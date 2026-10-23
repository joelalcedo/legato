# Legato

Cache-aware model routing for Claude Code. TypeScript, Node 20+, zero runtime dependencies.

## Commands

- `npm install && npm run build`: compile to `dist/`
- `npm test`: node:test suites via tsx (95 tests)
- `npm run typecheck`
- `npm run demo`: replay the synthetic sample transcripts and write `examples/sample-report.html`
- `node dist/cli.js claude`: start the proxy if needed and launch Claude Code through it as "Dynamic mode" (the user runs this; the auto-mode classifier in this repo's sessions blocks starting servers)
- `node dist/cli.js explain "<prompt>" --context 150000`: inspect one decision
- `node dist/cli.js analyze --since 30d`: replay real `~/.claude/projects` transcripts (about 35s for 30 days); `--json` adds per-task records and the cost series
- `node scripts/video/make-data.mjs analyze.json`, then in `scripts/video`: `npx hyperframes render ...` for the README film and `--composition savings.html` for the savings chart (CONTRIBUTING.md has the full sequence). The session scene replays a real session from the decision log.

## Layout

- `src/engine.ts`: the decision function and cache economics (`decide`, `switchEconomics`, `observe`). Start here.
- `src/words.ts`: every sentence a person sees (model names, money, the classifier's signals in words, the status line clauses, `headline()`). Engine reasons, the status line, `explain`, the proxy log and the dashboard all go through it.
- `src/classifier.ts`: heuristic difficulty classifier, plus `classifyWithModel` (Haiku 5.5, optional).
- `src/features.ts`: signals extracted from a Messages API request (shared by proxy and analyzer): turn detection, errors, agent type from the system prompt, forks, thinking volume.
- `src/rewrite.ts`: applies a decision to a request; appends the turn's effort as an effort-only system message at the tail. It never edits Claude Code's own control message (DESIGN.md, "Setting the effort": an edited copy cost about 11K tokens of cache writes per turn in live traffic).
- `src/sessions.ts`: conversation identity (session id from `metadata.user_id`, forks keyed apart) and on-disk state.
- `src/proxy.ts`: HTTP proxy, SSE usage tap, fail-open, decision log, dashboard, per-session status files.
- `src/stats.ts`: decision log entries, running totals, status files for `legato statusline`.
- `src/analyzer/`: transcript reader (Claude Code 2.1.28x to 2.1.30x formats), replay, text and HTML reports.
- `src/pricing.ts`, `src/models.ts`: prices and model capabilities. Update when models change.
- `docs/DESIGN.md`: derivation of the switching rule. `docs/EVALUATION.md`: results on real data. `docs/REFERENCE.md`: commands, options, limitations. `docs/ROADMAP.md`. `docs/PITCH.md`.
- `.claude/agents/plain-english-reviewer.md`: adversarial reviewer (English teacher and economist) for the README, docs and the CLI's own sentences. Run it after changing anything a person reads.

## Conventions

- The proxy and analyzer must call the same `decide()`; never fork policy logic between them.
- Every decision appends plain sentences to `reasons`, with the numbers in them and the models named as Claude Code names them (`displayName`). No arrows, no jargon ("downshift", "rebuild", "economics", "tier", "hold"), nothing a first-time user would have to look up. The same rule covers the status line, `explain`, the proxy log, the dashboard and the docs.
- Work goes straight to `main`: commit and push, no pull requests to wait on (the user asked for this on 2026-10-22).
- Anything that changes request bytes must be deterministic across requests, or it breaks the prompt cache and can invalidate preserved thinking. Never insert into or reorder the user/assistant history. Add a prefix-stability test for any change to request bytes.
- Savings estimates should err low: when unsure, price tokens as cache writes. Assumptions (effort's effect on output) go on their own labelled line, never in the headline.
- A policy change comes with `analyze --since <fixed date>` before and after, on the same window.
- `report.html` and anything under `~/.legato` contain real prompts; never commit them.

## Claude Code facts the code depends on

- Claude Code attaches a `role: "system"` control message to each user turn, carrying the environment block, `tool_addition` blocks and `output_config.effort` (beta `per-turn-control-2026-07-01`). It is the tail of the turn's first request only: in later requests the loop's assistant and tool-result messages follow it, and Claude Code re-sends it with its own effort. Top-level `output_config.effort` is set on every request as well.
- After every turn Claude Code sends a hidden `[SUGGESTION MODE: …]` request with the whole conversation and the tools, and after idle time a `The user stepped away and is coming back` recap. They arrive as user messages but are not user turns (`MACHINE_TEXT_RE` in `features.ts`); the proxy holds the model and effort for them.
- The `security-guidance` plugin reviews each commit in a separate Agent SDK session (`entrypoint: sdk-py`) with its own session id; it shows up as agent type `agent`.
- `metadata.user_id` is a JSON string with `device_id`, `account_uuid`, `session_id`. Subagents share the session id; the conversation key also hashes the system prompt, the first message and the fork boilerplate position.
- Main-thread system prompts start "You are Claude Code, Anthropic's official CLI for Claude."; subagents start "You are a Claude agent, built on Anthropic's Claude Agent SDK." followed by a type-specific block (see `AGENT_PROMPTS` in `features.ts`).
- On a subscription the main thread caches with `ttl: "1h"`, subagents with the 5-minute default.

## Next steps

See `docs/ROADMAP.md`. First: run the trial on general-purpose subagents live (`--trial general-purpose=claude-sonnet-5-5/high:50`) and compare arms.
