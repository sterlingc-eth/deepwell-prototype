// Measures the import autopilot on a synthetic import (model stubbed): auto-filed, decisions, papers left one-by-one, clicks before/after,
// wrong links and wrong values (counted against each paper's truth record). `N=5000 node scripts/proof-import-autopilot.mjs`
import { startPglite } from './lib/pglite-tenant.mjs';
import { buildSynthetic } from './lib/import-synth.mjs';
import { loadSynthetic } from './lib/import-load.mjs';
import { drive, CLICKS } from './lib/import-run.mjs';
import { writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const N = Number(process.env.N || 5000);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const h = await startPglite(root);
const ctx = { tenantKey: 'org_synth', tenantName: 'Mesa Mechanical Services' };
const ten = (await h.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const batch = h.nid(); const scope = { batchId: batch };
const synth = buildSynthetic(N);
await loadSynthetic(h, ten, synth, batch);
const IA = await import(root + '/api/_lib/importAutopilot.js');
const q = async (sql, p = []) => (await h.lite.query(sql, p)).rows;
const snap = async () => {
  const links = await q(`SELECT l.document_id d, e.data->>'customer_name' n FROM document_entity_links l JOIN entities e ON e.id = l.entity_id`);
  const sd = await q(`SELECT DISTINCT ON (document_id) document_id d, COALESCE(NULLIF(btrim(corrected_value),''), value) v FROM extractions WHERE field_key='service_date' ORDER BY document_id, created_at DESC, id DESC`);
  const docs = await q(`SELECT id d, document_type t, stage s, verified_by vb FROM documents`);
  return { links: new Map(links.map((r) => [r.d, r.n])), sd: new Map(sd.map((r) => [r.d, r.v])), docs: new Map(docs.map((r) => [r.d, r])) };
};
const before = await snap();
const t0 = Date.now();
const plan0 = await IA.importPlan(ctx, { ...scope, fresh: true });
const planMs = Date.now() - t0;
const run = await drive(IA, ctx, scope, { chooser: (d) => d.kind !== 'choose-type' ? undefined : (d.params.options.includes('insurance-certificate') ? 'insurance-certificate' : d.params.options[0]) });
const final = await IA.importStatus(ctx, scope);
const plan1 = await IA.importPlan(ctx, { ...scope, fresh: true });
const after = await snap();
let wrongLinks = 0, newLinks = 0, wrongValues = 0, valuesWritten = 0, wrongTypes = 0; const bad = [];
for (const [id, t] of synth.truth) {
  const was = before.links.get(id), now = after.links.get(id);
  if (now && now !== was) { newLinks++; if (norm(now) !== norm(t.customer)) { wrongLinks++; bad.push({ id, kind: t.kind, now, want: t.customer }); } }
  if (was && now !== was) { wrongLinks++; bad.push({ id, kind: t.kind, lost: was }); }
  const sb = before.sd.get(id), sa = after.sd.get(id);
  if (sa !== sb) { valuesWritten++; if (sa !== t.serviceDate) { wrongValues++; bad.push({ id, kind: t.kind, date: sa, want: t.serviceDate }); } }
  if (sb && sa !== sb) { wrongValues++; bad.push({ id, kind: t.kind, overwritten: sb }); }
  const d0 = before.docs.get(id), d1 = after.docs.get(id);
  if (d0.t !== d1.t && t.type && d1.t !== t.type) { wrongTypes++; bad.push({ id, kind: t.kind, type: d1.t, want: t.type }); }
}
// clicks: before = today's Inbox (each paper opened and acted on), after = 2 per decision + each paper left one by one
const kinds = {}; for (const d of synth.docs) if (d.stage !== 'verified') kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
const per = { clean: CLICKS.openActCheck, company: CLICKS.openActCheck, newcust: CLICKS.newCustomerForm, suggest: CLICKS.linkInDetail, suggest2: CLICKS.linkInDetail, datefix: CLICKS.typeDate, copyfiled: CLICKS.setAside, copyopen: CLICKS.setAside, revision: CLICKS.setAside, typeq: CLICKS.chooseType };
let clicksBefore = 0; for (const [k, n] of Object.entries(kinds)) clicksBefore += n * (per[k] ?? CLICKS.lookAt);
const left = plan1.lookAt.count + (final.counts.failed ?? 0);
const clicksAfter = run.decisionCount * CLICKS.decision + left * CLICKS.lookAt;
const out = { N, papers: synth.docs.length, autoFiledFirstPass: run.autoFiled, filedTotal: final.counts.filed, decisionsFirstPlan: plan0.decisions.length, decisionsTotal: run.decisionCount, decisionsStillOpen: plan1.decisions.length, papersLeftOneByOne: left, lookAtReasons: plan1.lookAt.reasons, newLinks, wrongLinks, valuesWritten, wrongValues, wrongTypes, clicksBefore, clicksAfter, planMs, rounds: run.answered.length, bad: bad.slice(0, 10) };
console.log(JSON.stringify(out, null, 1));
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
process.exit(wrongLinks || wrongValues || wrongTypes ? 1 : 0);
