/**
 * dql/learned - Donovan's own small learned planner (round 2).
 *
 * Trained offline on the question factory's oracle-checked plans (two wording banks: scripts/gen-dql-training.mjs + scripts/train-dql-planner-v2.py;
 * api/_lib/dql/learned/model.json) plus the HVAC dev questions. It never reads a slot: names, dates, amounts, document types and cities always come
 * from the deterministic detectors, and the families still build and execute the plan.
 *
 *   leftoverGate(info)      -> hook A, step 1. Where the parser gave up (COVERAGE RULE: words nothing explained): {clear, pending} when the guards pass and
 *                              EVERY unexplained word is filler above a calibrated threshold (token roles); null (= release, exactly as before) otherwise.
 *   verifyPlan(gate, plan)  -> hook A, step 2. The plan the families built (with those words ignored) must agree with the heads' own reading of the question
 *                              (op, measure, entity, document-type role, grouping) and the VERIFY gate (view + unexplained words + the plan's reading) must
 *                              call the answer right above its calibrated threshold; false = release.
 *   supplyOp(info)          -> hook B. All words explained but no operator trigger matched: the heads may supply it (count / sum / avg ...) when very confident.
 *   predictHeads(view)      -> the calibrated head predictions (tests, tooling).
 *
 * The heads read hashed features: word 1-3-grams of the slot-masked view, slot-masked skip-grams, char 2-5-grams, and n-grams over WORD CLUSTERS
 * (PPMI + SVD vectors computed from the training corpus itself, exported as a small word -> cluster table).
 * Guards kept from the round-4 wording model: negation, a measure/concept noun, modality, scope words, future time, a second clause. Any unexplained
 * word that is one of those (or condition-like: a comparison, a quantity, a time word) releases.
 * No network, no model API. Kill switches: DONOVAN_DQL_LEARNED=0 (everything), DONOVAN_DQL_HOOKB=0 (hook B only).
 */
import fs from 'node:fs';
import { classifyWords, viewTokens, headFeats, headFeats2, hashIds, tokFeats, verifyFeats } from './features.js';
import { classify, classify2, verifyProb as linVerify } from './linear.js';
import { dqlHeads } from './planmap.js';

export const learnedEnabled = () => process.env.DONOVAN_DQL_LEARNED !== '0';
const readUrl = (u) => JSON.parse(fs.readFileSync(u, 'utf8')); // literal new URL(...) so the serverless bundler ships the file

let STATE = null;
function load() {
  if (STATE !== null) return STATE || null;
  try {
    const model = readUrl(new URL('./model.json', import.meta.url));
    STATE = { model, opwords: new Set(model.opwords), compat: new Map(), clusters: model.version >= 2 ? model.clusters.map((o) => new Map(Object.entries(o))) : null };
    for (const [h, pairs] of Object.entries(model.compat ?? {})) STATE.compat.set(h, new Set(pairs.map((p) => `${p[0]}|${p[1]}`)));
  } catch { STATE = false; }
  return STATE || null;
}

/* ---------------------------------------------------------------------------------------------- guards */
const NEG = /^(?:not|no|never|without|except|excluding|exclude|besides|non|isnt|arent|wasnt|werent|dont|doesnt|didnt|hasnt|havent|hadnt|wont|cant|cannot|neither|nor|none|nobody|nothing|outside|missing|lacking|lack|minus|off|unless|aside|apart)$/;
const MODAL = /^(?:want|wants|wanted|need|needs|needed|should|could|would|if|plan|plans|planning|gonna|will|wish|hope|might|may|can|whether|whats|suppose|imagine|assume|hypothetically)$/;
const FUTURE = /^(?:next|upcoming|coming|future|tomorrow|forecast|projected|expected|soon|later|ahead|eventually|anticipated|predict|predicted)$/;
const SCOPE = /^(?:per|each|every|near|nearby|around|within|covered|under|inside|across|among|amongst|between|versus|vs|compared|compare|relative|against)$/;
const COND = /^(?:single|stand|stands|mean|means|meant|meaning|define|definition|abbreviation|acronym|higher|lower|bigger|smaller|greater|larger|exceed|exceeds|exceeding|beat|beats|more|less|fewer|fewest|most|least|top|bottom|best|worst|biggest|smallest|largest|highest|lowest|first|last|oldest|newest|latest|earliest|before|after|since|until|over|under|above|below|than|at|ago|but|only|exactly|except|total|average|avg|mean|median|sum|count|number|percent|percentage|share|ratio|rate|many|much|longest|shortest|busiest|slowest|fastest|cheapest|priciest|biggest|ever|never|already|yet|still|again|twice|once|both|either|other|another|same|different|similar|duplicate|duplicates|repeat|repeated|late|early|overdue|due|owed|owe|unpaid|paid|pending|open|closed|expired|expiring|active|inactive|lost|won|cancelled|canceled|declined|rejected|accepted|approved|completed|scheduled)$/;
/** Pronouns and back-references: a question that leans on an earlier turn ("which brands were those") is the follow-up engine's job, never a filler guess. */
const DEICTIC = /^(?:those|these|them|they|their|theirs|it|its|ones|former|latter|aforementioned|same|above|earlier|previous|prior|before|that|this|such|he|she|his|her|him|hers)$/;
const NOUNISH = /^(?:tickets?|payments?|calls?|visits?|jobs?|invoices?|quotes?|proposals?|estimates?|bids?|orders?|permits?|agreements?|warrant(?:y|ies)|customers?|clients?|units?|systems?|technicians?|techs?|documents?|appointments?|bills?|contracts?|plans?|equipment|address(?:es)?|phones?|emails?|models?|brands?|serials?|labor|vendors?|installs?|installations?|repairs?|maintenance|startups?|dispatch(?:es)?|inspections?|registrations?|purchases?|receipts?|statements?|deposits?|refunds?|credits?|discounts?|taxes|tax|fees?|charges?|costs?|prices?|amounts?|balances?|hours?|minutes?|revenue|sales|profit|margin|income|expenses?|payroll|salary|salaries|wages?|tips?|rent|leases?|tenants?|patients?|donors?|gifts?|pledges?|matters?|filings?|cases?|vehicles?|vins?|mileage|miles)$/;

/** R24 (handoff learning): why a word may never be learned as filler or rewritten (negation, modality, future, scope, condition, back-reference, a measure / concept noun, a number), or null. */
export function wordBlocked(word) {
  const w = String(word ?? '').toLowerCase().replace(/'/g, '');
  if (!/^[a-z]{2,20}$/.test(w)) return 'shape';
  if (DEICTIC.test(w)) return 'deictic';
  if (NEG.test(w)) return 'negation';
  if (MODAL.test(w)) return 'modality';
  if (FUTURE.test(w)) return 'future';
  if (SCOPE.test(w)) return 'scope';
  if (COND.test(w)) return 'condition';
  if (NOUNISH.test(w)) return 'noun';
  if (/^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|grand|dozen|half)$/.test(w)) return 'number-word';
  return null;
}

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
    if (/^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|grand|dozen|half)$/.test(w)) return `number-word:${w}`;
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
  const th = { tok: 0.9, verify: 0.98, ...(S.model.thresholds ?? {}) };
  if (!S.model.verify) return null; // a model without the verify head cannot open the gate
  let minTok = 1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].k !== 'L') continue;
    const r = classify(S.model.tok, tokFeats(v, i, S.clusters?.[0]));
    const pf = r.p[S.model.tok.classes.indexOf('filler')];
    if (pf < minTok) minTok = pf;
  }
  if (minTok < th.tok) { if (info.debug) info.debug.learnedWhy = `tok:${minTok.toFixed(3)}`; return null; }
  // the verdict itself needs the plan the families build from the detectors' slots (verifyPlan): `pending` until then
  return { clear: true, pending: true, tok: minTok, view: v, words, debug: info.debug };
}

/* ---------------------------------------------------------------------------------------------- heads + plan check */
export function predictHeads(view) {
  const S = load();
  if (!S) return null;
  const out = {};
  if (S.clusters) {
    const ids = hashIds(headFeats2(view, S.clusters));
    for (const h of Object.keys(S.model.heads)) { const r = classify2(S.model.heads[h], ids); out[h] = { label: r.label, prob: r.prob }; }
    return out;
  }
  const f = headFeats(view);
  for (const h of Object.keys(S.model.heads)) { const r = classify(S.model.heads[h], f); out[h] = { label: r.label, prob: r.prob }; }
  return out;
}

/** P(the answer is right with the unexplained words ignored) given the plan the families built; null when the model has no verify head */
export function verifyScore(gate, dh) {
  const S = load();
  if (!S?.model.verify || !gate?.view || !gate.words) return null;
  const ids = hashIds(verifyFeats(gate.view, gate.words, dh, S.clusters?.[0]));
  return linVerify(S.model.verify, ids);
}

/** The plan the families built must agree with a confident reading of the question (op, measure, entity, document-type role, grouping) and
 *  the verify gate (view + unexplained words + the plan's own reading) must call the answer right above its calibrated threshold. */
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
  if (gate.pending) {
    const p = verifyScore(gate, mine);
    gate.verify = p;
    if (p === null || p < (S.model.thresholds?.verify ?? 0.98)) { if (gate.debug) gate.debug.verifyWhy = `verify:${p === null ? 'none' : p.toFixed(3)}`; return false; }
  }
  return true;
}

/* ---------------------------------------------------------------------------------------------- hook B: supply the missing operator
 * The deterministic parser explained every word but could not claim the question because NO operator trigger matched ("tickets in Q1 2026"). The heads
 * may SUPPLY the trigger - only when
 *   - there are no unexplained words and the op head reads the question as count / sum / avg / median / max / min / exists / latest / first with a
 *     calibrated probability above thresholds.hookB.op (and the measure head above hookB.measure),
 *   - the round-4 guards pass (negation, modality, scope and condition words, a second clause, a back-reference ...),
 *   - the parser found no operator trigger of its own, and
 *   - the plan the families then build from the detectors' slots has the same operator (and money measure) as the model's reading.
 * Slots (names, dates, amounts, document types, cities) always come from the detectors. DONOVAN_DQL_LEARNED=0 or DONOVAN_DQL_HOOKB=0 turn it off.
 * Returns {flag, op, prob, view, confirm(plan)} or null. */
export const SUPPLY = { count: 'howMany', sum: 'total', avg: 'avg', median: 'median', max: 'max', min: 'min', exists: 'exists', latest: 'latest', first: 'earliest' };
const MONEY_OPS = new Set(['sum', 'avg', 'median', 'max', 'min']);
export const SEM_TRIGGERS = ['negation', 'missing', 'distinct', 'howMany', 'howMuch', 'share', 'versus', 'median', 'avg', 'exists', 'total', 'max', 'min', 'latest', 'earliest', 'any', 'hours', 'tonnageWord', 'ageWord', 'topN', 'argmax'];
/** why the parser's own reading leaves no room for a supplied operator (it has a trigger, a set / time question, a grouping ...), or null */
export function supplyBlocked(f) {
  const t = f?.trig;
  if (!t) return 'no-trig';
  if (f.sets || f.timeq) return 'sets-or-time';
  if (f.recentN || f.dims?.length || f.distinctDim || f.flags?.each) return 'dims-or-recent';
  const sem = SEM_TRIGGERS.find((k) => t[k]);
  return sem ? `trigger:${sem}` : null;
}
export function supplyOp(info) {
  if (!learnedEnabled() || process.env.DONOVAN_DQL_HOOKB === '0') return null;
  const S = load();
  if (!S || !S.clusters) return null;
  const why = (m) => { if (info.debug) info.debug.supplyWhy = m; return null; };
  const f = info.feat;
  const blocked = supplyBlocked(f);
  if (blocked) return why(blocked);
  if (info.left?.length) return why('unexplained-words');
  const d = describe(info);
  if (!d) return null;
  const g = guardReason(info.raw, d.words);
  if (g) return why(g);
  const th = { op: 0.99, measure: 0.99, ...(S.model.thresholds?.hookB ?? {}) };
  const pred = predictHeads(d.v);
  const op = pred.op; const flag = SUPPLY[op.label];
  if (!flag || op.prob < th.op) return why(`op:${op.label}:${op.prob.toFixed(3)}`);
  const wantMoney = MONEY_OPS.has(op.label);
  if (pred.measure.prob < th.measure) return why(`measure:${pred.measure.label}:${pred.measure.prob.toFixed(3)}`);
  if (wantMoney && pred.measure.label !== 'money') return why(`measure-op:${op.label}/${pred.measure.label}`);
  const confirm = (plan) => {
    const mine = dqlHeads(plan);
    if (mine.op !== op.label) return false;
    if (wantMoney && mine.measure !== 'money') return false;
    const e = pred.entity;
    if (e.prob >= (S.model.thresholds?.head ?? 0.9) && e.label !== mine.entity && !S.compat.get('entity')?.has(`${e.label}|${mine.entity}`)) return false;
    return true;
  };
  return { flag, op: op.label, prob: op.prob, view: d.v, confirm };
}
