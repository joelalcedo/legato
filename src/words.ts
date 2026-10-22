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

/** A cheaper model can be cheaper even uncached, so a rebuild cost at or below zero is "nothing". */
export function rebuildPhrase(usd: number): string {
  return usd < 0.005 ? 'costs nothing up front' : `costs ${money(usd)} to rebuild the cache`;
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
  'long-prompt': 'a long prompt',
  'medium-prompt': 'a medium-length prompt',
  confirmation: 'a confirmation',
};

/** The classifier's signals (`+3 diagnosis`, `-2 vcs`) as a short list of words. */
export function describeSignals(signals: string[]): string {
  const words = signals.map((s) => {
    const label = s.replace(/^[+-]\d+\s+/, '');
    const list = /^(\d+)-item-list$/.exec(label);
    if (list) return `a ${list[1]}-item list`;
    return SIGNAL_WORDS[label] ?? label;
  });
  return [...new Set(words)].join(', ');
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
  why: 'cost' | 'thinking' | 'weak-upgrade';
  rebuildUsd?: number;
  /** For `cost`: how much the switch would lose over the expected run (positive). */
  lossUsd?: number;
  thinkingTokens?: number;
}

export function holdClause(h: Hold): string {
  const to = displayName(h.model);
  if (h.why === 'thinking') return `a switch to ${to} would throw away this conversation's thinking`;
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

/** "switched from Opus 5.5 to Sonnet 5.5 for this task" / "staying on Opus 5.5 for this task" / "Haiku 5.5 for this task". */
export function modelClause(h: Headline, tense: 'past' | 'imperative' | 'conditional' = 'past'): string {
  const to = displayName(h.to);
  const from = h.from ? displayName(h.from) : undefined;
  if (h.switched && from && from !== to) {
    const verb = tense === 'past' ? 'switched' : tense === 'imperative' ? 'Switch' : 'would switch';
    return `${verb} from ${from} to ${to} for this task`;
  }
  if (h.held) {
    const verb = tense === 'past' ? 'staying' : tense === 'imperative' ? 'Stay' : 'would stay';
    return `${verb} on ${to} for this task`;
  }
  return tense === 'imperative' ? `Keep ${to} for this task` : `${to} for this task`;
}

/** ", using medium effort instead of xhigh" / ", using xhigh effort, as you set" / "" */
export function effortClause(h: Headline): string {
  if (!h.effort) return '';
  let s = `, using ${h.effort} effort`;
  if (h.asked && h.asked !== h.effort) s += ` instead of ${h.asked}`;
  else if (h.asked) s += ', as you set';
  return s;
}

/** The one-line summary `legato explain` prints (imperative) and the proxy logs (past tense). */
export function headline(h: Headline, tense: 'past' | 'imperative' | 'conditional' = 'imperative'): string {
  let s = modelClause(h, tense) + effortClause(h);
  if (h.held) s += ` (${holdClause(h.held)})`;
  return capitalize(s) + '.';
}
