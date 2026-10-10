/**
 * Pure rules for hiding "Needs attention" rows. A person can hide a row two ways:
 *  - Dismiss: hidden until the number on that row changes (new items appear, or old ones are fixed).
 *  - Snooze 7 days: hidden until the date passes, whatever the number does.
 * Kept free of React and storage so scripts/verify-dashboard-alerts.ts can test it directly.
 */
export type HideMode = 'dismiss' | 'snooze';
export interface HideEntry { mode: HideMode; count: number; until?: string }
export type HiddenMap = Record<string, HideEntry>;

export const SNOOZE_DAYS = 7;

/** YYYY-MM-DD in local time. */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function snoozeUntil(from: Date, days = SNOOZE_DAYS): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return ymd(d);
}

/** True while this insight should stay out of the main list. */
export function isHidden(entry: HideEntry | undefined, count: number, today: string): boolean {
  if (!entry) return false;
  if (entry.mode === 'snooze') return !!entry.until && today < entry.until;
  return entry.count === count;
}

export function hide(map: HiddenMap, id: string, mode: HideMode, count: number, now: Date): HiddenMap {
  const entry: HideEntry = mode === 'snooze' ? { mode, count, until: snoozeUntil(now) } : { mode, count };
  return { ...map, [id]: entry };
}

export function restore(map: HiddenMap, id: string): HiddenMap {
  const next = { ...map };
  delete next[id];
  return next;
}

export function splitHidden<T extends { id: string; count: number }>(items: T[], map: HiddenMap, today: string): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const it of items) (isHidden(map[it.id], it.count, today) ? hidden : visible).push(it);
  return { visible, hidden };
}
