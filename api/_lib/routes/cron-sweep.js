import { ingestDocument, recordIngestFailure } from "../readDocument.js";
import { listStuckDocuments, listTenantKeys } from "../opsStore.js";
import { captureMessage, captureException } from "../telemetry.js";

/**
 * GET /api/cron-sweep
 *
 * Finds documents stuck at stage 'received' with no extract_error — the
 * production defect this build fixes: two documents were stuck exactly like
 * this with nothing that would ever find them, because 'received' with no
 * error is indistinguishable from "still in progress" to every other view in
 * the codebase. This sweep is that missing "nothing happened for an hour"
 * check.
 *
 * AUTH: protected by CRON_SECRET, matching Vercel's documented pattern for
 * securing cron routes — Vercel's own cron invocations send
 * `Authorization: Bearer ${CRON_SECRET}` automatically, so the check below is
 * exactly what https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 * describes, not a bespoke scheme. Not Clerk `requireAuth`: nobody signs in
 * for a cron trigger, and a route that only checked for the ABSENCE of a
 * user token would be open to anyone.
 *
 * CROSS-TENANT LIMITATION (see HANDOFF.md and opsStore.listTenantKeys' own
 * doc comment for the full explanation): the app's Postgres role is RLS-
 * restricted and cannot list `tenants` across tenants in production, so
 * listTenantKeys() returns an empty list there today. As a fallback, POSTing
 * `{ "tenants": ["org_abc", ...] }` (Clerk org ids, or {tenant_key,
 * tenant_name} objects) runs the sweep against exactly those tenants. Once
 * listTenantKeys() has a real cross-tenant path, this fallback becomes dead
 * code that can simply be deleted — it does not need to be threaded through
 * anywhere else.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "64kb" } },
  maxDuration: 60,
};

const STUCK_MINUTES = 60;
// Bounds one cron invocation's work, the same way listStuckDocuments' own
// LIMIT 200 bounds one tenant's query — a sweep that ingests without limit is
// the next 60-second platform timeout waiting to happen, on the one route
// that exists specifically to clean up after platform timeouts.
const MAX_DOCS_PER_TENANT = 25;

/** Pure, exported for scripts/verify-ops.mjs. A misconfigured (empty/unset)
 * CRON_SECRET fails closed — it authorizes nothing, ever. */
export function isValidCronAuth(authorizationHeader, secret) {
  if (!secret) return false;
  return authorizationHeader === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isValidCronAuth(req.headers?.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let tenants = await listTenantKeys();

  const bodyTenants = Array.isArray(req.body?.tenants) ? req.body.tenants : [];
  if (!tenants.length && bodyTenants.length) {
    tenants = bodyTenants
      .map((t) => (typeof t === "string" ? { tenant_key: t, tenant_name: t } : t))
      .filter((t) => t && typeof t.tenant_key === "string" && t.tenant_key);
  }

  const summary = { tenantsChecked: tenants.length, stuckFound: 0, recovered: 0, stillFailing: 0, errors: [] };

  for (const t of tenants) {
    const ctx = { tenantKey: t.tenant_key, tenantName: t.tenant_name ?? t.tenant_key };

    let stuck;
    try {
      stuck = await listStuckDocuments(ctx, STUCK_MINUTES);
    } catch (err) {
      summary.errors.push({ tenant: t.tenant_key, phase: "list", message: err?.message });
      await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "list" });
      continue;
    }
    summary.stuckFound += stuck.length;

    for (const doc of stuck.slice(0, MAX_DOCS_PER_TENANT)) {
      try {
        // ONE attempt. This is a nightly safety net, not a retry loop — a
        // document that fails here goes through recordIngestFailure exactly
        // like any other permanent failure, and the tenant sees it on their
        // next visit instead of it silently sitting at 'received' again.
        await ingestDocument(ctx, doc.id);
        summary.recovered += 1;
      } catch (err) {
        summary.stillFailing += 1;
        await recordIngestFailure(
          ctx,
          doc.id,
          new Error(
            `This document was never read after upload, and the nightly recovery pass also failed ` +
              `(${err?.message ?? "unknown error"}). Please re-upload it.`
          )
        );
      }
    }
  }

  await captureMessage(
    `cron-sweep: ${summary.tenantsChecked} tenant(s) checked, ${summary.stuckFound} stuck document(s) found, ` +
      `${summary.recovered} recovered, ${summary.stillFailing} still failing.`,
    { route: "/api/cron-sweep" }
  );

  return res.status(200).json(summary);
}
