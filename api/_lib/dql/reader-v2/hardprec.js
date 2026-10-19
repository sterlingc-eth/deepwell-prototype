/** hardprec.js - port of lib/hardprec.py (hard_v1): stricter-only vetoes (list shape, dropped condition, wrong-direction cue) + fuzzy contact field words. The 'sig'/'type_typo' path is not ported (switch hard_v1.sig is off). */
import { lev } from './pyx.js';

const DEFR = ['list_shape', 'cond_miss', 'cue_conflict'];
let CFG = { on: false, sig: false, rules: [...DEFR], contact_fuzzy: true };
export const configure = (d) => {
  CFG = { on: false, sig: false, rules: [...DEFR], contact_fuzzy: true };
  if (d && typeof d === 'object') Object.assign(CFG, d);
  if (CFG.sig) throw new Error('hard_v1.sig is not supported by this port');
};
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
export function contactFields(ql) {
  const out = [];
  for (const w of ql.match(/[a-z]+/g) || []) {
    if (w.length < 4) continue;
    if (['email', 'emails', 'phone', 'phones'].includes(w)) continue;
    if (w[0] === 'e' && w.includes('a') && w.includes('l') && lev(w, 'email') <= 2) out.push('email');
    else if ('pf'.includes(w[0]) && w.includes('h') && lev(w, 'phone') <= 1 + (w.length >= 6 ? 1 : 0)) out.push('phone');
  }
  return out;
}
const SHAPE_ASK = /\b(list|all|every|each|enumerate|show)\b|in .* folder|\bwhat .* (?:are|do) .* (?:have|has)\b/;
const SHAPE_OK = /\b(latest|most recent|newest|last|earliest|oldest|first|highest|lowest|largest|smallest|biggest|top|cheapest)\b/;
const COND = /\b(?:\w*ark\w*|that are|and are|which are|and that are|where \w+ is|whose [\w ]+ is|with status|status)\s+([a-z]+)/;
const STATUS = new Set(['unpaid', 'paid', 'pending', 'open', 'closed', 'overdue', 'active', 'late', 'signed', 'void', 'draft']);
export function listShape(q, a) {
  const ql = q.toLowerCase(); a = a || '';
  return !!(SHAPE_ASK.test(ql) && !SHAPE_OK.test(ql) && /^(Latest|Earliest|Highest|Lowest) /.test(a) && !a.split(': ')[0].includes('('));
}
export function condMiss(q, a) {
  const m = COND.exec(q.toLowerCase()); a = a || '';
  if (!m || !/on file|\bhas \d|\bhave \d|^Total of \d|^(Latest|Earliest|Highest|Lowest) | among /.test(a)) return false;
  if (/(?:^|\s)0 [a-z]/.test(a.slice(0, 60)) && a.slice(0, 80).includes('on file') && /^(?:.* has )?0 /.test(a)) return false;
  const v = m[1];
  return (STATUS.has(v) || m[0].includes('whose') || m[0].includes('where') || m[0].includes('status')) && !a.toLowerCase().includes(v);
}
const CUES = { Latest: ['latest', 'newest', 'recent', 'last', 'current'], Earliest: ['earliest', 'oldest', 'first', 'initial', 'original'],
  Highest: ['highest', 'largest', 'biggest', 'greatest', 'maximum', 'priciest'], Lowest: ['lowest', 'smallest', 'cheapest', 'minimum', 'fewest', 'tiniest'] };
const EXACT = new Set(['latest', 'newest', 'recent', 'last', 'current', 'earliest', 'oldest', 'first', 'initial', 'original', 'highest', 'largest', 'biggest', 'greatest', 'maximum', 'priciest', 'top', 'most', 'max',
  'lowest', 'smallest', 'cheapest', 'minimum', 'fewest', 'tiniest', 'least', 'min', 'bottom', 'latter', 'newer', 'older']);
export function cueConflict(q, a) {
  const m = /^(Latest|Earliest|Highest|Lowest) /.exec(a || '');
  if (!m) return false;
  const ans = m[1]; const dirs = new Set(); const toks = q.toLowerCase().match(/[a-z]{4,}/g) || [];
  if (toks.some((w) => EXACT.has(w))) return false;
  for (const w of toks) {
    if (w.length < 5) continue;
    for (const [d, cs] of Object.entries(CUES)) for (const c of cs) if (c.length >= 5 && lev(w, c) <= (c.length <= 6 ? 1 : 2) && Math.abs(w.length - c.length) <= 2) dirs.add(d);
  }
  return dirs.size > 0 && !dirs.has(ans);
}
export function veto(q, c) {
  const R = CFG.rules || [];
  try {
    if (R.includes('type_typo')) throw new Error('type_typo is not supported by this port');
    const t = c.text || '';
    if (R.includes('list_shape') && listShape(q, t)) return 'list_shape';
    if (R.includes('cond_miss') && condMiss(q, t)) return 'cond_miss';
    if (R.includes('cue_conflict') && cueConflict(q, t)) return 'cue_conflict';
  } catch (e) { if (/not supported/.test(String(e.message))) throw e; }
  return null;
}
