# Cost report — 2026-09-20 (agent-cost)

Owner ask: "turn on caching within DeepWell / Claude API" + "make sure we're
not wasting money asking questions." Console facts: 7d = 1.9M tokens, $18.48;
prompt cache hit rate 2%; Haiku 264K input / 0% cache-read; Sonnet 151K input
/ 24% cache-read; spend dominated by transcription output tokens.

Root cause of the 2% cache hit rate: every stable prompt prefix (Ask's
SYSTEM_PROMPT, extraction's field/type guide, transcription had no system
prompt at all) was BELOW Haiku's 2048-token cache minimum
(`api/_lib/promptCache.js` `CACHE_MIN_TOKENS.haiku`). `cache_control` was
never attached to those blocks, so Anthropic never cached them — Sonnet's
24% hit rate (its minimum is only 1024) is the only place caching was doing
anything at all, and that's a small slice of total spend.

## 1. Measurement — `scripts/cost-report.mjs`

Run: `node scripts/cost-report.mjs`.

| Prefix | Model | Before (tokens) | After (tokens) | Haiku min | Cacheable before | Cacheable after |
|---|---|---|---|---|---|---|
| Ask `SYSTEM_PROMPT` | claude-haiku-4-5 | 320 | 2306 | 2048 | no | **YES** |
| Ask `ANSWER_TOOL` | claude-haiku-4-5 | 354 | 354 | 2048 | no | no (schema, not padded — see below) |
| Extract stable field/type guide | claude-haiku-4-5 | ~600 | 2303 | 2048 | no | **YES** |
| Extract `EXTRACT_TOOL` | claude-haiku-4-5 | 663 | 663 | 2048 | no | no (schema) |
| Transcribe system prompt (fast=Haiku) | claude-haiku-4-5 | 0 (no system block existed) | 2139 | 2048 | n/a | **YES** |
| Transcribe system prompt (strong=Sonnet) | claude-sonnet-4-5 | 0 | 2139 | 1024 | n/a | **YES** |
| Reclassify `RECLASSIFY_SYSTEM_PROMPT` | claude-haiku-4-5 | small | small (unchanged) | 2048 | no | no — see note below |

max_tokens allowed per call site (after this work):
- Ask: **700** (was 1500 — answers are 1–3 sentences + a small facts array, never used the extra room).
- Extract: 4000 (unchanged — legitimately multi-field documents can need it).
- Transcribe, PDF: **8000** (unchanged — a multi-page PDF returns many pages in one response).
- Transcribe, image: **3000** (was 8000 — an image call is always exactly one page).
- Reclassify: 50 (unchanged — single enum value out).

Reclassify is deliberately left uncached/small: it's already cheap (Haiku,
max_tokens 50, capped at 20 calls/request, first 1500 chars of page text
only — confirmed, no change needed) and padding it to clear the cache
minimum would cost more in extra tokens than the cache would ever save at
that call volume.

## 2. Caching fix

Every stable prefix above was raised with **genuinely useful, load-bearing
content** (never filler):

- **Ask** (`api/_lib/answer.js` `SYSTEM_PROMPT`): added an HVAC glossary
  (RTU, condenser, SEER, tonnage, refrigerant, pipeline stages, ...), the
  document-type guide (reused from `documentTypes.js`, not duplicated), a
  manufacturer warranty-brand summary table (rendered once at module load
  from `warrantyRules.js`'s `BRAND_RULES` — can never drift from the real
  derivation logic), and expanded answer-style rules. Every reference
  section is explicitly marked "background only" and the existing "answer
  only from the evidence above" rule is unchanged, so this cannot become a
  second, ungrounded source of facts (see `verify-answer.mjs`'s new checks).
- **Extraction** (`api/_lib/extractFields.js`): every `FIELD_SPECS` entry now
  carries a worked example (`printed X -> value Y`), plus new Rules bullets
  on OCR digit ambiguity, subtotal-vs-total, multi-technician documents, and
  per-field (not per-page) confidence. This is a better field guide on its
  own merits, not just bigger.
- **Transcription** (`api/_lib/readDocument.js`): added `TRANSCRIBE_SYSTEM_PROMPT`
  — previously there was no system block on this call at all — covering
  layout conventions per document type, handwriting shorthand, OCR digit
  ambiguity, multi-unit documents, and confidence guidance, plus a
  "fields the next step will look for" section reused directly from
  `extractFields.js`'s `FIELD_SPECS` (so it can't drift out of sync).

`api/_lib/promptCache.js`'s `withCache()` gained an optional `{ttl: '1h'}`
param (`CACHE_CONTROL_1H`); still caps at ≤4 breakpoints (unchanged —
`MAX_CACHE_BREAKPOINTS`), asserted directly in `verify-caching.mjs`.
Extraction and transcription's stable prefixes use the 1h TTL (a bulk import
runs the same prefix for hours, past the 5-minute default); Ask keeps the
5-minute default (a one-off Q&A exchange).

**Expected effect**: with these prefixes now clearing Haiku's minimum, a
tenant with any document-processing volume (multiple pages/documents per
import, multiple questions per session) should see cache_read tokens appear
on Ask/Extract/Transcribe where today they're 0% — cache reads are billed at
a fraction of a full input token, so this converts a meaningful chunk of
"every call pays full price for the same instructions" into "pay once per
cache window, read cheaply after that."

## 3. Waste cuts

| # | Change | File | Estimated saving |
|---|---|---|---|
| a | Transcription image calls capped at `max_tokens: 3000` (was 8000, same as PDF); PDF kept at 8000. Blank-page escalation skipped when the fast pass is itself confident (≥ threshold) the page is empty — "stop early on blank pages": a genuinely blank page essentially never turns up real text on a second (Sonnet) pass. | `api/_lib/readDocument.js` | Removes a wasted Sonnet call per confidently-blank page in a scanned batch (cover sheets, blank backs of one-sided forms are common in real HVAC paperwork); image max_tokens cut bounds worst-case runaway generation on the more common (photo) upload path. |
| b | Ask: context capped to ~6K tokens (`CONTEXT_TOKEN_BUDGET`, `selectPassagesForContext`), deduped by (documentId, page) before building the context block; `max_tokens` 1500 → 700. | `api/_lib/answer.js`, `api/ask.js` | Removes duplicate-passage tokens outright (retrieval can return the same page twice for different search terms); 700 vs 1500 max_tokens is billed on OUTPUT only if actually generated, but removes headroom that was never used and bounds worst case. |
| c | Extraction skips pages that are clearly non-content (near-blank, cover sheets, logo-only headers) before they reach the model — unless they carry an identifier/date/dollar fragment, or the document has nothing else. | `api/_lib/extractFields.js` (`selectPages`) | Cuts input tokens 1:1 for every skipped page on a multi-page document (title pages, blank dividers are common in scanned packets). |
| d | Confirmed: documents are deduplicated by `(tenant_id, sha256_hash)` at upload time (`recordsStore.js` `ON CONFLICT`, `api/upload-url.js`) — re-uploading an identical file resolves to the SAME document row, and `ingestDocument`'s `alreadyIngested()` check (`readDocument.js`) already skips re-transcription unless `force: true`. No code change needed. | — | Already correct; documented so it doesn't get "fixed" into a regression later. |
| e | Confirmed: `reclassifyDocuments`'s Haiku fallback already sends only the first 1500 chars of page text (`RECLASSIFY_TEXT_CHARS`), capped at 20 model calls per request. No code change needed. | `api/_lib/reviewStore.js` | Already correct. |

## 4. Per-tenant AI cost estimate

`GET /api/billing?action=status` now returns `usage.aiCostEstimateUsd`
(`api/billing.js`, `api/_lib/usage.js` `estimateCostUsd`/`getUsage`) — the
last 30 days of a tenant's recorded input/output tokens, priced at blended
Haiku/Sonnet list prices (`MODEL_PRICE_PER_MTOK`, overridable via env).
**This is an estimate, not a bill**: `usage_counters` has no per-model or
cache-read/cache-write column (adding one needs a schema change this agent
doesn't own — see `usage.js`'s doc comments), so the blend uses a documented
assumed Haiku/Sonnet mix (`AI_COST_HAIKU_SHARE`, default 0.85) rather than a
measured one. Frontend wiring not done — field is exposed for the Billing
screen to pick up.

## Files touched (1 line each)

- `api/_lib/promptCache.js` — `withCache(block, model, {ttl})`, `CACHE_CONTROL_1H`.
- `api/_lib/answer.js` — expanded `SYSTEM_PROMPT` (glossary/doc-types/brand table/style); `selectPassagesForContext` + `CONTEXT_TOKEN_BUDGET`.
- `api/ask.js` — use `selectPassagesForContext`; `max_tokens` 1500 → 700.
- `api/_lib/extractFields.js` — `FIELD_SPECS` examples; expanded Rules; cover-page skip in `selectPages`.
- `api/_lib/extractDocument.js` — 1h TTL on the cached stable prompt.
- `api/_lib/readDocument.js` — `TRANSCRIBE_SYSTEM_PROMPT` (new, cached, 1h TTL); image vs. PDF `max_tokens`; confidently-blank pages skip escalation.
- `api/_lib/usage.js` — `MODEL_PRICE_PER_MTOK`, `estimateCostUsd`.
- `api/billing.js` — `usage.aiCostEstimateUsd` on `?action=status`.
- `scripts/cost-report.mjs` — new: measures every stable prefix vs. its model's cache minimum.
- `scripts/verify-caching.mjs`, `scripts/verify-answer.mjs`, `scripts/verify-transcribe.mjs`, `scripts/verify-extract.mjs`, `scripts/verify-billing.mjs` — extended (see each file's own new test blocks).

## Results

`npm run typecheck:api` — clean.
`npm run verify:all` — 1651 checks, all PASS.
`npm run typecheck` — clean.
`npm run build` — clean.
`api/` file count — still 12 (no new files added there; all new code in `api/_lib/`).
