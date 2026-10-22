import type { RouterConfig } from './config.js';
import type { Decision } from './engine.js';
import { OVERRIDE_RE, type ContentBlock, type Features, type Message, type MessagesRequest } from './features.js';
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
 * Effort is set per message. Claude Code ends every request with a `role: "system"`
 * control message that carries `output_config.effort` for the turn (beta
 * per-turn-control-2026-07-01); Legato rewrites that value. The control message is
 * the tail of the request, never part of the user/assistant history Claude Code re-sends,
 * so changing it edits no history: the cached prefix and every preserved thinking block
 * stay valid, and nothing has to be remembered between requests. A client that sends no
 * control message gets an effort-only message appended instead, under the
 * mid-conversation effort beta.
 */
export function controlMessageIndex(messages: Message[]): number {
  const last = messages.length - 1;
  const m = messages[last];
  return m && m.role === 'system' && m.output_config !== undefined ? last : -1;
}

export function effortMessage(effort: Effort): Message {
  return { role: 'system', content: [], output_config: { effort } };
}

/** Remove a leading //h //s //o //f from user text, the same way on every request. */
function stripOverrides(messages: Message[]): { messages: Message[]; changed: boolean } {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== 'user') return m;
    if (typeof m.content === 'string') {
      if (!OVERRIDE_RE.test(m.content)) return m;
      changed = true;
      return { ...m, content: m.content.replace(OVERRIDE_RE, '') };
    }
    let hit = false;
    const content = m.content.map((b: ContentBlock) => {
      if (b.type === 'text' && typeof b.text === 'string' && OVERRIDE_RE.test(b.text)) {
        hit = true;
        return { ...b, text: b.text.replace(OVERRIDE_RE, '') };
      }
      return b;
    });
    if (!hit) return m;
    changed = true;
    return { ...m, content };
  });
  return { messages: changed ? out : messages, changed };
}

function canChangeEffortPerMessage(model: string, thinkingType: string | undefined): boolean {
  if (!supportsPerMessageEffort(model)) return false;
  // Sonnet 5.5 with between_tools and Haiku 5.5 with thinking disabled reject per-message effort changes.
  return thinkingType !== 'between_tools' && thinkingType !== 'disabled';
}

export interface Rewrite {
  body: MessagesRequest;
  betas: string[];
  /** Effort this request runs at after rewriting, when known. */
  effort?: Effort;
  /** A user turn whose effort differs from what Claude Code asked for. */
  effortChanged: boolean;
  modified: boolean;
  notes: string[];
}

/**
 * Apply a routing decision to a request: set the model, make parameters valid for it,
 * and set the turn's effort. `sessionEffort` is the effort the current turn started on,
 * so its tool-loop steps (which the engine holds without an effort) keep running there.
 */
export function rewriteRequest(
  original: MessagesRequest,
  decision: Decision,
  features: Features,
  sessionEffort: Effort | undefined,
  cfg: RouterConfig,
): Rewrite {
  const notes: string[] = [];
  const body = structuredClone(original) as MessagesRequest;
  const sourceMessages = original.messages ?? [];

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

  const stripped = stripOverrides(sourceMessages);
  let messages = stripped.messages;
  let changed = stripped.changed;
  const betas: string[] = [];

  const asked = features.incomingEffort as Effort | undefined;
  const perMessage = cfg.routeEffort && canChangeEffortPerMessage(model, body.thinking?.type);
  // A user turn takes the engine's effort; a tool-loop step keeps the turn's.
  const wanted = features.newUserTurn ? decision.effort : (decision.effort ?? sessionEffort);
  const desired = wanted ?? asked;
  const target = desired ? clampEffort(model, desired) : undefined;
  let effort = asked ?? defaultEffort(model);
  let effortChanged = false;

  if (perMessage && target && target !== asked) {
    const idx = controlMessageIndex(messages);
    if (idx >= 0) {
      const control = messages[idx]!;
      messages = [...messages.slice(0, idx), { ...control, output_config: { ...(control.output_config as object), effort: target } }];
      notes.push(`effort ${asked ?? 'default'} -> ${target} (rewrote the per-turn control message)`);
    } else {
      messages = [...messages, effortMessage(target)];
      betas.push(PER_MESSAGE_EFFORT_BETA);
      notes.push(`effort ${asked ?? 'default'} -> ${target} (appended an effort-only message)`);
    }
    changed = true;
    effort = target;
    effortChanged = features.newUserTurn;
  }
  body.messages = messages;

  const modified = model !== original.model || betas.length > 0 || notes.length > 0 || changed;
  return { body, betas, effort, effortChanged, modified, notes };
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
