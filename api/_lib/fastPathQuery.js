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
import {
  FIELD_BY_INTENT,
  NO_FIELD_INTENTS,
  WARRANTY_INTENTS,
  LIST_INTENTS,
  pickUnique,
  pickBestExtraction,
  pickMostRecent,
  significantAddressTokens,
  buildFieldAnswer,
  buildWarrantyAnswer,
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
 *   {kind: 'customer', customer}  |  {kind: 'equipment', equipment}
 *   {kind: 'ambiguous'}  — more than one candidate; never guessed through
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
    const tokens = significantAddressTokens(subject.address);
    if (tokens.length) {
      const patterns = tokens.map((t) => `%${t}%`);
      const { rows } = await db.raw(
        `SELECT id, entity_type, customer_id, data FROM entities
          WHERE merged_into IS NULL AND ${TENANT_SQL}
            AND entity_type IN ('customer', 'equipment')
            AND data->>'service_address' ILIKE ALL($1::text[])
          LIMIT 10`,
        [patterns]
      );
      const equipmentRows = rows.filter((r) => r.entity_type === 'equipment');
      const uniqueEquip = pickUnique(equipmentRows);
      if (uniqueEquip) return { kind: 'equipment', equipment: uniqueEquip };
      if (equipmentRows.length === 0) {
        const uniqueCust = pickUnique(rows.filter((r) => r.entity_type === 'customer'));
        if (uniqueCust) return { kind: 'customer', customer: uniqueCust };
      }
      if (rows.length > 0) return { kind: 'ambiguous' };
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
  const preferred = rows.filter((r) => r.document_type === 'work-order' || r.document_type === 'startup-sheet');
  return pickBestExtraction(preferred.length ? preferred : rows);
}

async function fetchLastServiceTech(db, resolution) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'technician');
  const preferred = rows.filter((r) => r.document_type === 'service-ticket' || r.document_type === 'work-order');
  return pickMostRecent(preferred.length ? preferred : rows);
}

async function fetchLastServiceDate(db, resolution) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'service_date');
  return pickMostRecent(rows);
}

async function fetchInvoiceTotal(db, resolution) {
  const rows = await fetchFieldRowsForResolution(db, resolution, 'cost');
  const invoiceRows = rows.filter((r) => r.document_type === 'invoice');
  return pickMostRecent(invoiceRows.length ? invoiceRows : rows);
}

async function runWarranty(db, resolution, intent, today) {
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

  return buildWarrantyAnswer({ intent, resolution: equipmentResolution, stable, today, citationRow });
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
  const { intent, subject } = fp;
  if (NO_FIELD_INTENTS.has(intent)) return null; // no extraction field exists — always defer (seer, filter_size)

  const resolution = await resolveFastPathSubject(db, subject);
  if (resolution.kind !== 'customer' && resolution.kind !== 'equipment') return null;

  if (LIST_INTENTS.has(intent)) {
    return intent === 'equipment_list'
      ? runEquipmentList(db, resolution, today)
      : runDocumentList(db, resolution);
  }

  if (WARRANTY_INTENTS.has(intent)) return runWarranty(db, resolution, intent, today);

  const fieldKey = FIELD_BY_INTENT[intent];
  if (!fieldKey) return null;

  let row;
  if (intent === 'installer') row = await fetchInstaller(db, resolution);
  else if (intent === 'last_service_tech') row = await fetchLastServiceTech(db, resolution);
  else if (intent === 'last_service_date') row = await fetchLastServiceDate(db, resolution);
  else if (intent === 'invoice_total') row = await fetchInvoiceTotal(db, resolution);
  else row = pickBestExtraction(await fetchFieldRowsForResolution(db, resolution, fieldKey));

  if (!row) return null;
  return buildFieldAnswer({ intent, resolution, row });
}
