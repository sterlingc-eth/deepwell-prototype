/**
 * dql/proposer/slots.js - the deterministic SLOT DETECTORS of the local plan proposer (R20). Pure; no model, no database.
 *
 * Slot values are never predicted: a name, a city, a brand, a stored category value, a kind of paper, a period and a money bound are found in the question
 * by exact lookup in the company's own vocabulary (dql/vocab.js compileVocab) and by the time reader (analytics.js resolveAnyTimeRange).
 *
 *   detectSlots(qt, vocab, today) -> {spans[], filters[], docType, docKinds, time, nums}
 *   maskView(qt, slots, lex, generic) -> string[]     the question's SHAPE: slots become typed placeholders, the company's own nouns <k>, numbers <n>
 */
import { resolveAnyTimeRange } from '../../analytics.js';

const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const MAXN = 5;
const MON = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;
const UNIT = /^(?:days?|weeks?|months?|quarters?|years?)$/;
const TIME_LEAD = new Set(['in', 'during', 'since', 'from', 'between', 'before', 'after', 'last', 'past', 'this', 'previous', 'prior', 'over', 'within', 'for', 'of', 'on', 'through', 'until', 'year', 'ytd', 'today', 'yesterday', 'the', 'as', 'by']);
const isTimeTok = (w) => /^(?:19|20)\d\d$/.test(w) || /^q[1-4]$/.test(w) || MON.test(w) || UNIT.test(w) || /^(?:ytd|today|yesterday|date)$/.test(w);

/** longest-first exact lookup of the company's own words in the question tokens */
function lookups(qt, vocab) {
  const spans = [];
  const words = qt.map((t) => t.w);
  const joinN = (i, n) => words.slice(i, i + n).join(' ');
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(MAXN, words.length - i); n >= 1; n--) {
      const k = joinN(i, n);
      const nm = n >= 2 ? vocab.names.get(k) : null;
      if (nm) spans.push({ i, j: i + n, kind: 'name', roles: nm, key: k });
      const doc = vocab.docPhrases.get(k);
      if (doc && k.length >= 3 && vocab.docTypesInUse.has(doc)) spans.push({ i, j: i + n, kind: 'doc', id: doc, key: k });
      const city = vocab.cities.get(k);
      if (city && k.length >= 3) spans.push({ i, j: i + n, kind: 'city', value: city, key: k });
      const brand = vocab.brands.get(k);
      if (brand && k.length >= 3) spans.push({ i, j: i + n, kind: 'brand', value: brand, key: k });
      for (const [field, m] of Object.entries(vocab.cat)) { const c = m.get(k); if (c && k.length >= 2) spans.push({ i, j: i + n, kind: 'cat', field, value: c, key: k }); }
    }
  }
  return spans;
}

const PRI = { name: 5, city: 4, brand: 3, cat: 2, doc: 1 };
function resolveOverlaps(spans) {
  spans.sort((a, b) => (b.j - b.i) - (a.j - a.i) || PRI[b.kind] - PRI[a.kind] || a.i - b.i);
  const taken = []; const out = [];
  for (const s of spans) {
    let ok = true; for (let x = s.i; x < s.j; x++) if (taken[x]) { ok = false; break; }
    if (!ok) continue;
    for (let x = s.i; x < s.j; x++) taken[x] = true;
    out.push(s);
  }
  return out.sort((a, b) => a.i - b.i);
}

const CMP = [
  [['more', 'than'], 'gt'], [['greater', 'than'], 'gt'], [['bigger', 'than'], 'gt'], [['larger', 'than'], 'gt'], [['higher', 'than'], 'gt'], [['over'], 'gt'], [['above'], 'gt'], [['exceeding'], 'gt'], [['exceeds'], 'gt'],
  [['at', 'least'], 'gte'], [['no', 'less', 'than'], 'gte'], [['minimum', 'of'], 'gte'],
  [['less', 'than'], 'lt'], [['fewer', 'than'], 'lt'], [['smaller', 'than'], 'lt'], [['lower', 'than'], 'lt'], [['cheaper', 'than'], 'lt'], [['under'], 'lt'], [['below'], 'lt'],
  [['at', 'most'], 'lte'], [['no', 'more', 'than'], 'lte'], [['up', 'to'], 'lte'],
];
const MONEY_UNIT = /^(?:dollars?|bucks?|usd)$/;
/** a money amount at token k: "$500" or "500 dollars" -> {value, len} */
function readMoney(w, k) {
  const x = w[k] ?? '';
  if (/^\$\d+(?:\.\d+)?$/.test(x)) return { value: Number(x.slice(1)), len: 1 };
  if (/^\d+(?:\.\d+)?$/.test(x) && MONEY_UNIT.test(w[k + 1] ?? '')) return { value: Number(x), len: 2 };
  return null;
}
const LOW = /^(?:less|under|below|fewer|lower|smaller)$/; const HIGH = /^(?:more|over|above|higher|greater|bigger|larger)$/;

/** "over $500", "at least $130 but no more than $850", "$70 or less", "$270 to $1,400" -> total filters (a money bound needs the $ sign or the word dollars: a bare number could be a count) */
function moneyFilters(qt, taken) {
  const out = []; const w = qt.map((t) => t.w);
  const push = (f, i, j) => { if (taken.slice(i, j).some(Boolean)) return false; out.push({ ...f, i, j }); for (let x = i; x < j; x++) taken[x] = true; return true; };
  for (let i = 0; i < w.length; i++) {
    if (taken[i]) continue;
    // between X and Y / X to Y / from X up to Y
    let st = i; if ((w[i] === 'between' || w[i] === 'from') && readMoney(w, i + 1)) st = i + 1;
    const m1 = readMoney(w, st);
    if (m1) {
      let k = st + m1.len;
      const sep = [['up', 'to'], ['to'], ['and'], ['through'], ['thru']].find((p) => p.every((x, d) => w[k + d] === x));
      if (sep) { const m2 = readMoney(w, k + sep.length); if (m2 && (st !== i || sep[0] === 'up' || sep[0] === 'to' || sep[0] === 'through' || sep[0] === 'thru') && (st !== i || w[i - 1] !== 'and')) { if (push({ field: 'total', op: 'between', value: [m1.value, m2.value] }, i, k + sep.length + m2.len)) { i = k + sep.length + m2.len - 1; continue; } } }
      // X or less / X or more
      if (w[k] === 'or' && (LOW.test(w[k + 1] ?? '') || HIGH.test(w[k + 1] ?? '') || w[k + 1] === 'under')) { if (push({ field: 'total', op: LOW.test(w[k + 1]) ? 'lte' : 'gte', value: m1.value }, st, k + 2)) { i = k + 1; continue; } }
    }
    for (const [ph, op] of CMP) {
      if (ph.every((p, d) => w[i + d] === p)) {
        const m = readMoney(w, i + ph.length);
        if (m) { if (push({ field: 'total', op, value: m.value }, i, i + ph.length + m.len)) { i += ph.length + m.len - 1; } }
        break;
      }
    }
  }
  return out;
}

/** the period phrase: the longest run of tokens from a time lead word that the time reader resolves and that contains a real time word */
function timeSpan(qt, taken, today, resolve = resolveAnyTimeRange) {
  const w = qt.map((t) => t.w);
  for (let i = 0; i < w.length; i++) {
    if (taken[i]) continue;
    if (!(TIME_LEAD.has(w[i]) || isTimeTok(w[i]))) continue;
    for (let n = Math.min(10, w.length - i); n >= 1; n--) {
      const seg = w.slice(i, i + n);
      if (taken.slice(i, i + n).some(Boolean)) continue;
      if (!seg.some(isTimeTok)) continue;
      if (!isTimeTok(seg[seg.length - 1]) && !/^(?:now|present|date)$/.test(seg[seg.length - 1])) continue;
      const phrase = seg.join(' ');
      let ok = false;
      if (/^(?:in |on )?(?:before|prior to|after) (?:19|20)\d\d$/.test(phrase)) ok = true;
      else {
        try { const r = resolve(/^(?:19|20)\d\d$/.test(phrase) ? `in ${phrase}` : phrase, today); ok = Boolean(r && !r.invalid && r.from && r.to); } catch { ok = false; }
      }
      if (ok) return { i, j: i + n, words: phrase };
    }
  }
  return null;
}

const NUMW = new Map(Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 }));
const NUMBERISH = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|\d+(?:st|nd|rd|th)?|\d+k|\$?\d[\d.]*)$/;

export function detectSlots(qt, vocab, today) {
  const spans = resolveOverlaps(lookups(qt, vocab));
  const taken = new Array(qt.length).fill(false);
  for (const s of spans) for (let x = s.i; x < s.j; x++) taken[x] = true;
  const money = moneyFilters(qt, taken);
  const time = timeSpan(qt, taken, today);
  if (time) for (let x = time.i; x < time.j; x++) taken[x] = true;
  const docs = spans.filter((s) => s.kind === 'doc');
  const docKinds = [...new Set(docs.map((s) => s.id))];
  const limitTok = [];
  for (let i = 0; i < qt.length; i++) { if (taken[i]) continue; const w = qt[i].w; if (/^\d{1,3}$/.test(w) && Number(w) >= 1 && Number(w) <= 100) limitTok.push(Number(w)); else if (NUMW.has(w)) limitTok.push(NUMW.get(w)); }
  const leftoverNums = qt.filter((t, i) => !taken[i] && NUMBERISH.test(t.w)).length; // numbers nothing explained (a count, a quantity, a date the reader did not take)
  return { spans, money, time, docs, docKinds, docType: docKinds.length === 1 ? docKinds[0] : null, limitTok, leftoverNums, taken };
}

export function maskLexicon(card, names = []) {
  const words = new Set();
  const add = (s) => { for (const w of String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !/^\d+$/.test(x))) words.add(stem(w)); };
  for (const [id, k] of Object.entries(card?.kinds ?? {})) { add(id); add(k.label); add(k.plural); for (const h of k.heads ?? []) add(h); }
  for (const [key, f] of Object.entries(card?.fields ?? {})) { add(key); if (f.shape === 'category' || f.shape === 'person') for (const v of f.values ?? []) add(v); }
  for (const n of card?.staffNouns ?? []) add(n);
  for (const n of names) add(n);
  return { words };
}

const ROLE_TAG = (r) => (r.customer && !r.tech && !r.vendor ? 'cust' : r.tech && !r.customer && !r.vendor ? 'tech' : r.vendor && !r.customer && !r.tech ? 'vend' : 'name');
/** the question's shape: typed placeholders for every detected slot, <k> for the company's other own nouns, <n> for numbers */
export function maskView(qt, slots, lex, generic) {
  const at = new Map();
  for (const s of slots.spans) at.set(s.i, { s, tag: s.kind === 'name' ? `<${ROLE_TAG(s.roles)}>` : s.kind === 'doc' ? '<doc>' : s.kind === 'city' ? '<city>' : s.kind === 'brand' ? '<brand>' : `<cat:${s.field}>` });
  for (const m of slots.money) at.set(m.i, { s: m, tag: m.op === 'between' ? '<amt2>' : `<amt:${m.op}>` });
  if (slots.time) at.set(slots.time.i, { s: slots.time, tag: '<time>' });
  const out = [];
  for (let i = 0; i < qt.length; i++) {
    const a = at.get(i);
    if (a) { out.push(a.tag); i = a.s.j - 1; continue; }
    const w = qt[i].w;
    if (/\d/.test(w)) { out.push('<n>'); continue; }
    const st = stem(w);
    if (lex?.words.has(st) && !generic?.has(st)) out.push('<k>'); else out.push(w);
  }
  return out.filter((t, i) => !(t === '<k>' && out[i - 1] === '<k>'));
}
