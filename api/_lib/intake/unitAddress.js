/**
 * UNIT <-> SERVICE ADDRESS, at the source (Round 16, E2 — owner decision 2026-09-26).
 *
 * The gap: an equipment ("unit") entity has never carried its own `service_address` — only the
 * customer entity does (entities.data.service_address). Every equipment entity in the golden
 * export (132 of 132) is missing it. That means an address-based unit question ("is the unit at
 * <addr> under warranty", "who makes the unit at <addr>") can never be answered strictly from the
 * unit's own record — api/_lib/fastPath*.js (E1, this round) currently declines those honestly
 * rather than guess (see scripts/verify-address-lookups.mjs's own header comment).
 *
 * This module is the ONE rule engine both consumers below share, so they can never disagree:
 *   - api/_lib/intake/autofill.js's per-document hook (runs on every new document, going forward)
 *   - api/_lib/backfill/unitAddress.js (one deterministic, idempotent pass over EXISTING data)
 *
 * THE RULE (owner decision):
 *   1. never overwrite a unit that already has its own service_address.
 *   2. if the document/unit's own linked paperwork states a service address for THIS unit, and it
 *      agrees with (or the customer has none on file to compare against), stamp it — rule
 *      'document-stated'.
 *   3. else, if the unit's customer has exactly ONE service address on file (no conflicting
 *      evidence anywhere), stamp the customer's address — rule 'customer-single-address'.
 *   4. if the document/unit's own stated address DISAGREES with the customer's on-file address,
 *      stamp nothing — raise it as an intake question instead (intake_needs_info), same shape as
 *      every other autofill.js conflict.
 *   5. anything else (no customer address, ambiguous/multi-address customer, nothing stated) ->
 *      leave it blank. Accuracy over coverage: a wrong stamp is worse than a unit that stays
 *      unanswered a while longer.
 *
 * Every stamp carries its own provenance in entities.data.service_address_source (rule, which
 * document it came from, which customer, when) — nothing here duplicates writing to
 * `extractions` (autofill.js's own doc comment explains why an inferred/derived value never
 * belongs there); a citation for an address answered this way points at the unit's own linked
 * documents (document_entity_links / extractions.entity_id), exactly like any other equipment fact.
 *
 * Pure decision function (decideUnitAddress) has zero DB dependency — see
 * scripts/verify-unit-address.mjs's pure section for its own unit tests. Everything below it talks
 * to Postgres, tenant-scoped (TENANT_SQL, same as every other reader in this codebase).
 */
import { normalizeAddressKey } from '../integrity.js';
import { TENANT_SQL } from '../scope.js';

export const RULE = Object.freeze({
  DOCUMENT_STATED: 'document-stated',
  CUSTOMER_SINGLE_ADDRESS: 'customer-single-address',
});

export const OUTCOME = Object.freeze({
  HAS_ADDRESS: 'has-address', // never overwrite
  STAMP: 'stamp',
  CONFLICT: 'conflict',
  NO_DATA: 'no-data',
});

function clean(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/* ============================================================================ pure rule engine */

/**
 * @param {object} p
 * @param {string|null} [p.existingAddress]   the unit's OWN data.service_address, if any
 * @param {string|null} [p.customerAddress]    the unit's customer's data.service_address, if any
 * @param {boolean} [p.customerHasSingleAddress]  true when nothing on file contradicts customerAddress
 * @param {string|null} [p.documentAddress]    a service address THIS unit's own paperwork states
 * @param {boolean} [p.documentAddressConflicting]  true when the unit's OWN documents disagree with
 *   EACH OTHER about its address (so there is no single "document-stated" value to use at all)
 * @returns {{outcome: string, address?: string, rule?: string, reason?: string,
 *            documentAddress?: string, customerAddress?: string}}
 */
export function decideUnitAddress({
  existingAddress = null,
  customerAddress = null,
  customerHasSingleAddress = false,
  documentAddress = null,
  documentAddressConflicting = false,
} = {}) {
  if (clean(existingAddress)) return { outcome: OUTCOME.HAS_ADDRESS };

  if (documentAddressConflicting) {
    return { outcome: OUTCOME.CONFLICT, reason: 'unit-documents-disagree' };
  }

  const doc = clean(documentAddress);
  const cust = clean(customerAddress);

  if (doc && cust && normalizeAddressKey(doc) !== normalizeAddressKey(cust)) {
    return { outcome: OUTCOME.CONFLICT, reason: 'document-customer-mismatch', documentAddress: doc, customerAddress: cust };
  }
  if (doc) return { outcome: OUTCOME.STAMP, address: doc, rule: RULE.DOCUMENT_STATED };
  if (cust && customerHasSingleAddress) return { outcome: OUTCOME.STAMP, address: cust, rule: RULE.CUSTOMER_SINGLE_ADDRESS };
  return { outcome: OUTCOME.NO_DATA };
}

/* ================================================================================ DB: reads */

/**
 * The unit's customer's own on-file address, plus whether anything else on file for that customer
 * contradicts it. "hasSingleAddress" is what the owner's rule 3 means by "exactly one service
 * address on file": the customer entity's own address is non-empty AND no document linked
 * directly to the customer entity states field_key='service_address' with a DIFFERENT value.
 */
export async function loadCustomerAddressInfo(db, customerId) {
  if (!customerId) return { address: null, hasSingleAddress: false };
  const custRes = await db.raw(
    `SELECT data->>'service_address' AS address FROM entities
      WHERE id = $1 AND ${TENANT_SQL} AND entity_type = 'customer' AND merged_into IS NULL`,
    [customerId]
  );
  const address = clean(custRes.rows[0]?.address);
  if (!address) return { address: null, hasSingleAddress: false };

  const conflictRes = await db.raw(
    `SELECT DISTINCT COALESCE(x.corrected_value, x.value) AS addr
       FROM extractions x
       JOIN document_entity_links l
         ON l.document_id = x.document_id AND l.entity_id = $1 AND ${TENANT_SQL.replace('tenant_id', 'l.tenant_id')}
      WHERE x.field_key = 'service_address' AND ${TENANT_SQL.replace('tenant_id', 'x.tenant_id')}
        AND COALESCE(x.corrected_value, x.value) IS NOT NULL AND btrim(COALESCE(x.corrected_value, x.value)) <> ''`,
    [customerId]
  );
  const keys = new Set([normalizeAddressKey(address)]);
  for (const row of conflictRes.rows) {
    const k = normalizeAddressKey(row.addr);
    if (k) keys.add(k);
  }
  return { address, hasSingleAddress: keys.size <= 1 };
}

/**
 * Every distinct service address THIS unit's own paperwork states — directly (extractions.entity_id
 * = the unit) or via a document linked to it (document_entity_links). Grouped in JS
 * (normalizeAddressKey has no SQL equivalent — same idiom as autofill.js's groupCandidatesByValue):
 *   - zero distinct values -> {address: null, conflicting: false}
 *   - exactly one          -> {address, documentId (earliest), conflicting: false}
 *   - two or more          -> {address: null, documentId (first seen, for a needs-info anchor),
 *                              conflicting: true, candidates}
 */
export async function loadUnitDocumentStatedAddress(db, unitId) {
  const { rows } = await db.raw(
    `SELECT addr, document_id FROM (
        SELECT COALESCE(x.corrected_value, x.value) AS addr, x.document_id, x.created_at
          FROM extractions x
          JOIN document_entity_links l
            ON l.document_id = x.document_id AND l.entity_id = $1 AND ${TENANT_SQL.replace('tenant_id', 'l.tenant_id')}
         WHERE x.field_key = 'service_address' AND ${TENANT_SQL.replace('tenant_id', 'x.tenant_id')}
        UNION ALL
        SELECT COALESCE(x2.corrected_value, x2.value) AS addr, x2.document_id, x2.created_at
          FROM extractions x2
         WHERE x2.entity_id = $1 AND x2.field_key = 'service_address' AND ${TENANT_SQL.replace('tenant_id', 'x2.tenant_id')}
     ) s
     WHERE addr IS NOT NULL AND btrim(addr) <> ''
     ORDER BY created_at ASC`,
    [unitId]
  );

  const distinct = new Map();
  for (const r of rows) {
    const key = normalizeAddressKey(r.addr);
    if (!key || distinct.has(key)) continue;
    distinct.set(key, { address: r.addr, documentId: r.document_id });
  }
  const values = [...distinct.values()];
  if (values.length === 0) return { address: null, documentId: null, conflicting: false, candidates: [] };
  if (values.length > 1) return { address: null, documentId: values[0].documentId, conflicting: true, candidates: values };
  return { address: values[0].address, documentId: values[0].documentId, conflicting: false, candidates: values };
}

/* =============================================================================== DB: writes */

/**
 * Stamp `address` onto one equipment entity, with provenance — guarded again at the SQL level
 * (entity_type/merged_into/still-missing) so this is safe to call speculatively and safe to race:
 * two callers stamping the same unit at once, only the first UPDATE's WHERE clause still matches.
 * @returns {Promise<boolean>} true iff this call actually wrote the address (false: someone/something
 *   else already had, a race, or the id no longer resolves to a live equipment entity).
 */
export async function applyUnitAddressStamp(db, { unitId, address, rule, sourceDocumentId = null, customerId = null }) {
  const provenance = {
    rule,
    sourceDocumentId: sourceDocumentId ?? null,
    customerId: customerId ?? null,
    stampedAt: new Date().toISOString(),
  };
  const { rowCount } = await db.raw(
    `UPDATE entities
        SET data = data || jsonb_build_object('service_address', $2::text, 'service_address_source', $3::jsonb),
            updated_at = NOW()
      WHERE id = $1 AND ${TENANT_SQL} AND entity_type = 'equipment' AND merged_into IS NULL
        AND (data ->> 'service_address') IS NULL`,
    [unitId, address, JSON.stringify(provenance)]
  );
  return rowCount > 0;
}

let needsInfoKnown = null;
/** Same "detect once" tolerance idiom as autofill.js's own table probes (migration 43 may not be
 *  pasted yet) — kept as its own small probe rather than importing autofill.js's, to avoid a
 *  circular import (autofill.js calls into this module). */
async function needsInfoTableExists(db) {
  if (needsInfoKnown != null) return needsInfoKnown;
  try {
    const r = await db.raw("SELECT to_regclass('public.intake_needs_info') IS NOT NULL AS ok", []);
    needsInfoKnown = Boolean(r.rows[0]?.ok);
  } catch {
    return false;
  }
  return needsInfoKnown;
}
export function _resetUnitAddressTableProbeForTests() {
  needsInfoKnown = null;
}

/**
 * Raise the ONE precise question a genuine address conflict deserves — same intake_needs_info
 * table/shape autofill.js's own field conflicts use (field_key = 'service_address'), so it shows
 * up in the existing exception queue (api/_lib/intake/queue.js) rather than a second, parallel
 * mechanism. A no-op (returns false) when migration 43 hasn't been pasted yet.
 */
export async function raiseUnitAddressConflict(db, { unitId, documentId, documentAddress, customerAddress, candidates }) {
  if (!documentId) return false;
  if (!(await needsInfoTableExists(db))) return false;

  const options = candidates && candidates.length
    ? candidates.map((c) => `"${c.address}"`).join(' or ')
    : [documentAddress, customerAddress].filter(Boolean).map((a) => `"${a}"`).join(' or ');
  const question = `Which service address is correct for this unit: ${options}?`;
  const cands = candidates && candidates.length
    ? candidates.map((c) => ({ value: c.address, source: 'document' }))
    : [
        ...(documentAddress ? [{ value: documentAddress, source: 'document' }] : []),
        ...(customerAddress ? [{ value: customerAddress, source: 'customer' }] : []),
      ];

  await db.raw(
    `INSERT INTO intake_needs_info
        (tenant_id, document_id, entity_id, field_key, question, candidates, status, created_at, updated_at)
     VALUES ((current_setting('app.tenant_id'))::uuid, $1, $2, 'service_address', $3, $4::jsonb, 'open', NOW(), NOW())
     ON CONFLICT (tenant_id, document_id, field_key) DO UPDATE SET
        question = EXCLUDED.question, candidates = EXCLUDED.candidates, entity_id = EXCLUDED.entity_id,
        status = CASE WHEN intake_needs_info.status = 'open' THEN 'open' ELSE intake_needs_info.status END,
        updated_at = NOW()`,
    [documentId, unitId, question, JSON.stringify(cands)]
  );
  return true;
}

/**
 * Every LIVE equipment entity a document is directly linked to (document_entity_links, or via
 * extractions.entity_id) — never a guess at "the customer's only unit"; that ambiguity is
 * autofill.js's own EQUIPMENT_SCOPED_FIELDS concern, not this feature's. Includes each unit's own
 * existing address (so the caller can skip it without a second query) and its customer_id.
 */
export async function resolveDocumentEquipmentIds(db, documentId) {
  const { rows } = await db.raw(
    `SELECT DISTINCT e.id, e.customer_id, e.data->>'service_address' AS existing_address
       FROM entities e
      WHERE ${TENANT_SQL.replace('tenant_id', 'e.tenant_id')} AND e.entity_type = 'equipment' AND e.merged_into IS NULL
        AND (
          EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = $1 AND l.entity_id = e.id AND ${TENANT_SQL.replace('tenant_id', 'l.tenant_id')})
          OR EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = $1 AND x.entity_id = e.id AND ${TENANT_SQL.replace('tenant_id', 'x.tenant_id')})
        )`,
    [documentId]
  );
  return rows;
}
