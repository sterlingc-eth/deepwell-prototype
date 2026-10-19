/** cueagree.js - port of lib/cueagree.py (cue_agree_v1): stamp unfiltered lowest/highest answers whose direction label and document-type phrase agree with the question; precfix rescues them. */
import { repAll } from './pyx.js';

const DEF = { on: false, floor: 0.5 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const CUE = { Highest: /\b(highest|largest|biggest|greatest|maximum|priciest|most expensive|top)\b/, Lowest: /\b(lowest|smallest|cheapest|minimum|tiniest|bottom|least expensive|fewest)\b/ };
const CUEG = { Highest: new RegExp(CUE.Highest.source, 'g'), Lowest: new RegExp(CUE.Lowest.source, 'g') };
const OPP = { Highest: 'Lowest', Lowest: 'Highest' };
const FILT = /\d|\b(since|before|after|over|under|between|above|below|ytd|year|month|quarter|week|days?|last|past|this|winter|spring|summer|fall|autumn|q[1-4]|h[12]|least|most|more|less|than|at|from|to|worth|including|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*|thousand|k)\b/i;
const ANS = /^(Highest|Lowest) ([^:()]+): \$[\d,.]+ \(/;
const OKW = new Set(['total', 'amount', 'dollar', 'dollars', 'date', 'number', 'name', 'type']);
const FW = new WeakMap();
function fieldwords(ix) {
  let s = FW.get(ix);
  if (!s) { s = new Set(); for (const h of ix.fields.values()) for (const w of String(h).toLowerCase().match(/[a-z]+/g) || []) if (!OKW.has(w) && w.length >= 3) s.add(w); FW.set(ix, s); }
  return s;
}
export function check(ix, q, c) {
  try {
    if (c.intent !== 'min' && c.intent !== 'max') return false;
    const m = ANS.exec(String(c.text || ''));
    if (!m) return false;
    const lab = m[1], dt = m[2].trim().toLowerCase(); const ql = q.toLowerCase();
    if (!CUE[lab].test(ql) || CUE[OPP[lab]].test(ql) || !ql.includes(dt)) return false;
    const rest = repAll(ql.replace(CUEG[lab], ' '), dt, ' ');
    if (FILT.test(rest)) return false;
    const fw = fieldwords(ix);
    if ((rest.match(/[a-z]+/g) || []).some((w) => fw.has(w))) return false;
    return true;
  } catch (e) { return false; }
}
export function stamp(ix, q, res) { for (const [src, c] of res) if (src === 2 && check(ix, q, c)) c._ca = 1; }
export function rescue(pf, c, pv) {
  try {
    if (!enabled() || !c._ca) return false;
    if (pf.grounding_hard && c._ungrounded) return false;
    return Number(pv) >= Number(CFG.floor);
  } catch (e) { return false; }
}
