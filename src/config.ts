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
  expectedRunRequests: 8,
  returnProbability: 0.3,
  minNetSavingsUsd: 0.02,
  freeSwitchTokens: 8_000,
  escalateAfterErrors: 2,
  switchMidLoop: false,
  planTier: 'opus',
  failOpen: true,
  maxOutputTokens: { 'claude-haiku-5-5': 64_000 },
  upstream: 'https://api.anthropic.com',
  port: 8787,
  host: '127.0.0.1',
  dataDir: join(homedir(), '.switchyard'),
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

export function defaultConfig(preset: Preset = 'balanced'): RouterConfig {
  return mergeConfig(structuredClone(BASE), { preset, ...PRESETS[preset] });
}

function mergeConfig(base: RouterConfig, patch: Partial<RouterConfig>): RouterConfig {
  const out = { ...base, ...patch } as RouterConfig;
  if (patch.tiers) out.tiers = { ...base.tiers, ...patch.tiers };
  if (patch.tierEffort) out.tierEffort = { ...base.tierEffort, ...patch.tierEffort };
  if (patch.maxOutputTokens) out.maxOutputTokens = { ...base.maxOutputTokens, ...patch.maxOutputTokens };
  return out;
}

/**
 * Resolve config: defaults, then the preset, then ~/.switchyard/config.json (or
 * SWITCHYARD_CONFIG), then explicit overrides from the CLI.
 */
export function loadConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  const path = process.env.SWITCHYARD_CONFIG ?? join(BASE.dataDir, 'config.json');
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
  if (process.env.SWITCHYARD_UPSTREAM) cfg.upstream = process.env.SWITCHYARD_UPSTREAM;
  validate(cfg);
  return cfg;
}

function validate(cfg: RouterConfig): void {
  if (!cfg.enabledTiers.length) throw new Error('enabledTiers must include at least one tier');
  if (!['live', 'shadow'].includes(cfg.mode)) throw new Error(`mode must be live or shadow, got ${cfg.mode}`);
  if (cfg.cacheTtlSeconds <= 0) throw new Error('cacheTtlSeconds must be positive');
}
