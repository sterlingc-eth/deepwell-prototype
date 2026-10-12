/**
 * dql/translator/validate.js - the strict gate between a model-written plan and the DQL executor. Pure; no database, no model.
 *
 *   validateTranslatedPlan(raw, question, {tv, pack, today}) -> {ok: true, plan} | {ok: false, reason}
 *
 * A plan is used only when ALL of this holds (anything else is a rejection, and the question goes on to the full model path exactly as before):
 *   1. the shape is the schema's: a known op, entity, field names, filter operators; no stray keys;
 *   2. every condition is ANCHORED: its `words` are in the question, and its value comes from those words (or from the company's own vocabulary
 *      for the same words, e.g. a corrected spelling of a customer). A person is accepted only when the company has that customer/technician/vendor;
 *   3. nothing in the question is left out: every name, city, brand, model and stored value the company knows that the question mentions is in the
 *      plan; every number, period, comparison, negation, "each"/"per", "average"/"median"/"highest"... word is explained by a part of the plan;
 *      every other word is plain filler or the company's own known word, and the round-4 guards (negation, modality, future, scope, deictic,
 *      a second clause, a leftover noun or number) find nothing unexplained;
 *   4. the plan does not invent: an average, median, minimum, share, "different", ranking or period the question does not ask for is rejected;
 *   5. not-tracked concepts (paid, balance, due ...) and private papers (HR letters) are never planned.
 * The accepted plan is the same object dql/parse.js builds, so the existing executor, wording and citations run it unchanged.
 */
import { ENTITIES } from '../fields.js';
import { tokenize, editDistance, repairWord } from '../text.js';
import { compileVocab, normName, lexWords } from '../vocab.js';
import { FILLER, ENTITY_WORDS, DIM_WORDS, MONEY_WORDS } from '../lex.js';
import { guardReason } from '../learned/index.js';
import { customerWordFor } from '../custWord.js';
import { EXCLUDED_DOC_TYPES } from '../snapshot.js';
import { untrackedConcept } from '../../lexicon/jargon.js';
import { resolveAnyTimeRange } from '../../analytics.js';
import { wordsToNumber } from '../../lookups/countQualifiers.js';
import { stripConversationalFrame } from '../../router/frame.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { TP_OPS, FILTER_OPS, TIME_DIMS, MEASURE_FIELDS, FIELD_MENU } from './schema.js';

const MAX_Q = 300;
/** chat words that carry no condition (the executor's own filler list is stricter; these are texting forms of "you", "are", "thanks") */
const CHAT = new Set(['u', 'r', 'ur', 'thx', 'b4', 'btw', 'pls', 'plz', 'asap', 'cheers', 'lifesaver', 'appreciate', 'rush', 'mind', 'remember', 'recall']);
const CHAT_PHRASES = [['i', 'never', 'remember'], ['i', 'never', 'know'], ['i', 'dont', 'remember'], ['i', 'dont', 'know'], ['cant', 'recall'], ['cant', 'remember'], ['if', 'you', 'dont', 'mind'], ['no', 'rush'], ['i', 'cant', 'recall'], ['cant', 'find', 'my', 'notes'], ['appreciate', 'it'], ['is', 'it', 'true'], ['is', 'it', 'possible'], ['if', 'its', 'possible'], ['need', 'it', 'for', 'the', 'books'], ['need', 'it', 'in', '5', 'min'], ['need', 'it'], ['tell', 'if', 'right'], ['tell', 'me', 'if', 'right'], ['per', 'the', 'boss'], ['per', 'the', 'records'], ['keep', 'losing', 'track', 'of', 'it'], ['it', 'been', 'bugging'], ['as', 'best', 'you', 'can', 'tell'], ['as', 'best', 'as', 'you', 'can']];
const TOP_KEYS = new Set(['op', 'reason', 'entity', 'docType', 'visit', 'filters', 'time', 'measure', 'groupBy', 'distinct', 'sortField', 'limit', 'ask']);
const FILTER_KEYS = new Set(['field', 'op', 'value', 'words', 'docType']);
const NUM_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'outside', 'missing', 'present']);
const TEXT_OPS = new Set(['eq', 'neq', 'in', 'notin', 'missing', 'present']);
const PEOPLE = new Set(['customer', 'name', 'tech', 'vendor']);
const DATE_AMBIGUOUS = new Set(['maintenance-agreement', 'agreement', 'warranty-registration', 'insurance-certificate', 'permit', 'price-list', 'statement', 'schedule', 'equipment-record', 'nameplate-photo']);
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const rej = (reason) => ({ ok: false, reason });
const lc = (s) => String(s ?? '').toLowerCase();
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;

/* ------------------------------------------------------------------ question words */

/** The question as the executor's parser reads it: the conversational frame off, tokens lower-cased, small misspellings repaired (only into the parser's own words). */
export function questionTokens(question, vocab) {
  const raw = String(question ?? '');
  const framed = stripConversationalFrame(raw) ?? raw;
  const toks = tokenize(framed);
  for (const t of toks) {
    if (vocab.known(t.w)) continue;
    const r = repairWord(t.w, vocab.repairByLen, { has: vocab.known });
    if (r) t.w = r;
  }
  return toks;
}

/** Find the words (a phrase as typed) in the question tokens: contiguous, each token equal or one typo away (words of 6+ letters). [start, end) or null. */
function findPhrase(qt, phrase, vocab) {
  const pt = tokenize(phrase).map((t) => t.w);
  if (!pt.length || pt.length > 14) return null;
  const same = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && editDistance(a, b, 1) <= 1);
  for (let i = 0; i + pt.length <= qt.length; i++) {
    let ok = true;
    for (let j = 0; j < pt.length && ok; j++) ok = same(qt[i + j].w, pt[j]);
    if (ok) return [i, i + pt.length];
  }
  // the phrase may carry a word the repair step changed ("yeaar" -> "year"): compare against repaired phrase tokens too
  const rp = pt.map((w) => (vocab.known(w) ? w : repairWord(w, vocab.repairByLen, { has: vocab.known }) ?? w));
  for (let i = 0; i + rp.length <= qt.length; i++) {
    let ok = true;
    for (let j = 0; j < rp.length && ok; j++) ok = same(qt[i + j].w, rp[j]);
    if (ok) return [i, i + rp.length];
  }
  return null;
}

function numbersIn(qt) {
  const set = new Set();
  for (const t of qt) {
    const w = t.w.replace(/^\$/, '');
    if (/^\d+(\.\d+)?$/.test(w)) set.add(Number(w));
    else { const n = wordsToNumber(w); if (Number.isFinite(n)) set.add(n); }
  }
  return set;
}

/* ------------------------------------------------------------------ operator words in the question */

const W = {
  avg: /\b(?:average|averages|avg|mean|typical|typically|usual|usually|normal)\b/, median: /\bmedian\b/,
  max: /\b(?:max|maximum|highest|largest|biggest|greatest|most expensive|priciest|costliest|top|most)\b/, min: /\b(?:min|minimum|lowest|smallest|cheapest|least expensive|least|fewest|bottom)\b/,
  sum: /\b(?:total|totals|tot|sum|add up|adds up|adding up|combined|altogether|overall|how much|revenue|billed|invoiced|spent|spend|worth|amount|amounts|dollars|grand|billings|sales|income|earned|cost|costs|value)\b/,
  count: /\b(?:how many|count|number|numbers|many|tally|headcount)\b/, share: /\b(?:percent|percentage|share|proportion|ratio|fraction|portion)\b/,
  distinct: /\b(?:different|distinct|unique|separate|individual)\b/, each: /\b(?:per|each|every|by|breakdown|broken|grouped|group|split|across)\b/,
  latest: /\b(?:latest|newest|most recent|recent|recently|last|final)\b/, earliest: /\b(?:earliest|first|oldest|initial|original)\b/,
  exists: /\b(?:is there|are there|do we|did we|does|have we|has|have|any|anything|exist|exists|ever|got)\b/, rank: /\b(?:top|bottom|best|worst|highest|lowest|most|least|biggest|largest|smallest|busiest|ranking|ranked|rank|leading|fewest|greatest|heaviest|number one|number 1)\b/,
};
const strip = (q) => lc(q).replace(/[?!.,]/g, ' ').replace(/\btotal\s+(?:number|count)\b/g, 'number').replace(/\s+/g, ' ');

/** Does the question state the thing an op needs? (the plan may not invent an average, a median, a ranking ...) */
function opEvidence(op, q, planInfo) {
  const s = strip(q);
  if (op === 'count' && /#/.test(String(q))) return true;
  switch (op) {
    case 'avg': case 'group_avg': return W.avg.test(s);
    case 'median': return W.median.test(s);
    case 'min': return W.min.test(s);
    case 'max': return W.max.test(s);
    case 'share_pct': return W.share.test(s);
    case 'count_distinct': return W.distinct.test(s) || Boolean(planInfo.distinctWord);
    case 'latest': return W.latest.test(s);
    case 'first_ever': return W.earliest.test(s);
    case 'top_n': case 'bottom_n': return W.rank.test(s) || planInfo.hasLimit;
    case 'group_count': case 'group_sum': return W.each.test(s) || planInfo.hasDimWord;
    case 'sum': return W.sum.test(s);
    case 'count': return W.count.test(s) || W.exists.test(s) || /\b(?:list|show|which|who|what)\b/.test(s);
    default: return true;
  }
}
/** The other way: a stated average / median / total / min / max / share / ranking word must have been used. */
function opConflict(op, q) {
  const s = strip(q);
  if (W.median.test(s) && op !== 'median') return 'the question says median';
  if (W.avg.test(s) && !['avg', 'group_avg', 'top_n', 'bottom_n', 'share_pct'].includes(op)) return 'the question says average';
  if (W.share.test(s) && op !== 'share_pct') return 'the question says percent/share';
  return null;
}

/* ------------------------------------------------------------------ time */

function resolveTime(words, today, entity, field, docType) {
  const phrase = String(words).trim().replace(/\b(previous|prior)(?=\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|sixty|ninety)\s+(?:day|week|month|quarter|year)s?\b)/i, 'last');
  const low = lc(phrase);
  if (/\b(?:before|prior to|after|until|till|by|through|thru)\b/.test(low)) {
    const m = new RegExp(`^(?:in\\s+|on\\s+)?(before|prior to|after)\\s+((?:19|20)\\d\\d)$`).exec(low);
    if (!m) return { err: 'time-direction' };
    const y = Number(m[2]);
    const span = /^(?:before|prior to)$/.test(m[1]) ? { from: '1900-01-01', to: `${y - 1}-12-31`, label: `before ${y}` } : { from: `${y + 1}-01-01`, to: today, label: `after ${y}` };
    if (span.from > span.to) return { err: 'time-empty' };
    return { span };
  }
  let sp = null;
  const open = /^(?:between|from|since)\s+(.+?)\s+(?:and|to|through|thru|until|till)\s+(?:now|today|present|date)$/.exec(low);
  try {
    if (open) { const st = resolveAnyTimeRange(`since ${open[1]}`, today); sp = st && !st.invalid && st.from ? { from: st.from, to: today, label: `from ${open[1]} through today` } : null; }
    else sp = resolveAnyTimeRange(/^(?:19|20)\d\d$/.test(low) ? `in ${low}` : phrase, today);
  } catch { sp = null; }
  if (!sp || sp.invalid || !sp.from || !sp.to) return { err: 'time-unreadable' };
  if (new RegExp(`\\b(?:${MON})\\b`).test(low) && !/(?:19|20)\d\d/.test(low) && !/\b(?:last|this|next|past|previous|prior|current)\s+month\b/.test(low)) return { err: 'time-month-without-year' };
  const day = (v, end) => {
    const x = String(v).slice(0, 10);
    if (/^\d{4}$/.test(x)) return end ? `${x}-12-31` : `${x}-01-01`;
    if (/^\d{4}-\d{2}$/.test(x)) { if (!end) return `${x}-01`; const [yy, mm] = x.split('-').map(Number); return `${x}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`; }
    return x;
  };
  const lab0 = String(sp.label ?? sp.bare ?? phrase);
  const label = /^(?:in|since|before|after|on|from|during|through|this|last|year to date|today|yesterday|the)\b/i.test(lab0) ? lab0 : `in ${lab0}`;
  return { span: { from: day(sp.from, false), to: day(sp.to, true), label } };
}

/* ------------------------------------------------------------------ the validator */

/**
 * @param {object} raw     the model's plan (the tool input)
 * @param {string} question
 * @param {{tv: object, pack?: object, today: string}} ctx
 */
export function validateTranslatedPlan(raw, question, { tv, pack, today, snap } = {}) {
  try { return validate(raw, question, { tv, pack, today, snap }); } catch (e) { return rej(`error:${String(e?.message ?? e).slice(0, 60)}`); }
}

function validate(raw, question, { tv, pack, today, snap }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rej('shape');
  const q = String(question ?? '');
  if (!q.trim() || q.length > MAX_Q) return rej('question-length');
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) return rej(`stray-key:${k}`);
  if (!TP_OPS.includes(raw.op)) return rej('unknown-op');
  if (raw.op === 'none') return rej('model-declined');
  if (untrackedConcept(q)) return rej('untracked-concept');
  const vocab = compileVocab(tv, pack);
  const qt = questionTokens(q, vocab);
  if (!qt.length) return rej('empty');
  const covered = new Array(qt.length).fill(false);
  const mark = (r) => { for (let i = r[0]; i < r[1]; i++) covered[i] = true; };
  const nums = numbersIn(qt);

  const entity = raw.entity;
  if (!ENTITIES[entity]) return rej('entity');
  const fields = ENTITIES[entity].fields;
  const menu = new Set(FIELD_MENU[entity]);
  const op = raw.op;
  const isGroupOp = ['group_count', 'group_sum', 'group_avg'].includes(op);
  const isRank = op === 'top_n' || op === 'bottom_n';

  // ---- document type
  let docType = null;
  if (raw.docType != null && raw.docType !== '') {
    if (!isStr(raw.docType) || entity !== 'document') return rej('docType-entity');
    docType = lc(raw.docType).replace(/_/g, '-');
    if (EXCLUDED_DOC_TYPES.has(docType) || /(^|-)hr(-|$)|personnel|payroll|salary|employment/.test(docType)) return rej('private-paper');
    if (!vocab.docTypesInUse.has(docType)) return rej('docType-not-on-file');
  }
  // visits: papers that carry a service date, asked by the everyday visit word (visit, appointment, service call, session ...)
  const visit = raw.visit === true;
  if (raw.visit != null && typeof raw.visit !== 'boolean') return rej('visit-shape');
  if (visit) {
    if (entity !== 'document' || docType) return rej('visit-shape');
    if (!ENTITY_WORDS.visit.some((p) => (p.includes(' ') ? ` ${qt.map((t) => t.w).join(' ')} `.includes(` ${p} `) : qt.some((t) => t.w === p))) && !qt.some((t) => /^(?:jobs?|calls?|appointments?|meetings?|sessions?|visits?|stops?|events?|shifts?)$/.test(t.w))) return rej('visit-not-in-question');
  }
  // the question's own paper words (phrase -> id): the plan must carry exactly the kind the words name
  const docHits = [];
  for (const [phrase, id] of vocab.docPhrases) {
    if (phrase.length < 3) continue;
    const r = findPhrase(qt, phrase, vocab);
    if (r && (vocab.docTypesInUse.has(id) || id === docType)) docHits.push({ id, r, len: r[1] - r[0] });
  }
  for (const [phrase, ids] of vocab.docGroups ?? []) { const r = findPhrase(qt, phrase, vocab); if (r) docHits.push({ id: ids[0], group: ids, r, len: r[1] - r[0] }); }
  docHits.sort((a, b) => b.len - a.len);
  // a short phrase inside a longer one ("ticket" in "delivery ticket") is the longer phrase's word
  for (let i = docHits.length - 1; i >= 0; i--) if (docHits.some((o, j) => j !== i && o.len > docHits[i].len && o.r[0] <= docHits[i].r[0] && o.r[1] >= docHits[i].r[1])) docHits.splice(i, 1);
  const kinds = new Set(docHits.filter((h) => !h.group).map((h) => h.id));
  let docWord = null; let byWordIdx = [];
  const groupKinds = docHits.filter((h) => h.group);
  if (docType) {
    // the company's own word for the kind, or (when the question names no stored kind at all) one distinctive word of the kind's id ("pledge" for pledge-card)
    const idWords = docType.split('-').filter((w) => w.length >= 5);
    const idMatch = (t, w) => t.w === w || t.w === `${w}s` || `${t.w}s` === w || t.w === w.replace(/y$/, 'ies');
    const byWord = !kinds.size && !groupKinds.length && idWords.some((w) => qt.some((t) => idMatch(t, w)));
    if (byWord) byWordIdx = qt.map((t, i) => (docType.split('-').filter((w) => w.length >= 4).some((w) => idMatch(t, w)) ? i : -1)).filter((i) => i >= 0);
    const ok = kinds.has(docType) || groupKinds.some((h) => h.group.includes(docType)) || byWord;
    if (!ok) return rej('docType-not-in-question');
    if (kinds.size > 1 && ![...kinds].every((k) => k === docType)) return rej('two-paper-kinds');
  } else if (kinds.size && entity === 'document' && !visit && !(kinds.size === 1 && [...kinds][0] === 'other')) return rej('docType-dropped');
  else if (groupKinds.length && entity === 'document') return rej('docType-group-dropped');
  for (const h of docHits) if (kinds.has(h.id) || h.group) mark(h.r);
  for (const i of byWordIdx) covered[i] = true;
  { const h = docHits.find((x) => x.id === docType); if (h) docWord = qt.slice(h.r[0], h.r[1]).map((t) => t.w).join(' '); else if (byWordIdx.length) docWord = byWordIdx.map((i) => qt[i].w).join(' '); }
  if (/\bhr\b|\bhuman resources\b|\bpersonnel\b/.test(lc(q))) return rej('private-paper-question');

  // ---- filters
  const filters = [];
  const rawFilters = raw.filters ?? [];
  if (!Array.isArray(rawFilters) || rawFilters.length > 5) return rej('filters');
  const seenField = new Map();
  let hasNegation = false; let hasCompare = false; let customerFilter = false;
  for (const f of rawFilters) {
    if (!f || typeof f !== 'object') return rej('filter-shape');
    for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k)) return rej(`filter-stray-key:${k}`);
    if (!menu.has(f.field)) return rej(`filter-field:${f.field}`);
    if (f.field === 'type') return rej('filter-type-use-docType');
    if (!FILTER_OPS.includes(f.op)) return rej('filter-op');
    if (!isStr(f.words)) return rej('filter-unanchored');
    const r = findPhrase(qt, f.words, vocab);
    if (!r) return rej('filter-words-not-in-question');
    const def = fields[f.field];
    if (def.kind === 'date') return rej('filter-date-use-time');
    const key = `${f.field}:${f.docType ?? ''}`;
    if (seenField.has(key) && !['total', 'rent', 'hours', 'tonnage', 'age', 'docCount', 'unitCount', 'visitCount', 'billed', 'installYear'].includes(f.field) && f.op === 'eq') return rej('same-field-twice');
    seenField.set(key, true);
    const out = { field: f.field, op: f.op };
    const phrase = qt.slice(r[0], r[1]).map((t) => t.w).join(' ');
    if (f.op === 'missing' || f.op === 'present') {
      if (def.kind === 'bool') return rej('filter-bool-op');
      out.value = null; out.neg = true; out.label = `${f.op === 'missing' ? 'with no' : 'with a'} ${def.label} on file`; hasNegation = hasNegation || f.op === 'missing';
    } else if (def.kind === 'num') {
      if (!NUM_OPS.has(f.op)) return rej('filter-op-num');
      const vals = f.op === 'between' || f.op === 'outside' ? f.value : [f.value];
      if (!Array.isArray(vals) || vals.length !== (f.op === 'between' || f.op === 'outside' ? 2 : 1)) return rej('filter-value-shape');
      const nv = vals.map((x) => (typeof x === 'number' ? x : Number(String(x).replace(/[$,\s]/g, ''))));
      if (nv.some((x) => !Number.isFinite(x))) return rej('filter-value-nan');
      // every number must be in the question (the executor never sees a figure the owner did not type)
      if (nv.some((x) => !nums.has(x) && !(x === 0 && ['docCount', 'unitCount', 'visitCount'].includes(f.field) && /\b(?:never|no|none|without|zero)\b/.test(lc(f.words))))) return rej('filter-number-not-in-question');
      if ((f.op === 'between' || f.op === 'outside') && nv[0] > nv[1]) return rej('filter-between-order');
      if (def.kind === 'num' && ['total', 'rent'].includes(f.field) && entity !== 'document') return rej('filter-money-entity');
      out.value = f.op === 'between' || f.op === 'outside' ? nv : nv[0];
      const money = ['total', 'rent', 'billed'].includes(f.field);
      const fmt = (x) => (money ? usd(x) : String(x));
      const unitWord = { tonnage: ' tons', hours: ' labor hours', age: ' years', docCount: ' documents', unitCount: ' units', visitCount: ' service visits' }[f.field] ?? '';
      const cmp = { gt: 'over', gte: 'at least', lt: 'under', lte: 'at most', eq: 'exactly', neq: 'other than' }[f.op];
      out.label = cmp ? `${f.field === 'billed' ? 'billed ' : money ? '' : `${def.label} `}${cmp} ${fmt(nv[0])}${unitWord}`.trim() : f.op === 'between' ? `${f.field === 'billed' ? 'billed' : def.label} between ${fmt(nv[0])} and ${fmt(nv[1])}${unitWord}` : `${def.label} outside ${fmt(nv[0])} to ${fmt(nv[1])}${unitWord}`;
      if (['gt', 'gte', 'lt', 'lte', 'between', 'outside'].includes(f.op)) hasCompare = true;
      if (f.op === 'neq') hasNegation = true;
      if (['docCount', 'unitCount', 'visitCount', 'billed'].includes(f.field) && entity !== 'customer') return rej('filter-relation-entity');
      if (f.field === 'docCount' && f.docType) { const dt = lc(f.docType).replace(/_/g, '-'); if (!vocab.docTypesInUse.has(dt) || !kindsMention(docHits, dt)) return rej('filter-docType'); out.docType = dt; out.label = `with ${out.label.replace(/ documents$/, '')} ${dt.replace(/-/g, ' ')} document${nv[0] === 1 ? '' : 's'}`.replace(/\s+/g, ' '); }
      if (f.field === 'total' && !docType && !(docHits.length)) return rej('filter-money-without-paper-kind');
    } else if (def.kind === 'bool') {
      // customers who own a unit of a brand
      if (f.field !== 'hasBrand' || !['eq', 'neq'].includes(f.op) || !isStr(f.value)) return rej('filter-bool');
      const brand = brandIn(vocab, f.value, phrase);
      if (!brand) return rej('filter-brand-not-known');
      out.value = brand; out.label = f.op === 'eq' ? `with ${brand} units` : `without ${brand} units`; if (f.op === 'neq') hasNegation = true;
    } else {
      if (!TEXT_OPS.has(f.op)) return rej('filter-op-text');
      const list = f.op === 'in' || f.op === 'notin';
      const vals = list ? f.value : [f.value];
      if (!Array.isArray(vals) || !vals.length || vals.length > 6 || vals.some((x) => !isStr(x))) return rej('filter-value-shape');
      const resolved = [];
      for (const v of vals) { const rv = resolveText(f.field, v, phrase, vocab, entity); if (rv.err) return rej(rv.err); resolved.push(rv.value); }
      out.value = list ? resolved : resolved[0];
      if (f.field === 'customer' || f.field === 'name') customerFilter = true;
      const shown = list ? resolved.join(' or ') : resolved[0];
      if (f.op === 'neq' || f.op === 'notin') { hasNegation = true; out.neg = true; out.label = `${def.label} not ${shown}`; }
    }
    mark(r);
    filters.push(out);
  }
  // customers: the executor reads only these fields
  if (entity === 'customer' && filters.some((x) => !['name', 'city', 'docCount', 'unitCount', 'visitCount', 'billed', 'hasBrand'].includes(x.field))) return rej('customer-filter-field');

  // ---- time
  let time = null;
  if (raw.time != null) {
    if (typeof raw.time !== 'object' || !isStr(raw.time.words)) return rej('time-shape');
    const r = findPhrase(qt, raw.time.words, vocab);
    if (!r) return rej('time-words-not-in-question');
    let field = raw.time.field ?? (visit ? 'serviceDate' : ENTITIES[entity].defaultDate);
    if (entity === 'customer') return rej('time-on-customer');
    if (!field || !fields[field] || fields[field].kind !== 'date') return rej('time-field');
    const rt = resolveTime(qt.slice(r[0], r[1]).map((t) => t.w).join(' '), today, entity, field, docType);
    if (rt.err) return rej(rt.err);
    if (entity === 'document' && field === 'date' && docType && DATE_AMBIGUOUS.has(docType)) return rej('time-date-ambiguous-for-paper-kind');
    time = { field, from: rt.span.from, to: rt.span.to, label: rt.span.label };
    mark(r);
  } else if (timeInQuestion(qt)) return rej('time-dropped');

  // ---- measure
  let measure = null;
  const needsMeasure = ['sum', 'avg', 'median', 'min', 'max', 'group_sum', 'group_avg'].includes(op);
  if (raw.measure != null) {
    if (typeof raw.measure !== 'object' || !MEASURE_FIELDS[raw.measure.field]) return rej('measure-field');
    const mf = raw.measure.field;
    if (!menu.has(mf) && mf !== 'age') return rej('measure-not-on-entity');
    if (!fields[mf] || fields[mf].kind !== 'num') return rej('measure-not-numeric');
    if (entity === 'customer') return rej('measure-on-customer');
    if (mf === 'total' && (entity !== 'document' || !docType || visit)) return rej('measure-money-needs-one-paper-kind');
    if (mf === 'rent' && (entity !== 'document' || !docType)) return rej('measure-rent-needs-paper-kind');
    measure = { field: mf, label: MEASURE_FIELDS[mf].label, unit: MEASURE_FIELDS[mf].unit };
  }
  if (needsMeasure && !measure) return rej('measure-missing');
  if (!needsMeasure && !isRank && measure && !['share_pct'].includes(op)) return rej('measure-not-needed');
  // the measure word the question uses must name the measure the plan has
  if (measure) {
    const s = strip(q);
    const moneyW = W.sum.test(s) || MONEY_WORDS.some(([p]) => new RegExp(`\\b${p}\\b`).test(s)) || /\b(?:price|prices|charge|charged|fee|fees|bill|bills|rent|rents|payment|payments)\b/.test(s);
    if (measure.field === 'hours' && !/\b(?:hours?|hrs?|labor|labour|time)\b/.test(s)) return rej('measure-hours-not-in-question');
    if (measure.field === 'tonnage' && !/\b(?:tonnage|tons?|size|sizes|capacity)\b/.test(s)) return rej('measure-tonnage-not-in-question');
    if (measure.field === 'age' && !/\b(?:age|old|older|oldest|years?|newest|youngest|installed)\b/.test(s)) return rej('measure-age-not-in-question');
    if (['total', 'rent'].includes(measure.field) && !moneyW && !/\b(?:invoices?|quotes?|orders?|receipts?|estimates?|proposals?|bids?|agreements?|leases?)\b/.test(s) && !docHits.length) return rej('measure-money-not-in-question');
    // "total labor hours": the word total belongs to the hours, so a money measure needs a money word of its own
    if (['total', 'rent'].includes(measure.field) && (/\b(?:hours?|hrs|labor|labour|tons?|tonnage)\b/.test(s)) && !/\b(?:dollars?|revenue|billed|invoiced|spent|worth|amount|amounts|cost|costs|price|prices|charge|charged|fee|fees|rent|income|sales|billings|value|paid|\$\d)/.test(s)) return rej('measure-money-vs-hours');
  }

  // ---- groups, distinct, sort, limit
  const groupBy = [];
  const gb = raw.groupBy ?? [];
  if (!Array.isArray(gb) || gb.length > 2) return rej('groupBy');
  for (const by of gb) {
    if (!isStr(by)) return rej('groupBy');
    if (TIME_DIMS.includes(by)) {
      const field = time?.field ?? (visit ? 'serviceDate' : ENTITIES[entity].defaultDate);
      if (!field) return rej('groupBy-time-field');
      if (!dimWordInQuestion(by, qt)) return rej(`groupBy-not-in-question:${by}`);
      groupBy.push({ by, field });
    } else {
      if (!menu.has(by) || !fields[by] || fields[by].kind === 'date') return rej(`groupBy-field:${by}`);
      if (entity === 'customer' && by === 'type') return rej('groupBy-type-customer');
      if (!dimWordInQuestion(by, qt, vocab)) return rej(`groupBy-not-in-question:${by}`);
      groupBy.push({ by });
    }
  }
  if ((isGroupOp || isRank) && !groupBy.length && !(isRank && raw.measure && !gb.length)) return rej('groupBy-missing');
  if (!isGroupOp && !isRank && groupBy.length) return rej('groupBy-not-needed');
  if (isGroupOp && op === 'group_count' && measure) return rej('group_count-has-measure');
  if (isGroupOp && op !== 'group_count' && !measure) return rej('group-measure-missing');

  let distinct = null;
  if (raw.distinct != null) {
    if (!['count_distinct', 'list'].includes(op) || !isStr(raw.distinct) || !menu.has(raw.distinct) || fields[raw.distinct].kind === 'date') return rej('distinct');
    if (!dimWordInQuestion(raw.distinct, qt, vocab)) return rej('distinct-not-in-question');
    distinct = raw.distinct;
  }
  if (op === 'count_distinct' && !distinct) return rej('distinct-missing');
  const hasLimit = Number.isInteger(raw.limit) && raw.limit > 0;
  let limit = null;
  if (raw.limit != null) {
    if (!hasLimit || raw.limit > 100) return rej('limit');
    if (!nums.has(raw.limit) && !(raw.limit === 1 && W.rank.test(strip(q)))) return rej('limit-not-in-question');
    limit = raw.limit;
  }
  let sortField = null;
  if (raw.sortField != null) {
    if (!['latest', 'first_ever', 'list'].includes(op) || !fields[raw.sortField] || fields[raw.sortField].kind === 'unknown') return rej('sortField');
    if (!['date', 'num'].includes(fields[raw.sortField].kind)) return rej('sortField-kind');
    sortField = raw.sortField;
  }

  // ---- the op, in the executor's own shape
  const base = { v: 1, entity, docType, visit, filters, time, measure: null, groupBy: [], limit: null, dir: 'desc', docWord: null };
  let plan;
  switch (op) {
    case 'count': case 'exists_yes_no':
      if (measure || groupBy.length) return rej('op-shape');
      plan = { ...base, op };
      break;
    case 'count_distinct':
      plan = { ...base, op, distinct };
      break;
    case 'list':
      if (measure || groupBy.length) return rej('op-shape');
      plan = { ...base, op };
      if (distinct) plan.distinct = distinct;
      else if (sortField) { if (!hasLimit) return rej('list-sort-needs-limit'); plan.sort = { field: sortField, dir: ['asc', 'desc'].includes(raw.dir) ? raw.dir : 'desc' }; plan.limit = limit; }
      break;
    case 'sum': case 'avg': case 'median': case 'min': case 'max':
      if (groupBy.length) return rej('op-shape');
      plan = { ...base, op, measure: { ...measure, agg: op } };
      break;
    case 'group_count': case 'group_sum': case 'group_avg':
      plan = { ...base, op: groupBy.length === 2 ? 'pivot_two_dims' : op, groupBy, measure: measure ? { ...measure, agg: op === 'group_avg' ? 'avg' : 'sum' } : null };
      break;
    case 'top_n': case 'bottom_n': {
      const dir = op === 'bottom_n' ? 'asc' : 'desc';
      if (groupBy.length === 1) {
        const agg = raw.measure?.agg === 'avg' ? 'avg' : 'sum';
        if (agg === 'avg' && !W.avg.test(strip(q))) return rej('invented-average');
        plan = { ...base, op, groupBy, measure: measure ? { ...measure, agg } : null, limit: limit ?? 1, dir, rank: 'groups' };
        if (!measure && entity === 'customer') return rej('rank-customer-needs-measure');
        if (!measure && !docType && !visit && entity === 'document') return rej('rank-needs-paper-kind');
      } else if (!groupBy.length && measure && entity === 'document' && hasLimit) {
        plan = { ...base, op, measure: { ...measure, agg: 'row' }, limit, dir, rank: 'rows' };
      } else return rej('rank-shape');
      break;
    }
    case 'latest': case 'first_ever': {
      if (entity === 'customer' || measure || groupBy.length) return rej('op-shape');
      const sf = sortField ?? time?.field ?? (entity === 'document' ? (visit ? 'serviceDate' : 'date') : null);
      if (!sf || !fields[sf] || fields[sf].kind !== 'date') return rej('sortField-date');
      plan = { ...base, op, sortField: sf };
      if (raw.ask != null) {
        const sq = strip(q);
        if (raw.ask === 'tech') { if (!/\b(?:who|whom)\b/.test(sq) || groupBy.length || filters.some((x) => x.field === 'tech' && x.op === 'eq')) return rej('ask-tech'); }
        else if (raw.ask === 'customer') { if (!/\b(?:who|whom|which|name)\b/.test(sq) || entity !== 'document' || filters.some((x) => x.field === 'customer' && x.op === 'eq')) return rej('ask-customer'); }
        else if (raw.ask === 'amount') { if (!docType || visit || !/\b(?:how much|amount|value|total|cost|price|worth|dollars)\b/.test(sq)) return rej('ask-amount'); }
        else return rej('ask');
        plan.ask = raw.ask;
      }
      break;
    }
    case 'share_pct':
      if (entity === 'customer' || filters.length !== 1 || groupBy.length) return rej('share-shape');
      plan = { ...base, op };
      break;
    default: return rej('op');
  }

  // a list shows papers, not their printed numbers: "which invoice numbers" is another kind of answer
  if (op === 'list' && !distinct && /\b(?:numbers|nums|ids)\b/.test(strip(q)) && !/\b(?:number of|numbers of)\b/.test(strip(q))) return rej('list-of-document-numbers-not-supported');

  // ---- the question says what the op needs, and nothing the op contradicts
  const info = { distinctWord: Boolean(distinct), hasLimit, hasDimWord: groupBy.length > 0 };
  if (!opEvidence(op, q, info)) return rej(`op-not-in-question:${op}`);
  const cf = opConflict(op, q); if (cf) return rej(`op-conflict:${cf}`);
  if (measure && (op === 'sum' || op === 'group_sum') && W.max.test(strip(q)) && !W.sum.test(strip(q)) && !isRank) return rej('wrong-measure-op');

  // ---- coverage: names, places, brands and stored values the company knows and the question mentions must be in the plan
  const inPlan = (kind, val) => filters.some((x) => lc(JSON.stringify(x.value)).includes(lc(val)));
  for (const [k, e] of vocab.names) {
    if (k.split(' ').length < 2) continue;
    const r = findPhrase(qt, k, vocab);
    if (r && !qt.slice(r[0], r[1]).every((_, i) => covered[r[0] + i])) return rej('name-dropped');
  }
  for (const [k] of vocab.cities) { const r = findPhrase(qt, k, vocab); if (r && !(r[0] < r[1] && covered[r[0]])) return rej('city-dropped'); }
  for (const [k] of vocab.brands) { if (k.length < 3) continue; const r = findPhrase(qt, k, vocab); if (r && !(covered[r[0]])) return rej('brand-dropped'); }
  for (const [, m] of Object.entries(vocab.cat)) for (const [k] of m) { if (k.length < 3) continue; const r = findPhrase(qt, k, vocab); if (r && !covered[r[0]]) return rej('stored-value-dropped'); }

  // comparisons and negations in the question need a part of the plan that says them
  const s = strip(q).replace(/\bi (?:never|can'?t|don'?t) (?:remember|recall|know|figure)\b|\bcan'?t (?:recall|remember|find my notes)\b|\bif you (?:don'?t|do not) mind\b|\bno rush\b/g, ' ');
  if (/\b(?:more than|greater than|bigger than|larger than|higher than|exceeding|exceeds|over|above|less than|fewer than|smaller than|lower than|cheaper than|under|below|at least|at most|no more than|no less than|between|older than|newer than|within)\b/.test(s) && !hasCompare && !time) {
    // "over" in "over the years" is not a comparison, but a stated amount comparison with no numeric filter is a dropped condition
    if (/\b(?:more than|greater than|bigger than|larger than|higher than|exceeding|exceeds|over|above|less than|fewer than|smaller than|lower than|cheaper than|under|below|at least|at most|no more than|no less than|older than|newer than)\s+\$?\d/.test(s)) return rej('comparison-dropped');
  }
  if (/\b(?:not|no|never|without|except|excluding|exclude|other than|besides|apart from|aside from|but not|isn'?t|aren'?t|haven'?t|hasn'?t|don'?t|doesn'?t|didn'?t)\b/.test(s) && !hasNegation && !filterWordsHave(rawFilters, /\b(?:not|no|never|without|except|excluding|other than)\b/)) return rej('negation-dropped');

  // mark the words the plan's op, measure, dimensions and entity explain; every other word must be filler or a company word, and the round-4 guards must find nothing
  for (const ph of CHAT_PHRASES) for (let i = 0; i + ph.length <= qt.length; i++) if (ph.every((w, j) => qt[i + j].w === w)) for (let j = 0; j < ph.length; j++) covered[i + j] = true;
  for (let i = 0; i < qt.length; i++) if (CHAT.has(qt[i].w)) covered[i] = true;
  explain(qt, covered, { op, measure, groupBy, entity, distinct, docType, filters, limit, vocab, visit });
  const view = [];
  for (let i = 0; i < qt.length; i++) {
    const w = qt[i].w;
    if (covered[i]) { view.push({ w, k: 'E' }); continue; }
    if (FILLER.has(w)) { view.push({ w, k: 'F' }); continue; }
    view.push({ w, k: 'L' });
    if (!vocab.known(w) && !lexWords().has(w)) return rej(`unexplained-word:${w}`);
  }
  const g = guardReason(strip(q).replace(/\bi (?:never|can'?t|don'?t) (?:remember|recall|know|figure)\b|\bcan'?t (?:recall|remember|find my notes)\b|\bif you (?:don'?t|do not) mind\b|\bno rush\b/g, ' '), view);
  if (g) return rej(`guard:${g}`);

  // "not X" / "other than X" over a field some rows do not record: those rows are neither X nor not-X, so a count would be a guess (the executor never counts a row without the value)
  if (snap) {
    const E = ENTITIES[entity];
    const scope = E.rows(snap).filter((r) => (entity !== 'document' || ((!docType || r.type === docType) && (!visit || r.serviceDate != null))));
    for (const f of filters) {
      if (!['neq', 'notin'].includes(f.op)) continue;
      const def = fields[f.field];
      if (scope.length && scope.some((r) => { const v = def.get(r, snap, today, f); return v == null || v === ''; })) return rej(`negation-on-partly-recorded-field:${f.field}`);
    }
  }

  // ---- the plan's finishing touches, as dql/parse.js does them
  if (plan.docType && plan.docType !== 'other') { const lab = documentTypeLabel(plan.docType, pack); if (lab && lab !== documentTypeLabel('other', pack)) plan.docLabel = lab; }
  if (entity === 'customer') { const cw = customerWordFor(vocab.industryKind).one; if (cw !== 'customer') plan.custWord = cw; }
  if (docWord && plan.docType) plan.docWord = docWord;
  plan.translated = true;
  return { ok: true, plan };
}

/* ------------------------------------------------------------------ helpers */

const kindsMention = (docHits, id) => docHits.some((h) => h.id === id || h.group?.includes(id));
const filterWordsHave = (fs, re) => fs.some((f) => re.test(lc(f.words)));

function timeInQuestion(qt) {
  const s = qt.map((t) => t.w).join(' ');
  return /\b(?:19|20)\d\d\b/.test(s) || new RegExp(`\\b(?:${MON})\\s+(?:\\d{1,2}\\s+)?(?:19|20)?\\d{0,4}`).test(s) && /\b(?:in|during|since|of|from)\s+(?:${MON})\b/.test(s)
    || /\b(?:last|past|previous|prior|this|current|next)\s+(?:\d+\s+)?(?:day|week|month|quarter|year)s?\b/.test(s) || /\b(?:today|yesterday|ytd|year to date)\b/.test(s) || /\bq[1-4]\b/.test(s);
}

function dimWordInQuestion(by, qt, vocab) {
  const words = new Set(qt.map((t) => t.w));
  const flat = ` ${qt.map((t) => t.w).join(' ')} `;
  if (by === 'weekday') return /day of (?:the )?week|weekdays?|week day/.test(flat);
  if (by === 'monthOfYear') return /month of (?:the )?year|calendar month|which month|months? of the year/.test(flat) || words.has('monthly');
  const phrases = (DIM_WORDS[by] ?? []).concat({ equipmentType: ['equipment type', 'type', 'kind'], name: ['customer', 'client'], monthOfYear: ['month', 'monthly'], hasBrand: ['brand'] }[by] ?? []);
  const joined = ` ${qt.map((t) => t.w).join(' ')} `;
  if (phrases.some((p) => (p.includes(' ') ? joined.includes(` ${p} `) : words.has(p)))) return true;
  // the company's own word for the people it bills / the staff
  if (by === 'customer' || by === 'name') return (vocab?.industry && [...words].some((w) => /^(?:patients?|tenants?|donors?|members?|owners?|residents?|students?|guests?|clients?)$/.test(w))) || [...words].some((w) => /^(?:patients?|tenants?|donors?|members?|owners?|residents?|students?|guests?|accounts?|who)$/.test(w));
  if (by === 'tech') return [...words].some((w) => /^(?:who|managers?|supervisors?|foremen|foreman|foremans|coordinators?|dentists?|doctors?|staff|employees?|worker|workers|person|people|mechanic|mechanics|inspectors?|attorneys?|lawyers?|crew|agent|agents|dentist|doctor|doctors|provider|providers|trainer|trainers|stylist|stylists|driver|drivers|cleaner|cleaners|installers?|plumbers?|electricians?)$/.test(w));
  if (by === 'type') return words.has('kind') || words.has('type') || words.has('papers') || words.has('documents');
  return false;
}

function brandIn(vocab, value, phrase) {
  const k = normName(value).replace(/-/g, ' ');
  for (const [key, label] of vocab.brands) { if (key === lc(value) || key === k) { if (lc(phrase).includes(key) || editClose(key, phrase)) return label; } }
  return null;
}
const editClose = (a, phrase) => lc(phrase).split(/\s+/).some((w) => w.length >= 5 && a.length >= 5 && editDistance(w, a, 1) <= 1);

/** One text value -> the company's spelling, or {err}. The value must come from the anchored words; a person must exist in the company's records. */
function resolveText(field, value, phrase, vocab, entity) {
  const v = String(value).trim();
  const nv = normName(v);
  const np = normName(phrase);
  const inWords = np.includes(nv) || nv.split(' ').every((w) => np.split(' ').includes(w)) || fuzzyIn(nv, np);
  if (PEOPLE.has(field)) {
    const role = field === 'tech' ? 'tech' : field === 'vendor' ? 'vendor' : 'customer';
    const hit = vocab.names.get(nv) ?? [...vocab.names.entries()].find(([k]) => k.split(' ').length > 1 && editDistance(k, nv, Math.max(1, Math.floor(k.length / 8))) <= Math.max(1, Math.floor(k.length / 8)))?.[1];
    if (!hit) return { err: `invented-name:${field}` };
    if (!hit[role]) return { err: `name-wrong-role:${field}` };
    if (hit.customer && hit.tech) return { err: 'name-both-customer-and-technician' };
    if (!inWords && !fuzzyIn(normName(hit.display), np)) return { err: 'name-not-in-question' };
    return { value: hit.display };
  }
  if (field === 'city') { const c = vocab.cities.get(lc(v)); if (c && inWords) return { value: c }; if (inWords && nv.length >= 3) return { value: titleCase(v) }; return { err: 'city-not-in-question' }; }
  if (field === 'brand' || field === 'hasBrand') { const b = brandIn(vocab, v, phrase); return b ? { value: b } : { err: 'brand-not-known' }; }
  if (field === 'model' || field === 'serial') return inWords && /\d/.test(v) ? { value: v } : { err: `${field}-not-in-question` };
  const cat = vocab.cat[field];
  if (cat) { const c = cat.get(lc(v)); if (c) return inWords ? { value: c } : { err: `${field}-not-in-question` }; }
  if (inWords && nv.length >= 2) return { value: v };
  return { err: `${field}-value-not-in-question` };
}
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
function fuzzyIn(nv, np) {
  if (nv.length < 6) return false;
  const nw = nv.split(' '); const pw = np.split(' ');
  for (let i = 0; i + nw.length <= pw.length; i++) { let ok = true; for (let j = 0; j < nw.length && ok; j++) ok = pw[i + j] === nw[j] || (nw[j].length >= 5 && editDistance(pw[i + j], nw[j], 1) <= 1); if (ok) return true; }
  return false;
}

/** Mark the words that the plan's op, measure, dimensions, entity noun and limit stand for (they carry no condition). */
function explain(qt, covered, { op, measure, groupBy, entity, distinct, docType, filters, limit, vocab, visit }) {
  const words = ENTITY_WORDS;
  const nouns = new Set();
  const addAll = (arr) => arr.forEach((p) => p.split(' ').forEach((w) => nouns.add(w)));
  if (entity === 'customer') addAll(words.customer); if (entity === 'unit') addAll(words.unit.concat(words.install));
  if (entity === 'document') { addAll(words.document); addAll(words.visit); }
  if (filters.some((f) => f.field === 'tech') || groupBy.some((g) => g.by === 'tech') || distinct === 'tech') addAll(words.technician);
  if (filters.some((f) => f.field === 'customer' || f.field === 'name') || groupBy.some((g) => g.by === 'customer') || distinct === 'customer') addAll(words.customer);
  for (const g of groupBy) addAll(DIM_WORDS[g.by] ?? []);
  if (distinct) addAll(DIM_WORDS[distinct] ?? []);
  if (distinct) addAll(['different', 'distinct', 'unique', 'separate', 'individual', 'which', 'what']);
  if (['count', 'group_count', 'count_distinct', 'top_n', 'bottom_n', 'share_pct'].includes(op)) addAll(['count', 'number', 'numbers', 'many']);
  if (filters.some((f) => ['customer', 'name', 'city'].includes(f.field)) && entity !== 'customer') addAll(words.customer);
  if (measure) { addAll(['total', 'totals', 'amount', 'amounts']); for (const [p] of MONEY_WORDS) addAll([p]); addAll(['hours', 'hour', 'labor', 'hrs', 'tonnage', 'tons', 'ton', 'age', 'old', 'older', 'size', 'rent', 'price', 'prices', 'charge', 'charged', 'fee', 'fees', 'payment', 'payments', 'invoiced', 'invoice']); }
  if (visit) addAll(['jobs', 'job', 'calls', 'call', 'appointments', 'appointment', 'meetings', 'meeting', 'sessions', 'session', 'visits', 'visit', 'stops', 'events', 'event', 'shifts']);
  if (filters.some((f) => ['brand', 'model', 'refrigerant', 'tonnage', 'serial'].includes(f.field))) addAll(['equipment', 'system', 'systems', 'units', 'unit']);
  const opw = {
    count: 'how many number numbers count many tally list show give which what who', exists_yes_no: 'is there are any do we have did does exist exists ever got anything', count_distinct: 'how many number different distinct unique separate individual',
    list: 'list show give which what who all every', sum: 'total sum combined altogether overall how much grand', avg: 'average avg mean typical typically per', median: 'median', min: 'minimum min lowest smallest cheapest least fewest bottom',
    max: 'maximum max highest largest biggest greatest most expensive priciest costliest top', group_count: 'per each by every breakdown broken grouped group split across how many number', group_sum: 'per each by every total sum breakdown broken grouped group split across how much',
    group_avg: 'per each by every average avg mean breakdown broken grouped group split across', top_n: 'top highest largest biggest most best busiest leading rank ranked ranking which who what active busy heaviest greatest', bottom_n: 'bottom lowest smallest least fewest worst which who what lightest quietest',
    latest: 'latest newest most recent recently last final which what who', first_ever: 'earliest first oldest initial original which what who', share_pct: 'percent percentage share proportion ratio fraction portion of what',
  }[op] ?? '';
  const common = 'the a an of for in on to by with and or is are was were do does did me my our we us you please show tell give what whats which how many much there that this have has had been all total number';
  const set = new Set([...opw.split(' '), ...nouns]);
  void common;
  for (let i = 0; i < qt.length; i++) {
    if (covered[i]) continue;
    const w = qt[i].w;
    if (set.has(w)) covered[i] = true;
    else if (limit != null && /^\d+$/.test(w) && Number(w) === limit) covered[i] = true;
    else if (limit != null && wordsToNumber(w) === limit) covered[i] = true;
  }
  // the compound "most recent" etc. share words with ops; plain verbs of asking are filler already
  void docType; void vocab;
}
