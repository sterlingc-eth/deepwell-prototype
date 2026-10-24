/**
 * Tables lane (2026-10-24): the one place where verified table rows (tableRows.js) are given to the financials pipeline.
 * Used by the deterministic money path (financialsHook.js) and, via financials/extract.js, the model path. Pure.
 *
 * TABLE_ROWS_READER=1 (default OFF, see switches.js). With it on, `input.line_items` is REPLACED by the rows the page's own
 * arithmetic proves (qty x unit = amount, rows = subtotal, rows + tax = total, table total = the total of `input`), each with
 * its page. Nothing is added when the reader cannot prove the table: `input` comes back untouched (the model's own lines, if
 * any, then keep going through normalize.js's checks exactly as before). Shipping / discount lines are not modelled by the
 * financials header, so such a document is left alone.
 */
import { readTables, lineItemsForFinancials } from './tableRows.js';
import { isTableRowsReaderEnabled } from './switches.js';

const toCents = (v) => { const t = String(v ?? '').replace(/[$,\s]/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.value : x);

/** @returns {{input: object, applied: boolean, reason?: string, rows?: number}} */
export function withVerifiedRows(input, pages, { env = process.env } = {}) {
  if (!isTableRowsReaderEnabled(env) || !input || typeof input !== 'object') return { input, applied: false, reason: 'off' };
  try {
    const tr = readTables(pages);
    const items = lineItemsForFinancials(tr);
    if (!items.length || !tr.documentVerified) return { input, applied: false, reason: tr.reason ?? 'not_verified' };
    const tt = tr.totals?.total;
    const mine = toCents(val(input.total));
    if (!tt || mine == null || Math.round(tt.value * 100) !== mine) return { input, applied: false, reason: 'total_differs' };
    if (tr.extras?.shipping || tr.extras?.discount) return { input, applied: false, reason: 'shipping_or_discount' };
    if (tr.totals.tax ? !tr.totals.subtotal : tr.extras?.tax) return { input, applied: false, reason: 'tax_shape' };
    const next = { ...input };
    next.line_items = items.map((x) => ({ description: x.description, qty: x.qty, unit_price: x.unit_price, amount: x.amount.toFixed(2), page_no: x.page_no }));
    if (tr.totals.subtotal && tr.totals.tax) {
      const sub = toCents(val(input.subtotal)), tax = toCents(val(input.tax));
      if ((sub != null && sub !== Math.round(tr.totals.subtotal.value * 100)) || (tax != null && tax !== Math.round(tr.totals.tax.value * 100))) return { input, applied: false, reason: 'header_differs' };
      if (sub == null) next.subtotal = { value: tr.totals.subtotal.value.toFixed(2), page_no: tr.totals.subtotal.page, verbatim: tr.totals.subtotal.quote, confidence: 0.9 };
      if (tax == null) next.tax = { value: tr.totals.tax.value.toFixed(2), page_no: tr.totals.tax.page, verbatim: tr.totals.tax.quote, confidence: 0.9 };
    }
    return { input: next, applied: true, rows: items.length };
  } catch { return { input, applied: false, reason: 'error' }; }
}
