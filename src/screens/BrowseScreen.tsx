import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, FolderOpen, Loader2, Search, Trash2 } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { StagePill } from '../components/StagePill';
import { WarrantyStatusBadge } from '../components/WarrantyStatusBadge';
import { entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, fmtDate, fmtMoney, normalize, numOf, str } from '../core/answer';
import type { Doc, Entity } from '../core/types';
import { DOCUMENT_TYPES } from '../domains/hvac/documentTypes';
import { deleteDocuments } from '../services/documentClient';
import { useAppStore } from '../store/appStore';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

const DOCUMENT_TYPE_LABEL = new Map(DOCUMENT_TYPES.map((t) => [t.id, t.label]));

type Kind = 'all' | 'property' | 'equipment' | 'service' | 'technician';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'property', label: 'Properties' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'service', label: 'Service visits' },
  { id: 'technician', label: 'Technicians' },
];

function haystack(e: Entity, g: ReturnType<typeof useGraph.getState>): string {
  const parts = Object.values(e.fields).map((v) => (v instanceof Date ? fmtDate(v) : v === null ? '' : String(v)));
  for (const key of ['propertyId', 'equipmentId', 'technicianId']) {
    const ref = g.entities[str(e, key)];
    if (ref) parts.push(str(ref, 'address'), str(ref, 'serial'), str(ref, 'name'));
  }
  return normalize(parts.join(' '));
}

/** Best available "who/what this is about" label for a linked document. */
function linkedLabel(doc: Doc, entities: Record<string, Entity>): string {
  for (const id of doc.linkedEntityIds) {
    const e = entities[id];
    if (!e) continue;
    switch (e.type) {
      case 'customer': return str(e, 'name');
      case 'property': return str(e, 'address');
      case 'equipment': return str(e, 'serial') || str(e, 'model');
      default: return str(e, 'name') || e.type;
    }
  }
  return '';
}

type DocSort = 'date' | 'name' | 'type';

/**
 * Documents tab: every synced document in one table — filter, sort,
 * multi-select delete, and a typed "empty this shop" wipe. See the team
 * brief's DELETE CONTRACT. Documents that only exist locally (not yet
 * synced — no real server id) are included, but deleting them just drops
 * them from the local graph since the server has never heard of them.
 */
function DocumentsTab() {
  const docs = useGraph((s) => s.docs);
  const entities = useGraph((s) => s.entities);
  const removeDoc = useGraph((s) => s.removeDoc);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<DocSort>('date');
  const [sortDesc, setSortDesc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyText, setEmptyText] = useState('');
  const [emptying, setEmptying] = useState(false);

  const rows = useMemo(() => {
    const q = normalize(filter);
    let list = Object.values(docs).map((doc) => ({
      doc,
      typeLabel: (doc.typeId && DOCUMENT_TYPE_LABEL.get(doc.typeId)) || 'Unclassified',
      linked: linkedLabel(doc, entities),
    }));
    if (q) {
      list = list.filter(({ doc, typeLabel, linked }) =>
        normalize(`${doc.filename} ${typeLabel} ${linked}`).includes(q)
      );
    }
    list.sort((a, b) => {
      let cmp = 0;
      if (sort === 'date') cmp = a.doc.receivedAt.getTime() - b.doc.receivedAt.getTime();
      else if (sort === 'name') cmp = a.doc.filename.localeCompare(b.doc.filename);
      else cmp = a.typeLabel.localeCompare(b.typeLabel);
      return sortDesc ? -cmp : cmp;
    });
    return list;
  }, [docs, entities, filter, sort, sortDesc]);

  // Selection can only ever hold ids currently in view; a doc removed out
  // from under it (deleted elsewhere) should not linger as a phantom count.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => docs[id]));
      return next.size === prev.size ? prev : next;
    });
  }, [docs]);

  const toggleSort = (col: DocSort) => {
    if (sort === col) setSortDesc((d) => !d);
    else { setSort(col); setSortDesc(true); }
  };

  const sortIcon = (col: DocSort) =>
    sort === col ? (sortDesc ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />) : null;

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const allVisibleSelected = rows.length > 0 && rows.every(({ doc }) => selected.has(doc.id));
  const toggleAll = () =>
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map(({ doc }) => doc.id)));

  const runDelete = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await deleteDocuments(ids);
      for (const id of ids) removeDoc(id);
      setSelected(new Set());
      setConfirmingBulk(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const runEmpty = async () => {
    setEmptying(true);
    setError(null);
    try {
      const ids = Object.keys(docs);
      await deleteDocuments(ids);
      for (const id of ids) removeDoc(id);
      setEmptyText('');
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setEmptying(false);
    }
  };

  const totalCount = Object.keys(docs).length;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
        <label htmlFor="doc-filter-input" className="sr-only">Filter documents</label>
        <input
          id="doc-filter-input"
          className="dw-input !pl-12"
          placeholder="Filter by filename, type, customer, or equipment…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoComplete="off"
        />
      </div>

      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-ink-3">
          {rows.length} of {totalCount} document{totalCount === 1 ? '' : 's'}{selected.size ? ` · ${selected.size} selected` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            confirmingBulk ? (
              <span className="flex items-center gap-2">
                <span className="text-body text-ink-2">Delete {selected.size} document{selected.size === 1 ? '' : 's'}?</span>
                <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1" onClick={() => setConfirmingBulk(false)} disabled={busy}>Cancel</button>
                <button
                  type="button"
                  className="dw-btn-primary !min-h-[36px] !py-1 !bg-bad hover:!bg-bad"
                  onClick={() => void runDelete([...selected])}
                  disabled={busy}
                >
                  {busy ? 'Deleting…' : 'Confirm'}
                </button>
              </span>
            ) : (
              <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1 text-bad-ink" onClick={() => setConfirmingBulk(true)}>
                <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete selected
              </button>
            )
          )}
        </div>
      </div>

      <div className="overflow-x-auto border border-line rounded-lg bg-surface">
        <table className="w-full text-left text-body">
          <thead>
            <tr className="border-b border-line text-caption text-ink-3">
              <th className="px-3 py-2 w-10">
                <input type="checkbox" aria-label="Select all shown" checked={allVisibleSelected} onChange={toggleAll} />
              </th>
              <th className="px-3 py-2">
                <button type="button" className="flex items-center gap-1" onClick={() => toggleSort('name')}>Filename {sortIcon('name')}</button>
              </th>
              <th className="px-3 py-2">
                <button type="button" className="flex items-center gap-1" onClick={() => toggleSort('type')}>Type {sortIcon('type')}</button>
              </th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">Customer / equipment</th>
              <th className="px-3 py-2">
                <button type="button" className="flex items-center gap-1" onClick={() => toggleSort('date')}>Received {sortIcon('date')}</button>
              </th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ doc, typeLabel, linked }) => (
              <tr key={doc.id} className="hover:bg-surface-2">
                <td className="px-3 py-2 align-top">
                  <input type="checkbox" aria-label={`Select ${doc.filename}`} checked={selected.has(doc.id)} onChange={() => toggleOne(doc.id)} />
                </td>
                <td className="px-3 py-2 align-top max-w-[16rem] truncate" title={doc.filename}>{doc.filename}</td>
                <td className="px-3 py-2 align-top">{typeLabel}</td>
                <td className="px-3 py-2 align-top"><StagePill stage={doc.stage} ai={doc.verifiedBy === 'ai'} compact /></td>
                <td className="px-3 py-2 align-top text-ink-2">{linked || '—'}</td>
                <td className="px-3 py-2 align-top text-ink-2 whitespace-nowrap">{fmtDate(doc.receivedAt)}</td>
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2"
                    onClick={() => { openDocument(doc.id); setCurrentScreen('review'); }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-3">
                  {totalCount === 0 ? 'No documents yet.' : 'No documents match this filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
 * Browse — Documents (default) and Records tabs. Documents lists every
 * synced document with bulk delete; Records is the plain entity list for
 * scanning rather than asking.
 */
export function BrowseScreen() {
  const graph = useGraph();
  const query = useAppStore((s) => s.searchQuery);
  const setQuery = useAppStore((s) => s.setSearchQuery);
  const openEntity = useAppStore((s) => s.openEntity);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const [mainTab, setMainTab] = useState<'documents' | 'records'>('documents');
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
        return { title: str(e, 'workPerformed'), sub: `${fmtDate(dateOf(e, 'date'))} · ${str(e, 'technicianName')} · ${p ? str(p, 'address') : ''} · ${fmtMoney(numOf(e, 'cost'))}`, mono: false, badge: null };
      default:
        return { title: str(e, 'name'), sub: str(e, 'specialty'), mono: false, badge: null };
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1>Browse</h1>
            <p className="text-ink-2 mt-1">Every document, or a plain list, when you'd rather scan than ask.</p>
          </div>
          {mainTab === 'records' && query.trim() && (
            <button type="button" className="dw-btn-secondary" onClick={() => askQuestion(query)}>
              Ask this instead <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </header>

        <div role="tablist" aria-label="Browse view" className="flex flex-wrap gap-1.5">
          {([
            { id: 'documents' as const, label: 'Documents', Icon: FolderOpen },
            { id: 'records' as const, label: 'Records', Icon: Search },
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
              {results.length === 0 && <li className="px-4 py-8 text-center text-ink-3">No records match. Try fewer words, or <button type="button" className="underline underline-offset-4" onClick={() => askQuestion(query)}>ask it as a question</button>.</li>}
            </ul>
            <p className="text-caption text-ink-3">{results.length} shown{results.length === 60 ? ' (first 60)' : ''}</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
