/** entmatch.js - port of lib/entmatch.py (misspelled customer names / street addresses resolved against the company's own entity list). */
import { osa, GENERIC, st as extSt } from './ext.js';
import { STOP } from './text.js';

const DEFAULT = { on: false, thr: 0.82, margin: 0.04, addr: true, addr_thr: 0.74, phonetic: true, max_dist: 3 };
let CFG = { ...DEFAULT };
export const configure = (d) => { CFG = { ...DEFAULT }; if (d) for (const k of Object.keys(DEFAULT)) if (k in d) CFG[k] = d[k]; };
export const enabled = () => !!CFG.on;
const V = 'aeiou';
const asciiLower = (w) => w.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^a-z]/g, '');
export function metaphone(w0, alt = false) {
  let w = asciiLower(w0);
  if (!w) return '';
  if (['ae', 'gn', 'kn', 'pn', 'wr'].includes(w.slice(0, 2))) w = w.slice(1);
  else if (w[0] === 'x') w = 's' + w.slice(1);
  else if (w.slice(0, 2) === 'wh') w = 'w' + w.slice(2);
  const out = []; const n = w.length; let i = 0;
  if (alt && w[0] === 'j' && w.length > 1 && V.includes(w[1])) { out.push('H'); i = 1; }
  const isV = (x) => x !== '' && V.includes(x);
  while (i < n) {
    const c = w[i]; const p = i ? w[i - 1] : ''; const x = i + 1 < n ? w[i + 1] : ''; const x2 = i + 2 < n ? w[i + 2] : '';
    if (c === p && c !== 'c') { i += 1; continue; }
    if (V.includes(c)) { if (i === 0) out.push(c.toUpperCase()); }
    else if (c === 'b') { if (!(p === 'm' && i === n - 1)) out.push('B'); }
    else if (c === 'c') {
      if (x === 'i' && x2 === 'a') out.push('X');
      else if (x === 'h') { out.push((alt || (i && p === 's')) ? 'K' : 'X'); i += 1; }
      else if (['i', 'e', 'y'].includes(x)) { if (p !== 's') out.push('S'); }
      else out.push('K');
    } else if (c === 'd') {
      if (x === 'g' && ['i', 'e', 'y'].includes(x2)) { out.push('J'); i += 2; }
      else if (x !== 't') out.push('T');
    } else if (c === 'g') {
      if (x === 'h' && !isV(x2)) i += 1;
      else if (x === 'n' && (i + 2 >= n || (x2 === 'e' && i + 4 >= n))) { /* silent */ }
      else if (['i', 'e', 'y'].includes(x) && p !== 'g') out.push('J');
      else out.push('K');
    } else if (c === 'h') { if (isV(x) && !['c', 'g', 'p', 's', 't'].includes(p)) out.push('H'); }
    else if (c === 'k') { if (p !== 'c') out.push('K'); }
    else if (c === 'p') out.push(x === 'h' ? 'F' : 'P');
    else if (c === 'q') out.push('K');
    else if (c === 's') {
      if (x === 'h') { out.push('X'); i += 1; }
      else if (x === 'i' && ['o', 'a'].includes(x2)) out.push('X');
      else out.push('S');
    } else if (c === 't') {
      if (x === 'i' && ['o', 'a'].includes(x2)) out.push('X');
      else if (x === 'h') { out.push('0'); i += 1; }
      else if (!(x === 'c' && x2 === 'h')) out.push('T');
    } else if (c === 'v') out.push('F');
    else if (c === 'w' || c === 'y') { if (isV(x)) out.push(c.toUpperCase()); }
    else if (c === 'x') out.push('KS');
    else if (c === 'z') out.push('S');
    else out.push(c.toUpperCase());
    i += 1;
  }
  return out.join('');
}
export const pkeys = (w) => { const s = new Set(); for (const k of [metaphone(w), metaphone(w, true)]) if (k.length >= 2) s.add(k); return s; };
function dels(w, d) {
  const out = new Set([w]); let cur = new Set([w]);
  for (let r = 0; r < d; r++) { const nxt = new Set(); for (const x of cur) for (let i = 0; i < x.length; i++) nxt.add(x.slice(0, i) + x.slice(i + 1)); for (const y of nxt) out.add(y); cur = nxt; }
  return out;
}
const dn = (w) => (w.length <= 5 ? 1 : 2);
function tris(w) { const s = `  ${w} `; const r = new Set(); for (let i = 0; i < s.length - 2; i++) r.add(s.slice(i, i + 3)); return r; }
function dice(a, b) { if (!a.size || !b.size) return 0.0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return 2.0 * inter / (a.size + b.size); }
function distCap(a, b) { const m = Math.max(a.length, b.length); return m <= 5 ? 1 : (m <= 9 ? 2 : CFG.max_dist); }
const intersects = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
export function tokSim(a, b, ka = null, kb = null) {
  if (a === b) return 1.0;
  const la = a.length, lb = b.length;
  if (Math.min(la, lb) <= 2) return 0.0;
  const cap = distCap(a, b); const d = osa(a, b, cap + 1);
  const ph = !!(CFG.phonetic && intersects(ka !== null ? ka : pkeys(a), kb !== null ? kb : pkeys(b)));
  if (d > cap + 1 || (d > cap && !ph)) return 0.0;
  const m = Math.max(la, lb); const es = 1.0 - d / m; const tri = dice(tris(a), tris(b));
  let s = 0.85 * es + 0.10 * tri + 0.05 * (ph ? 1.0 : 0.0);
  if (a[0] !== b[0] && !ph) s *= 0.9;
  if (d > cap) s *= 0.8;
  return s;
}
const SUFFIX = { street: 'st', str: 'st', avenue: 'ave', av: 'ave', aven: 'ave', road: 'rd', drive: 'dr', drv: 'dr', lane: 'ln', boulevard: 'blvd', blv: 'blvd', court: 'ct', place: 'pl', parkway: 'pkwy', pky: 'pkwy', highway: 'hwy', circle: 'cir', terrace: 'ter', trail: 'trl', square: 'sq', way: 'way', loop: 'loop', pike: 'pike', alley: 'aly' };
const SUFFIX_VALUES = new Set(Object.values(SUFFIX));
const isSuffixWord = (w) => Object.prototype.hasOwnProperty.call(SUFFIX, w) || SUFFIX_VALUES.has(w);
const DIRS = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
const dirOf = (w) => (Object.prototype.hasOwnProperty.call(DIRS, w) ? DIRS[w] : w);
const DIRSET = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
function atoks(s) {
  s = s.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  s = s.replace(/(?<=[a-z])'s\b/g, ''); s = s.split('#').join(' # ');
  return s.match(/[a-z0-9#]+/g) || [];
}
export function normStreet(s) {
  const head = s.toLowerCase().split(/,|\b(?:suite|ste|apt|apartment|unit|bldg|building|floor|room)\b|#/)[0];
  const t = atoks(head);
  if (!t.length || !/^\d+$/.test(t[0])) return null;
  const num = t[0]; let rest = t.slice(1).map(dirOf); let suf = '';
  if (rest.length && isSuffixWord(rest[rest.length - 1])) { const l = rest[rest.length - 1]; suf = Object.prototype.hasOwnProperty.call(SUFFIX, l) ? SUFFIX[l] : l; rest = rest.slice(0, -1); }
  let d = '';
  if (rest.length && DIRSET.has(rest[0])) { d = rest[0]; rest = rest.slice(1); }
  if (rest.length && DIRSET.has(rest[rest.length - 1]) && !d) { d = rest[rest.length - 1]; rest = rest.slice(0, -1); }
  return [num, d, rest, suf];
}
class EntIdx {
  constructor(ix) {
    this.names = []; this.bycount = new Map(); this.inv = new Map();
    const addInv = (g, i) => { let s = this.inv.get(g); if (!s) this.inv.set(g, (s = new Set())); s.add(i); };
    for (const key of ix.name2ents.keys()) {
      const toks = key.replace(/'/g, '').match(/[a-z]+/g) || [];
      if (!toks.length || key.length < 5) continue;
      const i = this.names.length; const pk = toks.map(pkeys); this.names.push([key, toks, pk, toks.join('')]);
      if (!this.bycount.has(toks.length)) this.bycount.set(toks.length, []); this.bycount.get(toks.length).push(i);
      toks.forEach((t, z) => { if (t.length >= 3) { for (const g of dels(t, dn(t))) addInv(g, i); for (const q of pk[z]) addInv('~' + q, i); } });
      if (toks.length > 1) for (const g of dels(toks.join(''), 2)) addInv(g, i);
    }
    this.addr = new Map();
    for (const a of ix.addr2ents.keys()) {
      const ns = normStreet(a);
      if (ns) { if (!this.addr.has(ns[0])) this.addr.set(ns[0], []); this.addr.get(ns[0]).push([a, ns[1], ns[2], ns[3], a.split(',')[0].trim()]); }
    }
  }
}
const eidx = (ix) => (ix._em || (ix._em = new EntIdx(ix)));
let STOPW = null;
const stopw = () => (STOPW || (STOPW = new Set([...GENERIC, ...STOP])));
function scoreName(wt, wk, nm) {
  const [, toks, pk, joined] = nm;
  if (wt.length !== toks.length) {
    if (wt.length === 1 && toks.length > 1) { const s = tokSim(wt[0], joined, wk[0], null); return s > 0 ? [s * 0.97, osa(wt[0], joined, 3)] : null; }
    return null;
  }
  let tot = 0.0, dist = 0, wsum = 0;
  for (let z = 0; z < wt.length; z++) {
    const a = wt[z], b = toks[z]; const s = tokSim(a, b, wk[z], pk[z]);
    if (s <= 0.0) return null;
    if (a !== b) dist += osa(a, b, 4);
    const w_ = Math.max(a.length, b.length); tot += s * w_; wsum += w_;
  }
  if (dist > CFG.max_dist) return null;
  return [tot / wsum, dist];
}
const isAlphaWord = (w) => /^\p{L}+$/u.test(w);
function pyStripChars(s, chars) { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); }
export function resolveName(ix, q, taken) {
  const E = eidx(ix);
  const toks = [...q.matchAll(/[A-Za-z][A-Za-z'.-]*/g)].map((m) => [m.index, m.index + m[0].length, m[0]]);
  if (!toks.length || !E.names.length) return null;
  const known = ix.vocab; const stop = stopw(); const found = new Map();
  const Ls = [...E.bycount.keys()].sort((a, b) => a - b).concat([1]);
  for (const L of Ls) {
    for (let i = 0; i <= toks.length - L; i++) {
      const win = toks.slice(i, i + L); const s0 = win[0][0], en = win[win.length - 1][1];
      if (taken.some(([a, b]) => !(en <= a || s0 >= b))) continue;
      const wt = win.map((w) => pyStripChars(w[2].toLowerCase(), ".'-").replace(/'s$/, ''));
      if (wt.some((w) => !isAlphaWord(w)) || [wt[0], wt[wt.length - 1]].some((w) => stop.has(w))) continue;
      if (wt.every((w) => known.has(w) || known.has(extSt(w)))) continue;
      if (L === 1 && wt[0].length < 8) continue;
      const wk = wt.map(pkeys); const cand = new Set();
      wt.forEach((w, z) => {
        if (w.length >= 3) {
          for (const g of dels(w, dn(w))) { const s = E.inv.get(g); if (s) for (const v of s) cand.add(v); }
          for (const qk of wk[z]) { const s = E.inv.get('~' + qk); if (s) for (const v of s) cand.add(v); }
        }
      });
      for (const ni of [...cand].sort((a, b) => a - b)) {
        const r = scoreName(wt, wk, E.names[ni]); if (r === null) continue;
        const [sc, dist] = r; const key = E.names[ni][0];
        const f = found.get(key);
        if (!f || sc > f[0] || (sc === f[0] && (en - s0) > (f[2][1] - f[2][0]))) found.set(key, [sc, dist, [s0, en]]);
      }
    }
  }
  if (!found.size) return null;
  const rk = [...found.entries()].map((e, i) => [e, i]).sort((a, b) => (b[0][1][0] - a[0][1][0]) || (a[1] - b[1])).map((z) => z[0]);
  const [k1, [s1, d1, sp1]] = rk[0];
  if (s1 < CFG.thr) return null;
  let s2 = 0.0;
  for (const [, [sc2, , sp2]] of rk.slice(1)) { if (!(sp2[1] <= sp1[0] || sp2[0] >= sp1[1]) && sc2 >= CFG.thr - 0.12) { s2 = sc2; break; } }
  const margin = s1 - s2;
  if (s2 && margin < CFG.margin) return { ambiguous: true, conf: s1, margin, kind: 2 };
  return { span: sp1, key: k1, dist: d1, conf: s1, margin: s2 ? margin : Math.min(1.0, s1), kind: 2 };
}
function scoreStreet(ns, d0, name0, suf0) {
  let [, d, name, suf] = ns;
  if (!name.length || !name0.length) return null;
  if (name.length !== name0.length) {
    if (name.length === 1 && name0.length === 1) { /* ok */ }
    else if (name.join('') && name0.join('') && tokSim(name.join(''), name0.join('')) >= 0.85) { name = [name.join('')]; name0 = [name0.join('')]; }
    else return null;
  }
  let tot = 0.0;
  for (let z = 0; z < Math.min(name.length, name0.length); z++) { const a = name[z], b = name0[z]; const s = a !== b ? tokSim(a, b) : 1.0; if (s <= 0.0) return null; tot += s; }
  let sc = tot / name0.length;
  if (d0 && d !== d0) sc -= !d ? 0.12 : 0.25;
  if (!d0 && d) sc -= 0.2;
  if (suf0 && suf !== suf0) sc -= !suf ? 0.10 : (tokSim(suf, suf0) > 0 ? 0.05 : 0.30);
  return Math.max(0.0, Math.min(1.0, sc));
}
export function resolveAddr(ix, q, taken) {
  const E = eidx(ix);
  if (!E.addr.size) return null;
  const per = new Map();
  for (const m of q.matchAll(/\b(\d{1,6})\b/g)) {
    const num = m[1]; if (!E.addr.has(num)) continue;
    const s0 = m.index;
    if (taken.some(([a, b]) => !(s0 + 1 <= a || s0 >= b))) continue;
    const tail = q.slice(s0); const tk = [...tail.matchAll(/[A-Za-z0-9#.'-]+|,/g)].map((mm) => [mm.index, mm.index + mm[0].length, mm[0]]).slice(0, 15);
    for (const ent of E.addr.get(num)) {
      const [full, d0, name0, suf0] = ent;
      for (let k = 2; k <= tk.length; k++) {
        if (tk[k - 1][2] === ',') break;
        const nxt = k < tk.length ? pyStripChars(tk[k][2].toLowerCase(), '.') : '';
        if (isSuffixWord(nxt)) continue;
        const sub = tail.slice(0, tk[k - 1][1]); const ns = normStreet(sub);
        if (!ns || ns[0] !== num || !ns[2].length) continue;
        const sc = scoreStreet(ns, d0, name0, suf0);
        if (sc === null) continue;
        const cur = per.get(full);
        if (!cur || sc > cur[0] || (sc === cur[0] && tk[k - 1][1] > cur[1][1] - s0)) per.set(full, [sc, [s0, s0 + tk[k - 1][1]]]);
      }
    }
  }
  if (!per.size) return null;
  const rk = [...per.entries()].map((e, i) => [e, i]).sort((a, b) => (b[0][1][0] - a[0][1][0]) || (a[1] - b[1])).map((z) => z[0]);
  const [k1, [s1, sp1]] = rk[0];
  if (s1 < CFG.addr_thr) return null;
  const s2 = rk.length > 1 ? rk[1][1][0] : 0.0;
  if (s2 >= CFG.addr_thr - 0.05 && s1 - s2 < CFG.margin) return { ambiguous: true, conf: s1, margin: s1 - s2, kind: 3 };
  const ft = atoks(k1).map((w) => (Object.prototype.hasOwnProperty.call(DIRS, w) ? DIRS[w] : (Object.prototype.hasOwnProperty.call(SUFFIX, w) ? SUFFIX[w] : w)));
  const tail = q.slice(sp1[0]); let bestSp = sp1;
  for (const mm of tail.matchAll(/[A-Za-z0-9#.'-]+/g)) {
    const e = mm.index + mm[0].length;
    if (sp1[0] + e <= bestSp[1]) continue;
    const qt = atoks(tail.slice(0, e)).map((w) => (Object.prototype.hasOwnProperty.call(DIRS, w) ? DIRS[w] : (Object.prototype.hasOwnProperty.call(SUFFIX, w) ? SUFFIX[w] : w)));
    if (qt.length > ft.length) break;
    const a_ = qt.join(' '), b_ = ft.slice(0, qt.length).join(' '); const tol = Math.max(2, Math.floor(b_.length / 8));
    if (osa(a_, b_, tol) <= tol) bestSp = [sp1[0], sp1[0] + e];
  }
  return { span: bestSp, key: k1, dist: 0, conf: s1, margin: s2 ? (s1 - s2) : Math.min(1.0, s1), kind: 3 };
}
export function resolve(ix, q, taken, haveName, haveAddr) {
  if (!haveName) { const r = resolveName(ix, q, taken); if (r) return r; }
  if (CFG.addr && !haveName && !haveAddr) return resolveAddr(ix, q, taken);
  return null;
}
