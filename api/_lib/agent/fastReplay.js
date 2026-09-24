/**
 * Donovan agent - exact-match recipe fast replay.
 *
 * When the incoming question equals an ACTIVE single-query recipe's normalized question, the recipe's
 * SQL is re-executed FRESH through the same guard + tenant transaction + read-only + timeout as any
 * model-written query (tools.js runQuery) and the answer is composed by code from the rows with the
 * recipe's template, then re-grounded by shape.js like every other agent answer. No model call, so no
 * cost and no allowance use (the caller skips incrementAsksThisMonth).
 *
 * Anything that differs (query rejected/failed, columns changed, no rows, answer not groundable)
 * returns {handled: false} and the caller falls back to the normal agent - never a wrong answer.
 */
import { createToolbox } from "./tools.js";
import { shapeAgentAnswer } from "./shape.js";
import { composeFromRecipe } from "../learning/recipes.js";
// TEAM C: the replayed query's rows are the citation records, same as a live agent run.
import { citeAgentData } from "../citations/agent.js";

/**
 * @returns {Promise<{handled: boolean, data: object|null, reason: string, fastReplay: true, steps: object[], modelCalls: 0,
 *   inputTokens: 0, outputTokens: 0, costUsd: 0}>}
 */
export async function runRecipeFastPath({ withTenant, ctxArg, recipe, question, today }) {
  const base = { fastReplay: true, modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0, steps: [], queries: [] };
  const miss = (reason) => ({ ...base, handled: false, data: null, reason });
  try {
    const toolbox = createToolbox({ withTenant, ctxArg, today });
    const started = Date.now();
    const r = await toolbox.runRecipeQuery(recipe.sqls[0]);
    base.steps.push({ tool: "run_query", inputSummary: "query:recipe", rowCount: r.rowCount ?? 0, ms: Date.now() - started, ...(r.ok ? {} : { error: true }) });
    if (!r.ok) return miss("query-failed");
    const composed = composeFromRecipe(recipe, r.columns, r.rows ?? []);
    if (!composed.ok) return miss(composed.reason);
    const shaped = shapeAgentAnswer(composed.input, toolbox.ledger, { question, today });
    if (!shaped.answered) return miss("not-grounded");
    const data = await citeAgentData({ withTenant, ctxArg, data: shaped.data, ledger: toolbox.ledger, input: composed.input });
    return { ...base, handled: true, data, reason: "recipe", queries: toolbox.queries };
  } catch {
    return miss("error");
  }
}
