/**
 * Checks for explain.js's three deterministic "why"/"explain" shapes (warranty-alert, last-visit,
 * follow-up) and the customer-name resolution they build on (contactLookup.js's resolveContactCandidates).
 *
 * Round 8 (2026-09-25/26): the live exam's breadth-explain-001,002,005,006,007,008,009,010,011,012 were
 * failing (003/004 passed) — every one of the ten shares ONE root cause, found by reproducing it here
 * against a PGlite fixture built from the REAL business-corpus documents (test-docs/business/*), not a
 * synthetic guess: the searched surname matches TWO distinct customers (the corpus routinely has this —
 * "Mercer" is both Thomas Mercer and Laura Mercer, "Prentiss" is both David and Deborah, etc.), and every
 * handler answered with a single blended, unattributed sentence built from BOTH customers' facts. When
 * both matched customers' facts happened to agree (003/004 — Delgado, Rios: both units expired), the
 * blended sentence still read as true and passed. When they disagreed (001/002 — Mercer, Salazar: one
 * unit flagged, the other not; and every last-visit/follow-up case here, where the two customers' visit
 * history or reason differs), the SAME blended sentence became either self-contradicting ("is flagged...
 * is NOT flagged" in one breath) or simply wrong (naming the wrong customer's last visit, or the wrong
 * customer's follow-up reason) — the previous engineer's "customer-name-resolution" hypothesis, confirmed.
 *
 * The fix (see explain.js's own top-of-file comment) is NOT to refuse to answer when a name is
 * ambiguous — the oracle itself never disambiguates, it unions every matching customer, so the reference
 * answer legitimately covers all of them — it is to never again let one fact stand in for a name it did
 * not come from: every sentence here now names the ACTUAL customer entity a fact belongs to (the unit's
 * own customer_id, the document's own link, the visit's own correlated customer_name) whenever more than
 * one customer matched, so two same-surname customers' facts are described side by side, attributed, and
 * never blended into one guessed claim. A single match (by far the common case) is provably unaffected:
 * every "own customer" lookup below is a no-op (returns null) unless more than one customer matched.
 *
 * Part 1 (pure, no DB): parseExplain's three shapes plus wording variants this file's own live-sample
 * saw fail. Part 2 (DB-backed, same PGlite-real-Postgres harness as scripts/verify-reasoning.mjs): all
 * twelve breadth-explain question shapes end to end (classifyAndRunExplain), the customer-name-resolution
 * edge cases (a unique surname, common surnames sharing a value, two customers sharing a surname with
 * DIFFERENT facts, and a merely-fuzzy-matched pair that must never trade one customer's fact for another's).
 *
 *   node scripts/verify-explain.mjs
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

const { parseExplain } = await import('../api/_lib/explain.js');

/* ================================================================== 1. pure parse */

const parseCases = [
  ['Why is the Mercer unit flagged for a warranty alert?', 'warranty-alert', 'Mercer'],
  ['Why is the Salazar unit flagged for a warranty alert?', 'warranty-alert', 'Salazar'],
  ["Explain what happened at Holbrook's last service visit", 'last-visit', 'Holbrook'],
  ["Explain what happened at Prentiss's last service visit", 'last-visit', 'Prentiss'],
  ['Why would Norwood need a follow-up?', 'follow-up', 'Norwood'],
  ['Why would Wyckoff need a follow-up?', 'follow-up', 'Wyckoff'],
];
for (const [q, kind, name] of parseCases) {
  const parsed = parseExplain(q);
  check(`parseExplain: ${q}`, parsed?.kind === kind && parsed?.name === name, JSON.stringify(parsed));
}
check('parseExplain rejects an unrelated question', parseExplain('How many Trane units do we have?') === null);
check('parseExplain rejects empty input', parseExplain('') === null && parseExplain(null) === null);

/* ================================================================== 2. harness: real Postgres via PGlite */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
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
const { classifyAndRunExplain } = await import('../api/_lib/explain.js');
const { deriveWarranty } = await import('../api/_lib/warrantyRules.js');

const TODAY = '2026-09-25';
const ctxArg = { tenantKey: 'org_explain_a', tenantName: 'Desert Peak HVAC' };
const tenantId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
// Hex-only prefix (uuid columns reject non-hex characters) - same idiom as verify-reasoning.mjs's own uid().
const uid = (k, n) => `a${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let custN = 0, equipN = 0, docN = 0;
async function customer(name, address, phone = null, email = null) {
  custN++;
  const id = uid('c', custN);
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)`,
    [id, tenantId, JSON.stringify({ customer_name: name, service_address: address, phone, email }), `C-X${custN}`]);
  return id;
}
/** `facts` are exactly the extractions a compliant extractor (extractFields.js's own "never infer,
 *  calculate, or fill in a typical value" rule) would have produced — deriveWarranty is called for
 *  real, the same helper recordsStore.js's setEquipmentWarranty calls at ingest time, so the seeded
 *  `data.warranty` here is never hand-picked to make a test pass. */
async function equipment(customerId, facts) {
  equipN++;
  const id = uid('e', equipN);
  const warranty = deriveWarranty(facts, TODAY, null);
  const data = {
    manufacturer: facts.manufacturer ?? null, model: facts.model ?? null, serial_number: facts.serial_number ?? null,
    installation_date: facts.installation_date ?? null, service_address: facts.service_address ?? null, warranty,
  };
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment',$3::jsonb,$4)`,
    [id, tenantId, JSON.stringify(data), customerId]);
  return id;
}
async function document(type, filename, links, facts = {}, pages = []) {
  docN++;
  const id = uid('d', docN);
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,'verified')`,
    [id, tenantId, filename, type, `hash-${docN}`]);
  for (const l of links) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, id, l]);
  for (const [key, value] of Object.entries(facts)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v != null) await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [tenantId, id, key, String(v)]);
    }
  }
  for (const [i, text] of pages.entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [id, tenantId, i + 1, text]);
  return id;
}
const ask = (q) => withTenant(ctxArg, (db) => classifyAndRunExplain(db, q, { today: TODAY }));

/* ---------------------------------------------------------------- fixtures (real corpus documents) */

// Thomas Mercer (test-docs/business/006,008-invoice/service-ticket-c1.pdf): no equipment-record,
// warranty-registration or startup-sheet on file for this unit anywhere in the real corpus, so a
// compliant extractor never produces installation_date for it (extractFields.js's own rule: only when
// literally printed as "Install Date:", never inferred from an invoice's own "Date:" line even when its
// description reads "Install ... system") — its warranty tier is genuinely 'unknown', not a bug.
const thomas = await customer('Thomas Mercer', '137 W Southern Ave, Phoenix, AZ 85001', '480-555-0111');
const thomasEq = await equipment(thomas, { manufacturer: 'Carrier', model: '24ACC634A003', serial_number: '2C100003' });
await document('invoice', '006-invoice-c1.pdf', [thomas, thomasEq], { service_date: '2016-06-10', technician: 'Marisol Vega', work_performed: 'Install 3 ton Carrier system, R-410A charge' });
await document('service-ticket', '008-service-ticket-c1.pdf', [thomas, thomasEq], { service_date: '2017-11-05', technician: 'Denise Ford', service_type: 'Repair', work_performed: ['Checked refrigerant charge', 'Replaced air filter'], notes: 'System operating normally after visit' });

// Laura Mercer (…-c58.pdf): DOES have a warranty-registration document, so installation_date and
// warranty_registered_date ARE on file — an active, fully-known warranty, the opposite of Thomas's.
const laura = await customer('Laura Mercer', '2246 E Ray Rd, San Tan Valley, AZ 85140', '480.555.0168');
const lauraEq = await equipment(laura, { manufacturer: 'Goodman', model: 'GSX164261FB', serial_number: '2G100060', installation_date: '2019-03-19', warranty_registered_date: '2019-04-21' });
await document('invoice', '291-invoice-c58.pdf', [laura, lauraEq], { service_date: '2019-03-19' });
await document('warranty-registration', '292-warranty-registration-c58.pdf', [laura, lauraEq], { installation_date: '2019-03-19', warranty_registered_date: '2019-04-21' });

// Barbara & Brian Delgado: BOTH have their install-bearing document (warranty-registration /
// startup-sheet respectively), so both units are known-expired — the 003 case that already passed
// (a merged answer where both halves agree is still a true sentence even unattributed) must keep passing.
const barbara = await customer('Barbara Delgado', '618 N Power Rd, Mesa, AZ 85201', null, 'barbara.delgado4@gmail.com');
await equipment(barbara, { manufacturer: 'Daikin', model: 'DZ16SA0561', serial_number: 'D100016', installation_date: '2017-11-15', warranty_registered_date: '2017-12-14' });
const brian = await customer('Brian Delgado', '2727 N College Ave, Casa Grande, AZ 85122', 'Cell: 480-555-0181');
await equipment(brian, { manufacturer: 'Mitsubishi', model: 'MUZ-FS30NA', serial_number: 'M100073', installation_date: '2020-08-24' });

// Maria Holbrook: unique surname, four visit-type documents on file — the true latest is the service
// ticket (2021-03-09), not the original install invoice (2017-05-25) or the inspection report (2020-01-18).
const holbrook = await customer('Maria Holbrook', '2616 N Recker Rd, Casa Grande, AZ 85122', '(480) 555-0178', 'maria.holbrook3@hotmail.com');
const holbrookEq = await equipment(holbrook, { manufacturer: 'Rheem', model: 'RA1446AJ1NA', serial_number: '2R100070' });
await document('invoice', '341-invoice-c68.pdf', [holbrook, holbrookEq], { service_date: '2017-05-25', technician: 'Kevin Pratt', work_performed: 'Install 4 ton Rheem system' });
await document('inspection-report', '344-inspection-report-c68.pdf', [holbrook, holbrookEq], { service_date: '2020-01-18', technician: 'Kevin Pratt' });
await document('service-ticket', '343-service-ticket-c68.pdf', [holbrook, holbrookEq], { service_date: '2021-03-09', technician: 'Ray Sutton', service_type: 'Repair', work_performed: ['Checked refrigerant charge', 'Replaced air filter'], notes: 'System operating normally after visit' });

// David & Deborah Prentiss: a duplicate surname where the two customers' LAST VISITS differ — David's
// latest is 2019-05-01, Deborah's is 2022-01-15 (the true overall latest). The pre-fix code answered
// with the vague merged "Prentiss (2 customers)'s last service visit" label; it must now name Deborah.
const david = await customer('David Prentiss', '9 Pine Ct, Mesa, AZ 85201');
const davidEq = await equipment(david, { manufacturer: 'York', model: 'YXV026BF31TAA', serial_number: 'Y100007' });
await document('invoice', '026-invoice-c5.pdf', [david, davidEq], { service_date: '2018-01-01', technician: 'Marisol Vega', work_performed: 'Install 2 ton York system' });
await document('service-ticket', '028-service-ticket-c5.pdf', [david, davidEq], { service_date: '2019-05-01', technician: 'Denise Ford', service_type: 'Repair', work_performed: ['Checked refrigerant charge'], notes: 'ok' });
const deborah = await customer('Deborah Prentiss', '40 Rincon Rd, Tucson, AZ 85701');
const deborahEq = await equipment(deborah, { manufacturer: 'Daikin', model: 'DZ16SA0361', serial_number: 'D100064' });
await document('invoice', '311-invoice-c62.pdf', [deborah, deborahEq], { service_date: '2011-11-27', technician: 'Ray Sutton', work_performed: 'Install 3 ton Daikin system' });
await document('service-ticket', '313-service-ticket-c62.pdf', [deborah, deborahEq], { service_date: '2022-01-15', technician: 'Wyatt Coburn', service_type: 'Preventive Maintenance', work_performed: ['Annual PM: cleaned coil'], notes: 'System operating normally' });

// Joseph Norwood: single match, no reminder note, unit not currently flagged, but overdue for service
// (last visit well over a year ago) — exercises the follow-up shape's visit-cadence branch.
const joseph = await customer('Joseph Norwood', '803 E Pecos Rd, Gilbert, AZ 85234');
// No installation_date/warranty_registered_date on file (tier 'unknown') so the follow-up shape falls
// through the warranty branch and reaches the overdue-for-service check this test exercises.
const josephEq = await equipment(joseph, { manufacturer: 'Lennox', model: 'ML14XC1-056-230', serial_number: 'LX100021' });
await document('invoice', '096-invoice-c19.pdf', [joseph, josephEq], { service_date: '2016-12-04', technician: 'Marisol Vega', work_performed: 'Install 3.5 ton Lennox system' });
await document('service-ticket', '098-service-ticket-c19.pdf', [joseph, josephEq], { service_date: '2018-06-01', technician: 'Danny Ochoa', service_type: 'Preventive Maintenance', work_performed: 'Annual PM: cleaned coil, checked charge' });

// Sandra & Gary Wyckoff: a duplicate surname where ONLY Gary has a logged reminder note — the answer
// must say it is Gary's account the note was logged for, never blend it with Sandra's (unrelated) file.
const sandra = await customer('Sandra Wyckoff', '10 Alma School Rd, Mesa, AZ 85201');
const sandraEq = await equipment(sandra, { manufacturer: 'Trane', model: 'XR14', serial_number: 'TR-9001', installation_date: '2018-01-01', warranty_registered_date: '2018-01-10' });
await document('invoice', '031-invoice-c6.pdf', [sandra, sandraEq], { service_date: '2018-01-01' });
const gary = await customer('Gary Wyckoff', '900 E University Dr, Mesa, AZ 85201');
const garyEq = await equipment(gary, { manufacturer: 'Trane', model: 'XR16', serial_number: 'TR-9002', installation_date: '2015-01-01', warranty_registered_date: '2015-01-15' });
await document('invoice', '316-invoice-c63.pdf', [gary, garyEq], { service_date: '2015-01-01', reminder_text: 'confirm filter size on next visit', reminder_customer_name: 'Gary Wyckoff', reminder_trigger: 'next_visit' });

// Ellis / Ellisson: a merely-FUZZY surname match (not a shared surname, not a contains-substring match) —
// searching "Ellisson" must still attribute whatever it finds to its own real name, never silently borrow
// the other's facts just because both are within edit distance of the search term.
const ellis = await customer('Frank Ellis', '55 Gilbert Rd, Gilbert, AZ 85234');
const ellisEq = await equipment(ellis, { manufacturer: 'Carrier', model: '24ABC636', serial_number: 'CR-5001', installation_date: '2010-01-01', warranty_registered_date: '2010-01-05' });
await document('invoice', '900-invoice-x1.pdf', [ellis, ellisEq], { service_date: '2010-01-01' });

console.log('\n=== explain.js: warranty-alert (breadth-explain-001..004 shape) ===');
{
  const a1 = await ask('Why is the Mercer unit flagged for a warranty alert?');
  check('warranty-alert :: routes to an answer', Boolean(a1), JSON.stringify(a1));
  check('warranty-alert :: names Thomas Mercer', a1?.text?.includes('Thomas Mercer'), a1?.text);
  check('warranty-alert :: names Laura Mercer', a1?.text?.includes('Laura Mercer'), a1?.text);
  check('warranty-alert :: gives the plain reason for the flagged unit (no installation date on file)', /no installation date is on file/.test(a1?.text ?? ''), a1?.text);
  check('warranty-alert :: does NOT invent an installation date for Thomas Mercer\'s unit', !/installed \d{4}-\d{2}-\d{2}/.test((a1?.text ?? '').split('Laura Mercer')[0]), a1?.text);
  check('warranty-alert :: states Laura Mercer\'s unit is active with its real expiry date', /Laura Mercer's Goodman GSX164261FB is NOT flagged.*March 19, 2029/.test(a1?.text ?? ''), a1?.text);
  // The round-8 bug: the pre-fix text had "is flagged" and "is NOT flagged" back to back about the same
  // bare label with no attribution. Post-fix, each clause is anchored to its own customer's name right
  // before the flagged/NOT-flagged verb, so this can never read as one contradicting claim about one unit.
  check('warranty-alert :: leads with the flagged customer, not the non-flagged one', a1?.text?.indexOf('Thomas Mercer') < a1?.text?.indexOf('Laura Mercer'), a1?.text);

  const a2 = await ask('Why is the Delgado unit flagged for a warranty alert?');
  check('warranty-alert :: Delgado (both matches expired) still names both customers', a2?.text?.includes('Barbara Delgado') && a2?.text?.includes('Brian Delgado'), a2?.text);
  check('warranty-alert :: Delgado :: both units are stated as flagged, no contradiction introduced', !/NOT flagged/.test(a2?.text ?? ''), a2?.text);

  const a3 = await ask('Why is the Holbrook unit flagged for a warranty alert?');
  check('warranty-alert :: a single (unique-surname) customer reads exactly as before the fix ("the <unit>", no name prefix)', /^the Rheem RA1446AJ1NA/.test(a3?.text ?? ''), a3?.text);
}

console.log('\n=== explain.js: last-visit (breadth-explain-005..008 shape) ===');
{
  const b1 = await ask("Explain what happened at Holbrook's last service visit");
  check('last-visit :: unique surname names the customer and the true latest visit (service ticket, not the install invoice)', /^Maria Holbrook's last service visit was March 9, 2021/.test(b1?.text ?? ''), b1?.text);
  check('last-visit :: describes the actual work performed, no invented detail', /Checked refrigerant charge/.test(b1?.text ?? ''), b1?.text);

  const b2 = await ask("Explain what happened at Prentiss's last service visit");
  check('last-visit :: duplicate surname names the customer whose visit is ACTUALLY latest (Deborah, 2022), not the merged label', /^Deborah Prentiss's last service visit was January 15, 2022/.test(b2?.text ?? ''), b2?.text);
  check('last-visit :: never reads as the vague merged "Name (N customers)" subject', !/Prentiss \(2 customers\)'s/.test(b2?.text ?? ''), b2?.text);
  check('last-visit :: does not describe David\'s (the wrong, older) visit', !/Denise Ford/.test(b2?.text ?? ''), b2?.text);
}

console.log('\n=== explain.js: follow-up (breadth-explain-009..012 shape) ===');
{
  const c1 = await ask('Why would Norwood need a follow-up?');
  check('follow-up :: overdue-for-service reason, grounded in the real last-visit date', /no service visit since June 1, 2018/.test(c1?.text ?? ''), c1?.text);

  const c2 = await ask('Why would Wyckoff need a follow-up?');
  check('follow-up :: attributes the logged reminder to the customer it was actually logged for (Gary)', /^Gary Wyckoff needs a follow-up because a note on file says/.test(c2?.text ?? ''), c2?.text);
  check('follow-up :: never attributes Gary\'s note to Sandra (the other Wyckoff)', !/^Sandra Wyckoff/.test(c2?.text ?? ''), c2?.text);
}

console.log('\n=== name resolution edge cases (contactLookup.js resolveContactCandidates via explain.js) ===');
{
  const d1 = await ask('Why is the Ellis unit flagged for a warranty alert?');
  check('name resolution :: an exact/contains surname match resolves to the real customer, single match reads unattributed', /^the Carrier 24ABC636/.test(d1?.text ?? ''), d1?.text);

  const d2 = await ask('Why is the Nobody unit flagged for a warranty alert?');
  eq('name resolution :: a name with zero matches falls through (null), never a guess', d2, null);
}

console.log(`\n${passes}/${passes + failures} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
