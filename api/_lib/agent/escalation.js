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
export const DEFAULT_ESCALATION_MODEL = "claude-sonnet-4-5";
export const escalationModel = (env = process.env) => env?.DONOVAN_ESCALATION_MODEL || DEFAULT_ESCALATION_MODEL;

export const DEFAULT_SONNET_DAILY_USD = 2;
export const MIN_ESCALATION_MS = 10_000;
export const SONNET_BUCKET = "sonnet_usd_micro";

export const isEscalationEnabled = (env = process.env) => env?.DONOVAN_ESCALATION !== "0";

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
  return null;
}

/* ------------------------------------------------------------------ daily Sonnet spend (per tenant) */

const utcDayStart = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/** USD of Sonnet spend recorded for this tenant today. Returns null when it cannot be read (fail closed). */
export async function sonnetSpentTodayUsd(withTenant, ctxArg, now = Date.now()) {
  try {
    const { rows } = await withTenant(ctxArg, (db) => db.raw(
      `SELECT units FROM rate_limit_windows
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = $1 AND window_start = $2::timestamptz`,
      [SONNET_BUCKET, utcDayStart(now)]));
    return (Number(rows[0]?.units) || 0) / 1_000_000;
  } catch {
    return null;
  }
}

/** Add `usd` to this tenant's Sonnet spend for today. Best-effort, never throws. */
export async function recordSonnetSpend(withTenant, ctxArg, usd, now = Date.now()) {
  const micro = Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));
  if (!micro) return false;
  try {
    await withTenant(ctxArg, (db) => db.raw(
      `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::timestamptz, $3)
       ON CONFLICT (tenant_id, bucket, window_start)
       DO UPDATE SET units = LEAST(2000000000, rate_limit_windows.units + EXCLUDED.units)`,
      [SONNET_BUCKET, utcDayStart(now), micro]));
    return true;
  } catch {
    return false;
  }
}

/** True when this tenant may still start a Sonnet run today. */
export async function sonnetAllowed(withTenant, ctxArg, env = process.env, now = Date.now()) {
  if (!isEscalationEnabled(env)) return { allowed: false, why: "disabled" };
  const cap = sonnetDailyCapUsd(env);
  if (cap <= 0) return { allowed: false, why: "cap-zero" };
  const spent = await sonnetSpentTodayUsd(withTenant, ctxArg, now);
  if (spent === null) return { allowed: false, why: "spend-unreadable" };
  if (spent >= cap) return { allowed: false, why: "daily-cap", spentUsd: spent, capUsd: cap };
  return { allowed: true, spentUsd: spent, capUsd: cap };
}
