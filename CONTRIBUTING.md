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

## The demo video

`docs/demo.gif`, `docs/demo.mp4` and `docs/savings.gif` are rendered with
[HyperFrames](https://github.com/heygen-com/hyperframes): HTML and GSAP, rendered frame by frame in
headless Chrome, so every render is the same. `scripts/video` is the 62-second film;
`scripts/savings-chart` is the 12-second chart of what a task costs with and without Legato.
The session scene replays a real session from the decision log: the prompts, token counts and
timings are the logged ones, and the routing and the savings are that session run through today's
router at list prices, with the cold-cache rebuild of the Opus turn charged. The assistant's replies
are abridged. The chart scene and the savings chart read `compositions/series.js` and
`compositions/kinds.js`, which `make-data.mjs` writes from `legato analyze --json`. That JSON holds
the first words of real prompts, so it stays out of the repository; the data files hold only
timestamps, dollar totals and the by-kind summary (`kinds.js` is written to both projects).

```bash
legato analyze --since 2026-09-21 --json > /tmp/analyze.json
node scripts/video/make-data.mjs /tmp/analyze.json
cd scripts/video
npx hyperframes check --json                       # lint, layout, motion
npx hyperframes snapshot --at 9,20,34,50           # look before rendering
npx hyperframes render --quality looks --output ../../docs/demo.mp4
cd ../savings-chart && npx hyperframes render --quality looks --output ../../docs/savings.mp4 && cd ../video
GIF='fps=12,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
ffmpeg -y -i ../../docs/demo.mp4 -vf "$GIF" ../../docs/demo.gif
ffmpeg -y -i ../../docs/savings.mp4 -vf "$GIF" ../../docs/savings.gif
```

Needs Node 22+ and ffmpeg. To change the session, edit the lines and the timings in
`compositions/session.html`. The numbers quoted in the README come from the same `analyze` run;
its text report prints the by-kind table.

## The diagrams

The three diagrams in the README's "How it works" are hand-drawn SVG in `docs/diagrams/*.html`,
following [diagram-design](https://github.com/cathrynlavery/diagram-design): Geist type,
orthogonal connectors with rounded elbows, one accent per diagram, no shadows, nothing in the
picture that the sentence before it does not need. Each file carries light and dark tokens, and
`scripts/diagrams/render.mjs` screenshots the SVG twice, at 2x, into `docs/diagrams/<name>-light.png`
and `<name>-dark.png`; the README picks one with a `<picture>` element. The cost chart's points are
the engine's own numbers: `switchEconomics` for Opus to Sonnet at 40K and 180K tokens of context,
with the default 2K tokens of growth and 1.2K of output per request, at 5-minute cache prices.

```bash
cd scripts/diagrams && npm install && npx playwright-core install chromium   # once
node render.mjs                                   # every diagram, or: node render.mjs decision
```

`LEGATO_CHROME=/path/to/chrome` uses a browser that is already installed instead. From a checkout
of diagram-design, `python3 scripts/verify-geometry.py docs/diagrams/<name>.html` checks the
connector rules and `python3 skills/diagram-design/scripts/self_check.py` the accessible-SVG contract.

## Reporting a transcript the reader gets wrong

Run `legato analyze --since 7d --json` and look for a conversation whose request count
or costs look off; then open an issue with the shape of the lines involved (types, roles,
`parentUuid` chain), not their content. The reader is tested against shapes taken from real
Claude Code transcripts in `test/analyzer.test.ts`.
