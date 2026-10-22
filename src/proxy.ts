import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { classifyWithModel } from './classifier.js';
import { resolveAlias, type RouterConfig } from './config.js';
import { decide, observe, type Decision } from './engine.js';
import { extractFeatures, type Features, type MessagesRequest } from './features.js';
import { esc, int, mixBar, page, pill, tierOfModelName, usd } from './html.js';
import { costOf, promptTokens, splitUsage, type Usage } from './pricing.js';
import { mergeBetaHeader, rewriteRequest, type Rewrite } from './rewrite.js';
import { sessionIdOf, SessionStore, type SessionRecord } from './sessions.js';
import { resplit } from './simulate.js';
import { usageFromJson, UsageTap } from './sse.js';
import { StatsStore, writeSessionStatus, type DecisionLogEntry } from './stats.js';

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
/** Logged status when Claude Code closed the request before the response finished (Esc, timeout, exit). */
const CLIENT_CLOSED = 499;
/** How long a model-based classification may hold up the first token of a turn. */
const CLASSIFIER_TIMEOUT_MS = 400;

export interface ProxyOptions {
  cfg: RouterConfig;
  /** Write stats, the decision log, session state and status files to cfg.dataDir (off in tests). */
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
  if (routedModel) to.setHeader('x-legato-model', routedModel);
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '...' : t;
}

/** Identifies the code a running proxy was started from, so a launcher can tell it is stale. */
export const BUILD: string = (() => {
  try {
    return String(Math.round(statSync(fileURLToPath(import.meta.url)).mtimeMs));
  } catch {
    return 'unknown';
  }
})();

interface Outcome {
  usage: Usage;
  status: number;
  failOpen: boolean;
  ranOn: string;
  live: boolean;
  /** The model name Claude Code sent when it was an alias (`dynamic`), resolved before routing. */
  alias?: string;
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const { cfg } = opts;
  const persist = opts.persist ?? true;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const sessions = new SessionStore(500, persist ? cfg.dataDir : undefined);
  const stats = new StatsStore(cfg.dataDir, persist);
  const upstream = cfg.upstream.replace(/\/$/, '');
  const classifierKey = process.env.LEGATO_CLASSIFIER_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (cfg.classifier === 'haiku' && !classifierKey) {
    log(`[legato] classifier haiku needs LEGATO_CLASSIFIER_KEY or ANTHROPIC_API_KEY; using the heuristic`);
  }
  /** Per Claude Code session: what its main thread's status line shows. */
  const statusTotals = new Map<string, { turns: number; requests: number; costUsd: number; baselineUsd: number }>();

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

  async function classifyTurn(features: Features) {
    if (cfg.classifier !== 'haiku' || !classifierKey || !features.newUserTurn || !features.hasTools || features.override) return undefined;
    return classifyWithModel(features.userText, { apiKey: classifierKey, model: cfg.classifierModel, upstream, timeoutMs: CLASSIFIER_TIMEOUT_MS });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
    let original: MessagesRequest;
    try {
      original = JSON.parse(raw.toString('utf8')) as MessagesRequest;
    } catch {
      return passthrough(req, res, raw);
    }
    // `claude --model dynamic`: the alias means "route it, up to this model". The API has never
    // heard of it, so the forwarded body carries the real name even when nothing else changes.
    const aliasTarget = resolveAlias(cfg, original.model);
    const alias = aliasTarget ? original.model : undefined;
    if (aliasTarget) original = { ...original, model: aliasTarget };
    const sent = alias ? Buffer.from(JSON.stringify(original)) : raw;
    const t0 = now();
    const features = extractFeatures(original);
    const session = sessions.get(original, t0);
    const classification = await classifyTurn(features);
    const decision = decide({ req: original, features, state: session.state, cfg, now: t0, classification });

    let rewrite: Rewrite | undefined;
    if (decision.route) rewrite = rewriteRequest(original, decision, features, session.state.effort, cfg);
    const live = cfg.mode === 'live' && !!rewrite?.modified;
    const sendBody = live ? rewrite!.body : original;
    const sendBetas = live ? rewrite!.betas : [];

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const outcome: Outcome = { usage: {}, status: 0, failOpen: false, ranOn: sendBody.model, live, alias };
    const tap = new UsageTap();
    const classifier = classification ? cfg.classifierModel : undefined;
    try {
      let upstreamRes = await fetch(upstream + req.url, {
        method: 'POST',
        headers: forwardHeaders(req, sendBetas),
        // Unless a rewrite is live, forward Claude Code's bytes exactly as sent.
        body: live ? JSON.stringify(sendBody) : new Uint8Array(sent),
        signal: abort.signal,
      });

      if (live && cfg.failOpen && FAIL_OPEN_STATUSES.has(upstreamRes.status)) {
        const errText = await upstreamRes.text();
        log(`[legato] ${upstreamRes.status} on ${sendBody.model}; retrying as sent by Claude Code: ${errText.slice(0, 300)}`);
        outcome.failOpen = true;
        outcome.ranOn = original.model;
        upstreamRes = await fetch(upstream + req.url, {
          method: 'POST',
          headers: forwardHeaders(req),
          body: new Uint8Array(sent),
          signal: abort.signal,
        });
      }

      outcome.status = upstreamRes.status;
      res.statusCode = upstreamRes.status;
      copyResponseHeaders(upstreamRes, res, decision.route ? outcome.ranOn : undefined);

      const isStream = (upstreamRes.headers.get('content-type') ?? '').includes('text/event-stream');
      if (upstreamRes.body) {
        if (isStream) {
          for await (const chunk of upstreamRes.body) {
            res.write(chunk);
            tap.push(chunk);
          }
          tap.end();
          outcome.usage = tap.usage;
        } else {
          const text = await upstreamRes.text();
          res.write(text);
          outcome.usage = usageFromJson(text).usage;
        }
      }
      res.end();
    } catch (err) {
      // Claude Code gave up on the request, or the upstream connection failed. Either way the
      // request happened, so it is logged with what was learned before it ended.
      const aborted = (err as Error).name === 'AbortError';
      tap.end();
      outcome.usage = tap.usage;
      outcome.status = aborted ? CLIENT_CLOSED : 502;
      account(session, original, decision, rewrite, features, outcome, t0, classifier);
      if (aborted) {
        log(`[legato] client closed the request after ${((now() - t0) / 1000).toFixed(1)}s (${outcome.ranOn}, ${features.newUserTurn ? 'user turn' : 'tool loop'})`);
        return;
      }
      throw err;
    }
    account(session, original, decision, rewrite, features, outcome, t0, classifier);
  }

  function account(
    session: SessionRecord,
    original: MessagesRequest,
    decision: Decision,
    rewrite: Rewrite | undefined,
    features: Features,
    { usage, status, failOpen, ranOn, live, alias }: Outcome,
    t: number,
    classifier: string | undefined,
  ): void {
    const ttl = (cfg.detectCacheTtl && features.cacheTtlSeconds) || cfg.cacheTtlSeconds;
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
          : resplit(split, session.baseline, t, ttl, 'capByCacheable');
      baselineUsd = costOf(original.model, baseSplit, cfg.prices);
    } else {
      baselineUsd = costOf(original.model, split, cfg.prices);
      const routedSplit = resplit(
        split,
        session.state.modelCache[routedModel],
        t,
        ttl,
        continuous || (!session.state.model && routedModel === original.model) ? 'continuous' : 'capByRead',
      );
      costUsd = decision.route ? costOf(routedModel, routedSplit, cfg.prices) : baselineUsd;
    }

    if (ok && prompt > 0) {
      if (decision.route) {
        // After a fail-open the request ran as Claude Code sent it: on its model, at its effort.
        observe(session.state, failOpen ? original.model : routedModel, prompt, split.output, t, failOpen ? undefined : rewrite?.effort);
      }
      session.baseline = { at: t, promptTokens: prompt };
      session.lastIncomingModel = original.model;
      sessions.save(session);
    }

    const sessionId = sessionIdOf(original);
    const entry: DecisionLogEntry = {
      ts: new Date(t).toISOString(),
      session: session.key,
      mode: cfg.mode,
      incoming: original.model,
      routed: decision.route ? (failOpen ? original.model : routedModel) : original.model,
      effort: failOpen ? undefined : rewrite?.effort,
      switched: decision.switched && !failOpen,
      freeSwitch: decision.freeSwitch,
      effortChanged: !!rewrite?.effortChanged && !failOpen,
      newUserTurn: features.newUserTurn,
      promptTokens: prompt,
      outputTokens: split.output,
      costUsd,
      baselineUsd,
      status,
      forwarded: live && !failOpen ? 'rewritten' : alias ? 'aliased' : 'original',
      alias,
      ranOn,
      failOpen: failOpen || undefined,
      reasons: decision.reasons,
      notes: rewrite?.notes ?? [],
      userPreview: features.userText ? preview(features.userText) : undefined,
      sessionId,
      agentType: features.agentType,
      arm: decision.arm,
      classifier: decision.route && features.newUserTurn ? (classifier ?? 'heuristic') : undefined,
      latencyMs: Math.max(0, now() - t),
    };
    stats.record(entry, decision.route);

    // The status line shows the session's main thread, not its subagents. Requests the router
    // forwarded as sent (unknown model) and upstream failures are shown too, so the line never
    // claims a session is not going through the proxy when it is; background requests (no tools)
    // are left out so they don't flicker the line after every turn.
    const mainThread = features.agentType === 'main' || features.agentType === undefined;
    if (persist && sessionId && mainThread && (decision.route || features.hasTools)) {
      const totals = statusTotals.get(sessionId) ?? { turns: 0, requests: 0, costUsd: 0, baselineUsd: 0 };
      if (decision.route) {
        totals.requests++;
        if (features.newUserTurn) totals.turns++;
        totals.costUsd += costUsd;
        totals.baselineUsd += baselineUsd;
        statusTotals.set(sessionId, totals);
      }
      writeSessionStatus(cfg.dataDir, {
        sessionId,
        at: entry.ts,
        mode: cfg.mode,
        incoming: alias ?? original.model,
        model: entry.routed,
        effort: entry.effort,
        incomingEffort: features.incomingEffort,
        alias,
        switched: entry.switched,
        reason: decision.reasons[0] ?? '',
        through: decision.route,
        lastStatus: status,
        ...totals,
      });
    }

    if (decision.route && (decision.switched || features.newUserTurn)) {
      log(
        `[legato] ${original.model} -> ${entry.routed}${entry.effort ? '/' + entry.effort : ''}` +
          `${entry.switched ? ' (switch)' : ''}  ${decision.reasons.join(' | ')}`,
      );
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'GET' && (path === '/legato' || path === '/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(dashboard(stats, cfg));
        return;
      }
      if (req.method === 'GET' && path === '/legato/stats') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ stats: stats.stats, recent: stats.recent.slice(0, 50) }, null, 2));
        return;
      }
      if (req.method === 'GET' && path === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, build: BUILD, pid: process.pid, mode: cfg.mode }));
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
      log(`[legato] error: ${e.stack ?? e.message}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `legato: ${e.message}` } }));
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
      (e) => `<tr><td class="mono">${esc(e.ts.slice(11, 19))}</td><td>${pill(e.routed)}${e.effort ? ` <span class="mono">${esc(e.effort)}</span>` : ''}${e.switched ? ' ⇄' : ''}${e.status >= 400 ? ` <span class="mono">${e.status === CLIENT_CLOSED ? 'closed by client' : e.status}</span>` : ''}</td>
<td>${e.agentType && e.agentType !== 'main' ? `<span class="reasons">${esc(e.agentType)}${e.arm ? ' · arm ' + e.arm : ''}</span> ` : ''}${e.userPreview ? esc(e.userPreview) : '<span class="reasons">tool loop</span>'}<div class="reasons">${esc(e.reasons.join(' · '))}</div></td>
<td class="num">${int(e.promptTokens)}</td><td class="num">${usd(e.costUsd)}</td><td class="num">${usd(e.baselineUsd)}</td></tr>`,
    )
    .join('');
  return page(
    'Legato',
    `<header><h1>Legato</h1><p>Mode <b>${esc(cfg.mode)}</b> · preset <b>${esc(cfg.preset)}</b> · cache TTL ${cfg.cacheTtlSeconds}s · since ${esc(s.startedAt.slice(0, 16).replace('T', ' '))}</p></header>
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
