/**
 * decompose/compound.js — compound questions: "how many invoices in 2025 and what was the total",
 * "how many customers in Tempe and how many in Gilbert", "how many pm tickets vs repair tickets".
 *
 * ONE question that really asks two or three small things. This file splits it into clauses, carries the
 * subject / period / noun from an earlier clause into a short later one ("and how many Denise Ford"), runs
 * each finished clause through the deterministic planners that already answer single questions (the money
 * reader, then the analytics planner — no model), and joins the answers in order, each labelled with the
 * clause it answers.
 *
 * Honesty rule: ALL clauses resolve or the whole question returns null. A half-answered compound question
 * never goes out looking complete — the normal chain (and its honest decline) takes it instead.
 *
 * pure: parseCompound     db: runCompound
 */
import { docTypePhrases } from './clauses.js';

/* ------------------------------------------------------------------ lexical pieces */

/** A word that opens a (second) clause: a question word or a measure word. A split happens ONLY before one of these,
 *  so "a customer with an email and a phone" or "Smith and Sons" are never cut. */
const CLAUSE_LEAD = '(?:how\\s+(?:many|much)|what(?:\\s+(?:is|was|are|were))?(?:\'s|s)?|who(?:\\s+(?:is|was|are|were))?(?:\'s)?|which|when|where|total(?:s)?|the\\s+(?:total|average|avg|biggest|largest|smallest|highest|lowest|number)|avg|average|biggest|largest|smallest|highest|lowest|number\\s+of|count\\s+of|(?:their|its)\\s+(?:total|average|avg|combined|dollar))\\b';
const SPLIT_RE = new RegExp(`(?:\\s*,\\s*(?:and\\s+|plus\\s+)?|\\s+(?:and|&|plus)\\s+)(?=${CLAUSE_LEAD})`, 'i');
const CLAUSE_START_RE = new RegExp(`^(?:and\\s+|also\\s+)?${CLAUSE_LEAD}`, 'i');
const LEAD_RE = new RegExp(`^(?:and\\s+|also\\s+)?(${CLAUSE_LEAD})\\s*`, 'i');

/** Nouns that make a clause complete on its own: it names what is being asked about. */
const BASE_NOUNS = [
  'customers?', 'clients?', 'accounts?', 'units?', 'equipment', 'systems?', 'tickets?', 'visits?', 'jobs?', 'technicians?', 'techs?', 'brands?',
  'manufacturers?', 'invoices?', 'bills?', 'quotes?', 'estimates?', 'proposals?', 'permits?', 'agreements?', 'contracts?', 'purchase\\s+orders?', 'pos?',
  'work\\s+orders?', 'warrant(?:y|ies)', 'documents?', 'files?', 'records?', 'repairs?', 'models?', 'cities', 'city', 'zip\\s+codes?', 'receipts?',
  'inspections?', 'installs?', 'installations?', 'payments?', 'balance', 'revenue', 'sales', 'amounts?', 'dollars?',
];
function nounRe(pack) {
  const extra = [];
  try { for (const p of docTypePhrases(pack) ?? []) { const ph = String(p?.phrase ?? p ?? '').trim(); if (ph) extra.push(ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')); } } catch { /* pack optional */ }
  return new RegExp(`\\b(?:${[...BASE_NOUNS, ...extra].join('|')})\\b`, 'i');
}

const MEASURE_ONLY_RE = /^(?:the\s+)?(?:total|totals|sum|average|avg|biggest|largest|smallest|highest|lowest|amount|number)(?:\s+(?:amount|value|dollars?|of\s+(?:them|those|it)|there))?\s*$/i;
const PRONOUN_TAIL_RE = /^(?:(?:many|much)\s+)?(?:did|does|do|has|have|is|was|are|were|of)?\s*(?:he|she|they|it|them|that|those|this|these)?\s*(?:do|did|have|has|get|got|make|made|handle|handled|work|worked|complete|completed|own|there)?\s*$/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const NAME_RE = /\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+\b/;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clean = (s) => String(s ?? '').replace(/[?!.\s]+$/g, '').replace(/\s+/g, ' ').trim();

const PERIOD_RE = /\b(?:(?:in|during|for|of)\s+)?(?:(?:(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+)?(?:19|20)\d{2}|(?:this|last)\s+(?:year|month|quarter))\b/i;
const nounOf = (t, pack) => (String(t).match(nounRe(pack))?.[0] ?? '').toLowerCase().replace(/s$/, '');

/* ------------------------------------------------------------------ "A vs B" */

/** "how many pm tickets vs repair tickets do we have" -> two full clauses sharing the lead and the tail;
 *  "compare invoice totals 2024 vs 2025" -> the same thing for two periods. null when it is not that shape. */
function splitVersus(q) {
  const m = q.match(/^(.*?)\s+(?:vs\.?|versus|against|compared\s+(?:to|with))\s+(.*)$/i);
  if (!m) return null;
  let left = clean(m[1]); const right = clean(m[2]);
  if (!left || !right) return null;
  const leadCompare = /^(?:compare|comparing|compared)\s+/i;
  const isCompare = leadCompare.test(left);
  left = left.replace(leadCompare, '');
  // two periods: "<base> 2024 vs 2025", "<base> in March 2025 vs 2026", "<base> in March 2025 vs March 2026"
  const MON = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|q[1-4])';
  const yl = left.match(new RegExp(`^(.*?)((?:\\s+(?:in|for|of|during))?)\\s+(?:(${MON})\\s+)?((?:19|20)\\d{2})$`, 'i'));
  const yr = right.match(new RegExp(`^(?:(?:in|for|during)\\s+)?(?:(${MON})\\s+)?((?:19|20)\\d{2})$`, 'i'));
  if (yl && yr) {
    const base = clean(yl[1]);
    if (!base) return null;
    const prep = yl[2].trim() || 'in';
    // only the part the second side names is replaced: a bare year keeps the first side's month
    if (yr[1] && yl[3] === undefined) return null; // second side adds a month the first never had: uncertain
    const m2 = yr[1] ?? yl[3];
    const per = (m, y) => (m ? `${m} ${y}` : y);
    return { versus: true, clauses: [`${base} ${prep} ${per(yl[3], yl[4])}`, `${base} ${prep} ${per(m2, yr[2])}`] };
  }
  // two modifiers on one head noun: "<lead> <A> <head>" vs "<B> <head> <tail>"
  const lw = left.split(/\s+/);
  const head = lw[lw.length - 1].toLowerCase();
  const rw = right.split(/\s+/);
  const at = rw.findIndex((w, i) => i >= 0 && w.toLowerCase() === head);
  if (at < 0 || head.length < 3) return null;
  const bPhrase = rw.slice(0, at + 1).join(' ');
  const tail = rw.slice(at + 1).join(' ');
  const c1 = clean(`${left} ${tail}`);
  // the lead is everything up to the first noun-ish modifier of A: keep the leading question phrase only
  const lead = left.match(new RegExp(`^(${CLAUSE_LEAD})`, 'i'))?.[1];
  if (!lead) return null;
  const c2 = clean(`${lead} ${bPhrase} ${tail}`);
  return { versus: true, clauses: [c1, c2] };
}

/* ------------------------------------------------------------------ parse (pure) */

/**
 * @returns {null | {mode:'compound', clauses:string[], versus?:boolean, original:string, pack?:object}}
 */
export function parseCompound(question, pack) {
  const q = clean(question);
  if (!q || q.length > 240) return null;
  // "smallest and largest invoice", "the oldest and the newest quote": one noun, two extremes -> one clause per extreme
  const ex = q.match(/^(?:(?:what|which)(?:'s|\s+(?:is|was|are|were))\s+)?(?:the\s+)?(smallest|lowest|cheapest|oldest|earliest|largest|biggest|highest|newest|latest)\s+(?:and|&|or)\s+(?:the\s+)?(smallest|lowest|cheapest|oldest|earliest|largest|biggest|highest|newest|latest)\s+((?:\w+\s+){0,2}\w+)$/i);
  if (ex && ex[1].toLowerCase() !== ex[2].toLowerCase() && nounRe(pack).test(ex[3])) {
    return { mode: 'compound', clauses: [`what is the ${ex[1]} ${ex[3]}`, `what is the ${ex[2]} ${ex[3]}`], original: q, pack, extremes: true };
  }
  // "how many service tickets and invoices do we have": one count word, several kinds of paper -> one clause each
  {
    const m = q.match(/^(how\s+many|number\s+of|count\s+of)\s+(.+?)\s+((?:do|does|did|are|is|have|has)\b.*|on\s+file.*|in\s+total.*)?$/i);
    const list = m ? m[2].split(/\s*,\s*(?:and\s+|plus\s+)?|\s+(?:and|plus|&)\s+/i).map(clean).filter(Boolean) : [];
    const NOUN = nounRe(pack);
    const whole = (t) => NOUN.test(t) && t.split(/\s+/).length <= 3;
    if (m && list.length >= 2 && list.length <= 4 && list.every(whole)) {
      const tail = m[3] ? ` ${m[3]}` : '';
      return { mode: 'compound', clauses: list.map((t) => clean(`${m[1]} ${t}${tail}`)), original: q, pack };
    }
  }
  const vs = splitVersus(q);
  if (vs) return { mode: 'compound', clauses: vs.clauses, versus: true, original: q, pack };
  // "total of invoices in 2024 and in 2025": one question, two windows -> one clause per window (never a combined figure that was not asked, never a year read as an amount)
  {
    const m = q.match(/^(.*?\b(?:in|for|during))\s+((?:19|20)\d{2})\s+(?:and|&|plus)\s+(?:in|for|during)\s+((?:19|20)\d{2})\b(.*)$/i);
    if (m && m[2] !== m[3] && nounRe(pack).test(m[1])) {
      const mk = (y) => { const t = clean(`${m[1]} ${y}${m[4]}`); return CLAUSE_START_RE.test(t) || /^(?:what|total|sum)\b/i.test(t) ? t : `how many ${t}`; };
      return { mode: 'compound', clauses: [mk(m[2]), mk(m[3])], original: q, pack };
    }
  }
  // "tickets in 2024, tickets in 2025 and tickets in 2026": the same kind of paper asked for in several windows -> one clause each
  {
    const lst = q.split(/\s*,\s*(?:and\s+|plus\s+)?|\s+(?:and|plus)\s+/i).map(clean).filter(Boolean);
    const NOUN = nounRe(pack);
    if (lst.length >= 2 && lst.length <= 4 && !CLAUSE_START_RE.test(lst[0]) && lst.every((p) => NOUN.test(p) && /\b(?:19|20)\d{2}\b/.test(p) && !CLAUSE_START_RE.test(p))) {
      return { mode: 'compound', clauses: lst.map((p) => `how many ${p}`), original: q, pack };
    }
  }
  const parts = q.split(SPLIT_RE).map(clean).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  if (!LEAD_RE.test(parts[0]) && !new RegExp(`^${CLAUSE_LEAD}`, 'i').test(parts[0])) return null;
  return { mode: 'compound', clauses: parts, original: q, pack };
}

/* ------------------------------------------------------------------ carrying context into short clauses */

/** The clause after its leading question word, and the leading word itself. */
function leadOf(clause) {
  const m = clause.match(LEAD_RE);
  if (!m) return { lead: '', rest: clause };
  return { lead: m[1].trim(), rest: clause.slice(m[0].length).trim() };
}

/**
 * Finish clause `cur` using the clause before it. Returns {text} (a complete standalone question),
 * or null
 * (cannot be finished — the whole compound question is then left alone).
 */
const DOC_ID_RE = /\b[A-Z]{1,4}-?\d{3,}\b/;
/** A record the clause points at: a document number or a person's full name (a name typed with capitals, not at the start of the sentence). */
function anchorOf(text) {
  const id = text.match(DOC_ID_RE);
  if (id) return id[0];
  const nm = text.replace(/^\S+\s+/, '').match(NAME_RE);
  return nm ? nm[0] : null;
}

export function completeClause(prev, cur, pack) {
  const done = completeClauseInner(prev, cur, pack);
  if (!done?.text) return done;
  // the earlier clause names ONE record ("INV-20075", "Kevin Pratt") and this one names none: a short lookup ("and who was the tech") is about that record;
  // anything else is ambiguous in scope, so the question is left to the normal chain rather than answered for the whole business
  const pa = anchorOf(prev);
  if (pa && !anchorOf(done.text) && done.text === cur) {
    const { lead, rest } = leadOf(cur);
    if (/^(?:who|what|when|which|how\s+much)\b/i.test(lead) && rest.split(/\s+/).length <= 5) return { text: clean(`${cur} for ${pa}`) };
    return null;
  }
  return done;
}

// "what did they total", "and their total value", "what is their average": a money measure of the SET the earlier clause counted
const PRON_MEASURE_RE = /^(?:and\s+)?(?:what\s+(?:did|do|does|is|was|are|were)\s+(?:they|it|those|these|that)\s+(total|come\s+to|add(?:ed)?\s+up(?:\s+to)?|sum(?:med)?(?:\s+to)?|average)|what(?:'s|\s+is|\s+was|\s+are|\s+were)\s+(?:their|its|the)\s+(total|combined|average|avg)(?:\s+(?:value|amount|dollars?))?|(?:their|its)\s+(total|combined|average|avg|dollar)(?:\s+(?:value|amount|dollars?))?)\s*$/i;
// "total invoiced", "total proposed": the verb form names the kind of paper
const VERB_KIND = { invoiced: 'invoices', billed: 'invoices', quoted: 'proposals', proposed: 'proposals', estimated: 'proposals' };
/** A finished earlier clause as the thing a later money measure is about ("how many invoices in 2022" -> "invoices in 2022"), or null when it is not a plain "<count word> <things>" clause. */
function subjectOfPrev(prev) {
  const m = String(prev ?? '').match(/^(?:how\s+many|number\s+of|count\s+of|the\s+number\s+of)\s+(.+)$/i);
  if (!m) return null;
  const body = m[1].trim();
  // "invoices did Wyatt Coburn write" -> "invoices by Wyatt Coburn" is a person's work: not carried (the money readers have no such scope)
  if (/\b(?:did|does|do|has|have)\s+[A-Z]/.test(body)) return null;
  return body;
}
function completeClauseInner(prev, cur, pack) {
  const NOUN = nounRe(pack);
  { // a money measure of the set the earlier clause named
    const pm = cur.match(PRON_MEASURE_RE);
    if (pm) {
      const word = (pm[1] || pm[2] || pm[3] || '').toLowerCase();
      const body = subjectOfPrev(prev);
      if (!body || !NOUN.test(body)) return null;
      const measure = /average|avg/.test(word) ? 'average' : 'total';
      return { text: `what is the ${measure} of ${body}`, measureOnly: true };
    }
    const vk = cur.match(/^(?:and\s+)?total\s+(invoiced|billed|quoted|proposed|estimated)\s*$/i);
    if (vk) return { text: `what is the total of ${VERB_KIND[vk[1].toLowerCase()]}`, measureOnly: true };
  }
  const { lead, rest } = leadOf(cur);
  if (!lead) return NOUN.test(cur) ? { text: cur } : null;
  // already names its own subject: stands alone ("how many units", "total of maintenance agreements")
  if (rest && NOUN.test(rest)) {
    // a measure clause with a noun but no period / name inherits the earlier clause's period when it has one
    return { text: cur, carryPeriod: true };
  }
  const p = leadOf(prev);
  // 1) the measure alone: "...and what was the total" -> the same thing the first clause counted, as a total
  if (!rest || MEASURE_ONLY_RE.test(rest)) {
    if (!p.rest || !NOUN.test(p.rest)) return null;
    const measure = /\b(?:average|avg)\b/i.test(`${lead} ${rest}`) ? 'average' : /\b(?:biggest|largest|highest)\b/i.test(`${lead} ${rest}`) ? 'biggest' : /\b(?:smallest|lowest)\b/i.test(`${lead} ${rest}`) ? 'smallest' : /\bnumber|many\b/i.test(`${lead} ${rest}`) ? 'count' : 'total';
    if (measure === 'count') return null; // "...and how many" with nothing after it: nothing says what to count
    return { text: `what is the ${measure} of ${p.rest}`, measureOnly: true };
  }
  // 2) a pointer back ("...and how many did he do") needs the earlier answer's own number to mean the same thing as the question: not answered here
  if (PRONOUN_TAIL_RE.test(rest)) return null;
  // 2b) the same sentence about another person: "how many tickets did Danny Ochoa do" + "how many did Kevin Pratt do"
  {
    const nb = (p.rest || prev).match(NAME_RE); const nc = rest.match(NAME_RE);
    if (nb && nc && nb[0] !== nc[0] && (p.rest || prev).replace(nb[0], '\u00a7').endsWith(rest.replace(nc[0], '\u00a7'))) {
      return { text: clean(`${p.lead ? `${p.lead} ` : ''}${(p.rest || prev).replace(nb[0], nc[0])}`) };
    }
  }
  // 3) a swapped detail: a period, a place, a person
  const body = p.rest || prev;
  const prefix = p.lead ? `${p.lead} ` : '';
  const prep = rest.match(/^(in|at|for|from|during|by|of)\s+(.+)$/i);
  const payload = prep ? prep[2] : rest;
  if (/^(?:19|20)\d{2}$/.test(payload) || /^(?:q[1-4]\s+)?(?:19|20)\d{2}$/i.test(payload) || /^(?:in\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(payload)) {
    const swapped = body.replace(/\b(?:(?:in|for|during|of)\s+)?(?:(?:q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:19|20)\d{2}\b/i, `${prep ? prep[1] : 'in'} ${payload}`);
    if (swapped !== body) return { text: clean(`${prefix}${swapped}`) };
    return { text: clean(`${prefix}${body} ${prep ? prep[1] : 'in'} ${payload}`) };
  }
  if (/^[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+)*$/u.test(payload)) {
    // a name or a place: replaces the earlier clause's name/place of the same kind
    if (prep) {
      const m = body.match(/\b(in|at|from|for|by|of)\s+((?:[A-Z][\p{L}'’.-]+)(?:\s+[A-Z][\p{L}'’.-]+)*)/u);
      if (m) return { text: clean(`${prefix}${body.replace(m[0], `${prep[1]} ${payload}`)}`) };
      return null;
    }
    const nm = body.match(NAME_RE);
    if (nm && /\s/.test(payload)) return { text: clean(`${prefix}${body.replace(nm[0], payload)}`) };
    const place = body.match(/\b(in|at|from)\s+((?:[A-Z][\p{L}'’.-]+)(?:\s+[A-Z][\p{L}'’.-]+)*)/u);
    if (place && !/\s/.test(payload)) return { text: clean(`${prefix}${body.replace(place[0], `${place[1]} ${payload}`)}`) };
    return null;
  }
  return null;
}
/* ------------------------------------------------------------------ run (db) */

const DEFAULT_LABEL = (c) => `${cap(clean(c))}?`;

/** An answer that says it could not do it is not an answer to a clause. */
function isDecline(d) {
  if (!d || d.kind === 'no-answer' || d.kind === 'decline' || d.kind === 'refusal') return true;
  return /couldn'?t work that particular question out|not in your records|can'?t find|isn'?t recorded|could not find|which .* do you mean/i.test(String(d.text ?? ''));
}

/** Other wordings of the same money question that the money reader knows ("invoice totals in 2024" -> "total invoices in 2024"). */
function moneyCandidates(text) {
  const out = [text];
  const flip = text.replace(/\b((?:[a-z]+\s+){0,2}?)(invoice|quote|estimate|proposal|bill|purchase\s+order|po)s?\s+totals?\b/i, (_m, a, n) => `total ${a}${n}s`);
  if (flip !== text) out.push(flip);
  const m = text.match(/^(?:what\s+(?:is|was|are|were)\s+)?(?:the\s+)?total(?:s)?\s+(?:of|for)\s+(.+)$/i);
  if (m) {
    out.push(`${m[1]} total`);
    if (/\b(?:agreements?|contracts?|plans?)\b/i.test(m[1])) out.push(`total ${m[1].replace(/\b(agreements?|contracts?|plans?)\b/i, '$1 fees')}`);
  }
  return [...new Set(out)];
}

/** One finished clause through the lanes api/ask.js tries before the model, in the same order, each exactly as ask.js runs it. */
async function runLanes(db, text, { today, tenantVocab, pack }) {
  const { withCitations } = await import('../citations/enrich.js');
  const { normalizeQuestion } = await import('../nlNormalize.js');
  const { mentionsFutureYear } = await import('../analytics.js');
  if (mentionsFutureYear(text, today)) return null;
  // a business concept this organization's records never track (a warranty claim, a renewal reminder): ask.js declines it before any lane; so does each clause
  const { detectUntrackedConcept } = await import('../concepts/registry.js');
  if (detectUntrackedConcept(text, { pack })) return null;
  const ok = (d) => (d && typeof d === 'object' && !isDecline(d) ? d : null);

  // the records-first lane (a stored fact of one named record: "who was the tech for INV-20075") is tried before every older lane, as in ask.js
  const rec = await import('../records/lane.js');
  const recordsOn = rec.recordsFirstEnabled();
  if (recordsOn) {
    const rr = await rec.runRecordsLane(db, text, { today, phase: 'early' }).catch(() => null);
    const d = ok(rr?.data);
    if (d) return d;
  }
  const { classifyRelationsQuestion, answerRelationsQuestion } = await import('../relations/questions.js');
  if (classifyRelationsQuestion(text)) {
    const d = ok(await answerRelationsQuestion({ withTenant: (_c, fn) => fn(db), ctxArg: null, question: text, today }));
    if (d) return d;
  }
  const { classifyDeterministic, runDeterministic } = await import('../deterministicRouter.js');
  const det = classifyDeterministic(text, { tenantVocab });
  if (det) {
    const d = ok(await withCitations(db, runDeterministic(db, det, { today })));
    if (d) return d;
  }
  const { classifyFastPath, isFastPathEnabled } = await import('../fastPath.js');
  if (isFastPathEnabled()) {
    const fp = classifyFastPath(text);
    if (fp) {
      const { runFastPath } = await import('../fastPathQuery.js');
      const d = ok(await withCitations(db, runFastPath(db, fp, { today })));
      if (d) return d;
    }
  }
  const norm = normalizeQuestion(text, { pack, tenantVocab }).normalized || text;
  const { isMoneyQuestion } = await import('../analytics.js');
  const { isFinancialQuestion } = await import('../financials/classify.js');
  if (isMoneyQuestion(norm) || isFinancialQuestion(norm)) {
    const { answerMoneyQuestion } = await import('../financials/moneyGate.js');
    for (const cand of moneyCandidates(norm)) {
      const r = await answerMoneyQuestion({ withTenant: (_c, fn) => fn(db), ctxArg: null, question: cand, today });
      const d = r?.handled ? ok(r.data) : null;
      if (d) return d;
    }
    return null;
  }
  const viaAnalytics = await runAnalytics(db, norm, { today, tenantVocab });
  if (viaAnalytics) return viaAnalytics;
  if (recordsOn) {
    const rr = await rec.runRecordsLane(db, text, { today, phase: 'late' }).catch(() => null);
    return ok(rr?.data);
  }
  return null;
}

async function runAnalytics(db, text, { today, tenantVocab }) {
  const { detectAnalyticsPlan } = await import('../analytics/detPlan.js');
  const raw = detectAnalyticsPlan(text, tenantVocab, today);
  if (!raw) return null;
  const A = await import('../analytics.js');
  const cond = A.detectedConditions(text);
  if (cond && cond.size) return null; // a condition the plan vocabulary cannot express: left to the normal chain, never answered without it
  const mod = await import('../routes/analytics.js');
  const plan = mod.finalizePlanInput(raw, text, today);
  if (!plan) return null;
  // the same leftover-condition check the single-question planner applies (a clause must not be answered with a bigger or different question's figure)
  try {
    const { leftoverWords, leftoverEnabled, domainWordsFromVocab } = await import('../router/leftover.js');
    if (leftoverEnabled()) {
      const sig = (q) => { const r = detectAnalyticsPlan(q, tenantVocab, today); return JSON.stringify((r ? mod.finalizePlanInput(r, q, today) : null) ?? null); };
      const bare = typeof mod.isBarePlan === 'function' ? mod.isBarePlan(plan) : false;
      if (leftoverWords(text, sig, { lane: 'compound', domainWords: domainWordsFromVocab(tenantVocab), plain: bare, entityKey: plan.entity }).length) return null;
    }
  } catch { return null; }
  if (A.suspiciousUnfilteredCustomerPlan(plan, text)) return null;
  if (A.missingConditions(plan, text).size) return null;
  const { documentsHaveAudience } = await import('../audience/probe.js');
  const { audienceFilterSql } = await import('../audience/sql.js');
  const teamScoped = A.isTeamScopedQuestion(text);
  const has = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const audienceClause = audienceFilterSql({ docAlias: 'd', hasAudienceColumn: has, teamScoped });
  const timeRangeLabel = plan.timeRange ? A.resolveAnyTimeRange(text, today)?.label ?? null : null;
  const data = await mod.executeAnalyticsPlan(db, { ...plan, teamScoped }, { today, timeRangeLabel, audienceClause });
  if (!data || isDecline(data)) return null;
  // the same precision check ask.js applies to an analytics answer (a ranking asked, a bare total given, ...)
  const { guardAnalyticsAnswer } = await import('../router/guard/check.js');
  const g = await guardAnalyticsAnswer({ question: text, data, tenantVocab, withTenant: (_c, fn) => fn(db), ctxArg: null });
  return g.blocked ? null : data;
}

/**
 * The word right before the thing being asked about ("PM tickets", "Navien units") must have changed the answer: re-ask without it, and if
 * the answer is identical the lanes ignored it, so the figure answers a bigger question than the one typed. Returns true when it was ignored.
 */
async function modifierIgnored(db, text, data, ctx, pack) {
  const NOUN = nounRe(pack);
  const m = text.match(NOUN);
  if (!m) return false;
  const before = text.slice(0, m.index).trim().split(/\s+/);
  const mod = before[before.length - 1];
  if (!mod || mod.length < 2 || !/^[A-Za-z][A-Za-z-]*$/.test(mod)) return false;
  if (isStopWord(mod)) return false;
  // "service ticket", "work order", "purchase order": the modifier is part of the kind's own name
  if (NOUN.test(`${mod} ${m[0]}`) && new RegExp(`\\b${mod}\\s+${m[0]}`, 'i').test(text) && nounRe(pack).exec(`${mod} ${m[0]}`)?.[0].toLowerCase() === `${mod} ${m[0]}`.toLowerCase()) return false;
  const without = clean(text.slice(0, m.index).trim().split(/\s+/).slice(0, -1).join(' ') + ' ' + text.slice(m.index));
  const other = await runLanes(db, without, ctx).catch(() => null);
  return Boolean(other) && String(other.text) === String(data.text);
}
function isStopWord(w) {
  return /^(?:the|a|an|our|my|your|all|any|each|every|many|much|total|many|of|in|on|at|for|do|does|did|we|have|has|are|is|was|were|how|what|which|who|number|count|avg|average|biggest|largest|smallest|highest|lowest|and|by|per|open|new)$/i.test(w);
}

export async function runCompound(db, intent, { today } = {}) {
  const clauses = intent.clauses;
  const pack = intent.pack;
  const texts = [];
  for (let i = 0; i < clauses.length; i++) {
    if (i === 0) { texts.push(clauses[0]); continue; }
    const c = completeClause(texts[i - 1], clauses[i], pack);
    if (!c?.text) return null; // cheap exit before any database work
    let t = c.text;
    // a total / average / biggest of "it" after two different things is ambiguous: not guessed
    if (c.measureOnly && i >= 2 && nounOf(texts[i - 1], pack) !== nounOf(texts[i - 2], pack)) return null;
    // a clause with its own noun but no period inherits the earlier clause's period
    if (c.carryPeriod && !PERIOD_RE.test(t)) {
      const per = texts[i - 1].match(PERIOD_RE)?.[0];
      if (per) t = clean(`${t} ${/^(?:in|during|for|of)\b/i.test(per) ? '' : 'in '}${per}`);
    }
    texts.push(t);
  }
  let tenantVocab = null;
  try { const { buildTenantVocab } = await import('../vocab/tenantVocab.js'); tenantVocab = await buildTenantVocab(db, pack); } catch { tenantVocab = null; }
  const ctx = { today, tenantVocab, pack };
  const answers = [];
  for (let i = 0; i < texts.length; i++) {
    let data = null;
    try { data = await runLanes(db, texts[i], ctx); } catch { data = null; }
    if (!data) return null;
    if (await modifierIgnored(db, texts[i], data, ctx, pack).catch(() => false)) return null;
    answers.push({ data, label: DEFAULT_LABEL(texts[i]) });
  }
  const text = answers.map((a, i) => `${i + 1}. ${a.label} ${String(a.data.text ?? '').trim()}`).join(' ');
  const facts = answers.flatMap((a) => a.data.facts ?? []);
  const records = answers.flatMap((a) => a.data.records ?? []);
  const sources = answers.flatMap((a) => a.data.sources ?? []);
  const { answerEnvelope } = await import('../scope.js');
  const { attachCitations } = await import('../citations/records.js');
  const out = answerEnvelope({ text, facts, sources });
  return attachCitations(out, {
    records,
    total: answers.reduce((s, a) => s + Number(a.data.recordsTotal ?? (a.data.records ?? []).length), 0),
    claimedCount: null,
    basis: `Answered each part of your question separately from your records: ${answers.map((a) => a.label.replace(/\?$/, '')).join('; ')}.`,
  });
}

export { runLanes as _runLanes };
