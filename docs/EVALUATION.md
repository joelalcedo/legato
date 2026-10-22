# Evaluation on real usage

Everything here comes from replaying one developer's `~/.claude/projects` transcripts through the
same `decide()` the proxy runs, with cache rebuilds priced at API list prices. The replay is
`legato analyze`; the method is in [DESIGN.md](DESIGN.md). Numbers are from a Claude Max
subscription, so "dollars" means usage at list prices, not money the developer would have paid.

## The data

The README charts use the month from 21 Sep to 22 Oct 2026: 280 sessions, 446 subagent runs,
52,217 API requests, 1,552 tasks and $5,166 of usage at list prices on current models. The
analysis below was done on the month to 21 Oct (267 sessions, 443 subagent runs, 51,895
requests, $5,109) and has not been re-run; where a figure differs between the two, the
difference is one more day of data. The same account's previous window (18 Sep to 18 Oct) was
$5,457 and included several sessions started on Fable 5.1.

Where the money goes, measured on the raw ledger ($4,921 is what the models that actually ran
cost; $5,109 re-prices the same traffic on today's models):

| Component | Share |
| - | - |
| Cache reads | 61.6% |
| Cache writes | 28.1% |
| Output tokens | 10.3% (a lower bound: 69% of responses never had their final usage written) |
| Uncached input | 0.0% |

Cache reads on prompts over 200K tokens are 52% of spend on their own. Main-thread user turns
arrive with a mean context of 387K tokens. Subagents are 66% of spend; general-purpose agents
alone are 55% (310 agents, mean 106 requests each, mean prompt 276K tokens).

Two consequences shape the policy:

- At 387K tokens a switch from Opus to Sonnet rebuilds the cache for $0.88 with a 5-minute cache
  or $1.46 with a 1-hour one (`legato explain --context 387000`), to save about 6¢ per request.
  A paid move to a cheaper model on a long main thread never pays for itself.
  What works there is effort, which is free, and switches at boundaries where no cache exists:
  the first request of a conversation, every subagent start, after compaction, after the cache
  has expired.
- Haiku 5.5 is out of reach for 43,000 of the 51,895 requests (83%): above 100K tokens of prompt
  its prices multiply by five.

## Results

Each row keeps the fixes of the rows above it; the window stays the same until a row names a new
one. "Saved" is against the same traffic on the same models with no routing, after paying for
every cache rebuild.

| Policy | Window | Saved (share of list-price usage) | Switches, of which free | Paid for cache rebuilds |
| - | - | - | - | - |
| As first written, 5m TTL assumed | Sep 18 to Oct 18 | $160 (2.9%) | 412 (302) | $752 |
| + a message carrying tool results is a loop step, never a turn | | $166 (3.0%) | 391 | $748 |
| + strip Claude Code's wrappers and notifications from "user text" | | $397 (7.3%) | 318 | $558 |
| + fix false positives ("0 failed", "profile", "security master") | | $428 (7.8%) | 313 | $541 |
| + treat "how come" and "why would" as asking for a cause: costs $105 of saving, and the replay cannot show whether the answers improved | | $323 (5.9%) | 325 | $586 |
| + escalate only when the previous task *ended* failing | | $572 (10.5%) | 289 | $476 |
| + read the cache TTL per conversation (1h main thread, 5m subagents) | | $687 (12.6%) | 164 | $93 |
| + the user's /effort is a ceiling; forks inherit the parent's context | | $691 (12.7%) | 163 | $89 |
| Same policy, next window | Sep 21 to Oct 21 | $473 (9.3%) | 151 (117) | $82 |
| + route Explore subagents to Sonnet by type; hold forks; hold moves to a cheaper model that would drop thinking | Sep 21 to Oct 21 | $504 (9.9%) | 173 (139) | $82 |
| Same policy, the window the README charts show | Sep 21 to Oct 22 | $529 (10.2%) | 180 (143) | $86 |
| Same policy, same window a day later (286 sessions) | Sep 21 to Oct 22 | $540 (10.4%) | 184 (145) | $91 |
| + greetings go to Haiku | Sep 21 to Oct 22 | $540 (10.4%) | 186 (147) | $91 |

The gap between 12.7% and 9.9% comes from the data: the earlier window had sessions
started on Fable 5.1, which the router moves to Opus at the first request, and that one kind of
switch was 46% of its savings. On sessions started on Opus the saving is about 8% in both windows.

By kind of task, in the README's window (a task is a user turn and the requests that follow it,
or one subagent run; costs at list prices, rebuilds included; the mean is what the chart shows,
the median is given because a few long runs pull the means up):

| Task | Count | Mean, Claude Code alone | Mean, with Legato | Median, alone | Median, with Legato | Saved per task | Saved in all |
| - | - | - | - | - | - | - | - |
| General-purpose agent run | 338 | $8.51 | $7.71 | $4.88 | $4.35 | $0.80 | $271 |
| Ordinary coding task | 703 | $1.74 | $1.40 | $0.69 | $0.57 | $0.34 | $242 |
| Explore agent run | 26 | $2.42 | $1.21 | $2.17 | $1.09 | $1.20 | $31 |
| Quick task (commit, find a file) | 13 | $2.84 | $0.71 | $1.71 | $0.34 | $2.13 | $28 |
| Design, plan or large change | 82 | $1.95 | $2.00 | $1.28 | $1.18 | -$0.04 | -$4 |
| Find why something fails | 370 | $0.85 | $0.97 | $0.36 | $0.35 | -$0.12 | -$43 |

The two hard kinds cost more with Legato because a hard task that arrives while the conversation
is on Sonnet pays the rebuild to bring Opus back. The earlier switch to Sonnet already priced that
return in (`returnProbability`), so the pair is still ahead; the per-task view just lands the bill
on the hard task.

In the month to 21 Oct the router declined 498 moves to a cheaper model because the rebuild would
have cost more than the cheaper model saved. Effort changes: 613 turns run at a lower effort than the
user's setting, on the same model. If output tokens scale with effort as `effortOutputScale`
assumes, those are worth another $58; the headline leaves that out because it is an assumption.

## Reading the real decisions

Before the parser and classifier fixes, 13 of 18 sampled decisions were wrong; the sample has not
been re-read since. The causes, in order of cost:

1. Machine text treated as the user's prompt: task notifications, compaction summaries, a skill's
   body loaded by a slash command, image captions inside tool results. One task notification
   escalated a session to Fable for a $7.50 rebuild. Only 44% of what looked like user turns were
   typed by the user. Shadow mode later added two more: the next-prompt suggestion Claude Code
   requests after every turn, and its idle recap.
2. A switch inside a tool loop. Claude Code attaches text (an image caption, a queued "Status?")
   to the message that carries tool results. Treating that as a new turn switched models
   mid-loop, rebuilding the cache for one step.
3. The wrong cache TTL. A subscription's main thread caches for 1h; subagents for 5m. With 300s
   assumed, "free switch: cache expired" was claimed on 277K-token contexts that were warm.
4. Escalating on recovered failures. 202 of 221 escalations were for tasks whose failing test had
   already gone green before the user's next message.
5. Classifier false positives: "profile" as performance work (it was a user-profile screen),
   "security master" as infosec (it is finance reference data), "0 failed" as a failure.

## What the replay cannot see

- Quality. Output length is held constant across models, and a cheaper model may take more turns
  to finish the same task. The `trial` config exists to measure this live: it routes a share of
  one agent type to another model and logs the arm, so requests-to-finish and error rates can be
  compared between arms.
- Output tokens. Claude Code stops writing a response's transcript lines before the final token
  count arrives, mostly in subagents. 69% of responses are affected; their output is undercounted,
  so every cost here is a lower bound.
- Thinking. Thinking blocks are readable only by the model that wrote them or a stronger one. A
  switch from Opus to Sonnet mid-session discards Opus's earlier reasoning silently. The router
  holds such a switch when more than `holdThinkingTokens` of thinking would be dropped; on this
  data the rule never fired, because the economics already held every such switch.

## Where the remaining money is

Measured on this data, ranked by what it is worth:

| Lever | Worth per month | Status |
| - | - | - |
| General-purpose subagents on Sonnet/high instead of Opus/xhigh | $1,355 a month if Sonnet takes no more requests than Opus; a guess of a third of that, about $400, if it takes more | Needs the live `trial`; the replay cannot judge quality |
| Lower effort on subagents (they run at xhigh/max) through fewer tool-loop steps | about $300 if a 10% reduction in requests holds | Unmeasured; needs live data |
| Lower effort on the main thread | about $58 a month, if output shrinks with effort as `effortOutputScale` assumes | Shipped; the saving is unmeasured |
| Context editing (`clear_tool_uses`) on long subagent runs | up to $300 to $500 before counting re-fetches | Experiment only; Anthropic's own trial found re-fetches made it a net loss |
| Explore subagents on Sonnet | $31 | Shipped |
| Cache TTL changes | none to make: the 1-hour main-thread cache is already worth about $800 a month | Nothing to do |
| Deferring switches to boundaries | at most $171 | Not worth a mechanism |
