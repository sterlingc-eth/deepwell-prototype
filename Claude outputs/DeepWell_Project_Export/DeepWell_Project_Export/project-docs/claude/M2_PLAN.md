# M2 Plan — Real ingestion, open schema (v2)

**Goal:** a real file goes in, and within a minute Ask can answer from it with the source page highlighted — including on labels and headings DeepWell has never seen before. Nothing on this path is seeded or hand-written. Scope: **lean persistence** (IndexedDB via a `RecordsStore` interface; Postgres/object storage swap in at M3), **generated realistic test documents** (no real customer files available yet), and the **open/self-extending schema** from `claude/STORAGE_AND_RETRIEVAL_MODEL.md` v2 (superseding the closed 8-type/fixed-field-registry version this plan originally described).

This supersedes the September 12 "lean first" plan's ingestion shape only where it assumed a closed registry. Everything about persistence being IndexedDB, test docs being generated, and guard rails matching `/api/ask` still holds.

## What changed vs. the original plan

The original plan had one model call per document: classify into one of 8 fixed types, then extract into a fixed field registry, dropping anything that didn't fit. Sterling's explicit pushback: that isn't sophisticated enough to identify aspects of documents it hasn't seen before, or to keep improving. The v2 design fixes this with two model passes and a governed, versioned registry instead of a fixed one:

1. **Universal reading pass** (schema-free, runs on every page of every upload): find segments (header / party-block / line-item table / terms / signature / handwritten note / stamp / photo region — each boxed) and facets (every label→value pair, cell, checkbox, date, amount, identifier, name, address, freeform note it can see — each boxed with a confidence and a value-type guess). Nothing is filtered here. A document can carry more than one aspect (a work order that also has a payment section is both).
2. **Mapping pass** (schema-aware, runs against the facets from step 1): match each facet to the layered registry by field key, by learned synonym, or by value-type+position; matched facets become `extractions` (entity-linked, provenance-carrying, answerable by Ask like M1's fields). Unmapped facets become first-class `facets` rows — still boxed, still citable, still searchable — and feed **proposals**.
3. **Proposals**: unmapped facets cluster into proposals (`kind` ∈ document_type | aspect | field | entity_type | relation | synonym | enum_value) with evidence (examples, counts, value-type signature). Promotion rules from the spec: synonyms auto-promote at 2 consistent occurrences; fields auto-promote to "discovered" at ≥3 docs/≥2 batches with a consistent value type (unverified for answering until confirmed or ≥10 observations); document types/aspects propose after ≥3 clustering docs and need one human click in Review; entity types always need human confirmation; enum values auto-add with merge suggestions. Every promotion/rename/merge/rejection is audit-logged and reversible.
4. **Layered/versioned registry**: tier 0 (core HVAC schema shipped by DeepWell) → tier 1 (discovered) → tier 2 (confirmed) → tier 3 (shared across tenants, a deliberate release — not automatic; out of scope at prototype single-tenant scale but the schema carries `tenant_id` from day one). Every change is a versioned `schema_versions` row. Promoting a field triggers a targeted **re-map** of already-stored facets against the new definition — not re-OCR, not re-reading the original document.
5. **Schema Health panel** (new screen section, on Records): proposals awaiting confirmation, discovered fields with observation counts, mapping coverage %, re-map backlog. This is the visible proof the model is "isolating and building" rather than static.

Cost tradeoff, stated plainly again: two model passes per page instead of one roughly doubles per-page extraction spend. At this test-doc volume that's cents; Sterling has accepted this.

## What "done" means (spec ids + v2 additions)

| Step | Requirement | Acceptance on real input |
|---|---|---|
| Upload | ING-01, ING-10 | Drag-drop / picker / camera; PDF, JPG, PNG, HEIC→JPEG, CSV/XLSX; sha256 client-side; per-file progress; batch = unit of work. |
| Receive + render | §4.3 step 1 | PDF → page PNGs, images normalized (EXIF), spreadsheets → one page per sheet. Page images + bbox sidecars use the same `/docs/<id>.json` contract M1 built (Ask/Review/DocumentPreview don't change shape). |
| Dedupe exact | ING-10, §4.6 | Same bytes twice → `duplicate_of`, no second processing. |
| **Universal read** | v2 §1 (new) | Every page → segments + facets, unfiltered, boxed, confidence-scored, stored verbatim regardless of whether anything maps. This replaces "classify" as the first model call; document type becomes a byproduct (an aspect) rather than a gate. |
| **Map** | v2 §2 (new) | Facets → registry match (tier 0/1/2) or learned synonym or learned mapping → `extractions`; unmapped → `facets` rows feeding proposals. Normalization per §4.4 (dates, serial confusables, money, names, addresses) applies to matched values. ≥0.90 auto · 0.70–0.89 needs review · <0.70 dropped with a gap issue if the field is required by an active proposal or tier-0 schema. |
| **Proposals** | v2 §3 (new) | Clustering + promotion rules as above; Review gets a one-click confirm/reject queue; rejections are remembered (never re-proposed identically). |
| Resolve (link or park) | ING-05, §4.5 | Serial exact/fuzzy, model+address, address normalized, customer name+street, technician name; score ≥0.80 link, 0.50–0.79 inbox with best guess + reason, no candidate but enough key fields → provisional new entity. Facets link to the same entities as extractions on the same page, even before their field is mapped. |
| Dedupe near | ING-06, §4.6 | Field-signature match (matched fields) plus facet-signature fallback (unmapped but identical-looking documents) → "Possible duplicate" side by side. |
| Conflicts | ING-07, §4.7 | Two docs, same entity, same mapped field, different normalized value → conflict with both page crops. Facet-level disagreement (two unmapped facets with the same label, different values) surfaces as a softer "inconsistent" note, not a hard conflict, until the field is confirmed. |
| Derived stages | ING-02 | Received → Read → Mapped → Linked → Verified computed from document state. Human verifies (facets/proposals/conflicts); the machine advances. |
| Progress | ING-12 | Per-batch progress and per-document status live in Intake; upload → answerable p95 ≤ 2 min single doc measured and shown. |
| Persistence (interim) | toward PLT-02 | Documents, page images, facets, extractions, proposals, schema_versions, entities, links, conflicts, audit in IndexedDB behind a `RecordsStore` interface (`get/put/query/export`). Survives reload; "Reset sample data" stays available. Export-all as zip (EXP-04 shape: jsonl + originals). |
| Retrieval | ASK-02 upgrade | Ask's export now comes from the store; the **facet index** (v2 §"three indexes") makes unmapped/long-tail facets answerable — labeled "from an unconfirmed field" and counted as unverified. Retrieval index rebuilt incrementally per ingested document; eval re-run after ingesting the generated set. |
| **Schema Health** | v2 §"Schema Health panel" (new) | Records screen shows proposals pending, discovered-field counts + observations, mapping coverage %, re-map backlog. Confirming a proposal visibly changes coverage % and triggers a re-map without re-reading source documents. |
| Guard rails | owner requirement | `/api/ingest/*` behind the same guard as `/api/ask`: `INGEST_ENABLED`, origin allow-list, per-IP limits, per-day page cap (`INGEST_DAILY_PAGES`, default 300), max 20 MB/file, 20 files/batch, cost logged per document (now two model calls/page — logged separately as `read` and `map`). |

## Architecture (lean, v2)

```
Browser                                   Vercel functions
IntakeScreen ─ files ─▶ sha256, page render ─▶ POST /api/ingest/read     (page image → segments + facets, unfiltered)
                                              ─▶ POST /api/ingest/map      (facets + registry version → extractions | unmapped facets)
RecordsStore (IndexedDB) ◀── pipeline runner (client, per document, idempotent steps:
                              receive → read → map → propose → resolve → dedupe → conflicts → index)
Registry (IndexedDB, versioned) ◀── proposals confirmed/rejected in Review ──▶ triggers targeted re-map of stored facets
Ask ── buildAskRequest(store snapshot incl. facet index) ──▶ /api/ask (unchanged contract; facts may now cite unmapped facets)
DocumentPreview ◀── page images + bbox sidecars from the store (same shape as M1, now covers facets too)
Review ── writes (link/dedupe/conflict/proposal decisions) ──▶ RecordsStore (audit log) ──▶ stages recompute ──▶ Ask changes
```

The pipeline runner and every step are pure functions in `src/core/pipeline/*` against a `DomainAdapter` (vocabulary seed, tier-0 field registry, normalizers, resolution rules — `src/domains/hvac`), so M3 can move the runner server-side without rewriting the steps. Only `/api/ingest/read` and `/api/ingest/map` call the model.

## Generated test set (`test-docs/`, committed)

~24–28 documents from a hidden ground-truth JSON, rendered with real imperfections (skewed/noisy scans, phone photos of nameplates with glare and perspective, a handwritten-font work order, a faxed low-res invoice, a two-page warranty registration, a spreadsheet of service records). Includes: one exact duplicate, one photo-of-a-PDF near duplicate, two documents that conflict on a serial and a total, one blank page, one password-protected PDF (must fail gracefully), one document with no key fields (must park with the right reason) — **plus, new for v2**: at least 4 documents carrying labels/fields that do not exist in the tier-0 HVAC registry at all (a rebate form, a permit inspection checklist, a manufacturer recall notice, a financing agreement), so the eval can prove the proposals mechanism actually fires — clusters, proposes, and (in Review) promotes at least one new field and one new document type from nothing.

The ground truth drives an ingestion eval: classification/aspect accuracy, required-field recall on tier-0 fields, link precision, dedupe/conflict detection (the spec's QA-02 gates: ≥95/≥90/≥97), **plus** proposal-firing recall (did the ≥3 novel-labeled docs produce a proposal?) and post-promotion re-map correctness (after confirming a proposed field, do previously-ingested facets get correctly reclassified as extractions?).

## Build order (agents, disjoint ownership)

1. Core pipeline + `DomainAdapter` contract + registry (tiered, versioned) + `RecordsStore` (IndexedDB) + derived stages.
2. `/api/ingest/read` (universal reading pass) and `/api/ingest/map` (registry/synonym/learned matching) with guard, bbox validation, normalization, unit tests with fakes.
3. Proposals engine: clustering, promotion rules, audit log, re-map trigger.
4. Intake/Review/Records screens on the store: real drop zone with progress, review sections per §4.8 (facets, proposals-to-confirm, conflicts with page crops, "New equipment found", provisional entities answerable only with include-unverified), Schema Health panel.
5. Test-doc generator (incl. the 4+ novel-schema docs) + ingestion eval script (`npm run eval:ingest`) scoring the v2 metrics above.
6. Tune against the real API (reading/mapping/proposal rounds, cost-capped), then re-run the 50-question Ask eval with the ingested set added, including at least a few questions only answerable from unmapped facets or newly-promoted fields.
7. Independent verifier: fresh browser, ingest the test set end to end, confirm at least one proposal in Review and watch the re-map happen, ask questions (including facet-only questions), click sources, check field mode, measure upload→answerable.

Estimated model spend for build + tuning: under $15 (two passes/page roughly doubles M2's per-document eval cost vs. the original plan, still small at this volume). Deliverables: commit(s) on `deepwell-app`, `claude/M2_BUILD_SUMMARY.md`, traceability rows updated, files written to `C:\Users\chapman\Desktop\GitHub\deepwell-app`.

## Not in M2 (deliberately)

Email intake, folder sync, Textract (Claude vision covers the prototype; Textract slots in at M3 for bbox precision at volume), embeddings, accounts/tenancy, server-side persistence, geocoding, tier-3 cross-tenant schema promotion (single tenant at prototype scale — the `tenant_id` column exists but nothing promotes across it yet).
