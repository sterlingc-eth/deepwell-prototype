/** watch6.js - port of lib/watch6.py (watch6_veto): stricter-only text vetoes found on mined wrong answers (stamps the existing _hv2 release flag). */
const DEFAULT_RULES = ['keys_clause', 'units_rank', 'funds_cutoff', 'inspect_foreign', 'assoc_price', 'cam_foreign'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: !!(d && d.on), rules: [...((d && d.rules && d.rules.length) ? d.rules : DEFAULT_RULES)] }; };
export const on = () => CFG.on;
const KEYS_CUE = /\b(terms?|provisions?|wording|sections?|language|clauses?|anything (about|on|in)|(say|says) about|tell me about|stated|covers?)\b/i;
const INSP = /inspect|walk[- ]?through/i;
const R = {
  keys_clause: (q, t) => t.startsWith('Keys returned:') && KEYS_CUE.test(q),
  units_rank: (q, t) => /^Total units (highest|lowest) among/.test(t),
  funds_cutoff: (q, t) => t.startsWith('The funds required') && q.toLowerCase().includes('cutoff'),
  inspect_foreign: (q, t) => t.startsWith('We inspect the unit') && !INSP.test(q),
  assoc_price: (q, t) => t.startsWith('The association charges') && /\b(sales? price|price tag|asking price)\b/i.test(q),
  cam_foreign: (q, t) => t.startsWith('Annual CAM increases') && /common area (charges?|fees?|costs?)|\bcam (charges?|fees?)/i.test(q),
};
export function check(q, t, rules = null) {
  for (const name of (rules || CFG.rules)) { const f = R[name]; try { if (f && f(q, t)) return name; } catch (e) { /* swallowed */ } }
  return null;
}
export function mark(q, res) {
  if (!on()) return;
  for (const [, c] of res) { const r = check(q, String(c.text || '')); if (r && !c._hv2) c._hv2 = 'w6:' + r; }
}
