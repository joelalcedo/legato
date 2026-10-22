import type { Effort, Tier } from './models.js';

/**
 * A transparent, dependency-free difficulty classifier for a single user turn.
 *
 * It is deliberately simple and explainable: every point it adds is reported
 * as a signal so a decision can be audited in the log. It is the default
 * because it costs nothing and runs offline; a learned router (RouteLLM-style)
 * or a Haiku-based classifier can replace it behind the same interface.
 */

export interface Classification {
  tier: Tier;
  effort: Effort;
  hard: number;
  easy: number;
  signals: string[];
}

interface Rule {
  re: RegExp;
  weight: number;
  label: string;
}

const HARD: Rule[] = [
  { re: /\b(architect(ure)?|system design|design (a|the|an)\b|trade-?offs?)\b/i, weight: 3, label: 'design' },
  { re: /\b(root cause|investigate|(figure|find) out (why|what)|why (does|is|do|are|did|would)|how come|diagnos)/i, weight: 3, label: 'diagnosis' },
  { re: /\b(race condition|deadlock|memory leak|heisenbug|flaky|intermittent|non-?deterministic)\b/i, weight: 3, label: 'hard-bug' },
  // "security master" is reference data in finance, not infosec.
  { re: /\b(security(?! master)|vulnerab|exploit|threat model|auth(entication|orization)? flow|cve)\b/i, weight: 3, label: 'security' },
  { re: /\b(migrat(e|ion)|re-?architect|rewrite|overhaul|large refactor|refactor (the|our|this) (whole|entire))\b/i, weight: 3, label: 'large-change' },
  // "profile" alone is usually a user-profile screen; profiling and profilers are performance work.
  { re: /\b(performance|latency|throughput|optimi[sz]e|profil(ing|er)|bottleneck)\b/i, weight: 2, label: 'performance' },
  { re: /\b(concurren|distributed|consisten(cy|t)|transaction|idempoten)/i, weight: 2, label: 'systems' },
  { re: /\b(plan|proposal|spec|rfc|strategy|approach)\b/i, weight: 1, label: 'planning' },
  { re: /\b(ultrathink|think (hard|harder|deeply|carefully)|be thorough|carefully)\b/i, weight: 3, label: 'asked-for-depth' },
  { re: /\b(still (fail|broken|not working|wrong)|same error|doesn'?t work|didn'?t (work|fix)|again\b|that broke)/i, weight: 2, label: 'retry-after-failure' },
  { re: /\b(prove|correctness|invariant|formal|algorithm|complexity)\b/i, weight: 2, label: 'reasoning' },
];

const EASY: Rule[] = [
  { re: /\b(rename|typo|spelling|reformat|format(ting)?|lint|prettier|whitespace|indent)\b/i, weight: 2, label: 'mechanical-edit' },
  { re: /\b(bump (the )?version|changelog|update (the )?readme|add (a )?comment|fix imports?)\b/i, weight: 2, label: 'chore' },
  { re: /\b(git (status|log|diff|add|push|pull)|commit( this| it| the)?|open a pr|push it)\b/i, weight: 2, label: 'vcs' },
  { re: /^\s*(where is|where are|find|list|show me|which files?|what files?|grep|search for|look up)\b/i, weight: 2, label: 'lookup' },
  { re: /\b(run (the )?(tests?|build|linter|script)|npm (run|test|install)|install (the )?dep)/i, weight: 1, label: 'run-command' },
  { re: /^\s*(thanks|thank you|ty|cool|nice|great|perfect)\b[.! ]*$/i, weight: 3, label: 'acknowledgement' },
];

/** Short confirmations kick off execution of an already-agreed plan: route to the workhorse, not Haiku. */
const CONFIRM_RE = /^\s*(y|yes|yep|yeah|ok(ay)?|sure|go( ahead)?|do it|proceed|continue|sounds good|lgtm|ship it)\b[.! ]*\S{0,20}$/i;

export function classify(text: string): Classification {
  const t = text.trim();
  const signals: string[] = [];
  let hard = 0;
  let easy = 0;

  for (const r of HARD) {
    if (r.re.test(t)) {
      hard += r.weight;
      signals.push(`+${r.weight} ${r.label}`);
    }
  }
  for (const r of EASY) {
    if (r.re.test(t)) {
      easy += r.weight;
      signals.push(`-${r.weight} ${r.label}`);
    }
  }

  // Length and structure: long, multi-requirement asks tend to be harder.
  if (t.length > 1200) {
    hard += 2;
    signals.push('+2 long-prompt');
  } else if (t.length > 500) {
    hard += 1;
    signals.push('+1 medium-prompt');
  }
  const listItems = (t.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length;
  if (listItems >= 4) {
    hard += 1;
    signals.push(`+1 ${listItems}-item-list`);
  }

  if (CONFIRM_RE.test(t)) {
    signals.push('confirmation');
    return { tier: 'sonnet', effort: 'medium', hard, easy, signals };
  }

  let tier: Tier;
  let effort: Effort;
  if (hard >= 3 && hard > easy) {
    tier = 'opus';
    effort = hard >= 6 ? 'high' : 'medium';
  } else if (easy >= 2 && hard === 0 && t.length < 400) {
    tier = 'haiku';
    effort = easy >= 3 ? 'low' : 'medium';
  } else {
    tier = 'sonnet';
    effort = hard >= 2 ? 'high' : easy >= 2 ? 'low' : 'medium';
  }
  return { tier, effort, hard, easy, signals };
}

export interface ModelClassifierOptions {
  apiKey: string;
  model: string;
  upstream: string;
  timeoutMs: number;
}

const MODEL_SYSTEM = `You route one request made inside a coding agent to a model tier. Reply with one line of JSON only:
{"tier":"haiku|sonnet|opus","effort":"low|medium|high|xhigh","why":"<under 10 words>"}
haiku: mechanical edits, lookups, git, acknowledgements. sonnet: ordinary feature work, confirmations of a plan, moderate edits. opus: root-cause debugging, architecture, concurrency, security, large refactors, anything asking for deep thought.`;
const MODEL_TIERS = ['haiku', 'sonnet', 'opus'];
const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const verdicts = new Map<string, Classification>();

/**
 * Classify with a small model. Returns undefined on timeout, error or an unusable reply so
 * the caller falls back to the heuristic. Verdicts are cached by text, so the tool-loop steps
 * of a turn cost nothing.
 */
export async function classifyWithModel(text: string, opts: ModelClassifierOptions): Promise<Classification | undefined> {
  const key = text.slice(0, 4000);
  const hit = verdicts.get(key);
  if (hit) return hit;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(`${opts.upstream}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 80,
        thinking: { type: 'disabled' },
        system: MODEL_SYSTEM,
        messages: [{ role: 'user', content: key }],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    const out = j.content?.find((b) => b.type === 'text')?.text ?? '';
    const m = /\{[\s\S]*\}/.exec(out);
    if (!m) return undefined;
    const v = JSON.parse(m[0]) as { tier?: string; effort?: string; why?: string };
    if (!MODEL_TIERS.includes(v.tier ?? '') || !MODEL_EFFORTS.includes(v.effort ?? '')) return undefined;
    const c: Classification = {
      tier: v.tier as Tier,
      effort: v.effort as Effort,
      hard: 0,
      easy: 0,
      signals: [`${opts.model}: ${v.why ?? ''}`.trim()],
    };
    if (verdicts.size >= 500) verdicts.delete(verdicts.keys().next().value!);
    verdicts.set(key, c);
    return c;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
