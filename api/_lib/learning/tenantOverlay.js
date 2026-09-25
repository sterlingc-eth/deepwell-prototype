/**
 * TEAM H (2026-09-24): TENANT-SCOPED learned vocabulary
 * (`donovan_learned_tenant`, optional M3-config/32-donovan-autopilot.sql).
 *
 * learning/store.js's donovan_learned/donovan_proposals are deliberately
 * PLATFORM-level (no tenant_id at all — see 26-donovan-learning.sql's own
 * header: "a learned abbreviation/typo/synonym benefits every tenant
 * equally"). Per-tenant vocabulary mining (vocabMining.js) needs the
 * opposite: a term ONE shop's own documents taught Donovan must never leak
 * into another shop's overlay. Rather than retrofitting tenant_id onto the
 * existing global table (and its SECURITY-DEFINER-only, zero-RLS-policy
 * access pattern — see that migration's header for why), this is a NEW
 * table, sitting ALONGSIDE it: ordinary per-tenant shape (FORCE RLS, one
 * tenant-isolation policy, written through withTenant) — exactly like
 * ask_misses / donovan_scorecard_* — because this data genuinely IS scoped
 * to one tenant's own connection. Existing global learned items are
 * completely untouched by this file.
 *
 * Tolerant of the migration not being applied: every function here warns
 * once (per process) and returns an empty/false result, same convention as
 * missStore.js / learning/store.js.
 */
import { withTenant } from '../recordsStore.js';

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`donovan-learning: tenant overlay ${context} failed (M3-config/32-donovan-autopilot.sql may not be applied yet):`, err?.message);
}

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** Active tenant-scoped learned rows: {id, kind, key, value, created_at}. Empty array on failure. */
export async function listActiveTenantLearned(ctxArg) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT id, kind, key, value, created_at FROM donovan_learned_tenant WHERE ${TENANT_SQL} AND status = 'active' ORDER BY created_at ASC`,
      []
    )).rows);
  } catch (err) {
    warnOnce('listActiveTenantLearned', err);
    return [];
  }
}

/** Every row (any status) for one tenant — used by the review UI / gap analysis. Empty array on failure. */
export async function listTenantLearned(ctxArg, { status = null, limit = 200 } = {}) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      status
        ? `SELECT * FROM donovan_learned_tenant WHERE ${TENANT_SQL} AND status = $1 ORDER BY created_at DESC LIMIT $2`
        : `SELECT * FROM donovan_learned_tenant WHERE ${TENANT_SQL} ORDER BY created_at DESC LIMIT $1`,
      status ? [status, limit] : [limit]
    )).rows);
  } catch (err) {
    warnOnce('listTenantLearned', err);
    return [];
  }
}

/** The existing row for one (kind,key) in this tenant, or null. */
export async function findTenantVocab(ctxArg, kind, key) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT * FROM donovan_learned_tenant WHERE ${TENANT_SQL} AND kind = $1 AND key = $2`,
      [kind, key]
    )).rows[0] ?? null);
  } catch (err) {
    warnOnce('findTenantVocab', err);
    return null;
  }
}

/**
 * Insert or refresh one tenant vocabulary candidate/decision (upsert on
 * (tenant_id, kind, key)) — same "re-observing accumulates evidence, doesn't
 * duplicate rows" shape as learning/store.js's own recipe proposals.
 * @returns {Promise<string|null>} the row id, or null on failure
 */
export async function upsertTenantVocab(ctxArg, { kind, key, value, status = 'pending', evidence = {}, reason = null }) {
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `INSERT INTO donovan_learned_tenant (tenant_id, kind, key, value, status, evidence, reason, decided_at)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3::jsonb, $4, $5::jsonb, $6, CASE WHEN $4 = 'pending' THEN NULL ELSE NOW() END)
         ON CONFLICT (tenant_id, kind, key) DO UPDATE
           SET value = EXCLUDED.value, status = EXCLUDED.status, evidence = EXCLUDED.evidence, reason = EXCLUDED.reason,
               decided_at = CASE WHEN EXCLUDED.status = 'pending' THEN donovan_learned_tenant.decided_at ELSE NOW() END
         RETURNING id`,
        [kind, key, JSON.stringify(value ?? {}), status, JSON.stringify(evidence ?? {}), reason]
      );
      return rows[0]?.id ?? null;
    });
  } catch (err) {
    warnOnce('upsertTenantVocab', err);
    return null;
  }
}

/** Retire one tenant-scoped learned row (status='rejected' via a fresh disagreement, i.e. auto-demote).
 *  Returns true only when a row was actually found and updated. */
export async function deactivateTenantVocab(ctxArg, id, reason) {
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rowCount } = await db.raw(
        `UPDATE donovan_learned_tenant SET status = 'rejected', reason = $2, decided_at = NOW() WHERE ${TENANT_SQL} AND id = $1 AND status = 'active'`,
        [id, reason ?? null]
      );
      return rowCount > 0;
    });
  } catch (err) {
    warnOnce('deactivateTenantVocab', err);
    return false;
  }
}
