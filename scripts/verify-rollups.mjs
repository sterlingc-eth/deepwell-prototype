/**
 * Checks for precomputed rollups (api/_lib/rollups/{refresh,read}.js,
 * M3-config/40-rollups-and-semantic-cache.sql's tenant_rollups).
 *
 * Real Postgres via PGlite (same harness convention as scripts/
 * verify-count-parity.mjs / verify-semantic-cache.mjs): every migration is
 * loaded for real, RLS is genuinely in force, and every rollup number is
 * checked for PARITY against an equivalent live SQL / analytics.js query —
 * never just "a number came back".
 *
 *   node scripts/verify-rollups.mjs
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
/** Plain-object equality regardless of key insertion order (bucket maps are
 *  built from GROUP BY / Map iteration, whose order is never a correctness
 *  property this suite cares about). */
const eqMap = (name, got, want) => {
  const sort = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  eq(name, sort(got), sort(want));
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.VOYAGE_API_KEY;
console.warn = () => {};

let PGlite, contrib = {}, vectorExt;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  vectorExt = (await import('@electric-sql/pglite-pgvector')).vector;
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite / pgvector is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const cfgDir = path.join(ROOT, 'M3-config');
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();

async function freshLite(migrations) {
  const lite = new PGlite({ extensions: { ...contrib, vector: vectorExt } });
  const notes = [];
  for (const f of migrations) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 100)}`); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run failed: ${err.message}`); }
  return { lite, notes };
}

function wirePg(lite, pgMod) {
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
}

const pgMod = (await import('pg')).default;

/* ================================================================== full stack: all migrations */
{
  const { lite, notes } = await freshLite(allMigrations);
  wirePg(lite, pgMod);
  for (const n of notes) console.log(`NOTE  migration harness: ${n}`);
  check('harness: migration 40 loaded cleanly', !notes.some((n) => n.startsWith('40-')));

  const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
  const rollups = await import('../api/_lib/rollups/index.js');
  const { deriveGeo, warrantyStatusOf, UNKNOWN_BUCKET } = await import('../api/_lib/analytics.js');

  const ctx = { tenantKey: 'org_rollups', tenantName: 'Rollups Shop' };
  const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const uid = (kind, n) => `dab00000-0000-4000-9${kind}00-${String(n).padStart(12, '0')}`;
  const eId = (n) => uid('e', n);
  const dId = (n) => uid('d', n);
  const TODAY = '2026-09-25';

  const EQUIPMENT = [
    { manufacturer: 'Trane', address: '123 Main St, Mesa, AZ 85201', warranty: { expires: '2030-01-01' } },       // active
    { manufacturer: 'Trane', address: '456 Oak Ave, Mesa, AZ 85201', warranty: { expires: '2020-01-01' } },       // expired
    { manufacturer: 'Carrier', address: '789 Pine Rd, Tempe, AZ 85281', warranty: { expires: '2026-10-01' } },    // expiring
    { manufacturer: 'Carrier', address: '111 Elm Dr, Tempe, AZ 85281', warranty: null },                          // unknown
    { manufacturer: '', address: '222 Cedar Ln, Gilbert, AZ 85234', warranty: null },                              // blank brand -> Unknown
  ];
  const DOC_TYPES = ['invoice', 'invoice', 'work_order', 'estimate', null];

  await withTenant(ctx, async (db) => {
    for (let i = 0; i < EQUIPMENT.length; i++) {
      const e = EQUIPMENT[i];
      await db.raw(
        `INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1, $2, 'equipment', $3::jsonb)`,
        [eId(i), tenId, JSON.stringify({ manufacturer: e.manufacturer, service_address: e.address, warranty: e.warranty })]
      );
    }
    for (let i = 0; i < DOC_TYPES.length; i++) {
      await db.raw(
        `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1, $2, $3, $4, $5, 'verified')`,
        [dId(i), tenId, `doc${i}.pdf`, DOC_TYPES[i], `hash-${i}`]
      );
    }
  });

  /* ------------------------------------------------------------ 1. equipment_brand parity */
  await withTenant(ctx, async (db) => {
    const brands = await rollups.getBrandCounts(db, { today: TODAY });
    const live = await db.raw(
      `SELECT COALESCE(NULLIF(trim(data->>'manufacturer'), ''), $1) AS bucket, count(*)::int AS n
         FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND tenant_id = $2 GROUP BY 1`,
      [UNKNOWN_BUCKET, tenId]
    );
    const liveMap = Object.fromEntries(live.rows.map((r) => [r.bucket, Number(r.n)]));
    const rollupMap = Object.fromEntries((brands ?? []).map((r) => [r.bucket, r.count]));
    eqMap('equipment_brand: rollup matches live SQL exactly', rollupMap, liveMap);
    eq('equipment_brand: Trane count is 2', rollupMap.Trane, 2);
    eq('equipment_brand: blank manufacturer buckets as Unknown', rollupMap[UNKNOWN_BUCKET], 1);
  });

  /* ------------------------------------------------------------ 2. document_type parity */
  await withTenant(ctx, async (db) => {
    const types = await rollups.getDocTypeCounts(db, { today: TODAY });
    const live = await db.raw(
      `SELECT COALESCE(NULLIF(trim(document_type), ''), $1) AS bucket, count(*)::int AS n
         FROM documents WHERE tenant_id = $2 GROUP BY 1`,
      [UNKNOWN_BUCKET, tenId]
    );
    const liveMap = Object.fromEntries(live.rows.map((r) => [r.bucket, Number(r.n)]));
    const rollupMap = Object.fromEntries((types ?? []).map((r) => [r.bucket, r.count]));
    eqMap('document_type: rollup matches live SQL exactly', rollupMap, liveMap);
    eq('document_type: null document_type buckets as Unknown', rollupMap[UNKNOWN_BUCKET], 1);
  });

  /* ------------------------------------------------------------ 3. customer_city + warranty_status parity vs deriveGeo/warrantyStatusOf */
  await withTenant(ctx, async (db) => {
    const cities = await rollups.getCityCounts(db, { today: TODAY });
    const rawAddrs = (await db.raw(`SELECT data->>'service_address' AS a FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment'`, [tenId])).rows;
    // customer_city is computed over entity_type='customer' (none inserted here -> empty, but
    // the SAME pure function must agree when there ARE customers): exercised directly on the
    // equipment addresses above via deriveGeo for a same-function parity check instead.
    const expectCityForEquipmentAddrs = {};
    for (const r of rawAddrs) { const c = deriveGeo(r.a).city || UNKNOWN_BUCKET; expectCityForEquipmentAddrs[c] = (expectCityForEquipmentAddrs[c] ?? 0) + 1; }
    check('customer_city: no customers on file -> null (not a crash, not a false empty answer)', cities === null || cities.length === 0);
    check('deriveGeo parity sanity: Mesa/Tempe/Gilbert all derivable from the fixture addresses', Object.keys(expectCityForEquipmentAddrs).length >= 3, JSON.stringify(expectCityForEquipmentAddrs));

    const warranty = await rollups.getWarrantyStatusCounts(db, { today: TODAY });
    const rawWarranties = (await db.raw(`SELECT data->'warranty' AS w FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment'`, [tenId])).rows;
    const expectWarranty = {};
    for (const r of rawWarranties) { const s = warrantyStatusOf(r.w, TODAY) || UNKNOWN_BUCKET; expectWarranty[s] = (expectWarranty[s] ?? 0) + 1; }
    const warrantyMap = Object.fromEntries((warranty ?? []).map((r) => [r.bucket, r.count]));
    eqMap('warranty_status: rollup matches warrantyStatusOf applied row-by-row', warrantyMap, expectWarranty);
    check('warranty_status: has at least one active, one expired, one unknown bucket', warrantyMap.active >= 1 && warrantyMap.expired >= 1 && warrantyMap.unknown >= 1, JSON.stringify(warrantyMap));
  });

  /* ------------------------------------------------------------ 4. customer_city with real customers */
  const cId = (n) => uid('c', n);
  const CUSTOMERS = [
    '100 First St, Mesa, AZ 85201',
    '200 Second St, Mesa, AZ 85201',
    '300 Third St, Tempe, AZ 85281',
  ];
  await withTenant(ctx, async (db) => {
    for (let i = 0; i < CUSTOMERS.length; i++) {
      await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1, $2, 'customer', $3::jsonb)`,
        [cId(i), tenId, JSON.stringify({ customer_name: `Customer ${i}`, service_address: CUSTOMERS[i] })]);
    }
  });
  await withTenant(ctx, async (db) => {
    const cities = await rollups.getCityCounts(db, { today: TODAY });
    const cityMap = Object.fromEntries((cities ?? []).map((r) => [r.bucket, r.count]));
    const expect = {};
    for (const a of CUSTOMERS) { const c = deriveGeo(a).city || UNKNOWN_BUCKET; expect[c] = (expect[c] ?? 0) + 1; }
    eqMap('customer_city: rollup matches deriveGeo applied to each customer address', cityMap, expect);
    eq('customer_city: two Mesa customers, one Tempe', [cityMap.Mesa, cityMap.Tempe], [2, 1]);
  });

  /* ------------------------------------------------------------ 5. staleness: a new equipment row changes corpus_stamp and is picked up */
  await withTenant(ctx, async (db) => {
    const before = await rollups.getBrandCounts(db, { today: TODAY });
    const beforeMap = Object.fromEntries((before ?? []).map((r) => [r.bucket, r.count]));
    await db.raw(`INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1, $2, 'equipment', $3::jsonb)`,
      [eId(99), tenId, JSON.stringify({ manufacturer: 'Trane', service_address: '999 New Unit Ave, Mesa, AZ 85201' })]);
    const after = await rollups.getBrandCounts(db, { today: TODAY }); // autoRefresh default true, no explicit refreshMetric call
    const afterMap = Object.fromEntries((after ?? []).map((r) => [r.bucket, r.count]));
    eq('staleness: a corpus change is picked up automatically on the next read (lazy refresh)', afterMap.Trane, (beforeMap.Trane ?? 0) + 1);
  });

  /* ------------------------------------------------------------ 6. warranty_status is date-sensitive even with an unchanged corpus */
  await withTenant(ctx, async (db) => {
    const day1 = await rollups.getWarrantyStatusCounts(db, { today: '2026-09-25' });
    const day1Map = Object.fromEntries((day1 ?? []).map((r) => [r.bucket, r.count]));
    // Same data, but the Carrier unit expiring 2026-10-01 crosses from
    // "expiring" (within 30 days of 09-25) to "expired" a couple years
    // later, with NO corpus write in between — only the date-sensitivity
    // check (not corpus_stamp) can catch this. The other Trane unit
    // (expires 2030) is still comfortably active either date, so it must
    // NOT move — this pins the recompute to be date-driven, not a blanket
    // "everything expires" bug.
    const later = await rollups.getWarrantyStatusCounts(db, { today: '2028-01-01' });
    const laterMap = Object.fromEntries((later ?? []).map((r) => [r.bucket, r.count]));
    check('warranty_status: recomputes on a later "today" with no corpus change', JSON.stringify(day1Map) !== JSON.stringify(laterMap), `${JSON.stringify(day1Map)} vs ${JSON.stringify(laterMap)}`);
    eq('warranty_status: the still-far-future warranty (expires 2030) stays active', laterMap.active, day1Map.active);
    eq('warranty_status: only the unit that was "expiring" in 2026 has newly expired by 2028', laterMap.expired, day1Map.expired + (day1Map.expiring ?? 0));
    eq('warranty_status: nothing newly "expiring" by 2028 (no unit sits in that window)', laterMap.expiring ?? 0, 0);
    eq('warranty_status: unknown-warranty count is unaffected by the date', laterMap.unknown, day1Map.unknown);
  });

  /* ------------------------------------------------------------ 7. open_invoices: null without migration 22 (already true here — 22 IS loaded in the full stack, so test the OTHER direction: with real rows) */
  await withTenant(ctx, async (db) => {
    const exists = (await db.raw(`SELECT to_regclass('public.document_financials') IS NOT NULL AS ok`, [])).rows[0]?.ok;
    check('harness: document_financials exists in the full-stack run (migration 22 loaded)', exists === true);
    const rows = [
      { doc: 0, total: 500, paid: 0, due: '2026-08-01', status: 'unpaid' },   // overdue, open
      { doc: 1, total: 300, paid: 100, due: '2026-10-01', status: 'partial' }, // open, not yet due
      { doc: 2, total: 200, paid: 200, due: '2026-08-01', status: 'paid' },   // NOT open
    ];
    for (const r of rows) {
      await db.raw(
        `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, total, amount_paid, balance_due, due_date, status)
         VALUES ($1, $2, 'invoice', 'receivable', 'USD', $3, $4, $5, $6, $7)`,
        [tenId, dId(r.doc), r.total, r.paid, r.total - r.paid, r.due, r.status]
      );
    }
  });
  await withTenant(ctx, async (db) => {
    const open = await rollups.getOpenInvoiceTotals(db, { today: TODAY });
    check('open_invoices: rollup is available once migration 22 data exists', open !== null, JSON.stringify(open));
    eq('open_invoices: count matches the two open (unpaid/partial) rows', open?.count, 2);
    eq('open_invoices: sum matches 500 + 200 = 700.00 dollars, in cents', open?.totalCents, 70000);
  });

  /* ------------------------------------------------------------ 8. corpus_stamp is shared with askCache.js (one invalidation signal) */
  await withTenant(ctx, async (db) => {
    const rollupStamp = await rollups.getCorpusStamp(db, { today: TODAY });
    const { getCacheEntry } = await import('../api/_lib/askCache.js');
    const { corpusStamp: askStamp } = await getCacheEntry(db, { questionHash: '__unrelated__', today: TODAY });
    // Different promptVersion suffixes (by design — see refresh.js's doc comment), but the
    // underlying DB-stamp portion (before the ':') must be identical either way.
    check('corpus_stamp: rollups and ask_answer_cache derive from the SAME underlying DB stamp',
      rollupStamp.split(':')[0] === askStamp.split(':')[0], `${rollupStamp} vs ${askStamp}`);
  });
}

/* ================================================================== migration-optional: 40 (and 22) never applied */
{
  const without40 = allMigrations.filter((f) => !f.startsWith('40-') && !f.startsWith('22-'));
  const { lite } = await freshLite(without40);
  wirePg(lite, pgMod);
  // Fresh module graph: the tableExists probes are memoized at module scope,
  // and this is a genuinely different database.
  // Reuse the SAME module instances as the full-stack block above (a fresh
  // query-string import only busts the barrel file, not refresh.js/read.js's
  // own memoized tableExists — see their _reset*ForTests exports) and
  // explicitly reset every probe memo before pointing them at this new,
  // migration-40-and-22-less database.
  const rollups = await import('../api/_lib/rollups/index.js');
  const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
  const { _resetFinancialsProbe } = await import('../api/_lib/financials/store.js');
  rollups._resetRollupsStateForTests();
  rollups._resetRollupsReadStateForTests();
  _resetFinancialsProbe(); // this harness's DB has no document_financials table (22 excluded) — don't trust the OTHER harness's memoized "true" above.
  const ctx = { tenantKey: 'org_rollups_no_migration', tenantName: 'No Migration Shop' };
  await getTenantContext(ctx.tenantKey, ctx.tenantName);

  let threw = null;
  let results;
  try {
    results = await withTenant(ctx, async (db) => ({
      brands: await rollups.getBrandCounts(db, {}),
      docTypes: await rollups.getDocTypeCounts(db, {}),
      cities: await rollups.getCityCounts(db, {}),
      warranty: await rollups.getWarrantyStatusCounts(db, {}),
      openInvoices: await rollups.getOpenInvoiceTotals(db, {}),
      refreshed: await rollups.refreshAllRollups(db, {}),
    }));
  } catch (err) { threw = err; }
  check('migration-optional: no throw with migration 40 (and 22) unapplied', threw === null, threw?.message);
  check('migration-optional: every getter returns null (caller falls back to live SQL)',
    threw === null && results.brands === null && results.docTypes === null && results.cities === null &&
    results.warranty === null && results.openInvoices === null, JSON.stringify(results));
  check('migration-optional: refreshAllRollups reports every metric as not-refreshed, not an error',
    threw === null && Object.values(results.refreshed).every((v) => v === false), JSON.stringify(results?.refreshed));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
console.log(`${passes} checks passed.`);
