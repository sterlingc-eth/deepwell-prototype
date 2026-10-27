/** clausetopic98.js - port of lib/clausetopic98.py mark()/sigA()/sigB() + the clausenat7 helpers they use (log path only: the a/b/c veto sub-switches of the loop recipe are OFF, so the fired flags ct[7], ct[8] are always 0 here).
 * Stamps c._ct98s = [a_known, a_nb_chosen, a_nb_other, b_field, b_pre_only, b_unc, b_id, fired_a, fired_b, a_rich] on src-2 text candidates of ONE cited document.  Only called when the shipped bundle carries ck289
 * (clausestack289.needStamp); never changes an answer by itself. Needs data/clausenat7_lex.json (the loop's lexicon, md5 pinned: a different file => no stamp => no rescue). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { words, stem } from './text.js';
import { teq } from './clausefree2.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEX_MD5 = '2e14b68d623b041d01c0a80ba136ea5a';
const CUT = /\s*\(page \d+/; const END = /[.!?]["')\]]?$/; const YN = /^(Yes|No)\.\s+/; const TIT = /\(page \d+, ([\s\S]*)\)\s*$/;
const FLD = /^([A-Za-z][A-Za-z /&'-]{1,30}): ([\s\S]+?)(?: \([\s\S]*)?$/;
const SEG = /\s*(?:,|;|:| - | – | — |\?)\s*/;
const REFS = /[A-Za-z]{2,4}-\d{3,5}|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/;
const B_MAXPRE = 6;
let LEX; let LEXOK;
function lex() {
  if (LEXOK === undefined) {
    try { const buf = fs.readFileSync(path.join(HERE, 'data', 'clausenat7_lex.json')); LEXOK = crypto.createHash('md5').update(buf).digest('hex') === LEX_MD5; LEX = LEXOK ? JSON.parse(buf.toString('utf8')) : null; } catch (e) { LEXOK = false; LEX = null; }
  }
  return LEXOK ? LEX : null;
}
export const lexOk = () => !!lex();
const body = (t) => { const s = String(t ?? ''); const m = CUT.exec(s); return (m ? s.slice(0, m.index) : s).trim(); };
const title = (t) => { const m = TIT.exec(String(t ?? '')); return m ? m[1] : ''; };
const tpl = (s) => String(s ?? '').replace(/\$?\d[\d,]*(\.\d+)?%?/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
function subseq(a, b) { let j = 0; for (let i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++; return j === a.length; }
function titleLike(w, tws) {
  for (const t of tws) {
    if (w === t || (t.length >= 4 && w.length >= 4 && teq(w, t))) return true;
    if (w.length >= 3 && w.length < t.length && w[0] === t[0] && subseq(w, t)) return true;
  }
  return false;
}
function nbscore(lx, S, t) {
  const d = lx.tpl[t]; if (!d) return 0.0;
  const v = []; for (const w of S) if (Object.prototype.hasOwnProperty.call(d, w)) v.push(d[w]);
  v.sort((a, b) => b - a); return v.slice(0, 3).reduce((a, b) => a + b, 0);
}
function topic(q, text, lx) {
  const tws = words(title(text)).filter((w) => w.length > 2); const ts = new Set(tws.map(stem));
  const qs = new Set(words(String(q)).filter((w) => w.length > 2 && !titleLike(w, tws)).map(stem));
  const noise = new Set(lx.noise || []);
  const top = new Set([...qs].filter((s) => !ts.has(s) && !noise.has(s)));
  return { top, tws, ts, noise };
}
function sigA(q, text, doc, lx) {
  const b = body(text).replace(YN, '').trim();
  const { top } = topic(q, text, lx);
  const ct = tpl(b);
  if (!Object.prototype.hasOwnProperty.call(lx.tpl, ct) || !top.size) return [0, 0.0, 0.0, 0.0];
  const rich = Object.values(lx.tpl[ct]).sort((a, c) => c - a).slice(0, 3).reduce((a, c) => a + c, 0);
  const nbC = nbscore(lx, top, ct); let nbO = 0.0;
  for (let l of String(doc ?? '').split('\n')) {
    l = l.trim();
    if (l.length < 12 || !END.test(l)) continue;
    const t = tpl(l.replace(YN, ''));
    if (t === ct || !Object.prototype.hasOwnProperty.call(lx.tpl, t)) continue;
    const v = nbscore(lx, top, t); if (v > nbO) nbO = v;
  }
  return [1, nbC, nbO, rich];
}
function sigB(q, text, lx) {
  const m = FLD.exec(body(text));
  if (!m) return [0, 0, 0, 0];
  const label = m[1], val = m[2];
  const lw = words(label).filter((w) => w.length > 2).map(stem);
  if (!lw.length) return [1, 0, 0, 0];
  const qs = String(q); const mm = SEG.exec(qs);
  if (!mm) return [1, 0, 0, 0];
  const pre = qs.slice(0, mm.index), rest = qs.slice(mm.index + mm[0].length);
  if (pre.split(/\s+/).filter(Boolean).length > B_MAXPRE) return [1, 0, 0, 0];
  const ps = new Set(words(pre).map(stem)), rs = new Set(words(rest).map(stem));
  if (!lw.every((w) => ps.has(w)) || lw.some((w) => rs.has(w))) return [1, 0, 0, 0];
  const tws = words(title(text)).filter((w) => w.length > 2); const ts = new Set(tws.map(stem));
  const noise = new Set(lx.noise || []); const ans = new Set(words(label + ' ' + val).map(stem));
  let unc = 0;
  for (const s of rs) if (s.length > 2 && !/\d/.test(s) && !ts.has(s) && !noise.has(s) && !ans.has(s) && !titleLike(s, tws)) unc++;
  const pid = [...ps].some((s) => s.length > 2 && (ts.has(s) || titleLike(s, tws))) || REFS.test(pre);
  const rid = [...rs].some((s) => s.length > 2 && (ts.has(s) || titleLike(s, tws))) || REFS.test(rest);
  return [1, 1, unc, (!pid && rid) ? 1 : 0];
}
/** python round(x, 2) (round-half-even on the exact binary value); JS toFixed(2) rounds exact ties up.  Exact ties exist only for x = odd/8, handled here. */
function rnd2(x) {
  x = Number(x);
  const e = x * 8;
  if (Number.isInteger(e) && Math.abs(e) % 2 === 1) { const n = x * 100; const lo = Math.floor(n); return (lo % 2 === 0 ? lo : lo + 1) / 100; }
  return Number(x.toFixed(2));
}
/** stamp res = [[src, c, v], ...] after the other marks (clausetopic98.mark) */
export function mark(ix, q, res) {
  const lx = lex(); if (!lx) return;
  for (const [src, c] of res) {
    try {
      if (src !== 2 || c.intent !== 'text') continue;
      const docs = c.docs || [];
      if (docs.length !== 1) continue;
      const text = c.text;
      const plain = !Object.entries(c).some(([k, val]) => k.startsWith('_') && val === true);
      const b = sigB(q, text, lx);
      let a = [0, 0.0, 0.0, 0.0];
      if (!b[0] && plain) a = sigA(q, text, ix.c.text(docs[0]), lx);
      c._ct98s = [a[0], rnd2(a[1]), rnd2(a[2]), b[0], b[1], b[2], b[3], 0, 0, rnd2(a[3])];
    } catch (e) { /* swallowed like the reference */ }
  }
}
