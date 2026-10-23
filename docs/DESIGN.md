# Design

## The constraint

The Claude API caches by exact prefix, per model. Claude Code re-sends the whole conversation every request and normally reads almost all of it from cache. Prices on the Anthropic API (USD per million tokens, October 2026):

| Model | Input | Output | 5m write | 1h write | Cache read |
| - | - | - | - | - | - |
| Opus 5.5 | 4 | 20 | 5 | 8 | 0.20 |
| Sonnet 5.5 | 2 | 10 | 2.50 | 4 | 0.10 |
| Haiku 5.5 (≤100K prompt) | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| Haiku 5.5 (>100K prompt) | 0.50 | 2.50 | 0.625 | 1 | 0.05 |

A cache write costs 25x a cache read on Opus and Sonnet 5.5. So a model switch on a large context is expensive, and the saving per request afterwards is small. Two consequences:

1. Between Opus and Sonnet, the arithmetic decides. On a 150K context the rebuild on Sonnet costs about $0.34, against about 3¢ saved per request (`legato explain --context 150000`).
2. Dropping to Haiku pays on small prompts: its cache writes are so cheap that even a 150K rebuild costs under $0.10, and each later request saves about 5¢ on reads and output. Above 100K tokens of prompt Haiku's prices multiply by five, so on long conversations it is rarely chosen.

Effort is different: on Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5 and Fable 5.1, a per-turn effort change keeps the cache. So effort is the free gear and model is the expensive one.

## Decision procedure

For each `/v1/messages` request:

1. Pass through if the request has no tools (Claude Code background calls such as titles) or is already on Haiku.
2. Legato changes nothing while a tool loop is running, that is, while the last message carries only tool results. Switching there would rebuild the cache for one step. Claude Code's own prompts (the next-prompt suggestion after each turn, idle recaps, summaries) are held the same way.
3. Pick a target at a user turn:
   - `//h //s //o //f` override, else the classifier's tier and effort. The classifier reads only
     the first and last 400 characters of a prompt longer than 1,200, since the rest is pasted
     content; length itself scores nothing.
   - When no classifier rule fires, there is no guess: the conversation stays on its current model
     (`noSignalTier: 'current'`) at one effort step below the user's setting. On a month of real
     use this was 42% of main-thread tasks, and guessing Sonnet for them had bought nothing the
     cache arithmetic did not already decide.
   - A "hard" verdict routes to Opus for free at a cache boundary. Paying to rebuild a warm cache
     takes a score of at least `strongHardScore` (5: two rules, not one), a previous task that ended
     in failures, or plan mode; otherwise the task runs on the current model at the user's effort.
     One keyword on a Sonnet session used to pay a median $1.67 rebuild, and the tasks it bought
     were not measurably harder.
   - Plan mode floors at `planTier` (Opus).
   - If the previous task ended with `escalateAfterErrors` or more failing tool results, step one tier above the current model.
   - A subagent's first request goes by its agent type when `subagentTiers` names it (Explore to Sonnet; general-purpose stays on the parent's model until the live trial says otherwise); a fork is never switched; a move to a cheaper model that would discard more than `holdThinkingTokens` of the current model's thinking is held.
   - Clamp to `[floor, ceiling]`; the default ceiling is the model Claude Code asked for.
4. Check the switch against the cache arithmetic (below). If a move to a cheaper model does not pay, stay and apply the classifier's effort instead.
5. Rewrite: set the model, make parameters valid for it (drop `thinking: disabled` on always-thinking models, clamp `max_tokens`, clamp effort), strip the override prefix, and set the turn's effort.

## Switch arithmetic

Let `C` be the prompt size, `g` the expected growth per request (EWMA of observed growth), `o` the expected output per request (EWMA), and `r`, `w`, `out` the read, write and output prices of the current model (subscript `f`) and target (subscript `t`). `W` is the target's warm prefix if it served this conversation within the TTL, else 0.

Cost of this request if we stay:

    stay = (C − g)·r_f + g·w_f

Cost if we switch:

    switch = W·r_t + (C − W)·w_t

Rebuild premium: `R = switch − stay`.

Saving on each later request:

    s = (C − g)·(r_f − r_t) + g·(w_f − w_t) + o·(out_f − out_t)

Expected cost of coming back to the current model later after its cache expired:

    B = p_return · C · w_f

Move to the cheaper model when:

    s · N − R − B ≥ minNetSavings

with `N = expectedRunRequests` (default 8, counting tool-loop steps) and `p_return = returnProbability` (default 0.3).

A switch is free (no gate) when there is no cache to lose: the conversation's first request, the current model's cache older than the TTL, or `C < freeSwitchTokens`.

## Setting the effort

Claude Code attaches a `role: "system"` control message to each user turn, under the `per-turn-control-2026-07-01` beta. It carries the environment block, the tool definitions added that turn and `output_config.effort`. On the turn's first request it is the tail of the request; on every later request of the turn Claude Code re-sends it unchanged, in place, with the loop's assistant and tool-result messages after it.

Legato never edits that message. It appends its own effort-only message `{"role":"system","content":[],"output_config":{"effort":"low"}}` at the tail of every request whose effort differs from what Claude Code asked. Claude Code never sees the appended message, so each request's history is byte-identical to the previous request's prefix, and the proxy appends again. Nothing has to be remembered between requests, and a proxy restart changes nothing.

The first live run set the effort on Claude Code's control message instead, when it was the tail. The cost showed up on the next request of each turn: one subagent read 5.6K of its 16.6K cached tokens, another 20.6K of 31.6K, while an agent whose effort was left alone read all of its 31.9K. Claude Code had re-sent its message with the original effort, so the edited copy broke the cached prefix at that point and about 11K tokens, the environment block and tool definitions, were written again. At Opus's 1-hour cache write price of $8 per million tokens, across the 613 effort changes a month in the evaluation data, that is about $54, roughly what the effort changes were assumed to save ($58).

An earlier version inserted effort messages into the history and tracked them in a ledger keyed by message index. It worked until Claude Code's control message moved between requests; the ledger's anchors then drifted and its entries were dropped silently. Editing only the tail removed that failure mode.

## Conversation identity

The key is a hash of `metadata.user_id` (which carries Claude Code's session id), the system prompt, the first message, and the position of a fork's boilerplate. Subagents share the session id but have their own system prompt and task, so each gets its own state, and each subagent's first request is a free routing choice. A fork re-sends its parent's history and gets its own key, so it is held on the parent's model.

## Accounting

The proxy records the cost of what ran and a counterfactual "unrouted" cost. After a switch, the unrouted model's cache would still have been warm, so the counterfactual re-prices the request's cacheable tokens as reads up to the size the unrouted model last saw. In shadow mode the reverse applies.

The analyzer replays transcripts through the same engine with exact measured prompt sizes. For a routed request on a different model than the previous one, cached tokens are re-priced as reads only up to what that model last saw within the TTL, and only up to what the real request read; the rest become writes. Output tokens are held constant and effort savings are not counted, so savings estimates are conservative on cost. Quality is not measured.

## What a native implementation could do better

- Route on hidden state the proxy can't see (the model's own uncertainty, tool-call plans).
- Share cache prefixes across models for the system prompt and tool definitions, if the serving stack allowed it, which would remove most of the switching penalty.
- Learn `N` and `p_return` per user.
- Show the routed model in the UI and let users veto a switch inline.
