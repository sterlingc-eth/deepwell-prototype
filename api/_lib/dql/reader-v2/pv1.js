/** pv1.js - port of lib/pv1.py + lib/pv1feat.py (present_value_v1): intent-consistency between the question form and the answer form (stricter-only veto modes). */
import { crc32 } from './pyx.js';

const DEF = { on: false, modes: ['veto', 'veto_sub'], tau_route: 0.7, tau_veto: 0.8 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; CACHE.clear(); };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
// ---- model: logistic regression on hashed word 1-2 grams + char 3-5 grams (float32 weights, evaluated with float32 arithmetic like the reference under NumPy 2)
const NF = 1 << 17;
let W = null; let B = 0;
const CACHE = new Map();
export const setData = (w, b) => { W = w; B = Math.fround(b); CACHE.clear(); };
const R1 = /\b[a-z]{1,3}-\d{3,5}\b/g, R2 = /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g, R3 = /\d+/g, WR = /[a-z']+/g;
const norm = (q) => q.toLowerCase().replace(R1, ' REF ').replace(R2, ' DATE ').replace(R3, ' N ');
export function feats(q0) {
  const ws = norm(q0).match(WR) || []; const d = new Map();
  const add = (s, off) => { const h = crc32(s) % NF; const k = h * 2 + off; d.set(k, (d.get(k) || 0) + 1); };
  for (const w of ws) add('w ' + w, 0);
  for (let i = 0; i + 1 < ws.length; i++) add('b ' + ws[i] + ' ' + ws[i + 1], 0);
  for (const w of ws) {
    const t = ' ' + w + ' ';
    for (const n of [3, 4, 5]) for (let i = 0; i < t.length - n + 1; i++) add('c ' + t.slice(i, i + n), 1);
  }
  const out = [];
  for (const blk of [0, 1]) {
    const items = []; for (const [k, v] of d) if ((k & 1) === blk) items.push([k >> 1, v]);
    let s = 0; for (const [, v] of items) s += v * v;
    const nrm = Math.sqrt(s) || 1.0;
    for (const [h, v] of items) out.push([blk * NF + h, v / nrm]);
  }
  return out;
}
export function score(q) {
  const f = feats(q); const fr = Math.fround;
  let acc = 0; let first = true;
  for (const [i, v] of f) { const t = fr(W[i] * fr(v)); acc = first ? t : fr(acc + t); first = false; }
  if (first) return 1.0 / (1.0 + Math.exp(-B));
  const z = fr(B + acc);
  const e = fr(Math.exp(fr(-z)));
  return fr(1.0 / fr(1.0 + e));
}
export function pClause(q) {
  if (CACHE.has(q)) return CACHE.get(q);
  const v = score(q);
  if (CACHE.size > 20000) CACHE.clear();
  CACHE.set(q, v); return v;
}
const FA = /^([A-Z][A-Za-z #/&'-]{1,40}): (.+?) \((?!page )/;
const DR = /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\s*-\s*\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/;
const NT = /(?<![\w.])\$?\d[\d,]*(?:\.\d+)?/g;
const stems = (t) => new Set((t.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4).map((w) => w.slice(0, 4)));
const numSet = (t) => new Set((t.match(NT) || []).map((x) => x.split('$').join('').split(',').join('').replace(/\.+$/, '')));
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
const hasInter = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
export function veto(q, c, ix = null) {
  const modes = CFG.modes; const t = c.text || '';
  if (c._rk_direct || !['text', 'field', 'clause', 'total', 'date', 'party'].includes(c.intent) || !t || t.startsWith('Not on file') || /\(page \d+,/.test(t)) return null;
  try {
    if (modes.includes('veto') && ['total', 'date', 'party'].includes(c.intent) && pClause(q) >= Number(CFG.tau_veto)) return 'pv1:docvalue';
    const m = FA.exec(t);
    if (!m) return null;
    const key = m[1], val = m[2].trim();
    if (modes.includes('veto') && DR.test(val) && pClause(q) >= Number(CFG.tau_veto)) return 'pv1:range';
    if (modes.includes('veto_sub') && ix !== null && pClause(q) >= Number(CFG.tau_route)) {
      const vn = numSet(val);
      if (vn.size !== 1) return null;
      const kst = stems(key); const did = (c.docs && c.docs.length ? c.docs[0] : null);
      for (const [, ln] of (ix.lines.get(did) || [])) {
        const ns = numSet(ln);
        if (subset(vn, ns) && [...ns].some((x) => !vn.has(x)) && (hasInter(stems(ln), kst) || !(Object.prototype.hasOwnProperty.call(CFG, 'sub_topic') ? CFG.sub_topic : true))) return 'pv1:sub';
      }
    }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
