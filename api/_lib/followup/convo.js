/**
 * followup/convo.js (round 17): conversations that work for ANY company, not only the ones whose words the follow-up gate knows.
 *
 * The earlier merge (dqlmerge.js) only keeps a rewrite when a stand-in vocabulary can explain it, so a company with its own document
 * words ("pledge cards", "freight bills") never got a follow-up answered. Here the rewrite is built from the PRIOR question's own words
 * (its scope: papers, person, place, period, filters are all inside that text) and the DQL engine, which does hold the company's
 * vocabulary, reads the result or releases it. Each turn adds or replaces exactly what the new turn says:
 *
 *   - another measure of the same scope: "what was the total", "and on average?", "how many is that", "which ones - names please"
 *   - one more condition on the same scope: "only over $500", "Boulder City only", "just the no-show ones", "just last year"
 *
 * Anything this file cannot place with certainty returns null (the caller releases). Pure: no database, no model, no network.
 */

import { CHATTER } from './noise.js';

const strip = (t) => String(t ?? '').trim().replace(/[?.!\s]+$/, '');
const clean = (q) => String(q).replace(/\s+/g, ' ').replace(/\s+([?.!,])/g, '$1').trim();
const demoji = (t) => String(t ?? '').replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, ' ').replace(/\s+/g, ' ').trim();

/* words that only dress a follow-up (persona lead-ins, politeness, urgency, tails): they never carry a condition */
const NOISE = new Set(('a an the and also then now just only so ok okay hey hi hello please pls plz thanks thank you thx much appreciated asap today tonight now quick fast one real ' +
  'sec when can could would if possible possible youre you\'re lifesaver for me my us our we it its it\'s is are was were be been that this those these them they there of on in at to as per ' +
  'records record files file docs doc paperwork papers paper entries entry stuff system company documents document office books going by what\'s whats what from with the on side ' +
  'tell let know see show give gimme dime oye por favor para mi que lo les cuantos cuanto muestrame dame y el la los las un una i need want like would just ' +
  'according based given mentioned looking look files going lemme thats wanna gonna tell me ' +
  'owner here new first week learning ropes bookkeeper bookkeeper\'s accountant boss supervisor cpa audit prep review quarterly taxes tax urgent rush no (no rush) ' +
  'bugging been checking juxt btw im i\'m sorry dumb question not sure how works this still way best you well actually really kind').split(/\s+/));
for (const w of CHATTER) NOISE.add(w);

const MEASURES = [
  ['list', /\bw[a-z]{2,4}\s+on[a-z]{1,3}\b|\bwho\s+(?:are|were|is|was)?\s*(?:they|those|them|that)\b|\bwho\s*\?*$|\bnames?\b|\blist\s+(?:them|those|these|all)\b|\bshow\s+(?:them|those|me\s+(?:them|those))\b|\bwho\b/],
  ['count', /\bhow\s+many\b|\bcount\b|\bnumber\s+of\b|\btally\b/],
  ['avg', /\b(?:average|avg|mean|typical|usual|norm)\b/],
  ['sum', /\b(?:total|sum|altogether|how\s+much|come\s+to|add\s+up|dollar\s+total|dollars|worth|all\s+together|combined)\b/],
  ['latest', /\b(?:latest|newest|most\s+recent|last\s+one|last\s+date|last\s+one\s+date)\b|\blast\b(?!\s+(?:year|month|week|quarter|\d))/],
  ['earliest', /\b(?:earliest|oldest|first\s+one|first\s+date)\b|\bfirst\b/],
  ['max', /\b(?:biggest|largest|highest|most\s+expensive|priciest|top\s+one)\b/],
  ['min', /\b(?:smallest|lowest|cheapest|least\s+expensive|min(?:imum)?)\b/],
];

/** Which one measure a follow-up asks for (null when it names none or several). */
function measureOf(f0) {
  // chatter that contains a measure word ("first week here", "last night", "the first time") is not a measure
  const f = f0.replace(/\b(?:first|new)\s+(?:week|day|time|month)\b(?:\s+here)?|\blast\s+(?:night|time)\b|\bat\s+first\b/g, ' ');
  const hits = MEASURES.filter(([, re]) => re.test(f)).map(([k]) => k);
  if (!hits.length) return null;
  // "how many ... total" asks a count; "list" words win only when alone
  if (hits.includes('count') && hits.every((h) => ['count', 'sum', 'list'].includes(h)) && /\bhow\s+many\b/.test(f)) return 'count';
  if (hits.length === 1) return hits[0];
  if (hits.length === 2 && hits.includes('sum') && hits.includes('avg')) return null;
  if (hits.includes('latest') && hits.includes('earliest')) return null;
  return hits.length === 2 && hits.includes('list') ? hits.find((h) => h !== 'list') : null;
}

/** The measure of the prior question, read from its own words. */
function priorMeasure(P) {
  const p = P.toLowerCase();
  if (/\b(?:biggest|largest|highest|smallest|lowest|cheapest|latest|newest|oldest|earliest|first|last|most recent|top|bottom|min|max|least|fewest|median)\b/.test(p) && !/\bhow\s+many\b/.test(p)) return 'other';
  if (/\bhow\s+many\b|\bnumber\s+of\b|\bcount\b|\btally\b/.test(p)) return 'count';
  if (/\b(?:average|avg|mean|typical|usual)\b/.test(p)) return 'avg';
  if (/\b(?:total|sum|how\s+much|add\s+up|dollars?|worth|amount)\b/.test(p)) return 'sum';
  if (/\b(?:list|show|which|who|what\s+are)\b/.test(p)) return 'list';
  return null;
}

const SCOPE_LEADS = [
  /\b(?:what(?:'s|\s+is|\s+was)\s+the\s+)?(?:total\s+)?(?:an?\s+)?(?:number|count|headcount)\s+of\s+(?:the\s+|our\s+)?/i,
  /\bhow\s+many(?:\s+|$)(?:of\s+)?(?:the\s+|our\s+)?/i,
  /\b(?:tally|count)(?:\s+up)?\s+(?:the\s+|our\s+)?(?:number\s+of\s+)?/i,
  /\b(?:what(?:'s|\s+is|\s+was)\s+)?(?:the\s+|our\s+)?(?:(?:overall|grand|dollar|combined)\s+)?(?:total|sum|average|avg|mean|typical|usual)\s+(?:dollar\s+)?(?:amount|value|dollars?|cost|billed)?\s*(?:of|on|for|among|across|from)?\s*(?:the\s+|our\s+|all\s+)?/i,
  /\bhow\s+much\s+(?:(?:is|are|was|were|did|do|does)\s+)?(?:the\s+|our\s+)?(?:total\s+)?(?:(?:of|on|for|from)\s+)?(?:the\s+|our\s+)?/i,
  /\b(?:what\s+do\s+you\s+get\s+if\s+you\s+)?add\s+up\s+(?:the\s+|our\s+)?/i,
  /\b(?:list|show(?:\s+me)?|give\s+me|display|pull\s+up)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|our\s+)?/i,
];

/** The prior split at its measure phrase: what comes before it (a period, a lead-in), and the papers-and-conditions after it. Null when the measure phrase cannot be located. */
function scopeOf(P) {
  const t = strip(P);
  let best = null;
  for (const re of SCOPE_LEADS) {
    const m = re.exec(t);
    if (!m) continue;
    let rest = t.slice(m.index + m[0].length).trim();
    let before = t.slice(0, m.index);
    if (!rest) { rest = before.replace(/[\s,:;–—-]+$/, '').trim(); before = ''; } // "tenant charges for paul carr - how many"
    if (!rest) continue;
    if (!best || m.index < best.at) best = { at: m.index, rest, before };
  }
  if (best) { // "give me the number of X": peel every further lead at the start of the rest
    for (let i = 0; i < 3; i++) {
      let moved = false;
      for (const re of SCOPE_LEADS) { const m = re.exec(best.rest); if (m && m.index === 0 && m[0].length && best.rest.length > m[0].length) { best.rest = best.rest.slice(m[0].length).trim(); moved = true; break; } }
      if (!moved) break;
    }
    // a leftover question verb ("work orders did we get Judith George worked on") has no clean scope: release
    if (/\b(?:did|do|does|have|has|had|would|will|can|could)\s+(?:we|you|i|they)\b|\b(?:we|i)\s+(?:get|got|have|had|send|sent|do|did)\b|\b(?:did|does|turned|became|become|got|was|were|will|would)\b/i.test(best.rest)) return null;
  }
  return best;
}
/** The prior with its measure phrase replaced: every condition it carried (before or after the phrase) stays. */
const PERIOD_CLAUSE = /\d|\b(?:last|past|previous|prior|since|ago|this|current|january|february|march|april|may|june|july|august|september|october|november|december|quarter|year|month|week|during|between|within|before|after|from|until|through)\b/i;
/** Only the clauses of the text before the measure phrase that carry a period are kept ("During 2020, "); the chatter ("Hey, figure out") goes. */
const keepBefore = (b0) => { const b = String(b0).replace(/\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell|show|give|get|pull|check)\s+me\s+/gi, ' '); const parts = String(b).split(/(?<=[,:;])\s+|\s+[-–—]\s+/).map((c) => c.replace(/\s+(?:(?:get|give|pull|show|tell|find|run|figure|gimme|need|want|can you|could you|i need|i want|what'?s|what is|what was)\b[^,;:]*)$/i, '')).filter((c) => PERIOD_CLAUSE.test(c)); return parts.length ? `${parts.join(' ').replace(/[\s,:;-]+$/, '')}, ` : ''; };
const withLead = (sc, lead) => clean(`${keepBefore(demoji(sc.before))}${lead} ${sc.rest}`);

const COMP = '(?:over|above|more\\s+than|greater\\s+than|exceeding|at\\s+least|under|below|less\\s+than|no\\s+more\\s+than|at\\s+most|up\\s+to|and\\s+up|and\\s+over|or\\s+more|or\\s+less)';
const THR_RE = new RegExp(`\\b(${COMP})\\s*\\$?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\b|\\$\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(and\\s+up|and\\s+over|or\\s+more|or\\s+less|and\\s+under)\\b`, 'i');

function thresholdOf(f) {
  const m = THR_RE.exec(f);
  if (!m) return null;
  const comp = (m[1] || m[4]).toLowerCase().replace(/\s+/g, ' ');
  const n = (m[2] || m[3]).replace(/,/g, '');
  const up = /over|above|more than|greater|exceeding|at least|and up|and over|or more/.test(comp);
  const word = /at least/.test(comp) ? 'at least' : /at most|no more|up to|or less/.test(comp) ? 'at most' : up ? 'over' : 'under';
  return { text: `${word} $${n}`, start: m.index, end: m.index + m[0].length };
}

const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * "<X> only", "just <X>", "limit it to <X>", "which are in <X>", "restrict it to in <X>": the value X a follow-up narrows by.
 * X is up to three words that are not dressing; the engine decides whether X is a place, a person, a status or a service type.
 */
function narrowValueOf(F) {
  const t = demoji(strip(F)).replace(/\s+/g, ' ');
  // the clause that carries the value: the one containing the narrowing cue
  const clauses = t.split(/\s*[,;:–—]\s+|\s+-\s+/).filter(Boolean);
  const cue = /(?:^|\s)(?:only|just|limit(?:ed)?\s+(?:it\s+)?to|restrict(?:ed)?\s+(?:it\s+)?to|which\s+are\s+in|which\s+are|filter\s+(?:to|by)|narrow\s+(?:it\s+)?to|but\s+only|how\s+about\s+just)(?:\s|$)/i;
  for (const c of clauses) {
    if (!cue.test(` ${c} `) && !/\bonly\s*$/i.test(c)) continue;
    let w = c.replace(/^(?:and|also|then|ok|okay|so|um|well|please|pls)\s+/gi, '').replace(/\b(?:limit(?:ed)?|restrict(?:ed)?|narrow)\s+(?:it\s+)?to\b/gi, ' ').replace(/\b(?:which\s+are\s+in|which\s+are|filter\s+(?:to|by)|but\s+only|how\s+about\s+just)\b/gi, ' ')
      .replace(/\b(?:only|just)\b/gi, ' ').replace(/\b(?:in|from|for|at|of)\s+(?=\S)/gi, ' ').replace(/\b(?:the\s+ones|ones|those|the)\b/gi, ' ').replace(/\s+/g, ' ').trim().split(' ');
    // drop dressing words from both ends, keep a short run of content words
    const keep = [];
    for (const x of w) { if (!x) continue; if (NOISE.has(x.toLowerCase().replace(/[.!?]+$/, ''))) { if (keep.length) break; continue; } keep.push(x.replace(/[.!?]+$/, '')); }
    if (keep.length && keep.length <= 3 && keep.every((x) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*$/.test(x))) return keep.join(' ');
  }
  return null;
}

function ed(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const MEASURE_WORDS = ['total', 'sum', 'average', 'avg', 'mean', 'typical', 'usual', 'amount', 'value', 'dollars', 'dollar', 'year', 'altogether', 'names', 'name', 'ones', 'count', 'number', 'many', 'much', 'list', 'show', 'who', 'which', 'come', 'add', 'latest', 'newest', 'recent', 'most', 'last', 'first', 'earliest', 'oldest', 'date', 'biggest', 'largest', 'highest', 'smallest', 'lowest', 'cheapest', 'expensive', 'combined', 'worth', 'cost', 'each', 'tally', 'whose', 'there', 'how', 'were', 'they', 'those', 'one', 'their', 'overall', 'together'];
const PEOPLE_WORDS = ['customers', 'customer', 'clients', 'client', 'custs', 'cust', 'members', 'member', 'tenants', 'tenant', 'supporters', 'donors', 'guests', 'patients', 'owners', 'students', 'accounts', 'people', 'persons', 'shippers', 'residents', 'parishioners', 'companies'];
/** A word of a measure follow-up: a measure word, allowing one or two slips of the keyboard. */
function isMeasureWord(w) {
  if (MEASURE_WORDS.includes(w)) return true;
  if (w.length < 4) return false;
  const max = w.length >= 7 ? 2 : 1;
  return MEASURE_WORDS.some((m) => m.length >= 4 && m[0] === w[0] && Math.abs(m.length - w.length) <= max && ed(w, m) <= max);
}

/** True for a follow-up that is only a measure ("average amount?", "and the total", "their total PlEASE", "the newest one?"): it means something only against the earlier question. */
export function isBareMeasureFollowup(q) {
  const F = demoji(strip(q)); const f = F.toLowerCase();
  // only the ask for the names behind an earlier answer is held back for the engine; the other bare measures (total, average, newest) stay with the older lanes, which carry the earlier turns
  if (!/\b(?:who|which|names?|lista?|those|tohse|wh[a-z]{2,4}\s+on[a-z]{1,3})\b/.test(f)) return false;
  if (!F || F.split(/\s+/).length > 40 || /[$\d]/.test(F)) return false;
  const words = leftoverWords(f).filter((w) => w !== 'u' && w !== 'r');
  // "which customers?" / "can u tell me which members": the people behind an earlier answer (only with a "which"/"who"; typos of the nouns allowed)
  const asksPeople = /\bwh\w{2,4}\s+[a-z]+/.test(f) && !/[$\d]/.test(f);
  const isPeopleWord = (w) => PEOPLE_WORDS.includes(w) || (w.length >= 5 && PEOPLE_WORDS.some((m) => m.length >= 5 && m[0] === w[0] && Math.abs(m.length - w.length) <= 1 && ed(w, m) <= 1));
  // every word was dressing ("who were they much appreciated", "ok donovan, which ones - names?"): a bare ask for the names behind the earlier answer
  if (!words.length) return /\b(?:who|which\s+on[a-z]{1,3}|wh[a-z]{2,4}\s+on[a-z]{1,3}|names?|lista?|those|tohse)\b/.test(f);
  if (!words.every((w) => isMeasureWord(w) || (asksPeople && isPeopleWord(w)))) return false;
  return words.some((w) => !['one', 'ones', 'they', 'those', 'their', 'were', 'there', 'much', 'many', 'how', 'who', 'which', 'each', 'come'].includes(w) || /^(?:much|many)$/.test(w)) && /\b(?:total|sum|tot\w*|av\w*|mean|typical|usual|count|number|many|much|how|names?|which|latest|newest|oldest|earliest|first|last|biggest|largest|smallest|lowest|highest|cheapest|amount|value|altogether|combined|list|who)\b/i.test(f);
}

/** The words of F left once dressing, measure words and recognised features are gone: any real word left means a condition we cannot place. */
function leftoverWords(f) {
  return f.toLowerCase().replace(/[^a-z0-9$\s'’-]/g, ' ').split(/\s+/).filter((w) => w && /[a-z0-9]/.test(w) && !NOISE.has(w));
}

const CUST_HEAD = /\b(?:tenants?|residents?|accounts?|clients?|customers?|custs?|donors?|supporters?|members?|guests?|patients?|homeowners?|owners?|students?|shippers?|people|persons?|contacts?|vendors?|suppliers?|technicians?|staff|stylists?|drivers?)\b/;

const CHAIN_NOISE = /\b(?:that|those|them|it|this|these)\b/;

/**
 * @param {string} P the prior question as the engine saw it (an earlier follow-up already expanded)
 * @param {string} F0 the new question as typed
 * @param {{spansOf:Function, swapPeriod:Function}} H period helpers from dqlmerge.js
 * @returns {{query:string, slot:string}|null}
 */
export function convoRewrite(P, F0, H) {
  const F = demoji(strip(F0));
  if (!P || !F || F.length > 200) return null;
  const f = F.toLowerCase();
  // a negation or an exclusion is never rewritten here
  if (/\b(?:not|never|without|except|excluding|exclude|other than|besides|but not|isn'?t|aren'?t|don'?t|doesn'?t)\b|n't\b/.test(f)) return null;
  // a follow-up that carries its own full question (a new document noun plus a measure phrase of its own) is not an ellipsis
  if (F.split(/\s+/).length > 30) return null;
  // a prior that is itself one of this file's rewrites ("what is the total amount of ...") is not rewritten again: a third turn is left to the model
  if (/^(?:what is the (?:total|average) amount of|what is the date of the|what is the (?:largest|smallest) amount among|list )/i.test(strip(P))) return null;
  // a prior that is itself an unresolved follow-up (it points back with "that", "those", "their") has no scope of its own to carry
  if (/\b(?:is|are|was|were|of|for|about)\s+(?:that|those|them|it|this|these)\b|\b(?:their|them|those)\b/i.test(strip(P))) return null;
  // a part-of or comparison question ("how much of that is tax", "is that more than 2025") or an ordering request is not another measure or condition
  if (/\bhow (?:much|many) of\b|^(?:is|are|was|were|does|do|did)\s+(?:that|it|this|those|they)\b|\b(?:oldest|newest|latest|earliest|biggest|largest|smallest|highest|lowest)\s+first\b|\b(?:sorted?|order(?:ed)?)\b/i.test(F)) return null;
  const pm = priorMeasure(P);
  if (!pm || strip(P).split(/\s+/).length < 4) return null;

  // a condition (threshold, period, one more value) is only added to a plain count / total / average with a clean scope: a list, a ranking or a prior with a verb tail ("did Kevin do", "turned into an invoice") is released
  const condOk = (pm === 'count' || pm === 'sum' || pm === 'avg' || (pm === 'other' && !/\b(?:top|bottom)\s+\d+|\b(?:by|per)\s+[a-z]+|\b(?:most|least|who|which|rank\w*)\b/i.test(P))) && (pm === 'other' || !!scopeOf(P));

  // ---------------- another condition on the same scope
  const thr = condOk ? thresholdOf(F) : null;
  if (thr) {
    // the threshold must be the only real content: "only over $500", "just the ones more than $120 (no rush)"
    const rest = leftoverWords(f.slice(0, thr.start) + ' ' + f.slice(thr.end)).filter((w) => !/^(?:ones|more|than|over|under|above|below|and|up|or|less|the|restrict|limit|filter|to)$/.test(w));
    if (!rest.length && !/\$\s*\d/.test(strip(P)) && !new RegExp(`${COMP}\\s*\\$?\\s*\\d`, 'i').test(strip(P))) return { query: `${clean(strip(P))} ${thr.text}?`, slot: 'convo-thr' };
    if (!rest.length) return null;
  }

  // a period: replaced when the prior has one, added when it has none
  if (H?.spansOf && condOk) {
    const fs = H.spansOf(F, { fragment: true }).filter((s) => s.kind === 'period');
    const others = H.spansOf(F, { fragment: true }).filter((s) => s.kind !== 'period');
    if (fs.length === 1 && !others.length && !measureOf(f)) {
      const extra = leftoverWords(F.slice(0, fs[0].start) + ' ' + F.slice(fs[0].end)).filter((w) => !/^(?:restrict|limit|narrow|to|during|within|throughout|back|over|for|in|of|during|filter|switch|change|try)$/.test(w));
      if (!extra.length) {
        const pp = H.spansOf(P).filter((s) => s.kind === 'period');
        if (pp.length === 1) {
          const r = H.swapPeriod(strip(P), pp[0], fs[0], F);
          return r && clean(r).toLowerCase() !== clean(strip(P)).toLowerCase() ? { query: `${clean(r)}?`, slot: 'convo-period' } : null;
        }
        if (!pp.length) {
          const p = fs[0].period;
          const txt = p.gran === 'win' || p.prep ? fs[0].raw : `in ${fs[0].raw}`;
          return { query: `${clean(strip(P))} ${txt.replace(/^the\s+/i, '')}?`, slot: 'convo-period' };
        }
        return null;
      }
    }
  }

  // ---------------- "which clients?", "can you tell me which customers": the people behind the prior answer
  {
    const wm = /\bwhich\s+(clients?|customers?|custs?|people|persons?|guests?|members?|patients?|tenants?|residents?|shippers?|students?|donors?|supporters?|parishioners?|owners?|accounts?|companies|businesses|vendors?|contacts?|names)\b/.exec(f);
    if (wm && pm === 'count') {
      const left = leftoverWords(f.replace(wm[0], ' ')).filter((w) => !/^(?:tell|can|u|right|now|me|names?|list)$/.test(w));
      const scope = scopeOf(P);
      // a count of the people themselves is listed as it stands; behind papers, only a plain scope is read ("list customers with <papers>" misreads an unplaceable one)
      if (!left.length && scope && CUST_HEAD.test(scope.rest.split(/\s+/).slice(0, 3).join(' ').toLowerCase())) return { query: `${withLead(scope, 'list')}?`, slot: 'convo-who' };
      return null;
    }
  }

  // ---------------- another measure of the same scope
  const fm = measureOf(f);
  if (fm) {
    // the follow-up must be about "that": no word of its own besides dressing, measure words, "amount/value/dollars/year/one"
    const rest = leftoverWords(f).filter((w) => !isMeasureWord(w));
    if (rest.length) return null;
    if (fm === pm && fm !== 'list') return null;
    if (pm === 'other') return null;
    const scope = scopeOf(P);
    if (!scope) return null;
    const sc = scope; const s = clean(scope.rest);
    // a scope that still carries a clause of its own ("units are older than 15 years", "agreements expire this year") is not a plain noun phrase: released
    if (/\b(?:are|is|was|were)\s+(?:older|newer|more|less|over|under|from|before|after|since|due|past|within)\b|\b(?:expire|expires|expiring|expired|renew|renews|renewing|ends?|ending|due)\b/i.test(s)) return null;
    // the people behind papers a person handled: the engine also lists customers who only share a visit with them, so it is left to the model
    if (fm === 'list' && /\b(?:handled|performed|done|worked|assigned|completed)\s+(?:by|on)\b|\bby\s+technician\b/i.test(s)) return null;
    // a prior that is a grouped / ranked / yes-no question has no single scope to measure again
    if (/\b(?:per|by)\s+(?:year|month|quarter|city|customer|vendor|type|status|technician)\b|\bwho\b.*\b(?:most|least|biggest)\b/i.test(s) && fm !== 'list') return null;
    if (fm === 'count') return pm === 'count' ? null : { query: `${withLead(sc, 'how many')}?`, slot: 'convo-measure' };
    if (fm === 'list') {
      if (pm !== 'count') return null;
      // "names" asks for the people behind papers; a count of the people themselves is listed as it stands
      const wantsNames = /\b(?:names?|who)\b/.test(f) || /\bnam\w{1,3}\b/.test(f);
      const head = s.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      const peopleHead = CUST_HEAD.test(head);
      return { query: `${withLead(sc, wantsNames && !peopleHead ? 'list customers with' : 'list')}?`, slot: 'convo-measure' };
    }
    if (fm === 'sum') return { query: `${withLead(sc, 'what is the total amount of')}?`, slot: 'convo-measure' };
    if (fm === 'avg') return { query: `${withLead(sc, 'what is the average amount of')}?`, slot: 'convo-measure' };
    if (fm === 'latest') return { query: `${withLead(sc, 'what is the date of the latest of')}?`, slot: 'convo-measure' };
    if (fm === 'earliest') return { query: `${withLead(sc, 'what is the date of the earliest of')}?`, slot: 'convo-measure' };
    if (fm === 'max') return { query: `${withLead(sc, 'what is the largest amount among')}?`, slot: 'convo-measure' };
    if (fm === 'min') return { query: `${withLead(sc, 'what is the smallest amount among')}?`, slot: 'convo-measure' };
    return null;
  }

  // "<X> only", "just <X>", "limit it to <X>": the engine reads X against the company's own places, people, statuses and kinds
  const val = condOk ? narrowValueOf(F) : null;
  if (val && !CHAIN_NOISE.test(val.toLowerCase())) {
    return { query: `${clean(strip(P))} ${/^[a-z]/.test(val) ? title(val) : val}?`, slot: 'convo-value' };
  }
  return null;
}
