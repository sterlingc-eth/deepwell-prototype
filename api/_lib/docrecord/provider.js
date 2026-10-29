/** The real model call, behind the same provider abstraction extractDocument.js uses (getApiKey / withBackoff / withCache / recordModelCall). Imported only by the upload hook. */
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff, providerFailureMessage } from "../claude.js";
import { withCache } from "../promptCache.js";
import { RECORD_TOOL } from "./schema.js";

export const RECORD_MODEL = process.env.DOCRECORD_MODEL || process.env.EXTRACT_MODEL || "claude-haiku-4-5";
export const messageFor = providerFailureMessage;

/** @param {{modelAttempts?:number}} [o]  queue callers pass 1 so one layer of retry owns a 429 (same rule as extractDocument.js) */
export function makeAnthropicProvider({ modelAttempts } = {}) {
  return async function provider({ system, user, repair }) {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
    const content = repair?.length
      ? `${user}\n\nYour previous record had values whose span was NOT found verbatim on the named page, or totals that do not add up. Return the complete record again. Drop any value you cannot copy exactly from the page. Problems:\n${JSON.stringify(repair)}`
      : user;
    const response = await withBackoff(() => client.messages.create({
      model: RECORD_MODEL, max_tokens: 6000,
      system: [withCache({ type: "text", text: system }, RECORD_MODEL, { ttl: "1h" })],
      tools: [withCache(RECORD_TOOL, RECORD_MODEL)], tool_choice: { type: "tool", name: RECORD_TOOL.name },
      messages: [{ role: "user", content }],
    }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt, attempts: modelAttempts });
    const tu = response.content.find((b) => b.type === "tool_use");
    return { input: tu?.input ?? {}, usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens, cacheReadInputTokens: response.usage?.cache_read_input_tokens, cacheCreationInputTokens: response.usage?.cache_creation_input_tokens } };
  };
}
