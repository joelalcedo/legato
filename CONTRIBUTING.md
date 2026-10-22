# Contributing

```bash
npm install
npm run build      # tsc, into dist/
npm test           # node:test suites via tsx
npm run typecheck
npm run demo       # replay the synthetic samples, write examples/sample-report.html
```

## Rules the code follows

- One `decide()`. The proxy and the analyzer call the same decision function with the same
  `extractFeatures()`. A policy change goes in `src/engine.ts`, `src/classifier.ts` or
  `src/features.ts`, never in the proxy or the replay.
- Plain sentences, with the numbers in them. Every reason, status line and log line is built in
  `src/words.ts`. Say "a switch to Sonnet 5.5 would cost $0.95 more than it saves", never
  "downshift held" or an arrow. If a first-time user would have to look a word up, it is wrong.
- Request bytes are deterministic. Anything that changes a request must produce the same
  bytes for the same history on every request, or it breaks the prompt cache and can invalidate
  preserved thinking. Add a prefix-stability test (see `test/proxy.test.ts`) for any such change.
- Savings err low. When unsure how a token would have been billed, price it as a cache write.
  Assumptions that cannot be measured (effort's effect on output length) are reported on their
  own line, never in the headline.
- Measure on real data before changing policy. `legato analyze --since <date>` before and
  after, same window, and put both numbers in the commit message.
- After changing anything a person reads, run the `plain-english-reviewer` agent in
  `.claude/agents/` over it and act on what it finds.

## The README charts

`scripts/charts.R` draws both charts from the output of `legato analyze --since <date> --json`.
That JSON holds the first words of real prompts, so it stays out of the repository; only the PNGs
in `docs/img/` go in. Needs R with ggplot2, dplyr, tidyr, jsonlite, scales and ggrepel.

```bash
legato analyze --since 2026-09-21 --json > /tmp/analyze.json
Rscript scripts/charts.R /tmp/analyze.json docs/img
```

## The demo video

`docs/demo.gif` and `docs/demo.mp4` are rendered from `scripts/video`, a [HyperFrames](https://github.com/heygen-com/hyperframes)
composition: HTML and GSAP, rendered frame by frame in headless Chrome, so every render is the same.
The session scene replays a real Legato session from the decision log (the models, the effort,
the rebuild cost and the savings are the logged numbers; the assistant's replies are abridged), and
the chart scene draws the cumulative series from `legato analyze --json`.

```bash
cd scripts/video
npx hyperframes check --json            # lint, layout, motion
npx hyperframes snapshot --at 9,20,34,50  # look before rendering
npx hyperframes render --quality looks --output ../../docs/demo.mp4
ffmpeg -y -i ../../docs/demo.mp4 -vf "fps=12,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" ../../docs/demo.gif
```

Needs Node 22+ and ffmpeg. To change the session, edit the lines and the timings in
`compositions/session.html`; to refresh the chart, regenerate `compositions/series.js` from the
`series` field of `analyze --json` (300 points is plenty).

## Reporting a transcript the reader gets wrong

Run `legato analyze --since 7d --json` and look for a conversation whose request count
or costs look off; then open an issue with the shape of the lines involved (types, roles,
`parentUuid` chain), not their content. The reader is tested against shapes taken from real
Claude Code transcripts in `test/analyzer.test.ts`.
