/**
 * The independent money model of the industry demo (/demo/). Everything is recomputed here, in whole cents, straight from the sample documents and the
 * reader's records, WITHOUT using the demo's own dashboard code, so a slip in either one shows up as a difference.
 * Used by scripts/verify-demo-financials.ts (every aggregate of every industry) and scripts/verify-demo-financials-ui.ts (the numbers on the rendered screens).
 */
import type { DemoDocument, DemoFixture } from '../../src/demo/engine';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayNum = (s: string) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
export const niceDate = (s: string) => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const mdy = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

/** Whole cents of a dollar amount; NaN when the amount has fractions of a cent (that alone is a failure). */
export const cents = (n: number): number => { const c = Math.round(n * 100); return Math.abs(n * 100 - c) < 1e-6 ? c : NaN; };
/** The one currency format of the demo: $1,234.00 */
export const fmtC = (c: number): string => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const CANON = /^\$(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)\.\d{2}$/;
const isCanon = (s: string) => CANON.test(s) && (!s.includes(',') || /^\$[1-9]\d{0,2}(?:,\d{3})+\.\d{2}$/.test(s));
export const moneyIn = (t: string): string[] => t.match(/\$[\d,]+(?:\.\d+)?/g) ?? [];
export const valueOf = (m: string): number => cents(Number(m.replace(/[$,]/g, '')));

export const isBill = (d: DemoDocument) => d.billable;
export const customerOf = (d: DemoDocument) => d.customer ?? d.vendor ?? 'Other';

export interface Expected {
  invoices: number; billedC: number; collectedC: number; openC: number; openInvoices: number; overdueC: number; overdueInvoices: number;
  aging: Array<{ label: string; invoices: number; amountC: number }>; byCustomer: Array<{ name: string; invoices: number; billedC: number; collectedC: number; openC: number }>;
  amountsOnFileC: number; amountDocuments: number;
}
const BUCKETS: Array<[string, number, number]> = [['Not yet due', 0, 0], ['1 to 30 days overdue', 1, 30], ['31 to 60 days overdue', 31, 60], ['61 to 90 days overdue', 61, 90], ['Over 90 days overdue', 91, Infinity]];

/** What the dashboard must show, worked out again from the documents alone. today = the demo's pinned day. */
export function expectedOf(fx: DemoFixture, docs: DemoDocument[] = fx.documents): Expected {
  const today = dayNum(fx.demoToday);
  const bills = docs.filter((d) => d.billable && d.pay && d.total != null);
  const sum = (xs: DemoDocument[], f: (d: DemoDocument) => number) => xs.reduce((a, d) => a + f(d), 0);
  const open = bills.filter((d) => cents(d.pay!.balance) > 0);
  const lateDays = (d: DemoDocument) => Math.max(0, today - dayNum(d.pay!.dueOn));
  const names = [...new Set(bills.map(customerOf))].sort();
  const withAmount = docs.filter((d) => d.total != null);
  return {
    invoices: bills.length, billedC: sum(bills, (d) => cents(d.total!)), collectedC: sum(bills, (d) => cents(d.pay!.paid)), openC: sum(open, (d) => cents(d.pay!.balance)),
    openInvoices: open.length, overdueC: sum(open.filter((d) => lateDays(d) > 0), (d) => cents(d.pay!.balance)), overdueInvoices: open.filter((d) => lateDays(d) > 0).length,
    aging: BUCKETS.map(([label, lo, hi]) => { const xs = open.filter((d) => lateDays(d) >= lo && lateDays(d) <= hi); return { label, invoices: xs.length, amountC: sum(xs, (d) => cents(d.pay!.balance)) }; }),
    byCustomer: names.map((name) => { const xs = bills.filter((d) => customerOf(d) === name); return { name, invoices: xs.length, billedC: sum(xs, (d) => cents(d.total!)), collectedC: sum(xs, (d) => cents(d.pay!.paid)), openC: sum(xs, (d) => cents(d.pay!.balance)) }; }),
    amountsOnFileC: sum(withAmount, (d) => cents(d.total!)), amountDocuments: withAmount.length,
  };
}

/** The status pill text of a bill in the documents table. */
export function pillOf(d: DemoDocument, today: string): string | null {
  if (!d.pay) return null;
  if (cents(d.pay.balance) <= 0) return 'Paid';
  const late = dayNum(today) - dayNum(d.pay.dueOn) > 0;
  return `${late ? 'Overdue' : 'Open'} ${fmtC(cents(d.pay.balance))}`;
}

interface RecordsLike {
  documents: Array<{ id: string }>;
  financials: Array<{ document_id: string; doc_kind: string; direction: string; total: string | null; subtotal: string | null; tax: string | null; amount_paid: string | null; balance_due: string | null; status: string; due_date: string | null }>;
  extractions: Array<{ document_id: string; field_key: string; value: string }>;
}

/** Every check on one industry. Returns the failures (empty = all figures agree to the cent). */
export function auditIndustry(fx: DemoFixture, rec: RecordsLike, expectedToday: string): string[] {
  const bad: string[] = []; const t = `[${fx.slug}]`;
  const f = (msg: string) => bad.push(`${t} ${msg}`);
  const today = dayNum(fx.demoToday);
  if (fx.demoToday !== expectedToday) f(`demo "today" is ${fx.demoToday}, not the pinned ${expectedToday}`);
  const byId = new Map(fx.documents.map((d) => [d.id, d]));
  const finRows = new Map(rec.financials.map((r) => [r.document_id, r]));
  if (rec.documents.length !== fx.documents.length) f(`records hold ${rec.documents.length} documents, the demo ${fx.documents.length}`);

  for (const d of fx.documents) {
    const n = `${d.name}`;
    const where = (m: string) => f(`${n}: ${m}`);
    if (d.date > fx.demoToday) where(`dated ${d.date}, after the demo's today ${fx.demoToday}`);
    const tot = d.total == null ? null : cents(d.total);
    if (d.total != null && Number.isNaN(tot)) where(`total ${d.total} is not a whole number of cents`);
    // ---- the paper's own arithmetic
    const text = d.pages.join('\n');
    const totalLines = [...text.matchAll(/^TOTAL: (\$[\d,]+(?:\.\d+)?)$/gm)].map((m) => m[1]!);
    if (d.total == null) { if (totalLines.length) where(`page shows a TOTAL but the document has no total`); }
    else if (totalLines.length !== 1 || valueOf(totalLines[0]!) !== tot) where(`page TOTAL ${totalLines.join('/')} differs from total ${fmtC(tot!)}`);
    const allowed = new Set<number>();
    if (tot != null) allowed.add(tot);
    if (d.lines) {
      const lc = d.lines.map((l) => cents(l.amount)); const sub = d.subtotal == null ? NaN : cents(d.subtotal);
      if (lc.some(Number.isNaN)) where('a line has fractions of a cent');
      const lsum = lc.reduce((a, b) => a + b, 0);
      if (d.tax == null) { if (lsum !== tot) where(`lines add to ${fmtC(lsum)}, total is ${fmtC(tot ?? 0)}`); }
      else {
        if (lsum !== sub) where(`lines add to ${fmtC(lsum)}, subtotal is ${fmtC(sub)}`);
        const tx = cents(d.tax); const per = Math.round((d.taxRate ?? 0) * 1000);
        if (sub + tx !== tot) where(`subtotal ${fmtC(sub)} + tax ${fmtC(tx)} is not total ${fmtC(tot ?? 0)}`);
        if (Math.round((sub * per) / 1000) !== tx) where(`tax ${fmtC(tx)} is not ${(per / 10).toFixed(1)}% of ${fmtC(sub)}`);
        allowed.add(sub); allowed.add(tx);
        if (!text.includes(`Subtotal: ${fmtC(sub)}`)) where('page lacks the subtotal line');
        if (!text.includes(`${d.taxLabel} (${((d.taxRate ?? 0) * 100).toFixed(1)}%): ${fmtC(tx)}`)) where('page lacks the tax line');
      }
      for (const l of d.lines) { for (const m of moneyIn(l.desc)) allowed.add(valueOf(m)); allowed.add(cents(l.amount)); if (!text.includes(`${l.desc}: ${fmtC(cents(l.amount))}`)) where(`page lacks the line "${l.desc}"`); }
    } else if (d.tax != null || d.subtotal != null) where('subtotal or tax without lines');
    // ---- fields: format, and no amount larger than the total it belongs to
    const fieldAmounts: Array<[string, number]> = [];
    for (const [k, v] of d.fields) if (v.startsWith('$')) { if (!isCanon(v)) where(`field ${k} "${v}" is not written as $1,234.00`); const c = valueOf(v); fieldAmounts.push([k, c]); allowed.add(c); }
    for (const [k, c] of fieldAmounts) {
      if (tot != null && c > tot && !/^(Rent amount|Security deposit)$/.test(k)) where(`${k} ${fmtC(c)} is more than the total ${fmtC(tot)}`);
      if (/^Lodging tax$/.test(k) && d.tax != null && c !== cents(d.tax)) where(`field ${k} ${fmtC(c)} differs from the tax ${fmtC(cents(d.tax))}`);
    }
    const rent = fieldAmounts.find(([k]) => k === 'Rent amount');
    if (rent && tot != null && tot !== rent[1] * 12) where(`lease total ${fmtC(tot)} is not 12 months of rent ${fmtC(rent[1])}`);
    // ---- every dollar figure on the paper is written one way, and (on a paper with money) is one of the paper's own figures
    const moneyDoc = d.total != null || fieldAmounts.length > 0;
    for (const m of moneyIn(text)) {
      if (!isCanon(m)) where(`page amount "${m}" is not written as $1,234.00`);
      else if (moneyDoc && !allowed.has(valueOf(m))) where(`page amount ${m} is not one of this paper's own figures`);
    }
    // ---- no sentence on the paper may contradict its own tax, deposit or due date
    const sentences = text.split('\n').filter((l) => !/^(Payment terms:|Subtotal:|TOTAL:)/.test(l) && !d.lines?.some((x) => l.startsWith(x.desc + ':')));
    const hasDeposit = d.fields.some(([k]) => /^Deposit (paid|requested)$/.test(k));
    for (const l of sentences) {
      if (hasDeposit && /%/.test(l) && /deposit|retainer|date|book|reserv|paid|pay|due/i.test(l)) where(`"${l.slice(0, 70)}" states a deposit percentage next to the paper's own deposit`);
      if (d.taxRate != null && /tax/i.test(l) && /%/.test(l) && !l.startsWith(`${d.taxLabel} (`)) where(`"${l.slice(0, 70)}" states a tax rate other than the paper's own`);
      if (d.billable && /pay|due|remit|net\b|invoice|bill/i.test(l) && /\b\d+\s*(?:business\s+)?days?\b|\bnet\s*\d+/i.test(l) && !/past due|overdue|late|dispute|question|objection|quer(?:y|ies)|collection|suspend|stops|^Status:|within \d+ days (?:of|following) (?:departure|the stay)/i.test(l)) where(`"${l.slice(0, 70)}" gives a payment deadline other than the paper's own due date`);
    }
    // ---- payment
    if (d.billable && !d.pay) where('is a bill but has no payment status');
    if (!d.billable && d.pay) where('has a payment status but is not a bill');
    if (d.billable && (d.total == null || d.direction !== 'receivable')) where('billable without a receivable total');
    if (d.pay && tot != null) {
      const paid = cents(d.pay.paid), bal = cents(d.pay.balance);
      if (Number.isNaN(paid) || Number.isNaN(bal)) where('payment has fractions of a cent');
      if (paid + bal !== tot) where(`paid ${fmtC(paid)} + balance ${fmtC(bal)} is not total ${fmtC(tot)}`);
      const s = d.pay.status;
      if ((s === 'paid' && bal !== 0) || (s === 'unpaid' && paid !== 0) || (s === 'partial' && !(paid > 0 && bal > 0)) || !['paid', 'unpaid', 'partial'].includes(s)) where(`status "${s}" does not match paid ${fmtC(paid)} / balance ${fmtC(bal)}`);
      if (dayNum(d.pay.dueOn) <= dayNum(d.date)) where(`due ${d.pay.dueOn} is not after the invoice date ${d.date}`);
      if (paid > 0) { if (!d.pay.paidOn) where('paid money without a payment date'); else if (d.pay.paidOn < d.date || d.pay.paidOn > fx.demoToday) where(`paid on ${d.pay.paidOn}, outside ${d.date}..${fx.demoToday}`); } else if (d.pay.paidOn) where('payment date on an unpaid bill');
      const dep = fieldAmounts.find(([k]) => k === 'Deposit paid');
      if (dep && paid < dep[1]) where(`paid ${fmtC(paid)} is less than the deposit paid ${fmtC(dep[1])}`);
      if (dep && dep[1] > tot) where('deposit paid is more than the total');
      if (!text.includes(`Payment terms: net ${dayNum(d.pay.dueOn) - dayNum(d.date)} days. Due date: ${mdy(d.pay.dueOn)}`)) where(`page does not state the due date ${d.pay.dueOn}`);
    }
    // ---- the reader's records agree with the demo
    const row = finRows.get(d.id);
    if (d.kind) {
      if (!row) where('no financial row in the reader records');
      else {
        const same = (a: string | null, b: number | null) => (a == null ? b == null : b != null && cents(Number(a)) === cents(b));
        if (!same(row.total, d.total)) where(`records total ${row.total} vs demo ${d.total}`);
        if (!same(row.subtotal, d.subtotal)) where(`records subtotal ${row.subtotal} vs demo ${d.subtotal}`);
        if (!same(row.tax, d.tax)) where(`records tax ${row.tax} vs demo ${d.tax}`);
        if (!same(row.amount_paid, d.pay ? d.pay.paid : null)) where(`records paid ${row.amount_paid} vs demo ${d.pay?.paid}`);
        if (!same(row.balance_due, d.pay ? d.pay.balance : null)) where(`records balance ${row.balance_due} vs demo ${d.pay?.balance}`);
        if ((row.due_date ?? null) !== (d.pay ? d.pay.dueOn : null)) where(`records due date ${row.due_date} vs demo ${d.pay?.dueOn}`);
        if (d.pay && row.status !== d.pay.status) where(`records status ${row.status} vs demo ${d.pay.status}`);
      }
    } else if (row) where('financial row for a document the demo shows without an amount');
  }
  for (const r of rec.financials) if (!byId.has(r.document_id)) f(`records hold a financial row for an unknown document ${r.document_id}`);

  // ---- the dashboard: every aggregate recomputed from the documents
  const e = expectedOf(fx);
  if (e.billedC !== e.collectedC + e.openC) f(`billed ${fmtC(e.billedC)} is not collected ${fmtC(e.collectedC)} + open ${fmtC(e.openC)}`);
  if (e.aging.reduce((a, b) => a + b.amountC, 0) !== e.openC) f('aging buckets do not add up to the open balance');
  if (e.aging.reduce((a, b) => a + b.invoices, 0) !== e.openInvoices) f('aging bucket counts do not add up to the open invoices');
  if (e.aging.slice(1).reduce((a, b) => a + b.amountC, 0) !== e.overdueC) f('overdue is not the sum of the overdue buckets');
  for (const k of ['billedC', 'collectedC', 'openC'] as const) if (e.byCustomer.reduce((a, b) => a + b[k], 0) !== e[k]) f(`customer rows do not add up to the company ${k}`);
  if (e.byCustomer.reduce((a, b) => a + b.invoices, 0) !== e.invoices) f('customer invoice counts do not add up');
  for (const c of e.byCustomer) if (c.billedC !== c.collectedC + c.openC) f(`${c.name}: billed is not collected + open`);
  // the demo's own dashboard code must agree with this recomputation to the cent (dynamic import done by the caller; see verify-demo-financials.ts)
  return bad;
}

/** Donovan's sample answers against the documents. */
export function auditAnswers(fx: DemoFixture): string[] {
  const bad: string[] = []; const t = `[${fx.slug}]`; const f = (m: string) => bad.push(`${t} ${m}`);
  const byId = new Map(fx.documents.map((d) => [d.id, d]));
  const gold = (fx as unknown as { gold: Record<string, { kind: string; value: unknown; docs: string[] }> }).gold;
  for (const q of fx.questions) {
    const a = q.answer; const g = gold[q.id]; const cited = a.docs.map((id) => byId.get(id)).filter(Boolean) as DemoDocument[];
    const amounts = moneyIn(a.text);   // the headline is the start of the text
    for (const m of amounts) if (!isCanon(m)) f(`answer to "${q.q}" has "${m}", not written as $1,234.00`);
    if (a.headline && !a.text.startsWith(a.headline)) f(`answer to "${q.q}": the headline is not the start of the answer`);
    if (!g) { f(`no gold for "${q.q}"`); continue; }
    if (q.intent === 'total') {
      const d = cited[0]; const want = d && d.total != null ? fmtC(cents(d.total)) : null;
      if (cited.length !== 1 || !want || !a.text.includes(want)) f(`answer to "${q.q}" does not quote the cited document's total ${want}`);
      if (amounts.length !== 1) f(`answer to "${q.q}" quotes ${amounts.length} amounts, expected 1`);
      if (d && !q.q.includes(d.number ?? '\0')) f(`answer to "${q.q}" cites a different document number`);
    } else if (q.intent === 'sum') {
      const sumC = cited.reduce((acc, d) => acc + cents(d.total ?? 0), 0); const first = cited[0];
      if (!first || !q.customer || !a.text.includes(fmtC(sumC))) f(`answer to "${q.q}" does not quote the sum of its documents ${fmtC(sumC)}`);
      const all = fx.documents.filter((d) => d.customer === q.customer && d.type === first?.type && d.total != null);
      if (all.length !== cited.length || all.some((d) => !a.docs.includes(d.id))) f(`answer to "${q.q}" leaves out ${all.length - cited.length} of ${q.customer}'s ${first?.typeLabel}`);
      if (new RegExp(`Total of ${cited.length} `).test(a.text) === false) f(`answer to "${q.q}" counts a different number of documents than it adds`);
      if (amounts.length !== 1) f(`answer to "${q.q}" quotes ${amounts.length} amounts, expected 1`);
    } else if (q.intent === 'count') {
      const ids = g.docs; const ds = ids.map((id) => byId.get(id)).filter(Boolean) as DemoDocument[]; const year = /\b(20\d\d)\b/.exec(q.q)?.[1];
      const all = fx.documents.filter((d) => ds[0] && d.type === ds[0].type && (!year || d.date.startsWith(year)));
      if (!ds[0] || !new RegExp(`(^|\\D)${all.length} `).test(a.text) || all.length !== ds.length) f(`answer to "${q.q}" counts something other than the ${all.length} matching documents`);
    } else if (q.intent === 'field' && g.kind === 'money') {
      const d = cited[0]; const want = Number(g.value);
      const fld = d?.fields.find(([, v]) => v.startsWith('$') && valueOf(v) === cents(want));
      if (!d || !fld || !a.text.includes(fmtC(cents(want)))) f(`answer to "${q.q}" does not match a money field of the cited document`);
    } else if (amounts.length) {
      // any other answer that quotes money (e.g. a clause) must quote it the same way as the papers
      const d = cited[0]; if (d && (d.total != null || d.fields.some(([, v]) => v.startsWith('$')))) f(`answer to "${q.q}" quotes an amount from a paper that already shows its own figures`);
    }
  }
  return bad;
}
