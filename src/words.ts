import type { Effort, Tier } from './models.js';

/**
 * Every sentence Legato shows a person comes from here: the status line, `legato explain`,
 * the proxy log and the dashboard. The rule is one plain sentence per fact, with the models
 * named the way Claude Code names them and money in dollars and cents, never in jargon.
 */

/** `claude-opus-5-5` reads as `Opus 5.5`, the way Claude Code's header writes it. */
export function displayName(model: string): string {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

export function tierName(t: Tier): string {
  return t[0]!.toUpperCase() + t.slice(1);
}

/** "$0.97", "4¢", "under 1¢". Negative amounts keep their sign: "-$0.95". */
export function money(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  const v = Math.abs(usd);
  if (v < 0.005) return v === 0 ? '$0.00' : 'under 1¢';
  if (v < 0.1) return `${sign}${Math.round(v * 100)}¢`;
  return `${sign}$${v.toFixed(2)}`;
}

export function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K tokens` : `${n} tokens`;
}

/** Money to a tenth of a cent when under 10¢, so a per-request figure times a run adds up on paper. */
export function money1(usd: number): string {
  const v = Math.abs(usd);
  if (v >= 0.1) return money(usd);
  const tenths = Math.round(v * 1000) / 10;
  if (tenths === 0) return 'under 0.1¢';
  return `${usd < 0 ? '-' : ''}${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}¢`;
}

/** A cheaper model can be cheaper even uncached, so a rebuild cost at or below zero is "nothing". */
export function rebuildPhrase(usd: number): string {
  return usd < 0.005 ? 'costs nothing up front' : `costs ${money(usd)} to rebuild the cache`;
}

export interface Arithmetic {
  perRequest: number;
  run: number;
  /** perRequest × run, in whole cents. */
  saving: number;
  rebuild: number;
  back: number;
  /** saving − rebuild − back, from the rounded terms, so the printed sum is true. */
  net: number;
}

/**
 * The switch sum with each term rounded to the cent before the subtraction, so a reader who
 * checks the printed figures gets the printed result. It can differ from the engine's exact net
 * by a cent; every sentence uses this one, so no two sentences disagree.
 */
export function arithmetic(e: { perRequestSavingUsd: number; rebuildUsd: number; returnUsd: number }, run: number): Arithmetic {
  const cents = (x: number) => Math.round(x * 100) / 100;
  const saving = cents(e.perRequestSavingUsd * run);
  const rebuild = cents(Math.max(0, e.rebuildUsd));
  const back = cents(e.returnUsd);
  return { perRequest: e.perRequestSavingUsd, run, saving, rebuild, back, net: cents(saving - rebuild - back) };
}

const SIGNAL_WORDS: Record<string, string> = {
  design: 'design',
  diagnosis: 'finding a cause',
  'hard-bug': 'a hard bug',
  security: 'security',
  'large-change': 'a large change',
  performance: 'performance work',
  systems: 'systems work',
  planning: 'planning',
  'asked-for-depth': 'you asked for care',
  'retry-after-failure': 'a retry after a failure',
  reasoning: 'reasoning',
  'mechanical-edit': 'a mechanical edit',
  chore: 'a chore',
  vcs: 'git',
  lookup: 'a lookup',
  'run-command': 'running a command',
  acknowledgement: 'an acknowledgement',
  greeting: 'a greeting',
  confirmation: 'a confirmation',
  'pasted-content': 'pasted content',
};

/** The classifier's signals (`+3 diagnosis`, `-2 vcs`) as a short list of words. */
export function describeSignals(signals: string[]): string {
  const words = signals.map((s) => {
    const label = s.replace(/^[+-]\d+\s+/, '');
    return SIGNAL_WORDS[label] ?? label;
  });
  return [...new Set(words)].join(', ');
}

/** Which cache price table `legato explain` used, and how to get the other one. */
export function ttlNote(cacheTtlSeconds: number): string {
  return cacheTtlSeconds >= 3600
    ? 'Priced with the 1-hour cache, which the main thread uses on a subscription.'
    : 'Priced with the 5-minute cache, as on an API key. On a subscription the main thread uses the 1-hour cache: pass --ttl 3600 to see that case.';
}

/** What a classified tier means in words: the thing a person would call the task. */
export function taskKind(tier: Tier): string {
  switch (tier) {
    case 'haiku':
      return 'a quick task';
    case 'sonnet':
      return 'an ordinary coding task';
    default:
      return 'a hard task';
  }
}

/** Models named in a sentence: "an Explore agent", "a general-purpose agent". */
export function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Why a switch the policy wanted was not taken. */
export interface Hold {
  /** The model the switch would have gone to. */
  model: string;
  why: 'cost' | 'weak-upgrade';
  rebuildUsd?: number;
  /** For `cost`: how much the switch would lose over the expected run (positive). */
  lossUsd?: number;
}

export function holdClause(h: Hold): string {
  const to = displayName(h.model);
  if (h.why === 'weak-upgrade') return `not clearly hard enough to pay ${money(h.rebuildUsd ?? 0)} for ${to}`;
  return `a switch to ${to} would cost ${money(h.lossUsd ?? 0)} more than it saves`;
}

export interface Headline {
  /** Model the conversation was on before this decision; undefined on its first request. */
  from?: string;
  to: string;
  effort?: Effort | string;
  /** The effort Claude Code asked for (the user's /effort setting). */
  asked?: string;
  switched: boolean;
  held?: Hold;
}

type Tense = 'past' | 'imperative' | 'conditional';

/**
 * "switched from Opus 5.5 to Sonnet 5.5 for this task" / "staying on Opus 5.5 for this task" /
 * "chose Haiku 5.5 for this task" (a conversation's first pick) / "kept Opus 5.5 for this task".
 */
export function modelClause(h: Headline, tense: Tense = 'past'): string {
  const to = displayName(h.to);
  const from = h.from ? displayName(h.from) : undefined;
  const verb = (past: string, imperative: string) => (tense === 'past' ? past : tense === 'imperative' ? imperative : `would ${imperative.toLowerCase()}`);
  if (h.switched && from && from !== to) return `${verb('switched', 'Switch')} from ${from} to ${to} for this task`;
  if (h.held) return `${verb('staying', 'Stay')} on ${to} for this task`;
  if (!from) return `${verb('chose', 'Choose')} ${to} for this task`;
  return `${verb('kept', 'Keep')} ${to} for this task`;
}

/** ", using medium effort instead of xhigh" / ", using xhigh effort, as you set" / "" */
export function effortClause(h: Headline): string {
  if (!h.effort) return '';
  let s = `, using ${h.effort} effort`;
  if (h.asked && h.asked !== h.effort) s += ` instead of ${h.asked}`;
  else if (h.asked) s += ', as you set';
  return s;
}

/**
 * The one-line summary `legato explain` prints (imperative) and the proxy logs (past tense).
 * `withHold` adds why a wanted switch was not taken; `explain` leaves it out because the reasons
 * that follow say it with the numbers.
 */
export function headline(h: Headline, tense: Tense = 'imperative', withHold = true): string {
  let s = modelClause(h, tense) + effortClause(h);
  if (h.held && withHold) s += ` (${holdClause(h.held)})`;
  return capitalize(s) + '.';
}
