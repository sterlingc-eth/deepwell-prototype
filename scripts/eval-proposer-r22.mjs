/**
 * scripts/eval-proposer.mjs - offline evaluation of the local plan proposer on factory DEV splits (never test) - R22, no model, no HTTP:
 * question -> proposePlan -> validateTranslatedPlan -> headsAgree -> DQL executor over the company's stored records -> the factory's own checker.
 *   node scripts/eval-proposer.mjs --tenants church,gym,storage,photostudio [--n 300] [--model path.json] [--out file.json]
 * Prints, per company and in total: proposed (accepted by every gate), right / wrong / other of the accepted, and the released count.
 */
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
import { loadTenant, tenantListAll as tenantList, F, ROOT, TODAY } from './lib/proposer-env.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
if (A.model) process.env.DONOVAN_PROPOSER_MODEL = A.model;
const N = Number(A.n ?? 300); const tenants = A.tenants ? A.tenants.split(',') : tenantList();
const { proposeAndValidate } = await import(`${ROOT}/api/_lib/dql/proposer/index.js`);
const { answerFromSnapshot } = await import(`${ROOT}/api/_lib/dql/index.js`);
const { checkRecord4, buildLexicon } = await import(`${F}/questions/check4.mjs`);
const { checkRecord5 } = await import(`${F}/questions/check5.mjs`);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const dirs = [[`${F}/questions/out`, 'dev'], [`${F}/questions/out2`, 'dev'], [`${F}/questions/out3/dev3`, null], [`${F}/questions/out4/dev4`, null], [`${F}/questions/out5/dev5`, null], [`${F}/questions/out6/dev6`, null]];
function devRecs(t) {
  const out = [];
  for (const [dir, need] of dirs) for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`${t}-`) && x.endsWith('.jsonl.gz'))) {
    for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString().split('\n')) { if (!l) continue; const r = JSON.parse(l); if (need && r.split !== need) continue; if (A.bank && String(r.bank) !== A.bank) continue; if (r.split === 'test' || r.split === 'train') continue; out.push(r); }
  }
  return out.sort((a, b) => hash(a.id) - hash(b.id)).slice(0, N);
}
const ths = (A.ths ?? '').split(',').filter(Boolean);
const totBy = Object.fromEntries((ths.length ? ths : ['default']).map((t) => [t, { n: 0, proposed: 0, right: 0, wrong: 0, other: 0, viaCore: 0 }])); const rows = []; const rej = {};
for (const t of tenants) {
  const T = await loadTenant(t);
  const lex = buildLexicon(T.data); const recs = devRecs(t);
  for (const th of (ths.length ? ths : ['default'])) {
    if (th !== 'default') process.env.DONOVAN_PROPOSER_TH = th;
    const c = { n: 0, proposed: 0, right: 0, wrong: 0, other: 0, viaCore: 0 };
    for (const r of recs) {
      c.n++;
      const res = r.prior ? { ok: false, reason: 'followup-turn' } : proposeAndValidate(r.q, { tv: T.tv, pack: T.pack, today: TODAY, snap: T.snap });
      if (!res.ok) { const k = String(res.reason).replace(/[:0-9.]+$/, '').slice(0, 40); rej[k] = (rej[k] ?? 0) + 1; continue; }
      const d = answerFromSnapshot(T.snap, res.plan, TODAY);
      if (!d) { rej['executor-abstained'] = (rej['executor-abstained'] ?? 0) + 1; continue; }
      c.proposed++;
      const v = (r.bank >= 5 ? checkRecord5 : checkRecord4)({ ...r, prior: null }, { text: d.text, recs: (d.records || []).length, kind: d.kind, model: false }, lex);
      if (res.core) c.viaCore++; const k = v.v === 'right' ? 'right' : v.v === 'wrong' ? 'wrong' : 'other'; c[k]++;
      rows.push({ core: !!res.core, th, t, id: r.id, q: r.q, fam: r.family, label: res.label, prob: +res.prob.toFixed(3), v: v.v, why: v.why ?? null, text: d.text?.slice(0, 160) });
    }
    console.log(t.padEnd(12), th, JSON.stringify(c));
    for (const k of Object.keys(c)) totBy[th][k] += c[k];
  }
  try { await T.lite.close(); } catch { /* ignore */ }
}
for (const [th, tot] of Object.entries(totBy)) console.log('TOTAL th', th, JSON.stringify(tot), 'precision', (tot.right / Math.max(tot.proposed, 1)).toFixed(4), 'coverage', (tot.proposed / tot.n).toFixed(3));
console.log('released because', JSON.stringify(Object.entries(rej).sort((a, b) => b[1] - a[1]).slice(0, 14)));
if (A.out) fs.writeFileSync(A.out, JSON.stringify(rows, null, 1));
process.exit(0);
