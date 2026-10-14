/**
 * dql/families/textdq.js - family "textdq": what the papers SAY, and what is MISSING, REPEATED or DISAGREEING in the records.
 *
 *   text_search     "which tickets mention a capacitor", "anything about a leak", "how many times did we clean a coil"
 *                   (the work performed, the notes and the invoice lines; a negated mention such as "no leaks found" is left out, and said so)
 *   line_search     "line items mentioning 5 ton", "how much have we billed for Trane installs", "which invoices have a parts line"
 *   cost_breakdown  "break down line items by what they were for", "split of line item spend between parts and service"
 *   duplicates      "same invoice number twice", "any duplicate serial numbers", "phone numbers shared by more than one customer"
 *   missing_field   "invoices without a customer", "customers with no email", "units that never got registered", "docs missing a model"
 *   find_document   "pull up invoice INV-20050", "find the invoice for exactly $2,800", "all paperwork on serial F100002"
 *   field_conflict  "do any nameplates disagree with the equipment record on model", "serial numbers that show up in two different brands"
 *   future_dates    "are there any dates in the future"
 *   completeness    "how complete is the equipment data"
 *   field_text      "model numbers starting with 24ACC", "units at addresses with a Suite number"
 *   reverse_lookup  "which customer uses this email", "look up phone 480.555.0112"
 *
 * The core parser releases a question with a word nothing explained. This family explains the leftover words ITSELF (family.rescue, see
 * registry.rescuePlan): a cue word ("mention", "say", "duplicate", "missing" ...), a search term, a scope word. If one word stays unexplained
 * the question is released, never guessed. Spelling of a search term is settled at execution time against the organization's own text
 * (a word that is neither in the records, nor in the language, nor one unambiguous repair away releases the question there).
 *
 * Nothing here names a business or an industry: field words are generic (customer, phone, email, date, total, serial, model ...).
 */
import { registerFamily } from '../registry.js';
import { ENTITIES } from '../fields.js';
import { FILLER, ENTITY_WORDS } from '../lex.js';
import { nounOf, condText, recordFor, fmtDate } from '../say.js';
import { editDistance } from '../text.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { COMMON_WORDS } from '../../router/lexicon.generated.js';

export const TEXTDQ_OPS = ['text_search', 'line_search', 'cost_breakdown', 'duplicates', 'missing_field', 'find_document', 'field_conflict', 'future_dates', 'completeness', 'field_text', 'reverse_lookup'];

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMoney = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lc = (v) => (v == null ? '' : String(v).toLowerCase().trim());
const aOrAn = (s) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

/* ====================================================================== words: stems, spelling, negation */

/** Plain morphology: the base of a plural / -ing / -ed / -ment word ("replacements", "replaced", "replacing" -> "replac"). */
export function stem(word) {
  let x = String(word ?? '').toLowerCase();
  if (x.length <= 3 || /\d/.test(x)) return x;
  if (/ies$/.test(x) && x.length > 4) x = `${x.slice(0, -3)}y`;
  else if (/(ss|us|is)$/.test(x)) { /* keep */ } else if (/(ches|shes|xes|sses|zes)$/.test(x)) x = x.slice(0, -2);
  else if (/s$/.test(x)) x = x.slice(0, -1);
  if (/ments?$/.test(x) && x.length > 7) x = x.replace(/ments?$/, '');
  else if (/ing$/.test(x) && x.length > 5) { x = x.slice(0, -3); if (/(.)\1$/.test(x)) x = x.slice(0, -1); } else if (/ed$/.test(x) && x.length > 4) { x = x.slice(0, -2); if (/(.)\1$/.test(x)) x = x.slice(0, -1); }
  if (/e$/.test(x) && x.length > 4) x = x.slice(0, -1);
  return x;
}
/** Two stems name the same word: equal, or one is the front of the other (diagnos / diagnosis) once it is long enough not to be an accident. */
const stemEq = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

const NEG_BEFORE = new Set('no not none never without nor neither cannot cant dont doesnt didnt wasnt isnt arent werent wont couldnt wouldnt hasnt havent negative free zero absent nothing nobody lacks lacking lack'.split(' '));
const NEG_AFTER = new Set('not none free absent negative ruled excluded nowhere'.split(' '));
const CLAUSE_SPLIT = /[,;:.!?()\n]|\s[-–—]\s|\bbut\b|\bhowever\b|\balthough\b/i;
const tokenizeText = (s) => String(s ?? '').toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) ?? [];

let COMMON = null;
const commonSet = () => (COMMON ??= new Set(COMMON_WORDS.split(/\s+/)));
/** A plain word of the language: itself, or its plural / past / -ing form's base is a dictionary word. */
export function isRealWord(w) {
  if (/\d/.test(w)) return true;
  const C = commonSet();
  if (C.has(w)) return true;
  if (w.endsWith('s') && C.has(w.slice(0, -1))) return true;
  if (w.endsWith('es') && C.has(w.slice(0, -2))) return true;
  if (w.endsWith('ied') && C.has(`${w.slice(0, -3)}y`)) return true;
  if (w.endsWith('ed') && (C.has(w.slice(0, -2)) || C.has(w.slice(0, -1)))) return true;
  if (w.endsWith('ing') && (C.has(w.slice(0, -3)) || C.has(`${w.slice(0, -3)}e`))) return true;
  return false;
}

/* ====================================================================== the organization's own text, indexed once per snapshot */

const IDX = new WeakMap();
/** Free-text fields of a document: the work performed, notes, findings ... (never an identifier, a name or an address). */
const TEXT_KEY = /(?:^|_)(?:work_performed|notes?|comments?|findings?|recommendations?|descriptions?|summary|scope|issues?|problems?|complaints?|resolutions?|diagnos\w*|observations?)(?:$|_)/;
const isTextKey = (k, v) => TEXT_KEY.test(k) && typeof v === 'string' && v.trim().length > 0;

function snippetOf(src, text) {
  const clauses = String(text).split(CLAUSE_SPLIT).map((c) => tokenizeText(c).map((w) => ({ w, s: stem(w) }))).filter((c) => c.length);
  const flat = [];
  clauses.forEach((c, ci) => c.forEach((t) => flat.push({ ...t, c: ci })));
  return { src, text: String(text), clauses, flat };
}
export function textIndex(snap) {
  let ix = IDX.get(snap);
  if (ix) return ix;
  const byDoc = new Map(); const words = new Set(); const stems = new Set();
  const put = (docId, sn) => {
    if (!byDoc.has(docId)) byDoc.set(docId, []);
    byDoc.get(docId).push(sn);
    for (const c of sn.clauses) for (const t of c) { words.add(t.w); stems.add(t.s); }
  };
  for (const d of snap.documents) {
    for (const [k, v] of Object.entries(d.f ?? {})) {
      if (!isTextKey(k, v)) continue;
      for (const val of d.fMulti?.[k] ?? [v]) put(d.id, snippetOf(k, val));
    }
  }
  const lineSn = new Map();
  for (const l of snap.lines) {
    if (!l.description) continue;
    const sn = snippetOf('line', l.description);
    lineSn.set(l.id, sn);
    put(l.docId, sn);
  }
  const fileWords = new Set();
  for (const d of snap.documents) for (const w of tokenizeText(d.filename ?? '')) if (!/^\d+$/.test(w)) fileWords.add(w);
  const byLen = new Map();
  for (const w of [...words, ...fileWords]) { if (w.length < 4 || /\d/.test(w)) continue; if (!byLen.has(w.length)) byLen.set(w.length, []); byLen.get(w.length).push(w); }
  ix = { byDoc, lineSn, words, stems, fileWords, byLen };
  IDX.set(snap, ix);
  return ix;
}

/** Repair a typed word to exactly one nearby word; null when none, or when two are equally near. */
function repairTo(w, byLen) {
  const max = w.length >= 8 ? 2 : 1;
  let best = null; let bd = max + 1; let tie = false;
  for (let len = w.length - max; len <= w.length + max; len++) {
    for (const v of byLen.get(len) ?? []) {
      const d = editDistance(w, v, max);
      if (d < bd) { best = v; bd = d; tie = false; } else if (d === bd && v !== best) tie = true;
    }
  }
  return best && !tie && bd <= max ? best : null;
}
/** One typed word -> {w, from?} or null (not a word we can search for): known to the records, a word of the language, a code, or one repair away from the records / the language. */
function resolveWord(w, ix) {
  if (ix.words.has(w) || ix.fileWords.has(w) || isRealWord(w)) return { w };
  if (w.length < 4) return null;
  // a misspelling is only ever repaired into a word the organization's own records contain; into the language at large it could become any word
  const r1 = repairTo(w, ix.byLen);
  if (r1) return { w: r1, from: w };
  return null;
}
/** The plan's raw term -> the searchable term (stemmed chunks), or null when a word cannot be read. */
function resolveTerm(raw, ix, literal = false) {
  const words = []; const repairs = [];
  for (const w of raw.words) {
    if (/\d/.test(w) || w.length <= 2) { words.push(w); continue; }
    const r = literal ? (ix.words.has(w) || ix.fileWords.has(w) || [...ix.stems].some((y) => stemEq(y, stem(w))) ? { w } : null) : resolveWord(w, ix);
    if (!r) return null;
    if (r.from) repairs.push([r.from, r.w]);
    words.push(r.w);
  }
  const chunks = []; let at = 0;
  for (const len of raw.chunkLens) { chunks.push(words.slice(at, at + len).map(stem)); at += len; }
  return { words, chunks, stems: words.map(stem), literalNeg: raw.literalNeg, repairs, display: repairs.length ? words.join(' ') : raw.display };
}

/** Does one snippet say the term? 'pos' | 'neg' (only in a negated form) | null.  The term is chunks of words that must sit side by side ("3 ton", "R-454B"); the chunks must sit near each other, in any order. */
function matchSnippet(sn, term) {
  let sawNeg = false;
  const chunks = term.chunks;
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const tk = sn.flat;
  const occs = chunks.map((ch) => {
    const o = [];
    for (let i = 0; i + ch.length <= tk.length; i++) {
      let ok = true;
      for (let k = 0; k < ch.length; k++) if (!stemEq(tk[i + k].s, ch[k])) { ok = false; break; }
      if (ok) o.push([i, i + ch.length - 1]);
    }
    return o;
  });
  if (occs.some((o) => !o.length)) return null;
  const found = [];
  for (const first of occs[0]) {
    let lo = first[0]; let hi = first[1]; let ok = true;
    const taken = [first];
    for (let c = 1; c < occs.length; c++) {
      let best = null; let bd = 1e9;
      for (const o of occs[c]) {
        if (taken.some((t2) => !(o[1] < t2[0] || o[0] > t2[1]))) continue;
        const d = Math.min(Math.abs(o[0] - first[1]), Math.abs(o[1] - first[0]));
        if (d < bd) { best = o; bd = d; }
      }
      if (!best) { ok = false; break; }
      taken.push(best); lo = Math.min(lo, best[0]); hi = Math.max(hi, best[1]);
    }
    if (ok && hi - lo + 1 <= total + 6) found.push([lo, hi]);
  }
  for (const [lo, hi] of found) {
    if (term.literalNeg) return 'pos';
    let negated = false;
    for (let i = Math.max(0, lo - 4); i < lo; i++) if (tk[i].c === tk[lo].c && NEG_BEFORE.has(tk[i].w)) negated = true;
    for (let i = hi + 1; i <= Math.min(tk.length - 1, hi + 2); i++) if (tk[i].c === tk[hi].c && NEG_AFTER.has(tk[i].w)) negated = true;
    if (!negated) return 'pos';
    sawNeg = true;
  }
  return sawNeg ? 'neg' : null;
}
function matchAny(sns, term) {
  let neg = null;
  for (const sn of sns ?? []) {
    const m = matchSnippet(sn, term);
    if (m === 'pos') return { m: 'pos', sn };
    if (m === 'neg' && !neg) neg = sn;
  }
  return neg ? { m: 'neg', sn: neg } : { m: null };
}

/* ====================================================================== reading the question word by word */

/** [{w, i, consumed}] - every word of the question and whether a core slot (a name, a date, a type, a count word ...) already explained it. */
function tokensOf(work) {
  const out = []; const re = /\S+/g; let m;
  while ((m = re.exec(work.orig))) out.push({ w: m[0], i: out.length, consumed: !/\S/.test(work.s.slice(m.index, m.index + m[0].length)) });
  // the core repairs a misspelling into one of its own words; a plain word it left alone and the core "repaired" anyway ("replaced" -> "placed") is read as typed
  if (work.raw && work.raw.length === out.length) for (const t of out) { const r = work.raw[t.i]; if (!t.consumed && r !== t.w && isRealWord(r)) t.w = r; }
  return out;
}
const isLeft = (t) => !t.consumed && !FILLER.has(t.w);

const TERM_STOP = new Set('per each average avg mean typical every more than once twice most common least many much date dates time times number numbers history rank rate year month week day days top bottom best worst biggest smallest total'.split(' '));
const ARTICLES = new Set('a an the of any some my our their its this that those these'.split(' '));
const SCOPE_WORDS = new Set('notes note work performed text comments comment details detail records record paperwork descriptions description wording'.split(' '));
const PRE_CUE_OK = new Set('they people anyone anybody someone everyone everything anything something wat wats wich whch wut whihc'.split(' '));
const TAIL_CHATTER = new Set('possible asap urgent urgently quick quickly please pls thanks thx give fast soon today now'.split(' '));
const QUOTE_WORDS = new Set('word words phrase term saying'.split(' '));
const BOUNDARY = new Set('in on at from by since during before after between within per across over under through until till for with to into and or but'.split(' '));
const CUE_RE = {
  mention: /^(?:mention|mentions|mentioned|mentioning|reference|references|referenced|referencing|talk|talks|talked|talking)$/, say: /^(?:say|says|said|saying)$/, contain: /^(?:contain|contains|contained|containing)$/,
  search: /^(?:search|searches|searched|searching)$/, about: /^(?:anything|anyting|something)$/, involve: /^(?:involve|involves|involved|involving)$/,
  include: /^(?:include|includes|included|including)$/,
};
const CUE_BASES = { mention: 'mention', mentions: 'mention', mentioning: 'mention', search: 'search', searching: 'search', containing: 'contain', involved: 'involve', involving: 'involve' };
/** A cue word as typed; a long word one or two letters off a cue word is that cue word (the same forgiveness the core gives other words). */
function cueOf(w, prev = '') {
  if (/^(?:has|have|holds|prints)$/.test(w) && /^(?:text|texts|wording)$/.test(prev)) return 'contain'; // R21: "files whose text has \"net 30\""
  for (const [k, re] of Object.entries(CUE_RE)) if (re.test(w)) return k;
  if (w.length >= 6) {
    for (const [c, k] of Object.entries(CUE_BASES)) {
      const max = w.length >= 8 ? 2 : 1;
      if (Math.abs(c.length - w.length) <= max && editDistance(w, c, max) <= max) return k;
    }
  }
  return null;
}

/* ====================================================================== plan helpers */

const DATE_AMBIGUOUS = new Set(['maintenance-agreement', 'agreement', 'warranty-registration', 'insurance-certificate', 'permit', 'price-list', 'statement', 'schedule', 'equipment-record', 'nameplate-photo']);
const LINE_TYPES = new Set(['invoice', 'proposal-quote', 'purchase-order', 'estimate', 'receipt', 'statement']);

function baseFor(feat, entity) {
  const docType = feat.docTypes.length === 1 ? feat.docTypes[0] : null;
  return { v: 1, entity, docType, visit: Boolean(feat.nouns.visit), filters: [], time: null, measure: null, groupBy: [], limit: null, dir: 'desc', docWord: feat.docTypes.length === 1 ? feat.docWord ?? null : null };
}
/** Role filters (a named customer, technician, vendor) and categorical filters onto this entity's fields; null when the entity cannot be asked that. */
function mapFilters(filters, entity) {
  const E = ENTITIES[entity]; const out = [];
  for (const x of filters) {
    if (x.field === '?num') return null;
    let field = x.field;
    if (x.role === 'customer') field = entity === 'customer' ? 'name' : 'customer';
    if (entity === 'customer' && field === 'brand') { out.push({ ...x, field: 'hasBrand', op: 'eq', label: `with ${x.value} units` }); continue; }
    if (!E.fields[field]) return null;
    out.push({ ...x, field });
  }
  return out;
}
function timeFor(feat, entity, visit, docType) {
  if (!feat.time) return null;
  if ((feat.times?.length ?? 0) > 1) return undefined;
  const c = feat.cue ?? {};
  let field = null;
  if (entity === 'document') {
    if (c.install || c.expire || c.register) return undefined;
    field = c.created ? 'createdAt' : visit ? 'serviceDate' : 'date';
    if (field === 'date' && docType && DATE_AMBIGUOUS.has(docType)) return undefined;
  } else if (entity === 'unit') {
    field = c.install ? 'installDate' : c.expire ? 'warrantyExpires' : c.register ? 'registeredDate' : null;
    if (!field) return undefined;
  } else return undefined;
  return { field, from: feat.time.from, to: feat.time.to, label: feat.time.label };
}
function groupFor(dim, entity, timeField) {
  const E = ENTITIES[entity];
  if (['year', 'month', 'quarter', 'monthOfYear'].includes(dim)) { const field = timeField ?? E.defaultDate; return field ? { by: dim, field } : null; }
  const by = { tech: 'tech', city: 'city', brand: 'brand', vendor: 'vendor', status: 'status', serviceType: 'serviceType', type: 'type' }[dim];
  return by && E.fields[by] ? { by } : null;
}
/* ====================================================================== recognizer: what the papers say */

/** Reclaimable words: a core slot took them out of the question although they are plain words of a search term (a brand, "5 ton", "R-454B", "unit"). */
function makeReclaim(vocab) {
  const brandWords = new Set(); for (const k of vocab.brands.keys()) for (const w of k.split(' ')) brandWords.add(w);
  const catWords = new Set(); for (const map of Object.values(vocab.cat)) for (const k of map.keys()) for (const w of k.split(' ')) catWords.add(w);
  return (tok, next) => {
    if (!tok.consumed) return true;
    const w = tok.w;
    if (/^\d+(?:\.\d+)?$/.test(w)) return Boolean(next && /^tons?$/.test(next.w)); // "3 ton"; a bare number a core slot took is a date or an amount
    return /^(?:unit|units|system|systems|equipment|install|installs|installation|installations|machine|machines|asset|assets|condenser|condensers|furnace|furnaces|ton|tons)$/.test(w)
      || /^r-?\d{2,3}[a-z]?$/.test(w) || brandWords.has(w) || vocab.models.has(w) || catWords.has(w);
  };
}

function textual(feat, h, T) {
  const t = feat.trig ?? {};
  const lower = T.map((x) => x.w);
  const vocab = h.vocab;
  const reclaim = makeReclaim(vocab);
  const lineIdx = lower.findIndex((w, i) => !T[i].consumed && /^lines?$/.test(w));
  const lineItems = lower.some((w, i) => /^items?$/.test(w) && /^lines?$/.test(lower[i - 1] ?? ''));
  const lineScope = lineIdx >= 0;
  // cue
  let cueIdx = -1;
  for (let i = 0; i < T.length; i++) {
    if (T[i].consumed || !cueOf(T[i].w, T[i - 1]?.w)) continue;
    // "anything about X" / "anything mentioning X"; a bare "anything" is not a search cue
    if (cueOf(T[i].w, T[i - 1]?.w) === 'about' && !(/^(?:about|on|regarding|concerning|re)$/.test(T[i + 1]?.w ?? '') || (T[i + 1] && !T[i + 1].consumed && cueOf(T[i + 1].w) && cueOf(T[i + 1].w) !== 'about'))) continue;
    cueIdx = i; break;
  }
  while (cueIdx >= 0 && cueIdx + 1 < T.length && !T[cueIdx + 1].consumed && cueOf(T[cueIdx + 1].w, T[cueIdx].w)) cueIdx++; // "anything mentioning"
  const cueKind = cueIdx >= 0 ? cueOf(T[cueIdx].w, T[cueIdx - 1]?.w) : null;
  const timesIdx = T.findIndex((x) => !x.consumed && x.w === 'times');
  const chargeIdx = T.findIndex((x) => !x.consumed && /^charges?$/.test(x.w));
  const chargeWord = chargeIdx >= 0 && cueIdx < 0 && !lineScope && Boolean(t.howMuch || t.howMany || feat.flags.listVerb || /^what/.test(T[0]?.w ?? '') || t.exists);
  const instalLike = feat.nouns.install && (t.howMuch || t.total) && !t.tonnageWord && !t.hours && !t.ageWord;
  const billedWords = (Boolean(t.money?.length) && (t.moneyType ?? []).includes('invoice')) || chargeWord || Boolean(instalLike);

  let mode;
  if (cueIdx >= 0) mode = 'cue';
  else if (timesIdx >= 0 && t.howMany) mode = 'times';
  else if (lineScope) mode = 'linecue';
  else if (billedWords && (t.howMany || t.howMuch || t.total || chargeWord || feat.flags.listVerb || t.exists || t.any || /^(?:which|what|who)$/.test(T[0]?.w ?? ''))) mode = 'billed';
  else mode = 'implicit';
  if (cueKind === 'include' && !lineScope && !feat.docTypes.some((d) => LINE_TYPES.has(d))) return null;

  const regionIdx = [];
  const leadIn = (tok, first) => ARTICLES.has(tok.w) || (FILLER.has(tok.w) && !BOUNDARY.has(tok.w)) || SCOPE_WORDS.has(tok.w) || QUOTE_WORDS.has(tok.w) || (first && /^(?:for|about|that|which|of|on|with|to|in)$/.test(tok.w));
  const take = (from) => {
    let i = from;
    while (i < T.length && leadIn(T[i], true)) i++;
    for (; i < T.length; i++) {
      const tok = T[i]; const w = tok.w;
      if (BOUNDARY.has(w) && regionIdx.length) break;
      if (tok.consumed && !reclaim(tok, T[i + 1])) {
        // a leading "no" / "not" of the phrase itself ("no cooling") is consumed as a negation word; it still belongs to the term
        if (!regionIdx.length && /^(?:no|not)$/.test(w)) { regionIdx.push(i); continue; }
        if (FILLER.has(w) || ARTICLES.has(w)) continue;
        break;
      }
      if (/^systems?$/.test(w) && regionIdx.length) { regionIdx.push(i); continue; }
      if (FILLER.has(w) || ARTICLES.has(w)) continue;
      regionIdx.push(i);
    }
  };
  if (mode === 'cue') take(cueIdx + 1);
  else if (mode === 'linecue') {
    const after = lineItems ? lower.findIndex((w, i) => /^items?$/.test(w) && /^lines?$/.test(lower[i - 1] ?? '')) + 1 : lineIdx + 1;
    take(after);
    if (!regionIdx.length && lineIdx > 0) {
      // "a parts line", "service line items": the word before "line" is the term
      for (let i = lineIdx - 1; i >= 0 && regionIdx.length < 2; i--) { if (ARTICLES.has(T[i].w) || FILLER.has(T[i].w)) { if (regionIdx.length) break; continue; } if (T[i].consumed && !reclaim(T[i], T[i + 1])) break; regionIdx.unshift(i); }
    }
  } else if (mode === 'times') {
    for (let i = 0; i < T.length; i++) if (isLeft(T[i]) && i !== timesIdx && !/^(?:jobs?|wat|wich|whch)$/.test(T[i].w)) regionIdx.push(i);
  } else if (mode === 'billed') {
    for (let i = 0; i < T.length; i++) {
      if (i === chargeIdx || /^(?:jobs?|wat|wich|whch|systems?)$/.test(T[i].w)) continue;
      if ((T[i].consumed && reclaim(T[i], T[i + 1]) && !FILLER.has(T[i].w) && !isStructuralConsumed(T[i], feat)) || isLeft(T[i])) regionIdx.push(i);
    }
  } else {
    for (let i = 0; i < T.length; i++) if (isLeft(T[i]) && !/^(?:jobs?|wat|wich|whch)$/.test(T[i].w)) regionIdx.push(i);
  }
  // R23: a trailing chatter word ("possible", "asap", "give") is not part of the phrase; a quoted word never is chatter
  while (regionIdx.length > 1 && TAIL_CHATTER.has(T[regionIdx[regionIdx.length - 1]].w) && !/["'\u201c\u201d]/.test(T[regionIdx[regionIdx.length - 1]].w)) regionIdx.pop();
  const region = regionIdx.map((i) => T[i]);
  if (!region.length || region.length > 6) return null;

  // coverage: every word nothing else explained is a cue, a scope word, a lead-in or part of the term
  const used = new Set(regionIdx);
  if (cueIdx >= 0) used.add(cueIdx);
  if (timesIdx >= 0) used.add(timesIdx);
  if (chargeIdx >= 0 && mode === 'billed') used.add(chargeIdx);
  for (let k = 0; k < T.length; k++) if (lineScope && (/^(?:lines?|items?)$/.test(T[k].w))) used.add(k);
  for (const tok of T.filter(isLeft)) {
    if (used.has(tok.i)) continue;
    const w = tok.w;
    if (SCOPE_WORDS.has(w) || QUOTE_WORDS.has(w) || PRE_CUE_OK.has(w) || /^(?:jobs?|invoice|invoices)$/.test(w) || cueOf(w)) continue;
    return null;
  }

  // the term (raw words; spelling is settled at execution against the organization's own text)
  const raw = region.map((r) => r.w);
  if (raw.some((w) => /^[a-z]{2,5}-\d{3,}(?:-\d+)*$/.test(w))) return null; // a document number is looked up, not searched
  let literalNeg = false;
  if (/^(?:no|not)$/.test(raw[0]) && raw.length > 1) literalNeg = true;
  else if (raw.some((w) => NEG_BEFORE.has(w))) return null;
  const words = []; const chunkLens = [];
  for (let ri = 0; ri < raw.length; ri++) {
    const parts = raw[ri].replace(/^["']|["']$/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter((part) => literalNeg || !ARTICLES.has(part));
    if (!parts.length) continue;
    // "3 ton": a number and its unit sit side by side
    if (/^tons?$/.test(parts[0]) && parts.length === 1 && words.length && /^\d+(?:\.\d+)?$/.test(words[words.length - 1]) && chunkLens[chunkLens.length - 1] === 1) { words.push(parts[0]); chunkLens[chunkLens.length - 1] = 2; continue; }
    for (const part of parts) words.push(part);
    chunkLens.push(parts.length);
  }
  if (!words.length) return null;
  if (literalNeg) { chunkLens.length = 0; chunkLens.push(words.length); }
  if (words.some((w) => TERM_STOP.has(w))) return null;
  if (words.length === 1 && (words[0].length < 3 || /^\d+$/.test(words[0]))) return null;
  // serial numbers and document numbers are looked up, not searched
  if (words.includes('serial') && words.some((w) => /\d/.test(w))) return null;
  // a word that is a VALUE of a field (a brand, a city, a status, a kind of service ...) names that field, not a phrase on the papers: "documents mentioning Trane"
  // would count the papers whose text happens to say it, which is not the papers about Trane equipment. Released unless it sits in a longer phrase ("Trane system").
  { const phrase = words.join(' '); const keyOf = (m) => (m.has(phrase) || m.has(phrase.replace(/s$/, '')));
    if (keyOf(vocab.brands) || keyOf(vocab.cities) || Object.values(vocab.cat).some((m) => keyOf(m))) return null; }
  const term = { words, chunkLens, literalNeg, display: words.join(' ') };

  // filters: a brand / "5 ton" / refrigerant / model / category the question put INSIDE the term belongs to the term, not to a field
  const regionWords = new Set(words);
  const inTerm = (f) => {
    const vals = (Array.isArray(f.value) ? f.value : [f.value]).flatMap((v) => lc(v).split(/[^a-z0-9]+/).filter(Boolean));
    if (f.field === 'tonnage') return regionWords.has('ton') || regionWords.has('tons') || vals.some((v) => regionWords.has(v));
    if (f.field === 'refrigerant') return words.some((w) => w.replace(/-/g, '') === lc(f.value).replace(/-/g, '')) || (regionWords.has('r') && vals.some((v) => regionWords.has(v)));
    return vals.some((v) => regionWords.has(v));
  };
  const keep = []; const dropped = [];
  for (const f of feat.filters) { if (['brand', 'refrigerant', 'tonnage', 'model', 'serviceType', 'status'].includes(f.field) && inTerm(f)) dropped.push(f); else keep.push(f); }
  term.display = region.map((r) => r.w.replace(/^["']|["']$/g, '')).filter((w) => !ARTICLES.has(w)).map((w) => (/\d/.test(w) && /[a-z]/.test(w) ? w.toUpperCase() : w)).join(' ');

  if (mode === 'billed' || mode === 'implicit' || mode === 'times') term.needCorpus = true; // no cue word was typed: the words must be ones the records themselves use, as typed
  return finishText(feat, h, { term, keep, mode, lineScope, lineItems, cueKind, billedWords, region, chargeWord, scopeNotes: T.some((x) => !x.consumed && /^notes?$/.test(x.w)) });
}
const isStructuralConsumed = (tok, feat) => /^(?:how|many|much|billed|bill|billing|billings|charged|invoiced|total|sum|did|do|we|have|add|up|to)$/.test(tok.w);

function finishText(feat, h, o) {
  const t = feat.trig ?? {};
  const ents = feat.nouns;
  const unitNounLeft = ents.unit && !o.region.some((r) => ENTITY_WORDS.unit.includes(r.w) || ENTITY_WORDS.install.includes(r.w));
  if (unitNounLeft) return null;
  if (ents.tech && !feat.filters.some((f) => f.role === 'tech')) return null;
  const asCustomers = Boolean(ents.customer) && !feat.docTypes.length && !ents.visit && !ents.document;
  if (ents.customer && !asCustomers) return null;
  if (feat.docTypes.length > 1) return null;
  if (feat.docTypes.includes('hr-letter')) return null;
  const base = baseFor(feat, 'document');
  const filters = mapFilters(o.keep, 'document');
  if (!filters) return null;
  base.filters = filters;
  const jobs = /\bjobs?\b/.test(feat.work.orig);
  if (jobs && !base.docType && !ents.visit && !(o.lineScope || o.mode === 'billed' || o.cueKind === 'include')) base.visit = true;
  const time = timeFor(feat, 'document', base.visit, base.docType);
  if (time === undefined) return null;
  base.time = time;
  if (feat.dims.length > 1) return null;
  if (feat.dims.length) { const g = groupFor(feat.dims[0], 'document', time?.field); if (!g) return null; base.groupBy = [g]; }
  if (t.negation && !o.term.literalNeg) return null;
  if (t.missing || t.share || t.versus || t.median || t.avg || t.latest || t.earliest || t.topN || t.argmax || t.distinct || t.max || t.min) return null;
  if (feat.recentN || feat.flags.each) return null;
  if (feat.distinctDim) return null; // "which cities have invoices with a roofing line" is a list of values, not a list of papers
  const money = Boolean(t.howMuch || t.total || t.money?.length);
  const lineWanted = o.lineScope || o.mode === 'billed' || o.cueKind === 'include';
  if (o.mode === 'implicit' || o.mode === 'times') {
    // no cue word: only a question that is plainly about what was done
    if (money) return null;
    const verbish = o.region.some((r) => /(?:ed|ing)$/.test(r.w) && r.w.length > 4);
    // what is counted must be named as a paper (a ticket, a visit, a job, a document) and the question must say something was DONE to it
    if (o.mode === 'implicit' && !(verbish && (feat.docTypes.length || ents.visit || ents.document || jobs))) return null;
    if (o.mode === 'implicit' && !(t.howMany || feat.flags.listVerb || t.any)) return null;
    if (feat.work.orig.split(/\s+/).some((w) => /^(?:sheets?|files?|forms?|copy|scan)$/.test(w))) return null;
  }
  let show;
  if (t.howMany) show = 'count';
  else if (t.exists || t.any) show = feat.flags.listVerb && !t.exists ? 'list' : 'exists';
  else show = 'list';
  if (lineWanted) {
    if (feat.dims.length) return null; // a line search is not grouped here
    const wantsSum = Boolean(t.howMuch || t.total || (o.chargeWord && !t.howMany && !feat.flags.listVerb));
    if (o.mode !== 'billed' && money && !wantsSum) return null;
    if (t.avg || t.median) return null;
    if (asCustomers) return { ...base, op: 'line_search', term: o.term, show: 'customers', asCustomers: true, countLines: true };
    const docType = base.docType ?? (o.mode === 'billed' ? 'invoice' : null);
    if (docType && !LINE_TYPES.has(docType)) return null;
    // "sum of POs that have a drywall line": the papers that carry such a line, added up by their own totals; only "line amounts" / "billed for" add up the lines themselves
    const lineAmounts = /\b(?:line\s+(?:amounts?|totals?|values?)|lines?\s+(?:amounts?|totals?)|amounts?\s+(?:of|on)\s+(?:the\s+)?[\w ]{0,20}lines?|lines?\s+(?:items?\s+)?(?:amounts?|totals?))\b/i.test(feat.raw ?? '');
    const rawL = String(feat.raw ?? '').toLowerCase();
    const docPos = base.docWord ? rawL.search(new RegExp(`\\b${String(base.docWord).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) : -1;
    const asModifier = docPos >= 0 && (/\b(?:billing|billed)\s+for\b/.test(rawL) && rawL.search(/\b(?:billing|billed)\s+for\b/) > docPos || /\bwith\s+(?:an?|the)\s+"?[\w ]{1,25}"?\s+line(?:\s+items?)?\b/.test(rawL) && rawL.search(/\bwith\s+(?:an?|the)\s+"?[\w ]{1,25}"?\s+line/) > docPos) && !/\b(?:how\s+much|total|sum|dollars?|amount)\s+(?:in|of)\s+(?:the\s+)?"?[\w ]{1,25}"?\s+lines?\b/.test(rawL);
    const docLevel = asModifier && !lineAmounts || Boolean(base.docType) && o.mode !== 'billed' && !o.chargeWord && !lineAmounts && (o.cueKind === 'include' || /\b(?:include|includes|including|have|has|contain|contains)\s+(?:"[^"]+"|[a-z]+)\s+as\s+(?:a|an|the)\s+line\b/i.test(feat.raw ?? ''));
    return { ...base, docType, docWord: base.docType ? base.docWord : null, op: 'line_search', term: o.term, show: wantsSum ? 'sum' : show, countLines: docLevel ? false : Boolean(o.lineScope) || o.mode === 'billed', sumDocs: Boolean(wantsSum && docLevel), _weak: o.mode === 'implicit' };
  }
  if (money) return null;
  if (asCustomers) return { ...base, op: 'text_search', term: o.term, show: 'customers', asCustomers: true };
  if (base.groupBy.length) show = 'count';
  return { ...base, op: 'text_search', term: o.term, show, scopeNoun: o.scopeNotes ? 'notes' : null, _weak: o.mode === 'implicit' || o.mode === 'times' };
}

/* ====================================================================== recognizer: field tables (missing, duplicates, conflicts) */

/** Phrases a person uses for a field, per entity. [words, field id, label]. Longest first when matching. */
const FIELD_TABLE = {
  document: [
    [['customer', 'link'], 'custLink', 'customer link'], [['client', 'link'], 'custLink', 'customer link'],
    [['customer', 'name'], 'custName', 'customer name'], [['client', 'name'], 'custName', 'customer name'], [['customer'], 'customer', 'customer'], [['client'], 'customer', 'customer'],
    [['service', 'date'], 'serviceDate', 'service date'], [['invoice', 'date'], 'invoiceDate', 'invoice date'], [['install', 'date'], 'installDate', 'installation date'], [['installation', 'date'], 'installDate', 'installation date'],
    [['date'], 'date', 'date'], [['dates'], 'date', 'date'],
    [['total'], 'total', 'total'], [['amount'], 'total', 'total'], [['technician'], 'tech', 'technician'], [['tech'], 'tech', 'technician'],
    [['serial', 'number'], 'serial', 'serial number'], [['serial'], 'serial', 'serial number'], [['model', 'number'], 'model', 'model number'], [['model'], 'model', 'model number'],
    [['brand'], 'brand', 'brand'], [['manufacturer'], 'brand', 'brand'], [['vendor'], 'vendor', 'vendor'], [['supplier'], 'vendor', 'vendor'],
    [['labor', 'hours'], 'hours', 'labor hours'], [['hours'], 'hours', 'labor hours'], [['tonnage'], 'tonnage', 'tonnage'], [['refrigerant'], 'refrigerant', 'refrigerant'],
    [['work', 'performed'], 'workPerformed', 'work performed'], [['notes'], 'notes', 'notes'], [['status'], 'status', 'status'], [['service', 'type'], 'serviceType', 'service type'],
    [['invoice', 'number'], 'num:invoice_number', 'invoice number'], [['po', 'number'], 'num:po_number', 'PO number'], [['purchase', 'order', 'number'], 'num:po_number', 'PO number'], [['permit', 'number'], 'num:permit_number', 'permit number'],
    [['extracted', 'details'], 'details', 'extracted details'], [['extracted', 'fields'], 'details', 'extracted details'], [['details'], 'details', 'extracted details'],
  ],
  customer: [
    [['phone', 'number'], 'phone', 'phone number'], [['phone'], 'phone', 'phone number'], [['telephone'], 'phone', 'phone number'], [['email', 'address'], 'email', 'email'], [['email'], 'email', 'email'], [['e', 'mail'], 'email', 'email'],
    [['service', 'address'], 'address', 'service address'], [['street', 'address'], 'address', 'service address'], [['address'], 'address', 'service address'],
    [['contact', 'info'], 'contact', 'contact info'], [['contact', 'information'], 'contact', 'contact info'], [['contact', 'details'], 'contact', 'contact info'],
  ],
  unit: [
    [['serial', 'number'], 'serial', 'serial number'], [['serial'], 'serial', 'serial number'], [['model', 'number'], 'model', 'model number'], [['model'], 'model', 'model number'],
    [['brand'], 'brand', 'brand'], [['manufacturer'], 'brand', 'brand'], [['tonnage'], 'tonnage', 'tonnage'], [['refrigerant'], 'refrigerant', 'refrigerant'],
    [['install', 'date'], 'installDate', 'installation date'], [['installation', 'date'], 'installDate', 'installation date'],
    [['warranty', 'registration'], 'registeredDate', 'warranty registration'], [['registration'], 'registeredDate', 'warranty registration'], [['registered'], 'registeredDate', 'warranty registration'],
    [['warranty', 'end', 'date'], 'warrantyExpires', 'warranty end date'], [['warranty', 'expiry', 'date'], 'warrantyExpires', 'warranty end date'], [['warranty', 'expiration', 'date'], 'warrantyExpires', 'warranty end date'], [['warranty', 'expiration'], 'warrantyExpires', 'warranty end date'], [['warranty', 'expiry'], 'warrantyExpires', 'warranty end date'],
    [['end', 'date'], 'warrantyExpires', 'warranty end date'], [['expiry', 'date'], 'warrantyExpires', 'warranty end date'], [['customer'], 'customer', 'customer'], [['owner'], 'customer', 'customer'], [['type'], 'equipmentType', 'equipment type'],
  ],
};
const sgl = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** Find a phrase (array of words) at token position i; returns its length or 0. Plurals are read as singulars. */
function phraseAt(T, i, words) {
  for (let k = 0; k < words.length; k++) {
    const tok = T[i + k];
    if (!tok) return 0;
    const a = sgl(tok.w); const b = sgl(words[k]);
    if (a === b) continue;
    // a slip of one letter in a longer field word ("mdel", "serail") is that word; short words are never stretched ("date" is not "data")
    if (b.length >= 5 && a.length >= 4 && a[0] === b[0] && editDistance(a, b, 1) <= 1) continue;
    return 0;
  }
  return words.length;
}
/** The fields named in T[from..]: [{id,label,idx:[token indexes]}] longest phrase first; tokens used are reported. */
function fieldsIn(T, from, entity, upto = T.length) {
  const out = []; const used = new Set();
  for (let i = from; i < upto; i++) {
    if (used.has(i)) continue;
    let best = null;
    for (const [words, id, label] of FIELD_TABLE[entity]) { const n = phraseAt(T, i, words); if (n && (!best || n > best.n)) best = { n, id, label }; }
    if (best) { if (!out.some((f) => f.id === best.id)) out.push({ id: best.id, label: best.label, idx: [] }); for (let k = 0; k < best.n; k++) used.add(i + k); out.find((f) => f.id === best.id).idx.push(...Array.from({ length: best.n }, (_, k) => i + k)); i += best.n - 1; }
  }
  return { fields: out, used };
}

const MISSING_MARK = new Set('missing without lacking lack lacks blank empty no none neither nothing never dont doesnt not arent isnt havent hasnt wo'.split(' '));
const TRAIL_OK = new Set('w r u ur nor or and either on file listed recorded attached assigned linked entered stored provided given filled present shown noted saved included there in the system record records from them it for to be got get gotten been has have had with'.split(' '));
const VERB_FIELD = { registered: 'registeredDate', linked: 'custLink', attached: 'custLink', extracted: 'details', assigned: 'tech' };

function entityBefore(T, feat, upto) {
  const before = T.slice(0, upto).map((x) => x.w);
  const has = (re) => before.some((w) => re.test(w));
  const beforeText = ` ${before.join(' ')} `;
  const docTypeBefore = feat.docTypes.length > 0 && Boolean(feat.docWord) && beforeText.includes(` ${feat.docWord.split(' ')[0]}`);
  const docNoun = has(/^(?:documents?|docs?|paperwork|papers?|files?|records?)$/) || docTypeBefore;
  const visit = has(/^(?:visits?|jobs?|service|calls?)$/) && feat.nouns.visit;
  const unit = before.some((w) => ENTITY_WORDS.unit.includes(w));
  const cust = before.some((w) => ENTITY_WORDS.customer.includes(w)) || has(/^(?:tenants?|patients?|donors?|people|who)$/);
  const kinds = [docNoun || visit ? 'document' : null, unit ? 'unit' : null, cust ? 'customer' : null].filter(Boolean);
  return { kinds, visit };
}

const fuzzyWord = (w, target) => w === target || (w.length >= 6 && Math.abs(w.length - target.length) <= 1 && w[0] === target[0] && editDistance(w, target, 1) <= 1);
function missingFields(feat, h, T0) {
  const t = feat.trig ?? {};
  const T = T0.map((x) => (fuzzyWord(x.w, 'nothing') ? { ...x, w: 'nothing' } : fuzzyWord(x.w, 'missing') ? { ...x, w: 'missing' } : x));
  const lowerAll = T.map((x) => x.w);
  // marker
  let m = -1;
  for (let i = 0; i < T.length; i++) if (MISSING_MARK.has(T[i].w)) { m = i; break; }
  // "waiting to be linked", "orphan documents": no marker word at all
  const orphan = lowerAll.some((w) => /^orphans?$|^unlinked$|^orphaned$/.test(w)) || lowerAll.join(' ').match(/waiting to be linked|not (?:been )?linked|isn t linked/);
  if (m < 0 && !orphan) return null;
  if (m < 0) m = T.length;
  const ent0 = entityBefore(T, feat, m);
  let entity = ent0.kinds.length === 1 ? ent0.kinds[0] : null;
  if (!entity && ent0.kinds.length === 0 && /^who$/.test(lowerAll[0] ?? '') ) entity = 'customer';
  if (!entity && lowerAll.includes('who')) entity = 'customer';
  if (!entity) return null;
  if (feat.docTypes.length > 1) return null;

  // fields after the marker (verbs that stand for a field: "never got registered", "not linked")
  let after = m + 1;
  while (after < T.length && /^(?:have|has|had|got|get|list|listed|show|shows|include|includes|carry|carries|record|records|store|mention|mentions|name|names)$/.test(T[after].w) && /^(?:dont|doesnt|not|never|arent|isnt|havent|hasnt|no)$/.test(T[m].w)) after++;
  let { fields, used } = fieldsIn(T, after, entity);
  const verbs = [];
  for (let i = after; i < T.length; i++) { const f = VERB_FIELD[T[i].w]; if (f && /^(?:not|never|arent|isnt|havent|hasnt|dont|doesnt|no|without|neither|none|got|get|been)$/.test(T[Math.max(m, i - 1)].w) || (f && i > m)) { if (entity === 'unit' && T[i].w === 'registered') verbs.push({ id: 'registeredDate', label: 'warranty registration', idx: [i] }); else if (entity === 'document' && (T[i].w === 'linked' || T[i].w === 'attached')) verbs.push({ id: 'custLink', label: 'customer link', idx: [i] }); else if (entity === 'document' && T[i].w === 'extracted') verbs.push({ id: 'details', label: 'extracted details', idx: [i] }); } }
  if (orphan && entity === 'document') fields.push({ id: 'custLink', label: 'customer link', idx: [] });
  for (const v of verbs) if (!fields.some((f) => f.id === v.id)) fields.push(v);
  // a bare "number" belongs to the kind of paper asked about
  const numIdx = T.findIndex((x, i) => i > m && /^numbers?$/.test(x.w) && !used.has(i));
  if (numIdx >= 0 && entity === 'document' && feat.docTypes.length === 1) {
    const id = { invoice: 'num:invoice_number', 'purchase-order': 'num:po_number', permit: 'num:permit_number' }[feat.docTypes[0]];
    if (!id) return null;
    fields.push({ id, label: { invoice: 'invoice number', 'purchase-order': 'PO number', permit: 'permit number' }[feat.docTypes[0]], idx: [numIdx] });
  }
  if (entity === 'document' && lowerAll.join(' ').match(/nothing extracted|no extracted|not extracted|noting extracted|nothing was extracted/) && !fields.some((f) => f.id === 'details')) fields.push({ id: 'details', label: 'extracted details', idx: [] });
  if (fields.some((f) => f.id === 'customer' || f.id === 'custName') && fields.some((f) => f.id === 'custLink')) fields = fields.filter((f) => f.id !== 'custLink');
  let forceAll = false;
  if (fields.some((f) => f.id === 'contact')) {
    // "no contact info" is neither a phone nor an email; "missing contact info" could be either one missing: asked back, not guessed
    if (fields.length > 1 || entity !== 'customer' || /^(?:missing|lacking|lack|lacks|blank|empty)$/.test(T[m].w)) return null;
    fields = [{ id: 'phone', label: 'phone number', idx: fields[0].idx }, { id: 'email', label: 'email', idx: [] }];
    forceAll = true;
  }
  if (!fields.length) return null;
  const usedIdx = new Set([...used, ...fields.flatMap((f) => f.idx)]);
  // conjunction: "neither phone nor email" / "no equipment and no invoice" -> all; "no email or phone" / "customer or date" -> any
  const joined = lowerAll.slice(m).join(' ');
  const mode = forceAll || /\bneither\b/.test(joined) || (/\band\b/.test(joined) && fields.length > 1 && /\b(?:no|without)\b.*\band\b.*\b(?:no|without)\b/.test(joined)) ? 'all' : 'any';
  if (fields.length > 1 && mode === 'any' && !forceAll && !/\bor\b|\bnor\b|\band\b/.test(joined)) return null;
  if (fields.length > 3) return null;
  // "customers without a phone and an email" could mean either one or both: asked back, not guessed
  if (fields.length > 1 && /\band\b/.test(joined) && mode === 'any' && !/\bor\b/.test(joined)) return null;
  // unsupported contexts
  for (const f of fields) if (f.id === 'details' && entity !== 'document') return null;
  // coverage: every unexplained token is a marker, a field phrase, a trailing word or a noun
  for (const tok of T.filter(isLeft)) {
    if (usedIdx.has(tok.i)) continue;
    const w = tok.w;
    if (MISSING_MARK.has(w) || TRAIL_OK.has(w) || VERB_FIELD[w] || /^(?:numbers?|orphans?|orphaned|unlinked|waiting|linked|any|other|else)$/.test(w) || ENTITY_WORDS.customer.includes(w) || ENTITY_WORDS.unit.includes(w) || ENTITY_WORDS.document.includes(w)) continue;
    if (/^(?:tenants?|patients?|donors?|people|who|jobs?|files?|records?)$/.test(w) || PRE_CUE_OK.has(w)) continue;
    return null;
  }
  if (entity === 'document' && !feat.docTypes.length && !ent0.visit) {
    // across every kind of paper only a few fields mean the same thing: a model, a total or a technician needs the kind of paper named
    const OK = new Set(['custLink', 'customer', 'custName', 'date', 'details', 'serviceDate', 'invoiceDate']);
    if (fields.some((f) => !OK.has(f.id))) return null;
  }
  if ((entity === 'unit' || entity === 'customer') && feat.docTypes.length) {
    // "units with no warranty registration": the doc-type word is the field's own phrase; "units with no startup sheet" asks about another kind of paper
    const fieldWords = new Set([...usedIdx].map((i) => T[i]?.w).filter(Boolean));
    const dw = String(feat.docWord ?? '').split(/\s+/).filter(Boolean);
    if (!dw.length || !dw.every((w) => fieldWords.has(w) || fieldWords.has(sgl(w)))) return null;
  }
  const base = baseFor(feat, entity);
  if (entity === 'unit') { base.docType = null; base.visit = false; }
  if (entity === 'customer') { base.docType = null; base.visit = false; }
  if (ent0.visit) base.visit = true;
  const keep = feat.filters;
  const filters = mapFilters(keep, entity);
  if (!filters) return null;
  if (entity === 'customer' && filters.some((x) => !['name', 'city', 'hasBrand'].includes(x.field))) return null;
  base.filters = filters;
  const time = timeFor(feat, entity, base.visit, base.docType);
  if (time === undefined) return null;
  base.time = time;
  if (entity === 'customer' && time) return null;
  if (feat.dims.length || feat.flags.each || t.topN || t.argmax || t.share || t.avg || t.median || t.versus || t.distinct || feat.recentN) return null;
  const show = t.howMany ? 'count' : (t.exists || t.any) && !feat.flags.listVerb ? 'exists' : 'list';
  // field ids valid for the entity
  return { ...base, op: 'missing_field', fields: fields.map(({ id, label }) => ({ id, label })), mode, show, entity };
}

/* ---------------------------------------------------------------------- duplicates */

const DUP_WORD = /^(?:duplicate|duplicates|duplicated|dupe|dupes|twice|doubled|shared|shares|sharing|identical)$/;
const DUP_KNOWN = new Set(('duplicate duplicates duplicated dupe dupes twice doubled shared shares sharing identical more than once one same number numbers used listed showing shows show up another by two any check is ever uploaded ' +
  'file files invoice invoices serial serials po pos permit permits phone email emails address addresses customer customers tenant tenants client clients patient patients visit visits day amount bill billed billing job jobs anyone anybody ' +
  'double this work order orders purchase record records time times entries per of different in on at among across and or that appear appears appearing got do did we have has are there with for to a an the doc docs document documents paperwork ' +
  'mistake multiple anywhere somewhere possible possibly potential perimt nmbers').split(' '));
/** R20: the field that carries the paper's own number for one kind of paper, read from the company's card: the one id-shaped field stored on that kind (when several, the one whose key says number/no/ref). Two fits means none. */
function cardIdField(vocab, docType) {
  const fields = vocab?.card?.fields; if (!fields) return null;
  const ids = Object.entries(fields).filter(([, f]) => f.shape === 'id' && (f.types ?? []).includes(docType)).map(([k]) => k);
  if (ids.length === 1) return ids[0];
  const named = ids.filter((k) => k.toLowerCase().split(/[^a-z0-9]+/).some((t) => ['number', 'no', 'num', 'ref', 'nbr'].includes(t)));
  return named.length === 1 ? named[0] : null;
}
function duplicates(feat, h, T) {
  const t = feat.trig ?? {};
  const lowerAll = T.map((x) => x.w);
  const text = lowerAll.join(' ');
  const twoIdx = lowerAll.findIndex((w, i) => w === 'two' && i + 1 < lowerAll.length);
  const hasDup = lowerAll.some((w) => DUP_WORD.test(w)) || /double(?:d)? up|same .* as another|(?:show|shows|showing|appear|appears|appearing|listed|used|filed) (?:up )?(?:more than once|more than one time|twice)|two visits/.test(text) || (twoIdx >= 0 && /^(?:are|is|do|does|did)\b/.test(text));
  if (!hasDup) return null;
  if (feat.docTypes.length > 1) return null;
  const docType = feat.docTypes[0] ?? null;
  const has = (re) => re.test(text);
  let key = null; let label = null; let type = null;
  const num = (field, lbl, ty) => { key = { kind: 'docnum', field }; label = lbl; type = ty; };
  // "are there two Pat Smiths": the words after "two" are a name
  const pairWords = [];
  if (twoIdx >= 0 && /^(?:are|is|do|does|did)\b/.test(text)) for (let i = twoIdx + 1; i < T.length; i++) { if (!isLeft(T[i]) && !T[i].consumed) continue; if (T[i].consumed) { if (!feat.filters.some((f) => f.role === 'customer')) break; continue; } if (!DUP_KNOWN.has(T[i].w)) pairWords.push(T[i].w); }
  const namedCust = feat.filters.find((f) => f.role === 'customer');
  if (has(/work orders?.*numbers?|work order numbers?/) || (docType === 'work-order' && has(/numbers?/))) num('work_order_number', 'work order number', 'work-order');
  else if (has(/\bpo numbers?\b|purchase order numbers?/) || (docType === 'purchase-order' && has(/numbers?/))) num('po_number', 'PO number', 'purchase-order');
  else if (has(/permit numbers?|\bperm\w* numbers?\b/) || (docType === 'permit' && has(/numbers?/))) num('permit_number', 'permit number', 'permit');
  else if (has(/invoice numbers?/) || (docType === 'invoice' && has(/numbers?/))) num('invoice_number', 'invoice number', 'invoice');
  else if (process.env.R20_DUPNUM !== '0' && docType && has(/\bnumbers?\b/) && cardIdField(h.vocab, docType)) { const f = cardIdField(h.vocab, docType); num(f, `${String(f).replace(/_/g, ' ')}`, docType); }
  else if (has(/phone/)) { key = { kind: 'customerField', field: 'phone' }; label = 'phone number'; }
  else if (has(/e ?mail/)) { key = { kind: 'customerField', field: 'email' }; label = 'email address'; }
  else if (has(/address/)) { key = { kind: 'customerField', field: 'address' }; label = 'service address'; }
  else if (has(/serial/)) {
    if (docType || feat.nouns.document) { key = { kind: 'docSerial' }; label = 'serial number'; type = docType; } else { key = { kind: 'unitSerial' }; label = 'serial number'; }
  } else if (has(/uploaded twice|same file|file.*twice|document.*twice|filed twice/)) { key = { kind: 'file' }; label = 'file'; }
  else if (has(/same amount|same customer|bill\w* .*twice|twice.*job|same job|double.*bill/) && (docType === 'invoice' || has(/invoice|bill/))) { key = { kind: 'invoiceAmount', job: has(/same job|for the same job/) }; label = 'customer and amount'; type = 'invoice'; }
  else if (has(/two visits|same day/)) { key = { kind: 'visitDay' }; label = 'customer and visit day'; }
  else if (pairWords.length && pairWords.length <= 3) { key = { kind: 'namedPair', name: pairWords.join(' ') }; label = 'name'; }
  else if (feat.nouns.customer || /\b(?:tenants?|patients?|clients?|customers?)\b/.test(text)) { key = { kind: 'customerName' }; label = 'name'; }
  if (!key) return null;
  // coverage: every word nothing else explained is part of the duplicate question itself
  for (const tok of T.filter(isLeft)) { if (!DUP_KNOWN.has(tok.w) && !cueOf(tok.w) && !(key.kind === 'namedPair' && pairWords.includes(tok.w))) return null; }
  if (t.negation || t.share || t.avg || t.median || t.topN || t.argmax || t.versus || feat.recentN || feat.dims.length) return null;
  const entity = ['unitSerial'].includes(key.kind) ? 'unit' : ['customerField', 'customerName', 'namedPair'].includes(key.kind) ? 'customer' : 'document';
  const base = baseFor(feat, entity);
  base.docType = type ?? (entity === 'document' ? docType : null);
  if (key.kind === 'visitDay') { base.docType = null; base.visit = true; }
  if (key.kind === 'file') base.docType = null;
  if (key.kind === 'invoiceAmount') { base.docWord = null; }
  const dropNum = (f) => f.field === '?num' && ((f.value === 1 && ['gt', 'gte'].includes(f.op)) || (f.value === 2 && ['gte', 'eq'].includes(f.op)));
  const filters = mapFilters(feat.filters.filter((f) => !dropNum(f)), entity);
  if (!filters) return null;
  base.filters = key.kind === 'customerName' ? filters.filter((f) => f.role !== 'customer') : filters;
  if (namedCust && !['customerName', 'namedPair'].includes(key.kind)) return null;
  const time = timeFor(feat, entity, base.visit, base.docType);
  if (time === undefined) return null;
  base.time = time;
  const show = t.howMany ? 'count' : (t.exists || t.any || /^(?:are|is|do|did|does|any|check)$/.test(lowerAll[0] ?? '')) && !feat.flags.listVerb ? 'exists' : 'list';
  return { ...base, op: 'duplicates', key, keyLabel: label, show, named: namedCust ? namedCust.value : null };
}

/* ---------------------------------------------------------------------- cost breakdown */

function breakdown(feat, h, T) {
  const t = feat.trig ?? {};
  const text = T.map((x) => x.w).join(' ');
  if (!/\b(?:break ?down|breakdown|split)\b|\bbroken down\b/.test(text)) return null;
  if (!/\b(?:line items?|lines|billings?|billed|spend|charges?|revenue|invoices?)\b/.test(text) && !(t.money?.length)) return null;
  if (!/\bline items?\b|\blines\b|\bby (?:the )?(?:type|kind) of work\b|\bby what\b|\bby type\b|\bparts\b/.test(text)) return null;
  if (feat.docTypes.length > 1) return null;
  const known = /^(?:break|breakdown|down|split|of|our|line|lines|items?|item|spend|by|what|they|were|for|type|types|kind|work|billings?|billed|between|and|installs?|service|services|parts?|each|the|a|all|on|per|show|me|or|vs|versus|into|categories|category|how|much|money|is|pls|please)$/;
  for (const tok of T.filter(isLeft)) if (!known.test(tok.w)) return null;
  if (/\b(?:materials?|labor|labour)\b/.test(text)) return null; // materials vs labor needs a field the lines do not carry
  const only = [];
  const bw = /\bbetween\s+([a-z]+)\s+and\s+([a-z]+)\b/.exec(text);
  if (bw) only.push(bw[1], bw[2]);
  const lst = /\binstalls?\s*,\s*service\s*,\s*(?:and\s+)?parts\b/.exec(text);
  if (lst) only.push('installs', 'service', 'parts');
  const base = baseFor(feat, 'document');
  const docType = feat.docTypes[0] ?? (/\b(?:billings?|billed|revenue|invoices?)\b/.test(text) ? 'invoice' : null);
  if (docType && !LINE_TYPES.has(docType)) return null;
  base.docType = docType; base.docWord = feat.docTypes.length ? base.docWord : null;
  const filters = mapFilters(feat.filters, 'document');
  if (!filters) return null;
  base.filters = filters;
  const time = timeFor(feat, 'document', false, docType);
  if (time === undefined) return null;
  base.time = time;
  if (feat.dims.length) return null;
  return { ...base, op: 'cost_breakdown', only: only.map(sgl) };
}

/* ---------------------------------------------------------------------- field conflicts */

const CONFLICT_WORD = /^(?:disagree|disagrees|disagreed|conflict|conflicts|mismatch|mismatches|mismatched|differ|differs)$/;
function conflicts(feat, h, T) {
  const t = feat.trig ?? {};
  const text = T.map((x) => x.w).join(' ');
  const two = /serial(?: numbers?)? .*(?:two|2|more than one) (?:different )?brands?|(?:two|2) different brands?/.test(text);
  if (two) {
    for (const tok of T.filter(isLeft)) if (!/^(?:serial|serials|numbers?|show|shows|up|in|two|different|brands?|that|appear|appears|with)$/.test(tok.w)) return null;
    return { ...baseFor(feat, 'document'), op: 'field_conflict', kind: 'serialBrands', filters: [], time: null };
  }
  if (!(/\b(?:disagree\w*|mismatch\w*|conflict\w*)\b|doesnt match|does not match|different .* than|differs? from/.test(text))) return null;
  const types = feat.docTypes.filter((d) => d !== 'equipment-record');
  const docType = types[0] ?? null;
  if (!docType || types.length > 1) return null;
  const fm = /\b(model|brand|manufacturer|serial|install date|installation date|tonnage|refrigerant)\b/.exec(text);
  if (!fm) return null;
  const fld = { model: 'model', brand: 'brand', manufacturer: 'brand', serial: 'serial', 'install date': 'installDate', 'installation date': 'installDate', tonnage: 'tonnage', refrigerant: 'refrigerant' }[fm[1]];
  if (!/equipment record|unit record|the unit|equipment/.test(text)) return null;
  const known = /^(?:do|does|any|disagree|disagrees|with|the|equipment|record|records|on|model|brand|manufacturer|serial|install|installation|date|tonnage|refrigerant|show|shows|a|different|than|differs?|from|mismatch\w*|conflict\w*|match|doesnt|not|unit|that|where|have|has|numbers?)$/;
  for (const tok of T.filter(isLeft)) if (!known.test(tok.w) && !CONFLICT_WORD.test(tok.w)) return null;
  const base = { ...baseFor(feat, 'document'), docType, docWord: null };
  const filters = mapFilters(feat.filters, 'document');
  if (!filters) return null;
  base.filters = filters;
  return { ...base, op: 'field_conflict', kind: 'docVsUnit', field: fld, fieldLabel: fm[1], time: null };
}

/* ---------------------------------------------------------------------- finding one paper */

/** What a person asks about one paper ("total", "labor hours", "service date and tech"): the fields named, [] when none, null when the words are not a field list we know. */
const ASK_FIELDS = [
  [/^(?:hours?|horus|hrs?)$/, 'hours', 'labor hours'], [/^(?:total|amount|cost|price)$/, 'total', 'total'], [/^(?:technician|tech)$/, 'tech', 'technician'],
  [/^(?:vendor|supplier)$/, 'vendor', 'vendor'], [/^status$/, 'status', 'status'], [/^(?:customer|client)$/, 'customer', 'customer'],
];
function askFields(T, t = {}) {
  const ws = T.map((x) => x.w);
  const out = []; const used = new Set();
  const add = (id, label, ...idx) => { if (!out.some((f) => f.id === id)) out.push({ id, label }); idx.forEach((i) => used.add(i)); };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === 'service' && ws[i + 1] === 'date') { add('serviceDate', 'service date', i, i + 1); i++; continue; }
    if (w === 'invoice' && ws[i + 1] === 'date') { add('invoiceDate', 'invoice date', i, i + 1); i++; continue; }
    if (w === 'labor' && /^(?:hours?|horus|hrs?)$/.test(ws[i + 1] ?? '')) { add('hours', 'labor hours', i, i + 1); i++; continue; }
    if (w === 'billed' && ws[i + 1] === 'to') { add('customer', 'customer', i, i + 1); i++; continue; }
    if (w === 'work' && /^performed$/.test(ws[i + 1] ?? '')) { add('work', 'work performed', i, i + 1); i++; continue; }
    if (/^(?:date|dated)$/.test(w)) { add('date', 'date', i); continue; }
    if (w === 'when') { add('date', 'date', i); continue; }
    for (const [re, id, label] of ASK_FIELDS) if (re.test(w)) add(id, label, i);
  }
  if (t.howMuch && !out.some((f) => f.id === 'total')) { out.push({ id: 'total', label: 'total' }); }
  return { fields: out, used };
}

const CODEISH = /^(?=.*\d)(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIND_OK = new Set('pull up find show me get open see look display give the a an of for on about details detail all everything anything any is are was were what whats do does we have has in file files there record records document documents doc docs paperwork paper papers copy number numbered with that mention mentions mentioning serial and included include includes it this its please pls plz thanks hey hi hello ok okay can could would you i my us our need want like let lets know tell then'.split(' '));
const ASK_GLUE = new Set('how many much were was billed bill to who when what which placed filed issued'.split(' '));
function findDocument(feat, h, T) {
  const t = feat.trig ?? {};
  const lowerAll = T.map((x) => x.w);
  if (feat.docTypes.length > 1) return null;
  if (t.negation || t.missing || t.share || t.avg || t.median || t.versus || t.topN || t.argmax || t.max || t.min || feat.recentN || feat.dims.length) return null;
  const docType = feat.docTypes[0] ?? null;
  const serialWord = lowerAll.includes('serial');
  const base = baseFor(feat, 'document');
  const docWordParts = new Set(String(feat.docWord ?? '').split(/\s+/).filter(Boolean));
  const { fields: ask, used: askUsed } = serialWord ? { fields: [], used: new Set() } : askFields(T, t);
  const codeTok = T.find((x) => !x.consumed && CODEISH.test(x.w) && x.w.length >= 5);
  // every word of the question must be one the lookup itself uses; a word like "age", "model", "who" or "expire" asks something else about the same paper or unit
  const allWordsKnown = () => T.every((tok) => tok === codeTok || askUsed.has(tok.i) || FIND_OK.has(tok.w) || docWordParts.has(tok.w) || (ask.length > 0 && ASK_GLUE.has(tok.w)) || (t.howMuch && ask.length > 0 && tok.w === 'much'));
  // a document number or a serial number ("INV-20050", "PO-9004", "BP-2025-10001", "2G100076")
  if (codeTok) {
    if (!allWordsKnown()) return null;
    // "what is serial 2C100027" / "pull up serial ..." asks about the UNIT (its model, its customer); only a question that names papers asks which papers carry the serial
    if (serialWord && !docType && !lowerAll.some((w) => /^(?:documents?|docs?|paperwork|papers?|files?|mentions?|mentioning|records?)$/.test(w))) return null;
    if (feat.filters.length || feat.time) return null;
    return { ...base, op: 'find_document', by: serialWord ? 'serial' : 'code', code: codeTok.w, hyphen: codeTok.w.includes('-'), filters: [], time: null, show: 'list', ask };
  }
  // an amount ("find the invoice for exactly $2,800")
  const numF = feat.filters.filter((f) => f.field === '?num');
  if (numF.length === 1 && numF[0].op === 'eq' && numF[0].dollar && docType && !feat.flags.plural && !t.howMany) {
    const left = T.filter(isLeft);
    for (const tok of left) if (!FIND_OK.has(tok.w) && !docWordParts.has(tok.w)) return null;
    if (feat.filters.length > 1) return null;
    return { ...base, op: 'find_document', by: 'total', amount: numF[0].value, filters: [], time: null, show: 'list' };
  }
  return null;
}
/** A bare amount in the working words ("which invoice was for 2937"): not a dollar sign, so the core leaves it as a leftover number. */
function findByBareAmount(feat, h, T) {
  const t = feat.trig ?? {};
  const docType = feat.docTypes[0] ?? null;
  if (!docType || feat.docTypes.length > 1 || feat.filters.length || feat.time || t.howMany || t.negation) return null;
  const left = T.filter(isLeft);
  const nums = left.filter((x) => /^\d{3,7}(?:\.\d+)?$/.test(x.w));
  if (nums.length !== 1) return null;
  for (const tok of left) if (tok !== nums[0] && !/^(?:was|for|which|exactly|of|worth|that|is|total|totals?|amount|came|to)$/.test(tok.w)) return null;
  if (!/\b(?:for|exactly|worth|of)\b/.test(T.map((x) => x.w).join(' '))) return null;
  return { ...baseFor(feat, 'document'), op: 'find_document', by: 'total', amount: Number(nums[0].w), filters: [], time: null, show: 'list', _bare: true };
}
/** "find the parts count sheet", "shop truck dispatch note": the words name the file. */
function findByFilename(feat, h, T) {
  const t = feat.trig ?? {};
  if (feat.docTypes.length > 1 || feat.filters.length || feat.time || t.howMany || t.negation || t.missing || feat.recentN || feat.dims.length) return null;
  const left = T.filter(isLeft);
  if (!left.length) return null;
  const lead = /^(?:find|pull|show|get|open|see|where|whats|what|wheres)$/;
  const GEN = /^(?:sheet|sheets|note|notes|file|files|doc|docs|document|documents|paper|papers|report|form|page|copy|scan|about|is|the|a|an)$/;
  if (!T.some((x) => /^(?:find|pull|show|get|open|see)$/.test(x.w)) && !T.some((x) => /^(?:sheet|sheets|note|notes|file|files|copy|scan|form)$/.test(x.w))) return null;
  const terms = left.filter((x) => !GEN.test(x.w) && !lead.test(x.w));
  if (!terms.length || terms.length > 4) return null;
  return { ...baseFor(feat, 'document'), op: 'find_document', by: 'filename', words: terms.map((x) => x.w), filters: [], time: null, show: 'list', explain: /\babout\b/.test(T.map((x) => x.w).join(' ')) };
}

/* ---------------------------------------------------------------------- future dates, completeness, starts-with */

function futureDates(feat, h, T) {
  const t = feat.trig ?? {};
  const text = T.map((x) => x.w).join(' ');
  if (!/\b(?:future|upcoming|later than today|after today|ahead of today)\b/.test(text) || !/\b(?:dates?|dated|date)\b/.test(text)) return null;
  if (feat.docTypes.length > 1 || feat.filters.length || feat.time || t.howMany && false) return null;
  const known = /^(?:are|is|there|any|dates?|dated|in|the|future|documents?|docs?|records?|anything|anyone|later|than|today|after|upcoming|ahead|of|have|has|with|a|an|that|do|we|did|file|files)$/;
  for (const tok of T.filter(isLeft)) if (!known.test(tok.w)) return null;
  const base = baseFor(feat, 'document');
  return { ...base, op: 'future_dates', filters: [], time: null, show: t.howMany ? 'count' : 'exists' };
}

const COMPLETE_SETS = {
  unit: [['serial', 'serial number'], ['model', 'model number'], ['brand', 'brand'], ['tonnage', 'tonnage'], ['refrigerant', 'refrigerant'], ['installDate', 'installation date'], ['registeredDate', 'warranty registration']],
  customer: [['phone', 'phone number'], ['email', 'email'], ['address', 'service address']],
};
function completeness(feat, h, T) {
  const text = T.map((x) => x.w).join(' ');
  const m = /\bhow (?:complete|filled in|full|good) (?:is|are) (?:the |our |my )?(equipment|units?|customers?|clients?)(?: records?| data| info(?:rmation)?)?(?: data| info(?:rmation)?)?\b/.exec(text);
  if (!m) return null;
  const entity = /^(?:equipment|unit)/.test(m[1]) ? 'unit' : 'customer';
  const known = /^(?:how|complete|filled|in|full|good|is|are|the|our|my|equipment|units?|customers?|clients?|records?|data|info|information)$/;
  for (const tok of T.filter(isLeft)) if (!known.test(tok.w)) return null;
  if (feat.filters.length || feat.time || feat.docTypes.length) return null;
  return { ...baseFor(feat, entity), entity, docType: null, visit: false, op: 'completeness', fields: COMPLETE_SETS[entity].map(([id, label]) => ({ id, label })), filters: [], time: null };
}

const PREFIX_FIELDS = { model: ['unit', 'model', 'model number'], serial: ['unit', 'serial', 'serial number'], phone: ['customer', 'phone', 'phone number'], email: ['customer', 'email', 'email address'] };
function addressContains(feat, h, T) {
  const t = feat.trig ?? {};
  const text = T.map((x) => x.w).join(' ');
  const m = /\b(units?|equipment|customers?|clients?)\b.*?\baddress(?:es)? (?:with|containing|that (?:have|has|include|includes|contain|contains)) (?:an? |the |any )?([a-z0-9]+)(?: numbers?)?$/.exec(text.replace(/\s+(?:pls|please)$/, ''));
  if (!m) return null;
  const entity = /^(?:unit|equipment)/.test(m[1]) ? 'unit' : 'customer';
  const word = m[2];
  if (/^(?:a|an|the|any|number|numbers|street|st|city|state|zip)$/.test(word)) return null;
  const known = new Set(['units', 'unit', 'equipment', 'customers', 'customer', 'clients', 'client', 'are', 'at', 'in', 'with', 'addresses', 'address', 'that', 'have', 'has', 'include', 'includes', 'contain', 'contains', 'containing', 'number', 'numbers', word, 'how', 'many', 'a', 'an', 'the', 'any', 'show', 'list', 'which']);
  for (const tok of T.filter(isLeft)) if (!known.has(tok.w)) return null;
  if (feat.docTypes.length || feat.time || t.negation) return null;
  const filters = mapFilters(feat.filters, entity);
  if (!filters) return null;
  if (entity === 'customer' && filters.some((x) => !['name', 'city'].includes(x.field))) return null;
  return { ...baseFor(feat, entity), entity, docType: null, visit: false, filters, time: null, op: 'field_text', field: entity === 'unit' ? 'custAddress' : 'address', label: 'address', how: 'contains', value: word, show: t.howMany ? 'count' : 'list' };
}
function startsWith(feat, h, T) {
  const t = feat.trig ?? {};
  const text = T.map((x) => x.w).join(' ');
  const m = /\b(model|serial|phone|email)(?: numbers?| addresses| address)? (?:that |which )?(start|starts|starting|begin|begins|beginning|end|ends|ending) (?:with|in) ([a-z0-9][a-z0-9.@-]*)\b/.exec(text);
  if (!m) return null;
  const [entity, field, label] = PREFIX_FIELDS[m[1]];
  const code = m[3];
  const known = new Set(['model', 'serial', 'phone', 'email', 'number', 'numbers', 'address', 'addresses', 'that', 'which', 'start', 'starts', 'starting', 'begin', 'begins', 'beginning', 'end', 'ends', 'ending', 'with', 'in', code, 'units', 'unit', 'customers', 'show', 'list']);
  for (const tok of T.filter(isLeft)) if (!known.has(tok.w)) return null;
  const tokCode = T.find((x) => x.w === code);
  if (feat.docTypes.length || feat.time || t.negation) return null;
  const filters = mapFilters(feat.filters, entity);
  if (!filters) return null;
  if (entity === 'customer' && filters.some((x) => !['name', 'city'].includes(x.field))) return null;
  return { ...baseFor(feat, entity), entity, docType: null, visit: false, filters, time: null, op: 'field_text', field, label, how: /^(?:end|ends|ending)$/.test(m[2]) ? 'suffix' : 'prefix', value: code, show: t.howMany ? 'count' : 'list', _tok: Boolean(tokCode) };
}

/* ---------------------------------------------------------------------- who has this phone number / email */

const REVERSE_KNOWN = new Set('look up find phone number email address which customer customers who uses use has have this that is are one of ours on file whose belongs belong to the owner for does anyone do we any with a an it whos has the mine our us'.split(' '));
function reverseLookup(feat, h, T) {
  const t = feat.trig ?? {};
  const raw = String(feat.work?.text ?? '');
  const em = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(raw);
  const ph = em ? null : /(?<![\d.-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\d-])/.exec(raw);
  const hit = em ?? ph;
  if (!hit) return null;
  if (feat.docTypes.length || feat.filters.length || feat.time || t.howMany || t.negation || t.missing || t.share || feat.dims.length) return null;
  const hitAlnum = hit[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tok of T.filter(isLeft)) { const a = tok.w.replace(/[^a-z0-9]/g, ''); if (!(a && hitAlnum.includes(a)) && !REVERSE_KNOWN.has(tok.w)) return null; }
  const field = em ? 'email' : 'phone';
  const value = em ? em[0].toLowerCase() : hit[0].replace(/\D/g, '').slice(-10);
  if (field === 'phone' && value.length < 10) return null;
  const yesNo = /^(?:is|are|do|does|have|has)\b/i.test(raw.trim()) || /\bone of ours\b|\bon file\b/i.test(raw);
  return { ...baseFor(feat, 'customer'), entity: 'customer', docType: null, visit: false, filters: [], time: null, op: 'reverse_lookup', field, value, shown: hit[0].trim(), show: yesNo ? 'exists' : 'list' };
}

/* ====================================================================== analyze: run every recognizer; exactly one may answer */

const MY_WORDS = ['numbers', 'number', 'permit', 'permits', 'invoice', 'invoices', 'serial', 'duplicate', 'duplicates', 'twice', 'customers', 'customer', 'technician', 'missing', 'without', 'registration', 'registered', 'equipment', 'documents', 'anyone', 'mention', 'mentions', 'mentioning', 'between', 'address', 'phone', 'estimates', 'attached', 'extracted', 'nothing', 'service', 'records'];
let MY_BY_LEN = null;
/** A misspelled word of this family's own small vocabulary ("nmbers", "perimt", "tiwce") is that word; only when exactly one is nearest. */
function normalizeTokens(T) {
  if (!MY_BY_LEN) { MY_BY_LEN = new Map(); for (const w of MY_WORDS) { if (!MY_BY_LEN.has(w.length)) MY_BY_LEN.set(w.length, []); MY_BY_LEN.get(w.length).push(w); } }
  return T.map((tok) => {
    const w = tok.w;
    if (tok.consumed || w.length < 5 || /\d/.test(w) || isRealWord(w)) return tok;
    const r = repairTo(w, MY_BY_LEN);
    return r ? { ...tok, w: r } : tok;
  });
}
function analyze(feat, h) {
  if (!feat.work) return null;
  const T = normalizeTokens(tokensOf(feat.work));
  if (!T.length) return null;
  const tries = [textual, missingFields, duplicates, breakdown, conflicts, findDocument, findByBareAmount, findByFilename, futureDates, completeness, startsWith, addressContains, reverseLookup];
  const plans = [];
  for (const fn of tries) {
    let p = null;
    try { p = fn(feat, h, T); } catch (e) { if (process.env.DQL_DEBUG) console.error('textdq', fn.name, e); p = null; }
    if (p) plans.push(p);
  }
  if (!plans.length) return null;
  // the strongest reading wins only when it is alone at its strength; a tie is a question we do not understand
  const prio = (p) => (p.op === 'find_document' && p.by === 'filename' ? 1 : (p.op === 'text_search' || p.op === 'line_search') && p._weak ? 2 : p.op === 'find_document' && p.by === 'total' && p._bare ? 2 : 3);
  const top = Math.max(...plans.map(prio));
  const best = plans.filter((p) => prio(p) === top);
  if (best.length !== 1) return null;
  const out = { ...best[0] }; delete out._weak; delete out._bare; delete out._tok;
  return out;
}

/* ====================================================================== execution */

const docNumber = (d, snap, key) => {
  const fin = finOf(snap).get(d.id);
  if (key === 'invoice_number') return d.f.invoice_number ?? fin?.invoice_number ?? null;
  if (key === 'po_number') return d.f.po_number ?? fin?.po_number ?? null;
  if (key === 'permit_number') return d.f.permit_number ?? null;
  return d.f[key] ?? null;
};
const FINMAP = new WeakMap();
function finOf(snap) {
  let m = FINMAP.get(snap);
  if (!m) { m = new Map(); for (const f of snap.fin ?? []) m.set(f.doc.id, f); FINMAP.set(snap, m); }
  return m;
}
const LINEMAP = new WeakMap();
function linesOf(snap) {
  let m = LINEMAP.get(snap);
  if (!m) { m = new Map(); for (const l of snap.lines) { if (!m.has(l.docId)) m.set(l.docId, []); m.get(l.docId).push(l); } LINEMAP.set(snap, m); }
  return m;
}
const unitOfDoc = (d, snap) => (d.unitId ? snap.unitById.get(d.unitId) ?? null : null);

function selectOnly(plan, x, over = {}) {
  return x.h.selectRows({ ...plan, ...over }, x.snap, x.today);
}

/* ---- text_search / line_search */
function execText(plan, x) {
  const { snap, h } = x;
  const ix = textIndex(snap);
  const term = resolveTerm(plan.term, ix, plan.term.needCorpus);
  if (!term) return { abstain: 'term' };
  if (plan.term.needCorpus && !term.stems.every((s) => [...ix.stems].some((y) => stemEq(y, s)))) return { abstain: 'term-not-in-records' };
  const sel = selectOnly(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  const pos = []; const neg = []; const negEx = [];
  const isLines = plan.op === 'line_search';
  const posLines = [];
  for (const r of sel.rows) {
    if (isLines) {
      let dp = false; let dn = false;
      for (const l of linesOf(snap).get(r.id) ?? []) {
        const sn = ix.lineSn.get(l.id);
        if (!sn) continue;
        const m = matchSnippet(sn, term);
        if (m === 'pos') { posLines.push(l); dp = true; } else if (m === 'neg') { dn = true; negEx.push(sn.text); }
      }
      if (dp) pos.push(r); else if (dn) neg.push(r);
    } else {
      const { m, sn } = matchAny(ix.byDoc.get(r.id), term);
      if (m === 'pos') pos.push(r); else if (m === 'neg') { neg.push(r); if (negEx.length < 3) negEx.push(sn.text); }
    }
  }
  // R23: the snapshot keeps the fields, notes and line items, not the page text the owner's papers were read from: finding nothing here is only a lower bound, so "No ... mention" is never said; the question is released to the page search / the model
  if (!pos.length) return { abstain: 'zero-is-lower-bound' };
  // a question with no cue word is only read as a text search when it finds something; "nothing" would be a guess about what was meant
  if (plan.term.needCorpus && !pos.length) return { abstain: 'no-cue-no-match' };
  const res = { n: pos.length, rows: pos, neg, negEx, term, leftOut: sel.leftOut ?? 0, scanned: sel.rows.length, posLines };
  if (plan.show === 'sum' && plan.sumDocs) {
    const vals = pos.map((r) => r.total).filter((v) => v != null);
    res.sum = vals.reduce((a, b) => a + b, 0); res.sumN = vals.length; res.noAmount = pos.length - vals.length;
    if (pos.length && !vals.length) return { abstain: 'measure-missing' };
  } else if (plan.show === 'sum') {
    const vals = posLines.map((l) => l.amount).filter((v) => v != null);
    res.sum = vals.reduce((a, b) => a + b, 0); res.sumN = vals.length; res.noAmount = posLines.length - vals.length;
    if (posLines.length && !vals.length) return { abstain: 'measure-missing' };
  }
  if (plan.groupBy?.length) {
    const g = h.groupRows(pos, plan, snap, x.today);
    res.groups = [...g.groups.entries()].map(([k, v]) => ({ key: k, parts: v.parts, n: v.rows.length, rows: v.rows }));
    const chrono = ['year', 'month', 'quarter', 'monthOfYear'].includes(plan.groupBy[0].by);
    res.groups.sort((a, b) => (chrono ? a.key.localeCompare(b.key) : (b.n - a.n) || a.key.localeCompare(b.key)));
    res.groupLeftOut = g.leftOut;
  }
  if (plan.asCustomers) {
    const seen = new Map();
    for (const r of pos) if (r.custId && !seen.has(r.custId)) seen.set(r.custId, snap.custById.get(r.custId));
    res.customers = [...seen.values()].filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.noCustomer = pos.filter((r) => !r.custId).length;
  }
  if (!pos.length && plan.docType) {
    const sel2 = selectOnly(plan, x, { docType: null, visit: false });
    if (!sel2.abstain) {
      const counts = new Map();
      for (const r of sel2.rows) {
        let hit = false;
        if (isLines) { for (const l of linesOf(snap).get(r.id) ?? []) { const sn = ix.lineSn.get(l.id); if (sn && matchSnippet(sn, term) === 'pos') hit = true; } } else hit = matchAny(ix.byDoc.get(r.id), term).m === 'pos';
        if (hit) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
      }
      res.others = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }
  }
  return res;
}

/* ---- cost_breakdown */
const lineKind = (desc) => { const w = /^[A-Za-z]+/.exec(String(desc ?? '').trim()); return w && w[0].length >= 3 && /^[A-Za-z]+(?:[\s,:(]|$)/.test(String(desc).trim()) ? cap1(w[0].toLowerCase()) : 'Other'; };
function execBreakdown(plan, x) {
  const { snap } = x;
  const sel = selectOnly(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  const groups = new Map(); let noAmt = 0; let lines = 0;
  for (const r of sel.rows) {
    for (const l of linesOf(snap).get(r.id) ?? []) {
      lines++;
      if (l.amount == null) { noAmt++; continue; }
      const k = lineKind(l.description);
      const g = groups.get(k) ?? { key: k, sum: 0, n: 0, rows: new Set() };
      g.sum += l.amount; g.n++; g.rows.add(r);
      groups.set(k, g);
    }
  }
  let out = [...groups.values()];
  if (plan.only?.length) {
    const wanted = plan.only.map((s) => stem(s));
    out = out.filter((g) => wanted.some((w) => stemEq(stem(g.key.toLowerCase()), w)));
    const missing = wanted.filter((w) => !out.some((g) => stemEq(stem(g.key.toLowerCase()), w)));
    if (missing.length) return { abstain: 'group-not-found' };
  }
  out.sort((a, b) => b.sum - a.sum || a.key.localeCompare(b.key));
  return { groups: out.map((g) => ({ ...g, rows: [...g.rows] })), lines, noAmt, docs: sel.rows.length, leftOut: sel.leftOut ?? 0 };
}

/* ---- duplicates */
const digits = (s) => String(s ?? '').replace(/\D/g, '');
function groupDups(items, keyFn) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); if (k == null || k === '') continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return { all: m, dup: [...m.entries()].filter(([, v]) => v.length > 1) };
}
function execDuplicates(plan, x) {
  const { snap } = x;
  const k = plan.key;
  const out = { key: k };
  if (k.kind === 'file') return { ...out, structural: true };
  if (k.kind === 'namedPair') {
    const want = lc(k.name).replace(/\s+/g, ' ');
    const same = snap.customers.filter((c) => { const n = lc(c.name).replace(/\s+/g, ' '); return n === want || `${n}s` === want || `${n}es` === want; });
    if (!same.length) return { abstain: 'name-not-on-file' };
    return { ...out, ent: 'customer', pair: same, checked: snap.customers.length, groups: same.length > 1 ? [{ key: want, rows: same }] : [] };
  }
  if (k.kind === 'customerName' || k.kind === 'customerField' || k.kind === 'unitSerial') {
    const ent = plan.entity;
    const sel = selectOnly(plan, x);
    if (sel.abstain && sel.abstain !== 'ambiguous-name') return { abstain: sel.abstain };
    let rows = ent === 'customer' ? snap.customers : sel.rows;
    if (ent === 'unit') rows = sel.rows ?? snap.units;
    const keyFn = k.kind === 'customerName' ? (c) => lc(c.name).replace(/\s+/g, ' ') : k.kind === 'unitSerial' ? (u) => lc(u.serial) : k.field === 'phone' ? (c) => (digits(c.phone).length >= 7 ? digits(c.phone).slice(-10) : null) : k.field === 'email' ? (c) => lc(c.email) : (c) => lc(c.address);
    const g = groupDups(rows, keyFn);
    let dups = g.dup;
    if (plan.named) dups = dups.filter(([, v]) => lc(v[0].name) === lc(plan.named));
    return { ...out, ent, checked: [...g.all.values()].reduce((a, v) => a + v.length, 0), groups: dups.map(([key, v]) => ({ key, rows: v })) };
  }
  const sel = selectOnly(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  const rows = sel.rows;
  if (k.kind === 'docnum') {
    const withNum = rows.filter((d) => docNumber(d, snap, k.field) != null);
    const g = groupDups(withNum, (d) => lc(docNumber(d, snap, k.field)));
    return { ...out, ent: 'document', total: rows.length, checked: withNum.length, groups: g.dup.map(([key, v]) => ({ key, rows: v })) };
  }
  if (k.kind === 'docSerial') {
    const withS = rows.filter((d) => d.serial);
    const g = groupDups(withS, (d) => lc(d.serial));
    return { ...out, ent: 'document', total: rows.length, checked: withS.length, groups: g.dup.map(([key, v]) => ({ key, rows: v })) };
  }
  if (k.kind === 'invoiceAmount') {
    const withT = rows.filter((d) => d.custId && d.total != null);
    const jobOf = (d) => finOf(snap).get(d.id)?.job_key ?? '';
    const g = groupDups(withT, (d) => `${d.custId}|${d.total}${k.job ? `|${jobOf(d)}` : ''}`);
    return { ...out, ent: 'document', total: rows.length, checked: withT.length, groups: g.dup.map(([key, v]) => ({ key: `${v[0].custName} ${fmtMoney(v[0].total)}`, rows: v })) };
  }
  if (k.kind === 'visitDay') {
    const withV = rows.filter((d) => d.serviceDate && d.custId);
    const g = groupDups(withV, (d) => `${d.custId}|${d.serviceDate}`);
    return { ...out, ent: 'document', total: rows.length, checked: withV.length, groups: g.dup.map(([key, v]) => ({ key: `${v[0].custName} ${fmtDate(v[0].serviceDate)}`, rows: v })) };
  }
  return { abstain: 'dup-kind' };
}

/* ---- missing_field */
const DOC_GET = {
  custLink: (d) => (d.custIds?.length ? 'x' : null), customer: (d) => (d.custIds?.length ? 'x' : null),
  // the name printed on a billed paper is its own field; a paper with no financial record is named by the customer it is linked to
  custName: (d, s) => { const f = finOf(s).get(d.id); return f ? (f.customer_name ?? null) : (d.custIds?.length ? 'x' : null); },
  serviceDate: (d) => d.serviceDate, invoiceDate: (d) => d.invoiceDate, installDate: (d) => (d.f.installation_date ?? null), date: (d) => d.date,
  total: (d) => d.total, tech: (d) => d.tech, serial: (d) => d.serial, model: (d) => d.model, brand: (d) => d.brand, vendor: (d) => d.vendor, hours: (d) => d.hours,
  tonnage: (d, s) => ENTITIES.document.fields.tonnage.get(d, s), refrigerant: (d, s) => ENTITIES.document.fields.refrigerant.get(d, s), status: (d) => d.status, serviceType: (d) => d.serviceType,
  workPerformed: (d) => d.f.work_performed ?? null, notes: (d) => d.f.notes ?? null, details: (d) => (Object.keys(d.f ?? {}).length ? 'x' : null),
};
const CUST_GET = {
  phone: (c) => c.phone, email: (c) => c.email, address: (c) => c.address,
};
const UNIT_GET = {
  serial: (u) => u.serial, model: (u) => u.model, brand: (u) => u.brand, tonnage: (u) => u.tonnage, refrigerant: (u) => u.refrigerant, installDate: (u) => u.installDate ?? (u.installYear ? String(u.installYear) : null),
  registeredDate: (u) => u.registeredDate, warrantyExpires: (u) => u.warrantyExpires, customer: (u) => u.custId, equipmentType: (u) => u.type,
  custAddress: (u, s) => s.custById.get(u.custId)?.address ?? null,
};
function getField(plan, id, row, snap) {
  if (id.startsWith('num:')) return docNumber(row, snap, id.slice(4));
  const g = plan.entity === 'document' ? DOC_GET[id] : plan.entity === 'customer' ? CUST_GET[id] : UNIT_GET[id];
  return g ? g(row, snap) : undefined;
}
function execMissing(plan, x) {
  const { snap } = x;
  const sel = selectOnly(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  for (const f of plan.fields) if (getField(plan, f.id, sel.rows[0] ?? (plan.entity === 'document' ? snap.documents[0] : plan.entity === 'customer' ? snap.customers[0] : snap.units[0]), snap) === undefined && (sel.rows[0] ?? true)) return { abstain: 'field' };
  const isMissing = (row, f) => { const v = getField(plan, f.id, row, snap); return v == null || v === ''; };
  const hit = sel.rows.filter((r) => (plan.mode === 'all' ? plan.fields.every((f) => isMissing(r, f)) : plan.fields.some((f) => isMissing(r, f))));
  const res = { rows: hit, total: sel.rows.length, leftOut: sel.leftOut ?? 0 };
  // a document's date is its service date, else its invoice date, else its upload date: papers with no date printed on them are reported beside the answer
  if (plan.entity === 'document' && plan.fields.some((f) => f.id === 'date')) res.paperUndated = sel.rows.filter((r) => !r.serviceDate && !r.invoiceDate).length;
  return res;
}

/* ---- find_document */
const wordTokens = (v) => tokenizeText(v);
function execFind(plan, x) {
  const { snap } = x;
  const docs = snap.documents.filter((d) => !plan.docType || d.type === plan.docType);
  if (plan.docType && !snap.documents.some((d) => d.type === plan.docType)) return { abstain: 'type-not-on-file' };
  const byNumber = () => {
    const code = lc(plan.code);
    return snap.documents.filter((d) => [docNumber(d, snap, 'invoice_number'), docNumber(d, snap, 'po_number'), docNumber(d, snap, 'permit_number')].some((v) => v != null && lc(v) === code));
  };
  const bySerial = () => {
    const code = lc(plan.code);
    const known = snap.units.some((u) => lc(u.serial) === code) || snap.documents.some((d) => lc(d.serial) === code);
    const hit = docs.filter((d) => lc(d.serial) === code || Object.values(d.f ?? {}).some((v) => typeof v === 'string' && wordTokens(v).includes(code)));
    return { hit, known };
  };
  if (plan.by === 'filename') {
    const ix = textIndex(snap);
    const ws = [];
    for (const w of plan.words) { const r = ix.fileWords.has(w) ? { w } : resolveWord(w, ix); if (!r || !ix.fileWords.has(r.w)) return { abstain: 'filename-word' }; ws.push(r.w); }
    const hit = docs.filter((d) => { const fw = new Set(tokenizeText(d.filename ?? '')); return ws.every((w) => fw.has(w)); });
    if (!hit.length || hit.length > 5) return { abstain: hit.length ? 'too-many' : 'no-file' };
    return { kind: 'filename', rows: hit, words: ws };
  }
  if (plan.by === 'total') return { kind: 'total', rows: docs.filter((d) => d.total != null && Math.abs(d.total - plan.amount) < 0.005), amount: plan.amount };
  if (plan.by === 'number') return { kind: 'number', rows: byNumber(), code: plan.code };
  if (plan.by === 'code') {
    const n = byNumber();
    if (n.length || plan.hyphen) return { kind: 'number', rows: n, code: plan.code };
    const { hit, known } = bySerial();
    if (!known && !hit.length) return { abstain: 'unknown-code' };
    return { kind: 'serial', rows: hit, code: plan.code };
  }
  if (plan.by === 'serial') {
    const { hit, known } = bySerial();
    if (!known && !hit.length && !plan.code) return { abstain: 'unknown-code' };
    return { kind: 'serial', rows: hit, code: plan.code };
  }
  return { abstain: 'find-kind' };
}


/* ---- future_dates, completeness, field_text */
function execFuture(plan, x) {
  const { snap, today } = x;
  const docs = snap.documents.filter((d) => !plan.docType || d.type === plan.docType);
  if (plan.docType && !docs.length) return { abstain: 'type-not-on-file' };
  const dated = docs.filter((d) => d.date);
  const futureDocs = dated.filter((d) => d.date > today);
  const units = plan.docType ? [] : snap.units.filter((u) => u.installDate);
  const futureUnits = units.filter((u) => u.installDate > today);
  return { today, docsChecked: dated.length, units: units.length, futureDocs, futureUnits, scope: docs.length };
}
function execComplete(plan, x) {
  const { snap } = x;
  const rows = plan.entity === 'unit' ? snap.units : snap.customers;
  const get = plan.entity === 'unit' ? UNIT_GET : CUST_GET;
  if (!rows.length) return { abstain: 'no-rows' };
  const counts = plan.fields.map((f) => ({ ...f, missing: rows.filter((r) => { const v = get[f.id](r, snap); return v == null || v === ''; }).length }));
  return { total: rows.length, counts };
}
function execFieldText(plan, x) {
  const { snap } = x;
  const sel = selectOnly(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  const get = plan.entity === 'unit' ? UNIT_GET[plan.field] : CUST_GET[plan.field];
  const v = lc(plan.value);
  const norm = (a) => lc(a).replace(plan.field === 'phone' ? /\D/g : /\s+/g, '');
  const word = new RegExp(`(?<![a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
  const hit = sel.rows.filter((r) => { const a = get(r, snap); if (a == null || a === '') return false; if (plan.how === 'contains') return word.test(String(a)); const n = norm(a); const w = norm(v); return plan.how === 'prefix' ? n.startsWith(w) : n.endsWith(w); });
  // a text pattern that matches many rows ("phone numbers starting with 480") is not a list worth reading out in a sentence, and a cut-off list reads as a short one: past ten rows the list is released (the count form is answered)
  if (plan.show === 'list' && hit.length > 10) return { abstain: 'long-list' };
  return { rows: hit, total: sel.rows.length, withValue: sel.rows.filter((r) => { const a = get(r, snap); return a != null && a !== ''; }).length };
}

function execReverse(plan, x) {
  const { snap } = x;
  const key = (c) => (plan.field === 'email' ? lc(c.email) : String(c.phone ?? '').replace(/\D/g, '').slice(-10));
  const rows = snap.customers.filter((c) => key(c) === plan.value);
  return { rows, checked: snap.customers.filter((c) => key(c)).length };
}

/* ---- field_conflict */
const brandKeyOf = (b) => ENTITIES.unit.fields.brand.key(b);
function execConflict(plan, x) {
  const { snap } = x;
  if (plan.kind === 'serialBrands') {
    const m = new Map();
    const add = (serial, brand, ref) => { if (!serial || !brand) return; const k = lc(serial); if (!m.has(k)) m.set(k, new Map()); const bk = brandKeyOf(brand); if (!m.get(k).has(bk)) m.get(k).set(bk, []); m.get(k).get(bk).push(ref); };
    for (const u of snap.units) add(u.serial, u.brand, u);
    for (const d of snap.documents) add(d.f.serial_number, d.f.manufacturer, d);
    const hits = [...m.entries()].filter(([, v]) => v.size > 1);
    return { serials: m.size, hits: hits.map(([serial, v]) => ({ serial, brands: [...v.keys()], rows: [...v.values()].flat() })) };
  }
  if (plan.kind === 'docVsUnit') {
    const sel = selectOnly(plan, x);
    if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
    const dv = (d) => ({ model: d.f.model, brand: d.f.manufacturer, serial: d.f.serial_number, installDate: d.f.installation_date, tonnage: d.f.tonnage, refrigerant: d.f.refrigerant })[plan.field];
    const uv = (u) => ({ model: u.model, brand: u.brand, serial: u.serial, installDate: u.installDate, tonnage: u.tonnage, refrigerant: u.refrigerant })[plan.field];
    const norm = (v) => (plan.field === 'brand' ? lc(brandKeyOf(v)) : lc(v).replace(/[^a-z0-9]/g, ''));
    const comparable = []; const diff = [];
    for (const d of sel.rows) {
      const u = unitOfDoc(d, snap);
      const a = dv(d); const b = u ? uv(u) : null;
      if (a == null || b == null || a === '' || b === '') continue;
      comparable.push(d);
      if (plan.field === 'installDate') { if (String(a).slice(0, 10) !== String(b).slice(0, 10)) diff.push(d); } else if (norm(a) !== norm(b)) diff.push(d);
    }
    if (!comparable.length) return { abstain: 'nothing-to-compare' };
    return { rows: diff, comparable: comparable.length, total: sel.rows.length };
  }
  return { abstain: 'conflict-kind' };
}

function exec(plan, x) {
  switch (plan.op) {
    case 'text_search': case 'line_search': return execText(plan, x);
    case 'cost_breakdown': return execBreakdown(plan, x);
    case 'duplicates': return execDuplicates(plan, x);
    case 'missing_field': return execMissing(plan, x);
    case 'find_document': return execFind(plan, x);
    case 'field_conflict': return execConflict(plan, x);
    case 'future_dates': return execFuture(plan, x);
    case 'completeness': return execComplete(plan, x);
    case 'field_text': return execFieldText(plan, x);
    case 'reverse_lookup': return execReverse(plan, x);
    default: return { abstain: 'op' };
  }
}

/* ====================================================================== the answer */

const listNames = (arr, cap = 30) => (arr.length > cap ? `${arr.slice(0, cap).join(', ')}, and ${fmtInt(arr.length - cap)} more` : arr.join(', '));
const numOf = (d, snap) => d.f.invoice_number ?? finOf(snap).get(d.id)?.invoice_number ?? d.f.po_number ?? finOf(snap).get(d.id)?.po_number ?? d.f.permit_number ?? null;
function docLabel(d, snap, withCust = true, detail = 2) {
  const num = numOf(d, snap);
  const id = num ?? d.filename ?? documentTypeLabel(d.type);
  if (detail <= 0) return id;
  const bits = [withCust ? d.custName : null, detail >= 2 && d.date ? fmtDate(d.date) : null, detail >= 2 && d.total != null ? fmtMoney(d.total) : null].filter(Boolean);
  return bits.length ? `${id} (${bits.join(', ')})` : id;
}
/** A short list shows each paper in full; a longer one stays readable (the paper's own number or file name, and whose it is up to a dozen). */
const detailFor = (n) => (n <= 5 ? 2 : n <= 12 ? 1 : 0);
const docRecords = (rows, snap, max = 200) => rows.slice(0, max).map((r) => recordFor({ entity: 'document' }, r, snap));
const termText = (term) => `"${term.display}"`;
const repairNote = (term) => (term.repairs?.length ? `Read ${term.repairs.map(([a, b]) => `"${a}" as "${b}"`).join(' and ')}.` : '');
const DOC_ONLY = 'internal-only papers and HR letters are left out';

const pos0 = (res) => res.rows.length > 0;
function sayText(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const isLines = plan.op === 'line_search';
  const n = res.n;
  const cond = condText(plan);
  const lineNoun = (k) => `${plan.docType ? `${nounOf(plan, 1)} ` : ''}line item${k === 1 ? '' : 's'}`;
  const noun = (k) => (plan.asCustomers ? (k === 1 ? 'customer' : 'customers') : isLines && plan.countLines ? lineNoun(k) : nounOf(plan, k));
  const docNoun = (k) => nounOf(plan, k);
  const tm = termText(res.term);
  const zn = plan.scopeNoun ?? (isLines && plan.countLines ? lineNoun(2) : docNoun(2));
  const verb = (k) => (k === 1 ? 'mentions' : 'mention');
  const negN = res.neg.length;
  const negNote = negN ? `${fmtInt(negN)} ${docNoun(negN)} ${negN === 1 ? 'says' : 'say'} it only in a negated form (for example "${res.negEx[0]}") and ${negN === 1 ? 'is' : 'are'} not counted.` : '';
  const othersNote = res.others?.length ? `${listNames(res.others.map(([t, c]) => `${fmtInt(c)} ${nounOf({ entity: 'document', docType: t, docWord: null }, c)}`))} ${res.others.length === 1 && res.others[0][1] === 1 ? 'does' : 'do'}.` : '';
  const countRows = isLines && plan.countLines ? res.posLines.length : n;
  const where = isLines ? 'invoice line items' : 'the work performed and notes';
  const scopeBasis = isLines
    ? `Searched the description of every ${plan.docType ? `${nounOf(plan, 1)} ` : ''}line item on file for ${tm} (plural, past-tense and -ing forms count).`
    : `Searched the work performed, notes and invoice line items recorded on every ${plan.visit ? 'service visit' : plan.docType ? nounOf(plan, 1) : 'document'} on file for ${tm} (plural, past-tense and -ing forms count; the full text of scanned pages was not searched).`;
  const bits = [scopeBasis];
  if (plan.filters?.length) bits.push(`Conditions: ${condText(plan).trim()}.`);
  if (negN) bits.push('Negated mentions ("no leaks found") were left out.');
  if (res.leftOut) bits.push(`${fmtInt(res.leftOut)} ${docNoun(res.leftOut)} with no date on file were not counted.`);
  if (plan.docType === 'invoice' || !plan.docType) bits.push(`${cap1(DOC_ONLY)}.`);
  const rep = repairNote(res.term); if (rep) bits.push(rep);
  out.basis = bits.join(' ');

  if (plan.show === 'sum' && plan.sumDocs) {
    if (!pos0(res)) { out.text = `No ${docNoun(2)}${cond} have a line mentioning ${tm}, so there is nothing to add up.${negN ? ` ${negNote}` : ''}`; out.total = 0; return out; }
    out.text = `${fmtMoney(res.sum)} across ${fmtInt(res.sumN)} ${docNoun(res.sumN)}${cond} with a line mentioning ${tm}.${res.noAmount ? ` ${fmtInt(res.noAmount)} ${docNoun(res.noAmount)} ${res.noAmount === 1 ? 'has' : 'have'} no total on file and ${res.noAmount === 1 ? 'was' : 'were'} left out.` : ''}`;
    out.facts = [{ label: `${cap1(docNoun(2))} with ${res.term.display}`, value: fmtMoney(res.sum) }];
    out.records = docRecords(res.rows, snap); out.total = res.rows.length;
    out.basis += ' The total adds up the printed total of each of those papers.';
    return out;
  }
  if (plan.show === 'sum') {
    if (!res.posLines.length) { out.text = `No ${lineNoun(2)}${cond} mention ${tm}, so there is nothing to add up.${negN ? ` ${negNote}` : ''}`; out.total = 0; return out; }
    out.text = `${fmtMoney(res.sum)} across ${fmtInt(res.sumN)} ${lineNoun(res.sumN)}${cond} mentioning ${tm} (${fmtInt(n)} ${docNoun(n)}).${res.noAmount ? ` ${fmtInt(res.noAmount)} line${res.noAmount === 1 ? ' has' : 's have'} no amount on file and ${res.noAmount === 1 ? 'was' : 'were'} left out.` : ''}`;
    out.facts = [{ label: `Billed for ${res.term.display}`, value: fmtMoney(res.sum) }];
    out.records = docRecords(res.rows, snap); out.total = res.rows.length;
    out.basis += ' The total adds up the line amounts as printed.';
    return out;
  }
  if (plan.show === 'customers') {
    const cs = res.customers;
    if (!cs.length) { out.text = `No customers${cond} have ${isLines ? 'a line item' : 'a paper'} mentioning ${tm}.${negN ? ` ${negNote}` : ''}`; out.total = 0; return out; }
    out.text = `${fmtInt(cs.length)} customer${cs.length === 1 ? '' : 's'} ${cs.length === 1 ? 'has' : 'have'} ${isLines ? 'a line item' : 'a paper'} mentioning ${tm}${cond}: ${listNames(cs.map((c) => c.name))}.${res.noCustomer ? ` ${fmtInt(res.noCustomer)} matching paper${res.noCustomer === 1 ? ' is' : 's are'} not linked to a customer.` : ''}`;
    out.facts = [{ label: 'Customers', value: fmtInt(cs.length) }];
    out.records = cs.slice(0, 200).map((c) => recordFor({ entity: 'customer' }, c, snap)); out.total = cs.length; out.claimedCount = cs.length;
    return out;
  }
  if (!n) {
    const none = `No ${plan.scopeNoun ?? (isLines && plan.countLines ? lineNoun(2) : docNoun(2))}${cond} mention ${tm}.`;
    out.text = `${none}${negN ? ` ${negNote}` : ''}${res.others?.length ? ` ${cap1(othersNote)}` : ''}`;
    out.facts = [{ label: cap1(docNoun(2)), value: '0' }]; out.total = 0; out.claimedCount = 0;
    return out;
  }
  const records = docRecords(res.rows, snap);
  if (plan.groupBy?.length) {
    const lines = res.groups.map((g) => `${plan.groupBy[0].by === 'month' ? g.key : g.key} ${fmtInt(g.n)}`);
    out.text = `${fmtInt(n)} ${docNoun(n)}${cond} ${verb(n)} ${tm}, by ${plan.groupBy[0].by === 'monthOfYear' ? 'month of the year' : plan.groupBy[0].by}: ${listNames(lines)}.`;
    out.facts = res.groups.length <= 7 ? res.groups.map((g) => ({ label: g.key, value: fmtInt(g.n) })) : [{ label: cap1(docNoun(2)), value: fmtInt(n) }];
  } else if (plan.show === 'count') {
    out.text = `${fmtInt(countRows)} ${noun(countRows)}${cond} ${verb(countRows)} ${tm}${isLines && plan.countLines && countRows !== n ? ` (on ${fmtInt(n)} ${docNoun(n)})` : ''}.`;
    out.facts = [{ label: cap1(noun(2)), value: fmtInt(countRows) }];
  } else if (plan.show === 'exists') {
    out.text = `Yes, ${fmtInt(countRows)} ${noun(countRows)}${cond} ${verb(countRows)} ${tm}.`;
    out.facts = [{ label: cap1(noun(2)), value: fmtInt(countRows) }];
  } else {
    const names = res.rows.map((r) => docLabel(r, snap, !(plan.filters ?? []).some((f) => f.field === 'customer'), detailFor(res.rows.length)));
    out.text = isLines ? `${fmtInt(n)} ${docNoun(n)}${cond} ${n === 1 ? 'has' : 'have'} a line item mentioning ${tm}: ${listNames(names)}.` : `${fmtInt(n)} ${docNoun(n)}${cond} ${verb(n)} ${tm}: ${listNames(names)}.`;
    out.facts = res.rows.length <= 7 ? res.rows.map((r) => ({ label: cap1(docNoun(1)), value: docLabel(r, snap) })) : [{ label: cap1(docNoun(2)), value: fmtInt(n) }];
  }
  if (negN) out.text += ` ${negNote}`;
  out.records = records; out.total = n; out.claimedCount = n;
  return out;
}

function sayBreakdown(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const cond = condText(plan);
  const gs = res.groups;
  if (!gs.length) { out.text = `No ${plan.docType ? `${nounOf(plan, 1)} ` : ''}line items${cond} with an amount are on file.`; out.basis = 'Grouped the line items on file by the first word of their description.'; return out; }
  const total = gs.reduce((a, g) => a + g.sum, 0);
  const lines = gs.map((g) => `${g.key} ${fmtMoney(g.sum)} (${fmtInt(g.n)} line${g.n === 1 ? '' : 's'})`);
  const what = plan.docType ? `${cap1(nounOf(plan, 1))} line items` : 'Line items';
  out.text = `${what}${cond} by kind of work, ${fmtMoney(total)} in all: ${lines.join('; ')}.`;
  out.facts = gs.slice(0, 7).map((g) => ({ label: g.key, value: fmtMoney(g.sum) }));
  out.records = docRecords([...new Set(gs.flatMap((g) => g.rows))], snap); out.total = out.records.length;
  out.basis = `Added up the line amounts of every ${plan.docType ? nounOf(plan, 1) : 'paper with line items'} on file, grouped by the first word of each line's description${res.noAmt ? `; ${fmtInt(res.noAmt)} line${res.noAmt === 1 ? '' : 's'} with no amount ${res.noAmt === 1 ? 'was' : 'were'} left out` : ''}${plan.only?.length ? `; only ${plan.only.join(' and ')} shown` : ''}.`;
  return out;
}

function sayDuplicates(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const k = plan.key;
  const lab = plan.keyLabel;
  if (res.structural) {
    out.text = 'No duplicates: a file with the same content as one already on file is recognized when it is uploaded and filed only once, so no two documents are copies of the same file.';
    out.basis = 'Every document is filed once per file content, so repeated uploads of the same file cannot appear as separate documents.';
    return out;
  }
  const g = res.groups;
  const entN = res.ent === 'customer' ? 'customer' : res.ent === 'unit' ? 'unit' : nounOf(plan, 2).replace(/s$/, '');
  const nounPl = res.ent === 'customer' ? 'customers' : res.ent === 'unit' ? 'units' : nounOf(plan, 2);
  const checkedBits = res.ent === 'document' ? `${fmtInt(res.checked)} of ${fmtInt(res.total)} ${nounPl}${condText(plan)} carry ${aOrAn(lab)}` : `${fmtInt(res.checked)} ${nounPl}${condText(plan)} carry ${aOrAn(lab)}`;
  if (!g.length) {
    if (k.kind === 'docnum' && !res.checked) { out.text = `No repeats: none of the ${fmtInt(res.total)} ${nounPl}${condText(plan)} carries ${aOrAn(lab)} of its own, so there is nothing to repeat.`; }
    else if (k.kind === 'unitSerial' && res.checked) out.text = `No repeats: ${fmtInt(res.checked)} distinct serials across ${fmtInt(res.checked)} ${nounPl}${condText(plan)}.`;
    else out.text = `No repeats: no two ${nounPl}${condText(plan)} share the same ${k.kind === 'invoiceAmount' ? `customer${k.job ? ', job site' : ''} and amount` : k.kind === 'visitDay' ? 'customer and visit day' : lab}; ${checkedBits}.`;
    out.basis = `Compared ${k.kind === 'invoiceAmount' ? `the customer${k.job ? ', job site' : ''} and total` : k.kind === 'visitDay' ? 'the customer and service date' : `the ${lab}${k.kind === 'customerField' && k.field === 'phone' ? ' (digits only)' : ''}`} of ${res.ent === 'document' ? `every ${nounOf(plan, 1)} on file` : `every ${res.ent} on file`} against all the others; a match needs the same value on two or more. ${res.ent === 'document' ? cap1(DOC_ONLY) + '.' : ''}`.trim();
    out.facts = []; out.claimedCount = 0; // an empty list carries no facts (the sentence says none repeat)
    return out;
  }
  const detail = g.map((gr) => {
    const rows = gr.rows;
    const names = res.ent === 'customer' ? rows.map((r) => r.name ?? 'Unnamed').join(', ') : res.ent === 'unit' ? rows.map((r) => r.serial).join(', ') : rows.map((r) => docLabel(r, snap, false)).join(', ');
    const shown = k.kind === 'customerField' || k.kind === 'customerName' ? (k.kind === 'customerName' ? rows[0].name : k.field === 'phone' ? rows[0].phone : k.field === 'email' ? rows[0].email : rows[0].address) : k.kind === 'unitSerial' ? rows[0].serial : gr.key;
    return `${shown} (${rows.length}: ${names})`;
  });
  const rowsAll = g.flatMap((gr) => gr.rows);
  const what = k.kind === 'customerName' ? 'customer names' : k.kind === 'customerField' ? `${lab}s` : k.kind === 'invoiceAmount' ? 'sets of invoices with the same customer' + (k.job ? ', job site' : '') + ' and amount' : k.kind === 'visitDay' ? 'customers with more than one visit on the same day' : `${lab}s`;
  if (plan.show === 'count' && k.kind === 'visitDay') {
    const custs = new Set(rowsAll.map((r) => r.custId));
    out.text = `${fmtInt(custs.size)} customer${custs.size === 1 ? ' has' : 's have'} more than one visit on the same day (${fmtInt(g.length)} such days).`;
  } else if (k.kind === 'namedPair') {
    out.text = `Yes. ${fmtInt(g[0].rows.length)} customers are named ${g[0].rows[0].name}: ${listNames(g[0].rows.map((r) => `${r.name}${r.number ? ` (${r.number})` : ''}${r.address ? `, ${r.address}` : ''}`))}.`;
  } else if (k.kind === 'visitDay') {
    const custs = new Set(rowsAll.map((r) => r.custId));
    out.text = `${fmtInt(custs.size)} customer${custs.size === 1 ? ' has' : 's have'} more than one visit on the same day: ${listNames(detail, 12)}.`;
  } else if (k.kind === 'customerName') {
    out.text = `Yes. ${fmtInt(g.length)} customer name${g.length === 1 ? ' appears' : 's appear'} on more than one customer record: ${listNames(detail, 15)}.`;
  } else {
    out.text = `${plan.show === 'exists' ? 'Yes. ' : ''}${fmtInt(g.length)} ${g.length === 1 ? what.replace(/s\b/, '') : what} ${g.length === 1 ? 'is' : 'are'} shared by more than one ${res.ent === 'document' ? nounOf(plan, 1) : res.ent}: ${listNames(detail, 15)}.`;
  }
  out.facts = [{ label: 'Repeated', value: fmtInt(g.length) }];
  out.records = res.ent === 'customer' ? rowsAll.slice(0, 200).map((c) => recordFor({ entity: 'customer' }, c, snap)) : res.ent === 'unit' ? rowsAll.slice(0, 200).map((c) => recordFor({ entity: 'unit' }, c, snap)) : docRecords(rowsAll, snap);
  out.total = rowsAll.length; out.claimedCount = null;
  out.basis = `Compared the ${k.kind === 'invoiceAmount' ? `customer${k.job ? ', job site' : ''} and total` : k.kind === 'visitDay' ? 'customer and service date' : lab}${k.kind === 'customerField' && k.field === 'phone' ? ' (digits only)' : ''} of ${res.ent === 'document' ? `every ${nounOf(plan, 1)} on file` : `every ${res.ent} on file`} against all the others (${checkedBits}). ${res.ent === 'document' ? cap1(DOC_ONLY) + '.' : ''}`.trim();
  return out;
}

const hasNo = (labels, mode) => (mode === 'all' ? `no ${labels.join(' and no ')}` : `no ${labels.join(', or no ')}`);
function sayMissing(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const cond = condText(plan);
  const nn = plan.entity === 'customer' ? (k) => (k === 1 ? 'customer' : 'customers') : plan.entity === 'unit' ? (k) => (k === 1 ? 'unit' : 'units') : (k) => nounOf(plan, k);
  const labels = plan.fields.map((f) => f.label);
  const n = res.rows.length;
  const rec = (rows) => (plan.entity === 'document' ? docRecords(rows, snap) : rows.slice(0, 200).map((r) => recordFor({ entity: plan.entity }, r, snap)));
  const nameOf = (r) => (plan.entity === 'customer' ? r.name ?? 'Unnamed customer' : plan.entity === 'unit' ? (res.rows.length > 12 && r.serial ? r.serial : [r.serial, r.brand, r.model].filter(Boolean).join(' ') || 'unit') : docLabel(r, snap, !plan.filters?.some((f) => f.field === 'customer') && !plan.fields.some((f) => f.id === 'custName'), detailFor(res.rows.length)));
  const scope = `every ${plan.entity === 'document' ? (plan.visit ? 'service visit' : plan.docType ? nounOf(plan, 1) : 'document') : plan.entity} on file`;
  const bits = [`Checked ${scope}${plan.filters?.length || plan.time ? `: ${condText(plan).trim()}` : ''} for ${plan.mode === 'all' ? 'all of' : 'any of'} ${labels.join(', ')} being blank.`];
  if (plan.fields.some((f) => f.id === 'custName')) bits.push('A customer name is the one printed on the billed paper; a paper without a billing record counts as named when it is linked to a customer.');
  if (plan.fields.some((f) => f.id === 'date')) bits.push('A document\'s date is its service date, else its invoice date, else the day it was uploaded.');
  if (plan.fields.some((f) => f.id === 'warrantyExpires')) bits.push('A warranty end date appears only where the brand\'s warranty term is known.');
  if (plan.entity === 'document') bits.push(`${cap1(DOC_ONLY)}.`);
  if (res.leftOut) bits.push(`${fmtInt(res.leftOut)} ${nn(res.leftOut)} with no date on file were not counted.`);
  out.basis = bits.join(' ');
  if (!res.total) { out.text = `No ${nn(2)}${cond} are on file.`; out.facts = [{ label: cap1(nn(2)), value: '0' }]; out.claimedCount = 0; return out; }
  const tail = res.paperUndated ? ` ${fmtInt(res.paperUndated)} of the ${fmtInt(res.total)} carry no service or invoice date on the paper itself and are dated by when they were uploaded.` : '';
  if (!n) {
    out.text = `None of ${res.total === 1 ? 'the one' : `the ${fmtInt(res.total)}`} ${nn(res.total)}${cond} ${plan.mode === 'all' ? `lack ${labels.length > 1 ? 'both ' : ''}${labels.map(aOrAn).join(' and ')}` : `${res.total === 1 ? 'is' : 'are'} missing ${labels.map(aOrAn).join(' or ')}`}.${tail}`;
    out.facts = [{ label: cap1(nn(2)), value: '0' }]; out.claimedCount = 0;
    return out;
  }
  const lead = `${fmtInt(n)} ${nn(n)}${cond} ${n === 1 ? 'has' : 'have'} ${hasNo(labels, plan.mode)} on file`;
  if (plan.show === 'count') { out.text = `${lead} (of ${fmtInt(res.total)}).${tail}`; out.facts = [{ label: cap1(nn(2)), value: fmtInt(n) }]; }
  else if (plan.show === 'exists') { out.text = `Yes. ${lead} (of ${fmtInt(res.total)}).${tail}`; out.facts = [{ label: cap1(nn(2)), value: fmtInt(n) }]; }
  else { out.text = `${lead}: ${listNames(res.rows.map(nameOf))}.${tail}`; out.facts = n <= 7 ? res.rows.map((r) => ({ label: cap1(nn(1)), value: nameOf(r) })) : [{ label: cap1(nn(2)), value: fmtInt(n) }]; }
  out.records = rec(res.rows); out.total = n; out.claimedCount = n;
  return out;
}

const ASK_VAL = { hours: (r) => (r.hours != null ? `${r.hours}` : null), total: (r) => (r.total != null ? fmtMoney(r.total) : null), tech: (r) => r.tech, vendor: (r) => r.vendor, status: (r) => r.status, customer: (r) => r.custName, serviceDate: (r) => (r.serviceDate ? fmtDate(r.serviceDate) : null), invoiceDate: (r) => (r.invoiceDate ? fmtDate(r.invoiceDate) : null), date: (r) => (r.date ? fmtDate(r.date) : null), work: (r) => r.f.work_performed ?? null };
function sayFind(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const rows = res.rows;
  const typed = plan.docType ? nounOf(plan, 2) : 'documents';
  const kind = res.kind ?? plan.by;
  if (kind === 'number') {
    if (!rows.length) { out.text = `${plan.code.toUpperCase()} was not found: no ${plan.docType ? nounOf(plan, 1) : 'document'} with that number is on file.`; out.basis = 'Looked for that number among the invoice, purchase order and permit numbers of every document on file.'; return out; }
    if (rows.length > 1) {
      // one number printed on several papers: show every one of them, each with who it is for, when and the amount (and the asked fields)
      const each = rows.map((r) => {
        const asked = (plan.ask ?? []).map((a) => { const v = ASK_VAL[a.id]?.(r); return v == null ? `no ${a.label} on file` : `${a.label} ${v}`; });
        const bits = plan.ask?.length ? asked : [r.custName ? `for ${r.custName}` : null, r.date ? `dated ${fmtDate(r.date)}` : null, r.total != null ? `total ${fmtMoney(r.total)}` : null].filter(Boolean);
        return `${cap1(documentTypeLabel(r.type) ?? 'document')} ${numOf(r, snap)}${plan.ask?.length && r.custName ? ` for ${r.custName}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
      });
      out.text = `${fmtInt(rows.length)} documents on file print ${plan.code.toUpperCase()}: ${each.join('; ')}.`;
      out.facts = rows.slice(0, 7).map((r) => ({ label: cap1(documentTypeLabel(r.type) ?? 'Document'), value: numOf(r, snap) }));
      out.records = docRecords(rows, snap); out.total = rows.length; out.claimedCount = rows.length;
      out.basis = 'Looked for that number among the invoice, purchase order and permit numbers of every document on file.';
      return out;
    }
    const d = rows[0];
    if (plan.ask?.length) {
      const val = ASK_VAL;
      const parts = plan.ask.map((a) => ({ a, v: val[a.id](d) }));
      const label = `${cap1(documentTypeLabel(d.type) ?? 'document')} ${numOf(d, snap)}`;
      out.text = `${label}: ${parts.map(({ a, v }) => (v == null ? `no ${a.label} on file` : `${a.label} ${v}`)).join('; ')}.`;
      out.facts = parts.filter((p) => p.v != null).map(({ a, v }) => ({ label: cap1(a.label), value: v }));
      out.records = docRecords(rows, snap); out.total = rows.length; out.claimedCount = rows.length;
      out.basis = 'Looked for that number among the invoice, purchase order and permit numbers of every document on file, and read the field from that paper.';
      return out;
    }
    const ft = (d.f.work_performed ?? d.f.notes) ? ` ${cap1(d.f.work_performed ? 'work performed' : 'notes')}: ${d.f.work_performed ?? d.f.notes}.` : '';
    out.text = `${cap1(documentTypeLabel(d.type) ?? 'document')} ${numOf(d, snap)}${d.custName ? ` is for ${d.custName}` : ''}${d.date ? `, dated ${fmtDate(d.date)}` : ''}${d.total != null ? `, total ${fmtMoney(d.total)}` : ''}.${ft}`;
    if (plan.docType && d.type !== plan.docType) out.text = `${plan.code.toUpperCase()} is ${aOrAn(documentTypeLabel(d.type).toLowerCase())}, not ${aOrAn(nounOf(plan, 1))}. ${out.text}`;
    out.facts = [{ label: cap1(documentTypeLabel(d.type) ?? 'Document'), value: numOf(d, snap) }];
    out.records = docRecords(rows, snap); out.total = rows.length; out.claimedCount = rows.length;
    out.basis = 'Looked for that number among the invoice, purchase order and permit numbers of every document on file.';
    return out;
  }
  if (kind === 'total') {
    if (!rows.length) { out.text = `No ${nounOf(plan, 1)} for exactly ${fmtMoney(plan.amount)} is on file.`; out.basis = `Compared ${fmtMoney(plan.amount)} with the printed total of every ${plan.docType ? nounOf(plan, 1) : 'document'} on file.`; return out; }
    out.text = `${fmtInt(rows.length)} ${nounOf(plan, rows.length)} ${rows.length === 1 ? 'is' : 'are'} for exactly ${fmtMoney(plan.amount)}: ${listNames(rows.map((r) => docLabel(r, snap)))}.`;
    out.facts = rows.length <= 7 ? rows.map((r) => ({ label: cap1(nounOf(plan, 1)), value: docLabel(r, snap) })) : [{ label: cap1(typed), value: fmtInt(rows.length) }];
    out.records = docRecords(rows, snap); out.total = rows.length; out.claimedCount = rows.length;
    out.basis = `Compared ${fmtMoney(plan.amount)} with the printed total of every ${plan.docType ? nounOf(plan, 1) : 'document'} on file. ${cap1(DOC_ONLY)}.`;
    return out;
  }
  if (kind === 'serial') {
    const code = plan.code.toUpperCase();
    if (!rows.length) { out.text = `Serial ${code} was not found: no ${plan.docType ? nounOf(plan, 1) : 'document'} on file mentions it.`; out.basis = `Checked the serial number and the text of every ${plan.docType ? nounOf(plan, 1) : 'document'} on file.`; return out; }
    out.text = `${fmtInt(rows.length)} ${nounOf(plan, rows.length)} mention${rows.length === 1 ? 's' : ''} serial ${code}: ${listNames(rows.map((r) => `${documentTypeLabel(r.type)}${numOf(r, snap) ? ` ${numOf(r, snap)}` : ''} (${[r.custName, r.date ? fmtDate(r.date) : null].filter(Boolean).join(', ')})`))}.`;
    out.facts = rows.length <= 7 ? rows.map((r) => ({ label: cap1(documentTypeLabel(r.type) ?? 'Document'), value: numOf(r, snap) ?? r.filename })) : [{ label: 'Documents', value: fmtInt(rows.length) }];
    out.records = docRecords(rows, snap); out.total = rows.length; out.claimedCount = rows.length;
    out.basis = `Checked the serial number and the text of every ${plan.docType ? nounOf(plan, 1) : 'document'} on file. ${cap1(DOC_ONLY)}.`;
    return out;
  }
  // filename
  const d = rows;
  const ex = plan.explain ? d.map((r) => `${r.filename}: ${r.f.work_performed ?? r.f.notes ?? 'nothing was extracted from it, so open the file to read it'}`) : null;
  out.text = ex ? `${listNames(ex, 5)}.` : `${fmtInt(d.length)} ${d.length === 1 ? 'document matches' : 'documents match'}: ${listNames(d.map((r) => `${r.filename} (${[documentTypeLabel(r.type), r.date ? fmtDate(r.date) : null, r.custName].filter(Boolean).join(', ')})`))}.`;
  out.facts = d.map((r) => ({ label: cap1(documentTypeLabel(r.type) ?? 'Document'), value: r.filename }));
  out.records = docRecords(d, snap); out.total = d.length; out.claimedCount = d.length;
  out.basis = `Matched ${res.words.join(' ')} against the file names of every ${plan.docType ? nounOf(plan, 1) : 'document'} on file. ${cap1(DOC_ONLY)}.`;
  return out;
}

function sayConflict(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  if (plan.kind === 'serialBrands') {
    if (!res.hits.length) { out.text = `No serial number appears under two different brands (${fmtInt(res.serials)} checked across units and papers).`; out.basis = 'Grouped every serial number on a unit or a paper and compared the brand written with it.'; out.facts = [{ label: 'Serials in conflict', value: '0' }]; out.claimedCount = 0; return out; }
    out.text = `${fmtInt(res.hits.length)} serial number${res.hits.length === 1 ? '' : 's'} appear${res.hits.length === 1 ? 's' : ''} under more than one brand: ${listNames(res.hits.map((h2) => `${h2.serial.toUpperCase()} (${h2.brands.join(', ')})`))}.`;
    out.facts = [{ label: 'Serials in conflict', value: fmtInt(res.hits.length) }];
    out.basis = 'Grouped every serial number on a unit or a paper and compared the brand written with it.';
    return out;
  }
  const noun1 = nounOf(plan, 1); const noun2 = nounOf(plan, 2);
  const fl = plan.fieldLabel === 'manufacturer' ? 'brand' : plan.fieldLabel;
  out.basis = `Compared the ${fl} written on each ${noun1} with the ${fl} on the equipment record it is linked to; only ${noun2} that carry both are compared (${fmtInt(res.comparable)} of ${fmtInt(res.total)}). ${cap1(DOC_ONLY)}.`;
  if (!res.rows.length) { out.text = `None of the ${fmtInt(res.comparable)} ${noun2} compared show a different ${fl} than their equipment record (${fmtInt(res.comparable)} of ${fmtInt(res.total)} carry both).`; out.facts = [{ label: cap1(noun2), value: '0' }]; out.claimedCount = 0; return out; }
  out.text = `${fmtInt(res.rows.length)} ${nounOf(plan, res.rows.length)} show a different ${fl} than the equipment record: ${listNames(res.rows.map((r) => docLabel(r, snap)))}.`;
  out.facts = [{ label: cap1(noun2), value: fmtInt(res.rows.length) }];
  out.records = docRecords(res.rows, snap); out.total = res.rows.length; out.claimedCount = res.rows.length;
  return out;
}


function sayFuture(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const th = fmtDate(res.today);
  const nf = res.futureDocs.length + res.futureUnits.length;
  const what = plan.docType ? nounOf(plan, 2) : 'documents';
  out.basis = `Compared the date on each ${plan.docType ? nounOf(plan, 1) : 'document'} (its service date, else its invoice date, else the day it was uploaded)${plan.docType ? '' : ' and each unit\'s installation date'} with today, ${th}. Agreement terms and warranty end dates are meant to run into the future, so they are not counted. ${plan.docType || true ? cap1(DOC_ONLY) + '.' : ''}`;
  if (!nf) {
    out.text = `None of the ${what} are dated after ${th}${plan.docType ? '' : ', and no unit has an installation date after it'} (${fmtInt(res.docsChecked)} ${what}${plan.docType ? '' : ` and ${fmtInt(res.units)} installation dates`} checked).`;
    out.facts = [{ label: 'Future-dated', value: '0' }]; out.claimedCount = 0;
    return out;
  }
  const parts = [];
  if (res.futureDocs.length) parts.push(`${fmtInt(res.futureDocs.length)} ${nounOf({ entity: 'document', docType: plan.docType, docWord: null }, res.futureDocs.length)} dated after ${th}: ${listNames(res.futureDocs.map((r) => docLabel(r, snap)), 15)}`);
  if (res.futureUnits.length) parts.push(`${fmtInt(res.futureUnits.length)} unit${res.futureUnits.length === 1 ? '' : 's'} with an installation date after ${th}: ${listNames(res.futureUnits.map((u) => [u.serial, u.brand, u.model].filter(Boolean).join(' ') + ` (${fmtDate(u.installDate)})`), 15)}`);
  out.text = `Yes. ${parts.join('; ')}.`;
  out.facts = [{ label: 'Future-dated', value: fmtInt(nf) }];
  out.records = [...docRecords(res.futureDocs, snap), ...res.futureUnits.slice(0, 100).map((u) => recordFor({ entity: 'unit' }, u, snap))]; out.total = nf; out.claimedCount = nf;
  return out;
}
function sayComplete(res, plan) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const noun = plan.entity === 'unit' ? 'units' : 'customers';
  out.text = `How many of the ${fmtInt(res.total)} ${noun} are blank on each field: ${res.counts.map((c) => `${c.label}: ${fmtInt(c.missing)}`).join('; ')}.`;
  out.facts = res.counts.filter((c) => c.missing).slice(0, 7).map((c) => ({ label: `${cap1(c.label)} blank`, value: fmtInt(c.missing) }));
  out.basis = `Counted, for every ${plan.entity} on file, how many have each of these fields blank: ${res.counts.map((c) => c.label).join(', ')}. A warranty registration is blank where none was filed.`;
  out.total = res.total;
  return out;
}
function sayFieldText(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const noun = (k) => (plan.entity === 'unit' ? (k === 1 ? 'unit' : 'units') : (k === 1 ? 'customer' : 'customers'));
  const cond = condText(plan);
  const phrase = plan.how === 'contains' ? `${plan.label} containing "${cap1(plan.value)}"` : `${plan.label} ${plan.how === 'prefix' ? 'starting' : 'ending'} with ${plan.value.toUpperCase()}`;
  const n = res.rows.length;
  out.basis = `Checked the ${plan.how === 'contains' ? (plan.entity === 'unit' ? 'service address of the customer of ' : 'service address of ') : `${plan.label} of `}every ${plan.entity} on file${cond ? ` ${cond.trim()}` : ''} (${fmtInt(res.withValue)} of ${fmtInt(res.total)} have one); capitals and spacing are ignored.`;
  if (!n) { out.text = `No ${noun(2)}${cond} have ${aOrAn(phrase)} (${fmtInt(res.withValue)} ${noun(res.withValue)} checked).`; out.facts = [{ label: cap1(noun(2)), value: '0' }]; out.claimedCount = 0; return out; }
  const names = res.rows.map((r) => (plan.entity === 'unit' ? (res.rows.length > 12 && r.serial ? r.serial : [r.serial, r.brand, r.model].filter(Boolean).join(' ')) : r.name));
  out.text = plan.show === 'count' ? `${fmtInt(n)} ${noun(n)}${cond} ${n === 1 ? 'has' : 'have'} ${aOrAn(phrase)}.` : `${fmtInt(n)} ${noun(n)}${cond} ${n === 1 ? 'has' : 'have'} ${aOrAn(phrase)}: ${listNames(names)}.`;
  out.facts = [{ label: cap1(noun(2)), value: fmtInt(n) }];
  out.records = res.rows.slice(0, 200).map((r) => recordFor({ entity: plan.entity }, r, snap)); out.total = n; out.claimedCount = n;
  return out;
}
function sayReverse(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const lab = plan.field === 'email' ? 'email address' : 'phone number';
  const n = res.rows.length;
  out.basis = `Compared that ${lab}${plan.field === 'phone' ? ' (digits only)' : ''} with the ${lab} of every customer on file (${fmtInt(res.checked)} customers have one).`;
  if (!n) { out.text = `No customer has ${plan.shown} as ${aOrAn(lab)} on file.`; out.facts = [{ label: 'Customers', value: '0' }]; out.claimedCount = 0; return out; }
  const names = res.rows.map((c) => c.name ?? 'Unnamed customer');
  out.text = plan.show === 'exists' ? `Yes. ${listNames(names)} ${n === 1 ? 'has' : 'have'} ${plan.shown} on file as ${aOrAn(lab)}.` : `${listNames(names)} ${n === 1 ? 'has' : 'have'} ${plan.shown} on file as ${aOrAn(lab)}.`;
  out.facts = res.rows.slice(0, 7).map((c) => ({ label: 'Customer', value: c.name ?? 'Unnamed customer' }));
  out.records = res.rows.map((c) => recordFor({ entity: 'customer' }, c, snap)); out.total = n; out.claimedCount = n;
  return out;
}

function say(res, plan, x) {
  switch (plan.op) {
    case 'text_search': case 'line_search': return sayText(res, plan, x);
    case 'cost_breakdown': return sayBreakdown(res, plan, x);
    case 'duplicates': return sayDuplicates(res, plan, x);
    case 'missing_field': return sayMissing(res, plan, x);
    case 'find_document': return sayFind(res, plan, x);
    case 'field_conflict': return sayConflict(res, plan, x);
    case 'future_dates': return sayFuture(res, plan, x);
    case 'completeness': return sayComplete(res, plan, x);
    case 'field_text': return sayFieldText(res, plan, x);
    case 'reverse_lookup': return sayReverse(res, plan, x);
    default: return null;
  }
}

/** "units with no warranty registration": the sets family reads it as units with no registration PAPER, this family as the registration field left blank; both count the same units, and this answer names the field it checked. */
const beatsUnit = (mine, other) => mine.op === 'missing_field' && other.op === 'set_select' && other.entity === 'unit' && !other.base && !other.scope && !other.expr?.all?.length && !other.expr?.any?.length && other.expr?.none?.length === 1 && other.expr.none[0].k === 'udoc' && other.expr.none[0].type === 'warranty-registration';
/** "customers without an email": the sets family reads it as customers with no email PAPER (a correspondence document); a contact field named in the same words is what is meant: the customers whose record has no such field. */
const beatsContact = (mine, other) => mine.op === 'missing_field' && other.op === 'set_select' && other.entity === 'customer' && mine.entity === 'customer' && !other.base && !other.scope && !other.expr?.all?.length && !other.expr?.any?.length && other.expr?.none?.length === 1 && other.expr.none[0].k === 'doc' && mine.fields?.length === 1 && ['email', 'phone'].includes(mine.fields[0].id) && String(other.expr.none[0].word ?? '').replace(/[^a-z]/gi, '').toLowerCase() === mine.fields[0].id;
const beats = (mine, other) => beatsUnit(mine, other) || beatsContact(mine, other);

registerFamily({ id: 'textdq', ops: TEXTDQ_OPS, beats, detect: (feat, h) => analyze(feat, h), rescue: (feat, h) => analyze(feat, h), exec, say });
export { analyze as _analyze, exec as _exec };
export { resolveTerm, matchAny };
