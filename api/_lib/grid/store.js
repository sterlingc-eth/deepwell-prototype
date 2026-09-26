/**
 * Grid view (round 13, H3) — server side. Two independent queries behind one
 * `gridQuery` entry point, both tenant-scoped (bound `$1 = db.tenantId`,
 * belt-and-braces next to RLS — same convention as recordsStore.js's
 * `getDocument`/`deleteDocument`) and built from parameterized fragments only
 * (no caller string is ever concatenated into SQL — see `normalizeGridColumns`
 * for where an unknown column id is dropped before it gets this far):
 *
 *   'documentCells' — Records Browse already fetched the row (customer,
 *     address, amount, …) and its own filters/paging; this only fills in the
 *     few extra per-document columns Records Browse doesn't carry (model,
 *     serial, agreement), each with its real source document + page via
 *     extractions.source_facet_id -> facets.page_no. Bounded by the caller's
 *     own already-paged document id list (Records Browse's page size), never
 *     a second independent page of its own.
 *
 *   'units' — a full paged/filtered query over `entities` (entity_type =
 *     'equipment'), the "row is a piece of equipment, not a document" half
 *     of the Hebbia Matrix pattern (claude/R12_RESEARCH.md item 4/9). Each
 *     cell's source is the SPECIFIC document that produced that field
 *     (extractions.entity_id + field_key, most recent by created_at) rather
 *     than "the unit" — this is the part a plain per-document grid can't do.
 *
 * No model call anywhere in this file (R11 HARD RULE: Anthropic credits are
 * out) — every value is a straight read or SUM/COUNT over rows another
 * pipeline already wrote.
 */
import {
  DOCUMENT_GRID_FIELD_KEYS, UNIT_GRID_FIELD_KEYS, isValidGridColumn, normalizeGridColumns,
} from './columns.js';
import { financialsTableExists } from '../financials/store.js';
import { decodeBrowseCursor, encodeBrowseCursor, browseFiltersKey, normalizeBrowseFilters, isoPlusDays } from '../recordsStore.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cap on ids accepted in one 'documentCells' call — Records Browse's own
 *  page size never exceeds this (normalizeBrowseFilters clamps `limit` to
 *  200), so a real caller never hits it; it exists so a malformed request
 *  can't turn one call into an unbounded IN-list scan. */
const MAX_DOCUMENT_CELLS_IDS = 500;

function validIds(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(0, MAX_DOCUMENT_CELLS_IDS) : [];
}

/** One cell: `value` plus every document (+ page, when known) or record that
 *  backs it. `sources: []` means "nothing on file for this field at all" —
 *  an honest empty cell, never an invented one. When a value came off a
 *  customer/unit record directly rather than a document extraction, use
 *  `recordSource` below instead of leaving `sources` empty — the client
 *  only treats `[]` as "no source", so an entities.data-backed value with
 *  no record source would render indistinguishable from a cited one. */
const cell = (value, sources = []) => ({ value: value ?? null, sources });

/** A source pointing at a customer or unit record itself, for a field that
 *  lives on `entities.data` with no backing extraction (a hand-entered
 *  value, or one set before extraction provenance existed). */
const recordSource = (entityType, recordId) => (recordId ? [{ kind: 'record', entityType, recordId }] : []);

/**
 * Extra per-document grid columns (model/serial/agreement) for a caller-
 * supplied, already-filtered/paged list of document ids — the 'documents'
 * row type's server half; see this file's own doc comment.
 * @returns {Promise<Record<string, Record<string, {value: unknown, sources: {documentId:string, page?:number}[]}>>>}
 *   documentId -> columnKey -> cell
 */
export async function documentGridCells(db, rawDocumentIds, rawColumns) {
  const documentIds = validIds(rawDocumentIds);
  const columns = normalizeGridColumns('documents', rawColumns).filter((c) => c === 'model' || c === 'serial' || c === 'agreement');
  const out = {};
  for (const id of documentIds) out[id] = {};
  if (!documentIds.length || !columns.length) return out;

  if (columns.includes('agreement')) {
    const { rows } = await db.raw(
      `SELECT id, (document_type = 'maintenance-agreement') AS is_agreement
         FROM documents WHERE tenant_id = $1 AND id = ANY($2)`,
      [db.tenantId, documentIds],
    );
    for (const r of rows) out[r.id].agreement = cell(r.is_agreement ? 'Yes' : null, [{ documentId: r.id }]);
  }

  const fieldColumns = columns.filter((c) => c === 'model' || c === 'serial');
  if (fieldColumns.length) {
    const fieldKeys = fieldColumns.map((c) => DOCUMENT_GRID_FIELD_KEYS[c]);
    const { rows } = await db.raw(
      `SELECT DISTINCT ON (e.document_id, e.field_key)
              e.document_id, e.field_key, e.value, fa.page_no
         FROM extractions e
         LEFT JOIN facets fa ON fa.id = e.source_facet_id
        WHERE e.tenant_id = $1 AND e.document_id = ANY($2) AND e.field_key = ANY($3)
        ORDER BY e.document_id, e.field_key, e.created_at DESC`,
      [db.tenantId, documentIds, fieldKeys],
    );
    const byKey = Object.fromEntries(Object.entries(DOCUMENT_GRID_FIELD_KEYS).map(([col, fk]) => [fk, col]));
    for (const r of rows) {
      const col = byKey[r.field_key];
      if (!col || !out[r.document_id]) continue;
      out[r.document_id][col] = cell(r.value, [{ documentId: r.document_id, ...(r.page_no != null ? { page: r.page_no } : {}) }]);
    }
  }
  // Every requested id gets every requested column, even when nothing was found (an honest empty cell).
  for (const id of documentIds) for (const c of columns) if (!(c in out[id])) out[id][c] = cell(null, []);
  return out;
}

/**
 * Paged/filtered grid rows for the 'units' row type (equipment entities).
 * Accepts a SUBSET of BrowseFilters (customerId, brand, q — the dimensions
 * that make sense for a unit rather than a document); anything else is
 * ignored rather than rejected, same "extra fields are just not applied"
 * tolerance normalizeBrowseFilters already has.
 */
export async function unitGridRows(db, rawFilters, rawColumns, { cursor, limit } = {}) {
  const f = normalizeBrowseFilters(rawFilters ?? {});
  const columns = normalizeGridColumns('units', rawColumns);
  const pageLimit = Number.isFinite(Number(limit)) && Number(limit) >= 1 ? Math.min(Math.trunc(Number(limit)), 200) : 50;

  const filtersKey = browseFiltersKey({ rowType: 'units', columns, customerId: f.customerId, brand: f.brand, q: f.q });
  const offset = decodeBrowseCursor(cursor, filtersKey);

  const where = ["e.tenant_id = $1", "e.entity_type = 'equipment'", 'e.merged_into IS NULL'];
  const vals = [db.tenantId];
  // ::text on both sides: customerId is caller input and may not be a valid
  // uuid at all (a stale link, a typo'd deep-link param) — comparing as text
  // returns "no match" for that instead of a 22P02 invalid-uuid error that
  // would 400 the whole grid over one bad filter value.
  if (f.customerId) { vals.push(f.customerId); where.push(`e.customer_id::text = $${vals.length}`); }
  if (f.brand) { vals.push(f.brand); where.push(`lower(e.data->>'manufacturer') = lower($${vals.length})`); }
  if (f.q) {
    vals.push(`%${f.q.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    where.push(`(lower(e.data->>'model') LIKE $${vals.length} ESCAPE '\\' OR lower(e.data->>'serial_number') LIKE $${vals.length} ESCAPE '\\')`);
  }
  const whereSql = where.join(' AND ');

  const { rows: totalRows } = await db.raw(`SELECT COUNT(*)::int AS ct FROM entities e WHERE ${whereSql}`, vals);
  const total = totalRows[0]?.ct ?? 0;

  const pageVals = [...vals, pageLimit + 1, offset];
  const { rows: page } = await db.raw(
    `SELECT e.id, e.data, e.customer_id, e.updated_at
       FROM entities e WHERE ${whereSql}
       ORDER BY e.updated_at DESC NULLS LAST, e.id
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
    pageVals,
  );
  const hasMore = page.length > pageLimit;
  const unitRows = page.slice(0, pageLimit);
  const unitIds = unitRows.map((r) => r.id);
  const nextCursor = hasMore ? encodeBrowseCursor(offset + pageLimit, filtersKey) : null;

  if (!unitIds.length) return { rowType: 'units', columns, rows: [], total, hasMore: false, nextCursor: null };

  // ---- customer name/address (entities.customer_id -> customer entity) ----
  const customerIds = [...new Set(unitRows.map((r) => r.customer_id).filter(Boolean))];
  const custById = new Map();
  if (customerIds.length) {
    const { rows } = await db.raw(
      `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address
         FROM entities WHERE tenant_id = $1 AND id = ANY($2)`,
      [db.tenantId, customerIds],
    );
    for (const r of rows) custById.set(r.id, r);
  }

  // ---- own-field provenance: most recent extraction per (unit, field) ----
  const neededOwnFields = columns.filter((c) => Object.prototype.hasOwnProperty.call(UNIT_GRID_FIELD_KEYS, c));
  const extByUnit = new Map(); // unitId -> fieldKey -> {value, document_id, page_no}
  if (neededOwnFields.length) {
    const fieldKeys = neededOwnFields.map((c) => UNIT_GRID_FIELD_KEYS[c]);
    const { rows } = await db.raw(
      `SELECT DISTINCT ON (x.entity_id, x.field_key)
              x.entity_id, x.field_key, x.value, x.document_id, fa.page_no
         FROM extractions x LEFT JOIN facets fa ON fa.id = x.source_facet_id
        WHERE x.tenant_id = $1 AND x.entity_id = ANY($2) AND x.field_key = ANY($3)
        ORDER BY x.entity_id, x.field_key, x.created_at DESC`,
      [db.tenantId, unitIds, fieldKeys],
    );
    for (const r of rows) {
      if (!extByUnit.has(r.entity_id)) extByUnit.set(r.entity_id, {});
      extByUnit.get(r.entity_id)[r.field_key] = r;
    }
  }

  // ---- last service + last technician: most recent document linked to this unit ----
  const lastDocByUnit = new Map();
  if (columns.includes('lastService') || columns.includes('technician')) {
    const { rows } = await db.raw(
      `SELECT DISTINCT ON (l.entity_id)
              l.entity_id, d.id AS document_id, d.created_at,
              (SELECT t.value FROM extractions t
                WHERE t.tenant_id = $1 AND t.document_id = d.id AND t.field_key = 'technician_name'
                ORDER BY t.created_at DESC LIMIT 1) AS technician
         FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.tenant_id = $1
        WHERE l.tenant_id = $1 AND l.entity_id = ANY($2)
        ORDER BY l.entity_id, d.created_at DESC`,
      [db.tenantId, unitIds],
    );
    for (const r of rows) lastDocByUnit.set(r.entity_id, r);
  }

  // ---- open balance: SUM(balance_due) over this unit's unpaid/partial linked documents ----
  const balanceByUnit = new Map();
  if (columns.includes('balance') && (await financialsTableExists(db))) {
    const { rows } = await db.raw(
      `SELECT l.entity_id, SUM(df.balance_due) AS balance, array_agg(DISTINCT df.document_id) AS doc_ids
         FROM document_entity_links l
         JOIN document_financials df ON df.document_id = l.document_id AND df.tenant_id = $1
        WHERE l.tenant_id = $1 AND l.entity_id = ANY($2) AND df.status IN ('unpaid', 'partial')
        GROUP BY l.entity_id`,
      [db.tenantId, unitIds],
    );
    for (const r of rows) balanceByUnit.set(r.entity_id, r);
  }

  // ---- open questions: linked documents not yet verified ----
  const openQByUnit = new Map();
  if (columns.includes('openQuestions')) {
    const { rows } = await db.raw(
      `SELECT l.entity_id, array_agg(DISTINCT d.id) AS doc_ids, COUNT(DISTINCT d.id)::int AS ct
         FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.tenant_id = $1
        WHERE l.tenant_id = $1 AND l.entity_id = ANY($2) AND d.stage <> 'verified'
        GROUP BY l.entity_id`,
      [db.tenantId, unitIds],
    );
    for (const r of rows) openQByUnit.set(r.entity_id, r);
  }

  // Same three thresholds as recordsStore.js's WARRANTY_BUCKET_CASE (private
  // to that file), applied in JS since this cell is built from a value
  // already fetched above rather than a fresh SQL projection.
  const today = new Date().toISOString().slice(0, 10);
  const in90 = isoPlusDays(today, 90);
  const bucketOf = (expiry) => {
    if (!expiry) return 'unknown';
    const iso = String(expiry).slice(0, 10);
    if (iso < today) return 'expired';
    if (iso <= in90) return 'expiring';
    return 'active';
  };

  // `entities.data` carries every own-field's CURRENT value directly (same
  // raw keys as UNIT_GRID_FIELD_KEYS — see usePostgresSync.ts's toEntity),
  // written whether or not that value also has an extraction row tracking
  // where it came from (an older row, or one set by hand rather than
  // extracted). `extByUnit` gives real per-field provenance when it has it;
  // when it doesn't, this still shows the entity's own value rather than a
  // blank cell — just with an empty `sources` (an honest "no document to
  // point at" rather than a missing fact that IS on file).
  const ownField = (unitId, data, col) => {
    const fieldKey = UNIT_GRID_FIELD_KEYS[col];
    const ext = extByUnit.get(unitId)?.[fieldKey];
    if (ext) return cell(ext.value, [{ documentId: ext.document_id, ...(ext.page_no != null ? { page: ext.page_no } : {}) }]);
    const value = data[fieldKey] ?? null;
    // No extraction traces this field, but it IS set on the unit's own
    // record (entered by hand, or extracted before provenance existed) —
    // cite the record itself rather than leaving `sources` empty, which the
    // client reserves for "nothing on file at all" (see `cell`'s doc comment).
    return cell(value, value != null ? recordSource('unit', unitId) : []);
  };

  const rows = unitRows.map((u) => {
    const data = u.data ?? {};
    const cust = u.customer_id ? custById.get(u.customer_id) : null;
    const warrantyExt = extByUnit.get(u.id)?.warranty_expires;
    const warrantyExpiry = warrantyExt?.value ?? data.warranty?.expires ?? null;
    const lastDoc = lastDocByUnit.get(u.id);
    const bal = balanceByUnit.get(u.id);
    const openQ = openQByUnit.get(u.id);

    const cells = {};
    for (const col of columns) {
      switch (col) {
        case 'serial': case 'model': case 'manufacturer': case 'equipmentType':
          cells[col] = ownField(u.id, data, col); break;
        case 'warrantyExpiry':
          cells[col] = cell(
            warrantyExpiry,
            warrantyExt
              ? [{ documentId: warrantyExt.document_id, ...(warrantyExt.page_no != null ? { page: warrantyExt.page_no } : {}) }]
              : (warrantyExpiry != null ? recordSource('unit', u.id) : []),
          );
          break;
        case 'warrantyStatus':
          // Always has a value (bucketOf never returns null — 'unknown' is
          // itself the computed answer), so this always has a source: the
          // same document as the expiry when one traced it, otherwise the
          // unit record it was computed from (even a bare 'unknown' is a
          // fact ABOUT that record, not a value with nothing behind it).
          cells[col] = cell(bucketOf(warrantyExpiry), warrantyExt ? [{ documentId: warrantyExt.document_id }] : recordSource('unit', u.id));
          break;
        case 'customerName':
          cells[col] = cell(cust?.name ?? null, cust?.name != null ? recordSource('customer', u.customer_id) : []); break;
        case 'siteAddress': {
          const address = cust?.address ?? data.service_address ?? null;
          const addrSource = cust?.address != null ? recordSource('customer', u.customer_id) : (data.service_address != null ? recordSource('unit', u.id) : []);
          cells[col] = cell(address, addrSource);
          break;
        }
        case 'lastService':
          cells[col] = cell(lastDoc ? new Date(lastDoc.created_at).toISOString().slice(0, 10) : null, lastDoc ? [{ documentId: lastDoc.document_id }] : []);
          break;
        case 'technician':
          cells[col] = cell(lastDoc?.technician ?? null, lastDoc?.technician ? [{ documentId: lastDoc.document_id }] : []);
          break;
        case 'balance':
          cells[col] = cell(bal ? Number(bal.balance) : null, bal ? bal.doc_ids.map((id) => ({ documentId: id })) : []);
          break;
        case 'openQuestions':
          // 0 is a real computed fact (no unverified document links this
          // unit), not "unknown" — cite the unit record so it's still
          // click-through-able even though no single document proves a
          // negative.
          cells[col] = cell(openQ ? openQ.ct : 0, openQ ? openQ.doc_ids.map((id) => ({ documentId: id })) : recordSource('unit', u.id));
          break;
        default:
          cells[col] = cell(null, []);
      }
    }
    return { id: u.id, cells };
  });

  return { rowType: 'units', columns, rows, total, hasMore, nextCursor };
}

/** Top-level dispatcher — see route.js for the HTTP surface. */
export async function gridQuery(db, params = {}) {
  if (params.op === 'documentCells') {
    return { rowType: 'documents', cells: await documentGridCells(db, params.documentIds, params.columns) };
  }
  if (params.op === 'units') {
    return unitGridRows(db, params.filters, params.columns, { cursor: params.cursor, limit: params.limit });
  }
  return { error: 'Unknown grid op' };
}

export { isValidGridColumn };
