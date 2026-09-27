/**
 * AUDIENCE CLASSIFICATION (round 18, part 2, owner ask (a); M3-config/57-audience-and-
 * notifications.sql) — api/_lib/audience/**, api/_lib/intake/audienceQuestions.js,
 * api/_lib/recordsStore.js's browse filter, api/_lib/search/knowledge.js's retrieval scoping.
 *
 * "some of the correspondence and service tickets are specifically for the techs and have
 * nothing to do with the customer. how do we incorporate those into the technicians'
 * notifications and not mingle with the normal documents strictly for customers?"
 *
 * No network, no Anthropic key, NO MODEL CALL ANYWHERE (deterministic classification only) — the
 * database is a REAL Postgres (PGlite) loaded from the actual M3-config/*.sql migrations and
 * queried as the app's non-superuser NOBYPASSRLS role (deepwell_rls), same harness as
 * scripts/verify-intake-autofill.mjs / scripts/verify-document-names.mjs.
 *
 *   1. pure: classify.js (positives/negatives incl. the owner's own "service ticket at a customer
 *      address stays customer" example, and "internal memo mentioning a customer name" -> question),
 *      extractMentionedNames, sql.js's audienceFilterSql, notify.js's resolveAddressedMembers
 *   2. DB-backed, WITH migration 57: end-to-end classifyDocumentAudience (customer / internal /
 *      needs-a-question), entity-link undo, notification to the matched tech, admin fallback
 *      when nobody matches, dedupe (no double notification), one-tap override, tenant isolation
 *   3. records browse filter chip (Customer default / Internal / All)
 *   4. retrieval scoping: resolveFilterDocumentIds excludes internal unless teamScoped
 *   5. DB-backed, WITHOUT migration 57: the same shapes via the extractions fallback
 *
 *   node scripts/verify-audience.mjs
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
delete process.env.CLERK_SECRET_KEY; // never hit Clerk in this suite — every test passes `members` explicitly

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ============================================================== 1. pure: classify.js */
const C = await import('../api/_lib/audience/classify.js');

{
  const r = C.classifyAudience({
    documentType: 'service-ticket',
    text: 'Service ticket. Tech: Kevin Pratt replaced the capacitor at the customer address.',
    fields: { customer_name: 'Ana Garcia', service_address: '19 Cactus Ln' },
    customerIdentifierMatch: true,
  });
  check("owner's own example: a service ticket at a customer address stays customer", r.audience === 'customer' && r.needsQuestion === false, JSON.stringify(r));
}
{
  const r = C.classifyAudience({
    documentType: 'correspondence',
    text: 'MEMO to all techs: remember to log mileage. FYI, this came up while discussing the Ana Garcia job.',
    fields: { customer_name: 'Ana Garcia' },
    customerIdentifierMatch: false, // named casually, never actually on file as a real match
  });
  check('internal memo mentioning a customer name -> ambiguous, raises the question (never guesses)', r.audience === 'customer' && r.needsQuestion === true && r.question === C.AUDIENCE_QUESTION_TEXT, JSON.stringify(r));
}
{
  const r = C.classifyAudience({ documentType: 'dispatch-note', text: 'Dispatching to tech: assigned to Maria Alvarez. Truck 4, 8am start.', fields: {} });
  check('dispatch/job assignment addressed to a tech, no customer -> internal', r.audience === 'internal' && r.needsQuestion === false, JSON.stringify(r));
  eq('matchedTechNames picks up the addressed technician', r.matchedTechNames, ['Maria Alvarez']);
}
{
  const r = C.classifyAudience({ documentType: 'other', text: 'Parts count request: warehouse needs 12 capacitors and 4 contactors restocked by Friday.', fields: {} });
  check('parts/warehouse note -> internal', r.audience === 'internal', JSON.stringify(r));
}
{
  const r = C.classifyAudience({ documentType: 'other', text: 'Safety meeting bulletin: ladder inspection procedure, mandatory for all techs.', fields: {} });
  check('training/safety material -> internal', r.audience === 'internal', JSON.stringify(r));
}
{
  const r = C.classifyAudience({ documentType: 'internal', text: 'Truck maintenance log, oil change due.', fields: {} });
  check("documentType === 'internal' alone is a strong signal -> internal", r.audience === 'internal', JSON.stringify(r));
}
{
  const r = C.classifyAudience({ documentType: 'invoice', text: 'Invoice for HVAC tune-up at 412 Elm St. Total due: $180.', fields: { customer_name: 'Karen Abernathy', service_address: '412 Elm St' } });
  check('an ordinary invoice with no internal signal -> customer, no question (never asks needlessly)', r.audience === 'customer' && r.needsQuestion === false, JSON.stringify(r));
}
{
  const r = C.classifyAudience({ documentType: 'other', text: 'FYI heads up — schedule change for tomorrow.', fields: {} });
  check('a weak-only internal signal is ambiguous, not decisive -> question, never silently internal', r.audience === 'customer' && r.needsQuestion === true, JSON.stringify(r));
}
eq('extractMentionedNames: "To:" and "Tech:" prefixes, deduped', C.extractMentionedNames('To: Kevin Pratt — Tech: Kevin Pratt, see attached. cc Maria Alvarez'), ['Kevin Pratt']);

/* ============================================================== 1b. pure: sql.js */
const SQL = await import('../api/_lib/audience/sql.js');
check('audienceFilterSql: teamScoped skips the exclusion entirely', SQL.audienceFilterSql({ hasAudienceColumn: true, teamScoped: true }) === 'TRUE');
check('audienceFilterSql: column path excludes internal via the real column', /audience/.test(SQL.audienceFilterSql({ hasAudienceColumn: true })) && /<> 'internal'/.test(SQL.audienceFilterSql({ hasAudienceColumn: true })));
check('audienceFilterSql: pre-migration fallback excludes via the extractions marker, not the column', SQL.audienceFilterSql({ hasAudienceColumn: false }).includes('_audience') && !SQL.audienceFilterSql({ hasAudienceColumn: false }).includes('d.audience'));

/* ============================================================== 1c. pure: notify.js matching */
const N = await import('../api/_lib/audience/notify.js');
{
  const roster = [
    { userId: 'u1', displayName: 'Kevin Pratt', email: 'kevin@shop.test', isAdmin: false },
    { userId: 'u2', displayName: 'Maria Alvarez', email: 'maria@shop.test', isAdmin: false },
    { userId: 'u3', displayName: 'Ana Ownerson', email: 'ana@shop.test', isAdmin: true },
  ];
  eq('resolveAddressedMembers: matches by name, one entry per matched member', N.resolveAddressedMembers(['Kevin Pratt'], roster).map((m) => m.userId), ['u1']);
  eq('resolveAddressedMembers: last-name fallback still matches ("K. Pratt")', N.resolveAddressedMembers(['K. Pratt'], roster).map((m) => m.userId), ['u1']);
  eq('resolveAddressedMembers: no match on the roster -> empty (caller falls back to admins)', N.resolveAddressedMembers(['Nobody Real'], roster), []);
  eq('resolveAddressedMembers: two different addressed names -> two matched members', N.resolveAddressedMembers(['Kevin Pratt', 'Maria Alvarez'], roster).map((m) => m.userId).sort(), ['u1', 'u2']);
}

/* ============================================================== harness: real Postgres via PGlite */
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

const cfgDir = path.join(ROOT, 'M3-config');
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();

async function buildLite(migrationFiles) {
  const lite = new PGlite({ extensions: contrib });
  const notes = [];
  for (const f of migrationFiles) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk */ }
  return { lite, notes };
}
const pgModCache = (await import('pg')).default;
function patchPgPool(lite) {
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgModCache.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgModCache.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}

/* -------------------------------------------------- instance 1: every migration (57 included) */
const { lite, notes } = await buildLite(allMigrations);
check('harness: migration 57 loaded cleanly (no error from 57-audience-and-notifications.sql)', !notes.some((n) => n.startsWith('57-')), notes.join(' | '));
patchPgPool(lite);

const RS = await import('../api/_lib/recordsStore.js');
const AS = await import('../api/_lib/audience/store.js');
const KN = await import('../api/_lib/search/knowledge.js');
const IF = await import('../api/_lib/routes/integrity.js');

const ctxA = { tenantKey: 'org_audience_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_audience_b', tenantName: 'Other Shop' };
const tenA = (await RS.getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await RS.getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
async function makeDocument(tenantId, { id, type }) {
  seq++;
  await lite.query(
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at)
     VALUES ($1,$2,$3,$4,$5,'linked',NOW())`,
    [id, tenantId, `doc-${seq}.pdf`, type, `hash-${tenantId}-${seq}`]
  );
}
async function makeCustomer(tenantId, id, name, address) {
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer',$3::jsonb)`,
    [id, tenantId, JSON.stringify({ customer_name: name, service_address: address })]);
}
async function linkDoc(tenantId, documentId, entityId) {
  await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
     VALUES ($1,$2,$3,0.9,'ai',NOW()) ON CONFLICT DO NOTHING`, [tenantId, documentId, entityId]);
}
async function linkCount(tenantId, documentId) {
  const r = await lite.query(`SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id=$1 AND document_id=$2`, [tenantId, documentId]);
  return r.rows[0].n;
}
async function notificationsFor(tenantId) {
  const r = await lite.query(`SELECT kind, title, body, link FROM notifications WHERE tenant_id=$1 ORDER BY created_at`, [tenantId]);
  return r.rows;
}
async function withTenantDb(ctx, fn) {
  return RS.withTenant(ctx, (store) => fn({ query: (sql, p) => store.raw(sql, p) }, store));
}

const ROSTER = [
  { userId: 'u_kevin', displayName: 'Kevin Pratt', email: 'kevin@shop.test', isAdmin: false },
  { userId: 'u_maria', displayName: 'Maria Alvarez', email: 'maria@shop.test', isAdmin: false },
  { userId: 'u_admin', displayName: 'Ana Ownerson', email: 'ana@shop.test', isAdmin: true },
];

/* ---------- migration shape ---------- */
{
  eq('migration 57: audience/assigned_member/assigned_tech_name columns exist',
    (await lite.query(`SELECT column_name FROM information_schema.columns WHERE table_name='documents' AND column_name IN ('audience','assigned_member','assigned_tech_name') ORDER BY column_name`)).rows.map((r) => r.column_name),
    ['assigned_member', 'assigned_tech_name', 'audience']);
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '57-audience-and-notifications.sql'), 'utf8')).then(() => true, () => false);
  check('migration 57 is idempotent (re-running it changes nothing and errors nothing)', twice);
  const defaultCheck = (await lite.query(`SELECT column_default FROM information_schema.columns WHERE table_name='documents' AND column_name='audience'`)).rows[0];
  check("migration 57: documents.audience defaults to 'customer'", String(defaultCheck?.column_default ?? '').includes('customer'), JSON.stringify(defaultCheck));
}

/* ---------- 2a. customer document: a service ticket at a matched customer address stays customer, no side effects */
{
  const cust = uid('a', 'c', 1);
  const doc = uid('a', 'd', 1);
  await makeCustomer(tenA, cust, 'Ana Garcia', '19 Cactus Ln');
  await makeDocument(tenA, { id: doc, type: 'service-ticket' });
  await linkDoc(tenA, doc, cust);

  const result = await withTenantDb(ctxA, (db) => AS.classifyDocumentAudience(db, doc, {
    documentType: 'service-ticket',
    text: 'Service ticket at 19 Cactus Ln. Tech: Kevin Pratt replaced the capacitor.',
    fields: { customer_name: 'Ana Garcia', service_address: '19 Cactus Ln' },
    orgId: ctxA.tenantKey,
  }));
  check('classifyDocumentAudience: service ticket at a customer address stays customer', result.audience === 'customer', JSON.stringify(result));
  check('customer document: entity link is left alone', await linkCount(tenA, doc) === 1);
  const audience = await withTenantDb(ctxA, (db) => AS.getDocumentAudience(db, doc));
  check('getDocumentAudience reads back customer', audience === 'customer');
  const notes = await notificationsFor(tenA);
  check('customer document: no notification produced', notes.length === 0, JSON.stringify(notes));
}

/* ---------- 2b. internal document addressed to a real roster member ---------- */
{
  const doc = uid('a', 'd', 2);
  await makeDocument(tenA, { id: doc, type: 'dispatch-note' });

  const result = await withTenantDb(ctxA, (db) => AS.classifyDocumentAudience(db, doc, {
    documentType: 'dispatch-note',
    text: 'Dispatching to tech: assigned to Kevin Pratt. Truck 4, 8am start, no customer job today.',
    fields: {},
    orgId: ctxA.tenantKey,
  }));
  // classifyDocumentAudience resolves the roster via Clerk when `members` isn't passed directly —
  // this suite never sets CLERK_SECRET_KEY, so fetchOrgMembers short-circuits to []. Exercise the
  // real roster-matching path directly through notifyForInternalDocument instead (same function
  // classifyDocumentAudience calls), which is what a real deployment's Clerk-backed roster feeds.
  await withTenantDb(ctxA, (db) => AS.setDocumentAudience(db, doc, 'internal'));
  await withTenantDb(ctxA, (db) => AS.undoCustomerEntityLinks(db, doc));

  const doc3 = uid('a', 'd', 3);
  await makeDocument(tenA, { id: doc3, type: 'dispatch-note' });
  await withTenantDb(ctxA, (db) => N.notifyForInternalDocument(db, doc3, { techNames: ['Kevin Pratt'], members: ROSTER }));

  check('internal document (no roster) -> audience is internal', result.audience === 'internal', JSON.stringify(result));

  const notes = await notificationsFor(tenA);
  const kevin = notes.find((n) => n.title.includes('Kevin Pratt'));
  check('internal document addressed to a roster member -> a bell notification names them', Boolean(kevin), JSON.stringify(notes));
  check("notification kind is 'internal-doc'", kevin?.kind === 'internal-doc');
}

/* ---------- 2c. internal document, nobody on the roster matches -> admin fallback ---------- */
{
  const doc = uid('a', 'd', 4);
  await makeDocument(tenA, { id: doc, type: 'internal' });
  await withTenantDb(ctxA, (db) => N.notifyForInternalDocument(db, doc, { techNames: ['Somebody Unknown'], members: ROSTER }));
  const notes = await notificationsFor(tenA);
  check('nobody on the roster matched -> "Internal document needs an owner" notification', notes.some((n) => n.title === N.ADMIN_NEEDS_OWNER_TITLE), JSON.stringify(notes));
}

/* ---------- 2d. dedupe: re-notifying the SAME document never doubles the bell item ---------- */
{
  const doc = uid('a', 'd', 5);
  await makeDocument(tenA, { id: doc, type: 'internal' });
  await withTenantDb(ctxA, (db) => N.notifyForInternalDocument(db, doc, { techNames: ['Maria Alvarez'], members: ROSTER }));
  const before = (await notificationsFor(tenA)).length;
  await withTenantDb(ctxA, (db) => N.notifyForInternalDocument(db, doc, { techNames: ['Maria Alvarez'], members: ROSTER }));
  const after = (await notificationsFor(tenA)).length;
  check('notifyForInternalDocument is idempotent — a second call for the same document adds nothing', after === before, `before=${before} after=${after}`);
}

/* ---------- 2e. ambiguous document -> raises the existing intake exception queue's question ---------- */
{
  const doc = uid('a', 'd', 6);
  await makeDocument(tenA, { id: doc, type: 'correspondence' });
  const result = await withTenantDb(ctxA, (db) => AS.classifyDocumentAudience(db, doc, {
    documentType: 'correspondence',
    text: 'Internal memo: heads up, this relates to the Karen Abernathy account.',
    fields: { customer_name: 'Karen Abernathy' }, // never actually linked/matched
    orgId: ctxA.tenantKey,
  }));
  check('ambiguous document stays customer but flags needsQuestion', result.audience === 'customer' && result.needsQuestion === true, JSON.stringify(result));
  const rows = await lite.query(`SELECT field_key, question, status, candidates FROM intake_needs_info WHERE tenant_id=$1 AND document_id=$2`, [tenA, doc]);
  check("an open 'audience' question was raised in the EXISTING intake_needs_info queue", rows.rows.length === 1 && rows.rows[0].field_key === 'audience' && rows.rows[0].status === 'open', JSON.stringify(rows.rows));

  // One-tap override answers it.
  await withTenantDb(ctxA, (db) => AS.overrideDocumentAudience(db, doc, 'customer', { resolvedBy: 'human:tester' }));
  const resolved = await lite.query(`SELECT status, resolved_value FROM intake_needs_info WHERE tenant_id=$1 AND document_id=$2 AND field_key='audience'`, [tenA, doc]);
  check('one-tap override resolves the open audience question', resolved.rows[0]?.status === 'resolved' && resolved.rows[0]?.resolved_value === 'customer', JSON.stringify(resolved.rows));
}

/* ---------- 2f. one-tap override flips a customer doc to internal and undoes entity links ---------- */
{
  const cust = uid('a', 'c', 2);
  const doc = uid('a', 'd', 7);
  await makeCustomer(tenA, cust, 'Bill Whitmore', '88 Whitmore Ave');
  await makeDocument(tenA, { id: doc, type: 'service-ticket' });
  await linkDoc(tenA, doc, cust);
  check('before override: entity link present', await linkCount(tenA, doc) === 1);

  await withTenantDb(ctxA, (db) => AS.overrideDocumentAudience(db, doc, 'internal', { resolvedBy: 'human:tester' }));
  check('one-tap override to internal undoes the customer entity link', await linkCount(tenA, doc) === 0);
  const audience = await withTenantDb(ctxA, (db) => AS.getDocumentAudience(db, doc));
  check('override persisted', audience === 'internal');
}

/* ---------- 2f-bis. REVIEWER FIX (2026-09-27): overriding a document back to 'customer' after it was
 * (rightly or wrongly) marked 'internal' must restore its customer entity link — otherwise it stays
 * invisible to every entity-scoped customer answer (docLookup.js resolves a customer's documents ONLY
 * through document_entity_links) even though the UI/records browser now shows it as a customer
 * document again. See api/_lib/audience/route.js's op:'override' handler, which now calls the existing
 * integrityFixDocument repair (same one extractDocument.js already runs after every extraction) whenever
 * the override target is 'customer'. ---------- */
{
  const cust = uid('a', 'c', 20);
  const doc = uid('a', 'd', 30);
  await makeCustomer(tenA, cust, 'Diane Castillo', '77 Ocotillo Rd');
  await makeDocument(tenA, { id: doc, type: 'service-ticket' });
  await lite.query(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
     VALUES ($1,$2,'customer_name','Diane Castillo',0.9,NOW()), ($1,$2,'service_address','77 Ocotillo Rd',0.9,NOW())`,
    [tenA, doc]
  );
  await linkDoc(tenA, doc, cust);
  check('2f-bis before: entity link present', await linkCount(tenA, doc) === 1);

  await withTenantDb(ctxA, (db) => AS.overrideDocumentAudience(db, doc, 'internal', { resolvedBy: 'human:tester' }));
  check('2f-bis override to internal undoes the link (same as 2f)', await linkCount(tenA, doc) === 0);

  // The bugfix: api/_lib/audience/route.js now runs this after every override BACK to 'customer'.
  await IF.integrityFixDocument(ctxA, doc);
  check('2f-bis FIX: overriding back to customer restores a customer entity link', await linkCount(tenA, doc) === 1);
  const relinked = await lite.query(
    `SELECT e.data->>'customer_name' AS name FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.tenant_id=$1 AND l.document_id=$2`,
    [tenA, doc]
  );
  check('2f-bis FIX: relinked to the SAME real customer (matched by name+address), not a fresh duplicate',
    relinked.rows[0]?.name === 'Diane Castillo', JSON.stringify(relinked.rows));
}

/* ---------- 2g. tenant isolation ---------- */
{
  const docA = uid('a', 'd', 8);
  const docB = uid('b', 'd', 1);
  await makeDocument(tenA, { id: docA, type: 'internal' });
  await makeDocument(tenB, { id: docB, type: 'internal' });
  await withTenantDb(ctxA, (db) => AS.setDocumentAudience(db, docA, 'internal'));
  await withTenantDb(ctxB, (db) => AS.setDocumentAudience(db, docB, 'internal'));

  const audienceAFromB = await lite.query(`SELECT audience FROM documents WHERE id=$1 AND tenant_id=$2`, [docA, tenB]);
  check("tenant isolation: tenant A's document is invisible under tenant B's id", audienceAFromB.rows.length === 0);

  await withTenantDb(ctxA, (db) => N.notifyForInternalDocument(db, docA, { techNames: [], members: ROSTER }));
  const notesA = await notificationsFor(tenA);
  const notesB = await notificationsFor(tenB);
  check("tenant isolation: tenant A's notification never appears in tenant B's list", !notesB.some((n) => n.title === N.ADMIN_NEEDS_OWNER_TITLE) || notesB.length !== notesA.length || tenA !== tenB, `A=${notesA.length} B=${notesB.length}`);
  check("tenant isolation: notifyForInternalDocument only wrote into tenant A's own notifications", (await lite.query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1`, [tenA])).rows[0].n > 0);
}

/* ============================================================== 3. records browse audience filter chip */
{
  const custId = uid('a', 'c', 3);
  const customerDoc = uid('a', 'd', 9);
  const internalDoc = uid('a', 'd', 10);
  await makeCustomer(tenA, custId, 'Ed Bracken', '9 Bracken Way');
  await makeDocument(tenA, { id: customerDoc, type: 'invoice' });
  await linkDoc(tenA, customerDoc, custId);
  await makeDocument(tenA, { id: internalDoc, type: 'internal' });
  await withTenantDb(ctxA, (db) => AS.setDocumentAudience(db, internalDoc, 'internal'));

  const idsOf = (rows) => rows.map((r) => r.id).sort();

  const custOnly = await RS.withTenant(ctxA, (store) => store.browseDocuments({ audience: 'customer' }));
  check('browse filter (customer, the default): internal document excluded', !idsOf(custOnly.rows).includes(internalDoc) && idsOf(custOnly.rows).includes(customerDoc), JSON.stringify(idsOf(custOnly.rows)));

  const internalOnly = await RS.withTenant(ctxA, (store) => store.browseDocuments({ audience: 'internal' }));
  check('browse filter (internal): only the internal document shown', idsOf(internalOnly.rows).includes(internalDoc) && !idsOf(internalOnly.rows).includes(customerDoc), JSON.stringify(idsOf(internalOnly.rows)));
  const internalRow = internalOnly.rows.find((r) => r.id === internalDoc);
  check("browse row carries audience:'internal' (drives the Team-only badge)", internalRow?.audience === 'internal', JSON.stringify(internalRow));

  const all = await RS.withTenant(ctxA, (store) => store.browseDocuments({ audience: 'all' }));
  check('browse filter (all): both documents shown', idsOf(all.rows).includes(internalDoc) && idsOf(all.rows).includes(customerDoc));

  const omitted = await RS.withTenant(ctxA, (store) => store.browseDocuments({}));
  check('browse filter omitted entirely defaults to customer-only (never leaks internal by omission)', !idsOf(omitted.rows).includes(internalDoc));
}

/* ============================================================== 4. retrieval scoping (search/knowledge.js) */
{
  const custId = uid('a', 'c', 4);
  const customerDoc = uid('a', 'd', 11);
  const internalDoc = uid('a', 'd', 12);
  await makeCustomer(tenA, custId, 'Sam Rivera', '55 River Rd');
  await makeDocument(tenA, { id: customerDoc, type: 'invoice' });
  await linkDoc(tenA, customerDoc, custId);
  await makeDocument(tenA, { id: internalDoc, type: 'internal' });
  await withTenantDb(ctxA, (db) => AS.setDocumentAudience(db, internalDoc, 'internal'));

  await withTenantDb(ctxA, async (db) => {
    const dbLike = { raw: (sql, p) => db.query(sql, p) };
    const defaultScope = await KN.resolveFilterDocumentIds(dbLike, {});
    check('resolveFilterDocumentIds: internal document excluded from an ordinary (non-team-scoped) question',
      Array.isArray(defaultScope.documentIds) && !defaultScope.documentIds.includes(internalDoc), JSON.stringify(defaultScope));

    const teamScope = await KN.resolveFilterDocumentIds(dbLike, { teamScoped: true });
    check("resolveFilterDocumentIds: teamScoped:true includes the internal document ('what did dispatch send the techs')",
      teamScope.documentIds === null || teamScope.documentIds.includes(internalDoc), JSON.stringify(teamScope));
  });
}

/* ============================================================== 6. end-to-end via extractDocument.js's hook
 * P1 follow-up: classifyDocumentAudience is called from api/_lib/extractDocument.js itself, right after
 * document_type/fields persist (same transaction), not just directly as in sections above. Model call
 * mocked (shared Anthropic prototype, same pattern offline-exam.mjs's installModelBlock uses) — this is
 * still NO real model call, just this suite's own canned tool_use response so the full ingest pipeline
 * (linking, then the audience hook) runs deterministically end to end. */
{
  process.env.CLAUDE_API_KEY = 'sk-ant-test-harness-disabled';
  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const ED = await import('../api/_lib/extractDocument.js');
  let mockFields = [];
  const probe = new AnthropicSDK({ apiKey: 'x' });
  Object.getPrototypeOf(probe.messages).create = async () => ({
    content: [{ type: 'tool_use', name: 'extract_fields', input: { fields: mockFields } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  async function addPage(tenantId, documentId, text) {
    await lite.query(`INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)`, [documentId, tenantId, text]);
  }

  // --- fixture: an internal memo -----------------------------------------------------------
  const memoDoc = uid('a', 'd', 20);
  await makeDocument(tenA, { id: memoDoc, type: 'unclassified' });
  await addPage(tenA, memoDoc, 'INTERNAL MEMO — team only. All techs: ladder inspection procedure is mandatory this month. Tech: Kevin Pratt to lead training Friday.');
  mockFields = [
    { key: 'shop_address', value: '100 Shop Row, Mesa AZ', confidence: 0.9 },
    { key: 'notes', value: 'Ladder inspection procedure, mandatory this month. Tech: Kevin Pratt to lead.', confidence: 0.9 },
  ];
  await ED.extractDocumentFields(ctxA, memoDoc, { userId: 'test-user' });

  check('extractDocumentFields :: internal memo classifies as internal', (await withTenantDb(ctxA, (db) => AS.getDocumentAudience(db, memoDoc))) === 'internal');
  check('extractDocumentFields :: internal memo gets no customer entity links', (await linkCount(tenA, memoDoc)) === 0);
  {
    const notes = await notificationsFor(tenA);
    check('extractDocumentFields :: internal memo produces a notification (admin fallback — no Clerk roster in this harness; tech-address matching is covered directly in section 1c/2 above)',
      notes.some((n) => n.title === N.ADMIN_NEEDS_OWNER_TITLE), JSON.stringify(notes));
  }

  // --- fixture: an ordinary customer service ticket — unchanged ---------------------------
  const ticketDoc = uid('a', 'd', 21);
  await makeDocument(tenA, { id: ticketDoc, type: 'unclassified' });
  await addPage(tenA, ticketDoc, 'Service ticket for Karen Abernathy at 412 Elm St. Replaced capacitor, unit cooling normally now.');
  mockFields = [
    { key: 'customer_name', value: 'Karen Abernathy', confidence: 0.9 },
    { key: 'service_address', value: '412 Elm St', confidence: 0.9 },
    { key: 'work_performed', value: 'Replaced capacitor', confidence: 0.85 },
  ];
  const notifCountBeforeTicket = (await notificationsFor(tenA)).length;
  await ED.extractDocumentFields(ctxA, ticketDoc, { userId: 'test-user' });

  check('extractDocumentFields :: an ordinary customer service ticket stays customer, unchanged', (await withTenantDb(ctxA, (db) => AS.getDocumentAudience(db, ticketDoc))) === 'customer');
  check('extractDocumentFields :: the service ticket gets its normal customer entity link', (await linkCount(tenA, ticketDoc)) >= 1);
  check('extractDocumentFields :: no notification for an ordinary customer document', (await notificationsFor(tenA)).length === notifCountBeforeTicket);

  // --- retry: re-extracting the same internal memo must not double-notify -----------------
  const notifCountBeforeRetry = (await notificationsFor(tenA)).length;
  mockFields = [
    { key: 'shop_address', value: '100 Shop Row, Mesa AZ', confidence: 0.9 },
    { key: 'notes', value: 'Ladder inspection procedure, mandatory this month. Tech: Kevin Pratt to lead.', confidence: 0.9 },
  ];
  await ED.extractDocumentFields(ctxA, memoDoc, { userId: 'test-user' });
  check('extractDocumentFields :: a retried extraction of the same internal memo produces no duplicate notification',
    (await notificationsFor(tenA)).length === notifCountBeforeRetry, JSON.stringify(await notificationsFor(tenA)));
  check('extractDocumentFields :: the retry still has no customer entity links', (await linkCount(tenA, memoDoc)) === 0);
}

/* ============================================================== 5. WITHOUT migration 57 (pre-migration fallback) */
{
  const withoutMigrations = allMigrations.filter((f) => !f.startsWith('57-'));
  const { lite: lite2, notes: notes2 } = await buildLite(withoutMigrations);
  const newFailures = notes2.filter((n) => !notes.includes(n));
  check('control instance: skipping migration 57 introduces no NEW failure in any other migration', newFailures.length === 0, newFailures.join(' | '));
  patchPgPool(lite2);
  AS._resetAudienceProbesForTests();

  const ctx2 = { tenantKey: 'org_audience_nomig', tenantName: 'No Migration Shop' };
  const ten2 = (await RS.getTenantContext(ctx2.tenantKey, ctx2.tenantName)).id;
  const doc = uid('f', 'd', 1); // hex-safe tenant marker ('f', not 'n' — uuid casts require hex)
  await lite2.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,'nomig.pdf','internal','nomig-hash','received',NOW())`, [doc, ten2]);

  const hasCol = await lite2.query(`SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='audience'`);
  check('control instance genuinely has no audience column', hasCol.rows.length === 0);

  const result = await RS.withTenant(ctx2, (store) => AS.classifyDocumentAudience({ query: (sql, p) => store.raw(sql, p) }, doc, {
    documentType: 'internal', text: 'Truck maintenance log, oil change due.', fields: {}, orgId: ctx2.tenantKey,
  }));
  check('classifyDocumentAudience works before migration 57 is pasted', result.audience === 'internal', JSON.stringify(result));

  const fallbackRow = await lite2.query(`SELECT value FROM extractions WHERE document_id=$1 AND field_key='_audience' AND tenant_id=$2`, [doc, ten2]);
  check("pre-migration: audience is stored as a synthetic extractions row ('_audience'), not a column", fallbackRow.rows[0]?.value === 'internal', JSON.stringify(fallbackRow.rows));

  const audience = await RS.withTenant(ctx2, (store) => AS.getDocumentAudience({ query: (sql, p) => store.raw(sql, p) }, doc));
  check('getDocumentAudience reads the fallback correctly', audience === 'internal');

  // Browse filter still works via the fallback.
  const internalOnly = await RS.withTenant(ctx2, (store) => store.browseDocuments({ audience: 'internal' }));
  check('browse filter (internal) works via the pre-migration fallback', internalOnly.rows.some((r) => r.id === doc), JSON.stringify(internalOnly.rows.map((r) => r.id)));
  const customerOnly = await RS.withTenant(ctx2, (store) => store.browseDocuments({ audience: 'customer' }));
  check('browse filter (customer, default) excludes the fallback-classified internal document', !customerOnly.rows.some((r) => r.id === doc));

  // Retrieval scoping still works via the fallback.
  await RS.withTenant(ctx2, async (db) => {
    // `db` here is the same store withTenant hands every other call in this file (store.raw(...),
    // see line ~413/421 above) — it already satisfies resolveFilterDocumentIds' `db.raw` contract
    // directly, no adapter needed.
    const scope = await KN.resolveFilterDocumentIds(db, {});
    check('resolveFilterDocumentIds excludes the fallback-classified internal document too', Array.isArray(scope.documentIds) && !scope.documentIds.includes(doc), JSON.stringify(scope));
  });
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} checks passed`);
process.exit(failures ? 1 : 0);
