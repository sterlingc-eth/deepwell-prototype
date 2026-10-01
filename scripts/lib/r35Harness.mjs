/**
 * R35 shared harness: a real Postgres (PGlite, in-process, $0) with every M3-config migration applied, the app's
 * RLS role, and pg.Pool patched to run on it - the same pattern verify-r30-audit-fixes / verify-r34-breakit-uploads use,
 * plus connection accounting (how many checkouts, the peak held at once, and whether any was never released).
 * No network, no real R2 / Neon / model / Stripe.
 *
 *   const h = await bootHarness();            // call once, before importing any api/_lib module that reads env
 *   const id = await h.newTenant('org_x', 'shop');
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function bootHarness({ migrations = true, loadFrom = null, dataDir = null } = {}) {
  for (const k of ['STRIPE_SECRET_KEY', 'CLERK_SECRET_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY']) delete process.env[k];
  process.env.NEON_CONNECTION_STRING = 'postgres://fixture_user:fixture_pw@db.fixture.invalid:5432/fixture?sslmode=require&channel_binding=require';
  Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAFIXTURE', R2_SECRET_ACCESS_KEY: 'secretfixture', R2_BUCKET_NAME: 'fixture-bucket' });

  const { PGlite } = await import('@electric-sql/pglite');
  const contrib = {};
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  const loaded = loadFrom && fs.existsSync(loadFrom);
  // R36: `dataDir` keeps the database on disk (PGlite's Node filesystem), so a 50,000-document tenant is seeded once and
  // re-opened by later runs. The old `loadFrom` snapshot had to hold the whole dump in memory several times over and was
  // OOM-killed on a small machine. An existing directory is reused as it is (no migrations re-applied).
  const persisted = Boolean(dataDir) && fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (loaded || persisted) migrations = false;
  const lite = dataDir
    ? new PGlite(dataDir, { extensions: contrib })
    : new PGlite({ extensions: contrib, ...(loaded ? { loadDataDir: new Blob([fs.readFileSync(loadFrom)]) } : {}) });
  const cfgDir = path.join(ROOT, 'M3-config');
  const applied = [];
  const skipped = [];
  if (migrations) {
    for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
      try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); applied.push(f); } catch (e) { skipped.push(`${f}: ${String(e.message).slice(0, 80)}`); }
    }
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* optional */ }
  }

  const pgMod = (await import('pg')).default;
  const stats = { connects: 0, out: 0, peakOut: 0, queries: 0, queryLog: null };
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  const countQuery = (sql, params) => { stats.queries++; if (stats.capture) stats.capture.push({ sql: String(sql), params }); if (stats.queryLog) stats.queryLog.push(String(sql).replace(/\s+/g, ' ').slice(0, 120)); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    stats.connects++; stats.out++; stats.peakOut = Math.max(stats.peakOut, stats.out);
    await lite.exec('SET ROLE deepwell_rls');
    let released = false;
    return {
      query: (sql, params) => { countQuery(sql, params); return lite.query(sql, params); },
      release: () => { if (released) return; released = true; stats.out--; lite.exec('RESET ROLE').finally(release); },
    };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { countQuery(sql, params); return await lite.query(sql, params); } finally { release(); }
  };

  const RS = await import(path.join(ROOT, 'api/_lib/recordsStore.js'));
  const PLAN = await import(path.join(ROOT, 'api/_lib/plan.js'));
  const resetCaches = () => { RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.(); };
  const newTenant = async (key, plan = 'shop', status = 'active', limits = null) => {
    const ctx = await RS.getTenantContext(key, key);
    await lite.query(`UPDATE tenants SET billing_status=$2, plan=$3 ${limits ? ', limits = $4::jsonb' : ''} WHERE id = $1`, limits ? [ctx.id, status, plan, JSON.stringify(limits)] : [ctx.id, status, plan]);
    resetCaches();
    return ctx.id;
  };
  const rnd = () => crypto.randomBytes(32).toString('hex');
  return { lite, RS, PLAN, stats, newTenant, resetCaches, rnd, applied, skipped, root: ROOT };
}

/** Run `fn` and return its result together with wall-clock ms and the number of SQL statements it issued. */
export async function measure(h, label, fn) {
  const q0 = h.stats.queries;
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms: Math.round(ms * 10) / 10, queries: h.stats.queries - q0, value };
}
