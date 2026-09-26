import { useEffect, useMemo, useState } from 'react';
import { Columns3, Download, Loader2 } from 'lucide-react';
import { DocumentPreview } from '../DocumentPreview';
import { useAppStore } from '../../store/appStore';
import { useRecordsBrowse } from '../records/useRecordsBrowse';
import type { BrowseRow } from '../records/types';
import { gridClient } from './gridClient';
import { downloadGridCsv } from './csv';
import { GridTable } from './GridTable';
import { sortGridRows } from './sort';
import {
  DOCUMENT_GRID_COLUMNS, DOCUMENT_GRID_COMPUTED_COLUMNS, GRID_COLUMNS_BY_ROW_TYPE, UNIT_GRID_COLUMNS,
  isRecordSource, loadGridColumnPicks, saveGridColumnPicks,
  type GridCellSource, type GridColumnDef, type GridRow, type GridRowType, type GridSort,
} from './types';
import { useGridUnits } from './useGridUnits';

/** Grid column key -> the BrowseRow field it reads (src/components/records/types.ts) —
 *  every one of these columns is a fact about the row's OWN document, so its
 *  source is just that document, page unknown (Records Browse doesn't carry
 *  one — see the module doc comment in api/_lib/grid/store.js). Kept beside
 *  DOCUMENT_GRID_COMPUTED_COLUMNS in types.ts: together the two lists cover
 *  every entry in DOCUMENT_GRID_COLUMNS exactly once. */
const BROWSE_FIELD_FOR_COLUMN: Record<string, keyof BrowseRow> = {
  documentType: 'documentType',
  customerName: 'customerName',
  siteAddress: 'siteAddress',
  serviceDate: 'serviceDate',
  technician: 'technician',
  status: 'stageBucket',
  warrantyStatus: 'warrantyBucket',
  warrantyExpiry: 'warrantyExpiry',
  amount: 'amount',
  balance: 'balanceDue',
};

function browseRowCell(row: BrowseRow, key: string): { value: string | number | null; sources: { documentId: string }[] } {
  const field = BROWSE_FIELD_FOR_COLUMN[key];
  const value = key === 'name' ? (row.displayName?.trim() || row.filename) : field ? ((row[field] as string | number | null | undefined) ?? null) : null;
  return { value: value ?? null, sources: value != null ? [{ documentId: row.id }] : [] };
}

function DocumentsGrid({ columns, onOpenSource, sort, onSort }: {
  columns: GridColumnDef[]; sort: GridSort | null; onSort: (c: string) => void; onOpenSource: (s: GridCellSource) => void;
}) {
  // Reads the SAME URL-persisted filters as the Documents tab (see
  // useRecordsBrowse.ts's filtersFromUrl) — this is what makes the grid's
  // rows "documents (current filters from the records browser)" without
  // needing shared React state between the two tabs.
  const b = useRecordsBrowse();
  const [computed, setComputed] = useState<Record<string, Record<string, { value: string | number | null; sources: GridCellSource[] }>>>({});
  const computedColumns = columns.map((c) => c.key).filter((k) => DOCUMENT_GRID_COMPUTED_COLUMNS.has(k));
  const ids = useMemo(() => b.rows.map((r) => r.id), [b.rows]);
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!computedColumns.length || !ids.length) { setComputed({}); return; }
    let cancelled = false;
    void gridClient.documentCells(ids, computedColumns).then((res) => { if (!cancelled) setComputed(res.cells); }).catch(() => { /* extra columns are an enhancement */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, computedColumns.join(',')]);

  const gridRows: GridRow[] = useMemo(() => b.rows.map((r) => {
    const cells: GridRow['cells'] = {};
    for (const c of columns) {
      cells[c.key] = DOCUMENT_GRID_COMPUTED_COLUMNS.has(c.key)
        ? computed[r.id]?.[c.key] ?? { value: null, sources: [] }
        : browseRowCell(r, c.key);
    }
    return { id: r.id, cells };
  }), [b.rows, columns, computed]);

  const sorted = useMemo(() => sortGridRows(gridRows, columns, sort), [gridRows, columns, sort]);

  return (
    <div className="space-y-2">
      {b.error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{b.error}</p>}
      <p className="text-caption text-ink-3" aria-live="polite">
        {b.loading ? 'Loading…' : `${b.rows.length} of ${b.total} document${b.total === 1 ? '' : 's'} loaded`}
      </p>
      <GridTable columns={columns} rows={sorted} sort={sort} onSort={onSort} onOpenSource={onOpenSource} />
      <div className="flex justify-center">
        {b.loadingMore && <Loader2 className="w-5 h-5 animate-spin text-ink-3" aria-hidden="true" />}
        {!b.loadingMore && b.hasMore && <button type="button" className="dw-btn-secondary" onClick={b.loadMore}>Load more rows</button>}
      </div>
      <ExportRow columns={columns} rows={sorted} prefix="grid-documents" />
    </div>
  );
}

function UnitsGrid({ columns, onOpenSource, sort, onSort }: {
  columns: GridColumnDef[]; sort: GridSort | null; onSort: (c: string) => void; onOpenSource: (s: GridCellSource) => void;
}) {
  const [q, setQ] = useState('');
  const g = useGridUnits({ q: q || undefined }, columns.map((c) => c.key));
  const sorted = useMemo(() => sortGridRows(g.rows, columns, sort), [g.rows, columns, sort]);

  return (
    <div className="space-y-2">
      <div className="relative max-w-sm">
        <label htmlFor="grid-units-search" className="sr-only">Search units</label>
        <input id="grid-units-search" className="dw-input" placeholder="Filter by model or serial…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {g.error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{g.error}</p>}
      <p className="text-caption text-ink-3" aria-live="polite">
        {g.loading ? 'Loading…' : `${g.rows.length} of ${g.total} unit${g.total === 1 ? '' : 's'} loaded${g.atCap ? ' (5,000 shown, cap reached)' : ''}`}
      </p>
      <GridTable columns={columns} rows={sorted} sort={sort} onSort={onSort} onOpenSource={onOpenSource} />
      <div className="flex justify-center gap-2">
        {g.loadingMore && <Loader2 className="w-5 h-5 animate-spin text-ink-3" aria-hidden="true" />}
        {!g.loadingMore && g.hasMore && (
          <>
            <button type="button" className="dw-btn-secondary" onClick={g.loadMore}>Load more rows</button>
            <button type="button" className="dw-btn-tertiary" onClick={g.loadAll}>Load all (up to 5,000)</button>
          </>
        )}
      </div>
      <ExportRow columns={columns} rows={sorted} prefix="grid-units" />
    </div>
  );
}

function ExportRow({ columns, rows, prefix }: { columns: GridColumnDef[]; rows: GridRow[]; prefix: string }) {
  return (
    <div className="flex justify-end">
      <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" onClick={() => downloadGridCsv(prefix, columns, rows)} disabled={rows.length === 0}>
        <Download className="w-3.5 h-3.5" aria-hidden="true" /> Export CSV ({rows.length} row{rows.length === 1 ? '' : 's'})
      </button>
    </div>
  );
}

function ColumnPicker({ rowType, picks, onChange }: { rowType: GridRowType; picks: string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const all = GRID_COLUMNS_BY_ROW_TYPE[rowType];
  const toggle = (key: string) => {
    const next = picks.includes(key) ? picks.filter((k) => k !== key) : [...picks, key];
    onChange(next.length ? next : picks); // never let it go to zero columns
  };
  return (
    <div className="relative">
      <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Columns3 className="w-3.5 h-3.5" aria-hidden="true" /> Columns ({picks.length})
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 w-56 dw-card p-2 space-y-0.5 shadow-lg max-h-72 overflow-y-auto" onMouseLeave={() => setOpen(false)}>
          {all.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-body text-ink-2 px-2 py-1 rounded hover:bg-surface-2">
              <input type="checkbox" checked={picks.includes(c.key)} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Grid view (round 13, H3) — Hebbia "Matrix" pattern: rows are documents
 * (Records Browse's own current filters — see DocumentsGrid) or equipment
 * units (UnitsGrid), columns are chosen fields, every cell shows its
 * source(s) and opens the document at the page when it has one.
 */
export function GridView() {
  const [rowType, setRowType] = useState<GridRowType>('documents');
  const [picks, setPicks] = useState<string[]>(() => loadGridColumnPicks('documents'));
  const [sort, setSort] = useState<GridSort | null>(null);
  const openDocument = useAppStore((s) => s.openDocument);
  const openEntity = useAppStore((s) => s.openEntity);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const [previewTarget, setPreviewTarget] = useState<{ documentId: string; page?: number } | null>(null);

  // Reset column picks + sort from the EVENT that changes row type (the tab
  // click below), not a `useEffect` on `rowType` — the two row types don't
  // share a column list, so switching tabs with the old picks/sort still in
  // place would just show "no matching column" until the next click anyway.
  const switchRowType = (rt: GridRowType) => { setRowType(rt); setPicks(loadGridColumnPicks(rt)); setSort(null); };

  const allDefs = rowType === 'documents' ? DOCUMENT_GRID_COLUMNS : UNIT_GRID_COLUMNS;
  const columns = useMemo(() => picks.map((k) => allDefs.find((c) => c.key === k)).filter((c): c is GridColumnDef => !!c), [picks, allDefs]);

  const onColumnsChange = (keys: string[]) => { setPicks(keys); saveGridColumnPicks(rowType, keys); };
  const onSort = (column: string) => setSort((prev) => (prev?.column === column ? { column, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }));
  // A record source (a value that lives on a customer/unit record with no
  // backing document — see api/_lib/grid/store.js's recordSource) opens that
  // record's own screen instead of a document preview; only a document
  // source opens DocumentPreview.
  const onOpenSource = (s: GridCellSource) => {
    if (isRecordSource(s)) {
      if (s.entityType === 'customer') openCustomer(s.recordId); else openEntity(s.recordId);
      return;
    }
    openDocument(s.documentId);
    setPreviewTarget({ documentId: s.documentId, page: s.page });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line overflow-hidden" role="tablist" aria-label="Grid rows">
          {(['documents', 'units'] as const).map((rt) => (
            <button
              key={rt}
              type="button"
              role="tab"
              aria-selected={rowType === rt}
              className={`px-3 py-2 min-h-[36px] text-body ${rowType === rt ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface text-ink-2'}`}
              onClick={() => switchRowType(rt)}
            >
              {rt === 'documents' ? 'Documents' : 'Units'}
            </button>
          ))}
        </div>
        <ColumnPicker rowType={rowType} picks={picks} onChange={onColumnsChange} />
      </div>

      {rowType === 'documents'
        ? <DocumentsGrid columns={columns} sort={sort} onSort={onSort} onOpenSource={onOpenSource} />
        : <UnitsGrid columns={columns} sort={sort} onSort={onSort} onOpenSource={onOpenSource} />}

      {previewTarget && (
        <DocumentPreview
          documentId={previewTarget.documentId}
          location={previewTarget.page != null ? { page: previewTarget.page } : undefined}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  );
}
