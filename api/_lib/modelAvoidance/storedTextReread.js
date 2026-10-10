/**
 * "Never silently accept an empty extraction" (F1, 2026-10-10).
 *
 * 161 of 390 unverified documents in the live export had ZERO extracted fields and no error: extractDocument.js treated "the
 * model returned nothing" as a valid answer. This module is the second look, and it is shared by ingest and by repair:
 *
 *   planStoredTextRead()      pure: what the label scan can read from the page text of a document that has no fields
 *   reextractFromStoredText() $0, no model: re-read ONE stored document from `document_pages.text` (F2's re-sort calls this
 *                             after it retypes a document). Fills what is missing, raises confidence where the page
 *                             corroborates a value already stored, and, when the page is readable but still yields nothing,
 *                             records the machine-readable "nothing read" marker.
 *
 * THE MARKER (existing storage, no DDL): an `audit_log` row  action = 'document.nothing_read',  resource_type = 'document',
 * resource_id = <document id>,  changes = { reason: 'no_fields_after_text_scan', chars, pages, type, source }.  The same
 * `nothing_read: true` flag is also written into the `document.fields_extracted` row of the ingest that produced the empty
 * result. A reader finds unread documents with  SELECT resource_id FROM audit_log WHERE action = 'document.nothing_read'
 * (newest row per document wins; a later `document.fields_rechecked` / `document.fields_extracted` without the flag clears it).
 */
import { withTenant, FIELD_RECHECK_SEGMENT } from "../recordsStore.js";
import { packForTenant } from "../industry/index.js";
import { planLabelFill, corroborateFields } from "./labelFill.js";
import { classifyFromText } from "./textExtract.js";
import { loadOwnNames, applyOwnCompanyGuard } from "./ownCompany.js";
import {
  completenessFor, toCompletenessFields, normalizeDocumentType, mayVerifyWithoutLink, AI_VERIFY_MIN_CONFIDENCE,
  isLegacyOrUnknownType, inferTypeFromFilename, isSyntheticKey,
} from "../documentTypes.js";

export const NOTHING_READ_ACTION = "document.nothing_read";
/** Synthetic extraction row (like '_audience'): the marker as the client entity graph sees it (src/core/entityGraph.ts
 *  NOTHING_READ_MARKER). No facet, so a re-extract never sweeps it; removed by clearNothingReadMarker when fields are found.
 *  Every completeness / auto-check path ignores '_' keys (documentTypes.js isSyntheticKey). */
export const NOTHING_READ_FIELD_KEY = "_nothing_read";

/** Idempotent: one marker row per document. `db` = recordsStore's makeStore, inside an open tenant transaction. */
export async function setNothingReadMarker(db, documentId) {
  await db.raw(`DELETE FROM extractions WHERE document_id = $1::uuid AND ${TENANT} AND field_key = $2::text`, [documentId, NOTHING_READ_FIELD_KEY]);
  await db.raw(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1::uuid, $2::text, 'true', 1, NOW())`,
    [documentId, NOTHING_READ_FIELD_KEY]
  );
}
export async function clearNothingReadMarker(db, documentId) {
  await db.raw(`DELETE FROM extractions WHERE document_id = $1::uuid AND ${TENANT} AND field_key = $2::text`, [documentId, NOTHING_READ_FIELD_KEY]);
}
export const REREAD_ACTION = "document.fields_reread";
export const REREAD_VERSION = 1;
const MIN_READABLE_CHARS = 20;
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-whitespace characters of page text. A page below MIN_READABLE_CHARS is "nothing to read", not "read and empty". */
export function readableChars(pages) {
  return (pages ?? []).reduce((n, p) => n + String(p?.text ?? "").replace(/\s+/g, "").length, 0);
}
export const isReadable = (pages) => readableChars(pages) >= MIN_READABLE_CHARS;

/** Best guess of a document's type for a read: an explicit type, a decided stored type, the page's title, the file name. */
export function guessType({ documentType = null, storedType = null, pages = [], filename = "" }) {
  if (documentType) return documentType;
  if (storedType && !isLegacyOrUnknownType(storedType) && storedType !== "other") return storedType;
  try { const t = classifyFromText(pages)?.type; if (t) return t; } catch { /* fall through */ }
  try { return inferTypeFromFilename(filename) || null; } catch { return null; }
}

/**
 * Pure. Everything the labelled scan can read from the page text of a document that has no fields at all.
 * @returns {{type: string|null, add: object[], ambiguous: object[], readable: boolean, chars: number}}
 */
export function planStoredTextRead({ documentType, storedType, filename, pages, ownNames = [], pack = null, pageCount, today }) {
  const type = guessType({ documentType, storedType, pages, filename });
  const chars = readableChars(pages);
  if (chars < MIN_READABLE_CHARS) return { type, add: [], ambiguous: [], readable: false, chars };
  const plan = planLabelFill({
    type, fields: [], pages, method: "text-reread", pageCount, today, ownNames, allKeys: true,
    pack: pack && pack.id !== "hvac" ? pack : null,
  });
  const { fields } = applyOwnCompanyGuard(plan.add, ownNames);
  return { type, add: fields, ambiguous: plan.ambiguous, readable: true, chars };
}

/**
 * Re-read one stored document from its page text. $0, no model, idempotent (every insert is guarded by NOT EXISTS).
 * Never overwrites an extraction or a human correction; a verified document is left alone.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {string} documentId
 * @param {{actorClerkId?: string|null, source?: string, today?: string}} [opts]
 * @returns {Promise<{documentId: string, status: 'not-found'|'already-verified'|'filled'|'raised'|'nothing-read'|'nothing-to-fill'|'unreadable',
 *   filled: object[], corroborated: object[], nothingRead: boolean, aiVerified: boolean, type: string|null}>}
 */
export async function reextractFromStoredText(ctx, documentId, { actorClerkId = null, source = "admin", today } = {}) {
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    const err = new Error("documentId must be a uuid");
    err.status = 400;
    throw err;
  }
  return withTenant(ctx, async (db) => {
    await db.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`recheck:${documentId}`]);
    const doc = await db.getDocument(documentId);
    const base = { documentId, filled: [], corroborated: [], nothingRead: false, aiVerified: false, type: null };
    if (!doc) return { ...base, status: "not-found" };
    if (doc.stage === "verified") return { ...base, status: "already-verified" };

    const [pack, pages, rows, ownNames] = await Promise.all([
      packForTenant(db).catch(() => null),
      db.listPages(documentId),
      db.listExtractionsByDocument(documentId),
      loadOwnNames(db, ctx),
    ]);
    const pagesIn = pages.map((p) => ({ page_no: p.page_no, text: p.text ?? "" }));
    const highestPage = pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
    const live = rows.filter((r) => !isSyntheticKey(r.field_key) && (r.corrected_value ?? r.value) != null && String(r.corrected_value ?? r.value).trim() !== "");
    const asFields = (list) => list.map((r) => ({ field_key: r.field_key, value: r.value, corrected_value: r.corrected_value, confidence: Number(r.confidence ?? 0) }));
    const type = guessType({ storedType: doc.document_type, pages: pagesIn, filename: doc.original_filename });
    const docType = normalizeDocumentType(type, {}, pack);

    if (!isReadable(pagesIn)) return { ...base, type: docType, status: "unreadable" };

    // 1) fill: a document with no fields gets everything the scan can read; one with fields gets only its missing required ones.
    const plan = live.length === 0
      ? (() => { const r = planStoredTextRead({ documentType: null, storedType: doc.document_type, filename: doc.original_filename, pages: pagesIn, ownNames, pack, pageCount: highestPage, today }); return { add: r.add, ambiguous: r.ambiguous }; })()
      : (() => {
        const p = planLabelFill({ type: docType, fields: asFields(live), pages: pagesIn, method: "reread", pageCount: highestPage, today, ownNames, pack: pack && pack.id !== "hvac" ? pack : null });
        return { add: applyOwnCompanyGuard(p.add, ownNames).fields, ambiguous: p.ambiguous };
      })();

    const entityId = rows.find((r) => r.entity_id)?.entity_id ?? null;
    const filled = [];
    for (const f of plan.add) {
      const repeatable = f.field_key === "work_performed" || f.field_key === "part_number";
      const guard = repeatable ? "x.field_key = $5::text AND x.value = $4::text" : "x.field_key = $5::text";
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
      if (r.rowCount > 0) filled.push({ field_key: f.field_key, value: f.value, page_no: f.page_no ?? null, method: "reread", confidence: f.confidence, ...(f.flags ? { flags: f.flags } : {}) });
    }

    // 2) corroboration: a stored model value the page prints identically becomes >= 0.9 (extractions only; never a corrected row).
    const co = corroborateFields({ type: docType, fields: asFields(live), pages: pagesIn, ownNames });
    const corroborated = [];
    for (const c of co.corroborated) {
      const r = await db.raw(
        `UPDATE extractions SET confidence = $3::numeric WHERE document_id = $1::uuid AND ${TENANT} AND field_key = $2::text
            AND corrected_value IS NULL AND confidence < $3::numeric`,
        [documentId, c.field_key, c.to]
      );
      if (r.rowCount > 0) corroborated.push(c);
    }

    const after = [...asFields(live).map((f) => {
      const hit = corroborated.find((c) => c.field_key === f.field_key);
      return hit ? { ...f, confidence: hit.to, corroborated: true } : f;
    }), ...filled.map((f) => ({ field_key: f.field_key, value: f.value, confidence: f.confidence }))];

    // 3) still nothing from a readable page: say so, in a form a program can find.
    const nothingRead = after.length === 0;
    if (!nothingRead) await clearNothingReadMarker(db, documentId);
    if (nothingRead) {
      await setNothingReadMarker(db, documentId);
      await db.logAction({
        action: NOTHING_READ_ACTION, resource_type: "document", resource_id: documentId, clerk_user_id: actorClerkId,
        changes: { reason: "no_fields_after_text_scan", chars: readableChars(pagesIn), pages: pagesIn.length, type: docType, source, reread_version: REREAD_VERSION },
      });
    }

    // 4) verify when the document is now complete at the bar and linked (same rule as ingest); an untyped document is never auto-verified off a re-read.
    let aiVerified = false;
    const completeness = completenessFor(docType, toCompletenessFields(after.map((f) => ({ field_key: f.field_key, value: f.value, confidence: f.confidence }))));
    if ((filled.length || corroborated.length) && docType !== "other" && completeness.complete && completeness.minConfidence >= AI_VERIFY_MIN_CONFIDENCE) {
      aiVerified = (await db.verifyByAi(documentId, { allowUnlinked: mayVerifyWithoutLink(docType, after, { hasText: true, filename: doc.original_filename }) })) > 0;
    }

    if (filled.length || corroborated.length) {
      await db.logAction({
        action: REREAD_ACTION, resource_type: "document", resource_id: documentId, clerk_user_id: actorClerkId,
        changes: {
          method: "reread", reread_version: REREAD_VERSION, source, filled,
          corroborated, ambiguous: plan.ambiguous.slice(0, 10), completeness_missing: completeness.missing, ai_verified: aiVerified,
        },
      });
    }
    const status = nothingRead ? "nothing-read" : filled.length ? "filled" : corroborated.length ? "raised" : "nothing-to-fill";
    return { documentId, status, filled, corroborated, nothingRead, aiVerified, type: docType };
  });
}
