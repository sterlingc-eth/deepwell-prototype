import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Download, FolderOpen, Loader2, Network, Search, Trash2, Users } from 'lucide-react';
import { downloadExportCsv } from '../services/exportClient';
import { AppShell } from '../components/AppShell';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { WarrantyStatusBadge } from '../components/WarrantyStatusBadge';
import { entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, fmtMoney, formatYmd, normalize, numOf, str } from '../core/answer';
import type { Entity } from '../core/types';
import { deleteDocuments } from '../services/documentClient';
import { CustomersScreen } from './CustomersScreen';
import { useAppStore } from '../store/appStore';
import { RecordsBrowser } from '../components/records/RecordsBrowser';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

type Kind = 'all' | 'property' | 'equipment' | 'service' | 'technician';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'property', label: 'Properties' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'service', label: 'Service visits' },
  { id: 'technician', label: 'Technicians' },
];

function haystack(e: Entity, g: ReturnType<typeof useGraph.getState>): string {
  // Every Date-valued entity field here is a bare calendar day (warranty
  // expiry, install date, a visit date) — formatYmd, not fmtDate, is what
  // keeps it timezone-safe (see core/answer.ts).
  const parts = Object.values(e.fields).map((v) => (v instanceof Date ? formatYmd(v) : v === null ? '' : String(v)));
  for (const key of ['propertyId', 'equipmentId', 'technicianId']) {
    const ref = g.entities[str(e, key)];
    if (ref) parts.push(str(ref, 'address'), str(ref, 'serial'), str(ref, 'name'));
  }
  return normalize(parts.join(' '));
}

/**
 * Documents tab: the records browser (round 12 contract — server-side
 * filter/sort/search/facets/paging, no 500 cap; see RecordsBrowser.tsx and
 * api/_lib/recordsStore.js's browseDocuments), plus CSV export and the typed
 * "empty this shop" wipe carried over from the previous client-side table.
 *
 * Row-level multi-select delete (the previous table's checkbox column) is
 * NOT carried over: it doesn't compose with server-side paging (a checked
 * row can scroll out of the loaded page) — "Empty this shop" below still
 * covers the one bulk-delete case the owner actually asked for. A single
 * document still deletes from inside its own preview (ReviewScreen).
 */
function DocumentsTab() {
  const docs = useGraph((s) => s.docs);
  const removeDoc = useGraph((s) => s.removeDoc);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const [error, setError] = useState<string | null>(null);
  const [emptyText, setEmptyText] = useState('');
  const [emptying, setEmptying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const runExport = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      await downloadExportCsv('documents');
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Could not download that export.');
    } finally {
      setExporting(false);
    }
  };

  const onOpenDocument = (id: string) => { openDocument(id); setCurrentScreen('review'); };

  const runEmpty = async () => {
    setEmptying(true);
    setError(null);
    try {
      const ids = Object.keys(docs);
      await deleteDocuments(ids);
      for (const id of ids) removeDoc(id);
      setEmptyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setEmptying(false);
    }
  };

  const totalCount = Object.keys(docs).length;

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}
      {exportErr && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{exportErr}</p>}

      <div className="flex justify-end">
        <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" disabled={exporting} onClick={() => void runExport()}>
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />} Export CSV
        </button>
      </div>

      <RecordsBrowser onOpenDocument={onOpenDocument} />

      {totalCount > 0 && (
        <div className="dw-card p-4 space-y-2 border-bad/30">
          <p className="font-medium text-bad-ink flex items-center gap-2"><Trash2 className="w-4 h-4" aria-hidden="true" /> Empty this shop's documents</p>
          <p className="text-body text-ink-2">
            Permanently deletes all {totalCount} document{totalCount === 1 ? '' : 's'} in this shop, along with their extracted fields and links. This can't be undone.
            Type <span className="font-mono">DELETE</span> to confirm.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="empty-confirm-input" className="sr-only">Type DELETE to confirm</label>
            <input
              id="empty-confirm-input"
              className="dw-input max-w-[10rem]"
              value={emptyText}
              onChange={(e) => setEmptyText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
            <button
              type="button"
              className="dw-btn-primary !bg-bad hover:!bg-bad"
              disabled={emptyText !== 'DELETE' || emptying}
              onClick={() => void runEmpty()}
            >
              {emptying ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
              {emptying ? 'Deleting…' : 'Empty documents'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Browse — Documents (records browser), Customers, Search and Graph tabs.
 */
export function BrowseScreen() {
  const graph = useGraph();
  const query = useAppStore((s) => s.searchQuery);
  const setQuery = useAppStore((s) => s.setSearchQuery);
  const openEntity = useAppStore((s) => s.openEntity);
  const askQuestion = useAppStore((s) => s.askQuestion);
  // Customers first (owner, 2026-09-20): the shop's people are the entry point; documents hang off them.
  const [mainTab, setMainTab] = useState<'documents' | 'customers' | 'search' | 'graph'>('customers');
  const [kind, setKind] = useState<Kind>('all');
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 120);
    return () => window.clearTimeout(t);
  }, [query]);

  // A kind that can never have data for a real tenant yet (the server has no
  // writer for property/customer/technician/service entities today — see
  // usePostgresSync.ts) shouldn't render as a selectable, permanently-empty
  // category. Demo mode is exempt: its fixture populates all of them.
  const visibleKinds = useMemo(
    () => KINDS.filter((k) => k.id === 'all' || DEMO_MODE || entitiesOfType(graph, k.id).length > 0),
    [graph],
  );
  useEffect(() => {
    if (kind !== 'all' && !visibleKinds.some((k) => k.id === kind)) setKind('all');
  }, [visibleKinds, kind]);

  const results = useMemo(() => {
    const q = normalize(debounced);
    const tokens = q.split(' ').filter(Boolean);
    const kinds: Kind[] = kind === 'all' ? (visibleKinds.filter((k) => k.id !== 'all').map((k) => k.id)) : [kind];
    const out: { e: Entity; score: number }[] = [];
    for (const k of kinds) {
      for (const e of entitiesOfType(graph, k)) {
        const h = haystack(e, graph);
        const score = tokens.length ? tokens.reduce((acc, t) => acc + (h.includes(t) ? 1 : 0), 0) : 1;
        if (tokens.length === 0 || score === tokens.length) out.push({ e, score });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 60);
  }, [debounced, kind, graph, visibleKinds]);

  const row = (e: Entity) => {
    const p = graph.entities[str(e, 'propertyId')];
    switch (e.type) {
      case 'property':
        return { title: str(e, 'address'), sub: `${str(e, 'customerName')} · ${str(e, 'city')}`, mono: false, badge: null };
      case 'equipment':
        return { title: str(e, 'serial'), sub: `${str(e, 'manufacturer')} ${str(e, 'equipmentType')} · ${str(e, 'model')} · ${p ? str(p, 'address') : ''}`, mono: true, badge: <WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(e, 'warrantyExpiry') }} /> };
      case 'service':
        return { title: str(e, 'workPerformed'), sub: `${formatYmd(dateOf(e, 'date'))} · ${str(e, 'technicianName')} · ${p ? str(p, 'address') : ''} · ${fmtMoney(numOf(e, 'cost'))}`, mono: false, badge: null };
      default:
        return { title: str(e, 'name'), sub: str(e, 'specialty'), mono: false, badge: null };
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1>Records</h1>
            <p className="text-ink-2 mt-1">Every property, unit, and document you have on file.</p>
          </div>
          {mainTab === 'search' && query.trim() && (
            <button type="button" className="dw-btn-secondary" onClick={() => askQuestion(query)}>
              Ask about this <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </header>

        <div role="tablist" aria-label="Records view" className="flex flex-wrap gap-1.5">
          {([
            { id: 'documents' as const, label: 'Documents', Icon: FolderOpen },
            { id: 'customers' as const, label: 'Customers', Icon: Users },
            { id: 'search' as const, label: 'Search', Icon: Search },
            { id: 'graph' as const, label: 'Graph', Icon: Network },
          ]).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={mainTab === t.id}
              onClick={() => setMainTab(t.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3', mainTab === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              <t.Icon className="w-4 h-4" aria-hidden="true" /> {t.label}
            </button>
          ))}
        </div>

        {mainTab === 'documents' ? (
          <DocumentsTab />
        ) : mainTab === 'customers' ? (
          <CustomersScreen />
        ) : mainTab === 'graph' ? (
          <KnowledgeGraph showSearch heading="DeepWell knowledge graph" />
        ) : (
          <div className="space-y-6">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
              <label htmlFor="browse-input" className="sr-only">Filter records</label>
              <input id="browse-input" className="dw-input !pl-12" placeholder="Filter by address, serial, model, technician, work…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
            </div>

            <div role="tablist" aria-label="Record type" className="flex flex-wrap gap-1.5">
              {visibleKinds.map((k) => (
                <button key={k.id} role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)} className={['dw-btn !min-h-[40px] !py-1.5 !px-3', kind === k.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}>
                  {k.label}
                </button>
              ))}
            </div>

            <ul className="divide-y divide-line border border-line rounded-lg bg-surface" aria-label="Results">
              {results.map(({ e }) => {
                const r = row(e);
                const typeLabel = graph.schema.entityTypes.find((t) => t.id === e.type)?.label ?? e.type;
                return (
                  <li key={e.id}>
                    <button type="button" onClick={() => openEntity(e.id)} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                      <span className="dw-pill-muted shrink-0 w-28 justify-center">{typeLabel}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-ink truncate ${r.mono ? 'font-mono text-data sm:text-body-lg' : 'font-medium'}`}>{r.title}</span>
                        <span className="block text-body text-ink-3 truncate">{r.sub}</span>
                      </span>
                      {r.badge}
                    </button>
                  </li>
                );
              })}
              {results.length === 0 && debounced.trim() === '' && kind === 'all' && (
                <li className="px-4 py-8 text-center text-ink-3">No properties or units yet. They'll appear here once you add documents in Inbox.</li>
              )}
              {results.length === 0 && !(debounced.trim() === '' && kind === 'all') && (
                <li className="px-4 py-8 text-center text-ink-3">No records match. Try fewer words, or <button type="button" className="underline underline-offset-4" onClick={() => askQuestion(query)}>ask it as a question</button>.</li>
              )}
            </ul>
            <p className="text-caption text-ink-3">{results.length} shown{results.length === 60 ? ' (first 60)' : ''}</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
