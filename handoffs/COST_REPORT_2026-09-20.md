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

## Correction 2026-09-20 (late)

Production logs still showed `cache_read:0, cache_creation:0` on every
`/api/ask` call after the above shipped. Root cause: this report's own "Haiku
min 2048" was wrong. The real minimum for `claude-haiku-4-5`, per the current
Anthropic docs (platform.claude.com/docs/en/build-with-claude/prompt-caching,
fetched 2026-09-20), is **4096 tokens** — double what `api/_lib/promptCache.js`
(`CACHE_MIN_TOKENS.haiku`) assumed. Every "now cacheable" row in this report's
own table above was measured against that wrong bar; `withCache()` dutifully
attached `cache_control` to blocks Anthropic itself still refused to cache,
which is the actual reason the hit rate stayed at 0% for Haiku regardless of
how much reference content was added.

Two more bugs, both in the same file, compounded it:

1. `estimateTokens` used `ceil(chars/4)`, on the (backwards) theory that
   chars/4 under-estimates real BPE token counts for English prose. It's the
   opposite: ordinary prose tokenizes closer to chars/4.3-4.6 (whitespace and
   common words batch into fewer, longer tokens), so chars/4 OVER-estimates —
   exactly the wrong direction for a "don't claim cacheable when it isn't"
   heuristic. A 9,377-char prompt this file reported as ~2,345 tokens was
   really ~2,050-2,150. Corrected to `floor(chars/4.6)` — now biased LOWER
   than the real count, so it can under-claim cacheability but never
   over-claim it.
2. `withCache()` measured each block (system prompt, context block, tool
   schema) in isolation against the minimum. Anthropic actually bills the
   CUMULATIVE prefix up to each breakpoint, in request order (tools -> system
   -> messages) — so a block that individually falls short can still be a
   valid breakpoint once an earlier block in the same request has already
   pushed the cumulative total past the minimum. A per-block check can only
   under-attach breakpoints, never over-attach them, but it was silently
   leaving cacheable blocks unmarked. Added `planCacheBreakpoints({tools,
   system, messageBlocks}, model)` (`api/_lib/promptCache.js`) to replace
   `withCache()` at `/api/ask`'s one call site (`api/ask.js`) — it walks all
   three groups in Anthropic's own billed order, tracks the running total,
   and attaches `cache_control` only where cumulative tokens clear the
   model's real minimum, capped at the existing 4-breakpoint limit.

### What changed

- `api/_lib/promptCache.js`: `CACHE_MIN_TOKENS.haiku` 2048 -> **4096**;
  `estimateTokens` `ceil(chars/4)` -> **`floor(chars/4.6)`**; new
  `planCacheBreakpoints()`; `modelCallLogLine()` gained optional
  `stopReason`/`factsRaw`/`factsKept` fields (diagnostics only — counts and a
  short enum, never content) so a Vercel log line can now show whether a call
  was cut off (`stop_reason`) and how many facts the model returned vs. how
  many `shapeAnswer` actually kept after grounding.
- `api/_lib/answer.js`: `SYSTEM_PROMPT` raised again — this time genuinely
  needed, not just "clear the (wrong) 2048 bar" — with an extracted
  field-key guide (reused from `extractFields.js`'s own `FIELD_SPECS`, never
  copied by hand), a required-fields-per-type guide (reused from
  `documentTypes.js`'s `REQUIRED_FIELDS`), an HVAC abbreviation glossary
  (AHU, RTU, SEER/SEER2, TXV, VAV, VFD, ERV/HRV, MERV, CFM, BTU, ACH, PSI,
  ...), and a compressor-vs-parts warranty note condensed from
  `docs/HVAC_WARRANTY_RESEARCH.md`. Real, load-bearing reference content
  (each section marked "background only", same sourcing rules unchanged),
  now measuring **~21,300 chars / ~4,631 est. tokens** — clears the
  corrected 4096 minimum with a ~535-token safety margin (target was
  >= 4,600).
- `api/_lib/answer.js` (separate fix, same file, filed together): the
  2026-09-20 RULES/facts trim had an unintended side effect — Haiku started
  refusing ("Nothing in your records answers that.") on an AMBIGUOUS question
  (a customer with several units/warranties/matching customers) instead of
  answering the best match. Added an explicit RULES bullet and rewrote the
  `text`/`facts` tool-schema descriptions: on an ambiguous question, answer
  for the best match and name the other candidates in one clause, or return
  one fact per matching record (still capped at 5); no-answer is reserved for
  evidence that is genuinely irrelevant to the question. The sourcing/citation
  rules are untouched.
- `api/ask.js`: switched from per-block `withCache()` to
  `planCacheBreakpoints()`; `max_tokens` 700 -> **900** (the disambiguation
  fix above can legitimately cost a few more output tokens — naming other
  matches or returning up to 5 per-record facts instead of a one-line
  refusal); log line now passes `stopReason`/`factsRaw`/`factsKept`.
- `scripts/verify-caching.mjs`: rewritten boundary/estimator tests for the
  corrected numbers; new direct unit tests for `planCacheBreakpoints`
  (cumulative-prefix attachment, the 4-breakpoint cap, `{ttl:'1h'}`, empty
  input); new tests asserting the ambiguity-fix RULES text is present and the
  sourcing rules are unchanged; the two stable prefixes this agent does not
  own (extraction, transcription) are now asserted against their REAL current
  state (not yet cacheable under the corrected minimum) rather than an
  aspirational one — see below.

### Known gap this agent does not own

`api/_lib/extractFields.js`'s stable field/type guide (used by
`api/_lib/extractDocument.js`) and `api/_lib/readDocument.js`'s
`TRANSCRIBE_SYSTEM_PROMPT` were both sized to clear the old, wrong 2048
minimum and do not clear the corrected 4096 one (~2,000 and ~1,860 est.
tokens respectively — both need roughly double their current content). These
two files are outside this task's ownership, so the exact needed change
(content ideas included, not just "make it longer") is filed in
`handoffs/REQUESTS_ask-cache-agent.md` instead of edited directly.
`scripts/verify-caching.mjs` and `scripts/verify-transcribe.mjs` were updated
to assert this real, current (not-yet-fixed) state so `verify:all` stays
honest and green — each assertion is commented with a pointer back to the
request file, to flip once that work lands.

### Results (re-run after this correction)

`npm run typecheck:api` — clean.
`npm run verify:all` — clean (all PASS; extraction/transcription's known
caching gap above is asserted as a known, filed gap, not silently masked).
`npm run build` — clean.
`api/` file count — still 12 (no files added or removed under `api/`; all
changes in `api/_lib/`, `api/ask.js`'s log line, and `scripts/`).
