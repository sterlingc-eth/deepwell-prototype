/** hardv4.js - port of lib/hardv4.py (hard_v4): type_swap / type_name / file_note release rules. */
import * as H3 from './hardv3.js';

const DEFAULT_RULES = ['type_swap', 'type_name', 'file_note'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: !!(d && d.on), rules: [...((d && d.rules && d.rules.length) ? d.rules : DEFAULT_RULES)] }; };
export const on = () => CFG.on;
export const sim = H3.sim; export const stripTail = H3.stripTail; export const words = H3.words;
function typeName(q, t) { if (!t.startsWith('Type name:')) return false; return !words(stripTail(q)).filter((w) => w.length >= 3).some((w) => sim(w, 'name') >= 0.75); }
function fileNote(q, t) { if (!t.startsWith('File note:')) return false; return words(stripTail(q)).filter((w) => w.length >= 4).some((w) => sim(w, 'visit') >= 0.75 || sim(w, 'visits') >= 0.75); }
const hum = (s) => s.replace(/[_-]+/g, ' ').toLowerCase();
export function st(w) { w = w.toLowerCase(); return w.length > 3 ? w.replace(/(es|s|e)$/, '') : w; }
const ATYPE = [/^(?:Latest|Earliest|Highest|Lowest) (.+?)(?: for [^:(]+?)?(?: \([^)]*\))?:/, /^(?:[^:]{0,60} has )?\d+ (.+?) on file/, /^Total of \d+ (.+?) (?:for [^:(]+?)?(?: \([^)]*\))?:/, /^[^:]{2,60}'s (.+?)(?: \([^)]*\))?:/];
export function ansType(t) { t = t.slice(0, 200); for (const p of ATYPE) { const m = p.exec(t); if (m) return m[1]; } return null; }
export function tm(tp, qt) {
  const ws = (tp.toLowerCase().match(/[a-z]+/g) || []).map(st);
  if (!ws.length) return 0.0;
  return ws.filter((w) => qt.some((x) => sim(w, x) >= 0.84)).length / ws.length;
}
export function contig(tp, qt) {
  const ws = (tp.toLowerCase().match(/[a-z]+/g) || []).map(st); const n = ws.length;
  if (n === 0 || qt.length < n) return false;
  for (let i = 0; i <= qt.length - n; i++) { let all = true; for (let k = 0; k < n; k++) if (!(sim(ws[k], qt[i + k]) >= 0.84)) { all = false; break; } if (all) return true; }
  return false;
}
function typeSwap(q, t, types) {
  const a = ansType(t);
  if (!a || !types || !types.length) return false;
  if (/^(0 |[^:]{0,80} has 0 )/.test(t)) return false;
  const qt = words(stripTail(q)).filter((w) => w.length >= 3).map(st);
  const sa = tm(a, qt);
  if (sa >= 1.0) return false;
  const A = new Set((a.toLowerCase().match(/[a-z]+/g) || []).map(st));
  for (const ty of types) {
    const h = hum(ty); const hw = new Set((h.match(/[a-z]+/g) || []).map(st));
    const sub = (x, y) => [...x].every((v) => y.has(v));
    const eq = hw.size === A.size && sub(hw, A);
    if (eq || sub(hw, A) || sub(A, hw)) continue;
    if (hw.size >= 2 && hw.size >= A.size && contig(h, qt)) return true;
  }
  return false;
}
const RULES = { type_swap: typeSwap, type_name: typeName, file_note: fileNote };
export function check(q, c, types = null) {
  if (!on()) return null;
  const t = String(c.text || '');
  for (const name of CFG.rules) {
    const f = RULES[name];
    try { if (f && (name === 'type_swap' ? f(q, t, types) : f(q, t))) return name; } catch (e) { /* swallowed like the reference */ }
  }
  return null;
}
export function mark(q, res, ix = null) {
  if (!on()) return;
  const types = [...((ix && ix.types) || [])];
  for (const [, c] of res) { const r = check(q, c, types); if (r) c._hv4 = r; }
}
