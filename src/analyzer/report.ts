import type { RouterConfig } from '../config.js';
import { esc, int, mixBar, page, pct, pill, usd } from '../html.js';
import type { ReplayResult } from './replay.js';

const day = (t: number) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : 'n/a');

export function textReport(r: ReplayResult, cfg: RouterConfig, source: string): string {
  const t = r.totals;
  const saved = t.baselineUsd - t.routedUsd;
  const mixTotal = Object.values(t.tierMix).reduce((a, b) => a + b, 0) || 1;
  const mix = Object.entries(t.tierMix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${pct(v / mixTotal)}`)
    .join(', ');
  const lines = [
    '',
    `Switchyard replay: ${source}`,
    `  ${t.conversations} sessions, ${t.subagents} subagent runs, ${int(t.requests)} API requests, ${int(t.userTurns)} user turns (${day(t.start)} to ${day(t.end)})`,
    `  preset ${cfg.preset}, cache TTL ${cfg.cacheTtlSeconds}s, tiers ${cfg.enabledTiers.map((x) => cfg.tiers[x]).join(' / ')}`,
    '',
    `  Actual bill (list prices)          ${usd(t.actualUsd).padStart(10)}`,
    `  Same traffic, current models       ${usd(t.baselineUsd).padStart(10)}   (no routing)`,
    `  With Switchyard                    ${usd(t.routedUsd).padStart(10)}   saves ${usd(saved)} (${pct(t.baselineUsd ? saved / t.baselineUsd : 0)})`,
    '',
    `  Model mix with routing: ${mix}`,
    `  Model switches: ${t.switches} (${t.freeSwitches} at free cache boundaries), cache rebuilds paid: ${usd(t.rebuildUsd)}`,
    `  Downshifts declined because the rebuild cost more than it saved: ${t.heldDownshifts}`,
    `  Per-turn effort changes (cache-safe): ${t.effortChanges}  (their output savings are not counted above)`,
  ];
  if (r.unpricedModels.length) lines.push(`  Unpriced models skipped: ${r.unpricedModels.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function chart(series: ReplayResult['series']): string {
  if (series.length < 2) return '<p class="note">Not enough requests to chart.</p>';
  const W = 960;
  const H = 260;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const max = Math.max(...series.map((p) => p.baseline), ...series.map((p) => p.routed)) || 1;
  // Plot against request index so idle gaps between sessions don't flatten the curve.
  const n = series.length - 1;
  const x = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const step = Math.max(1, Math.floor(series.length / 600));
  const path = (key: 'baseline' | 'routed') =>
    series
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => i % step === 0 || i === n)
      .map(({ p, i }) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--line)"/>
<text x="${pad.l - 8}" y="${y(max * f) + 4}" text-anchor="end">${usd(max * f)}</text>`)
    .join('');
  const last = series[n]!;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cumulative cost, unrouted versus routed">
${ticks}
<path d="${path('baseline')}" fill="none" stroke="var(--opus)" stroke-width="2.2"/>
<path d="${path('routed')}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>
<text x="${W - pad.r - 4}" y="${Math.max(pad.t + 12, y(last.baseline) - 6)}" text-anchor="end">unrouted ${usd(last.baseline)}</text>
<text x="${W - pad.r}" y="${y(last.routed) + 16}" text-anchor="end">routed ${usd(last.routed)}</text>
<text x="${pad.l}" y="${H - 6}">first request</text><text x="${W - pad.r}" y="${H - 6}" text-anchor="end">request ${int(n + 1)}</text>
</svg>
<div class="legend"><span><i class="dot" style="background:var(--opus)"></i>Unrouted (current models)</span><span><i class="dot" style="background:var(--accent)"></i>Switchyard</span></div>`;
}

export function htmlReport(r: ReplayResult, cfg: RouterConfig, source: string, synthetic: boolean): string {
  const t = r.totals;
  const saved = t.baselineUsd - t.routedUsd;
  const notable = r.notable
    .filter((n) => n.kind !== 'effort')
    .slice(0, 40)
    .map(
      (n) => `<tr><td>${n.kind === 'switch' ? `${pill(n.from)} → ${pill(n.to)}` : `held ${pill(n.from)}`}${n.effort ? ` <span class="mono">${esc(n.effort)}</span>` : ''}</td>
<td>${esc(n.userText || '(tool loop)')}<div class="reasons">${esc(n.reasons.join(' · '))}</div></td><td class="num">${int(n.promptTokens)}</td></tr>`,
    )
    .join('');
  const convRows = r.conversations
    .slice(0, 50)
    .map((c) => {
      const s = c.baselineUsd - c.routedUsd;
      return `<tr><td class="mono">${esc(c.id.slice(0, 28))}${c.isSubagent ? ' <span class="reasons">subagent</span>' : ''}</td>
<td class="num">${int(c.userTurns)}</td><td class="num">${int(c.requests)}</td><td class="num">${int(c.switches)}</td>
<td class="num">${usd(c.baselineUsd)}</td><td class="num">${usd(c.routedUsd)}</td><td class="num ${s >= 0 ? 'good' : 'bad'}">${usd(s)}</td></tr>`;
    })
    .join('');

  const banner = synthetic
    ? `<section><h2>Sample data</h2><p class="sub">These sessions are synthetic transcripts generated by <code>scripts/make-sample-transcripts.ts</code> to exercise the analyzer. Run <code>switchyard analyze</code> on your own <code>~/.claude/projects</code> to see real numbers.</p></section>`
    : '';

  return page(
    'Switchyard Replay',
    `<header><h1>Switchyard replay report</h1>
<p>${esc(source)} · ${t.conversations} sessions, ${t.subagents} subagent ${t.subagents === 1 ? 'run' : 'runs'}, ${int(t.requests)} API requests · ${day(t.start)} to ${day(t.end)} · preset <b>${esc(cfg.preset)}</b>, cache TTL ${cfg.cacheTtlSeconds}s</p></header>
${banner}
<div class="cards">
<div class="card"><div class="k">Unrouted</div><div class="v">${usd(t.baselineUsd)}</div><div class="s">same traffic on current models</div></div>
<div class="card"><div class="k">With Switchyard</div><div class="v">${usd(t.routedUsd)}</div><div class="s">cache rebuilds included</div></div>
<div class="card"><div class="k">Saved</div><div class="v ${saved >= 0 ? 'good' : 'bad'}">${pct(t.baselineUsd ? saved / t.baselineUsd : 0)}</div><div class="s">${usd(saved)} at API list prices</div></div>
<div class="card"><div class="k">Model switches</div><div class="v">${int(t.switches)}</div><div class="s">${int(t.freeSwitches)} free · ${usd(t.rebuildUsd)} rebuilds</div></div>
<div class="card"><div class="k">Downshifts declined</div><div class="v">${int(t.heldDownshifts)}</div><div class="s">rebuild would cost more than it saves</div></div>
</div>
<section><h2>Cumulative cost</h2><p class="sub">Every request in time order, unrouted versus routed.</p>${chart(r.series)}</section>
<section><h2>Model mix with routing</h2><p class="sub">Share of API requests per tier, tool-loop steps included.</p>${mixBar(t.tierMix)}</section>
<section><h2>What the router decided</h2><p class="sub">Model switches and declined downshifts, with the reasoning the engine logged.</p>
<div class="scroll"><table><tr><th>Decision</th><th>User turn and reasoning</th><th class="num">Prompt tokens</th></tr>${notable || '<tr><td colspan="3">No switches.</td></tr>'}</table></div></section>
<section><h2>Sessions</h2><p class="sub">Most expensive first.</p><div class="scroll"><table>
<tr><th>Session</th><th class="num">Turns</th><th class="num">Requests</th><th class="num">Switches</th><th class="num">Unrouted</th><th class="num">Routed</th><th class="num">Saved</th></tr>${convRows}</table></div></section>
<section><h2>How to read this</h2><p class="sub">The replay runs the same decision engine as the live proxy over each recorded request.
Token counts are the measured ones; on a model switch, cached tokens the new model hadn't seen are re-priced as cache writes.
Output length is held constant across models, and savings from lower effort aren't counted, so the estimate errs low on cost savings.
The replay can't measure answer quality; validate a preset in shadow mode, then live, before relying on it.</p></section>`,
  );
}
