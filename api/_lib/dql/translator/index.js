/**
 * dql/translator - the plan translator: when Donovan does need a language model for a question about the company's records, the model is the
 * cheapest one and does the smallest thing: it writes a JSON PLAN, in DQL's own plan schema (translator/schema.js), and nothing else.
 *
 *   translatorEnabled()                       DONOVAN_PLAN_TRANSLATOR=1 (default OFF; the owner turns it on)
 *   classifyTranslate(question, {tenantVocab, pack, today})   router side: the intent {mode: 'dql-translate'} for a question no lane claimed, or null
 *   runTranslated(db, intent, {today})        decompose side: the model call (call.js), the strict gate (validate.js), then the DQL executor over the
 *                                             company's records; null (never a guess) on any doubt, so the question carries on to the full model path
 *   answerFromRawPlan(snap, raw, question, ctx)   the pure half the verify script and the offline evaluation run (no model, no database)
 *
 * The model never writes the answer: the figures, names and source documents come from stored rows, with the usual citations.
 */
import { withTenantFor } from './tenant.js';
import { translatorEnabled, requestPlan } from './call.js';
import { validateTranslatedPlan } from './validate.js';
import { answerFromSnapshot } from '../index.js';
import { loadSnapshot } from '../load.js';
import { localProposerEnabled, proposeAndValidate } from '../proposer/index.js';
import { learnedReaderEnabled, proposeLearned } from '../reader-ml/index.js';
import { todayIso } from '../../scope.js';
import { compileVocab } from '../vocab.js';
import { tokenize } from '../text.js';
import { ENTITY_WORDS, MONEY_WORDS, DIM_WORDS } from '../lex.js';

export { translatorEnabled, validateTranslatedPlan };
export { setTranslatorCallForTests, clearTranslatorCache } from './call.js';

/** Words that say a question is about the stored records (a count, a total, a list, a rank ...), so a greeting or a how-to is never sent to the model. */
const ASKS_RECORDS = /\b(?:how many|how much|number of|count|total|sum|average|avg|mean|median|list|show|which|who|what|when|latest|newest|oldest|earliest|first|last|most|least|highest|lowest|largest|smallest|biggest|top|bottom|percent|percentage|share|any|is there|are there|do we have|per|each|by)\b/i;
const NOT_RECORDS = /\b(?:how (?:do|can|should) (?:i|we)|how to|what is (?:a|an|the) (?:meaning|definition)|password|log ?in|sign ?up|billing|subscription|upgrade|support|help me|explain|why)\b/i;

/** a question that leans on an earlier answer ("those", "it", "the same") is the follow-up engine's, never the translator's */
const LEANS_ON_EARLIER = /\b(?:those|these|them|they|their|theirs|it|its|that one|this one|the same|the other one|former|latter|above|earlier|previous)\b/i;
const nounCache = new WeakMap();
/** the words that say a question is about this company's stored records: its paper kinds and names, the shared entity / money / dimension words */
function recordNouns(tv, pack) {
  if (nounCache.has(tv)) return nounCache.get(tv);
  const v = compileVocab(tv, pack);
  const set = new Set();
  const add = (p) => { for (const w of String(p).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4) set.add(w); };
  for (const p of v.docPhrases.keys()) add(p);
  for (const arr of Object.values(ENTITY_WORDS)) arr.forEach(add);
  for (const [p] of MONEY_WORDS) add(p);
  for (const [dim, arr] of Object.entries(DIM_WORDS)) if (!['year', 'month', 'weekday', 'quarter', 'type', 'status', 'model', 'tonnage'].includes(dim)) arr.forEach(add);
  for (const k of v.names.keys()) add(k);
  for (const k of v.cities.keys()) add(k);
  nounCache.set(tv, set);
  return set;
}

export function classifyTranslate(question, { tenantVocab, pack, today } = {}) {
  if ((!translatorEnabled() && !localProposerEnabled() && !learnedReaderEnabled()) || !tenantVocab) return null; // the model translator (DONOVAN_PLAN_TRANSLATOR=1), the local proposer (DONOVAN_LOCAL_PROPOSER) and/or the learned reader (DONOVAN_LEARNED_READER)
  const q = String(question ?? '').trim();
  if (q.length < 8 || q.length > 300 || !ASKS_RECORDS.test(q) || NOT_RECORDS.test(q) || LEANS_ON_EARLIER.test(q)) return null;
  const nouns = recordNouns(tenantVocab, pack);
  const toks = tokenize(q);
  if (!toks.some((t) => nouns.has(t.w) || nouns.has(t.w.replace(/s$/, '')))) return null; // nothing in it names a kind of paper, a person or a place of this company
  return { mode: 'dql-translate', question: q, tv: tenantVocab, pack, today };
}

/** The pure half: a raw model plan -> validated -> executed over the snapshot. {data, plan} | {rejected: reason} | {abstained: true}. */
export function answerFromRawPlan(snap, raw, question, { tv, pack, today }) {
  const v = validateTranslatedPlan(raw, question, { tv, pack, today, snap });
  if (!v.ok) return { rejected: v.reason };
  const data = answerFromSnapshot(snap, v.plan, today);
  return data ? { data, plan: v.plan } : { abstained: true, plan: v.plan };
}

export async function runTranslated(db, intent, { today } = {}) {
  if ((!translatorEnabled() && !localProposerEnabled() && !learnedReaderEnabled()) || !intent?.question || !intent.tv) return null;
  const t = todayIso(today);
  // the LOCAL PROPOSER (dql/proposer, no model call): its plan must pass the same strict gate and agree with the learned heads; anything else carries on exactly as before
  if (localProposerEnabled()) {
    try {
      const pre = proposeAndValidate(intent.question, { tv: intent.tv, pack: intent.pack, today: t });
      if (pre.ok) {
        const snap = await loadSnapshot(db, { today: t });
        if (!snap.truncated) {
          const again = proposeAndValidate(intent.question, { tv: intent.tv, pack: intent.pack, today: t, snap });
          const data = again.ok ? answerFromSnapshot(snap, again.plan, t) : null;
          console.log(JSON.stringify({ route: 'ask', proposer: data ? 'answered' : 'rejected', op: pre.plan.op }));
          if (data) return data;
        }
      }
    } catch { /* fall through to the model translator or the normal chain */ }
  }
  // R25: the LEARNED READER (dql/reader-ml, DONOVAN_LEARNED_READER, off by default). Only a question the rules engine released gets here; the reader's plan must clear its calibrated confidence,
  // the skeleton/slot checks and this same strict validator, and agree with the filler's own period and values. Any doubt: carry on exactly as before. It never overrides a rules answer.
  if (learnedReaderEnabled()) {
    try {
      const snap = await loadSnapshot(db, { today: t });
      if (!snap.truncated) {
        const lr = await proposeLearned(intent.question, { tv: intent.tv, pack: intent.pack, today: t, snap });
        const data = lr.ok ? answerFromSnapshot(snap, lr.plan, t) : null;
        console.log(JSON.stringify({ route: 'ask', learnedReader: data ? 'answered' : lr.ok ? 'abstained' : 'released', why: lr.ok ? undefined : String(lr.reason).slice(0, 40), op: lr.ok ? lr.plan.op : undefined }));
        if (data) return data;
      }
    } catch { /* fall through to the model translator or the normal chain */ }
  }
  if (!translatorEnabled()) return null;
  const { withTenant, ctxArg } = await withTenantFor(db);
  const raw = await requestPlan({ withTenant, ctxArg, question: intent.question, tv: intent.tv, pack: intent.pack });
  if (!raw) return null;
  const snap = await loadSnapshot(db, { today: t });
  if (snap.truncated) return null;
  const pre = validateTranslatedPlan(raw, intent.question, { tv: intent.tv, pack: intent.pack, today: t, snap });
  if (!pre.ok) { console.log(JSON.stringify({ route: 'ask', translator: 'rejected', reason: String(pre.reason).slice(0, 60) })); return null; }
  const data = answerFromSnapshot(snap, pre.plan, t);
  console.log(JSON.stringify({ route: 'ask', translator: data ? 'answered' : 'abstained', op: pre.plan.op }));
  return data;
}
