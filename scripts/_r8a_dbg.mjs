import fs from 'node:fs';
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const key = process.argv[2]; const qs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const data = JSON.parse(fs.readFileSync(`/home/claude/work/factory/tenants/${key}.json`, 'utf8'));
const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:ind-${key}`, tenantName: key });
await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", [key === 'medical' ? 'medical-admin' : key, loaded.tenantId]);
const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
for (const q of qs) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: '2026-10-07', original: q });
  let ans = null;
  if (intent && !intent.plain) ans = await withTenant(ctxArg, (db) => runDql(db, intent, { today: '2026-10-07' }));
  realLog(q, '=>', intent ? (intent.plain ? 'PLAIN' : JSON.stringify(intent.plan).slice(0, 150)) : 'NULL', '|', ans?.text?.slice(0, 200));
}
process.exit(0);
