/**
 * The entity graph: entities + documents + batches + conflicts, and the
 * provenance between them. The answer service reads from here; the review
 * screen writes here. A correction approved in review changes the next answer
 * because both go through this one store.
 */
import { create } from 'zustand';
import type {
  Batch,
  Conflict,
  Doc,
  DocCompleteness,
  DocumentId,
  DomainSchema,
  Entity,
  EntityId,
  FieldTarget,
  FieldValue,
  IntakeSource,
  PipelineStage,
  SourceRef,
} from './types';
import { PIPELINE_STAGES } from './types';
import { reviewClient, type Correction, type DocumentLink } from '../services/reviewClient';
import { recordsStore } from '../services/recordsStoreClient';
import { authHeader } from '../services/authToken';
import { normalizeDocumentType } from '../domains/hvac/documentTypes';

/**
 * Demo mode keeps the whole graph in memory on purpose (its own fixture data
 * has no server-side rows to persist to). Everywhere else, the six review
 * actions below are optimistic writes to a real account: the local store
 * updates immediately, same as before, and — for the four actions that have
 * a real server-side counterpart — a request goes out behind it. A failed
 * request rolls the local change back and records why in `lastError`, so the
 * screen never shows a correction as saved when it was not.
 *
 * `resolveConflict` and `mergeDuplicate` are deliberately NOT wired to a
 * server call. Both operate on data nothing server-side produces yet:
 * `conflicts` is seeded as `[]` by every real sync (usePostgresSync's `seed`
 * call always passes an empty conflicts array — conflict detection across
 * documents is not implemented server-side), and the 'duplicate' issue is
 * only ever raised by receiveDocs' filename check against the in-memory demo
 * fixture, never by anything usePostgresSync produces (`toDoc` always sets
 * `issues: []`). Wiring either to `reviewClient` today would be dead code:
 * neither one's precondition can occur outside demo mode. The moment either
 * form of detection ships server-side, it needs a reviewStore counterpart
 * the way `linkDoc` has one, and this comment is the reminder to add it.
 */
// Optional chaining on purpose: this module is imported by the pure-function
// test runner (tsx), where import.meta.env does not exist. Vite inlines it in
// the real build, so the app sees a plain string either way.
const DEMO_MODE = import.meta.env?.VITE_DEMO_MODE === 'true';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface GraphSnapshot {
  schema: DomainSchema;
  entities: Record<EntityId, Entity>;
  docs: Record<DocumentId, Doc>;
  batches: Record<string, Batch>;
  conflicts: Record<string, Conflict>;
  /** Message from the last review action that failed to persist server-side,
   *  or null. Cleared on the next successful action and by clearLastError. */
  lastError: string | null;
  /** Document ids with an AI-verify request in flight — the single-flight
   *  guard for `aiVerifyDoc`, keyed by docId so a rapid double-click on
   *  "Verify with AI" (which can fire two click events before React commits
   *  a disabled button) cannot start a second request while the first is
   *  still out. Set synchronously before the first `await`, so there is no
   *  gap for a second call to slip through. */
  aiVerifying: Record<DocumentId, boolean>;
}

interface GraphActions {
  seed: (schema: DomainSchema, entities: Entity[], docs: Doc[], batches: Batch[], conflicts: Conflict[]) => void;
  /** Dismiss the banner shown for `lastError`. */
  clearLastError: () => void;

  /** Review: correct an extracted value (or add a missing one). If the doc is linked/verified the entity field updates too. */
  correctField: (docId: DocumentId, fieldName: string, value: string, by: string, target?: FieldTarget) => void;
  /** Review: classify a received doc. */
  classifyDoc: (docId: DocumentId, typeId: string) => void;
  /** Review: attach a doc to an entity (clears the unlinked issue). */
  linkDoc: (docId: DocumentId, entityId: EntityId, by: string) => void;
  /** Review: approve — advance as far as the doc's issues allow. */
  approveDoc: (docId: DocumentId, by: string) => void;
  /** Review: pick the winning value for a conflict. */
  resolveConflict: (conflictId: string, value: string, by: string) => void;
  /** Review: merge a duplicate into its original (drops the copy). */
  mergeDuplicate: (docId: DocumentId) => void;
  /** Review: AI VERIFICATION CONTRACT — ask the server to verify this doc if
   *  it's complete and confident enough. Resolves false (no throw) when it
   *  isn't; a real transport failure sets `lastError` same as the others. */
  aiVerifyDoc: (docId: DocumentId) => Promise<boolean>;
  /** Review: batch reclassification of legacy/unknown/'other' types. Resolves
   *  the number actually changed and how many of `docIds` are still 'other'
   *  (the caller should resubmit exactly those until `remaining` is 0). */
  reclassifyDocs: (docIds: DocumentId[]) => Promise<{ changed: number; remaining: number }>;
  /** Review: drop a document locally after its server-side delete succeeded. */
  removeDoc: (docId: DocumentId) => void;
  /**
   * Insert or replace one document in the graph, recomputing its issues and
   * (if linked/verified) applying its fields onto its entities — same
   * bookkeeping every other graph-mutating action does. This is the write
   * side of the beyond-500-documents fix: usePostgresSync's initial sync
   * caps at 500 documents (recordsStore.js's listDocuments LIMIT 500), but
   * Records Browse (round 12/13) queries the server directly and can return
   * a row for ANY document. `ensureDocLoaded` below calls this once it has
   * fetched a document the graph never loaded, so DocumentPreview.tsx (which
   * just reads `useGraph(s => s.docs[documentId])`) renders it like any
   * other document — no new UI path required. Also creates/extends a
   * placeholder Batch for the document if its batch isn't in the graph yet,
   * mirroring usePostgresSync.ts's buildBatches.
   */
  upsertDoc: (doc: Doc) => void;
  /** Intake: create a batch. */
  createBatch: (input: { name: string; source: IntakeSource; from: Date; to: Date; by: string }) => string;
  /** Intake: add received documents to a batch (mock upload). */
  receiveDocs: (batchId: string, files: { filename: string; fileType: Doc['fileType'] }[]) => DocumentId[];
  /**
   * Intake: fold a real ingest result onto the client-side placeholder
   * `receiveDocs` created for it, swapping the invented id for the server's
   * real `documentId` and applying whatever the ingest pipeline learned
   * (pages read, pipeline stage, a preview reflecting an error). If the real
   * id already names a document already in the graph (e.g. a duplicate
   * re-upload the server matched to an existing row, possibly one this
   * session already loaded from Postgres), that existing record is kept as
   * the richer copy and the placeholder is simply dropped rather than
   * clobbered onto it.
   */
  reconcileIntakeDoc: (tempId: DocumentId, updates: { id?: DocumentId } & Partial<Pick<Doc, 'pages' | 'stage' | 'preview'>>) => void;
}

export type GraphStore = GraphSnapshot & GraphActions;

const stageIndex = (s: PipelineStage) => PIPELINE_STAGES.indexOf(s);

/** A requirement may be `a|b` — either extracted field key satisfies it. */
export function splitAlternatives(requirement: string): string[] {
  return requirement.split('|');
}
export function isRequirementMet(present: Set<string>, requirement: string): boolean {
  return splitAlternatives(requirement).some((k) => present.has(k));
}

export function isAnswerable(doc: Doc, includeUnverified: boolean): boolean {
  if (doc.issues.some((i) => i.kind === 'duplicate')) return false;
  return includeUnverified ? stageIndex(doc.stage) >= stageIndex('linked') : doc.stage === 'verified';
}

/** Where in the pipeline a document can legitimately sit given its issues. */
export function maxStageFor(doc: Doc, schema: DomainSchema): PipelineStage {
  if (doc.issues.some((i) => i.kind === 'duplicate')) return 'received';
  if (!doc.typeId) return 'received';
  const type = schema.documentTypes.find((t) => t.id === doc.typeId);
  const present = new Set(doc.extracted.filter((f) => (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  const missing = (type?.requiredFields ?? []).filter((r) => !isRequirementMet(present, r));
  if (missing.length) return 'classified';
  if (doc.linkedEntityIds.length === 0) return 'extracted';
  if (doc.issues.some((i) => i.kind === 'conflict')) return 'linked';
  return 'verified';
}

/**
 * Recomputes `issues` from the document's own extracted fields and links.
 * Required-field gaps are always freshly derived (never trusted from a stale
 * `issues` array); an 'unlinked' issue is synthesized for a classified but
 * unattached document when nothing already flagged it — real synced
 * documents (usePostgresSync.ts) never carry one on arrival, and this is
 * what makes Records' health tiles and Review's "Unlinked inbox"/"Needs a
 * person" filters honest for them, not just for the demo fixture (whose own
 * `unlinked` issues, seeded with a bestGuess, are preserved as-is).
 */
export function recomputeIssues(doc: Doc, schema: DomainSchema): Doc {
  const type = schema.documentTypes.find((t) => t.id === doc.typeId);
  const present = new Set(doc.extracted.filter((f) => (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  let kept = doc.issues.filter((i) => i.kind !== 'missing-field' && !(i.kind === 'unlinked' && doc.linkedEntityIds.length > 0));
  const missing = (type?.requiredFields ?? []).filter((r) => !isRequirementMet(present, r)).map((f) => ({ kind: 'missing-field' as const, field: f }));
  if (doc.typeId && doc.linkedEntityIds.length === 0 && !kept.some((i) => i.kind === 'unlinked')) {
    kept = [...kept, { kind: 'unlinked' as const, confidence: 0 }];
  }
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

export const useGraph = create<GraphStore>((set, get) => ({
  schema: { id: 'none', label: '', entityTypes: [], documentTypes: [], fallbackDocumentType: 'other' },
  entities: {},
  docs: {},
  batches: {},
  conflicts: {},
  lastError: null,
  aiVerifying: {},

  seed: (schema, entities, docs, batches, conflicts) =>
    set({
      schema,
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      docs: Object.fromEntries(docs.map((d) => [d.id, d])),
      batches: Object.fromEntries(batches.map((b) => [b.id, b])),
      conflicts: Object.fromEntries(conflicts.map((c) => [c.id, c])),
    }),

  clearLastError: () => set({ lastError: null }),

  correctField: (docId, fieldName, value, by, target) => {
    const before = get().docs[docId];
    if (!before) return;
    const beforeEntities = get().entities;

    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const exists = doc.extracted.some((f) => f.name === fieldName);
      const extracted = exists
        ? doc.extracted.map((f) => (f.name === fieldName ? { ...f, correctedValue: value, correctedBy: by, correctedAt: new Date(), ...(target ? { target } : {}) } : f))
        : [...doc.extracted, { name: fieldName, value, confidence: 1, location: { page: 1, field: fieldName }, correctedValue: value, correctedBy: by, correctedAt: new Date(), ...(target ? { target } : {}) }];
      const preview = exists ? doc.preview : `${doc.preview}\n${fieldName}: ${value}`;
      let next = recomputeIssues({ ...doc, extracted, preview }, s.schema);
      // Mirrors reviewStore.js's nextStageAfterCorrection: a verified document
      // whose facts just changed is not verified against those facts anymore.
      if (next.stage === 'verified') {
        next = { ...next, stage: 'linked', verifiedBy: undefined, verifiedAt: undefined };
      }
      const docs = { ...s.docs, [docId]: next };
      return { docs, entities: applyDocToEntities({ ...s, docs }, next), lastError: null };
    });

    if (!DEMO_MODE) {
      void reviewClient.correctField(docId, fieldName, value, by).catch((err) => {
        set((s) => ({ docs: { ...s.docs, [docId]: before }, entities: beforeEntities, lastError: describeError(err) }));
      });
    }
  },

  classifyDoc: (docId, typeId) => {
    const before = get().docs[docId];
    if (!before) return;

    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const next = recomputeIssues({ ...doc, typeId, stage: 'classified' }, s.schema);
      return { docs: { ...s.docs, [docId]: next }, lastError: null };
    });

    if (!DEMO_MODE) {
      void reviewClient.classifyDocument(docId, typeId).catch((err) => {
        set((s) => ({ docs: { ...s.docs, [docId]: before }, lastError: describeError(err) }));
      });
    }
  },

  linkDoc: (docId, entityId, by) => {
    const before = get().docs[docId];
    if (!before) return;

    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const linkedEntityIds = Array.from(new Set([...doc.linkedEntityIds, entityId]));
      const next = recomputeIssues({ ...doc, linkedEntityIds, linkConfidence: 1 }, s.schema);
      return { docs: { ...s.docs, [docId]: next }, lastError: null };
    });

    if (!DEMO_MODE) {
      void reviewClient.linkDocument(docId, entityId, by).catch((err) => {
        set((s) => ({ docs: { ...s.docs, [docId]: before }, lastError: describeError(err) }));
      });
    }
  },

  approveDoc: (docId, by) => {
    const before = get().docs[docId];
    if (!before) return;
    const beforeEntities = get().entities;
    const target = maxStageFor(before, get().schema);

    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const next: Doc = { ...doc, stage: target };
      if (target === 'verified') {
        next.verifiedBy = by;
        next.verifiedAt = new Date();
      }
      const docs = { ...s.docs, [docId]: next };
      return { docs, entities: applyDocToEntities({ ...s, docs }, next), lastError: null };
    });

    // Only 'verified' has a server-side counterpart: the Postgres pipeline's
    // own stages (received/read/mapped/linked/verified) already reflect
    // classification and linking the moment classifyDoc/linkDoc persist them
    // above; an intermediate core stage like 'classified' or 'extracted' is
    // client-side bookkeeping with no column of its own to write.
    if (!DEMO_MODE && target === 'verified') {
      void reviewClient.verifyDocument(docId, by).catch((err) => {
        set((s) => ({ docs: { ...s.docs, [docId]: before }, entities: beforeEntities, lastError: describeError(err) }));
      });
    }
  },

  resolveConflict: (conflictId, value, by) =>
    set((s) => {
      const c = s.conflicts[conflictId];
      if (!c) return s;
      const conflicts = { ...s.conflicts, [conflictId]: { ...c, resolvedValue: value, resolvedBy: by, resolvedAt: new Date() } };
      // Clear the conflict issue on every doc that raised it; the winning value goes on the entity.
      const docs = { ...s.docs };
      for (const cand of c.candidates) {
        const d = docs[cand.documentId];
        if (d) docs[cand.documentId] = { ...d, issues: d.issues.filter((i) => !(i.kind === 'conflict' && i.conflictId === conflictId)) };
      }
      const ent = s.entities[c.entityId];
      const entities = ent
        ? { ...s.entities, [c.entityId]: { ...ent, fields: { ...ent.fields, [c.field]: coerce(s.schema, ent, c.field, value) } } }
        : s.entities;
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
      return { docs, batches };
    }),

  aiVerifyDoc: async (docId) => {
    if (DEMO_MODE) return false;
    // Single-flight per doc: set BEFORE the first await, so a second call
    // arriving before this one resolves (a double-click racing a re-render)
    // sees the flag already up and bails instead of firing a second request
    // that could resolve out of order and leave the doc in a self-contradictory
    // state (see the caller — ReviewScreen.tsx — for the full reload that
    // replaces this function's old local patch-from-partial-payload).
    if (get().aiVerifying[docId]) return false;
    set((s) => ({ aiVerifying: { ...s.aiVerifying, [docId]: true } }));
    try {
      const { verified } = await reviewClient.aiVerify(docId);
      set({ lastError: null });
      return verified;
    } catch (err) {
      set({ lastError: describeError(err) });
      return false;
    } finally {
      set((s) => {
        if (!(docId in s.aiVerifying)) return s;
        const aiVerifying = { ...s.aiVerifying };
        delete aiVerifying[docId];
        return { aiVerifying };
      });
    }
  },

  reclassifyDocs: async (docIds) => {
    if (DEMO_MODE || !docIds.length) return { changed: 0, remaining: 0 };
    try {
      const { changes, remaining } = await reviewClient.reclassify(docIds);
      set((s) => {
        const docs = { ...s.docs };
        for (const c of changes) {
          const doc = docs[c.documentId];
          if (doc) docs[c.documentId] = recomputeIssues({ ...doc, typeId: c.to }, s.schema);
        }
        return { docs, lastError: null };
      });
      return { changed: changes.length, remaining };
    } catch (err) {
      set({ lastError: describeError(err) });
      return { changed: 0, remaining: 0 };
    }
  },

  removeDoc: (docId) =>
    set((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const docs = { ...s.docs };
      delete docs[docId];
      const batch = s.batches[doc.batchId];
      const batches = batch
        ? { ...s.batches, [doc.batchId]: { ...batch, documentIds: batch.documentIds.filter((id) => id !== docId) } }
        : s.batches;
      return { docs, batches };
    }),

  createBatch: ({ name, source, from, to, by }) => {
    const id = newId('batch');
    set((s) => ({
      batches: { ...s.batches, [id]: { id, name, source, dateRange: { from, to }, createdAt: new Date(), createdBy: by, documentIds: [] } },
    }));
    return id;
  },

  reconcileIntakeDoc: (tempId, updates) =>
    set((s) => {
      const doc = s.docs[tempId];
      if (!doc) return s;
      const newId = updates.id ?? tempId;
      const batch = s.batches[doc.batchId];

      if (newId !== tempId && s.docs[newId]) {
        // The server's real id already names a document in the graph (a
        // duplicate upload, most likely). Keep that copy — it may already
        // carry real pipeline state from Postgres — and just drop the
        // placeholder instead of overwriting it with thinner local data.
        const docs = { ...s.docs };
        delete docs[tempId];
        const batches = batch
          ? { ...s.batches, [doc.batchId]: { ...batch, documentIds: batch.documentIds.filter((id) => id !== tempId) } }
          : s.batches;
        return { docs, batches };
      }

      const merged: Doc = {
        ...doc,
        ...(updates.pages !== undefined ? { pages: updates.pages } : {}),
        ...(updates.stage !== undefined ? { stage: updates.stage } : {}),
        ...(updates.preview !== undefined ? { preview: updates.preview } : {}),
        id: newId,
      };
      const docs = { ...s.docs };
      delete docs[tempId];
      docs[newId] = merged;
      const batches =
        newId !== tempId && batch
          ? { ...s.batches, [doc.batchId]: { ...batch, documentIds: batch.documentIds.map((id) => (id === tempId ? newId : id)) } }
          : s.batches;
      return { docs, batches };
    }),

  upsertDoc: (doc) =>
    set((s) => {
      const next = recomputeIssues(doc, s.schema);
      const docs = { ...s.docs, [next.id]: next };
      const existingBatch = s.batches[next.batchId];
      const batches = existingBatch
        ? existingBatch.documentIds.includes(next.id)
          ? s.batches
          : { ...s.batches, [next.batchId]: { ...existingBatch, documentIds: [...existingBatch.documentIds, next.id] } }
        : {
            ...s.batches,
            [next.batchId]: {
              id: next.batchId,
              name: next.batchId === 'synced' ? 'Ingested documents' : `Batch ${next.batchId.slice(0, 8)}`,
              source: next.source,
              dateRange: { from: next.receivedAt, to: next.receivedAt },
              createdAt: next.receivedAt,
              createdBy: 'system',
              documentIds: [next.id],
            },
          };
      return { docs, batches, entities: applyDocToEntities({ ...s, docs }, next) };
    }),

  receiveDocs: (batchId, files) => {
    const ids: DocumentId[] = [];
    set((s) => {
      const batch = s.batches[batchId];
      if (!batch) return s;
      const docs = { ...s.docs };
      for (const f of files) {
        const id = newId('doc');
        ids.push(id);
        // Dedupe on intake: same filename already in the system → flag, don't double count
        const dup = Object.values(s.docs).find((d) => d.filename === f.filename);
        docs[id] = {
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
        };
      }
      return { docs, batches: { ...s.batches, [batchId]: { ...batch, documentIds: [...batch.documentIds, ...ids] } } };
    });
    return ids;
  },
}));

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
/**
 * Documents named as a candidate in a still-open Conflict record, deduped.
 * `openConflicts` is the source of truth for "is this still open"; this is
 * the one place that turns those records into document rows, so any screen
 * that needs to list or count the *documents* behind an open conflict (the
 * Review queue's "Conflicts" filter, Dashboard's "Conflicts" tile) reads it
 * from here instead of re-deriving its own notion of "conflicted doc" from
 * `doc.issues` — which could silently drift from `graph.conflicts` over time.
 */
export function conflictDocs(g: GraphSnapshot): Doc[] {
  const ids = new Set<DocumentId>();
  for (const c of openConflicts(g)) {
    for (const cand of c.candidates) ids.add(cand.documentId);
  }
  return Object.values(g.docs).filter((d) => ids.has(d.id));
}
export function duplicateDocs(g: GraphSnapshot): Doc[] {
  return Object.values(g.docs).filter((d) => d.issues.some((i) => i.kind === 'duplicate'));
}

// ---------------------------------------------------------------------------
// Fetch-on-demand: a document past usePostgresSync's 500-document sync cap
// ---------------------------------------------------------------------------

const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** api/_lib/extractDocument.js's equipment field keys -> the hvac schema's
 *  camelCase keys. Deliberately duplicated from usePostgresSync.ts's
 *  EQUIPMENT_FIELD_MAP (a private, un-exported const in a hook this worktree
 *  doesn't own) rather than imported — same "small, intentionally-duplicated
 *  copy" convention that file itself already uses for clientNormalizeSurname.
 *  IDEAL FIX for whoever next owns usePostgresSync.ts: export `toDoc` (and
 *  its EQUIPMENT_FIELD_MAP/fileTypeOf/toDateOrNull helpers) so this becomes a
 *  straight import instead of a hand-kept copy. */
const EQUIPMENT_FIELD_MAP: Record<string, string> = {
  serial_number: 'serial',
  model: 'model',
  manufacturer: 'manufacturer',
  equipment_type: 'equipmentType',
  installation_date: 'installDate',
  tonnage: 'tonnage',
  refrigerant: 'refrigerant',
  service_address: 'address',
  customer_name: 'customerName',
  warranty_expires: 'warrantyExpiry',
  installed_by: 'installedByName',
};

function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function fileTypeOfRow(row: { content_type?: string | null; original_filename: string }): Doc['fileType'] {
  const ct = (row.content_type ?? '').toLowerCase();
  const name = row.original_filename.toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|tiff?)$/.test(name)) return 'image';
  if (ct.includes('sheet') || ct.includes('csv') || /\.(xlsx?|xls|csv)$/.test(name)) return 'spreadsheet';
  return 'text';
}

/** One `documents` row, as returned by POST /api/records { action: 'getDocument' }
 *  (api/_lib/recordsStore.js's plain `SELECT * FROM documents WHERE id = $1 AND …`
 *  — no join, no derived fields; that's what the extractions/links/corrections/
 *  completeness fetched alongside it in `ensureDocLoaded` are for). */
interface FetchedDocumentRow {
  id: string;
  batch_id?: string | null;
  original_filename: string;
  document_type?: string | null;
  stage: 'received' | 'read' | 'mapped' | 'linked' | 'verified';
  created_at: unknown;
  content_type?: string | null;
  page_count?: number | null;
  extract_error?: string | null;
  verified_by?: string | null;
  verified_at?: unknown;
  display_name?: string | null;
  uploaded_by?: string | null;
}

interface FetchedExtractionRow {
  id: string;
  document_id: string;
  entity_id: string | null;
  field_key: string;
  value: string | null;
  confidence: number | null;
  unit_index?: number | null;
}

/**
 * Maps one fetched document (+ its extractions/links/corrections/completeness)
 * onto the shape `useGraph` expects — a smaller, standalone twin of
 * usePostgresSync.ts's `toDoc`/`deriveStage` (see the EQUIPMENT_FIELD_MAP
 * comment above for why this isn't a straight import). `maxStageFor` (this
 * module, not duplicated) is what lets a document at backend 'read'/'mapped'
 * with every required field present show as further along than "just past
 * received", same rule the real sync hook applies.
 */
function docFromFetchedRow(
  row: FetchedDocumentRow,
  extractions: FetchedExtractionRow[],
  links: DocumentLink[],
  corrections: Correction[],
  schema: DomainSchema,
  completeness?: DocCompleteness,
): Doc {
  const receivedAt = toDateOrNull(row.created_at) ?? new Date();
  const preview = row.extract_error
    ? `${row.original_filename}\n\nExtraction failed: ${row.extract_error}`
    : row.page_count
      ? `${row.original_filename}\n\n${row.page_count} page(s) read.`
      : `${row.original_filename}\n\nReceived.`;

  const correctionByField = new Map(corrections.map((c) => [c.field_key, c]));
  const linkedFromLinks = links.map((l) => l.entity_id);
  const linkedFromExtractions = extractions.map((x) => x.entity_id).filter((id): id is string => !!id);
  const facts = Object.fromEntries(extractions.filter((x) => x.value != null && x.value !== '').map((x) => [x.field_key, x.value]));
  const typeId = normalizeDocumentType(row.document_type, facts);

  const doc: Doc = {
    id: row.id,
    filename: row.original_filename,
    displayName: row.display_name ?? undefined,
    fileType: fileTypeOfRow(row),
    pages: row.page_count ?? 0,
    batchId: row.batch_id ?? 'synced',
    source: 'drive',
    receivedAt,
    uploadedBy: row.uploaded_by ?? undefined,
    typeId,
    stage: 'received', // placeholder — replaced below
    extracted: extractions.map((x) => {
      const field = EQUIPMENT_FIELD_MAP[x.field_key];
      const correction = correctionByField.get(x.field_key);
      return {
        name: x.field_key,
        value: x.value ?? '',
        confidence: x.confidence ?? 0,
        location: {},
        target: x.entity_id && field ? { entityId: x.entity_id, field } : undefined,
        unitIndex: x.unit_index ?? undefined,
        ...(correction
          ? { correctedValue: correction.corrected_value, correctedBy: correction.corrected_by ?? undefined, correctedAt: toDateOrNull(correction.corrected_at) ?? undefined }
          : {}),
      };
    }),
    linkedEntityIds: [...new Set([...linkedFromExtractions, ...linkedFromLinks])],
    linkConfidence: linkedFromExtractions.length > 0 || linkedFromLinks.length > 0 ? 1 : 0,
    issues: [],
    linkedFromBodyName: links.find((l) => l.linked_by === 'name-in-body')?.entity_id,
    verifiedBy: row.verified_by ?? undefined,
    verifiedAt: toDateOrNull(row.verified_at) ?? undefined,
    completeness,
    preview,
  };

  const withIssues = recomputeIssues(doc, schema);
  const stage: PipelineStage =
    row.stage === 'verified' ? 'verified' : row.stage === 'received' ? 'received' : (() => {
      const ceiling = maxStageFor(withIssues, schema);
      return ceiling === 'verified' ? 'linked' : ceiling;
    })();
  return { ...withIssues, stage };
}

/** In-flight fetches by document id, so a doc rendered by two components at
 *  once (or two rapid clicks) never fires the request twice. */
const fetchesInFlight = new Map<DocumentId, Promise<void>>();

/**
 * Fetch one document's full details from the server and upsert it into the
 * graph — the fetch-on-demand half of the beyond-500-documents fix (see
 * `upsertDoc`'s doc comment). No-op when the doc is already in the graph,
 * when the id isn't a real (synced) document id, or in demo mode (nothing
 * server-side to fetch). Best-effort: a failed fetch leaves the graph as it
 * was — DocumentPreview.tsx's own `if (!doc) return null` is the existing,
 * correct behaviour for "this id truly isn't available".
 */
export async function ensureDocLoaded(docId: DocumentId): Promise<void> {
  if (DEMO_MODE) return;
  if (!DOC_ID_RE.test(docId)) return;
  if (useGraph.getState().docs[docId]) return;

  const existing = fetchesInFlight.get(docId);
  if (existing) return existing;

  const run = (async () => {
    try {
      const [row, extractions, linksRes, correctionsRes] = await Promise.all([
        recordsStore.getDocument(docId) as unknown as Promise<FetchedDocumentRow | null>,
        recordsStore.listExtractionsByDocument(docId).catch(() => []) as unknown as Promise<FetchedExtractionRow[]>,
        reviewClient.listLinks([docId]).catch(() => ({ links: [] as DocumentLink[] })),
        reviewClient.listCorrections([docId]).catch(() => ({ corrections: [] as Correction[] })),
      ]);
      if (!row) return; // wrong tenant, deleted, or not yet synced anywhere

      let completeness: DocCompleteness | undefined;
      try {
        const res = await fetch('/api/document-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ documentIds: [docId] }),
        });
        if (res.ok) {
          const { documents } = (await res.json()) as { documents: { id: string; completeness?: DocCompleteness }[] };
          completeness = documents.find((d) => d.id === docId)?.completeness;
        }
      } catch {
        /* completeness is an enhancement (why-AI-verified), not a precondition */
      }

      // Re-check: a slower rival call (or a real sync finishing) may have
      // already landed this doc while these round trips were in flight.
      if (useGraph.getState().docs[docId]) return;
      const doc = docFromFetchedRow(row, extractions, linksRes.links, correctionsRes.corrections, useGraph.getState().schema, completeness);
      useGraph.getState().upsertDoc(doc);
    } finally {
      fetchesInFlight.delete(docId);
    }
  })();
  fetchesInFlight.set(docId, run);
  return run;
}
