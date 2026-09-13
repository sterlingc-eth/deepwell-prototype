# M2 ingestion — shared contract

Every M2 agent builds to this file. It exists so the core pipeline, the two
server endpoints, and the UI can be built in parallel without reading each
other's code. Do not redesign these shapes without updating this file first.

Implements `claude/STORAGE_AND_RETRIEVAL_MODEL.md` v2 (open schema:
universal reading pass → mapping pass → tiered/versioned registry →
proposals). See `claude/M2_PLAN.md` for the full requirement table.

## New core types (add to `src/core/types.ts`, do not replace existing ones)

```ts
export interface Bbox { page: number; x: number; y: number; w: number; h: number } // x/y/w/h are fractions 0–1 of the page image

export type ValueTypeGuess = 'text' | 'date' | 'money' | 'serial' | 'number' | 'address' | 'name' | 'checkbox' | 'identifier';

export interface Segment {
  id: string;
  documentId: DocumentId;
  page: number;
  kind: 'header' | 'party-block' | 'line-item-table' | 'terms' | 'signature' | 'handwritten-note' | 'stamp' | 'photo-region' | 'other';
  bbox: Bbox;
}

/** A label→value pair (or cell/checkbox/date/amount/identifier/name/address/note) found by the universal reading pass, before any mapping. First-class, citable, searchable regardless of whether it ever maps to a known field. */
export interface Facet {
  id: string;
  documentId: DocumentId;
  page: number;
  segmentId?: string;
  labelRaw: string;
  valueRaw: string;
  valueTypeGuess: ValueTypeGuess;
  bbox: Bbox;
  confidence: number; // 0–1, the reading pass's confidence this is a real label/value pair
  linkedEntityIds: EntityId[]; // entities on the same page/segment, populated at resolve time regardless of mapping status
  // Set once the mapping pass has run:
  mappedEntityType?: string;
  mappedFieldKey?: string;
  mappingConfidence?: number;
  mappingMethod?: 'registry' | 'synonym' | 'learned' | 'human';
  schemaVersionAtMapping?: number;
  proposalId?: string; // set when this facet is part of a pending proposal
}

export type ProposalKind = 'document_type' | 'aspect' | 'field' | 'entity_type' | 'relation' | 'synonym' | 'enum_value';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  label: string; // the raw label being proposed as a field/type/synonym/etc.
  targetEntityType?: string; // for kind 'field' | 'relation' | 'enum_value'
  targetFieldKey?: string; // for kind 'synonym' | 'enum_value' — the existing field this maps onto
  evidence: { facetIds: string[]; documentIds: DocumentId[]; count: number; valueTypeGuess?: ValueTypeGuess };
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export type RegistryTier = 0 | 1 | 2 | 3; // 0 core (shipped) · 1 discovered (auto-promoted) · 2 confirmed (human) · 3 shared (cross-tenant, unused at prototype scale)

/** Extends FieldSpec conceptually — add these as optional properties on the existing FieldSpec interface. */
export interface FieldSpecRegistryMeta {
  tier: RegistryTier;
  synonyms: string[];
  observationCount: number;
  addedInSchemaVersion: number;
}

export interface SchemaVersionRow {
  version: number;
  changeKind: 'field-added' | 'field-promoted' | 'synonym-added' | 'document-type-added' | 'aspect-added' | 'entity-type-added' | 'enum-value-added';
  description: string;
  createdAt: Date;
  createdBy?: string; // absent = auto-promoted
}
```

Extend `Doc` (in the same file) with:
```ts
facets: Facet[]; // every facet found on this document, mapped or not
aspects: string[]; // document type ids this doc matches; typeId remains the primary one for back-compat with existing UI
```

Do not rename or remove the existing five `PIPELINE_STAGES` (`received | classified | extracted | linked | verified`) — every screen and the Ask contract depend on those names. Their *meaning* changes: `classified` now means "the universal reading pass ran and produced segments/facets, aspects assigned"; `extracted` now means "the mapping pass ran, tier-0 required fields for the doc's type are present (via mapped extraction OR human-entered), remaining facets are unmapped but stored." Everything downstream (`linked`, `verified`) is unchanged from M1/M0.

## `RecordsStore` (new file `src/core/recordsStore.ts`)

```ts
export type CollectionName = 'entities' | 'docs' | 'batches' | 'conflicts' | 'facets' | 'proposals' | 'schemaVersions' | 'auditLog';

export interface RecordsStore {
  get<T>(collection: CollectionName, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: CollectionName, value: T): Promise<void>;
  putMany<T extends { id: string }>(collection: CollectionName, values: T[]): Promise<void>;
  delete(collection: CollectionName, id: string): Promise<void>;
  all<T>(collection: CollectionName): Promise<T[]>;
  query<T>(collection: CollectionName, predicate: (v: T) => boolean): Promise<T[]>;
  clear(collection?: CollectionName): Promise<void>; // no arg = wipe everything ("Reset sample data")
  exportAll(): Promise<Record<CollectionName, unknown[]>>; // for the export-all zip
}
```

Backed by plain `indexedDB` (no external dependency), one object store per collection, database name `deepwell-records`, version 1. Ship a factory `createIndexedDbStore(): RecordsStore` plus an in-memory fallback `createMemoryStore(): RecordsStore` (same interface) used automatically when `indexedDB` is unavailable (SSR, tests, some browser privacy modes) — feature-detect with `typeof indexedDB === 'undefined'`.

The existing `useGraph` Zustand store (`src/core/entityGraph.ts`) stays the in-memory reactive layer everything reads from (Ask, Review, Intake, Records all keep using `useGraph`); every mutating action in it also writes through to a module-level `RecordsStore` instance so state survives reload. On app boot: if the store has any docs, hydrate `useGraph` from it; otherwise seed from `src/domains/hvac/seed.ts` as today. Add `facets: Record<string, Facet>` and `proposals: Record<string, Proposal>` to `GraphSnapshot`/`GraphStore`, plus actions: `ingestRead(docId, facets, segments)`, `ingestMap(docId, mappingResult)`, `confirmProposal(proposalId, by)`, `rejectProposal(proposalId, by)` (each persists through the store and, for `confirmProposal`, triggers the re-map step described below).

## `DomainAdapter` (extends `src/domains/hvac`, new file `src/domains/hvac/adapter.ts`)

```ts
export interface DomainAdapter {
  schema: DomainSchema; // existing hvacSchema, extended with FieldSpecRegistryMeta on every FieldSpec (tier 0, synonyms: [], observationCount: 0, addedInSchemaVersion: 0 for all shipped fields)
  normalizeValue(kind: ValueTypeGuess, raw: string): string; // reuse the normalizers already in api/_lib/validate.js (dates, money, serial confusables, addresses, names) — extract them to a shared module both the API and this adapter can import (see "shared normalizers" below)
  resolveEntity(facetOrField: { labelRaw: string; valueRaw: string; mappedFieldKey?: string }, graph: GraphSnapshot): { entityId: EntityId; confidence: number; reason: string } | { provisional: true; entityType: string; fields: Record<string, string> } | null;
  dedupeSignature(doc: Doc): string; // field-signature for near-dup detection: type + normalized key fields, e.g. "warranty-registration|serial:SN-LEN-456789"
  facetSignature(doc: Doc): string; // fallback dedupe signature built from unmapped facets when the doc has no mapped type yet (raw label+value pairs, sorted, hashed)
}
```

**Shared normalizers**: move the date/money/serial/address/name normalization functions currently inside `api/_lib/validate.js` into a new `api/_lib/normalize.js` (pure functions, no imports from `validate.js`'s sentence logic), have `validate.js` import from it unchanged, and mirror the same logic in a client-safe copy at `src/core/normalize.ts` (duplicated intentionally — server code (`api/`) and client code (`src/`) don't share a bundler target in this repo, so keep the two in sync rather than trying to import across the boundary).

## Pipeline (new directory `src/core/pipeline/`)

Pure functions, one per step, each `(doc, context) => Partial<Doc> & { newFacets?: Facet[]; newProposals?: Proposal[] }` (a patch, never a mutation), orchestrated by `src/core/pipeline/runner.ts` which calls them in order and applies patches through the `RecordsStore`/`useGraph` actions:

1. `receive.ts` — sha256 (Web Crypto `crypto.subtle.digest`), exact-dup check against existing docs by hash, page rendering (PDF → page PNGs via `pdfjs-dist`, already not a dependency — add it; images pass through as 1 page; spreadsheets → one page per sheet rendered as a simple table image or skipped with a "no visual page" flag and read directly as text/CSV rows fed straight to the map step, skipping the vision call). Produces page image data URLs held in memory (not yet persisted as files — store them as base64 in the `docs` record's per-page data for the prototype; this is the same tradeoff M1's `public/docs/*.json` sidecars made, just generated at runtime instead of build time).
2. `read.ts` — calls `POST /api/ingest/read` once per page, collects segments + facets (unfiltered, per the contract below), stage → `classified` once every page has been read.
3. `map.ts` — calls `POST /api/ingest/map` with the doc's facets + a snapshot of the current registry (tier 0–2 field specs with synonyms), gets back which facets matched (→ `extractions`, written the same way M0/M1 already write `doc.extracted`) and which stayed unmapped (stay as `Facet` rows on the doc), plus a document-type/aspect guess. Stage → `extracted` once required tier-0 fields for the guessed type are present (reuse the existing `recomputeIssues`/`maxStageFor` logic in `entityGraph.ts` — extend it to also consider mapped facets, not just `doc.extracted`).
4. `propose.ts` — clusters unmapped facets (same normalized label, same value-type guess, across the corpus) into `Proposal` rows per the promotion rules in `STORAGE_AND_RETRIEVAL_MODEL.md` (synonym auto-promote at 2 occurrences against an existing field with a compatible value type; field proposals after ≥3 docs/≥2 batches; document-type/aspect proposals after ≥3 clustering docs; entity-type proposals always pending). Auto-promotions write a `SchemaVersionRow` and update the field's tier/observationCount directly; everything else creates a `pending` `Proposal` for Review.
5. `resolve.ts` — link-or-park using `adapter.resolveEntity`, same score bands as the original plan (≥0.80 link, 0.50–0.79 inbox + best guess, else provisional new entity when enough key fields are present). Also attaches every facet on the page to whatever entities the page resolves to, independent of mapping status.
6. `dedupe.ts` — exact (hash, already done in `receive`) + near (field-signature via `adapter.dedupeSignature`, falling back to `adapter.facetSignature` when the doc has no mapped type) → `duplicate`/`possible-duplicate` issue.
7. `conflicts.ts` — same entity + same **mapped** field + different normalized value across docs → hard `Conflict` (existing shape, unchanged). Same entity + same **facet label** (unmapped) + different value → a new `DocumentIssue` kind `'inconsistent-facet'` (add to the `DocumentIssue` union in `types.ts`), softer than a conflict, shown in Review but not blocking.
8. `autoverify.ts` — confidence-tiered auto-approval **by consequence**, not by one global threshold (see `claude/INGESTION_STRATEGY_AT_SCALE.md`, layer 1). Every registered field carries a `consequence` tier (`'high' | 'medium' | 'low'`, defaulting to `'medium'`; see `FieldSpec.consequence` in `types.ts` and `src/domains/hvac/schema.ts`). A document structurally ready to become `'verified'` (required fields present, linked, no conflicts) only actually reaches it once every consequential field it touches clears its tier's bar: `'high'` (warranty expiry, serial) never auto-verifies — a human must look at least once, ever, per (entity, field); `'medium'` (technician, service date, cost) needs an independent corroborating document reporting the same normalized value, or a prior human look; `'low'` (freeform notes) is unchanged, always auto. A blocked document stays at `'linked'` (still answerable as Unverified) with a `needs-verification` issue; Review's existing Approve action always clears it. Also responsible for advancing a structurally-incomplete document as far as it legitimately can go — before this step, nothing did that automatically past `'classified'`, so a document sat unopened until a person looked at it just to become answerable-as-Unverified.
9. `index.ts` — no-op for now beyond marking the doc indexed; retrieval reads the graph directly (as M1 does) plus the new facet index described next — there is no separate build step required at prototype scale.

**Re-map on promotion**: when a `Proposal` of kind `field` or `synonym` is confirmed (via `useGraph.confirmProposal`), re-run `map.ts` locally (no new model call — it's a pure re-match against the now-updated registry) over every `Facet` row already tagged with that proposal's `label`/`facetIds` evidence, across all documents, turning matching facets into extractions. This is the "re-map, not re-OCR" behavior from the design doc — implement it as `src/core/pipeline/remap.ts`, called by the `confirmProposal` action.

## Facet index (new file `src/core/facetIndex.ts`)

`buildFacetIndex(g: GraphSnapshot): FacetIndexEntry[]` where each entry is `{ facetId, documentId, entityIds, labelRaw, valueRaw, valueTypeGuess, searchText }` (searchText = lowercased "label value" for substring/lexical matching). `searchFacets(index, terms: string[]): FacetIndexEntry[]`. This is index #3 in the design doc (identifier/exact and structured/typed being #1–2, already covered by `api/_lib/retrieve.js`'s entity-field matching). Wire it into `answerService.claude.ts`'s `buildAskRequest`: unmapped facets touching a retrieved/answerable entity get added to the request as a new top-level array `unmappedFacets: [{ entityId, labelRaw, valueRaw, documentId, page, bbox }]` (extend `docs/ASK_API.md`'s request shape with this field — additive, optional, older requests without it still work), and `api/ask.js`'s prompt building includes them as citable-but-unverified context, labeled the same way `heldBack` docs are today ("from an unconfirmed field"). Facts built from an `unmappedFacets` entry count toward `unverifiedCount`, never `verifiedCount`.

## `POST /api/ingest/read` (new file `api/ingest/read.js`)

Guard: same shape as `api/_lib/guard.js`'s `checkGuard`, plus a new `checkIngestGuard(req)` in `api/_lib/guard.js` (add to the existing file, don't create a parallel guard module) using `INGEST_ENABLED` (must be `"true"`, default off — 403 otherwise, same body shape as the ask guard), the existing origin allow-list and per-IP bucket, and a new global daily **page** cap `INGEST_DAILY_PAGES` (default 300) — same Upstash-or-memory counter pattern as `ASK_DAILY_CAP`, separate counter key. Reject bodies over 8 MB (one page image) with 413.

Request:
```jsonc
{ "pageImageBase64": "...", "mediaType": "image/png", "documentId": "DOC101", "page": 1, "hint": { "filename": "IMG_4502.jpg", "priorAspects": ["nameplate-photo"] } } // hint is optional and advisory only — the model must not be gated by it
```

Response (200):
```jsonc
{
  "segments": [ { "kind": "header", "bbox": { "x":0.05,"y":0.02,"w":0.9,"h":0.12 } } ],
  "facets": [ { "labelRaw": "Model No.", "valueRaw": "XR16", "valueTypeGuess": "text", "bbox": {"x":0.1,"y":0.3,"w":0.3,"h":0.05}, "confidence": 0.92 } ]
}
```
Model: `claude-sonnet-4-5`, vision, tool-forced to this exact shape (`extract_page_reading` tool), temperature 0, 15s timeout. **Nothing is filtered here** — every label/value pair the model can see goes in `facets`, matched or not; do not pass a field registry into this prompt at all (that would bias the reading pass back toward a closed schema, which is exactly what this replaces). Reject any facet whose `bbox` falls outside `[0,1]` on any axis (drop it, don't fail the request) and cap at 60 facets/page (log if truncated).

## `POST /api/ingest/map` (new file `api/ingest/map.js`)

Request:
```jsonc
{
  "documentId": "DOC101",
  "facets": [ { "index": 0, "labelRaw": "Model No.", "valueRaw": "XR16", "valueTypeGuess": "text" } ],
  "registry": { "documentTypes": [ /* DocumentTypeSpec[] */ ], "fields": [ { "entityType": "equipment", "key": "model", "label": "Model", "synonyms": ["Model No.", "Model #"] } ] },
  "filenameHint": "IMG_4502.jpg"
}
```
Response (200):
```jsonc
{
  "documentType": { "id": "nameplate-photo", "confidence": 0.88 },
  "aspects": ["nameplate-photo"],
  "matches": [ { "facetIndex": 0, "entityType": "equipment", "fieldKey": "model", "valueNorm": "XR16", "confidence": 0.94, "method": "synonym" } ],
  "unmatchedIndices": [2, 5]
}
```
Model: `claude-sonnet-4-5` (mapping needs the same reasoning quality as classification did in the original plan — Haiku is fine to try first in tuning if it holds accuracy), tool-forced, temperature 0, 10s timeout. `method` must be one of `registry | synonym | learned` (never `human` — that value is only ever set client-side when a person does it in Review). Server validates every `facetIndex` exists in the request and every `entityType`/`fieldKey` pair exists in the supplied `registry`; anything else is dropped server-side and counted in `unmatchedIndices` regardless of what the model said.

Both endpoints are logged one JSON line per call (documentId, page, latencyMs, facet/match counts, cost estimate) the same way `api/ask.js` logs questions today.

## File ownership for the M2 build (avoid touching the same file from two agents)

- **Foundation agent**: `src/core/types.ts` (additive edits only), `src/core/recordsStore.ts` (new), `src/core/normalize.ts` (new), `src/core/facetIndex.ts` (new), `src/core/pipeline/*.ts` (new dir, all 8 files + `runner.ts` + `remap.ts`), `src/core/entityGraph.ts` (edits: facets/proposals collections, hydrate-from-store, new actions), `src/domains/hvac/adapter.ts` (new), `src/domains/hvac/schema.ts` (edits: add `tier`/`synonyms`/`observationCount`/`addedInSchemaVersion` to every field spec).
- **API agent**: `api/_lib/normalize.js` (new — move normalizers out of `api/_lib/validate.js`, keep `validate.js` behavior identical by importing from the new module), `api/_lib/guard.js` (edits: add `checkIngestGuard` + `INGEST_DAILY_PAGES` counter, don't touch `checkGuard`), `api/ingest/read.js` (new), `api/ingest/map.js` (new), delete `api/extract.js` and `api/search.js` after grepping the whole repo for any import of `/api/extract` or `/api/search` (there should be none live — they predate the M0/M1 rebuild; if anything still references them, leave them and note it instead of deleting), `scripts/test-ingest-api.mjs` (new, `node:test`, no network — mirrors `scripts/test-api.mjs`'s fake-req/res pattern), `.env.local.example` (append `INGEST_ENABLED=false`, `INGEST_DAILY_PAGES=300` — if the write tool refuses this path, note it in the final report instead of failing).
- **UI agent**: `src/screens/IntakeScreen.tsx` (rewire real upload: actual `File` objects → sha256 → page render → pipeline runner, replacing the filename-only mock; keep the batch/source UI shell), `src/screens/ReviewScreen.tsx` (add a Facets section listing unmapped facets on the open doc with an inline "this means <field>" quick-map control that creates a `synonym` proposal, a Proposals-to-confirm section, `inconsistent-facet` issue display), `src/screens/RecordsScreen.tsx` (add the Schema Health panel: proposals pending count, discovered fields + observation counts, mapping coverage %, re-map backlog — read the file first to match its existing layout/components), `src/domains/hvac/intake.ts` (edits: keep `classifyByFilename`/`fileTypeOf` as fallbacks/hints only, they're no longer the source of truth for `typeId`), `src/components/DocumentPreview.tsx` (edits, additive: also draw facet boxes, not just cited-field boxes, when a facet is being highlighted from Review), package.json (add `pdfjs-dist` dependency and wire it — check what's already installed first).
- **Test-doc-generator agent**: `test-docs/` (new dir, committed — generated PDFs/PNGs + `test-docs/ground-truth.json`), `scripts/gen-test-docs.mjs` (new, the generator script itself, so the set is reproducible), does not touch anything under `src/` or `api/`.

Read `claude/M2_PLAN.md` for the full generated-test-set spec (~24–28 docs, including the 4+ documents with fields outside the tier-0 registry needed to prove the proposals mechanism fires) and the eval/tuning/verification steps that follow once these four pieces exist.
