import { useCallback, useEffect, useRef, useState } from 'react';
import { gridClient } from './gridClient';
import type { GridRow } from './types';

/** Grid rows never grow past this in one browser tab — the spec's own
 *  "virtualization for 5k rows" cap. A tenant with more units than this
 *  still works: `total`/`hasMore` stay honest, "Load more" just stops
 *  offering once the cap is hit. */
const MAX_ROWS = 5000;
const PAGE_SIZE = 200;

export interface UseGridUnitsResult {
  rows: GridRow[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  atCap: boolean;
  error: string | null;
  loadMore: () => void;
  /** Fetches pages back-to-back until `hasMore` is false or the 5,000-row
   *  cap is hit — the toolbar's "Load all" button. */
  loadAll: () => void;
}

export function useGridUnits(
  filters: { customerId?: string; brand?: string; q?: string },
  columns: string[],
): UseGridUnitsResult {
  const [rows, setRows] = useState<GridRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const columnsKey = columns.join(',');

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    void gridClient.units(filters, columns, null, PAGE_SIZE)
      .then((res) => {
        if (requestId.current !== id) return;
        setRows(res.rows);
        setTotal(res.total);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((err: unknown) => {
        if (requestId.current !== id) return;
        setError(err instanceof Error ? err.message : 'Could not load the grid.');
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.customerId, filters.brand, filters.q, columnsKey]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || rows.length >= MAX_ROWS) return;
    const id = requestId.current;
    setLoadingMore(true);
    setError(null);
    void gridClient.units(filters, columns, cursor, PAGE_SIZE)
      .then((res) => {
        if (requestId.current !== id) return;
        setRows((prev) => [...prev, ...res.rows]);
        setTotal(res.total);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
      })
      .catch((err: unknown) => {
        if (requestId.current !== id) return;
        setError(err instanceof Error ? err.message : 'Could not load more rows.');
      })
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.customerId, filters.brand, filters.q, columnsKey, cursor, hasMore, loadingMore, rows.length]);

  const loadAllRef = useRef(false);
  const loadAll = useCallback(() => {
    if (loadAllRef.current) return;
    loadAllRef.current = true;
    const id = requestId.current;
    const step = async () => {
      let nextCursor = cursor;
      let more = hasMore;
      let loaded = rows.length;
      setLoadingMore(true);
      try {
        while (more && loaded < MAX_ROWS && requestId.current === id) {
          const res = await gridClient.units(filters, columns, nextCursor, PAGE_SIZE);
          if (requestId.current !== id) return;
          setRows((prev) => [...prev, ...res.rows]);
          loaded += res.rows.length;
          setTotal(res.total);
          nextCursor = res.nextCursor;
          more = res.hasMore;
          setCursor(nextCursor);
          setHasMore(more);
        }
      } catch (err) {
        if (requestId.current === id) setError(err instanceof Error ? err.message : 'Could not load all rows.');
      } finally {
        if (requestId.current === id) setLoadingMore(false);
        loadAllRef.current = false;
      }
    };
    void step();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.customerId, filters.brand, filters.q, columnsKey, cursor, hasMore]);

  return { rows, total, loading, loadingMore, hasMore: hasMore && rows.length < MAX_ROWS, atCap: rows.length >= MAX_ROWS, error, loadMore, loadAll };
}
