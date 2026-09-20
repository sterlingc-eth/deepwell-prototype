/**
 * Loads a signed-in tenant's real documents and entities out of Postgres
 * (via `recordsStoreClient`, i.e. `POST /api/records`) and into the
 * `useGraph` store the whole app reads from.
 *
 * This used to fetch the rows and then only `console.log` them — nothing
 * ever reached the screens, and it was never called from anywhere. It is
 * read-only on purpose: the previous version also tried to write every local
 * graph mutation straight back to Postgres on every render, through shapes
 * that do not match what the API actually stores (`doc as any`, a `stage`
 * enum that does not exist server-side, `entity as any` sent whole instead of
 * `{ data }`). That write path never worked and is not resurrected here —
 * see the module-level report for why. This hook only loads.
 */

import { useEffect, useRef, useState } from 'react';
import { recordsStore } from '../services/recordsStoreClient';
import { reviewClient, type DocumentLink, type Correction } from '../services/reviewClient';
import { authHeader } from '../services/authToken';
import { maxStageFor, recomputeIssues, useGraph } from '../core/entityGraph';
import { hvacSchema } from '../domains/hvac';
import { normalizeDocumentType } from '../domains/hvac/documentTypes';
import type { Batch, Doc, DocCompleteness, Entity, FieldValue, FileType, PipelineStage } from '../core/types';
import type { Entity as ApiEntity } from '../services/postgresRecordsStore';

export type SyncStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PostgresSyncState {
  status: SyncStatus;
  /** Human-readable message from the last failed fetch, e.g. a 401. */
  error: string | null;
  /** True once loaded and the tenant genuinely has nothing ingested yet. */
  isEmpty: boolean;
  /** Re-fetches everything and reseeds the graph, outside the hook's own
   *  loading/error lifecycle. For a caller (DataHealthStrip's "Re-check all
   *  documents with AI") that just drove several server-side mutations whose true resulting
   *  stage/completeness this store can't reconstruct from optimistic local
   *  patches alone — see `loadGraphFromServer` below, which this wraps. */
  refresh: () => Promise<void>;
}

const noopRefresh = async () => {};
const IDLE: PostgresSyncState = { status: 'idle', error: null, isEmpty: false, refresh: noopRefresh };

/**
 * The real `documents` row (see M3-config/01-create-schema.sql +
 * 03-retrieval.sql). The `Document` type exported by
 * `services/postgresRecordsStore.ts` is missing several columns this store
 * has always had (`page_count`, `extract_error`, `extracted_at`,
 * `content_type`) — that file is owned by another agent, so rather than
 * editing it this hook declares the columns it actually reads. Every date
 * column comes back as an ISO string over JSON despite what that type
 * claims; `toDateOrNull` below is what actually parses them.
 */
interface DocumentRow {
  id: string;
  batch_id?: string | null;
  original_filename: string;
  document_type?: string | null;
  stage: 'received' | 'read' | 'mapped' | 'linked' | 'verified';
  created_at: unknown;
  content_type?: string | null;
  page_count?: number | null;
  extract_error?: string | null;
  /** Written by api/_lib/reviewStore.js's verifyDocument (M3-config/08-review.sql). */
  verified_by?: string | null;
  verified_at?: unknown;
}

/** Parses whatever JSON actually sent back (a string, or nothing) into a Date. */
function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function fileTypeOf(row: DocumentRow): FileType {
  const ct = (row.content_type ?? '').toLowerCase();
  const name = row.original_filename.toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|tiff?)$/.test(name)) return 'image';
  if (ct.includes('sheet') || ct.includes('csv') || /\.(xlsx?|xls|csv)$/.test(name)) return 'spreadsheet';
  return 'text';
}

/** One `extractions` row as the bulk action returns it.
 *  `unit_index` is selected by listExtractionsByDocuments (2026-09-20).
 *  (handoffs/REQUESTS_frontend.md asks agent-backend to add it) — declared
 *  optional here so wiring it through below is a no-op today and correct the
 *  moment the column ships. */
interface ExtractionRow {
  id: string;
  document_id: string;
  entity_id: string | null;
  field_key: string;
  value: string | null;
  confidence: number | null;
  unit_index?: number | null;
}

/**
 * Maps one Postgres document row onto the shape `useGraph` expects.
 *
 * `extracted` and `linkedEntityIds` come from the `extractions` table, fetched
 * for every synced document in ONE bulk call (`listExtractionsByDocuments`).
 * They used to be hardcoded empty because fetching them was 500 round trips —
 * and that shortcut cascaded through the whole app: `sourcesFor()` found no
 * sources so EntityScreen rendered no facts, `docsLinkedTo()` found no links
 * so it said "no documents are linked" about the document that created the
 * record, and the warranty packet stayed disabled forever. A contractor
 * uploaded a document, it processed perfectly, and the app showed them an
 * empty record.
 *
 * Two more bulk fetches (also one round trip for the whole sync, same reason)
 * feed in here now that review actions persist (api/review.js):
 *   `links`       — document_entity_links rows a human created with Review's
 *                   "Link" control, unioned with the extraction-derived
 *                   entity ids above (a document can be linked to more than
 *                   the entity its own fields target — a service ticket
 *                   naming a unit is also about the customer at that address).
 *   `corrections` — extractions.corrected_value/by/at for this document's
 *                   fields. Applied OVER the original `value`, same rule
 *                   entityGraph.ts's `correctField` already used locally
 *                   (`f.correctedValue ?? f.value` everywhere a fact is
 *                   read) — the corrected reading is what review answers with.
 */
/**
 * The real stage to show, given what Postgres has and what the graph derives.
 * `STAGE_MAP` alone used to be the whole answer, which is exactly the "read"
 * vs "classified" mismatch the brief calls out: a document at backend
 * 'read'/'mapped' with its type set and every required field present is, by
 * the core pipeline's own rules, already 'extracted' (or 'linked', if it has
 * links) — not merely "one step past received". 'verified' is never
 * upgraded to here; it only ever comes from the backend actually verifying
 * (human or `verified_by: 'ai'`), never inferred client-side.
 */
function deriveStage(row: DocumentRow, doc: Doc): PipelineStage {
  if (row.stage === 'verified') return 'verified';
  if (row.stage === 'received') return 'received';
  const ceiling = maxStageFor(doc, hvacSchema);
  return ceiling === 'verified' ? 'linked' : ceiling;
}

function toDoc(row: DocumentRow, extractions: ExtractionRow[], links: DocumentLink[], corrections: Correction[], completeness?: DocCompleteness): Doc {
  const receivedAt = toDateOrNull(row.created_at) ?? new Date();
  const preview = row.extract_error
    ? `${row.original_filename}\n\nExtraction failed: ${row.extract_error}`
    : row.page_count
      ? `${row.original_filename}\n\n${row.page_count} page(s) read.`
      : `${row.original_filename}\n\nReceived.`;

  const correctionByField = new Map(corrections.map((c) => [c.field_key, c]));
  const linkedFromLinks = links.map((l) => l.entity_id);
  const linkedFromExtractions = extractions.map((x) => x.entity_id).filter((id): id is string => !!id);

  // Postgres's `documents.document_type` column is written raw — legacy ids
  // (warranty/service_ticket/install_record/...) and free text included; only
  // /api/document-status.js normalizes it server-side, and this sync uses
  // /api/records.js's listDocuments, which does not. Normalizing here is what
  // makes typeId always one of the 15 canonical ids (never null/"Unclassified"
  // for a document that has been extracted — legacy/unknown falls to 'other').
  const facts = Object.fromEntries(extractions.filter((x) => x.value != null && x.value !== '').map((x) => [x.field_key, x.value]));
  const typeId = normalizeDocumentType(row.document_type, facts);

  const doc: Doc = {
    id: row.id,
    filename: row.original_filename,
    fileType: fileTypeOf(row),
    pages: row.page_count ?? 0,
    batchId: row.batch_id ?? 'synced',
    // Postgres does not track where a document physically came from — that
    // concept only exists in the HVAC demo's own intake flow. 'drive' reads
    // as "already digital" and is the least misleading of the four options.
    source: 'drive',
    receivedAt,
    typeId,
    stage: 'received', // placeholder — deriveStage below sets the real one
    extracted: extractions.map((x) => {
      const field = EQUIPMENT_FIELD_MAP[x.field_key];
      const correction = correctionByField.get(x.field_key);
      return {
        name: x.field_key,
        value: x.value ?? '',
        confidence: x.confidence ?? 0,
        // `extractions` carries no page number — that lives on `facets`, one
        // join away. An uncited fact is honest; an invented page is not.
        location: {},
        target: x.entity_id && field ? { entityId: x.entity_id, field } : undefined,
        unitIndex: x.unit_index ?? undefined,
        ...(correction
          ? {
              correctedValue: correction.corrected_value,
              correctedBy: correction.corrected_by ?? undefined,
              correctedAt: toDateOrNull(correction.corrected_at) ?? undefined,
            }
          : {}),
      };
    }),
    linkedEntityIds: [...new Set([...linkedFromExtractions, ...linkedFromLinks])],
    linkConfidence: linkedFromExtractions.length > 0 || linkedFromLinks.length > 0 ? 1 : 0,
    issues: [],
    verifiedBy: row.verified_by ?? undefined,
    verifiedAt: toDateOrNull(row.verified_at) ?? undefined,
    // POST /api/document-status's completeness (required fields → present/missing
    // → minConfidence) — this is what Review's "why the AI accepted this" panel
    // reads for an AI-verified doc. Fetched in one more bulk round trip below,
    // same degrade-gracefully treatment as extractions/links/corrections.
    completeness,
    preview,
  };

  // recomputeIssues fills `issues` (missing-field gaps, an unlinked flag) so
  // Records' health tiles and Review's filters are true for a synced
  // document, not just for one built up locally through classifyDoc/linkDoc.
  // deriveStage then reads those same issues/links to place the document at
  // its real reachable stage instead of trusting the backend's raw stage
  // column at face value (see deriveStage's own comment above).
  const withIssues = recomputeIssues(doc, hvacSchema);
  return { ...withIssues, stage: deriveStage(row, withIssues) };
}

/** entities.data keys the real extraction pipeline writes for 'equipment' (api/_lib/extractDocument.js, findOrCreateEquipment) → the hvac schema's field keys. */
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
  // Written by api/_lib/extractDocument.js for install-shaped documents that
  // name a technician (facts.technician) — see its module comment for the
  // one-line addition to findOrCreateEquipment's own field list this still
  // needs (HANDOFF.md) before a real installed_by value ever reaches here.
  installed_by: 'installedByName',
};

/**
 * Maps one Postgres entity row onto the shape `useGraph` expects.
 *
 * Today the real pipeline (`findOrCreateEquipment` in
 * api/_lib/recordsStore.js) only ever creates `entity_type: 'equipment'`
 * rows; 'property' / 'customer' / 'technician' have no server-side writer
 * yet. Equipment's own fields (`data.serial_number`, ...) are renamed to the
 * hvac schema's camelCase keys so `EntityScreen`, `WarrantyStatusBadge`, etc.
 * read them exactly as they read the demo fixture. The warranty itself lives
 * separately, under `data.warranty` (set by `setEquipmentWarranty`), not
 * alongside the flat fields — a row written before that feature existed, or
 * one whose brand/rule is unverified, has no `data.warranty` at all, which is
 * why `expires` is read with `?.` and missing becomes `null`, the same "no
 * warranty on file" state `warrantyStatus()` already renders for the demo.
 * Any other entity type's `data` is passed through as-is rather than
 * dropped, so a manually-inserted row still shows something.
 */
function toEntity(row: ApiEntity): Entity {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const fields: Record<string, FieldValue> = {};

  if (row.entity_type === 'equipment') {
    for (const [rawKey, fieldKey] of Object.entries(EQUIPMENT_FIELD_MAP)) {
      const v = data[rawKey];
      if (v == null || v === '') continue;
      fields[fieldKey] = fieldKey === 'installDate' ? toDateOrNull(v) : String(v);
    }
    const warranty = data.warranty as { expires?: unknown } | undefined;
    fields.warrantyExpiry = toDateOrNull(warranty?.expires);
    // entities.customer_id is a real column (setEquipmentCustomer), not a
    // data key — surface it so screens can walk unit → customer.
    if (row.customer_id) fields.customerId = String(row.customer_id);
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number' || v === null) fields[k] = v;
    }
  }

  return { id: row.id, type: row.entity_type, fields };
}

/** Groups synced docs into one Batch per real `batch_id`, plus a catch-all for documents that were never given one (true of every document ingested through IntakeScreen today — see api/upload-url.js). */
function buildBatches(docs: Doc[]): Batch[] {
  const groups = new Map<string, Doc[]>();
  for (const d of docs) {
    const list = groups.get(d.batchId);
    if (list) list.push(d);
    else groups.set(d.batchId, [d]);
  }
  return Array.from(groups.entries()).map(([batchId, list]) => {
    const times = list.map((d) => d.receivedAt.getTime());
    const latest = new Date(Math.max(...times));
    return {
      id: batchId,
      name: batchId === 'synced' ? 'Ingested documents' : `Batch ${batchId.slice(0, 8)}`,
      source: 'drive',
      dateRange: { from: new Date(Math.min(...times)), to: latest },
      createdAt: latest,
      createdBy: 'system',
      documentIds: list.map((d) => d.id),
    };
  });
}

/**
 * One full fetch-and-reseed pass, outside any hook lifecycle. `usePostgresSync`
 * runs this on mount/enable; `DataHealthStrip`'s "Re-check all documents with
 * AI" also calls it directly once its server-side batch actions finish, because those
 * actions' own optimistic local patches (typeId, verifiedBy) can't reconstruct
 * the real post-action `stage` the way a fresh read of `documents.stage` +
 * `maxStageFor` can — that gap is exactly why the health tiles used to need a
 * manual reload to catch up.
 *
 * @param tenantKey Handed to `recordsStore.connect()` for parity with the
 *   hook's effect; the server derives the real tenant from the verified Clerk
 *   token regardless of what is sent here.
 * @returns whether the tenant genuinely has nothing ingested yet.
 */
export async function loadGraphFromServer(tenantKey = ''): Promise<{ isEmpty: boolean }> {
  await recordsStore.connect(tenantKey);
  const [docRows, entityRows] = await Promise.all([
    recordsStore.listDocuments() as unknown as Promise<DocumentRow[]>,
    recordsStore.listEntities(),
  ]);

  // Four more round trips for every document's fields, links, corrections and
  // AI-verification completeness — not one per document each. Failure in any
  // one of them degrades to the old behaviour (documents missing that one
  // enhancement) rather than failing the whole sync.
  const documentIds = docRows.map((r) => r.id);
  const byDoc = new Map<string, ExtractionRow[]>();
  try {
    const rows = (await recordsStore.listExtractionsByDocuments(documentIds)) as unknown as ExtractionRow[];
    for (const x of rows) {
      const list = byDoc.get(x.document_id);
      if (list) list.push(x);
      else byDoc.set(x.document_id, [x]);
    }
  } catch {
    /* fields are an enhancement to the sync, not a precondition of it */
  }

  const linksByDoc = new Map<string, DocumentLink[]>();
  try {
    const { links } = await reviewClient.listLinks(documentIds);
    for (const l of links) {
      const list = linksByDoc.get(l.document_id);
      if (list) list.push(l);
      else linksByDoc.set(l.document_id, [l]);
    }
  } catch {
    /* manual links are an enhancement to the sync, not a precondition of it */
  }

  const correctionsByDoc = new Map<string, Correction[]>();
  try {
    const { corrections } = await reviewClient.listCorrections(documentIds);
    for (const c of corrections) {
      const list = correctionsByDoc.get(c.document_id);
      if (list) list.push(c);
      else correctionsByDoc.set(c.document_id, [c]);
    }
  } catch {
    /* corrections are an enhancement to the sync, not a precondition of it */
  }

  // POST /api/document-status's completeness ({required, present, missing,
  // minConfidence}) — what Review's AI-verified panel shows as "why the AI
  // accepted this". Capped at 100 ids per call server-side, so this chunks the
  // same way listCorrections/listLinks do internally.
  const completenessByDoc = new Map<string, DocCompleteness>();
  try {
    for (let i = 0; i < documentIds.length; i += 100) {
      const batch = documentIds.slice(i, i + 100);
      if (!batch.length) continue;
      const res = await fetch('/api/document-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ documentIds: batch }),
      });
      if (!res.ok) continue;
      const { documents } = (await res.json()) as { documents: { id: string; completeness?: DocCompleteness }[] };
      for (const d of documents) {
        if (d.completeness) completenessByDoc.set(d.id, d.completeness);
      }
    }
  } catch {
    /* completeness is an enhancement (why-AI-verified) to the sync, not a precondition of it */
  }

  const docs = docRows.map((r) =>
    toDoc(r, byDoc.get(r.id) ?? [], linksByDoc.get(r.id) ?? [], correctionsByDoc.get(r.id) ?? [], completenessByDoc.get(r.id))
  );
  const entities = entityRows.map(toEntity);
  useGraph.getState().seed(hvacSchema, entities, docs, buildBatches(docs), []);

  return { isEmpty: docs.length === 0 && entities.length === 0 };
}

/**
 * @param enabled Only fetches while true — pass `isLoaded && isSignedIn`
 *   (and `false` outright in demo mode) so this never fires while signed out
 *   or races the fixture bootstrap. Flipping it fires a fresh load; flipping
 *   it off resets to `idle` and abandons any fetch in flight so a quick
 *   sign-out/sign-in cannot let a stale response land after the new one.
 * @param tenantKey Just an effect dependency and what gets handed to
 *   `recordsStore.connect()` — the server derives the real tenant from the
 *   verified Clerk token regardless of what is sent here.
 */
export function usePostgresSync(enabled: boolean, tenantKey: string | null): PostgresSyncState {
  const [state, setState] = useState<PostgresSyncState>(IDLE);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    const id = ++requestId.current;
    let cancelled = false;

    const run = async () => {
      setState((s) => ({ status: 'loading', error: null, isEmpty: false, refresh: s.refresh }));
      try {
        const { isEmpty } = await loadGraphFromServer(tenantKey ?? '');
        if (cancelled || requestId.current !== id) return;
        setState({ status: 'ready', error: null, isEmpty, refresh: run });
      } catch (err) {
        if (cancelled || requestId.current !== id) return;
        // A 401 (session resolved by Clerk client-side but rejected by the
        // API — an expired token, a tenant the server cannot resolve)
        // reaches here as a normal Error via recordsStoreClient's `.call()`,
        // same as a network failure. Surfacing it as `status: 'error'` rather
        // than leaving `isEmpty` true is the whole point: a denied request
        // must not render the same as a real, empty tenant.
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err), isEmpty: false, refresh: run });
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [enabled, tenantKey]);

  return state;
}
