# Changelog

## Unreleased

### Name
- Renamed to **Legato** (was Switchyard, which is taken on npm). Command `legato`, data in
  `~/.legato`, env vars `LEGATO_CONFIG` and `LEGATO_CLASSIFIER_KEY`, dashboard at `/legato`,
  repository `github.com/joelalcedo/legato`.

### Routing
- Effort is set by appending an effort-only message at the tail of the request, under the
  per-turn-control beta Claude Code already uses, instead of a ledger of inserted messages. Nothing
  is inserted into history, so the cache prefix and preserved thinking blocks stay valid, and a
  proxy restart changes nothing. Editing Claude Code's own control message in place was tried first
  and dropped: the first live run showed it costs about 11K tokens of cache writes on the next
  request of every turn whose effort changed.
- A turn's effort holds through its tool loop.
- Claude Code's hidden prompts (the next-prompt suggestion sent after every turn, the idle recap,
  the text-only summary) hold the model and effort and are not turns. Found in shadow mode: the
  suggestion request alone would have moved a Haiku session back to Opus after every turn.
- Subagents are routed by agent type at their first request (`subagentTiers`; Explore agents go to Sonnet).
- Forks are never switched: they inherit the parent's context, cache and thinking.
- A move to a cheaper model that would discard more than `holdThinkingTokens` of the current
  model's thinking is held, and effort adjusted instead.
- The user's `/effort` is a ceiling: hard turns keep it, others may run lower.
- Escalation happens only when the previous task ended on failing tool results.
- A greeting ("hi", "hello", "good morning") goes to Haiku. It usually opens a session, and whatever
  answers it writes the cache for the whole system prompt; the real task that follows pays to
  rebuild on its own model either way, so the cheapest first write wins. Neutral on the month's
  replay ($539.61 to $540.02 on the same window); it was the first thing a new user saw go wrong.
- A message carrying tool results is a loop step even when it also carries text.
- Claude Code's wrappers, notifications, compaction summaries and skill bodies are not user prompts.
- The cache TTL is read from each request's `cache_control` markers (`detectCacheTtl`).
- Optional Haiku 5.5 classifier (`--classifier haiku`), heuristic fallback.
- Trial arms for a live A/B on one agent type (`--trial`).

### Proxy
- Shadow mode forwards Claude Code's bytes untouched; the log records `forwarded` and `ranOn`.
- Requests Claude Code abandons are logged with status 499; upstream failures with 502.
- Session state persists under `~/.legato/state`.
- A per-session status file under `~/.legato/status` drives `legato statusline`.
- Everything a person reads comes from `src/words.ts`, in plain sentences: the status line
  (`Legato: switched from Opus 5.5 to Sonnet 5.5 for this task, using medium effort instead of
  xhigh · saved $0.58 this session`), the reasons in the decision log, `legato explain`, the proxy
  log and the dashboard. No arrows, no "downshift", "rebuild" or "economics"; a held switch says
  what it would have cost in dollars.
- `legato claude`: starts the proxy if needed and launches Claude Code through it as
  "Dynamic mode", with the environment that stops Claude Code assuming a 200K window for a name
  it doesn't know. Warns when the running proxy is an older build than the installed code.
- Launch aliases (`Dynamic mode`, `dynamic`, `auto`, `legato`, matched loosely): the proxy
  resolves them to a ceiling model (`modelAliases`) on every request, including background ones
  and shadow mode, logged as `forwarded: "aliased"`.
- The status line reports a request the router forwarded as sent, or one the API rejected, instead
  of claiming the session is not going through the proxy. `/health` returns the build id and pid.
- After a fail-open, neither the routed model nor the effort is recorded as having run.
- The live proxy charges the cold-cache rebuild when a hard task brings Opus back after a stretch
  on Sonnet. That request goes up unchanged, and it was priced as if Claude Code alone would have
  paid the rebuild too; the session's "saved" figure was overstated by the rebuild. On the filmed
  session: $0.84 logged, $0.52 with the rebuild charged.
- Removed the stale 64K `max_tokens` clamp for Haiku 5.5.

### Analyzer
- `legato analyze` groups tasks by kind (general-purpose agent run, ordinary coding task, Explore
  agent run, quick task, design or plan, find why something fails) and prints what each kind costs
  with and without Legato; `--json` carries the same `byKind` summary. The README's savings chart is
  rendered from it (`scripts/savings-chart`), which replaces the R and ggplot script.
- `analyze --json` includes one record per task (a user turn and the requests that follow it, or a
  subagent run) with its kind, models, effort and cost with and without routing, and the
  cumulative cost series. `scripts/charts.R` draws the README charts from it.
- Transcript reader rewritten for Claude Code 2.1.28x to 2.1.30x: per-block response lines,
  `parentUuid` branches, resumed sessions and forks, fork context references, plan-mode
  attachments, per-request effort, responses without final usage.
- `--since` skips old files before parsing; token estimation is lazy (30 days in 18s, from 6 minutes).
- Effort changes are priced on a separate, labelled line.
- Agent type and fork flag read from each subagent's `.meta.json`.

### Docs
- README: the definition, a demo film (`scripts/video`, a HyperFrames composition: a real session
  replayed from the decision log with callouts, then the month's chart drawing itself), quick
  start, how it works, and two charts of what tasks cost with and without Legato.
  `docs/REFERENCE.md` holds the commands, options and limitations.
- `.claude/agents/plain-english-reviewer.md`: an adversarial reviewer (English teacher and
  economist) for everything a person reads, including the CLI's own sentences.
