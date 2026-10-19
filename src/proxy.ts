import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RouterConfig } from './config.js';
import { decide, observe, type Decision } from './engine.js';
import { extractFeatures, type MessagesRequest } from './features.js';
import { esc, int, mixBar, page, pill, tierOfModelName, usd } from './html.js';
import { costOf, promptTokens, splitUsage, type Usage } from './pricing.js';
import { mergeBetaHeader, rewriteRequest, type Rewrite } from './rewrite.js';
import { SessionStore, type SessionRecord } from './sessions.js';
import { resplit } from './simulate.js';
import { usageFromJson, UsageTap } from './sse.js';
import { StatsStore, type DecisionLogEntry } from './stats.js';

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'accept-encoding',
  'proxy-connection',
  'upgrade',
]);
const RESPONSE_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
/** Request-shape and availability errors worth retrying with the request Claude Code actually sent. */
const FAIL_OPEN_STATUSES = new Set([400, 404, 422, 529]);

export interface ProxyOptions {
  cfg: RouterConfig;
  /** Write stats and the decision log to cfg.dataDir (off in tests). */
  persist?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export interface RunningProxy {
  server: Server;
  url: string;
  stats: StatsStore;
  sessions: SessionStore;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function forwardHeaders(req: IncomingMessage, extraBetas: string[] = []): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    h.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  h.set('accept-encoding', 'identity');
  if (extraBetas.length) {
    const merged = mergeBetaHeader(h.get('anthropic-beta') ?? undefined, extraBetas);
    if (merged) h.set('anthropic-beta', merged);
  }
  return h;
}

function copyResponseHeaders(from: Response, to: ServerResponse, routedModel?: string): void {
  from.headers.forEach((v, k) => {
    if (!RESPONSE_DROP.has(k.toLowerCase())) to.setHeader(k, v);
  });
  if (routedModel) to.setHeader('x-switchyard-model', routedModel);
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '...' : t;
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const { cfg } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const sessions = new SessionStore();
  const stats = new StatsStore(cfg.dataDir, opts.persist ?? true);
  const upstream = cfg.upstream.replace(/\/$/, '');

  async function passthrough(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const r = await fetch(upstream + req.url, {
      method: req.method,
      headers: forwardHeaders(req),
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : new Uint8Array(body),
    });
    res.statusCode = r.status;
    copyResponseHeaders(r, res);
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
    let original: MessagesRequest;
    try {
      original = JSON.parse(raw.toString('utf8')) as MessagesRequest;
    } catch {
      return passthrough(req, res, raw);
    }
    const t0 = now();
    const features = extractFeatures(original);
    const session = sessions.get(original, t0);
    const decision = decide({ req: original, features, state: session.state, cfg, now: t0 });

    let rewrite: Rewrite | undefined;
    if (decision.route) rewrite = rewriteRequest(original, decision, features, session.ledger, cfg);
    const live = cfg.mode === 'live' && !!rewrite?.modified;
    const sendBody = live ? rewrite!.body : original;
    const sendBetas = live ? rewrite!.betas : [];

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let upstreamRes = await fetch(upstream + req.url, {
      method: 'POST',
      headers: forwardHeaders(req, sendBetas),
      // Unless a rewrite is live, forward Claude Code's bytes exactly as sent.
      body: live ? JSON.stringify(sendBody) : new Uint8Array(raw),
      signal: abort.signal,
    });

    let failOpen = false;
    let ranOn = sendBody.model;
    if (live && cfg.failOpen && FAIL_OPEN_STATUSES.has(upstreamRes.status)) {
      const errText = await upstreamRes.text();
      log(`[switchyard] ${upstreamRes.status} on ${sendBody.model}; retrying as sent by Claude Code: ${errText.slice(0, 300)}`);
      failOpen = true;
      ranOn = original.model;
      upstreamRes = await fetch(upstream + req.url, {
        method: 'POST',
        headers: forwardHeaders(req),
        body: new Uint8Array(raw),
        signal: abort.signal,
      });
    }

    res.statusCode = upstreamRes.status;
    copyResponseHeaders(upstreamRes, res, decision.route ? ranOn : undefined);

    const isStream = (upstreamRes.headers.get('content-type') ?? '').includes('text/event-stream');
    let usage: Usage = {};
    if (upstreamRes.body) {
      if (isStream) {
        const tap = new UsageTap();
        for await (const chunk of upstreamRes.body) {
          res.write(chunk);
          tap.push(chunk);
        }
        tap.end();
        usage = tap.usage;
      } else {
        const text = await upstreamRes.text();
        res.write(text);
        usage = usageFromJson(text).usage;
      }
    }
    res.end();

    account(session, original, decision, rewrite, features.newUserTurn, usage, upstreamRes.status, failOpen, ranOn, live, features.userText, t0);
  }

  function account(
    session: SessionRecord,
    original: MessagesRequest,
    decision: Decision,
    rewrite: Rewrite | undefined,
    newUserTurn: boolean,
    usage: Usage,
    status: number,
    failOpen: boolean,
    ranOn: string,
    live: boolean,
    userText: string,
    t: number,
  ): void {
    const split = splitUsage(usage);
    const prompt = promptTokens(split);
    const ok = status < 400;

    // In shadow mode the request really ran on the incoming model; re-price it as if routed.
    const routedModel = decision.route ? decision.model : original.model;
    let costUsd: number;
    let baselineUsd: number;
    const continuous = session.state.model === routedModel;
    if (live && !failOpen) {
      costUsd = costOf(ranOn, split, cfg.prices);
      const baseSplit =
        routedModel === original.model && (continuous || !session.state.model)
          ? split
          : resplit(split, session.baseline, t, cfg.cacheTtlSeconds, 'capByCacheable');
      baselineUsd = costOf(original.model, baseSplit, cfg.prices);
    } else {
      baselineUsd = costOf(original.model, split, cfg.prices);
      const routedSplit = resplit(
        split,
        session.state.modelCache[routedModel],
        t,
        cfg.cacheTtlSeconds,
        continuous || (!session.state.model && routedModel === original.model) ? 'continuous' : 'capByRead',
      );
      costUsd = decision.route ? costOf(routedModel, routedSplit, cfg.prices) : baselineUsd;
    }

    if (ok && prompt > 0) {
      if (decision.route) {
        if (rewrite) session.ledger = rewrite.ledger;
        observe(session.state, failOpen ? original.model : routedModel, prompt, split.output, t, rewrite?.effort);
      }
      session.baseline = { at: t, promptTokens: prompt };
      session.lastIncomingModel = original.model;
    }

    const entry: DecisionLogEntry = {
      ts: new Date(t).toISOString(),
      session: session.key,
      mode: cfg.mode,
      incoming: original.model,
      routed: decision.route ? (failOpen ? original.model : routedModel) : original.model,
      effort: rewrite?.effort,
      switched: decision.switched && !failOpen,
      freeSwitch: decision.freeSwitch,
      effortChanged: !!rewrite?.effortChanged && !failOpen,
      newUserTurn,
      promptTokens: prompt,
      outputTokens: split.output,
      costUsd,
      baselineUsd,
      status,
      forwarded: live && !failOpen ? 'rewritten' : 'original',
      ranOn,
      failOpen: failOpen || undefined,
      reasons: decision.reasons,
      notes: rewrite?.notes ?? [],
      userPreview: userText ? preview(userText) : undefined,
    };
    stats.record(entry, decision.route);
    if (decision.route && (decision.switched || newUserTurn)) {
      log(
        `[switchyard] ${original.model} -> ${entry.routed}${entry.effort ? '/' + entry.effort : ''}` +
          `${entry.switched ? ' (switch)' : ''}  ${decision.reasons.join(' | ')}`,
      );
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'GET' && (path === '/switchyard' || path === '/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(dashboard(stats, cfg));
        return;
      }
      if (req.method === 'GET' && path === '/switchyard/stats') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ stats: stats.stats, recent: stats.recent.slice(0, 50) }, null, 2));
        return;
      }
      if (req.method === 'GET' && path === '/health') {
        res.end('ok');
        return;
      }
      const body = await readBody(req);
      if (req.method === 'POST' && path === '/v1/messages') {
        await handleMessages(req, res, body);
      } else {
        await passthrough(req, res, body);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') return;
      log(`[switchyard] error: ${e.stack ?? e.message}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `switchyard: ${e.message}` } }));
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      resolve({
        server,
        url: `http://${cfg.host}:${port}`,
        stats,
        sessions,
        close: () =>
          new Promise<void>((r) => {
            stats.flush();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function dashboard(store: StatsStore, cfg: RouterConfig): string {
  const s = store.stats;
  const saved = s.baselineUsd - s.costUsd;
  const counts: Record<string, number> = {};
  for (const [m, v] of Object.entries(s.byModel)) {
    const t = tierOfModelName(m);
    counts[t] = (counts[t] ?? 0) + v.requests;
  }
  const rows = store.recent
    .slice(0, 60)
    .map(
      (e) => `<tr><td class="mono">${esc(e.ts.slice(11, 19))}</td><td>${pill(e.routed)}${e.effort ? ` <span class="mono">${esc(e.effort)}</span>` : ''}${e.switched ? ' ⇄' : ''}</td>
<td>${e.userPreview ? esc(e.userPreview) : '<span class="reasons">tool loop</span>'}<div class="reasons">${esc(e.reasons.join(' · '))}</div></td>
<td class="num">${int(e.promptTokens)}</td><td class="num">${usd(e.costUsd)}</td><td class="num">${usd(e.baselineUsd)}</td></tr>`,
    )
    .join('');
  return page(
    'Switchyard',
    `<header><h1>Switchyard</h1><p>Mode <b>${esc(cfg.mode)}</b> · preset <b>${esc(cfg.preset)}</b> · cache TTL ${cfg.cacheTtlSeconds}s · since ${esc(s.startedAt.slice(0, 16).replace('T', ' '))}</p></header>
<div class="cards">
<div class="card"><div class="k">Requests</div><div class="v">${int(s.requests)}</div><div class="s">${int(s.routed)} routed</div></div>
<div class="card"><div class="k">Model switches</div><div class="v">${int(s.switches)}</div><div class="s">${int(s.freeSwitches)} at free cache boundaries</div></div>
<div class="card"><div class="k">Effort changes</div><div class="v">${int(s.effortChanges)}</div><div class="s">cache-safe, per message</div></div>
<div class="card"><div class="k">Cost</div><div class="v">${usd(s.costUsd)}</div><div class="s">vs ${usd(s.baselineUsd)} unrouted</div></div>
<div class="card"><div class="k">Saved</div><div class="v ${saved >= 0 ? 'good' : 'bad'}">${usd(saved)}</div><div class="s">${s.baselineUsd > 0 ? ((saved / s.baselineUsd) * 100).toFixed(1) : '0.0'}% at API list prices</div></div>
</div>
<section><h2>Model mix</h2><p class="sub">Share of requests per tier</p>${mixBar(counts)}</section>
<section><h2>Recent decisions</h2><p class="sub">Newest first. Refreshes every 5 seconds.</p><div class="scroll"><table>
<tr><th>Time</th><th>Routed to</th><th>Turn and reasoning</th><th class="num">Prompt tokens</th><th class="num">Cost</th><th class="num">Unrouted</th></tr>${rows}</table></div></section>`,
    '<meta http-equiv="refresh" content="5">',
  );
}
