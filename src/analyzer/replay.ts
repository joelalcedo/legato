import type { RouterConfig } from '../config.js';
import { decide, newState, observe } from '../engine.js';
import { extractFeatures, type MessagesRequest } from '../features.js';
import { defaultEffort, tierOf, type Effort, type Tier } from '../models.js';
import { costOf, priceFor, promptTokens, splitUsage } from '../pricing.js';
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
  /** Output cost the effort changes would save under cfg.effortOutputScale: an assumption, kept out of routedUsd. */
  effortSavingsUsd: number;
  tierMix: Record<string, number>;
}

/** One task: a user turn and the tool-loop requests that follow it, or a subagent's whole run. */
export interface TurnResult {
  conversation: string;
  /** `main`, or the subagent type (`Explore`, `general-purpose`, ...). */
  agentType: string;
  at: number;
  /** The tier the policy wanted for this task, before any hold. */
  wanted?: Tier;
  /** The classifier's signals, when the heuristic ran. */
  signals: string[];
  from: string;
  to: string;
  effortAsked?: string;
  effortUsed?: string;
  switched: boolean;
  held: boolean;
  freeSwitch: boolean;
  requests: number;
  /** Prompt size at the task's first request. */
  promptTokens: number;
  baselineUsd: number;
  routedUsd: number;
}

/** What a task of one kind costs, with and without routing, across the replay. */
export interface KindResult {
  kind: string;
  tasks: number;
  meanBaselineUsd: number;
  meanRoutedUsd: number;
  medianBaselineUsd: number;
  medianRoutedUsd: number;
  savedUsd: number;
}

/**
 * The name a person would give a task, from the agent type or the classifier's signals.
 * These are the rows of the README's saving chart and of `legato analyze`'s "by kind" table.
 */
export function kindOf(t: Pick<TurnResult, 'agentType' | 'wanted' | 'signals'>): string {
  const has = (re: RegExp) => t.signals.some((s) => re.test(s));
  if (t.agentType === 'Explore') return 'Explore agent run';
  if (t.agentType === 'general-purpose') return 'General-purpose agent run';
  if (t.agentType !== 'main') return 'Other subagent run';
  if (t.wanted === 'haiku') return 'Quick task (commit, find a file, a greeting)';
  if (t.wanted === 'sonnet') return has(/confirmation/) ? 'A "yes, go ahead"' : 'Ordinary coding task';
  if (t.wanted === 'opus') return has(/diagnosis|hard-bug|retry-after-failure/) ? 'Find why something fails' : 'Design, plan or large change';
  return 'Other';
}

export function summarizeKinds(turns: TurnResult[]): KindResult[] {
  const groups = new Map<string, TurnResult[]>();
  for (const t of turns) {
    const k = kindOf(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return [...groups.entries()]
    .map(([kind, ts]) => ({
      kind,
      tasks: ts.length,
      meanBaselineUsd: mean(ts.map((t) => t.baselineUsd)),
      meanRoutedUsd: mean(ts.map((t) => t.routedUsd)),
      medianBaselineUsd: median(ts.map((t) => t.baselineUsd)),
      medianRoutedUsd: median(ts.map((t) => t.routedUsd)),
      savedUsd: ts.reduce((a, t) => a + (t.baselineUsd - t.routedUsd), 0),
    }))
    .sort((a, b) => b.savedUsd - a.savedUsd);
}

export interface ReplayResult {
  conversations: ConversationResult[];
  turns: TurnResult[];
  /** Tasks grouped by kind, biggest total saving first. */
  byKind: KindResult[];
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
  const turns: TurnResult[] = [];
  const notable: NotableDecision[] = [];
  const unpriced = new Set<string>();
  const points: { t: number; baseline: number; routed: number }[] = [];
  let heldDownshifts = 0;
  let freeSwitches = 0;
  let partialUsage = 0;

  for (const conv of convs) {
    const state = newState();
    let effort: Effort | undefined;
    let ttl = cfg.cacheTtlSeconds;
    let turn: TurnResult | undefined;
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
      effortSavingsUsd: 0,
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
      features.incomingEffort ??= rq.effort;
      // Transcripts don't carry the system prompt; the subagent's .meta.json names its type.
      features.agentType ??= conv.agentType;
      if (conv.isFork) features.isFork = true;
      // Transcripts drop cache_control; the TTL Claude Code asked for shows in which cache it wrote.
      if (cfg.detectCacheTtl) {
        if (split.write1h > 0) ttl = 3600;
        else if (split.write5m > 0) ttl = 300;
        features.cacheTtlSeconds = ttl;
      }
      const t = rq.timestamp;
      const d = decide({ req, features, state, cfg, now: t, contextTokens: prompt });
      const routed = d.route ? d.model : incoming;

      const actualUsd = costOf(rq.model, split, cfg.prices);
      if (actualUsd === 0 && prompt > 0) unpriced.add(rq.model);
      const baselineUsd = costOf(incoming, split, cfg.prices);

      const continuous = state.model === undefined ? routed === incoming : state.model === routed;
      const rsplit = continuous ? split : resplit(split, state.modelCache[routed], t, ttl, 'capByRead');
      const routedUsd = costOf(routed, rsplit, cfg.prices);
      const rebuildUsd = continuous ? 0 : Math.max(0, routedUsd - costOf(routed, split, cfg.prices));
      if (!continuous) {
        r.switches++;
        r.rebuildUsd += rebuildUsd;
        if (d.freeSwitch) freeSwitches++;
      }

      if (features.newUserTurn) {
        r.userTurns++;
        // The turn runs at the engine's effort, else at what Claude Code asked for (the user's /effort).
        const asked = (rq.effort as Effort | undefined) ?? defaultEffort(incoming);
        const effortChanged = !!d.effort && d.effort !== asked;
        effort = d.effort ?? asked;
        if (effortChanged) r.effortChanges++;
        const held = !!d.held && d.held.why !== 'weak-upgrade';
        if (held) heldDownshifts++;
        if (turn) turns.push(turn);
        turn = {
          conversation: conv.id,
          agentType: conv.isSubagent ? (conv.agentType ?? 'subagent') : 'main',
          at: t,
          wanted: d.route ? (d.classification?.tier ?? d.tier) : undefined,
          signals: d.route ? (d.classification?.signals ?? []) : [],
          from: state.model ?? incoming,
          to: routed,
          effortAsked: rq.effort,
          effortUsed: d.effort ?? rq.effort,
          switched: !continuous,
          held,
          freeSwitch: !!d.freeSwitch,
          requests: 0,
          promptTokens: prompt,
          baselineUsd: 0,
          routedUsd: 0,
        };
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

      // Effort changes the output length. That saving is priced under a stated assumption and
      // reported on its own line, never in the headline.
      const ran = rq.effort as Effort | undefined;
      if (rq.usageFinal && split.output > 0 && effort && ran && effort !== ran) {
        const scale = cfg.effortOutputScale[effort] / cfg.effortOutputScale[ran];
        const price = priceFor(routed, prompt, cfg.prices);
        if (price && Number.isFinite(scale)) r.effortSavingsUsd += (split.output * (1 - scale) * price.output) / 1e6;
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
      if (turn) {
        turn.requests++;
        turn.baselineUsd += baselineUsd;
        turn.routedUsd += routedUsd;
      }
    }
    if (turn) turns.push(turn);
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
    turns: turns.sort((a, b) => a.at - b.at),
    byKind: summarizeKinds(turns),
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
      effortSavingsUsd: sum((r) => r.effortSavingsUsd),
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
