# Legato

> *Legato is an Italian musical term meaning "tied together" that indicates notes should be played or sung smoothly and continuously with no silence or gap between them.*

Cache-aware model routing for Claude Code. Legato runs Claude Code through a local proxy and routes each task to Haiku, Sonnet or Opus at the effort the task needs, switching model only when the saving covers the cost of rebuilding the prompt cache. Cursor and GitHub Copilot call this Auto. Claude Code has no native version ([#27665](https://github.com/anthropics/claude-code/issues/27665)). On one month of one developer's real use, Legato cut usage 10% at API list prices.

## Demo

![A Claude Code session running through Legato: the header says Dynamic mode where a model name would be, the status line says which model each task ran on and what it saved, then one month of use is replayed as a chart](docs/demo.gif)

Sixty-two seconds: a real session replayed through Legato's router, with the status line reporting each switch, then one month of real use replayed. The same film as video: [docs/demo.mp4](docs/demo.mp4).

## Quick start

```bash
npm install -g github:joelalcedo/legato
legato
```

Needs Node 20 or newer and Claude Code. `legato` starts the proxy, adds the status line and launches Claude Code as `Dynamic mode`, since the model now varies by task. Claude Code's own arguments pass through: `legato --resume`.

```bash
legato analyze --since 30d --html report.html    # what Legato would have saved on your own history
legato explain "add a loading state" --context 180000 --effort xhigh   # one decision, with the arithmetic
legato start --mode shadow                       # decide and log, but send every request as is
```

Nothing leaves your machine except the API calls Claude Code already makes.

## How it works

Legato is a local proxy between Claude Code and the API. For every request it reads the conversation, chooses a model and an effort, rewrites the request when that saves money, and streams the answer back.

What kind of task it is comes from a short list of keyword rules you can read in `src/classifier.ts`: "root cause" and "race condition" point to a hard task, "rename", "commit" and a greeting point to a quick one, and every rule that fires is printed with the decision. No model and no network call sits in that path; `--classifier haiku` asks Haiku 5.5 instead, with an API key.

Effort is Claude Code's setting for how long a model thinks before it answers. Legato lowers it on easy tasks and keeps your setting on hard ones. That costs nothing, because nothing in the conversation changes and the cache stays warm.

A switch of model is different. Each model keeps its own cached copy of the conversation, so a switch partway through a long conversation pays to rebuild that cache. Where no cache exists yet the switch is free. Where one does, Legato switches only when the saving over the next few requests beats the rebuild, and when it declines a switch the status line says why:

```
Legato: staying on Opus 5.5 for this task, using medium effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.39 more than it saves) · saved $1.15 this session
```

Hard tasks, plan mode and a task that follows a failure go to Opus regardless. A fork, which inherits its parent's whole conversation, stays on the parent's model.

"Saved" is what the same requests would have cost, at API list prices, on the model Claude Code asked for. If the API rejects a rewritten request, Legato sends it once more exactly as Claude Code wrote it. Every decision is logged with its reasons in `~/.legato/decisions.jsonl`.

## Saving examples

A task is one request from you and everything Claude Code does to finish it, or one subagent run. These are mean costs over one month of one developer's real Claude Code history, replayed through Legato's router, charging for every cache rebuild a switch caused.

![Mean cost of a task with and without Legato, by kind of task](docs/img/cost-per-task.png)

Ordinary coding tasks and general-purpose subagent runs are where the saving is: a coding task goes from $1.74 to $1.40, a general-purpose run from $8.51 to $7.71. The two hard kinds cost a few cents more, 4¢ on a $1.95 design task and 12¢ on an 85¢ debugging task, because a hard task that arrives while the conversation is on Sonnet pays to bring Opus back. Legato pays that rather than leave a hard task on Sonnet.

The film's last scene is the whole month: $529 saved of $5,166, or 10%, after paying for every cache rebuild. Three qualifiers belong next to that number. The developer is on a Claude Max subscription, so the dollars are usage at API list prices; on pay-as-you-go pricing they would be the bill. Part of the saving comes from sessions that began on Fable 5.1 and were moved to Opus at their first request; on sessions that began on Opus the saving is about 8%. Lower effort on the same model is not counted, because its effect on output length is an assumption. Your month will differ: `legato analyze --since 30d` gives your number.

The arithmetic behind the switching rule, the full evaluation and the roadmap are in `docs/`.
