# Contributing

```bash
npm install
npm run build      # tsc -> dist/
npm test           # node:test suites via tsx
npm run typecheck
npm run demo       # replay the synthetic samples, write examples/sample-report.html
```

## Rules the code follows

- **One `decide()`.** The proxy and the analyzer call the same decision function with the same
  `extractFeatures()`. A policy change goes in `src/engine.ts`, `src/classifier.ts` or
  `src/features.ts`, never in the proxy or the replay.
- **Reasons with numbers.** Every decision appends human-readable strings to `reasons`. Say
  "rebuild $0.97 on 387K tokens", not "large context".
- **Request bytes are deterministic.** Anything that changes a request must produce the same
  bytes for the same history on every request, or it breaks the prompt cache and can invalidate
  preserved thinking. Add a prefix-stability test (see `test/proxy.test.ts`) for any such change.
- **Savings err low.** When unsure how a token would have been billed, price it as a cache write.
  Assumptions that can't be measured (effort's effect on output length) are reported on their
  own line, never in the headline.
- **Measure on real data before changing policy.** `switchyard analyze --since 30d` before and
  after, same window, and put both numbers in the PR.

## Recording the demo

The README links `docs/demo.gif`. It has to come from a real session, so it is recorded by hand:

```bash
brew install asciinema agg          # agg renders a .cast to a gif
asciinema rec docs/demo.cast         # then: switchyard; an easy prompt, a hard one, exit
agg --cols 100 --rows 30 docs/demo.cast docs/demo.gif
```

Show the header (`Dynamic mode`), one cheap turn landing on Haiku, one hard turn staying on Opus, and the status line changing between them. Keep it under 40 seconds and don't type anything private.

## Reporting a transcript the reader gets wrong

Run `switchyard analyze --since 7d --json` and look for a conversation whose request count
or costs look off; then open an issue with the shape of the lines involved (types, roles,
`parentUuid` chain), not their content. The reader is tested against shapes taken from real
Claude Code transcripts in `test/analyzer.test.ts`.
