/** wildprec2.js - port of lib/wildprec2.py (wild_prec_v2): stricter-only text vetoes (foreign stock clauses, closing-document head mismatch). */
import { ratio } from './difflib.js';

const DEFAULT_RULES = ['buildout_foreign', 'ownerpays_foreign', 'closing_head'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: false, rules: [...DEFAULT_RULES], ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const toks = (q) => q.toLowerCase().split('-').join('').match(/[a-z]+/g) || [];
function fz(q, ws, thr = 0.8) {
  for (const t of toks(q)) {
    if (t.length < 3) continue;
    for (const w of ws) if (t === w || t.startsWith(w) || (t.length >= 4 && w.length >= 4 && ratio(t, w) >= thr)) return true;
  }
  return false;
}
const BO = ['build', 'buildout', 'improvement', 'improvements', 'allowance', 'contribution', 'ti', 'tenant improvement', 'improve'];
const buildoutForeign = (q, a) => (a.startsWith('The build-out contribution') && !fz(q, BO) ? 'buildout_foreign' : null);
const OP = ['fee', 'manage', 'manager', 'management', 'commission', 'pay', 'charge', 'percent', 'percentage', 'cut', 'take', 'takes', 'compensation'];
const ownerpaysForeign = (q, a) => (a.startsWith('Owner pays the manager') && !fz(q, OP) ? 'ownerpays_foreign' : null);
const PATS = [/^(?:Latest|Earliest) (.+?) for /, /^(?:Highest|Lowest) (.+?) (?:\(|:)/, /^Total of \d+ (.+?) (?:for|\(|on)/, /^(?:\d+|.+? has \d+) (.+?) on file/, /^Total of \d+ (.+?)[:(]/, /^.+?'s (.+?)(?: \(|:)/];
const HEADS = { 'closing disclosure': 'disclosure', 'closing statement': 'statement', 'settlement statement': 'statement' };
const rstripS = (s) => s.replace(/s+$/, '');
export function closingHead(q, a) {
  let h = null;
  for (const p of PATS) { const m = p.exec(a); if (m && m[1]) { h = m[1].split('(')[0].trim().toLowerCase(); break; } }
  if (!h) return null;
  if (h.endsWith('s') && !Object.prototype.hasOwnProperty.call(HEADS, rstripS(h))) h = h.replace(/(ies|es|s)$/, '');
  let hn = null;
  for (const [k, v] of Object.entries(HEADS)) if (rstripS(h) === k || h === k) { hn = v; break; }
  if (!hn) return null;
  return (fz(q, [hn], 0.78) || fz(q, ['paper', 'papers', 'document', 'documents', 'docs', 'package', 'packet', 'paperwork'], 0.85)) ? null : 'closing_head';
}
const FN = { buildout_foreign: buildoutForeign, ownerpays_foreign: ownerpaysForeign, closing_head: closingHead };
export function veto(q, text, rules = null) {
  try {
    for (const r of (rules !== null ? rules : (CFG.rules || DEFAULT_RULES))) { const f = FN[r]; if (f && text) { const v = f(q, text); if (v) return v; } }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
