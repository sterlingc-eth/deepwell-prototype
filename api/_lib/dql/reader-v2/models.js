/** models.js - the learned parts of Reader V2: int8 ONNX encoders (onnxruntime-web, wasm), the intent MLP head, the pair scorer, LightGBM trees. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WordPiece } from './tokenizer.js';
import { Booster } from './lgb.js';
import * as DT from './doctype.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, 'data');
const VENDOR = path.join(HERE, 'vendor', 'ort');
let ORT = null;
async function ort() {
  if (ORT) return ORT;
  const m = await import('./vendor/ort/ort.wasm.min.mjs');
  m.env.wasm.numThreads = 1; m.env.wasm.simd = true; m.env.wasm.proxy = false; m.env.wasm.wasmPaths = VENDOR + path.sep;
  ORT = m; return m;
}
const big = (arr) => { const o = new BigInt64Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = BigInt(arr[i]); return o; };
async function makeSession(file) {
  const m = await ort();
  return m.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' });   // 'basic': the int8 weight-only graph matches torch to 2e-6 only without the aggressive fusions
}
/** run rows of token ids (already padded to the same length) and return the mean-pooled [b, 384] */
async function pooled(session, rows) {
  const m = await ort(); const b = rows.length, s = rows[0].ids.length;
  const ids = new BigInt64Array(b * s), am = new BigInt64Array(b * s), tt = new BigInt64Array(b * s);
  rows.forEach((r, i) => { for (let j = 0; j < s; j++) { ids[i * s + j] = BigInt(r.ids[j]); am[i * s + j] = BigInt(r.mask[j]); tt[i * s + j] = BigInt(r.types[j]); } });
  const out = await session.run({ input_ids: new m.Tensor('int64', ids, [b, s]), attention_mask: new m.Tensor('int64', am, [b, s]), token_type_ids: new m.Tensor('int64', tt, [b, s]) });
  const d = out.pooled.data; const res = [];
  for (let i = 0; i < b; i++) res.push(Float32Array.from(d.subarray(i * 384, (i + 1) * 384)));
  return res;
}
const padRows = (encs) => { const L = Math.max(...encs.map((e) => e.ids.length)); return encs.map((e) => { const n = e.ids.length; const pad = (a, v) => a.concat(new Array(L - n).fill(v)); return { ids: pad(e.ids, 0), mask: pad(new Array(n).fill(1), 0), types: pad(e.types, 0) }; }); };
function l2(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; const n = Math.max(Math.sqrt(s), 1e-12); const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }
/** Emb: sentence embedder with cache; texts are embedded in length-sorted batches, L2-normalised (lib/emb.py Emb.enc) */
export class Emb {
  constructor(session, wp, maxLength = 48) { this.s = session; this.wp = wp; this.maxLength = maxLength; this.cache = new Map(); this.dim = 384; }
  async enc(texts, bs = 32) {
    const need = [...new Set(texts)].filter((t) => !this.cache.has(t));
    if (need.length) {
      need.sort((a, b) => a.length - b.length);
      for (let i = 0; i < need.length; i += bs) {
        const b = need.slice(i, i + bs); const encs = b.map((t) => this.wp.encode(t, this.maxLength));
        const out = await pooled(this.s, padRows(encs)); b.forEach((t, k) => this.cache.set(t, l2(out[k])));
      }
    }
    return texts.map((t) => this.cache.get(t));
  }
}
/** the clause cross-encoder: mean pooled [query, passage] pair -> passages' pooled vectors (head applied by the caller) */
export class PairEnc {
  constructor(session, wp, maxLen = 96) { this.s = session; this.wp = wp; this.maxLen = maxLen; }
  async pooled(q, passages) { const encs = passages.map((p) => this.wp.encodePair(q, p, this.maxLen)); return pooled(this.s, padRows(encs)); }
}
const softmax = (z) => { const m = Math.max(...z); const e = z.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((v) => v / s); };
const matvec = (x, W, b, nin, nout) => { const h = new Float32Array(nout); for (let j = 0; j < nout; j++) h[j] = b[j]; for (let i = 0; i < nin; i++) { const xi = x[i]; if (xi === 0) continue; const o = i * nout; for (let j = 0; j < nout; j++) h[j] += xi * W[o + j]; } return h; };
export class MLPHead {
  constructor(classes, layers) { this.classes_ = classes; this.layers = layers; }
  predictProba(x) {
    let h = x;
    this.layers.forEach(({ W, b, nin, nout }, i) => { h = matvec(h, W, b, nin, nout); if (i < this.layers.length - 1) for (let j = 0; j < h.length; j++) if (h[j] < 0) h[j] = 0; });
    return Array.from(softmax(Array.from(h)));
  }
}
export class Pair {
  constructor(W1, b1, W2, b2) { this.W1 = W1; this.b1 = b1; this.W2 = W2; this.b2 = b2; }
  /** scores for every candidate row ce[i] */
  score(qe, qf, ce, isf) {
    const n = ce.length, d = qe.length, nin = 3 * d + 1, nh = this.b1.length; const out = new Float32Array(n);
    const f = new Float32Array(nin);
    for (let r = 0; r < n; r++) {
      const c = ce[r];
      for (let i = 0; i < d; i++) { f[i] = qe[i] * c[i]; f[d + i] = Math.abs(qe[i] - c[i]); f[2 * d + i] = qf[i] * c[i]; }
      f[3 * d] = isf[r];
      const h = matvec(f, this.W1, this.b1, nin, nh); let s = this.b2[0];
      for (let j = 0; j < nh; j++) if (h[j] > 0) s += h[j] * this.W2[j];
      out[r] = s;
    }
    return out;
  }
}
export const CUES = [/\b(lowest|smallest|least|cheapest|minimum|tiniest|fewest|bottom|smallest-dollar|lowest-value)\b/, /\b(highest|largest|biggest|greatest|maximum|priciest|most expensive|top|highest-value)\b/,
  /\b(earliest|oldest|first|initial|very first)\b/, /\b(latest|newest|most recent|last|recent)\b/, /\b(total|totals|sum|combined|add up|adds up|added|together|grand total|altogether|combine)\b/,
  /\b(how many|number of|count)\b/, /\b(list|every|each|all|enumerate|show)\b/, /\b(many|much)\b/];
export const cues = (masked) => { const m = masked.toLowerCase(); return CUES.map((r) => (r.test(m) ? 1.0 : 0.0)); };
export class Models {
  constructor() { this.emb = null; this.intent_emb = null; this.intent_clf = null; this.ranker = null; this.verifier = null; this.pair = null; this.syn = {}; this.doctype = null; this.clause = null; }
  async intentProba(masked) {
    const [e] = await this.intent_emb.enc([masked]); const x = new Float32Array(e.length + 8); x.set(e); cues(masked).forEach((v, i) => { x[e.length + i] = v; });
    const p = this.intent_clf.predictProba(x); return new Map(this.intent_clf.classes_.map((c, i) => [c, p[i]]));
  }
}
const f32 = (buf, off, n) => { const a = new Float32Array(n); const dv = new DataView(buf.buffer, buf.byteOffset + off, n * 4); for (let i = 0; i < n; i++) a[i] = dv.getFloat32(i * 4, true); return a; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export async function loadModels(dir = DATA_DIR) {
  const B = readJson(path.join(dir, 'bundle.json')); const wts = fs.readFileSync(path.join(dir, 'weights.bin'));
  const T = (k) => { const t = B.tensors[k]; return f32(wts, t.offset, t.shape.reduce((a, b) => a * b, 1)); };
  const wp = new WordPiece(fs.readFileSync(path.join(dir, 'vocab.txt'), 'utf8'));
  const M = new Models(); M.bundle = B;
  M.emb = new Emb(await makeSession(path.join(dir, B.models.enc_base.file)), wp, 48);
  M.intent_emb = new Emb(await makeSession(path.join(dir, B.models.intent_enc.file)), wp, 48);
  M.intent_clf = new MLPHead(B.classes, [{ W: T('intent.W0'), b: T('intent.b0'), nin: B.tensors['intent.W0'].shape[0], nout: B.tensors['intent.W0'].shape[1] }, { W: T('intent.W1'), b: T('intent.b1'), nin: B.tensors['intent.W1'].shape[0], nout: B.tensors['intent.W1'].shape[1] }]);
  M.pair = new Pair(T('pair.W1'), T('pair.b1'), T('pair.W2'), T('pair.b2'));
  M.ranker = new Booster(readJson(path.join(dir, B.models.ranker.file))); M.verifier = new Booster(readJson(path.join(dir, B.models.verifier.file)));
  M.syn = B.switches.syn || {};
  const dcfg = B.switches.doctype; M.doctype = [DT.makeCfg(dcfg), new DT.Learned(dcfg)];
  M.thr = B.thresholds; M.switches = B.switches;
  if (B.models.cf2_lex) { const CF2 = await import('./clausefree2.js'); CF2.setData(readJson(path.join(dir, B.models.cf2_lex.file)), readJson(path.join(dir, B.models.cf2_meta.file))); }
  if (B.models.pv1_w) { const PV1 = await import('./pv1.js'); PV1.setData(f32(fs.readFileSync(path.join(dir, B.models.pv1_w.file)), 0, 1 << 18), B.models.pv1_w.b); }
  if (B.models.pm_inc_verifier) M.pmInc = { verifier: new Booster(readJson(path.join(dir, B.models.pm_inc_verifier.file))), thr: B.thresholds.pm_inc };      // precision_match anchor: the incumbent's verifier + thresholds (v003 bundles)
  const cc = B.switches.clause;
  if (cc && cc.on) { const CL = await import('./clause.js'); M.clause = new CL.Reader2(new PairEnc(await makeSession(path.join(dir, B.models.clause_ce.file)), wp, 96), cc); }
  return M;
}
