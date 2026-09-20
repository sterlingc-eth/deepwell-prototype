# /api/ask latency — 2026-09-20

Owner report: 2.1–4.9s per question on Haiku, 7 documents. Retrieval SQL is
indexed (GIN tsv/trgm), so with a corpus this small the cost is (a) serial DB
round trips through `withTenant()`, (b) the one Anthropic call (output
tokens), (c) cold starts (Vercel + Neon). This is instrumentation + fixes for
(a) and a trim of (b); (c) needs an owner decision (section 4).

## 0. What `withTenant()` actually costs (read first)

`api/_lib/recordsStore.js` `withTenant()`:
```
client = pool.connect()      -- checkout (fast once the pool has a warm client)
BEGIN                        -- round trip
SELECT resolve_tenant($1,$2) -- round trip
SELECT set_config(...)       -- round trip
<fn's own queries>
COMMIT                       -- round trip
client.release()
```
Every `withTenant()` call is **4 round trips of pure transaction bookkeeping**
before a single real query runs, on top of whatever `fn` itself queries.
`api/ask.js`'s main path called it up to **4 separate times** (gate check,
optional customer-number scope, retrieval, audit) — up to 16 bookkeeping
round trips, fully serial, before counting a single `searchPassages` call.

## 1. Instrumentation

`api/_lib/timing.js` (new): `startTimer()` / `timer.time(name, fn)` /
`timer.add(name, ms)` / `formatServerTiming(map)`. Stages can run
**concurrently** (see below), so each stage measures its own start-to-finish
wall time rather than "time since the last mark" — two overlapping stages
both report their real cost and can legitimately sum to more than `total`;
that's the signal that they overlapped rather than chained.

`api/ask.js` now tracks `auth, limit, gate, scope, retrieve, budget, model,
bookkeeping, total` and:
- always emits them as a `Server-Timing` response header (ms only, no PII —
  visible in any browser's Network tab or via `curl -sD- ... | grep -i
  server-timing`),
- folds the same snapshot into the existing `modelCallLogLine` JSON
  `console.log` as `timings_ms` (`api/_lib/promptCache.js`, backward
  compatible — every other caller that doesn't pass `timingsMs` gets the
  exact same line as before),
- adds `data.timingsMs` to the JSON body **only** when
  `ASK_DEBUG_TIMINGS=1` is set (Vercel env var, no redeploy needed to
  toggle) — turn this on briefly in production to get real per-stage numbers
  instead of the estimates below.

## 2. Round-trip cuts (behavior/ordering unchanged)

- **checkAskGate**: was 2 sequential queries inside one `withTenant`
  (tenant row, then `countDocuments()`). Now 1 query (a small `SELECT` with
  two sub-selects) — same two facts, one round trip.
- **searchPassages + searchExtractions**: run with `Promise.all` (were
  sequential `await`s) inside the retrieval `withTenant`.
- **Customer-number scope + retrieval**: collapsed from 2 `withTenant` calls
  into 1 (`retrieveEvidence()` in `api/ask.js`) — scope resolution still
  runs first (retrieval needs its result as a filter) but no longer pays a
  second BEGIN/resolve_tenant/SET LOCAL/COMMIT to do it.
- **gate check + retrieval now run concurrently** on separate pool
  connections (pool max is 5 — see `recordsStore.js` `getPool()` — so 2–3
  concurrent connections is well within budget), instead of gate first, then
  retrieval after. Wall time for this phase drops from
  `gate_time + retrieve_time` to roughly `max(gate_time, retrieve_time)`.
- **assertModelBudget** (`getDailyModelBudgetStatus`, already a single
  combined round trip) is fired at the same time as the two above, and only
  actually `await`ed right before the model call — same enforcement point as
  before, just no longer stacked serially after gate+retrieval.
- **`limit()`** (rate limiting) is left first and sequential, unchanged — it
  writes its own 429 and must do so before anything else can respond.
- **Response-first bookkeeping**: `recordModelCall` (usage accounting) and
  the `document.queried` audit write now run **after** `res.json()` sends
  the answer, via `Promise.allSettled` (each already wrapped in its own
  `.catch`, same non-fatal semantics as before — a write failure here still
  never surfaces to the customer). Vercel keeps the function alive until the
  handler's own promise resolves, so this work still completes reliably; it
  just no longer sits between "model answered" and "customer sees it." This
  alone removes one `withTenant` (4 round trips + an INSERT) and one aux-pool
  call (2 round trips) from the critical path.

Net: the non-meta happy path went from **up to 4 serial `withTenant` calls**
(≈16 bookkeeping round trips alone, before any real query) to **1 on the
critical path** (retrieval) **+ 1 overlapped, not serial** (gate) **+ 1
after the response is already sent** (audit), plus a rate-limit check that
was already 1 aux-pool round of queries and is unchanged.

## 3. Output-token trim (`api/_lib/answer.js`)

- `ANSWER_TOOL.input_schema.properties.facts.maxItems = 5` — a dispatcher
  acts on the handful of facts that answer the question, never a dump of
  everything retrieval found. RULES now says so explicitly ("Return at most
  5 facts").
- `text`: "1–3 sentences" → "1–2 sentences" in both the schema description
  and RULES.
- Dropped `sources[].excerpt` from the schema entirely — nothing downstream
  ever reads it (`src/components/SourceList.tsx` renders from the
  locally-synced document via `documentId`/`location`, never from the
  answer payload's own excerpt; confirmed by reading `AnswerCard.tsx`,
  `FactGrid.tsx`, `SourceList.tsx`, and `answerService.claude.ts`'s
  `normalizeAnswer`). One less place for the model to spend output tokens
  re-copying passage text into.
- **Sourcing rules unchanged**: every fact still requires a grounded
  citation checked by `shapeAnswer()` (`sourceIsGrounded`), `basis` still
  defaults to `"printed"` and requires caller opt-in for `"computed"`, and
  the no-answer/closest-documents fallback is untouched. Nothing here
  weakens what a citation has to prove.
- `SYSTEM_PROMPT` is still **2345 est. tokens** (was 2306) — comfortably
  above Haiku's 2048-token cache-eligibility minimum
  (`api/_lib/promptCache.js` `CACHE_MIN_TOKENS.haiku`, see
  `handoffs/COST_REPORT_2026-09-20.md`). The RULES additions above added
  text, not less, so the cache breakpoint is unaffected — checked in
  `scripts/verify-caching.mjs`.

## 4. Two things only the owner can do

**(i) Confirm the Neon project region matches the Vercel function region.**
Every round trip this doc talks about pays actual network latency between
Vercel's compute and Neon's — same-region that's low single-digit ms per
round trip; cross-region (e.g. US east compute talking to a US west or EU
database) it can be 30–100ms+ **per round trip**, which turns even the
already-cut retrieval path into real, visible latency.
- Vercel: Project → Settings → Functions → Function Region. Hobby plan
  defaults to `iad1` (Washington, DC, US East) and that can't be changed on
  Hobby — `api/ask.js`'s `export const config` could set `regions: [...]`
  but that option only takes effect on a Pro plan or above.
- Neon: Project → Settings → General → Region (or the region shown next to
  the connection string in the Neon console).
If they don't match, either move the Neon project to the matching region
(Neon supports this via a new branch/project in that region + cutover) or
upgrade Vercel to pin `regions` to Neon's region — whichever is cheaper for
the account.

**(ii) Neon compute auto-suspend.** The Free plan suspends compute after 5
minutes idle; the first request after any idle gap pays a multi-second
cold-start reconnect on top of everything above — this alone could be most
of the reported 4.9s tail. The Neon **Launch** plan (or higher) lets you
raise the suspend timeout or disable auto-suspend entirely. If most of the
production complaints are "the first question after a while is slow, then
it's fine," this is almost certainly why — turn on `ASK_DEBUG_TIMINGS=1`
and compare `timings_ms` on a cold first call vs. a warm second call to
confirm before paying for the plan change.

## Why a separate bucket/store per organization would NOT make this faster

Not asked for here, but worth heading off: sharding storage per tenant
wouldn't touch any of the above. (1) Every tenant's rows are already
isolated by RLS plus `tenant_id`-leading indexes in Postgres, and by a
per-tenant key prefix in R2 — a second tenant's data is never scanned or
read today, sharded or not. (2) A GIN/trgm index lookup is `O(log n)` in the
size of *that tenant's* matching rows, not the whole table, so another
tenant having more or fewer rows doesn't change this tenant's query cost.
(3) Every millisecond measured above comes from transaction round trips and
the model call, neither of which is a function of corpus size at all — a
tenant with 7 documents and a tenant with 7,000 pay the same per-`withTenant`
overhead and the same Anthropic latency for the same question.

## 5. Verification

- `npm run typecheck:api` — clean.
- `npm run verify:all` — all green (19 suites).
- `scripts/verify-caching.mjs` extended (pure, no DB, part of `verify:all`):
  `formatServerTiming` formatting/edge cases, `timer.add`/`timer.time`
  accumulation and exception-safety, `ANSWER_TOOL.facts.maxItems === 5`, no
  `excerpt` field on fact sources, `SYSTEM_PROMPT` still names the 5-fact
  cap, and `SYSTEM_PROMPT` still clears Haiku's cache minimum.
- `scripts/verify-retrieval.mjs`'s no-DB meta-router checks still pass
  (confirms `api/ask.js` still imports and classifies correctly after the
  refactor); its DB-backed checks are unchanged and untested here (no Neon
  connection in this environment — same as before this work).

## Files touched

- `api/ask.js` — timing instrumentation, concurrent gate/budget/retrieval,
  collapsed `withTenant` calls, response-before-bookkeeping.
- `api/_lib/timing.js` (new) — `startTimer`/`formatServerTiming`.
- `api/_lib/promptCache.js` — `modelCallLogLine` gained an optional
  `timingsMs` param.
- `api/_lib/answer.js` — `ANSWER_TOOL` facts `maxItems: 5`, dropped
  `sources[].excerpt`, tightened `text` length and RULES wording.
- `scripts/verify-caching.mjs` — new pure tests (see above).
