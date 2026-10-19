/** mainprec2.js - port of lib/mainprec2.py (main_prec_v2): stricter-only text vetoes (field answer to a check-for clause template, clause concept without tails, HOA tail). */
import * as MP from './mainprec.js';
import * as H3 from './hardv3.js';
import { reEscape } from './text.js';

const ALL = ['field_look', 'cc2', 'tail_hoa'];
let CFG = { on: false, rules: ALL };
export const configure = (d) => { CFG = { on: false, rules: ALL, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const FIRST = { 'keys returned': 'keys?', 'comps used': 'comps?', 'comps count': 'comps?', 'rent amount': 'rent', 'plan term': '(?:plan|term)', 'security deposit': '(?:security|deposit)', 'hoa fee': '(?:hoa|fee)' };
const FLD = /^(Keys returned|Comps used|Comps count|Rent amount|Plan term|Security deposit|Hoa fee): /;
export function fieldLook(q, t) {
  const m = FLD.exec(t);
  if (!m) return null;
  const ql = H3.stripTail(q).toLowerCase().replace(/\s+/g, ' '); const f = FIRST[m[1].toLowerCase()];
  if (new RegExp('\\b(?:check|look at)\\b[^:]{0,80}?\\bfor ' + f + '\\b').test(ql) || new RegExp('\\blook at\\b[^:]{0,100}:\\s*(?:the )?' + f + '\\b').test(ql)
    || new RegExp('^(?:[^:]{0,60}, )?(?:look at|check) [^:]{0,100}:\\s*(?:the )?' + f + '\\b').test(ql)) return 'field_look';
  return null;
}
const XT = /owner asked about the (?:homeowners|homaowners|homeowner'?s?) association|owner asked about the h\w+ association|resident wants to know|tenant is waiting|buyer is asking|client is asking|lender is waiting|lender wants (?:it|to know)|title wants it today|before we send to escrow|for the lender|for the owner|for the piti math/gi;
const KEEP = new Set(['quote', 'quotes', 'estimate', 'estimates', 'bid', 'bids', 'invoice', 'invoices', 'bill', 'bills', 'statement', 'statements', 'total', 'price', 'payoff']);
const docOf = (t) => { const m = /\(page \d+, ([A-Za-z ]+?) [A-Z]{1,3}-\d+/.exec(t); return m ? m[1].toLowerCase() : ''; };
export function cc2(q, t) {
  if (!t.includes(' (page')) return null;
  let q2 = H3.stripTail(q).replace(XT, ' ').toLowerCase();
  for (const w of new Set(docOf(t).match(/[a-z]{3,}/g) || [])) {
    if (KEEP.has(w)) continue;
    q2 = q2.replace(new RegExp('\\b' + reEscape(w) + '\\w{0,3}\\b', 'g'), ' ');
  }
  return MP.clauseConcept(q2, t) ? 'cc2' : null;
}
const TH = /owner asked about the (?:homeowners|homaowners|homeowner'?s?) association|owner asked about the h\w+ association/i;
const THG = new RegExp(TH.source, 'gi');
export function tailHoa(q, t) {
  if (!TH.test(q)) return null;
  const q2 = q.replace(THG, ' ').toLowerCase(); const h = t.split(' (page')[0].toLowerCase();
  if (!/association|^hoa fee|^dues per month|hoa/.test(h)) return null;
  if (/\b(hoa|association|dues|assessments?|community|fees?|common|board|reserve|special)\b/.test(q2)) return null;
  for (const w of q2.match(/[a-z]{4,}/g) || []) {
    if (MP.lev(w, 'association', 2) <= 2 || MP.lev(w, 'assessment', 2) <= 2 || MP.lev(w, 'community', 2) <= 2 || MP.lev(w, 'homeowners', 2) <= 2) return null;
  }
  return 'tail_hoa';
}
const FN = { field_look: fieldLook, cc2, tail_hoa: tailHoa };
export function veto(q, text, rules = null) {
  try {
    for (const r of (rules !== null ? rules : (CFG.rules || ALL))) { const f = FN[r]; if (f && text) { const v = f(q, text); if (v) return v; } }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
