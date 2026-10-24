/** evidence4.js - v4 port of lib/evidence4.py + lib/evidence4_hook.py (supersedes evidence v1-v3) (lane evid2fix, 2026-10-23). v4 = v3 + role-party exemption from the topic check, 'terms' followed by the answered field key is not a clause ask, anydoc answers are gated whatever intent the pipeline labelled, table-cell / date / total / table-row (support) checks. v3 text follows:: evidence-gated answering, the LAST step of the reader (PLAN Spec 4).
 * ONE env switch, default OFF: DONOVAN_READER_V2_EVIDENCE4=1 (optional DONOVAN_READER_V2_EVIDENCE4_CONFLICT=both|abstain; default 'off' = same-attribute field-vs-clause conflicts are not acted on).
 * OFF = nothing in this file is consulted (index.js calls it only when the switch is on). Pure function of (question, final prediction, the cited document's text and stored extractions).
 * Checks, in order, on an ANSWERED prediction: A topic (a field-shaped answer needs its key's head noun in the question topic, noise segments / tails / anchors removed),
 * C clause (question asks for language/wording/clause/terms: a field is not an answer, hand over to the one clause sentence or abstain),
 * B conflict (a clause sentence on the same document gives a different money/percent amount for the same key word: show both, or abstain), D claim (numbers / single date / names must be in the document).
 * Never throws: gate() returns null to keep the reader's own answer. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './models.js';
import { AnyIndex, toks, sim, parseDate } from './anydoc.js';

const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const EV = { on: false, conflict: 'off' };
export function configureEvidence() { EV.on = truthy(process.env.DONOVAN_READER_V2_EVIDENCE4); { const c = String(process.env.DONOVAN_READER_V2_EVIDENCE4_CONFLICT ?? '').toLowerCase(); EV.conflict = (c === 'abstain' || c === 'both') ? c : 'off'; } return EV.on; }
export const evidenceOn = () => EV.on;

let K = null; let REF, REFG, NAMEY, LEX;
function load() { if (K) return; K = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'anydoc_consts.json'), 'utf8')); REF = new RegExp(K.REF[0], K.REF[1]); REFG = new RegExp(K.REF[0], K.REF[1] + 'g'); NAMEY = new RegExp(K.NAMEY[0], K.NAMEY[1]); LEX = K.LEX; }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const FIELD = /^([A-Za-z][A-Za-z0-9 /#&'-]{0,40}): (.+?)( \(.*)?$/;
const GENERIC = new Set('name number no date amount total type status id code value info detail'.split(' '));
const WH = /\b(what|which|who|whom|whose|when|where|how|why|tell|show|read|look|check|pull|give|find|lookup|list)\b/;
const AUX0 = /^\s*(is|are|was|were|does|do|did|can|could|has|have)\b/;
const GER = /\b(asking|waiting|wondering|calling|wanting|needing|trying|hoping|working|standing|sitting|driving|heading|running|traveling|travelling|covering|going|getting|looking|checking|holding|texting|emailing|walking|parked|outside)\b/;
const PREPDET = /^\s*(in|at|on|from|with|for)\s+(the|a|an|my|our|his|her|their)\s+[a-z]+/;
const CONJ0 = /^\s*(before|until|while|once|after)\b/;
const TAIL = /\b(before|until|while|once|when|after)\s+(the|a|an|my|our|their|his|her|your)\s+[a-z]+\s+[a-z]+\s*$/;
const POSS = /\b(?!what|that|it|there|here|who|how|where|let|he|she)([a-z]{2,})'s\b/;
const LANG = /\b(language|wording|worded|clauses?|terms|provisions?|fine print|spelled out)\b/;
const TRAIL = /\b(please|pls|thx|thanks|thank you|asap|ok|okay)\s*$/;
const MONEY = /\$\s?([\d,]+(?:\.\d+)?)/g;
const PCT = /(\d+(?:\.\d+)?)\s?%/g;
const NUMR = /(?<![A-Za-z0-9-])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9-])/g;
const NAMEWORDS = /\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g;

function segments(q) {
  q = q.replace(REFG, ' REFX ');
  q = q.replace(/\$\s?[\d,.]+/g, ' '); q = q.replace(/\d+[./-]\d+[./-]\d+/g, ' DATEX ');
  q = q.replace(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g, ' DATEX ');
  q = q.replace(/\s[-–—]\s/g, ', ');
  return q.split(/[,;:?!.\n]+/).filter((s) => s.trim());
}
const PREP = /\b(on|for|about|regarding|with|of|in|at|from|before|after|until|while|once|to)\s+(the|a|an|my|our|his|her|their|this|that)?\s*/;
function afterPrep(s) { const m = PREP.exec(s); return m ? s.slice(m.index + m[0].length) : ''; }
function topicTokens(q, D, kt) {
  const keep = []; let seenMain = false;
  for (const seg of segments(q)) {
    let rescued = false; let s = seg.toLowerCase();
    const anchor = s.includes('refx') || s.includes('datex') || POSS.test(s);
    const frame = WH.test(s) || AUX0.test(s);
    let noise = !anchor && !frame && (GER.test(s) || PREPDET.test(s) || CONJ0.test(s) || /\bhere\b/.test(s));
    if (noise && !seenMain && kt && kt.length) { const rest = toks(afterPrep(s)); if (kt.some((k) => hasTok(k, rest))) { noise = false; rescued = true; } }
    if (noise && kt && kt.length && seenMain) { const need = kt.filter((k) => !GENERIC.has(k)); if (need.length >= 2) { const st = toks(s); if (need.every((k) => hasTok(k, st))) { noise = false; rescued = true; } } }
    if (!noise && (anchor || frame)) seenMain = true;
    if (noise) continue;
    s = s.trim().replace(TRAIL, ''); if (!rescued) s = s.replace(TAIL, '');
    keep.push(s);
  }
  const txt = keep.join(' ').replace(/refx/g, ' ').replace(/datex/g, ' ');
  const names = new Set();
  if (D) for (const [, v] of D.kv) if (NAMEY.test(v) && !/\d/.test(v) && v.trim().includes(' ')) for (const t of toks(v)) names.add(t);
  if (kt) for (const k of kt) names.delete(k);
  return toks(txt).filter((t) => !names.has(t));
}
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function subseq(s, l) { let i = 0; for (const c of l) { if (i < s.length && s[i] === c) i++; } return i === s.length; }
function variants(t) { const out = [t]; for (const suf of ['ing', 'ed', 'es', 's', 'ly']) if (t.endsWith(suf) && t.length - suf.length >= 3) out.push(t.slice(0, t.length - suf.length)); return out; }
/** v4 typo tolerance (see evidence4.py _fuzzy) */
function fuzzy(a, b) {
  for (const x of variants(a)) for (const y of variants(b)) {
    if (x === y) return true;
    const m = Math.min(x.length, y.length);
    if (m >= 4 && osa(x, y) <= 1) return true;
    if (m >= 7 && osa(x, y) <= 2) return true;
    const [s_, l_] = x.length <= y.length ? [x, y] : [y, x];
    if (s_.length >= 3 && s_[0] === l_[0] && l_.length - s_.length <= 3 && subseq(s_, l_)) return true;
  }
  return false;
}
const mtok = (a, b) => {
  if (sim(a, b) >= 0.7) return true;
  if (a.length >= 5 && a.length === b.length && [...a].sort().join('') === [...b].sort().join('')) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; if (d === 2) return true; }      // one transposition (vnedor / vendor)
  return fuzzy(a, b);
};
function hasTok(tok, topic) {
  for (const t of topic) { if (mtok(tok, t)) return true; if (has(LEX, t) && has(LEX[t], tok) && LEX[t][tok] >= 0.5) return true; }
  return false;
}
function vtype(v) {
  v = v.trim().replace(/\.+$/, '');
  if (/^[$]?[\d,]+(\.\d+)?%?$/.test(v)) return 'num';
  if (/^\d{4}-\d\d-\d\d$/.test(v) || parseDate(v).length) return 'date';
  if (/^(Dr\.? |Mr\.? |Ms\.? )?[A-Z][A-Za-z.'&-]+( [A-Z][A-Za-z.'&-]+){1,3}$/.test(v)) return 'person';
  return 'text';
}
function fieldOf(pred) {
  const t = pred.text || '';
  const m = t.includes(' (page ') ? null : FIELD.exec(t);
  if (m) return [m[1].trim(), m[2].trim()];
  const ad = pred.anydoc || {}; const ln = ad.line || '';
  if (['field', 'role', 'date', 'total'].some((p) => String(ad.why ?? '').startsWith(p)) && ln.includes(':')) {
    const k = ln.split(':')[0].trim();
    if (/^[A-Za-z][A-Za-z0-9 /#&'().-]{0,40}$/.test(k)) return [k, t.trim()];
  }
  return null;
}
const r2 = (x) => Math.round(x * 100) / 100;
function amounts(s) {
  const out = [];
  for (const m of s.matchAll(MONEY)) out.push(['$', r2(Number(m[1].replace(/,/g, '')))]);
  for (const m of s.matchAll(PCT)) out.push(['%', Number(m[1])]);
  return out;
}
function valAmounts(v) {
  const a = amounts(v); if (a.length) return a;
  const m = /^([\d,]+(?:\.\d+)?)$/.exec(v.trim());
  return m ? [['$', r2(Number(m[1].replace(/,/g, '')))]] : [];
}
function clauseSents(D, kt) {
  const out = [];
  for (const [s, p] of D.sent) { const st = toks(s); if (kt.some((k) => st.some((t) => mtok(k, t) && k.length >= 4))) out.push([s, p]); }
  return out;
}
const MONEYW = new Set('fee charge price rate limit cost amount total payment due balance copay deposit rent premium fine penalty dues tax'.split(' '));
const GENMONEY = new Set('fee charge price rate limit cost amount total payment due balance'.split(' '));
const ftype = (kt, val) => val.includes('%') ? '%' : (val.includes('$') || kt.some((k) => MONEYW.has(k))) ? '$' : null;
const spec = (kt) => kt.filter((x) => !GENERIC.has(x) && !GENMONEY.has(x) && x.length >= 4);
const sentHas = (st, w) => st.some((t) => mtok(w, t));
function conflictSent(D, kt, val) {
  const ft = ftype(kt, val); if (ft === null) return null;
  const va = valAmounts(val).filter((x) => x[0] === ft); if (!va.length) return null;
  const S = spec(kt); if (!S.length) return null;
  const head = kt[kt.length - 1];
  for (const [s, p] of D.sent) {
    const st = toks(s);
    if (!S.every((w) => sentHas(st, w))) continue;
    if (!GENERIC.has(head) && !sentHas(st, head)) continue;
    const sa = amounts(s).filter((x) => x[0] === ft);
    if (sa.length && !sa.some((x) => va.some((y) => y[0] === x[0] && y[1] === x[1]))) return [s, p];
  }
  return null;
}
function betterField(D, key, kt, top) {
  const kl = key.toLowerCase();
  for (const [k, , , ln] of D.kv) {
    if (k.toLowerCase() === kl) continue;
    if (D.party && ln === D.party[3]) continue;
    const k2 = toks(k).filter((x) => !GENERIC.has(x));
    if (k2.length && k2.every((x) => hasTok(x, top))) return k;
  }
  return null;
}
function blobOf(D) { if (D._blob === undefined) D._blob = D.lines.map((x) => x[1]).join(' ').toLowerCase(); return D._blob; }
function claimOk(val, D, extra) {
  const blob = blobOf(D) + ' ' + extra.toLowerCase(); const flat = blob.replace(/,/g, '');
  const dates = new Set(); for (const [, ln] of D.lines) for (const d of parseDate(ln)) dates.add(d);
  for (const d of extra.match(/\d{4}-\d\d-\d\d/g) || []) dates.add(d);
  const ds = parseDate(val);
  if (ds.length === 1 && !dates.has(ds[0])) return false;
  if (/^\d{4}-\d\d-\d\d$/.test(val.trim()) && !dates.has(val.trim())) return false;
  for (const x of val.replace(/\d{4}-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{4}/g, ' ').match(NUMR) || []) if (!flat.includes(x.replace(/,/g, ''))) return false;
  for (const nm of val.match(NAMEWORDS) || []) if (!blob.includes(nm.toLowerCase())) return false;
  return true;
}
/** v3: words of the document TYPE/title being referenced ("key terms digest", "terms outline") are not part of the question's own ask: blank any run of >=2 title words ending at the title's last word (plural-insensitive) */
function escRe(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function ownAsk(ql, D) {
  const tw = ((D && D.title) || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (let i = 0; i < tw.length - 1; i++) {
    const run = tw.slice(i);
    ql = ql.replace(new RegExp('\\b' + run.map((w) => escRe(w.replace(/s+$/, '')) + 's?').join('\\W+') + '\\b', 'g'), ' ');
  }
  return ql;
}

const NOISEASK = new Set('line item row each entry listed person party people name individual someone anyone contact'.split(' '));
const CELLSEP = /\t|\s{2,}/;
const pyStrip = (x) => x.replace(/^\s+|\s+$/g, '');
function rowLike(pred) {
  const ad = pred.anydoc || {};
  if (!String(ad.why ?? '').startsWith('clause')) return false;
  const t = pred.text || '';
  if (t.includes(' (page ') || FIELD.test(t)) return false;
  if (CELLSEP.test(t)) return t.split(CELLSEP).filter((c) => pyStrip(c)).length >= 3;
  return (t.split(', ').length - 1) >= 2 && t.includes('$');
}
function cellsOf(line) {
  const c = line.split(CELLSEP).map(pyStrip).filter((x) => x);
  return c.length >= 2 ? c : line.split(', ').map(pyStrip).filter((x) => x);
}
function rowSupport(q, pred, D) {
  const ad = pred.anydoc || {}; const line = ad.line || pred.text || '';
  const lt = new Set(toks(line + ' ' + (pred.text || '')));
  const cells = cellsOf(line); const lab = new Set(cells.length ? toks(cells[0]).filter((x) => x.length >= 3) : []);
  let best = null; let bn = 0;
  for (const seg of segments(q)) { const st = new Set(toks(seg)); let n = 0; for (const x of lab) if (st.has(x)) n++; if (n > bn) { best = seg; bn = n; } }
  if (best === null) return false;
  let bl = best.toLowerCase();
  if (bl.includes('refx')) { const pre = bl.slice(0, bl.lastIndexOf('refx')); const ps = new Set(toks(pre)); let any = false; for (const x of lab) if (ps.has(x)) any = true; if (any) bl = pre; }
  const res = toks(bl.replace(/refx/g, ' ').replace(/datex/g, ' ')).filter((t) => !lt.has(t) && !GENERIC.has(t) && t.length >= 5 && !NOISEASK.has(t));
  if (!res.length) return false;
  const bt = new Set(toks(blobOf(D)));
  const sup = (t) => { if (bt.has(t)) return true; for (const b of bt) { if (mtok(t, b)) return true; if (has(LEX, t) && has(LEX[t], b) && LEX[t][b] >= 0.5) return true; } return false; };
  return !res.some(sup);
}
function cellOk(q, pred, D) {
  const ad = pred.anydoc || {}; const line = ad.line || ''; const t = pyStrip(pred.text || '');
  const cells = cellsOf(line);
  if (cells.length < 2) return true;
  if (t && !cells.slice(1).some((c) => c.toLowerCase() === t.toLowerCase()) && !line.toLowerCase().includes(t.toLowerCase())) return false;
  const lab = toks(cells[0]).filter((x) => x.length >= 3);
  if (!lab.length) return true;
  const qt = toks(q); let hit = 0;
  for (const x of lab) if (qt.some((y) => mtok(x, y) || (x.length >= 4 && y.length >= 4 && x.slice(0, 4) === y.slice(0, 4)))) hit++;
  return 2 * hit >= lab.length;
}
function termsIsField(qo, m, kt) {
  if (m[1] !== 'terms') return false;
  const rest0 = qo.slice(m.index + m[0].length).split(/\s[-\u2013\u2014]\s|[,.;?!:\n]/)[0];
  const tt = toks(rest0.replace(REFG, ' ')).slice(0, 3);
  return tt.length > 0 && tt.every((x) => kt.some((k) => mtok(x, k)));
}
/** -> null (keep) or [reason, replacement|null] */
export function check(q, pred, D, extra = '', conflict = 'off') {
  load();
  if (!D) return null;
  const t = pred.text || '';
  if (/^(Total|Earliest|Latest|Oldest|Newest|Count|Sum)\b.{0,60}\b(for|of)\b/.test(t) || (!(pred.intent === undefined || pred.intent === null || pred.intent === 'text') && !pred.anydoc)) return null;
  const f = fieldOf(pred); const ql = q.toLowerCase();
  if (f) {
    const [key, val] = f; const kt = toks(key);
    if (!kt.length) return null;
    const vt = vtype(val); const top = topicTokens(q, D, kt);
    let need = kt.filter((x) => !GENERIC.has(x)); if (!need.length) need = kt;
    let hit = 0; for (const x of need) if (hasTok(x, top)) hit++;
    const last = kt[kt.length - 1];
    let okk = (!GENERIC.has(last) ? hasTok(last, top) : hit > 0) || (need.length >= 2 && 2 * hit >= need.length);
    const anyhit = hit > 0 || hasTok(last, top);
    if (vt === 'person' && /\b(who|whom|whose)\b/.test(ql) && !okk) okk = true;
    if (vt === 'date' && /\b(when|what date|which date|what day)\b/.test(ql) && !okk) okk = true;
    if (vt === 'num' || vt === 'date') { okk = true; if (!anyhit && betterField(D, key, kt, top)) return ['role', null]; }
    if (String((pred.anydoc || {}).why ?? '') === 'role-party') okk = true;
    if (!okk) return ['topic', null];
    const qo = ownAsk(ql, D); const lm = LANG.exec(qo);
    const lang = lm && !kt.some((x) => ['term', 'clause', 'provision', 'languag', 'wording'].includes(x)) && !termsIsField(qo, lm, kt);
    let sp = spec(kt); if (!sp.length) sp = kt.filter((x) => !GENERIC.has(x) && x.length >= 4);
    if (lang) { const cl = clauseSents(D, sp); if (cl.length === 1) return ['clause_handover', { text: cl[0][0], page: cl[0][1] }]; return ['clause', null]; }
    if (conflict !== 'off') {
      const c = conflictSent(D, kt, val);
      if (c) {
        const [s, p] = c;
        if (conflict === 'both') return ['conflict', { text: 'Two figures on this document: ' + key + ': ' + val + ' (field); and the text says: ' + s + ' (page ' + p + ')', page: p }];
        return ['conflict', null];
      }
    }
    if (!claimOk(val, D, extra)) return ['claim', null];
    return null;
  }
  const ad4 = pred.anydoc || {};
  if (String(ad4.why ?? '').startsWith('table-cell')) { if (!cellOk(q, pred, D)) return ['cell', null]; if (!claimOk(t, D, extra)) return ['claim', null]; return null; }
  if (rowLike(pred)) { if (rowSupport(q, pred, D)) return ['support', null]; return null; }
  if (/\(page \d+, /.test(t)) { const sent = t.split(' (page ')[0]; if (!claimOk(sent, D, extra)) return ['claim', null]; }
  return null;
}
/** extra evidence text per document: stored extraction values + linked entity data (the answer's value may live there and not in the page text) */
export function extraOf(records) {
  const ex = new Map(); const add = (id, s) => { const l = ex.get(id); if (l) l.push(s); else ex.set(id, [s]); };
  for (const e of records.extractions || []) add(e.document_id, String(e.value ?? 'None'));
  const ent = new Map(); for (const e of records.entities || []) ent.set(e.id, Object.values(e.data || {}).map((v) => String(v)).join(' '));
  for (const l of records.document_entity_links || []) add(l.document_id, ent.get(l.entity_id) ?? '');
  const out = new Map(); for (const [k, v] of ex) out.set(k, v.join(' ')); return out;
}
/** pred = the reader's final decision for question q on index ix. Returns the new decision (abstention / hand-over) or null to keep pred. */
export function gate(ix, q, pred) {
  if (!EV.on || !pred.answered) return null;
  try {
    load();
    if (!ix._anyIndex) ix._anyIndex = new AnyIndex(ix.rawPages);
    if (!ix._evExtra) ix._evExtra = ix.records ? extraOf(ix.records) : new Map();
    const docs = pred.docs || []; const D = docs.length ? ix._anyIndex.docs.get(docs[0]) : null;
    const r = check(q, pred, D, D ? (ix._evExtra.get(D.id) ?? '') : '', EV.conflict);
    if (r === null) return null;
    const [reason, rep] = r;
    if (rep) return { ...pred, text: rep.text, evidence: reason };
    return { answered: false, reason: 'evidence:' + reason, text: '', docs: [], intent: pred.intent, evidence: reason };
  } catch (e) { return null; }
}
