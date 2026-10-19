/** rankv2.js - port of lib/rankv2.py (rank_v2): deterministic "which <document> has the highest/lowest <field>" over the company's own records. */
import { words, stem, hum } from './text.js';
import { parseFilters } from './ext.js';
import * as AG from './aggv2.js';
import { getCloseMatches } from './difflib.js';
import { sortedBy, cap, reEscape } from './pyc.js';

const DEF = { on: false, direct: true, direct_unk: 5, direct_syn: true, typo: true, allow_missing: 0.0, min_docs: 2, type_by_field: true };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const MAX = /\b(highest|largest|biggest|greatest|maximum|most|top|longest|priciest|max)\b/;
const MIN = /\b(lowest|smallest|least|minimum|fewest|shortest|quickest|fastest|cheapest|min|bottom|quicker)\b/;
const CONCEPTS = [
  ['price', /\b(asking|list|listing|listed)\s+price|\blisted at\b|\bprice (?:listed|asked)\b/, /^(list_price|asking_price|listed_at|listing_price|ask_price|list_amount|asking_amount)$/],
  ['dom', /\bdom\b|days? on (?:the )?market|time on (?:the )?market|market days|days listed|days on/, /^(days_on_market|market_days|days_listed|dom|time_on_market|days_on_mls)$/],
  ['drops', /price (?:drops?|reductions?|cuts?)|markdowns?|times? (?:reduced|marked down)|reductions?\b/, /^(price_drops|times_reduced|reductions?|markdowns?|price_reductions?|price_cuts)$/],
  ['sqft', /\bsq\.? ?ft\b|\bsqft\b|square (?:feet|foot|footage)/, /^(sqft|square_feet|square_footage|sq_ft|living_area)$/],
  ['delinq', /delinquen|arrears/, /delinquen|arrears/],
  ['defects', /\bdefects?\b/, /^(defects_found|defect_count|total_defects|defects)$/],
  ['major', /\bmajor defects?\b/, /^(major_defects|critical_defects)$/],
  ['dues', /\bdues\b|hoa (?:fees?|dues)|\bassessments?\b|monthly (?:fee|assessment)/, /^(monthly_dues|dues_per_month|assessment_monthly|hoa_fee|hoa_dues|monthly_assessment|monthly_fee|dues)$/],
];
const SN = /^\s*-?\$?\s*\d[\d,]*(?:\.\d+)?\s*%?\s*$/;
function snum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!SN.test(s)) return null;
  const f = Number(s.replace(/[\s$,%]/g, ''));
  return Number.isNaN(f) ? null : f;
}
function fieldsOf(ix) {
  let c = ix._rk_nk;
  if (!c) {
    c = ix._rk_nk = new Map();
    for (const [t, docs] of ix.by_t) {
      const cnt = new Map(), tot = new Map();
      for (const x of docs) for (const [k, v] of x.fields) {
        if (v === null || v === undefined || v === '') continue;
        tot.set(k, (tot.get(k) || 0) + 1);
        if (snum(v) !== null) cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      c.set(t, [...cnt.keys()].filter((k) => cnt.get(k) >= 0.8 * tot.get(k) && cnt.get(k) >= 2));
    }
  }
  return c;
}
const LINE = /^\s*([A-Za-z][A-Za-z0-9 /#&'.-]{1,38}?)\s*[:=]\s*(.+?)\s*$/;
function labels(ix) {
  let c = ix._rk_lb;
  if (c) return c;
  c = ix._rk_lb = new Map();
  for (const [t, ks] of fieldsOf(ix)) {
    const cnt = new Map(ks.map((k) => [k, new Map()]));
    for (const x of (ix.by_t.get(t) || []).slice(0, 14)) {
      let txt; try { txt = ix.c.text(x.id); } catch (e) { continue; }
      const lines = [];
      for (const ln of txt.split('\n')) {
        const m = LINE.exec(ln);
        if (m) { const v = snum(m[2]); if (v !== null) lines.push([m[1].trim().toLowerCase(), v]); }
      }
      for (const k of ks) {
        const v = snum(x.fields.get(k));
        if (v === null) continue;
        for (const [lb, lv] of lines) if (Math.abs(lv - v) < 1e-6 && !['total', 'page', 'document no', 'date'].includes(lb)) cnt.get(k).set(lb, (cnt.get(k).get(lb) || 0) + 1);
      }
    }
    for (const k of ks) {
      const m = cnt.get(k);
      if (m.size) { let bl = null, bc = -1, bn = 0; for (const [lb, n] of m) { if (bl === null || n > bc || (n === bc && -lb.length > bn)) { bl = lb; bc = n; bn = -lb.length; } } c.set(t + '\u0002' + k, bl); }
    }
  }
  return c;
}
function kn(ix, t, k) {
  const out = [k]; const lb = labels(ix).get(t + '\u0002' + k);
  if (lb) out.push(lb.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  return out;
}
function pickField(ix, ql, qs) {
  const nk = fieldsOf(ix); const hit = [];
  const names = new Set(CONCEPTS.filter((c) => c[1].test(ql)).map((c) => c[0]));
  if (names.has('major')) names.delete('defects');
  for (const [name, , kp] of CONCEPTS) {
    if (names.has(name)) {
      const ks = new Set();
      for (const [t, kk] of nk) for (const k of kk) if (kn(ix, t, k).some((n) => kp.test(n))) ks.add(k);
      const sk = [...ks].sort();
      if (sk.length) hit.push([name, sk]);
    }
  }
  if (hit.length > 1) return [null, 'which field to rank by?'];
  if (hit.length) return [hit[0][1], null];
  let best = []; let bn = 0;
  for (const [t, kk] of nk) for (const k of kk) for (const n of kn(ix, t, k)) {
    const lw = words(hum(n)).map(stem);
    if (lw.length && lw.every((w) => qs.has(w)) && (lw.length > 1 || !['number', 'no', 'ref', 'id'].includes(lw[0]))) {
      if (lw.length > bn) { best = [k]; bn = lw.length; } else if (lw.length === bn) best.push(k);
    }
  }
  if (!best.length) return [null, null];
  return [[...new Set(best)].sort(), null];
}
const VOC = ['asking', 'listing', 'listed', 'price', 'prices', 'highest', 'lowest', 'largest', 'smallest', 'biggest', 'greatest', 'maximum', 'minimum', 'longest', 'shortest', 'quickest', 'fastest', 'cheapest', 'fewest',
  'delinquent', 'delinquency', 'delinquen', 'defects', 'defect', 'square', 'footage', 'market', 'markdowns', 'markdown', 'reductions', 'reduced', 'reduction', 'monthly', 'dues', 'assessment', 'assessments', 'arrears'];
function fixTypos(ql, vocab) {
  const out = [];
  for (let w of ql.match(/[A-Za-z0-9']+|[^A-Za-z0-9']+/g) || []) {
    if (/^\p{L}+$/u.test(w) && w.length >= 5 && !VOC.includes(w) && !vocab.has(w)) {
      const m = getCloseMatches(w, VOC, 3, 0.82).filter((v) => v[0] === w[0] && Math.abs(v.length - w.length) <= 2);
      if (m.length) w = m[0];
    }
    out.push(w);
  }
  return out.join('');
}
export function rank(ix, g, F, no, ok, intent) {
  if (!enabled()) return null;
  let ql = g.ql;
  if (g.nums.length || g.ents.length || (g.unknown_nums && g.unknown_nums.length)) return null;
  if (/\b(most|latest|newest|last|first|earliest|oldest) (recent|recently)\b|\b(latest|newest|earliest|oldest)\b/.test(ql)) return null;
  if (CFG.typo !== false) ql = fixTypos(ql, ix.vocab);
  const ql0 = ql; const qs0 = new Set(words(ql).map(stem));
  for (const t_ of ix.by_t.keys()) ql = ql.replace(new RegExp('\\b' + reEscape(hum(t_).toLowerCase()) + 's?\\b', 'g'), ' DOCTYPE ');
  ql = ql.replace(/\b(for|on) the [a-z ]{3,30}? (report|audit trail|audit|timeline|file|packet|review)\b/g, ' ');
  const dm = MAX.test(ql), dn = MIN.test(ql);
  if (dm === dn) return null;
  const d = dm ? 'max' : 'min';
  if (/\btotal\b/.test(ql.replace(/delinquent total|total units/g, ' '))) return null;
  const qs = new Set(words(ql).map(stem));
  const [keys, why0] = pickField(ix, ql, qs);
  if (why0) return no(why0, intent);
  if (!keys) return null;
  const conc = CONCEPTS.some((c) => c[1].test(ql));
  const nk = fieldsOf(ix);
  const cand = [...nk].filter(([t, ks]) => keys.some((k) => ks.includes(k)) && ix.by_t.has(t)).map(([t]) => t);
  const types = g.types.map((z) => z[0]);
  let sel;
  if (types.length) {
    sel = cand.filter((t) => types.includes(t));
    if (!sel.length) {
      if (!(conc && CFG.type_by_field !== false) || types.some((t_) => new RegExp('\\b' + reEscape(hum(t_).toLowerCase()) + 's?\\b').test(ql0))) return null;
      sel = cand;
    }
  } else if (conc && CFG.type_by_field !== false) sel = cand; else return null;
  if (sel.length > 1) {
    const sc = new Map(sel.map((t) => [t, words(hum(t)).map(stem).filter((w, i, a) => a.indexOf(w) === i && qs0.has(w)).length]));
    const m = Math.max(...sc.values()); const top = sel.filter((t) => sc.get(t) === m);
    if (m === 0 || top.length !== 1) return no('document type unclear', intent);
    sel = top;
  }
  if (!sel.length) return null;
  const t = sel[0]; const key0 = keys.filter((k) => nk.get(t).includes(k));
  if (key0.length !== 1) return no('which field to rank by?', intent);
  const key = key0[0];
  const FL = parseFilters(ix, g);
  Object.assign(F, { n_filters: FL.conds.length, filt_year: +FL.kinds.has('year'), filt_rel: +FL.kinds.has('rel'), filt_range: +(FL.kinds.has('range') || FL.kinds.has('month')), f_amount: +FL.kinds.has('amount') });
  if (FL.bad) return no('unclear date range or filter', intent);
  const allx = ix.by_t.get(t); const xs = allx.filter((x) => FL.ok(x));
  const [why, af] = AG.gate(ix, t, null, allx, xs, FL, F.unk ?? 0); Object.assign(F, af);
  if (why) return no(why, intent);
  let vals = xs.map((x) => [snum(x.fields.get(key)), x]);
  const nm = vals.filter(([v]) => v === null).length;
  if (nm && nm > CFG.allow_missing * vals.length) return no('some documents have no value for that field', intent);
  vals = vals.filter((z) => z[0] !== null);
  if (vals.length < Math.max(2, parseInt(CFG.min_docs, 10))) return no('tie or no values', intent);
  vals = sortedBy(vals, (z) => z[0]);
  const [a, b] = d === 'max' ? [vals[vals.length - 1], vals[vals.length - 2]] : [vals[0], vals[1]];
  if (a[0] === b[0]) return no(`tie for the ${d === 'max' ? 'highest' : 'lowest'} ${hum(key)}`, intent);
  const x = a[1]; const fdesc = FL.desc.join(', '); const sfx = fdesc ? ` (${fdesc})` : '';
  const who = x.cust ? ix.name(x.cust) : null; const ident = [];
  for (const k of sortedBy([...x.fields.keys()], (k) => (/address|name|property/.test(k) ? 0 : 1))) {
    const v = x.fields.get(k);
    if (k !== key && v && String(v).length <= (/address|location|premises|property|site|street/.test(k) ? 90 : 40) && snum(v) === null && !AG.DATE_RX.test(String(v)) && ident.length < 5) ident.push(`${hum(k)} ${v}`);
  }
  const parts = (who ? [who] : []).concat(ident);
  const r = ok(`${cap(hum(key))} ${d === 'max' ? 'highest' : 'lowest'} among ${hum(t)}s${sfx}: ${x.fields.get(key)}. ${parts.join('; ')} (${ix.cite(x)})`, [x.id], intent);
  const inn = (v, arr) => arr.includes(v);
  if (CFG.direct !== false && (inn(F.syn ?? 0, [0, -1]) || CFG.direct_syn) && (F.unk ?? 0) <= parseInt(CFG.direct_unk, 10) && inn(F.fuzzy ?? 0, [0, -1]) && (F.ncorr ?? 0) === parseInt(CFG.direct_ncorr ?? 0, 10) && !nm) r._rk_direct = true;
  return r;
}
