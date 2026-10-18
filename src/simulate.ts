import type { TokenSplit } from './pricing.js';

/**
 * How to re-price a request's measured tokens as if it had run on another model.
 *
 * - `continuous`: that model also served the previous request, so the real cache
 *   pattern applies unchanged.
 * - `capByRead`: that model is cold or out of date; it can read at most what the
 *   real request read, and only if it served this conversation within the TTL.
 *   Used for routed switches in the analyzer, which keeps savings estimates low.
 * - `capByCacheable`: the model never left; everything it last saw is still warm.
 *   Used for the unrouted baseline in live mode, after the router switched away.
 *
 * Input and output tokens stay as measured: output length on a different model is
 * unknowable from a transcript, so it is held constant.
 */
export type ResplitMode = 'continuous' | 'capByRead' | 'capByCacheable';

export function resplit(
  actual: TokenSplit,
  entry: { at: number; promptTokens: number } | undefined,
  now: number,
  ttlSeconds: number,
  mode: ResplitMode,
): TokenSplit {
  const cacheable = actual.read + actual.write5m + actual.write1h;
  let read: number;
  if (mode === 'continuous') {
    read = actual.read;
  } else {
    const warm = !!entry && now - entry.at < ttlSeconds * 1000;
    const cap = mode === 'capByRead' ? actual.read : cacheable;
    read = warm ? Math.min(entry!.promptTokens, cap) : 0;
  }
  const write = cacheable - read;
  const actualWrite = actual.write5m + actual.write1h;
  const share1h = actualWrite > 0 ? actual.write1h / actualWrite : ttlSeconds >= 3600 ? 1 : 0;
  const write1h = Math.round(write * share1h);
  return { input: actual.input, output: actual.output, read, write5m: write - write1h, write1h };
}
