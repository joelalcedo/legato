import { createHash } from 'node:crypto';

/** JSON with cache_control removed: Claude Code moves cache breakpoints between requests. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v));
}

export function stableHash(value: unknown): string {
  return createHash('sha1').update(stableJson(value)).digest('hex').slice(0, 16);
}

/** Deterministic share in [0, 1) for a piece of text, so an A/B split replays identically. */
export function shareOf(text: string): number {
  return parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}
