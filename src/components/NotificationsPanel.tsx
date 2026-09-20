import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useAppStore } from '../store/appStore';
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
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openEntity = useAppStore((s) => s.openEntity);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const refresh = useCallback(() => {
    fetchNotifications()
      .then((res) => {
        setItems(res.items);
        setUnreadCount(res.unreadCount);
        setLoaded(true);
      })
      .catch(() => {
        /* silent — the bell just doesn't update this cycle */
      });
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

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
      setUnreadCount((n) => Math.max(0, n - 1));
      markNotificationsRead([item.id]).catch(() => {});
    }
    const { entityId } = parseNotificationLink(item.link);
    if (entityId) openEntity(entityId);
    else setCurrentScreen('dashboard');
    setOpen(false);
  };

  const handleMarkAllRead = () => {
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    markAllNotificationsRead().catch(() => {});
  };

  const badge = unreadBadgeLabel(unreadCount);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
          className="absolute right-0 top-full mt-2 w-80 max-w-[90vw] z-50 dw-card p-0 overflow-hidden shadow-lift"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <span className="text-body font-medium text-ink">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={handleMarkAllRead} className="text-caption text-ink-2 hover:text-ink underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!loaded && <p className="px-4 py-6 text-caption text-ink-3 text-center">Loading…</p>}
            {loaded && items.length === 0 && (
              <p className="px-4 py-6 text-caption text-ink-3 text-center">Nothing needs your attention.</p>
            )}
            {items.map((item) => (
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
        </div>
      )}
    </div>
  );
}
