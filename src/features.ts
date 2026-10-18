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
  /** Failing tool results in the task before the current user turn. */
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
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const PLAN_MODE_RE = /plan mode is (?:active|on)/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_based_edit_tool']);
const FAILURE_RE =
  /(\b\d+ (?:failed|failing)\b|\bFAIL(?:ED)?\b|\bTraceback \(most recent call last\)|\bError:|\bexit code [1-9]\d*|\bcommand not found\b|\bnpm ERR!|\berror\[E\d+\])/;

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
  const parts = blocksOf(m.content)
    .filter((b) => b.type === 'text')
    .map(textOfBlock)
    .map((t) => t.replace(REMINDER_RE, '').trim())
    .filter((t) => t.length > 0)
    // Claude Code echoes local slash-command output into the transcript; it isn't a request.
    .filter((t) => !/^<(local-command-stdout|command-stdout)>/.test(t))
    // An interrupted turn leaves a marker that isn't a new request either.
    .filter((t) => !/^\[Request interrupted by user/.test(t));
  return parts.join('\n').trim();
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

/** Index of the latest user message with fresh human input, or -1. */
export function lastFreshUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
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

export function extractFeatures(req: MessagesRequest): Features {
  const messages = req.messages ?? [];
  const lastIdx = lastNonSystemIndex(messages);
  const last = lastIdx >= 0 ? messages[lastIdx] : undefined;
  const freshIdx = lastFreshUserIndex(messages);
  const newUserTurn = !!last && last.role === 'user' && lastIdx === freshIdx;
  const userText = newUserTurn && last ? freshUserText(last) : '';

  const current = countTaskSignals(messages, Math.max(0, freshIdx), messages.length);
  const prevFresh = freshIdx > 0 ? lastFreshUserIndex(messages.slice(0, freshIdx)) : -1;
  const previous = prevFresh >= 0 ? countTaskSignals(messages, prevFresh, freshIdx) : { errors: 0 };

  const turnText = freshIdx >= 0 ? rawTextOf(messages[freshIdx]!) : '';
  const planMode = PLAN_MODE_RE.test(turnText);

  let override: Features['override'];
  const m = OVERRIDE_RE.exec(userText);
  if (m) override = OVERRIDE_MAP[m[1]!.toLowerCase() as keyof typeof OVERRIDE_MAP];

  return {
    newUserTurn,
    userText: userText.replace(OVERRIDE_RE, ''),
    planMode,
    toolLoopDepth: current.loopDepth,
    taskErrors: current.errors,
    previousTaskErrors: previous.errors,
    consecutiveErrors: current.consecutive,
    filesTouched: current.files,
    isFirstRequest: !messages.some((x) => x.role === 'assistant'),
    hasTools: Array.isArray(req.tools) && req.tools.length > 0,
    estimatedTokens: estimateTokens(req),
    override,
  };
}
