/**
 * Donovan claim-check (R11) — date parsing/comparison, format-normalized (build spec item 2: "dates
 * (format-normalized)"). Pure, no Intl/timezone dependence: every date is handled as plain {y,m,d}
 * integers so "2027-03-15", "3/15/2027" and "March 15, 2027" all compare equal regardless of which
 * format the answer text used versus which format the cited source used.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function ymd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** Parse one date-looking token/phrase in any of the formats the fixtures cover:
 *  ISO (2027-03-15), US slash (3/15/2027 or 03/15/2027), and "Month D[,] YYYY" / "D Month YYYY".
 *  Returns {y,m,d} or null. */
export function parseDateLoose(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return ymd(m[3], m[1], m[2]);

  m = s.match(/^([a-zA-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(m[3], MONTHS[m[1].toLowerCase()], m[2]);

  m = s.match(/^(\d{1,2})\s+([a-zA-Z]{3,9})\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return ymd(m[3], MONTHS[m[2].toLowerCase()], m[1]);

  return null;
}

export function toIsoDate(d) {
  if (!d) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
}

/** Two date-looking strings, in possibly different formats, refer to the same calendar day. */
export function datesEqual(a, b) {
  const da = parseDateLoose(a);
  const db = parseDateLoose(b);
  return Boolean(da && db && da.y === db.y && da.m === db.m && da.d === db.d);
}

/** Whole-day difference `to - from` (positive = `to` is in the future of `from`), or null if either
 *  side does not parse as a plausible calendar date. */
export function daysBetween(fromLoose, toLoose) {
  const a = parseDateLoose(fromLoose);
  const b = parseDateLoose(toLoose);
  if (!a || !b) return null;
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86_400_000);
}

/**
 * Derive the status word an expiry/due date implies as of `today`, for the two status families the
 * build spec calls out ("under warranty / expired", "overdue"). Returns null when it cannot be
 * determined (unparseable date), never a guess.
 */
export function deriveStatus(kind, dateLoose, todayLoose) {
  const diff = daysBetween(todayLoose, dateLoose); // date - today
  if (diff == null) return null;
  if (kind === "invoice") return diff < 0 ? "overdue" : "current";
  // warranty (default): folds "expiring soon" into "active" here — this module only needs to tell
  // expired from not-expired; the finer expiring-30/90/365 tiers are warrantyRules.js's job, not a
  // claim-support judgement.
  return diff < 0 ? "expired" : "active";
}
