/**
 * Retention: which nightly snapshot dates to KEEP. Pure.
 *   keepDaily   the newest N snapshots (default 7)
 *   keepWeekly  the newest snapshot of each of the last N ISO weeks (default 4)
 *   keepMonthly the newest snapshot of each of the last N calendar months (default 12)
 * A snapshot kept by any rule is kept. The newest snapshot is always kept, whatever the numbers say.
 * Dates are "YYYY-MM-DD" (UTC).
 */
export const DEFAULT_RETENTION = Object.freeze({ keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });

export function retentionFromEnv(env = process.env) {
  const n = (v, d) => { const x = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(x) && x >= 0 && x <= 3650 ? x : d; };
  return {
    keepDaily: Math.max(1, n(env.BACKUP_KEEP_DAILY, DEFAULT_RETENTION.keepDaily)),
    keepWeekly: n(env.BACKUP_KEEP_WEEKLY, DEFAULT_RETENTION.keepWeekly),
    keepMonthly: n(env.BACKUP_KEEP_MONTHLY, DEFAULT_RETENTION.keepMonthly),
  };
}

/** ISO week label "YYYY-Www" for a YYYY-MM-DD date. */
export function isoWeekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // the Thursday of this week decides the year
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** @param {string[]} dates  @returns {{keep: string[], drop: string[]}} both sorted newest first */
export function selectRetention(dates, policy = DEFAULT_RETENTION) {
  const sorted = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  const keep = new Set();
  sorted.slice(0, Math.max(1, policy.keepDaily)).forEach((d) => keep.add(d));
  const weeks = new Map(); const months = new Map();
  for (const d of sorted) { // newest first, so the first seen per bucket is the newest in it
    const w = isoWeekKey(d); if (!weeks.has(w)) weeks.set(w, d);
    const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d);
  }
  [...weeks.values()].slice(0, policy.keepWeekly).forEach((d) => keep.add(d));
  [...months.values()].slice(0, policy.keepMonthly).forEach((d) => keep.add(d));
  return { keep: sorted.filter((d) => keep.has(d)), drop: sorted.filter((d) => !keep.has(d)) };
}
