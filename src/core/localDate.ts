/**
 * The device's LOCAL calendar date as YYYY-MM-DD. `new Date().toISOString().slice(0, 10)` is the UTC date, which
 * for a shop in Arizona (UTC-7) becomes tomorrow after 5 pm local time and put warranty / registration windows
 * off by one every evening (R30 M10). Pure; pass `now` to test.
 */
export function localYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
