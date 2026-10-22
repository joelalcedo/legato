#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlReport, textReport } from './analyzer/report.js';
import { replay } from './analyzer/replay.js';
import { loadConversations } from './analyzer/transcripts.js';
import { loadConfig, resolveAlias, type Mode, type Preset, type RouterConfig } from './config.js';
import { decide, newState } from './engine.js';
import { extractFeatures, type MessagesRequest } from './features.js';
import { usd } from './html.js';
import type { Effort } from './models.js';
import { BUILD, startProxy } from './proxy.js';
import { displayName, formatStatus, readSessionStatus, readStats } from './stats.js';

const HELP = `switchyard: cache-aware model routing for Claude Code

Usage
  switchyard claude [any claude arguments]
      The normal way to run. Starts the proxy if it isn't running, then launches Claude Code
      through it as "Dynamic mode": the header says so, and the status line says which model
      and effort each turn actually ran on. Arguments go to claude unchanged (e.g. --resume).

  switchyard start [--port 8787] [--mode live|shadow] [--preset balanced] [--ttl 300]
                   [--classifier heuristic|haiku] [--trial <agentType>=<model>[/<effort>][:<share%>]]
      Run the proxy by itself (shadow mode decides and logs but forwards every request as
      sent). Then, in another terminal, "switchyard claude", or by hand:
        ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --model "Dynamic mode"
      "Dynamic mode" is an alias the proxy resolves (modelAliases in config.json; default:
      route up to Opus 5.5). A real model name works too and becomes the ceiling.
      Dashboard: http://127.0.0.1:8787/switchyard
      --classifier haiku asks Haiku 5.5 to classify each user turn (needs ANTHROPIC_API_KEY).
      --trial general-purpose=claude-sonnet-5-5/high:50 routes half of those subagents to
      Sonnet and logs the arm, so the two halves can be compared.

  switchyard analyze [--dir ~/.claude/projects] [--since 30d] [--preset balanced]
                     [--ttl 300] [--html report.html] [--json] [--keep-models]
      Replay your Claude Code transcripts through the router and report what it
      would have cost, with cache rebuilds priced in.

  switchyard explain "<prompt>" [--context 120000] [--current claude-opus-5-5] [--idle 30]
      Show the decision the engine makes for one user turn.

  switchyard stats        Print totals from the running or last proxy session.
  switchyard statusline   One line for Claude Code's statusLine setting: the model and effort this
                          session is running on, and what the routing has saved. Add to settings.json:
                          "statusLine": {"type": "command", "command": "switchyard statusline"}

Presets: conservative (never below Sonnet), balanced (default), aggressive.
Per-turn override: start a prompt with //h, //s, //o or //f to force Haiku, Sonnet, Opus or Fable.
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[k!] = inline;
      else if (next !== undefined && !next.startsWith('--')) {
        flags[k!] = next;
        i++;
      } else flags[k!] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function overridesFrom(flags: Record<string, string | boolean>): Partial<RouterConfig> {
  const o: Partial<RouterConfig> = {};
  if (str(flags.preset)) o.preset = str(flags.preset) as Preset;
  if (str(flags.mode)) o.mode = str(flags.mode) as Mode;
  if (str(flags.port)) o.port = Number(flags.port);
  if (str(flags.host)) o.host = str(flags.host)!;
  if (str(flags.ttl)) {
    o.cacheTtlSeconds = Number(flags.ttl);
    o.detectCacheTtl = false;
  }
  if (str(flags.upstream)) o.upstream = str(flags.upstream)!;
  if (str(flags['data-dir'])) o.dataDir = resolve(str(flags['data-dir'])!);
  if (flags['no-effort']) o.routeEffort = false;
  if (flags.fable) o.enabledTiers = ['haiku', 'sonnet', 'opus', 'fable'];
  if (str(flags.classifier)) o.classifier = str(flags.classifier) as RouterConfig['classifier'];
  if (str(flags.trial)) o.trial = parseTrial(str(flags.trial)!);
  return o;
}

/** general-purpose=claude-sonnet-5-5/high:50 -> route half of those agents to Sonnet at high effort. */
function parseTrial(v: string): RouterConfig['trial'] {
  const m = /^([^=]+)=([^/:]+)(?:\/([a-z]+))?(?::(\d+))?$/.exec(v);
  if (!m) throw new Error(`--trial expects <agentType>=<model>[/<effort>][:<share%>], got ${v}`);
  return { agentType: m[1]!, model: m[2]!, effort: m[3] as Effort | undefined, share: m[4] ? Number(m[4]) / 100 : 0.5 };
}

function readStdinJson(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseSince(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--since expects e.g. 30d, 12h or a date, got ${v}`);
  return t;
}

interface ProxyHealth {
  build?: string;
  pid?: number;
  mode?: string;
}

async function probeProxy(url: string): Promise<ProxyHealth | undefined> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(700) });
    if (!r.ok) return undefined;
    const text = await r.text();
    try {
      return JSON.parse(text) as ProxyHealth;
    } catch {
      return {}; // a build from before the health endpoint returned JSON
    }
  } catch {
    return undefined;
  }
}

/**
 * `switchyard claude`: make sure the proxy is up, then run Claude Code through it under the
 * launch alias. The alias is a model name Claude Code doesn't know, so the environment also
 * tells Claude Code the real context window and the features the ceiling model supports;
 * otherwise it assumes 200K and warns on every start.
 */
async function launchClaude(cfg: RouterConfig, args: string[]): Promise<void> {
  const url = `http://127.0.0.1:${cfg.port}`;
  let health = await probeProxy(url);
  if (!health) {
    mkdirSync(cfg.dataDir, { recursive: true });
    const logPath = join(cfg.dataDir, 'proxy.log');
    const fd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    for (let i = 0; i < 40 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await probeProxy(url);
    }
    if (!health) throw new Error(`the proxy did not come up on ${url}; see ${logPath}`);
    process.stderr.write(`switchyard: proxy started on ${url} (${cfg.mode} mode, log ${logPath})\n`);
  } else if (health.build !== BUILD) {
    process.stderr.write(
      `switchyard: the proxy on ${url} is running an older build${health.pid ? ` (pid ${health.pid})` : ''}. ` +
        `Stop it and run this again to use the new code.\n`,
    );
  }

  const ceiling = resolveAlias(cfg, cfg.launchModel) ?? cfg.launchModel;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: url,
    // Claude Code can't know the alias's window; the ceiling model's is 1M.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '1000000',
    // Puts the alias in the /model picker under its own name, with effort and thinking enabled.
    ANTHROPIC_CUSTOM_MODEL_OPTION: cfg.launchModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: cfg.launchModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: `Switchyard picks the model for each turn, up to ${displayName(ceiling)}`,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: 'effort,xhigh_effort,thinking,adaptive_thinking,interleaved_thinking',
  };
  const claudeArgs = args.includes('--model') ? args : ['--model', cfg.launchModel, ...args];
  const claude = spawn('claude', claudeArgs, { stdio: 'inherit', env });
  claude.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(err.code === 'ENOENT' ? 'switchyard: `claude` is not on your PATH\n' : `switchyard: ${err.message}\n`);
    process.exit(1);
  });
  claude.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'claude': {
      await launchClaude(loadConfig(), rest);
      return;
    }

    case 'start':
    case 'proxy': {
      const cfg = loadConfig(overridesFrom(flags));
      const p = await startProxy({ cfg });
      process.stderr.write(
        `switchyard ${cfg.mode} on ${p.url} -> ${cfg.upstream} (preset ${cfg.preset}, TTL ${cfg.cacheTtlSeconds}s)\n` +
          `  run:        switchyard claude   (or ANTHROPIC_BASE_URL=${p.url} claude --model "${cfg.launchModel}")\n` +
          `  dashboard:  ${p.url}/switchyard\n`,
      );
      const stop = () => p.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }

    case 'analyze': {
      const cfg = loadConfig(overridesFrom(flags));
      const dir = resolve(str(flags.dir) ?? join(homedir(), '.claude', 'projects'));
      const since = parseSince(str(flags.since));
      const convs = loadConversations(dir, { modifiedSince: since });
      if (!convs.length) {
        process.stderr.write(`No Claude Code transcripts with usage found under ${dir}\n`);
        process.exitCode = 1;
        return;
      }
      const result = replay(convs, cfg, {
        normalizeGeneration: !flags['keep-models'],
        since,
      });
      if (flags.json) {
        process.stdout.write(JSON.stringify({ totals: result.totals, conversations: result.conversations, notable: result.notable.slice(0, 200) }, null, 2) + '\n');
      } else {
        process.stdout.write(textReport(result, cfg, dir) + '\n');
      }
      const html = str(flags.html);
      if (html) {
        const synthetic = /sample-transcripts/.test(dir);
        writeFileSync(html, htmlReport(result, cfg, dir, synthetic));
        process.stderr.write(`Report written to ${resolve(html)}\n`);
      }
      return;
    }

    case 'explain': {
      const cfg = loadConfig(overridesFrom(flags));
      const prompt = positional.join(' ');
      if (!prompt) throw new Error('explain needs a prompt, e.g. switchyard explain "rename foo to bar"');
      const current = str(flags.current) ?? cfg.tiers.opus;
      const ctx = Number(str(flags.context) ?? 60_000);
      const idle = Number(str(flags.idle) ?? 30);
      const now = Date.now();
      const state = newState();
      state.model = current;
      state.lastPromptTokens = ctx;
      state.lastRequestAt = now - idle * 1000;
      state.modelCache[current] = { at: now - idle * 1000, promptTokens: ctx };
      const req: MessagesRequest = {
        model: str(flags.incoming) ?? current,
        tools: [{}],
        messages: [
          { role: 'user', content: 'earlier turn' },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          { role: 'user', content: prompt },
        ],
      };
      const d = decide({ req, features: extractFeatures(req), state, cfg, now, contextTokens: ctx });
      process.stdout.write(
        `${current} -> ${d.model}${d.effort ? ' / effort ' + d.effort : ''}${d.switched ? '  (switch)' : ''}\n` +
          d.reasons.map((r) => `  - ${r}`).join('\n') +
          '\n' +
          (d.economics
            ? `  economics: context ${d.economics.contextTokens} tokens, rebuild ${usd(d.economics.rebuildUsd)}, ` +
              `saving ${usd(d.economics.perRequestSavingUsd, 4)}/request, net ${usd(d.economics.netUsd)}\n`
            : ''),
      );
      return;
    }

    case 'stats': {
      const cfg = loadConfig(overridesFrom(flags));
      const s = readStats(cfg.dataDir);
      if (!s) {
        process.stdout.write(`No stats yet in ${cfg.dataDir}\n`);
        return;
      }
      const saved = s.baselineUsd - s.costUsd;
      process.stdout.write(
        `since ${s.startedAt}\n  requests ${s.requests} (${s.routed} routed), switches ${s.switches}, effort changes ${s.effortChanges}, fail-opens ${s.failOpens}\n` +
          `  cost ${usd(s.costUsd)} vs ${usd(s.baselineUsd)} unrouted, saved ${usd(saved)}\n` +
          Object.entries(s.byModel)
            .map(([m, v]) => `  ${m.padEnd(22)} ${String(v.requests).padStart(6)} requests  ${usd(v.costUsd)}`)
            .join('\n') +
          '\n',
      );
      return;
    }

    case 'statusline': {
      const cfg = loadConfig(overridesFrom(flags));
      // Claude Code pipes its session JSON in; the proxy writes one status file per session id.
      const input = readStdinJson();
      const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
      const status = sessionId ? readSessionStatus(cfg.dataDir, sessionId) : undefined;
      if (status) {
        process.stdout.write(formatStatus(status) + '\n');
        return;
      }
      // A session the proxy has never seen must not borrow other sessions' numbers.
      if (sessionId) {
        process.stdout.write('⇄ switchyard: this session is not going through the proxy\n');
        return;
      }
      const s = readStats(cfg.dataDir);
      if (!s || !s.last) {
        process.stdout.write('⇄ switchyard idle\n');
        return;
      }
      const saved = s.baselineUsd - s.costUsd;
      const share = s.baselineUsd > 0 ? ` (${((saved / s.baselineUsd) * 100).toFixed(0)}%)` : '';
      process.stdout.write(`⇄ all sessions: last ${displayName(s.last.routed)}${s.last.effort ? ' · ' + s.last.effort : ''} · saved ${usd(saved)}${share}\n`);
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`switchyard: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
