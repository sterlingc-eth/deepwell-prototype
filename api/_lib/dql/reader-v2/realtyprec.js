/** realtyprec.js - port of lib/realtyprec.py (realty_prec_v1): stricter-only text vetoes, typo-tolerant contact keywords, concept-ranked fields, reader agreement key. */
import { lev as levp } from './pyx.js';
import { words as wordsOf, stem as stemOf, hum } from './text.js';
import { parseFilters } from './ext.js';
import * as AG from './aggv2.js';
import { sortedBy, cap } from './pyc.js';

const ALL = ['contact', 'status', 'filter_drop', 'unit_kind', 'when_date', 'money_bound', 'order_flip'];
let CFG = { on: false, rules: ALL };
export const configure = (d) => { CFG = { on: false, rules: ALL, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const pyget = (k, dflt) => (Object.prototype.hasOwnProperty.call(CFG, k) ? CFG[k] : dflt);
const lev = (a, b, k = 2) => levp(a, b, k);
const toks = (ql) => ql.match(/[a-z]+/g) || [];
const EMAILW = new Set(['email', 'emails', 'e-mail', 'emial', 'emali', 'emaill', 'emil']);
const PHONE = /(\(\d{3}\)\s*|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b/;
const DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4})/i;
const STATUS = new Set(['unpaid', 'paid', 'overdue', 'expired', 'pending', 'withdrawn', 'cancelled', 'canceled', 'delinquent', 'outstanding']);
const ROLE = [['buyer', 'seller'], ['seller', 'buyer'], ['tenant', 'landlord'], ['landlord', 'tenant'], ['lessee', 'lessor'], ['lessor', 'lessee']];
const FAM = { late: ['latest', 'newest', 'recent'], early: ['earliest', 'oldest', 'initial'], high: ['highest', 'largest', 'biggest', 'greatest', 'priciest'], low: ['lowest', 'smallest', 'cheapest', 'fewest', 'tiniest'] };
function famOf(tk) {
  const got = new Set();
  for (const [f, ws] of Object.entries(FAM)) for (const t of tk) for (const w of ws) if (t === w || (t.length >= 5 && w.length >= 5 && lev(t, w, 2) <= 2)) got.add(f);
  return got;
}
const HEAD = /^(latest|earliest|highest|lowest) /i;
const OPPF = { late: 'early', early: 'late', high: 'low', low: 'high' };
export const GENW = new Set(['sheet', 'report', 'statement', 'letter', 'notice', 'form', 'request', 'record', 'summary', 'document', 'file', 'packet', 'agreement', 'contract', 'order', 'bill', 'invoice', 'slip', 'log', 'ticket', 'note', 'memo', 'certificate', 'receipt', 'estimate', 'bid', 'quote', 'paper', 'papers']);
const stem = (w) => (w.length > 4 ? w.replace(/(ies|es|s)$/, '') : w.replace(/s+$/, ''));
export function answerType(text) {
  const t = text || '';
  let m = /^(?:Latest|Earliest|Highest|Lowest) (.+?)(?: for | \(|:|$)/.exec(t);
  if (m) return m[1];
  m = /^(?:Total of \d+|\d+|[A-Z][^0-9]*? has \d+|All) (.+?)s?(?: on file| for |\s\(|:|$)/.exec(t);
  if (m) return m[1];
  return null;
}
function alias(qtoks, tt, ctx) {
  if (!ctx) return false;
  for (const L of [1, 2, 3]) for (let i = 0; i < qtoks.length - L + 1; i++) if (ctx(qtoks.slice(i, i + L).join(' '), tt)) return true;
  return false;
}
export function fixText(text) {
  const t = text || '';
  if (!pyget('format', true)) return t;
  const i = t.indexOf(' (page ');
  if (i < 0) return t;
  const span = t.slice(0, i), rest = t.slice(i);
  const span2 = span.replace(/\s*\(([^()]*\d[^()]*)\)/g, ' $1');
  return span2 !== span ? span2 + rest : t;
}
const FILT = [
  /\b(?:whose|where|with|and)\s+(?:the\s+)?[a-z][a-z ]{2,24}?\s+(?:is|are|equals|=)\s+([a-z0-9][a-z0-9\- ]{1,30})/g,
  /\b(?:marked|listed as|labell?ed|tagged|flagged|noted as)\s+([a-z0-9][a-z0-9\- ]{1,30})/g,
  /\bwith\s+(?:[a-z]+\s+){0,2}status\s+([a-z0-9][a-z0-9\-]{2,20})/g];
const FSTOP = new Set(['the', 'and', 'for', 'pls', 'please', 'thanks', 'thx', 'this', 'that', 'file', 'before', 'after', 'from', 'with', 'what', 'about', 'how', 'many', 'any', 'all', 'count', 'total', 'there', 'have', 'has', 'are', 'was', 'were', 'asap', 'now', 'today', 'tomorrow', 'week', 'year', 'month', 'owner', 'buyer', 'seller', 'tenant', 'lender', 'title', 'broker', 'agent']);
export function filterDropped(ql, tl) {
  if (!/^(\d+ |total of |latest |earliest |highest |lowest |all |[a-z .'-]+ has \d+|[a-z .'-]+'s )/.test(tl)) return false;
  const head = tl.slice(0, 200);
  for (const rx of FILT) {
    for (const m of ql.matchAll(rx)) {
      const ws = (m[1].match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !FSTOP.has(w));
      if (!ws.length) continue;
      const w = ws[0];
      if (!(head.match(/[a-z0-9]+/g) || []).some((t) => w === t || (w.length >= 5 && t.length >= 5 && lev(w, t, 1) <= 1) || t.startsWith(w.slice(0, 5)))) return true;
    }
  }
  return false;
}
const pySearch = (rx, s) => rx.test(s);
export function veto(q, text, rules = null, aliasFn = null) {
  rules = rules && rules.length ? rules : (CFG.rules && CFG.rules.length ? CFG.rules : ALL);
  if (typeof rules === 'string') rules = [rules];
  let ql = (q || '').toLowerCase().replace(/(sent )?(from|on|via) my (phone|cell|mobile|iphone)/g, ' ');
  ql = ql.replace(/\b(long|this|that|the|my|your|an|prior|earlier|previous|forwarded|below|email) (e-?mails?|emails? thread|threads?)\b/g, ' ');
  const tl = (text || '').toLowerCase(); const tk = toks(ql); const tx = text || '';
  if (rules.includes('contact') && /^[^:(]{3,60}: (\S+@\S+|\d+ [^,:]+, [^,:]+, [A-Z]{2} \d{5}|(\(\d{3}\)\s*|\d{3}[-. ])\d{3}[-. ]\d{4})/.test(tx)) {
    const em = tk.some((t) => EMAILW.has(t) || ([4, 5, 6].includes(t.length) && t[0] === 'e' && t.endsWith('l') && lev(t, 'email', 2) <= 2)) || ql.includes('e-mail');
    const ph = tk.some((t) => ['phone', 'telephone', 'cell', 'mobile', 'fone', 'phne'].includes(t));
    const hasAt = tl.includes('@'); const hasPh = PHONE.test(tx);
    if (em && !ph && !hasAt) return 'contact';
    if (ph && !em && !hasPh) return 'contact';
  }
  if (rules.includes('list_shape')) {
    if (/\b(list|lists|listing out|enumerate)\b/.test(ql) && /^(latest|earliest|highest|lowest|total of)\b/.test(tl) && !/\b(latest|newest|most recent|earliest|oldest|first|last|highest|lowest|total|sum)\b/.test(ql)) return 'list_shape';
  }
  if (rules.includes('status')) {
    const st = tk.filter((t) => STATUS.has(t));
    if (st.length && /^(latest|earliest|highest|lowest|total of|\d+ |[a-z .'-]+ has \d+|[a-z .'-]+'s)/.test(tl)) {
      if (!st.some((s) => tl.includes(s))) return 'status';
    }
  }
  if (rules.includes('filter_drop') && filterDropped(ql, tl)) return 'filter_drop';
  if (rules.includes('unit_kind')) {
    const unit = /\b(units|uints|unis|sq ?ft|sqft|square f\w+|footage|acres|bedrooms|bathrooms)\b/.test(ql);
    if (unit && /^(total: \$|(highest|lowest) [^:(]*(\([^)]*\))?: \$)/.test(tl)) return 'unit_kind';
  }
  if (rules.includes('when_date')) {
    if (/\b(when was|when is|what date|which day|what day|date of|date on)\b/.test(ql) && !/\b(how many|count|number of|how long|total)\b/.test(ql) && !/^(total of|\d+ |all |[a-z .']+ has \d)/.test(tl) && !tl.includes(' on file') && !DATE.test(tx)) return 'when_date';
  }
  if (rules.includes('role')) {
    for (const [a, b] of ROLE) {
      if (new RegExp('\\b' + a + "(s|'s)?\\b").test(ql) && !new RegExp('\\b' + b + "(s|'s)?\\b").test(ql) && new RegExp('\\b' + b + '\\b').test(tl) && !new RegExp('\\b' + a + '\\b').test(tl)) return 'role';
    }
  }
  if (rules.includes('money_bound')) {
    if (/\$\s?0+\s?[mkb]\b/.test(ql) || /(under|less than|over|above|below|more than|exceeding|between|up to|at least|at most|\$|and|to)\s*\$?\d{3,}\s[kmb]\b/.test(ql)) return 'money_bound';
  }
  if (rules.includes('order_flip')) {
    const mh = HEAD.exec(tx);
    if (mh) {
      const h = mh[1].toLowerCase(); const mine = { latest: 'late', earliest: 'early', highest: 'high', lowest: 'low' }[h];
      const fs = famOf(tk);
      if (fs.has(OPPF[mine]) && !fs.has(mine)) return 'order_flip';
    }
  }
  if (tx.includes(' (page ')) {
    const sp = tx.slice(0, tx.indexOf(' (page '));
    if (rules.includes('frag_case') && /^\p{Ll}/u.test(sp.slice(0, 1))) return 'frag_case';
    if (rules.includes('frag_end') && !/[.!?]["']?$/.test(sp.trim())) return 'frag_end';
    if (rules.includes('frag_ocr') && /[a-z]\d[a-z]/.test(sp)) return 'frag_ocr';
  }
  if (rules.includes('type_echo')) {
    const tt = answerType(tx);
    if (tt) {
      const gen = new Set([...GENW].map(stem));
      const tw = (tt.toLowerCase().match(/[a-z]+/g) || []).map(stem);
      const qs = tk.map(stem);
      const ok = tw.filter((w) => !gen.has(w)).some((w) => qs.includes(w) || qs.some((x) => w.length >= 5 && x.length >= 5 && lev(w, x, 1) <= 1));
      if (!ok && !alias(qs, tt, aliasFn)) return 'type_echo';
    }
  }
  return null;
}
// ---------------------------------------------------------------------------------------------------- coverage helpers
export function contactKw(ql) {
  if (!pyget('rank', true)) return [];
  ql = ql.replace(/(sent )?(from|on|via) my (phone|cell|mobile|iphone)/g, ' ');
  ql = ql.replace(/\b(long|this|that|the|my|your|an|prior|earlier|previous|forwarded|below) (e-?mails?|emails? thread)\b/g, ' ');
  const tk = ql.match(/[a-z-]+/g) || []; const out = [];
  if (tk.some((t) => EMAILW.has(t) || ([4, 5, 6].includes(t.length) && t[0] === 'e' && t.endsWith('l') && lev(t, 'email', 2) <= 2))) out.push('email');
  if (tk.some((t) => t.length >= 4 && 'pf'.includes(t[0]) && lev(t, 'phone', 1) <= 1) || tk.some((t) => t === 'fone' || t === 'telephone')) out.push('phone');
  if (!out.length && tk.some((t) => t.length >= 6 && t[0] === 'a' && lev(t, 'address', 2) <= 2)) out.push('service_address');
  return out.length === 1 ? out : [];
}
const CONCEPTS = {
  dues: [['hoa fee', 'dues per month', 'monthly dues', 'hoa dues', 'monthly hoa fee', 'association dues'], ['hoa fee', 'monthly dues', 'dues per month', 'hoa dues', 'association fee', 'association dues', 'monthly hoa', 'monthly fee', 'hoa monthly', 'dues']],
  price: [['asking price', 'price on sheet', 'list price', 'listing price'], ['asking price', 'list price', 'listing price', 'price on the sheet', 'price on sheet', 'asking', 'listed price']],
  sqft: [['sqft', 'square feet', 'square footage', 'sq ft'], ['sqft', 'sq ft', 'square footage', 'square feet', 'square foot', 'square f', 'footage', 'size']],
  dom: [['market days', 'days on market'], ['days on market', 'market days', 'dom', 'time on market', 'longest on the market', 'days listed']],
  delinq: [['delinquent total', 'delinquency', 'delinquent amount'], ['delinquency', 'delinquent', 'past due', 'arrears', 'behind on rent', 'unpaid rent']],
  defects: [['defects found', 'defect count'], ['defects', 'defects found', 'deficiencies', 'issues found']],
  value: [['value conclusion', 'valuation amount', 'appraised value'], ['appraised value', 'valuation', 'value conclusion', 'appraisal value', 'appraised at']],
  units: [['total units', 'unit count'], ['total units', 'unit count', 'number of units', 'units']],
  beds: [['beds', 'bedrooms'], ['beds', 'bedrooms', 'bedroom count']],
  baths: [['baths', 'bathrooms'], ['baths', 'bathrooms']],
  cuts: [['price cuts', 'reduction count', 'price reductions'], ['price cuts', 'reductions', 'price reductions', 'reduction count']],
  comps: [['comps count', 'comps used'], ['comps used', 'comps count', 'comparables']],
};
const wset = (p) => (p.toLowerCase().match(/[a-z]+/g) || []).map(stem);
const isSub = (a, b) => [...a].every((x) => b.has(x));
export function conceptsOfLabel(label) {
  const lw = new Set(wset(label)); const out = new Set();
  for (const [c, [kp]] of Object.entries(CONCEPTS)) if (kp.some((p) => isSub(new Set(wset(p)), lw))) out.add(c);
  return out;
}
export function conceptsOfQuestion(ql) {
  const qj = wset(ql).join(' '); const out = new Set();
  for (const [c, [, qp]] of Object.entries(CONCEPTS)) if (qp.some((p) => (' ' + wset(p).join(' ') + ' ').length && (' ' + qj + ' ').includes(' ' + wset(p).join(' ') + ' '))) out.add(c);
  return out;
}
export function conceptKeys(ix, t, ql, numericKeys) {
  const qc = conceptsOfQuestion(ql);
  if (!qc.size) return [];
  return numericKeys.filter((k) => [...conceptsOfLabel(k.replace(/[_-]+/g, ' '))].some((c) => qc.has(c)));
}
export function rankType(ix, g) {
  if (!pyget('rank', true)) return null;
  const ql = g.ql;
  if (!Object.values(AG.SUP_SRC).some((p) => new RegExp(p).test(ql))) return null;
  const qc = conceptsOfQuestion(ql);
  if (!qc.size) return null;
  const cand = g.types.length > 1 ? g.types.map((z) => z[0]) : [...ix.by_t.keys()];
  const hit = [];
  for (const t of cand) {
    if ((ix.by_t.get(t) || []).length < 2) continue;
    if (conceptKeys(ix, t, ql, AG.numericKeys(ix, t)).length) hit.push(t);
  }
  if (hit.length !== 1) return null;
  const t = hit[0];
  if (g.types.length <= 1) {
    const tw = (t.replace(/-/g, ' ').match(/[a-z]+/g) || []).map(stem); const qs = (ql.match(/[a-z]+/g) || []).map(stem);
    const gs = new Set([...GENW].map(stem));
    if (!tw.filter((w) => !gs.has(w)).some((w) => w.length >= 4 && qs.some((x) => w === x || (x.length >= 5 && lev(w, x, 1) <= 1)))) return null;
  }
  return [t, false];
}
export function rank2(ix, g, F, no, ok, intent) {
  if (!pyget('rank', true)) return null;
  const ql = g.ql; const types = g.types;
  if (types.length !== 1 || g.nums.length) return null;
  const d = Object.entries(AG.SUP_SRC).filter(([, p]) => new RegExp(p).test(ql)).map(([k]) => k);
  if (d.length !== 1) return null;
  const dir = d[0]; const t = types[0][0];
  const best = conceptKeys(ix, t, ql, AG.numericKeys(ix, t));
  if (best.length !== 1) return null;
  const key = best[0];
  const FL = parseFilters(ix, g);
  Object.assign(F, { n_filters: FL.conds.length, filt_year: +FL.kinds.has('year'), filt_rel: +FL.kinds.has('rel'), filt_range: +(FL.kinds.has('range') || FL.kinds.has('month')), f_amount: +FL.kinds.has('amount') });
  if (FL.bad) return no('unclear date range or filter', intent);
  const ents = g.ents; let ent = null;
  if (ents.length) { if (ents[0][1].length > 1) return no('name matches more than one record', intent); ent = ents[0][1][0]; }
  const allx = ent ? (ix.by_ct.get(`${ent}\u0001${t}`) || []) : ix.by_t.get(t);
  const xs = allx.filter((x) => FL.ok(x));
  const [why, af] = AG.gate(ix, t, ent, allx, xs, FL, F.unk ?? 0); Object.assign(F, af);
  if (why) return no(why, intent);
  if (xs.length < 2) return no('tie or no values', intent);
  const vals = xs.map((x) => [AG.num(x.fields.get(key)), x]);
  if (vals.some(([v]) => v === null)) return no('some documents have no value for that field', intent);
  const sv = sortedBy(vals, (z) => z[0]);
  const [a, b] = dir === 'max' ? [sv[sv.length - 1], sv[sv.length - 2]] : [sv[0], sv[1]];
  if (a[0] === b[0]) return no('tie or no values', intent);
  const x = a[1]; const fdesc = FL.desc.join(', '); const sfx = fdesc ? ` (${fdesc})` : '';
  const who = x.cust ? ix.name(x.cust) : null; const ident = [];
  for (const [k, v] of x.fields) if (k !== key && v && String(v).length <= 40 && AG.num(v) === null && !AG.DATE_RX.test(String(v)) && ident.length < 4) ident.push(`${hum(k)} ${v}`);
  const parts = (who ? [who] : []).concat(ident);
  F.rp_rank = 1;
  return ok(`${cap(hum(key))} ${dir === 'max' ? 'highest' : 'lowest'} among ${hum(t)}s${sfx}: ${x.fields.get(key)}. ${parts.join('; ')} (${ix.cite(x)})`, [x.id], intent);
}
export function canon(t) {
  let s = (t || '').toLowerCase();
  if (pyget('agree', true)) {
    s = s.replace(/^(yes\.\s*|mentioned in:\s*)/, '');
    s = s.replace(/\b(on file|dated)\b/g, ' ');
  }
  return s.replace(/[^a-z0-9]/g, '');
}
