/**
 * TEAM H (2026-09-24): fair, deterministic per-tenant ROTATION for the
 * autonomous nightly learning loop (autopilot.js). Pure — no DB, no clock
 * reads (the caller passes `dateStr`) — so a cost/time-budget-truncated run
 * still makes steady, even progress across the whole tenant roster instead
 * of always favoring whichever tenants sort first.
 *
 * No persisted cursor: the roster is rotated by a pure function of the
 * UTC date, same idiom as scorecard/runner.js's own nightlySlice() (a
 * day-dependent starting offset, rather than a stored "where we left off"
 * row) — a tenant near the END of tonight's order is near the FRONT of some
 * other night's, and because the offset advances by exactly one position
 * per day, every tenant is guaranteed to reach position 0 (and therefore be
 * processed, budget permitting) at least once every `tenants.length` nights.
 */

/** A small, stable (non-cryptographic, FNV-1a) hash of a string -> 32-bit unsigned int. Pure. */
export function stableHash(s) {
  let h = 2166136261;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Days since the Unix epoch for a "YYYY-MM-DD" date string (UTC midnight). 0 for an unparseable input. */
export function dayNumber(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}

/**
 * Order `tenants` for `dateStr`'s nightly run: a cyclic rotation whose
 * offset advances by one every UTC day. Over any `tenants.length`
 * consecutive dates, every tenant occupies position 0 exactly once (and
 * every position 0..k for k consecutive dates), which is what gives the
 * "every tenant gets a turn at least every N nights" guarantee — see
 * unreachedOverNights below for the check that proves it.
 * @template T
 * @param {T[]} tenants  any array; only its length/order matter (not identity)
 * @param {string} dateStr  "YYYY-MM-DD"
 * @returns {T[]} a new array, same elements, rotated
 */
export function rotationForDate(tenants, dateStr) {
  const list = Array.isArray(tenants) ? tenants : [];
  const n = list.length;
  if (n < 2) return [...list];
  const offset = dayNumber(dateStr) % n;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

/**
 * Pure fairness proof for tests: simulate `nights` consecutive nights
 * starting at `startDateStr`, each night only reaching the first `perNight`
 * tenants of that night's rotation (the rest are left for a future night by
 * the caps/deadline). Returns the indices (of a synthetic `tenantCount`-
 * tenant roster) that were NEVER reached across every simulated night —
 * empty means fully fair.
 */
export function unreachedOverNights(tenantCount, startDateStr, nights, perNight) {
  const tenants = Array.from({ length: tenantCount }, (_, i) => i);
  const reached = new Set();
  const start = dayNumber(startDateStr);
  for (let d = 0; d < nights; d++) {
    const dateStr = new Date((start + d) * 86_400_000).toISOString().slice(0, 10);
    for (const t of rotationForDate(tenants, dateStr).slice(0, perNight)) reached.add(t);
  }
  const unreached = [];
  for (const t of tenants) if (!reached.has(t)) unreached.push(t);
  return unreached;
}
