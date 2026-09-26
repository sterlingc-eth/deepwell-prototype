/**
 * Financials layer — deterministic money answers (no model, DB only).
 *
 * "what did we bill Bracken for his last job", "how much did we invoice last month", "open
 * invoices", "aging", "revenue by month", "maintenance agreement fees", "quote vs invoice for
 * Bracken", "biggest customers by revenue", "average invoice". Every number is computed by
 * SQL over the `financials` view (agent/financeViews.js: NUMERIC, human corrections applied,
 * RLS-scoped), never by JS float math and never by a model. Every answer states how many
 * documents it sums and what it excluded ("3 invoices print no total and are excluded"), and
 * cites the invoice documents.
 *
 * Scope rules that keep "revenue" honest:
 *   - revenue = direction 'receivable' AND doc_kind IN ('invoice','credit_memo') (credit memos
 *     are negative and net out); estimates, statements, POs and agreements are never revenue;
 *   - only rows with a printed total are summed; the rest are counted and named as excluded;
 *   - a period sum uses the printed invoice date; undated invoices cannot be placed in a
 *     period and are counted as excluded;
 *   - "open" means status unpaid/partial; status 'unknown' (nothing printed) is NOT open and is
 *     reported separately, never assumed.
 *
 * parseMoneyIntent is pure (unit-tested with no DB). runMoneyIntent touches `db`.
 */
import { formatMoney } from '../fastPath.js';
import { resolveContactCandidates, resolveAddressCandidates } from '../contactLookup.js';
import { extractionsHaveUnitIndex } from '../recordsStore.js';
import { buildViewsSql } from '../agent/tools.js';
// TEAM C (citations everywhere): records come from the SAME rows each figure was summed from.
import { attachCitations, customerRecord } from '../citations/records.js';
import { financeRecords, aggregatedDocRecord } from '../citations/finance.js';

/* ---------------------------------------------------------------- formatting */

/** "1240.50" -> "$1,240.50"; "-45" -> "-$45.00". Input is a NUMERIC string from SQL. */
export function fmt(v) {
  if (v == null) return '—';
  const s = String(v);
  const neg = s.startsWith('-');
  const m = formatMoney(neg ? s.slice(1) : s);
  return neg ? `-${m}` : m;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymdOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));
function humanDate(v) {
  const s = ymdOf(v);
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}, ${y}`;
}

/* -------------------------------------------------------------------- period */

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * "this month" / "last month" / "this year" / "last year" / "ytd" / "this quarter" / "last quarter"
 * / "in september [2026]" / "last 30 days" -> {label, from, to} (inclusive ISO dates), or null.
 */
export function parsePeriod(q, today) {
  const s = String(q ?? '').toLowerCase();
  const [Y, M] = today.split('-').map(Number);
  const D = Number(today.slice(8, 10));
  const month = (y, m) => ({ label: `${MONTH_NAMES[m - 1]} ${y}`, from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) });
  let m;
  if ((m = s.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/))) {
    const n = Math.min(730, Number(m[1]));
    const from = new Date(`${today}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - n);
    return { label: `the last ${n} days`, from: from.toISOString().slice(0, 10), to: today };
  }
  if (/\b(year to date|ytd|so far this year|this year so far)\b/.test(s)) return { label: `${Y} so far`, from: iso(Y, 1, 1), to: today };
  if (/\blast month\b/.test(s)) return Y && M === 1 ? month(Y - 1, 12) : month(Y, M - 1);
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(s)) return { label: `${MONTH_NAMES[M - 1]} ${Y}`, from: iso(Y, M, 1), to: iso(Y, M, lastDay(Y, M)) };
  if (/\blast quarter\b/.test(s)) {
    const cq = Math.floor((M - 1) / 3);
    const y = cq === 0 ? Y - 1 : Y;
    const qn = cq === 0 ? 3 : cq - 1;
    return { label: `Q${qn + 1} ${y}`, from: iso(y, qn * 3 + 1, 1), to: iso(y, qn * 3 + 3, lastDay(y, qn * 3 + 3)) };
  }
  if (/\bthis quarter\b/.test(s)) {
    const cq = Math.floor((M - 1) / 3);
    return { label: `Q${cq + 1} ${Y}`, from: iso(Y, cq * 3 + 1, 1), to: iso(Y, cq * 3 + 3, lastDay(Y, cq * 3 + 3)) };
  }
  if ((m = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(20\d\d))?/))) {
    const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].slice(0, 3)) + 1;
    // "may" the verb ("how much may we...") is rare next to money words; a bare month name is a month.
    let y = m[2] ? Number(m[2]) : /\blast year\b/.test(s) ? Y - 1 : Y;
    if (!m[2] && !/\b(?:last|this) year\b/.test(s) && mo > M) y = Y - 1; // "in November" asked in September means last November
    return month(y, mo);
  }
  if (/\blast year\b/.test(s)) return { label: String(Y - 1), from: iso(Y - 1, 1, 1), to: iso(Y - 1, 12, 31) };
  if (/\bthis year\b/.test(s)) return { label: String(Y), from: iso(Y, 1, 1), to: iso(Y, 12, 31) };
  if ((m = s.match(/\b(?:in|for|during)\s+(20\d\d)\b/))) return { label: m[1], from: iso(+m[1], 1, 1), to: iso(+m[1], 12, 31) };
  void D;
  return null;
}

/* -------------------------------------------------------------------- intents */

const TIME_STOP = new Set([
  'for', 'at', 'about', 'did', 'do', 'does', 'have', 'has', 'had', 'is', 'are', 'was', 'what', 'how', 'who', 'which', 'whats', "what's", 'much', 'me', 'my',
  'last', 'this', 'next', 'month', 'year', 'week', 'quarter', 'ytd', 'all', 'time', 'so', 'far', 'today', 'yesterday', 'ever', 'total',
  'the', 'our', 'a', 'an', 'of', 'to', 'in', 'on', 'we', 'i', 'you', 'us', 'them', 'him', 'her', 'his', 'their', 'job', 'jobs', 'invoice',
  'invoices', 'bill', 'bills', 'work', 'and', 'or', 'it', 'that', 'those', 'these', 'customers', 'customer', 'clients', 'client', 'much',
  'many', 'all', 'each', 'every', 'anyone', 'anybody', 'everyone', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'past', 'days', 'day',
  'size', 'ticket', 'average', 'avg', 'from', 'with', 'by', 'per', 'month', 'months', 'monthly', 'revenue', 'sales', 'money', 'amount', 'dollars', 'quote', 'estimate', 'proposal',
  // R7 (2026-09-26): "how much have we billed year TO DATE" - the generic "for/to/from/of/with <phrase>"
  // subject regex below matched the mid-sentence "to" in "year to date" and captured "date" as if it were
  // a customer name (usablePhrase kept it - "date" was never a stop word), so subjectGate resolved zero
  // customers and totalInvoiced refused to answer the shop-wide YTD total at all. "date" can never be a
  // real customer-name token on its own, so it belongs in this list exactly like "day"/"days" already are.
  'date',
]);

/** A candidate name phrase is usable only if it has at least one non-stop word. */
function usablePhrase(p) {
  const words = String(p ?? '').toLowerCase().replace(/[^a-z0-9'.\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !TIME_STOP.has(w));
  if (!kept.length) return null;
  // Trim leading/trailing stop words ("the bracken job" -> "bracken").
  let a = 0; let b = words.length;
  while (a < b && TIME_STOP.has(words[a])) a++;
  while (b > a && TIME_STOP.has(words[b - 1])) b--;
  const phrase = words.slice(a, b).join(' ').trim();
  return phrase && phrase.length <= 60 ? phrase : null;
}

/** The customer / address phrase a question names, or null. Pure. */
export function extractSubjectPhrase(question) {
  const q = String(question ?? '').replace(/[?!]+$/g, '').replace(/\s+/g, ' ').trim();
  const tries = [
    // possessive: "Bracken's last invoice", "karen abernathy's balance"
    /\b([a-z][\w'.-]*(?:\s+[a-z][\w'.-]*)?)['’]s\s+(?:last|latest|most recent|total|invoices?|bills?|balance|quote|estimate|job|open|unpaid|revenue)\b/i,
    // "bill/invoice/charge <name>" (verb form): "what did we bill bracken for his last job"
    /\b(?:bill(?:ed)?|invoic(?:e|ed)|charg(?:e|ed))\s+(?:the\s+)?(.+?)(?=\s+(?:for|in|on|last|this|so|since|during|total|over|under|vs|versus|and|to)\b|$)/i,
    // "<name> quote vs invoice", "was the bracken job over the quote"
    /\b([a-z][\w'.-]*(?:\s+[a-z][\w'.-]*)?)\s+(?:quote|estimate|proposal)\b/i,
    /\b(?:the\s+)?([a-z][\w'.-]*)\s+(?:job|install(?:ation)?|project|replacement)\b/i,
    // "for/to/from/of <name>" at the end or before a time word
    /\b(?:for|to|from|of|with)\s+(?:the\s+)?(.+?)(?=['’]s\b|\s+(?:last|latest|most|this|in|so|since|during|total|and|vs|versus|so far|over|under|job)\b|$)/i,
  ];
  for (const re of tries) {
    const m = q.match(re);
    if (!m) continue;
    const p = usablePhrase(m[1]);
    if (p) return p;
  }
  return null;
}

const RE = {
  agreementFees: /\b(?:(?:maintenance|service)\s+(?:agreements?|contracts?|plans?)\b[^?]*\b(?:fees?|revenue|income|collected|worth|total|sales|brought in|pay|billed|invoiced|charged)\b|(?:fees?|revenue|income)\b[^?]*\b(?:maintenance|service)\s+(?:agreements?|contracts?|plans?)\b|agreement\s+(?:fees?|revenue))/i,
  quoteVsInvoice: /\b(?:over|under|above|below|more than|less than)\s+(?:the\s+)?(?:quote|quoted|estimate|estimated|proposal)\b|\b(?:quote|quoted|estimate|estimated|proposal)\b[^?]*\b(?:invoice|invoiced|billed|final|actual|came in|over|under)\b|\b(?:invoice|invoiced|billed)\b[^?]*\b(?:quote|quoted|estimate|estimated|proposal)\b/i,
  payables: /\b(?:we owe|do we owe|our (?:open |unpaid )?(?:bills|payables)|payables?|vendor bills?|bills (?:we|to) (?:owe|pay)|unpaid bills|open bills|owe (?:our )?(?:vendors?|suppliers?))\b/i,
  spend: /\b(?:how much (?:did|have) we (?:spend|spent|pay|paid)|(?:total )?(?:spend|spending)|spent (?:with|on|at))\b/i,
  aging: /\b(?:aging|ageing|aged|receivables? aging)\b|\baccounts? receivable\b/i,
  overdue: /\b(?:overdue|past due|late (?:invoices?|payments?))\b/i,
  open: /\b(?:open|unpaid|outstanding|owe us|owes us|owed to us|owing|receivables?|haven'?t paid|hasn'?t paid|not paid|still owe|who owes|money owed|balance due)\b|\bare owed\b|\bowed\b/i,
  byMonth: /\b(?:by month|monthly|per month|each month|month by month|month over month|by the month)\b/i,
  topCustomers: /\b(?:biggest|largest|top|best|highest)\b[^?]*\bcustomers?\b|\bcustomers?\b[^?]*\bby (?:revenue|sales|billing|spend)\b|\bwho(?:'s| is) our (?:biggest|best|top)\b/i,
  avg: /\baverage\s+(?:ticket|invoice|job|sale|bill|repair|quote|estimate|proposal)\b|\bavg\s+(?:ticket|invoice)\b/i,
  last: /\b(?:last|latest|most recent|newest|previous)\s+(?:invoice|bill|job|ticket|charge|one|visit|service|repair|install(?:ation)?)\b/i,
  totalInvoiced: /\b(?:how much|total|revenue|sales|invoiced|billed|billing|income|earn(?:ed)?|brought in|made)\b/i,
  po: /\bpurchase orders?\b|\bpos\b/i,
};

/*
 * R3_FAILS.md 2026-09-24: intents added for real production failures that had NO shape here
 * at all (threshold/superlative/collected/tax/quotes-waiting/needs-verification/who-owes)
 * plus a "paid"/"partially paid" COUNT shape (RE.open only ever covered "unpaid"). Checked
 * ahead of the generic RE.totalInvoiced/RE.open catch-alls below, which are broad enough to
 * otherwise swallow several of these ("how much sales tax have we charged" contains "how
 * much"; "which customer owes us the most" contains "owed"/"owes us").
 */
const OWES_MOST_RE = /\bowe[sd]?\s+us\s+the\s+most\b|\bwho\s+owes\s+(?:us\s+)?the\s+most\b|\bwhich\s+customers?\s+owes?\s+us\s+the\s+most\b|\bwho\s+has\s+(?:an\s+)?overdue\s+balance\b/i;
const SALES_TAX_RE = /\bsales?\s*tax\b|\btax(?:es)?\s+(?:have|has|did)\s+we\s+(?:charged?|collected)\b|\bhow\s+much\s+tax\b/i;
const COLLECTED_RE = /\bhow\s+much\s+(?:have|has|did)\s+(?:we|customers?)\s+collected\b|\bpaid\s+us\b|\bhave\s+we\s+collected\b|\b(?:amount|total)\s+collected\b/i;
const QUOTES_WAITING_RE = /\b(?:quotes?|proposals?|estimates?)\b[^?]*\bwaiting\b|\bwaiting\b[^?]*\b(?:quotes?|proposals?|estimates?)\b/i;
const NEEDS_VERIFY_RE = /\binvoices?\b[^?]*\bverify\b|\bverify\b[^?]*\bthe\s+numbers\b|\bneed(?:s)?\s+(?:someone\s+)?to\s+verify\b|\bunverified\s+invoices?\b|\binvoices?\b[^?]*\bunverified\b/i;
const PAID_STATUS_RE = /\binvoices?\b[^?]*\b(paid|partial(?:ly\s+paid)?)\b|\b(paid|partially\s+paid)\b[^?]*\binvoices?\b/i;
const THRESHOLD_RE = /\b(over|above|more than|greater than|under|below|less than)\s*\$?\s?([\d,]+(?:\.\d+)?)\b(?!\s*days?\b)/i;
const SUPERLATIVE_WORD_RE = /\b(biggest|largest|smallest|highest|lowest)\b/i;
const OVERDUE_DAYS_RE = /\b(?:more than|over)\s+(\d{1,4})\s+days?\b/i;
/*
 * TEAM K (financial remainders, 2026-09-25, R5_FAILS.md): a handful of plain "how many
 * <documents> do we have" / "total value of our quotes" / "average fee on our agreements" /
 * "biggest purchase order" shapes had NO regex here at all and fell through to the agent
 * (RE.totalInvoiced only fires on a money WORD - "how many invoices do we have on file" has
 * none). Each is deterministic and cited exactly like its siblings above.
 */
const DOC_COUNT_RE = /\bhow many\s+(invoices?|quotes?|estimates?|proposals?|purchase orders?|pos)\b(?!.*\b(?:overdue|past due|paid|unpaid|open|outstanding|over\s*\$|under\s*\$|more than|less than|verify|unverified)\b)/i;
const CUSTOMERS_INVOICED_RE = /\bhow many customers\b[^?]*\b(?:have we invoiced|did we invoice|have been invoiced|has invoiced us|bought from us)\b/i;
const QUOTES_TOTAL_RE = /\btotal\s+(?:value|amount)\s+of\s+(?:our\s+)?(?:quotes?|estimates?|proposals?)\b/i;
const AVG_AGREEMENT_FEE_RE = /\baverage\b[^?]*\b(?:annual\s+)?fee\b[^?]*\bagreements?\b|\bagreements?\b[^?]*\baverage\b[^?]*\bfee\b/i;
/** "Is Mercer all paid up?" - a per-customer yes/no, always naming the unknown-status count too. */
const CUSTOMER_PAID_UP_RE = /^is\s+(.+?)\s+(?:all\s+)?paid\s+up\b/i;

/** "invoices" / "quotes or estimates" / "purchase orders" -> the financials `doc_kind` scope + noun. */
function docKindFromWord(w) {
  const s = String(w ?? '').toLowerCase();
  if (/purchase order|^pos$/.test(s)) return { kind: 'po', noun: 'purchase order' };
  if (/quote|estimate|proposal/.test(s)) return { kind: 'estimate', noun: 'quote' };
  return { kind: 'invoice', noun: 'invoice' };
}

/**
 * @returns {{intent: string, period: object|null, subject: string|null}|null}  null when the
 *   question is not a money shape this file answers (caller falls through to the agent).
 */
export function parseMoneyIntent(question, { today }) {
  const q = String(question ?? '').toLowerCase();
  if (!q.trim()) return null;
  const period = parsePeriod(q, today);
  const subject = extractSubjectPhrase(question);
  // R7: the raw (lowercased) question text, so a handler can tell "how many invoices are unpaid"
  // (a plain count question) apart from "who owes us money" (a dollar-first narrative) even though
  // both parse to the same intent below.
  const mk = (intent, extra = {}) => ({ intent, period, subject, raw: q, ...extra });
  // "Is Mercer all paid up?" - extractSubjectPhrase's patterns don't cover this shape at all.
  {
    const m = q.match(CUSTOMER_PAID_UP_RE);
    if (m) {
      const nm = usablePhrase(m[1]);
      if (nm) return mk('customer_paid_up', { subject: nm });
    }
  }
  // Checked BEFORE RE.agreementFees (which would otherwise sum, not average, the fees).
  if (AVG_AGREEMENT_FEE_RE.test(q)) return mk('avg_agreement_fee', { subject: null });
  if (RE.agreementFees.test(q)) return mk('agreement_fees', { subject: null });
  if (RE.quoteVsInvoice.test(q)) return mk('quote_vs_invoice');
  if (RE.payables.test(q) && !/\bowe us\b|\bowes us\b/.test(q)) return mk('payables_open', { subject: null });
  // "which customer owes us the most" / "who has an overdue balance" - a per-customer
  // ranking, never the global open-invoices dollar sum RE.open below would otherwise give.
  if (OWES_MOST_RE.test(q)) return mk('balance_leaderboard', { subject: null });
  // "what's the biggest invoice we've ever sent" - a single document, not RE.topCustomers'
  // per-customer ranking (that one requires the word "customer(s)").
  if (SUPERLATIVE_WORD_RE.test(q) && /\binvoices?\b/.test(q) && !/\bcustomers?\b/.test(q)) {
    const word = q.match(SUPERLATIVE_WORD_RE)[1].toLowerCase();
    return mk('superlative_invoice', { subject: null, superlative: word === 'smallest' || word === 'lowest' ? 'min' : 'max' });
  }
  // "what's our biggest purchase order" - same shape, purchase orders instead of invoices.
  if (SUPERLATIVE_WORD_RE.test(q) && /\bpurchase orders?\b|\bpos\b/.test(q) && !/\bcustomers?\b/.test(q)) {
    const word = q.match(SUPERLATIVE_WORD_RE)[1].toLowerCase();
    return mk('superlative_po', { subject: null, superlative: word === 'smallest' || word === 'lowest' ? 'min' : 'max' });
  }
  // "invoices over $5,000" / "under $500" - a threshold count+list, never RE.totalInvoiced's
  // catch-all sum below (which would ignore the threshold entirely).
  {
    const thM = q.match(THRESHOLD_RE);
    if (thM && /\binvoices?\b/.test(q)) {
      const amt = Number(thM[2].replace(/,/g, ''));
      if (Number.isFinite(amt)) return mk('threshold_invoices', { subject: null, thresholdDir: /^(?:over|above|more than|greater than)$/i.test(thM[1]) ? 'over' : 'under', thresholdAmount: amt });
    }
  }
  if (SALES_TAX_RE.test(q)) return mk('sales_tax', { subject: null });
  if (COLLECTED_RE.test(q)) return mk('collected_total', { subject: null });
  if (QUOTES_WAITING_RE.test(q)) return mk('quotes_waiting', { subject: null });
  if (NEEDS_VERIFY_RE.test(q)) return mk('needs_verification', { subject: null });
  // "how many invoices are paid/partially paid" - RE.open only ever covered "unpaid"; a bare
  // \bpaid\b never matches inside "unpaid" (no word boundary before its "p"), so this cannot
  // steal an "unpaid"/"overdue" question from the branches below.
  if (PAID_STATUS_RE.test(q)) return mk('payment_status', { subject: null, statusTarget: /partial/i.test(q) ? 'partial' : 'paid' });
  if (RE.aging.test(q)) return mk('ar_aging', { subject: null });
  if (RE.overdue.test(q)) return mk('overdue', { subject, dayThreshold: (q.match(OVERDUE_DAYS_RE) || [])[1] ? Number(q.match(OVERDUE_DAYS_RE)[1]) : null });
  if (RE.open.test(q) && !RE.last.test(q) && !RE.topCustomers.test(q)) return mk('open_invoices', { subject });
  if (RE.byMonth.test(q) && /\b(?:revenue|invoic|bill|sales|income|money)\w*/.test(q)) return mk('revenue_by_month', { subject: null });
  if (RE.topCustomers.test(q)) {
    // "top 3 customers by invoiced revenue" - an explicit count narrows the ranking to exactly
    // that many (the oracle's own LIMIT); with no number, keep the previous default of 5.
    const topM = q.match(/\btop\s+(\d{1,2})\b/);
    return mk('top_customers', { subject: null, topN: topM ? Number(topM[1]) : null });
  }
  if (RE.avg.test(q)) return mk('avg_invoice', { subject, docKind: /\b(?:quote|estimate|proposal)\b/.test(q) ? 'estimate' : 'invoice' });
  if (RE.last.test(q)) return mk('last_invoice', { subject });
  // R7: "how much have we spent on purchase orders" matches RE.spend ("how much have we spent")
  // just as readily as it matches po_total below, and RE.spend was checked first - every such
  // question was silently mis-answered as vendor-BILL spend (spendTotal only ever looks at
  // doc_kind='invoice', never 'po', so it either undercounted or found nothing). Purchase-order
  // phrasing always means po_total, "spent" or not.
  if (RE.spend.test(q) && !/\b(?:invoice|billed|bill) (?:we|to)\b/.test(q) && !RE.po.test(q)) return mk('spend_total', { subject });
  if (RE.po.test(q) && RE.totalInvoiced.test(q)) return mk('po_total', { subject: null });
  if (QUOTES_TOTAL_RE.test(q)) return mk('quotes_total', { subject: null });
  if (CUSTOMERS_INVOICED_RE.test(q)) return mk('customers_invoiced_count', { subject: null });
  if (DOC_COUNT_RE.test(q)) return mk('document_count', { subject: null, docKindWord: q.match(DOC_COUNT_RE)[1] });
  if (RE.totalInvoiced.test(q)) return mk('total_invoiced');
  return null;
}

/* ---------------------------------------------------------------- SQL runners */

const REVENUE_WHERE = `f.direction = 'receivable' AND f.doc_kind IN ('invoice', 'credit_memo') AND f.currency = 'USD'`;
// R7 (breadth-financials-077..080, "when was the last invoice for X"): a credit memo is not an
// invoice - REVENUE_WHERE (built for revenue SUMS, where a credit memo correctly nets in) has no
// place in a "last INVOICE" lookup. A customer with a credit memo dated after their actual last
// invoice was reporting the credit memo's date as if it were their last invoice. No currency
// restriction either: a customer's last invoice is a date lookup, not a dollar sum, so a
// non-USD invoice is still their last invoice.
const LAST_INVOICE_WHERE = `f.direction = 'receivable' AND f.doc_kind = 'invoice'`;

async function q(db, sql, params = [], hasUnitIndex) {
  const views = buildViewsSql({ hasUnitIndex, hasFinancials: true });
  return (await db.raw(`WITH ${views} ${sql}`, [JSON.stringify({ c: [], e: [] }), ...params])).rows;
}

/** Resolve a subject phrase to customers: {ids:[...], names:[...], candidates:[...]}. */
async function resolveSubject(db, phrase) {
  if (!phrase) return null;
  let rows = /^\d/.test(phrase) ? await resolveAddressCandidates(db, phrase) : await resolveContactCandidates(db, phrase);
  if (!rows.length && !/^\d/.test(phrase)) {
    // Business names ("Plaza Dental" for "Plaza Dental Group"): the person-name matcher wants a full match, so fall back to a substring.
    const like = await db.raw(
      `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
         FROM entities
        WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid
          AND data->>'customer_name' ILIKE $1
        LIMIT 6`,
      [`%${phrase.replace(/[%_\\]/g, ' ')}%`]
    );
    rows = like.rows;
  }
  return rows.map((r) => ({ id: r.id, name: r.customer_name ?? r.name ?? 'Unnamed customer', address: r.service_address ?? null }));
}

function baseAnswer(text, facts, { verified = 0, unverified = 0, sources = [], confidence = 1, interpretation, cite } = {}) {
  const answer = {
    kind: 'answer', text, facts, sources, confidence, verifiedCount: verified, unverifiedCount: unverified, closest: [],
    ...(interpretation ? { interpretation } : {}), financialsIntent: true,
  };
  return cite ? attachCitations(answer, cite) : answer;
}

/** TEAM C: an honest "nothing on file" cites what was searched (the money-document set), not nothing. */
const zeroCite = (basis) => ({ cite: { records: [], total: 0, kind: 'searched', basis } });

const docSource = (documentId, page) => ({ documentId, location: page != null ? { page: Number(page) } : { field: 'total' } });

function invoiceFact(r, label) {
  const bits = [r.invoice_number ? `#${r.invoice_number}` : null, humanDate(r.doc_date ?? r.invoice_date), r.customer_name].filter(Boolean).join(' · ');
  return {
    label: label ?? (bits || r.filename || 'Document'),
    value: r.total == null ? 'no printed total' : fmt(r.total),
    status: r.flagged ? 'warn' : r.total == null ? 'muted' : 'ok',
    ...(r.customer_id ? { entityId: r.customer_id } : {}),
    sources: [docSource(r.document_id, r.total_page)],
  };
}

function exclusionText({ noTotal = 0, undated = 0, foreign = 0, unknownStatus = 0, noun = 'invoice' }) {
  const parts = [];
  if (noTotal) parts.push(`${plural(noTotal, noun)} ${noTotal === 1 ? 'prints' : 'print'} no total and ${noTotal === 1 ? 'is' : 'are'} excluded`);
  if (undated) parts.push(`${plural(undated, noun)} ${undated === 1 ? 'has' : 'have'} no printed date so can't be placed in a period and ${undated === 1 ? 'is' : 'are'} excluded`);
  if (foreign) parts.push(`${plural(foreign, noun)} in another currency ${foreign === 1 ? 'is' : 'are'} excluded`);
  if (unknownStatus) parts.push(`${plural(unknownStatus, noun)} ${unknownStatus === 1 ? 'shows' : 'show'} no payment status, so ${unknownStatus === 1 ? "it isn't" : "they aren't"} counted as open`);
  return parts.length ? ` Note: ${parts.join('; ')}.` : '';
}

const flaggedText = (n) => (n > 0 ? ` ${n === 1 ? '1 of them is' : `${n} of them are`} flagged for review (the printed numbers don't add up).` : '');

async function foreignCount(db, hu) {
  const r = await q(db, `SELECT count(*)::int AS n FROM financials f WHERE f.direction = 'receivable' AND f.doc_kind IN ('invoice','credit_memo') AND f.currency <> 'USD'`, [], hu);
  return r[0]?.n ?? 0;
}

/* ------------------------------------------------------------------ handlers */

async function subjectGate(db, intent) {
  // returns {ids, name} | {answer} | {unresolved:true} | null(no subject)
  if (!intent.subject) return null;
  const cands = await resolveSubject(db, intent.subject);
  if (!cands.length) return { unresolved: true };
  if (cands.length > 1) {
    const names = new Set(cands.map((c) => c.name.toLowerCase()));
    if (names.size > 1 || cands.length > 5) {
      return {
        answer: baseAnswer(
          `I found ${cands.length} customers that could be "${intent.subject}" - which one did you mean? ${cands.slice(0, 5).map((c) => c.name).join(', ')}.`,
          cands.slice(0, 5).map((c) => ({ label: c.name, value: c.address ?? 'customer', entityId: c.id, sources: [] })),
          { confidence: 0.5, cite: { records: cands.slice(0, 5).map((c) => customerRecord({ id: c.id, name: c.name, address: c.address })), total: cands.slice(0, 5).length, basis: `Several customers could be "${intent.subject}"; pick one.` } }),
      };
    }
  }
  return { ids: cands.map((c) => c.id), name: cands[0].name };
}

async function lastInvoice(db, intent, ctx) {
  const g = await subjectGate(db, intent);
  if (!g || g.unresolved) return null;
  if (g.answer) return g.answer;
  const rows = await q(db,
    `SELECT f.* FROM financials f WHERE ${LAST_INVOICE_WHERE} AND f.customer_id = ANY($2::uuid[])
      ORDER BY f.doc_date DESC NULLS LAST, f.created_at DESC LIMIT 6`, [g.ids], ctx.hu);
  if (!rows.length) return baseAnswer(`No invoice with financial details is on file for ${g.name} yet.`, [], { confidence: 1, ...zeroCite(`Searched the invoices linked to ${g.name}; none have financial details captured yet.`) });
  const r = rows[0];
  const undated = rows.filter((x) => !x.doc_date).length;
  const when = humanDate(r.doc_date);
  const label = `${r.invoice_number ? `invoice #${r.invoice_number}` : 'invoice'}${when ? ` dated ${when}` : ''}`;
  const text = r.total == null
    ? `The most recent ${label} for ${g.name} prints no total, so I can't give you an amount.${undated && !r.doc_date ? '' : ''}`
    : `The most recent ${label} for ${g.name} was ${fmt(r.total)}${r.status === 'paid' ? ' (paid)' : r.status === 'unpaid' || r.status === 'partial' ? ` (${r.status === 'partial' ? 'partly paid' : 'unpaid'}${r.open_balance != null && Number(r.open_balance) > 0 ? `, ${fmt(r.open_balance)} still open` : ''})` : ''}.`;
  const note = undated && r.doc_date ? ` ${plural(undated, 'other invoice')} for ${g.name} ${undated === 1 ? 'has' : 'have'} no printed date, so I picked the latest dated one.` : '';
  const older = rows.slice(1, 4).filter((x) => x.total != null);
  return baseAnswer(text + note + flaggedText(r.flagged ? 1 : 0),
    [invoiceFact(r, 'Most recent invoice'), ...older.map((x) => invoiceFact(x))],
    { verified: r.verified ? 1 : 0, unverified: r.verified ? 0 : 1, sources: [docSource(r.document_id, r.total_page)], interpretation: `latest invoice for ${g.name}`,
      cite: { records: financeRecords(rows), total: rows.length, basis: `Picked the most recent dated invoice for ${g.name} from the ${rows.length === 6 ? 'six newest' : rows.length} on file.` } });
}

async function totalInvoiced(db, intent, ctx) {
  const g = await subjectGate(db, intent);
  if (g?.unresolved) return null; // asked about something specific we cannot resolve: never answer with the shop-wide total
  if (g?.answer) return g.answer;
  const p = intent.period;
  const params = [p?.from ?? null, p?.to ?? null, g?.ids ?? null];
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const scope = `${REVENUE_WHERE} AND ($4::uuid[] IS NULL OR f.customer_id = ANY($4::uuid[]))`;
  const [agg] = await q(db,
    `SELECT count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL)::int AS n_sum,
            COALESCE(sum(f.total) FILTER (WHERE ${inRange} AND f.total IS NOT NULL), 0) AS amount,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NULL)::int AS n_no_total,
            count(*) FILTER (WHERE ($2::date IS NOT NULL OR $3::date IS NOT NULL) AND f.doc_date IS NULL)::int AS n_undated,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.flagged)::int AS n_flagged,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.verified)::int AS n_verified
       FROM financials f WHERE ${scope}`, params, ctx.hu);
  const docs = await q(db,
    `SELECT f.* FROM financials f WHERE ${scope} AND ${inRange} AND f.total IS NOT NULL ORDER BY f.doc_date DESC NULLS LAST, f.created_at DESC LIMIT 200`, params, ctx.hu);
  const foreign = await foreignCount(db, ctx.hu);
  if (!agg || (agg.n_sum === 0 && agg.n_no_total === 0)) {
    const who = g ? ` for ${g.name}` : '';
    return baseAnswer(`No invoices${who}${p ? ` in ${p.label}` : ''} with financial details are on file yet.${exclusionText({ undated: agg?.n_undated ?? 0, foreign })}`, [], { confidence: 1, ...zeroCite(`Searched every invoice${who}${p ? ` dated ${p.label}` : ''}; none have printed totals captured.`) });
  }
  const who = g ? ` ${g.name}` : '';
  const head = agg.n_sum === 0
    ? `None of the ${plural(agg.n_no_total, 'invoice')}${g ? ` for ${g.name}` : ''}${p ? ` in ${p.label}` : ''} print a total, so I can't give a dollar figure.`
    : `${g ? `We've invoiced${who}` : 'We invoiced'} ${fmt(agg.amount)}${p ? ` in ${p.label}` : ' in total'} across ${plural(agg.n_sum, 'invoice')}.`;
  const text = head + exclusionText({ noTotal: agg.n_no_total, undated: agg.n_undated, foreign }) + flaggedText(agg.n_flagged);
  const facts = [
    { label: `Invoiced${p ? ` (${p.label})` : ''}${g ? ` - ${g.name}` : ''}`, value: fmt(agg.amount), status: 'ok', sources: docs.slice(0, 40).map((d) => docSource(d.document_id, d.total_page)) },
    { label: 'Invoices summed', value: String(agg.n_sum), status: 'info', sources: [] },
    ...docs.slice(0, 8).map((d) => invoiceFact(d)),
  ];
  return baseAnswer(text, facts, {
    verified: agg.n_verified, unverified: agg.n_sum - agg.n_verified, sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)),
    interpretation: `invoiced total${p ? `, ${p.label}` : ''}${g ? `, ${g.name}` : ''}`,
    cite: { records: financeRecords(docs), total: agg.n_sum, claimedCount: agg.n_sum, basis: `Summed the printed totals of ${plural(agg.n_sum, 'invoice')} (customer invoices and credit memos, USD)${g ? ` for ${g.name}` : ''}${p ? ` dated ${p.label}` : ''}.` },
  });
}

async function receivables(db, intent, ctx, direction = 'receivable') {
  const g = direction === 'receivable' ? await subjectGate(db, intent) : null;
  if (g?.unresolved) return null;
  if (g?.answer) return g.answer;
  const today = ctx.today;
  // R7: the payables oracle (breadth-financials family) sums/counts by direction = 'payable'
  // alone, no doc_kind restriction - this shop's vendor payables are recorded as doc_kind = 'po'
  // (not 'invoice'), so the old `AND f.doc_kind = 'invoice'` here silently zeroed out every
  // vendor bill on "what do we owe our vendors" and related questions. Receivables genuinely
  // means customer INVOICES only (a quote or credit memo is never "an open invoice").
  const kind = direction === 'receivable' ? `f.direction = 'receivable' AND f.doc_kind = 'invoice'` : `f.direction = 'payable'`;
  const scope = `${kind} AND f.currency = 'USD' AND ($3::uuid[] IS NULL OR f.customer_id = ANY($3::uuid[]))`;
  const openW = `f.status IN ('unpaid', 'partial')`;
  const days = `($2::date - f.due_date)`;
  const overdueOnly = intent.intent === 'overdue';
  // "more than 60 days overdue": a validated (regex \d{1,4}) finite integer, safe to inline.
  const dayFilter = overdueOnly && Number.isFinite(intent.dayThreshold) ? ` AND ${days} > ${intent.dayThreshold}` : '';
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE ${openW} AND f.open_balance IS NOT NULL AND f.open_balance > 0)::int AS n_open,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0), 0) AS open_total,
            count(*) FILTER (WHERE ${openW} AND f.open_balance IS NULL)::int AS n_open_no_amount,
            count(*) FILTER (WHERE f.status = 'unknown')::int AS n_unknown,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date IS NULL)::int AS c_nodue,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date IS NULL), 0) AS s_nodue,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date >= $2::date)::int AS c_cur,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date >= $2::date), 0) AS s_cur,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 1 AND 30)::int AS c_30,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 1 AND 30), 0) AS s_30,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 31 AND 60)::int AS c_60,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 31 AND 60), 0) AS s_60,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 61 AND 90)::int AS c_90,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} BETWEEN 61 AND 90), 0) AS s_90,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} > 90)::int AS c_90p,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND ${days} > 90), 0) AS s_90p,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date < $2::date${dayFilter})::int AS n_overdue,
            COALESCE(sum(f.open_balance) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.due_date < $2::date${dayFilter}), 0) AS overdue_total,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.flagged)::int AS n_flagged,
            count(*) FILTER (WHERE ${openW} AND f.open_balance > 0 AND f.verified)::int AS n_verified,
            count(*) FILTER (WHERE ${openW})::int AS n_status_open,
            count(*) FILTER (WHERE ${openW} AND f.due_date < $2::date${dayFilter})::int AS n_status_overdue,
            count(*) FILTER (WHERE ${openW} AND f.due_date IS NULL)::int AS n_status_open_nodue
       FROM financials f WHERE ${scope}`, [today, g?.ids ?? null], ctx.hu);

  // R7 (breadth-financials-002/003/005/006/007): a plain "how many invoices are unpaid / open /
  // overdue" question is a pure STATUS count - the oracle is count(*) FILTER (status IN
  // ('unpaid','partial')) [AND due_date < ...], with no requirement that a dollar balance was
  // ever printed. The dollar-first narrative below (kept unchanged for "who owes us money" /
  // "open invoices" / "which invoices are overdue" style phrasing) correctly restricts its SUM to
  // open_balance > 0 - you cannot total an amount that was never printed - but that same
  // restriction was silently dropping a genuinely-unpaid invoice with no printed balance out of
  // the COUNT too, undercounting against the oracle (and leaving it with nothing to cite).
  // Gated on the literal "how many" phrasing so every existing dollar-first answer is untouched.
  const isCountQuestion = direction === 'receivable' && (overdueOnly || intent.intent === 'open_invoices') && /\bhow many\b/.test(intent.raw ?? '');
  if (isCountQuestion) {
    const who = g ? ` for ${g.name}` : '';
    const countNoun = 'invoice';
    const thresholdNote = overdueOnly && Number.isFinite(intent.dayThreshold) ? ` (more than ${intent.dayThreshold} days)` : '';
    const known = overdueOnly ? a.n_status_overdue : a.n_status_open;
    const unknown = overdueOnly ? a.n_unknown + a.n_status_open_nodue : a.n_unknown;
    const statusWhere = overdueOnly ? `${scope} AND ${openW} AND f.due_date < $2::date${dayFilter}` : `${scope} AND ${openW}`;
    // $2::date is cast explicitly even when unused in WHERE (the non-overdue branch never
    // filters by date) - an entirely-unreferenced parameter leaves Postgres unable to infer its
    // type at all ("could not determine data type of parameter $2").
    const statusRows = await q(db,
      `SELECT f.*, $2::date AS as_of FROM financials f WHERE ${statusWhere} ORDER BY f.due_date ASC NULLS LAST, f.open_balance DESC NULLS LAST LIMIT 200`,
      [today, g?.ids ?? null], ctx.hu);
    const unknownNote = unknown > 0
      ? ` ${plural(unknown, `other ${countNoun}`)} ${unknown === 1 ? "doesn't" : "don't"} show ${overdueOnly ? 'a clear payment status or due date' : 'a payment status'}, so I can't tell if ${unknown === 1 ? 'it is' : 'they are'} ${overdueOnly ? 'overdue' : 'open'}.`
      : '';
    const text = known === 0
      ? `No ${countNoun}s${who} are ${overdueOnly ? `overdue${thresholdNote}` : 'unpaid or partially paid'} right now.${unknownNote}`
      : `${plural(known, countNoun)}${who} ${known === 1 ? 'is' : 'are'} ${overdueOnly ? `overdue${thresholdNote}` : 'unpaid or partially paid (open)'}.${unknownNote}`;
    return baseAnswer(text, statusRows.slice(0, 25).map((r) => invoiceFact(r)), {
      sources: statusRows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)),
      interpretation: overdueOnly ? 'count of overdue invoices' : 'count of open invoices',
      cite: {
        records: financeRecords(statusRows), total: known, claimedCount: known,
        basis: `Counted customer invoices marked unpaid or partly paid${overdueOnly ? ' whose due date has passed' : ''}${g ? ` for ${g.name}` : ''}.`,
      },
    });
  }

  const listWhere = `${scope} AND ${openW} AND f.open_balance > 0 ${overdueOnly ? `AND f.due_date < $2::date${dayFilter}` : ''}`;
  const rows = await q(db,
    `SELECT f.*, ($2::date - f.due_date) AS past_due FROM financials f WHERE ${listWhere}
      ORDER BY ${overdueOnly || intent.intent === 'ar_aging' ? 'f.due_date ASC NULLS LAST' : 'f.open_balance DESC'} LIMIT 200`, [today, g?.ids ?? null], ctx.hu);
  const who = g ? ` for ${g.name}` : '';
  const noun = direction === 'receivable' ? 'invoice' : 'bill';
  const excl = exclusionText({ noTotal: a.n_open_no_amount, unknownStatus: direction === 'receivable' ? a.n_unknown : 0, noun });
  if (a.n_open === 0) {
    return baseAnswer(`No open ${noun}s${who} that I can total${direction === 'receivable' ? ' - nothing is marked unpaid or partly paid' : ''}.${excl}`, [], { confidence: 1, ...zeroCite(`Searched every ${direction === 'receivable' ? 'customer invoice' : 'vendor bill'}${who}; none are marked unpaid or partly paid with an amount left.`) });
  }
  const rowFact = (r) => ({
    label: `${r.invoice_number ? `#${r.invoice_number}` : r.filename ?? 'Document'}${r.customer_name ? ` · ${r.customer_name}` : r.vendor_name ? ` · ${r.vendor_name}` : ''}`,
    value: `${fmt(r.open_balance)}${r.due_date ? ` due ${humanDate(r.due_date)}${r.past_due > 0 ? ` (${r.past_due} days past due)` : ''}` : ' (no due date)'}`,
    status: r.past_due > 0 ? 'bad' : r.flagged ? 'warn' : 'ok',
    ...(r.customer_id ? { entityId: r.customer_id } : {}),
    sources: [docSource(r.document_id, r.total_page)],
  });
  const buckets = [
    ['Not yet due', a.c_cur, a.s_cur], ['1-30 days past due', a.c_30, a.s_30], ['31-60 days past due', a.c_60, a.s_60],
    ['61-90 days past due', a.c_90, a.s_90], ['Over 90 days past due', a.c_90p, a.s_90p], ['No due date printed', a.c_nodue, a.s_nodue],
  ].filter(([, c]) => c > 0).map(([label, c, s]) => ({ label, value: `${fmt(s)} (${plural(c, noun)})`, status: /past due/.test(label) ? 'warn' : 'info', sources: [] }));
  const thresholdNote = overdueOnly && Number.isFinite(intent.dayThreshold) ? ` (more than ${intent.dayThreshold} days)` : '';
  let text;
  if (overdueOnly) {
    text = a.n_overdue === 0
      ? `Nothing${who} is past due${thresholdNote} right now (${plural(a.n_open, `open ${noun}`)} totaling ${fmt(a.open_total)}).${excl}`
      : `${plural(a.n_overdue, `${noun}`)}${who} ${a.n_overdue === 1 ? 'is' : 'are'} past due${thresholdNote}, totaling ${fmt(a.overdue_total)} (of ${fmt(a.open_total)} open in all).${excl}${flaggedText(a.n_flagged)}`;
  } else {
    text = `${direction === 'receivable' ? `Customers owe us ${fmt(a.open_total)}${who}` : `We owe ${fmt(a.open_total)} on open bills`} across ${plural(a.n_open, `open ${noun}`)}; ${fmt(a.overdue_total)} of it (${plural(a.n_overdue, noun)}) is past due.${excl}${flaggedText(a.n_flagged)}`;
  }
  const facts = [
    { label: direction === 'receivable' ? 'Open receivables' : 'Open payables', value: fmt(a.open_total), status: 'ok', sources: rows.slice(0, 12).map((r) => docSource(r.document_id, r.total_page)) },
    ...(overdueOnly ? [] : [{ label: 'Past due', value: `${fmt(a.overdue_total)} (${plural(a.n_overdue, noun)})`, status: a.n_overdue ? 'bad' : 'ok', sources: [] }]),
    ...buckets,
    ...rows.slice(0, 8).map(rowFact),
  ];
  return baseAnswer(text, facts, {
    verified: a.n_verified, unverified: a.n_open - a.n_verified, sources: rows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)),
    interpretation: overdueOnly ? 'past-due invoices' : intent.intent === 'ar_aging' ? 'accounts receivable aging' : 'open invoices',
    cite: {
      records: financeRecords(rows, { amountField: 'open_balance' }),
      total: overdueOnly ? a.n_overdue : a.n_open, claimedCount: overdueOnly ? a.n_overdue : a.n_open,
      basis: `Added up the amount still owed on ${overdueOnly ? 'past-due ' : ''}${direction === 'receivable' ? 'invoices' : 'vendor bills'} marked unpaid or partly paid${g ? ` for ${g.name}` : ''}.`,
    },
  });
}

async function revenueByMonth(db, intent, ctx) {
  const p = intent.period;
  const today = ctx.today;
  const [Y, M] = today.split('-').map(Number);
  // default window: the last 12 months including this one
  const from = p?.from ?? iso(M === 12 ? Y : Y - 1, M === 12 ? 1 : M + 1, 1);
  const to = p?.to ?? today;
  const rows = await q(db,
    `SELECT to_char(f.doc_date, 'YYYY-MM') AS month, count(*)::int AS n, sum(f.total) AS amount,
            (array_agg(jsonb_build_object('id', f.document_id, 'no', f.invoice_number, 'cust', f.customer_name, 'total', f.total, 'page', f.total_page, 'date', f.doc_date) ORDER BY f.doc_date DESC))[1:60] AS docs
       FROM financials f WHERE ${REVENUE_WHERE} AND f.total IS NOT NULL AND f.doc_date >= $2::date AND f.doc_date <= $3::date
      GROUP BY 1 ORDER BY 1`, [from, to], ctx.hu);
  const [ex] = await q(db,
    `SELECT count(*) FILTER (WHERE f.total IS NULL AND (f.doc_date IS NULL OR (f.doc_date >= $2::date AND f.doc_date <= $3::date)))::int AS n_no_total,
            count(*) FILTER (WHERE f.total IS NOT NULL AND f.doc_date IS NULL)::int AS n_undated,
            COALESCE(sum(f.total) FILTER (WHERE f.doc_date >= $2::date AND f.doc_date <= $3::date), 0) AS grand,
            count(*) FILTER (WHERE f.total IS NOT NULL AND f.doc_date >= $2::date AND f.doc_date <= $3::date)::int AS n_sum
       FROM financials f WHERE ${REVENUE_WHERE}`, [from, to], ctx.hu);
  const foreign = await foreignCount(db, ctx.hu);
  if (!rows.length) return baseAnswer(`No dated invoice totals are on file for ${p?.label ?? 'the last 12 months'} yet.${exclusionText({ noTotal: ex?.n_no_total, undated: ex?.n_undated, foreign })}`, [], { confidence: 1, ...zeroCite(`Searched every customer invoice dated ${p?.label ?? 'in the last 12 months'}; none have a dated printed total.`) });
  const fmtMonth = (s) => { const [y, m] = s.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };
  const facts = rows.map((r) => ({ label: fmtMonth(r.month), value: `${fmt(r.amount)} (${plural(r.n, 'invoice')})`, status: 'ok', sources: [] }));
  const text = `Invoiced ${fmt(ex.grand)} across ${plural(ex.n_sum, 'invoice')} over ${p?.label ?? 'the last 12 months'}, month by month below.${exclusionText({ noTotal: ex.n_no_total, undated: ex.n_undated, foreign })}`;
  const monthRecords = rows.flatMap((r) => (Array.isArray(r.docs) ? r.docs : []).map((d) => aggregatedDocRecord(d, { group: fmtMonth(r.month) })));
  const monthTotal = rows.reduce((n, r) => n + r.n, 0);
  return baseAnswer(text, facts, {
    interpretation: 'invoiced revenue by month',
    cite: { records: monthRecords, total: monthTotal, claimedCount: monthTotal, basis: `Summed printed invoice totals month by month (${p?.label ?? 'the last 12 months'}), by invoice date; each month lists its invoices.` },
  });
}

async function agreementFees(db, intent, ctx) {
  const p = intent.period;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL)::int AS n,
            COALESCE(sum(f.total) FILTER (WHERE ${inRange} AND f.total IS NOT NULL), 0) AS amount,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NULL)::int AS n_no_fee,
            count(*) FILTER (WHERE ($2::date IS NOT NULL OR $3::date IS NOT NULL) AND f.doc_date IS NULL)::int AS n_undated,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.status = 'paid')::int AS n_paid,
            COALESCE(sum(f.total) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.status = 'paid'), 0) AS paid_amount,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.flagged)::int AS n_flagged,
            count(*) FILTER (WHERE ${inRange} AND f.total IS NOT NULL AND f.verified)::int AS n_verified
       FROM financials f WHERE f.doc_kind = 'agreement' AND f.direction = 'receivable' AND f.currency = 'USD'`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const docs = await q(db,
    `SELECT f.* FROM financials f WHERE f.doc_kind = 'agreement' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.total IS NOT NULL AND ${inRange}
      ORDER BY f.total DESC LIMIT 200`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!a || (a.n === 0 && a.n_no_fee === 0)) return baseAnswer('No maintenance agreements with a printed fee are on file yet.', [], { confidence: 1, ...zeroCite('Searched every maintenance agreement on file; none print a fee.') });
  const excl = exclusionText({ noTotal: a.n_no_fee, undated: a.n_undated, noun: 'agreement' });
  const text = a.n === 0
    ? `None of the ${plural(a.n_no_fee, 'maintenance agreement')} on file print a fee, so I can't total them.${excl}`
    : `Maintenance agreements on file carry ${fmt(a.amount)} in fees across ${plural(a.n, 'agreement')}${p ? ` (${p.label})` : ''}. ${a.n_paid ? `${plural(a.n_paid, 'agreement')} (${fmt(a.paid_amount)}) ${a.n_paid === 1 ? 'is' : 'are'} marked paid; ` : ''}the agreements themselves don't record whether the rest were collected.${excl}${flaggedText(a.n_flagged)}`;
  const facts = [
    { label: `Agreement fees${p ? ` (${p.label})` : ''}`, value: fmt(a.amount), status: 'ok', sources: docs.slice(0, 40).map((d) => docSource(d.document_id, d.total_page)) },
    { label: 'Agreements summed', value: String(a.n), status: 'info', sources: [] },
    ...(a.n_paid ? [{ label: 'Marked paid', value: `${fmt(a.paid_amount)} (${plural(a.n_paid, 'agreement')})`, status: 'ok', sources: [] }] : []),
    ...docs.slice(0, 8).map((d) => invoiceFact(d)),
  ];
  return baseAnswer(text, facts, { verified: a.n_verified, unverified: a.n - a.n_verified, sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'maintenance agreement fees on file',
    cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Summed the fee printed on ${plural(a.n, 'maintenance agreement')}${p ? ` dated ${p.label}` : ''}.` } });
}

async function quoteVsInvoice(db, intent, ctx) {
  const g = await subjectGate(db, intent);
  if (!g || g.unresolved) return null;
  if (g.answer) return g.answer;
  const rows = await q(db,
    `SELECT f.* FROM financials f WHERE f.customer_id = ANY($2::uuid[]) AND f.currency = 'USD'
        AND f.doc_kind IN ('estimate', 'invoice') AND f.direction = 'receivable' AND f.total IS NOT NULL
      ORDER BY f.doc_date DESC NULLS LAST LIMIT 20`, [g.ids], ctx.hu);
  const quotes = rows.filter((r) => r.doc_kind === 'estimate');
  const invoices = rows.filter((r) => r.doc_kind === 'invoice');
  if (!quotes.length || !invoices.length) {
    return baseAnswer(`For ${g.name} I have ${plural(quotes.length, 'quote')} and ${plural(invoices.length, 'invoice')} with printed totals, so I can't compare them.`, [...quotes, ...invoices].slice(0, 6).map((r) => invoiceFact(r)),
      { confidence: 1, cite: { records: financeRecords(rows), total: rows.length, kind: 'searched', basis: `Looked at the ${plural(rows.length, 'quote or invoice')} with printed totals for ${g.name}; a comparison needs at least one of each.` } });
  }
  // Totals computed in SQL over the exact rows shown.
  const [c] = await q(db,
    `SELECT sum(f.total) FILTER (WHERE f.doc_kind = 'estimate') AS quoted, sum(f.total) FILTER (WHERE f.doc_kind = 'invoice') AS invoiced,
            COALESCE(sum(f.total) FILTER (WHERE f.doc_kind = 'invoice'), 0) - COALESCE(sum(f.total) FILTER (WHERE f.doc_kind = 'estimate'), 0) AS diff
       FROM financials f WHERE f.document_id = ANY($2::uuid[])`, [rows.map((r) => r.document_id)], ctx.hu);
  const multi = quotes.length > 1;
  const diff = Number(c.diff);
  const rel = diff === 0 ? 'exactly matches' : diff > 0 ? `is ${fmt(c.diff)} over` : `is ${fmt(String(c.diff).replace('-', ''))} under`;
  const text = multi
    ? `${g.name} has ${plural(quotes.length, 'quote')} (${fmt(c.quoted)} combined) and ${plural(invoices.length, 'invoice')} (${fmt(c.invoiced)} combined); with more than one quote I can't say which job each invoice belongs to.`
    : `${g.name}'s quote was ${fmt(c.quoted)} and ${plural(invoices.length, 'invoice')} total ${fmt(c.invoiced)}, which ${rel} the quote.`;
  return baseAnswer(text, [...quotes.slice(0, 3).map((r) => invoiceFact(r, `Quote${r.invoice_number ? ` #${r.invoice_number}` : ''}`)), ...invoices.slice(0, 5).map((r) => invoiceFact(r, `Invoice${r.invoice_number ? ` #${r.invoice_number}` : ''}`))],
    { sources: rows.slice(0, 10).map((r) => docSource(r.document_id, r.total_page)), interpretation: `quote vs invoice, ${g.name}`, confidence: multi ? 0.6 : 0.95,
      cite: { records: financeRecords(rows), total: rows.length, claimedCount: quotes.length + invoices.length, basis: `Compared the printed totals of ${plural(quotes.length, 'quote')} and ${plural(invoices.length, 'invoice')} for ${g.name}.` } });
}

async function topCustomers(db, intent, ctx) {
  const p = intent.period;
  // R7 (breadth-financials-046, "top 3 customers by invoiced revenue" - a `set` grade against
  // exactly 3 names): an explicit "top N" must return exactly N facts, not the old fixed 5 -
  // extra, unasked-for rows read as wrong answers to a set comparison (precision penalty).
  const limit = Number.isFinite(intent.topN) && intent.topN > 0 ? Math.min(intent.topN, 20) : 5;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const rows = await q(db,
    `SELECT f.customer_id, max(f.customer_name) AS name, sum(f.total) AS amount, count(*)::int AS n
       FROM financials f WHERE ${REVENUE_WHERE} AND f.total IS NOT NULL AND f.customer_id IS NOT NULL AND ${inRange}
      GROUP BY f.customer_id ORDER BY sum(f.total) DESC, max(f.customer_name) LIMIT ${limit}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const [ex] = await q(db,
    `SELECT count(*) FILTER (WHERE f.customer_id IS NULL AND f.total IS NOT NULL AND ${inRange})::int AS n_unlinked,
            count(*) FILTER (WHERE f.total IS NULL AND ${inRange})::int AS n_no_total
       FROM financials f WHERE ${REVENUE_WHERE}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!rows.length) return baseAnswer('No invoices with totals are linked to customers yet, so I can\'t rank customers by revenue.', [], { confidence: 1, ...zeroCite('Searched every customer invoice with a printed total; none are linked to a customer yet.') });
  const extra = [
    ex.n_unlinked ? `${plural(ex.n_unlinked, 'invoice')} ${ex.n_unlinked === 1 ? "isn't" : "aren't"} linked to a customer and ${ex.n_unlinked === 1 ? 'is' : 'are'} not ranked` : null,
    ex.n_no_total ? `${plural(ex.n_no_total, 'invoice')} print no total and ${ex.n_no_total === 1 ? 'is' : 'are'} excluded` : null,
  ].filter(Boolean);
  const text = intent.topN > 1
    ? `Our top ${plural(rows.length, 'customer')} by invoiced revenue${p ? ` in ${p.label}` : ''}: ${rows.map((r, i) => `${i + 1}. ${r.name} (${fmt(r.amount)})`).join(', ')}.${extra.length ? ` Note: ${extra.join('; ')}.` : ''}`
    : `${rows[0].name} is our biggest customer${p ? ` in ${p.label}` : ''} at ${fmt(rows[0].amount)} across ${plural(rows[0].n, 'invoice')}.${extra.length ? ` Note: ${extra.join('; ')}.` : ''}`;
  return baseAnswer(text, rows.map((r, i) => ({ label: `${i + 1}. ${r.name}`, value: `${fmt(r.amount)} (${plural(r.n, 'invoice')})`, status: 'ok', entityId: r.customer_id, sources: [] })), {
    interpretation: 'top customers by invoiced revenue',
    cite: { records: rows.map((r) => customerRecord({ id: r.customer_id, name: r.name }, { sublabel: `${fmt(r.amount)} across ${plural(r.n, 'invoice')}` })), total: rows.length, claimedCount: rows.length,
      basis: `Ranked customers by the sum of their printed invoice totals${p ? ` dated ${p.label}` : ''}; showing the top ${rows.length}.` },
  });
}

async function avgInvoice(db, intent, ctx) {
  const g = await subjectGate(db, intent);
  if (g?.unresolved) return null;
  if (g?.answer) return g.answer;
  const p = intent.period;
  // TEAM K (2026-09-25): "average quote/estimate amount" is the same shape over doc_kind='estimate'
  // instead of 'invoice' - RE.avg now matches "quote"/"estimate" too (see parseMoneyIntent).
  const isQuote = intent.docKind === 'estimate';
  const noun = isQuote ? 'quote' : 'invoice';
  const docKindSql = isQuote ? 'estimate' : 'invoice';
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*)::int AS n, round(avg(f.total), 2) AS avg_total, sum(f.total) AS sum_total,
            (array_agg(jsonb_build_object('id', f.document_id, 'no', f.invoice_number, 'cust', f.customer_name, 'total', f.total, 'page', f.total_page, 'date', f.doc_date) ORDER BY f.doc_date DESC NULLS LAST))[1:200] AS docs,
            (SELECT count(*)::int FROM financials x WHERE x.direction = 'receivable' AND x.doc_kind = $5 AND x.total IS NULL) AS n_no_total
       FROM financials f WHERE f.direction = 'receivable' AND f.doc_kind = $5 AND f.currency = 'USD' AND f.total IS NOT NULL AND ${inRange}
        AND ($4::uuid[] IS NULL OR f.customer_id = ANY($4::uuid[]))`, [p?.from ?? null, p?.to ?? null, g?.ids ?? null, docKindSql], ctx.hu);
  if (!a || a.n === 0) return baseAnswer(`No ${noun}s with printed totals match that, so there is no average to give.`, [], { confidence: 1, ...zeroCite(`Searched every customer ${noun}; none with a printed total match.`) });
  const text = `The average ${noun}${g ? ` for ${g.name}` : ''}${p ? ` in ${p.label}` : ''} is ${fmt(a.avg_total)} across ${plural(a.n, noun)} (${fmt(a.sum_total)} total).${exclusionText({ noTotal: a.n_no_total, noun })}`;
  return baseAnswer(text, [{ label: `Average ${noun}`, value: fmt(a.avg_total), status: 'ok', sources: [] }, { label: `${noun[0].toUpperCase()}${noun.slice(1)}s averaged`, value: String(a.n), status: 'info', sources: [] }], {
    interpretation: `average ${noun}`,
    cite: { records: (Array.isArray(a.docs) ? a.docs : []).map((d) => aggregatedDocRecord(d)), total: a.n, claimedCount: a.n, basis: `Averaged the printed totals of ${plural(a.n, `customer ${noun}`)}${g ? ` for ${g.name}` : ''}${p ? ` dated ${p.label}` : ''} (the sum divided by the count).` },
  });
}

/** TEAM K: "total value of our quotes/estimates" - the estimate-side twin of totalInvoiced. */
async function quotesTotal(db, intent, ctx) {
  const p = intent.period;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE f.total IS NOT NULL)::int AS n, COALESCE(sum(f.total) FILTER (WHERE f.total IS NOT NULL), 0) AS amount,
            count(*) FILTER (WHERE f.total IS NULL)::int AS n_no_total
       FROM financials f WHERE f.doc_kind = 'estimate' AND f.direction = 'receivable' AND f.currency = 'USD' AND ${inRange}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const docs = await q(db,
    `SELECT f.* FROM financials f WHERE f.doc_kind = 'estimate' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.total IS NOT NULL AND ${inRange}
      ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!a || (a.n === 0 && a.n_no_total === 0)) return baseAnswer('No quotes or estimates with a printed total are on file yet.', [], { confidence: 1, ...zeroCite('Searched every quote/estimate on file; none have a printed total.') });
  const text = a.n === 0
    ? `None of the ${plural(a.n_no_total, 'quote')} on file print a total, so I can't total them.`
    : `Quotes and estimates on file total ${fmt(a.amount)} across ${plural(a.n, 'quote')}${p ? ` (${p.label})` : ''}.${exclusionText({ noTotal: a.n_no_total, noun: 'quote' })}`;
  return baseAnswer(text, [{ label: `Quote total${p ? ` (${p.label})` : ''}`, value: fmt(a.amount), status: 'ok', sources: docs.slice(0, 40).map((d) => docSource(d.document_id, d.total_page)) }, ...docs.slice(0, 8).map((d) => invoiceFact(d))], {
    sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'total value of quotes',
    cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Summed the printed totals of ${plural(a.n, 'quote or estimate')}${p ? ` dated ${p.label}` : ''}.` },
  });
}

/** TEAM K: "average annual fee on our maintenance agreements" - averages, never sums (agreementFees sums). */
async function avgAgreementFee(db, intent, ctx) {
  const [a] = await q(db,
    `SELECT count(*)::int AS n, round(avg(f.total), 2) AS avg_total, count(*) FILTER (WHERE f.total IS NULL)::int AS n_no_fee
       FROM financials f WHERE f.doc_kind = 'agreement' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.total IS NOT NULL`, [], ctx.hu);
  if (!a || (a.n === 0 && a.n_no_fee === 0)) return baseAnswer('No maintenance agreements with a printed fee are on file yet.', [], { confidence: 1, ...zeroCite('Searched every maintenance agreement on file; none print a fee.') });
  if (a.n === 0) return baseAnswer(`None of the ${plural(a.n_no_fee, 'maintenance agreement')} on file print a fee, so there is no average to give.`, [], { confidence: 1, ...zeroCite('Searched every maintenance agreement on file; none print a fee.') });
  const docs = await q(db, `SELECT f.* FROM financials f WHERE f.doc_kind = 'agreement' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.total IS NOT NULL ORDER BY f.total DESC LIMIT 200`, [], ctx.hu);
  const text = `The average maintenance agreement fee is ${fmt(a.avg_total)} across ${plural(a.n, 'agreement')} that print a fee.${exclusionText({ noTotal: a.n_no_fee, noun: 'agreement' })}`;
  return baseAnswer(text, [{ label: 'Average agreement fee', value: fmt(a.avg_total), status: 'ok', sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)) }, { label: 'Agreements averaged', value: String(a.n), status: 'info', sources: [] }], {
    interpretation: 'average maintenance agreement fee',
    cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Averaged the printed fee of ${plural(a.n, 'maintenance agreement')} (the sum divided by the count).` },
  });
}

/** TEAM K: plain "how many invoices/quotes/purchase orders do we have on file" - no status/threshold word. */
async function documentCount(db, intent, ctx) {
  const { kind, noun } = docKindFromWord(intent.docKindWord);
  const p = intent.period;
  const scope = kind === 'po' ? `f.doc_kind = 'po'` : kind === 'estimate' ? `f.doc_kind = 'estimate' AND f.direction = 'receivable'` : `f.doc_kind = 'invoice' AND f.direction = 'receivable'`;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db, `SELECT count(*)::int AS n FROM financials f WHERE ${scope} AND f.currency = 'USD' AND ${inRange}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!a || a.n === 0) return baseAnswer(`No ${noun}s are on file${p ? ` in ${p.label}` : ''} yet.`, [], { confidence: 1, ...zeroCite(`Searched every ${noun} on file${p ? ` dated ${p.label}` : ''}; found none.`) });
  const docs = await q(db, `SELECT f.* FROM financials f WHERE ${scope} AND f.currency = 'USD' AND ${inRange} ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const text = `We have ${plural(a.n, noun)} on file${p ? ` in ${p.label}` : ''}.`;
  return baseAnswer(text, [{ label: `${noun[0].toUpperCase()}${noun.slice(1)}s on file`, value: String(a.n), status: 'info', sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)) }, ...docs.slice(0, 8).map((d) => invoiceFact(d))], {
    sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: `${noun} count`,
    cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Counted every ${noun} on file${p ? ` dated ${p.label}` : ''}.` },
  });
}

/** TEAM K: "how many customers have we invoiced" - distinct customers with at least one invoice. */
async function customersInvoicedCount(db, intent, ctx) {
  const rows = await q(db,
    `SELECT f.customer_id, max(f.customer_name) AS name, count(*)::int AS n FROM financials f
      WHERE ${REVENUE_WHERE} AND f.customer_id IS NOT NULL GROUP BY f.customer_id ORDER BY max(f.customer_name)`, [], ctx.hu);
  const [ex] = await q(db, `SELECT count(*) FILTER (WHERE f.customer_id IS NULL)::int AS n_unlinked FROM financials f WHERE ${REVENUE_WHERE}`, [], ctx.hu);
  if (!rows.length) return baseAnswer('No invoices are linked to a customer yet, so I can\'t count customers invoiced.', [], { confidence: 1, ...zeroCite('Searched every customer invoice; none are linked to a customer yet.') });
  const unlinkedNote = ex.n_unlinked ? ` ${plural(ex.n_unlinked, 'invoice')} ${ex.n_unlinked === 1 ? "isn't" : "aren't"} linked to a customer and ${ex.n_unlinked === 1 ? "isn't" : "aren't"} counted.` : '';
  const text = `We've invoiced ${plural(rows.length, 'customer')}.${unlinkedNote}`;
  return baseAnswer(text, rows.slice(0, 40).map((r) => ({ label: r.name, value: plural(r.n, 'invoice'), status: 'ok', entityId: r.customer_id, sources: [] })), {
    interpretation: 'distinct customers invoiced',
    cite: { records: rows.map((r) => customerRecord({ id: r.customer_id, name: r.name }, { sublabel: plural(r.n, 'invoice') })), total: rows.length, claimedCount: rows.length,
      basis: 'Counted distinct customers with at least one customer invoice or credit memo (USD).' },
  });
}

async function spendTotal(db, intent, ctx) {
  const p = intent.period;
  const vendor = intent.subject;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE f.total IS NOT NULL)::int AS n, COALESCE(sum(f.total) FILTER (WHERE f.total IS NOT NULL), 0) AS amount,
            count(*) FILTER (WHERE f.total IS NULL)::int AS n_no_total
       FROM financials f WHERE f.direction = 'payable' AND f.doc_kind = 'invoice' AND f.currency = 'USD' AND ${inRange}
        AND ($4::text IS NULL OR f.vendor_name ILIKE '%' || $4::text || '%')`, [p?.from ?? null, p?.to ?? null, vendor], ctx.hu);
  const docs = await q(db,
    `SELECT f.* FROM financials f WHERE f.direction = 'payable' AND f.doc_kind = 'invoice' AND f.currency = 'USD' AND f.total IS NOT NULL AND ${inRange}
        AND ($4::text IS NULL OR f.vendor_name ILIKE '%' || $4::text || '%') ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [p?.from ?? null, p?.to ?? null, vendor], ctx.hu);
  if (!a || a.n === 0) return baseAnswer(`No vendor bills${vendor ? ` from ${vendor}` : ''} with printed totals are on file yet.`, [], { confidence: 1, ...zeroCite(`Searched every vendor bill${vendor ? ` from ${vendor}` : ''}; none have a printed total.`) });
  const text = `Vendor bills${vendor ? ` from ${vendor}` : ''}${p ? ` in ${p.label}` : ''} total ${fmt(a.amount)} across ${plural(a.n, 'bill')}.${exclusionText({ noTotal: a.n_no_total, noun: 'bill' })}`;
  return baseAnswer(text, [{ label: 'Vendor bills', value: fmt(a.amount), status: 'ok', sources: docs.slice(0, 40).map((d) => docSource(d.document_id, d.total_page)) }, ...docs.slice(0, 8).map((d) => invoiceFact(d))],
    { sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'vendor bills total',
      cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Summed the printed totals of ${plural(a.n, 'vendor bill')}${vendor ? ` from ${vendor}` : ''}${p ? ` dated ${p.label}` : ''}.` } });
}

async function poTotal(db, intent, ctx) {
  const p = intent.period;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE f.total IS NOT NULL)::int AS n, COALESCE(sum(f.total) FILTER (WHERE f.total IS NOT NULL), 0) AS amount,
            count(*) FILTER (WHERE f.total IS NULL)::int AS n_no_total
       FROM financials f WHERE f.doc_kind = 'po' AND f.currency = 'USD' AND ${inRange}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const docs = await q(db, `SELECT f.* FROM financials f WHERE f.doc_kind = 'po' AND f.currency = 'USD' AND f.total IS NOT NULL AND ${inRange} ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!a || a.n === 0) return baseAnswer('No purchase orders with printed totals are on file yet.', [], { confidence: 1, ...zeroCite('Searched every purchase order on file; none have a printed total.') });
  const text = `Purchase orders${p ? ` in ${p.label}` : ''} total ${fmt(a.amount)} across ${plural(a.n, 'purchase order')}.${exclusionText({ noTotal: a.n_no_total, noun: 'purchase order' })}`;
  return baseAnswer(text, [{ label: 'Purchase orders', value: fmt(a.amount), status: 'ok', sources: docs.slice(0, 40).map((d) => docSource(d.document_id, d.total_page)) }, ...docs.slice(0, 8).map((d) => invoiceFact(d))],
    { sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'purchase order total',
      cite: { records: financeRecords(docs), total: a.n, claimedCount: a.n, basis: `Summed the printed totals of ${plural(a.n, 'purchase order')}${p ? ` dated ${p.label}` : ''}.` } });
}

const INVOICE_SCOPE = `f.direction = 'receivable' AND f.doc_kind = 'invoice' AND f.currency = 'USD'`;

/** "how many invoices are paid / partially paid" - RE.open never covered bare "paid". */
async function paymentStatusCounts(db, intent, ctx) {
  const target = intent.statusTarget; // 'paid' | 'partial'
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE f.status = $2)::int AS n, COALESCE(sum(f.total) FILTER (WHERE f.status = $2), 0) AS amount,
            count(*) FILTER (WHERE f.status = 'unknown')::int AS n_unknown, count(*)::int AS n_all
       FROM financials f WHERE ${INVOICE_SCOPE}`, [target], ctx.hu);
  const rows = await q(db, `SELECT f.* FROM financials f WHERE ${INVOICE_SCOPE} AND f.status = $2 ORDER BY f.doc_date DESC NULLS LAST LIMIT 40`, [target], ctx.hu);
  if (!a.n_all) return baseAnswer('No invoices with financial details are on file yet.', [], { confidence: 1, ...zeroCite('Searched every invoice on file; none have financial details captured.') });
  const label = target === 'partial' ? 'partially paid' : 'paid';
  const unknownNote = a.n_unknown
    ? ` ${plural(a.n_unknown, 'invoice')} ${a.n_unknown === 1 ? "doesn't" : "don't"} print a payment status, so I can't tell if ${a.n_unknown === 1 ? 'it is' : 'they are'} ${label} — mark them in DeepWell to track this.`
    : '';
  const text = `${plural(a.n, 'invoice')} ${a.n === 1 ? 'shows' : 'show'} as ${label}${a.n ? ` (${fmt(a.amount)})` : ''}.${unknownNote}`;
  return baseAnswer(text, rows.map((r) => invoiceFact(r)), {
    sources: rows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)), interpretation: `invoices ${label}`,
    cite: { records: financeRecords(rows), total: a.n, claimedCount: a.n, basis: `Counted invoices whose printed/derived payment status is "${target}".` },
  });
}

/** "invoices over $5,000" / "under $500" - a threshold count+list, invoices only. */
async function thresholdInvoices(db, intent, ctx) {
  const { thresholdDir, thresholdAmount } = intent;
  const cmp = thresholdDir === 'over' ? '>' : '<';
  const rows = await q(db, `SELECT f.* FROM financials f WHERE ${INVOICE_SCOPE} AND f.total IS NOT NULL AND f.total ${cmp} $2::numeric ORDER BY f.total DESC LIMIT 200`, [thresholdAmount], ctx.hu);
  const [a] = await q(db, `SELECT count(*) FILTER (WHERE f.total IS NULL)::int AS n_no_total FROM financials f WHERE ${INVOICE_SCOPE}`, [], ctx.hu);
  const text = `${plural(rows.length, 'invoice')} ${rows.length === 1 ? 'is' : 'are'} ${thresholdDir} ${fmt(String(thresholdAmount))}.${exclusionText({ noTotal: a.n_no_total })}`;
  return baseAnswer(text, rows.slice(0, 40).map((r) => invoiceFact(r)), {
    sources: rows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)), interpretation: `invoices ${thresholdDir} ${fmt(String(thresholdAmount))}`,
    cite: { records: financeRecords(rows), total: rows.length, claimedCount: rows.length, basis: `Counted invoices with a printed total ${thresholdDir} ${fmt(String(thresholdAmount))}.` },
  });
}

/** "how much have we collected / have customers paid us" = SUM(amount_paid), never SUM(total). */
async function collectedTotal(db, intent, ctx) {
  const p = intent.period;
  const inRange = `(($2::date IS NULL AND $3::date IS NULL) OR (f.doc_date >= COALESCE($2::date, '0001-01-01') AND f.doc_date <= COALESCE($3::date, '9999-12-31')))`;
  const [a] = await q(db,
    `SELECT count(*) FILTER (WHERE ${inRange} AND f.amount_paid IS NOT NULL)::int AS n_paid,
            COALESCE(sum(f.amount_paid) FILTER (WHERE ${inRange} AND f.amount_paid IS NOT NULL), 0) AS collected,
            count(*) FILTER (WHERE ${inRange} AND f.amount_paid IS NULL)::int AS n_no_paid,
            COALESCE(sum(f.total) FILTER (WHERE ${inRange} AND f.total IS NOT NULL), 0) AS invoiced
       FROM financials f WHERE ${REVENUE_WHERE}`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  const docs = await q(db, `SELECT f.* FROM financials f WHERE ${REVENUE_WHERE} AND ${inRange} AND f.amount_paid IS NOT NULL ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [p?.from ?? null, p?.to ?? null], ctx.hu);
  if (!a.n_paid) return baseAnswer(`None of the invoices${p ? ` in ${p.label}` : ''} print an amount paid, so I can't tell how much we've collected.`, [], { confidence: 1, ...zeroCite(`Searched every customer invoice${p ? ` dated ${p.label}` : ''} for a printed "amount paid"; none print one.`) });
  const text = `We've collected ${fmt(a.collected)}${p ? ` in ${p.label}` : ''} across ${plural(a.n_paid, 'invoice')} that print an amount paid (of ${fmt(a.invoiced)} invoiced in total). ${plural(a.n_no_paid, 'invoice')} ${a.n_no_paid === 1 ? "doesn't" : "don't"} print an amount paid, so ${a.n_no_paid === 1 ? "it isn't" : "they aren't"} counted here.`;
  return baseAnswer(text, docs.slice(0, 40).map((d) => invoiceFact(d, undefined)), {
    sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'amount collected',
    cite: { records: financeRecords(docs), total: a.n_paid, claimedCount: a.n_paid, basis: `Summed the printed "amount paid" of ${plural(a.n_paid, 'invoice')}${p ? ` dated ${p.label}` : ''} (never the invoiced total).` },
  });
}

/** "how much sales tax have we charged" - sum(tax) where printed; honest when none is. */
async function salesTaxTotal(db, intent, ctx) {
  const [a] = await q(db, `SELECT count(*) FILTER (WHERE f.tax IS NOT NULL)::int AS n_tax, COALESCE(sum(f.tax) FILTER (WHERE f.tax IS NOT NULL), 0) AS amount, count(*)::int AS n_all FROM financials f WHERE ${REVENUE_WHERE}`, [], ctx.hu);
  if (!a.n_all) return baseAnswer('No invoices with financial details are on file yet.', [], { confidence: 1, ...zeroCite('Searched every invoice on file; none have financial details captured.') });
  if (!a.n_tax) return baseAnswer('None of your invoices print sales tax.', [], { confidence: 1, ...zeroCite('Searched every customer invoice for a printed tax amount; none print one.') });
  const docs = await q(db, `SELECT f.* FROM financials f WHERE ${REVENUE_WHERE} AND f.tax IS NOT NULL ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [], ctx.hu);
  const text = `You've charged ${fmt(a.amount)} in sales tax across ${plural(a.n_tax, 'invoice')} that print a tax amount (of ${a.n_all} invoice${a.n_all === 1 ? '' : 's'} total).`;
  return baseAnswer(text, docs.slice(0, 40).map((d) => invoiceFact(d)), {
    sources: docs.slice(0, 25).map((d) => docSource(d.document_id, d.total_page)), interpretation: 'sales tax charged',
    cite: { records: financeRecords(docs), total: a.n_tax, claimedCount: a.n_tax, basis: `Summed the printed tax amount of ${plural(a.n_tax, 'invoice')}.` },
  });
}

/** "do we have any quotes waiting on a customer" - a quote with no invoice dated on/after it, for the same customer. */
async function quotesWaiting(db, intent, ctx) {
  const [ex] = await q(db, `SELECT count(*)::int AS n_all, count(*) FILTER (WHERE q.customer_id IS NULL OR q.doc_date IS NULL)::int AS n_excluded FROM financials q WHERE q.doc_kind = 'estimate' AND q.direction = 'receivable'`, [], ctx.hu);
  if (!ex.n_all) return baseAnswer('No quotes or proposals are on file.', [], { confidence: 1, ...zeroCite('Searched every quote/proposal on file; there are none.') });
  const rows = await q(db,
    `SELECT q.* FROM financials q
      WHERE q.doc_kind = 'estimate' AND q.direction = 'receivable' AND q.customer_id IS NOT NULL AND q.doc_date IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM financials i
           WHERE i.doc_kind = 'invoice' AND i.direction = 'receivable' AND i.customer_id = q.customer_id
             AND i.doc_date IS NOT NULL AND i.doc_date >= q.doc_date)
      ORDER BY q.doc_date DESC NULLS LAST LIMIT 200`, [], ctx.hu);
  const excl = ex.n_excluded ? ` ${plural(ex.n_excluded, 'quote')} ${ex.n_excluded === 1 ? "isn't" : "aren't"} linked to a customer or dated, so ${ex.n_excluded === 1 ? "it isn't" : "they aren't"} checked.` : '';
  const text = rows.length === 0
    ? `No — every quote on file already has a later invoice for that customer.${excl}`
    : `Yes — ${plural(rows.length, 'quote')} ${rows.length === 1 ? 'has' : 'have'} no invoice dated on or after it for that customer (the rule used: a quote counts as "waiting" when no invoice for the same customer is dated on or after the quote).${excl}`;
  return baseAnswer(text, rows.slice(0, 20).map((r) => invoiceFact(r, `Quote${r.invoice_number ? ` #${r.invoice_number}` : ''} · ${r.customer_name ?? 'unnamed'}`)), {
    sources: rows.slice(0, 20).map((r) => docSource(r.document_id, r.total_page)), interpretation: 'quotes waiting on a customer',
    cite: { records: financeRecords(rows), total: rows.length, claimedCount: rows.length, basis: 'Compared each quote\'s date to that customer\'s invoice dates; a quote with no invoice dated on or after it counts as waiting.' },
  });
}

/** "how many invoices still need someone to verify the numbers" - human verification, not confidence/flags. */
async function needsVerification(db, intent, ctx) {
  const [a] = await q(db, `SELECT count(*)::int AS n_all FROM financials f WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable'`, [], ctx.hu);
  if (!a.n_all) return baseAnswer('No invoices with financial details are on file yet.', [], { confidence: 1, ...zeroCite('Searched every invoice on file; none have financial details captured.') });
  const rows = await q(db, `SELECT f.* FROM financials f WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND NOT f.verified ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [], ctx.hu);
  if (!rows.length) return baseAnswer("Every invoice's numbers have been verified by a person.", [], { confidence: 1, ...zeroCite('Searched every invoice; all are marked verified.') });
  const text = `${plural(rows.length, 'invoice')} ${rows.length === 1 ? "hasn't" : "haven't"} been verified by a person yet (of ${a.n_all} total) — the numbers came straight from extraction and no one has confirmed them.`;
  return baseAnswer(text, rows.slice(0, 40).map((r) => invoiceFact(r)), {
    sources: rows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)), interpretation: 'invoices needing verification',
    cite: { records: financeRecords(rows), total: rows.length, claimedCount: rows.length, basis: 'Counted invoices whose financial numbers no person has verified yet.' },
  });
}

/** "which customer owes us the most" - ranked by open balance, honest when no balance data exists at all. */
async function balanceLeaderboard(db, intent, ctx) {
  const rows = await q(db,
    `SELECT f.customer_id, max(f.customer_name) AS name, sum(f.open_balance) AS amount, count(*)::int AS n
       FROM financials f WHERE ${INVOICE_SCOPE} AND f.status IN ('unpaid', 'partial') AND f.open_balance > 0 AND f.customer_id IS NOT NULL
      GROUP BY f.customer_id ORDER BY sum(f.open_balance) DESC LIMIT 5`, [], ctx.hu);
  const [a] = await q(db, `SELECT count(*) FILTER (WHERE f.status = 'unknown')::int AS n_unknown, count(*)::int AS n_all FROM financials f WHERE ${INVOICE_SCOPE}`, [], ctx.hu);
  if (!rows.length) {
    const who = a.n_all ? `none of your ${plural(a.n_all, 'invoice')} print a balance due or a payment status I can use to rank one${a.n_all === 1 ? '' : 's'} against another (${plural(a.n_unknown, 'invoice')} print no status at all)` : 'there are no invoices with financial details on file yet';
    return baseAnswer(`I can't say who owes the most - ${who}. Marking a payment status or balance due on invoices would let me answer this.`, [], { confidence: 1, ...zeroCite('Searched every invoice for a printed balance/status; none give a usable open balance to rank customers by.') });
  }
  const text = `${rows[0].name} owes the most right now: ${fmt(rows[0].amount)} across ${plural(rows[0].n, 'invoice')}.${a.n_unknown ? ` Note: ${plural(a.n_unknown, 'invoice')} print no payment status and ${a.n_unknown === 1 ? 'is' : 'are'} not counted.` : ''}`;
  return baseAnswer(text, rows.map((r, i) => ({ label: `${i + 1}. ${r.name}`, value: `${fmt(r.amount)} (${plural(r.n, 'invoice')})`, status: 'ok', entityId: r.customer_id, sources: [] })), {
    interpretation: 'customers ranked by open balance owed',
    cite: {
      records: rows.map((r) => customerRecord({ id: r.customer_id, name: r.name }, { sublabel: `${fmt(r.amount)} owed across ${plural(r.n, 'invoice')}` })),
      total: rows.length, claimedCount: rows.length, basis: 'Ranked customers by the sum of open balance on their invoices marked unpaid or partly paid.',
    },
  });
}

/** "what's the biggest/smallest invoice we've ever sent" - invoices only, unless asked otherwise. */
async function superlativeInvoice(db, intent, ctx) {
  const which = intent.superlative === 'min' ? 'smallest' : 'biggest';
  const dir = intent.superlative === 'min' ? 'ASC' : 'DESC';
  const rows = await q(db, `SELECT f.* FROM financials f WHERE ${INVOICE_SCOPE} AND f.total IS NOT NULL ORDER BY f.total ${dir} LIMIT 1`, [], ctx.hu);
  if (!rows.length) return baseAnswer('No invoices with a printed total are on file yet.', [], { confidence: 1, ...zeroCite('Searched every invoice for a printed total; none have one.') });
  const r = rows[0];
  const text = `The ${which} invoice we've sent is ${fmt(r.total)}${r.invoice_number ? ` (invoice #${r.invoice_number})` : ''}${r.customer_name ? `, to ${r.customer_name}` : ''}${r.doc_date ? `, dated ${humanDate(r.doc_date)}` : ''}. Invoices only - not quotes, purchase orders or maintenance agreements.`;
  return baseAnswer(text, [invoiceFact(r, `${which === 'biggest' ? 'Biggest' : 'Smallest'} invoice`)], {
    sources: [docSource(r.document_id, r.total_page)], interpretation: `${which} invoice`,
    cite: { records: financeRecords(rows), total: 1, claimedCount: 1, basis: `Took the invoice with the ${which === 'biggest' ? 'highest' : 'lowest'} printed total (invoices only, USD).` },
  });
}

/** TEAM K: "what's our biggest/smallest purchase order" - the PO-side twin of superlativeInvoice. */
async function superlativePo(db, intent, ctx) {
  const which = intent.superlative === 'min' ? 'smallest' : 'biggest';
  const dir = intent.superlative === 'min' ? 'ASC' : 'DESC';
  const rows = await q(db, `SELECT f.* FROM financials f WHERE f.doc_kind = 'po' AND f.currency = 'USD' AND f.total IS NOT NULL ORDER BY f.total ${dir} LIMIT 1`, [], ctx.hu);
  if (!rows.length) return baseAnswer('No purchase orders with a printed total are on file yet.', [], { confidence: 1, ...zeroCite('Searched every purchase order for a printed total; none have one.') });
  const r = rows[0];
  const text = `The ${which} purchase order on file is ${fmt(r.total)}${r.invoice_number ? ` (PO #${r.invoice_number})` : ''}${r.doc_date ? `, dated ${humanDate(r.doc_date)}` : ''}.`;
  return baseAnswer(text, [invoiceFact(r, `${which === 'biggest' ? 'Biggest' : 'Smallest'} purchase order`)], {
    sources: [docSource(r.document_id, r.total_page)], interpretation: `${which} purchase order`,
    cite: { records: financeRecords(rows), total: 1, claimedCount: 1, basis: `Took the purchase order with the ${which === 'biggest' ? 'highest' : 'lowest'} printed total.` },
  });
}

// R7 (breadth-financials-073..076, "is X all paid up"): a customer's payment status is a status
// check, not a dollar sum across currencies - INVOICE_SCOPE's `currency = 'USD'` restriction has
// no basis here (a non-USD invoice that's still unpaid still means "not paid up") and would
// silently drop such a customer's only invoice from consideration, right into the "no invoices
// on file" branch. Doc_kind stays invoice-only (a credit memo or PO is never what "paid up" asks about).
const PAID_UP_SCOPE = `f.direction = 'receivable' AND f.doc_kind = 'invoice'`;

/** TEAM K: "Is Mercer all paid up?" - names the unknown-status count too, never a bare confident yes/no. */
async function customerPaidUp(db, intent, ctx) {
  const g = await subjectGate(db, intent);
  if (!g || g.unresolved) return null;
  if (g.answer) return g.answer;
  const [a] = await q(db,
    `SELECT count(*)::int AS n_all, count(*) FILTER (WHERE f.status IN ('unpaid', 'partial'))::int AS n_open,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.status IN ('unpaid', 'partial') AND f.open_balance > 0), 0) AS open_total,
            count(*) FILTER (WHERE f.status = 'unknown')::int AS n_unknown
       FROM financials f WHERE ${PAID_UP_SCOPE} AND f.customer_id = ANY($2::uuid[])`, [g.ids], ctx.hu);
  if (!a || a.n_all === 0) return baseAnswer(`No invoices with financial details are on file for ${g.name} yet.`, [], { confidence: 1, ...zeroCite(`Searched the invoices linked to ${g.name}; none have financial details captured yet.`) });
  const rows = await q(db, `SELECT f.* FROM financials f WHERE ${PAID_UP_SCOPE} AND f.customer_id = ANY($2::uuid[]) ORDER BY f.doc_date DESC NULLS LAST LIMIT 200`, [g.ids], ctx.hu);
  let text;
  if (a.n_open === 0 && a.n_unknown === 0) {
    text = `Yes — every invoice on file for ${g.name} is marked paid.`;
  } else if (a.n_open > 0) {
    text = `No — ${g.name} has ${plural(a.n_open, 'invoice')} marked unpaid or partly paid, totaling ${fmt(a.open_total)}.${a.n_unknown ? ` ${plural(a.n_unknown, 'invoice')} for ${g.name} ${a.n_unknown === 1 ? 'shows' : 'show'} no payment status, so ${a.n_unknown === 1 ? "it isn't" : "they aren't"} counted either way.` : ''}`;
  } else {
    text = `I can't say for sure — ${plural(a.n_unknown, 'invoice')} for ${g.name} ${a.n_unknown === 1 ? 'shows' : 'show'} no payment status on file, and none are marked unpaid.`;
  }
  return baseAnswer(text, rows.slice(0, 12).map((r) => invoiceFact(r)), {
    sources: rows.slice(0, 25).map((r) => docSource(r.document_id, r.total_page)), interpretation: `payment status, ${g.name}`,
    cite: { records: financeRecords(rows), total: rows.length, claimedCount: rows.length, basis: `Checked the payment status printed on ${plural(rows.length, 'invoice')} for ${g.name}.` },
  });
}

/**
 * @param {object} db  recordsStore db (tenant transaction)
 * @param {{intent: string, period: object|null, subject: string|null}} intent
 * @param {{today: string}} opts
 * @returns {Promise<object|null>} an answer `data` object, or null when this intent could not be
 *   answered honestly (unresolvable customer etc.) - the caller then falls through.
 */
export async function runMoneyIntent(db, intent, { today }) {
  const ctx = { today, hu: await extractionsHaveUnitIndex(db) };
  switch (intent.intent) {
    case 'last_invoice': return lastInvoice(db, intent, ctx);
    case 'total_invoiced': return totalInvoiced(db, intent, ctx);
    case 'open_invoices': case 'overdue': case 'ar_aging': return receivables(db, intent, ctx, 'receivable');
    case 'payables_open': return receivables(db, intent, ctx, 'payable');
    case 'revenue_by_month': return revenueByMonth(db, intent, ctx);
    case 'agreement_fees': return agreementFees(db, intent, ctx);
    case 'quote_vs_invoice': return quoteVsInvoice(db, intent, ctx);
    case 'top_customers': return topCustomers(db, intent, ctx);
    case 'avg_invoice': return avgInvoice(db, intent, ctx);
    case 'spend_total': return spendTotal(db, intent, ctx);
    case 'po_total': return poTotal(db, intent, ctx);
    case 'payment_status': return paymentStatusCounts(db, intent, ctx);
    case 'threshold_invoices': return thresholdInvoices(db, intent, ctx);
    case 'collected_total': return collectedTotal(db, intent, ctx);
    case 'sales_tax': return salesTaxTotal(db, intent, ctx);
    case 'quotes_waiting': return quotesWaiting(db, intent, ctx);
    case 'needs_verification': return needsVerification(db, intent, ctx);
    case 'balance_leaderboard': return balanceLeaderboard(db, intent, ctx);
    case 'superlative_invoice': return superlativeInvoice(db, intent, ctx);
    case 'superlative_po': return superlativePo(db, intent, ctx);
    case 'quotes_total': return quotesTotal(db, intent, ctx);
    case 'avg_agreement_fee': return avgAgreementFee(db, intent, ctx);
    case 'document_count': return documentCount(db, intent, ctx);
    case 'customers_invoiced_count': return customersInvoicedCount(db, intent, ctx);
    case 'customer_paid_up': return customerPaidUp(db, intent, ctx);
    default: return null;
  }
}

/**
 * Dashboard strip: invoiced this month / YTD, open receivables with aging buckets, counts.
 * Same SQL semantics as the answers above (revenue kinds, USD, printed totals only).
 * @returns {Promise<object>} plain strings for amounts (exact NUMERIC) and integer counts.
 */
export async function financialsSummary(db, { today }) {
  const hu = await extractionsHaveUnitIndex(db);
  const [Y, M] = today.split('-').map(Number);
  const monthFrom = iso(Y, M, 1);
  const monthTo = iso(Y, M, lastDay(Y, M));
  const ytdFrom = iso(Y, 1, 1);
  const rev = REVENUE_WHERE;
  const [a] = await q(db,
    `SELECT COALESCE(sum(f.total) FILTER (WHERE ${rev} AND f.total IS NOT NULL AND f.doc_date BETWEEN $2::date AND $3::date), 0) AS month_total,
            count(*) FILTER (WHERE ${rev} AND f.total IS NOT NULL AND f.doc_date BETWEEN $2::date AND $3::date)::int AS month_n,
            COALESCE(sum(f.total) FILTER (WHERE ${rev} AND f.total IS NOT NULL AND f.doc_date BETWEEN $4::date AND $5::date), 0) AS ytd_total,
            count(*) FILTER (WHERE ${rev} AND f.total IS NOT NULL AND f.doc_date BETWEEN $4::date AND $5::date)::int AS ytd_n,
            count(*) FILTER (WHERE ${rev} AND f.total IS NULL)::int AS n_no_total,
            count(*) FILTER (WHERE ${rev} AND f.total IS NOT NULL AND f.doc_date IS NULL)::int AS n_undated,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.status IN ('unpaid','partial') AND f.open_balance > 0), 0) AS open_total,
            count(*) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.status IN ('unpaid','partial') AND f.open_balance > 0)::int AS open_n,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND f.due_date < $6::date), 0) AS overdue_total,
            count(*) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.currency = 'USD' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND f.due_date < $6::date)::int AS overdue_n,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND f.due_date >= $6::date), 0) AS b_current,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND $6::date - f.due_date BETWEEN 1 AND 30), 0) AS b_30,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND $6::date - f.due_date BETWEEN 31 AND 60), 0) AS b_60,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND $6::date - f.due_date BETWEEN 61 AND 90), 0) AS b_90,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND $6::date - f.due_date > 90), 0) AS b_90p,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.status IN ('unpaid','partial') AND f.open_balance > 0 AND f.due_date IS NULL), 0) AS b_nodue,
            count(*) FILTER (WHERE f.flagged)::int AS n_flagged,
            count(*)::int AS n_rows
       FROM financials f`, [monthFrom, monthTo, ytdFrom, iso(Y, 12, 31), today], hu);
  return {
    enabled: true,
    month: { label: `${MONTH_NAMES[M - 1]} ${Y}`, total: a.month_total, invoices: a.month_n },
    ytd: { label: `${Y} so far`, total: a.ytd_total, invoices: a.ytd_n },
    open: { total: a.open_total, invoices: a.open_n },
    overdue: { total: a.overdue_total, invoices: a.overdue_n },
    aging: { current: a.b_current, d1_30: a.b_30, d31_60: a.b_60, d61_90: a.b_90, d90plus: a.b_90p, noDueDate: a.b_nodue },
    excluded: { noTotal: a.n_no_total, undated: a.n_undated },
    needsReview: a.n_flagged,
    documents: a.n_rows,
  };
}
