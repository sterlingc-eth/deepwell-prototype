/**
 * Deterministic data-integrity scan/fix (handoffs/DATA_INTEGRITY_2026-09-20.md).
 * No model calls — every rule here is a pure function in ../integrity.js;
 * this file only runs the SQL that feeds those rules and applies their
 * verdicts. Dispatched from api/review.js as `action: 'integrityScan'` /
 * `'integrityFix'`.
 *
 *   integrityScan(ctx)                       -> read-only report
 *   integrityFix(ctx, {apply, dryRun, ...})   -> applies high-confidence fixes
 *
 * Every fix is idempotent: findOrCreateEquipment is keyed on serial,
 * linkDocumentToCustomer/linkDocumentToEntity use ON CONFLICT DO NOTHING,
 * setEquipmentCustomer is fill-only, mergeCustomers refuses an
 * already-merged row. Running the same `apply` list twice changes nothing
 * the second time.
 */
import { withTenant as withRecordsTenant, linkDocumentToCustomer, linkDocumentToEntity, extractionsHaveUnitIndex } from '../recordsStore.js';
import { mergeCustomers, ReviewError, isUuid } from '../reviewStore.js';
import { hasShop, requireRole, AuthError } from '../auth.js';
import {
  customerMatchScore, findDuplicateCustomerPairs, isUnlinkedDocument,
  isEquipmentMissingCustomer, multiUnitUnderLinked, CUSTOMER_MATCH_THRESHOLD,
  unitIndexBackfillPlan, groupExtractionRowsByUnit,
} from '../integrity.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const CUSTOMER_SCAN_LIMIT = 500;
const DOCUMENT_SCAN_LIMIT = 1000;
const APPLY_ACTIONS = new Set(['mergeDuplicates', 'linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits']);

// ------------------------------------------------------------------ reads --

async function loadCustomersForScan(db) {
  const rows = await db.raw(
    `SELECT id, customer_number, data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
      ORDER BY created_at LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ id: r.id, customerNumber: r.customer_number, name: r.name, address: r.address }));
}

/** One row per document that names a customer_name/service_address, with
 *  whether ANY path already resolves it to a customer (direct link, or a
 *  linked/primary equipment entity whose customer_id is set). `documentId`
 *  narrows to exactly one document — used by integrityFixDocument's cheap
 *  post-extraction repair, so it never pays for a tenant-wide scan. */
async function loadUnlinkedCandidates(db, documentId = null) {
  const rows = await db.raw(
    `WITH doc_facts AS (
       SELECT document_id,
              bool_or(field_key = 'customer_name')   AS has_customer_name,
              bool_or(field_key = 'service_address') AS has_address,
              bool_or(field_key = 'serial_number')   AS has_serial,
              max(value) FILTER (WHERE field_key = 'customer_name')   AS customer_name,
              max(value) FILTER (WHERE field_key = 'service_address') AS service_address
         FROM extractions
        WHERE ${TENANT} AND ($1::uuid IS NULL OR document_id = $1)
        GROUP BY document_id
     ),
     linked_customer AS (
       SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE e.entity_type = 'customer' AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE e.entity_type = 'equipment' AND e.customer_id IS NOT NULL AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT x.document_id FROM extractions x JOIN entities e ON e.id = x.entity_id
        WHERE e.entity_type = 'equipment' AND e.customer_id IS NOT NULL AND x.tenant_id = (current_setting('app.tenant_id', true))::uuid
     )
     SELECT d.id AS document_id, df.has_customer_name, df.has_address, df.has_serial,
            df.customer_name, df.service_address,
            (lc.document_id IS NOT NULL) AS linked_to_customer
       FROM documents d
       JOIN doc_facts df ON df.document_id = d.id
       LEFT JOIN linked_customer lc ON lc.document_id = d.id
      WHERE d.${TENANT} AND ($1::uuid IS NULL OR d.id = $1)
      LIMIT ${DOCUMENT_SCAN_LIMIT}`,
    [documentId]
  );
  return rows.rows.map((r) => ({
    documentId: r.document_id,
    hasCustomerName: !!r.has_customer_name,
    hasAddress: !!r.has_address,
    hasSerial: !!r.has_serial,
    linkedToCustomer: !!r.linked_to_customer,
    customerName: r.customer_name,
    serviceAddress: r.service_address,
  }));
}

/** Equipment entities that carry a customer_name/service_address of their
 *  own (findOrCreateEquipment's fill-once fields) but no customer_id. */
async function loadEquipmentMissingCustomer(db) {
  const rows = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
       FROM entities
      WHERE entity_type = 'equipment' AND customer_id IS NULL AND merged_into IS NULL AND ${TENANT}
        AND (data->>'customer_name' IS NOT NULL OR data->>'service_address' IS NOT NULL)
      LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ equipmentId: r.id, customerName: r.customer_name, serviceAddress: r.service_address }));
}

/** Documents whose extractions carry >=2 distinct serial_number values,
 *  with how many DISTINCT equipment entities are actually linked. */
async function loadMultiUnitCandidates(db) {
  const rows = await db.raw(
    `WITH serials AS (
       SELECT document_id, array_agg(DISTINCT lower(value)) AS values
         FROM extractions
        WHERE field_key = 'serial_number' AND value IS NOT NULL AND ${TENANT}
        GROUP BY document_id
       HAVING count(DISTINCT lower(value)) >= 2
     ),
     linked_equip_ids AS (
       SELECT l.document_id, l.entity_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE e.entity_type = 'equipment' AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT x.document_id, x.entity_id FROM extractions x JOIN entities e ON e.id = x.entity_id
        WHERE e.entity_type = 'equipment' AND x.entity_id IS NOT NULL AND x.tenant_id = (current_setting('app.tenant_id', true))::uuid
     ),
     linked_counts AS (
       SELECT document_id, count(DISTINCT entity_id) AS n FROM linked_equip_ids GROUP BY document_id
     )
     SELECT s.document_id, s.values, COALESCE(lc.n, 0) AS linked_count
       FROM serials s
       LEFT JOIN linked_counts lc ON lc.document_id = s.document_id
      LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ documentId: r.document_id, serialValues: r.values ?? [], linkedEquipmentCount: Number(r.linked_count) || 0 }));
}

async function loadOrphanEquipment(db) {
  const rows = await db.raw(
    `SELECT e.id FROM entities e
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND ${TENANT}
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.entity_id = e.id AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid)
        AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.entity_id = e.id AND x.tenant_id = (current_setting('app.tenant_id', true))::uuid)
      LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ equipmentId: r.id }));
}

// ---------------------------------------------------------------- scan API --

export async function integrityScan(ctx) {
  return withRecordsTenant(ctx, async (db) => {
    const [customers, docCandidates, equipCandidates, multiUnitCandidates, orphanEquipment] = await Promise.all([
      loadCustomersForScan(db),
      loadUnlinkedCandidates(db),
      loadEquipmentMissingCustomer(db),
      loadMultiUnitCandidates(db),
      loadOrphanEquipment(db),
    ]);

    const duplicateCustomers = findDuplicateCustomerPairs(customers);

    const unlinkedRows = docCandidates.filter(isUnlinkedDocument);
    const unlinkedDocuments = [];
    for (const r of unlinkedRows) {
      const suggestedCustomerId = await db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress });
      unlinkedDocuments.push({
        documentId: r.documentId, hasCustomerName: r.hasCustomerName, hasAddress: r.hasAddress,
        hasSerial: r.hasSerial, suggestedCustomerId: suggestedCustomerId ?? null,
      });
    }

    const equipWithoutCustomer = [];
    for (const r of equipCandidates.filter(isEquipmentMissingCustomer)) {
      const suggestedCustomerId = await db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress });
      equipWithoutCustomer.push({ equipmentId: r.equipmentId, suggestedCustomerId: suggestedCustomerId ?? null });
    }

    const multiUnitDocsUnderLinked = multiUnitCandidates
      .filter(multiUnitUnderLinked)
      .map((r) => ({ documentId: r.documentId, unitsExtracted: new Set(r.serialValues).size, unitsLinked: r.linkedEquipmentCount }));

    return {
      duplicateCustomers,
      unlinkedDocuments,
      equipmentWithoutCustomer: equipWithoutCustomer,
      multiUnitDocsUnderLinked,
      orphanEquipment,
      counts: {
        duplicateCustomers: duplicateCustomers.length,
        unlinkedDocuments: unlinkedDocuments.length,
        equipmentWithoutCustomer: equipWithoutCustomer.length,
        multiUnitDocsUnderLinked: multiUnitDocsUnderLinked.length,
        orphanEquipment: orphanEquipment.length,
      },
    };
  });
}

// ----------------------------------------------------------------- fix API --

/**
 * Stamp unit_index (M3-config/19) onto a document's existing extraction rows
 * — see integrity.js's unitIndexBackfillPlan for the (pure, tested) rule.
 * No-op once the column doesn't exist yet, any serial row already carries a
 * unit_index, or there's nothing to group. Idempotent: re-running finds
 * nothing left in the plan.
 */
async function backfillUnitIndexForDocument(db, documentId) {
  if (!(await extractionsHaveUnitIndex(db))) return 0;
  const rows = await db.listExtractionsByDocument(documentId); // ORDER BY id — appearance order
  const plan = unitIndexBackfillPlan(
    rows.map((r) => ({ id: r.id, field_key: r.field_key, value: r.corrected_value ?? r.value, unit_index: r.unit_index }))
  );
  for (const { id, unitIndex } of plan) {
    await db.raw(`UPDATE extractions SET unit_index = $2 WHERE id = $1 AND ${TENANT}`, [id, unitIndex]);
  }
  return plan.length;
}

/** Best-effort per-unit equipment for a document flagged by
 *  multiUnitUnderLinked: one findOrCreateEquipment per not-yet-linked
 *  serial value, carrying the document's shared facts — grouped by
 *  integrity.js's groupExtractionRowsByUnit (unit_index when on file,
 *  positional-pairing fallback otherwise). */
async function createMissingUnitsForDocument(ctx, { documentId }, { dryRun }) {
  return withRecordsTenant(ctx, async (db) => {
    if (!dryRun) await backfillUnitIndexForDocument(db, documentId);

    const rows = await db.listExtractionsByDocument(documentId);
    const valuesFor = (key) => rows.filter((r) => r.field_key === key).map((r) => r.corrected_value ?? r.value).filter(Boolean);
    const shared = {};
    for (const k of ['customer_name', 'service_address', 'installed_by']) {
      const v = valuesFor(k)[0];
      if (v) shared[k] = v;
    }

    const groups = groupExtractionRowsByUnit(
      rows.map((r) => ({ field_key: r.field_key, value: r.corrected_value ?? r.value, unit_index: r.unit_index }))
    );
    const unitBuckets = groups.map((g) => ({ serial: g.facts.serial_number, facts: g.facts }));

    const linked = await db.raw(
      `SELECT DISTINCT lower(e.data->>'serial_number') AS serial
         FROM (
           SELECT entity_id FROM document_entity_links WHERE document_id = $1 AND ${TENANT}
           UNION
           SELECT entity_id FROM extractions WHERE document_id = $1 AND entity_id IS NOT NULL AND ${TENANT}
         ) l(entity_id)
         JOIN entities e ON e.id = l.entity_id AND e.entity_type = 'equipment'`,
      [documentId]
    );
    const alreadyLinked = new Set(linked.rows.map((r) => r.serial));

    const created = [];
    for (const bucket of unitBuckets) {
      const serial = bucket.serial;
      if (!serial || alreadyLinked.has(serial.toLowerCase())) continue;
      if (dryRun) { created.push({ documentId, equipmentId: null, serial }); continue; }
      const unitFacts = { ...shared, ...bucket.facts, serial_number: serial };
      const unitEntity = await db.findOrCreateEquipment(unitFacts);
      if (!unitEntity?.id) continue;
      await linkDocumentToEntity(db, { documentId, entityId: unitEntity.id, confidence: 0.7 });
      if (shared.customer_name || shared.service_address) {
        const customerId = await db.suggestCustomer({ customer_name: shared.customer_name, service_address: shared.service_address });
        if (customerId) await db.setEquipmentCustomer(unitEntity.id, customerId);
      }
      created.push({ documentId, equipmentId: unitEntity.id, serial });
    }
    return created;
  });
}

/**
 * The actual work, no auth check — see integrityFix (HTTP, admin-gated) and
 * integrityFixTenant (cron-sweep's system caller) below, both of which call
 * this. `apply`: any of
 * ['mergeDuplicates','linkDocuments','linkEquipmentCustomers','createMissingUnits'].
 * `minMergeScore`: floor for auto-merging duplicate customers (default the
 * same 0.9 bar selectCustomerMatch itself uses); cron-sweep.js passes 0.95
 * for its unattended nightly run and leaves lower-score pairs as suggestions.
 */
async function applyIntegrityFix(ctx, { apply, dryRun = false, minMergeScore = CUSTOMER_MATCH_THRESHOLD } = {}, actorClerkId) {
  const applySet = new Set((Array.isArray(apply) ? apply : []).filter((a) => APPLY_ACTIONS.has(a)));
  const result = { dryRun: !!dryRun, merged: [], documentsLinked: [], equipmentLinked: [], unitsCreated: [], skipped: [] };

  if (applySet.has('mergeDuplicates')) {
    const customers = await withRecordsTenant(ctx, loadCustomersForScan);
    const pairs = findDuplicateCustomerPairs(customers, { threshold: Math.max(minMergeScore, CUSTOMER_MATCH_THRESHOLD) });
    for (const pair of pairs) {
      if (dryRun) { result.merged.push(pair); continue; }
      try {
        await mergeCustomers(ctx, { keepId: pair.keepId, dropId: pair.dropId }, actorClerkId);
        await withRecordsTenant(ctx, (db) => db.logAction({
          clerk_user_id: actorClerkId, action: 'integrity.merge_duplicates',
          resource_type: 'entity', resource_id: pair.keepId, changes: pair,
        }));
        result.merged.push(pair);
      } catch (err) {
        // Already merged (a previous run got there first) is success, not a
        // failure worth surfacing — anything else is reported and skipped.
        if (!/already been merged/i.test(err?.message ?? '')) {
          result.skipped.push({ documentId: null, reason: `merge ${pair.dropId}: ${err?.message}` });
        }
      }
    }
  }

  if (applySet.has('linkDocuments')) {
    const rows = (await withRecordsTenant(ctx, loadUnlinkedCandidates)).filter(isUnlinkedDocument);
    for (const r of rows) {
      const customerId = await withRecordsTenant(ctx, (db) => db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }));
      if (!customerId) { result.skipped.push({ documentId: r.documentId, reason: 'no confident customer match' }); continue; }
      if (dryRun) { result.documentsLinked.push({ documentId: r.documentId, customerId }); continue; }
      const didLink = await withRecordsTenant(ctx, (db) => linkDocumentToCustomer(db, { documentId: r.documentId, customerId, confidence: 0.75 }));
      result.documentsLinked.push({ documentId: r.documentId, customerId, alreadyLinked: !didLink });
    }
    if (result.documentsLinked.length) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.link_documents', resource_type: 'tenant',
        changes: { count: result.documentsLinked.length },
      }));
    }
  }

  if (applySet.has('linkEquipmentCustomers')) {
    const rows = (await withRecordsTenant(ctx, loadEquipmentMissingCustomer)).filter(isEquipmentMissingCustomer);
    for (const r of rows) {
      const customerId = await withRecordsTenant(ctx, (db) => db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }));
      if (!customerId) { result.skipped.push({ documentId: null, reason: `equipment ${r.equipmentId}: no confident customer match` }); continue; }
      if (dryRun) { result.equipmentLinked.push({ equipmentId: r.equipmentId, customerId }); continue; }
      const n = await withRecordsTenant(ctx, (db) => db.setEquipmentCustomer(r.equipmentId, customerId));
      if (n > 0) result.equipmentLinked.push({ equipmentId: r.equipmentId, customerId });
    }
    if (result.equipmentLinked.length) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.link_equipment_customers', resource_type: 'tenant',
        changes: { count: result.equipmentLinked.length },
      }));
    }
  }

  if (applySet.has('createMissingUnits')) {
    const rows = (await withRecordsTenant(ctx, loadMultiUnitCandidates)).filter(multiUnitUnderLinked);
    for (const r of rows) {
      const created = await createMissingUnitsForDocument(ctx, r, { dryRun });
      result.unitsCreated.push(...created);
    }
    if (result.unitsCreated.length && !dryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.create_missing_units', resource_type: 'tenant',
        changes: { count: result.unitsCreated.length },
      }));
    }
  }

  return result;
}

/**
 * HTTP-facing entry point (api/review.js's `action: 'integrityFix'`).
 * Admin-only when the tenant is a Clerk org — same gate as deleteDocuments;
 * a solo tenant is its own admin.
 */
export async function integrityFix(ctx, opts, auth) {
  try {
    if (hasShop(auth)) requireRole(auth, 'admin');
  } catch (err) {
    if (err instanceof AuthError) throw new ReviewError(err.message, err.status);
    throw err;
  }
  return applyIntegrityFix(ctx, opts, auth?.userId);
}

/**
 * cron-sweep.js's nightly, unattended caller — no HTTP auth to gate on (the
 * route itself is CRON_SECRET-protected), so this skips straight to the
 * work with no acting user. Kept as its own export rather than a flag on
 * integrityFix so nothing outside cron-sweep.js can reach the unattended
 * path.
 */
export async function integrityFixTenant(ctx, opts) {
  return applyIntegrityFix(ctx, opts, null);
}

/**
 * Narrow, cheap repair for exactly one document — run right after extraction
 * (extractDocument.js) so a new document never sits unlinked waiting for the
 * nightly sweep. Deliberately does NOT touch mergeDuplicates or
 * createMissingUnits (both tenant-wide scans, too costly to run on every
 * extraction) — only the two per-document link checks. Best-effort: never
 * throws, since a repair pass must not fail the extraction it follows.
 */
export async function integrityFixDocument(ctx, documentId) {
  if (!isUuid(documentId)) return { documentsLinked: [], equipmentLinked: [] };
  try {
    const docRow = (await withRecordsTenant(ctx, (db) => loadUnlinkedCandidates(db, documentId)))[0];
    const documentsLinked = [];
    if (docRow && isUnlinkedDocument(docRow)) {
      const customerId = await withRecordsTenant(ctx, (db) => db.suggestCustomer({ customer_name: docRow.customerName, service_address: docRow.serviceAddress }));
      if (customerId) {
        await withRecordsTenant(ctx, (db) => linkDocumentToCustomer(db, { documentId, customerId, confidence: 0.75 }));
        documentsLinked.push({ documentId, customerId });
      }
    }
    return { documentsLinked, equipmentLinked: [] };
  } catch (err) {
    console.error('integrityFixDocument: best-effort repair failed:', documentId, err?.message);
    return { documentsLinked: [], equipmentLinked: [] };
  }
}
