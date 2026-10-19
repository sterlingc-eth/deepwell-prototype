/** clausefree2.js - port of lib/clausefree2.py (clause_free_v2): release a free-text clause answer the verifier holds back ONLY when the evidence is unambiguous. */
import { stem, words } from './text.js';

const DEF = { on: false, pmi: 2.6, collect: false };
let CFG = { ...DEF }; let LEX = []; let FILL = new Set(); let REL = new Set(); const KC = new Map();
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; KC.clear(); };
/** lex: [[key, [[clauseWord, pmi], ...]], ...] in the reference's dict order; meta: {fillers, keys} */
export const setData = (lex, meta) => { LEX = lex || []; FILL = new Set((meta && meta.fillers) || []); REL = new Set((meta && meta.keys) || []); KC.clear(); };
export const cfg = () => CFG;
export const enabled = () => !!(CFG.on || CFG.collect);
export function ctx(cw, cands, bidx, sc, qraw = null) {
  return { cw: cw.map(String), qw: (qraw || []).map(String), bidx, sc: Array.from(sc, Number),
    lines: cands.map((m) => [m.kind, m.kind === 'line' ? m.text : `${m.key ?? ''} ${m.val ?? ''}`, m.page ?? 0]) };
}
const END = /\.\s*\(page/;
export function tdist(a, b) {
  const la = a.length, lb = b.length; const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) for (let j = 1; j <= lb; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[la][lb];
}
export function teq(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  const dd = tdist(a, b);
  return dd <= 1 || (dd === 2 && n >= 8 && a[0] === b[0]);
}
function keysOf(s) {
  let r = KC.get(s);
  if (r === undefined) {
    r = LEX.filter(([k]) => k === s || (s.length >= 5 && teq(s, k)));
    if (KC.size > 5000) KC.clear();
    KC.set(s, r);
  }
  return r;
}
export function evidence(s, U, pmiMin = 2.6) {
  if (U.has(s)) return [3, 'L:' + s];
  if (s.length >= 4) for (const u of [...U].sort()) if (teq(s, u)) return [2, 'L:' + u];
  for (const [k, d] of keysOf(s)) {
    if (!d || !d.length) continue;
    let u = d[0][0], v = d[0][1];
    for (const [uu, vv] of d) if (vv > v) { u = uu; v = vv; }
    if (U.has(u) && v >= pmiMin) return [1, `X:${k}:${u}`];
  }
  return [0, null];
}
export function decide(cx, c) {
  const pm = Number(CFG.pmi ?? 2.6); const lines = cx.lines; const bi = cx.bidx;
  if (lines[bi][0] !== 'line' || !END.test(c.text || '')) return [false, 'not a complete clause line'];
  const tw = cx.cw.map((w) => stem(w)).filter((s) => !FILL.has(s));
  if (!tw.length) return [false, 'no topic word'];
  const pws = lines.map(([k, t]) => (k === 'line' ? new Set(words(t).map((w) => stem(w))) : new Set()));
  const ev = tw.map((w) => evidence(w, pws[bi], pm));
  if (Math.min(...ev.map((e) => e[0])) < 1) return [false, 'topic word not explained'];
  if (ev.some((e) => !REL.has(e[1]))) return [false, 'evidence key not proven reliable'];
  const qs = new Set((cx.qw || []).map((w) => stem(w))); for (const f of FILL) qs.delete(f);
  const ov = (ws) => { let n = 0; for (const s of qs) if (ws.has(s) || (s.length >= 4 && [...ws].some((u) => teq(s, u)))) n++; return n; };
  const oCh = ov(pws[bi]);
  if (pws.some((ws, i) => i !== bi && ws.size && ov(ws) > oCh)) return [false, 'another clause overlaps the question better'];
  const sc = Math.min(...ev.map((e) => e[0]));
  for (let i = 0; i < pws.length; i++) {
    const ws = pws[i];
    if (i === bi || !ws.size) continue;
    if (Math.min(...tw.map((w) => evidence(w, ws, pm)[0])) >= sc) return [false, 'another clause explains it as well'];
  }
  return [true, 'ok'];
}
/** True -> release this candidate although its verifier score is below the threshold (called AFTER every stricter-only veto, only for pv < thr) */
export function rescue(precfix, c) {
  try {
    if (!enabled()) return false;
    const cx = c._cf2_ctx;
    if (cx === undefined || cx === null || c.intent !== 'text' || parseInt(c._cf2_n ?? 1, 10) !== 1) return false;
    if ((precfix || {}).grounding_hard && c._ungrounded) return false;
    c._cf2_reached = true;
    if (CFG.collect && !CFG.on) return false;
    const [ok, why] = decide(cx, c);
    c._cf2_why = why;
    return !!ok;
  } catch (e) { return false; }
}
