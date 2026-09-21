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
- `scripts/verify-business-corpus.mjs` — new, 71 pure checks (35 for the
  default corpus + 36 for the small subset below), wired as the last step of
  `verify:all`, run against **both** scales. Covers: generator determinism
  (two runs produce byte-identical output), key internal consistency (county
  sum = AZ state total, state sum = customer total, every document belongs
  to exactly one customer or the letterhead-only set — never both, never
  neither, never twice — tallies of brand/warranty-status/document-type
  independently recomputed and compared), every question's expected value
  independently re-derived from the key, and — for the small subset
  specifically — that all 3 AZ counties, ≥1 out-of-state customer, all 8
  brands, all 15 document types, and ≥3 of the 4 warranty-status buckets are
  actually *present* in the generated data, not just internally consistent.

### Cheaper testing: `--customers N` / `--out <dir>`

`scripts/synth-business.mjs` now takes two flags for a smaller, cheaper
corpus, per the owner's request:

```
node scripts/synth-business.mjs --customers 30 --out test-docs/business-small
```

The **default run (no flags) is byte-for-byte unchanged** — verified by
hashing `ANSWER_KEY.json` before and after this change (same
`04b48bb2...` SHA-256). A `--customers` run:

- uses a reduced, representative geography (Mesa/Maricopa, Casa Grande/
  Pinal, Tucson/Pima, Las Vegas/NV) instead of all 19 full-scale cities, so
  it still guarantees all 3 AZ counties and ≥1 out-of-state customer at any
  size;
- scales the apartment complex to 4 units (8 at `--customers 60` or above);
- scales the traps down: 1 near-miss surname pair (of the full run's 2), 1
  name-variant household (of 3), 2 letterhead-only documents (of 4);
- reduces to 20 analytics + 20 lookup questions (of 30/30), built from
  city-safe phrasing (no question names a city that doesn't exist at that
  scale);
- switches correspondence documents from `.pdf` to `.txt` (cheaper to
  extract, same content) — dispatch notes and nameplate-photo transcripts
  were already `.txt`. PDFs stay single-page at every scale (every template
  is well under the ~53-lines-per-page budget the hand-rolled PDF writer
  uses, full or small);
- warns (not fails) if `--customers` is small enough (<15) that full
  document-type/brand coverage can no longer be guaranteed.

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
  `verify:business-corpus` (all checks pass, both scales).

### Small subset (`--customers 30 --out test-docs/business-small`)

- **30 customers, 144 documents** (139.5 KB raw / ~197 KB base64).
- **By state:** AZ 29, NV 1. **By county (AZ only):** Maricopa 13, Pinal 8,
  Pima 8 — all 3 present.
- **Equipment by brand** (30 units, all 8 present): Trane 5, Carrier 4,
  Goodman 5, Lennox 3, Rheem 4, York 3, Daikin 3, Mitsubishi 3.
- **Warranty status:** expired 17, active 7, expiring 3, unknown 3 — all 4
  buckets present.
- **Documents by type:** all 15/15 present (invoice 30, service-ticket 30,
  proposal-quote 13, warranty-registration 13, dispatch-note 8, work-order 7,
  startup-sheet/inspection-report/equipment-record/correspondence/
  maintenance-agreement 5 each, permit 5, other 5, purchase-order 4,
  nameplate-photo 4).
- **Traps:** 1 near-miss-surname pair, 1 name-variant household, a 4-unit
  apartment complex, 2 letterhead-only documents.
- **40 questions** (20 analytics + 20 lookup); self-test: 40/40 correct,
  30/30 customers matched, 1/1 merge trap held, 100% docs/units linked.

## Cost estimate

Computed per document FORM, not a flat rate, now that the small subset mixes
`.pdf` and `.txt`: **$0.012/PDF, $0.006/txt** (a plain-text extraction is
half the token cost of a rendered PDF page).

- **Full corpus:** 560 PDF + 44 txt = 604 docs → 560×$0.012 + 44×$0.006 =
  **$6.98**.
- **Small subset:** 127 PDF + 17 txt = 144 docs → 127×$0.012 + 17×$0.006 =
  **$1.63**.

Both figures are printed by the generator itself on every run (`Document
forms:` / `Estimated Haiku extraction cost:` lines), so they never drift
from what actually got written to disk.

## Exact ingest steps (for the owner, or for me once he's signed in)

Use the small subset (`test-docs/business-small/`, ~$1.63) for a first pass
or to test a code change cheaply; use the full corpus
(`test-docs/business/`, ~$6.98) for the real analytics-accuracy scoring run.
Steps are identical either way, just point at the other directory.

1. **Build the bundle** (already done, re-run any time the corpus changes):
   ```
   node scripts/synth-business.mjs        # regenerates test-docs/business/ + ANSWER_KEY.json
   node scripts/build-bundle.mjs test-docs/business

   # or, for the cheaper subset:
   node scripts/synth-business.mjs --customers 30 --out test-docs/business-small
   node scripts/build-bundle.mjs test-docs/business-small
   ```
   Writes `test-docs/business/bundle.json` (851.9 KB) or
   `test-docs/business-small/bundle.json` (196.5 KB) — both well under the
   8 MB single-file budget, so no chunking occurs either way.

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

## Update (2026-09-21, later same day): dates capped at today, customer contacts, `--contacts-topup`

Two live findings from the owner's own testing, fixed in `scripts/synth-business.mjs`
(`CORPUS_VERSION` bumped to `2`, stored in `ANSWER_KEY.json`, so a stale key is
visible):

1. **No document printed a customer phone/email** (0/144). Real invoices/work
   orders/tickets do. Fixed: ~80% of customers now get a phone on file, ~50%
   an email (independent, deterministic per customer — varied formats: `(480)
   555-01xx`, `480-555-01xx`, `Ph: 480.555.01xx`, `Cell: 480-555-01xx`; varied
   lowercase email domains; area code follows the customer's state; never the
   shop's own `(480) 555-0199`/`info@sonorancomfortair.com`). Printed on
   invoices (`Bill To:` block), service tickets and work orders (`Customer
   phone:`), warranty registrations (`Homeowner email:`), and correspondence
   (`Re: ... - <phone>` / `Email on file:`).
2. **Some documents were dated after 2026-09-21** (up to 2031 in a few cases)
   — `installDateFor()`'s formula could itself land past today, and every
   `addDaysIso(installDate, N)`-derived service/invoice/work-order/proposal/
   inspection/purchase-order/dispatch-note/memo date could overshoot today for
   a recent install. Fixed with a `capToday()` clamp applied at both. The one
   deliberate exception: a maintenance agreement's `Agreement Period` (e.g.
   `01/01/2025 - 12/31/2026`) is a contract term, not an event date — like a
   warranty's "Valid through," its end date is *supposed* to be in the
   future, so it's left alone (`verify-business-corpus.mjs`'s date check
   excludes `maintenance-agreement` filenames for the same reason).

**The already-uploaded `test-docs/business-small/` (144 files) was changed as
little as possible.** Contact info is computed for every customer and
recorded in *both* corpora's `ANSWER_KEY.json`, but is only **printed** into
documents when the run is not that exact, already-shipped combination
(`--customers 30 --out test-docs/business-small`, no `--contacts-topup`) — a
`PRINT_CONTACTS` flag gates it. So re-running the small corpus's generator
changed **11 of its 144 files**, solely from the date-cap fix (a — nothing
from contacts, since printing was suppressed there):

```
027-proposal-quote-c5.pdf   028-service-ticket-c5.pdf   030-other-c5.pdf
053-service-ticket-c10.pdf  054-other-c10.pdf           055-purchase-order-c10.pdf
117-proposal-quote-c23.pdf  118-service-ticket-c23.pdf  120-dispatch-note-c23.txt
141-service-ticket-apt4.pdf 142-dispatch-note-apt4.txt
```
The other 133 files are byte-identical to what's already ingested (verified
by SHA-256 diff against the pre-fix corpus). Only those 11 need re-uploading
if the account already has the old versions; skip the rest.

### `--contacts-topup`: proving contact extraction without re-ingesting the 144

```
node scripts/synth-business.mjs --customers 30 --out test-docs/business-small --contacts-topup
node scripts/build-bundle.mjs test-docs/business-small-topup
```
Runs the whole small-corpus generator in memory (same deterministic facts,
same seed) but **writes nothing into `test-docs/business-small/`** — no
mkdir, no cleanup, no `ANSWER_KEY.json` overwrite, every `writePdf`/`writeTxt`
call is a no-op on disk for the base dir. Instead it writes **one new invoice
per customer who has a phone or email on file** into
`test-docs/business-small-topup/` (27 documents from the current seed —
`201-invoice-topup-res0.pdf`, `202-invoice-topup-res1.pdf`, ...), each with a
new invoice number, a date ≤ today, and content guaranteed distinct from
every other generated document (verified sha256-clean against both corpora),
plus `test-docs/business-small-topup/TOPUP_KEY.json` (customer → expected
phone/email/filename). Upload just this ~27-document, ~$0.32 batch onto the
already-ingested account to prove phone/email extraction without touching
anything already there.

### Contact + date numbers

- **Full corpus** (regenerated, free to change): 97/120 customers have a
  phone, 60/120 have an email — printed directly into its 604 documents.
  67 questions now (was 60): 31 analytics (+1: "How many customers have an
  email on file?") and 36 lookup (+6: 3 phone + 3 email fact lookups).
- **Small corpus key** (documents unchanged except the 11 above): 25/30
  customers have a phone, 16/30 have an email — recorded in the key and
  provable via the 27-document topup, not printed in the base 144. 47
  questions now (was 40): 21 analytics, 26 lookup, same +1/+6 shape.
- No document in either corpus (or the topup) prints a date after
  2026-09-21, other than a maintenance agreement's forward-looking contract
  period — checked by two new `verify-business-corpus.mjs` assertions plus a
  `[small-topup]` block (10 more checks: base dir untouched, topup count
  matches contacts-in-key, no future dates, every topup invoice actually
  prints its promised phone/email, no sha256 collision with either corpus,
  and `--contacts-topup` itself is deterministic across two runs). Verify
  suite is now 79 checks total (37 full + 32 small + 10 small-topup),
  `npm run verify:all` green.
- `bundle.json` rebuilt for `test-docs/business` (870.2 KB) and
  `test-docs/business-small` (196.5 KB, reflects the 11 changed files); new
  `test-docs/business-small-topup/bundle.json` (46.1 KB).

## Update (2026-09-21, third pass): near-miss surname trap applied before rendering, not after

Same class of bug as the brand mismatch above, this time on customer names.
`ANSWER_KEY.json` said `res_2` = "Sorensen" @ 174 N College Ave and `res_11`
= "Sorenson" @ 507 N Dobson Rd — but the base documents at those addresses
printed "Donna Thornton" and "Donald Holbrook". Root cause: the near-miss
trap ran *after* `buildResidential()` had already written the customer's
real documents, patching only the in-memory answer-key object. The
`--contacts-topup` invoices, generated from a fresh run, then picked up the
(different) trapped names, so the topup and base disagreed with each other
too.

Fixed by resolving `residentialTotal` and the near-miss pairs' clamped
indices statically (before any building happens — `CITIES`' `residential`
counts are all literals) and having `nameFor()` bake the forced surname into
the name *before* `buildResidential` renders that customer's first document.
`mustNotMerge` is now built directly from the already-correct names, never
patched afterward. Verified: documents are what a real system extracts, so
they're the source of truth — the key can now never describe a name no
document prints.

**For the frozen small base**, forcing a name into `test-docs/business-small`'s
144 already-uploaded files was not an option (would change their text for no
reason other than this bug). A `APPLY_NAME_TRAPS` flag (gated on the same
"is this exactly the shipped 30-customer/business-small identity" check used
for contacts, shared by both the base run and its `--contacts-topup` run so
they never disagree on a name) turns the trap off entirely for that specific
corpus: `res_2`/`res_11`'s key now correctly reads **Donna Thornton** / 174 N
College Ave and **Donald Holbrook** / 507 N Dobson Rd — exactly what the
documents already said — and `mustNotMerge` is `[]` for that key (there is no
naturally-occurring near-miss surname pair among the real, un-trapped names;
per the coordinator's own fallback, the trap is dropped from this one key
rather than invented). The full corpus and any other/future `--customers`
run still get the real trap, now correctly baked into the documents:
`res_2`/`res_11` → **Donna Sorensen** / **Donald Sorenson**, `res_20`/`res_33`
→ **Emily Whitfield** / **Charles Whitford**, verified present in the actual
PDF text.

**Key entries that changed:**
- `test-docs/business/ANSWER_KEY.json` (full, free to change): `res_2`,
  `res_11`, `res_20`, `res_33` canonicalName now matches what's baked into
  their (regenerated) documents; `mustNotMerge` unchanged in shape (still 2
  pairs) but now true.
- `test-docs/business-small/ANSWER_KEY.json`: `res_2` → "Donna Thornton",
  `res_11` → "Donald Holbrook" (both previously "Sorensen"/"Sorenson"),
  `mustNotMerge` → `[]` (previously `[["res_2","res_11"]]`). **The 144 files
  on disk did not change** (byte-for-byte identical, re-verified).
- `test-docs/business-small-topup/TOPUP_KEY.json`: regenerated so its two
  affected invoices (`res_2`, `res_11`) print "Donna Thornton"/"Donald
  Holbrook" — matching the base corpus — instead of the old, now-incorrect
  "Sorensen"/"Sorenson"; their sha256s changed (new content, still
  collision-free against both corpora) — everyone else's topup invoice is
  unaffected.

**New verify checks** (`scripts/verify-business-corpus.mjs`, +2 per corpus):
for every customer, `canonicalName` appears in at least one of its own
documents (not necessarily all — a nameplate-photo transcript never prints a
customer name, by design); and every name printed right after a `Customer:`/
`Bill To:`/`Homeowner:`/`Dear ... ,` label belongs to that document's
customer, never someone else's. Verify suite is now 90 checks total (41 full
+ 39 small + 10 small-topup — full has 2 more than small since it has 2
mustNotMerge pairs to check where the frozen small key correctly has 0),
`npm run verify:all` green.

## Files touched

- `scripts/synth-business.mjs` — new (generator); extended with
  `--customers N` / `--out <dir>` for a cheaper subset (default-run output
  unchanged, hash-verified); later extended again with `capToday()` (dates),
  `contactFor()`/`PRINT_CONTACTS` (customer phone/email), `CORPUS_VERSION`,
  and `--contacts-topup`.
- `test-docs/business/` — new (604 generated docs + `ANSWER_KEY.json` +
  `bundle.json`); regenerated for the date/contact fix (free to change).
- `test-docs/business-small/` — new (144 generated docs + `ANSWER_KEY.json`
  + `bundle.json`, from `--customers 30`); 11 of the 144 files changed for
  the date-cap fix only (listed above), the other 133 are byte-identical.
- `test-docs/business-small-topup/` — new (27 contact-proving invoices +
  `TOPUP_KEY.json` + `bundle.json`, from `--contacts-topup`).
- `scripts/score-corpus.mjs` — extended (`containsAnalyticsMatch`,
  `--key` flag, `analytics`/`lookups` breakdown in the scorecard).
- `scripts/build-bundle.mjs` — new (generalized, chunking).
- `scripts/browser-ingest.js` — new (paste-in console script).
- `scripts/verify-business-corpus.mjs` — new; runs its full check suite
  (79 checks) against `test-docs/business/`, `test-docs/business-small/`,
  and a `[small-topup]` block for `--contacts-topup`.
- `package.json` — added `verify:business-corpus`, wired into `verify:all`.

---
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uwc37MXKyvkjvNUD6Lmb5X
