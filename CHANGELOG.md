# Changelog

## Unreleased

### Routing
- Effort is set by rewriting the per-turn control message Claude Code already sends, instead of
  inserting an effort-only message tracked in a ledger. Nothing is inserted into history, so the
  cache prefix and preserved thinking blocks stay valid, and a proxy restart changes nothing.
- A turn's effort holds through its tool loop.
- Claude Code's hidden prompts (the next-prompt suggestion sent after every turn, the idle recap,
  the text-only summary) hold the model and effort and are not turns. Found in shadow mode: the
  suggestion request alone would have moved a Haiku session back to Opus after every turn.
- Subagents are routed by agent type at their first request (`subagentTiers`; Explore → Sonnet).
- Forks are never switched: they inherit the parent's context, cache and thinking.
- A downshift that would discard more than `holdThinkingTokens` of the current model's thinking
  is held, and effort adjusted instead.
- The user's `/effort` is a ceiling: hard turns keep it, others may run lower.
- Escalation happens only when the previous task ended on failing tool results.
- A message carrying tool results is a loop step even when it also carries text.
- Claude Code's wrappers, notifications, compaction summaries and skill bodies are not user prompts.
- The cache TTL is read from each request's `cache_control` markers (`detectCacheTtl`).
- Optional Haiku 5.5 classifier (`--classifier haiku`), heuristic fallback.
- Trial arms for a live A/B on one agent type (`--trial`).

### Proxy
- Shadow mode forwards Claude Code's bytes untouched; the log records `forwarded` and `ranOn`.
- Requests Claude Code abandons are logged with status 499; upstream failures with 502.
- Session state persists under `~/.switchyard/state`.
- A per-session status file under `~/.switchyard/status` drives `switchyard statusline`.
- The status line is written in words: `running on Sonnet 5.5 at medium effort instead of Opus 5.5 ·
  saved $0.58 over 3 turns`; held switches show the rebuild cost.
- `switchyard claude`: starts the proxy if needed and launches Claude Code through it as
  "Dynamic mode", with the environment that stops Claude Code assuming a 200K window for a name
  it doesn't know. Warns when the running proxy is an older build than the installed code.
- Launch aliases (`Dynamic mode`, `dynamic`, `auto`, `switchyard`, matched loosely): the proxy
  resolves them to a ceiling model (`modelAliases`) on every request, including background ones
  and shadow mode, logged as `forwarded: "aliased"`.
- The status line reports a request the router forwarded as sent, or one the API rejected, instead
  of claiming the session is not going through the proxy. `/health` returns the build id and pid.
- After a fail-open, neither the routed model nor the effort is recorded as having run.
- Removed the stale 64K `max_tokens` clamp for Haiku 5.5.

### Analyzer
- Transcript reader rewritten for Claude Code 2.1.28x–2.1.30x: per-block response lines,
  `parentUuid` branches, resumed sessions and forks, fork context references, plan-mode
  attachments, per-request effort, responses without final usage.
- `--since` skips old files before parsing; token estimation is lazy (30 days in 18s, from 6 minutes).
- Effort changes are priced on a separate, labelled line.
- Agent type and fork flag read from each subagent's `.meta.json`.

### Docs
- README restructured; `docs/EVALUATION.md` and `docs/ROADMAP.md` added.
