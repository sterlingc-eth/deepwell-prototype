/**
 * Citations for the financial answers (api/_lib/financials/answers.js): the records are the
 * `financials` rows the money figure was summed from (same query, same rows), each pointing at the
 * page the total is printed on.
 */
import { documentRecord, customerRecord } from './records.js';

export const money = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const dateLabel = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/** One `financials` row -> one invoice/document record (page = where the total is printed). */
export function financeRecord(r, { group, amountField = 'total' } = {}) {
  const kind = r.doc_kind === 'invoice' ? 'invoice' : undefined;
  const bits = [r.doc_kind === 'invoice' ? 'Invoice' : r.doc_kind === 'estimate' ? 'Quote' : r.doc_kind === 'po' ? 'Purchase order' : r.doc_kind === 'agreement' ? 'Maintenance agreement' : 'Document'];
  const label = `${bits[0]}${r.invoice_number ? ` #${r.invoice_number}` : ''} · ${r.customer_name ?? r.vendor_name ?? r.filename ?? 'unnamed'}`;
  const amount = money(r[amountField] ?? r.total);
  return documentRecord({ id: r.document_id, document_type: kind === 'invoice' ? 'invoice' : r.doc_kind, filename: r.filename }, {
    type: kind, label, group, page: r.total_page != null ? Number(r.total_page) : undefined,
    sublabel: [amount, dateLabel(r.doc_date ?? r.invoice_date)].filter(Boolean).join(' · '),
  });
}

export const financeRecords = (rows, opts) => (rows ?? []).map((r) => financeRecord(r, opts)).filter(Boolean);

/** Rows aggregated in SQL into {id, no, cust, total, page, date}; used by revenue-by-month / average. */
export function aggregatedDocRecord(d, { group } = {}) {
  return documentRecord({ id: d.id, document_type: 'invoice' }, {
    type: 'invoice', label: `Invoice${d.no ? ` #${d.no}` : ''} · ${d.cust ?? 'unnamed'}`, group,
    page: d.page != null ? Number(d.page) : undefined,
    sublabel: [money(d.total), dateLabel(d.date)].filter(Boolean).join(' · '),
  });
}

export { customerRecord };
