/**
 * DB-facing half of audience classification (round 18, part 2, owner ask (a)) — column detection
 * (with the extractions fallback M3-config/57 needs before it's pasted), the customer-identity
 * match check that feeds classify.js's Rule 1, entity-link skip/undo for internal documents, and
 * the intake-time orchestrator that ties classify.js + notify.js + the intake exception queue
 * together into one call.
 *
 * Every exported function here takes a plain `db` with a `.query(sql, params)` (a raw pg client,
 * or `{query: (sql,p) => store.raw(sql,p)}` the way ../intake/queue.js already adapts recordsStore
 * for documentsHaveDisplayName) — same "no import of a specific driver shape" contract as
 * recordsStore.js's own documentsHaveUpdatedAt/documentsHaveDisplayName probes, which this file's
 * own probes below are deliberately styled to match byte-for-byte (same memoize-per-warm-instance,
 * same _reset export for tests).
 *
 * INTEGRATION HOOK (not this engineer's file to edit — see the final report): call
 * `classifyDocumentAudience(...)` once, right after a document's document_type + extracted fields
 * are persisted (api/_lib/extractDocument.js's intake pipeline). Every function here is directly
 * callable/testable without that hook existing yet (scripts/verify-audience.mjs constructs its own
 * PGlite fixtures and calls classifyDocumentAudience itself), which is exactly the point of the
 * H-round "export a function, describe the hook" pattern this contract reuses.
 */
import { TENANT_SQL } from '../scope.js';
import { classifyAudience } from './classify.js';
import { documentsHaveAudience, documentsHaveAssignedTech, _resetAudienceProbesForTests } from './probe.js';
import { audienceFilterSql, AUDIENCE_FALLBACK_FIELD_KEY, AUDIENCE_NOTIFIED_FIELD_KEY } from './sql.js';
import { notifyForInternalDocument } from './notify.js';
import { raiseAudienceQuestion, resolveAudienceQuestion } from '../intake/audienceQuestions.js';

export { documentsHaveAudience, documentsHaveAssignedTech, _resetAudienceProbesForTests };

/**
 * Reads a document's current audience. Column when M3-config/57 is pasted, else the newest
 * `_audience` extractions row, defaulting to 'customer' when neither says otherwise (a document
 * nobody has ever classified is, by definition, an ordinary customer document — the same "never
 * hide by omission" default classify.js itself returns).
 * @returns {Promise<'customer'|'internal'>}
 */
export async function getDocumentAudience(db, documentId) {
  if (await documentsHaveAudience(db)) {
    const r = await db.query(`SELECT audience FROM documents WHERE id = $1 AND ${TENANT_SQL}`, [documentId]);
    return r.rows?.[0]?.audience === 'internal' ? 'internal' : 'customer';
  }
  const r = await db.query(
    `SELECT value FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT_SQL}
      ORDER BY created_at DESC LIMIT 1`,
    [documentId, AUDIENCE_FALLBACK_FIELD_KEY]
  );
  return r.rows?.[0]?.value === 'internal' ? 'internal' : 'customer';
}

/**
 * Writes a document's audience (and, when the columns exist, who it's assigned to) — column when
 * available, else the extractions fallback (delete-then-insert: this file has no unique
 * constraint to upsert against pre-migration, and a rewrite is exactly what a one-tap override
 * needs — the newest row always wins per getDocumentAudience's own ORDER BY).
 */
export async function setDocumentAudience(db, documentId, audience, { assignedMemberId = null, assignedTechName = null } = {}) {
  const value = audience === 'internal' ? 'internal' : 'customer';
  if (await documentsHaveAudience(db)) {
    if (await documentsHaveAssignedTech(db)) {
      await db.query(
        `UPDATE documents SET audience = $1, assigned_member = $2, assigned_tech_name = $3 WHERE id = $4 AND ${TENANT_SQL}`,
        [value, assignedMemberId, assignedTechName, documentId]
      );
    } else {
      await db.query(`UPDATE documents SET audience = $1 WHERE id = $2 AND ${TENANT_SQL}`, [value, documentId]);
    }
    return;
  }
  await db.query(`DELETE FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT_SQL}`, [documentId, AUDIENCE_FALLBACK_FIELD_KEY]);
  await db.query(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 1, NOW())`,
    [documentId, AUDIENCE_FALLBACK_FIELD_KEY, value]
  );
}

/**
 * Internal docs never link to customer entities (owner ask (a), item 2) — removes every
 * document_entity_links row for this document. This is also what keeps an internal document out
 * of every entity-scoped customer answer path for free: api/_lib/search/knowledge.js's
 * documentIdsForEntities, api/_lib/docLookup.js and api/_lib/contactLookup.js all resolve a
 * customer's documents THROUGH this join table, so a document with no rows here simply never
 * surfaces for a customer/unit-scoped question, no matter which engine asks.
 */
export async function undoCustomerEntityLinks(db, documentId) {
  await db.query(`DELETE FROM document_entity_links WHERE document_id = $1 AND ${TENANT_SQL}`, [documentId]);
}

/**
 * Does this document's own extracted customer_name/service_address/phone match a REAL customer
 * entity this tenant already has on file? The one signal classify.js's Rule 1 treats as decisive
 * ("a service ticket at a customer address stays customer"). Deliberately loose (ILIKE, trimmed,
 * case-insensitive) — a false NEGATIVE here just means classify.js falls through to its text
 * signals (still safe, since the default is 'customer'); a false positive would wrongly keep a
 * genuinely internal document customer-facing, so this only matches on a real, non-empty field
 * value, never a bare substring of the whole document text.
 *
 * Bounded (LIMIT) the same way documentIdsForDocTypes-style full-tenant scans already are
 * elsewhere in this codebase — a shop's customer roster is not paginated by this feature.
 */
export async function documentMatchesKnownCustomer(db, fields = {}) {
  const name = String(fields?.customer_name ?? '').trim();
  const address = String(fields?.service_address ?? '').trim();
  const phone = String(fields?.phone ?? '').trim();
  if (!name && !address && !phone) return false;

  const clauses = [];
  const params = [];
  if (name) { params.push(name); clauses.push(`data->>'customer_name' ILIKE $${params.length}`); }
  if (address) { params.push(address); clauses.push(`data->>'service_address' ILIKE $${params.length}`); }
  if (phone) { params.push(phone); clauses.push(`data->>'phone' ILIKE $${params.length}`); }

  const r = await db.query(
    `SELECT 1 FROM entities
      WHERE entity_type IN ('customer', 'property') AND merged_into IS NULL AND ${TENANT_SQL}
        AND (${clauses.join(' OR ')})
      LIMIT 1`,
    params
  );
  return r.rowCount > 0;
}

/**
 * The whole intake-time flow for one document: classify, persist, and — only on the branches that
 * need it — undo customer entity links, raise the "Is this for the team only?" intake question,
 * and notify the technician(s) addressed (or the admins, when nobody on the roster matched).
 * Idempotent: re-running for the same document just re-classifies and re-writes (a one-tap
 * override calls setDocumentAudience/undoCustomerEntityLinks directly instead — see
 * overrideDocumentAudience below — so this orchestrator's own notify step is the only thing that
 * needs its own dedupe, handled inside notify.js).
 *
 * @param {object} db
 * @param {string} documentId
 * @param {{documentType?: string, text?: string, fields?: object, orgId?: string|null}} doc
 * @returns {Promise<{audience: 'customer'|'internal', needsQuestion: boolean, matchedTechNames: string[]}>}
 */
export async function classifyDocumentAudience(db, documentId, { documentType = null, text = '', fields = {}, orgId = null } = {}) {
  const customerIdentifierMatch = await documentMatchesKnownCustomer(db, fields);
  const result = classifyAudience({ documentType, text, fields, customerIdentifierMatch });

  let assignedMemberId = null;
  let assignedTechName = null;
  if (result.audience === 'internal' && result.matchedTechNames.length) {
    const resolved = await notifyForInternalDocument(db, documentId, { techNames: result.matchedTechNames, orgId });
    assignedMemberId = resolved.assignedMemberId;
    assignedTechName = resolved.assignedTechName;
  } else if (result.audience === 'internal') {
    await notifyForInternalDocument(db, documentId, { techNames: [], orgId });
  }

  await setDocumentAudience(db, documentId, result.audience, { assignedMemberId, assignedTechName });
  if (result.audience === 'internal') await undoCustomerEntityLinks(db, documentId);
  if (result.needsQuestion) await raiseAudienceQuestion(db, documentId, { question: result.question });

  return { audience: result.audience, needsQuestion: result.needsQuestion, matchedTechNames: result.matchedTechNames };
}

/**
 * One-tap override — "anywhere a doc is shown" (see ../route.js's `op: 'override'`, the HTTP
 * surface for this). Any signed-in member may flip a document between 'customer' and 'internal',
 * same bar as api/_lib/naming/assign.js's own `rename` op (a person correcting what they can
 * already see is not an admin action). Also resolves any open "Is this for the team only?"
 * question for this document (a person tapping the override answered it themselves — the
 * exception queue shouldn't keep asking) and keeps entity linking consistent with the new value.
 */
export async function overrideDocumentAudience(db, documentId, audience, { resolvedBy = null } = {}) {
  const value = audience === 'internal' ? 'internal' : 'customer';
  await setDocumentAudience(db, documentId, value);
  if (value === 'internal') {
    await undoCustomerEntityLinks(db, documentId);
    await notifyForInternalDocument(db, documentId, { techNames: [], orgId: null });
  }
  await resolveAudienceQuestion(db, documentId, { resolvedValue: value, resolvedBy });
  return { audience: value };
}

export { audienceFilterSql, AUDIENCE_FALLBACK_FIELD_KEY, AUDIENCE_NOTIFIED_FIELD_KEY };
