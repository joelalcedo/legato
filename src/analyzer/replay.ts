import type { RouterConfig } from '../config.js';
import { decide, newState, observe } from '../engine.js';
import { extractFeatures, type MessagesRequest } from '../features.js';
import { defaultEffort, tierOf, type Effort, type Tier } from '../models.js';
import { costOf, promptTokens, splitUsage } from '../pricing.js';
import { resplit } from '../simulate.js';
import type { Conversation } from './transcripts.js';

export interface ReplayOptions {
  /**
   * Map each request's model onto the configured model for its tier before comparing
   * (claude-opus-4-6 -> claude-opus-5-5), so savings measure routing, not a model upgrade.
   */
  normalizeGeneration: boolean;
  /** Only requests at or after this time (ms since epoch). */
  since?: number;
}

export interface NotableDecision {
  conversation: string;
  at: number;
  from: string;
  to: string;
  effort?: string;
  kind: 'switch' | 'hold' | 'effort';
  userText: string;
  reasons: string[];
  promptTokens: number;
  /** Extra cost this request paid for the switch (cache rebuild on the new model). */
  rebuildUsd: number;
}

export interface ConversationResult {
  id: string;
  project: string;
  isSubagent: boolean;
  requests: number;
  userTurns: number;
  start: number;
  end: number;
  actualUsd: number;
  baselineUsd: number;
  routedUsd: number;
  switches: number;
  rebuildUsd: number;
  effortChanges: number;
  tierMix: Record<string, number>;
}

export interface ReplayResult {
  conversations: ConversationResult[];
  totals: Omit<ConversationResult, 'id' | 'project' | 'isSubagent' | 'start' | 'end'> & {
    conversations: number;
    subagents: number;
    start: number;
    end: number;
    heldDownshifts: number;
    freeSwitches: number;
    /** Requests whose transcript usage stops at stream start, so output tokens are undercounted. */
    partialUsage: number;
  };
  /** Cumulative cost over all requests in time order, for the chart. */
  series: { t: number; baseline: number; routed: number }[];
  notable: NotableDecision[];
  unpricedModels: string[];
}

export function replay(convs: Conversation[], cfg: RouterConfig, opts: ReplayOptions): ReplayResult {
  const results: ConversationResult[] = [];
  const notable: NotableDecision[] = [];
  const unpriced = new Set<string>();
  const points: { t: number; baseline: number; routed: number }[] = [];
  let heldDownshifts = 0;
  let freeSwitches = 0;
  let partialUsage = 0;

  for (const conv of convs) {
    const state = newState();
    let effort: Effort | undefined;
    const r: ConversationResult = {
      id: conv.id,
      project: conv.project,
      isSubagent: conv.isSubagent,
      requests: 0,
      userTurns: 0,
      start: Infinity,
      end: 0,
      actualUsd: 0,
      baselineUsd: 0,
      routedUsd: 0,
      switches: 0,
      rebuildUsd: 0,
      effortChanges: 0,
      tierMix: {},
    };

    for (const rq of conv.requests) {
      if (opts.since && rq.timestamp < opts.since) continue;
      const split = splitUsage(rq.usage);
      const prompt = promptTokens(split);
      if (prompt === 0 && split.output === 0) continue;

      const actualTier = tierOf(rq.model);
      const incoming =
        opts.normalizeGeneration && actualTier ? cfg.tiers[actualTier as Tier] : rq.model;
      const req: MessagesRequest = {
        model: incoming,
        messages: rq.context.slice(0, rq.messageCount),
        // Claude Code always sends its tool list; transcripts don't record it.
        tools: [{}],
      };
      const features = extractFeatures(req);
      const t = rq.timestamp;
      const d = decide({ req, features, state, cfg, now: t, contextTokens: prompt });
      const routed = d.route ? d.model : incoming;

      const actualUsd = costOf(rq.model, split, cfg.prices);
      if (actualUsd === 0 && prompt > 0) unpriced.add(rq.model);
      const baselineUsd = costOf(incoming, split, cfg.prices);

      const continuous = state.model === undefined ? routed === incoming : state.model === routed;
      const rsplit = continuous ? split : resplit(split, state.modelCache[routed], t, cfg.cacheTtlSeconds, 'capByRead');
      const routedUsd = costOf(routed, rsplit, cfg.prices);
      const rebuildUsd = continuous ? 0 : Math.max(0, routedUsd - costOf(routed, split, cfg.prices));
      if (!continuous) {
        r.switches++;
        r.rebuildUsd += rebuildUsd;
        if (d.freeSwitch) freeSwitches++;
      }

      if (features.newUserTurn) {
        r.userTurns++;
        // Start from the effort Claude Code actually ran at (the user's /effort setting).
        effort ??= (rq.effort as Effort | undefined) ?? defaultEffort(incoming);
        const effortChanged = d.effort && d.effort !== effort;
        if (effortChanged) {
          r.effortChanges++;
          effort = d.effort;
        }
        const held = d.economics && !d.switched && d.reasons.some((x) => x.startsWith('hold '));
        if (held) heldDownshifts++;
        if (!continuous || held || (effortChanged && notable.length < 400)) {
          notable.push({
            conversation: conv.id,
            at: t,
            from: state.model ?? incoming,
            to: routed,
            effort: d.effort,
            kind: !continuous ? 'switch' : held ? 'hold' : 'effort',
            userText: features.userText.slice(0, 160),
            reasons: d.reasons,
            promptTokens: prompt,
            rebuildUsd,
          });
        }
      }

      // A stream-start output count would teach the EWMA that this conversation barely
      // writes; the proxy sees final usage, so leave the estimate where it was.
      if (!rq.usageFinal) partialUsage++;
      observe(state, routed, prompt, rq.usageFinal ? split.output : 0, t, d.effort);
      const tier = tierOf(routed) ?? 'other';
      r.tierMix[tier] = (r.tierMix[tier] ?? 0) + 1;
      r.requests++;
      r.actualUsd += actualUsd;
      r.baselineUsd += baselineUsd;
      r.routedUsd += routedUsd;
      r.start = Math.min(r.start, t);
      r.end = Math.max(r.end, t);
      points.push({ t, baseline: baselineUsd, routed: routedUsd });
    }
    if (r.requests) results.push(r);
  }

  points.sort((a, b) => a.t - b.t);
  let cb = 0;
  let cr = 0;
  const series = points.map((p) => ({ t: p.t, baseline: (cb += p.baseline), routed: (cr += p.routed) }));

  const tierMix: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.tierMix)) tierMix[k] = (tierMix[k] ?? 0) + v;
  const sum = (f: (r: ConversationResult) => number) => results.reduce((a, r) => a + f(r), 0);

  return {
    conversations: results.sort((a, b) => b.baselineUsd - a.baselineUsd),
    totals: {
      conversations: results.filter((r) => !r.isSubagent).length,
      subagents: results.filter((r) => r.isSubagent).length,
      requests: sum((r) => r.requests),
      userTurns: sum((r) => r.userTurns),
      start: Math.min(...results.map((r) => r.start)),
      end: Math.max(...results.map((r) => r.end)),
      actualUsd: sum((r) => r.actualUsd),
      baselineUsd: sum((r) => r.baselineUsd),
      routedUsd: sum((r) => r.routedUsd),
      switches: sum((r) => r.switches),
      rebuildUsd: sum((r) => r.rebuildUsd),
      effortChanges: sum((r) => r.effortChanges),
      tierMix,
      heldDownshifts,
      freeSwitches,
      partialUsage,
    },
    series,
    notable: notable.sort((a, b) => a.at - b.at),
    unpricedModels: [...unpriced],
  };
}
