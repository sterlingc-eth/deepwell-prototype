/** doctype.js - port of lib/doctype.py (document-type matching against the company's own type list: alias layer, word classes, typo tolerance, own-document words, embedding). */
import { words, stem, hum } from './text.js';
import { osa, SYN_STOP } from './ext.js';
import { reEscape } from './pyc.js';
import * as DA1 from './doctypealias1.js';
import { osaFull } from './v3util.js';
import { U } from './unified1.js';

const CLASSES = [
  'bid estimate quote quotation proposal', 'bill invoice inv billing', 'contract agreement agmt pact', 'order purchase po requisition',
  'ticket tag jobsheet', 'note memo memorandum', 'cert certificate certification', 'report writeup', 'log record register journal',
  'form application request paperwork', 'letter notice notification advisory', 'list checklist', 'receipt slip', 'statement stmt ledger',
  'packet package bundle pack', 'disclosure', 'lease tenancy rental', 'sheet summary', 'plan program',
];
const CLS = new Map();
CLASSES.forEach((c, i) => { for (const w of c.split(' ')) CLS.set(stem(w), `#${i}`); });
const GROUPS = [
  'closing statement|closing disclosure|settlement statement|cd|hud 1|hud|closing papers|closing docs|closing documents|closing sheet|settlement sheet|closing',
  'closing instructions|escrow instructions|settlement instruction letter|settlement instructions',
  'listing agreement|listing contract|listing agmt|listing',
  'buy sell agreement|purchase agreement|sales contract|purchase contract|sale contract|purchase and sale agreement|psa',
  'residential lease|lease agreement|lease|rental agreement|rental contract|tenancy agreement|rental lease',
  'rent statement|rent ledger|tenant ledger|rent roll statement',
  'maintenance request|repair ticket|repair request|service request|work request|service ticket|repair order|work order',
  'unit condition report|move in report|move out report|walkthrough report|inspection report|condition report',
  'violation notice|violation letter|compliance letter|rule compliance letter|citation',
  'renewal offer|renewal letter|renewal notice|lease renewal',
  'deposit receipt|earnest money receipt|escrow receipt|deposit slip',
  'title search report|title report|title commitment|title opinion letter|title opinion',
  'payoff statement|payoff letter|lender payoff letter|payoff',
  'wire instruction receipt|wire receipt|wire confirmation',
  'commission statement|commission payout|commission report|commission sheet',
  'seller disclosure|disclosure form|property disclosure|seller disclosure form',
  'showing record|showing sheet|showing log|showing notes|space showing notes',
  'buyer notice packet|advisory|buyer advisory|buyer packet|buyer information sheet',
  'transfer disclosure packet|resale packet|resale certificate|resale package|transfer packet',
  'assessment invoice|dues bill|dues invoice|assessment bill|hoa bill',
  'contractor bill|vendor bill|supplier statement|vendor invoice|supplier bill',
  'architectural request|architectural form|architectural application|design review request',
  'terms outline|lease proposal|letter of intent|loi|term sheet|proposal outline',
  'annual common area bill|cam statement|cam bill|common area statement|cam reconciliation',
  'due diligence checklist|acquisition diligence list|diligence list|dd checklist|diligence checklist',
  'lease abstract|lease summary sheet|lease summary|abstract of lease',
  'broker commission agreement|fee agreement|commission agreement|brokerage agreement',
  'occupier representation contract|rep agreement|tenant rep agreement|representation agreement',
  'transaction memo|file note|file progress sheet|transaction note',
  'invoice|bill|billing statement|billing',
  'estimate|quote|bid|proposal|quotation',
  'purchase order|po|supply order|parts po|supply purchase|reagent po|purchase request',
  'receipt|payment slip|payment receipt',
  'work ticket|job ticket|job sheet|work order|service ticket|job card',
  'certificate|cert|certification',
];
const norm = (p) => words(p).map(stem).join(' ');
const GPH = new Map();
GROUPS.forEach((g, gi) => { for (const p of g.split('|')) { const k = norm(p); if (!GPH.has(k)) GPH.set(k, new Set()); GPH.get(k).add(gi); } });
const MON = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'paid', 'unpaid', 'overdue', 'open', 'closed', 'pending', 'active', 'quarter', 'week', 'months', 'days', 'dated', 'during', 'since', 'before', 'after', 'between', 'filed', 'came', 'issued', 'last', 'this', 'past', 'previous']);
export const DEFAULT = { on: true, thr: 0.52, margin: 0.10, emb_w: 0.25, ctx_w: 0.10 };
export class Learned {
  constructor(d) { d = d || {}; this.pairs = new Map(); this.heads = new Map(); for (const [a, b, n] of d.pairs || []) { this.pairs.set(`${a}\u0001${b}`, n); this.pairs.set(`${b}\u0001${a}`, n); } for (const [a, b, n] of d.heads || []) this.heads.set(a, [b, n]); }
  hasPair(a, b) { return this.pairs.has(`${a}\u0001${b}`); }
}
export function makeCfg(d) { const o = { ...DEFAULT }; for (const k of Object.keys(DEFAULT)) if (d && k in d) o[k] = d[k]; return o; }
function tokCanon(w, vocabSorted, vocab) {
  const c = CLS.get(w); if (c) return c;
  if (w.length >= 5 && !vocab.has(w)) {
    const k = w.length < 9 ? 1 : 2;
    if (U.on) {      // determinism_v1 (canon 'best', unified rulebook): the vocab word with the smallest exact OSA distance wins, ties by sorted order (the banded osa under-counts, so several words can match)
      let bv = null, bd = 1e9;
      for (const v of vocabSorted) if (Math.abs(v.length - w.length) <= k && osa(w, v, k) <= k) { const d = osaFull(w, v); if (d < bd) { bd = d; bv = v; } }
      return bv !== null ? (CLS.get(bv) || bv) : w;
    }
    for (const v of vocabSorted) if (Math.abs(v.length - w.length) <= k && osa(w, v, k) <= k) return CLS.get(v) || v;
  }
  return w;
}
function ctxWords(ix) {
  if (ix._dt_ctx) return ix._dt_ctx;
  const df = new Map(); const n = new Map();
  for (const [did, x] of ix.D) {
    const t = x.type; if ((n.get(t) || 0) >= 60) continue;
    n.set(t, (n.get(t) || 0) + 1);
    const ws = new Set(words(ix.c.text(did).slice(0, 900)).filter((w) => w.length > 3).map(stem));
    if (!df.has(t)) df.set(t, new Map()); const c = df.get(t); for (const w of ws) c.set(w, (c.get(w) || 0) + 1);
  }
  const tot = new Map(); for (const c of df.values()) for (const [w, k] of c) tot.set(w, (tot.get(w) || 0) + k);
  const nsum = [...n.values()].reduce((a, b) => a + b, 0); const cw = new Map();
  for (const [t, c] of df) {
    const keep = new Set();
    for (const [w, k] of c) { const frac = k / n.get(t); const other = (tot.get(w) - k) / Math.max(1, nsum - n.get(t)); if (frac >= 0.5 && frac - other >= 0.35) keep.add(w); }
    cw.set(t, keep);
  }
  ix._dt_ctx = cw; return cw;
}
async function typeInfo(ix, M) {
  if (ix._dt_ti) return ix._dt_ti;
  const ts = [...ix.tphr.keys()]; const toks = new Map(ts.map((t) => [t, words(hum(t)).map(stem)]));
  const vocab = new Set(); for (const v of toks.values()) for (const w of v) vocab.add(w);
  const ev = ts.length && M.emb ? await M.emb.enc(ts.map(hum)) : ts.map(() => new Float32Array(384));
  const ti = { ts, toks, vocab, vocabSorted: [...vocab].sort(), ev }; ix._dt_ti = ti; return ti;
}
export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function scorePhrase(ix, M, phraseToks, ti, learned, cfg, pe, ctx) {
  const { ts, toks } = ti; const pn = phraseToks.join(' '); const out = [];
  const P = phraseToks.map((w) => tokCanon(w, ti.vocabSorted, ti.vocab)); const pg = GPH.get(pn) || new Set();
  ts.forEach((t, i) => {
    const T = toks.get(t); const tn = T.join(' '); const Tc = T.map((w) => tokCanon(w, ti.vocabSorted, ti.vocab));
    let kind = 0, alias = 0.0;
    if (pn === tn) alias = 1.0;
    else if (learned.hasPair(pn, tn) || learned.hasPair(pn, [...T].sort().join(' '))) { alias = 1.0; kind = 1; }
    else if (pg.size && [...pg].some((x) => (GPH.get(tn) || new Set()).has(x))) { alias = 1.0; kind = 1; }
    let headEq = P[P.length - 1] === Tc[Tc.length - 1];
    const lastTok = phraseToks[phraseToks.length - 1];
    if (!headEq && learned.heads.has(lastTok) && stem(learned.heads.get(lastTok)[0]) === Tc[Tc.length - 1]) headEq = true;
    const mP = new Set(P.slice(0, -1)), mT = new Set(Tc.slice(0, -1)); let ov = 0; for (const x of mP) if (mT.has(x)) ov++;
    let nm;
    if (headEq) {
      nm = 0.5 + 0.25 * (mP.size ? ov / mP.size : 1.0) + 0.25 * (mT.size ? ov / mT.size : 1.0);
      if (mP.size && ov === 0) nm = Math.min(nm, 0.5);
    } else { const sP = new Set(P), sT = new Set(Tc); let inter = 0; for (const x of sP) if (sT.has(x)) inter++; nm = 0.3 * inter / Math.max(1, P.length); }
    const cs = pe ? dot(pe, ti.ev[i]) : 0.0; const em = Math.min(1.0, Math.max(0.0, (cs - 0.4) / 0.5));
    let cx = 0.0;
    const cset = ctx.get(t);
    if (cset && cset.size) { const mods = phraseToks.filter((w) => CLS.get(w) === undefined); cx = mods.length ? mods.filter((w) => cset.has(w)).length / mods.length : 0.0; }
    const sc = alias ? alias : (1 - cfg.emb_w - cfg.ctx_w) * nm + cfg.emb_w * em + cfg.ctx_w * cx;
    out.push([sc, kind]);
  });
  return out;
}
function phrases(mask) {
  const ws = words(mask); const out = []; const n = ws.length;
  for (const L of [3, 2, 1]) {
    for (let i = 0; i <= n - L; i++) {
      const w = ws.slice(i, i + L);
      if (SYN_STOP.has(w[0]) || SYN_STOP.has(w[w.length - 1]) || w.some((x) => x.length < 2 || /^\d+$/.test(x) || MON.has(x))) continue;
      if (w.some((x) => ['doctype', 'doctypes', 'name', 'year', 'docno', 'date', 'addr'].includes(x))) continue;
      if (w.slice(1, -1).some((x) => SYN_STOP.has(x))) continue;
      out.push(w);
    }
  }
  return out;
}
export async function match(ix, g, M, cfg, learned) {
  Object.assign(g, { dt_conf: -1.0, dt_margin: -1.0, dt_kind: -1 });
  if ((g.types && g.types.length) || (g.restricted && g.restricted.length) || (g.nums && g.nums.length) || (g.unknown_nums && g.unknown_nums.length) || !ix.tphr.size) return;
  const ph = phrases(g.mask); if (!ph.length) return;
  const ti = await typeInfo(ix, M); const ctx = ctxWords(ix);
  const ptxt = ph.map((p) => p.join(' ')); const PE = M.emb ? await M.emb.enc(ptxt) : null;
  let best = null;
  for (let j = 0; j < ph.length; j++) {
    const p = ph[j]; const sc = scorePhrase(ix, M, p.map(stem), ti, learned, cfg, PE ? PE[j] : null, ctx);
    const o = sc.map((_, k) => k).sort((a, b) => (sc[b][0] - sc[a][0]) || (a - b));
    const top = sc[o[0]][0]; const sec = o.length > 1 ? sc[o[1]][0] : 0.0;
    const key = [(top - sec >= cfg.margin && top >= cfg.thr), top, p.length];
    if (best === null || (+key[0] > +best[0][0]) || ((+key[0] === +best[0][0]) && (key[1] > best[0][1] || (key[1] === best[0][1] && key[2] > best[0][2])))) best = [key, p, ti.ts[o[0]], top - sec, sc[o[0]][1]];
  }
  if (U.on && best !== null && !best[0][0]) {
    try {     // alias_compound_v1 (H078, unified rulebook): rescue-only resolution when the old scoring resolved no type
      if (DA1.enabled()) { const r_ = DA1.rescue(ix, g, M, cfg, learned, ph, ti, ctx, PE, { CLS, stem, dot }); if (r_ !== null) { best = r_; g.dt_rescue = 1; } }
    } catch (e) { /* swallowed like the reference */ }
  }
  if (best === null) return;
  const [key, p, t, mg, kind] = best;
  g.dt_conf = Number(key[1]); g.dt_margin = Number(mg); g.dt_kind = parseInt(kind, 10);
  if (key[0]) {
    const ps = p.join(' '); const pl = ps.endsWith('s') && !ps.endsWith('ss');
    g.types = [[t, pl]]; g.syn = 1; g.syn_phrase = ps; g.syn_cos = Number(key[1]); g.syn_margin = Number(mg);
    g.masked = g.masked.replace(new RegExp('\\b' + p.map(reEscape).join('\\s+') + '\\b'), pl ? 'DOCTYPES' : 'DOCTYPE');
  }
}
