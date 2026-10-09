// Pure helpers behind the Inbox's live import progress panel (src/components/intake/ImportProgressPanel.tsx).
// Kept free of React and the network so scripts/verify-import-progress.ts can check them directly.

/** Minutes left at the current pace, or null when there is no pace yet (nothing read in the last 10 minutes). */
export function minutesLeft(pending: number, readLast10m: number): number | null {
  if (!(pending > 0)) return 0;
  if (!(readLast10m > 0)) return null;
  return Math.ceil(pending / (readLast10m / 10));
}

/** "less than a minute", "about 7 minutes", "about 1 hour", "about 2 hours 30 minutes" (rounded to 10 minutes past an hour). */
export function formatTimeLeft(min: number): string {
  if (min <= 1) return 'less than a minute';
  if (min < 60) return `about ${min} minutes`;
  const rounded = Math.round(min / 10) * 10;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `about ${hours} ${m} minutes` : `about ${hours}`;
}

export function fmtCount(n: number): string {
  return Math.max(0, Math.trunc(n)).toLocaleString('en-US');
}
