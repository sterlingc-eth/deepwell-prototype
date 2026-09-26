/**
 * Round 7 (Workstream A) regression lock — R7_MEASURE.md's items 1-4, offline (PGlite/mocked, no network, no
 * model call), same harness convention as scripts/verify-round6.mjs / verify-reasoning.mjs.
 *
 *   1. condition-drop guard — a question with a qualifying clause no deterministic plan can express (a
 *      repeat-visit/callback time window, a ratio/percentage) must fall through rather than silently answering
 *      the question with the clause dropped (analytics.js's detectedConditions + routes/analytics.js's up-front
 *      unsupported-condition branches, decided before any cache lookup or model call).
 *   2. existence yes/no shape — "do we have any X" leads with Yes/No (routes/analytics.js's applyExistenceShape),
 *      applied to the outgoing response only, never baked into the analytics cache row.
 *   3. citation contract — every rankings.js handler (geo/brand/doctype AND tech-performance) attaches real
 *      records + a basis sentence, not a bare answer.
 *   4. maintenance-due — the oracle's flat 365-day, visit-required definition: a customer is a candidate the
 *      moment they have any qualifying visit (no agreement needed), overdue is decided purely against a flat
 *      12-month cutoff, and an agreement's own stated cadence never changes the decision (only the wording).
 *
 *   node scripts/verify-r7-guardrails.mjs
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
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
console.error = () => {};

const {
  detectedConditions, CONDITION_CROSS_VISIT_RELATION, CONDITION_RATIO,
  isExistenceQuestion, existenceWrap,
} = await import('../api/_lib/analytics.js');
const { applyExistenceShape } = await import('../api/_lib/routes/analytics.js');

/* ================================================================== item 1: condition-drop guard (pure) */

const dropPhrasings = [
  'How many Trane units had a repeat visit within 90 days of installation?',
  'Which customers had a callback within 30 days of their last service?',
  'How many jobs led to a repeat visit within 2 weeks?',
  'Did any Carrier units get a callback within 60 days of the original job?',
];
for (const q of dropPhrasings) {
  check(`item 1 :: detects the dropped clause :: "${q}"`, detectedConditions(q).has(CONDITION_CROSS_VISIT_RELATION));
}
const ratioPhrasings = [
  'What percentage of customers have an active maintenance agreement?',
  'What is the ratio of Trane units to Carrier units?',
  'What proportion of jobs were completed by Danny Ochoa?',
];
for (const q of ratioPhrasings) {
  check(`item 1 :: detects a ratio/percentage clause :: "${q}"`, detectedConditions(q).has(CONDITION_RATIO));
}
const plainPhrasings = [
  'How many Trane units do we have?',
  'Which customers have a maintenance agreement?',
  'How many service tickets did we close last month?',
];
for (const q of plainPhrasings) {
  const found = detectedConditions(q);
  check(`item 1 negative :: plain question never flags a dropped condition :: "${q}"`,
    !found.has(CONDITION_CROSS_VISIT_RELATION) && !found.has(CONDITION_RATIO), JSON.stringify([...found]));
}

// The up-front branches in routes/analytics.js must decide BEFORE any DB/tenant call — same idiom as the
// existing 'money'/'maintenance' branches (see runAnalyticsQuestion's own comment). A withTenant that throws
// proves this: reaching it would mean the guard let a dropped-condition question fall through to the planner.
{
  const { runAnalyticsQuestion } = await import('../api/_lib/routes/analytics.js');
  const explodingWithTenant = async () => { throw new Error('must not touch the database for a dropped-condition question'); };
  for (const q of [dropPhrasings[0], ratioPhrasings[0]]) {
    const res = await runAnalyticsQuestion({ withTenant: explodingWithTenant, ctxArg: {}, question: q, today: '2026-09-25' });
    check(`item 1 :: falls through without querying the DB or caching a wrong answer :: "${q}"`,
      res?.handled === true && res?.missOutcome === 'unsupported-condition' && res?.modelCalled === false, JSON.stringify(res));
  }
}

/* ================================================================== item 2: existence yes/no shape (pure) */

check('item 2 :: isExistenceQuestion recognizes "Do we have any Ruud units?"', isExistenceQuestion('Do we have any Ruud units?'));
check('item 2 :: isExistenceQuestion recognizes "Did we service any Ruud units?"', isExistenceQuestion('Did we service any Ruud units?'));
check('item 2 :: isExistenceQuestion recognizes "Are there any Carrier units?"', isExistenceQuestion('Are there any Carrier units?'));
check('item 2 :: isExistenceQuestion rejects a plain count question', !isExistenceQuestion('How many Ruud units do we have?'));
// A customer-specific existence question ("Did Ann Alpha have a repair?") is intentionally out of scope for this
// general we/there/you regex - that shape is answered by customerFile.js/comparison.js, not the generic
// analytics existence wrap, so it must NOT match here (a false positive would wrap an unrelated answer shape).
check('item 2 :: isExistenceQuestion does not match a named-customer question (out of its scope)', !isExistenceQuestion('Did Ann Alpha have a repair?'));

check('item 2 :: existenceWrap leads with Yes for a positive count', existenceWrap('you have 3 Ruud units.', true) === 'Yes, you have 3 Ruud units.');
check('item 2 :: existenceWrap leads with No for a zero count', existenceWrap('you have 0 pieces of equipment.', false) === 'No, you have 0 pieces of equipment.');
check('item 2 :: existenceWrap is idempotent (already-prefixed text is left alone)', existenceWrap('Yes, you have 3 units.', true) === 'Yes, you have 3 units.');

{
  const zero = applyExistenceShape({ kind: 'answer', text: 'You have 0 pieces of equipment.', facts: [{ value: 0 }] }, 'Do we have any Ruud units?');
  check('item 2 :: applyExistenceShape wraps a zero count as "No, ..."', zero.text === 'No, you have 0 pieces of equipment.', zero.text);
  const some = applyExistenceShape({ kind: 'answer', text: 'You have 5 pieces of equipment.', facts: [{ value: 5 }] }, 'Do we have any Ruud units?');
  check('item 2 :: applyExistenceShape wraps a nonzero count as "Yes, ..."', some.text === 'Yes, you have 5 pieces of equipment.', some.text);
  const notExistence = applyExistenceShape({ kind: 'answer', text: 'You have 5 pieces of equipment.', facts: [{ value: 5 }] }, 'How many Ruud units do we have?');
  check('item 2 :: applyExistenceShape leaves a plain count question untouched', notExistence.text === 'You have 5 pieces of equipment.', notExistence.text);
  // The transform must never mutate the object it was handed — that object is also what gets cached upstream.
  const original = { kind: 'answer', text: 'You have 0 pieces of equipment.', facts: [{ value: 0 }] };
  const wrapped = applyExistenceShape(original, 'Do we have any Ruud units?');
  check('item 2 :: applyExistenceShape never mutates the input (the cached row must stay unwrapped)', original.text === 'You have 0 pieces of equipment.' && wrapped !== original, original.text);
}

/* ================================================================== db-backed harness (items 3 & 4) */

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
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* order-dependent, see verify-agent.mjs */ }
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
const { classifyAndRunRanking } = await import('../api/_lib/rankings.js');

const TODAY = '2026-09-25';
const ctx = { tenantKey: 'org_r7_guardrails', tenantName: 'R7 Guardrails Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (kind, n) => `e${kind}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cId = (n) => uid('c', n);
const dbCall = (fn) => withTenant(ctx, fn);

/* ------------------------------------------------------------------ fixture
 * Customers cover every maintenance-due candidacy case:
 *   #1 Nora Nolan — has an agreement stating a 6-month cadence, last visit 300 days ago (within 365, but
 *       past the agreement's own 6-month cadence): must NOT be overdue — proves the flat 365-day rule ignores
 *       an agreement's own stated cadence, matching the oracle exactly (round 6 used the agreement cadence
 *       here and would have wrongly listed her).
 *   #2 Owen Ortiz — NO agreement at all, one plain stale repair >365 days old: must be overdue (candidacy is
 *       "any qualifying visit", never "agreement or nothing").
 *   #3 Faith Farrow — has an agreement, but NO visit on file at all: must NOT be listed (no visit = not a
 *       candidate at all, never an automatic overdue).
 *   #4, #5 — Karen/Bill, for the rankings/tech-performance citation-contract checks below.
 */
const CUSTOMERS = [
  { n: 1, name: 'Nora Nolan', address: '90 Nolan Dr, Mesa, AZ 85202' },
  { n: 2, name: 'Owen Ortiz', address: '12 Ortiz Way, Tempe, AZ 85281' },
  { n: 3, name: 'Faith Farrow', address: '4 Farrow Ct, Tempe, AZ 85281' },
  { n: 4, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201' },
  { n: 5, name: 'Bill Whitmore', address: '88 Ash Ave, Mesa, AZ 85201' },
];
const daysAgo = (n) => { const d = new Date('2026-09-25T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
let docN = 1;
async function doc(type, customer, { serviceDate, technician } = {}) {
  const id = uid('d', docN++);
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, tenId, `${id}.pdf`, type, `hash-${id}`, 'verified']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, id, cId(customer)]);
  if (serviceDate) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, id, cId(customer), 'service_date', serviceDate]);
  if (technician) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, id, cId(customer), 'technician', technician]);
  return id;
}
async function seed() {
  for (const c of CUSTOMERS) {
    await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [cId(c.n), tenId, 'customer', JSON.stringify({ customer_name: c.name, service_address: c.address }), `C-9${String(c.n).padStart(4, '0')}`]);
  }
  await doc('maintenance-agreement', 1, {});
  await lite.query(
    `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence)
     SELECT $1, id, $2, 'agreement_term', '2 visits per year', 0.9 FROM documents WHERE tenant_id = $1 AND document_type = 'maintenance-agreement' ORDER BY created_at DESC LIMIT 1`,
    [tenId, cId(1)]);
  await doc('service-ticket', 1, { serviceDate: daysAgo(300) }); // Nora: within 365, past her 6-month cadence
  await doc('service-ticket', 2, { serviceDate: daysAgo(400) }); // Owen: no agreement, stale -> overdue
  await doc('maintenance-agreement', 3, {}); // Faith: agreement but never serviced -> not a candidate

  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [uid('e', 1), tenId, 'equipment', JSON.stringify({ manufacturer: 'Trane', model: 'XR14', equipment_type: 'condenser', service_address: CUSTOMERS[3].address }), cId(4)]);
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [uid('e', 2), tenId, 'equipment', JSON.stringify({ manufacturer: 'Goodman', model: 'GSX14', equipment_type: 'condenser', service_address: CUSTOMERS[3].address }), cId(4)]);
  await doc('service-ticket', 4, { serviceDate: daysAgo(20), technician: 'D. Ramirez' });
  await doc('service-ticket', 4, { serviceDate: daysAgo(10), technician: 'D. Ramirez' });
  await doc('service-ticket', 5, { serviceDate: daysAgo(15), technician: 'M. Ortiz' });
}
await seed();

/* ================================================================== item 4: maintenance-due definition */
{
  const q = 'Which customers are overdue for maintenance?';
  const intent = classifyDeterministic(q);
  check('item 4 :: classifies as the maintenance route', intent?.route === 'maintenance', JSON.stringify(intent));
  const answer = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check('item 4 :: Nora Nolan (agreement cadence 6mo, but last visit only 300 days ago) is NOT overdue',
    !/nora nolan/i.test(answer?.text ?? ''), answer?.text);
  check('item 4 :: Owen Ortiz (no agreement, stale repair 400 days ago) IS overdue',
    /owen ortiz/i.test(answer?.text ?? ''), answer?.text);
  check('item 4 :: Faith Farrow (agreement but no visit on file) is NOT listed at all',
    !/faith farrow/i.test(answer?.text ?? ''), answer?.text);
  check('item 4 :: the basis is a flat cutoff, not "maintenance agreement" candidacy text',
    !/agreement.*(covered|coverage)/i.test(answer?.basis ?? answer?.text ?? ''), answer?.basis ?? answer?.text);
}

/* ================================================================== item 3: citation contract on rankings */
{
  const data = await dbCall((db) => classifyAndRunRanking(db, 'Which customer has the most units?'));
  check('item 3 :: geo/entity ranking carries records', Array.isArray(data?.records) && data.records.length > 0, JSON.stringify(data?.records));
  check('item 3 :: geo/entity ranking carries a basis sentence', typeof data?.basis === 'string' && data.basis.length > 0, data?.basis);
  check('item 3 :: geo/entity ranking names the winner', /karen abernathy/i.test(data?.text ?? ''), data?.text);
}
{
  const data = await dbCall((db) => classifyAndRunRanking(db, 'How many jobs has D. Ramirez done in total?'));
  check('item 3 :: tech-performance answer carries records', Array.isArray(data?.records) && data.records.length > 0, JSON.stringify(data?.records));
  check('item 3 :: tech-performance answer carries a basis sentence', typeof data?.basis === 'string' && data.basis.length > 0, data?.basis);
}
{
  const data = await dbCall((db) => classifyAndRunRanking(db, 'How many technicians do we have on record?'));
  check('item 3 :: technician count carries records or an explicit basis', (Array.isArray(data?.records) && data.records.length >= 0) && typeof data?.basis === 'string' && data.basis.length > 0, JSON.stringify({ records: data?.records, basis: data?.basis }));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
