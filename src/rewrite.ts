import { createHash } from 'node:crypto';
import type { RouterConfig } from './config.js';
import type { Decision } from './engine.js';
import { blocksOf, OVERRIDE_RE, type ContentBlock, type Features, type Message, type MessagesRequest } from './features.js';
import {
  clampEffort,
  defaultEffort,
  PER_MESSAGE_EFFORT_BETA,
  supportsPerMessageEffort,
  thinkingAlwaysOn,
  type Effort,
} from './models.js';
import { normalizeModel } from './pricing.js';

/**
 * Per-message effort changes are injected as effort-only `role: "system"` messages.
 * Claude Code doesn't know about them, so it re-sends its own history without them.
 * The ledger remembers where each one was placed and re-inserts it at the same
 * point on every later request, which keeps the request prefix byte-identical and
 * the prompt cache warm.
 */
export interface LedgerEntry {
  /** Index of the anchor message in Claude Code's own message list (before injection). */
  index: number;
  /** Hash of the anchor message content, so a compacted or rewritten history drops the entry. */
  hash: string;
  effort: Effort;
}

/** JSON with cache_control removed: Claude Code moves cache breakpoints between requests. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v));
}

export function stableHash(value: unknown): string {
  return createHash('sha1').update(stableJson(value)).digest('hex').slice(0, 16);
}

export function messageHash(m: Message): string {
  return stableHash([m.role, m.content]);
}

/** Drop entries whose anchor no longer matches (after /compact, /clear, /rewind). */
export function pruneLedger(messages: Message[], ledger: LedgerEntry[]): LedgerEntry[] {
  return ledger.filter((e) => {
    const m = messages[e.index];
    return !!m && messageHash(m) === e.hash;
  });
}

export function effortMessage(effort: Effort): Message {
  return { role: 'system', content: [], output_config: { effort } };
}

export function injectLedger(messages: Message[], ledger: LedgerEntry[]): Message[] {
  if (!ledger.length) return messages;
  const byIndex = new Map<number, LedgerEntry>();
  for (const e of ledger) byIndex.set(e.index, e);
  const out: Message[] = [];
  messages.forEach((m, i) => {
    out.push(m);
    const e = byIndex.get(i);
    if (e) out.push(effortMessage(e.effort));
  });
  return out;
}

/** Remove a leading //h //s //o //f from user text, the same way on every request. */
function stripOverrides(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== 'user') return m;
    if (typeof m.content === 'string') {
      return OVERRIDE_RE.test(m.content) ? { ...m, content: m.content.replace(OVERRIDE_RE, '') } : m;
    }
    let changed = false;
    const content = m.content.map((b: ContentBlock) => {
      if (b.type === 'text' && typeof b.text === 'string' && OVERRIDE_RE.test(b.text)) {
        changed = true;
        return { ...b, text: b.text.replace(OVERRIDE_RE, '') };
      }
      return b;
    });
    return changed ? { ...m, content } : m;
  });
}

export function effectiveEffort(req: MessagesRequest, ledger: LedgerEntry[]): Effort | undefined {
  const last = ledger[ledger.length - 1];
  if (last) return last.effort;
  const top = req.output_config?.effort as Effort | undefined;
  return top ?? defaultEffort(req.model);
}

function canChangeEffortPerMessage(model: string, thinkingType: string | undefined): boolean {
  if (!supportsPerMessageEffort(model)) return false;
  // Sonnet 5.5 with between_tools and Haiku 5.5 with thinking disabled reject per-message effort changes.
  return thinkingType !== 'between_tools' && thinkingType !== 'disabled';
}

export interface Rewrite {
  body: MessagesRequest;
  ledger: LedgerEntry[];
  betas: string[];
  /** Effort this request runs at after rewriting, when known. */
  effort?: Effort;
  effortChanged: boolean;
  modified: boolean;
  notes: string[];
}

/**
 * Apply a routing decision to a request: set the model, make parameters valid for
 * it, and maintain the per-message effort ledger.
 */
export function rewriteRequest(
  original: MessagesRequest,
  decision: Decision,
  features: Features,
  ledgerIn: LedgerEntry[],
  cfg: RouterConfig,
): Rewrite {
  const notes: string[] = [];
  const body = structuredClone(original) as MessagesRequest;
  const sourceMessages = original.messages ?? [];
  let ledger = pruneLedger(sourceMessages, ledgerIn);
  if (ledger.length !== ledgerIn.length) notes.push(`dropped ${ledgerIn.length - ledger.length} stale effort entries`);

  const model = decision.model;
  body.model = model;

  // Thinking can't be disabled on Opus 5.5, Sonnet 5.5 or the Fable models.
  if (body.thinking?.type === 'disabled' && thinkingAlwaysOn(model)) {
    delete body.thinking;
    notes.push('removed thinking:disabled for an always-thinking model');
  }
  // between_tools is a Sonnet 5.5 thinking mode.
  if (body.thinking?.type === 'between_tools' && normalizeModel(model) !== 'claude-sonnet-5-5') {
    delete body.thinking;
    notes.push('removed thinking:between_tools for a non-Sonnet-5.5 model');
  }
  const cap = cfg.maxOutputTokens[normalizeModel(model)];
  if (cap && typeof body.max_tokens === 'number' && body.max_tokens > cap) {
    notes.push(`max_tokens ${body.max_tokens} -> ${cap}`);
    body.max_tokens = cap;
  }
  const top = body.output_config?.effort as Effort | undefined;
  if (top) {
    const c = clampEffort(model, top);
    if (!c) {
      delete body.output_config!.effort;
      notes.push(`removed top-level effort for ${model}`);
    } else if (c !== top) {
      body.output_config!.effort = c;
      notes.push(`top-level effort ${top} -> ${c}`);
    }
  }

  let messages = stripOverrides(sourceMessages);
  let effortChanged = false;
  const thinkingType = body.thinking?.type;
  const perMessage = cfg.routeEffort && canChangeEffortPerMessage(model, thinkingType);

  if (perMessage && features.newUserTurn && decision.effort) {
    const current = effectiveEffort(body, ledger);
    if (current !== decision.effort) {
      const anchor = sourceMessages.length - 1;
      ledger = [...ledger.filter((e) => e.index !== anchor), {
        index: anchor,
        hash: messageHash(sourceMessages[anchor]!),
        effort: decision.effort,
      }];
      effortChanged = true;
      notes.push(`effort ${current ?? 'default'} -> ${decision.effort} (per-message, cache-safe)`);
    }
  }

  const betas: string[] = [];
  if (perMessage && ledger.length) {
    messages = injectLedger(messages, ledger);
    betas.push(PER_MESSAGE_EFFORT_BETA);
  }
  body.messages = messages;

  const effort = perMessage ? effectiveEffort(body, ledger) : (body.output_config?.effort as Effort | undefined) ?? defaultEffort(model);
  const modified = model !== original.model || betas.length > 0 || notes.length > 0 || messages !== sourceMessages;
  return { body, ledger, betas, effort, effortChanged, modified, notes };
}

export function mergeBetaHeader(existing: string | undefined, add: string[]): string | undefined {
  const set = new Set(
    (existing ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const b of add) set.add(b);
  return set.size ? [...set].join(',') : undefined;
}

/** Text of every block for debugging and tests. */
export function plainText(m: Message): string {
  return blocksOf(m.content)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
}
