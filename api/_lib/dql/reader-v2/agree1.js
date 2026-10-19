/** agree1.js - port of lib/agree1.py (agree_v1): dual-path intent agreement - cue path vs classifier; on disagreement the pipeline is re-run once with the cue intent forced. */
import { cleanQuestion } from './ext.js';

const ALL = ['L1', 'P1', 'T1'];
const DEF = { on: false, rules: ALL };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const RULES = [
  ['L1', /\b(?:list|lists)\b/i, /\b(?:latest|newest|most recent|recent|last|current|newer)\b/i, new Set(['latest']), 'list'],
  ['P1', /\bname of the (?:p\w{3,6}n|person|people)\b/i, null, null, 'party'],
  ['T1', /\bwhat (?:we|i|they|you) billed\b|\bmoney[- ]?wise\b/i, null, null, 'total'],
];
export function route(q, intent) {
  const on = new Set(CFG.rules || ALL);
  for (const [name, pat, anti, frm, tgt] of RULES) {
    if (!on.has(name) || intent === tgt) continue;
    if (frm !== null && !frm.has(intent)) continue;
    if (pat.test(q) && !(anti && anti.test(q))) return [name, tgt];
  }
  return null;
}
export async function reroute(ix, q, M, res, out, base) {
  const [q2] = cleanQuestion(q);
  const r = route(q2, out.intent);
  if (r === null) return null;
  const [name, tgt] = r;
  const cls = (M.intent_clf && M.intent_clf.classes_) ? [...M.intent_clf.classes_] : [];
  if (!cls.includes(tgt)) return null;
  const [res2, out2] = await base(ix, q, M, new Map(cls.map((c) => [c, c === tgt ? 1.0 : 0.0])));
  if (!res2.length) return null;
  for (const [, c] of res2) c._ag1 = name;
  return [res2, out2];
}
