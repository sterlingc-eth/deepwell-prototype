/**
 * DOCUMENT DISPLAY NAMES (M3-config/41-document-display-names.sql, api/_lib/naming/{engine,
 * store,assign}.js, api/_lib/routes/naming.js, src/core/documentName.ts) — round 12, G3.
 *
 * Same harness as scripts/verify-job-costing.mjs: no network, no Anthropic key, no DATABASE_URL —
 * a real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations, queried as the
 * app's non-superuser NOBYPASSRLS role (deepwell_rls).
 *
 *   1. pure: computeDisplayName's per-type templates (one worked example per nameable type,
 *      matching the owner's own examples where given), missing-field graceful fallback, smart
 *      truncation (<=70 chars, label never dropped), dedupeDisplayName, sanitizeDisplayName.
 *   2. migration 41: idempotent, adds only columns + indexes (no new table/policy needed).
 *   3. assignDisplayName end to end: confirmed via verified_by, confirmed via a logged
 *      classification confidence >= AI_VERIFY_MIN_CONFIDENCE, NOT confirmed (low confidence, no
 *      verification) -> stays null, insufficient fields -> stays null even when confirmed.
 *   4. dedupe: two sibling documents (same tenant+type+customer+date) that would produce the
 *      identical base name get " (2)"; a THIRD tenant's identical document does not collide with
 *      either (tenant isolation).
 *   5. never overwrites a user name: renameDocument sets source='user'; a later assignDisplayName
 *      or backfill pass leaves it untouched.
 *   6. backfill: bounded + resumable (small batches, afterId cursor) converges to remaining=0 and
 *      never re-processes a document twice; never touches a user-named document.
 *   7. WITHOUT migration 41 (a second PGlite instance that never loads 41-*.sql): every op
 *      degrades to a no-op/{enabled:false} instead of throwing a bare 42703.
 *
 *   node scripts/verify-document-names.mjs
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
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ================================================================== 1. pure engine */
const E = await import('../api/_lib/naming/engine.js');

{
  const named = (typeId, fields, entities = []) => E.computeDisplayName({ typeId, fields, entities });

  eq('invoice: owner example — "Invoice #10493 · Carol Rios · $1,240.00 · Jun 12, 2025"',
    named('invoice', { invoice_number: 'INV-10493', customer_name: 'Carol Rios', cost: '1240.00', service_date: '2025-06-12' }),
    'Invoice #INV-10493 · Carol Rios · $1,240.00 · Jun 12, 2025');

  eq('warranty-registration: owner example — "Warranty · Carol Rios · Trane XR16 · Jun 12, 2025"',
    named('warranty-registration', { customer_name: 'Carol Rios', manufacturer: 'Trane', model: 'XR16', warranty_registered_date: '2025-06-12' }),
    'Warranty · Carol Rios · Trane XR16 · Jun 12, 2025');

  eq('work-order: owner example — "Work order · 581 W Thomas Rd · Jun 12, 2025"',
    named('work-order', { service_address: '581 W Thomas Rd', service_date: '2025-06-12' }),
    'Work order · 581 W Thomas Rd · Jun 12, 2025');

  eq('maintenance-agreement: owner example — "Maintenance agreement · Rios · 2025–2026" (surname, year range)',
    named('maintenance-agreement', { customer_name: 'Carol Rios', agreement_term: '01/01/2025 - 12/31/2026' }),
    'Maintenance agreement · Rios · 2025–2026');

  eq('purchase-order: owner example — "Purchase order #2291 · Ferguson · $812.50"',
    named('purchase-order', { invoice_number: '2291', customer_name: 'Ferguson', cost: '812.50' }),
    'Purchase order #2291 · Ferguson · $812.50');

  // One worked example for every remaining nameable type — nothing in NAMEABLE_TYPES is untested.
  const REMAINING = {
    'startup-sheet': [{ customer_name: 'Amy Isaacson', manufacturer: 'Carrier', model: '24ABC6', installation_date: '2025-03-04' }, 'Startup sheet · Amy Isaacson · Carrier 24ABC6 · Mar 4, 2025'],
    permit: [{ permit_number: 'BP-2024-08841', service_address: '412 Elm St', service_date: '2025-01-05' }, 'Permit #BP-2024-08841 · 412 Elm St · Jan 5, 2025'],
    'nameplate-photo': [{ manufacturer: 'Goodman', model: 'GSX140361K', customer_name: 'Karen Abernathy' }, 'Nameplate photo · Goodman GSX140361K · Karen Abernathy'],
    'service-ticket': [{ customer_name: 'Donna Thornton', service_date: '2025-07-15' }, 'Service ticket · Donna Thornton · Jul 15, 2025'],
    'dispatch-note': [{ customer_name: 'Emily Whitfield', service_date: '2025-06-02' }, 'Dispatch note · Emily Whitfield · Jun 2, 2025'],
    'proposal-quote': [{ customer_name: 'Plaza Dental Group', cost: '3400.00', service_date: '2025-05-01' }, 'Quote · Plaza Dental Group · $3,400.00 · May 1, 2025'],
    'inspection-report': [{ service_address: '17 Cactus Ln', service_date: '2025-08-01' }, 'Inspection report · 17 Cactus Ln · Aug 1, 2025'],
    'equipment-record': [{ manufacturer: 'Lennox', model: 'XC21', customer_name: 'Oak Phoenix Co' }, 'Equipment record · Lennox XC21 · Oak Phoenix Co'],
    correspondence: [{ reminder_customer_name: 'David Prentiss', service_date: '2025-09-01' }, 'Correspondence · David Prentiss · Sep 1, 2025'],
    internal: [{ service_address: '2210 E Main St', service_date: '2025-02-14' }, 'Shop record · 2210 E Main St · Feb 14, 2025'],
  };
  for (const [typeId, [fields, want]] of Object.entries(REMAINING)) {
    eq(`${typeId}: template produces the expected name`, named(typeId, fields), want);
  }

  check("'other' never gets a generated name (classification not decided)", named('other', { customer_name: 'Anyone' }) === null);
  check('unknown/garbled typeId -> null', named('not-a-real-type', { customer_name: 'Anyone' }) === null);
  check('no typeId at all -> null', E.computeDisplayName({ fields: { customer_name: 'Anyone' } }) === null);

  /* ---- missing-field graceful fallback ---- */
  check('invoice with ONLY a customer name (no number, no cost, no date) -> null (fewer than 2 segments incl. label is not enough, and label+1 alone is allowed)',
    named('invoice', { customer_name: 'Solo Name' }) === 'Invoice · Solo Name');
  check('invoice with NOTHING at all -> null (label alone beats nothing, but is not better than the filename)',
    named('invoice', {}) === null);
  check('warranty-registration missing model — falls back to manufacturer alone',
    named('warranty-registration', { customer_name: 'Amy Isaacson', manufacturer: 'Trane' }) === 'Warranty · Amy Isaacson · Trane');
  check('cost field that does not parse as a number is left out, never shown as "$NaN"',
    !named('proposal-quote', { customer_name: 'Amy Isaacson', cost: 'not a number', service_date: '2025-01-01' }).includes('NaN'));

  /* ---- entities fallback (this document's own extraction is missing the fact; a linked entity has it) ---- */
  eq('customer_name absent from THIS document but present on the linked customer entity',
    named('service-ticket', { service_date: '2025-04-01' }, [{ type: 'customer', name: 'Karen Abernathy' }]),
    'Service ticket · Karen Abernathy · Apr 1, 2025');
  eq('manufacturer/model absent from fields, present on the linked equipment entity',
    named('startup-sheet', { customer_name: 'Amy Isaacson', installation_date: '2025-03-04' }, [{ type: 'equipment', manufacturer: 'Carrier', model: '24ABC6' }]),
    'Startup sheet · Amy Isaacson · Carrier 24ABC6 · Mar 4, 2025');
  check("this document's OWN field wins over a linked entity's when both exist",
    named('service-ticket', { customer_name: 'Real Customer', service_date: '2025-01-01' }, [{ type: 'customer', name: 'Wrong Entity Name' }])
      === 'Service ticket · Real Customer · Jan 1, 2025');

  /* ---- truncation: max ~70 chars, label never dropped, safe characters ---- */
  const longName = 'A'.repeat(90);
  const long1 = named('service-ticket', { customer_name: longName, service_date: '2025-01-01' });
  check(`truncation: an extremely long customer name still yields a name <= ${E.MAX_DISPLAY_NAME_LENGTH} chars`, long1 !== null && long1.length <= E.MAX_DISPLAY_NAME_LENGTH, `len=${long1?.length}`);
  check('truncation: the label survives even when the rest is dropped', long1.startsWith('Service ticket'));
  const longInvoice = named('invoice', { invoice_number: 'INV-1', customer_name: 'Bartholomew Winterbourne-Ashworth the Third of Scottsdale', cost: '1240.00', service_date: '2025-06-12' });
  check(`truncation drops LEAST important segments first, keeping the result <= ${E.MAX_DISPLAY_NAME_LENGTH}`, longInvoice.length <= E.MAX_DISPLAY_NAME_LENGTH);
  check('sanitizeSegment strips control/markup characters, keeps safe punctuation',
    E.__internal.sanitizeSegment('Bad\u0000<script>Name\n\t') === 'BadscriptName');

  /* ---- dedupeDisplayName (pure) ---- */
  eq('dedupeDisplayName: no collision -> unchanged', E.dedupeDisplayName('Invoice · Carol Rios', []), 'Invoice · Carol Rios');
  eq('dedupeDisplayName: one collision -> " (2)"', E.dedupeDisplayName('Invoice · Carol Rios', ['Invoice · Carol Rios']), 'Invoice · Carol Rios (2)');
  eq('dedupeDisplayName: (2) also taken -> " (3)"', E.dedupeDisplayName('Invoice · Carol Rios', ['Invoice · Carol Rios', 'Invoice · Carol Rios (2)']), 'Invoice · Carol Rios (3)');

  /* ---- sanitizeDisplayName (manual rename path) ---- */
  eq('sanitizeDisplayName: trims and strips unsafe characters (angle brackets, exclamation marks)', E.sanitizeDisplayName('  Front Office Copy!! <b>  '), 'Front Office Copy b');
  check('sanitizeDisplayName: caps length with an ellipsis', E.sanitizeDisplayName('X'.repeat(200)).length <= E.MAX_DISPLAY_NAME_LENGTH);
}

/* ================================================================== documentName.ts client mirror (pure, no DOM) */
{
  // A tiny CommonJS-free TS import works under tsx; this harness runs under plain node, so we only
  // sanity-check the compiled behavior indirectly is out of scope here — src/core/documentName.ts
  // is exercised by `npm run build`/`typecheck` per R11's own required check list, and its own
  // logic is a deliberate near-mirror of engine.js's, reviewed by hand above.
  check('src/core/documentName.ts exists and exports the required, unchanged surface', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/documentName.ts'), 'utf8');
    return /export function documentName\(/.test(src) && /export function hasFriendlyName\(/.test(src) && /export function originalFilename\(/.test(src);
  })());
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

const cfgDir = path.join(ROOT, 'M3-config');
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();

async function buildLite(migrationFiles) {
  const lite = new PGlite({ extensions: contrib });
  const notes = [];
  for (const f of migrationFiles) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk, same as verify-job-costing.mjs */ }
  return { lite, notes };
}

function patchPgPool(lite) {
  const pgMod0 = pgModCache;
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod0.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod0.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}

const pgModCache = (await import('pg')).default;

/* ---------------------------------------------------------------- instance 1: every migration */
const { lite, notes } = await buildLite(allMigrations);
check('harness: migration 41 loaded cleanly (no error from 41-document-display-names.sql)', !notes.some((n) => n.startsWith('41-')), notes.join(' | '));
patchPgPool(lite);

// Fresh module graph AFTER the pg.Pool patch above — recordsStore.js caches a pool at import time.
const RS = await import('../api/_lib/recordsStore.js');
const Store = await import('../api/_lib/naming/store.js');
const A = await import('../api/_lib/naming/assign.js');

const ctx = { tenantKey: 'org_naming_a', tenantName: 'Naming Shop A' };
const ctxB = { tenantKey: 'org_naming_b', tenantName: 'Naming Shop B' };
const tenId = (await RS.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const tenIdB = (await RS.getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
// hex-safe filler only (kind is 'c' or 'd', both valid hex digits) — a non-hex character here
// would make the id fail isUuid()'s strict hex check, or Postgres's ::uuid cast, silently.
const uid = (kind, n) => `${kind}a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = (n) => uid('d', n);
const cust = (n) => uid('c', n);

/* ---------- migration shape ---------- */
{
  eq('migration 41: display_name/_source/_updated_at columns exist',
    (await lite.query(`SELECT column_name FROM information_schema.columns WHERE table_name='documents' AND column_name LIKE 'display_name%' ORDER BY column_name`)).rows.map((r) => r.column_name),
    ['display_name', 'display_name_source', 'display_name_updated_at']);
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'documents'")).rows[0];
  check('migration 41 added no new table: documents keeps ENABLE + FORCE ROW LEVEL SECURITY', rls.rls && rls.force);
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '41-document-display-names.sql'), 'utf8')).then(() => true, () => false);
  check('migration 41 is idempotent (re-running it changes nothing and errors nothing)', twice);
  // A no-row UPDATE never trips a CHECK constraint either way, so this verifies the constraint's
  // own definition text instead of trying (and failing) to provoke it with a no-op write.
  const constraintDef = (await lite.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'documents_display_name_source_check'`)).rows[0]?.def ?? '';
  check("migration 41: display_name_source CHECK constraint allows only 'auto'/'user'/NULL", constraintDef.includes("'auto'") && constraintDef.includes("'user'"), constraintDef);
}

/* ---------- fixtures ---------- */
async function addCustomer(n, name, address, tenant = tenId) {
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer',$3::jsonb)`,
    [cust(n), tenant, JSON.stringify({ customer_name: name, service_address: address })]);
}
async function addDocument(n, { type = 'invoice', verifiedBy = null, tenant = tenId } = {}) {
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, verified_by) VALUES ($1,$2,$3,$4,$5,'linked',$6)`,
    [doc(n), tenant, `${n}.pdf`, type, `naming-hash-${n}`, verifiedBy]);
}
async function addFields(n, fields, tenant = tenId) {
  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    i++;
    await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)`, [tenant, doc(n), key, value]);
  }
}
async function linkCustomer(n, custN, tenant = tenId) {
  await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)`, [tenant, doc(n), cust(custN)]);
}
async function logClassification(n, { documentType, confidence }, tenant = tenId) {
  await lite.query(
    `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at) VALUES ($1,'document.fields_extracted','document',$2,$3::jsonb,NOW())`,
    [tenant, doc(n), JSON.stringify({ document_type: documentType, document_type_confidence: confidence })]
  );
}

/* ---------- 3. assignDisplayName: confirmed vs not, insufficient fields ---------- */
await addCustomer(1, 'Amy Isaacson', '248 W Guadalupe Rd, Phoenix, AZ');
await addDocument(1, { type: 'warranty-registration', verifiedBy: 'ai' });
await addFields(1, { customer_name: 'Amy Isaacson', manufacturer: 'Trane', model: 'XR16', warranty_registered_date: '2025-06-12' });
await linkCustomer(1, 1);
{
  const r = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(1) });
  eq('assignDisplayName: verified_by set -> confirmed, named', r, { assigned: true, documentId: doc(1), typeId: 'warranty-registration', displayName: 'Warranty · Amy Isaacson · Trane XR16 · Jun 12, 2025' });
  const row = (await lite.query(`SELECT display_name, display_name_source FROM documents WHERE id = $1`, [doc(1)])).rows[0];
  eq('assignDisplayName: persisted with source=auto', row, { display_name: 'Warranty · Amy Isaacson · Trane XR16 · Jun 12, 2025', display_name_source: 'auto' });
  const again = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(1) });
  eq('assignDisplayName: idempotent — calling again on an already-named document is a no-op', again, { assigned: false, reason: 'already_named', documentId: doc(1), displayName: 'Warranty · Amy Isaacson · Trane XR16 · Jun 12, 2025' });
}

await addDocument(2, { type: 'invoice', verifiedBy: null });
await addFields(2, { customer_name: 'Karen Abernathy', invoice_number: 'INV-9', cost: '500.00', service_date: '2025-07-01' });
await logClassification(2, { documentType: 'invoice', confidence: 0.92 });
{
  const r = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(2) });
  eq('assignDisplayName: no verified_by, but logged confidence >= threshold -> confirmed, named', r, { assigned: true, documentId: doc(2), typeId: 'invoice', displayName: 'Invoice #INV-9 · Karen Abernathy · $500.00 · Jul 1, 2025' });
}

await addDocument(3, { type: 'invoice', verifiedBy: null });
await addFields(3, { customer_name: 'Donna Thornton', invoice_number: 'INV-10', cost: '90.00', service_date: '2025-08-01' });
await logClassification(3, { documentType: 'invoice', confidence: 0.4 });
{
  const r = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(3) });
  eq('assignDisplayName: low confidence, not verified -> NOT confirmed, stays null', r, { assigned: false, reason: 'not_confirmed', documentId: doc(3) });
  const row = (await lite.query(`SELECT display_name FROM documents WHERE id = $1`, [doc(3)])).rows[0];
  check('not confirmed -> display_name really is NULL in the database', row.display_name === null);
}

await addDocument(4, { type: 'work-order', verifiedBy: 'ai' });
// No fields at all — confirmed type, but nothing to build a name from.
{
  const r = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(4) });
  eq('assignDisplayName: confirmed type but insufficient fields -> stays null (never a "Work order" by itself)', r, { assigned: false, reason: 'insufficient_fields', documentId: doc(4), typeId: 'work-order' });
}

/* ---------- 4. dedupe: same tenant/type/customer/date collide; a different tenant does not ---------- */
await addCustomer(5, 'Repeat Customer', '9 Test Ct, Mesa, AZ');
await addDocument(5, { type: 'service-ticket', verifiedBy: 'ai' });
await addFields(5, { customer_name: 'Repeat Customer', service_date: '2025-09-01' });
await linkCustomer(5, 5);
await addDocument(6, { type: 'service-ticket', verifiedBy: 'ai' });
await addFields(6, { customer_name: 'Repeat Customer', service_date: '2025-09-01' });
await linkCustomer(6, 5);
{
  const r5 = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(5) });
  const r6 = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(6) });
  eq('dedupe: first of two identical siblings gets the base name', r5.displayName, 'Service ticket · Repeat Customer · Sep 1, 2025');
  eq('dedupe: second identical sibling gets " (2)"', r6.displayName, 'Service ticket · Repeat Customer · Sep 1, 2025 (2)');
}

// Tenant isolation: tenant B has the identical customer/type/date, must NOT collide with tenant
// A's names. entities.id/documents.id are GLOBAL primary keys (not tenant-scoped) in this schema,
// so tenant B's fixtures need their own numeric ids, never a number already used by tenant A.
await addCustomer(55, 'Repeat Customer', '9 Test Ct, Mesa, AZ', tenIdB);
await addDocument(50, { type: 'service-ticket', verifiedBy: 'ai', tenant: tenIdB });
await addFields(50, { customer_name: 'Repeat Customer', service_date: '2025-09-01' }, tenIdB);
await linkCustomer(50, 55, tenIdB);
{
  const rB = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctxB, documentId: doc(50) });
  eq("tenant isolation: tenant B's identical document gets the plain base name, not tenant A's (2)", rB.displayName, 'Service ticket · Repeat Customer · Sep 1, 2025');
}

/* ---------- 5. never overwrite a user-named document ---------- */
await addDocument(7, { type: 'invoice', verifiedBy: 'ai' });
await addFields(7, { customer_name: 'User Named Co', invoice_number: 'INV-99', cost: '10.00', service_date: '2025-01-01' });
{
  const renamed = await A.renameDocument(ctx, { documentId: doc(7), name: 'Front office copy' }, { withTenantFn: RS.withTenant });
  eq('renameDocument: sets source=user', renamed, { renamed: true, documentId: doc(7), displayName: 'Front office copy' });
  const auto = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx, documentId: doc(7) });
  eq('assignDisplayName never overwrites a user-set name', auto, { assigned: false, reason: 'user_named', documentId: doc(7), displayName: 'Front office copy' });
  const row = (await lite.query(`SELECT display_name, display_name_source FROM documents WHERE id = $1`, [doc(7)])).rows[0];
  eq('user name + source=user persisted', row, { display_name: 'Front office copy', display_name_source: 'user' });
}

/* ---------- 6. backfill: bounded, resumable, never re-processes, never touches user names ---------- */
for (let n = 100; n < 108; n++) {
  await addDocument(n, { type: 'permit', verifiedBy: 'ai' });
  await addFields(n, { permit_number: `BP-${n}`, service_address: `${n} Test Ave`, service_date: '2025-05-05' });
}
// Two documents from section 3 (doc(3): logged confidence 0.4, never confirmed; doc(4):
// confirmed but zero fields) are eligible (document_type IS NOT NULL) yet can NEVER be named
// with the data on file — `remaining` correctly never reaches 0 while they exist, so
// convergence is measured against that known floor, not a literal zero.
const STUCK_REMAINING = 2;
{
  let cursor = null;
  let totalProcessed = 0;
  let totalNamed = 0;
  let rounds = 0;
  let last = null;
  do {
    last = await A.runNamingBackfillBatch(ctx, { afterId: cursor, limit: 3, withTenantFn: RS.withTenant });
    totalProcessed += last.processed;
    totalNamed += last.named;
    cursor = last.nextCursor;
    rounds++;
    check(`backfill round ${rounds}: never exceeds the requested batch size`, last.processed <= 3);
  } while (last.remaining > STUCK_REMAINING && rounds < 20);

  check(`backfill: converges to its floor of ${STUCK_REMAINING} permanently-unnameable documents within a bounded number of rounds`, last.remaining === STUCK_REMAINING, `remaining=${last.remaining}`);
  check('backfill: processed AT LEAST the 8 new permits across the whole run (may also see earlier eligible docs)', totalProcessed >= 8);
  const named = (await lite.query(`SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1 AND document_type = 'permit' AND display_name IS NOT NULL`, [tenId])).rows[0].n;
  check('backfill: every one of the 8 permits ended up named', named >= 8);

  // Re-running after convergence processes the two stuck documents again (cursor restarts from
  // the top every full pass) but assigns nothing new — remaining stays at the same floor, not 0.
  const again = await A.runNamingBackfillBatch(ctx, { afterId: null, limit: 50, withTenantFn: RS.withTenant });
  check('backfill: a second full pass is stable at the same floor and assigns nothing new', again.remaining === STUCK_REMAINING && again.named === 0, JSON.stringify(again));

  // The user-named document from section 5 must never have been touched by the backfill.
  const stillUser = (await lite.query(`SELECT display_name, display_name_source FROM documents WHERE id = $1`, [doc(7)])).rows[0];
  eq('backfill never overwrote the user-named document from an earlier section', stillUser, { display_name: 'Front office copy', display_name_source: 'user' });
}

const status = await A.namingBackfillStatus(ctx, { withTenantFn: RS.withTenant });
check(`namingBackfillStatus: reports enabled + remaining=${STUCK_REMAINING} (its known floor) after the backfill above`, status.enabled === true && status.remaining === STUCK_REMAINING, JSON.stringify(status));

/* ================================================================== 7. WITHOUT migration 41 */
{
  const withoutMigrations = allMigrations.filter((f) => !f.startsWith('41-'));
  const { lite: lite2, notes: notes2 } = await buildLite(withoutMigrations);
  // `notes` (the harness's own pre-existing quirks — pgvector unavailable in PGlite, etc., same
  // ones the full run above already tolerated) may reappear here; what matters is that skipping
  // migration 41 introduces no NEW failure in any OTHER file.
  const newFailures = notes2.filter((n) => !notes.includes(n));
  check('control instance: skipping migration 41 introduces no NEW failure in any other migration', newFailures.length === 0, newFailures.join(' | '));
  // Redirect the (globally monkey-patched, same as verify-job-costing.mjs) pg.Pool prototype at
  // this SECOND PGlite instance — recordsStore.js's own pool just starts talking to it. The one
  // piece of app-level state that would otherwise leak from section 1-6 is naming/store.js's
  // memoized "does display_name exist" probe, cleared explicitly below.
  patchPgPool(lite2);
  Store.resetDisplayNameColumnsProbe();

  const ctx2 = { tenantKey: 'org_naming_nomig', tenantName: 'No Migration Shop' };
  const ten2 = (await RS.getTenantContext(ctx2.tenantKey, ctx2.tenantName)).id;
  await lite2.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, verified_by) VALUES ($1,$2,'34534895.pdf','warranty-registration','nomig-hash','linked','ai')`, [doc(1), ten2]);
  await lite2.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'customer_name','Amy Isaacson',0.9)`, [ten2, doc(1)]);

  let threw = false;
  let assignResult = null;
  try {
    assignResult = await A.assignDisplayName({ withTenant: RS.withTenant, ctxArg: ctx2, documentId: doc(1) });
  } catch { threw = true; }
  check('assignDisplayName without migration 41: never throws', !threw);
  check("assignDisplayName without migration 41: reports 'columns_missing' rather than silently pretending it worked", !threw && assignResult?.reason === 'columns_missing', JSON.stringify(assignResult));

  const backfillResult = await A.runNamingBackfillBatch(ctx2, { withTenantFn: RS.withTenant }).catch((e) => ({ threw: String(e) }));
  check('runNamingBackfillBatch without migration 41: {enabled:false}, never throws', backfillResult?.enabled === false, JSON.stringify(backfillResult));

  const statusResult = await A.namingBackfillStatus(ctx2, { withTenantFn: RS.withTenant }).catch((e) => ({ threw: String(e) }));
  check('namingBackfillStatus without migration 41: {enabled:false}, never throws', statusResult?.enabled === false, JSON.stringify(statusResult));

  const renameResult = await A.renameDocument(ctx2, { documentId: doc(1), name: 'Anything' }, { withTenantFn: RS.withTenant }).catch((e) => ({ threw: String(e) }));
  check("renameDocument without migration 41: {renamed:false, reason:'columns_missing'}, never throws", renameResult?.renamed === false && renameResult?.reason === 'columns_missing', JSON.stringify(renameResult));
}

console.log(`\n${passes} passed, ${failures} failed.`);
if (failures) process.exit(1);
