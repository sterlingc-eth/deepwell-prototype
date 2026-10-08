/**
 * R41U: decides, from the shared reading (understand.js), whether a question is one of the exact document lookups answered from the organization's own
 * financial rows with NO model: a document NAMED BY ITS AMOUNT ("the invoice for 3470", "who did we bill 3086.00", "the bill for 3470 from a vendor") or the
 * latest / biggest document on one side of the books ("the latest invoice from a customer", "the biggest bill from a supplier").
 * Pure. Returns null when the question is anything else (a name, a status, a threshold, a second number...): every other lane keeps its own behaviour.
 */
import { parseThreshold, betweenWithCurrency } from '../amountWords.js';

const DOC = new Set(['invoice', 'bill']);

/** @returns {null | {intent: 'invoice_by_amount'|'doc_extreme', ...}} */
export function docLaneFromUnderstanding(u, question = '') {
  if (!u || !DOC.has(u.docKind)) return null;
  const f = u.filters ?? {};
  if ((u.notes ?? []).includes('directionConflict')) return { intent: 'direction_ask', docNoun: u.docKind };
  // A3: "wheres George Garrison invoice": a named customer (or vendor) and the document word, nothing else. The name never contains a question word or a role word.
  if (f.name && !f.address && (!f.status || f.status === 'paid') && !f.amount && !f.docNumber && !(u.residual ?? []).length && !u.unknownName && (u.kind === 'invoice' || u.kind === 'bill' || (u.kind === 'latest' && u.docKind === 'bill')) && !(u.notes ?? []).includes('unresolvedPronoun')
      && !parseThreshold(String(question)) && (!u.role || ['customer', 'vendor', 'supplier'].includes(u.role))) {
    return { intent: 'customer_docs', order: u.kind === 'latest' ? 'latest' : null, askPay: /\b(?:pay|pays|paid|paying|owe|owes|owed|settled)\b/i.test(String(question)), subject: f.name.value, declineByName: f.name.source === 'capitalised', direction: u.direction ?? null, docNoun: u.docKind, wants: u.wants ?? [], window: f.dateWindow ? { from: f.dateWindow.from ?? null, to: f.dateWindow.to ?? null, label: f.dateWindow.label } : null, readNotes: [...(u.corrections ?? []).map((c) => c.note), ...(f.dateWindow?.note ? [f.dateWindow.note] : [])] };
  }
  // R2: "bills over 5000 from vendors" / "vendor bills between 2000 and 5000": a vendor-bill amount filter, answered from the payable rows
  if (u.docKind === 'bill' && !f.docNumber?.explicit && !f.name && !f.address && !f.status && !u.unknownName && (u.residual ?? []).every((w) => /^(?:over|under|above|below|between|and|than|more|less|least|most|to|exceeding|exceed|from|up)$/.test(w)) && (!u.role || ['vendor', 'supplier'].includes(u.role))) {
    const th = parseThreshold(String(question));
    const bt = String(question).toLowerCase().match(/\bbetween\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(k?)\s+(?:and|to)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(k?)\b/);
    const val = (n, k) => Number(String(n).replace(/,/g, '')) * (k ? 1000 : 1);
    if (th && !th.unparsed && !bt) return { intent: 'bill_threshold', dir: th.dir, inclusive: th.inclusive, amount: th.amount, direction: 'out', docNoun: 'bill', readNotes: (u.corrections ?? []).map((c) => c.note).filter((n) => !/was not applied/.test(n)) };
    if (bt) {
      const lo = val(bt[1], bt[2]); const hi = val(bt[3], bt[4]);
      const yearish = (n) => Number.isInteger(n) && n >= 1990 && n <= 2100;
      if (Number.isFinite(lo) && Number.isFinite(hi) && !(yearish(lo) && yearish(hi) && !/[$]|dollars?|usd/i.test(String(question)))) return { intent: 'bill_threshold', between: [Math.min(lo, hi), Math.max(lo, hi)], direction: 'out', docNoun: 'bill', readNotes: (u.corrections ?? []).map((c) => c.note).filter((n) => !/was not applied/.test(n)) };
    }
  }
  if (f.name || f.address || f.status || (u.residual ?? []).length || u.unknownName || (u.notes ?? []).includes('unresolvedPronoun')) return null;
  if (parseThreshold(String(question)) || betweenWithCurrency(String(question))) return null;
  // R2: "whats my invoice" / "hows my invoice" / "whos my invoice": no name, number or amount was given; one short question, never a generic decline
  if (!u.role && !f.amount && !f.docNumber && !f.dateWindow && (u.kind === 'invoice' || u.kind === 'bill') && (u.strippedQuestionWords ?? []).some((w) => /^(?:whats|hows|whos|what|how|who)$/.test(w)) && /\b(?:my|our)\s+(?:invoices?|bills?)\b/i.test(String(question))) {
    return { intent: 'which_ask', docNoun: u.docKind };
  }
  const common = { direction: u.direction ?? null, docNoun: u.docKind, wants: u.wants ?? [], window: f.dateWindow ? { from: f.dateWindow.from ?? null, to: f.dateWindow.to ?? null, label: f.dateWindow.label } : null, readNotes: [...(u.corrections ?? []).map((c) => c.note), ...(f.dateWindow?.note ? [f.dateWindow.note] : [])] };
  // R2: "#1234 from a donor" / "invoice 1234 from a landlord": the number as typed, on the role's side of the books (no dollar reading of a "#" number)
  if ((u.kind === 'invoice' || u.kind === 'bill') && f.numberOnly && f.docNumber?.explicit && !f.amount) {
    return { intent: 'invoice_by_amount', amountCents: String(Number(f.docNumber.value) * 100), amountBare: true, numberOnly: true, role: u.role ?? null, ...common };
  }
  // R2: a role word with nothing else ("show me the invoice from a landlord"): a short answer with the count, never the whole list
  if (u.role && (u.kind === 'invoice' || u.kind === 'bill') && !f.amount && !f.docNumber && !f.dateWindow && !(u.wants ?? []).some((w) => w !== 'which')) {
    return { intent: 'side_docs', role: u.role, ...common };
  }
  if ((u.kind === 'invoice' || u.kind === 'bill') && f.amount && !f.docNumber?.explicit) {
    if (f.amount.approx) common.readNotes.push('only exact totals are matched, so "around" was read as exactly that amount');
    return { intent: 'invoice_by_amount', amountCents: f.amount.cents, amountBare: Boolean(f.amount.bare), role: u.role ?? null, ...common };
  }
  if ((u.kind === 'latest' || u.kind === 'biggest') && !f.amount && !f.docNumber && (u.role || u.docKind === 'bill' || u.direction)) {
    return { intent: 'doc_extreme', order: u.kind === 'latest' ? 'latest' : f.order === 'min' ? 'min' : 'max', ...common };
  }
  if ((u.kind === 'invoice' || u.kind === 'bill') && !f.amount && !f.docNumber && f.dateWindow && (f.dateWindow.from || f.dateWindow.to) && !(u.wants ?? []).length) {
    return { intent: 'docs_in_window', ...common };
  }
  // R2: "how many vendor bills do we have": counted from the rows (never the model)
  if (u.kind === 'count' && u.docKind === 'bill' && !/\binvoices?\b/i.test(String(question)) && !f.amount && !f.docNumber && !f.dateWindow && !(u.wants ?? []).some((w) => w !== 'how-many')) return { intent: 'doc_count', ...common };
  return null;
}
