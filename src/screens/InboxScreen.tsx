import { useState } from 'react';
import { AppShell } from '../components/AppShell';
import { useGraph } from '../core/entityGraph';
import { useAppStore } from '../store/appStore';
import { IntakeBody } from './IntakeScreen';
import { ReviewBody, needsPersonCount } from './ReviewScreen';
import { IntakeQueuePanel } from '../components/intake/IntakeQueuePanel';

/** The store only knows about the two tabs it always has ('add'/'needs-person' —
 *  store/appStore.ts's own `inboxTab`, which Dashboard's tiles and other screens navigate to
 *  directly via `openInboxNeedsPerson`). "Needs a decision" (Round 13, H2) is a third, purely
 *  LOCAL tab layered on top rather than a change to that store: it never needs to be the target
 *  of a deep link from elsewhere yet, and keeping it local means every existing
 *  `setInboxTab('needs-person')` call site keeps working untouched. `lastStoreTab` mirrors the
 *  store's own value each render (adjusted during render, not in an effect — React's own pattern
 *  for "state derived from a changing external value") so an external "open Needs a person"
 *  navigation still lands correctly even while this screen is showing the local-only tab. */
type UiTab = 'add' | 'needs-person' | 'decide';

export function InboxScreen() {
  const graph = useGraph();
  const storeTab = useAppStore((s) => s.inboxTab);
  const setStoreTab = useAppStore((s) => s.setInboxTab);
  const [tab, setTab] = useState<UiTab>(storeTab);
  const [lastStoreTab, setLastStoreTab] = useState(storeTab);
  const badge = needsPersonCount(graph.docs);

  if (storeTab !== lastStoreTab) {
    setLastStoreTab(storeTab);
    setTab(storeTab);
  }

  const selectTab = (t: UiTab) => {
    setTab(t);
    if (t !== 'decide') setStoreTab(t);
  };

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
            { id: 'decide' as const, label: 'Needs a decision' },
            { id: 'needs-person' as const, label: 'Needs a person', count: badge },
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

        {tab === 'add' ? <IntakeBody /> : tab === 'decide' ? <IntakeQueuePanel /> : <ReviewBody />}
      </div>
    </AppShell>
  );
}
