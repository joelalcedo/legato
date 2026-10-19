import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DecisionLogEntry {
  ts: string;
  session: string;
  mode: 'live' | 'shadow';
  incoming: string;
  routed: string;
  effort?: string;
  switched: boolean;
  freeSwitch?: boolean;
  effortChanged: boolean;
  newUserTurn: boolean;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineUsd: number;
  status: number;
  /** What went upstream: Claude Code's request byte for byte, or the routed rewrite. */
  forwarded: 'original' | 'rewritten';
  /** Model the upstream request named. */
  ranOn: string;
  failOpen?: boolean;
  reasons: string[];
  notes: string[];
  userPreview?: string;
}

export interface Stats {
  startedAt: string;
  requests: number;
  routed: number;
  passthrough: number;
  switches: number;
  freeSwitches: number;
  effortChanges: number;
  failOpens: number;
  costUsd: number;
  baselineUsd: number;
  byModel: Record<string, { requests: number; costUsd: number }>;
  last?: { routed: string; effort?: string; at: string };
}

export function emptyStats(): Stats {
  return {
    startedAt: new Date().toISOString(),
    requests: 0,
    routed: 0,
    passthrough: 0,
    switches: 0,
    freeSwitches: 0,
    effortChanges: 0,
    failOpens: 0,
    costUsd: 0,
    baselineUsd: 0,
    byModel: {},
  };
}

/** Running totals plus an append-only JSONL decision log under the data directory. */
export class StatsStore {
  stats: Stats;
  recent: DecisionLogEntry[] = [];
  private statsPath: string;
  private logPath: string;
  private pending = false;

  constructor(private dir: string, private persist = true) {
    this.statsPath = join(dir, 'stats.json');
    this.logPath = join(dir, 'decisions.jsonl');
    this.stats = emptyStats();
    if (persist) {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.statsPath)) {
        try {
          this.stats = { ...emptyStats(), ...JSON.parse(readFileSync(this.statsPath, 'utf8')) };
        } catch {
          /* start fresh on a corrupt file */
        }
      }
    }
  }

  record(e: DecisionLogEntry, routed: boolean): void {
    const s = this.stats;
    s.requests++;
    if (routed) s.routed++;
    else s.passthrough++;
    if (e.switched) s.switches++;
    if (e.freeSwitch && e.switched) s.freeSwitches++;
    if (e.effortChanged) s.effortChanges++;
    if (e.failOpen) s.failOpens++;
    s.costUsd += e.costUsd;
    s.baselineUsd += e.baselineUsd;
    const bm = (s.byModel[e.routed] ??= { requests: 0, costUsd: 0 });
    bm.requests++;
    bm.costUsd += e.costUsd;
    s.last = { routed: e.routed, effort: e.effort, at: e.ts };

    this.recent.unshift(e);
    if (this.recent.length > 200) this.recent.pop();
    if (this.persist) {
      appendFileSync(this.logPath, JSON.stringify(e) + '\n');
      this.flushSoon();
    }
  }

  private flushSoon(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
    }, 250).unref();
  }

  flush(): void {
    if (this.persist) writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
  }
}

export function readStats(dir: string): Stats | undefined {
  const p = join(dir, 'stats.json');
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Stats;
  } catch {
    return undefined;
  }
}
