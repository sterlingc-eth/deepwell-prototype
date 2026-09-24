/**
 * Financials layer — pure normalization + arithmetic checks (no DB, no model).
 *
 * Everything the model returns about money is UNTRUSTED text. This module is the
 * only door between that text and `document_financials`:
 *
 *   - money is parsed to exact integer cents ("$1,234.50", "(45.00)", "-$45" all
 *     become numbers; "TBD", "1,2,3", ranges and anything not plainly one amount
 *     become null) and stored as NUMERIC(12,2) strings, never floats;
 *   - a header amount is KEPT only if that amount is actually printed somewhere
 *     in the page text (`pageAmounts`) — a total the model computed, guessed or
 *     misread is dropped to null, never stored. "Never invent: a total not
 *     printed stays null";
 *   - arithmetic (line items vs subtotal, subtotal + tax vs total, total - paid
 *     vs balance) is CHECKED and any mismatch becomes a flag that routes the
 *     document to Needs review with confidence capped at 0.4. Nothing is
 *     silently "fixed" to make the numbers agree.
 *
 * Reuses extractFields.js's normalizeDate so date handling is one rule, not two.
 */
import { normalizeDate } from '../extractFields.js';

/** doc_kind values each document_type may produce (first = default). */
export const FINANCIAL_KINDS_BY_TYPE = Object.freeze({
  invoice: ['invoice', 'credit_memo', 'statement', 'receipt'],
  'proposal-quote': ['estimate', 'change_order'],
  'purchase-order': ['po'],
  'maintenance-agreement': ['agreement'],
});

/** The document types that get a financial extraction (and backfill). */
export const FINANCIAL_DOCUMENT_TYPES = Object.freeze(Object.keys(FINANCIAL_KINDS_BY_TYPE));

export function isFinancialDocumentType(t) {
  return Object.prototype.hasOwnProperty.call(FINANCIAL_KINDS_BY_TYPE, String(t ?? ''));
}

/** Kinds that count toward "revenue / invoiced": customer-facing billed documents. */
export const REVENUE_KINDS = Object.freeze(['invoice', 'credit_memo']);

/** Header money fields, in display order. */
export const MONEY_FIELDS = Object.freeze(['subtotal', 'tax', 'total', 'amount_paid', 'balance_due']);
export const DATE_FIELDS = Object.freeze(['invoice_date', 'due_date', 'period_start', 'period_end']);
export const TEXT_FIELDS = Object.freeze(['invoice_number', 'po_number', 'agreement_term', 'customer_name', 'vendor_name']);
/** Fields a person may correct in the review screen. */
export const EDITABLE_FIELDS = Object.freeze([...MONEY_FIELDS, ...DATE_FIELDS, ...TEXT_FIELDS, 'status']);

/** Two cents of slack: rounding on a printed invoice is real; more than that is a mismatch. */
export const TOLERANCE_CENTS = 2;
/** Below this a financial row is "worth a second look" (matches the review screen's 0.85 line). */
export const REVIEW_CONFIDENCE = 0.85;

const MAX_DOLLARS = 1e8;

/* ------------------------------------------------------------------ money */

/**
 * Exact money parser -> integer cents, or null. Handles $ / USD, thousands
 * commas (only real ones: groups of three), a leading minus, accounting
 * parentheses "(45.00)", and a trailing minus "45.00-". At most `maxDecimals`
 * decimal places (extra places that are all zero are fine; anything else is
 * refused rather than rounded, because rounding a printed value is inventing one).
 */
export function parseCents(raw, { maxDecimals = 2 } = {}) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  const paren = s.match(/^\(\s*(.+?)\s*\)$/);
  if (paren) { negative = true; s = paren[1]; }
  s = s.replace(/\b(usd|us\$)\b/ig, '').replace(/\$/g, '').trim();
  if (/^-/.test(s)) { negative = true; s = s.replace(/^-\s*/, ''); }
  if (/-$/.test(s)) { negative = true; s = s.replace(/\s*-$/, ''); }
  if (/^\+/.test(s)) s = s.replace(/^\+\s*/, '');
  // Whole-number-with-commas or plain digits, optional decimals.
  const m = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const whole = m[1].replace(/,/g, '');
  let frac = m[2] ?? '';
  if (frac.length > maxDecimals) {
    if (/[^0]/.test(frac.slice(maxDecimals))) return null; // would need rounding: refuse
    frac = frac.slice(0, maxDecimals);
  }
  const dollars = Number(whole);
  if (!Number.isFinite(dollars) || dollars >= MAX_DOLLARS) return null;
  const cents = dollars * 100 + Number((frac + '00').slice(0, 2));
  // Sub-cent unit prices (maxDecimals > 2) are not representable as cents; callers that
  // need them use parseDecimal4 below.
  return negative ? -cents : cents;
}

/** cents -> "123.45" (always two decimals, sign kept). */
export function centsToString(cents) {
  if (cents == null || !Number.isFinite(cents)) return null;
  const neg = cents < 0;
  const a = Math.abs(Math.round(cents));
  const s = `${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** A NUMERIC(12,4)-safe decimal string for a unit price, or null (refuses >4 dp). */
export function parseDecimal4(raw) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  const s = String(raw).trim().replace(/\$/g, '').replace(/,/g, '');
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,4}))?$/);
  if (!m) return null;
  if (Number(m[2]) >= MAX_DOLLARS) return null;
  const frac = m[3] ? m[3].replace(/0+$/, '') : '';
  return `${m[1]}${m[2]}${frac ? `.${frac}` : ''}`;
}

/** Quantity: NUMERIC(12,3)-safe or null. */
export function parseQty(raw) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  const s = String(raw).trim().replace(/,/g, '');
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,3}))?$/);
  if (!m || Number(m[2]) >= 1e7) return null;
  return `${m[1]}${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/**
 * Every money-shaped amount printed in the page text, as a Set of |cents|.
 * "1,240.50", "1240.50", "$ 1,240.50", "(45.00)" and a bare "1240" all register.
 * Used to prove a header amount is actually on the page.
 */
export function pageAmounts(pages) {
  const set = new Set();
  const text = (Array.isArray(pages) ? pages : []).map((p) => String(p?.text ?? p ?? '')).join('\n');
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+(?:\.\d{1,4})?/g)) {
    const c = parseCents(m[0], { maxDecimals: 4 });
    if (c != null) set.add(Math.abs(c));
  }
  return set;
}

/* ------------------------------------------------------------------- dates */

function parseFullDate(raw) {
  const d = normalizeDate(raw);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/* ------------------------------------------------------------------ helpers */

function clamp01(n, dflt) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt;
}

function cleanText(v, max = 120) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
  return s || null;
}

/** A model "money field" may be {value,page_no,verbatim,confidence} or a bare scalar. */
function unwrap(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { value: raw.value, page_no: raw.page_no, verbatim: raw.verbatim, confidence: raw.confidence };
  }
  return { value: raw, page_no: null, verbatim: null, confidence: null };
}

/* -------------------------------------------------------------- status logic */

const PRINTED_STATUS = new Set(['paid', 'unpaid', 'partial', 'overdue', 'open', 'none']);

/**
 * paid | unpaid | partial | unknown from what is PRINTED. Absence of a balance or a
 * "PAID" stamp is never read as paid (unknown is a real, countable state).
 * Numbers beat a printed word when they disagree; the disagreement is flagged by the caller.
 */
export function deriveStatus({ kind, printedStatus, totalCents, paidCents, balanceCents }) {
  if (kind === 'receipt') return 'paid';
  if (kind === 'estimate' || kind === 'po' || kind === 'change_order') return 'unknown';
  const printed = PRINTED_STATUS.has(printedStatus) ? printedStatus : 'none';
  if (balanceCents != null && totalCents != null && totalCents !== 0) {
    if (balanceCents === 0) return 'paid';
    if (paidCents != null && paidCents > 0 && balanceCents > 0) return 'partial';
  }
  if (paidCents != null && totalCents != null && totalCents > 0) {
    if (paidCents >= totalCents) return 'paid';
    if (paidCents > 0) return 'partial';
  }
  if (printed === 'paid') return 'paid';
  if (printed === 'partial') return 'partial';
  if (printed === 'unpaid' || printed === 'overdue' || printed === 'open') return 'unpaid';
  if (balanceCents != null && balanceCents > 0) return 'unpaid';
  return 'unknown';
}

/* ------------------------------------------------------------ arithmetic flags */

/**
 * Pure arithmetic checks on already-parsed cents. `f` = {subtotal,tax,total,amount_paid,
 * balance_due} in cents (null when absent); `lines` = [{qty,unit_price,amount}] where
 * amount is cents|null. Returns an array of flag strings (possibly empty).
 */
export function arithmeticFlags(f, lines = [], { kind } = {}) {
  const flags = [];
  const near = (a, b) => Math.abs(a - b) <= TOLERANCE_CENTS;
  if (f.subtotal != null && f.total != null) {
    if (!near(f.subtotal + (f.tax ?? 0), f.total)) flags.push('total_mismatch');
  }
  const amounts = lines.map((l) => l.amount);
  if (lines.length && amounts.every((a) => a != null)) {
    const sum = amounts.reduce((a, b) => a + b, 0);
    if (f.subtotal != null) {
      if (!near(sum, f.subtotal)) flags.push('lines_mismatch');
    } else if (f.total != null && f.tax == null) {
      if (!near(sum, f.total)) flags.push('lines_mismatch');
    } else if (f.total != null && f.tax != null) {
      if (!near(sum + f.tax, f.total)) flags.push('lines_mismatch');
    }
  }
  for (const l of lines) {
    if (l.qty != null && l.unit_price != null && l.amount != null) {
      const expect = Math.round(Math.abs(Number(l.qty) * Number(l.unit_price)) * 100);
      if (Math.abs(expect - Math.abs(l.amount)) > TOLERANCE_CENTS) { flags.push('line_math'); break; }
    }
  }
  if (f.total != null && f.amount_paid != null && f.balance_due != null && kind !== 'credit_memo') {
    if (!near(f.total - f.amount_paid, f.balance_due)) flags.push('balance_mismatch');
  }
  return flags;
}

/** Flags that mean "a person must look" (vs informational ones). */
export const REVIEW_FLAGS = Object.freeze([
  'total_mismatch', 'lines_mismatch', 'line_math', 'balance_mismatch', 'status_conflict',
  'amount_not_on_page', 'due_before_invoice', 'no_total', 'non_usd',
]);

/* ---------------------------------------------------------------- normalize */

/**
 * @param {object} input   the model's extract_financials tool input
 * @param {{documentType: string, pages?: Array<{page_no:number,text:string}>, pageCount?: number, today?: string}} ctx
 * @returns {{ok: boolean, header: object|null, lines: object[], flags: string[], confidence: number,
 *            evidence: object, dropped: object[]}}
 *   ok=false only when the document type is not financial or the input is not an object.
 */
export function normalizeFinancials(input, { documentType, pages, pageCount, today } = {}) {
  const dropped = [];
  if (!isFinancialDocumentType(documentType) || !input || typeof input !== 'object') {
    return { ok: false, header: null, lines: [], flags: [], confidence: 0, evidence: {}, dropped };
  }
  const allowed = FINANCIAL_KINDS_BY_TYPE[documentType];
  const kind = allowed.includes(input.kind) ? input.kind : allowed[0];
  const defaultDirection = kind === 'po' ? 'payable' : 'receivable';
  const direction = input.direction === 'payable' || input.direction === 'receivable' ? input.direction : defaultDirection;

  const known = Array.isArray(pages) && pages.length ? pageAmounts(pages) : null;
  const evidence = {};
  const cents = {};
  const fieldConf = {};
  const flagSet = new Set();

  for (const key of MONEY_FIELDS) {
    const { value, page_no, verbatim, confidence } = unwrap(input[key]);
    if (value == null || value === '') { cents[key] = null; continue; }
    let c = parseCents(value);
    if (c == null) { dropped.push({ key, reason: 'unparseable amount' }); cents[key] = null; continue; }
    // A credit memo is negative by convention, however it was printed.
    if (kind === 'credit_memo' && c > 0) c = -c;
    if (known && !known.has(Math.abs(c))) {
      // Not printed anywhere on the pages: computed / guessed / misread. Dropped, flagged.
      dropped.push({ key, reason: 'amount not on any page' });
      flagSet.add('amount_not_on_page');
      cents[key] = null;
      continue;
    }
    cents[key] = c;
    let pn = Number(page_no);
    if (!Number.isInteger(pn) || pn < 1 || (pageCount && pn > pageCount)) pn = null;
    fieldConf[key] = clamp01(confidence, 0.7);
    evidence[key] = { page: pn, verbatim: cleanText(verbatim, 200), confidence: fieldConf[key] };
  }

  const dates = {};
  for (const key of DATE_FIELDS) {
    const { value, page_no, verbatim } = unwrap(input[key]);
    if (value == null || value === '') { dates[key] = null; continue; }
    const d = parseFullDate(value);
    if (!d) { dropped.push({ key, reason: 'unparseable date' }); dates[key] = null; continue; }
    dates[key] = d;
    let pn = Number(page_no);
    if (!Number.isInteger(pn) || pn < 1 || (pageCount && pn > pageCount)) pn = null;
    if (pn != null || verbatim) evidence[key] = { page: pn, verbatim: cleanText(verbatim, 200) };
  }
  if (dates.invoice_date && dates.due_date && dates.due_date < dates.invoice_date) flagSet.add('due_before_invoice');
  if (dates.invoice_date && today && dates.invoice_date > addDays(today, 60)) flagSet.add('future_dated');

  const text = {};
  for (const key of TEXT_FIELDS) {
    const { value } = unwrap(input[key]);
    text[key] = cleanText(value, key === 'agreement_term' ? 160 : 100);
  }

  const currencyRaw = cleanText(input.currency, 8)?.toUpperCase() ?? 'USD';
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  if (currency !== 'USD') flagSet.add('non_usd');

  // ---- line items -----------------------------------------------------------
  const lines = [];
  const rawLines = Array.isArray(input.line_items) ? input.line_items.slice(0, 80) : [];
  for (const li of rawLines) {
    if (!li || typeof li !== 'object') continue;
    const description = cleanText(li.description, 200);
    let amount = li.amount == null || li.amount === '' ? null : parseCents(li.amount);
    if (kind === 'credit_memo' && amount != null && amount > 0) amount = -amount;
    // Same "must be printed" rule as header amounts: a line amount not on the page is not stored.
    if (known && amount != null && !known.has(Math.abs(amount))) { amount = null; flagSet.add('amount_not_on_page'); }
    const unitDec = li.unit_price == null || li.unit_price === '' ? null : parseDecimal4(li.unit_price);
    const qty = li.qty == null || li.qty === '' ? null : parseQty(li.qty);
    if (!description && amount == null && unitDec == null) continue;
    let pn = Number(li.page_no);
    if (!Number.isInteger(pn) || pn < 1 || (pageCount && pn > pageCount)) pn = null;
    lines.push({
      line_no: lines.length + 1,
      description,
      qty,
      unit_price: unitDec,
      amount,
      amount_str: amount == null ? null : centsToString(amount),
      category_guess: cleanText(li.category_guess, 40),
      page_no: pn,
    });
  }

  // ---- checks ----------------------------------------------------------------
  for (const f of arithmeticFlags(cents, lines, { kind })) flagSet.add(f);
  if (cents.total == null) flagSet.add('no_total');

  const printedStatus = PRINTED_STATUS.has(input.printed_status) ? input.printed_status : 'none';
  const status = deriveStatus({
    kind, printedStatus, totalCents: cents.total, paidCents: cents.amount_paid, balanceCents: cents.balance_due,
  });
  if ((printedStatus === 'paid' && status !== 'paid') || (['unpaid', 'overdue', 'open'].includes(printedStatus) && status === 'paid')) {
    flagSet.add('status_conflict');
  }

  // ---- confidence ---------------------------------------------------------------
  let confidence = clamp01(input.confidence, 0.7);
  if (fieldConf.total != null) confidence = Math.min(confidence, fieldConf.total);
  const flags = [...flagSet];
  const arithmetic = ['total_mismatch', 'lines_mismatch', 'line_math', 'balance_mismatch'].some((x) => flagSet.has(x));
  if (arithmetic) confidence = Math.min(confidence, 0.4);
  if (flagSet.has('amount_not_on_page') || flagSet.has('no_total')) confidence = Math.min(confidence, 0.5);

  const header = {
    doc_kind: kind,
    direction,
    currency,
    invoice_number: text.invoice_number,
    po_number: text.po_number,
    invoice_date: dates.invoice_date,
    due_date: dates.due_date,
    period_start: dates.period_start,
    period_end: dates.period_end,
    agreement_term: text.agreement_term,
    customer_name: text.customer_name,
    vendor_name: text.vendor_name,
    subtotal: centsToString(cents.subtotal),
    tax: centsToString(cents.tax),
    total: centsToString(cents.total),
    amount_paid: centsToString(cents.amount_paid),
    balance_due: centsToString(cents.balance_due),
    status,
  };
  return { ok: true, header, lines, flags, confidence: Math.round(confidence * 1000) / 1000, evidence, dropped };
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- corrections */

/**
 * Effective (corrected-over-original) header for a stored row. Corrections are a
 * {field: string} map; an empty string means "person cleared it" -> null.
 */
export function effectiveHeader(row) {
  const corr = row?.corrections && typeof row.corrections === 'object' ? row.corrections : {};
  const out = { ...row };
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(corr, k)) out[k] = corr[k] === '' ? null : corr[k];
  }
  return out;
}

/**
 * Validate one person-entered correction. Returns {ok:true, value} (value normalized,
 * '' = clear) or {ok:false, error}. Money accepts what parseCents accepts; dates need a
 * full date; status one of the four.
 */
export function validateCorrection(field, raw) {
  if (!EDITABLE_FIELDS.includes(field)) return { ok: false, error: `${String(field).slice(0, 30)} is not an editable financial field` };
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: '' };
  if (MONEY_FIELDS.includes(field)) {
    const c = parseCents(s);
    return c == null ? { ok: false, error: 'Enter an amount like 1234.50' } : { ok: true, value: centsToString(c) };
  }
  if (DATE_FIELDS.includes(field)) {
    const d = parseFullDate(s);
    return d ? { ok: true, value: d } : { ok: false, error: 'Enter a full date like 2026-09-12' };
  }
  if (field === 'status') {
    return ['paid', 'unpaid', 'partial', 'unknown'].includes(s) ? { ok: true, value: s } : { ok: false, error: 'Status must be paid, unpaid, partial or unknown' };
  }
  return { ok: true, value: s.slice(0, 160) };
}

/**
 * Recompute the arithmetic flags of a stored row from its EFFECTIVE values + its lines.
 * Returns {flags, confidence}: after a person corrects a number the mismatch flags are
 * re-evaluated on what they typed (the original evidence flags like amount_not_on_page
 * stay only if nothing was corrected).
 */
export function recomputeFlags(row, lines = []) {
  const eff = effectiveHeader(row);
  const c = {};
  for (const k of MONEY_FIELDS) c[k] = eff[k] == null || eff[k] === '' ? null : parseCents(eff[k]);
  const parsedLines = lines.map((l) => ({
    qty: l.qty == null ? null : l.qty,
    unit_price: l.unit_price == null ? null : l.unit_price,
    amount: l.amount == null ? null : parseCents(l.amount),
  }));
  const set = new Set(arithmeticFlags(c, parsedLines, { kind: eff.doc_kind }));
  if (c.total == null) set.add('no_total');
  if (eff.due_date && eff.invoice_date && eff.due_date < eff.invoice_date) set.add('due_before_invoice');
  if (eff.currency && eff.currency !== 'USD') set.add('non_usd');
  const corrected = row?.corrections && Object.keys(row.corrections).length > 0;
  // Evidence flags survive only while nobody has corrected the row.
  if (!corrected) for (const f of row?.flags ?? []) if (f === 'amount_not_on_page' || f === 'status_conflict') set.add(f);
  const flags = [...set];
  const arithmetic = flags.some((x) => ['total_mismatch', 'lines_mismatch', 'line_math', 'balance_mismatch'].includes(x));
  let confidence = Number(row?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.7;
  // A human-corrected number is as good as it gets unless it still does not add up.
  if (corrected) confidence = arithmetic ? Math.min(confidence, 0.4) : Math.max(confidence, 0.95);
  return { flags, confidence: Math.round(confidence * 1000) / 1000 };
}

/** Does this stored row need a person? (not yet verified AND (flagged OR low confidence)). */
export function needsReview(row) {
  if (!row || row.verified_by) return false;
  const flags = Array.isArray(row.flags) ? row.flags : [];
  const conf = Number(row.confidence);
  return flags.some((f) => REVIEW_FLAGS.includes(f)) || (Number.isFinite(conf) && conf < REVIEW_CONFIDENCE);
}
