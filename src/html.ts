/** Shared page chrome for the live dashboard and the analyzer report. No external assets. */

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const usd = (n: number, digits = 2) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(Math.abs(n) < 1 && digits === 2 ? 3 : digits);
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const int = (n: number) => Math.round(n).toLocaleString('en-US');

export const TIER_COLOR: Record<string, string> = {
  haiku: 'var(--haiku)',
  sonnet: 'var(--sonnet)',
  opus: 'var(--opus)',
  fable: 'var(--fable)',
};

const CSS = `
:root{--bg:#f7f6f2;--panel:#ffffff;--ink:#1d1c1a;--muted:#6b6862;--line:#e4e1d9;--accent:#c4562b;
--haiku:#3f8f6b;--sonnet:#3a6fb0;--opus:#8a4fb8;--fable:#b8862f;--good:#2f7d4f;--bad:#b3402f;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151513;--panel:#1e1d1b;--ink:#ecebe6;--muted:#a19d94;--line:#34322e;--accent:#e07a50;
--haiku:#5fbf93;--sonnet:#6f9fdc;--opus:#b884de;--fable:#dcae55;--good:#5cc28a;--bad:#e37766;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#151513;--panel:#1e1d1b;--ink:#ecebe6;--muted:#a19d94;--line:#34322e;--accent:#e07a50;
--haiku:#5fbf93;--sonnet:#6f9fdc;--opus:#b884de;--fable:#dcae55;--good:#5cc28a;--bad:#e37766;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 64px}
header h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}
header p{margin:0;color:var(--muted)}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.card .v{font-size:24px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}
.card .s{color:var(--muted);font-size:13px}
.good{color:var(--good)}.bad{color:var(--bad)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}
section h2{font-size:17px;margin:0 0 4px}
section .sub{color:var(--muted);margin:0 0 14px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:550;font-size:12px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:7px 8px;vertical-align:top;font-variant-numeric:tabular-nums}
td.num,th.num{text-align:right}
.scroll{overflow-x:auto}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--line)}
.bar span{display:block;height:100%}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:13px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff}
.reasons{color:var(--muted);font-size:12.5px}
.note{color:var(--muted);font-size:13px;margin-top:12px}
svg text{fill:var(--muted);font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif}
`;

export function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>${extraHead}</head>
<body><main>${body}</main></body></html>`;
}

export function tierOfModelName(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

export function pill(model: string): string {
  const t = tierOfModelName(model);
  return `<span class="pill" style="background:${TIER_COLOR[t] ?? 'var(--muted)'}">${esc(model.replace(/^claude-/, ''))}</span>`;
}

export function mixBar(counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const order = ['haiku', 'sonnet', 'opus', 'fable', 'other'];
  const segs = order
    .filter((t) => counts[t])
    .map((t) => `<span title="${t}: ${counts[t]}" style="width:${((counts[t]! / total) * 100).toFixed(2)}%;background:${TIER_COLOR[t] ?? 'var(--muted)'}"></span>`)
    .join('');
  const legend = order
    .filter((t) => counts[t])
    .map((t) => `<span><i class="dot" style="background:${TIER_COLOR[t] ?? 'var(--muted)'}"></i>${t} ${pct(counts[t]! / total)}</span>`)
    .join('');
  return `<div class="bar">${segs}</div><div class="legend">${legend}</div>`;
}
