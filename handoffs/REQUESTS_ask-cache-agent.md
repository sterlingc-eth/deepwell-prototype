# Request to whoever owns extractFields.js / extractDocument.js / readDocument.js

From: ask-cache-agent (2026-09-20, late). Filed instead of edited because
those three files are not in this task's ownership (`api/_lib/answer.js`,
`api/_lib/promptCache.js`, `api/ask.js` log line only, `scripts/verify-caching.mjs`,
`handoffs/COST_REPORT_2026-09-20.md`, `docs/HVAC_WARRANTY_RESEARCH.md` read-only).

## What changed under you

Two bugs in `api/_lib/promptCache.js` are corrected (see
`handoffs/COST_REPORT_2026-09-20.md`'s "Correction 2026-09-20 (late)" section
for the full writeup):

1. `CACHE_MIN_TOKENS.haiku`: **2048 -> 4096** (the real Anthropic minimum for
   claude-haiku-4-5; 2048 was simply wrong).
2. `estimateTokens`: **`ceil(chars/4)` -> `floor(chars/4.6)`** (chars/4
   over-estimates English-prose tokens; the real ratio is closer to
   chars/4.3-4.6, and flooring keeps the estimate pessimistic-toward-"not
   cacheable" rather than optimistic).

Both call sites you own build a "stable prefix" specifically to clear the old
2048-token minimum. Under the corrected numbers, **neither one clears 4096
any more**:

| Stable prefix | File | Current chars | Current est. tokens (new formula) | Needs (chars, ~) | Needs (est. tokens) |
|---|---|---:|---:|---:|---:|
| Extract field/type guide (`splitExtractPrompt(buildExtractPrompt(...))`'s `stable` half) | `api/_lib/extractFields.js` (content) / `api/_lib/extractDocument.js` (call site) | ~9,209 | ~2,001 | **>= 20,000** (target est >= 4,600, matching the safety margin used for Ask's SYSTEM_PROMPT) | >= 4,600 |
| `TRANSCRIBE_SYSTEM_PROMPT` | `api/_lib/readDocument.js` | ~8,554 | ~1,859 | **>= 20,000** | >= 4,600 |

Verify with: `node -e "import('./api/_lib/promptCache.js').then(pc => import('./api/_lib/extractDocument.js').then(async ed => { const ef = await import('./api/_lib/extractFields.js'); const full = ef.buildExtractPrompt([{page_no:1,text:'x'}],'invoice'); const {stable} = ed.splitExtractPrompt(full); console.log(stable.length, pc.estimateTokens(stable)); }))"` (swap in `readDocument.js`'s `TRANSCRIBE_SYSTEM_PROMPT` for the other row).

## What to add (genuinely useful, not filler — same bar `handoffs/COST_REPORT_2026-09-20.md` already held these two prefixes to)

Ideas that would help the model these prompts are actually sent to, not just
pad token count:

- **extractFields.js**: OCR digit-confusion cheat sheet (0/O, 1/I/l, 5/S,
  8/B — already mentioned in prose in the Rules bullets; a compact table
  would both help and add real length); a short worked example per document
  TYPE (not just per field) showing which fields typically co-occur on a
  work order vs. an invoice vs. a startup sheet; unit-conversion notes
  (tons <-> BTU/hr, °F context) since `tonnage`/`cost`/`labor_hours` are
  extracted as free text today.
- **readDocument.js**: layout convention notes per document type (where a
  nameplate's serial/model block usually sits vs. an invoice's total line);
  a handwriting-shorthand glossary (tech shorthand like "PM", "chk", "rplc");
  multi-column / multi-unit page layout guidance (a maintenance agreement
  listing several RTUs in a table).

## Verification already updated on this end

`scripts/verify-caching.mjs` and `scripts/verify-transcribe.mjs` now assert
the CURRENT (not-yet-cacheable) state for both of these, each pointing back
at this file, so `verify:all` stays green without a false "already fixed"
assertion. Once you raise either prefix past 4096 est. tokens, flip that
assertion in the relevant script back to `expectCacheable: true` (verify-caching.mjs)
/ the positive `'cache_control' in ...` check (verify-transcribe.mjs) — the
exact line is marked with a comment referencing this file.
