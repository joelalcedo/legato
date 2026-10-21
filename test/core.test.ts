import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify } from '../src/classifier.js';
import { defaultConfig } from '../src/config.js';
import { decide, newState, observe, switchEconomics } from '../src/engine.js';
import { agentTypeOf, extractFeatures, forkIndex, type Message, type MessagesRequest } from '../src/features.js';
import { clampEffort, tierOf } from '../src/models.js';
import { costOf, normalizeModel, priceFor } from '../src/pricing.js';

const cfg = defaultConfig();
const NOW = 1_800_000_000_000;

function req(messages: Message[], model = 'claude-opus-5-5', tools = true): MessagesRequest {
  return { model, messages, tools: tools ? [{ name: 'Bash' }] : undefined, max_tokens: 64000 };
}
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const toolUse = (name: string, input: Record<string, unknown> = {}): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name, input }],
});
const toolResult = (content: string, is_error = false): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 't1', content, ...(is_error ? { is_error } : {}) }],
});

/** A conversation already running on `model` with a warm cache of `ctx` tokens. */
function warmState(model: string, ctx: number, idleSeconds = 20) {
  const s = newState();
  observe(s, model, ctx, 800, NOW - idleSeconds * 1000);
  return s;
}

describe('pricing', () => {
  it('normalizes provider, date and context suffixes', () => {
    assert.equal(normalizeModel('us.anthropic.claude-opus-4-8-v1:0'), 'claude-opus-4-8');
    assert.equal(normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
    assert.equal(normalizeModel('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(normalizeModel('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5');
  });

  it('applies the Haiku 5.5 long-prompt price above 100K tokens', () => {
    assert.equal(priceFor('claude-haiku-5-5', 50_000)!.read, 0.01);
    assert.equal(priceFor('claude-haiku-5-5', 150_000)!.read, 0.05);
  });

  it('prices a request', () => {
    const c = costOf('claude-opus-5-5', { input: 0, output: 1_000_000, read: 1_000_000, write5m: 0, write1h: 0 });
    assert.equal(c, 20.2);
  });
});

describe('classifier', () => {
  const cases: [string, string][] = [
    ['rename getUserData to fetchUserProfile everywhere', 'haiku'],
    ['run the linter and fix formatting', 'haiku'],
    ['thanks', 'haiku'],
    ['where is the retry logic for webhooks?', 'haiku'],
    ['add a pagination param to the orders endpoint with tests', 'sonnet'],
    ['yes do it', 'sonnet'],
    ['Why does the dashboard re-render three times? Find the root cause.', 'opus'],
    ['Design the architecture for multi-region failover and weigh the trade-offs', 'opus'],
    ['there is a race condition in the job scheduler, investigate', 'opus'],
    ['how come the backtest shows such a deep drawdown in 2025?', 'opus'],
    ['add a back button to the profile screen', 'sonnet'],
    ['onboard the vendor security master data into the warehouse', 'sonnet'],
  ];
  for (const [text, tier] of cases) {
    it(`${tier}: ${text}`, () => assert.equal(classify(text).tier, tier));
  }
});

describe('features', () => {
  it('detects a fresh user turn and strips system reminders', () => {
    const f = extractFeatures(req([user('<system-reminder>ctx</system-reminder>\nfix the bug')]));
    assert.equal(f.newUserTurn, true);
    assert.equal(f.userText, 'fix the bug');
    assert.equal(f.isFirstRequest, true);
  });

  it('treats a tool-result-only message as a loop step', () => {
    const f = extractFeatures(req([user('fix it'), toolUse('Bash'), toolResult('ok')]));
    assert.equal(f.newUserTurn, false);
    assert.equal(f.toolLoopDepth, 1);
  });

  it('counts failing tool results and edited files in the task', () => {
    const f = extractFeatures(
      req([
        user('fix it'),
        toolUse('Edit', { file_path: 'a.ts' }),
        toolResult('ok'),
        toolUse('Bash'),
        toolResult('Tests: 2 failed, 10 passed'),
        toolUse('Bash'),
        toolResult('boom', true),
      ]),
    );
    assert.equal(f.taskErrors, 2);
    assert.equal(f.consecutiveErrors, 2);
    assert.equal(f.filesTouched, 1);
  });

  it('reports errors from the previous task on the next user turn', () => {
    const f = extractFeatures(
      req([user('fix it'), toolUse('Bash'), toolResult('x', true), toolUse('Bash'), toolResult('y', true), { role: 'assistant', content: 'done' }, user('still broken')]),
    );
    assert.equal(f.newUserTurn, true);
    assert.equal(f.previousTaskErrors, 2);
  });

  it('detects plan mode and per-turn overrides', () => {
    const f = extractFeatures(req([user('<system-reminder>Plan mode is active.</system-reminder> //s write a plan')]));
    assert.equal(f.planMode, true);
    assert.equal(f.override, 'sonnet');
    assert.equal(f.userText, 'write a plan');
  });

  // Shapes below are from real Claude Code 2.1.3xx requests.
  it('keeps a tool result that Claude Code annotated with text a loop step', () => {
    const shot: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image' }] },
        { type: 'text', text: '[Image: original 2450x1696, displayed at 2000x1384. Multiply coordinates by 1.22 to map to original image.]' },
      ],
    };
    const f = extractFeatures(req([user('check the layout'), toolUse('Read'), shot]));
    assert.equal(f.newUserTurn, false);
  });

  it('does not open a routable turn for notifications Claude Code writes as the user', () => {
    const done = { role: 'assistant', content: 'started it' } as Message;
    for (const text of [
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
      'Another Claude session sent a message:\n<agent-message>ready</agent-message>',
      'This session is being continued from a previous conversation that ran out of context.',
    ]) {
      assert.equal(extractFeatures(req([user('run the build'), done, user(text)])).newUserTurn, false, text.slice(0, 30));
    }
  });

  it('classifies what the user typed, not the slash-command wrapper around it', () => {
    const f = extractFeatures(
      req([
        user(
          '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>\n' +
            '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>\n' +
            '<pasted_content id="af7a">\nDo you see the screen that renders while the song is generating?\n</pasted_content id="af7a">',
        ),
      ]),
    );
    assert.equal(f.userText, 'Do you see the screen that renders while the song is generating?');
  });

  it('counts only the failures a task ended on, and not a passing "0 failed" summary', () => {
    const msgs = [
      user('fix it'),
      toolUse('Bash'),
      toolResult('x', true),
      toolUse('Bash'),
      toolResult('y', true),
      toolUse('Bash'),
      toolResult('Tests: 0 failed, 12 passed'),
      { role: 'assistant', content: 'fixed' } as Message,
      user('ok, can I test it now?'),
    ];
    assert.equal(extractFeatures(req(msgs)).previousTaskErrors, 0);
  });

  it('reads the cache TTL and effort Claude Code asked for', () => {
    const r = req([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ]);
    r.output_config = { effort: 'xhigh' };
    const f = extractFeatures(r);
    assert.equal(f.cacheTtlSeconds, 3600);
    assert.equal(f.incomingEffort, 'max');
    assert.equal(extractFeatures(req([user('hi')])).cacheTtlSeconds, undefined);
  });
});

describe('models', () => {
  it('maps families to tiers', () => {
    assert.equal(tierOf('claude-fable-5-1'), 'fable');
    assert.equal(tierOf('us.anthropic.claude-sonnet-4-5-v1:0'), 'sonnet');
  });
  it('clamps effort to what the model supports', () => {
    assert.equal(clampEffort('claude-opus-4-6', 'xhigh'), 'high');
    assert.equal(clampEffort('claude-haiku-4-5', 'low'), undefined);
  });
});

describe('engine', () => {
  it('passes through requests without tools (background calls)', () => {
    const r = req([user('summarize')], 'claude-opus-5-5', false);
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW });
    assert.equal(d.route, false);
  });

  it('switches for free on the first request of a conversation', () => {
    const r = req([user('rename foo to bar everywhere')]);
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW });
    assert.equal(d.model, 'claude-haiku-5-5');
    assert.equal(d.freeSwitch, true);
  });

  it('holds the model inside a tool loop', () => {
    const r = req([user('rename foo'), toolUse('Bash'), toolResult('ok')]);
    const s = warmState('claude-haiku-5-5', 30_000);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW });
    assert.equal(d.model, 'claude-haiku-5-5');
    assert.equal(d.switched, false);
  });

  it('declines an Opus to Sonnet downshift when the warm context is large', () => {
    const r = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('add a loading state to the table component')]);
    const s = warmState('claude-opus-5-5', 180_000);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW, contextTokens: 180_000 });
    assert.equal(d.model, 'claude-opus-5-5');
    assert.ok(d.economics && d.economics.netUsd < 0);
  });

  it('takes the same downshift when the context is small', () => {
    const r = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('add a loading state to the table component')]);
    const s = warmState('claude-opus-5-5', 25_000);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW, contextTokens: 25_000 });
    assert.equal(d.model, 'claude-sonnet-5-5');
  });

  it('keeps a 1h cache warm when the request asks for a 1h TTL', () => {
    const r = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('add a loading state to the table component')]);
    (r.messages[0]!.content as { cache_control?: unknown }[])[0]!.cache_control = { type: 'ephemeral', ttl: '1h' };
    const s = warmState('claude-opus-5-5', 180_000, 900);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW, contextTokens: 180_000 });
    assert.equal(d.model, 'claude-opus-5-5', 'idle 15 minutes is inside a 1h TTL, so the downshift is not free');
    assert.equal(d.freeSwitch, undefined);
  });

  it('runs hard turns at the requested effort and never goes above it', () => {
    const hard = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('Why does the scheduler deadlock? Find the root cause.')]);
    hard.output_config = { effort: 'xhigh' };
    const s = warmState('claude-opus-5-5', 50_000);
    assert.equal(decide({ req: hard, features: extractFeatures(hard), state: s, cfg, now: NOW }).effort, 'xhigh');
    const easy = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('Why does the scheduler deadlock? Find the root cause.')]);
    easy.output_config = { effort: 'low' };
    assert.equal(decide({ req: easy, features: extractFeatures(easy), state: s, cfg, now: NOW }).effort, 'low');
  });

  it('switches for free once the current cache has expired', () => {
    const r = req([user('earlier'), { role: 'assistant', content: 'ok' }, user('add a loading state to the table component')]);
    const s = warmState('claude-opus-5-5', 180_000, 900);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW, contextTokens: 180_000 });
    assert.equal(d.model, 'claude-sonnet-5-5');
    assert.equal(d.freeSwitch, true);
  });

  it('escalates after failures in the previous task', () => {
    const r = req([user('fix it'), toolUse('Bash'), toolResult('x', true), toolUse('Bash'), toolResult('y', true), { role: 'assistant', content: 'done' }, user('ok try again')]);
    const s = warmState('claude-sonnet-5-5', 40_000);
    const d = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW });
    assert.equal(d.model, 'claude-opus-5-5');
  });

  it('never routes above the model Claude Code asked for', () => {
    const r = req([user('Design the architecture for a distributed lock service')], 'claude-sonnet-5-5');
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW });
    assert.equal(d.model, 'claude-sonnet-5-5');
  });

  it('lets an explicit override go above the ceiling', () => {
    const r = req([user('//o look at this')], 'claude-sonnet-5-5');
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW });
    assert.equal(d.model, 'claude-opus-5-5');
  });

  it('respects the conservative floor', () => {
    const c = defaultConfig('conservative');
    const r = req([user('rename foo to bar')]);
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg: c, now: NOW });
    assert.equal(d.model, 'claude-sonnet-5-5');
  });

  it('computes switch economics that favor small contexts', () => {
    const small = switchEconomics('claude-opus-5-5', 'claude-sonnet-5-5', warmState('claude-opus-5-5', 20_000), 20_000, cfg, NOW);
    const big = switchEconomics('claude-opus-5-5', 'claude-sonnet-5-5', warmState('claude-opus-5-5', 300_000), 300_000, cfg, NOW);
    assert.ok(small.netUsd > 0);
    assert.ok(big.netUsd < 0);
  });

  it('takes a classification made elsewhere instead of running the heuristic', () => {
    const r = req([user('Design the architecture for multi-region failover')]);
    const d = decide({
      req: r,
      features: extractFeatures(r),
      state: newState(),
      cfg,
      now: NOW,
      classification: { tier: 'haiku', effort: 'low', hard: 0, easy: 0, signals: ['claude-haiku-5-5: a lookup'] },
    });
    assert.equal(d.model, 'claude-haiku-5-5');
    assert.match(d.reasons[0]!, /claude-haiku-5-5: a lookup/);
  });
});

describe('agents', () => {
  const SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const sys = (...texts: string[]) => texts.map((text) => ({ type: 'text', text }));

  it('reads the agent type off the system prompt', () => {
    assert.equal(agentTypeOf("You are Claude Code, Anthropic's official CLI for Claude."), 'main');
    assert.equal(agentTypeOf(sys("You are Claude Code, Anthropic's official CLI for Claude.", '\nYou are an agent working with the user')), 'main');
    assert.equal(agentTypeOf(sys(SDK, 'You are a file search specialist for Claude Code, Anthropic\'s official CLI for Claude. You excel')), 'Explore');
    assert.equal(agentTypeOf(sys(SDK, 'You are a software architect and planning specialist for Claude Code. Your role')), 'Plan');
    assert.equal(agentTypeOf(sys(SDK, "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message")), 'general-purpose');
    assert.equal(agentTypeOf(sys('x-anthropic-billing-header: cc_version=2.1.304;', SDK, '\nYou are an agent working with the user')), 'agent');
    assert.equal(agentTypeOf('You are a helpful assistant.'), undefined);
  });

  it('spots a fork by its boilerplate and counts the thinking in the history', () => {
    const msgs: Message[] = [
      user('build it'),
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(3500) }, { type: 'text', text: 'ok' }] },
      user('name the app'),
      user('<fork-boilerplate>You are a worker fork.</fork-boilerplate>'),
    ];
    assert.equal(forkIndex(msgs), 3);
    const f = extractFeatures(req(msgs));
    assert.equal(f.isFork, true);
    assert.equal(f.thinkingChars, 3500);
  });

  it('routes an Explore subagent to Sonnet by type on its first request', () => {
    const r: MessagesRequest = {
      ...req([user('Find every place the retry logic is configured and report the files.')]),
      system: sys(SDK, 'You are a file search specialist for Claude Code, Anthropic\'s official CLI for Claude.'),
    };
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW });
    assert.equal(d.model, 'claude-sonnet-5-5');
    assert.match(d.reasons[0]!, /Explore agent -> sonnet by agent type/);
  });

  it('never switches a fork, which carries its parent context and thinking', () => {
    const r = req([user('build the app'), toolUse('Bash'), toolResult('ok'), { role: 'assistant', content: 'done' }, user('rename the icon file'), user('<fork-boilerplate>fork</fork-boilerplate>')]);
    const d = decide({ req: r, features: extractFeatures(r), state: newState(), cfg, now: NOW, contextTokens: 300_000 });
    assert.equal(d.model, 'claude-opus-5-5');
    assert.equal(d.switched, false);
    assert.match(d.reasons.join(' '), /fork: holds claude-opus-5-5/);
  });

  it('holds a downshift that would discard the current model\'s thinking, and lowers effort instead', () => {
    const msgs: Message[] = [
      user('earlier'),
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'y'.repeat(140_000) }, { type: 'text', text: 'ok' }] },
      user('add a loading state to the table component'),
    ];
    const r = req(msgs);
    const s = warmState('claude-opus-5-5', 25_000);
    const held = decide({ req: r, features: extractFeatures(r), state: s, cfg, now: NOW, contextTokens: 25_000 });
    assert.equal(held.model, 'claude-opus-5-5');
    assert.equal(held.effort, 'medium');
    assert.match(held.reasons.join(' '), /drop ~40K tokens of its thinking/);
    const free = decide({ req: r, features: extractFeatures(r), state: s, cfg: { ...cfg, holdThinkingTokens: 1_000_000 }, now: NOW, contextTokens: 25_000 });
    assert.equal(free.model, 'claude-sonnet-5-5');
  });

  it('assigns trial arms deterministically from the brief', () => {
    const trialCfg = { ...cfg, trial: { agentType: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'high' as const, share: 0.5 } };
    const gp = sys(SDK, "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message");
    const arms = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r: MessagesRequest = { ...req([user(`Investigate why job ${i} deadlocks and find the root cause`)]), system: gp };
      const a = decide({ req: r, features: extractFeatures(r), state: newState(), cfg: trialCfg, now: NOW });
      const b = decide({ req: r, features: extractFeatures(r), state: newState(), cfg: trialCfg, now: NOW });
      assert.equal(a.arm, b.arm);
      assert.equal(a.model, a.arm === 'B' ? 'claude-sonnet-5-5' : 'claude-opus-5-5');
      if (a.arm === 'B') assert.equal(a.effort, 'high');
      arms.add(a.arm!);
    }
    assert.deepEqual([...arms].sort(), ['A', 'B']);
  });
});
