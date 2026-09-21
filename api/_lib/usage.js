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
 * List prices, dollars per million tokens, for the two model families this
 * codebase calls (see claude.js/ask.js/extractDocument.js/readDocument.js).
 * Override via env if pricing changes rather than editing this file.
 */
export const MODEL_PRICE_PER_MTOK = {
  haiku: {
    input: Number(process.env.AI_COST_HAIKU_INPUT_PER_MTOK ?? 1),
    output: Number(process.env.AI_COST_HAIKU_OUTPUT_PER_MTOK ?? 5),
  },
  sonnet: {
    input: Number(process.env.AI_COST_SONNET_INPUT_PER_MTOK ?? 3),
    output: Number(process.env.AI_COST_SONNET_OUTPUT_PER_MTOK ?? 15),
  },
};

/**
 * What fraction of a tenant's billed tokens are Haiku vs. Sonnet, for
 * estimateCostUsd below. usage_counters (increment_usage_counters) has no
 * per-model column — see recordModelCall's own doc comment on why cache
 * tokens are folded into one input-token number instead of a schema change —
 * so this file cannot know the REAL split for a given tenant without adding
 * one. Ask and extraction default to Haiku; transcription's fast pass also
 * defaults to Haiku, with only its (comparatively rare) Sonnet escalation
 * pass pulling the mix toward Sonnet. HAIKU_SHARE is a documented estimate of
 * that mix, not a measurement — override via env if a tenant's real mix is
 * known to differ (e.g. TRANSCRIBE_MODEL pinned to Sonnet for everything).
 */
const HAIKU_SHARE = Math.min(1, Math.max(0, Number(process.env.AI_COST_HAIKU_SHARE ?? 0.85)));

/**
 * Estimate a dollar cost for a tenant's billed token totals. This is an
 * ESTIMATE, not a bill: it blends Haiku/Sonnet list prices by HAIKU_SHARE
 * rather than reading which model each token actually billed to (that split
 * isn't stored — see HAIKU_SHARE's own comment) and it prices cache-read/
 * cache-write tokens at the same rate as a full-price input token, when
 * Anthropic actually bills a cache read cheaper and a cache write more (see
 * promptCache.js) — both of those tokens are already folded into one number
 * before they reach here (totalInputTokens), so this can't distinguish them
 * either. Good enough for a "roughly how much is this tenant costing us"
 * figure on a billing screen; not good enough for a per-tenant invoice.
 */
export function estimateCostUsd({ inputTokens = 0, outputTokens = 0 } = {}) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const blendedInputPerMtok = HAIKU_SHARE * MODEL_PRICE_PER_MTOK.haiku.input + (1 - HAIKU_SHARE) * MODEL_PRICE_PER_MTOK.sonnet.input;
  const blendedOutputPerMtok = HAIKU_SHARE * MODEL_PRICE_PER_MTOK.haiku.output + (1 - HAIKU_SHARE) * MODEL_PRICE_PER_MTOK.sonnet.output;
  const usd = (inTok * blendedInputPerMtok + outTok * blendedOutputPerMtok) / 1_000_000;
  return Math.round(usd * 10000) / 10000; // 4 decimal places — this is cents-and-fractions money, not dollars
}

/**
 * Read back `days` of daily counters for a tenant. Used by billing.js's
 * `status` action to fold into `aiCostEstimateUsd` (see estimateCostUsd
 * above) — and available for a future usage dashboard to render directly.
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

/**
 * Monthly question allowance (owner decision, 2026-09-21): a % meter per
 * plan that resets on the 1st UTC, replacing the old daily ask cap (see
 * rateLimit.js's PLAN_DAILY_ASKS, now a 30%-of-monthly runaway guard instead
 * of the primary limit).
 *
 * WHY THIS DOESN'T LIVE IN usage_counters: that table (10-api-keys.sql) has
 * no bucket dimension — `requests`/`model_calls` are incremented by every
 * bucket (ask, ingest, read) alike (see limit()/recordModelCall's own doc
 * comments), so summing it by day would count a bulk document import as
 * "questions asked". No migration is available to add a bucket column
 * (no-DDL constraint), so this reuses rate_limit_windows
 * (12-rate-limit-window.sql) instead: same (tenant, bucket, window_start)
 * primary key the per-minute burst limiter already has, just with `bucket =
 * 'ask_month'` and `window_start` truncated to the MONTH rather than the
 * minute. That table is already FORCE ROW LEVEL SECURITY with a tenant_id
 * policy, so plain SQL through a withTenant `db` (RLS already scoped by
 * app.tenant_id) is enough — no new SECURITY DEFINER function needed, unlike
 * the burst limiter's own increment_rate_limit_window (which runs on the
 * aux pool, OUTSIDE any tenant transaction, so it has no other way to pass
 * RLS). One row per tenant per month persists after this build (nothing
 * purges last month's row); at one row per tenant per month that's a few
 * dozen rows a year — never worth its own cleanup job.
 */
const ASK_MONTH_BUCKET = "ask_month";

/** Pure: the first instant of `now`'s UTC month. Exported for tests with no
 *  clock/database — scripts/verify-scale.mjs. */
export function monthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Pure: the first instant of the UTC month AFTER `now`'s — the reset point
 *  a % meter counts down to. Correct across a December -> January rollover
 *  because Date.UTC normalizes month 12 into January of year+1 itself. */
export function nextMonthStartUtc(now = new Date()) {
  const d = monthStartUtc(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** "2026-10-01" — the ISO date billing.js's status payload reports as
 *  usage.resetsOn. */
export function resetsOnIso(now = new Date()) {
  return nextMonthStartUtc(now).toISOString().slice(0, 10);
}

/** "Oct 1" — the human label gateAsk's 402 message and the client's banners
 *  use (owner correction, 2026-09-21: short month everywhere, matching the
 *  client's own resetsOnShortLabel). Month name via Intl (no new
 *  dependency); UTC so this never drifts a day depending on the server's
 *  local timezone. */
export function resetsOnLabel(now = new Date()) {
  const d = nextMonthStartUtc(now);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}

/**
 * Which answer sources actually reached the model and therefore count
 * against the monthly allowance (owner rule, 2026-09-21): cache hits, the
 * meta-router, fast path, and no-evidence no-answers are all free; the
 * retrieval+Haiku answer and the analytics planner's tool-use call are not,
 * REGARDLESS of what kind of answer either one ends up producing (a model
 * call that comes back "no-answer" still spent the call). Pure and exported
 * so the rule itself — not just its call sites — is unit tested (see
 * scripts/verify-scale.mjs).
 */
export const COUNTABLE_ASK_SOURCES = Object.freeze(["model", "analytics-model"]);
export function isCountableAskSource(source) {
  return COUNTABLE_ASK_SOURCES.includes(source);
}

/**
 * Read this tenant's count of countable questions so far this UTC month.
 * `db` is a recordsStore.js store (has `.raw`), called from INSIDE a
 * withTenant transaction — RLS (already scoped to app.tenant_id) is what
 * makes the plain SELECT below safe against rate_limit_windows' FORCE RLS,
 * the same way askCache.js's raw queries already rely on it.
 */
export async function getAsksThisMonth(db, now = new Date()) {
  try {
    const { rows } = await db.raw(
      `SELECT units FROM rate_limit_windows
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
          AND bucket = $1 AND window_start = $2::timestamptz`,
      [ASK_MONTH_BUCKET, monthStartUtc(now).toISOString()]
    );
    return Number(rows[0]?.units) || 0;
  } catch (err) {
    // Same fail-open principle as every other usage/limit read in this
    // codebase: a broken read must not turn into "block every question" —
    // see gateAsk's own cap check, which treats this as 0 asked so far.
    console.error("usage: could not read asksThisMonth (failing open, reporting 0):", err?.message);
    return 0;
  }
}

/**
 * Record one countable question against this tenant's monthly allowance.
 * Called ONLY at the point a question actually reached the model (see
 * isCountableAskSource above) — never from limit()'s per-request burst/daily
 * accounting, which fires for every request regardless of what answered it.
 * Best-effort: a failed write here must not turn an already-answered
 * question into a failed request for the customer.
 */
export async function incrementAsksThisMonth(db, now = new Date()) {
  try {
    await db.raw(
      `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::timestamptz, 1)
       ON CONFLICT (tenant_id, bucket, window_start)
       DO UPDATE SET units = rate_limit_windows.units + 1`,
      [ASK_MONTH_BUCKET, monthStartUtc(now).toISOString()]
    );
  } catch (err) {
    console.error("usage: could not increment asksThisMonth:", err?.message);
  }
}
