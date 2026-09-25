import { memo, useDeferredValue, useMemo, useState } from 'react'
import { AlertTriangle, FileText, Image as ImageIcon, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { useGraph } from '../core/entityGraph'
import { useWorkFilter } from '../hooks/useWorkFilter'
import type { SyncStatus } from '../hooks/usePostgresSync'
import type { Doc, Entity, EntityId } from '../core/types'
import { customerName, customerOf, formatDate, searchText, typeLabel } from './docUtils'

type Filter = 'all' | 'mine' | 'warranty' | 'attention'
const PAGE = 40
/** api records listDocuments caps at the newest 500 (recordsStore.js). */
const SERVER_DOC_CAP = 500

const DocRow = memo(function DocRow({ doc, entities, onOpen }: { doc: Doc; entities: Record<EntityId, Entity>; onOpen: (id: string) => void }) {
  const name = customerName(customerOf(doc, entities))
  const Icon = (doc.typeId ?? '').includes('warranty') ? ShieldCheck : doc.fileType === 'image' ? ImageIcon : FileText
  return (
    <li>
      <button type="button" onClick={() => onOpen(doc.id)} className="w-full min-h-touch text-left flex items-center gap-3 px-1 py-3">
        <Icon className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <span className="block text-body font-semibold text-ink truncate">{name || doc.filename}</span>
          <span className="block text-caption text-ink-3 truncate">
            {typeLabel(doc.typeId)} · {formatDate(doc.receivedAt)}
          </span>
        </span>
        {doc.issues.length > 0 && <AlertTriangle className="w-4 h-4 text-warn shrink-0" aria-label="Needs info" />}
      </button>
    </li>
  )
})

export function DocsTab({
  syncStatus,
  onOpenDoc,
  onRefresh,
}: {
  syncStatus: SyncStatus
  onOpenDoc: (id: string) => void
  onRefresh: () => Promise<void>
}) {
  const docsById = useGraph((s) => s.docs)
  const entities = useGraph((s) => s.entities)
  const allDocs = useMemo(() => Object.values(docsById).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()), [docsById])
  const work = useWorkFilter(allDocs)

  const [query, setQuery] = useState('')
  // Typing stays instant on low-end phones; the filter catches up a frame later.
  const deferredQuery = useDeferredValue(query)
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [refreshing, setRefreshing] = useState(false)

  const index = useMemo(() => new Map(allDocs.map((d) => [d.id, searchText(d, entities)])), [allDocs, entities])

  const visible = useMemo(() => {
    const terms = deferredQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return allDocs.filter((d) => {
      if (filter === 'mine' && !work.isMine(d)) return false
      if (filter === 'warranty' && !(d.typeId ?? '').includes('warranty')) return false
      if (filter === 'attention' && d.issues.length === 0) return false
      if (!terms.length) return true
      const hay = index.get(d.id) ?? ''
      return terms.every((t) => hay.includes(t))
    })
  }, [allDocs, filter, deferredQuery, index, work])

  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...(work.hasShop ? [{ id: 'mine' as const, label: 'My work' }] : []),
    { id: 'warranty', label: 'Warranties' },
    { id: 'attention', label: 'Needs info' },
  ]

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const loading = (syncStatus === 'loading' || syncStatus === 'idle') && allDocs.length === 0

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 bg-bg">
        <div className="max-w-2xl mx-auto px-4 pt-3 short:pt-1.5">
          <div className="relative">
            <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <label htmlFor="dw-m-search" className="sr-only">
              Search documents
            </label>
            <input
              id="dw-m-search"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(PAGE)
              }}
              placeholder="Customer, address, serial…"
              enterKeyHint="search"
              autoComplete="off"
              className="w-full h-12 short:h-11 rounded-xl bg-surface-2 text-ink pl-10 pr-3 placeholder:text-ink-3 border border-transparent focus:outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center gap-2 py-2 overflow-x-auto no-scrollbar -mx-4 px-4">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={filter === c.id}
                onClick={() => {
                  setFilter(c.id)
                  setLimit(PAGE)
                }}
                className={`shrink-0 min-h-11 px-4 rounded-full text-caption font-semibold ${
                  filter === c.id ? 'bg-accent text-forest-950' : 'bg-surface text-ink-2'
                }`}
              >
                {c.label}
              </button>
            ))}
            <button type="button" onClick={() => void refresh()} aria-label="Refresh documents" className="shrink-0 ml-auto w-11 h-11 flex items-center justify-center text-ink-3">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-2xl mx-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-ink-3">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading your documents…
            </div>
          ) : visible.length === 0 ? (
            <p className="text-center text-body text-ink-3 py-16 m-0">
              {allDocs.length === 0 ? 'No documents yet. Use Scan to add your first one.' : 'Nothing matches. Try Ask — Donovan searches everything.'}
            </p>
          ) : (
            <>
              <p className="m-0 text-caption text-ink-3">
                {visible.length} document{visible.length === 1 ? '' : 's'}
              </p>
              <ul className="list-none p-0 m-0 divide-y divide-line/50">
                {visible.slice(0, limit).map((d) => (
                  <DocRow key={d.id} doc={d} entities={entities} onOpen={onOpenDoc} />
                ))}
              </ul>
              {visible.length > limit && (
                <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="mt-2 w-full min-h-touch rounded-xl bg-surface text-ink-2 font-semibold">
                  Show more
                </button>
              )}
              {allDocs.length >= SERVER_DOC_CAP && visible.length <= limit && (
                <p className="m-0 mt-3 text-caption text-ink-3 text-center">Showing your newest {SERVER_DOC_CAP} documents. Ask Donovan to find older ones.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
