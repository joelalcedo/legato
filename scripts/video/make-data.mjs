// Turn `legato analyze --since <date> --json` into the two data files the film reads.
// Usage: node scripts/video/make-data.mjs /tmp/analyze.json
// The JSON holds the first words of real prompts, so it stays out of the repository; the two
// files written here hold only timestamps, dollar totals and task-kind summaries.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/video/make-data.mjs analyze.json');
  process.exit(1);
}
const d = JSON.parse(readFileSync(src, 'utf8'));
const out = join(dirname(fileURLToPath(import.meta.url)), 'compositions');

// the cumulative series, about 300 points, first and last kept
const ser = d.series;
const step = Math.max(1, Math.floor(ser.length / 300));
const pts = ser.filter((_, i) => i % step === 0);
if (pts[pts.length - 1] !== ser[ser.length - 1]) pts.push(ser[ser.length - 1]);
writeFileSync(join(out, 'series.js'), 'const SERIES = ' + JSON.stringify(pts.map((p) => [Math.round(p.t / 1000), +p.baseline.toFixed(2), +p.routed.toFixed(2)])) + ';\n');

// tasks by kind, as the analyzer groups them; kinds with fewer than 15 tasks or under $10 either way are left out
// short names for the charts; the analyzer's full names stay in its own table
const LABELS = {
  'No clear signal (stays put, effort one step down)': 'No clear signal',
  'Quick task (commit, find a file, a greeting)': 'Quick task',
  'A "yes, go ahead"': 'A "yes, go ahead"',
};
const kinds = d.byKind
  .filter((k) => k.tasks >= 15 && Math.abs(k.savedUsd) >= 10 && k.kind !== 'Other subagent run')
  .map((k) => ({ kind: k.kind, label: LABELS[k.kind] ?? k.kind, tasks: k.tasks, without: +k.meanBaselineUsd.toFixed(2), with: +k.meanRoutedUsd.toFixed(2), total: Math.round(k.savedUsd) }));
const totals = {
  without: Math.round(d.totals.baselineUsd),
  with: Math.round(d.totals.routedUsd),
  tasks: d.turns.length,
  shown: kinds.reduce((a, k) => a + k.tasks, 0),
  sessions: d.totals.conversations,
  subagents: d.totals.subagents,
  requests: d.totals.requests,
  from: new Date(d.totals.start).toISOString().slice(0, 10),
  to: new Date(d.totals.end).toISOString().slice(0, 10),
};
const kindsJs = 'const KINDS = ' + JSON.stringify(kinds) + ';\nconst TOTALS = ' + JSON.stringify(totals) + ';\n';
writeFileSync(join(out, 'kinds.js'), kindsJs);
writeFileSync(join(out, '..', '..', 'savings-chart', 'kinds.js'), kindsJs);
console.log('wrote', join(out, 'series.js'), 'and', join(out, 'kinds.js'));
for (const k of kinds) console.log(` ${k.kind.padEnd(44)} ${String(k.tasks).padStart(4)} tasks  $${k.without.toFixed(2)} -> $${k.with.toFixed(2)}  total $${k.total}`);
