import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { replay } from '../src/analyzer/replay.js';
import { loadConversations } from '../src/analyzer/transcripts.js';
import { defaultConfig } from '../src/config.js';

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
    assert.ok(r.totals.heldDownshifts >= 1, 'the long session should hold Opus instead of rebuilding a big cache');
    assert.equal(r.series.length, r.totals.requests);
  });

  it('conservative routes nothing below Sonnet', () => {
    const r = replay(loadConversations(SAMPLES), defaultConfig('conservative'), { normalizeGeneration: true });
    assert.equal(r.totals.tierMix.haiku ?? 0, 0);
  });
});
