import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { blocksOf, type ContentBlock, type Message } from '../features.js';
import type { Usage } from '../pricing.js';

/**
 * Reader for Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl,
 * with subagents in <session>/subagents/agent-<id>.jsonl).
 *
 * Each line is one event linked to its predecessor by parentUuid. Claude Code writes an
 * assistant response as one line per content block, all sharing message.id and usage,
 * and with streaming tool execution it writes each tool result as soon as it finishes,
 * between blocks of the same response. Attachments (plan mode, reminders) are separate
 * lines that Claude Code renders into the user message at request time.
 *
 * This reader emits one ReplayRequest per real API response, with the context that
 * request carried: the parentUuid chain from the response's first line back to the root
 * (so rewound branches and pre-compaction history are excluded), folded back into
 * API-shaped messages. A response copied into another file (resumed sessions, forked
 * subagents) is counted once, in the first file that claims it. A fork of the main thread
 * references its parent's context instead of copying it; that context is rebuilt from the
 * parent session file and prepended.
 */

export interface ReplayRequest {
  /** API message id of the response. */
  id: string;
  /** The request carried context.slice(0, messageCount). */
  context: Message[];
  messageCount: number;
  model: string;
  usage: Usage;
  /**
   * Whether the transcript recorded the response's final usage. Claude Code writes each
   * block as it streams; when a response ends on a tool_use (common in subagents), the
   * final message_delta usage is often never written, leaving output_tokens at its
   * stream-start value. Input and cache tokens are known at stream start and are exact.
   */
  usageFinal: boolean;
  /** Effort Claude Code ran this request at (recorded since Claude Code 2.1.28x). */
  effort?: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  file: string;
  project: string;
  sessionId: string;
  isSubagent: boolean;
  /** Context of the last request's branch. */
  messages: Message[];
  requests: ReplayRequest[];
}

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
  requestId?: string;
  effort?: string;
  attachment?: { type?: string };
  /** fork-context-ref lines: the fork's context is the parent session's chain up to this line. */
  parentSessionId?: string;
  parentLastUuid?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: Usage;
    stop_reason?: string | null;
  };
}

/** A line reduced to what the chain walk and message folding need. */
interface Node {
  uuid: string;
  parent: string | undefined;
  role?: 'user' | 'assistant';
  /** Assistant message id, for merging the blocks of one response. */
  msgId?: string;
  blocks: ContentBlock[];
}

/** Claude Code renders the plan_mode attachment into the turn as this reminder. */
const PLAN_MODE_TEXT = '<system-reminder>\nPlan mode is active.\n</system-reminder>';

export function findTranscripts(dir: string, modifiedSince?: number): string[] {
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
      // A file last written before the window can't hold requests inside it.
      else if (name.endsWith('.jsonl') && !(modifiedSince && st.mtimeMs < modifiedSince)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function toBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function isSubagentFile(file: string): boolean {
  return /[\\/]subagents[\\/]/.test(file);
}

/** Subagent nesting depth from the sibling .meta.json (forks of a subagent copy its lines). */
function spawnDepth(file: string): number {
  if (!isSubagentFile(file)) return 0;
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { spawnDepth?: number };
    return typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1;
  } catch {
    return 1;
  }
}

export function parseTranscript(file: string, root: string, claimed: Set<string> = new Set()): Conversation[] {
  const text = readFileSync(file, 'utf8');
  const project = relative(root, file).split(/[\\/]/)[0] ?? '';
  const subFile = isSubagentFile(file);
  // Older Claude Code versions wrote sidechains into the session file; split those by agent.
  const streams = new Map<string, { sessionId?: string; isSubagent: boolean; lines: RawLine[] }>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: RawLine;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const sub = subFile || j.isSidechain === true;
    const key = subFile || !sub ? '' : (j.agentId ?? 'sidechain');
    let s = streams.get(key);
    if (!s) streams.set(key, (s = { isSubagent: sub, lines: [] }));
    if (j.type === 'user' || j.type === 'assistant') s.sessionId ??= j.sessionId;
    s.lines.push(j);
  }

  const out: Conversation[] = [];
  for (const [key, s] of streams) {
    const sessionId = s.sessionId ?? basename(file, '.jsonl');
    const agent = subFile ? basename(file, '.jsonl').replace(/^agent-/, '') : key;
    const ref = s.lines.find((l) => l.type === 'fork-context-ref' && l.parentSessionId && l.parentLastUuid);
    const prefix = ref ? contextAt(join(dirname(file), '..', '..', `${ref.parentSessionId}.jsonl`), ref.parentLastUuid!) : [];
    const { messages, requests } = buildRequests(s.lines, claimed, prefix);
    if (requests.length) {
      out.push({
        id: agent ? `${sessionId}:${agent}` : sessionId,
        file,
        project,
        sessionId,
        isSubagent: s.isSubagent,
        messages,
        requests,
      });
    }
  }
  return out;
}

interface Response {
  anchor: string;
  model: string;
  usage?: Usage;
  final: boolean;
  effort?: string;
  timestamp: number;
}

function toNodes(lines: RawLine[]): { nodes: Map<string, Node>; responses: Map<string, Response>; order: string[] } {
  const nodes = new Map<string, Node>();
  const responses = new Map<string, Response>();
  const order: string[] = [];
  let prev: string | undefined;

  lines.forEach((l, i) => {
    // Lines without uuids (old or hand-written transcripts) chain in file order.
    const uuid = l.uuid ?? `#${i}`;
    const parent = l.parentUuid === null ? undefined : (l.parentUuid ?? prev);
    const node: Node = { uuid, parent, blocks: [] };
    const msg = l.message;
    if ((l.type === 'user' || l.type === 'assistant') && msg) {
      node.role = l.type;
      node.blocks = toBlocks(msg.content);
      if (l.type === 'assistant') {
        if (msg.model === '<synthetic>') {
          // Error placeholders Claude Code writes locally; never sent to the API.
          node.role = undefined;
          node.blocks = [];
        } else {
          const id = msg.id ?? l.requestId ?? `anon-${i}`;
          node.msgId = id;
          const r = responses.get(id);
          const ts = l.timestamp ? Date.parse(l.timestamp) : NaN;
          // Hand-written transcripts without stop_reason are treated as complete.
          const final = msg.stop_reason !== null;
          if (!r) {
            responses.set(id, {
              anchor: uuid,
              model: msg.model ?? 'unknown',
              usage: msg.usage && { ...msg.usage },
              final,
              effort: l.effort,
              timestamp: Number.isFinite(ts) ? ts : 0,
            });
            order.push(id);
          } else {
            if (msg.usage) r.usage = r.usage ? mergeUsage(r.usage, msg.usage) : { ...msg.usage };
            r.final ||= final;
          }
        }
      }
    } else if (l.type === 'attachment' && l.attachment?.type === 'plan_mode') {
      node.role = 'user';
      node.blocks = [{ type: 'text', text: PLAN_MODE_TEXT }];
    }
    nodes.set(uuid, node);
    prev = uuid;
  });
  return { nodes, responses, order };
}

/** Folds chain nodes, root first, into API-shaped messages that start from `prefix`. */
function makeFolder(prefix: Message[]) {
  const messages: Message[] = prefix.map((m) => ({ ...m, content: [...blocksOf(m.content)] }));
  const byMsgId = new Map<string, number>();
  const fold = (n: Node) => {
    if (!n.role || !n.blocks.length) return;
    if (n.role === 'assistant') {
      const at = n.msgId !== undefined ? byMsgId.get(n.msgId) : undefined;
      if (at !== undefined) {
        // A later block of a response already in context (written after an interleaved tool result).
        (messages[at]!.content as ContentBlock[]).push(...n.blocks);
        return;
      }
      messages.push({ role: 'assistant', content: [...n.blocks] });
      if (n.msgId !== undefined) byMsgId.set(n.msgId, messages.length - 1);
      return;
    }
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') (last.content as ContentBlock[]).push(...n.blocks);
    else messages.push({ role: 'user', content: [...n.blocks] });
  };
  return { messages, fold };
}

/** The context a session file's chain carried at `leaf`, or [] if it can't be read. */
function contextAt(file: string, leaf: string): Message[] {
  let lines: RawLine[];
  try {
    lines = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          const j = JSON.parse(l) as RawLine;
          return j.isSidechain ? [] : [j];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
  const { nodes } = toNodes(lines);
  const chain: Node[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = leaf; cur !== undefined && nodes.has(cur) && !seen.has(cur); cur = nodes.get(cur)!.parent) {
    seen.add(cur);
    chain.push(nodes.get(cur)!);
  }
  const f = makeFolder([]);
  for (let k = chain.length - 1; k >= 0; k--) f.fold(chain[k]!);
  return f.messages;
}

function buildRequests(
  lines: RawLine[],
  claimed: Set<string>,
  prefix: Message[] = [],
): { messages: Message[]; requests: ReplayRequest[] } {
  const { nodes, responses, order } = toNodes(lines);

  // Walk each response's ancestry, reusing the current branch when the chain extends it.
  let path: string[] = [];
  let pathPos = new Map<string, number>();
  let f = makeFolder(prefix);
  let folded = 0;
  const reset = () => {
    path = [];
    pathPos = new Map();
    f = makeFolder(prefix);
    folded = 0;
  };

  const requests: ReplayRequest[] = [];
  for (const id of order) {
    const r = responses.get(id)!;
    const anchor = nodes.get(r.anchor)!;
    const chain: string[] = [];
    let cur = anchor.parent;
    const seen = new Set<string>();
    while (cur !== undefined && !pathPos.has(cur) && nodes.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = nodes.get(cur)!.parent;
    }
    const joinAt = cur !== undefined ? pathPos.get(cur) : undefined;
    if (joinAt === undefined) {
      // The chain reached a root: a new conversation start, or a compaction boundary.
      if (path.length) reset();
    } else if (joinAt < path.length - 1) {
      // Branch switch (rewind or retry): rebuild from the shared prefix in a fresh array,
      // so earlier requests keep the context they actually carried.
      const keep = path.slice(0, joinAt + 1);
      reset();
      for (const u of keep) {
        pathPos.set(u, path.length);
        path.push(u);
      }
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      pathPos.set(chain[k]!, path.length);
      path.push(chain[k]!);
    }
    for (; folded < path.length; folded++) f.fold(nodes.get(path[folded]!)!);

    if (!r.usage || claimed.has(id)) continue;
    claimed.add(id);
    requests.push({
      id,
      context: f.messages,
      messageCount: f.messages.length,
      model: r.model,
      usage: r.usage,
      usageFinal: r.final,
      effort: r.effort,
      timestamp: r.timestamp,
    });
  }
  return { messages: f.messages, requests };
}

function mergeUsage(a: Usage, b: Usage): Usage {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = Math.max((out[k] as number) ?? 0, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...((out[k] as object) ?? {}), ...v };
    else out[k] = v;
  }
  return out as Usage;
}

/**
 * Load every transcript under `dir`. Session files are read before subagent files, and
 * shallower subagents before their forks, so a response copied into a resumed session or
 * a fork is attributed to the conversation that made it.
 */
export function loadConversations(dir: string, opts: { modifiedSince?: number } = {}): Conversation[] {
  const files = findTranscripts(dir, opts.modifiedSince)
    .map((f) => ({ f, depth: spawnDepth(f) }))
    .sort((a, b) => a.depth - b.depth || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  const claimed = new Set<string>();
  return files.flatMap(({ f }) => parseTranscript(f, dir, claimed));
}
