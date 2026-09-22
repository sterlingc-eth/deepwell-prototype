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
} from '../api/_lib/expensesStore.js';
import { validateExpenseFields } from '../api/_lib/routes/expenses.js';
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
    { occurred_on: '2026-09-11', vendor: 'Anthropic', amount_cents: 2166, currency: 'USD', category: 'AI & Cloud Services', note: 'Claude Max 20 — $200/mo, prorated', receipt_filename: null },
    { occurred_on: '2026-09-13', vendor: 'Acme, Inc.', amount_cents: 16810, currency: 'USD', category: 'Software & Subscriptions', note: null, receipt_filename: 'receipt.pdf' },
  ];
  const csv = buildExpensesCsv(rows);
  check('buildExpensesCsv: starts with the header row', csv.startsWith('Date,Vendor,Amount,Currency,Category,Note,Receipt Filename\r\n'));
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

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
