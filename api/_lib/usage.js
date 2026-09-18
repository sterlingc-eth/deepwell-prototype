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
 * Record one model call's token usage against a tenant's daily counters.
 *
 * @param {{tenantKey: string}} ctx           same ctx shape withTenant() takes elsewhere in this codebase
 * @param {{inputTokens?: number, outputTokens?: number}} usage
 */
export async function recordModelCall(ctx, { inputTokens = 0, outputTokens = 0 } = {}) {
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
      [tenantUuid, today, Math.max(0, Math.trunc(inputTokens) || 0), Math.max(0, Math.trunc(outputTokens) || 0)]
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
