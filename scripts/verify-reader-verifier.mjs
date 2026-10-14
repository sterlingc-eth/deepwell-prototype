/**
 * verify:reader-verifier - the VERIFIER on top of the learned reader (api/_lib/dql/reader-ml/verifier.mjs + data/verifier.json), behind DONOVAN_READER_VERIFIER (default OFF).
 *
 *   - the switch and the files: off by default, small, dependency-free, thresholds in order
 *   - the model's top-5 view (predictTop5) is the same forward pass as predict
 *   - the verifier itself: JS and Python (numpy beam + LightGBM) take the same decision on 500 recorded questions; a high-confidence stub is rejected when its other signals disagree
 *   - OFF changes nothing: the reader's results are byte-identical to the recorded ones from before the verifier existed
 *   - ON: the reader answers only when the verifier accepts; every other test still applies; a missing config, the GPU backend or a stricter threshold release
 *
 *   node scripts/verify-reader-verifier.mjs            (--gen-off writes the OFF baseline fixture; run it only on a tree WITHOUT the verifier change)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_PLAN_TRANSLATOR; delete process.env.DONOVAN_DQL; process.env.DONOVAN_LEARNED_READER = '0'; delete process.env.DONOVAN_LEARNED_TARGET; delete process.env.DONOVAN_LEARNED_FOLD; delete process.env.DONOVAN_LEARNED_BACKEND; delete process.env.DONOVAN_LEARNED_MODEL_DIR; delete process.env.DONOVAN_READER_VERIFIER; delete process.env.DONOVAN_VERIFIER_THRESHOLD;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const DATA = path.join(ROOT, 'api/_lib/dql/reader-ml/data');
const BASE_FIXTURE = path.join(ROOT, 'scripts/golden/reader-verifier-off-baseline.json');
const R = await import('../api/_lib/dql/reader-ml/index.js');
const MODEL = await import('../api/_lib/dql/reader-ml/model.js');
const ANON = await import('../api/_lib/dql/reader-ml/anon.js');
const GEN = process.argv.includes('--gen-off');

/* ================================================================== harness: the golden company, as in verify:learned-reader-r25 */
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:rv', tenantName: 'rv' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { loadSnapshot } = await import('../api/_lib/dql/load.js');
const TODAY = '2026-10-07'; const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'rv' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const snap = await withTenant(ctxArg, (db) => loadSnapshot(db, { today: TODAY }));
const vctx = { tv, pack, today: TODAY, snap };
const custNames = data.entities.filter((e) => e.entity_type === 'customer').map((e) => e.data.customer_name);
const NAME = custNames.find((n) => snap.documents.filter((d) => d.type === 'invoice' && d.custName === n).length >= 1) ?? custNames[0];
const QUESTIONS = [
  `boss asked me to find out how many invoices ${NAME} has on file when you get a chance`, `hey y'all how many invoices did we do in 2024, thx`, `so i was thinking, count the invoices tied to ${NAME} - and be exact`,
  'how many work orders in 2023', 'how many invoices', `total of invoices for ${NAME}`, 'what is the average invoice amount', 'how many invoices in 2022', `how many invoices for ${NAME} in 2024`,
  'how many invoices did we do in 2024', 'total of invoices in 2024', `what is the total of invoices for ${NAME}`, 'average invoice amount in 2023', `count the invoices for ${NAME}`, 'how many estimates',
  'how many quotes did we send', 'how many invoices were issued last year', 'how many invoices per month in 2024', 'top 5 customers by invoice total', 'who has the most invoices',
  'sum of unpaid invoices', 'number of visits in 2024', 'how many service visits were there in 2023', 'what is the largest invoice', 'what was the smallest invoice in 2024',
  'and what about them', 'how many of those were in Mesa', 'how many invoices for Zelda Quimby', `how many invoices except ${NAME}`, 'how many invoices not in Mesa',
  `how many invoices and also the total for ${NAME}`, 'how much is unpaid on invoices', 'how many invoices compared with last year', `what is the balance owed by ${NAME}`,
  'list the hr letters', 'tell me a joke about invoices', 'how many signed consent forms', 'hi', 'x'.repeat(400), '', `what is the phone number of ${NAME}`, 'who was the latest customer', 'compare invoices of 2023 and 2024',
  'is it true that we have invoices', 'count of invoices by customer', 'how many invoices from january to march 2024', 'what is the total of all work orders',
];
const MUST_RELEASE = QUESTIONS.slice(QUESTIONS.indexOf('and what about them'), QUESTIONS.indexOf('and what about them') + 18);
const collect = async (target) => {
  if (target) process.env.DONOVAN_LEARNED_TARGET = target; else delete process.env.DONOVAN_LEARNED_TARGET;
  const out = []; for (const q of QUESTIONS) out.push(JSON.stringify(await R.proposeLearned(q, vctx))); delete process.env.DONOVAN_LEARNED_TARGET; return out;
};
if (GEN) {
  fs.writeFileSync(BASE_FIXTURE, JSON.stringify({ note: 'proposeLearned results recorded BEFORE the verifier existed (shipped target, and target=open); verify:reader-verifier asserts the OFF path reproduces them exactly', questions: QUESTIONS, shipped: await collect(null), open: await collect('open') }));
  realLog('wrote', BASE_FIXTURE); process.exit(0);
}
const V = await import('../api/_lib/dql/reader-ml/verifier.mjs');
const CFG = JSON.parse(fs.readFileSync(path.join(DATA, 'verifier.json'), 'utf8'));
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/learned-reader-fixture.json'), 'utf8'));
const PAR = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/reader-verifier-parity.json'), 'utf8'));
const BASE = JSON.parse(fs.readFileSync(BASE_FIXTURE, 'utf8'));
const M = MODEL.loadCpuModel(DATA);

/* ================================================================== 1. the switch and the files */
check('switch :: DONOVAN_READER_VERIFIER is OFF by default', R.DEFAULT_VERIFIER_ON === false && R.verifierEnabled({}) === false);
check('switch :: only =1 turns it on (0, true, empty, yes stay off)', R.verifierEnabled({ DONOVAN_READER_VERIFIER: '1' }) === true && ['0', 'true', '', 'yes', 'on'].every((v) => R.verifierEnabled({ DONOVAN_READER_VERIFIER: v }) === false));
check('switch :: independent of the reader\'s own kill switch', R.learnedReaderEnabled({ DONOVAN_LEARNED_READER: '0', DONOVAN_READER_VERIFIER: '1' }) === false);
const vsrc = fs.readFileSync(path.join(ROOT, 'api/_lib/dql/reader-ml/verifier.mjs'), 'utf8');
check('files :: verifier.mjs has no imports at all (dependency-free)', !/^\s*import\s|require\(|import\(/m.test(vsrc));
check('files :: verifier.mjs does no I/O (no fs, no network, no env)', !/\bfs\b|process\.|fetch\(|node:/.test(vsrc.replace(/\/\/.*$/gm, '')));
const vsize = fs.statSync(path.join(DATA, 'verifier.json')).size;
check('files :: data/verifier.json is under 1 MB', vsize < 1024 * 1024, String(vsize));
check('files :: the whole data folder is still under 32 MB', fs.readdirSync(DATA).reduce((a, f) => a + fs.statSync(path.join(DATA, f)).size, 0) < 32 * 1024 * 1024);
check('files :: no model file anywhere in the reader folder is over 100 MB', fs.readdirSync(DATA).every((f) => fs.statSync(path.join(DATA, f)).size < 100e6));
check('config :: 300 trees, nine temperatures above 1 (every head is overconfident), beam width 30, 41 features', CFG.tree_dump.tree_info.length === 300 && V.HEADS.every((h) => CFG.temperatures[h] > 1) && CFG.beam_width === 30 && CFG.features.length === 41);
check('config :: thresholds are in order: cp995 above cp99 and emp995 above emp99; the shipped one is cp995', CFG.thresholds.cp995 > CFG.thresholds.cp99 && CFG.thresholds.emp995 > CFG.thresholds.emp99 && CFG.threshold === CFG.thresholds.cp995 && CFG.threshold_name === 'cp995');
check('config :: every threshold is a probability in (0.9, 1)', Object.values(CFG.thresholds).every((t) => t > 0.9 && t < 1));
check('threshold :: a number, a name, or the shipped default', V.pickThreshold(CFG, '0.97') === 0.97 && V.pickThreshold(CFG, 'cp99') === CFG.thresholds.cp99 && V.pickThreshold(CFG, undefined) === CFG.threshold && V.pickThreshold(CFG, 'junk') === CFG.threshold && V.pickThreshold(CFG, '7') === CFG.threshold && V.pickThreshold(CFG, '0') === CFG.threshold);
check('rules :: api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
check('rules :: ask.js, retrieval/ and grounding/ are not touched by the verifier', !/reader-ml|VERIFIER|verifier/.test(fs.readFileSync(path.join(ROOT, 'api/ask.js'), 'utf8')) && !/verifier/i.test(fs.readdirSync(path.join(ROOT, 'api/_lib/retrieval')).map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib/retrieval', f), 'utf8')).join('\n')) && !/verifier/i.test(fs.readdirSync(path.join(ROOT, 'api/_lib/grounding')).map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib/grounding', f), 'utf8')).join('\n')));
check('docs :: docs/LEARNED_READER.md explains the verifier switch', /DONOVAN_READER_VERIFIER/.test(fs.readFileSync(path.join(ROOT, 'docs/LEARNED_READER.md'), 'utf8')));

/* ================================================================== 2. predictTop5 is the same forward pass */
{
  let same = 0; let mono = 0; let ent = 0; let first = 0;
  for (const o of FX.model) {
    const a = MODEL.predict(o.an, M); const b = MODEL.predictTop5(o.an, M);
    if (JSON.stringify([a.A, a.P, a.Q, a.labels]) === JSON.stringify([b.A, b.P, b.Q, b.labels])) same++;
    if (b.top5.every((t) => t.pv.every((v, k) => k === 0 || t.pv[k - 1] >= v) && t.pv.reduce((x, y) => x + y, 0) <= 1 + 1e-9)) mono++;
    if (b.top5.every((t) => t.ent >= 0)) ent++;
    if (b.top5.every((t, j) => t.ix[0] === b.A[j] && Math.abs(t.pv[0] - b.P[j]) < 1e-9)) first++;
  }
  check(`top5 :: predictTop5 returns exactly predict's A, P, Q and labels on all ${FX.model.length} fixture questions`, same === FX.model.length, `${same}`);
  check('top5 :: probabilities are sorted and sum to at most 1', mono === FX.model.length);
  check('top5 :: the entropy of every head is non-negative', ent === FX.model.length);
  check('top5 :: the first of the five is the argmax with its probability', first === FX.model.length);
  check('top5 :: predict itself carries no extra field (the OFF path is untouched)', Object.keys(MODEL.predict(FX.model[0].an, M)).join() === 'A,P,Q,labels');
}

/* ================================================================== 3. the verifier: JS equals Python */
{
  let dec = 0; let lab = 0; let maxd = 0; let acc = 0;
  for (const c of PAR.cases) {
    const r = V.scoreFromTop5(c.top5, CFG);
    if (r.answer === c.answer) dec++; if (JSON.stringify(r.labels) === JSON.stringify(c.labels)) lab++; maxd = Math.max(maxd, Math.abs(r.score - c.score)); if (r.answer) acc++;
  }
  check(`parity :: JS and Python (numpy beam + LightGBM) make the same answer / release decision on ${PAR.cases.length} recorded questions`, dec === PAR.cases.length && PAR.cases.length === 500, `${dec}`);
  check('parity :: the judged combination (the rescored labels) is identical on all 500', lab === 500, `${lab}`);
  check('parity :: scores agree to 1e-9', maxd < 1e-9, String(maxd));
  check('parity :: the fixture exercises both outcomes (answers and releases)', acc > 50 && acc < 450, String(acc));
  check('parity :: the fixture\'s threshold is the shipped one', PAR.threshold === CFG.threshold);
  const viaProbs = PAR.cases.slice(0, 20).every((c) => { // full probability vectors in, same verdict: top5() inside score()
    const probs = c.top5.map((t) => { const p = new Float64Array(60).fill(0); t.ix.forEach((i, k) => { p[i] = t.pv[k]; }); return p; });
    const a = V.score(probs, CFG); const b = V.scoreFromTop5(probs.map((p) => { const ix = [...p.keys()].sort((x, y) => p[y] - p[x]).slice(0, 5); return { ix, pv: ix.map((i) => p[i]), ent: 0 }; }), CFG);
    return a.answer === b.answer || Math.abs(a.score - b.score) < 0.05; // entropy differs by construction (the stub has none); only a sanity check of the input path
  });
  check('parity :: score() on full vectors and scoreFromTop5 accept the same shapes', viaProbs);
}
{
  const real = PAR.cases.filter((c) => c.answer).sort((x, y) => y.score - x.score)[0]; // a recorded question the verifier accepts
  const withEnt = (c, f) => c.top5.map((t, j) => ({ ...t, ent: f(j, t) }));
  const honest = V.scoreFromTop5(real.top5, CFG);
  check('stub :: a genuinely confident recorded question is accepted', honest.answer === true && honest.score >= CFG.threshold, JSON.stringify(honest));
  const lying = V.scoreFromTop5(real.top5.map((t) => ({ ...t, pv: [0.99999, ...t.pv.slice(1).map((v) => Math.min(v, 1e-6))], ent: 5.5 })), CFG);
  check('stub :: a stub that claims p 0.99999 on every head while its entropy says the distribution is flat is rejected', lying.answer === false, JSON.stringify(lying));
  const lyingAll = V.scoreFromTop5(withEnt(real, () => 6), CFG);
  check('stub :: the same confident probabilities with a high entropy on every head are rejected', lyingAll.answer === false, JSON.stringify(lyingAll));
  const lyingSix = V.scoreFromTop5(withEnt(real, (j, t) => (j >= 3 ? 6 : t.ent)), CFG);
  check('stub :: confident probabilities contradicted by a high entropy on six heads are rejected', lyingSix.answer === false, JSON.stringify(lyingSix));
  const doubtful = V.scoreFromTop5(real.top5.map((t, j) => (j === 2 ? { ...t, pv: [0.5, 0.49, 0.005, 0.003, 0.001], ent: 1 } : t)), CFG);
  check('stub :: eight confident heads and one that is torn between two classes (0.50 / 0.49) are rejected', doubtful.answer === false, JSON.stringify(doubtful));
  const noMargin = V.scoreFromTop5(real.top5.map((t, j) => (j === 4 ? { ...t, pv: [t.pv[0], t.pv[0], t.pv[2], t.pv[3], t.pv[4]], ent: 3 } : t)), CFG);
  check('stub :: a head claiming a top-1 equal to its top-2 (no margin) is rejected', noMargin.answer === false, JSON.stringify(noMargin));
  const flat = V.scoreFromTop5(real.top5.map((t) => ({ ...t, pv: [0.2, 0.19, 0.18, 0.17, 0.16], ent: 3 })), CFG);
  check('stub :: an uncertain question (p 0.2 on every head) is released', flat.answer === false && flat.score < 0.5, JSON.stringify(flat));
  const allOther = V.scoreFromTop5(Array.from({ length: 9 }, () => ({ ix: [0, 1, 2, 3, 4], pv: [0.99999, 0.000005, 0.000002, 0.000001, 0.000001], ent: 0.0003 })), CFG);
  check('stub :: when every candidate has <OTHER> somewhere the score is 0 and nothing is answered', allOther.answer === false && allOther.score === 0 && allOther.labels === null);
  const oneOther = V.scoreFromTop5(real.top5.map((t, j) => (j === 3 ? { ...t, ix: [0, ...t.ix.slice(1)] } : t)), CFG);
  check('stub :: <OTHER> as the favourite of one head: the judged combination never contains it', oneOther.labels === null || oneOther.labels.every((c) => c !== 0), JSON.stringify(oneOther.labels));
  const hi = V.scoreFromTop5(real.top5, CFG, 0.5); const lo = V.scoreFromTop5(real.top5, CFG, 1.01);
  check('threshold :: the same question is accepted at 0.5 and released above 1', hi.answer === true && lo.answer === false && hi.score === lo.score);
  check('determinism :: the same input gives the same score', V.scoreFromTop5(real.top5, CFG).score === V.scoreFromTop5(real.top5, CFG).score);
}

/* ================================================================== 4. OFF changes nothing */
const ofs = async (envv) => { if (envv === undefined) delete process.env.DONOVAN_READER_VERIFIER; else process.env.DONOVAN_READER_VERIFIER = envv; };
{
  check('off :: the baseline fixture covers every question, shipped target and target=open', BASE.questions.join('\n') === QUESTIONS.join('\n') && BASE.shipped.length === QUESTIONS.length && BASE.open.length === QUESTIONS.length);
  await ofs(undefined);
  const a = await collect(null); const b = await collect('open');
  check('off :: unset: every result is byte-identical to the one recorded before the verifier existed (shipped target)', a.every((s, i) => s === BASE.shipped[i]), a.map((s, i) => (s === BASE.shipped[i] ? null : QUESTIONS[i])).filter(Boolean).join(' | '));
  check('off :: unset: byte-identical with every confidence threshold open', b.every((s, i) => s === BASE.open[i]), b.map((s, i) => (s === BASE.open[i] ? null : QUESTIONS[i])).filter(Boolean).join(' | '));
  const answered = BASE.open.filter((s) => JSON.parse(s).ok).length;
  check('off :: the baseline contains answered questions (so the comparison has teeth)', answered >= 4, String(answered));
  await ofs('0'); const c0 = await collect('open'); await ofs('true'); const c1 = await collect('open');
  check('off :: =0 and =true (anything but 1) are the same as unset', c0.every((s, i) => s === BASE.open[i]) && c1.every((s, i) => s === BASE.open[i]));
  await ofs('0'); process.env.DONOVAN_VERIFIER_THRESHOLD = '0.5'; const c2 = await collect(null); delete process.env.DONOVAN_VERIFIER_THRESHOLD;
  check('off :: a threshold set while OFF has no effect', c2.every((s, i) => s === BASE.shipped[i]));
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules/.rv-off-'));
  try {
    for (const f of fs.readdirSync(DATA)) if (f !== 'verifier.json') fs.copyFileSync(path.join(DATA, f), path.join(dir, f));
    process.env.DONOVAN_LEARNED_MODEL_DIR = dir; await ofs(undefined); const d = await collect(null);
    check('off :: the reader does not need verifier.json when OFF (same results without the file)', d.every((s, i) => s === BASE.shipped[i]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DONOVAN_LEARNED_MODEL_DIR; }
  const rsrc = fs.readFileSync(path.join(ROOT, 'api/_lib/dql/reader-ml/index.js'), 'utf8');
  check('off :: translator/index.js and the callers of proposeLearned are unchanged in shape (same exports)', typeof R.proposeLearned === 'function' && typeof R.learnedReaderEnabled === 'function' && typeof R.anonVocabFor === 'function' && R.DEFAULT_TARGET === '0.995' && R.DEFAULT_ON === true && /DONOVAN_READER_VERIFIER/.test(rsrc));
}

/* ================================================================== 5. ON: answers only when the verifier accepts */
{
  await ofs('1'); const vocab = R.anonVocabFor(snap, tv);
  const verdict = (q) => { const an = ANON.anonText(q.trim(), ANON.mentions(q.trim(), vocab)); const top = MODEL.predictTop5(an, M).top5; return { v: V.scoreFromTop5(top, CFG), top }; };
  const run = async (target, thr) => { if (thr) process.env.DONOVAN_VERIFIER_THRESHOLD = thr; else delete process.env.DONOVAN_VERIFIER_THRESHOLD; const o = []; if (target) process.env.DONOVAN_LEARNED_TARGET = target; else delete process.env.DONOVAN_LEARNED_TARGET; for (const q of QUESTIONS) o.push(await R.proposeLearned(q, vctx)); delete process.env.DONOVAN_LEARNED_TARGET; delete process.env.DONOVAN_VERIFIER_THRESHOLD; return o; };
  const def = await run(null); const cp99 = await run(null, 'cp99'); const emp99 = await run(null, 'emp99'); const wide = await run(null, '0.5'); const open = await run('open');
  const okIdx = (a) => new Set(a.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0));
  const longQ = QUESTIONS.map((q, i) => i).filter((i) => QUESTIONS[i].trim().length >= 6 && QUESTIONS[i].length <= 300);
  const rejected = longQ.filter((i) => !verdict(QUESTIONS[i]).v.answer);
  check('on :: every question the verifier rejects is released with the reason "verifier"', rejected.every((i) => def[i].ok === false && def[i].reason === 'verifier' && def[i].score < CFG.threshold), rejected.map((i) => `${QUESTIONS[i]} => ${JSON.stringify(def[i])}`).slice(0, 2).join(' | '));
  check('on :: every answer comes with a verifier acceptance, and its labels are the judged combination', [...okIdx(def)].every((i) => { const { v } = verdict(QUESTIONS[i]); return v.answer && JSON.stringify(def[i].labels) === JSON.stringify(v.labels.map((c, j) => M.classes[MODEL.HEADS[j]][c])) && Math.abs(def[i].miss - (1 - v.score)) < 1e-12; }));
  check('on :: with the verifier at 0.5 the very same holds (acceptance is the gate, whatever the threshold)', [...okIdx(wide)].every((i) => verdict(QUESTIONS[i]).v.score >= 0.5) && wide.every((r, i) => r.ok || !(longQ.includes(i)) || r.reason !== 'verifier' || verdict(QUESTIONS[i]).v.score < 0.5));
  const sa = okIdx(def); const sb = okIdx(cp99); const sc = okIdx(emp99);
  check('on :: a looser threshold only adds answers (cp995 inside cp99 inside emp99)', [...sa].every((i) => sb.has(i)) && [...sb].every((i) => sc.has(i)), `${sa.size}/${sb.size}/${sc.size}`);
  check('on :: the reader still answers some questions under the verifier', sc.size >= 1, `${sa.size}/${sb.size}/${sc.size}`);
  check('on :: the confidence thresholds are not consulted (no low-confidence / other reasons at all)', [def, cp99, emp99, wide, open].every((a) => a.every((r) => r.ok || !/^(low-confidence|other$)/.test(r.reason))));
  const t999 = await run('0.999'); const t99 = await run('0.99');
  check('on :: DONOVAN_LEARNED_TARGET makes no difference while the verifier is on', t999.every((r, i) => JSON.stringify(r) === JSON.stringify(def[i])) && t99.every((r, i) => JSON.stringify(r) === JSON.stringify(def[i])));
  check('on :: the must-release list (follow-ups, invented names, negations, multi-part, private, lookups, empty) stays released at the loosest threshold', MUST_RELEASE.every((q) => { const i = QUESTIONS.indexOf(q); return wide[i].ok === false && emp99[i].ok === false; }), MUST_RELEASE.filter((q) => wide[QUESTIONS.indexOf(q)].ok).join(' | '));
  check('on :: a statement-worded yes/no ("is it true that ...") is released at the shipped threshold', def[QUESTIONS.indexOf('is it true that we have invoices')].ok === false);
  const ans = [...sc].map((i) => emp99[i]);
  check('on :: an accepted proposal still carries a validated plan, the raw plan and nine labels', ans.every((r) => r.plan && r.raw && r.labels.length === 9 && r.Q.length === 9 && typeof r.miss === 'number'));
  check('on :: an accepted question is a skeleton the model was trained on (the seen-skeleton test still applies)', ans.every((r) => r.skeletonOp));
  const dirs = [];
  const mkdir = () => { const d = fs.mkdtempSync(path.join(ROOT, 'node_modules/.rv-on-')); dirs.push(d); for (const f of fs.readdirSync(DATA)) if (f !== 'verifier.json') fs.symlinkSync(path.join(DATA, f), path.join(d, f)); process.env.DONOVAN_LEARNED_MODEL_DIR = d; return d; };
  try {
    let dir;
    const stub = (leaf) => ({ ...CFG, tree_dump: { tree_info: [{ tree_structure: { leaf_value: leaf } }] }, threshold: 0.5, thresholds: { ...CFG.thresholds } });
    const put = (c) => { dir = mkdir(); fs.writeFileSync(path.join(dir, 'verifier.json'), JSON.stringify(c)); }; // a new folder each time: the reader caches the config per folder
    const reload = async (qs) => { const o = []; for (const q of qs) o.push(await R.proposeLearned(q, vctx)); return o; };
    put({ ...CFG, threshold: 1.1 }); let r = await reload(QUESTIONS.filter((q) => q.length >= 6 && q.length <= 300));
    check('on :: a config whose threshold is above any score answers nothing and releases every question as "verifier"', r.every((x) => !x.ok && x.reason === 'verifier'), r.find((x) => x.ok || x.reason !== 'verifier') && JSON.stringify(r.find((x) => x.ok || x.reason !== 'verifier')).slice(0, 120));
    put(stub(-25)); r = await reload(QUESTIONS.slice(0, 12));
    check('on :: a verifier that always says no (every tree -25) answers nothing', r.every((x) => !x.ok && x.reason === 'verifier'));
    put(stub(25)); r = await reload(QUESTIONS);
    check('on :: a verifier that always says yes cannot push a wrong question through: the other tests still release the must-release list', MUST_RELEASE.every((q) => !r[QUESTIONS.indexOf(q)].ok));
    check('on :: ... and the questions it passes carry plans validated against the company\'s own records', r.filter((x) => x.ok).every((x) => x.plan?.op && x.raw?.op));
    dir = mkdir(); r = await reload(QUESTIONS.slice(3, 8));
    check('on :: a missing verifier.json is a release ("verifier-config"), never a crash and never an answer', r.every((x) => !x.ok && x.reason === 'verifier-config'));
    dir = mkdir(); fs.writeFileSync(path.join(dir, 'verifier.json'), '{not json'); r = await reload(QUESTIONS.slice(3, 6));
    check('on :: a corrupt verifier.json is a release too', r.every((x) => !x.ok && x.reason === 'verifier-config'));
    dir = mkdir(); fs.writeFileSync(path.join(dir, 'verifier.json'), JSON.stringify({ temperatures: CFG.temperatures, tree_dump: { tree_info: [] } })); r = await reload(QUESTIONS.slice(3, 5));
    check('on :: a verifier.json with no trees is a release too', r.every((x) => !x.ok && x.reason === 'verifier-config'));
    put(CFG); process.env.DONOVAN_LEARNED_BACKEND = 'onnx'; r = await reload(QUESTIONS.slice(3, 6)); delete process.env.DONOVAN_LEARNED_BACKEND;
    check('on :: with the GPU backend the verifier (fitted to the CPU model) is not applied: a release, "verifier-backend"', r.every((x) => !x.ok && x.reason === 'verifier-backend'));
    process.env.DONOVAN_LEARNED_BACKEND = 'cpu'; r = await reload(QUESTIONS.slice(3, 6)); delete process.env.DONOVAN_LEARNED_BACKEND;
    check('on :: the CPU backend named explicitly works', r.some((x) => x.ok || x.reason !== 'verifier-backend'));
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); delete process.env.DONOVAN_LEARNED_MODEL_DIR; }
  await ofs(undefined);
  const again = await collect(null);
  check('off again :: switching it back off restores the recorded results exactly (no state is kept)', again.every((s, i) => s === BASE.shipped[i]));
  const timing = (() => { const t = process.hrtime.bigint(); for (let i = 0; i < 50; i++) V.scoreFromTop5(PAR.cases[i].top5, CFG); return Number(process.hrtime.bigint() - t) / 1e6 / 50; })();
  check('cost :: the verifier adds under 10 ms per question (beam plus 300 trees)', timing < 10, `${timing.toFixed(2)} ms`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  (${passes} passed, ${failures} failed)`);
process.exit(failures ? 1 : 0);
