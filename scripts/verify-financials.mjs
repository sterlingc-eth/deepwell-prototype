/**
 * Checks for the FINANCIALS layer (api/_lib/financials/*, api/_lib/agent/financeViews.js,
 * M3-config/22-document-financials.sql; handoffs/FINANCIALS_2026-09-23.md).
 *
 * No network, no Anthropic key, no DATABASE_URL: the extraction model is scripted, and the database is a
 * REAL Postgres (PGlite) loaded from the actual M3-config/*.sql migrations and queried as the app's
 * non-superuser NOBYPASSRLS role (deepwell_rls), exactly like scripts/verify-agent.mjs (same harness).
 *
 *   1. pure: money parsing, normalization, "never invent a total", arithmetic mismatch flags, status, intents
 *   2. extraction + backfill on seeded fixtures (paging, idempotency, budget/cost caps, human-work is never overwritten)
 *   3. every deterministic money answer, with exact expected numbers and citations
 *   4. the agent's `financials` view: exact SUM in SQL, RLS (tenant B invisible), prompt rule, grounding
 *   5. corrections beside originals, verification, needs-review, dashboard summary
 *   6. the money gate with / without the table and with / without rows; migration idempotency
 *
 *   node scripts/verify-financials.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

const N = await import('../api/_lib/financials/normalize.js');
const { parseMoneyIntent, parsePeriod, extractSubjectPhrase, fmt } = await import('../api/_lib/financials/answers.js');
const TODAY = '2026-09-23';

/* ================================================================== 1. pure */
{
  eq('parseCents: plain, $, commas, parens, minus, trailing minus', ['1234.50', '$1,234.50', '(45.00)', '-$45', '45.00-', 1234.5].map((v) => N.parseCents(v)), [123450, 123450, -4500, -4500, -4500, 123450]);
  eq('parseCents: refuses non-amounts (TBD, 1,2,3, ranges, exponent, 3+ decimals that need rounding, empty)', ['TBD', '1,2,3', '10-20', '1e5', '12.345', '', null, {}].map((v) => N.parseCents(v)), [null, null, null, null, null, null, null, null]);
  eq('parseCents: trailing zeros beyond cents are fine, magnitude cap holds', [N.parseCents('12.500'), N.parseCents('100000000'), N.parseCents('99999999.99')], [1250, null, 9999999999]);
  eq('centsToString is exact to the cent (no float drift)', [N.centsToString(10), N.centsToString(-4500), N.centsToString(123456789), N.centsToString(5)], ['0.10', '-45.00', '1234567.89', '0.05']);
  eq('parseDecimal4 / parseQty', [N.parseDecimal4('12.3750'), N.parseDecimal4('$1,200'), N.parseDecimal4('1.23456'), N.parseQty('2.5'), N.parseQty('abc')], ['12.375', '1200', null, '2.5', null]);
  const set = N.pageAmounts([{ text: 'Total $1,240.50 and (45.00) plus 1150' }]);
  check('pageAmounts sees every printed amount, comma-insensitive, sign-insensitive', set.has(124050) && set.has(4500) && set.has(115000) && !set.has(124051));

  const pages = [{ page_no: 1, text: 'Invoice INV-1 Subtotal $100.00 Tax $8.25 Total Due $108.25' }];
  const M = (v, page = 1, conf = 0.95) => ({ value: v, page_no: page, verbatim: `x ${v}`, confidence: conf });
  const good = N.normalizeFinancials({ kind: 'invoice', invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '09/30/2026', subtotal: M('100.00'), tax: M('8.25'), total: M('$108.25'), printed_status: 'none', confidence: 0.9 }, { documentType: 'invoice', pages, pageCount: 1, today: TODAY });
  check('normalize: a clean invoice -> exact numeric strings, real dates, no flags, status unknown (nothing printed)', good.ok && good.header.total === '108.25' && good.header.subtotal === '100.00' && good.header.tax === '8.25' && good.header.due_date === '2026-09-30' && good.flags.length === 0 && good.header.status === 'unknown' && good.confidence === 0.9, JSON.stringify(good));
  check('normalize: evidence keeps page + verbatim for citation', good.evidence.total.page === 1 && /108\.25/.test(good.evidence.total.verbatim));

  const invented = N.normalizeFinancials({ kind: 'invoice', total: M('9999.99'), subtotal: M('100.00') }, { documentType: 'invoice', pages, pageCount: 1, today: TODAY });
  check('NEVER INVENT: a total that is not printed anywhere on the pages is dropped to null and flagged', invented.header.total === null && invented.header.subtotal === '100.00' && invented.flags.includes('amount_not_on_page') && invented.flags.includes('no_total') && invented.dropped.some((d) => d.key === 'total'), JSON.stringify(invented));
  const onlySub = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), tax: M('8.25') }, { documentType: 'invoice', pages, pageCount: 1, today: TODAY });
  check('NEVER INVENT: subtotal + tax printed but no total -> total stays null (not computed), flagged no_total, confidence capped', onlySub.header.total === null && onlySub.flags.includes('no_total') && onlySub.confidence <= 0.5);

  const mism = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), tax: M('8.25'), total: M('108.25') }, { documentType: 'invoice', pages: [{ page_no: 1, text: 'Subtotal 100.00 Tax 8.25 Total 108.25 Also 120.00' }], today: TODAY });
  check('arithmetic: subtotal + tax = total -> no flag', !mism.flags.includes('total_mismatch'));
  const bad = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), tax: M('10.00'), total: M('120.00') }, { documentType: 'invoice', pages: [{ page_no: 1, text: '100.00 10.00 120.00' }], today: TODAY });
  check('arithmetic: subtotal + tax != total -> total_mismatch flag, values kept AS PRINTED (not "fixed"), confidence capped at 0.4', bad.flags.includes('total_mismatch') && bad.header.total === '120.00' && bad.header.subtotal === '100.00' && bad.confidence <= 0.4, JSON.stringify(bad));
  const within = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), tax: M('8.25'), total: M('108.26') }, { documentType: 'invoice', pages: [{ page_no: 1, text: '100.00 8.25 108.26' }], today: TODAY });
  check('arithmetic: a 1-cent rounding difference is inside the 2-cent tolerance', !within.flags.includes('total_mismatch'));
  const linesBad = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), total: M('100.00'), line_items: [{ description: 'Labor', amount: '60.00' }, { description: 'Parts', amount: '30.00' }] }, { documentType: 'invoice', pages: [{ page_no: 1, text: '60.00 30.00 100.00' }], today: TODAY });
  check('arithmetic: line items that do not sum to the subtotal -> lines_mismatch', linesBad.flags.includes('lines_mismatch') && linesBad.lines.length === 2 && linesBad.confidence <= 0.4);
  const linesOk = N.normalizeFinancials({ kind: 'invoice', subtotal: M('100.00'), total: M('100.00'), line_items: [{ description: 'Labor', qty: '2', unit_price: '30', amount: '60.00' }, { description: 'Parts', amount: '40.00' }] }, { documentType: 'invoice', pages: [{ page_no: 1, text: '60.00 40.00 100.00 30' }], today: TODAY });
  check('arithmetic: line items that sum to the subtotal (and qty x price = amount) -> clean', linesOk.flags.length === 0 && linesOk.lines[0].amount_str === '60.00', JSON.stringify(linesOk.flags));
  const lineMath = N.normalizeFinancials({ kind: 'invoice', total: M('100.00'), line_items: [{ description: 'Labor', qty: '2', unit_price: '30', amount: '100.00' }] }, { documentType: 'invoice', pages: [{ page_no: 1, text: '100.00 30' }], today: TODAY });
  check('arithmetic: qty x unit price != line amount -> line_math flag', lineMath.flags.includes('line_math'));
  const balBad = N.normalizeFinancials({ kind: 'invoice', total: M('500.00'), amount_paid: M('100.00'), balance_due: M('300.00') }, { documentType: 'invoice', pages: [{ page_no: 1, text: '500.00 100.00 300.00' }], today: TODAY });
  check('arithmetic: total - paid != balance due -> balance_mismatch', balBad.flags.includes('balance_mismatch'));
  const lineNotOnPage = N.normalizeFinancials({ kind: 'invoice', total: M('10.00'), line_items: [{ description: 'Ghost', amount: '777.00' }] }, { documentType: 'invoice', pages: [{ page_no: 1, text: 'Total 10.00' }], today: TODAY });
  check('NEVER INVENT: a line amount not printed on the page is stored as null', lineNotOnPage.lines[0].amount === null && lineNotOnPage.flags.includes('amount_not_on_page'));

  const cm = N.normalizeFinancials({ kind: 'credit_memo', total: M('45.00'), subtotal: M('(45.00)') }, { documentType: 'invoice', pages: [{ page_no: 1, text: 'Credit 45.00' }], today: TODAY });
  check('credit memo: amounts are negative NUMERICs however printed', cm.header.total === '-45.00' && cm.header.subtotal === '-45.00' && cm.header.doc_kind === 'credit_memo' && !cm.flags.includes('total_mismatch'), JSON.stringify(cm.header));
  check('doc kinds are constrained per document type (a PO cannot be an invoice; unknown kind -> the type default)', N.normalizeFinancials({ kind: 'invoice', total: M('5.00') }, { documentType: 'purchase-order', pages: [{ text: '5.00' }] }).header.doc_kind === 'po' && N.normalizeFinancials({ kind: 'nonsense' }, { documentType: 'maintenance-agreement' }).header.doc_kind === 'agreement');
  check('non-financial document types are refused', !N.normalizeFinancials({ kind: 'invoice' }, { documentType: 'permit' }).ok && !N.isFinancialDocumentType('work-order') && N.isFinancialDocumentType('proposal-quote'));
  eq('status: printed PAID, partial by numbers, zero balance, open by label, nothing -> unknown', [
    N.deriveStatus({ kind: 'invoice', printedStatus: 'paid' }),
    N.deriveStatus({ kind: 'invoice', printedStatus: 'none', totalCents: 30000, paidCents: 10000, balanceCents: 20000 }),
    N.deriveStatus({ kind: 'invoice', printedStatus: 'none', totalCents: 30000, paidCents: 30000, balanceCents: 0 }),
    N.deriveStatus({ kind: 'invoice', printedStatus: 'open' }),
    N.deriveStatus({ kind: 'invoice', printedStatus: 'none', totalCents: 30000 }),
  ], ['paid', 'partial', 'paid', 'unpaid', 'unknown']);
  check('status: a printed PAID that disagrees with a balance is flagged status_conflict (numbers win)', N.normalizeFinancials({ kind: 'invoice', printed_status: 'paid', total: M('500.00'), amount_paid: M('100.00'), balance_due: M('400.00') }, { documentType: 'invoice', pages: [{ text: '500.00 100.00 400.00' }] }).flags.includes('status_conflict'));
  check('validateCorrection: money/date/status normalized, junk refused, empty clears', N.validateCorrection('total', '$1,000').value === '1000.00' && !N.validateCorrection('total', 'abc').ok && N.validateCorrection('due_date', '9/5/2026').value === '2026-09-05' && !N.validateCorrection('due_date', 'soon').ok && !N.validateCorrection('status', 'maybe').ok && N.validateCorrection('tax', '').value === '' && !N.validateCorrection('confidence', '1').ok);

  // intents (pure)
  const I = (q) => parseMoneyIntent(q, { today: TODAY });
  eq('intent: "what did we bill Bracken for his last job" -> last_invoice(bracken)', [I('What did we bill Bracken for his last job?')?.intent, I('What did we bill Bracken for his last job?')?.subject], ['last_invoice', 'bracken']);
  eq('intent: "how much did we invoice last month" -> total_invoiced Aug 2026, no subject', [I('how much did we invoice last month')?.intent, I('how much did we invoice last month')?.period?.from, I('how much did we invoice last month')?.subject], ['total_invoiced', '2026-08-01', null]);
  eq('intent: open / overdue / aging / by-month / agreement fees / quote / top / avg / payables', [
    I('open invoices')?.intent, I('which invoices are overdue')?.intent, I('show me the AR aging')?.intent, I('revenue by month')?.intent,
    I("total we've collected in maintenance agreement fees")?.intent, I('Bracken quote vs invoice')?.intent, I('who is our biggest customer by revenue')?.intent,
    I('average invoice size')?.intent, I('what do we owe our vendors')?.intent, I('who owes us money')?.intent, I('revenue this year')?.intent,
  ], ['open_invoices', 'overdue', 'ar_aging', 'revenue_by_month', 'agreement_fees', 'quote_vs_invoice', 'top_customers', 'avg_invoice', 'payables_open', 'open_invoices', 'total_invoiced']);
  check('intent: a non-money question is not claimed', I('how many customers are in gilbert') === null && I('') === null);

  // R3_FAILS.md 2026-09-24: new intents for real production failures with no shape before.
  eq('intent: payment status (paid/partial), threshold, superlative, tax, collected, quotes waiting, needs verification, who-owes', [
    I('how many invoices are paid')?.intent, I('how many invoices are partially paid')?.statusTarget,
    I('how many invoices are over $5,000')?.intent, I('how many invoices are under $500')?.thresholdDir,
    I("what's the biggest invoice we've ever sent")?.intent, I('what is the smallest invoice')?.superlative,
    I('how much sales tax have we charged')?.intent, I('how much have we collected')?.intent,
    I('have customers paid us')?.intent, I('do we have any quotes waiting on a customer')?.intent,
    I('how many invoices still need someone to verify the numbers')?.intent,
    I('which customer owes us the most')?.intent, I('who has an overdue balance I need to call')?.intent,
  ], ['payment_status', 'partial', 'threshold_invoices', 'under', 'superlative_invoice', 'min', 'sales_tax', 'collected_total', 'collected_total', 'quotes_waiting', 'needs_verification', 'balance_leaderboard', 'balance_leaderboard']);
  eq('intent: "which invoices are overdue" is untouched (still overdue, no threshold); "more than 60 days overdue" captures the threshold', [I('which invoices are overdue')?.intent, I('which invoices are overdue')?.dayThreshold, I('invoices more than 60 days overdue')?.dayThreshold], ['overdue', null, 60]);
  check('intent: "who owes us money" (no superlative) still stays open_invoices, never hijacked by the new who-owes-the-most intent', I('who owes us money')?.intent === 'open_invoices');
  check('intent: "who is our biggest customer by revenue" stays top_customers (a customer ranking, not the new single-invoice superlative)', I('who is our biggest customer by revenue')?.intent === 'top_customers');

  // TEAM K (2026-09-25, R5_FAILS.md financials 59/81): plain "how many <docs> do we have",
  // "average quote/agreement-fee", "total value of our quotes", "biggest purchase order" and
  // "is X all paid up" had NO shape here at all and fell through to the agent.
  eq('intent: plain document counts (invoices/quotes/POs), never stolen by a status/threshold word', [
    I('How many invoices do we have on file?')?.intent, I('How many purchase orders do we have?')?.intent,
    I('How many quotes or estimates do we have on file?')?.intent, I('How many invoices did we send last month?')?.intent,
    I('How many invoices are still unpaid?')?.intent, I('How many invoices are over $5,000?')?.intent,
  ], ['document_count', 'document_count', 'document_count', 'document_count', 'open_invoices', 'threshold_invoices']);
  eq('intent: customers invoiced, quotes total value, quote/agreement averages, PO superlative, paid-up', [
    I('How many customers have we invoiced?')?.intent,
    I("What's the total value of our quotes?")?.intent,
    I("What's the average quote amount?")?.intent, I("What's the average quote amount?")?.docKind,
    I("What's the average annual fee on our maintenance agreements?")?.intent,
    I("What's our biggest purchase order?")?.intent, I("What's our biggest purchase order?")?.superlative,
    I('Is Mercer all paid up?')?.intent, I('Is Mercer all paid up?')?.subject,
  ], ['customers_invoiced_count', 'quotes_total', 'avg_invoice', 'estimate', 'avg_agreement_fee', 'superlative_po', 'max', 'customer_paid_up', 'mercer']);

  const C = await import('../api/_lib/financials/classify.js');
  const analyticsMod = await import('../api/_lib/analytics.js');
  check('classify gate: every new shape above also clears isFinancialQuestion/isMoneyQuestion (the money gate ask.js checks before calling parseMoneyIntent)', [
    'How many invoices do we have on file?', 'How many purchase orders do we have?', 'How many quotes or estimates do we have on file?',
    'How many customers have we invoiced?', "What's the total value of our quotes?", "What's the average quote amount?",
    "What's the average annual fee on our maintenance agreements?", "What's our biggest purchase order?", 'Is Mercer all paid up?',
    'How much do our maintenance agreements bring in?', 'How much have we spent on purchase orders?', 'How much do we owe vendors right now?',
    'How much is past due?', 'When was the last invoice for Holbrook?',
  ].every((qq) => C.isFinancialQuestion(qq.toLowerCase()) || analyticsMod.isMoneyQuestion(qq.toLowerCase())));
  check('classify: catches every R3_FAILS phrasing MONEY_RE (analytics.js) missed', [
    'how many invoices are still unpaid', 'do we have any overdue invoices', 'invoices are over $5,000', 'invoices under $500',
    "what's the biggest invoice we've ever sent", 'which customer owes us the most right now', 'who has an overdue balance i need to call',
    'top 3 customers by invoiced revenue', 'how much sales tax have we charged', 'do we have any quotes waiting on a customer',
    'how many invoices still need someone to verify the numbers', 'have customers paid us',
  ].every((q) => C.isFinancialQuestion(q)), JSON.stringify(['how many invoices are still unpaid', 'do we have any overdue invoices', 'invoices are over $5,000'].map((q) => [q, C.isFinancialQuestion(q)])));
  check('classify: an ordinary non-financial question is not claimed', !C.isFinancialQuestion('how many customers are in gilbert') && !C.isFinancialQuestion('what unit is installed at the Bracken house') && !C.isFinancialQuestion(''));
  eq('period: ytd / last quarter / in march / last 30 days', [parsePeriod('ytd', TODAY)?.from, parsePeriod('last quarter', TODAY)?.label, parsePeriod('in march', TODAY)?.to, parsePeriod('last 30 days', TODAY)?.from], ['2026-01-01', 'Q2 2026', '2026-03-31', '2026-08-24']);
  eq('subject phrase: "last invoice for Bracken" / "bill karen abernathy this year" / none', [extractSubjectPhrase('last invoice for Bracken'), extractSubjectPhrase('how much did we bill karen abernathy this year'), extractSubjectPhrase('how much did we invoice last month')], ['bracken', 'karen abernathy', null]);
  eq('fmt: exact currency text from NUMERIC strings', [fmt('1240.5'), fmt('-45'), fmt('0'), fmt(null)], ['$1,240.50', '-$45.00', '$0.00', '—']);
  const sqlGuardMod = await import('../api/_lib/agent/sqlGuard.js');
  check('guard: the new tables are deny-listed and the new views are queryable', sqlGuardMod.REAL_TABLES.includes('document_financials') && sqlGuardMod.REAL_TABLES.includes('document_financial_lines') && sqlGuardMod.VIEW_NAMES.includes('financials') && sqlGuardMod.VIEW_NAMES.includes('invoice_lines') && !sqlGuardMod.guardSql('SELECT * FROM document_financials').ok && sqlGuardMod.guardSql("SELECT to_char(invoice_date, 'YYYY-MM') AS m, sum(total) FILTER (WHERE status IN ('unpaid','partial')) FROM financials WHERE days_past_due > 0 GROUP BY 1").ok);
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const harnessNotes = [];
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { harnessNotes.push(`01b re-run failed: ${err.message}`); }
for (const line of harnessNotes) realLog(`NOTE  migration harness: ${line}`);
check('harness: migration 22 loaded cleanly (no error from 22-document-financials.sql)', !harnessNotes.some((n) => n.startsWith('22-')), harnessNotes.join(' | '));
const role = (await lite.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'deepwell_rls'")).rows[0];
check('harness: the app role deepwell_rls is not a superuser and does not bypass RLS', Boolean(role) && !role.rolsuper && !role.rolbypassrls);

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const S = await import('../api/_lib/financials/store.js');
const X = await import('../api/_lib/financials/extract.js');
const B = await import('../api/_lib/financials/backfill.js');
const A = await import('../api/_lib/financials/answers.js');
const G = await import('../api/_lib/financials/moneyGate.js');
const { createToolbox, VIEW_DOCS } = await import('../api/_lib/agent/tools.js');
const { runDonovanAgent, AGENT_SYSTEM_PROMPT } = await import('../api/_lib/agent/loop.js');
const { shapeAgentAnswer } = await import('../api/_lib/agent/shape.js');
const { ModelBudgetExceededError } = await import('../api/_lib/rateLimit.js');
const { moneyFallbackAnswer, MONEY_FALLBACK_TEXT } = await import('../api/_lib/analytics.js');

const ctxA = { tenantKey: 'org_fin_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_fin_b', tenantName: 'Other Shop' };
const ctxC = { tenantKey: 'org_fin_c', tenantName: 'Empty Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
await getTenantContext(ctxC.tenantKey, ctxC.tenantName);
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const dA = (n) => uid('a', 'd', n);

/* ---------- fixtures ---------- */
const money = (v, page = 1, conf = 0.95) => ({ value: v, page_no: page, verbatim: `printed ${v}`, confidence: conf });
// doc n -> { type, customer, text (page text; must print every amount the fake model returns), input (raw model tool input) }
const DOCS = {
  1: { type: 'invoice', cust: 1, text: 'Invoice INV-1001 Bill To Ed Bracken Total $1,200.00 Amount Paid $1,200.00 Balance Due $0.00 PAID',
    input: { kind: 'invoice', invoice_number: 'INV-1001', invoice_date: '2026-03-10', due_date: '2026-04-09', customer_name: 'Ed Bracken', printed_status: 'paid', total: money('1200.00'), amount_paid: money('1200.00'), balance_due: money('0.00'), confidence: 0.95 } },
  2: { type: 'invoice', cust: 1, text: 'Invoice INV-1002 Bill To Ed Bracken Labor $900.00 Parts $250.00 Subtotal $1,150.00 Tax $90.50 Total $1,240.50 Balance Due $1,240.50',
    input: { kind: 'invoice', invoice_number: 'INV-1002', invoice_date: '2026-08-12', due_date: '2026-09-11', customer_name: 'Ed Bracken', printed_status: 'open', subtotal: money('1150.00'), tax: money('90.50'), total: money('1240.50'), balance_due: money('1240.50'), confidence: 0.96,
      line_items: [{ description: 'Labor', amount: '900.00', category_guess: 'labor' }, { description: 'Parts', amount: '250.00', category_guess: 'parts' }] } },
  3: { type: 'invoice', cust: 2, text: 'Invoice INV-2001 Karen Abernathy Total $500.00 Balance Due $500.00',
    input: { kind: 'invoice', invoice_number: 'INV-2001', invoice_date: '2026-08-05', due_date: '2026-08-20', customer_name: 'Karen Abernathy', printed_status: 'open', total: money('500.00'), balance_due: money('500.00'), confidence: 0.94 } },
  4: { type: 'invoice', cust: 3, text: 'Invoice INV-3001 Plaza Dental Group Total $2,000.00 Balance Due $2,000.00',
    input: { kind: 'invoice', invoice_number: 'INV-3001', invoice_date: '2026-09-02', due_date: '2026-10-02', customer_name: 'Plaza Dental Group', printed_status: 'open', total: money('2000.00'), balance_due: money('2000.00'), confidence: 0.95 } },
  5: { type: 'invoice', cust: 3, text: 'Invoice INV-3002 Plaza Dental Group Total $300.00 Amount Paid $100.00 Balance Due $200.00',
    input: { kind: 'invoice', invoice_number: 'INV-3002', invoice_date: '2026-06-01', due_date: '2026-07-01', customer_name: 'Plaza Dental Group', printed_status: 'partial', total: money('300.00'), amount_paid: money('100.00'), balance_due: money('200.00'), confidence: 0.93 } },
  6: { type: 'invoice', cust: 4, text: 'Invoice INV-4001 Donna Thornton Repair visit - see quote for pricing (no total printed)',
    input: { kind: 'invoice', invoice_number: 'INV-4001', invoice_date: '2026-08-20', customer_name: 'Donna Thornton', printed_status: 'none', confidence: 0.8 } },
  7: { type: 'invoice', cust: 2, text: 'CREDIT MEMO CM-1 Karen Abernathy Credit $50.00',
    input: { kind: 'credit_memo', invoice_number: 'CM-1', invoice_date: '2026-08-25', customer_name: 'Karen Abernathy', total: money('50.00'), confidence: 0.92 } },
  8: { type: 'invoice', cust: 2, text: 'Invoice INV-2002 Karen Abernathy (undated) Total $75.00',
    input: { kind: 'invoice', invoice_number: 'INV-2002', customer_name: 'Karen Abernathy', total: money('75.00'), confidence: 0.9 } },
  9: { type: 'invoice', cust: 4, text: 'Invoice INV-4002 Donna Thornton Subtotal $100.00 Tax $10.00 Total $120.00',
    input: { kind: 'invoice', invoice_number: 'INV-4002', invoice_date: '2026-09-01', customer_name: 'Donna Thornton', subtotal: money('100.00'), tax: money('10.00'), total: money('120.00'), confidence: 0.9 } },
  10: { type: 'proposal-quote', cust: 1, text: 'Quote Q-77 Ed Bracken Total $1,100.00',
    input: { kind: 'estimate', invoice_number: 'Q-77', invoice_date: '2026-02-20', customer_name: 'Ed Bracken', total: money('1100.00'), confidence: 0.95 } },
  11: { type: 'maintenance-agreement', cust: 2, text: 'Maintenance Agreement Karen Abernathy Annual fee $350.00 PAID',
    input: { kind: 'agreement', invoice_date: '2026-01-02', customer_name: 'Karen Abernathy', agreement_term: '12 months', printed_status: 'paid', total: money('350.00'), confidence: 0.95 } },
  12: { type: 'maintenance-agreement', cust: 3, text: 'Maintenance Agreement Plaza Dental Group Annual fee $600.00',
    input: { kind: 'agreement', invoice_date: '2026-02-01', customer_name: 'Plaza Dental Group', total: money('600.00'), confidence: 0.95 } },
  13: { type: 'maintenance-agreement', cust: 5, text: 'Maintenance Agreement Bill Whitmore (fee to be quoted)',
    input: { kind: 'agreement', invoice_date: '2026-03-01', customer_name: 'Bill Whitmore', confidence: 0.85 } },
  14: { type: 'purchase-order', cust: null, text: 'PURCHASE ORDER PO-9 Vendor Ferguson Supply Total $800.00',
    input: { kind: 'po', direction: 'payable', po_number: 'PO-9', invoice_date: '2026-09-03', vendor_name: 'Ferguson Supply', total: money('800.00'), confidence: 0.95 } },
  15: { type: 'invoice', cust: null, text: 'Vendor invoice INV-F1 from Ferguson Supply to Desert Peak HVAC Total $450.00 Balance Due $450.00',
    input: { kind: 'invoice', direction: 'payable', invoice_number: 'INV-F1', invoice_date: '2026-08-15', due_date: '2026-09-01', vendor_name: 'Ferguson Supply', printed_status: 'open', total: money('450.00'), balance_due: money('450.00'), confidence: 0.93 } },
};
const CUSTOMERS = [[1, 'Ed Bracken', '9 Bracken Way, Mesa, AZ 85201'], [2, 'Karen Abernathy', '412 Elm St, Mesa, AZ 85201'], [3, 'Plaza Dental Group', '2210 E Main St, Gilbert, AZ 85234'], [4, 'Donna Thornton', '17 Cactus Ln, Tucson, AZ 85701'], [5, 'Bill Whitmore', '88 Whitmore Ave, Mesa, AZ 85201'], [6, 'Tom Hill', '1 Hill Rd, Mesa, AZ 85201'], [7, 'Tim Hall', '2 Hall Rd, Mesa, AZ 85201']];

async function seedTenant(t, tenantId, customers, docs) {
  for (const [n, name, addr] of customers) {
    await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)', [uid(t, 'c', n), tenantId, 'customer', JSON.stringify({ customer_name: name, service_address: addr }), `C-0000${n}`]);
  }
  for (const [n, d] of Object.entries(docs)) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [uid(t, 'd', n), tenantId, `${d.type}-${n}.pdf`, d.type, `${t}-hash-${n}`, 'linked']);
    if (d.cust) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', n), uid(t, 'c', d.cust)]);
    await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)', [uid(t, 'd', n), tenantId, `DOC-${t}${n} ${d.text}`]);
  }
}
await seedTenant('a', tenA, CUSTOMERS, DOCS);
await seedTenant('b', tenB, [[1, 'Zed Competitor', '1 Secret Way, Reno, NV 89501']], {
  1: { type: 'invoice', cust: 1, text: 'Invoice INV-B1 Zed Competitor Total $99,999.00 Balance Due $99,999.00', input: { kind: 'invoice', invoice_number: 'INV-B1', invoice_date: '2026-09-05', due_date: '2026-09-15', customer_name: 'Zed Competitor', printed_status: 'open', total: money('99999.00'), balance_due: money('99999.00'), confidence: 0.95 } },
});
await lite.query("INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,'permit.pdf','permit','a-hash-perm','linked')", [dA(90), tenA]);
await lite.query("INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,'Building permit - not a money document')", [dA(90), tenA]);

/** The scripted "model": finds which document the prompt is about by its DOC-<tenant><n> marker. */
const modelCalls = [];
const fakeModel = ({ prompt }) => {
  const m = prompt.match(/DOC-([ab])(\d+)/);
  modelCalls.push(m ? `${m[1]}${m[2]}` : '?');
  const doc = m?.[1] === 'a' ? DOCS[Number(m[2])] : m?.[1] === 'b' ? { input: { kind: 'invoice', invoice_number: 'INV-B1', invoice_date: '2026-09-05', due_date: '2026-09-15', customer_name: 'Zed Competitor', printed_status: 'open', total: money('99999.00'), balance_due: money('99999.00'), confidence: 0.95 } } : null;
  return Promise.resolve({ input: doc?.input ?? null, usage: { inputTokens: 2000, outputTokens: 300 } });
};

/* ================================================================== 2. extraction + backfill */
{
  check('migration 22: both tables have ENABLE + FORCE ROW LEVEL SECURITY and a tenant policy each', await (async () => {
    const r = (await lite.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('document_financials','document_financial_lines') ORDER BY 1`)).rows;
    const pol = (await lite.query(`SELECT polname FROM pg_policy WHERE polrelid IN ('document_financials'::regclass,'document_financial_lines'::regclass)`)).rows;
    return r.length === 2 && r.every((x) => x.rls && x.f) && pol.length === 2;
  })());
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '22-document-financials.sql'), 'utf8')).then(() => true, () => false);
  check('migration 22 is idempotent (re-running it changes nothing and errors nothing)', twice);
  check('the cost estimator matches Haiku list price ($1 / $5 per Mtok): 2000 in + 300 out = $0.0035', Math.abs(X.estimateFinancialsCost({ inputTokens: 2000, outputTokens: 300 }) - 0.0035) < 1e-9);
  const tool = X.FINANCIALS_TOOL.input_schema.properties;
  check('extraction tool: kind/direction/dates/money/line_items/printed_status all present, total documented as the document total', ['kind', 'direction', 'invoice_number', 'invoice_date', 'due_date', 'subtotal', 'tax', 'total', 'amount_paid', 'balance_due', 'line_items', 'vendor_name', 'agreement_term', 'printed_status'].every((k) => k in tool));
  const prompt = X.buildFinancialsPrompt([{ page_no: 1, text: 'hello' }], 'invoice');
  check('extraction prompt: page markers + "never compute a total" rule', /\[page 1\]/.test(prompt) && /never compute one/.test(prompt) && /Never infer paid/.test(prompt));
  const src = fs.readFileSync(path.join(ROOT, 'api/_lib/financials/extract.js'), 'utf8');
  check('extraction uses Haiku (env-overridable, default claude-haiku-4-5), temperature 0, forced tool_choice, and never logs page text', /claude-haiku-4-5/.test(src) && /temperature: 0/.test(src) && /tool_choice: \{ type: 'tool'/.test(src) && !/console\.(log|error)\([^)]*(prompt|text|input)\b/.test(src.replace(/modelCallLogLine\([\s\S]*?\}\)\)\)/, '')));

  // one document, end to end (skipBudget: the daily-budget gate is exercised separately below)
  const one = await X.extractFinancialsForDocument(ctxA, dA(2), { withTenant, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('extract one invoice: written, has a total, no flags, cost $0.0035', [one.status, one.hasTotal, one.flags, Math.round(one.costUsd * 10000) / 10000], ['written', true, [], 0.0035]);
  const got = await withTenant(ctxA, (db) => S.getDocumentFinancials(db, dA(2)));
  check('stored: NUMERIC cents exact, dates real, evidence with page + verbatim, 2 lines summing to the subtotal',
    got.financials.fields.total.value === '1240.50' && got.financials.fields.subtotal.value === '1150.00' && got.financials.fields.total.evidence.page === 1 && /1240\.50/.test(got.financials.fields.total.evidence.verbatim) && got.financials.lines.length === 2 && got.financials.lines[0].amount === '900.00' && got.financials.fields.due_date.value === '2026-09-11' && got.financials.docKind === 'invoice' && got.financials.direction === 'receivable' && got.financials.fields.status.value === 'unpaid', JSON.stringify(got.financials).slice(0, 400));
  const notFin = await X.extractFinancialsForDocument(ctxA, dA(90), { withTenant, callModel: fakeModel, skipBudget: true });
  eq('a permit is skipped with no model call', [notFin.status, notFin.reason, notFin.modelCalls], ['skipped', 'not_financial', 0]);
  const again = await X.extractFinancialsForDocument(ctxA, dA(2), { withTenant, callModel: fakeModel, skipBudget: true, today: TODAY });
  const rowsAfter = (await lite.query('SELECT count(*)::int AS n FROM document_financials WHERE document_id = $1', [dA(2)])).rows[0].n;
  const linesAfter = (await lite.query('SELECT count(*)::int AS n FROM document_financial_lines WHERE document_id = $1', [dA(2)])).rows[0].n;
  eq('re-extracting the same document replaces, never duplicates (1 header row, 2 lines)', [again.status, rowsAfter, linesAfter], ['written', 1, 2]);
  const failing = await X.extractFinancialsForDocument(ctxA, dA(3), { withTenant, callModel: () => Promise.reject(new Error('boom')), skipBudget: true });
  const garbage = await X.extractFinancialsForDocument(ctxA, dA(3), { withTenant, callModel: () => Promise.resolve({ input: null, usage: {} }), skipBudget: true });
  eq('a model error / an unparseable reply is a soft "failed" (never throws, nothing stored)', [failing.status, garbage.status, (await lite.query('SELECT count(*)::int AS n FROM document_financials WHERE document_id = $1', [dA(3)])).rows[0].n], ['failed', 'failed', 0]);

  // ---- backfill: paging, caps, idempotency ----
  modelCalls.length = 0;
  const b1 = await B.runFinancialsBackfill(ctxA, { maxCalls: 6, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('backfill batch 1: 6 model calls max, 6 written (doc 2 was already done, so it is never re-billed), stopped at the batch', [b1.modelCalls, b1.written, b1.processed, b1.stoppedReason], [6, 6, 6, 'batch_complete']);
  check('backfill batch 1: reports eligible/remaining and a paging cursor', b1.eligible === 15 && b1.remaining === 8 && typeof b1.nextCursor === 'string', JSON.stringify(b1));
  const b2 = await B.runFinancialsBackfill(ctxA, { maxCalls: 20, afterId: b1.nextCursor, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('backfill batch 2 (after the cursor): the remaining 8 documents', [b2.written, b2.remaining, b2.modelCalls], [8, 0, 8]);
  check('backfill made exactly one model call per money document, none for the permit, none twice', modelCalls.length === 14 && new Set(modelCalls).size === 14 && !modelCalls.includes('a90'), modelCalls.join(','));
  const b3 = await B.runFinancialsBackfill(ctxA, { callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('backfill is idempotent: a third run finds nothing, makes 0 model calls, costs $0', [b3.processed, b3.modelCalls, b3.costUsd, b3.stoppedReason, b3.remaining], [0, 0, 0, 'done', 0]);
  const totalCost = b1.costUsd + b2.costUsd;
  check(`backfill cost for the 14 backfilled fixture documents is ${totalCost.toFixed(4)} USD (under the $0.30 budget; ~$0.0035/document)`, totalCost < 0.3 && Math.abs(totalCost - 14 * 0.0035) < 1e-6);
  // caps: cost cap and daily budget stop a run early
  await lite.query('DELETE FROM document_financials WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])', [tenA, [dA(13), dA(14), dA(15)]]);
  const capped = await B.runFinancialsBackfill(ctxA, { maxCostUsd: 0.005, concurrency: 1, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('backfill cost cap: stops after the call that crosses $0.005 (2 documents), leaving the rest for the next run', [capped.stoppedReason, capped.modelCalls, capped.remaining], ['cost_cap', 2, 1]);
  const budget = await B.runFinancialsBackfill(ctxA, { callModel: () => Promise.reject(new ModelBudgetExceededError()), skipBudget: true });
  eq('backfill: the daily model budget stops the run cleanly (stoppedReason daily_budget, no crash, 0 billed)', [budget.stoppedReason, budget.written, budget.modelCalls], ['daily_budget', 0, 0]);
  await B.runFinancialsBackfill(ctxA, { callModel: fakeModel, skipBudget: true, today: TODAY });
  const sw = await B.runFinancialsBackfill(ctxB, { callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('tenant B backfills only its own document', [sw.written, sw.eligible], [1, 1]);
  const rowsByTenant = (await lite.query('SELECT tenant_id, count(*)::int AS n FROM document_financials GROUP BY 1 ORDER BY 2 DESC')).rows;
  eq('rows landed under the right tenants (A: 15, B: 1)', rowsByTenant.map((r) => [r.tenant_id === tenA ? 'A' : 'B', r.n]), [['A', 15], ['B', 1]]);
  const realBudget = await X.extractFinancialsForDocument(ctxC, dA(1), { withTenant, callModel: fakeModel }).catch((e) => e);
  check('extraction against another tenant\'s document id finds nothing (RLS) and makes no model call', realBudget.status === 'skipped' && realBudget.reason === 'document_missing');
}

/* ================================================================== stored flags */
{
  const rows = (await lite.query('SELECT d.n, f.flags, f.confidence, f.status, f.doc_kind, f.direction, f.total FROM document_financials f JOIN (SELECT id, right(id::text, 2)::int AS n FROM documents) d ON d.id = f.document_id WHERE f.tenant_id = $1 ORDER BY d.n', [tenA])).rows;
  const by = Object.fromEntries(rows.map((r) => [r.n, r]));
  check('stored: doc 9 (100 + 10 != 120) is flagged total_mismatch with confidence <= 0.4', by[9].flags.includes('total_mismatch') && Number(by[9].confidence) <= 0.4);
  check('stored: doc 6 prints no total -> total NULL (not invented), flagged no_total, status unknown', by[6].total === null && by[6].flags.includes('no_total') && by[6].status === 'unknown');
  check('stored: doc 7 is a credit_memo stored negative; doc 14 a payable po; doc 15 a payable invoice; doc 11 an agreement', by[7].total === '-50.00' && by[7].doc_kind === 'credit_memo' && by[14].doc_kind === 'po' && by[14].direction === 'payable' && by[15].direction === 'payable' && by[11].doc_kind === 'agreement');
  check('stored: doc 5 partial, doc 1 paid, doc 2 unpaid', by[5].status === 'partial' && by[1].status === 'paid' && by[2].status === 'unpaid');
}

/* ================================================================== 3. deterministic money answers */
const gate = (q, ctx = ctxA) => G.answerMoneyQuestion({ withTenant, ctxArg: ctx, question: q, today: TODAY });
const text = (r) => r.data?.text ?? '';
{
  const r = await gate('What did we bill Bracken for his last job?');
  check('ANSWER last invoice: Bracken -> INV-1002, Aug 12, 2026, $1,240.50 (unpaid), cited to that invoice document', r.handled && /INV-1002/.test(text(r)) && /\$1,240\.50/.test(text(r)) && /Aug 12, 2026/.test(text(r)) && /unpaid/.test(text(r)) && r.data.facts[0].sources[0].documentId === dA(2) && r.data.sources[0].documentId === dA(2), text(r));
  check('ANSWER last invoice: the earlier Bracken invoice is shown as a supporting fact, and the answer states no aggregate it cannot back', r.data.facts.some((f) => f.value === '$1,200.00'));
  const amb = await gate('what was the last invoice for hill');
  check('ANSWER last invoice: two customers match ("Tom Hill", "Tim Hall") -> asks which one, gives NO dollar figure', amb.handled && /which one/.test(text(amb)) && !/\$\d/.test(text(amb)) && amb.data.facts.length === 2, text(amb));
  const none = await gate('what did we bill Zzyzx for his last job');
  eq('ANSWER unresolvable customer: not handled (no shop-wide number substituted), the agent gets it', [none.handled, none.hasData], [false, true]);

  const lm = await gate('how much did we invoice last month');
  check('ANSWER invoiced last month (Aug 2026): $1,690.50 across 3 invoices, with the exclusions named', lm.handled && /\$1,690\.50/.test(text(lm)) && /3 invoices/.test(text(lm)) && /1 invoice prints no total and is excluded/.test(text(lm)) && /1 invoice has no printed date/.test(text(lm)) && /August 2026/.test(text(lm)), text(lm));
  check('ANSWER invoiced last month: fact list cites the summed invoice documents; credit memo nets out (-$50.00)', lm.data.facts[0].value === '$1,690.50' && lm.data.facts[0].sources.map((s) => s.documentId).sort().join() === [dA(2), dA(3), dA(7)].sort().join() && lm.data.facts.some((f) => f.value === '-$50.00'), JSON.stringify(lm.data.facts.map((f) => [f.label, f.value])));
  const ty = await gate('total invoiced this year');
  check('ANSWER invoiced this year: $5,310.50 across 7 invoices (undated INV-2002 cannot be placed, named), 1 no-total excluded', ty.handled && /\$5,310\.50/.test(text(ty)) && /7 invoices/.test(text(ty)) && /no printed date/.test(text(ty)) && /prints no total/.test(text(ty)), text(ty));
  const tm = await gate('how much have we invoiced this month');
  check('ANSWER invoiced this month (Sep): $2,120.00 across 2 invoices, and says 1 of them is flagged for review (doc 9 does not add up)', tm.handled && /\$2,120\.00/.test(text(tm)) && /2 invoices/.test(text(tm)) && /1 of them is flagged for review/.test(text(tm)), text(tm));
  const all = await gate('what is our total revenue');
  check('ANSWER all-time revenue: $5,385.50 across 8 invoices (undated one included, 1 no-total excluded)', all.handled && /\$5,385\.50/.test(text(all)) && /8 invoices/.test(text(all)) && /in total/.test(text(all)), text(all));
  const cust = await gate('how much have we invoiced Karen Abernathy this year');
  check('ANSWER invoiced for one customer: Karen Abernathy this year = $450.00 (500.00 - 50.00 credit) across 2 invoices', cust.handled && /\$450\.00/.test(text(cust)) && /2 invoices/.test(text(cust)) && /Karen Abernathy/.test(text(cust)), text(cust));
  const nov = await gate('how much did we invoice in November');
  check('ANSWER an empty period says so and never $0 across 0 documents', nov.handled && /No invoices/.test(text(nov)) && !/\$0\.00/.test(text(nov)) && nov.data.facts.length === 0, text(nov));

  const op = await gate('open invoices');
  check('ANSWER open invoices: $3,940.50 across 4, $1,940.50 of it past due (3), the 3 with no payment status are named as not counted', op.handled && /\$3,940\.50/.test(text(op)) && /4 open invoices/.test(text(op)) && /\$1,940\.50/.test(text(op)) && /3 invoices show no payment status/.test(text(op)), text(op));
  const bucket = (r, label) => r.data.facts.find((f) => f.label === label)?.value;
  eq('ANSWER aging buckets: not yet due $2,000.00 | 1-30 $1,240.50 | 31-60 $500.00 | 61-90 $200.00 | (no 90+)', [bucket(op, 'Not yet due'), bucket(op, '1-30 days past due'), bucket(op, '31-60 days past due'), bucket(op, '61-90 days past due'), bucket(op, 'Over 90 days past due')], ['$2,000.00 (1 invoice)', '$1,240.50 (1 invoice)', '$500.00 (1 invoice)', '$200.00 (1 invoice)', undefined]);
  check('ANSWER open invoices: rows cite their invoice documents and carry the due date / days past due', op.data.facts.some((f) => /INV-1002/.test(f.label) && /12 days past due/.test(f.value) && f.sources[0].documentId === dA(2)) && op.data.sources.length === 4);
  const od = await gate('which invoices are overdue');
  check('ANSWER overdue: 3 invoices past due totaling $1,940.50 (not the not-yet-due $2,000.00)', od.handled && /3 invoices/.test(text(od)) && /\$1,940\.50/.test(text(od)) && od.data.facts.filter((f) => f.sources.length && /INV-/.test(f.label)).length === 3, text(od));
  const ag = await gate('show me the ar aging');
  check('ANSWER aging: same buckets, oldest first', ag.handled && bucket(ag, '61-90 days past due') === '$200.00 (1 invoice)', text(ag));
  const oc = await gate('who owes us money for Plaza Dental');
  check('ANSWER open invoices for one customer: Plaza owes $2,200.00 across 2 (one partly paid: only the $200.00 balance counts)', oc.handled && /\$2,200\.00/.test(text(oc)) && /2 open invoices/.test(text(oc)) && /Plaza Dental Group/.test(text(oc)), text(oc));
  const pay = await gate('what do we owe our vendors');
  check('ANSWER payables: we owe $450.00 on 1 open bill (Ferguson), past due; customer invoices are not in it', pay.handled && /\$450\.00/.test(text(pay)) && /1 open bill/.test(text(pay)) && !/\$3,940/.test(text(pay)), text(pay));

  const rm = await gate('revenue by month');
  eq('ANSWER revenue by month: Mar $1,200.00 | Jun $300.00 | Aug $1,690.50 (3) | Sep $2,120.00 (2)', rm.data.facts.map((f) => [f.label, f.value]), [['March 2026', '$1,200.00 (1 invoice)'], ['June 2026', '$300.00 (1 invoice)'], ['August 2026', '$1,690.50 (3 invoices)'], ['September 2026', '$2,120.00 (2 invoices)']]);
  check('ANSWER revenue by month: total $5,310.50 over 7 invoices, exclusions named', /\$5,310\.50/.test(text(rm)) && /7 invoices/.test(text(rm)) && /prints no total/.test(text(rm)) && /no printed date/.test(text(rm)), text(rm));
  const af = await gate("what's the total we've collected in maintenance agreement fees");
  check('ANSWER agreement fees: $950.00 across 2 agreements, $350.00 marked paid, honest that collection is not recorded, 1 agreement with no fee excluded', af.handled && /\$950\.00/.test(text(af)) && /2 agreements/.test(text(af)) && /\$350\.00/.test(text(af)) && /don't record whether the rest were collected/.test(text(af)) && /1 agreement prints no total/.test(text(af)), text(af));
  const qv = await gate('Bracken quote vs invoice');
  check('ANSWER quote vs invoice: quote $1,100.00, invoiced $2,440.50, $1,340.50 over (difference computed in SQL)', qv.handled && /\$1,100\.00/.test(text(qv)) && /\$2,440\.50/.test(text(qv)) && /\$1,340\.50 over/.test(text(qv)), text(qv));
  const top = await gate('who is our biggest customer by revenue');
  check('ANSWER top customers: Ed Bracken $2,440.50, then Plaza $2,300.00', top.handled && /Ed Bracken/.test(text(top)) && /\$2,440\.50/.test(text(top)) && top.data.facts[1].value.startsWith('$2,300.00'), JSON.stringify(top.data.facts.map((f) => [f.label, f.value])));
  const avg = await gate('average invoice size');
  check('ANSWER average invoice: $776.50 across 7 invoices (credit memo and payables excluded)', avg.handled && /\$776\.50/.test(text(avg)) && /7 invoices/.test(text(avg)), text(avg));
  const spend = await gate('total spend with ferguson');
  check('ANSWER vendor spend: $450.00 on 1 bill from ferguson (the PO is not double counted)', spend.handled && /\$450\.00/.test(text(spend)) && /1 bill/.test(text(spend)), text(spend));
  const po = await gate('what is the total of our purchase orders');
  check('ANSWER purchase orders: $800.00 across 1', po.handled && /\$800\.00/.test(text(po)), text(po));

  const b = await gate('what have we invoiced this year', ctxB);
  check('tenant B asking the same question sees only tenant B ($99,999.00 across 1 invoice), never A', b.handled && /\$99,999\.00/.test(text(b)) && /1 invoice/.test(text(b)) && !/5,3/.test(text(b)));
  const c = await gate('how much did we invoice last month', ctxC);
  eq('a tenant with no financial rows: not handled and hasData false -> keeps today\'s honest refusal', [c.handled, c.hasData], [false, false]);
  const allAnswers = [lm, ty, tm, all, cust, op, od, ag, oc, pay, rm, af, qv, top, avg, spend, po];
  check('EVERY answer is a well-formed answer object with counts and citations (no bare number without a document count)', allAnswers.every((r) => r.data.kind === 'answer' && Array.isArray(r.data.facts) && typeof r.data.verifiedCount === 'number') && allAnswers.every((r) => /\b\d+ (invoices?|agreements?|bills?|purchase orders?|open invoices?|open bills?)\b|\$\d/.test(r.data.text)));
  check('no answer contains a fabricated NaN / undefined / null amount', allAnswers.every((r) => !/NaN|undefined|null|\$-/.test(JSON.stringify(r.data))));
}

/* ================================================================== 3b. R3_FAILS.md new intents */
{
  // Fixture recap (invoice-kind, receivable, tenant A, before any correction/verification below):
  // doc1 paid $1,200 (amount_paid $1,200) | doc2 unpaid $1,240.50 (tax $90.50) | doc3 unpaid $500
  // doc4 unpaid $2,000 | doc5 partial $300 (amount_paid $100) | doc6 unknown, no total
  // doc8 unknown $75 (undated) | doc9 unknown $120 (tax $10.00, flagged total_mismatch)
  // -> 8 invoices: 1 paid, 3 unpaid, 1 partial, 3 unknown; none verified yet.
  const paid = await gate('how many invoices are paid');
  check('ANSWER payment status (paid): 1 invoice shows as paid ($1,200.00); 3 unknown-status invoices named, honestly', paid.handled && /1 invoice shows as paid/.test(text(paid)) && /\$1,200\.00/.test(text(paid)) && /3 invoices don't print a payment status/.test(text(paid)) && /DeepWell/.test(text(paid)), text(paid));
  const partial = await gate('how many invoices are partially paid');
  check('ANSWER payment status (partial): 1 invoice shows as partially paid ($300.00)', partial.handled && /1 invoice shows as partially paid/.test(text(partial)) && /\$300\.00/.test(text(partial)), text(partial));

  const over = await gate('how many invoices are over $1,000');
  check('ANSWER threshold (over): 3 invoices over $1,000 (doc1 1200, doc2 1240.50, doc4 2000), listed', over.handled && /3 invoices are over \$1,000\.00/.test(text(over)) && over.data.facts.length === 3, text(over));
  const under = await gate('how many invoices are under $500');
  check('ANSWER threshold (under): 3 invoices under $500 (doc3 $500 itself excluded - strictly under)', under.handled && /3 invoices are under \$500\.00/.test(text(under)), text(under));

  const big = await gate("what's the biggest invoice we've ever sent");
  check('ANSWER biggest invoice: $2,000.00 (doc4, Plaza Dental Group) - invoices only, not the $2,440.50 quote+invoice combo or any PO/agreement', big.handled && /\$2,000\.00/.test(text(big)) && /Plaza Dental Group/.test(text(big)) && /Invoices only/.test(text(big)), text(big));
  const small = await gate('what is the smallest invoice on file');
  check('ANSWER smallest invoice: $75.00 (doc8)', small.handled && /\$75\.00/.test(text(small)), text(small));

  const tax = await gate('how much sales tax have we charged');
  check('ANSWER sales tax: $100.50 across 2 invoices that print tax (doc2 $90.50 + doc9 $10.00)', tax.handled && /\$100\.50/.test(text(tax)) && /2 invoices/.test(text(tax)), text(tax));
  const noTax = await gate('how much sales tax have we charged', ctxB);
  check('ANSWER sales tax: tenant B prints none -> honest "none of your invoices print sales tax"', noTax.handled && /none of your invoices print sales tax/i.test(text(noTax)), text(noTax));

  const collected = await gate('how much have we collected');
  check('ANSWER collected: We\'ve collected $1,300.00 (doc1 $1,200 + doc5 $100 amount_paid) across 2 invoices - the headline figure is amount_paid, never the $5,385.50 invoiced total', collected.handled && /We've collected \$1,300\.00/.test(text(collected)) && /2 invoices/.test(text(collected)), text(collected));
  const paidUs = await gate('have customers paid us');
  check('ANSWER "have customers paid us" routes to the same collected-amount answer', paidUs.handled && /\$1,300\.00/.test(text(paidUs)), text(paidUs));

  const waiting = await gate('do we have any quotes waiting on a customer');
  check('ANSWER quotes waiting: no (Bracken\'s only quote already has two later invoices)', waiting.handled && /^No/.test(text(waiting)), text(waiting));

  const needsVer = await gate('how many invoices still need someone to verify the numbers');
  check('ANSWER needs verification: all 8 invoices are unverified so far', needsVer.handled && /8 invoices/.test(text(needsVer)) && /of 8 total/.test(text(needsVer)), text(needsVer));

  const owesMost = await gate('which customer owes us the most');
  check('ANSWER who-owes-the-most: Plaza Dental Group $2,200.00 (doc4 $2,000 + doc5 $200 open balance), ranked by balance not document count', owesMost.handled && /Plaza Dental Group owes the most/.test(text(owesMost)) && /\$2,200\.00/.test(text(owesMost)) && !/\d+ documents?\b/.test(text(owesMost)), text(owesMost));
}

/* ================================================================== 4. the agent's financials view */
{
  const tb = () => createToolbox({ withTenant, ctxArg: ctxA, today: TODAY });
  const parse = (r) => JSON.parse(r.content);
  const cell = (p, c) => p.rows.map((row) => row[p.columns.indexOf(c)]);
  const t = tb();
  const sum = await t.execute('run_query', { sql: "SELECT count(*) AS n, sum(total) AS s, count(*) FILTER (WHERE total IS NULL) AS no_total FROM financials WHERE direction = 'receivable' AND doc_kind IN ('invoice','credit_memo') AND currency = 'USD'", purpose: 'total invoiced' });
  eq('agent view: SUM in SQL over the financials view = 5385.50 across 9 rows (1 with no total)', sum.ok ? [cell(parse(sum), 'n')[0], cell(parse(sum), 's')[0], cell(parse(sum), 'no_total')[0]] : sum.content, [9, '5385.50', 1]);
  const cust = await t.execute('run_query', { sql: "SELECT customer_name, sum(total) AS s FROM financials WHERE doc_kind = 'invoice' AND customer_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1", purpose: 'customer link' });
  eq('agent view: customer_id/customer_name come from the live document links', cust.ok ? [cell(parse(cust), 'customer_name')[0], cell(parse(cust), 's')[0]] : cust.content, ['Ed Bracken', '2440.50']);
  const lines = await t.execute('run_query', { sql: "SELECT document_id, description, amount FROM invoice_lines WHERE customer_name = 'Ed Bracken' ORDER BY line_no", purpose: 'lines' });
  eq('agent view: invoice_lines returns the printed line items with the document id to cite', lines.ok ? [cell(parse(lines), 'description'), cell(parse(lines), 'amount')] : lines.content, [['Labor', 'Parts'], ['900.00', '250.00']]);
  const tbB = createToolbox({ withTenant, ctxArg: ctxB, today: TODAY });
  const sumB = await tbB.execute('run_query', { sql: 'SELECT count(*) AS n, sum(total) AS s FROM financials', purpose: 'rls' });
  eq('RLS: tenant B\'s financials view holds only B\'s own row (1 row, $99,999.00) - none of A\'s 15', sumB.ok ? [cell(parse(sumB), 'n')[0], cell(parse(sumB), 's')[0]] : sumB.content, [1, '99999.00']);
  const linesB = await tbB.execute('run_query', { sql: 'SELECT count(*) AS n FROM invoice_lines', purpose: 'rls lines' });
  eq('RLS: tenant B sees none of A\'s invoice lines', linesB.ok ? cell(parse(linesB), 'n') : linesB.content, [0]);
  const raw = (sql) => t._runQueryForTests({ sql }, { skipGuard: true });
  const rawA = await raw('SELECT count(*)::int AS n FROM document_financials');
  const rawLines = await raw('SELECT count(*)::int AS n FROM document_financial_lines');
  eq('RLS with the guard bypassed: SELECT FROM document_financials as A still returns only A\'s 15 rows (not 16), lines only A\'s 2', [cell(parse(rawA), 'n')[0], cell(parse(rawLines), 'n')[0]], [15, 2]);
  eq('control: as superuser the table holds all 16 rows, so the 15 above is RLS at work', (await lite.query('SELECT count(*)::int AS n FROM document_financials')).rows[0].n, 16);
  const ins = await raw("INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction) VALUES ('" + tenB + "', '" + dA(90) + "', 'invoice', 'receivable')");
  check('read-only + RLS: an INSERT through the agent path is refused', !ins.ok, ins.content);
  const real = await t.execute('run_query', { sql: 'SELECT * FROM document_financials', purpose: 'real table' });
  check('the real tables cannot be queried directly by the model (views only)', !real.ok && /not queryable/.test(real.content));
  const cat = await t.execute('describe_data', {});
  check('describe_data tells the model financial data exists (15 documents, 13 with a total)', parse(cat).financials?.documents === 15 && parse(cat).financials?.withTotal === 13, cat.content.slice(-200));

  // prompt rule
  check('agent prompt: the old "never total dollar amounts" ban is gone; totals only from the financials view, SQL-summed, with document count + exclusions + citations', !/never total, sum, or estimate dollar amounts/.test(AGENT_SYSTEM_PROMPT) && /ONLY from the financials view/.test(AGENT_SYSTEM_PROMPT) && /never estimate a dollar amount/.test(AGENT_SYSTEM_PROMPT) && /cite the invoice documents/.test(AGENT_SYSTEM_PROMPT));
  check('VIEW_DOCS documents financials + invoice_lines and the MONEY RULES (revenue kinds, NULL totals excluded and counted)', /financials\(document_id/.test(VIEW_DOCS) && /invoice_lines\(/.test(VIEW_DOCS) && /MONEY RULES/.test(VIEW_DOCS) && /total IS NULL/.test(VIEW_DOCS));

  // scripted agent trajectory: an exotic money question the deterministic shapes do not cover
  let n = 0;
  const tuc = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
  const last = (m) => { const b = m[m.length - 1].content.find((x) => x.type === 'tool_result'); return JSON.parse(b.content); };
  const model = (() => {
    let i = 0;
    const turns = [
      () => [tuc('run_query', { purpose: 'sum of Plaza invoices', sql: "SELECT count(*) AS invoices, sum(total) AS amount, count(*) FILTER (WHERE total IS NULL) AS no_total FROM financials WHERE customer_name = 'Plaza Dental Group' AND doc_kind = 'invoice'" })],
      () => [tuc('run_query', { purpose: 'the documents', sql: "SELECT document_id, invoice_number, total FROM financials WHERE customer_name = 'Plaza Dental Group' AND doc_kind = 'invoice' ORDER BY invoice_number" })],
      (m) => { const p = last(m); return [tuc('answer', { status: 'answered', text: 'Plaza Dental Group has been invoiced $2,300.00 across 2 invoices.', interpretation: 'sum of invoice totals', facts: [{ label: 'Invoiced to Plaza Dental Group', value: '$2,300.00', sources: p.rows.map((r) => ({ documentId: r[0], location: { field: 'total' } })) }] })]; },
    ];
    return async (req) => { const out = turns[Math.min(i++, turns.length - 1)](req.messages, req); return { content: out, usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'tool_use' }; };
  })();
  const run = await runDonovanAgent({ withTenant, ctxArg: ctxA, question: 'what has plaza dental been billed in total', today: TODAY, callModel: model });
  check('AGENT money answer: total comes from a SQL SUM (2,300.00 appears in a tool result), and is cited to the 2 Plaza invoice documents',
    run.handled && run.data.kind === 'answer' && /2,300\.00/.test(run.data.text) && run.data.sources.length === 2 && run.data.sources.map((s) => s.documentId).sort().join() === [dA(4), dA(5)].sort().join(), JSON.stringify(run.data ?? run).slice(0, 400));
  const led = t.ledger;
  const invented = shapeAgentAnswer({ status: 'answered', text: 'We invoiced $9,999.00 across 3 invoices.', facts: [{ label: 'Invoiced', value: '$9,999.00' }] }, (await (async () => { const tt = tb(); await tt.execute('run_query', { sql: "SELECT sum(total) AS s FROM financials WHERE doc_kind = 'invoice'", purpose: 'x' }); return tt.ledger; })()), { question: 'total invoiced', today: TODAY });
  check('NO FABRICATED TOTAL: an agent answer whose dollar figure appears in no tool result is dropped, not shown', !invented.answered && !JSON.stringify(invented.data).includes('9,999'), JSON.stringify(invented.data));
  void led;
  const grounded = (() => shapeAgentAnswer({ status: 'answered', text: 'x', facts: [{ label: 'Invoiced', value: '$5,435.50' }] }, (() => { const tt = tb(); return tt.ledger; })(), { question: 'q', today: TODAY }))();
  check('NO FABRICATED TOTAL: with no tool evidence a dollar figure is never accepted', !grounded.answered);
}

/* ================================================================== 5. corrections, verification, review, summary */
{
  const doc3 = await withTenant(ctxA, (db) => S.getDocumentFinancials(db, dA(3)));
  eq('review view of an untouched field: original == value, not corrected', [doc3.financials.fields.total.value, doc3.financials.fields.total.original, doc3.financials.fields.total.corrected], ['500.00', '500.00', false]);
  const before = await withTenant(ctxA, (db) => S.listFinancialsNeedingReview(db));
  const ids = before.items.map((i) => i.documentId);
  check('needs review: the mismatch (doc 9) and the no-total invoice (doc 6) are listed; a clean verified-looking paid invoice (doc 1) is not', ids.includes(dA(9)) && ids.includes(dA(6)) && !ids.includes(dA(1)) && before.items.find((i) => i.documentId === dA(9)).flags.includes('total_mismatch'), JSON.stringify(before.items.map((i) => [i.documentId.slice(-2), i.flags])));
  const sumBefore = await withTenant(ctxA, (db) => A.financialsSummary(db, { today: TODAY }));
  check('dashboard summary: invoiced this month $2,120.00 (2), YTD $5,310.50 (7), open $3,940.50 (4), overdue $1,940.50 (3), 1 flagged, exclusions counted',
    sumBefore.month.total === '2120.00' && sumBefore.month.invoices === 2 && sumBefore.ytd.total === '5310.50' && sumBefore.ytd.invoices === 7 && sumBefore.open.total === '3940.50' && sumBefore.open.invoices === 4 && sumBefore.overdue.total === '1940.50' && sumBefore.overdue.invoices === 3 && sumBefore.needsReview === 1 && sumBefore.excluded.noTotal === 1 && sumBefore.excluded.undated === 1, JSON.stringify(sumBefore));
  eq('dashboard aging buckets add up: current 2000.00, 1-30 1240.50, 31-60 500.00, 61-90 200.00, 90+ 0', [sumBefore.aging.current, sumBefore.aging.d1_30, sumBefore.aging.d31_60, sumBefore.aging.d61_90, Number(sumBefore.aging.d90plus)], ['2000.00', '1240.50', '500.00', '200.00', 0]);

  const bad = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(3), field: 'total', value: 'abc', by: 'Owner' })).catch((e) => e);
  check('a junk correction is refused with a 400 and stores nothing', bad instanceof S.FinancialsError && bad.status === 400);
  const ro = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(3), field: 'confidence', value: '1', by: 'Owner' })).catch((e) => e);
  check('only the editable financial fields can be corrected', ro instanceof S.FinancialsError);
  const fixed = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(3), field: 'total', value: '$550.00', by: 'Owner' }));
  check('correction: stored BESIDE the original (original 500.00 kept, effective 550.00, corrected flag, who)', fixed.financials.fields.total.value === '550.00' && fixed.financials.fields.total.original === '500.00' && fixed.financials.fields.total.corrected && fixed.financials.correctedBy === 'Owner');
  const raw = (await lite.query('SELECT total, corrections FROM document_financials WHERE document_id = $1', [dA(3)])).rows[0];
  check('correction: the extracted column is untouched; the correction lives in corrections JSON', raw.total === '500.00' && raw.corrections.total === '550.00');
  const lm2 = await gate('how much did we invoice last month');
  check('a correction flows straight into every total: last month is now $1,740.50 (500 -> 550)', /\$1,740\.50/.test(text(lm2)), text(lm2));
  const viewS = await createToolbox({ withTenant, ctxArg: ctxA, today: TODAY }).execute('run_query', { sql: "SELECT total FROM financials WHERE invoice_number = 'INV-2001'", purpose: 'x' });
  check('the agent view applies the correction too (550.00), so the agent and the deterministic answers never disagree', JSON.parse(viewS.content).rows[0][0] === '550.00');
  const re = await X.extractFinancialsForDocument(ctxA, dA(3), { withTenant, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('a corrected row is NEVER overwritten by re-extraction (skipped human_reviewed, no model call)', [re.status, re.reason, re.modelCalls], ['skipped', 'human_reviewed', 0]);
  const mfix = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(9), field: 'total', value: '110.00', by: 'Owner' }));
  check('correcting the mismatched total so it adds up clears total_mismatch and lifts confidence; the original 120.00 is kept', !mfix.financials.flags.includes('total_mismatch') && mfix.financials.confidence >= 0.95 && mfix.financials.fields.total.original === '120.00');
  const wrong = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(9), field: 'tax', value: '99.00', by: 'Owner' }));
  check('a correction that still does not add up keeps the flag and caps confidence at 0.4 (nothing silently "fixed")', wrong.financials.flags.includes('total_mismatch') && wrong.financials.confidence <= 0.4);
  const ver = await withTenant(ctxA, (db) => S.verifyFinancials(db, { documentId: dA(2), by: 'Owner' }));
  check('verify: records who/when; needs-review no longer lists it; a later correction un-verifies it', ver.financials.verifiedBy === 'Owner' && !(await withTenant(ctxA, (db) => S.listFinancialsNeedingReview(db))).items.some((i) => i.documentId === dA(2)));
  const ans = await gate('what did we bill Bracken for his last job');
  check('verified documents count as verified in the answer (verifiedCount 1)', ans.data.verifiedCount === 1 && ans.data.unverifiedCount === 0);
  await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(2), field: 'status', value: 'paid', by: 'Owner' }));
  check('correcting the status to paid takes INV-1002 out of open receivables ($3,940.50 - $1,240.50 = $2,700.00 - 0 correction on doc 3 balance)', /\$2,700\.00/.test(text(await gate('open invoices'))) && (await withTenant(ctxA, (db) => S.getDocumentFinancials(db, dA(2)))).financials.verifiedBy === null);
  const noRow = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(90), field: 'total', value: '5', by: 'Owner' })).catch((e) => e);
  check('correcting a document with no financial row is a clean 404', noRow instanceof S.FinancialsError && noRow.status === 404);
  const crossTenant = await withTenant(ctxB, (db) => S.correctFinancialField(db, { documentId: dA(3), field: 'total', value: '1.00', by: 'Owner' })).catch((e) => e);
  check('tenant B cannot correct tenant A\'s document (RLS: it does not exist for B)', crossTenant instanceof S.FinancialsError && crossTenant.status === 404);
  const exp = (await lite.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.financials_extracted'")).rows[0].n;
  check('each extraction wrote an audit row (counts only)', exp >= 16);
  const auditLeak = (await lite.query("SELECT changes FROM audit_log WHERE action = 'document.financials_extracted'")).rows.some((r) => /Bracken|Abernathy|1240|Ferguson/.test(JSON.stringify(r.changes)));
  check('audit rows carry no names or amounts', !auditLeak);
}

/* ================================================================== 6. gate with/without the table */
{
  const ask = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('ask.js wiring: the money gate asks the financials layer first, hands unmatched questions to the agent, and otherwise keeps moneyFallbackAnswer', /answerMoneyQuestion\(\{ withTenant, ctxArg, question, today: todayResolved \}\)/.test(ask) && /fin\.hasData && \(await tryAgent\(\)\)/.test(ask) && /fin\.hasData \? moneyNoMatchAnswer\(\) : moneyFallbackAnswer\(\)/.test(ask));
  eq('the honest refusal text is unchanged when there is no data', moneyFallbackAnswer().text, MONEY_FALLBACK_TEXT);
  check('no-match text never claims "can\'t total yet" (it would be false once data exists)', !/can't total/.test(G.MONEY_NO_MATCH_TEXT) && G.moneyNoMatchAnswer().facts.length === 0);
  const q = (await gate('what did we bill Bracken for his last job')).handled;

  // DROP the tables: feature off, everything degrades, nothing throws
  await lite.exec('DROP TABLE document_financial_lines; DROP TABLE document_financials CASCADE');
  S._resetFinancialsProbe();
  const off = await gate('what did we bill Bracken for his last job');
  eq('TABLE ABSENT: money gate -> {handled:false, hasData:false} -> ask.js serves today\'s honest refusal', [q, off.handled, off.hasData], [true, false, false]);
  const offDoc = await withTenant(ctxA, (db) => S.getDocumentFinancials(db, dA(2)));
  eq('TABLE ABSENT: the per-document read reports enabled:false (UI hides the panel)', offDoc, { enabled: false, financials: null });
  const offCorr = await withTenant(ctxA, (db) => S.correctFinancialField(db, { documentId: dA(2), field: 'total', value: '1', by: 'x' })).catch((e) => e);
  check('TABLE ABSENT: a correction answers a clean 503, not a raw SQL error', offCorr instanceof S.FinancialsError && offCorr.status === 503);
  const offExtract = await X.extractFinancialsForDocument(ctxA, dA(2), { withTenant, callModel: fakeModel, skipBudget: true });
  eq('TABLE ABSENT: extraction skips with no model call', [offExtract.status, offExtract.reason, offExtract.modelCalls], ['skipped', 'table_missing', 0]);
  const offBackfill = await B.runFinancialsBackfill(ctxA, { callModel: fakeModel, skipBudget: true });
  eq('TABLE ABSENT: backfill reports enabled:false and does nothing', [offBackfill.enabled, offBackfill.modelCalls], [false, 0]);
  const tbOff = createToolbox({ withTenant, ctxArg: ctxA, today: TODAY });
  const viewOff = await tbOff.execute('run_query', { sql: 'SELECT count(*) AS n FROM financials', purpose: 'off' });
  check('TABLE ABSENT: the agent\'s financials view still exists (empty) so no query errors', viewOff.ok && JSON.parse(viewOff.content).rows[0][0] === 0, viewOff.content);
  const stillWorks = await tbOff.execute('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'other views unaffected' });
  check('TABLE ABSENT: every other agent view is unaffected', stillWorks.ok && JSON.parse(stillWorks.content).rows[0][0] === 7);
  const offCat = await tbOff.execute('describe_data', {});
  check('TABLE ABSENT: describe_data omits the financials block', !('financials' in JSON.parse(offCat.content)));
  const exported = await (await import('../api/_lib/opsStore.js')).exportTenant(ctxA);
  check('TABLE ABSENT: the tenant export is unchanged (no financials key)', !('financials' in exported));

  // re-apply the migration: idempotent restore, then "table exists but no rows for the tenant"
  await lite.exec(fs.readFileSync(path.join(cfgDir, '22-document-financials.sql'), 'utf8'));
  S._resetFinancialsProbe();
  const empty = await gate('what did we bill Bracken for his last job');
  eq('TABLE PRESENT, NO ROWS: hasData false -> the honest refusal, not an invented $0', [empty.handled, empty.hasData], [false, false]);
  const rows0 = (await lite.query('SELECT count(*)::int AS n FROM document_financials')).rows[0].n;
  eq('the re-created table starts empty (the earlier rows died with the DROP, as expected)', rows0, 0);
  await B.runFinancialsBackfill(ctxA, { callModel: fakeModel, skipBudget: true, today: TODAY });
  const back = await gate('what did we bill Bracken for his last job');
  check('after the migration + a backfill the same question answers again, from the re-extracted data', back.handled && /\$1,240\.50/.test(text(back)), text(back));
  const exported2 = await (await import('../api/_lib/opsStore.js')).exportTenant(ctxA);
  check('with the table present the tenant export includes financials + lines (tenant A only)', Array.isArray(exported2.financials) && exported2.financials.length === 15 && exported2.financials.every((r) => r.tenant_id === tenA) && Array.isArray(exported2.financial_lines));
}

/* ================================================================== static checks */
{
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
  eq('api/ still has exactly 12 top-level files (Vercel Hobby function ceiling)', apiFiles.length, 12);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json: verify:financials exists and is part of verify:all', pkg.scripts['verify:financials'] === 'node scripts/verify-financials.mjs' && /verify:financials/.test(pkg.scripts['verify:all']));
  const account = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
  check('the financials route is reachable via /api/account?action=financials only (no new function)', /financials/.test(account) && !fs.existsSync(path.join(ROOT, 'api/financials.js')));
  const route = fs.readFileSync(path.join(ROOT, 'api/_lib/routes/financials.js'), 'utf8');
  check('route: backfill/summary are admin-gated, backfill is billing-gated and rate-limited; tenant + user come only from the token', /requireAdmin\(\)/.test(route) && /assertActiveBilling/.test(route) && /rateLimit\(req, res, auth, "write"\)/.test(route) && !/body\.tenant/.test(route));
  const srcs = ['normalize', 'store', 'extract', 'answers', 'moneyGate', 'backfill', 'hook'].map((f) => fs.readFileSync(path.join(ROOT, `api/_lib/financials/${f}.js`), 'utf8')).join('\n');
  check('no financials source logs question text, names or amounts (console.* only ever prints an error name)', !/console\.(log|error|warn)\([^)]*(question|namePhrase|total|amount|customer)/i.test(srcs.replace(/console\.error\('financials: [a-z ]+:'[^)]*\)/g, '')));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
process.exit(0);
