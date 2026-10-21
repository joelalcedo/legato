/**
 * Turn a Messages API request (what Claude Code sends) into the signals the
 * router decides on. The same extractor runs live in the proxy and offline
 * over transcripts, so the analyzer measures the exact policy the proxy runs.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  [key: string]: unknown;
}

export interface MessagesRequest {
  model: string;
  messages: Message[];
  system?: string | ContentBlock[];
  tools?: unknown[];
  max_tokens?: number;
  thinking?: { type: string; [key: string]: unknown };
  output_config?: { effort?: string; [key: string]: unknown };
  metadata?: { user_id?: string };
  stream?: boolean;
  [key: string]: unknown;
}

export interface Features {
  /** Last message is a user turn carrying fresh human input (not only tool results). */
  newUserTurn: boolean;
  /** The latest fresh human text, with system reminders removed. Empty inside a tool loop. */
  userText: string;
  /** Claude Code's plan mode reminder is present in the current turn. */
  planMode: boolean;
  /** Assistant tool-use rounds since the last fresh user input. */
  toolLoopDepth: number;
  /** Failing tool results since the last fresh user input. */
  taskErrors: number;
  /**
   * Failing tool results the previous task ended on (its trailing run). Failures it
   * recovered from, such as a red test that later passed, don't count.
   */
  previousTaskErrors: number;
  /** Trailing run of consecutive failing tool results. */
  consecutiveErrors: number;
  /** Distinct files edited since the last fresh user input. */
  filesTouched: number;
  /** No assistant message yet: the conversation's first request, so no cache exists. */
  isFirstRequest: boolean;
  hasTools: boolean;
  /** Rough prompt size from characters; the proxy prefers measured usage when it has it. */
  estimatedTokens: number;
  /** Per-turn manual override parsed from a leading //h, //s, //o or //f. */
  override?: 'haiku' | 'sonnet' | 'opus' | 'fable';
  /** Cache TTL the request's cache_control markers ask for, when it has any. */
  cacheTtlSeconds?: number;
  /**
   * Effort Claude Code asked for: its latest per-message effort (a role:"system" message
   * with output_config, which is how /effort changes apply mid-session), else top-level.
   */
  incomingEffort?: string;
  /**
   * Which Claude Code agent sent the request, read from its system prompt: 'main' (the REPL
   * thread), 'Explore', 'Plan', 'general-purpose', 'agent' (an SDK or custom agent), or
   * undefined when the prompt isn't Claude Code's.
   */
  agentType?: string;
  /** A fork carries its parent's history, cache and thinking; switching it costs the parent's. */
  isFork: boolean;
  /** Characters of thinking in the history: what a switch to a model that can't read them discards. */
  thinkingChars: number;
}

const AGENT_PROMPTS: [RegExp, string][] = [
  [/^You are an agent for Claude Code\b/, 'general-purpose'],
  [/^You are a file search specialist for Claude Code\b/, 'Explore'],
  [/^You are a software architect and planning specialist for Claude Code\b/, 'Plan'],
];

/** The Claude Code agent behind a system prompt; see Features.agentType. */
export function agentTypeOf(system: MessagesRequest['system']): string | undefined {
  const head = (typeof system === 'string' ? [system] : (system ?? []).map(textOfBlock)).slice(0, 4).map((t) => t.trimStart());
  for (const t of head) for (const [re, type] of AGENT_PROMPTS) if (re.test(t)) return type;
  const lead = head.find((t) => t.startsWith('You are '));
  if (lead?.startsWith("You are Claude Code, Anthropic's official CLI")) return 'main';
  if (lead?.startsWith('You are a Claude agent, built on')) return 'agent';
  return undefined;
}

/** Index of the user message carrying Claude Code's fork boilerplate, or -1. */
export function forkIndex(messages: Message[]): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    for (const b of blocksOf(m.content)) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('<fork-boilerplate>')) return i;
    }
  }
  return -1;
}

function countThinkingChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'thinking' && typeof b.thinking === 'string') n += b.thinking.length;
      else if (b.type === 'redacted_thinking' && typeof b.data === 'string') n += b.data.length;
    }
  }
  return n;
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const PLAN_MODE_RE = /plan mode is (?:active|on)/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_based_edit_tool']);
const FAILURE_RE =
  /(\b[1-9]\d* (?:failed|failing)\b|\bFAIL(?:ED)?\b|\bTraceback \(most recent call last\)|\bError:|\bexit code [1-9]\d*|\bcommand not found\b|\bnpm ERR!|\berror\[E\d+\])/;

export const OVERRIDE_RE = /^\s*\/\/(h|s|o|f)\b\s*/i;
const OVERRIDE_MAP = { h: 'haiku', s: 'sonnet', o: 'opus', f: 'fable' } as const;

export function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function textOfBlock(b: ContentBlock): string {
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return '';
}

/** Human text in a user message, with system reminders and command wrappers removed. */
export function freshUserText(m: Message): string {
  if (m.role !== 'user') return '';
  const blocks = blocksOf(m.content);
  // A message that answers tool calls is a loop step even when Claude Code adds text to it
  // (image captions from Read, a loaded skill's body, fork instructions).
  if (blocks.some((b) => b.type === 'tool_result')) return '';
  const parts = blocks
    .filter((b) => b.type === 'text')
    .map(textOfBlock)
    .map(stripHarnessMarkup)
    .filter((t) => t.length > 0)
    // Claude Code echoes local slash-command output into the transcript; it isn't a request.
    .filter((t) => !/^<(local-command-stdout|command-stdout)>/.test(t))
    // An interrupted turn leaves a marker that isn't a new request either.
    .filter((t) => !/^\[Request interrupted by user/.test(t))
    // Text Claude Code writes on the user's behalf: background-task and agent notifications,
    // compaction summaries, a slash-command skill's body. None of it says how hard the next
    // step is, so it doesn't open a routable turn.
    .filter((t) => !MACHINE_TEXT_RE.test(t));
  return parts.join('\n').trim();
}

const MACHINE_TEXT_RE =
  /^(<task-notification>|\[SYSTEM NOTIFICATION|Another Claude session sent a message|The coordinator sent a message|This session is being continued from a previous conversation|<artifact-content-authored-by-others\/>|Base directory for this skill:)/;

/** Remove Claude Code's wrappers around what the user typed, keeping the typed text. */
function stripHarnessMarkup(t: string): string {
  return t
    .replace(REMINDER_RE, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-(name|message)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, '$1')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/\[Image: original [^\]]*\]/g, '')
    .trim();
}

function rawTextOf(m: Message): string {
  return blocksOf(m.content).map(textOfBlock).join('\n');
}

function toolResultText(b: ContentBlock): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return (b.content as ContentBlock[]).map(textOfBlock).join('\n');
  }
  return '';
}

export function isFailingToolResult(b: ContentBlock): boolean {
  if (b.type !== 'tool_result') return false;
  if (b.is_error === true) return true;
  return FAILURE_RE.test(toolResultText(b).slice(0, 4000));
}

/** Index of the latest user message with fresh human input before `end`, or -1. */
export function lastFreshUserIndex(messages: Message[], end = messages.length): number {
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && freshUserText(m).length > 0) return i;
  }
  return -1;
}

function lastNonSystemIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'system') return i;
  }
  return -1;
}

function countTaskSignals(messages: Message[], from: number, to: number) {
  let errors = 0;
  let consecutive = 0;
  let loopDepth = 0;
  const files = new Set<string>();
  for (let i = from; i < to; i++) {
    const m = messages[i]!;
    for (const b of blocksOf(m.content)) {
      if (m.role === 'assistant' && b.type === 'tool_use') {
        if (EDIT_TOOLS.has(String(b.name))) {
          const path = (b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path) as string | undefined;
          if (path) files.add(path);
        }
      }
      if (m.role === 'user' && b.type === 'tool_result') {
        if (isFailingToolResult(b)) {
          errors++;
          consecutive++;
        } else {
          consecutive = 0;
        }
      }
    }
    if (m.role === 'assistant' && blocksOf(m.content).some((b) => b.type === 'tool_use')) loopDepth++;
  }
  return { errors, consecutive, files: files.size, loopDepth };
}

export function estimateTokens(req: Pick<MessagesRequest, 'messages' | 'system' | 'tools'>): number {
  let chars = 0;
  const sys = req.system;
  chars += typeof sys === 'string' ? sys.length : JSON.stringify(sys ?? '').length;
  chars += JSON.stringify(req.tools ?? []).length;
  chars += JSON.stringify(req.messages).length;
  // ~3.5 characters per token for English prose and code with Claude's current tokenizer.
  return Math.round(chars / 3.5);
}

/** 3600 if any cache_control marker asks for a 1h TTL, 300 if there are only default markers. */
export function requestCacheTtl(req: Pick<MessagesRequest, 'messages' | 'system' | 'tools'>): number | undefined {
  let ttl: number | undefined;
  const visit = (b: unknown) => {
    const cc = (b as { cache_control?: { ttl?: string } } | null)?.cache_control;
    if (cc) ttl = cc.ttl === '1h' ? 3600 : (ttl ?? 300);
  };
  if (Array.isArray(req.system)) req.system.forEach(visit);
  (req.tools ?? []).forEach(visit);
  for (const m of req.messages ?? []) if (Array.isArray(m.content)) m.content.forEach(visit);
  return ttl;
}

export function extractFeatures(req: MessagesRequest): Features {
  const messages = req.messages ?? [];
  const lastIdx = lastNonSystemIndex(messages);
  const last = lastIdx >= 0 ? messages[lastIdx] : undefined;
  const freshIdx = lastFreshUserIndex(messages);
  const newUserTurn = !!last && last.role === 'user' && lastIdx === freshIdx;
  const userText = newUserTurn && last ? freshUserText(last) : '';

  const current = countTaskSignals(messages, Math.max(0, freshIdx), messages.length);
  const prevFresh = freshIdx > 0 ? lastFreshUserIndex(messages, freshIdx) : -1;
  const previous = prevFresh >= 0 ? countTaskSignals(messages, prevFresh, freshIdx) : { consecutive: 0 };

  const turnText = freshIdx >= 0 ? rawTextOf(messages[freshIdx]!) : '';
  const planMode = PLAN_MODE_RE.test(turnText);

  let override: Features['override'];
  const m = OVERRIDE_RE.exec(userText);
  if (m) override = OVERRIDE_MAP[m[1]!.toLowerCase() as keyof typeof OVERRIDE_MAP];

  let estimated: number | undefined;
  let thinking: number | undefined;
  return {
    newUserTurn,
    userText: userText.replace(OVERRIDE_RE, ''),
    planMode,
    toolLoopDepth: current.loopDepth,
    taskErrors: current.errors,
    previousTaskErrors: previous.consecutive,
    consecutiveErrors: current.consecutive,
    filesTouched: current.files,
    isFirstRequest: !messages.some((x) => x.role === 'assistant'),
    hasTools: Array.isArray(req.tools) && req.tools.length > 0,
    // Serializing the history is the costliest step here, and only a conversation's
    // first request through the proxy needs it, so compute it on demand.
    get estimatedTokens() {
      return (estimated ??= estimateTokens(req));
    },
    override,
    cacheTtlSeconds: requestCacheTtl(req),
    incomingEffort: requestEffort(req),
    agentType: agentTypeOf(req.system),
    isFork: forkIndex(messages) >= 0,
    get thinkingChars() {
      return (thinking ??= countThinkingChars(messages));
    },
  };
}

function requestEffort(req: MessagesRequest): string | undefined {
  const messages = req.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const e = (messages[i]!.output_config as { effort?: string } | undefined)?.effort;
    if (messages[i]!.role === 'system' && e) return e;
  }
  return req.output_config?.effort;
}
