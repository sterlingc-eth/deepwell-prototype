/** clause.js - port of lib/clausereader.py (version 2): hybrid retrieval shortlist + cross-encoder with a learned "no clause" outcome. */
import { words, stem, hum } from './text.js';
const pad = (s) => s;
export const passageText = (m) => (m.kind === 'line' ? m.text : `${hum(m.key)}: ${m.val}`);
const isUpper = (s) => /\p{Lu}/u.test(s) && !/\p{Ll}|\p{Lt}/u.test(s);
function isTitle(s) {   // str.istitle()
  let prevCased = false, any = false;
  for (const ch of s) {
    const up = /\p{Lu}|\p{Lt}/u.test(ch), lo = /\p{Ll}/u.test(ch);
    if (up) { if (prevCased) return false; prevCased = true; any = true; } else if (lo) { if (!prevCased) return false; prevCased = true; any = true; } else prevCased = false;
  }
  return any;
}
const WH = /\b(what|which|how|who|whom|whose|when|where|why)\b/;
const YN = /^(?:\W*(?:hey|hi|hello)\b[^,]*,\s*)?(?:is|are|does|do|did|has|have|was|were|can|will)\b/;
export function isYesno(masked) { const m = masked.toLowerCase().trim(); return YN.test(m) && !WH.test(m); }
function isHeading(s) {
  if (!s || s.length > 60 || s.endsWith('.') || s.includes('$') || s.includes(' - page ')) return false;
  const w = s.split(/\s+/).filter((x) => x);
  if (w.length > 7) return false;
  if (/^(client|customer|tenant|document no|date|total|signed|status|agent|invoice|bill to|property manager)\b/i.test(s)) return false;
  if (s.includes(':') && !s.endsWith(':')) return false;
  return isUpper(s) || s.endsWith(':') || /^(\d+[.)]|section|article|schedule|exhibit)\b/i.test(s) || isTitle(s) || (w.length <= 4 && /\p{Lu}/u.test(s[0]) && !/\d/.test(s));
}
export function docHeadings(ix, did) {
  let hd = ix._hd2; if (!hd) hd = ix._hd2 = new Map();
  if (hd.has(did)) return hd.get(did);
  const m = new Map(); let cur = '';
  for (const p of ix.c.pages.get(did) || []) for (const ln of p.text.split('\n')) { const s = ln.trim(); if (isHeading(s)) cur = s; else if (cur && !m.has(s)) m.set(s, cur); }
  hd.set(did, m); return m;
}
function bm25One(ws, cw, idf, idfDef, avg, k1 = 1.2, b = 0.75) {
  let sc = 0.0; const ln = ws.size;
  for (const w of cw) if (ws.has(w)) sc += (idf.has(w) ? idf.get(w) : idfDef) * (k1 + 1) / (1 + k1 * (1 - b + b * ln / Math.max(1.0, avg)));
  return sc;
}
const argsortDesc = (v) => Array.from(v.keys()).sort((a, b) => (v[b] - v[a]) || (a - b));      // np.argsort(-v, kind='stable')
const argmax = (v) => { let bi = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[bi]) bi = i; return bi; };
export function build2(ix, x, cands, cw, sc = null, kmax = 8) {
  const did = x.id; const hdm = docHeadings(ix, did); const n = cands.length;
  const L = ix.lines.get(did) || []; let avg = 5.0; if (L.length) { let t = 0; for (const l of L) t += l[2].size; avg = t / L.length; }
  const cws = new Set(cw); const bm = new Float64Array(n), hdov = new Float64Array(n), heads = new Array(n).fill('');
  let den = 0; for (const w of cws) den += ix.idf.has(w) ? ix.idf.get(w) : ix.idf_default; den = den || 1.0;
  let lj = 0;
  cands.forEach((m, i) => {
    if (m.kind === 'field') { const fw = new Set(words(hum(m.key)).map(stem)); bm[i] = bm25One(fw, cws, ix.idf, ix.idf_default, avg); } else {
      const ws = (lj < L.length && L[lj][1] === m.text) ? L[lj][2] : new Set(words(m.text).map(stem)); lj++;
      const h = hdm.get(m.text) || ''; heads[i] = h;
      bm[i] = bm25One(ws, cws, ix.idf, ix.idf_default, avg);
      if (h) {
        const hw = new Set(words(h).map(stem)); const diff = new Set([...cws].filter((w) => !ws.has(w)));
        const hb = bm25One(hw, diff, ix.idf, ix.idf_default, avg); bm[i] += 0.5 * hb;
        let s = 0; for (const w of cws) if (hw.has(w)) s += ix.idf.has(w) ? ix.idf.get(w) : ix.idf_default; hdov[i] = s / den;
      }
    }
  });
  const cos = cands.map((m) => m.cos), lex = cands.map((m) => m.lex);
  const rk = (v) => { const o = argsortDesc(v); const r = new Array(v.length); o.forEach((idx, pos) => { r[idx] = pos; }); return r; };
  const rb = rk(bm), rc = rk(cos), rl = rk(lex); const rrf = new Float64Array(n);
  for (let i = 0; i < n; i++) rrf[i] = 1.0 / (60 + rb[i]) + 1.0 / (60 + rc[i]) + 1.0 / (60 + rl[i]);
  const sel = argsortDesc(rrf).slice(0, kmax);
  for (const v of [bm, cos, lex, ...(sc !== null ? [sc] : [])]) { const t = argmax(v); if (!sel.includes(t)) sel.push(t); }
  let bmMax = -Infinity; for (const v of bm) if (v > bmMax) bmMax = v; const bmx = Math.max(1e-6, bmMax);
  let rmx = -Infinity; for (const v of rrf) if (v > rmx) rmx = v;
  let cmax = -Infinity; for (const v of cos) if (v > cmax) cmax = v;
  let lmax = -Infinity; for (const v of lex) if (v > lmax) lmax = v;
  const f = sel.map((i) => [bm[i] / bmx, cos[i] - cmax, lex[i], rrf[i] / rmx, cands[i].kind === 'field' ? 1.0 : 0.0, hdov[i]]);
  const ps = sel.map((i) => (heads[i] ? `${heads[i]} | ` : '') + passageText(cands[i]));
  let cov = 0.0; for (let i = 0; i < n; i++) { const v = lex[i] + hdov[i]; if (i === 0 || v > cov) cov = v; }
  const nv = [cmax, lmax, Math.min(1.0, cov), Math.min(1.0, bmMax / (den * 2.2))];
  const picks = { bm25: argmax(bm), cos: argmax(cos), lex: argmax(lex), rrf: argmax(rrf), rank: sc !== null ? argmax(sc) : -1 };
  return { sel, ps, f, nv, picks, rrf, hdov, n, cov, lex };
}
export function v2Features(zz, info, masked, cal = null) {
  const K = zz.length - 1; const z = zz.slice(0, K); let zmax = -Infinity; for (const v of zz) if (v > zmax) zmax = v;
  let p = zz.map((v) => Math.exp(v - zmax)); const ps = p.reduce((a, b) => a + b, 0); p = p.map((v) => v / ps);
  const o = Array.from(z.keys()).sort((a, b) => (z[b] - z[a]) || (a - b)); const b0 = o[0]; const best = info.sel[b0];
  const margin = z[b0] - (K > 1 ? z[o[1]] : -10.0); const pn = p[K]; const ptop = p[b0];
  const pk = info.picks; const ag = [+(best === pk.bm25), +(best === pk.cos), +(best === pk.lex)];
  const rrf = Array.from(info.rrf).sort((a, b) => b - a);
  const F = {
    cr2_on: 1, cr2_p: ptop, cr2_margin: margin, cr2_pnull: pn, cr2_nullgap: z[b0] - zz[K], cr2_agree_bm25: ag[0], cr2_agree_cos: ag[1], cr2_agree_lex: ag[2],
    cr2_agree_rank: pk.rank >= 0 ? +(best === pk.rank) : -1, cr2_nagree: ag[0] + ag[1] + ag[2] + (pk.rank >= 0 ? +(best === pk.rank) : 0),
    cr2_rrfgap: rrf.length > 1 ? (rrf[0] - rrf[1]) / Math.max(1e-9, rrf[0]) : 1.0, cr2_hd: info.hdov[best], cr2_cov: info.cov, cr2_yn: +isYesno(masked), cr2_nc: K,
    cr2_verb: info.lex[best], cr2_verbhd: Math.min(1.0, info.lex[best] + info.hdov[best]),
  };
  const xx = [zz[b0], margin, ptop, pn, ag[0] + ag[1] + ag[2], info.cov];
  if (cal) { let d = 0; for (let i = 0; i < xx.length; i++) d += cal.w[i] * xx[i]; F.cr2_cal = 1 / (1 + Math.exp(-(d + cal.b))); } else F.cr2_cal = ptop;
  return [best, F];
}
export class Reader2 {
  constructor(enc, cfg) { this.enc = enc; this.cfg = cfg; this.cal = cfg.cal || null; this.hw = Float64Array.from(cfg.head_w); this.hb = cfg.head_b; this.nw = Float64Array.from(cfg.null_w); this.nb = cfg.null_b; }
  async logits(q, info) {
    const E = await this.enc.pooled(q, info.ps); const K = info.ps.length; const zz = new Array(K + 1);
    for (let r = 0; r < K; r++) { let s = this.hb; const e = E[r]; for (let i = 0; i < 384; i++) s += e[i] * this.hw[i]; const f = info.f[r]; for (let i = 0; i < f.length; i++) s += f[i] * this.hw[384 + i]; zz[r] = Math.fround(s); }
    let sn = this.nb; for (let i = 0; i < 4; i++) sn += info.nv[i] * this.nw[i]; zz[K] = Math.fround(sn); return zz;
  }
  async read(ix, x, g, cands, cw, sc) {
    if (!cands.length || !cw.length) return [null, {}];
    const info = build2(ix, x, cands, cw, sc, parseInt(this.cfg.kmax ?? 8, 10)); const zz = await this.logits(g.masked, info);
    const [best, F] = v2Features(zz, info, g.masked, this.cal);
    if ((this.cfg.absent ?? true) && F.cr2_pnull >= parseFloat(this.cfg.absent_thr ?? 0.8) && F.cr2_pnull > F.cr2_p) return [-1, F];
    return [best, F];
  }
}
