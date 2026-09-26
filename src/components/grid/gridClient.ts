/**
 * Typed client for POST /api/account?action=grid (api/_lib/grid/route.js).
 * Same postJson + error-parsing shape as reviewClient.ts/financialsClient.ts.
 */
import { authHeader } from '../../services/authToken';
import type { BrowseFilters } from '../records/types';
import type { GridCell, GridRow, GridRowType } from './types';

const API_URL = '/api/account?action=grid';

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface DocumentCellsResponse {
  rowType: 'documents';
  cells: Record<string, Record<string, GridCell>>;
}

export interface UnitsGridResponse {
  rowType: 'units';
  columns: string[];
  rows: GridRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export const gridClient = {
  /** Extra per-document columns (model/serial/agreement) for an
   *  already-filtered/paged list of document ids — the 'documents' row
   *  type's server half; the rest of a documents-grid row comes straight off
   *  Records Browse's own BrowseRow (useRecordsBrowse.ts). */
  documentCells(documentIds: string[], columns: string[]) {
    if (!documentIds.length) return Promise.resolve<DocumentCellsResponse>({ rowType: 'documents', cells: {} });
    return postJson<DocumentCellsResponse>({ op: 'documentCells', documentIds, columns });
  },

  /** Paged/filtered rows for the 'units' (equipment) row type. */
  units(filters: Pick<BrowseFilters, 'customerId' | 'brand' | 'q'>, columns: string[], cursor: string | null, limit = 100) {
    return postJson<UnitsGridResponse>({ op: 'units', filters, columns, cursor, limit });
  },
};

export type { GridRowType };
