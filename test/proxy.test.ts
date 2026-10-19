import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { defaultConfig, type RouterConfig } from '../src/config.js';
import type { Decision } from '../src/engine.js';
import { extractFeatures, type Message, type MessagesRequest } from '../src/features.js';
import { PER_MESSAGE_EFFORT_BETA } from '../src/models.js';
import { startProxy, type RunningProxy } from '../src/proxy.js';
import { injectLedger, messageHash, rewriteRequest, type LedgerEntry } from '../src/rewrite.js';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

describe('rewrite', () => {
  const cfg = defaultConfig();
  const base: MessagesRequest = {
    model: 'claude-opus-5-5',
    tools: [{}],
    max_tokens: 128000,
    thinking: { type: 'disabled' },
    messages: [user('earlier'), { role: 'assistant', content: 'ok' }, user('//h thanks')],
  };
  const decision: Decision = { route: true, model: 'claude-haiku-5-5', effort: 'low', switched: true, reasons: [] };

  it('sets the model, clamps max_tokens, strips the override and adds an effort message', () => {
    const f = extractFeatures(base);
    const rw = rewriteRequest(base, decision, f, [], cfg);
    assert.equal(rw.body.model, 'claude-haiku-5-5');
    assert.equal(rw.body.max_tokens, 64000);
    // Haiku 5.5 with thinking disabled can't change effort per message, so none is injected.
    assert.equal(rw.betas.length, 0);
    const last = rw.body.messages[rw.body.messages.length - 1]!;
    assert.equal((last.content as any)[0].text, 'thanks');
  });

  it('drops thinking:disabled for always-thinking models', () => {
    const rw = rewriteRequest(base, { ...decision, model: 'claude-sonnet-5-5', effort: 'medium' }, extractFeatures(base), [], cfg);
    assert.equal(rw.body.thinking, undefined);
    assert.ok(rw.betas.includes(PER_MESSAGE_EFFORT_BETA));
    const sys = rw.body.messages.find((m) => m.role === 'system')!;
    assert.deepEqual(sys.output_config, { effort: 'medium' });
  });

  it('re-injects ledger entries at the same place so the prefix stays identical', () => {
    const msgs: Message[] = [user('a'), { role: 'assistant', content: 'b' }, user('c')];
    const ledger: LedgerEntry[] = [{ index: 2, hash: messageHash(msgs[2]!), effort: 'low' }];
    const first = injectLedger(msgs, ledger);
    const later = injectLedger([...msgs, { role: 'assistant', content: 'd' }, user('e')], ledger);
    assert.deepEqual(later.slice(0, first.length), first);
  });

  it('drops ledger entries whose anchor changed (compaction)', () => {
    const msgs: Message[] = [user('summary of earlier work'), { role: 'assistant', content: 'ok' }, user('next')];
    const stale: LedgerEntry[] = [{ index: 2, hash: 'deadbeefdeadbeef', effort: 'low' }];
    const rw = rewriteRequest({ ...base, thinking: undefined, messages: msgs }, { ...decision, model: 'claude-opus-5-5', effort: undefined }, extractFeatures({ ...base, messages: msgs }), stale, cfg);
    assert.equal(rw.ledger.length, 0);
  });
});

/** A fake Anthropic API that records requests and streams a reply with usage. */
interface Recorded {
  raw: string;
  body: MessagesRequest;
  headers: IncomingMessage['headers'];
}

function sse(model: string, usage: Record<string, number>): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', model, role: 'assistant', content: [], usage: { ...usage, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

describe('proxy end to end', () => {
  let upstream: Server;
  let upstreamUrl = '';
  const seen: Recorded[] = [];
  let rejectModel: string | undefined;
  let proxy: RunningProxy;

  before(async () => {
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.startsWith('/v1/models')) {
        res.setHeader('content-type', 'application/json');
        res.end('{"data":[]}');
        return;
      }
      const body = JSON.parse(raw) as MessagesRequest;
      seen.push({ raw, body, headers: req.headers });
      if (rejectModel && body.model === rejectModel) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}');
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse(body.model, { input_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000 }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const a = upstream.address();
    upstreamUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  after(async () => {
    await proxy?.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  async function start(patch: Partial<RouterConfig> = {}) {
    if (proxy) await proxy.close();
    const cfg = { ...defaultConfig(), upstream: upstreamUrl, port: 0, ...patch };
    proxy = await startProxy({ cfg, persist: false, log: () => {} });
    seen.length = 0;
  }

  async function send(body: MessagesRequest, beta = 'oauth-2025-04-20') {
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test', 'anthropic-beta': beta },
      body: JSON.stringify({ stream: true, max_tokens: 32000, metadata: { user_id: 'session_abc' }, system: 'You are Claude Code.', tools: [{ name: 'Bash' }], ...body }),
    });
    return { res, text: await res.text() };
  }

  it('routes a fresh conversation, streams the reply through, and keeps the prefix stable in the tool loop', async () => {
    await start();
    const turn1: Message[] = [user('rename getUserData to fetchUserProfile everywhere')];
    const r1 = await send({ model: 'claude-opus-5-5', messages: turn1 });
    assert.equal(r1.res.status, 200);
    assert.match(r1.text, /message_stop/);
    assert.equal(r1.res.headers.get('x-switchyard-model'), 'claude-haiku-5-5');
    assert.equal(seen[0]!.body.model, 'claude-haiku-5-5');
    assert.equal(seen[0]!.headers['authorization'], undefined);
    assert.equal(seen[0]!.headers['x-api-key'], 'test');

    // Claude Code continues the tool loop, unaware of the routing.
    const turn1b: Message[] = [
      ...turn1,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'getUserData' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/a.ts:1' }] },
    ];
    await send({ model: 'claude-opus-5-5', messages: turn1b });
    assert.equal(seen[1]!.body.model, 'claude-haiku-5-5');

    // Whatever the router injected into request 1 must reappear unchanged at the start of request 2.
    const first = seen[0]!.body.messages;
    assert.deepEqual(seen[1]!.body.messages.slice(0, first.length), first);
  });

  it('injects a cache-safe effort change with the beta header', async () => {
    await start();
    await send({ model: 'claude-opus-5-5', messages: [user('thanks!')] });
    const body = seen[0]!.body;
    assert.equal(body.model, 'claude-haiku-5-5');
    const sys = body.messages.find((m) => m.role === 'system');
    assert.deepEqual(sys?.output_config, { effort: 'low' });
    const betas = String(seen[0]!.headers['anthropic-beta']);
    assert.ok(betas.includes('oauth-2025-04-20'));
    assert.ok(betas.includes(PER_MESSAGE_EFFORT_BETA));
  });

  it('fails open: retries with the original request when the routed one is rejected', async () => {
    await start();
    rejectModel = 'claude-haiku-5-5';
    try {
      const r = await send({ model: 'claude-opus-5-5', messages: [user('rename a to b')] });
      assert.equal(r.res.status, 200);
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.body.model, 'claude-opus-5-5');
      assert.equal(proxy.stats.stats.failOpens, 1);
    } finally {
      rejectModel = undefined;
    }
  });

  it('shadow mode decides but forwards the request untouched', async () => {
    await start({ mode: 'shadow' });
    // Spacing and escapes that a JSON parse-and-serialize round trip would normalize.
    const raw = '{ "model": "claude-opus-5-5", "stream": true, "max_tokens": 32000, "tools": [{"name": "Bash"}],\n' +
      '  "messages": [{"role": "user", "content": [{"type": "text", "text": "rename a to b \\u00e9"}]}] }';
    await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' }, body: raw });
    assert.equal(seen[0]!.raw, raw);
    assert.equal(proxy.stats.recent[0]!.forwarded, 'original');
    assert.equal(proxy.stats.recent[0]!.ranOn, 'claude-opus-5-5');
    assert.equal(proxy.stats.recent[0]!.routed, 'claude-haiku-5-5');
    assert.ok(proxy.stats.recent[0]!.costUsd < proxy.stats.recent[0]!.baselineUsd);
  });

  it('passes other endpoints through and serves the dashboard', async () => {
    await start();
    const m = await fetch(`${proxy.url}/v1/models`, { headers: { 'x-api-key': 'k' } });
    assert.equal(m.status, 200);
    const d = await fetch(`${proxy.url}/switchyard`);
    assert.match(await d.text(), /Switchyard/);
    const s = await (await fetch(`${proxy.url}/switchyard/stats`)).json();
    assert.equal(typeof s.stats.requests, 'number');
  });
});
