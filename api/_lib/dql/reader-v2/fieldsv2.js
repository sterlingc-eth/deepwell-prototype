/** fieldsv2.js - port of lib/fieldsv2.py (fields_v2): field-first routing + ingest-time dual extraction of structured fields. */
import * as DN from './datenorm.js';
import { D as mkDate, iso as isoOf, pyRound, cap } from './pyc.js';

const DEFAULT = { on: false, route: true, direct: true, floor: 0.0, rel_min: 0.5, min_docs: 3, direct_p1: 0.6, doc_level: true };
let CFG = { ...DEFAULT };
export const configure = (d) => { CFG = { ...DEFAULT, ...(d && typeof d === 'object' ? d : {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const MON = Object.fromEntries(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((m, i) => [m, i + 1]));
function isoYMD(y, m, d) { try { return isoOf(mkDate(parseInt(y, 10), parseInt(m, 10), parseInt(d, 10))); } catch (e) { return null; } }
export function toIso(s0) {
  const s = (s0 || '').trim();
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ].*)?$/.exec(s);
  if (m) return isoYMD(m[1], m[2], m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return isoYMD(m[3], m[1], m[2]);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m && Object.prototype.hasOwnProperty.call(MON, m[1].slice(0, 3).toLowerCase())) return isoYMD(m[3], MON[m[1].slice(0, 3).toLowerCase()], m[2]);
  return null;
}
const fold = (s) => (s || '').toLowerCase().replace(/[^a-z0-9@.%]+/g, '');
export function forms(s0) {
  const s = (s0 || '').trim();
  if (!s) return new Set();
  const out = new Set(); const iso = toIso(s);
  if (iso) out.add('d\u0000' + iso);
  else {
    let mv = null;
    if (/^[\s$(),.\d%A-Za-z]{1,24}$/.test(s) && /\d/.test(s) && !/[A-Za-z]{3,}/.test(s)) {
      try { mv = DN.parseAmount(s, false); } catch (e) { mv = null; }
    }
    if (mv !== null && mv !== undefined) out.add('m\u0000' + mv.toFixed(2));
  }
  const f = fold(s);
  if (f) out.add('t\u0000' + f);
  return out;
}
const inter = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const LAB = /(?:(?<=^)|(?<=\s{2}))([A-Z][A-Za-z#./&' -]{0,30}?):\s+/g;
export function parseLines(c, did) {
  const out = [];
  for (const p of c.pages.get(did) || []) {
    for (const ln of p.text.split('\n')) {
      const raw = ln.trim();
      if (!raw) continue;
      const ms = [...raw.matchAll(LAB)]; const segs = [];
      ms.forEach((m, i) => {
        const e = i + 1 < ms.length ? ms[i + 1].index : raw.length;
        segs.push([m[1].trim().toLowerCase(), raw.slice(m.index + m[0].length, e).trim()]);
      });
      out.push([p.page_no, raw, segs]);
    }
  }
  return out;
}
function docRules(ix, did) {
  let cache = ix._fx_doc; if (!cache) cache = ix._fx_doc = new Map();
  let r = cache.get(did);
  if (!r) {
    const lab = new Map(), bare = new Map();
    for (const [pg, ln, segs] of parseLines(ix.c, did)) {
      for (const [l, v] of segs) if (v) { if (!lab.has(l)) lab.set(l, []); lab.get(l).push([v, pg, ln]); }
      const f = fold(ln); if (!bare.has(f)) bare.set(f, []); bare.get(f).push([pg, ln]);
    }
    r = [lab, bare]; cache.set(did, r);
  }
  return r;
}
function hits(ix, did, val) {
  const [lab, bare] = docRules(ix, did); const fv = forms(val); const res = [];
  if (!fv.size) return res;
  for (const [l, vs] of lab) for (const [v, pg, ln] of vs) if (inter(forms(v), fv)) res.push(['lab', l, pg, ln]);
  const kinds = new Set([...fv].map((z) => z[0]));
  if (!res.length && kinds.has('t') && !(kinds.has('d') || kinds.has('m'))) {
    const f = fold(val);
    if (f.length >= 6 && bare.has(f)) for (const [pg, ln] of bare.get(f)) res.push(['bare', null, pg, ln]);
  }
  return res;
}
function tkOf(ix) {
  let tk = ix._fx_tk;
  if (!tk) {
    const n = new Map(), strong = new Map(), labs = new Map();
    for (const x of ix.D.values()) {
      for (const [k, v] of x.fields) {
        if (!v) continue;
        const key = x.type + '\u0002' + k;
        n.set(key, (n.get(key) || 0) + 1); const h = hits(ix, x.id, v);
        if (h.length) {
          strong.set(key, (strong.get(key) || 0) + 1);
          for (const [kind, l] of h) if (kind === 'lab') { if (!labs.has(key)) labs.set(key, new Map()); const m = labs.get(key); m.set(l, (m.get(l) || 0) + 1); }
        }
      }
    }
    tk = new Map();
    for (const [key, nn] of n) {
      let ml = null, mc = 0;
      const lm = labs.get(key);
      if (lm) for (const [l, c] of lm) if (c > mc) { ml = l; mc = c; }
      tk.set(key, { n: nn, rel: (strong.get(key) || 0) / nn, label: ml !== null && mc >= 0.6 * Math.max(1, strong.get(key) || 0) ? ml : null });
    }
    ix._fx_tk = tk;
  }
  return tk;
}
export function fieldState(ix, x, k) {
  const v = x.fields.get(k);
  if (!v) return [-1, -1, -1.0, -1, null];
  const st = tkOf(ix).get(x.type + '\u0002' + k); const C = CFG;
  if (!st || st.n < C.min_docs) return [0, -1, -1.0, -1, null];
  const [lab] = docRules(ix, x.id); const rel = st.rel;
  const h = hits(ix, x.id, v);
  const ok = h.filter((z) => z[0] === 'bare' || (st.label !== null && z[1] === st.label));
  if (st.label !== null && lab.has(st.label)) {
    const vs = lab.get(st.label);
    if (new Set(vs.map(([a]) => [...forms(a)].sort().join('\u0001'))).size > 1 && !ok.length) return [0, 0, rel, 0, null];
    const fv = forms(v);
    if (!vs.some(([a]) => inter(forms(a), fv))) return [0, 0, rel, 0, null];
  }
  if (!ok.length) return [0, -1, rel, st.label ? 0 : 1, null];
  if (new Set(ok.map((z) => z[2] + '\u0001' + z[3])).size > 1) return [0, -1, rel, 1, null];
  const z = ok[0];
  return [rel >= C.rel_min ? 1 : 0, 1, rel, z[0] === 'lab' ? 0 : 1, [z[2], z[3]]];
}
const TOT = /^\s*(?:grand\s+)?(?:total(?:\s+due)?|amount\s+due|balance\s+due|total\s+amount|invoice\s+total)\s*[:-]?\s*(.+)$/i;
const PARTY = new Set(['client', 'customer', 'tenant', 'patient', 'owner', 'buyer', 'seller', 'member', 'student', 'resident', 'bill to', 'name', 'account', 'guest', 'borrower', 'lessee', 'applicant', 'vendor', 'seller/owner', 'homeowner', 'licensee', 'passenger']);
export function docState(ix, x, kind) {
  const [lab] = docRules(ix, x.id);
  if (kind === 'total') {
    if (x.tot === null) return [-1, -1, null];
    const vals = [];
    for (const [pg, ln] of parseLines(ix.c, x.id)) {
      const m = TOT.exec(ln);
      if (m) { const v = DN.parseAmount(m[1], true); if (v !== null && v !== undefined) vals.push([v, pg, ln]); }
    }
    if (!vals.length) return [0, -1, null];
    if (new Set(vals.map(([v]) => pyRound(v, 2))).size > 1) return [0, 0, null];
    const [v, pg, ln] = vals[vals.length - 1];
    return Math.abs(v - x.tot) < 0.005 ? [1, 1, [pg, ln]] : [0, 0, null];
  }
  if (kind === 'date') {
    const vs = []; for (const [l, e] of lab) if (l === 'date') for (const [v, pg, ln] of e) vs.push([v, pg, ln]);
    const isos = new Set(vs.map(([v]) => toIso(v)));
    if (!vs.length || isos.has(null)) return [0, -1, null];
    if (isos.size > 1) return [0, 0, null];
    return isos.has(x.date) ? [1, 1, [vs[0][1], vs[0][2]]] : [0, 0, null];
  }
  if (kind === 'party') {
    if (!x.cust) return [-1, -1, null];
    const nm = fold(ix.name(x.cust));
    const vs = []; for (const [l, e] of lab) if (PARTY.has(l)) for (const [v, pg, ln] of e) vs.push([v, pg, ln]);
    if (!vs.length) return [0, -1, null];
    if (new Set(vs.map(([v]) => fold(v))).size > 1) return [0, 0, null];
    return fold(vs[0][0]) === nm ? [1, 1, [vs[0][1], vs[0][2]]] : [0, 0, null];
  }
  return [-1, -1, null];
}
const MARK = ['say', 'clause', 'term', 'language', 'handle', 'about', 'written', 'provision', 'wording', 'rule', 'policy', 'deal', 'part', 'read', 'section', 'paragraph', 'mention', 'regarding', 'cover'];
const wset = (stem, words, s) => new Set(words(s).map(stem));
export function matchKey(ix, x, qw, stem, words, hum) {
  const best = [];
  for (const [k, v] of x.fields) {
    if (!v) continue;
    const kw = wset(stem, words, hum(k));
    if (kw.size && [...kw].every((w) => qw.has(w))) best.push([kw.size, k]);
  }
  if (!best.length) return null;
  best.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const top = best[0][0]; const ks = best.filter(([n]) => n === top).map(([, k]) => k);
  if (ks.length > 1 && new Set(ks.map((k) => x.fields.get(k))).size > 1) return null;
  return ks[0];
}
export function qWords(g, stem, words, hum) {
  const wq = words(g.mask); const sq = wq.map(stem);
  const phr = g.types.map(([t]) => hum(t)).concat(g.syn_phrase ? [g.syn_phrase] : []);
  for (const ph of phr) {
    const ps = words(ph).map(stem); const L = ps.length;
    for (let i = 0; i < sq.length - L + 1; i++) {
      if (L && ps.every((p, j) => sq[i + j] === p)) { sq.splice(i, L); break; }
    }
  }
  return new Set(sq);
}
const GENERIC1 = new Set(['date', 'total', 'name', 'amount', 'number', 'no', 'id', 'type', 'ref', 'reference']);
export function route(ix, g, x, intent, F, no, ok, helpers) {
  if (!CFG.route) return null;
  const [stem, words, hum] = helpers;
  const qw = qWords(g, stem, words, hum);
  const mk = MARK.map(stem);
  if (mk.some((w) => qw.has(w))) return null;
  const k = matchKey(ix, x, qw, stem, words, hum);
  if (k === null) return null;
  const kw = wset(stem, words, hum(k));
  const only1 = kw.size === 1 && [...kw].every((w) => GENERIC1.has(w));
  if (only1 && ['total', 'date', 'party'].includes(intent)) return null;
  const [ver, agr, rel, kind, span] = fieldState(ix, x, k);
  Object.assign(F, { fx_ver: ver, fx_agree: agr, fx_route: 1, fx_rel: rel, fx_kind: kind });
  if (ver !== 1) {
    if (intent !== 'text' && !only1) F.fx_force_text = 1;
    return null;
  }
  const v = x.fields.get(k);
  const out = ok(`${cap(hum(k))}: ${v} (${ix.cite(x)})`, [x.id], 'text', 1.0);
  out.fx_span = span; out.fx_key = k; mark(out, F);
  return out;
}
function mark(out, F) {
  if (CFG.direct && [0, -1].includes(F.syn ?? 0) && (F.unk ?? 0) <= 2 && [0, -1].includes(F.fuzzy ?? 0) && (F.ncorr ?? 0) === 0 && F.fx_ver === 1) out._fx_direct = true;
}
export function post(ix, g, out, F, intent) {
  if ('fx_ver' in F && F.fx_route === 1) return out;
  if (!out.answered || (out.docs || []).length !== 1 || !ix.D.has(out.docs[0])) return out;
  const C = CFG; const x = ix.D.get(out.docs[0]);
  const kind = { total: 'total', date: 'date', party: 'party' }[intent];
  if (kind && C.doc_level) {
    const [ver, agr, span] = docState(ix, x, kind);
    Object.assign(F, { fx_ver: ver, fx_agree: agr, fx_route: 0, fx_rel: -1.0, fx_kind: 2 });
    if (ver === 1) {
      out.fx_span = span;
      if ((F.p1 ?? 0) >= C.direct_p1 && (F.margin ?? 0) >= 0.3 && out.intent === intent) mark(out, F);
    }
  }
  return out;
}
