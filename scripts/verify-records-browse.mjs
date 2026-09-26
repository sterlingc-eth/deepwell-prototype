/**
 * Records Browse (round 12 contract, G2) — api/_lib/recordsStore.js's
 * browseDocuments: server-side filter/sort/search/facets/paging behind the
 * records screen, replacing listDocuments' LIMIT-500 cap.
 *
 * No network, no Anthropic key, no DATABASE_URL: the database is a REAL
 * Postgres (PGlite, in process) loaded from the actual M3-config/*.sql
 * migrations and queried as the app's non-superuser NOBYPASSRLS role
 * (deepwell_rls), exactly like scripts/verify-agent.mjs/verify-financials.mjs
 * (same harness) — withTenant()/makeStore() run unmodified.
 *
 *   1. pure: normalizeBrowseFilters, cursor encode/decode, isoPlusDays
 *   2. every filter individually + in combination, tenant isolation, facet
 *      counts (respecting every OTHER active filter, never their own)
 *   3. sort stability (every sort id, ties broken by id, no dup/missing rows
 *      across pages), cursor paging across 1,500 documents
 *   4. SQL injection attempts in every text filter and the search box
 *
 *   node scripts/verify-records-browse.mjs
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

const {
  normalizeBrowseFilters, browseFiltersKey, encodeBrowseCursor, decodeBrowseCursor, isoPlusDays,
  BROWSE_SORTS, DEFAULT_BROWSE_SORT, STAGE_BUCKETS, WARRANTY_BUCKETS,
} = await import('../api/_lib/recordsStore.js');

/* ================================================================== 1. pure */
{
  const f = normalizeBrowseFilters({});
  eq('normalizeBrowseFilters: empty input -> default sort/limit, everything else null', f, {
    documentType: null, customerId: null, site: null, technician: null, brand: null,
    stageBucket: null, warrantyBucket: null, hasMoney: null, openBalance: null, uploadedByMe: null,
    serviceDateFrom: null, serviceDateTo: null, uploadDateFrom: null, uploadDateTo: null,
    q: null, sort: DEFAULT_BROWSE_SORT, limit: 50, cursor: null,
  });
  eq('normalizeBrowseFilters: unknown sort id falls back to default', normalizeBrowseFilters({ sort: 'nonsense; DROP TABLE documents' }).sort, DEFAULT_BROWSE_SORT);
  eq('normalizeBrowseFilters: unknown stage/warranty bucket dropped, not passed through', [normalizeBrowseFilters({ stageBucket: 'deleted' }).stageBucket, normalizeBrowseFilters({ warrantyBucket: 'nope' }).warrantyBucket], [null, null]);
  eq('normalizeBrowseFilters: every real stage/warranty bucket accepted', [
    STAGE_BUCKETS.every((b) => normalizeBrowseFilters({ stageBucket: b }).stageBucket === b),
    WARRANTY_BUCKETS.every((b) => normalizeBrowseFilters({ warrantyBucket: b }).warrantyBucket === b),
  ], [true, true]);
  eq('normalizeBrowseFilters: limit clamps to [1,200], default 50', [
    normalizeBrowseFilters({ limit: 0 }).limit, normalizeBrowseFilters({ limit: 5000 }).limit, normalizeBrowseFilters({ limit: -1 }).limit, normalizeBrowseFilters({ limit: 'abc' }).limit, normalizeBrowseFilters({ limit: 25.9 }).limit,
  ], [50, 200, 50, 50, 25]);
  eq('normalizeBrowseFilters: malformed dates dropped', [
    normalizeBrowseFilters({ serviceDateFrom: '09/01/2026' }).serviceDateFrom,
    normalizeBrowseFilters({ serviceDateFrom: "2026-01-01'; DROP TABLE documents; --" }).serviceDateFrom,
    normalizeBrowseFilters({ serviceDateFrom: '2026-01-01' }).serviceDateFrom,
  ], [null, null, '2026-01-01']);
  eq('normalizeBrowseFilters: booleans only ever true/false/null, never a truthy string coerced', [
    normalizeBrowseFilters({ hasMoney: 'true' }).hasMoney, normalizeBrowseFilters({ hasMoney: true }).hasMoney, normalizeBrowseFilters({ hasMoney: false }).hasMoney,
  ], [null, true, false]);
  eq('normalizeBrowseFilters: q is trimmed and capped', normalizeBrowseFilters({ q: `  ${'x'.repeat(300)}  ` }).q.length, 200);

  eq('browseFiltersKey: limit and cursor excluded (a page-size change or paging keeps the same key)', browseFiltersKey({ sort: 'upload-date', limit: 50, cursor: 'abc' }), browseFiltersKey({ sort: 'upload-date', limit: 200, cursor: 'xyz' }));
  eq('browseFiltersKey: a real filter change DOES change the key', browseFiltersKey({ sort: 'upload-date', documentType: 'invoice' }) === browseFiltersKey({ sort: 'upload-date', documentType: 'permit' }), false);

  const key = browseFiltersKey(normalizeBrowseFilters({ documentType: 'invoice' }));
  eq('cursor round-trips', decodeBrowseCursor(encodeBrowseCursor(120, key), key), 120);
  eq('cursor minted for a DIFFERENT filters key restarts at 0', decodeBrowseCursor(encodeBrowseCursor(120, key), 'a-different-key'), 0);
  eq('malformed/empty/tampered cursor restarts at 0', [decodeBrowseCursor('', key), decodeBrowseCursor(null, key), decodeBrowseCursor('not-base64-json!!', key), decodeBrowseCursor(Buffer.from('{"o":-1,"f":"x"}').toString('base64url'), 'x')], [0, 0, 0, 0]);

  eq('isoPlusDays: 90 days from a fixed date', isoPlusDays('2026-01-01', 90), '2026-04-01');
  eq('isoPlusDays: crosses a year boundary', isoPlusDays('2026-12-15', 30), '2027-01-14');

  eq('every BROWSE_SORTS expr is a bare identifier (never string-built from caller input downstream)', Object.values(BROWSE_SORTS).every((s) => /^[a-z_]+$/.test(s.expr) && ['ASC', 'DESC'].includes(s.dir)), true);
}

/* ================================================================== harness: real Postgres via PGlite */
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
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { console.log(`NOTE  migration harness: ${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after resolve_tenant() exists, same as verify-agent.mjs */ }

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

const ctxA = { tenantKey: 'org_browse_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_browse_b', tenantName: 'Rival Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

// Deterministic, collision-free, and always a VALID uuid: t/k are short tags
// (e.g. 'a'/'scale'), not necessarily hex digits, so they're hashed into hex
// nibbles rather than spliced in raw.
const hex2 = (s) => String(s).charCodeAt(0).toString(16).padStart(2, '0');
const uid = (t, k, n) => `${hex2(t)}${hex2(t)}${hex2(k)}${hex2(k)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedBasics(t, tenantId) {
  const ent = (id, type, data, customerId = null) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [id, tenantId, type, JSON.stringify(data), customerId]);
  await ent(uid(t, 'c', 1), 'customer', { customer_name: 'Karen Abernathy', service_address: '412 Elm St, Mesa, AZ 85201' });
  await ent(uid(t, 'c', 2), 'customer', { customer_name: 'Bill Whitmore', service_address: '88 Whitmore Ave, Mesa, AZ 85201' });
  await ent(uid(t, 'e', 1), 'equipment', { manufacturer: 'Trane', model: 'XR14', service_address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2026-11-01' } }, uid(t, 'c', 1));
  await ent(uid(t, 'e', 2), 'equipment', { manufacturer: 'Goodman', model: 'GSX14', service_address: '88 Whitmore Ave, Mesa, AZ 85201', warranty: { expires: '2020-01-01' } }, uid(t, 'c', 2));

  const doc = async (n, { file = `doc-${n}.pdf`, type = 'invoice', stage = 'verified', createdAt, uploadedBy = null }) => {
    await lite.query(
      `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uid(t, 'd', n), tenantId, file, type, `${t}-hash-${n}`, stage, createdAt ?? '2026-09-01T00:00:00Z', uploadedBy]
    );
    return uid(t, 'd', n);
  };
  const link = (n, entityId) => lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', n), entityId]);
  const fact = (n, key, value, confidence = 0.9) => lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5)', [tenantId, uid(t, 'd', n), key, value, confidence]);
  const money = (n, { total, balance_due = null, status = 'unknown' }) => lite.query(
    `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, total, balance_due, status) VALUES ($1,$2,'invoice','receivable',$3,$4,$5)`,
    [tenantId, uid(t, 'd', n), total, balance_due, status]
  );

  await doc(1, { file: 'karen-invoice.pdf', type: 'invoice', stage: 'verified', createdAt: '2026-09-10T00:00:00Z', uploadedBy: 'user_alice' });
  await link(1, uid(t, 'c', 1)); await link(1, uid(t, 'e', 1));
  await fact(1, 'service_date', '2026-09-05'); await fact(1, 'technician', 'D. Ramirez');
  await money(1, { total: '500.00', balance_due: '0.00', status: 'paid' });

  await doc(2, { file: 'whitmore-workorder.pdf', type: 'work-order', stage: 'read', createdAt: '2026-09-15T00:00:00Z' });
  await link(2, uid(t, 'c', 2)); await link(2, uid(t, 'e', 2));
  await fact(2, 'service_date', '2026-09-12'); await fact(2, 'technician', 'M. Ortiz');
  await money(2, { total: '250.00', balance_due: '250.00', status: 'unpaid' });

  await doc(3, { file: '34534895.pdf', type: null, stage: 'received', createdAt: '2026-09-20T00:00:00Z' });

  return { customer1: uid(t, 'c', 1), customer2: uid(t, 'c', 2) };
}

const idsA = await seedBasics('a', tenA);
await seedBasics('b', tenB);

const browse = (ctx, filters, opts) => withTenant(ctx, (db) => db.browseDocuments(filters, opts));

/* ================================================================== 2. filters, tenant isolation, facets */
{
  const all = await browse(ctxA, {});
  eq('no filters: every tenant-A document returned, none of tenant B\'s', [all.total, all.rows.length], [3, 3]);
  const tenantAPrefix = hex2('a') + hex2('a');
  check('tenant isolation: tenant A never sees a B document id', all.rows.every((r) => r.id.startsWith(tenantAPrefix)), JSON.stringify(all.rows.map((r) => r.id)));

  const byType = await browse(ctxA, { documentType: 'invoice' });
  eq('filter: documentType', byType.rows.map((r) => r.filename), ['karen-invoice.pdf']);

  const byStage = await browse(ctxA, { stageBucket: 'verified' });
  eq('filter: stageBucket verified', byStage.rows.map((r) => r.filename), ['karen-invoice.pdf']);
  const missing = await browse(ctxA, { stageBucket: 'missing-info' });
  eq('filter: stageBucket missing-info (received stage / no type)', missing.rows.map((r) => r.filename), ['34534895.pdf']);
  const needsReview = await browse(ctxA, { stageBucket: 'needs-review' });
  eq('filter: stageBucket needs-review', needsReview.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  const byCustomer = await browse(ctxA, { customerId: idsA.customer1 });
  eq('filter: customerId', byCustomer.rows.map((r) => r.filename), ['karen-invoice.pdf']);

  const bySite = await browse(ctxA, { site: '88 Whitmore Ave, Mesa, AZ 85201' });
  eq('filter: site (exact address)', bySite.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  const byTech = await browse(ctxA, { technician: 'M. Ortiz' });
  eq('filter: technician', byTech.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  const byBrand = await browse(ctxA, { brand: 'Trane' });
  eq('filter: brand', byBrand.rows.map((r) => r.filename), ['karen-invoice.pdf']);

  const byWarranty = await browse(ctxA, { warrantyBucket: 'expired' });
  eq('filter: warrantyBucket expired', byWarranty.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  const byMoney = await browse(ctxA, { hasMoney: true });
  eq('filter: hasMoney', byMoney.rows.map((r) => r.filename).sort(), ['karen-invoice.pdf', 'whitmore-workorder.pdf']);
  const byOpenBalance = await browse(ctxA, { openBalance: true });
  eq('filter: openBalance', byOpenBalance.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  const byUploader = await browse(ctxA, { uploadedByMe: true }, { currentUserId: 'user_alice' });
  eq('filter: uploadedByMe', byUploader.rows.map((r) => r.filename), ['karen-invoice.pdf']);
  const byUploaderNone = await browse(ctxA, { uploadedByMe: true }, { currentUserId: 'user_bob' });
  eq('filter: uploadedByMe (a different user sees none of these)', byUploaderNone.rows.length, 0);

  const byServiceDate = await browse(ctxA, { serviceDateFrom: '2026-09-10', serviceDateTo: '2026-09-30' });
  eq('filter: service date range', byServiceDate.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);
  const byUploadDate = await browse(ctxA, { uploadDateFrom: '2026-09-16', uploadDateTo: '2026-09-30' });
  eq('filter: upload date range (distinct from service date)', byUploadDate.rows.map((r) => r.filename), ['34534895.pdf']);

  const byQFilename = await browse(ctxA, { q: 'karen' });
  eq('search: matches filename', byQFilename.rows.map((r) => r.filename), ['karen-invoice.pdf']);
  const byQCustomer = await browse(ctxA, { q: 'whitmore' });
  eq('search: matches linked customer name/address', byQCustomer.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);
  const byQTech = await browse(ctxA, { q: 'ortiz' });
  eq('search: matches technician', byQTech.rows.map((r) => r.filename), ['whitmore-workorder.pdf']);

  // Combinations: two real filters that both match the same one document,
  // and two that individually match different documents (empty intersection).
  const combo = await browse(ctxA, { documentType: 'invoice', customerId: idsA.customer1 });
  eq('combination: documentType + customerId (same doc)', combo.rows.map((r) => r.filename), ['karen-invoice.pdf']);
  const comboNone = await browse(ctxA, { documentType: 'invoice', customerId: idsA.customer2 });
  eq('combination: documentType + customerId (no doc matches both)', comboNone.rows.length, 0);

  // Facet counts: picking one option must never remove ITS OWN sibling
  // options from that same facet (counted with every OTHER filter, never
  // its own) — but a filter on a DIFFERENT dimension does narrow it.
  const facetsAll = all.facets;
  const typeFacetAll = facetsAll.find((f) => f.key === 'documentType').options;
  eq('facets (no filters): documentType has both real types, counts 1 each', typeFacetAll.map((o) => [o.value, o.count]).sort(), [['invoice', 1], ['work-order', 1]]);

  const filteredByType = await browse(ctxA, { documentType: 'invoice' });
  const typeFacetFiltered = filteredByType.facets.find((f) => f.key === 'documentType').options;
  eq('facets: picking "invoice" does not remove "work-order" from the Type facet\'s own options', typeFacetFiltered.map((o) => o.value).sort(), ['invoice', 'work-order']);

  const custFacetFiltered = filteredByType.facets.find((f) => f.key === 'customerId').options;
  eq('facets: a DIFFERENT dimension (Customer) IS narrowed by the Type filter', custFacetFiltered.length, 1);

  const hasMoneyFacet = all.facets.find((f) => f.key === 'hasMoney');
  eq('facets: boolean facet reports a trueCount, not an options list', typeof hasMoneyFacet.trueCount, 'number');
  eq('facets: hasMoney trueCount matches the two money documents', hasMoneyFacet.trueCount, 2);
}

/* ================================================================== 3. sort stability + cursor paging at scale */
{
  const tenC = (await getTenantContext('org_browse_scale', 'Scale Shop')).id;
  const ctxC = { tenantKey: 'org_browse_scale', tenantName: 'Scale Shop' };
  const N = 1500;
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(`('${uid('s', 'd', i)}', '${tenC}', 'scale-${i}.pdf', 'invoice', 'scale-hash-${i}', 'verified', now() - (${i} || ' minutes')::interval)`);
  }
  // One INSERT for all 1,500 rows — fast, and exercises the same code path a
  // real backlog import would.
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ${rows.join(',')}`);

  for (const sortId of Object.keys(BROWSE_SORTS)) {
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    let total = null;
    do {
      const page = await browse(ctxC, { sort: sortId, cursor, limit: 200 });
      total = page.total;
      for (const r of page.rows) seen.add(r.id);
      cursor = page.nextCursor;
      pages++;
      if (pages > 20) break; // guard against an infinite loop if hasMore is ever wrong
    } while (cursor);
    eq(`cursor paging (sort=${sortId}): every one of ${N} documents seen exactly once across pages, no cap at 500`, [seen.size, total], [N, N]);
  }

  // Sort stability: the SAME query run twice (a page a person might reload)
  // returns rows in the identical order — ties (same amount/date/etc, since
  // these are all 'invoice'/'verified') are broken by id, not left to chance.
  const page1a = await browse(ctxC, { sort: 'type', limit: 50 });
  const page1b = await browse(ctxC, { sort: 'type', limit: 50 });
  eq('sort stability: identical filters/sort return identical row order', page1a.rows.map((r) => r.id), page1b.rows.map((r) => r.id));
}

/* ================================================================== 4. SQL injection attempts */
{
  const payloads = [
    "'; DROP TABLE documents; --",
    "' OR '1'='1",
    "x'); DELETE FROM documents WHERE ('1'='1",
    'Robert"); DROP TABLE documents;--',
    "%' UNION SELECT tenant_id, 1, 2 FROM tenants --",
  ];
  for (const p of payloads) {
    for (const filters of [{ q: p }, { customerId: p }, { site: p }, { technician: p }, { brand: p }, { documentType: p }]) {
      let threw = false;
      let result;
      try { result = await browse(ctxA, filters); } catch { threw = true; }
      check(`injection payload is inert (no throw, no crash) — ${JSON.stringify(filters)} = ${JSON.stringify(p).slice(0, 40)}`, !threw && Array.isArray(result?.rows));
    }
  }
  // A NUL byte can't appear in a Postgres `text` value at the wire-protocol
  // level (true for a parameterized value exactly as much as for a literal)
  // — Postgres itself rejects it before any query text is even considered,
  // so this is Postgres refusing invalid input, not an injection risk. The
  // one thing that must never happen is the value making it into the SQL
  // text unescaped, which parameterization already rules out.
  for (const filters of [{ q: '\u0000\u0000' }, { customerId: '\u0000\u0000' }]) {
    let threw = false;
    try { await browse(ctxA, filters); } catch { threw = true; }
    check(`NUL byte in a filter value is safely rejected by Postgres, not executed as SQL — ${JSON.stringify(filters)}`, threw);
  }
  // The tables themselves must still be exactly as seeded — no payload above
  // actually executed as SQL.
  const stillThere = await withTenant(ctxA, (db) => db.raw('SELECT count(*)::int AS n FROM documents', []));
  eq('documents table untouched after every injection attempt', stillThere.rows[0].n, 3);
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`${passes} checks passed.`);
