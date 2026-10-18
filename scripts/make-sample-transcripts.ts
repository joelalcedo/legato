/**
 * Generate synthetic Claude Code transcripts for demos and tests.
 *
 * The files use Claude Code's JSONL layout (one line per user event and per
 * assistant content block, usage on assistant lines) and realistic token growth:
 * a ~22K-token system prompt and tool list, tool results that add thousands of
 * tokens, and prompt caching with a 5-minute TTL. Every session runs on Opus 5.5,
 * the Claude Code default on most plans. The content is invented.
 *
 *   npx tsx scripts/make-sample-transcripts.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'examples/sample-transcripts';
const MODEL = 'claude-opus-5-5';
const TTL = 300_000;
const BASE_PROMPT = 22_000;
const PLAN_REMINDER =
  '<system-reminder>Plan mode is active. The user indicated that they do not want you to execute yet. Research and present a plan.</system-reminder>';

interface Step {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  resultTokens: number;
  error?: boolean;
  out?: number;
}

interface Turn {
  user: string;
  gap: number; // seconds of idle before the user sends this
  steps: Step[];
  final: string;
  finalOut?: number;
}

interface Session {
  project: string;
  id: string;
  start: string;
  turns: Turn[];
  sidechains?: { agentId: string; afterTurn: number; turns: Turn[] }[];
}

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;

const read = (file: string, tokens: number): Step => ({
  tool: 'Read',
  input: { file_path: file },
  result: `     1\t// ${file}\n     2\t...`,
  resultTokens: tokens,
});
const grep = (pattern: string, tokens = 600): Step => ({
  tool: 'Grep',
  input: { pattern },
  result: `src/auth/session.ts:42\nsrc/routes/login.ts:17`,
  resultTokens: tokens,
});
const edit = (file: string, out = 900): Step => ({
  tool: 'Edit',
  input: { file_path: file, old_string: '...', new_string: '...' },
  result: `The file ${file} has been updated.`,
  resultTokens: 250,
  out,
});
const write = (file: string, out = 2600): Step => ({
  tool: 'Write',
  input: { file_path: file, content: '...' },
  result: `File created successfully at: ${file}`,
  resultTokens: 120,
  out,
});
const bash = (command: string, result: string, tokens: number, error = false): Step => ({
  tool: 'Bash',
  input: { command },
  result,
  resultTokens: tokens,
  error,
});

const SESSIONS: Session[] = [
  {
    project: '-Users-dev-api-server',
    id: 'a1b2c3d4-auth-expired-cookie',
    start: '2026-10-12T14:02:00Z',
    turns: [
      {
        user: 'The /login endpoint returns 500 when the session cookie is expired. Can you find out why and fix it?',
        gap: 0,
        steps: [
          grep('session cookie'),
          read('src/auth/session.ts', 5_800),
          read('src/routes/login.ts', 3_900),
          edit('src/auth/session.ts'),
          bash('npm test -- auth', 'FAIL src/auth/session.test.ts\n  2 failed, 31 passed', 2_400, true),
          edit('src/auth/session.ts'),
          bash('npm test -- auth', 'FAIL src/auth/refresh.test.ts\n  1 failed, 32 passed', 2_100, true),
        ],
        final: 'The expiry check threw on a null payload; I guarded it, but one refresh test still fails.',
        finalOut: 700,
      },
      {
        user: 'still failing, same error on the refresh path',
        gap: 95,
        steps: [read('src/auth/refresh.ts', 4_200), edit('src/auth/refresh.ts', 1_400), bash('npm test -- auth', '33 passed', 900)],
        final: 'Fixed: refresh reused the expired token before re-validating. All 33 auth tests pass.',
        finalOut: 600,
      },
      {
        user: 'great, commit it with a good message',
        gap: 40,
        steps: [bash('git add -A && git commit -m "fix(auth): handle expired session cookies"', '[main 3f2a1c9] fix(auth)...', 200)],
        final: 'Committed as 3f2a1c9.',
        finalOut: 120,
      },
      { user: 'thanks', gap: 25, steps: [], final: 'Anytime.', finalOut: 20 },
    ],
    sidechains: [
      {
        agentId: 'agent-cookie-survey',
        afterTurn: 0,
        turns: [
          {
            user: 'Search the codebase for every place that reads the session cookie and summarize how expiry is handled in each.',
            gap: 0,
            steps: [grep('req.cookies.session', 900), read('src/middleware/auth.ts', 3_100), read('src/routes/account.ts', 2_700)],
            final: 'Three readers; only middleware/auth.ts checks expiry before use.',
            finalOut: 650,
          },
        ],
      },
    ],
  },
  {
    project: '-Users-dev-api-server',
    id: 'b2c3d4e5-notifications-websockets',
    start: '2026-10-13T10:15:00Z',
    turns: [
      {
        user:
          PLAN_REMINDER +
          '\nDesign a migration from REST polling to websockets for the notifications service. Consider backpressure, reconnection with resume tokens, auth on the socket handshake, and how we roll it out behind a feature flag.',
        gap: 0,
        steps: [
          { tool: 'Glob', input: { pattern: 'src/notifications/**' }, result: '14 files', resultTokens: 400 },
          read('src/notifications/poller.ts', 7_200),
          read('src/notifications/store.ts', 6_100),
          read('src/gateway/server.ts', 8_400),
          read('docs/notifications.md', 3_300),
        ],
        final: 'Plan: a dual-stack gateway, resume tokens keyed by last event id, a bounded per-socket queue with drop-oldest...',
        finalOut: 4_200,
      },
      {
        user: 'yes do it',
        gap: 140,
        steps: [
          write('src/gateway/socket.ts', 3_400),
          write('src/notifications/resume.ts', 2_200),
          edit('src/gateway/server.ts', 1_300),
          edit('src/notifications/store.ts', 1_100),
          write('src/gateway/socket.test.ts', 2_900),
          bash('npm test -- gateway', '18 passed', 1_200),
        ],
        final: 'Implemented the socket gateway behind NOTIFY_WS, with resume tokens and a bounded queue. 18 tests pass.',
        finalOut: 500,
      },
      {
        user: 'add a test for reconnect after the server drops the socket',
        gap: 70,
        steps: [edit('src/gateway/socket.test.ts', 1_600), bash('npm test -- gateway', '19 passed', 1_100)],
        final: 'Added a drop-and-resume test; 19 pass.',
        finalOut: 200,
      },
    ],
  },
  {
    project: '-Users-dev-web-app',
    id: 'c3d4e5f6-chores-and-a-perf-bug',
    start: '2026-10-14T16:40:00Z',
    turns: [
      {
        user: 'rename getUserData to fetchUserProfile everywhere',
        gap: 0,
        steps: [grep('getUserData', 1_100), edit('src/api/user.ts', 300), edit('src/pages/Profile.tsx', 300), edit('src/pages/Settings.tsx', 300), edit('src/hooks/useUser.ts', 300)],
        final: 'Renamed in 4 files.',
        finalOut: 80,
      },
      {
        user: 'run the linter and fix formatting',
        gap: 30,
        steps: [bash('npm run lint', 'src/pages/Profile.tsx\n  12:3  error  Insert `,`  prettier/prettier\n✖ 3 problems', 900, true), bash('npm run lint -- --fix', 'done', 150), bash('npm run lint', 'no problems', 100)],
        final: 'Lint is clean.',
        finalOut: 60,
      },
      {
        user: 'bump the version to 2.3.1 and update the changelog',
        gap: 25,
        steps: [edit('package.json', 200), edit('CHANGELOG.md', 400)],
        final: 'Bumped to 2.3.1 and added a changelog entry.',
        finalOut: 60,
      },
      {
        user: 'which files still import the old config module?',
        gap: 20,
        steps: [grep("from '../config/legacy'", 700)],
        final: 'Two: src/boot.ts and src/analytics/init.ts.',
        finalOut: 70,
      },
      {
        user: 'Why does the dashboard re-render three times on load? Profile it and figure out the root cause.',
        gap: 420,
        steps: [
          read('src/pages/Dashboard.tsx', 6_800),
          read('src/state/store.ts', 5_200),
          read('src/hooks/useDashboardData.ts', 3_400),
          bash('npm run profile:dashboard', 'commit 1: Dashboard (store init)\ncommit 2: Dashboard (data fetch)\ncommit 3: Dashboard (theme context)', 2_600),
          edit('src/hooks/useDashboardData.ts', 1_200),
          bash('npm run profile:dashboard', 'commit 1: Dashboard', 800),
        ],
        final: 'Root cause: the theme provider re-created its value each render and the store emitted twice on hydrate. Now one commit.',
        finalOut: 1_100,
      },
    ],
  },
  {
    project: '-Users-dev-api-server',
    id: 'd4e5f6a7-orders-pagination',
    start: '2026-10-15T09:05:00Z',
    turns: [
      {
        user: 'Add cursor-based pagination to the /orders API, with opaque cursor tokens, a limit param capped at 100, and tests.',
        gap: 0,
        steps: [read('src/routes/orders.ts', 4_600), read('src/db/orders.ts', 3_800), edit('src/db/orders.ts', 1_500), edit('src/routes/orders.ts', 1_400), write('src/routes/orders.test.ts', 2_400), bash('npm test -- orders', '12 passed', 900)],
        final: 'Added cursor pagination with base64url cursors over (created_at, id); 12 tests pass.',
        finalOut: 400,
      },
      {
        user: 'also handle the empty page case and document it in the README',
        gap: 60,
        steps: [edit('src/routes/orders.ts', 700), edit('README.md', 600), bash('npm test -- orders', '13 passed', 800)],
        final: 'Empty pages now return next_cursor: null; documented.',
        finalOut: 150,
      },
      {
        user: 'commit it',
        gap: 30,
        steps: [bash('git commit -am "feat(orders): cursor pagination"', '[main 9c1d2e0] feat(orders)...', 200)],
        final: 'Committed.',
        finalOut: 40,
      },
    ],
  },
  {
    project: '-Users-dev-web-app',
    id: 'e5f6a7b8-long-design-system-session',
    start: '2026-10-16T13:00:00Z',
    turns: [
      {
        user: 'Refactor the whole component library to use the new design tokens. Start with Button, Modal and Table, keep the public props stable, and migrate the theme provider.',
        gap: 0,
        steps: [
          read('src/ui/tokens.ts', 9_000),
          read('src/ui/Button.tsx', 6_000),
          read('src/ui/Modal.tsx', 8_000),
          read('src/ui/Table.tsx', 14_000),
          read('src/ui/theme.tsx', 11_000),
          edit('src/ui/Button.tsx', 2_200),
          edit('src/ui/Modal.tsx', 2_800),
          edit('src/ui/Table.tsx', 3_600),
          edit('src/ui/theme.tsx', 2_400),
          bash('npm test -- ui', '94 passed', 3_000),
          read('src/ui/Select.tsx', 12_000),
          read('src/ui/Tabs.tsx', 10_000),
          edit('src/ui/Select.tsx', 2_600),
          edit('src/ui/Tabs.tsx', 2_300),
          bash('npm test -- ui', '96 passed', 3_000),
          read('src/ui/DatePicker.tsx', 22_000),
          edit('src/ui/DatePicker.tsx', 3_900),
          bash('npm run build', 'built in 41s', 2_000),
        ],
        final: 'Migrated 7 components and the theme provider to the token system; public props unchanged, 96 tests pass.',
        finalOut: 900,
      },
      {
        user: 'add a loading skeleton to the Table component while rows are fetching',
        gap: 60,
        steps: [edit('src/ui/Table.tsx', 1_800), write('src/ui/TableSkeleton.tsx', 1_600), bash('npm test -- ui', '97 passed', 2_000)],
        final: 'Added a TableSkeleton shown while loading; 97 tests pass.',
        finalOut: 200,
      },
      {
        user: 'fix the typo in the Modal close button label',
        gap: 45,
        steps: [edit('src/ui/Modal.tsx', 200)],
        final: 'Fixed "Cloes" to "Close".',
        finalOut: 30,
      },
      {
        user: 'rename the prop isOpen to open in Modal and update the call sites',
        gap: 50,
        steps: [grep('isOpen', 1_600), edit('src/ui/Modal.tsx', 300), edit('src/pages/Settings.tsx', 300), edit('src/pages/Billing.tsx', 300)],
        final: 'Renamed and updated 2 call sites.',
        finalOut: 60,
      },
      {
        user: 'run the tests',
        gap: 30,
        steps: [bash('npm test', '402 passed', 2_200)],
        final: 'All 402 pass.',
        finalOut: 30,
      },
    ],
  },
];

interface Line {
  [k: string]: unknown;
}

function render(session: Session): { main: Line[]; subs: Map<string, Line[]> } {
  let t = Date.parse(session.start);
  let prompt = 0;
  let lastAt = -Infinity;
  const lines: Line[] = [];
  const subs = new Map<string, Line[]>();
  let reqCounter = 0;

  const emit = (
    out: Line[],
    turns: Turn[],
    sidechain: { agentId: string } | undefined,
    state: { t: number; prompt: number; lastAt: number },
    onTurnEnd?: (i: number) => void,
  ) => {
    const base = {
      sessionId: session.id,
      isSidechain: !!sidechain,
      ...(sidechain ? { agentId: sidechain.agentId } : {}),
      userType: 'external',
      cwd: '/Users/dev/' + session.project.split('-').pop(),
      version: '2.1.296',
      gitBranch: 'main',
    };
    const request = (content: unknown[], growth: number, output: number) => {
      const cold = state.t - state.lastAt > TTL;
      const total = (state.prompt || BASE_PROMPT) + (state.prompt ? growth : 0);
      const read = cold ? 0 : state.prompt;
      const usage = {
        input_tokens: 6,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: total - read - 6,
        output_tokens: output,
      };
      const id = `msg_${session.id.slice(0, 8)}_${++reqCounter}`;
      const requestId = `req_${session.id.slice(0, 8)}_${reqCounter}`;
      // Claude Code writes one line per content block, each carrying the same usage.
      for (const block of content) {
        out.push({
          ...base,
          type: 'assistant',
          uuid: uuid(),
          timestamp: new Date(state.t).toISOString(),
          requestId,
          message: { id, type: 'message', role: 'assistant', model: MODEL, content: [block], stop_reason: null, usage },
        });
      }
      state.prompt = total + output;
      state.lastAt = state.t;
    };

    turns.forEach((turn, i) => {
      state.t += turn.gap * 1000;
      out.push({ ...base, type: 'user', uuid: uuid(), timestamp: new Date(state.t).toISOString(), message: { role: 'user', content: turn.user } });
      let growth = Math.ceil(turn.user.length / 3.5) + 40;
      for (const [k, step] of turn.steps.entries()) {
        state.t += 4_000 + ((k * 7_919) % 9_000);
        const toolId = `toolu_${session.id.slice(0, 6)}_${reqCounter + 1}`;
        request(
          [
            { type: 'text', text: k === 0 ? 'Let me look.' : 'Next.' },
            { type: 'tool_use', id: toolId, name: step.tool, input: step.input },
          ],
          growth,
          step.out ?? 260,
        );
        state.t += 1_500;
        out.push({
          ...base,
          type: 'user',
          uuid: uuid(),
          timestamp: new Date(state.t).toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: step.result, ...(step.error ? { is_error: true } : {}) }] },
        });
        growth = step.resultTokens;
      }
      state.t += 5_000;
      request([{ type: 'text', text: turn.final }], growth, turn.finalOut ?? 300);
      onTurnEnd?.(i);
    });
  };

  const mainState = { t, prompt, lastAt };
  emit(lines, session.turns, undefined, mainState, (i) => {
    for (const sc of session.sidechains ?? []) {
      if (sc.afterTurn !== i) continue;
      const subLines: Line[] = [];
      emit(subLines, sc.turns, sc, { t: mainState.t - 60_000, prompt: 0, lastAt: -Infinity });
      subs.set(sc.agentId, subLines);
    }
  });
  return { main: lines, subs };
}

for (const s of SESSIONS) {
  const dir = join(OUT, s.project);
  mkdirSync(dir, { recursive: true });
  const { main, subs } = render(s);
  writeFileSync(join(dir, `${s.id}.jsonl`), main.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [agentId, subLines] of subs) {
    const subDir = join(dir, s.id, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `${agentId}.jsonl`), subLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}
process.stdout.write(`Wrote ${SESSIONS.length} synthetic sessions to ${OUT}\n`);
