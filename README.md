# Switchyard

**Cache-aware model routing for Claude Code.** A local proxy that picks the model and effort for every turn, and only switches models when the prompt-cache math says the switch pays for itself.

Replayed on one developer's 30 days of real Claude Code sessions (51.9K API requests, $5.1K at list prices): per-turn routing that ignores the cache saved **2.9%** and paid **$752** in cache rebuilds. Cache-aware routing saved **9.9%** ($504; 12.7% in a month with Fable sessions) and paid **$82**.

```
⇄ Sonnet 5.5 · medium ← Opus 5.5 · saved $0.84 over 12 turns        ← Claude Code status line, this session
⇄ Opus 5.5 · medium (asked xhigh) · held: rebuild $0.97 · saved $0.31 over 7 turns
```

[Quick start](#quick-start) · [How it decides](#how-it-decides) · [Results](#results-on-real-usage) · [What's in the repo](#whats-in-the-repo) · [Design](docs/DESIGN.md) · [Evaluation](docs/EVALUATION.md) · [Roadmap](docs/ROADMAP.md)

## Why this exists

Claude Code runs every turn of a session on one model. On Opus, that includes renames, commits, "thanks", and the hundred tool-loop steps of every subagent. Routing is the most-requested class of feature in the Claude Code tracker ([anthropics/claude-code#27665](https://github.com/anthropics/claude-code/issues/27665) rolls up 30+ duplicates).

The reason it is not a one-liner: **each model has its own prompt cache.** Switching the main model mid-conversation re-reads the entire history uncached. At the context sizes a real session reaches (a mean of 387K tokens at each user turn in the evaluation data), moving Opus 5.5 to Sonnet 5.5 costs about $0.97 up front to save 4¢ per request. Cache reads are 62% of a heavy user's bill; output tokens are 10%. A router that doesn't do this arithmetic loses money.

## How it decides

Two gears, applied by one `decide()` function that both the proxy and the analyzer call.

**Effort, every turn, free.** Claude Code attaches a control message carrying the turn's effort to each user turn. Switchyard sets the effort on that message when it is the request's tail, and otherwise appends an effort-only message at the tail. Either way the user and assistant history is untouched, so the cached prefix and preserved thinking blocks stay valid. A mechanical turn on Opus runs at `medium` instead of `xhigh`; a hard one keeps the user's setting. This is the only lever that works on a long main thread.

**Model, at cache boundaries.** A switch happens only at a user turn, never inside a tool loop, and only when it is free or pays:

- Free: the first request of a conversation, every subagent's first request, after compaction, after the cache has expired, or when the context is small.
- Paid: a downshift must clear `saving per request × expected run − cache rebuild − expected cost of switching back`. Upgrades for quality (a hard turn, plan mode, a task that ended failing) go through.

Three more rules from the evaluation data:

- **Agent type beats the brief.** A subagent's system prompt says what it is. Explore agents go to Sonnet; a `trial` can route a share of general-purpose agents to another model and log the arm, so quality can be compared live.
- **Forks are never switched.** A fork inherits its parent's context, cache and thinking; switching it rebuilds all three.
- **Thinking is not thrown away.** Thinking blocks are readable only by the model that wrote them or a stronger one. A downshift that would discard more than 20K tokens of the current model's reasoning is held, and effort adjusted instead.

Every decision logs its reasons with the numbers: `hold claude-opus-5-5: downshift nets $-0.950 (rebuild $0.970, saves $0.0390/request) - adjusting effort instead`.

## Quick start

Node 20+. Nothing is sent anywhere except the API you already use.

```bash
git clone https://github.com/joelalcedo/switchyard && cd switchyard
npm install && npm run build && npm link

# 1. What it would have done on your own history, cache rebuilds included.
switchyard analyze --since 30d --html report.html

# 2. Shadow mode: decides and logs, forwards every request untouched.
switchyard start --mode shadow
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# 3. Live.
switchyard start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Dashboard: http://127.0.0.1:8787/switchyard. Decision log: `~/.switchyard/decisions.jsonl`.

**Status line.** Claude Code's header keeps showing the model you launched with; the status line shows what this session is running on. In `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "switchyard statusline" }
```

**One decision, explained:**

```bash
switchyard explain "add a loading state to the table" --context 180000   # holds Opus, lowers effort
switchyard explain "add a loading state to the table" --context 25000    # switches to Sonnet
```

**Options.** `--preset conservative|balanced|aggressive`, `--classifier haiku` (Haiku 5.5 classifies each turn; needs `ANTHROPIC_API_KEY`), `--trial general-purpose=claude-sonnet-5-5/high:50`, `--no-effort`, `--fable`. Everything is in `~/.switchyard/config.json`; see `src/config.ts`. A leading `//h`, `//s`, `//o` or `//f` on a prompt forces a tier for that turn.

## Results on real usage

From [docs/EVALUATION.md](docs/EVALUATION.md). Same account, same `analyze`, rebuild cost included:

| Policy | 30-day saving | Rebuilds paid |
| - | - | - |
| Per-turn routing with a 5-minute cache assumed (first version) | $160 (2.9%) | $752 |
| + treat Claude Code's own text as machine text, not prompts | $397 (7.3%) | $558 |
| + escalate only on tasks that ended failing; read the real cache TTL | $691 (12.7%) | $89 |
| Same policy, following month (no Fable sessions) | $473 (9.3%) | $82 |
| + route subagents by type, hold forks and thinking | $504 (9.9%) | $82 |

What the replay cannot measure: whether a cheaper model takes more turns to finish. The `trial` flag exists to measure that live. 69% of recorded responses lack a final token count, so every figure is a lower bound.

`npm run demo` replays five synthetic sessions in `examples/sample-transcripts` (invented content, realistic token growth): $4.45 → $3.63, 9 switches, $0.32 in rebuilds, one downshift declined. Those are test numbers; the ones that matter come from your own transcripts.

## What's in the repo

```
src/
  engine.ts        decide(): the policy and the switch economics. Start here.
  classifier.ts    the heuristic classifier, and the optional Haiku 5.5 one
  features.ts      signals from a Messages API request: turns, errors, agent type, forks, thinking
  rewrite.ts       applies a decision: model, parameters, the turn's effort
  proxy.ts         HTTP proxy: streaming, fail-open, decision log, dashboard, status files
  sessions.ts      conversation identity and on-disk state
  pricing.ts       list prices        models.ts   capabilities per model
  analyzer/        transcript reader, replay, text and HTML reports
test/              engine, rewrite prefix stability, proxy end-to-end against a mock API, analyzer
docs/              DESIGN.md (the math), EVALUATION.md (real data), ROADMAP.md, PITCH.md
examples/          synthetic transcripts and the demo report
```

## Safety properties

- **Nothing inserted into history.** Effort is set on Claude Code's own control message or on a message appended at the tail. No ledger, no prefix edits, nothing lost on a proxy restart.
- **Fail-open.** If the API rejects a rewritten request (400, 404, 422, 529), the proxy retries once with exactly what Claude Code sent, and records that it ran as sent.
- **No mid-loop switches.** Thinking and cache stay with the model that produced them.
- **Shadow mode** forwards Claude Code's request bytes untouched and logs `forwarded: "original"` on every entry, so "nothing was rewritten" is checkable line by line.
- **Every request is logged**, including the ones Claude Code abandons (status 499) and upstream failures (502).
- **Background requests** (no tools) pass through.
- **Claude Code's hidden prompts** (the next-prompt suggestion it sends after every turn, idle recaps, summaries) hold the current model and effort and are not counted as turns.

## Limitations

- The analyzer holds output length constant across models and cannot see quality. Validate in shadow mode, then with a `trial`.
- The default classifier is a transparent keyword heuristic; the Haiku classifier needs an API key because a subscription's OAuth token can't be used for other calls.
- Claude Code's own header line cannot be changed from outside; use the status line.
- Haiku 5.5 is rarely chosen on long sessions: its price multiplies by five above 100K tokens of prompt.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed. Not affiliated with Anthropic.
