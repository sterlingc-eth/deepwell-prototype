import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Building2, CreditCard, Database, FileText, Inbox as InboxIcon, LayoutDashboard,
  Search, Sparkles, UserCog, Users, Users2, Wrench,
} from 'lucide-react';
import { entitiesOfType, useGraph } from '../../core/entityGraph';
import { str } from '../../core/answer';
import { documentName } from '../../core/documentName';
import { useAppStore, type Screen } from '../../store/appStore';
import { DocumentPreview } from '../DocumentPreview';
import { fuzzyScoreAny } from './fuzzy';

/** One row in the palette's result list — a screen jump, a record to open,
 *  or the "Ask Donovan" fallback. `run` is whatever navigating there means:
 *  a store action for a screen/record, or opening the Donovan overlay
 *  (which the store has no screen id for — see DonovanScreen.tsx's file
 *  comment) via the callback AppShell passes in. */
interface Row {
  id: string;
  group: 'Screens' | 'Customers' | 'Addresses' | 'Units' | 'Service visits' | 'Technicians' | 'Documents' | 'Ask';
  title: string;
  subtitle?: string;
  icon: ComponentType<{ className?: string }>;
  score: number;
  run: () => void;
}

const GROUP_ORDER: Row['group'][] = ['Screens', 'Customers', 'Addresses', 'Units', 'Service visits', 'Technicians', 'Documents', 'Ask'];
const PER_GROUP_CAP = 5;

interface CommandPaletteProps {
  /** Admin/operator-only, same gate the Team/Donovan buttons use — a plain
   *  member never sees "Team" or "Donovan" as jump targets, same as they
   *  don't see the buttons themselves in the account row. */
  isAdmin: boolean;
  /** Opens the Donovan overlay (AppShell owns that toggle — see its file
   *  comment on why Donovan isn't a `Screen` id). */
  onOpenDonovan: () => void;
  /** Only DeepWell operators get the Donovan screen; customers never see this jump target. */
  showDonovan?: boolean;
}

/**
 * ⌘K / Ctrl+K jump-to (round 17, U2 top fix #5 + the Records "Search" tab's
 * fold-in, top fix #7). Keyboard-only, fuzzy, and reads ONLY data the app
 * already has in memory — the entity graph (customers/properties/units/
 * service visits/technicians all sync from Postgres the same way BrowseScreen
 * and EntityScreen already read them) and the synced documents — so opening
 * this never fires a new network request. "Ask Donovan: <text>" is always
 * the last row: whatever you typed that didn't match a record can still be
 * asked as a question, in one more keystroke.
 *
 * Replaces BrowseScreen's old standalone "Search" tab, which covered
 * property/equipment/service/technician but — a real gap the audit called
 * out — never customers. This covers all five, from anywhere in the app,
 * not only from Records, in 0 mouse clicks (⌘K, type, Enter).
 */
export function CommandPalette({ isAdmin, onOpenDonovan, showDonovan = false }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const graph = useGraph();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openEntity = useAppStore((s) => s.openEntity);
  const openDocument = useAppStore((s) => s.openDocument);
  const askQuestion = useAppStore((s) => s.askQuestion);

  // Global shortcut: Cmd+K (Mac) / Ctrl+K (everyone else). Esc closes.
  // preventDefault matters here specifically for Ctrl/Cmd+K — several
  // browsers bind that combo to the address bar otherwise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus after the overlay actually paints, not on the same tick as the
      // keydown that opened it (that keydown is still bubbling).
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const close = () => setOpen(false);

  const openScreen = (screen: Screen) => { setCurrentScreen(screen); close(); };
  const openRecord = (entityId: string) => { openEntity(entityId); close(); };
  const openDoc = (docId: string) => { openDocument(docId); setPreviewDocId(docId); close(); };
  const runAsk = (text: string) => { askQuestion(text); close(); };

  const results = useMemo<Row[]>(() => {
    const q = query.trim();
    const rows: Row[] = [];

    const screenTargets: { screen: Screen; label: string; icon: ComponentType<{ className?: string }> }[] = [
      { screen: 'ask', label: 'Ask Donovan', icon: Sparkles },
      { screen: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { screen: 'ingest', label: 'Inbox', icon: InboxIcon },
      { screen: 'browse', label: 'Records', icon: Database },
      { screen: 'billing', label: 'Billing', icon: CreditCard },
    ];
    for (const t of screenTargets) {
      const score = fuzzyScoreAny(q, [t.label]);
      if (score !== null) rows.push({ id: `screen-${t.screen}`, group: 'Screens', title: t.label, icon: t.icon, score: score + 100, run: () => openScreen(t.screen) });
    }
    if (isAdmin) {
      const teamScore = fuzzyScoreAny(q, ['Team']);
      if (teamScore !== null) rows.push({ id: 'screen-team', group: 'Screens', title: 'Team', icon: Users, score: teamScore + 100, run: () => openScreen('team') });
    }
    if (showDonovan) {
      const donovanScore = fuzzyScoreAny(q, ['Donovan', 'Donovan misses', 'Donovan learning', 'Search by meaning']);
      if (donovanScore !== null) rows.push({ id: 'screen-donovan', group: 'Screens', title: 'Donovan (admin)', subtitle: 'Misses, learning, search by meaning', icon: Sparkles, score: donovanScore + 100, run: () => { onOpenDonovan(); close(); } });
    }

    for (const e of entitiesOfType(graph, 'customer')) {
      const name = str(e, 'name') || 'Unnamed customer';
      const score = fuzzyScoreAny(q, [name]);
      if (score !== null) rows.push({ id: `customer-${e.id}`, group: 'Customers', title: name, subtitle: str(e, 'type') || undefined, icon: Users2, score, run: () => openRecord(e.id) });
    }
    for (const e of entitiesOfType(graph, 'property')) {
      const address = str(e, 'address');
      if (!address) continue;
      const score = fuzzyScoreAny(q, [address, str(e, 'customerName'), str(e, 'city')]);
      if (score !== null) rows.push({ id: `property-${e.id}`, group: 'Addresses', title: address, subtitle: [str(e, 'customerName'), str(e, 'city')].filter(Boolean).join(' · '), icon: Building2, score, run: () => openRecord(e.id) });
    }
    for (const e of entitiesOfType(graph, 'equipment')) {
      const serial = str(e, 'serial');
      if (!serial) continue;
      const p = graph.entities[str(e, 'propertyId')];
      const score = fuzzyScoreAny(q, [serial, str(e, 'manufacturer'), str(e, 'model'), p ? str(p, 'address') : '']);
      if (score !== null) {
        rows.push({
          id: `equipment-${e.id}`,
          group: 'Units',
          title: serial,
          subtitle: [str(e, 'manufacturer'), str(e, 'model'), p ? str(p, 'address') : null].filter(Boolean).join(' · '),
          icon: Wrench,
          score: score + 20, // a serial lookup is the flagship task for this palette — win close ties
          run: () => openRecord(e.id),
        });
      }
    }
    for (const e of entitiesOfType(graph, 'technician')) {
      const name = str(e, 'name');
      if (!name) continue;
      const score = fuzzyScoreAny(q, [name, str(e, 'specialty')]);
      if (score !== null) rows.push({ id: `tech-${e.id}`, group: 'Technicians', title: name, subtitle: str(e, 'specialty') || undefined, icon: UserCog, score, run: () => openRecord(e.id) });
    }
    for (const e of entitiesOfType(graph, 'service')) {
      const work = str(e, 'workPerformed');
      if (!work) continue;
      const p = graph.entities[str(e, 'propertyId')];
      const score = fuzzyScoreAny(q, [work, str(e, 'technicianName'), p ? str(p, 'address') : '']);
      if (score !== null) rows.push({ id: `service-${e.id}`, group: 'Service visits', title: work, subtitle: [str(e, 'technicianName'), p ? str(p, 'address') : null].filter(Boolean).join(' · '), icon: Wrench, score, run: () => openRecord(e.id) });
    }
    if (q.length >= 2) {
      for (const d of Object.values(graph.docs)) {
        const name = documentName(d);
        const score = fuzzyScoreAny(q, [name, d.filename]);
        if (score !== null) rows.push({ id: `doc-${d.id}`, group: 'Documents', title: name, subtitle: d.filename !== name ? d.filename : undefined, icon: FileText, score, run: () => openDoc(d.id) });
      }
    }

    // Group, cap, sort by score within a group, then flatten in GROUP_ORDER.
    const byGroup = new Map<Row['group'], Row[]>();
    for (const r of rows) {
      const list = byGroup.get(r.group) ?? [];
      list.push(r);
      byGroup.set(r.group, list);
    }
    const out: Row[] = [];
    for (const g of GROUP_ORDER) {
      const list = (byGroup.get(g) ?? []).sort((a, b) => b.score - a.score).slice(0, PER_GROUP_CAP);
      out.push(...list);
    }
    // The fallback row — always present once there's something to ask, never counted against a group's cap.
    if (q) out.push({ id: 'ask-fallback', group: 'Ask', title: `Ask Donovan: "${q}"`, icon: Sparkles, score: 0, run: () => runAsk(q) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, graph, isAdmin, showDonovan]);

  useEffect(() => setActiveIndex(0), [query]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[activeIndex]?.run(); }
  };

  let lastGroup: string | null = null;

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-20 sm:pt-28" role="presentation">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-forest-950/60 dark:bg-black/70"
            onClick={close}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Jump to"
            className="relative w-full max-w-xl dw-card !shadow-lift overflow-hidden flex flex-col max-h-[70vh]"
          >
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="w-5 h-5 text-ink-3 shrink-0" aria-hidden="true" />
              <label htmlFor="dw-command-input" className="sr-only">Jump to a customer, address, serial, document, or screen</label>
              <input
                id="dw-command-input"
                ref={inputRef}
                className="flex-1 min-h-touch bg-transparent text-body-lg text-ink placeholder:text-ink-3 focus:outline-none"
                placeholder="Jump to a customer, address, serial, document, or screen…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                autoComplete="off"
                role="combobox"
                aria-expanded="true"
                aria-controls="dw-command-results"
                aria-activedescendant={results[activeIndex] ? `dw-command-row-${results[activeIndex].id}` : undefined}
              />
              <kbd className="hidden sm:inline text-caption text-ink-3 border border-line rounded px-1.5 py-0.5">Esc</kbd>
            </div>

            <ul id="dw-command-results" role="listbox" className="overflow-y-auto py-1">
              {results.length === 0 && (
                <li className="px-4 py-6 text-center text-ink-3 text-body">
                  {query.trim() ? 'Nothing matches — try a serial, an address, or a customer name.' : 'Start typing to jump anywhere.'}
                </li>
              )}
              {results.map((r, i) => {
                const showHeading = r.group !== lastGroup;
                lastGroup = r.group;
                return (
                  <li key={r.id}>
                    {showHeading && (
                      <p className="px-4 pt-2 pb-1 text-caption font-medium text-ink-3 uppercase tracking-wide">{r.group}</p>
                    )}
                    <button
                      type="button"
                      id={`dw-command-row-${r.id}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => r.run()}
                      className={[
                        'w-full text-left flex items-center gap-3 px-4 py-2.5 min-h-touch transition-colors duration-quick',
                        i === activeIndex ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'text-ink hover:bg-surface-2',
                      ].join(' ')}
                    >
                      <r.icon className="w-4 h-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.title}</span>
                        {r.subtitle && <span className={`block truncate text-caption ${i === activeIndex ? 'opacity-80' : 'text-ink-3'}`}>{r.subtitle}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-line px-4 py-2 flex items-center gap-3 text-caption text-ink-3">
              <span>↑↓ navigate</span>
              <span>Enter select</span>
              <span>Esc close</span>
            </div>
          </div>
        </div>
      )}

      {previewDocId && <DocumentPreview documentId={previewDocId} onClose={() => setPreviewDocId(null)} />}
    </>
  );
}
