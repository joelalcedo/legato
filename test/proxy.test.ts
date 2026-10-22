import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultConfig, type RouterConfig } from '../src/config.js';
import type { Decision } from '../src/engine.js';
import { extractFeatures, type Message, type MessagesRequest } from '../src/features.js';
import { PER_MESSAGE_EFFORT_BETA } from '../src/models.js';
import { startProxy, type RunningProxy } from '../src/proxy.js';
import { controlMessageIndex, rewriteRequest } from '../src/rewrite.js';
import { conversationKey, sessionIdOf } from '../src/sessions.js';
import { readSessionStatus } from '../src/stats.js';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
/** Claude Code's per-turn control message: the request's tail, carrying the environment block and the effort. */
const control = (effort: string): Message => ({
  role: 'system',
  content: [{ type: 'text', text: '# Environment\n - Primary working directory: /tmp/p', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  output_config: { effort },
});
const toolUse: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'a' } }] };
const toolResult: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/a.ts:1' }] };
const MAIN_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const SESSION = '2b83602b-b1e1-4964-a8cd-38a7814fbc62';
const userId = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SESSION });

describe('rewrite', () => {
  const cfg = defaultConfig();
  const base: MessagesRequest = {
    model: 'claude-opus-5-5',
    tools: [{}],
    max_tokens: 128000,
    output_config: { effort: 'xhigh' },
    messages: [user('earlier'), { role: 'assistant', content: 'ok' }, user('//h thanks'), control('xhigh')],
  };
  const decision: Decision = { route: true, model: 'claude-haiku-5-5', effort: 'low', switched: true, reasons: [] };

  it("sets the model, strips the override and rewrites the effort in Claude Code's control message", () => {
    const rw = rewriteRequest(base, decision, extractFeatures(base), undefined, cfg);
    assert.equal(rw.body.model, 'claude-haiku-5-5');
    // Claude Code's own per-turn-control beta covers a rewritten value: no header is added.
    assert.equal(rw.betas.length, 0);
    const msgs = rw.body.messages;
    assert.equal(msgs.length, 4);
    assert.equal((msgs[2]!.content as any)[0].text, 'thanks');
    assert.deepEqual(msgs[3]!.output_config, { effort: 'low' });
    assert.deepEqual((msgs[3]!.content as any)[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.equal(rw.effort, 'low');
    assert.equal(rw.effortChanged, true);
    assert.equal(rw.modified, true);
  });

  it('appends an effort-only message, under the beta, when the client sends no control message', () => {
    const req = { ...base, messages: base.messages.slice(0, 3) };
    const rw = rewriteRequest(req, { ...decision, model: 'claude-sonnet-5-5', effort: 'medium' }, extractFeatures(req), undefined, cfg);
    assert.ok(rw.betas.includes(PER_MESSAGE_EFFORT_BETA));
    const last = rw.body.messages[rw.body.messages.length - 1]!;
    assert.equal(last.role, 'system');
    assert.deepEqual(last.output_config, { effort: 'medium' });
    assert.equal(controlMessageIndex(rw.body.messages), rw.body.messages.length - 1);
  });

  it("keeps the turn's effort through its tool loop without touching the history", () => {
    const loop: MessagesRequest = { ...base, messages: [user('rename a to b'), toolUse, toolResult, control('xhigh')] };
    const hold: Decision = { route: true, model: 'claude-opus-5-5', switched: false, reasons: [] };
    const rw = rewriteRequest(loop, hold, extractFeatures(loop), 'low', cfg);
    assert.deepEqual(rw.body.messages.slice(0, 3), loop.messages.slice(0, 3));
    assert.deepEqual(rw.body.messages[3]!.output_config, { effort: 'low' });
    assert.equal(rw.effortChanged, false);
  });

  it('leaves a request alone when the engine agrees with the effort Claude Code asked for', () => {
    const rw = rewriteRequest(base, { ...decision, model: 'claude-opus-5-5', effort: 'xhigh', switched: false }, extractFeatures(base), undefined, cfg);
    assert.equal(rw.effort, 'xhigh');
    assert.deepEqual(rw.body.messages[3], base.messages[3]);
  });

  it('drops thinking:disabled for always-thinking models', () => {
    const req = { ...base, thinking: { type: 'disabled' } };
    const rw = rewriteRequest(req, { ...decision, model: 'claude-sonnet-5-5', effort: 'medium' }, extractFeatures(req), undefined, cfg);
    assert.equal(rw.body.thinking, undefined);
    assert.deepEqual(rw.body.messages[3]!.output_config, { effort: 'medium' });
  });

  it('does not change effort on Haiku 5.5 with thinking disabled, which rejects it', () => {
    const req = { ...base, thinking: { type: 'disabled' } };
    const rw = rewriteRequest(req, decision, extractFeatures(req), undefined, cfg);
    assert.deepEqual(rw.body.messages[3]!.output_config, { effort: 'xhigh' });
    assert.equal(rw.betas.length, 0);
  });
});

describe('sessions', () => {
  it('reads the session id out of metadata.user_id', () => {
    assert.equal(sessionIdOf({ model: 'm', messages: [], metadata: { user_id: userId } }), SESSION);
    assert.equal(sessionIdOf({ model: 'm', messages: [], metadata: { user_id: `user_x_account_y_session_${SESSION}` } }), SESSION);
    assert.equal(sessionIdOf({ model: 'm', messages: [] }), undefined);
  });

  it('gives a fork its own key although it re-sends the parent history', () => {
    const parent: MessagesRequest = { model: 'm', messages: [user('build it'), toolUse, toolResult], metadata: { user_id: userId }, system: MAIN_SYSTEM };
    const fork: MessagesRequest = { ...parent, messages: [...parent.messages, user('name the app'), user('<fork-boilerplate>You are a worker fork.</fork-boilerplate>')] };
    const parentLater: MessagesRequest = { ...parent, messages: [...parent.messages, { role: 'assistant', content: 'done' }, user('next')] };
    assert.notEqual(conversationKey(fork), conversationKey(parent));
    assert.equal(conversationKey(parentLater), conversationKey(parent));
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

  async function start(patch: Partial<RouterConfig> = {}, persist = false) {
    if (proxy) await proxy.close();
    const cfg = { ...defaultConfig(), upstream: upstreamUrl, port: 0, ...patch };
    proxy = await startProxy({ cfg, persist, log: () => {} });
    seen.length = 0;
  }

  async function send(body: Partial<MessagesRequest>, beta = 'oauth-2025-04-20,per-turn-control-2026-07-01') {
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test', 'anthropic-beta': beta },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        stream: true,
        max_tokens: 128000,
        output_config: { effort: 'xhigh' },
        metadata: { user_id: userId },
        system: MAIN_SYSTEM,
        tools: [{ name: 'Bash' }],
        messages: [],
        ...body,
      }),
    });
    return { res, text: await res.text() };
  }

  it('routes a fresh conversation, streams the reply through, and keeps the prefix stable in the tool loop', async () => {
    await start();
    const turn1: Message[] = [user('rename getUserData to fetchUserProfile everywhere'), control('xhigh')];
    const r1 = await send({ messages: turn1 });
    assert.equal(r1.res.status, 200);
    assert.match(r1.text, /message_stop/);
    assert.equal(r1.res.headers.get('x-switchyard-model'), 'claude-haiku-5-5');
    assert.equal(seen[0]!.body.model, 'claude-haiku-5-5');
    assert.equal(seen[0]!.headers['authorization'], undefined);
    assert.equal(seen[0]!.headers['x-api-key'], 'test');
    assert.deepEqual(seen[0]!.body.messages[1]!.output_config, { effort: 'medium' });

    // Claude Code continues the tool loop, unaware of the routing; its control message moves to the new tail.
    const turn1b: Message[] = [turn1[0]!, toolUse, toolResult, control('xhigh')];
    await send({ messages: turn1b });
    assert.equal(seen[1]!.body.model, 'claude-haiku-5-5');
    // The history the router forwarded in request 1 reappears byte for byte at the start of request 2,
    // and the turn's effort is still in force without anything having been inserted.
    assert.deepEqual(seen[1]!.body.messages.slice(0, 1), seen[0]!.body.messages.slice(0, 1));
    assert.deepEqual(seen[1]!.body.messages.slice(1, 3), [toolUse, toolResult]);
    assert.deepEqual(seen[1]!.body.messages[3]!.output_config, { effort: 'medium' });
    assert.equal(String(seen[1]!.headers['anthropic-beta']).includes(PER_MESSAGE_EFFORT_BETA), false);
  });

  it('appends a cache-safe effort message with the beta when the client has no control message', async () => {
    await start();
    await send({ messages: [user('thanks!')] }, 'oauth-2025-04-20');
    const body = seen[0]!.body;
    assert.equal(body.model, 'claude-haiku-5-5');
    const sys = body.messages.find((m) => m.role === 'system');
    assert.deepEqual(sys?.output_config, { effort: 'low' });
    const betas = String(seen[0]!.headers['anthropic-beta']);
    assert.ok(betas.includes('oauth-2025-04-20'));
    assert.ok(betas.includes(PER_MESSAGE_EFFORT_BETA));
  });

  it('fails open: retries with the original request and records that it ran as sent', async () => {
    await start();
    rejectModel = 'claude-haiku-5-5';
    try {
      const r = await send({ messages: [user('rename a to b'), control('xhigh')] });
      assert.equal(r.res.status, 200);
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.body.model, 'claude-opus-5-5');
      assert.deepEqual(seen[1]!.body.messages[1]!.output_config, { effort: 'xhigh' });
      assert.equal(proxy.stats.stats.failOpens, 1);
      const e = proxy.stats.recent[0]!;
      assert.equal(e.ranOn, 'claude-opus-5-5');
      assert.equal(e.effort, undefined);
      assert.equal(e.forwarded, 'original');
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

  it('resolves a launch alias such as --model dynamic before routing and never forwards it upstream', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sy-alias-'));
    await start({ dataDir }, true);
    // A background request (no tools) goes as sent, apart from the model name the API would reject.
    await send({ model: 'dynamic', tools: [], messages: [user('hi')] });
    assert.equal(seen[0]!.body.model, 'claude-opus-5-5');
    // A routable turn is priced against the alias target and routed from there.
    await send({ model: 'dynamic', messages: [user('rename a to b'), control('xhigh')] });
    assert.equal(seen[1]!.body.model, 'claude-haiku-5-5');
    const status = readSessionStatus(dataDir, SESSION)!;
    assert.equal(status.alias, 'dynamic');
    assert.equal(status.incoming, 'dynamic'); // what Claude Code asked for, as the user typed it
    assert.equal(status.model, 'claude-haiku-5-5');
    // Shadow mode too, and the alias is matched loosely: Claude Code's header shows it verbatim.
    await start({ mode: 'shadow' });
    await send({ model: 'Dynamic Mode', messages: [user('rename a to b'), control('xhigh')] });
    assert.equal(seen[0]!.body.model, 'claude-opus-5-5');
    assert.equal(proxy.stats.recent[0]!.forwarded, 'aliased');
    assert.equal(proxy.stats.recent[0]!.routed, 'claude-haiku-5-5');
  });

  it('tells the status line when a request was forwarded as sent or failed upstream', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sy-fail-'));
    await start({ dataDir }, true);
    rejectModel = 'gpt-5';
    try {
      const { res } = await send({ model: 'gpt-5', messages: [user('Test'), control('xhigh')] });
      assert.equal(res.status, 400);
    } finally {
      rejectModel = undefined;
    }
    let status = readSessionStatus(dataDir, SESSION)!;
    assert.equal(status.through, false);
    assert.equal(status.lastStatus, 400);
    assert.equal(status.reason, 'unrecognized model family');
    // A background request must not overwrite what the line shows.
    await send({ model: 'claude-opus-5-5', tools: [], messages: [user('title please')] });
    status = readSessionStatus(dataDir, SESSION)!;
    assert.equal(status.lastStatus, 400);
    // The health endpoint identifies the build, so a launcher can tell a stale proxy.
    const health = (await (await fetch(`${proxy.url}/health`)).json()) as { ok: boolean; build: string; pid: number };
    assert.equal(health.ok, true);
    assert.equal(health.pid, process.pid);
    assert.ok(health.build.length > 0);
  });

  it("writes a status file for the session's main thread and keeps session state across a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sy-data-'));
    await start({ dataDir }, true);
    await send({ messages: [user('rename a to b'), control('xhigh')] });
    const status = readSessionStatus(dataDir, SESSION)!;
    assert.equal(status.model, 'claude-haiku-5-5');
    assert.equal(status.effort, 'medium');
    assert.equal(status.incoming, 'claude-opus-5-5');
    assert.equal(status.turns, 1);
    assert.ok(status.baselineUsd > status.costUsd);
    const entry = proxy.stats.recent[0]!;
    assert.equal(entry.sessionId, SESSION);
    assert.equal(entry.agentType, 'main');
    assert.equal(entry.classifier, 'heuristic');

    // A new proxy process finds the conversation on Haiku and holds it through the tool loop.
    await start({ dataDir }, true);
    await send({ messages: [user('rename a to b'), toolUse, toolResult, control('xhigh')] });
    assert.equal(seen[0]!.body.model, 'claude-haiku-5-5');
    assert.equal(proxy.stats.recent[0]!.switched, false);
  });

  it('routes an Explore subagent by its type and logs the trial arm for general-purpose agents', async () => {
    await start({ trial: { agentType: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'high', share: 1 } });
    const explore = ['You are a Claude agent, built on Anthropic\'s Claude Agent SDK.', 'You are a file search specialist for Claude Code, Anthropic\'s official CLI for Claude.'];
    await send({ system: explore.map((text) => ({ type: 'text', text })), messages: [user('Find where the retry logic for webhooks lives and report the files.'), control('high')] });
    assert.equal(seen[0]!.body.model, 'claude-sonnet-5-5');
    assert.equal(proxy.stats.recent[0]!.agentType, 'Explore');

    const gp = ['You are a Claude agent, built on Anthropic\'s Claude Agent SDK.', 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude. Given the user\'s message, you should use the tools available to complete the task.'];
    await send({ system: gp.map((text) => ({ type: 'text', text })), messages: [user('Investigate why the dashboard re-renders three times and find the root cause.'), control('high')] });
    assert.equal(seen[1]!.body.model, 'claude-sonnet-5-5');
    assert.deepEqual(seen[1]!.body.messages[1]!.output_config, { effort: 'high' });
    assert.equal(proxy.stats.recent[0]!.arm, 'B');
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
