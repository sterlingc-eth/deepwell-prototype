/** aggfilter1.js - port of lib/aggfilter1.py (agg_filter_v1): filtered-aggregate hardening (b4 -> before, type-modifier collisions, list intent fix, name gate). */
import { words, stem, hum, STOP, reEscape } from './text.js';
import { pget, osaDist } from './pyx.js';

const DEF = { on: false, collide: 'drop', list_fix: true, name_gate: true, b4: true, min_words: 1 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const PROTECT = new Set(['list', 'lists', 'match', 'part', 'parts', 'lease', 'leases', 'weak', 'string', 'strings']);
function valwords(ix) {
  let c = ix._af_vw;
  if (!c) { c = ix._af_vw = new Set(); for (const p of ix.catphr.keys()) for (const w of p.match(/[a-z0-9]+/g) || []) c.add(w); }
  return c;
}
export function protectedWord(lw, ix = null) {
  if (!pget(CFG, 'protect', true)) return false;
  if (PROTECT.has(lw)) return true;
  try { return ix !== null && ix !== undefined && valwords(ix).has(lw); } catch (e) { return false; }
}
const KSTRAY = /(\$?\s?\d{1,3}(?:,\d{3})+|\$?\s?\d{4,})\s+k\b(?!\w)/gi;
export function normQ(q) {
  if (pget(CFG, 'b4', true)) q = q.replace(/(?<![A-Za-z0-9])b4(?![A-Za-z0-9])/gi, 'before');
  if (pget(CFG, 'kstray', true)) q = q.replace(KSTRAY, '$1');
  return q;
}
const CUE = new Set(['marked', 'flagged', 'tagged', 'labelled', 'labeled', 'listed', 'noted', 'shown', 'as', 'status', 'statsu', 'staus', 'stauts', 'with', 'whose', 'where', 'type', 'kind', 'that', 'which', 'equals']);
function near(a, b) { const k = b.length <= 7 ? 1 : 2; return b.length >= 4 && osaDist(a, b, k) <= k; }
export function dropCollisions(ix, g, ql, vals, F) {
  const C = CFG; const ag = F.ag; const tw = new Set();
  for (const [t] of g.types || []) for (const w of words(hum(t))) tw.add(stem(w));
  for (const w of words(g.syn_phrase || '')) tw.add(stem(w));
  if (!tw.size) return vals;
  const out = [];
  for (const [p, keys] of vals) {
    const pw = words(p);
    if (pw.length < Number(pget(C, 'min_words', 1))) { out.push([p, keys]); continue; }
    const occ = [...ql.matchAll(new RegExp('(?<![a-z0-9])' + reEscape(p) + '(?![a-z0-9])', 'g'))]; let hit = occ.length > 0;
    for (const m of occ) {
      const after = /^\s+([a-z0-9]+)/.exec(ql.slice(m.index + m[0].length)); const nxt = after ? after[1] : '';
      const before = (ql.slice(0, m.index).match(/[a-z0-9']+|[:;,]/g) || []).slice(-3);
      if (!nxt || (!tw.has(stem(nxt)) && !(nxt.length >= 5 && [...tw].some((w) => near(nxt, w)))) || before.some((b) => CUE.has(b) || b === ':' || b === ';')) { hit = false; break; }
    }
    if (hit) {
      if (pget(C, 'collide', 'drop') === 'abstain') { ag.unres = (ag.unres || 0) + 1; out.push([p, keys]); } else ag.coll = (ag.coll || 0) + 1;
      continue;
    }
    out.push([p, keys]);
  }
  return out;
}
const LISTCUE = /(?:^|[\s,:;.?!])(?:list|give\s+me|show\s+me|which|what\s+are|pull\s+up)\b/;
const SUPCUE = /\b(?:latest|last|most\s+recent|recent|newest|earliest|first|oldest|when|date)\b/;
export function fixIntent(g, intent) {
  if (!pget(CFG, 'list_fix', true) || !['latest', 'earliest'].includes(intent)) return intent;
  const ql = g.ql;
  if (LISTCUE.test(ql) && !SUPCUE.test(ql)) return 'list';
  return intent;
}
const FOR = /\b(?:for|from|by)\s+([a-z]{3,})\b/g;
const NOTNAME = new Set('january february march april may june july august september october november december last this next past current previous every each all any year years month months week weeks day days quarter half spring summer fall winter autumn today yesterday tomorrow end late early mid second first third fourth ytd mtd our their its each'.split(' '));
const POSS = /\b([a-z]{3,})'s\b/g;
function nametoks(ix) {
  let c = ix._af_nt;
  if (!c) {
    c = ix._af_nt = new Set();
    for (const cid of ix.c.cust.keys()) { try { for (const w of (ix.name(cid) || '').toLowerCase().match(/[a-z]+/g) || []) if (w.length >= 3) c.add(w); } catch (e) { /* ignore */ } }
  }
  return c;
}
function closename(ix, w) {
  const nt = nametoks(ix);
  if (nt.has(w) || w.length < 3) return false;
  const k = w.length < 6 ? 1 : 2;
  for (const n of nt) if (Math.abs(n.length - w.length) <= k && osaDist(w, n, k) <= k) return true;
  return false;
}
export function nameOrphan(ix, g, ql) {
  if (!pget(CFG, 'name_gate', true) || (g.ents && g.ents.length)) return false;
  for (const m of ql.matchAll(POSS)) { const w = m[1]; if (!ix.vocab.has(w) && !ix.vocab.has(stem(w)) && closename(ix, w)) return true; }
  for (const m of ql.matchAll(FOR)) {
    const w = m[1];
    if (STOP.has(w) || NOTNAME.has(w) || ix.vocab.has(w) || ix.vocab.has(stem(w))) continue;
    if (closename(ix, w)) return true;
  }
  return false;
}
