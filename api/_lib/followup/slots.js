/**
 * Round 2 (B1): slot carry-over for elliptical follow-ups.
 *
 * "how many invoices in 2023" then "and in 2022?" has no subject of its own, so the engine used to ask the
 * model. Here the PRIOR turn's question text is split into named slots (period, person, city, brand, document
 * type, dollar threshold, document anchor) with the same closed vocabularies the planners use; the follow-up is
 * read as ONE new slot value (or one different measure, or one different field of the same record); and a fully
 * self-contained question is composed and handed to the normal pipeline, exactly like pronounReplacement does.
 *
 * Safety rules (every one releases the question, never guesses):
 *  - the follow-up must be explained ENTIRELY by one slot value plus filler words (no unexplained words left);
 *  - the prior question must hold exactly one value of that slot kind (never invents a scope the prior lacked);
 *  - a follow-up that restates its own measure ("how many X?") only inherits when the prior has no other slot;
 *  - more than one slot value in the follow-up, or two candidates in the prior, means no rewrite.
 *
 * Pure. No DB, no model, no network.
 */
import { KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from '../analytics.js';
import { BRAND_RULES } from '../warrantyRules.js';
import { docTypeSynonymAlternation } from '../documentTypes.js';
import { serviceType } from '../lookups/namedCompare.js';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_FRAGMENT_WORDS = 10;

// ------------------------------------------------------------------------------------------ vocabularies

const DOC_SPAN_RE = new RegExp(`\\b(?:${docTypeSynonymAlternation()})(?:e?s)?\\b`, 'gi');

const BRAND_ENTRIES = Object.entries(BRAND_RULES)
  .flatMap(([key, v]) => [key, ...(v.aliases ?? [])])
  .filter((w) => String(w).length >= 3)
  .sort((a, b) => b.length - a.length);
const BRAND_RE = new RegExp(`\\b(?:${BRAND_ENTRIES.map(escapeRe).join('|')})\\b`, 'gi');

let CITY_RE = null;
function cityRe() {
  if (!CITY_RE) {
    const names = [...new Set([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES])]
      .map((c) => String(c).trim()).filter((c) => c.length >= 3)
      .sort((a, b) => b.length - a.length);
    CITY_RE = new RegExp(`\\b(?:${names.map(escapeRe).join('|')})\\b`, 'gi');
  }
  return CITY_RE;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALT = `${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec`;
const YEAR = '(?:19|20)\\d{2}';
const ORD = 'first|second|third|fourth|1st|2nd|3rd|4th';
const ORD_NUM = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
const HALF_NAMES = { 1: ['January', 'June'], 2: ['July', 'December'] };

const PERIOD_PATTERNS = [
  { kind: 'ordpart', re: new RegExp(`\\b(?:the\\s+)?(${ORD})\\s+(half|quarter)(?:\\s+of)?(?:\\s+(${YEAR}))?\\b`, 'gi') },
  { kind: 'q', re: new RegExp(`\\bq([1-4])\\b(?:\\s*(?:of\\s+)?(${YEAR})\\b)?`, 'gi') },
  { kind: 'h', re: new RegExp(`\\bh([12])\\b(?:\\s*(?:of\\s+)?(${YEAR})\\b)?`, 'gi') },
  { kind: 'month', re: new RegExp(`\\b(${MONTH_ALT})\\b\\.?(?:\\s+(${YEAR})\\b)?`, 'gi') },
  { kind: 'rel', re: /\b(?:the\s+)?(?:this|last|previous|prior|next|following)\s+(?:year|quarter|month)\b|\bthe\s+(?:year|quarter|month)\s+(?:before|after)\b|\byear[- ]to[- ]date\b|\bytd\b/gi },
  { kind: 'year', re: new RegExp(`\\b(${YEAR})\\b`, 'g') },
];

const PREP_BEFORE_RE = /(?:^|\s)(in|during|for|of|from|within|throughout|over)\s+$/i;

// ------------------------------------------------------------------------------------------ span finding

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }

function mask(text, spans) {
  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + ' '.repeat(s.end - s.start) + out.slice(s.end);
  return out;
}

function matchAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push(m);
  }
  return out;
}

function parsePeriod(kind, m) {
  const raw = m[0];
  if (kind === 'ordpart') {
    const n = ORD_NUM[m[1].toLowerCase()];
    const part = m[2].toLowerCase();
    if (part === 'half' && n > 2) return null;
    return { gran: part, n, year: m[3] || null, raw };
  }
  if (kind === 'q') return { gran: 'quarter', n: Number(m[1]), year: m[2] || null, raw };
  if (kind === 'h') return { gran: 'half', n: Number(m[1]), year: m[2] || null, raw };
  if (kind === 'month') {
    const w = m[1].toLowerCase();
    // "may"/"march"/"mar" read as ordinary words unless a year follows (checked by the caller with the prefix).
    return { gran: 'month', word: m[1], year: m[2] || null, raw };
  }
  if (kind === 'rel') return { gran: 'rel', raw };
  return { gran: 'year', year: m[1], raw };
}

/**
 * All slot-value spans in `text`, in reading order. Each: {kind, start, end, raw, ...value}.
 * kinds: id, thr, period, doc, brand, city, person.
 */
export function findSpans(text, { fragment = false } = {}) {
  const spans = [];
  const claim = (s) => { if (!spans.some((x) => overlaps(x, s))) { spans.push(s); return true; } return false; };

  // Document ids ("INV-20033", "#4471") — an anchor, and must never be read as a year/threshold.
  for (const m of matchAll(/\b[A-Za-z]{1,5}-\d{3,}\b|#\d{3,}\b/g, text)) claim({ kind: 'id', start: m.index, end: m.index + m[0].length, raw: m[0] });

  // Dollar thresholds.
  const COMP = '(over|above|more than|greater than|exceeding|under|below|less than|at least|at most|up to|beyond)';
  const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)(\\s*(?:k|thousand|dollars|bucks))?';
  for (const re of [new RegExp(`\\b${COMP}\\s+\\$?\\s?${NUM}`, 'gi'), new RegExp(`()\\$\\s?${NUM}`, 'g')]) {
    for (const m of matchAll(re, text)) {
      const before = text.slice(0, m.index);
      if (/\d$/.test(before)) continue;
      claim({ kind: 'thr', start: m.index, end: m.index + m[0].length, raw: m[0], comp: (m[1] || '').toLowerCase() || null, amount: `${m[0].includes('$') ? '$' : ''}${m[2]}${m[3] ?? ''}`.trim() });
    }
  }

  // Periods.
  for (const { kind, re } of PERIOD_PATTERNS) {
    for (const m of matchAll(re, text)) {
      const s = { kind: 'period', start: m.index, end: m.index + m[0].length, raw: m[0] };
      if (spans.some((x) => overlaps(x, s))) continue;
      const p = parsePeriod(kind, m);
      if (!p) continue;
      if (p.gran === 'month' && /^(may|mar|march|sep|sept|dec|jun|jan|feb|apr|jul|aug|oct|nov)$/i.test(p.word) && !p.year) {
        // a bare month word is a period only when introduced by a preposition or when the whole fragment is that word
        const pre = text.slice(0, m.index);
        const bare = fragment && text.trim().replace(/^(and|what about|how about)\s+/i, '').replace(/[?.!\s]+$/, '').toLowerCase() === m[0].trim().replace(/\.$/, '').toLowerCase();
        if (!PREP_BEFORE_RE.test(pre) && !bare) continue;
        if (/^(may|mar)$/i.test(p.word) && !p.year && !PREP_BEFORE_RE.test(pre) && !bare) continue;
      }
      claim({ ...s, period: p });
    }
  }

  // Document types.
  for (const m of matchAll(DOC_SPAN_RE, text)) claim({ kind: 'doc', start: m.index, end: m.index + m[0].length, raw: m[0] });

  // Brands.
  for (const m of matchAll(BRAND_RE, text)) claim({ kind: 'brand', start: m.index, end: m.index + m[0].length, raw: m[0] });

  // Cities (single-word hits next to a capitalised word are surnames, not places: "Denise Ford").
  for (const m of matchAll(cityRe(), text)) {
    const start = m.index, end = start + m[0].length;
    const multi = /\s/.test(m[0]);
    const prevWord = text.slice(0, start).match(/([A-Za-z'’-]+)\s+$/)?.[1] ?? '';
    const nextWord = text.slice(end).match(/^\s+([A-Za-z'’-]+)/)?.[1] ?? '';
    const capNeighbor = (w) => /^[A-Z][a-z]/.test(w) && !/^(In|At|Near|From|Around|Of|And|What|How|About|Same|For)$/.test(w);
    const hasPrep = /(?:^|\s)(in|at|near|from|around|of|to)\s+$/i.test(text.slice(0, start));
    const capitalised = /^[A-Z]/.test(m[0]);
    const wholeFragment = fragment && text.trim().replace(/^(and|what about|how about|same for|also)\s+/i, '').replace(/[?.!\s]+$/, '').toLowerCase() === m[0].toLowerCase();
    if (!multi && (capNeighbor(prevWord) && start > 0 || capNeighbor(nextWord))) continue;
    if (!(capitalised || hasPrep || wholeFragment)) continue;
    claim({ kind: 'city', start, end, raw: m[0] });
  }

  // People: two or three capitalised words that nothing above explains. The first word of the text is
  // lower-cased first (when it is a question starter) so "How many ..." / "Total ..." is never the start of a name.
  const masked = mask(text, spans);
  const lowered = masked.replace(/^(\s*)((?:How|What|Whats|Who|Whose|Which|When|Where|Total|Average|Show|List|Give|Tell|Number|Count|And|Also|Same|Now|Then|Do|Does|Did|Is|Are|Was|Were|Can|Could|Please)\b)/, (_, a, b) => a + b.toLowerCase());
  for (const m of matchAll(/\b[A-Z][a-z]+(?:['’-][A-Za-z]+)?(?:\s+[A-Z][a-z]+(?:['’-][A-Za-z]+)?){1,2}/g, lowered)) {
    let raw = m[0].replace(/['’]s$/i, '');
    claim({ kind: 'person', start: m.index, end: m.index + raw.length, raw });
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------------------------------ measures

const MEASURE_PATTERNS = [
  ['count', /\bhow many\b|\bnumber of\b|\bcount(?: of)?\b/gi],
  ['total', /\bdollar total\b|\bthe total\b|\btotals?\b|\bsum\b|\bcombined\b|\bhow much\b/gi],
  ['avg', /\baverage\b|\bavg\b|\bmean\b/gi],
  ['extreme', /\b(?:biggest|largest|highest|smallest|lowest|cheapest|most expensive|least expensive)\b/gi],
];

function measureOf(text) {
  const kinds = [];
  for (const [k, re] of MEASURE_PATTERNS) { re.lastIndex = 0; if (re.test(text)) kinds.push(k); }
  return kinds;
}

function stripMeasures(text) {
  let out = text;
  for (const [, re] of MEASURE_PATTERNS) out = out.replace(re, ' ');
  return out;
}

const FILLER = new Set(('not and also then now just only what whats what\'s about how same for in of on at the a an to from during is are was were do does did we you i ' +
  'have has there that this those these them it they one ones as well too again please me us our tell give show').split(' '));

const LEAD_IN_RE = /^\s*(and|also|what about|how about|same for|same|what of|now|then)\b[\s,]*/i;

// ------------------------------------------------------------------------------------------ rendering

function renderYear(p, fallbackYear) {
  const y = p.year || fallbackYear || '';
  return y;
}

/** Text for a period in a question, plus whether it carries its own preposition ("from X through Y"). */
function renderPeriod(p, yearHint) {
  if (p.gran === 'year') return { text: p.year, ownPrep: false };
  if (p.gran === 'rel') return { text: p.raw.toLowerCase(), ownPrep: false };
  if (p.gran === 'month') return { text: `${p.word}${renderYear(p, yearHint) ? ' ' + renderYear(p, yearHint) : ''}`, ownPrep: false };
  if (p.gran === 'quarter') return { text: `Q${p.n}${renderYear(p, yearHint) ? ' ' + renderYear(p, yearHint) : ''}`, ownPrep: false };
  if (p.gran === 'half') {
    const [a, b] = HALF_NAMES[p.n];
    const y = renderYear(p, yearHint);
    return { text: `from ${a} through ${b}${y ? ' ' + y : ''}`, ownPrep: true };
  }
  return null;
}

/** The new period when `follow` overrides `prior` — keeps the prior's granularity for a bare year. */
function relShift(raw) {
  const t = raw.toLowerCase();
  const unit = (t.match(/year|quarter|month/) || [])[0];
  if (!unit) return null;
  if (/\b(previous|prior|last|before)\b/.test(t)) return { unit, d: -1 };
  if (/\b(next|following|after)\b/.test(t)) return { unit, d: 1 };
  return null; // "this year" etc. cannot be resolved without today's date
}

/** Resolves a relative word against the prior period; null when it cannot be resolved. */
function resolveRel(prior, follow) {
  const sh = relShift(follow.raw);
  if (!sh) return null;
  if (prior.gran === 'year' && sh.unit === 'year' && prior.year) return { gran: 'year', year: String(Number(prior.year) + sh.d), raw: '' };
  if (prior.gran === 'quarter' && sh.unit === 'quarter') {
    let n = prior.n + sh.d, y = prior.year ? Number(prior.year) : null;
    if (n < 1 || n > 4) { if (y === null) return null; y += n < 1 ? -1 : 1; n = n < 1 ? 4 : 1; }
    return { ...prior, n, year: y === null ? null : String(y) };
  }
  if (prior.gran === 'month' && sh.unit === 'month') {
    const idx = MONTHS.findIndex((m) => m.startsWith(prior.word.toLowerCase().slice(0, 3)));
    if (idx < 0) return null;
    let n = idx + sh.d, y = prior.year ? Number(prior.year) : null;
    if (n < 0 || n > 11) { if (y === null) return null; y += n < 0 ? -1 : 1; n = (n + 12) % 12; }
    const w = MONTHS[n];
    return { ...prior, word: prior.word.length <= 3 ? w.slice(0, 3) : w[0].toUpperCase() + w.slice(1), year: y === null ? null : String(y) };
  }
  if (prior.gran === 'rel') return null;
  return null;
}

/** The new period when `follow` overrides `prior` — keeps the prior's granularity for a bare year. */
function mergePeriod(prior, follow) {
  if (follow.gran === 'year') {
    if (['quarter', 'half', 'month'].includes(prior.gran)) return { ...prior, year: follow.year };
    return follow;
  }
  if (follow.gran === 'rel') return resolveRel(prior, follow);
  if (!follow.year) {
    if (prior.gran === 'rel') return null;
    return { ...follow, year: prior.year || null };
  }
  return follow;
}

function replaceRange(text, start, end, value) {
  return (text.slice(0, start) + value + text.slice(end)).replace(/\s+/g, ' ').replace(/\s+([?.!,])/g, '$1').trim();
}

function matchCase(value, like) {
  return /^[a-z]/.test(value) && /^[A-Z]/.test(like) ? value.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : value;
}

function cleanQuestion(q) {
  return q.replace(/\s+/g, ' ').replace(/\s+([?.!,])/g, '$1').trim();
}

// ------------------------------------------------------------------------------------------ prior shape

function priorMeasure(text) {
  const kinds = measureOf(text);
  if (kinds.includes('count')) return 'count';
  if (kinds.includes('avg')) return 'avg';
  if (kinds.includes('extreme')) return 'extreme';
  if (kinds.includes('total') || /\b(billed|invoiced|revenue|sales)\b/i.test(text)) return 'total';
  return null;
}

const TAIL_FILLER = new Set(('came come were are was is we did do does have has there written wrote send sent issued issue made make completed ' +
  'billed bill done on file books the our all to with a an that of in for from during and total').split(' '));

function onlyFiller(text, set) {
  const words = text.toLowerCase().replace(/[?.!,;:()'’"]/g, ' ').split(/\s+/).filter(Boolean);
  return words.every((w) => set.has(w));
}

/**
 * Parses a prior COUNT/TOTAL question into the pieces a measure swap needs. null when anything is unexplained.
 */
function parseMeasureQuestion(prior) {
  const spans = findSpans(prior);
  const docs = spans.filter((s) => s.kind === 'doc');
  const people = spans.filter((s) => s.kind === 'person');
  const periods = spans.filter((s) => s.kind === 'period');
  const thrs = spans.filter((s) => s.kind === 'thr');
  const cities = spans.filter((s) => s.kind === 'city');
  if (spans.some((s) => s.kind === 'brand' || s.kind === 'id')) return null;
  if (periods.length > 1 || thrs.length > 1 || cities.length > 1 || people.length > 1) return null;
  let doc;
  let headEnd;
  if (docs.length === 1) { doc = docs[0].raw; headEnd = docs[0].start; }
  else if (docs.length === 0 && /\b(billed|invoiced|revenue)\b/i.test(prior)) { doc = 'invoices'; headEnd = -1; }
  else return null;
  if (headEnd >= 0) {
    const head = prior.slice(0, headEnd);
    if (!/^\W*(?:and\s+)?(?:what(?:'s| is| was)?\s+the\s+)?(?:how many|number of|count of|total(?: dollar)?(?: amount)?(?: of)?|sum of|average(?: of)?)\s*$/i.test(head)) return null;
  }
  // the words around the slots must all be plain filler
  const rest = mask(prior, spans);
  const restClean = headEnd >= 0 ? rest.slice(0, headEnd).replace(/.*/, ' ') + rest.slice(headEnd) : rest;
  const tailWords = restClean.replace(/\b(?:total|billed|invoiced|revenue|what|whats|is|the|how|many|much)\b/gi, ' ');
  if (!onlyFiller(tailWords, TAIL_FILLER)) return null;
  let person = null;
  if (people.length) {
    const p = people[0];
    const around = prior.slice(Math.max(0, p.start - 14), Math.min(prior.length, p.end + 12));
    const customerForm = /\b(?:does|do|did|has|have)\s+$/i.test(prior.slice(0, p.start)) && /^\s*(?:have|get|receive|received|own)\b/i.test(prior.slice(p.end));
    const forForm = /\b(?:for|from|to)\s+$/i.test(prior.slice(0, p.start));
    if (!customerForm && !forForm) return null;
    person = p.raw;
  }
  return {
    doc, person,
    thr: thrs[0] ? thrs[0].raw : null,
    city: cities[0] ? cities[0].raw : null,
    period: periods[0] ? periods[0].period : null,
  };
}

function composeMeasure(parts, lead) {
  const bits = [lead, parts.doc];
  if (parts.thr) bits.push(parts.thr);
  if (parts.city) bits.push(`in ${parts.city}`);
  if (parts.person) bits.push(`for ${parts.person}`);
  if (parts.period) {
    const r = renderPeriod(parts.period);
    if (!r) return null;
    bits.push(r.ownPrep ? r.text : `in ${r.text}`);
  }
  return cleanQuestion(bits.join(' ')) + '?';
}

// ------------------------------------------------------------------------------------------ the rewrite

// Only fields the document-number lane itself reads (customer, total, date, payment status, work). With a
// conversation present the records lane steps aside, so a question about any other field of a numbered
// document (technician, hours, notes) would be answered with a false "not stored" — those are left as typed.
// Each field is re-asked in the plainest wording that lane reads, so a synonym ("issued") never leaves an unread word.
const RECORD_FIELDS = [
  ['status', /\b(?:paid|unpaid|status|balance|owe[ds]?|outstanding|overdue|past due|due)\b/i, (a) => `is ${a.noun} ${a.id} paid`],
  ['total', /\b(?:how much|total|amount|cost|price|charged?|billed)\b/i, (a) => `how much was ${a.noun} ${a.id}`],
  ['who', /\b(?:whose|customer|client|who (?:was|is) it for|who (?:was|is) (?:that|this) for)\b|\bwhose\b/i, (a) => `whose job was ${a.noun} ${a.id}`],
  ['date', /\b(?:date|dated|when|day|issued|written)\b/i, (a) => `what is the date of ${a.noun} ${a.id}`],
  ['work', /\b(?:work performed|work|description|what (?:was|is) (?:it|that|this) for)\b|\bwhat was done\b/i, (a) => `what was ${a.id} for`],
];
const RECORD_GLUE = new Set(('and also what whats what\'s how the a an was is were it that this one those of for on at in did do does be been me to tell give show they there as well too again job').split(' '));
const UNREAD_FIELD_RE = /\b(technician|tech|labor|hours?|notes?|serial|model|who did|who worked)\b/i;
const ANAPHOR_RE = /\b(it|that one|this one|that|this)\b/i;
const ADDRESS_ASK_RE = /\bwhere\b[^?]*\b(live|lives|located|stay|stays|reside|resides|at)\b|\bwhere (?:is|are) (?:he|she|they|it)\b|\bwhere do(?:es)? (?:he|she|they)\b/i;
const CONTACT_PRIOR_RE = /\b(phone|number|email|e-mail|address|cell|mobile)\b/i;
const HOWMANY_THAT_RE = /^\s*(?:and\s+)?how many(?: is| are| was| were)?\s+(?:that|those|them|it|this)\s*[?.!]*\s*$/i;

const TOTAL_OF_THAT_RE = /^(?:what|how much)\s+(?:did|does|do|would|will)\s+(?:that|those|they|it|these|this)\s+(?:all\s+)?(?:come|add\s+up|amount|total|sum\s+up)(?:\s+up)?\s+to$/i;
const MONEY_DOC_RE = /\b(?:invoice|proposal|estimate|quote|bid|purchase order|credit memo)s?\b/i;
const SUPERLATIVE_FAMILIES = [['most', 'fewest', 'least'], ['highest', 'lowest'], ['biggest', 'largest', 'greatest', 'smallest']];
const SUPERLATIVE_TOP = new Set(['most', 'highest', 'biggest', 'largest', 'greatest']);
const SUPERLATIVE_RE = /^(?:the\s+)?(most|fewest|least|highest|lowest|biggest|largest|greatest|smallest)(?:\s+(?:one|ones|of them))?$/i;
const QUALIFIER_ONES_RE = /^\s*(?:and\s+)?(?:only|just)\s+(?:the\s+)?(\w+)\s+ones?\s*[?.!]*\s*$/i;

function stripPunct(t) { return String(t ?? '').trim().replace(/[?.!\s]+$/, ''); }

/**
 * @param {string} prior effective question text of the previous turn
 * @param {string} follow the new question as typed
 * @param {{resolvedEntities?: object[]}} [priorTurn]
 * @returns {{query: string, slot: string}|null}
 */
export function slotRewrite(prior, follow, priorTurn = null) {
  const P = stripPunct(prior);
  const F0 = stripPunct(follow);
  if (!P || !F0) return null;
  // A negation in the prior ("not from 2025") is never inherited unless the follow-up says "not" too.
  const NEG_RE = /\b(?:not|never|without|except|excluding|other than|but|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|doesn'?t|don'?t|no)\b|n't\b/i;
  if (NEG_RE.test(P) !== NEG_RE.test(F0)) return null;
  const hadLeadIn = LEAD_IN_RE.test(F0);
  const F = F0.replace(LEAD_IN_RE, '').trim();
  if (!F) return null;
  if (F.split(/\s+/).length > MAX_FRAGMENT_WORDS) return null;

  const priorSpans = findSpans(P);
  const fSpans = findSpans(F, { fragment: true });

  // ---- contact field with a different phrasing ("where do they live") on a person lookup
  if (!fSpans.length && ADDRESS_ASK_RE.test(F) && CONTACT_PRIOR_RE.test(P)) {
    const people = priorSpans.filter((s) => s.kind === 'person');
    if (people.length === 1 && !priorSpans.some((s) => s.kind === 'id')) return { query: `what is the address for ${people[0].raw}?`, slot: 'field' };
    return null;
  }

  // ---- "how many is that?" after a list or "who has the most X"
  if (HOWMANY_THAT_RE.test(F0)) {
    const lm = P.match(/^(?:and\s+)?(?:which|what)\s+(.+)$/i) || P.match(/^(?:and\s+)?(?:list|show(?: me)?|give me)\s+(?:all\s+)?(?:the\s+)?(.+)$/i);
    if (lm && /\b[a-z]+s\b/i.test(lm[1]) && !/^(?:is|was|are|were)\b/i.test(lm[1])) {
      const rest = lm[1];
      if (/\bhow many\b/i.test(P)) return null;
      return { query: `how many ${rest}?`, slot: 'list-count' };
    }
    const most = P.match(/^(?:and\s+)?who\s+(?:has|had|did|does)\s+the\s+(most|fewest|least)\s+(.+)$/i);
    if (most) {
      const ents = (priorTurn?.resolvedEntities ?? []).filter((e) => e?.type === 'customer' && e.label);
      if (ents.length !== 1) return null;
      return { query: `how many ${most[2]} does ${ents[0].label} have?`, slot: 'list-count' };
    }
    return null;
  }

  // ---- field of the same record: the prior named a document ("invoice INV-20033")
  const priorIds = priorSpans.filter((s) => s.kind === 'id');
  if (priorIds.length === 1 && !fSpans.length) {
    const id = priorIds[0];
    const docBefore = P.slice(0, id.start).match(new RegExp(`(${docTypeSynonymAlternation()})\\s*(?:number|no\\.?|#)?\\s*$`, 'i'));
    const anchor = `${docBefore ? docBefore[1].replace(/s$/i, '') + ' ' : ''}${id.raw}`.trim();
    const measures = measureOf(F);
    if (measures.includes('count') || measures.includes('avg') || measures.includes('extreme')) return null;
    if (UNREAD_FIELD_RE.test(F)) return null;
    if (/\b(invoices|tickets|proposals|customers|units|documents)\b/i.test(F)) return null;
    const hits = RECORD_FIELDS.filter(([, re]) => re.test(F));
    if (hits.length !== 1) return null;
    const [, fre, build] = hits[0];
    const leftover = F.toLowerCase().replace(new RegExp(fre.source, 'gi'), ' ').replace(ANAPHOR_RE, ' ').replace(/[?.!,]/g, ' ').split(/\s+/).filter(Boolean);
    if (!leftover.every((w) => RECORD_GLUE.has(w))) return null;
    const q = build({ noun: docBefore ? docBefore[1].replace(/s$/i, '') : 'document', id: id.raw });
    return { query: cleanQuestion(q) + '?', slot: 'record-field' };
  }

  // ---- "what did that come to": the dollar total of the same scope a prior COUNT of money documents asked about
  if (!fSpans.length && TOTAL_OF_THAT_RE.test(F)) {
    if (priorMeasure(P) !== 'count') return null;
    const parts = parseMeasureQuestion(P);
    if (!parts || parts.thr || parts.person || parts.city || !MONEY_DOC_RE.test(parts.doc)) return null;
    const q = composeMeasure(parts, 'what is the total of');
    return q ? { query: q, slot: 'measure' } : null;
  }

  // ---- "and the fewest?": the opposite end of the ranking the prior asked for
  const sup = F.match(SUPERLATIVE_RE);
  if (sup && !fSpans.length) {
    const want = sup[1].toLowerCase();
    const fam = SUPERLATIVE_FAMILIES.find((f) => f.includes(want));
    const inP = fam ? matchAll(new RegExp(`\\b(?:${fam.join('|')})\\b`, 'gi'), P) : [];
    if (!fam || inP.length !== 1) return null;
    const had = inP[0][0].toLowerCase();
    if (!/^(?:and\s+)?(?:who|which|what)\b/i.test(P)) return null;
    if (SUPERLATIVE_TOP.has(had) === SUPERLATIVE_TOP.has(want)) return null; // same end again: nothing new
    return { query: cleanQuestion(P.slice(0, inP[0].index) + want + P.slice(inP[0].index + had.length)) + '?', slot: 'measure' };
  }

  // ---- "only the repair ones": a service-type word narrowing a prior COUNT of service tickets
  const qual = F0.match(QUALIFIER_ONES_RE);
  if (qual && !fSpans.length) {
    if (serviceType(qual[1].toLowerCase()) !== 'Repair') return null; // only the one type the count lanes read exactly
    if (priorMeasure(P) !== 'count') return null;
    const parts = parseMeasureQuestion(P);
    if (!parts || parts.thr || parts.person || parts.city || !/^(?:service\s+)?(?:tickets?|calls?|visits?)$/i.test(parts.doc)) return null;
    const q = composeMeasure({ ...parts, doc: 'repair tickets' }, 'how many');
    return q ? { query: q, slot: 'qualifier' } : null;
  }

  // ---- explain the follow-up with slot values + measure + filler
  const fMeasures = measureOf(F);
  const left = stripMeasures(mask(F, fSpans)).replace(/[?.!,;:]/g, ' ');
  const leftWords = left.toLowerCase().split(/\s+/).filter(Boolean);
  if (!leftWords.every((w) => FILLER.has(w))) return null;

  const pMeasure = priorMeasure(P);

  // ---- a different measure of the same scope ("and the total?", "and the average?", "how many?")
  if (fSpans.length === 0) {
    if (fMeasures.length !== 1) return null;
    const fm = fMeasures[0];
    if (fm === pMeasure) return null;
    if (fm === 'extreme' || fm === 'avg') {
      if (pMeasure === 'avg' || pMeasure === 'extreme') {
        const m = F.match(/\b(biggest|largest|highest|smallest|lowest|cheapest|most expensive|least expensive|average|avg|mean)\b/i);
        const pm = P.match(/\b(biggest|largest|highest|smallest|lowest|cheapest|most expensive|least expensive|average|avg|mean)\b/i);
        if (!m || !pm) return null;
        return { query: cleanQuestion(P.slice(0, pm.index) + m[0].toLowerCase() + P.slice(pm.index + pm[0].length)) + '?', slot: 'measure' };
      }
      if (fm === 'avg' && pMeasure === 'count') {
        const parts = parseMeasureQuestion(P);
        if (!parts) return null;
        const q = composeMeasure(parts, 'what is the average of');
        return q ? { query: q, slot: 'measure' } : null;
      }
      return null;
    }
    if ((fm === 'total' && pMeasure === 'count') || (fm === 'count' && pMeasure === 'total')) {
      const parts = parseMeasureQuestion(P);
      if (!parts) return null;
      const q = composeMeasure(parts, fm === 'total' ? 'what is the total of' : 'how many');
      return q ? { query: q, slot: 'measure' } : null;
    }
    return null;
  }

  // ---- one new slot value
  if (fSpans.length !== 1) return null;
  const fs = fSpans[0];
  if (fs.kind === 'id') return null;
  if (fMeasures.length > 1) return null;
  if (fMeasures.length === 1 && fMeasures[0] !== pMeasure) return null;
  // bare slot values ("2022?") are allowed; a restated measure ("how many work orders?") only when the prior has nothing else to carry
  const targets = priorSpans.filter((s) => s.kind === fs.kind);
  if (targets.length !== 1) return null;
  const target = targets[0];
  const otherKinds = priorSpans.filter((s) => s !== target && ['period', 'person', 'city', 'brand', 'thr'].includes(s.kind));
  if (fMeasures.length === 1 && otherKinds.length) return null;
  if (!hadLeadIn && F.split(/\s+/).length > 4 && !fMeasures.length) return null;

  if (fs.kind === 'period') {
    const merged = mergePeriod(target.period, fs.period);
    if (!merged) return null;
    const r = renderPeriod(merged);
    if (!r) return null;
    let start = target.start;
    const pre = P.slice(0, start).match(PREP_BEFORE_RE);
    if (r.ownPrep && pre) start -= pre[0].replace(/^\s/, '').length;
    return { query: replaceRange(P, start, target.end, r.text) + '?', slot: 'period' };
  }
  if (fs.kind === 'thr') {
    const comp = fs.comp || target.comp || '';
    return { query: replaceRange(P, target.start, target.end, `${comp ? comp + ' ' : ''}${fs.amount}`) + '?', slot: 'threshold' };
  }
  if (fs.kind === 'doc') {
    const plural = /s$/i.test(target.raw);
    let v = fs.raw;
    if (plural && !/s$/i.test(v)) v += 's';
    return { query: replaceRange(P, target.start, target.end, v) + '?', slot: 'doc' };
  }
  if (fs.kind === 'brand') return { query: replaceRange(P, target.start, target.end, matchCase(fs.raw, fs.raw)) + '?', slot: 'brand' };
  if (fs.kind === 'city') return { query: replaceRange(P, target.start, target.end, matchCase(fs.raw, 'A')) + '?', slot: 'city' };
  if (fs.kind === 'person') return { query: replaceRange(P, target.start, target.end, fs.raw) + '?', slot: 'person' };
  return null;
}

/**
 * The previous turn's question as the engine saw it: a prior elliptical follow-up is itself expanded against
 * the turn before it (so "and 2021?" after "and 2022?" after "how many invoices in 2023" still has a scope).
 */
function effectivePrior(turns, i, depth = 0) {
  const q = turns[i].question;
  if (i === 0 || depth > 3) return q;
  const base = effectivePrior(turns, i - 1, depth + 1);
  const r = slotRewrite(base, q, turns[i - 1]);
  return r ? r.query : q;
}

/** Entry point for resolve.js / conversation.js. */
export function slotFollowup(turns, question) {
  try {
    if (!Array.isArray(turns) || !turns.length) return null;
    const i = turns.length - 1;
    const r = slotRewrite(effectivePrior(turns, i), question, turns[i]);
    if (!r || !r.query || r.query.toLowerCase() === String(question).trim().toLowerCase()) return null;
    return r;
  } catch {
    return null;
  }
}
