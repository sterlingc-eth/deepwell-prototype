/** clausestack289.js - port of lib/clausestack289.py REV2 (clausepm289 rev2): stacked-evidence release of a verifier-withheld single-document clause LINE answer.
 * The rescue is a PER-VERSION operating-point flag: thresholds.precfix.ck289 = {p_min, pv_floor, cos_min, model, model_md5} (true = shipped defaults) of the shipped bundle; this module never reads a recipe.
 * Switch: env DONOVAN_READER_V2_CLAUSESTACK289=1 must be set to SERVE a bundle that carries ck289 (R79b: loop and app ON together); a flagged bundle with the switch off THROWS (like guard), so it cannot be served silently without the rescue.
 * A bundle without ck289 never reaches this code (byte-identical behaviour). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL0 = 'clausestack289_model.json';
export const NF = ['r_gap', 'r_cos', 'r_pm_gap', 'r_top', 'r_lex', 'r_ncw'];
const CUT = /\s*\(page \d+/; const END = /[.!?]["')\]]?$/; const START = /^["'(]?[A-Z0-9$]/;
export const switchOn = () => process.env.DONOVAN_READER_V2_CLAUSESTACK289 === '1';
/** the ck289 flag of a thresholds object (or null) */
export const flagOf = (thr) => { const k = thr && thr.precfix ? thr.precfix.ck289 : null; return k ? k : null; };
export function body(t) { const s = String(t ?? ''); const m = CUT.exec(s); return (m ? s.slice(0, m.index) : s).trim(); }
const MC = new Map();
function loadModel(name) {
  const p = path.join(HERE, 'data', path.basename(name || MODEL0));
  let h = MC.get(p);
  if (h === undefined) {
    try { const buf = fs.readFileSync(p); h = { m: JSON.parse(buf.toString('utf8')), md5: crypto.createHash('md5').update(buf).digest('hex') }; } catch (e) { h = null; }
    MC.set(p, h);
  }
  return h;
}
export const modelMd5 = (name) => { const h = loadModel(name); return h ? h.md5 : null; };
/** flag -> full parameter dict (true -> shipped defaults; object -> defaults overlaid; anything else -> null) */
export function norm(k) {
  if (k === true) k = {};
  if (k === null || typeof k !== 'object' || Array.isArray(k)) return null;
  return { p_min: 0.99, pv_floor: 0.80, cos_min: -1.0, model: MODEL0, ...k };
}
/** parameter dict is usable: the model loads and, when pinned, its md5 matches */
export function usable(k) {
  const kk = norm(k); if (!kk) return null;
  const h = loadModel(kk.model); if (!h || !h.m) return null;
  if (kk.model_md5 && h.md5 !== kk.model_md5) return null;
  return { kk, m: h.m };
}
export function prob(x, m) {
  if (!m) return 0.0;
  let z = Number(m.init); const lr = Number(m.lr);
  for (const t of m.trees) {
    let i = 0;
    while (t.l[i] !== -1) i = x[t.f[i]] <= t.t[i] ? t.l[i] : t.r[i];
    z += lr * t.v[i];
  }
  return 1.0 / (1.0 + Math.exp(-Math.max(Math.min(z, 30.0), -30.0)));
}
export function vec(pv, f, ct) {
  return [Number(pv), ...NF.map((k) => Number(f[k])), Number(ct[0]), Number(ct[1]), Number(ct[2]), Number(ct[9]), Number(ct[3]), Number(ct[4]), Number(ct[5]), Number(ct[6])];
}
export function decide(pv, f, ct, text, ndocs, k) {
  try {
    const u = usable(k === undefined || k === null ? true : k); if (!u) return false;
    const kk = u.kk;
    if (!ct || ct.length < 10 || ndocs !== 1) return false;
    if (Number(f.r_field ?? 1.0) !== 0.0 || ct[7] || ct[8]) return false;
    if (Number(pv) < Number(kk.pv_floor)) return false;
    if (Number(f.r_cos ?? 0.0) < Number(kk.cos_min)) return false;
    const b = body(text);
    if (!b || !END.test(b) || !START.test(b)) return false;
    return prob(vec(pv, f, ct), u.m) >= Number(kk.p_min);
  } catch (e) { return false; }
}
/** ctx = {VI: {featureName: index}, INTENTS: [...]} from the pipeline (avoids a circular import) */
export function fires(c, pv, k, ctx) {
  try {
    if (!c || typeof c !== 'object' || c.intent !== 'text') return false;
    const v = c._v; if (v === undefined || v === null) return false;
    const ci = Math.trunc(Number(v[ctx.VI.cand_intent_id]));
    const name = ci >= 0 && ci < ctx.INTENTS.length ? ctx.INTENTS[ci] : '';
    if (name !== 'text' || Number(v[ctx.VI.src]) !== 2.0) return false;
    const f = { r_field: Number(v[ctx.VI.r_field]) }; for (const n of NF) f[n] = Number(v[ctx.VI[n]]);
    return decide(pv, f, c._ct98s, c.text, (c.docs || []).length, k);
  } catch (e) { return false; }
}
/** precfix.passes rescue: pf = the version's precfix block, c = candidate, pv = verifier score.  Never called for a version without ck289. */
export function rescue(pf, c, pv, ctx) {
  try {
    const k = pf ? pf.ck289 : null; if (!k) return false;
    if (pf.grounding_hard && c._ungrounded) return false;
    return fires(c, pv, k, ctx);
  } catch (e) { return false; }
}
