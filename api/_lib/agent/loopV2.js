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
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "../claude.js";
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

/** Sonnet by default (owner decision, 2026-09-25: "Sonnet as the default research agent for anything
 *  non-trivial; NO Opus"). Reuses escalation.js's model id rather than a second copy of it. */
export const RESEARCH_MODEL = process.env.DONOVAN_RESEARCH_MODEL || escalationModel();
export const MAX_TURNS_V2 = 8;
/** Cumulative tool EXECUTIONS across the whole run (several in one turn still count individually). */
export const MAX_TOOL_CALLS_V2 = 15;
export const DEFAULT_INPUT_TOKEN_CAP_V2 = 120_000;
const MAX_TOOLS_PER_TURN_V2 = 4;
const MAX_OUTPUT_TOKENS_V2 = 1400;
const MIN_CALL_BUDGET_MS = 4000;
export const DEFAULT_DEADLINE_MS_V2 = Number(process.env.DONOVAN_AGENT_DEADLINE_MS) || 240_000; // must stay below vercel.json maxDuration (300 s on Pro)
export const TOOL_CONCURRENCY_V2 = Math.max(1, Math.min(MAX_TOOLS_PER_TURN_V2, Number(process.env.DONOVAN_RESEARCH_TOOL_CONCURRENCY) || 3));

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
- Call several independent tools in the SAME turn when you already know you need them (searching two different things, reading two documents that do not depend on each other, one query per side of a comparison) — they run concurrently and reach the answer faster. Only chain calls one at a time when a later call genuinely needs an id or value an earlier one returned.
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

  async function runTurns(turnBudget) {
    let nudged = false;
    for (let turn = 1; turn <= turnBudget; turn++) {
      if (totals.inputTokens >= inputCap) { reason = "token-cap"; return; }
      if (toolCallsUsed >= maxToolCalls) { reason = "tool-cap"; return; }
      if (deadline - Date.now() < MIN_CALL_BUDGET_MS) { reason = "deadline"; return; }

      const forceAnswer = turn === turnBudget || totals.inputTokens >= inputCap * 0.75 || toolCallsUsed >= maxToolCalls - 1 || nudged;
      const modelStarted = Date.now();
      const resp = await callModel(
        {
          model: RESEARCH_MODEL, max_tokens: MAX_OUTPUT_TOKENS_V2, temperature: 0, system, tools,
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
        return { type: "tool_result", tool_use_id: use.id, content: r.content, ...(r.ok ? {} : { is_error: true }) };
      });
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
    reason = "error";
    error = String(err?.message ?? err).slice(0, 200);
  }

  let shaped = null;
  if (finalInput) shaped = shapeAgentAnswer(finalInput, toolbox.ledger, { question, today });

  // ---- verify step (build spec item 3): re-check every cited fact against its OWN cited page/field,
  // not just the run's whole evidence corpus (shape.js already did that broader check above). One
  // bounded re-research turn is allowed when something gets dropped and there is still time/turn/tool
  // budget left, so a fixable gap ("I have the doc, I just cited the wrong page") gets one more chance
  // before the answer goes out short a fact.
  let verifyDropped = 0;
  if (shaped?.answered && shaped.data?.kind === "answer" && shaped.data.facts?.length) {
    emit("verify", "Cross-checking each fact against its source…");
    const fetchSourceText = createDbSourceFetcher({ withTenant, ctxArg });
    const first = await verifyFacts(shaped.data, fetchSourceText);
    verifyDropped = first.droppedCount;
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
        }
      } else {
        reason = "verify-retry-exhausted";
      }
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
    })
  );

  return {
    handled,
    data: handled ? shaped.data : null,
    reason,
    model: RESEARCH_MODEL,
    models: [RESEARCH_MODEL],
    ...totals,
    costUsd,
    steps,
    modelCallsMs,
    queries: toolbox.queries,
    examplesInjected: examples ? examples.split("\nQ: ").length - 1 : 0,
    dropped: shaped ? { ...shaped.dropped, verify: verifyDropped } : null,
    ...(error ? { error } : {}),
  };
}
