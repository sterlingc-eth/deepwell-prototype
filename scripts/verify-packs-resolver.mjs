/**
 * Pack resolver tests (slice 1A, 2026-10-02): pure normalisation, legacy
 * default, general, kill switch, features, cache + invalidation, and a
 * flag-leak test across two companies on a real (PGlite) database.
 *   node scripts/verify-packs-resolver.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `\n      ${d}`}`); };
const eq = (n, g, w) => check(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.DEEPWELL_PACKS_ENABLED;

const R = await import('../api/_lib/industry/resolver.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');

/* 1. pure */
eq('missing key -> legacy', R.normalizePacks(undefined), ['equipment', 'hvac']);
eq('null -> legacy', R.normalizePacks(null), ['equipment', 'hvac']);
eq('string (malformed) -> legacy', R.normalizePacks('hvac'), ['equipment', 'hvac']);
eq('[] -> general', R.normalizePacks([]), []);
check('[] isGeneral', R.isGeneral(R.normalizePacks([])));
eq('hvac auto-includes equipment', R.normalizePacks(['hvac']), ['equipment', 'hvac']);
eq('equipment alone allowed', R.normalizePacks(['equipment']), ['equipment']);
eq('unknown ids dropped', R.normalizePacks(['hvac', 'bogus']), ['equipment', 'hvac']);
eq('only unknown -> legacy (fail safe)', R.normalizePacks(['bogus']), ['equipment', 'hvac']);
eq('case/space tolerant + dedupe', R.normalizePacks([' HVAC ', 'hvac']), ['equipment', 'hvac']);
eq('property needs no equipment', R.normalizePacks(['property']), ['property']);
eq('legacy list is not shared/mutable', (() => { const a = R.normalizePacks(undefined); a.push('x'); return R.normalizePacks(undefined); })(), ['equipment', 'hvac']);
eq('settings null -> legacy', R.packsFromSettings(null), ['equipment', 'hvac']);
eq('settings {packs:[]} -> general', R.packsFromSettings({ packs: [] }), []);
eq('general has no features', R.featuresFor([]), []);
check('legacy has warranty_alerts', R.hasFeature(R.LEGACY_PACKS, 'warranty_alerts'));
check('general lacks warranty_alerts', !R.hasFeature([], 'warranty_alerts'));
check('hvac wording only with hvac', R.hasFeature(['equipment', 'hvac'], 'hvac_wording') && !R.hasFeature(['equipment'], 'hvac_wording'));
check('every manifest requirement is a known pack', Object.values(R.PACK_MANIFESTS).every((m) => m.requires.every((r) => R.PACK_MANIFESTS[r])));
for (const v of ['false', '0', 'off', 'FALSE']) check(`kill switch ${v}`, !R.packsEnabled({ DEEPWELL_PACKS_ENABLED: v }));
check('kill switch default on', R.packsEnabled({}));
eq('kill switch forces legacy over general', R.packsFromSettings({ packs: [] }, { DEEPWELL_PACKS_ENABLED: 'off' }), ['equipment', 'hvac']);

/* 2. DB-backed */
let PGlite; const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const k of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[k] = (await import(`@electric-sql/pglite/contrib/${k}`))[k];
} catch (e) {
  console.log(`SKIP  database-backed checks: ${e?.message}`);
  if (failures) process.exit(1);
  console.log(`${passes} checks passed (db skipped).`); process.exit(0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* tolerant, as verify-industry */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }
const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let rel; const p = new Promise((r) => { rel = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => rel); };
pgMod.Pool.prototype.connect = async function () {
  const rel = await lock(); await lite.exec('SET ROLE deepwell_rls');
  return { query: (s, p) => lite.query(s, p), release: () => { lite.exec('RESET ROLE').finally(rel); } };
};
pgMod.Pool.prototype.query = async function (s, p) { const rel = await lock(); try { return await lite.query(s, p); } finally { rel(); } };
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const mk = async (key, name, settings) => {
  const id = (await getTenantContext(key, name)).id;
  if (settings) await lite.query("UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb WHERE id = $1", [id, JSON.stringify(settings)]);
  return id;
};
const A = { tenantKey: 'org_packs_general', tenantName: 'Law Office A' };
const B = { tenantKey: 'org_packs_hvac', tenantName: 'Shop B' };
const C = { tenantKey: 'org_packs_legacy', tenantName: 'Legacy C' };
const idA = await mk(A.tenantKey, A.tenantName, { packs: [] });
await mk(B.tenantKey, B.tenantName, { packs: ['hvac'], industry: 'hvac' });
await mk(C.tenantKey, C.tenantName, null);

R.resetPacksCacheForTests();
eq('A (general) resolves []', await R.packsForTenant({ withTenant, ctxArg: A }), []);
eq('B resolves equipment+hvac', await R.packsForTenant({ withTenant, ctxArg: B }), ['equipment', 'hvac']);
eq('C (no key) resolves legacy', await R.packsForTenant({ withTenant, ctxArg: C }), ['equipment', 'hvac']);

// flag-leak: interleaved, repeated, cached and uncached, A never inherits B's features
const seen = [];
for (let i = 0; i < 3; i++) {
  seen.push(await R.tenantFeatures({ withTenant, ctxArg: B }));
  seen.push(await R.tenantFeatures({ withTenant, ctxArg: A }));
}
check('flag-leak: A never sees equipment features, B always does',
  seen.every((f, i) => (i % 2 === 0 ? f.includes('warranty_alerts') : f.length === 0)));
R.resetPacksCacheForTests();
const [a1, b1] = await Promise.all([R.packsForTenant({ withTenant, ctxArg: A }), R.packsForTenant({ withTenant, ctxArg: B })]);
check('flag-leak: concurrent resolve stays isolated', a1.length === 0 && b1.includes('hvac'));
// db-handle shape + tenant scoped by RLS
eq('db-handle shape, tenant A', await withTenant(A, (db) => R.packsForTenant(db)), []);
eq('db-handle shape, tenant B', await withTenant(B, (db) => R.packsForTenant(db)), ['equipment', 'hvac']);

// cache + invalidation
await lite.query("UPDATE tenants SET settings = settings || '{\"packs\":[\"equipment\"]}'::jsonb WHERE id = $1", [idA]);
eq('cached value served until invalidated', await R.packsForTenant({ withTenant, ctxArg: A }), []);
R.invalidatePacksCache(A.tenantKey);
eq('after invalidate, new value seen', await R.packsForTenant({ withTenant, ctxArg: A }), ['equipment']);

// db-handle cache path: interleaved, cached, invalidated by uuid and by object
R.resetPacksCacheForTests();
const dbSeen = [];
for (let i = 0; i < 3; i++) {
  dbSeen.push(await withTenant(B, (db) => R.packsForTenant(db)));
  dbSeen.push(await withTenant(A, (db) => R.packsForTenant(db)));
}
check('flag-leak (db-handle cache path): A never gets B packs', dbSeen.every((p, i) => (i % 2 === 0 ? p.includes('hvac') : !p.includes('hvac'))));
await lite.query("UPDATE tenants SET settings = settings || '{\"packs\":[]}'::jsonb WHERE id = $1", [idA]);
eq('db-handle cached until invalidated', await withTenant(A, (db) => R.packsForTenant(db)), ['equipment']);
R.invalidatePacksCache({ tenantId: idA, tenantKey: A.tenantKey });
eq('invalidate {tenantId,tenantKey} clears both shapes', [await withTenant(A, (db) => R.packsForTenant(db)), await R.packsForTenant({ withTenant, ctxArg: A })], [[], []]);
// transient failure is not cached
R.resetPacksCacheForTests();
let boom = true;
const flaky = { withTenant: async (c, fn) => { if (boom) throw new Error('x'); return withTenant(c, fn); }, ctxArg: A };
eq('failure -> legacy', await R.packsForTenant(flaky), ['equipment', 'hvac']);
boom = false;
eq('failure not cached: next call reads real value', await R.packsForTenant(flaky), []);

// kill switch beats DB + cache
process.env.DEEPWELL_PACKS_ENABLED = 'false';
eq('kill switch: general tenant forced legacy', await R.packsForTenant({ withTenant, ctxArg: A }), ['equipment', 'hvac']);
delete process.env.DEEPWELL_PACKS_ENABLED;

// failure degrades to legacy; existing industry resolver untouched
eq('query failure -> legacy', await R.packsForTenant({ withTenant: async () => { throw new Error('x'); }, ctxArg: { tenantKey: 'nope' } }), ['equipment', 'hvac']);
eq('no handle -> legacy', await R.packsForTenant({}), ['equipment', 'hvac']);
check('Round 4 packForTenant still hvac default for C', (await packForTenant({ withTenant, ctxArg: C })).id === 'hvac');
R.invalidatePacksCache(null);

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
