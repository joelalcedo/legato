import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify } from '../src/classifier.js';
import { defaultConfig } from '../src/config.js';
import { decide, newState, observe, switchEconomics } from '../src/engine.js';
import { extractFeatures, type Message, type MessagesRequest } from '../src/features.js';
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
});
