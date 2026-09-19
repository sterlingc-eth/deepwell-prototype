# Adversarial code audit — 2026-09-19

Read-only. Every finding below was traced end-to-end in source; the two
marked PROVEN were reproduced against a real local Postgres 16 instance
(scripts run from `/tmp`, DB torn down after — nothing persisted to the repo
or to Neon). No source files were modified.

---

## BLOCKER

### B1. Daily model-spend budget only gates one of four billed call sites — PROVEN by code trace
**Files:** `api/_lib/queue.js:283-294` (the only call site), `api/_lib/rateLimit.js:270-333` (`getDailyModelBudgetStatus`), `api/ask.js`, `api/extract.js`, `api/read-document.js`

`getDailyModelBudgetStatus(ctx)` is called in exactly one place in the whole
codebase: inside the Inngest `read-document` function, before the
transcription call. It is **never** called from:
- `api/read-document.js`'s inline path (`ingestDocument` run directly when
  `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` are unset — which the code's own
  header calls the **default** configuration: "THE QUEUE IS OPTIONAL AND OFF
  BY DEFAULT"). With the queue off, ingestion has *no* budget enforcement at
  all.
- `api/_lib/queue.js`'s `extract-fields` Inngest function (`extractDocumentFields`,
  Haiku calls) — checked at lines 321-352; no budget call anywhere in it.
- `api/extract.js` (both the stored-document path and the photograph path).
- `api/ask.js` — the single most expensive call site (Sonnet, `ASK_MODEL =
  "claude-sonnet-4-5"`), gated only by `rateLimit.js`'s `limit(...,"ask")`,
  which is a *request-count* cap (default 500/day), explicitly documented in
  rateLimit.js itself as "**Independent of** the `ask` bucket's perDay ...
  this is a whole-tenant cap on `usage_counters.model_calls`" — i.e. the two
  are different numbers and only one of them is ever checked for `ask`.

`usage.js`'s own comment says the counter this budget reads
(`usage_counters.model_calls`) is "whichever route produced it (ask, ingest,
or extract all share this counter)" — so the code *believes* the budget
covers all three, but only wires the check into one.

**Scenario:** a tenant's daily cap is exhausted by a burst of document reads.
New transcriptions correctly get deferred with `DAILY_BUDGET_EXCEEDED_MESSAGE`.
Every document already past the read stage keeps extracting fields (Haiku)
freely, and the tenant (or anyone holding an `ask`-scoped API key) can keep
asking unlimited questions (Sonnet, no per-call cap beyond the unrelated
request-rate limiter) all day. The "daily processing limit reached — resumes
tomorrow" message a customer sees is true only for new uploads.

**Fix:** call `getDailyModelBudgetStatus` (or a shared wrapper) before the
Anthropic call in `extractDocumentFields`, `extract.js`'s image path, and
`ask.js`, and also in `ingestDocument`'s inline entry point (not just the
Inngest wrapper) so queue-off deployments are covered too.

---

### B2. `findOrCreateEquipment` / `findOrCreateCustomer` race under concurrent extraction — PROVEN against real Postgres
**Files:** `api/_lib/recordsStore.js:851-921` (`findOrCreateEquipment`), `:982-1025` (`findOrCreateCustomer`); no unique constraint on `entities` beyond `(tenant_id, entity_type)` index (`M3-config/01-create-schema.sql:123-132`)

Both functions are a plain `SELECT ... WHERE lower(data->>'serial_number') =
lower($1) ... LIMIT 1` followed, if nothing is found, by an unconditional
`INSERT`. No `SELECT ... FOR UPDATE`, no advisory lock, no unique constraint,
no `ON CONFLICT`. Two extraction transactions that both reach the `SELECT`
before either has committed the `INSERT` both see "nothing exists" and both
insert.

This is exactly the case the queue is built to allow: `resolveIngestConcurrency()`
(`queue.js:204-209`) lets up to `INGEST_CONCURRENCY_TENANT` (default 3)
documents of the **same tenant** run their read step at once, and the
`extract-fields` function chains automatically off each one with its own
5-slot global concurrency (see B3) — so two documents for one tenant that
both name the same brand-new serial or customer (an install invoice split
into two files, an invoice + a same-day filter-change ticket, a batch upload
of a new customer's paperwork) routinely overlap.

**Reproduced** with two concurrent Postgres transactions running the literal
query pair from `findOrCreateEquipment` against a throwaway schema (real
Postgres 16, `uuid-ossp`, no mocks):

```
doc A result: { id: '58eb161f-...', created: true }
doc B result: { id: '9a61d308-...', created: true }

entities rows for serial CG-4021-A: 2
RACE CONFIRMED: two equipment entities created for the same new serial number.
```

**Impact:** exactly the failure mode `recordsStore.js`'s own extensive
comments say the fill-only merge logic exists to prevent — the unit's install
date, warranty basis, and later service history split across two entity
rows. Nothing self-heals it: subsequent extractions deterministically match
the earlier-`created_at` row (`ORDER BY created_at LIMIT 1`), so the second,
duplicate row sits there forever, silently missing whatever documents landed
on it before the duplicate was noticed. Same defect, same mechanism, for
`findOrCreateCustomer` (person, not equipment) — a live privacy concern per
that function's own doc comment ("a customer record that quietly carries
someone else's equipment... is a privacy problem").

**Fix:** either a partial unique index on `entities (tenant_id, (lower(data->>'serial_number')))
WHERE entity_type='equipment' AND merged_into IS NULL` (and the customer-name
equivalent) with `INSERT ... ON CONFLICT DO UPDATE`, or take a
`pg_advisory_xact_lock(hashtext(tenant_id || ':' || lower(serial)))` before
the SELECT. The unique-index route also gives the entity-merge logic
(`08-review.sql`'s `merged_into`) a real backstop instead of relying on
nobody ever racing it.

---

## HIGH

### H1. `extract-fields` Inngest function has no per-tenant concurrency key — worsens B2
**File:** `api/_lib/queue.js:321-328`

`readDocument`'s config uses `resolveIngestConcurrency()` — global limit
**and** a `key: "event.data.tenantKey"` limit, specifically so one tenant's
bulk import can't occupy the whole global budget (the file's own "scale
config" comment explains this at length for the read step). `extractFields`
gets only `concurrency: { limit: 5 }` — global, no tenant key. A single
tenant's burst upload can occupy all 5 global extraction slots at once,
which both starves every other tenant's extraction during that burst and
directly increases how many of one tenant's own documents run
`findOrCreateEquipment`/`findOrCreateCustomer` concurrently (B2) — up to 5 at
once instead of the 3 the read step deliberately caps a single tenant to.

**Fix:** give `extractFields` the same two-entry `concurrency` array
(`resolveIngestConcurrency()`, already exported and pure) that `readDocument`
uses.

### H2. Nested retries can multiply one document's extraction spend up to ~9x under sustained 429/529
**Files:** `api/_lib/extractDocument.js:108-115` (`withBackoff`, up to 3 attempts), `api/_lib/queue.js:264` / `:326` (`RETRIES = 3` total Inngest attempts, wrapping the whole `extractDocumentFields` call)

`withBackoff` (claude.js) retries a 429/529 up to 3 times *inside* one
`extractDocumentFields` invocation. The Inngest `extract-fields` function
retries the *whole step* — including that internal `withBackoff` loop — up to
3 times on any non-fatal error. Under a sustained rate-limit condition (the
exact condition both mechanisms exist for) a single document's extraction
can generate up to 3×3=9 Anthropic call attempts before either succeeding or
giving up permanently. Each layer is individually well-reasoned (documented
in both files) but the composition was never checked against the daily
budget (see B1) or against each other. Bounded and not catastrophic on its
own, but combined with B1's gap it is real, uncapped-by-anything-except-itself
spend.

**Fix:** either drop `withBackoff` from the queue-driven call (let Inngest's
own retry own all backoff — it already waits between attempts) or cap
`RETRIES` to reflect that `withBackoff` already retries once internally.

### H3. Document deleted mid-ingestion wastes a full paid transcription retry, and permanently-missing R2 objects are misclassified as retryable — PROVEN
**Files:** `api/_lib/readDocument.js:349-459` (`ingestDocument`), `api/_lib/queue.js:133-136` (`fatal`), `api/_lib/r2.js:94-112` (`getObject`)

Traced end-to-end and confirmed against real Postgres:

- **Deleted document:** `ingestDocument` reads the row, downloads bytes,
  calls the model (seconds to tens of seconds), then writes pages via
  `upsertPages` inside a fresh `withTenant` transaction. If the document row
  was deleted in between (a user delete, or `tenant-delete.js`'s own delete
  path) the `INSERT INTO document_pages` violates its FK to `documents`
  (`ON DELETE CASCADE` means the parent must still exist to insert a child).
  Reproduced directly:
  ```
  ERROR:  insert or update on table "document_pages" violates foreign key
  constraint "document_pages_document_id_fkey"
  ```
  This is a plain `pg` error: `err.name` is `"error"`, not `"IngestError"`,
  and it carries no `.status`. `queue.js`'s `fatal(error)` requires
  `error?.name === "IngestError"`, so this is **never** classified as fatal —
  it is thrown as a plain (retryable) error, and Inngest retries the whole
  step, which means the model is billed **again** to transcribe a document
  that Postgres will refuse to accept the moment the second attempt
  re-checks `getDocument` (which correctly returns `null` → `IngestError`
  404 → *now* fatal, on attempt 2). Net effect: deleting a document while it
  is mid-ingestion always burns one extra full-price transcription call
  before the retry gives up.
- **Missing R2 object:** `getObject` throws `new Error("R2 GET ... failed:
  404")` with no `.status` set. Both `fatal()` and `isTransientError()`
  therefore treat a permanently-missing object exactly like a transient
  network blip — under the queue it gets the full `RETRIES=3` treatment
  before failing, delaying the user-visible failure and wasting run
  attempts on something that can never succeed.

**Fix:** classify FK-violation (`err.code === '23503'`) and "document not
found" races as fatal in `queue.js`'s `fatal()` (or have `getDocument`
races short-circuit before spending the model call — re-check existence
right before the DB write, not just at the start). Attach a real `.status`
(404, non-retryable) to `r2.js`'s thrown errors instead of a bare `Error`.

### H4. `/api/ask`'s `verifiedCount`/`unverifiedCount` do not reflect document verification stage at all
**Files:** `api/_lib/answer.js:309-326` (`shapeAnswer`), `api/_lib/recordsStore.js:580-683` (`searchPassages`/`searchExtractions` — no stage filter or stage column returned)

`searchPassages`/`searchExtractions` retrieve from **every** document
regardless of `stage` — a document that has never been through AI or human
verification (`stage` still `received`/`read`/`mapped`/`linked`, meaning its
OCR and field extraction have never been checked) is cited with exactly the
same weight as one at `stage = 'verified'`. `shapeAnswer` then reports
`verifiedCount` as "number of distinct cited documents" (not "documents at
stage=verified") and hardcodes `unverifiedCount: 0` unconditionally — so a
UI trusting these fields to communicate confidence is told every answer is
100% verified, always, regardless of the underlying documents' real
verification state. `buildContextBlock`'s label for extractions —
"ALREADY-EXTRACTED FIELDS (verified by the pipeline...)" — repeats the same
conflation (extracted ≠ AI/human-verified; see `documentTypes.js`'s
`AI_VERIFY_MIN_CONFIDENCE` gate, which many extractions never clear).

This isn't a security hole, but it directly undercuts the product's stated
promise ("every fact comes from your own documents," with a designed
verified/unverified distinction elsewhere in the same codebase — the meta
question router at `ask.js:124-128` correctly distinguishes them for count
questions, so the omission in the main answer path looks like an oversight,
not a design choice).

**Fix:** have `searchPassages`/`searchExtractions` return `stage`, and have
`shapeAnswer` compute `unverifiedCount` from facts whose source document(s)
are not `stage='verified'`, surfacing it to the caller instead of a
constant.

---

## Section-by-section notes (not independently BLOCKER/HIGH, recorded for completeness)

- **Idempotency on re-delivery (queue.js/inngest.js):** `enqueueDocument` uses
  `id: read-${documentId}` / `extract-${documentId}` as the Inngest event id,
  and `ingestDocument`'s `alreadyIngested()` short-circuit plus `upsertPages`'s
  `ON CONFLICT (document_id, page_no)` make a genuine re-delivery of the same
  event safe — verified this is real idempotency, not just retry dedup. No
  finding here.
- **Cron-sweep budget bypass is schedule-dependent, not code-enforced**
  (`api/_lib/routes/cron-sweep.js:100-113`, `vercel.json`): `retryOnce` for
  budget-deferred documents calls `ingestDocument` directly, bypassing the
  queue and therefore B1's one enforcement point, with **no** re-check of
  `getDailyModelBudgetStatus`. The only reason this doesn't immediately
  re-blow the daily cap same-day is that `vercel.json` schedules the sweep
  once daily at `17 9 * * *` (well after UTC midnight reset). Nothing in code
  stops the sweep — which also accepts an operator-supplied tenant list via
  POST body — from being invoked more than once a day and re-spending a
  tenant's whole daily model budget a second time. LOW/MEDIUM: relies on
  deployment config, not defense in depth.
- **Auth/tenancy (auth.js, apiKeyAuth.js, members.js, merge-tenant.js,
  tenant-delete.js):** tenantId is derived exclusively from verified Clerk
  claims or a server-resolved API-key row, never from client input, in every
  route checked. `tenant-delete.js`, `tenant-export.js`, and `keys.js` are
  all admin-gated (`requireRole(auth, "admin")` when `hasShop`) — note
  `tenant-delete.js`'s own header comment ("NOT YET ADMIN-GATED") is stale;
  the code already gates it. `merge_tenant()` is idempotent (re-running it is
  a verified no-op — traced through its own `RETURN`-early cases) and its
  `from_key ~ ^user_` check makes cross-shop merges structurally impossible
  regardless of caller bugs. No cross-tenant access path found in any of the
  five files.
- **Retrieval injection (recordsStore.js `searchPassages`/`searchExtractions`,
  `ask.js`):** the tsquery is built via `to_tsvector('english', $1)` →
  `tsvector_to_array` → string-joined with `|` → cast to `::tsquery`, entirely
  parameterized ($1 never string-concatenated into SQL) — traced as safe
  against quotes/colons/`&`/`|`/`!`/unicode/length. ILIKE tokens are
  extracted via regexes (`[A-Za-z0-9][A-Za-z0-9/-]{3,}`, `[A-Za-z][A-Za-z'-]{3,}`)
  that structurally exclude `%`/`_`, so user input can't inject SQL LIKE
  wildcards into those patterns. Every query carries the tenant predicate.
  No finding here.
