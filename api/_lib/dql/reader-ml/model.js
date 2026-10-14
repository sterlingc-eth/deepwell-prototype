/**
 * dql/reader-ml/model.js - the learned question reader's CPU model, in plain Node (no native packages).
 *
 * The model reads an ANONYMIZED question (company words already replaced by role tokens, see anon.js) and predicts the nine parts of a plan SKELETON
 * (op, entity, doc-type role, measure, time, group-by, filters, args, rest) with a probability for each. It never writes a value.
 *   hashed 1-4-gram features -> embedding bag (int8 rows) -> LayerNorm -> 128-512-512 MLP -> nine classification heads (int8)
 * File: data/model-cpu.bin (built by scripts/learned-reader/export_cpu_model.py); class names: data/classes.json.gz.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export const HEADS = ['op', 'ent', 'dt', 'meas', 'time', 'grp', 'filt', 'args', 'rest'];

// ---- crc32 with a starting value (the trainer hashed with python's zlib.crc32(bytes, salt))
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(str, salt) {
  let c = (salt ^ 0xffffffff) >>> 0;
  for (let i = 0; i < str.length; i++) c = CRC[(c ^ str.charCodeAt(i)) & 0xff] ^ (c >>> 8); // anonymized text is ASCII
  return (c ^ 0xffffffff) >>> 0;
}
/** the trainer's featurizer (learned_reader/feats.py, char=False) */
export function featurize(an, NB) {
  const mask = NB - 1; const h = (s, salt) => crc32(s, salt) & mask;
  const t = an.split(/\s+/).filter(Boolean); const n = t.length; const f = [];
  for (let i = 0; i < n; i++) {
    f.push(h(`u|${t[i]}`, 0));
    if (i + 1 < n) f.push(h(`b|${t[i]} ${t[i + 1]}`, 1));
    if (i + 2 < n) f.push(h(`t|${t[i]} ${t[i + 1]} ${t[i + 2]}`, 2));
    if (i + 3 < n && i < 12) f.push(h(`q|${t[i]} ${t[i + 1]} ${t[i + 2]} ${t[i + 3]}`, 3));
  }
  for (let i = 0; i < Math.min(3, n); i++) f.push(h(`p${i}|${t[i]}`, 6));
  if (n) f.push(h(`last|${t[n - 1]}`, 7));
  f.push(h(`len|${Math.min(Math.floor(n / 4), 12)}`, 8));
  return f;
}

const erf = (x) => { // Abramowitz-Stegun 7.1.26 is too coarse for 1e-3 parity; use a series/continued form with ~1e-7 error
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};
const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));

let STATE = null;
export function loadCpuModel(dir) {
  if (STATE && STATE.dir === dir) return STATE;
  const b = fs.readFileSync(`${dir}/model-cpu.bin`);
  if (b.toString('latin1', 0, 4) !== 'DLR1') throw new Error('learned reader: bad model file');
  const hl = b.readUInt32LE(4); const H = JSON.parse(b.toString('utf8', 8, 8 + hl)); let off = 8 + hl;
  const T = {};
  for (const s of H.sections) {
    const cnt = s.shape.reduce((a, x) => a * x, 1);
    const ctor = { int32: Int32Array, float32: Float32Array, int8: Int8Array }[s.dtype]; if (!ctor) throw new Error(`dtype ${s.dtype}`);
    const bytes = cnt * ctor.BYTES_PER_ELEMENT; const ab = new ArrayBuffer(bytes); new Uint8Array(ab).set(b.subarray(off, off + bytes)); T[s.name] = new ctor(ab); off += bytes;
  }
  const rowmap = new Int32Array(H.NB).fill(-1); T.rowids.forEach((r, i) => { rowmap[r] = i; });
  const classes = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${dir}/classes.json.gz`)).toString('utf8'));
  STATE = { dir, H, T, rowmap, classes, D: H.D };
  return STATE;
}

/** anonymized text -> { A: [class index per head], P: [probability per head], Q: [miss mass 1-p per head, precise near 1], labels: [class per head] } */
export function predict(an, M) {
  const { H, T, rowmap, D } = M; const NB = H.NB;
  const f = featurize(an, NB); const w = 1 / Math.sqrt(Math.max(f.length, 1));
  const x = new Float32Array(D);
  for (const b of f) { const r = rowmap[b]; if (r < 0) continue; const sc = T.emb_scale[r] * w; const o = r * D; for (let d = 0; d < D; d++) x[d] += T.emb_q[o + d] * sc; }
  let mu = 0; for (let d = 0; d < D; d++) mu += x[d]; mu /= D; let v = 0; for (let d = 0; d < D; d++) v += (x[d] - mu) ** 2; v /= D;
  const inv = 1 / Math.sqrt(v + 1e-5); const z0 = new Float32Array(D);
  for (let d = 0; d < D; d++) z0[d] = (x[d] - mu) * inv * T['mlp.0.weight'][d] + T['mlp.0.bias'][d];
  const lin = (inp, W, bias, nout, nin) => { const out = new Float32Array(nout); for (let o = 0; o < nout; o++) { let s = bias[o]; const base = o * nin; for (let i = 0; i < nin; i++) s += W[base + i] * inp[i]; out[o] = gelu(s); } return out; };
  const h1 = lin(z0, T['mlp.1.weight'], T['mlp.1.bias'], 512, D); const h2 = lin(h1, T['mlp.4.weight'], T['mlp.4.bias'], 512, 512);
  const A = []; const P = []; const Q = []; const labels = [];
  for (let j = 0; j < HEADS.length; j++) {
    const n = H.heads[j].n; const q = T[`h${j}_q`]; const sc = T[`h${j}_s`]; const bias = T[`h${j}_b`];
    let best = -1; let bz = -Infinity; const z = new Float32Array(n);
    for (let o = 0; o < n; o++) { let s = 0; const base = o * 512; for (let i = 0; i < 512; i++) s += q[base + i] * h2[i]; s = s * sc[o] + bias[o]; z[o] = s; if (s > bz) { bz = s; best = o; } }
    bz = z[best]; let den = 0; for (let o = 0; o < n; o++) den += Math.exp(z[o] - bz);
    A.push(best); P.push(1 / den); Q.push((den - 1) / den); labels.push(M.classes[HEADS[j]][best]);
  }
  return { A, P, Q, labels };
}

/** crc32 over bytes with a starting value (used for the trained-skeleton table) */
export function crc32buf(buf, salt) {
  let c = (salt ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** the key of a nine-part skeleton: [hi, lo] words of two crc32s over the parts joined by 0x1f (None = 0x00) */
export function skeletonKey(labels) {
  const b = Buffer.from(labels.map((x) => (x == null ? '\x00' : x)).join('\x1f'), 'utf8');
  return [crc32buf(b, 0x1234abcd), crc32buf(b, 0x9e3779b9)];
}
