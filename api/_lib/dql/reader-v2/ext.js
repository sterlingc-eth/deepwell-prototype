/** ext.js - port of lib/ext.py (email cleanup, edit distance, filters / relative dates, document-type phrase candidates). */
import * as DN from './datenorm.js';
import * as AG from './aggv2.js';
import { isAlnum } from './pyc.js';

const GREET = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b/i;
const CLOSE = /^(thanks|thank you|thx|regards|best|cheers|sincerely|warmly|talk soon|sent from|--|kind regards|appreciate)/i;
export function cleanQuestion(q) {
  if (!q.includes('\n') && q.length < 170) return [q, 0];
  const parts = q.split(/\n+|(?<=[.?!])\s+(?=[A-Z])/).map((p) => p.trim()).filter((p) => p);
  const keep = parts.filter((p) => !GREET.test(p) && !CLOSE.test(p) && p.length > 3);
  if (!keep.length) return [q, 0];
  const qs = keep.filter((p) => p.includes('?'));
  if (qs.length) return [qs.slice(0, 2).join(' '), 1];
  const ask = keep.filter((p) => /\b(need|what|how|which|who|when|where|show|find|pull|list|give|tell|look|check|send)\b/i.test(p));
  return [(ask.length ? ask : keep).slice(0, 2).join(' '), 1];
}
/** optimal-string-alignment distance, k+1 when larger than k */
export function osa(a, b, k) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > k) return k + 1;
  let prev2 = null; let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1).fill(0); cur[0] = i; const lo = Math.max(1, i - k), hi = Math.min(lb, i + k);
    if (lo > 1) cur[lo - 1] = k + 1;
    let best = lo === 1 ? cur[0] : k + 1;
    for (let j = lo; j <= hi; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && prev2 !== null) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; best = Math.min(best, v);
    }
    if (best > k) return k + 1;
    prev2 = prev; prev = cur;
  }
  return Math.min(prev[lb], k + 1);
}
export const GENERIC = new Set('dated after before since during came filed back last this that year month quarter week status total count combined value sum amount number how many much what which show list give tell find all every each latest earliest newest oldest highest lowest largest smallest biggest paid unpaid open closed from between and the for with have has had are were was does did'.split(' '));
export function st(w) {
  for (const [suf, rep] of [['ies', 'y'], ['sses', 'ss'], ['ses', 's'], ['s', '']]) if (w.endsWith(suf) && w.length > suf.length + 2) return w.slice(0, w.length - suf.length) + rep;
  return w;
}
const MON3 = {}; ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].forEach((m, i) => { MON3[m.slice(0, 3)] = i + 1; });
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function monthYear(ql) {
  const out = [];
  for (const m of ql.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(?:of\s+)?(\d{4})\b/g)) {
    const mo = MON3[m[1].slice(0, 3)]; const y = parseInt(m[2], 10);
    out.push([dd(y, mo, 1), dd(y, mo, monthEnd(y, mo)), [m.index, m.index + m[0].length]]);
  }
  return out;
}
export class Filt {
  constructor() { this.conds = []; this.kinds = new Set(); this.bad = false; this.desc = []; this.conf = 1.0; this.amb = false; this.nsp = 0; this.ncmp = 0; this.ag = {}; }
  get length() { return this.conds.length; }
  truthy() { return this.conds.length > 0; }
  ok(x) { return this.conds.every((c) => c(x)); }
}
const CUES = new RegExp("\\b(?:ytd|mtd|qtd|ttm|ago|fiscal|fy\\s?\\d*|q[1-4]|h[12]|(?:first|second|third|fourth)\\s+quarter|(?:first|second)\\s+half"
  + "|(?:last|past|previous|prior|next|this|current|coming|trailing|rolling|preceding)\\s+(?:calendar\\s+)?(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|couple(?:\\s+of)?|few|several)?\\s*\\w*\\s*(?:day|week|month|quarter|year|season|spring|summer|fall|autumn|winter|weekend)s?\\b"
  + "|(?:last|past|previous|prior|next|trailing)\\s+\\d+\\s+\\w+"
  + "|\\d+\\s*(?:day|week|month|quarter|year)s?\\s+(?:ago|back|earlier)"
  + "|\\bhalf\\b|\\bquarter\\b|\\bqtr\\b|\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b"
  + "|(?:in|during|since|until|through|before|after|by)\\s+(?:the\\s+)?(?:spring|summer|fall|autumn|winter|" + DN._MONRE + ")\\b)", 'g');
const AMT_CUES = /\b(?:over|above|under|below|more than|less than|greater than|at least|at most|no more than|no less than|up to|exceeding|between)\s+(?:\$|usd\s?\d|[\d,.]+\s?(?:k|m|mm|mil|thousand|million|dollars|bucks)\b)|\$\s?\d/g;
export function unparsedCues(ql, claimed, typeWords) {
  let s = ql;
  for (const [a, b] of claimed) s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
  let out = [...s.matchAll(CUES)].map((m) => m[0]).concat([...s.matchAll(AMT_CUES)].map((m) => m[0]));
  if (typeWords && typeWords.size) out = out.filter((c) => !(c.match(/[a-z0-9]+/g) || []).every((w) => typeWords.has(w)));
  return out;
}
const overlaps = (a, b, spans) => spans.some(([x, y]) => !(b <= x || a >= y));
const OPS = {
  after: (d, iso) => d > iso, since: (d, iso) => d >= iso, 'on or after': (d, iso) => d >= iso,
  before: (d, iso) => d < iso, 'prior to': (d, iso) => d < iso, until: (d, iso) => d <= iso, through: (d, iso) => d <= iso, 'on or before': (d, iso) => d <= iso,
};
const OPRX = /(on or after|on or before|after|since|before|prior to|until|through)\s*$/;
export function parseFilters(ix, g, dnCfg = DN.cfg()) {
  const ql = g.ql; const F = new Filt(); const today = ix.today; const C = dnCfg; const applyC = parseFloat(C.apply_conf ?? 0.7); const relAmb = !!C.release_ambiguous;
  const dts = g.dates; const used = [];
  const bt = /between\s+(.+?)\s+and\s+(.+?)(?:\?|$|\s(?:for|with|in|of)\b)/.exec(ql);
  if (bt && dts.length >= 2) {
    const [i1, i2] = [dts[0][1], dts[1][1]].sort(); F.conds.push((x) => i1 <= x.date && x.date <= i2); F.kinds.add('range'); F.desc.push(`between ${i1} and ${i2}`); used.push(dts[0][0], dts[1][0]);
  } else {
    for (const [[a, b], iso] of dts) {
      const m = OPRX.exec(ql.slice(Math.max(0, a - 14), a)); if (!m) continue;
      const op = OPS[m[1]]; F.conds.push((x) => op(x.date, iso)); F.kinds.add('range'); F.desc.push(`${m[1]} ${iso}`); used.push([a, b]);
    }
  }
  let keep = (g.spans || []).filter(([, , tag]) => ['NAME', 'ADDR', 'DOCNO'].includes(tag)).map(([a, b]) => [a, b]);
  keep = AG.realKeep(g, keep);
  const dsp = dts.map(([sp]) => sp);
  let spans = DN.resolveDates(ql, today).filter((s) => !overlaps(s.start, s.end, keep) && !overlaps(s.start, s.end, dsp));
  const cmps = DN.parseComparisons(ql).filter((c) => !overlaps(c.start, c.end, keep) && !overlaps(c.start, c.end, dsp));
  const soft = spans.filter((s) => s.soft); const ysp = [];
  if (soft.length) {
    if ((spans.length - soft.length) + dts.length + cmps.length + (ql.match(/\b(?:19|20)\d\d\b/g) || []).length + monthYear(ql).length > 0) {
      for (const s of soft) ysp.push([s.start, s.end]); spans = spans.filter((s) => !s.soft);
    }
  }
  for (const s of spans) {
    const [lo, hi] = s.iso();
    if (s.conf < applyC && !relAmb) F.bad = true;
    F.conds.push((x) => lo <= x.date && x.date <= hi);
    F.kinds.add(s.kind === 'rel' ? 'rel' : (s.kind === 'open' ? 'range' : 'month')); F.desc.push(s.label); ysp.push([s.start, s.end]);
    F.conf = Math.min(F.conf, s.conf);
  }
  F.nsp = spans.length;
  const my = monthYear(ql).filter((m) => !overlaps(m[2][0], m[2][1], ysp));
  for (const [lo, hi, sp] of my) { F.conds.push((x) => lo <= x.date && x.date <= hi); F.kinds.add('month'); F.desc.push(lo.slice(0, 7)); ysp.push(sp); }
  if (my.length + spans.filter((s) => s.kind !== 'open').length > 1) F.bad = true;
  const asp = [];
  for (const c of cmps) {
    if (c.conf < applyC && !relAmb) F.bad = true;
    F.conds.push((x) => x.tot !== null && x.tot !== undefined && c.ok(x.tot)); F.kinds.add('amount'); F.desc.push(c.desc()); asp.push([c.start, c.end]); F.conf = Math.min(F.conf, c.conf);
  }
  F.ncmp = cmps.length;
  const declineUnparsed = C.decline_unparsed !== false;
  if (declineUnparsed && cmps.some((c) => /^\s?(?:thou|thos|mill|mil\w|doll|buck|gran)/.test(ql.slice(c.end, c.end + 12)))) { F.bad = true; F.conf = Math.min(F.conf, 0.3); }
  if (declineUnparsed) {
    let tw = ix._dn_typewords;
    if (!tw) { tw = ix._dn_typewords = new Set(); for (const t of ix.types || []) for (const w of (t.toLowerCase().replace(/[_-]+/g, ' ').match(/[a-z0-9]+/g) || [])) tw.add(w); }
    const un = unparsedCues(ql, [...ysp, ...asp, ...dsp, ...keep, ...used], tw);
    if (un.length) { F.bad = true; F.conf = Math.min(F.conf, 0.3); }
  }
  F.amb = F.conf < 0.9;
  let mq = g.mask;
  for (const [a, b] of [...ysp, ...asp]) mq = mq.slice(0, a) + ' '.repeat(b - a) + mq.slice(b);
  const yrs = (mq.replace(/\b[A-Za-z]{1,6}(?:-\d{2,7})+\b/g, ' ').replace(/\$\s?[\d,]+(?:\.\d+)?/g, ' ')).match(/\b((?:19|20)\d\d)\b/g) || [];
  if (yrs.length === 1 && !ysp.length) { const y = yrs[0]; F.conds.push((x) => x.date.slice(0, 4) === y); F.kinds.add('year'); F.desc.push(y); }
  else if (yrs.length === 1 && ysp.length) { const y = yrs[0]; F.conds.push((x) => x.date.slice(0, 4) === y); F.kinds.add('year'); F.desc.push(y); }
  else if (yrs.length >= 2 && !ysp.length) {
    const lo = yrs.reduce((p, c) => (c < p ? c : p)), hi = yrs.reduce((p, c) => (c > p ? c : p));
    if (/\b(between|from|through|to|thru|and|-)\b/.test(ql) && !/\bor\b/.test(ql)) { F.conds.push((x) => lo <= x.date.slice(0, 4) && x.date.slice(0, 4) <= hi); F.kinds.add('year'); F.desc.push(`${lo}-${hi}`); }
    else F.bad = true;
  } else if (yrs.length >= 2) F.bad = true;
  if (F.kinds.has('rel') && (F.kinds.has('year') || F.kinds.has('month') || F.kinds.has('range'))) F.bad = true;
  let vals = [];
  if (ix.cat_re) {
    let sp = (g.spans || []).filter(([, , tag]) => tag === 'NAME' || tag === 'ADDR').map(([a, b]) => [a, b]);
    if (!(g.ents && g.ents.length)) sp = [];
    for (const m of ql.matchAll(ix.cat_re)) {
      const a = m.index, b = m.index + m[0].length;
      if (sp.some(([x, y]) => !(b <= x || a >= y))) continue;
      vals.push([m[1], ix.catphr.get(m[1])[0]]);
    }
  }
  vals = vals.filter((v) => !vals.some((w) => v[0] !== w[0] && w[0].includes(v[0])));
  vals = AG.fieldVals(ix, g, ql, vals, F);
  const seen = new Set();
  for (const [phrase, keys] of vals.slice(0, 2)) {
    if (seen.has(phrase)) continue; seen.add(phrase);
    F.conds.push((x) => keys.some((k) => ((x.fields.get(k) || '').toLowerCase()) === phrase)); F.kinds.add('field'); F.desc.push(phrase);
  }
  for (const phrase of ix.paywords) if (new RegExp('\\b' + phrase + '\\b').test(ql)) { F.conds.push((x) => x.pay === phrase); F.kinds.add('pay'); F.desc.push(phrase); }
  AG.labelFilters(ix, g, ql, F);
  return F;
}
const SYN_STOP = new Set('a an the of for on in at to is are was were be what whats which who how when where do does did we our you your me my i it its this that these those and or by with from about please can could tell give need want show get see find any all every many much number total count list latest earliest first last oldest newest most recent highest lowest largest smallest biggest how many year month status name'.split(' '));
export { SYN_STOP };
export function phraseCandidates(maskWords) {
  const out = []; const n = maskWords.length;
  for (const L of [3, 2, 1]) {
    for (let i = 0; i <= n - L; i++) {
      const w = maskWords.slice(i, i + L);
      if (SYN_STOP.has(w[0]) || SYN_STOP.has(w[w.length - 1])) continue;
      if (w.some((x) => ['doctype', 'doctypes', 'name', 'year', 'docno', 'date', 'addr'].includes(x))) continue;
      if (w.slice(1, -1).some((x) => SYN_STOP.has(x))) continue;
      out.push(w.join(' '));
    }
  }
  return out;
}
