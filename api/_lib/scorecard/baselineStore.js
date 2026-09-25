/**
 * Donovan Scorecard - CLAUDE BASELINE persistence (TEAM T3, 2026-09-25).
 *
 * A baseline answer is cached per (tenant, exam version, question id) so bumping the exam does not mean
 * re-running the whole baseline, and an answer the operator already paid for is never repeated (build item
 * 2: "baseline runs cached per exam version so they're not repeated"). Backed by audit_log (every deploy
 * already has it, same fallback discipline as store.js) with an in-process Map as the last resort. No
 * migration is required: `resource_id` is a UUID column, so the (examVersion, questionId) pair is hashed
 * into a deterministic UUID (never a real random one - the SAME pair always maps to the SAME row, which is
 * exactly what "get-or-run-once" caching needs) rather than adding a lookup table.
 *
 * `backend` on every return value says which store answered: 'audit' | 'memory'.
 */
import { createHash } from "node:crypto";
import { withTenant } from "../recordsStore.js";

const ACTION = "donovan.scorecard_baseline";
const memory = new Map(); // tenantKey -> Map<"examVersion:questionId", record>

export function resetBaselineStoreForTests() { memory.clear(); }

/** Pure: a stable, deterministic UUID-shaped key for one (examVersion, questionId) pair. */
export function baselineKey(examVersion, questionId) {
  const h = createHash("sha1").update(`${examVersion}:${questionId}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const memMap = (ctxArg) => memory.get(ctxArg.tenantKey) ?? memory.set(ctxArg.tenantKey, new Map()).get(ctxArg.tenantKey);

/**
 * @returns {Promise<object|null>} the cached record {questionId, examVersion, answer, passed, score, costUsd,
 *   latencyMs, model, citedDocumentIds, at} or null when nothing is cached yet.
 */
export async function getBaseline(ctxArg, examVersion, questionId) {
  const key = baselineKey(examVersion, questionId);
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `SELECT changes FROM audit_log WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND action = $1 AND resource_id = $2::uuid ORDER BY created_at DESC LIMIT 1`,
        [ACTION, key]);
      return rows[0]?.changes?.record ?? null;
    });
  } catch {
    return memMap(ctxArg).get(`${examVersion}:${questionId}`) ?? null;
  }
}

/** Persist one baseline answer, replacing any prior one for the same (examVersion, questionId). */
export async function saveBaseline(ctxArg, examVersion, questionId, record) {
  const key = baselineKey(examVersion, questionId);
  try {
    await withTenant(ctxArg, (db) => db.logAction({ action: ACTION, resource_type: "scorecard-baseline", resource_id: key, changes: { record } }));
    return { backend: "audit" };
  } catch {
    memMap(ctxArg).set(`${examVersion}:${questionId}`, record);
    return { backend: "memory" };
  }
}

/** Every cached baseline record for one exam version (for the per-category gap report). Bounded to the exam's own size. */
export async function listBaselines(ctxArg, examVersion, questionIds) {
  const wanted = new Set(questionIds ?? []);
  try {
    return await withTenant(ctxArg, async (db) => {
      const keys = [...wanted].map((id) => baselineKey(examVersion, id));
      if (!keys.length) return [];
      const { rows } = await db.raw(
        `SELECT DISTINCT ON (resource_id) resource_id, changes FROM audit_log
          WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND action = $1 AND resource_id = ANY($2::uuid[])
          ORDER BY resource_id, created_at DESC`,
        [ACTION, keys]);
      return rows.map((r) => r.changes?.record).filter(Boolean);
    });
  } catch {
    const m = memMap(ctxArg);
    return [...wanted].map((id) => m.get(`${examVersion}:${id}`)).filter(Boolean);
  }
}
