import { classify, type Classification } from './classifier.js';
import type { RouterConfig } from './config.js';
import type { Features, MessagesRequest } from './features.js';
import { shareOf } from './hash.js';
import { clampEffort, EFFORT_ORDER, effortRank, tierOf, tierRank, TIER_ORDER, type Effort, type Tier } from './models.js';
import { priceFor, type Price } from './pricing.js';

/** What the router remembers about one conversation (main session or a single subagent). */
export interface ConversationState {
  /** Model the previous request ran on. */
  model?: string;
  /** Effort the router last set for this conversation; undefined means Claude Code's own level. */
  effort?: Effort;
  lastRequestAt?: number;
  /** Prompt size of the previous request (input + cache read + cache write). */
  lastPromptTokens: number;
  /** Per-model cache warmth: when each model last served this conversation and at what prompt size. */
  modelCache: Record<string, { at: number; promptTokens: number }>;
  /** EWMA of output tokens per request. */
  avgOutputTokens: number;
  /** EWMA of prompt growth per request (new tool results, user text, the previous reply). */
  avgGrowthTokens: number;
  requests: number;
}

export function newState(): ConversationState {
  return { lastPromptTokens: 0, modelCache: {}, avgOutputTokens: 1_200, avgGrowthTokens: 2_000, requests: 0 };
}

export interface Economics {
  contextTokens: number;
  /** Extra cost this request pays for switching instead of staying (cache rebuild). */
  rebuildUsd: number;
  /** Saving per subsequent request on the new model. */
  perRequestSavingUsd: number;
  /** Expected cost of switching back later and rebuilding the old model's cache. */
  returnUsd: number;
  /** perRequestSaving * expectedRunRequests - rebuild - return. */
  netUsd: number;
}

export interface Decision {
  /** false: forward untouched (background request, unknown model, or routing disabled). */
  route: boolean;
  model: string;
  tier?: Tier;
  /** Effort to apply from this turn on, if it should change. */
  effort?: Effort;
  switched: boolean;
  /** Why the decision was made, in order, for the log. */
  reasons: string[];
  classification?: Classification;
  economics?: Economics;
  freeSwitch?: boolean;
  /** Which arm of cfg.trial this conversation landed in, when the trial applied. */
  arm?: 'A' | 'B';
}

export interface DecideInput {
  req: MessagesRequest;
  features: Features;
  state: ConversationState;
  cfg: RouterConfig;
  now: number;
  /** Exact prompt size when known (analyzer); the proxy estimates it from the previous request. */
  contextTokens?: number;
  /** A classification made elsewhere (the proxy's model-based classifier); the heuristic runs otherwise. */
  classification?: Classification;
}

function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function stepUp(t: Tier, allowed: Tier[]): Tier {
  const up = allowed.filter((x) => tierRank(x) > tierRank(t)).sort((a, b) => tierRank(a) - tierRank(b));
  return up[0] ?? t;
}

/** Nearest allowed tier, preferring the closest one at or above the request, then below. */
function clampTier(t: Tier, allowed: Tier[]): Tier {
  if (allowed.includes(t)) return t;
  const sorted = [...allowed].sort((a, b) => tierRank(a) - tierRank(b));
  const above = sorted.find((x) => tierRank(x) >= tierRank(t));
  return above ?? sorted[sorted.length - 1]!;
}

function allowedTiers(incoming: Tier, cfg: RouterConfig, includeOverride?: Tier): Tier[] {
  const ceiling = cfg.ceiling === 'incoming' ? incoming : cfg.ceiling;
  const set = new Set<Tier>([...cfg.enabledTiers, incoming]);
  if (includeOverride) set.add(includeOverride);
  return TIER_ORDER.filter(
    (t) =>
      set.has(t) &&
      tierRank(t) >= tierRank(cfg.floor) &&
      (tierRank(t) <= tierRank(ceiling) || t === includeOverride),
  );
}

function modelForTier(t: Tier, incomingModel: string, incomingTier: Tier, cfg: RouterConfig): string {
  // Keep the exact model the user picked when routing lands on its own tier.
  return t === incomingTier ? incomingModel : cfg.tiers[t];
}

function cacheIsWarm(entry: { at: number } | undefined, now: number, cfg: RouterConfig): boolean {
  return !!entry && now - entry.at < cfg.cacheTtlSeconds * 1000;
}

function writePrice(p: Price, cfg: RouterConfig): number {
  return cfg.cacheTtlSeconds >= 3600 ? p.write1h : p.write5m;
}

/** The cost model behind every downshift: see docs/DESIGN.md for the derivation. */
export function switchEconomics(
  fromModel: string,
  toModel: string,
  state: ConversationState,
  ctx: number,
  cfg: RouterConfig,
  now: number,
): Economics {
  const from = priceFor(fromModel, ctx, cfg.prices);
  const to = priceFor(toModel, ctx, cfg.prices);
  if (!from || !to) {
    return { contextTokens: ctx, rebuildUsd: 0, perRequestSavingUsd: 0, returnUsd: 0, netUsd: 0 };
  }
  const growth = Math.max(0, Math.min(state.avgGrowthTokens, ctx));
  const cachedPrefix = Math.max(0, ctx - growth);

  // This request if we stay: the prefix is a cache read, the new tail is a cache write.
  const stay = (cachedPrefix * from.read + growth * writePrice(from, cfg)) / 1e6;

  // This request if we switch: whatever the target still has warm is a read; the rest is rebuilt.
  const targetEntry = state.modelCache[toModel];
  const targetWarm = cacheIsWarm(targetEntry, now, cfg) ? Math.min(targetEntry!.promptTokens, ctx) : 0;
  const sw = (targetWarm * to.read + (ctx - targetWarm) * writePrice(to, cfg)) / 1e6;

  const rebuildUsd = sw - stay;
  const perRequestSavingUsd =
    (cachedPrefix * (from.read - to.read) +
      growth * (writePrice(from, cfg) - writePrice(to, cfg)) +
      state.avgOutputTokens * (from.output - to.output)) /
    1e6;
  const returnUsd = cfg.returnProbability * ((ctx * writePrice(from, cfg)) / 1e6);
  const netUsd = perRequestSavingUsd * cfg.expectedRunRequests - rebuildUsd - returnUsd;
  return { contextTokens: ctx, rebuildUsd, perRequestSavingUsd, returnUsd, netUsd };
}

export function estimateContext(state: ConversationState, features: Features): number {
  if (state.lastPromptTokens > 0) return state.lastPromptTokens + state.avgGrowthTokens;
  return features.estimatedTokens;
}

export function decide({ req, features, state, cfg, now, contextTokens, classification: given }: DecideInput): Decision {
  if (cfg.detectCacheTtl && features.cacheTtlSeconds) cfg = { ...cfg, cacheTtlSeconds: features.cacheTtlSeconds };
  const incomingModel = req.model;
  const incomingTier = tierOf(incomingModel);
  const reasons: string[] = [];

  if (!features.hasTools) {
    return { route: false, model: incomingModel, switched: false, reasons: ['no tools: background request'] };
  }
  if (!incomingTier) {
    return { route: false, model: incomingModel, switched: false, reasons: ['unrecognized model family'] };
  }
  if (cfg.ceiling === 'incoming' && incomingTier === 'haiku' && !features.override) {
    return { route: false, model: incomingModel, switched: false, reasons: ['already on haiku'] };
  }

  const currentModel = state.model ?? incomingModel;
  const currentTier = tierOf(currentModel) ?? incomingTier;
  const ctx = contextTokens ?? estimateContext(state, features);

  // Inside a tool loop the model is held: switching mid-loop would rebuild the cache
  // for a single step, and the per-message effort beta only takes effect on new user input.
  if (!features.newUserTurn && !cfg.switchMidLoop) {
    return {
      route: true,
      model: currentModel,
      tier: currentTier,
      switched: false,
      reasons: [
        features.machineTurn
          ? `Claude Code's own prompt (suggestion, recap or compaction), not a user turn: hold ${currentModel}`
          : `tool loop step ${features.toolLoopDepth}: hold ${currentModel}`,
      ],
    };
  }

  const allowed = allowedTiers(incomingTier, cfg, features.override);
  let target: Tier;
  let effort: Effort | undefined;
  let classification: Classification | undefined;
  let strongUpgrade = false;
  let arm: Decision['arm'];
  let trialModel: string | undefined;
  // A subagent's first request is free to route, and its type says more than its brief does.
  const agentTier = features.isFirstRequest && features.agentType ? cfg.subagentTiers[features.agentType] : undefined;
  const trial = cfg.trial && features.isFirstRequest && features.agentType === cfg.trial.agentType ? cfg.trial : undefined;

  if (features.override) {
    target = clampTier(features.override, allowed);
    effort = cfg.tierEffort[target];
    reasons.push(`override //${features.override[0]} -> ${target}`);
    strongUpgrade = true;
  } else if (trial) {
    // The arm is a function of the brief, so the analyzer replays each agent into the same arm.
    arm = shareOf(features.userText) < trial.share ? 'B' : 'A';
    if (arm === 'B') {
      target = tierOf(trial.model) ?? incomingTier;
      trialModel = trial.model;
      effort = trial.effort ?? cfg.tierEffort[target];
      reasons.push(`trial arm B: ${features.agentType} agent -> ${trial.model}/${effort} (${Math.round(trial.share * 100)}% of them)`);
    } else {
      target = incomingTier;
      reasons.push(`trial arm A: ${features.agentType} agent stays on ${incomingModel} (control)`);
      strongUpgrade = true;
    }
  } else if (agentTier) {
    target = agentTier;
    effort = cfg.tierEffort[agentTier];
    reasons.push(`${features.agentType} agent -> ${agentTier} by agent type`);
  } else {
    classification = given ?? classify(features.userText);
    target = classification.tier;
    effort = classification.effort;
    reasons.push(
      `classified ${target}/${effort}` + (classification.signals.length ? ` [${classification.signals.join(', ')}]` : ''),
    );
    if (features.planMode && tierRank(target) < tierRank(cfg.planTier)) {
      target = cfg.planTier;
      effort = cfg.tierEffort[cfg.planTier];
      reasons.push(`plan mode -> ${cfg.planTier}`);
      strongUpgrade = true;
    }
    if (features.previousTaskErrors >= cfg.escalateAfterErrors) {
      const bumped = stepUp(maxTier(target, currentTier), allowed);
      if (bumped !== target) {
        reasons.push(`escalate: the previous task ended on ${features.previousTaskErrors} failing tool results -> ${bumped}`);
        target = bumped;
        strongUpgrade = true;
      }
    }
    if (classification.tier === 'opus') strongUpgrade = true;
  }

  const clamped = clampTier(target, allowed);
  if (clamped !== target) reasons.push(`clamped ${target} -> ${clamped} (floor ${cfg.floor}, ceiling ${cfg.ceiling})`);
  target = clamped;

  let model = trialModel && tierOf(trialModel) === target ? trialModel : modelForTier(target, incomingModel, incomingTier, cfg);
  let switched = model !== currentModel;
  let economics: Economics | undefined;
  let freeSwitch: boolean | undefined;

  if (switched && features.isFork) {
    reasons.push(`fork: holds ${currentModel}, whose ${Math.round(ctx / 1000)}K-token context and thinking it inherits from the parent`);
    model = currentModel;
    target = currentTier;
    switched = false;
  }

  // Thinking blocks are readable only by the model that wrote them (or a stronger one), so a
  // downshift mid-session discards the current model's reasoning even when the cache is cold.
  const downshift = switched && tierRank(target) < tierRank(currentTier);
  const thinkingTokens = downshift && !features.isFirstRequest ? Math.round(features.thinkingChars / 3.5) : 0;
  if (thinkingTokens > cfg.holdThinkingTokens) {
    economics = switchEconomics(currentModel, model, state, ctx, cfg, now);
    reasons.push(
      `hold ${currentModel}: switching would drop ~${Math.round(thinkingTokens / 1000)}K tokens of its thinking, ` +
        `which ${model} can't read - adjusting effort instead`,
    );
    model = currentModel;
    target = currentTier;
    switched = false;
  } else if (switched && (state.model || !features.isFirstRequest)) {
    // With no history for this conversation (router started mid-session), assume the
    // incoming model's cache is warm: that is the expensive case to get wrong.
    const warm = state.model ? cacheIsWarm(state.modelCache[currentModel], now, cfg) : true;
    if (features.isFirstRequest || !warm || ctx < cfg.freeSwitchTokens) {
      freeSwitch = true;
      reasons.push(
        features.isFirstRequest
          ? 'free switch: first request, no cache yet'
          : !warm
            ? `free switch: ${currentModel} cache expired`
            : `free switch: small context (${ctx} tokens)`,
      );
    } else {
      economics = switchEconomics(currentModel, model, state, ctx, cfg, now);
      const upgrading = tierRank(target) > tierRank(currentTier);
      if (upgrading) {
        if (!strongUpgrade) {
          reasons.push('upgrade not strongly signaled: hold');
          model = currentModel;
          target = currentTier;
          switched = false;
        } else {
          reasons.push(`upgrade for quality; cache rebuild $${economics.rebuildUsd.toFixed(3)}`);
        }
      } else if (economics.netUsd < cfg.minNetSavingsUsd) {
        reasons.push(
          `hold ${currentModel}: downshift nets $${economics.netUsd.toFixed(3)} ` +
            `(rebuild $${economics.rebuildUsd.toFixed(3)}, saves $${economics.perRequestSavingUsd.toFixed(4)}/request) - adjusting effort instead`,
        );
        model = currentModel;
        target = currentTier;
        switched = false;
      } else {
        reasons.push(
          `downshift nets $${economics.netUsd.toFixed(3)} over ~${cfg.expectedRunRequests} requests ` +
            `(rebuild $${economics.rebuildUsd.toFixed(3)})`,
        );
      }
    }
  } else if (switched) {
    freeSwitch = true;
    reasons.push('free switch: no cache yet for this conversation');
  }

  // The user's effort is a ceiling, like the model: hard turns run at it, others may go lower.
  const ceiling = features.incomingEffort as Effort | undefined;
  if (effort && ceiling && EFFORT_ORDER.includes(ceiling)) {
    if (strongUpgrade || classification?.tier === 'opus') {
      if (effort !== ceiling) reasons.push(`effort ${effort} -> ${ceiling}: hard turn keeps the requested effort`);
      effort = ceiling;
    } else if (effortRank(effort) > effortRank(ceiling)) {
      reasons.push(`effort ${effort} -> ${ceiling}: never above the requested effort`);
      effort = ceiling;
    }
  }

  if (!cfg.routeEffort) {
    effort = undefined;
  } else if (effort) {
    const c = clampEffort(model, effort);
    if (c !== effort) reasons.push(`effort ${effort} -> ${c ?? 'n/a'} for ${model}`);
    effort = c;
  }

  return { route: true, model, tier: target, effort, switched, reasons, classification, economics, freeSwitch, arm };
}

/** Fold a completed request's measured usage back into the conversation state. */
export function observe(
  state: ConversationState,
  model: string,
  promptTokens: number,
  outputTokens: number,
  now: number,
  effort?: Effort,
): void {
  if (state.lastPromptTokens > 0 && promptTokens > state.lastPromptTokens) {
    const growth = promptTokens - state.lastPromptTokens;
    state.avgGrowthTokens = 0.7 * state.avgGrowthTokens + 0.3 * growth;
  }
  if (outputTokens > 0) state.avgOutputTokens = 0.7 * state.avgOutputTokens + 0.3 * outputTokens;
  state.model = model;
  state.lastRequestAt = now;
  state.lastPromptTokens = promptTokens;
  state.modelCache[model] = { at: now, promptTokens };
  state.requests++;
  if (effort) state.effort = effort;
}
