/**
 * Donovan training-plan Day 2 "miss loop" (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * every /api/ask outcome that answers HONESTLY rather than with a real fact —
 * a no-answer, a money/maintenance/"can't filter by X yet" fallback, a
 * contact lookup that matched zero or more than one customer, or an
 * analytics plan the executor rejected — gets a row here so the weekly
 * review has something to look at besides Vercel logs. A 402/429 gate hit is
 * NOT a miss (no answer was even attempted) and nothing here is ever called
 * for one — see api/ask.js's call sites, all of which are past the gate/limit
 * checks.
 *
 * TOLERANT OF THE TABLE NOT EXISTING: M3-config/23-ask-misses.sql may lag a
 * deploy (no DDL happens automatically — see the repo's own constraint), so
 * every write here is caught and, once, warned about — never thrown, never a
 * failed ask. `warnedMissingTable` is a module-level (per-process) flag so a
 * busy tenant doesn't spam the same warning on every request; a fresh
 * container gets to warn once too.
 *
 * FIRE-AND-FORGET: every call site in api/ask.js either awaits this AFTER the
 * response has already been sent (inside the same post-response bookkeeping
 * block that already writes the ask-cache/usage rows — see that file), or
 * fires it with no await at all for the couple of pre-response fall-through
 * points where nothing else is being awaited yet either. Either way a slow or
 * failed miss write never delays, and never fails, the customer's answer.
 */
import { withTenant } from './recordsStore.js';

/** Outcome codes this file writes — the single source of truth api/ask.js,
 *  api/review.js and scripts/miss-review.mjs all import rather than
 *  hand-typing the strings. */
export const MISS_OUTCOMES = {
  NO_ANSWER: 'no-answer',
  MONEY_FALLBACK: 'money-fallback',
  MAINTENANCE_FALLBACK: 'maintenance-fallback',
  UNSUPPORTED_CONDITION: 'unsupported-condition',
  CONTACT_ZERO: 'contact-lookup-zero',
  CONTACT_AMBIGUOUS: 'contact-lookup-ambiguous',
  ANALYTICS_FALLTHROUGH: 'analytics-fallthrough',
  // Item 1/7 (100-question persona sample, 2026-09-22): doc-lookup's own zero-
  // candidate miss, distinct from contact-lookup's — see api/ask.js's
  // doc-lookup pre-router and analytics.js's parseCrossDocCondition.
  DOC_LOOKUP_ZERO: 'doc-lookup-zero',
  CROSS_DOC_UNSUPPORTED: 'cross-doc-unsupported',
  // Donovan agent fallback (api/_lib/agent/): the bounded tool-use loop ran and
  // ALSO could not answer. `outcome` is a plain TEXT column (23-ask-misses.sql
  // has no CHECK on it), so a new code needs no DDL.
  AGENT_NO_ANSWER: 'agent-no-answer',
  // A user's thumbs-down on an answer (api/review.js askFeedback): a correction miss.
  USER_MARKED_WRONG: 'user-marked-wrong',
};

const MAX_QUESTION_CHARS = 300;

function truncate(s) {
  const str = String(s ?? '');
  return str.length > MAX_QUESTION_CHARS ? str.slice(0, MAX_QUESTION_CHARS) : str;
}

/** {entity, op, filters:[{field,op}]} — the SHAPE of a plan, never a filter
 *  VALUE (a filter value is often a customer's own city/name; see the
 *  migration file's own doc comment for why this table deliberately leaves
 *  values out). Returns null for no plan at all (most miss outcomes have none). */
function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    entity: plan.entity ?? null,
    op: plan.op ?? null,
    groupBy: plan.groupBy ?? null,
    filters: Array.isArray(plan.filters) ? plan.filters.map((f) => ({ field: f?.field ?? null, op: f?.op ?? null })) : [],
  };
}

function toConditionsArray(conditions) {
  if (!conditions) return [];
  if (conditions instanceof Set) return [...conditions];
  if (Array.isArray(conditions)) return conditions;
  return [];
}

let warnedMissingTable = false;

/**
 * Insert one miss row against an ALREADY tenant-scoped `db` (a
 * recordsStore.js store — the same convention usage.js's
 * incrementAsksThisMonth(db, ...) uses), so a caller already inside a
 * withTenant transaction (e.g. api/ask.js's post-response bookkeeping block)
 * reuses that same connection instead of opening a second one. Never throws.
 */
export async function insertAskMiss(db, { question, questionNormalized, outcome, detectedConditions, plan } = {}) {
  if (!db || !outcome) return;
  // SAVEPOINT: this runs inside the caller's withTenant transaction. If the
  // table is missing (migration 23 not yet run) the failed INSERT must not
  // abort that transaction and silently roll back the audit / usage rows
  // written around it — same idiom as ask.js's cache upsert.
  let savepoint = false;
  try {
    await db.raw("SAVEPOINT ask_miss_insert", []);
    savepoint = true;
    await db.raw(
      `INSERT INTO ask_misses (tenant_id, question, question_normalized, outcome, detected_conditions, plan_summary)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        truncate(question),
        truncate(questionNormalized ?? question),
        outcome,
        JSON.stringify(toConditionsArray(detectedConditions)),
        JSON.stringify(summarizePlan(plan)),
      ]
    );
    await db.raw("RELEASE SAVEPOINT ask_miss_insert", []);
  } catch (err) {
    if (savepoint) await db.raw("ROLLBACK TO SAVEPOINT ask_miss_insert", []).catch(() => {});
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn(
        'ask_misses write failed (miss logging disabled for this process; run M3-config/23-ask-misses.sql):',
        err?.message
      );
    }
  }
}

/**
 * Convenience wrapper for a call site with no tenant-scoped `db` already in
 * hand — opens its own withTenant, same as any other one-off write in this
 * codebase. Callers that already have a `db` (inside an existing withTenant
 * block) should call insertAskMiss(db, ...) directly instead of nesting a
 * second transaction. Never throws; the caller is free to not await this at
 * all (true fire-and-forget) for a pre-response fall-through point where
 * nothing else is being awaited either.
 */
export async function recordAskMiss(ctxArg, opts) {
  try {
    await withTenant(ctxArg, (db) => insertAskMiss(db, opts));
  } catch (err) {
    // withTenant itself failing (pool exhausted, bad ctxArg) is exactly as
    // non-fatal here as insertAskMiss's own catch — miss logging must never
    // take down or slow down an ask.
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn('ask_misses write failed (miss logging disabled for this process):', err?.message);
    }
  }
}

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Owner/admin miss report: the last 200 miss rows for this tenant, grouped by
 * outcome with a count and the top 20 distinct normalized questions per
 * group (by how often each was asked within those 200 rows). Returns an
 * empty report (never throws) when the table doesn't exist yet.
 *
 * `days`, when given (the Team screen's "Donovan misses" card passes 7),
 * additionally restricts to rows from the last N days — still capped at 200,
 * never more. Omitted entirely, this is exactly the brief's own "last 200
 * misses" contract with no date bound at all.
 */
export async function missReport(ctxArg, { days } = {}) {
  return withTenant(ctxArg, async (db) => {
    let rows;
    try {
      const n = Number(days);
      const sinceClause = Number.isFinite(n) && n > 0 ? `AND created_at >= NOW() - ($1 || ' days')::interval` : '';
      const params = sinceClause ? [n] : [];
      const result = await db.raw(
        `SELECT outcome, question, question_normalized, created_at
           FROM ask_misses
          WHERE ${TENANT_SQL} ${sinceClause}
          ORDER BY created_at DESC
          LIMIT 200`,
        params
      );
      rows = result.rows;
    } catch (err) {
      console.warn('missReport: ask_misses read failed (table may not exist yet):', err?.message);
      return { total: 0, groups: [] };
    }

    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.outcome)) groups.set(row.outcome, { outcome: row.outcome, count: 0, questions: new Map() });
      const g = groups.get(row.outcome);
      g.count += 1;
      const key = row.question_normalized || row.question;
      g.questions.set(key, (g.questions.get(key) ?? 0) + 1);
    }

    const out = [...groups.values()]
      .map((g) => ({
        outcome: g.outcome,
        count: g.count,
        topQuestions: [...g.questions.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([text, count]) => ({ text, count })),
      }))
      .sort((a, b) => b.count - a.count);

    return { total: rows.length, groups: out };
  });
}

/** outcome -> the route a bank entry generated from it should be tagged with
 *  — scripts/gen-question-bank.mjs / scripts/miss-review.mjs's own
 *  `expect.route` vocabulary (analytics / retrieval / contact-lookup). Not
 *  every outcome maps to a route worth re-testing (e.g. a genuine no-answer
 *  might just mean the corpus has nothing on that topic yet) — those fall
 *  back to 'retrieval', the safest generic guess for a human reviewer to
 *  correct rather than skip. */
const OUTCOME_SUGGESTED_ROUTE = {
  [MISS_OUTCOMES.NO_ANSWER]: 'retrieval',
  [MISS_OUTCOMES.MONEY_FALLBACK]: 'analytics',
  [MISS_OUTCOMES.MAINTENANCE_FALLBACK]: 'analytics',
  [MISS_OUTCOMES.UNSUPPORTED_CONDITION]: 'analytics',
  [MISS_OUTCOMES.CONTACT_ZERO]: 'contact-lookup',
  [MISS_OUTCOMES.CONTACT_AMBIGUOUS]: 'contact-lookup',
  [MISS_OUTCOMES.ANALYTICS_FALLTHROUGH]: 'analytics',
  [MISS_OUTCOMES.DOC_LOOKUP_ZERO]: 'doc-lookup',
  [MISS_OUTCOMES.CROSS_DOC_UNSUPPORTED]: 'analytics',
};

/**
 * Export shape for scripts/miss-review.mjs / the question bank: one row per
 * DISTINCT normalized question (first-seen wins, most-recent-first source
 * order) across the last 500 misses, {text, suggestedRoute}. Owner/admin
 * only, tenant-scoped — same gate as missReport (see api/review.js).
 */
export async function exportMisses(ctxArg) {
  return withTenant(ctxArg, async (db) => {
    let rows;
    try {
      const result = await db.raw(
        `SELECT question, question_normalized, outcome
           FROM ask_misses
          WHERE ${TENANT_SQL}
          ORDER BY created_at DESC
          LIMIT 500`,
        []
      );
      rows = result.rows;
    } catch (err) {
      console.warn('exportMisses: ask_misses read failed (table may not exist yet):', err?.message);
      return { items: [] };
    }

    const seen = new Set();
    const items = [];
    for (const row of rows) {
      const text = row.question_normalized || row.question;
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push({ text, suggestedRoute: OUTCOME_SUGGESTED_ROUTE[row.outcome] ?? 'retrieval' });
    }
    return { items };
  });
}
