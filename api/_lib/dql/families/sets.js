/**
 * dql/families/sets.js - the sets family: questions about groups of customers / units / cities / technicians that are built from what
 * each one HAS or HAS NOT on file, and a few questions about a group measured against itself.
 *
 *   set_select      "customers with an estimate but no agreement", "units with no startup sheet", "who else is in Mesa besides X",
 *                   "customers who have seen both Danny and Kevin", "which cities have no permits", "repeat customers",
 *                   "percent of customers with a maintenance agreement"            (list / count / share)
 *   set_above_avg   "invoices above average", "customers billed more than the average customer", "techs with more tickets than average"
 *   set_rank        "where does Richard Osborn rank among customers by total billed", "rank of Mesa among cities by unit count"
 *   set_ratio       "ratio of invoices to proposals", "repair to pm ratio"
 *   set_per_entity  "average visits per customer", "average billed per customer"
 *   set_building    "total billed for the Alma School building", "which apartment in the Alma School building was billed the most"
 *
 * How it reads a question: parse.js hands this family the whole sentence (feat.text0) through `slots`, before its coverage check. The
 * family lexes the sentence into typed items (names, document types, brands, cities, numbers, periods, small phrases) and parses it with
 * its own grammar. EVERY item must be explained: an unknown word, an ambiguous negation ("without A and B"), a doc type that cannot be
 * applied to the thing asked about, a name on file twice - the question is released, never reduced to a guess. When the grammar succeeds
 * the family takes all the words, sets feat.sets (core.js then stands aside) and claims the plan in detect().
 * If the core family would answer the question on its own (and the sentence has no word the core does not explain) the core keeps it.
 *
 * Definitions this family states in every answer it gives:
 *  - a customer HAS a kind of paper when a paper of that kind is linked to the customer (directly, or through the customer's unit);
 *  - a unit HAS a kind of paper only when it is linked to that unit; a kind of paper that is not tied to units reliably is released;
 *  - a service visit is any paper that carries a service date; a repeat customer has two or more of them;
 *  - invoice dollars are the totals printed on invoices (nothing about payment is tracked).
 */
import { registerFamily } from '../registry.js';
import { brandKey } from '../fields.js';
import { ENTITY_WORDS, FILLER } from '../lex.js';
import { normName } from '../vocab.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { recordFor } from '../say.js';
import { detectCore } from './core.js';

export const SETS_OPS = ['set_select', 'set_above_avg', 'set_rank', 'set_ratio', 'set_per_entity', 'set_building'];

const lc = (v) => (v == null ? null : String(v).toLowerCase().trim());
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const art = (w) => (/^(?:[aeiou]|hr\b|r-)/i.test(w) && !/^(?:uni|use|eu)/i.test(w) ? 'an' : 'a');
const listNames = (arr, cap = 40) => (arr.length > cap ? `${arr.slice(0, cap).join(', ')}, and ${fmtInt(arr.length - cap)} more` : arr.join(', '));

/* ====================================================================== lexicon */

const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

/** Small phrases -> a tag (or several tags; null = carries nothing and is dropped). Matched longest first over plain word items. */
const PHRASES = [
  [['how', 'many'], 'q_count'], [['number', 'of'], 'q_count'], [['total', 'number', 'of'], 'q_count'], [['count', 'of'], 'q_count'], [['count'], 'q_count'],
  [['what', 'percent', 'of'], 'q_share'], [['what', 'percentage', 'of'], 'q_share'], [['what', 'share', 'of'], 'q_share'], [['what', 'fraction', 'of'], 'q_share'], [['what', 'proportion', 'of'], 'q_share'],
  [['percent', 'of'], 'q_share'], [['percentage', 'of'], 'q_share'], [['share', 'of'], 'q_share'], [['fraction', 'of'], 'q_share'], [['proportion', 'of'], 'q_share'], [['percent'], 'q_share'], [['percentage'], 'q_share'],
  [['more', 'than'], 'cmp_gt'], [['greater', 'than'], 'cmp_gt'], [['bigger', 'than'], 'cmp_gt'], [['larger', 'than'], 'cmp_gt'], [['higher', 'than'], 'cmp_gt'], [['over'], 'cmp_gt'], [['above'], 'cmp_gt'], [['exceeding'], 'cmp_gt'], [['exceeds'], 'cmp_gt'],
  [['at', 'least'], 'cmp_gte'], [['no', 'less', 'than'], 'cmp_gte'],
  [['at', 'most'], 'cmp_lte'], [['no', 'more', 'than'], 'cmp_lte'],
  [['less', 'than'], 'cmp_lt'], [['fewer', 'than'], 'cmp_lt'], [['smaller', 'than'], 'cmp_lt'], [['lower', 'than'], 'cmp_lt'], [['under'], 'cmp_lt'], [['below'], 'cmp_lt'],
  [['exactly'], 'cmp_eq'], [['only'], 'cmp_eq'],
  [['older', 'than'], 'age_gt'], [['newer', 'than'], 'age_lt'], [['younger', 'than'], 'age_lt'],
  [['or', 'more'], 'ormore'], [['and', 'up'], 'ormore'], [['or', 'higher'], 'ormore'], [['or', 'greater'], 'ormore'], [['or', 'bigger'], 'ormore'], [['or', 'larger'], 'ormore'],
  [['or', 'less'], 'orless'], [['or', 'fewer'], 'orless'], [['or', 'lower'], 'orless'], [['or', 'smaller'], 'orless'],
  [['other', 'than'], 'neg_excl'], [['apart', 'from'], 'neg_excl'], [['aside', 'from'], 'neg_excl'], [['besides'], 'neg_excl'], [['except', 'for'], 'neg_excl'], [['except'], 'neg_excl'], [['excluding'], 'neg_excl'], [['exclude'], 'neg_excl'],
  [['but', 'not'], ['conj_but', 'neg_not']], [['but'], 'conj_but'],
  [['no'], 'neg_no'], [['none'], 'neg_no'], [['nobody'], 'neg_no'],
  [['not'], 'neg_not'], [['dont'], 'neg_not'], [['doesnt'], 'neg_not'], [['didnt'], 'neg_not'], [['isnt'], 'neg_not'], [['arent'], 'neg_not'], [['wasnt'], 'neg_not'], [['werent'], 'neg_not'],
  [['havent'], 'neg_not'], [['hasnt'], 'neg_not'], [['hadnt'], 'neg_not'], [['wont'], 'neg_not'], [['cant'], 'neg_not'], [['cannot'], 'neg_not'], [['aint'], 'neg_not'],
  [['never'], 'neg_never'], [['without'], 'neg_without'], [['neither'], 'neg_neither'], [['nor'], 'neg_nor'],
  [['as', 'well', 'as'], 'conj_and'], [['along', 'with'], 'conj_and'], [['plus'], 'conj_and'], [['and'], 'conj_and'], [['or'], 'conj_or'], [['either'], 'either'], [['both'], 'both'],
  [['at', 'all'], null], [['on', 'record'], null], [['all', 'time'], null], [['so', 'far'], null], [['on', 'file'], null], [['to', 'date'], null], [['overall'], null],
  [['out', 'of', 'warranty'], 'warr_out'], [['expired', 'warranty'], 'warr_out'],
  [['still', 'in', 'warranty'], 'warr_in'], [['still', 'under', 'warranty'], 'warr_in'], [['in', 'warranty'], 'warr_in'], [['under', 'warranty'], 'warr_in'],
  [['same', 'city', 'as'], 'samecity'], [['same', 'town', 'as'], 'samecity'], [['share', 'a', 'city', 'with'], 'samecity'], [['shares', 'a', 'city', 'with'], 'samecity'], [['sharing', 'a', 'city', 'with'], 'samecity'], [['share', 'a', 'town', 'with'], 'samecity'],
  [['average'], 'avg'], [['avg'], 'avg'], [['mean'], 'avg'], [['typical'], 'avg'],
  [['ratio', 'of'], 'ratio'], [['ratio'], 'ratio'],
  [['rank'], 'rank'], [['ranks'], 'rank'], [['ranked'], 'rank'], [['ranking'], 'rank'],
  [['repeat'], 'repeat'], [['multi-unit'], 'multiunit'], [['multiunit'], 'multiunit'], [['per'], 'per'], [['each'], 'each'], [['every'], 'each'],
].sort((a, b) => b[0].length - a[0].length);

const NEG_WORD = { neg_no: 'no', neg_not: 'not', neg_never: 'never', neg_without: 'without', neg_neither: 'neither', neg_nor: 'nor' };

/** Words that carry no condition in this grammar (everything else that is not lexed as an item releases the question). */
const AW = new Set((
  'a an the this that of in on at for to from with into about as is are was were be been being am do does did done doing have has had having get gets got gotten can could would should will shall may might must ' +
  'please pls plz so just also still now currently there here me my our we us you your i what whats which who whom whos whove weve ive youve theyve thats theres im youre need want like let lets know ' +
  'list show display give name pull find tell bring see look run any anyone anybody ever yet else seen file files records record paperwork signed issued written placed filed generated made created sent pulled raised booked scheduled performed ' +
  'ones one people lives live living located based own owns owned owning worked works work served serves out saw handled helped assigned by'
).split(/\s+/).filter(Boolean));

const VERB_DOC = { invoiced: 'invoice', billed: 'invoice', quoted: 'proposal-quote', registered: 'warranty-registration' };
const VERB_WORD = { invoiced: 'invoice', billed: 'invoice', quoted: 'quote', registered: 'warranty registration' };
const VISIT_WORDS = new Set(['serviced', 'visited', 'service', 'visit', 'visits', 'callout', 'callouts']);
const MONEY_VERBS = new Set(['spent', 'spend', 'billed', 'invoiced', 'billings', 'billing', 'revenue']);
const SUBJ_OF = (key) => ({ customer: 'customer', unit: 'unit', install: 'unit', visit: 'visit', document: 'document', technician: 'tech' }[key] ?? null);

/* ====================================================================== lexer */

/** The sentence -> typed items. null = a thing this family cannot read (ambiguous period, a name that is two things ...). */
function lex(text0, vocab, today, takeTime) {
  const mini = { s: ` ${String(text0).trim()} `, blank(i, len) { this.s = this.s.slice(0, i) + ' '.repeat(len) + this.s.slice(i + len); } };
  const times = [];
  for (let k = 0; k < 3; k++) {
    const before = mini.s;
    let sp = null;
    try { sp = takeTime(mini, today); } catch { sp = null; }
    if (!sp) break;
    if (sp.ambiguous) return null;
    // "in the last year" can mean the calendar year or the past twelve months: the resolver picks one, so the question is released
    if (/\bthe\s+(?:last|past|previous)\s+(?:year|month|quarter|week)\b/.test(before.slice(0, 0) + (String(text0).match(/\b(?:in|during|over|within|for)\s+the\s+(?:last|previous)\s+(?:year|month|quarter|week)\b/) ?? [''])[0])) return null;
    let a = 0; while (a < before.length && before[a] === mini.s[a]) a++;
    let b = before.length - 1; while (b > a && before[b] === mini.s[b]) b--;
    times.push({ sp, a, b });
  }
  let str = mini.s;
  times.forEach((t, k) => { str = str.slice(0, t.a) + `@t${k}`.padEnd(t.b - t.a + 1, ' ') + str.slice(t.b + 1); });
  str = str.replace(/\b(?:the\s+)?same\s+(?:city|town)\s+as\b/g, ' samecity ').replace(/\b(?:share|shares|sharing)\s+a\s+(?:city|town)\s+with\b/g, ' samecity ');
  const toks = str.split(/\s+/).filter(Boolean);
  const building = toks.includes('building') || toks.includes('complex');
  const items = [];
  const noun = (key) => ENTITY_WORDS[key].map((p) => p.split(' '));
  const NOUNS = [];
  for (const k of ['customer', 'unit', 'install', 'visit', 'document', 'technician']) for (const ws of noun(k)) NOUNS.push([ws, SUBJ_OF(k)]);
  for (const w of ['city', 'cities', 'town', 'towns']) NOUNS.push([[w], 'city']);
  for (const w of ['brand', 'brands']) NOUNS.push([[w], 'brand']);
  for (const w of ['year', 'years']) NOUNS.push([[w], 'year']);
  for (const w of ['month', 'months']) NOUNS.push([[w], 'month']);
  if (building) for (const w of ['tenant', 'tenants', 'resident', 'residents', 'apartment', 'apartments', 'apt', 'apts', 'occupant', 'occupants']) NOUNS.push([[w], 'customer']);
  NOUNS.sort((a, b) => b[0].length - a[0].length);
  const svcMap = vocab.cat?.serviceType ?? null;
  const svcPhrases = svcMap ? [...svcMap.entries()].map(([k, v]) => [k.split(' '), v]) : [];
  const eq = (ws, i) => ws.every((w, k) => toks[i + k] === w);
  const plural = (w) => [w, w.endsWith('s') ? w.slice(0, -1) : null].filter(Boolean);
  for (let i = 0; i < toks.length;) {
    const tk = toks[i];
    let m;
    if (tk === 'samecity') { items.push({ t: 'p', v: 'samecity' }); i++; continue; }
    if ((m = /^@t(\d)$/.exec(tk))) { items.push({ t: 'time', span: times[Number(m[1])].sp }); i++; continue; }
    // names (longest first; a single short word is never a name)
    let hit = null;
    for (let n = Math.min(vocab.maxNameWords, 6); n >= 1 && !hit; n--) {
      if (i + n > toks.length) continue;
      const key = normName(toks.slice(i, i + n).join(' '));
      const nm = vocab.names.get(key);
      if (!nm || (n === 1 && key.length < 5)) continue;
      const roles = [nm.customer && 'customer', nm.tech && 'tech', nm.vendor && 'vendor'].filter(Boolean);
      if (roles.length !== 1) return null;
      hit = { len: n, item: { t: 'name', display: nm.display, role: roles[0] } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    // document types (and the short forms people use for a registration)
    if (/^(?:registrations?|regs?)$/.test(tk) && !vocab.docPhrases.has(tk) && vocab.docTypesInUse?.has('warranty-registration')) { items.push({ t: 'doc', id: 'warranty-registration', word: 'warranty registration' }); i++; continue; }
    for (let n = Math.min(4, toks.length - i); n >= 1 && !hit; n--) {
      const ph = toks.slice(i, i + n).join(' ');
      if (n === 1 && /^(?:other|others)$/.test(ph)) continue;
      const id = vocab.docPhrases.get(ph);
      if (id) hit = { len: n, item: { t: 'doc', id, word: ph.endsWith('s') && vocab.docPhrases.has(ph.slice(0, -1)) ? ph.slice(0, -1) : ph } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    // service types ("repair", "preventive maintenance", "pm")
    for (const [ws, val] of svcPhrases) {
      if (eq(ws, i)) { hit = { len: ws.length, item: { t: 'cat', field: 'serviceType', v: val } }; break; }
      if (ws.length === 1 && toks[i] === `${ws[0]}s`) { hit = { len: 1, item: { t: 'cat', field: 'serviceType', v: val } }; break; }
    }
    if (!hit && svcMap && /^(?:pms?|preventative)$/.test(tk)) {
      const pmKey = [...svcMap.keys()].find((k) => /preventive maintenance/.test(k));
      if (pmKey) hit = { len: tk === 'preventative' && toks[i + 1] === 'maintenance' ? 2 : 1, item: { t: 'cat', field: 'serviceType', v: svcMap.get(pmKey) } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    // brands, cities
    for (let n = Math.min(3, toks.length - i); n >= 1 && !hit; n--) {
      const ph = toks.slice(i, i + n).join(' ');
      for (const cand of plural(ph)) { const b = vocab.brands.get(cand); if (b) { hit = { len: n, item: { t: 'brand', v: b } }; break; } }
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    for (let n = Math.min(3, toks.length - i); n >= 1 && !hit; n--) {
      const c = vocab.cities.get(toks.slice(i, i + n).join(' '));
      if (c) hit = { len: n, item: { t: 'city', v: c } };
    }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    if ((m = /^r-?(\d{2,3})([a-z])?$/.exec(tk))) { items.push({ t: 'ref', v: `R-${m[1]}${(m[2] ?? '').toUpperCase()}` }); i++; continue; }
    if ((m = /^(\d+(?:\.\d+)?)-?tons?$/.exec(tk))) { items.push({ t: 'ton', v: Number(m[1]) }); i++; continue; }
    if (/^\d+(?:\.\d+)?$/.test(tk) && /^tons?$/.test(toks[i + 1] ?? '')) { items.push({ t: 'ton', v: Number(tk) }); i += 2; continue; }
    // entity nouns
    for (const [ws, kind] of NOUNS) { if (eq(ws, i)) { hit = { len: ws.length, item: { t: 'subj', v: kind, w: ws.join(' ') } }; break; } }
    if (hit) { items.push(hit.item); i += hit.len; continue; }
    if (building && (tk === 'building' || tk === 'complex')) { items.push({ t: 'bldg' }); i++; continue; }
    if ((m = /^(\$?)(\d+(?:\.\d+)?)$/.exec(tk))) { items.push({ t: 'num', v: Number(m[2]), dollar: m[1] === '$' }); i++; continue; }
    if (tk in NUMW) { items.push({ t: 'num', v: NUMW[tk], dollar: false, word: true }); i++; continue; }
    items.push({ t: 'w', v: tk });
    i++;
  }
  // "Rebecca Montoya's city" -> the same city as Rebecca Montoya; "who've" repaired into "whose"
  for (let i = 0; i < items.length; i++) {
    if (items[i].t === 'name' && items[i].role === 'customer' && items[i + 1]?.t === 'subj' && items[i + 1].v === 'city') {
      items.splice(i, 2, { t: 'p', v: 'samecity' }, items[i]);
      if (items[i - 1]?.t === 'w' && /^(?:in|from|at)$/.test(items[i - 1].v)) { items.splice(i - 1, 1); i--; }
    }
    if (items[i].t === 'w' && items[i].v === 'whose' && items[i + 1]?.t === 'w' && /^(?:seen|been|had|got|gotten|worked|have|has|ever|never)$/.test(items[i + 1].v)) items[i] = { t: 'w', v: 'who' };
  }
  // small phrases
  const out = [];
  for (let i = 0; i < items.length;) {
    let done = false;
    for (const [ws, tag] of PHRASES) {
      if (i + ws.length > items.length) continue;
      if (ws.every((w, k) => items[i + k].t === 'w' && items[i + k].v === w)) {
        for (const g of [].concat(tag ?? [])) out.push({ t: 'p', v: g });
        i += ws.length; done = true; break;
      }
    }
    if (!done) { out.push(items[i]); i++; }
  }
  return out;
}

/* ====================================================================== grammar: predicate lists */

const FAIL = null;

/**
 * items -> {all, none, any}: AND of `all`, AND NOT of each in `none`, OR group `any`.
 * ctx.subj: 'customer' | 'unit' | 'city' | 'tech'
 */
function parsePreds(items, ctx) {
  let E = { all: [], none: [], any: [] };
  const st = { negNext: false, negWord: null, joinNext: null, last: null, clause: true, bundle: null, installCue: false, svcPending: null, moneyCue: false, visitCtx: false, afterNegAnd: false, orGroup: false, elseWord: false, exclSeen: false, bothSeen: false, lastConj: null };
  const fail = () => { throw FAIL; };
  const SUB = ctx.subj;

  const emit = (pred) => {
    const neg = st.negNext;
    if (st.afterNegAnd && !neg) fail();
    let bucket = 'all';
    if (neg) bucket = 'none';
    else if (st.orGroup || st.joinNext === 'or') bucket = 'any';
    if (bucket === 'any' && E.all.length) fail();
    if (bucket === 'all' && E.any.length) fail();
    E[bucket].push(pred);
    st.last = { pred, bucket, neg };
    st.negNext = false; st.joinNext = null; st.clause = false; st.afterNegAnd = false; st.negWord = neg ? st.negWord : null;
    return pred;
  };
  const bundleAdd = (filter) => {
    if (st.bundle && !st.clause && st.last && st.last.pred === st.bundle) {
      // two different brands / cities / refrigerants cannot both describe one unit
      if (['brand', 'city', 'refrigerant', 'warrantyStatus'].includes(filter.field) && st.bundle.f.some((g) => g.field === filter.field)) fail();
      st.bundle.f.push(filter); return;
    }
    st.bundle = emit({ k: SUB === 'unit' ? 'ufield' : 'unit', f: [filter], cmp: null });
  };
  const qty = (op, n) => ({ op, n });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const nx = () => items[i + 1];
    switch (it.t) {
      case 'w': {
        const v = it.v;
        if (MONEY_VERBS.has(v) && SUB === 'customer') {
          // "spent more than 5000", "billed under 1000", "total billings over $5,000"
          let j = i + 1; while (items[j]?.t === 'w' && /^(?:total|a|an|the|more|over)$/.test(items[j].v)) j++;
          if (items[j]?.t === 'p' && /^cmp_/.test(items[j].v) && items[j + 1]?.t === 'num') { st.moneyCue = true; break; }
          if (v === 'billed' || v === 'invoiced') { emit({ k: 'doc', type: 'invoice', visit: false, cmp: null, word: 'invoice' }); break; }
          fail();
        }
        if (v === 'total' && /^(?:billings|billing|billed|invoiced)$/.test(items[i + 1]?.v ?? '')) break;
        if (v in VERB_DOC && !(MONEY_VERBS.has(v))) { emit({ k: ctx.subj === 'unit' ? 'udoc' : 'doc', type: VERB_DOC[v], visit: false, cmp: null, word: VERB_WORD[v], verb: v }); break; }
        if (VISIT_WORDS.has(v)) {
          st.visitCtx = true;
          if (v === 'service' && (items[i + 1]?.t === 'doc' || items[i + 1]?.t === 'subj')) fail(); // "service invoice": a qualifier this family cannot apply
          // "called us for service three or more times": the count that follows makes the visit atom
          let j = i + 1; while (j < items.length && j <= i + 4 && ((items[j].t === 'w' && AW.has(items[j].v)) || (items[j].t === 'p' && /^cmp_/.test(items[j].v)))) j++;
          if (items[j]?.t === 'num') break;
          emit({ k: ctx.subj === 'unit' ? 'udoc' : 'doc', type: null, visit: true, cmp: null, word: 'service visit' }); break;
        }
        if (v === 'installed' || v === 'install') {
          if (items[i + 1]?.t === 'w' && items[i + 1].v === 'date') { if (SUB !== 'unit') fail(); bundleAdd({ field: 'installDate', op: 'present', label: 'with an installation date' }); i++; break; }
          if (items[i + 1]?.t === 'time') { st.installCue = true; break; }
          if (SUB === 'unit' && v === 'installed') { bundleAdd({ field: 'installDate', op: 'present', label: 'with an installation date' }); break; }
          fail();
        }
        if (v === 'called' || v === 'came' || v === 'come') { st.visitCtx = true; break; }
        // "... no agreement and are in Tucson" / "... and have a permit": a verb starts a new, positive clause
        if (st.afterNegAnd && /^(?:are|is|was|were|have|has|had|live|lives|living|located|based|own|owns|got|get)$/.test(v)) { st.afterNegAnd = false; break; }
        if (v === 'else' || v === 'other' || v === 'others') { st.elseWord = true; break; }
        if (v === 'times' && st.visitCtx) { fail(); }
        if (/^(?:years?|yrs?|old)$/.test(v)) fail();
        if (AW.has(v)) break;
        fail();
        break;
      }
      case 'subj': {
        if (/^install/.test(it.w ?? '')) {
          if (items[i + 1]?.t === 'w' && items[i + 1].v === 'date' && SUB === 'unit') { bundleAdd({ field: 'installDate', op: 'present', label: 'with an installation date' }); i++; break; }
          fail();
        }
        if (it.v === 'brand' || it.v === 'year' || it.v === 'month' || it.v === 'city' || it.v === 'tech' || it.v === 'customer') fail();
        if (it.v === 'visit' && items[i - 1]?.t === 'cat') { st.visitCtx = true; break; } // "a PM visit": the visit is the noun of the kind of service just named, not a second condition
        if (it.v === 'visit') { st.visitCtx = true; emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: null, visit: true, cmp: null, word: 'service visit' }); break; }
        if (it.v === 'unit') {
          if (SUB === 'unit') fail();
          if (items[i + 1]?.t === 'w' && /^(?:with|that|which|has|have|having|where|whose)$/.test(items[i + 1].v) && (items.slice(i + 2, i + 5).some((x) => x.t === 'doc' || x.t === 'cat'))) fail(); // "a unit with a startup sheet": the paper must belong to that unit
          if (st.bundle && !st.clause && st.last && st.last.pred === st.bundle) break; // "Carrier units": the noun of the bundle
          st.bundle = emit({ k: 'unit', f: [], cmp: null }); break;
        }
        if (it.v === 'document') {
          if (SUB === 'unit') fail();
          emit({ k: 'doc', type: null, visit: false, cmp: null, word: 'document' }); break;
        }
        fail();
        break;
      }
      case 'doc': {
        if (/^(?:hr-letter|internal)$/.test(it.id)) fail();
        const pred = { k: SUB === 'unit' ? 'udoc' : 'doc', type: it.id, visit: false, cmp: null, word: it.word };
        if (st.svcPending) { if (it.id !== 'service-ticket') fail(); pred.svc = st.svcPending; st.svcPending = null; }
        emit(pred);
        if ((items[i + 1]?.t === 'w' && /^(?:list|lists|file|files|records?)$/.test(items[i + 1].v)) || (items[i + 1]?.t === 'subj' && items[i + 1].v === 'document')) i++;
        break;
      }
      case 'cat': {
        if (nx()?.t === 'doc' && nx().id === 'service-ticket') { st.svcPending = it.v; break; }
        if (nx()?.t === 'doc') fail();
        // "a repair", "no preventive maintenance": a service ticket of that kind
        emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: 'service-ticket', visit: false, cmp: null, word: 'ticket', svc: it.v });
        break;
      }
      case 'brand': bundleAdd({ field: 'brand', op: 'eq', value: it.v }); break;
      case 'ref': bundleAdd({ field: 'refrigerant', op: 'eq', value: it.v }); break;
      case 'ton': {
        let op = 'eq';
        if (nx()?.t === 'p' && nx().v === 'ormore') { op = 'gte'; i++; } else if (nx()?.t === 'p' && nx().v === 'orless') { op = 'lte'; i++; }
        bundleAdd({ field: 'tonnage', op, value: it.v });
        break;
      }
      case 'city': {
        if (SUB === 'unit') bundleAdd({ field: 'city', op: 'eq', value: it.v });
        else emit({ k: 'city', value: it.v });
        break;
      }
      case 'name': {
        if (it.role === 'tech') { if (SUB !== 'customer' && SUB !== 'unit') fail(); emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: null, visit: false, cmp: null, tech: it.display, word: '' }); break; }
        if (it.role === 'customer') {
          if (st.negNext && SUB === 'customer') { st.exclSeen = true; emit({ k: 'isName', name: it.display }); break; }
          if (SUB === 'tech') { emit({ k: 'servedCust', name: it.display }); break; }
        }
        fail();
        break;
      }
      case 'time': {
        const span = { from: it.span.from, to: it.span.to, label: it.span.label };
        if (st.installCue) { st.installCue = false; bundleAdd({ field: 'installDate', op: 'between', value: [span.from, span.to], label: `installed ${span.label}` }); break; }
        if (st.clause && st.last) {
          const lp = st.last.pred;
          if (lp.k !== 'doc' && lp.k !== 'udoc') fail();
          // "a visit in 2024 and 2025" can mean either year: only "both" or a negation ("but not 2025") makes it a second condition
          if (!st.negNext && st.joinNext === 'and' && st.lastConj === 'and' && !st.bothSeen) fail();
          emit({ ...lp, time: span });
          break;
        }
        const lp = st.last?.pred;
        if (lp && (lp.k === 'doc' || lp.k === 'udoc' || lp.k === 'billed') && !lp.time) { lp.time = span; break; }
        fail();
        break;
      }
      case 'num': {
        // "3 or more invoices", "two or more times"
        const n = it.v;
        if (nx()?.t === 'p' && (nx().v === 'ormore' || nx().v === 'orless')) {
          const op = nx().v === 'ormore' ? 'gte' : 'lte';
          i++;
          i = readCountNoun(op, n, i);
          break;
        }
        // "with 3 invoices", "zero visits": exactly that many
        if (nx() && (nx().t === 'doc' || (nx().t === 'subj' && (nx().v === 'visit' || nx().v === 'unit')))) { i = readCountNoun('eq', n, i); break; }
        fail();
        break;
      }
      case 'p': {
        const v = it.v;
        if (/^cmp_/.test(v) || v === 'age_gt' || v === 'age_lt') {
          const numIt = nx();
          if (numIt?.t === 'ton') {
            const op = { cmp_gt: 'gt', cmp_gte: 'gte', cmp_lt: 'lt', cmp_lte: 'lte', cmp_eq: 'eq' }[v];
            if (!op) fail();
            bundleAdd({ field: 'tonnage', op, value: numIt.v });
            i++; break;
          }
          if (numIt?.t === 'w' && numIt.v === 'once') {
            const lp = st.last?.pred;
            if (!lp || !(lp.k === 'doc' || lp.k === 'udoc') || lp.cmp) fail();
            const op1 = { cmp_gt: 'gt', cmp_gte: 'gte' }[v];
            if (!op1) fail();
            lp.cmp = qty(op1, 1); i++; break;
          }
          if (numIt?.t !== 'num') fail();
          const n = numIt.v;
          let op = { cmp_gt: 'gt', cmp_gte: 'gte', cmp_lt: 'lt', cmp_lte: 'lte', cmp_eq: 'eq', age_gt: 'gt', age_lt: 'lt' }[v];
          i++;
          // "at least 3 or more" style tails
          if (items[i + 1]?.t === 'p' && (items[i + 1].v === 'ormore' || items[i + 1].v === 'orless')) { if (op === 'gt' || op === 'lt') fail(); i++; }
          // money
          if (SUB === 'customer' && (st.moneyCue || numIt.dollar || /^(?:dollars?|bucks)$/.test(items[i + 1]?.v ?? ''))) {
            if (/^(?:dollars?|bucks)$/.test(items[i + 1]?.v ?? '')) i++;
            if (v.startsWith('age_')) fail();
            st.moneyCue = false;
            if (items.some((it) => it.t === 'doc' && it.id !== 'invoice')) fail(); // an amount beside another kind of paper ("tenants on leases over $22,500") is not what an invoice was billed
            emit({ k: 'billed', cmp: qty(op, n) });
            break;
          }
          // age
          if ((items[i + 1]?.t === 'w' && /^(?:years?|yrs?)$/.test(items[i + 1].v)) || (items[i + 1]?.t === 'subj' && items[i + 1].v === 'year')) {
            i++;
            if (items[i + 1]?.t === 'w' && items[i + 1].v === 'old') i++;
            bundleAdd({ field: 'age', op, value: n, label: `${op === 'gt' ? 'older than' : op === 'lt' ? 'newer than' : op === 'gte' ? 'at least' : op === 'lte' ? 'at most' : 'exactly'} ${n} years` });
            break;
          }
          if (v.startsWith('age_')) fail();
          i = readCountNoun(op, n, i);
          break;
        }
        if (v === 'neg_excl') { st.negNext = true; st.negWord = 'except'; st.clause = true; st.joinNext = 'and'; break; }
        if (NEG_WORD[v]) {
          if (st.negNext && v !== 'neg_nor') fail(); // "not no", "never not"
          st.negNext = true; st.negWord = NEG_WORD[v]; st.clause = true;
          break;
        }
        if (v === 'conj_but') { st.joinNext = 'and'; st.clause = true; st.afterNegAnd = false; st.lastConj = 'but'; break; }
        if (v === 'conj_and') {
          if (st.last?.neg && !st.negNext) st.afterNegAnd = true;
          st.joinNext = 'and'; st.clause = true; st.lastConj = 'and'; break;
        }
        if (v === 'conj_or') {
          if (st.last?.neg) { st.negNext = true; st.clause = true; st.joinNext = 'and'; break; }
          // a positive "A or B": move the first atom into the OR group
          if (!st.last) fail();
          if (st.last.bucket === 'all') {
            if (E.all.length !== 1 || E.any.length) fail();
            E.any.push(E.all.pop()); st.last.bucket = 'any';
          }
          st.orGroup = true; st.joinNext = 'or'; st.clause = true; break;
        }
        if (v === 'both') { st.bothSeen = true; break; }
        if (v === 'either') break;
        if (v === 'warr_out') { bundleAdd({ field: 'warrantyStatus', op: 'eq', value: 'expired', label: 'out of warranty' }); break; }
        if (v === 'warr_in') { bundleAdd({ field: 'warrantyStatus', op: 'in', value: ['active', 'expiring'], label: 'in warranty' }); break; }
        if (v === 'multiunit') { if (SUB !== 'customer') fail(); emit({ k: 'unit', f: [], cmp: qty('gte', 2) }); break; }
        if (v === 'repeat') {
          if (SUB !== 'customer') fail();
          emit({ k: 'doc', type: null, visit: true, cmp: qty('gte', 2), word: 'service visit', repeat: true });
          break;
        }
        if (v === 'samecity') {
          if (SUB !== 'customer' || nx()?.t !== 'name' || nx().role !== 'customer') fail();
          const nm = nx().display; i++;
          emit({ k: 'cityOf', name: nm });
          st.exclSeen = true;
          E.none.push({ k: 'isName', name: nm });
          break;
        }
        fail();
        break;
      }
      case 'bldg': break;
      default: fail();
    }
  }
  function readCountNoun(op, n, i) {
    const a = items[i + 1];
    if (!a) fail();
    const o = { gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', eq: 'eq' }[op];
    if (a.t === 'doc') {
      if (/^(?:hr-letter|internal)$/.test(a.id)) fail();
      emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: a.id, visit: false, cmp: qty(o, n), word: a.word });
      return i + 1;
    }
    if (a.t === 'subj' && a.v === 'visit') { st.visitCtx = true; emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: null, visit: true, cmp: qty(o, n), word: 'service visit' }); return i + 1; }
    if (a.t === 'subj' && a.v === 'unit' && SUB === 'customer') { emit({ k: 'unit', f: [], cmp: qty(o, n) }); return i + 1; }
    if ((a.t === 'brand' || a.t === 'ref') && SUB === 'customer') {
      const filt = a.t === 'brand' ? { field: 'brand', op: 'eq', value: a.v } : { field: 'refrigerant', op: 'eq', value: a.v };
      st.bundle = emit({ k: 'unit', f: [filt], cmp: qty(o, n) });
      return items[i + 2]?.t === 'subj' && items[i + 2].v === 'unit' ? i + 2 : i + 1;
    }
    if (a.t === 'w' && a.v === 'times' && st.visitCtx) { emit({ k: SUB === 'unit' ? 'udoc' : 'doc', type: null, visit: true, cmp: qty(o, n), word: 'service visit' }); return i + 1; }
    if (a.t === 'w' && a.v === 'times') fail();
    return fail();
  }
  if (st.negNext || st.joinNext === 'or' || st.svcPending || st.installCue || st.moneyCue) fail();
  // "units serviced by Kevin Pratt": the service visit and the technician describe the same papers
  {
    const plain = E.all.findIndex((p) => (p.k === 'doc' || p.k === 'udoc') && p.visit && !p.type && !p.tech && !p.cmp && !p.time && !p.repeat);
    const withTech = E.all.findIndex((p) => (p.k === 'doc' || p.k === 'udoc') && p.tech && !p.type && !p.visit);
    if (plain >= 0 && withTech >= 0) { E.all[withTech] = { ...E.all[withTech], visit: true }; E.all.splice(plain, 1); }
  }
  // "repeat clients with more than one invoice": the count that is written out defines what repeat means here
  if (E.all.some((p) => p.repeat) && E.all.some((p) => (p.k === 'doc' || p.k === 'unit') && p.cmp && !p.repeat)) E.all = E.all.filter((p) => !p.repeat);
  // "repeat clients for engagement letters": repeat visits, or repeat letters? Too open to guess, so it is released
  if (E.all.some((p) => p.repeat) && E.all.some((p) => (p.k === 'doc' || p.k === 'udoc') && p.type && !p.repeat)) fail();
  if (st.elseWord && !st.exclSeen) fail();
  // "customers in Mesa and Tucson": a customer lives in one city, so the intersection is empty by construction - released, not answered
  if (E.all.filter((p) => p.k === 'city').length > 1) fail();
  if (E.all.filter((p) => (p.k === 'doc' || p.k === 'udoc') && p.tech && !p.type).length > 1 && !st.bothSeen) fail();
  return E;
}

function tryParsePreds(items, ctx) {
  try { return parsePreds(items, ctx); } catch (e) { if (e === FAIL) return null; throw e; }
}

/* ====================================================================== grammar: sentence */

const HEAD_KINDS = new Set(['customer', 'unit', 'tech', 'city']);

/** Split off the head noun (what is being selected). Returns {head, rest, headIdx} or null. */
function splitHead(items) {
  const nIdx = items.findIndex((it) => it.t === 'subj' && HEAD_KINDS.has(it.v));
  // "who has a unit installed before 2012": people are customers, and "who" before the first noun says the question is about them
  const wIdx = items.findIndex((it) => it.t === 'w' && /^(?:who|whos|whove|anyone|anybody|someone)$/.test(it.v));
  let idx = nIdx; let head = nIdx >= 0 ? items[nIdx].v : null; let drop = [];
  if (wIdx >= 0 && (nIdx < 0 || wIdx < nIdx)) {
    idx = wIdx; head = 'customer';
    if (nIdx >= 0 && items[nIdx].v === 'customer') drop = [nIdx];
  } else if (idx >= 0) {
    // a kind of paper or a visit written before the head is what is selected ("repair tickets on Trane equipment"), unless it just describes the head ("agreement customers")
    for (let k = 0; k < idx; k++) {
      const it = items[k];
      if ((it.t === 'doc' || it.t === 'cat' || (it.t === 'subj' && (it.v === 'visit' || it.v === 'document'))) && !(items[k + 1] === items[idx])) return null;
    }
  }
  if (idx < 0) return null;
  // "list all customers ...", "show all the units ...": "all" right before the head noun only says "every one of them"
  let a = idx - 1; if (items[a]?.t === 'w' && /^(?:the|our|of)$/.test(items[a].v)) a--;
  if (nIdx === idx && items[a]?.t === 'w' && items[a].v === 'all') drop.push(a);
  return { head, rest: items.filter((_, k) => k !== idx && !drop.includes(k)), headIdx: idx };
}

const isP = (it, ...tags) => it.t === 'p' && tags.includes(it.v);

/** The mode words (how many / percent of ...) removed; returns {mode, items}. */
function takeMode(items) {
  let mode = 'list';
  const out = [];
  for (const it of items) {
    if (isP(it, 'q_count')) { mode = 'count'; continue; }
    if (isP(it, 'q_share')) { mode = 'share'; continue; }
    out.push(it);
  }
  return { mode, items: out };
}

/** The general sentence: head noun + predicates -> set_select plan. */
function parseSelect(items0, vocab) {
  const hasSpecial = items0.some((it) => isP(it, 'avg', 'ratio', 'rank', 'per'));
  if (hasSpecial) return null;
  const { mode, items: items1 } = takeMode(items0);
  const hd = splitHead(items1);
  if (!hd) return null;
  const subj = hd.head;
  // a building phrase names the group of customers asked about
  let scope = null;
  let rest = hd.rest;
  const bi = rest.findIndex((it) => it.t === 'bldg');
  if (bi >= 0) {
    if (subj !== 'customer') return null;
    let a = bi; while (a - 1 >= 0 && rest[a - 1].t === 'w' && !AW.has(rest[a - 1].v) && bi - (a - 1) <= 4) a--;
    const phrase = rest.slice(a, bi).map((it) => it.v).join(' ');
    if (!phrase) return null;
    scope = { building: phrase };
    rest = [...rest.slice(0, a), ...rest.slice(bi + 1)];
  }
  if (mode === 'share') {
    // "percent of <base> that/are/have <condition>"
    const ci = rest.findIndex((it, k) => it.t === 'w' && /^(?:are|is|have|has|had|that|who|which|with|in|were|was|having|got)$/.test(it.v) && k >= 0);
    // the base is whatever sits before the condition word and is an attribute of the head (brand, city, ref ...)
    let baseItems = []; let condItems = rest;
    if (ci >= 0) {
      const before = rest.slice(0, ci);
      if (before.every((it) => ['brand', 'city', 'ref', 'ton'].includes(it.t) || (it.t === 'w' && AW.has(it.v)))) {
        baseItems = before.filter((it) => it.t !== 'w'); condItems = rest.slice(ci);
      }
    }
    // attributes written before the head noun ("Trane units that ...") sit in `rest` already; take the leading ones as the base
    if (!baseItems.length && hd.headIdx > 0) {
      const pre = items1.slice(0, hd.headIdx).filter((it) => ['brand', 'city', 'ref', 'ton'].includes(it.t));
      if (pre.length) { baseItems = pre; condItems = rest.filter((it) => !pre.includes(it)); }
    }
    if (!condItems.some((it) => it.t !== 'w' || !AW.has(it.v))) return null;
    const cond = tryParsePreds(condItems, { subj, vocab });
    if (!cond) return null;
    let base = { all: [], none: [], any: [] };
    if (baseItems.length) { base = tryParsePreds(baseItems, { subj, vocab }); if (!base) return null; }
    return { v: 1, op: 'set_select', entity: subj, mode: 'share', expr: cond, base, scope };
  }
  const expr = tryParsePreds(rest, { subj, vocab });
  if (!expr) return null;
  if (!expr.all.length && !expr.none.length && !expr.any.length && !scope) return null;
  if (subj === 'tech' && (expr.all.some((p) => p.k !== 'servedCust') || expr.all.length !== 1 || expr.none.length || expr.any.length)) return null;
  if (subj === 'city' && [...expr.all, ...expr.none, ...expr.any].some((p) => !['doc'].includes(p.k) || p.tech)) return null;
  if (subj !== 'tech' && [...expr.all, ...expr.none, ...expr.any].some((p) => p.k === 'servedCust')) return null;
  if (subj === 'unit' && [...expr.all, ...expr.none, ...expr.any].some((p) => ['doc', 'billed', 'city', 'cityOf', 'isName', 'unit', 'building'].includes(p.k))) return null;
  if (subj === 'city' && mode === 'share') return null;
  return { v: 1, op: 'set_select', entity: subj, mode, expr, base: null, scope };
}

/* ====================================================================== grammar: groups measured against themselves */

const TOTAL_WORDS = /^(?:total|amount|amounts|size|dollars?)$/;
const isMoneyWord = (v) => MONEY_VERBS.has(v) || /^(?:sales|income|dollars?|bucks|earned|charged)$/.test(v);
const DIM_OF_SUBJ = { customer: 'customer', tech: 'tech', city: 'city', brand: 'brand', year: 'year', month: 'month' };
const DIM_PAIRS = {
  customer: ['billed', 'visits', 'docs', 'units', 'tickets'],
  tech: ['tickets', 'visits', 'hours', 'docs', 'billed'],
  city: ['units', 'customers', 'billed', 'visits', 'docs'],
  brand: ['units'],
  year: ['visits', 'docs', 'billed'],
  month: ['visits', 'docs', 'billed'],
};

/**
 * Find the measure named by a stretch of items: {kind: billed|visits|docs|tickets|hours|units|customers, type?}, or null (none / more than one).
 * Everything that is not part of a measure must be function words, a period, or one of the `allow` item kinds (the caller checks the rest).
 */
function measureIn(items) {
  const found = new Set(); let type = null; let svc = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === 'w' && isMoneyWord(it.v) && !/^(?:dollars?|bucks)$/.test(it.v)) found.add('billed');
    else if (it.t === 'w' && /^(?:hours?|hrs?)$/.test(it.v)) found.add('hours');
    else if (it.t === 'w' && /^(?:calls|jobs)$/.test(it.v)) found.add('visits');
    else if (it.t === 'subj' && it.v === 'visit') found.add('visits');
    else if (it.t === 'subj' && it.v === 'unit') found.add('units');
    else if (it.t === 'subj' && it.v === 'document') found.add('docs');
    else if (it.t === 'doc') {
      if (it.id === 'invoice' && items.some((x) => x.t === 'w' && TOTAL_WORDS.test(x.v))) found.add('billed');
      else if (it.id === 'service-ticket') { found.add('tickets'); type = it.id; }
      else { found.add('docs'); type = it.id; }
    } else if (it.t === 'cat') svc = it.v;
  }
  if (found.size !== 1) return null;
  return { kind: [...found][0], type, svc };
}

/** "invoices above average", "customers billed more than the average customer", "techs who did more tickets than average", "which years had more visits than average" */
function parseAbove(items, vocab) {
  const a = items.findIndex((it) => isP(it, 'avg'));
  if (a < 0) return null;
  let c = a - 1;
  while (c >= 0 && items[c].t === 'w' && /^(?:the|our|an|a|of)$/.test(items[c].v)) c--;
  let cmp = null; let cIdx = -1;
  if (c >= 0 && items[c].t === 'w' && items[c].v === 'than') {
    for (let k = c - 1; k >= Math.max(0, c - 6); k--) {
      if (items[k].t === 'w' && /^(?:more|higher|bigger|larger|greater)$/.test(items[k].v)) { cmp = 'cmp_gt'; cIdx = k; break; }
      if (items[k].t === 'w' && /^(?:less|fewer|lower|smaller|cheaper)$/.test(items[k].v)) { cmp = 'cmp_lt'; cIdx = k; break; }
    }
  } else if (c >= 0 && isP(items[c], 'cmp_gt', 'cmp_lt', 'age_gt', 'age_lt')) { cmp = items[c].v; cIdx = c; }
  if (!cmp) return null;
  const dir = /gt$/.test(cmp) ? 'gt' : 'lt';
  const { mode, items: all0 } = takeMode(items);
  if (mode === 'share') return null;
  // the comparison words themselves are taken out; what is left names the group and the measure
  const a2 = all0.findIndex((it) => isP(it, 'avg'));
  const clean = all0.filter((it, k) => !isP(it, 'avg', 'cmp_gt', 'cmp_lt', 'age_gt', 'age_lt') && !(it.t === 'w' && it.v === 'than' && k >= a2 - 3 && k < a2) && !(it.t === 'w' && /^(?:more|higher|bigger|larger|greater|less|fewer|lower|smaller|cheaper)$/.test(it.v)));
  const times = clean.filter((it) => it.t === 'time');
  if (times.length > 1) return null;
  const time = times[0] ? { from: times[0].span.from, to: times[0].span.to, label: times[0].span.label } : null;
  const hd = clean.find((it) => it.t === 'subj' && ['customer', 'tech', 'unit', 'year', 'month', 'city', 'brand'].includes(it.v));
  const okRest = (list, extraOk) => list.every((it) => it.t === 'time' || (it.t === 'w' && (AW.has(it.v) || TOTAL_WORDS.test(it.v) || /^(?:invoice|invoices)$/.test(it.v))) || (it.t === 'p' && it.v === 'both') || extraOk(it));
  // ---- units older / newer than the average of a brand
  if (hd?.v === 'unit' && (cmp === 'age_gt' || cmp === 'age_lt')) {
    const brands = clean.filter((it) => it.t === 'brand');
    if (brands.length > 1) return null;
    if (!okRest(clean, (it) => it === hd || it.t === 'brand')) return null;
    return { v: 1, op: 'set_above_avg', entity: 'unit', dir: cmp === 'age_gt' ? 'gt' : 'lt', benchmark: brands[0] ? { brand: brands[0].v } : null, mode };
  }
  if (cmp.startsWith('age_')) return null;
  // ---- one kind of paper ("invoices above average", "estimates above the average estimate")
  if (!hd) {
    const docs = clean.filter((it) => it.t === 'doc');
    const ids = [...new Set(docs.map((d) => d.id))];
    if (ids.length !== 1 || /^(?:hr-letter|internal)$/.test(ids[0])) return null;
    if (!okRest(clean, (it) => it.t === 'doc')) return null;
    return { v: 1, op: 'set_above_avg', entity: 'document', type: ids[0], word: docs[0].word, dir, time, mode };
  }
  if (!['customer', 'tech', 'year', 'month', 'city', 'brand'].includes(hd.v)) return null;
  const m = measureIn(clean);
  if (!m) return null;
  if (!DIM_PAIRS[DIM_OF_SUBJ[hd.v]]?.includes(m.kind)) return null;
  if (!okRest(clean, (it) => it === hd || it.t === 'doc' || it.t === 'cat' || (it.t === 'subj' && ['visit', 'unit', 'document'].includes(it.v)) || (it.t === 'w' && /^(?:hours?|hrs?|labor|calls|jobs|spent|spend|billed|invoiced|billings?|revenue|sales|did|had|have|has|with|who|which|are|is|were|was|do|done|completed|worked|made|brought|total)$/.test(it.v)))) return null;
  if (m.svc && m.kind !== 'tickets') return null;
  return { v: 1, op: 'set_above_avg', entity: 'group', dim: DIM_OF_SUBJ[hd.v], measure: m, dir, time, mode };
}

/** "where does X rank among customers by total billed", "rank of Mesa among cities by unit count", "what rank is 2026 for visit count" */
function parseRank(items, vocab) {
  if (!items.some((it) => isP(it, 'rank'))) return null;
  let target = null; let dimWord = null; let countWord = false; const rest = [];
  for (const it of items) {
    if (isP(it, 'rank') || it.t === 'bldg') continue;
    if (isP(it, 'q_count')) { countWord = true; continue; }
    if (it.t === 'name' && (it.role === 'customer' || it.role === 'tech')) { if (target) return null; target = { dim: it.role, name: it.display }; continue; }
    if (it.t === 'city') { if (target) return null; target = { dim: 'city', value: it.v }; continue; }
    if (it.t === 'brand') { if (target) return null; target = { dim: 'brand', value: it.v }; continue; }
    if (it.t === 'time' && /^\d{4}-01-01$/.test(it.span.from) && it.span.to === `${it.span.from.slice(0, 4)}-12-31`) { if (target) return null; target = { dim: 'year', value: it.span.from.slice(0, 4) }; continue; }
    if (it.t === 'subj' && DIM_OF_SUBJ[it.v] && !(it.v === 'city' && false)) {
      if (dimWord && dimWord !== DIM_OF_SUBJ[it.v]) return null;
      // "how many customers" style nouns can also be the measure (cities by customers): the first one is the group, a second is the measure
      dimWord = DIM_OF_SUBJ[it.v]; continue;
    }
    rest.push(it);
  }
  if (!target) return null;
  const dim = dimWord ?? target.dim;
  if (dimWord && dimWord !== target.dim) return null;
  // a year-by-year rank sets the year still running (a part year) against full years, and equal years share a place in some books and not in others: not claimed
  if (dim === 'year') return null;
  const m = measureIn(rest);
  if (!m) {
    // cities by customers: the second noun
    return null;
  }
  if (!DIM_PAIRS[dim]?.includes(m.kind)) return null;
  const okRest = rest.every((it) => it.t === 'doc' || it.t === 'cat' || it.t === 'subj' || (it.t === 'w' && (AW.has(it.v) || /^(?:where|how|does|is|number|rank|among|against|across|other|others|our|all|by|in|total|count|unit|units|amount|revenue|billing|billings|billed|invoiced|spend|spent|hours?|labor|tickets|visits|calls|jobs|rate|compare|compared)$/.test(it.v))) || it.t === 'time');
  if (!okRest) return null;
  // a bare "by invoices" says nothing about count versus amount
  if (m.kind === 'docs' && m.type && /^(?:invoice|proposal-quote|purchase-order|maintenance-agreement)$/.test(m.type) && !countWord && !rest.some((it) => it.t === 'w' && /^(?:count|number)$/.test(it.v))) return null;
  if (m.kind === 'billed' && !rest.some((it) => it.t === 'w' && (MONEY_VERBS.has(it.v) || /^(?:revenue|total|amount|dollars?|sales)$/.test(it.v))) ) return null;
  const times = rest.filter((it) => it.t === 'time');
  if (times.length > 1) return null;
  return { v: 1, op: 'set_rank', dim, target, measure: m, time: times[0] ? { from: times[0].span.from, to: times[0].span.to, label: times[0].span.label } : null };
}

/** One side of a ratio: {kind: doc|visit|unit|customer, type?, svc?, dollars?, filters?, label} */
function ratioSide(list) {
  const docs = list.filter((it) => it.t === 'doc');
  const cats = list.filter((it) => it.t === 'cat');
  const refs = list.filter((it) => it.t === 'ref'); const brands = list.filter((it) => it.t === 'brand');
  const dollars = list.some((it) => it.t === 'w' && /^(?:dollars?|revenue|billed)$/.test(it.v)) || (list.some((it) => it.t === 'w' && /^(?:value|amount)$/.test(it.v)));
  const verbDoc = list.map((it) => (it.t === 'w' ? VERB_DOC[it.v] : null)).find(Boolean);
  const subj = list.filter((it) => it.t === 'subj');
  const ok = list.every((it) => ['doc', 'cat', 'ref', 'brand', 'subj', 'time'].includes(it.t) || (it.t === 'w' && (AW.has(it.v) || /^(?:dollars?|revenue|billed|value|amount|quoted|invoiced|total|installs?)$/.test(it.v))));
  if (!ok) return null;
  if (docs.length > 1 || cats.length > 1 || refs.length + brands.length > 1) return null;
  // every noun of a side must be used by the reading: a paper with a person noun beside it ("units per technician startup") is some other question
  if (docs.length === 1 && subj.length) return null;
  if (subj.length > 1 || (subj.length === 1 && (refs.length + brands.length || cats.length) && subj[0].v !== 'unit')) return null;
  if (docs.length === 1) {
    if (/^(?:hr-letter|internal)$/.test(docs[0].id)) return null;
    if (cats.length && docs[0].id !== 'service-ticket') return null;
    return { kind: 'doc', type: docs[0].id, svc: cats[0]?.v ?? null, dollars, word: docs[0].word, plural: true };
  }
  if (verbDoc && dollars) return { kind: 'doc', type: verbDoc, svc: null, dollars: true, word: verbDoc === 'invoice' ? 'invoice' : 'quote' };
  if (cats.length === 1) return { kind: 'doc', type: 'service-ticket', svc: cats[0].v, dollars: false, word: 'ticket' };
  if (refs.length || brands.length) return { kind: 'unit', filters: [refs[0] ? { field: 'refrigerant', op: 'eq', value: refs[0].v } : { field: 'brand', op: 'eq', value: brands[0].v }], label: refs[0]?.v ?? brands[0].v };
  if (subj.length === 1 && subj[0].v === 'visit') return { kind: 'visit' };
  if (subj.length === 1 && subj[0].v === 'unit') return { kind: 'unit', filters: [], label: 'units' };
  if (subj.length === 1 && subj[0].v === 'customer') return { kind: 'customer' };
  return null;
}

/** "ratio of invoices to proposals", "repair to pm ratio", "visits per invoice" */
function parseRatio(items) {
  const hasRatio = items.some((it) => isP(it, 'ratio'));
  const perIdx = items.findIndex((it) => isP(it, 'per'));
  if (!hasRatio && perIdx < 0) return null;
  if (items.some((it) => isP(it, 'avg', 'rank', 'q_share'))) return null;
  const body = items.filter((it) => !isP(it, 'ratio', 'q_count') && !(it.t === 'w' && /^(?:how|many|much|what|whats|is|the|our|of|a|an)$/.test(it.v)));
  let splitAt = body.findIndex((it) => it.t === 'w' && it.v === 'to');
  let by = 'to';
  if (splitAt < 0 && !hasRatio) { splitAt = body.findIndex((it) => isP(it, 'per')); by = 'per'; }
  if (splitAt < 0) return null;
  const times = body.filter((it) => it.t === 'time');
  if (times.length > 1) return null;
  const A = ratioSide(body.slice(0, splitAt).filter((it) => it.t !== 'time')); const B = ratioSide(body.slice(splitAt + 1).filter((it) => it.t !== 'time'));
  if (!A || !B) return null;
  // "visits per customer" is an average, not a ratio of two papers
  if (by === 'per' && (A.kind === 'customer' || B.kind === 'customer')) return null;
  if ((A.kind === 'doc' && A.dollars) !== (B.kind === 'doc' && B.dollars)) return null;
  return { v: 1, op: 'set_ratio', a: A, b: B, by, time: times[0] ? { from: times[0].span.from, to: times[0].span.to, label: times[0].span.label } : null };
}

/** "average visits per customer", "invoices per client on average", "average billed per customer in 2026" */
function parsePerEntity(items) {
  const withAvg = items.some((it) => isP(it, 'avg'));
  let perIdx = items.findIndex((it) => isP(it, 'per'));
  if (perIdx < 0 && withAvg) perIdx = items.findIndex((it, k) => isP(it, 'each') && items[k + 1]?.t === 'subj' && items[k + 1].v === 'customer');
  // "how many invoices does the typical customer have": the average customer is the subject
  let custIdx = -1; let entity = 'customer';
  if (perIdx >= 0) {
    const nx2 = items[perIdx + 1];
    if (!(nx2?.t === 'subj' && nx2.v === 'customer')) return null;
    entity = nx2.v; custIdx = perIdx + 1;
  }
  else if (withAvg) { custIdx = items.findIndex((it) => it.t === 'subj' && it.v === 'customer'); if (custIdx < 0 || items.some((it) => it.t === 'name')) return null; perIdx = custIdx; }
  else return null;
  const body = items.filter((it, k) => k !== perIdx && k !== custIdx && !isP(it, 'avg', 'q_count'));
  const times = body.filter((it) => it.t === 'time');
  if (times.length > 1) return null;
  const rest = body.filter((it) => it.t !== 'time');
  const m = measureIn(rest);
  if (!m || !['billed', 'visits', 'docs', 'units', 'tickets'].includes(m.kind)) return null;
  // "average statement total per client" asks for an amount, not a number of papers: only the invoice (billed) measure reads money here
  if (m.kind === 'docs' && rest.some((it) => it.t === 'w' && /^(?:total|totals|amount|amounts|dollars?|value|worth|cost|costs|price|prices)$/.test(it.v))) return null;
  // "average invoice per customer": the size of an invoice or the number of invoices - two readings, so it is released
  if (m.kind === 'docs' && m.type && /^(?:invoice|proposal-quote|purchase-order|maintenance-agreement)$/.test(m.type)) {
    const ai = items.findIndex((it) => isP(it, 'avg'));
    const di = items.findIndex((it) => it.t === 'doc');
    if (ai >= 0 && di > ai && di - ai <= 2 && items.slice(ai + 1, di).every((it) => it.t === 'w' && /^(?:the|an|a|our)$/.test(it.v))) return null;
  }
  if (entity === 'unit' && !['visits', 'docs', 'tickets'].includes(m.kind)) return null;
  const okRest = rest.every((it) => it.t === 'doc' || it.t === 'cat' || (it.t === 'subj' && ['visit', 'unit', 'document'].includes(it.v) && !(entity === 'unit' && it.v === 'unit')) || (it.t === 'w' && (AW.has(it.v) || /^(?:how|many|much|total|amount|count|spend|spent|billed|invoiced|billings?|revenue|does|do|average|any|has|have|tickets|visits|calls|jobs|typical)$/.test(it.v))));
  if (!okRest) return null;
  // money papers counted: "invoices per customer" is a count of invoices
  const onlyThose = rest.some((it) => it.t === 'w' && it.v === 'any');
  return { v: 1, op: 'set_per_entity', entity, measure: m, time: times[0] ? { from: times[0].span.from, to: times[0].span.to, label: times[0].span.label } : null, onlyThose };
}

/** "total billed for the Alma School building", "which apartment in the Alma School building was billed the most" */
function parseBuildingStat(items) {
  const bi = items.findIndex((it) => it.t === 'bldg');
  if (bi < 0) return null;
  let a = bi; while (a - 1 >= 0 && items[a - 1].t === 'w' && !AW.has(items[a - 1].v) && !isMoneyWord(items[a - 1].v) && !/^(?:total|most|least|highest|lowest|biggest|largest|smallest|fewest|much|how)$/.test(items[a - 1].v) && bi - (a - 1) <= 4) a--;
  const phrase = items.slice(a, bi).map((it) => it.v).join(' ');
  if (!phrase) return null;
  const rest = [...items.slice(0, a), ...items.slice(bi + 1)];
  if (rest.some((it) => it.t === 'p' && !['avg', 'q_count', 'per'].includes(it.v))) return null;
  const words = rest.filter((it) => it.t === 'w').map((it) => it.v);
  const m = measureIn(rest.filter((it) => !(it.t === 'subj' && it.v === 'customer')));
  if (!m || !['billed', 'visits', 'docs'].includes(m.kind)) return null;
  const most = words.some((w) => /^(?:most|highest|biggest|largest)$/.test(w)); const least = words.some((w) => /^(?:least|lowest|smallest|fewest)$/.test(w));
  const total = words.includes('total') || (words.includes('much') && !most && !least);
  const avg = rest.some((it) => isP(it, 'avg'));
  const head = rest.find((it) => it.t === 'subj' && it.v === 'customer');
  const ok = rest.every((it) => it.t === 'doc' || it.t === 'time' || it.t === 'p' || (it.t === 'subj' && ['customer', 'visit'].includes(it.v)) || (it.t === 'w' && (AW.has(it.v) || isMoneyWord(it.v) || /^(?:total|most|least|highest|lowest|biggest|largest|smallest|fewest|much|how|did|do|does|have|has|we|was|were|been|bill|billed|visits|calls|jobs)$/.test(it.v))));
  if (!ok) return null;
  const times = rest.filter((it) => it.t === 'time');
  if (times.length > 1) return null;
  let agg = null;
  if ((most || least) && head) agg = most ? 'max' : 'min';
  else if (avg && head) agg = 'avg';
  else if (total && !head) agg = 'sum';
  else if (total && head && !most && !least && !avg) agg = 'sum';
  if (!agg) return null;
  return { v: 1, op: 'set_building', building: phrase, measure: m.kind, agg, time: times[0] ? { from: times[0].span.from, to: times[0].span.to, label: times[0].span.label } : null };
}

/** "what percent of our billing comes from Mesa customers", "how much of total billing is from the top 5 customers" */
function parseMoneyShare(items0, vocab) {
  const MONEYW = /^(?:billing|billings|billed|invoicing|invoiced|revenue|sales|income|dollars|business)$/;
  const muchOf = items0.some((it, k) => it.t === 'w' && it.v === 'much' && items0[k + 1]?.t === 'w' && items0[k + 1].v === 'of');
  const share = items0.some((it) => isP(it, 'q_share')) || muchOf;
  if (!share || !items0.some((it) => it.t === 'w' && MONEYW.test(it.v))) return null;
  if (items0.some((it) => it.t === 'bldg' || isP(it, 'avg', 'rank', 'ratio', 'q_count', 'per'))) return null;
  let topN = null;
  const out = [];
  for (let i = 0; i < items0.length; i++) {
    const it = items0[i];
    if (isP(it, 'q_share')) continue;
    if (it.t === 'w' && (MONEYW.test(it.v) || /^(?:how|much|total|comes?|coming|came|share|of)$/.test(it.v))) continue;
    if (it.t === 'w' && it.v === 'top' && items0[i + 1]?.t === 'num') { topN = items0[i + 1].v; i++; continue; }
    out.push(it);
  }
  const hd = splitHead(out);
  if (!hd || hd.head !== 'customer') return null;
  if (topN != null && (!Number.isInteger(topN) || topN < 1 || hd.rest.some((it) => it.t !== 'w'))) return null;
  const expr = hd.rest.length ? tryParsePreds(hd.rest, { subj: 'customer', vocab }) : { all: [], none: [], any: [] };
  if (!expr) return null;
  if (!expr.all.length && !expr.none.length && !expr.any.length && topN == null) return null;
  if ([...expr.all, ...expr.none, ...expr.any].some((p) => p.k === 'billed')) return null;
  return { v: 1, op: 'set_select', entity: 'customer', mode: 'share_billed', expr, base: null, scope: null, topN };
}

/* ====================================================================== the parse entry */

export function parseSets(text0, vocab, today, takeTime) {
  const items = lex(text0, vocab, today, takeTime);
  if (!items || !items.length) return null;
  if (items.length > 40) return null;
  const has = (...tags) => items.some((it) => isP(it, ...tags));
  if (items.some((it) => it.t === 'bldg') && !has('q_share', 'rank', 'ratio')) {
    const b = parseBuildingStat(items);
    if (b) return b;
  }
  if (has('q_share') || items.some((it, k) => it.t === 'w' && it.v === 'much' && items[k + 1]?.v === 'of')) { const ms = parseMoneyShare(items, vocab); if (ms) return ms; }
  if (has('rank')) return parseRank(items, vocab);
  if (has('ratio')) return parseRatio(items);
  if (has('avg')) return parseAbove(items, vocab) ?? parsePerEntity(items);
  if (has('per')) return parsePerEntity(items) ?? parseRatio(items);
  return parseSelect(items, vocab);
}

/* ====================================================================== hook + detect */

function shallowFeat(feat) {
  return { ...feat, filters: [...feat.filters], docTypes: [...feat.docTypes], nouns: { ...feat.nouns }, flags: { ...feat.flags }, cue: { ...(feat.cue ?? {}) }, trig: { ...(feat.trig ?? {}) }, dims: [...feat.dims], times: [...(feat.times ?? [])], sets: undefined };
}

function slots(w, feat, vocab, { takeTime }) {
  if (!feat.text0) return;
  const plan = parseSets(feat.text0, vocab, feat.today, takeTime);
  if (process.env.DQL_DEBUG) console.error('sets:', feat.text0.trim(), '=>', plan ? JSON.stringify(plan).slice(0, 300) : 'no parse');
  if (!plan) return;
  // operational knob: DONOVAN_DQL_SETS_OFF=set_rank,set_per_entity (or "all") turns off those kinds of question; the core family and the router are untouched
  { const off = process.env.DONOVAN_DQL_SETS_OFF; if (off && off.split(',').map((x) => x.trim()).some((x) => x === 'all' || x === plan.op)) return; }
  // a word the jargon layer turned into "customers" (donors, tenants ...) is not a customer for the definition of "repeat"
  if (JSON.stringify(plan).includes('"repeat":true') && !/\b(?:customers?|clients?)\b/i.test(feat.raw ?? '')) return;
  const unexplained = w.left().filter((x) => !FILLER.has(x));
  // If the core family would answer this exact sentence on its own, and every word is already explained without this family, it keeps it.
  const leftover = unexplained.length;
  // "how much of our billing is from Mesa customers" is a share; the core reading of it is the dollar total, which leaves the "of" unexplained
  if (!leftover && plan.mode !== 'share_billed') {
    let claims = true;
    try { claims = Boolean(detectCore(shallowFeat(feat))); } catch (e) { if (process.env.DQL_DEBUG) console.error('sets: core trial threw', e); claims = true; }
    if (claims) return;
  }
  feat.sets = plan;
  w.s = ' '.repeat(w.s.length);
}

function detect(feat) {
  return feat.sets ?? null;
}

/* ====================================================================== exec */

const IX = new WeakMap();
function indexOf(snap) {
  let ix = IX.get(snap);
  if (ix) return ix;
  const docsByCust = new Map(); const docsByUnit = new Map(); const unitsByCust = new Map();
  for (const d of snap.documents) {
    for (const cid of d.custIds ?? []) { if (!docsByCust.has(cid)) docsByCust.set(cid, []); docsByCust.get(cid).push(d); }
    if (d.unitId) { if (!docsByUnit.has(d.unitId)) docsByUnit.set(d.unitId, []); docsByUnit.get(d.unitId).push(d); }
  }
  for (const u of snap.units) if (u.custId) { if (!unitsByCust.has(u.custId)) unitsByCust.set(u.custId, []); unitsByCust.get(u.custId).push(u); }
  const nameCount = new Map();
  for (const c of snap.customers) nameCount.set(lc(c.name), (nameCount.get(lc(c.name)) ?? 0) + 1);
  ix = { docsByCust, docsByUnit, unitsByCust, nameCount };
  IX.set(snap, ix);
  return ix;
}

const cmpOk = (n, cmp) => {
  const c = cmp ?? { op: 'gte', n: 1 };
  switch (c.op) { case 'gt': return n > c.n; case 'gte': return n >= c.n; case 'lt': return n < c.n; case 'lte': return n <= c.n; case 'eq': return n === c.n; default: return false; }
};

function docMatch(d, p) {
  if (p.type && d.type !== p.type) return false;
  if (p.visit && d.serviceDate == null) return false;
  if (p.tech && lc(d.tech) !== lc(p.tech)) return false;
  if (p.svc && lc(d.serviceType) !== lc(p.svc)) return false;
  if (p.time) {
    const v = p.visit ? d.serviceDate : d.date;
    if (!v) return false;
    const day = String(v).slice(0, 10);
    if (day < p.time.from || day > p.time.to) return false;
  }
  return true;
}

function allPreds(expr) { return [...expr.all, ...expr.none, ...expr.any]; }

/** Resolve names in predicates against the snapshot; {abstain} when a name is missing or on file twice. */
function resolvePreds(expr, snap, ix) {
  const R = { ids: new Map() };
  for (const p of allPreds(expr)) {
    if (p.k === 'isName' || p.k === 'cityOf' || p.k === 'servedCust') {
      const m = snap.customers.filter((c) => lc(c.name) === lc(p.name));
      if (m.length > 1) return { abstain: 'ambiguous-name', name: p.name };
      if (m.length === 0) return { abstain: 'name-not-on-file', name: p.name };
      R.ids.set(p.name, m[0]);
    }
  }
  return R;
}

function typesOf(expr) { return [...new Set(allPreds(expr).filter((p) => (p.k === 'doc' || p.k === 'udoc') && p.type).map((p) => p.type))]; }

/** Can a kind of paper be attributed to units? Every one of them is tied to a unit, or the ones that are not belong to customers without equipment. */
function unitResolvable(type, snap, ix) {
  const docs = snap.documents.filter((d) => d.type === type);
  if (!docs.length) return false;
  return docs.every((d) => d.unitId || (d.custIds ?? []).every((cid) => !(ix.unitsByCust.get(cid)?.length)));
}

function evalPred(row, p, subj, x, R) {
  const { snap, today, h } = x; const ix = indexOf(snap);
  switch (p.k) {
    case 'doc': {
      let n = 0;
      for (const d of ix.docsByCust.get(row.id) ?? []) if (docMatch(d, p)) n++;
      return cmpOk(n, p.cmp);
    }
    case 'udoc': {
      let n = 0;
      for (const d of ix.docsByUnit.get(row.id) ?? []) if (docMatch(d, p)) n++;
      return cmpOk(n, p.cmp);
    }
    case 'unit': {
      let n = 0;
      for (const u of ix.unitsByCust.get(row.id) ?? []) if (p.f.every((f) => h.matchFilter(u, f, 'unit', snap, today))) n++;
      return cmpOk(n, p.cmp);
    }
    case 'ufield': return p.f.every((f) => h.matchFilter(row, f, 'unit', snap, today));
    case 'city': return lc(row.city) === lc(p.value);
    case 'cityOf': { const c = R.ids.get(p.name); return c.city != null && lc(row.city) === lc(c.city); }
    case 'isName': return row.id === R.ids.get(p.name).id;
    case 'billed': {
      if (p.time) {
        const inv = (ix.docsByCust.get(row.id) ?? []).filter((d) => d.type === 'invoice' && d.total != null && inWindow(d.date, p.time));
        return inv.length > 0 && cmpOk(inv.reduce((a, d) => a + d.total, 0), p.cmp);
      }
      const st = snap.stats.get(row.id); return Boolean(st && st.billedN > 0 && cmpOk(st.billed, p.cmp));
    }
    case 'building': return R.building?.has(row.id) ?? false;
    default: return false;
  }
}

function evalExpr(row, expr, subj, x, R) {
  for (const p of expr.all) if (!evalPred(row, p, subj, x, R)) return false;
  for (const p of expr.none) if (evalPred(row, p, subj, x, R)) return false;
  if (expr.any.length && !expr.any.some((p) => evalPred(row, p, subj, x, R))) return false;
  return true;
}

function execSelect(plan, x) {
  const { snap } = x; const ix = indexOf(snap);
  const expr = plan.expr;
  const R = resolvePreds(expr, snap, ix);
  if (R.abstain) return { abstain: R.abstain, name: R.name };
  const baseExpr = plan.base ?? { all: [], none: [], any: [] };
  const R2 = resolvePreds(baseExpr, snap, ix);
  if (R2.abstain) return { abstain: R2.abstain };
  for (const [k, v] of R2.ids) R.ids.set(k, v);
  // the kinds of paper asked about must exist on file at all (a kind never filed is not "zero")
  for (const t of typesOf(expr).concat(typesOf(baseExpr))) if (!snap.documents.some((d) => d.type === t)) return { abstain: 'type-not-on-file' };
  const subj = plan.entity;
  if (subj === 'unit') for (const t of typesOf(expr).concat(typesOf(baseExpr))) if (!unitResolvable(t, snap, ix)) return { abstain: 'type-not-tied-to-units' };
  if (plan.scope?.building) { const b = resolveBuilding(plan.scope.building, snap); if (b.abstain) return b; R.building = new Set(b.customers.map((c) => c.id)); R.buildingInfo = b; }
  const caveats = [];
  const unlinked = (t) => snap.documents.filter((d) => d.type === t && !(d.custIds ?? []).length).length;
  if (subj === 'customer' || subj === 'city') for (const t of typesOf(expr)) { const u = unlinked(t); if (u) caveats.push({ type: t, n: u }); }

  let pool;
  if (subj === 'customer') pool = snap.customers;
  else if (subj === 'unit') pool = snap.units;
  else if (subj === 'city') {
    // a city is a row of its own: the customers who live there
    const by = new Map();
    for (const c of snap.customers) if (c.city) { if (!by.has(c.city)) by.set(c.city, []); by.get(c.city).push(c); }
    pool = [...by.entries()].map(([city, custs]) => ({ id: city, city, custs }));
  } else if (subj === 'tech') {
    const techs = new Map();
    for (const d of snap.documents) if (d.tech) { const k = lc(d.tech); if (!techs.has(k)) techs.set(k, d.tech); }
    pool = [...techs.values()].map((name) => ({ id: name, name }));
  } else return { abstain: 'entity' };
  if (R.building && subj === 'customer') pool = pool.filter((c) => R.building.has(c.id));

  const test = (row, e) => {
    if (subj === 'city') return evalCityExpr(row, e, x, R);
    if (subj === 'tech') return evalTechExpr(row, e, x, R);
    return evalExpr(row, e, subj, x, R);
  };
  if (plan.mode === 'share_billed') return execShareBilled(plan, x, pool, R, caveats);
  const baseRows = pool.filter((r) => test(r, baseExpr));
  // "haven't been serviced / invoiced SINCE 2020" is about customers who were, and then stopped: a customer with no such paper at all has not "stopped" and is counted apart
  const lapse = (e) => {
    const only = e.all.length === 0 && e.any.length === 0 && e.none.length === 1 ? e.none[0] : null;
    if (subj !== 'customer' || !only || !only.time || !/^since /.test(only.time.label ?? '') || only.cmp || !(only.k === 'doc' || only.k === 'udoc')) return null;
    const ever = { all: [{ ...only, time: { from: '0000-01-01', to: only.time.to, label: 'ever' } }], none: [], any: [] }; // a paper dated after today has not happened yet: it does not make a customer "lapsed"
    return (r) => test(r, ever);
  };
  const lapsedOf = lapse(expr);
  let never = 0;
  const keepLapsed = (rs, l) => (l ? rs.filter((r) => l(r)) : rs);
  let rows = baseRows.filter((r) => test(r, expr));
  // "not R-410A": a unit with no refrigerant on file is not known to be anything else; it is counted apart, never as "not R-410A"
  let unknown = null;
  if (subj === 'unit') {
    const flds = [...new Set(expr.none.filter((q) => q.k === 'ufield').flatMap((q) => q.f.map((f) => f.field)).filter((f) => ['refrigerant', 'tonnage', 'brand', 'model'].includes(f)))];
    if (flds.length) {
      const blank = (r) => flds.find((f) => r[f] == null || String(r[f]).trim() === '');
      const kept = rows.filter((r) => !blank(r));
      if (kept.length !== rows.length) { unknown = { n: rows.length - kept.length, field: flds.length === 1 ? flds[0] : 'that detail' }; rows = kept; }
    }
  }
  if (lapsedOf) { const kept = keepLapsed(rows, lapsedOf); never = rows.length - kept.length; rows = kept; }
  // "a visit" is any paper with a service date; when counting only service tickets would change the answer, say so (the number, never a second list)
  let alt = null;
  const plainVisit = (p) => (p.k === 'doc' || p.k === 'udoc') && p.visit && !p.type && !p.tech && !p.svc;
  if ((subj === 'customer' || subj === 'unit') && allPreds(expr).concat(allPreds(baseExpr)).some(plainVisit) && snap.documents.some((d) => d.type === 'service-ticket')) {
    const swap = (e) => ({ all: e.all.map(swapOne), none: e.none.map(swapOne), any: e.any.map(swapOne) });
    const swapOne = (p) => (plainVisit(p) ? { ...p, type: 'service-ticket', visit: false } : p);
    const e2 = swap(expr); const b2 = swap(baseExpr);
    const baseRows2 = pool.filter((r) => test(r, b2)); const rows2 = keepLapsed(baseRows2.filter((r) => test(r, e2)), lapse(e2));
    const ids = (xs) => xs.map((r) => r.id).sort().join('|');
    if (ids(rows2) !== ids(rows) || (plan.mode === 'share' && baseRows2.length !== baseRows.length)) alt = { n: rows2.length, den: baseRows2.length };
  }
  return { op: plan.op, entity: subj, mode: plan.mode, rows, base: baseRows, n: rows.length, den: baseRows.length, caveats, R, alt, never, unknown };
}

function execShareBilled(plan, x, pool, R, caveats) {
  const { snap } = x; const ix = indexOf(snap);
  const invs = snap.documents.filter((d) => d.type === 'invoice' && d.total != null);
  if (!invs.length) return { abstain: 'measure-missing' };
  const billedBy = new Map();
  for (const d of invs) for (const cid of d.custIds ?? []) billedBy.set(cid, (billedBy.get(cid) ?? 0) + d.total);
  // an invoice linked to two customers would be counted twice: not worth guessing
  if (invs.some((d) => (d.custIds ?? []).length > 1)) return { abstain: 'shared-invoice' };
  const den = invs.filter((d) => (d.custIds ?? []).length === 1).reduce((a, d) => a + d.total, 0);
  const unlinked = invs.filter((d) => !(d.custIds ?? []).length).length;
  let rows = pool.filter((c) => evalExpr(c, plan.expr, 'customer', x, R));
  if (plan.topN != null) {
    const ranked = rows.filter((c) => billedBy.has(c.id)).sort((a, b) => billedBy.get(b.id) - billedBy.get(a.id) || String(a.name).localeCompare(String(b.name)));
    if (ranked.length > plan.topN && billedBy.get(ranked[plan.topN - 1].id) === billedBy.get(ranked[plan.topN].id)) return { abstain: 'tie-at-cut' };
    rows = ranked.slice(0, plan.topN);
  }
  const num = rows.reduce((a, c) => a + (billedBy.get(c.id) ?? 0), 0);
  return { op: plan.op, entity: 'customer', mode: 'share_billed', rows, n: rows.length, num: Math.round(num * 100) / 100, den: Math.round(den * 100) / 100, unlinked, caveats, R };
}

function evalCityExpr(row, expr, x, R) {
  const { snap } = x; const ix = indexOf(snap);
  const hasDoc = (p) => {
    let n = 0;
    for (const c of row.custs) for (const d of ix.docsByCust.get(c.id) ?? []) if (docMatch(d, p)) n++;
    return cmpOk(n, p.cmp);
  };
  for (const p of expr.all) if (!hasDoc(p)) return false;
  for (const p of expr.none) if (hasDoc(p)) return false;
  if (expr.any.length && !expr.any.some(hasDoc)) return false;
  return true;
}

function evalTechExpr(row, expr, x, R) {
  const { snap } = x; const ix = indexOf(snap);
  for (const p of expr.all) {
    const c = R.ids.get(p.name);
    if (!(ix.docsByCust.get(c.id) ?? []).some((d) => d.tech && lc(d.tech) === lc(row.name))) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- measures over groups */

const inWindow = (day, time) => { if (!time) return true; if (!day) return false; const d = String(day).slice(0, 10); return d >= time.from && d <= time.to; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n) => Math.round(n * 100) / 100;

/** The docs a measure reads: [{doc, v}] (v = the number it contributes). */
function measureDocs(m, snap, time) {
  const out = [];
  for (const d of snap.documents) {
    if (m.kind === 'billed') { if (d.type === 'invoice' && d.total != null && inWindow(d.date, time)) out.push({ doc: d, v: d.total }); }
    else if (m.kind === 'visits') { if (d.serviceDate != null && inWindow(d.serviceDate, time)) out.push({ doc: d, v: 1 }); }
    else if (m.kind === 'tickets') { if (d.type === 'service-ticket' && (!m.svc || lc(d.serviceType) === lc(m.svc)) && inWindow(d.date, time)) out.push({ doc: d, v: 1 }); }
    else if (m.kind === 'docs') { if ((!m.type || d.type === m.type) && inWindow(d.date, time)) out.push({ doc: d, v: 1 }); }
    else if (m.kind === 'hours') { if (d.hours != null && inWindow(d.date, time)) out.push({ doc: d, v: d.hours }); }
  }
  return out;
}
const measureLabel = (m) => ({ billed: 'invoice total', visits: 'service visits', tickets: m.svc ? `${m.svc.toLowerCase()} tickets` : 'service tickets', docs: m.type ? `${documentTypeLabel(m.type)?.toLowerCase() ?? m.type} count` : 'documents', hours: 'labor hours', units: 'units', customers: 'customers' }[m.kind]);
const fmtMeasure = (m, v) => (m.kind === 'billed' ? usd(v) : m.kind === 'hours' ? `${fmtNum(v)} hours` : fmtNum(v));

function typeCheck(m, snap) {
  if (m.type && !snap.documents.some((d) => d.type === m.type)) return { abstain: 'type-not-on-file' };
  return null;
}

/** Value of a measure per group key for one dimension; Map(key -> {value, label}). */
function groupValues(dim, m, snap, time, ix) {
  const out = new Map();
  const add = (key, label, v) => { if (key == null || key === '') return; const k = lc(key); const g = out.get(k); if (g) g.value += v; else out.set(k, { key: k, label, value: v }); };
  const dateKey = (d, kind) => { const v = kind === 'visits' ? d.serviceDate : d.date; return v ? String(v).slice(0, dim === 'year' ? 4 : 7) : null; };
  if (m.kind === 'units') {
    for (const u of snap.units) { if (dim === 'brand') add(brandKey(u.brand), u.brand, 1); else if (dim === 'city') add(u.city, u.city, 1); else if (dim === 'customer') add(u.custId, u.custName, 1); }
    return out;
  }
  if (m.kind === 'customers') {
    for (const c of snap.customers) if (dim === 'city') add(c.city, c.city, 1);
    return out;
  }
  for (const { doc: d, v } of measureDocs(m, snap, time)) {
    if (dim === 'tech') add(d.tech, d.tech, v);
    else if (dim === 'city') add(d.city, d.city, v);
    else if (dim === 'brand') add(brandKey(d.brand), d.brand, v);
    else if (dim === 'customer') add(d.custId, d.custName, v);
    else if (dim === 'year' || dim === 'month') add(dateKey(d, m.kind), dateKey(d, m.kind), v);
  }
  return out;
}

/** Per customer: Map(customerId -> value) for a measure; customers with nothing are 0 for counts and absent for dollars. */
function customerValues(m, snap, time, ix) {
  const out = new Map();
  if (m.kind === 'units') { for (const c of snap.customers) out.set(c.id, (ix.unitsByCust.get(c.id) ?? []).length); return out; }
  if (m.kind === 'billed') {
    for (const d of snap.documents) if (d.type === 'invoice' && d.total != null && inWindow(d.date, time)) for (const cid of d.custIds ?? []) out.set(cid, (out.get(cid) ?? 0) + d.total);
    return out;
  }
  for (const c of snap.customers) out.set(c.id, 0);
  for (const { doc: d, v } of measureDocs(m, snap, time)) for (const cid of d.custIds ?? []) out.set(cid, (out.get(cid) ?? 0) + v);
  return out;
}

function docLabel(d) {
  const num = d.f?.invoice_number ?? d.f?.po_number ?? d.f?.permit_number ?? null;
  const id = num ?? d.filename ?? documentTypeLabel(d.type);
  const bits = [d.custName, d.total != null ? usd(d.total) : null].filter(Boolean);
  return bits.length ? `${id} (${bits.join(', ')})` : id;
}

function execAbove(plan, x) {
  const { snap, today } = x; const ix = indexOf(snap);
  const gt = plan.dir === 'gt';
  const split = (items) => {
    const avg = mean(items.map((o) => o.value));
    const sel = items.filter((o) => (gt ? o.value > avg + 1e-9 : o.value < avg - 1e-9));
    return { avg, sel };
  };
  if (plan.entity === 'document') {
    if (!snap.documents.some((d) => d.type === plan.type)) return { abstain: 'type-not-on-file' };
    const rows = snap.documents.filter((d) => d.type === plan.type && d.total != null && inWindow(d.date, plan.time));
    if (!rows.length) return { abstain: 'measure-missing' };
    const { avg, sel } = split(rows.map((d) => ({ value: d.total, row: d })));
    return { op: plan.op, kind: 'document', pop: rows.length, avg: round2(avg), sel: sel.map((o) => ({ ...o, label: docLabel(o.row) })).sort((a, b) => b.value - a.value), n: sel.length };
  }
  if (plan.entity === 'unit') {
    const age = (u) => { if (!u.installDate) return null; const y = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${u.installDate}T00:00:00Z`)) / (365.25 * 86400000); return y < 0 ? null : y; };
    const bench = snap.units.filter((u) => age(u) != null && (!plan.benchmark?.brand || brandKey(u.brand) === brandKey(plan.benchmark.brand)));
    if (!bench.length) return { abstain: 'measure-missing' };
    const avg = mean(bench.map(age));
    const sel = snap.units.filter((u) => age(u) != null && (gt ? age(u) > avg + 1e-9 : age(u) < avg - 1e-9)).map((u) => ({ row: u, value: age(u) }));
    return { op: plan.op, kind: 'unit', pop: bench.length, avg: round2(avg), sel, n: sel.length };
  }
  if (plan.entity === 'group') {
    const m = plan.measure;
    const tc = typeCheck(m, snap); if (tc) return tc;
    if (plan.dim === 'customer') {
      const vals = customerValues(m, snap, plan.time, ix);
      const pool = snap.customers.filter((c) => vals.has(c.id)).map((c) => ({ row: c, value: vals.get(c.id) }));
      if (!pool.length) return { abstain: 'measure-missing' };
      const { avg, sel } = split(pool);
      return { op: plan.op, kind: 'customer', pop: pool.length, avg: round2(avg), sel: sel.sort((a, b) => b.value - a.value), n: sel.length, allCustomers: snap.customers.length };
    }
    const groups = [...groupValues(plan.dim, m, snap, plan.time, ix).values()];
    if (groups.length < 2) return { abstain: 'too-few-groups' };
    const { avg, sel } = split(groups);
    return { op: plan.op, kind: 'group', pop: groups.length, avg: round2(avg), sel: sel.sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label))), n: sel.length };
  }
  return { abstain: 'entity' };
}

function execRank(plan, x) {
  const { snap } = x; const ix = indexOf(snap);
  const m = plan.measure;
  const tc = typeCheck(m, snap); if (tc) return tc;
  let vals; let targetKey; let targetLabel;
  if (plan.dim === 'customer') {
    const cv = customerValues(m, snap, plan.time, ix);
    const match = snap.customers.filter((c) => lc(c.name) === lc(plan.target.name));
    if (match.length !== 1) return { abstain: match.length ? 'ambiguous-name' : 'name-not-on-file', name: plan.target.name };
    vals = new Map([...cv.entries()].map(([k, v]) => [k, { value: v }]));
    targetKey = match[0].id; targetLabel = match[0].name;
    return rankResult(plan, vals, targetKey, targetLabel, m);
  }
  vals = groupValues(plan.dim, m, snap, plan.time, ix);
  if (plan.dim === 'tech') { targetKey = lc(plan.target.name); targetLabel = plan.target.name; }
  else if (plan.dim === 'city') { targetKey = lc(plan.target.value); targetLabel = plan.target.value; }
  else if (plan.dim === 'brand') { targetKey = lc(brandKey(plan.target.value)); targetLabel = plan.target.value; }
  else { targetKey = String(plan.target.value); targetLabel = String(plan.target.value); }
  return rankResult(plan, vals, targetKey, targetLabel, m);
}
function rankResult(plan, vals, targetKey, targetLabel, m) {
  const list = [...vals.values()].map((o) => o.value);
  const t = vals.get(targetKey);
  if (!list.length) return { abstain: 'measure-missing' };
  if (!t) return { op: plan.op, none: true, label: targetLabel, pop: list.length };
  const v = t.value;
  const above = list.filter((y) => y > v + 1e-9).length; const tied = list.filter((y) => Math.abs(y - v) < 1e-9).length - 1;
  if (tied > 0) return { abstain: 'rank-tie' }; // equal values share a rank in some books and are numbered one after another in others: not guessed
  return { op: plan.op, label: targetLabel, rank: above + 1, pop: list.length, value: v, tied };
}

function sideValue(side, snap, time, h, today) {
  if (side.kind === 'doc') {
    if (!snap.documents.some((d) => d.type === side.type)) return { abstain: 'type-not-on-file' };
    const rows = snap.documents.filter((d) => docMatch(d, { type: side.type, svc: side.svc, time }));
    if (side.dollars) {
      const t = rows.filter((d) => d.total != null);
      if (rows.length && !t.length) return { abstain: 'measure-missing' };
      return { value: t.reduce((a, d) => a + d.total, 0), n: t.length, money: true };
    }
    return { value: rows.length, n: rows.length };
  }
  if (side.kind === 'visit') { const rows = snap.documents.filter((d) => docMatch(d, { visit: true, time })); return { value: rows.length, n: rows.length }; }
  if (side.kind === 'unit') {
    if (time) return { abstain: 'unit-time' };
    const rows = snap.units.filter((u) => side.filters.every((f) => h.matchFilter(u, f, 'unit', snap, today)));
    return { value: rows.length, n: rows.length };
  }
  if (side.kind === 'customer') return { value: snap.customers.length, n: snap.customers.length };
  return { abstain: 'side' };
}

function execRatio(plan, x) {
  const { snap, today, h } = x;
  const a = sideValue(plan.a, snap, plan.time, h, today); if (a.abstain) return a;
  const b = sideValue(plan.b, snap, plan.time, h, today); if (b.abstain) return b;
  return { op: plan.op, a, b, ratio: b.value ? a.value / b.value : null };
}

function execPerEntity(plan, x) {
  const { snap } = x; const ix = indexOf(snap);
  const m = plan.measure;
  const tc = typeCheck(m, snap); if (tc) return tc;
  const isUnit = plan.entity === 'unit';
  let cv; let all; let rows;
  if (isUnit) {
    cv = new Map(snap.units.map((u) => [u.id, 0]));
    for (const { doc: d, v } of measureDocs(m, snap, plan.time)) if (d.unitId && cv.has(d.unitId)) cv.set(d.unitId, cv.get(d.unitId) + v);
    all = snap.units.length; rows = snap.units;
  } else { cv = customerValues(m, snap, plan.time, ix); all = snap.customers.length; rows = snap.customers; }
  if (!all) return { abstain: 'no-denominator' };
  const vals = rows.filter((c) => cv.has(c.id)).map((c) => cv.get(c.id));
  const total = vals.reduce((a, b) => a + b, 0);
  const withSome = vals.filter((v) => v > 0).length;
  if (!withSome) return { abstain: 'measure-missing' };
  return { op: plan.op, total: m.kind === 'billed' ? round2(total) : total, all, withSome, perAll: total / all, perSome: total / withSome };
}

function execBuilding(plan, x) {
  const { snap } = x; const ix = indexOf(snap);
  const b = resolveBuilding(plan.building, snap);
  if (b.abstain) return b;
  const m = { kind: plan.measure };
  const cv = customerValues(m, snap, plan.time, ix);
  const pool = b.customers.filter((c) => cv.has(c.id)).map((c) => ({ row: c, value: cv.get(c.id) }));
  if (!pool.length) return { op: plan.op, street: b.street, n: b.customers.length, none: true };
  const res = { op: plan.op, street: b.street, n: b.customers.length, pop: pool.length };
  if (plan.agg === 'sum') res.value = pool.reduce((a, o) => a + o.value, 0);
  else if (plan.agg === 'avg') res.value = mean(pool.map((o) => o.value));
  else {
    const best = plan.agg === 'max' ? Math.max(...pool.map((o) => o.value)) : Math.min(...pool.map((o) => o.value));
    res.value = best; res.extreme = pool.filter((o) => Math.abs(o.value - best) < 1e-9).map((o) => o.row);
  }
  return res;
}

/* ---------------------------------------------------------------- buildings */

const UNIT_DESIGNATOR = /^(?:apt|apartment|unit|suite|ste|#)\s*\S+/i;
function streetOf(address) {
  const parts = String(address ?? '').split(',').map((s) => s.trim());
  const street = parts[0] ?? '';
  const desig = parts[1] && UNIT_DESIGNATOR.test(parts[1]) ? parts[1] : null;
  return { street, desig };
}
/** A building = a street address shared by two or more customers who each have their own unit designator. */
function resolveBuilding(phrase, snap) {
  const groups = new Map();
  for (const c of snap.customers) {
    const { street, desig } = streetOf(c.address);
    if (!street || !desig) continue;
    const k = lc(street);
    if (!groups.has(k)) groups.set(k, { street, customers: [], desigs: new Set() });
    const g = groups.get(k); g.customers.push(c); g.desigs.add(lc(desig));
  }
  const words = phrase.split(/\s+/).filter(Boolean);
  const hits = [...groups.values()].filter((g) => g.desigs.size >= 2 && words.every((w) => lc(g.street).split(/[\s.]+/).includes(w)));
  if (hits.length !== 1) return { abstain: hits.length ? 'building-ambiguous' : 'building-not-found' };
  return { street: hits[0].street, customers: hits[0].customers };
}

/* ====================================================================== say */

const nounFor = (plan, n) => {
  if (plan.entity === 'customer') return n === 1 ? (plan.custWord ?? 'customer') : `${plan.custWord ?? 'customer'}s`;
  if (plan.entity === 'unit') return n === 1 ? 'unit' : 'units';
  if (plan.entity === 'city') return n === 1 ? 'city' : 'cities';
  if (plan.entity === 'tech') return n === 1 ? 'technician' : 'technicians';
  return 'rows';
};

const cmpWords = { gt: 'more than', gte: 'at least', lt: 'fewer than', lte: 'at most', eq: 'exactly' };
function qtyPhrase(cmp, singularNoun, pluralNoun, lead) {
  if (!cmp || (cmp.op === 'gte' && cmp.n === 1)) return `${art(lead || singularNoun)} ${singularNoun}`;
  if (cmp.op === 'gte') return `${fmtInt(cmp.n)} or more ${pluralNoun}`;
  if (cmp.op === 'lte' && cmp.n === 1) return `at most one ${singularNoun}`;
  if (cmp.op === 'eq' && cmp.n === 0) return `no ${singularNoun}`;
  return `${cmpWords[cmp.op]} ${fmtInt(cmp.n)} ${cmp.n === 1 ? singularNoun : pluralNoun}`;
}
const plur = (w) => (/(s|x|ch|sh)$/.test(w) ? w : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

function unitAdjectives(filters) {
  const adj = []; const tail = [];
  for (const f of filters) {
    if (f.field === 'brand') adj.push(f.value);
    else if (f.field === 'refrigerant') adj.push(f.value);
    else if (f.field === 'tonnage') adj.push(`${f.value} ton${f.op === 'gte' ? ' or bigger' : f.op === 'lte' ? ' or smaller' : f.op === 'gt' ? ' or more (over)' : f.op === 'lt' ? ' (under)' : ''}`.replace(' or more (over)', '+').replace(' (under)', ' or less'));
    else if (f.field === 'city') tail.push(`in ${f.value}`);
    else if (f.label) tail.push(f.label);
    else tail.push(`${f.field} ${f.op} ${f.value}`);
  }
  return { adj, tail };
}

/** One predicate as {style: 'with' | 'plain', text, neg} */
function describePred(p, plan) {
  switch (p.k) {
    case 'doc': case 'udoc': {
      const noun = p.visit ? 'service visit' : p.type ? p.word : (p.tech ? 'service' : 'document');
      const svc = p.svc ? `${p.svc.toLowerCase()} ` : '';
      let core;
      if (p.tech && !p.type && !p.visit) core = `service from technician ${p.tech}`;
      else {
        const q = qtyPhrase(p.cmp, `${svc}${noun}`, plur(`${svc}${noun}`), `${svc}${noun}`);
        core = `${q}${p.tech ? ` from technician ${p.tech}` : ''}`;
      }
      return { style: 'with', text: `${core}${p.time ? ` ${p.time.label}` : ''}` };
    }
    case 'unit': {
      const { adj, tail } = unitAdjectives(p.f);
      const nounS = [...adj, 'unit'].join(' '); const nounP = [...adj, 'units'].join(' ');
      const q = qtyPhrase(p.cmp, nounS, nounP, adj[0] ?? 'unit');
      return { style: 'with', text: `${q}${tail.length ? ` ${tail.join(' ')}` : ''}` };
    }
    case 'ufield': {
      const { adj, tail } = unitAdjectives(p.f);
      const parts = p.f.map((f) => (f.field === 'brand' ? `${f.value} brand` : f.field === 'refrigerant' ? `using ${f.value}` : f.field === 'city' ? `in ${f.value}` : f.field === 'tonnage' ? `at ${f.value} ton${f.op === 'gte' ? ' or bigger' : f.op === 'lte' ? ' or smaller' : ''}` : (f.label ?? `${f.field} ${f.op} ${f.value}`)));
      return { style: 'plain', text: parts.join(' '), negText: parts.length === 1 ? `not ${parts[0]}` : `not (${parts.join(' ')})` };
    }
    case 'city': return { style: 'plain', text: `in ${p.value}`, negText: `not in ${p.value}` };
    case 'cityOf': return { style: 'plain', text: `in the same city as ${p.name}${(plan.expr.none ?? []).some((q) => q.k === 'isName' && q.name === p.name) ? ', not counting ' + p.name : ''}`, negText: `not in the same city as ${p.name}` };
    case 'isName': return { style: 'plain', text: `named ${p.name}`, negText: (plan.expr.all ?? []).some((q) => q.k === 'cityOf' && q.name === p.name) ? '' : `other than ${p.name}` };
    case 'servedCust': return { style: 'plain', text: `who have worked with ${p.name}`, negText: '' };
    case 'billed': return { style: 'plain', text: `billed ${cmpWords[p.cmp.op]} ${usd(p.cmp.n)}${p.time ? ` ${p.time.label}` : ''}`, negText: `not billed ${cmpWords[p.cmp.op]} ${usd(p.cmp.n)}${p.time ? ` ${p.time.label}` : ''}` };
    default: return { style: 'plain', text: p.k, negText: `not ${p.k}` };
  }
}

function condPhrase(expr, plan) {
  const withPos = []; const withNeg = []; const plainPos = []; const plainNeg = [];
  for (const p of expr.all) { const d = describePred(p, plan); (d.style === 'with' ? withPos : plainPos).push(d.text); }
  for (const p of expr.none) { const d = describePred(p, plan); if (d.style === 'with') withNeg.push(d.text); else plainNeg.push(d.negText); }
  const anyDesc = expr.any.map((p) => describePred(p, plan));
  const anyPart = anyDesc.map((d) => d.text);
  const anyStyle = anyDesc.every((d) => d.style === 'with') ? 'with' : 'plain';
  const parts = [];
  if (withPos.length) parts.push(`with ${withPos.join(' and ')}`);
  if (anyPart.length) parts.push(anyStyle === 'with' ? `with ${anyPart.join(' or ')}` : (expr.any.every((p) => p.k === 'city') ? `in ${expr.any.map((p) => p.value).join(' or ')}` : anyPart.join(' or ')));
  if (withNeg.length) parts.push(`${withPos.length || anyPart.length ? 'but ' : ''}without ${withNeg.join(' or ')}`);
  // "not in Mesa" + "not in Gilbert" read as one condition: "not in Mesa or Gilbert"
  const notIn = plainNeg.filter((t) => /^not in /.test(t));
  const negOut = notIn.length > 1 ? [`not in ${notIn.map((t) => t.slice(7)).join(' or ')}`, ...plainNeg.filter((t) => !/^not in /.test(t))] : plainNeg;
  return [...plainPos, ...parts, ...negOut].filter(Boolean).join(' ');
}

/** A unit in a sentence: serial, brand, model; in a list longer than twelve just the serial (the same rule the core family uses), the cards carry the rest. */
const unitLabel = (row, n = 0) => (n > 12 && row.serial ? row.serial : [row.serial, row.brand, row.model].filter(Boolean).join(' ') || 'unit');

function labelRow(plan, row, snap, n = 0) {
  if (plan.entity === 'customer') {
    const ix = indexOf(snap);
    const dup = (ix.nameCount.get(lc(row.name)) ?? 0) > 1;
    return dup ? `${row.name} (${n > 12 ? String(row.address ?? 'address not on file').split(',')[0] : (row.address ?? 'address not on file')})` : (row.name ?? 'Unnamed customer');
  }
  if (plan.entity === 'unit') return unitLabel(row, n);
  if (plan.entity === 'city') return row.city;
  return row.name;
}

function basisFor(plan, res, snap) {
  const bits = [];
  const subj = plan.entity;
  const scope = plan.scope?.building && res.R?.buildingInfo ? `every customer at ${res.R.buildingInfo.street}` : subj === 'customer' ? 'every customer on file' : subj === 'unit' ? 'every unit on file' : subj === 'city' ? 'every city where a customer is on file' : 'every technician named on a document';
  const conds = [condPhrase(plan.expr, plan)];
  if (plan.base && (plan.base.all.length || plan.base.none.length)) conds.unshift(`base: ${condPhrase(plan.base, plan)}`);
  const defs = [];
  const preds = allPreds(plan.expr).concat(plan.base ? allPreds(plan.base) : []);
  if (preds.some((p) => p.repeat)) defs.push('a repeat customer is one with two or more service visits (papers that carry a service date)');
  if (preds.some((p) => (p.k === 'doc' || p.k === 'unit') && subj === 'customer')) defs.push('a customer has a paper when it is linked to the customer or to one of the customer\'s units');
  if (subj === 'unit' && preds.some((p) => p.k === 'udoc')) defs.push('a unit has a paper only when the paper is linked to that unit');
  if (preds.some((p) => p.k === 'billed')) defs.push('billed means the totals printed on invoices');
  if (preds.some((p) => p.k === 'doc' && p.visit)) defs.push('a service visit is any paper that carries a service date');
  if (preds.some((p) => (p.k === 'doc' || p.k === 'udoc') && p.time)) defs.push('a paper is dated by its service date, else its invoice date, else the day it was uploaded');
  if (preds.some((p) => (p.k === 'doc' || p.k === 'udoc'))) defs.push('internal-only papers and HR letters are left out');
  const tail = (res.caveats ?? []).map((c) => `${fmtInt(c.n)} ${documentTypeLabel(c.type)?.toLowerCase() ?? c.type} paper${c.n === 1 ? '' : 's'} on file ${c.n === 1 ? 'is' : 'are'} not linked to any customer and could not be placed`);
  if (plan.mode === 'share') bits.push(`Divided the matching ${nounFor(plan, 2)} by ${res.den === res.base?.length && !plan.base?.all?.length ? scope : 'the base group'}`);
  else bits.push(`Checked ${scope}`);
  return `${bits[0]}: ${conds.filter(Boolean).join('; ')}.${defs.length ? ` ${cap1(defs.join('; '))}.` : ''}${tail.length ? ` ${cap1(tail.join('; '))}.` : ''}`;
}

const LEAD = '\u0001LEAD\u0001';

function caveatSentence(res) {
  const cs = (res.caveats ?? []);
  let altS = '';
  if (res.alt) {
    altS = res.mode === 'share'
      ? ` If only service tickets count as visits, it is ${fmtInt(res.alt.n)} of ${fmtInt(res.alt.den)}${res.alt.den ? ` (${Math.round((res.alt.n / res.alt.den) * 1000) / 10}%)` : ''}.`
      : ` If only service tickets count as visits, ${fmtInt(res.alt.n)} match.`;
  }
  if (!cs.length) return altS;
  return `${altS} ${cs.map((c) => `${fmtInt(c.n)} ${documentTypeLabel(c.type)?.toLowerCase() ?? c.type} paper${c.n === 1 ? '' : 's'} on file ${c.n === 1 ? 'is' : 'are'} not linked to any customer and could not be placed`).join('; ')}.`;
}

/** Two customer records with one name are two customers here; say so, so a count of names and a count of records both read true. */
function sameNameParts(res, plan) {
  if (plan.entity !== 'customer' || plan.mode === 'share' || plan.mode === 'share_billed' || !Array.isArray(res.rows)) return null;
  const seen = new Map();
  for (const r of res.rows) { const k = lc(r.name); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
  const dup = [...seen.entries()].filter(([, c]) => c > 1);
  if (!dup.length) return null;
  const uniq = [...new Set(res.rows.filter((r) => dup.some(([k]) => k === lc(r.name))).map((r) => r.name))];
  return { who: listNames(uniq.slice(0, 3)), many: uniq.length > 1, distinct: seen.size };
}

/** "customers with no invoices": the customers with no paper of any kind on file are in the list; say how many, so the list reads whole. */
function nothingAtAll(res, plan, snap) {
  if (plan.entity !== 'customer' || plan.mode === 'share' || plan.mode === 'share_billed' || !Array.isArray(res.rows) || !res.rows.length) return 0;
  if (!(plan.expr?.none ?? []).some((p) => p.k === 'doc' && p.type)) return 0;
  const ix = indexOf(snap);
  const n = res.rows.filter((r) => !(ix.docsByCust.get(r.id)?.length)).length;
  return n > 0 && n < res.rows.length ? n : 0;
}

function saySelect(res, plan, { snap }) {
  const r = saySelect0(res, plan, { snap });
  if (!r?.text) return r;
  const dn = sameNameParts(res, plan);
  const zero = nothingAtAll(res, plan, snap);
  // in a long list the notes that qualify the NUMBER sit right after the count, before the names, so they are never pushed out of sight
  if (r.text.includes(LEAD)) {
    const parts = [];
    if (res.alt && res.mode !== 'share') parts.push(`if only service tickets count as visits, ${fmtInt(res.alt.n)} match`);
    if (dn) parts.push(`${dn.who} ${dn.many ? 'are' : 'is'} on file twice, so ${fmtInt(dn.distinct)} different names`);
    if (res.unknown) parts.push(`${fmtInt(res.unknown.n)} more ${res.unknown.n === 1 ? 'has' : 'have'} no ${res.unknown.field} on file and ${res.unknown.n === 1 ? 'is' : 'are'} not counted`);
    if (res.never) parts.push(`${fmtInt(res.never)} more ${res.never === 1 ? 'has' : 'have'} never had one and ${res.never === 1 ? 'is' : 'are'} left out`);
    if (zero) parts.push(`${fmtInt(zero)} of them ${zero === 1 ? 'has' : 'have'} no papers of any kind on file`);
    r.text = r.text.replace(LEAD, parts.length ? ` (${parts.join('; ')})` : '');

    if ((res.caveats ?? []).length) r.text += ` ${caveatSentence({ caveats: res.caveats }).trim()}`;
    return r;
  }
  r.text += caveatSentence(res);
  if (res.unknown) r.text += ` ${fmtInt(res.unknown.n)} more ${res.unknown.n === 1 ? 'has' : 'have'} no ${res.unknown.field} on file and ${res.unknown.n === 1 ? 'is' : 'are'} not counted.`;
  if (res.never) r.text += ` ${fmtInt(res.never)} more ${res.never === 1 ? 'has' : 'have'} never had one and ${res.never === 1 ? 'is' : 'are'} left out.`;
  if (dn) r.text += ` ${dn.who} ${dn.many ? 'are' : 'is'} on file twice, so that is ${fmtInt(dn.distinct)} different names.`;
  if (zero) r.text += ` ${fmtInt(zero)} of them ${zero === 1 ? 'has' : 'have'} no papers of any kind on file.`;
  return r;
}

function saySelect0(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: res.n, claimedCount: null };
  const n = res.n;
  const noun = (k) => nounFor(plan, k);
  const cond = condPhrase(plan.expr, plan);
  const scopeTxt = res.R?.buildingInfo ? ` at ${res.R.buildingInfo.street}` : '';
  const c = scopeTxt + (cond ? ` ${cond}` : '');
  const baseC = plan.base && (plan.base.all.length || plan.base.none.length) ? ` ${condPhrase(plan.base, plan)}` : '';
  const recordsPlan = { entity: plan.entity };
  const recs = (rows) => (plan.entity === 'customer' || plan.entity === 'unit' ? rows.slice(0, 200).map((r) => recordFor(recordsPlan, r, snap)) : []);
  if (plan.mode === 'share_billed') {
    if (!res.den) { out.text = 'No invoice totals are on file, so there is no share of billing to give.'; out.basis = basisFor(plan, res, snap); return out; }
    const pct = Math.round((res.num / res.den) * 1000) / 10;
    const who = plan.topN != null ? `the top ${fmtInt(plan.topN)} customers by amount billed` : `customers${cond ? ` ${cond}` : ''}`;
    out.text = `${usd(res.num)} of ${usd(res.den)} billed (${pct}%) comes from ${who}${plan.topN != null && cond ? ` ${cond}` : ''}.`;
    out.facts = [{ label: 'Share of billing', value: `${pct}%` }];
    out.records = recs(res.rows); out.total = res.rows.length;
    out.basis = `Added up the invoice totals of ${plan.topN != null ? 'the top customers' : 'the matching customers'} and divided by the invoice totals of every customer on file; billed means the totals printed on invoices.${res.unlinked ? ` ${fmtInt(res.unlinked)} invoice${res.unlinked === 1 ? ' is' : 's are'} not linked to any customer and ${res.unlinked === 1 ? 'is' : 'are'} left out of both.` : ''}`;
    return out;
  }
  if (plan.mode === 'share') {
    if (!res.den) { out.text = `No ${noun(2)}${baseC} are on file, so there is no share to give.`; out.basis = basisFor(plan, res, snap); return out; }
    const pct = Math.round((n / res.den) * 1000) / 10;
    out.text = `${fmtInt(n)} of ${fmtInt(res.den)} ${noun(res.den)}${baseC} (${pct}%)${c}.`;
    out.facts = [{ label: 'Share', value: `${pct}%` }];
    out.records = recs(res.rows); out.total = n;
    out.basis = basisFor(plan, res, snap);
    return out;
  }
  if (n === 0) {
    out.text = `No ${noun(2)}${c} on file.`;
    out.facts = [{ label: cap1(noun(2)), value: '0' }];
    out.basis = basisFor(plan, res, snap); out.total = 0; out.claimedCount = 0;
    return out;
  }
  out.facts = [{ label: cap1(noun(2)), value: fmtInt(n) }];
  out.records = recs(res.rows); out.total = n; out.claimedCount = plan.entity === 'customer' || plan.entity === 'unit' ? n : null;
  if (plan.mode === 'count') out.text = `${fmtInt(n)} ${noun(n)}${c}.`;
  else out.text = `${fmtInt(n)} ${noun(n)}${c}${LEAD}: ${listNames(res.rows.map((r) => labelRow(plan, r, snap, res.rows.length)).sort((a, b) => a.localeCompare(b)))}.`;
  out.basis = basisFor(plan, res, snap);
  return out;
}

const timeNote = (t) => (t ? ` ${t.label}` : '');

function sayAbove(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: res.n, claimedCount: null };
  const above = plan.dir === 'gt';
  const word = above ? 'above' : 'below';
  const recs = (rows, ent) => rows.slice(0, 200).map((r) => recordFor({ entity: ent }, r, snap));
  let noun; let measureText; let avgText; let popNoun; let names;
  if (res.kind === 'document') {
    const uw = plan.word && /^[a-z -]+$/.test(plan.word) && plan.word.length >= 3 ? plan.word.replace(/s$/, '') : null;
    const label = uw && !/^(?:po)$/.test(uw) ? uw : (documentTypeLabel(plan.type)?.toLowerCase() ?? plan.type);
    noun = (n) => (n === 1 ? label : plur(label)); measureText = `${label} total`; avgText = usd(res.avg); popNoun = plur(label);
    names = res.sel.map((o) => o.label);
    out.records = recs(res.sel.map((o) => o.row), 'document');
  } else if (res.kind === 'unit') {
    noun = (n) => (n === 1 ? 'unit' : 'units'); measureText = `age${plan.benchmark?.brand ? ` of ${plan.benchmark.brand} units` : ' of units'}`; avgText = `${fmtNum(res.avg)} years`; popNoun = `${plan.benchmark?.brand ? `${plan.benchmark.brand} ` : ''}units with an installation date`;
    names = res.sel.map((o) => `${[o.row.serial, o.row.brand, o.row.model].filter(Boolean).join(' ')} (${fmtNum(round2(o.value))} years)`);
    out.records = recs(res.sel.map((o) => o.row), 'unit');
  } else if (res.kind === 'customer') {
    const m = plan.measure;
    noun = (n) => (n === 1 ? 'customer' : 'customers'); measureText = `${measureLabel(m)} per customer`; avgText = fmtMeasure(m, res.avg); popNoun = m.kind === 'billed' ? 'customers with an invoice' : 'customers';
    names = res.sel.map((o) => `${labelRow({ entity: 'customer' }, o.row, snap)} (${fmtMeasure(m, o.value)})`);
    out.records = recs(res.sel.map((o) => o.row), 'customer');
  } else {
    const m = plan.measure; const dn = { tech: 'technician', year: 'year', month: 'month', city: 'city', brand: 'brand' }[plan.dim];
    noun = (n) => (n === 1 ? dn : plur(dn)); measureText = measureLabel(m); avgText = fmtMeasure(m, res.avg); popNoun = plur(dn);
    names = res.sel.map((o) => `${o.label} (${fmtMeasure(m, o.value)})`);
  }
  const tn = timeNote(plan.time);
  const word2 = res.kind === 'unit' ? (above ? 'older than' : 'newer than') : word;
  if (!res.n) out.text = `No ${noun(2)} are ${word} the average ${measureText} of ${avgText} (${fmtInt(res.pop)} ${popNoun} compared${tn ? `,${tn}` : ''}).`;
  else if (plan.mode === 'count') out.text = `${fmtInt(res.n)} ${noun(res.n)} ${word2} the average ${measureText} of ${avgText} (${fmtInt(res.pop)} ${popNoun} compared${tn ? `,${tn}` : ''}).`;
  else out.text = `${fmtInt(res.n)} ${noun(res.n)} ${word2} the average ${measureText} of ${avgText} (${fmtInt(res.pop)} ${popNoun} compared${tn ? `,${tn}` : ''}): ${listNames(names)}.`;
  out.facts = [{ label: `${cap1(noun(2))} ${word} average`, value: fmtInt(res.n) }, { label: 'Average', value: avgText }];
  out.basis = `Took the average ${measureText} over ${fmtInt(res.pop)} ${popNoun}${tn ? ` ${tn.trim()}` : ''} and compared each one with it (strictly ${above ? 'more' : 'less'} than the average counts); amounts are the totals printed on the papers.`;
  out.total = out.records.length ? res.n : res.n; out.claimedCount = out.records.length ? res.n : null;
  return out;
}

const dimNoun = { customer: 'customer', tech: 'technician', city: 'city', brand: 'brand', year: 'year', month: 'month' };
function sayRank(res, plan) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const m = plan.measure; const dn = dimNoun[plan.dim];
  const by = measureLabel(m);
  if (res.none) { out.text = `${res.label} has no ${m.kind === 'billed' ? 'invoices' : by} on file, so there is no rank among the ${fmtInt(res.pop)} ${plur(dn)} that do.`; }
  else {
    const tie = res.tied > 0 ? `, tied with ${fmtInt(res.tied)} other${res.tied === 1 ? '' : 's'}` : '';
    out.text = `${res.label} ranks ${fmtInt(res.rank)} of ${fmtInt(res.pop)} ${plur(dn)} by ${by} (${fmtMeasure(m, res.value)}${tie}).`;
    out.facts = [{ label: 'Rank', value: `${fmtInt(res.rank)} of ${fmtInt(res.pop)}` }];
  }
  out.basis = `Ranked every ${dn} that has ${by} on file${plan.time ? ` ${plan.time.label}` : ''}; rank 1 is the highest, and equal values share a rank.`;
  return out;
}

function sayRatio(res, plan) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const nameOf = (s) => {
    if (s.kind === 'doc') return s.dollars ? `dollars on ${plur(s.word ?? documentTypeLabel(s.type)?.toLowerCase() ?? s.type)}` : `${s.svc ? `${s.svc.toLowerCase()} ` : ''}${plur(s.word ?? documentTypeLabel(s.type)?.toLowerCase() ?? s.type)}`;
    if (s.kind === 'visit') return 'service visits';
    if (s.kind === 'unit') return s.label && s.label !== 'units' ? `${s.label} units` : 'units';
    return 'customers';
  };
  const f = (s, r) => (r.money ? usd(r.value) : fmtInt(r.value));
  if (!res.ratio && res.ratio !== 0) { out.text = `There are no ${nameOf(plan.b)} on file${timeNote(plan.time)}, so there is no ratio of ${nameOf(plan.a)} to ${nameOf(plan.b)} to give.`; }
  else {
    out.text = `Ratio of ${nameOf(plan.a)} to ${nameOf(plan.b)}${timeNote(plan.time)}: ${fmtNum(round2(res.ratio))} to 1 (${plan.a.dollars ? `${f(plan.a, res.a)}, ${f(plan.b, res.b)}` : `${f(plan.a, res.a)} ${nameOf(plan.a)}, ${f(plan.b, res.b)} ${nameOf(plan.b)}`}).`;
    out.facts = [{ label: 'Ratio', value: `${fmtNum(round2(res.ratio))} : 1` }];
  }
  out.basis = `Divided the count${plan.a.dollars ? ' of dollars' : ''} of ${nameOf(plan.a)} by the count of ${nameOf(plan.b)}${timeNote(plan.time)}; a service visit is any paper that carries a service date.`;
  return out;
}

function sayPerEntity(res, plan) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const m = plan.measure;
  const thing = { billed: 'billed on invoices', visits: 'service visits', tickets: m.svc ? `${m.svc.toLowerCase()} tickets` : 'service tickets', docs: m.type ? plur(documentTypeLabel(m.type)?.toLowerCase() ?? m.type) : 'documents', units: 'units' }[m.kind];
  const v = (n) => (m.kind === 'billed' ? usd(round2(n)) : fmtNum(round2(n)));
  const tot = m.kind === 'billed' ? usd(res.total) : fmtInt(res.total);
  const tn = timeNote(plan.time);
  const ent = plan.entity === 'unit' ? 'unit' : 'customer';
  const head = m.kind === 'billed' ? `Per ${ent}, ${v(plan.onlyThose ? res.perSome : res.perAll)} ${thing}${tn}` : `About ${v(plan.onlyThose ? res.perSome : res.perAll)} ${thing} per ${ent}${tn}`;
  const second = plan.onlyThose
    ? `${v(res.perAll)} across all ${fmtInt(res.all)} ${ent}s on file`
    : `${v(res.perSome)} among the ${fmtInt(res.withSome)} ${ent}s who have any`.replace('units who have', 'units that have');
  out.text = `${head} on average (${tot} across ${plan.onlyThose ? fmtInt(res.withSome) + ` ${ent}s that have any` : fmtInt(res.all) + ` ${ent}s on file`}); ${second}.`;
  out.facts = [{ label: `Average per ${ent}`, value: v(plan.onlyThose ? res.perSome : res.perAll) }, { label: plan.onlyThose ? `Across all ${ent}s` : `Among ${ent}s with any`, value: v(plan.onlyThose ? res.perAll : res.perSome) }];
  out.basis = `Divided the ${m.kind === 'billed' ? 'invoice totals' : 'count'} by the number of ${ent}s on file, and by the ${ent}s that have any, because the two readings differ; a service visit is any paper that carries a service date${ent === 'unit' ? '; papers that are not tied to a unit are not counted' : ''}.`;
  return out;
}

function sayBuilding(res, plan, { snap }) {
  const out = { text: '', facts: [], records: [], basis: '', total: 0, claimedCount: null };
  const mw = { billed: 'billed on invoices', visits: 'service visits', docs: 'documents' }[plan.measure];
  const v = (n) => (plan.measure === 'billed' ? usd(round2(n)) : fmtNum(round2(n)));
  const tn = timeNote(plan.time);
  if (res.none) { out.text = `None of the ${fmtInt(res.n)} customers at ${res.street} has ${mw} on file${tn}.`; out.basis = `Looked at every customer whose address is ${res.street} (one street address, each with its own unit number).`; return out; }
  if (plan.agg === 'sum') out.text = `${v(res.value)} ${mw}${tn} across ${res.pop === res.n ? `the ${fmtInt(res.n)}` : `${fmtInt(res.pop)} of the ${fmtInt(res.n)}`} customers at ${res.street}.`;
  else if (plan.agg === 'avg') out.text = `On average ${v(res.value)} ${mw} per customer${tn} at ${res.street} (${fmtInt(res.pop)} customers counted).`;
  else {
    const names = res.extreme.map((c) => `${c.name} (${(c.address ?? '').split(',')[1]?.trim() ?? 'unit not on file'})`);
    out.text = `${names.join(', ')} ${res.extreme.length === 1 ? 'has' : 'have'} the ${plan.agg === 'max' ? 'most' : 'least'} ${mw}${tn} at ${res.street}: ${v(res.value)}.`;
    out.records = res.extreme.map((c) => recordFor({ entity: 'customer' }, c, snap));
  }
  out.facts = [{ label: plan.agg === 'sum' ? 'Total' : plan.agg === 'avg' ? 'Average' : plan.agg === 'max' ? 'Most' : 'Least', value: v(res.value) }];
  out.total = out.records.length; out.claimedCount = null;
  out.basis = `Added up every customer whose address is ${res.street} (one street address, each customer with its own unit number); amounts are the totals printed on invoices.`;
  return out;
}

/* ====================================================================== registration */

function exec(plan, x) {
  switch (plan.op) {
    case 'set_select': return execSelect(plan, x);
    case 'set_above_avg': return execAbove(plan, x);
    case 'set_rank': return execRank(plan, x);
    case 'set_ratio': return execRatio(plan, x);
    case 'set_per_entity': return execPerEntity(plan, x);
    case 'set_building': return execBuilding(plan, x);
    default: return { abstain: 'op' };
  }
}

function say(res, plan, x) {
  switch (plan.op) {
    case 'set_select': return saySelect(res, plan, x);
    case 'set_above_avg': return sayAbove(res, plan, x);
    case 'set_rank': return sayRank(res, plan);
    case 'set_ratio': return sayRatio(res, plan);
    case 'set_per_entity': return sayPerEntity(res, plan);
    case 'set_building': return sayBuilding(res, plan, x);
    default: return null;
  }
}

registerFamily({ id: 'sets', ops: SETS_OPS, slots, detect, exec, say });
export { slots as setsSlots, detect as detectSets };
