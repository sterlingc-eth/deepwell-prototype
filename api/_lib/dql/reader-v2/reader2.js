/** reader2.js - port of lib/reader2.py (v002 switch set): grounding + document-type matching, intent dispatch, candidate ranking, aggregates. */
import { words, stem, hum, STOP, has, DOCNO_SRC } from './text.js';
import { ground } from './reader.js';
import * as S1 from './s1.js';
import * as DT from './doctype.js';
import * as DN from './datenorm.js';
import * as AG from './aggv2.js';
import * as RV from './retr.js';
import { parseFilters } from './ext.js';
import { dot } from './doctype.js';
import { cap, fmtMoney, sortedBy } from './pyc.js';

export const INTENTS = ['text', 'total', 'date', 'party', 'find', 'count', 'sum', 'latest', 'earliest', 'list', 'count_year', 'max', 'min', 'contact', 'who_addr', 'mention', 'unsupported'];
const MARK = new Set(['say', 'clause', 'term', 'language', 'handle', 'about', 'written', 'provision']);
const GEN = new Set(['total', 'amount', 'much', 'dollar', 'price', 'date', 'when', 'day', 'who', 'whose', 'name', 'find', 'pull', 'open', 'locate', 'show', 'see', 'get', 'where', 'issued', 'dated', 'belongs', 'which', 'listed', 'whn', 'is', ...MARK]);
const SEP = '\u0001';
const nd = (s) => s.replace(/\d+/g, '#');
const fr = Math.fround;
export const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
export async function groundFull(ix, q, M) {
  const g = ground(ix, q); Object.assign(g, { syn: 0, syn_cos: -1.0, syn_margin: -1.0, syn_phrase: '' });
  const dtc = M.doctype;
  if (dtc && dtc[0].on && M.emb) { await DT.match(ix, g, M, dtc[0], dtc[1]); return g; }
  throw new Error('doctype_match must be on');
}
export function resolveDoc(ix, g) {
  const { nums, ents, types } = g;
  if (nums.length) return [ix.D.get(nums[0]), null];
  if (ents.length && types.length && g.dates.length) {
    const ent = ents[0][1].length === 1 ? ents[0][1][0] : null;
    if (ent === null) return [null, 'name matches more than one record'];
    const xs = ix.by_c_date.get(ent + SEP + types[0][0] + SEP + g.dates[0][1]) || [];
    if (xs.length === 1) return [xs[0], null];
    return [null, xs.length > 1 ? 'more than one matching document' : 'no such document on file for that date'];
  }
  return [null, null];
}
function topic(ix, g) {
  const qw = new Set(words(g.mask).map(stem)); const types = g.types;
  const refw = types.length ? new Set(words(hum(types[0][0])).map(stem)) : new Set();
  for (const w of words(g.syn_phrase || '')) refw.add(stem(w));
  const gen = new Set([...GEN, ...ix.labelw]);
  let cwRaw = words(g.mask).filter((w) => w.length > 1 && !STOP.has(w) && !gen.has(stem(w)) && !refw.has(stem(w)));
  if (RV.enabled() && (RV.cfg().ocr ?? true)) cwRaw = RV.qfix(ix, cwRaw);
  return [qw, cwRaw, cwRaw.map(stem)];
}
export const FEATS = ['is_field', 'lex', 'allw', 'cos', 'cos_rel', 'lex_rel', 'n_cw', 'n_words', 'digit', 'rank_cos', 'rank_lex', 'n_cand', 'cosq', 'cosq_rel', 'pm', 'pm_rel'];
const idfOf = (ix, w) => (ix.idf.has(w) ? ix.idf.get(w) : ix.idf_default);
const f32dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return fr(s); };
const ranksDesc = (v) => { const o = Array.from(v.keys()).sort((a, b) => (v[b] - v[a]) || (a - b)); const r = new Array(v.length); o.forEach((idx, pos) => { r[idx] = pos; }); return r; };
export async function candidates(ix, M, x, g) {
  const [qw, cwRaw, cw] = topic(ix, g); const phrase = cwRaw.join(' ');
  const qEmbText = phrase || words(g.mask).join(' ');
  let den = 0; for (const w of cw) den += idfOf(ix, w); den = den || 1.0;
  const texts = [qEmbText]; const meta = [];
  for (const [k, v] of x.fields) {
    if (!v) continue;
    const fw = words(hum(k)).map(stem); let lex = 0; for (const w of cw) if (fw.includes(w)) lex += idfOf(ix, w); lex /= den;
    const allw = fw.length && fw.every((w) => qw.has(w)) ? 1.0 : 0.0;
    meta.push({ kind: 'field', key: k, text: hum(k), val: v, lex, allw, nw: fw.length, digit: 0 }); texts.push(hum(k));
  }
  for (const [pg, ln, ws] of ix.lines.get(x.id)) {
    let lex = 0; for (const w of cw) if (ws.has(w)) lex += idfOf(ix, w); lex /= den;
    meta.push({ kind: 'line', page: pg, text: ln, val: ln, lex, allw: 0.0, nw: ws.size, digit: /\d/.test(ln) ? 1 : 0 });
    const cx = ix.ctx.get(`${x.id}${SEP}${pg}${SEP}${ln}`); texts.push(!cx ? nd(ln) : nd(cx + ': ' + ln));
  }
  if (!meta.length) return [[], cwRaw];
  const E = await M.emb.enc(texts.concat(phrase ? [words(g.mask).join(' ')] : []));
  const qe = E[0]; const ce = E.slice(1, 1 + meta.length); const last = E[E.length - 1];
  const cos = ce.map((c) => f32dot(c, qe)); const cosq = phrase ? ce.map((c) => f32dot(c, last)) : cos;
  const lx = meta.map((m) => m.lex);
  const rkC = ranksDesc(cos), rkL = ranksDesc(lx);
  const pm = M.pair ? M.pair.score(qe, phrase ? last : qe, ce, meta.map((m) => (m.kind === 'field' ? 1 : 0))) : new Float32Array(meta.length);
  const mx = (a) => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };
  const cmax = mx(cos), cqmax = mx(cosq), pmax = mx(pm), lmax = mx(lx);
  meta.forEach((m, i) => {
    Object.assign(m, { pm: pm[i], pm_rel: fr(pm[i] - pmax), cos: cos[i], cosq: cosq[i], cos_rel: fr(cos[i] - cmax), cosq_rel: fr(cosq[i] - cqmax), lex_rel: m.lex - lmax, rank_cos: rkC[i], rank_lex: rkL[i], n_cand: meta.length, n_cw: cw.length, n_words: m.nw, is_field: m.kind === 'field' ? 1 : 0 });
  });
  return [meta, cwRaw];
}
const featvec = (m) => FEATS.map((f) => Number(m[f]));
export async function decide2(ix, q, M, probs = null, cleaned = 0) {
  q = AG.fixCues(ix, q);
  const g = await groundFull(ix, q, M); const ql = g.ql;
  AG.cleanEnts(g);
  let unk = 0; for (const w of words(g.mask)) if (!ix.vocab.has(w) && !ix.vocab.has(stem(w)) && w.length > 2) unk++;
  const F = { ncorr: g.ncorr, fuzzy: g.fuzzy, syn: g.syn, syn_cos: g.syn_cos, syn_margin: g.syn_margin, dt_conf: g.dt_conf ?? -1.0, dt_margin: g.dt_margin ?? -1.0, dt_kind: g.dt_kind ?? -1, unk, email: cleaned, qlen_masked: g.masked.split(/\s+/).filter((s) => s).length, ent_conf: g.ent_conf ?? -1.0, ent_margin: g.ent_margin ?? -1.0, ent_kind: g.ent_kind ?? -1 };
  const no = (reason, intent = null, kw = {}) => ({ answered: false, text: 'Not on file / released: ' + reason, docs: [], conf: 0.0, intent, reason, feat: { ...F, ...kw }, g });
  const ok = (text, docs, intent, conf = 1.0, kw = {}) => ({ answered: true, text, docs, conf, intent, reason: '', feat: { ...F, ...kw }, g });
  if (g.ambiguous) return no('ambiguous number');
  if (g.ent_ambig) return no('name or address matches more than one record');
  if (g.restricted.length) return no('restricted document type', 'restricted');
  const { nums, ents, types } = g;
  if (g.unknown_nums.length && !nums.length) return no('number not found in your records: ' + g.unknown_nums[0], 'notfound');
  const P = probs !== null ? probs : await M.intentProba(g.masked);
  const order = sortedBy([...P.entries()], (kv) => -kv[1]); const [intent, p1] = order[0]; const p2 = order[1][1];
  Object.assign(F, { p1, p2, margin: p1 - p2, intent_id: INTENTS.indexOf(intent), has_doc: nums.length, has_ent: ents.length, has_type: types.length, has_date: g.dates.length });
  const s1 = S1.decide(ix, q);
  F.s1_answered = +s1.answered;
  F.s1_intent_match = +(s1.intent === intent || (intent === 'text' && ['field', 'clause'].includes(s1.intent)) || (intent === 'count' && ['count', 'count0'].includes(s1.intent)) || (intent === 'latest' && s1.intent === 'latest') || (intent === 'maxmin' && s1.intent === 'maxmin'));
  const out = await dispatch(ix, g, M, intent, F, no, ok);
  out.s1 = s1; out.g = g;
  out.feat.agree = +(out.answered && s1.answered && norm(out.text) === norm(s1.text));
  return out;
}
async function dispatch(ix, g, M, intent, F, no, ok) {
  const ql = g.ql, { nums, ents } = g; let { types } = g; const q = g.q;
  if (intent === 'unsupported') return no('not something your records track', intent);
  let ent = null;
  if (ents.length) { const [, eids] = ents[0]; if (eids.length > 1) return no('name matches more than one record', intent); ent = eids[0]; }
  if (intent === 'mention') {
    if (g.unknown_nums.length) return no('not found: ' + g.unknown_nums[0], intent);
    const m = new RegExp(DOCNO_SRC).exec(q); const raw = m ? m[0] : (ents.length ? ents[0][0] : null);
    if (!raw) return no('nothing to search for', intent);
    const rl = raw.toLowerCase(); const hits = [...ix.D.keys()].filter((did) => ix.c.text(did).toLowerCase().includes(rl));
    if (!hits.length) return no('no document mentions it', intent);
    if (hits.length > 12) return no('too many documents', intent);
    return ok('Mentioned in: ' + hits.map((h) => ix.cite(ix.D.get(h))).join('; '), hits, intent);
  }
  if (intent === 'who_addr') {
    if (ent && ents[0][2]) return ok(`${ix.name(ent)} is at ${ix.c.cust.get(ent).data.service_address}.`, [], intent);
    return no('no matching address', intent);
  }
  if (intent === 'contact') {
    if (!ent) return no('person not found', intent);
    let kw = [['phone', 'phone'], ['email', 'email'], ['address', 'service_address']].filter(([w]) => has(ql, w)).map(([, k]) => k);
    if (kw.length > 1 && kw.includes('email')) kw = ['email'];
    if (kw.length !== 1) return no('which contact detail?', intent);
    const v = ix.c.cust.get(ent).data[kw[0]];
    if (!v) return no('not on file', intent);
    return ok(`${ix.name(ent)}: ${v}`, [], intent);
  }
  if (AG.enabled() && ['text', 'max', 'min'].includes(intent) && !nums.length && types.length === 1) {
    const r = AG.rank(ix, g, F, no, ok, intent); if (r !== null && r !== undefined) return r;
  }
  if (['total', 'date', 'party', 'find', 'text'].includes(intent)) {
    const [x, why] = resolveDoc(ix, g);
    if (why) return no(why, intent);
    if (!x) return no('no document identified', intent);
    F.docref = nums.length ? 1 : 2;
    if (intent === 'total') { if (x.tot === null) return no('no total on that document', intent); return ok(`Total: ${fmtMoney(x.tot)} (${ix.cite(x)})`, [x.id], intent); }
    if (intent === 'date') return ok(`Date: ${x.date} (${ix.cite(x)})`, [x.id], intent);
    if (intent === 'party') { if (!x.cust) return no('no name on that document', intent); return ok(`${ix.name(x.cust)} (${ix.cite(x)})`, [x.id], intent); }
    if (intent === 'find') return ok(ix.cite(x), [x.id], intent);
    const [cands, cw] = await candidates(ix, M, x, g);
    if (!cands.length) return no('nothing to read', intent);
    const X = cands.map(featvec); const sc = M.ranker.predict(X);
    const o = Array.from(sc.keys()).sort((a, b) => (sc[b] - sc[a]) || (a - b));
    let b = cands[o[0]]; const s1_ = sc[o[0]]; const s2_ = o.length > 1 ? sc[o[1]] : -9.0; let bidx = o[0];
    const pms = cands.map((m) => m.pm).sort((a, c) => c - a);
    const cr = M.clause; let yes_prefix = '';
    if (cr && cw.length) {
      let bi = null, CF = {};
      try { [bi, CF] = await cr.read(ix, x, g, cands, cw.map(stem), sc); } catch (e) { if (process.env.DONOVAN_V2_DEBUG) throw e; bi = null; CF = {}; }
      if (bi !== null) {
        Object.assign(F, CF);
        if (bi === -1) return no('no matching clause found', intent, { ...CF });
        if (cr.cfg.override ?? true) { b = cands[bi]; bidx = bi; }
        if (CF.cr2_yn && (cr.cfg.yesno ?? true)) yes_prefix = 'Yes. ';
      }
    }
    Object.assign(F, { r_top: s1_, r_gap: s1_ - s2_, r_cos: b.cos, r_lex: b.lex, r_field: b.is_field, r_allw: b.allw, r_ncw: cw.length, r_pm: b.pm, r_pm_gap: pms[0] - (pms.length > 1 ? pms[1] : -9.0) });
    if (!cw.length) return no('could not tell what to read', intent);
    if (b.kind === 'field') return ok(`${yes_prefix}${cap(hum(b.key))}: ${b.val} (${ix.cite(x)})`, [x.id], intent, s1_);
    { const r = ok(`${yes_prefix}${b.val} (page ${b.page}, ${ix.cite(x)})`, [x.id], intent, s1_); r.page = b.page; return r; }
  }
  // aggregates
  if (!types.length) return no('document type unclear', intent);
  if (types.length > 1) return no('document type unclear', intent);
  const [t, pl] = types[0]; F.plural = +pl;
  const FL = parseFilters(ix, g);
  Object.assign(F, { n_filters: FL.conds.length, filt_year: +FL.kinds.has('year'), filt_rel: +FL.kinds.has('rel'), filt_field: +(FL.kinds.has('field') || FL.kinds.has('pay')), filt_range: +(FL.kinds.has('range') || FL.kinds.has('month')), f_amount: +FL.kinds.has('amount') });
  if (DN.enabled()) Object.assign(F, { dn_conf: FL.conf, dn_amb: +FL.amb, dn_n: FL.nsp + FL.ncmp });
  if (FL.bad) return no('unclear date range or filter', intent);
  const fdesc = FL.desc.join(', '); const sfx = fdesc ? ` (${fdesc})` : '';
  if (['count', 'sum', 'latest', 'earliest', 'list'].includes(intent)) {
    let allx, nm;
    if (ent) { allx = ix.by_ct.get(ent + SEP + t) || []; nm = ix.name(ent) + "'s"; } else if (FL.truthy()) { allx = ix.by_t.get(t) || []; nm = 'All'; } else return no('which customer?', intent);
    const xs = allx.filter((x) => FL.ok(x)); const who = ent ? ix.name(ent) : null;
    if (AG.enabled()) { const [why, af] = AG.gate(ix, t, ent, allx, xs, FL, F.unk ?? 0); Object.assign(F, af); if (why) return no(why, intent); }
    const s = xs.length !== 1 ? 's' : '';
    if (intent === 'count') {
      if (!ent) return ok(`${xs.length} ${hum(t)}${s} on file${sfx}.`, xs.map((x) => x.id).slice(0, 50), intent);
      return ok(`${who} has ${xs.length} ${hum(t)}${s} on file${sfx}.`, xs.map((x) => x.id), intent);
    }
    if (!xs.length) return no('none on file', intent);
    if (intent === 'sum') {
      if (xs.some((x) => x.tot === null)) return no('some documents have no total', intent);
      let sm = 0; for (const x of xs) sm += x.tot;
      return ok(`Total of ${xs.length} ${hum(t)}s${who ? ' for ' + who : ''}${sfx}: ${fmtMoney(sm)}`, xs.map((x) => x.id).slice(0, 50), intent);
    }
    if (intent === 'latest' || intent === 'earliest') {
      const ds = sortedBy(xs, (x) => x.date); const y = intent === 'latest' ? ds[ds.length - 1] : ds[0];
      if (ds.length > 1 && ((intent === 'latest' && ds[ds.length - 1].date === ds[ds.length - 2].date) || (intent === 'earliest' && ds[0].date === ds[1].date))) return no('tie', intent);
      return ok(`${cap(intent)} ${hum(t)}${who ? ' for ' + who : ''}${sfx}: ${y.date} (${ix.cite(y)})`, [y.id], intent);
    }
    if (!ent && xs.length > 12) return no('too many documents; narrow the search', intent);
    return ok(`${ent ? nm : 'All'} ${hum(t)}s${sfx}: ` + sortedBy(xs, (x) => x.date).map((x) => ix.cite(x)).join('; '), xs.map((x) => x.id), intent);
  }
  const all = ix.by_t.get(t) || []; const xs = all.filter((x) => FL.ok(x));
  if (AG.enabled()) { const [why, af] = AG.gate(ix, t, null, all, xs, FL, F.unk ?? 0); Object.assign(F, af); if (why) return no(why, intent); }
  if (intent === 'count_year') {
    if (!FL.truthy()) return no('which year?', intent);
    return ok(`${xs.length} ${hum(t)}s on file${sfx}.`, xs.map((x) => x.id).slice(0, 50), intent);
  }
  if (intent === 'max' || intent === 'min') {
    const wt = sortedBy(xs.filter((x) => x.tot !== null), (x) => x.tot);
    if (wt.length < 2 || (intent === 'max' && wt[wt.length - 1].tot === wt[wt.length - 2].tot) || (intent === 'min' && wt[0].tot === wt[1].tot)) return no('tie or no totals', intent);
    const y = intent === 'max' ? wt[wt.length - 1] : wt[0];
    return ok(`${intent === 'max' ? 'Highest' : 'Lowest'} ${hum(t)}${sfx}: ${fmtMoney(y.tot)} (${ix.cite(y)})`, [y.id], intent);
  }
  return no('could not ground the question', intent);
}
