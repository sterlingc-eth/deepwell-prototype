/** xdocv1.js - port of lib/xdocv1.py (xdoc_v1): deterministic cross-document diff / compare over the company's own records. */
import { ratio } from './difflib.js';
import { reEscape, fmtNum, cap } from './pyc.js';

const DEF = { on: false, typo: true };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const CONCEPTS = [
  [['appraisal', 'appraised value', 'appraisal figure', 'appraisal report', 'appraisal value', 'appraised price', 'appraisal number', 'appraised amount', 'appraisal price', 'appraiser s number', 'appraiser s value', 'appraiser s figure', 'appraised figure', 'property appraisal', 'appraised value report'], /apprais/],
  [['contract price', 'sales price', 'sale price', 'purchase price', 'purchase contract', 'sales contract', 'sale contract', 'purchase agreement', 'contract', 'purchase and sale', 'psa', 'contract amount', 'sales contract price', 'sale agreement', 'sales agreement', 'buy sell agreement', 'buy sell contract', 'buy sell', 'sale agmt', 'sales agmt', 'purchase agmt', 'sale contrac', 'purchase and sales agreement', 'purchase offer'], /^(purchase|sale|sales|buy)[a-z-]*(contract|agreement)|^contract$|^(purchase|sale|sales)-and-sale/],
  [['list price', 'asking price', 'listing price', 'listed price', 'mls price', 'mls', 'mls sheet', 'listing sheet', 'listing data sheet', 'list amount', 'listing data', 'mls number', 'mls value', 'mls figure', 'listing sheet price'], /listing-?data|mls|listing-?sheet|data-?sheet/],
  [['cma', 'cma price', 'cma number', 'cma figure', 'comp analysis', 'comp sheet', 'market analysis', 'comparative market analysis', 'cma report', 'suggested list price', 'comps', 'cma value', 'comp value', 'comps number', 'market comparison sheet', 'market comparison', 'comparison sheet', 'comp analysis report', 'cma sheet'], /market-?analysis|cma|comp-?sheet/],
  [['counter', 'counter offer', 'counteroffer', 'counter price', 'counter number', 'counter figure', 'counter proposal', 'seller counter', 'seller counter proposal', 'counter value', 'counter amount'], /counter/],
];
const STREET_SFX = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'way', 'blvd', 'boulevard', 'pl', 'place', 'cir', 'circle', 'ter', 'terrace', 'trl', 'trail', 'pkwy', 'hwy', 'loop', 'row', 'sq', 'path', 'run', 'walk']);
const ADDR = /^\s*(\d{1,6})\s+([A-Za-z][A-Za-z0-9.' -]{1,40}?)\s*(?:,.*)?$/;
const pySplit = (s) => { const t = s.trim(); return t ? t.split(/\s+/) : []; };
const norm = (s) => (s || '').toLowerCase().split("'s ").join(' ').split('’').join("'").replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function props(ix) {
  if (ix._xd_props) return ix._xd_props;
  const c = new Map();
  for (const x of ix.D.values()) {
    for (const [, v] of x.fields) {
      if (typeof v !== 'string') continue;
      if (!ADDR.test(v)) continue;
      const toks = pySplit(norm(v));
      if (toks.length < 2 || (!STREET_SFX.has(toks[toks.length - 1]) && toks.length < 3)) continue;
      if (!STREET_SFX.has(toks[toks.length - 1])) continue;
      const a = toks.join(' ');
      if (!c.has(a)) c.set(a, new Map());
      const m = c.get(a); if (!m.has(x.type)) m.set(x.type, new Map());
      m.get(x.type).set(x.id, x);
      break;
    }
  }
  ix._xd_props = c; return c;
}
function findProp(ql, ix, typo = true) {
  const P = props(ix); const qw = pySplit(ql); const qs = ' ' + ql + ' ';
  const full = [...P.keys()].filter((a) => qs.includes(' ' + a + ' '));
  if (full.length) {
    const fs = full.map((v, i) => [v, i]).sort((x, y) => (y[0].length - x[0].length) || (x[1] - y[1])).map((z) => z[0]);
    if (fs.length === 1 || fs.every((a) => a === fs[0] || fs[0].includes(a) || a.includes(fs[0]))) return [fs[0], fs[0]];
    return [null, ''];
  }
  const short = [...P.keys()].filter((a) => qs.includes(' ' + a.split(' ').slice(0, -1).join(' ') + ' '));
  if (short.length === 1) return [short[0], short[0].split(' ').slice(0, -1).join(' ')];
  if (short.length) return [null, ''];
  if (!typo) return [null, ''];
  const best = [];
  for (const a of P.keys()) {
    const at = a.split(' '); const num = at[0]; const name = at.slice(1, -1);
    if (!qw.includes(num)) continue;
    const i = qw.indexOf(num); const seg = qw.slice(i + 1, i + 1 + name.length);
    if (seg.length !== name.length || !name.length) continue;
    let ok = true;
    for (let j = 0; j < name.length; j++) {
      const w = name[j], v = seg[j];
      if (w === v) continue;
      if (w.length >= 5 && ratio(w, v) >= 0.85 && Math.abs(w.length - v.length) <= 1 && w[0] === v[0]) continue;
      ok = false; break;
    }
    if (ok) best.push(a);
  }
  if (best.length === 1) { const at = best[0].split(' '); const i = qw.indexOf(at[0]); return [best[0], qw.slice(i, i + at.length - 1).join(' ')]; }
  return [null, ''];
}
function phrases(ix) {
  if (ix._xd_ph) return ix._xd_ph;
  const ph = new Map();
  const add = (p, t) => { if (!ph.has(p)) ph.set(p, new Set()); ph.get(p).add(t); };
  const types = [...ix.by_t.keys()];
  for (const t of types) {
    const h = norm(t.split('-').join(' ').split('_').join(' ')); add(h, t); add(h + 's', t);
    const ws = h.split(' ').filter((z) => z);
    if (ws.length >= 2 && ['form', 'sheet', 'report', 'document', 'record', 'notice'].includes(ws[ws.length - 1])) add(ws.slice(0, -1).join(' '), t);
  }
  for (const [phrs, rx] of CONCEPTS) {
    const ts = types.filter((t) => rx.test(t.toLowerCase()));
    if (ts.length !== 1) continue;
    for (const p of phrs) add(p, ts[0]);
  }
  ix._xd_ph = ph; return ph;
}
function spans(ql, ph) {
  const taken = []; const out = [];
  const keys = [...ph.keys()].sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
  for (const p of keys) {
    for (const m of ql.matchAll(new RegExp('(?<![a-z0-9])' + reEscape(p) + '(?![a-z0-9])', 'g'))) {
      const s = m.index, e = m.index + m[0].length;
      if (taken.some(([a, b]) => !(e <= a || s >= b))) continue;
      taken.push([s, e]); out.push([s, e, p, ph.get(p)]);
    }
  }
  out.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  return out;
}
const DIFF = /\b(gap|difference|differ|differs|differing|differential|spread|apart|delta|variance|how much (?:higher|lower|more|less|bigger|larger|greater|smaller|cheaper|over|under|above|below)|by how much|how far (?:apart|off)|off by)\b/;
const LT = /\b(under|below|beneath|lower than|less than|smaller than|cheaper than|short of)\b/;
const GT = /\b(over|above|exceeds?|higher than|more than|greater than|bigger than|larger than)\b/;
const NEG = /\b(not|isn t|wasn t|didn t|doesn t|don t|aren t|weren t|never|n t)\b/;
const HL = /how much (higher|lower|more|less|bigger|larger|greater|smaller|over|under|above|below)/;
const CUEW = ['higher', 'lower', 'under', 'below', 'above', 'exceeds', 'differ', 'difference', 'spread', 'apart', 'between', 'beneath', 'greater', 'smaller', 'larger', 'bigger', 'cheaper'];
export function osa(a, b, mx = 2) {
  if (Math.abs(a.length - b.length) > mx) return mx + 1;
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function targetsOf(ph) {
  const ws = new Set(CUEW);
  for (const p of ph.keys()) for (const w of p.split(' ')) if (w.length >= 5) ws.add(w);
  return ws;
}
function fixTokens(tokens, ix, targets) {
  const voc = ix.vocab; const out = []; let i = 0;
  const best = (t) => {
    if (t.length < 4 || voc.has(t) || targets.has(t) || /^\d+$/.test(t)) return null;
    const c = [];
    for (const w of targets) {
      const k = w.length < 8 ? 1 : 2;
      if (Math.abs(w.length - t.length) > k || (t[0] !== w[0] && !(w.length >= 8))) continue;
      const dd = osa(t, w, k);
      if (dd <= k) c.push([dd, w]);
    }
    if (!c.length) return null;
    c.sort((x, y) => (x[0] - y[0]) || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    if (c.length > 1 && c[0][0] === c[1][0]) return null;
    return c[0][1];
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (i + 1 < tokens.length && !(voc.has(t) && voc.has(tokens[i + 1])) && !/^\d+$/.test(t) && !/^\d+$/.test(tokens[i + 1])) {
      const m = t + tokens[i + 1];
      if (targets.has(m) || (m.length >= 7 && best(m))) { out.push(targets.has(m) ? m : best(m)); i += 2; continue; }
    }
    const b = best(t); out.push(b || t); i += 1;
  }
  return out;
}
const money = (v) => (Math.abs(v - Math.round(v)) > 1e-9 ? '$' + fmtNum(v, 2) : '$' + fmtNum(Math.round(v), 0));
export function solve(ix, q, g, no, ok, hum, citeFn) {
  const ql = norm(q);
  if (!ql) return null;
  const [pa, ptxt] = findProp(ql, ix, CFG.typo !== false);
  if (!pa) return null;
  const ph = phrases(ix);
  let toks = pySplit(ql.split(ptxt).join(' ').replace(/\bm l s\b/g, 'mls').replace(/\bc m a\b/g, 'cma'));
  toks = fixTokens(toks, ix, targetsOf(ph)); const qr = toks.join(' ');
  let sp = spans(qr, ph);
  const P = props(ix).get(pa);
  const moneyish = (t) => [...(P.get(t) || new Map()).values()].some((x) => x.tot !== null);
  const first = (s) => s.values().next().value;
  const keep = sp.length > 2 ? sp.filter((s_) => !(s_[3].size === 1 && !moneyish(first(s_[3])))) : sp;
  if (keep.length !== 2) return null;
  sp = keep;
  if (sp.some((s_) => s_[3].size !== 1)) return null;
  const ta = first(sp[0][3]), tb = first(sp[1][3]);
  if (ta === tb) return null;
  const lo = Math.max(0, sp[0][0] - 32); const hi0 = sp[1][1] + 28; const win = qr.slice(lo, hi0);
  const diff = DIFF.test(win), lt = LT.test(win), gt = GT.test(win);
  if (!(diff || lt || gt)) return null;
  if (NEG.test(win)) return null;
  if (diff) { if (lt && gt && !HL.test(win)) return null; } else if (lt === gt) return null;
  const da = P.get(ta) || new Map(), db = P.get(tb) || new Map();
  if (da.size !== 1 || db.size !== 1) return null;
  const A = first(da), B = first(db);
  if (A.tot === null || B.tot === null) return null;
  const a = Number(A.tot), b = Number(B.tot);
  const na = cap(hum(ta)), nb = cap(hum(tb)); const ca = citeFn(A), cb = citeFn(B);
  if (diff) {
    const m = HL.exec(win); const d = Math.abs(a - b); const dirw = a > b ? 'higher' : 'lower';
    if (m) { const hi = ['higher', 'more', 'bigger', 'larger', 'greater', 'over', 'above'].includes(m[1]); if (a !== b && hi !== (a > b)) return null; }
    const txt = a === b ? `No difference: the ${na} is ${money(a)} (${ca}) and the ${nb} is ${money(b)} (${cb}).` : `The ${na} is ${money(a)} (${ca}) and the ${nb} is ${money(b)} (${cb}). Difference: ${money(d)}, the ${na} is ${dirw}.`;
    return ok(txt, [A.id, B.id], 'xdoc');
  }
  const yes = lt ? a < b : a > b; const rel = a < b ? 'below' : (a > b ? 'above' : 'equal to');
  return ok(`${yes ? 'Yes' : 'No'}. The ${na} is ${money(a)} (${ca}) and the ${nb} is ${money(b)} (${cb}): the ${na} is ${rel} the ${nb}.`, [A.id, B.id], 'xdoc');
}
