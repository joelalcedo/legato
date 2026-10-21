import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationState } from './engine.js';
import { newState } from './engine.js';
import { forkIndex, type MessagesRequest } from './features.js';
import { stableHash } from './hash.js';

export interface SessionRecord {
  key: string;
  state: ConversationState;
  /** Cache warmth of the model Claude Code asked for, as if the router were off. */
  baseline: { at: number; promptTokens: number } | undefined;
  lastIncomingModel?: string;
  createdAt: number;
}

/** Claude Code's session id, from the JSON it puts in metadata.user_id. */
export function sessionIdOf(req: MessagesRequest): string | undefined {
  const raw = req.metadata?.user_id;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string') return parsed.session_id;
  } catch {
    /* older format below */
  }
  return /session_([0-9a-f-]{36})/.exec(raw)?.[1];
}

/**
 * Identify a conversation. Claude Code puts the session id in metadata.user_id, but
 * subagents share it, so the key also hashes the system prompt and the first message:
 * each subagent gets its own routing state. A fork re-sends its parent's history, so
 * the position of its fork boilerplate is hashed too, or it would share the parent's state.
 */
export function conversationKey(req: MessagesRequest): string {
  const first = req.messages?.[0];
  return stableHash([req.metadata?.user_id ?? '', req.system ?? '', first ?? null, forkIndex(req.messages ?? [])]);
}

const KEEP_MS = 48 * 3_600_000;

/**
 * Routing state per conversation. Records are kept on disk under `<dir>/state` so a proxy
 * restart mid-session doesn't forget which model and effort a conversation is on (forgetting
 * would re-route it and rebuild its cache).
 */
export class SessionStore {
  private map = new Map<string, SessionRecord>();
  private dir: string | undefined;

  constructor(private max = 500, dir?: string) {
    if (dir) {
      this.dir = join(dir, 'state');
      try {
        mkdirSync(this.dir, { recursive: true });
        const cutoff = Date.now() - KEEP_MS;
        for (const f of readdirSync(this.dir)) {
          const p = join(this.dir, f);
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        }
      } catch {
        this.dir = undefined;
      }
    }
  }

  get(req: MessagesRequest, now: number): SessionRecord {
    const key = conversationKey(req);
    let rec = this.map.get(key);
    if (rec) {
      this.map.delete(key);
    } else {
      rec = this.load(key) ?? { key, state: newState(), baseline: undefined, createdAt: now };
    }
    this.map.set(key, rec);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return rec;
  }

  save(rec: SessionRecord): void {
    if (!this.dir) return;
    try {
      writeFileSync(join(this.dir, rec.key + '.json'), JSON.stringify(rec));
    } catch {
      /* a failed save only costs the restart protection */
    }
  }

  private load(key: string): SessionRecord | undefined {
    if (!this.dir) return undefined;
    const p = join(this.dir, key + '.json');
    if (!existsSync(p)) return undefined;
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8')) as SessionRecord;
      return rec.key === key && rec.state ? rec : undefined;
    } catch {
      return undefined;
    }
  }

  get size(): number {
    return this.map.size;
  }
}
