/** hardv3.js - port of lib/hardv3.py (hard_v3): stricter-only release rules on question + answer text. */
import { ratio } from './difflib.js';
import { reEscape } from './text.js';

const DEFAULT_RULES = ['dom_cue', 'tot_cue', 'field_cue', 'contact_suffix', 'contact_addr', 'appr_cue'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: !!(d && d.on), rules: [...((d && d.rules && d.rules.length) ? d.rules : DEFAULT_RULES)] }; };
export const on = () => CFG.on;
export function sim(a, b) {
  if (a === b) return 1.0;
  if (a.length >= 4 && b.length >= 4 && (a.slice(0, 5) === b.slice(0, 5) || a.replace(/s+$/, '') === b.replace(/s+$/, ''))) return 0.95;
  return ratio(a, b);
}
const TAILS = ['for the days on market report', 'for the dom report', 'for the principal, interest, taxes and insurance math', 'for the piti math', 'ahead of the broker price opinion', 'ahead of the bpo',
  'for the owner report', 'for the owner statement', 'for the transaction coordinator checklist', 'for the tc checklist', 'for the checklist', 'need it for the timeline', 'for the timeline',
  'for the audit trail', 'for compliance', 'for the production report', 'for the report', 'before the broker review', 'for the cda', 'need it for the cda', 'for the file audit', 'for the file', 'for my records', 'for the tracker'];
const TR = new RegExp([...TAILS].sort((a, b) => b.length - a.length).map(reEscape).join('|'), 'gi');
export const stripTail = (q) => q.replace(TR, ' ');
export const words = (s) => s.toLowerCase().match(/[a-z]+/g) || [];
const REF = /\b[A-Za-z]{1,3}-?\d{3,4}\b/;
const MONEY = /\b(sales? price|price tag|how much|come to|came to|the amount on|amount on|the number on|what.s the number on)\b/i;
export function domCue(q, t) {
  if (!/^(Dom|Market days): \d/.test(t)) return false;
  const ql = stripTail(q).toLowerCase(); const tk = words(ql);
  if (/\bdom\b|market|days|listing time|how long/.test(ql)) return false;
  return !tk.some((w) => sim(w, 'market') >= 0.8 || sim(w, 'days') >= 0.9);
}
export function totCue(q, t) {
  const s = stripTail(q);
  if (t.startsWith('Total:') || !(REF.test(s) && MONEY.test(s))) return false;
  return t.slice(0, 140).includes(' (page ') || t.startsWith('Record number:') || /^[A-Z][A-Za-z.' ]+ \(/.test(t);
}
export function fieldCue(q, t) {
  if (!t.startsWith('Total:')) return false;
  const ql = stripTail(q).toLowerCase(); const tk = words(ql).filter((w) => w.length >= 5);
  if (tk.some((w) => sim(w, 'delinquent') >= 0.75)) return true;
  if (tk.some((w) => sim(w, 'wholesale') >= 0.85)) return true;
  return words(ql).filter((w) => w.length >= 4).some((w) => sim(w, 'units') >= 0.85 || w === 'unnits') && !/\$|dollars?|rent/.test(ql);
}
const CSUF = ['north', 'south', 'east', 'west', 'central', 'metro', 'prime', 'elite', 'premier'];
export function contactSuffix(q, t) {
  const m = /^([A-Z][A-Za-z&.' ]+?(?: LLC| Inc| Co)?): /.exec(t);
  if (!m) return false;
  const name = m[1].toLowerCase(); const tail = t.slice(m[1].length, m[1].length + 40);
  if (!/@|\d{3}[-. )]+\d{3}|\d+ [A-Z]/.test(tail)) return false;
  const ql = q.toLowerCase().replace(/\s+/g, ' '); const i = ql.indexOf(name);
  if (i < 0) return false;
  const rest = words(ql.slice(i + name.length)).slice(0, 1);
  if (!rest.length) return false;
  const w = rest[0];
  if (w === 'pro') return true;
  return w.length >= 4 && CSUF.some((s) => sim(w, s) >= 0.8);
}
const PH = /^[^:]{2,60}: \(\d{3}\) \d{3}-\d{4}\s*$/; const EM = /^[^:]{2,60}: \S+@\S+\s*$/;
export function contactAddr(q, t) {
  const tk = words(stripTail(q));
  if (!tk.some((w) => w.length >= 5 && sim(w, 'address') >= 0.72)) return false;
  const em = tk.filter((w) => w.length >= 4).some((w) => sim(w, 'email') >= 0.75) || tk.slice(0, -1).some((w, i) => sim(w, 'phone') >= 0.75 && ['number', 'nubmer', 'num', 'no', 'numbr'].includes(tk[i + 1])) || tk.some((w) => sim(w, 'number') >= 0.8);
  return !em && !!(PH.test(t.slice(0, 80)) || EM.test(t.slice(0, 90)));
}
const STOPW = new Set('this that with from have year dollars under than what were does many there also over least most about years month months last past next first half quarter before after since during till until between been your those these then them they when which where whose into only just pls please'.split(' '));
const AGGR = /^(?:[^:]{0,60} has )?\d+ [^:]*? on file|^Total of \d+ |^(?:Earliest|Latest) [^:]* for [^:]*: \d/;
export function filtAgg(q, t) {
  if (!AGGR.test(t.slice(0, 140))) return false;
  if (/^[^:]{0,60}'s [^:]+:/.test(t)) return false;
  const ql = q.toLowerCase();
  const m = /\b(and (?:that are|that is|that were|whose|with notes?|with|where|marked|which are|listed as)|whose|marked|listed as)\s+([a-z' ]{3,40})/.exec(ql);
  if (!m) return false;
  const cond = (m[2].match(/[a-z]{4,}/g) || []).filter((w) => !STOPW.has(w));
  if (!cond.length) return false;
  const tl = t.toLowerCase();
  if (/^(0 |[^:]{0,80}has 0 )/.test(tl) || tl.slice(0, 60).includes(' 0 ')) return false;
  const tt = words(tl);
  return !cond.some((w) => tt.some((x) => sim(w, x) >= 0.8));
}
export function apprCue(q, t) {
  if (!(t.startsWith('Appraiser:') || t.startsWith('Inspector:'))) return false;
  const tk = words(stripTail(q));
  if (tk.some((x) => x === 'fee' || x === 'fees')) return true;
  return tk.some((x) => x.length >= 5 && ['charge', 'charges', 'costs', 'repair', 'repairs', 'looked'].some((c) => sim(x, c) >= 0.8));
}
const RULES = { appr_cue: apprCue, dom_cue: domCue, tot_cue: totCue, field_cue: fieldCue, contact_suffix: contactSuffix, contact_addr: contactAddr, filt_agg: filtAgg };
export function check(q, c) {
  if (!on()) return null;
  const t = String(c.text || '');
  for (const name of CFG.rules) { const f = RULES[name]; try { if (f && f(q, t)) return name; } catch (e) { /* the Python version swallows the same way */ } }
  return null;
}
export function mark(q, res) { if (!on()) return; for (const [, c] of res) { const r = check(q, c); if (r) c._hv3 = r; } }
