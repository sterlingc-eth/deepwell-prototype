# M2 Build Summary — Real ingestion, open schema (v2)

**Repo:** `deepwell-app` · **Status:** built, tuned, independently verified, **critical gap patched and confirmed fixed post-verification** — ready to show Sterling with two known, honestly-reported near-misses (see gaps #2–3)
**Date:** September 13, 2026 · **Gate status:** the one real functional gap independent verification found (stage advancement not resolving through mapped fields) has been patched and confirmed fixed by direct reproduction of the verifier's own failing case; classification and link-precision remain honest near-misses on genuinely hard cases

**Post-verification fix (same day):** the independent verifier's gap #1 below was real. `presentRequiredLabels()` in `src/core/entityGraph.ts` has been rewritten to resolve a required-field label to its canonical field key (matching against every registered field's `label` + `synonyms`, case-insensitively) and check `mappedFieldKey`/`target.field` against that canonical key — falling back to the old raw-text match only for required labels with no registered field yet (e.g. "Permit No."). `ReviewScreen.tsx`'s independent, duplicate copy of the same buggy check was replaced with a call to the new shared `missingRequiredFields()` export so the UI and the pipeline can never disagree again. The verifier's exact repro (doc-01, label "Parts coverage ends" → `equipment.warrantyExpiry`) was re-run directly against the fixed code and now resolves to `stage: 'verified'` instead of getting stuck at `'classified'`. `npx tsc -b`, `npm run build`, and both test suites (23/23 Ask, 15/15 Ingest) were re-run clean after the fix — no regression introduced.

This milestone replaces M1's seeded ingestion demo with the real thing: files go in through `/api/ingest/read` and `/api/ingest/map`, get read by a schema-free universal pass, mapped against a versioned tier-0/1/2 registry, resolved onto entities, deduped, checked for conflicts, and stored in IndexedDB — per the v2 design in `claude/STORAGE_AND_RETRIEVAL_MODEL.md` and the plan in `claude/M2_PLAN.md`.

## Headline numbers (real `--provider claude` tuning run, round 6 of 6)

| Metric | Result | Gate | Status |
|---|---|---|---|
| Classification/aspect accuracy | 22/24 (91.7%) | ≥95% | **miss** |
| Required-field recall (tier-0), as scored by `eval-ingest.ts` | 107/118 (90.7%) | ≥90% | pass (see caveat below) |
| Link precision | 21/23 (91.3%) | ≥97% | **miss** |
| Dedupe/conflict detection | 6/6 signals (100%), 1 false positive | ≥97% (informal) | pass on detection; 1 FP |
| **Proposal-firing recall** (v2 mechanic) | **4/4 novel-schema docs fired a proposal** | 4/4 | pass |
| **Post-confirmation re-map** (v2 mechanic) | 3/3 evidence facets became extractions, 0 new model calls | — | pass |
| M1 Ask eval (regression check) | 50/50, 0 validator strikes | ≥95% | pass — no regression |
| Total model spend, build + tuning | ≈ $3.10 (6 full 27-doc runs + ~6 targeted debug runs) | < $15 | well under budget |
| `npx tsc -b` / `npm run lint:strings` / `npm run build` | clean, 0 errors, 49 files lint-clean | — | pass |
| `node --test scripts/test-api.mjs` | 23/23 | — | pass |
| `node --test scripts/test-ingest-api.mjs` | 15/15 | — | pass |

**Important caveat on required-field recall (90.7%):** independent verification found that this number is scored by `eval-ingest.ts`'s own fuzzy label matcher (`fieldPresent`/`labelsClose`), not by the pipeline's actual stage-advancement gate (`presentRequiredLabels` in `src/core/entityGraph.ts`). Those two do not agree — see **Known gap #1** below. The 90.7% describes whether the *right field was correctly mapped*; it does not describe whether the document visibly reaches the "Extracted" stage badge in the product. That second number was not measured and is expected to be meaningfully lower.

## What "open schema" concretely did in this eval

This is the part M2 exists to prove — that varied real-world document phrasing becomes answerable without a fixed field registry:

- **Universal read fired on every page, unfiltered.** All 27 test documents (26 real rendered files + 1 CSV) went through `/api/ingest/read` with no field registry in the prompt at all — segments and facets came back regardless of whether anything downstream could use them. Verified directly: doc-01 (a clean warranty registration) produced 7 raw facets before any mapping occurred.
- **Mapping pass matched facets to the tier-0 registry, by synonym, not by exact string.** Independent verification's end-to-end walk found `equipment.warrantyExpiry` correctly matched from the raw label "Parts coverage ends" — a phrase that appears in none of the field's own registered synonyms — proving the map step's real job (schema-aware fuzzy/registry matching) works even where it later exposed a *different* bug downstream (see gap #1).
- **Proposals fired on genuinely novel paperwork.** All 4 novel-schema documents built specifically to carry fields absent from the tier-0 HVAC registry (SRP rebate application, city permit checklist, Lennox recall notice, equipment financing agreement) produced clustered proposals — **4/4 proposal-firing recall**, the headline v2 metric. One end-to-end run on the rebate document (doc-24) directly observed 9 facets read (5 known + 4 novel), 6 staying unmapped, and 10 total pending proposals queryable afterward via `pendingProposals()`.
- **Re-map worked with zero re-reading.** Confirming a pending synonym proposal (`proposal-synonym-applicantname`) via `useGraph.confirmProposal` directly (not through the UI) turned its 1 evidence facet into a real extraction on the source document — and the `/api/ingest/read` / `/api/ingest/map` call counters were provably unchanged before and after, confirming `remap.ts` is local and never re-invokes the model, matching the "no re-OCR" contract in `M2_PLAN.md`.
- **Schema Health is real, not decorative.** `pendingProposals`, `discoveredFields`, and `mappingCoverage` (the three selectors backing the Records screen's new Schema Health panel) were called directly against live store state after the pipeline run above and returned real, non-throwing numbers (9 pending proposals, 59.1% mapping coverage) with no seeded/mocked backing data.
- **Real dedupe and real linking, not literals.** The exact-duplicate pair (doc-17/doc-18) triggered a genuine sha256 short-circuit in `receive.ts` — doc-18 never reached a model call and was correctly marked `duplicate_of` doc-17. doc-01 was linked to its real equipment/property entities (EQ001/PROP001) by `resolve.ts`'s actual scoring logic against the actual seeded entity graph, not a hardcoded confidence.

## Per-requirement status (ids from `claude/M2_PLAN.md`)

| Requirement | Plan area | Status | Evidence |
|---|---|---|---|
| ING-01, ING-10 | Upload: drag-drop/picker, real bytes, sha256, per-file progress | SHIPPED | `IntakeScreen.tsx` reads real `File` bytes via `file.arrayBuffer()`, hashes client-side in `receive.ts`; drop zone and picker both call `uploadRealFiles`; live per-doc stage-pill progress panel. |
| §4.3 step 1 (receive/render) | PDF→pages, image normalize, spreadsheet→page-per-sheet | SHIPPED | `src/core/pipeline/receive.ts`; PDF rendering via `pdfjs-dist` (now installed), CSV rows read directly with no model call. |
| ING-10 (dedupe exact) | sha256 exact-dup short-circuit | SHIPPED | Verified live: doc-17/doc-18 pair, doc-18 stopped at `stage='received'` with a `duplicate` issue, no model call spent. |
| v2 §1 — universal read | schema-free segments+facets on every page | SHIPPED | `api/ingest/read.js` + `src/core/pipeline/read.ts`; no registry text enters the read prompt (asserted by `test-ingest-api.mjs`); bbox sanitization, 60-facet/page cap. |
| v2 §2 — mapping | facets → registry/synonym/learned match, ≥0.90/0.70–0.89/<0.70 bands | SHIPPED | `api/ingest/map.js` + `src/core/pipeline/map.ts`; server-side validation drops hallucinated fields/indices and recomputes `unmatchedIndices` from scratch rather than trusting the model. |
| v2 §3 — proposals | clustering + promotion thresholds + Review confirm/reject queue | SHIPPED | `src/core/pipeline/propose.ts`, `remap.ts`; ReviewScreen proposals-to-confirm panel; **4/4 novel docs fired a proposal** (headline metric above). |
| Layered/versioned registry | tier 0→1→2, `schema_versions` rows, targeted re-map on promotion | SHIPPED | `src/domains/hvac/schema.ts` (tier/synonyms/observationCount/addedInSchemaVersion on every `FieldSpec`); `SchemaVersionRow` in `core/types.ts`; re-map proven local (0 new model calls) above. |
| ING-05 (resolve) | serial/model+address/name-street/technician scoring, ≥0.80 link band | SHIPPED | `src/core/pipeline/resolve.ts`, `src/domains/hvac/adapter.ts`; tuned across 6 rounds (multi-facet linking, property→equipment hop, typo-tolerant address match). |
| ING-06 (dedupe near) | field-signature + facet-signature near-dup | SHIPPED (1 known FP) | `src/core/pipeline/dedupe.ts`; 6/6 dedupe/conflict signals detected; 1 false positive on doc-25 (see gap #3). |
| ING-07 (conflicts) | hard conflict on mapped-field disagreement; soft "inconsistent-facet" on unmapped disagreement | SHIPPED | `src/core/pipeline/conflicts.ts`; restricted to a field's owning entity type and made confusable-tolerant during tuning. |
| ING-02 (derived stages) | Received→Read→Mapped→Linked→Verified, machine-advanced | SHIPPED (patched post-verification) | Verification found stage advancement didn't resolve through a facet's mapped field key (**gap #1**, below); fixed the same day in `entityGraph.ts`'s `presentRequiredLabels`/`missingRequiredFields`, re-confirmed against the verifier's exact failing case. |
| ING-12 (progress) | per-batch/per-doc progress; upload→answerable p95 measured | PARTIAL | Live progress UI shipped in `IntakeScreen.tsx`; p95 upload→answerable was not separately re-measured this milestone (eval measures pipeline correctness, not wall-clock latency). |
| toward PLT-02 (persistence) | IndexedDB-backed `RecordsStore`, survives reload, export-all | SHIPPED | `src/core/recordsStore.ts` (real `indexedDB`, memory-store fallback); `hydrateFromStore`/`bootstrapFromStoreOrSeed` in `entityGraph.ts`. One noted gap: `src/domains/hvac/index.ts`'s `bootstrapHvac()` still seeds unconditionally/synchronously rather than calling the new hydrate-first path (outside the Foundation agent's ownership to fix). |
| ASK-02 upgrade (facet index) | unmapped facets answerable, labeled "from an unconfirmed field" | SHIPPED, not independently re-verified this pass | `src/core/facetIndex.ts` built and wired per `docs/INGEST_API.md`; the end-to-end "Ask cites an unmapped facet" path was not re-walked in verification (explicitly noted as out of scope of the 9 checks run). |
| Schema Health panel | proposals/discovered fields/mapping coverage/re-map backlog on Records | SHIPPED | `RecordsScreen.tsx` new section; selectors verified live against real store state (see above). |
| Guard rails | `INGEST_ENABLED`, origin allow-list, per-IP + per-day page cap, separate from `/api/ask`'s budget | SHIPPED | See Guard-rail proof below. |

## Guard-rail proof

Proven by `scripts/test-ingest-api.mjs` (15/15 passing) without touching `/api/ask`'s own suite:

- `INGEST_ENABLED` off → 403 on both `/api/ingest/read` and `/api/ingest/map`.
- Bad `Origin` → 403; no-origin requests still allowed (server-to-server/dev case).
- Body over `INGEST_MAX_BODY_BYTES` (8 MB default) → 413.
- Per-IP token bucket is a **separate pool** from `/api/ask`'s (`memory.ingestBuckets`, distinct Upstash key prefix `ingest:ip:`) — 11th call in a minute → 429 + `Retry-After`; proven independent of `/api/ask`'s own bucket so heavy ingestion traffic can't starve Ask or vice versa.
- `INGEST_DAILY_PAGES` (default 300) caps only the vision-reading pass (`read.js`); `map.js` calls the guard with `pages: 0` so mapping is never blocked by the page cap, matching the plan's framing that only one of the two model passes reads a page image.
- Malformed bodies (including duplicate facet indices) → 400 on both endpoints.
- `api/ask.js`'s own pre-existing 23/23 test suite still passes unchanged after the shared `guard.js` edits — no regression to the Ask guard rails from this milestone's changes.
- `api/extract.js` and `api/search.js` (dead, pre-M0/M1 leftovers, never called live) were removed per the ownership contract; a repo-wide grep confirmed the only remaining reference is a comment, not a live call.

## Known gaps — stated honestly

**1. Stage advancement didn't resolve through mapped fields — FIXED, same day, post-verification.** `presentRequiredLabels()` in `src/core/entityGraph.ts` checked a facet's raw OCR label text (or `extracted[].name`, itself set from `labelRaw`) against each document type's `requiredFields` strings verbatim, never resolving through `mappedFieldKey`/`mappedEntityType` to the canonical field. In the verifier's real end-to-end run, doc-01 — a clean, correctly-read, correctly-mapped, correctly-linked warranty registration — got stuck at `stage='classified'` forever, because its real label "Parts coverage ends" correctly mapped to `equipment.warrantyExpiry` but doesn't literally equal the registry's required string ("Warranty expires") or any of that field's own registered synonyms. This directly undermined the v2 design's central premise. **Fix applied:** `presentRequiredLabels` now resolves each required-field label to a canonical `{fieldKey}` by matching case-insensitively against every registered field's `label` + `synonyms` (new helper `canonicalFieldForRequiredLabel`), then checks `doc.extracted[].target.field` and `facet.mappedFieldKey` against that canonical key — falling back to the original raw-text match only when a required label has no registered field at all (e.g. "Permit No.", "Term", which the tier-0 registry doesn't cover yet). The new logic is exported once as `missingRequiredFields(doc, schema)` and used by both `entityGraph.ts` (pipeline gating) and `ReviewScreen.tsx` (the UI's "Blocked at Classified" banner), which previously had its own separate, equally-buggy copy of this check — they can no longer disagree. Re-running the verifier's exact repro (doc-01) against the fixed code now yields `stage: 'verified'`. `required-field recall` as scored by `eval-ingest.ts` was not changed or re-run against the real gate this pass (that would require another `--provider claude` spend); the fix closes the mechanism gap the verifier flagged, and a follow-up eval run against the real stage-advancement path is recommended before the number in the headline table is treated as fully validated end-to-end, though the two measures should now track much more closely than before the fix, since both key off the same mapped-field concept.

**2. Classification/aspect accuracy, 91.7% vs. ≥95% gate — miss, on structural rather than tuning grounds.** Two documents miss: (a) doc-18, the byte-identical exact duplicate, is *designed* to short-circuit before any model call per the dedupe contract, so it never receives an aspect — yet ground truth still expects one, putting the spec's "no reprocessing of exact dupes" rule and the eval's classification check in tension; (b) doc-25 (a permit checklist) matches the schema's own pre-existing tier-0 `permit` type well enough that the model — correctly, per the tuned prompt's "prefer a listed type when it substantially fits" instruction — classifies it there rather than inventing a novel type, where ground truth expected a genuinely new type id. The other 3 of 4 novel-schema documents landed on ground truth's exact string.

**3. Link precision, 91.3% vs. ≥97% gate — miss, on a genuinely ambiguous case.** The only two misses (doc-19/doc-20) are an invoice for a property with two same-type furnaces on record and no serial, model, or any other distinguishing text on the document. There is no principled signal available to pick one over the other; the tuning agent deliberately did not add a guessed tie-breaker, preferring an honest miss.

**4. One dedupe false positive (doc-25).** A direct side effect of the address-typo tolerance added to fix link precision: it correctly links the permit checklist's typo'd address to the real property, but that same match surfaces a genuine one-digit address disagreement between documents on that property, which the conflict detector correctly flags but ground truth didn't anticipate as a conflict.

**5. `bootstrapHvac()` still seeds unconditionally/synchronously** rather than calling the new `bootstrapFromStoreOrSeed(hvacSchema, ...)` hydration path — flagged by the Foundation build agent as outside their file ownership; not yet fixed.

**6. Facet-level Ask citations ("from an unconfirmed field") were not independently re-verified end to end** in this pass — confirmed to exist in code, not walked through the UI.

**7. Pre-existing, not new:** the vite build emits one non-fatal chunk-size warning (`WarrantyExportScreen` bundle, 606 KB) — bundling debt from before M2, unrelated to ingestion work.

## Verifier's bottom line

Six of nine independent checks passed on hard evidence exactly as the build/tuning agents claimed: `tsc -b`, string-lint, `vite build`, both Node test suites (23/23 Ask, 15/15 Ingest), and the `api/extract.js`/`api/search.js` cleanup. The real pipeline walk (receive→read→map→propose→resolve→dedupe→conflicts→index, actual store, actual entity graph, only the two model HTTP calls stubbed) also passed — real hash-dedupe, real entity linking, a real pending proposal from a novel document, and a real zero-model-call re-map after confirming a proposal directly. But that same walk surfaced gap #1 above, which the self-reported 90.7% required-field-recall number does not reflect, because it's scored by the eval's own looser matcher rather than the code path that actually gates the "Extracted" stage badge shown to a user.

**Verdict, updated post-fix: M2 is ready to show Sterling**, with two known, honestly-reported near-misses. The mechanics genuinely work — universal read, schema-aware mapping, proposals, re-map, and Schema Health are all real, not mocked, and the v2 open-schema promise is demonstrably proven by the 4/4 proposal-firing recall and the zero-model-call re-map. Gap #1 — the one defect serious enough to block shipping, because it directly contradicted the milestone's own headline goal — has been patched (`presentRequiredLabels` now keys off `mappedFieldKey`/canonical field resolution, not raw label text) and confirmed fixed by re-running the verifier's own exact failing case. Recommended before the next milestone starts: re-run `eval:ingest:claude` once to re-score required-field recall against the now-fixed real gate (not just the eval's own fuzzy matcher) so that number is fully trustworthy going forward — this is a validation step, not a known defect. The classification and link-precision misses (gaps #2–3) remain honest near-misses on genuinely hard/ambiguous cases (a duplicate-by-design document expected to still classify, and an invoice with two functionally identical candidate links and no distinguishing text) and were not chased with guessed tie-breakers, per the project's standing rule against hardcoding a pass.

## Commands

```
npm run build              # string-lint → tsc -b → vite build
npm run test:api           # 23/23, Ask guard/validator/retrieval
npm run test:ingest-api    # 15/15, Ingest guard/read/map
npm run eval:ingest        # mock scoring sanity check, no spend
npm run eval:ingest:claude # real pipeline against real test-docs/, --confirm required
npm run eval:claude        # M1 regression check, 50/50
```

## Next: M3 — Persistence & accounts

Per `claude/REQUIREMENTS_TRACEABILITY.md`'s delivery plan: Postgres + row-level security, object storage, real auth, tenant onboarding (account → first batch → 50-question set → accuracy report → go-live), backups, health/error monitoring, warranty alerts (DASH-07/PLT-01/PLT-02/PLT-03). M2's gap #1 (stage-advancement matching) should be patched and re-verified before or alongside the start of M3, since M3's onboarding flow will put real, non-seeded customer documents through this exact path.
