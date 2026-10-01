/**
 * R33 (2026-09-30): repair documents ALREADY ingested with a dropped/missed field — $0, no model, no re-upload.
 *
 * Sonoran Comfort Air's service tickets print "Date of Service: 10/19/2028"; before R33 the validator dropped that
 * date (beyond service_date's 18-month window) and the Inbox said "Missing information — Service date". The ingest
 * path is fixed (extractFields.js keeps the date, extractDocument.js label-fills gaps), but every document ingested
 * before the fix still has the gap in `extractions`. The pipeline never stored the dropped value itself (audit_log
 * only ever recorded a COUNT of dropped fields, and the raw model output is not persisted), so the only faithful
 * source left is what the page says: `document_pages.text`. This module re-reads it.
 *
 *   recheckDocument(ctx, documentId)  one document — the Inbox's "Re-check this document" (and "Verify with AI"
 *                                     runs it first when a required field is missing)
 *   recheckTenantMissing(ctx, opts)   a bounded batch of one tenant's documents with missing required fields — the
 *                                     nightly cron sweep and the Inbox's "Re-check all missing fields"
 *
 * What a re-check does, per document (modelAvoidance/labelFill.js decides WHAT; this file only writes it):
 *   - fills a field ONLY if it is absent (canonical or unconfirmed) — never overwrites an extraction or a correction;
 *   - writes facet + extraction exactly like an extraction would, under facets.segment_id = 'field-recheck'
 *     (provenance `method: 'recheck'`; swept by the next full re-extraction like any extractor row);
 *   - a far-future date lands as `<key>_unconfirmed` (flagged, shown as "check the year", ignored downstream);
 *   - re-derives the unit's warranty when a canonical install date was restored (fill-only entity merge);
 *   - AI-verifies the document when it is now complete and linked (same rule as ingest);
 *   - logs `document.fields_rechecked` {method:'recheck', recheck_version, filled, ambiguous, ...}.
 * Idempotent: a second run finds the field present and writes nothing (and the SQL insert is itself guarded by NOT
 * EXISTS, so two concurrent runs cannot double-write). Tenant-scoped through withTenant + RLS like every store call.
 */
import { withTenant, FIELD_RECHECK_SEGMENT } from "./recordsStore.js";
import { planLabelFill, LABEL_FILL_VERSION } from "./modelAvoidance/labelFill.js";
import { completenessFor, toCompletenessFields, normalizeDocumentType, AI_VERIFY_MIN_CONFIDENCE } from "./documentTypes.js";
import { deriveWarranty } from "./warrantyRules.js";
import { packForTenant } from "./industry/index.js";

export const RECHECK_VERSION = LABEL_FILL_VERSION;
export const RECHECK_ACTION = "document.fields_rechecked";
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const REPEATABLE = new Set(["work_performed", "part_number"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One document, inside an already-open tenant transaction (`db` = recordsStore's makeStore). */
export async function recheckDocumentTx(db, documentId, { actorClerkId = null, source = "admin", today } = {}) {
  // R34: the NOT EXISTS guard on the insert below is a snapshot read, so under READ COMMITTED two concurrent re-checks of the
  // SAME document (the nightly sweep, an admin's "Re-check all", and a person's click can overlap) each saw "absent" and BOTH
  // inserted - a duplicate extraction row. A per-document transaction-scoped advisory lock makes the second one wait, then see
  // the first's rows and write nothing.
  await db.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`recheck:${documentId}`]);
  const doc = await db.getDocument(documentId);
  if (!doc) return { documentId, status: "not-found", filled: [] };
  if (doc.stage === "verified") return { documentId, status: "already-verified", filled: [] };
  const pack = await packForTenant(db).catch(() => null);
  if (pack && pack.id && pack.id !== "hvac") return { documentId, status: "pack-not-supported", filled: [] };

  const [pages, rows] = await Promise.all([db.listPages(documentId), db.listExtractionsByDocument(documentId)]);
  const type = normalizeDocumentType(doc.document_type);
  const fieldsBefore = toCompletenessFields(rows);
  const before = completenessFor(type, fieldsBefore);
  const highestPage = pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
  const plan = planLabelFill({
    type, fields: rows.map((r) => ({ field_key: r.field_key, value: r.value, corrected_value: r.corrected_value, confidence: Number(r.confidence ?? 0) })),
    pages: pages.map((p) => ({ page_no: p.page_no, text: p.text ?? "" })), today, method: "recheck", pageCount: highestPage,
  });

  const entityId = rows.find((r) => r.entity_id)?.entity_id ?? null;
  const written = [];
  for (const f of plan.add) {
    const guard = REPEATABLE.has(f.field_key)
      ? "x.field_key = $5::text AND x.value = $4::text"
      : "x.field_key = $5::text";
    const r = await db.raw(
      `WITH ins AS (
         INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence,
                             mapped_field_key, mapping_method, created_at)
         SELECT (current_setting('app.tenant_id', true))::uuid, $1::uuid, $2::int, $3::text, COALESCE($6::text, $5::text), $4::text, $7::numeric, $5::text, 'registry', NOW()
          WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = $1::uuid AND x.${TENANT} AND ${guard})
         RETURNING id
       )
       INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, created_at)
       SELECT (current_setting('app.tenant_id', true))::uuid, $1::uuid, $8::uuid, $5::text, $4::text, $7::numeric, ins.id, NOW() FROM ins
       RETURNING id`,
      [documentId, f.page_no ?? null, FIELD_RECHECK_SEGMENT, f.value, f.field_key, f.verbatim ?? null, f.confidence, entityId]
    );
    if (r.rowCount > 0) written.push({ field_key: f.field_key, value: f.value, page_no: f.page_no ?? null, method: "recheck", ...(f.flags ? { flags: f.flags } : {}) });
  }

  const fieldsAfter = [...fieldsBefore, ...written.map((w) => ({ field_key: w.field_key, value: w.value, confidence: plan.add.find((a) => a.field_key === w.field_key)?.confidence ?? 0.9 }))];
  const after = completenessFor(type, fieldsAfter);

  // A restored canonical install date is what the warranty clock runs on: same fill-only merge + derive as ingest.
  let warrantyRederived = false;
  if (written.some((w) => w.field_key === "installation_date")) {
    const facts = Object.fromEntries(fieldsAfter.map((f) => [f.field_key, f.value]));
    if (facts.serial_number) {
      const entity = await db.findOrCreateEquipment(facts);
      if (entity?.id) {
        await db.setEquipmentWarranty(entity.id, deriveWarranty({ ...facts, ...(entity.data ?? {}) }, null, pack));
        warrantyRederived = true;
      }
    }
  }

  let aiVerified = false;
  if (written.length && after.complete && after.minConfidence >= AI_VERIFY_MIN_CONFIDENCE) {
    aiVerified = (await db.verifyByAi(documentId)) > 0;
  }

  await db.logAction({
    action: RECHECK_ACTION,
    resource_type: "document",
    resource_id: documentId,
    clerk_user_id: actorClerkId,
    changes: {
      method: "recheck",
      recheck_version: RECHECK_VERSION,
      source,
      filled: written,
      ambiguous: plan.ambiguous.slice(0, 10),
      completeness_missing_before: before.missing,
      completeness_missing: after.missing,
      unconfirmed: after.unconfirmed ?? [],
      warranty_rederived: warrantyRederived,
      ai_verified: aiVerified,
    },
  });

  return {
    documentId,
    status: written.length ? "filled" : "nothing-to-fill",
    filled: written,
    ambiguous: plan.ambiguous,
    missingBefore: before.missing,
    completeness: after,
    aiVerified,
  };
}

/** The Inbox's "Re-check this document". Never calls a model. */
export async function recheckDocument(ctx, documentId, opts = {}) {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    const err = new Error("documentId must be a uuid");
    err.status = 400;
    throw err;
  }
  return withTenant(ctx, (db) => recheckDocumentTx(db, documentId, opts));
}

/**
 * One tenant's documents with a missing required field, re-checked in a bounded batch, newest first. Skips documents
 * a re-check of this RECHECK_VERSION already looked at (so the nightly sweep does not re-scan the same unfixable
 * documents forever, and a version bump re-scans everything once). `documentIds` restricts the batch (the Inbox's
 * bulk action sends the documents it is showing).
 * @returns {Promise<{scanned:number, candidates:number, rechecked:number, filled:number, fields:number, verified:number, leftForNextRun:number}>}
 */
export async function recheckTenantMissing(ctx, { limit = 40, today, deadlineAt = Infinity, actorClerkId = null, source = "cron", documentIds = null, force = false } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 40));
  const ids = Array.isArray(documentIds) ? documentIds.filter((x) => typeof x === "string" && UUID_RE.test(x)).slice(0, 500) : null;
  const candidates = await withTenant(ctx, async (db) => {
    // The label dictionary is HVAC vocabulary: another industry pack's tenant is skipped whole (nothing written, so
    // nothing to re-scan tomorrow either).
    const pack = await packForTenant(db).catch(() => null);
    if (pack && pack.id && pack.id !== "hvac") return [];
    // A document qualifies when a REQUIRED field is missing, or when its page prints an install / registration date
    // label and the extraction has no such date at all (the warranty clock's inputs — the same drop, one field over).
    const { rows: docs } = await db.raw(
      `SELECT d.id, d.document_type,
              EXISTS (SELECT 1 FROM document_pages p2 WHERE p2.document_id = d.id AND p2.${TENANT}
                        AND p2.text ~* '(install(ed|ation)?[[:space:]]*(date|dt|on)|date[[:space:]]+installed|registered|registration[[:space:]]+date)') AS has_warranty_date_label
         FROM documents d
        WHERE d.${TENANT} AND d.stage IN ('read', 'mapped', 'linked') AND d.document_type IS NOT NULL
          ${ids ? "AND d.id = ANY($3::uuid[])" : ""}
          AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.${TENANT} AND COALESCE(p.text, '') <> '')
          AND ($2::boolean OR NOT EXISTS (
                SELECT 1 FROM audit_log a
                 WHERE a.resource_id = d.id AND a.${TENANT} AND a.action = '${RECHECK_ACTION}'
                   AND COALESCE((a.changes->>'recheck_version')::int, 0) >= $1))
        ORDER BY d.created_at DESC
        LIMIT 500`,
      ids ? [RECHECK_VERSION, !!force, ids] : [RECHECK_VERSION, !!force]
    );
    if (!docs.length) return [];
    const ex = await db.listExtractionsByDocuments(docs.map((d) => d.id));
    const byDoc = new Map();
    for (const e of ex) { if (!byDoc.has(e.document_id)) byDoc.set(e.document_id, []); byDoc.get(e.document_id).push(e); }
    return docs.filter((d) => {
      const fields = toCompletenessFields(byDoc.get(d.id) ?? []);
      if (completenessFor(normalizeDocumentType(d.document_type), fields).missing.length > 0) return true;
      if (!d.has_warranty_date_label) return false;
      const keys = new Set(fields.filter((f) => f.value != null && String(f.value).trim() !== '').map((f) => String(f.field_key).replace(/_unconfirmed$/, '')));
      return !keys.has('installation_date') || !keys.has('warranty_registered_date');
    });
  });

  const summary = { scanned: 0, candidates: candidates.length, rechecked: 0, filled: 0, fields: 0, verified: 0, leftForNextRun: 0, errors: 0 };
  for (const d of candidates.slice(0, cap)) {
    if (Date.now() >= deadlineAt) { summary.leftForNextRun++; continue; }
    summary.scanned++;
    try {
      const r = await withTenant(ctx, (db) => recheckDocumentTx(db, d.id, { actorClerkId, source, today }));
      summary.rechecked++;
      if (r.filled.length) { summary.filled++; summary.fields += r.filled.length; }
      if (r.aiVerified) summary.verified++;
    } catch (err) {
      summary.errors++;
      console.error(`recheck: ${d.id} failed: ${err?.message}`);
    }
  }
  summary.leftForNextRun += Math.max(0, candidates.length - cap);
  return summary;
}
