/**
 * THE CLEAN EXCEPTION QUEUE — api/_lib/intake/queue.js (list + per-document summaries),
 * api/_lib/routes/intake-status.js's `?queue=1`/`?documentIds=` extensions, and the write side
 * (api/_lib/routes/intake-resolve.js, wired into api/account.js as `?action=intake`), reusing
 * reviewStore.js's own correctField/linkDocument/assignDocumentCustomer exactly as that route
 * does (Round 13, H2).
 *
 * Real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations, queried as the app's
 * non-superuser role (deepwell_rls) — same harness as scripts/verify-intake-autofill.mjs. The
 * write route itself (Clerk auth) is not exercised over HTTP — same discipline as
 * scripts/verify-review.mjs, which tests reviewStore.js directly rather than faking a Clerk
 * token — but every line intake-resolve.js's handler runs (write the correction/link, close the
 * needs-info row, cascade through completeIntake) is exercised here in that exact order, plus a
 * source-level check that the route carries no admin gate.
 *
 *   1. listIntakeQueue: shape, evidence excerpts, filled-field chips w/ provenance, pagination
 *   2. resolve (field conflict): writes the correction, closes the question, cascades to verified
 *   3. resolve (equipment_unit): links the document, and the NEXT autofill pass sees that link
 *      (loadDocumentContext's document_entity_links fallback) instead of re-raising the ambiguity
 *   4. dismiss: permanent — a later, decisive sibling must NOT reopen it
 *   5. snooze: hidden from the queue while in the future, counted again once it lapses; the STP
 *      openQuestions count is unaffected either way (still a real, unanswered `status='open'` row)
 *   6. documentIntakeSummaries: the Scan tab's post-upload line, filled-count includes inferred fields
 *   7. tenant isolation
 *   8. idempotency: resolving/dismissing an already-closed question is a safe no-op, never a throw
 *   9. source check: intake-resolve.js has no admin/role gate; api/account.js wires it up
 *
 *   node scripts/verify-intake-queue.mjs
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

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ============================================================ 9a. source-level permission check */
{
  const routeSrc = fs.readFileSync(path.join(ROOT, 'api/_lib/routes/intake-resolve.js'), 'utf8');
  check('intake-resolve.js requires auth (requireAuth)', /requireAuth/.test(routeSrc));
  check('intake-resolve.js carries NO admin/role gate — any tenant member may resolve/dismiss/snooze', !/requireRole/.test(routeSrc));
  const accountSrc = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
  check('api/account.js wires the intake route in under ?action=intake', /intake:\s*intake\b/.test(accountSrc.replace(/\s+/g, ' ')) || /\bintake\b.*intake-resolve\.js/.test(accountSrc));
  check('api/account.js imports intake-resolve.js', /from ["']\.\/_lib\/routes\/intake-resolve\.js["']/.test(accountSrc));
}

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
check('harness: migration 45 loaded cleanly (snoozed_until + index)', !harnessNotes.some((n) => n.startsWith('45-')), harnessNotes.join(' | '));
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
const Q = await import('../api/_lib/intake/queue.js');
const A = await import('../api/_lib/intake/autofill.js');
const R = await import('../api/_lib/reviewStore.js');

const ctxA = { tenantKey: 'org_iq_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_iq_b', tenantName: 'Other Shop' };
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
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, extracted_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
    [id, tenantId, `doc-${seq}.pdf`, type, `hash-${tenantId}-${seq}`, stage]
  );
}
async function makeExtractions(tenantId, documentId, entityId, fields) {
  for (const f of fields) {
    let facetId = null;
    if (f.page != null) {
      seq++;
      const fid = uid('f', '9', seq);
      await lite.query(
        `INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at)
         VALUES ($1,$2,$3,$4,'fields',$5,$6,$7,$8,'registry',NOW())`,
        [fid, tenantId, documentId, f.page, f.labelRaw ?? f.key, f.valueRaw ?? f.value, f.confidence, f.key]
      );
      facetId = fid;
    }
    seq++;
    await lite.query(
      `INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9 || ' seconds')::interval)`,
      [uid('e', '9', seq), tenantId, documentId, entityId, f.key, f.value, f.confidence, facetId, String(seq)]
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
async function getNeedsInfo(tenantId, documentId, fieldKey) {
  const r = await lite.query(`SELECT * FROM intake_needs_info WHERE tenant_id = $1 AND document_id = $2 AND field_key = $3`, [tenantId, documentId, fieldKey]);
  return r.rows[0] ?? null;
}

/* ===================================================== 1 & 2. list + resolve a field conflict */
let workOrder, dispatch1, dispatch2, equip, cust;
{
  cust = uid('a', 'c', 1);
  equip = uid('a', 'e', 1);
  workOrder = uid('a', 'd', 1);
  dispatch1 = uid('a', 'd', 2);
  dispatch2 = uid('a', 'd', 3);

  await makeEntity(tenA, { id: cust, type: 'customer', data: { customer_name: 'Karen Abernathy', service_address: '412 Elm St' } });
  await makeEntity(tenA, { id: equip, type: 'equipment', data: { serial_number: 'SN-Q1' }, customerId: cust });

  await makeDocument(tenA, { id: workOrder, type: 'work-order' });
  await makeExtractions(tenA, workOrder, equip, [
    { key: 'service_address', value: '412 Elm St', confidence: 0.95 },
    { key: 'service_date', value: '2026-08-05', confidence: 0.95 },
  ]);
  await linkCustomer(tenA, workOrder, cust);

  await makeDocument(tenA, { id: dispatch1, type: 'dispatch-note' });
  await makeExtractions(tenA, dispatch1, equip, [{ key: 'technician', value: 'Mike Rivera', confidence: 0.6, page: 1, valueRaw: 'Tech: Mike Rivera' }]);
  await linkCustomer(tenA, dispatch1, cust);

  await makeDocument(tenA, { id: dispatch2, type: 'dispatch-note' });
  await makeExtractions(tenA, dispatch2, equip, [{ key: 'technician', value: 'Miguel Rivera', confidence: 0.6, page: 1, valueRaw: 'Tech: Miguel Rivera' }]);
  await linkCustomer(tenA, dispatch2, cust);

  await A.runIntakeAutofill(ctxA, workOrder, { resolvedType: 'work-order', entityId: equip, customerId: cust, facts: { service_address: '412 Elm St', service_date: '2026-08-05' } });

  const page = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 20 }));
  check('listIntakeQueue: tracked', page.tracked === true);
  const item = page.items.find((i) => i.documentId === workOrder);
  check('listIntakeQueue: the conflicted work order appears with its ONE question', Boolean(item), JSON.stringify(page.items.map((i) => i.documentId)));
  check('listIntakeQueue: question names both technicians, in plain language', /Mike Rivera/.test(item?.question ?? '') && /Miguel Rivera/.test(item?.question ?? ''));
  check('listIntakeQueue: two candidates, each carrying its source document + page', item?.candidates.length === 2 && item.candidates.every((c) => c.kind === 'value' && c.documentId && c.page === 1), JSON.stringify(item?.candidates));
  check('listIntakeQueue: candidate evidence pulled from the source facet\'s printed text', item.candidates.some((c) => /Tech:/.test(c.evidence ?? '')), JSON.stringify(item.candidates));
  check('listIntakeQueue: candidate carries a real source document label, not a bare id', item.candidates.every((c) => c.sourceDocumentLabel && !/^[0-9a-f-]{20,}$/.test(c.sourceDocumentLabel)), JSON.stringify(item.candidates.map((c) => c.sourceDocumentLabel)));
  check('listIntakeQueue: filledFields carries what this document DOES have, for the confidence chips', item.filledFields.some((f) => f.fieldKey === 'service_address' && f.source === 'stated'), JSON.stringify(item.filledFields));
  check('listIntakeQueue: extracted shape is present for client-side documentName()', Array.isArray(item.extracted) && item.extracted.some((f) => f.name === 'service_address'));
  check('listIntakeQueue: fieldLabel is a plain word, not the raw key', item.fieldLabel === 'Technician');

  // ---- resolve: exactly what intake-resolve.js's handler does, in order ----
  const chosen = 'Mike Rivera';
  await R.correctField(ctxA, { documentId: workOrder, fieldKey: 'technician', value: chosen, by: 'Test Tech' }, 'user_test');
  await withTenant(ctxA, (db) => A.markNeedsInfoResolved(db, { documentId: workOrder, fieldKey: 'technician', value: chosen, resolvedBy: 'human:Test Tech' }));
  const cascade = await A.completeIntake(ctxA, workOrder, {});
  check('resolve: completeIntake cascade never throws and reports verified', cascade.ok !== false);

  const resolvedRow = await getNeedsInfo(tenA, workOrder, 'technician');
  check('resolve: the needs-info row is closed with the human\'s answer on file', resolvedRow?.status === 'resolved' && resolvedRow.resolved_value === chosen && resolvedRow.resolved_by === 'human:Test Tech', JSON.stringify(resolvedRow));
  const doc = await getDoc(tenA, workOrder);
  check('resolve: the document is now verified (the cascade re-ran auto-verify)', doc.stage === 'verified', JSON.stringify(doc));

  const pageAfter = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 20 }));
  check('resolve: the resolved document no longer appears in the queue', !pageAfter.items.some((i) => i.documentId === workOrder), JSON.stringify(pageAfter.items.map((i) => i.documentId)));

  // ---- idempotency: resolving again (e.g. a double-tap) must not throw or duplicate anything ----
  let threw = null;
  try {
    await R.correctField(ctxA, { documentId: workOrder, fieldKey: 'technician', value: chosen, by: 'Test Tech' }, 'user_test');
    await withTenant(ctxA, (db) => A.markNeedsInfoResolved(db, { documentId: workOrder, fieldKey: 'technician', value: chosen, resolvedBy: 'human:Test Tech' }));
    await A.completeIntake(ctxA, workOrder, {});
  } catch (err) { threw = err; }
  check('idempotency: resolving an already-resolved question again is a safe no-op', threw === null, String(threw));
  const stillOne = await lite.query(`SELECT count(*)::int AS n FROM intake_needs_info WHERE tenant_id = $1 AND document_id = $2 AND field_key = 'technician'`, [tenA, workOrder]);
  check('idempotency: still exactly one needs-info row for this (document, field)', stillOne.rows[0].n === 1);
}

/* ============================================================== 3. resolve an equipment_unit pick */
let multiCust, unit1, unit2, namePhoto;
{
  multiCust = uid('a', 'c', 10);
  unit1 = uid('a', 'e', 20);
  unit2 = uid('a', 'e', 21);
  namePhoto = uid('a', 'd', 20);

  await makeEntity(tenA, { id: multiCust, type: 'customer', data: { customer_name: 'Multi Unit Customer', service_address: '55 Duplex Dr' } });
  await makeEntity(tenA, { id: unit1, type: 'equipment', data: { serial_number: 'SN-QD1', model: 'Trane XR16' }, customerId: multiCust });
  await makeEntity(tenA, { id: unit2, type: 'equipment', data: { serial_number: 'SN-QD2', model: 'Carrier 24ABC' }, customerId: multiCust });
  await makeDocument(tenA, { id: namePhoto, type: 'nameplate-photo' });
  await linkCustomer(tenA, namePhoto, multiCust);

  await A.runIntakeAutofill(ctxA, namePhoto, { resolvedType: 'nameplate-photo', entityId: null, customerId: multiCust, facts: {} });

  const page = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 50 }));
  const item = page.items.find((i) => i.documentId === namePhoto);
  check('equipment_unit: raised as a distinct kind ("entity"), never a bare document/page evidence claim', Boolean(item) && item.candidates.every((c) => c.kind === 'entity' && c.documentId === null), JSON.stringify(item?.candidates));
  check('equipment_unit: both units offered by their real serials', item.candidates.some((c) => /SN-QD1/.test(c.label)) && item.candidates.some((c) => /SN-QD2/.test(c.label)), JSON.stringify(item.candidates));

  const pick = item.candidates.find((c) => /SN-QD1/.test(c.label));
  await R.linkDocument(ctxA, { documentId: namePhoto, entityId: pick.entityId, by: 'Test Tech' }, 'user_test');
  await withTenant(ctxA, (db) => A.markNeedsInfoResolved(db, { documentId: namePhoto, fieldKey: 'equipment_unit', value: pick.label, resolvedBy: 'human:Test Tech' }));
  await A.completeIntake(ctxA, namePhoto, {});

  // The document's OWN extractions still never named a unit — this only works if loadDocumentContext
  // falls back to document_entity_links for entityId (the reviewer-note fix in autofill.js).
  const r2 = await A.runIntakeAutofill(ctxA, namePhoto, {}); // re-derive everything fresh from the DB
  check('equipment_unit resolved: re-running autofill no longer raises the ambiguity again', !r2.questions.includes('equipment_unit'), JSON.stringify(r2));
}

/* ========================================================================= 4. dismiss is permanent */
let dismissDoc, dismissSib1, dismissSib2, dismissCust, dismissEquip;
{
  dismissCust = uid('a', 'c', 30);
  dismissEquip = uid('a', 'e', 30);
  dismissDoc = uid('a', 'd', 30);
  dismissSib1 = uid('a', 'd', 31);
  dismissSib2 = uid('a', 'd', 32);

  await makeEntity(tenA, { id: dismissCust, type: 'customer', data: { customer_name: 'Dismiss Test', service_address: '1 Dismiss Ln' } });
  await makeEntity(tenA, { id: dismissEquip, type: 'equipment', data: { serial_number: 'SN-DISMISS' }, customerId: dismissCust });
  await makeDocument(tenA, { id: dismissDoc, type: 'work-order' });
  await makeExtractions(tenA, dismissDoc, dismissEquip, [{ key: 'service_address', value: '1 Dismiss Ln', confidence: 0.9 }, { key: 'service_date', value: '2026-08-09', confidence: 0.9 }]);
  await linkCustomer(tenA, dismissDoc, dismissCust);
  await makeDocument(tenA, { id: dismissSib1, type: 'dispatch-note' });
  await makeExtractions(tenA, dismissSib1, dismissEquip, [{ key: 'technician', value: 'Ana Ruiz', confidence: 0.6 }]);
  await linkCustomer(tenA, dismissSib1, dismissCust);
  await makeDocument(tenA, { id: dismissSib2, type: 'dispatch-note' });
  await makeExtractions(tenA, dismissSib2, dismissEquip, [{ key: 'technician', value: 'Anna Ruiz', confidence: 0.6 }]);
  await linkCustomer(tenA, dismissSib2, dismissCust);

  await A.runIntakeAutofill(ctxA, dismissDoc, { resolvedType: 'work-order', entityId: dismissEquip, customerId: dismissCust });
  const before = await getNeedsInfo(tenA, dismissDoc, 'technician');
  check('dismiss fixture: a real open question exists first', before?.status === 'open');

  const dismissed = await withTenant(ctxA, (db) => A.dismissNeedsInfo(db, { documentId: dismissDoc, fieldKey: 'technician', resolvedBy: 'human:Test Tech' }));
  check('dismiss: reports success', dismissed === true);
  const afterDismiss = await getNeedsInfo(tenA, dismissDoc, 'technician');
  check('dismiss: status is "dismissed", not "resolved"', afterDismiss.status === 'dismissed');

  // A decisive late arrival must NOT reopen a row a person already dismissed.
  const lateDecisive = uid('a', 'd', 33);
  await makeDocument(tenA, { id: lateDecisive, type: 'dispatch-note' });
  await makeExtractions(tenA, lateDecisive, dismissEquip, [{ key: 'technician', value: 'Ana Ruiz', confidence: 0.98 }]);
  await linkCustomer(tenA, lateDecisive, dismissCust);
  await A.runIntakeAutofill(ctxA, lateDecisive, { resolvedType: 'dispatch-note', entityId: dismissEquip, customerId: dismissCust });
  const stillDismissed = await getNeedsInfo(tenA, dismissDoc, 'technician');
  check('dismiss: permanent — a later sibling\'s decisive value never reopens a dismissed row', stillDismissed.status === 'dismissed', JSON.stringify(stillDismissed));

  const idempotentDismiss = await withTenant(ctxA, (db) => A.dismissNeedsInfo(db, { documentId: dismissDoc, fieldKey: 'technician', resolvedBy: 'human:Test Tech' }));
  check('idempotency: dismissing an already-dismissed row is a safe no-op (reports false, never throws)', idempotentDismiss === false);
}

/* ========================================================================== 5. snooze */
let snoozeDoc;
{
  const snoozeCust = uid('a', 'c', 40);
  const snoozeEquip = uid('a', 'e', 40);
  snoozeDoc = uid('a', 'd', 40);
  const snoozeSib1 = uid('a', 'd', 41);
  const snoozeSib2 = uid('a', 'd', 42);
  await makeEntity(tenA, { id: snoozeCust, type: 'customer', data: { customer_name: 'Snooze Test', service_address: '2 Snooze Ct' } });
  await makeEntity(tenA, { id: snoozeEquip, type: 'equipment', data: { serial_number: 'SN-SNOOZE' }, customerId: snoozeCust });
  await makeDocument(tenA, { id: snoozeDoc, type: 'work-order' });
  await makeExtractions(tenA, snoozeDoc, snoozeEquip, [{ key: 'service_address', value: '2 Snooze Ct', confidence: 0.9 }, { key: 'service_date', value: '2026-08-11', confidence: 0.9 }]);
  await linkCustomer(tenA, snoozeDoc, snoozeCust);
  await makeDocument(tenA, { id: snoozeSib1, type: 'dispatch-note' });
  await makeExtractions(tenA, snoozeSib1, snoozeEquip, [{ key: 'technician', value: 'Wade Long', confidence: 0.6 }]);
  await linkCustomer(tenA, snoozeSib1, snoozeCust);
  await makeDocument(tenA, { id: snoozeSib2, type: 'dispatch-note' });
  await makeExtractions(tenA, snoozeSib2, snoozeEquip, [{ key: 'technician', value: 'Wade Lang', confidence: 0.6 }]);
  await linkCustomer(tenA, snoozeSib2, snoozeCust);
  await A.runIntakeAutofill(ctxA, snoozeDoc, { resolvedType: 'work-order', entityId: snoozeEquip, customerId: snoozeCust });

  const future = new Date(Date.now() + 60_000).toISOString();
  const snoozed = await withTenant(ctxA, (db) => A.snoozeNeedsInfo(db, { documentId: snoozeDoc, fieldKey: 'technician', until: future }));
  check('snooze: reports success (migration 45 present)', snoozed === true);

  const pageWhileSnoozed = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 50 }));
  check('snooze: hidden from the queue while snoozed_until is in the future', !pageWhileSnoozed.items.some((i) => i.documentId === snoozeDoc));
  const statusWhileSnoozed = await withTenant(ctxA, (db) => intakeStatus(db));
  const stillOpenRow = await getNeedsInfo(tenA, snoozeDoc, 'technician');
  check('snooze: the row itself STAYS status=open (a snooze is not an answer)', stillOpenRow.status === 'open');
  check('snooze: openQuestions (the STP metric) still counts it — snoozing never inflates the straight-through rate', statusWhileSnoozed.openQuestions >= 1);

  const past = new Date(Date.now() - 60_000).toISOString();
  await withTenant(ctxA, (db) => A.snoozeNeedsInfo(db, { documentId: snoozeDoc, fieldKey: 'technician', until: past }));
  const pageAfterLapse = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 50 }));
  check('snooze: reappears in the queue once snoozed_until has passed', pageAfterLapse.items.some((i) => i.documentId === snoozeDoc));
}

/* ============================================================ 6. documentIntakeSummaries (Scan tab) */
{
  const summaries = await withTenant(ctxA, (db) => Q.documentIntakeSummaries(db, [workOrder, snoozeDoc, uid('a', 'd', 999)]));
  const wo = summaries.find((s) => s.documentId === workOrder);
  check('documentIntakeSummaries: the now-verified work order reports verified with no open question', wo?.verified === true && wo.openQuestion === null, JSON.stringify(wo));
  check('documentIntakeSummaries: filledCount reflects the fill (technician + the two originally-stated fields)', wo.filledCount === wo.totalRequired, JSON.stringify(wo));
  const sd = summaries.find((s) => s.documentId === snoozeDoc);
  check('documentIntakeSummaries: a snoozed-but-still-open question still surfaces as the open question to answer', sd?.openQuestion?.fieldKey === 'technician', JSON.stringify(sd));
  check('documentIntakeSummaries: an unknown/deleted id is simply absent, never an error', !summaries.some((s) => s.documentId === uid('a', 'd', 999)));
}

/* ===================================================================== 7. tenant isolation */
{
  const equipB = uid('b', 'e', 1);
  const docB = uid('b', 'd', 1);
  const sib1B = uid('b', 'd', 2);
  const sib2B = uid('b', 'd', 3);
  await makeEntity(tenB, { id: equipB, type: 'equipment', data: { serial_number: 'SN-B1' } });
  await makeDocument(tenB, { id: docB, type: 'work-order' });
  await makeExtractions(tenB, docB, equipB, [{ key: 'service_address', value: '1 Other Tenant Rd', confidence: 0.95 }, { key: 'service_date', value: '2026-08-01', confidence: 0.95 }]);
  await makeDocument(tenB, { id: sib1B, type: 'dispatch-note' });
  await makeExtractions(tenB, sib1B, equipB, [{ key: 'technician', value: 'Pat Cross', confidence: 0.6 }]);
  await makeDocument(tenB, { id: sib2B, type: 'dispatch-note' });
  await makeExtractions(tenB, sib2B, equipB, [{ key: 'technician', value: 'Patt Cross', confidence: 0.6 }]);
  await A.runIntakeAutofill(ctxB, docB, { resolvedType: 'work-order', entityId: equipB });

  const pageA = await withTenant(ctxA, (db) => Q.listIntakeQueue(db, { limit: 100 }));
  const pageB = await withTenant(ctxB, (db) => Q.listIntakeQueue(db, { limit: 100 }));
  check('tenant isolation: tenant A\'s queue never lists tenant B\'s document', !pageA.items.some((i) => i.documentId === docB));
  check('tenant isolation: tenant B DOES see its own open question', pageB.items.some((i) => i.documentId === docB));
  check('tenant isolation: tenant B\'s candidates never leak tenant A\'s document labels', pageB.items.find((i) => i.documentId === docB).candidates.every((c) => !c.sourceDocumentLabel || !/Elm/.test(c.sourceDocumentLabel)));
}

console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll ${passes} intake-queue checks passed.`);
process.exit(failures ? 1 : 0);
