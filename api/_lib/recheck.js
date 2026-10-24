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
import { completenessFor, toCompletenessFields, normalizeDocumentType, autoCheckDecision } from "./documentTypes.js";
import { deriveWarranty } from "./warrantyRules.js";
import { packForTenant } from "./industry/index.js";
import { loadOwnNames } from "./modelAvoidance/ownCompany.js";
import { clearNothingReadMarker } from "./modelAvoidance/storedTextReread.js";
import { retypeDecision } from "./modelAvoidance/retype.js";
import { auditDocumentTx, auditEnabled } from "./storedAuditStore.js";
import { COMPANY_FOLDER_FIELD_KEY, HR_FOLDER_ID } from "./companyFiles.js";

/** Docread round: the audit action Sort already writes for a re-type; Re-check writes the same one (source 'recheck'), so every
 *  move is listed with its from / to and can be put back. */
export const RETYPE_ACTION = "review.document_resorted";

export const RECHECK_VERSION = LABEL_FILL_VERSION;
export const RECHECK_ACTION = "document.fields_rechecked";
const RECHECK_EXTRACTION_CHUNK = 200; // ids per extraction lookup (stays under its 500-id / 8000-row caps)
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const REPEATABLE = new Set(["work_performed", "part_number"]);
/** True when the document already has a customer or unit link (the same test verifyByAi applies in SQL). */
const HAS_LINK_SQL = `(EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.entity_id IS NOT NULL)
                    OR EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id))`;
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
  let type = normalizeDocumentType(doc.document_type);
  // Docread round: re-judge the TYPE from the page first (a COI or licence stored as "Warranty registration" before the inbox
  // round). Never a type a person chose (any review.document_classified row for this paper), never an HR-filed paper.
  let retyped = null;
  try {
    // Verify round: a failed audit-log read counts as "a person may have chosen this type" (safe side: no re-type).
    const classified = await db.getAuditLog({ action: "review.document_classified", resource_type: "document", resource_id: documentId }).catch(() => null);
    const hrOverride = rows.some((r) => r.field_key === COMPANY_FOLDER_FIELD_KEY && r.value === HR_FOLDER_ID);
    const decision = retypeDecision({
      currentType: type, filename: doc.original_filename ?? null, humanChosen: classified === null || classified.length > 0, hrOverride,
      pages: pages.map((p) => ({ page_no: p.page_no, text: p.text ?? "" })),
      fields: rows.map((r) => ({ field_key: r.field_key, value: r.value, corrected_value: r.corrected_value })),
    });
    if (decision) {
      await db.updateDocument(documentId, { document_type: decision.to });
      await db.logAction({
        clerk_user_id: actorClerkId, action: RETYPE_ACTION, resource_type: "document", resource_id: documentId,
        changes: { from: decision.from, to: decision.to, source: `recheck:${decision.source}`, evidence: String(decision.evidence ?? "").slice(0, 200), model_calls: 0, had_fields: rows.length > 0 },
      });
      retyped = decision;
      type = decision.to;
    }
  } catch (err) {
    console.error(`recheck: retype skipped for ${documentId}: ${err?.message}`);
  }
  const filenameOpt = { filename: doc.original_filename ?? null };
  const fieldsBefore = toCompletenessFields(rows);
  const before = completenessFor(type, fieldsBefore, null, filenameOpt);
  const highestPage = pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
  const ownNames = await loadOwnNames(db, {}).catch(() => []);
  const plan = planLabelFill({
    ownNames,
    type, fields: rows.map((r) => ({ field_key: r.field_key, value: r.value, corrected_value: r.corrected_value, confidence: Number(r.confidence ?? 0) })),
    pages: pages.map((p) => ({ page_no: p.page_no, text: p.text ?? "" })), today, method: "recheck", pageCount: highestPage,
    filename: doc.original_filename ?? null,
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

  if (written.length) await clearNothingReadMarker(db, documentId);
  const fieldsAfter = [...fieldsBefore, ...written.map((w) => ({ field_key: w.field_key, value: w.value, confidence: plan.add.find((a) => a.field_key === w.field_key)?.confidence ?? 0.9 }))];
  const after = completenessFor(type, fieldsAfter, null, filenameOpt);

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

  // Automatic check under today's rules (documentTypes.js autoCheckDecision), whether or not this run filled anything:
  // a complete document that an older rule left unchecked is judged again here.
  let aiVerified = false;
  let checkReason = null;
  {
    const hasText = pages.some((p) => String(p.text ?? '').trim() !== '');
    const link = await db.raw(`SELECT ${HAS_LINK_SQL} AS linked, d.original_filename AS filename FROM documents d WHERE d.id = $1::uuid`, [documentId]);
    const pageText = pages.map((p) => String(p.text ?? "")).join("\n").slice(0, 20000);
    const verdict = autoCheckDecision(type, fieldsAfter, { hasText, hasLink: !!link.rows?.[0]?.linked, filename: link.rows?.[0]?.filename ?? null, text: pageText });
    checkReason = verdict.reason;
    if (verdict.ok) aiVerified = (await db.verifyByAi(documentId, { allowUnlinked: verdict.allowUnlinked })) > 0;
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
      retyped: retyped ? { from: retyped.from, to: retyped.to, source: retyped.source } : null,
      ungrounded: (plan.ungrounded ?? []).slice(0, 10),
      completeness_missing: after.missing,
      unconfirmed: after.unconfirmed ?? [],
      warranty_rederived: warrantyRederived,
      ai_verified: aiVerified,
      ai_check_reason: checkReason,
    },
  });

  // Docread2: Re-check is insert-only, so a wrong value an older reader stored stays. Judge the STORED values with the same new
  // cross-checks (read-only: never overwrites; flags are written, and shown, only when the owner switch STORED_FACT_FLAGS=1 is on).
  let suspect = [];
  // It runs inside a SAVEPOINT: a database error in the audit rolls back to the savepoint only, so it can never undo the fill above.
  if (auditEnabled()) {
    let sp = false;
    try {
      await db.raw("SAVEPOINT stored_audit", []);
      sp = true;
      const a = await auditDocumentTx(db, documentId, { commit: true, actorClerkId, source: `recheck:${source}` });
      suspect = a.flags.map((f) => ({ field_key: f.field_key, value: f.value, rule: f.rule, reason: f.reason, quote: f.quote, page: f.page }));
      await db.raw("RELEASE SAVEPOINT stored_audit", []);
    } catch (err) {
      console.error(`recheck: stored-value audit skipped for ${documentId}: ${err?.message}`);
      suspect = [];
      if (sp) { try { await db.raw("ROLLBACK TO SAVEPOINT stored_audit", []); } catch { /* the fill is already written; nothing more to do */ } }
    }
  }

  return {
    documentId,
    suspect,
    status: written.length ? "filled" : retyped ? "retyped" : "nothing-to-fill",
    retyped,
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
  const cap = Math.max(1, Math.min(500, Number(limit) || 40));
  const ids = Array.isArray(documentIds) ? documentIds.filter((x) => typeof x === "string" && UUID_RE.test(x)).slice(0, 500) : null;
  const candidates = await withTenant(ctx, async (db) => {
    // The label dictionary is HVAC vocabulary: another industry pack's tenant is skipped whole (nothing written, so
    // nothing to re-scan tomorrow either).
    const pack = await packForTenant(db).catch(() => null);
    if (pack && pack.id && pack.id !== "hvac") return [];
    // A document qualifies when a REQUIRED field is missing, when its page prints an install / registration date
    // label and the extraction has no such date at all (the warranty clock's inputs), or when it is complete and
    // would be checked automatically under today's rules but is not yet (an older, stricter rule left it open).
    const { rows: docs } = await db.raw(
      `SELECT d.id, d.document_type, d.stage, d.original_filename,
              ${HAS_LINK_SQL} AS has_link,
              EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.${TENANT} AND COALESCE(p.text, '') <> '') AS has_text,
              EXISTS (SELECT 1 FROM document_pages p2 WHERE p2.document_id = d.id AND p2.${TENANT}
                        AND p2.text ~* '(install(ed|ation)?[[:space:]]*(date|dt|on)|date[[:space:]]+installed|registered|registration[[:space:]]+date)') AS has_warranty_date_label,
              EXISTS (SELECT 1 FROM audit_log a
                       WHERE a.resource_id = d.id AND a.${TENANT} AND a.action = '${RECHECK_ACTION}'
                         AND COALESCE((a.changes->>'recheck_version')::int, 0) >= $1) AS already_rechecked
         FROM documents d
        WHERE d.${TENANT} AND d.stage IN ('read', 'mapped', 'linked') AND d.document_type IS NOT NULL
          ${ids ? "AND d.id = ANY($2::uuid[])" : ""}
        ORDER BY d.created_at DESC
        LIMIT 3000`,
      // 2026-10-22 fix: every bound parameter MUST appear in the SQL. `force` used to be sent as an unreferenced $2
      // (ids as $3); Postgres/Neon cannot type an unused parameter and rejects the whole query (42P18 "could not
      // determine data type of parameter $2"), so the Inbox's "Re-check all missing fields" and the nightly sweep's
      // re-check both failed. `force` is applied in JS below, never in SQL.
      ids ? [RECHECK_VERSION, ids] : [RECHECK_VERSION]
    );
    if (!docs.length) return [];
    // listExtractionsByDocuments caps at 500 ids / 8000 rows; a large account (~1,200+ documents) would otherwise
    // see every document past the cap as "missing everything". Fetch in chunks.
    const ex = [];
    for (let i = 0; i < docs.length; i += RECHECK_EXTRACTION_CHUNK) {
      ex.push(...(await db.listExtractionsByDocuments(docs.slice(i, i + RECHECK_EXTRACTION_CHUNK).map((d) => d.id))));
    }
    const byDoc = new Map();
    for (const e of ex) { if (!byDoc.has(e.document_id)) byDoc.set(e.document_id, []); byDoc.get(e.document_id).push(e); }
    return docs.filter((d) => {
      const fields = toCompletenessFields(byDoc.get(d.id) ?? []);
      const type = normalizeDocumentType(d.document_type);
      const c = completenessFor(type, fields, null, { filename: d.original_filename });
      // Would the automatic check pass today? Always worth a pass (it writes nothing but the verified stamp).
      if (autoCheckDecision(type, fields, { hasText: d.has_text, hasLink: d.has_link, filename: d.original_filename }).ok) return true;
      if (!force && d.already_rechecked) return false;
      if (!d.has_text) return false;
      if (c.missing.length > 0) return true;
      if (!d.has_warranty_date_label) return false;
      const keys = new Set(fields.filter((f) => f.value != null && String(f.value).trim() !== '').map((f) => String(f.field_key).replace(/_unconfirmed$/, '')));
      return !keys.has('installation_date') || !keys.has('warranty_registered_date');
    });
  });

  const summary = { scanned: 0, candidates: candidates.length, rechecked: 0, filled: 0, fields: 0, retyped: 0, verified: 0, leftForNextRun: 0, errors: 0 };
  for (const d of candidates.slice(0, cap)) {
    if (Date.now() >= deadlineAt) { summary.leftForNextRun++; continue; }
    summary.scanned++;
    try {
      const r = await withTenant(ctx, (db) => recheckDocumentTx(db, d.id, { actorClerkId, source, today }));
      summary.rechecked++;
      if (r.filled.length) { summary.filled++; summary.fields += r.filled.length; }
      if (r.retyped) summary.retyped++;
      if (r.aiVerified) summary.verified++;
    } catch (err) {
      summary.errors++;
      console.error(`recheck: ${d.id} failed: ${err?.message}`);
    }
  }
  summary.leftForNextRun += Math.max(0, candidates.length - cap);
  return summary;
}
