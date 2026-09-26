/**
 * Grid view (round 13, H3) — Hebbia "Matrix" pattern (research #5/#9,
 * claude/R12_RESEARCH.md): rows are documents or equipment units, columns are
 * chosen fields, every cell carries its source document(s) so a person can
 * check "why does it say that" without leaving the grid. Server side:
 * api/_lib/grid/{columns,store,route}.js.
 */

export type GridRowType = 'documents' | 'units';
export type GridColumnKind = 'text' | 'date' | 'money' | 'badge' | 'number';

export interface GridColumnDef {
  key: string;
  label: string;
  kind: GridColumnKind;
}

/** A cell's source is either a document (the common case — extractions
 *  always trace to one) or, for a handful of unit-grid fields that live
 *  directly on a customer/unit record with no backing extraction (e.g. a
 *  hand-entered customer name/address, or a field set without a document),
 *  the record itself. `kind` is omitted on the document variant (existing
 *  server payloads predate this field and never set it) — `isRecordSource`
 *  below is the one place that distinguishes them. */
export type GridCellSource =
  | { kind?: 'document'; documentId: string; page?: number }
  | { kind: 'record'; entityType: 'customer' | 'unit'; recordId: string };

export function isRecordSource(s: GridCellSource): s is { kind: 'record'; entityType: 'customer' | 'unit'; recordId: string } {
  return (s as { kind?: string }).kind === 'record';
}

export interface GridCell {
  value: string | number | null;
  /** Every document or record (0, 1, or several for an aggregate like a
   *  unit's open balance) that backs this value. Empty = "nothing on file",
   *  not a fetch failure — GridTable renders that case with an explicit
   *  "no source" marker rather than leaving it looking the same as a cited
   *  one, so a value with sources: [] is always the honest kind. */
  sources: GridCellSource[];
}

export type GridRowCells = Record<string, GridCell>;

export interface GridRow {
  id: string;
  cells: GridRowCells;
}

/** Whitelisted column ids per row type, in a stable pick-list order —
 *  mirrors api/_lib/grid/columns.js exactly (kept in sync by hand; both are
 *  small, static tables, not derived from anything that changes at runtime). */
export const DOCUMENT_GRID_COLUMNS: GridColumnDef[] = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'documentType', label: 'Type', kind: 'text' },
  { key: 'customerName', label: 'Customer', kind: 'text' },
  { key: 'siteAddress', label: 'Address', kind: 'text' },
  { key: 'serviceDate', label: 'Service date', kind: 'date' },
  { key: 'technician', label: 'Technician', kind: 'text' },
  { key: 'status', label: 'Status', kind: 'badge' },
  { key: 'warrantyStatus', label: 'Warranty status', kind: 'badge' },
  { key: 'warrantyExpiry', label: 'Warranty expiry', kind: 'date' },
  { key: 'amount', label: 'Amount', kind: 'money' },
  { key: 'balance', label: 'Balance due', kind: 'money' },
  { key: 'model', label: 'Model', kind: 'text' },
  { key: 'serial', label: 'Serial', kind: 'text' },
  { key: 'agreement', label: 'Agreement', kind: 'badge' },
];
export const DOCUMENT_GRID_DEFAULT_COLUMNS = ['name', 'documentType', 'customerName', 'serviceDate', 'status', 'amount'];
/** Columns store.js's `documentGridCells` computes server-side; every other
 *  document column's value already lives on the BrowseRow the records
 *  browser fetched. */
export const DOCUMENT_GRID_COMPUTED_COLUMNS = new Set(['model', 'serial', 'agreement']);

export const UNIT_GRID_COLUMNS: GridColumnDef[] = [
  { key: 'serial', label: 'Serial', kind: 'text' },
  { key: 'model', label: 'Model', kind: 'text' },
  { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
  { key: 'equipmentType', label: 'Equipment type', kind: 'text' },
  { key: 'customerName', label: 'Customer', kind: 'text' },
  { key: 'siteAddress', label: 'Address', kind: 'text' },
  { key: 'warrantyStatus', label: 'Warranty status', kind: 'badge' },
  { key: 'warrantyExpiry', label: 'Warranty expiry', kind: 'date' },
  { key: 'lastService', label: 'Last service', kind: 'date' },
  { key: 'technician', label: 'Last technician', kind: 'text' },
  { key: 'balance', label: 'Open balance', kind: 'money' },
  { key: 'openQuestions', label: 'Open questions', kind: 'number' },
];
export const UNIT_GRID_DEFAULT_COLUMNS = ['serial', 'model', 'customerName', 'warrantyStatus', 'lastService', 'balance'];

export const GRID_COLUMNS_BY_ROW_TYPE: Record<GridRowType, GridColumnDef[]> = {
  documents: DOCUMENT_GRID_COLUMNS,
  units: UNIT_GRID_COLUMNS,
};
export const GRID_DEFAULT_COLUMNS_BY_ROW_TYPE: Record<GridRowType, string[]> = {
  documents: DOCUMENT_GRID_DEFAULT_COLUMNS,
  units: UNIT_GRID_DEFAULT_COLUMNS,
};

export type SortDir = 'asc' | 'desc';
export interface GridSort {
  column: string;
  dir: SortDir;
}

const COLUMN_PICKS_KEY = 'dw.grid.columns.v1';

/** Which columns are shown, per row type — a per-viewer convenience
 *  (localStorage), same tier as RecordsBrowser's own view-mode/saved-views
 *  storage; never a precondition for the grid to render (falls back to
 *  that row type's defaults). */
export function loadGridColumnPicks(rowType: GridRowType): string[] {
  try {
    const raw = window.localStorage.getItem(COLUMN_PICKS_KEY);
    if (!raw) return GRID_DEFAULT_COLUMNS_BY_ROW_TYPE[rowType];
    const parsed = JSON.parse(raw) as Partial<Record<GridRowType, string[]>>;
    const picks = parsed[rowType];
    const valid = new Set(GRID_COLUMNS_BY_ROW_TYPE[rowType].map((c) => c.key));
    const filtered = Array.isArray(picks) ? picks.filter((k): k is string => typeof k === 'string' && valid.has(k)) : [];
    return filtered.length ? filtered : GRID_DEFAULT_COLUMNS_BY_ROW_TYPE[rowType];
  } catch {
    return GRID_DEFAULT_COLUMNS_BY_ROW_TYPE[rowType];
  }
}

export function saveGridColumnPicks(rowType: GridRowType, columns: string[]): void {
  try {
    const raw = window.localStorage.getItem(COLUMN_PICKS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<GridRowType, string[]>>) : {};
    parsed[rowType] = columns;
    window.localStorage.setItem(COLUMN_PICKS_KEY, JSON.stringify(parsed));
  } catch {
    /* per-viewer convenience only — losing it changes nothing about correctness */
  }
}
