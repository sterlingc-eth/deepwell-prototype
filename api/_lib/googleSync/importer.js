/**
 * Hands one file to DeepWell's ONE ingestion pipeline. There is no second pipeline: a synced file gets exactly what a manual
 * upload gets, in the same order:
 *
 *   1. the upload allow-list      checkUploadFile()   (api/_lib/uploadTypes.js: type, size cap per kind, no scripts/archives)
 *   2. the plan gate              assertUploadRoomInTx()   (api/upload-url.js: pages / documents the plan allows)
 *   3. a document row             db.createDocument()  stage 'received', keyed by sha256, so identical bytes are ONE document
 *      whose bytes sit in R2 at objectKey(tenant, sha256)   (api/_lib/r2.js)
 *   4. reading + extraction       enqueueDocument() when the Inngest queue is on; otherwise the existing sweep
 *      (api/_lib/routes/cron-sweep.js) finds the 'received' row and runs ingestDocument / extractDocumentFields on it.
 *
 * Document types, the privacy rules (HR papers are private) and Donovan indexing all happen in steps 4+ on the stored row, as
 * for any upload, so nothing is decided here. In particular this file never sets document_type, audience or a folder.
 */
import { createHash } from "node:crypto";
import { checkUploadFile } from "../uploadTypes.js";
import { objectKey, presign, sanitizeUploadFilename, R2Error } from "../r2.js";
import { documentBySha } from "./store.js";

export const SYNC_UPLOADER = "google-sync";

/** Default deps, loaded lazily so a deployment with the flag OFF never imports any of this. */
export async function defaultImportDeps() {
  const upload = await import("../../upload-url.js");
  const queue = await import("../queue.js");
  return {
    putObject: defaultPutObject,
    loadBillingRow: (auth) => upload.loadBillingRowForRecheck(auth),
    assertRoom: (db, billingRow) => upload.assertUploadRoomInTx(db, billingRow),
    enqueue: async (ctx, documentId) => {
      if (queue.isQueueEnabled()) {
        await queue.enqueueDocument({ documentId, tenantKey: ctx.tenantKey, tenantName: ctx.tenantName, userId: SYNC_UPLOADER, autoExtract: true });
        return "queued";
      }
      return "swept"; // the existing sweep picks up 'received' documents
    },
  };
}

export async function defaultPutObject(key, bytes, contentType, fetchImpl = fetch) {
  const url = presign("PUT", key, 300, {}, new Date(), { contentLength: bytes.length });
  const r = await fetchImpl(url, { method: "PUT", body: bytes, headers: contentType ? { "Content-Type": contentType } : {}, signal: AbortSignal.timeout(30_000) });
  await r.body?.cancel?.().catch?.(() => {});
  if (!r.ok) throw new R2Error(`R2 PUT failed: ${r.status}`, r.status);
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Plain-language reason a file was not brought in, never an internal detail. */
export function refusalNote(verdict) {
  return String(verdict?.message ?? "Not a supported file type").slice(0, 300);
}

/**
 * Pre-flight on name/type/size only (no bytes yet): lets the sync skip a download it would refuse anyway.
 * @returns {{ok: true, filename: string, contentType: string} | {ok: false, note: string}}
 */
export function precheck({ filename, contentType, sizeBytes }) {
  const clean = sanitizeUploadFilename(filename);
  if (!clean) return { ok: false, note: "The file has no usable name." };
  const v = checkUploadFile({ filename: clean, contentType, sizeBytes: sizeBytes > 0 ? sizeBytes : undefined });
  if (!v.ok) return { ok: false, note: refusalNote(v) };
  return { ok: true, filename: clean, contentType: v.contentType };
}

/**
 * Store the bytes and create (or find) the document row. Runs inside the caller's tenant transaction `db`.
 * @returns {Promise<{outcome: 'created'|'duplicate'|'refused', documentId?: string, sha256?: string, filename?: string, note?: string}>}
 * @throws UploadGateRefusal when the plan has no room (the caller stops the pass)
 */
export async function importBytes(db, deps, { filename, contentType, bytes, billingRow, source = null, externalId = null }) {
  if (!bytes?.length) return { outcome: "refused", note: "The file is empty." };
  const pre = precheck({ filename, contentType, sizeBytes: bytes.length });
  if (!pre.ok) return { outcome: "refused", note: pre.note };
  const sha = sha256Hex(bytes);

  // Identical bytes are already a document (manual upload, an earlier sync, another folder): no second copy, no second read.
  const existing = await documentBySha(db, sha);
  if (existing) return { outcome: "duplicate", documentId: existing.id, sha256: sha, filename: pre.filename };

  if (billingRow !== undefined) await deps.assertRoom(db, billingRow);

  const key = objectKey(db.tenantId, sha, pre.filename);
  // Bytes first, row second: a failed upload leaves nothing behind, instead of a row that points at a missing object.
  await deps.putObject(key, bytes, pre.contentType);
  const doc = await db.createDocument({
    original_filename: pre.filename,
    sha256_hash: sha,
    file_size_bytes: bytes.length,
    content_type: pre.contentType,
    storage_key: key,
    uploaded_by: SYNC_UPLOADER,
  });
  await db.logAction({
    action: "document.synced_from_google",
    resource_type: "document",
    resource_id: doc.id,
    clerk_user_id: null,
    // source tag: where this document came from. For Drive: source=google_drive and the Drive file id (also kept in google_sync_items.external_id).
    changes: { filename: pre.filename, sizeBytes: bytes.length, ...(source ? { source } : {}), ...(source === "google_drive" && externalId ? { driveFileId: externalId } : {}) },
  });
  return { outcome: "created", documentId: doc.id, sha256: sha, filename: pre.filename };
}
