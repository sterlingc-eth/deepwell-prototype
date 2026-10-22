/** anydoc.js - port of lib/anydoc.py + lib/anydoc2.py + lib/anydoc2_hook.py (recipe switch anydoc2_v1, STRICT operating point, anydoc3/anydoc4 tiers are NOT part of the unified rulebook).
 * Generic document-field answers for questions the reader RELEASED, industry-pack companies only (the caller says so: buildIndex(..., { pack: true }) or records.packWording).
 * Part of the unified rulebook (unified1.js, env DONOVAN_READER_V2_UNIFIED); never loaded into the answer path while that switch is off.
 * Constants (word lists, regex sources, tables) live in data/anydoc_consts.json + data/anydoc2_tables.json, generated from the Python modules. Never throws: maybe() returns null to keep the reader's own answer. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './models.js';

let K = null; let T2 = null;
const rd = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
let STOP, ABBR, LEX, REF, REFG, NAMEY, CLAUSEY, DATEQ, TOTQ, PARTYQ, BADQ, AGGQ, ROLEW, HAND, STRONG, WEAK, CHAT, CORE_X, MON;
function load() {
  if (K) return;
  K = rd('anydoc_consts.json'); T2 = rd('anydoc2_tables.json');
  STOP = new Set(K.STOP); ABBR = K.ABBR; LEX = K.LEX; ROLEW = new Set(K.ROLEW); HAND = K.HAND; STRONG = K.STRONG; WEAK = K.WEAK; CHAT = K.CHAT; CORE_X = new Set(K.CORE_X); MON = K.MON;
  const rx = (n, g = '') => new RegExp(K[n][0], K[n][1] + g);
  REF = rx('REF'); REFG = rx('REF', 'g'); NAMEY = rx('NAMEY'); CLAUSEY = rx('CLAUSEY'); DATEQ = rx('DATEQ'); TOTQ = rx('TOTQ'); PARTYQ = rx('PARTYQ'); BADQ = rx('BADQ'); AGGQ = rx('AGGQ');
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const re = (pat, flags = '') => new RegExp(pat, flags);
const cpLen = (s) => Array.from(s).length;
const pyStrip = (s, chars) => { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); };

// ---- anydoc.py
export function stem(w) {
  w = pyStrip(w.toLowerCase(), '.,:;?!\'"()');
  for (const suf of ['ings', 'ing', 'ies', 'es', 's', 'ed', 'ly']) if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, w.length - suf.length) + (suf === 'ies' ? 'y' : '');
  return w;
}
const stripApos = (s) => s.replace(/'s?$/, '');
function toks0(s) {
  const out = [];
  for (const w of s.match(/[A-Za-z][A-Za-z']+/g) || []) { if (!STOP.has(stripApos(w.toLowerCase())) && w.length > 1) out.push(stem(stripApos(w))); }
  return out;
}
export function toks(s) { load(); return toks0(s).map((t) => stem(has(ABBR, t) ? ABBR[t] : t)); }
function ed1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}
export function sim(a, b) {
  if (a === b) return 1.0;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))) return 0.8;
  if (a.length >= 5 && b.length >= 5 && ed1(a, b)) return 0.7;
  return 0.0;
}
const dim = (y, m) => [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const p2 = (n) => String(n).padStart(2, '0');
export function parseDate(s) {
  const out = [];
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push([+m[1], +m[2], +m[3]]);
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push([+m[3], +m[1], +m[2]]);
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g)) { const k = m[1].toLowerCase(); if (has(MON, k)) out.push([+m[3], MON[k], +m[2]]); }
  const r = [];
  for (const [y, mo, d] of out) if (y >= 1 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1 && d <= dim(y, mo)) r.push(`${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}`);
  return r;
}
export function parseMoney(s) {
  const v = [];
  for (const m of s.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s*([kKmM])?/g)) {
    const t = m[1].replace(/,/g, ''); if (t === '' || Number.isNaN(Number(t))) continue;
    let x = Number(t); if (m[2]) x *= 'kK'.includes(m[2]) ? 1000 : 1e6;
    v.push(x);
  }
  return v;
}
const KVRE = /^([A-Za-z][A-Za-z0-9 \/#&'().-]{0,40}?):\s*([^\n]+)$/;
const isUpper = (s) => s !== s.toLowerCase() && s === s.toUpperCase();
class Doc {
  constructor(did, pages) {
    this.id = did; this.kv = []; this.sent = []; this.title = ''; this.lines = [];
    for (const [pno, text] of pages) {
      const L = text.split('\n');
      for (let i = 0; i < L.length; i++) {
        const ln = L[i].trim();
        if (!ln) continue;
        this.lines.push([pno, ln]);
        if (pno === 1 && i === 1 && isUpper(ln)) { this.title = ln; continue; }
        if (i === 0 || ln.includes(' - page ') || ln.toLowerCase() === 'terms and conditions') continue;
        const parts = ln.split(/\s{2,}/).filter((p) => p);
        const kvs = parts.map((p) => KVRE.exec(p));
        if (kvs.every((m) => m)) { for (const m of kvs) this.kv.push([m[1].trim(), m[2].trim(), pno, ln]); } else if (cpLen(ln) > 15) this.sent.push([ln, pno]);
      }
    }
    const f1 = this.kv.find(([k, v]) => /\b(no|number|#|ref)\b/.test(k.toLowerCase()) && REF.test(v));
    this.docno = f1 ? f1[1] : null;
    this.dates = []; for (const [k, v, p, ln] of this.kv) for (const d of parseDate(v)) this.dates.push([k, d, p, ln]);
    this.party = this.kv.find(([k, v]) => NAMEY.test(v) && !/\d/.test(v) && !['signed', 'tier', 'status', 'prepared by', 'technician', 'tech', 'agent'].includes(k.toLowerCase())) || null;
    const tot = this.kv.filter(([k, v]) => /total|amount|balance|due|price|fee|cost/.test(k.toLowerCase()) && parseMoney(v).length);
    this.total = tot.find((t) => t[0].toLowerCase().includes('total')) || (tot.length ? tot[0] : null);
  }
}
const cmpPage = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
export class AnyIndex {
  constructor(pages) {
    load();
    const pg = new Map();
    for (const p of pages) { let l = pg.get(p.document_id); if (!l) { l = []; pg.set(p.document_id, l); } l.push([p.page_no, p.text]); }
    this.docs = new Map(); for (const [did, v] of pg) this.docs.set(did, new Doc(did, [...v].sort(cmpPage)));
    const df = new Map(); let n = 0;
    for (const D of this.docs.values()) for (const [, ln] of D.lines) { n++; for (const t of new Set(toks(ln))) df.set(t, (df.get(t) || 0) + 1); }
    this.idf = new Map(); for (const [t, c] of df) this.idf.set(t, Math.log((n + 1) / (c + 0.5)));
    this.maxidf = Math.log(n + 1);
    this.byno = new Map();
    for (const D of this.docs.values()) if (D.docno) { const k = D.docno.toUpperCase().replace(/ /g, '-'); let l = this.byno.get(k); if (!l) { l = []; this.byno.set(k, l); } l.push(D); }
  }
}
function findRefs(q, I) {
  const out = [];
  for (const m of q.matchAll(REFG)) { const k = `${m[1].toUpperCase()}-${m[2]}`; const l = I.byno.get(k); if (l && l.length === 1 && !out.includes(l[0])) out.push(l[0]); }
  return out;
}
function resolve(q, I) {
  const R = findRefs(q, I); if (R.length) return [R, 'docno'];
  const ds = new Set(parseDate(q)); if (!ds.size) return [[], 'none'];
  const ql = q.toLowerCase(); const qt = new Set(toks(q)); const C = [];
  for (const D of I.docs.values()) {
    if (!D.dates.slice(0, 1).some((x) => ds.has(x[1]))) continue;
    if (!D.party || !ql.includes(D.party[1].toLowerCase())) continue;
    const tt = new Set(toks(D.title)); let sc = 0; for (const t of tt) if ([...qt].some((u) => sim(t, u) >= 0.8)) sc++;
    C.push([sc, D]);
  }
  if (!C.length) return [[], 'none'];
  C.sort((a, b) => b[0] - a[0]);
  if (C.length > 1 && C[0][0] === C[1][0]) return [[], 'ambiguous'];
  return [[C[0][1]], 'party+date'];
}
function residual(q, D) {
  const rm = new Set([...toks(D.title), ...toks(D.party ? D.party[1] : ''), 'dated', 'date']);
  return toks(q.replace(REFG, ' ')).filter((t) => !rm.has(t) && !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(t));
}
function tscore(qt, tt, I, oov = 0.0) {
  let num = 0.0, den = 0.0, hits = 0;
  for (const q of new Set(qt)) {
    const w = I.idf.has(q) ? I.idf.get(q) : (has(LEX, q) ? I.maxidf : oov * I.maxidf);
    if (w <= 0) continue;
    let m = 0; for (const t of tt) { const s = sim(q, t); if (s > m) m = s; const l = 0.9 * ((has(LEX, q) && has(LEX[q], t)) ? LEX[q][t] : 0); if (l > m) m = l; }
    den += w; num += w * m; if (m >= 0.7) hits++;
  }
  return [den ? num / den : 0.0, hits];
}
const f2 = (x) => x.toFixed(2);
function answer(q, I) {
  const [R] = resolve(q, I); const ql = q.toLowerCase();
  if (!R.length) return null;
  if (R.length === 2 && /\b(higher|lower|bigger|larger|smaller|more|less|greater|cheaper|pricier)\b/.test(ql)) {
    const [a, b] = R; if (!(a.total && b.total)) return null;
    const va = parseMoney(a.total[1])[0], vb = parseMoney(b.total[1])[0];
    if (va === vb) return null;
    const hi = /\b(higher|bigger|larger|more|greater|pricier)\b/.test(ql);
    const w = ((va > vb) === hi) ? a : b;
    return { kind: 'ref', value: w.docno.toUpperCase(), doc: w.id, page: w.total[2], line: w.total[3], why: 'compare totals', nums: [va, vb] };
  }
  if (R.length !== 1) return null;
  const D = R[0]; const thr = parseMoney(q);
  if (/\b(over|under|above|below|more than|less than|at least|at most|exceed|greater than)\b/.test(ql) && thr.length && D.total) {
    const v = parseMoney(D.total[1])[0], t = thr[0]; let yes;
    if (/\b(over|above|more than|exceed|greater than)\b/.test(ql)) yes = v > t; else if (/\b(under|below|less than)\b/.test(ql)) yes = v < t; else yes = ql.includes('at least') ? v >= t : v <= t;
    return { kind: 'yesno', value: yes ? 'yes' : 'no', doc: D.id, page: D.total[2], line: D.total[3], why: 'amount vs threshold' };
  }
  const res = residual(q, D); const clausey = CLAUSEY.test(ql); const qall = toks(q.replace(REFG, ' '));
  const yesno = /\byes or no\b|^\W*(is|does|do|are|was|has|have)\b|\banything on\b|\bis .* (addressed|covered|mentioned|included)\b|\b(does|do|is|are|has|have)\b[^?]*\b(include|includ|contain|mention|address|cover|list|say anything|have any)/.test(ql) && !/\b(what|which|who|whom|when|how|where|tell me|read me|show me)\b/.test(ql);
  const C = [];
  for (const [k, v, p, ln] of D.kv) {
    const kt = toks(k); if (!kt.length) continue;
    if (D.party && ln === D.party[3] && !PARTYQ.test(ql)) continue;
    const [sc, h] = tscore(res, kt, I, 0.5);
    let cn = 0; for (const t of kt) if (qall.some((u) => sim(t, u) >= 0.7)) cn++;
    const cov = cn / kt.length;
    if (sc < 0.8 || clausey) continue;
    C.push([h ? (0.5 * sc + 0.5 * cov + ((cov === 1.0 && sc >= 0.9) ? 0.1 : 0.0) - (clausey ? 0.2 : 0.0)) : 0.0, 'kv', [k, v, p, ln], ln]);
  }
  const bare = !res.filter((t) => !ROLEW.has(t)).length;
  const rb = bare ? 1.15 : 0.0;
  if (D.dates.length && DATEQ.test(ql) && !clausey) { const [k, d, p, ln] = D.dates[0]; C.push([rb, 'date', [k, d, p, ln], ln]); }
  if (D.total && TOTQ.test(ql) && !clausey) C.push([rb, 'total', D.total, D.total[3]]);
  if (D.party && PARTYQ.test(ql)) C.push([rb, 'party', D.party, D.party[3]]);
  const lines = D.sent.map(([t, p]) => [t, p]).concat(D.kv.filter(([k, , , ln]) => k.trim().split(/\s+/).filter((x) => x).length >= 3 && !/^(signed|date|document no)\b/.test(ln.toLowerCase())).map(([, , p, ln]) => [ln, p]));
  for (const [sent, p] of lines) {
    let [sc, h] = tscore(res, toks(sent), I);
    if (!h) continue;
    if (h < 2 && !clausey && !yesno) sc -= 0.25;
    if (h < 2) sc -= 0.3;
    C.push([sc + ((clausey || yesno) ? 0.05 : 0.0), 'sent', [sent, p], sent]);
  }
  if (!C.length) return null;
  C.sort((a, b) => b[0] - a[0]);
  const [s0, kind, val, key0] = C[0];
  const rival = C.slice(1).find((c) => c[3] !== key0) || null; const s1 = rival ? rival[0] : 0.0;
  let out = null;
  if (rival && rival[1] !== kind && rival[0] >= 0.75 && (kind === 'sent' || kind === 'kv' || rival[1] === 'sent' || rival[1] === 'kv')) return null;
  if (kind === 'sent') {
    if (s0 >= 0.75 && s0 - s1 >= 0.2) {
      const [sent, p] = val; const kvl = D.kv.find(([, , , ln]) => ln === sent) || null;
      if (kvl && !clausey && !yesno) out = { kind: 'field', value: kvl[1], key: kvl[0], doc: D.id, page: p, line: sent, why: `field-line ${kvl[0]} ${f2(s0)}` };
      else out = yesno ? { kind: 'yesno', value: 'yes', doc: D.id, page: p, line: sent, span: sent, why: `clause present ${f2(s0)}` } : { kind: 'span', value: sent, doc: D.id, page: p, line: sent, span: sent, why: `clause ${f2(s0)}` };
    }
  } else if (kind === 'kv') {
    if (s0 >= 0.95 && s0 - s1 >= 0.1) { const [k, v, p, ln] = val; out = { kind: 'field', value: v, key: k, doc: D.id, page: p, line: ln, why: `field ${k} ${f2(s0)}` }; }
  } else if (s0 >= 0.85 && (s0 - s1 >= 0.05 || (rival && rival[0] < 0.75))) {
    const [k, v, p, ln] = val; out = { kind, value: v, key: k, doc: D.id, page: p, line: ln, why: kind };
  }
  return out;
}

// ---- anydoc2.py
const CLAUSE_MIN = 0.80; let WEAKONLY = false;
const hand = {}; const chatS = new Set(); let inited = false; let cueKeys = null; let wrapS = null; let cueWrap = null;
function init2() {
  if (inited) return; inited = true;
  for (const [r, ws] of Object.entries(HAND)) for (const w of ws.split(' ')) for (const t of toks(w)) hand[t] = r;
  for (const w of CHAT.split(' ')) for (const t of toks(w)) chatS.add(t);
  cueKeys = Object.keys(T2.cue); wrapS = new Set(T2.wrap); cueWrap = cueKeys.concat([...wrapS]);
}
const isTrue = (x) => x !== undefined;
function wm(w, c) {
  if (w === c) return true;
  if (w.length < 5 || c.length < 4) return false;
  if (ed1(w, c)) return true;
  if (w.length !== c.length) return false;
  let d = 0; for (let i = 0; i < w.length; i++) if (w[i] !== c[i]) d++;
  return d === 2 && [...w].sort().join('') === [...c].sort().join('');
}
const abbr = (w) => (has(ABBR, w) ? ABBR[w] : w);
function roleOf(ql, skip) {
  const ws = (ql.match(/[a-z]+/g) || []).filter((w) => !skip.has(stem(w))).map(abbr);
  const st = new Set();
  for (const [r, l] of Object.entries(STRONG)) for (const w of ws) for (const c of l.split(' ')) if (wm(w, c)) st.add(r);
  if (ws.includes('much') || (ws.includes('how') && ws.includes('many') && ws.includes('dollars'))) st.add('total');
  WEAKONLY = false;
  if (st.size === 1) return [...st][0];
  if (st.size === 0) {
    const wk = new Set();
    for (const [r, l] of Object.entries(WEAK)) for (const w of ws) for (const c of l.split(' ')) if (wm(w, c)) wk.add(r);
    if (wk.size === 1) {
      WEAKONLY = true; const r = [...wk][0];
      if (r === 'party') {
        const pn = WEAK.party.split(' ').slice(3);
        const nouns = []; ws.forEach((w, i) => { if (pn.some((c) => wm(w, c))) nouns.push(i); });
        const good = nouns.filter((i) => (i > 0 && ['which', 'what', 'whose'].includes(ws[i - 1])) && !(i + 1 < ws.length && ['is', 'are', 'was', 'called', 'waiting', 'on', 'asking', 'has', 'wants', 'here'].includes(ws[i + 1])));
        if (!good.length && !ws.some((w) => ['under', 'tied', 'filed'].some((c) => wm(w, c)))) return null;
      }
      return r;
    }
    return null;
  }
  const has2 = (a, b) => st.size === 2 && st.has(a) && st.has(b);
  if (has2('total', 'party') && /\b(price|amount|total)\b/.test(ql)) return 'total';
  if (has2('date', 'party') && /issued to|belongs? to/.test(ql)) return 'party';
  if (has2('date', 'total') && /face|price|amount|net|total/.test(ql) && !/\b(date|dated|day)\b/.test(ql)) return 'total';
  return null;
}
function known(t, r) {
  if (chatS.has(t)) return true;
  if (has(hand, t)) return r === undefined || r === null || hand[t] === r || wrapS.has(t);
  if (has(T2.cue, t) || wrapS.has(t)) return true;
  return cueWrap.some((u) => t.length >= 5 && u.length >= 5 && sim(t, u) >= 0.7);
}
function totalOf(D) {
  const ks = D.kv.filter((t) => /total|amount|balance|due|price|fee|cost/.test(t[0].toLowerCase()) && parseMoney(t[1]).length);
  const tt = ks.filter((t) => t[0].toLowerCase().includes('total'));
  if (tt.length === 1 && !tt[0][0].toLowerCase().includes('sub') && ks.length <= 3) return tt[0];
  return null;
}
function dateOf(D) { const vs = new Set(D.dates.map((x) => x[1])); return (vs.size === 1 && D.dates.length) ? D.dates[0] : null; }
function partyOf(D) {
  const ps = D.kv.filter(([, v]) => NAMEY.test(v) && !/\d/.test(v));
  const names = new Set(ps.filter(([k]) => !['tier', 'status', 'prepared by', 'technician', 'tech', 'agent'].includes(k.toLowerCase())).map(([, v]) => v.toLowerCase()));
  return (D.party && names.size === 1) ? D.party : null;
}
function coreOk(ql, D) {
  const tw = new Set(toks(D.title));
  const skip = new Set(toks(D.party ? D.party[1] : '')); for (const m of ql.matchAll(REFG)) skip.add(m[1].toLowerCase());
  const ws = ql.match(/[a-z]+/g) || [];
  const allowed = new Set([...STOP, ...CORE_X]); for (const l of [...Object.values(STRONG), ...Object.values(WEAK)]) for (const w of l.split(' ')) allowed.add(w);
  const cl = []; for (const l of [...Object.values(STRONG), ...Object.values(WEAK)]) for (const c of l.split(' ')) cl.push(c);
  const cues = new Set(); ws.forEach((w, i) => { if (cl.some((c) => wm(abbr(w), c))) cues.add(i); });
  for (const i of cues) {
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < ws.length && !cues.has(j) && !allowed.has(ws[j]) && !skip.has(stem(ws[j])) && !skip.has(ws[j]) && ws[j].length > 1) {
        const k2 = j < i ? j - 1 : j + 1;
        if (tw.has(stem(ws[j])) && k2 >= 0 && k2 < ws.length && k2 !== i && tw.has(stem(ws[k2]))) continue;
        return false;
      }
    }
  }
  return true;
}
function roleAnswer(q, I) {
  const [R, how] = resolve(q, I);
  if (R.length !== 1) return null;
  const D = R[0]; let ql = q.toLowerCase();
  ql = ql.replace(/when you (?:get|have) a (?:sec|minute|moment)|one detail|a detail/g, ' ');
  for (const t of [D.title, D.party ? D.party[1] : '']) if (t) ql = ql.split(t.toLowerCase()).join(' ');
  if (BADQ.test(ql) || AGGQ.test(ql) || parseMoney(q).length) return null;
  if (how === 'party+date' && !/\bfrom\b/.test(ql)) return null;
  const res = residual(q, D); const r0 = roleOf(ql, new Set(toks(D.title)));
  if (!r0) return null;
  const idfKeys = null; void idfKeys;
  for (const t of res) {
    if (!known(t, r0) && (WEAKONLY || I.idf.has(t) || [...I.idf.keys()].some((u) => Math.abs(u.length - t.length) <= 1 && sim(t, u) >= 0.7))) return null;
  }
  if (!coreOk(ql, D)) return null;
  {
    const ws = (ql.match(/[a-z]+/g) || []).map((w) => stem(abbr(w)));
    const cl = []; for (const l of [...Object.values(STRONG), ...Object.values(WEAK)]) for (const c of l.split(' ')) cl.push(c);
    const cues = new Set(); ws.forEach((w, i) => { if (cl.some((c) => wm(w, c))) cues.add(i); });
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (res.includes(w) && !known(w, r0) && (cues.has(i - 1) || cues.has(i + 1) || cues.has(i - 2) || cues.has(i + 2))) return null;
    }
    if (/\b(client|customer|tenant|member|owner|guest|patient) (is|are|was|waiting|called|on hold|just)\b/.test(ql)) return null;
  }
  let x; let kind;
  if (r0 === 'total') { x = totalOf(D); kind = 'total'; } else if (r0 === 'date') { x = dateOf(D); kind = 'date'; } else { x = partyOf(D); kind = 'party'; }
  if (!x) return null;
  return { kind, value: x[1], key: x[0], doc: D.id, page: x[2], line: x[3], why: 'role-' + r0 };
}
function fieldAnswer(q, I) {
  const [R, how] = resolve(q, I);
  if (R.length !== 1) return null;
  const D = R[0]; const ql = q.toLowerCase();
  if (BADQ.test(ql) || AGGQ.test(ql) || parseMoney(q).length) return null;
  if (how === 'party+date' && !/\bfrom\b/.test(ql)) return null;
  const qt = new Set(toks(q.replace(REFG, ' ')));
  for (const t of toks(D.title)) qt.delete(t);
  for (const t of toks(D.party ? D.party[1] : '')) qt.delete(t);
  const cands = new Map();
  const fm = (t, u) => t === u || (t.length >= 5 && u.length >= 5 && (ed1(t, u) || (t.length === u.length && [...t].sort().join('') === [...u].sort().join('') && [...t].filter((x, i) => x !== u[i]).length === 2)));
  for (const [k, v, p, ln] of D.kv) {
    const kt = toks(k);
    if (!kt.length || kt.length > 4) continue;
    if (D.party && ln === D.party[3]) continue;
    if (/document|\bno\b|number|signed|\bdate\b/.test(k.toLowerCase())) continue;
    if (kt.every((t) => wrapS.has(t) || has(hand, t))) continue;
    if (NAMEY.test(v) && !/\d/.test(v)) continue;
    if (kt.every((t) => [...qt].some((u) => fm(t, u)))) { const kl = k.toLowerCase(); if (!cands.has(kl)) cands.set(kl, []); cands.get(kl).push([k, v, p, ln]); }
  }
  if (!cands.size) return null;
  const ks = [...cands.keys()].sort((a, b) => toks(b).length - toks(a).length);
  if (ks.length > 1) {
    const top = new Set(toks(ks[0]));
    for (const o of ks.slice(1)) { const so = new Set(toks(o)); if (!(so.size < top.size && [...so].every((x) => top.has(x)))) return null; }
  }
  const L = cands.get(ks[0]);
  if (new Set(L.map((x) => x[1])).size !== 1) return null;
  const [k, v, p, ln] = L[0];
  const kt = new Set(toks(k)); const ws = (ql.match(/[a-z]+/g) || []).map((w) => stem(abbr(w)));
  const pos = new Set(); ws.forEach((w, i) => { if ([...kt].some((u) => fm(w, u))) pos.add(i); });
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (pos.has(i) || STOP.has(w) || w.length < 3) continue;
    if ((pos.has(i - 1) || pos.has(i + 1)) && !(wrapS.has(w) || has(hand, w))) return null;
  }
  return { kind: 'field', value: v, key: k, doc: D.id, page: p, line: ln, why: 'field-named ' + k };
}
function answer2(q, I) {
  init2();
  if (AGGQ.test(q) && !/\b(higher|lower|bigger|larger|smaller|cheaper|pricier|greater)\b/i.test(q)) return null;
  let a = answer(q, I);
  if (a !== null && CLAUSE_MIN > 0 && a.why.startsWith('clause')) { const m = /([\d.]+)$/.exec(a.why); if (m && Number(m[1]) < CLAUSE_MIN) a = null; }
  if (a !== null) return a;
  a = roleAnswer(q, I);
  if (a !== null) return a;
  return fieldAnswer(q, I);
}
// ---- anydoc_hook.py
function textOf(a) {
  const k = a.kind;
  if (k === 'yesno') return a.value.charAt(0).toUpperCase() + a.value.slice(1).toLowerCase() + ' - ' + (a.span || a.line);
  if (k === 'ref') return a.value + ': $' + (a._hi === false ? Math.min(...a.nums) : Math.max(...a.nums)).toFixed(2);
  if (k === 'span') return a.span;
  return a.value;
}
/** pred = the reader's own (not answered) decision. Returns the anydoc2 answer in the same shape, or null (keep the reader's decision). ix.pack must be true; ix.anyIndex is built once from the company's pages. */
export function maybe(ix, rawPages, q, pred) {
  if (pred.answered) return null;
  try {
    load(); init2();
    if (!ix.pack) return null;
    if (!ix._anyIndex) ix._anyIndex = new AnyIndex(rawPages);
    const a = answer2(q, ix._anyIndex);
    if (a === null) return null;
    if (a.kind === 'ref') { const ql = q.toLowerCase(); a._hi = ['higher', 'bigger', 'larger', 'more', 'greater', 'pricier'].some((w) => ql.includes(w)); }
    return { answered: true, text: textOf(a), docs: [a.doc], page: a.page ?? null, pv: pred.pv, intent: pred.intent, reason: 'anydoc2', anydoc: { page: a.page ?? null, line: a.line ?? null, why: a.why ?? null }, cands: pred.cands };
  } catch (e) { return null; }
}
void isTrue; void re;
