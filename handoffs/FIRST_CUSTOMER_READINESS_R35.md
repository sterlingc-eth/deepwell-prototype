# R35 - First paying customer: reliability and limit test

What was tested: the shop that signs up and imports a year of paperwork in the first week. Everything ran at $0 in an in-process
Postgres (PGlite) with mocked storage, model, Stripe and network. Nothing real was touched.

**Read the caveat on every timing below:** PGlite is a single-threaded WebAssembly Postgres. Its numbers are good for finding work that
grows with shop size (the thing that breaks first) and for before/after comparisons. They are not a prediction of Neon latency, which is
typically several times faster on the same plan. Where a number matters to the decision it is labelled "PGlite".

Regression gate: `npm run verify:r35-limits` (133 checks, part of `verify:all`). Measurement tool: `npx tsx scripts/r35-measure.mjs`
(seeds 50,000 documents / 10,000 customers / 20,000 units / 5,000 open Inbox questions in about two minutes).

## Owner decision applied

`sizeBytes` is required on every upload path: web presign, batch presign, phone / offline queue, v1 ingest (it shares the presign
validation), and the Records `createDocument` action. Missing, zero, negative, fractional or non-numeric = HTTP 400 with the plain
message "sizeBytes is required...". The signed PUT URL always carries `content-length`, so a client cannot send more than it declared.
Every in-repo client already sends it (`ingestClient`, `bulkImport`, `uploadQueue`, the queued item). Read-time caps stay as the second
line of defence. One unsized presign remains: platform expense receipts (`api/_lib/routes/expenses.js`, owner-only, not part of the
customer pipeline). Flagged, not changed.

## Measured limits (what a customer will actually hit)

Per tenant (every user in the shop shares these):

| | Solo | Shop | Crew | Fleet |
|---|---|---|---|---|
| Pages read per month (resets on the 1st, UTC) | 750 | 2,000 | 5,000 | 10,000 |
| Plus per-tenant extra pages (`extraPagesPerMonth`) | + any | + any | + any | + any |
| Documents stored | 25,000 | 100,000 | 500,000 | no cap |
| Upload burst (ingest units per minute) | 60 | 150 | 360 | 720 |
| ...in files per minute (each file = 2 units: presign + read) | 30 | 75 | 180 | 360 |
| Upload per day (ingest units) | 2,000 | 5,000 | 12,000 | 24,000 |
| ...in files per day | 1,000 | 2,500 | 6,000 | 12,000 |
| Model calls per day (`maxModelCallsPerDay` default) | 2,000 | 5,000 | 12,000 | 24,000 |
| Donovan questions per minute, whole shop | 20 | 40 | 80 | 120 |
| ...one person's share of that | 10 | 20 | 40 | 60 |
| Donovan safety ceiling (hidden, all plans) | 3,000 / day, 30,000 / month | | | |

Before R35 the per-minute upload and ask numbers were 60 and 20 for every plan, and the daily model-call cap was 2,000 for every plan.

Infrastructure:

- **Database connections: 3 per warm serverless instance** (`PG_POOL_MAX`). Ten people at once is fine only on Neon's pooled endpoint
  (hostname contains `-pooler`). The app logs a one-line warning at boot if it is not. Check this first (checklist item 2).
- **Import queue speed is set by `INGEST_CONCURRENCY_TENANT` (default 3), not the global 5.** One shop gets 3 reads at a time.
  Formula: documents per hour = 3 x 3600 / seconds per read. At an assumed 30 s per document that is 360 per hour, so a 5,000-document
  import takes about 14 hours. The throttle (40 starts per minute) is not the limit. The 30 s is an assumption (no real model is
  allowed in this test); measure the real average from the first 50 documents and rescale.
- With `INGEST_CONCURRENCY_GLOBAL=20`, `INGEST_CONCURRENCY_TENANT=15`, `INGEST_THROTTLE_PER_MIN=120` (needs a paid Inngest plan and an
  Anthropic tier that allows ~20 concurrent requests): 15 x 3600 / 30 = 1,800 per hour, 5,000 documents in about 3 hours.
- First big import, 5,000 to 20,000 pages in a day, is blocked three separate ways on any plan until the owner raises it: the monthly
  page cap, the per-day upload units, and the per-day model-call cap. The one-paste SQL below raises all three for one shop.

Large tenant (PGlite, 50,000 documents, 10,000 customers, 20,000 units; before to after):

| Query | Before | After |
|---|---|---|
| Customers list, last page (offset 9,800) | **19,388 ms** | 336 ms |
| Customers list, first page | 590 ms | 356 ms |
| Customers CSV export | returned **200 of 10,000** rows | all rows, 322 ms |
| Records, "load more" (page 2+) | ~1,900 ms, 14 statements | 1 page query, no facet scans |
| Pages read this month count (every upload batch, every app load), 240k pages | 421 ms | 4 ms |
| Inbox page (5,000 open questions) | every open row pulled into Node per page | 21 rows per page, sorted and counted in SQL |
| Records first page | 1,875 ms | ~2,000 ms (unchanged, see risks) |
| Records search | 7,554 ms | ~7,100 ms (unchanged, see risks) |
| Donovan passage search | 1,005 ms | 861 ms |
| Open document count, documents stuck scan, extraction fetch (500) | 56 / 3 / 38 ms | same, fine |
| Pool after all of it | peak 1 connection, 0 still out | same |

## Findings fixed

Severity: **P1** = loses or blocks the customer's work or money, **P2** = wrong or slow in a way they notice, **P3** = hygiene.
Every row has a regression check in `scripts/verify-r35-limits.mjs`.

**1. P1 - The monthly page cap could be bypassed with unsized or batched uploads.**
Repro: a Shop at 1,990 of 2,000 pages sends one batch of 50 PDFs of ~100 pages each. Root cause: the gate looked only at the count
*before* the batch and an unsized file counted as 1 page. Fix: size required; the gate returns how many pages and documents are left
and the batch spends from that per new file; a file that no longer fits gets its own 402 with the plain-English message and creates no
row. Check: family `size` and `gate` (50 files into 10 pages of headroom: 1 accepted, 49 refused, 1 row created).

**2. P1 - "Stored documents" limit was only displayed, never enforced.** Fix: enforced at the gate (fails open on a lookup error), with
a message that says search and Donovan still work. Check: `gate`.

**3. P1 - "Resets Oct 1" was a lie.** The Billing screen, the 402 text and the billing rules promise a calendar-month reset; the
counter was rolling 30 days, so 2,000 pages scanned Sep 25 stayed blocked until Oct 25. Fix: the count never reaches before the 1st (UTC).
Check: `gate` (a page just before the 1st is not counted).

**4. P1 - The billing webhook erased owner overrides.** `billing_apply` replaces `tenants.limits` wholesale on every Stripe event, so a
hand-set `extraPagesPerMonth` / `maxModelCallsPerDay` / per-bucket override / `testAccount` vanished at the next renewal. Fix: migration 62
carries those keys over unless the incoming patch sets them. Check: `billing`.

**5. P1 - Customers CSV export silently returned 200 rows.** The export asked for up to 10,000, the list function clamps to 200.
A 10,000-customer shop's "export everything" was missing 98% of its customers. Fix: an explicit `cap` for the export path (screens keep 200).
Check: `export`. File touched outside the owned list: `api/_lib/routes/export-csv.js` (one line).

**6. P1 - Customers list got slower the further you scrolled: 19 s on the last page.** A correlated subquery scanned every unit once per
customer. Fix: one grouped pass. Check: `scale` (same output, source guard against the pattern).

**7. P2 - Retrying a refused request kept the whole shop locked out.** A denied request stayed counted, so a client retrying a 429 kept
the shared per-minute bucket pinned for everyone. Fix: refused units are refunded (burst and daily). Needs migration 62; without it
nothing breaks, the refund is just a no-op. Check: `rate` (20 refused retries leave the window unchanged).

**8. P2 - One Donovan user could use the whole shop's per-minute budget; every plan had the same burst.** Fix: plan-scaled per-minute
limits and a per-person share of the ask bucket. An env-pinned `RATE_LIMIT_<BUCKET>_PER_MINUTE` is not scaled. Check: `rate`.

**9. P2 - A big import deferred itself for a day on every plan.** The daily model-call default was 2,000 regardless of plan. Fix: scales
with the plan; an explicit override still wins. Check: `rate`.

**10. P2 - Phone queue hammered a refusing server.** With 100 scans queued and a 429 or 402, the drain tried all 100, burned each scan's
retry count and added the denied requests to the shop's bucket. It also ignored `Retry-After`. Fix: the first 429 or 402 pauses the whole
shop's queue (honours `Retry-After`, capped at 2 h; 402 waits at least 10 min) and leaves the other scans untouched. Check: `client`
(100 scans, exactly 1 request, 99 untouched, no early retry from an online / visibility trigger).

**11. P2 - Bulk import made thousands of failing calls after the monthly cap.** A whole-batch 402 was swallowed and every file fell back to its
own presign. Fix: a 402 ends the run with the server's message in the notice. Files: `src/services/bulkImport.ts` and
`src/screens/IntakeScreen.tsx` (a small edit outside the owned list). Check: `client` (120 files, 1 request).

**12. P2 - Nightly recovery could not recover the common cases ("2 stuck, 0 recovered").** Causes and fixes:
a) An upload whose PUT never happened (closed tab, lost signal) failed as a raw "R2 GET ... 404", was counted as "still failing" and
fired the Sentry warning every night. Now a plain "This upload never finished... please upload it again", counted separately, no Sentry.
b) Recovered documents were read but never extracted. Now extracted too.
c) A document read but never extracted was invisible to every sweep. Now listed and recovered.
d) 25 documents per tenant per night (1,500 deferred documents = 60 nights). With the queue on, the sweep now enqueues up to 400 per
tenant per run, skips a tenant whose model budget is still spent, and treats "stuck" as quiet for 12 h (read) / 6 h (extract) so a
document merely waiting behind a big import is never run twice.
e) New light mode `?mode=docs` (recovery only) cheap enough to run every 15 minutes. See checklist item 6.
Check: `sweep`.

**13. P2 - Records page-count query grew with the shop's whole history.** It runs on every upload batch and every app load. Fix: no join
plus an index (migration 63). 240k pages: 421 ms to 4 ms. Check: `scale` and `structure`.

**14. P2 - Inbox queue pulled every open question into Node for every page.** Fix: sort, cursor and total in SQL. Garbage cursors act as
"start at the top". Check: `inbox` (130 questions in pages of 20: every one exactly once, ties on timestamp handled).

**15. P3 - Connection pool.** No handler for an idle-connection drop (an unhandled `error` event crashes a warm instance); a connection
whose ROLLBACK failed went back into the pool. Fix: handler added; a failed rollback destroys the connection. Check: `pool`.

**16. P3 - Duplicate-file check loaded every page's full text** just to read `.length`. Fix: an EXISTS probe. Check: `size`.

**17. P3 - Messages.** Page-cap messages include the reset date; Fleet is told to email support rather than "upgrade"; past-due past
grace is explained (what is paused, what still works); an over-cap team after a downgrade is told how many logins it has, that members
keep access, and how many to remove. Existing test strings kept. Check: `gate`, `seats`.

Also changed: `scripts/verify-r34-breakit-uploads.mjs` (three payloads now carry the required size so they still test what they say) and
`scripts/verify-r33-dates.mjs` (its "no new SQL" check now allows R35's two migrations).

## Remaining risks (not fixed)

1. **Records first page and Records search at 50,000 documents: ~2 s and ~7 s in PGlite.** Ten facet scans each re-scan every document.
   Page one is the only page that runs them now. Expect roughly a third to a fifth of that on Neon; search is the one to watch. Fix when
   it bites: materialise the "linked" rows once per request, or cache facets per filter set for 60 s. Not done: it is the Records contract
   and a large change.
2. **The app loads at most the newest 500 documents and 500 entities into the client graph** (`usePostgresSync`, not owned). Inbox "Needs
   you" counts and some derived views are computed from those 500, so a needs-review document older than the newest 500 is invisible
   there until the Inbox queue endpoint is used for it. Documented earlier; unchanged.
3. **Import speed is the per-shop queue concurrency (3).** See limits. A 5,000-document first import is an overnight job until the env
   vars are raised.
4. **Records Rescue is not fulfilled in code.** The checkout is a one-time payment with no code that adds pages. The owner sets
   `extraPagesPerMonth` by hand (SQL below). It survives renewals only after migration 62.
5. **Canceled customers see only Billing** (`src/App.tsx`, not owned) and Donovan is blocked. Their data is retained. Confirm they can
   still reach the export from Billing or support before the first cancellation.
6. **Each file costs 2 upload units** (presign and read). Intentional and now documented; it halves the files-per-day figure above.
7. **Inbox page = ~2.4 SQL statements per card** (one set of lookups per card, 49 for a page of 20; 320 ms PGlite). Fine at 20 per page.
8. **Expense receipt uploads are unsized** (owner-only).
9. **Not measured:** full-tenant export streaming at 50,000 documents (it pages and resumes by design, no cap), and real latency to
   Neon, R2, Inngest or Anthropic.

## Owner onboarding-day checklist

1. Paste migrations 62 and 63 (SQL below). Run 63 before the import, not during.
2. Confirm `NEON_CONNECTION_STRING` is the pooled one (host contains `-pooler`). The deploy logs a warning at boot if not.
3. Confirm the Inngest keys are set, then raise the import speed: `INGEST_CONCURRENCY_GLOBAL`, `INGEST_CONCURRENCY_TENANT`,
   `INGEST_THROTTLE_PER_MIN` (see limits; needs the paid Inngest plan and an Anthropic tier to match). Check the Anthropic rate limit first.
4. Raise the customer's limits for the import day (SQL below). Reset the three overrides afterwards.
5. Do a 50-document dry run first. Read the average seconds per document off the Inngest dashboard, rescale the hours estimate above, and
   confirm the deferral message "Daily processing limit reached" never appears.
6. Add the frequent light recovery cron (JSON below) for import week. Vercel Hobby only allows once-daily crons; this needs Pro.
7. Tell the customer: uploads pause by themselves at a limit with a plain message, nothing is lost, and phone scans resume on their own.
8. Watch Sentry: "cron-sweep ... could not be recovered" should now mean a real failure, not an abandoned upload.
9. After the import, set the customer's real plan, remove the temporary overrides, and check Billing shows "resets on the 1st".

### SQL to paste (Neon SQL editor, in order)

1. `M3-config/62-rate-limit-refund-and-owner-overrides.sql` (idempotent; safe to re-run).
2. `M3-config/63-page-count-index.sql` (idempotent).
3. Per customer, for the import (replace the org id; numbers are an example for 20,000 pages on a Shop plan):

```sql
UPDATE tenants
   SET limits = COALESCE(limits, '{}'::jsonb)
             || '{"extraPagesPerMonth": 20000,
                  "maxModelCallsPerDay": 40000,
                  "ingest": {"perDay": 60000, "perMinute": 300}}'::jsonb
 WHERE clerk_org_id = 'org_XXXXXXXX';
```

To undo afterwards:
`UPDATE tenants SET limits = limits - 'extraPagesPerMonth' - 'maxModelCallsPerDay' - 'ingest' WHERE clerk_org_id = 'org_XXXXXXXX';`
(Run this only after migration 62, otherwise the next Stripe event removes them anyway.)

### vercel.json (add to the existing `crons` array)

```json
{ "path": "/api/account?action=sweep&mode=docs", "schedule": "*/15 * * * *" }
```

## Files changed

Code: `api/upload-url.js`, `api/records.ts`, `api/_lib/plan.js`, `api/_lib/rateLimit.js`, `api/_lib/recordsStore.js`,
`api/_lib/readDocument.js`, `api/_lib/seats.js`, `api/_lib/routes/cron-sweep.js`, `api/_lib/routes/v1-ingest.js` (comment),
`api/_lib/routes/export-csv.js`, `api/_lib/intake/queue.js`, `src/mobile/offline/uploadQueue.ts`, `src/services/bulkImport.ts`,
`src/screens/IntakeScreen.tsx`, `src/components/records/useRecordsBrowse.ts`.
New: `M3-config/62-rate-limit-refund-and-owner-overrides.sql`, `M3-config/63-page-count-index.sql`, `scripts/verify-r35-limits.mjs`,
`scripts/r35-measure.mjs`, `scripts/lib/r35Harness.mjs`, this file. `package.json`: `verify:r35-limits`, appended to `verify:all`.
Tests adjusted: `scripts/verify-r34-breakit-uploads.mjs`, `scripts/verify-r33-dates.mjs`.
`api/` still has exactly 12 top-level files. No `.env` created, no dependency installed, no Donovan engine, router, support-bot or
telemetry file touched.
