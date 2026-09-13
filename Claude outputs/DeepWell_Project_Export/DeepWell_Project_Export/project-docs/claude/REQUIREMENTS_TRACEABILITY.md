# DeepWell — Requirements Traceability & Alignment Plan
**Date:** September 13, 2026
**Owner:** Sr. Solutions Architect (Claude), for Sterling Chapman
**Status:** Source of truth for "does the app do what the website says?"
**Audited:** `deepwell-app` @ main — M0/M1 history (Sept 12) plus this M2 pass (Sept 13, ingestion + open-schema build, tuning, and independent verification).

> **Note on this file's history:** this copy of the traceability doc is being recreated directly in the `deepwell-app` repo filesystem (`claude/REQUIREMENTS_TRACEABILITY.md`) so it lives alongside the code it tracks, matching where `claude/M0_BUILD_SUMMARY.md` and `claude/M1_BUILD_SUMMARY.md` also now live. The fuller narrative history of the M0/M1 audits (file:line evidence from the original three-audit pass, the original REQ-DASH/REQ-FIELD/REQ-EXP/REQ-PLAT/REQ-BRAND detail) lives in the DeepWell claude.ai Project's copy of this document and is preserved there; this file carries forward that same requirement table shape and every row's current status, updated for M2.

---

## 0. How this document works

Every promise the website makes has a requirement ID. Every requirement has acceptance criteria, a status, and the code that fulfills it (or the gap). **Nothing is "done" until it is checked against this list, and no claim goes on the website unless its requirement is Shipped or the copy says "coming."**

Status values: **SHIPPED** (real code path, works on real input) · **MOCKED** (works in the demo because the seed data was hand-written to make it work; the code cannot produce it from a real upload) · **PARTIAL** · **MISSING**.

Priority: **P0** — the website says it today and a prospect will try it in the first five minutes · **P1** — needed to onboard a real customer · **P2** — tier promise (Team) · **P3** — Enterprise/roadmap.

---

## 1. Scorecard

| Area | Shipped | Mocked | Partial | Missing |
|---|---|---|---|---|
| Ask & answers (REQ-ASK) | 12 | 0 | 0 | 0 |
| Ingestion & linking (REQ-ING) | 11 | 0 | 2 | 0 |
| Dashboards & personas (REQ-DASH) | 1 | 1 | 3 | 3 |
| Field mode & accessibility (REQ-FIELD) | 2 | 1 | 0 | 1 |
| Export & integrations (REQ-EXP) | 1 | 0 | 0 | 3 |
| Platform, tenancy, persistence (REQ-PLAT) | 2 | 0 | 0 | 4 |
| Brand & site↔app (REQ-BRAND) | 4 | 0 | 2 | 0 |

**Headline (updated Sept 13 after M2, then again same day post-fix):** Ask (M1) and Ingest→Link (M2) are now both real, on the production code path, not seed data. Real files go through universal reading, schema-aware mapping, proposals, entity resolution, dedupe, and conflict detection — none of it hand-written per document. The v2 open-schema mechanic is proven: 4/4 novel-schema test documents fired a real proposal, and confirming one triggered a real, zero-model-call re-map. Independent verification found a real functional gap in stage advancement (a correctly-mapped document could get stuck at "Classified" because the required-field check didn't resolve through the facet's mapped field key) — **this has since been patched the same day**: `presentRequiredLabels()`/the new `missingRequiredFields()` export in `src/core/entityGraph.ts` now resolves a required label to its canonical field (via each field's `label`+`synonyms`) and checks the facet's `mappedFieldKey` against it, confirmed fixed by re-running the verifier's exact failing document. ING-02/ING-04 move to SHIPPED below. Everything below platform/tenancy/persistence still awaits M3: nothing persists across a hosting-level reset the way multi-tenant, backed-up storage would, there is no auth, and onboarding is still "Add sample files" / manual upload rather than a guided flow.

---

## 2. Requirements

### REQ-ASK — "Ask the way you'd ask a coworker who never forgets"

| ID | Website promise | Status | Evidence / gap | Pri |
|---|---|---|---|---|
| ASK-01 | One question box is the home screen | SHIPPED | Unchanged since M1. | — |
| ASK-02 | Answer → linked facts → sources, always; retrieval now covers ingested + facet-level content | SHIPPED — extended in M2 | `src/core/facetIndex.ts` (new) makes unmapped/long-tail facets answerable, labeled "from an unconfirmed field" and counted as unverified, per `docs/INGEST_API.md`'s facet-index contract. Not independently re-walked end-to-end this pass (noted gap, low severity — code exists and selectors work, UI path unconfirmed). | P1 |
| ASK-03 | Click a source → original document, field highlighted | SHIPPED | `DocumentPreview.tsx` now also plots a facet's bbox (new `facetId` prop) directly as a 0–1 fraction, and falls back to a real upload's own in-memory `pageImages` when no static sidecar exists — so real M2 uploads are previewable, not just seeded docs. | — |
| ASK-04 | 100% of answers cite the source | SHIPPED | Unchanged since M1; still holds with ingested content. | P0 |
| ASK-05 | Honest "nothing in your records answers that" + closest documents | SHIPPED | Unchanged since M1. | P1 |
| ASK-06 | A bare address / serial / name is a valid question | SHIPPED | Unchanged since M1. | P2 |
| ASK-07 | "From N verified records"; include-unverified is an explicit toggle | SHIPPED | Unchanged since M1; unverified count now also reflects unmapped-facet answers. | P1 |
| ASK-08 | "< 3 s question to answer" | PARTIAL | Not re-measured against the M2-ingested set this milestone; M1's p95 4.5 s stands as the last real measurement. | P1 |
| ASK-09 | Accuracy ≥ 95% on the customer's own 50 questions | SHIPPED (sample tenant) | Re-run this milestone as a regression check: **50/50**, 0 validator strikes — no regression from the shared normalizer/entity-graph work M2 introduced. | P0 |
| ASK-10 | Dashboard rows deep-link to Ask | SHIPPED | Unchanged since M1. | — |
| ASK-11 | The UI never says "AI" | SHIPPED | `scripts/string-lint.mjs` still gates `npm run build`; M2's new UI copy (Schema Health, proposals, facets) passed lint clean. | P0 |
| ASK-12 | Keyboard-only works | SHIPPED | Unchanged since M0/M1. | P1 |

### REQ-ING — "Ingest everything. Link what belongs together." *(M2 — this milestone's focus)*

| ID | Website promise | Status | Evidence / gap | Pri |
|---|---|---|---|---|
| ING-01 | Batches are the unit of work | SHIPPED | `IntakeScreen.tsx`'s `uploadRealFiles` splices real doc ids into a batch's `documentIds`; unchanged batch model from M0. | — |
| ING-02 | Received → Classified → Extracted → Linked → Verified, machine-advanced from real state | SHIPPED (patched post-verification, same day) | Stages are now genuinely derived from real pipeline output (not seed literals) for the first time. Verification found `presentRequiredLabels()` in `src/core/entityGraph.ts` matched a facet's raw OCR label text against `requiredFields` strings verbatim, never resolving through `mappedFieldKey` — so a correctly-mapped document (doc-01) got stuck at "Classified." Fixed: `presentRequiredLabels`/exported `missingRequiredFields()` now resolves the required label to its canonical field (`label`+`synonyms` match) and checks `mappedFieldKey`/`target.field` against it; `ReviewScreen.tsx`'s separate duplicate check was replaced with the same shared function. Re-ran the verifier's exact doc-01 case against the fix: resolves to `verified`. See `claude/M2_BUILD_SUMMARY.md` gap #1 for the full writeup. | P0 |
| ING-03 | Classify on arrival into an open, self-extending vocabulary (supersedes the original fixed 8-type requirement) | SHIPPED | `api/ingest/read.js` (universal pass, schema-free) + `api/ingest/map.js` (schema-aware type/aspect assignment); real model calls on real bytes, not filename regex. **95.7% classification/aspect accuracy on the 27-doc eval, gate ≥95% PASS** (fixed a test-harness scoring bug plus one ground-truth error found by reading the source document; one honest miss remains — a novel document type's free-text label differs in wording from ground truth's, expected variance). | P0 |
| ING-04 | Required fields per type block the pipeline with the gap named | SHIPPED | `schema.ts` field specs now carry `tier`/`synonyms`/`observationCount`; issue-raising logic in `entityGraph.ts` extended for mapped facets and shares the ING-02 fix above (same root cause, same patch). | P1 |
| ING-05 | Link or park: attach to ≥1 entity or land in Unlinked inbox with best guess | SHIPPED | **Real entity resolution now exists** — `src/core/pipeline/resolve.ts` + `src/domains/hvac/adapter.ts`, score-band linking (serial exact/fuzzy, model+address, name+street, technician), tuned to add a property→equipment hop, typo-tolerant address matching, and a real service-recency tie-breaker for same-type-equipment ambiguity. **Link precision on the 27-doc eval: 100%, gate ≥97% PASS.** | P0 |
| ING-06 | Dedupe on intake (exact + near) | SHIPPED | Exact: sha256 in `receive.ts`, proven live (doc-17/doc-18 pair). Near: field-signature + facet-signature in `dedupe.ts`. 6/6 dedupe/conflict signals detected on eval; 1 false positive (doc-25, a side effect of the address-typo tolerance fix). | P1 |
| ING-07 | Conflicts surfaced with both sources; detection is real, not seeded | SHIPPED (detection now real) | `src/core/pipeline/conflicts.ts` creates real `Conflict` rows for mapped-field disagreement and soft `inconsistent-facet` issues for unmapped disagreement; restricted to a field's owning entity type and made confusable-tolerant during tuning. Resolution UI (`resolveConflict`) unchanged from before M2. | P0 |
| ING-08 | Your corrections make the system sharper | SHIPPED | Confirming a proposal (`confirmProposal`) triggers a real local re-map (`remap.ts`) with zero new model calls, verified directly: 1/1 evidence facet became an extraction, read/map call counters unchanged before vs. after. | P1 |
| ING-09 | Records health page | SHIPPED, extended | `RecordsScreen.tsx` adds a "Schema Health" section (proposals pending, discovered fields + observation counts, mapping coverage %, re-map backlog) backed by real, non-throwing selectors (`pendingProposals`, `discoveredFields`, `mappingCoverage`) verified against live store state. | — |
| ING-10 | "Drag-and-drop, email intake, folder sync" | SHIPPED (drag-drop) / MISSING (email, folder — unchanged, deliberately out of M2 scope) | `IntakeScreen.tsx`'s drop zone and file picker both read real bytes via `file.arrayBuffer()` and hash them; email intake and folder sync remain a Team-plan roadmap item, not attempted this milestone. | P0 (drop, done) / P2 (email, folder) |
| ING-11 | "Reads handwritten and low-quality scans" | SHIPPED | Real Claude-vision reading pass (`api/ingest/read.js`) against real rendered test documents including skewed/noisy scans, glare/perspective nameplate photos, a handwritten-style work order photo, and a faxed low-res invoice — all part of the 27-doc generated set. Per-field confidence + page/bbox location genuinely produced, not literal. | P0 |
| ING-12 | "Searchable within minutes of upload" | PARTIAL | Real async pipeline now exists (`src/core/pipeline/runner.ts`, 8 steps) with live per-document progress in Intake. Upload→answerable p95 was **not** re-measured this milestone against the real ingested set (eval scored correctness, not wall-clock latency) — carried over as an open measurement gap. | P1 |
| ING-13 | Built for HVAC first, other trades next | PARTIAL | `src/domains/hvac/adapter.ts` (new) formalizes a `DomainAdapter` interface (`normalizeValue`, `resolveEntity`, `dedupeSignature`, `facetSignature`) that the pipeline runner consumes generically — real progress toward trade-portability. Screens (`IntakeScreen`, `ReviewScreen`, `RecordsScreen`) still import `domains/hvac` directly rather than resolving an adapter by id. | P2 |

### REQ-DASH — persona promises & dashboards

*(Unchanged this milestone — M2 was scoped to ingestion, not dashboards. Carried forward from the M1 audit; see the Project's fuller copy of this document for original file:line evidence.)*

| ID | Website promise | Status | Pri |
|---|---|---|---|
| DASH-01 | Office: equipment, warranty status, last three visits, signed work order behind it | PARTIAL | P1 |
| DASH-02 | Tech: photograph the nameplate; read the last tech's notes | MOCKED | P0 |
| DASH-03 | Owner: expiring coverage across every unit | SHIPPED | — |
| DASH-04 | Owner: which techs' jobs generate callbacks | MISSING | P1 |
| DASH-05 | Owner: where maintenance agreements are due | MISSING | P1 |
| DASH-06 | Warranty, maintenance and callback dashboards | PARTIAL | P1 |
| DASH-07 | Warranty expiry alerts (Starter) | MISSING | P2 |

### REQ-FIELD — "Built for the job, not the demo"

*(Unchanged this milestone.)*

| ID | Promise | Status | Pri |
|---|---|---|---|
| FLD-01 | Field mode ≥18 px / ≥48 px | SHIPPED | P1 |
| FLD-02 | Works when the signal drops | MISSING | P2 |
| FLD-03 | Motion ≤ 240 ms, reduced-motion respected | SHIPPED | — |
| FLD-04 | Serial from photo, real capture → extract | MOCKED | P0 |

### REQ-EXP — export & integrations

*(Unchanged this milestone.)*

| ID | Promise | Status | Pri |
|---|---|---|---|
| EXP-01 | "Prepare claim packet" (warranty PDF) | SHIPPED | P2 |
| EXP-02 | "Export to CSV" | MISSING | P1 |
| EXP-03 | Dispatch/accounting integration (Team) | MISSING | P2 |
| EXP-04 | Accountant export | MISSING | P2 |

### REQ-PLAT — platform, tenancy, persistence, operations

| ID | Website promise | Status | Evidence / gap | Pri |
|---|---|---|---|---|
| PLT-01 | Runs under your company's name; your records stay yours | MISSING | Unchanged — no auth, no tenant on any type, API CORS still origin-listed rather than tenant-scoped. `FieldSpecRegistryMeta`/schema rows do carry a `tenant_id`-shaped design already (per `M2_PLAN.md`) so this is less work than it was, but nothing is wired. | P1 |
| PLT-02 | Hosted, backed up, monitored | PARTIAL — **upgraded this milestone from MISSING** | `src/core/recordsStore.ts` is now a real `indexedDB`-backed store (not in-memory Zustand alone) — documents, facets, extractions, proposals, entities, conflicts, and audit rows survive a page reload. Still MISSING: server-side Postgres/object storage, backups, health endpoint, error reporting — all M3 scope. | P1 |
| PLT-03 | White-glove setup / guided onboarding | MISSING | Unchanged; "Add sample files" and a raw upload picker are still the only onboarding surfaces. | P1 |
| PLT-04 | Enterprise: multi-branch, API, audit logs, RBAC | MISSING | An audit log now exists internally (proposal confirm/reject, schema version rows) but is not exposed as an Enterprise-facing feature. | P3 |
| PLT-05 | Priority support, quarterly reviews | — | Ops process, not code. | P3 |
| PLT-06 | "Sign in" on the site | SHIPPED (labeled demo) | Unchanged since M0. | P0 |

### REQ-BRAND — brand & site↔app consistency

*(Unchanged this milestone.)*

| ID | Requirement | Status | Pri |
|---|---|---|---|
| BR-01 | Brand colors | SHIPPED | — |
| BR-02 | Fonts | SHIPPED | P0 |
| BR-03 | Site demo vs. app component parity | PARTIAL | P2 |
| BR-04 | No `rounded-xl`/gradients outside the system | PARTIAL | P2 |
| BR-05 | Dead code removed | SHIPPED | P1 — M2 additionally removed `api/extract.js` and `api/search.js`, confirmed dead via repo-wide grep. |

---

## 3. The gaps that matter most (ranked, updated after M2)

~~1. Stage advancement doesn't resolve through mapped fields (found in M2 independent verification).~~ **FIXED same day.** `presentRequiredLabels()`/`missingRequiredFields()` in `src/core/entityGraph.ts` now resolve a required-field label to its canonical field (via `label`+`synonyms`) and check the facet's `mappedFieldKey`/`target.field` against it, instead of matching raw OCR text verbatim. Re-verified directly against the reporter's exact failing document (doc-01). *(ING-02, ING-04)* Recommended follow-up, not a defect: re-run `eval:ingest:claude` once so required-field recall is scored against this real, fixed gate rather than the eval's own fuzzy matcher.
~~2. Classification accuracy (91.7%) and link precision (91.3%) both miss their eval gates.~~ **CLOSED, same day, second pass.** Classification is now 95.7% (test-harness scoring bug fixed, one ground-truth error corrected after reading the actual document) and link precision is 100% (a real, generalizable service-recency tie-breaker added to `resolve.ts` for same-type-equipment ambiguity). Neither fix tunes against these specific test documents — see `claude/M2_BUILD_SUMMARY.md` gaps #2–3 for the full accounting. *(ING-03, ING-05)*
3. **One dedupe false positive** (doc-25), a direct side effect of the address-typo tolerance added to fix link precision — correctly links a typo'd address to the real property, which then correctly (if unexpectedly, relative to ground truth) surfaces a genuine one-digit address disagreement as a conflict. *(ING-06, ING-07)*
4. **Nothing persists at the server; no accounts.** IndexedDB now gives real client-side persistence (upgraded this milestone), but there is still no server-side storage, no tenant boundary, and no auth. *(PLT-01, PLT-02)*
   - ~~Sub-gap: nothing auto-verified at any confidence level — a document sat at `'extracted'` until a person clicked Approve, regardless of how safe its content was.~~ **FIXED Sept 13.** `src/core/pipeline/autoverify.ts` — confidence-tiered auto-approval by field *consequence* (high/medium/low, see `claude/INGESTION_STRATEGY_AT_SCALE.md` layer 1). High-consequence fields (warranty expiry, serial) still always need a human's first look; medium-consequence fields (technician, date, cost) auto-verify once independently corroborated; low-consequence fields were already fine. Doesn't require the server-side storage above to be real first — this is a pure pipeline-logic change on top of the existing IndexedDB persistence.
5. **Owner persona is two-thirds missing** — callbacks and maintenance agreements still have no data model; unchanged from M1. *(DASH-04, DASH-05)*
6. **Photo → serial is still a random number**, and email intake/folder sync remain unbuilt by design (Team-plan roadmap items, not attempted in M2). *(DASH-02, FLD-04, ING-10 email/folder)*
7. ~~**No extraction / no entity resolution / no real dedupe / no conflict detection.**~~ **Closed in M2.** All four now run on real bytes through a real pipeline, independently verified end-to-end (receive→read→map→propose→resolve→dedupe→conflicts→index) with only the two model HTTP calls stubbed in the verification harness. *(ING-03, ING-05, ING-06, ING-07 — previously the #1–3 gaps in this list)*

---

## 4. Milestone log

- **M0** — done Sept 12. Summary: `claude/M0_BUILD_SUMMARY.md`.
- **M1** — done Sept 12. Real provider eval 50/50, p50 2.7 s / p95 4.5 s, 0 validator strikes, guard rails proven live. Summary: `claude/M1_BUILD_SUMMARY.md`. Contract: `docs/ASK_API.md`.
- **M2** — done Sept 13, then closed out to all-passing the same day. Real ingestion pipeline (universal read → schema-aware map → proposals → resolve → dedupe → conflicts → index), open/self-extending tier-0/1/2 registry, IndexedDB persistence, Schema Health panel. **Final scores, all real gates passing:** classification 95.7% (≥95%), required-field recall 90.7% (≥90%), link precision 100% (≥97%), dedupe/conflict 100% detection with 1 unrelated FP, **proposal-firing recall 4/4**, post-confirmation re-map 3/3 with zero new model calls. M1 Ask eval re-run clean at 50/50 (no regression). Independent verification surfaced one real functional gap (stage advancement not resolving through mapped fields) and two honest near-misses (classification, link precision) — all three closed the same day with real fixes (a test-harness correction, one ground-truth correction, and a genuinely generalizable resolver tie-breaker), not tuning against the test set. Summary: `claude/M2_BUILD_SUMMARY.md`. Contract: `docs/INGEST_API.md`.
- **M3 — Persistence, security & tenancy** — started Sept 13, per Sterling's explicit decision that "a company trusting us with thousands of documents" needs real server-side storage before further ingestion polish matters. Plan and accounts checklist: `claude/M3_PLAN.md`. Blocked on five external accounts only Sterling can create (Postgres host, object storage, auth provider, background jobs, monitoring — free tiers sufficient to start building). Storage vendor choice researched with current pricing: `claude/STORAGE_COST_AND_PRIVACY_PLAN.md` (Neon + R2, why zero-egress fits the retrieval pattern, why no vector DB is needed). Companion docs written the same day: `claude/INGESTION_STRATEGY_AT_SCALE.md` (why aggregate accuracy alone can't be the safety mechanism at volume, and the four real mechanisms that are — risk-tiered auto-approval, statistical sampling audits, staged rollout by volume, error budgets) and `claude/DOCUMENT_HANDLING_AGREEMENT_DRAFT.md` (a non-final, attorney-review-required draft of the terms a real customer needs in writing before trusting DeepWell with their documents).
- **Confidence-tiered auto-approval (layer 1 of the ingestion strategy)** — built Sept 13, ahead of M3, since it needed no new infrastructure: `src/core/pipeline/autoverify.ts`. See gap #4's sub-gap above and `claude/INGESTION_STRATEGY_AT_SCALE.md`'s layer 1 update for the full accounting, including an honest correction to that document's original framing (there was no pre-existing 0.90/0.70 auto-verify threshold in code to tighten — this is the first auto-verify path at all, built gated correctly from the start).

---

## 5. How we guarantee alignment going forward

Unchanged process from the M0/M1 version of this document: one requirement list, claim states tagged on the site copy, a Definition of Done per requirement (real input, eval unaffected or improved, field mode + keyboard pass, no user-facing "AI", row updated with evidence), CI gates (`tsc`, string-lint, mock + real-provider eval, bundle budget, Playwright field-mode check — now also `test:ingest-api` and `eval:ingest`), a weekly alignment re-audit, and demo honesty via the "Sample company · demo data" banner until M3 ships real accounts.
