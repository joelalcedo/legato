# How it works

Switchyard is a local HTTP proxy. Claude Code is pointed at it with `ANTHROPIC_BASE_URL`; the proxy reads each request, decides the model and effort, rewrites the request when that pays, and streams the response back. Nothing is sent anywhere except the API you already use.

## Why routing is not a one-liner

Claude Code runs every turn of a session on one model. On Opus, that includes renames, commits, "thanks", and the hundred tool-loop steps of every subagent. Routing is the most-requested class of feature in the Claude Code tracker ([anthropics/claude-code#27665](https://github.com/anthropics/claude-code/issues/27665) rolls up 30+ duplicates).

The catch: **each model has its own prompt cache.** Switching the main model mid-conversation re-reads the entire history uncached. At the context sizes a real session reaches (a mean of 387K tokens at each user turn in the evaluation data), moving Opus 5.5 to Sonnet 5.5 costs about $0.97 up front to save 4¢ per request. Cache reads are 62% of a heavy user's bill; output tokens are 10%. A router that doesn't do this arithmetic loses money.

## Two gears

One `decide()` function, called by both the proxy and the analyzer.

**Effort, every turn, free.** Claude Code attaches a control message carrying the turn's effort to each user turn. Switchyard sets the effort on that message when it is the request's tail, and otherwise appends an effort-only message at the tail. Either way the user and assistant history is untouched, so the cached prefix and preserved thinking blocks stay valid. A mechanical turn on Opus runs at `medium` instead of `xhigh`; a hard one keeps the user's setting. This is the only lever that works on a long main thread.

**Model, at cache boundaries.** A switch happens only at a user turn, never inside a tool loop, and only when it is free or pays:

- Free: the first request of a conversation, every subagent's first request, after compaction, after the cache has expired, or when the context is small.
- Paid: a downshift must clear `saving per request × expected run − cache rebuild − expected cost of switching back`. Upgrades for quality (a hard turn, plan mode, a task that ended failing) go through.

Three more rules from the evaluation data:

- **Agent type beats the brief.** A subagent's system prompt says what it is. Explore agents go to Sonnet; a `trial` can route a share of general-purpose agents to another model and log the arm, so quality can be compared live.
- **Forks are never switched.** A fork inherits its parent's context, cache and thinking; switching it rebuilds all three.
- **Thinking is not thrown away.** Thinking blocks are readable only by the model that wrote them or a stronger one. A downshift that would discard more than 20K tokens of the current model's reasoning is held, and effort adjusted instead.

Every decision logs its reasons with the numbers:

```
hold claude-opus-5-5: downshift nets $-0.950 (rebuild $0.970, saves $0.0390/request) - adjusting effort instead
```

The derivation of the rule is in [DESIGN.md](DESIGN.md).

## "Dynamic mode"

Claude Code's header names the model it was launched with, and nothing outside the binary can change that line. So `switchyard` launches Claude Code with `--model "Dynamic mode"`, an alias the proxy resolves (`modelAliases` in the config; by default "route, up to Opus 5.5") and never forwards to the API. Because Claude Code doesn't know that name, the launcher also sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` (otherwise it assumes a 200K window and warns) and the `ANTHROPIC_CUSTOM_MODEL_OPTION*` variables that put "Dynamic mode" in the `/model` picker with effort and thinking enabled. Launching by hand with a real model name works too; the router treats it as the ceiling.

The status line is what shows the routed model. `switchyard` adds it to `~/.claude/settings.json` on first use when no status line is configured:

```json
"statusLine": { "type": "command", "command": "switchyard statusline" }
```

## Safety properties

- **Nothing inserted into history.** Effort is set on Claude Code's own control message or on a message appended at the tail. No ledger, no prefix edits, nothing lost on a proxy restart.
- **Fail-open.** If the API rejects a rewritten request (400, 404, 422, 529), the proxy retries once with exactly what Claude Code sent, and records that it ran as sent.
- **No mid-loop switches.** Thinking and cache stay with the model that produced them.
- **Shadow mode** forwards Claude Code's request bytes untouched and logs `forwarded: "original"` on every entry, so "nothing was rewritten" is checkable line by line.
- **Every request is logged**, including the ones Claude Code abandons (status 499) and upstream failures (502).
- **Background requests** (no tools) pass through.
- **Claude Code's hidden prompts** (the next-prompt suggestion it sends after every turn, idle recaps, summaries) hold the current model and effort and are not counted as turns.

## Commands and options

```bash
switchyard                       # run Claude Code through the router (starts the proxy if needed)
switchyard start --mode shadow   # proxy only, decides and logs, forwards as sent
switchyard analyze --since 30d --html report.html   # replay your own transcripts
switchyard explain "add a loading state to the table" --context 180000   # one decision, with the arithmetic
switchyard stats                 # totals from the running or last proxy
```

Options: `--preset conservative|balanced|aggressive`, `--classifier haiku` (Haiku 5.5 classifies each turn; needs `ANTHROPIC_API_KEY`), `--trial general-purpose=claude-sonnet-5-5/high:50`, `--no-effort`, `--fable`. Everything is in `~/.switchyard/config.json`; see `src/config.ts`. A leading `//h`, `//s`, `//o` or `//f` on a prompt forces a tier for that turn.

Decision log: `~/.switchyard/decisions.jsonl`. Dashboard: http://127.0.0.1:8787/switchyard.

## Limitations

- The analyzer holds output length constant across models and cannot see quality. Validate in shadow mode, then with a `trial`.
- The default classifier is a transparent keyword heuristic; the Haiku classifier needs an API key because a subscription's OAuth token can't be used for other calls.
- Claude Code's own header line cannot be changed from outside. The launch alias makes it say `Dynamic mode`; the status line says what is running. If you launch by hand with the alias and without `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, Claude Code assumes a 200K window and compacts earlier than it would on Opus.
- Haiku 5.5 is rarely chosen on long sessions: its price multiplies by five above 100K tokens of prompt.

## What's in the repo

```
src/
  engine.ts        decide(): the policy and the switch economics. Start here.
  classifier.ts    the heuristic classifier, and the optional Haiku 5.5 one
  features.ts      signals from a Messages API request: turns, errors, agent type, forks, thinking
  rewrite.ts       applies a decision: model, parameters, the turn's effort
  proxy.ts         HTTP proxy: streaming, fail-open, decision log, dashboard, status files
  sessions.ts      conversation identity and on-disk state
  cli.ts           the launcher, start, analyze, explain, stats, statusline
  pricing.ts       list prices        models.ts   capabilities per model
  analyzer/        transcript reader, replay, text and HTML reports
test/              engine, rewrite prefix stability, proxy end-to-end against a mock API, analyzer, status line
docs/              DESIGN.md (the math), EVALUATION.md (real data), ROADMAP.md, PITCH.md
examples/          synthetic transcripts and the demo report
```

`npm run demo` replays five synthetic sessions in `examples/sample-transcripts` (invented content, realistic token growth): $4.45 → $3.63, 9 switches, $0.32 in rebuilds, one downshift declined. Those are test numbers; the ones that matter come from your own transcripts.
