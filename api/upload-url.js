import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { presign, objectKey } from "./_lib/r2.js";
import { handleCors, handleError } from "./_lib/claude.js";

/**
 * POST /api/upload-url
 * body: { filename, sha256, contentType?, sizeBytes? }
 * -> { documentId, storageKey, uploadUrl, alreadyUploaded }
 *
 * Step one of ingestion, and the point where the two stores meet: this creates
 * the Postgres row (the fact that a document exists, who owns it, where its
 * bytes will live) and hands back a short-lived URL the browser PUTs the bytes
 * to directly. Compute never touches the file.
 *
 * The client sends the file's sha256. That makes uploads idempotent — the same
 * file dropped twice is one document, thanks to the (tenant_id, sha256_hash)
 * unique constraint — and it is the hook for "you already have this invoice",
 * which is a real HVAC office problem: the same PO arrives by email, by fax,
 * and in a folder from the installer.
 */
export const config = { api: { bodyParser: { sizeLimit: "16kb" } } };

const MAX_BYTES = 100 * 1024 * 1024;

// What the reader will actually accept for a PDF or a photo. Checked HERE, not
// only at read time: the old arrangement presigned anything up to 100 MB, the
// browser uploaded all of it over whatever connection a technician has in a
// crawlspace, and read-document then refused it with a 413. The bytes were
// already spent. A file too big to read should be refused before it moves.
const MAX_MODEL_BYTES = 24 * 1024 * 1024;
const MODEL_READ_TYPES = /^(application\/pdf|image\/(jpeg|png|gif|webp))$/;

/**
 * Thrown when presign() can't produce an upload URL (R2 env vars unset, e.g.
 * every Preview/Development deploy today). Kept distinct from other errors so
 * the handler can report it as a legible 503 instead of a generic 500, and so
 * it can be recognized before the transaction that created the document row
 * commits — see the comment at the presign() call below.
 */
class StorageUnavailableError extends Error {
  constructor(cause) {
    super("File storage is not configured");
    this.name = "StorageUnavailableError";
    this.cause = cause;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  try {
    const { filename, sha256, contentType, sizeBytes } = req.body ?? {};
    if (typeof filename !== "string" || !filename.trim()) {
      return res.status(400).json({ error: "filename is required" });
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      return res.status(400).json({ error: "sha256 must be a 64-character hex digest" });
    }
    if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0)) {
      return res.status(400).json({ error: "sizeBytes must be a positive number" });
    }
    if (sizeBytes != null && sizeBytes > MAX_BYTES) {
      return res.status(413).json({ error: "File is larger than 100 MB" });
    }
    if (
      sizeBytes != null &&
      sizeBytes > MAX_MODEL_BYTES &&
      typeof contentType === "string" &&
      MODEL_READ_TYPES.test(contentType)
    ) {
      return res.status(413).json({
        error:
          "PDFs and photos have to be under 24 MB to be read. Split this into " +
          "smaller files, or scan at a lower resolution, and upload again.",
      });
    }

    const result = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      async (db) => {
        const key = objectKey(db.tenantId, sha256, filename);
        const doc = await db.createDocument({
          original_filename: filename,
          sha256_hash: sha256,
          file_size_bytes: sizeBytes ?? null,
          content_type: contentType ?? null,
          storage_key: key,
        });
        // Was this row already here (same tenant, same bytes)? If the document
        // already has pages, the client can skip the upload entirely.
        const pages = await db.listPages(doc.id);
        const alreadyUploaded = pages.length > 0;

        // presign() must run BEFORE this transaction commits, not after. It used
        // to be called outside withTenant, once the documents row above was
        // already committed — so a misconfigured R2 (presign() throws when
        // R2_ACCOUNT_ID etc. are unset, true for every Preview/Development
        // deploy today) left behind a permanent orphan row: stage='received',
        // no error recorded, indistinguishable from an upload in progress,
        // never cleaned up. Calling it here means a throw happens inside the
        // transaction, so withTenant's catch/ROLLBACK undoes the createDocument
        // insert along with it — no row, no orphan.
        let uploadUrl = null;
        if (!alreadyUploaded) {
          try {
            uploadUrl = presign("PUT", key, 900);
          } catch (err) {
            throw new StorageUnavailableError(err);
          }
        }

        await db.logAction({
          action: "document.upload_requested",
          resource_type: "document",
          resource_id: doc.id,
          clerk_user_id: auth.userId,
          changes: { filename, sizeBytes: sizeBytes ?? null },
        });
        return { documentId: doc.id, storageKey: key, alreadyUploaded, uploadUrl };
      }
    );

    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    if (error?.name === "StorageUnavailableError") {
      // Legible and specific, not the generic 500 handleError would give: a
      // technician reading this knows it's an environment problem, not a bad
      // upload, and support knows to check R2 credentials, not the database.
      console.error("upload-url: R2 is not configured:", error.cause?.message ?? error.cause);
      return handleCors(res, req).status(503).json({
        error: "File storage is not configured for this environment. Uploads are unavailable until an administrator sets the R2 credentials.",
      });
    }
    return handleError(res, error, req);
  }
}
