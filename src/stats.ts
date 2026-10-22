import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayName, effortClause, modelClause, money, holdClause, type Hold } from './words.js';

export { displayName };

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
  /** The model name Claude Code was launched with when it is an alias such as `Dynamic mode`. */
  alias?: string;
  /** false: the last request was forwarded as sent (unknown model, routing off). */
  through?: boolean;
  /** HTTP status of the last request, so a failing session says so instead of showing stale numbers. */
  lastStatus?: number;
  switched: boolean;
  /** Model the session's main thread was on before the last decision. */
  from?: string;
  /** A switch the policy wanted but did not take, and why. */
  held?: Hold;
  /** The engine's first reason, in plain words. */
  reason: string;
  turns: number;
  requests: number;
  costUsd: number;
  baselineUsd: number;
}

/**
 * One line for Claude Code's status line: what this task runs on, whether that is a change,
 * the effort, and what the session has saved so far.
 *
 *   Legato: switched from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of xhigh · saved $0.58 this session
 *   Legato: staying on Opus 5.5 for this task, using medium effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.95 more than it saves) · saved $0.31 this session
 *   Legato: Haiku 5.5 for this task, using low effort · saved $0.70 this session
 */
export function formatStatus(s: SessionStatus): string {
  if (s.lastStatus !== undefined && s.lastStatus >= 400 && s.lastStatus !== 499) {
    const what = s.lastStatus === 404 ? `the API does not know the model "${s.incoming}"` : `the API answered HTTP ${s.lastStatus}`;
    const hint = s.through === false ? `; if you just rebuilt legato, restart the proxy` : '';
    return `Legato: the last request failed, ${what}${hint}`;
  }
  if (s.through === false) return `Legato: not routing "${s.incoming}" (${s.reason})`;
  const saved = s.baselineUsd - s.costUsd;
  const shadow = s.mode === 'shadow';
  // The alias ("Dynamic mode") is not a model, so a first pick is not a switch from it.
  const from = s.from ?? (s.alias ? undefined : s.incoming);
  const h = { from, to: s.model, effort: s.effort, asked: s.incomingEffort, switched: s.switched, held: s.held };
  let line = `Legato${shadow ? ' (shadow)' : ''}: ${modelClause(h, shadow ? 'conditional' : 'past')}${effortClause(h)}`;
  if (s.held) line += ` (${holdClause(s.held)})`;
  const tally =
    saved >= -0.005
      ? `${shadow ? 'would have saved' : 'saved'} ${money(Math.max(0, saved))} this session`
      : `${shadow ? 'would have spent' : 'spent'} ${money(-saved)} more than Claude Code alone this session`;
  return `${line} · ${tally}`;
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
