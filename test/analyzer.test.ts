import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { replay } from '../src/analyzer/replay.js';
import { loadConversations } from '../src/analyzer/transcripts.js';
import { defaultConfig } from '../src/config.js';
import { extractFeatures } from '../src/features.js';

const SAMPLES = join(import.meta.dirname, '..', 'examples', 'sample-transcripts');

describe('transcripts', () => {
  it('merges per-block assistant lines into one request each', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    const usage = { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000, output_tokens: 300 };
    const lines = [
      { type: 'user', sessionId: 's', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-10-01T00:00:05Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking' }], usage } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-10-01T00:00:05Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], usage } },
      { type: 'user', sessionId: 's', timestamp: '2026-10-01T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-10-01T00:00:12Z', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done' }], usage: { ...usage, cache_read_input_tokens: 20000, cache_creation_input_tokens: 400 } } },
      { type: 'summary', summary: 'ignored' },
      { type: 'assistant', sessionId: 's', message: { id: 'm3', role: 'assistant', model: '<synthetic>', content: [], usage } },
    ];
    writeFileSync(join(dir, 'x.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const [conv] = loadConversations(dir);
    assert.ok(conv);
    assert.equal(conv.requests.length, 2);
    assert.equal(conv.messages[1]!.role, 'assistant');
    assert.equal((conv.messages[1]!.content as unknown[]).length, 2);
    assert.equal(conv.requests[1]!.messageCount, 3);
  });

  // Shapes below are taken from real Claude Code 2.1.3xx transcripts.
  const u = (uuid: string, parentUuid: string | null, content: unknown, extra = {}) => ({
    type: 'user', uuid, parentUuid, sessionId: 's', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content }, ...extra,
  });
  const a = (uuid: string, parentUuid: string, id: string, block: unknown, extra: { stop?: string | null; out?: number } = {}) => ({
    type: 'assistant', uuid, parentUuid, sessionId: 's', timestamp: '2026-10-01T00:00:01Z',
    message: {
      id, role: 'assistant', model: 'claude-opus-5-5', content: [block], stop_reason: extra.stop === undefined ? 'tool_use' : extra.stop,
      usage: { input_tokens: 2, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500, output_tokens: extra.out ?? 400 },
    },
  });
  const write = (dir: string, name: string, lines: unknown[]) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'));
  };
  const tu = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

  it('folds tool results written between blocks of one response back into API shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s.jsonl', [
      u('u1', null, 'list the files'),
      a('a1', 'u1', 'm1', { type: 'thinking', thinking: '' }),
      a('a2', 'a1', 'm1', tu('t1')),
      u('r1', 'a2', [tr('t1')]),
      a('a3', 'r1', 'm1', tu('t2')),
      u('r2', 'a3', [tr('t2')]),
      a('a4', 'r2', 'm2', { type: 'text', text: 'done' }, { stop: 'end_turn' }),
    ]);
    const [conv] = loadConversations(dir);
    assert.equal(conv!.requests.length, 2);
    const ctx = conv!.requests[1]!.context.slice(0, conv!.requests[1]!.messageCount);
    assert.deepEqual(ctx.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal((ctx[1]!.content as unknown[]).length, 3);
    assert.equal((ctx[2]!.content as unknown[]).length, 2);
  });

  it('follows parentUuid so rewound turns and pre-compaction history are not in the context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s.jsonl', [
      u('u1', null, 'first'),
      a('a1', 'u1', 'm1', { type: 'text', text: 'ok' }, { stop: 'end_turn' }),
      u('u2', 'a1', 'abandoned branch'),
      a('a2', 'u2', 'm2', { type: 'text', text: 'ok' }, { stop: 'end_turn' }),
      u('u3', 'a1', 'rewound and asked this instead'),
      a('a3', 'u3', 'm3', { type: 'text', text: 'ok' }, { stop: 'end_turn' }),
      { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null, logicalParentUuid: 'a3' },
      u('u4', 'b', 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
      a('a4', 'u4', 'm4', { type: 'text', text: 'ok' }, { stop: 'end_turn' }),
    ]);
    const [conv] = loadConversations(dir);
    const texts = (i: number) =>
      conv!.requests[i]!.context.slice(0, conv!.requests[i]!.messageCount).map((m) => (m.content as { text?: string }[])[0]!.text);
    assert.deepEqual(texts(1), ['first', 'ok', 'abandoned branch']);
    assert.deepEqual(texts(2), ['first', 'ok', 'rewound and asked this instead']);
    assert.deepEqual(texts(3), ['This session is being continued from a previous conversation.']);
  });

  it('counts a response copied into a resumed session or a fork once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    const shared = [u('u1', null, 'review this'), a('a1', 'u1', 'm1', tu('t1')), u('r1', 'a1', [tr('t1')])];
    write(dir, 'p/s.jsonl', [...shared, a('a2', 'r1', 'm2', { type: 'text', text: 'done' }, { stop: 'end_turn' })]);
    write(dir, 'p/s2.jsonl', [...shared, a('a2', 'r1', 'm2', { type: 'text', text: 'done' }, { stop: 'end_turn' }), u('u5', 'a2', 'resumed'), a('a5', 'u5', 'm5', { type: 'text', text: 'ok' }, { stop: 'end_turn' })]);
    write(dir, 'p/s/subagents/agent-f1.jsonl', [...shared, u('f1', 'r1', 'fork task'), a('a6', 'f1', 'm6', { type: 'text', text: 'ok' }, { stop: 'end_turn' })]);
    writeFileSync(join(dir, 'p/s/subagents/agent-f1.meta.json'), JSON.stringify({ agentType: 'fork', isFork: true, spawnDepth: 2 }));
    const convs = loadConversations(dir);
    const ids = convs.flatMap((c) => c.requests.map((r) => r.id)).sort();
    assert.deepEqual(ids, ['m1', 'm2', 'm5', 'm6']);
    assert.ok(convs.find((c) => c.requests.some((r) => r.id === 'm6'))!.isSubagent);
  });

  it('prepends the parent context a main-thread fork references instead of copying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s.jsonl', [u('u1', null, 'build the app'), a('a1', 'u1', 'm1', tu('t1')), u('r1', 'a1', [tr('t1')]), a('a2', 'r1', 'm2', tu('t2'))]);
    write(dir, 'p/s/subagents/agent-f.jsonl', [
      { type: 'fork-context-ref', agentId: 'f', parentSessionId: 's', parentLastUuid: 'a2', contextLength: 3 },
      u('f1', null, 'name the app'),
      u('f2', 'f1', '<fork-boilerplate>You are a worker fork.</fork-boilerplate>'),
      a('f3', 'f2', 'm9', { type: 'text', text: 'names' }, { stop: 'end_turn' }),
    ]);
    const fork = loadConversations(dir).find((c) => c.isSubagent)!;
    const rq = fork.requests[0]!;
    const ctx = rq.context.slice(0, rq.messageCount);
    assert.deepEqual(ctx.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(extractFeatures({ model: 'claude-opus-5-5', tools: [{}], messages: ctx }).isFirstRequest, false);
  });

  it('renders the plan_mode attachment into the turn so plan mode is detected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s.jsonl', [
      u('u1', null, 'how should we restructure the billing module'),
      { type: 'attachment', uuid: 'x1', parentUuid: 'u1', attachment: { type: 'plan_mode', reminderType: 'full', isSubAgent: false } },
      a('a1', 'x1', 'm1', { type: 'text', text: 'plan' }, { stop: 'end_turn' }),
    ]);
    const [conv] = loadConversations(dir);
    const rq = conv!.requests[0]!;
    const f = extractFeatures({ model: 'claude-opus-5-5', tools: [{}], messages: rq.context.slice(0, rq.messageCount) });
    assert.equal(f.planMode, true);
    assert.equal(f.userText, 'how should we restructure the billing module');
  });

  it('flags responses whose final usage was never written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s/subagents/agent-x.jsonl', [
      u('u1', null, 'find the config loader'),
      a('a1', 'u1', 'm1', { type: 'thinking', thinking: '' }, { stop: null, out: 8 }),
      a('a2', 'a1', 'm1', tu('t1'), { stop: null, out: 8 }),
      u('r1', 'a2', [tr('t1')]),
      a('a3', 'r1', 'm2', { type: 'text', text: 'here' }, { stop: 'end_turn' }),
    ]);
    const [conv] = loadConversations(dir);
    assert.deepEqual(conv!.requests.map((r) => r.usageFinal), [false, true]);
  });

  it('carries the agent type and fork flag from .meta.json into the replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sy-'));
    write(dir, 'p/s.jsonl', [u('u1', null, 'look into it'), a('a1', 'u1', 'm1', { type: 'text', text: 'ok' }, { stop: 'end_turn' })]);
    write(dir, 'p/s/subagents/agent-e.jsonl', [u('e1', null, 'Find every config loader and report the files.'), a('e2', 'e1', 'm2', { type: 'text', text: 'here' }, { stop: 'end_turn' })]);
    writeFileSync(join(dir, 'p/s/subagents/agent-e.meta.json'), JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }));
    const convs = loadConversations(dir);
    assert.equal(convs.find((c) => !c.isSubagent)!.agentType, 'main');
    const explore = convs.find((c) => c.isSubagent)!;
    assert.equal(explore.agentType, 'Explore');
    assert.equal(explore.isFork, false);
    const r = replay(convs, defaultConfig(), { normalizeGeneration: true });
    const sub = r.conversations.find((c) => c.isSubagent)!;
    assert.equal(sub.tierMix.sonnet, 1);
    assert.equal(typeof r.totals.effortSavingsUsd, 'number');
  });

  it('loads the bundled sample sessions and their subagent run', () => {
    const convs = loadConversations(SAMPLES);
    assert.equal(convs.filter((c) => !c.isSubagent).length, 5);
    assert.equal(convs.filter((c) => c.isSubagent).length, 1);
  });
});

describe('replay', () => {
  it('reports lower routed cost than baseline on the samples, with rebuilds priced in', () => {
    const r = replay(loadConversations(SAMPLES), defaultConfig(), { normalizeGeneration: true });
    assert.ok(r.totals.routedUsd < r.totals.baselineUsd);
    assert.ok(r.totals.switches > 0);
    assert.ok(r.totals.rebuildUsd > 0);
    assert.equal(r.series.length, r.totals.requests);
    // When unknown tasks are guessed as Sonnet, the long session is held by the cache arithmetic.
    const g = replay(loadConversations(SAMPLES), { ...defaultConfig(), noSignalTier: 'sonnet' }, { normalizeGeneration: true });
    assert.ok(g.totals.heldDownshifts >= 1, 'the long session should hold Opus instead of rebuilding a big cache');
  });

  it('until fixes the end of the window: requests at or after it are left out', () => {
    const convs = loadConversations(SAMPLES);
    const all = replay(convs, defaultConfig(), { normalizeGeneration: true });
    const cut = replay(convs, defaultConfig(), { normalizeGeneration: true, until: all.totals.end });
    assert.ok(cut.totals.requests > 0);
    assert.ok(cut.totals.requests < all.totals.requests);
    assert.ok(cut.totals.end < all.totals.end);
    const none = replay(convs, defaultConfig(), { normalizeGeneration: true, until: all.totals.start });
    assert.equal(none.totals.requests, 0);
  });

  it('conservative routes nothing below Sonnet', () => {
    const r = replay(loadConversations(SAMPLES), defaultConfig('conservative'), { normalizeGeneration: true });
    assert.equal(r.totals.tierMix.haiku ?? 0, 0);
  });
});
