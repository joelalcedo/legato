/**
 * Claude API list prices, USD per million tokens.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (retrieved 2026-10-18).
 * Override any entry from config if your contract differs.
 */
export interface Price {
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
}

export interface PriceEntry {
  base: Price;
  /** Optional higher price tier that applies when the prompt exceeds `threshold` tokens. */
  long?: { threshold: number; price: Price };
}

const p = (input: number, output: number, write5m: number, write1h: number, read: number): Price => ({
  input,
  output,
  write5m,
  write1h,
  read,
});

/** Keys are normalized model IDs (see normalizeModel). Order matters only for readability. */
export const PRICES: Record<string, PriceEntry> = {
  'claude-fable-5-1': { base: p(10, 50, 12.5, 20, 0.25) },
  'claude-mythos-5-1': { base: p(10, 50, 12.5, 20, 0.25) },
  'claude-fable-5': { base: p(10, 50, 12.5, 20, 1) },
  'claude-mythos-5': { base: p(10, 50, 12.5, 20, 1) },
  'claude-opus-5-5': { base: p(4, 20, 5, 8, 0.2) },
  'claude-sonnet-5-5': { base: p(2, 10, 2.5, 4, 0.1) },
  'claude-haiku-5-5': {
    base: p(0.1, 0.5, 0.125, 0.2, 0.01),
    long: { threshold: 100_000, price: p(0.5, 2.5, 0.625, 1, 0.05) },
  },
  'claude-opus-5': { base: p(5, 25, 6.25, 10, 0.5) },
  'claude-opus-4-8': { base: p(5, 25, 6.25, 10, 0.5) },
  'claude-opus-4-7': { base: p(5, 25, 6.25, 10, 0.5) },
  'claude-opus-4-6': { base: p(5, 25, 6.25, 10, 0.5) },
  'claude-opus-4-5': { base: p(5, 25, 6.25, 10, 0.5) },
  'claude-opus-4-1': { base: p(15, 75, 18.75, 30, 1.5) },
  'claude-opus-4': { base: p(15, 75, 18.75, 30, 1.5) },
  'claude-sonnet-5': { base: p(2, 10, 2.5, 4, 0.2) },
  'claude-sonnet-4-6': { base: p(3, 15, 3.75, 6, 0.3) },
  'claude-sonnet-4-5': { base: p(3, 15, 3.75, 6, 0.3) },
  'claude-sonnet-4': { base: p(3, 15, 3.75, 6, 0.3) },
  'claude-haiku-4-5': { base: p(1, 5, 1.25, 2, 0.1) },
  'claude-3-5-haiku': { base: p(0.8, 4, 1, 1.6, 0.08) },
};

/**
 * Strip provider prefixes, date suffixes and context-window suffixes so that
 * "us.anthropic.claude-opus-4-8-v1:0", "claude-sonnet-4-5-20250929" and
 * "claude-opus-4-6[1m]" all map onto a PRICES key.
 */
export function normalizeModel(model: string): string {
  let m = model.toLowerCase().trim();
  m = m.replace(/\[1m\]$/, '');
  const idx = m.indexOf('claude-');
  if (idx > 0) m = m.slice(idx);
  m = m.replace(/@\d{8}$/, '');
  m = m.replace(/-v\d+(:\d+)?$/, '');
  m = m.replace(/-\d{8}$/, '');
  if (m === 'claude-haiku-3-5') m = 'claude-3-5-haiku';
  return m;
}

export function priceFor(model: string, promptTokens = 0, overrides?: Record<string, PriceEntry>): Price | undefined {
  const key = normalizeModel(model);
  const table = overrides ? { ...PRICES, ...overrides } : PRICES;
  let entry = table[key];
  if (!entry) {
    // Fall back to the longest known prefix, e.g. "claude-opus-5-5-preview" -> "claude-opus-5-5".
    const match = Object.keys(table)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (match) entry = table[match];
  }
  if (!entry) return undefined;
  if (entry.long && promptTokens > entry.long.threshold) return entry.long.price;
  return entry.base;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface TokenSplit {
  input: number;
  output: number;
  read: number;
  write5m: number;
  write1h: number;
}

export function splitUsage(u: Usage): TokenSplit {
  const writeTotal = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5mExplicit = u.cache_creation?.ephemeral_5m_input_tokens;
  const w5m = w5mExplicit ?? Math.max(0, writeTotal - w1h);
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    write5m: w5m,
    write1h: w1h,
  };
}

export function promptTokens(s: TokenSplit): number {
  return s.input + s.read + s.write5m + s.write1h;
}

/** Cost in USD of one request with the given token split on the given model. */
export function costOf(model: string, s: TokenSplit, overrides?: Record<string, PriceEntry>): number {
  const price = priceFor(model, promptTokens(s), overrides);
  if (!price) return 0;
  return (
    (s.input * price.input +
      s.output * price.output +
      s.read * price.read +
      s.write5m * price.write5m +
      s.write1h * price.write1h) /
    1_000_000
  );
}

export function isPriced(model: string): boolean {
  return priceFor(model) !== undefined;
}
