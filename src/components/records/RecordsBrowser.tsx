import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Filter as FilterIcon, LayoutGrid, List as ListIcon, Loader2, Save, Search,
  X,
} from 'lucide-react';
import { DOCUMENT_TYPES } from '../../domains/hvac/documentTypes';
import { fmtDate, fmtMoney, formatYmd } from '../../core/answer';
import { StagePill } from '../StagePill';
import type { PipelineStage } from '../../core/types';
import { WarrantyStatusBadge } from '../WarrantyStatusBadge';
import { useRecordsBrowse } from './useRecordsBrowse';
import {
  BROWSE_SORT_OPTIONS, STAGE_BUCKET_LABEL, WARRANTY_BUCKET_LABEL,
  type BrowseFacet, type BrowseFilters, type BrowseRow, type GroupBy,
} from './types';

const DOCUMENT_TYPE_LABEL = new Map(DOCUMENT_TYPES.map((t) => [t.id, t.label]));
const typeLabel = (id: string | null) => (id ? DOCUMENT_TYPE_LABEL.get(id) ?? id : 'Unclassified');

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'none', label: 'No grouping' },
  { id: 'customer', label: 'Customer' },
  { id: 'type', label: 'Type' },
  { id: 'month', label: 'Month' },
  { id: 'site', label: 'Site' },
];

/** The DB's raw `documents.stage` ('received'|'read'|'mapped'|'linked'|
 *  'verified') to StagePill's PipelineStage label set. This is the SIMPLE
 *  1:1 mapping, not usePostgresSync.ts's deriveStage (which upgrades a
 *  'read'/'mapped' document further once the full client graph shows every
 *  required field/link present) — a browse list has no client graph to
 *  derive from; opening the document in Review shows the precise stage. */
function toPipelineStage(stage: string): PipelineStage {
  switch (stage) {
    case 'read': return 'classified';
    case 'mapped': return 'extracted';
    case 'received': case 'linked': case 'verified': return stage;
    default: return 'received';
  }
}

/** Service date is a bare calendar day (formatYmd, timezone-safe); upload
 *  date is a real timestamp (fmtDate) — same distinction BrowseScreen.tsx's
 *  own haystack() comment calls out for entity fields. */
function rowDateLabel(r: BrowseRow): string {
  if (r.serviceDate) return formatYmd(r.serviceDate);
  if (r.createdAt) return fmtDate(new Date(r.createdAt));
  return '—';
}

function rowName(r: BrowseRow): string {
  return (r.displayName && r.displayName.trim()) || r.filename;
}

function groupKeyOf(r: BrowseRow, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case 'customer': return { key: r.customerId ?? 'none', label: r.customerName || 'No customer linked' };
    case 'type': return { key: r.documentType ?? 'none', label: typeLabel(r.documentType) };
    case 'site': return { key: r.siteAddress ?? 'none', label: r.siteAddress || 'No site on file' };
    case 'month': {
      const src = r.serviceDate ?? r.createdAt;
      const ym = src ? src.slice(0, 7) : null;
      if (!ym) return { key: 'none', label: 'No date' };
      const parts = ym.split('-').map(Number);
      const y = parts[0] ?? 1970;
      const m = parts[1] ?? 1;
      return { key: ym, label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    }
    default: return { key: 'all', label: '' };
  }
}

function groupRows(rows: BrowseRow[], groupBy: GroupBy) {
  if (groupBy === 'none') return [{ key: 'all', label: '', rows }];
  const order: string[] = [];
  const byKey = new Map<string, { key: string; label: string; rows: BrowseRow[] }>();
  for (const r of rows) {
    const { key, label } = groupKeyOf(r, groupBy);
    if (!byKey.has(key)) { byKey.set(key, { key, label, rows: [] }); order.push(key); }
    byKey.get(key)!.rows.push(r);
  }
  return order.map((k) => byKey.get(k)!);
}

function facetOptions(facets: BrowseFacet[], key: string) {
  const f = facets.find((x) => x.key === key);
  return f && 'options' in f ? f.options : [];
}
function facetTrueCount(facets: BrowseFacet[], key: string) {
  const f = facets.find((x) => x.key === key);
  return f && 'trueCount' in f ? f.trueCount : 0;
}

/** One filter chip's human label — used both for the active-chips row and
 *  nowhere else, so a filter added here never needs a second place updated. */
function chipLabel(key: keyof BrowseFilters, filters: BrowseFilters): string | null {
  const v = filters[key];
  if (v === undefined || v === null || v === '') return null;
  switch (key) {
    case 'q': return `Search: "${v}"`;
    case 'documentType': return typeLabel(String(v));
    case 'stageBucket': return STAGE_BUCKET_LABEL[v as keyof typeof STAGE_BUCKET_LABEL];
    case 'warrantyBucket': return WARRANTY_BUCKET_LABEL[v as keyof typeof WARRANTY_BUCKET_LABEL];
    case 'customerId': return `Customer`;
    case 'site': return `Site: ${v}`;
    case 'technician': return `Tech: ${v}`;
    case 'brand': return `Brand: ${v}`;
    case 'hasMoney': return 'Has money';
    case 'openBalance': return 'Open balance';
    case 'uploadedByMe': return 'My uploads';
    case 'serviceDateFrom': return `Service from ${v}`;
    case 'serviceDateTo': return `Service to ${v}`;
    case 'uploadDateFrom': return `Uploaded from ${v}`;
    case 'uploadDateTo': return `Uploaded to ${v}`;
    default: return null;
  }
}
const CHIP_KEYS: (keyof BrowseFilters)[] = [
  'q', 'documentType', 'stageBucket', 'warrantyBucket', 'customerId', 'site', 'technician', 'brand',
  'hasMoney', 'openBalance', 'uploadedByMe', 'serviceDateFrom', 'serviceDateTo', 'uploadDateFrom', 'uploadDateTo',
];

export function RecordsBrowser({ onOpenDocument }: { onOpenDocument: (id: string) => void }) {
  const b = useRecordsBrowse();
  const [panelOpen, setPanelOpen] = useState(true);
  const [searchDraft, setSearchDraft] = useState(b.filters.q ?? '');
  const [savingName, setSavingName] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Instant search: debounce the network call, not the input.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((b.filters.q ?? '') !== searchDraft) b.patchFilters({ q: searchDraft || undefined });
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);
  useEffect(() => { setSearchDraft(b.filters.q ?? ''); }, [b.filters.q]);

  // Infinite scroll: a sentinel below the list triggers loadMore when visible.
  const { loadMore } = b;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadMore(); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const groups = useMemo(() => groupRows(b.rows, b.groupBy), [b.rows, b.groupBy]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const activeChips = CHIP_KEYS.map((k) => ({ key: k, label: chipLabel(k, b.filters) })).filter((c) => c.label);

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveRow((i) => Math.min(i + 1, b.rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveRow((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && b.rows[activeRow]) { onOpenDocument(b.rows[activeRow].id); }
  };

  return (
    <div className="space-y-3" data-testid="records-browser">
      {/* Saved views */}
      <div className="flex flex-wrap items-center gap-1.5">
        {b.builtInViews.map((v) => (
          <button key={v.name} type="button" className="dw-pill-muted" onClick={() => b.applyView(v)}>{v.name}</button>
        ))}
        {b.savedViews.map((v) => (
          <span key={v.id} className="dw-pill-muted inline-flex items-center gap-1">
            <button type="button" onClick={() => b.applyView(v)}>{v.name}</button>
            <button type="button" aria-label={`Delete view ${v.name}`} onClick={() => b.deleteSavedView(v.id)}><X className="w-3 h-3" aria-hidden="true" /></button>
          </span>
        ))}
        {savingName === null ? (
          <button type="button" className="dw-btn-tertiary !min-h-[28px] !py-0.5 !px-2 text-caption" onClick={() => setSavingName('')}>
            <Save className="w-3.5 h-3.5" aria-hidden="true" /> Save current view
          </button>
        ) : (
          <span className="inline-flex items-center gap-1">
            <label className="sr-only" htmlFor="save-view-name">View name</label>
            <input
              id="save-view-name"
              className="dw-input !min-h-[28px] !py-0.5 !w-40 text-caption"
              value={savingName}
              onChange={(e) => setSavingName(e.target.value)}
              placeholder="View name"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && savingName.trim()) { b.saveCurrentView(savingName.trim()); setSavingName(null); } if (e.key === 'Escape') setSavingName(null); }}
            />
            <button type="button" className="dw-btn-tertiary !min-h-[28px] !py-0.5 !px-2 text-caption" disabled={!savingName.trim()} onClick={() => { b.saveCurrentView(savingName.trim()); setSavingName(null); }}>Save</button>
          </span>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="dw-btn-secondary !min-h-[40px]" aria-pressed={panelOpen} onClick={() => setPanelOpen((p) => !p)}>
          <FilterIcon className="w-4 h-4" aria-hidden="true" /> Filters{b.activeCount ? ` (${b.activeCount})` : ''}
        </button>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
          <label htmlFor="records-search" className="sr-only">Search records</label>
          <input
            id="records-search"
            className="dw-input !pl-12"
            placeholder="Search filename, customer, address, technician, brand, contents…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && searchDraft) { e.stopPropagation(); setSearchDraft(''); } }}
            autoComplete="off"
          />
        </div>
        <label className="sr-only" htmlFor="records-sort">Sort</label>
        <select id="records-sort" className="dw-input !w-auto !min-h-[40px]" value={b.filters.sort ?? 'upload-date'} onChange={(e) => b.patchFilters({ sort: e.target.value as BrowseFilters['sort'] })}>
          {BROWSE_SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="records-group">Group by</label>
        <select id="records-group" className="dw-input !w-auto !min-h-[40px]" value={b.groupBy} onChange={(e) => b.setGroupBy(e.target.value as GroupBy)}>
          {GROUP_OPTIONS.map((o) => <option key={o.id} value={o.id}>Group: {o.label}</option>)}
        </select>
        <div className="flex items-center rounded-lg border border-line overflow-hidden" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={b.viewMode === 'table'} className={`p-2 min-h-[40px] ${b.viewMode === 'table' ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface text-ink-2'}`} onClick={() => b.setViewMode('table')} aria-label="Table view">
            <ListIcon className="w-4 h-4" aria-hidden="true" />
          </button>
          <button type="button" role="tab" aria-selected={b.viewMode === 'cards'} className={`p-2 min-h-[40px] ${b.viewMode === 'cards' ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface text-ink-2'}`} onClick={() => b.setViewMode('cards')} aria-label="Card view">
            <LayoutGrid className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeChips.map((c) => (
            <button key={c.key} type="button" className="dw-pill-muted inline-flex items-center gap-1" onClick={() => b.clearFilter(c.key)}>
              {c.label} <X className="w-3 h-3" aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="dw-btn-tertiary !min-h-[28px] !py-0.5 !px-2 text-caption" onClick={b.clearAll}>Clear all</button>
        </div>
      )}

      {b.error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{b.error}</p>}

      <div className="flex items-start gap-4">
        {panelOpen && (
          <FacetPanel filters={b.filters} facets={b.facets} onPatch={b.patchFilters} onClose={() => setPanelOpen(false)} />
        )}

        <div className="flex-1 min-w-0 space-y-3">
          <p className="text-caption text-ink-3" aria-live="polite">
            {b.loading ? 'Loading…' : `${b.rows.length} of ${b.total} document${b.total === 1 ? '' : 's'} shown`}
          </p>

          {!b.loading && b.rows.length === 0 ? (
            <div className="dw-card p-8 text-center text-ink-3 space-y-2">
              <p>{b.activeCount > 0 ? 'No documents match these filters.' : 'No documents yet.'}</p>
              {b.activeCount > 0 && <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 mx-auto" onClick={b.clearAll}>Clear all filters</button>}
            </div>
          ) : b.viewMode === 'table' ? (
            <div className="overflow-x-auto border border-line rounded-lg bg-surface" onKeyDown={onRowKeyDown}>
              <table className="w-full text-left text-body">
                <thead>
                  <tr className="border-b border-line text-caption text-ink-3">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Address</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Tech</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {groups.map((g) => (
                    <GroupRows key={g.key} group={g} groupBy={b.groupBy} collapsed={collapsed.has(g.key)} onToggle={() => toggleGroup(g.key)} onOpen={onOpenDocument} activeId={b.rows[activeRow]?.id} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.key}>
                  {g.label && (
                    <button type="button" className="flex items-center gap-1.5 text-body font-medium text-ink-2 mb-2" onClick={() => toggleGroup(g.key)}>
                      {collapsed.has(g.key) ? <ChevronRight className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
                      {g.label} <span className="dw-pill-muted">{g.rows.length}</span>
                    </button>
                  )}
                  {!collapsed.has(g.key) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {g.rows.map((r) => <RecordCard key={r.id} row={r} onOpen={onOpenDocument} />)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div ref={sentinelRef} />
          {b.loadingMore && <div className="flex justify-center py-3"><Loader2 className="w-5 h-5 animate-spin text-ink-3" aria-hidden="true" /></div>}
          {!b.loadingMore && b.hasMore && (
            <button type="button" className="dw-btn-secondary w-full" onClick={b.loadMore}>Load more</button>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupRows({ group, groupBy, collapsed, onToggle, onOpen, activeId }: {
  group: { key: string; label: string; rows: BrowseRow[] }; groupBy: GroupBy; collapsed: boolean;
  onToggle: () => void; onOpen: (id: string) => void; activeId?: string;
}) {
  return (
    <>
      {groupBy !== 'none' && (
        <tr>
          <td colSpan={8} className="px-3 py-1.5 bg-surface-2">
            <button type="button" className="flex items-center gap-1.5 text-body font-medium text-ink-2" onClick={onToggle}>
              {collapsed ? <ChevronRight className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
              {group.label} <span className="dw-pill-muted">{group.rows.length}</span>
            </button>
          </td>
        </tr>
      )}
      {!collapsed && group.rows.map((r) => (
        <tr key={r.id} className={`hover:bg-surface-2 cursor-pointer ${activeId === r.id ? 'bg-surface-2' : ''}`} tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.id); }}>
          <td className="px-3 py-2 max-w-[16rem]" title={rowName(r)}>
            <span className="block truncate font-medium text-ink">{rowName(r)}</span>
            {r.displayName && <span className="block truncate text-caption text-ink-3">{r.filename}</span>}
          </td>
          <td className="px-3 py-2 text-ink-2">{typeLabel(r.documentType)}</td>
          <td className="px-3 py-2 text-ink-2">{r.customerName || '—'}</td>
          <td className="px-3 py-2 text-ink-2 max-w-[14rem] truncate" title={r.siteAddress ?? ''}>{r.siteAddress || '—'}</td>
          <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{rowDateLabel(r)}</td>
          <td className="px-3 py-2 text-ink-2">{r.technician || '—'}</td>
          <td className="px-3 py-2"><StagePill stage={toPipelineStage(r.stage)} ai={r.verifiedBy === 'ai'} compact /></td>
          <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{r.amount != null ? fmtMoney(r.amount) : '—'}</td>
        </tr>
      ))}
    </>
  );
}

function RecordCard({ row: r, onOpen }: { row: BrowseRow; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(r.id)} className="dw-card p-3 text-left hover:bg-surface-2 transition-colors duration-quick space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-ink truncate">{rowName(r)}</span>
        <StagePill stage={toPipelineStage(r.stage)} ai={r.verifiedBy === 'ai'} compact />
      </div>
      <p className="text-caption text-ink-3">{typeLabel(r.documentType)}</p>
      {r.customerName && <p className="text-body text-ink-2 truncate">{r.customerName}</p>}
      {r.siteAddress && <p className="text-caption text-ink-3 truncate">{r.siteAddress}</p>}
      <div className="flex items-center justify-between text-caption text-ink-3">
        <span>{rowDateLabel(r)}</span>
        {r.amount != null && <span>{fmtMoney(r.amount)}</span>}
      </div>
      {/* Bare 'YYYY-MM-DD', no time suffix — parses as UTC midnight, same
          convention as usePostgresSync.ts's toDateOrNull (see formatYmd's
          doc comment above); appending a local time-of-day here would shift
          the day near a timezone boundary. */}
      {r.warrantyBucket !== 'unknown' && <WarrantyStatusBadge warranty={{ warrantyExpiry: r.warrantyExpiry ? new Date(r.warrantyExpiry) : null }} />}
    </button>
  );
}

function FacetSection({ title, options, active, onPick }: {
  title: string; options: { value: string; label: string; count: number }[]; active?: string; onPick: (v: string | undefined) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-caption font-medium text-ink-3 uppercase tracking-wide">{title}</p>
      <ul className="space-y-0.5">
        {options.map((o) => (
          <li key={o.value}>
            <button
              type="button"
              onClick={() => onPick(active === o.value ? undefined : o.value)}
              aria-pressed={active === o.value}
              className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-body text-left ${active === o.value ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'hover:bg-surface-2 text-ink-2'}`}
            >
              <span className="truncate">{o.label}</span>
              <span className="text-caption opacity-70 shrink-0">{o.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FacetPanel({ filters, facets, onPatch, onClose }: {
  filters: BrowseFilters; facets: BrowseFacet[]; onPatch: (p: Partial<BrowseFilters>) => void; onClose: () => void;
}) {
  return (
    <aside className="w-64 shrink-0 dw-card p-3 space-y-4 max-h-[calc(100vh-14rem)] overflow-y-auto" aria-label="Filters">
      <div className="flex items-center justify-between">
        <p className="font-medium text-ink">Filters</p>
        <button type="button" aria-label="Hide filters" onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-4 h-4" aria-hidden="true" /></button>
      </div>

      <FacetSection title="Type" options={facetOptions(facets, 'documentType').map((o) => ({ ...o, label: typeLabel(o.value) }))} active={filters.documentType} onPick={(v) => onPatch({ documentType: v })} />
      <FacetSection
        title="Status"
        options={facetOptions(facets, 'stageBucket').map((o) => ({ ...o, label: STAGE_BUCKET_LABEL[o.value as keyof typeof STAGE_BUCKET_LABEL] ?? o.value }))}
        active={filters.stageBucket}
        onPick={(v) => onPatch({ stageBucket: v as BrowseFilters['stageBucket'] })}
      />
      <FacetSection
        title="Warranty"
        options={facetOptions(facets, 'warrantyBucket').map((o) => ({ ...o, label: WARRANTY_BUCKET_LABEL[o.value as keyof typeof WARRANTY_BUCKET_LABEL] ?? o.value }))}
        active={filters.warrantyBucket}
        onPick={(v) => onPatch({ warrantyBucket: v as BrowseFilters['warrantyBucket'] })}
      />
      <FacetSection title="Customer" options={facetOptions(facets, 'customerId')} active={filters.customerId} onPick={(v) => onPatch({ customerId: v })} />
      <FacetSection title="Site" options={facetOptions(facets, 'site')} active={filters.site} onPick={(v) => onPatch({ site: v })} />
      <FacetSection title="Technician" options={facetOptions(facets, 'technician')} active={filters.technician} onPick={(v) => onPatch({ technician: v })} />
      <FacetSection title="Brand" options={facetOptions(facets, 'brand')} active={filters.brand} onPick={(v) => onPatch({ brand: v })} />

      <div className="space-y-1">
        <p className="text-caption font-medium text-ink-3 uppercase tracking-wide">Money</p>
        <label className="flex items-center gap-2 text-body text-ink-2">
          <input type="checkbox" checked={!!filters.hasMoney} onChange={(e) => onPatch({ hasMoney: e.target.checked || undefined })} />
          Has money ({facetTrueCount(facets, 'hasMoney')})
        </label>
        <label className="flex items-center gap-2 text-body text-ink-2">
          <input type="checkbox" checked={!!filters.openBalance} onChange={(e) => onPatch({ openBalance: e.target.checked || undefined })} />
          Open balance ({facetTrueCount(facets, 'openBalance')})
        </label>
        <label className="flex items-center gap-2 text-body text-ink-2">
          <input type="checkbox" checked={!!filters.uploadedByMe} onChange={(e) => onPatch({ uploadedByMe: e.target.checked || undefined })} />
          Uploaded by me ({facetTrueCount(facets, 'uploadedByMe')})
        </label>
      </div>

      <div className="space-y-1">
        <p className="text-caption font-medium text-ink-3 uppercase tracking-wide">Service date</p>
        {/* Stacked, not side-by-side: a native date input has enough
            intrinsic width that two of them plus a separator overflow this
            narrow panel column at 1280px (found by actually looking at the
            verify-records-ui.mjs screenshots — see records-desktop-*-2-filtered.png). */}
        <div className="flex flex-col gap-1">
          <input type="date" aria-label="Service date from" className="dw-input !min-h-[32px] !py-0.5 text-caption w-full" value={filters.serviceDateFrom ?? ''} onChange={(e) => onPatch({ serviceDateFrom: e.target.value || undefined })} />
          <input type="date" aria-label="Service date to" className="dw-input !min-h-[32px] !py-0.5 text-caption w-full" value={filters.serviceDateTo ?? ''} onChange={(e) => onPatch({ serviceDateTo: e.target.value || undefined })} />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-caption font-medium text-ink-3 uppercase tracking-wide">Upload date</p>
        <div className="flex flex-col gap-1">
          <input type="date" aria-label="Upload date from" className="dw-input !min-h-[32px] !py-0.5 text-caption w-full" value={filters.uploadDateFrom ?? ''} onChange={(e) => onPatch({ uploadDateFrom: e.target.value || undefined })} />
          <input type="date" aria-label="Upload date to" className="dw-input !min-h-[32px] !py-0.5 text-caption w-full" value={filters.uploadDateTo ?? ''} onChange={(e) => onPatch({ uploadDateTo: e.target.value || undefined })} />
        </div>
      </div>
    </aside>
  );
}
