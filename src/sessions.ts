import type { ConversationState } from './engine.js';
import { newState } from './engine.js';
import type { MessagesRequest } from './features.js';
import type { LedgerEntry } from './rewrite.js';
import { stableHash } from './rewrite.js';

export interface SessionRecord {
  key: string;
  state: ConversationState;
  ledger: LedgerEntry[];
  /** Cache warmth of the model Claude Code asked for, as if the router were off. */
  baseline: { at: number; promptTokens: number } | undefined;
  lastIncomingModel?: string;
  createdAt: number;
}

/**
 * Identify a conversation. Claude Code puts the session id in metadata.user_id,
 * but subagents share it, so the key also hashes the system prompt and the first
 * message: each subagent gets its own routing state, which matters because every
 * subagent starts with a cold cache and can be routed for free.
 */
export function conversationKey(req: MessagesRequest): string {
  const first = req.messages?.[0];
  return stableHash([req.metadata?.user_id ?? '', req.system ?? '', first ?? null]);
}

export class SessionStore {
  private map = new Map<string, SessionRecord>();
  constructor(private max = 500) {}

  get(req: MessagesRequest, now: number): SessionRecord {
    const key = conversationKey(req);
    let rec = this.map.get(key);
    if (rec) {
      this.map.delete(key);
    } else {
      rec = { key, state: newState(), ledger: [], baseline: undefined, createdAt: now };
    }
    this.map.set(key, rec);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return rec;
  }

  get size(): number {
    return this.map.size;
  }
}
