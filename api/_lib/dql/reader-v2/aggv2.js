/** aggv2.js - port of lib/aggv2.py (aggregate / filter hardening: cue repair, filter values, completeness gate, rank by a numeric field). */
import { words, stem, hum, STOP, reEscape } from './text.js';
import { parseFilters } from './ext.js';
import { cap as capitalize } from './pyc.js';
import * as AF from './aggfilter1.js';

const DEF = { on: false, soft_check: true, rank: true, link_check: true, amount_check: true, status_check: true, unk_gate: false, unk_min: 1 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;

const CUEW = ('after before since until through between during trailing previous preceding following current ago last past next this month months week weeks year years quarter quarters '
  + 'spring summer winter autumn january february march april june july august september october november december dollars thousand above below under over exceeding least').split(' ');
const CUEW_SET = new Set(CUEW);
const FIXED = { b4: 'before', btw: 'between', aftr: 'after', thru: 'through' };
const NAMECUE = /\d|\$|\b(?:over|under|above|below|than|dollars?|bucks|before|after|since|until|between|during|last|past|next|this|ago|months?|weeks?|years?|quarters?)\b/;
function dist(a, b, k) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > k) return k + 1;
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) for (let j = 1; j <= lb; j++) {
    let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
    d[i][j] = v;
  }
  return Math.min(d[la][lb], k + 1);
}
export function fixCues(ix, q) {
  const voc = ix.vocab;
  return q.replace(/[A-Za-z]+/g, (w) => {
    const lw = w.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(FIXED, lw)) return FIXED[lw];
    try { if (AF.enabled() && AF.protectedWord(lw, ix)) return w; } catch (e) { /* swallowed like the reference */ }
    if (lw.length < 4 || CUEW_SET.has(lw) || voc.has(lw) || voc.has(stem(lw)) || (lw.endsWith('s') && voc.has(lw.slice(0, -1))) || STOP.has(lw)) return w;
    const k = lw.length <= 7 ? 1 : 2; let best = []; let bd = k + 1;
    for (const c of CUEW) {
      if (c[0] !== lw[0] || Math.abs(c.length - lw.length) > k) continue;
      const d = dist(lw, c, k);
      if (d < bd) { bd = d; best = [c]; } else if (d === bd && d <= k) best.push(c);
    }
    return best.length === 1 && bd <= k ? best[0] : w;
  });
}
export function cleanEnts(g) {
  const sp = g.spans || [];
  const bad = sp.filter(([a, b, tg]) => tg === 'NAME' && NAMECUE.test(g.ql.slice(a, b))).map(([a, b]) => [a, b]);
  if (bad.length && (g.ents || []).length <= bad.length) {
    g.ents = []; g.spans = sp.filter((s) => !bad.some(([a, b]) => a === s[0] && b === s[1])); g.ag_orphan = 1;
  }
}
const STATUS = /\b(?:marked|flagged|tagged|labell?ed|listed\s+as|noted\s+as|shown\s+as|status\s+(?:is|of|=|:)|with\s+status|whose\s+status\s+is|that\s+are|which\s+are|where\s+(?:it|they)\s+(?:is|are))\s+(?:as\s+|being\s+)?([a-z][a-z-]{2,20}(?:\s[a-z][a-z-]{2,20})?)/g;
const STOPV = new Set('the a an on in for of to and or by with from at as is are was were this that these those not no all any each every per last next past current since before after between during over under above below more less than only still also just please pls thanks thank sent signed filed there here our your their his her its it we you they i me my'.split(' '));
const MONSTART = /^(?:(?:19|20)\d\d|\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|h[12]|last|next|this|spring|summer|fall|winter))/;
export function fieldVals(ix, g, ql, vals, F) {
  const ag = F.ag; const tw = new Set();
  for (const [t] of g.types || []) for (const w of words(hum(t))) tw.add(stem(w));
  for (const w of words(g.syn_phrase || '')) tw.add(stem(w));
  let out = [];
  for (const [p, keys] of vals) {
    const pw = words(p).map(stem);
    if (pw.length && tw.size && pw.every((w) => tw.has(w)) && (ql.match(new RegExp('(?<![a-z0-9])' + reEscape(p) + '(?![a-z0-9])', 'g')) || []).length === 1) { ag.drop = (ag.drop || 0) + 1; continue; }
    out.push([p, keys]);
  }
  if (CFG.status_check !== false) {
    const known = new Set([...ix.catphr.keys(), ...ix.paywords, ...out.map(([p]) => p)]);
    const tcw = new Set([...tw, ...words(vals.map(([p]) => p).join(' ')).map(stem)]);
    for (const m of ql.matchAll(STATUS)) {
      const capt = m[1].trim(); const ws = words(capt).filter((w) => !STOPV.has(w));
      if (!ws.length) continue;
      const first = ws[0];
      if ([...known].some((k) => k.includes(first) || capt.includes(k))) continue;
      if (tcw.has(stem(first)) || ['paid', 'unpaid', 'partial', 'overdue', 'late'].includes(first)) continue;
      if (MONSTART.test(first)) continue;
      if ([...known].some((v) => v.includes(first))) continue;
      ag.unres = (ag.unres || 0) + 1;
    }
  }
  try { if (AF.enabled()) out = AF.dropCollisions(ix, g, ql, out, F); } catch (e) { /* swallowed like the reference */ }
  return out;
}
export function realKeep(g, keep) {
  if (g.ents && g.ents.length) return keep;
  const tagged = new Map((g.spans || []).map(([a, b, tg]) => [`${a},${b}`, tg]));
  return keep.filter(([a, b]) => tagged.get(`${a},${b}`) === 'DOCNO');
}
const OPSX = /^(?:over|under|above|below|more|less|greater|at least|at most|exceeding|between)\b/;
const SKIPV = new Set(['is', 'are', 'of', 'as', 'equals', 'equal', 'to', 'the', '=']);
export const DATE_RX = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/;
const NUM_RX = /-?\d[\d,]*(?:\.\d+)?/;
export function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || DATE_RX.test(s)) return null;
  const m = NUM_RX.exec(s); if (!m) return null;
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/^[ $%/]+|[ $%/]+$/g, '');
  if (rest.length > 8) return null;
  const f = Number(m[0].replace(/,/g, '')); return Number.isNaN(f) ? null : f;
}
export function numericKeys(ix, t) {
  let c = ix._ag_nk; if (!c) c = ix._ag_nk = new Map();
  if (c.has(t)) return c.get(t);
  const docs = ix.by_t.get(t) || []; const cnt = new Map(); const tot = new Map();
  for (const x of docs) for (const [k, v] of x.fields) {
    if (v === null || v === undefined || v === '') continue;
    tot.set(k, (tot.get(k) || 0) + 1); if (num(v) !== null) cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const out = [...cnt.keys()].filter((k) => cnt.get(k) >= 0.8 * tot.get(k) && cnt.get(k) >= 2);
  c.set(t, out); return out;
}
function labels(ix, t) {
  let c = ix._ag_lab; if (!c) c = ix._ag_lab = new Map();
  if (c.has(t)) return c.get(t);
  const nk = new Set(numericKeys(ix, t)); const vals = new Map();
  for (const x of ix.by_t.get(t) || []) for (const [k, v] of x.fields) {
    if (nk.has(k) || !v || v.length > 40 || DATE_RX.test(v)) continue;
    if (!vals.has(k)) vals.set(k, new Set()); vals.get(k).add(v.toLowerCase().trim());
  }
  const tw = new Set(words(hum(t)).map(stem)); let out = [];
  for (const [k, vs] of vals) {
    const lab = words(hum(k)).map(stem);
    if (!lab.length || lab.every((w) => tw.has(w)) || ['date', 'total', 'note', 'notes'].some((z) => lab.length === 1 && lab[0] === z)) continue;
    out.push([k, lab, vs]);
  }
  out = out.map((z, i) => [z, i]).sort((a, b) => (b[0][1].length - a[0][1].length) || (a[1] - b[1])).map((z) => z[0]);
  c.set(t, out); return out;
}
export function labelFilters(ix, g, ql, F) {
  if (!(g.types && g.types.length) || CFG.status_check === false) return;
  const t = g.types[0][0]; const ag = F.ag;
  const ws = ql.match(/[a-z0-9][a-z0-9'-]*/g) || []; const sts = ws.map(stem); const used = new Set();
  for (const [k, lab, vs] of labels(ix, t)) {
    const n = lab.length;
    for (let i = 0; i <= sts.length - n; i++) {
      let match = true; for (let z = 0; z < n; z++) if (sts[i + z] !== lab[z]) { match = false; break; }
      if (!match) continue;
      let anyUsed = false; for (let j = i; j < i + n; j++) if (used.has(j)) anyUsed = true;
      if (anyUsed) continue;
      let j = i + n;
      while (j < ws.length && SKIPV.has(ws[j])) j++;
      if (j >= ws.length) break;
      if (OPSX.test(ws.slice(j, j + 2).join(' '))) { ag.unres = (ag.unres || 0) + 1; break; }
      let hit = null;
      for (let L = Math.min(6, ws.length - j); L > 0; L--) { const cand = ws.slice(j, j + L).join(' '); if (vs.has(cand)) { hit = [cand, L]; break; } }
      if (hit) {
        const [cand, L] = hit;
        if (F.desc.some((d) => d.toLowerCase().includes(cand))) { for (let z = i; z < j + L; z++) used.add(z); break; }
        F.conds.push((x) => ((x.fields.get(k) || '').toLowerCase().trim()) === cand); F.kinds.add('field'); F.desc.push(`${ws.slice(i, i + n).join(' ')} ${cand}`); ag.lab = (ag.lab || 0) + 1;
        for (let z = i; z < j + L; z++) used.add(z); break;
      }
      if (STOPV.has(ws[j]) || /^(?:19|20)\d\d|^\d/.test(ws[j]) || /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|h[12]|last|next|this|spring|summer|fall|winter|ty|pls|thx|asap|please|lmk)/.test(ws[j])) break;
      ag.unres = (ag.unres || 0) + 1; break;
    }
  }
}
function unlinked(ix, t, ent) {
  let c = ix._ag_nolink; if (!c) c = ix._ag_nolink = new Map();
  const key = `${t}\u0001${ent}`; if (c.has(key)) return c.get(key);
  const nm = (ix.name(ent) || '').toLowerCase().trim(); let n = 0;
  if (nm) for (const x of ix.by_t.get(t) || []) if (x.cust === null) { let tx = ''; try { tx = ix.c.text(x.id).toLowerCase(); } catch (e) { tx = ''; } if (tx.includes(nm)) n++; }
  c.set(key, n); return n;
}
function couldMatchAmount(FL, x, allx) {
  let tots = [...new Set(allx.filter((y) => y.tot !== null).map((y) => y.tot))].sort((a, b) => a - b);
  if (tots.length > 40) { const st = Math.max(1, Math.floor(tots.length / 40)); tots = tots.filter((_, i) => i % st === 0); }
  for (const v of [...tots, 0.0, 1e12]) { try { if (FL.ok({ ...x, tot: v })) return true; } catch (e) { return true; } }
  return false;
}
export function gate(ix, t, ent, allx, xs, FL, unk = 0) {
  const C = CFG; const ag = FL.ag; const unres = ag.unres || 0; const drop = ag.drop || 0; const nres = FL.conds.length;
  let amb = drop + (ag.orphan || 0); let why = null;
  if (unres) why = 'filter value not recognized';
  if (why === null && C.amount_check !== false && FL.kinds.has('amount')) {
    const miss = allx.filter((x) => x.tot === null);
    if (miss.length && miss.slice(0, 20).some((x) => couldMatchAmount(FL, x, allx))) why = 'some documents have no total to filter on';
  }
  if (C.link_check !== false && ent) { const u = unlinked(ix, t, ent); amb += u; if (why === null && u) why = 'some documents are not linked to a customer'; }
  if (why === null && ent && FL.kinds.size === 1 && FL.kinds.has('rel') && FL.desc.length === 1 && FL.desc[0].startsWith('this week') && C.soft_check !== false) why = 'ambiguous date phrase';
  if (why === null && C.unk_gate && unk && unk >= parseInt(C.unk_min ?? 1, 10)) why = 'question has words that matched no record or filter';
  const f = { agg_res: (nres + unres) ? nres / (nres + unres) : 1.0, agg_amb: Number(amb + unres), agg_n: Number(xs.length), agg_unk: Number(unk) };
  return [why, f];
}
export const SUP_SRC = { max: String.raw`\b(highest|largest|biggest|greatest|maximum|most|top|priciest)\b`, min: String.raw`\b(lowest|smallest|least|minimum|tiniest|fewest|cheapest|bottom)\b` };
const SUP = { max: /\b(highest|largest|biggest|greatest|maximum|most|top|priciest)\b/, min: /\b(lowest|smallest|least|minimum|tiniest|fewest|cheapest|bottom)\b/ };
export function rank(ix, g, F, no, ok, intent) {
  if (CFG.rank === false) return null;
  const ql = g.ql; const types = g.types;
  if (types.length !== 1 || g.nums.length) return null;
  const d = Object.entries(SUP).filter(([, p]) => p.test(ql)).map(([k]) => k);
  if (d.length !== 1) return null;
  const dir = d[0]; const t = types[0][0]; const qs = new Set(words(ql).map(stem));
  let best = []; let bn = 0;
  for (const k of numericKeys(ix, t)) {
    const lw = words(hum(k)).map(stem);
    if (lw.length && lw.every((w) => qs.has(w))) { if (lw.length > bn) { best = [k]; bn = lw.length; } else if (lw.length === bn) best.push(k); }
  }
  if (!best.length) return null;
  if (best.length > 1) return no('which field to rank by?', intent);
  const key = best[0]; const FL = parseFilters(ix, g);
  Object.assign(F, { n_filters: FL.conds.length, filt_year: +FL.kinds.has('year'), filt_rel: +FL.kinds.has('rel'), filt_range: +(FL.kinds.has('range') || FL.kinds.has('month')), f_amount: +FL.kinds.has('amount') });
  if (FL.bad) return no('unclear date range or filter', intent);
  const ents = g.ents; let ent = null;
  if (ents.length) { if (ents[0][1].length > 1) return no('name matches more than one record', intent); ent = ents[0][1][0]; }
  const allx = ent ? (ix.by_ct.get(`${ent}\u0001${t}`) || []) : ix.by_t.get(t);
  const xs = allx.filter((x) => FL.ok(x));
  const [why, af] = gate(ix, t, ent, allx, xs, FL, F.unk || 0); Object.assign(F, af);
  if (why) return no(why, intent);
  if (xs.length < 2) return no('tie or no values', intent);
  const vals = xs.map((x) => [num(x.fields.get(key)), x]);
  if (vals.some(([v]) => v === null)) return no('some documents have no value for that field', intent);
  vals.sort((a, b) => a[0] - b[0]);
  const [a, b] = dir === 'max' ? [vals[vals.length - 1], vals[vals.length - 2]] : [vals[0], vals[1]];
  if (a[0] === b[0]) return no('tie or no values', intent);
  const x = a[1]; const fdesc = FL.desc.join(', '); const sfx = fdesc ? ` (${fdesc})` : '';
  const who = x.cust ? ix.name(x.cust) : null; const ident = [];
  for (const [k, v] of x.fields) if (k !== key && v && String(v).length <= 40 && num(v) === null && !DATE_RX.test(String(v)) && ident.length < 4) ident.push(`${hum(k)} ${v}`);
  const parts = (who ? [who] : []).concat(ident);
  return ok(`${capitalize(hum(key))} ${dir === 'max' ? 'highest' : 'lowest'} among ${hum(t)}s${sfx}: ${x.fields.get(key)}. ${parts.join('; ')} (${ix.cite(x)})`, [x.id], intent);
}
