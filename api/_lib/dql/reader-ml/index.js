/**
 * dql/reader-ml - Donovan's LEARNED QUESTION READER (R25), behind DONOVAN_LEARNED_READER.
 *
 *   learnedReaderEnabled()                    DONOVAN_LEARNED_READER=1 forces it on, =0 off; unset follows DEFAULT_ON below
 *   proposeLearned(question, {tv, pack, today, snap})   -> {ok: true, plan, raw, labels, miss} | {ok: false, reason}
 *
 * What it is: a small model reads the ANONYMIZED question (anon.js) and predicts the nine parts of a plan skeleton (model.js) with a probability for
 * each; a deterministic filler (fill.js) copies the values from the question's own words and the company's records. It runs ONLY for a question the
 * rules engine (dql/parse.js) has released, and it never overrides an answer. The proposed plan is used only when ALL of this holds:
 *   1. every head's miss mass and their sum are below the calibrated thresholds (data/calibration.json; the target is DONOVAN_LEARNED_TARGET, default 0.995)
 *   2. no head says <OTHER>, and the nine parts form a skeleton seen in training (data/trsk.bin)
 *   3. every literal in it is a closed structural word or one of this company's own words
 *   4. the filler resolves every slot to a word of the question and a record of the company
 *   5. the plan maps to the translator's plan shape (map.js) and passes translator/validate.js: values anchored to the question's words, every word
 *      explained (the coverage rule), nothing invented, private papers never
 *   6. the period and the values of the validated plan equal the filler's own
 * Any doubt: {ok: false} and the question goes to the model exactly as before.
 *
 * R26: the VERIFIER (verifier.mjs + data/verifier.json), behind DONOVAN_READER_VERIFIER (default OFF). When ON it replaces test 1 (the per-head miss-mass thresholds): a small
 * tree model judges the whole nine-part answer (joint beam over the heads, confidence features) and the reader answers only if it accepts; tests 2 to 6 still apply, to the
 * combination the verifier judged. Unset or =0, nothing below changes: the same code path, the same results. DONOVAN_VERIFIER_THRESHOLD picks a threshold (a number or
 * cp995 | cp99 | emp995 | emp99); the shipped one is the Clopper-Pearson 99.5 percent threshold on held-out companies. Needs the CPU model (the verifier is fitted to its outputs).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCpuModel, predict, predictTop5, skeletonKey, HEADS } from './model.js';
import { scoreFromTop5, pickThreshold } from './verifier.mjs';
import { loadOnnx, predictOnnx } from './onnx.js';
import { buildAnonVocab, mentions, anonText } from './anon.js';
import { loadFillData, skeletonSeen, makeCtx, unskel, literalOk } from './fill.js';
import { toRaws } from './map.js';
import { validateTranslatedPlan } from '../translator/validate.js';

/** the shipped default; DONOVAN_LEARNED_READER=0 is the kill switch, =1 forces it on */
export const DEFAULT_ON = true; // R25: measured on never-seen wording (tier 1, tier 2 and every suite): no wrong answer added, 100 percent of the newly answered right; set DONOVAN_LEARNED_READER=0 to turn it off
export const DEFAULT_TARGET = '0.995';
export const learnedReaderEnabled = (env = process.env) => (env?.DONOVAN_LEARNED_READER === '1' ? true : env?.DONOVAN_LEARNED_READER === '0' ? false : DEFAULT_ON);
/** DONOVAN_READER_VERIFIER=1 turns the verifier on; unset or anything else is off (the reader then works exactly as before) */
export const DEFAULT_VERIFIER_ON = false;
export const verifierEnabled = (env = process.env) => (env?.DONOVAN_READER_VERIFIER === '1' ? true : DEFAULT_VERIFIER_ON);
const DIR = () => process.env.DONOVAN_LEARNED_MODEL_DIR || fileURLToPath(new URL('./data', import.meta.url));

let CAL = null;
/** The CPU model ships miss-mass thresholds (data/calibration.json: targets -> fold -> {head[], total}); the GPU kit ships calibration.json with
 *  `calibration: {"0.999": {thr_fold0, thr_fold1, thr_all}}` on conf = product of head probabilities, i.e. a total miss of about 1 - conf. */
function thresholds(backend) {
  if (process.env.DONOVAN_LEARNED_TARGET === 'open') return { total: Infinity, head: new Array(9).fill(Infinity) }; // measurement only: every threshold is applied afterwards
  CAL ??= JSON.parse(fs.readFileSync(`${DIR()}/calibration.json`, 'utf8'));
  const tg = String(process.env.DONOVAN_LEARNED_TARGET || DEFAULT_TARGET); const fold = process.env.DONOVAN_LEARNED_FOLD || 'all';
  if (CAL.calibration) { // GPU kit format
    const c = CAL.calibration[tg]; const thr = c?.[`thr_${fold}`] ?? c?.thr_all;
    return { total: thr == null ? -1 : 1 - thr, head: new Array(9).fill(Infinity) }; // no calibrated threshold = never answer
  }
  const set = CAL.targets[tg] ?? CAL.targets['0.999'];
  return set[fold] ?? set.all;
}
const backendName = () => (process.env.DONOVAN_LEARNED_BACKEND || (fs.existsSync(`${DIR()}/model.onnx`) ? 'onnx' : 'cpu'));
async function predictAny(an) {
  const b = backendName();
  if (b === 'onnx') return { pr: await predictOnnx(an, await loadOnnx(DIR())), backend: 'onnx' };
  return { pr: predict(an, loadCpuModel(DIR())), backend: 'cpu' };
}

let VCFG = null;
/** data/verifier.json (trees, temperatures, thresholds), read once per folder; null when it is missing or unreadable */
function loadVerifier(dir) {
  if (VCFG?.dir === dir) return VCFG.cfg;
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(`${dir}/verifier.json`, 'utf8')); if (!cfg?.tree_dump?.tree_info?.length || !cfg.temperatures) cfg = null; } catch { cfg = null; }
  VCFG = { dir, cfg }; return cfg;
}

const normType = (t) => String(t ?? '').trim().toLowerCase().replace(/_/g, '-');
const VCACHE = new WeakMap();
/** the anonymizer's vocabulary: the company's own records (snapshot) plus the request's vocabulary */
export function anonVocabFor(snap, tv) {
  const key = snap ?? tv; let hit = VCACHE.get(key); if (hit) return hit;
  const cust = new Set(); const staff = new Set(); const city = new Set(); const vals = new Set(); const dts = new Set();
  const addVals = (set, cap) => { if (set.size && set.size <= cap) for (const v of set) if (v.length > 2 && v.length <= 40) vals.add(v); };
  if (snap) {
    for (const c of snap.customers ?? []) { if (c.name) cust.add(c.name); if (c.city) city.add(c.city); }
    const st = new Set(); const vn = new Set(); const sv = new Set(); const br = new Set();
    for (const d of snap.documents ?? []) { if (d.custName) cust.add(d.custName); if (d.tech) staff.add(d.tech); if (d.city) city.add(d.city); if (d.type) dts.add(normType(d.type)); if (d.status) st.add(d.status); if (d.vendor) vn.add(d.vendor); if (d.serviceType) sv.add(d.serviceType); if (d.brand) br.add(d.brand); }
    addVals(st, 60); addVals(vn, 60); addVals(sv, 60); for (const b of br) if (b.length > 2) vals.add(b);
    for (const u of snap.units ?? []) { if (u.brand) vals.add(u.brand); if (u.type) vals.add(u.type); }
  }
  if (tv) {
    for (const n of tv.customers?.phrases ?? []) cust.add(n); for (const n of tv.technicians?.phrases ?? []) staff.add(n); for (const n of tv.cities ?? []) city.add(n);
    for (const b of tv.brands ?? []) vals.add(b); for (const b of tv.equipmentTypes ?? []) vals.add(b);
    for (const d of tv.dql?.docTypes ?? []) dts.add(normType(d.id));
  }
  hit = buildAnonVocab({ cust: [...cust], staff: [...staff], city: [...city], vals: [...vals], docTypes: [...dts] });
  hit.allowed = new Set([...hit.dts, ...cust, ...staff, ...city, ...vals].map((x) => String(x).toLowerCase()));
  VCACHE.set(key, hit); return hit;
}

const rej = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const lcj = (x) => String(x ?? '').toLowerCase();

export async function proposeLearned(question, { tv, pack, today, snap } = {}) {
  try { return await propose(question, { tv, pack, today, snap }); } catch (e) { return rej(`error:${String(e?.message ?? e).slice(0, 60)}`); }
}
async function propose(question, { tv, pack, today, snap }) {
  const q = String(question ?? '').trim();
  if (q.length < 6 || q.length > 300) return rej('length');
  if (!tv || !today) return rej('no-context');
  const dir = DIR(); const D = loadFillData(dir);
  const V = anonVocabFor(snap, tv);
  const ms = mentions(q, V); const an = anonText(q, ms);
  let pr; let total; let labels; let backend;
  if (verifierEnabled()) { // R26: the verifier judges the whole combination (replaces the miss-mass thresholds); everything after it is unchanged
    if (backendName() !== 'cpu') return rej('verifier-backend');
    const vcfg = loadVerifier(dir); if (!vcfg) return rej('verifier-config');
    const M = loadCpuModel(dir); pr = predictTop5(an, M);
    const v = scoreFromTop5(pr.top5, vcfg, pickThreshold(vcfg, process.env.DONOVAN_VERIFIER_THRESHOLD));
    total = 1 - v.score; if (!v.answer) return rej('verifier', { total, score: v.score });
    labels = v.labels.map((c, j) => M.classes[HEADS[j]][c]);
  } else {
    ({ pr, backend } = await predictAny(an)); labels = pr.labels;
    if (pr.labels.some((l) => l === '<OTHER>')) return rej('other');
    const th = thresholds(backend); total = pr.Q.reduce((a, b) => a + b, 0);
    if (!(total <= th.total)) return rej('low-confidence', { total });
    for (let j = 0; j < pr.Q.length; j++) if (!(pr.Q[j] <= Math.max(th.head[j], th.total / 4))) return rej(`low-confidence:${j}`, { total });
  }
  if (!skeletonSeen(D, skeletonKey(labels))) return rej('unseen-skeleton', { total });
  const [op, ent, dt, meas, time, grp, filt, args, rest] = labels;
  let sk;
  try { sk = { ...(op != null ? { op } : {}), entity: ent, doc_type: dt, measure: meas, time: JSON.parse(time), group_by: JSON.parse(grp), filters: JSON.parse(filt), args: JSON.parse(args), ...JSON.parse(rest) }; } catch { return rej('skeleton-parse'); }
  if (!literalOk(sk, V.allowed, D)) return rej('literal', { total });
  const ctx = makeCtx(ms); let plan;
  try { plan = unskel(sk, ctx, today, D); } catch (e) { return rej(`fill:${String(e.message).slice(0, 40)}`, { total }); }
  const mapped = toRaws(plan, ms, q);
  if (!mapped.raws) return rej(`map:${mapped.none}`, { total, op: plan.op });
  let last = 'validate';
  for (const raw of mapped.raws) {
    const v = validateTranslatedPlan(raw, q, { tv, pack, today, snap });
    if (!v.ok) { last = `validate:${v.reason}`; continue; }
    const p = v.plan;
    if (plan.time) { if (!p.time || p.time.from !== plan.time.from || p.time.to !== plan.time.to) { last = 'period-disagrees'; continue; } } else if (p.time) { last = 'period-extra'; continue; }
    const gv = (plan.filters ?? []).filter((f) => f.field !== 'total').map((f) => lcj(f.value)).sort().join('|');
    const pv = (p.filters ?? []).filter((f) => f.field !== 'total').map((f) => lcj(f.value)).sort().join('|');
    if (gv !== pv) { last = 'values-disagree'; continue; }
    return { ok: true, plan: p, raw, labels, miss: total, Q: pr.Q, skeletonOp: plan.op };
  }
  return rej(last, { total, op: plan.op });
}
