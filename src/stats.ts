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
  /** `aliased`: the bytes went as sent except for the model name, which was a launch alias. */
  forwarded: 'original' | 'rewritten' | 'aliased';
  alias?: string;
  /** Model the upstream request named. */
  ranOn: string;
  failOpen?: boolean;
  reasons: string[];
  notes: string[];
  userPreview?: string;
  /** Claude Code's session id, shared by a session's main thread and its subagents. */
  sessionId?: string;
  agentType?: string;
  /** Trial arm, when cfg.trial applied to this conversation. */
  arm?: 'A' | 'B';
  /** Which classifier produced the tier: the heuristic, or the model named in config. */
  classifier?: string;
  /** Wall time from the request arriving to the response finishing (or being abandoned). */
  latencyMs?: number;
}

/** What the status line shows for one Claude Code session: its main thread's latest decision and running totals. */
export interface SessionStatus {
  sessionId: string;
  at: string;
  mode: 'live' | 'shadow';
  incoming: string;
  model: string;
  effort?: string;
  incomingEffort?: string;
  /** The model name Claude Code was launched with when it is an alias such as `dynamic`. */
  alias?: string;
  switched: boolean;
  /** The engine's first reason, which names a hold or a switch. */
  reason: string;
  turns: number;
  requests: number;
  costUsd: number;
  baselineUsd: number;
}

export function displayName(model: string): string {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

/**
 * One line for Claude Code's status line, in words: what this session is running on, how that
 * differs from what Claude Code asked for, and what it has saved so far.
 *
 *   ⇄ running on Sonnet 5.5 at medium effort instead of Opus 5.5 · saved $0.57 over 3 turns
 *   ⇄ running on Opus 5.5 at medium effort (asked xhigh) · switch held: rebuild $0.97 · saved $0.31 over 7 turns
 *   ⇄ dynamic: running on Haiku 5.5 at low effort · saved $0.70 over 1 turn
 */
export function formatStatus(s: SessionStatus): string {
  const saved = s.baselineUsd - s.costUsd;
  const shadow = s.mode === 'shadow';
  let line = `⇄ ${s.alias ? s.alias + ': ' : ''}${shadow ? 'shadow: would run' : 'running'} on ${displayName(s.model)}`;
  if (s.effort) line += ` at ${s.effort} effort`;
  // With an alias the user delegated the choice, so there is nothing to compare against.
  if (s.alias) {
    // nothing
  } else if (s.model !== s.incoming) line += ` instead of ${displayName(s.incoming)}`;
  else if (s.effort && s.incomingEffort && s.effort !== s.incomingEffort) line += ` (asked ${s.incomingEffort})`;
  else line += ', as asked';
  if (s.reason.startsWith('hold ')) {
    const rebuild = /rebuild \$([\d.]+)/.exec(s.reason);
    const thinking = /drop ~(\d+K) tokens/.exec(s.reason);
    line += thinking ? ` · switch held: ${thinking[1]} of thinking` : rebuild ? ` · switch held: rebuild $${Number(rebuild[1]).toFixed(2)}` : ' · switch held';
  }
  const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`;
  return `${line} · ${shadow ? 'would save' : 'saved'} $${saved.toFixed(2)} over ${turns}`;
}

const SESSION_ID_RE = /^[0-9A-Za-z_-]{1,80}$/;

function statusPath(dir: string, sessionId: string): string | undefined {
  return SESSION_ID_RE.test(sessionId) ? join(dir, 'status', sessionId + '.json') : undefined;
}

export function writeSessionStatus(dir: string, s: SessionStatus): void {
  const p = statusPath(dir, s.sessionId);
  if (!p) return;
  try {
    mkdirSync(join(dir, 'status'), { recursive: true });
    writeFileSync(p, JSON.stringify(s));
  } catch {
    /* the status line is best-effort */
  }
}

export function readSessionStatus(dir: string, sessionId: string): SessionStatus | undefined {
  const p = statusPath(dir, sessionId);
  if (!p || !existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SessionStatus;
  } catch {
    return undefined;
  }
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

  constructor(dir: string, private persist = true) {
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
