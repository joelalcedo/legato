# Legato

Claude Code, with the model picked for every turn.

Easy turns run on Haiku, normal ones on Sonnet, hard ones on Opus. Legato switches only when the prompt-cache math says the switch pays, so it lowers your bill instead of burning it on cache rebuilds. The header says `Dynamic mode`; the status line says what each turn actually ran on.

*legato* (music): notes joined without a break.

## Demo

<!-- docs/demo.gif: recorded from a real session, see CONTRIBUTING.md#recording-the-demo -->

```
⇄ Dynamic mode: running on Haiku 5.5 at low effort · saved $0.70 over 1 turn
⇄ Dynamic mode: running on Opus 5.5 at xhigh effort · saved $0.84 over 13 turns
⇄ Dynamic mode: running on Opus 5.5 at medium effort (asked xhigh) · switch held: rebuild $0.97 · saved $1.15 over 20 turns
```

## What it saves

9.9% on 30 days of one developer's real Claude Code history, and 12.7% in a month with Fable sessions. Routing that ignores the cache saved 2.9% and paid $752 in cache rebuilds. Numbers and caveats: [docs/EVALUATION.md](docs/EVALUATION.md).

Your own number, from your own transcripts. Nothing leaves your machine:

```bash
legato analyze --since 30d --html report.html
```

## Install

```bash
npm install -g github:joelalcedo/legato
legato
```

Node 20+ and Claude Code. `legato` starts the proxy, sets up the status line, and launches Claude Code. Any Claude Code arguments pass through: `legato --resume`.

## More

[How it works](docs/HOW-IT-WORKS.md) · [Design](docs/DESIGN.md) · [Evaluation](docs/EVALUATION.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md) · MIT · Not affiliated with Anthropic
