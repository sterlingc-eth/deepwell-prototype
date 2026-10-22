/** doctypealias1.js - port of lib/doctypealias1.py (alias_compound_v1): rescue-only document-type resolution (plural skeletons, true edit distance, compound kind words,
 * plural-tolerant alias pairs).  Runs only when the old scoring resolved no type, so every old resolution is unchanged.  DT = { CLS, stem, dot } from doctype.js (passed in: no import cycle). */
import { osaK } from './v3util.js';

let CFG = { on: false, thr: null, margin: null, head_only: true, compound: true, alias: true };
export const configure = (d) => { d = d || {}; CFG = { on: !!d.on, thr: d.thr ?? null, margin: d.margin ?? null, head_only: !!(d.head_only ?? true), compound: !!(d.compound ?? true), alias: !!(d.alias ?? true) }; };
export const enabled = () => CFG.on;
const dl = (a, b, k) => (a === b ? 0 : osaK(a, b, k));
function st(w) {
  for (const [suf, rep] of [['ies', 'y'], ['sses', 'ss'], ['ses', 's'], ['s', '']]) if (w.endsWith(suf) && w.length > suf.length + 2) return w.slice(0, -suf.length) + rep;
  return w;
}
export function skel(w) {
  for (let i = 0; i < 3; i++) { const n = st(w); if (n === w) break; w = n; }
  if (w.length >= 3 && w.endsWith('s') && !(w.endsWith('ss') || w.endsWith('us') || w.endsWith('is'))) w = w.slice(0, -1);
  if (w.length >= 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
const COMPOUND = new Map(Object.entries({ 'job sheet': 'ticket', 'job card': 'ticket', 'job tag': 'ticket', 'work sheet': 'ticket', 'work ticket': 'ticket', 'service sheet': 'ticket', 'write up': 'report', 'payment slip': 'receipt',
  'pay slip': 'receipt', 'cash receipt': 'receipt', 'price quote': 'quote', 'price sheet': 'quote' }));
class Canon {
  constructor(vocab, CLS) {
    this.CLS = CLS; this.vocab = new Set(vocab); this.cache = new Map();
    this.sk = new Map(); for (const v of this.vocab) { const k = skel(v); if (!this.sk.has(k)) this.sk.set(k, new Set()); this.sk.get(k).add(v); }
    this.clsSk = new Map(); for (const [k, c] of CLS) { const s = skel(k); if (!this.clsSk.has(s)) this.clsSk.set(s, new Set()); this.clsSk.get(s).add(c); }
    this.clsWords = [...CLS.keys()];
  }
  tok(w) { let r = this.cache.get(w); if (r !== undefined) return r; r = this._tok(w); this.cache.set(w, r); return r; }
  _tok(w) {
    const c = this.CLS.get(w); if (c) return c;
    if (this.vocab.has(w)) return w;
    const k = skel(w);
    const cs = this.clsSk.get(k);
    if (cs && cs.size === 1) return [...cs][0];
    const vs = this.sk.get(k);
    if (vs && vs.size === 1) { const v = [...vs][0]; return this.CLS.get(v) ?? v; }
    if (w.length >= 5) {
      const kk = w.length < 9 ? 1 : 2; let best = []; let bd = kk + 1;
      for (const v of [...this.vocab, ...this.clsWords]) {
        if (Math.abs(v.length - w.length) > kk || v.length < 4) continue;
        const d = dl(w, v, kk);
        if (d < bd) { bd = d; best = [v]; } else if (d === bd && d <= kk && !best.includes(v)) best.push(v);
      }
      if (bd <= kk) { const cl = new Set(best.map((v) => this.CLS.get(v) ?? v)); if (cl.size === 1) return [...cl][0]; }
    }
    return w;
  }
}
const CANON = new WeakMap();
function collapse(toks, cn) {
  let t = [...toks];
  if (CFG.compound && t.length >= 2) { const k = COMPOUND.get(t.slice(-2).join(' ')); if (k !== undefined) t = t.slice(0, -2).concat([k]); }
  return t.map((w) => cn.tok(w));
}
function canon(ix, ti, DT) {
  let e = CANON.get(ix);
  if (!e) { const cn = new Canon(ti.vocab, DT.CLS); e = { cn, T2: new Map() }; CANON.set(ix, e); for (const t of ti.ts) e.T2.set(t, collapse(ti.toks.get(t), cn)); }
  return e;
}
const ALIAS = new WeakMap();
function aliasIndex(ix, learned, ti) {
  const ai = ALIAS.get(ix);
  if (ai && ai[0] === learned) return ai;
  const byT = new Map(); const toks = new Set();
  const tn = new Map(); for (const t of ti.ts) tn.set([...ti.toks.get(t)].sort().join(' '), t); for (const t of ti.ts) tn.set(ti.toks.get(t).join(' '), t);
  for (const key of learned.pairs.keys()) {
    const [a, b] = key.split('\u0001');
    if (tn.has(b)) {
      const t = tn.get(b); if (!byT.has(t)) byT.set(t, new Set()); byT.get(t).add(a.split(' ').map(skel).join(' '));
      for (const w of a.split(' ')) if (w.length >= 5) toks.add(skel(w));
    }
  }
  const out = [learned, byT, toks]; ALIAS.set(ix, out); return out;
}
function scorePhrase2(ix, M, phraseToks, ti, learned, cfg, pe, ctx, DT) {
  const { cn, T2 } = canon(ix, ti, DT); const { ts } = ti;
  const P = collapse(phraseToks, cn);
  const ai = CFG.alias ? aliasIndex(ix, learned, ti) : null;
  const pk = phraseToks.map(skel).join(' ');
  let pk2 = null;
  if (ai !== null) {
    const ws = [];
    for (const w of phraseToks) {
      let sw = skel(w);
      if (sw.length >= 6 && !ai[2].has(sw)) { const c = [...ai[2]].filter((a) => Math.abs(a.length - sw.length) <= 1 && dl(sw, a, 1) <= 1); if (c.length === 1) sw = c[0]; }
      ws.push(sw);
    }
    pk2 = ws.join(' ');
  }
  const out = [];
  ts.forEach((t, i) => {
    const T = T2.get(t);
    let kind = 0, alias = 0.0;
    const bt = ai !== null ? ai[1].get(t) : undefined;
    if (ai !== null && bt && (bt.has(pk) || bt.has(pk2))) { alias = 1.0; kind = 1; } else if (P.length === T.length && P.every((x, j) => x === T[j])) alias = 1.0;
    let headEq = P[P.length - 1] === T[T.length - 1];
    const last = phraseToks[phraseToks.length - 1];
    if (!headEq && learned.heads.has(last) && DT.stem(learned.heads.get(last)[0]) === T[T.length - 1]) headEq = true;
    const mP = new Set(P.slice(0, -1)), mT = new Set(T.slice(0, -1)); let ov = 0; for (const x of mP) if (mT.has(x)) ov++;
    let nm;
    if (headEq) { nm = 0.5 + 0.25 * (mP.size ? ov / mP.size : 1.0) + 0.25 * (mT.size ? ov / mT.size : 1.0); if (mP.size && ov === 0) nm = Math.min(nm, 0.5); } else { const sP = new Set(P), sT = new Set(T); let inter = 0; for (const x of sP) if (sT.has(x)) inter++; nm = 0.3 * inter / Math.max(1, P.length); }
    const cs = pe ? DT.dot(pe, ti.ev[i]) : 0.0; const em = Math.min(1.0, Math.max(0.0, (cs - 0.4) / 0.5));
    let cx = 0.0; const cset = ctx.get(t);
    if (cset && cset.size) { const mods = phraseToks.filter((w) => DT.CLS.get(w) === undefined); cx = mods.length ? mods.filter((w) => cset.has(w)).length / mods.length : 0.0; }
    const sc = alias ? alias : (1 - cfg.emb_w - cfg.ctx_w) * nm + cfg.emb_w * em + cfg.ctx_w * cx;
    out.push([sc, kind, !!alias || headEq]);
  });
  return out;
}
/** the doctype.match 'best' tuple [[passed, top, len], phrase, type, margin, kind] or null */
export function rescue(ix, g, M, cfg, learned, ph, ti, ctx, PE, DT) {
  const thr = CFG.thr !== null ? CFG.thr : cfg.thr; const mgn = CFG.margin !== null ? CFG.margin : cfg.margin;
  let best = null;
  for (let j = 0; j < ph.length; j++) {
    const p = ph[j];
    const sc = scorePhrase2(ix, M, p.map(DT.stem), ti, learned, cfg, PE ? PE[j] : null, ctx, DT);
    const o = sc.map((_, k) => k).sort((a, b) => (sc[b][0] - sc[a][0]) || (a - b));
    const top = sc[o[0]][0]; const sec = o.length > 1 ? sc[o[1]][0] : 0.0;
    if (!(top - sec >= mgn && top >= thr)) continue;
    if (CFG.head_only && !sc[o[0]][2]) continue;
    const key = [true, top, p.length];
    if (best === null || key[1] > best[0][1] || (key[1] === best[0][1] && key[2] > best[0][2])) best = [key, p, ti.ts[o[0]], top - sec, sc[o[0]][1]];
  }
  return best;
}
