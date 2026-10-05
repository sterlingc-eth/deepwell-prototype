/**
 * Mixed-company harness (Build 2, stage 2A). Four companies on ONE real (PGlite)
 * database, one per industry, so a check can prove that a company in one industry
 * never sees another's wording, packs, or settings, and that company isolation
 * holds on every new path. Later stages (2B-2E) EXTEND it: add fixtures with
 * `addFixture(company, fn)`, or read `H.companies` and run their own queries.
 *
 *   const H = await startMixedHarness();           // companies created, industry set via setTenantIndustry
 *   H.companies.plumbing.ctx                         // { tenantKey, tenantName } for withTenant()
 *   await H.as('property', (db) => db.raw(...))      // run inside that company only (row-level security on)
 *   await H.stop();
 *
 * No network, no model calls, no real email: PGlite only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIXED_INDUSTRIES = Object.freeze(['hvac', 'electrical', 'plumbing', 'property']);

export async function startMixedHarness({ industries = MIXED_INDUSTRIES } = {}) {
  process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
  delete process.env.DEEPWELL_PACKS_ENABLED;
  const { PGlite } = await import('@electric-sql/pglite');
  const contrib = {};
  for (const k of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[k] = (await import(`@electric-sql/pglite/contrib/${k}`))[k];
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* tolerant, same as verify-industry */ }
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

  const { withTenant, getTenantContext } = await import('../../api/_lib/recordsStore.js');
  const R = await import('../../api/_lib/industry/resolver.js');
  const I = await import('../../api/_lib/industry/index.js');

  const companies = {};
  for (const industry of industries) {
    const ctx = { tenantKey: `org_mixed_${industry}`, tenantName: `Mixed ${industry} Co` };
    const id = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
    await withTenant(ctx, (db) => R.setTenantIndustry(db, industry, { tenantKey: ctx.tenantKey }));
    companies[industry] = { industry, ctx, id };
  }
  R.resetPacksCacheForTests(); I.resetPackForTenantCacheForTests();

  const as = (industry, fn) => withTenant(companies[industry].ctx, fn);
  /** Run `fn(db, company)` inside every company in turn; returns {industry: result}. */
  const eachCompany = async (fn) => {
    const out = {};
    for (const industry of industries) out[industry] = await as(industry, (db) => fn(db, companies[industry]));
    return out;
  };
  /** Later stages register fixture loaders here; they run in order inside the named company only. */
  const fixtures = [];
  const addFixture = async (industry, fn) => { fixtures.push({ industry, fn }); await as(industry, (db) => fn(db, companies[industry])); };
  const stop = async () => { try { await lite.close(); } catch { /* */ } };
  return { lite, withTenant, R, I, companies, industries, as, eachCompany, addFixture, fixtures, stop };
}
