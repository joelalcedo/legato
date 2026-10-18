# Switchyard

**Cache-aware model routing for Claude Code.** Switchyard picks the model and effort level for every turn, and only switches models when the prompt-cache math says the switch pays for itself.

```
rename getUserData to fetchUserProfile    opus-5-5 -> haiku-5-5   free switch: first request, no cache yet
Why does the dashboard re-render 3x?      haiku-5-5 -> opus-5-5   free switch: haiku cache expired
add a loading skeleton to the Table       held opus-5-5           downshift nets -$0.19 (rebuild $0.31 on a 147K context)
fix the typo in the Modal close label     opus-5-5 -> haiku-5-5   downshift nets +$0.12 (Haiku rebuilds are cheap)
```

## Why this exists

Claude Code runs every turn of a session on one model. On plans that default to Opus, renames, `git commit`, "thanks" and grep-result processing all run on Opus. The consolidated feature request for routing ([anthropics/claude-code#27665](https://github.com/anthropics/claude-code/issues/27665)) rolls up 30+ duplicates, including one Max user's measurement of 93.8% of tokens going to Opus.

What exists today is coarse: `opusplan` (Opus only inside plan mode), the advisor tool (escalates to a stronger model, never de-escalates), per-subagent `model:` frontmatter, and fallback chains for outages. Community plugins mostly inject "use the Haiku subagent for X" instructions, which spend main-model tokens on the routing decision itself.

Every one of these ignores the constraint that actually governs the economics: **each model has its own prompt cache.** Switching the main model mid-conversation re-reads the entire history uncached. On a 150K-token conversation, moving Opus 5.5 to Sonnet 5.5 costs about $0.35 in cache writes up front to save about $0.03 per request afterwards. Naive per-turn routing can cost more than it saves.

## How it works

Switchyard has two gears:

1. **Model, at cache boundaries.** A model switch happens only at a user turn, never inside a tool loop, and only when it pays:
   - **Free switches**: the first request of a conversation (including every subagent, which always starts cold), after the current model's cache has expired, or when the context is small.
   - **Paid switches**: a downshift must clear `savings per request × expected run length − cache rebuild − expected cost of switching back`. Upgrades for quality (hard task, plan mode, repeated failures) always go through.
2. **Effort, every turn, for free.** On the 5.5 models, effort can change per message with an effort-only `role: "system"` message (beta `mid-conversation-output-config-2026-07-01`) without touching the cache. When a downshift doesn't pay, Switchyard lowers effort instead. Because Claude Code doesn't know about these injected messages, Switchyard keeps a ledger and re-inserts each one at the same position on every later request, so the request prefix stays byte-identical.

Decisions use signals from the transcript as well as the prompt: failing tool results in the previous task escalate the next turn, plan mode floors at Opus, and a leading `//h`, `//s`, `//o` or `//f` forces a tier for one turn.

See [docs/DESIGN.md](docs/DESIGN.md) for the cost model and its derivation.

## Three pieces

| Piece | What it does |
| - | - |
| **Engine** (`src/engine.ts`) | Pure decision function: request + conversation state → model, effort, and logged reasons. |
| **Proxy** (`switchyard start`) | Point `ANTHROPIC_BASE_URL` at it. Rewrites requests live, streams responses through untouched, fails open, and serves a dashboard. |
| **Analyzer** (`switchyard analyze`) | Replays your real `~/.claude/projects` transcripts through the same engine and reports what routing would have cost, cache rebuilds included. |

## Quick start

Requires Node 20+.

```bash
npm install
npm run build
npm link            # optional: puts `switchyard` on your PATH

# 1. See what it would have done on your own history. Nothing is sent anywhere.
switchyard analyze --since 30d --html report.html

# 2. Run it in shadow mode: decides and logs, but forwards requests untouched.
switchyard start --mode shadow
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --model opus

# 3. Go live.
switchyard start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --model opus
```

Dashboard: http://127.0.0.1:8787/switchyard. Status line: add `"statusLine": {"type": "command", "command": "switchyard statusline"}` to `~/.claude/settings.json`.

Debug one decision without running anything:

```bash
switchyard explain "add a loading state to the table" --context 180000
switchyard explain "add a loading state to the table" --context 25000
```

On a Claude subscription within plan usage, Claude Code uses a one-hour cache TTL for the main conversation; pass `--ttl 3600`.

## Sample results

`npm run demo` replays five synthetic sessions bundled in `examples/sample-transcripts` (invented content, realistic token growth) and writes `examples/sample-report.html`:

```
Same traffic, current models       $4.45   (no routing)
With Switchyard                    $3.59   saves $0.86 (19.4%)
Model mix: opus 47%, haiku 28%, sonnet 25%
Model switches: 8 (4 free), cache rebuilds paid: $0.23
Downshifts declined because the rebuild cost more than it saved: 1
```

These are synthetic numbers to exercise the code. The figure that matters is what `switchyard analyze` reports on your own transcripts.

## Presets

| Preset | Behavior |
| - | - |
| `conservative` | Never below Sonnet in the main conversation; higher bar for downshifts; escalates after one failure. |
| `balanced` (default) | All three tiers; downshift must net at least $0.02. |
| `aggressive` | Longer expected runs on the cheaper model; switches more readily. |

Switchyard never routes above the model Claude Code asked for (`ceiling: "incoming"`), so `claude --model sonnet` caps routing at Sonnet. Fable is opt-in (`--fable`). Everything is configurable in `~/.switchyard/config.json`; see `src/config.ts`.

## Safety properties

- **Fail-open.** If the API rejects a rewritten request (400, 404, 422, 529), Switchyard retries once with exactly what Claude Code sent.
- **No mid-loop switches** by default: thinking blocks and cache stay with the model that produced them.
- **Background requests pass through** untouched (no tools, or already on Haiku).
- **Shadow mode** for evaluating a policy before it changes anything.
- **Nothing leaves your machine** except the request to the upstream API you already use. Decisions are logged to `~/.switchyard/decisions.jsonl`.

## Limitations

- The analyzer can't measure answer quality. It holds output length constant across models and doesn't count effort savings, so its cost estimate errs low, but a cheaper model can still take more turns to finish. Validate in shadow mode, then live.
- The default classifier is a transparent keyword-and-structure heuristic. It's the weakest part and is designed to be replaced (see roadmap).
- Claude Code's own UI keeps showing the model you launched with; use the dashboard or status line to see routed models.
- Model limits (for example Haiku 5.5's `max_tokens`) are in config and may need updating as models change.

## Roadmap

- A learned router trained on preference data (RouteLLM-style) or a Haiku 5.5 classifier behind the same interface.
- Quality evaluation: replay task suites with and without routing and compare pass rates.
- Learn expected run length per user from their own history instead of a constant.
- A Claude Code plugin form for deterministic subagent routing via a `PreToolUse` hook on the Agent tool.

## Development

```bash
npm test          # 43 tests: engine, rewrite ledger, proxy end-to-end against a mock API, analyzer
npm run samples   # regenerate the synthetic transcripts
npm run demo      # build and write examples/sample-report.html
```

MIT licensed. Not affiliated with Anthropic.
