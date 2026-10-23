# Reference

## Commands

```bash
legato                           # run Claude Code through Legato (starts the proxy if it is not running)
legato --resume                  # any Claude Code argument passes through
legato start --mode shadow       # proxy only: decide and log, send every request as is
legato start --mode live         # proxy only, routing on
legato analyze --since 30d --html report.html   # replay your own transcripts
legato analyze --since 2026-09-21 --until 2026-10-23T08:00Z   # a fixed window, for before/after comparisons
legato explain "rename the helper to parseConfig" --context 180000 --effort xhigh   # one decision, with the arithmetic
legato stats                     # totals from the running or last proxy
legato statusline                # the line Claude Code's status bar shows (reads the session id on stdin)
```

Options for `start` and `legato`:

- `--preset conservative`, `balanced` (the default) or `aggressive`. Conservative never goes below Sonnet and wants 5¢ of net saving before a switch. Aggressive switches for any saving at all, counts on 12 more requests instead of 8, and treats conversations under 20K tokens as free to switch.
- `--classifier haiku` asks Haiku 5.5 to classify each task instead of the keyword rules. Needs `ANTHROPIC_API_KEY` or `LEGATO_CLASSIFIER_KEY`.
- `--trial general-purpose=claude-sonnet-5-5/high:50` routes half of those subagents to Sonnet and logs which half each one was in, so the two halves can be compared.
- `--no-effort` leaves the effort alone and only routes the model.
- `--fable` allows Fable 5.1 as a tier above Opus.
- `--ttl 300` sets how long the API keeps a cache, in seconds; by default it is read from each request.

Starting a prompt with `//h`, `//s`, `//o` or `//f` forces Haiku, Sonnet, Opus or Fable for that task.

Settings live in `~/.legato/config.json`; every key is documented in `src/config.ts`. The decision log is `~/.legato/decisions.jsonl`, one line per request with the reasons in plain words. The dashboard is at http://127.0.0.1:8787/legato while the proxy runs.

## "Dynamic mode"

Claude Code's header names the model it was launched with, and nothing outside Claude Code can change that line. So `legato` launches Claude Code with `--model "Dynamic mode"`, a name the proxy resolves on every request (`modelAliases` in the config; by default it means "route, up to Opus 5.5") and never sends to the API. Because Claude Code does not know the name, the launcher also sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` (otherwise Claude Code assumes a 200K window and warns) and the `ANTHROPIC_CUSTOM_MODEL_OPTION*` variables that put "Dynamic mode" in the `/model` picker. Launching by hand with a real model name works too; Legato treats it as the ceiling.

The status line is what shows the model that is actually running. `legato` adds it to `~/.claude/settings.json` the first time, if no status line is configured:

```json
"statusLine": { "type": "command", "command": "legato statusline" }
```

## What Legato never does

- It never edits or reorders Claude Code's messages. The effort goes on a small message appended at the end of the request, so the cached prefix and preserved thinking stay valid.
- It never switches models in the middle of a task. Thinking and cache stay with the model that produced them.
- If the API rejects a rewritten request, the proxy sends it once more exactly as Claude Code wrote it, and records that it ran as sent.
- In shadow mode it never changes a byte. Every log line says `forwarded: "original"`, so that claim can be checked line by line.
- It never counts Claude Code's own hidden prompts (the next-prompt suggestion after every task, idle recaps, summaries) as your tasks. They keep the current model and effort.
- Nothing leaves your machine except the API calls Claude Code already makes.

## Limitations

- The replay holds output length constant across models and cannot judge answer quality. Try a preset in shadow mode, then live, then with a `trial`, before trusting it.
- The default classifier is a keyword heuristic you can read in `src/classifier.ts`. The Haiku classifier needs an API key, because a subscription's token cannot be used for other calls.
- If you launch Claude Code by hand with the alias and without `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, Claude Code assumes a 200K window and compacts earlier than it would on Opus.
- Haiku 5.5 is rarely chosen on long conversations: its price multiplies by five above 100K tokens of prompt.

## The repository

```
src/
  engine.ts        decide(): the policy and the switch arithmetic. Start here.
  words.ts         every sentence a person sees: model names, money, reasons, the status line
  classifier.ts    the keyword classifier, and the optional Haiku 5.5 one
  features.ts      what a request tells us: new task or loop step, errors, agent type, forks
  rewrite.ts       applies a decision: model, parameters, the task's effort
  proxy.ts         the HTTP proxy: streaming, retries, decision log, dashboard, status files
  sessions.ts      which conversation a request belongs to, and its state on disk
  cli.ts           the launcher, start, analyze, explain, stats, statusline
  pricing.ts       list prices        models.ts   what each model supports
  analyzer/        transcript reader, replay, text and HTML reports
test/              engine, request-bytes stability, proxy end to end against a mock API, analyzer, status line
scripts/video/     the README film (HyperFrames) and make-data.mjs for its data; scripts/savings-chart/ the savings chart
docs/              DESIGN.md (the arithmetic), EVALUATION.md (real data), ROADMAP.md, PITCH.md
examples/          synthetic transcripts and the demo report
.claude/agents/    plain-english-reviewer: the adversarial reviewer for everything a person reads
```

`npm run demo` replays five synthetic sessions in `examples/sample-transcripts` (invented content, realistic token growth). Those are test numbers; the ones that matter come from your own transcripts.
