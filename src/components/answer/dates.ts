/**
 * Round 12 answer-presentation dates: "Jun 12, 2025 (3 months ago)". Pure, no DOM — shared by the
 * hero components in this folder. Deliberately separate from FactGrid's own (older) date helpers,
 * which stay as they are to avoid re-testing that file's existing breakdown-table behavior.
 */

/** "Jun 12, 2025" from a YYYY-MM-DD (or any Date-parseable) string, day-of-month only (no time). */
export function humanDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}/.test(value) ? `${value.slice(0, 10)}T00:00:00` : value) : value;
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "3 months ago" / "in 4 months" / "today" — null once it is far enough out (24mo+) that a bare date
 *  reads better than a big number, matching FactGrid's own relativeDateNote threshold. */
export function relativeNote(value: string | Date, now: Date = new Date()): string | null {
  const d = typeof value === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}/.test(value) ? `${value.slice(0, 10)}T00:00:00` : value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  const months = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  const future = days > 0;
  const absMonths = Math.abs(months);
  if (absMonths === 0) return future ? `in ${days} day${days === 1 ? '' : 's'}` : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (absMonths >= 24) return null;
  return future ? `in ${absMonths} month${absMonths === 1 ? '' : 's'}` : `${absMonths} month${absMonths === 1 ? '' : 's'} ago`;
}

/** "Jun 12, 2025 (3 months ago)" — the combined form the contract asks every date to render as. */
export function humanDateWithRelative(value: string | Date, now: Date = new Date()): string {
  const abs = humanDate(value);
  const rel = relativeNote(value, now);
  return rel ? `${abs} (${rel})` : abs;
}
