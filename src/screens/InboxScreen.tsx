import { AppShell } from '../components/AppShell';
import { useGraph } from '../core/entityGraph';
import { useAppStore } from '../store/appStore';
import { IntakeBody } from './IntakeScreen';
import { ReviewBody, needsPersonCount } from './ReviewScreen';

/**
 * Inbox = "the pile I have to work through," in two tabs: Add files (today's
 * Intake) and Needs a person (today's separate Review screen/route). One nav
 * item, one mental model, instead of a review queue buried as a secondary
 * button on Intake with no door of its own.
 *
 * `currentScreen` stays 'ingest' for both tabs — the tab itself lives in
 * `inboxTab` (see store/appStore.ts) — and the retired 'review' screen id is
 * kept as an alias there so every existing `setCurrentScreen('review')` /
 * `openDocument` call site still lands on this tab correctly.
 */
export function InboxScreen() {
  const graph = useGraph();
  const inboxTab = useAppStore((s) => s.inboxTab);
  const setInboxTab = useAppStore((s) => s.setInboxTab);
  const badge = needsPersonCount(graph.docs);

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1>Inbox</h1>
          <p className="text-ink-2 mt-1">Add paperwork and clear what needs your attention.</p>
        </header>

        <div role="tablist" aria-label="Inbox view" className="flex flex-wrap gap-1.5">
          {([
            { id: 'add' as const, label: 'Add files' },
            { id: 'needs-person' as const, label: 'Needs a person', count: badge },
          ]).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={inboxTab === t.id}
              onClick={() => setInboxTab(t.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3 text-body-lg', inboxTab === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              {t.label}
              {t.count !== undefined && <span className="font-mono text-caption opacity-80">{t.count}</span>}
            </button>
          ))}
        </div>

        {inboxTab === 'add' ? <IntakeBody /> : <ReviewBody />}
      </div>
    </AppShell>
  );
}
