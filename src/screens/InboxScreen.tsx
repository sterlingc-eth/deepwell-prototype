import { useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { useGraph } from '../core/entityGraph';
import { useAppStore } from '../store/appStore';
import { IntakeBody } from './IntakeScreen';
import { ReviewBody, needsPersonCount } from './ReviewScreen';
import { FILTERS, type Filter } from './reviewFilters';
import { IntakeQueuePanel } from '../components/intake/IntakeQueuePanel';

/** The store only knows about the two tabs it always has ('add'/'needs-person' —
 *  store/appStore.ts's own `inboxTab`, which Dashboard's tiles and other screens navigate to
 *  directly via `openInboxNeedsPerson`). `lastStoreTab` mirrors the store's own value each
 *  render (adjusted during render, not in an effect — React's own pattern for "state derived
 *  from a changing external value") so an external "open Needs a person" navigation still
 *  lands correctly even while this screen shows whichever local tab it was last on. */
type UiTab = 'add' | 'needs';

/** One entry in the merged "Needs you" chip row — either the autofill-exception queue
 *  (round 13's "Needs a decision", server-backed) or one of ReviewBody's 9 document filters. */
type Chip = 'decisions' | Filter;

/**
 * Inbox (round 17, U2 top fixes #8/#9): used to be 3 top-level tabs — Add
 * files / Needs a decision / Needs a person — with "Needs a person" carrying
 * its OWN second tier of 9 filter chips underneath. Clearing every kind of
 * open intake work meant clicking through two independent tab systems with
 * different visual treatments (pill tabs, then filter chips) and no single
 * place that said how much work was open before you drilled in.
 *
 * Now: 2 tabs (Add files / Needs you), and "Needs you" is ONE chip row —
 * "Decisions" (autofill exceptions IntakeQueuePanel already tracked) plus
 * the same 9 filters ReviewBody always had, hoisted up here so they render
 * together instead of ReviewBody drawing its own second row underneath.
 * Nothing any of the 3 old tabs could do is gone — every one of those chips
 * still opens the exact same panel it always did, just from one row.
 */
export function InboxScreen() {
  const graph = useGraph();
  const storeTab = useAppStore((s) => s.inboxTab);
  const setStoreTab = useAppStore((s) => s.setInboxTab);
  const pendingReviewFilter = useAppStore((s) => s.pendingReviewFilter);
  const [tab, setTab] = useState<UiTab>(storeTab === 'needs-person' ? 'needs' : 'add');
  const [lastStoreTab, setLastStoreTab] = useState(storeTab);
  const [chip, setChip] = useState<Chip>('attention');
  const [counts, setCounts] = useState<Record<Filter, number> | null>(null);
  const badge = needsPersonCount(graph.docs);

  if (storeTab !== lastStoreTab) {
    setLastStoreTab(storeTab);
    setTab(storeTab === 'needs-person' ? 'needs' : 'add');
  }

  // A deep link (a Dashboard tile) that arrives with a specific document
  // filter must land somewhere ReviewBody is actually mounted to consume it
  // — if "Decisions" happened to be the selected chip already, hop back to
  // the default filter chip first so that hand-off never gets silently
  // dropped (ReviewBody's own effect then applies the exact filter it asked for).
  useEffect(() => {
    if (pendingReviewFilter && chip === 'decisions') setChip('attention');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReviewFilter]);

  const selectTab = (t: UiTab) => {
    setTab(t);
    setStoreTab(t === 'needs' ? 'needs-person' : 'add');
  };

  // The "Money to check" chip only appears once there's something in it (or
  // it's already the active one) — same rule ReviewBody's own row used to
  // apply, just read here from the counts it now reports up.
  const visibleFilters = FILTERS.filter((f) => f.id !== 'money' || (counts?.money ?? 0) > 0 || chip === 'money');

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1>Inbox</h1>
          <p className="text-ink-2 mt-1">Add paperwork, answer what autofill couldn't, and clear what needs your attention.</p>
        </header>

        <div role="tablist" aria-label="Inbox view" className="flex flex-wrap gap-1.5">
          {([
            { id: 'add' as const, label: 'Add files' },
            { id: 'needs' as const, label: 'Needs you', count: badge > 0 ? badge : undefined },
          ]).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3 text-body-lg', tab === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              {t.label}
              {t.count !== undefined && <span className="font-mono text-caption opacity-80">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'add' ? (
          <IntakeBody />
        ) : (
          <div className="space-y-6">
            <div role="tablist" aria-label="Needs you filters" className="flex flex-wrap gap-1.5">
              <button
                type="button"
                role="tab"
                aria-selected={chip === 'decisions'}
                onClick={() => setChip('decisions')}
                className={['dw-btn !min-h-[40px] !py-1.5 !px-3 text-body-lg', chip === 'decisions' ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
              >
                Decisions
              </button>
              {visibleFilters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={chip === f.id}
                  onClick={() => setChip(f.id)}
                  className={['dw-btn !min-h-[40px] !py-1.5 !px-3 text-body-lg', chip === f.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
                >
                  {f.label} {counts && <span className="font-mono text-caption opacity-80">{counts[f.id]}</span>}
                </button>
              ))}
            </div>

            {chip === 'decisions' ? (
              <IntakeQueuePanel />
            ) : (
              <ReviewBody filter={chip} onFilterChange={setChip} onCounts={setCounts} />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
