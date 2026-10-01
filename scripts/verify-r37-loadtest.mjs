/**
 * R37 load-test files: proves the three SQL files the owner pastes on a Neon branch (M3-config/loadtest/L1, L2, L3) work
 * against the real schema, before he spends any time on them. PGlite (in-process Postgres, $0), every M3-config
 * migration applied, the app's RLS role. No network, no real Neon / R2 / model / Stripe.
 *
 *   npx tsx scripts/verify-r37-loadtest.mjs                    # 3,000 documents (about 15 s)
 *   LOADTEST_DOCS=50000 npx tsx scripts/verify-r37-loadtest.mjs   # the real size (PGlite is slower than Neon)
 *
 * Checks: L1 seeds the test company at the right shape and refuses a second run; the data satisfies every FK / CHECK and
 * leaves nothing queued; row-level security keeps it apart from another company; L2 returns one result table with every
 * timed check answered; L3 leaves nothing of the test company and does not touch a second company that was already there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness } from './lib/r35Harness.mjs';
import { LOADTEST_TENANT as T, runFile, expectedSizes, loadtestSql } from './lib/loadtestSql.mjs';

const DOCS = Math.trunc(Number(process.env.LOADTEST_DOCS ?? 3000)) || 3000;
const FULL = DOCS > 10000;
// At the real size the database is kept on disk (PGlite's Node filesystem) instead of in memory: a 50,000-document company
// held in memory several times over gets a small machine's process killed (same reason r35Harness has `dataDir`).
const dataDir = FULL && !process.env.LOADTEST_INMEMORY ? (process.env.LOADTEST_DATADIR ?? path.join(os.tmpdir(), `r37-loadtest-pgdata-${process.pid}`)) : null;
if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
const h = await bootHarness(dataDir ? { dataDir } : {});
const { lite } = h;
// The harness applies the migrations before it creates the app role, so 64's GRANT found nobody to grant to (see verify-r36-scale).
await lite.exec(`GRANT EXECUTE ON FUNCTION records_search_candidates(text, text) TO deepwell_rls`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const q = async (sql, params) => (await lite.query(sql, params)).rows;
const n1 = async (sql, params) => Number((await q(sql, params))[0].n);
const fmt = (s) => `${s.toFixed(1)} s`;
const sizes = expectedSizes(DOCS);

const COUNT_TABLES = ['documents', 'document_pages', 'extractions', 'entities', 'document_entity_links', 'document_financials'];
const countsFor = async (tid) => {
  const out = {};
  for (const t of COUNT_TABLES) out[t] = await n1(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [tid]);
  out.tenants = await n1(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [tid]);
  return out;
};
const fingerprint = async (tid) => (await q(
  `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
     SELECT 'd' || id || original_filename || stage AS x FROM documents WHERE tenant_id = $1
     UNION ALL SELECT 'p' || id || coalesce(text, '') FROM document_pages WHERE tenant_id = $1
     UNION ALL SELECT 'e' || id || data::text FROM entities WHERE tenant_id = $1
     UNION ALL SELECT 'x' || id || field_key || coalesce(value, '') FROM extractions WHERE tenant_id = $1
     UNION ALL SELECT 'l' || id || document_id || entity_id FROM document_entity_links WHERE tenant_id = $1
     UNION ALL SELECT 't' || id || name || plan FROM tenants WHERE id = $1) s`, [tid]))[0].fp;

/* ------------------------------------------------------------ a second company that already exists (must survive everything) */
const OTHER = '0b5e55ed-0000-4000-8000-000000000001';
await lite.exec(`
  INSERT INTO tenants (id, name, slug, clerk_org_id, plan, billing_status) VALUES ('${OTHER}', 'Other Shop', 'other-shop-r37', 'org_r37_other', 'shop', 'active');
  INSERT INTO entities (id, tenant_id, entity_type, data, customer_number)
    SELECT md5('r37-other-c-' || g)::uuid, '${OTHER}', 'customer', jsonb_build_object('customer_name', 'Other Customer ' || g, 'service_address', g || ' Elm St'), 'C-' || lpad(g::text, 5, '0') FROM generate_series(1, 40) g;
  INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, display_name)
    SELECT md5('r37-other-d-' || g)::uuid, '${OTHER}', 'other-' || g || '.pdf', 'invoice', md5('r37o' || g) || md5('r37p' || g), 'verified', now() - (g || ' hours')::interval, 'Other doc ' || g FROM generate_series(1, 120) g;
  INSERT INTO document_pages (document_id, page_no, tenant_id, text)
    SELECT md5('r37-other-d-' || g)::uuid, 1, '${OTHER}', 'Other shop service ticket compressor replaced serial OTHER' || g FROM generate_series(1, 120) g;
  INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
    SELECT '${OTHER}', md5('r37-other-d-' || g)::uuid, 'technician', 'Other Tech ' || (g % 4), 0.9 FROM generate_series(1, 120) g;
  INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by)
    SELECT '${OTHER}', md5('r37-other-d-' || g)::uuid, md5('r37-other-c-' || (1 + g % 40))::uuid, 0.9, 'ai' FROM generate_series(1, 120) g;
`);
// Inserting the pages above made this session cache a "seq scan of documents" plan for the document_pages -> documents foreign-key
// check while documents was tiny; with 50,000 documents arriving afterwards that cached plan makes every page insert scan them all.
// A real database re-plans after its routine ANALYZE (and the owner's SQL editor session has no such cached plan); do the same here.
await lite.exec('ANALYZE');
const otherBefore = await countsFor(OTHER);
const otherFp = await fingerprint(OTHER);
check('setup: a second, pre-existing company has rows in every seeded table', otherBefore.documents === 120 && otherBefore.document_pages === 120 && otherBefore.entities === 40 && otherBefore.extractions === 120 && otherBefore.document_entity_links === 120, JSON.stringify(otherBefore));
const tenantsBefore = await n1(`SELECT count(*)::int AS n FROM tenants`);

/* ------------------------------------------------------------ L1 */
console.log(`\n-- L1: seeding ${DOCS} documents`);
const l1 = await runFile(lite, 'L1', { docs: DOCS, segments: FULL });
console.log(`   L1 took ${fmt(l1.seconds)} in PGlite`);
const seeded = Object.fromEntries(l1.rows.map((r) => [r.what, Number(r.rows_created)]));
const c = await countsFor(T);
eq(`L1 seeded exactly ${DOCS} documents`, c.documents, DOCS);
eq(`L1 seeded ${sizes.customers} customers`, await n1(`SELECT count(*)::int AS n FROM entities WHERE tenant_id=$1 AND entity_type='customer'`, [T]), sizes.customers);
eq(`L1 seeded ${sizes.units} equipment units`, await n1(`SELECT count(*)::int AS n FROM entities WHERE tenant_id=$1 AND entity_type='equipment'`, [T]), sizes.units);
check('L1 result table reports the same counts it created', seeded.documents === DOCS && seeded['pages of text'] === c.document_pages && seeded['extracted fields'] === c.extractions && seeded['document links'] === c.document_entity_links, JSON.stringify(seeded));
check('every document has 1 to 3 pages of text, about 1.6 on average', c.document_pages >= DOCS && c.document_pages <= DOCS * 3 && c.document_pages / DOCS > 1.4 && c.document_pages / DOCS < 1.8, `${c.document_pages / DOCS}`);
eq('every document has page_count equal to the pages it really has', await n1(`SELECT count(*)::int AS n FROM documents d WHERE tenant_id=$1 AND page_count <> (SELECT count(*) FROM document_pages p WHERE p.document_id = d.id)`, [T]), 0);
check('money rows exist for invoices / quotes / POs / agreements', c.document_financials === await n1(`SELECT count(*)::int AS n FROM documents WHERE tenant_id=$1 AND document_type IN ('invoice','proposal-quote','purchase-order','maintenance-agreement')`, [T]) && c.document_financials > 0);
const types = await q(`SELECT document_type, count(*)::int AS n FROM documents WHERE tenant_id=$1 GROUP BY 1`, [T]);
check('document types are varied (at least 12 kinds, none over 30%)', types.length >= 12 && types.every((t) => t.n <= DOCS * 0.3), JSON.stringify(types));
const span = (await q(`SELECT min(created_at) AS lo, max(created_at) AS hi FROM documents WHERE tenant_id=$1`, [T]))[0];
check('documents are spread over about 6 years', (new Date(span.hi) - new Date(span.lo)) / (365.25 * 864e5) > (FULL ? 5.5 : 4.5), `${span.lo} .. ${span.hi}`);
check('file names are varied (more than 30% distinct)', (await n1(`SELECT count(DISTINCT original_filename)::int AS n FROM documents WHERE tenant_id=$1`, [T])) > DOCS * 0.3);
check('technician, service date, serial and amount extractions all exist', (await q(`SELECT DISTINCT field_key FROM extractions WHERE tenant_id=$1`, [T])).map((r) => r.field_key).sort().join() === 'customer_name,serial_number,service_date,technician,total_amount');
check('units carry customer name, address, manufacturer, model and serial as the app reads them', await n1(`SELECT count(*)::int AS n FROM entities WHERE tenant_id=$1 AND entity_type='equipment' AND customer_id IS NOT NULL AND data ? 'manufacturer' AND data ? 'model' AND data ? 'serial_number' AND data ? 'service_address' AND data ? 'customer_name'`, [T]) === sizes.units);
check('customers carry name, address and a C- number', await n1(`SELECT count(*)::int AS n FROM entities WHERE tenant_id=$1 AND entity_type='customer' AND data ? 'customer_name' AND data ? 'service_address' AND customer_number ~ '^C-[0-9]{5}$'`, [T]) === sizes.customers);

// Nothing may be left for the background workers (nightly recovery lists stage 'received' with no error) or for billing.
eq('no document is waiting to be processed (none in stage received, none with an error)', await n1(`SELECT count(*)::int AS n FROM documents WHERE tenant_id=$1 AND (stage='received' OR extract_error IS NOT NULL)`, [T]), 0);
const t1 = (await q(`SELECT clerk_org_id, plan, billing_status, limits FROM tenants WHERE id=$1`, [T]))[0];
check('the test company has no login (clerk_org_id NULL), so the nightly sweep never lists it, and a plan with no caps', t1.clerk_org_id === null && t1.plan === 'fleet' && t1.billing_status === 'active' && t1.limits.testAccount === true, JSON.stringify(t1));
eq('the test company is not in list_all_tenant_keys()', await n1(`SELECT count(*)::int AS n FROM list_all_tenant_keys() WHERE tenant_id = $1`, [T]), 0);
eq('no usage / billing / rate-limit / notification rows were created by the seed', await n1(`SELECT (SELECT count(*) FROM usage_counters WHERE tenant_id=$1) + (SELECT count(*) FROM rate_limit_windows WHERE tenant_id=$1) + (SELECT count(*) FROM notifications WHERE tenant_id=$1) + (SELECT count(*) FROM billing_events WHERE tenant_id=$1) + (SELECT count(*) FROM audit_log WHERE tenant_id=$1) AS n`, [T]), 0);
check('the other company was not touched by L1', JSON.stringify(await countsFor(OTHER)) === JSON.stringify(otherBefore) && (await fingerprint(OTHER)) === otherFp);
eq('exactly one new company exists after L1', await n1(`SELECT count(*)::int AS n FROM tenants`), tenantsBefore + 1);

// Row-level security: the app role sees the test company only when it asks as that company.
{
  await lite.exec('SET ROLE deepwell_rls');
  await lite.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER]);
  const asOther = await n1(`SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1`, [T]);
  const otherOwn = await n1(`SELECT count(*)::int AS n FROM documents`);
  await lite.query(`SELECT set_config('app.tenant_id', $1, false)`, [T]);
  const asTest = await n1(`SELECT count(*)::int AS n FROM documents`);
  await lite.query(`SELECT set_config('app.tenant_id', '', false)`);
  await lite.exec('RESET ROLE');
  check('row-level security: as the other company the test documents are invisible, and as the test company only its own are', asOther === 0 && otherOwn === 120 && asTest === DOCS, `asOther=${asOther} otherOwn=${otherOwn} asTest=${asTest}`);
}

// A second run must refuse, with a message that points at L3, and change nothing.
{
  const before = await countsFor(T);
  let msg = null;
  try { await runFile(lite, 'L1', { docs: DOCS }); } catch (e) { msg = String(e.message); }
  check('L1 refuses to run twice, telling the owner to run L3 first', msg !== null && /already exists/.test(msg) && /L3-remove-test-company/.test(msg), String(msg));
  check('...and the refused run changed nothing', JSON.stringify(await countsFor(T)) === JSON.stringify(before));
}

/* ------------------------------------------------------------ L2 */
console.log('\n-- L2: timing');
let l2;
try { l2 = await runFile(lite, 'L2'); } catch (e) { check('L2 runs', false, e.message); }
if (l2) {
  console.log(`   L2 took ${fmt(l2.seconds)} in PGlite`);
  const rows = l2.rows;
  eq('L2 returns one table with the documented columns', Object.keys(rows[0] ?? {}), ['step', 'check_name', 'ms', 'target_ms', 'result', 'ran_as', 'result_size', 'note']);
  const timed = rows.filter((r) => r.target_ms != null);
  check('L2 has a verdict row (step 0) and at least 24 timed checks', rows[0].step === 0 && /^OVERALL/.test(rows[0].check_name) && timed.length >= 24, `${timed.length}`);
  check('every timed check returned a number and PASS or FAIL (none ERROR)', timed.every((r) => r.ms !== null && Number(r.ms) >= 0 && ['PASS', 'FAIL'].includes(r.result)), JSON.stringify(timed.filter((r) => r.result === 'ERROR' || r.ms === null).map((r) => [r.check_name, r.note])));
  check('every row says who ran it, and it ran as the app role', timed.every((r) => r.ran_as === 'app role (deepwell_rls)'), [...new Set(timed.map((r) => r.ran_as))].join());
  const byName = (re) => rows.find((r) => re.test(r.check_name));
  eq('L2 reports the seeded document count', Number(byName(/^Seeded: documents/).result_size), DOCS);
  eq('L2 sees migrations 63 and 64 as present', [byName(/^Migration 64/).result, byName(/^Migration 63/).result], ['PASS', 'PASS']);
  check('targets: searches 300 ms, pages and counts 200 ms', timed.filter((r) => /^Records search|^Donovan/.test(r.check_name)).every((r) => r.target_ms === 300) && timed.filter((r) => /first page|Load more|^Inbox|^Billing|^Customers|^Upload|^Dashboard/.test(r.check_name)).every((r) => r.target_ms === 200));
  for (const [label, re] of [['the common word', /common word/], ['the phrase', /phrase/], ['the rare serial', /rare serial/], ['the customer name', /customer name/], ['the technician', /technician "/], ['the street name', /street name/]]) {
    const r = timed.find((x) => /^Records search/.test(x.check_name) && re.test(x.check_name));
    check(`search finds something for ${label}`, r && Number(r.result_size) > 0, JSON.stringify(r));
  }
  eq('the no-match search finds nothing', Number(byName(/no matches/).result_size), 0);
  eq('the first Records page returns a full page plus the one-extra row the app uses to know there is more', Number(byName(/first page \(newest/).result_size), Math.min(51, DOCS));
  eq('customers last page is a real page of 50', Number(byName(/Customers list: last page/).result_size), 50);
  eq('customers total count', Number(byName(/Customers list: total count/).result_size), sizes.customers);
  eq('billing document count', Number(byName(/total documents stored/).result_size), DOCS);
  console.log('\n   L2 result table (PGlite):');
  console.table(rows.map((r) => ({ step: r.step, check: r.check_name.slice(0, 74), ms: r.ms === null ? '' : Number(r.ms), target: r.target_ms ?? '', result: r.result, size: r.result_size === null ? '' : Number(r.result_size) })));
  // The same run without migration 64's function: still answers, and says what is wrong.
  await lite.exec(`REVOKE EXECUTE ON FUNCTION records_search_candidates(text, text) FROM deepwell_rls`);
  const noFn = await runFile(lite, 'L2');
  await lite.exec(`GRANT EXECUTE ON FUNCTION records_search_candidates(text, text) TO deepwell_rls`);
  const m64 = noFn.rows.find((r) => /^Migration 64/.test(r.check_name));
  check('without the search function L2 still returns every check and flags "64 not pasted - search will be slow"', noFn.rows.filter((r) => r.target_ms != null).every((r) => r.ms !== null) && m64.result === 'FAIL' && /64 not pasted - search will be slow/.test(m64.note) && noFn.rows.some((r) => /^Records search/.test(r.check_name) && /64 not pasted/.test(r.note ?? '')), JSON.stringify(m64));
  // L2 writes nothing but helper functions
  eq('L2 changed no rows', JSON.stringify(await countsFor(T)), JSON.stringify(c));
}

/* ------------------------------------------------------------ L3 */
console.log('\n-- L3: removing');
const l3 = await runFile(lite, 'L3', { segments: FULL });
console.log(`   L3 took ${fmt(l3.seconds)} in PGlite`);
const gone = await countsFor(T);
check('L3 leaves zero rows for the test company in every table', Object.values(gone).every((v) => v === 0), JSON.stringify(gone));
check('L3 result table shows every row count at 0 and PASS', l3.rows.length >= 6 && l3.rows.every((r) => Number(r.rows_left) === 0 && /^PASS/.test(r.result)), JSON.stringify(l3.rows.filter((r) => Number(r.rows_left) !== 0)));
{
  let left = 0;
  for (const t of (await q(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_name=c.table_name AND x.table_schema=c.table_schema AND x.table_type='BASE TABLE' WHERE c.table_schema='public' AND c.column_name='tenant_id'`)).map((r) => r.table_name)) left += await n1(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [T]);
  eq('...checked across all tenant-scoped tables (no stray rows anywhere)', left, 0);
}
check('the other company is untouched (same row counts, same row contents)', JSON.stringify(await countsFor(OTHER)) === JSON.stringify(otherBefore) && (await fingerprint(OTHER)) === otherFp, JSON.stringify(await countsFor(OTHER)));
eq('only the test company was removed (tenant count is back to what it was)', await n1(`SELECT count(*)::int AS n FROM tenants`), tenantsBefore);
eq('the loadtest_* helper functions are gone', await n1(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'loadtest\\_%'`), 0);
{
  let msg = null;
  try { await runFile(lite, 'L3'); } catch (e) { msg = String(e.message); }
  check('L3 can be run again safely (nothing to remove)', msg === null, String(msg));
  check('...and the other company is still untouched after the second L3', (await fingerprint(OTHER)) === otherFp);
}
// L3's own safety: it must not delete a company that has the test id but is not marked as a load-test company.
{
  await lite.exec(`INSERT INTO tenants (id, name, slug, plan, billing_status) VALUES ('${T}', 'Pretend real company', 'pretend-real-r37', 'shop', 'active')`);
  let msg = null;
  try { await runFile(lite, 'L3'); } catch (e) { msg = String(e.message); }
  check('L3 refuses to delete a company with the test id that is not marked as a load test', msg !== null && /not marked as a load-test company/.test(msg) && (await n1(`SELECT count(*)::int AS n FROM tenants WHERE id=$1`, [T])) === 1, String(msg));
  await lite.exec(`DELETE FROM tenants WHERE id = '${T}'`);
}
if (!FULL) {
  // The whole cycle works again on the same database (the "repeat the test on the same branch" path).
  await runFile(lite, 'L1', { docs: DOCS });
  check('after L3, L1 can seed again (same counts)', (await countsFor(T)).documents === DOCS);
  await runFile(lite, 'L3');
  check('...and L3 removes it again', Object.values(await countsFor(T)).every((v) => v === 0) && (await fingerprint(OTHER)) === otherFp);
}
// The seed guard: a database missing a migration is refused with a plain message (simulated by dropping a column).
{
  await lite.exec(`ALTER TABLE documents RENAME COLUMN display_name TO display_name_x`);
  let msg = null;
  try { await runFile(lite, 'L1', { docs: DOCS }); } catch (e) { msg = String(e.message); }
  await lite.exec(`ALTER TABLE documents RENAME COLUMN display_name_x TO display_name`);
  check('L1 refuses a database that is missing a migration, naming the column', msg !== null && /missing migrations/.test(msg) && /documents\.display_name/.test(msg), String(msg));
  eq('...and created nothing', await n1(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [T]), 0);
}
// Every DELETE in L3 is filtered by the test id.
{
  const l3sql = loadtestSql('L3');
  const deletes = l3sql.match(/DELETE FROM[^;]*;/g) ?? [];
  check('every DELETE statement in L3 is filtered by the test company id', deletes.length >= 3 && deletes.every((d) => /tenant_id\s*=\s*(\$1|c_tenant)|id\s*=\s*c_tenant/.test(d)), JSON.stringify(deletes.filter((d) => !/tenant_id\s*=|id\s*=\s*c_tenant/.test(d))));
}

// The owner pastes these in Neon's SQL editor as a role that may NOT be exempt from row-level security (the app role is not;
// the default owner usually is). Prove all three files also work for a role that is subject to it (FORCE RLS applies to it).
// Runs LAST: PGlite cannot get back to the superuser after SET SESSION AUTHORIZATION, and from here on only this role's own
// company is visible (so the other company's untouched-ness is the superuser checks above).
{
  await lite.exec(`CREATE ROLE lt_owner_r37 NOSUPERUSER NOBYPASSRLS LOGIN;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO lt_owner_r37; GRANT ALL ON SCHEMA public TO lt_owner_r37;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO lt_owner_r37`);
  try {
    await lite.exec('SET SESSION AUTHORIZATION lt_owner_r37');
    await runFile(lite, 'L1', { docs: 600 });
    const mid = await countsFor(T); // as this role, with app.tenant_id = the test company
    const rls = await runFile(lite, 'L2');
    await runFile(lite, 'L3');
    const left = await countsFor(T);
    check('as a role subject to row-level security: L1 seeds 600 documents (and its 72 customers + 108 units)', mid.documents === 600 && mid.entities === 72 + 108, JSON.stringify(mid));
    const timed = rls.rows.filter((r) => r.target_ms != null);
    check('...L2 still answers every check (falling back to "ran as owner" when it cannot become the app role)', timed.length >= 24 && timed.every((r) => r.ms !== null && r.result !== 'ERROR') && timed.every((r) => r.ran_as === 'ran as owner') && /could not switch/.test(rls.rows[0].note), JSON.stringify(timed.filter((r) => r.result === 'ERROR').map((r) => [r.check_name, r.note])));
    check('...and L3 removes everything again', Object.values(left).every((v) => v === 0), JSON.stringify(left));
  } catch (e) { check('L1/L2/L3 work for a role subject to row-level security', false, String(e.message)); }
}

if (dataDir && !process.env.LOADTEST_DATADIR) fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll load-test file checks passed');
process.exit(failed ? 1 : 0);
