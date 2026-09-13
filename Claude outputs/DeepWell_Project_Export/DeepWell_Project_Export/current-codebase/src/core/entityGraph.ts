/**
 * The entity graph: entities + documents + batches + conflicts + facets +
 * proposals, and the provenance between them. The answer service reads from
 * here; the review screen writes here. A correction approved in review
 * changes the next answer because both go through this one store.
 *
 * Every mutating action also writes through to a module-level `RecordsStore`
 * instance (src/core/recordsStore.ts) so state survives reload — the lean
 * persistence layer for M2 (IndexedDB behind that interface; Postgres swaps
 * in later without this file's callers changing). See
 * `hydrateFromStore`/`bootstrapFromStoreOrSeed` below for the boot sequence.
 */
import { create } from 'zustand';
import type {
  Batch,
  Conflict,
  Doc,
  DocumentId,
  DomainSchema,
  Entity,
  EntityId,
  Facet,
  FieldSpec,
  FieldTarget,
  FieldValue,
  IntakeSource,
  PipelineStage,
  Proposal,
  SchemaVersionRow,
  Segment,
  SourceRef,
} from './types';
import { PIPELINE_STAGES } from './types';
import { createRecordsStore, type RecordsStore } from './recordsStore';
import { remap } from './pipeline/remap';

export interface GraphSnapshot {
  schema: DomainSchema;
  entities: Record<EntityId, Entity>;
  docs: Record<DocumentId, Doc>;
  batches: Record<string, Batch>;
  conflicts: Record<string, Conflict>;
  /** Every facet found by the universal reading pass, mapped or not — see docs/INGEST_API.md. */
  facets: Record<string, Facet>;
  /** Pending/resolved schema-growth proposals awaiting confirmation in Review. */
  proposals: Record<string, Proposal>;
}

/** The result of the mapping pass for one document — what `ingestMap` applies. */
export interface IngestMapMatch {
  facetId: string;
  entityType: string;
  fieldKey: string;
  valueNorm: string;
  confidence: number;
  method: 'registry' | 'synonym' | 'learned';
}
export interface IngestMapResult {
  documentType: { id: string; confidence: number } | null;
  aspects: string[];
  matches: IngestMapMatch[];
}

interface GraphActions {
  seed: (schema: DomainSchema, entities: Entity[], docs: Doc[], batches: Batch[], conflicts: Conflict[]) => void;

  /** Review: correct an extracted value (or add a missing one). If the doc is linked/verified the entity field updates too. */
  correctField: (docId: DocumentId, fieldName: string, value: string, by: string, target?: FieldTarget) => void;
  /** Review: classify a received doc. */
  classifyDoc: (docId: DocumentId, typeId: string) => void;
  /** Review: attach a doc to an entity (clears the unlinked issue). */
  linkDoc: (docId: DocumentId, entityId: EntityId) => void;
  /** Review: approve — advance as far as the doc's issues allow. */
  approveDoc: (docId: DocumentId, by: string) => void;
  /** Review: pick the winning value for a conflict. */
  resolveConflict: (conflictId: string, value: string, by: string) => void;
  /** Review: merge a duplicate into its original (drops the copy). */
  mergeDuplicate: (docId: DocumentId) => void;
  /** Intake: create a batch. */
  createBatch: (input: { name: string; source: IntakeSource; from: Date; to: Date; by: string }) => string;
  /** Intake: add received documents to a batch (mock upload). */
  receiveDocs: (batchId: string, files: { filename: string; fileType: Doc['fileType'] }[]) => DocumentId[];

  // -- Open-schema (v2) ingestion actions — see docs/INGEST_API.md --------

  /** Pipeline step 2 (read): records the universal reading pass's output for a doc. */
  ingestRead: (docId: DocumentId, facets: Facet[], segments: Segment[]) => void;
  /** Pipeline step 3 (map): applies the mapping pass's matches as extractions; unmatched facets stay as facets. */
  ingestMap: (docId: DocumentId, mappingResult: IngestMapResult) => void;
  /** Review: confirm a pending proposal — promotes the registry (tier bump / new field / new synonym) and triggers a targeted re-map, never a re-read. */
  confirmProposal: (proposalId: string, by: string) => void;
  /** System-confirmed promotion (no Review click) for the auto-promote rules — synonyms at 2 occurrences, fields at ≥3 docs/≥2 batches. See docs/INGEST_API.md, "propose.ts". */
  autoPromoteProposal: (proposal: Proposal) => void;
  /** Review: reject a pending proposal — remembered so the same noise isn't proposed again. */
  rejectProposal: (proposalId: string, by: string) => void;
  /**
   * Generic patch application used by the pipeline runner (src/core/pipeline/runner.ts)
   * for the steps that don't have a bespoke action above (receive, propose,
   * resolve, dedupe, conflicts, index) — merges the patch, recomputes issues,
   * and writes through to the store exactly like every other action here.
   */
  applyPipelinePatch: (docId: DocumentId, patch: Partial<Doc>) => void;
  /** Registers facets minted by a pipeline step other than `read` (currently only propose.ts's clustering) into the global facets collection. */
  registerFacets: (facets: Facet[]) => void;
  /** Registers proposals minted by propose.ts into the global proposals collection. */
  registerProposals: (proposals: Proposal[]) => void;
  /** Registers provisional entities minted by resolve.ts when no existing entity matched. */
  registerEntities: (entities: Entity[]) => void;
  /** Registers hard conflicts newly detected by conflicts.ts. */
  registerConflicts: (conflicts: Conflict[]) => void;
}

export type GraphStore = GraphSnapshot & GraphActions;

const stageIndex = (s: PipelineStage) => PIPELINE_STAGES.indexOf(s);

export function isAnswerable(doc: Doc, includeUnverified: boolean): boolean {
  if (doc.issues.some((i) => i.kind === 'duplicate')) return false;
  return includeUnverified ? stageIndex(doc.stage) >= stageIndex('linked') : doc.stage === 'verified';
}

/**
 * Resolve a document type's required-field label (raw printed text, e.g.
 * "Warranty expires") to the canonical field a registered entity type
 * declares for it, by matching case-insensitively against every field's
 * `label` and `synonyms`. Returns undefined when nothing in the registry
 * claims that label yet (e.g. "Permit No." has no field of its own) — such
 * labels fall back to exact raw-text matching, same as pre-M2 behavior.
 *
 * This is the fix for the M2 verifier's stage-advancement bug: a document
 * whose printed label maps to the right field (via the mapping pass) must
 * satisfy the requirement even when its raw wording never literally equals
 * the required-field string — that's the entire point of the open schema.
 */
function canonicalFieldForRequiredLabel(schema: DomainSchema, label: string): { fieldKey: string } | undefined {
  const norm = label.trim().toLowerCase();
  for (const et of schema.entityTypes) {
    for (const f of et.fields) {
      const candidates = [f.label, ...(f.synonyms ?? [])].map((s) => s.trim().toLowerCase());
      if (candidates.includes(norm)) return { fieldKey: f.key };
    }
  }
  return undefined;
}

/**
 * Which of a document type's required-field labels this doc currently
 * satisfies. Three ways a requirement can be met, checked in order:
 *   1. Raw-text match — an extracted field or mapped facet whose label is
 *      literally the required string (pre-M2 behavior, kept for required
 *      labels with no registered field, e.g. "Permit No.").
 *   2. Canonical match via `doc.extracted` — a field whose `target.field`
 *      (set by the mapping pass or a human correction) is the field the
 *      required label resolves to, regardless of how it was worded on the
 *      page.
 *   3. Canonical match via `doc.facets` — a facet the mapping pass matched
 *      (`mappedFieldKey`) to that same field, even before it's copied into
 *      `extracted`.
 */
function presentRequiredLabels(doc: Doc, schema: DomainSchema, requiredFields: string[]): Set<string> {
  const extractedRaw = new Set(doc.extracted.filter((f) => (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  const facetsRaw = new Set((doc.facets ?? []).filter((f) => f.mappedFieldKey && f.valueRaw.trim()).map((f) => f.labelRaw));
  const satisfied = new Set<string>();
  for (const required of requiredFields) {
    if (extractedRaw.has(required) || facetsRaw.has(required)) {
      satisfied.add(required);
      continue;
    }
    const canonical = canonicalFieldForRequiredLabel(schema, required);
    if (!canonical) continue;
    const extractedMatch = doc.extracted.some((f) => f.target?.field === canonical.fieldKey && (f.correctedValue ?? f.value).trim());
    const facetMatch = (doc.facets ?? []).some((f) => f.mappedFieldKey === canonical.fieldKey && f.valueRaw.trim());
    if (extractedMatch || facetMatch) satisfied.add(required);
  }
  return satisfied;
}

/** A registered field's consequence tier, defaulting to 'medium' (the conservative choice) when the field is unregistered or hasn't declared one. Shared by `autoverify.ts` and anything else that needs to reason about a field's risk without duplicating the registry lookup. */
export function fieldConsequence(schema: DomainSchema, entityType: string, fieldKey: string): 'high' | 'medium' | 'low' {
  const field = schema.entityTypes.find((t) => t.id === entityType)?.fields.find((f) => f.key === fieldKey);
  return field?.consequence ?? 'medium';
}

/** Required-field labels for a doc's type that are NOT yet satisfied — shared by the pipeline (recomputeIssues/maxStageFor) and by Review's UI, so both agree on what "missing" means. */
export function missingRequiredFields(doc: Doc, schema: DomainSchema): string[] {
  const type = schema.documentTypes.find((t) => t.id === doc.typeId);
  const required = type?.requiredFields ?? [];
  const present = presentRequiredLabels(doc, schema, required);
  return required.filter((r) => !present.has(r));
}

/** Where in the pipeline a document can legitimately sit given its issues. */
export function maxStageFor(doc: Doc, schema: DomainSchema): PipelineStage {
  if (doc.issues.some((i) => i.kind === 'duplicate')) return 'received';
  if (!doc.typeId) return 'received';
  const missing = missingRequiredFields(doc, schema);
  if (missing.length) return 'classified';
  if (doc.linkedEntityIds.length === 0) return 'extracted';
  if (doc.issues.some((i) => i.kind === 'conflict')) return 'linked';
  return 'verified';
}

function recomputeIssues(doc: Doc, schema: DomainSchema): Doc {
  const kept = doc.issues.filter((i) => i.kind !== 'missing-field' && !(i.kind === 'unlinked' && doc.linkedEntityIds.length > 0));
  const missing = missingRequiredFields(doc, schema).map((f) => ({ kind: 'missing-field' as const, field: f }));
  return { ...doc, issues: [...missing, ...kept] };
}

/** Parse a corrected string back into the entity's field type. */
function coerce(schema: DomainSchema, entity: Entity, field: string, raw: string): FieldValue {
  const spec = schema.entityTypes.find((t) => t.id === entity.type)?.fields.find((f) => f.key === field);
  const v = raw.trim();
  if (!spec) return v;
  switch (spec.kind) {
    case 'date': {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'money':
    case 'number': {
      const n = Number(v.replace(/[^0-9.-]/g, ''));
      return Number.isNaN(n) ? null : n;
    }
    default:
      return v;
  }
}

/** Apply every corrected + linked field of a doc onto its target entities. */
function applyDocToEntities(state: GraphSnapshot, doc: Doc): Record<EntityId, Entity> {
  if (stageIndex(doc.stage) < stageIndex('linked')) return state.entities;
  const entities = { ...state.entities };
  for (const f of doc.extracted) {
    if (!f.target || f.correctedValue === undefined) continue;
    const ent = entities[f.target.entityId];
    if (!ent) continue;
    entities[f.target.entityId] = {
      ...ent,
      fields: { ...ent.fields, [f.target.field]: coerce(state.schema, ent, f.target.field, f.correctedValue) },
    };
  }
  return entities;
}

let idCounter = 1;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function slugifyKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_+|_+$)/g, '') || `field_${newId('f')}`;
}

/** Applies a confirmed proposal's registry change (new synonym, or a brand-new discovered field) — pure, returns the updated schema plus the audit row. */
function promoteInSchema(schema: DomainSchema, proposal: Proposal, newVersion: number): { schema: DomainSchema; versionRow: SchemaVersionRow } {
  if (proposal.kind === 'synonym' && proposal.targetFieldKey) {
    const entityTypes = schema.entityTypes.map((et) => ({
      ...et,
      fields: et.fields.map((f) =>
        f.key === proposal.targetFieldKey
          ? { ...f, synonyms: Array.from(new Set([...(f.synonyms ?? []), proposal.label])), observationCount: (f.observationCount ?? 0) + proposal.evidence.count }
          : f,
      ),
    }));
    return {
      schema: { ...schema, entityTypes },
      versionRow: { version: newVersion, changeKind: 'synonym-added', description: `"${proposal.label}" recognized as a synonym for ${proposal.targetFieldKey}`, createdAt: new Date(), createdBy: proposal.resolvedBy },
    };
  }
  if (proposal.kind === 'field' && proposal.targetEntityType) {
    const key = slugifyKey(proposal.label);
    const kind = proposal.evidence.valueTypeGuess === 'money' ? 'money' : proposal.evidence.valueTypeGuess === 'date' ? 'date' : proposal.evidence.valueTypeGuess === 'serial' || proposal.evidence.valueTypeGuess === 'identifier' ? 'serial' : proposal.evidence.valueTypeGuess === 'number' ? 'number' : 'text';
    const newField: FieldSpec = {
      key,
      label: proposal.label,
      kind,
      tier: 1,
      synonyms: [proposal.label],
      observationCount: proposal.evidence.count,
      addedInSchemaVersion: newVersion,
    };
    const entityTypes = schema.entityTypes.map((et) => (et.id === proposal.targetEntityType ? { ...et, fields: [...et.fields, newField] } : et));
    return {
      schema: { ...schema, entityTypes },
      versionRow: { version: newVersion, changeKind: 'field-added', description: `Discovered field "${proposal.label}" on ${proposal.targetEntityType}`, createdAt: new Date(), createdBy: proposal.resolvedBy },
    };
  }
  return { schema, versionRow: { version: newVersion, changeKind: 'field-added', description: `Confirmed proposal ${proposal.id} (${proposal.kind}, no schema change)`, createdAt: new Date(), createdBy: proposal.resolvedBy } };
}

/** Shared by `confirmProposal` (human-confirmed) and `autoPromoteProposal` (system-confirmed, per the promotion rules in claude/STORAGE_AND_RETRIEVAL_MODEL.md §4): promotes the registry and re-maps every facet the proposal names as evidence. */
function promoteAndRemap(s: GraphSnapshot, resolved: Proposal): Pick<GraphSnapshot, 'schema' | 'docs' | 'facets'> {
  schemaVersionCounter += 1;
  const { schema: nextSchema, versionRow } = promoteInSchema(s.schema, resolved, schemaVersionCounter);
  void recordsStore.put('schemaVersions', { id: `sv-${versionRow.version}`, ...versionRow });

  const remapped =
    resolved.kind === 'field' || resolved.kind === 'synonym'
      ? remap(resolved, s.docs, s.facets, nextSchema, schemaVersionCounter)
      : { docs: s.docs, facets: s.facets, touchedFacetIds: [], touchedDocIds: [] };
  const { docs: nextDocs, facets: nextFacets, touchedDocIds, touchedFacetIds } = remapped;

  persistDocs(touchedDocIds.map((id) => nextDocs[id]).filter((d): d is Doc => Boolean(d)));
  persistFacets(touchedFacetIds.map((id) => nextFacets[id]).filter((f): f is Facet => Boolean(f)));

  return { schema: nextSchema, docs: nextDocs, facets: nextFacets };
}

// ---------------------------------------------------------------------------
// Persistence (write-through)
// ---------------------------------------------------------------------------

const recordsStore: RecordsStore = createRecordsStore();
/** In-memory registry-version counter, seeded from the store on hydrate. Schema versions aren't part of `GraphSnapshot` (the schema itself lives there; the version ledger is store-only), so this is the only place that needs to track "what's next". */
let schemaVersionCounter = 0;

function persistDoc(doc: Doc): void {
  void recordsStore.put('docs', doc);
}
function persistDocs(docs: Doc[]): void {
  void recordsStore.putMany('docs', docs);
}
function persistEntities(entities: Entity[]): void {
  void recordsStore.putMany('entities', entities);
}
function persistFacets(facets: Facet[]): void {
  if (facets.length) void recordsStore.putMany('facets', facets);
}
function persistProposal(p: Proposal): void {
  void recordsStore.put('proposals', p);
}
function persistBatch(b: Batch): void {
  void recordsStore.put('batches', b);
}
function persistConflict(c: Conflict): void {
  void recordsStore.put('conflicts', c);
}

export const useGraph = create<GraphStore>((set) => ({
  schema: { id: 'none', label: '', entityTypes: [], documentTypes: [], fallbackDocumentType: 'other' },
  entities: {},
  docs: {},
  batches: {},
  conflicts: {},
  facets: {},
  proposals: {},

  seed: (schema, entities, docs, batches, conflicts) =>
    set({
      schema,
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      docs: Object.fromEntries(docs.map((d) => [d.id, d])),
      batches: Object.fromEntries(batches.map((b) => [b.id, b])),
      conflicts: Object.fromEntries(conflicts.map((c) => [c.id, c])),
      facets: {},
      proposals: {},
    }),

  correctField: (docId, fieldName, value, by, target) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const exists = doc.extracted.some((f) => f.name === fieldName);
      const extracted = exists
        ? doc.extracted.map((f) => (f.name === fieldName ? { ...f, correctedValue: value, correctedBy: by, correctedAt: new Date(), ...(target ? { target } : {}) } : f))
        : [...doc.extracted, { name: fieldName, value, confidence: 1, location: { page: 1, field: fieldName }, correctedValue: value, correctedBy: by, correctedAt: new Date(), ...(target ? { target } : {}) }];
      const preview = exists ? doc.preview : `${doc.preview}\n${fieldName}: ${value}`;
      const next = recomputeIssues({ ...doc, extracted, preview }, s.schema);
      const docs = { ...s.docs, [docId]: next };
      const entities = applyDocToEntities({ ...s, docs }, next);
      persistDoc(next);
      persistEntities(Object.values(entities));
      return { docs, entities };
    }),

  classifyDoc: (docId, typeId) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const next = recomputeIssues({ ...doc, typeId, stage: 'classified' }, s.schema);
      persistDoc(next);
      return { docs: { ...s.docs, [docId]: next } };
    }),

  linkDoc: (docId, entityId) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const linkedEntityIds = Array.from(new Set([...doc.linkedEntityIds, entityId]));
      const next = recomputeIssues({ ...doc, linkedEntityIds, linkConfidence: 1 }, s.schema);
      persistDoc(next);
      return { docs: { ...s.docs, [docId]: next } };
    }),

  approveDoc: (docId, by) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const target = maxStageFor(doc, s.schema);
      const next: Doc = { ...doc, stage: target };
      if (target === 'verified') {
        next.verifiedBy = by;
        next.verifiedAt = new Date();
        // A human looking at the whole document is exactly the "at least once" look the
        // consequence-tiered auto-verify gate (autoverify.ts) requires for high-consequence
        // fields, and more than satisfies the medium-consequence corroboration bar — clear
        // whatever it was still waiting on.
        next.issues = next.issues.filter((i) => i.kind !== 'needs-verification');
      }
      const docs = { ...s.docs, [docId]: next };
      const entities = applyDocToEntities({ ...s, docs }, next);
      persistDoc(next);
      persistEntities(Object.values(entities));
      return { docs, entities };
    }),

  resolveConflict: (conflictId, value, by) =>
    set((s) => {
      const c = s.conflicts[conflictId];
      if (!c) return s;
      const nextConflict = { ...c, resolvedValue: value, resolvedBy: by, resolvedAt: new Date() };
      const conflicts = { ...s.conflicts, [conflictId]: nextConflict };
      // Clear the conflict issue on every doc that raised it; the winning value goes on the entity.
      const docs = { ...s.docs };
      for (const cand of c.candidates) {
        const d = docs[cand.documentId];
        if (d) {
          docs[cand.documentId] = { ...d, issues: d.issues.filter((i) => !(i.kind === 'conflict' && i.conflictId === conflictId)) };
          persistDoc(docs[cand.documentId] as Doc);
        }
      }
      const ent = s.entities[c.entityId];
      const entities = ent
        ? { ...s.entities, [c.entityId]: { ...ent, fields: { ...ent.fields, [c.field]: coerce(s.schema, ent, c.field, value) } } }
        : s.entities;
      persistConflict(nextConflict);
      if (ent) persistEntities([entities[c.entityId] as Entity]);
      return { conflicts, docs, entities };
    }),

  mergeDuplicate: (docId) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const docs = { ...s.docs };
      delete docs[docId];
      const batch = s.batches[doc.batchId];
      const batches = batch
        ? { ...s.batches, [doc.batchId]: { ...batch, documentIds: batch.documentIds.filter((id) => id !== docId) } }
        : s.batches;
      void recordsStore.delete('docs', docId);
      if (batch) persistBatch(batches[doc.batchId] as Batch);
      return { docs, batches };
    }),

  createBatch: ({ name, source, from, to, by }) => {
    const id = newId('batch');
    set((s) => {
      const batch: Batch = { id, name, source, dateRange: { from, to }, createdAt: new Date(), createdBy: by, documentIds: [] };
      persistBatch(batch);
      return { batches: { ...s.batches, [id]: batch } };
    });
    return id;
  },

  receiveDocs: (batchId, files) => {
    const ids: DocumentId[] = [];
    set((s) => {
      const batch = s.batches[batchId];
      if (!batch) return s;
      const docs = { ...s.docs };
      const newDocs: Doc[] = [];
      for (const f of files) {
        const id = newId('doc');
        ids.push(id);
        // Dedupe on intake: same filename already in the system → flag, don't double count
        const dup = Object.values(s.docs).find((d) => d.filename === f.filename);
        const doc: Doc = {
          id,
          filename: f.filename,
          fileType: f.fileType,
          pages: 1,
          batchId,
          source: batch.source,
          receivedAt: new Date(),
          typeId: null,
          stage: 'received',
          extracted: [],
          linkedEntityIds: [],
          linkConfidence: 0,
          issues: dup ? [{ kind: 'duplicate', of: dup.id }] : [],
          preview: `${f.filename}\n\nReceived. Not yet classified.`,
          facets: [],
          aspects: [],
        };
        docs[id] = doc;
        newDocs.push(doc);
      }
      const nextBatch = { ...batch, documentIds: [...batch.documentIds, ...ids] };
      persistDocs(newDocs);
      persistBatch(nextBatch);
      return { docs, batches: { ...s.batches, [batchId]: nextBatch } };
    });
    return ids;
  },

  ingestRead: (docId, facets, _segments) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const mergedFacets = [...(doc.facets ?? []), ...facets];
      const stage: PipelineStage = stageIndex(doc.stage) < stageIndex('classified') ? 'classified' : doc.stage;
      const next = recomputeIssues({ ...doc, facets: mergedFacets, stage }, s.schema);
      const facetsById = { ...s.facets };
      for (const f of facets) facetsById[f.id] = f;
      persistDoc(next);
      persistFacets(facets);
      return { docs: { ...s.docs, [docId]: next }, facets: facetsById };
    }),

  ingestMap: (docId, mappingResult) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const facets = (doc.facets ?? []).map((f) => ({ ...f }));
      const byId = new Map(facets.map((f) => [f.id, f]));
      const extracted = [...doc.extracted];
      const touchedFacets: Facet[] = [];

      for (const m of mappingResult.matches) {
        const facet = byId.get(m.facetId);
        if (!facet) continue;
        facet.mappedEntityType = m.entityType;
        facet.mappedFieldKey = m.fieldKey;
        facet.mappingConfidence = m.confidence;
        facet.mappingMethod = m.method;
        facet.schemaVersionAtMapping = schemaVersionCounter;
        touchedFacets.push(facet);
        extracted.push({ name: facet.labelRaw, value: m.valueNorm, confidence: m.confidence, location: { page: facet.page, field: facet.labelRaw } });
      }

      const typeId = mappingResult.documentType?.id ?? doc.typeId;
      const aspects = Array.from(new Set([...(doc.aspects ?? []), ...mappingResult.aspects]));
      const patched = { ...doc, facets, extracted, typeId, aspects };
      const stage = maxStageFor(patched, s.schema);
      const next = recomputeIssues({ ...patched, stage }, s.schema);

      const facetsById = { ...s.facets };
      for (const f of touchedFacets) facetsById[f.id] = f;
      persistDoc(next);
      persistFacets(touchedFacets);
      return { docs: { ...s.docs, [docId]: next }, facets: facetsById };
    }),

  confirmProposal: (proposalId, by) =>
    set((s) => {
      const proposal = s.proposals[proposalId];
      if (!proposal || proposal.status !== 'pending') return s;
      const resolved: Proposal = { ...proposal, status: 'confirmed', resolvedAt: new Date(), resolvedBy: by };
      const { schema, docs, facets } = promoteAndRemap(s, resolved);
      persistProposal(resolved);
      return { proposals: { ...s.proposals, [proposalId]: resolved }, schema, docs, facets };
    }),

  /**
   * System-confirmed promotion for the rules that don't wait on a human
   * click — synonyms at 2 consistent occurrences, fields at ≥3 docs/≥2
   * batches (claude/STORAGE_AND_RETRIEVAL_MODEL.md §4). Called by
   * `src/core/pipeline/propose.ts` via the runner, not exposed to Review.
   */
  autoPromoteProposal: (proposal) =>
    set((s) => {
      const resolved: Proposal = { ...proposal, status: 'confirmed', resolvedAt: new Date(), resolvedBy: undefined };
      const { schema, docs, facets } = promoteAndRemap(s, resolved);
      persistProposal(resolved);
      return { proposals: { ...s.proposals, [resolved.id]: resolved }, schema, docs, facets };
    }),

  rejectProposal: (proposalId, by) =>
    set((s) => {
      const proposal = s.proposals[proposalId];
      if (!proposal || proposal.status !== 'pending') return s;
      const resolved: Proposal = { ...proposal, status: 'rejected', resolvedAt: new Date(), resolvedBy: by };
      persistProposal(resolved);
      return { proposals: { ...s.proposals, [proposalId]: resolved } };
    }),

  applyPipelinePatch: (docId, patch) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const merged: Doc = { ...doc, ...patch };
      const next = recomputeIssues(merged, s.schema);
      const docs = { ...s.docs, [docId]: next };
      const entities = applyDocToEntities({ ...s, docs }, next);
      persistDoc(next);
      if (entities !== s.entities) persistEntities(Object.values(entities));
      return { docs, entities };
    }),

  registerFacets: (facets) =>
    set((s) => {
      const next = { ...s.facets };
      for (const f of facets) next[f.id] = f;
      persistFacets(facets);
      return { facets: next };
    }),

  registerProposals: (proposals) =>
    set((s) => {
      const next = { ...s.proposals };
      for (const p of proposals) next[p.id] = p;
      void recordsStore.putMany('proposals', proposals);
      return { proposals: next };
    }),

  registerEntities: (newEntities) =>
    set((s) => {
      const next = { ...s.entities };
      for (const e of newEntities) next[e.id] = e;
      persistEntities(newEntities);
      return { entities: next };
    }),

  registerConflicts: (newConflicts) =>
    set((s) => {
      const next = { ...s.conflicts };
      for (const c of newConflicts) {
        next[c.id] = c;
        persistConflict(c);
      }
      return { conflicts: next };
    }),
}));

/**
 * Loads every collection from the RecordsStore into `useGraph`. Returns
 * `true` when there was anything to hydrate (the caller should skip
 * seeding in that case), `false` on a first run with an empty store.
 *
 * `schema` isn't a stored collection (it's code, not data) — the caller
 * supplies the domain schema either way; hydrate only restores the *data*
 * collections layered on top of it.
 */
export async function hydrateFromStore(schema: DomainSchema): Promise<boolean> {
  const [entities, docs, batches, conflicts, facets, proposals, schemaVersions] = await Promise.all([
    recordsStore.all<Entity>('entities'),
    recordsStore.all<Doc>('docs'),
    recordsStore.all<Batch>('batches'),
    recordsStore.all<Conflict>('conflicts'),
    recordsStore.all<Facet>('facets'),
    recordsStore.all<Proposal>('proposals'),
    recordsStore.all<SchemaVersionRow>('schemaVersions'),
  ]);
  if (!docs.length) return false;

  schemaVersionCounter = schemaVersions.reduce((max, r) => Math.max(max, r.version), 0);
  useGraph.setState({
    schema,
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    docs: Object.fromEntries(docs.map((d) => [d.id, d])),
    batches: Object.fromEntries(batches.map((b) => [b.id, b])),
    conflicts: Object.fromEntries(conflicts.map((c) => [c.id, c])),
    facets: Object.fromEntries(facets.map((f) => [f.id, f])),
    proposals: Object.fromEntries(proposals.map((p) => [p.id, p])),
  });
  return true;
}

/**
 * Boot helper: hydrate from the store when there's anything saved, otherwise
 * run the given seed function. `src/domains/hvac/index.ts`'s `bootstrapHvac`
 * (outside this agent's file ownership) currently seeds unconditionally and
 * synchronously — wiring it to call this instead is the one integration
 * step left for whoever owns that file; see the M2 build report.
 */
export async function bootstrapFromStoreOrSeed(schema: DomainSchema, seed: () => void): Promise<void> {
  const hydrated = await hydrateFromStore(schema);
  if (!hydrated) seed();
}

/** Exposed for the pipeline runner and tests — the shared write-through store instance. */
export function getRecordsStore(): RecordsStore {
  return recordsStore;
}

// ---------------------------------------------------------------------------
// Read helpers (pure; take a snapshot so the answer service is testable)
// ---------------------------------------------------------------------------

export function entitiesOfType(g: GraphSnapshot, type: string): Entity[] {
  return Object.values(g.entities).filter((e) => e.type === type);
}

/** Sources for one entity field, restricted to answerable documents. */
export function sourcesFor(g: GraphSnapshot, entityId: EntityId, field: string, includeUnverified: boolean): SourceRef[] {
  const out: SourceRef[] = [];
  for (const doc of Object.values(g.docs)) {
    if (!isAnswerable(doc, includeUnverified)) continue;
    for (const f of doc.extracted) {
      if (f.target?.entityId === entityId && f.target.field === field) {
        out.push({ documentId: doc.id, location: f.location, excerpt: `${f.name}: ${f.correctedValue ?? f.value}` });
      }
    }
  }
  return out;
}

/** Docs linked to an entity, most recent first. */
export function docsLinkedTo(g: GraphSnapshot, entityId: EntityId): Doc[] {
  return Object.values(g.docs)
    .filter((d) => d.linkedEntityIds.includes(entityId))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
}

export function docCountsByStage(g: GraphSnapshot): Record<PipelineStage, number> {
  const counts: Record<PipelineStage, number> = { received: 0, classified: 0, extracted: 0, linked: 0, verified: 0 };
  for (const d of Object.values(g.docs)) counts[d.stage] += 1;
  return counts;
}

export function unlinkedDocs(g: GraphSnapshot): Doc[] {
  return Object.values(g.docs).filter((d) => d.issues.some((i) => i.kind === 'unlinked'));
}
export function gapDocs(g: GraphSnapshot): Doc[] {
  return Object.values(g.docs).filter((d) => d.issues.some((i) => i.kind === 'missing-field'));
}
export function openConflicts(g: GraphSnapshot): Conflict[] {
  return Object.values(g.conflicts).filter((c) => !c.resolvedValue);
}
export function duplicateDocs(g: GraphSnapshot): Doc[] {
  return Object.values(g.docs).filter((d) => d.issues.some((i) => i.kind === 'duplicate'));
}

// -- Open-schema (v2) read helpers ------------------------------------------

/** Proposals awaiting a human decision in Review. */
export function pendingProposals(g: GraphSnapshot): Proposal[] {
  return Object.values(g.proposals).filter((p) => p.status === 'pending');
}
/** Unmapped facets on one document — the Review screen's "Facets" section. */
export function unmappedFacetsFor(g: GraphSnapshot, docId: DocumentId): Facet[] {
  return (g.docs[docId]?.facets ?? []).filter((f) => !f.mappedFieldKey);
}
/** Schema Health: fraction of all known facets that are mapped. */
export function mappingCoverage(g: GraphSnapshot): number {
  const all = Object.values(g.facets);
  if (!all.length) return 1;
  return all.filter((f) => f.mappedFieldKey).length / all.length;
}
/** Schema Health: fields discovered above tier 0, with their observation counts. */
export function discoveredFields(g: GraphSnapshot): { entityType: string; field: FieldSpec }[] {
  const out: { entityType: string; field: FieldSpec }[] = [];
  for (const et of g.schema.entityTypes) {
    for (const f of et.fields) {
      if ((f.tier ?? 0) > 0) out.push({ entityType: et.id, field: f });
    }
  }
  return out;
}
