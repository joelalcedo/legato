# Switchyard

Cache-aware model routing for Claude Code. TypeScript, Node 20+, zero runtime dependencies.

## Commands

- `npm install && npm run build` — compile to `dist/`
- `npm test` — node:test suites via tsx (43 tests)
- `npm run typecheck`
- `npm run demo` — replay the synthetic sample transcripts and write `examples/sample-report.html`
- `node dist/cli.js explain "<prompt>" --context 150000` — inspect one decision

## Layout

- `src/engine.ts` — the decision function and cache economics (`decide`, `switchEconomics`, `observe`). Start here.
- `src/classifier.ts` — heuristic difficulty classifier; the intended swap-in point for a learned router.
- `src/features.ts` — signals extracted from a Messages API request (shared by proxy and analyzer).
- `src/rewrite.ts` — applies a decision to a request; per-message effort ledger.
- `src/proxy.ts` — HTTP proxy, SSE usage tap, fail-open, dashboard.
- `src/analyzer/` — transcript reader, replay, text and HTML reports.
- `src/pricing.ts`, `src/models.ts` — prices and model capabilities. Update when models change.
- `docs/DESIGN.md` — derivation of the switching rule. `docs/PITCH.md` — the pitch.

## Conventions

- The proxy and analyzer must call the same `decide()`; never fork policy logic between them.
- Every decision appends human-readable strings to `reasons`; keep them specific (numbers, not adjectives).
- Anything that changes request bytes must be deterministic across requests, or it breaks the prompt cache. Add a prefix-stability test for it.
- Savings estimates should err low: when unsure, price tokens as cache writes.

## Next steps

1. Run `node dist/cli.js analyze --since 30d --html report.html` on real `~/.claude/projects` data and sanity-check the decisions table.
2. Try the proxy in `--mode shadow` against a real Claude Code session, then live.
3. Replace or augment the heuristic classifier (Haiku 5.5 call or a RouteLLM-style model) behind `classify()`.
4. Push to GitHub: `git remote add origin <url> && git push -u origin main`.
