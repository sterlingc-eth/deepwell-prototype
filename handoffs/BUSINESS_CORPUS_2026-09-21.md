# Workstream B — 600-document business corpus (2026-09-21)

Built per `handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md`'s Workstream B,
exercising exactly the field vocabulary and geo table Workstream A shipped
(`handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md`, `api/_lib/analytics.js`,
`api/_lib/geo/zip-county.json`, `api/_lib/warrantyRules.js`). Reused
`scripts/synth-corpus.mjs`'s hand-rolled PDF builder and document templates
byte-for-byte (no em-dashes in any PDF text); no git, no DDL, no new deps.

## What was built

- `scripts/synth-business.mjs` — generates `test-docs/business/`: a
  fictional Phoenix-metro HVAC company, "Sonoran Comfort Air" (same shop as
  `synth-corpus.mjs`, plus a shop email now on every letterhead alongside the
  phone). Deterministic (mulberry32-seeded, re-run twice → byte-identical
  output — checked by `verify-business-corpus.mjs`).
- `test-docs/business/ANSWER_KEY.json` — 120 customers, 604 documents,
  computed against the real product code (`api/_lib/analytics.js`'s
  `deriveGeo`/`warrantyStatusOf`, `api/_lib/warrantyRules.js`'s
  `deriveWarranty`), not re-implemented, so the key and the app can never
  disagree about which county a ZIP is in or when a unit's warranty expires.
- `scripts/score-corpus.mjs` — extended: `containsAnalyticsMatch` scores a
  `type: "analytics"` question's numeric answers **exactly** (an expected
  "14" must appear as its own whole-number token — "114" or "40" no longer
  falsely pass — while "14 customers" still passes); non-numeric expected
  values (brand/city/customer names in a groupBy or list answer) still match
  by substring. Backward-compatible: the original 12-customer synthetic
  corpus (no `type` field on its questions) still self-tests at 100%. Added
  `--key <path>` as an alias for `--answerkey`.
- `scripts/build-bundle.mjs` — generalized from the one-off snippet in
  `handoffs/LIMIT_TEST_PLAN_2026-09-20.md` into a reusable script
  (`node scripts/build-bundle.mjs test-docs/business`); chunks output into
  `bundle.1.json`, `bundle.2.json`, ... (+ `bundle-manifest.json`) if a
  corpus's base64 payload would ever exceed 8 MB in one file. Not needed at
  this corpus's size (see Numbers below) but the tool is now correct if the
  corpus grows.
- `scripts/browser-ingest.js` — plain, dependency-free JS to paste into the
  signed-in app's DevTools console. Extends
  `handoffs/LIMIT_TEST_PLAN_2026-09-20.md`'s Steps 2-4 with:
  1. concurrency capped at 2, self-throttled under 60 units/minute
     (`DW_UNITS_PER_MINUTE = 55`, a safety margin under the product's cap),
     plus reactive `Retry-After`/exponential backoff on any 429 as a backstop;
  2. resumable — progress persisted to `localStorage`, and even without that,
     the server's own sha256-based `alreadyUploaded` on `/api/upload-url`
     means a re-run skips the PUT for a file already stored;
  3. `dwWaitForIngest(ids)` polls `/api/document-status` (same 15-minute cap
     as `src/services/ingestClient.ts`);
  4. `dwCaptureSnapshot(questions)` fetches customers/documents/scan/asks,
     downloads all four as files (for `score-corpus.mjs --dir`), **and**
     builds a compact summary (only the fields the scorer reads) chunked into
     ≤900-character pieces read back via `window.__dwPiece(i)` /
     `window.__dwPieceCount()` — for a tool with small per-call output limits
     to reconstruct the whole snapshot without ever reading one giant blob.
- `scripts/verify-business-corpus.mjs` — new, 31 pure checks, wired as the
  last step of `verify:all`. Covers: generator determinism (two runs
  produce byte-identical output), key internal consistency (county sum = AZ
  state total, state sum = customer total, every document belongs to exactly
  one customer or the letterhead-only set — never both, never neither, never
  twice — tallies of brand/warranty-status/document-type independently
  recomputed and compared), and every question's expected value independently
  re-derived from the key rather than just re-read.

## Numbers

- **120 customers, 604 documents** (605.6 KB raw / ~852 KB base64 — one
  `bundle.json`, no chunking needed).
- **By state:** AZ 116, NV 2, NM 1, CA 1.
- **By county (AZ only):** Maricopa 70, Pinal 26, Pima 20.
- **By city (top few):** Mesa 16 (includes the 8-unit apartment complex),
  Tucson 12, Phoenix 10, Chandler 10, San Tan Valley 8, Casa Grande 8,
  Gilbert 8, Tempe 8 — 19 cities total, all 9 Maricopa + 4 Pinal + 3 Pima
  cities the brief named, plus Las Vegas/Albuquerque/Los Angeles.
- **Equipment by brand** (132 units total): Trane 17, Carrier 15, Goodman 17,
  Lennox 15, Rheem 17, York 16, Daikin 17, Mitsubishi 18. York is
  deliberately included as the one unverified brand in `warrantyRules.js`
  (`rule: null`) — every York unit resolves to `warrantyStatus: "unknown"`,
  which is exactly what the real product does and what 16/16 "unknown" units
  in the corpus confirms.
- **Warranty status as of 2026-09-21** (via `deriveWarranty` +
  `warrantyStatusOf`, not hand-computed): expired 77, active 33, expiring 6,
  unknown 16.
- **Documents by type** (15/15 types the app supports, all exercised):
  invoice 120, service-ticket 120, proposal-quote 60, warranty-registration
  52, work-order 31, startup-sheet 27, permit 27, maintenance-agreement 27,
  dispatch-note 25, other 20, inspection-report 19, equipment-record 19,
  correspondence 19, purchase-order 19, nameplate-photo 19.
- **Traps** (from `handoffs/LIMIT_TEST_PLAN_2026-09-20.md`, scaled up):
  2 near-miss-surname `mustNotMerge` pairs (Sorensen/Sorenson, Whitfield/
  Whitford, different cities), 3 flagged household-name-variant customers,
  an 8-unit apartment complex at one Mesa street address (must resolve to 8
  distinct customers, never merge on shared address), 4 shop-letterhead-only
  documents (must never become a customer), shop phone **and** email on
  every letterhead.
- **60 questions:** 30 analytics (count/list/groupBy over
  state/county/city/brand/warrantyStatus/documentType — including one
  deliberate zero-row case, "how many customers in Yuma County?", to
  exercise the ambiguity rule) + 30 lookup (single-record fact lookups,
  spanning residential, the 8 commercial multi-unit customers, apartment
  units, and out-of-state customers).
- **Self-test:** `node scripts/score-corpus.mjs --selftest --key
  test-docs/business/ANSWER_KEY.json` → 120/120 customers, 2/2 merge traps
  held, 100% documents/units linked, 60/60 questions correct (30/30
  analytics, 30/30 lookup). The original 12-customer corpus still self-tests
  at 100% (backward compatibility confirmed).
- **`npm run typecheck && npm run typecheck:api && npm run lint && npm run
  verify:all`** — all green, `verify:all` now ends with
  `verify:business-corpus` (all checks pass).

## Cost estimate

604 documents x ~$0.012/doc (Haiku extraction, per the owner's already-
accepted rate from `handoffs/LIMIT_TEST_PLAN_2026-09-20.md`) ≈ **$7.25**.

## Exact ingest steps (for the owner, or for me once he's signed in)

1. **Build the bundle** (already done, re-run any time the corpus changes):
   ```
   node scripts/synth-business.mjs        # regenerates test-docs/business/ + ANSWER_KEY.json
   node scripts/build-bundle.mjs test-docs/business
   ```
   Writes `test-docs/business/bundle.json` (851.9 KB — well under the 8 MB
   single-file budget, so no chunking occurs).

2. **Sign in** to the DeepWell app in a browser tab, open DevTools console on
   that tab (so `window.Clerk` and same-origin `fetch` both work).

3. **Paste `scripts/browser-ingest.js`** in full. It only defines functions —
   nothing runs yet.

4. **Paste the bundle and start the upload:**
   ```js
   const bundle = { files: [...] };   // paste test-docs/business/bundle.json's contents
   const results = await dwRunIngest(bundle);
   ```
   This uploads all 604 files at concurrency 2, self-throttled under 60
   units/minute (with reactive backoff on any 429), and is safe to re-run if
   interrupted — already-uploaded files are skipped both locally
   (`localStorage`) and server-side (sha256 `alreadyUploaded`).

5. **Wait for extraction:**
   ```js
   const ids = results.filter((r) => r.documentId).map((r) => r.documentId);
   await dwWaitForIngest(ids);
   ```
   Give the linking/warranty sweep another minute or two after this resolves
   before the next step, same as the original synthetic-corpus run.

6. **Capture the snapshot and score it.** Paste `test-docs/business/
   ANSWER_KEY.json`'s `.questions` array as `answerKeyQuestions`, then:
   ```js
   await dwCaptureSnapshot(answerKeyQuestions);
   ```
   This downloads `customers.json`, `documents.json`, `scan.json`,
   `asks.json` into the browser's Downloads folder (same as
   `handoffs/LIMIT_TEST_PLAN_2026-09-20.md`'s Step 4) **and** builds a
   compact in-memory summary retrievable via `dwPieceCount()` /
   `dwPiece(0)`, `dwPiece(1)`, ... (each ≤900 characters) for a tool reading
   the console with a small output limit — concatenate every piece in order
   and `JSON.parse()` to get `{ customers, documents, scan, asks }`.

7. **Score it** (from the four downloaded files, moved into one directory):
   ```
   node scripts/score-corpus.mjs --dir <that-directory> --key test-docs/business/ANSWER_KEY.json
   ```
   Prints the same scorecard shape as the original corpus, plus an
   `analytics`/`lookups` accuracy split (analytics questions score their
   numbers exactly; lookups score by substring, same as before).

## Files touched

- `scripts/synth-business.mjs` — new (generator).
- `test-docs/business/` — new (604 generated docs + `ANSWER_KEY.json` +
  `bundle.json`).
- `scripts/score-corpus.mjs` — extended (`containsAnalyticsMatch`,
  `--key` flag, `analytics`/`lookups` breakdown in the scorecard).
- `scripts/build-bundle.mjs` — new (generalized, chunking).
- `scripts/browser-ingest.js` — new (paste-in console script).
- `scripts/verify-business-corpus.mjs` — new.
- `package.json` — added `verify:business-corpus`, wired into `verify:all`.

---
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uwc37MXKyvkjvNUD6Lmb5X
