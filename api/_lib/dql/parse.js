/**
 * dql/parse.js - question -> structured plan, by reading SLOTS and then asking the registered families which one understands them.
 *
 * Pure: no database, no model. The organization's own vocabulary comes in through ctx.tenantVocab (vocab/tenantVocab.js).
 *
 * How it works
 *   1. The text is tokenised and misspellings are repaired against the parser's own words (conservative: unique nearest word only).
 *   2. Slot detectors take words OUT of the working string, longest and most specific first:
 *        names (customers / technicians / vendors), time spans (timeSpans.js + analytics.js resolvers do the date math),
 *        amounts and comparators, tonnage, refrigerant, document types, brands, cities, models, categorical values.
 *   3. Operator and dimension triggers (lex.js) are taken next ("how many", "average", "by year", "top 5" ...).
 *   4. COVERAGE RULE: every word still left must be filler (lex.js FILLER). One unexplained word and the whole question is released
 *      (null) - the parser never guesses what a word it does not know was supposed to constrain.
 *   5. The families (families/*.js) read the slots and claim the question with a plan, or decline.
 *
 * What it never does: answer payment status / balance / due / paid / owed (not tracked), a name that is both a customer and a
 * technician, or a name on file twice (the executor abstains on that one; the existing clarify path asks).
 */
import { resolveAnyTimeRange } from '../analytics.js';
import { stripConversationalFrame } from '../router/frame.js';
import { wordsToNumber } from '../lookups/countQualifiers.js';
import { untrackedConcept, jargonEnabled, respellJargon } from '../lexicon/jargon.js';
import { tokenize, repairWord, findRun } from './text.js';
import { compileVocab, normName } from './vocab.js';
import { FILLER, ENTITY_WORDS, DIM_WORDS, MONEY_WORDS } from './lex.js';
import { detectPlan, allFamilies, rescuePlan } from './registry.js';
import { isPlainInventory } from './plain.js';
import './families/index.js';

export const dqlEnabled = () => process.env.DONOVAN_DQL !== '0';

const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const YEAR = '(?:19|20)\\d\\d';
const NUMW = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety';
const B = '(?<![a-z0-9$.-])'; const E = '(?![a-z0-9-])';
const rx = (src, flags = 'i') => new RegExp(`${B}(?:${src})${E}`, flags);

/** Working string with "take": a matched span is blanked so nothing else can read it again. */
class Work {
  constructor(words) { this.s = ` ${words.join(' ')} `; this.orig = this.s; }
  take(re) { const m = re.exec(this.s); if (!m) return null; this.blank(m.index, m[0].length); return m; }
  /** Like take, but only when fewer than `k` words come before the match (request verbs belong at the start of a question). */
  takeNear(re, k) {
    const m = re.exec(this.s);
    if (!m) return null;
    const before = this.s.slice(0, m.index).split(/\s+/).filter(Boolean).length;
    if (before > k) return null;
    this.blank(m.index, m[0].length);
    return m;
  }
  takeAll(re) { const out = []; for (let m; (m = this.take(re));) out.push(m); return out; }
  blank(i, len) { this.s = this.s.slice(0, i) + ' '.repeat(len) + this.s.slice(i + len); }
  has(re) { return re.test(this.s); }
  left() { return this.s.split(/\s+/).filter(Boolean); }
}

const lookupPlural = (map, text) => { const t = String(text).trim().replace(/\s+/g, ' ').toLowerCase(); return map.get(t) ?? (t.endsWith('s') ? map.get(t.slice(0, -1)) : undefined); };
const numberOf = (w) => { if (/^\d+(\.\d+)?$/.test(w)) return Number(w); const n = wordsToNumber(w); return Number.isFinite(n) ? n : null; };

/* ------------------------------------------------------------------ time */

const TIME_PATTERNS = (() => {
  const POINT = `(?:${MON}\\s+${YEAR}|${YEAR}|q[1-4]\\s+${YEAR}|${MON}|\\d{1,2}/\\d{1,2}/\\d{2,4}|${YEAR}-\\d{2}(?:-\\d{2})?)`;
  return [
    `(?:between|from)\\s+${POINT}\\s+(?:and|to|through|thru|until|till)\\s+${POINT}(?:\\s+(?:of\\s+)?${YEAR})?`,
    `(?:the\\s+)?(?:first|second|third|fourth|1|2|3|4)\\s+quarter\\s+(?:of\\s+)?${YEAR}`,
    `q[1-4]\\s+(?:of\\s+)?${YEAR}`, `${YEAR}\\s+q[1-4]`,
    `(?:the\\s+)?(?:first|second|last)\\s+half\\s+(?:of\\s+)?(?:${YEAR}|this\\s+year|last\\s+year)`, `h[12]\\s+${YEAR}`,
    `(?:the\\s+)?(?:19|20)\\d0s`,
    `(?:on\\s+|in\\s+|during\\s+|since\\s+|before\\s+|after\\s+)?(?:${MON})\\s+(?:\\d{1,2}\\s+)?${YEAR}`,
    `(?:on\\s+|since\\s+|before\\s+|after\\s+)?\\d{1,2}/\\d{1,2}/\\d{2,4}`, `${YEAR}-\\d{2}(?:-\\d{2})?`,
    `(?:since|before|after|by|until|till|through|prior\\s+to)\\s+${YEAR}`,
    `(?:in|during|for|of|from|within)\\s+(?:the\\s+year\\s+)?${YEAR}`,
    `(?:since|before|after)\\s+(?:${MON})`,
    `(?:in|during|for|of)\\s+(?:the\\s+month\\s+of\\s+)?(?:${MON})`,
    `(?:in\\s+|during\\s+|over\\s+|within\\s+|for\\s+|from\\s+)?(?:the\\s+)?(?:last|past|previous|prior)\\s+(?:(?:\\d+|${NUMW})\\s+)?(?:day|week|month|quarter|year)s?`,
    `(?:in\\s+|during\\s+|over\\s+)?(?:the\\s+)?(?:this|current)\\s+(?:past\\s+)?(?:year|month|week|quarter)`,
    `(?:in\\s+|during\\s+)?next\\s+(?:year|month|quarter)`, `year\\s+to\\s+date|ytd|so\\s+far\\s+this\\s+year`,
    `today|yesterday`,
    `${YEAR}`,
  ];
})();
const TIME_RES = TIME_PATTERNS.map((p) => rx(p));

function takeTime(w, today) {
  for (const re of TIME_RES) {
    const m = re.exec(w.s);
    if (!m) continue;
    let phrase = m[0].trim();
    if (/^(?:19|20)\d\d$/.test(phrase)) phrase = `in ${phrase}`;
    let span = null;
    try { span = resolveAnyTimeRange(phrase, today); } catch { span = null; }
    if (!span || span.invalid || !span.from || !span.to) continue;
    w.blank(m.index, m[0].length);
    const day = (v, end) => {
      const x = String(v).slice(0, 10);
      if (/^\d{4}$/.test(x)) return end ? `${x}-12-31` : `${x}-01-01`;
      if (/^\d{4}-\d{2}$/.test(x)) { if (!end) return `${x}-01`; const [yy, mm] = x.split('-').map(Number); return `${x}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`; }
      return x;
    };
    // a month named with no year ("in september", "since march") leaves the year to a guess: released, never guessed
    if (new RegExp(`\\b(?:${MON})\\b`, 'i').test(phrase) && !new RegExp(YEAR).test(phrase) && !/\b(?:last|this|next|past|previous|prior|current)\s+month\b/i.test(phrase)) return { ambiguous: true };
    const lab0 = String(span.label ?? span.bare ?? phrase);
    const label = /^(?:in|since|before|after|on|from|during|through|this|last|year to date|today|yesterday|the)\b/i.test(lab0) ? lab0 : `in ${lab0}`;
    return { from: day(span.from, false), to: day(span.to, true), label };
  }
  return null;
}

/* ------------------------------------------------------------------ triggers */

const R = {
  howMany: rx('how\\s+many(?:\\s+total)?|number\\s+of|count\\s+of|total\\s+number\\s+of|count|tally(?:\\s+up)?'),
  howMuch: rx('how\\s+much'),
  distinct: rx('different|distinct|unique|separate'),
  total: rx('total|totals|sum|sum\\s+of|add\\s+up|adds\\s+up|altogether|combined|in\\s+total'),
  avg: rx('average|avg|mean|typical|on\\s+average'),
  median: rx('median'),
  max: rx('highest|largest|biggest|greatest|most\\s+expensive|maximum|max|priciest|biggest'),
  min: rx('lowest|smallest|cheapest|minimum|min|least\\s+expensive'),
  latest: rx('latest|most\\s+recent(?:ly)?|newest|last|recent'),
  earliest: rx('earliest|first|oldest|initial'),
  exists: rx('is\\s+there|are\\s+there|do\\s+we\\s+have|have\\s+we\\s+got|do\\s+we\\s+got|got\\s+any|have\\s+we\\s+had|did\\s+we\\s+ever\\s+have|does\\s+have'),
  any: rx('any'),
  share: rx('what\\s+(?:percent|percentage|share|proportion|fraction)|(?:percent|percentage|share|proportion|fraction)\\s+of|percent|percentage'),
  versus: rx('versus|vs|compare|compared\\s+(?:to|with)|against'),
  most: rx('(?:the\\s+)?(?:most|highest|biggest|largest|busiest|top)'),
  least: rx('(?:the\\s+)?(?:least|fewest|lowest|smallest|bottom)'),
  neg: rx("no|not|never|none|nobody|nothing|nor|neither|non|zero|without|except|excluding|exclude|other\\s+than|besides|apart\\s+from|aside\\s+from|but\\s+not|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|wont|cant|cannot|aint|lacking"),
  missing: rx('missing|lacking|lack|lacks|blank|empty'),
};

const DIM_ALT = Object.values(DIM_WORDS).flat().sort((a, b) => b.length - a.length).join('|');
const BYWORDS = 'by|per|for\\s+each|each|every|across|broken\\s+down\\s+by|breakdown\\s+by|grouped\\s+by|group\\s+by|split\\s+by|in\\s+each|of\\s+each|by\\s+each|over\\s+each';
const DIM_RE = rx(`(?:${BYWORDS})\\s+(?:the\\s+)?(?:(?:month\\s+of\\s+the\\s+year|month\\s+of\\s+year)|(${DIM_ALT}))(?:\\s+(?:and|then)\\s+(?:${BYWORDS}\\s+)?(?:(${DIM_ALT})))?`);

const dimIdOf = (phrase) => {
  const p = String(phrase ?? '').toLowerCase().trim();
  for (const [id, ph] of Object.entries(DIM_WORDS)) if (ph.includes(p)) return id;
  return null;
};

/* ------------------------------------------------------------------ main */

/**
 * @param {string} question
 * @param {{tenantVocab?:object, pack?:object, today?:string}} ctx
 * @returns {{mode:'dql', plan:object, text:string}|null}
 */
export function parseDql(question, ctx = {}) {
  if (!dqlEnabled()) return null;
  const tv = ctx.tenantVocab;
  if (!tv) return null;
  const raw0 = String(question ?? '').trim();
  if (!raw0 || raw0.length > 240) return null;
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  try { if (jargonEnabled() && untrackedConcept(raw0)) return null; } catch { /* ignore */ }
  const framed = stripConversationalFrame(raw0) ?? raw0;
  // a definition or an opinion is not a query over records ("what is a startup sheet", "what does that mean")
  if (/\b(?:what(?:'s|s|\s+is|\s+are|\s+does)|define|explain|meaning\s+of)\s+(?:a|an)\s/i.test(framed) || /\bwhat\b.*\b(?:mean|means|meaning)\b/i.test(framed)) return null;
  if (/\b\d{1,6}\s+(?:[a-z.]+\s+){0,3}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|pkwy|parkway)\b/i.test(framed)) return null;
  // a question that opens by leaning on the one before it is a follow-up, not a query of its own
  const OPENER = /^\s*(?:and|also|then|but|or|so|what about|how about|same|those|these)\b/i;
  if (OPENER.test(raw0) || OPENER.test(framed) || (ctx.original && OPENER.test(String(ctx.original)))) return null;
  const vocab = compileVocab(tv, ctx.pack);

  // ---- tokens + conservative repair
  const toks = tokenize(framed);
  if (!toks.length || toks.length > 40) return null;
  const words = toks.map((t) => {
    const r = repairWord(t.w, vocab.repairByLen, { has: vocab.known });
    return r ?? t.w;
  });
  if (ctx.debug) ctx.debug.words = words.join(' ');
  const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  for (let i = 1; i < words.length; i++) {
    if (NUMWORDS[words[i]] != null && /^(?:than|least|most|exactly|only|just|over|under|above|below|top|bottom|last|first)$/.test(words[i - 1])) words[i] = String(NUMWORDS[words[i]]);
  }
  let w = new Work(words);
  if (jargonEnabled()) {
    try {
      const jr = respellJargon(words.join(' '), { tenantVocab: tv });
      if (jr?.text) w = new Work(tokenize(jr.text).map((t) => t.w));
    } catch { /* keep the typed words */ }
  }
  const feat = { today, vocab, text0: w.s, raw: raw0, recentN: null, distinctDim: null, times: [], filters: [], docTypes: [], flags: {}, nouns: {}, dims: [], notes: [] };

  // ---- 1. names (customers, technicians, vendors), longest first
  const nameHits = [];
  {
    const parts = [...w.s.matchAll(/\S+/g)].map((m) => ({ w: m[0], i: m.index }));
    const used = new Array(parts.length).fill(false);
    for (let n = Math.min(vocab.maxNameWords, 6); n >= 1; n--) {
      for (let a = 0; a + n <= parts.length; a++) {
        if (used.slice(a, a + n).some(Boolean)) continue;
        const key = normName(parts.slice(a, a + n).map((p) => p.w).join(' '));
        const hit = vocab.names.get(key);
        if (!hit) continue;
        // a single common word is not a name unless it is also written like one in the vocabulary (>= 5 letters or multi-word)
        if (n === 1 && key.length < 5) continue;
        nameHits.push({ key, hit, a, n });
        for (let k = a; k < a + n; k++) used[k] = true;
      }
    }
    for (const h of nameHits.sort((x, y) => y.a - x.a)) {
      const start = parts[h.a].i; const end = parts[h.a + h.n - 1].i + parts[h.a + h.n - 1].w.length;
      w.blank(start, end - start);
    }
  }
  for (const h of nameHits.sort((x, y) => x.a - y.a)) {
    const r = h.hit;
    const roles = [r.customer && 'customer', r.tech && 'tech', r.vendor && 'vendor'].filter(Boolean);
    if (roles.length !== 1) return null; // a name that is two things at once: ask, do not guess
    feat.filters.push({ field: roles[0], op: 'eq', value: r.display, label: r.display, role: roles[0] });
  }

  feat.flags.custRel = /\b(?:customers?|clients?)\s+(?:with|who|that|which|have|has|having|whose)\b/.test(w.s);

  // ---- 2. time (a second span only means something next to "versus")
  feat.times = [];
  for (let i = 0; i < 3; i++) { const sp = takeTime(w, today); if (!sp) break; if (sp.ambiguous) return null; feat.times.push(sp); }
  feat.time = feat.times[0] ?? null;
  // direction words that only ever introduce a time span we just took are gone with it; a stray one is left to the coverage rule.

  // "by dollars billed", "by revenue": the measure of a ranking, not a dimension
  {
    const bm = w.take(rx('by\\s+(?:total\\s+)?(?:dollars?|revenue|sales|billings?|amount|billed|invoiced)(?:\\s+(?:billed|invoiced))?'));
    feat.byMoney = Boolean(bm);
    feat.byMoneyType = bm && /revenue|sales|billing|billed|invoiced/.test(bm[0]) ? ['invoice'] : [];
  }
  // ---- 3. dimensions ("by year", "per technician", "for each city")
  const dimHits = [];
  if (w.take(rx('(?:what|which)\\s+(?:kinds?|types?)\\s+of(?=\\s+(?:documents?|docs?|paperwork|files|records|papers))'))) dimHits.push('type');
  for (let m; (m = w.take(DIM_RE));) {
    const full = m[0];
    if (/month\s+of\s+(?:the\s+)?year/.test(full)) dimHits.push('monthOfYear');
    if (m[1]) { dimHits.push(dimIdOf(m[1])); if (/^per\b/i.test(full.trim())) { feat.flags.perDim = true; if (dimIdOf(m[1]) === 'customer') feat.flags.perCustomer = true; } }
    if (m[2]) dimHits.push(dimIdOf(m[2]));
  }
  if (w.take(rx('how\\s+many\\s+of\\s+each|of\\s+each|each\\s+one|each'))) feat.flags.each = true;
  feat.dims = dimHits.filter(Boolean);
  if (dimHits.some((d) => !d)) return null;

  // ---- 4. amounts / comparators (a number needs a unit or a money word to mean anything)
  {
    const CMP = '(?:exactly|only|just|at\\s+least|at\\s+most|no\\s+more\\s+than|no\\s+less\\s+than|more\\s+than|greater\\s+than|bigger\\s+than|larger\\s+than|higher\\s+than|exceeding|exceeds|over|above|less\\s+than|fewer\\s+than|smaller\\s+than|lower\\s+than|cheaper\\s+than|under|below|older\\s+than|younger\\s+than|newer\\s+than)';
    const NUM = `(\\$?\\d+(?:\\.\\d+)?)`;
    if (!vocab.unitRe) vocab.unitRe = [...vocab.docPhrases.keys()].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
    const UNIT = `(?:\\s+(years?|yrs?|days?|months?|hours?|hrs?|tons?|ton|dollars?|bucks|percent|units?|systems?|visits?|documents?|docs?|customers?|times|${vocab.unitRe}))?`;
    const TAIL = '(?:\\s+(?:or|and)\\s+(more|less|bigger|larger|smaller|older|newer|higher|lower|greater|fewer|up))?';
    const re = rx(`(${CMP})\\s+${NUM}${UNIT}(?:\\s+ago)?${TAIL}`);
    for (let m; (m = w.take(re));) {
      const word = m[1].replace(/\s+/g, ' ');
      const dir = /^(?:at least|no less than|more than|greater than|bigger than|larger than|higher than|exceeding|exceeds|over|above|older than)$/.test(word) ? 'gt' : 'lt';
      const incl = /^(?:at least|no less than|at most|no more than)$/.test(word);
      const op = /^(?:exactly|only|just)$/.test(word) ? 'eq' : dir === 'gt' ? (incl ? 'gte' : 'gt') : (incl ? 'lte' : 'lt');
      const num = Number(m[2].replace('$', ''));
      if (!m[2].startsWith('$') && !m[3] && num >= 1900 && num <= 2100 && Number.isInteger(num)) { feat.flags.badNumber = true; }
      feat.filters.push({ field: '?num', op, value: num, unit: (m[3] ?? '').toLowerCase().replace(/s$/, ''), relDoc: m[3] ? vocab.docPhrases.get(m[3].toLowerCase().replace(/\s+/g, ' ')) ?? null : null, dollar: m[2].startsWith('$'), word, ago: /ago/.test(m[0]), older: /older|younger|newer/.test(word) });
    }
    // "have 7 documents", "has 3 units": an exact count of related records
    for (let m; (m = w.take(rx(`(?:have|has|had|having|with)\\s+(\\d+)\\s+(units?|systems?|documents?|docs?|visits?|${vocab.unitRe})`)));) {
      feat.filters.push({ field: '?num', op: 'eq', value: Number(m[1]), unit: m[2].toLowerCase().replace(/s$/, ''), relDoc: vocab.docPhrases.get(m[2].toLowerCase().replace(/\s+/g, ' ')) ?? null, dollar: false, word: 'exactly' });
    }
    for (let m; (m = w.take(rx('(multiple|several|multi)[ -]?(units?|systems?|invoices?|documents?|docs?|visits?)')));) {
      feat.filters.push({ field: '?num', op: 'gte', value: 2, unit: m[2].toLowerCase().replace(/s$/, ''), relDoc: null, dollar: false, word: 'multiple' });
    }
    // "between $500 and $1000" / "between 3 and 5 tons"
    const btw = rx(`between\\s+${NUM}${UNIT}\\s+and\\s+${NUM}${UNIT}`);
    for (let m; (m = w.take(btw));) {
      const a = Number(m[1].replace('$', '')); const b = Number(m[3].replace('$', ''));
      feat.filters.push({ field: '?num', op: 'between', value: [Math.min(a, b), Math.max(a, b)], unit: (m[2] ?? m[4] ?? '').toLowerCase().replace(/s$/, ''), dollar: m[1].startsWith('$') || m[3].startsWith('$') });
    }
  }

  // ---- 5. tonnage ("3 ton", "2.5 tons", "4 ton or bigger")
  {
    const re = rx('(\\d+(?:\\.\\d+)?)\\s*-?\\s*tons?(?:\\s+(?:or|and)\\s+(bigger|larger|more|up|higher|greater|smaller|less|lower|under|above))?');
    for (let m; (m = w.take(re));) {
      const tail = m[2];
      const op = !tail ? 'eq' : /smaller|less|lower|under/.test(tail) ? 'lte' : 'gte';
      feat.filters.push({ field: 'tonnage', op, value: Number(m[1]), label: `${m[1]} ton${tail ? ` or ${/smaller|less|lower|under/.test(tail) ? 'smaller' : 'bigger'}` : ''}` });
    }
  }
  // fold tonnage cmp from step 4 ("over 3 tons") into tonnage
  // ---- 6. refrigerant (r-410a, r454b)
  for (let m; (m = w.take(rx('r-?(\\d{2,3})([a-z])?')));) {
    feat.filters.push({ field: 'refrigerant', op: 'eq', value: `R-${m[1]}${(m[2] ?? '').toUpperCase()}`, label: `R-${m[1]}${(m[2] ?? '').toUpperCase()}` });
  }

  // ---- 7. document types (longest phrase first)
  {
    if (!vocab.docRe) {
      const phr = [...vocab.docPhrases.keys()].filter((p) => p.length >= 2).sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
      vocab.docRe = rx(phr.join('|'));
    }
    for (let m; (m = w.take(vocab.docRe));) {
      const id = vocab.docPhrases.get(m[0].trim().replace(/\s+/g, ' ').toLowerCase());
      if (id && !feat.docTypes.includes(id)) { feat.docTypes.push(id); feat.docWord = m[0].trim().replace(/\s+/g, ' ').toLowerCase(); }
      if (/s\s*$/.test(m[0].trim()) || /\bpos?\b/.test(m[0])) feat.flags.plural = true;
    }
  }
  // ---- 8. entity nouns that are not document types
  const noun = (key) => {
    const alt = ENTITY_WORDS[key].slice().sort((a, b) => b.length - a.length).map((p) => p.replace(/\s+/g, '\\s+')).join('|');
    return rx(alt);
  };
  for (const k of ['visit', 'document', 'unit', 'customer', 'technician', 'install']) {
    const hits = w.takeAll(noun(k));
    feat.nouns[k === 'technician' ? 'tech' : k] = hits.length > 0;
    if (hits.some((m) => /s\s*$/.test(m[0].trim()) && !/(?:ss|us)\s*$/.test(m[0].trim()))) feat.flags.plural = true;
  }

  if (feat.nouns.tech && !feat.docTypes.length && !feat.nouns.visit && !feat.nouns.document && !feat.nouns.unit && !feat.nouns.customer && !feat.dims.length && !feat.distinctDim) { feat.distinctDim = 'tech'; feat.nouns.tech = false; }

  // ---- 9. brands, cities, models, categorical values
  {
    const brandKeys = [...vocab.brands.keys()].sort((a, b) => b.length - a.length).map((k) => `${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}s?`);
    if (brandKeys.length) {
      const re = rx(brandKeys.join('|'));
      const hits = [];
      for (let m; (m = w.take(re));) hits.push(lookupPlural(vocab.brands, m[0]));
      if (hits.length) feat.filters.push({ field: 'brand', op: hits.length > 1 ? 'in' : 'eq', value: hits.length > 1 ? [...new Set(hits)] : hits[0], label: [...new Set(hits)].join(' or ') });
    }
    const cityKeys = [...vocab.cities.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    if (cityKeys.length) {
      const re = rx(cityKeys.join('|'));
      const hits = [];
      for (let m; (m = w.take(re));) hits.push(vocab.cities.get(m[0].trim().replace(/\s+/g, ' ').toLowerCase()));
      if (hits.length) feat.filters.push({ field: 'city', op: hits.length > 1 ? 'in' : 'eq', value: hits.length > 1 ? [...new Set(hits)] : hits[0], label: [...new Set(hits)].join(' or ') });
    }
    const modelKeys = [...vocab.models.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (modelKeys.length) {
      const re = rx(modelKeys.join('|'));
      for (let m; (m = w.take(re));) feat.filters.push({ field: 'model', op: 'eq', value: vocab.models.get(m[0].trim().toLowerCase()), label: vocab.models.get(m[0].trim().toLowerCase()) });
    }
    // categorical values: status needs the word "status"; the rest are nouns of their own
    const statusCue = w.take(rx('status|statuses'));
    for (const [field, map] of Object.entries(vocab.cat)) {
      if (field === 'status' && !statusCue) continue;
      if (field === 'refrigerant' || field === 'tonnage') continue; // read by their own slots above
      if (field === 'serviceType') {
        // "PM tickets": the common short form of a service type this organization has
        const pmKey = [...map.keys()].find((k) => /preventive maintenance/.test(k));
        if (pmKey) w.s = w.s.replace(/(?<![a-z0-9$.\/-])(?:pms?|preventative maintenance)(?![a-z0-9-])/g, ` ${pmKey} `);
      }
      const keys = [...map.keys()].filter((k) => k.length >= 3).sort((a, b) => b.length - a.length).map((k) => `${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}s?`);
      if (!keys.length) continue;
      const re = rx(keys.join('|'));
      const hits = [];
      for (let m; (m = w.take(re));) hits.push(lookupPlural(map, m[0]));
      if (hits.length) feat.filters.push({ field, op: hits.length > 1 ? 'in' : 'eq', value: hits.length > 1 ? hits : hits[0], label: hits.join(' or ') });
    }
    if (statusCue) feat.flags.statusCue = true;
  }

  // ---- 10. operator triggers
  const t = feat.trig = {};
  if (feat.byMoney) { t.money = ['dollars']; t.moneyType = feat.byMoneyType; }
  // "which tech has the most X" / "who has the fewest X"
  {
    const m = w.take(rx(`(?:which|what|who)\\s+(?:(${DIM_ALT})\\s+)?(?:(?:has|have|had|did|does|do|is|are|was|were|with|got|gets|brings?|in|made|makes|sold|generated|handled|done|completed|we|our|us|the|a|an)\\s+){0,4}(most|highest|biggest|largest|busiest|top|least|fewest|lowest|smallest)`));
    if (m) {
      const dir = /^(least|fewest|lowest|smallest)$/.test(m[2]) ? 'asc' : 'desc';
      if (m[1]) t.argmax = { dim: dimIdOf(m[1]), dir };
      else if (/^who$/.test(m[0].trim().split(/\s+/)[0])) t.argmax = { dim: null, dir, who: true }; // "who has the most ..." - who is not named
      else if (/^which$/.test(m[0].trim().split(/\s+/)[0]) && (feat.nouns.tech || feat.nouns.customer)) t.argmax = { dim: null, dir }; // "which customer has the most": the noun already named what is ranked
      else if (/^(?:most|highest|biggest|largest)$/.test(m[2])) t.max = true; // "what is the biggest invoice": an extreme, not a ranking of groups
      else if (/^(?:least|fewest|lowest|smallest)$/.test(m[2])) t.min = true;
      else t.argmax = { dim: null, dir };
    }
  }
  // "top 5", "3 best", "bottom 3", "5 worst" (optionally followed by what is ranked: "top 3 cities")
  {
    const RK = 'top|best|biggest|largest|highest|bottom|worst|lowest|smallest|least';
    const m = w.take(rx(`(${RK})\\s+(\\d+|${NUMW})(?:\\s+(${DIM_ALT}))?`));
    const m2 = m ? null : w.take(rx(`(\\d+|${NUMW})\\s+(${RK})(?:\\s+(${DIM_ALT}))?`));
    const hit = m ?? m2;
    if (hit) {
      const word = (m ? m[1] : m2[2]).toLowerCase(); const n = numberOf((m ? m[2] : m2[1]).toLowerCase());
      const dimWord = m ? m[3] : m2[3];
      if (n) { t.topN = { n, dir: /bottom|worst|lowest|smallest|least/.test(word) ? 'asc' : 'desc' }; if (dimWord) { const d = dimIdOf(dimWord); if (d && d !== 'customer') feat.dims.push(d); else if (d === 'customer') feat.nouns.customer = true; } }
    }
  }
  {
    // "how many different brands", "which cities do we serve": the distinct values of one field
    const DD = Object.entries(DIM_WORDS).filter(([id]) => ['tech', 'city', 'brand', 'vendor', 'refrigerant', 'model', 'serviceType', 'tonnage'].includes(id));
    const alt = DD.flatMap(([, ph]) => ph).sort((a, b) => b.length - a.length).join('|');
    const idOf = (phrase) => DD.find(([, ph]) => ph.includes(phrase.toLowerCase().replace(/\s+/g, ' ')))?.[0];
    let m = w.take(rx(`how\\s+many\\s+(?:(?:different|distinct|unique|separate)\\s+)?(${alt})`));
    if (m) { feat.distinctDim = idOf(m[1]); t.howMany = true; }
    else if ((m = w.take(rx(`(?:different|distinct|unique|separate)\\s+(${alt})`)))) { feat.distinctDim = idOf(m[1]); t.distinctWord = true; }
    else if ((m = w.take(rx(`(?:which|what|list|show|name)\\s+(?:are\\s+)?(?:all\\s+)?(?:of\\s+)?(?:the\\s+|our\\s+)?(${alt})`)))) { feat.distinctDim = idOf(m[1]); feat.flags.listVerb = true; }
  }
  // "last 5 invoices" / "first 3 permits": N rows, newest/oldest first
  {
    const m = w.take(rx(`(last|latest|most\\s+recent|newest|recent|first|earliest|oldest)\\s+(\\d+|${NUMW})`));
    if (m) { const n = numberOf(m[2].toLowerCase()); if (n) { feat.recentN = n; t.latest = /^(last|latest|most|newest|recent)/.test(m[1]); t.earliest = !t.latest; } }
  }
  if (!feat.recentN) {
    const m = w.take(rx(`(\\d+|${NUMW})\\s+(most\\s+recent|newest|latest|oldest|earliest|recent)`));
    if (m) { const n = numberOf(m[1].toLowerCase()); if (n) { feat.recentN = n; const latest = /recent|newest|latest/.test(m[2]); t.latest = latest; t.earliest = !latest; } }
  }
  t.negation = Boolean(w.take(R.neg));
  t.missing = Boolean(w.take(R.missing));
  t.distinct = Boolean(w.take(R.distinct)) || Boolean(t.distinctWord);
  t.howMany = Boolean(w.take(R.howMany)) || Boolean(t.howMany);
  t.howMuch = Boolean(w.take(R.howMuch));
  t.share = Boolean(w.take(R.share));
  t.versus = Boolean(w.take(R.versus));
  t.median = Boolean(w.take(R.median));
  t.avg = Boolean(w.take(R.avg));
  t.exists = Boolean(w.take(R.exists));
  t.total = Boolean(w.take(R.total));
  t.max = Boolean(w.take(R.max)) || Boolean(t.max);
  t.min = Boolean(w.take(R.min)) || Boolean(t.min);
  t.latest = Boolean(w.take(R.latest)) || Boolean(t.latest);
  t.earliest = Boolean(w.take(R.earliest)) || Boolean(t.earliest);
  t.any = Boolean(w.take(R.any));
  // money words (measure) - the document type the amount is read from
  {
    const alt = MONEY_WORDS.map(([p]) => p).sort((a, b) => b.length - a.length).join('|');
    const hits = w.takeAll(rx(alt));
    if (hits.length) {
      t.money = hits.map((m) => m[0].trim().toLowerCase());
      t.moneyType = [...new Set(t.money.map((x) => MONEY_WORDS.find(([p]) => p === x)?.[1]).filter(Boolean))];
    }
  }
  // measures that are not money
  if (w.take(rx('labor\\s+hours?|hours?|hrs?'))) t.hours = true;
  if (w.take(rx('tonnage'))) t.tonnageWord = true;
  if (w.take(rx('age|ages|old'))) t.ageWord = true;
  // time cue verbs (which date a time span applies to)
  {
    const cue = {};
    if (w.take(rx('installed|install|installs|installation|installing'))) cue.install = true;
    if (w.take(rx('expire|expires|expired|expiring|expiration|ending|ends|ended|run\\s+out|runs\\s+out|ran\\s+out|lapse|lapsed|lapses'))) cue.expire = true;
    if (w.take(rx('registered|register|registers'))) cue.register = true;
    if (w.take(rx('uploaded|upload|scanned|scan|added|imported|received|came\\s+in|entered|logged'))) cue.created = true;
    if (feat.time) {
      if (w.take(rx('serviced|visited|completed|performed|done|did|worked|ran'))) cue.visit = true;
      w.take(rx('dated|started|opened|gone|go|went|took|take|happened'));
    }
    feat.cue = cue;
  }
  // "jobs": a visit when nothing else says what is counted; just a carrier word beside a money word or a document type
  w.take(rx('log|logged|logging'));
  if (feat.docTypes.length || t.money?.length) w.take(rx('jobs?'));

  // "tickets handled by Marisol Vega", "hours billed by Danny Ochoa": the technician filter's own preposition
  if (feat.filters.some((x) => x.role === 'tech')) w.take(rx('(?:handled|done|completed|performed|worked|logged|billed|written|filed|run|did) by|by'));
  // list verbs
  {
    const lv = w.takeNear(rx('list|show|display|which|name|who|give|pull|find|what|tell|get|bring|see|look|run'), 3);
    feat.flags.listVerb = feat.flags.listVerb || Boolean(lv);
    if (lv && /^who$/i.test(lv[0].trim())) feat.flags.who = true;
    if (lv && /^(?:list|show|display|give|name|pull)$/i.test(lv[0].trim())) feat.flags.explicitList = true;
  }
  // plural/generic carrier words: ignored only when they carry no condition of their own
  for (const x of vocab.industry) w.take(rx(x));
  // a family may read the whole sentence itself (set questions, ranks, averages of a group ...) and take the words it fully explains; it must release when it does not
  for (const fam of allFamilies()) { if (fam.slots) { try { fam.slots(w, feat, vocab, { takeTime }); } catch (e) { if (process.env.DQL_DEBUG) console.error('dql slots error', e); } } }
  // a verb that is only filler ("issued") is a condition when this organization has it as a value of a field ("issued" permits, "completed" work orders)
  // and nothing in the question gave it a date to point at: it is then not explained, and the question is released
  const valueWords = new Set(Object.values(vocab.cat ?? {}).flatMap((m) => [...m.keys()]).flatMap((k) => k.split(' ')));
  // "2024 to now", "until today": the end of a range is a condition; "now" is only filler when it does not close a span
  const spanEnd = /\b(?:to|until|till|through|thru|and|up to)\s+(?:now|today|present)\b/.test(w.s) ? new Set(['now', 'today', 'present']) : null;
  feat.left = w.left().filter((x) => !FILLER.has(x) || (spanEnd && spanEnd.has(x)) || (valueWords.has(x) && !feat.times.length && !feat.time));
  if (ctx.debug) ctx.debug.feat = feat;
  if (feat.flags.badNumber) return null;
  feat.work = { orig: w.orig, s: w.s, raw: toks.map((t) => t.w), text: framed }; // families that explain leftover words themselves (registry.rescuePlan) read the question word by word
  if (feat.left.length) {
    // COVERAGE RULE: an unexplained word releases the question, unless exactly one family explains EVERY leftover word itself
    const early = rescuePlan(feat, { vocab });
    if (early) return { mode: 'dql', plan: early, text: framed, plain: false };
    if (ctx.debug) ctx.debug.why = `unexplained: ${feat.left.join(' ')}`;
    return null;
  }

  // ---- families
  const plan = detectPlan(feat, { vocab });
  if (!plan) { if (ctx.debug) ctx.debug.why = `no family claimed it${feat.unusedTriggers ? ` (unused: ${feat.unusedTriggers.join(',')})` : ''}`; return null; }
  return { mode: 'dql', plan, text: framed, plain: isPlainInventory(plan) };
}
