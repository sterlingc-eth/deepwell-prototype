/** reader.js - port of lib/rv2lib.py Co + lib/reader.py Index and ground(): everything is grounded inside ONE company's own records. */
import { words, stem, hum, STOP, DOCNO_SRC, parseDates, reEscape } from './text.js';
import { isAlnum, sortedBy, cap, pyCmp } from './pyc.js';
import * as EM from './entmatch.js';
import * as DN from './datenorm.js';
import * as RV from './retr.js';

const defMap = (m, k, mk) => { let v = m.get(k); if (v === undefined) { v = mk(); m.set(k, v); } return v; };
const SEP = '\u0001';
export const pyStrSort = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const pySplit = (s) => { const t = s.trim(); return t ? t.split(/\s+/) : []; };

/** Co: the company's exported records (documents/pages/extractions/entities/links/financials) */
export class Co {
  constructor(key, d) {
    this.key = key; this.name = d.tenantName; this.exported = (d.exportedAt || '2026-10-07').slice(0, 10);
    this.docs = new Map(d.documents.map((x) => [x.id, x]));
    this.pages = new Map();
    for (const p of d.pages) defMap(this.pages, p.document_id, () => []).push(p);
    for (const v of this.pages.values()) v.sort((a, b) => a.page_no - b.page_no);
    this.ex = new Map(); for (const e of d.extractions) defMap(this.ex, e.document_id, () => []).push(e);
    this.fin = new Map(); for (const f of d.financials) if (!this.fin.has(f.document_id)) this.fin.set(f.document_id, f);
    this.ents = new Map(d.entities.filter((e) => !e.merged_into).map((e) => [e.id, e]));
    this.cust = new Map([...this.ents].filter(([, e]) => e.entity_type === 'customer'));
    this.links = new Map(); for (const l of d.document_entity_links) defMap(this.links, l.document_id, () => []).push(l.entity_id);
    this.lines = new Map(); for (const l of d.financial_lines || []) defMap(this.lines, l.document_id, () => []).push(l);
    this._text = new Map();
  }
  text(did) { let t = this._text.get(did); if (t === undefined) { t = (this.pages.get(did) || []).map((p) => p.text).join('\n'); this._text.set(did, t); } return t; }
}
const NUMKEY = /(_no|_ref|number)$/;
const RESTRICT = /internal\s*-\s*restricted/i;
export class Index {
  constructor(c) {
    this.c = c; this.key = c.key;
    this.types = pyStrSort(new Set([...c.docs.values()].map((d) => d.document_type)));
    this.restricted_docs = new Set(); const tcount = new Map(), rcount = new Map();
    for (const [did, d] of c.docs) {
      if (RESTRICT.test(c.text(did).slice(0, 400))) { this.restricted_docs.add(did); rcount.set(d.document_type, (rcount.get(d.document_type) || 0) + 1); } else tcount.set(d.document_type, (tcount.get(d.document_type) || 0) + 1);
    }
    this.restricted = new Set([...rcount.keys()].filter((t) => !tcount.get(t)));
    this.D = new Map(); this.num2docs = new Map();
    for (const [did, d] of c.docs) {
      if (this.restricted_docs.has(did)) continue;
      const f = c.fin.get(did) || {}; const text = c.text(did);
      let num = f.invoice_number || f.po_number;
      if (!num) for (const e of c.ex.get(did) || []) if (NUMKEY.test(e.field_key)) { num = e.value; break; }
      if (num && !text.includes(num)) num = null;
      const ents = (c.links.get(did) || []).filter((e) => c.cust.has(e)).map((e) => c.cust.get(e));
      const cust = ents.length === 1 ? ents[0] : null;
      let tot = f.total !== undefined && f.total !== null && f.total !== '' ? Number(f.total) : null;
      if (tot === null && DN.enabled() && DN.cfg().tot_fallback) throw new Error('tot_fallback is not supported in the JS port');
      const fields = new Map(); for (const e of c.ex.get(did) || []) fields.set(e.field_key, e.value);
      const x = { id: did, type: d.document_type, date: d.created_at.slice(0, 10), num: num || null, cust: cust ? cust.id : null, tot, fields, restricted: false };
      this.D.set(did, x);
      if (num) defMap(this.num2docs, num.toLowerCase(), () => []).push(did);
    }
    this.name2ents = new Map(); this.addr2ents = new Map();
    for (const e of c.cust.values()) {
      const n = (e.data.customer_name || '').toLowerCase().trim(); if (n) defMap(this.name2ents, n, () => []).push(e.id);
      const a = (e.data.service_address || '').toLowerCase().trim(); if (a) defMap(this.addr2ents, a, () => []).push(e.id);
    }
    this.by_ct = new Map(); this.by_t = new Map(); this.by_c_date = new Map();
    for (const x of this.D.values()) { defMap(this.by_t, x.type, () => []).push(x); if (x.cust) defMap(this.by_ct, x.cust + SEP + x.type, () => []).push(x); }
    for (const x of this.D.values()) if (x.cust) defMap(this.by_c_date, x.cust + SEP + x.type + SEP + x.date, () => []).push(x);
    this.fields = new Map();
    for (const x of this.D.values()) for (const k of x.fields.keys()) this.fields.set(k, hum(k));
    this.tphr = new Map();
    for (const t of this.types) { if (this.restricted.has(t)) continue; const h = hum(t); this.tphr.set(t, [h, h + 's', stem(h)]); }
    this.lines = new Map(); this.ctx = new Map(); let N = 0; const df = new Map(); this.rv2_df = null;
    if (!RV.enabled()) throw new Error('retrieval_v2 must be on');
    const r = RV.build(c, [...this.D.keys()], words, stem, Object.fromEntries([...this.D].map(([k, v]) => [k, v.type])), df);
    this.lines = r.lines; this.ctx = r.ctx; N = r.N; this.rv2_df = r.rawdf;
    this.idf = new Map(); for (const [w, n] of df) this.idf.set(w, Math.log((N + 1) / (n + 1)) + 1);
    this.idf_default = Math.log(N + 1) + 1;
    this.fullnum = [...this.num2docs.keys()];
    const lab = new Map(); let cnt = 0;
    for (const did of this.D.keys()) {
      if (cnt++ >= 3000) break;
      for (const ln of c.text(did).split('\n')) { const m = /^([A-Za-z][A-Za-z #./]{1,30}):/.exec(ln.trim()); if (m) for (const w of new Set(words(m[1]).map(stem))) lab.set(w, (lab.get(w) || 0) + 1); }
    }
    this.labelw = new Set([...lab].filter(([, n]) => n >= 3).map(([w]) => w));
    this.vocab = new Set([...this.idf.keys()]);
    for (const n of this.name2ents.keys()) for (const w of words(n)) this.vocab.add(w);
    for (const t of this.types) for (const w of words(hum(t))) this.vocab.add(w);
    for (const w of STOP) { this.vocab.add(w); this.vocab.add(stem(w)); }
    this.today = c.exported || '2026-10-07';
    for (const [did, x] of this.D) { const f = c.fin.get(did) || {}; const st = (f.status || '').toLowerCase(); x.pay = { paid: 'paid', unpaid: 'unpaid', partial: 'partial' }[st] || null; }
    this.paywords = ['paid', 'unpaid'].filter((w) => [...this.D.values()].filter((x) => x.pay === w).length >= 20);
    const vc = new Map();
    for (const x of this.D.values()) for (const [k, v] of x.fields) if (v && v.length >= 3 && v.length <= 30 && !/\d/.test(v)) { const m = defMap(vc, k, () => new Map()); const lv = v.toLowerCase(); m.set(lv, (m.get(lv) || 0) + 1); }
    this.catphr = new Map();
    for (const [k, m] of vc) {
      let tot = 0; for (const n of m.values()) tot += n;
      if (m.size <= 14 && tot >= 20) for (const [v, n] of m) if (n >= 2) { if (this.catphr.has(v)) this.catphr.get(v)[0].push(k); else this.catphr.set(v, [[k], n]); }
    }
    this.cat_re = this.catphr.size ? new RegExp('(?<![a-z0-9])(' + sortedBy([...this.catphr.keys()], (s) => s.length, true).map(reEscape).join('|') + ')(?![a-z0-9])', 'g') : null;
    this.names_by_len = new Map();
    for (const n of this.name2ents.keys()) if (n.length >= 6) defMap(this.names_by_len, n.length, () => []).push(n);
  }
  name(eid) { return this.c.cust.get(eid).data.customer_name; }
  cite(x) { return `${cap(hum(x.type))} ${x.num ? x.num + ' ' : ''}(${x.cust ? this.name(x.cust) + ', ' : ''}${x.date})`; }
}
export const DOCNO = () => new RegExp(DOCNO_SRC, 'g');
const spaces = (n) => ' '.repeat(n);
export function ground(ix, q) {
  const ql = q.toLowerCase().replace(/’/g, "'");
  const a1 = pySplit(q.toLowerCase()), a2 = pySplit(ql); let ncorr = 0; for (let i = 0; i < Math.min(a1.length, a2.length); i++) if (a1[i] !== a2[i]) ncorr++;
  const g = { q, ql, fuzzy: 0, nums: [], unknown_nums: [], ents: [], dates: parseDates(ql), types: [], ambiguous: false, ncorr };
  for (const m of q.matchAll(DOCNO())) {
    const k = m[0].toLowerCase();
    if (ix.num2docs.has(k)) { if (ix.num2docs.get(k).length === 1) g.nums.push(ix.num2docs.get(k)[0]); else g.ambiguous = true; } else g.unknown_nums.push(m[0]);
  }
  const cands = [];
  for (const [n, eids] of ix.name2ents) {
    let i = ql.indexOf(n);
    while (i >= 0) {
      if ((i === 0 || !isAlnum(ql[i - 1])) && (i + n.length >= ql.length || !isAlnum(ql[i + n.length]))) cands.push([i, i + n.length, n, eids]);
      i = ql.indexOf(n, i + 1);
    }
  }
  for (const [a, eids] of ix.addr2ents) { const i = ql.indexOf(a); if (i >= 0) cands.push([i, i + a.length, a, eids]); }
  const sc = sortedBy(cands, (x) => -(x[1] - x[0])); const taken = [];
  for (const [st, en, n, eids] of sc) {
    if (taken.some(([a, b]) => !(en <= a || st >= b))) continue;
    taken.push([st, en]); g.ents.push([n, eids, ix.addr2ents.has(n)]);
  }
  const hasEnt = g.ents.length > 0;
  Object.assign(g, { ent_conf: hasEnt ? 1.0 : -1.0, ent_margin: hasEnt ? 1.0 : -1.0, ent_kind: hasEnt ? 1 : 0, ent_ambig: 0 });
  if (!g.ents.some(([, , isaddr]) => !isaddr) && !g.nums.length) {
    if (EM.enabled()) {
      const fz = EM.resolve(ix, q, taken, g.ents.some(([, , isaddr]) => !isaddr), hasEnt);
      if (fz && fz.ambiguous) Object.assign(g, { ent_conf: fz.conf, ent_margin: fz.margin, ent_kind: fz.kind, ent_ambig: 1 });
      else if (fz) {
        const [st, en] = fz.span; const n = fz.key; const isaddr = fz.kind === 3;
        taken.push([st, en]); g.ents.push([n, (isaddr ? ix.addr2ents : ix.name2ents).get(n), isaddr]); g.fuzzy = !isaddr ? Math.max(1, fz.dist) : 1;
        Object.assign(g, { ent_conf: fz.conf, ent_margin: fz.margin, ent_kind: fz.kind });
      }
    } else throw new Error('typo_match must be on');
  }
  let mask = ql;
  for (const [st, en] of sortedBy(taken, (x) => x, true)) mask = mask.slice(0, st) + spaces(en - st) + mask.slice(en);
  for (const m of mask.matchAll(DOCNO())) mask = mask.slice(0, m.index) + spaces(m[0].length) + mask.slice(m.index + m[0].length);
  for (const [[a, b]] of g.dates) mask = mask.slice(0, a) + spaces(b - a) + mask.slice(b);
  g.mask = mask;
  const sp = taken.map(([st, en], i) => [st, en, g.ents[i][2] ? 'ADDR' : 'NAME']);
  for (const m of ql.matchAll(DOCNO())) sp.push([m.index, m.index + m[0].length, 'DOCNO']);
  for (const [[a, b]] of g.dates) sp.push([a, b, 'DATE']);
  g.spans = sp;
  const wq = words(mask), sq = wq.map(stem); let best = [];
  const tl = [...ix.tphr.keys()].concat([...ix.restricted]);
  for (const t of tl) {
    const pw = words(hum(t)), spw = pw.map(stem), L = spw.length;
    for (let i = 0; i <= sq.length - L; i++) { let eq = true; for (let j = 0; j < L; j++) if (sq[i + j] !== spw[j]) { eq = false; break; } if (eq) { best.push([L, t, wq[i + L - 1] !== pw[pw.length - 1]]); break; } }
  }
  best = sortedBy(best, (x) => x, true);
  g.restricted = best.filter(([, t]) => ix.restricted.has(t)).map(([, t]) => t);
  best = best.filter((b) => !ix.restricted.has(b[1]));
  if (best.length) { const top = best[0][0]; g.types = best.filter(([l]) => l === top).map(([, t, pl]) => [t, pl]); }
  let mq = ql;
  for (const [a, b, ph] of sortedBy(g.spans, (x) => x, true)) mq = mq.slice(0, a) + ' ' + ph + ' ' + mq.slice(b);
  for (const [t, pl] of g.types.slice(0, 1)) {
    const pw = words(hum(t));
    const pat = '\\b' + pw.map((w, i) => {
      if (i === pw.length - 1 && w.endsWith('y')) return reEscape(w.slice(0, -1)) + '(?:y|ies)';
      return reEscape(w) + (i < pw.length - 1 ? '(?:s|es)?' : '(?:ies|s|es)?');
    }).join('\\s+') + '\\b';
    mq = mq.replace(new RegExp(pat, 'g'), pl ? 'DOCTYPES' : 'DOCTYPE');
  }
  mq = mq.replace(/\b(19|20)\d\d\b/g, 'YEAR');
  g.masked = mq.replace(/\s+/g, ' ').trim();
  return g;
}
