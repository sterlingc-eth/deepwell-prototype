/**
 * Audit-log policy for the industry demo companies (fix round 2, 2026-10-22).
 *
 * A demo day produces a lot of routine audit rows (every question asked, every automatic link repair, every financial read).
 * Those are noise in the audit trail and in anything that counts it, so for a DEMO company they are not written. Security
 * entries are always kept: key creation and revocation, export, delete, billing and plan events, staff access, support
 * grants, sign-in, the reset itself (demo.reset) - anything that is not on the noise list below. A real company is never
 * affected: the skip needs the company row to say plan 'demo' AND billing_status 'demo'.
 *
 * Pure policy here; the two audit writers (recordsStore.logAction, reviewStore.logAction) call skipDemoAuditNoise().
 */

/** Routine, high-volume actions. Anything NOT matching this is a security/business entry and is always written. */
export const DEMO_AUDIT_NOISE = /^(?:document\.(?:queried|financials_extracted)|integrity\.|review\.|customers\.|reminder\.|alert\.|donovan\.)/;

export function isDemoAuditNoise(action) {
  return typeof action === 'string' && DEMO_AUDIT_NOISE.test(action);
}

const TTL_MS = 60_000;
const cache = new Map();

/**
 * True when this audit row should be skipped: the action is routine noise AND the company is a demo company.
 * @param {(sql: string, params: unknown[]) => Promise<unknown[]>} rowsFn  runs a query inside the caller's tenant transaction, returns rows
 * Fails open (returns false = write the row) on any lookup error.
 */
export async function skipDemoAuditNoise(rowsFn, tenantId, action) {
  if (!isDemoAuditNoise(action) || !tenantId) return false;
  const hit = cache.get(tenantId);
  if (hit && hit.exp > Date.now()) return hit.demo;
  try {
    const rows = await rowsFn("SELECT 1 AS d FROM tenants WHERE id = $1 AND plan = 'demo' AND billing_status = 'demo'", [tenantId]);
    const demo = Array.isArray(rows) && rows.length > 0;
    if (cache.size > 500) cache.clear();
    cache.set(tenantId, { demo, exp: Date.now() + TTL_MS });
    return demo;
  } catch {
    return false;
  }
}

/** Test hook. */
export function _resetAuditPolicyCache() { cache.clear(); }
