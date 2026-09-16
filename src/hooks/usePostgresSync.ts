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
import { useGraph } from '../core/entityGraph';
import { hvacSchema } from '../domains/hvac';
import type { Batch, Doc, Entity, FieldValue, FileType, PipelineStage } from '../core/types';
import type { Entity as ApiEntity } from '../services/postgresRecordsStore';

export type SyncStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PostgresSyncState {
  status: SyncStatus;
  /** Human-readable message from the last failed fetch, e.g. a 401. */
  error: string | null;
  /** True once loaded and the tenant genuinely has nothing ingested yet. */
  isEmpty: boolean;
}

const IDLE: PostgresSyncState = { status: 'idle', error: null, isEmpty: false };

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
}

/**
 * Postgres pipeline stages, in the order the browser polls for
 * (`src/services/ingestClient.ts`'s STAGES), lined up against the core
 * pipeline's own five stages (`PIPELINE_STAGES` in core/types.ts). Both are
 * five-stage, received-to-verified pipelines that only ever move forward;
 * this is a positional mapping between them, not a semantic one — Postgres's
 * 'read' (text pulled out, fields not yet mapped) is not the same idea as
 * the core's 'classified' (a document type assigned, fields not yet
 * extracted), but it sits in the same slot, and nothing downstream treats
 * 'classified' as meaning more than "one step past received".
 */
const STAGE_MAP: Record<DocumentRow['stage'], PipelineStage> = {
  received: 'received',
  read: 'classified',
  mapped: 'extracted',
  linked: 'linked',
  verified: 'verified',
};

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

/**
 * Maps one Postgres document row onto the shape `useGraph` expects.
 *
 * Deliberately left empty for now: `extracted` (per-field extractions) and
 * `linkedEntityIds` (which entity this document is about). Both live in the
 * `extractions` table, keyed by document, not on the document row itself —
 * loading them would mean a second query per document (or a join the
 * `listDocuments` action does not do), and at "500 documents at once" that is
 * 500 extra round trips for a hook whose job today is making real documents
 * show up at all. A document synced this way is honestly a step behind a
 * freshly-reviewed one: it will show its real filename, type and pipeline
 * stage, but not yet its extracted fields or which entity it is linked to.
 * Left for a follow-up once there is a bulk `listExtractionsByDocuments`.
 */
function toDoc(row: DocumentRow): Doc {
  const stage = STAGE_MAP[row.stage] ?? 'received';
  const receivedAt = toDateOrNull(row.created_at) ?? new Date();
  const preview = row.extract_error
    ? `${row.original_filename}\n\nExtraction failed: ${row.extract_error}`
    : row.page_count
      ? `${row.original_filename}\n\n${row.page_count} page(s) read.`
      : `${row.original_filename}\n\nReceived.`;

  return {
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
    typeId: row.document_type ?? null,
    stage,
    extracted: [],
    linkedEntityIds: [],
    linkConfidence: 0,
    issues: [],
    preview,
  };
}

/** entities.data keys the real extraction pipeline writes for 'equipment' (api/_lib/extractDocument.js, findOrCreateEquipment) → the hvac schema's field keys. */
const EQUIPMENT_FIELD_MAP: Record<string, string> = {
  serial_number: 'serial',
  model: 'model',
  manufacturer: 'manufacturer',
  equipment_type: 'equipmentType',
  installation_date: 'installDate',
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
  const seed = useGraph((s) => s.seed);
  const [state, setState] = useState<PostgresSyncState>(IDLE);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    const id = ++requestId.current;
    let cancelled = false;
    setState({ status: 'loading', error: null, isEmpty: false });

    void (async () => {
      try {
        await recordsStore.connect(tenantKey ?? '');
        const [docRows, entityRows] = await Promise.all([
          recordsStore.listDocuments() as unknown as Promise<DocumentRow[]>,
          recordsStore.listEntities(),
        ]);
        if (cancelled || requestId.current !== id) return;

        const docs = docRows.map(toDoc);
        const entities = entityRows.map(toEntity);
        seed(hvacSchema, entities, docs, buildBatches(docs), []);

        setState({ status: 'ready', error: null, isEmpty: docs.length === 0 && entities.length === 0 });
      } catch (err) {
        if (cancelled || requestId.current !== id) return;
        // A 401 (session resolved by Clerk client-side but rejected by the
        // API — an expired token, a tenant the server cannot resolve)
        // reaches here as a normal Error via recordsStoreClient's `.call()`,
        // same as a network failure. Surfacing it as `status: 'error'` rather
        // than leaving `isEmpty` true is the whole point: a denied request
        // must not render the same as a real, empty tenant.
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err), isEmpty: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, tenantKey, seed]);

  return state;
}
