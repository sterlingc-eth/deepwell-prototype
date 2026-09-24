/**
 * Unit checks for the owners-only expense tracker
 * (handoffs/EXPENSES_2026-09-22.md). Pure functions only — no DB, no
 * network, no Clerk. Same style as scripts/verify-miss-digest.mjs /
 * scripts/verify-followups.mjs.
 *
 *   node scripts/verify-expenses.mjs
 */
import {
  EXPENSE_CATEGORIES,
  isValidExpenseCategory,
  parseAmountToCents,
  centsToDollarString,
  csvEscapeField,
  buildExpensesCsv,
  resolveExpenseDateRange,
  shapeExpenseTotals,
  MAX_EXPENSE_CENTS,
  aggregateMonthly,
  isOwnedReceiptKey,
  monthRange,
  yearRange,
  ymdOf,
} from '../api/_lib/expensesStore.js';
import { validateExpenseFields, dispatchExpenses, handleReceiptViewUrl, isExpensesOperator, _resetFounderMemberCache } from '../api/_lib/routes/expenses.js';
import { isPlatformOperator } from '../api/_lib/missDigest.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- categories */

check('category list has all eleven fixed categories', EXPENSE_CATEGORIES.length === 11);
check('AI & Cloud Services is a valid category', isValidExpenseCategory('AI & Cloud Services'));
check('Other is a valid category', isValidExpenseCategory('Other'));
check('an arbitrary string is not a valid category', !isValidExpenseCategory('Snacks'));
check('empty string is not a valid category', !isValidExpenseCategory(''));

/* --------------------------------------------------------- amount parsing */

eq('parses a plain decimal', parseAmountToCents('21.66'), 2166);
eq('parses a dollar sign + comma amount', parseAmountToCents('$1,234.50'), 123450);
eq('parses a parenthesized amount as negative', parseAmountToCents('(45.00)'), -4500);
eq('parses a bare number type', parseAmountToCents(21.66), 2166);
eq('parses a leading-minus amount as negative', parseAmountToCents('-9.99'), -999);
eq('parses a whole-dollar amount with no cents', parseAmountToCents('$200'), 20000);
eq('rejects an empty string', parseAmountToCents(''), null);
eq('rejects non-numeric text', parseAmountToCents('free'), null);
eq('rejects a NaN number', parseAmountToCents(NaN), null);
eq('rejects three-decimal cents', parseAmountToCents('21.666'), null);

eq('centsToDollarString: plain', centsToDollarString(2166), '21.66');
eq('centsToDollarString: negative', centsToDollarString(-4500), '-45.00');
eq('centsToDollarString: whole dollars', centsToDollarString(20000), '200.00');
eq('centsToDollarString: null/undefined -> 0.00', centsToDollarString(undefined), '0.00');

/* --------------------------------------------------------------- CSV -- */

eq('csvEscapeField: plain text unchanged', csvEscapeField('Anthropic'), 'Anthropic');
eq('csvEscapeField: a comma forces quoting', csvEscapeField('Acme, Inc.'), '"Acme, Inc."');
eq('csvEscapeField: an embedded quote is doubled and the field quoted', csvEscapeField('12" pipe'), '"12"" pipe"');
eq('csvEscapeField: a newline forces quoting', csvEscapeField('line one\nline two'), '"line one\nline two"');
eq('csvEscapeField: null/undefined -> empty string', csvEscapeField(null), '');

{
  const rows = [
    { occurred_on: '2026-09-11', vendor: 'Anthropic', amount_cents: 2166, currency: 'USD', category: 'AI & Cloud Services', note: 'Claude Max 20 — $200/mo, prorated', receipt_filename: null, receipt_key: null },
    { occurred_on: '2026-09-13', vendor: 'Acme, Inc.', amount_cents: 16810, currency: 'USD', category: 'Software & Subscriptions', note: null, receipt_filename: 'receipt.pdf', receipt_key: 'platform/expenses/abc' },
  ];
  const csv = buildExpensesCsv(rows);
  check('buildExpensesCsv: starts with the header row', csv.startsWith('Date,Vendor,Amount,Currency,Category,Note,Receipt Filename,receipt_on_file\r\n'));
  check('buildExpensesCsv: one line per row plus the header, CRLF-terminated', csv.split('\r\n').filter(Boolean).length === 3);
  check('buildExpensesCsv: quotes a vendor containing a comma', csv.includes('"Acme, Inc."'));
  check('buildExpensesCsv: renders cents as a plain decimal amount', csv.includes(',21.66,USD,'));
  check('buildExpensesCsv: empty note renders as an empty field, not "null"', !csv.includes('null'));
}

/* --------------------------------------------------------- date ranges -- */

const FIXED_NOW = new Date('2026-09-22T18:00:00Z');

eq('resolveExpenseDateRange: month -> calendar month bounds', resolveExpenseDateRange('month', FIXED_NOW), { from: '2026-09-01', to: '2026-09-30' });
eq('resolveExpenseDateRange: year -> calendar year bounds', resolveExpenseDateRange('year', FIXED_NOW), { from: '2026-01-01', to: '2026-12-31' });
eq('resolveExpenseDateRange: ytd -> Jan 1 through today', resolveExpenseDateRange('ytd', FIXED_NOW), { from: '2026-01-01', to: '2026-09-22' });
eq('resolveExpenseDateRange: custom -> passes the given bounds through', resolveExpenseDateRange('custom', FIXED_NOW, { from: '2025-01-01', to: '2025-06-30' }), { from: '2025-01-01', to: '2025-06-30' });
eq('resolveExpenseDateRange: custom with no bounds -> both null (open range)', resolveExpenseDateRange('custom', FIXED_NOW, {}), { from: null, to: null });
eq('resolveExpenseDateRange: unknown kind defaults to ytd', resolveExpenseDateRange('bogus', FIXED_NOW), { from: '2026-01-01', to: '2026-09-22' });

// A leap-year February should resolve to 29 days, not a hardcoded 28.
eq('resolveExpenseDateRange: month handles a leap-year February', resolveExpenseDateRange('month', new Date('2028-02-10T00:00:00Z')), { from: '2028-02-01', to: '2028-02-29' });

/* ------------------------------------------------------------- totals -- */

{
  const rows = [
    { category: 'AI & Cloud Services', month: '2026-09', total_cents: '2166', expense_count: '1' },
    { category: 'AI & Cloud Services', month: '2026-09', total_cents: '16810', expense_count: '1' },
    { category: 'Software & Subscriptions', month: '2026-08', total_cents: '5000', expense_count: '2' },
  ];
  const shaped = shapeExpenseTotals(rows);
  eq('shapeExpenseTotals: grand total sums every row', shaped.grandTotalCents, 23976);
  check('shapeExpenseTotals: merges the same category across months into one bucket', shaped.byCategory.length === 2);
  eq('shapeExpenseTotals: byCategory sorted highest total first', shaped.byCategory[0].category, 'AI & Cloud Services');
  eq('shapeExpenseTotals: byCategory total is the sum of its rows', shaped.byCategory[0].totalCents, 18976);
  eq('shapeExpenseTotals: byMonth sorted chronologically', shaped.byMonth.map((m) => m.month), ['2026-08', '2026-09']);
}
eq('shapeExpenseTotals: empty input -> zeroed shape, not a throw', shapeExpenseTotals([]), { grandTotalCents: 0, byCategory: [], byMonth: [] });
eq('shapeExpenseTotals: undefined input -> zeroed shape, not a throw', shapeExpenseTotals(undefined), { grandTotalCents: 0, byCategory: [], byMonth: [] });

/* --------------------------------------------------- operator gate reuse */
// The route gates every op (except operatorStatus) with the SAME
// isPlatformOperator missDigest.js/review.js already use — asserted here so
// a future refactor of that gate can't silently stop covering expenses too.

const OPERATOR_ENV_BACKUP = { founder: process.env.DEEPWELL_FOUNDER_TENANT_ID, ids: process.env.DEEPWELL_OPERATOR_USER_IDS };
process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder';
process.env.DEEPWELL_OPERATOR_USER_IDS = 'user_ops1';

check('a fake non-operator auth (some other tenant, unlisted user) is refused', !isPlatformOperator({ tenantId: 'org_other_shop', userId: 'user_random' }));
check('a fake non-operator auth with no auth at all is refused', !isPlatformOperator(null));
check('the founder tenant itself is an operator', isPlatformOperator({ tenantId: 'org_founder', userId: 'user_random' }));
check('an allowlisted user id is an operator regardless of tenant', isPlatformOperator({ tenantId: 'org_other_shop', userId: 'user_ops1' }));

if (OPERATOR_ENV_BACKUP.founder === undefined) delete process.env.DEEPWELL_FOUNDER_TENANT_ID; else process.env.DEEPWELL_FOUNDER_TENANT_ID = OPERATOR_ENV_BACKUP.founder;
if (OPERATOR_ENV_BACKUP.ids === undefined) delete process.env.DEEPWELL_OPERATOR_USER_IDS; else process.env.DEEPWELL_OPERATOR_USER_IDS = OPERATOR_ENV_BACKUP.ids;

/* ------------------------------------------------------------------ done */

// Reviewer items (2026-09-22): amount ceiling + CSV formula-injection guard.
check('MAX_EXPENSE_CENTS is $1,000,000.00', MAX_EXPENSE_CENTS === 100_000_000);
{
  let threw = false;
  try { validateExpenseFields({ occurredOn: '2026-09-11', vendor: 'X', amount: '2,000,000.00', category: 'Other' }); } catch { threw = true; }
  check('validateExpenseFields rejects $2,000,000.00', threw);
  let ok = false;
  try { ok = validateExpenseFields({ occurredOn: '2026-09-11', vendor: 'X', amount: '999,999.99', category: 'Other' }).amountCents === 99999999; } catch { ok = false; }
  check('validateExpenseFields accepts $999,999.99', ok);
}
for (const bad of ['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)', '\tfoo']) {
  check(`csvEscapeField neutralizes formula prefix ${JSON.stringify(bad)}`, csvEscapeField(bad).replace(/^"/, '').startsWith("'"));
}
check('csvEscapeField leaves a plain vendor alone', csvEscapeField('Anthropic') === 'Anthropic');
check('csvEscapeField leaves a signed number ("-45.00", a refund) as data', csvEscapeField('-45.00') === '-45.00');

check('buildExpensesCsv: receipt_on_file is yes when a receipt key exists', csv0().includes(',receipt.pdf,yes\r\n'));
check('buildExpensesCsv: receipt_on_file is no when there is none', csv0().includes(',,no\r\n'));
function csv0() {
  return buildExpensesCsv([
    { occurred_on: '2026-09-11', vendor: 'A', amount_cents: 100, category: 'Other', note: null, receipt_filename: null, receipt_key: null },
    { occurred_on: '2026-09-12', vendor: 'B', amount_cents: 200, category: 'Other', note: null, receipt_filename: 'receipt.pdf', receipt_key: 'platform/expenses/x' },
  ]);
}

/* ------------------------------------------------ monthly running log */

{
  const rows = [
    { id: '1', occurred_on: '2026-09-20', amount_cents: 2166, category: 'AI & Cloud Services' },
    { id: '2', occurred_on: new Date(2026, 8, 13), amount_cents: 16810, category: 'AI & Cloud Services' }, // pg returns a Date
    { id: '3', occurred_on: '2026-09-01', amount_cents: 5000, category: 'Marketing' },
    { id: '4', occurred_on: '2026-09-02', amount_cents: 100, category: 'Other' },
    { id: '5', occurred_on: '2026-09-03', amount_cents: 50, category: 'Insurance' },
    { id: '6', occurred_on: '2026-07-04', amount_cents: 999, category: 'Insurance' },
    { id: '7', occurred_on: '2025-12-31', amount_cents: 7777, category: 'Other' }, // other year: excluded
    { id: '8', occurred_on: '2026-08-15', amount_cents: -500, category: 'Marketing' }, // refund
  ];
  const m = aggregateMonthly(rows, 2026);
  eq('monthly: months newest first (empty months omitted)', m.months.map((x) => x.month), ['2026-09', '2026-08', '2026-07']);
  eq('monthly: September total and count', [m.months[0].totalCents, m.months[0].count], [24126, 5]);
  eq('monthly: top 3 categories, highest first', m.months[0].topCategories.map((c) => c.category), ['AI & Cloud Services', 'Marketing', 'Other']);
  eq('monthly: category subtotal', m.months[0].topCategories[0].totalCents, 18976);
  eq('monthly: refunds net against the month', m.months[1].totalCents, -500);
  eq('monthly: year total equals sum of months and skips other years', m.yearTotalCents, 24126 - 500 + 999);
  eq('monthly: year count', m.yearCount, 7);
  eq('monthly: rows within a month newest first, Date normalized', m.months[0].items.map((r) => r.occurred_on), ['2026-09-20', '2026-09-13', '2026-09-03', '2026-09-02', '2026-09-01']);
  eq('monthly: a year with no rows -> empty log', aggregateMonthly(rows, 2024), { year: 2024, yearTotalCents: 0, yearCount: 0, months: [] });
  eq('ymdOf: string passes through, Date normalizes', [ymdOf('2026-09-11T00:00:00.000Z'), ymdOf(new Date(2026, 0, 5))], ['2026-09-11', '2026-01-05']);
  eq('monthRange: leap February', monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  eq('monthRange: rejects garbage', monthRange('2026-13'), null);
  eq('yearRange: 2026', yearRange('2026'), { from: '2026-01-01', to: '2026-12-31' });
  eq('yearRange: rejects garbage', yearRange('26'), null);
}

/* ------------------------------------------- receiptViewUrl + gating */

check('isOwnedReceiptKey: expense prefix ok', isOwnedReceiptKey('platform/expenses/abc'));
check('isOwnedReceiptKey: tenant object rejected', !isOwnedReceiptKey('tenants/t1/docs/abc'));
check('isOwnedReceiptKey: bare prefix and traversal rejected', !isOwnedReceiptKey('platform/expenses/') && !isOwnedReceiptKey('platform/expenses/../x'));
{
  let threw = false;
  try { validateExpenseFields({ occurredOn: '2026-09-11', vendor: 'X', amount: '1', category: 'Other', receiptKey: 'tenants/t1/secret' }); } catch { threw = true; }
  check('add/update reject a receiptKey outside platform/expenses/', threw);
  check('add/update accept an owned receiptKey', validateExpenseFields({ occurredOn: '2026-09-11', vendor: 'X', amount: '1', category: 'Other', receiptKey: 'platform/expenses/abc' }).receiptKey === 'platform/expenses/abc');
}

const ID = '11111111-1111-4111-8111-111111111111';
const fakeRes = () => {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
};
const call = async (auth, body, deps = {}) => {
  const res = fakeRes();
  await dispatchExpenses({ method: 'POST', headers: {}, body }, res, auth, { rateLimit: async () => true, ...deps });
  return res;
};
{
  process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder';
  delete process.env.DEEPWELL_OPERATOR_USER_IDS;
  const owner = { tenantId: 'org_founder', userId: 'u1' };
  const stranger = { tenantId: 'org_other_shop', userId: 'u2' };
  let dbTouched = false;
  const spyGet = async () => { dbTouched = true; return null; };
  const signed = [];
  const presignStub = (m, k, e) => { signed.push([m, k, e]); return `https://r2.test/${k}?sig=1`; };

  let r = await call(stranger, { op: 'receiptViewUrl', id: ID }, { getExpense: spyGet });
  check('receiptViewUrl: non-operator gets 403 before any DB work', r.code === 403 && !dbTouched);
  r = await call(stranger, { op: 'monthly', year: 2026 }, { listExpenses: async () => { dbTouched = true; return []; } });
  check('monthly: non-operator gets 403', r.code === 403 && !dbTouched);

  r = await call(owner, { op: 'receiptViewUrl', id: 'not-a-uuid' }, { getExpense: spyGet });
  check('receiptViewUrl: bad id -> 400', r.code === 400);
  r = await call(owner, { op: 'receiptViewUrl', id: ID }, { getExpense: async () => null, presign: presignStub });
  check('receiptViewUrl: unknown row -> 404', r.code === 404);
  r = await call(owner, { op: 'receiptViewUrl', id: ID }, { getExpense: async () => ({ id: ID, receipt_key: null }), presign: presignStub });
  check('receiptViewUrl: row without receipt -> 404', r.code === 404 && signed.length === 0);
  r = await call(owner, { op: 'receiptViewUrl', id: ID }, { getExpense: async () => ({ id: ID, receipt_key: 'tenants/t1/docs/secret' }), presign: presignStub });
  check('receiptViewUrl: foreign key in the row is rejected, never signed', r.code === 400 && signed.length === 0);
  r = await call(owner, { op: 'receiptViewUrl', id: ID }, { getExpense: async () => ({ id: ID, receipt_key: 'platform/expenses/abc', receipt_filename: 'r.pdf' }), presign: presignStub });
  check('receiptViewUrl: owned key -> short-lived presigned GET', r.code === 200 && r.body.url.includes('platform/expenses/abc') && r.body.filename === 'r.pdf' && signed[0][0] === 'GET' && signed[0][2] <= 600);
  const direct = await handleReceiptViewUrl({ id: ID }, { getExpense: async () => ({ receipt_key: 'platform/expenses/abc' }), presign: presignStub });
  check('handleReceiptViewUrl: exposes expiresIn', direct.expiresIn === 300);

  r = await call(owner, { op: 'monthly', year: 2026 }, { listExpenses: async () => [{ id: '1', occurred_on: '2026-09-11', amount_cents: 2166, category: 'Other' }] });
  check('monthly op: aggregates via the route', r.code === 200 && r.body.yearTotalCents === 2166 && r.body.months[0].month === '2026-09');
  r = await call(owner, { op: 'monthly', year: 'abc' }, { listExpenses: async () => [] });
  check('monthly op: bad year -> 400', r.code === 400);

  let seen = null;
  r = await call(owner, { op: 'exportCsv', month: '2026-09' }, { listExpenses: async (rg) => { seen = rg; return [{ occurred_on: new Date(2026, 8, 11), vendor: 'A', amount_cents: 2166, category: 'Other', receipt_key: 'platform/expenses/x', receipt_filename: 'a.jpg' }]; } });
  check('exportCsv: month scope resolves to that calendar month', seen?.from === '2026-09-01' && seen?.to === '2026-09-30');
  check('exportCsv: includes receipt filename and receipt_on_file', r.body.includes('receipt_on_file') && r.body.includes('a.jpg,yes') && r.body.startsWith('Date,'));
  check('exportCsv: filename reflects the month', /2026-09-01_to_2026-09-30/.test(r.headers['Content-Disposition']));
  r = await call(owner, { op: 'exportCsv', year: '2026' }, { listExpenses: async (rg) => { seen = rg; return []; } });
  check('exportCsv: year scope', seen?.from === '2026-01-01' && seen?.to === '2026-12-31');
  r = await call(owner, { op: 'exportCsv', month: 'garbage' }, { listExpenses: async () => [] });
  check('exportCsv: bad month -> 400', r.code === 400);
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
}

// Founder-org MEMBERSHIP gate (server-side; no client org switching).
{
  process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder';
  delete process.env.DEEPWELL_OPERATOR_USER_IDS;
  const other = { tenantId: 'org_other_shop', userId: 'u_member' };
  let lookups = 0;
  const memberLookup = async () => { lookups++; return ['org_x', 'org_founder']; };
  const nonMemberLookup = async () => { lookups++; return ['org_x']; };
  const errLookup = async () => { lookups++; throw new Error('clerk down'); };

  _resetFounderMemberCache();
  let r = await call(other, { op: 'operatorStatus' }, { membershipLookup: memberLookup });
  check('membership: founder-org member (other org active) -> operatorStatus true', r.code === 200 && r.body.isOperator === true);
  r = await call(other, { op: 'monthly', year: 2026 }, { membershipLookup: memberLookup, listExpenses: async () => [] });
  check('membership: founder-org member is allowed through the op gate', r.code === 200);
  check('membership: second call served from cache (one lookup)', lookups === 1);

  _resetFounderMemberCache(); lookups = 0;
  r = await call({ tenantId: 'org_other_shop', userId: 'u_non' }, { op: 'monthly', year: 2026 }, { membershipLookup: nonMemberLookup, listExpenses: async () => [] });
  check('membership: non-member -> 403', r.code === 403);
  r = await call({ tenantId: 'org_other_shop', userId: 'u_non' }, { op: 'operatorStatus' }, { membershipLookup: nonMemberLookup });
  check('membership: non-member operatorStatus false, and the negative result is cached', r.body.isOperator === false && lookups === 1);

  _resetFounderMemberCache();
  r = await call({ tenantId: 'org_other_shop', userId: 'u_err' }, { op: 'monthly', year: 2026 }, { membershipLookup: errLookup, listExpenses: async () => [] });
  check('membership: lookup error fails closed (403)', r.code === 403);
  r = await call({ tenantId: 'org_other_shop', userId: 'u_err' }, { op: 'operatorStatus' }, { membershipLookup: errLookup });
  check('membership: lookup error -> operatorStatus false', r.body.isOperator === false);

  _resetFounderMemberCache(); lookups = 0;
  process.env.DEEPWELL_FOUNDER_TENANT_ID = 'user_solo_founder';
  check('membership: non-org founder key -> no lookup, allowlist only', (await isExpensesOperator(other, { membershipLookup: memberLookup })) === false && lookups === 0);
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  check('membership: no founder configured -> false, no lookup', (await isExpensesOperator(other, { membershipLookup: memberLookup })) === false && lookups === 0);
  _resetFounderMemberCache();
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
