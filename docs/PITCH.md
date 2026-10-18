# Pitch: cache-aware routing for Claude Code

**One line:** Claude Code should pick the model per turn, the way Copilot and Cursor now do, but only switch models when the prompt-cache math says it pays, and use cache-safe per-message effort as the free knob in between. Switchyard is a working implementation of that policy.

## The problem

- Every turn of a session runs on one model. On plans that default to Opus, renames, commits and acknowledgements run on Opus too.
- It's the most-requested class of feature in the Claude Code tracker: #27665 consolidates 30+ duplicates; #44976, #67898, #31464 and #39551 ask for the same thing; #69530 was closed as not planned.
- Competitors shipped it: GitHub Copilot's Auto routes by task and states it routes along natural cache boundaries; Cursor's Auto is its default.

## Why it hasn't been done naively

Each model has its own cache. Switching mid-conversation re-reads everything uncached. On Opus/Sonnet 5.5 a cache write costs 25x a read, so per-turn routing on a long session can increase cost. Existing knobs (`opusplan`, advisor, subagent frontmatter, fallback chains) sidestep this by being coarse.

## The policy

1. **Effort every turn, free.** Per-message effort keeps the cache on the 5.5 models. Lower it for mechanical turns, raise it for hard ones.
2. **Model at cache boundaries.** Switch freely when there's no cache to lose: new conversations, every subagent, after TTL expiry, small contexts. Otherwise downshift only when `savings × expected run − rebuild − expected return cost` is positive. Upgrade for quality whenever the turn is clearly hard, the user is in plan mode, or the previous task kept failing.
3. **Signals from the transcript, not just the prompt.** Failed tool runs escalate the next turn; plan mode floors at Opus.

## What's built

- A decision engine with logged reasons for every choice.
- A local proxy (`ANTHROPIC_BASE_URL`) that applies it live, with shadow mode, fail-open retries and a dashboard.
- A replay analyzer that runs any user's `~/.claude/projects` transcripts through the same engine and reports the cost with routing, rebuilds included. This is the cheapest way to evaluate the policy on real usage: zero quality risk, real token counts.
- 43 tests, including end-to-end proxy tests that verify the request prefix stays byte-identical across a tool loop after an effort change.

## Asks

1. Run `switchyard analyze` across internal dogfooding transcripts to size the opportunity on real sessions.
2. Feedback on the policy, especially whether a native version could share system-prompt and tool-definition cache across models, which would remove most of the switching penalty.
3. A path to a native `model: "auto"` in Claude Code, with the routed model visible in the UI and per-turn override.

## Demo script (5 minutes)

1. `switchyard analyze --since 30d --html report.html` on a real account; open the report.
2. `switchyard explain "add a loading state" --context 180000` vs `--context 25000`: same prompt, opposite decisions, with the arithmetic shown.
3. Live session through the proxy with the dashboard open: a rename drops to Haiku, a "why does this break" question goes to Opus, a typo on a huge context drops to Haiku but a medium task on that same context holds Opus and lowers effort instead.
