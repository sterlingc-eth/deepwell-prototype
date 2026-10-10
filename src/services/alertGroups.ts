/** Pure grouping and filtering for the alerts (bell) list, so scripts/verify-dashboard-alerts.ts can test it with no DOM. */
import type { NotificationItem } from './notifyClient';

export type AlertsFilterId = 'all' | 'unread' | 'week';
export const ALERT_FILTERS: { id: AlertsFilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'week', label: 'This week' },
];

const KIND_LABEL: Record<string, string> = {
  warranty: 'Warranties',
  outreach: 'Outreach',
  followup: 'Follow-ups',
  import: 'Imports',
};

/** A plain heading for a notification kind; unknown kinds get a tidy version of their own name. */
export function kindLabel(kind: string): string {
  if (KIND_LABEL[kind]) return KIND_LABEL[kind];
  const t = kind.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Other';
}

const WEEK_MS = 7 * 86400000;

export function matchesFilter(item: NotificationItem, filter: AlertsFilterId, nowMs: number, showEarlier = false): boolean {
  if (filter === 'unread') return !item.readAt;
  if (filter === 'week') return nowMs - new Date(item.createdAt).getTime() <= WEEK_MS;
  return showEarlier || !item.readAt;
}

export interface AlertGroup { kind: string; label: string; items: NotificationItem[]; unread: number }

/** Groups by kind, newest activity first; items keep their incoming order inside a group. */
export function groupAlerts(items: NotificationItem[], filter: AlertsFilterId, nowMs: number, showEarlier = false): AlertGroup[] {
  const map = new Map<string, AlertGroup>();
  for (const it of items) {
    if (!matchesFilter(it, filter, nowMs, showEarlier)) continue;
    const g = map.get(it.kind) ?? { kind: it.kind, label: kindLabel(it.kind), items: [], unread: 0 };
    g.items.push(it);
    if (!it.readAt) g.unread++;
    map.set(it.kind, g);
  }
  return [...map.values()].sort((a, b) => b.unread - a.unread || a.label.localeCompare(b.label));
}
