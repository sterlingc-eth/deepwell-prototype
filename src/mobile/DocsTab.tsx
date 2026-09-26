import { memo, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import type { SyncStatus } from '../hooks/usePostgresSync'
import { useRecordsBrowse } from '../components/records/useRecordsBrowse'
import { STAGE_BUCKET_LABEL, WARRANTY_BUCKET_LABEL, type BrowseFilters, type BrowseRow } from '../components/records/types'
import { formatYmd } from '../core/answer'
import { Sheet } from './Sheet'

/** documentName()'s priority (server display_name -> derived -> filename) —
 *  the row itself already carries `displayName` from the server, so this is
 *  just the fallback for a document not yet named. */
function rowName(r: BrowseRow): string {
  return (r.displayName && r.displayName.trim()) || r.filename
}

const DocRow = memo(function DocRow({ row: r, onOpen }: { row: BrowseRow; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(r.id)} className="w-full min-h-touch text-left flex items-center gap-3 px-1 py-3">
        <span className="flex-1 min-w-0">
          <span className="block text-body font-semibold text-ink truncate">{rowName(r)}</span>
          <span className="block text-caption text-ink-3 truncate">
            {r.customerName || 'No customer'} · {r.serviceDate ? formatYmd(r.serviceDate) : r.createdAt ? formatYmd(r.createdAt) : '—'}
          </span>
        </span>
        <span className="dw-pill-muted shrink-0 text-caption">{STAGE_BUCKET_LABEL[r.stageBucket]}</span>
      </button>
    </li>
  )
})

/**
 * Mobile Docs tab (round 12 contract): the same server-side browse API as
 * the desktop RecordsBrowser (useRecordsBrowse), reshaped for one thumb —
 * sticky search, a bottom-sheet filter with the 5 filters a field tech
 * reaches for most, sort, group-by-customer, and large tap targets. No
 * client-side 500-doc cap: this reads straight from the server, page by
 * page, same as desktop.
 */
export function DocsTab({
  syncStatus,
  onOpenDoc,
  onRefresh,
}: {
  syncStatus: SyncStatus
  onOpenDoc: (id: string) => void
  onRefresh: () => Promise<void>
}) {
  const b = useRecordsBrowse()
  const [searchDraft, setSearchDraft] = useState(b.filters.q ?? '')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState<BrowseFilters>(b.filters)
  const [refreshing, setRefreshing] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((b.filters.q ?? '') !== searchDraft) b.patchFilters({ q: searchDraft || undefined })
    }, 200)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft])

  const { loadMore } = b
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadMore() }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore])

  const openSheet = () => { setDraft(b.filters); setSheetOpen(true) }
  const applySheet = () => { b.patchFilters(draft); setSheetOpen(false) }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([onRefresh(), b.refetch()])
    } finally {
      setRefreshing(false)
    }
  }

  const loading = (syncStatus === 'loading' || syncStatus === 'idle') && b.loading && b.rows.length === 0

  // Group by customer (owner brief: "large rows showing name + customer +
  // date + status" — grouping keeps a multi-visit customer's documents
  // together without hiding the fields each row already shows).
  const groups: { key: string; label: string; rows: BrowseRow[] }[] = []
  if (b.groupBy === 'customer') {
    const byKey = new Map<string, { key: string; label: string; rows: BrowseRow[] }>()
    for (const r of b.rows) {
      const key = r.customerId ?? 'none'
      if (!byKey.has(key)) byKey.set(key, { key, label: r.customerName || 'No customer linked', rows: [] })
      byKey.get(key)!.rows.push(r)
    }
    groups.push(...byKey.values())
  } else {
    groups.push({ key: 'all', label: '', rows: b.rows })
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 bg-bg">
        <div className="max-w-2xl mx-auto px-4 pt-3 short:pt-1.5">
          <div className="relative">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <label htmlFor="dw-m-search" className="sr-only">Search documents</label>
            <input
              id="dw-m-search"
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Customer, address, serial…"
              enterKeyHint="search"
              autoComplete="off"
              className="w-full h-12 short:h-11 rounded-xl bg-surface-2 text-ink pl-10 pr-3 placeholder:text-ink-3 border border-transparent focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center gap-2 py-2 overflow-x-auto no-scrollbar -mx-4 px-4">
            <button type="button" onClick={openSheet} className="shrink-0 min-h-11 px-4 rounded-full text-caption font-semibold bg-surface text-ink-2 inline-flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> Filters{b.activeCount ? ` (${b.activeCount})` : ''}
            </button>
            <label className="sr-only" htmlFor="dw-m-sort">Sort</label>
            <select id="dw-m-sort" value={b.filters.sort ?? 'upload-date'} onChange={(e) => b.patchFilters({ sort: e.target.value as BrowseFilters['sort'] })} className="shrink-0 min-h-11 px-3 rounded-full text-caption font-semibold bg-surface text-ink-2">
              <option value="upload-date">Newest upload</option>
              <option value="service-date">Newest service date</option>
              <option value="customer">Customer A-Z</option>
              <option value="type">Type</option>
              <option value="amount">Amount</option>
            </select>
            <button
              type="button"
              aria-pressed={b.groupBy === 'customer'}
              onClick={() => b.setGroupBy(b.groupBy === 'customer' ? 'none' : 'customer')}
              className={`shrink-0 min-h-11 px-4 rounded-full text-caption font-semibold ${b.groupBy === 'customer' ? 'bg-accent text-forest-950' : 'bg-surface text-ink-2'}`}
            >
              Group by customer
            </button>
            <button type="button" onClick={() => void refresh()} aria-label="Refresh documents" className="shrink-0 ml-auto w-11 h-11 flex items-center justify-center text-ink-3">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {b.activeCount > 0 && (
            <div className="flex items-center gap-2 pb-2 overflow-x-auto no-scrollbar -mx-4 px-4">
              {b.filters.q && <Chip label={`"${b.filters.q}"`} onClear={() => { setSearchDraft(''); b.clearFilter('q') }} />}
              {b.filters.stageBucket && <Chip label={STAGE_BUCKET_LABEL[b.filters.stageBucket]} onClear={() => b.clearFilter('stageBucket')} />}
              {b.filters.warrantyBucket && <Chip label={WARRANTY_BUCKET_LABEL[b.filters.warrantyBucket]} onClear={() => b.clearFilter('warrantyBucket')} />}
              {b.filters.documentType && <Chip label={b.filters.documentType} onClear={() => b.clearFilter('documentType')} />}
              {b.filters.uploadedByMe && <Chip label="My uploads" onClear={() => b.clearFilter('uploadedByMe')} />}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-2xl mx-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-ink-3">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading your documents…
            </div>
          ) : b.rows.length === 0 ? (
            <p className="text-center text-body text-ink-3 py-16 m-0">
              {b.activeCount > 0 ? 'Nothing matches these filters.' : 'No documents yet. Use Scan to add your first one.'}
            </p>
          ) : (
            <>
              <p className="m-0 text-caption text-ink-3">
                {b.rows.length} of {b.total} document{b.total === 1 ? '' : 's'}
              </p>
              {groups.map((g) => (
                <div key={g.key}>
                  {g.label && <p className="m-0 mt-3 mb-1 text-caption font-semibold text-ink-2">{g.label} ({g.rows.length})</p>}
                  <ul className="list-none p-0 m-0 divide-y divide-line/50">
                    {g.rows.map((r) => <DocRow key={r.id} row={r} onOpen={onOpenDoc} />)}
                  </ul>
                </div>
              ))}
              <div ref={sentinelRef} />
              {b.loadingMore && (
                <div className="flex justify-center py-3"><Loader2 className="w-5 h-5 animate-spin text-ink-3" /></div>
              )}
              {!b.loadingMore && b.hasMore && (
                <button type="button" onClick={b.loadMore} className="mt-2 w-full min-h-touch rounded-xl bg-surface text-ink-2 font-semibold">
                  Show more
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {sheetOpen && (
        <Sheet title="Filters" onClose={() => setSheetOpen(false)}>
          <label className="text-body font-semibold text-ink" htmlFor="dw-m-f-type">Type</label>
          <input id="dw-m-f-type" className="dw-input" placeholder="e.g. invoice" value={draft.documentType ?? ''} onChange={(e) => setDraft((d) => ({ ...d, documentType: e.target.value || undefined }))} />

          <label className="text-body font-semibold text-ink" htmlFor="dw-m-f-stage">Status</label>
          <select id="dw-m-f-stage" className="dw-input" value={draft.stageBucket ?? ''} onChange={(e) => setDraft((d) => ({ ...d, stageBucket: (e.target.value || undefined) as BrowseFilters['stageBucket'] }))}>
            <option value="">Any status</option>
            <option value="verified">Verified</option>
            <option value="needs-review">Needs review</option>
            <option value="missing-info">Missing info</option>
          </select>

          <label className="text-body font-semibold text-ink" htmlFor="dw-m-f-warranty">Warranty</label>
          <select id="dw-m-f-warranty" className="dw-input" value={draft.warrantyBucket ?? ''} onChange={(e) => setDraft((d) => ({ ...d, warrantyBucket: (e.target.value || undefined) as BrowseFilters['warrantyBucket'] }))}>
            <option value="">Any warranty</option>
            <option value="expired">Expired</option>
            <option value="expiring">Expiring (90 days)</option>
            <option value="active">Active</option>
            <option value="unknown">No warranty on file</option>
          </select>

          <label className="text-body font-semibold text-ink" htmlFor="dw-m-f-site">Site / address</label>
          <input id="dw-m-f-site" className="dw-input" placeholder="Street address" value={draft.site ?? ''} onChange={(e) => setDraft((d) => ({ ...d, site: e.target.value || undefined }))} />

          <label className="flex items-center gap-2 text-body text-ink">
            <input type="checkbox" checked={!!draft.uploadedByMe} onChange={(e) => setDraft((d) => ({ ...d, uploadedByMe: e.target.checked || undefined }))} />
            My uploads only
          </label>

          <div className="flex items-center gap-2 pt-2">
            <button type="button" className="dw-btn-secondary flex-1" onClick={() => { setDraft({ sort: b.filters.sort }); }}>Clear</button>
            <button type="button" className="dw-btn-primary flex-1" onClick={applySheet}>Apply</button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} className="shrink-0 inline-flex items-center gap-1 min-h-8 px-3 rounded-full bg-surface-2 text-caption text-ink-2">
      {label} <X className="w-3 h-3" aria-hidden="true" />
    </button>
  )
}
