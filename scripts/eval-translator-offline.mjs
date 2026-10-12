/**
 * eval:translator - the offline evaluation of the plan translator, without a model.
 *
 * scripts/translator-fixtures/factory300.json holds 300 questions that no lane answered (released to the full model path), taken from the factory's
 * DEV splits (out, out2, out3, out4; never test), each with the plan a careful small model is expected to write from the prompt alone (RECORDED, written
 * by hand from the prompt text and the company's own vocabulary). Each plan goes through the validator and the DQL executor over the company's stored
 * records, and the answer is scored with the factory's own checker against the oracle label: right / wrong / rejected (went on to the full model path)
 * / other (declined, unclear).
 *
 *   FACTORY_DIR=/home/claude/work/factory node scripts/eval-translator-offline.mjs [out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = process.env.FACTORY_DIR || '/home/claude/work/factory';
const TODAY = '2026-10-07';
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { loadSnapshot } = await import('../api/_lib/dql/load.js');
const { validateTranslatedPlan } = await import('../api/_lib/dql/translator/validate.js');
const { answerFromSnapshot } = await import('../api/_lib/dql/index.js');
const { checkRecord, buildLexicon } = await import(path.join(F, 'questions/check.mjs'));

const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/translator-fixtures/factory300.json'), 'utf8'));
const byT = new Map(); for (const it of items) { if (!byT.has(it.tenant)) byT.set(it.tenant, []); byT.get(it.tenant).push(it); }
const tot = { n: 0 }; const rows = [];
for (const [key, its] of byT) {
  const p = ['tenants', 'tenants4'].map((d) => path.join(F, d, `${key}.json`)).find((x) => fs.existsSync(x));
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:${key}`, tenantName: key });
  const ind = p.includes('tenants4') ? 'other' : (data.industry ?? (key === 'medical' ? 'medical-admin' : key));
  await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings,'{}'::jsonb),'{industry}',to_jsonb($1::text)) WHERE id = $2", [ind, loaded.tenantId]);
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctxArg.tenantKey, pack));
  const snap = await withTenant(ctxArg, (db) => loadSnapshot(db, { today: TODAY }));
  const lex = buildLexicon(data);
  for (const it of its) {
    let v; let why = null; let text = null;
    const r = validateTranslatedPlan(it.plan, it.q, { tv, pack, today: TODAY, snap });
    if (!r.ok) { v = 'rejected'; why = r.reason; }
    else {
      const d = answerFromSnapshot(snap, r.plan, TODAY);
      if (!d) { v = 'rejected'; why = 'executor-abstained'; }
      else { text = d.text; const c = checkRecord({ ...it, prior: null }, { text: d.text, recs: (d.records || []).length, kind: d.kind, model: false }, lex); v = c.v; why = c.why ?? null; }
    }
    tot.n++; tot[v] = (tot[v] ?? 0) + 1; rows.push({ id: it.id, tenant: key, bank: it.bank, q: it.q, v, why, text: text?.slice(0, 200) });
  }
}
const bank = {}; for (const r of rows) { const b = (bank[r.bank] ??= { n: 0 }); b.n++; b[r.v] = (b[r.v] ?? 0) + 1; }
realLog('banks', JSON.stringify(bank)); realLog('TOTAL', JSON.stringify(tot));
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(rows, null, 1));
process.exit(0);
