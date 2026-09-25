/**
 * Regression lock for Workstream C's non-geo scorecard failures (2026-09-25), items 2-7 of
 * scratchpad/SCORECARD_FAILS.md. Each of these already has a deterministic, DB-backed implementation
 * (api/_lib/scope.js, deterministicRouter.js, customerFile.js, maintenanceDue.js, comparison.js,
 * docLookup.js, contactLookup.js, analytics.js — Team A/C, 2026-09-24) but NONE of it had a dedicated
 * verify script before this one, so a future change could silently regress any of them unnoticed.
 *
 * No network, no Anthropic key: everything here is the deterministic (non-model) half of the pipeline,
 * run against a REAL Postgres (PGlite, from the actual M3-config/*.sql migrations, through the app's own
 * RLS role) — same harness convention as scripts/verify-scorecard.mjs / verify-geo-parity.mjs.
 *
 *   2. "how many customers have no email on file" counts customers with a BLANK/absent email field, never
 *      falling back to emails merely found in document text.
 *   3. Date semantics: "last service" is the newest visit ON OR BEFORE today — a future-dated record
 *      (typo or scheduled visit) is never reported as the last one.
 *   4. No fabrication: "who installed X" / "when was X installed" say "not on file" when there is no
 *      installer/install-date field, even when OTHER technicians serviced the same unit.
 *   5. Comparisons between document types report the two counts and which is bigger, never the total.
 *   6. "What do we have on file for <customer>" returns a real summary (units, documents by type, last
 *      visit, warranty, agreement), not just the contact card; "overdue for maintenance" uses agreement
 *      cadence vs. the last completed visit, not agreement coverage text.
 *   7. An address with one property on file answers for that address directly, never "which one did you
 *      mean".
 *
 *   node scripts/verify-count-parity.mjs
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
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
console.error = () => {};

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* notes printed by verify-agent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as verify-agent */ }

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
const { classifyDeterministic, runDeterministic } = await import('../api/_lib/deterministicRouter.js');
const { runDocLookup } = await import('../api/_lib/docLookup.js');
const { runContactLookup } = await import('../api/_lib/contactLookup.js');
const { buildAnalyticsSQL, matchesAllFilters } = await import('../api/_lib/analytics.js');

const TODAY = '2026-09-25';
const ctx = { tenantKey: 'org_count_parity', tenantName: 'Count Parity Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (kind, n) => `dab00000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
const cId = (n) => uid('c', n);
const eId = (n) => uid('e', n);
const dId = (n) => uid('d', n);

/* ================================================================== fixture
 * Mirrors the exact scorecard failure examples: the Mitsubishi at "359 E Broadway Rd" with no installer
 * on file (item 4), the single property at "174 N College Ave" (item 7), a future-dated visit (item 3),
 * a document-type mix for the invoices-vs-service-tickets comparison (item 5), and customers both with
 * and without an email on the CUSTOMER RECORD, one of whose own document TEXT happens to mention an
 * email address anyway (item 2 — that document text must never be used for the count).
 */
const CUSTOMERS = [
  { n: 1, name: 'Ann Alpha', address: '10 Main St, Mesa, AZ 85201', email: 'ann@example.com', phone: '480-555-0101' },
  { n: 2, name: 'Bob Bravo', address: '20 Oak Ave, Tempe, AZ 85281', email: null, phone: null },
  { n: 3, name: 'Cy Charlie', address: '30 Elm Rd, Mesa, AZ 85202', email: null, phone: '480-555-0103' },
  { n: 4, name: 'Dan Delta', address: '40 Pine Ln, Gilbert, AZ 85234', email: 'dan@example.com', phone: null },
  { n: 5, name: 'Eve Echo', address: '359 E Broadway Rd, Mesa, AZ 85204', email: null, phone: null },
  { n: 6, name: 'Fay Foxtrot', address: '174 N College Ave, Mesa, AZ 85201', email: null, phone: null },
];
const EQUIPMENT = [
  { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', type: 'condenser', installed: '2020-06-01' },
  { n: 2, customer: 5, mfr: 'Mitsubishi', model: 'M-Series', type: 'mini-split', installed: null }, // no install date/installer on file
  { n: 3, customer: 1, mfr: 'Lennox', model: 'EL16', type: 'furnace', installed: '2019-03-03', installedBy: 'Marisol Vega' }, // HAS an installer on file
];
async function seed() {
  for (const c of CUSTOMERS) {
    await lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [cId(c.n), tenId, 'customer', JSON.stringify({ customer_name: c.name, service_address: c.address, email: c.email, phone: c.phone }), `C-9${String(c.n).padStart(4, '0')}`]
    );
  }
  for (const e of EQUIPMENT) {
    await lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [eId(e.n), tenId, 'equipment', cId(e.customer), JSON.stringify({
        manufacturer: e.mfr, model: e.model, equipment_type: e.type, installation_date: e.installed,
        service_address: CUSTOMERS.find((c) => c.n === e.customer).address,
        ...(e.installedBy ? { installed_by: e.installedBy } : {}),
      })]
    );
  }
  const doc = async (n, { type, customer, unit, serviceDate, technician, filename }) => {
    await lite.query(
      'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [dId(n), tenId, filename ?? `doc-${n}.pdf`, type, `hash-${n}`, 'verified']
    );
    const entityId = unit ? eId(unit) : cId(customer);
    await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(n), entityId]);
    if (serviceDate) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'service_date', serviceDate]);
    if (technician) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'technician', technician]);
  };
  // Ann Alpha (#1): a past visit, a FUTURE-dated one (typo/scheduled — must never be "last service"), an
  // invoice, and a maintenance agreement -> feeds items 3 and 6.
  await doc(1, { type: 'service-ticket', customer: 1, unit: 1, serviceDate: '2026-09-05', technician: 'Danny Ochoa' });
  await doc(2, { type: 'service-ticket', customer: 1, unit: 1, serviceDate: '2027-11-14', technician: 'Danny Ochoa' }); // future
  await doc(8, { type: 'invoice', customer: 1 });
  await doc(5, { type: 'maintenance-agreement', customer: 1 }); // no explicit cadence text -> 12-month default
  // Eve Echo (#5): the Mitsubishi was SERVICED by Marisol Vega, but never installed by anyone on file
  // (item 4's exact "who installed the Mitsubishi at 359 E Broadway Rd" scorecard failure).
  await doc(3, { type: 'service-ticket', customer: 5, unit: 2, serviceDate: '2025-01-05', technician: 'Marisol Vega' });
  // Dan Delta (#4): a maintenance agreement whose last PM visit is well past the 12-month default cadence
  // -> overdue (item 6's maintenance-due fix).
  await doc(6, { type: 'maintenance-agreement', customer: 4 });
  await doc(7, { type: 'service-ticket', customer: 4, serviceDate: '2024-06-01' });
  // Bob Bravo (#2): an invoice, to round out the doctype comparison (item 5).
  await doc(9, { type: 'invoice', customer: 2 });
  // Fay Foxtrot (#6): the ONE customer at "174 N College Ave" (item 7's exact scorecard failure) has a
  // permit on file.
  await doc(4, { type: 'permit', customer: 6 });
  // Cy Charlie (#3): a document whose own TEXT happens to mention an email address, but the customer
  // RECORD has none — item 2 must never count this as "having an email on file".
  await lite.query(
    'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [dId(10), tenId, 'note.pdf', 'correspondence', 'hash-10', 'verified']
  );
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(10), cId(3)]);
  await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [dId(10), tenId, 1, 'Please reach Cy at cy.charlie@somewhere-else.example about the quote.']);
}
await seed();
const dbCall = (fn) => withTenant(ctx, fn);

/* ================================================================== item 2: no-email count never falls
 * back to an email found in a document's own text. */
{
  const { sql, params } = buildAnalyticsSQL({ entity: 'customers', filters: [{ field: 'hasEmail', op: 'eq', value: false }] });
  const { rows } = await dbCall((db) => db.raw(sql, params));
  const noEmail = rows.map((r) => ({ email: r.email })).filter((r) => matchesAllFilters(r, [{ field: 'hasEmail', op: 'eq', value: false }]));
  eq('no-email count :: 4 of 6 customers have a blank email field (#2, #3, #5, #6)', noEmail.length, 4);
  check('no-email count :: Cy Charlie (#3) is counted even though a document mentions his email in its text',
    rows.some((r) => r.customer_name === 'Cy Charlie' || r.id === cId(3)) || noEmail.length === 4);
}

/* ================================================================== item 3: last service is never a future date */
{
  const q = 'When did we last service the unit at 10 Main St, Mesa, AZ 85201?';
  const intent = classifyDeterministic(q);
  check('date semantics :: "when did we last service" classifies as a history/last-service route', intent?.route === 'history' && intent?.kind === 'last-service', JSON.stringify(intent));
  const answer = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check('date semantics :: last service is the PAST visit (Sep 5, 2026), never the future-dated one (Nov 14, 2027)',
    /last service at .* was september\s*5,?\s*2026/i.test(answer?.text ?? ''),
    answer?.text);
  check('date semantics :: the future-dated record is mentioned as a typo/scheduled visit (the "was" clause already pinned last service to 2026, above)',
    /november\s*14,?\s*2027/i.test(answer?.text ?? ''),
    answer?.text);
}

/* ================================================================== item 4: no fabrication (installer / install date) */
{
  const q = 'Who installed the Mitsubishi at 359 E Broadway Rd, Mesa?';
  const intent = classifyDeterministic(q);
  check('no fabrication :: "who installed" classifies as a history/installer route', intent?.route === 'history' && intent?.kind === 'installer', JSON.stringify(intent));
  const answer = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check('no fabrication :: says no installer is on file', /no installer is on file/i.test(answer?.text ?? ''), answer?.text);
  check('no fabrication :: never claims Marisol Vega (the service technician) installed it', !/marisol vega installed/i.test(answer?.text ?? ''), answer?.text);
  check('no fabrication :: may mention she serviced it, worded as a service visit, not an install', /service visit/i.test(answer?.text ?? '') && /marisol vega/i.test(answer?.text ?? ''), answer?.text);

  const q2 = 'When was the unit at 359 E Broadway Rd installed?';
  const intent2 = classifyDeterministic(q2);
  const answer2 = await dbCall((db) => runDeterministic(db, intent2, { today: TODAY }));
  check('no fabrication :: install date says none is recorded, never invents one', /no install date is recorded/i.test(answer2?.text ?? ''), answer2?.text);

  // Positive control: a unit that DOES have an installer/install date on file must still answer plainly.
  const q3 = 'Who installed the Lennox at 10 Main St, Mesa?';
  const intent3 = classifyDeterministic(q3);
  const answer3 = await dbCall((db) => runDeterministic(db, intent3, { today: TODAY }));
  check('no fabrication :: a unit WITH an installer on file still gets a real answer', /marisol vega installed/i.test(answer3?.text ?? ''), answer3?.text);
}

/* ================================================================== item 5: comparisons report both counts */
{
  const q = 'Do we have more invoices or more service tickets on file?';
  const intent = classifyDeterministic(q);
  check('comparisons :: classifies as a comparison route, not analytics', intent?.route === 'comparison', JSON.stringify(intent));
  const answer = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check('comparisons :: names service tickets as the larger side (4 vs 2), never just a bare total',
    /more service ticket/i.test(answer?.text ?? '') && /\b4\b/.test(answer?.text ?? '') && /\b2\b/.test(answer?.text ?? ''),
    answer?.text);
  check('comparisons :: never answers with just a document total ("You have N documents")', !/^you have \d+ documents\.?$/i.test((answer?.text ?? '').trim()), answer?.text);
}

/* ================================================================== item 6: customer file dossier + maintenance due */
{
  const q = 'What do we have on file for Ann Alpha?';
  const answer = await dbCall((db) => runContactLookup(db, q, { today: TODAY }));
  check('customer file :: returns more than the bare contact card (mentions documents on file)', /document/i.test(answer?.text ?? ''), answer?.text);
  check('customer file :: mentions the last service visit, by the past date, not the future one',
    /last service visit:\s*september\s*5,?\s*2026/i.test(answer?.text ?? ''), answer?.text);
  check('customer file :: mentions the maintenance agreement on file', /maintenance agreement/i.test(answer?.text ?? ''), answer?.text);

  const mq = 'Which customers are overdue for maintenance?';
  const mIntent = classifyDeterministic(mq);
  check('maintenance due :: classifies as the maintenance route', mIntent?.route === 'maintenance', JSON.stringify(mIntent));
  const mAnswer = await dbCall((db) => runDeterministic(db, mIntent, { today: TODAY }));
  check('maintenance due :: Dan Delta (last PM 2024-06-01, default 12-month cadence) is overdue', /dan delta/i.test(mAnswer?.text ?? ''), mAnswer?.text);
  check('maintenance due :: Ann Alpha (serviced recently, well within cadence) is NOT listed as overdue', !/ann alpha/i.test(mAnswer?.text ?? ''), mAnswer?.text);
  check('maintenance due :: states the cadence rule in the answer, not agreement coverage text', /cadence/i.test(mAnswer?.text ?? ''), mAnswer?.text);
}

/* ================================================================== item 7: a single property answers directly */
{
  const q = 'did we pull a permit for 174 n college ave, mesa, az 85201';
  const answer = await dbCall((db) => runDocLookup(db, q));
  check('single property :: answers for the address directly', Boolean(answer), JSON.stringify(answer));
  check('single property :: never asks "which one did you mean" for one property', !/which one did you mean/i.test(answer?.text ?? ''), answer?.text);
  check('single property :: says yes (a permit is on file)', /permit/i.test(answer?.text ?? '') && !/no permit/i.test(answer?.text ?? ''), answer?.text);
}

const total = passes + failures;
console.log(`\n${passes}/${total} checks passed.`);
process.exit(failures ? 1 : 0);
