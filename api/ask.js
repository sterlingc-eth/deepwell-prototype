import { questionNamesEntity } from "./_lib/lookups/nameMatch.js";
import { armResponseDeadline } from "./_lib/util/deadline.js";
import { resolveToday } from "./_lib/util/localDate.js";
import crypto from "node:crypto";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS, withBackoff, providerFailureMessage } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { helpGate, answerHowTo } from "./_lib/support/askhelp.js";
import { limit, assertModelBudget, sendModelBudgetExceeded } from "./_lib/rateLimit.js";
import { withTenant, normalizeMatchText } from "./_lib/recordsStore.js";
import { mergeDocumentVia, formatVia } from "./_lib/routes/customers.js";
import {
  ANSWER_TOOL,
  buildAllowed,
  shapeAnswer,
  SYSTEM_PROMPT,
  buildContextBlock,
  buildQuestionBlock,
  selectPassagesForContext,
} from "./_lib/answer.js";
import { planCacheBreakpoints, modelCallLogLine } from "./_lib/promptCache.js";
import { recordModelCall, incrementAsksThisMonth as incrementAsksThisMonthRaw, isCountableAskSource, monthStartUtc, currentUsageMeter } from "./_lib/usage.js";
import { documentTypeLabel } from "./_lib/documentTypes.js";
import { gateAsk } from "./_lib/plan.js";
import { startTimer, formatServerTiming } from "./_lib/timing.js";
import { getCacheEntry, isCacheHit, upsertCacheEntry, shouldCache, ASK_CACHE_ENABLED as ASK_CACHE_ENABLED_RAW } from "./_lib/askCache.js";
import { lookupSemantic, storeSemantic } from "./_lib/cache/semanticCache.js";
import { runFastPath } from "./_lib/fastPathQuery.js";
// Team A (2026-09-24): deterministic history/comparison/maintenance router (no model call, cited answers).
import { runDeterministic } from "./_lib/deterministicRouter.js";
import { looksLikeSingleRecordReference, moneyFallbackAnswer, detectedConditions } from "./_lib/analytics.js";
// R16 (F2 hook): oldest/newest-unit questions now have a deterministic, cited planner — keep them off the agent-first gates.
import { isInstallDateExtremeQuestion } from "./_lib/analytics/detPlan.js";
// FINANCIALS layer (handoffs/FINANCIALS_2026-09-23.md): answers money questions from SQL over document_financials.
// Round 16 D1 #7 (cold start): moneyGate.js -> financials/answers.js -> agent/tools.js
// -> agent/viewPage.js/search/dossier.js/search/mapReduce.js all transitively pull in
// @anthropic-ai/sdk (the agent tool-use loop these share) — loaded lazily below
// (loadMoneyGateModule), gated on the exact same `moneyQuestion` condition that used
// to just call these functions directly, so a non-money question never touches it.
// (isFinancialQuestion itself is now only called from classifyAll.js — see the router import below.)
// TEAM C (citations everywhere): one citation contract for every answer kind (records / recordsTotal / basis).
import { attachCitations, finalizeCitations, unitRecord, documentRecord } from "./_lib/citations/records.js";
// Round 22 (S2, privacy): a fuzzy-typo correction pair (below) is a fragment of whatever a
// technician actually typed — a customer surname, a street name — so it is hashed before it ever
// reaches a route log, never printed raw. See api/_lib/privacy/redact.js's own module doc.
import { hashForLog } from "./_lib/privacy/redact.js";
import { checkAnswerClaimsSync } from "./_lib/claims/index.js";
import { parseAmountInvoiceQuestion, amountMentioned } from "./_lib/financials/amountInvoice.js";
import { namedMoneyShape } from "./_lib/lookups/namedMoney.js";
import { understandQuestion } from "./_lib/understanding/understand.js";
import { docLaneFromUnderstanding } from "./_lib/understanding/route.js";
import { loadGroundingEvidence, loadFinancialRows, applyGrounding } from "./_lib/grounding/gate.js";
import { attachSentenceCitationsSync } from "./_lib/citations/sentences.js";
import { annotateSuperseded, getSupersessionMap } from "./_lib/supersession.js";
import { attachRetrievalCitations } from "./_lib/citations/retrieval.js";
import { metaCount, metaListCitations, metaDocumentTypes, withCitations, honestZeroCitations, searchedLibraryBasis } from "./_lib/citations/enrich.js";
// Round 16 D1 #7 (cold start): routes/analytics.js imports @anthropic-ai/sdk
// at module scope (its one-Haiku-tool-use-call planner) — loaded lazily
// below (loadAnalyticsRouteModule) instead of statically, so a request a
// deterministic pre-router answers never pays for it.
import { runContactLookup, resolveAddressCandidates } from "./_lib/contactLookup.js";
import { runDocLookup, resolveHonestZeroContext, buildHonestZeroText, customerDocumentIds } from "./_lib/docLookup.js";
// TEAM E (2026-09-24): full-corpus content-count questions ("how many jobs mention a capacitor", "which customers had
// a coil issue on file") — a deterministic scan of document_pages.text (all of it, not a top-K search), never the
// agent's own search_documents fallback which was silently undercounting. See contentCount.js's own doc comment.
import { runContentCount } from "./_lib/contentCount.js";
import { answerRelationsQuestion } from "./_lib/relations/questions.js";
// Round 11 (literature #2): deterministic query decomposition for multi-part/conjunctive/comparison
// questions ("Which Trane customers with no agreement had a callback this year?", "Compare invoices vs
// POs for the Rios job") — typed sub-queries over analytics/relations/financials building blocks,
// intersected/compared by entity id. Tried after relations (0.35)/the deterministic history router (0.4),
// before the analytics planner — see the "0.42 query decomposition" block below.
import { runDecompose } from "./_lib/decompose/index.js";
import { packForTenant } from "./_lib/industry/index.js";
// Round 11 (literature #6/#7): per-tenant vocabulary (brands/models/technicians/customers actually on
// file, cached per tenant by data-version) — widens normalization's fuzzy-typo correction beyond the
// generic/pack vocabulary and grounds the analytics planner prompt in what THIS tenant's data contains.
import { getTenantVocab, correctTenantNameTypos } from "./_lib/vocab/tenantVocab.js";
import { decorateWithTypoNote, techNoteFromCorrection } from "./_lib/lookups/typoResolve.js";
import { resolveNicknameInQuestion } from "./_lib/vocab/nicknames.js";
// Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): every honest
// fallback / no-answer / ambiguous-lookup / analytics-fallthrough gets a row
// in ask_misses for the weekly review — see missStore.js's own doc comment
// for why every call site here is fire-and-forget and tolerant of the table
// not existing yet.
import { insertAskMiss, recordAskMiss, MISS_OUTCOMES } from "./_lib/missStore.js";
import { getStreetVocab, peekStreetVocab, correctStreetTypos } from "./_lib/streetVocab.js";
// Day 1 training-plan normalization layer (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// aliased because this file already has its own `normalizeQuestion` (the
// retrieval-cache one, below) — the analytics pre-classifier gate needs the
// NL-normalized text (abbreviations expanded, typos fixed) so a sloppy
// phrasing gets the same routing decision a clean one would, not this file's
// plainer lowercase/trim/strip-punctuation normalization.
import { normalizeQuestion as normalizeQuestionForAnalytics } from "./_lib/nlNormalize.js";
// Tier 2 learning loop, Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// the process-wide ACTIVE overlay of every approved learned abbreviation/
// typo/synonym/few-shot example — cached 10 minutes, {} on any error (e.g.
// migration 26 not applied yet). Threaded explicitly into every overlay-aware
// call below rather than read again by each one.
import { getActiveOverlayForTenant } from "./_lib/learning/overlay.js";
// Donovan agent fallback (api/_lib/agent/): a bounded read-only tool-use loop tried when every
// pre-router / the analytics planner / retrieval+model could not answer. DONOVAN_AGENT=0 disables it.
// Round 16 D1 #7 (cold start): agent/loop.js imports @anthropic-ai/sdk at
// module scope — loaded lazily below (loadAgentModule) instead of statically.
import { isAgentFirstQuestion, isEnumerationQuestion } from "./_lib/agent/intents.js";
// Round 16 D1 #7 (cold start): fastReplay.js -> agent/tools.js -> viewPage.js/search/
// dossier.js/search/mapReduce.js transitively pull @anthropic-ai/sdk — loaded lazily
// below (loadFastReplayModule), only reached from inside tryAgent (see loadAgentModule).
// TEAM T1 (research agent v2, 2026-09-25): Sonnet-first, more-tools, longer-budget successor to the
// Haiku loop above, with its own verify step. Swapped in at every existing tryAgent() call site below —
// none of the pre-router chain above it changes. See loopV2.js's own doc comment.
// Round 16 D1 #7 (cold start): loopV2.js imports @anthropic-ai/sdk (and
// routes/analytics.js's ANALYTICS_MODEL) at module scope — loaded lazily
// below (loadResearchAgentModule) instead of statically.
import { logRouteDecision } from "./_lib/agent/router.js";
// Round 18 (H3): the unified pre-router classification (relations through analytics) — see this
// module's own header and its call site below ("unified pre-router classification").
import { classifyAll } from "./_lib/router/classifyAll.js";
// R32: general early declines (off-domain / untracked component attribute / dangling follow-up with no conversation).
import { rewriteInvoiceTotal } from "./_lib/lookups/countQualifiers.js";
import { buildAddressMissAnswer } from "./_lib/lookups/addressMiss.js";
import { buildUnknownNameDecline } from "./_lib/lookups/unknownName.js";
import { parseCustomerCount, runCustomerCount } from "./_lib/lookups/namedCompare.js";
import { buildClarifyAnswer, clarifyEnabled, ADDRESS_RE } from "./_lib/lookups/clarify.js";
import { answerAddressConflict, softConflictNote } from "./_lib/addressConflict.js";
import { capInlineNameList } from "./_lib/router/brevity.js";
import { resolvePartialNameInQuestion, buildPartialNameClarify } from "./_lib/vocab/partialNames.js";
import { classifySafety, buildSafetyAnswer, unverifiedTypeNote, normalizeInputText, neutralizeMarkup } from "./_lib/router/safetyGate.js";
import { normalizeRephrase, typoFixes, applyTypoFixes, rephraseEnabled } from "./_lib/router/rephrase.js";
import { classifyEarlyDecline, buildEarlyDeclineAnswer, earlyDeclineEnabled, triggerMatchesCustomerName } from "./_lib/router/earlyDecline.js";
// Round 20 (J1): the general precision guard (THE #1 PROBLEM — false confidence, r19_blind3_clusters.json's
// F1/F6) — see guard/check.js's own header for what each function checks and why, and the untracked-concept
// registry (api/_lib/concepts/registry.js) for the honest-decline half.
import { guardDecomposeAnswer, guardAnalyticsAnswer } from "./_lib/router/guard/check.js";
import { detectUntrackedConcept, untrackedConceptAnswer } from "./_lib/concepts/registry.js";
// Recipes (api/_lib/learning/recipes.js): worked examples an approved/confirmed grounded answer taught the agent.
import { findExactRecipe, matchParametricExamples } from "./_lib/learning/recipes.js";
// Round 16 D1 #7 (cold start): learning/replay.js itself statically imports
// agent/loop.js (-> @anthropic-ai/sdk) just for its own isAgentEnabled() —
// loaded lazily below (loadReplayModule) instead of statically.
import { isPlatformOperator } from "./_lib/missDigest.js";
// Donovan Scorecard (api/_lib/scorecard/): in-process calls carry {auth, escalate} under a Symbol no HTTP request can set.
import { takeScorecardCall } from "./_lib/scorecard/hook.js";
// TEAM T2 (2026-09-25): conversational follow-ups — an optional, client-supplied conversationContext
// (see api/_lib/conversation.js for the shape T1's agent shares) is validated server-side and, only when
// the new question actually reads as a continuation ("and last year?", "just the Trane ones", "who was
// the tech?"), folded into a self-contained question BEFORE the existing pipeline below ever sees it.
// A self-contained question, or a request with no conversationContext at all (every existing caller),
// takes this exact same path it always has — nothing here changes behavior unless the field is sent.
import { classifyNonQuestion, nonQuestionAnswer } from "./_lib/modelAvoidance/nonQuestion.js";
import { isNonQuestionGateEnabled } from "./_lib/modelAvoidance/switches.js";
import { validateConversationContext, isFollowupContinuation, composeFollowup } from "./_lib/conversation.js";

/** Billing gate (handoffs/BILLING_RULES.md): ask stays readable through
 * past-due grace and past-grace alike — only a never-subscribed tenant past
 * its free preview, or a canceled subscription, blocks it. */
async function checkAskGate(auth) {
  // Fail OPEN: a billing lookup that errors (e.g. migration 14 not applied
  // yet, or a DB blip) must never turn into a 500 for every customer.
  try {
    return await checkAskGateInner(auth);
  } catch (err) {
    console.error("billing gate failed open (checkAskGate):", err?.message);
    return { allowed: true };
  }
}

/**
 * A9: post-response bookkeeping (audit row, usage counter, cache write) runs AFTER a model call that can take many seconds.
 * Every transaction in this route is already short and no model call runs inside one (scripts/lib/r41u-sec-e2-a9.mjs asserts
 * that for every route), but a pooled connection that sat idle through the model call can be dropped by the server/pooler, and
 * the first statement of the new transaction then fails with "Connection terminated". That transaction rolled back whole, so
 * re-running it once on a fresh connection is safe (the audit row is never written twice) and is what keeps the row from being lost.
 */
function isConnectionDropError(err) {
  const m = `${err?.code ?? ""} ${err?.message ?? ""}`;
  return /ECONNRESET|EPIPE|ETIMEDOUT|57P01|57P02|57P03|08006|08003|08000|connection terminated|connection error|Client has encountered a connection error|timeout exceeded when trying to connect/i.test(m);
}
async function withTenantRetry(ctxArg, fn) {
  try {
    return await withTenant(ctxArg, fn);
  } catch (err) {
    if (!isConnectionDropError(err)) throw err;
    console.error("bookkeeping connection dropped, retrying once on a fresh connection:", err?.message);
    return await withTenant(ctxArg, fn);
  }
}

async function checkAskGateInner(auth) {
  return withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (db) => {
    // Latency fix (2026-09-20, handoffs/ASK_LATENCY_2026-09-20.md): this used
    // to be two sequential queries (the tenant row, then countDocuments()) —
    // two round trips inside a withTenant transaction that already costs
    // BEGIN + resolve_tenant + SET LOCAL + COMMIT on top. One query, one
    // round trip, same two facts. asksThisMonth (2026-09-21, monthly
    // allowance) joins the same round trip rather than costing a second one —
    // see usage.js's getAsksThisMonth for why this can't just be that
    // function called separately (same table, same RLS, cheaper as one more
    // subselect here than a whole extra query).
    const { rows } = await db.raw(
      `SELECT
         (SELECT row_to_json(t) FROM (
            SELECT plan, billing_status, trial_ends_at, current_period_end
              FROM tenants WHERE id = $1
          ) t) AS tenant,
         (SELECT count(*)::int FROM documents WHERE tenant_id = $1) AS documents_stored,
         (SELECT units FROM rate_limit_windows
           WHERE tenant_id = $1 AND bucket = 'ask_month' AND window_start = $2::timestamptz) AS asks_this_month`,
      [db.tenantId, monthStartUtc().toISOString()]
    );
    return gateAsk(rows[0]?.tenant ?? {}, {
      documentsStored: rows[0]?.documents_stored ?? 0,
      asksThisMonth: rows[0]?.asks_this_month ?? 0,
    });
  });
}

/**
 * SHA-256 of a question, never the question itself. Pure and exported so it
 * can be unit tested without a database — see scripts/verify-ops.mjs.
 *
 * WHY THE QUESTION TEXT IS NEVER LOGGED: a dispatcher's question routinely
 * contains a customer's name, address, or unit serial ("what's the warranty
 * on the Andersons' furnace at 12 Elm St") typed straight into a free-text
 * box. audit_log exists to answer "who saw this customer's document" — it is
 * not a place to accumulate a second, unprotected copy of customer PII next
 * to the answer. The hash still lets the same question asked twice be
 * recognized as the same question (e.g. for rate limiting or repeat-question
 * metrics) without ever storing what was actually typed.
 */
export function hashQuestion(question) {
  return crypto.createHash("sha256").update(String(question)).digest("hex");
}

/**
 * POST /api/ask
 * body: { question, today? }
 *
 * Retrieval happens HERE, on the server, against the tenant's own rows:
 * full-text and identifier search over document_pages, plus any
 * already-extracted fields that mention the same identifiers. Only the
 * passages and extractions retrieval actually returns go into the prompt,
 * and shapeAnswer() then drops any fact whose citation doesn't match one of
 * those exact rows (document AND page, or document AND field — see
 * _lib/answer.js). Cost doesn't scale with corpus size, and the model is
 * handed real pages rather than a summary of them, so a fact it cites is a
 * fact on a page.
 *
 * THE TRUST BUG THIS REPLACES: this endpoint used to accept a client-
 * supplied `records` array and answer from it whenever server retrieval came
 * back empty. That fallback is gone, on purpose, not just moved.
 *
 * The reason isn't request size or latency — it's that the browser has no
 * way to send anything BUT its local entity graph, and today that graph is
 * always `src/domains/hvac/seed.ts`: a hardcoded demo fixture, bootstrapped
 * unconditionally on every page load (see src/main.tsx). There is currently
 * no code path that puts a real customer's own data into that graph. So "no
 * server passages, fall back to client records" meant, in practice: a real
 * customer with zero or partially-ingested documents gets a confident,
 * fully-cited answer built entirely out of demo equipment, demo warranties
 * and demo work orders. `shapeAnswer` could not catch this, because the
 * cited "document" genuinely was in the set the fallback handed it — the
 * whole set was just never the customer's.
 *
 * The product's one promise is "every fact comes from your own documents."
 * An honest "nothing in your records answers that yet" keeps that promise;
 * a fabricated-but-cited answer breaks it, and breaks it worse the more
 * confident it sounds. So when retrieval finds nothing, we say so and stop.
 * We do not reach for a second "evidence" source that was never the
 * customer's to begin with — and there is no server-side flag or client
 * field left that could quietly turn it back on. If a real client-side
 * ingestion path is built later, it should hand the SERVER the raw material
 * to retrieve from, so it goes through this same tenant-scoped, retrieval-
 * gated path, not hand the model a pre-packaged, unverifiable "here are the
 * facts" payload directly.
 */
// maxDuration is explicit rather than inherited. A route without it runs on
// the platform's bare default, which is SHORTER than 60s — so the model call
// below could be hard-killed before its own timeout ever fired, and a hard kill
// runs no catch block and tells the user nothing.
//
// 300 (owner decision, 2026-09-25, Vercel Pro): the research agent (loopV2.js) budgets up to ~240s of
// tool-use before it forces an answer; every OTHER path here (meta/deterministic/fast-path/retrieval)
// still finishes in well under a second and is completely unaffected by a larger ceiling.
export const config = { api: { bodyParser: { sizeLimit: "512kb" } }, maxDuration: 300 };

// ---------------------------------------------------------------------------
// Round 16 D1 #7 (cold start): every model-only module below (the Anthropic
// SDK itself, the two agent loops, the analytics planner, and the recipe-
// teaching module that pulls the v1 loop in just for its own isAgentEnabled)
// used to be a static top-of-file import, so simply `import()`-ing this file
// (before a single request is even handled) cost ~250-290ms — ~130ms of it
// @anthropic-ai/sdk alone — paid on every cold Vercel invocation even for a
// request the deterministic pre-router chain (meta/relations/deterministic/
// decompose/fast-path/contact/doc-lookup/content-count/money) answers
// without ever touching the model. Each loader is a plain dynamic import(),
// cached in a module-level variable (`??=`) the first time it's actually
// awaited: the SECOND and later calls in the same warm process resolve
// instantly (Node's own module cache backs this up regardless), and a
// request that never reaches one of these call sites never imports the SDK
// at all. See scripts/verify-cold-start.mjs for the regression check (plain
// `import('./api/ask.js')` must not pull @anthropic-ai/sdk into the graph).
let _anthropicSdk = null;
function loadAnthropicSdk() {
  return (_anthropicSdk ??= import("@anthropic-ai/sdk"));
}
let _agentModule = null;
function loadAgentModule() {
  return (_agentModule ??= import("./_lib/agent/loop.js"));
}
let _researchAgentModule = null;
function loadResearchAgentModule() {
  return (_researchAgentModule ??= import("./_lib/agent/loopV2.js"));
}
let _analyticsRouteModule = null;
function loadAnalyticsRouteModule() {
  return (_analyticsRouteModule ??= import("./_lib/routes/analytics.js"));
}
let _moneyGateModule = null;
function loadMoneyGateModule() {
  return (_moneyGateModule ??= import("./_lib/financials/moneyGate.js"));
}
let _fastReplayModule = null;
function loadFastReplayModule() {
  return (_fastReplayModule ??= import("./_lib/agent/fastReplay.js"));
}
let _replayModule = null;
function loadReplayModule() {
  return (_replayModule ??= import("./_lib/learning/replay.js"));
}

// Research agent v2 (owner decision, 2026-09-25): "Sonnet as the default research agent for anything
// non-trivial." Resolved once per process, not per request (memoized below, same as the old module-level
// constant) — DONOVAN_RESEARCH_AGENT=0 reverts every tryAgent() call site below to the v1 Haiku loop
// (loop.js) with no other change. Computed lazily (only once something actually needs to know) rather
// than at module load, per the cold-start note above — isResearchAgentEnabled() itself lives inside
// loopV2.js, so checking it does still load that module (and the SDK) the first time any request reaches
// a call site that needs it; a request a deterministic pre-router answers never reaches one.
let _researchV2Enabled = null;
async function getResearchV2Enabled() {
  if (_researchV2Enabled === null) {
    const mod = await loadResearchAgentModule();
    _researchV2Enabled = mod.isResearchAgentEnabled();
  }
  return _researchV2Enabled;
}

// DONOVAN_AGENT (default on) — same "resolved once, memoized" shape as
// getResearchV2Enabled above, for the exact same cold-start reason.
let _agentOnCache = null;
async function getAgentOn() {
  if (_agentOnCache === null) {
    const mod = await loadAgentModule();
    _agentOnCache = mod.isAgentEnabled();
  }
  return _agentOnCache;
}

const MAX_QUESTION = 2000;
const MAX_PASSAGES = 12;
const MAX_EXCERPT = 1200;
// Haiku by default (owner decision 2026-09-20: cost). Set ASK_MODEL in Vercel
// env to switch without a deploy. Retrieval is what makes answers right;
// the model only phrases and cites what retrieval returned.
export const ASK_MODEL = process.env.ASK_MODEL || "claude-haiku-4-5";

/**
 * ---------------------------------------------------------------------------
 * Meta-question pre-router: "how many documents are in the system", "list
 * all customers" — inventory questions with a single, deterministic SQL
 * answer. No model call, no retrieval, no cost, and no chance of the
 * grounding bug above (there is nothing for a model to hallucinate).
 *
 * Classification is exact-match on a normalized question, on purpose: a
 * flexible regex here ("how many X do we have") would also swallow
 * per-entity questions like "how many documents does Plaza Dental have" or
 * "how many tons is the Goodman" — those must keep going through retrieval
 * (buildAllowed/searchPassages), which already answers them correctly.
 * classifyMetaQuestion is exported so scripts/verify-retrieval.mjs can check
 * both the positive phrasings and those negatives without a database.
 */
export function normalizeQuestion(q) {
  return String(q ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

const COUNT_QUESTIONS = {
  "how many documents are in the system": "documents",
  "how many documents do we have": "documents",
  "how many documents are there": "documents",
  "how many docs do we have": "documents",
  "how many customers do we have": "customers",
  "how many customers are there": "customers",
  "how many clients do we have": "customers",
  "how many units do we have": "equipment",
  "how many pieces of equipment do we have": "equipment",
  "how many equipment records are there": "equipment",
  "how many invoices do we have": "invoices",
  "how many invoices are there": "invoices",
  "how many warranties do we have": "warranties",
  "how many warranty registrations are there": "warranties",
  "how many documents are verified": "verified",
  "how many are verified": "verified",
  "how many documents are unverified": "unverified",
  "how many are unverified": "unverified",
  "how many are still unverified": "unverified",
};

const LIST_DOCUMENTS = new Set([
  "list all documents", "list documents", "show all documents",
  "show me all documents", "what documents do we have", "what documents exist",
]);
const LIST_UNVERIFIED = new Set([
  "which documents are unverified", "list unverified documents",
  "show unverified documents", "what documents are unverified", "what needs review",
]);
const LIST_CUSTOMERS = new Set([
  "list all customers", "list customers", "show all customers", "who are our customers",
]);
const LIST_TYPES = new Set([
  "what document types do we have", "what types of documents do we have",
  "list document types", "what document types exist",
]);

// Customer numbers (M3-config/15-customer-profiles.sql, 'C-00001' style).
// Matched case-insensitively against the RAW question (never the lowercased
// `q` normalizeQuestion produces) so the returned id keeps canonical
// uppercase 'C-' regardless of how the dispatcher typed it.
const CUSTOMER_NUMBER_RE = /\bC-(\d{5})\b/i;

/** Pure: pull a customer number out of free text, or null. Exported so this
 *  is testable with no database (scripts/verify-retrieval.mjs). */
export function extractCustomerNumber(question) {
  const m = String(question ?? "").match(CUSTOMER_NUMBER_RE);
  return m ? `C-${m[1]}` : null;
}

const SHOW_EVERYTHING_RE = /^show (?:me )?everything (?:for|about) (c-\d{5})$/;

// Round 6 (2026-09-25): "how many invoces are there" (a typo of "invoices") never matched COUNT_QUESTIONS at all —
// this exact-match lookup used to run only through this file's own bare normalizeQuestion (trim/lowercase/strip
// punctuation), never nlNormalize.js's fuzzy typo corrector, even though every COUNT_QUESTIONS/LIST_* key is plain
// English with no address/customer name in it (nothing for that corrector's own singleRecord guard to protect).
// normalizeQuestionForAnalytics (nlNormalize.js, imported above) leaves every one of this table's own keys
// byte-for-byte unchanged (see scripts/verify-round6.mjs) while fixing exactly this class of typo.
export function classifyMetaQuestion(question) {
  const q = normalizeQuestionForAnalytics(question).normalized;
  if (!q) return null;
  const everything = q.match(SHOW_EVERYTHING_RE);
  if (everything) return { kind: "customer", number: everything[1].toUpperCase() };
  if (COUNT_QUESTIONS[q]) return { kind: "count", target: COUNT_QUESTIONS[q] };
  if (LIST_DOCUMENTS.has(q)) return { kind: "list", target: "documents" };
  if (LIST_UNVERIFIED.has(q)) return { kind: "list", target: "unverified-documents" };
  if (LIST_CUSTOMERS.has(q)) return { kind: "list", target: "customers" };
  if (LIST_TYPES.has(q)) return { kind: "list", target: "document-types" };
  // Imperative: the Ask box can't do these — point at where in the app can.
  if (/^(please\s+)?(delete|remove)\b/.test(q)) return { kind: "imperative", action: "delete" };
  if (/^(please\s+)?upload\b/.test(q)) return { kind: "imperative", action: "upload" };
  return null;
}

/**
 * Every document id reachable for one customer, via the same three paths as
 * the customer profile screen (api/_lib/routes/customers.js) — direct
 * customer link, owned-equipment link/extraction, or a name+address text
 * match. Returns null (not []) when the number resolves to no customer, so
 * callers can tell "found the customer, they have zero documents" (a real []
 * — retrieval should find nothing) apart from "that number doesn't exist"
 * (null — the meta path answers that directly; the scoping path falls back
 * to answering unscoped rather than silently returning zero results for a
 * typo'd number).
 */
async function resolveCustomerDocumentIds(db, number) {
  const row = await db.getCustomerByIdOrNumber({ number });
  if (!row || row.merged_into) return { row: null, documentIds: null };
  const name = normalizeMatchText(row.data?.customer_name);
  const address = normalizeMatchText(row.data?.service_address);
  const [linkRows, nameMatchRows] = await Promise.all([
    db.listCustomerDocumentLinks(row.id),
    db.listNameMatchedDocuments(name, address),
  ]);
  const via = mergeDocumentVia([
    ...linkRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
    ...nameMatchRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
  ]);
  return { row, documentIds: via.map((v) => v.documentId).slice(0, 2000), via };
}

/** "show everything for C-00012" — model-free: lists this customer's
 *  documents and equipment with sources, same shape as listCustomers/
 *  listDocuments above. */
async function showCustomerEverything(db, number) {
  const { row, documentIds, via } = await resolveCustomerDocumentIds(db, number);
  if (!row) {
    return attachCitations(
      { kind: "no-answer", text: `No customer found for ${number}.`, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Looked up customer number ${number} in your customer records; no customer has that number.` } // TEAM C
    );
  }
  const [equipmentRows, documentDetails] = await Promise.all([
    db.listCustomerEquipment(row.id),
    db.listDocumentDetails(documentIds),
  ]);
  const viaByDoc = new Map(via.map((v) => [v.documentId, v]));
  const facts = documentDetails.slice(0, META_LIST_LIMIT).map((d) => {
    const v = viaByDoc.get(d.id);
    return {
      label: documentTypeLabel(d.document_type),
      value: `${d.original_filename ?? d.id} (${formatVia(v?.via, v?.serial)})`,
      sources: [{ documentId: d.id, location: {} }],
    };
  });
  for (const u of equipmentRows.slice(0, META_LIST_LIMIT)) {
    facts.push({ label: "Equipment", value: [u.serial_number, u.model].filter(Boolean).join(" — ") || u.id, sources: [] });
  }
  const name = row.data?.customer_name ?? "Unnamed customer";
  const text = `${name} (${row.customer_number}) — ${documentDetails.length} document${documentDetails.length === 1 ? "" : "s"}, ${equipmentRows.length} piece${equipmentRows.length === 1 ? "" : "s"} of equipment.`;
  // TEAM C: the records are the same documents + units the sentence counts.
  const everything = [
    ...documentDetails.map((d) => documentRecord(d, { label: `${documentTypeLabel(d.document_type)} · ${d.original_filename ?? d.id}` })),
    ...equipmentRows.map((u) => unitRecord(u, { customerId: row.id })),
  ];
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    { records: everything, total: everything.length, claimedCount: documentDetails.length + equipmentRows.length,
      basis: `Everything linked to ${name} (${row.customer_number}): documents linked directly, through their equipment, or by matching name and address, plus their equipment.` }
  );
}

const META_LIST_LIMIT = 50;
// Belt-and-braces alongside RLS, same predicate recordsStore.js's private
// TENANT constant uses — see withTenant() there. This route only reaches the
// database via db.raw(), the tenant-scoped escape hatch recordsStore.js
// already exposes for exactly this (see its own doc comment).
const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

const COUNT_LABEL = {
  documents: "documents",
  customers: "customers",
  equipment: "pieces of equipment",
  invoices: "invoices",
  warranties: "warranty registrations",
  verified: "verified documents",
  unverified: "unverified documents",
};

async function countFor(db, target) {
  const table = target === "customers" || target === "equipment" ? "entities" : "documents";
  const where = {
    documents: TENANT_SQL,
    customers: `entity_type = 'customer' AND ${TENANT_SQL}`,
    equipment: `entity_type = 'equipment' AND ${TENANT_SQL}`,
    invoices: `document_type = 'invoice' AND ${TENANT_SQL}`,
    // 'warranty' is the pre-migration legacy id (see handoffs/TEAM_BRIEF); a
    // never-reprocessed row can still carry it.
    warranties: `document_type IN ('warranty-registration','warranty') AND ${TENANT_SQL}`,
    verified: `stage = 'verified' AND ${TENANT_SQL}`,
    unverified: `stage <> 'verified' AND ${TENANT_SQL}`,
  }[target];
  const { rows } = await db.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, []);
  return rows[0].n;
}

async function listDocuments(db, unverifiedOnly) {
  const filter = unverifiedOnly ? `stage <> 'verified' AND ${TENANT_SQL}` : TENANT_SQL;
  const total = (await db.raw(`SELECT COUNT(*)::int AS n FROM documents WHERE ${filter}`, [])).rows[0].n;
  // TEAM C: the citation records come from this same query (more columns, up to the record cap); the
  // response `sources` keep their original first-META_LIST_LIMIT size.
  const { rows: allRows } = await db.raw(
    `SELECT id, document_type, original_filename, created_at FROM documents WHERE ${filter} ORDER BY created_at DESC LIMIT 200`,
    []
  );
  const rows = allRows.slice(0, META_LIST_LIMIT);
  const sources = rows.map((r) => ({ documentId: r.id, location: {} }));
  const noun = unverifiedOnly ? "unverified document" : "document";
  const text = total > sources.length
    ? `${total} ${noun}s — showing the first ${sources.length}.`
    : `${total} ${noun}${total === 1 ? "" : "s"}.`;
  return attachCitations(
    { kind: "answer", text, facts: [], sources, confidence: 1, verifiedCount: sources.length, unverifiedCount: 0, closest: [] },
    { ...metaListCitations(unverifiedOnly ? "unverified" : "documents", allRows, total), basis: unverifiedOnly ? "Listed documents that have not been verified yet, newest upload first." : "Listed documents, newest upload first." }
  );
}

async function listCustomers(db) {
  const total = (await db.raw(
    `SELECT COUNT(*)::int AS n FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}`, []
  )).rows[0].n;
  // TEAM C: id column added so each listed customer is a clickable record (same rows, same order).
  const { rows: allRows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}
      ORDER BY updated_at DESC LIMIT 200`,
    []
  );
  const rows = allRows.slice(0, META_LIST_LIMIT);
  const facts = rows.map((r) => ({ label: r.name || "Unnamed customer", value: r.address || "—", entityId: r.id, sources: [] }));
  const text = total > facts.length
    ? `${total} customers — showing the first ${facts.length}.`
    : `${total} customer${total === 1 ? "" : "s"}.`;
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    metaListCitations("customers", allRows.map((r) => ({ ...r, customer_name: r.name, service_address: r.address })), total)
  );
}

async function listDocumentTypes(db) {
  // TEAM C: same GROUP BY, now also carrying the documents in each group (records keep the type as their group key).
  const { rows, citations } = await metaDocumentTypes(db);
  const facts = rows.map((r) => ({ label: documentTypeLabel(r.document_type), value: String(r.n), sources: [] }));
  const text = facts.length ? `${facts.length} document type${facts.length === 1 ? "" : "s"} in use.` : "No documents yet.";
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    citations
  );
}

const IMPERATIVE_TEXT = {
  delete: "To delete a document: go to Browse → Documents, select it, then choose Delete selected.",
  upload: "To upload a document: go to Intake and drop your files there.",
};

async function runMetaQuestion(db, meta) {
  if (meta.kind === "imperative") {
    return attachCitations(
      { kind: "no-answer", text: IMPERATIVE_TEXT[meta.action], facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, basis: "This is a how-to about the app, not something drawn from your records." } // TEAM C
    );
  }
  if (meta.kind === "count") {
    // TEAM C: ONE query yields the number AND the rows behind it (window COUNT), so they cannot disagree.
    const counted = await metaCount(db, meta.target);
    const n = counted ? counted.n : await countFor(db, meta.target);
    const label = COUNT_LABEL[meta.target];
    // R41U E4: "how many invoices" must agree with "how many customer invoices": when some documents typed as invoices are purchase orders / credit memos / vendor bills, say so.
    let invText = null;
    if (meta.target === "invoices" && n > 0) {
      try {
        const { invoiceKindCounts } = await import("./_lib/financials/answers.js");
        const fk = await invoiceKindCounts(db);
        const other = fk ? fk.other : 0;
        if (other > 0 && fk.inv + other === n) invText = `You have ${n} documents typed as invoices: ${n - other} customer invoice${n - other === 1 ? "" : "s"} and ${other} other (purchase orders, credit memos or vendor bills).`;
      } catch { /* no financial rows: keep the plain count */ }
    }
    const answer = {
      kind: "answer",
      text: invText ?? `You have ${n} ${label}.`,
      facts: [{ label: label[0].toUpperCase() + label.slice(1), value: String(n), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [],
    };
    return counted ? attachCitations(answer, counted.citations) : answer;
  }
  if (meta.kind === "customer") return showCustomerEverything(db, meta.number);
  if (meta.target === "unverified-documents") return listDocuments(db, true);
  if (meta.target === "documents") return listDocuments(db, false);
  if (meta.target === "customers") return listCustomers(db);
  return listDocumentTypes(db);
}

/**
 * Evidence retrieval for one question: the customer-number scope (if any)
 * plus the two independent reads (searchPassages/searchExtractions), all in
 * ONE withTenant transaction — was three separate withTenant calls (each its
 * own connect + BEGIN + resolve_tenant + SET LOCAL + COMMIT), now one, with
 * the two searches themselves run with Promise.all since neither depends on
 * the other. See handoffs/ASK_LATENCY_2026-09-20.md.
 *
 * Same failure semantics as before: a customer-scope lookup failure falls
 * back to an unscoped search (not an error); a search failure returns empty
 * results (the same "nothing matched" the honest no-answer path already
 * handles) rather than a 500.
 */
// EMPTY_RETRIEVAL: the shared "nothing here" return shape, extended with the
// cache bookkeeping fields (questionHash/corpusStamp) every caller destructures
// regardless of which branch produced it.
const EMPTY_RETRIEVAL = { passages: [], extractions: [], cacheHit: false, cachedAnswer: null, questionHash: null, corpusStamp: null };

function retrieveEvidence(ctxArg, question, customerNumber, timer, { today, questionHash, noCache = false }) {
  return timer.time("retrieve", async () => {
    try {
      return await withTenant(ctxArg, async (db) => {
        let documentIdsFilter = null;
        if (customerNumber) {
          const scopeStart = Date.now();
          try {
            const resolved = await resolveCustomerDocumentIds(db, customerNumber);
            documentIdsFilter = resolved.documentIds; // null (unknown number) or a real (possibly empty) list
          } catch (err) {
            console.error("Customer-number scoping failed, answering unscoped:", err?.message);
          } finally {
            timer.add("scope", Date.now() - scopeStart);
          }
        }

        // ---- answer cache (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md) -----
        // Stamp + cache row in the SAME round trip as each other (see
        // askCache.js's COMBINED_SQL), inside this same withTenant
        // transaction — no extra connection just to check the cache.
        let corpusStamp = null;
        let cachedAnswer = null;
        await timer.time("cache", async () => {
          if (noCache) return; // scorecard calls always run the live pipeline
          try {
            const entry = await getCacheEntry(db, { questionHash, today });
            corpusStamp = entry.corpusStamp;
            if (isCacheHit(entry.row, entry.corpusStamp)) cachedAnswer = entry.row.answer;
          } catch (err) {
            console.error("Ask cache lookup failed, answering without cache:", err?.message);
          }
        });
        if (cachedAnswer) {
          return { passages: [], extractions: [], cacheHit: true, cachedAnswer, questionHash, corpusStamp };
        }

        // ---- semantic cache (R11 item 2): only tried on an EXACT-cache miss, using the SAME
        // corpusStamp the exact-cache probe just computed above (never a second, independent stamp).
        // Fails open (any error -> treated as a miss, retrieval/model runs exactly as before).
        if (!noCache) {
          try {
            const semantic = await lookupSemantic(db, { question, corpusStamp });
            if (semantic.hit) {
              return { passages: [], extractions: [], cacheHit: true, cachedAnswer: semantic.answer, questionHash, corpusStamp };
            }
          } catch (err) {
            console.error("Semantic cache lookup failed, answering without it:", err?.message);
          }
        }

        const [passages, extractions] = await Promise.all([
          db.searchPassages(question, MAX_PASSAGES, { documentIds: documentIdsFilter }),
          db.searchExtractions(question, 25, { documentIds: documentIdsFilter }),
        ]);
        return { passages, extractions, cacheHit: false, cachedAnswer: null, questionHash, corpusStamp };
      });
    } catch (err) {
      // A retrieval failure must not take the endpoint down. It also must
      // NOT be papered over with a second, untrustworthy evidence source —
      // see the file header. Log it and fall through to the same honest
      // no-answer that "nothing matched" gets: a customer can't act any
      // differently on the difference between "we found nothing" and "we
      // couldn't check", and guessing is worse than either.
      console.error("Retrieval failed:", err?.message);
      return EMPTY_RETRIEVAL;
    }
  });
}

/**
 * R31 (speed): tenant vocabulary with a short "recently verified" window on top of getTenantVocab's own
 * data-version cache. getTenantVocab re-runs its data-version probe (a count + max(updated_at) over entities)
 * on every call, and this call site wrapped that probe in a full withTenant transaction (connect + BEGIN +
 * SET LOCAL + probe + COMMIT) for EVERY question, even though the vocabulary it guards only widens typo
 * correction. Within DONOVAN_VOCAB_FRESH_MS (default 15 s; 0 disables) of a successful verify the cached
 * vocabulary is returned with no database work; after that the normal version-keyed check runs again, so a
 * customer/unit added by an upload is picked up within one window. Keyed per tenant; bounded.
 */
const VOCAB_FRESH_MS = (() => { const n = Number(process.env.DONOVAN_VOCAB_FRESH_MS); return Number.isFinite(n) && n >= 0 ? n : 15_000; })();
const VOCAB_FRESH_MAX = 500;
const vocabFresh = new Map(); // tenantKey -> { vocab, at }
async function getTenantVocabFresh(ctxArg, tenantKey, pack) {
  const now = Date.now();
  const hit = VOCAB_FRESH_MS > 0 ? vocabFresh.get(tenantKey) : null;
  if (hit && now - hit.at < VOCAB_FRESH_MS) return hit.vocab;
  const vocab = await withTenant(ctxArg, (db) => getTenantVocab(db, tenantKey, pack));
  if (VOCAB_FRESH_MS > 0 && vocab) {
    if (vocabFresh.size >= VOCAB_FRESH_MAX) vocabFresh.delete(vocabFresh.keys().next().value);
    vocabFresh.set(tenantKey, { vocab, at: Date.now() });
  }
  return vocab;
}
/** Test-only: forget every "recently verified" tenant vocabulary. */
export function _resetTenantVocabFresh() { vocabFresh.clear(); }

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Server-Timing + the ASK_DEBUG_TIMINGS escape hatch (both handoffs/
  // ASK_LATENCY_2026-09-20.md) — ms only, no PII, no question text.
  const timer = startTimer();

  // ---- streaming UX (build spec item 4, 2026-09-25) --------------------------------------------------
  // Opt-in only (`{stream: true}` in the request body): a non-streaming caller (an API key integration,
  // the scorecard runner) gets EXACTLY today's single JSON response — nothing below changes their
  // contract. When it IS requested, `startStreaming()` (called once, from inside tryAgent below, right
  // before the research agent actually runs) switches the response to newline-delimited JSON: zero or
  // more `{"type":"step","message":"..."}` progress lines, one final `{"type":"final",...}` line carrying
  // exactly the same `success`/`data`/`error` shape `send()` would otherwise have returned as the whole
  // body. A question the deterministic fast layer answers never streams at all (send() is called before
  // streaming is ever started), so the vast majority of asks are completely unaffected.
  let streaming = false;
  const startStreaming = () => {
    if (streaming || res.headersSent) return false;
    try {
      handleCors(res, req);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.writeHead(200);
      streaming = true;
    } catch (err) {
      console.error("ask: failed to start streaming, falling back to a single JSON response:", err?.message);
    }
    return streaming;
  };
  // R14 integration fix: `todayResolved` is declared inside the try block below, invisible to this closure —
  // every call threw a ReferenceError and the claim check was silently skipped on EVERY answer.
  let claimsToday = null;
  // R34: the question as typed, so send() can refuse an answer about a DIFFERENT address than the one asked about (addressConflict.js).
  let askedText = null;
  // Round 29: set when the question looked like an app how-to that the strict help route did not answer; a no-answer
  // result then carries `helpHint` so the UI can point to the DeepWell Help chat instead of a bare "not in your records".
  let helpHint = false;
  // R32: a technician-name typo silently corrected in the question text below is announced on the answer ("Showing results for ...").
  let techTypoNote = null;
  // R39: a misspelled manufacturer the normalizer fixed; announced ONLY on an answer whose text, basis or fact labels name the corrected manufacturer (i.e. whose lane applied that filter)
  let brandTypoNote = null;
  // R31 3b: this tenant's replaced-document map (api/_lib/supersession.js), loaded once per ask after auth; null until then.
  let supersededMap = null;
  const recordsFirstOn = () => !/^(?:0|false|off|no)$/i.test(String(process.env.DONOVAN_RECORDS_FIRST ?? "1").trim());
  const send = (status, body) => {
    // R2: an answer with no text and no cards is never sent (a clear decline instead)
    if (body?.success && body.data && typeof body.data === "object" && (body.data.kind === "answer" || body.data.kind === "no-answer") && !String(body.data.text ?? "").trim() && !(Array.isArray(body.data.facts) && body.data.facts.length)) {
      body = { ...body, data: { ...body.data, kind: "no-answer", text: "I couldn't find an answer to that in your records. Try naming the customer, the document or an amount.", facts: [], sources: body.data.sources ?? [], confidence: 0 } };
    }
    if (askedText && body?.data && typeof body.data === "object" && body.data.kind === "answer") {
      try {
        const typeNote = unverifiedTypeNote(askedText, body.data);
        if (typeNote) body.data.text = `${body.data.text} ${typeNote}`;
      } catch (err) { console.error("type-premise note failed, sending answer as computed:", err?.message); }
      try {
        const conflict = answerAddressConflict(askedText, body.data);
        if (conflict?.soft) {
          // A loosely typed city/zip never blocks the answer (the exam relies on that), but it is never silently ignored either.
          // R35: short wording — "(Note: on file in Phoenix, not Mesa.)"
          const note = softConflictNote(conflict);
          if (note) body.data.text = `${body.data.text} ${note}`;
        } else if (conflict) {
          body = { ...body, data: attachCitations(
            { kind: "no-answer", text: `Nothing on file for ${conflict.asked}. The closest address on file is ${conflict.closest}, which is a different ${conflict.kind === "city" ? "city" : conflict.kind === "zip" ? "zip code" : conflict.kind === "unit" ? "unit" : conflict.kind === "suffix" ? "street type" : "side of the street"}.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], addressMiss: true },
            { records: [], total: 0, kind: "searched", basis: `Searched every customer service address for ${conflict.asked}; only a different ${conflict.kind} of the same street number is on file.` }
          ) };
        }
      } catch (err) { console.error("address conflict check failed, sending answer as computed:", err?.message); }
    }
    if (techTypoNote && body?.data && typeof body.data === "object" && body.data.kind === "answer") decorateWithTypoNote(body.data, techTypoNote);
    else if (brandTypoNote && body?.data && typeof body.data === "object" && body.data.kind === "answer" && typeof body.data.text === "string" && [body.data.text, body.data.basis, ...(Array.isArray(body.data.facts) ? body.data.facts.map((f) => f?.label) : [])].some((t) => typeof t === "string" && t.toLowerCase().includes(brandTypoNote.resolved.toLowerCase()))) decorateWithTypoNote(body.data, brandTypoNote);
    // R35 brevity: a list sentence that repeats every fact row keeps only its first few names (router/brevity.js).
    if (body?.data && typeof body.data === "object") { try { capInlineNameList(body.data); } catch { /* never block an answer on brevity */ } }
    if (helpHint && body?.data && typeof body.data === "object" && body.data.kind === "no-answer" && !body.data.help) body.data.helpHint = true;
    // TEAM C: last-resort guarantee that EVERY answer carries the citation contract (idempotent; mutates in place
    // so the answer cache stores it too). Producers attach richer records/basis earlier; this only fills gaps.
    if (body?.data && typeof body.data === "object") {
      if (body.data.claimCheck == null) {
        try { checkAnswerClaimsSync(body.data, { today: claimsToday ?? new Date().toISOString().slice(0, 10) }); } catch (err) { console.error("checkAnswerClaimsSync failed, sending answer without it:", err?.message); }
      }
      if (supersededMap) { try { annotateSuperseded(body.data, supersededMap); } catch (err) { console.error("annotateSuperseded failed, sending answer without it:", err?.message); } }
      try { finalizeCitations(body.data); } catch (err) { console.error("finalizeCitations failed, sending answer without it:", err?.message); }
      // R13H1: sentence-level citations (api/_lib/citations/sentences.js) — additive `data.sentences`,
      // independent of the claimCheck guard above so an answer that already carried its own claimCheck
      // (the agent path) still gets it here unless attachSentenceCitations already ran with real source
      // text (see that module's header for the richer, DB-backed hook loopV2.js can add). Sync, no DB:
      // attribution (documentId/page) only, never a quote — safe to call unconditionally on every answer.
      if (body.data.sentences == null) {
        try { attachSentenceCitationsSync(body.data); } catch (err) { console.error("attachSentenceCitationsSync failed, sending answer without it:", err?.message); }
      }
    }
    // RECORDS-R1 item 6: which of the three produced this answer (records, model, decline). The marker never leaves the server; the trace is for operators / scorecard calls only.
    if (body?.data && typeof body.data === "object" && (body.data.kind === "answer" || body.data.kind === "no-answer")) {
      try {
        const fromLane = body.data.recordsLane === true; delete body.data.recordsLane;
        const modelCalls = currentUsageMeter()?.calls ?? 0;
        const lane = body.data.kind === "no-answer" ? "decline" : (modelCalls > 0 || ["model", "analytics-model", "agent"].includes(body.data.source)) ? "model" : "records";
        const laneDetail = fromLane ? "records-lane" : lane === "records" ? "records-rules" : lane === "decline" ? (modelCalls > 0 ? "decline-after-model" : "decline") : "model";
        console.log(JSON.stringify({ route: "ask", answer_lane: lane, detail: laneDetail }));
        if (scorecardCall || (req.body?.debug === true && auth && isPlatformOperator(auth))) body.data.debug = { ...(body.data.debug && typeof body.data.debug === "object" ? body.data.debug : {}), lane, laneDetail };
      } catch { /* the trace never blocks an answer */ }
    }
    if (body?.data && typeof body.data === "object") { try { neutralizeMarkup(body.data); } catch { /* never block an answer on hygiene */ } }
    if (streaming) {
      try {
        const line = status < 400
          ? { type: "final", success: true, data: body.data }
          : { type: "final", success: false, error: body.error, ...(body.url ? { url: body.url } : {}) };
        res.write(`${JSON.stringify(line)}\n`);
      } catch (err) {
        console.error("ask: failed to write final streaming event:", err?.message);
      }
      try { res.end(); } catch { /* the client may already be gone */ }
      return res;
    }
    const header = formatServerTiming(timer.snapshot());
    if (header && !res.headersSent) res.setHeader("Server-Timing", header);
    if (process.env.ASK_DEBUG_TIMINGS === "1" && body?.data && typeof body.data === "object") {
      body.data.timingsMs = timer.snapshot();
    }
    return handleCors(res, req).status(status).json(body);
  };

  // Scorecard call (hook.js): null for every real request. When set it supplies the auth, skips the rate
  // limiter / billing gate, never counts against the monthly allowance and never touches the answer cache.
  const scorecardCall = takeScorecardCall(req);
  // maxDuration is 300s: answer 504 (honest message) at 290s instead of being hard-killed with no response.
  // Not for in-process scorecard calls (mock res, long-lived caller).
  if (!scorecardCall) armResponseDeadline(res, 290_000);
  const incrementAsksThisMonth = scorecardCall ? async () => {} : incrementAsksThisMonthRaw;
  const ASK_CACHE_ENABLED = ASK_CACHE_ENABLED_RAW && !scorecardCall;
  // Non-streaming clients (an API key integration, the scorecard runner) never set this — see the
  // streaming block's own comment above for exactly what changes when they do.
  const wantStream = !scorecardCall && req.body?.stream === true;

  let auth;
  try {
    auth = scorecardCall
      ? scorecardCall.auth
      : await timer.time("auth", async () => {
          const a = await requireAuthOrKey(req);
          assertScope(a, "ask");
          return a;
        });
  } catch (err) {
    return denyAuth(res, err);
  }

  // The single most rate-limit-relevant route in the codebase: every call is
  // a model call. 429 is already written when this returns false.
  if (!scorecardCall && !(await timer.time("limit", () => limit(req, res, auth, "ask")))) return;

  try {
    let { question, today, conversationContext } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }
    if (question.length > MAX_QUESTION) {
      return res.status(400).json({ error: "Question is too long" });
    }
    // R34: fold fullwidth/compatibility forms, drop invisible/bidi/control characters and lone surrogates before ANY router sees the text.
    question = normalizeInputText(question);
    if (!question) return res.status(400).json({ error: "Missing question" });
    askedText = question;
    if (rephraseEnabled()) { const rp = normalizeRephrase(question); if (rp) question = rp; } // FORGE: same question, different wording -> same answer (plural before an id, role words, "invoice X in total", status-word typos)
    if (rephraseEnabled()) { // FORGE: a status-word typo is only fixed when no name in THIS org's data contains it (a customer called "Verdue Plumbing" stays itself); if the check fails, no rewrite
      const fx = typoFixes(question);
      if (fx.length) {
        try {
          const terms = fx.map((f) => `\\m${f.from.replace(/[^A-Za-z]/g, "")}\\M`);
          const clash = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (db) => {
            const a = await db.raw(`SELECT 1 FROM entities WHERE merged_into IS NULL AND data::text ~* ANY($1::text[]) LIMIT 1`, [terms]);
            if (a.rows.length) return true;
            if (!(await (await import("./_lib/financials/store.js")).financialsTableExists(db))) return false;
            const b = await db.raw(`SELECT 1 FROM document_financials WHERE coalesce(customer_name,'') || ' ' || coalesce(vendor_name,'') ~* ANY($1::text[]) LIMIT 1`, [terms]);
            return b.rows.length > 0;
          });
          if (!clash) question = applyTypoFixes(question, fx);
        } catch (e) { if (process.env.FORGE_DEBUG) process.stderr.write("typo-check: " + e.message + "\n"); /* cannot confirm: leave the words exactly as typed */ }
      }
    }
    { const rw = rewriteInvoiceTotal(question); if (rw) question = rw; } // "total of invoices in 2012" -> dollar total (kill switch DONOVAN_AMOUNT_NOHOW=0)

    // ---- Round 29: how-to questions about the app itself ("how do I invite a tech", "where is billing") -------
    // Answered from the signed-in DeepWell Help KB at $0, labelled "From DeepWell Help: <article>". Two layers keep
    // records questions out: a cheap regex gate (how-to shape + app vocabulary + no serial/address/person/date/
    // "who did"/"how many jobs" signal) and, only when it passes, a strict FAQ match (lazy-imported). Anything else,
    // including every scorecard question and every API-key call, continues to the normal pipeline untouched.
    if ((!scorecardCall || process.env.ASK_HELPGATE_IN_SCORECARD === "1") && !auth.viaKey && helpGate(question)) { // ASK_HELPGATE_IN_SCORECARD=1 is test-only: runs the help gate in the offline harness
      helpHint = true;
      try {
        const help = await answerHowTo(question);
        if (help) {
          console.log(JSON.stringify({ route: "ask", help_route: true, help_entry: help.help.entry }));
          return send(200, { success: true, data: help });
        }
      } catch (err) {
        console.error("ask: help route failed, continuing with the normal pipeline:", err?.message);
      }
    }

    // TEAM T2: fold a real follow-up into a self-contained question (see the
    // import above) — never throws, never blocks the question on a malformed
    // context, and re-checks the length cap since the composed text is longer.
    // FORGE: a context with no usable turns is no conversation; one whose turns resolved no entity cannot answer "this customer"
    let contextHasEntity = false;
    if (conversationContext) {
      try {
        const cv = validateConversationContext(conversationContext);
        if (!cv.turns.length) conversationContext = undefined; else contextHasEntity = cv.turns.some((t) => t.resolvedEntities && (Array.isArray(t.resolvedEntities) ? t.resolvedEntities.length : Object.keys(t.resolvedEntities).length));
      } catch { conversationContext = undefined; }
    }
    if (conversationContext) {
      try {
        const convo = validateConversationContext(conversationContext);
        if (convo.turns.length && isFollowupContinuation(question, convo)) {
          const composed = composeFollowup(convo, question).query;
          if (composed && composed.length <= MAX_QUESTION) question = composed;
        }
      } catch { /* not a followup — the question is asked exactly as typed */ }
    }

    // R32 (Team M): greetings / thanks / keyboard mash / unmistakably off-topic text is answered with a canned honest
    // no-answer here, at $0, instead of falling through retrieval to the Sonnet agent. Conservative (see nonQuestion.js:
    // any digit or records vocabulary vetoes it); scorecard calls are exempt; ASK_NONQUESTION_GATE=0 turns it off.
    if (!scorecardCall && isNonQuestionGateEnabled()) {
      const nq = classifyNonQuestion(question);
      if (nq) {
        console.log(JSON.stringify({ route: "ask", non_question: nq.kind }));
        return send(200, { success: true, data: attachCitations(nonQuestionAnswer(nq), { records: [], total: 0, basis: "This isn't a question about your records, so nothing was searched." }) });
      }
    }

    // R34: injection / sensitive-identifier / forecast / impossible-date questions are declined here at $0, for every caller
    // (scorecard included), before any router can answer them with a confident wrong number. See router/safetyGate.js.
    {
      const safety = classifySafety(question);
      if (safety) {
        console.log(JSON.stringify({ route: "ask", safety_gate: safety.kind }));
        return send(200, { success: true, data: buildSafetyAnswer(safety) });
      }
    }

    const ctxArg = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
    const meta0 = classifyMetaQuestion(question);
    const meta = meta0 && meta0.kind === 'count' && amountMentioned(question) ? null : meta0; // R40: a count of ALL invoices is never the answer to a question that named an amount
    if (!meta && earlyDeclineEnabled()) {
      const early = classifyEarlyDecline(question, { hasConversation: !!conversationContext, contextHasEntity });
      let vetoed = false;
      if (early?.kind === "off_domain") { try { vetoed = await withTenant(ctxArg, async (db) => (await triggerMatchesCustomerName(db, early.trigger)) || (await questionNamesEntity(db, question))); } catch { vetoed = false; } }
      if (early && !vetoed) return send(200, { success: true, data: buildEarlyDeclineAnswer(early.kind, early) });
    }
    // Never throws (see getActiveOverlay's own doc comment) — safe to await
    // directly with no try/catch here.
    // TEAM H (2026-09-24): the tenant's OWN learned vocabulary (per-tenant
    // autopilot's vocab mining, donovan_learned_tenant) merged in on top of
    // the global overlay — falls back to exactly getActiveOverlay()'s result
    // when this tenant has nothing learned yet (see that function's own doc
    // comment), so this is a no-op for every tenant until autopilot has
    // actually promoted something for it.
    const overlay = await timer.time("overlay", () => getActiveOverlayForTenant(ctxArg));
    // Team G (industry packs): resolved once per request, cached ~10min per
    // tenant inside packForTenant itself (a cache hit is a Map lookup, not a
    // query) — needed here, before the content-count pre-router below, so a
    // plumbing/electrical/property tenant's own vocabulary ("water heater",
    // "tankless", "panel", "unit turn", ...) is recognized instead of only
    // HVAC's. Never throws (packForTenant degrades to the hvac pack on any
    // failure) — safe to await directly with no try/catch here.
    const pack = await timer.time("pack", () => packForTenant({ withTenant, ctxArg }));

    // ---- tenant vocabulary (Round 11, literature #6/#7) --------------------
    // This tenant's own brands/models/technicians/customers actually on file (vocab/tenantVocab.js),
    // cached per tenant by a cheap data-version key (rebuilt only when this tenant's own rows actually
    // changed, never on a blind timer alone). Widens normalizeQuestionForAnalytics's fuzzy-typo
    // correction beyond the generic/pack vocabulary (below) and, for a genuine technician/customer NAME
    // typo right before "'s jobs/units/..." or after "did/was/is" (a shape the general vocabulary
    // correction never touches — see nlNormalize.js's own singleRecord guard), corrects it here the same
    // conservative, unambiguous-winner-only way streetVocab.js already corrects a street name. Never
    // throws — a probe failure degrades to no tenant vocab at all, same behavior as before this existed.
    let tenantVocab = null;
    try {
      tenantVocab = await timer.time("tenantvocab", () => getTenantVocabFresh(ctxArg, auth.tenantId, pack));
    } catch (err) {
      console.error("Tenant vocab lookup failed, using generic vocabulary only:", err?.message);
    }
    // R31 3b: which cited documents have since been replaced (memoized 15 s per tenant; never throws).
    supersededMap = await timer.time("superseded", () => getSupersessionMap({ withTenant, ctxArg, tenantKey: auth.tenantId }));
    if (!meta && tenantVocab) {
      try {
        const { corrected, corrections } = correctTenantNameTypos(question, tenantVocab);
        if (corrections.length) {
          // Round 22 (S2, privacy): `corrections` used to log the raw {from,to} word pairs — often a
          // customer surname or a mistyped tenant-vocab entry — straight into the route log. Only the
          // count and a hash pair (for grep-correlating a repeated bad correction) leave the process now.
          console.log(JSON.stringify({
            route: "ask",
            tenant_name_corrections: corrections.length,
            tenant_name_correction_hashes: corrections.map((c) => ({ from: hashForLog(c.from), to: hashForLog(c.to) })),
          }));
          question = corrected;
          const techFix = corrections.find((c) => c.category === "technician");
          if (techFix) techTypoNote = techNoteFromCorrection(techFix, tenantVocab?.technicians?.phrases);
        }
      } catch (err) {
        console.error("Tenant name-typo correction failed, using original question:", err?.message);
      }
    }
    // R39: a misspelled MANUFACTURER the question normalizer fixed ("Trnae" -> "Trane") is announced like any other typo correction, so the count is never silently for a different word.
    if (!meta && tenantVocab && !techTypoNote) {
      try {
        const brands = (tenantVocab.brands ?? []).map((b) => String(b));
        const fix = normalizeQuestionForAnalytics(question).corrections.find((c) => c.from !== c.to && brands.some((b) => b.toLowerCase() === String(c.to).toLowerCase()));
        // only inside a manufacturer slot, at edit distance 1, with exactly one manufacturer that close: never for a person's name ("customers named Carrie")
        const fromWord = fix ? String(fix.from).replace(/[^a-z0-9]/gi, "").toLowerCase() : "";
        const slotCue = fix ? new RegExp(`\\b(?:named|called|name|mr|mrs|ms|miss|dr|by|for|from|with)\\s+${fromWord}\\b`, "i").test(question) && !new RegExp(`\\b(?:made|manufactured|built|produced)\\s+by\\s+${fromWord}\\b`, "i").test(question) : false;
        const dl1 = (a, b) => { if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false; let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; const A = a.slice(i), B = b.slice(i);
          return A.slice(1) === B || A === B.slice(1) || A.slice(1) === B.slice(1) || (A.length >= 2 && B.length >= 2 && A[0] === B[1] && A[1] === B[0] && A.slice(2) === B.slice(2)); };
        const close = fix ? brands.filter((b) => dl1(fromWord, b.toLowerCase())) : [];
        if (fix && !slotCue && close.length === 1) {
          const typed = (question.match(new RegExp(`\\b${String(fix.from).replace(/[^a-z0-9]/gi, "")}\\b`, "i")) ?? [])[0] ?? fix.from;
          const resolved = brands.find((b) => b.toLowerCase() === String(fix.to).toLowerCase());
          brandTypoNote = { typed, resolved, text: `Reading "${typed}" as ${resolved}.` };
        }
      } catch (err) {
        console.error("Brand typo note failed:", err?.message);
      }
    }
    // RECORDS-FIRST: a name typed in lower case ("thomas mercer") is put back into the name's stored spelling before the older lanes read it, so wording and capital letters never change the answer.
    if (!meta && tenantVocab && recordsFirstOn()) {
      try {
        const { restoreNameCase, canonicalFactWords } = await import("./_lib/records/nameCase.js");
        const rc = restoreNameCase(question, tenantVocab);
        if (rc.restored) question = rc.question;
        question = canonicalFactWords(question);
      } catch (err) { console.error("Name-case restore failed, using original question:", err?.message); }
    }
    // R35 (owner decision 2026-10-01): a nickname ("Tom Mercer") resolves to the ONE person on file it can mean ("Thomas Mercer"),
    // announced on the answer like a typo correction. Ambiguous / no match: the question goes on exactly as typed (vocab/nicknames.js).
    if (!meta && tenantVocab && !techTypoNote) {
      try {
        const nick = resolveNicknameInQuestion(question, tenantVocab);
        if (nick) { question = nick.question; techTypoNote = nick.note; }
      } catch (err) {
        console.error("Nickname resolution failed, using original question:", err?.message);
      }
    }

    // A partial organization name ("Sunrise Valley Elementary") resolves to the one customer it can mean, or asks which (vocab/partialNames.js).
    if (!meta && tenantVocab && !techTypoNote) {
      try {
        const part = resolvePartialNameInQuestion(question, tenantVocab);
        if (part?.ambiguous) return send(200, { success: true, data: attachCitations(buildPartialNameClarify(part.ambiguous), { records: [], total: 0, kind: "searched", basis: "Matched the name you typed to more than one customer; none is picked." }) });
        if (part) { question = part.question; if (part.note) techTypoNote = part.note; }
      } catch (err) {
        console.error("Partial name resolution failed, using original question:", err?.message);
      }
    }

    // ---- street-name typo correction (live miss cluster 4, 2026-09-21) ----
    // "when was the unit at 766 n val ivsta dr, tucson installed" — the
    // ADDRESS SHAPE is fine (fastPath's own ADDRESS_RE needs only a number +
    // words + a street-suffix word), but the typo'd street NAME never
    // matches a real address token during DB resolution, so both fastPath
    // and the retrieval fallback come up empty. nlNormalize's own fuzzy
    // correction deliberately skips every word of a single-record question
    // (a general word list has no business rewriting an address) — this
    // corrects against the TENANT'S OWN street vocabulary instead (see
    // streetVocab.js), cached 10 minutes per tenant so this costs a real DB
    // round trip only on a cache miss, and only for a question that already
    // looks like a single-record reference (never for an aggregate/analytics
    // question — no address to correct there). Runs before fastPathIntent/
    // customerNumber/retrieval are computed so all three see the corrected
    // text; `question` is reassigned in place (let, not const) rather than
    // threading a second "effective question" variable through every
    // downstream call site.
    if (!meta && looksLikeSingleRecordReference(question)) {
      try {
        // R31: a warm in-process vocabulary answers without opening a transaction at all.
        const streetVocab = peekStreetVocab(auth.tenantId) ?? await timer.time("streetvocab", () =>
          withTenant(ctxArg, (db) => getStreetVocab(db, auth.tenantId))
        );
        const { corrected, corrections } = correctStreetTypos(question, streetVocab);
        if (corrections.length) {
          // Round 22 (S2, privacy): same reasoning as tenant_name_corrections above — a street-name
          // fragment is still part of a real customer's address; hash it, don't print it.
          console.log(JSON.stringify({
            route: "ask",
            street_typo_corrections: corrections.length,
            street_typo_correction_hashes: corrections.map((c) => ({ from: hashForLog(c.from), to: hashForLog(c.to) })),
          }));
          question = corrected;
        }
      } catch (err) {
        console.error("Street vocab correction failed, using original question:", err?.message);
      }
    }

    // ---- unified pre-router classification (Round 18, H3) ------------------
    // Every classifier from fast path through analytics — relations (0.35), the deterministic history
    // router (0.4), query decomposition (0.42), fast path (0.5), contact lookup (0.6), doc lookup
    // (0.62), content count (0.63), the money gate (0.65) and the analytics pre-router (0.7) — used to
    // be ~90 lines of scattered `const xIntent = !meta && ... ? classifyX(question) : null` right here,
    // each one's gate written out by hand. That's now api/_lib/router/classifyAll.js: ONE call that
    // runs every one of those pure classifiers, applies the exact same gating (PRECEDENCE_TABLE, with
    // each gate's reason documented there — see r16_d1_pipeline.json D1 #1/#3 for why computation-order
    // gating and TRIAL order are not the same thing here), and returns the same values these locals used
    // to hold, plus (D1 #10) every classifier's own raw claim + timing for logRouteDecision below.
    // loadAnalyticsRouteModule/loadAgentModule are THIS file's own memoized loaders (unchanged from
    // before this existed) — passed in so the analytics stage's lazy import happens at the exact same
    // point production always reached it, never earlier (verify-cold-start.mjs is unaffected).
    const preRouter = await classifyAll(question, { today: resolveToday(today), meta, overlay, pack, tenantVocab, loadAnalyticsRouteModule, loadAgentModule });
    const { normalizedForAnalytics, gated } = preRouter;
    if (preRouter.effectiveQuestion) question = preRouter.effectiveQuestion; // R31: conversational-frame-stripped text when it made a deterministic stage claim
    const relationsIntent = gated.relations;
    const detIntent = gated.deterministic;
    const decomposeIntent = gated.decompose;
    const fastPathIntent = gated.fastPath;
    const contactLookupIntent = gated.contactLookup;
    const docLookupIntent = gated.docLookup;
    const contentCountIntent = gated.contentCount;
    const moneyQuestion = gated.money;
    const analyticsCandidate = gated.analytics;
    // D1 #10: one structured line per request, BEFORE any pre-router branch runs — so a question a fast
    // branch fully answers (never reaching the agent) is now in the route log too, not only the ones
    // that fall all the way through to tryAgent's own call below (route/reasons there stay unchanged).
    logRouteDecision(question, {}, preRouter);
    const customerNumber = extractCustomerNumber(question);
    // R40: a question that names an invoice amount ("the invoice for 3470") is decided by the organization's own financial rows whose total equals it
    // (financials/amountInvoice.js). Claimed before every other lane (an address / count / fast-path lane must not read the number as something else).
    // R41U: one shared reading of the question (understanding/understand.js) feeds this lane too: "the bill for 3470 from a vendor", "who did we bill 3086.00", "the latest invoice from a customer".
    let understood = null;
    try { understood = understandQuestion(question, { today: resolveToday(today), rescueNames: tenantVocab?.customers?.phrases ?? null, conversation: (() => { try { return validateConversationContext(conversationContext).turns; } catch { return null; } })() }); } catch { understood = null; }
    const amountInvoiceIntent = (parseAmountInvoiceQuestion(question) || (understood && docLaneFromUnderstanding(understood, question))) ? true : false;
    // Resolved once, reused for both the answer cache key's `today` and the
    // question block the model sees (buildQuestionBlock, below) — was
    // computed twice (inconsistently) before the cache needed it up front.
    // R30 M9: `today` is client input that reaches cache keys, date math and the prompt. Arbitrary strings used to
    // pass straight through (random values also bypassed the answer cache = spend). Only a real, plausible
    // YYYY-MM-DD is accepted (the same helper the warranty routes use); anything else falls back to the server's
    // view of the shop's local date (R30 M10: TENANT_DEFAULT_TZ / America/Phoenix, not UTC).
    const todayResolved = resolveToday(today);
    claimsToday = todayResolved;
    // Cache key (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md): normalized so
    // near-identical phrasings ("What's the warranty?" / "whats the warranty")
    // share a cache entry — same normalization the meta-router already uses.
    const questionHash = hashQuestion(normalizeQuestion(question));

    // ---- Donovan agent fallback (DONOVAN_AGENT, default on) ----------------
    // Tried at most once per request, from three places below: an honest analytics fallback / an
    // unhandled analytics candidate, retrieval finding nothing, and the retrieval+model path
    // shaping a no-answer. Answers are cached under their own namespaced hash + prompt version
    // (never shared with retrieval or analytics rows) and count ONCE against the monthly allowance
    // (usage.js "agent"). Any agent error / timeout / no-answer returns false and the caller
    // continues with exactly today's behaviour. The operator-only `data.debug` trace needs both an
    // operator caller AND body.debug === true. Returns true iff it already sent the response.
    const requestStartedAt = Date.now();
    let agentTried = false;
    // Round 16 D1 #7 (cold start): agentOn/agentDebug/the v1-vs-v2 budget default used
    // to be computed unconditionally right here, forcing agent/loop.js (and loopV2.js's
    // isResearchAgentEnabled check, and hence @anthropic-ai/sdk) to load for EVERY
    // request, even ones a deterministic pre-router branch (meta/relations/deterministic/
    // decompose/fast-path/contact/doc-lookup/content-count/money) fully answers without
    // ever calling tryAgent(). Moved inside tryAgent's own body below (still resolved at
    // most once per request, via getAgentOn/getResearchV2Enabled's own module-level
    // memoization) so a request that never calls tryAgent() never loads either module.
    // R32: deterministic "clarify instead of model" (lookups/clarify.js): an on-topic question whose entities we recognise but no rule
    // answers gets 2-3 tap-able reformulations (the client fetches them through the existing didyoumean channel) instead of a model call.
    // RECORDS-FIRST (see api/_lib/records/lane.js). phase "early" = before the older lanes; "late" = after they declined (also covers facts the older lanes own when they are right).
    let _recordsLaneModule = null;
    const tryRecordsFirst = async (phase) => {
      if (meta || conversationContext || !question) return false;
      try {
        const mod = (_recordsLaneModule ??= await import("./_lib/records/lane.js"));
        if (!mod.recordsFirstEnabled()) return false;
        // RECORDS-R3C menu pick (DONOVAN_MENU_PICK, default OFF): a late-phase question about a resolvable subject whose wording named no readable fact may be read by ONE small
        // model call that only picks directory facts; the lane then answers from stored rows exactly as for a rule-matched question. Any failure = no pick = the path below as before.
        const pickMod = phase === "late" ? await import("./_lib/records/pick.js") : null;
        const pickWanted = Boolean(pickMod?.menuPickEnabled());
        let rr = await timer.time("records", () => withTenant(ctxArg, (db) => mod.runRecordsLane(db, question, { today: todayResolved, phase, pickWanted })));
        if (rr?.pickable) {
          let pick = null;
          try { await budgetPromise; pick = await (await import("./_lib/records/pickCall.js")).requestPick({ withTenant, ctxArg, question }); } catch { pick = null; }
          rr = await timer.time("records", () => withTenant(ctxArg, (db) => mod.runRecordsLane(db, question, { today: todayResolved, phase, pick, afterPick: true })));
        }
        if (!rr?.data) { if (rr?.skip) console.log(JSON.stringify({ route: "ask", records_skip: rr.skip, phase })); return false; }
        console.log(JSON.stringify({ route: "ask", records_first: rr.detail, phase }));
        send(200, { success: true, data: rr.data });
        await timer.time("bookkeeping", () =>
          withTenant(ctxArg, (db) => db.logAction({
            action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [...new Set((rr.data.sources ?? []).map((x) => x.documentId).filter(Boolean))], passages: 0, records_first: rr.detail },
          })).catch((err) => console.error("Failed to write document.queried audit row (records-first):", err?.message))
        );
        return true;
      } catch (err) {
        console.error("Records-first look-up failed, continuing with the older lanes:", err?.message);
        return false;
      }
    };
    const tryClarify = async () => {
      if (conversationContext) return false;
      try {
        const miss = await withTenant(ctxArg, (db) => buildAddressMissAnswer(db, question));
        if (miss) { send(200, { success: true, data: miss }); return true; }
      } catch { /* best-effort: fall through to the normal path */ }
      if (!clarifyEnabled() || !tenantVocab) return false; // a follow-up turn carries context the chips would drop
      const { routesWithoutModel } = await import("./_lib/suggest/classify.js"); // lazy: pulls the analytics route (-> @anthropic-ai/sdk), see clarify.js
      let knownAddress = false;
      const addr = ADDRESS_RE.exec(question)?.[0];
      if (addr) { try { knownAddress = (await withTenant(ctxArg, (db) => resolveAddressCandidates(db, addr))).length > 0; } catch { knownAddress = false; } }
      const clarify = buildClarifyAnswer(question, tenantVocab, { overlay, pack, tenantVocab, routesWithoutModel, knownAddress });
      if (!clarify) return false;
      send(200, { success: true, data: clarify });
      return true;
    };
    const tryAgent = async ({ extraUsage = null, budgetMs, recordMiss = true } = {}) => {
      if (agentTried) return false;
      if (await tryClarify()) return true;
      const agentOn = await getAgentOn();
      if (!agentOn) return false;
      agentTried = true;
      const agentDebug = Boolean(scorecardCall) || (req.body?.debug === true && isPlatformOperator(auth));
      const researchV2Enabled = await getResearchV2Enabled();
      // The research agent budgets up to ~240s of tool-use (loopV2.js); the v1 Haiku loop stays at its
      // original, much shorter default. Every explicit budgetMs below scales the same way.
      if (budgetMs === undefined) {
        budgetMs = researchV2Enabled ? Math.max(20_000, (Number(process.env.DONOVAN_AGENT_DEADLINE_MS) || 240_000) - 20_000) : 50_000; // must track vercel.json maxDuration (300 s on Pro)
      }
      const agentModule = await loadAgentModule();
      const researchAgentModule = researchV2Enabled ? await loadResearchAgentModule() : null;
      // Route-decision log (build spec item 1): counts only (route id + reason codes), never question
      // text — see router.js's own doc comment. Every call here already fell through the whole
      // deterministic fast layer (meta/detIntent/fastPath/contact/doc-lookup/content-count/money), so
      // this only records WHY, not whether, the research agent gets involved.
      logRouteDecision(question, { agent_version: researchV2Enabled ? "v2" : "v1" });
      // Streaming (build spec item 4): only for the research agent, and only once, from whichever of
      // this function's several call sites actually gets here first for this request.
      if (wantStream && researchV2Enabled) startStreaming();
      const onEvent = streaming
        ? (evt) => { try { res.write(`${JSON.stringify({ type: "step", ...evt })}\n`); } catch { /* client may be gone */ } }
        : undefined;
      const qHash = researchV2Enabled ? researchAgentModule.researchQuestionHash(question) : agentModule.agentQuestionHash(question);
      const promptVersion = `${researchV2Enabled ? researchAgentModule.RESEARCH_PROMPT_VERSION : agentModule.AGENT_PROMPT_VERSION}-r40`; // R40: -r40 drops every agent answer cached before the grounding gate
      let corpusStamp = null;
      let result = null;
      try {
        if (ASK_CACHE_ENABLED) {
          try {
            const probe = await withTenant(ctxArg, (db) => getCacheEntry(db, { questionHash: qHash, today: todayResolved, promptVersion }));
            corpusStamp = probe.corpusStamp;
            if (isCacheHit(probe.row, probe.corpusStamp)) {
              const cachedData = { ...probe.row.answer, cached: true };
              send(200, { success: true, data: cachedData });
              await timer.time("bookkeeping", async () => {
                try {
                  await withTenant(ctxArg, async (db) => {
                    await db.logAction({
                      action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                      changes: { question_hash: hashQuestion(question), documents: [...new Set((cachedData.sources ?? []).map((x) => x.documentId))], passages: 0, agent: true, cached: true },
                    });
                    if (extraUsage && isCountableAskSource("model")) await incrementAsksThisMonth(db);
                  });
                } catch (err) {
                  console.error("Agent cache-hit bookkeeping failed:", err?.message);
                }
                if (extraUsage) await recordModelCall(ctxArg, extraUsage).catch(() => {});
              });
              return true;
            }
          } catch (err) {
            console.error("Agent cache probe failed:", err?.message);
          }
        }
        // Exact-match recipe (an ACTIVE, approved/confirmed recipe for this very question): re-run its
        // SQL fresh through the same guard and answer from the rows - no model call. Anything that
        // differs falls through to the normal agent below.
        // Same-shaped question with a different city/brand/doc type (parametric recipe, workstream A).
        const recipe = findExactRecipe(overlay?.recipes, question) ?? matchParametricExamples(question, overlay?.recipes);
        if (recipe) {
          const { runRecipeFastPath } = await loadFastReplayModule();
          const fast = await timer.time("recipe", () => runRecipeFastPath({ withTenant, ctxArg, recipe, question, today: todayResolved }));
          if (fast.handled) result = fast;
        }
        if (!result) {
          const deadlineAt = Math.min(requestStartedAt + budgetMs, scorecardCall?.deadlineAt ?? Infinity);
          result = researchV2Enabled
            ? await timer.time("agent", () => researchAgentModule.runResearchAgent({ withTenant, ctxArg, question, today: todayResolved, overlay, deadlineAt, onEvent }))
            : await timer.time("agent", () => agentModule.runDonovanAgent({ withTenant, ctxArg, question, today: todayResolved, overlay, deadlineAt, escalate: scorecardCall?.escalate === true }));
        }
      } catch (err) {
        // Includes ModelBudgetExceededError: the standard fallback below decides what a
        // budget-exhausted tenant sees, exactly as it did before the agent existed.
        console.error("Donovan agent failed, using the standard fallback:", err?.name === "ModelBudgetExceededError" ? "model budget" : err?.message);
      }
      if (!result?.handled) {
        // recordMiss:false for the agent-first probe: retrieval still gets its turn, and whatever it
        // ends with is what gets logged as the miss (or not).
        if (recordMiss) recordAskMiss(ctxArg, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.AGENT_NO_ANSWER }).catch(() => {});
        return false;
      }
      const { _gate: gateCtx, ...dataNoCtx } = result.data ?? {}; // run context for the gate (documents retrieved when none is cited); never sent
      let data = result.data ? dataNoCtx : result.data;
      // R40 GROUNDING GATE on the agent's answer too (agent mode: aggregates over many documents stay legitimate; every id / name / address / date / quantity and every
      // single-document amount must be on the document its card cites). Fails closed.
      if (data?.kind === "answer" && process.env.DONOVAN_GROUNDING_GATE !== "0") {
        try {
          const ev = await withTenantRetry(ctxArg, async (db) => {
            const cited = [...(data.facts ?? []).flatMap((f) => (f.sources ?? []).map((s) => s.documentId)), ...(data.sources ?? []).map((s) => s.documentId)];
            const m = await loadGroundingEvidence(db, cited.length ? cited : (gateCtx?.docIds ?? []));
            await loadFinancialRows(db, m);
            return m;
          });
          data = applyGrounding(data, ev, { question, agent: true, today: todayResolved, agentRows: gateCtx?.rows === true });
        } catch (err) {
          console.error("grounding gate (agent) failed, withdrawing the answer:", err?.message);
          data = applyGrounding(data, new Map(), { question, agent: true, today: todayResolved, evidenceFailed: true });
        }
      }
      send(200, { success: true, data: agentDebug ? { ...data, debug: agentModule.agentDebugTrace(result) } : data });
      await timer.time("bookkeeping", async () => {
        try {
          await withTenantRetry(ctxArg, async (db) => {
            try {
              await db.logAction({
                action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                changes: { question_hash: hashQuestion(question), documents: [...new Set((data.sources ?? []).map((x) => x.documentId))], passages: 0, agent: true },
              });
            } catch (err) {
              console.error("Failed to write document.queried audit row (agent):", err?.message);
            }
            // A recipe replay made no model call: it never counts against the allowance.
            if (!result.fastReplay && isCountableAskSource("agent")) await incrementAsksThisMonth(db);
            if (ASK_CACHE_ENABLED && corpusStamp && shouldCache(data.kind, 0, 0)) {
              await db.raw("SAVEPOINT agent_cache_upsert", []);
              try {
                await upsertCacheEntry(db, { questionHash: qHash, corpusStamp, today: todayResolved, answer: data });
                await db.raw("RELEASE SAVEPOINT agent_cache_upsert", []);
              } catch (err) {
                console.error("Failed to upsert agent cache row:", err?.message);
                await db.raw("ROLLBACK TO SAVEPOINT agent_cache_upsert", []).catch(() => {});
              }
            }
          });
        } catch (err) {
          console.error("Agent bookkeeping transaction failed:", err?.message);
        }
        if (extraUsage) await recordModelCall(ctxArg, extraUsage).catch(() => {});
        // A fresh grounded agent answer teaches a recipe proposal (goes live only once confirmed:
        // same result twice, or an operator/thumbs-up approves it - learning/policy.js). Never throws.
        // A real model call already ran above, so loading replay.js's own transitive
        // agent/loop.js import here costs nothing extra (already cached, see loadAgentModule above).
        if (!result.fastReplay) {
          const replayModule = await loadReplayModule();
          await replayModule.submitRecipe({ ctxArg, question, run: result });
        }
      });
      return true;
    };

    // ---- overlap, not a chain (handoffs/ASK_LATENCY_2026-09-20.md) --------
    // Three independent reads that used to run one after another. `limit`
    // above stays first (it writes the 429 itself and must do so before
    // anything else responds); everything below it is safe to overlap:
    //   - assertModelBudget is a single already-combined round trip
    //     (getDailyModelBudgetStatus) on its own connection/pool. Fired now
    //     so its latency overlaps the gate check and retrieval instead of
    //     stacking after both — it is only actually CONSULTED (awaited)
    //     right before the model call below, exactly where it always was;
    //     starting it early changes nothing about when it's enforced. The
    //     `.catch` silences the "unhandled rejection" warning for a request
    //     that never reaches the model at all (blocked by billing, or
    //     answered by the meta-router) and therefore never awaits it again.
    //   - checkAskGate needs its own connection regardless.
    //   - retrieveEvidence needs its own connection regardless, and doesn't
    //     depend on the gate's answer — skipped here for a meta question,
    //     which answers from a single deterministic query instead; on the
    //     rare case the meta query itself fails, retrieval is (re)run
    //     inline below, same as the very first implementation.
    // Pool is max 5 (recordsStore.js) — cap this request at 2 concurrent
    // connections: gate→budget chained on one, retrieval on the other.
    const gatePromise = scorecardCall ? Promise.resolve({ allowed: true }) : timer.time("gate", () => checkAskGate(auth));
    const budgetPromise = gatePromise.then(() => timer.time("budget", () => assertModelBudget(ctxArg)));
    budgetPromise.catch(() => {});
    // Neither a meta question nor a fast-path candidate needs retrieval fired
    // early — both may answer without it. A fast-path candidate that turns out
    // to have no DB answer (ambiguous subject, no value on file) re-runs
    // retrieval inline below, same fallback shape as the meta-router's own.
    const retrievalPromise = meta || relationsIntent || detIntent || decomposeIntent || fastPathIntent || contactLookupIntent || docLookupIntent || contentCountIntent || moneyQuestion || analyticsCandidate || amountInvoiceIntent
      ? null
      : retrieveEvidence(ctxArg, question, customerNumber, timer, { today: todayResolved, questionHash, noCache: Boolean(scorecardCall) });

    const gate = await gatePromise;
    if (!gate.allowed) {
      if (retrievalPromise) await retrievalPromise; // don't leak an in-flight transaction on the way out
      return send(gate.status, { error: gate.error, url: gate.url, ...(gate.scope ? { scope: gate.scope } : {}) });
    }

    // RECORDS-R2: "invoice 20002 technician" names a document by its bare number, not an amount: the records lane gets the first look
    if (/\b(?:invoice|inv|bill|quote|estimate|ticket|work order|purchase order|po|wo)\s*(?:number|no|num|#|:)?\s*#?\s*\d{4,}\b/i.test(question) && await tryRecordsFirst("early")) return;

    if (amountInvoiceIntent) {
      const amountGate = await loadMoneyGateModule();
      const fin = await timer.time("financials", () => amountGate.answerAmountInvoiceQuestion({ withTenant, ctxArg, question, today: todayResolved, understanding: understood }));
      if (fin.handled) {
        send(200, { success: true, data: fin.data });
        await timer.time("bookkeeping", () =>
          withTenant(ctxArg, (db) => db.logAction({
            action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [...new Set((fin.data.sources ?? []).map((x) => x.documentId))], passages: 0, financials: fin.intent },
          })).catch((err) => console.error("Failed to write document.queried audit row (amount invoice):", err?.message))
        );
        return;
      }
    }

    if (!amountInvoiceIntent && /\binvoic\w*/i.test(question) && /\b(?:tech(?:nician)?s?|who (?:did|worked|handled|serviced|visited|installed))\b/i.test(question) && amountMentioned(question)) {
      // R40: a technician/who question that names an amount is not a count of every invoice (and not answerable by amount here)
      send(200, { success: true, data: { kind: "no-answer", text: "I can't tie a technician to an invoice by its dollar amount. Give me the invoice number or the customer's name and I'll look it up.", facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] } });
      return;
    }

    // ---- 0. meta-question pre-router (no model, no retrieval) --------------
    if (meta) {
      try {
        // Round 16 D1 #8: compute + bookkeeping used to be two separate
        // withTenant() round trips (BEGIN/SET LOCAL/COMMIT each) on the same
        // tenant; one transaction now does both — the audit row (and the
        // no-answer miss row) is written from the SAME connection right after
        // the answer is known, before it commits. A logAction/insertAskMiss
        // failure is still caught here exactly as before and never affects
        // the answer already computed in `data` (that document is returned
        // from JS memory, not re-read from the DB after this point) — see the
        // identical try/catch-inside-withTenant shape already used below for
        // the agent cache-hit and analytics bookkeeping blocks.
        const data = await timer.time("retrieve", () => withTenant(ctxArg, async (db) => {
          const result = await runMetaQuestion(db, meta);
          const bkStart = Date.now();
          try {
            await db.logAction({
              action: "document.queried",
              resource_type: "question",
              clerk_user_id: auth.userId,
              changes: {
                question_hash: hashQuestion(question),
                documents: [...new Set(result.sources.map((s) => s.documentId))],
                passages: 0,
              },
            });
            if (result.kind === "no-answer") {
              await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER });
            }
          } catch (err) {
            console.error("Failed to write document.queried audit row (meta):", err?.message);
          } finally {
            timer.add("bookkeeping", Date.now() - bkStart);
          }
          return result;
        }));
        return send(200, { success: true, data });
      } catch (err) {
        // A broken meta-query must not 500 a cheap question — fall through to
        // the normal retrieval+model path rather than failing the request.
        console.error("Meta-question router failed, falling through:", err?.message);
      }
    }

    // ---- 0.2 untracked-concept honest decline (Round 20 J1, no model, no DB) ----
    // "how many open warranty claims do we have right now" / "have we sent a renewal reminder on any of
    // the maintenance agreements" — a business concept this corpus's own schema never tracks at all (see
    // concepts/registry.js's own doc comment). Checked BEFORE every other deterministic router below —
    // several of them (the analytics fallback among them) have no notion of "claim"/"renewal reminder" as
    // their own vocabulary and, left unchecked, silently match the question to an unrelated count/yes-no
    // template instead (r19_blind3_clusters.json cluster F6). A tenant with no matching field ever
    // extracted (isTracked, concepts/registry.js) always gets this honest decline; a tenant whose pack DOES
    // track the concept (a future FIELD_SPECS/pack addition) never reaches this branch at all.
    if (!meta) {
      const untracked = detectUntrackedConcept(question, { pack });
      if (untracked) {
        console.log(JSON.stringify({ route: "ask", untracked_concept: untracked.id }));
        return send(200, { success: true, data: untrackedConceptAnswer(untracked) });
      }
    }

    // ---- 0.25 RECORDS-FIRST (DONOVAN_RECORDS_FIRST, default on; "0" turns it off): "<fact> for <customer | document number | unit | address>" is read straight from the stored
    // records (api/_lib/records/), each value cited to its page, no model. Returns false (and changes nothing) when no stored fact fits; the older lanes then run exactly as before. ----
    if (await tryRecordsFirst("early")) return;

    // ---- 0.35 relations engine (Round 7, no model, DB only) -----------------
    // Returns null (falls through) whenever a named condition can't be applied exactly.
    if (relationsIntent) {
      const relData = await timer.time("relations", () => answerRelationsQuestion({ withTenant, ctxArg, question, today: todayResolved }));
      console.log(JSON.stringify({ route: "ask", relations_family: relationsIntent.family, relations_hit: Boolean(relData) }));
      if (relData) return send(200, { success: true, data: relData });
    }

    // ---- 0.4 deterministic history router (Team A, no model, DB only) ------
    // "do we have more invoices or more service tickets", "who's overdue for maintenance", "when did we last service the
    // unit at <address>", "who installed the Mitsubishi at <address>", "last 3 visits at Zimmerman's": date arithmetic and
    // counts over the shop's own records, answered with a citation per fact (deterministicRouter.js). null = not
    // confident -> the normal chain (fast path, lookups, analytics, agent, retrieval) carries on unchanged.
    if (detIntent) {
      let detData = null;
      try {
        // Round 16 D1 #8: compute + the audit-log write share one withTenant
        // transaction (was two round trips) — see the meta-router above for
        // why a logAction failure here is still harmless and non-fatal.
        detData = await timer.time("deterministic", () =>
          withTenant(ctxArg, async (db) => {
            const result = await withCitations(db, runDeterministic(db, detIntent, { today: todayResolved })); // TEAM C
            if (result) {
              const bkStart = Date.now();
              try {
                await db.logAction({
                  action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                  changes: { question_hash: hashQuestion(question), documents: [...new Set((result.sources ?? []).map((x) => x.documentId))], passages: 0, deterministic: detIntent.route },
                });
              } catch (err) {
                console.error("Failed to write document.queried audit row (deterministic):", err?.message);
              } finally {
                timer.add("bookkeeping", Date.now() - bkStart);
              }
            }
            return result;
          })
        );
      } catch (err) {
        console.error("Deterministic router failed, falling through:", err?.message);
      }
      console.log(JSON.stringify({ route: "ask", det_route: detIntent.route, det_kind: detIntent.kind ?? null, det_hit: Boolean(detData) }));
      if (detData) {
        // a document-number look-up that could not read the wording ("I don't have that stored for Invoice ...") gets one late records-first try: the stored record of that document beats a decline
        if (detIntent.route === "docnumber" && detData.kind === "no-answer" && await tryRecordsFirst("late")) return;
        return send(200, { success: true, data: detData });
      }
    }

    // ---- 0.42 query decomposition (Round 11, no model, DB only) ------------
    // Multi-part/conjunctive questions ("Which Trane customers with no agreement had a callback this
    // year?", "customers in Mesa with units older than 10 years and no visit since 2024") and job
    // comparisons ("Compare invoices vs POs for the Rios job") — decompose/index.js. Only ever claims a
    // question when EVERY clause maps to a supported sub-query (classifyDecompose's own parse already
    // enforces this); a null return here means the chain carries on exactly as it always has.
    if (decomposeIntent) {
      let decData = null;
      try {
        // Round 16 D1 #8: one withTenant transaction for compute + audit log
        // (was two round trips) — see the meta-router above for why a
        // logAction failure here is harmless and non-fatal.
        decData = await timer.time("decompose", () => withTenant(ctxArg, async (db) => {
          const result = await runDecompose(db, decomposeIntent, { today: todayResolved });
          if (result) {
            const bkStart = Date.now();
            try {
              await db.logAction({
                action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                changes: { question_hash: hashQuestion(question), documents: [...new Set((result.sources ?? []).map((x) => x.documentId))], passages: 0, decompose: decomposeIntent.mode },
              });
            } catch (err) {
              console.error("Failed to write document.queried audit row (decompose):", err?.message);
            } finally {
              timer.add("bookkeeping", Date.now() - bkStart);
            }
          }
          return result;
        }));
      } catch (err) {
        console.error("Query decomposition failed, falling through:", err?.message);
      }
      console.log(JSON.stringify({ route: "ask", decompose_mode: decomposeIntent.mode, decompose_hit: Boolean(decData) }));
      // Round 20 (J1) precision guard: decompose's own clause vocabulary has no condition type that ever
      // scopes to one named customer/business (see guard/check.js's own doc comment) — a question naming
      // one that decompose still claims to have answered silently ignored it (r19_blind3_clusters.json F1,
      // "purchase order on file for the Amy Isaacson account" answered from an unscoped portfolio-wide
      // scan). Treated exactly like a null decompose result: falls through to the next stage below.
      if (decData) {
        const guard = guardDecomposeAnswer({ question, data: decData, intent: decomposeIntent, tenantVocab });
        if (guard.blocked) {
          console.log(JSON.stringify({ route: "ask", guard: "precision", stage: "decompose", blocked: true, reason: guard.reason, constraint: guard.constraintType }));
          decData = null;
        }
      }
      if (decData) {
        return send(200, { success: true, data: decData });
      }
    }

    // ---- 0.5 fast-path pre-router (no model, DB only) ----------------------
    // Distinct from the meta-router above: meta answers deterministic
    // inventory questions ("how many documents"); this answers a specific
    // field lookup ("what's the serial on the unit at 3247 Elm") straight from
    // `extractions`, with the same citation contract the model path enforces
    // (see fastPath.js buildFieldAnswer/buildWarrantyAnswer). Cheap to run and
    // cheap to be wrong about deciding NOT to answer, so it is tried whenever
    // classification found an intent, and any failure — DB error, ambiguous
    // subject, no value on file — falls through to retrieval+model rather than
    // ever guessing or 500ing. Not cached (see askCache.js's shouldCache — a
    // fast answer is already ~0.3s, caching it buys nothing) but still
    // audit-logged, same as every other answer this endpoint gives.
    if (fastPathIntent) {
      let fastData = null;
      try {
        // Round 16 D1 #8: one withTenant transaction for compute + audit log
        // (was two round trips) — see the meta-router above for why a
        // logAction failure here is harmless and non-fatal.
        fastData = await timer.time("fast", () =>
          withTenant(ctxArg, async (db) => {
            const result = await withCitations(db, runFastPath(db, fastPathIntent, { today: todayResolved })); // TEAM C
            if (result) {
              const bkStart = Date.now();
              try {
                await db.logAction({
                  action: "document.queried",
                  resource_type: "question",
                  clerk_user_id: auth.userId,
                  changes: {
                    question_hash: hashQuestion(question),
                    documents: [...new Set((result.sources ?? []).map((s) => s.documentId))],
                    passages: 0,
                    fast: true,
                  },
                });
              } catch (err) {
                console.error("Failed to write document.queried audit row (fast path):", err?.message);
              } finally {
                timer.add("bookkeeping", Date.now() - bkStart);
              }
            }
            return result;
          }) // TEAM C
        );
      } catch (err) {
        console.error("Fast path failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        fast_intent: fastPathIntent.intent,
        fast_hit: Boolean(fastData),
      }));
      if (fastData) {
        return send(200, { success: true, data: fastData, fast: true });
      }
      // fastData is null: DB found nothing certain enough. Retrieval was never
      // started above (retrievalPromise is null for a fast-path candidate), so
      // run it now, inline — identical fallback shape to the meta-router's own.
    }

    // ---- 0.6 contact-lookup pre-router (no model, DB only) -----------------
    // "what's the phone number on file for donna thornton" — answered
    // straight from the customer's own entity row (data->>'phone' etc.), no
    // document to cite, no model call — see contactLookup.js's own doc
    // comment. Never a model call: 'contact-lookup' is not in
    // usage.js's COUNTABLE_ASK_SOURCES, so nothing here ever touches
    // incrementAsksThisMonth.
    if (contactLookupIntent) {
      let contactData = null;
      try {
        // Round 16 D1 #8: one withTenant transaction for compute + audit log
        // (was two round trips) — see the meta-router above for why a
        // logAction/insertAskMiss failure here is harmless and non-fatal.
        contactData = await timer.time("contact", () =>
          withTenant(ctxArg, async (db) => {
            const result = await withCitations(db, runContactLookup(db, question, { overlay, today: todayResolved })); // TEAM C
            if (result) {
              const bkStart = Date.now();
              try {
                await db.logAction({
                  action: "document.queried",
                  resource_type: "question",
                  clerk_user_id: auth.userId,
                  changes: {
                    question_hash: hashQuestion(question),
                    documents: [],
                    passages: 0,
                    contactLookup: true,
                  },
                });
                // Miss loop: more than one customer matched the name — the
                // dispatcher got a "which one did you mean" instead of a value
                // (candidateCount, contactLookup.js's buildAmbiguousContactAnswer).
                if ((result.candidateCount ?? 1) > 1) {
                  await insertAskMiss(db, {
                    question, questionNormalized: normalizedForAnalytics,
                    outcome: MISS_OUTCOMES.CONTACT_AMBIGUOUS,
                  });
                }
              } catch (err) {
                console.error("Failed to write document.queried audit row (contact lookup):", err?.message);
              } finally {
                timer.add("bookkeeping", Date.now() - bkStart);
              }
            }
            return result;
          }) // TEAM C
        );
      } catch (err) {
        console.error("Contact lookup failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        contact_lookup_field: contactLookupIntent.field,
        contact_lookup_hit: Boolean(contactData),
      }));
      if (contactData) {
        return send(200, { success: true, data: contactData });
      }
      // contactData is null: no customer matched the name. Miss loop: zero
      // candidates is itself the miss worth reviewing, regardless of what
      // retrieval (run inline just below, same fallback shape as the
      // fast-path miss above) manages to answer instead — fired with no
      // await (true fire-and-forget: nothing else here is awaited yet
      // either), never delaying the retrieval fallback.
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.CONTACT_ZERO,
      }).catch(() => {});
    }

    // ---- 0.62 doc-lookup pre-router (no model, DB only) --------------------
    // "do we have a maintenance agreement on file for the Bracken job" —
    // answered straight from documents/document_entity_links, no model call.
    // Never counted against the monthly model allowance: 'doc-lookup' is not
    // in usage.js's COUNTABLE_ASK_SOURCES, so nothing here ever touches
    // incrementAsksThisMonth.
    if (docLookupIntent) {
      let docData = null;
      try {
        // Round 16 D1 #8: one withTenant transaction for compute + audit log
        // (was two round trips) — see the meta-router above for why a
        // logAction/insertAskMiss failure here is harmless and non-fatal.
        docData = await timer.time("doclookup", () =>
          withTenant(ctxArg, async (db) => {
            const result = await withCitations(db, runDocLookup(db, question, { overlay, today: todayResolved })); // TEAM C
            if (result) {
              const bkStart = Date.now();
              try {
                await db.logAction({
                  action: "document.queried",
                  resource_type: "question",
                  clerk_user_id: auth.userId,
                  changes: {
                    question_hash: hashQuestion(question),
                    documents: [...new Set((result.sources ?? []).map((s) => s.documentId))],
                    passages: 0,
                    docLookup: true,
                  },
                });
                if ((result.candidateCount ?? 1) > 1) {
                  await insertAskMiss(db, {
                    question, questionNormalized: normalizedForAnalytics,
                    outcome: MISS_OUTCOMES.CONTACT_AMBIGUOUS,
                  });
                }
              } catch (err) {
                console.error("Failed to write document.queried audit row (doc lookup):", err?.message);
              } finally {
                timer.add("bookkeeping", Date.now() - bkStart);
              }
            }
            return result;
          }) // TEAM C
        );
      } catch (err) {
        console.error("Doc lookup failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        doc_lookup_type: docLookupIntent.doctype,
        doc_lookup_hit: Boolean(docData),
      }));
      if (docData) {
        return send(200, { success: true, data: docData });
      }
      // docData is null: no customer/address matched, or matched but had no
      // document of that type on file — same fallback shape as contact
      // lookup's own miss above: retrieval (run inline just below) still gets
      // a shot, fire-and-forget miss logging never delays it.
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.DOC_LOOKUP_ZERO,
      }).catch(() => {});
    }

    // ---- 0.63 content-count pre-router (no model, DB only) -----------------
    // "how many jobs mention a capacitor" / "which customers had a coil issue on file" — a deterministic scan of
    // EVERY page of the tenant's own corpus (contentCount.js), never the agent's own top-K search_documents. Always
    // answers once the shape+term are recognized (even at zero matches: an honest "no jobs mention X" is itself the
    // answer), so this never falls through to retrieval the way contact/doc lookup do on a miss.
    if (contentCountIntent) {
      let contentData = null;
      try {
        // Round 16 D1 #8: one withTenant transaction for compute + audit log
        // (was two round trips) — see the meta-router above for why a
        // logAction failure here is harmless and non-fatal.
        contentData = await timer.time("contentcount", () => withTenant(ctxArg, async (db) => {
          const result = await runContentCount(db, contentCountIntent, pack);
          if (result) {
            const bkStart = Date.now();
            try {
              await db.logAction({
                action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                changes: { question_hash: hashQuestion(question), documents: (result.records ?? []).map((r) => r.documentId).filter(Boolean), passages: 0, contentCount: true },
              });
            } catch (err) {
              console.error("Failed to write document.queried audit row (content count):", err?.message);
            } finally {
              timer.add("bookkeeping", Date.now() - bkStart);
            }
          }
          return result;
        }));
      } catch (err) {
        console.error("Content-count router failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask", content_count_scope: contentCountIntent.scope, content_count_group_by: contentCountIntent.groupBy,
        content_count_hit: Boolean(contentData),
      }));
      if (contentData) {
        return send(200, { success: true, data: contentData });
      }
      // contentData is null only on an unexpected error above; retrieval (run inline just below) still gets a shot.
    }

    // ---- 0.64 unknown-name gate (R32b, no model): a record question about a name that exists nowhere in this tenant is an honest "not on file".
    if (!conversationContext && !moneyQuestion) {
      try {
        const unknown = await withTenant(ctxArg, async (db) => {
          const cc = parseCustomerCount(question);
          return (cc && (await runCustomerCount(db, cc))) || buildUnknownNameDecline(db, question);
        });
        if (unknown) return send(200, { success: true, data: unknown });
      } catch { /* best-effort: fall through to the normal path */ }
    }

    // ---- 0.64b R3 named-customer money lookups: runs only where another lane would have declined ("<name> - how much", "look up <name>", a flipped or misspelled name) ----
    const tryNamedMoney = async () => {
      if (!namedMoneyShape(question)) return false;
      try {
        const mg = await loadMoneyGateModule();
        const nf = await timer.time("financials", () => mg.answerNamedMoneyQuestion({ withTenant, ctxArg, question, today: todayResolved }));
        if (!nf.handled) return false;
        send(200, { success: true, data: nf.data });
        await timer.time("bookkeeping", () =>
          withTenant(ctxArg, (db) => db.logAction({ action: "document.queried", resource_type: "question", clerk_user_id: auth.userId, changes: { question_hash: hashQuestion(question), documents: [...new Set((nf.data.sources ?? []).map((x) => x.documentId))], passages: 0, financials: nf.intent } }))
            .catch((err) => console.error("Failed to write document.queried audit row (named money):", err?.message)));
        return true;
      } catch { return false; }
    };

    // ---- 0.65 money gate (no model, no DB, no cache) -----------------------
    // "What's the total dollar amount of our open invoices?" — the honest
    // "not built yet" answer, always, never a fabricated dollar figure. See
    // isMoneyQuestion/moneyFallbackAnswer (analytics.js) for why this can
    // never produce "$0.00 across N documents." again. Not cached (nothing
    // here should ever be served back stale once financials ships) and not
    // counted against the monthly model allowance (no model call was made).
    if (moneyQuestion) {
      const moneyGateModule = await loadMoneyGateModule();
      // FINANCIALS hook: when M3-config/22 exists AND this tenant has financial rows, answer from real data
      // (deterministic SQL first, then the Donovan agent over the `financials` view); otherwise `fin.hasData`
      // is false and everything below is exactly the old honest refusal.
      const fin = await timer.time("financials", () => moneyGateModule.answerMoneyQuestion({ withTenant, ctxArg, question, today: todayResolved }));
      if (fin.handled) {
        send(200, { success: true, data: fin.data });
        await timer.time("bookkeeping", () =>
          withTenant(ctxArg, (db) => db.logAction({
            action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [...new Set((fin.data.sources ?? []).map((x) => x.documentId))], passages: 0, financials: fin.intent },
          })).catch((err) => console.error("Failed to write document.queried audit row (financials):", err?.message))
        );
        return;
      }
      if (await tryNamedMoney()) return;
      if (await tryRecordsFirst("late")) return;
      if (fin.hasData && (await tryAgent())) return;
      const data = fin.hasData ? moneyGateModule.moneyNoMatchAnswer() : moneyFallbackAnswer();
      send(200, { success: true, data });
      await timer.time("bookkeeping", () =>
        withTenant(ctxArg, async (db) => {
          await db.logAction({
            action: "document.queried",
            resource_type: "question",
            clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [], passages: 0, money: true },
          });
          await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.MONEY_FALLBACK });
        }).catch((err) => console.error("Failed to write document.queried audit row (money):", err?.message))
      );
      return;
    }

    if (!moneyQuestion && (await tryNamedMoney())) return;
    if (await tryRecordsFirst("late")) return;

    // ---- 0.7 analytics pre-router (ONE Haiku tool-use call, before retrieval) --
    // "how many customers in Arizona", "list customers in Gilbert", "which
    // customers have Trane units" — counting/grouping/listing questions that
    // otherwise have no path (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md). The
    // model gets exactly one tool-use call with a strict, closed-vocabulary
    // schema (api/_lib/analytics.js's ANALYTICS_TOOL) and NEVER writes SQL or
    // free prose; the answer text itself is composed deterministically in code
    // from the query results, same "no second model call" contract the
    // meta-router and fast path both already keep. A plan the model returns
    // that doesn't fit the vocabulary, or that matches no data the executor
    // can act on, falls through to retrieval+model exactly like a fast-path
    // miss — see runAnalyticsQuestion's own doc comment.
    if (analyticsCandidate) {
      let analyticsResult = null;
      try {
        // The one real model call this branch can make must respect the same
        // daily spend budget the main retrieval+model path enforces — already
        // in flight (fired concurrently with the gate check above), just
        // consulted here instead of after retrieval.
        await budgetPromise;
        // analyticsCandidate can only be true once the analytics module was
        // already loaded above (loadAnalyticsRouteModule is memoized, so this
        // resolves instantly from cache — never a second import).
        const analyticsRouteModule = await loadAnalyticsRouteModule();
        // No `questionHash` passed through: runAnalyticsQuestion computes its
        // own namespaced hashes (api/_lib/analytics.js's analyticsQuestionHash/
        // analyticsPlanHash) so an analytics cache row can never collide with
        // — or be shadowed by — a retrieval-cached row for the same question
        // text (2026-09-21 reviewer fix, handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md).
        analyticsResult = await timer.time("analytics_plan", () =>
          analyticsRouteModule.runAnalyticsQuestion({ withTenant, ctxArg, question, today: todayResolved, overlay, tenantVocab, noCache: Boolean(scorecardCall) })
        );
      } catch (err) {
        // A tenant already over its daily model budget must not spend a
        // retrieval round trip finding that out a second time right below —
        // let the outer handler's own ModelBudgetExceededError branch answer
        // this exactly once, the same clean 429 the main model call gets.
        if (err?.name === "ModelBudgetExceededError") throw err;
        console.error("Analytics path failed, falling through to retrieval+model:", err?.message);
      }
      console.log(
        JSON.stringify({
          route: "ask",
          analytics_candidate: true,
          analytics_hit: Boolean(analyticsResult?.handled),
          analytics_cache_hit: Boolean(analyticsResult?.cacheHit),
        })
      );
      // Round 20 (J1) precision guard: routes/analytics.js's own plan (filters/timeRange/groupBy) is never
      // returned in `data`, so this checks only what the ANSWER itself can prove — a genuine honest
      // fallback (missOutcome set) is never touched, only a genuine "handled" count/value answer. Blocked
      // means treated exactly like `handled: false` below — same tryAgent-then-retrieval fallthrough a real
      // analytics miss already takes (r19_blind3_clusters.json F1: "so far this year"/"zero ... on file"/
      // "distinct document types"/"longer than 30 days"/"earliest ... date" silently answered from an
      // unfiltered portfolio total or a bare count where a date/distinct value was asked for).
      if (analyticsResult?.handled && !analyticsResult.missOutcome) {
        const guard = await guardAnalyticsAnswer({
          question,
          data: analyticsResult.data,
          tenantVocab,
          withTenant,
          ctxArg,
        });
        if (guard.blocked) {
          console.log(JSON.stringify({ route: "ask", guard: "precision", stage: "analytics", blocked: true, reason: guard.reason, constraint: guard.constraintType }));
          analyticsResult = { ...analyticsResult, handled: false };
        }
      }
      if (analyticsResult?.handled) {
        // An honest analytics fallback (maintenance / unsupported condition / cross-doc) gets one
        // shot at the agent first. The money gate is deliberately left alone (financials phase).
        if (analyticsResult.missOutcome && analyticsResult.missOutcome !== MISS_OUTCOMES.MONEY_FALLBACK && (await tryAgent())) return;
        const data = analyticsResult.cacheHit ? { ...analyticsResult.data, cached: true } : analyticsResult.data;
        // R7 guardrail item 2 ("yes/no shape"): applied to the OUTGOING response only, never to `data` itself —
        // `data` is also what the bookkeeping block below caches (Tier 1/Tier 2, routes/analytics.js), and a
        // "how many Ruud units" question can share a Tier-2 plan-hash row with "do we have any Ruud units";
        // only the second one wants the Yes/No lead-in, so the wrap must never be persisted into the shared
        // cache row itself. applyExistenceShape is a pure, idempotent string transform (see its own doc
        // comment), so computing it fresh on every response costs nothing. (Module already loaded above
        // to reach this branch at all; loadAnalyticsRouteModule's cache makes this a no-op re-fetch.)
        const { applyExistenceShape } = await loadAnalyticsRouteModule();
        send(200, { success: true, data: applyExistenceShape(data, question) });
        await timer.time("bookkeeping", async () => {
          try {
            await withTenantRetry(ctxArg, async (db) => {
              try {
                await db.logAction({
                  action: "document.queried",
                  resource_type: "question",
                  clerk_user_id: auth.userId,
                  changes: {
                    question_hash: hashQuestion(question),
                    documents: [],
                    passages: 0,
                    analytics: true,
                    cached: analyticsResult.cacheHit,
                  },
                });
              } catch (err) {
                console.error("Failed to write document.queried audit row (analytics):", err?.message);
              }
              // Miss loop: this "handled" answer is actually an honest
              // fallback (money/maintenance/"can't filter by X yet"), not a
              // real count/list — runAnalyticsQuestion (routes/analytics.js)
              // marks these with missOutcome; a genuine analytics answer
              // never sets it.
              if (analyticsResult.missOutcome) {
                await insertAskMiss(db, {
                  question, questionNormalized: normalizedForAnalytics,
                  outcome: analyticsResult.missOutcome,
                  detectedConditions: detectedConditions(normalizedForAnalytics),
                  plan: analyticsResult.missMeta?.plan ?? null,
                });
              }
              // Monthly ask allowance (owner decision, 2026-09-21): counts iff
              // the one Haiku planner call actually ran (modelCalled — see
              // routes/analytics.js's runAnalyticsQuestion doc comment). A
              // Tier-1 cache hit answers before that call is ever made, so
              // it's free, same as the retrieval+model path's own cache hit.
              if (isCountableAskSource(analyticsResult.modelCalled ? "analytics-model" : "analytics-cache")) {
                await incrementAsksThisMonth(db);
              }
              // Cache write — same corpus_stamp mechanism askCache.js already
              // gives the retrieval+model path (design point 3: "cache via
              // askCache with corpus_stamp"), but under analytics' OWN
              // namespaced hashes, never the shared `questionHash` above (see
              // runAnalyticsQuestion's doc comment). Two rows on a fresh
              // answer — Tier 1 (this exact question text) and Tier 2 (this
              // exact plan, reusable by a differently-worded question that
              // resolves to it) — a cache hit above already reused a prior
              // write, so `writes` is empty and this loop is a no-op.
              if (!analyticsResult.cacheHit && ASK_CACHE_ENABLED && shouldCache(data.kind, 0, 0)) {
                for (const w of analyticsResult.writes ?? []) {
                  if (!w.corpusStamp) continue;
                  await db.raw("SAVEPOINT analytics_cache_upsert", []);
                  try {
                    await upsertCacheEntry(db, {
                      questionHash: w.questionHash, corpusStamp: w.corpusStamp, today: todayResolved, answer: data,
                    });
                    await db.raw("RELEASE SAVEPOINT analytics_cache_upsert", []);
                  } catch (err) {
                    console.error("Failed to upsert analytics cache row:", err?.message);
                    await db.raw("ROLLBACK TO SAVEPOINT analytics_cache_upsert", []).catch(() => {});
                  }
                }
              }
            });
          } catch (err) {
            console.error("Analytics bookkeeping transaction failed:", err?.message);
          }
        });
        return;
      }
      // Not handled (invalid plan, no matching data, or an error): retrieval
      // was never started above (retrievalPromise is null for an analytics
      // candidate), so run it now, inline — identical fallback shape to the
      // fast-path miss above. Miss loop: this fallthrough is itself worth
      // reviewing regardless of what retrieval manages next — fired with no
      // await (nothing else here is awaited yet either), never delaying the
      // retrieval fallback.
      // "Analytics plan rejected" (live miss cluster): the agent gets a shot before retrieval.
      // v1: retrieval + model (35s) still follows on a miss, so this stays a small share of the old 60s
      // budget. v2 (streaming, up to maxDuration 300) can afford to give the research agent a full try here.
      if (await tryAgent({ budgetMs: (await getResearchV2Enabled()) ? 90_000 : 18_000 })) return;
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.ANALYTICS_FALLTHROUGH,
        detectedConditions: detectedConditions(normalizedForAnalytics),
      }).catch(() => {});
    }

    // ---- 1. retrieve (already in flight above unless meta, fast path, or analytics fell through) ---
    const { passages, extractions, cacheHit, cachedAnswer, corpusStamp } = retrievalPromise
      ? await retrievalPromise
      : await retrieveEvidence(ctxArg, question, customerNumber, timer, { today: todayResolved, questionHash, noCache: Boolean(scorecardCall) });

    // ---- cache hit: no retrieval was even needed above, no model call -----
    if (cacheHit) {
      const data = { ...cachedAnswer, cached: true };
      send(200, { success: true, data });
      await timer.time("bookkeeping", () =>
        withTenant(ctxArg, (db) => db.logAction({
          action: "document.queried",
          resource_type: "question",
          clerk_user_id: auth.userId,
          changes: {
            question_hash: hashQuestion(question),
            documents: [...new Set((data.sources ?? []).map((s) => s.documentId))],
            passages: 0,
            cached: true,
          },
        })).catch((err) => console.error("Failed to write document.queried audit row (cache hit):", err?.message))
      );
      return;
    }

    if (passages.length === 0 && extractions.length === 0) {
      if (await tryAgent()) return;
      // Miss loop: fired with no await — nothing else on this path is
      // awaited before the response either, and this must never delay it.
      recordAskMiss(ctxArg, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER }).catch(() => {});
      // Item 8 (100-question persona sample, 2026-09-22): a single-record
      // question ("do we have anything about a compressor replacement for
      // Thomas Mercer") that resolves to exactly one known customer/address
      // gets a specific honest zero naming them, instead of the generic
      // "Nothing in your records answers that yet" — see docLookup.js's own
      // doc comment. Only attempted for a question that already looks like a
      // single-record reference (never for an aggregate/analytics-shaped one
      // that merely happened to retrieve nothing); any failure here falls
      // back to the generic line rather than risking a wrong/500 response on
      // an already-given-up path.
      let honestZeroText = null;
      // TEAM C: what was searched, from the same transaction (documents linked to the resolved customer, or the whole library).
      let zeroCitations = null;
      try {
        zeroCitations = await withTenant(ctxArg, async (db) => {
          let cites = null;
          if (looksLikeSingleRecordReference(question)) {
            try {
              const ctx = await resolveHonestZeroContext(db, question);
              if (ctx) {
                honestZeroText = buildHonestZeroText(ctx);
                cites = await honestZeroCitations(db, ctx, { documentIdsFor: customerDocumentIds });
              }
            } catch (err) {
              console.error("Honest-zero context resolution failed, using generic no-answer:", err?.message);
            }
          }
          return cites ?? { records: [], total: 0, kind: "searched", basis: await searchedLibraryBasis(db) };
        });
      } catch (err) {
        console.error("Honest-zero context resolution failed, using generic no-answer:", err?.message);
      }
      return send(200, {
        success: true,
        data: attachCitations({
          kind: "no-answer",
          text: honestZeroText ?? "Nothing in your records answers that yet. Your documents may still be processing.",
          facts: [], sources: [], confidence: 0,
          verifiedCount: 0, unverifiedCount: 0, closest: [],
        }, zeroCitations ?? { records: [], total: 0, kind: "searched", basis: "Searched your documents; nothing matched." }),
      });
    }

    const mappedPassages = passages.map((p) => ({
      documentId: p.document_id,
      filename: p.original_filename,
      documentType: p.document_type,
      page: p.page_no,
      excerpt: String(p.excerpt ?? "").slice(0, MAX_EXCERPT),
      stage: p.stage,
    }));
    const mappedExtractions = extractions.map((x) => ({
      documentId: x.document_id,
      filename: x.original_filename,
      field: x.field_key,
      value: x.value,
      entityType: x.entity_type,
      stage: x.stage,
    }));

    // Cost cut (2026-09-20, owner decision): dedupe by (documentId, page) and
    // cap the context block to ~6K tokens — see selectPassagesForContext's
    // doc comment. `candidates` below (for the no-answer "closest" list)
    // still uses the FULL retrieved set; only what's actually SHOWN to the
    // model, and therefore what a citation may point at, is capped.
    const contextPassages = selectPassagesForContext(mappedPassages);

    // What a citation is allowed to point at: exactly the documents (and,
    // per document, the pages/fields) actually shown to the model above.
    const allowed = buildAllowed({ passages: contextPassages, extractions: mappedExtractions });

    // B1 (2026-09-19 adversarial audit): /api/ask is the single most
    // expensive call site in the codebase (Sonnet, one call per question) and
    // used to be gated only by the `ask` bucket's REQUEST-count cap above —
    // a different number from the tenant's daily model-spend budget, and the
    // only one of the two ever checked here. Checked AFTER retrieval (a
    // question retrieval finds nothing already short-circuits above with no
    // model call) and right before the one Anthropic call this route makes,
    // so a tenant that is over budget never pays for it. Already IN FLIGHT
    // (fired concurrently with the gate check and retrieval above) — this
    // just consults the result at the same point in the flow it always was.
    if (await tryClarify()) return;
    await budgetPromise;

    // Enumerations ("who all has ...", "list every ...") and repair-history questions ("has this unit had a
    // compressor replaced?") go to the agent BEFORE the retrieval model: retrieval answers from the top few
    // pages and caps a reply at 5 facts, which silently truncated a 13-customer list. Falls through to
    // retrieval when the agent cannot answer (its budget leaves room for the retrieval call inside maxDuration).
    if (isAgentFirstQuestion(question) && !isInstallDateExtremeQuestion(question) && (await tryAgent({ budgetMs: (await getResearchV2Enabled()) ? 90_000 : 20_000, recordMiss: false }))) return;

    // ---- 2. ask ------------------------------------------------------------
    // Three separate blocks, not one flat prompt string, so an Anthropic
    // cache breakpoint can land after the stable ones. See answer.js's
    // "Prompt-caching split" comment for why the split falls exactly here.
    //
    //   system  -> SYSTEM_PROMPT: fixed task framing + RULES, identical on
    //              every call for every tenant.
    //   tools   -> ANSWER_TOOL: fixed schema.
    //   content -> [context block (passages+extractions), question block],
    //              IN THAT ORDER — the question block never gets a breakpoint
    //              (it's different on every single call, cached or not) so a
    //              follow-up question that retrieves the same top passages
    //              reuses the cache through the end of the context block and
    //              pays full price for only the question after it.
    //
    // planCacheBreakpoints() (api/_lib/promptCache.js, corrected 2026-09-20
    // late) decides breakpoints off the CUMULATIVE estimated prefix in
    // Anthropic's own billed order (tools -> system -> content), not each
    // block measured alone — so a context block that's individually short
    // still gets cached once the (now-large) system prompt ahead of it has
    // already cleared the model's minimum. See handoffs/COST_REPORT_2026-09-20.md's
    // "Correction" section for current measured sizes.
    const contextText = buildContextBlock({ passages: contextPassages, extractions: mappedExtractions });
    const questionText = buildQuestionBlock({
      question,
      today: todayResolved,
    });

    const { tools: cachedTools, system: cachedSystem, messageBlocks: cachedContent } = planCacheBreakpoints(
      {
        tools: [{ block: ANSWER_TOOL, breakpoint: true }],
        system: [{ block: { type: "text", text: SYSTEM_PROMPT }, breakpoint: true }],
        messageBlocks: [
          { block: { type: "text", text: contextText }, breakpoint: true },
          { block: { type: "text", text: questionText }, breakpoint: false }, // never cached — always different
        ],
      },
      ASK_MODEL
    );

    const { default: Anthropic } = await loadAnthropicSdk();
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const startedAt = Date.now();
    // Retries only 429/529/overloaded, with jitter, and never past the model
    // timeout budget — a burst of questions during a big import must not turn
    // into a wall of "try again" for the tech in the truck.
    const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
    const response = await withBackoff(() => client.messages.create({
      model: ASK_MODEL,
      // 900, not 700 (2026-09-20 late correction): the disambiguation fix
      // below (RULES + the text/facts descriptions in answer.js) means an
      // ambiguous question's answer now legitimately names other candidate
      // records or returns up to 5 per-record facts instead of refusing —
      // both cost a few more output tokens than a single-match answer. 700
      // was sized for the single-match case only; 900 keeps headroom for
      // 5 facts + a text clause naming the other matches without reintroducing
      // the unused 1500 headroom this was cut from in the first place.
      max_tokens: 900,
      // Deterministic on purpose: identical question, identical retrieved
      // evidence -> identical answer. The 2026-09-19 walkthrough saw the
      // SAME question return different dollar figures on two runs; that
      // can't happen at temperature 0.
      temperature: 0,
      system: cachedSystem,
      tools: cachedTools,
      tool_choice: { type: "tool", name: "answer" },
      messages: [{ role: "user", content: cachedContent }],
    }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
    const latencyMs = Date.now() - startedAt;
    timer.add("model", latencyMs);

    // ---- 3. enforce sourcing ------------------------------------------------
    // allowComputed defaults to false here: nothing on this endpoint's
    // evidence path is a computed value (extraction never does arithmetic —
    // see warrantyRules.js), so a model claiming basis "computed" is
    // overruled back to "printed" and held to the ordinary page/field check
    // rather than getting a free pass around it.
    const toolUse = response.content.find((b) => b.type === "tool_use");
    // candidates: what retrieval actually returned, for shapeAnswer to build
    // `closest` from IF everything gets downgraded to no-answer — see the
    // Bug 1 fix in answer.js's shapeAnswer doc comment.
    const candidates = [
      ...mappedPassages.map((p) => ({ documentId: p.documentId })),
      ...mappedExtractions.map((x) => ({ documentId: x.documentId })),
    ];
    let data = shapeAnswer(toolUse?.input, allowed, { candidates });
    // R40 GROUNDING GATE: every amount / number / date / address / name the model stated (headline and each fact card) must be on the document it cites.
    // A card whose value is not on its cited document is removed; an unsupported headline withdraws the answer (no-answer, never "verified"), after which the
    // agent below still gets its one shot. Fails closed (an evidence read that fails withdraws the answer too).
    if (data.kind === "answer" && process.env.DONOVAN_GROUNDING_GATE !== "0") {
      try {
        const ev = await withTenantRetry(ctxArg, async (db) => {
          const m = await loadGroundingEvidence(db, [...data.facts.flatMap((f) => (f.sources ?? []).map((s) => s.documentId)), ...(data.sources ?? []).map((s) => s.documentId)]);
          await loadFinancialRows(db, m);
          return m;
        });
        data = applyGrounding(data, ev, { question, today: todayResolved });
      } catch (err) {
        console.error("grounding gate failed, withdrawing the answer:", err?.message);
        data = applyGrounding(data, new Map(), { question, today: todayResolved, evidenceFailed: true });
      }
      if (Array.isArray(data.facts)) data.facts = data.facts.map(({ modelBasis, ...rest }) => rest);
    }
    // TEAM C: label the cited pages and say what the answer was selected from (a no-answer cites what was searched).
    attachRetrievalCitations(data, { passages: mappedPassages, extractions: mappedExtractions });
    // Retrieval+model shaped an honest no-answer: the agent gets one shot (its own answer is
    // counted once, and this call's usage is recorded with it).
    if (data.kind === "no-answer" && (await tryAgent({
      extraUsage: {
        inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens, cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
      },
    }))) return;

    // Retrieval caps a reply at 5 facts. When an enumeration question still ends up here (the agent
    // could not answer it) and hit that cap, never let 5 read as the whole list.
    if (data.kind === "answer" && data.facts.length >= 5 && isEnumerationQuestion(question)) {
      data.text = `${String(data.text ?? "").replace(/[.\s]+$/, "")}. These are the 5 closest matches, not necessarily every one.`;
    }

    // One structured line per call, no PII and no question text (see
    // hashQuestion's doc comment above for why questions never get logged
    // anywhere) — so Vercel logs show cache hit rates across tenants. Logged
    // (and the response sent) BEFORE the bookkeeping below runs — neither
    // needs the customer to wait on it. `timingsMs` is the same snapshot the
    // Server-Timing header below carries; see handoffs/ASK_LATENCY_2026-09-20.md.
    //
    // stop_reason/facts_raw/facts_kept (2026-09-20 late): counts only, no
    // content — stop_reason tells "genuine no-answer" apart from "the model
    // got cut off"; facts_raw vs. facts_kept is how many facts the model
    // actually cited that shapeAnswer's grounding check then dropped, which
    // is exactly the signal for whether the disambiguation-vs-no-answer
    // regression fix above is doing its job in production.
    console.log(
      JSON.stringify(
        modelCallLogLine({
          route: "ask",
          model: ASK_MODEL,
          inputTokens: response.usage?.input_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
          outputTokens: response.usage?.output_tokens,
          latencyMs,
          timingsMs: timer.snapshot(),
          stopReason: response.stop_reason,
          factsRaw: Array.isArray(toolUse?.input?.facts) ? toolUse.input.facts.length : 0,
          factsKept: data.facts.length,
        })
      )
    );

    // ---- respond FIRST, bookkeeping after (2026-09-20, handoffs/
    // ASK_LATENCY_2026-09-20.md) --------------------------------------------
    // The customer already has a correct, sourced answer at this point.
    // Recording spend and writing the audit row are real work that must
    // still happen, but neither should make the customer wait on it — this
    // sends the response now, then keeps the function alive (Vercel does not
    // freeze a serverless function until its handler's own promise settles)
    // to finish both, same non-fatal try/catch semantics as before, just run
    // together instead of one after the other after the response.
    send(200, { success: true, data });

    // ---- 4. bookkeeping (post-response) ------------------------------------
    // "Who saw this customer's document" has to be answerable, and cost
    // accounting is not request rate limiting (./_lib/rateLimit.js already
    // ran above) — both best-effort and non-fatal: a customer who already got
    // their answer must not see anything different because either write
    // failed after the fact. The question text itself is NEVER stored — see
    // hashQuestion's doc comment — only its hash, which documents were cited,
    // and how many passages were considered.
    const citedDocumentIds = [...new Set((data.sources ?? []).map((s) => s.documentId))];
    // ONE connection, sequential (2026-09-20 fix): running the three writes
    // as parallel withTenant calls exhausted the 5-client pool under Fluid
    // compute — production logged "Failed to upsert ask cache row: timeout
    // exceeded when trying to connect", so answers were never cached. The
    // response is already sent; nothing here is on the customer's clock.
    await timer.time("bookkeeping", async () => {
      try {
        await withTenantRetry(ctxArg, async (db) => {
          try {
            await db.logAction({
              action: "document.queried",
              resource_type: "question",
              clerk_user_id: auth.userId,
              changes: {
                question_hash: hashQuestion(question),
                documents: citedDocumentIds,
                passages: passages.length,
              },
            });
          } catch (err) {
            console.error("Failed to write document.queried audit row:", err?.message);
          }
          // Miss loop: the model itself declined (shapeAnswer downgraded
          // every fact to no-answer, e.g. nothing it cited actually
          // grounded) — reuses this same connection/transaction.
          if (data.kind === "no-answer") {
            await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER });
          }
          // Monthly ask allowance (owner decision, 2026-09-21): this branch is
          // only ever reached after the one Anthropic call above succeeded —
          // cache hits and the "no evidence" no-answer both already returned
          // earlier — so it always counts, regardless of whether shapeAnswer's
          // result kind ended up "answer" or "no-answer" (the model was still
          // reached either way; see usage.js's isCountableAskSource doc comment).
          if (isCountableAskSource("model")) await incrementAsksThisMonth(db);
          // Cache write (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md): a cache
          // miss above means `corpusStamp` came from the SAME transaction that
          // just ran retrieval, so it is still the stamp this answer was built
          // against.
          if (ASK_CACHE_ENABLED && corpusStamp && shouldCache(data.kind, passages.length, extractions.length)) {
            // SAVEPOINT: a failed upsert must not abort the transaction and
            // silently roll back the audit row written just above.
            await db.raw("SAVEPOINT ask_cache_upsert", []);
            try {
              await upsertCacheEntry(db, { questionHash, corpusStamp, today: todayResolved, answer: data });
              await db.raw("RELEASE SAVEPOINT ask_cache_upsert", []);
            } catch (err) {
              console.error("Failed to upsert ask cache row:", err?.message);
              await db.raw("ROLLBACK TO SAVEPOINT ask_cache_upsert", []).catch(() => {});
            }
            await storeSemantic(db, { question, corpusStamp, answer: data }).catch((err) => {
              console.error("Failed to store semantic cache row:", err?.message);
            });
          }
        });
      } catch (err) {
        console.error("Ask bookkeeping transaction failed:", err?.message);
      }
      try {
        await recordModelCall(ctxArg, {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        });
      } catch (err) {
        console.error("Failed to record ask usage:", err?.message);
      }
    });
  } catch (error) {
    try {
      const header = formatServerTiming(timer.snapshot());
      if (header && !res.headersSent) res.setHeader("Server-Timing", header);
    } catch { /* never let timing observability break error reporting */ }
    if (res.headersSent) {
      // Streaming (build spec item 4): headers went out before the answer did (startStreaming() writes
      // them as soon as the research agent begins), so a mid-run failure here would otherwise leave the
      // client's stream hanging with no final event at all — write one now, best-effort, same shape
      // send() would have used for an error.
      if (streaming && !res.writableEnded) {
        try {
          const message = error?.name === "ModelBudgetExceededError" ? (error.message ?? "Daily AI budget reached") : (providerFailureMessage(error) ?? "Something went wrong answering that.");
          res.write(`${JSON.stringify({ type: "final", success: false, error: message })}\n`);
        } catch { /* the client may already be gone */ }
        try { res.end(); } catch { /* the client may already be gone */ }
        console.error("ask: error after streaming started:", error?.message);
        return;
      }
      // Otherwise only reachable if the post-response bookkeeping above somehow threw past its own
      // per-promise .catch — the customer already has their answer, so there is nothing left to send.
      console.error("ask: error after response already sent:", error?.message);
      return;
    }
    // Checked before the generic handler: handleError's own 429 branch would
    // catch this too (status 429), but with a different message and no
    // Retry-After header — every model-budget-gated endpoint should answer
    // this exact condition the same way (see rateLimit.js's
    // sendModelBudgetExceeded doc comment).
    if (error?.name === "ModelBudgetExceededError") {
      return sendModelBudgetExceeded(handleCors(res, req), error);
    }
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
