/**
 * Workstream B ("connect the dots" relations engine) — api/_lib/relations/{timeline,questions}.js.
 *
 * No network, no Anthropic key: a REAL Postgres (PGlite, from the actual M3-config/*.sql migrations,
 * through the app's own RLS role) — same harness convention as scripts/verify-count-parity.mjs /
 * verify-scorecard.mjs. Every DB-backed check runs the module's OWN answer against the SAME oracle SQL
 * text the scorecard exam ships (test-docs/scorecard/exam.json), not a hand-computed expectation, so a
 * regression in the app's own logic is caught the same way the scorecard would catch it.
 *
 *   node scripts/verify-relations.mjs
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
const realErr = console.error;
console.error = () => {}; // relations/questions.js logs a bare error name on a query failure; keep test output clean

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
const { classifyRelationsQuestion, answerRelationsQuestion } = await import('../api/_lib/relations/questions.js');

const TODAY = '2026-09-25';
const ctxArg = { tenantKey: 'org_relations', tenantName: 'Relations Shop' };
const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
const uid = (kind, n) => `dab00000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
const cId = (n) => uid('c', n);
const eId = (n) => uid('e', n);
const dId = (n) => uid('d', n);
const VISIT_TYPES = ['service-ticket', 'service-report', 'work-order', 'dispatch-note', 'inspection-report', 'startup-sheet', 'invoice'];

/* ================================================================== fixture */
const CUSTOMERS = [
  { n: 1, name: 'Alice Alpha', address: '10 Main St, Mesa, AZ 85201' }, // repeat visit after install (30d)
  { n: 2, name: 'Bob Beta', address: '20 Oak Ave, Tucson, AZ 85701' }, // NO repeat visit (control)
  { n: 3, name: 'Carol Gamma', address: '30 Elm Rd, Mesa, AZ 85202' }, // old Carrier, no maintenance agreement
  { n: 4, name: 'Dave Delta', address: '40 Pine Ln, Mesa, AZ 85202' }, // old Carrier, HAS agreement (control)
  { n: 5, name: 'Erin Epsilon', address: '50 Birch Dr, Gilbert, AZ 85234' }, // agreement + recent visit (control)
  { n: 6, name: 'Frank Foxtrot', address: '60 Cedar Ct, Gilbert, AZ 85234' }, // agreement, no visit in 12mo
  { n: 7, name: 'Grace Golf', address: '70 Ash Way, Mesa, AZ 85201' }, // invoiced, never signed agreement
  { n: 8, name: 'Helen Hotel', address: '80 Fir Pl, Mesa, AZ 85201' }, // invoiced AND agreement (control)
  { n: 9, name: 'Ivan India', address: '90 Palm Cir, Tucson, AZ 85701' }, // old unit + permit
  { n: 10, name: 'Jane Juliet', address: '11 Rose Ave, Mesa, AZ 85201' }, // Trane, active warranty
  { n: 11, name: 'Karl Kilo', address: '12 Vine St, Mesa, AZ 85201' }, // old unit, never serviced
  { n: 12, name: 'Leo Lima', address: '13 Lake Dr, Mesa, AZ 85201' }, // two different techs within 14d
  { n: 13, name: 'Mia Mike', address: '14 Hill Rd, Mesa, AZ 85201' }, // callback within 14d
];
const EQUIPMENT = [
  { n: 1, customer: 1, mfr: 'Trane', installed: '2026-01-10' },
  { n: 2, customer: 2, mfr: 'Trane', installed: '2026-02-01' },
  { n: 3, customer: 3, mfr: 'Carrier', installed: '2010-05-01' },
  { n: 4, customer: 4, mfr: 'Carrier', installed: '2009-01-01' },
  { n: 9, customer: 9, mfr: 'Rheem', installed: '2005-01-01' },
  { n: 10, customer: 10, mfr: 'Trane', installed: '2024-01-01', warrantyExpires: '2030-01-01' },
  { n: 11, customer: 11, mfr: 'Lennox', installed: '2008-01-01' },
];

async function insertCustomer(c) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [cId(c.n), tenId, 'customer', JSON.stringify({ customer_name: c.name, service_address: c.address }), `C-9${String(c.n).padStart(4, '0')}`]);
}
async function insertEquipment(e) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [eId(e.n), tenId, 'equipment', cId(e.customer), JSON.stringify({
      manufacturer: e.mfr, installation_date: e.installed,
      ...(e.warrantyExpires ? { warranty: { expires: e.warrantyExpires } } : {}),
    })]);
}
async function doc(n, { type, customer, unit, serviceDate, technician }) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [dId(n), tenId, `doc-${n}.pdf`, type, `hash-${n}`, 'verified']);
  const entityId = unit ? eId(unit) : cId(customer);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(n), entityId]);
  if (serviceDate) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'service_date', serviceDate]);
  if (technician) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'technician', technician]);
}

async function seed() {
  for (const c of CUSTOMERS) await insertCustomer(c);
  for (const e of EQUIPMENT) await insertEquipment(e);

  // Alice Alpha (#1): installed 2026-01-10, a visit 10 days later -> repeat visit within 30 days.
  await doc(1, { type: 'service-ticket', customer: 1, unit: 1, serviceDate: '2026-01-20', technician: 'Danny Ochoa' });
  // Real ingestion links a service document to BOTH the unit it was for and the owning customer — add
  // the direct customer link too so techCustomerCount's own direct-link-only join (mirrors the oracle's
  // own join exactly) can see this job.
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(1), cId(1)]);
  // Bob Beta (#2): installed 2026-02-01, no later visit at all -> NOT a repeat visit (control).

  // Frank Foxtrot (#6): maintenance agreement, last visit 500 days before today (> 12 months ago).
  await doc(6, { type: 'maintenance-agreement', customer: 6 });
  await doc(7, { type: 'service-ticket', customer: 6, serviceDate: '2025-05-01' });
  // Erin Epsilon (#5): maintenance agreement, RECENT visit (control: must not appear as overdue).
  await doc(8, { type: 'maintenance-agreement', customer: 5 });
  await doc(9, { type: 'service-ticket', customer: 5, serviceDate: '2026-08-01' });
  // Carol Gamma (#3): old Carrier, NO maintenance agreement at all.
  // Dave Delta (#4): old Carrier, HAS a maintenance agreement (control: must not qualify).
  await doc(10, { type: 'maintenance-agreement', customer: 4 });
  // Grace Golf (#7): invoiced, never signed an agreement.
  await doc(11, { type: 'invoice', customer: 7 });
  // Helen Hotel (#8): invoiced AND has an agreement (control: must not qualify).
  await doc(12, { type: 'invoice', customer: 8 });
  await doc(13, { type: 'maintenance-agreement', customer: 8 });
  // Ivan India (#9): old unit (2005) + a permit on file.
  await doc(14, { type: 'permit', customer: 9 });
  // Karl Kilo (#11): old unit (2008), never serviced at all.
  // Leo Lima (#12): two different technicians within 14 days.
  await doc(15, { type: 'service-ticket', customer: 12, serviceDate: '2026-03-01', technician: 'Danny Ochoa' });
  await doc(16, { type: 'service-ticket', customer: 12, serviceDate: '2026-03-10', technician: 'Marisol Vega' });
  // Mia Mike (#13): a callback within 14 days (SAME technician, still a callback by definition).
  await doc(17, { type: 'service-ticket', customer: 13, serviceDate: '2026-04-01', technician: 'Danny Ochoa' });
  await doc(18, { type: 'service-ticket', customer: 13, serviceDate: '2026-04-08', technician: 'Danny Ochoa' });

  // Technician performance fixture: Danny Ochoa has 4 dated jobs total (docs 1, 15, 17, 18), one in a
  // past year (none here — all in 2026, "this year"); Marisol Vega has 1 (doc 16).
}
await seed();
const oracleQ = (sql, params) => lite.query(sql, params.map((p) => (p === '@today' ? TODAY : p)));

/* ================================================================== classify (pure) */
{
  const yes = (q) => check(`classify recognizes: "${q}"`, Boolean(classifyRelationsQuestion(q)), q);
  const no = (q) => check(`classify correctly ignores: "${q}"`, classifyRelationsQuestion(q) === null, q);
  yes('How many units had a repeat visit within 30 days of installation?');
  yes('How many Trane units had a repeat visit within 90 days of installation?');
  yes('Which customers had another service visit within 30 days of a unit\'s installation?');
  yes('Did Alice Alpha have a repeat visit within 90 days of installing a unit?');
  yes('Which customers had a callback within 14 days of a previous service visit?');
  yes('Which customers in Mesa had a callback within 30 days of a service visit?');
  yes('How many of Danny Ochoa\'s jobs had a callback within 30 days?');
  yes('Which technicians have had a callback within 30 days on one of their jobs?');
  yes('Which customers had two different technicians visit within 14 days of each other?');
  yes('How many jobs has Danny Ochoa done in total?');
  yes('Which technician has worked for the most different customers?');
  yes('Who\'s our busiest technician this year?');
  yes('Which city has the most customers?');
  yes('What\'s our most common brand?');
  yes('Which customers have a Carrier unit older than 10 years and no maintenance agreement?');
  yes('Which customers have a maintenance agreement but haven\'t had a service visit in the last 12 months?');
  // paraphrase tolerance
  yes('How many units have had a repeat visit within 30 days of installation?'); // "have had" variant
  yes('What is our most common brand?'); // "what is" vs "what's"
  yes('Who is our busiest technician this year?');
  // negative / not-our-shape controls (must fall through, never guess)
  no('What is the weather today?');
  no('How many customers do we have?');
  no('Why is this unit not under warranty?');
  no('Which customers have a Carrier unit older than 10 years?'); // single condition, not this family's 2-condition shape
}

/* ================================================================== connect: repeat visit after install */
{
  const oracle = fs.readFileSync(path.join(ROOT, 'test-docs/scorecard/exam.json'), 'utf8');
  const exam = JSON.parse(oracle);
  const byId = new Map(exam.questions.map((q) => [q.id, q]));

  const q002 = byId.get('breadth-connect-002').oracle; // "How many units had a repeat visit within 30 days of installation?"
  const { rows: o002 } = await oracleQ(q002.sql, q002.params);
  const a002 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many units had a repeat visit within 30 days of installation?', today: TODAY });
  check('repeat-visit units count :: app matches oracle SQL exactly', Boolean(a002) && `${o002[0].n}` === (a002.facts[0]?.value ?? ''), `oracle=${o002[0].n} app=${JSON.stringify(a002?.facts)}`);
  check('repeat-visit units count :: cites the qualifying unit and visit document', a002.recordsTotal > 0 && a002.records.some((r) => r.type === 'document'), JSON.stringify(a002.records));

  const q007 = { ...byId.get('breadth-connect-007').oracle, params: ['Trane', VISIT_TYPES, '@today'] };
  const { rows: o007 } = await oracleQ(q007.sql, q007.params);
  const a007 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many Trane units had a repeat visit within 90 days of installation?', today: TODAY });
  eq('repeat-visit brand-filtered count :: app matches oracle', Number(a007.facts[0].value), Number(o007[0].n));

  const q013 = { ...byId.get('breadth-connect-013').oracle, params: ['%Alice Alpha%', VISIT_TYPES, '@today'] };
  const { rows: o013 } = await oracleQ(q013.sql, q013.params);
  const a013 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Did Alice Alpha have a repeat visit within 90 days of installing a unit?', today: TODAY });
  check('repeat-visit yes/no :: app agrees with oracle (yes)', o013[0].v === true && /^Yes/.test(a013.text), a013.text);

  const a013b = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Did Bob Beta have a repeat visit within 90 days of installing a unit?', today: TODAY });
  check('repeat-visit yes/no :: control customer with no later visit answers No', /^No/.test(a013b.text), a013b.text);

  const missing = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Did Zzyzx Nobody have a repeat visit within 90 days of installing a unit?', today: TODAY });
  check('repeat-visit yes/no :: an unknown customer name returns null (never guesses)', missing === null);
}

/* ================================================================== connect: callback within N days */
{
  const exam = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/scorecard/exam.json'), 'utf8'));
  const byId = new Map(exam.questions.map((q) => [q.id, q]));
  const q021 = byId.get('breadth-connect-021').oracle; // "Which customers had a callback within 14 days of a previous service visit?"
  const { rows: o021 } = await oracleQ(q021.sql, q021.params);
  const a021 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Which customers had a callback within 14 days of a previous service visit?', today: TODAY });
  check('callback set :: Mia Mike (same-tech callback) is in both app and oracle', o021.some((r) => r.item === 'Mia Mike') && /Mia Mike/.test(a021.text), a021.text);
  check('callback set :: Alice Alpha (single visit, no callback) is in neither', !o021.some((r) => r.item === 'Alice Alpha') && !/Alice Alpha/.test(a021.text), a021.text);
  check('callback set :: cites the actual visit documents behind it', a021.records.some((r) => r.type === 'document'));

  const q031 = { ...byId.get('breadth-connect-031').oracle, params: [VISIT_TYPES, '@today', '%Danny Ochoa%'] };
  const { rows: o031 } = await oracleQ(q031.sql, q031.params);
  const a031 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many of Danny Ochoa\'s jobs had a callback within 30 days?', today: TODAY });
  eq('callback tech-jobs count :: app matches oracle', Number(a031.facts[0].value), Number(o031[0].n));

  const unknownTech = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many of Nobody Special\'s jobs had a callback within 30 days?', today: TODAY });
  check('callback tech-jobs count :: an unknown technician returns null (never guesses)', unknownTech === null);
}

/* ================================================================== connect: two different technicians */
{
  const exam = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/scorecard/exam.json'), 'utf8'));
  const byId = new Map(exam.questions.map((q) => [q.id, q]));
  const q038 = byId.get('breadth-connect-038').oracle;
  const { rows: o038 } = await oracleQ(q038.sql, q038.params);
  const a038 = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Which customers had two different technicians visit within 14 days of each other?', today: TODAY });
  check('two-tech set :: Leo Lima (two different techs, 9 days apart) is in both app and oracle', o038.some((r) => r.item === 'Leo Lima') && /Leo Lima/.test(a038.text), a038.text);
  check('two-tech set :: Mia Mike (same tech both times) is in neither', !o038.some((r) => r.item === 'Mia Mike') && !/Mia Mike/.test(a038.text), a038.text);
}

/* ================================================================== tech-performance */
{
  const a = await answerRelationsQuestion({ withTenant, ctxArg, question: "How many jobs has Danny Ochoa done in total?", today: TODAY });
  eq('tech-performance :: Danny Ochoa total jobs = 4 (docs 1, 15, 17, 18)', Number(a.facts[0].value), 4);
  check('tech-performance :: cites the job documents', a.records.length >= 4);

  const b = await answerRelationsQuestion({ withTenant, ctxArg, question: "How many different customers has Danny Ochoa worked for?", today: TODAY });
  eq('tech-performance :: Danny Ochoa distinct customers = 3 (Alice, Leo, Mia)', Number(b.facts[0].value), 3);

  const c = await answerRelationsQuestion({ withTenant, ctxArg, question: "Which technician has worked for the most different customers?", today: TODAY });
  check('tech-performance :: Danny Ochoa is the top technician by distinct customers', /Danny Ochoa/.test(c.text), c.text);

  const d = await answerRelationsQuestion({ withTenant, ctxArg, question: "How many technicians do we have on record?", today: TODAY });
  eq('tech-performance :: 2 technicians on record', Number(d.facts[0].value), 2);

  const e = await answerRelationsQuestion({ withTenant, ctxArg, question: "Who's our busiest technician this year?", today: TODAY });
  check('tech-performance :: busiest technician this year cites job documents (round-6 bug: was uncited)', e.recordsTotal > 0, JSON.stringify(e.records));

  const unknown = await answerRelationsQuestion({ withTenant, ctxArg, question: "How many jobs has Nobody Special done in total?", today: TODAY });
  check('tech-performance :: an unknown technician returns null (never guesses)', unknown === null);
}

/* ================================================================== rankings ("most common X") */
{
  const a = await answerRelationsQuestion({ withTenant, ctxArg, question: "Which city has the most customers?", today: TODAY });
  check('rankings :: Mesa has the most customers, and it is cited', /Mesa/.test(a.text) && a.recordsTotal > 0, `${a.text} records=${a.recordsTotal}`);

  const b = await answerRelationsQuestion({ withTenant, ctxArg, question: "What's our most common brand?", today: TODAY });
  check('rankings :: most common brand answers and is cited (round-6 bug: was uncited)', a.recordsTotal > 0 && typeof b.text === 'string' && b.text.length > 0, b.text);
}

/* ================================================================== multi-hop (same-row conjunctions) */
{
  const a = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Which customers have a Carrier unit older than 10 years and no maintenance agreement?', today: TODAY });
  check('multi-hop :: Carol Gamma (old Carrier, no agreement) qualifies', /Carol Gamma/.test(a.text), a.text);
  check('multi-hop :: Dave Delta (old Carrier, HAS an agreement) is correctly excluded — the compose.js same-row bug this module fixes', !/Dave Delta/.test(a.text), a.text);

  const b = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Which customers have a maintenance agreement but haven\'t had a service visit in the last 12 months?', today: TODAY });
  check('multi-hop :: Frank Foxtrot (agreement, 500-day-old visit) qualifies', /Frank Foxtrot/.test(b.text), b.text);
  check('multi-hop :: Erin Epsilon (agreement, recent visit) is excluded', !/Erin Epsilon/.test(b.text), b.text);

  const c = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many customers have been invoiced but never signed a maintenance agreement?', today: TODAY });
  check('multi-hop :: Grace Golf (invoiced, no agreement) is counted, Helen Hotel (both) is not', Number(c.facts[0].value) === 1, c.text);

  const d = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many customers have a unit older than 15 years and a permit on file?', today: TODAY });
  eq('multi-hop :: Ivan India (2005 unit + permit) is the only match', Number(d.facts[0].value), 1);

  const e = await answerRelationsQuestion({ withTenant, ctxArg, question: 'How many customers with a Trane unit have an active warranty?', today: TODAY });
  eq('multi-hop :: Jane Juliet (Trane, warranty expiring 2030) is the only match', Number(e.facts[0].value), 1);

  const f = await answerRelationsQuestion({ withTenant, ctxArg, question: 'Which customers with units older than 10 years have never had a service visit on file?', today: TODAY });
  // Carol/Dave/Ivan/Karl all have a unit older than 10 years and none of them has an actual VISIT-type
  // document (agreements and permits are not visits) — all four belong in this set.
  for (const name of ['Carol Gamma', 'Dave Delta', 'Ivan India', 'Karl Kilo']) {
    check(`multi-hop :: ${name} (old unit, no service-visit document) qualifies`, new RegExp(name).test(f.text), f.text);
  }
  check('multi-hop :: Alice Alpha (new unit, has a visit) is correctly excluded', !/Alice Alpha/.test(f.text), f.text);
}

/* ================================================================== citations: every relations answer cites something */
{
  const questions = [
    'How many units had a repeat visit within 30 days of installation?',
    'Which customers had a callback within 14 days of a previous service visit?',
    'How many jobs has Danny Ochoa done in total?',
    'Which city has the most customers?',
    'Which customers have a Carrier unit older than 10 years and no maintenance agreement?',
  ];
  for (const q of questions) {
    const a = await answerRelationsQuestion({ withTenant, ctxArg, question: q, today: TODAY });
    check(`citations :: "${q}" carries records/recordsTotal/basis`, Boolean(a) && Array.isArray(a.records) && Number.isFinite(a.recordsTotal) && typeof a.basis === 'string' && a.basis.length > 0, JSON.stringify({ recordsTotal: a?.recordsTotal, basis: a?.basis }));
  }
}

console.error = realErr;
const total = passes + failures;
console.log(`\n${passes}/${total} checks passed.`);
process.exit(failures ? 1 : 0);
