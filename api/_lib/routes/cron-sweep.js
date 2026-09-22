import { ingestDocument, recordIngestFailure } from "../readDocument.js";
import { listStuckDocuments, listBudgetDeferredDocuments, listTenantKeys } from "../opsStore.js";
import { DAILY_BUDGET_EXCEEDED_MESSAGE } from "../queue.js";
import { assertActiveBilling } from "../plan.js";
import { captureMessage, captureException } from "../telemetry.js";
import { runWarrantyNotificationSweep } from "../notify.js";
import { runOutreachSweep } from "./outreach.js";
import { runFollowupsSweep } from "./followups.js";
import { integrityFixTenant } from "./integrity.js";
import { runMissDigestSweepStep } from "../missDigest.js";

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
 *
 * SCALE-READINESS ADDITION (2026-09): also finds and re-attempts documents
 * the ingest queue deliberately deferred because a tenant's daily model-spend
 * cap was already spent when they were uploaded (queue.js's cost guard,
 * DAILY_BUDGET_EXCEEDED_MESSAGE) — a customer dropping in far more than a
 * day's worth of documents at once produces exactly this, by design, and
 * this nightly sweep is what makes the "resumes tomorrow" in that message
 * literally true, on whatever day the tenant's usage has room again. Kept
 * strictly separate from the "genuinely stuck" population above: matched by
 * the EXACT deferral message (see listBudgetDeferredDocuments), so a document
 * that failed for a real, permanent reason is never retried here.
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

  // ONE shared deadline for this whole invocation (api/account.js's
  // maxDuration is 60s for every ?action=, this one included). 45s leaves a
  // margin for the response itself and whatever the stuck-document phases
  // below still take. Only the notification step is deadline-aware today
  // (REVIEW FIX 2026-09-20) — it receives this and stops before crossing it,
  // logging + reporting how many tenants it had to leave for next run.
  const deadlineAt = Date.now() + 45_000;

  let tenants = await listTenantKeys();

  const bodyTenants = Array.isArray(req.body?.tenants) ? req.body.tenants : [];
  if (!tenants.length && bodyTenants.length) {
    tenants = bodyTenants
      .map((t) => (typeof t === "string" ? { tenant_key: t, tenant_name: t } : t))
      .filter((t) => t && typeof t.tenant_key === "string" && t.tenant_key);
  }

  const summary = {
    tenantsChecked: tenants.length,
    stuckFound: 0,
    recovered: 0,
    stillFailing: 0,
    budgetDeferredFound: 0,
    budgetDeferredRecovered: 0,
    budgetDeferredStillFailing: 0,
    integrityMerged: 0,
    integrityLinked: 0,
    integrityHealed: 0,
    integrityContactStripped: 0,
    // Round 4 (2026-09-21): healSplitUnits/refillCustomerContacts, both safe
    // to auto-apply (see integrityFixTenant's own doc comments) — repair
    // already-damaged state from before those fixes existed, not just fresh
    // ingests.
    integritySplitUnitsHealed: 0,
    integrityContactsFilled: 0,
    // Round 2 gap 4 (2026-09-21): absorbAddressPlaceholders, same safe-to-
    // auto-apply reasoning as healSplitUnits/refillCustomerContacts above —
    // repairs already-damaged state (a placeholder that should have matched
    // an existing named customer) from before the write-path fix existed.
    integrityAddressPlaceholdersAbsorbed: 0,
    // Review fix (2026-09-20): relinkMismatchedNames runs dry-run only from
    // cron (see below) — this is how many documents it WOULD relink, not how
    // many it did. An admin applies them from the Customers-tab panel.
    integrityNamesRelinkable: 0,
    integritySkippedTenants: 0,
    billingGatedTenants: 0,
    errors: [],
  };

  // Distinct tenants skipped for billing below, across both retryOnce()
  // call sites (stuck + budget-deferred) — a tenant hit in both counts once.
  const billingGatedTenantKeys = new Set();

  /**
   * One attempt per document, ONE attempt only — this is a nightly safety
   * net, not a retry loop. A document that fails here goes through
   * recordIngestFailure exactly like any other permanent failure, and the
   * tenant sees it (with `failMessage`) on their next visit instead of it
   * silently sitting at 'received' again.
   *
   * HARD GATE (Reviewer NO-GO, 2026-09-21): a tenant with no active
   * subscription must not have this nightly sweep spend Anthropic-billed
   * model calls re-reading their documents on their behalf. Checked ONCE per
   * call (there is nothing per-document to gain — the whole point of "skip
   * the tenant" is that none of its documents in this batch get retried),
   * and only when there is actually something to retry, so a tenant with an
   * empty `docs` list costs no extra query. Silent to the tenant on purpose:
   * this is a background recovery pass, not a user-facing action, so there
   * is no 402 to send anywhere — logging (+ the summary counter below) is
   * enough for an operator to see why a canceled tenant's stuck documents
   * aren't clearing. Every document is left completely untouched (no
   * recordIngestFailure), so a later run — once billing is fixed — finds it
   * exactly as stuck/deferred as before, not marked failed in the meantime.
   */
  async function retryOnce(ctx, docs, failMessage) {
    if (docs.length === 0) return { recovered: 0, stillFailing: 0, billingGated: false };

    const billingGate = await assertActiveBilling(ctx);
    if (!billingGate.allowed) {
      console.log(`cron-sweep: billing-gated, skipping ${docs.length} document(s) for tenant ${ctx.tenantKey}`);
      billingGatedTenantKeys.add(ctx.tenantKey);
      return { recovered: 0, stillFailing: 0, billingGated: true };
    }

    let recovered = 0;
    let stillFailing = 0;
    for (const doc of docs.slice(0, MAX_DOCS_PER_TENANT)) {
      try {
        await ingestDocument(ctx, doc.id);
        recovered += 1;
      } catch (err) {
        stillFailing += 1;
        await recordIngestFailure(ctx, doc.id, new Error(failMessage(err)));
      }
    }
    return { recovered, stillFailing, billingGated: false };
  }

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
    const stuckResult = await retryOnce(
      ctx,
      stuck,
      (err) =>
        `This document was never read after upload, and the nightly recovery pass also failed ` +
        `(${err?.message ?? "unknown error"}). Please re-upload it.`
    );
    summary.recovered += stuckResult.recovered;
    summary.stillFailing += stuckResult.stillFailing;

    // Documents the ingest queue deliberately deferred yesterday (or earlier
    // today) because the tenant's daily model-spend cap was already spent —
    // see the file header. Listed and retried separately from "stuck" above:
    // these were never stuck, they were waiting for exactly this sweep.
    let budgetDeferred;
    try {
      budgetDeferred = await listBudgetDeferredDocuments(ctx, DAILY_BUDGET_EXCEEDED_MESSAGE);
    } catch (err) {
      summary.errors.push({ tenant: t.tenant_key, phase: "list-budget-deferred", message: err?.message });
      await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "list-budget-deferred" });
      continue;
    }
    summary.budgetDeferredFound += budgetDeferred.length;
    const deferredResult = await retryOnce(
      ctx,
      budgetDeferred,
      (err) =>
        `This document was deferred by yesterday's daily processing limit, and today's retry also failed ` +
        `(${err?.message ?? "unknown error"}). Please re-upload it.`
    );
    summary.budgetDeferredRecovered += deferredResult.recovered;
    summary.budgetDeferredStillFailing += deferredResult.stillFailing;

    // Data integrity (handoffs/DATA_INTEGRITY_2026-09-20.md, section D):
    // deterministic, no model calls. Only score >= 0.95 duplicate-customer
    // merges are auto-applied unattended — anything lower stays a suggestion
    // the Customers screen surfaces (GET /api/v1/customers's `duplicates`).
    // Every link fix runs regardless of score, since a link is reversible
    // (unlinkDocument) and never merges two records into one. stripShopContact
    // is safe to auto-apply too (its target is a phone/email that already
    // cleared the floor of 3+ distinct customer addresses, or an exact match
    // on the tenant's own configured contact — never a judgement call), so it
    // gets `dryRun: false` explicitly, same as everything else here.
    //
    // relinkMismatchedNames does NOT: unlinking a document from one customer
    // and repointing it at another is exactly the kind of change nobody
    // should wake up to unattended, however confident the match. Review fix
    // (2026-09-20, reviewer NO-GO item 2): run it dry-run only here — log
    // what it WOULD relink so an admin can see the count and act on it from
    // the Customers-tab panel, never apply it from cron.
    if (Date.now() < deadlineAt) {
      try {
        const fixed = await integrityFixTenant(ctx, {
          apply: [
            'mergeDuplicates', 'linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits', 'healMergedSurvivors',
            'stripShopContact', 'healSplitUnits', 'refillCustomerContacts', 'absorbAddressPlaceholders',
          ],
          minMergeScore: 0.95,
          dryRun: false,
        });
        summary.integrityMerged += fixed.merged.length;
        summary.integrityLinked += fixed.documentsLinked.length + fixed.equipmentLinked.length + fixed.unitsCreated.length;
        summary.integrityHealed += fixed.survivorsHealed.length;
        summary.integrityContactStripped += fixed.shopContactStripped?.length ?? 0;
        summary.integritySplitUnitsHealed += fixed.splitUnitsHealed?.length ?? 0;
        summary.integrityContactsFilled += fixed.customerContactsFilled?.length ?? 0;
        summary.integrityAddressPlaceholdersAbsorbed += fixed.addressPlaceholdersAbsorbed?.length ?? 0;

        const relinkPreview = await integrityFixTenant(ctx, { apply: ['relinkMismatchedNames'], dryRun: true });
        summary.integrityNamesRelinkable += relinkPreview.mismatchedNamesRelinked?.length ?? 0;
      } catch (err) {
        summary.errors.push({ tenant: t.tenant_key, phase: "integrity-fix", message: err?.message });
        await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "integrity-fix" });
      }
    } else {
      summary.integritySkippedTenants += 1;
    }
  }

  // Warranty-expiration notifications (handoffs/NOTIFICATIONS.md). Its own
  // tenant listing (SECURITY DEFINER, active/trialing plans only — see
  // M3-config/16-notifications.sql) rather than listTenantKeys() above,
  // which is scoped to "every tenant" for document recovery, not "tenants
  // who should get a warranty digest". Never allowed to fail the sweep the
  // rest of this route exists for.
  try {
    summary.notifications = await runWarrantyNotificationSweep({ deadlineAt });
  } catch (err) {
    summary.notifications = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "notifications" });
  }

  // Customer outreach (handoffs/OUTREACH_2026-09-20.md): same shared deadline,
  // own cross-tenant listing (opt-in tenants only — list_outreach_enabled_tenants,
  // M3-config/18-outreach.sql), never allowed to fail the rest of this sweep.
  try {
    summary.outreach = await runOutreachSweep({ deadlineAt });
  } catch (err) {
    summary.outreach = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "outreach" });
  }

  // Missing-info follow-ups (owner brief, item 3: handoffs/START_HERE_NEXT_CHAT.md;
  // design in handoffs/TECH_FOLLOWUPS_2026-09-21.md): same shared deadline, own
  // cross-tenant listing (reused from notify.js's own — see followups.js's
  // module comment), off by default per tenant, never allowed to fail the
  // rest of this sweep.
  try {
    summary.followups = await runFollowupsSweep({ deadlineAt });
  } catch (err) {
    summary.followups = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "followups" });
  }

  // Donovan miss digest, Tier 1 of the self-learning loop
  // (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md, api/_lib/missDigest.js):
  // platform-owner-only, cross-tenant, guarded to at most once per UTC day
  // internally — never allowed to fail the rest of this sweep.
  try {
    summary.missDigest = await runMissDigestSweepStep();
  } catch (err) {
    summary.missDigest = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "miss-digest" });
  }

  summary.billingGatedTenants = billingGatedTenantKeys.size;

  await captureMessage(
    `cron-sweep: ${summary.tenantsChecked} tenant(s) checked, ${summary.stuckFound} stuck document(s) found, ` +
      `${summary.recovered} recovered, ${summary.stillFailing} still failing; ` +
      `${summary.budgetDeferredFound} budget-deferred document(s) found, ` +
      `${summary.budgetDeferredRecovered} recovered, ${summary.budgetDeferredStillFailing} still failing; ` +
      `notifications: ${summary.notifications?.tenantsChecked ?? 0} tenant(s), ` +
      `${summary.notifications?.notified ?? 0} notified, ${summary.notifications?.emailsSent ?? 0} digest(s) sent, ` +
      `${summary.notifications?.skipped ?? 0} tenant(s) skipped (deadline); ` +
      `outreach: ${summary.outreach?.tenantsChecked ?? 0} tenant(s), ${summary.outreach?.drafted ?? 0} drafted, ` +
      `${summary.outreach?.sent ?? 0} sent, ${summary.outreach?.failed ?? 0} failed; ` +
      `followups: ${summary.followups?.tenantsEnabled ?? 0}/${summary.followups?.tenantsChecked ?? 0} tenant(s) enabled, ` +
      `${summary.followups?.messagesSent ?? 0} message(s) sent, ${summary.followups?.emailsSent ?? 0} emailed; ` +
      `integrity: ${summary.integrityMerged} merged, ${summary.integrityLinked} linked, ` +
      `${summary.integrityHealed} survivor(s) healed, ${summary.integrityContactStripped} shop contact field(s) stripped, ` +
      `${summary.integritySplitUnitsHealed} split unit(s) healed, ${summary.integrityContactsFilled} customer contact(s) filled, ` +
      `${summary.integrityNamesRelinkable} mismatched name link(s) relinkable (dry-run, needs an admin), ` +
      `${summary.integritySkippedTenants} tenant(s) skipped (deadline); ` +
      `${summary.billingGatedTenants} tenant(s) billing-gated (no active subscription, retries skipped); ` +
      `miss-digest: ${summary.missDigest?.skipped ?? summary.missDigest?.ranAt ?? summary.missDigest?.error ?? "n/a"}.`,
    { route: "/api/cron-sweep" }
  );

  return res.status(200).json(summary);
}
