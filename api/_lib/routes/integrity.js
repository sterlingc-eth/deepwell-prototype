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
  findDuplicateCustomerPairs, isUnlinkedDocument,
  isEquipmentMissingCustomer, multiUnitUnderLinked, CUSTOMER_MATCH_THRESHOLD,
  unitIndexBackfillPlan, groupExtractionRowsByUnit, coalesceEntityData,
  isLikelyShopAddress, normalizeAddressKey, normalizeSurname, compareNamesStrict,
  isAddressOnlyCustomer, isLikelyShopPhone, isLikelyShopEmail, buildContactAddressCounts,
} from '../integrity.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const CUSTOMER_SCAN_LIMIT = 500;
const DOCUMENT_SCAN_LIMIT = 1000;
// Destructive/irreversible-feeling actions, admin-gated (integrityFix below)
// regardless of what else is in `apply`. stripShopContact and
// relinkMismatchedNames (limit-test defects A/C, 2026-09-20) join this list:
// both rewrite/repoint an existing customer's data rather than only adding a
// link or filling a blank, so they get the same admin gate as mergeDuplicates.
const ADMIN_ONLY_ACTIONS = new Set(['mergeDuplicates', 'retireShopCustomers', 'stripShopContact', 'relinkMismatchedNames']);
const APPLY_ACTIONS = new Set([
  'mergeDuplicates', 'linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits', 'healMergedSurvivors',
  'retireShopCustomers', 'stripShopContact', 'relinkMismatchedNames',
]);

// ------------------------------------------------------------------ reads --

async function loadCustomersForScan(db) {
  const rows = await db.raw(
    `SELECT id, customer_number, data->>'customer_name' AS name, data->>'service_address' AS address,
            data->>'phone' AS phone, data->>'email' AS email
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
      ORDER BY created_at LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  // phone/email feed evaluateCustomerMatch's hard-veto + auto-tier contact
  // check (integrity.js, owner "strict rules" follow-up 2026-09-20).
  return rows.rows.map((r) => ({
    id: r.id, customerNumber: r.customer_number, name: r.name, address: r.address, phone: r.phone, email: r.email,
  }));
}

/** One row per document that names a customer_name/service_address, with
 *  whether a DIRECT document_entity_links row to a customer entity already
 *  exists. `documentId` narrows to exactly one document — used by
 *  integrityFixDocument's cheap post-extraction repair, so it never pays for
 *  a tenant-wide scan.
 *
 *  ROOT CAUSE FIX (2026-09-20, handoffs/LINKING_ROOT_CAUSE_2026-09-20.md,
 *  "Margaret Henderson" defect): this used to also count a document as
 *  "linked to a customer" via its EQUIPMENT's entities.customer_id (two
 *  extra UNION branches, removed) — but the frontend never reads that column
 *  transitively (src/core/customer.ts's customerForDocument only trusts
 *  doc.linkedEntityIds, i.e. a direct document_entity_links row or
 *  extractions.entity_id, and extractions.entity_id is always the equipment,
 *  never the customer). A document whose equipment already had a customer_id
 *  set — true of nearly every document extracted before the "Bug B" fix that
 *  made the direct customer link unconditional — read as "already fine" here
 *  and was silently skipped by every repair path (this scan, the nightly
 *  sweep, "Fix everything"), while Review still showed it unowned forever.
 *  Now this only recognizes the SAME direct link the UI does, so the scan
 *  and its fixes actually see every document the screens call unlinked. */
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

/** Every merged (dropped) entity whose merged_into points at a currently
 *  LIVE survivor (survivor.merged_into IS NULL) — healMergedSurvivors'
 *  candidate set. A chain (X merged into Y, Y later merged into Z) is left
 *  for a later pass once Y itself is a live survivor pointed at by nothing
 *  further, rather than guessed at here. */
async function loadMergedSurvivorCandidates(db) {
  const rows = await db.raw(
    `SELECT dropped.id AS dropped_id, dropped.data AS dropped_data,
            survivor.id AS survivor_id, survivor.data AS survivor_data
       FROM entities dropped
       JOIN entities survivor ON survivor.id = dropped.merged_into
      WHERE dropped.merged_into IS NOT NULL AND survivor.merged_into IS NULL AND dropped.${TENANT}
      LIMIT ${CUSTOMER_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({
    droppedId: r.dropped_id, droppedData: r.dropped_data,
    survivorId: r.survivor_id, survivorData: r.survivor_data,
  }));
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

/** Address keys isLikelyShopAddress flags, each paired with the address-only
 *  PLACEHOLDER customer sitting at that address (if one exists — that's what
 *  retireShopCustomers acts on; `placeholderCustomerId: null` means the
 *  pattern was detected but nothing was ever created from it, nothing to
 *  retire). Reviewer follow-up, 2026-09-20 — see integrity.js's
 *  isLikelyShopAddress doc comment for the two signals. `shopContext`, when
 *  passed, is reused instead of re-querying (integrityScan already computes
 *  it once for the whole scan). */
async function loadSuspectedShopAddresses(db, shopContext) {
  shopContext = shopContext ?? await db.loadShopAddressContext();
  const flagged = Object.entries(shopContext.letterheadCounts)
    .filter(([addrKey]) => isLikelyShopAddress(addrKey, shopContext))
    .map(([addressKey, counts]) => ({ addressKey, ...counts }));
  if (shopContext.tenantAddressKey && !flagged.some((f) => f.addressKey === shopContext.tenantAddressKey)) {
    flagged.push({ addressKey: shopContext.tenantAddressKey, shopAddressDocs: 0, serviceAddressDocs: 0, distinctCustomerNames: 0, viaTenantAddress: true });
  }
  if (!flagged.length) return flagged;

  const placeholders = await db.raw(
    `SELECT id, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND ${TENANT} AND merged_into IS NULL
        AND data->>'name_source' = 'address'`,
    []
  );
  const placeholderByKey = new Map();
  for (const p of placeholders.rows) {
    const key = normalizeAddressKey(p.address);
    if (key) placeholderByKey.set(key, p.id);
  }
  return flagged.map((f) => ({ ...f, placeholderCustomerId: placeholderByKey.get(f.addressKey) ?? null }));
}

/** Address-only PLACEHOLDER customers (data.name_source='address') sitting at
 *  an address isLikelyShopAddress flags — retireShopCustomers' target list.
 *  Never touches a REAL (named) customer, even one that happens to share an
 *  address with the shop — only ever a placeholder this same address-only
 *  path created. */
async function loadShopCustomersToRetire(db) {
  const shopContext = await db.loadShopAddressContext();
  const placeholders = await db.raw(
    `SELECT id, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND ${TENANT} AND merged_into IS NULL
        AND data->>'name_source' = 'address'`,
    []
  );
  const targets = [];
  for (const p of placeholders.rows) {
    const addrKey = normalizeAddressKey(p.address);
    if (addrKey && isLikelyShopAddress(addrKey, shopContext)) targets.push({ id: p.id, addressKey: addrKey });
  }
  return targets;
}

/** Builds isLikelyShopPhone/isLikelyShopEmail's ctx from a scan's already-
 *  loaded `customers` rows plus the tenant's own configured phone/email
 *  (carried on `shopContext` — see recordsStore.js's computeShopAddressContext,
 *  extended for this). Pure once `customers`/`shopContext` are in hand — no
 *  extra query beyond what integrityScan/applyIntegrityFix already run. */
function buildContactCtx(customers, shopContext) {
  const { phoneAddressCounts, emailAddressCounts } = buildContactAddressCounts(customers);
  return {
    tenantPhoneKey: shopContext?.tenantPhoneKey ?? null,
    tenantEmailKey: shopContext?.tenantEmailKey ?? null,
    phoneAddressCounts,
    emailAddressCounts,
  };
}

/** Limit-test defect A (2026-09-20): customers whose phone/email is a likely
 *  shop value under `contactCtx` — stripShopContact's scan+fix target list.
 *  Pure once `customers` is in hand. */
function findShopContactLeaks(customers, contactCtx) {
  const leaks = [];
  for (const c of customers) {
    if (c.phone && isLikelyShopPhone(c.phone, contactCtx)) leaks.push({ customerId: c.id, field: 'phone', value: c.phone });
    if (c.email && isLikelyShopEmail(c.email, contactCtx)) leaks.push({ customerId: c.id, field: 'email', value: c.email });
  }
  return leaks;
}

/**
 * Limit-test defect C repair target (2026-09-20): a document whose DIRECT
 * customer link (document_entity_links -> a customer entity) disagrees at
 * the name level with what the document itself extracted as customer_name —
 * "a different business at the same address was silently absorbed" damage
 * done before the selectCustomerMatch fix above existed. Ignores address-only
 * placeholder customers (nothing to disagree with — a placeholder's name IS
 * the address) and merged-away rows (already excluded by the `merged_into IS
 * NULL` filter on the join).
 *
 * Review fix (2026-09-20, reviewer NO-GO item 1): relinkMismatchedNames
 * unlinks and re-links whatever this returns, so it must never include a
 * link a HUMAN made. ReviewScreen's "Change customer…" (LinkedCustomerSection
 * -> customerClient.assignDocument) writes `linked_by = 'human'`
 * (reviewStore.js's assignDocumentCustomer), never 'ai' or 'ai:name-only';
 * the generic entity-link picker (reviewStore.js's linkDocument, `linked_by =
 * by`) never offers a customer as a link target today, but is excluded on
 * the same terms if that ever changes. `linked_by IN ('ai','ai:name-only')`
 * is an ALLOW-list rather than excluding 'human' by name, so it fails closed
 * against any value it doesn't recognize — a Clerk user id, a future
 * provenance string, anything. A document a HUMAN has already reviewed
 * (`verified_by` set to anything other than 'ai') is excluded too, even if
 * its link still happens to say 'ai' — a person's verification implicitly
 * confirmed the customer and must not be silently relinked afterward.
 * Auto-verification (recordsStore.js's aiVerify stamps `verified_by = 'ai'`,
 * stage 'verified') is NOT a human review: the limit test of 2026-09-20
 * showed every pipeline document lands at stage 'verified'/'ai', so
 * excluding those would make this step a no-op on exactly the documents it
 * exists to repair (Desert Ridge Dental → Plaza Dental Group). `isEligibleForRelink` below pins this exact rule as a
 * plain function, re-applied in JS as defense in depth.
 */
/**
 * Pure: the same eligibility rule the SQL above encodes (`linked_by IN
 * ('ai','ai:name-only')` and not verified), pinned as a plain function per
 * reviewStore.js's own pattern ("a future edit to the SQL can be checked
 * against the same rule without a database") — see scripts/verify-integrity.mjs.
 * Applied again in JS below as defense in depth, not instead of the SQL
 * filter: a link a human made, or a document a human has already verified,
 * must never be a relinkMismatchedNames candidate, however the row got here.
 */
export function isEligibleForRelink({ linkedBy, verifiedBy, stage }) {
  if (linkedBy !== 'ai' && linkedBy !== 'ai:name-only') return false;
  // A human verification (any verified_by other than the pipeline's own
  // 'ai' stamp) locks the link. stage alone says nothing about who did it.
  if (verifiedBy && verifiedBy !== 'ai') return false;
  if (stage === 'verified' && verifiedBy && verifiedBy !== 'ai') return false;
  return true;
}

async function loadMismatchedDirectLinks(db) {
  const rows = await db.raw(
    `SELECT l.document_id, l.entity_id AS customer_id, e.data AS customer_data,
            l.linked_by, d.verified_by, d.stage,
            (SELECT COALESCE(x.corrected_value, x.value) FROM extractions x
              WHERE x.document_id = l.document_id AND x.field_key = 'customer_name' AND x.value IS NOT NULL
                AND x.${TENANT}
              ORDER BY x.confidence DESC NULLS LAST, x.id LIMIT 1) AS doc_customer_name
       FROM document_entity_links l
       JOIN entities e ON e.id = l.entity_id
       JOIN documents d ON d.id = l.document_id
      WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND l.${TENANT}
        AND l.linked_by IN ('ai', 'ai:name-only')
        AND (d.verified_by IS NULL OR d.verified_by = 'ai')
      LIMIT ${DOCUMENT_SCAN_LIMIT}`,
    []
  );
  return rows.rows
    .filter((r) => isEligibleForRelink({ linkedBy: r.linked_by, verifiedBy: r.verified_by, stage: r.stage }))
    .filter((r) => r.doc_customer_name && String(r.doc_customer_name).trim() && !isAddressOnlyCustomer(r.customer_data))
    .filter((r) => compareNamesStrict(r.doc_customer_name, r.customer_data?.customer_name) === 'no-match')
    .map((r) => ({ documentId: r.document_id, customerId: r.customer_id, docCustomerName: r.doc_customer_name }));
}

/**
 * Limit-test defect B, item 3 (2026-09-20): a document whose DIRECT customer
 * (document_entity_links -> customer) differs from the customer its LINKED
 * UNIT belongs to (entities.customer_id, reached either via
 * document_entity_links or extractions.entity_id) — the
 * 36-service-ticket-paterson shape: direct link -> "Paterson", unit link ->
 * "Patterson". Needs-attention only; no auto-fix (which of the two
 * customers is "right" is a judgement call this scan does not make).
 */
async function loadSplitLinkDocuments(db) {
  const rows = await db.raw(
    `WITH direct_customer AS (
       SELECT l.document_id, l.entity_id AS customer_id
         FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE e.entity_type = 'customer' AND l.${TENANT}
     ),
     unit_customer AS (
       SELECT x.document_id, eq.customer_id
         FROM extractions x JOIN entities eq ON eq.id = x.entity_id
        WHERE eq.entity_type = 'equipment' AND eq.customer_id IS NOT NULL AND x.${TENANT}
        UNION
       SELECT l.document_id, eq.customer_id
         FROM document_entity_links l JOIN entities eq ON eq.id = l.entity_id
        WHERE eq.entity_type = 'equipment' AND eq.customer_id IS NOT NULL AND l.${TENANT}
     )
     SELECT dc.document_id, dc.customer_id AS direct_customer_id, uc.customer_id AS unit_customer_id
       FROM direct_customer dc JOIN unit_customer uc ON uc.document_id = dc.document_id
      WHERE dc.customer_id IS DISTINCT FROM uc.customer_id
      LIMIT ${DOCUMENT_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ documentId: r.document_id, directCustomerId: r.direct_customer_id, unitCustomerId: r.unit_customer_id }));
}

/**
 * Limit-test defect D (2026-09-20): a document linked to its customer purely
 * by name (`linked_by = 'ai:name-only'` — see recordsStore.js's
 * findOrCreateCustomer/selectCustomerMatch matchBasis, and
 * linkDocumentToCustomer's `linkedBy`) whose surname now matches TWO OR MORE
 * non-merged customers — order-dependent at the moment it was linked
 * (25-correspondence-castillo.pdf's case), and invisible after. Needs-
 * attention only; no auto-fix (deciding which customer is right needs a
 * person). `customers` is the scan's already-loaded list — no extra query.
 */
async function loadAmbiguousNameOnlyLinks(db, customers) {
  const rows = await db.raw(
    `SELECT l.document_id, l.entity_id AS customer_id
       FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND l.linked_by = 'ai:name-only'
        AND l.${TENANT}
      LIMIT ${DOCUMENT_SCAN_LIMIT}`,
    []
  );
  if (!rows.rows.length) return [];

  const bySurname = new Map();
  const customerById = new Map();
  for (const c of customers) {
    customerById.set(c.id, c);
    const s = normalizeSurname(c.name);
    if (!s) continue;
    if (!bySurname.has(s)) bySurname.set(s, []);
    bySurname.get(s).push(c.id);
  }

  const out = [];
  for (const r of rows.rows) {
    const cust = customerById.get(r.customer_id);
    const surname = normalizeSurname(cust?.name);
    const candidates = surname ? (bySurname.get(surname) ?? []) : [];
    if (candidates.length >= 2) out.push({ documentId: r.document_id, customerId: r.customer_id, candidates });
  }
  return out;
}

// ---------------------------------------------------------------- scan API --

export async function integrityScan(ctx) {
  return withRecordsTenant(ctx, async (db) => {
    const [customers, docCandidates, equipCandidates, multiUnitCandidates, orphanEquipment, shopContext, mismatchedNameLinks, splitLinkDocuments] = await Promise.all([
      loadCustomersForScan(db),
      loadUnlinkedCandidates(db),
      loadEquipmentMissingCustomer(db),
      loadMultiUnitCandidates(db),
      loadOrphanEquipment(db),
      db.loadShopAddressContext(),
      loadMismatchedDirectLinks(db),
      loadSplitLinkDocuments(db),
    ]);
    const suspectedShopAddresses = await loadSuspectedShopAddresses(db, shopContext);

    // Limit-test defect A (2026-09-20): a phone/email shared as a likely shop
    // value is excluded from evaluateCustomerMatch's identity check entirely
    // (see integrity.js's buildMatchEvidence) — otherwise every customer that
    // still carries the leaked shop number "matches" every other on phone.
    const contactCtx = buildContactCtx(customers, shopContext);
    const duplicateCustomers = findDuplicateCustomerPairs(customers, { ctx: contactCtx });
    const shopContactLeaks = findShopContactLeaks(customers, contactCtx);
    const ambiguousNameOnlyLinks = await loadAmbiguousNameOnlyLinks(db, customers);

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
      suspectedShopAddresses,
      shopContactLeaks,
      mismatchedNameLinks,
      splitLinkDocuments,
      ambiguousNameOnlyLinks,
      counts: {
        duplicateCustomers: duplicateCustomers.length,
        unlinkedDocuments: unlinkedDocuments.length,
        equipmentWithoutCustomer: equipWithoutCustomer.length,
        multiUnitDocsUnderLinked: multiUnitDocsUnderLinked.length,
        orphanEquipment: orphanEquipment.length,
        suspectedShopAddresses: suspectedShopAddresses.length,
        shopContactLeaks: shopContactLeaks.length,
        mismatchedNameLinks: mismatchedNameLinks.length,
        splitLinkDocuments: splitLinkDocuments.length,
        ambiguousNameOnlyLinks: ambiguousNameOnlyLinks.length,
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
 * Limit-test defect C repair (2026-09-20): a document flagged by
 * loadMismatchedDirectLinks — its DIRECT customer link disagrees at the name
 * level with what it actually extracted. Unlinks it from the wrong customer,
 * re-resolves via the (now name-checked) findOrCreateCustomer, links to the
 * result, and moves any equipment unit THIS document introduced (its serial
 * appears on no other document already tied to the old customer) over to the
 * new one — reusing linkDocumentToCustomer/findOrCreateCustomer rather than
 * reimplementing linking. Returns `{documentId, fromCustomerId, toCustomerId,
 * unitsMoved}`.
 */
async function relinkMismatchedNameDocument(ctx, { documentId, customerId: oldCustomerId }) {
  return withRecordsTenant(ctx, async (db) => {
    const rows = await db.listExtractionsByDocument(documentId);
    const facts = {};
    for (const r of rows) {
      const v = r.corrected_value ?? r.value;
      if (v != null && String(v).trim() !== '' && facts[r.field_key] == null) facts[r.field_key] = v;
    }
    const docSerials = new Set(
      rows
        .filter((r) => r.field_key === 'serial_number')
        .map((r) => String(r.corrected_value ?? r.value ?? '').trim().toLowerCase())
        .filter(Boolean)
    );

    await db.raw(
      `DELETE FROM document_entity_links WHERE document_id = $1 AND entity_id = $2 AND ${TENANT}`,
      [documentId, oldCustomerId]
    );

    const newCustomer = await db.findOrCreateCustomer(facts);
    let unitsMoved = 0;
    if (newCustomer?.id && newCustomer.id !== oldCustomerId) {
      await linkDocumentToCustomer(db, {
        documentId, customerId: newCustomer.id, confidence: 0.75,
        linkedBy: newCustomer.matchBasis === 'name-only' ? 'ai:name-only' : 'ai',
      });

      if (docSerials.size) {
        // Every serial this document shares with some OTHER document already
        // tied to the old customer stays put — this document didn't
        // introduce it. Only a serial appearing on no document but this one
        // moves with it.
        const otherDocs = await db.raw(
          `SELECT DISTINCT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
             WHERE e.customer_id = $1 AND e.entity_type = 'equipment' AND l.${TENANT} AND l.document_id <> $2
            UNION
           SELECT DISTINCT x.document_id FROM extractions x JOIN entities e ON e.id = x.entity_id
             WHERE e.customer_id = $1 AND e.entity_type = 'equipment' AND x.${TENANT} AND x.document_id <> $2`,
          [oldCustomerId, documentId]
        );
        const otherDocIds = otherDocs.rows.map((r) => r.document_id);
        let otherSerials = new Set();
        if (otherDocIds.length) {
          const otherRows = await db.raw(
            `SELECT DISTINCT lower(COALESCE(corrected_value, value)) AS serial FROM extractions
              WHERE field_key = 'serial_number' AND document_id = ANY($1::uuid[]) AND ${TENANT}`,
            [otherDocIds]
          );
          otherSerials = new Set(otherRows.rows.map((r) => r.serial).filter(Boolean));
        }
        for (const serial of docSerials) {
          if (otherSerials.has(serial)) continue;
          const r = await db.raw(
            `UPDATE entities SET customer_id = $3, updated_at = NOW()
               WHERE entity_type = 'equipment' AND customer_id = $1 AND merged_into IS NULL
                 AND lower(data->>'serial_number') = $2 AND ${TENANT}`,
            [oldCustomerId, serial, newCustomer.id]
          );
          unitsMoved += r.rowCount;
        }
      }
    }
    return { documentId, fromCustomerId: oldCustomerId, toCustomerId: newCustomer?.id ?? null, unitsMoved };
  });
}

// ---- Inbox link-sweep debounce (reviewer follow-up, 2026-09-20) -----------
// usePostgresSync.ts's runInboxLinkSweep already guards itself to once per
// browser tab per page load, but that is a CLIENT guard — nothing stops two
// tabs, two signed-in users on the same tenant, or a reload seconds later
// from calling this again. This is the SERVER backstop, scoped ONLY to the
// exact shape that sweep uses (apply ⊆ {linkDocuments, linkEquipmentCustomers},
// never dryRun) — an admin's explicit "Fix everything" click (which also
// requests mergeDuplicates/createMissingUnits/etc.) is never debounced.
//
// Module-level Map: per-instance only (a cold start or a different warm
// instance starts fresh) — best-effort, not a lock; every fix this sweep runs
// is idempotent (ON CONFLICT DO NOTHING / fill-only), so a sweep that slips
// through twice does no extra work the second time. Also persisted to
// tenants.settings->>'integrity_last_link_sweep' (jsonb column present since
// M3-config/01-create-schema.sql — no new migration) via a single
// compare-and-swap UPDATE, so the debounce survives a cold start across
// instances; a lookup/grant failure degrades to the module-level Map alone.
const LINK_SWEEP_DEBOUNCE_MS = 10 * 60 * 1000;
const LINK_SWEEP_ONLY_ACTIONS = new Set(['linkDocuments', 'linkEquipmentCustomers']);
const lastLinkSweepByTenant = new Map();

function isLinkSweepOnly(apply) {
  const list = Array.isArray(apply) ? apply : [];
  return list.length > 0 && list.every((a) => LINK_SWEEP_ONLY_ACTIONS.has(a));
}

/** @returns {Promise<boolean>} true when a sweep ran too recently for this
 *  tenant and the caller should skip; false (and this call is now the
 *  recorded "last run") otherwise. */
async function debounceLinkSweep(ctx) {
  const now = Date.now();
  const memKey = ctx.tenantKey;
  const memLast = lastLinkSweepByTenant.get(memKey);
  if (memLast && now - memLast < LINK_SWEEP_DEBOUNCE_MS) return true;

  try {
    const allowed = await withRecordsTenant(ctx, async (db) => {
      const cutoff = new Date(now - LINK_SWEEP_DEBOUNCE_MS).toISOString();
      const r = await db.raw(
        `UPDATE tenants
            SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('integrity_last_link_sweep', $2)
          WHERE id = (current_setting('app.tenant_id', true))::uuid
            AND ( settings->>'integrity_last_link_sweep' IS NULL
                  OR (settings->>'integrity_last_link_sweep')::timestamptz < $1::timestamptz )
          RETURNING 1`,
        [cutoff, new Date(now).toISOString()]
      );
      return r.rowCount > 0;
    });
    lastLinkSweepByTenant.set(memKey, now);
    return !allowed;
  } catch (err) {
    console.error('debounceLinkSweep: tenants.settings check failed (falling back to in-memory only):', err?.message);
    lastLinkSweepByTenant.set(memKey, now);
    return false;
  }
}

/**
 * The actual work, no auth check — see integrityFix (HTTP, admin-gated) and
 * integrityFixTenant (cron-sweep's system caller) below, both of which call
 * this. `apply`: any of ['mergeDuplicates','linkDocuments',
 * 'linkEquipmentCustomers','createMissingUnits','healMergedSurvivors',
 * 'retireShopCustomers']. `minMergeScore`: floor for auto-merging duplicate
 * customers (default the same 0.9 bar selectCustomerMatch itself uses);
 * cron-sweep.js passes 0.95 for its unattended nightly run and leaves
 * lower-score pairs as suggestions. Owner "strict rules" follow-up
 * (2026-09-20): a high score alone is no longer enough here — only `tier ===
 * 'auto'` pairs are ever merged unattended (evaluateCustomerMatch, via
 * findDuplicateCustomerPairs); a suggest-tier pair (e.g. matching
 * name/address but phone only on one side) is left for a human in the
 * Customers-tab banner, however high its score.
 *
 * `dryRun` is left undefined rather than defaulted here on purpose:
 * `retireShopCustomers`, `stripShopContact` and `relinkMismatchedNames` each
 * treat anything OTHER than the explicit boolean `false` as dry-run (see
 * below) — stricter than every other action, which default to NOT dry-run
 * (`effectiveDryRun`) exactly as before. All three rewrite or repoint an
 * existing record rather than only adding a link or filling a blank, so an
 * admin has to ask for them twice: once by naming the action, once by
 * passing `dryRun: false`.
 */
async function applyIntegrityFix(ctx, { apply, dryRun, minMergeScore = CUSTOMER_MATCH_THRESHOLD } = {}, actorClerkId) {
  const applySet = new Set((Array.isArray(apply) ? apply : []).filter((a) => APPLY_ACTIONS.has(a)));
  const effectiveDryRun = dryRun ?? false;

  // Reviewer follow-up (2026-09-20): server-side backstop for the Inbox
  // auto-fix, independent of the client's once-per-tab guard.
  if (!effectiveDryRun && isLinkSweepOnly(apply) && (await debounceLinkSweep(ctx))) {
    return { skipped: true, reason: 'recent' };
  }

  const result = {
    dryRun: !!effectiveDryRun, merged: [], documentsLinked: [], equipmentLinked: [], unitsCreated: [],
    survivorsHealed: [], shopCustomersRetired: [], shopContactStripped: [], mismatchedNamesRelinked: [], skipped: [],
  };

  if (applySet.has('mergeDuplicates')) {
    const customers = await withRecordsTenant(ctx, loadCustomersForScan);
    const pairs = findDuplicateCustomerPairs(customers, { threshold: Math.max(minMergeScore, CUSTOMER_MATCH_THRESHOLD) })
      .filter((p) => p.tier === 'auto');
    for (const pair of pairs) {
      if (effectiveDryRun) { result.merged.push(pair); continue; }
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
    // Computed once for the whole loop, not once per row — see
    // recordsStore.js's computeShopAddressContext doc comment.
    const shopContext = effectiveDryRun ? null : await withRecordsTenant(ctx, (db) => db.loadShopAddressContext());
    for (const r of rows) {
      // dryRun must never write: preview with the read-only suggestCustomer
      // (name/address match against EXISTING customers only — no address-
      // only creation to preview, that only happens on the real run below).
      if (effectiveDryRun) {
        const customerId = await withRecordsTenant(ctx, (db) => db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }));
        if (!customerId) { result.skipped.push({ documentId: r.documentId, reason: 'no confident customer match' }); continue; }
        result.documentsLinked.push({ documentId: r.documentId, customerId });
        continue;
      }
      // findOrCreateCustomer, not suggestCustomer (owner root-cause fix,
      // 2026-09-20): a document with a service_address but no customer_name
      // used to be skipped forever ("no confident customer match") since
      // suggestCustomer never creates. findOrCreateCustomer resolves by
      // address against existing customers, or creates a
      // "Customer at <address>" placeholder (data.name_source='address') so
      // the document is never left unowned — see recordsStore.js. It also
      // refuses outright for a likely SHOP address (shopContext, reviewer
      // follow-up 2026-09-20) — that document is left "doesn't state a
      // customer" for a human, not silently attributed to the shop.
      const customer = await withRecordsTenant(ctx, (db) => db.findOrCreateCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }, shopContext));
      if (!customer?.id) { result.skipped.push({ documentId: r.documentId, reason: 'no customer name or address to resolve (or a likely shop address)' }); continue; }
      const didLink = await withRecordsTenant(ctx, (db) => linkDocumentToCustomer(db, {
        documentId: r.documentId, customerId: customer.id, confidence: 0.75,
        linkedBy: customer.matchBasis === 'name-only' ? 'ai:name-only' : 'ai',
      }));
      result.documentsLinked.push({ documentId: r.documentId, customerId: customer.id, alreadyLinked: !didLink });
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
    const shopContext = effectiveDryRun ? null : await withRecordsTenant(ctx, (db) => db.loadShopAddressContext());
    for (const r of rows) {
      if (effectiveDryRun) {
        const customerId = await withRecordsTenant(ctx, (db) => db.suggestCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }));
        if (!customerId) { result.skipped.push({ documentId: null, reason: `equipment ${r.equipmentId}: no confident customer match` }); continue; }
        result.equipmentLinked.push({ equipmentId: r.equipmentId, customerId });
        continue;
      }
      const customer = await withRecordsTenant(ctx, (db) => db.findOrCreateCustomer({ customer_name: r.customerName, service_address: r.serviceAddress }, shopContext));
      if (!customer?.id) { result.skipped.push({ documentId: null, reason: `equipment ${r.equipmentId}: no customer name or address to resolve (or a likely shop address)` }); continue; }
      const n = await withRecordsTenant(ctx, (db) => db.setEquipmentCustomer(r.equipmentId, customer.id));
      if (n > 0) result.equipmentLinked.push({ equipmentId: r.equipmentId, customerId: customer.id });
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
      const created = await createMissingUnitsForDocument(ctx, r, { dryRun: effectiveDryRun });
      result.unitsCreated.push(...created);
    }
    if (result.unitsCreated.length && !effectiveDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.create_missing_units', resource_type: 'tenant',
        changes: { count: result.unitsCreated.length },
      }));
    }
  }

  if (applySet.has('healMergedSurvivors')) {
    const rows = await withRecordsTenant(ctx, loadMergedSurvivorCandidates);
    // One survivor can have more than one dropped row pointing at it; fold
    // them in one at a time. coalesceEntityData is fill-only/prefer-fuller,
    // so folding an already-healed pair again changes nothing — idempotent.
    const bySurvivor = new Map();
    for (const r of rows) {
      if (!bySurvivor.has(r.survivorId)) bySurvivor.set(r.survivorId, { data: r.survivorData ?? {}, dropped: [] });
      bySurvivor.get(r.survivorId).dropped.push(r.droppedData ?? {});
    }
    for (const [survivorId, { data, dropped }] of bySurvivor) {
      const healed = dropped.reduce((acc, d) => coalesceEntityData(acc, d), data);
      if (JSON.stringify(healed) === JSON.stringify(data)) continue; // already healed, nothing changed
      if (effectiveDryRun) { result.survivorsHealed.push({ survivorId }); continue; }
      await withRecordsTenant(ctx, (db) => db.raw(
        `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
        [survivorId, healed]
      ));
      result.survivorsHealed.push({ survivorId });
    }
    if (result.survivorsHealed.length && !effectiveDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.heal_survivor', resource_type: 'tenant',
        changes: { count: result.survivorsHealed.length },
      }));
    }
  }

  if (applySet.has('retireShopCustomers')) {
    // Stricter default than every other action here: anything other than
    // the EXPLICIT boolean `dryRun: false` previews only. An admin who wants
    // this to actually unlink documents must ask for it twice — once by
    // naming the action, once by passing dryRun:false — since unlinking is
    // hard for a person to undo by eye (unlike every other action here,
    // which only ADDS a link or fills a blank).
    const retireDryRun = dryRun !== false;
    const targets = await withRecordsTenant(ctx, loadShopCustomersToRetire);
    for (const t of targets) {
      const linkedDocs = await withRecordsTenant(ctx, (db) => db.raw(
        `SELECT document_id FROM document_entity_links WHERE entity_id = $1 AND ${TENANT}`,
        [t.id]
      ));
      const documentIds = linkedDocs.rows.map((r) => r.document_id);
      if (retireDryRun) {
        result.shopCustomersRetired.push({ customerId: t.id, addressKey: t.addressKey, documentIds });
        continue;
      }
      await withRecordsTenant(ctx, (db) => db.raw(
        `DELETE FROM document_entity_links WHERE entity_id = $1 AND ${TENANT}`,
        [t.id]
      ));
      await withRecordsTenant(ctx, (db) => db.raw(
        `UPDATE entities SET merged_into = NULL, data = data || '{"retired": true}'::jsonb, updated_at = NOW()
          WHERE id = $1 AND ${TENANT}`,
        [t.id]
      ));
      result.shopCustomersRetired.push({ customerId: t.id, addressKey: t.addressKey, documentIds });
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.retire_shop_customer', resource_type: 'entity',
        resource_id: t.id, changes: { addressKey: t.addressKey, documentsUnlinked: documentIds.length },
      }));
    }
  }

  if (applySet.has('stripShopContact')) {
    // Review fix (2026-09-20, reviewer NO-GO item 2): same stricter default
    // as retireShopCustomers above — anything other than the EXPLICIT
    // boolean `dryRun: false` previews only. Removing a field from
    // `entities.data` is not something a person can eyeball-undo the way
    // linkDocuments/linkEquipmentCustomers's fill-a-blank additions are, so
    // it gets the same "ask twice" gate rather than the plain
    // `effectiveDryRun` every additive fix uses.
    const stripDryRun = dryRun !== false;
    // Limit-test defect A (2026-09-20): remove a leaked shop phone/email from
    // `entities.data` outright rather than trying to guess a real value to
    // replace it with — a wrong phone is worse than no phone. Computed fresh
    // (not reused from a scan the caller may not have run) but cheap: one
    // customer list read plus the tenant-context lookup.
    const customers = await withRecordsTenant(ctx, loadCustomersForScan);
    const shopContext = await withRecordsTenant(ctx, (db) => db.loadShopAddressContext());
    const contactCtx = buildContactCtx(customers, shopContext);
    const leaks = findShopContactLeaks(customers, contactCtx);
    for (const leak of leaks) {
      if (stripDryRun) { result.shopContactStripped.push(leak); continue; }
      await withRecordsTenant(ctx, (db) => db.raw(
        `UPDATE entities SET data = data - $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
        [leak.customerId, leak.field]
      ));
      result.shopContactStripped.push(leak);
    }
    if (result.shopContactStripped.length && !stripDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.strip_shop_contact', resource_type: 'tenant',
        changes: { count: result.shopContactStripped.length },
      }));
    }
  }

  if (applySet.has('relinkMismatchedNames')) {
    // Review fix (2026-09-20, reviewer NO-GO item 2): same stricter default
    // as retireShopCustomers/stripShopContact — this unlinks a document from
    // one customer and links it to another, which is exactly the kind of
    // change a person cannot eyeball-undo. Requires the EXPLICIT boolean
    // `dryRun: false`; anything else (including simply omitting `dryRun`)
    // previews only.
    const relinkDryRun = dryRun !== false;
    const candidates = await withRecordsTenant(ctx, loadMismatchedDirectLinks);
    for (const c of candidates) {
      if (relinkDryRun) {
        result.mismatchedNamesRelinked.push({ documentId: c.documentId, fromCustomerId: c.customerId, toCustomerId: null, unitsMoved: 0 });
        continue;
      }
      const r = await relinkMismatchedNameDocument(ctx, { documentId: c.documentId, customerId: c.customerId });
      result.mismatchedNamesRelinked.push(r);
    }
    if (result.mismatchedNamesRelinked.length && !relinkDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.relink_mismatched_names', resource_type: 'tenant',
        changes: { count: result.mismatchedNamesRelinked.length },
      }));
    }
  }

  return result;
}

/**
 * HTTP-facing entry point (api/review.js's `action: 'integrityFix'`).
 * Admin-only when the tenant is a Clerk org AND `apply` includes
 * 'mergeDuplicates' or 'retireShopCustomers' — merging irreversibly retires a
 * customer record (same gate as deleteDocuments/mergeCustomers), and
 * retiring unlinks documents from a placeholder a person would otherwise
 * have to notice went missing. The other actions (linkDocuments,
 * linkEquipmentCustomers, createMissingUnits, healMergedSurvivors) only ADD
 * links or fill blanks — never destructive, ON CONFLICT DO NOTHING/fill-only
 * throughout — so the owner's 2026-09-20 request explicitly does not gate
 * those on admin: any signed-in user (and the Inbox-load auto-fix,
 * usePostgresSync.ts) can run them. A solo tenant is its own admin either way.
 */
export async function integrityFix(ctx, opts, auth) {
  const apply = Array.isArray(opts?.apply) ? opts.apply : [];
  try {
    if (apply.some((a) => ADMIN_ONLY_ACTIONS.has(a)) && hasShop(auth)) requireRole(auth, 'admin');
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
 * (extractDocument.js) AND from usePostgresSync's Inbox-load sweep (item 4,
 * 2026-09-20) so a document never sits unlinked waiting for the nightly
 * sweep. Deliberately does NOT touch mergeDuplicates or createMissingUnits
 * (both tenant-wide scans, too costly to run this often) — only the
 * per-document customer link, via findOrCreateCustomer (which may CREATE an
 * address-only placeholder customer, not just link to an existing one — see
 * that function's doc comment). Best-effort: never throws, since a repair
 * pass must not fail the extraction (or page load) it follows.
 */
export async function integrityFixDocument(ctx, documentId) {
  if (!isUuid(documentId)) return { documentsLinked: [], equipmentLinked: [] };
  try {
    const docRow = (await withRecordsTenant(ctx, (db) => loadUnlinkedCandidates(db, documentId)))[0];
    const documentsLinked = [];
    if (docRow && isUnlinkedDocument(docRow)) {
      // findOrCreateCustomer (can create an address-only placeholder), not
      // suggestCustomer (read-only) — see applyIntegrityFix's linkDocuments
      // branch for why.
      const customer = await withRecordsTenant(ctx, (db) => db.findOrCreateCustomer({ customer_name: docRow.customerName, service_address: docRow.serviceAddress }));
      if (customer?.id) {
        await withRecordsTenant(ctx, (db) => linkDocumentToCustomer(db, {
          documentId, customerId: customer.id, confidence: 0.75,
          linkedBy: customer.matchBasis === 'name-only' ? 'ai:name-only' : 'ai',
        }));
        documentsLinked.push({ documentId, customerId: customer.id });
      }
    }
    return { documentsLinked, equipmentLinked: [] };
  } catch (err) {
    console.error('integrityFixDocument: best-effort repair failed:', documentId, err?.message);
    return { documentsLinked: [], equipmentLinked: [] };
  }
}
