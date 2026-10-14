/** scripts/lib/proposer-env.mjs - load one factory company into an in-memory PGlite and return {tv, pack, snap, data}; shared by the proposer's generator, trainer and evaluation. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const F = process.env.FACTORY_DIR || '/home/claude/work/factory';
export const TODAY = '2026-10-07';
export const NEW4 = ['petgroom', 'feedstore', 'eventvenue', 'msp', 'tutoring', 'trucking', 'salon', 'restaurant', 'church', 'gym', 'storage', 'photostudio'];
export const NEW5 = ['vetclinic','bookkeeping','insagency','realtybroker','brewery','filmprod','medbilling','warehouse','mfgqa','hotel','roofing','poolservice','pestcontrol','daycare','policerecords','grantnp','weddingplan','foodtruck','dentallab','marina'];
export const tenantList = () => [...new Set(fs.readdirSync(`${F}/tenants`).filter((x) => /^[a-z]+\.json$/.test(x)).map((x) => x.slice(0, -5)).concat(NEW4))];
export const tenantListAll = () => [...tenantList(), ...NEW5];
let off = null; let mods = null;
export async function init() {
  if (mods) return mods;
  delete process.env.ANTHROPIC_API_KEY;
  const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = (...a) => { if (process.env.PROPOSER_VERBOSE) process.stderr.write(`${a.join(' ')}\n`); };
  off = await import(`${ROOT}/scripts/offline-exam.mjs`);
  await off.installPgHarness(); await off.installModelBlock();
  mods = {
    withTenant: (await import(`${ROOT}/api/_lib/recordsStore.js`)).withTenant,
    getTenantVocab: (await import(`${ROOT}/api/_lib/vocab/tenantVocab.js`)).getTenantVocab,
    packForTenant: (await import(`${ROOT}/api/_lib/industry/index.js`)).packForTenant,
    loadSnapshot: (await import(`${ROOT}/api/_lib/dql/load.js`)).loadSnapshot,
  };
  return mods;
}
export async function loadTenant(key, { snapshot = true } = {}) {
  const M = await init();
  const p = ['tenants', 'tenants4', 'tenants5'].map((d) => path.join(F, d, `${key}.json`)).find((x) => fs.existsSync(x));
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:${key}`, tenantName: key });
  const ind = (p.includes('tenants4') || p.includes('tenants5')) ? 'other' : (data.industry ?? (key === 'medical' ? 'medical-admin' : key));
  await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings,'{}'::jsonb),'{industry}',to_jsonb($1::text)) WHERE id = $2", [ind, loaded.tenantId]);
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await M.packForTenant({ withTenant: M.withTenant, ctxArg });
  const tv = await M.withTenant(ctxArg, (db) => M.getTenantVocab(db, ctxArg.tenantKey, pack));
  const snap = snapshot ? await M.withTenant(ctxArg, (db) => M.loadSnapshot(db, { today: TODAY })) : null;
  return { key, data, tv, pack, snap, lite };
}
