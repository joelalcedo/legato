# Pitch: cache-aware routing for Claude Code

In one line: Claude Code should pick the model per turn, the way Copilot and Cursor now do, but only switch models when the prompt-cache math says it pays, and use per-turn effort as the free knob in between. Legato is a working implementation of that policy, evaluated on a real account's history.

## The problem

- Every turn of a session runs on one model. On plans that default to Opus, renames, commits and acknowledgements run on Opus too, and so does every step of every subagent.
- It's the most-requested class of feature in the Claude Code tracker: #27665 consolidates 30+ duplicates; #44976, #67898, #31464 and #39551 ask for the same thing; #69530 was closed as not planned.
- Competitors shipped it: GitHub Copilot's Auto routes by task and states it routes along natural cache boundaries; Cursor's Auto is its default.

## Why it hasn't been done naively

Each model has its own cache. Switching mid-conversation re-reads everything uncached. On Opus/Sonnet 5.5 a cache write costs 25x a read, so per-turn routing on a long session can increase cost. The first version of this very router did: 2.9% saved, $752 paid in rebuilds. Existing knobs (`opusplan`, advisor, subagent frontmatter, fallback chains) sidestep the problem by being coarse.

## What the data says

Replayed on 30 days of one developer's real Claude Code history (267 sessions, 443 subagent runs, 51.9K API requests, $5.1K at list prices), cache rebuilds priced in:

- Cache-aware routing cuts cost 10.2% ($529 of $5,166) on the latest month; 12.7% in a month that included Fable sessions. About 8% on sessions started on Opus.
- It declines about 500 downshifts whose rebuild would cost more than they save, and pays $82 in rebuilds instead of $752.
- Cache reads are 62% of the bill, output tokens 10%. Main-thread turns arrive with a mean context of 387K tokens, where no paid switch can pay for itself. Effort is the lever there: 613 turns run below the user's `xhigh`, with no cache or thinking loss.
- Subagents are 66% of spend; general-purpose agents alone 55%. Routing them by type at their first request is free. Whether they can run on Sonnet without taking more turns is the open question, worth about $1,355/month gross on this account; the router ships a trial mode to measure it live.

Details, including what the replay cannot see, are in [EVALUATION.md](EVALUATION.md).

## The policy

1. Effort on every turn, free. The router appends an effort-only message at the tail of each request, under the per-turn-control beta Claude Code already uses. Nothing is inserted into history and none of Claude Code's messages are edited, so the cache prefix stays byte-identical and preserved thinking stays valid.
2. Model changes at cache boundaries. Switch freely when there's no cache to lose: new conversations, every subagent, after compaction, after TTL expiry, small contexts. Otherwise downshift only when `savings × expected run − rebuild − expected return cost` is positive. Upgrade for quality whenever the turn is clearly hard, the user is in plan mode, or the previous task ended failing.
3. Signals beyond the prompt. Agent type from the system prompt; forks never switched; downshifts that would discard the current model's thinking held; the user's `/effort` as a ceiling.

## What's built

- A decision engine with logged, numeric reasons for every choice.
- A local proxy (`ANTHROPIC_BASE_URL`) that applies it live, with shadow mode that forwards bytes untouched, fail-open retries, a dashboard, a per-session status line and a log of every request including abandoned ones.
- A one-command launcher that runs Claude Code through the proxy as "Dynamic mode", so the header stops naming a model that isn't the one running.
- A replay analyzer that runs any user's `~/.claude/projects` transcripts through the same engine and reports the cost with routing, rebuilds included. It reads the current transcript format (per-block lines, rewinds, compaction, resumed sessions, forks, fork context references).
- 84 tests, including end-to-end proxy tests that verify the request prefix stays byte-identical across a tool loop after an effort change.
- Every sentence a person reads, from the status line to the decision log, is plain English with the money in it: "staying on Opus 5.5 for this task, using medium effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.95 more than it saves)".

## Asks

1. Run `legato analyze` across internal dogfooding transcripts to size the opportunity on real sessions.
2. Feedback on the policy, especially whether a native version could share system-prompt and tool-definition cache across models, which would remove most of the switching penalty, and whether thinking-block portability between models is on the roadmap.
3. A path to a native `model: "auto"` in Claude Code, with the routed model visible in the UI and per-turn override.
4. A final token count on every transcript response: 69% of recorded responses stop before it, which hides output cost from any analysis of real usage.

## Demo script (5 minutes)

1. `legato analyze --since 30d --html report.html` on a real account; open the report.
2. `legato explain "add a loading state" --context 180000` vs `--context 25000`: same prompt, opposite decisions, with the arithmetic shown.
3. `legato`, then a live session with the status line on: a rename drops the effort, a "why does this break" question keeps Opus at xhigh, an Explore subagent runs on Sonnet, and a typo on a huge context holds Opus with the rebuild cost in the reason.
