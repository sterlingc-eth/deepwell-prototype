import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recordsStore } from '../../services/recordsStoreClient';
import type { BrowseFacet, BrowseFilters, BrowseRow, BrowseSort, GroupBy, SavedView, ViewMode } from './types';
import { BUILT_IN_VIEWS } from './types';

const SAVED_VIEWS_KEY = 'dw.records.savedViews.v1';

/** No router in this app (screens are zustand state, not real routes — see
 *  BrowseScreen.tsx) — URL query params are read/written directly so the
 *  view is shareable and the back button works, without pulling in a router
 *  just for this screen. Only touches the params this screen owns; anything
 *  else already on the URL is left alone. */
const URL_KEYS = [
  'q', 'documentType', 'customerId', 'site', 'technician', 'brand', 'stageBucket', 'warrantyBucket',
  'hasMoney', 'openBalance', 'uploadedByMe', 'serviceDateFrom', 'serviceDateTo', 'uploadDateFrom', 'uploadDateTo',
  'sort', 'groupBy', 'view',
] as const;

function filtersFromUrl(): { filters: BrowseFilters; groupBy: GroupBy; viewMode: ViewMode } {
  const params = new URLSearchParams(window.location.search);
  const filters: BrowseFilters = {};
  for (const k of ['q', 'documentType', 'customerId', 'site', 'technician', 'brand'] as const) {
    const v = params.get(k);
    if (v) filters[k] = v;
  }
  for (const k of ['stageBucket', 'warrantyBucket'] as const) {
    const v = params.get(k);
    if (v) (filters as Record<string, unknown>)[k] = v;
  }
  for (const k of ['hasMoney', 'openBalance', 'uploadedByMe'] as const) {
    if (params.get(k) === '1') (filters as Record<string, unknown>)[k] = true;
  }
  for (const k of ['serviceDateFrom', 'serviceDateTo', 'uploadDateFrom', 'uploadDateTo'] as const) {
    const v = params.get(k);
    if (v) filters[k] = v;
  }
  const sort = params.get('sort');
  if (sort) filters.sort = sort as BrowseSort;
  const groupBy = (params.get('groupBy') as GroupBy) || 'none';
  const viewMode = (params.get('view') as ViewMode) || 'table';
  return { filters, groupBy, viewMode };
}

function urlFromState(filters: BrowseFilters, groupBy: GroupBy, viewMode: ViewMode): string {
  const params = new URLSearchParams(window.location.search);
  for (const k of URL_KEYS) params.delete(k);
  const setIf = (k: string, v: string | undefined | null) => { if (v) params.set(k, v); };
  setIf('q', filters.q);
  setIf('documentType', filters.documentType);
  setIf('customerId', filters.customerId);
  setIf('site', filters.site);
  setIf('technician', filters.technician);
  setIf('brand', filters.brand);
  setIf('stageBucket', filters.stageBucket);
  setIf('warrantyBucket', filters.warrantyBucket);
  if (filters.hasMoney) params.set('hasMoney', '1');
  if (filters.openBalance) params.set('openBalance', '1');
  if (filters.uploadedByMe) params.set('uploadedByMe', '1');
  setIf('serviceDateFrom', filters.serviceDateFrom);
  setIf('serviceDateTo', filters.serviceDateTo);
  setIf('uploadDateFrom', filters.uploadDateFrom);
  setIf('uploadDateTo', filters.uploadDateTo);
  setIf('sort', filters.sort);
  if (groupBy !== 'none') params.set('groupBy', groupBy); else params.delete('groupBy');
  if (viewMode !== 'table') params.set('view', viewMode); else params.delete('view');
  const qs = params.toString();
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

export function loadSavedViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(SAVED_VIEWS_KEY);
    const custom: SavedView[] = raw ? JSON.parse(raw) : [];
    return custom;
  } catch {
    return [];
  }
}

function persistSavedViews(views: SavedView[]) {
  try {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* best-effort — a private tab or full storage just means views don't persist */
  }
}

/** This-month date range, computed fresh each time (never baked into a
 *  stored view — see types.ts's BUILT_IN_VIEWS comment). */
function thisMonthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

export function resolveBuiltInFilters(view: Omit<SavedView, 'id'>): BrowseFilters {
  if (view.name === "This month's invoices") {
    const { from, to } = thisMonthRange();
    return { ...view.filters, uploadDateFrom: from, uploadDateTo: to };
  }
  return view.filters;
}

const EMPTY_FILTERS: BrowseFilters = { sort: 'upload-date' };

/**
 * Data + view-state for the records browser, shared by the desktop workspace
 * and (via the same shape) the mobile Docs tab. Owns: filters, group-by,
 * view mode, URL sync, fetching + infinite accumulation, and saved views.
 */
export function useRecordsBrowse() {
  const initial = useMemo(() => filtersFromUrl(), []);
  const [filters, setFiltersState] = useState<BrowseFilters>({ ...EMPTY_FILTERS, ...initial.filters });
  const [groupBy, setGroupBy] = useState<GroupBy>(initial.groupBy);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.viewMode);
  const [rows, setRows] = useState<BrowseRow[]>([]);
  const [facets, setFacets] = useState<BrowseFacet[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Keep the address bar (and back-button history) in sync with view state —
  // replace, not push, so every keystroke/filter click doesn't spam history;
  // a real navigation elsewhere still leaves one clean entry to come back to.
  useEffect(() => {
    const url = urlFromState(filters, groupBy, viewMode);
    window.history.replaceState(window.history.state, '', url);
  }, [filters, groupBy, viewMode]);

  // Back/forward: re-read the URL and refetch from scratch.
  useEffect(() => {
    const onPop = () => {
      const next = filtersFromUrl();
      setFiltersState({ ...EMPTY_FILTERS, ...next.filters });
      setGroupBy(next.groupBy);
      setViewMode(next.viewMode);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const fetchPage = useCallback(async (f: BrowseFilters, cur: string | null, append: boolean) => {
    const id = ++requestId.current;
    (append ? setLoadingMore : setLoading)(true);
    setError(null);
    try {
      const res = await recordsStore.browseDocuments({ ...f, cursor: cur, limit: 50 });
      if (id !== requestId.current) return; // a newer request landed first
      setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
      setFacets(res.facets);
      setTotal(res.total);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load records.');
    } finally {
      if (id === requestId.current) (append ? setLoadingMore : setLoading)(false);
    }
  }, []);

  // Any filter/sort change refetches from the top.
  useEffect(() => {
    void fetchPage(filters, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore) return;
    void fetchPage(filters, cursor, true);
  }, [fetchPage, filters, cursor, hasMore, loading, loadingMore]);

  const setFilters = useCallback((next: BrowseFilters) => setFiltersState(next), []);
  const patchFilters = useCallback((patch: Partial<BrowseFilters>) => setFiltersState((prev) => ({ ...prev, ...patch })), []);
  const clearFilter = useCallback((key: keyof BrowseFilters) => setFiltersState((prev) => { const next = { ...prev }; delete next[key]; return next; }), []);
  const clearAll = useCallback(() => setFiltersState({ sort: filters.sort }), [filters.sort]);

  const activeCount = useMemo(
    () => Object.entries(filters).filter(([k, v]) => k !== 'sort' && k !== 'cursor' && k !== 'limit' && v !== undefined && v !== null && v !== '').length,
    [filters]
  );

  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews());
  const saveCurrentView = useCallback((name: string) => {
    const view: SavedView = { id: `v${Date.now()}`, name, filters, groupBy, viewMode };
    setSavedViews((prev) => {
      const next = [...prev.filter((v) => v.name !== name), view];
      persistSavedViews(next);
      return next;
    });
  }, [filters, groupBy, viewMode]);
  const deleteSavedView = useCallback((id: string) => {
    setSavedViews((prev) => {
      const next = prev.filter((v) => v.id !== id);
      persistSavedViews(next);
      return next;
    });
  }, []);
  const applyView = useCallback((view: Omit<SavedView, 'id'>) => {
    setFiltersState({ sort: 'upload-date', ...resolveBuiltInFilters(view) });
    setGroupBy(view.groupBy);
    setViewMode(view.viewMode);
  }, []);

  return {
    filters, setFilters, patchFilters, clearFilter, clearAll, activeCount,
    groupBy, setGroupBy, viewMode, setViewMode,
    rows, facets, total, hasMore, loading, loadingMore, error,
    loadMore, refetch: () => fetchPage(filters, null, false),
    savedViews, builtInViews: BUILT_IN_VIEWS, saveCurrentView, deleteSavedView, applyView,
  };
}
