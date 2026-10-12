/**
 * dql/translator/tenant.js - the tenant context the model call needs (its daily dollar ledger and usage meter), found from the store the decompose
 * stage already holds (db.tenantId), so the call site in api/ask.js does not change. recordsStore.js is loaded only when a call is about to be made.
 */
export async function withTenantFor(db) {
  try {
    const rs = await import('../../recordsStore.js');
    const tenantKey = db?.tenantId ? rs.tenantKeyForId(db.tenantId) : null;
    return { withTenant: rs.withTenant, ctxArg: tenantKey ? { tenantKey } : null };
  } catch { return { withTenant: null, ctxArg: null }; }
}
