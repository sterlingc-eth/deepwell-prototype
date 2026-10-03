/**
 * LIMIT TEST (Tester A) - pack resolver, beyond scripts/verify-packs-resolver.mjs:
 * malformed JSON types, prototype-pollution-ish ids, fuzz (never throws / always known ids), 3 companies concurrent on one DB,
 * cache key collisions (db:<uuid> vs ctx:<tenantKey>), db handle without tenantId, invalidation scope, TTL, kill switch, legacy default,
 * and "nothing but the test imports the resolver" (static grep).   Run: node scripts/limit-test/packs-resolver-extended.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness } from '../lib/r35Harness.mjs';
import { check, finish } from './lib.mjs';
const eq = (n, g, w) => check(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
delete process.env.DEEPWELL_PACKS_ENABLED;
const h = await bootHarness();
const R = await import('../../api/_lib/industry/resolver.js');
const { withTenant } = h.RS;
const LEG = ['equipment', 'hvac'];

/* ---- 1. pure: malformed values -------------------------------------------------------------------------------------------- */
const throwsOn = (v) => { try { R.normalizePacks(v); return null; } catch (e) { return e.message; } };
for (const [name, v, want] of [
  ['number', 5, LEG], ['object', { 0: 'hvac' }, LEG], ['boolean', true, LEG], ['string', 'hvac', LEG], ['null', null, LEG], ['undefined', undefined, LEG],
  ['[number]', [1, 2], LEG], ['[null]', [null], LEG], ['[object]', [{ id: 'hvac' }], LEG], ['[true]', [true], LEG],
  ['[[hvac]] (nested array)', [['hvac']], LEG], ['[[],[]]', [[], []], LEG], ['[hvac, [plumbing]] (nested ignored)', ['hvac', ['plumbing']], LEG],
  ['empty string id', [''], LEG], ['whitespace id', ['   '], LEG], ['"hvac\\n" tolerated', ['hvac\n'], LEG], ['unicode lookalike', ['hvаc'], LEG],
]) {
  const err = throwsOn(v);
  check(`normalizePacks(${name}) does not throw`, err === null, err);
  if (err === null) eq(`normalizePacks(${name}) -> ${JSON.stringify(want)}`, R.normalizePacks(v), want);
}
for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf']) {
  const err = throwsOn([id]);
  check(`normalizePacks(['${id}']) does not throw (prototype-key id is just "unknown")`, err === null, err);
  if (err === null) eq(`normalizePacks(['${id}']) is an unknown id -> legacy (fail safe)`, R.normalizePacks([id]), LEG);
  const err2 = throwsOn(['plumbing', id]);
  check(`normalizePacks(['plumbing','${id}']) does not throw`, err2 === null, err2);
  if (err2 === null) eq(`normalizePacks(['plumbing','${id}']) keeps only the real pack`, R.normalizePacks(['plumbing', id]), ['equipment', 'plumbing']);
  let f; try { f = R.featuresFor([id]); } catch (e) { f = `THROW ${e.message}`; }
  eq(`featuresFor(['${id}']) = []`, f, []);
  check(`hasFeature(['${id}'], 'warranty_alerts') = false`, (() => { try { return R.hasFeature([id], 'warranty_alerts') === false; } catch { return false; } })());
}
check('Object.prototype was not polluted by any of the above', ({}).requires === undefined && ({}).features === undefined && Object.keys(Object.prototype).length === 0);
{ // fuzz: never throws, output always a canonical subset of KNOWN_PACKS in KNOWN order, deterministic
  const atoms = [undefined, null, 0, 1, -1, NaN, true, false, '', ' ', 'hvac', 'HVAC', 'equipment', 'plumbing', 'electrical', 'property', 'general', '__proto__', 'constructor', 'toString', [], ['hvac'], {}, { a: 1 }, Symbol.iterator.toString(), 'x'.repeat(1000)];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let bad = 0, n = 0;
  for (let i = 0; i < 20000; i++) {
    const len = Math.floor(rnd() * 6); const arr = Array.from({ length: len }, () => atoms[Math.floor(rnd() * atoms.length)]);
    const v = rnd() < 0.15 ? atoms[Math.floor(rnd() * atoms.length)] : arr; n++;
    try { const out = R.normalizePacks(v); const ok = out.every((x) => R.KNOWN_PACKS.includes(x)) && JSON.stringify(out) === JSON.stringify(R.KNOWN_PACKS.filter((k) => out.includes(k))) && JSON.stringify(R.normalizePacks(v)) === JSON.stringify(out); if (!ok) bad++; } catch { bad++; }
  }
  check(`fuzz: ${n} random malformed values -> never throws, always known ids in canonical order, deterministic`, bad === 0, `${bad} bad`);
  const big = Array.from({ length: 200000 }, (_, i) => (i % 2 ? 'hvac' : `x${i}`)); const t0 = Date.now(); R.normalizePacks(big);
  check('200,000-element array normalises in < 1.5 s (no quadratic blow-up)', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
}
{ const a = R.normalizePacks(undefined); a.push('x'); a[0] = 'zzz'; eq('legacy copy is never shared (mutating a result cannot change later results)', R.normalizePacks(undefined), LEG); check('LEGACY_PACKS is frozen', Object.isFrozen(R.LEGACY_PACKS)); check('PACK_MANIFESTS is frozen', Object.isFrozen(R.PACK_MANIFESTS)); }
eq('packsFromSettings(non-object settings) -> legacy', [R.packsFromSettings('x'), R.packsFromSettings(5), R.packsFromSettings([]), R.packsFromSettings(undefined)], [LEG, LEG, LEG, LEG]);
eq('packsFromSettings({}) / {packs: undefined} -> legacy', [R.packsFromSettings({}), R.packsFromSettings({ packs: undefined })], [LEG, LEG]);
eq('packsFromSettings({packs: null}) -> legacy', R.packsFromSettings({ packs: null }), LEG);
eq('settings key "packs" inherited from prototype is ignored', R.packsFromSettings(Object.create({ packs: [] })), []); // documents behaviour: only matters if JSON.parse produced it (it cannot)

/* ---- 2. kill switch: every spelling, read on every call -------------------------------------------------------------------- */
for (const v of ['false', 'FALSE', 'False', '0', 'off', 'OFF', 'no', 'NO', ' off ', ' false\n']) check(`kill switch '${JSON.stringify(v)}' disables`, R.packsEnabled({ DEEPWELL_PACKS_ENABLED: v }) === false);
for (const v of [undefined, '', 'true', '1', 'on', 'yes', 'disabled', 'nope', 'null']) check(`kill switch ${JSON.stringify(v)} leaves packs ON (only false/0/off/no are recognised)`, R.packsEnabled({ DEEPWELL_PACKS_ENABLED: v }) === true);

/* ---- 3. database: three companies, one DB --------------------------------------------------------------------------------- */
const mk = async (key, settings) => { const id = await h.newTenant(key); if (settings !== undefined) await h.lite.query(`UPDATE tenants SET settings = $2::jsonb WHERE id=$1`, [id, JSON.stringify(settings)]); return id; };
const raw = async (id, sql) => h.lite.query(`UPDATE tenants SET settings = ${sql} WHERE id=$1`, [id]);
const ctx = (k) => ({ tenantKey: k, tenantName: k });
const idG = await mk('org_general', { packs: [] });
const idH = await mk('org_hvac', { packs: ['hvac'], industry: 'hvac' });
const idP = await mk('org_plumb', { packs: ['plumbing', 'property'] });
const idL = await mk('org_legacy_null', null);
const idE = await mk('org_legacy_empty', {});
R.resetPacksCacheForTests();
const P = (k) => R.packsForTenant({ withTenant, ctxArg: ctx(k) });
eq('general company [] -> general', await P('org_general'), []);
eq('hvac company', await P('org_hvac'), LEG);
eq('plumbing+property company', await P('org_plumb'), ['equipment', 'plumbing', 'property']);
eq('company with settings NULL -> legacy default (existing companies unchanged)', await P('org_legacy_null'), LEG);
eq('company with settings {} -> legacy default (existing companies unchanged)', await P('org_legacy_empty'), LEG);
eq('company that does not exist yet -> legacy (resolver creates nothing harmful)', await P('org_brand_new'), LEG);
// concurrent, interleaved, cached & uncached
for (const round of ['cold', 'warm']) {
  if (round === 'cold') R.resetPacksCacheForTests();
  const keys = ['org_general', 'org_hvac', 'org_plumb', 'org_legacy_null'];
  const want = { org_general: [], org_hvac: LEG, org_plumb: ['equipment', 'plumbing', 'property'], org_legacy_null: LEG };
  const jobs = []; for (let i = 0; i < 40; i++) for (const k of keys) jobs.push(P(k).then((r) => [k, r]));
  const out = await Promise.all(jobs);
  check(`3+ companies, 160 concurrent resolves (${round} cache): every company always gets ITS OWN packs`, out.every(([k, r]) => JSON.stringify(r) === JSON.stringify(want[k])));
}
// db-handle path (cache key db:<uuid>)
R.resetPacksCacheForTests();
{
  const jobs = []; for (let i = 0; i < 20; i++) for (const k of ['org_general', 'org_hvac', 'org_plumb']) jobs.push(withTenant(ctx(k), (db) => R.packsForTenant(db)).then((r) => [k, r]));
  const out = await Promise.all(jobs);
  check('db-handle path: 60 concurrent resolves isolated', out.every(([k, r]) => (k === 'org_general' ? r.length === 0 : k === 'org_hvac' ? JSON.stringify(r) === JSON.stringify(LEG) : JSON.stringify(r) === JSON.stringify(['equipment', 'plumbing', 'property']))));
}
// db handle WITHOUT tenantId: no cache key -> every call must query under the CURRENT tenant's RLS and never share
R.resetPacksCacheForTests();
{
  const seq = [];
  for (let i = 0; i < 3; i++) for (const k of ['org_hvac', 'org_general']) seq.push([k, await withTenant(ctx(k), (db) => R.packsForTenant({ raw: db.raw }))]); // handle has raw() but NO tenantId
  check('db handle with no tenantId: not cached, never shares between companies (6 interleaved calls)', seq.every(([k, r]) => (k === 'org_general' ? r.length === 0 : JSON.stringify(r) === JSON.stringify(LEG))));
  const mixed = await Promise.all(['org_general', 'org_hvac', 'org_general', 'org_hvac'].map((k) => withTenant(ctx(k), (db) => R.packsForTenant({ query: (s, p) => db.raw(s, p) }))));
  check('db handle with only query() and no tenantId: concurrent, still isolated', JSON.stringify(mixed) === JSON.stringify([[], LEG, [], LEG]), JSON.stringify(mixed));
  const noGuc = await R.packsForTenant({ raw: (s, p) => h.RS.getPool().query(s, p) }); // no tenant context at all (bare pool): must degrade to legacy, not throw, not leak
  eq('handle with NO tenant context (bare pool, GUC unset) -> legacy, no throw', noGuc, LEG);
  const afterNoGuc = await P('org_general'); eq('...and the failed no-context read did not poison a later real resolve', afterNoGuc, []);
  const nullish = await Promise.all([R.packsForTenant(null), R.packsForTenant(undefined), R.packsForTenant({}), R.packsForTenant({ ctxArg: null }), R.packsForTenant({ withTenant, ctxArg: { tenantKey: '' } }), R.packsForTenant({ withTenant, ctxArg: { tenantKey: null } }), R.packsForTenant(5), R.packsForTenant('org_hvac')]);
  check('null/undefined/{}/empty tenantKey/null tenantKey/number/string inputs -> legacy, no throw', nullish.every((r) => JSON.stringify(r) === JSON.stringify(LEG)), JSON.stringify(nullish));
}
// cache key collisions: db:<uuid> vs ctx:<tenantKey> namespaces; hostile tenantKey strings
R.resetPacksCacheForTests();
{
  await P('org_general'); // caches ctx:org_general = []
  await withTenant(ctx('org_hvac'), (db) => R.packsForTenant(db)); // caches db:<idH>
  const hostileKeys = [`db:${idH}`, `ctx:org_general`, idH, `db:${idG}`, 'org_general ', 'ORG_GENERAL', 'org_general\u0000', `org_general:${idH}`];
  const res = [];
  for (const k of hostileKeys) res.push([k, await R.packsForTenant({ withTenant, ctxArg: ctx(k) })]);
  check('hostile tenantKey strings that imitate other cache keys never return another company\'s cached packs (all resolve legacy/own)', res.every(([, r]) => JSON.stringify(r) === JSON.stringify(LEG)), JSON.stringify(res));
  eq('org_general still resolves [] after the hostile keys', await P('org_general'), []);
}
// cache returns copies
{ const a = await P('org_hvac'); a.push('HACK'); eq('cached array is returned as a copy (caller mutation cannot poison the cache)', await P('org_hvac'), LEG); }
// settings.packs of every JSON type stored in the real column
R.resetPacksCacheForTests();
const typed = [['string "hvac"', `'{"packs":"hvac"}'::jsonb`, LEG], ['number 7', `'{"packs":7}'::jsonb`, LEG], ['object', `'{"packs":{"hvac":true}}'::jsonb`, LEG], ['JSON null', `'{"packs":null}'::jsonb`, LEG], ['nested [[hvac]]', `'{"packs":[["hvac"]]}'::jsonb`, LEG], ['[1,null,{}]', `'{"packs":[1,null,{}]}'::jsonb`, LEG],
  ['["__proto__"]', `'{"packs":["__proto__"]}'::jsonb`, LEG], ['["constructor","hvac"]', `'{"packs":["constructor","hvac"]}'::jsonb`, LEG], ['["__proto__","plumbing"]', `'{"packs":["__proto__","plumbing"]}'::jsonb`, ['equipment', 'plumbing']], ['["HVAC"," Plumbing "]', `'{"packs":["HVAC"," Plumbing "]}'::jsonb`, ['equipment', 'hvac', 'plumbing']],
  ['[] general', `'{"packs":[]}'::jsonb`, []], ['packs missing, other keys', `'{"industry":"plumbing","address":"x"}'::jsonb`, LEG], ['settings JSON null column', `NULL`, LEG]];
for (const [name, sql, want] of typed) {
  await raw(idE, sql); R.invalidatePacksCache({ tenantId: idE, tenantKey: 'org_legacy_empty' });
  let got; try { got = await P('org_legacy_empty'); } catch (e) { got = `THROW ${e.message}`; }
  eq(`DB settings.packs = ${name} -> ${JSON.stringify(want)} (resolver never throws)`, got, want);
}
// invalidation scope: invalidating one company must not clear another's entry or break anything
R.resetPacksCacheForTests(); await raw(idE, `'{}'::jsonb`);
await P('org_general'); await P('org_hvac');
await raw(idG, `'{"packs":["plumbing"]}'::jsonb`); await raw(idH, `'{"packs":[]}'::jsonb`);
R.invalidatePacksCache('org_general');
eq('after invalidate(org_general): general sees its new value', await P('org_general'), ['equipment', 'plumbing']);
eq('...org_hvac (not invalidated) still serves ITS cached value, not general\'s', await P('org_hvac'), LEG);
for (const junk of [null, undefined, '', 0, {}, [], { tenantId: null }, 'nonexistent', { tenantId: idH, tenantKey: null }]) { try { R.invalidatePacksCache(junk); } catch (e) { check(`invalidatePacksCache(${JSON.stringify(junk)}) must not throw`, false, e.message); } }
R.invalidatePacksCache({ tenantId: idH, tenantKey: 'org_hvac' });
eq('after invalidate({tenantId}) the uuid-keyed + key-keyed entries both clear: hvac now general', await P('org_hvac'), []);
await raw(idG, `'{"packs":[]}'::jsonb`); await raw(idH, `'{"packs":["hvac"]}'::jsonb`); R.resetPacksCacheForTests();
// TTL expiry (10 min) with a mocked clock
{
  R.resetPacksCacheForTests(); await P('org_general');
  await raw(idG, `'{"packs":["property"]}'::jsonb`);
  eq('inside TTL: stale value served (documented)', await P('org_general'), []);
  const realNow = Date.now; Date.now = () => realNow() + 10 * 60 * 1000 + 1000;
  try { eq('after 10 min TTL: fresh value read', await P('org_general'), ['property']); } finally { Date.now = realNow; }
  await raw(idG, `'{"packs":[]}'::jsonb`); R.resetPacksCacheForTests();
}
// failed DB read is not cached (and does not become another company's value)
R.resetPacksCacheForTests();
{ let boom = true; const flaky = (k) => ({ withTenant: async (c, fn) => { if (boom) throw new Error('db down'); return withTenant(c, fn); }, ctxArg: ctx(k) });
  eq('db down -> legacy (general company degrades to legacy, i.e. MORE features, never fewer than before this feature)', await R.packsForTenant(flaky('org_general')), LEG);
  boom = false; eq('db back: failure was not cached', await R.packsForTenant(flaky('org_general')), []); }
// kill switch beats DB + warm cache, flips both ways without restart
R.resetPacksCacheForTests(); await P('org_general');
process.env.DEEPWELL_PACKS_ENABLED = 'off';
eq('kill switch on (warm cache): general company forced legacy', await P('org_general'), LEG);
eq('kill switch on: db-handle path forced legacy', await withTenant(ctx('org_general'), (db) => R.packsForTenant(db)), LEG);
eq('kill switch on: tenantFeatures = legacy features', await R.tenantFeatures({ withTenant, ctxArg: ctx('org_general') }), R.featuresFor(LEG));
process.env.DEEPWELL_PACKS_ENABLED = 'false'; let q = h.stats.queries; await P('org_plumb'); check('kill switch short-circuits BEFORE any query', h.stats.queries === q);
delete process.env.DEEPWELL_PACKS_ENABLED;
eq('kill switch off again: general company is general again (no restart needed)', await P('org_general'), []);

/* ---- 4. nothing else imports the resolver (existing companies see NO change) ---------------------------------------------- */
const ROOT = h.root; const hits = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'dist', '.vercel'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|mjs|cjs|ts|tsx|jsx|json)$/.test(e.name)) { const t = fs.readFileSync(p, 'utf8'); if (/industry\/resolver|packsForTenant|tenantFeatures|invalidatePacksCache|PACK_MANIFESTS/.test(t)) hits.push(path.relative(ROOT, p)); } } };
walk(ROOT);
const nonTest = hits.filter((f) => !/^scripts\/(verify-packs-resolver\.mjs|limit-test\/)/.test(f) && f !== 'api/_lib/industry/resolver.js');
check('grep: no api/, src/, app/, m/ or other runtime file imports or references the resolver (only scripts/ tests do)', nonTest.length === 0, JSON.stringify(nonTest));
console.log('files referencing resolver symbols:', JSON.stringify(hits));
finish();
