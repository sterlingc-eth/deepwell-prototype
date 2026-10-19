/** mrprec2.js - port of lib/mrprec2.py (mr_prec_v2): stricter-only text vetoes (typo-tolerant field-vs-clause cues, label conflicts). */
import * as MP from './mainprec.js';

const ALL = ['field_cue', 'label_conflict'];
let CFG = { on: false, rules: ALL };
export const configure = (d) => { CFG = { on: false, rules: ALL, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
function fz(t, w) {
  if (t === w) return true;
  if ((t === 'term' && w === 'terms') || t === 'detail') return false;
  if (t.length < 4 || Math.abs(t.length - w.length) > 2) return false;
  if (t[0] === w[0] && [...t].sort().join('') === [...w].sort().join('')) return true;
  const mx = w.length >= 5 ? 1 : 0;
  return mx > 0 && MP.lev(t, w, mx) <= mx;
}
const FIELD = /^(Keys returned|Comps used|Comps count|Rent amount|Plan term|Security deposit|Hoa fee): /;
const CUE = ['terms', 'provisions', 'provision', 'wording', 'section', 'language', 'clause', 'details', 'stated', 'handle', 'anything'];
const CUE_EXACT = ['say'];
export function fieldCue(q, a) {
  if (!FIELD.test(a)) return null;
  for (const t of q.toLowerCase().match(/[a-z]{3,}/g) || []) {
    if (CUE_EXACT.includes(t)) return 'field_cue';
    for (const c of CUE) if (fz(t, c)) return 'field_cue';
  }
  return null;
}
const CON = { 'Rent amount': /\b(owe[sd]?|owing|balance|delinq\w*|late|arrears?|overdue|past due)\b/, 'Hoa fee': /\b(transfer|resale)\b/ };
export function labelConflict(q, a) {
  const m = /^([A-Z][A-Za-z ]+?): /.exec(a);
  const rx = m ? CON[m[1]] : null;
  return rx && rx.test(q.toLowerCase()) ? 'label_conflict' : null;
}
const FN = { field_cue: fieldCue, label_conflict: labelConflict };
export function veto(q, text, rules = null) {
  try {
    for (const r of (rules !== null ? rules : (CFG.rules || ALL))) { const f = FN[r]; if (f && text) { const v = f(q, text); if (v) return v; } }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
