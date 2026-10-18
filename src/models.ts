import { normalizeModel } from './pricing.js';

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

export function effortRank(e: Effort): number {
  return EFFORT_ORDER.indexOf(e);
}

/** Map a model ID onto a capability tier by its family name. */
export function tierOf(model: string): Tier | undefined {
  const m = normalizeModel(model);
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return undefined;
}

/**
 * Models that accept a per-message effort change (an effort-only `role: "system"`
 * message, beta `mid-conversation-output-config-2026-07-01`), which keeps the
 * prompt cache intact. Source: platform.claude.com/docs/en/build-with-claude/effort
 */
const PER_MESSAGE_EFFORT = new Set([
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

export const PER_MESSAGE_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';

export function supportsPerMessageEffort(model: string): boolean {
  return PER_MESSAGE_EFFORT.has(normalizeModel(model));
}

/** Effort levels each model accepts. Models not listed don't take the effort parameter. */
export function supportedEfforts(model: string): Effort[] {
  const m = normalizeModel(model);
  if (/^claude-(fable|mythos)-5/.test(m)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^claude-(opus|sonnet|haiku)-5/.test(m)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^claude-opus-4-[78]/.test(m)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^claude-(opus|sonnet)-4-6/.test(m)) return ['low', 'medium', 'high', 'max'];
  if (/^claude-opus-4-5/.test(m)) return ['low', 'medium', 'high'];
  return [];
}

/** Clamp to the highest supported level at or below the requested one (Claude Code's rule). */
export function clampEffort(model: string, e: Effort): Effort | undefined {
  const levels = supportedEfforts(model);
  if (levels.length === 0) return undefined;
  for (let i = effortRank(e); i >= 0; i--) {
    const candidate = EFFORT_ORDER[i]!;
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0];
}

/** The API's default effort when the request omits it. */
export function defaultEffort(model: string): Effort | undefined {
  const m = normalizeModel(model);
  if (m === 'claude-opus-5-5' || m === 'claude-haiku-5-5') return 'medium';
  return supportedEfforts(m).length ? 'high' : undefined;
}

/** Models whose thinking can't be disabled; a request with thinking.type=disabled returns 400. */
export function thinkingAlwaysOn(model: string): boolean {
  const m = normalizeModel(model);
  return /^claude-(fable|mythos)-5/.test(m) || m === 'claude-opus-5-5' || m === 'claude-sonnet-5-5';
}
