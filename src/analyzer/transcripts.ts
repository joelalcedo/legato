import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ContentBlock, Message } from '../features.js';
import type { Usage } from '../pricing.js';

/**
 * Reader for Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl).
 *
 * Each line is one event. Claude Code writes an assistant response as one line per
 * content block, all sharing the same message.id and usage, and writes each tool
 * result as its own user line. This reader merges those back into API-shaped
 * messages and emits one ReplayRequest per real API response.
 */

export interface ReplayRequest {
  /** The request carried conversation.messages.slice(0, messageCount). */
  messageCount: number;
  model: string;
  usage: Usage;
  timestamp: number;
}

export interface Conversation {
  id: string;
  file: string;
  project: string;
  sessionId: string;
  isSubagent: boolean;
  messages: Message[];
  requests: ReplayRequest[];
}

interface RawLine {
  type?: string;
  sessionId?: string;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: Usage;
  };
}

export function findTranscripts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function toBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function parseTranscript(file: string, root: string): Conversation[] {
  const text = readFileSync(file, 'utf8');
  const project = relative(root, file).split(/[\\/]/)[0] ?? '';
  const streams = new Map<string, { sessionId: string; isSubagent: boolean; lines: RawLine[] }>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: RawLine;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if ((j.type !== 'user' && j.type !== 'assistant') || !j.message) continue;
    const sessionId = j.sessionId ?? 'unknown';
    const sub = j.isSidechain === true;
    const key = `${sessionId}${sub ? ':' + (j.agentId ?? 'sidechain') : ''}`;
    let s = streams.get(key);
    if (!s) streams.set(key, (s = { sessionId, isSubagent: sub, lines: [] }));
    s.lines.push(j);
  }

  const out: Conversation[] = [];
  for (const [key, s] of streams) {
    const { messages, requests } = buildRequests(s.lines);
    if (requests.length) {
      out.push({ id: key, file, project, sessionId: s.sessionId, isSubagent: s.isSubagent, messages, requests });
    }
  }
  return out;
}

function buildRequests(lines: RawLine[]): { messages: Message[]; requests: ReplayRequest[] } {
  const messages: Message[] = [];
  const requests: ReplayRequest[] = [];
  let currentAssistantId: string | undefined;
  let currentRequest: ReplayRequest | undefined;

  for (const l of lines) {
    const msg = l.message!;
    const ts = l.timestamp ? Date.parse(l.timestamp) : NaN;
    if (l.type === 'assistant') {
      const id = msg.id ?? l.requestId ?? `anon-${requests.length}`;
      const blocks = toBlocks(msg.content);
      if (id === currentAssistantId && messages.length && messages[messages.length - 1]!.role === 'assistant') {
        (messages[messages.length - 1]!.content as ContentBlock[]).push(...blocks);
        if (currentRequest && msg.usage) currentRequest.usage = mergeUsage(currentRequest.usage, msg.usage);
        continue;
      }
      currentAssistantId = id;
      const model = msg.model ?? 'unknown';
      if (model !== '<synthetic>' && msg.usage) {
        currentRequest = {
          messageCount: messages.length,
          model,
          usage: { ...msg.usage },
          timestamp: Number.isFinite(ts) ? ts : 0,
        };
        requests.push(currentRequest);
      } else {
        currentRequest = undefined;
      }
      messages.push({ role: 'assistant', content: [...blocks] });
    } else {
      currentAssistantId = undefined;
      const blocks = toBlocks(msg.content);
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        (last.content as ContentBlock[]).push(...blocks);
      } else {
        messages.push({ role: 'user', content: [...blocks] });
      }
    }
  }
  return { messages, requests };
}

function mergeUsage(a: Usage, b: Usage): Usage {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = Math.max((out[k] as number) ?? 0, v);
    else if (v && typeof v === 'object') out[k] = { ...((out[k] as object) ?? {}), ...v };
  }
  return out as Usage;
}

export function loadConversations(dir: string): Conversation[] {
  return findTranscripts(dir).flatMap((f) => parseTranscript(f, dir));
}
