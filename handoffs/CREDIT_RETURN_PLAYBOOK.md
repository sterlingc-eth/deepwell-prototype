# Credit-return playbook (ROUND 20, J4)

What to do the day Anthropic credits come back, in order. Nothing in here has been run for real —
credits are out this whole round (R11_RULES.md/R20_CONTRACT.md hard rule: nothing built this round may
require a live model call to test) — every number below is either a token-count estimate
(`scripts/model-ab.mjs`'s dry-run) or a design decision, never a measured result. Follow this in order;
do not skip straight to a full live run.

## 0. What R20 shipped, and what's still off by default

- `api/_lib/planner/validate.js` — rejects a MODEL-produced analytics plan that drops a stated
  condition, invents a filter value, or (once wired) names an entity id outside the tenant. Already
  wired into `planAnalyticsQuestion` (`api/_lib/routes/analytics.js`) — **live the moment credits
  return**, no flag to flip.
- `api/_lib/planner/spend.js` — a per-tenant daily **$** cap (`assertDailySpend`/`recordDailySpend`),
  generalized from `agent/escalation.js`'s existing Sonnet cap so any route gets its own ledger in the
  same `rate_limit_windows` table (no migration). **NOT yet enforced for the analytics planner** — see
  the one-line hook below. The research agent (`agent/loopV2.js`) and v1 escalation (`agent/loop.js`)
  already had their own per-tenant $ caps before this round; those are unchanged.
- Prompt caching on the analytics planner's system prompt + tool schema — wired
  (`planCacheBreakpoints`, same mechanism `agent/loopV2.js` already used). **Honest finding from
  `scripts/verify-spend-control.mjs`: today's DEFAULT prompt (no tenant-vocab match, no learned
  few-shot) is ~1950 estimated tokens combined — under Haiku's real 4096-token cache minimum, so this
  is a no-op (byte-identical request) until a tenant's `tenantVocab`/overlay few-shot pushes it past
  that.** It activates correctly once large enough (tested); it does not save anything by itself today.
- `scripts/model-ab.mjs` — dry-run works today (no credits needed); `--live` mode is written against
  `scorecard/runner.js`'s existing `runScorecard` but has never executed against a real key.

### The one-line hook to turn the analytics $ cap on live

`planAnalyticsQuestion` (routes/analytics.js) already accepts optional `withTenant`/`ctxArg` and will
enforce `planner/spend.js`'s `analyticsPlanner` daily cap the moment they're passed. Its only call site
today is inside `runAnalyticsQuestion`, around:

```js
const plan = await planAnalyticsQuestion(question_n, { today, overlay, tenantVocab });
```

Change to:

```js
const plan = await planAnalyticsQuestion(question_n, { today, overlay, tenantVocab, withTenant, ctxArg });
```

(`withTenant`/`ctxArg` are already in scope in `runAnalyticsQuestion` — they're its own parameters.)
This is a J3-owned file outside J4's model-call-section ownership, so it wasn't made this round; it's a
five-minute change once someone with edit rights there is ready, and nothing else needs to change (the
function fails open with it absent, exactly as it does today).

## 1. Confirm credits are actually back (before anything else)

1. One real `messages.create` call, smallest possible (`max_tokens: 10`, no tools) — via a throwaway
   script or the existing scorecard smoke path. Confirm `classifyProviderError` (claude.js) sees no
   error and `getProviderOutage()` returns `null`.
2. `curl`/dashboard-check the actual Anthropic billing page — a single successful call does not prove
   the account is genuinely funded for a real run's volume.

## 2. Dry-run sanity check (still $0 — do this even if you're confident)

```
node scripts/model-ab.mjs handoffs/<latest-export>.json --budget=5
```

Confirms: the rules-only pass still gets the exam's current floor (936/1068 correct per the R20
contract's own scoreboard — **must not have regressed**; if it has, something in this round's other
engineers' work broke a no-model path and that is a bigger problem than credits), and prints the
current needs-model rate and its estimated $ cost by category. Sanity-read the `by category` table —
`history`/`warranty`-shaped categories are the expensive ones (research-agent, multi-turn); `counts-*`/
`two-condition`/`lists` are cheap (one analytics-planner call). If the estimated total for the full
1304-question set is wildly outside a few dollars, stop and re-check `estimateAgentRunCostUsd`'s
assumptions (`--agent-avg-turns`) against reality before spending anything for real.

## 3. First live run — small, capped, on the sets that matter most

Owner priority for this round was blind generalization (fp-2/fp-3) and multi-turn dialogues — run
those FIRST, not the full 746-question base exam (that floor is already well-established at $0; the
question a live run answers is "does turning the model on help or hurt the NOVEL phrasing the base exam
can't test").

```
node scripts/model-ab.mjs handoffs/<fp-2-and-fp-3-export>.json --live --budget=2 --out=handoffs/first-live-run.json
```

Then, separately:

```
node scripts/run-dialogues.mjs
```

(dialogues run through the real `/api/ask` handler already — no model-ab wiring needed for those; just
confirm `DONOVAN_ESCALATION`/`DONOVAN_RESEARCH_AGENT` aren't force-disabled in the environment this runs
in.)

Budget: **$2 for the first fp-2/fp-3 pass.** That is deliberately tiny — model-ab's own dry-run estimate
(step 2) tells you roughly how many questions that buys; if it's fewer than ~20-30, raise to $5, never
skip straight to the full budget scorecard already uses elsewhere (`DONOVAN_SCORECARD_BUDGET_USD`,
default $5, which is sized for the FULL exam, not a first live smoke test).

## 4. Go / no-go thresholds

Read `model-ab.mjs --live`'s own report. In order of how much they matter:

1. **`newConfidentWrong` must be empty, or every single one manually reviewed and understood before
   proceeding.** This is the R20 contract's own hard rule ("the model path must not add confident-wrong
   answers") made concrete: any question the rules-only pass had no answer for (needs-model/needs-grader
   /skipped) that came back BOTH graded and WRONG once the model ran. One is enough to stop and
   investigate — this is exactly the false-confidence failure mode this whole round exists to prevent,
   just moved to the model side of the fence instead of the deterministic-router side.
2. **Accuracy on the graded (correct+wrong) subset must not be below the rules-only pass's own accuracy
   on the SAME question ids** (not the overall exam average — the rules-only pass answers a different,
   easier subset for free; compare like for like: only ids where BOTH passes actually produced a graded
   answer).
3. **$/question by category should roughly match model-ab's dry-run estimate** (within, say, 3x — this
   isn't a hard gate, it's a signal that `estimateAgentRunCostUsd`'s assumptions were reasonable, or that
   something is looping/retrying more than expected). A large miss here is worth understanding before
   raising the budget further, even if accuracy/confident-wrong both look fine.
4. **Latency**: `agent/loopV2.js`'s own bounds (turn/tool-call/token/deadline caps, all unchanged this
   round) are the real enforcement; model-ab's `p50` per category is diagnostic only, not a gate.

**No-go** on (1) alone: disable the offending path (`DONOVAN_RESEARCH_AGENT=0` and/or
`DONOVAN_ANALYTICS_DAILY_USD=0`, whichever route the confident-wrong came from — model-ab's report
names it) and file what the wrong answer actually was as a new rule/guard, the same way this whole
project's learning loop already treats every other miss.

**Go** on all four: raise `--budget` gradually (2x per run, watching the same four checks each time)
before ever pointing this at the full exam or turning any of these routes on for live customer traffic
without a cap. Turn the analytics $ cap on live (section 0's one-line hook) at the same time you do
this, not after — an uncapped route being A/B tested for the first time is exactly the wrong moment to
also be uncapped.

## 5. Budgets and env vars this round added or touched

| Env var | Default | Route | Notes |
|---|---|---|---|
| `DONOVAN_ANALYTICS_DAILY_USD` | $1 | analytics planner | new (`planner/spend.js`); not enforced until the hook in section 0 lands |
| `DONOVAN_RETRIEVAL_DAILY_USD` | $5 | retrieval+Haiku answer | new bucket name reserved in `planner/spend.js`; **nothing calls `assertDailySpend`/`recordDailySpend` for this route yet** — retrieval's own call site in `api/ask.js` is outside J4's ownership this round, so this is a documented reservation, not a live cap |
| `DONOVAN_SONNET_DAILY_USD` | $2 | v1 escalation | unchanged, pre-existing (`agent/escalation.js`) |
| `DONOVAN_RESEARCH_DAILY_USD` | $10 | v2 research agent | unchanged, pre-existing (`agent/loopV2.js`) |
| `DONOVAN_PER_QUESTION_MAX_USD` | $0.50 | reporting only | `planner/spend.js`'s `withinPerQuestionBudget` — not an enforced cap anywhere yet; loopV2's own per-question TOKEN cap (120k input) is the real enforced ceiling, this is its $ translation for reporting |
| `--budget` (model-ab.mjs) | $5 | the A/B run itself | hard stop, both in dry-run (stops estimating) and `--live` (passed straight to `runScorecard`'s own budget enforcement — nothing reimplemented) |

## 6. What to measure and keep

- Every `model-ab.mjs --live` run's `--out` JSON — keep it (small, no question text beyond exam ids
  already public in `test-docs/scorecard/`, real category $/latency figures worth trending over time).
- The `cost_usd`/`cache_read_share` line `routes/analytics.js`'s `planAnalyticsQuestion` now logs on
  every real call, and the `cost_usd`/`cache_read_input_tokens`/`cache_creation_input_tokens` fields
  `agent/loopV2.js`'s own run-summary log line now carries — both new this round, both already flowing
  to Vercel logs the moment credits return, no dashboard work needed to start collecting them.
- Whether prompt caching ever actually engages for the analytics planner in production (check
  `cache_read_share > 0` in that log line across a day's traffic) — per section 0's honest finding, it
  won't for a tenant with a small `tenantVocab`/few-shot footprint, and that's expected, not a bug.
