/**
 * Donovan agent - Sonnet escalation for hard questions (owner-approved, 2026-09-23).
 *
 * Haiku stays the default model. The agent loop (loop.js) runs on the escalation model (Sonnet) instead
 * when, in this order:
 *   (c) the caller forces it: a thumbs-down replay or a scorecard retry (`escalate: true`);
 *   (a) a cheap deterministic classifier (classifyQuestionDifficulty, below) marks the question hard:
 *       comparisons, "why", trends, negation stacked on conditions, multi-entity joins, multiple
 *       conditions, or an ambiguous pronoun-only reference;
 *   (b) the Haiku run finished badly (needsEscalation, below): no answer / cannot_answer, two failed or
 *       guard-rejected SQL statements, or the grounding pass dropped facts the model tried to state.
 *
 * Guard rails, all enforced in code: DONOVAN_ESCALATION=0 turns the whole thing off; a per-tenant DAILY
 * Sonnet spend cap (DONOVAN_SONNET_DAILY_USD, default $2; 0 disables Sonnet) after which every question
 * stays on Haiku until the next UTC day; an escalation never starts with less than MIN_ESCALATION_MS left
 * on the request's deadline; the monthly allowance counts an escalated ask ONCE (ask.js increments once per
 * ask, not per model call).
 *
 * The daily Sonnet spend lives in rate_limit_windows (bucket 'sonnet_usd_micro', one row per tenant per UTC
 * day, units = micro-dollars) - an existing table, already FORCE-RLS, so no migration is needed. Every read/
 * write here fails CLOSED for spend (an unreadable counter means "cap reached"): Sonnet is never used
 * unmetered.
 *
 * Nothing here logs question text.
 */

/** The model the loop escalates to. Env-overridable; defaults to the Sonnet id readDocument.js documents. */
export const DEFAULT_ESCALATION_MODEL = "claude-sonnet-5-5";
export const escalationModel = (env = process.env) => env?.DONOVAN_ESCALATION_MODEL || DEFAULT_ESCALATION_MODEL;

export const DEFAULT_SONNET_DAILY_USD = 2;
export const MIN_ESCALATION_MS = 10_000;
export const SONNET_BUCKET = "sonnet_usd_micro";

export const isEscalationEnabled = (env = process.env) => env?.DONOVAN_ESCALATION !== "0";

/* ------------------------------------------------------------------ TIERED MODEL POLICY (owner directive 2026-10-30)
 * Haiku is the default for EVERYTHING. Sonnet is a gated escalation reachable ONLY from the designated paths
 * (agent/loop.js, agent/loopV2.js and, when wired, readDocument's hard-page fallback). Never audits, support, learning or the demo.
 * Budgets (all env-overridable, all fail closed => the Haiku answer stands or Donovan declines):
 *   monthly per tenant by plan   DONOVAN_SONNET_MONTHLY_USD_<SOLO|SHOP|CREW|FLEET|TRIAL>  solo 6, shop(Team) 9, crew 14, fleet 35, trial 1 total
 *   daily per tenant             monthly / 8 (DONOVAN_SONNET_DAILY_USD, if set explicitly, wins)
 *   platform-wide daily          DONOVAN_SONNET_PLATFORM_DAILY_USD, default $10 (sum of every tenant's Sonnet buckets that UTC day)
 *   per question                 1 Sonnet attempt, 40k input tokens, 1.5k output tokens => hard stop about $0.095 at $2/$10 per MTok
 */
export const HAIKU_MODEL = "claude-haiku-4-5";
export const SONNET_MONTHLY_USD = Object.freeze({ solo: 6, shop: 9, crew: 14, fleet: 35, trial: 1, demo: 0 });
export const SONNET_DAILY_DIVISOR = 8;
export const DEFAULT_PLATFORM_SONNET_DAILY_USD = 10;
export const QUESTION_SONNET_INPUT_CAP = 40_000;
export const QUESTION_SONNET_OUTPUT_CAP = 1_500;
export const QUESTION_SONNET_HARD_STOP_USD = 0.095;
export const SONNET_BUCKETS = Object.freeze(["sonnet_usd_micro", "research_usd_micro"]);
const nonNeg = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n >= 0 ? n : null; };

/** Monthly Sonnet cap for a plan (unknown plan => 0, fail closed). Trial billing_status wins over plan. */
export function sonnetMonthlyCapUsd(plan, billingStatus, env = process.env) {
  const key = /trial/i.test(String(billingStatus ?? "")) ? "trial" : String(plan ?? "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SONNET_MONTHLY_USD, key)) return 0;
  return nonNeg(env?.[`DONOVAN_SONNET_MONTHLY_USD_${key.toUpperCase()}`]) ?? SONNET_MONTHLY_USD[key];
}
export const sonnetDailyCapForPlanUsd = (plan, billingStatus, env = process.env) =>
  nonNeg(env?.DONOVAN_SONNET_DAILY_USD) ?? sonnetMonthlyCapUsd(plan, billingStatus, env) / SONNET_DAILY_DIVISOR;
export const platformSonnetDailyUsd = (env = process.env) => nonNeg(env?.DONOVAN_SONNET_PLATFORM_DAILY_USD) ?? DEFAULT_PLATFORM_SONNET_DAILY_USD;

/** Pure gate decision. null/undefined spend => deny (fail closed). */
export function decideSonnet({ plan, billingStatus, spentDayUsd, spentMonthUsd, spentPlatformDayUsd, env = process.env }) {
  const monthCap = sonnetMonthlyCapUsd(plan, billingStatus, env);
  if (monthCap <= 0) return { allowed: false, why: "plan-no-sonnet" };
  const dayCap = sonnetDailyCapForPlanUsd(plan, billingStatus, env);
  const platCap = platformSonnetDailyUsd(env);
  for (const v of [spentDayUsd, spentMonthUsd, spentPlatformDayUsd]) if (v === null || v === undefined || !Number.isFinite(v)) return { allowed: false, why: "spend-unreadable" };
  if (spentMonthUsd >= monthCap) return { allowed: false, why: "monthly-cap", spentUsd: spentMonthUsd, capUsd: monthCap };
  if (spentDayUsd >= dayCap) return { allowed: false, why: "daily-cap", spentUsd: spentDayUsd, capUsd: dayCap };
  if (spentPlatformDayUsd >= platCap) return { allowed: false, why: "platform-cap", spentUsd: spentPlatformDayUsd, capUsd: platCap };
  return { allowed: true, spentUsd: spentDayUsd, capUsd: dayCap, monthCapUsd: monthCap, platformCapUsd: platCap };
}

/** One structured, question-free line per escalation decision, so the escalation rate (target < 3% of handoffs) can be measured from logs. */
export function logEscalation(event) {
  try { console.log(JSON.stringify({ route: "escalation", ts: new Date().toISOString(), ...event })); } catch { /* logging only */ }
}

export function sonnetDailyCapUsd(env = process.env) {
  const raw = env?.DONOVAN_SONNET_DAILY_USD;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SONNET_DAILY_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SONNET_DAILY_USD;
}

/* ------------------------------------------------------------------ hard-question classifier */

const RULES = [
  { id: "why", points: 2, re: /\bwhy\b|\bhow come\b|\bwhat(?:'s| is) (?:causing|the reason)\b/i },
  { id: "trend", points: 2, re: /\b(?:trend(?:ing|s)?|over time|year[- ]over[- ]year|month[- ]over[- ]month|growing|grew|declin\w*|increas\w*|decreas\w*|dropp?ed|climb\w*|per month|by month|monthly|quarter over quarter)\b/i },
  { id: "comparison", points: 2, re: /\b(?:vs\.?|versus|compared? (?:to|with)|comparison|difference between|(?:more|less|fewer|greater|higher|lower|older|newer|bigger|smaller) than|best|worst|top \d+|bottom \d+)\b/i },
  // Team A (2026-09-24): "more X or more Y" carries no "than", so the rule above missed it; a full-file request
  // ("what do we have on file for X", "everything on X") needs several tools and a summary, not one lookup.
  { id: "comparison", points: 2, re: /\b(?:more|fewer|less|greater)\s+[a-z][a-z /&-]{1,40}?\s+(?:or|vs\.?|versus)\s+/i },
  { id: "file-summary", points: 2, re: /\b(?:what(?:'s| do we have| have we got| is there)?\s+on file (?:for|on|about)|everything (?:we have )?(?:on|about|for)|full (?:file|history|picture))\b/i },
  { id: "negation", points: 1, re: /\b(?:no|not|never|without|except|excluding|other than|haven'?t|hasn'?t|hadn'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|missing|lack(?:s|ing)?)\b/i },
  { id: "ambiguous", points: 1, re: /^\s*(?:and |what about |how about |same for )?(?:them|those|these|that one|this one|it|the other one|the same)\b|\b(?:of those|of them|the ones)\b/i },
];
const ENTITY_WORDS = [
  /\b(?:customers?|clients?|accounts?|homeowners?)\b/i,
  /\b(?:units?|systems?|equipment|furnaces?|condensers?|compressors?|air handlers?|heat pumps?)\b/i,
  /\b(?:documents?|invoices?|permits?|work orders?|tickets?|agreements?|contracts?|quotes?|proposals?|warranty registrations?)\b/i,
  /\b(?:technicians?|techs?)\b/i,
];
const CONDITION_WORDS = /\b(?:warrant\w*|expired|expiring|installed|older|newer|in [A-Z][a-z]+|brand|trane|carrier|goodman|lennox|rheem|york|daikin|mitsubishi|agreement|permit|last (?:year|month|week)|this (?:year|month)|since|before|after|between)\b/gi;

/**
 * Pure. {hard, points, reasons[]}: hard when the questions scores >= 2 points. Cheap on purpose (one pass of
 * regexes) so it can run on every agent-bound question; a false positive costs one Sonnet run (capped per
 * day), a false negative is caught by needsEscalation's after-the-fact triggers.
 */
export function classifyQuestionDifficulty(question) {
  const q = String(question ?? "").trim();
  const reasons = [];
  let points = 0;
  if (!q) return { hard: false, points, reasons };
  for (const r of RULES) {
    if (r.re.test(q)) { points += r.points; reasons.push(r.id); }
  }
  const entityKinds = ENTITY_WORDS.filter((re) => re.test(q)).length;
  const conditionCount = (q.match(CONDITION_WORDS) ?? []).length;
  const joiners = (q.match(/\b(?:and|but|or|whose|that (?:have|had|are|were)|who (?:have|had|are|were)|which (?:have|had))\b/gi) ?? []).length;
  if (entityKinds >= 2 && joiners >= 1) { points += 2; reasons.push("multi-entity"); }
  if (conditionCount >= 3 && joiners >= 1) { points += 2; reasons.push("multi-condition"); }
  else if (conditionCount >= 2 && joiners >= 2) { points += 1; reasons.push("multi-condition"); }
  if (q.split(/\s+/).length > 28) { points += 1; reasons.push("long"); }
  return { hard: points >= 2, points, reasons };
}

/* ------------------------------------------------------------------ after-the-fact triggers */

const NO_ANSWER_REASONS = new Set(["answered", "no-tool", "turn-cap", "token-cap"]);

/**
 * Pure. Why a finished Haiku run should be retried on the escalation model, or null.
 *  - no answer: the loop ended without a groundable answer (cannot_answer, an ungrounded answer, no tool
 *    call, or it ran out of turns/tokens) - never on "error"/"deadline"/"agent-disabled", where a second
 *    model would not help or there is no time;
 *  - sql-rejected-twice: two or more run_query steps errored (the SQL guard rejected them, or they failed);
 *  - grounding-dropped-facts: it answered, but shape.js had to drop facts the model tried to state.
 */
export function needsEscalation(run) {
  if (!run) return null;
  if (!run.handled && NO_ANSWER_REASONS.has(run.reason)) return "no-answer";
  const badQueries = (run.steps ?? []).filter((s) => s.tool === "run_query" && s.error).length;
  if (badQueries >= 2) return "sql-rejected-twice";
  if (run.handled && (run.dropped?.facts ?? 0) > 0) return "grounding-dropped-facts";
  // Unsure / failed verification on a multi-step (2+ tool calls = cross-record) question.
  if ((run.steps ?? []).length >= 2 && ((run.dropped?.verify ?? 0) > 0 || (run.dropped?.claims ?? 0) > 0)) return "verification-failed";
  return null;
}

/* ------------------------------------------------------------------ daily Sonnet spend (per tenant) */

const utcDayStart = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/** USD of Sonnet spend recorded for this tenant today. Returns null when it cannot be read (fail closed).
 *  `bucket` (Donovan v2 research agent, 2026-09-25): defaults to SONNET_BUCKET so every existing call
 *  keeps reading/writing the escalation counter unchanged; the research agent (agent/loopV2.js) passes
 *  its own bucket so its daily spend cap is tracked separately from Haiku-run escalation spend. */
export async function sonnetSpentTodayUsd(withTenant, ctxArg, now = Date.now(), bucket = SONNET_BUCKET) {
  try {
    const { rows } = await withTenant(ctxArg, (db) => db.raw(
      `SELECT units FROM rate_limit_windows
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = $1 AND window_start = $2::timestamptz`,
      [bucket, utcDayStart(now)]));
    return (Number(rows[0]?.units) || 0) / 1_000_000;
  } catch {
    return null;
  }
}

/** Add `usd` to this tenant's Sonnet spend for today. Best-effort, never throws. See bucket note above. */
export async function recordSonnetSpend(withTenant, ctxArg, usd, now = Date.now(), bucket = SONNET_BUCKET) {
  const micro = Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));
  if (!micro) return false;
  try {
    await withTenant(ctxArg, (db) => db.raw(
      `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::timestamptz, $3)
       ON CONFLICT (tenant_id, bucket, window_start)
       DO UPDATE SET units = LEAST(2000000000, rate_limit_windows.units + EXCLUDED.units)`,
      [bucket, utcDayStart(now), micro]));
    return true;
  } catch {
    return false;
  }
}

/** True when this tenant may still start a Sonnet run. Plan-gated (monthly + daily + platform) unless a caller passes its own `capUsd`
 *  (planner/spend.js's Haiku ledgers) and not `planGated`. FAILS CLOSED on any unreadable counter. */
export async function sonnetAllowed(withTenant, ctxArg, env = process.env, now = Date.now(), { capUsd, bucket = SONNET_BUCKET, planGated } = {}) {
  if (!isEscalationEnabled(env)) return { allowed: false, why: "disabled" };
  const gated = planGated ?? capUsd === undefined;
  if (!gated) {
    const cap = capUsd ?? sonnetDailyCapUsd(env);
    if (cap <= 0) return { allowed: false, why: "cap-zero" };
    const spent = await sonnetSpentTodayUsd(withTenant, ctxArg, now, bucket);
    if (spent === null) return { allowed: false, why: "spend-unreadable" };
    if (spent >= cap) return { allowed: false, why: "daily-cap", spentUsd: spent, capUsd: cap };
    return { allowed: true, spentUsd: spent, capUsd: cap };
  }
  try {
    const day = utcDayStart(now);
    const monthStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).toISOString();
    const t = await withTenant(ctxArg, async (db) => {
      const p = await db.raw(`SELECT plan, billing_status FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`, []);
      const d = await db.raw(`SELECT COALESCE(SUM(units),0) AS u FROM rate_limit_windows WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = ANY($1) AND window_start = $2::timestamptz`, [SONNET_BUCKETS, day]);
      const m = await db.raw(`SELECT COALESCE(SUM(units),0) AS u FROM rate_limit_windows WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = ANY($1) AND window_start >= $2::timestamptz`, [SONNET_BUCKETS, monthStart]);
      return { plan: p.rows[0]?.plan, billingStatus: p.rows[0]?.billing_status, day: Number(d.rows[0]?.u) / 1e6, month: Number(m.rows[0]?.u) / 1e6 };
    });
    let platform = null;
    try {
      const { getAuxPool } = await import("../apiKeyAuth.js");
      const r = await getAuxPool().query(`SELECT COALESCE(SUM(units),0) AS u FROM rate_limit_windows WHERE bucket = ANY($1) AND window_start = $2::timestamptz`, [SONNET_BUCKETS, day]);
      platform = Number(r.rows[0]?.u) / 1e6;
    } catch { platform = null; }
    return decideSonnet({ plan: t.plan, billingStatus: t.billingStatus, spentDayUsd: t.day, spentMonthUsd: t.month, spentPlatformDayUsd: platform, env });
  } catch {
    return { allowed: false, why: "spend-unreadable" };
  }
}
