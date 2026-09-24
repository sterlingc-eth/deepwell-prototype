/**
 * OWNERS-ONLY EXPENSE TRACKER (handoffs/EXPENSES_2026-09-22.md): DeepWell's
 * own business expenses — software, AI/cloud spend, travel, etc. Never a
 * tenant's data, never visible to a customer. Platform-level (no tenant_id),
 * same reasoning as api/_lib/learning/store.js's own header for
 * donovan_proposals/donovan_learned.
 *
 * Three layers, same split as missDigest.js / learning/store.js:
 *   - Pure functions (amount parsing, category validation, CSV building, date
 *     range resolution, totals shaping) — no DB, no network, unit-tested by
 *     scripts/verify-expenses.mjs with zero fixtures.
 *   - Thin SECURITY DEFINER wrappers (list/insert/update/delete/totals) —
 *     a plain getPool() connection (no withTenant; nothing here is
 *     tenant-scoped), one console.warn the first time a call fails (migration
 *     M3-config/28-expenses.sql not applied yet), and an empty/false/null
 *     return from then on rather than a throw — same tolerance contract as
 *     every other cross-tenant/platform table in this codebase.
 *
 * This file is the only place in the codebase that touches
 * platform_expenses directly — api/_lib/routes/expenses.js (the HTTP
 * surface, gated by isPlatformOperator BEFORE any of this runs) is its only
 * caller.
 */
import { getPool } from './recordsStore.js';

/** The fixed category list — a CHECK constraint on platform_expenses enforces
 *  the same set server-side, so a caller can never persist a category not in
 *  this list (an insert/update with a bad one is rejected here, before the
 *  DB even sees it, so it fails with a clean 400 rather than a raw Postgres
 *  constraint-violation 500). */
export const EXPENSE_CATEGORIES = Object.freeze([
  'Software & Subscriptions',
  'AI & Cloud Services',
  'Office Equipment',
  'Professional Services',
  'Marketing',
  'Vehicle & Transportation',
  'Travel & Meals',
  'Office & Operations',
  'Insurance',
  'Taxes & Fees',
  'Other',
]);

export function isValidExpenseCategory(category) {
  return EXPENSE_CATEGORIES.includes(category);
}

/* --------------------------------------------------------- amount parsing */

/**
 * "$1,234.50" / "(45.00)" / "21.66" / 21.66 -> integer cents (negative for a
 * parenthesized amount, the common accounting convention for a refund/
 * credit). Pure. Returns null for anything that doesn't parse — the caller
 * decides whether that's a 400.
 * @param {string|number} raw
 * @returns {number|null}
 */
export function parseAmountToCents(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const cleaned = s.replace(/[()$,\s-]/g, '');
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return negative ? -cents : cents;
}

/** Integer cents -> a plain "1234.50" / "-45.00" string, no currency symbol
 *  or thousands separator (CSV cells are safer plain). Pure. */
export function centsToDollarString(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}${(Math.abs(n) / 100).toFixed(2)}`;
}

/* --------------------------------------------------------------- CSV -- */

/** Standard CSV field escaping: quote a field that contains a comma, quote,
 *  or newline, doubling any embedded quotes. Pure. */
export function csvEscapeField(value) {
  let s = String(value ?? '');
  // Formula-injection guard (reviewer, 2026-09-22): a cell starting with
  // = + - @ (or a tab/CR that Excel treats as one) would execute as a formula
  // when the owner opens the export in Excel/Sheets. Prefix with a single
  // quote so it renders as text — the standard OWASP CSV mitigation.
  // A plain signed number ("-45.00", a refund) is data, not a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Hard ceiling on a single expense: $1,000,000.00. Anything above is a
 *  typo or a parsing accident, never a real DeepWell expense. */
export const MAX_EXPENSE_CENTS = 100_000_000;

export const EXPENSE_CSV_HEADERS = Object.freeze(['Date', 'Vendor', 'Amount', 'Currency', 'Category', 'Note', 'Receipt Filename', 'receipt_on_file']);

/**
 * expenses_list()'s row shape -> a CSV string (CRLF line endings, header
 * row first). Pure. @param {object[]} rows
 */
export function buildExpensesCsv(rows) {
  const lines = [EXPENSE_CSV_HEADERS.map(csvEscapeField).join(',')];
  for (const r of rows ?? []) {
    lines.push(
      [
        r.occurred_on ?? '',
        r.vendor ?? '',
        centsToDollarString(r.amount_cents),
        r.currency ?? 'USD',
        r.category ?? '',
        r.note ?? '',
        r.receipt_filename ?? '',
        r.receipt_key ? 'yes' : 'no',
      ]
        .map(csvEscapeField)
        .join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** occurred_on comes back from node-postgres as a JS Date (local midnight);
 *  tests/fixtures pass strings. Either -> 'YYYY-MM-DD'. Pure. */
export function ymdOf(v) {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v ?? '').slice(0, 10);
}

/** Row with occurred_on normalized to a plain date string. Pure. */
export function normalizeExpenseRow(r) {
  return { ...r, occurred_on: ymdOf(r.occurred_on) };
}

/** Every receipt lives under this prefix in R2 (route's receiptUploadUrl). */
export const RECEIPT_KEY_PREFIX = 'platform/expenses/';

/** A receipt key is viewable/attachable only if it is under our prefix and
 *  has no path tricks. Pure. */
export function isOwnedReceiptKey(key) {
  return typeof key === 'string' && key.startsWith(RECEIPT_KEY_PREFIX) && key.length > RECEIPT_KEY_PREFIX.length && !key.includes('..');
}

/**
 * Running monthly log: rows (any range) -> the months of `year`, newest
 * first, each with total, count, top categories (highest first) and its
 * rows (newest first). Pure. Months with no expenses are omitted.
 * @param {object[]} rows expenses_list() rows
 * @param {number|string} year
 */
export function aggregateMonthly(rows, year) {
  const prefix = `${year}-`;
  const months = new Map();
  for (const raw of rows ?? []) {
    const r = normalizeExpenseRow(raw);
    if (!r.occurred_on.startsWith(prefix)) continue;
    const month = r.occurred_on.slice(0, 7);
    const m = months.get(month) ?? { month, totalCents: 0, count: 0, cats: new Map(), items: [] };
    const cents = Number(r.amount_cents) || 0;
    m.totalCents += cents;
    m.count += 1;
    m.cats.set(r.category, (m.cats.get(r.category) ?? 0) + cents);
    m.items.push(r);
    months.set(month, m);
  }
  const out = [...months.values()].map((m) => ({
    month: m.month,
    totalCents: m.totalCents,
    count: m.count,
    topCategories: [...m.cats.entries()]
      .map(([category, totalCents]) => ({ category, totalCents }))
      .sort((a, b) => b.totalCents - a.totalCents)
      .slice(0, 3),
    items: m.items.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on)),
  }));
  out.sort((a, b) => b.month.localeCompare(a.month));
  return { year: Number(year), yearTotalCents: out.reduce((n, m) => n + m.totalCents, 0), yearCount: out.reduce((n, m) => n + m.count, 0), months: out };
}

/** 'YYYY-MM' -> {from,to} calendar-month bounds, or null if malformed. Pure. */
export function monthRange(ym) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad2(last)}` };
}

/** Four-digit year -> {from,to}, or null if malformed. Pure. */
export function yearRange(year) {
  const y = String(year ?? '');
  if (!/^\d{4}$/.test(y)) return null;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/* --------------------------------------------------------- date ranges -- */

function pad2(n) {
  return String(n).padStart(2, '0');
}
function isoDate(y, mZeroBased, d) {
  return `${y}-${pad2(mZeroBased + 1)}-${pad2(d)}`;
}

/**
 * The Expenses screen's month/year/YTD/custom toggle, resolved to a concrete
 * `{from, to}` (YYYY-MM-DD strings, or null for an open end on 'custom').
 * Pure — `now` is injectable so scripts/verify-expenses.mjs can assert every
 * branch against a fixed date. Calendar months/years, in UTC (this is an
 * accounting date range, not a timezone-sensitive one).
 * @param {'month'|'year'|'ytd'|'custom'} kind
 * @param {Date} [now]
 * @param {{from?: string|null, to?: string|null}} [custom]
 */
export function resolveExpenseDateRange(kind, now = new Date(), custom = {}) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const todayIso = isoDate(year, month, now.getUTCDate());
  switch (kind) {
    case 'month': {
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return { from: isoDate(year, month, 1), to: isoDate(year, month, lastDay) };
    }
    case 'year':
      return { from: isoDate(year, 0, 1), to: isoDate(year, 11, 31) };
    case 'custom':
      return { from: custom?.from ?? null, to: custom?.to ?? null };
    case 'ytd':
    default:
      return { from: isoDate(year, 0, 1), to: todayIso };
  }
}

/* ------------------------------------------------------------- totals -- */

/**
 * expenses_totals()'s `{category, month, total_cents, expense_count}` rows
 * -> the shape ExpensesScreen actually renders: a grand total, one entry per
 * category (sorted highest first, for the bar chart) and one per month.
 * Pure. @param {{category: string, month: string, total_cents: number|string, expense_count: number|string}[]} rows
 */
export function shapeExpenseTotals(rows) {
  const byCategory = new Map();
  const byMonth = new Map();
  let grandTotalCents = 0;

  for (const r of rows ?? []) {
    const cents = Number(r.total_cents) || 0;
    const count = Number(r.expense_count) || 0;
    grandTotalCents += cents;

    const c = byCategory.get(r.category) ?? { category: r.category, totalCents: 0, count: 0 };
    c.totalCents += cents;
    c.count += count;
    byCategory.set(r.category, c);

    const m = byMonth.get(r.month) ?? { month: r.month, totalCents: 0, count: 0 };
    m.totalCents += cents;
    m.count += count;
    byMonth.set(r.month, m);
  }

  return {
    grandTotalCents,
    byCategory: [...byCategory.values()].sort((a, b) => b.totalCents - a.totalCents),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/* -------------------------------------------------------------- DB reads/writes */

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`expenses: ${context} failed (M3-config/28-expenses.sql may not be applied yet):`, err?.message);
}

/** True the moment ANY call above succeeds once — lets a caller distinguish
 *  "the migration genuinely isn't applied" (every call fails) from an
 *  ordinary transient error, without a second round trip. Best-effort only:
 *  a cold start starts this false again, which just means one more warning
 *  line, never a wrong answer. */
let migrationConfirmed = false;

/** Rethrown by the wrappers below so the route can tell "the migration truly
 *  isn't applied" (safe to answer with a 503) apart from every other DB
 *  error (which should surface as a 500, not be swallowed as an empty list).
 *  Mirrors recordsStore.js's isUndefinedFunctionError check (Postgres code
 *  42883) — the exact error `SELECT expenses_list(...)` raises when
 *  M3-config/28-expenses.sql hasn't been pasted into this database yet. */
export class ExpensesMigrationPendingError extends Error {
  constructor(cause) {
    super("This feature needs a database update that hasn't been applied yet.");
    this.name = 'ExpensesMigrationPendingError';
    this.status = 503;
    this.cause = cause;
  }
}

function rethrowOrPending(context, err) {
  warnOnce(context, err);
  if (!migrationConfirmed && err?.code === '42883') {
    throw new ExpensesMigrationPendingError(err);
  }
  throw err;
}

export async function listExpenses({ from, to } = {}) {
  try {
    const { rows } = await getPool().query('SELECT * FROM expenses_list($1,$2)', [from ?? null, to ?? null]);
    migrationConfirmed = true;
    return rows;
  } catch (err) {
    return rethrowOrPending('expenses_list', err);
  }
}

/** One live expense by id, or null. There is no get-by-id SECURITY DEFINER
 *  function (no new DDL), so this scans expenses_list — a founders' tracker
 *  is hundreds of rows, not millions. */
export async function getExpenseById(id) {
  const rows = await listExpenses({});
  return rows.find((r) => r.id === id) ?? null;
}

export async function insertExpense({
  occurredOn, vendor, amountCents, currency, category, note, receiptKey, receiptFilename, source, createdBy,
}) {
  try {
    const { rows } = await getPool().query(
      'SELECT expenses_insert($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
      [occurredOn, vendor, amountCents, currency ?? 'USD', category, note ?? null, receiptKey ?? null, receiptFilename ?? null, source ?? 'manual', createdBy ?? null]
    );
    migrationConfirmed = true;
    return rows[0]?.id ?? null;
  } catch (err) {
    return rethrowOrPending('expenses_insert', err);
  }
}

export async function updateExpense(id, {
  occurredOn, vendor, amountCents, currency, category, note, receiptKey, receiptFilename,
}) {
  try {
    const { rows } = await getPool().query(
      'SELECT expenses_update($1,$2,$3,$4,$5,$6,$7,$8,$9) AS ok',
      [id, occurredOn, vendor, amountCents, currency ?? null, category, note ?? null, receiptKey ?? null, receiptFilename ?? null]
    );
    migrationConfirmed = true;
    return Boolean(rows[0]?.ok);
  } catch (err) {
    return rethrowOrPending('expenses_update', err);
  }
}

export async function deleteExpense(id) {
  try {
    const { rows } = await getPool().query('SELECT expenses_delete($1) AS ok', [id]);
    migrationConfirmed = true;
    return Boolean(rows[0]?.ok);
  } catch (err) {
    return rethrowOrPending('expenses_delete', err);
  }
}

export async function totalsExpenses({ from, to } = {}) {
  try {
    const { rows } = await getPool().query('SELECT * FROM expenses_totals($1,$2)', [from ?? null, to ?? null]);
    migrationConfirmed = true;
    return rows;
  } catch (err) {
    return rethrowOrPending('expenses_totals', err);
  }
}

/** Test-only: let scripts/verify-expenses.mjs (or a future integration test)
 *  reset the warn-once/confirmed flags between fixtures. */
export function _resetExpensesStoreState() {
  warned = false;
  migrationConfirmed = false;
}
