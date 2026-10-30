/**
 * The scheduled driver. runConnectorSweep(): every organization with an active link, each link once, with a deadline.
 * Returns at once (no database connection, no imports) unless DEEPWELL_CONNECTORS=1. A provider whose own flag is off is skipped.
 */
import { isConnectorsEnabled, isProviderEnabled, limits as limitsFor } from "./config.js";
import { runSync } from "./core.js";

/** One link, one pass, wired to the real database / importer / allowance. `deps` overrides any piece (tests). */
export async function syncLink(ctx, link, deps = {}) {
  const env = deps.env ?? process.env;
  if (!isProviderEnabled(link.provider, env)) return { skipped: "off" };
  const { withTenant } = deps.withTenant ? { withTenant: deps.withTenant } : await import("../recordsStore.js");
  const tctx = { tenantKey: ctx.tenantKey, tenantName: ctx.tenantName ?? ctx.tenantKey };
  const tx = (fn) => withTenant(tctx, fn);
  const store = deps.store ?? (await import("./store.js")).createStore(tx);
  const adapter = deps.adapter ?? (await (await import("./adapters/index.js")).loadAdapter(link.provider));
  const importer = deps.importer ?? (await (await import("./importer.js")).createImporter());
  const { sealSecrets, openSecrets } = await import("./secrets.js");
  const { importsAllowed } = await import("./allowance.js");
  const tenantId = await tx(async (db) => db.tenantId);
  const billing = deps.assertBilling ? await deps.assertBilling(tctx) : await (await import("../plan.js")).assertActiveBilling(tctx);
  if (!billing.allowed) return { skipped: "billing" };
  return runSync({ ...tctx, tenantId }, link, {
    store, importer, adapter, env, limits: { ...limitsFor(env), ...(deps.limits ?? {}) }, fetchImpl: deps.fetchImpl,
    openSecrets: (l) => openSecrets(l.provider, tenantId, l.secrets_enc, env),
    sealSecrets: (s) => sealSecrets(link.provider, tenantId, s, env),
    allowance: () => importsAllowed(withTenant, tctx, env),
    now: deps.now,
  });
}

export async function runConnectorSweep({ deadlineAt = Date.now() + 240_000, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  if (!isConnectorsEnabled(env)) return { skipped: "off" };
  const tenants = deps.tenants ?? (await listTenants());
  const summary = { tenants: tenants.length, links: 0, created: 0, errors: 0, left: 0 };
  for (const t of tenants) {
    if (Date.now() > deadlineAt) { summary.left++; continue; }
    try {
      const { withTenant } = deps.withTenant ? { withTenant: deps.withTenant } : await import("../recordsStore.js");
      const links = deps.linksFor ? await deps.linksFor(t) : await (await import("./store.js")).createStore((fn) => withTenant({ tenantKey: t.tenant_key, tenantName: t.tenant_key }, fn)).listLinks();
      for (const link of links.filter((l) => l.status === "active")) {
        if (Date.now() > deadlineAt) { summary.left++; break; }
        const r = await syncLink({ tenantKey: t.tenant_key }, link, deps);
        summary.links++; summary.created += r.tally?.created ?? 0;
        if (r.status && r.status !== "active") summary.errors++;
      }
    } catch (err) { summary.errors++; console.error("connectors: tenant failed:", err?.message); }
  }
  return summary;
}

async function listTenants() {
  const { getPool } = await import("../recordsStore.js");
  const { serializeClient } = await import("../util/pgClient.js");
  const client = serializeClient(await getPool().connect());
  try { return (await client.query("SELECT tenant_key FROM list_connector_tenants() WHERE tenant_key IS NOT NULL")).rows; }
  catch (err) { console.error("connectors: list_connector_tenants() unavailable (run CONNECTORS_TABLES.sql):", err?.message); return []; }
  finally { client.release(); }
}
