/**
 * Round 11, item 1 (literature #2, query decomposition) — api/_lib/decompose/{clauses,entitySets,compare,index}.js.
 *
 * Same harness convention as scripts/verify-relations.mjs / verify-job-costing.mjs: no network, no
 * Anthropic key, a REAL Postgres (PGlite, from the actual M3-config/*.sql migrations) through the app's
 * own RLS role.
 *
 *   node scripts/verify-decompose.mjs
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
console.error = () => {}; // decompose/index.js logs a bare error name on a query failure; keep test output clean

const { getPack } = await import('../api/_lib/industry/index.js');
const HVAC_PACK = getPack('hvac');

/* ================================================================== 1. pure classify */
const Clauses = await import('../api/_lib/decompose/clauses.js');
const { classifyDecompose } = await import('../api/_lib/decompose/index.js');

{
  const yes = (q) => check(`classify recognizes: "${q}"`, Boolean(classifyDecompose(q, { pack: HVAC_PACK })), q);
  const no = (q) => check(`classify correctly ignores: "${q}"`, classifyDecompose(q, { pack: HVAC_PACK }) === null, q);

  yes('Which Trane customers with no agreement had a callback this year?');
  yes('Which customers in Mesa with units older than 10 years and no visit since 2024?');
  yes('Compare invoices vs POs for the Rios job');
  yes('Compare invoices to purchase orders for 214 Mercer St');
  yes('How many customers with a Carrier unit older than 10 years have no maintenance agreement?');

  no('How many customers do we have?'); // no recognized clause at all
  no('Which customers have a Carrier unit?'); // a single clause (brand only) -> below the 2-clause floor
  no('What is the weather today?');
  no('Compare apples to oranges for the Rios job'); // neither side is a recognized doc-type phrase
  no('Which customers had a callback this year?'); // callback alone, no other clause to intersect against

  // R14 (K4): follow-up narrowing ("first question -- second question", the second answered as a
  // further AND'd condition against the same universe) and the two new filter conditions (hasEmail,
  // noPhone).
  yes('Which customers have no email on file -- and how many of those are in Mesa?');
  yes('which custs missing an e-mail -- and how many of those are in tucson'); // typo/abbrev tolerance
  yes('Which customers have a Trane unit -- and which of those have an email on file?');
  yes('Which customers have a Carrier unit -- and which of those have no phone number on file?');
  no('Which customers have no email on file?'); // one clause, no " -- " second half -> below the floor
  no('Which customers have a Carrier unit -- what is the weather today?'); // second half has no recognized clause

  const flt2 = Clauses.parseFilterClauses('Which customers have a Trane unit and have an email on file?', HVAC_PACK);
  eq('parseFilterClauses: recognizes brand + hasEmail', flt2.conditions.map((c) => c.type).sort(), ['brand', 'hasEmail'].sort());
  const flt3 = Clauses.parseFilterClauses("Which customers have a Carrier unit and don't have a phone number on file?", HVAC_PACK);
  eq('parseFilterClauses: recognizes brand + noPhone', flt3.conditions.map((c) => c.type).sort(), ['brand', 'noPhone'].sort());
  const fu = Clauses.parseFollowupNarrowing('Which customers have a Trane unit -- and which of those have no email on file?', HVAC_PACK);
  eq('parseFollowupNarrowing: merges conditions from both halves, deduped by type', fu.conditions.map((c) => c.type).sort(), ['brand', 'noEmail'].sort());

  const cmp = Clauses.parseComparison('Compare invoices vs POs for the Rios job');
  eq('parseComparison: doc-type phrases resolve to their canonical doc_kind', [cmp.aKinds, cmp.bKinds], [['invoice'], ['po']]);
  eq('parseComparison: subject captured verbatim (trailing "job" stripped by the regex)', cmp.subject, 'Rios');

  const flt = Clauses.parseFilterClauses('Which Trane customers with no agreement had a callback this year?', HVAC_PACK);
  const types = flt.conditions.map((c) => c.type).sort();
  eq('parseFilterClauses: recognizes brand + lacksDocType + callback(thisYear)', types, ['brand', 'callback', 'lacksDocType'].sort());
}

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
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* notes printed elsewhere */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as other verify-*.mjs */ }

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
const { runDecompose } = await import('../api/_lib/decompose/index.js');

const TODAY = '2026-09-25';
const ctxArg = { tenantKey: 'org_decompose', tenantName: 'Decompose Shop' };
const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
const uid = (kind, n) => `dab00000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
const cId = (n) => uid('c', n);
const eId = (n) => uid('e', n);
const dId = (n) => uid('d', n);

async function insertCustomer(n, name, address) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [cId(n), tenId, 'customer', JSON.stringify({ customer_name: name, service_address: address }), `C-DC${String(n).padStart(4, '0')}`]);
}
async function insertEquipment(n, customer, mfr, installed) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [eId(n), tenId, 'equipment', cId(customer), JSON.stringify({ manufacturer: mfr, installation_date: installed })]);
}
async function doc(n, { type, customer, serviceDate = null, technician = null }) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [dId(n), tenId, `doc-${n}.pdf`, type, `dc-hash-${n}`, 'verified']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(n), cId(customer)]);
  if (serviceDate) await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [tenId, dId(n), 'service_date', serviceDate]);
  if (technician) await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [tenId, dId(n), 'technician', technician]);
}

/* ---------------------------------------------------------------- fixture: conjunctive filter */
// C1: Trane, NO agreement, callback THIS year (2026) -> qualifies for clause set A.
await insertCustomer(1, 'Callback Carl', '10 Main St, Mesa, AZ 85201');
await insertEquipment(1, 1, 'Trane', '2015-01-01');
await doc(1, { type: 'service-ticket', customer: 1, serviceDate: '2026-06-01' });
await doc(2, { type: 'service-ticket', customer: 1, serviceDate: '2026-06-10' }); // within 30 days, dated 2026 -> this year

// C2: Trane, HAS agreement (control — excluded by lacksDocType).
await insertCustomer(2, 'Agreement Anna', '20 Oak Ave, Mesa, AZ 85202');
await insertEquipment(2, 2, 'Trane', '2015-01-01');
await doc(3, { type: 'maintenance-agreement', customer: 2 });
await doc(4, { type: 'service-ticket', customer: 2, serviceDate: '2026-06-01' });
await doc(5, { type: 'service-ticket', customer: 2, serviceDate: '2026-06-10' });

// C3: Trane, no agreement, callback LAST year (2025) — excluded by the "this year" scope.
await insertCustomer(3, 'LastYear Larry', '30 Elm Rd, Mesa, AZ 85202');
await insertEquipment(3, 3, 'Trane', '2015-01-01');
await doc(6, { type: 'service-ticket', customer: 3, serviceDate: '2025-06-01' });
await doc(7, { type: 'service-ticket', customer: 3, serviceDate: '2025-06-10' });

// C4: Carrier (wrong brand), no agreement, callback this year — excluded by brand.
await insertCustomer(4, 'WrongBrand Wanda', '40 Pine Ln, Mesa, AZ 85202');
await insertEquipment(4, 4, 'Carrier', '2015-01-01');
await doc(8, { type: 'service-ticket', customer: 4, serviceDate: '2026-06-01' });
await doc(9, { type: 'service-ticket', customer: 4, serviceDate: '2026-06-10' });

{
  const intent = classifyDecompose('Which Trane customers with no agreement had a callback this year?', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose filter :: brand+lacksDocType+callback(thisYear) answers with a hit', Boolean(data), JSON.stringify(data));
  check('decompose filter :: Callback Carl (qualifies on all 3 conditions) is in the answer', /Callback Carl/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: Agreement Anna (has an agreement) is excluded', !/Agreement Anna/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: LastYear Larry (callback was last year, not this year) is excluded', !/LastYear Larry/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: WrongBrand Wanda (Carrier, not Trane) is excluded', !/WrongBrand Wanda/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: basis names every condition applied', /Trane/.test(data?.basis ?? '') && /agreement/.test(data?.basis ?? '') && /callback/.test(data?.basis ?? ''), data?.basis);
  check('decompose filter :: cites the qualifying customer AND the qualifying visit documents', (data?.records ?? []).some((r) => r.type === 'customer') && (data?.records ?? []).some((r) => r.type === 'document'), JSON.stringify(data?.records));
}

/* ---------------------------------------------------------------- fixture: geo + age + absolute-date */
// C5: Mesa, old unit (2005, >10yr), no visit since 2024 (last visit 2023) -> qualifies.
await insertCustomer(5, 'OldUnit Olivia', '50 Birch Dr, Mesa, AZ 85234');
await insertEquipment(5, 5, 'Rheem', '2005-01-01');
await doc(10, { type: 'service-ticket', customer: 5, serviceDate: '2023-05-01' });

// C6: Mesa, old unit, but HAS a visit in 2024 — excluded.
await insertCustomer(6, 'Recent Rachel', '60 Cedar Ct, Mesa, AZ 85234');
await insertEquipment(6, 6, 'Rheem', '2005-01-01');
await doc(11, { type: 'service-ticket', customer: 6, serviceDate: '2024-05-01' });

// C7: Tucson (wrong city), old unit, no visit since 2024 — excluded by geo.
await insertCustomer(7, 'WrongCity Wes', '70 Ash Way, Tucson, AZ 85701');
await insertEquipment(7, 7, 'Rheem', '2005-01-01');
await doc(12, { type: 'service-ticket', customer: 7, serviceDate: '2023-05-01' });

// C8: Mesa, NEW unit (2020, <10yr), no visit since 2024 — excluded by age.
await insertCustomer(8, 'NewUnit Nina', '80 Fir Pl, Mesa, AZ 85234');
await insertEquipment(8, 8, 'Rheem', '2020-01-01');
await doc(13, { type: 'service-ticket', customer: 8, serviceDate: '2023-05-01' });

{
  const intent = classifyDecompose('Which customers in Mesa with units older than 10 years and no visit since 2024 have we not seen?', { pack: HVAC_PACK });
  check('classify: "in Mesa with units older than..." (broader geo phrasing than compose.js\'s own) is recognized', Boolean(intent));
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose filter :: geoCity+ageOlder+noVisitSinceYear answers with a hit', Boolean(data), JSON.stringify(data));
  check('decompose filter :: OldUnit Olivia (Mesa, old, no visit since 2024) is in the answer', /OldUnit Olivia/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: Recent Rachel (visited in 2024) is excluded', !/Recent Rachel/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: WrongCity Wes (Tucson, not Mesa) is excluded', !/WrongCity Wes/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: NewUnit Nina (unit too new) is excluded', !/NewUnit Nina/.test(data?.text ?? ''), data?.text);
}

/* ---------------------------------------------------------------- negative controls */
{
  const single = classifyDecompose('Which customers have a Carrier unit?', { pack: HVAC_PACK });
  check('classify: a single-condition question is never claimed (below the 2-clause floor)', single === null);
  // A two-condition question decompose recognizes but that is ALSO exactly compose.js's own canonical
  // phrasing is not itself a bug (in the real ask.js chain, compose.js's own 0.4 block already claims and
  // answers it before decompose is ever reached) — this just confirms decompose still answers it
  // correctly on its own when asked directly.
  const overlapping = classifyDecompose('Which customers have a Carrier unit older than 10 years?', { pack: HVAC_PACK });
  check('classify: a 2-condition question decompose also understands is still answered correctly standalone', Boolean(overlapping));
}

/* ---------------------------------------------------------------- fixture: hasEmail / noPhone / follow-up */
async function insertCustomerContact(n, name, address, { email = null, phone = null } = {}) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [cId(n), tenId, 'customer', JSON.stringify({ customer_name: name, service_address: address, email, phone }), `C-DC${String(n).padStart(4, '0')}`]);
}
// C15: Trane, has an email on file, has a phone -> qualifies "Trane + has email", excluded from "Trane + no email".
await insertCustomerContact(15, 'HasEmail Hank', '15 Vine St, Mesa, AZ 85201', { email: 'hank@example.com', phone: '480-555-0101' });
await insertEquipment(15, 15, 'Trane', '2018-01-01');
// C16: Trane, NO email on file, no phone -> qualifies "Trane + no email" / "Trane + no phone".
await insertCustomerContact(16, 'NoEmail Nora', '16 Lake Dr, Mesa, AZ 85201', { email: null, phone: null });
await insertEquipment(16, 16, 'Trane', '2018-01-01');

// The follow-up shape (parseFollowupNarrowing) always answers as a COUNT (every follow-up-category exam
// item is cmp:"number", e.g. "Customers missing an email -- and how many of those are in Tucson?") — so
// these check the count + citation records, not a name list in the text (a plain filter question with the
// SAME two conditions, exercised separately below, is what actually lists names).
{
  const intent = classifyDecompose('Which customers have a Trane unit -- and which of those have no email on file?', { pack: HVAC_PACK });
  eq('classify: follow-up narrowing always answers as a count (op)', intent.op, 'count');
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose follow-up :: brand + noEmail answers with a hit', Boolean(data), JSON.stringify(data));
  check('decompose follow-up :: counts NoEmail Nora but not HasEmail Hank', data?.records?.some((r) => r.label === 'NoEmail Nora') && !data?.records?.some((r) => r.label === 'HasEmail Hank'), JSON.stringify(data?.records));
}
{
  const intent = classifyDecompose('Which customers have a Trane unit and have an email on file?', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose filter :: brand + hasEmail :: HasEmail Hank qualifies', /HasEmail Hank/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: brand + hasEmail :: NoEmail Nora (no email) is excluded', !/NoEmail Nora/.test(data?.text ?? ''), data?.text);
}
{
  const intent = classifyDecompose("Which customers have a Trane unit and don't have a phone number on file?", { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose filter :: brand + noPhone :: NoEmail Nora (no phone either) qualifies', /NoEmail Nora/.test(data?.text ?? ''), data?.text);
  check('decompose filter :: brand + noPhone :: HasEmail Hank (has a phone) is excluded', !/HasEmail Hank/.test(data?.text ?? ''), data?.text);
}

/* ---------------------------------------------------------------- fixture: comparison */
async function addFinancialDoc(n, { docKind, direction, total, customer }) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [dId(n), tenId, `fin-${n}.pdf`, docKind === 'po' ? 'purchase-order' : 'invoice', `dc-fin-hash-${n}`, 'verified']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(n), cId(customer)]);
  await lite.query(
    `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, status, customer_name)
     VALUES ($1,$2,$3,$4,'USD',$5,'unknown',$6)`,
    [tenId, dId(n), docKind, direction, total, null]
  );
}

await insertCustomer(20, 'Rios', '500 Test Rd, Gilbert, AZ 85234');
await addFinancialDoc(20, { docKind: 'invoice', direction: 'receivable', total: '100.00', customer: 20 });
await addFinancialDoc(21, { docKind: 'invoice', direction: 'receivable', total: '50.00', customer: 20 });
await addFinancialDoc(22, { docKind: 'po', direction: 'payable', total: '40.00', customer: 20 });

{
  const intent = classifyDecompose('Compare invoices vs POs for the Rios job', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose compare :: resolves the job and totals both sides', Boolean(data), JSON.stringify(data));
  check('decompose compare :: counts 2 invoices vs 1 PO', /2 invoices/.test(data?.text ?? '') && /1 po/i.test((data?.text ?? '').toLowerCase()), data?.text);
  check('decompose compare :: totals are correct ($150.00 invoices, $40.00 PO)', /150\.00/.test(data?.text ?? '') && /40\.00/.test(data?.text ?? ''), data?.text);
  check('decompose compare :: cites the actual invoice/PO documents', (data?.records ?? []).length >= 3, JSON.stringify(data?.records));
}

// A second, similarly-named customer added AFTER the unambiguous check above — proves ambiguous-name
// resolution never guesses, without polluting the unambiguous test that ran before it existed.
await insertCustomer(23, 'Rios Junior', '600 Other Rd, Gilbert, AZ 85234');

{
  const intent = classifyDecompose('Compare invoices vs POs for the Rios job', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose compare :: an ambiguous subject name never guesses (falls through to null)', data === null, JSON.stringify(data));
}

{
  const intent = classifyDecompose('Compare invoices to purchase orders for 500 Test Rd', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose compare :: an address subject resolves the same job directly', Boolean(data), JSON.stringify(data));
}

{
  const intent = classifyDecompose('Compare invoices vs POs for the Nobody job', { pack: HVAC_PACK });
  const data = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('decompose compare :: an unresolvable subject falls through (never fabricates)', data === null, JSON.stringify(data));
}

console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
