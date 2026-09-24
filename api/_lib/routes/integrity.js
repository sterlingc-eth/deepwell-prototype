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
import { withTenant as withRecordsTenant, linkDocumentToCustomer, linkDocumentToEntity, extractionsHaveUnitIndex, linkedByForMatchBasis } from '../recordsStore.js';
import { mergeCustomers, ReviewError, isUuid, applyShopInternalClassification, wasClassifiedByHuman, shouldClassifyAsShopInternal } from '../reviewStore.js';
import { hasShop, requireRole, AuthError } from '../auth.js';
import { isShopInternalDocument, toCompletenessFields } from '../documentTypes.js';
import { applyBodyNameLinks, planBodyNameLinks } from '../bodyNameLink.js';
import { planPossibleDuplicates, loadKeepSeparatePairs } from './customers.js';
import {
  findDuplicateCustomerPairs, isUnlinkedDocument,
  isEquipmentMissingCustomer, multiUnitUnderLinked, CUSTOMER_MATCH_THRESHOLD,
  unitIndexBackfillPlan, groupExtractionRowsByUnit, coalesceEntityData,
  isLikelyShopAddress, normalizeAddressKey, normalizeSurname, compareNamesStrict,
  isAddressOnlyCustomer, isLikelyShopPhone, isLikelyShopEmail, buildContactAddressCounts,
  normalizePhoneKey, normalizeEmailKey, planAddressPlaceholderAbsorptions, houseNumberOf,
} from '../integrity.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const CUSTOMER_SCAN_LIMIT = 500;
const DOCUMENT_SCAN_LIMIT = 1000;
// Round 4 (2026-09-21) caps: both new evidence queries below join extractions
// across the whole tenant, so each gets its own row cap independent of the
// per-document/per-customer scan limits above.
const CONTACT_EXTRACTION_EVIDENCE_LIMIT = 5000;
const SPLIT_UNIT_EQUIPMENT_LIMIT = 2000;
const SPLIT_UNIT_ROW_LIMIT = 5000;
// Destructive/irreversible-feeling actions, admin-gated (integrityFix below)
// regardless of what else is in `apply`. stripShopContact and
// relinkMismatchedNames (limit-test defects A/C, 2026-09-20) join this list:
// both rewrite/repoint an existing customer's data rather than only adding a
// link or filling a blank, so they get the same admin gate as mergeDuplicates.
// Exported so scripts/verify-review.mjs can pin "classifyShopRecords is an
// applyable, non-admin-gated fix" with no database — both are otherwise
// module-private, checked only from inside applyIntegrityFix/integrityFix.
export const ADMIN_ONLY_ACTIONS = new Set(['mergeDuplicates', 'retireShopCustomers', 'stripShopContact', 'relinkMismatchedNames']);
export const APPLY_ACTIONS = new Set([
  'mergeDuplicates', 'linkDocuments', 'linkEquipmentCustomers', 'createMissingUnits', 'healMergedSurvivors',
  'retireShopCustomers', 'stripShopContact', 'relinkMismatchedNames',
  // Round 4 (2026-09-21): both additive/fill-only, like healMergedSurvivors —
  // never repoint a document or remove data, so they get the plain
  // effectiveDryRun gate and a place in ALL_INTEGRITY_FIXES/cron, not the
  // admin-only "ask twice" gate above.
  'healSplitUnits', 'refillCustomerContacts',
  // Round 2 gap 4 (2026-09-21): also additive/fill-only — only ever merges a
  // placeholder INTO an unambiguously-matched named customer (see
  // planAddressPlaceholderAbsorptions's own doc comment in integrity.js).
  'absorbAddressPlaceholders',
  // Round 5 (2026-09-22): also additive/fill-only — only ever classifies a
  // document that names no customer, unit or job (isShopInternalDocument)
  // and was never human-classified; never repoints or removes anything.
  'classifyShopRecords',
  // 2026-09-23: additive/fill-only and deterministic — links a memo/correspondence whose BODY names exactly one
  // existing customer (bodyNameLink.js); ambiguous/partial matches are only ever reported for review.
  'linkBodyNames',
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

const ADDRESS_PLACEHOLDER_BATCH_LIMIT = 500;
const ADDRESS_PLACEHOLDER_NAMED_CANDIDATE_LIMIT = 5000;

/**
 * Reviewer NO-GO (2026-09-21, round 3, item 1): the round-2 version of this
 * loaded EVERY non-merged customer with a service_address on file — correct
 * (this feeds an EXACT match, so nothing could be sampled away safely), but a
 * full-tenant load on every run. Narrowed the same way
 * recordsStore.js's findOrCreateCustomerByAddress now narrows its own
 * candidate query (houseNumberOf, integrity.js): placeholders are fetched in
 * batches of `ADDRESS_PLACEHOLDER_BATCH_LIMIT` (a nightly sweep runs again
 * tomorrow — this never needs to clear a whole tenant in one pass), then
 * named customers are fetched ONLY when they share a leading house number
 * with one of THIS batch's placeholders (or, for the rare placeholder
 * address with no leading house number, the first 12 characters of
 * normalizeAddressKey) — never the tenant's full customer list.
 * planAddressPlaceholderAbsorptions still requires an EXACT
 * normalizeAddressKey(+unit) match before proposing anything; this only
 * narrows which named rows it gets to compare against.
 */
async function loadAddressPlaceholderCandidates(db) {
  const placeholderRows = (await db.raw(
    `SELECT id, data->>'service_address' AS address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
        AND data->>'name_source' = 'address'
        AND data->>'service_address' IS NOT NULL AND data->>'service_address' <> ''
      LIMIT ${ADDRESS_PLACEHOLDER_BATCH_LIMIT}`,
    []
  )).rows;
  if (!placeholderRows.length) return [];

  const withNumber = placeholderRows.filter((r) => houseNumberOf(r.address));
  const withoutNumber = placeholderRows.filter((r) => !houseNumberOf(r.address));

  const named = new Map();
  if (withNumber.length) {
    const numbers = [...new Set(withNumber.map((r) => houseNumberOf(r.address)))];
    const rows = (await db.raw(
      `SELECT id, data->>'service_address' AS address
         FROM entities
        WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
          AND (data->>'name_source' IS DISTINCT FROM 'address')
          AND data->>'service_address' IS NOT NULL
          AND substring(data->>'service_address' FROM '^(\\d{1,6})') = ANY($1::text[])
        LIMIT ${ADDRESS_PLACEHOLDER_NAMED_CANDIDATE_LIMIT}`,
      [numbers]
    )).rows;
    for (const r of rows) named.set(r.id, r.address);
  }
  if (withoutNumber.length) {
    const patterns = [...new Set(withoutNumber.map((r) => `${normalizeAddressKey(r.address).slice(0, 12)}%`))].filter((p) => p.length > 1);
    if (patterns.length) {
      const rows = (await db.raw(
        `SELECT id, data->>'service_address' AS address
           FROM entities
          WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
            AND (data->>'name_source' IS DISTINCT FROM 'address')
            AND data->>'service_address' IS NOT NULL
            AND data->>'service_address' ILIKE ANY($1::text[])
          LIMIT ${ADDRESS_PLACEHOLDER_NAMED_CANDIDATE_LIMIT}`,
        [patterns]
      )).rows;
      for (const r of rows) named.set(r.id, r.address);
    }
  }

  // Reviewer NO-GO (2026-09-21, round 3, item 2): a placeholder linked to a
  // document a human already touched (a manual link, or a human
  // verification — isEligibleForRelink, above) is locked out of this heal
  // step entirely, regardless of how cleanly its address matches.
  const locked = await loadAddressPlaceholderLinkEligibility(db, placeholderRows.map((r) => r.id));

  const out = placeholderRows.map((r) => ({ id: r.id, address: r.address, isPlaceholder: true, isLocked: locked.has(r.id) }));
  for (const [id, address] of named) out.push({ id, address, isPlaceholder: false });
  return out;
}

/** Reviewer NO-GO (2026-09-21, round 3, item 2): which of `placeholderIds`
 *  have at least one linked document that fails isEligibleForRelink (a
 *  human-made link, or a document a human has already verified) — reuses the
 *  exact same rule relinkMismatchedNames applies, so a placeholder a human
 *  already confirmed via one of its documents is never silently absorbed.
 *  Returns a Set of the LOCKED ids only (absent = eligible). */
async function loadAddressPlaceholderLinkEligibility(db, placeholderIds) {
  const locked = new Set();
  if (!placeholderIds.length) return locked;
  const rows = (await db.raw(
    `SELECT l.entity_id AS customer_id, l.linked_by, d.verified_by, d.stage
       FROM document_entity_links l
       JOIN documents d ON d.id = l.document_id
      WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT}`,
    [placeholderIds]
  )).rows;
  for (const r of rows) {
    if (!isEligibleForRelink({ linkedBy: r.linked_by, verifiedBy: r.verified_by, stage: r.stage })) {
      locked.add(r.customer_id);
    }
  }
  return locked;
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

/**
 * Round 5 (2026-09-22): documents that may be shop-internal records
 * (isShopInternalDocument, api/_lib/documentTypes.js) ingested before that
 * type existed. Unlike loadUnlinkedCandidates above, this does NOT require
 * a customer_name/service_address/serial_number extraction — a shop-internal
 * document has none of those by definition, so it would never appear there
 * at all. Cast a wide net here (any document still short of 'verified', not
 * yet directly linked to a customer) and let the caller run
 * isShopInternalDocument/wasClassifiedByHuman per candidate, the same way
 * loadUnlinkedCandidates's own callers filter with isUnlinkedDocument.
 */
async function loadShopRecordCandidates(db) {
  const rows = await db.raw(
    `SELECT d.id AS document_id, d.document_type
       FROM documents d
      WHERE d.${TENANT} AND d.stage IN ('read', 'mapped', 'linked')
        AND NOT EXISTS (
          SELECT 1 FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
           WHERE l.document_id = d.id AND e.entity_type = 'customer' AND l.${TENANT}
        )
      LIMIT ${DOCUMENT_SCAN_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({ documentId: r.document_id, documentType: r.document_type }));
}

/**
 * Per-candidate verdict for loadShopRecordCandidates: does this document's
 * OWN extraction rows satisfy isShopInternalDocument, and was it never
 * human-classified? Both checks need a per-document query (extractions,
 * audit_log), so this is where loadShopRecordCandidates' broad SQL net gets
 * narrowed to the exact set classifyShopRecords may touch. Shared by the
 * scan count and the fix itself so they never disagree on what qualifies.
 */
async function planShopRecordClassification(db, candidate) {
  const auditRows = await db.getAuditLog({
    action: 'review.document_classified', resource_type: 'document', resource_id: candidate.documentId,
  });
  const humanClassified = wasClassifiedByHuman(candidate.documentType, auditRows);
  const rows = await db.listExtractionsByDocument(candidate.documentId);
  const isShopInternal = isShopInternalDocument(toCompletenessFields(rows));
  // loadShopRecordCandidates' own SQL already excludes anything with a direct
  // customer link (its NOT EXISTS clause) — hasCustomerLink is always false
  // for a row that reaches this function, but the shared predicate is used
  // anyway so scan and fix can never disagree with reclassifyDocuments about
  // what qualifies.
  return shouldClassifyAsShopInternal({ humanClassified, hasCustomerLink: false, isShopInternal });
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

/**
 * Round 4 (2026-09-21): evidence for the shop-contact-address-count
 * heuristic that a customer's OWN `data.phone`/`data.email` field can't see
 * — a document naming the shop's number as `customer_phone` (fill-once
 * wrote it there once, correctly recognized as shop-owned then, but never
 * re-checked once the ONLY customer that still carried it after a strip was
 * a fresh one with no address history) or `shop_phone`/`shop_email` still
 * proves the number/email is the shop's, on that document's customer's
 * address, whether or not it ever made it into that customer's own contact
 * field. Returns `[{address, phone?, email?}]`, straight into
 * buildContactAddressCounts's `extra` param — one row per (customer,
 * matching extraction), `phone` and `email` mutually exclusive per row (SQL
 * CASE, not a JS mapping step). Capped at CONTACT_EXTRACTION_EVIDENCE_LIMIT
 * rows — a heuristic input, not a report; missing a few rows past the cap
 * only makes the floor slightly harder to clear, never wrong.
 */
async function loadContactExtractionEvidence(db) {
  const rows = await db.raw(
    `SELECT ce.data->>'service_address' AS address,
            CASE WHEN x.field_key IN ('customer_phone','shop_phone') THEN COALESCE(x.corrected_value, x.value) END AS phone,
            CASE WHEN x.field_key IN ('customer_email','shop_email') THEN COALESCE(x.corrected_value, x.value) END AS email
       FROM document_entity_links l
       JOIN entities ce ON ce.id = l.entity_id AND ce.entity_type = 'customer' AND ce.merged_into IS NULL AND l.${TENANT}
       JOIN extractions x ON x.document_id = l.document_id AND x.${TENANT}
        AND x.field_key IN ('customer_phone','customer_email','shop_phone','shop_email') AND x.value IS NOT NULL
      LIMIT ${CONTACT_EXTRACTION_EVIDENCE_LIMIT}`,
    []
  );
  return rows.rows;
}

/** Builds isLikelyShopPhone/isLikelyShopEmail's ctx from a scan's already-
 *  loaded `customers` rows plus the tenant's own configured phone/email
 *  (carried on `shopContext` — see recordsStore.js's computeShopAddressContext,
 *  extended for this). `extraContactRows` (round 4, 2026-09-21, optional):
 *  loadContactExtractionEvidence's rows, widening the address-count evidence
 *  beyond each customer's own consolidated phone/email field — see that
 *  function's doc comment. Pure once all three are in hand — no extra query
 *  beyond what the caller already ran. */
function buildContactCtx(customers, shopContext, extraContactRows) {
  const { phoneAddressCounts, emailAddressCounts } = buildContactAddressCounts(customers, extraContactRows);
  return {
    tenantPhoneKey: shopContext?.tenantPhoneKey ?? null,
    tenantEmailKey: shopContext?.tenantEmailKey ?? null,
    // Round-3 fix (2026-09-21): a value learned into tenants.settings.
    // known_shop_contacts is a shop signal on its own, independent of how
    // many customer addresses it currently sits on — see isLikelyShopPhone's
    // own doc comment for why the address-count signal alone isn't durable.
    knownShopPhoneKeys: shopContext?.knownShopPhoneKeys ?? [],
    knownShopEmailKeys: shopContext?.knownShopEmailKeys ?? [],
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
 * Round-3 fix (2026-09-21): after stripping a leaked shop value, look for
 * the REAL value fill-once should have captured — this customer's OWN
 * documents' customer_phone/customer_email extractions, skipping any that
 * are themselves a likely shop value under `contactCtx` (kept current by the
 * caller as it strips each leak — see the stripShopContact loop below).
 * Fill-once had already locked the shop number in on the FIRST document a
 * customer appeared on, so a later document's real number (an invoice
 * printing the customer's own (480) 555-0176) was silently discarded —
 * stripping the leak alone would leave the customer with no phone on file at
 * all when a good one was sitting right there. Returns the first non-shop,
 * non-empty value found (any deterministic order), or null. Read-only.
 */
async function rederiveCustomerContact(db, { customerId, field, contactCtx }) {
  const extractionKey = field === 'phone' ? 'customer_phone' : 'customer_email';
  const isLikelyShop = field === 'phone' ? isLikelyShopPhone : isLikelyShopEmail;
  const rows = await db.raw(
    `SELECT DISTINCT COALESCE(x.corrected_value, x.value) AS value
       FROM document_entity_links l
       JOIN extractions x ON x.document_id = l.document_id AND x.${TENANT}
      WHERE l.entity_id = $1 AND l.${TENANT} AND x.field_key = $2 AND x.value IS NOT NULL
      LIMIT 200`,
    [customerId, extractionKey]
  );
  for (const r of rows.rows) {
    const value = String(r.value ?? '').trim();
    if (!value || isLikelyShop(value, contactCtx)) continue;
    return value;
  }
  return null;
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
  // Round 4 item 4 (2026-09-21): 'ai:name-mention' (recordsStore.js's
  // findOrCreateCustomer, matchBasis 'name-mention') is treated exactly like
  // 'ai:name-only' everywhere — same weak-match provenance, same eligibility.
  if (linkedBy !== 'ai' && linkedBy !== 'ai:name-only' && linkedBy !== 'ai:name-mention') return false;
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
        AND l.linked_by IN ('ai', 'ai:name-only', 'ai:name-mention')
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
 * Round 4 item 1 (2026-09-21): raw material for healSplitUnits — one row per
 * (equipment unit with a serial, document naming that serial). `directCustomerId`
 * is the document's DIRECT customer link (null when it has none). Grouped and
 * decided by the pure planSplitUnitMoves below. Live case this repairs:
 * Desert Ridge Dental's 3 RTUs are still on Plaza Dental Group because the
 * relink that moved their documents ran on the build before
 * planSerialMovesByGroup existed — this heals already-damaged state, not
 * just fresh ingests. Equipment scan capped at SPLIT_UNIT_EQUIPMENT_LIMIT,
 * total joined rows at SPLIT_UNIT_ROW_LIMIT.
 */
async function loadSplitUnitCandidateRows(db) {
  const rows = await db.raw(
    `WITH units AS (
       SELECT id, customer_id, lower(data->>'serial_number') AS serial
         FROM entities
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT}
          AND data->>'serial_number' IS NOT NULL AND data->>'serial_number' <> ''
        LIMIT ${SPLIT_UNIT_EQUIPMENT_LIMIT}
     )
     SELECT u.id AS equipment_id, u.customer_id AS unit_customer_id, u.serial,
            x.document_id, ce.id AS direct_customer_id
       FROM units u
       JOIN extractions x ON x.field_key = 'serial_number' AND x.value IS NOT NULL AND x.${TENANT}
        AND lower(COALESCE(x.corrected_value, x.value)) = u.serial
       LEFT JOIN document_entity_links l ON l.document_id = x.document_id AND l.${TENANT}
       LEFT JOIN entities ce ON ce.id = l.entity_id AND ce.entity_type = 'customer' AND ce.merged_into IS NULL
      LIMIT ${SPLIT_UNIT_ROW_LIMIT}`,
    []
  );
  return rows.rows.map((r) => ({
    equipmentId: r.equipment_id, unitCustomerId: r.unit_customer_id, serial: r.serial,
    documentId: r.document_id, directCustomerId: r.direct_customer_id,
  }));
}

/**
 * Pure: Round 4 item 1 (2026-09-21) — the decision at the heart of
 * healSplitUnits, pinned as a plain function (same isEligibleForRelink/
 * planSerialMovesByGroup pattern) so it is unit-testable without a database.
 * See scripts/verify-integrity.mjs.
 *
 * `rows`: loadSplitUnitCandidateRows' shape — one entry per (equipment,
 * document) pair where that document names the equipment's serial,
 * `{equipmentId, unitCustomerId, serial, documentId, directCustomerId}`
 * (`directCustomerId` null when that document has no direct customer link).
 *
 * A unit moves to `targetCustomerId` only when EVERY document naming its
 * serial has EXACTLY ONE direct customer link, and it's the SAME one across
 * all of them, and that customer differs from the unit's own — i.e. the
 * documents unanimously agree on a different owner. A document with no
 * direct link at all, or documents that disagree (the Paterson/Patterson
 * case: one doc says Paterson, three say Patterson), leaves the unit
 * untouched — it stays in splitLinkDocuments for a human. Returns
 * `[{equipmentId, unitCustomerId, serial, targetCustomerId}]`.
 */
export function planSplitUnitMoves(rows) {
  const byEquip = new Map();
  for (const r of rows || []) {
    if (!r || !r.equipmentId || !r.documentId) continue;
    let g = byEquip.get(r.equipmentId);
    if (!g) {
      g = { equipmentId: r.equipmentId, unitCustomerId: r.unitCustomerId, serial: r.serial, docs: new Map() };
      byEquip.set(r.equipmentId, g);
    }
    if (!g.docs.has(r.documentId)) g.docs.set(r.documentId, new Set());
    if (r.directCustomerId) g.docs.get(r.documentId).add(r.directCustomerId);
  }

  const moves = [];
  for (const g of byEquip.values()) {
    if (!g.docs.size) continue;
    let target;
    let unanimous = true;
    for (const custSet of g.docs.values()) {
      if (custSet.size !== 1) { unanimous = false; break; } // no direct link, or more than one
      const [only] = custSet;
      if (target === undefined) target = only;
      else if (target !== only) { unanimous = false; break; }
    }
    if (unanimous && target && target !== g.unitCustomerId) {
      moves.push({ equipmentId: g.equipmentId, unitCustomerId: g.unitCustomerId, serial: g.serial, targetCustomerId: target });
    }
  }
  return moves;
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
 * Round 4 item 4 (2026-09-21): `linked_by = 'ai:name-mention'` (a document
 * that only MENTIONED its customer in notes/status text) is exactly the same
 * kind of weak, name-only-derived link and gets the same ambiguity check.
 */
async function loadAmbiguousNameOnlyLinks(db, customers) {
  const rows = await db.raw(
    `SELECT l.document_id, l.entity_id AS customer_id
       FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE e.entity_type = 'customer' AND e.merged_into IS NULL
        AND l.linked_by IN ('ai:name-only', 'ai:name-mention')
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
    const [customers, docCandidates, equipCandidates, multiUnitCandidates, orphanEquipment, shopContext, mismatchedNameLinks, splitLinkDocuments, extraContactRows, keepSeparatePairs] = await Promise.all([
      loadCustomersForScan(db),
      loadUnlinkedCandidates(db),
      loadEquipmentMissingCustomer(db),
      loadMultiUnitCandidates(db),
      loadOrphanEquipment(db),
      db.loadShopAddressContext(),
      loadMismatchedDirectLinks(db),
      loadSplitLinkDocuments(db),
      loadContactExtractionEvidence(db),
      loadKeepSeparatePairs(db),
    ]);
    // Owner defect report (2026-09-22): same-address, different-name pairs —
    // never proposed for auto-merge, never counted by findDuplicateCustomerPairs
    // below (see planPossibleDuplicates's own doc comment, routes/customers.js)
    // — surfaced separately so the Inbox "Duplicates" chip stops showing 0.
    const possibleDuplicates = planPossibleDuplicates(customers, { keepSeparatePairs });
    const suspectedShopAddresses = await loadSuspectedShopAddresses(db, shopContext);

    // Limit-test defect A (2026-09-20): a phone/email shared as a likely shop
    // value is excluded from evaluateCustomerMatch's identity check entirely
    // (see integrity.js's buildMatchEvidence) — otherwise every customer that
    // still carries the leaked shop number "matches" every other on phone.
    // Round 4 (2026-09-21): extraContactRows widens the address-count
    // evidence to documents' own customer_phone/shop_phone/shop_email
    // extractions, not just each customer's consolidated phone/email field —
    // see loadContactExtractionEvidence's doc comment.
    const contactCtx = buildContactCtx(customers, shopContext, extraContactRows);
    const duplicateCustomers = findDuplicateCustomerPairs(customers, { ctx: contactCtx });
    const shopContactLeaks = findShopContactLeaks(customers, contactCtx);
    // Round 4: a value only findable via the extraction-evidence signal above
    // was never learned into known_shop_contacts either (that only happens
    // inside stripShopContact's fix loop) — best-effort persist here too so a
    // read-only scan still makes the finding durable, same as isLikelyShopPhone/
    // Email's own doc comment describes. Never throws, never blocks the scan.
    for (const leak of shopContactLeaks) {
      await db.recordKnownShopContact(leak.field === 'phone' ? { phone: leak.value } : { email: leak.value });
    }
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

    // Round 5 (2026-09-22): "shop records not yet filed" — documents that
    // look shop-internal (isShopInternalDocument) but predate the 'internal'
    // type and so are still sitting unlinked/unverified. loadShopRecordCandidates
    // casts a wide net (any not-yet-verified, not-directly-linked document);
    // planShopRecordClassification narrows it to the exact set
    // classifyShopRecords below would actually touch.
    const shopRecordCandidates = await loadShopRecordCandidates(db);
    const shopRecordsNotFiled = [];
    for (const candidate of shopRecordCandidates) {
      if (await planShopRecordClassification(db, candidate)) shopRecordsNotFiled.push(candidate.documentId);
    }

    // 2026-09-23: memos/correspondence whose body names an existing customer (read-only preview of linkBodyNames).
    const bodyNamePlan = await planBodyNameLinks(db, { dryRun: true });

    return {
      bodyNameLinks: bodyNamePlan.linked,
      bodyNameReview: bodyNamePlan.review,
      duplicateCustomers,
      possibleDuplicates,
      unlinkedDocuments,
      equipmentWithoutCustomer: equipWithoutCustomer,
      multiUnitDocsUnderLinked,
      orphanEquipment,
      suspectedShopAddresses,
      shopContactLeaks,
      mismatchedNameLinks,
      splitLinkDocuments,
      ambiguousNameOnlyLinks,
      shopRecordsNotFiled,
      counts: {
        duplicateCustomers: duplicateCustomers.length,
        possibleDuplicates: possibleDuplicates.length,
        unlinkedDocuments: unlinkedDocuments.length,
        equipmentWithoutCustomer: equipWithoutCustomer.length,
        multiUnitDocsUnderLinked: multiUnitDocsUnderLinked.length,
        orphanEquipment: orphanEquipment.length,
        suspectedShopAddresses: suspectedShopAddresses.length,
        shopContactLeaks: shopContactLeaks.length,
        mismatchedNameLinks: mismatchedNameLinks.length,
        splitLinkDocuments: splitLinkDocuments.length,
        ambiguousNameOnlyLinks: ambiguousNameOnlyLinks.length,
        shopRecordsNotFiled: shopRecordsNotFiled.length,
        bodyNameLinks: bodyNamePlan.linked.length,
        bodyNameReview: bodyNamePlan.review.length,
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
 * Limit-test defect C repair (2026-09-20), revised for Round 3 item 2
 * (2026-09-21, live-retest gap): loadMismatchedDirectLinks' whole batch of
 * flagged documents is processed together instead of one at a time, because
 * a unit's serial is often named on SEVERAL of the old customer's documents
 * at once (three RTUs each on multiple relinked tickets) — "did THIS
 * document introduce the serial" was never true for any of them, so the old
 * per-document rule moved 0 units. The rule is now per (fromCustomerId ->
 * toCustomerId) GROUP: a unit moves only when EVERY document that mentioned
 * its serial while linked to the old customer — per a snapshot taken before
 * any relinking starts — ended up relinked into that same group. A document
 * left behind (not a candidate, or ineligible), or relinked to a DIFFERENT
 * new customer, blocks that serial from moving at all (no partial/ambiguous
 * moves). Reuses linkDocumentToCustomer/findOrCreateCustomer rather than
 * reimplementing linking. Returns `{ perDoc: [{documentId, fromCustomerId,
 * toCustomerId}], groups: [{fromCustomerId, toCustomerId, documentIds,
 * unitsMoved}] }`.
 */
/**
 * Pure: Round 3 item 2 (2026-09-21) — the grouping/subset decision at the
 * heart of relinkMismatchedNamesBatch, pinned as a plain function (same
 * pattern as isEligibleForRelink) so it is unit-testable without a database.
 * See scripts/verify-integrity.mjs.
 *
 * `perDocEntries`: one entry per document actually relinked this run —
 * `{documentId, fromCustomerId, toCustomerId, serials}` (serials: any
 * iterable of serial strings; case/whitespace are normalized here). Entries
 * with no toCustomerId, or toCustomerId === fromCustomerId, are ignored.
 *
 * `serialOwners`: the FULL pre-relink ownership snapshot — a Map (or plain
 * object) keyed `${fromCustomerId}::${serial}` -> an iterable of every
 * document id that mentioned that serial while linked to that customer,
 * before this run touched anything. A serial with no key (or an empty
 * owner set) never moves — nothing to confirm "everything left".
 *
 * Returns one entry per (fromCustomerId -> toCustomerId) group that had at
 * least one relinked document: `{fromCustomerId, toCustomerId, documentIds,
 * serialsToMove}`. A serial appears in `serialsToMove` only when EVERY
 * document `serialOwners` lists for it is also in that group's
 * `documentIds` — i.e. nothing that named this serial was left behind
 * (unrelinked) or sent to a different customer.
 */
export function planSerialMovesByGroup(perDocEntries, serialOwners) {
  const groups = new Map();
  for (const d of perDocEntries || []) {
    if (!d || !d.toCustomerId || d.toCustomerId === d.fromCustomerId) continue;
    const key = `${d.fromCustomerId}=>${d.toCustomerId}`;
    let g = groups.get(key);
    if (!g) {
      g = { fromCustomerId: d.fromCustomerId, toCustomerId: d.toCustomerId, documentIds: new Set(), serials: new Set() };
      groups.set(key, g);
    }
    g.documentIds.add(d.documentId);
    for (const s of d.serials || []) {
      const serial = String(s ?? '').trim().toLowerCase();
      if (serial) g.serials.add(serial);
    }
  }

  const getOwners = (key) => {
    const raw = serialOwners instanceof Map ? serialOwners.get(key) : serialOwners?.[key];
    return raw ? [...raw] : undefined;
  };

  const results = [];
  for (const g of groups.values()) {
    const serialsToMove = [];
    for (const serial of g.serials) {
      const owners = getOwners(`${g.fromCustomerId}::${serial}`);
      if (!owners || !owners.length) continue;
      if (owners.every((docId) => g.documentIds.has(docId))) serialsToMove.push(serial);
    }
    results.push({
      fromCustomerId: g.fromCustomerId, toCustomerId: g.toCustomerId,
      documentIds: [...g.documentIds], serialsToMove,
    });
  }
  return results;
}

async function relinkMismatchedNamesBatch(ctx, candidates) {
  return withRecordsTenant(ctx, async (db) => {
    if (!candidates.length) return { perDoc: [], groups: [] };

    // Snapshot, BEFORE any unlinking: for each old customer in this batch,
    // every serial its currently-linked documents mention, and the full set
    // of document ids mentioning each one. This is the "everything about
    // this unit moved" baseline the group check below is measured against.
    const fromCustomerIds = [...new Set(candidates.map((c) => c.customerId))];
    const serialDocs = new Map(); // `${customerId}::${serial}` -> Set(documentId)
    const snapshot = await db.raw(
      `SELECT l.entity_id AS customer_id, l.document_id,
              lower(COALESCE(x.corrected_value, x.value)) AS serial
         FROM document_entity_links l
         JOIN extractions x ON x.document_id = l.document_id AND x.field_key = 'serial_number' AND x.${TENANT}
        WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT}`,
      [fromCustomerIds]
    );
    for (const r of snapshot.rows) {
      const serial = (r.serial || '').trim();
      if (!serial) continue;
      const key = `${r.customer_id}::${serial}`;
      if (!serialDocs.has(key)) serialDocs.set(key, new Set());
      serialDocs.get(key).add(r.document_id);
    }

    // Phase A: relink each candidate document (unlink from old, resolve via
    // the name-checked findOrCreateCustomer, link to the result).
    const perDoc = [];
    for (const c of candidates) {
      const rows = await db.listExtractionsByDocument(c.documentId);
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
        [c.documentId, c.customerId]
      );

      const newCustomer = await db.findOrCreateCustomer(facts);
      const toCustomerId = newCustomer?.id && newCustomer.id !== c.customerId ? newCustomer.id : null;
      if (toCustomerId) {
        await linkDocumentToCustomer(db, {
          documentId: c.documentId, customerId: toCustomerId, confidence: 0.75,
          linkedBy: linkedByForMatchBasis(newCustomer.matchBasis),
        });
      }
      perDoc.push({ documentId: c.documentId, fromCustomerId: c.customerId, toCustomerId, docSerials });
    }

    // Phase B: group the now-relinked documents by (fromCustomerId ->
    // toCustomerId) and decide, per group, which serials move — pure
    // decision, see planSerialMovesByGroup — then execute the moves.
    const plan = planSerialMovesByGroup(
      perDoc.map((d) => ({ documentId: d.documentId, fromCustomerId: d.fromCustomerId, toCustomerId: d.toCustomerId, serials: d.docSerials })),
      serialDocs
    );

    const groupResults = [];
    for (const g of plan) {
      let unitsMoved = 0;
      for (const serial of g.serialsToMove) {
        const r = await db.raw(
          `UPDATE entities SET customer_id = $2, updated_at = NOW()
             WHERE entity_type = 'equipment' AND customer_id = $1 AND merged_into IS NULL
               AND lower(data->>'serial_number') = $3 AND ${TENANT}`,
          [g.fromCustomerId, g.toCustomerId, serial]
        );
        unitsMoved += r.rowCount;
      }
      groupResults.push({
        fromCustomerId: g.fromCustomerId, toCustomerId: g.toCustomerId,
        documentIds: g.documentIds, unitsMoved,
      });
    }

    return {
      perDoc: perDoc.map((d) => ({ documentId: d.documentId, fromCustomerId: d.fromCustomerId, toCustomerId: d.toCustomerId })),
      groups: groupResults,
    };
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
    survivorsHealed: [], shopCustomersRetired: [], shopContactStripped: [], mismatchedNamesRelinked: [],
    unitsMovedByGroup: [], splitUnitsHealed: [], customerContactsFilled: [], addressPlaceholdersAbsorbed: [],
    shopRecordsClassified: [], bodyNamesLinked: [], bodyNamesForReview: [], skipped: [],
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

  if (applySet.has('linkBodyNames')) {
    // Before linkDocuments/classifyShopRecords so a memo that names a customer in its body is linked (not filed as
    // shop-internal, not given an address placeholder). Strict: only a single unambiguous match is linked.
    const { linked, review } = await applyBodyNameLinks(ctx, { dryRun: !!effectiveDryRun });
    result.bodyNamesLinked.push(...linked);
    result.bodyNamesForReview.push(...review);
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
        linkedBy: linkedByForMatchBasis(customer.matchBasis),
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
    // Round-3 fix (2026-09-21): pass the tenant's shop-contact signal too
    // (a no-op for a non-customer entity, which has no phone/email field to
    // begin with) — only fetched when there's actually something to heal.
    const shopContext = rows.length ? await withRecordsTenant(ctx, (db) => db.loadShopAddressContext()) : null;
    const bySurvivor = new Map();
    for (const r of rows) {
      if (!bySurvivor.has(r.survivorId)) bySurvivor.set(r.survivorId, { data: r.survivorData ?? {}, dropped: [] });
      bySurvivor.get(r.survivorId).dropped.push(r.droppedData ?? {});
    }
    for (const [survivorId, { data, dropped }] of bySurvivor) {
      const healed = dropped.reduce((acc, d) => coalesceEntityData(acc, d, shopContext), data);
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

  if (applySet.has('healSplitUnits')) {
    // Round 4 item 1 (2026-09-21), safe/additive like healMergedSurvivors
    // above: only moves a unit when every document naming its serial
    // unanimously points at one other customer (planSplitUnitMoves) — never
    // a judgement call, so it gets the plain effectiveDryRun gate. This is a
    // direct UPDATE (not the fill-only setEquipmentCustomer helper other
    // fixes use) because the live case is a unit that already has a WRONG
    // customer_id set (Desert Ridge Dental's RTUs still on Plaza Dental
    // Group from a relink that ran before planSerialMovesByGroup existed) —
    // a fill-only helper would never touch it.
    const rows = await withRecordsTenant(ctx, loadSplitUnitCandidateRows);
    const moves = planSplitUnitMoves(rows);
    for (const m of moves) {
      if (effectiveDryRun) {
        result.splitUnitsHealed.push({ equipmentId: m.equipmentId, from: m.unitCustomerId, to: m.targetCustomerId });
        continue;
      }
      const r = await withRecordsTenant(ctx, (db) => db.raw(
        `UPDATE entities SET customer_id = $2, updated_at = NOW()
           WHERE id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT}`,
        [m.equipmentId, m.targetCustomerId]
      ));
      if (r.rowCount) result.splitUnitsHealed.push({ equipmentId: m.equipmentId, from: m.unitCustomerId, to: m.targetCustomerId });
    }
    if (result.splitUnitsHealed.length && !effectiveDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.heal_split_units', resource_type: 'tenant',
        changes: { count: result.splitUnitsHealed.length },
      }));
    }
  }

  if (applySet.has('refillCustomerContacts')) {
    // Round 4 item 2 (2026-09-21), fill-only like every other additive fix
    // here: runs the SAME rederiveCustomerContact logic stripShopContact
    // already uses, but for a customer whose phone/email was left empty
    // rather than one that needs a leaked value replaced — currently that
    // logic only ever runs INSIDE a strip, so a customer stripped on an
    // earlier build (before rederiveCustomerContact existed) stayed empty
    // forever. Live case: Ortiz's own invoice prints (480) 555-0176, sitting
    // unused because fill-once locked the shop number in first.
    const customers = await withRecordsTenant(ctx, loadCustomersForScan);
    const emptyCustomers = customers.filter((c) => !c.phone || !c.email);
    if (emptyCustomers.length) {
      const shopContext = await withRecordsTenant(ctx, (db) => db.loadShopAddressContext());
      const extraContactRows = await withRecordsTenant(ctx, loadContactExtractionEvidence);
      const contactCtx = buildContactCtx(customers, shopContext, extraContactRows);
      for (const c of emptyCustomers) {
        for (const field of ['phone', 'email']) {
          if (c[field]) continue;
          const value = await withRecordsTenant(ctx, (db) => rederiveCustomerContact(db, { customerId: c.id, field, contactCtx }));
          if (!value) continue;
          if (effectiveDryRun) { result.customerContactsFilled.push({ customerId: c.id, field, value }); continue; }
          // Fill-only: the WHERE guard re-checks the field is still empty at
          // write time, in case something else filled it between the read
          // above and here.
          const r = await withRecordsTenant(ctx, (db) => db.raw(
            `UPDATE entities SET data = jsonb_set(COALESCE(data, '{}'::jsonb), $2::text[], to_jsonb($3::text)), updated_at = NOW()
               WHERE id = $1 AND ${TENANT} AND (data->>$4 IS NULL OR data->>$4 = '')`,
            [c.id, [field], value, field]
          ));
          if (r.rowCount) result.customerContactsFilled.push({ customerId: c.id, field, value });
        }
      }
    }
    if (result.customerContactsFilled.length && !effectiveDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.refill_customer_contacts', resource_type: 'tenant',
        changes: { count: result.customerContactsFilled.length },
      }));
    }
  }

  if (applySet.has('absorbAddressPlaceholders')) {
    // Round 2 gap 4 (2026-09-21), safe/additive like healMergedSurvivors:
    // mergeCustomers only ever runs on a pair planAddressPlaceholderAbsorptions
    // (integrity.js) already matched EXACTLY (never an ambiguous "several
    // named customers at this street" case), so this gets the plain
    // effectiveDryRun gate, not the admin-only "ask twice" gate mergeDuplicates
    // uses. dropId is always the placeholder (data.name_source='address');
    // mergeCustomers moves its docs/units onto keepId and marks it
    // merged_into, same as any other customer merge.
    const customers = await withRecordsTenant(ctx, loadAddressPlaceholderCandidates);
    const plans = planAddressPlaceholderAbsorptions(customers);
    for (const plan of plans) {
      if (effectiveDryRun) { result.addressPlaceholdersAbsorbed.push(plan); continue; }
      try {
        await mergeCustomers(ctx, { keepId: plan.keepId, dropId: plan.dropId }, actorClerkId);
        await withRecordsTenant(ctx, (db) => db.logAction({
          clerk_user_id: actorClerkId, action: 'integrity.absorb_address_placeholder',
          resource_type: 'entity', resource_id: plan.keepId, changes: plan,
        }));
        result.addressPlaceholdersAbsorbed.push(plan);
      } catch (err) {
        if (!/already been merged/i.test(err?.message ?? '')) {
          result.skipped.push({ documentId: null, reason: `absorb placeholder ${plan.dropId}: ${err?.message}` });
        }
      }
    }
  }

  if (applySet.has('classifyShopRecords')) {
    // Round 5 (2026-09-22), safe/additive like healMergedSurvivors above:
    // isShopInternalDocument only ever fires on a document that names no
    // customer, unit or job at all, and wasClassifiedByHuman is checked
    // first — never overrides a human's own decision — so this gets the
    // plain effectiveDryRun gate, not the admin-only "ask twice" gate.
    // applyShopInternalClassification (reviewStore.js) does the actual
    // write: document_type -> 'internal', AI-verified, `no_customer: true`
    // on its own per-document audit entry.
    const candidates = await withRecordsTenant(ctx, loadShopRecordCandidates);
    for (const candidate of candidates) {
      const eligible = await withRecordsTenant(ctx, (db) => planShopRecordClassification(db, candidate));
      if (!eligible) continue;
      if (effectiveDryRun) {
        result.shopRecordsClassified.push({ documentId: candidate.documentId, from: candidate.documentType, to: 'internal' });
        continue;
      }
      const change = await withRecordsTenant(ctx, (db) => applyShopInternalClassification(db, {
        documentId: candidate.documentId, fromType: candidate.documentType, actorClerkId,
      }));
      if (change) result.shopRecordsClassified.push(change); // null: a customer link appeared, skipped
    }
    if (result.shopRecordsClassified.length && !effectiveDryRun) {
      await withRecordsTenant(ctx, (db) => db.logAction({
        clerk_user_id: actorClerkId, action: 'integrity.classify_shop_records', resource_type: 'tenant',
        changes: { count: result.shopRecordsClassified.length },
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
    // Round 4 (2026-09-21): same widened evidence integrityScan now uses —
    // otherwise a value only findable via an extraction (never written to a
    // customer's own phone/email field once only one customer is left
    // carrying it) never reaches the floor here either.
    const extraContactRows = await withRecordsTenant(ctx, loadContactExtractionEvidence);
    const contactCtx = buildContactCtx(customers, shopContext, extraContactRows);
    const leaks = findShopContactLeaks(customers, contactCtx);
    for (const leak of leaks) {
      if (stripDryRun) { result.shopContactStripped.push(leak); continue; }

      // Round-3 fix (2026-09-21): persist this value into known_shop_contacts
      // BEFORE stripping — durable even once every customer that carried it
      // has been cleaned up and the address-count heuristic can no longer see
      // it (only one customer left, never enough to clear the floor again).
      // Also folded into THIS loop's in-memory contactCtx right away, so a
      // later leak in the SAME run (a different customer sharing the number)
      // and this leak's own re-derivation step both see it immediately,
      // without waiting for a fresh scan.
      await withRecordsTenant(ctx, (db) => db.recordKnownShopContact(
        leak.field === 'phone' ? { phone: leak.value } : { email: leak.value }
      ));
      const learnedKey = leak.field === 'phone' ? normalizePhoneKey(leak.value) : normalizeEmailKey(leak.value);
      if (learnedKey) {
        const listKey = leak.field === 'phone' ? 'knownShopPhoneKeys' : 'knownShopEmailKeys';
        if (!contactCtx[listKey].includes(learnedKey)) contactCtx[listKey] = [...contactCtx[listKey], learnedKey];
      }

      await withRecordsTenant(ctx, (db) => db.raw(
        `UPDATE entities SET data = data - $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
        [leak.customerId, leak.field]
      ));

      // Re-derive: this customer's own documents may have printed the real
      // value all along — fill-once just never got to see it because the
      // shop number was written first. One extra step, same fix.
      const rederivedTo = await withRecordsTenant(ctx, (db) => rederiveCustomerContact(db, { customerId: leak.customerId, field: leak.field, contactCtx }));
      if (rederivedTo) {
        await withRecordsTenant(ctx, (db) => db.raw(
          `UPDATE entities SET data = jsonb_set(data, $2::text[], to_jsonb($3::text)), updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
          [leak.customerId, [leak.field], rederivedTo]
        ));
      }
      result.shopContactStripped.push(rederivedTo ? { ...leak, rederivedTo } : leak);
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
    if (relinkDryRun) {
      for (const c of candidates) {
        result.mismatchedNamesRelinked.push({ documentId: c.documentId, fromCustomerId: c.customerId, toCustomerId: null });
      }
    } else if (candidates.length) {
      const batch = await relinkMismatchedNamesBatch(ctx, candidates);
      result.mismatchedNamesRelinked.push(...batch.perDoc);
      result.unitsMovedByGroup.push(...batch.groups);
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
 * linkEquipmentCustomers, createMissingUnits, healMergedSurvivors,
 * healSplitUnits, refillCustomerContacts, classifyShopRecords) only ADD
 * links or fill blanks — never destructive, ON CONFLICT DO NOTHING/fill-only
 * throughout — so the owner's 2026-09-20 request explicitly does not gate those on admin: any
 * signed-in user (and the Inbox-load auto-fix, usePostgresSync.ts) can run
 * them. A solo tenant is its own admin either way. healSplitUnits (round 4,
 * 2026-09-21) is the one exception to "fill blanks only" — it can overwrite
 * an already-set (wrong) equipment customer_id — but it's still a judgement-
 * free correction: planSplitUnitMoves only ever fires when every document
 * naming the unit's serial unanimously names one other customer, so it's
 * grouped here with the additive fixes rather than the admin-gated ones.
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
          linkedBy: linkedByForMatchBasis(customer.matchBasis),
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
