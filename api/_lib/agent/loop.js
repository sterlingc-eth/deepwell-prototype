/**
 * Donovan agent — the bounded tool-use loop that answers whatever the regex
 * pre-routers and the closed-vocabulary analytics planner could not.
 *
 * Bounds (all enforced in code, none left to the model):
 *   - at most MAX_TURNS (4) model calls; the last is forced to the `answer` tool (the shop's
 *     catalogue is already in the cached system prompt, so exploration rarely needs more);
 *   - a hard cap on cumulative INPUT tokens (default 40k, cache reads/writes
 *     included): past 75% the next call is forced to `answer`, past 100% the run
 *     stops with reason 'token-cap' and yields no answer;
 *   - a wall-clock deadline supplied by the caller;
 *   - temperature 0, small max_tokens, at most 4 tool executions per turn;
 *   - assertModelBudget() is awaited before anything else (throws
 *     ModelBudgetExceededError, same as every other model-billed path);
 *   - each call's usage goes through recordModelCall (usage.js).
 *
 * The model can only READ: see tools.js / sqlGuard.js. Its final `answer` is
 * re-grounded by shape.js before anything reaches the user.
 *
 * No question text, no row values, no model output is ever logged here — only
 * counts (see the single JSON line at the end of runDonovanAgent).
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "../claude.js";
import { assertModelBudget } from "../rateLimit.js";
import { planCacheBreakpoints } from "../promptCache.js";
import { recordModelCall, totalInputTokens, estimateCostUsd } from "../usage.js";
import { ANALYTICS_MODEL } from "../routes/analytics.js";
import { ALL_TOOL_DEFS, ANSWER_TOOL_NAME, VIEW_DOCS, createToolbox } from "./tools.js";
import { shapeAgentAnswer } from "./shape.js";
import { selectWorkedExamples, formatWorkedExamples } from "../learning/recipes.js";

export const AGENT_MODEL = process.env.DONOVAN_AGENT_MODEL || ANALYTICS_MODEL;
export const MAX_TURNS = 4;
export const DEFAULT_INPUT_TOKEN_CAP = 40_000;
const MAX_TOOLS_PER_TURN = 4;
const MAX_OUTPUT_TOKENS = 1200;
const MIN_CALL_BUDGET_MS = 4000;

/** DONOVAN_AGENT=0 disables the whole fallback (default ON). */
export function isAgentEnabled(env = process.env) {
  return env?.DONOVAN_AGENT !== "0";
}

export const AGENT_SYSTEM_PROMPT = `You are Donovan, the records assistant for an HVAC shop. Answer the dispatcher's or owner's question ONLY from tool results in this conversation.
- Never invent a name, date, number, model, serial, address or document. Every number and name in your answer must appear in a tool result.
- Prefer run_query for counts, lists and "who all / which / how many" questions (one well-formed query beats many small ones). Use search_documents for what documents SAY (permit or PO numbers, work performed, notes). Use find_customers then get_customer for one customer or address. A catalogue of this shop's records (entity counts, document types, field keys with examples, service-date range) follows the tools; call describe_data only if it is missing.
- History questions about one customer or address ("has this unit had a compressor replaced", "what was done last visit"): find_customers, then search_documents with that customerId and the key words (compressor, replaced, ...). Answer with the quoted excerpt as a fact citing its documentId and page. If a customer-scoped search returns nothing, use none_found and say what was searched ("No document on file for that address mentions a compressor replacement").
- Lists: one fact per row for EVERY row (up to 40), never a partial list phrased as complete; the total must be in text. If a result says truncated, narrow the query or select fewer columns and run it again.
- If a question could mean two things (documents of a brand: linked to that brand's units, or belonging to customers who own that brand) pick the most natural one and SAY which in text.
- If a query errors, read the error, fix the SQL and retry. Keep tool calls few.
- Warranty status comes from the equipment view's warranty_status / warranty_current columns; never work it out yourself.
- Finish by calling the answer tool exactly once. Lists: one fact per row (label = customer or item, value = the detail), entityId = the customer_id/equipment_id returned. A fact taken from a document cites it in sources. Pure counts and lists from run_query need no sources.
- Money: never total, sum, or estimate dollar amounts (invoices, billing, revenue, cost). Use cannot_answer and say dollar totals are not available yet; you may quote a single amount printed on one cited document.
- If the records cannot answer (a needed field is not captured at all), use status cannot_answer and say plainly what is missing. If the data was searched and there is genuinely nothing, use none_found. Never pad, never guess.
- text is 1-2 plain sentences a dispatcher would say out loud.

${VIEW_DOCS}`;

/** Any change to the model, prompt or tool schemas invalidates cached agent answers. */
export const AGENT_PROMPT_VERSION = createHash("sha256")
  .update(AGENT_MODEL)
  .update(AGENT_SYSTEM_PROMPT)
  .update(JSON.stringify(ALL_TOOL_DEFS))
  .digest("hex")
  .slice(0, 12);

/** Cache key namespace: can never collide with a retrieval or analytics cache row. */
export function agentQuestionHash(question) {
  const n = String(question ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  return createHash("sha256").update(`agent:${n}`).digest("hex");
}

/** Per-tenant catalogue text for the cached system prompt (10-minute window). */
const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const catalogueCache = new Map();
export function resetCatalogueCacheForTests() { catalogueCache.clear(); }

async function loadCatalogue(toolbox, ctxArg) {
  const key = String(ctxArg?.tenantKey ?? "");
  const hit = catalogueCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.text;
  const text = await toolbox.catalogueText();
  if (catalogueCache.size > 200) catalogueCache.clear();
  catalogueCache.set(key, { text, expiresAt: Date.now() + CATALOGUE_TTL_MS });
  return text;
}

async function defaultCallModel(req, { deadlineAt }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return withBackoff(
    () => client.messages.create(req, { timeout: Math.max(1000, deadlineAt - Date.now()) }),
    { deadlineAt }
  );
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

/**
 * @param {object} p
 * @param {Function} p.withTenant  recordsStore.js's withTenant
 * @param {{tenantKey: string, tenantName?: string}} p.ctxArg
 * @param {string} p.question
 * @param {string} p.today  YYYY-MM-DD
 * @param {object} [p.overlay]  the active learned overlay; its `recipes` (approved worked examples) are injected
 *   into the user message, top 3 by question similarity
 * @param {string} [p.hint]  a reviewer's note about a previous wrong answer (thumbs-down), <= 300 chars
 * @param {Function} [p.callModel]  (request, {deadlineAt}) => Anthropic-shaped response. Injectable for tests.
 * @param {number} [p.deadlineAt]  epoch ms
 * @param {{maxTurns?: number, inputTokenCap?: number}} [p.limits]
 * @returns {Promise<{handled: boolean, data: object|null, reason: string, modelCalls: number,
 *   inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number,
 *   costUsd: number, steps: object[], dropped: object|null, error?: string}>}
 */
export async function runDonovanAgent({ withTenant, ctxArg, question, today, overlay, hint, callModel = defaultCallModel, deadlineAt, limits = {} }) {
  // Same daily spend budget every other model call respects. Throws ModelBudgetExceededError.
  await assertModelBudget(ctxArg);

  const maxTurns = Math.max(1, Math.min(MAX_TURNS, limits.maxTurns ?? MAX_TURNS));
  const inputCap = limits.inputTokenCap ?? (Number(process.env.DONOVAN_AGENT_MAX_INPUT_TOKENS) || DEFAULT_INPUT_TOKEN_CAP);
  const deadline = deadlineAt ?? Date.now() + 30_000;

  const toolbox = createToolbox({ withTenant, ctxArg, today });
  const totals = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const steps = [];
  const records = [];
  let reason = "";
  let finalInput = null;
  let error;

  // The shop's catalogue rides in the cached system prompt (per-tenant, 10-minute window) instead of a
  // model round that calls describe_data. A failure here only costs the shortcut, never the run.
  let catalogue = "";
  try { catalogue = await loadCatalogue(toolbox, ctxArg); } catch { catalogue = ""; }
  const systemBlocks = [{ block: { type: "text", text: AGENT_SYSTEM_PROMPT }, breakpoint: true }];
  if (catalogue) systemBlocks.push({ block: { type: "text", text: `CATALOGUE of this shop's records (JSON, refreshed every few minutes):\n${catalogue}` }, breakpoint: true });
  const { tools, system } = planCacheBreakpoints(
    {
      tools: ALL_TOOL_DEFS.map((block, i) => ({ block, breakpoint: i === ALL_TOOL_DEFS.length - 1 })),
      system: systemBlocks,
    },
    AGENT_MODEL
  );

  const examples = formatWorkedExamples(selectWorkedExamples(overlay?.recipes, question, 3));
  const note = typeof hint === "string" && hint.trim()
    ? `\n\nREVIEWER NOTE (the previous answer to this question was marked wrong; take this into account, but every fact must still come from tool results): ${hint.trim().slice(0, 300)}`
    : "";
  const messages = [{ role: "user", content: [{ type: "text", text: `Today's date: ${today}\n\n${examples}QUESTION: ${question}${note}` }] }];

  try {
    let nudged = false;
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (totals.inputTokens >= inputCap) { reason = "token-cap"; break; }
      if (deadline - Date.now() < MIN_CALL_BUDGET_MS) { reason = "deadline"; break; }

      const forceAnswer = turn === maxTurns || totals.inputTokens >= inputCap * 0.75 || nudged;
      const resp = await callModel(
        {
          model: AGENT_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          system,
          tools,
          tool_choice: forceAnswer ? { type: "tool", name: ANSWER_TOOL_NAME } : { type: "auto" },
          messages,
        },
        { deadlineAt: deadline }
      );
      const u = usageOf(resp);
      totals.modelCalls++;
      totals.inputTokens += totalInputTokens(u);
      totals.outputTokens += u.outputTokens;
      totals.cacheReadInputTokens += u.cacheReadInputTokens;
      totals.cacheCreationInputTokens += u.cacheCreationInputTokens;
      records.push(recordModelCall(ctxArg, u));

      const content = Array.isArray(resp?.content) ? resp.content : [];
      const uses = content.filter((b) => b?.type === "tool_use");
      const answer = uses.find((b) => b.name === ANSWER_TOOL_NAME);
      if (answer) { finalInput = answer.input ?? {}; reason = "answered"; break; }

      if (!uses.length) {
        // Text with no tool call: nudge once toward the answer tool, then give up.
        if (nudged) { reason = "no-tool"; break; }
        nudged = true;
        messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no answer)" }] });
        messages.push({ role: "user", content: [{ type: "text", text: "Use the answer tool now." }] });
        continue;
      }

      messages.push({ role: "assistant", content });
      const results = [];
      for (const use of uses.slice(0, MAX_TOOLS_PER_TURN)) {
        const r = await toolbox.execute(use.name, use.input);
        steps.push({ tool: use.name, inputSummary: r.inputSummary, rowCount: r.rowCount, ms: r.ms, ...(r.ok ? {} : { error: true }) });
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
      }
      for (const extra of uses.slice(MAX_TOOLS_PER_TURN)) {
        results.push({ type: "tool_result", tool_use_id: extra.id, content: "ERROR: too many tool calls in one turn", is_error: true });
      }
      messages.push({ role: "user", content: results });
      if (turn === maxTurns) reason = "turn-cap";
    }
    if (!reason) reason = "turn-cap";
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") throw err;
    reason = "error";
    error = String(err?.message ?? err).slice(0, 200);
  }
  await Promise.allSettled(records);

  let shaped = null;
  if (finalInput) shaped = shapeAgentAnswer(finalInput, toolbox.ledger, { question, today });
  const costUsd = estimateCostUsd({ inputTokens: totals.inputTokens, outputTokens: totals.outputTokens });
  const handled = Boolean(shaped?.answered);

  console.log(
    JSON.stringify({
      route: "ask", agent: true, model: AGENT_MODEL, reason, handled,
      model_calls: totals.modelCalls, input_tokens: totals.inputTokens, output_tokens: totals.outputTokens,
      cache_read: totals.cacheReadInputTokens, tool_steps: steps.length,
      dropped_facts: shaped?.dropped.facts ?? 0, dropped_sources: shaped?.dropped.sources ?? 0,
    })
  );

  return {
    handled,
    data: handled ? shaped.data : null,
    reason,
    ...totals,
    costUsd,
    steps,
    queries: toolbox.queries,
    examplesInjected: examples ? examples.split("\nQ: ").length - 1 : 0,
    dropped: shaped?.dropped ?? null,
    ...(error ? { error } : {}),
  };
}

/** The operator-only trace attached as data.debug (never for a normal tenant). */
export function agentDebugTrace(result) {
  return {
    steps: (result.steps ?? []).map((s) => ({ tool: s.tool, inputSummary: s.inputSummary, rowCount: s.rowCount, ms: s.ms })),
    modelCalls: result.modelCalls,
    ...(result.examplesInjected ? { examplesInjected: result.examplesInjected } : {}),
    ...(result.fastReplay ? { fastReplay: true } : {}),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  };
}
