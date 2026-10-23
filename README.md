# Legato

> *Legato is an Italian musical term meaning "tied together" that indicates notes should be played or sung smoothly and continuously with no silence or gap between them.*

Cache-aware model routing for Claude Code. Legato runs Claude Code through a local proxy and routes each task to Haiku, Sonnet or Opus at the effort the task needs, switching model only when the saving covers the cost of rebuilding the prompt cache. Cursor and GitHub Copilot call this Auto. Claude Code has no native version ([#27665](https://github.com/anthropics/claude-code/issues/27665)). On one month of one developer's real use, Legato cut usage 10% at API list prices.

## Quick start

```bash
npm install -g github:joelalcedo/legato
legato
```

Needs Node 20 or newer and Claude Code. `legato` starts the proxy if none is running, adds a status line to `~/.claude/settings.json` on first use if you have none, and launches Claude Code as `Dynamic mode`, since the model now varies by task. Claude Code's own arguments pass through, so `legato --resume` works.

To see what Legato would have saved before you run it, replay your own Claude Code history. The report lists every task, the model it would have run on and what that would have cost or saved.

```bash
legato analyze --since 30d --html report.html
```

To see one decision and the arithmetic behind it, give `legato explain` a task as you would type it to Claude Code, with the size of the conversation and your effort setting (Claude Code's `/effort`). Here the task is a rename in a conversation that has grown to 180K tokens at xhigh; `explain` assumes the conversation is on Opus unless you pass `--current`:

```bash
legato explain "rename the helper to parseConfig and update its callers" --context 180000 --effort xhigh
```

It prints the model and effort it would use and the sum behind them:

```
Switch from Opus 5.5 to Haiku 5.5 for this task, using medium effort instead of xhigh.
  Looks like a quick task (a mechanical edit).
  Switching to Haiku 5.5: it saves about 5.6¢ on each of the next 8 requests ($0.45), costs 7¢ to rebuild the cache and about $0.27 to come back to Opus 5.5 later, so it comes out about $0.11 ahead.
  This assumes about 8 more requests on Haiku 5.5 and a 30% chance of coming back to Opus 5.5 after its cache has expired.
```

To watch Legato's decisions without letting it change a request, start the proxy in shadow mode in one terminal, then run `legato` in another; it uses the proxy that is already running. Every request is logged with the decision Legato would have made, then sent exactly as Claude Code wrote it.

```bash
legato start --mode shadow
```

Nothing leaves your machine except the API calls Claude Code already makes.

## Demo

A real session replayed through Legato's router, with the status line reporting each switch, then one month of real use replayed.

![A Claude Code session running through Legato: the header says Dynamic mode where a model name would be, the status line says which model each task ran on and what it saved, then one month of use is replayed as a chart](docs/demo.gif)

## How it works

Legato is a local proxy. Claude Code sends every request to it instead of to the API, and Legato forwards each one on the model and effort the task needs. The diagram below shows Claude Code on Opus by itself and Claude Code through Legato.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.png">
  <img alt="Without Legato, Claude Code sends every task to one model. With Legato, a local proxy sits between Claude Code and the API and sends quick tasks to Haiku, ordinary tasks to Sonnet and hard tasks to Opus." src="docs/diagrams/architecture-light.png" width="960">
</picture>

A short list of keyword rules in `src/classifier.ts` reads each task: "root cause" and "race condition" mean a hard task, "rename", "commit" and a greeting a quick one, and every rule that fires is printed with the decision. When no rule fires, Legato does not guess and the task stays on its model. A switch is free where no cache exists yet, at a conversation's first request, a subagent's first request or after Claude Code compacts a long conversation, and nine switches in ten in the month below were free. The diagram below shows the two questions Legato asks before it changes the model.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/decision-dark.png">
  <img alt="One decision: if no keyword rule fires, keep the model. Otherwise pick the task's model, and switch only if the switch pays for its cache rebuild; a switch is free where no cache exists yet." src="docs/diagrams/decision-light.png" width="960">
</picture>

Effort is chosen on every request as well: a hard task keeps the effort you set, other tasks run at low, medium or high depending on how strongly the rules fired, a task no rule reads runs one step below your setting, and nothing ever goes above your setting. That is free, because the effort goes on a small message added at the end of the request and the cached conversation is untouched. A model switch is not free. Each model keeps its own cached copy of the conversation, so a switch partway through pays to rebuild that cache before it saves anything. The chart below shows the same switch, from Opus to Sonnet for an ordinary coding task, in a conversation of 40K tokens and one of 180K: the rebuild, then what each request on Sonnet saves, at list prices.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/switch-cost-dark.png">
  <img alt="Cumulative cost over eight requests of staying on Opus against switching to Sonnet. At 40K tokens of context the switch line starts higher, for the cache rebuild, and crosses below the stay line between the fourth and fifth request. At 180K tokens it starts much higher and never crosses." src="docs/diagrams/switch-cost-light.png" width="960">
</picture>

At 40K tokens the switch pays for itself by the fifth request. Legato also charges a 30% chance of paying to come back to Opus later, which the chart leaves out; with that, the switch is still about 3¢ ahead after eight requests, so Legato switches. At 180K the rebuild alone costs more than eight requests on Sonnet save, so Legato stays on Opus, lowers the effort instead, and says so:

```
Legato: staying on Opus 5.5 for this task, using high effort instead of xhigh (a switch to Sonnet 5.5 would cost $0.39 more than it saves) · saved $1.15 this session
```

The figure at the end is the session's running total. Subagents are routed by what they are, independently of Claude Code's own subagent model setting ([#43869](https://github.com/anthropics/claude-code/issues/43869)): Explore agents run on Sonnet; general-purpose agents, and forks, which start with the parent's whole conversation, stay on the parent's model.

"Saved" is what the same requests would have cost on the model Claude Code asked for, at API list prices: money on API billing, usage against your plan's limits on a subscription. If the API rejects a rewritten request, Legato sends it once more exactly as Claude Code wrote it. Legato cannot judge whether the cheaper answer was as good as the dearer one; every decision and its reasons are logged in `~/.legato/decisions.jsonl` so that you can.

## Saving examples

![What a task costs with and without Legato, by kind of task: general-purpose agent runs and ordinary coding tasks carry the saving, hard tasks cost a few cents more](docs/savings.gif)

One month of one developer's real Claude Code use, replayed through Legato: $507 saved of $5,233, after paying for every cache rebuild. A task that reads as ordinary coding goes from $1.50 to $1.03. One the rules cannot read stays on its model at one effort step down, and still goes from $1.84 to $1.38, because many of those sit on Sonnet after an earlier free switch. Hard tasks go from 87¢ to 77¢.

The dollars are usage at API list prices on a Max subscription. On sessions that start on Opus the saving is about 8%. Lower effort on the same model is not counted. `legato analyze --since 30d` prints this table for your own history.

The arithmetic behind the switching rule, the full evaluation and the roadmap are in `docs/`.
