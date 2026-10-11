/**
 * dql/learned - Donovan's own small learned planner.
 *
 * Where the deterministic DQL parser gives up (the COVERAGE RULE released the question because of words nothing explained), this module asks a
 * small linear model trained offline on the question factory's oracle-checked plans (scripts/gen-dql-training.mjs + scripts/train-dql-planner.py;
 * api/_lib/dql/learned/model.json) whether those words are only filler. It never reads a slot: names, dates, amounts, document types and
 * cities always come from the deterministic detectors, and the families still build and execute the plan.
 *
 *   leftoverGate(info)      -> {clear: true, ...} when EVERY unexplained word is filler above a high calibrated threshold, the gate agrees,
 *                              and no guard fires; null (= release, exactly as before) otherwise.
 *   verifyPlan(gate, plan)  -> true when the plan the families built agrees with the model's own reading of the question (op, measure, entity,
 *                              document-type role, grouping); false = release.
 *   predictHeads(...)       -> the calibrated head predictions (tests, tooling).
 *
 * Guards kept from the round-4 wording model: negation, a measure/concept noun, modality, scope words, future time, a second clause. Any
 * unexplained word that is one of those (or condition-like: a comparison, a quantity, a time word) releases.
 * No network, no model API. Kill switch: DONOVAN_DQL_LEARNED=0.
 */
import fs from 'node:fs';
import { classifyWords, viewTokens, headFeats, tokFeats, gateFeats } from './features.js';
import { classify, gateProb } from './linear.js';
import { dqlHeads } from './planmap.js';

export const learnedEnabled = () => process.env.DONOVAN_DQL_LEARNED !== '0';
const readUrl = (u) => JSON.parse(fs.readFileSync(u, 'utf8')); // literal new URL(...) so the serverless bundler ships the file

let STATE = null;
function load() {
  if (STATE !== null) return STATE || null;
  try {
    const model = readUrl(new URL('./model.json', import.meta.url));
    STATE = { model, opwords: new Set(model.opwords), compat: new Map() };
    for (const [h, pairs] of Object.entries(model.compat ?? {})) STATE.compat.set(h, new Set(pairs.map((p) => `${p[0]}|${p[1]}`)));
  } catch { STATE = false; }
  return STATE || null;
}

/* ---------------------------------------------------------------------------------------------- guards */
const NEG = /^(?:not|no|never|without|except|excluding|exclude|besides|non|isnt|arent|wasnt|werent|dont|doesnt|didnt|hasnt|havent|hadnt|wont|cant|cannot|neither|nor|none|nobody|nothing|outside|missing|lacking|lack|minus|off|unless|aside|apart)$/;
const MODAL = /^(?:want|wants|wanted|need|needs|needed|should|could|would|if|plan|plans|planning|gonna|will|wish|hope|might|may|can|whether|whats|suppose|imagine|assume|hypothetically)$/;
const FUTURE = /^(?:next|upcoming|coming|future|tomorrow|forecast|projected|expected|soon|later|ahead|eventually|anticipated|predict|predicted)$/;
const SCOPE = /^(?:per|each|every|near|nearby|around|within|covered|under|inside|across|among|amongst|between|versus|vs|compared|compare|relative|against)$/;
const COND = /^(?:more|less|fewer|fewest|most|least|top|bottom|best|worst|biggest|smallest|largest|highest|lowest|first|last|oldest|newest|latest|earliest|before|after|since|until|over|under|above|below|than|at|ago|but|only|exactly|except|total|average|avg|mean|median|sum|count|number|percent|percentage|share|ratio|rate|many|much|longest|shortest|busiest|slowest|fastest|cheapest|priciest|biggest|ever|never|already|yet|still|again|twice|once|both|either|other|another|same|different|similar|duplicate|duplicates|repeat|repeated|late|early|overdue|due|owed|owe|unpaid|paid|pending|open|closed|expired|expiring|active|inactive|lost|won|cancelled|canceled|declined|rejected|accepted|approved|completed|scheduled)$/;
/** Pronouns and back-references: a question that leans on an earlier turn ("which brands were those") is the follow-up engine's job, never a filler guess. */
const DEICTIC = /^(?:those|these|them|they|their|theirs|it|its|ones|former|latter|aforementioned|same|above|earlier|previous|prior|before|that|this|such|he|she|his|her|him|hers)$/;
const NOUNISH = /^(?:tickets?|payments?|calls?|visits?|jobs?|invoices?|quotes?|proposals?|estimates?|bids?|orders?|permits?|agreements?|warrant(?:y|ies)|customers?|clients?|units?|systems?|technicians?|techs?|documents?|appointments?|bills?|contracts?|plans?|equipment|address(?:es)?|phones?|emails?|models?|brands?|serials?|labor|vendors?|installs?|installations?|repairs?|maintenance|startups?|dispatch(?:es)?|inspections?|registrations?|purchases?|receipts?|statements?|deposits?|refunds?|credits?|discounts?|taxes|tax|fees?|charges?|costs?|prices?|amounts?|balances?|hours?|minutes?|revenue|sales|profit|margin|income|expenses?|payroll|salary|salaries|wages?|tips?|rent|leases?|tenants?|patients?|donors?|gifts?|pledges?|matters?|filings?|cases?|vehicles?|vins?|mileage|miles)$/;

/** Words that look like a condition or a concept noun but are mostly plain wording ("number of", "repair" visits): no hard guard, the calibrated models decide (measured on factory dev: no wrong answers at the shipped thresholds). */
const SOFT = new Set(['number', 'repair', 'models', 'address']);

const rawHas = (raw, re) => re.test(String(raw).toLowerCase());
const SECOND_CLAUSE = /\b(?:and|also|plus|then|as well as)\s+(?:by\s+whom|how|what|whats|which|who|whom|when|where|why|the\s+total|show|give|list|tell)\b|\?\s*\S/;

/** Why the gate must not open for these words, or null. `words` = classifyWords output. */
export function guardReason(raw, words) {
  const L = words.filter((t) => t.k === 'L').map((t) => t.w.replace(/'/g, ''));
  if (rawHas(raw, SECOND_CLAUSE)) return 'second-clause';
  for (const w of L) {
    if (SOFT.has(w)) continue;
    if (DEICTIC.test(w)) return `deictic:${w}`;
    if (NEG.test(w)) return `negation:${w}`;
    if (MODAL.test(w)) return `modality:${w}`;
    if (FUTURE.test(w)) return `future:${w}`;
    if (SCOPE.test(w)) return `scope:${w}`;
    if (COND.test(w)) return `condition:${w}`;
    if (NOUNISH.test(w)) return `noun:${w}`;
    if (/\d/.test(w)) return `number:${w}`;
  }
  // a negation the parser itself consumed is fine (it is explained); one it left standing in the raw text next to an unexplained word is not
  const rawNeg = /\b(?:not|no|never|without|except|excluding|besides|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|hasn'?t|haven'?t|hadn'?t|none|nobody|nothing|neither|nor)\b|n't\b/i;
  if (rawNeg.test(raw) && !words.some((t) => t.k === 'E' && NEG.test(t.w))) return 'negation-in-question';
  return null;
}

/* ---------------------------------------------------------------------------------------------- the gate */
export function describe(info) {
  const S = load();
  if (!S) return null;
  const words = classifyWords(info.orig, info.rest, info.left);
  const v = viewTokens(words, S.opwords);
  return { S, words, v };
}

export function leftoverGate(info) {
  if (!learnedEnabled() || !info.left?.length) return null;
  if (process.env.DQL_LEARNED_FORCE === '1') return { clear: true, forced: true };
  const d = describe(info);
  if (!d) return null;
  const { S, words, v } = d;
  const g = guardReason(info.raw, words);
  if (g) { if (info.debug) info.debug.learnedWhy = g; return null; }
  const th = S.model.thresholds ?? { tok: 0.99, gate: 0.99 };
  let minTok = 1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].k !== 'L') continue;
    const r = classify(S.model.tok, tokFeats(v, i));
    const pf = r.p[S.model.tok.classes.indexOf('filler')];
    if (pf < minTok) minTok = pf;
  }
  if (minTok < th.tok) { if (info.debug) info.debug.learnedWhy = `tok:${minTok.toFixed(3)}`; return null; }
  const pg = gateProb(S.model.gate, gateFeats(v, words));
  if (pg < th.gate) { if (info.debug) info.debug.learnedWhy = `gate:${pg.toFixed(3)}`; return null; }
  return { clear: true, tok: minTok, gate: pg, view: v, words };
}

/* ---------------------------------------------------------------------------------------------- heads + plan check */
export function predictHeads(view) {
  const S = load();
  if (!S) return null;
  const f = headFeats(view);
  const out = {};
  for (const h of Object.keys(S.model.heads)) { const r = classify(S.model.heads[h], f); out[h] = { label: r.label, prob: r.prob }; }
  return out;
}

/** The plan the families built must not contradict a confident reading of the question. */
export function verifyPlan(gate, plan) {
  const S = load();
  if (!S || !gate || gate.forced || !gate.view) return true;
  const th = S.model.thresholds?.head ?? 0.9;
  const pred = predictHeads(gate.view);
  const mine = dqlHeads(plan);
  for (const h of Object.keys(pred)) {
    if (pred[h].prob < th) continue;
    const a = pred[h].label; const b = mine[h];
    if (a === b) continue;
    if (S.compat.get(h)?.has(`${a}|${b}`)) continue;
    if (gate.debug) gate.debug.verifyWhy = `${h}: model ${a} (${pred[h].prob.toFixed(2)}) vs plan ${b}`;
    return false;
  }
  return true;
}
