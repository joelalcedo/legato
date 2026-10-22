import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Effort, Tier } from './models.js';
import type { PriceEntry } from './pricing.js';

export type Preset = 'conservative' | 'balanced' | 'aggressive';
export type Mode = 'live' | 'shadow';

export interface RouterConfig {
  /** live: rewrite requests. shadow: decide and log, but forward requests untouched. */
  mode: Mode;
  preset: Preset;
  /** Concrete model ID for each tier. */
  tiers: Record<Tier, string>;
  /** Tiers the router may choose. Fable is opt-in because of its price and usage-credit billing. */
  enabledTiers: Tier[];
  /** Never route the main conversation below this tier. */
  floor: Tier;
  /** 'incoming' = never route above the model Claude Code asked for (respects the user's /model choice). */
  ceiling: Tier | 'incoming';
  /** Default effort per tier when the classifier has no strong opinion. */
  tierEffort: Record<Tier, Effort>;
  /** Vary effort per turn using cache-safe per-message effort where the model supports it. */
  routeEffort: boolean;
  /** Prompt cache TTL Claude Code is using: 300 (API key, usage credits) or 3600 (subscription within plan). */
  cacheTtlSeconds: number;
  /**
   * Read the TTL from each request's cache_control markers instead (on a subscription the
   * main thread asks for 1h and subagents for 5m); cacheTtlSeconds is the fallback.
   */
  detectCacheTtl: boolean;
  /** Expected API requests a newly chosen model will serve before the next switch (tool loops included). */
  expectedRunRequests: number;
  /** Probability the router switches back before the old model's cache would have expired anyway. */
  returnProbability: number;
  /** A downshift must save at least this many USD (net of cache rebuild) to happen. */
  minNetSavingsUsd: number;
  /** Below this context size, switching is treated as free (the rebuild is negligible). */
  freeSwitchTokens: number;
  /** Escalate one tier at the next user turn after this many failing tool results in the previous task. */
  escalateAfterErrors: number;
  /** Allow model switches inside a tool loop (off by default: switches happen at turn boundaries). */
  switchMidLoop: boolean;
  /** Plan mode always runs on at least this tier. */
  planTier: Tier;
  /** Tier for a subagent's first request by agent type (read from its system prompt); the classifier decides otherwise. */
  subagentTiers: Partial<Record<string, Tier>>;
  /**
   * Model names Claude Code may be launched with (`claude --model dynamic`) that stand for
   * "let the router choose, up to this model". Claude Code's header then shows the alias.
   */
  modelAliases: Record<string, string>;
  /** The model name `legato claude` launches Claude Code with; its header shows this text. */
  launchModel: string;
  /**
   * Hold a downshift that would discard more than this many tokens of the current model's
   * thinking, which the cheaper model can't read; effort is adjusted instead.
   */
  holdThinkingTokens: number;
  /**
   * A/B trial: route `share` (0-1) of the agents of one type to `model` (arm B), log the arm,
   * and leave the rest as the control (arm A), so completion quality can be compared. Off unless set.
   */
  trial?: { agentType: string; model: string; effort?: Effort; share: number };
  /** heuristic: the built-in regex classifier. haiku: a Haiku 5.5 call (needs ANTHROPIC_API_KEY), with the heuristic as fallback. */
  classifier: 'heuristic' | 'haiku';
  classifierModel: string;
  /**
   * Assumed output tokens per effort level, relative to xhigh. Used only for the analyzer's
   * separate "effort savings" line; it is an assumption, not a measurement.
   */
  effortOutputScale: Record<Effort, number>;
  /** On an upstream 4xx/5xx for a rewritten request, retry once with the original request. */
  failOpen: boolean;
  /** Optional clamp for max_tokens per model when the router targets a model with a smaller limit. */
  maxOutputTokens: Record<string, number>;
  /** Price overrides, keyed by normalized model ID. */
  prices?: Record<string, PriceEntry>;
  /** Upstream API base URL. */
  upstream: string;
  port: number;
  host: string;
  /** Where decisions and stats are written. */
  dataDir: string;
}

const BASE: RouterConfig = {
  mode: 'live',
  preset: 'balanced',
  tiers: {
    haiku: 'claude-haiku-5-5',
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5',
    fable: 'claude-fable-5-1',
  },
  enabledTiers: ['haiku', 'sonnet', 'opus'],
  floor: 'haiku',
  ceiling: 'incoming',
  tierEffort: { haiku: 'medium', sonnet: 'medium', opus: 'medium', fable: 'high' },
  routeEffort: true,
  cacheTtlSeconds: 300,
  detectCacheTtl: true,
  expectedRunRequests: 8,
  returnProbability: 0.3,
  minNetSavingsUsd: 0.02,
  freeSwitchTokens: 8_000,
  escalateAfterErrors: 2,
  switchMidLoop: false,
  planTier: 'opus',
  subagentTiers: { Explore: 'sonnet' },
  modelAliases: { 'Dynamic mode': 'claude-opus-5-5', dynamic: 'claude-opus-5-5', auto: 'claude-opus-5-5', legato: 'claude-opus-5-5' },
  launchModel: 'Dynamic mode',
  holdThinkingTokens: 20_000,
  classifier: 'heuristic',
  classifierModel: 'claude-haiku-5-5',
  effortOutputScale: { low: 0.35, medium: 0.6, high: 0.8, xhigh: 1, max: 1.1 },
  failOpen: true,
  // Every current model takes 128K output tokens; add an entry when routing to one that takes less.
  maxOutputTokens: {},
  upstream: 'https://api.anthropic.com',
  port: 8787,
  host: '127.0.0.1',
  dataDir: join(homedir(), '.legato'),
};

const PRESETS: Record<Preset, Partial<RouterConfig>> = {
  conservative: {
    floor: 'sonnet',
    expectedRunRequests: 6,
    returnProbability: 0.4,
    minNetSavingsUsd: 0.05,
    escalateAfterErrors: 1,
  },
  balanced: {},
  aggressive: {
    expectedRunRequests: 12,
    returnProbability: 0.2,
    minNetSavingsUsd: 0,
    freeSwitchTokens: 20_000,
    escalateAfterErrors: 3,
  },
};

/** The model a launch alias stands for, matched without regard to case, spaces or hyphens. */
export function resolveAlias(cfg: RouterConfig, model: string): string | undefined {
  const key = normalizeAlias(model);
  for (const [alias, target] of Object.entries(cfg.modelAliases)) {
    if (normalizeAlias(alias) === key) return target;
  }
  return undefined;
}

function normalizeAlias(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

export function defaultConfig(preset: Preset = 'balanced'): RouterConfig {
  return mergeConfig(structuredClone(BASE), { preset, ...PRESETS[preset] });
}

function mergeConfig(base: RouterConfig, patch: Partial<RouterConfig>): RouterConfig {
  const out = { ...base, ...patch } as RouterConfig;
  if (patch.tiers) out.tiers = { ...base.tiers, ...patch.tiers };
  if (patch.tierEffort) out.tierEffort = { ...base.tierEffort, ...patch.tierEffort };
  if (patch.maxOutputTokens) out.maxOutputTokens = { ...base.maxOutputTokens, ...patch.maxOutputTokens };
  if (patch.subagentTiers) out.subagentTiers = { ...base.subagentTiers, ...patch.subagentTiers };
  if (patch.modelAliases) out.modelAliases = { ...base.modelAliases, ...patch.modelAliases };
  if (patch.effortOutputScale) out.effortOutputScale = { ...base.effortOutputScale, ...patch.effortOutputScale };
  return out;
}

/**
 * Resolve config: defaults, then the preset, then ~/.legato/config.json (or
 * LEGATO_CONFIG), then explicit overrides from the CLI.
 */
export function loadConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  const path = process.env.LEGATO_CONFIG ?? join(BASE.dataDir, 'config.json');
  let fileCfg: Partial<RouterConfig> = {};
  if (existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<RouterConfig>;
    } catch (err) {
      throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
    }
  }
  const preset = (overrides.preset ?? fileCfg.preset ?? 'balanced') as Preset;
  let cfg = defaultConfig(preset);
  cfg = mergeConfig(cfg, fileCfg);
  cfg = mergeConfig(cfg, overrides);
  if (process.env.LEGATO_UPSTREAM) cfg.upstream = process.env.LEGATO_UPSTREAM;
  validate(cfg);
  return cfg;
}

function validate(cfg: RouterConfig): void {
  if (!cfg.enabledTiers.length) throw new Error('enabledTiers must include at least one tier');
  if (!['live', 'shadow'].includes(cfg.mode)) throw new Error(`mode must be live or shadow, got ${cfg.mode}`);
  if (cfg.cacheTtlSeconds <= 0) throw new Error('cacheTtlSeconds must be positive');
  if (!['heuristic', 'haiku'].includes(cfg.classifier)) throw new Error(`classifier must be heuristic or haiku, got ${cfg.classifier}`);
  if (cfg.trial && !(cfg.trial.share >= 0 && cfg.trial.share <= 1)) throw new Error('trial.share must be between 0 and 1');
}
