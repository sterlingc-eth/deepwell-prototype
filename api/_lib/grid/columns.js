/**
 * Grid view (round 13, H3) — Hebbia "Matrix" pattern (research #5/#9,
 * claude/R12_RESEARCH.md): rows are documents or equipment units, columns are
 * chosen fields pulled from extractions/financials/relations, every cell
 * carries its source document(s) (+ page, when known) for citation and
 * click-through. Deterministic — no model call, ever (R11 HARD RULE:
 * Anthropic credits are out) — every column here is a plain SQL projection
 * or aggregate over data another pipeline already extracted.
 *
 * WHITELISTED COLUMN KEYS ONLY. `store.js`'s gridQuery rejects any column id
 * not listed here (via `isValidGridColumn`) before it ever reaches a query —
 * a caller can never smuggle an arbitrary identifier into SQL through the
 * columns list.
 *
 * `kind` drives client-side formatting/sorting only (GridView.tsx) — it is
 * never interpolated into SQL.
 */

/** Columns whose VALUE the client already has from Records Browse's own
 *  `browseDocuments` (BrowseRow — src/components/records/types.ts) — the
 *  grid's "documents" row type reuses that live, already-filtered/paged list
 *  (see useRecordsBrowse.ts) rather than re-querying it, so these need no
 *  server work at all. Listed here anyway so they're real, pickable grid
 *  columns and so `isValidGridColumn` accepts them. */
export const DOCUMENT_GRID_BROWSE_COLUMNS = {
  name: { label: 'Name', kind: 'text' },
  documentType: { label: 'Type', kind: 'text' },
  customerName: { label: 'Customer', kind: 'text' },
  siteAddress: { label: 'Address', kind: 'text' },
  serviceDate: { label: 'Service date', kind: 'date' },
  technician: { label: 'Technician', kind: 'text' },
  status: { label: 'Status', kind: 'badge' },
  warrantyStatus: { label: 'Warranty status', kind: 'badge' },
  warrantyExpiry: { label: 'Warranty expiry', kind: 'date' },
  amount: { label: 'Amount', kind: 'money' },
  balance: { label: 'Balance due', kind: 'money' },
};

/** Columns the grid API DOES compute server-side for a "documents" row —
 *  extra per-document facts not already in a BrowseRow, each with real
 *  per-field provenance (extractions.source_facet_id -> facets.page_no). */
export const DOCUMENT_GRID_COMPUTED_COLUMNS = {
  model: { label: 'Model', kind: 'text' },
  serial: { label: 'Serial', kind: 'text' },
  agreement: { label: 'Agreement', kind: 'badge' },
};

export const DOCUMENT_GRID_COLUMNS = { ...DOCUMENT_GRID_BROWSE_COLUMNS, ...DOCUMENT_GRID_COMPUTED_COLUMNS };
export const DOCUMENT_GRID_DEFAULT_COLUMNS = ['name', 'documentType', 'customerName', 'serviceDate', 'status', 'amount'];

/** field_key values in `extractions` that back the computed document columns
 *  above — never user input, only ever bound as a parameter value. */
export const DOCUMENT_GRID_FIELD_KEYS = { model: 'model', serial: 'serial_number' };

export const UNIT_GRID_COLUMNS = {
  serial: { label: 'Serial', kind: 'text' },
  model: { label: 'Model', kind: 'text' },
  manufacturer: { label: 'Manufacturer', kind: 'text' },
  equipmentType: { label: 'Equipment type', kind: 'text' },
  customerName: { label: 'Customer', kind: 'text' },
  siteAddress: { label: 'Address', kind: 'text' },
  warrantyStatus: { label: 'Warranty status', kind: 'badge' },
  warrantyExpiry: { label: 'Warranty expiry', kind: 'date' },
  lastService: { label: 'Last service', kind: 'date' },
  technician: { label: 'Last technician', kind: 'text' },
  balance: { label: 'Open balance', kind: 'money' },
  openQuestions: { label: 'Open questions', kind: 'number' },
};
export const UNIT_GRID_DEFAULT_COLUMNS = ['serial', 'model', 'customerName', 'warrantyStatus', 'lastService', 'balance'];

/** entities.data / extractions.field_key keys that back the "own-field"
 *  unit columns (the ones with real per-field provenance via `extractions`,
 *  same EQUIPMENT_FIELD_MAP the frontend keeps at usePostgresSync.ts). */
export const UNIT_GRID_FIELD_KEYS = {
  serial: 'serial_number',
  model: 'model',
  manufacturer: 'manufacturer',
  equipmentType: 'equipment_type',
  warrantyExpiry: 'warranty_expires',
};

export const GRID_ROW_TYPES = ['documents', 'units'];
export const GRID_COLUMNS_BY_ROW_TYPE = { documents: DOCUMENT_GRID_COLUMNS, units: UNIT_GRID_COLUMNS };
export const GRID_DEFAULT_COLUMNS_BY_ROW_TYPE = { documents: DOCUMENT_GRID_DEFAULT_COLUMNS, units: UNIT_GRID_DEFAULT_COLUMNS };

export function isValidGridRowType(rowType) {
  return GRID_ROW_TYPES.includes(rowType);
}

export function isValidGridColumn(rowType, key) {
  return Object.prototype.hasOwnProperty.call(GRID_COLUMNS_BY_ROW_TYPE[rowType] ?? {}, key);
}

/** Filters and whitelists a caller-supplied column list: unknown ids are
 *  dropped (never a crash, never passed through to SQL), duplicates removed,
 *  and an empty/all-invalid result falls back to that row type's defaults —
 *  a grid is never rendered with zero columns. Capped at 20 (a person picks
 *  columns to read, not the whole schema). */
export function normalizeGridColumns(rowType, rawColumns) {
  const list = Array.isArray(rawColumns) ? rawColumns : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (typeof c !== 'string') continue;
    if (!isValidGridColumn(rowType, c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= 20) break;
  }
  return out.length ? out : [...(GRID_DEFAULT_COLUMNS_BY_ROW_TYPE[rowType] ?? [])];
}
