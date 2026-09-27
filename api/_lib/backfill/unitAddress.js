/**
 * UNIT <-> SERVICE ADDRESS — one-time (but idempotent, re-runnable) backfill for EXISTING data
 * (Round 16, E2 — owner decision 2026-09-26). See api/_lib/intake/unitAddress.js for the shared
 * rule engine this reuses verbatim — going forward, new documents get stamped by that module's
 * hook inside api/_lib/intake/autofill.js; this file is the batch pass over what is ALREADY on
 * file (the golden export's own 132/132 equipment entities with no service_address, and every
 * real tenant in the same state before this round).
 *
 * Deterministic: the SAME inputs (entities/extractions/document_entity_links) always produce the
 * SAME decision — see decideUnitAddress. Idempotent: the scan query only ever selects equipment
 * entities that STILL have no service_address (`data->>'service_address' IS NULL`), and
 * applyUnitAddressStamp re-guards the same condition at write time, so re-running this after a
 * full pass is a clean no-op (scanned may be >0 on a re-run against a large tenant mid-page, but
 * stamped/conflict counts converge to 0 once nothing eligible remains). Tenant-scoped: every query
 * goes through withTenant (RLS + this module's own explicit TENANT_SQL predicate, belt and
 * braces, same discipline as recordsStore.js).
 *
 * Batched for large tenants: `runUnitAddressBackfillBatch` does ONE bounded page (ordered by id,
 * resumable via `afterId`), the same paging shape as naming/assign.js's runNamingBackfillBatch;
 * `unitAddressBackfillStatus` loops that internally, time-boxed (`deadlineMs`), for a "how many
 * would this touch right now" read-only preview an operator sees BEFORE running anything for real
 * — see api/_lib/routes/unit-address-backfill.js (wired into POST /api/account?action=unit-address,
 * same op-dispatch shape as naming.js's own status/backfill).
 *
 * No model call anywhere in this file.
 */
import { withTenant } from "../recordsStore.js";
import { TENANT_SQL } from "../scope.js";
import {
  decideUnitAddress, loadCustomerAddressInfo, loadUnitDocumentStatedAddress,
  applyUnitAddressStamp, raiseUnitAddressConflict,
} from "../intake/unitAddress.js";

export const DEFAULT_BATCH_SIZE = 500;
export const MAX_BATCH_SIZE = 5000;
const DEFAULT_STATUS_DEADLINE_MS = 45_000; // safely inside Vercel Pro's 300s function budget

function clampBatchSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.trunc(v), MAX_BATCH_SIZE);
}

function emptyCounts() {
  return {
    scanned: 0,
    stamped: 0,
    stampedByRule: { "customer-single-address": 0, "document-stated": 0 },
    skippedHasAddress: 0,
    skippedNoData: 0,
    skippedConflict: 0,
  };
}

function addCounts(into, from) {
  into.scanned += from.scanned;
  into.stamped += from.stamped;
  into.skippedHasAddress += from.skippedHasAddress;
  into.skippedNoData += from.skippedNoData;
  into.skippedConflict += from.skippedConflict;
  for (const rule of Object.keys(into.stampedByRule)) into.stampedByRule[rule] += from.stampedByRule[rule] ?? 0;
}

/**
 * One bounded batch: scans up to `limit` equipment entities still missing a service_address
 * (ordered by id, resumable via `afterId`), applies decideUnitAddress, and — unless `dryRun`
 * (default true) — writes the result. `dryRun` computes the EXACT same decision and counts
 * without any UPDATE/INSERT, so an operator always sees the impact before applying it.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{afterId?: string|null, limit?: number, dryRun?: boolean}} [opts]
 * @returns {Promise<{dryRun: boolean, batchSize: number, afterId: string|null,
 *   nextAfterId: string|null, done: boolean, counts: object, conflicts: object[]}>}
 */
export async function runUnitAddressBackfillBatch(ctx, { afterId = null, limit, dryRun = true } = {}) {
  const batchSize = clampBatchSize(limit);
  return withTenant(ctx, (db) => runBatchTx(db, { afterId, batchSize, dryRun: dryRun !== false }));
}

async function runBatchTx(db, { afterId, batchSize, dryRun }) {
  const { rows } = await db.raw(
    `SELECT id, customer_id FROM entities
      WHERE ${TENANT_SQL} AND entity_type = 'equipment' AND merged_into IS NULL
        AND (data ->> 'service_address') IS NULL
        ${afterId ? "AND id > $2" : ""}
      ORDER BY id
      LIMIT $1`,
    afterId ? [batchSize, afterId] : [batchSize]
  );

  const counts = emptyCounts();
  const conflicts = [];
  let lastId = afterId;

  for (const unit of rows) {
    counts.scanned++;
    lastId = unit.id;

    const [customerInfo, docInfo] = await Promise.all([
      loadCustomerAddressInfo(db, unit.customer_id),
      loadUnitDocumentStatedAddress(db, unit.id),
    ]);

    const decision = decideUnitAddress({
      existingAddress: null, // the scan query already excludes units that have one
      customerAddress: customerInfo.address,
      customerHasSingleAddress: customerInfo.hasSingleAddress,
      documentAddress: docInfo.address,
      documentAddressConflicting: docInfo.conflicting,
    });

    if (decision.outcome === "has-address") { counts.skippedHasAddress++; continue; }

    if (decision.outcome === "no-data") { counts.skippedNoData++; continue; }

    if (decision.outcome === "conflict") {
      counts.skippedConflict++;
      const documentAddress = decision.documentAddress ?? (docInfo.candidates?.[0]?.address ?? null);
      const customerAddress = decision.customerAddress ?? customerInfo.address ?? null;
      conflicts.push({ entityId: unit.id, reason: decision.reason, documentAddress, customerAddress });
      if (!dryRun && docInfo.documentId) {
        await raiseUnitAddressConflict(db, {
          unitId: unit.id, documentId: docInfo.documentId,
          documentAddress, customerAddress, candidates: docInfo.candidates,
        });
      }
      continue;
    }

    // decision.outcome === 'stamp'
    if (dryRun) {
      counts.stamped++;
      counts.stampedByRule[decision.rule] = (counts.stampedByRule[decision.rule] ?? 0) + 1;
      continue;
    }
    const applied = await applyUnitAddressStamp(db, {
      unitId: unit.id, address: decision.address, rule: decision.rule,
      sourceDocumentId: docInfo.documentId ?? null, customerId: unit.customer_id ?? null,
    });
    if (applied) {
      counts.stamped++;
      counts.stampedByRule[decision.rule] = (counts.stampedByRule[decision.rule] ?? 0) + 1;
    } else {
      // Raced with something else stamping this unit between the scan above and this write
      // (a concurrent batch, the intake hook processing a fresh document for the same unit) —
      // not double-counted as stamped, and not a real conflict either.
      counts.skippedHasAddress++;
    }
  }

  return {
    dryRun,
    batchSize,
    afterId: afterId ?? null,
    nextAfterId: rows.length === batchSize ? lastId : null,
    done: rows.length < batchSize,
    counts,
    conflicts,
  };
}

/**
 * Read-only, whole-tenant preview: "how many units would this touch right now" — loops
 * runUnitAddressBackfillBatch internally (always dryRun, regardless of what the caller passes),
 * time-boxed by `deadlineMs` so a very large tenant returns an honestly-labeled partial summary
 * (`truncated: true`, with `nextAfterId` to resume the SAME preview) instead of running forever.
 */
export async function unitAddressBackfillStatus(ctx, { batchSize = DEFAULT_BATCH_SIZE, deadlineMs = DEFAULT_STATUS_DEADLINE_MS, afterId = null } = {}) {
  const started = Date.now();
  const totals = emptyCounts();
  const conflictSample = [];
  let cursor = afterId;
  let truncated = false;
  let batches = 0;

  for (;;) {
    if (Date.now() - started > deadlineMs) { truncated = true; break; }
    const batch = await runUnitAddressBackfillBatch(ctx, { afterId: cursor, limit: batchSize, dryRun: true });
    batches++;
    addCounts(totals, batch.counts);
    if (conflictSample.length < 20) conflictSample.push(...batch.conflicts.slice(0, 20 - conflictSample.length));
    cursor = batch.nextAfterId;
    if (batch.done) break;
  }

  return { dryRun: true, truncated, nextAfterId: truncated ? cursor : null, batches, counts: totals, conflictSample };
}
