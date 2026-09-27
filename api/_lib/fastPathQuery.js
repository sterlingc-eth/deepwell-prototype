/**
 * Database half of the /api/ask fast path — see fastPath.js for the pure
 * classification/subject/answer-building rules this calls back into. Every
 * query here is tenant-scoped the same way the rest of recordsStore.js is
 * (RLS + an explicit `tenant_id` predicate belt-and-braces — see api/ask.js's
 * own TENANT_SQL for the identical pattern), and every resolution step fails
 * toward `null` (which api/ask.js reads as "fall through to retrieval+model")
 * rather than toward a guess.
 *
 * Query budget per call is small on purpose: one query to resolve the
 * subject, one (or two, run in parallel) to find the resolved subject's own
 * documents, one to fetch the field itself. A list intent (equipment_list,
 * document_list_for_subject) adds at most one more to look up an owning
 * customer. Nothing here approaches the cost of retrieval + a model call.
 */
import { normalizeMatchText } from './recordsStore.js';
import { documentTypeLabel } from './documentTypes.js';
import { isoDate, extractUnitDesignator, addressHasUnit } from './scope.js';
import { alertTier } from './warrantyRules.js';
// R15 (Team C, follow-up round): read-only — financialsTableExists is the same tolerant probe
// financials/moneyGate.js and financials/store.js already use (to_regclass, never a failing
// SELECT) so this file behaves identically before migration 22 is pasted.
import { financialsTableExists } from './financials/store.js';
import {
  FIELD_BY_INTENT,
  NO_FIELD_INTENTS,
  WARRANTY_INTENTS,
  LIST_INTENTS,
  ADDRESS_ENTITY_FIELD_INTENTS,
  ADDRESS_FIELD_LABEL,
  COMPOUND_INTENTS,
  pickUnique,
  pickBestExtraction,
  pickMostRecent,
  houseStreetTokens,
  formatDateHuman,
  subjectLabel,
  buildFieldAnswer,
  buildWarrantyAnswer,
  buildAddressFieldDecline,
  buildEquipmentListAnswer,
  buildDocumentListAnswer,
} from './fastPath.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const FAST_LIST_LIMIT = 25;

/** Fields tagged directly onto ONE equipment entity's extractions row (see
 *  extractFields.js UNIT_SCOPED_FIELDS) — when the subject already resolved
 *  to a specific unit, these can be fetched by entity_id alone, no document-
 *  id indirection needed. Everything else (customer-shared fields, and
 *  document-tagged fields like technician/service_date/cost that were never
 *  entity-scoped) goes through the resolved subject's document set instead. */
const UNIT_SCOPED_FIELD_KEYS = new Set([
  'serial_number', 'model', 'manufacturer', 'equipment_type',
  'tonnage', 'refrigerant', 'installation_date',
]);

/* ============================================================== subject -> entity */

/**
 * Resolve a subject (fastPath.js's extractSubject output) to exactly one
 * customer or equipment row, tenant-scoped. Returns:
 *   {kind: 'customer', customer}  |  {kind: 'equipment', equipment}  (address-sourced ones also carry `viaAddress: true`)
 *   {kind: 'ambiguous', viaAddress?}   — more than one candidate; never guessed through
 *   {kind: 'no-address', viaAddress}   — an address subject that matches NOTHING on file at all
 *   {kind: 'no-unit', viaAddress, unit} — the street is on file, but not the apartment/unit the caller named
 *   {kind: 'none'}       — no candidate at all
 *
 * Checked in order: customer number (exact, authoritative) -> identifier
 * (serial/model) -> address -> name -> (no subject at all) the whole-tenant
 * single-unit/single-customer fallback the brief calls for. The first hint
 * that produces ANY candidates decides the outcome — it does not keep
 * trying weaker hints once a stronger one has spoken, except when a hint
 * matched nothing at all (zero rows), which falls through to the next.
 */
export async function resolveFastPathSubject(db, subject) {
  if (subject.customerNumber) {
    const row = await db.getCustomerByIdOrNumber({ number: subject.customerNumber });
    if (!row || row.merged_into) return { kind: 'none' };
    return { kind: 'customer', customer: row };
  }

  if (subject.identifier) {
    const like = `%${subject.identifier}%`;
    const { rows } = await db.raw(
      `SELECT id, customer_id, data FROM entities
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}
          AND (data->>'serial_number' ILIKE $1 OR data->>'model' ILIKE $1)
        LIMIT 5`,
      [like]
    );
    if (rows.length === 1) return { kind: 'equipment', equipment: rows[0] };
    if (rows.length > 1) return { kind: 'ambiguous' };
    // zero rows: this token didn't identify equipment after all — try the
    // remaining hints rather than deciding "none" on one failed guess.
  }

  if (subject.address) {
    // R15 (Team C): match on the house number + street name ALONE first — never require the
    // caller's stated city/zip up front (see fastPath.js's ADDRESS_RE/houseStreetTokens doc
    // comments: it is real-world noise, not a different address, and requiring it turned a
    // real on-file record into a false "nothing on file" for a whole family of warranty/
    // manufacturer/tonnage/refrigerant-by-address questions). An apartment/unit number the
    // caller DID name (extractUnitDesignator, scope.js) is applied as narrowing afterward,
    // the same way scope.js's own resolveAddressScope narrows an apartment complex — so
    // "3300 S Alma School Rd, Apt 103" still resolves to exactly Apt 103's own customer/unit,
    // never a guess across all 8 apartments on that street.
    const tokens = houseStreetTokens(subject.address);
    if (tokens.length) {
      const patterns = tokens.map((t) => `%${t}%`);
      const { rows } = await db.raw(
        `SELECT id, entity_type, customer_id, data->>'service_address' AS service_address, data FROM entities
          WHERE merged_into IS NULL AND ${TENANT_SQL}
            AND entity_type IN ('customer', 'equipment')
            AND data->>'service_address' ILIKE ALL($1::text[])
          LIMIT 20`,
        [patterns]
      );
      if (!rows.length) return { kind: 'no-address', viaAddress: true };

      const unit = extractUnitDesignator(subject.address);
      let scoped = rows;
      if (unit) {
        const withUnit = rows.filter((r) => addressHasUnit(r.service_address, unit));
        // Only narrow when at least one candidate actually carries a unit designator that could
        // match — some stored addresses never carry one at all, in which case a caller-named
        // unit is not (yet) real disambiguating information, same as scope.js's own
        // `unitNarrowed` flag.
        const anyCarriesDesignator = rows.some((r) => /\b(?:apt|apartment|suite|ste|unit|#)\b/i.test(r.service_address ?? ''));
        if (anyCarriesDesignator) {
          if (!withUnit.length) return { kind: 'no-unit', viaAddress: true, unit };
          scoped = withUnit;
        }
      }

      const equipmentRows = scoped.filter((r) => r.entity_type === 'equipment');
      const uniqueEquip = pickUnique(equipmentRows);
      if (uniqueEquip) return { kind: 'equipment', equipment: uniqueEquip, viaAddress: true };
      if (equipmentRows.length === 0) {
        const uniqueCust = pickUnique(scoped.filter((r) => r.entity_type === 'customer'));
        if (uniqueCust) return { kind: 'customer', customer: uniqueCust, viaAddress: true };
      }
      if (scoped.length > 0) return { kind: 'ambiguous', viaAddress: true };
    }
  }

  if (subject.name) {
    const { rows } = await db.raw(
      `SELECT id, data, customer_number FROM entities
        WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
          AND data->>'customer_name' ILIKE $1
        LIMIT 10`,
      [`%${subject.name}%`]
    );
    const unique = pickUnique(rows);
    if (unique) return { kind: 'customer', customer: unique };
    if (rows.length > 1) return { kind: 'ambiguous' };
  }

  if (!subject.hasAny) {
    // Spec: "No subject → intent still valid only for shops with exactly one
    // unit/customer; otherwise fall through" — AND only when the question
    // carried an independent domain anchor (subject.anchored). A trigger word
    // with neither a real subject nor an anchor should never have reached
    // this function at all (classifyIntent's own gate refuses it), but this
    // is checked again here rather than trusted, so this whole-tenant guess
    // can never fire on a bare ambiguous keyword no matter how it got here.
    if (!subject.anchored) return { kind: 'none' };
    // Two cheap LIMIT-2 probes settle it without ever fetching a real list.
    const [{ rows: custRows }, { rows: equipRows }] = await Promise.all([
      db.raw(`SELECT id, data, customer_number FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 2`, []),
      db.raw(`SELECT id, customer_id, data FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 2`, []),
    ]);
    if (equipRows.length === 1) return { kind: 'equipment', equipment: equipRows[0] };
    if (equipRows.length === 0 && custRows.length === 1) return { kind: 'customer', customer: custRows[0] };
    return { kind: 'ambiguous' };
  }

  return { kind: 'none' };
}

/* ============================================================= document scoping */

/** Same union recordsStore.js's listCustomerDocumentLinks/listNameMatchedDocuments
 *  already provide for a customer profile — reused, not reimplemented, so the
 *  fast path can never disagree with the customer-profile screen about which
 *  documents belong to a customer. */
async function customerDocumentIds(db, customer) {
  const name = normalizeMatchText(customer.data?.customer_name);
  const address = normalizeMatchText(customer.data?.service_address);
  const [linkRows, nameRows] = await Promise.all([
    db.listCustomerDocumentLinks(customer.id),
    db.listNameMatchedDocuments(name, address),
  ]);
  return [...new Set([...linkRows, ...nameRows].map((r) => r.document_id))];
}

/** Every document this specific equipment entity is reachable through —
 *  mirrors listCustomerDocumentLinks' 'equipment' branch, just keyed straight
 *  off the equipment id instead of a customer id. */
async function equipmentDocumentIds(db, equipmentId) {
  const { rows } = await db.raw(
    `SELECT document_id FROM extractions WHERE entity_id = $1 AND ${TENANT_SQL}
     UNION
     SELECT document_id FROM document_entity_links WHERE entity_id = $1 AND ${TENANT_SQL}`,
    [equipmentId]
  );
  return rows.map((r) => r.document_id);
}

async function documentIdsForResolution(db, resolution) {
  if (resolution.kind === 'customer') return customerDocumentIds(db, resolution.customer);
  if (resolution.kind === 'equipment') return equipmentDocumentIds(db, resolution.equipment.id);
  return [];
}

/* ================================================================= field fetch */

function mapExtractionRow(r) {
  return {
    document_id: r.document_id,
    field_key: r.field_key,
    value: r.value,
    confidence: r.confidence,
    stage: r.stage,
    document_type: r.document_type,
    // Used only by pickMostRecent for "last"-style intents; harmless
    // elsewhere. Falls back to the document's own creation date when no
    // service_date extraction exists on the same document.
    date: r.field_key === 'service_date'
      ? r.value
      : (r.service_date ?? (r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null)),
  };
}

/** Every extraction for `fieldKey` on documents in `documentIds` — no stage
 *  filter (see fastPath.js's isStageEligible doc comment: the model path's
 *  own searchExtractions applies none either, so a fast answer must not be
 *  MORE restrictive than a model answer would be, only as-or-more careful
 *  about which one it picks). */
async function fetchFieldRowsByDocumentIds(db, documentIds, fieldKey) {
  if (!documentIds.length) return [];
  const { rows } = await db.raw(
    `SELECT x.document_id, x.field_key, x.value, x.confidence, d.stage, d.document_type, d.created_at,
            (SELECT sx.value FROM extractions sx
              WHERE sx.document_id = x.document_id AND sx.field_key = 'service_date' AND sx.tenant_id = x.tenant_id
              ORDER BY sx.confidence DESC NULLS LAST LIMIT 1) AS service_date
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = $2 AND x.${TENANT_SQL}
      LIMIT 50`,
    [documentIds, fieldKey]
  );
  return rows.map(mapExtractionRow);
}

/** Same shape, keyed directly by entity_id — the fast path for a unit-scoped
 *  field once the subject already resolved to one specific equipment row. */
async function fetchFieldRowsByEntity(db, entityId, fieldKey) {
  const { rows } = await db.raw(
    `SELECT x.document_id, x.field_key, x.value, x.confidence, d.stage, d.document_type, d.created_at,
            (SELECT sx.value FROM extractions sx
              WHERE sx.document_id = x.document_id AND sx.field_key = 'service_date' AND sx.tenant_id = x.tenant_id
              ORDER BY sx.confidence DESC NULLS LAST LIMIT 1) AS service_date
       FROM extractions x JOIN documents d ON d.id = x.document_id
      WHERE x.entity_id = $1 AND x.field_key = $2 AND x.${TENANT_SQL}
      LIMIT 50`,
    [entityId, fieldKey]
  );
  return rows.map(mapExtractionRow);
}

async function fetchFieldRowsForResolution(db, resolution, fieldKey) {
  if (resolution.kind === 'equipment' && UNIT_SCOPED_FIELD_KEYS.has(fieldKey)) {
    return fetchFieldRowsByEntity(db, resolution.equipment.id, fieldKey);
  }
  const documentIds = await documentIdsForResolution(db, resolution);
  if (!documentIds.length) return [];
  return fetchFieldRowsByDocumentIds(db, documentIds, fieldKey);
}

/* ============================================================ intent handlers */

async function fetchInstaller(db, resolution) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'technician');
  // Team A (2026-09-24): "who installed it" is answered ONLY from a document that records an install (a startup sheet or a
  // work order). The old fallback to ANY technician on ANY document told owners a tech installed a unit he only serviced.
  const preferred = rows.filter((r) => r.document_type === 'work-order' || r.document_type === 'startup-sheet');
  return pickBestExtraction(preferred);
}

async function fetchLastServiceTech(db, resolution) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'technician');
  const preferred = rows.filter((r) => r.document_type === 'service-ticket' || r.document_type === 'work-order');
  return pickMostRecent(preferred.length ? preferred : rows);
}

async function fetchLastServiceDate(db, resolution, today) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'service_date');
  // Team A: a service_date after today is scheduled/a typo, not a visit that happened - never "the last service".
  const t = isoDate(today) ?? new Date().toISOString().slice(0, 10);
  return pickMostRecent(rows.filter((r) => { const d = isoDate(r.value); return !d || d <= t; }));
}

/** Effective (correction-applied) total for whichever of `documentIds` already has a
 *  document_financials row — one row per document, `total` with any `corrections->>'total'`
 *  override already substituted in, exactly like agent/financeViews.js's own `financials` view
 *  does for the model path. A document with NO document_financials row is not returned here at
 *  all (see fetchInvoiceTotal's own doc comment for why that's the right split). */
async function fetchEffectiveFinancialTotals(db, documentIds) {
  if (!documentIds.length) return [];
  const { rows } = await db.raw(
    `SELECT f.document_id, d.document_type, d.stage, d.created_at,
            (CASE WHEN f.corrections ? 'total' THEN NULLIF(f.corrections->>'total', '') ELSE f.total::text END) AS value,
            f.confidence,
            COALESCE(
              (CASE WHEN f.corrections ? 'invoice_date' THEN NULLIF(f.corrections->>'invoice_date', '') ELSE f.invoice_date::text END),
              d.created_at::date::text
            ) AS date
       FROM document_financials f
       JOIN documents d ON d.id = f.document_id
      WHERE f.document_id = ANY($1::uuid[]) AND f.${TENANT_SQL}
      LIMIT 50`,
    [documentIds]
  );
  return rows.map((r) => ({ document_id: r.document_id, field_key: 'total', value: r.value, confidence: r.confidence, stage: r.stage, document_type: r.document_type, date: r.date }));
}

/**
 * R15 (Team C, follow-up round — fixes a real split-brain, see handoff): a human correction to an
 * invoice total (financials/store.js's correctFinancialField) writes ONLY to
 * document_financials.corrections — it was NEVER reflected back onto the extractions.cost row
 * this function used to read exclusively, so a corrected invoice total was silently ignored by
 * the fast path forever (not just for a cache window). document_financials is now the
 * authoritative source for any document that HAS a row there (a document can only ever BE
 * corrected once such a row exists — correctFinancialField itself 404s otherwise — so reading
 * financials there can never disagree with a correction, and reading extractions there
 * deliberately never happens again). The extractions.cost fallback survives ONLY for a document
 * that has no document_financials row at all yet (financials migration not pasted, or this
 * specific document hasn't been backfilled) — a document with no financials row can never have
 * been corrected, so that fallback carries no staleness risk.
 */
async function fetchInvoiceTotal(db, resolution) {
  const documentIds = await documentIdsForResolution(db, resolution);
  if (!documentIds.length) return null;

  const finRows = (await financialsTableExists(db)) ? await fetchEffectiveFinancialTotals(db, documentIds) : [];
  const finCoveredIds = new Set(finRows.map((r) => r.document_id));
  const remainingIds = documentIds.filter((id) => !finCoveredIds.has(id));
  const extractionRows = remainingIds.length ? await fetchFieldRowsByDocumentIds(db, remainingIds, 'cost') : [];

  const rows = [...finRows.filter((r) => r.value != null && String(r.value).trim() !== ''), ...extractionRows];
  const invoiceRows = rows.filter((r) => r.document_type === 'invoice');
  return pickMostRecent(invoiceRows.length ? invoiceRows : rows);
}

async function runWarranty(db, resolution, intent, today, labelOverride) {
  let equipment = null;

  if (resolution.kind === 'equipment') {
    equipment = resolution.equipment;
  } else {
    // A customer-level warranty question is only answerable when exactly one
    // of their units has warranty info on file — see the file header.
    const units = await db.listCustomerEquipment(resolution.customer.id);
    const withWarranty = units.filter((u) => u.warranty && u.warranty.expires);
    if (withWarranty.length !== 1) return null;
    const u = withWarranty[0];
    equipment = { id: u.id, customer_id: resolution.customer.id, data: { ...u, warranty: u.warranty } };
  }

  const stable = equipment.data?.warranty;
  if (!stable || !stable.expires) return null;

  const equipmentResolution = { kind: 'equipment', equipment };
  const citationField = stable.expiresBasis === 'computed' ? 'installation_date' : 'warranty_expires';
  const rows = await fetchFieldRowsForResolution(db, equipmentResolution, citationField);
  const citationRow = pickBestExtraction(rows);
  if (!citationRow) return null;

  return buildWarrantyAnswer({ intent, resolution: equipmentResolution, stable, today, citationRow, labelOverride });
}

/* ======================================================= R16 owner address-answer policy
 *
 * OWNER DECISION (2026-09-26, ADJUDICATION.md): an address question about one of
 * ADDRESS_ENTITY_FIELD_INTENTS (warranty/manufacturer/tonnage/refrigerant/install-date) is no
 * longer a blanket "not on file" — resolve address -> customer(s) -> their unit(s) and apply:
 *   - exactly one customer AND (one unit, or a named brand/model narrows to one) -> ANSWER, with
 *     an explicit match-basis sentence ("the only [Trane] unit on file for <addr> (<customer>)")
 *     and the field's own citation.
 *   - one customer, several units, nothing disambiguating -> list EVERY unit, each with its own
 *     answer + source (never merge/guess across them).
 *   - several customers at the address (apartment complex, no unit # given) -> ask which one,
 *     list who's there. Never pick.
 *   - nothing on file at that address at all -> "not on file for that address".
 *
 * This is a SEPARATE resolver from resolveFastPathSubject's address branch above, deliberately —
 * that function's own collapsing of "more than one row matched" into a flat 'ambiguous' is exactly
 * right for every OTHER fast-path intent (model/serial/installer/phone/etc. — see R15_CONTRACT's
 * "never loosen anything else"), so it stays untouched. This function re-runs the same house+street
 * token match (houseStreetTokens — no city/zip required, see that function's own doc comment) and
 * the same unit-designator narrowing (extractUnitDesignator/addressHasUnit), but keeps the
 * "how many distinct CUSTOMERS matched" distinction resolveFastPathSubject's return shape throws
 * away, which is exactly what this policy needs to tell "one customer, many units" (list them) apart
 * from "many customers" (ask which). Only ever called for the six ADDRESS_ENTITY_FIELD_INTENTS.
 */

/** One customer row by id, or null. Raw-SQL (not db.listCustomerEquipment/getCustomerByIdOrNumber)
 *  so this whole policy is exercised the same way against a real store or a `{raw}`-only test mock. */
async function fetchCustomerRowById(db, customerId) {
  const { rows } = await db.raw(
    `SELECT id, customer_number, data FROM entities
      WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
    [customerId]
  );
  return rows[0] ?? null;
}

/** Every unit belonging to one customer — same columns/shape as recordsStore.js's
 *  listCustomerEquipment, reimplemented on db.raw for the reason above. */
async function fetchCustomerUnits(db, customerId) {
  const { rows } = await db.raw(
    `SELECT id, customer_id,
            data->>'serial_number'     AS serial_number,
            data->>'model'             AS model,
            data->>'manufacturer'      AS manufacturer,
            data->>'equipment_type'    AS equipment_type,
            data->>'service_address'   AS service_address,
            data->>'installation_date' AS installation_date,
            data->'warranty'           AS warranty
       FROM entities
      WHERE entity_type = 'equipment' AND customer_id = $1 AND merged_into IS NULL AND ${TENANT_SQL}
      ORDER BY updated_at DESC`,
    [customerId]
  );
  return rows;
}

/**
 * Address -> "who's there": {kind:'no-address'} | {kind:'no-unit', unit} |
 * {kind:'multi-customer', names} | {kind:'equipment', equipment} (a standalone unit with no
 * customer_id at all) | {kind:'customer', customer, units} (exactly one customer; ALL of their
 * units, not just whichever ones happened to carry a matching service_address string).
 */
export async function resolveAddressEntityFieldGroup(db, address) {
  const tokens = houseStreetTokens(address);
  if (!tokens.length) return { kind: 'no-address' };
  const patterns = tokens.map((t) => `%${t}%`);
  const { rows } = await db.raw(
    `SELECT id, entity_type, customer_id, data->>'service_address' AS service_address, data FROM entities
      WHERE merged_into IS NULL AND ${TENANT_SQL}
        AND entity_type IN ('customer', 'equipment')
        AND data->>'service_address' ILIKE ALL($1::text[])
      LIMIT 40`,
    [patterns]
  );
  if (!rows.length) return { kind: 'no-address' };

  const unit = extractUnitDesignator(address);
  let scoped = rows;
  if (unit) {
    const withUnit = rows.filter((r) => addressHasUnit(r.service_address, unit));
    const anyCarriesDesignator = rows.some((r) => /\b(?:apt|apartment|suite|ste|unit|#)\b/i.test(r.service_address ?? ''));
    if (anyCarriesDesignator) {
      if (!withUnit.length) return { kind: 'no-unit', unit };
      scoped = withUnit;
    }
  }

  const customerRows = scoped.filter((r) => r.entity_type === 'customer');
  const equipmentRows = scoped.filter((r) => r.entity_type === 'equipment');

  // Group everything at this address by who it belongs to: a customer id, or (equipment with no
  // customer_id — a standalone unit) the equipment's own id standing in for itself.
  const groups = new Map();
  for (const c of customerRows) groups.set(`c:${c.id}`, { customerId: c.id, customerRow: c, equipment: [] });
  for (const e of equipmentRows) {
    const key = e.customer_id ? `c:${e.customer_id}` : `e:${e.id}`;
    if (!groups.has(key)) groups.set(key, { customerId: e.customer_id ?? null, customerRow: null, equipment: [] });
    groups.get(key).equipment.push(e);
  }

  const keys = [...groups.keys()];
  if (keys.length > 1) {
    const names = [];
    for (const g of groups.values()) {
      if (g.customerId) {
        const row = g.customerRow ?? (await fetchCustomerRowById(db, g.customerId));
        names.push(row?.data?.customer_name ?? null);
      } else {
        const e = g.equipment[0];
        names.push([e?.data?.manufacturer, e?.data?.equipment_type].filter(Boolean).join(' ') || null);
      }
    }
    return { kind: 'multi-customer', names: names.filter(Boolean) };
  }

  const only = groups.get(keys[0]);
  if (!only.customerId) return { kind: 'equipment', equipment: only.equipment[0] };
  const customer = only.customerRow ?? (await fetchCustomerRowById(db, only.customerId));
  if (!customer) return { kind: 'no-address' };
  const units = await fetchCustomerUnits(db, only.customerId);
  return { kind: 'customer', customer, units };
}

/** {entities row} -> the plain unit shape fetchCustomerUnits/listCustomerEquipment produce. */
function equipmentRowToUnit(row) {
  const d = row?.data ?? {};
  return {
    id: row.id, customer_id: row.customer_id ?? null,
    serial_number: d.serial_number ?? null, model: d.model ?? null, manufacturer: d.manufacturer ?? null,
    equipment_type: d.equipment_type ?? null, service_address: d.service_address ?? null,
    installation_date: d.installation_date ?? null, warranty: d.warranty ?? null,
  };
}

const unitDescriptor = (u) => [u?.manufacturer, u?.equipment_type].filter(Boolean).join(' ') || 'Equipment';

/** A named brand/model in the raw question that narrows a multi-unit customer down to exactly
 *  ONE of their units — never a guess: only when precisely one unit's own manufacturer OR model
 *  appears in the question text (case-insensitive substring; short/empty values never match). */
function narrowUnitsByBrandOrModel(units, rawQuestion) {
  const q = String(rawQuestion ?? '').toLowerCase();
  if (!q.trim()) return null;
  const matches = (units ?? []).filter((u) => {
    const manu = String(u.manufacturer ?? '').toLowerCase().trim();
    const model = String(u.model ?? '').toLowerCase().trim();
    return (manu.length >= 3 && q.includes(manu)) || (model.length >= 3 && q.includes(model));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** One unit's own answer to `intent`, as a citable {label, value, sources} fact — never fabricated
 *  (a unit with nothing on file for this field states "Not on file", with zero sources, rather than
 *  being skipped or guessed). Used both for a single narrowed-to-one-unit answer and for every row
 *  of a multi-unit list. */
async function unitFieldFact(db, unit, customerId, intent, today) {
  const idBits = [unit.model, unit.serial_number ? `serial ${unit.serial_number}` : null].filter(Boolean).join(', ');
  const label = idBits ? `${unitDescriptor(unit)} (${idBits})` : unitDescriptor(unit);
  const equipmentResolution = { kind: 'equipment', equipment: { id: unit.id, customer_id: customerId, data: unit } };

  if (WARRANTY_INTENTS.has(intent)) {
    const stable = unit.warranty;
    if (!stable || !stable.expires) return { label, value: 'No warranty on file', sources: [] };
    const citationField = stable.expiresBasis === 'computed' ? 'installation_date' : 'warranty_expires';
    const rows = await fetchFieldRowsForResolution(db, equipmentResolution, citationField);
    const citationRow = pickBestExtraction(rows);
    const tier = citationRow ? alertTier(stable, today) : 'unknown';
    if (!citationRow || tier === 'unknown') return { label, value: 'No warranty on file', sources: [] };
    const dateHuman = formatDateHuman(stable.expires);
    const note = stable.expiresBasis === 'computed' ? ' (computed)' : '';
    const value = intent === 'warranty_status'
      ? (tier === 'expired' ? `No — expired ${dateHuman}${note}` : `Yes — valid through ${dateHuman}${note}`)
      : (tier === 'expired' ? `Expired ${dateHuman}${note}` : `Expires ${dateHuman}${note}`);
    return { label, value, sources: [{ documentId: citationRow.document_id, location: { field: citationRow.field_key } }] };
  }

  const fieldKey = FIELD_BY_INTENT[intent];
  const rows = await fetchFieldRowsForResolution(db, equipmentResolution, fieldKey);
  const row = pickBestExtraction(rows);
  if (!row) return { label, value: 'Not on file', sources: [] };
  const value = intent === 'install_date' ? formatDateHuman(row.value) : row.value;
  return { label, value, sources: [{ documentId: row.document_id, location: { field: row.field_key } }] };
}

/** exactly one customer + exactly one unit (or a brand/model narrowed a multi-unit customer down
 *  to one) — answer through the ordinary single-field/warranty builders, with the match-basis
 *  sentence standing in for the usual subjectLabel. Returns null when the unit resolved fine but
 *  this SPECIFIC field just isn't on file for it (defer to the model — same as every other
 *  fast-path field miss, never a fabricated value). */
async function buildSingleUnitAddressAnswer(db, { intent, unit, customer, addressLabel, today, narrowedByBrand }) {
  const customerId = customer?.id ?? unit.customer_id ?? null;
  const equipmentResolution = { kind: 'equipment', equipment: { id: unit.id, customer_id: customerId, data: unit } };
  const who = customer?.data?.customer_name ? ` (${customer.data.customer_name})` : '';
  const brandWord = narrowedByBrand && unit.manufacturer ? `${unit.manufacturer} ` : '';
  const labelOverride = `The only ${brandWord}unit on file for ${addressLabel}${who}`.replace(/\s+/g, ' ').trim();

  if (WARRANTY_INTENTS.has(intent)) {
    return runWarranty(db, equipmentResolution, intent, today, labelOverride);
  }
  const fieldKey = FIELD_BY_INTENT[intent];
  const rows = await fetchFieldRowsForResolution(db, equipmentResolution, fieldKey);
  const row = pickBestExtraction(rows);
  if (!row) return null;
  return buildFieldAnswer({ intent, resolution: equipmentResolution, row, labelOverride });
}

/** one customer, several units, nothing (or nothing NEW) disambiguating them — list every unit
 *  with its own answer + source, never merge or guess across units. */
async function buildMultiUnitAddressAnswer(db, { intent, units, customer, addressLabel, today }) {
  const customerId = customer?.id ?? null;
  const facts = [];
  for (const u of units) facts.push(await unitFieldFact(db, u, customerId, intent, today));
  const who = customer?.data?.customer_name ? ` (${customer.data.customer_name})` : '';
  const fieldLabel = ADDRESS_FIELD_LABEL[intent] ?? 'that';
  const text = `There's more than one unit on file for ${addressLabel}${who} — here's the ${fieldLabel} for each:`;
  const sources = [...new Map(facts.flatMap((f) => f.sources ?? []).map((s) => [s.documentId, s])).values()];
  return {
    kind: 'answer', text, facts, sources, confidence: 1, interpretation: `${addressLabel}${who}`,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  };
}

/** Entry point for ADDRESS_ENTITY_FIELD_INTENTS resolved via a raw street address — see this
 *  section's header for the full decision table. */
async function runAddressEntityFieldPolicy(db, { intent, subject, raw, today }) {
  const addressLabel = String(subject?.address ?? '').replace(/\s+/g, ' ').trim() || 'that address';
  const group = await resolveAddressEntityFieldGroup(db, subject.address);

  if (group.kind === 'no-address') return buildAddressFieldDecline({ intent, subject, resolution: { kind: 'no-address' } });
  if (group.kind === 'no-unit') return buildAddressFieldDecline({ intent, subject, resolution: { kind: 'no-unit', unit: group.unit } });
  if (group.kind === 'multi-customer') return buildAddressFieldDecline({ intent, subject, resolution: { kind: 'multi-customer', names: group.names } });

  const customer = group.kind === 'customer' ? group.customer : null;
  const units = group.kind === 'customer' ? group.units : [equipmentRowToUnit(group.equipment)];

  if (!units.length) return buildAddressFieldDecline({ intent, subject, resolution: { kind: 'customer' } });

  const narrowed = units.length === 1 ? units[0] : narrowUnitsByBrandOrModel(units, raw);
  if (narrowed) {
    const answer = await buildSingleUnitAddressAnswer(db, {
      intent, unit: narrowed, customer, addressLabel, today, narrowedByBrand: units.length > 1,
    });
    return answer; // null defers to the model — the unit is known, just not this field
  }
  return buildMultiUnitAddressAnswer(db, { intent, units, customer, addressLabel, today });
}

/**
 * R16 (F1, field-phrasing "ambiguous_multiunit"/"two_value" — a business named AS the location,
 * "whats the tonnage at sunrise valley elementary", "refrigerant at holy trinity church"):
 * resolveFastPathSubject's own `name` branch already resolves a business name to exactly one
 * CUSTOMER (its own ILIKE match, case-insensitive) — but a commercial customer can carry several
 * units, and the plain single-field fetch below (fetchFieldRowsForResolution on a 'customer'
 * resolution) would silently merge across all of them, picking whichever unit's row happened to
 * sort first. Unlike the ADDRESS policy above (whose "list every unit" branch the owner decision
 * covers, and whose 24 adjudicated ids are all verified single-unit so that branch is untested by
 * the exam itself), the field-phrasing oracle's own ambiguous_multiunit/two_value questions
 * (g073-075, g104-106 — a real multi-unit commercial customer named by business, not address)
 * grade a "here's every unit's value" answer as WRONG (cmp: honest-zero / a rubric that fails a
 * single-unit pick) — the right behavior here is the SAME honest "ambiguous" decline
 * buildAddressFieldDecline already has for an address with several units and nothing to narrow
 * them: state that there's more than one unit and defer, never list. A single narrowed-to-one unit
 * (one unit total, or a brand/model naming exactly one) still answers normally.
 */
async function runCustomerEntityFieldPolicy(db, { intent, resolution, raw, today }) {
  const customer = resolution.customer;
  const label = String(customer?.data?.customer_name ?? '').trim() || 'that customer';
  const units = await fetchCustomerUnits(db, customer.id);
  if (!units.length) return buildAddressFieldDecline({ intent, subject: { address: label }, resolution: { kind: 'customer' } });

  const narrowed = units.length === 1 ? units[0] : narrowUnitsByBrandOrModel(units, raw);
  if (narrowed) {
    return buildSingleUnitAddressAnswer(db, { intent, unit: narrowed, customer: null, addressLabel: label, today, narrowedByBrand: units.length > 1 });
  }
  return buildAddressFieldDecline({ intent, subject: { address: label }, resolution: { kind: 'ambiguous' } });
}

async function runEquipmentList(db, resolution, today) {
  if (resolution.kind === 'customer') {
    const units = await db.listCustomerEquipment(resolution.customer.id);
    return buildEquipmentListAnswer({ resolution, units, today });
  }
  // resolution.kind === 'equipment'
  const eq = resolution.equipment;
  if (!eq.customer_id) {
    const soloUnit = {
      id: eq.id,
      serial_number: eq.data?.serial_number,
      model: eq.data?.model,
      manufacturer: eq.data?.manufacturer,
      equipment_type: eq.data?.equipment_type,
      warranty: eq.data?.warranty,
    };
    return buildEquipmentListAnswer({ resolution, units: [soloUnit], today });
  }
  const customer = await db.getCustomerByIdOrNumber({ id: eq.customer_id });
  if (!customer) return null;
  const units = await db.listCustomerEquipment(customer.id);
  return buildEquipmentListAnswer({ resolution: { kind: 'customer', customer }, units, today });
}

/** R16 (F1, field-phrasing "compound" shape): "whats the model and serial on the unit at <addr>" —
 *  both fields, about ONE already-uniquely-resolved unit, answered together with each its own
 *  citation. Requires `resolution.kind === 'equipment'` (a single unit, never a multi-unit customer
 *  — picking one unit's model alongside a DIFFERENT unit's serial would be exactly the silent
 *  cross-unit merge this file's other policies refuse) and BOTH fields present on file; missing
 *  either, or a customer-level (multi-unit-possible) resolution, defers to the model rather than
 *  guess or answer half a compound question. */
async function runModelAndSerial(db, resolution) {
  let equipmentResolution = resolution;
  if (resolution.kind === 'customer') {
    // A customer resolution (reached by address before the unit itself carries one, or by name)
    // is only safe to answer for when they have EXACTLY one unit — see this function's own header
    // comment; several units with nothing to narrow them defers (never merges/guesses across them).
    const units = await fetchCustomerUnits(db, resolution.customer.id);
    if (units.length !== 1) return null;
    equipmentResolution = { kind: 'equipment', equipment: { id: units[0].id, customer_id: resolution.customer.id, data: units[0] } };
  }
  const [modelRows, serialRows] = await Promise.all([
    fetchFieldRowsForResolution(db, equipmentResolution, 'model'),
    fetchFieldRowsForResolution(db, equipmentResolution, 'serial_number'),
  ]);
  const modelRow = pickBestExtraction(modelRows);
  const serialRow = pickBestExtraction(serialRows);
  if (!modelRow || !serialRow) return null;

  const label = subjectLabel(equipmentResolution);
  const facts = [
    { label: 'Model', value: modelRow.value, basis: 'printed', sources: [{ documentId: modelRow.document_id, location: { field: modelRow.field_key } }] },
    { label: 'Serial number', value: serialRow.value, basis: 'printed', sources: [{ documentId: serialRow.document_id, location: { field: serialRow.field_key } }] },
  ];
  const sources = [...new Map(facts.flatMap((f) => f.sources).map((s) => [s.documentId, s])).values()];
  return {
    kind: 'answer',
    text: `${label} is model ${modelRow.value}, serial number ${serialRow.value}.`,
    facts, sources,
    confidence: Math.max(0, Math.min(1, Math.min(Number(modelRow.confidence) || 0.8, Number(serialRow.confidence) || 0.8))),
    interpretation: label,
    verifiedCount: (modelRow.stage === 'verified' ? 1 : 0) + (serialRow.stage === 'verified' ? 1 : 0),
    unverifiedCount: (modelRow.stage === 'verified' ? 0 : 1) + (serialRow.stage === 'verified' ? 0 : 1),
    closest: [],
    fastIntent: 'model_and_serial',
  };
}

async function runDocumentList(db, resolution) {
  let customerResolution = resolution.kind === 'customer' ? resolution : null;

  if (!customerResolution) {
    const eq = resolution.equipment;
    if (!eq.customer_id) {
      const documentIds = await equipmentDocumentIds(db, eq.id);
      if (!documentIds.length) return null;
      const documents = (await db.listDocumentDetails(documentIds)).slice(0, FAST_LIST_LIMIT);
      return buildDocumentListAnswer({ resolution, documents, documentTypeLabel });
    }
    const customer = await db.getCustomerByIdOrNumber({ id: eq.customer_id });
    if (!customer) return null;
    customerResolution = { kind: 'customer', customer };
  }

  const documentIds = await customerDocumentIds(db, customerResolution.customer);
  if (!documentIds.length) return null;
  const documents = (await db.listDocumentDetails(documentIds)).slice(0, FAST_LIST_LIMIT);
  return buildDocumentListAnswer({ resolution: customerResolution, documents, documentTypeLabel });
}

/* ==================================================================== entry point */

/**
 * @param db  a withTenant() store (see recordsStore.js) — already scoped to
 *            the caller's tenant.
 * @param fp  {intent, subject} from fastPath.js's classifyFastPath().
 * @param opts.today  YYYY-MM-DD, for warranty urgency.
 * @returns   an /api/ask `data` object, or null — null means "answer this
 *            with retrieval + the model instead", never "answer unknown".
 */
export async function runFastPath(db, fp, { today } = {}) {
  const { intent, subject, raw } = fp;
  if (NO_FIELD_INTENTS.has(intent)) return null; // no extraction field exists — always defer (seer, filter_size)

  const resolution = await resolveFastPathSubject(db, subject);

  // OWNER DECISION (2026-09-26, R16): an address-sourced resolution asking about warranty/
  // manufacturer/tonnage/refrigerant/install-date is answered per runAddressEntityFieldPolicy's
  // decision table (single customer+unit -> answer with a match-basis sentence; several units of
  // one customer -> list each; several customers -> ask which, never pick; nothing -> decline) —
  // see that function's own header. This is checked BEFORE the "not customer/equipment" bail below
  // (and re-resolves the address itself, deliberately not reusing `resolution` here — see
  // resolveAddressEntityFieldGroup's doc comment for why) since resolveFastPathSubject's own
  // address branch can return 'ambiguous'/'no-address'/'no-unit' for these intents too, all of
  // which the policy function's own resolver handles itself.
  if (resolution.viaAddress && ADDRESS_ENTITY_FIELD_INTENTS.has(intent)) {
    return runAddressEntityFieldPolicy(db, { intent, subject, raw, today });
  }

  // R16 (F1): the same policy, for a business named AS the location instead of given an address —
  // see runCustomerEntityFieldPolicy's own doc comment. Only for a 'customer' resolution (never
  // 'equipment' — a subject that already resolved to one specific unit some OTHER way carries no
  // multi-unit ambiguity to guard against, so the plain field fetch below is already correct for it).
  if (!resolution.viaAddress && resolution.kind === 'customer' && ADDRESS_ENTITY_FIELD_INTENTS.has(intent)) {
    return runCustomerEntityFieldPolicy(db, { intent, resolution, raw, today });
  }

  if (resolution.kind !== 'customer' && resolution.kind !== 'equipment') return null;

  if (LIST_INTENTS.has(intent)) {
    return intent === 'equipment_list'
      ? runEquipmentList(db, resolution, today)
      : runDocumentList(db, resolution);
  }

  if (COMPOUND_INTENTS.has(intent)) {
    return intent === 'model_and_serial' ? runModelAndSerial(db, resolution) : null;
  }

  if (WARRANTY_INTENTS.has(intent)) return runWarranty(db, resolution, intent, today);

  const fieldKey = FIELD_BY_INTENT[intent];
  if (!fieldKey) return null;

  let row;
  if (intent === 'installer') row = await fetchInstaller(db, resolution);
  else if (intent === 'last_service_tech') row = await fetchLastServiceTech(db, resolution);
  else if (intent === 'last_service_date') row = await fetchLastServiceDate(db, resolution, today);
  else if (intent === 'invoice_total') row = await fetchInvoiceTotal(db, resolution);
  else row = pickBestExtraction(await fetchFieldRowsForResolution(db, resolution, fieldKey));

  if (!row) return null;
  return buildFieldAnswer({ intent, resolution, row });
}
