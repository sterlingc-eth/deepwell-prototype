/**
 * Checks for Team J's reasoning routers (api/_lib/compose.js, explain.js, trends.js, rankings.js).
 *
 * Part 1 (pure, no DB): every multi-hop/trend/ranking question SHAPE this file's own exam set uses
 * parses into the expected condition/intent — catches a regressed regex without ever touching Postgres.
 *
 * Part 2 (DB-backed, same PGlite-real-Postgres harness as scripts/verify-agent.mjs): a small seeded
 * world, checked end to end through classifyDeterministic -> runDeterministic (api/_lib/deterministicRouter.js),
 * exactly the path api/ask.js takes — so a wiring mistake there fails this too, not just the pure parse.
 *
 *   node scripts/verify-reasoning.mjs
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

const { parseCompose } = await import('../api/_lib/compose.js');
const { parseExplain } = await import('../api/_lib/explain.js');
const { parseTrends, periodBounds, truncPeriod, shiftPeriod } = await import('../api/_lib/trends.js');
const { parseRanking } = await import('../api/_lib/rankings.js');
const hvacPack = (await import('../api/_lib/industry/packs/hvac.js')).default;

/* ================================================================== 1. pure parse: compose.js */

const multiHop = [
  ['Which customers have a Trane unit older than 10 years and no maintenance agreement?', ['brand', 'ageOlder', 'lacksDocType']],
  ['How many Carrier customers don\'t have a maintenance agreement?', ['brand', 'lacksDocType']],
  ['Which customers have an expired warranty and no maintenance agreement?', ['warrantyStatus', 'lacksDocType']],
  ['How many customers have an expired warranty but do have a maintenance agreement?', ['warrantyStatus', 'hasDocType']],
  ['Which customers have a warranty expiring in the next year and no maintenance agreement?', ['warrantyStatus', 'lacksDocType']],
  ['How many customers in Mesa have no maintenance agreement?', ['geoCity', 'lacksDocType']],
  ['Which customers have a maintenance agreement but haven\'t had a service visit in the last 12 months?', ['hasDocType', 'lacksRecentService']],
  ['How many customers have more than one unit?', ['unitCountGt']],
  ['Which customers have units from two or more different brands?', ['distinctBrandsGte']],
  ['How many customers have been invoiced but never signed a maintenance agreement?', ['hasDocType', 'lacksDocType']],
  ['Which customers have no email but do have an expired warranty?', ['noEmail', 'warrantyStatus']],
  ['How many customers have a unit older than 15 years and a permit on file?', ['ageOlder', 'hasDocType']],
  ['How many customers with a Trane or Carrier unit have an active warranty?', ['brand', 'warrantyStatus']],
  ['Which customers have both a permit and a maintenance agreement on file?', ['hasDocType', 'hasDocType']],
  ['How many customers have a purchase order on file but no invoice?', ['hasDocType', 'lacksDocType']],
  ['Which customers with units older than 10 years have never had a service visit on file?', ['ageOlder', 'neverServiced']],
];
const sorted = (a) => [...a].sort();
for (const [q, wantTypes] of multiHop) {
  const parsed = parseCompose(q, hvacPack);
  const gotTypes = parsed?.conditions?.map((c) => c.type) ?? null;
  // Order doesn't matter (AND is commutative) - compare as a multiset, not a sequence.
  check(`compose parses: ${q}`, JSON.stringify(sorted(gotTypes ?? [])) === JSON.stringify(sorted(wantTypes)), `got ${JSON.stringify(gotTypes)}`);
  check(`compose op: ${q}`, parsed?.op === (/^how many/i.test(q) ? 'count' : 'list'));
}
check('compose rejects a single ordinary filter (leaves it to analytics.js)', parseCompose('How many customers have a maintenance agreement?', hvacPack) === null);
check('compose rejects unrelated text', parseCompose('What is the weather today?', hvacPack) === null);

/* ================================================================== 1b. pure parse: explain.js */

const explainCases = [
  ['Why is the Mercer unit flagged for a warranty alert?', 'warranty-alert', 'Mercer'],
  ["Explain what happened at Holbrook's last service visit", 'last-visit', 'Holbrook'],
  ['Why would Norwood need a follow-up?', 'follow-up', 'Norwood'],
];
for (const [q, kind, name] of explainCases) {
  const parsed = parseExplain(q);
  check(`explain parses: ${q}`, parsed?.kind === kind && parsed?.name === name, JSON.stringify(parsed));
}
check('explain rejects an unrelated "why" question', parseExplain('Why do we service Trane units?') === null);

/* ================================================================== 1c. pure parse: trends.js */

const trendCases = [
  ['Did we do more service calls last quarter than the quarter before?', 'compare', 'serviceCount', 'quarter'],
  ['Did we run more jobs last month than the month before?', 'compare', 'serviceCount', 'month'],
  ['Did we invoice more last month than the month before?', 'compare', 'invoiceSum', 'month'],
  ['Is invoiced revenue higher last quarter than the quarter before?', 'compare', 'invoiceSum', 'quarter'],
  ['Did we install more units last year than the year before?', 'compare', 'installCount', 'year'],
];
for (const [q, kind, metric, grain] of trendCases) {
  const parsed = parseTrends(q);
  check(`trends parses: ${q}`, parsed?.kind === kind && parsed?.metric === metric && parsed?.grain === grain, JSON.stringify(parsed));
}
check('trends: which month had the most', parseTrends('Which month had the most service calls this year?')?.kind === 'monthMax');
check('trends: monthly series', parseTrends('How have our monthly service calls changed this year?')?.kind === 'monthSeries');

// period arithmetic (pure)
check('truncPeriod month', truncPeriod('2026-09-25', 'month') === '2026-09-01');
check('truncPeriod quarter', truncPeriod('2026-09-25', 'quarter') === '2026-07-01');
check('shiftPeriod -1 month across year', shiftPeriod('2026-01-01', 'month', -1) === '2025-12-01');
{
  const [p0, p1] = periodBounds('2026-09-25', 'month');
  check('periodBounds month: last month is Aug, before is Jul', p0.from === '2026-08-01' && p0.to === '2026-09-01' && p1.from === '2026-07-01' && p1.to === '2026-08-01', JSON.stringify([p0, p1]));
}

/* ================================================================== 1d. pure parse: rankings.js */

const rankCases = [
  ['Which customer has the most units?', 'mostUnitsCustomer'],
  ['Which city has the most customers?', 'mostCustomersCity'],
  ["What's our most common brand?", 'mostCommonBrand'],
  ['Which brand do we have the fewest units of?', 'fewestBrand'],
  ['Which customer has the largest single invoice?', 'largestInvoiceCustomer'],
  ['How many technicians do we have on record?', 'techCount'],
  ['How many service jobs have no technician assigned?', 'jobsNoTech'],
  ["Who's our busiest technician this year?", 'busiestTechThisYear'],
];
for (const [q, kind] of rankCases) check(`ranking parses: ${q}`, parseRanking(q)?.kind === kind, JSON.stringify(parseRanking(q)));
check('ranking parses a named technician question', parseRanking('How many jobs has Danny Ochoa done in total?')?.kind === 'techTotalJobs');
check('ranking captures the technician name', parseRanking('How many jobs has Danny Ochoa done in total?')?.name === 'Danny Ochoa');

/* ================================================================== 2. harness: real Postgres via PGlite */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* see verify-agent.mjs: some are order-dependent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after dependency */ }

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

const TODAY = '2026-09-25';
const ctxA = { tenantKey: 'org_reasoning_a', tenantName: 'Desert Peak HVAC' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
// Hex-only prefix (uuid columns reject non-hex characters) - 'f' + the entity-kind letter, same idiom
// as verify-agent.mjs's own uid() but using hex-safe letters throughout.
const uid = (k, n) => `f${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function ent(id, type, data, extra = {}) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenA, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
}
async function doc(id, type, links, facts = []) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, tenA, `${id}.pdf`, type, `hash-${id}`, 'verified']);
  for (const l of links) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenA, id, l]);
  for (const f of facts) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenA, id, f.entity ?? null, f.key, f.value]);
}

const cKaren = uid('c', 1);
const cBill = uid('c', 2);
const cCarol = uid('c', 3);
await ent(cKaren, 'customer', { customer_name: 'Karen Abernathy', service_address: '412 Elm St, Mesa, AZ 85201', email: 'karen@example.com' }, { number: 'C-1' });
await ent(cBill, 'customer', { customer_name: 'Bill Whitmore', service_address: '88 Ash Ave, Mesa, AZ 85201', email: 'bill@example.com' }, { number: 'C-2' });
await ent(cCarol, 'customer', { customer_name: 'Carol Rios', service_address: '5 Oak Rd, Tucson, AZ 85701', email: 'carol@example.com' }, { number: 'C-3' });

await ent(uid('e', 1), 'equipment', { manufacturer: 'Trane', model: 'XR14', equipment_type: 'condenser', installation_date: '2010-01-01', service_address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2020-01-01' } }, { customerId: cKaren });
await ent(uid('e', 2), 'equipment', { manufacturer: 'Goodman', model: 'GSX14', equipment_type: 'condenser', installation_date: '2021-01-01', service_address: '412 Elm St, Mesa, AZ 85201' }, { customerId: cKaren });
await ent(uid('e', 3), 'equipment', { manufacturer: 'Trane', model: 'XR16', equipment_type: 'condenser', installation_date: '2019-01-01', service_address: '88 Ash Ave, Mesa, AZ 85201', warranty: { expires: '2031-01-01' } }, { customerId: cBill });
await ent(uid('e', 4), 'equipment', { manufacturer: 'Carrier', model: '24ACC6', equipment_type: 'condenser', installation_date: '2005-01-01', service_address: '5 Oak Rd, Tucson, AZ 85701' }, { customerId: cCarol });

await doc(uid('d', 1), 'service-ticket', [cKaren], [{ key: 'service_date', value: '2026-08-05' }, { key: 'technician', value: 'D. Ramirez' }]);
await doc(uid('d', 2), 'service-ticket', [cKaren], [{ key: 'service_date', value: '2026-08-15' }, { key: 'technician', value: 'D. Ramirez' }]);
await doc(uid('d', 3), 'service-ticket', [cBill], [{ key: 'service_date', value: '2026-08-20' }, { key: 'technician', value: 'M. Ortiz' }]);
await doc(uid('d', 4), 'service-ticket', [cCarol], [{ key: 'service_date', value: '2026-07-10' }, { key: 'technician', value: 'D. Ramirez' }]);
await doc(uid('d', 5), 'maintenance-agreement', [cBill], [{ key: 'agreement_term', value: '01/01/2026 - 12/31/2026' }]);

const ctxArg = ctxA;
const runQ = async (q) => {
  const intent = classifyDeterministic(q);
  if (!intent) return null;
  return withTenant(ctxArg, (db) => runDeterministic(db, intent, { today: TODAY }));
};

/* ---- compose.js end to end ---- */
{
  const data = await runQ('Which customers have a Trane unit older than 10 years and no maintenance agreement?');
  check('compose e2e: routes to an answer', Boolean(data), 'no data returned — check the compose gate/parse');
  check('compose e2e: names Karen Abernathy', Boolean(data?.text?.includes('Karen Abernathy')), data?.text);
  check('compose e2e: does not name Bill Whitmore (has an agreement)', !data?.text?.includes('Bill Whitmore'), data?.text);
  check('compose e2e: carries records/basis', Array.isArray(data?.records) && typeof data?.basis === 'string' && data.basis.length > 0, JSON.stringify({ records: data?.records, basis: data?.basis }));
}

/* ---- explain.js end to end ---- */
{
  const data = await runQ('Why is the Abernathy unit flagged for a warranty alert?');
  check('explain e2e: routes to an answer', Boolean(data));
  check('explain e2e: mentions the expired Trane unit', Boolean(data?.text?.includes('Trane') && data?.text?.includes('expired')), data?.text);
}

/* ---- trends.js end to end ---- */
{
  const data = await runQ('Did we run more jobs last month than the month before?');
  check('trends e2e: routes to an answer', Boolean(data));
  check('trends e2e: Yes (3 in Aug vs 1 in Jul)', Boolean(data?.text?.startsWith('Yes')), data?.text);
}

/* ---- rankings.js end to end ---- */
{
  const data = await runQ('Which customer has the most units?');
  check('rankings e2e: routes to an answer', Boolean(data));
  check('rankings e2e: Karen Abernathy has 2 units', Boolean(data?.text?.includes('Karen Abernathy') && data?.text?.includes('2')), data?.text);
}

/* ---- tech-performance e2e ---- */
{
  const total = await runQ('How many jobs has D. Ramirez done in total?');
  check('tech-performance e2e: total jobs = 3', Boolean(total?.text?.includes('3')), total?.text);
  const custs = await runQ('How many different customers has D. Ramirez worked for?');
  check('tech-performance e2e: 2 different customers (Karen + Carol)', Boolean(custs?.text?.includes('2')), custs?.text);
  const count = await runQ('How many technicians do we have on record?');
  check('tech-performance e2e: 2 technicians on record', Boolean(count?.text?.includes('2')), count?.text);
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
