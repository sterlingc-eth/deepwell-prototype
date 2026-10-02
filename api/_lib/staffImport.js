/**
 * R43: STAFF IMPORT override (pure, no imports, so recordsStore.js and plan.js can both use it without a cycle).
 * See the long comment on staffImportFor below; plan.js re-exports everything here.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * R43: STAFF IMPORT override. DeepWell staff (never the customer) switch it on for ONE company by pasting
 * M3-config/import/I1-allow-staff-import.sql, which writes tenants.limits.staffImport:
 *   { from, until, pages, documents?, ingestPerMinute?, ingestPerDay?, maxModelCallsPerDay?, endedAt? }   (ISO-8601 UTC strings)
 * While it is ACTIVE (from <= now < end) the company, on ANY plan that is otherwise in good standing:
 *   - may create and use API keys (the staff import tool signs in with one),
 *   - uploads against a dedicated import page budget (`pages`) instead of the monthly page allowance, and may store
 *     `documents` more documents than the plan allows,
 *   - gets the larger upload-rate and daily model-call ceilings named in the override.
 * Pages read inside the window are NOT counted against the customer's monthly allowance, now or later (see
 * recordsStore.js countPagesSince), so a backfill neither consumes nor is blocked by the monthly allowance.
 * `end` is the earliest of: `until`, `endedAt` (set by I2), and from + 60 days, so a pasted year-2099 date cannot leave
 * it on forever. After `end` the grant is inert but the window is kept, only so its pages stay out of the monthly count.
 * Customers cannot write tenants.limits through any API route (verify-r43-import-tool.mjs proves it); migration 66 makes
 * billing_apply() carry the key across Stripe webhook events. Anything malformed means NO grant.
 */
export const STAFF_IMPORT_KEY = 'staffImport';
export const STAFF_IMPORT_MAX_DAYS = 60;
/**
 * Server-side CEILINGS, whatever the pasted numbers say: a typo with extra zeros in I1 (or a hand-edited row) can raise a
 * limit only this far, so the page budget and the model-call budgets can never be turned into "no cap". I1 refuses numbers
 * above these too (same values), so the two agree.
 */
export const STAFF_IMPORT_CEILINGS = Object.freeze({
  pages: 1_000_000, documents: 1_000_000, ingestPerMinute: 2_000, ingestPerDay: 1_000_000,
  maxModelCallsPerDay: 500_000, maxModelCalls: 4_000_000,
});
/** Whole positive numbers only: a JSON number or a string of digits. Booleans, arrays, objects, 0, negatives, NaN, fractions all deny. */
const posInt = (v, max) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : null;
};
/** ISO-8601 with an explicit zone (Z or +hh:mm): a zone-less value would be read in the server's local time, so it denies. */
const isoDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * "Now" for every staff-import decision is the DATABASE's clock, not this server's: whenever the app reads the database
 * (tenant context, key creation, key use, the model budget) it hands the database's now() to noteDatabaseClock(), and the
 * difference from this machine's clock is remembered (capped at one day). A server whose clock has drifted can therefore
 * neither extend an import past its end nor end it early. Before the first reading the difference is zero.
 */
let dbClockSkewMs = 0;
export function noteDatabaseClock(dbNow) {
  const t = dbNow instanceof Date ? dbNow.getTime() : typeof dbNow === 'string' ? Date.parse(dbNow) : NaN;
  if (Number.isFinite(t)) dbClockSkewMs = Math.max(-DAY_MS, Math.min(DAY_MS, t - Date.now()));
}
export function staffImportNow() { return new Date(Date.now() + dbClockSkewMs); }
/** Test-only. */
export function _resetDatabaseClock() { dbClockSkewMs = 0; }
/**
 * @param {{limits?: object|null}|null|undefined} tenantRow
 * @param {Date} [now]
 * @returns {null|{from: Date, end: Date, active: boolean, pages: number, documents: number, maxModelCalls: number,
 *   ingestPerMinute: number|null, ingestPerDay: number|null, maxModelCallsPerDay: number|null}}
 */
export function staffImportFor(tenantRow, now = staffImportNow()) {
  const raw = tenantRow?.limits?.[STAFF_IMPORT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const from = isoDate(raw.from);
  const until = isoDate(raw.until);
  const pages = posInt(raw.pages, STAFF_IMPORT_CEILINGS.pages);
  if (!from || !until || !pages) return null;
  let end = new Date(Math.min(until.getTime(), from.getTime() + STAFF_IMPORT_MAX_DAYS * DAY_MS));
  // A close marker that is present but unreadable still means "closed" (fail closed): the grant is off, the window stays.
  const hasEndedAt = raw.endedAt !== undefined && raw.endedAt !== null;
  const endedAt = hasEndedAt ? isoDate(raw.endedAt) : null;
  if (endedAt && endedAt.getTime() < end.getTime()) end = endedAt;
  return {
    from,
    end,
    active: !(hasEndedAt && !endedAt) && now.getTime() >= from.getTime() && now.getTime() < end.getTime(),
    pages,
    documents: posInt(raw.documents, STAFF_IMPORT_CEILINGS.documents) ?? 0,
    ingestPerMinute: posInt(raw.ingestPerMinute, STAFF_IMPORT_CEILINGS.ingestPerMinute),
    ingestPerDay: posInt(raw.ingestPerDay, STAFF_IMPORT_CEILINGS.ingestPerDay),
    maxModelCallsPerDay: posInt(raw.maxModelCallsPerDay, STAFF_IMPORT_CEILINGS.maxModelCallsPerDay),
    // Whole-import hard stop on model calls (retries that read no page do not move the page budget, so they need their own
    // ceiling): default 4 per budgeted page, never above the ceiling.
    maxModelCalls: posInt(raw.maxModelCalls, STAFF_IMPORT_CEILINGS.maxModelCalls) ?? Math.min(pages * 4, STAFF_IMPORT_CEILINGS.maxModelCalls),
  };
}

/** The window whose pages stay out of the monthly page count: {from, to} as ISO strings, or null (no staff import on file). */
export function staffImportWindowFor(tenantRow) {
  const imp = staffImportFor(tenantRow);
  return imp ? { from: imp.from.toISOString(), to: imp.end.toISOString() } : null;
}

