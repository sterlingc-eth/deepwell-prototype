/**
 * Donovan Scorecard - the rubric grader: ONE cheap Haiku call, used only for questions with no
 * deterministic oracle (free-text history / notes questions). Strict rubric, temperature 0, forced tool
 * output, tiny max_tokens. The reference material is what the oracle SQL pulled from the shop's own tables.
 * Spend is recorded like any other model call. Injectable `callModel` for tests. No text is logged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff, classifyProviderError, recordProviderOutage } from "../claude.js";
import { recordModelCall, estimateModelCostUsd } from "../usage.js";

export const GRADER_MODEL = process.env.DONOVAN_SCORECARD_GRADER_MODEL || "claude-haiku-4-5";

const GRADE_TOOL = {
  name: "grade",
  description: "Record the verdict.",
  input_schema: {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      reason: { type: "string", description: "One short sentence." },
    },
    required: ["pass", "reason"],
  },
};

// TEAM K (2026-09-25, R5_FAILS.md "maintenance-due 1/5 ... invents customer names"): the grader
// used to see ONLY a capped, alphabetically-truncated REFERENCE sample (e.g. the oracle's own
// "first 15" rows) with no way to tell a real name the sample happened to cut off from a genuine
// fabrication - it judged "not in REFERENCE" as "invented". RECORDS below is the deterministic
// citation list the answer itself attaches (api/_lib/citations/records.js): every name there is
// backed by an actual document/customer row in the shop's own data, independent of whatever
// REFERENCE's own SQL happened to sample. The grader now treats REFERENCE as a (possibly partial)
// sample to check CONSISTENCY against, and RECORDS as the ground truth for WHICH names are real.
const SYSTEM = `You are a strict grader for an HVAC shop's records assistant. You get a QUESTION, a RUBRIC, REFERENCE facts pulled straight from the shop's database (a SAMPLE of matching rows, not necessarily the complete list - a name absent from it is not by itself evidence of fabrication), the RECORDS the answer itself cites (each one backed by an actual document or customer row in the shop's own files - a name appearing here is grounded, whether or not REFERENCE repeats it), and the assistant's ANSWER.
Pass only if the ANSWER meets every requirement in the RUBRIC and does not CONTRADICT the REFERENCE, and every fact it states is supported by REFERENCE or RECORDS (or is plain arithmetic/wording over them). Fail only a fact backed by NEITHER REFERENCE NOR RECORDS - never a name merely missing from a capped REFERENCE sample when RECORDS backs it. If REFERENCE and RECORDS are both empty, the only correct answer is that nothing is on file (an answer that invents details then fails). A vague or evasive answer to a question the reference can answer fails. Call the grade tool once.`;

const clip = (s, n) => String(s ?? "").slice(0, n);

async function defaultCallModel(req, { deadlineAt }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return withBackoff(() => client.messages.create(req, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
}

/**
 * @param {string[]} [p.citedRecords]  the answer's OWN citation records (records[].label + sublabel,
 *   from api/_lib/citations/records.js), formatted as short lines - independent ground truth for which
 *   named entities are real, since REFERENCE alone may be a capped/truncated sample (TEAM K, see SYSTEM above).
 * @returns {Promise<{passed: boolean, reason: string, costUsd: number, error?: string}>}
 */
export async function gradeRubric({ ctxArg, question, rubric, reference, answerText, citedRecords, callModel = defaultCallModel, deadlineAt = Date.now() + 20_000 }) {
  const refText = (reference ?? []).map((r) => `- ${clip(r, 300)}`).join("\n").slice(0, 2500) || "(empty: nothing on file)";
  const recordsText = (citedRecords ?? []).length ? `\n\nRECORDS THE ANSWER CITES (each backed by a real document/customer row):\n${(citedRecords ?? []).map((r) => `- ${clip(r, 200)}`).join("\n").slice(0, 2000)}` : "";
  const user = `QUESTION: ${clip(question, 300)}\n\nRUBRIC: ${clip(rubric, 400)}\n\nREFERENCE (sample from the database, not necessarily complete):\n${refText}${recordsText}\n\nANSWER:\n${clip(answerText, 1200)}`;
  try {
    const resp = await callModel(
      {
        model: GRADER_MODEL, max_tokens: 200, temperature: 0,
        system: [{ type: "text", text: SYSTEM }],
        tools: [GRADE_TOOL], tool_choice: { type: "tool", name: "grade" },
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      },
      { deadlineAt }
    );
    const u = resp?.usage ?? {};
    const usage = { inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0, cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0, cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0 };
    await recordModelCall(ctxArg, { ...usage, model: GRADER_MODEL });
    const costUsd = estimateModelCostUsd(GRADER_MODEL, usage);
    const use = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === "grade");
    if (!use) return { passed: false, reason: "grader gave no verdict", costUsd, error: "no-verdict" };
    return { passed: use.input?.pass === true, reason: clip(use.input?.reason, 200), costUsd };
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") throw err;
    const provider = classifyProviderError(err);
    if (provider) {
      recordProviderOutage(provider);
      return { passed: false, reason: "provider unavailable", costUsd: 0, error: "provider-unavailable", providerUnavailable: true };
    }
    return { passed: false, reason: "grader failed", costUsd: 0, error: String(err?.name ?? "error") };
  }
}
