/**
 * DB-backed half of the citation contract (see records.js). Every function takes the tenant-scoped
 * `db` of the SAME withTenant transaction the producer already holds, so it can only ever see the
 * calling tenant's rows (RLS + the explicit tenant predicate below, belt and braces).
 *
 *   enrichCitations(db, data)     make sure `data` carries records/basis: derive them from the fact
 *                                 entityIds and cited sources it already has, and label them from
 *                                 the tenant's own rows.
 *   withCitations(db, promise)    convenience wrapper for a producer call.
 *   documentRecordsFor / customerRecordsFor   labelled records for a list of ids.
 *   honestZeroCitations           "Searched 6 documents for X - none mention Y".
 *   metaCount / metaListDocuments ...   the meta-router's counts, from the SAME query as the records.
 */
import { documentTypeLabel } from '../documentTypes.js';
import {
  MAX_RECORDS, makeRecord, customerRecord, unitRecord, documentRecord, attachCitations, deriveRecords, defaultBasis,
} from './records.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids) => [...new Set((ids ?? []).filter((v) => typeof v === 'string' && UUID_RE.test(v)))].slice(0, MAX_RECORDS);

const dateLabel = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
};

/** id -> {filename, type, date} for the tenant's own documents. */
export async function labelDocuments(db, ids) {
  const list = uuids(ids);
  if (!list.length) return new Map();
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename, d.document_type, d.created_at,
            (SELECT x.value FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
              ORDER BY x.created_at DESC LIMIT 1) AS service_date
       FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL}`,
    [list]
  );
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
}

/** id -> entity row (customer or equipment) for the tenant's own entities. */
export async function labelEntities(db, ids) {
  const list = uuids(ids);
  if (!list.length) return new Map();
  const { rows } = await db.raw(
    `SELECT id, entity_type, customer_id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
            data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model,
            data->>'serial_number' AS serial_number
       FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [list]
  );
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
}

export async function documentRecordsFor(db, ids, { group } = {}) {
  let labels = new Map();
  try {
    labels = await labelDocuments(db, ids);
  } catch (err) {
    console.error('Citation labels unavailable, using bare document ids:', err?.message);
  }
  return uuids(ids).map((id) => {
    const d = labels.get(id.toLowerCase());
    if (!d) return documentRecord({ id }, { group }); // the id came from a tenant-scoped query; label is best-effort
    return documentRecord(d, {
      label: `${documentTypeLabel(d.document_type)} · ${d.original_filename ?? id}`,
      sublabel: dateLabel(d.service_date) ?? dateLabel(d.created_at) ?? undefined, group,
    });
  }).filter(Boolean);
}

export async function customerRecordsFor(db, ids, { group } = {}) {
  const ents = await labelEntities(db, ids);
  return uuids(ids).map((id) => {
    const e = ents.get(id.toLowerCase());
    if (!e) return null;
    if (e.entity_type === 'equipment') return unitRecord(e, { group });
    return customerRecord(e, { group });
  }).filter(Boolean);
}

/**
 * Give `data` its records/basis when the producer did not (idempotent). Facts' entityIds and cited
 * sources are the raw material; the tenant's own rows supply real labels and the real type.
 */
export async function enrichCitations(db, data, { basis } = {}) {
  if (!data || typeof data !== 'object' || (data.kind !== 'answer' && data.kind !== 'no-answer')) return data;
  if (Array.isArray(data.records)) {
    if (basis && !data.basis) data.basis = basis;
    return data;
  }
  const derived = deriveRecords(data);
  const entityIds = derived.filter((r) => r.type === 'customer').map((r) => r.id);
  const docIds = derived.filter((r) => r.type === 'document').map((r) => r.id);
  const [ents, docs] = await Promise.all([labelEntities(db, entityIds), labelDocuments(db, docIds)]);
  const records = [];
  for (const r of derived) {
    if (r.type === 'customer') {
      const e = ents.get(String(r.id).toLowerCase());
      if (!e) continue; // not one of this tenant's rows: never cite it
      records.push(e.entity_type === 'equipment' ? unitRecord(e) : customerRecord(e));
    } else {
      const d = docs.get(String(r.id).toLowerCase());
      const label = d ? `${documentTypeLabel(d.document_type)} · ${d.original_filename ?? r.id}` : r.label || 'Document';
      records.push(documentRecord(d ?? { id: r.id }, { label, sublabel: r.sublabel ?? (d ? dateLabel(d.service_date) ?? dateLabel(d.created_at) ?? undefined : undefined), page: r.page }));
    }
  }
  const made = records.filter(Boolean);
  attachCitations(data, { records: made, total: made.length, basis: basis ?? defaultBasis(data, made, made.length) });
  return data;
}

/** Await a producer's answer and enrich it inside the same transaction. Never throws. */
export async function withCitations(db, produced, opts) {
  const data = await produced;
  if (!data || typeof data !== 'object') return data;
  try {
    return await enrichCitations(db, data, opts);
  } catch (err) {
    console.error('Citation enrichment failed, answer sent with derived citations only:', err?.message);
    return data;
  }
}

/* ------------------------------------------------------------------ honest zero */

/**
 * Citations for "nothing on file about <topic> for <customer>": the documents that WERE searched.
 * `ctx` is docLookup.js's resolveHonestZeroContext output ({name, address, topic, row}).
 */
export async function honestZeroCitations(db, ctx, { documentIdsFor }) {
  const row = ctx?.row;
  if (!row?.id) return null;
  const ids = await documentIdsFor(db, row);
  const searched = await documentRecordsFor(db, ids);
  const who = ctx.name || 'this customer';
  const topic = ctx.topic && ctx.topic.length ? ctx.topic : null;
  const basis = ids.length
    ? `Searched ${ids.length} document${ids.length === 1 ? '' : 's'} on file for ${who} — none mention ${topic ?? 'that'}.`
    : `No documents are on file for ${who}, so there was nothing to search for ${topic ?? 'that'}.`;
  const records = searched.length ? searched : [customerRecord({ id: row.id, customer_name: row.customer_name, service_address: row.service_address })].filter(Boolean);
  return { records, total: ids.length || records.length, basis, kind: searched.length ? 'searched' : 'basis' };
}

/** Generic no-answer: how much of the library was searched. One cheap count. */
export async function searchedLibraryBasis(db) {
  const { rows } = await db.raw(`SELECT COUNT(*)::int AS n FROM documents WHERE ${TENANT_SQL}`, []);
  const n = rows[0]?.n ?? 0;
  return n
    ? `Searched the text and extracted fields of all ${n} document${n === 1 ? '' : 's'} in your library; nothing matched.`
    : 'Your library has no documents yet, so there was nothing to search.';
}

/* ------------------------------------------------------------------ meta-router (counts / lists) */

const META = {
  documents: { sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at, COUNT(*) OVER()::int AS total FROM documents d WHERE d.${TENANT_SQL} ORDER BY d.created_at DESC LIMIT ${MAX_RECORDS}`, kind: 'document', basis: 'Counted every document in your library.' },
  invoices: { sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at, COUNT(*) OVER()::int AS total FROM documents d WHERE d.document_type = 'invoice' AND d.${TENANT_SQL} ORDER BY d.created_at DESC LIMIT ${MAX_RECORDS}`, kind: 'invoice', basis: 'Counted documents classified as invoices.' },
  warranties: { sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at, COUNT(*) OVER()::int AS total FROM documents d WHERE d.document_type IN ('warranty-registration','warranty') AND d.${TENANT_SQL} ORDER BY d.created_at DESC LIMIT ${MAX_RECORDS}`, kind: 'document', basis: 'Counted documents classified as warranty registrations.' },
  verified: { sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at, COUNT(*) OVER()::int AS total FROM documents d WHERE d.stage = 'verified' AND d.${TENANT_SQL} ORDER BY d.created_at DESC LIMIT ${MAX_RECORDS}`, kind: 'document', basis: 'Counted documents a person has verified.' },
  unverified: { sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at, COUNT(*) OVER()::int AS total FROM documents d WHERE d.stage <> 'verified' AND d.${TENANT_SQL} ORDER BY d.created_at DESC LIMIT ${MAX_RECORDS}`, kind: 'document', basis: 'Counted documents that have not been verified yet.' },
  customers: { sql: `SELECT e.id, e.data->>'customer_name' AS customer_name, e.data->>'service_address' AS service_address, COUNT(*) OVER()::int AS total FROM entities e WHERE e.entity_type = 'customer' AND e.${TENANT_SQL} ORDER BY e.updated_at DESC LIMIT ${MAX_RECORDS}`, kind: 'customer', basis: 'Counted customer records.' },
  equipment: { sql: `SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model, e.data->>'serial_number' AS serial_number, COUNT(*) OVER()::int AS total FROM entities e WHERE e.entity_type = 'equipment' AND e.${TENANT_SQL} ORDER BY e.updated_at DESC LIMIT ${MAX_RECORDS}`, kind: 'unit', basis: 'Counted pieces of equipment on file.' },
};

/** Row -> record for one META kind. */
function metaRecord(kind, r, group) {
  if (kind === 'customer') return customerRecord(r, { group });
  if (kind === 'unit') return unitRecord(r, { group });
  return documentRecord(r, {
    type: kind === 'invoice' ? 'invoice' : undefined,
    label: `${documentTypeLabel(r.document_type)} · ${r.original_filename ?? r.id}`, sublabel: dateLabel(r.created_at) ?? undefined, group,
  });
}

/**
 * One query gives BOTH the number and the rows behind it (window COUNT(*)), so they can never
 * disagree. Returns {n, citations:{records,total,basis,claimedCount}}.
 */
export async function metaCount(db, target) {
  const spec = META[target];
  if (!spec) return null;
  const { rows } = await db.raw(spec.sql, []);
  const n = rows[0]?.total ?? 0;
  return {
    n,
    citations: { records: rows.map((r) => metaRecord(spec.kind, r)), total: n, basis: spec.basis, claimedCount: n },
  };
}

/** Records for a "list documents / list customers" meta answer, from the same rows as the list. */
export function metaListCitations(target, rows, total) {
  const spec = META[target] ?? META.documents;
  return {
    records: rows.map((r) => metaRecord(spec.kind, r)),
    total,
    basis: target === 'customers' ? 'Listed customer records, most recently updated first.' : 'Listed documents, newest upload first.',
    claimedCount: total,
  };
}

/** Breakdown of documents by type: same rows, records carry the type as their group key. */
export async function metaDocumentTypes(db) {
  const { rows } = await db.raw(
    `SELECT document_type, COUNT(*)::int AS n,
            (array_agg(jsonb_build_object('id', id, 'filename', original_filename, 'created_at', created_at) ORDER BY created_at DESC))[1:${MAX_RECORDS}] AS docs
       FROM documents WHERE ${TENANT_SQL} GROUP BY document_type ORDER BY n DESC`,
    []
  );
  const records = [];
  let total = 0;
  for (const g of rows) {
    total += g.n;
    const key = documentTypeLabel(g.document_type);
    for (const d of Array.isArray(g.docs) ? g.docs : []) {
      records.push(documentRecord({ id: d.id, document_type: g.document_type }, {
        label: `${key} · ${d.filename ?? d.id}`, sublabel: dateLabel(d.created_at) ?? undefined, group: key,
      }));
    }
  }
  return { rows, citations: { records, total, basis: 'Grouped every document in your library by its classified type.', claimedCount: total } };
}

export { makeRecord };
