import type { GridCell, GridColumnDef, GridRow, GridSort } from './types';

function compareCells(a: GridCell | undefined, b: GridCell | undefined, kind: GridColumnDef['kind']): number {
  const av = a?.value ?? null;
  const bv = b?.value ?? null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1; // nulls last regardless of direction (flipped by the caller)
  if (bv == null) return -1;
  if (kind === 'money' || kind === 'number') return Number(av) - Number(bv);
  return String(av).localeCompare(String(bv));
}

/** Sorts a full row list client-side by one column — the grid never asks
 *  the server to sort (see GridView.tsx's own comment: columns come from
 *  three different tables server-side, so one SQL ORDER BY per pickable
 *  column isn't practical; sorting the already-loaded page in the browser
 *  is instant either way). */
export function sortGridRows(rows: GridRow[], columns: GridColumnDef[], sort: GridSort | null): GridRow[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.column);
  if (!col) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => dir * compareCells(a.cells[col.key], b.cells[col.key], col.kind));
}
