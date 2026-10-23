# Roadmap

Ordered by what the real-data evaluation ([EVALUATION.md](EVALUATION.md)) says each step is
worth, divided by its size.

## Done

- Transcript reader that matches Claude Code 2.1.3xx: per-block response lines folded into one
  request, `parentUuid` branches for rewinds and compaction, resumed sessions and forks counted
  once, fork context prepended, plan mode and per-request effort read from the files.
- Classifier and turn detection fixes: tool-result messages are loop steps; Claude Code's wrappers,
  notifications, summaries and hidden prompts (next-prompt suggestions, idle recaps) are not user
  prompts; escalation only on tasks that ended failing; the user's `/effort` is a ceiling.
- Effort without a ledger: an effort-only message appended at the tail of each request. Claude
  Code's own control message is never edited, because the first live run showed an edited copy
  costs about 11K tokens of cache writes per turn. No history edits, nothing to remember across
  requests or restarts.
- Agent awareness: agent type read from the system prompt; Explore agents routed to Sonnet at
  their first request; forks never switched; moves to a cheaper model that would discard the
  current model's thinking held.
- Session state on disk, so a proxy restart mid-session does not re-route a conversation.
- Status line per session, keyed by the `session_id` Claude Code sends in `metadata.user_id`,
  written in words.
- Every request logged, including ones Claude Code abandoned (status 499) and upstream failures
  (502), with latency.
- Haiku classifier behind `classify()` (`--classifier haiku`, needs an API key), with the
  heuristic as fallback and for the analyzer.
- Trial arms (`--trial`) for a live A/B on one agent type.
- `legato` as the one command: starts the proxy, sets up the status line, launches Claude Code as
  "Dynamic mode".

## Next

1. Run the trial on general-purpose subagents: `legato start --trial
   general-purpose=claude-sonnet-5-5/high:50` for two weeks, then compare arms on
   requests-to-finish, failing tool results per task, and how often the parent re-dispatches.
   This is the only lever worth more than about 15% of a month's usage, and the replay cannot
   measure it.
2. Effort on subagents. They run at xhigh or max. Measure requests per task by effort level from
   the trial data before lowering it.
2a. Session momentum as evidence for an upgrade: a task after a 20+ request task was big 26% of the
   time against 12% otherwise, the best offline predictor the review found. Add the previous task's
   request count to `Features` and admit it to the `strongHardScore` gate once the replay shows it
   pays.
3. Learn expected run length per user from their own transcripts instead of the
   `expectedRunRequests` constant; it is what the switch economics most depend on, and the
   classifier's tier does not predict it.
4. Context editing experiment: server-side `clear_tool_uses` with a high trigger on
   general-purpose subagents only, in shadow first, measuring re-fetches.
5. A learned router (RouteLLM-style) behind the same `classify()` interface, trained on the
   trial's outcomes and on transcript self-labels (requests, failing tool results, prompt growth
   and wall time of the task that followed), with inputs limited to what the proxy sees offline;
   a logistic model or a small decision tree shipped as frozen weights stays deterministic. One
   user's month gave AUC 0.69 for "big task" against 0.42 for the rules: real but not enough yet.
6. Release: publish to npm and put the measured trial result in the README as the headline
   number.

## Not planned

- Cache TTL changes: the 1h main-thread TTL is worth about $800/month to a heavy user as it is,
  and moving subagents to 1h costs more in write premium than it saves.
- Client-side history pruning or changing `clear_thinking keep:all`: both invalidate preserved
  thinking blocks, with a 400 on newer accounts.
- Deferring switches to cache boundaries: worth at most $171/month on the evaluation data.
