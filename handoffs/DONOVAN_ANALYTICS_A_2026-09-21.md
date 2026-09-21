# Workstream A — Donovan analytics (aggregate NLP questions), 2026-09-21

Built per `handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md`'s Workstream A design.
Standing constraints honored: no git, no DDL, no new deps, Haiku only, exactly
12 files directly under `api/` (unchanged — everything new lives under
`api/_lib/`).

## Reviewer round 1 — two NO-GOs fixed (2026-09-21)

**A1 — the classifier's own "bypass" rules skipped the vocabulary check.**
`WHICH_CUSTOMERS_RE`/`WHO_SERVICED_RE`/`GROUP_SHAPE_RE` returned `true`
directly, without the generic `AGGREGATE_NOUN && CONTEXT` check every other
phrasing goes through. "Which customers are at 1234 Main St, Mesa AZ?"
matched `WHICH_CUSTOMERS_RE` and got pre-classified as analytics; since
"address" isn't in the closed field vocabulary, the planner had nothing to
filter on and produced an unfiltered `list customers` plan — every customer
in the tenant, returned as a confident answer to what was really a
single-record lookup. Fixed two ways:
- **(a) Classifier** (`api/_lib/analytics.js` → `looksLikeSingleRecordReference`,
  called first in `preClassifyAnalytics`, before any trigger regex —
  including the bypasses — gets a chance to fire): a question containing a
  street-address pattern or a serial/model-shaped token (an alnum token ≥ 8
  chars with a digit) is never pre-classified as analytics, full stop.
- **(b) Executor guard** (`api/_lib/analytics.js` →
  `suspiciousUnfilteredCustomerPlan`, applied in
  `routes/analytics.js`'s `runAnalyticsQuestion` right after the plan comes
  back, before executing it): defense-in-depth — an unfiltered `list`/`count`
  plan over `customers` for a question that names any number of 2+ digits
  (a street number, a ZIP, a serial fragment the classifier's regex didn't
  happen to catch) is treated as suspicious and falls through to
  retrieval+model rather than confidently answering "every customer".
- 12 new adversarial checks added to `scripts/verify-analytics.mjs` (7
  single-record cases that must NOT be analytics — addresses with and without
  a recognized street suffix, serial/model tokens, a bare tonnage question
  with no location context — plus 5 controls that must STILL be analytics:
  "how many customers in Mesa", "which customers have Trane units", "list
  customers in Pinal County", "which customers have Goodman equipment", "how
  many customers do we have in Pinal County"). All pass.

**A2 — analytics answers shared the retrieval cache's key AND prompt
version.** `runAnalyticsQuestion` was calling `askCache.js`'s
`getCacheEntry`/`upsertCacheEntry` with `api/ask.js`'s shared
`questionHash` — the SAME hash the retrieval+model path caches under — and
`getCacheEntry` always mixed in `askCache.js`'s own `PROMPT_VERSION` (derived
from the RETRIEVAL system prompt + `ANSWER_TOOL`, nothing to do with
analytics). Two real bugs: a question previously cached via retrieval that
the classifier now routes to analytics would return that stale, wrongly-
shaped retrieval answer as a "hit"; and a future change to this file's own
prompt/schema had no way to invalidate old analytics cache rows, since the
shared corpus_stamp only reacts to retrieval's prompt changing. Fixed:
- `api/_lib/analytics.js` now derives its own `ANALYTICS_PROMPT_VERSION`
  (sha256 of a version constant + `ANALYTICS_TOOL` + `ANALYTICS_SYSTEM_PROMPT`)
  and two namespaced, pure hash functions: `analyticsQuestionHash` (prefix
  `"analytics:"` + the question text — checked FIRST, before the Haiku call,
  so a repeated exact phrasing still costs nothing) and `analyticsPlanHash`
  (prefix `"analytics-plan:"` + the validated plan's own canonicalized JSON,
  filters sorted so array order can't matter — checked after a Tier-1 miss,
  once the plan is known, so distinct plans can never collide because the
  hash literally IS a digest of the plan, and two differently-worded
  questions that resolve to the same plan share one answer).
- `api/_lib/askCache.js`'s `getCacheEntry` gained an optional `promptVersion`
  parameter (default: its own existing `PROMPT_VERSION`, so every existing
  retrieval-path call site is byte-for-byte unchanged); `routes/analytics.js`
  passes `ANALYTICS_PROMPT_VERSION` explicitly.
- `runAnalyticsQuestion` now checks its OWN two-tier cache (Tier 1 then Tier
  2) first — meaning analytics is, and always was, checked before the
  retrieval path's cache even gets a chance to run (retrieval's own cache
  check lives inside `retrieveEvidence`, which `api/ask.js` never invokes at
  all for an `analyticsCandidate` question) — but now that check can never
  return a row written by the other path, because the two hash namespaces
  are disjoint by construction (`"analytics:"`/`"analytics-plan:"` prefixes,
  never used by `api/ask.js`'s own `hashQuestion`).
- `api/ask.js` no longer threads its shared `questionHash` into the analytics
  call at all; `runAnalyticsQuestion` returns a `writes: [{questionHash,
  corpusStamp}, ...]` list (one entry per tier that needs writing) instead of
  a single `corpusStamp`, and the bookkeeping block upserts each one under
  its own namespaced hash.
- New verify section (`scripts/verify-analytics.mjs` §10, "cache key
  derivation"): `analyticsQuestionHash` never equals `api/ask.js`'s
  `hashQuestion(normalizeQuestion(...))` for the same text; it's
  deterministic and normalizes near-identical phrasing the same way;
  `analyticsPlanHash` never collides across distinct plans, is
  filter-order-independent, and never collides with a question hash;
  `ANALYTICS_PROMPT_VERSION` is a real 12-hex-char fingerprint.

Both fixes verified: `npm run typecheck && npm run typecheck:api && npm run
verify:all` all green — `verify:analytics` alone now reports **195/195**
(was 159; +36 for A1's 12-plus-supporting-unit-test checks and A2's key-
derivation section), and the full `verify:all` chain reports **3018 PASS / 0
FAIL** with no other script affected (the jump from 195 to 3018 in the total
includes checks other, parallel workstreams added to the same chain in the
meantime — none of this workstream's files touch theirs).

## What changed

Today `/api/ask` had: meta-router (exact-phrase inventory questions) → fast
path (single-field lookups) → retrieval + Haiku with citations. Nothing
answered a counting/grouping/listing question — "how many customers in
Arizona", "how many in Maricopa County", "list customers in Gilbert", "which
customers have Trane units" all fell through to retrieval, which has no way
to count or group rows.

A third pre-router — **analytics** — now sits between fast path and retrieval:

```
meta-router → fast path → analytics → retrieval + Haiku
```

Same contract as fast path: a miss (invalid plan, no matching data, an error)
falls straight through to retrieval+model, so nothing is worse off than
today. A hit answers with **zero free-form model text** — the model's only
job is to fill one strict, closed-vocabulary JSON plan; every word in the
answer is composed in code from real query results.

## Design as built

**1. Classifier** (`api/_lib/analytics.js` → `preClassifyAnalytics`) — a cheap
regex gate, no DB, no model call. It requires either an aggregate noun
(customers/units/documents/warranties/…) alongside a quantifier (how many /
list / count / total) and location/time/brand context, or one of a few
unambiguous aggregate shapes ("which customers…", "who did we service…",
"group X by Y" / "breakdown by Y"). It explicitly excludes possessive
single-record phrasing ("how many documents does Plaza Dental have", "does
the unit at 3247 Elm have a warranty") — those keep going through
fastPath/retrieval, per the same "never answer wrong" rule fastPath.js states
for itself. A false positive here only costs one wasted (cheap) Haiku call
that then gets rejected by plan validation and falls through; a false
negative costs nothing (question already went to retrieval today).

**2. Planner** (`api/_lib/analytics.js` → `ANALYTICS_TOOL` schema;
`api/_lib/routes/analytics.js` → `planAnalyticsQuestion`) — **one** Haiku
tool-use call (`tool_choice` forced), `max_tokens: 400`, temperature 0. The
schema is exactly the brief's:

```
{ entity: customers|equipment|documents|serviceVisits|warranties,
  op: count|list|groupBy|sum,
  groupBy?: city|county|state|zip|brand|documentType|month|technician|warrantyStatus,
  filters: [{field, op, value}],
  timeRange?: {from, to},
  limit? }
```

Closed field vocabulary: `state, county, city, zip, brand, model,
equipmentType, tonnage, refrigerant, installYear, warrantyStatus
(active|expiring|expired|unknown), documentType, technician, customerName`.
Filter ops: `eq, neq, contains, gt, gte, lt, lte, in`. The model **never
writes SQL** — it only picks enum values. `validatePlan` (pure, no DB)
rejects the **whole plan** if anything is outside the vocabulary (not just
the one bad filter — a silently-dropped filter would answer a different
question than what was asked without anyone knowing), and a rejected plan
falls through to retrieval exactly like an invalid fast-path classification.
State synonyms ("Arizona"/"AZ"/"arizona") and county-name normalization are
instructed in the system prompt and enforced again in code
(`normalizeStateValue`).

**3. Executor** (`api/_lib/routes/analytics.js` → `executeAnalyticsPlan`,
SQL built by `api/_lib/analytics.js` → `buildAnalyticsSQL`) — parameterized
SQL per entity, whitelisted columns only, tenant-scoped via the same
`(current_setting('app.tenant_id', true))::uuid` predicate every other store
query uses, `LIMIT 500`. Every filter value is a `$N` parameter; the model
never contributes a character of SQL text, only which of these fixed,
pre-written statements runs and which already-whitelisted column a value
binds to. Fields with no single real column (city/county/state/zip are all
derived from one free-text `service_address`; `warrantyStatus` is a computed
tier, not a column) are matched in JS after the fetch
(`matchesAllFilters`/`applyEntityFilters`), reusing `alertTier`
(`warrantyRules.js`) for warranty status and `normalizeBrand` for brand
matching — the same functions the rest of the app already trusts for this
arithmetic, not a second copy of it.

Geography: `deriveGeo` derives `{city, state, zip, county}` from
`service_address` — reuses `deriveCity` from `routes/customers.js` (no
duplicate), adds `deriveState`/`deriveZip` (new), and looks county up from
ZIP via the bundled table, falling back to a city→county table when the ZIP
is missing. A ZIP or city this table doesn't cover, or an address with none
of the above, resolves to `null` and buckets under `"Unknown"` — it is never
guessed.

**`api/_lib/geo/zip-county.json`** (11 KB, well under the 150 KB budget):
hand-compiled from general USPS ZIP-prefix / county-seat knowledge — **not**
a fetched HUD/USPS crosswalk file (no live data source was fetched for this;
the file's own `_source`/`_method` fields say so explicitly, same honesty
convention `warrantyRules.js` uses for its brand citations). Two-tier
Arizona lookup: a 3-digit-prefix default across the full 850–865 AZ range,
overridden by ~45 explicit 5-digit exceptions for ZIPs that land in a
different county than their prefix's default (Pinal towns sitting inside the
Maricopa-prefix range: Apache Junction, Casa Grande, Coolidge, Eloy,
Florence, Maricopa city, San Tan Valley, …; Tucson-suburb Pima towns sitting
inside the Cochise-prefix range: Marana, Sahuarita, Green Valley, Vail;
Yuma/La Paz/Santa Cruz/Graham/Greenlee pockets; a few Navajo/Apache/Coconino
crossovers). Plus a 60-entry AZ city→county fallback and a 100-entry US
city→county+state fallback (for "how many customers in Nevada" style
questions). **Maricopa, Pinal and Pima — the counties this product's actual
customer base concentrates in — are the most carefully verified**; the
remaining 11 AZ counties and the out-of-state table are prefix/best-effort
and may be wrong for an address this synthetic business never actually uses.
Caught and fixed during testing: an initial draft had Pima (Tucson, 857xxx)
and Cochise (Sierra Vista, 856xxx) swapped, and Marana's ZIP (85653, inside
the Cochise-prefix range) missing its Pima exception — both fixed and
covered by `scripts/verify-analytics.mjs`'s county-lookup checks.

**4. Answer** (`api/_lib/analytics.js` → `formatAnalyticsAnswer`) —
deterministic, no second model call. `count`: "You have 14 customers (of 31
total)." `groupBy`: "You have 14 customers by city: Gilbert 5, Mesa 4,
Chandler 3, Tempe 2." with facts rows `{label: "Gilbert", value: "5"}` per
group, capped at 12 rows (`MAX_FACT_ROWS`) with "...and N more <dimension>s"
appended to the text past that. `list`: individual rows as facts, each with
`entityId` when linkable so the UI can open the record. `sum`: a currency
total. **Ambiguity rule** (design point 5): a named filter value matching
zero rows names what the tenant's data actually has instead of a bare "0" —
"0 customers match that — your customers are in Maricopa (14), Pinal (3)."
rather than a dead end.

**5. Caching** — reuses `askCache.js` exactly as retrieval+model does: a
cache check (`getCacheEntry`/`isCacheHit`) runs first, before the Haiku
planner call, so a repeated analytics question costs nothing at all on a hit.
A miss plans, executes, answers, and the post-response bookkeeping writes the
answer back via `upsertCacheEntry` under the same `corpus_stamp` mechanism —
an ingest, a correction, a merge, anything that changes the tenant's data
invalidates the analytics cache exactly like it invalidates a retrieval
answer's cache, with no separate invalidation logic to keep in sync.

**6. Server-Timing / cost logging** — the whole plan-and-execute step is
wrapped in `timer.time("analytics_plan", …)`, so it appears in the
`Server-Timing` response header and in the existing structured `route: "ask"`
log line's `timingsMs`, same mechanism every other stage already uses — no
new logging plumbing. A separate one-line log
(`{route: "ask", analytics_candidate, analytics_hit, analytics_cache_hit}`)
mirrors the fast-path hit/miss log already there.

**7. Cost & budget** — one Haiku call, `max_tokens: 400`, cached. The daily
model-spend budget check (`assertModelBudget`, already in flight
concurrently with the gate check) is awaited before the analytics Haiku call
runs, same enforcement point the main retrieval+model path uses; a
budget-exceeded tenant gets the same clean 429 without wastefully running
retrieval first to discover it a second time.

**8. Client** (`src/components/FactGrid.tsx`) — no new response type and
`src/core/types.ts` untouched, per the brief. A groupBy/list answer already
arrives as ordinary `Fact[]` (`{label, value, sources: []}`) — the exact same
shape the meta-router's existing count/list answers have used all along
(`listCustomers`, `listDocumentTypes` in `api/ask.js`), so it renders through
`AnswerCard`/`FactGrid` with **zero** required changes. Added one purely
presentational enhancement: when more than 5 facts are all sourceless and
statusless (the groupBy/list signature), `FactGrid` renders them in a dense
two-column table instead of the citation-oriented three-column grid — the
citation-chip column buys nothing when there's nothing to cite. Governed
entirely by the existing `Fact` shape (`isGroupLikeFact`), not a flag on the
answer.

## Files touched

- `api/_lib/analytics.js` — new. Pure: classifier, plan schema/prompt,
  validation, geo derivation, filter matching, SQL builder, answer
  formatting, brand/year/warranty-status helpers. No `db`, no network.
- `api/_lib/routes/analytics.js` — new. Impure: the Haiku call
  (`planAnalyticsQuestion`), the DB executor (`executeAnalyticsPlan`), and
  the cache/plan/execute orchestration (`runAnalyticsQuestion`) `api/ask.js`
  calls.
- `api/_lib/geo/zip-county.json` — new. The ZIP/city → county table.
- `api/_lib/askCache.js` — round 1 fix (A2): `getCacheEntry` takes an
  optional `promptVersion` param (defaults to its existing `PROMPT_VERSION`,
  so retrieval's own calls are unchanged) so a caller with its own prompt
  fingerprint (analytics) doesn't inherit retrieval's.
- `api/ask.js` — wired the analytics pre-router in after fast path, before
  retrieval (imports, `analyticsCandidate` classification, the retrieval-skip
  guard, and the new response/bookkeeping/cache-write block). Round 1 fix
  (A2): no longer passes its shared `questionHash` into the analytics call;
  writes the `{questionHash, corpusStamp}` pairs `runAnalyticsQuestion`
  returns instead of a single shared one. No other behavior changed; meta and
  fast-path code is untouched.
- `src/components/FactGrid.tsx` — added the compact groupBy table renderer.
  `AnswerCard.tsx` and `src/core/types.ts` unchanged.
- `scripts/verify-analytics.mjs` — new, 195 checks (brief asked for ≥60), all
  pure/no-DB/no-network: the 25-question pre-classifier corpus, 12 round-1
  adversarial single-record checks (§1b) plus direct unit tests of
  `looksLikeSingleRecordReference`/`suspiciousUnfilteredCustomerPlan`, a
  recorded-plan fixture (what Haiku would have returned) run end-to-end
  through validation → SQL building → formatting, plan-vocabulary rejection,
  geo derivation (suites, missing ZIP, ZIP+4, no-comma-before-state,
  out-of-state), county lookup (prefix default, exceptions, city fallback,
  unknown), per-entity SQL shape, answer formatting (count/groupBy/list/sum,
  the ambiguity rule, the 12-row cap), the filter/group/brand/warranty
  helpers, and (§10) the cache-key derivation.
- `package.json` — added `verify:analytics` and wired it into `verify:all`.

## Question types now supported end to end

- "How many customers do we have in Arizona?" / "...in Maricopa?" (state or
  bare county name, count)
- "List customers in Gilbert" (city filter, list)
- "How many units are out of warranty?" / "...still under warranty?" /
  "...expiring soon?" (`warrantyStatus`, count or groupBy)
- "Which customers have Trane units?" (brand filter, list)
- "How many documents did we add this month?" (`documentType`/`timeRange`,
  count)
- "Who did we service in August?" (`serviceVisits`, technician + timeRange)
- "How many Goodman units are older than 10 years?" (brand + `installYear`
  filter, count)
- Any of the above as a `groupBy` — "breakdown of customers by county",
  "group equipment by brand" — rendered as the compact table.
- "How many customers in Pima County?" when the tenant has none — names what
  counties they actually have instead of a bare zero.

## Limits (be honest about these)

- **Geography outside Maricopa/Pinal/Pima is best-effort.** The 3-digit ZIP
  prefix defaults for the other 11 AZ counties, and the entire out-of-state
  city table, were hand-compiled from general knowledge, not verified against
  a real crosswalk. An address in, say, rural Gila or Graham county could
  land in the wrong county if its ZIP isn't one of the explicit exceptions.
- **`sum` is narrow.** Only tested/verified for a numeric total over already-
  matched rows (e.g. `documents`/`serviceVisits` cost-style totals); there's
  no dedicated "which field to sum" plan property, so a sum question the
  model can't map onto a numeric field it already fetched will simply return
  0 rather than the right total. Not one of the brief's 8 example questions,
  so it wasn't exercised against the real corpus.
- **serviceVisits technician/date matching is a two-query JS join**, not a
  single SQL join — correct for the data volumes this app runs at, but would
  not scale to a much larger `extractions` table without an index-aware
  rewrite.
- **The Haiku planner was never exercised over the network in this
  workstream** — `scripts/verify-analytics.mjs` validates the *pipeline*
  (schema validation → SQL → formatting) against a fixture of plans a real
  Haiku call is expected to produce, per the brief's own instruction ("the
  Haiku planner itself is exercised only by a fixture of recorded plans, no
  network"). Real-world scoring against the 600-document business and its
  30 analytics questions (Workstream B's `ANSWER_KEY.json`) happens once the
  owner signs back in and the corpus is live, per the brief's Sequence
  section.
- **The classifier is a gate, not a guarantee.** A genuinely ambiguous
  question can still cost one wasted, cached-schema Haiku call before falling
  through to retrieval — cheap, but not free, and this is a source of latency
  variance the fast-path miss path already has today.

## Verification run

Original build: `npm run typecheck && npm run typecheck:api && npm run lint
&& npm run verify:all` all green, `verify:all` at **2951 PASS / 0 FAIL**
(baseline 2792 + this workstream's 159), `npm run build` succeeded.

After the reviewer round 1 fixes (A1 + A2, this update): reran `npm run
typecheck`, `npm run typecheck:api`, and `npm run verify:all` — all green.
`scripts/verify-analytics.mjs` alone: **195/195** (was 159; +36 — the 12
adversarial checks A1 asked for, plus direct unit coverage of
`looksLikeSingleRecordReference`/`suspiciousUnfilteredCustomerPlan`, plus
A2's §10 cache-key-derivation section). Full `verify:all` chain: **3018 PASS
/ 0 FAIL, exit 0** (the total now also includes checks parallel workstreams
added to the shared chain in the meantime — `verify:business-corpus` now
runs after `verify:analytics` — none of it touches this workstream's files).

---
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uwc37MXKyvkjvNUD6Lmb5X
