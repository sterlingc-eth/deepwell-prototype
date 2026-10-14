/**
 * dql/proposer - Donovan's LOCAL PLAN PROPOSER (R20): the plan translator's job (translator/), done without a model call.
 *
 *   localProposerEnabled()                          DONOVAN_LOCAL_PROPOSER=0 turns it off, =1 forces it on; the shipped default is DEFAULT_ON below
 *   proposePlan(question, {tv, pack, today})        -> {raw, label, prob, view} | {none: reason}      the model's reading of the question's SHAPE + the detectors' slots, as a translator plan
 *   proposeAndValidate(question, ctx)               -> {ok, plan, label, prob, raw} | {ok:false, reason}   the plan must also pass translator/validate.js (schema, slot values exist
 *                                                      in the data, the coverage rule, every condition word represented, nothing invented) and AGREE with the learned heads
 *                                                      (learned/model-v3.json: the question must not read as a multi-part, follow-up or untracked-measure question)
 *
 * The model (learned/proposer.json, trained by scripts/train-dql-proposer.py over slot-masked questions of 24 companies) predicts only the SKELETON:
 * op, entity (document / visit / customer / unit), measure, group-by, distinct, limit, ask - or "none". Every slot value (names, cities, brands, stored categories,
 * kinds of paper, periods, money bounds) comes from the deterministic detectors (proposer/slots.js). Nothing here writes an answer: DQL executes the plan.
 */
import fs from 'node:fs';
import { compileVocab, lexWords } from '../vocab.js';
import { questionTokens, validateTranslatedPlan } from '../translator/validate.js';
import { FIELD_MENU } from '../translator/schema.js';
import { classify2 } from '../learned/linear.js';
import { shapeFeats, shapeHeads } from '../learned/shape3.js';
import { detectSlots, maskView, maskLexicon } from './slots.js';
import { parseSkeleton } from './skeleton.js';
import { extractCore } from './core.js';

export const DEFAULT_ON = false;
export const localProposerEnabled = (env = process.env) => (env?.DONOVAN_LOCAL_PROPOSER === '1' ? true : env?.DONOVAN_LOCAL_PROPOSER === '0' ? false : DEFAULT_ON);

let STATE = null;
function load() {
  if (STATE !== null) return STATE || null;
  try {
    const model = JSON.parse(process.env.DONOVAN_PROPOSER_MODEL ? fs.readFileSync(process.env.DONOVAN_PROPOSER_MODEL, 'utf8') : fs.readFileSync(new URL('../learned/proposer.json', import.meta.url), 'utf8')); // the env override is for the held-out evaluation only
    STATE = { model, generic: new Set(model.generic) };
  } catch { STATE = false; }
  return STATE || null;
}
const LEX = new WeakMap();
const lexOf = (vocab) => { let l = LEX.get(vocab); if (!l) { l = maskLexicon(vocab.card, vocab.customerNames ? [...vocab.customerNames] : []); LEX.set(vocab, l); } return l; };

const ROLE = (r) => (r.customer && !r.tech && !r.vendor ? 'customer' : r.tech && !r.customer && !r.vendor ? 'tech' : r.vendor && !r.customer && !r.tech ? 'vendor' : null);
const words = (qt, i, j) => qt.slice(i, j).map((t) => t.w).join(' ');

/** the detectors' slots as translator filters; null when a slot cannot be placed (the question is released) */
function buildFilters(qt, slots, entity, menu) {
  const out = [];
  for (const s of slots.spans) {
    if (s.kind === 'doc') continue;
    let field = null; let value = null;
    if (s.kind === 'name') { const r = ROLE(s.roles); if (!r) return null; field = entity === 'customer' ? (r === 'customer' ? 'name' : null) : r; value = s.roles.display; }
    else if (s.kind === 'city') { field = 'city'; value = s.value; }
    else if (s.kind === 'brand') { field = entity === 'customer' ? 'hasBrand' : 'brand'; value = s.value; }
    else if (s.kind === 'cat') { field = s.field; value = s.value; }
    if (!field || !menu.has(field)) return null;
    out.push({ field, op: 'eq', value, words: words(qt, s.i, s.j) });
  }
  for (const m of slots.money) out.push({ field: 'total', op: m.op, value: m.value, words: words(qt, m.i, m.j) });
  return out;
}

/** shapes the proposer never plans: an "as of / end of" period (a cumulative reading), and a where-from ask (the answer must carry its source papers) */
const AS_OF = /\b(?:as of|end of|start of|beginning of|up to date|through the end|by the end|since the start|since the beginning)\b/i;
const WHERE_FROM = /\b(?:which|what) (?:documents?|files?|papers?|records?|pages?)\b|\bbased on\b|\bsources?\b|\bwhere (?:is|does|did|do) (?:that|this|it|the)\b|\bcite\b|\bproof\b|\bshow me the (?:documents?|papers?|files?)\b|\bbacking\b|\bsay how many\b/i;


const GROUP_WORD = /\b(?:broken down|break down|breakdown|grouped?|split|per|each)\b|\bby (?:the )?(?:day|week|month|quarter|year|city|customer|client|tech|technician|vendor|type|status|brand|make|manufacturer|service|kind|weekday)\b/i;
const OP_WORDS = {
  count: /\b(?:how many|number of|count|tally|headcount|how much|total number|#)/i, count_distinct: /\b(?:how many|number of|count|tally)\b/i,
  list: /\b(?:list|show|which|who|what|give me|names?|tell me)\b/i, exists_yes_no: /\b(?:any|is there|are there|do we|did we|have we|has|have|does|ever|got|exist)\b/i,
};
const DISTINCT_WORD = /\b(?:different|distinct|unique|separate|individual|various|diff)\b/i;
const ALL_DOCS_OK = new Set(('how many much number numbers of count total tally all the a an our my we you i do does did have has had are is was were there on in at for to from with by and or file files document documents doc docs paper papers record records paperwork stored uploaded system ever so far please can could tell me show give what whats which list pages page entries entry any here sheets forms form overall together combined then just only it that this been being be now currently right do not').split(' '));
const PAPER_WORD = /\b(?:documents?|docs?|files?|papers?|paperwork|records?|entries|entry|forms?|pages?)\b/i;
/** guards on top of the validator: things the validator's word lists let through but that change what is asked */
function extraGuard(q, qt, slots, sk, vocab) {
  if (!sk.groupBy.length && GROUP_WORD.test(q)) return 'group-word-without-group';
  if (DISTINCT_WORD.test(q) !== (sk.op === 'count_distinct')) return 'distinct-word';
  const ow = OP_WORDS[sk.op]; if (ow && !ow.test(q)) return `op-word:${sk.op}`;
  if (sk.entity === 'document' && !sk.visit && !slots.docType && !PAPER_WORD.test(q)) return 'entity-word';
  // all papers (no kind named): nothing else in the question may name a kind or a condition the plan does not carry ("signed consent forms" is a kind this company does not keep)
  if (sk.entity === 'document' && !sk.visit && !slots.docType) { const extra = qt.find((t, i) => !slots.taken[i] && !ALL_DOCS_OK.has(t.w) && !/^\d+$/.test(t.w)); if (extra) return `all-docs-extra-word:${extra.w}`; }
  if (qt.some((t, i) => !slots.taken[i] && /^[b-hj-z]$/.test(t.w))) return 'initial'; // "deb r.": a name the records may know only in full
  const lex = lexWords();
  // R22: a single common English word read as a brand / city / stored value ("true", "will", "may") is a slot the detectors guessed - release
  for (const sp of slots.spans) if ((sp.kind === 'brand' || sp.kind === 'city' || sp.kind === 'cat') && sp.j - sp.i === 1 && lex.has(qt[sp.i].w)) return `common-word-slot:${qt[sp.i].w}`;
  if (sk.op === 'latest' || sk.op === 'earliest') return 'extreme-date';
  if (/\b(?:on|onward|onwards|forward|and (?:later|earlier|after|before))\b/i.test(q) && slots.time) return 'open-ended-time';
  for (let i = 0; i < qt.length; i++) {
    const w = qt[i].w;
    if (!slots.taken[i] && w.length >= 4 && vocab.nameWords.has(w) && !lex.has(w)) return 'partial-name';
  }
  return null;
}

export function proposePlan(question, { tv, pack, today } = {}) {
  const S = load();
  if (!S || !tv) return { none: 'no-model' };
  const q = String(question ?? '').trim();
  if (q.length < 6 || q.length > 300) return { none: 'length' };
  const vocab = compileVocab(tv, pack);
  const qt = questionTokens(q, vocab);
  if (!qt.length) return { none: 'empty' };
  if (AS_OF.test(q)) return { none: 'as-of-period' };
  if (WHERE_FROM.test(q)) return { none: 'where-from' };
  const slots = detectSlots(qt, vocab, today);
  const view = maskView(qt, slots, lexOf(vocab), S.generic);
  const r = classify2(S.model.head, shapeFeats(view));
  const th = Number(process.env.DONOVAN_PROPOSER_TH) || (S.model.thresholds?.prob ?? 0.9); // the env override is for the threshold sweep of the evaluation only
  const head = S.model.head; const noneIdx = head.classes.indexOf('none');
  let bi = -1; for (let i = 0; i < r.p.length; i++) if (i !== noneIdx && (bi < 0 || r.p[i] > r.p[bi])) bi = i;
  const label = bi >= 0 ? head.classes[bi] : 'none'; const prob = bi >= 0 ? r.p[bi] : 0; // the best PLANNABLE reading; "none" competes through its probability mass
  if (prob < th) return { none: r.label === 'none' ? 'model-none' : `low:${prob.toFixed(3)}`, prob, label, view };
  const sk = parseSkeleton(label);
  if (!sk) return { none: 'skeleton' };
  const eg = extraGuard(q, qt, slots, sk, vocab);
  if (eg) return { none: `guard:${eg}`, label, prob, view };
  const menu = new Set(FIELD_MENU[sk.entity] ?? []);
  const filters = buildFilters(qt, slots, sk.entity, menu);
  if (!filters) return { none: 'slot-placement', label, prob, view };
  if (slots.leftoverNums > (sk.limit === 'n' ? 1 : 0)) return { none: 'unread-number', label, prob, view };
  if (sk.entity !== 'document' && slots.docKinds.length) return { none: 'doc-on-non-document', label, prob, view };
  const raw = { op: sk.op, entity: sk.entity };
  if (sk.entity === 'document') { if (sk.visit) raw.visit = true; else if (slots.docType) raw.docType = slots.docType; }
  if (filters.length) raw.filters = filters;
  if (slots.time) raw.time = { words: slots.time.words };
  if (sk.measure) raw.measure = { field: sk.measure, ...(sk.op === 'top_n' || sk.op === 'bottom_n' ? { agg: 'sum' } : {}) };
  if (sk.groupBy.length) raw.groupBy = sk.groupBy;
  if (sk.distinct) raw.distinct = sk.distinct;
  if (sk.limit === '1') raw.limit = 1;
  else if (sk.limit === 'n') { if (slots.limitTok.length !== 1) return { none: 'limit-slot', label, prob, view }; raw.limit = slots.limitTok[0]; }
  if (sk.ask) raw.ask = sk.ask;
  return { raw, label, prob, view, vocab };
}

/** question patterns / measures the proposer cannot plan: a confident reading by the learned shape heads releases the question */
const PAT_CONFLICT = new Set(['multi_part', 'pronoun_chain', 'correction', 'followup_refine', 'followup_slot_swap', 'provenance', 'clarify_needed', 'decline_untracked', 'compare_periods', 'compare_two_values', 'change_pct', 'year_over_year', 'never_had', 'repeat_entities', 'hop_related', 'lookup_field', 'find_document', 'line_item_search', 'text_contains', 'yes_no', 'days_between', 'time_since_last', 'inactive_since', 'expiring_soon', 'coming_up', 'ratio', 'rank_of', 'above_average', 'per_entity_avg', 'missing_field', 'duplicates', 'age_of', 'nickname_lookup', 'share_pct', 'trend_over_time']);
const MEAS_OK = new Set(['none', 'total', 'technician', 'customer_name', 'city', 'manufacturer', 'model', 'service_type', 'status', 'vendor', 'date', 'number', 'invoice_number', 'name', 'customer', 'tonnage', 'phone', 'email', 'address']);
export function headsAgree(question, vocab) {
  let h = null;
  try { h = shapeHeads(question, vocab.card, vocab.customerNames ? [...vocab.customerNames] : []); } catch { h = null; }
  if (!h) return { ok: true, note: 'no-heads' };
  if (h.multi.label === 'multi' && h.multi.prob >= 0.5) return { ok: false, why: `heads:multi:${h.multi.prob.toFixed(2)}` };
  if (h.fu.label !== 'none' && h.fu.prob >= 0.5) return { ok: false, why: `heads:${h.fu.label}:${h.fu.prob.toFixed(2)}` };
  if (PAT_CONFLICT.has(h.pat.label) && h.pat.prob >= 0.9) return { ok: false, why: `heads:pat:${h.pat.label}:${h.pat.prob.toFixed(2)}` };
  if (!MEAS_OK.has(h.meas.label) && h.meas.prob >= 0.9) return { ok: false, why: `heads:meas:${h.meas.label}` };
  return { ok: true };
}

function proposeOne(question, { tv, pack, today, snap }) {
  const p = proposePlan(question, { tv, pack, today });
  if (!p.raw) return { ok: false, reason: p.none, label: p.label, prob: p.prob };
  const v = validateTranslatedPlan(p.raw, question, { tv, pack, today, snap });
  if (!v.ok) return { ok: false, reason: `validate:${v.reason}`, label: p.label, prob: p.prob, raw: p.raw };
  const a = headsAgree(question, p.vocab);
  if (!a.ok) return { ok: false, reason: a.why, label: p.label, prob: p.prob, raw: p.raw };
  return { ok: true, plan: v.plan, label: p.label, prob: p.prob, raw: p.raw };
}

/** R22: the question as typed first; when that is released and the text is one question wrapped in inert filler, the same gates again over the core question alone */
export function proposeAndValidate(question, { tv, pack, today, snap } = {}) {
  const ctx = { tv, pack, today, snap };
  const r = proposeOne(question, ctx);
  if (r.ok || process.env.DONOVAN_PROPOSER_CORE === '0') return r;
  let c = null;
  try { c = extractCore(question, compileVocab(tv, pack)); } catch { c = null; }
  if (!c) return r;
  const r2 = proposeOne(c.core, ctx);
  return r2.ok ? { ...r2, core: c.core } : { ...r, coreReason: r2.reason };
}
