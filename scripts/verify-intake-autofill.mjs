/**
 * STRAIGHT-THROUGH INTAKE — api/_lib/intake/autofill.js + api/_lib/intake/status.js
 * (M3-config/43-intake-autofill.sql; Round 12, G4).
 *
 * No network, no Anthropic key, no DATABASE_URL, NO MODEL CALL ANYWHERE (autofill.js is pure
 * deterministic SQL over what an earlier extraction pass already wrote) — the database is a
 * REAL Postgres (PGlite) loaded from the actual M3-config/*.sql migrations and queried as the
 * app's non-superuser NOBYPASSRLS role (deepwell_rls), same harness as scripts/verify-financials.mjs.
 *
 *   1. pure: normalizeCompareValue, splitAltKeys, groupCandidatesByValue, resolveFieldCandidates
 *      (the fill/conflict/unknown decision and its exact confidence-margin boundary), the two
 *      question builders
 *   2. sibling fill with provenance: a work order's missing `technician` is filled from a linked
 *      dispatch note, with source document/page recorded, and the document auto-verifies
 *   3. genuine conflict -> ONE precise needs-info question, with candidate options, document
 *      stays unverified
 *   4. late-arriving evidence resolves an earlier open question AND retroactively verifies the
 *      document it belonged to (rule 3 of the contract) — bounded, idempotent
 *   5. ambiguous customer match (the owner's own worked example) -> one precise question
 *   6. precision first: zero candidates anywhere never invents a fill and never raises a
 *      question either — the field is just left missing for a human
 *   7. idempotency (re-running never duplicates a row) and tenant isolation (tenant B's
 *      "technician" is never filled from tenant A's siblings)
 *   8. intake/status.js's straight-through-processing rate, before/after
 *   9. completeIntake wires the graph/rollup hooks and tolerates a missing naming module
 *
 *   node scripts/verify-intake-autofill.mjs
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

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ================================================================== 1. pure */
const A = await import('../api/_lib/intake/autofill.js');

eq('normalizeCompareValue: trims, collapses space, lowercases', [A.normalizeCompareValue('  Mike   Rivera '), A.normalizeCompareValue(null), A.normalizeCompareValue(undefined)], ['mike rivera', '', '']);
eq('splitAltKeys: alt-key requirement splits, bare key stays one', [A.splitAltKeys('a|b'), A.splitAltKeys('technician'), A.splitAltKeys('')], [['a', 'b'], ['technician'], []]);

{
  const rows = [
    { value: 'Mike Rivera', confidence: 0.9, documentId: 'd1', page: 2 },
    { value: 'mike   rivera', confidence: 0.6, documentId: 'd2', page: 1 },
    { value: 'Miguel Rivera', confidence: 0.5, documentId: 'd3', page: null },
  ];
  const groups = A.groupCandidatesByValue(rows);
  eq('groupCandidatesByValue: case/space-insensitive grouping, keeps the higher-confidence spelling', groups.map((g) => [g.value, g.confidence, g.documentId]), [['Mike Rivera', 0.9, 'd1'], ['Miguel Rivera', 0.5, 'd3']]);
}

eq('resolveFieldCandidates: no candidates -> unknown (never invented)', A.resolveFieldCandidates([]).outcome, 'unknown');
{
  const one = A.resolveFieldCandidates([{ value: 'X', confidence: 0.5, documentId: 'd1', page: 1 }]);
  check('resolveFieldCandidates: exactly one distinct value -> fill', one.outcome === 'fill' && one.value === 'X' && one.alternates.length === 0);
}
{
  // Exactly at the margin boundary (CONFLICT_MARGIN = 0.15): a 0.15 lead fills, a hair under conflicts.
  const atMargin = A.resolveFieldCandidates([{ value: 'A', confidence: 0.80, documentId: 'd1', page: 1 }, { value: 'B', confidence: 0.65, documentId: 'd2', page: 1 }]);
  const underMargin = A.resolveFieldCandidates([{ value: 'A', confidence: 0.80, documentId: 'd1', page: 1 }, { value: 'B', confidence: 0.651, documentId: 'd2', page: 1 }]);
  check('resolveFieldCandidates: lead exactly = CONFLICT_MARGIN -> fill', atMargin.outcome === 'fill' && atMargin.value === 'A');
  check('resolveFieldCandidates: lead a hair under CONFLICT_MARGIN -> conflict', underMargin.outcome === 'conflict' && underMargin.candidates.length === 2);
}

check('buildCustomerAmbiguityQuestion: owner\'s own worked example shape', A.buildCustomerAmbiguityQuestion({ address: '581 W Thomas Rd', candidateNames: ['Carol Rios', 'Carlos Rios'] }) === 'Which customer is 581 W Thomas Rd: Carol Rios or Carlos Rios?');
check('buildFieldConflictQuestion: names the field and both options, never a blank form', /technician/i.test(A.buildFieldConflictQuestion({ fieldKey: 'technician', docLabel: 'work order', candidates: [{ value: 'Mike Rivera' }, { value: 'Miguel Rivera' }] })) && /Mike Rivera/.test(A.buildFieldConflictQuestion({ fieldKey: 'technician', docLabel: 'work order', candidates: [{ value: 'Mike Rivera' }, { value: 'Miguel Rivera' }] })));

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
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { harnessNotes.push(`01b re-run failed: ${err.message}`); }
for (const line of harnessNotes) realLog(`NOTE  migration harness: ${line}`);
check('harness: migration 43 loaded cleanly (no error from 43-intake-autofill.sql)', !harnessNotes.some((n) => n.startsWith('43-')), harnessNotes.join(' | '));
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
const { intakeStatus } = await import('../api/_lib/intake/status.js');

const ctxA = { tenantKey: 'org_intake_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_intake_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let seq = 0;
async function makeEntity(tenantId, { id, type, data, customerId = null }) {
  await lite.query(
    `INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW())`,
    [id, tenantId, type, JSON.stringify(data), customerId]
  );
}
async function makeDocument(tenantId, { id, type, stage = 'linked' }) {
  seq++;
  await lite.query(
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [id, tenantId, `doc-${seq}.pdf`, type, `hash-${tenantId}-${seq}`, stage]
  );
}
/** fields: [{key, value, confidence, page}] — page, if given, gets its own facet row so
 *  provenance (source_page) is directly testable. */
async function makeExtractions(tenantId, documentId, entityId, fields) {
  for (const f of fields) {
    let facetId = null;
    if (f.page != null) {
      seq++;
      const fid = uid('f', 'a', seq);
      await lite.query(
        `INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at)
         VALUES ($1,$2,$3,$4,'fields','x',$5,$6,$7,'registry',NOW())`,
        [fid, tenantId, documentId, f.page, f.value, f.confidence, f.key]
      );
      facetId = fid;
    }
    seq++;
    await lite.query(
      `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9 || ' seconds')::interval)`,
      [uid('e', 'b', seq), tenantId, documentId, entityId, f.key, f.value, f.confidence, facetId, String(seq)]
    );
  }
}
async function linkCustomer(tenantId, documentId, entityId, linkedBy = 'ai') {
  await lite.query(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
     VALUES ($1,$2,$3,0.9,$4,NOW()) ON CONFLICT DO NOTHING`,
    [tenantId, documentId, entityId, linkedBy]
  );
}
async function getDoc(tenantId, id) {
  const r = await lite.query(`SELECT stage, verified_by FROM documents WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0];
}
async function getInferences(tenantId, documentId) {
  const r = await lite.query(`SELECT * FROM intake_field_inferences WHERE tenant_id = $1 AND document_id = $2`, [tenantId, documentId]);
  return r.rows;
}
async function getNeedsInfo(tenantId, documentId) {
  const r = await lite.query(`SELECT * FROM intake_needs_info WHERE tenant_id = $1 AND document_id = $2 ORDER BY created_at`, [tenantId, documentId]);
  return r.rows;
}

/* ================================================================ 2. sibling fill + provenance */
{
  const cust = uid('a', 'c', 1);
  const equip = uid('a', 'e', 1);
  const workOrder = uid('a', 'd', 1);
  const dispatch = uid('a', 'd', 2);

  await makeEntity(tenA, { id: cust, type: 'customer', data: { customer_name: 'Ed Bracken', service_address: '9 Bracken Way' } });
  await makeEntity(tenA, { id: equip, type: 'equipment', data: { serial_number: 'SN-1' }, customerId: cust });

  await makeDocument(tenA, { id: workOrder, type: 'work-order', stage: 'linked' });
  await makeExtractions(tenA, workOrder, equip, [
    { key: 'service_address', value: '9 Bracken Way', confidence: 0.95 },
    { key: 'service_date', value: '2026-08-01', confidence: 0.95 },
  ]);
  await linkCustomer(tenA, workOrder, cust);

  await makeDocument(tenA, { id: dispatch, type: 'dispatch-note', stage: 'linked' });
  await makeExtractions(tenA, dispatch, equip, [
    { key: 'customer_name', value: 'Ed Bracken', confidence: 0.9 },
    { key: 'service_date', value: '2026-08-01', confidence: 0.9 },
    { key: 'technician', value: 'Mike Rivera', confidence: 0.98, page: 1 },
  ]);
  await linkCustomer(tenA, dispatch, cust);

  const r1 = await A.runIntakeAutofill(ctxA, workOrder, {
    resolvedType: 'work-order', entityId: equip, customerId: cust,
    facts: { service_address: '9 Bracken Way', service_date: '2026-08-01' },
  });
  check('sibling fill: technician filled from the linked dispatch note', r1.filled.includes('technician'), JSON.stringify(r1));
  check('sibling fill: work order auto-verifies once the fill clears completeness', r1.verified === true, JSON.stringify(r1));

  const infs = await getInferences(tenA, workOrder);
  check('provenance: exactly one inference row, carrying source document + page + rule', infs.length === 1 && infs[0].source_document_id === dispatch && infs[0].source_page === 1 && infs[0].rule === 'sibling-fill', JSON.stringify(infs));
  check('provenance: confidence is discounted below the sibling\'s own (never overstated)', Number(infs[0].confidence) < 0.98 && Number(infs[0].confidence) > 0);

  const doc = await getDoc(tenA, workOrder);
  check('the document row itself reflects the auto-verify', doc.stage === 'verified' && doc.verified_by === 'ai', JSON.stringify(doc));

  // ---- idempotency: running again must not duplicate the inference row or re-verify differently ----
  const r2 = await A.runIntakeAutofill(ctxA, workOrder, {
    resolvedType: 'work-order', entityId: equip, customerId: cust,
    facts: { service_address: '9 Bracken Way', service_date: '2026-08-01' },
  });
  const infs2 = await getInferences(tenA, workOrder);
  check('idempotent: a second run does not duplicate the inference row', infs2.length === 1, JSON.stringify(infs2));
  check('idempotent: a second run reports nothing new to verify (already verified)', r2.verified === false);
}

/* ============================================================== 3 & 4. conflict, then late arrival resolves it */
let conflictWorkOrder, conflictEquip, conflictCust, lateDispatch;
{
  conflictCust = uid('a', 'c', 2);
  conflictEquip = uid('a', 'e', 2);
  conflictWorkOrder = uid('a', 'd', 3);
  const dispatch1 = uid('a', 'd', 4);
  const dispatch2 = uid('a', 'd', 5);
  lateDispatch = uid('a', 'd', 6);

  await makeEntity(tenA, { id: conflictCust, type: 'customer', data: { customer_name: 'Karen Abernathy', service_address: '412 Elm St' } });
  await makeEntity(tenA, { id: conflictEquip, type: 'equipment', data: { serial_number: 'SN-2' }, customerId: conflictCust });

  await makeDocument(tenA, { id: conflictWorkOrder, type: 'work-order', stage: 'linked' });
  await makeExtractions(tenA, conflictWorkOrder, conflictEquip, [
    { key: 'service_address', value: '412 Elm St', confidence: 0.95 },
    { key: 'service_date', value: '2026-08-05', confidence: 0.95 },
  ]);
  await linkCustomer(tenA, conflictWorkOrder, conflictCust);

  await makeDocument(tenA, { id: dispatch1, type: 'dispatch-note' });
  await makeExtractions(tenA, dispatch1, conflictEquip, [{ key: 'technician', value: 'Mike Rivera', confidence: 0.6 }]);
  await linkCustomer(tenA, dispatch1, conflictCust);

  await makeDocument(tenA, { id: dispatch2, type: 'dispatch-note' });
  await makeExtractions(tenA, dispatch2, conflictEquip, [{ key: 'technician', value: 'Miguel Rivera', confidence: 0.6 }]);
  await linkCustomer(tenA, dispatch2, conflictCust);

  const r3 = await A.runIntakeAutofill(ctxA, conflictWorkOrder, {
    resolvedType: 'work-order', entityId: conflictEquip, customerId: conflictCust,
    facts: { service_address: '412 Elm St', service_date: '2026-08-05' },
  });
  check('genuine conflict: NOT filled, ONE precise question raised instead', !r3.filled.includes('technician') && r3.questions.includes('technician'), JSON.stringify(r3));
  check('genuine conflict: the document is NOT auto-verified', r3.verified === false);

  let ni = await getNeedsInfo(tenA, conflictWorkOrder);
  check('needs-info: exactly one open row, carrying both candidate answers (never a blank form)', ni.length === 1 && ni[0].status === 'open' && ni[0].candidates.length === 2, JSON.stringify(ni));
  check('needs-info: the question names both technicians', /Mike Rivera/.test(ni[0].question) && /Miguel Rivera/.test(ni[0].question), ni[0]?.question);

  // ---- rule 3: a later, more decisive document arrives and resolves the earlier question ----
  await makeDocument(tenA, { id: lateDispatch, type: 'dispatch-note' });
  await makeExtractions(tenA, lateDispatch, conflictEquip, [{ key: 'technician', value: 'Mike Rivera', confidence: 0.98 }]);
  await linkCustomer(tenA, lateDispatch, conflictCust);

  await A.runIntakeAutofill(ctxA, lateDispatch, {
    resolvedType: 'dispatch-note', entityId: conflictEquip, customerId: conflictCust,
    facts: { customer_name: 'Karen Abernathy' },
  });

  ni = await getNeedsInfo(tenA, conflictWorkOrder);
  check('late arrival: the earlier question is now resolved, in the decisive document\'s favor', ni[0].status === 'resolved' && ni[0].resolved_value === 'Mike Rivera' && ni[0].resolved_by === 'ai:autofill', JSON.stringify(ni));

  const infs = await getInferences(tenA, conflictWorkOrder);
  check('late arrival: the resolution is filled in with its own provenance', infs.length === 1 && infs[0].value === 'Mike Rivera' && infs[0].source_document_id === lateDispatch && infs[0].rule === 'sibling-fill-late-arrival', JSON.stringify(infs));

  const doc = await getDoc(tenA, conflictWorkOrder);
  check('late arrival: the ORIGINAL work order retroactively auto-verifies now that it is complete', doc.stage === 'verified' && doc.verified_by === 'ai', JSON.stringify(doc));
}

/* ================================================================ 5. ambiguous customer match */
{
  const carol = uid('a', 'c', 3);
  const carlos = uid('a', 'c', 4);
  const correspondence = uid('a', 'd', 7);

  await makeEntity(tenA, { id: carol, type: 'customer', data: { customer_name: 'Carol Rios', service_address: '581 W Thomas Rd' } });
  await makeEntity(tenA, { id: carlos, type: 'customer', data: { customer_name: 'Carlos Rios', service_address: '999 Other St' } });

  await makeDocument(tenA, { id: correspondence, type: 'correspondence' });
  await makeExtractions(tenA, correspondence, null, [{ key: 'customer_name', value: 'Rios', confidence: 0.7 }]);

  const r5 = await A.runIntakeAutofill(ctxA, correspondence, {
    resolvedType: 'correspondence', entityId: null, customerId: null,
    facts: { customer_name: 'Rios', service_address: '581 W Thomas Rd' },
  });
  check('ambiguous customer: one precise question raised (owner\'s own worked example)', r5.questions.includes('customer_name'), JSON.stringify(r5));

  const ni = await getNeedsInfo(tenA, correspondence);
  check('ambiguous customer: question names the address and both candidates', ni.length === 1 && /581 W Thomas Rd/.test(ni[0].question) && /Carol Rios/.test(ni[0].question) && /Carlos Rios/.test(ni[0].question), ni[0]?.question);
  check('ambiguous customer: candidates carry each one\'s own address, for a UI to show', ni[0].candidates.every((c) => c.value && c.address));
}

/* ============================================================ 6. precision first: nothing anywhere */
{
  const lonelyEquip = uid('a', 'e', 9);
  const lonely = uid('a', 'd', 9);
  await makeEntity(tenA, { id: lonelyEquip, type: 'equipment', data: { serial_number: 'SN-LONELY' } });
  await makeDocument(tenA, { id: lonely, type: 'work-order' });
  await makeExtractions(tenA, lonely, lonelyEquip, [{ key: 'service_address', value: '1 Nowhere Rd', confidence: 0.9 }]);

  const r6 = await A.runIntakeAutofill(ctxA, lonely, {
    resolvedType: 'work-order', entityId: lonelyEquip, customerId: null,
    facts: { service_address: '1 Nowhere Rd' },
  });
  check('precision first: no siblings, no candidates -> no fill invented, no question raised either', r6.filled.length === 0 && r6.questions.length === 0, JSON.stringify(r6));
  const ni = await getNeedsInfo(tenA, lonely);
  const infs = await getInferences(tenA, lonely);
  check('precision first: nothing at all written for a field with zero evidence', ni.length === 0 && infs.length === 0);
}

/* ============================== 6b. equipment-scoped fields never cross a customer's OTHER unit
 * Reviewer blocking bug: a customer with two units had Unit B's model filled into Unit A's
 * document, auto-verified. */
{
  const cust = uid('a', 'c', 10);
  const unit1 = uid('a', 'e', 20);
  const unit2 = uid('a', 'e', 21);
  await makeEntity(tenA, { id: cust, type: 'customer', data: { customer_name: 'Multi Unit Customer', service_address: '55 Duplex Dr' } });
  await makeEntity(tenA, { id: unit1, type: 'equipment', data: { serial_number: 'SN-D1', model: 'Trane XR16' }, customerId: cust });
  await makeEntity(tenA, { id: unit2, type: 'equipment', data: { serial_number: 'SN-D2', model: 'Carrier 24ABC' }, customerId: cust });

  // A document naming neither serial and linked to NEITHER unit specifically (only the customer)
  // — the exact "which unit is this about" gap the bug used to paper over by guessing.
  const namePhoto = uid('a', 'd', 20);
  await makeDocument(tenA, { id: namePhoto, type: 'nameplate-photo' });
  await linkCustomer(tenA, namePhoto, cust);

  const rAmb = await A.runIntakeAutofill(ctxA, namePhoto, { resolvedType: 'nameplate-photo', entityId: null, customerId: cust, facts: {} });
  check('two units, no unit named: NEITHER serial nor model is guessed at from either unit', rAmb.filled.length === 0, JSON.stringify(rAmb));
  check('two units, no unit named: one precise question raised instead', rAmb.questions.includes('equipment_unit'), JSON.stringify(rAmb));
  const ambNi = await getNeedsInfo(tenA, namePhoto);
  const amb = ambNi.find((n) => n.field_key === 'equipment_unit');
  check('the question offers BOTH units as options, never a blank form', Boolean(amb) && amb.candidates.length === 2 && /SN-D1/.test(amb.question) && /SN-D2/.test(amb.question), amb?.question);
  const docAmb = await getDoc(tenA, namePhoto);
  check('two units, no unit named: the document is NOT auto-verified', docAmb.stage !== 'verified');

  // Same serial stated on two different documents -> fills correctly, entityId or not.
  const warrantyReg = uid('a', 'd', 21);
  const startupSheet = uid('a', 'd', 22);
  await makeDocument(tenA, { id: warrantyReg, type: 'warranty-registration' });
  await makeExtractions(tenA, warrantyReg, null, [{ key: 'serial_number', value: 'SN-SAME1', confidence: 0.95 }]);
  await makeDocument(tenA, { id: startupSheet, type: 'startup-sheet' });
  await makeExtractions(tenA, startupSheet, null, [
    { key: 'serial_number', value: 'SN-SAME1', confidence: 0.9 },
    { key: 'model', value: 'Trane XR16', confidence: 0.9 },
    { key: 'warranty_term', value: '10 years', confidence: 0.9 },
  ]);

  const rSerial = await A.runIntakeAutofill(ctxA, warrantyReg, { resolvedType: 'warranty-registration' });
  check('same serial across documents: model filled purely by the matching serial number (no entity link needed)', rSerial.filled.includes('model'), JSON.stringify(rSerial));
  check('same serial across documents: warranty term filled too', rSerial.filled.includes('warranty_expires'), JSON.stringify(rSerial));
  const serialInf = await getInferences(tenA, warrantyReg);
  const modelInf = serialInf.find((i) => i.field_key === 'model');
  check('same serial across documents: provenance points at the document that actually stated it', modelInf?.value === 'Trane XR16' && modelInf?.source_document_id === startupSheet);

  // Customer-scoped fields still legitimately cross a customer's units (the two-unit customer
  // above, on purpose) — unlike equipment-scoped ones, this is not the bug.
  const namedUnit1Doc = uid('a', 'd', 23);
  const namedUnit2Doc = uid('a', 'd', 24);
  await makeDocument(tenA, { id: namedUnit1Doc, type: 'dispatch-note' });
  await makeExtractions(tenA, namedUnit1Doc, unit1, [{ key: 'customer_name', value: 'Multi Unit Customer', confidence: 0.9 }]);
  await linkCustomer(tenA, namedUnit1Doc, cust);
  await makeDocument(tenA, { id: namedUnit2Doc, type: 'dispatch-note' });
  await makeExtractions(tenA, namedUnit2Doc, unit2, [{ key: 'service_date', value: '2026-09-01', confidence: 0.9 }]);
  await linkCustomer(tenA, namedUnit2Doc, cust);

  const rCustField = await A.runIntakeAutofill(ctxA, namedUnit2Doc, { resolvedType: 'dispatch-note', entityId: unit2, customerId: cust });
  check('customer-scoped field (customer_name) fills from a sibling on a DIFFERENT unit of the same customer', rCustField.filled.includes('customer_name'), JSON.stringify(rCustField));
}

/* ===================================================================== 7. tenant isolation */
{
  const equipB = uid('b', 'e', 1);
  const workOrderB = uid('b', 'd', 1);
  await makeEntity(tenB, { id: equipB, type: 'equipment', data: { serial_number: 'SN-B1' } });
  await makeDocument(tenB, { id: workOrderB, type: 'work-order' });
  await makeExtractions(tenB, workOrderB, equipB, [
    { key: 'service_address', value: '1 Other Tenant Rd', confidence: 0.95 },
    { key: 'service_date', value: '2026-08-01', confidence: 0.95 },
  ]);

  const rB = await A.runIntakeAutofill(ctxB, workOrderB, {
    resolvedType: 'work-order', entityId: equipB, customerId: null,
    facts: { service_address: '1 Other Tenant Rd', service_date: '2026-08-01' },
  });
  check('tenant isolation: tenant B\'s missing technician is NEVER filled from tenant A\'s "Mike Rivera" siblings', !rB.filled.includes('technician'), JSON.stringify(rB));
  const docB = await getDoc(tenB, workOrderB);
  check('tenant isolation: tenant B\'s document stays unverified (a real gap, correctly left alone)', docB.stage !== 'verified');
}

/* ===================================================================== 8. straight-through rate */
{
  const before = await withTenant(ctxA, (db) => intakeStatus(db));
  realLog(`NOTE  intake status on this fixture corpus: ${JSON.stringify(before)}`);
  check('status: needs_info tracked once migration 43 is pasted', before.needsInfoTracked === true);
  check('status: total counts every document past received', before.total >= 8, before.total);
  check('status: at least the two auto-verified work orders count as straight-through', before.autoVerifiedCount >= 2, JSON.stringify(before));
  check('status: the still-open ambiguous-customer question is NOT counted as straight-through', before.openQuestions >= 1);
  check('status: straightThroughRate is a real fraction in [0, 1]', before.straightThroughRate > 0 && before.straightThroughRate <= 1, before.straightThroughRate);

  // Resolve the open question a human's way and confirm the rate can only be told apart from an
  // AI auto-verify, not silently double-counted as straight-through.
  await lite.query(`UPDATE intake_needs_info SET status = 'resolved', resolved_by = 'human:owner', resolved_at = NOW() WHERE tenant_id = $1 AND status = 'open'`, [tenA]);
  await lite.query(`UPDATE documents SET stage = 'verified', verified_by = 'human', verified_at = NOW() WHERE id = $1`, [uid('a', 'd', 7)]);
  const after = await withTenant(ctxA, (db) => intakeStatus(db));
  check('status: a human-verified document does not inflate the AI straight-through count', after.autoVerifiedCount === before.autoVerifiedCount, JSON.stringify({ before, after }));
  check('status: humanVerified now reflects the human resolution', after.humanVerified >= 1);
}

/* =========================================================== 9. completeIntake wiring, no throw */
{
  const equip = uid('a', 'e', 1);
  const workOrder = uid('a', 'd', 1);
  let threw = null;
  try {
    await A.completeIntake(ctxA, workOrder, { resolvedType: 'work-order', entityId: equip, customerId: uid('a', 'c', 1) });
  } catch (err) {
    threw = err;
  }
  check('completeIntake: never throws even though api/_lib/naming/ does not exist in this worktree', threw === null, String(threw));
}

console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll ${passes} intake-autofill checks passed.`);
process.exit(failures ? 1 : 0);
