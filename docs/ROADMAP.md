# Roadmap

Ordered by what the real-data evaluation ([EVALUATION.md](EVALUATION.md)) says each step is
worth, divided by its size.

## Done

- **Transcript reader that matches Claude Code 2.1.3xx.** Per-block response lines folded into
  one request, `parentUuid` branches for rewinds and compaction, resumed sessions and forks
  counted once, fork context prepended, plan mode and per-request effort read from the files.
- **Classifier and turn detection fixes.** Tool-result messages are loop steps; Claude Code's
  wrappers, notifications and summaries are not user prompts; escalation only on tasks that
  ended failing; the user's `/effort` is a ceiling.
- **Effort without a ledger.** The per-turn control message Claude Code sends is rewritten in
  place: no inserted messages, no history edits, nothing to remember across requests or restarts.
- **Agent awareness.** Agent type read from the system prompt; Explore agents routed to Sonnet
  at their first request; forks never switched; downshifts that would discard the current
  model's thinking held.
- **Session state on disk**, so a proxy restart mid-session does not re-route a conversation.
- **Status line per session**, keyed by the `session_id` Claude Code sends in `metadata.user_id`.
- **Every request logged**, including ones Claude Code abandoned (status 499) and upstream
  failures (502), with latency.
- **Haiku classifier** behind `classify()` (`--classifier haiku`, needs an API key), with the
  heuristic as fallback and for the analyzer.
- **Trial arms** (`--trial`) for a live A/B on one agent type.

## Next

1. **Run the trial on general-purpose subagents.** `legato start --trial
   general-purpose=claude-sonnet-5-5/high:50` for two weeks, then compare arms on
   requests-to-finish, failing tool results per task, and how often the parent re-dispatches.
   This is the only lever above ~15%, and the replay cannot measure it.
2. **Effort on subagents.** They run at xhigh or max. Measure requests per task by effort level
   from the trial data before lowering it.
3. **Learn expected run length per user** from their own transcripts instead of the
   `expectedRunRequests` constant; it is what the switch economics most depend on, and the
   classifier's tier does not predict it.
4. **Context editing experiment.** Server-side `clear_tool_uses` with a high trigger on
   general-purpose subagents only, in shadow first, measuring re-fetches.
5. **A learned router** (RouteLLM-style) behind the same `classify()` interface, trained on the
   trial's outcomes.
6. **Release.** A demo recording of a session with the status line switching, and the measured
   trial result as the headline number.

## Not planned

- Cache TTL changes: the 1h main-thread TTL is worth ~$800/month to a heavy user as it is, and
  moving subagents to 1h costs more in write premium than it saves.
- Client-side history pruning or changing `clear_thinking keep:all`: both invalidate preserved
  thinking blocks, with a 400 on newer accounts.
- Deferring switches to cache boundaries: worth at most $171/month on the evaluation data.
