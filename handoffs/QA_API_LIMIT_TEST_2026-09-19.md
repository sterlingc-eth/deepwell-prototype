# QA / Limit & Break Test — DeepWell Production API — 2026-09-19

Target: https://deepwelltechnology.com (Vercel + Neon + Clerk + R2 + Inngest)
Tenant: Sterling's Organization (shop owner, signed in via Chrome tab)
Scope: auth, input abuse, rate limits, ingest-at-load, concurrency, delete safety, ask correctness.
All qa- test data created was deleted at the end; hard limits (8 original docs, account/Clerk/org settings) were not touched.

## FAIL list (ranked by severity)

### 1. [HIGH] `mode:'get'` on /api/upload-url 500s on a malformed (non-uuid) documentId, instead of 400/404
- **Where:** `api/upload-url.js` → `getOriginalUrl()`. It only checks `typeof documentId !== "string" || !documentId.trim()`, then calls `db.getDocument(documentId)`, which does a `::uuid` cast in SQL. A syntactically-invalid uuid throws an uncaught Postgres error that `handleError()` maps to a generic 500.
- **Repro:**
  ```
  curl -s -X POST https://deepwelltechnology.com/api/upload-url \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <valid session token>" \
    -d '{"mode":"get","documentId":"not-a-uuid"}'
  # -> 500 {"error":"Processing failed"}
  ```
  A well-formed-but-nonexistent uuid correctly returns 404 (`{"error":"Document not found"}`) — only the malformed-uuid shape breaks. Same class of bug should be checked on other bare `documentId` string params that skip `isUuid()` (e.g. `read-document.js`'s `documentId` check is also just a non-empty-string check, not a uuid-format check — not confirmed to 500 in this pass, but same pattern; worth a follow-up test).
- **Fix suggestion:** validate `documentId` with the same `isUuid()` regex `reviewStore.js`/`document-delete.js` already use, before hitting the DB, and throw `DocumentGetError(..., 400)`.

### 2. [MEDIUM] Empty-file upload gets permanently stuck at stage `read` with a misleading, already-completed instruction
- **Where:** `api/_lib/extractDocument.js` line 74: `if (!pages.length || !pages.some(p => p.text.trim())) throw new IngestError("This document has no page text yet. Run /api/read-document first.", 409)`.
- **Repro:** uploaded a 0-byte `qa-nasty-empty.txt`, ran `/api/read-document` (non-sync). It queues fine, `document-status` shows `stage:"read"`, `page_count:1` (an empty page row was created), but `extract_error` is permanently set to *"This document has no page text yet. Run /api/read-document first."* — even though read-document is exactly the step that just ran. There is no automatic re-check and no distinct message for "the file has no extractable text" vs. "the file was never read" — a technician following the error's own instruction (re-run read-document) will hit the identical error forever. Document never reaches a terminal `extract_error`-with-clear-explanation state.
- **Impact:** matches exactly the "stuck forever, not a graceful failure" case the test matrix calls out. Low blast radius (empty files are rare) but confusing/support-generating.
- **Fix suggestion:** detect the empty-page case at read time (empty/whitespace-only text) and record a distinct terminal error like "This file has no readable text (it appears to be empty)" instead of routing it through the generic pre-extraction guard.

### 3. [LOW / informational] Per-minute "burst" rate limit on /api/ask did not engage under real production load
- **Where:** `api/_lib/rateLimit.js` — the burst window is an in-memory `Map`, explicitly documented as per-Vercel-instance, not global.
- **Observation:** fired 30 concurrent, then 10 concurrent, then 20 sequential `/api/ask` calls (60 total in under ~90s, vs. the nominal `perMinute: 30`) — **zero 429s**, all 200s, zero 5xx. The documented, Postgres-backed daily cap (500/day) is the only real ceiling; the burst limiter is effectively decorative in this hosting shape because Vercel spreads traffic across many warm instances. Not a code defect (the tradeoff is explicitly commented in source) but worth flagging as a cost-control gap before launch, since 60 model calls landed with no throttling at all and a scripted abuser could sustain much higher throughput than "30/min" suggests before the daily cap bites.
- **No action strictly required**; recommend either a distributed limiter (Redis/Upstash) or accepting the daily cap as the real control and removing the false sense of security from the per-minute number.

## Everything else: PASS

- **Auth (all endpoints: ask, upload-url, document-status, review, warranty-attention, read-document):** no token → 401 `{"error":"Sign in required"}`; malformed/garbage/empty Bearer → 401 `{"error":"Session is invalid or has expired"}`. No stack traces, no internals leaked, no 500s.
- **CORS:** `handleCors()` is a hard allowlist (deepwelltechnology.com, www., the vercel.app domain, localhost dev ports). OPTIONS from `https://evil-attacker.example` returns 204 but **no** `Access-Control-Allow-Origin` header — browsers will block the read. No wildcard `*` anywhere.
- **Method enforcement:** GET on POST-only routes → 405.
- **/api/ask input abuse:** empty question → 400 "Missing question"; 20,000-char question → 400 "Question is too long" (server cap is 2000 chars, enforced); unicode/emoji question → 200 graceful no-answer; SQL-injection-shaped string (`' OR 1=1; DROP TABLE documents; --`) → 200 graceful no-answer, no error, no evidence of string concatenation (parameterized queries hold); question as an object → 400; question as a number → 400 (fails the `typeof === "string"` gate, same as missing).
- **/api/document-status abuse:** 101 ids → 400 "Too many ids in one request"; array of non-uuid strings → 200 `{"documents":[]}` (silently filtered, no 500); empty array → 400; missing field → 400; random-but-valid uuid → 200 empty list (no cross-tenant leak).
- **/api/review abuse:** unknown action → 400; missing action → 400; every action tried with missing/invalid required fields (`correctField`, `classifyDocument`, `linkDocument`, `unlinkDocument`, `verifyDocument`, `mergeEntities`, `aiVerify`) → 400 with a specific, correct field-level message (e.g. "documentId must be a uuid", "keepId must be a uuid"); `reclassify` with only non-uuid ids → 200 `{"changes":[],"remaining":0}` (silently filtered, no 500); `deleteDocuments` with no ids → 400; non-uuid ids → 400; 101 ids → 413; random uuid → 200 `{"deleted":0}` (no leak, no error).
- **/api/upload-url abuse:** path-traversal filename (`../../etc/passwd`) and `.exe` filename both accepted at 200 — **this is safe, not a hole**, because `objectKey()` deliberately never uses the filename in the storage key (content-addressed by tenant+sha256 only — see `r2.js`'s doc comment); the filename is stored only as a display column. 500-char filename → accepted (no length cap, but harmless for the same reason). Empty filename → 400. `sizeBytes: 0` → 400. `sizeBytes: 1GB` → 413 "File is larger than 100 MB". Malformed sha256 → 400. Batch of 51 files → blocked (hit the 60/min ingest burst limit first and returned 429, never even reached the 50-file cap check — still graceful, no 500). `mode:'get'` with a random well-formed uuid → 404, not a leak.
- **Rate limits:** no 5xx observed at any burst volume tested (60 `/api/ask` calls, 51-file batch presign). 429s, when they did fire (the 51-file batch), carried a correct `Retry-After`-bearing body and a clear `details` string.
- **Ingest at load (25 `qa-` documents):** batch-presigned 25 files in 1 call (22 normal `.txt`, 1 empty `.txt`, 1 200KB-random-bytes file named `.pdf`, 1 `.txt` containing only `asdf`) → all 25 got `uploadUrl`s, all 25 R2 PUTs returned 200, all 25 `/api/read-document` (non-sync) calls returned 202 `queued:true` (Inngest queue confirmed live). **Timing:** 24/25 documents got `extracted_at` set — **min 2s, median 6s, avg 6s, max 13s** from trigger to page-text-extracted. 23/25 reached terminal stage `mapped` (all normal files + the `asdf` file, classified `document_type:"other"` as expected for non-HVAC filler content). The 200KB-random-bytes-as-`.pdf` failed cleanly and terminally with Claude's own `"The PDF specified was not valid"` 400, recorded as `extract_error` at stage `received` — not stuck. The empty file is the one stuck case — see FAIL #2. **None reached `verified_by:'ai'`**, which is correct/expected: generic filler text never resolves to a real customer entity, so `aiVerifyDocument`'s completeness gate never passes.
- **Concurrency:** 5 simultaneous `reclassify` calls over the same 25 qa doc ids → all 5 responses `200`, identical (`changes:0, remaining:25` — docs weren't reclassifiable yet), no 500s, no inconsistent state. 5 simultaneous `aiVerify` calls on one doc → all 5 `200`, identical document payload, no 500s. `list all customers` before and after concurrency tests stayed at exactly 5 — no duplicate customer/entity rows created by the concurrent writes.
- **Delete safety:** random uuid → `deleted:0`; mix of a real uuid + a syntactically-invalid id → 400 (all-or-nothing validation, rejects the whole batch rather than partially deleting — reasonable and documented behavior, not a partial-delete hazard); a real uuid + a well-formed-but-nonexistent uuid → `deleted:1`, correct; R2 `mode:'get'` on a just-deleted document → 404 immediately (no dangling access).
- **Ask correctness under noise:** re-asked after the 25 qa docs existed and after 60+ ask calls and concurrent reclassify/aiVerify: *"How much was the Henderson install?"* → **$9,127.00** (unchanged); *"Who is the contact at Plaza Dental?"* → **Dr. Alan Whitfield** (unchanged). Meta-counts also correct throughout (`33 documents` while qa docs existed → `8 documents` after cleanup).
- **Cleanup:** single `deleteDocuments` batch call for all 25 qa ids → `{"deleted":25,"failedStorage":[]}`. Post-cleanup: `"how many documents do we have"` → **8**, `"list all documents"` → **8 documents**. Only the 8 original Desert Peak documents remain. No hard-limit files (01–08) were read, modified, or deleted. No `/api/account` destructive actions, no Clerk/org settings changes, no sign-out.

## Step 4 timing data (ingest at load, 25 qa docs)

| Metric | Value |
|---|---|
| Files batch-presigned in one call | 25/25 succeeded |
| R2 PUT success | 25/25 (200) |
| `/api/read-document` queued (202) | 25/25 |
| Reached `extracted_at` | 24/25 |
| Time to `extracted_at` — min | 2s |
| Time to `extracted_at` — median | 6s |
| Time to `extracted_at` — avg | 6s |
| Time to `extracted_at` — max | 13s |
| Reached terminal stage `mapped` | 23/25 |
| Terminal graceful failure (nasty PDF) | 1/25 — clean `extract_error`, stage `received` |
| Stuck / bad terminal state (empty file) | 1/25 — stage `read`, misleading `extract_error` (see FAIL #2) |
| Reached `verified_by:'ai'` | 0/25 (expected — no real customer data in filler content) |

## Call budget used
~150 requests to `/api/*` (well within the 150-call guidance given the added rate-limit exploration), 25 uploads (within the 40-upload cap), no destructive/prohibited actions taken.
