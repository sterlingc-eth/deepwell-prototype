/**
 * ROUND 20 (J4, credit-return readiness), task 2.
 *
 * Nothing here is a new spend-tracking MECHANISM — every dollar figure reuses usage.js's
 * estimateModelCostUsd (the exact arithmetic recordModelCall's own cost figures already use), and every
 * per-tenant DAILY cap reuses agent/escalation.js's sonnetAllowed/recordSonnetSpend, which — despite the
 * "sonnet" name — already take an arbitrary `bucket` and `capUsd` (agent/loopV2.js's own research agent
 * already proves this: it tracks its OWN daily cap under RESEARCH_BUCKET, entirely separate from
 * escalation.js's own SONNET_BUCKET, through that exact same generalized function). This file is the
 * thin, named layer that lets any OTHER model-billed route this codebase has (or gets — the owner
 * decision this round names a future Haiku planner + Sonnet research-agent split) get its own
 * independently-configured daily $ ledger for free, in the SAME `rate_limit_windows` table every one of
 * those already uses — no migration, no new DB code.
 *
 * Layered on top of, never a replacement for, the two existing guards every billed call site already
 * respects:
 *   - assertModelBudget/ModelBudgetExceededError (rateLimit.js): a per-tenant daily CALL-COUNT cap,
 *     already asserted once per /api/ask request (ask.js) before the analytics planner or any agent ever
 *     runs — this file adds a DOLLAR dimension alongside it, not instead of it.
 *   - agent/loopV2.js's own per-question INPUT TOKEN cap (DEFAULT_INPUT_TOKEN_CAP_V2) and turn/tool-call/
 *     deadline caps — the enforced per-question ceiling for the research agent already exists; see
 *     `perQuestionCapUsd` below for translating it into an approximate dollar figure for reporting.
 *
 * Every function here FAILS OPEN exactly like every other budget/limit read in this codebase
 * (getDailyModelBudgetStatus, sonnetAllowed, getAsksThisMonth, ...): a lookup failure, or simply no
 * tenant context to check against, must never be the reason a question goes unanswered — it means "no
 * extra cap today", never "nothing works today".
 */
import { estimateModelCostUsd, MODEL_PRICE_PER_MTOK } from '../usage.js';
import { sonnetAllowed, recordSonnetSpend, SONNET_BUCKET } from '../agent/escalation.js';
import { ModelBudgetExceededError } from '../rateLimit.js';

// Deliberately NOT `import ... from "../agent/loopV2.js"` for its RESEARCH_BUCKET/model/token-cap
// constants, even though that would be the more DRY-looking one-liner: agent/loopV2.js is one of the
// specific modules ask.js keeps behind a dynamic import() precisely because it (transitively, via
// tools.js/verify.js/citations/industry/learning) pulls in @anthropic-ai/sdk and a large module tree —
// see scripts/verify-cold-start.mjs's own doc comment. This file is imported from planAnalyticsQuestion
// (routes/analytics.js), which itself is ALSO one of those dynamic-only modules — routes/analytics.js
// loading, on every plain analytics question, the entire agent tree just to read one string constant
// would quietly reintroduce the exact per-request cost that round's fix removed, just one hop deeper.
// The bucket name is DATA, not logic, so it is safe to name it again here, guarded by the pairing test
// in scripts/verify-spend-control.mjs, which imports both modules and asserts the two literals match.
const RESEARCH_BUCKET = 'research_usd_micro';

/**
 * One entry per model-billed route this file knows how to meter. `bucket` is the rate_limit_windows
 * bucket name (case must never collide with an unrelated bucket some other feature already uses —
 * `_usd_micro` suffix matches escalation.js's/loopV2.js's own naming). `envVar`/`defaultUsd` follow the
 * exact same "env-overridable, sane default" shape escalation.js's sonnetDailyCapUsd already
 * establishes. `escalation`/`research` are listed here (reusing THEIR OWN existing bucket/env names, not
 * new ones) purely so a caller of this file — scripts/model-ab.mjs's cost report, in particular — can
 * name every route's cap from ONE map instead of importing escalation.js and loopV2.js separately for
 * the same idea; recording/checking spend for those two routes should still go through their own
 * existing exports directly (agent/loopV2.js and agent/loop.js already do), not through this file's
 * assertDailySpend/recordDailySpend, so there is exactly one writer per bucket.
 */
export const ROUTE_BUCKETS = Object.freeze({
  analyticsPlanner: { bucket: 'analytics_usd_micro', envVar: 'DONOVAN_ANALYTICS_DAILY_USD', defaultUsd: 1 },
  retrieval: { bucket: 'retrieval_usd_micro', envVar: 'DONOVAN_RETRIEVAL_DAILY_USD', defaultUsd: 5 },
  escalation: { bucket: SONNET_BUCKET, envVar: 'DONOVAN_SONNET_DAILY_USD', defaultUsd: 2 },
  research: { bucket: RESEARCH_BUCKET, envVar: 'DONOVAN_RESEARCH_DAILY_USD', defaultUsd: 10 },
  // Round 28: the Support Assistant's per-tenant daily $ cap (its Haiku path only; the FAQ path costs $0).
  // NOTE: support/limits.js reads/writes this bucket through escalation.js's sonnetSpentTodayUsd/
  // recordSonnetSpend directly, NOT through assertDailySpend above — assertDailySpend goes through
  // sonnetAllowed, which returns "disabled" whenever DONOVAN_ESCALATION=0, and turning Sonnet escalation off
  // must never silently turn the support assistant's cap into "always denied".
  support: { bucket: 'support_usd_micro', envVar: 'SUPPORT_DAILY_USD', defaultUsd: 0.5 },
});

/** This route's daily $ cap: its own env var if set (and a valid non-negative number), else its default. */
export function dailyCapUsd(route, env = process.env) {
  const cfg = ROUTE_BUCKETS[route];
  if (!cfg) return Infinity; // an unknown route name is never metered — see assertDailySpend's own note
  const raw = env?.[cfg.envVar];
  if (raw === undefined || raw === null || raw === '') return cfg.defaultUsd;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : cfg.defaultUsd;
}

/**
 * Throws ModelBudgetExceededError (the SAME class every existing catch site in this codebase already
 * recognizes by name — queue.js, loop.js, loopV2.js, the scorecard runner, learning/replay.js, every
 * routes/*.js — so wiring a NEW route through this function needs no new catch site anywhere) when this
 * tenant's spend for `route` today is already at or past its cap. Returns the allowance status
 * otherwise, mirroring assertModelBudget's own "return the status, in case a caller wants it" shape.
 *
 * `withTenant`/`ctxArg` are the same (fn, ctx) pair every other tenant-scoped read in this codebase
 * takes. Either missing (a caller that has no tenant context handy yet) skips the check entirely and
 * returns `{allowed: true, skipped: true}` — fail OPEN, per this file's own doc comment; a route that
 * wants the cap enforced simply has to pass its real tenant context, which is a one-line change at that
 * route's own call site (see handoffs/CREDIT_RETURN_PLAYBOOK.md for the analytics-planner one).
 */
export async function assertDailySpend(withTenant, ctxArg, route, env = process.env) {
  const cfg = ROUTE_BUCKETS[route];
  if (!cfg || !withTenant || !ctxArg) return { allowed: true, skipped: true };
  const status = await sonnetAllowed(withTenant, ctxArg, env, Date.now(), { capUsd: dailyCapUsd(route, env), bucket: cfg.bucket });
  if (!status.allowed) {
    throw new ModelBudgetExceededError(`Daily AI budget reached for ${route} — resumes tomorrow`);
  }
  return status;
}

/** Record `usd` of spend against this tenant's `route` ledger for today. Best-effort (never throws —
 *  same principle as recordSonnetSpend/recordModelCall: usage accounting must never turn an
 *  already-succeeded model call into a failed request). No-op (and returns false) for an unknown route,
 *  a missing tenant context, or a non-positive amount. */
export async function recordDailySpend(withTenant, ctxArg, route, usd) {
  const cfg = ROUTE_BUCKETS[route];
  if (!cfg || !withTenant || !ctxArg || !(Number(usd) > 0)) return false;
  return recordSonnetSpend(withTenant, ctxArg, usd, Date.now(), cfg.bucket);
}

/* ============================================================ per-question budget
 *
 * A single question's spend, independent of any tenant/DB context (pure — usable the moment a model
 * response comes back, before any daily-cap bookkeeping runs). loopV2.js already enforces its OWN
 * per-question ceiling as a TOKEN count (DEFAULT_INPUT_TOKEN_CAP_V2); `perQuestionCapUsd` below is that
 * same ceiling expressed as an approximate dollar figure — for reporting/alerting, not a second cap to
 * enforce (enforcing it a second time, in dollars, on top of the token cap that already bounds the same
 * quantity would just be re-implementing loopV2's own logic worse).
 */
export const DEFAULT_PER_QUESTION_MAX_USD = Number(process.env.DONOVAN_PER_QUESTION_MAX_USD) || 0.5;

/**
 * Approximately what a per-question INPUT TOKEN ceiling costs in dollars, for ONE route/model — e.g.
 * "a 120k-input-token cap is worth about $0.36 before any output tokens", for a cost report or the
 * credit-return playbook. Never fed back into any loop as an enforced limit — `model`/`inputTokenCap`
 * are REQUIRED (no default tied to one specific route) precisely so this stays a reporting helper for
 * whichever route's own already-enforced token cap the caller names, not a second, competing cap of its
 * own; see agent/loopV2.js's own DEFAULT_INPUT_TOKEN_CAP_V2/RESEARCH_MODEL for the research agent's real
 * numbers (not imported here — see the RESEARCH_BUCKET note above on why this file avoids that module).
 */
export function perQuestionCapUsd(model, inputTokenCap) {
  return estimateModelCostUsd(model, { inputTokens: inputTokenCap });
}

/** True while `spentUsd` (this question's running total so far) is still under `capUsd` — a caller with
 *  a multi-call loop (a future planner-plus-verify pass, say) checks this BETWEEN calls to decide
 *  whether one more call is still affordable; false means "stop and answer from what you have" rather
 *  than an error, matching this codebase's "decline honestly, don't fail the request" preference. */
export function withinPerQuestionBudget(spentUsd, capUsd = DEFAULT_PER_QUESTION_MAX_USD) {
  return Number(spentUsd) < capUsd;
}

/* ============================================================ $/question reporting
 *
 * "report estimated $/question by route" (task 2's own wording): one small, structured object per
 * model call, safe to `console.log(JSON.stringify(...))` exactly like promptCache.js's own
 * modelCallLogLine (no question text, no row values — counts and a route/model label only), and safe to
 * feed straight into scripts/model-ab.mjs's own per-category $/question rollup.
 */
export function routeCostReport({ route, model, usage = {} } = {}) {
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
  const cacheReadInputTokens = Math.max(0, Number(usage.cacheReadInputTokens) || 0);
  const cacheCreationInputTokens = Math.max(0, Number(usage.cacheCreationInputTokens) || 0);
  const costUsd = estimateModelCostUsd(model, { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });
  const billedInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    route: typeof route === 'string' ? route : 'unknown',
    model: typeof model === 'string' ? model : 'unknown',
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read: cacheReadInputTokens,
    cache_creation: cacheCreationInputTokens,
    // Share of this call's BILLED input that was a cache read — 0 when the call carried no
    // cache_control at all (never divides by zero: billedInputTokens is 0 only when every count is 0,
    // and 0/0 here reports as 0, not NaN).
    cache_read_share: billedInputTokens > 0 ? Math.round((cacheReadInputTokens / billedInputTokens) * 1000) / 1000 : 0,
  };
}

/** List prices this file's cost estimates are built from — re-exported so a report/playbook can print
 *  "at current list prices" without importing usage.js separately for the same constant. */
export { MODEL_PRICE_PER_MTOK };
