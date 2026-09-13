import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { WarrantyStatusBadge } from '../components/WarrantyStatusBadge';
import { entitiesOfType, useGraph } from '../core/entityGraph';
import { dateOf, fmtDate, fmtMoney, normalize, numOf, str } from '../core/answer';
import type { Entity } from '../core/types';
import { useAppStore } from '../store/appStore';

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

/**
 * Browse records — the secondary view. Plain filtering over the entity graph
 * when you'd rather scan a list than ask. Every row opens the record; the
 * query can be sent to Ask in one tap.
 */
export function BrowseScreen() {
  const graph = useGraph();
  const query = useAppStore((s) => s.searchQuery);
  const setQuery = useAppStore((s) => s.setSearchQuery);
  const openEntity = useAppStore((s) => s.openEntity);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const [kind, setKind] = useState<Kind>('all');
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 120);
    return () => window.clearTimeout(t);
  }, [query]);

  const results = useMemo(() => {
    const q = normalize(debounced);
    const tokens = q.split(' ').filter(Boolean);
    const kinds: Kind[] = kind === 'all' ? ['property', 'equipment', 'service', 'technician'] : [kind];
    const out: { e: Entity; score: number }[] = [];
    for (const k of kinds) {
      for (const e of entitiesOfType(graph, k)) {
        const h = haystack(e, graph);
        const score = tokens.length ? tokens.reduce((acc, t) => acc + (h.includes(t) ? 1 : 0), 0) : 1;
        if (tokens.length === 0 || score === tokens.length) out.push({ e, score });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 60);
  }, [debounced, kind, graph]);

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
            <h1>Browse records</h1>
            <p className="text-ink-2 mt-1">A plain list, when you'd rather scan than ask.</p>
          </div>
          {query.trim() && (
            <button type="button" className="dw-btn-secondary" onClick={() => askQuestion(query)}>
              Ask this instead <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </header>

        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-3" aria-hidden="true" />
          <label htmlFor="browse-input" className="sr-only">Filter records</label>
          <input id="browse-input" className="dw-input !pl-12" placeholder="Filter by address, serial, model, technician, work…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </div>

        <div role="tablist" aria-label="Record type" className="flex flex-wrap gap-1.5 dark:gap-2">
          {KINDS.map((k) => (
            <button key={k.id} role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)} className={['dw-btn min-h-[40px] !py-1.5 !px-3', kind === k.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}>
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
                  <span className="dw-pill-muted shrink-0 min-w-[7rem] justify-center">{typeLabel}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-ink truncate ${r.mono ? 'font-mono text-data sm:text-body-lg' : 'font-medium'}`}>{r.title}</span>
                    <span className="block text-body text-ink-3 truncate">{r.sub}</span>
                  </span>
                  {r.badge}
                </button>
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="px-4 py-8 text-center text-ink-3 space-y-2">
              <p>No records match. Try fewer words, or ask it as a question.</p>
              <button type="button" className="dw-btn-tertiary" onClick={() => askQuestion(query)}>Ask this as a question <ArrowRight className="w-4 h-4" aria-hidden="true" /></button>
            </li>
          )}
        </ul>
        <p className="text-caption text-ink-3">{results.length} shown{results.length === 60 ? ' (first 60)' : ''}</p>
      </div>
    </AppShell>
  );
}
