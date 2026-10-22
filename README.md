# Switchyard

**Claude Code, with the model picked per turn.** Renames and commits run on Haiku, ordinary work on Sonnet, hard problems on Opus, and the switch only happens when the prompt-cache math says it pays. Replayed on 30 days of one developer's real sessions, it cut the bill by **9.9%**, and 12.7% in a month with Fable sessions. Routing that ignores the cache saved 2.9% and paid $752 in cache rebuilds.

## What it looks like

Claude Code's header reads `Dynamic mode`. The status line says what each turn actually ran on, and why:

```
⇄ Dynamic mode: running on Haiku 5.5 at low effort · saved $0.70 over 1 turn
⇄ Dynamic mode: running on Sonnet 5.5 at medium effort · saved $0.84 over 12 turns
⇄ Dynamic mode: running on Opus 5.5 at xhigh effort · saved $0.84 over 13 turns
⇄ Dynamic mode: running on Opus 5.5 at medium effort (asked xhigh) · switch held: rebuild $0.97 · saved $1.15 over 20 turns
```

The last line is the point: on a 300K-token conversation, moving Opus to Sonnet would cost $0.97 to rebuild the cache and save 4¢ a request, so the router keeps Opus and lowers the effort instead. Every decision is logged with its numbers.

*(Demo recording: `docs/demo.gif`, see [CONTRIBUTING](CONTRIBUTING.md#recording-the-demo).)*

## What it saves

Same account, same 30 days, 51.9K API requests, $5.1K at list prices. Cache rebuilds are counted against the saving.

| Policy | Saved | Cache rebuilds paid |
| - | - | - |
| Switch models per turn, cache ignored | $160 (2.9%) | $752 |
| Cache-aware: switch only when it pays, lower effort otherwise | $691 (12.7%) | $89 |
| Same, following month (no Fable sessions) | $504 (9.9%) | $82 |

Your number comes from your own history, nothing leaves your machine:

```bash
switchyard analyze --since 30d --html report.html
```

What the replay cannot see is whether a cheaper model takes more turns. The `--trial` flag measures that live. Details and caveats: [docs/EVALUATION.md](docs/EVALUATION.md).

## Install

Node 20+ and Claude Code.

```bash
npm install -g github:joelalcedo/switchyard
switchyard
```

That is the whole setup. `switchyard` starts the local proxy if it isn't running, adds a status line to your Claude Code settings on first use, and launches Claude Code through it as "Dynamic mode". Arguments pass through: `switchyard --resume`. Dashboard at http://127.0.0.1:8787/switchyard.

To watch before trusting it, run the proxy in shadow mode first (it decides and logs, but forwards every request as sent): `switchyard start --mode shadow`, then `switchyard` in another terminal.

## More

- [How it works](docs/HOW-IT-WORKS.md): the two gears, the switching rule, safety properties, options, repo layout.
- [Design](docs/DESIGN.md): the arithmetic behind the switching rule.
- [Evaluation](docs/EVALUATION.md): results on real data, and what the replay can't measure.
- [Roadmap](docs/ROADMAP.md), [Contributing](CONTRIBUTING.md). MIT licensed. Not affiliated with Anthropic.
