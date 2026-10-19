/** wildprec.js - port of lib/wildprec.py (wild_prec_v1): stricter-only text vetoes. */
import { ratio } from './difflib.js';
import * as MP from './mainprec.js';

const DEFAULT_RULES = ['delinq_total', 'appr_looked'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: false, rules: [...DEFAULT_RULES], ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const fz = (q, word, thr) => (q.toLowerCase().match(/[a-z]+/g) || []).some((t) => t.length >= 4 && ratio(t, word) >= thr);
const delinqTotal = (q, a) => (a.startsWith('Total: $') && fz(q, 'delinquent', 0.78) ? 'delinq_total' : null);
const apprLooked = (q, a) => (a.startsWith('Appraiser: ') && /\b(looked|approach|method|how the apprais\w*|inspect\w* the)\b/.test(q.toLowerCase()) ? 'appr_looked' : null);
const FILL = /\b(inspection this week|turnover is tomorrow|closing in a few days|owner called twice already about the statement|the board meets next week|buyer is standing here|resident wants to know|owner asked about the homeowners association|before turnover|before the open house|open house|tenant is waiting|lender wants (?:it|to know)|before we send to escrow|before the broker review|production report|for the timeline|for the checklist)\b/gi;
export function concept2(q, a) {
  if (!a.includes(' (page')) return null;
  const drop = new Set(a.slice(a.indexOf(' (page') + ' (page'.length).toLowerCase().match(/[a-z]{3,}/g) || []);
  const toks = q.replace(FILL, ' ').match(/\S+/g) || []; const cn = new Map();
  const key = (w) => w.toLowerCase().replace(/[^a-z]/g, '');
  for (const w of toks) cn.set(key(w), (cn.get(key(w)) || 0) + 1);
  const q2 = toks.filter((w) => !(drop.has(key(w)) && cn.get(key(w)) === 1)).join(' ');
  return MP.clauseConcept(q2, a) ? 'concept2' : null;
}
const FN = { delinq_total: delinqTotal, appr_looked: apprLooked, concept2 };
export function veto(q, text, rules = null) {
  try {
    for (const r of (rules !== null ? rules : (CFG.rules || DEFAULT_RULES))) { const f = FN[r]; if (f && text) { const v = f(q, text); if (v) return v; } }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
