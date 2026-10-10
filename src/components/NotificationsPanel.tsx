import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useUiPrefs } from '../services/uiPrefs';
import { ALERT_FILTERS, groupAlerts, type AlertsFilterId } from '../services/alertGroups';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  parseNotificationLink,
  unreadBadgeLabel,
  type NotificationItem,
} from '../services/notifyClient';

/** How often the bell polls while the app is open (ms). Cheap: one small
 *  GET, and only while a tab is actually open — see the visibility guard
 *  below. */
const POLL_MS = 5 * 60 * 1000;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Bell icon + unread badge (AppShell, next to Billing) and its dropdown.
 * Polls GET /api/account?action=notifications every 5 minutes while the tab
 * is visible; clicking an item marks it read and navigates in-app via
 * appStore's `openEntity` (same pattern every other entity link in this app
 * uses — no page reload).
 */
export function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  // Startup performance (handoffs/STARTUP_PERF_R13.md): seeded from the one
  // bootstrap round trip App.tsx already fires on load (useBootstrap.ts) —
  // an instant, real badge count instead of waiting on this component's own
  // GET /api/account?action=notifications, which used to fire immediately
  // on mount as one more of the five staggered startup requests.
  const bootstrapUnread = useAppStore((s) => s.notificationsUnread);
  const bootstrapStatus = useAppStore((s) => s.bootstrapStatus);
  // null until this panel's own fetch (or a local mark-read/mark-all-read)
  // sets a real count — rendered as `bootstrapUnread` until then, derived
  // during render rather than mirrored into state via an effect.
  const [ownUnreadCount, setOwnUnreadCount] = useState<number | null>(null);
  const unreadCount = ownUnreadCount ?? bootstrapUnread;
  const [loaded, setLoaded] = useState(false);
  // Read notifications leave the list (they are done); "Show earlier notifications" brings them back for a look.
  const [showRead, setShowRead] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // On a phone the bell can wrap to the left of a second header row, so a right-anchored 20rem panel would run off the
  // left edge. Below the sm breakpoint the panel is pinned to the screen edges, just under the bell instead.
  const [phoneTop, setPhoneTop] = useState(0);
  const [prefs, updatePrefs] = useUiPrefs();
  const collapsedMap = prefs.alerts?.collapsed ?? {};
  const filter: AlertsFilterId = prefs.alerts?.filter ?? 'all';
  const setAlertsPrefs = (next: { collapsed?: Record<string, boolean>; filter?: AlertsFilterId }) =>
    updatePrefs({ alerts: { collapsed: next.collapsed ?? collapsedMap, filter: next.filter ?? filter } });
  const openEntity = useAppStore((s) => s.openEntity);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const openOutreach = useAppStore((s) => s.openOutreach);
  const setPendingWorkFilter = useAppStore((s) => s.setPendingWorkFilter);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const refresh = useCallback(() => {
    fetchNotifications()
      .then((res) => {
        setItems(res.items);
        setOwnUnreadCount(res.unreadCount);
        setLoaded(true);
      })
      .catch(() => {
        /* silent — the bell just doesn't update this cycle */
      });
  }, []);

  // Cross-tenant isolation (reviewer NO-GO, 2026-09-26): useBootstrap.ts
  // flips `bootstrapStatus` back to 'idle' the instant it detects a
  // same-tab tenant switch (OrganizationSwitcher, no reload — see its own
  // doc comment). This panel's OWN item list must clear right along with
  // it, or a previous tenant's notification titles/bodies would sit in
  // this component's state until its next poll/open. Genuinely
  // synchronizing with that external signal, not deriving it during
  // render, hence the effect.
  useEffect(() => {
    if (bootstrapStatus === 'idle') {
      // eslint-disable-next-line react/set-state-in-effect
      setItems([]);
      // eslint-disable-next-line react/set-state-in-effect
      setOwnUnreadCount(null);
      // eslint-disable-next-line react/set-state-in-effect
      setLoaded(false);
    }
  }, [bootstrapStatus]);

  // Fetch the full item list the moment the tray is actually opened, if it
  // hasn't loaded yet.
  useEffect(() => {
    if (open && !loaded) refresh();
  }, [open, loaded, refresh]);

  // Lazy, not eager (handoffs/STARTUP_PERF_R13.md): the badge already has a
  // real count from bootstrap, so this only needs to fetch the full list on
  // its own if nobody ever opens the tray. Two fallbacks keep this from
  // silently staying empty forever: bootstrap itself failing outright (an
  // older deployed API without the bootstrap action — same eager fetch this
  // component always did before this change), or, belt-and-suspenders, a
  // few seconds of nobody opening it.
  useEffect(() => {
    if (loaded) return;
    if (bootstrapStatus === 'error') {
      refresh();
      return;
    }
    const t = window.setTimeout(refresh, 4000);
    return () => window.clearTimeout(t);
  }, [loaded, bootstrapStatus, refresh]);

  useEffect(() => {
    if (!loaded) return; // first load is handled above (on open, on error, or the timeout fallback)
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loaded, refresh]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleItemClick = (item: NotificationItem) => {
    if (!item.readAt) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)));
      setOwnUnreadCount((n) => Math.max(0, (n ?? bootstrapUnread) - 1));
      markNotificationsRead([item.id]).catch(() => {});
    }
    // Mirrors useDeepLink.ts's own branching so every notification kind
    // (outreach, follow-ups, an entity mention, ...) lands where its link
    // actually points, not just the ?entity= case — see notifyClient.ts's
    // parseNotificationLink doc comment for the bug this replaced.
    const target = parseNotificationLink(item.link);
    if (target.entityId) openEntity(target.entityId);
    else if (target.customerRef) openCustomer(target.customerRef);
    else if (target.screen === 'outreach') openOutreach(target.outreachEquipmentId);
    else if (target.screen) {
      if (target.workFilter) setPendingWorkFilter(target.workFilter);
      setCurrentScreen(target.screen);
    } else setCurrentScreen('dashboard');
    setOpen(false);
  };

  const handleMarkAllRead = () => {
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    setOwnUnreadCount(0);
    markAllNotificationsRead().catch(() => {});
  };

  const badge = unreadBadgeLabel(unreadCount);
  const readCount = items.filter((i) => i.readAt).length;
  const groups = groupAlerts(items, filter, Date.now(), showRead);
  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => { setPhoneTop((containerRef.current?.getBoundingClientRect().bottom ?? 0) + 8); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        className="relative inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
      >
        <Bell className="w-5 h-5" aria-hidden="true" />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-brass-400 text-forest-900 text-[10px] font-bold leading-4 text-center"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          style={phoneTop ? { top: phoneTop } : undefined}
          className="fixed left-3 right-3 sm:absolute sm:left-auto sm:right-0 sm:!top-full sm:mt-2 sm:w-80 max-w-[calc(100vw-1.5rem)] z-50 dw-card p-0 overflow-hidden shadow-lift"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <span className="text-body font-medium text-ink">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={handleMarkAllRead} className="text-caption text-ink-2 hover:text-ink underline">
                Mark all read
              </button>
            )}
          </div>
          <div role="group" aria-label="Show alerts" className="flex items-center gap-1.5 px-4 py-2 border-b border-line">
            <span className="text-caption text-ink-3">Show:</span>
            {ALERT_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setAlertsPrefs({ filter: f.id })}
                className={['min-h-touch sm:min-h-[32px] px-2.5 rounded-md text-caption', filter === f.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!loaded && <p className="px-4 py-6 text-caption text-ink-3 text-center">Loading…</p>}
            {loaded && visibleCount === 0 && (
              <p className="px-4 py-6 text-caption text-ink-3 text-center">
                {filter === 'all' ? 'Nothing needs your attention.' : filter === 'unread' ? 'No unread alerts.' : 'No alerts from the last 7 days.'}
              </p>
            )}
            {groups.map((g) => {
              const isCollapsed = !!collapsedMap[g.kind];
              return (
                <section key={g.kind} aria-label={g.label}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={`alerts-group-${g.kind}`}
                    onClick={() => setAlertsPrefs({ collapsed: { ...collapsedMap, [g.kind]: !isCollapsed } })}
                    className="w-full min-h-touch flex items-center gap-2 px-4 py-2 bg-surface-2 border-b border-line text-left hover:bg-surface-3"
                  >
                    {isCollapsed ? <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" /> : <ChevronDown className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />}
                    <span className="flex-1 text-caption font-medium text-ink">{g.label}</span>
                    {g.unread > 0 && <span className="dw-pill-info">{g.unread} new</span>}
                    <span className="text-caption text-ink-3">{g.items.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div id={`alerts-group-${g.kind}`}>
                      {g.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="menuitem"
                          onClick={() => handleItemClick(item)}
                          className={[
                            'w-full text-left px-4 py-3 border-b border-line last:border-0 hover:bg-surface-2 transition-colors duration-quick',
                            item.readAt ? '' : 'bg-info-bg/40',
                          ].join(' ')}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-body font-medium text-ink">{item.title}</span>
                            {!item.readAt && <span aria-hidden="true" className="w-2 h-2 rounded-full bg-brass-400 mt-1.5 shrink-0" />}
                          </div>
                          {item.body && <p className="text-caption text-ink-2 mt-0.5">{item.body}</p>}
                          <p className="text-caption text-ink-3 mt-1">{timeAgo(item.createdAt)}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          {loaded && readCount > 0 && filter === 'all' && (
            <div className="px-4 py-2 border-t border-line">
              <button type="button" onClick={() => setShowRead((v) => !v)} className="text-caption text-ink-2 hover:text-ink underline">
                {showRead ? 'Hide earlier notifications' : 'Show earlier notifications'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
