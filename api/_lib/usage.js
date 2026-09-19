/**
 * Model-call usage accounting, separate from request rate limiting
 * (./rateLimit.js counts REQUESTS; this counts what those requests actually
 * spent on the model).
 *
 * NOT WIRED IN by this change — recordDocument/extractDocument/ask.js and
 * friends are owned by other engineers and are not edited here. The exact
 * call sites another engineer needs to add are written out in HANDOFF.md at
 * the repo root. This file exists so that work is a one-line addition at each
 * call site rather than a new subsystem someone has to design under time
 * pressure later.
 */
import { getAuxPool } from "./apiKeyAuth.js";

/**
 * Pure arithmetic recordModelCall uses to fold cache tokens into the single
 * input-token number increment_usage_counters accepts — pulled out to its
 * own export so scripts/verify-caching.mjs can assert it directly, with no
 * database. See recordModelCall's doc comment for why folding is the right
 * call here instead of a schema change.
 */
export function totalInputTokens({ inputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = {}) {
  return (
    Math.max(0, Math.trunc(inputTokens) || 0) +
    Math.max(0, Math.trunc(cacheReadInputTokens) || 0) +
    Math.max(0, Math.trunc(cacheCreationInputTokens) || 0)
  );
}

/**
 * Record one model call's token usage against a tenant's daily counters.
 *
 * @param {{tenantKey: string}} ctx           same ctx shape withTenant() takes elsewhere in this codebase
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number}} usage
 *   cacheReadInputTokens / cacheCreationInputTokens: from the Anthropic
 *   response's `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`
 *   (prompt caching — see api/_lib/promptCache.js). EXTENDED for that here
 *   (was inputTokens/outputTokens only) rather than adding a new DB column:
 *   increment_usage_counters (M3-config/*.sql) takes one input-token number
 *   and this repo's agent cannot touch migrations, so a cache read or cache
 *   write — which IS an input token billed at a different rate, per
 *   Anthropic's own usage object — is folded into that same total. This
 *   keeps usage_counters.model_input_tokens an honest total cost figure; it
 *   does NOT let a future usage dashboard show a cache-hit rate from this
 *   table alone. That needs its own columns — see handoffs/HANDOFF-B.md —
 *   which is why every call site ALSO emits a structured per-call log line
 *   with the cache fields broken out, so Vercel logs have that breakdown
 *   even though the daily counters don't.
 */
export async function recordModelCall(
  ctx,
  { inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = {}
) {
  const tenantKey = ctx?.tenantKey;
  if (!tenantKey) return; // nothing to attribute this call to

  try {
    const { rows } = await getAuxPool().query("SELECT resolve_tenant($1, $2) AS id", [
      tenantKey,
      ctx.tenantName ?? tenantKey,
    ]);
    const tenantUuid = rows[0]?.id;
    if (!tenantUuid) return;

    const today = new Date().toISOString().slice(0, 10);
    await getAuxPool().query(
      "SELECT * FROM increment_usage_counters($1, $2::date, 0, 1, $3, $4)",
      [
        tenantUuid,
        today,
        totalInputTokens({ inputTokens, cacheReadInputTokens, cacheCreationInputTokens }),
        Math.max(0, Math.trunc(outputTokens) || 0),
      ]
    );
  } catch (err) {
    // Usage accounting must never be the reason a model call that already
    // succeeded is reported as a failure to the caller — log and move on.
    console.error("usage: could not record model call:", err?.message);
  }
}

/**
 * Read back `days` of daily counters for a tenant — the data a future usage
 * dashboard would render. Not called from anywhere yet.
 *
 * @param {{tenantKey: string}} ctx
 * @param {number} [days]
 * @returns {Promise<{day: string, requests: number, modelCalls: number, modelInputTokens: number, modelOutputTokens: number}[]>}
 */
export async function getUsage(ctx, days = 30) {
  const tenantKey = ctx?.tenantKey;
  if (!tenantKey) return [];

  try {
    const { rows: tRows } = await getAuxPool().query("SELECT resolve_tenant($1, $2) AS id", [
      tenantKey,
      ctx.tenantName ?? tenantKey,
    ]);
    const tenantUuid = tRows[0]?.id;
    if (!tenantUuid) return [];

    const { rows } = await getAuxPool().query("SELECT * FROM get_usage_counters($1, $2)", [tenantUuid, days]);
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
      requests: r.requests,
      modelCalls: r.model_calls,
      modelInputTokens: Number(r.model_input_tokens),
      modelOutputTokens: Number(r.model_output_tokens),
    }));
  } catch (err) {
    console.error("usage: could not read usage counters:", err?.message);
    return [];
  }
}
