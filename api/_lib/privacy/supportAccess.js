/**
 * Round 22 (S2, privacy — owner ask: "when companies ask if we can see their data once stored, how
 * do we defend it and ensure privacy?"): time-boxed, revocable, LOGGED staff access to a tenant's own
 * content, behind M3-config/58-support-access.sql's support_access_grants / staff_access_log.
 *
 * THE GAP THIS CLOSES: api/review.js's OPERATOR_ACTIONS (learningReplay, examPromote/List/Export,
 * learningList, scorecardRun/Baseline/Status) run entirely inside the CALLER'S OWN resolved tenant
 * (ctx.tenantKey = auth.tenantId — see api/_lib/auth.js's deriveAuth; the tenant is never client-
 * supplied). Today, isPlatformOperator(auth) is the ONLY gate: a DeepWell staff account that is a
 * Clerk MEMBER of some customer's org (added for support, or listed in
 * DEEPWELL_OPERATOR_USER_IDS) can call any of those actions against that customer's real documents,
 * misses, and learning data indefinitely, with no time limit, no way to revoke it, and nothing the
 * customer can see. This file is the missing second gate.
 *
 * THREE LAYERS, same split every other privacy-sensitive file in this codebase uses:
 *   - decideAccess()               PURE — no DB, no clock read (`now` passed in) — the actual
 *                                   allow/deny decision, unit-tested with zero fixtures
 *                                   (scripts/verify-privacy.mjs).
 *   - grantSupportAccess/
 *     revokeSupportAccess/
 *     getActiveGrant/listGrants/
 *     appendAccessLog/listAccessLog   DB IO, one withTenant call each, tolerant of migration 58 not
 *                                   having run yet (warn once, empty/false/null, never throw) — same
 *                                   convention as api/_lib/learning/examPromote.js.
 *   - requireSupportAccess()          the single call site api/review.js's gateSupportAccess wraps:
 *                                   fetches the active grant, runs decideAccess, and appends the
 *                                   access-log row — best-effort; a logging failure never blocks
 *                                   (or silently allows) the access decision itself.
 *
 * EXEMPTION: the founder tenant itself (DEEPWELL_FOUNDER_TENANT_ID — the same env var
 * api/_lib/missDigest.js's isPlatformOperator already reads) is DeepWell's own dogfooding data, not a
 * customer's, so accessing it is not "support access" at all — decideAccess short-circuits to allow
 * with no grant needed. Every OTHER tenant needs an active grant, or an explicit emergency reason.
 *
 * EMERGENCY / "BREAK-GLASS": requireSupportAccess's caller may pass `emergencyReason` (a non-empty
 * string) to proceed with NO active grant. This is allowed — production incidents do not wait for a
 * tenant admin to be reachable — but it is never silent: every emergency access is logged with
 * is_emergency=true and the reason, and that log is the SAME staff_access_log the tenant's own
 * "Access log" Settings panel reads (src/screens/TeamScreen.tsx's SupportAccessCard) — the tenant
 * sees it the next time they check, which is the "flagged to the tenant" the R22 contract asks for.
 */
import { withTenant } from "../recordsStore.js";

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`support-access: ${context} failed (M3-config/58-support-access.sql may not be applied yet):`, err?.message);
}

/** A grant lasts at most this long (7 days) no matter what the caller asks for — "time-boxed" is the
 *  whole point; an admin who wants longer access simply grants again. */
export const MAX_GRANT_HOURS = 168;
export const DEFAULT_GRANT_HOURS = 24;

/**
 * PURE. Given an already-fetched active-grant row (or null/undefined — none found) and whether this
 * request's tenant IS the founder tenant, decide whether a platform-operator action may proceed.
 * `emergencyReason` is only consulted when there is no active grant AND this is not the founder
 * tenant — a grant always wins over "break-glass" (an emergency reason is not a way to bypass an
 * existing, narrower grant; it can only ever widen access when there is NONE).
 * @returns {{allowed: boolean, mode: 'exempt-founder-tenant'|'granted'|'emergency'|'denied'}}
 */
export function decideAccess({ grant, isFounderTenant, emergencyReason } = {}) {
  if (isFounderTenant) return { allowed: true, mode: "exempt-founder-tenant" };
  if (grant) return { allowed: true, mode: "granted" };
  const reason = typeof emergencyReason === "string" ? emergencyReason.trim() : "";
  if (reason) return { allowed: true, mode: "emergency", emergencyReason: reason.slice(0, 500) };
  return { allowed: false, mode: "denied" };
}

/** Insert a new grant for the CURRENT tenant context (ctxArg — always the tenant admin's own
 *  resolved tenant, same rule as every other write in this codebase: the tenant is never taken from
 *  the request body). `hours` is clamped to [1, MAX_GRANT_HOURS]; a non-finite/absent value falls
 *  back to DEFAULT_GRANT_HOURS. Returns the new grant row (camelCased) or null on any failure. */
export async function grantSupportAccess(ctxArg, { hours, reason } = {}, grantedBy) {
  const asked = Number(hours);
  const h = Math.max(1, Math.min(MAX_GRANT_HOURS, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_GRANT_HOURS));
  const reasonText = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `INSERT INTO support_access_grants (tenant_id, granted_by, reason, expires_at)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, NOW() + ($3 || ' hours')::interval)
         RETURNING id, granted_by, reason, expires_at, created_at`,
        [grantedBy ?? null, reasonText || null, String(h)]
      );
      const r = rows[0];
      return r
        ? { id: r.id, grantedBy: r.granted_by, reason: r.reason, expiresAt: r.expires_at, createdAt: r.created_at }
        : null;
    });
  } catch (err) {
    warnOnce("grantSupportAccess", err);
    return null;
  }
}

/** Revoke one grant early. Scoped to the current tenant context AND to grants not already revoked —
 *  returns false (not an error) for an id that doesn't exist, belongs to another tenant (impossible
 *  under RLS regardless), or is already revoked. */
export async function revokeSupportAccess(ctxArg, grantId, revokedBy) {
  if (typeof grantId !== "string" || !grantId) return false;
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `UPDATE support_access_grants SET revoked_at = NOW(), revoked_by = $2
           WHERE id = $1 AND tenant_id = (current_setting('app.tenant_id', true))::uuid AND revoked_at IS NULL
         RETURNING id`,
        [grantId, revokedBy ?? null]
      );
      return rows.length > 0;
    });
  } catch (err) {
    warnOnce("revokeSupportAccess", err);
    return false;
  }
}

/** The tenant's current active grant (most recent non-revoked, unexpired one), or null. Used both by
 *  requireSupportAccess below and by the Settings UI's "current grant expiry" display. */
export async function getActiveGrant(ctxArg) {
  try {
    return await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `SELECT id, granted_by, reason, expires_at, created_at FROM support_access_grants
          WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
            AND revoked_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1`
      );
      return rows[0] ?? null;
    });
  } catch (err) {
    warnOnce("getActiveGrant", err);
    return null;
  }
}

/** Every grant this tenant has ever issued (active, expired, or revoked), newest first — the
 *  Settings UI's own history view, not just "the current one". */
export async function listGrants(ctxArg, { limit = 20 } = {}) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT id, granted_by, reason, expires_at, revoked_at, revoked_by, created_at FROM support_access_grants
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
        ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 20))]
    )).rows);
  } catch (err) {
    warnOnce("listGrants", err);
    return [];
  }
}

/** Append one access-log row. Best-effort (never throws, never blocks the caller's real request) —
 *  see requireSupportAccess's own doc on why a logging failure must not become an access decision. */
export async function appendAccessLog(ctxArg, { staffUserId, action, recordCount, isEmergency, emergencyReason, grantId } = {}) {
  try {
    return await withTenant(ctxArg, async (db) => {
      await db.raw(
        `INSERT INTO staff_access_log (tenant_id, staff_user_id, action, record_count, is_emergency, emergency_reason, grant_id)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6)`,
        [
          staffUserId ?? null,
          String(action ?? "unknown").slice(0, 120),
          Number.isFinite(recordCount) ? Math.max(0, Math.trunc(recordCount)) : null,
          Boolean(isEmergency),
          emergencyReason ? String(emergencyReason).slice(0, 500) : null,
          grantId ?? null,
        ]
      );
      return true;
    });
  } catch (err) {
    warnOnce("appendAccessLog", err);
    return false;
  }
}

/** This tenant's own access-log rows, newest first — src/services/supportAccessClient.ts's `log`
 *  action, rendered by TeamScreen.tsx's SupportAccessCard. Never returns another tenant's rows: RLS
 *  enforces that at the DB layer regardless of what this function does, but the WHERE clause is here
 *  too, same "belt and suspenders" convention every other tenant-scoped read in this codebase uses. */
export async function listAccessLog(ctxArg, { limit = 200 } = {}) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT id, staff_user_id, action, record_count, is_emergency, emergency_reason, grant_id, created_at
         FROM staff_access_log
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
        ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(1000, Number(limit) || 200))]
    )).rows);
  } catch (err) {
    warnOnce("listAccessLog", err);
    return [];
  }
}

/**
 * THE ENFORCEMENT POINT — api/review.js's gateSupportAccess calls this for every OPERATOR_ACTIONS
 * entry that reads or replays a SPECIFIC tenant's own documents/answers/extractions/misses/learning
 * data (see review.js's own SUPPORT_ACCESS_REQUIRED comment for exactly which ones, and why the
 * platform-wide aggregate actions — missDigest, learningGapReport, learningAutopilotStatus, and the
 * global-table learningDecide/Deactivate/RunNow/Export/RejectAllGaps — are exempt).
 *
 * Never throws. Always appends an access-log row when access is allowed (best-effort — a logging
 * failure is warned once and otherwise swallowed; it must never turn an already-allowed request into
 * a 500, and it must never be the thing that SILENTLY allows access either, which is why logging
 * happens only after decideAccess has already said yes).
 */
export async function requireSupportAccess(ctxArg, { staffUserId, action, recordCount, emergencyReason } = {}) {
  const founderTenantKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  const isFounderTenant = Boolean(founderTenantKey) && ctxArg?.tenantKey === founderTenantKey;
  const grant = isFounderTenant ? null : await getActiveGrant(ctxArg);
  const decision = decideAccess({ grant, isFounderTenant, emergencyReason });
  if (decision.allowed && decision.mode !== "exempt-founder-tenant") {
    await appendAccessLog(ctxArg, {
      staffUserId,
      action,
      recordCount,
      isEmergency: decision.mode === "emergency",
      emergencyReason: decision.mode === "emergency" ? decision.emergencyReason : null,
      grantId: grant?.id ?? null,
    });
  }
  return decision;
}
