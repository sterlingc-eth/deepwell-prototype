import { ingestDocument, recordIngestFailure } from "../readDocument.js";
import { extractDocumentFields } from "../extractDocument.js";
import { withTenant } from "../recordsStore.js";
import { listStuckDocuments, listBudgetDeferredDocuments, listTenantKeysWithSource } from "../opsStore.js";
import { DAILY_BUDGET_EXCEEDED_MESSAGE, isQueueEnabled, enqueueDocument } from "../queue.js";
import { getDailyModelBudgetStatus } from "../rateLimit.js";
import { assertActiveBilling } from "../plan.js";
import { captureMessage, captureException, recordInfo } from "../telemetry.js";
import { runWarrantyNotificationSweep } from "../notify.js";
import { runOutreachSweep } from "./outreach.js";
import { runFollowupsSweep } from "./followups.js";
import { integrityFixTenant } from "./integrity.js";
import { runMissDigestSweepStep } from "../missDigest.js";
import { runLearningSweepStep } from "../learning/sweep.js";
import { runScorecardSweepStep } from "./scorecard.js";
import { runAutopilotSweepStep } from "../learning/autopilot.js";
import { runDossierCatchup } from "../search/dossier.js";
import { runKnowledgeReportSweepStep } from "../search/mapReduce.js";
import { recheckTenantMissing } from "../recheck.js";

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
 * CROSS-TENANT LISTING: the app's Postgres role is RLS-restricted and cannot read `tenants` across
 * tenants, so opsStore.listTenantKeysWithSource() calls the SECURITY DEFINER list_all_tenant_keys()
 * (M3-config/60 — identifiers only). Before that SQL is pasted the listing is empty in production;
 * POSTing `{ "tenants": ["org_abc", ...] }` (Clerk org ids, or {tenant_key, tenant_name} objects) then
 * runs the sweep against exactly those tenants. The summary's `tenantSource` reports which path was
 * used: "definer" | "fallback" | "body" | "none".
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
// R30 L6: informational only. This module is not a Vercel function entry point (api/account.js is, and it sets
// maxDuration 300 for every ?action=, this one included), so the value here was never applied; kept in step with it.
export const config = {
  api: { bodyParser: { sizeLimit: "64kb" } },
  maxDuration: 300,
};

const STUCK_MINUTES = 60;
// Bounds one cron invocation's work, the same way listStuckDocuments' own
// LIMIT 200 bounds one tenant's query — a sweep that ingests without limit is
// the next 60-second platform timeout waiting to happen, on the one route
// that exists specifically to clean up after platform timeouts.
const MAX_DOCS_PER_TENANT = 25;
// R35: with the Inngest queue on, the sweep only ENQUEUES (a few ms each); the queue's own concurrency/throttle does the
// model work. So the per-tenant cap is about how fast a backlog drains per night, not how long this function runs.
// 25/night made a 1,500-document first import take 60 nights; 400/night x 5 sweeps/day clears it in a day.
export const MAX_ENQUEUE_PER_TENANT = 400;
// Documents the read step finished that never got extracted (lost event, extract billing-gated, process killed).
const UNEXTRACTED_MINUTES = 60;
// R35: with the queue on, a document can legitimately wait hours behind a big import (e.g. 5,000 documents at the default
// 3 reads at a time is most of a day). Re-sending one that is merely waiting would run it twice (the sweep's event id differs
// from the upload's, so Inngest does not dedupe them, and a second extraction pass would re-bill the model). So in queue mode
// "stuck" means quiet for 12 h (read) / 6 h (extract), not 60 minutes. Without the queue nothing waits, so 60 minutes stands.
export const QUEUE_STUCK_MINUTES = 12 * 60;
export const QUEUE_UNEXTRACTED_MINUTES = 6 * 60;

/** Pure: the sweep's own Inngest event nonce. Fixed per UTC day so a re-run of the same sweep collapses into the
 *  same event ids (no double model spend), while tomorrow's sweep is allowed to re-queue what is still stuck. */
export function sweepNonce(now = Date.now()) {
  return `sweep-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`;
}

/** Documents read (page text stored) but never extracted: stage 'read', no error, quiet for an hour. */
export async function listUnextractedDocuments(ctx, olderThanMinutes = UNEXTRACTED_MINUTES, limit = MAX_ENQUEUE_PER_TENANT) {
  return withTenant(ctx, async (db) => {
    const { rows } = await db.raw(
      `SELECT id, original_filename, created_at
         FROM documents
        WHERE stage = 'read' AND extract_error IS NULL AND page_count > 0
          AND COALESCE(extracted_at, updated_at, created_at) < NOW() - ($1 || ' minutes')::interval
          AND tenant_id = (current_setting('app.tenant_id', true))::uuid
        ORDER BY created_at ASC
        LIMIT $2`,
      [olderThanMinutes, limit]
    );
    return rows;
  });
}

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
  // R35: `?mode=docs` is the LIGHT sweep - document recovery only (stuck, budget-deferred, read-but-unextracted),
  // none of the integrity / recheck / notification / outreach / learning work. Cheap enough to run every 15-30 minutes
  // during a first big import so documents do not wait for the nightly run. Same auth, same summary shape.
  const docsOnly = req.query?.mode === "docs" || (() => { try { return new URL(req.url ?? "", "http://x").searchParams.get("mode") === "docs"; } catch { return false; } })();
  const deadlineAt = Date.now() + 45_000;
  // Stuck-document re-reads (model calls) get their own, longer budget: api/account.js runs this on a 300s
  // ceiling, so 200s leaves ~100s for the integrity/notification/outreach steps and the response.
  const docRetryDeadlineAt = Date.now() + 200_000;

  // M3-config/60's list_all_tenant_keys() (SECURITY DEFINER) is the production path; `tenantSource` in the
  // summary says which path answered so a sweep that visited nobody is visible, not silent.
  const listed = await listTenantKeysWithSource();
  let tenants = listed.tenants;
  let tenantSource = listed.source;

  const bodyTenants = Array.isArray(req.body?.tenants) ? req.body.tenants : [];
  if (!tenants.length && bodyTenants.length) {
    tenants = bodyTenants
      .map((t) => (typeof t === "string" ? { tenant_key: t, tenant_name: t } : t))
      .filter((t) => t && typeof t.tenant_key === "string" && t.tenant_key);
    tenantSource = "body";
  }

  const summary = {
    tenantsChecked: tenants.length,
    tenantSource,
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
    // Round 5 (2026-09-22): classifyShopRecords, same safe-to-auto-apply
    // reasoning — a document that names no customer, unit or job at all
    // (isShopInternalDocument) can never acquire the link the nightly sweep's
    // other repairs are all trying to create, so it needs its own fix rather
    // than eventually resolving via linkDocuments/linkEquipmentCustomers.
    integrityShopRecordsClassified: 0,
    integrityBodyNamesLinked: 0,
    // Review fix (2026-09-20): relinkMismatchedNames runs dry-run only from
    // cron (see below) — this is how many documents it WOULD relink, not how
    // many it did. An admin applies them from the Customers-tab panel.
    integrityNamesRelinkable: 0,
    integritySkippedTenants: 0,
    // R33 (2026-09-30): $0 re-check of documents with a missing required field against their own stored page text
    // (api/_lib/recheck.js) — repairs documents ingested before the far-future-date fix (Sonoran Comfort Air).
    recheckScanned: 0,
    recheckFilledDocuments: 0,
    recheckFilledFields: 0,
    recheckVerified: 0,
    recheckLeftForNextRun: 0,
    recheckSkippedTenants: 0,
    billingGatedTenants: 0,
    // R35: documents handed to the queue by this sweep, abandoned uploads (PUT never happened), read-but-never-extracted
    // documents found, and tenants whose model budget was still spent today.
    queuedForRecovery: 0,
    abandonedUploads: 0,
    unextractedFound: 0,
    // TEAM T2 (2026-09-25): dossier catch-up (per tenant, below) + async full-report jobs (one per tenant, below).
    dossiersBuilt: 0,
    dossiersUnchanged: 0,
    dossiersSkippedTenants: 0,
    knowledgeReportsProcessed: 0,
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

    // R35: queue on -> hand the backlog to the queue (it has the concurrency, throttle, retries and budget guard).
    // Skipped entirely while today's model budget is still spent: enqueueing 400 documents into a spent budget
    // would only re-stamp them "deferred" and burn their retries.
    if (isQueueEnabled()) {
      const budget = await getDailyModelBudgetStatus(ctx);
      if (budget.exceeded) {
        summary.budgetStillSpentTenants = (summary.budgetStillSpentTenants ?? 0) + 1;
        return { recovered: 0, stillFailing: 0, billingGated: false, queued: 0 };
      }
      let queued = 0;
      const nonce = sweepNonce();
      for (const doc of docs.slice(0, MAX_ENQUEUE_PER_TENANT)) {
        if (Date.now() >= docRetryDeadlineAt) break;
        try {
          await enqueueDocument({ documentId: doc.id, tenantKey: ctx.tenantKey, tenantName: ctx.tenantName, autoExtract: true, requeueNonce: nonce });
          queued += 1;
        } catch (err) {
          summary.errors.push({ tenant: ctx.tenantKey, phase: "enqueue", message: err?.message });
          break; // the queue is down for everyone; do not hammer it once per document
        }
      }
      summary.queuedForRecovery += queued;
      summary.docsLeftForNextRun = (summary.docsLeftForNextRun ?? 0) + Math.max(0, docs.length - queued);
      return { recovered: 0, stillFailing: 0, billingGated: false, queued };
    }

    let recovered = 0;
    let stillFailing = 0;
    for (const doc of docs.slice(0, MAX_DOCS_PER_TENANT)) {
      // Deadline-aware (was only the notification step): each ingestDocument is a model call that can take
      // 30-60s, so an unbounded loop over tenants x 25 documents is what ran the sweep past maxDuration.
      // Skipped documents are left untouched (still stuck/deferred) and are picked up by tomorrow's sweep.
      if (Date.now() >= docRetryDeadlineAt) {
        summary.docsLeftForNextRun = (summary.docsLeftForNextRun ?? 0) + 1;
        continue;
      }
      try {
        await ingestDocument(ctx, doc.id);
        // R35: this used to stop after the READ, so a recovered document sat at stage 'read' with no fields forever
        // (no extraction was ever requested). Extraction is best-effort here: a failure is recorded on the row.
        await extractDocumentFields(ctx, doc.id, { modelAttempts: 1 });
        recovered += 1;
      } catch (err) {
        if (err?.abandoned) {
          // The file never reached storage - recorded quietly (no Sentry) with its own counter, not "still failing".
          summary.abandonedUploads += 1;
          await recordIngestFailure(ctx, doc.id, err);
          continue;
        }
        stillFailing += 1;
        await recordIngestFailure(ctx, doc.id, new Error(failMessage(err)));
      }
    }
    summary.docsLeftForNextRun = (summary.docsLeftForNextRun ?? 0) + Math.max(0, docs.length - MAX_DOCS_PER_TENANT);
    return { recovered, stillFailing, billingGated: false };
  }

  for (const t of tenants) {
    const ctx = { tenantKey: t.tenant_key, tenantName: t.tenant_name ?? t.tenant_key };

    let stuck;
    try {
      stuck = await listStuckDocuments(ctx, isQueueEnabled() ? QUEUE_STUCK_MINUTES : STUCK_MINUTES);
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

    // R35: read but never extracted (stage 'read', no error). listStuckDocuments only sees stage 'received', so a
    // document whose extract event was lost - or gated while billing lapsed - was never found by anything.
    try {
      const unextracted = await listUnextractedDocuments(ctx, isQueueEnabled() ? QUEUE_UNEXTRACTED_MINUTES : UNEXTRACTED_MINUTES);
      summary.unextractedFound += unextracted.length;
      const r = await retryOnce(
        ctx, unextracted,
        (err) => `This document was read but its details were never extracted, and the recovery pass also failed (${err?.message ?? "unknown error"}).`
      );
      summary.recovered += r.recovered;
      summary.stillFailing += r.stillFailing;
    } catch (err) {
      summary.errors.push({ tenant: t.tenant_key, phase: "list-unextracted", message: err?.message });
    }

    if (docsOnly) continue;

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
            'classifyShopRecords', 'linkBodyNames',
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
        summary.integrityShopRecordsClassified += fixed.shopRecordsClassified?.length ?? 0;
        summary.integrityBodyNamesLinked += fixed.bodyNamesLinked?.length ?? 0;

        const relinkPreview = await integrityFixTenant(ctx, { apply: ['relinkMismatchedNames'], dryRun: true });
        summary.integrityNamesRelinkable += relinkPreview.mismatchedNamesRelinked?.length ?? 0;
      } catch (err) {
        summary.errors.push({ tenant: t.tenant_key, phase: "integrity-fix", message: err?.message });
        await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "integrity-fix" });
      }
    } else {
      summary.integritySkippedTenants += 1;
    }

    // R33: missing-field re-check for THIS tenant — deterministic, no model, no billing gate needed ($0). Bounded per
    // tenant (25 documents, newest first) and idempotent: a document a re-check of this version already looked at is
    // not scanned again, so a backlog drains over successive nights instead of one tenant eating the deadline.
    if (Date.now() < deadlineAt) {
      try {
        const rc = await recheckTenantMissing(ctx, { limit: 25, deadlineAt, source: "cron" });
        summary.recheckScanned += rc.scanned;
        summary.recheckFilledDocuments += rc.filled;
        summary.recheckFilledFields += rc.fields;
        summary.recheckVerified += rc.verified;
        summary.recheckLeftForNextRun += rc.leftForNextRun;
      } catch (err) {
        summary.errors.push({ tenant: t.tenant_key, phase: "recheck", message: err?.message });
        await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "recheck" });
      }
    } else {
      summary.recheckSkippedTenants += 1;
    }

    // TEAM T2 (2026-09-25): dossier catch-up for THIS tenant — small, bounded slice (a few seconds,
    // a few dozen entities) so one tenant's backlog never crowds out the rest of the sweep. Never throws.
    if (Date.now() < deadlineAt) {
      try {
        const d = await runDossierCatchup(ctx, { deadlineMs: 6000, maxEntities: 25 });
        summary.dossiersBuilt += d.built ?? 0;
        summary.dossiersUnchanged += d.unchanged ?? 0;
      } catch (err) {
        summary.errors.push({ tenant: t.tenant_key, phase: "dossier-catchup", message: err?.message });
        await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "dossier-catchup" });
      }
    } else {
      summary.dossiersSkippedTenants += 1;
    }

    // One queued full-report job per tenant per sweep (mapReduceAnswer's async fallback for a synthesis
    // question spanning more documents than a single request can cover). Rare and already its own
    // deadline/budget internally; never allowed to fail the rest of this sweep.
    if (Date.now() < deadlineAt) {
      try {
        const rep = await runKnowledgeReportSweepStep(ctx, { deadlineMs: Math.max(5000, deadlineAt - Date.now()) });
        summary.knowledgeReportsProcessed += rep.processed ?? 0;
      } catch (err) {
        summary.errors.push({ tenant: t.tenant_key, phase: "knowledge-report", message: err?.message });
        await captureException(err, { route: "/api/cron-sweep", tenant: t.tenant_key, stage: "knowledge-report" });
      }
    }
  }

  if (docsOnly) {
    summary.mode = "docs";
    summary.billingGatedTenants = billingGatedTenantKeys.size;
    return res.status(200).json(summary);
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

  // Donovan self-learning, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
  // runs AFTER the miss digest above so the SAME night's freshly-logged misses
  // are what it proposes fixes for. Own once-per-UTC-day guard (task key
  // 'donovan-learning'), skips entirely when migration 26 isn't applied or
  // there's nothing new to learn from — never allowed to fail the rest of
  // this sweep.
  try {
    summary.learning = await runLearningSweepStep();
  } catch (err) {
    summary.learning = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "learning" });
  }

  // Donovan Scorecard (api/_lib/scorecard): a rotating ~40-question slice of the golden exam against the
  // founder tenant, LAST on purpose - it only uses the time and money left after every customer-facing step
  // above, is claimed once per UTC day, and failures feed the learning loop. Never fails the sweep.
  try {
    summary.scorecard = await runScorecardSweepStep({ deadlineAt });
  } catch (err) {
    summary.scorecard = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "scorecard" });
  }

  // TEAM H (2026-09-24): the AUTONOMOUS PER-TENANT learning loop — generalizes the founder-only
  // miss-replay/learning/scorecard steps above to EVERY paying/active tenant, fairly rotated within
  // whatever of the shared deadline is left. LAST on purpose, same reasoning as the scorecard step:
  // it only spends the time and money left after every customer-facing step above, and is itself
  // bounded by its own per-tenant/platform daily $ caps (DONOVAN_LEARNING_DAILY_USD /
  // DONOVAN_LEARNING_PLATFORM_DAILY_USD). Never fails the sweep.
  try {
    summary.autopilot = await runAutopilotSweepStep({ deadlineAt });
  } catch (err) {
    summary.autopilot = { error: err?.message };
    await captureException(err, { route: "/api/cron-sweep", stage: "autopilot" });
  }

  summary.billingGatedTenants = billingGatedTenantKeys.size;

  // R34: the one-line sweep summary is routine INFORMATION, not an incident — a log line + breadcrumb only
  // (it used to be a Sentry message every run, which became an unresolved "issue" forever: DEEPWELL-1).
  await recordInfo(
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
      `${summary.integrityHealed} survivor(s) healed, ${summary.integrityContactStripped} company contact field(s) stripped, ` +
      `${summary.integritySplitUnitsHealed} split unit(s) healed, ${summary.integrityContactsFilled} customer contact(s) filled, ` +
      `${summary.integrityNamesRelinkable} mismatched name link(s) relinkable (dry-run, needs an admin), ` +
      `${summary.integritySkippedTenants} tenant(s) skipped (deadline); ` +
      `recheck: ${summary.recheckScanned} document(s) re-checked, ${summary.recheckFilledFields} field(s) restored on ${summary.recheckFilledDocuments} document(s), ${summary.recheckVerified} verified, ${summary.recheckLeftForNextRun} left for next run; ` +
      `${summary.queuedForRecovery} queued for recovery, ${summary.abandonedUploads} abandoned upload(s), ${summary.unextractedFound} read-but-unextracted found; ` +
      `${summary.billingGatedTenants} tenant(s) billing-gated (no active subscription, retries skipped); ` +
      `miss-digest: ${summary.missDigest?.skipped ?? summary.missDigest?.ranAt ?? summary.missDigest?.error ?? "n/a"}; ` +
      `learning: ${summary.learning?.skipped ?? summary.learning?.error ?? `${summary.learning?.totalMissGroups ?? 0} group(s), ${summary.learning?.modelCallsMade ?? 0} model call(s)`}; ` +
      `scorecard: ${summary.scorecard?.skipped ?? summary.scorecard?.error ?? `${summary.scorecard?.passed ?? 0}/${summary.scorecard?.answered ?? 0} passed`}; ` +
      `autopilot: ${summary.autopilot?.skipped ?? summary.autopilot?.error ?? `${summary.autopilot?.tenantsProcessed ?? 0}/${summary.autopilot?.tenantsEligible ?? 0} tenant(s), $${summary.autopilot?.platformSpentUsd ?? 0}`}; ` +
      `dossiers: ${summary.dossiersBuilt} built, ${summary.dossiersUnchanged} unchanged, ${summary.dossiersSkippedTenants} tenant(s) skipped (deadline); ` +
      `knowledge-reports: ${summary.knowledgeReportsProcessed} processed.`,
    { route: "/api/cron-sweep" }
  );

  // Something ACTUALLY failed: documents the nightly retry could not recover (each one was also reported with its
  // real error by recordIngestFailure). One short, stably-fingerprinted warning so it is a single Sentry issue
  // whose event count shows how often it happens — not a sentence full of changing numbers.
  const unrecovered = summary.stillFailing + summary.budgetDeferredStillFailing;
  if (unrecovered > 0) {
    await captureMessage(
      `cron-sweep: ${unrecovered} stuck/deferred document(s) could not be recovered (${summary.stillFailing} stuck, ${summary.budgetDeferredStillFailing} budget-deferred)`,
      { route: "/api/cron-sweep", stage: "unrecovered-documents" },
      { level: "warning", fingerprint: ["cron-sweep-unrecovered-documents"] }
    );
  }

  return res.status(200).json(summary);
}
