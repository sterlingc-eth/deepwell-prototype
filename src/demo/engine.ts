/**
 * Demo mode (VITE_DEEPWELL_DEMO): the pure logic behind the industry demo page (/demo/).
 * Everything works from the static fixtures in ./fixtures (made by scripts/demo/gen-industry-demos.mjs from the industry packs):
 * no sign-in, no network, no database, no customer data, nothing saved. Every answer shown is the Donovan reader's own answer
 * over that industry's sample records, produced and checked when the fixture was generated (scripts/verify-industry-demo.ts re-checks it).
 */

export interface DemoIndustryEntry { slug: string; label: string; family: string; familyLabel: string; company: string; core: boolean }
export interface DemoIndex { schema: number; industries: DemoIndustryEntry[] }
export interface DemoPay { status: string; paid: number; balance: number; dueOn: string; paidOn: string | null }
export interface DemoLine { desc: string; amount: number }
export interface DemoDocument {
  id: string; type: string; typeLabel: string; name: string; file: string; date: string; number: string | null;
  customer: string | null; vendor: string | null; total: number | null; direction: string | null; kind: string | null; status: string | null;
  /** A bill (invoice, statement of account): it has a payment status and counts in Billed, Collected and Open. Contracts, quotes and receipts do not. */
  billable: boolean;
  /** The charges on the paper. The lines add up to the subtotal; subtotal plus tax is the total. */
  lines: DemoLine[] | null; subtotal: number | null; tax: number | null; taxRate: number | null; taxLabel: string | null;
  pay: DemoPay | null; endsOn: string | null; fields: Array<[string, string]>; pages: string[];
}
export interface DemoCustomer { id: string; name: string; address: string; phone: string; email: string; docs: number }
export interface DemoAnswer { text: string; headline: string | null; docs: string[]; page: number | null }
export interface DemoQuestion { id: string; intent: string; label: string; q: string; customer?: string; answer: DemoAnswer }
export interface DemoDidYouMean { q: string; typed: string; suggestion: string; corrected: string; answerOf: string }
export interface DemoFixture {
  schema: number; synthetic: true; slug: string; label: string; family: string; familyLabel: string;
  pack: { id: string; version: string; variants: string[] };
  company: string; customerNoun: string; staffNoun: string; staff: string[]; demoToday: string;
  documents: DemoDocument[]; customers: DemoCustomer[]; questions: DemoQuestion[]; didYouMean: DemoDidYouMean | null;
}

/** The build-time switch. Off unless VITE_DEEPWELL_DEMO is exactly "true" (same pattern as VITE_DEEPWELL_VOICE). */
export function demoFlagOn(env: Record<string, unknown> | undefined): boolean {
  return env?.VITE_DEEPWELL_DEMO === 'true';
}

// ---------------------------------------------------------------- ingestion
export const INGEST_STAGES = ['Uploaded', 'Reading pages', 'Fields found', 'Matched'] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];
export interface IngestStep { docId: string; stage: IngestStage; detail: string }

/** The visible processing steps for every document: uploaded, read, fields found, matched to a customer. Staggered like a real
 *  import queue: while one document is being read the next is already uploading. */
export function ingestPlan(fx: DemoFixture): IngestStep[] {
  const per = fx.documents.map((d): IngestStep[] => [
    { docId: d.id, stage: 'Uploaded', detail: d.file },
    { docId: d.id, stage: 'Reading pages', detail: `${d.pages.length} ${d.pages.length === 1 ? 'page' : 'pages'} · ${d.typeLabel}` },
    { docId: d.id, stage: 'Fields found', detail: `${d.fields.length + (d.total != null ? 1 : 0)} fields` },
    { docId: d.id, stage: 'Matched', detail: d.customer ? `Matched to ${d.customer}` : d.vendor ? `Filed under ${d.vendor}` : 'Filed with company records' },
  ]);
  const out: IngestStep[] = []; const n = per.length, k = INGEST_STAGES.length;
  for (let t = 0; t < n + k - 1; t++) for (let s = k - 1; s >= 0; s--) { const step = per[t - s]?.[s]; if (step) out.push(step); }
  return out;
}
/** Stage reached by each document after `done` steps of the plan. */
export function stagesAfter(fx: DemoFixture, done: number): Map<string, IngestStage> {
  const m = new Map<string, IngestStage>(); const plan = ingestPlan(fx);
  for (const s of plan.slice(0, Math.max(0, done))) m.set(s.docId, s.stage);
  return m;
}

// ---------------------------------------------------------------- dashboard
const dayNum = (s: string) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
/** Money is added up in whole cents so nothing drifts; every figure on the dashboard comes from the documents through the functions below. */
export const toCents = (n: number) => Math.round(n * 100);
export const fromCents = (c: number) => c / 100;
/** Days a bill is past its due date on the demo's own "today" (fx.demoToday, never the real clock). 0 = not yet due. */
export function daysOverdue(d: DemoDocument, demoToday: string): number {
  if (!d.pay || toCents(d.pay.balance) <= 0) return 0;
  return Math.max(0, dayNum(demoToday) - dayNum(d.pay.dueOn));
}
export const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due', min: 0, max: 0 },
  { key: '1-30', label: '1 to 30 days overdue', min: 1, max: 30 },
  { key: '31-60', label: '31 to 60 days overdue', min: 31, max: 60 },
  { key: '61-90', label: '61 to 90 days overdue', min: 61, max: 90 },
  { key: '90+', label: 'Over 90 days overdue', min: 91, max: Infinity },
] as const;
export interface DemoCustomerBilling { name: string; invoices: number; billed: number; collected: number; open: number }
export interface DemoBilling {
  invoices: number; billed: number; collected: number; open: number; openInvoices: number; overdue: number; overdueInvoices: number;
  aging: Array<{ key: string; label: string; invoices: number; amount: number }>; byCustomer: DemoCustomerBilling[];
}
/** Billed, collected, open, overdue, the aging of what is open, and the same by customer. null when the workspace has no bills. */
export function billingOf(docs: DemoDocument[], demoToday: string): DemoBilling | null {
  const bills = docs.filter((d) => d.billable && d.pay && d.total != null);
  if (!bills.length) return null;
  const sum = (xs: DemoDocument[], f: (d: DemoDocument) => number) => xs.reduce((a, d) => a + f(d), 0);
  const open = bills.filter((d) => toCents(d.pay!.balance) > 0);
  const late = open.filter((d) => daysOverdue(d, demoToday) > 0);
  const names = [...new Set(bills.map((d) => d.customer ?? d.vendor ?? 'Other'))].sort();
  return {
    invoices: bills.length,
    billed: fromCents(sum(bills, (d) => toCents(d.total!))), collected: fromCents(sum(bills, (d) => toCents(d.pay!.paid))), open: fromCents(sum(open, (d) => toCents(d.pay!.balance))),
    openInvoices: open.length, overdue: fromCents(sum(late, (d) => toCents(d.pay!.balance))), overdueInvoices: late.length,
    aging: AGING_BUCKETS.map((b) => { const xs = open.filter((d) => { const n = daysOverdue(d, demoToday); return n >= b.min && n <= b.max; }); return { key: b.key, label: b.label, invoices: xs.length, amount: fromCents(sum(xs, (d) => toCents(d.pay!.balance))) }; }),
    byCustomer: names.map((name) => { const xs = bills.filter((d) => (d.customer ?? d.vendor ?? 'Other') === name); return { name, invoices: xs.length, billed: fromCents(sum(xs, (d) => toCents(d.total!))), collected: fromCents(sum(xs, (d) => toCents(d.pay!.paid))), open: fromCents(sum(xs, (d) => toCents(d.pay!.balance))) }; }),
  };
}
export interface DemoDashboard {
  documents: number; customers: number; billing: DemoBilling | null; amountsOnFile: number; amountDocuments: number;
  /** kept for the older checks: billed and the open balance (0 when there are no bills) */
  billed: number; openBalance: number; openInvoices: number;
  comingUp: Array<{ doc: DemoDocument; on: string; days: number }>; byType: Array<{ label: string; count: number }>; recent: DemoDocument[];
}
export function dashboardOf(fx: DemoFixture, ingested = fx.documents.length): DemoDashboard {
  const docs = fx.documents.slice(0, ingested);
  const billing = billingOf(docs, fx.demoToday);
  const withAmount = docs.filter((d) => d.total != null);
  const today = dayNum(fx.demoToday);
  const comingUp = docs.filter((d) => d.endsOn).map((d) => ({ doc: d, on: d.endsOn as string, days: dayNum(d.endsOn as string) - today }))
    .filter((x) => x.days >= 0 && x.days <= 365).sort((a, b) => a.days - b.days).slice(0, 5);
  const counts = new Map<string, number>(); for (const d of docs) counts.set(d.typeLabel, (counts.get(d.typeLabel) ?? 0) + 1);
  return {
    documents: docs.length, customers: new Set(docs.map((d) => d.customer).filter(Boolean)).size, billing,
    amountsOnFile: fromCents(withAmount.reduce((a, d) => a + toCents(d.total!), 0)), amountDocuments: withAmount.length,
    billed: billing?.billed ?? 0, openBalance: billing?.open ?? 0, openInvoices: billing?.openInvoices ?? 0,
    comingUp, byType: [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    recent: docs.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6),
  };
}

// ---------------------------------------------------------------- asking Donovan
const STOP = new Set(['the', 'a', 'an', 'on', 'of', 'for', 'in', 'is', 'was', 'what', 'whats', "what's", 'how', 'much', 'do', 'does', 'did', 'we', 'our', 'me', 'please', 'to', 'at', 'from', 'with', 'and', 'it', 'its', 'were', 'are', 'there', 'tell', 'show']);
export const words = (s: string): string[] => s.toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9-]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));
function overlap(a: string, b: string): number { const A = new Set(words(a)), B = new Set(words(b)); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / new Set([...A, ...B]).size; }
/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length; const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1; const row = d[i]!, prev = d[i - 1]!;
    row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[m]![n]!;
}
/** A customer name the question nearly spells ("Kettelby" for "Kettleby"): the corrected question, or null. */
export function nearName(fx: DemoFixture, question: string): { typed: string; suggestion: string; corrected: string } | null {
  const toks = question.split(/(\s+)/);
  for (const c of fx.customers) {
    const parts = c.name.split(' '); if (parts.length !== 2) continue;
    const [firstName, last] = parts as [string, string];
    if (last.length < 5 || question.toLowerCase().includes(c.name.toLowerCase())) continue;
    for (let i = 2; i < toks.length; i++) {
      // a misspelled surname right after this customer's first name ("Sage Kettelby's")
      if (toks[i - 2]!.toLowerCase() !== firstName.toLowerCase()) continue;
      const raw = toks[i]!; const core = raw.replace(/[’']s$/i, '').replace(/[^A-Za-z]/g, '');
      if (core.length < 4 || core.toLowerCase() === last.toLowerCase()) continue;
      if (editDistance(core.toLowerCase(), last.toLowerCase()) <= (last.length >= 8 ? 2 : 1)) {
        const fixed = toks.slice(); fixed[i] = raw.replace(core, last);
        return { typed: `${firstName} ${core}`, suggestion: c.name, corrected: fixed.join('') };
      }
    }
  }
  return null;
}
export type DemoReply =
  | { kind: 'answer'; question: DemoQuestion }
  | { kind: 'did-you-mean'; typed: string; suggestion: string; corrected: string }
  | { kind: 'try-suggested' };
/** Answer a question in the demo: a suggested question (or close wording of one), a near-miss customer name offered back, or a pointer to the suggestions. */
export function askDemo(fx: DemoFixture, question: string): DemoReply {
  const q = question.trim(); if (!q) return { kind: 'try-suggested' };
  const near = nearName(fx, q);
  if (near) return { kind: 'did-you-mean', ...near };
  let best: DemoQuestion | null = null, score = 0;
  for (const x of fx.questions) { const s = overlap(q, x.q); if (s > score) { score = s; best = x; } }
  if (best && score >= 0.6) return { kind: 'answer', question: best };
  return { kind: 'try-suggested' };
}

// ---------------------------------------------------------------- formatting
export const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const niceDate = (s: string) => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
/** Reader text dates are ISO ("2025-06-01"); shown as "1 Jun 2025". */
export const niceText = (t: string) => t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => niceDate(m));
export const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** "tenant" -> "tenants", "family" -> "families", "reporting party" -> "reporting parties". */
export const nounPlural = (w: string) => (/[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /(?:s|x|z|ch|sh)$/.test(w) ? w + 'es' : w + 's');
