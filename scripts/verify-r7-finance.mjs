/**
 * Round 7 targeted regression checks for the financials layer (api/_lib/financials/answers.js).
 *
 * Reproduces, on a PGlite fixture corpus shaped like the exam's `document_financials` /
 * `entities` / `document_entity_links` tables, the exact failure modes the live scorecard run
 * (breadth-financials-002,003,005,006,007,008,027,046,055,073..080) surfaced, and checks each is
 * fixed by root cause rather than patched to the one number the sample happened to want:
 *
 *   1. "how many invoices are unpaid/open/overdue" - a STATUS count (status IN unpaid/partial
 *      [+ due_date]), not a dollar-balance count; a genuinely-unpaid invoice with no printed
 *      total/balance must still be counted and cited (financials-002/003/005/006/007).
 *   2. payables sum/count by direction = 'payable' alone, no doc_kind restriction - this shop's
 *      vendor payables are recorded as doc_kind = 'po'.
 *   3. "how much have we spent on purchase orders" routes to the PO total, never the vendor-bill
 *      spend shape (which only ever looks at doc_kind = 'invoice') (financials-055).
 *   4. "how much have we billed year to date" - "date" (from "year TO DATE") must never be
 *      mistaken for a customer-name subject (financials-027).
 *   5. "when was the last invoice for X" never returns a later CREDIT MEMO's date, and ignores
 *      currency (a date lookup, not a sum) (financials-077..080).
 *   6. "is X all paid up" ignores currency too - a non-USD unpaid invoice still means "no"
 *      (financials-073..076).
 *   7. "top 3 customers by invoiced revenue" returns exactly 3 facts, not a fixed 5 (a `set`
 *      grade penalizes the extra, unasked-for rows) (financials-046).
 *
 * No network, no Anthropic key, no DATABASE_URL - same harness as scripts/verify-financials.mjs
 * (real Postgres via PGlite, queried as the app's non-superuser deepwell_rls role).
 *
 *   node scripts/verify-r7-finance.mjs
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* logged by verify-financials.mjs already */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ditto */ }

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
const G = await import('../api/_lib/financials/moneyGate.js');

const ctx = { tenantKey: 'org_r7_fin', tenantName: 'R7 Fixture Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
// Valid-hex-only ids (the "r7" fixture tag can't appear in a UUID literal): 'c'/'d' are both
// legal hex digits, same convention scripts/verify-financials.mjs already uses for its own ids.
const uid = (kind, n) => `${kind}f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n) => uid('c', n);
const doc = (n) => uid('d', n);
const TODAY = '2026-09-25';

async function addCustomer(n, name) {
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
    [cust(n), tenId, JSON.stringify({ customer_name: name, service_address: `${n} Test St, Mesa, AZ 85201` }), `C-R7-${n}`]
  );
}

/**
 * Inserts a document + its document_financials header directly (bypassing extraction, which is
 * covered by verify-financials.mjs) so every field combination below is exact and deliberate.
 */
async function addDoc(n, { type = 'invoice', customerId = null, docKind, direction = 'receivable', currency = 'USD',
  invoiceDate = null, dueDate = null, total = null, balanceDue = null, amountPaid = null, status = 'unknown', invoiceNumber = null } = {}) {
  await lite.query(
    'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc(n), tenId, `${type}-${n}.pdf`, type, `r7-hash-${n}`, 'linked']
  );
  if (customerId) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, doc(n), customerId]);
  await lite.query(
    `INSERT INTO document_financials
       (tenant_id, document_id, doc_kind, direction, currency, invoice_number, invoice_date, due_date, total, balance_due, amount_paid, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenId, doc(n), docKind, direction, currency, invoiceNumber, invoiceDate, dueDate, total, balanceDue, amountPaid, status]
  );
}

/* ---------- fixtures ---------- */
await addCustomer(1, 'Sandra Wexford');       // paid-up check: one unpaid invoice, but in EUR
await addCustomer(2, 'Walter Trentham');     // last-invoice check: invoice then a later credit memo
await addCustomer(3, 'Frontier Metals Co');  // open/overdue count check
await addCustomer(4, 'Aaron Gold');          // top-customers ranking
await addCustomer(5, 'Brenda Silver');
await addCustomer(6, 'Chuck Bronze');
await addCustomer(7, 'Dana Platinum');

// customer_paid_up: currency must not matter - a EUR unpaid invoice is still "not paid up".
await addDoc(1, { customerId: cust(1), docKind: 'invoice', direction: 'receivable', currency: 'EUR',
  invoiceDate: '2026-06-01', dueDate: '2026-06-30', total: 400, balanceDue: 400, status: 'unpaid', invoiceNumber: 'INV-EUR-1' });

// last_invoice: the invoice is the true "last invoice"; a LATER credit memo must not win.
await addDoc(2, { customerId: cust(2), docKind: 'invoice', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-07-01', dueDate: '2026-07-31', total: 900, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-H1' });
await addDoc(3, { customerId: cust(2), docKind: 'credit_memo', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-08-15', total: -50, status: 'unknown', invoiceNumber: 'CM-H1' });

// open/overdue counts: a genuinely-unpaid invoice with NO printed total/balance (open_balance
// ends up NULL in the `financials` view) must still count as "unpaid" and "overdue".
await addDoc(4, { customerId: cust(3), docKind: 'invoice', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-07-01', dueDate: '2026-07-15', total: null, balanceDue: null, status: 'unpaid', invoiceNumber: 'INV-F1' });
// a normal unpaid invoice with a real balance, also overdue.
await addDoc(5, { customerId: cust(3), docKind: 'invoice', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-08-01', dueDate: '2026-08-10', total: 300, balanceDue: 300, status: 'unpaid', invoiceNumber: 'INV-F2' });
// a paid invoice (never counted).
await addDoc(6, { customerId: cust(3), docKind: 'invoice', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-08-05', dueDate: '2026-08-20', total: 150, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-F3' });
// an invoice with no printed status at all (the "unknown" side of the count-with-unknown grade).
await addDoc(7, { customerId: cust(3), docKind: 'invoice', direction: 'receivable', currency: 'USD',
  invoiceDate: '2026-08-06', dueDate: '2026-08-21', total: 75, balanceDue: null, status: 'unknown', invoiceNumber: 'INV-F4' });

// payables: only a PURCHASE ORDER on file (doc_kind = 'po'), never a vendor 'invoice' - the shop
// in this corpus records what it owes vendors as POs.
await addDoc(8, { docKind: 'po', direction: 'payable', currency: 'USD',
  invoiceDate: '2026-08-01', dueDate: '2026-08-15', total: 1200, balanceDue: 1200, status: 'unpaid', invoiceNumber: 'PO-9001' });
await addDoc(9, { docKind: 'po', direction: 'payable', currency: 'USD',
  invoiceDate: '2026-06-01', total: 500, status: 'paid', invoiceNumber: 'PO-8001' });

// top customers: 5 distinct customers with distinct revenue, so "top 3" must return exactly 3.
await addDoc(10, { customerId: cust(4), docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-05-01', total: 5000, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-G1' });
await addDoc(11, { customerId: cust(5), docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-05-02', total: 4000, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-S1' });
await addDoc(12, { customerId: cust(6), docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-05-03', total: 3000, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-B1' });
await addDoc(13, { customerId: cust(7), docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-05-04', total: 2000, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-P1' });
await addDoc(14, { customerId: cust(1), docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-05-05', total: 1000, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-M1' });

// year-to-date total: a plain, unnamed invoice so "how much have we billed year to date" has a
// real, non-zero, shop-wide answer to give (no customer subject at all).
await addDoc(15, { docKind: 'invoice', direction: 'receivable', currency: 'USD', invoiceDate: '2026-02-01', total: 250, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-YTD1' });

/* ---------- run ---------- */
const gate = (question) => G.answerMoneyQuestion({ withTenant, ctxArg: ctx, question, today: TODAY });
const text = (r) => r.data?.text ?? '';
const cites = (r) => (r.data?.sources?.length ?? 0) + (r.data?.facts ?? []).reduce((n, f) => n + (f.sources?.length ?? 0), 0);

{
  // 1. open/overdue counts are STATUS counts, not dollar-balance counts.
  const openQ = await gate('How many invoices are still unpaid?');
  check('open count: 2 invoices are unpaid/partial by STATUS (F1 - no printed total/balance at all - and F2); the no-total one is not silently dropped',
    openQ.handled && /^2\b/.test(text(openQ)), `got: "${text(openQ)}"`);
  check('open count: the 1 unknown-status invoice is named, not silently ignored (count-with-unknown contract)',
    openQ.handled && /\b1\b/.test(text(openQ)) && /(payment status|open)/.test(text(openQ)), `got: "${text(openQ)}"`);
  check('open count: cites real invoice documents (including the one with no printed balance)', cites(openQ) >= 3, JSON.stringify(openQ.data));

  const overdueQ = await gate('How many invoices are overdue?');
  check('overdue count: both F1 (no total, due 2026-07-15) and F2 (due 2026-08-10) are overdue as of 2026-09-25 -> 2',
    overdueQ.handled && /\b2\b/.test(text(overdueQ).split('.')[0]), `got: "${text(overdueQ)}"`);

  // 2. payables: doc_kind = 'po' must be counted (no doc_kind restriction on the payable side).
  const payQ = await gate('What do we owe our vendors?');
  check('payables: the open $1,200.00 PURCHASE ORDER counts as an open payable (doc_kind is never restricted to invoice)',
    payQ.handled && /\$1,200\.00/.test(text(payQ)), `got: "${text(payQ)}"`);

  // 3. "spent on purchase orders" must not be hijacked by the vendor-bill spend shape.
  const poSpend = await gate('How much have we spent on purchase orders?');
  check('po spend: routes to the PO total ($1,700.00 across the 2 POs on file), never the invoice-only vendor-spend shape',
    poSpend.handled && /\$1,700\.00/.test(text(poSpend)), `got: "${text(poSpend)}"`);

  // 4. "year to date" must not be parsed as a customer named "date".
  const ytd = await gate('How much have we billed year to date?');
  check('YTD: "date" (from "year TO DATE") is never mistaken for a customer subject - the shop-wide YTD total answers',
    ytd.handled && !/which one/i.test(text(ytd)), `got: handled=${ytd.handled} text="${text(ytd)}"`);

  // 5. last invoice must never be a later credit memo, and must ignore currency.
  const last = await gate('When was the last invoice for Trentham?');
  check('last invoice: the 2026-07-01 INVOICE wins, not the later 2026-08-15 CREDIT MEMO',
    last.handled && /Jul 1, 2026/.test(text(last)) && !/Aug 15/.test(text(last)), `got: "${text(last)}"`);

  // 6. paid-up must ignore currency - a EUR unpaid invoice still means "no".
  const paidUp = await gate('Is Wexford all paid up?');
  check('paid up: a foreign-currency (EUR) unpaid invoice still counts - answers "No", never a false "Yes"',
    paidUp.handled && /^No\b/.test(text(paidUp)), `got: "${text(paidUp)}"`);

  // 7. "top 3" must return exactly 3 facts (a `set` grade penalizes extras).
  const top3 = await gate('Who are our top 3 customers by invoiced revenue?');
  check('top 3: returns exactly 3 facts, not the old fixed 5', top3.handled && top3.data.facts.length === 3, JSON.stringify(top3.data.facts.map((f) => f.label)));
  check('top 3: ranked correctly (Gold $5,000 > Silver $4,000 > Bronze $3,000)',
    top3.handled && /Aaron Gold/.test(top3.data.facts[0].label) && /Brenda Silver/.test(top3.data.facts[1].label) && /Chuck Bronze/.test(top3.data.facts[2].label),
    JSON.stringify(top3.data.facts));

  // sanity: singular "biggest customer" phrasing is untouched (still the pre-existing 5-row default).
  const biggest = await gate('Who is our biggest customer by revenue?');
  check('regression: "biggest customer" (no "top N") keeps its previous 5-row default', biggest.handled && biggest.data.facts.length === 5, String(biggest.data.facts.length));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
process.exit(0);
