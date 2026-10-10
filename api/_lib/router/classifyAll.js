/**
 * Round 18 (H3) — the unified pre-router classification, extracted out of api/ask.js.
 *
 * WHY THIS EXISTS (r16_d1_pipeline.json, D1 items 1/3/4): a static architecture audit ran every
 * exam+generalization question (904) through each of ask.js's pre-router classifiers directly, then
 * re-gated the results with ask.js's own production computation-order guards, then resolved them
 * against ask.js's ACTUAL TRIAL ORDER — and found the two orders are NOT the same thing. 314/904
 * questions are claimed by 2+ classifiers once gating is applied; the winner is decided purely by
 * TRIAL-ORDER position, which several classifiers' own doc comments (wrongly) imply is
 * computation-order gating. Concretely: fastPath (tried 0.5) is gated ONLY on `!meta` and the
 * ASK_FAST_PATH flag — never on contactLookup/docLookup/contentCount/decompose at computation time —
 * yet is tried BEFORE contactLookup (0.6) and docLookup (0.62), so on any overlap it silently wins
 * regardless of which classifier's own comment claims priority for that shape (see
 * PRECEDENCE_TABLE's `fastPath` entry).
 *
 * This module makes that explicit and observable, without changing a single answer: `classifyAll`
 * runs every pure classifier exactly once (unconditionally — a "raw claim" — so a future classifier
 * change can be measured against every question, not just the ones production happens to reach
 * today), then applies PRECEDENCE_TABLE's own documented gate to decide which raw claims are actually
 * ELIGIBLE (matches ask.js's production gating, verified equivalent — see each entry's `reason`), then
 * picks the winner by TRIAL_ORDER. ask.js below imports this and uses its `gated` output in place of
 * the ~15 lines of scattered `const xIntent = !meta && ... ? classifyX(...) : null` it used to compute
 * inline — same values, same order, same lazy-loading (loadAnalyticsRouteModule/loadAgentModule are
 * injected by the caller so a request that never reaches those gates never imports
 * @anthropic-ai/sdk — see verify-cold-start.mjs).
 *
 * `meta` (the exact-match inventory-question router) is NOT reclassified here: it never conflicts
 * with anything (r16_d1_pipeline.json: claimCount === winCount === 8) and is tried unconditionally
 * first — ask.js still computes it itself (classifyMetaQuestion) and passes the result in as `ctx.meta`,
 * since every other gate below needs to know whether it fired.
 *
 * Pure module: no DB, no model call. The two feature-flag checks that live behind a dynamic import in
 * production (isAnalyticsEnabled in routes/analytics.js, isAgentEnabled in agent/loop.js — both pull
 * @anthropic-ai/sdk in transitively) are resolved through `ctx.loadAnalyticsRouteModule` /
 * `ctx.loadAgentModule`, which default to a plain `import()` here (memoized per call only, not
 * module-level — the caller, ask.js, passes its own already-memoized loaders so nothing is ever
 * imported twice or earlier than before).
 */
import { classifyRelationsQuestion } from "../relations/questions.js";
import { classifyDeterministic } from "../deterministicRouter.js";
import { classifyDecompose } from "../decompose/index.js";
import { classifyFastPath, isFastPathEnabled } from "../fastPath.js";
import { parseContactLookupQuestion } from "../contactLookup.js";
import { parseSummaryQuestion, canonicalSummaryQuestion } from "../summary/parse.js";
import { parseDocLookupQuestion } from "../docLookup.js";
import { parseContentCountQuestion } from "../contentCount.js";
import { preClassifyAnalytics, looksLikeSingleRecordReference, isMoneyQuestion } from "../analytics.js";
import { isFinancialQuestion } from "../financials/classify.js";
import { parseMoneyIntent } from "../financials/answers.js";
import { extraDocTypeAlternation, stemWord } from "../lookups/lexicon.js";
import { detectAnalyticsPlan } from "../analytics/detPlan.js";
import { ENTITY_SYNONYMS } from "../analytics.js";
import { leftoverWords, leftoverEnabled, domainWordsFromVocab, NEGATION_WORDS, unusedGrammar, grammarSpans, yearPairRewrite } from "./leftover.js";
import { normalizeQuestion as normalizeQuestionFull } from "../nlNormalize.js";
import { isUnitRankingQuestion, isReasoningQuestion } from "../agent/intents.js";
import { isInstallDateExtremeQuestion } from "../analytics/detPlan.js";
import { normalizeQuestion as normalizeQuestionForAnalytics } from "../nlNormalize.js";
import { stripConversationalFrame } from "./frame.js";
import { rewriteQuestion, rewriteRelWindow } from "./rewrite.js";
import { respellJargon, jargonEnabled } from "../lexicon/jargon.js";
import { detectAmbiguousSurname, clarifyEnabled } from "../lookups/clarify.js";
import { isFutureRecordQuestion } from "./futureDate.js";
import { performance } from "node:perf_hooks";

const now = () => performance.now();
const round = (ms) => Math.round(ms * 1000) / 1000; // 3 decimal places — these are sub-millisecond calls

/**
 * TRIAL ORDER — the order api/ask.js actually tries a branch in (its numeric block comments, "0.35
 * relations engine" etc.), reproduced verbatim. This is the order `classifyAll`'s winner-selection
 * walks; it is deliberately kept separate from each entry's own `gate` (computation-order eligibility)
 * because — per the audit above — the two are NOT the same order in production today, and collapsing
 * them would silently change which classifier wins on an overlap.
 */
const FUTURE_OVERRIDES = new Set(["fastPath", "docLookup", "contentCount", "money", "analytics"]);

export const TRIAL_ORDER = [
  "meta",
  "summary",
  "relations",
  "deterministic",
  "decompose",
  "fastPath",
  "contactLookup",
  "docLookup",
  "contentCount",
  "money",
  "analytics",
];

/**
 * PRECEDENCE TABLE — one entry per pre-router stage, in TRIAL order. `gate(raw, flags)` decides
 * whether this stage's raw claim is even ELIGIBLE to be the winner, given every OTHER stage's raw
 * claim (never a downstream "already gated" value — every gate below is a closed-form boolean over
 * raw claims + feature flags, algebraically reduced from ask.js's literal nested-const gating so it
 * can be read and audited independently of computation order; each `reason` names the exact ask.js
 * line shape it reproduces). `claim(question, ctx)` is the pure classifier call itself, run
 * unconditionally by classifyAll — never itself gated — so the "claimed" list below reflects every
 * classifier that recognizes the SHAPE, regardless of whether production would ever let it answer.
 */
export const PRECEDENCE_TABLE = [
  {
    name: "meta",
    trialOrder: 0,
    reason:
      "Tried unconditionally, first, no gate. An exact-match inventory-question table with zero " +
      "recorded conflicts (r16_d1_pipeline.json: claimCount === winCount === 8) — nothing else needs " +
      "to run once it fires, and nothing here re-derives it (ask.js still owns classifyMetaQuestion).",
    gate: () => true,
  },
  {
    name: "summary",
    trialOrder: 0.3,
    reason:
      "R2 B2: a summary of ONE subject (\"rundown on X\", \"what do we have on file for X\", \"tell me about our purchase orders\") - a summary verb plus a subject " +
      "that is fully explained (summary/parse.js). It is tried before every lookup because those read a document-type noun as a customer name and answer " +
      "the last job or a stub count. It runs through the contactLookup dispatch in ask.js (the intent is handed over as contactLookup with field 'summary'; " +
      "contactLookup.js runs summary/index.js first), so no other stage is consulted once it claims. Gated on meta alone.",
    gate: (raw) => !raw.meta,
  },
  {
    name: "relations",
    trialOrder: 0.35,
    reason: "ask.js: `!meta ? classifyRelationsQuestion(question) : null` — gated on meta alone.",
    gate: (raw) => !raw.meta,
  },
  {
    name: "deterministic",
    trialOrder: 0.4,
    reason: "ask.js: `!meta ? classifyDeterministic(question, {overlay}) : null` — gated on meta alone.",
    gate: (raw) => !raw.meta,
  },
  {
    name: "decompose",
    trialOrder: 0.42,
    reason:
      "ask.js: `!meta && !contactLookupIntent && !docLookupIntent && !contentCountIntent ? " +
      "classifyDecompose(...) : null`, where those three are THEMSELVES already gated on each other " +
      "(docLookup needs !contactLookup, contentCount needs !contactLookup && !docLookup) — collapses " +
      "to: none of contactLookup/docLookup/contentCount raw-claimed the question at all.",
    gate: (raw) => !raw.meta && !raw.contactLookup && !raw.docLookup && !raw.contentCount,
  },
  {
    name: "fastPath",
    trialOrder: 0.5,
    reason:
      "ask.js: `!meta && isFastPathEnabled() ? classifyFastPath(question) : null` — gated ONLY on " +
      "meta + the ASK_FAST_PATH flag. THE HEADLINE GAP (r16_d1_pipeline.json D1): fastPath is never " +
      "gated against contactLookup/docLookup/contentCount/decompose at computation time, yet TRIES " +
      "(0.5) before contactLookup (0.6) and docLookup (0.62) — so on any double-claim with either, " +
      "fastPath wins by trial-order accident, regardless of which classifier's own doc comment claims " +
      "priority for that shape (contactLookup.js/docLookup.js both say their family 'takes priority').",
    gate: (raw, flags) => !raw.meta && flags.fastPathEnabled,
  },
  {
    name: "contactLookup",
    trialOrder: 0.6,
    reason: "ask.js: `!meta ? parseContactLookupQuestion(question, {overlay}) : null` — gated on meta alone.",
    gate: (raw) => !raw.meta,
  },
  {
    name: "docLookup",
    trialOrder: 0.62,
    reason: "ask.js: `!meta && !contactLookupIntent ? parseDocLookupQuestion(...) : null`.",
    gate: (raw) => !raw.meta && !raw.contactLookup,
  },
  {
    name: "contentCount",
    trialOrder: 0.63,
    reason: "ask.js: `!meta && !contactLookupIntent && !docLookupIntent ? parseContentCountQuestion(...) : null`.",
    gate: (raw) => !raw.meta && !raw.contactLookup && !raw.docLookup,
  },
  {
    name: "money",
    trialOrder: 0.65,
    reason:
      "ask.js: `!meta && !docLookupIntent && !contentCountIntent && (isMoneyQuestion(...) || " +
      "isFinancialQuestion(...))`, where docLookupIntent/contentCountIntent are the ALREADY-GATED " +
      "computed values, not raw claims. Expanded algebraically over raw claims this is: money is " +
      "excluded only when docLookup or contentCount would ACTUALLY have fired (which itself requires " +
      "contactLookup to be raw-unclaimed) — money's gate never checks contactLookup or fastPath " +
      "directly at all. That is exactly why money+relations (relations wins, 0.35 < 0.65 — benign, " +
      "relations answers with a real document count/comparison, never a fabricated $ figure — see " +
      "handoffs/MONEY_SAFETY_EXCEPTIONS_2026-09-26.md) and fastPath+money (fastPath wins, 0.5 < 0.65) conflicts both occur " +
      "silently: money's own 'no fabricated $ figures' guard can be bypassed by any earlier-tried " +
      "classifier whose shape detector also matches, without money's gate ever being consulted.",
    gate: (raw) =>
      !raw.meta &&
      (raw.contactLookup || !raw.docLookup) &&
      (raw.contactLookup || raw.docLookup || !raw.contentCount),
  },
  {
    name: "analytics",
    trialOrder: 0.7,
    reason:
      "ask.js: `!meta && !fastPathIntent && !contactLookupIntent && !docLookupIntent && " +
      "!contentCountIntent && !moneyQuestion` (all already-gated computed values) `&& isAnalyticsEnabled() " +
      "&& !looksLikeSingleRecordReference(rawQuestion) && ` two agent-gated exclusions (unit-ranking / " +
      "reasoning questions go to the agent instead when DONOVAN_AGENT is on). Algebraically reduces " +
      "(substituting each computed value's own definition, with meta already false) to: none of " +
      "contactLookup/docLookup/contentCount/money raw-claimed, and fastPath either disabled or " +
      "raw-unclaimed — i.e. analytics is the true last-resort: eligible only once every other " +
      "classifier has already been ruled out by ITS OWN gate.",
    gate: (raw, flags) =>
      !raw.meta &&
      !raw.contactLookup &&
      !raw.docLookup &&
      !raw.contentCount &&
      !raw.money &&
      (!flags.fastPathEnabled || !raw.fastPath) &&
      flags.analyticsEnabled &&
      !flags.singleRecordRaw &&
      !(flags.agentEnabled && flags.unitRanking && !flags.installDateExtreme) &&
      !(flags.agentEnabled && flags.reasoning),
  },
];

/** name -> its PRECEDENCE_TABLE entry (reason/gate/trialOrder) — scripts/verify-router.mjs uses this to
 *  print the documented reason for a multi-claimed question's winner. */
export const STAGE_BY_NAME = new Map(PRECEDENCE_TABLE.map((s) => [s.name, s]));

async function defaultLoadAnalyticsRouteModule() {
  return import("../routes/analytics.js");
}
async function defaultLoadAgentModule() {
  return import("../agent/loop.js");
}

/**
 * Run every pure pre-router classifier once and return:
 *   - normalizedForAnalytics: the same normalized text ask.js already threads into money/analytics.
 *   - raw:    { [stage]: <classifier's own direct result, or null/false> } for every non-meta stage —
 *             UNGATED, so a shape 2+ classifiers both recognize shows up in more than one key.
 *   - claimed: raw stage names with a truthy raw result (meta included when ctx.meta is truthy).
 *   - gated:  { [stage]: <raw result iff PRECEDENCE_TABLE's gate for that stage holds, else null> },
 *             for every stage including meta — these are the SAME values ask.js's own
 *             const relationsIntent/detIntent/.../analyticsCandidate used to hold locally.
 *   - winner: { name, intent } for the first TRIAL_ORDER stage with a non-null/true `gated` value, or
 *             null if nothing claimed the question (falls through to retrieval, same as today).
 *   - timingsMs: { [stage]: ms, total: ms } — D1 #10 telemetry. Each stage is a pure regex/shape call
 *             (no DB, no model), so this is sub-millisecond bookkeeping; `total` also covers the two
 *             lazy module loads above on whichever call first triggers them.
 *
 * @param {string} question
 * @param {object} ctx
 * @param {object|null} ctx.meta        classifyMetaQuestion(question)'s own result (ask.js computes this).
 * @param {object} [ctx.overlay]        active learned-overlay bag (relations/deterministic/contactLookup/
 *                                      docLookup/analytics all take this the same way ask.js already passes it).
 * @param {object} [ctx.pack]           tenant's industry pack (decompose/contentCount).
 * @param {object} [ctx.tenantVocab]    per-tenant vocabulary (normalizeQuestionForAnalytics only).
 * @param {() => Promise<object>} [ctx.loadAnalyticsRouteModule]  lazy-loaded, memoized by the caller — see
 *                                      ask.js's own loadAnalyticsRouteModule. Only awaited when every earlier
 *                                      gate already holds (same lazy point production reaches it at today).
 * @param {() => Promise<object>} [ctx.loadAgentModule]  ditto, for isAgentEnabled/isUnitRankingQuestion's
 *                                      DONOVAN_AGENT-gated exclusions.
 * @param {object} [ctx.env]            process.env override, for tests (isFastPathEnabled/isAnalyticsEnabled).
 */
/** "documents over $500" / "receipts under 50": a threshold on ANY money-document noun is a money question (the money reader owns the document-type scope). */
function isDocumentThreshold(question, today) {
  try { return parseMoneyIntent(String(question ?? ""), { today: today ?? new Date().toISOString().slice(0, 10) })?.intent === "threshold_invoices"; } catch { return false; }
}

const EXTRA_DOC_NOUN = new RegExp(`\\b(?:${extraDocTypeAlternation()})\\b`, "i");
const MONEYISH = /[$]|\b(?:total|totals|amount|amounts|worth|owe|owes|owed|paid|unpaid|revenue|sales|cost|costs|price|priced|billed|invoiced|over|under|above|below|more than|less than|at least|spent|spend|balance|due)\b/i;
/** "how many price lists" / "list our COIs": a plain count or list of a document type people name in other words. The document-type reader owns it, not the money reader. */
function isPlainExtraDocCount(q) {
  const s = String(q ?? "");
  return /\b(?:how many|number of|count|list|which|show|any)\b/i.test(s) && EXTRA_DOC_NOUN.test(s) && !MONEYISH.test(s.replace(EXTRA_DOC_NOUN, " "));
}

async function classifyAllOnce(question, ctx = {}) {
  const {
    meta = null,
    overlay,
    pack,
    tenantVocab,
    loadAnalyticsRouteModule = defaultLoadAnalyticsRouteModule,
    loadAgentModule = defaultLoadAgentModule,
    env = process.env,
  } = ctx;

  const startedAt = now();
  const normalizedForAnalytics = normalizeQuestionForAnalytics(question, { overlay, pack, tenantVocab }).normalized;

  // ---- raw claims: every pure classifier, called directly, no gating at all -----------------------
  // Timed individually (D1 #10 telemetry) — each is a cheap regex/shape pass (no DB, no model), so this
  // is microsecond bookkeeping, not a performance concern; `timingsMs` is returned below for
  // logRouteDecision to fold into its one structured line, no question text or answer content in it.
  const timingsMs = {};
  const timed = (name, fn) => {
    const t0 = now();
    const result = fn();
    timingsMs[name] = round(now() - t0);
    return result;
  };
  const raw = {
    summary: timed("summary", () => parseSummaryQuestion(question, { today: ctx?.today })),
    relations: timed("relations", () => classifyRelationsQuestion(question)),
    deterministic: timed("deterministic", () => classifyDeterministic(question, { overlay, tenantVocab })),
    decompose: timed("decompose", () => classifyDecompose(question, { pack })),
    fastPath: timed("fastPath", () => classifyFastPath(question)),
    contactLookup: timed("contactLookup", () => parseContactLookupQuestion(question, { overlay, tenantVocab: ctx.tenantVocab })),
    docLookup: timed("docLookup", () => parseDocLookupQuestion(question, { overlay })),
    contentCount: timed("contentCount", () => parseContentCountQuestion(question, pack)),
    money: timed("money", () => !isPlainExtraDocCount(normalizedForAnalytics) && (isMoneyQuestion(normalizedForAnalytics) || isFinancialQuestion(normalizedForAnalytics) || isDocumentThreshold(question, ctx?.today))),
    analytics: timed("analytics", () => preClassifyAnalytics(normalizedForAnalytics, { overlay }) || isPlainExtraDocCount(normalizedForAnalytics)),
    meta: Boolean(meta),
  };

  const claimed = TRIAL_ORDER.filter((name) => (name === "meta" ? Boolean(meta) : Boolean(raw[name])));

  // ---- feature flags / cross-classifier gates the analytics/fastPath entries need -------------------
  const fastPathEnabled = isFastPathEnabled(env);
  // analyticsEnabled/agentEnabled are only ever resolved (and their modules only ever imported) once the
  // analytics stage's OTHER gate terms already hold — same lazy point ask.js reaches them at today. A
  // question meta/contactLookup/docLookup/contentCount/money/fastPath already claims never pays for either
  // import, exactly like before this file existed.
  let analyticsEnabled = false;
  let agentEnabled = false;
  const analyticsOtherGatesHold =
    !raw.meta && !raw.summary && !raw.contactLookup && !raw.docLookup && !raw.contentCount && !raw.money && (!fastPathEnabled || !raw.fastPath);
  if (analyticsOtherGatesHold) {
    const analyticsRouteModule = await loadAnalyticsRouteModule();
    analyticsEnabled = analyticsRouteModule.isAnalyticsEnabled(env);
    if (analyticsEnabled) {
      const agentModule = await loadAgentModule();
      agentEnabled = agentModule.isAgentEnabled(env);
    }
  }

  const flags = {
    fastPathEnabled,
    analyticsEnabled,
    agentEnabled,
    singleRecordRaw: looksLikeSingleRecordReference(question),
    unitRanking: agentEnabled ? isUnitRankingQuestion(question) : false,
    reasoning: agentEnabled ? isReasoningQuestion(question) : false,
    installDateExtreme: agentEnabled ? isInstallDateExtremeQuestion(question) : false,
  };

  // ---- gated eligibility, per PRECEDENCE_TABLE -------------------------------------------------------
  // Booleans (money/analytics) stay boolean (false, not null) when excluded — matching ask.js's own
  // `moneyQuestion`/`analyticsCandidate` locals, which callers `if (moneyQuestion)` directly; every other
  // stage stays an object-or-null, matching ask.js's own `xIntent` locals.
  const BOOLEAN_STAGES = new Set(["money", "analytics"]);
  const gated = { meta: meta ?? null };
  for (const stage of PRECEDENCE_TABLE) {
    if (stage.name === "meta") continue;
    const eligible = stage.gate(raw, flags) && Boolean(raw[stage.name]);
    gated[stage.name] = BOOLEAN_STAGES.has(stage.name) ? eligible : (eligible ? raw[stage.name] : null);
  }

  // R2 B2: a claimed summary owns the question outright. ask.js has no summary branch of its own, so the intent travels as the contactLookup
  // claim (contactLookup.js's runContactLookup runs the summary lane first); every other stage is switched off.
  if (gated.summary) {
    for (const stage of PRECEDENCE_TABLE) if (stage.name !== "meta" && stage.name !== "summary") gated[stage.name] = BOOLEAN_STAGES.has(stage.name) ? false : null;
    gated.contactLookup = { field: "summary", summary: gated.summary };
  }

  // ---- winner: first TRIAL_ORDER stage with a truthy gated value -------------------------------------
  let winner = null;
  for (const name of TRIAL_ORDER) {
    const value = gated[name];
    if (value) {
      winner = { name, intent: value };
      break;
    }
  }

  // R31 loop 4: a question about a record "filed/issued/logged in <future year>" — no classifier (or a fastPath that
  // then fails) claims it, yet routes/analytics.js already answers it with the deterministic future-date decline
  // (mentionsFutureYear -> futureDateAnswer). Route it there instead of a paid model call. Never overrides a
  // customer-name / relations / deterministic / decompose claim (see futureDate.js for the conservative shape test).
  if (!meta && (!winner || FUTURE_OVERRIDES.has(winner.name)) && isFutureRecordQuestion(question, { tenantVocab })) {
    const analyticsRouteModule = await loadAnalyticsRouteModule();
    if (analyticsRouteModule.isAnalyticsEnabled(env)) {
      for (const stage of PRECEDENCE_TABLE) if (stage.name !== "meta") gated[stage.name] = BOOLEAN_STAGES.has(stage.name) ? false : null;
      gated.analytics = true;
      winner = { name: "analytics", intent: true, futureDate: true };
    }
  }

  timingsMs.total = round(now() - startedAt); // includes the two lazy imports above, on their first call only

  return { normalizedForAnalytics, raw, claimed, gated, winner, timingsMs };
}

/**
 * R31 (Team A): classifyAll = one pass on the question as typed, plus (only when the text carries spoken
 * filler, router/frame.js) one pass on the frame-stripped text; the stripped pass is adopted when a
 * deterministic stage claims it. The adopted
 * text is returned as `effectiveQuestion` so ask.js hands the SAME text to the run* function that
 * re-parses it (runContactLookup/runDocLookup/runFastPath take the question string, not the intent).
 */
/**
 * F4 leftover-word guard (central). A deterministic analytics reading that is a PLAIN whole-entity count or list (no filter, no window, no grouping) is only right
 * when every meaningful word of the question is explained by it: the entity noun is one of that entity's own words, and no other content word was left unused
 * ("which homeowners signed a service plan" must not become "120 customers", "list the technicians we use" must not become the customer list).
 * A question that fails is released (no winner), so it falls through to the other lanes or the honest decline, never a nearby generic answer.
 */
async function leftoverDecline(out, question, ctx) {
  try {
    if (process.env.DONOVAN_F4_GUARD === "0" || !(out?.winner?.name === "analytics" || (out?.winner?.name === "deterministic" && out?.raw?.deterministic?.route === "compose")) || out.winner.futureDate || !leftoverEnabled()) return null;
    const text = out.effectiveQuestion ?? question;
    const { overlay, pack, tenantVocab } = ctx ?? {};
    const today = ctx?.today ?? new Date().toISOString().slice(0, 10);
    const norm = (q) => normalizeQuestionFull(q, { overlay, pack, tenantVocab }).normalized;
    // the same plan the analytics lane will run: the deterministic reading plus its own post-processing (dates, service visits...)
    const mod = await (ctx.loadAnalyticsRouteModule ?? defaultLoadAnalyticsRouteModule)();
    const planOf = (q) => { const raw = detectAnalyticsPlan(norm(q), tenantVocab, today); return raw ? mod.finalizePlanInput(raw, q, today) : null; };
    const plan = planOf(text);
    if (!plan || !["count", "list"].includes(plan.op) || plan.groupBy || plan.countDistinct) return null;
    // B3: the guard also covers document counts, service-visit counts and "customers with <document type>" (filtered only by the document type).
    // On those, only a dropped NEGATION / exclusion releases the claim ("service tickets that were not repairs" must not answer the total);
    // the name-like word test below stays customers-only.
    const composeWin = out.winner.name === "deterministic";
    const typeOnly = (plan.filters ?? []).every((f) => ["documentType", "hasDocType"].includes(f.field) && f.op === "eq");
    if (typeOnly && (["documents", "visits", "serviceVisits"].includes(plan.entity) || (plan.entity === "customers" && (plan.filters ?? []).length > 0 && !plan.timeRange))) {
      const base = JSON.stringify(plan);
      const toks = [...String(text).matchAll(/[A-Za-z']+/g)];
      const neg = [];
      for (let i = 0; i < toks.length; i++) {
        const w = toks[i][0].toLowerCase().replace(/’/g, "'");
        if (!NEGATION_WORDS.has(w)) continue;
        // ablation: delete the negation and the word it points at; if the lane reads the question the same way, the negation was never used
        const cut = toks[i + 1] ? toks[i + 1].index + toks[i + 1][0].length : toks[i].index + toks[i][0].length;
        const without = (text.slice(0, toks[i].index) + " " + text.slice(cut)).replace(/\s+/g, " ").trim();
        let same = false;
        try { same = JSON.stringify(planOf(without) ?? null) === base; } catch { same = true; }
        if (same) neg.push(w);
      }
      return neg.length ? { reason: "negation", words: neg } : null;
    }
    if (composeWin || plan.entity !== "customers" || plan.filters?.length || plan.timeRange) return null;
    // 1. the entity being counted must be named in the question by one of its own words
    const syn = ENTITY_SYNONYMS?.[plan.entity];
    if (syn?.length) {
      const stems = new Set(syn.flatMap((p) => String(p).toLowerCase().split(/[^a-z]+/)).filter(Boolean).map(stemWord));
      const words = (norm(text).toLowerCase().match(/[a-z]+/g) ?? []).map(stemWord);
      if (!words.some((w) => stems.has(w)) && !(tenantVocab?.industryWords ?? []).some((w) => words.includes(stemWord(String(w).toLowerCase())))) return { reason: "entity", words: [plan.entity] };
    }
    // 2. no other content word left unused
    const left = leftoverWords(text, (q) => JSON.stringify(planOf(q) ?? null), { lane: "classifyAll", plain: true, entityKey: plan.entity, domainWords: domainWordsFromVocab(tenantVocab), normalized: norm(text) });
    // numbers and ages are applied by the analytics lane itself at run time ("older than 15 years"), so they are not unused conditions here
    const unused = left.filter((w) => !/^\$?\d[\d,.]*%?$/.test(w) && !/^(?:years?|yrs?|months?|days?|weeks?|old|older|newer|younger|units?|systems?)$/i.test(w));
    return unused.length ? { reason: "leftover", words: unused } : null;
  } catch { return null; }
}

/**
 * B3 (round 2): grammar the winning deterministic lane never read. A question that asks two things ("how many Trane units and how many Daikin
 * units") and that decompose reads as two clauses goes to decompose, not to the single-count lane that merged them. A winner whose reading is
 * identical with a negation / top-N / second-measure phrase deleted never used that phrase: it is released (no winner) instead of answering a
 * different question.
 */
const SIMPLE_COUNT_ROUTES = new Set(["personamt", "countqual", "tonnage", "brandunits", "vocabcount", "datequal", "datedocs"]);
function grammarDecline(out, question, ctx) {
  try {
    if (process.env.DONOVAN_GRAMMAR === "0" || !leftoverEnabled()) return null;
    const name = out?.winner?.name;
    if (name !== "deterministic" && name !== "decompose") return null;
    if (name === "decompose" && out.winner.intent?.mode === "compound") return null; // each clause runs through its own lane's checks (decompose/compound.js)
    const text = out.effectiveQuestion ?? question;
    if (!grammarSpans(text, ["period", "money-measure"]).length) return null;
    const { overlay, pack, tenantVocab } = ctx ?? {};
    const sig = name === "deterministic"
      ? (q) => JSON.stringify(classifyDeterministic(q, { overlay, tenantVocab }) ?? null)
      : (q) => JSON.stringify(classifyDecompose(q, { pack }) ?? null);
    // the single-slot count lanes read one positive condition each: when the question stops being theirs without the marker, the marker had no place in their reading
    const simple = name === "deterministic" && SIMPLE_COUNT_ROUTES.has(out.winner.intent?.route);
    const words = unusedGrammar(text, sig, undefined, { nullUnused: simple, alwaysSecond: simple, topnAlways: simple || ["docextreme", "custdocrank", "rank"].includes(out.winner.intent?.route), include: name === "deterministic" ? (simple ? ["period", "money-measure"] : ["period"]) : [] });
    return words.length ? { reason: "grammar", words } : null;
  } catch { return null; }
}

export async function classifyAll(question, ctx = {}) {
  // two bare years joined by "and" ("total of invoices in 2024 and 2025"): the second is spelled as its own window so no lane reads it as a dollar amount ($2,025)
  if (process.env.DONOVAN_GRAMMAR !== "0") {
    const yp = yearPairRewrite(question);
    if (yp) { const o2 = await classifyAll(yp, ctx); return { ...o2, effectiveQuestion: o2.effectiveQuestion ?? yp }; }
  }
  let out = await classifyAllInner(question, ctx);
  // R2 B2: a summary claim travels under its one canonical spelling (summary/parse.js explains why): the older records-first lane answers
  // "rundown / recap / overview" wording with the last job only, and reads nothing in the canonical form.
  if (out?.winner?.name === "summary") {
    const canon = canonicalSummaryQuestion(out.winner.intent, out.effectiveQuestion ?? question, { today: ctx?.today });
    if (canon) out = { ...out, effectiveQuestion: canon };
  }
  // two clauses that decompose reads cleanly beat a single-count lane that merged them (the merged lane would answer one number for two questions)
  if (out?.winner?.name === "deterministic" && SIMPLE_COUNT_ROUTES.has(out.winner.intent?.route) && out.gated?.decompose?.mode === "compound" && process.env.DONOVAN_GRAMMAR !== "0" && grammarSpans(out.effectiveQuestion ?? question).some((s) => s.kind === "second-head" || s.kind === "second-measure" || s.kind === "pair-extreme")) {
    out = { ...out, winner: { name: "decompose", intent: out.gated.decompose }, gated: { ...out.gated, deterministic: null } };
  }
  const gd = grammarDecline(out, question, ctx);
  // a negated count that decompose can answer as a complement (all minus the excluded) beats releasing the question
  if (gd && out?.winner?.name !== "decompose" && out.gated?.decompose?.ratio && gd.words.some((w) => /^(?:percent|percentage|share|proportion|fraction|portion|ratio)\s+of$/i.test(w))) {
    return { ...out, winner: { name: "decompose", intent: out.gated.decompose }, gated: { ...out.gated, deterministic: null, analytics: false } };
  }
  if (gd && out?.winner?.name !== "decompose" && out.gated?.decompose?.negation && gd.words.some((w) => NEGATION_WORDS.has(String(w).toLowerCase().replace(/’/g, "'")) || /n't$|^(?:other than|excluding|except|but|aside from|apart from|besides)$/i.test(w))) {
    return { ...out, winner: { name: "decompose", intent: out.gated.decompose }, gated: { ...out.gated, deterministic: null, analytics: false } };
  }
  if (gd) return { ...out, winner: null, claimed: (out.claimed ?? []).filter((n) => n !== "deterministic" && n !== "decompose" && n !== "analytics"), gated: { ...out.gated, deterministic: null, decompose: null, analytics: false }, leftoverDeclined: gd };
  const lo = await leftoverDecline(out, question, ctx);
  if (lo) return { ...out, winner: null, claimed: (out.claimed ?? []).filter((n) => n !== "analytics"), gated: { ...out.gated, analytics: false }, leftoverDeclined: lo };
  // R32: an analytics claim on a bare surname shared by 2+ customers ("whens the winslow warranty up" -> a customers-in-Winslow count) is a wrong
  // reading of a customer reference; release it so the clarify path can ask "which one?".
  if (out?.winner?.name === "analytics" && clarifyEnabled() && ctx?.tenantVocab && detectAmbiguousSurname(out.effectiveQuestion ?? question, ctx.tenantVocab)) {
    return { ...out, winner: null, claimed: [], gated: { ...out.gated, analytics: null } };
  }
  return out;
}

async function classifyAllInner(question, ctx = {}) {
  const first = await classifyAllOnce(question, ctx);
  const stripped = stripConversationalFrame(question);
  // R32: vocabulary/dictation rewrite (router/rewrite.js) of the stripped-or-raw text. Preferred over the plain pass whenever a
  // deterministic stage claims it, because the rewrite only respells words the classifiers already know (mfr -> manufacturer, spoken
  // digits -> digits, "train unit" -> "trane unit"); an unchanged question never reaches this branch.
  if (process.env.DONOVAN_REWRITE !== "0") {
    let rewritten = rewriteQuestion(stripped ?? question, ctx?.today);
    // R3 relwindow: the frame stripper can eat a window word ("service calls today" -> "service calls"); try the window rewrite on the raw text too.
    if (!rewritten && stripped) { const rw = rewriteRelWindow(question, ctx?.today); if (rw !== question) rewritten = rw; }
    if (rewritten) {
      const third = await classifyAllOnce(rewritten, ctx);
      const thirdName = third.winner?.name ?? null;
      // R35: a rewrite only claimed by the (looser) analytics stage never overrides a deterministic claim on the text as typed
      // ("units with no warranty end date on file" was respelled to "... warranty expires date ..." and lost its exact count).
      const firstName = first.winner?.name ?? null;
      if (thirdName && !(thirdName === "analytics" && firstName && firstName !== "analytics")) return { ...third, effectiveQuestion: rewritten, frameStripped: Boolean(stripped), rewritten: true };
    }
  }
  // J1: jargon respell. People say "pay app", "packing list", "comfort club", "foreman", "prior month"; the lanes read "invoice", "delivery ticket",
  // "maintenance agreement", "technician", "last month". The jargon table (lexicon/jargon.js, built from the research dictionary) respells those
  // phrases and the result is adopted only when a deterministic lane claims it, exactly like the vocabulary rewrite above. It never overrides
  // a deterministic claim on the text as typed, and a phrase made of a customer or technician name is left alone (tenantVocab).
  if (jargonEnabled()) {
    const jr = respellJargon(stripped ?? question, { tenantVocab: ctx?.tenantVocab });
    if (jr) {
      const cand = rewriteQuestion(jr.text, ctx?.today) ?? jr.text;
      const jt = await classifyAllOnce(cand, ctx);
      const jName = jt.winner?.name ?? null;
      const fName = first.winner?.name ?? null;
      // a respelled phrase read as a person's name (contactLookup) is no understanding; a typed phrase read as a name IS the failure this fixes
      // a date-phrase-only respell ("prior month" -> "last month") says the same thing in the words the date parsers read, so it is adopted like the
      // vocabulary rewrite above (any deterministic claim, never trading a deterministic one for the looser analytics stage)
      const dateOnly = jr.hits.every((h) => h.date);
      const adopt = dateOnly ? !(jName === "analytics" && fName && fName !== "analytics") : (!fName || fName === "contactLookup" || fName === "analytics" || (fName === "deterministic" && jName !== "deterministic" && jName !== "analytics") || (fName === "deterministic" && first.winner?.intent?.route === "tenantcount" && jName === "deterministic"));
      if (jName && jName !== "contactLookup" && adopt) return { ...jt, effectiveQuestion: cand, frameStripped: Boolean(stripped), jargon: jr.hits };
    }
  }
  if (!stripped) return { ...first, effectiveQuestion: question };
  const second = await classifyAllOnce(stripped, ctx);
  const secondName = second.winner?.name ?? null;
  // The frame words carry no information by construction, so the stripped pass is the better read whenever
  // it is claimed by a deterministic stage. (The raw text can be "claimed" too — e.g. fastPath's own
  // subject extraction latches onto the filler — and then fail at run time and fall through to the model.)
  if (secondName && secondName !== "analytics") return { ...second, effectiveQuestion: stripped, frameStripped: true };
  // R32: the raw (filler-wrapped) text was claimed by nothing at all, so an analytics claim on the stripped text cannot be trading a
  // better raw read for a worse one; adopt it (previously: "so uh, did we do any visits in the last 90 days" went to the model).
  if (secondName === "analytics" && (!first.winner?.name || first.winner.name === "analytics")) return { ...second, effectiveQuestion: stripped, frameStripped: true };
  return { ...first, effectiveQuestion: question };
}
