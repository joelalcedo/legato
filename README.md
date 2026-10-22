# Legato

> *Legato is an Italian musical term meaning "tied together" that indicates notes should be played or sung smoothly and continuously with no silence or gap between them.*

Claude Code, with the model and effort picked for every task. Quick tasks run on Haiku, ordinary ones on Sonnet, hard ones on Opus, and the model only changes when that saves money after paying to rebuild the prompt cache.

## Demo

![legato explain: the same prompt switches to Sonnet on a small conversation and stays on Opus on a large one](docs/demo.gif)

Three decisions, explained on the command line. The same prompt at 25K tokens switches to Sonnet. At 180K tokens it stays on Opus with lower effort, because rebuilding the cache on Sonnet would cost more than Sonnet saves. A hard prompt keeps Opus at the effort you set.

## Quick start

```bash
npm install -g github:joelalcedo/legato
legato
```

Needs Node 20 or newer and Claude Code. `legato` starts the proxy, adds the status line, and launches Claude Code as "Dynamic mode". Claude Code's own arguments pass through: `legato --resume`.

```bash
legato analyze --since 30d --html report.html    # what Legato would have saved on your own history
legato explain "add a loading state" --context 180000 --effort xhigh   # one decision, with the arithmetic
legato start --mode shadow                       # decide and log, but send every request as is
```

Nothing leaves your machine except the API calls Claude Code already makes.

## How it works

Legato is a local proxy between Claude Code and the API. For every request it reads the conversation, picks a model and an effort, rewrites the request when that saves money, and streams the answer back.

Each model has its own prompt cache. Switching models in the middle of a conversation re-reads the whole history uncached, and on a long conversation that costs more than the cheaper model saves for a good while. So Legato has two gears:

- Effort changes on every task and costs nothing. A rename runs at medium instead of xhigh; a hard question keeps your setting. Nothing in the conversation changes, so the cache stays warm.
- The model changes only when the switch is free (the start of a conversation, every subagent, after compaction, after the cache has expired, a small conversation) or when the saving over the next few requests beats the cost of rebuilding the cache. Hard tasks, plan mode and tasks that just failed go up to Opus regardless.

Subagents are routed by what they are: Explore agents run on Sonnet. A fork stays on its parent's model.

Claude Code's header says `Dynamic mode`. The status line says what each task ran on:

```
Legato: Haiku 5.5 for this task, using low effort instead of xhigh · saved $0.70 this session
Legato: switched from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of xhigh · saved $0.58 this session
Legato: staying on Opus 5.5 for this task, using medium effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.95 more than it saves) · saved $1.15 this session
```

If the API rejects a rewritten request, Legato retries with exactly what Claude Code sent. Every decision is logged with its reasons in `~/.legato/decisions.jsonl`.

## Saving examples

A task is one request from you and everything Claude Code does to finish it. These are the mean costs over one month of one developer's real Claude Code history, replayed through Legato with every cache rebuild paid for.

![Mean cost of a task with and without Legato, by kind of task](docs/img/cost-per-task.png)

An ordinary coding task costs $1.74 on Opus and $1.40 with Legato. A general-purpose subagent run costs $8.51 and $7.71. Hard tasks cost a few cents more: that is the price of bringing Opus back after a cheaper stretch, and Legato pays it rather than leave a hard task on Sonnet.

![Cumulative cost over the month, with and without Legato](docs/img/bill-over-the-month.png)

Over the month, 280 sessions and 52,217 API requests, Legato would have saved $529 of $5,166 at list prices. Lower effort on the same model is not counted, because its effect on output length is an assumption. Run `legato analyze --since 30d` for your own number.

The arithmetic behind the switching rule, the full evaluation and the roadmap are in `docs/`.
