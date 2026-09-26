/**
 * Donovan research agent (v2) — "as capable as Claude at finding answers within documents, linking
 * them together and connecting the dots" (owner goal, 2026-09-25 build spec). This is the Sonnet-first
 * successor to loop.js's bounded 4-turn Haiku loop: more tools (tools.js's v2 additions — read_document,
 * get_unit, follow_links, timeline, compute), a much larger turn/token/time budget, and a dedicated
 * verify step (verify.js) that re-checks every cited fact against the actual page/field it cites before
 * the answer ever reaches the user.
 *
 * loop.js itself is UNTOUCHED — this is an additive module. api/ask.js decides, per the
 * DONOVAN_RESEARCH_AGENT flag, whether its `tryAgent()` fallback calls runDonovanAgent (v1) or
 * runResearchAgent (this file) at every one of its existing fallback points; nothing about ask.js's
 * pre-router chain (meta / deterministic / fast-path / contact / doc-lookup / content-count / money —
 * the "high-confidence fast layer") changes either way. See router.js for the (free, no-model-call)
 * classifier that logs why a question reached here.
 *
 * Bounds (all enforced in code):
 *   - MAX_TOOL_CALLS_V2 (15) tool EXECUTIONS total across the whole run, not per turn — several tool
 *     calls in one turn (parallel, via runToolsBounded from loop.js) count against the same budget;
 *   - MAX_TURNS_V2 (8) model calls;
 *   - a cumulative INPUT token cap (default 120k, cache reads/writes included) — past 75% the next
 *     call is forced to `answer`, past 100% the run stops with no answer;
 *   - a wall-clock deadline supplied by the caller (ask.js budgets up to ~240s within its own
 *     maxDuration, itself Vercel-Pro-sized — see ask.js's `config.maxDuration`);
 *   - a PER-TENANT daily USD spend cap, tracked separately from the v1 escalation cap (escalation.js's
 *     sonnetAllowed/recordSonnetSpend, generalized to take a bucket — this run uses RESEARCH_BUCKET,
 *     never touching v1's SONNET_BUCKET counter or vice versa);
 *   - assertModelBudget() (the existing shared daily-model-spend cap every billed path respects);
 *   - temperature 0, bounded output tokens, at most MAX_TOOLS_PER_TURN_V2 tool calls handled per turn.
 *
 * The model can only READ (see tools.js / sqlGuard.js). Its final `answer` is re-grounded by shape.js
 * (unchanged, shared with v1) and then re-checked fact-by-fact against its cited source by verify.js —
 * a fact whose citation does not actually say what it claims is dropped, and (bounded to ONE retry) the
 * run gets one more turn to fill the gap before returning whatever survives.
 *
 * No question text, no row values, no model output is ever logged here — only counts.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff, classifyProviderError, recordProviderOutage } from "../claude.js";
import { assertModelBudget } from "../rateLimit.js";
import { planCacheBreakpoints } from "../promptCache.js";
import { recordModelCall, totalInputTokens, estimateModelCostUsd } from "../usage.js";
import { ALL_TOOL_DEFS_V2, ANSWER_TOOL_NAME, VIEW_DOCS, createToolbox } from "./tools.js";
import { shapeAgentAnswer } from "./shape.js";
import { citeAgentData } from "../citations/agent.js";
import { selectWorkedExamples, formatWorkedExamples } from "../learning/recipes.js";
import { escalationModel, sonnetAllowed, recordSonnetSpend, isEscalationEnabled } from "./escalation.js";
import { VIEW_PAGE_DOCS } from "./viewPage.js";
import { packForTenant } from "../industry/index.js";
import { runToolsBounded } from "./loop.js";
import { verifyFacts, createDbSourceFetcher } from "./verify.js";
import { verifyAnswerClaims } from "../claims/index.js";
// Perf pass (2026-09-25, ask-latency): the same free, no-DB, no-model question-shape classifiers
// router.js already reuses for telemetry — isEnumerationQuestion/isAgentFirstQuestion pick out the
// "everything about X" / customer-file / enumeration shapes the prefetch step (below) targets.
import { isEnumerationQuestion, isAgentFirstQuestion } from "./intents.js";

/** Sonnet by default (owner decision, 2026-09-25: "Sonnet as the default research agent for anything
 *  non-trivial; NO Opus"). Reuses escalation.js's model id rather than a second copy of it. */
export const RESEARCH_MODEL = process.env.DONOVAN_RESEARCH_MODEL || escalationModel();
// R7 latency pass (2026-09-26, p95 29.1 s / observed 20-50 s answers — see R7_MEASURE.md): the previous
// 8-turn/15-tool-call ceiling was the ACTUAL shape of the slow answers, not a rarely-hit safety net — a
// question the model can't resolve (a join/window computation no read-only tool exposes, e.g. "callback
// within 14 days of a previous visit") burns every turn searching without ever finding new evidence and
// still returns "nothing in your records answers that" after the full 8 turns. Trimmed to 6/12 (still
// generous for genuine multi-hop) and backed by the no-progress/soft-deadline early exits below, which are
// what actually shorten the pathological runs — this cap alone only bounds the worst case.
export const MAX_TURNS_V2 = 6;
/** Cumulative tool EXECUTIONS across the whole run (several in one turn still count individually). */
export const MAX_TOOL_CALLS_V2 = 12;
/** R7 latency pass: once elapsed wall-clock time since the run started passes this AND at least one tool
 *  round has already run, the run is forced to answer from whatever evidence it has instead of spending
 *  another full turn — "provisional answer from the best evidence" rather than the model's own judgement
 *  of when it's done. Deliberately looser than the ~8s target quoted for the system as a whole (most of
 *  that 8s is fast-path/no-agent questions); this only bounds the agent's OWN slice of a run.
 *  DONOVAN_RESEARCH_SOFT_DEADLINE_MS overrides for tests/tuning. */
export const SOFT_DEADLINE_MS_V2 = Number(process.env.DONOVAN_RESEARCH_SOFT_DEADLINE_MS) || 14_000;
/** R7 latency pass: two consecutive tool rounds that ran an evidence-gathering tool (search/query/filter/
 *  synthesize/etc.) and turned up NO new rows at all means the model is stuck, not converging — forcing an
 *  answer here is what actually fixes "never spend 40 s to say nothing found" (a stuck run answers
 *  none_found/cannot_answer after ~2-3 rounds instead of 6). A round that only ran non-evidence tools
 *  (compute, view_document_page) neither counts against nor resets this — it is simply not a signal either
 *  way. */
export const NO_PROGRESS_ROUND_LIMIT_V2 = 2;
export const EVIDENCE_TOOLS_V2 = new Set([
  "search_documents", "run_query", "filter_records", "count_documents_mentioning", "synthesize",
  "find_customers", "get_customer", "get_unit", "get_dossier", "timeline", "follow_links",
]);
/** R7 latency pass: caps how much of any ONE tool result's text goes into the model's context. A huge
 *  result (a wide run_query, a long read_document page) is exactly what turns one turn's model call into a
 *  slow one — the model still gets the content it needs (evidence tools already return their own top-N/
 *  LIMIT-ed rows; this only trims pathological outliers) plus an explicit note to narrow the query instead
 *  of silently truncating. DONOVAN_RESEARCH_MAX_TOOL_CHARS overrides for tests/tuning. */
export const MAX_TOOL_RESULT_CHARS_V2 = Number(process.env.DONOVAN_RESEARCH_MAX_TOOL_CHARS) || 6000;
export function capToolResultContent(content) {
  if (typeof content !== "string" || content.length <= MAX_TOOL_RESULT_CHARS_V2) return content;
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS_V2)}\n…[truncated ${content.length - MAX_TOOL_RESULT_CHARS_V2} more characters — narrow the query (a customerId/equipmentId/date range) or use read_document/synthesize for the rest]`;
}
export const DEFAULT_INPUT_TOKEN_CAP_V2 = 120_000;
// Perf pass (2026-09-25, ask-latency): raised 4 -> 6 (build spec item 1) so the model can batch more
// independent lookups (a multi-part question, several unrelated ids) into ONE turn instead of spreading
// them across several round trips. Turn-level batching is safe to raise on its own: it only changes how
// many tool_use blocks are QUEUED per turn, not how many run at the database at once (see
// TOOL_CONCURRENCY_V2 just below, which is what actually bounds DB load).
export const MAX_TOOLS_PER_TURN_V2 = 6;
const MAX_OUTPUT_TOKENS_V2 = 1400;
/** Perf pass item 5 (trim max_tokens for a forced final-answer turn "where safe" — see
 *  forcedAnswerTokenBudget below): only used when the run's own evidence gives strong reason to believe
 *  the answer will be small, never as the default cap. */
const MAX_OUTPUT_TOKENS_V2_SMALL = 900;
const MIN_CALL_BUDGET_MS = 4000;
export const DEFAULT_DEADLINE_MS_V2 = Number(process.env.DONOVAN_AGENT_DEADLINE_MS) || 240_000; // must stay below vercel.json maxDuration (300 s on Pro)
// Perf pass (2026-09-25, ask-latency): build spec item 1 asks to raise this to 5 "if the DB pool allows".
// It does NOT: recordsStore.js's getPool caps the whole shared Neon pool at `max: 3` — deliberately, after
// a 2026-09-22 reviewer NO-GO on a bigger pool (see that file's own comment and
// handoffs/API_PERF_2026-09-22.md for the "timeout exceeded when trying to connect" incident it was
// lowered to fix). That pool is shared by every endpoint on a warm instance, not reserved for one ask, so
// one research-agent tool turn alone must never be able to claim more connections than the pool holds.
// Per the build spec's own fallback ("if pool is tiny, keep concurrency <= pool-1"), this stays at
// (PG_POOL_MAX - 1) by default — 2, down from this constant's old hardcoded default of 3, which left ZERO
// headroom (loop.js's v1 agent, by contrast, has always reserved 1 connection: TOOL_CONCURRENCY = 2 against
// the same pool). MAX_TOOLS_PER_TURN_V2 is still raised above: more tool calls PER TURN keeps cutting model
// round trips even though only (pool-1) of them run at the database at once — runToolsBounded just queues
// the rest behind the same small worker pool instead of firing all N at Postgres simultaneously.
// DONOVAN_RESEARCH_TOOL_CONCURRENCY still overrides this explicitly for an operator who has actually
// raised PG_POOL_MAX and wants to use the extra headroom.
const RESEARCH_POOL_HEADROOM = Math.max(1, (Number(process.env.PG_POOL_MAX) || 3) - 1);
export const TOOL_CONCURRENCY_V2 = Math.max(1, Math.min(MAX_TOOLS_PER_TURN_V2, Number(process.env.DONOVAN_RESEARCH_TOOL_CONCURRENCY) || RESEARCH_POOL_HEADROOM));
/** Build spec item 2: how long the pre-first-turn prefetch may run before the run just proceeds without
 *  it (DONOVAN_RESEARCH_PREFETCH_MS overrides for tests/tuning). */
export const PREFETCH_TIMEOUT_MS = Number(process.env.DONOVAN_RESEARCH_PREFETCH_MS) || 2500;
/** DONOVAN_RESEARCH_PREFETCH=0 disables the pre-first-turn prefetch (default ON); a kill switch
 *  independent of DONOVAN_RESEARCH_AGENT so prefetch alone can be rolled back without disabling v2. */
export function isPrefetchEnabled(env = process.env) {
  return env?.DONOVAN_RESEARCH_PREFETCH !== "0";
}

/** The research agent's OWN per-tenant daily spend cap — never shares a counter with v1's escalation
 *  cap (escalation.js's SONNET_BUCKET / DONOVAN_SONNET_DAILY_USD). */
export const RESEARCH_BUCKET = "research_usd_micro";
export const DEFAULT_RESEARCH_DAILY_USD = 10;
export function researchDailyCapUsd(env = process.env) {
  const raw = env?.DONOVAN_RESEARCH_DAILY_USD;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RESEARCH_DAILY_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESEARCH_DAILY_USD;
}

/** DONOVAN_RESEARCH_AGENT=0 disables v2; ask.js's tryAgent then keeps using v1 (loop.js) exactly as
 *  before. Default ON — the owner's stated goal is Sonnet-grade research everywhere. */
export function isResearchAgentEnabled(env = process.env) {
  return env?.DONOVAN_RESEARCH_AGENT !== "0" && isEscalationEnabled(env);
}

/** Per-tenant/day cap check, reusing escalation.js's generalized sonnetAllowed with our own bucket. */
export async function researchAllowed(withTenant, ctxArg, env = process.env) {
  return sonnetAllowed(withTenant, ctxArg, env, Date.now(), { capUsd: researchDailyCapUsd(env), bucket: RESEARCH_BUCKET });
}

function researchSystemPromptFor(businessNoun) {
  const article = /^hvac\b/i.test(businessNoun) ? "an" : (/^[aeiou]/i.test(businessNoun) ? "an" : "a");
  return `You are Donovan, the research assistant for ${article} ${businessNoun}. You work the way a careful analyst would: decompose the question, look things up instead of guessing, read the actual pages rather than trusting a snippet, and connect entities across documents before you answer. Answer ONLY from tool results in this conversation.

RESEARCH DISCIPLINE:
- Break a multi-part question into its parts and gather evidence for each part before answering; do not answer from the first thing you find if the question has more than one part.
- Prefer reading over guessing. search_documents gives you a short excerpt; when it is ambiguous, cuts off mid-thought, or the question depends on the WHOLE document (a contract's terms, a long work order), call read_document to read the actual pages. Use view_document_page when the transcript itself looks wrong or unclear (a nameplate, handwriting, a photo).
- When two documents or two facts disagree (a warranty date, an address, a status), say so explicitly in your answer and state which one is NEWER and therefore more authoritative — use timeline or the documents' own dates/created_at to work out which; never silently prefer one without saying why.
- Connect entities across documents: a question about "this customer" or "this unit" means everything linked to it, not just the first document you find — use follow_links, get_customer, get_unit and timeline to pull the fuller picture in before answering, especially for a "what do we know about..." or "everything on..." question.
- State uncertainty plainly when the records only partly answer the question: say what you found, and say what you could not find, rather than rounding a partial answer up to a confident one.
- NEVER invent a name, date, number, model, serial, address or document. Every claim in your final answer must be backed by a specific tool result; every fact that comes from a document cites that document AND its page (or field).
- Every number in your answer — including arithmetic (a sum, an age in months, a days-until-expiry) — must come from a tool result verbatim or from the compute tool; never compute it yourself in prose. Money totals may come ONLY from the financials view (see the view docs below), never added up by hand from search excerpts.
- Call several independent tools in the SAME turn whenever you already know you need them — up to six at once: searching two different things, reading two documents that do not depend on each other, one query per side of a comparison, or the several independent parts of one multi-part question (a question naming three different customers/units/dates is three independent lookups issued in ONE turn, not three separate round trips). This reaches the answer faster. Only chain calls one at a time when a later call genuinely needs an id or value an earlier one returned.
- TIME WORDS: "added / uploaded / received / scanned / filed" mean a document's own upload date; "serviced / visited / job / work done / installed" mean its service_date/installation_date. Say in text which date you used. A service_date later than today is a scheduled visit or a typo — never call it the last service; exclude it and mention it.
- Lists: one fact per row for EVERY row (up to 40), never a partial list phrased as complete; the true total is always stated in text. If a result says truncated, narrow the query and run it again.
- If the records genuinely cannot answer (a needed field was never captured), use status cannot_answer and say plainly what is missing. If you searched and there is genuinely nothing, use none_found. Never pad, never guess.
- Finish by calling the answer tool exactly once. text is 2-4 plain sentences (more room than a quick lookup, because a research answer often has more than one part) a dispatcher or owner would say out loud.

${VIEW_DOCS}

${VIEW_PAGE_DOCS}

RESEARCH TOOLS (beyond the SQL views above):
- read_document(documentId, fromPage?) — the FULL transcribed text of a document, page by page (not an excerpt). Use it to read a whole document in detail, reconcile two documents against each other, or when a search excerpt is not enough context. It tells you when more pages follow (call again with the given fromPage).
- get_unit(equipmentId) — one piece of equipment's own profile (manufacturer/model/serial/install date/warranty), its owning customer, and only the documents linked to THIS unit specifically.
- follow_links(entityId) — one hop of the customer<->unit<->document<->technician graph from any id you already have (a customerId, equipmentId or documentId): what else connects to it. Use this to connect entities across documents.
- timeline(customerId|equipmentId, dateFrom?, dateTo?, documentType?, order?) — the chronological event list for one customer or unit, or a date range, each with its date, type, technician and documentId. Use it to establish ordering and which of two documents is newer.
- compute(expression) — arithmetic and date math (+ - * /, today(), daysBetween(a,b), monthsBetween(a,b), yearsBetween(a,b), addDays(a,n), addMonths(a,n), addYears(a,n) over 'YYYY-MM-DD' dates). Use it for every number you did not copy verbatim from a tool result.
- get_dossier(entityId) — a precomputed, cited rolling summary for ONE customer or unit. Try this FIRST for a broad "everything about X" / "what do we know about this customer" question, before several search_documents/get_customer/timeline calls; dossier:null means none has been built yet, so fall back to those.
- synthesize(question, customerId?/equipmentId?/docType?/technician?/dateFrom?/dateTo?) — answers a question that spans MANY documents at once (dozens to hundreds) by reading each one and combining cited facts, with an honest coverage note. Use it for "across all of...", "every time we...", or a whole history no handful of search_documents/read_document calls can cover; note in your answer if it comes back as status 'dossier' or 'queued' rather than a fresh read.

search_documents note: it now also tries to work out which customer or unit the query itself names (the same way find_customers would) and scopes the search to just that entity's own documents when it can — pass customerId explicitly when you already have it rather than relying on that.`;
}

/** This tenant's resolved system prompt (Team G industry packs, same mechanism as loop.js). */
export function buildResearchSystemPrompt(pack) {
  return researchSystemPromptFor(pack?.businessNoun ?? "HVAC shop");
}
export const RESEARCH_SYSTEM_PROMPT = researchSystemPromptFor("HVAC shop");

/** Cache invalidation key: any change to the model, prompt or tool schemas here never collides with v1's
 *  AGENT_PROMPT_VERSION (loop.js) — separate namespace, separate cache rows. */
export const RESEARCH_PROMPT_VERSION = createHash("sha256")
  .update(RESEARCH_MODEL)
  .update(RESEARCH_SYSTEM_PROMPT)
  .update(JSON.stringify(ALL_TOOL_DEFS_V2))
  .digest("hex")
  .slice(0, 12);

export function researchQuestionHash(question) {
  const n = String(question ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  return createHash("sha256").update(`research:${n}`).digest("hex");
}

async function defaultCallModel(req, { deadlineAt }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return withBackoff(() => client.messages.create(req, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
}

/**
 * Perf pass item 5 (trim max_tokens for a forced final-answer turn "where safe"): only shrinks the cap
 * when THIS run's own evidence so far gives strong reason to expect a small answer — no listing-capable
 * tool (run_query / filter_records / count_documents_mentioning / synthesize / get_dossier) has been
 * called yet, and fewer than a handful of ids have surfaced in the ledger. A genuine list/enumeration
 * answer always keeps the FULL MAX_OUTPUT_TOKENS_V2 (it trips one of these two signals almost by
 * definition), so this can never truncate one — the smaller cap only ever applies to a narrow
 * single-entity lookup, where the one thing max_tokens was ever bounding is the model rambling in prose
 * before its (forced) tool call, not a large facts[] array.
 */
const LIST_CAPABLE_TOOLS = new Set(["run_query", "filter_records", "count_documents_mentioning", "synthesize", "get_dossier"]);
function forcedAnswerTokenBudget(steps, ledger) {
  const sawListTool = steps.some((s) => LIST_CAPABLE_TOOLS.has(s.tool));
  if (sawListTool || ledger.ids.size > 8) return MAX_OUTPUT_TOKENS_V2;
  return MAX_OUTPUT_TOKENS_V2_SMALL;
}

function usageOf(resp) {
  const u = resp?.usage ?? {};
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
    cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
  };
}

/** Friendly, client-facing progress labels for the streaming UX (build spec item 4). Never logged
 *  server-side (see file header) — only written to the requesting tenant's own response stream. */
function stepLabel(toolName, input) {
  const q = (s) => (typeof s === "string" && s.trim() ? `"${s.trim().slice(0, 60)}"` : "");
  switch (toolName) {
    case "describe_data": return "Checking what's on file…";
    case "search_documents": return `Searching documents${q(input?.query) ? ` for ${q(input.query)}` : ""}…`;
    case "count_documents_mentioning": return "Scanning every document on file…";
    case "find_customers": return "Looking up the customer…";
    case "get_customer": return "Reading the customer's file…";
    case "get_unit": return "Reading the unit's file…";
    case "run_query": return "Querying the records…";
    case "filter_records": return "Filtering matching records…";
    case "read_document": return `Reading document ${(input?.fromPage ?? 1) > 1 ? `page ${input.fromPage} onward` : ""}…`.replace("  ", " ");
    case "follow_links": return "Following links between records…";
    case "timeline": return "Building a timeline…";
    case "compute": return "Computing…";
    case "get_dossier": return "Checking the rolling summary…";
    case "synthesize": return "Reading many documents to combine an answer…";
    case "view_document_page": return "Looking at the original page…";
    default: return "Working…";
  }
}

/**
 * @param {object} p  same call shape as loop.js's runDonovanAgent, plus:
 * @param {(evt: {type:string, message:string}) => void} [p.onEvent]  streaming progress callback
 *   (build spec item 4). Called with {type:'plan'|'tool'|'cross-check'|'verify', message}. Never throws
 *   out of this function even if the callback does (wrapped in try/catch).
 * @returns same result shape as runDonovanAgent (handled/data/reason/model/modelCalls/inputTokens/
 *   outputTokens/costUsd/steps/modelCallsMs/queries/dropped/models/escalation?) so ask.js's existing
 *   bookkeeping (cache upsert, agentDebugTrace, submitRecipe) works completely unchanged.
 */
export async function runResearchAgent({ withTenant, ctxArg, question, today, overlay, hint, callModel = defaultCallModel, deadlineAt, limits = {}, onEvent, env = process.env }) {
  await assertModelBudget(ctxArg);

  const emit = (type, message) => { if (typeof onEvent === "function") { try { onEvent({ type, message }); } catch { /* streaming is best-effort */ } } };

  const gate = await researchAllowed(withTenant, ctxArg, env);
  if (!gate.allowed) {
    return { handled: false, data: null, reason: `budget:${gate.why}`, model: RESEARCH_MODEL, modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0, steps: [], modelCallsMs: [], queries: [], dropped: null, models: [RESEARCH_MODEL] };
  }

  const maxTurns = Math.max(1, Math.min(MAX_TURNS_V2, limits.maxTurns ?? MAX_TURNS_V2));
  const maxToolCalls = Math.max(1, Math.min(MAX_TOOL_CALLS_V2, limits.maxToolCalls ?? MAX_TOOL_CALLS_V2));
  const inputCap = limits.inputTokenCap ?? (Number(env?.DONOVAN_RESEARCH_MAX_INPUT_TOKENS) || DEFAULT_INPUT_TOKEN_CAP_V2);
  const deadline = deadlineAt ?? Date.now() + DEFAULT_DEADLINE_MS_V2;
  const runStartedAt = Date.now();
  let noProgressRounds = 0;
  let earlyExitReason = null; // "soft-deadline" | "no-progress", diagnostics only — never changes behavior

  const toolbox = createToolbox({ withTenant, ctxArg, today, deadlineAt: deadline, variant: "v2" });
  const totals = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let costUsd = 0;
  const steps = [];
  const modelCallsMs = [];
  const records = [];
  let toolCallsUsed = 0;
  let reason = "";
  let finalInput = null;
  let error;
  let providerUnavailable = false;

  let pack = null;
  try { pack = await packForTenant({ withTenant, ctxArg }); } catch { pack = null; }
  const { tools, system } = planCacheBreakpoints(
    {
      tools: ALL_TOOL_DEFS_V2.map((block, i) => ({ block, breakpoint: i === ALL_TOOL_DEFS_V2.length - 1 })),
      system: [{ block: { type: "text", text: buildResearchSystemPrompt(pack) }, breakpoint: true }],
    },
    RESEARCH_MODEL
  );

  const examples = formatWorkedExamples(selectWorkedExamples(overlay?.recipes, question, 3));
  const note = typeof hint === "string" && hint.trim()
    ? `\n\nREVIEWER NOTE (the previous answer to this question was marked wrong; take this into account, but every fact must still come from tool results): ${hint.trim().slice(0, 300)}`
    : "";
  const messages = [{ role: "user", content: [{ type: "text", text: `Today's date: ${today}\n\n${examples}QUESTION: ${question}${note}` }] }];

  emit("plan", "Reading the question and planning what to look up…");

  // ---- prefetch (build spec item 2, ask-latency pass): for an enumeration / "everything about X" /
  // customer-file question (the same free, no-model isEnumerationQuestion/isAgentFirstQuestion shapes
  // router.js already reuses for telemetry), run ONE cheap, time-boxed search_documents lookup — DB +
  // embeddings only, no model call — BEFORE the first model turn, and inject its result as an
  // already-fulfilled tool_use/tool_result pair so the first REAL model call starts with evidence already
  // in hand instead of spending a whole round trip asking for it. Time-boxed at PREFETCH_TIMEOUT_MS: a
  // slow prefetch is simply abandoned (Promise.race just stops waiting on it; nothing later in the run
  // blocks on it) and the run proceeds exactly as it would have with prefetch off — this can make a run
  // faster, never worse or wrong (a bad/empty prefetch result is just never injected, guarded by
  // `prefetched.ok` below).
  let prefetchUsed = false;
  if (isPrefetchEnabled(env) && (isEnumerationQuestion(question) || isAgentFirstQuestion(question))) {
    const prefetchBudgetMs = Math.min(PREFETCH_TIMEOUT_MS, deadline - Date.now() - MIN_CALL_BUDGET_MS);
    if (prefetchBudgetMs >= 500 && toolCallsUsed < maxToolCalls) {
      const prefetchInput = { query: String(question).slice(0, 300), limit: 8 };
      let prefetched = null;
      try {
        prefetched = await Promise.race([
          toolbox.execute("search_documents", prefetchInput),
          new Promise((resolve) => { setTimeout(() => resolve(null), prefetchBudgetMs); }),
        ]);
      } catch { prefetched = null; }
      if (prefetched && prefetched.ok) {
        const useId = "prefetch-1";
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: useId, name: "search_documents", input: prefetchInput }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: capToolResultContent(prefetched.content) }] });
        toolCallsUsed += 1;
        steps.push({ tool: "search_documents", inputSummary: prefetched.inputSummary, rowCount: prefetched.rowCount, ms: prefetched.ms, prefetch: true });
        prefetchUsed = true;
        emit("tool", "Checking existing records before asking the model…");
      }
    }
  }

  async function runTurns(turnBudget) {
    let nudged = false;
    for (let turn = 1; turn <= turnBudget; turn++) {
      if (totals.inputTokens >= inputCap) { reason = "token-cap"; return; }
      if (toolCallsUsed >= maxToolCalls) { reason = "tool-cap"; return; }
      if (deadline - Date.now() < MIN_CALL_BUDGET_MS) { reason = "deadline"; return; }

      const softDeadlineHit = turn > 1 && toolCallsUsed > 0 && (Date.now() - runStartedAt) > SOFT_DEADLINE_MS_V2;
      const stuck = noProgressRounds >= NO_PROGRESS_ROUND_LIMIT_V2;
      const forceAnswer = turn === turnBudget || totals.inputTokens >= inputCap * 0.75 || toolCallsUsed >= maxToolCalls - 1
        || nudged || softDeadlineHit || stuck;
      if (!earlyExitReason && (softDeadlineHit || stuck)) earlyExitReason = stuck ? "no-progress" : "soft-deadline";
      const modelStarted = Date.now();
      const resp = await callModel(
        {
          model: RESEARCH_MODEL,
          max_tokens: forceAnswer ? forcedAnswerTokenBudget(steps, toolbox.ledger) : MAX_OUTPUT_TOKENS_V2,
          temperature: 0, system, tools,
          tool_choice: forceAnswer ? { type: "tool", name: ANSWER_TOOL_NAME } : { type: "auto" },
          messages,
        },
        { deadlineAt: deadline }
      );
      modelCallsMs.push(Date.now() - modelStarted);
      const u = usageOf(resp);
      totals.modelCalls++;
      totals.inputTokens += totalInputTokens(u);
      totals.outputTokens += u.outputTokens;
      totals.cacheReadInputTokens += u.cacheReadInputTokens;
      totals.cacheCreationInputTokens += u.cacheCreationInputTokens;
      costUsd += estimateModelCostUsd(RESEARCH_MODEL, u);
      records.push(recordModelCall(ctxArg, { ...u, model: RESEARCH_MODEL }));

      const content = Array.isArray(resp?.content) ? resp.content : [];
      const uses = content.filter((b) => b?.type === "tool_use");
      const answer = uses.find((b) => b.name === ANSWER_TOOL_NAME);
      if (answer) { finalInput = answer.input ?? {}; reason = "answered"; return; }

      if (!uses.length) {
        if (nudged) { reason = "no-tool"; return; }
        nudged = true;
        messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no answer)" }] });
        messages.push({ role: "user", content: [{ type: "text", text: "Use the answer tool now." }] });
        continue;
      }

      messages.push({ role: "assistant", content });
      const remaining = Math.max(0, maxToolCalls - toolCallsUsed);
      const toRun = uses.slice(0, Math.min(MAX_TOOLS_PER_TURN_V2, remaining || 1));
      for (const use of toRun) emit("tool", stepLabel(use.name, use.input));
      const execResults = toRun.length ? await runToolsBounded(toolbox, toRun, TOOL_CONCURRENCY_V2) : [];
      toolCallsUsed += toRun.length;
      const results = toRun.map((use, i) => {
        const r = execResults[i];
        steps.push({ tool: use.name, inputSummary: r.inputSummary, rowCount: r.rowCount, ms: r.ms, ...(r.ok ? {} : { error: true }) });
        return { type: "tool_result", tool_use_id: use.id, content: capToolResultContent(r.content), ...(r.ok ? {} : { is_error: true }) };
      });
      // R7 latency pass: did this round's evidence-gathering tools (if any) turn up anything new? Two
      // rounds in a row of "ran a search/query and found nothing" forces the next turn to answer instead
      // of continuing to search — see NO_PROGRESS_ROUND_LIMIT_V2 above.
      const ranEvidenceTool = toRun.some((use) => EVIDENCE_TOOLS_V2.has(use.name));
      if (ranEvidenceTool) {
        const foundRows = execResults.some((r) => Number(r?.rowCount) > 0);
        noProgressRounds = foundRows ? 0 : noProgressRounds + 1;
      }
      for (const extra of uses.slice(toRun.length)) {
        results.push({ type: "tool_result", tool_use_id: extra.id, content: "ERROR: tool-call budget for this question is used up; answer from what you have", is_error: true });
      }
      messages.push({ role: "user", content: results });
      if (turn === turnBudget) reason = "turn-cap";
    }
    if (!reason) reason = "turn-cap";
  }

  try {
    await runTurns(maxTurns);
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") { await Promise.allSettled(records); throw err; }
    // ROUND 14: see loop.js's own comment on this same branch — a credits/auth/overload failure is
    // recorded once, at the source, so every downstream consumer (scorecard runner, replay.js, the
    // provider-status flag other model call sites check) sees it without re-parsing the raw error.
    const provider = err?.name === "ProviderUnavailableError" ? { reason: err.reason, detail: err.detail } : classifyProviderError(err);
    if (provider) {
      recordProviderOutage(provider);
      providerUnavailable = true;
      reason = "provider-unavailable";
      error = provider.detail || provider.reason;
    } else {
      reason = "error";
      error = String(err?.message ?? err).slice(0, 200);
    }
  }

  let shaped = null;
  if (finalInput) shaped = shapeAgentAnswer(finalInput, toolbox.ledger, { question, today });

  // ---- verify step (build spec item 3): re-check every cited fact against its OWN cited page/field,
  // not just the run's whole evidence corpus (shape.js already did that broader check above). One
  // bounded re-research turn is allowed when something gets dropped and there is still time/turn/tool
  // budget left, so a fixable gap ("I have the doc, I just cited the wrong page") gets one more chance
  // before the answer goes out short a fact. Perf pass confirmation (2026-09-25): the condition below
  // ALREADY gates the retry on `verifyDropped > 0` and nothing else drop-related — a clean verify pass
  // (or an answer with no sourced facts at all, filtered out above) never spends the extra model turn.
  let verifyDropped = 0;
  let verifySkipped = 0;
  // Hoisted (not `const` inside the block below) so the claim-check pass right after it — same DB
  // connection, same per-request cache — can reuse it instead of paying for a second fetcher/cache.
  let fetchSourceText = null;
  if (shaped?.answered && shaped.data?.kind === "answer" && shaped.data.facts?.length) {
    emit("verify", "Cross-checking each fact against its source…");
    fetchSourceText = createDbSourceFetcher({ withTenant, ctxArg });
    const first = await verifyFacts(shaped.data, fetchSourceText);
    verifyDropped = first.droppedCount;
    verifySkipped += first.skippedCount ?? 0;
    shaped = { ...shaped, data: first.data };
    if (verifyDropped > 0 && reason !== "deadline" && reason !== "token-cap" && reason !== "tool-cap"
        && toolCallsUsed < maxToolCalls && deadline - Date.now() >= MIN_CALL_BUDGET_MS && totals.modelCalls < maxTurns) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: "verify-note", name: ANSWER_TOOL_NAME, input: finalInput }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "verify-note", content: `${verifyDropped} of your facts could not be confirmed against the page/field you cited and were dropped. If you can find better support for them (read_document, view_document_page, or a corrected citation), answer again; otherwise call the answer tool again without them.` }] });
      reason = "";
      finalInput = null;
      await runTurns(1);
      if (finalInput) {
        const reshaped = shapeAgentAnswer(finalInput, toolbox.ledger, { question, today });
        if (reshaped.answered) {
          const second = await verifyFacts(reshaped.data, fetchSourceText);
          shaped = { ...reshaped, data: second.data };
          verifyDropped = second.droppedCount;
          verifySkipped += second.skippedCount ?? 0;
        }
      } else {
        reason = "verify-retry-exhausted";
      }
    }
  }

  // ---- claim check (build spec item 3, R11 — api/_lib/claims/**): a finer-grained pass than the fact-
  // level verify step above — it also catches an unsupported claim sitting in the free-form prose `text`
  // (a sentence verifyFacts never looks at, since it only checks each fact's own `value`), and applies
  // type-aware matching (format-normalized dates, fuzzy-but-bounded names, derived warranty/invoice
  // status) instead of verify.js's blunter "does this token appear anywhere in the cited text" check.
  // Reuses the SAME fetchSourceText this run already built for verifyFacts — its cache means any
  // citation verifyFacts already fetched costs nothing further here, and its own `.prefetch` still
  // batches whatever is new into one extra round trip. `agentWritten: true` is this file's policy
  // choice (build spec item 3: "unsupported claims in model-written (agent) answers -> remove/rewrite").
  let claimCheckResult = null;
  if (shaped?.answered && shaped.data?.kind === "answer") {
    const claimFetcher = fetchSourceText || createDbSourceFetcher({ withTenant, ctxArg });
    try {
      const { data, claimCheck } = await verifyAnswerClaims(shaped.data, { fetchSourceText: claimFetcher, today, agentWritten: true });
      shaped = { ...shaped, data };
      claimCheckResult = claimCheck;
    } catch (err) {
      console.error("claim check failed, keeping the answer as verifyFacts left it:", err?.message);
    }
  }

  if (shaped?.answered) shaped.data = await citeAgentData({ withTenant, ctxArg, data: shaped.data, ledger: toolbox.ledger, input: finalInput });
  await Promise.allSettled(records);
  costUsd = Math.round(costUsd * 1_000_000) / 1_000_000;
  const handled = Boolean(shaped?.answered);
  if (costUsd > 0) await recordSonnetSpend(withTenant, ctxArg, costUsd, Date.now(), RESEARCH_BUCKET);

  console.log(
    JSON.stringify({
      route: "ask", research_agent: true, model: RESEARCH_MODEL, reason, handled,
      model_calls: totals.modelCalls, input_tokens: totals.inputTokens, output_tokens: totals.outputTokens,
      tool_calls: toolCallsUsed, tool_steps: steps.length, model_ms: modelCallsMs,
      dropped_facts: (shaped?.dropped?.facts ?? 0) + verifyDropped, verify_dropped: verifyDropped,
      // Perf pass diagnostics (build spec items 2-4) — counts only, never question/answer content.
      verify_skipped: verifySkipped, prefetch_used: prefetchUsed, memo_hits: toolbox.memoHits,
      early_exit: earlyExitReason, run_ms: Date.now() - runStartedAt,
      // Claim-check diagnostics (R11 build spec item 3) — counts only.
      claim_checked: claimCheckResult?.checked ?? 0, claim_unsupported: claimCheckResult?.unsupported?.length ?? 0,
      claim_removed: (claimCheckResult?.removedSentences ?? 0) + (claimCheckResult?.removedFacts ?? 0),
    })
  );

  return {
    handled,
    data: handled ? shaped.data : null,
    reason,
    providerUnavailable,
    model: RESEARCH_MODEL,
    models: [RESEARCH_MODEL],
    ...totals,
    costUsd,
    steps,
    modelCallsMs,
    queries: toolbox.queries,
    examplesInjected: examples ? examples.split("\nQ: ").length - 1 : 0,
    dropped: shaped ? { ...shaped.dropped, verify: verifyDropped, verifySkipped, claims: (claimCheckResult?.removedSentences ?? 0) + (claimCheckResult?.removedFacts ?? 0) } : null,
    claimCheck: claimCheckResult,
    // Perf pass diagnostics (build spec items 2-4): a prefetch that ran before the first turn, and how
    // many tool calls this run served from the per-request memo instead of re-querying.
    prefetchUsed,
    memoHits: toolbox.memoHits,
    ...(error ? { error } : {}),
  };
}
