/**
 * R5: payment-status words in a model's answer are held to the STORED payment status (document_financials status / amount_paid / balance_due) of the document they
 * cite, not to whatever the page text says about itself (a page can print "every invoice is paid"). PURE.
 *
 * A stored row is read as one of: paid (status paid, or nothing left to pay and something paid), partial, unpaid (status unpaid, or a balance still due). A row that says
 * nothing usable ("unknown", no amounts) is ignored. A sentence asserts: paid / partially paid / unpaid / overdue / past due / open / outstanding. An assertion fails only on
 * POSITIVE evidence: the sentence is about stored rows (the cited documents, narrowed to the invoice numbers the sentence names) and none of them has the asserted state.
 */
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** @returns {'paid'|'partial'|'unpaid'|null} the state a stored financials row says */
export function storedPayState(fin) {
  if (!fin) return null;
  const st = String(fin.status ?? '').toLowerCase().trim();
  const total = num(fin.total), paid = num(fin.paid ?? fin.amount_paid), bal = num(fin.balance ?? fin.balance_due);
  if (st === 'paid') return 'paid';
  if (st === 'partial' || st === 'partially_paid' || st === 'partially paid') return 'partial';
  if (st === 'unpaid' || st === 'open' || st === 'overdue') return 'unpaid';
  if (bal != null && bal > 0) return paid != null && paid > 0 ? 'partial' : 'unpaid';
  if (bal != null && bal === 0 && (paid == null || paid > 0 || total === 0)) return 'paid';
  if (total != null && paid != null && paid > 0) return paid >= total ? 'paid' : 'partial';
  return null;
}

const PRE_HYP = /(?:\b(?:if|once|when|until|unless|before|after|will be|to be|must be|should be|can be|could be|would be|please|amount|total|payments?|deposit|balance)\s+(?:\w+\s+){0,1}|\bno\s+)$/i;
/** the payment states a sentence asserts: a subset of ['paid','partial','unpaid','open'] ('open' = overdue / past due / open / outstanding: unpaid or partly paid) */
export function assertedPayStates(sentence) {
  const s = String(sentence ?? '').replace(/[‘’]/g, "'");
  const out = new Set();
  let rest = s;
  if (/\b(?:partial(?:ly)?|part(?:ly)?)[\s-]+paid\b|\bpartial payment\b/i.test(rest)) { out.add('partial'); rest = rest.replace(/\b(?:partial(?:ly)?|part(?:ly)?)[\s-]+paid\b/gi, ' '); }
  if (/\bun[\s-]?paid\b|\b(?:not|n't|never|hasn't been|has not been|isn't|is not|wasn't|was not|yet to be)\s+(?:yet\s+|been\s+|fully\s+)?paid\b|\bstill\s+owes?\b|\bowes?\s+(?:us\s+)?\$/i.test(rest)) {
    out.add('unpaid'); rest = rest.replace(/\bun[\s-]?paid\b|\b(?:not|n't|never|hasn't been|has not been|isn't|is not|wasn't|was not|yet to be)\s+(?:yet\s+|been\s+|fully\s+)?paid\b/gi, ' ');
  }
  if (/\bfully\s+(?:paid|settled)\b|\bsettled\s+in\s+full\b|\b(?:no|zero|nothing)\s+(?:remaining\s+|outstanding\s+)?(?:balance|left\s+to\s+pay|owing|owed|due)\b|\bbalance\s+(?:is|of|due\s+is)\s+\$?0(?:\.00)?(?![\d,])|\bnothing\s+(?:is\s+)?(?:outstanding|owed|due)\b/i.test(rest)) out.add('paid');
  if (/\b(?:overdue|past[\s-]+due)\b/i.test(rest) || /\b(?:is|are|was|marked|status(?:\s+is)?|currently|still|remains?)\s+open\b/i.test(rest)) out.add('open');
  for (const m of rest.matchAll(/\bnot\s+outstanding\b|\b(?:no|zero|nothing|none|without any)\s+(?:\w+\s+)?outstanding\b|\boutstanding\b/gi)) if (!/^not|^no|^zero|^nothing|^none|^without/i.test(m[0])) { const before = rest.slice(Math.max(0, m.index - 14), m.index); if (!/(?:\$\s?0(?:\.00)?|zero|no|nothing)\s*$/i.test(before)) out.add('open'); }
  for (const m of rest.matchAll(/\bpaid\b(?!\s*[:$\d])/gi)) {
    const before = rest.slice(Math.max(0, m.index - 24), m.index);
    if (PRE_HYP.test(before) || /\b(?:and|or|not|n't)\s*$/i.test(before) && /\bnot\s*$/i.test(before)) continue;
    const after = rest.slice(m.index + 4, m.index + 14);
    if (/^\s*(?:to|for)\b/i.test(after) && !/\b(?:is|was|are|were|been|marked|fully|in full)\b/i.test(before.slice(-12))) continue; // "paid to the vendor" without a state verb
    out.add('paid');
  }
  return out;
}

const supports = (state, asserted) => (asserted === 'paid' ? state === 'paid' : asserted === 'partial' ? state === 'partial' : asserted === 'unpaid' ? state === 'unpaid' || state === 'partial' : state === 'unpaid' || state === 'partial');

/**
 * @param {string} sentence
 * @param {string[]} docIds    cited documents
 * @param {Map} evidence       per document { fin?: {status,total,paid,balance}, numbers?: string[] }
 * @returns {{kind:'stat', claim:string}|null}
 */
export function payStatusConflict(sentence, docIds, evidence) {
  const asserted = assertedPayStates(sentence);
  if (!asserted.size) return null;
  let rows = (docIds ?? []).map((id) => ({ id, ev: evidence?.get?.(id) })).filter((r) => r.ev?.fin && storedPayState(r.ev.fin));
  if (!rows.length) return null;
  const canon = (x) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const named = rows.filter((r) => { const n = canon(r.ev.fin.invoice_number); return n.length >= 3 && canon(sentence).includes(n); });
  if (named.length) rows = named;
  const states = rows.map((r) => storedPayState(r.ev.fin));
  for (const a of asserted) if (!states.some((st) => supports(st, a))) return { kind: 'stat', claim: a === 'open' ? 'overdue / open' : a === 'partial' ? 'partially paid' : a };
  return null;
}
