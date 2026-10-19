/** mentionparty.js - port of lib/mentionparty.py (mention_party_v1): mention / find / party intent disambiguation for questions that name exactly one document number. */
import { cleanQuestion } from './ext.js';
import { getCloseMatches } from './difflib.js';
import { setOf, union, isSubset, intersects } from './pyx.js';

const ALL = ['F1', 'M1', 'P1', 'V1'];
const DEF = { on: false, rules: ALL };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const DOCNO = /\b[A-Za-z]{1,6}(?:-\d{2,7})+\b/g;
const FILL = setOf('tomorrow today tonight later soon thank and a an the this that it its me my our us of to for in on at is are was be do does can could would will you i we please pls plz thanks thank kindly just now quick quickly there up');
const MEN_EV = setOf('mention mentions mentioned mentioning reference references referenced referencing appear appears appearing appeared search searches searching across anywhere contain contains containing contained include includes included including talk talks talking show shows showing anything any every all files documents docs paperwork papers');
const MEN_OK = setOf('which what where whose does do is are have has with them it in on up about check if look for find any anything that docs documents files file paperwork papers document doc can');
const FIND_EV = setOf('where wheres pull open bring get grab fetch retrieve locate find show display view see review dig lookup look take put screen filed i want need id like give let');
const FIND_OK = setOf('where wheres whats what is it document doc file paper filed up out front pulled bring pull open show me my on screen i want need to see view review dig look find locate get grab fetch retrieve display take put in id like give let here');
const PARTY_EV = setOf('who whos whose whom belongs belong belonging belongs signed signature named name names issued');
const PARTY_OK = setOf('who whos whose whom which what is it was did go goes belongs belong belonging to under name names named on of for made out issued signed signature paperwork file the person people behind tied prepared i need call send back with by');
const FIELDW = setOf('paid pay owe owed amount total date due balance status price cost rent phone email address number charge fee deposit term terms when how much many');
const SPLIT = /[:.?!,;\n]+/g;
const RSPLIT = /[.?!,;\n]+/;
function window(q) {
  const m = [...q.matchAll(DOCNO)];
  if (m.length !== 1) return [null, null];
  const mm = m[0]; const a = q.slice(0, mm.index); const b = q.slice(mm.index + mm[0].length);
  const cuts = [...a.matchAll(SPLIT)].map((x) => x.index + x[0].length); const left = cuts.length ? a.slice(cuts[cuts.length - 1]) : a;
  const s = RSPLIT.exec(b); const right = s ? b.slice(0, s.index) : b;
  return [left, right];
}
const VOC = [...setOf('mention mentions mentioned reference references referenced appear appears search contain contains containing anywhere across document documents files paperwork papers include includes')].sort();
const ALLV = union(MEN_EV, MEN_OK, FIND_EV, FIND_OK, PARTY_EV, PARTY_OK, FILL);
const NT = new Map();
function normTok(t) {
  if (NT.has(t)) return NT.get(t);
  let r = t;
  if (t.length >= 5 && !ALLV.has(t)) {
    const m = getCloseMatches(t, VOC, 1, 0.85).filter((w) => w[0] === t[0] || w[1] === t[1]);
    if (m.length) r = m[0];
  }
  NT.set(t, r); return r;
}
const TAIL = /\s*[-(]*\s*(?:sooner is better|thanks a lot|many thanks|thank you|thx|cheers|urgent|asap|if you can|when you get a chance|no rush)\)?\s*$/gi;
const MEN_LOOSE = /search|mention|referen|appear|contain|talk|across|anywhere|any of our|in them|on them|show up|includ|\bfiles?\b|\bdocs?\b|documents?|paperwork|papers/i;
const FIELDASK = /^\s*(?:tell me|give me|get me|what(?:'?s| is| are)?|whats)\s+(?:the\s+)?[\w ]{1,25}?\s+(?:for|on|of|under|about)\s*$/i;
export function mentionIsh(q) {
  q = q || '';
  return MEN_LOOSE.test(q) || (q.toLowerCase().match(/[a-z]{4,}/g) || []).some((t) => MEN_EV.has(normTok(t)));
}
const MENTION_W = setOf('mention mentions mentioned reference references referenced appear appears search across anywhere contain contains containing include includes talk any anything every all files documents docs paperwork papers show');
const MENTION_W2 = setOf('mention mentions mentioned reference references referenced appear appears search across anywhere contain contains containing include includes talk any anything every all files documents docs paperwork papers');
const WHO = setOf('who whos whose whom');
const MEN_ALL = union(MEN_EV, MEN_OK, FILL);
export function form(q) {
  q = (q || '').replace(TAIL, '');
  const [left, right] = window(q);
  if (left === null) return [null, false];
  if (/[^A-Za-z' \-()]/.test(left + right.split(' - ').join(' '))) return [null, true];
  let toks = (( left + ' ' + right).toLowerCase().split("'s").join('s').match(/[a-z']+/g)) || [];
  toks = toks.map((t) => t.split("'").join(''));
  const rawT = toks; toks = toks.map(normTok);
  if (rawT.some((a, i) => a !== toks[i] && ['document', 'documents', 'doc', 'docs'].includes(toks[i]))) return [null, true];
  toks = toks.filter((t) => !['pls', 'please', 'plz', 'thanks', 'cheers', 'asap', 'urgent', 'abt'].includes(t));
  if (!toks.length) return [null, true];
  const ts = new Set(toks);
  if (ts.has('show') && ts.has('up') && (ts.has('where') || ts.has('does')) && !intersects(ts, PARTY_EV) && isSubset(ts, union(MEN_EV, MEN_OK, FILL, new Set(['where', 'does'])))) return ['mention', true];
  if (intersects(ts, MEN_EV) && isSubset(ts, MEN_ALL) && intersects(ts, MENTION_W) && !intersects(ts, WHO)) {
    if (intersects(ts, MENTION_W2)) return ['mention', true];
  }
  const pev = new Set([...PARTY_EV].filter((x) => x !== 'name' && x !== 'names'));
  const ev = intersects(ts, pev) || toks.some((t, i) => (t === 'name' || t === 'names') && i + 1 < toks.length && ['on', 'of', 'tied', 'appears'].includes(toks[i + 1]));
  if (ev && !intersects(ts, FIELDW)) {
    const unk = []; toks.forEach((t, i) => { if (!PARTY_OK.has(t) && !FILL.has(t) && t !== 'tell' && t !== 'give') unk.push(i); });
    if (unk.every((i) => i > 0 && ['which', 'what', 'the', 'a'].includes(toks[i - 1])) && unk.length <= 1) return ['party', true];
  }
  const menMinus = new Set([...MEN_EV].filter((x) => !['show', 'find', 'any'].includes(x)));
  if (intersects(ts, FIND_EV) && isSubset(ts, union(FIND_OK, FILL)) && !intersects(ts, menMinus)) return ['find', true];
  return [null, true];
}
const RULE = { find: 'F1', mention: 'M1', party: 'P1' };
export function route(q, intent) {
  const on = new Set(CFG.rules || ALL);
  const [f, has] = form(q);
  if (f !== null) { const r = RULE[f]; return (on.has(r) && intent !== f) ? [r, f] : null; }
  if (has && intent === 'mention' && on.has('V1') && !mentionIsh(q) && FIELDASK.test(window(q)[0] || '')) return ['V1', null];
  return null;
}
export async function reroute(ix, q, M, res, out, base) {
  const [q2] = cleanQuestion(q);
  const r = route(q2, out.intent);
  if (r === null) return null;
  const [name, tgt] = r;
  if (tgt === null) { for (const [, c] of res) if (!c._hv2) c._hv2 = 'mp1:' + name; return null; }
  const cls = (M.intent_clf && M.intent_clf.classes_) ? [...M.intent_clf.classes_] : [];
  if (!cls.includes(tgt)) return null;
  const mass = Number(CFG.mass ?? 1.0); let P2;
  if (mass >= 1.0) P2 = new Map(cls.map((c) => [c, c === tgt ? 1.0 : 0.0]));
  else {
    const Pn = await M.intentProba(out.masked); let oth = 0; for (const [k, v] of Pn) if (k !== tgt) oth += v; oth = oth || 1.0;
    P2 = new Map(cls.map((c) => [c, c === tgt ? mass : (1.0 - mass) * (Pn.has(c) ? Pn.get(c) : 0.0) / oth]));
  }
  const [res2, out2] = await base(ix, q, M, P2);
  if (!res2.length) return null;
  for (const [, c] of res2) c._mp1 = name;
  return [res2, out2];
}
