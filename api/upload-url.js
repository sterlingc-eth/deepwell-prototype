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
    if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes > MAX_BYTES)) {
      return res.status(413).json({ error: "File is larger than 100 MB" });
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
        await db.logAction({
          action: "document.upload_requested",
          resource_type: "document",
          resource_id: doc.id,
          clerk_user_id: auth.userId,
          changes: { filename, sizeBytes: sizeBytes ?? null },
        });
        return { documentId: doc.id, storageKey: key, alreadyUploaded: pages.length > 0 };
      }
    );

    return handleCors(res, req).status(200).json({
      ...result,
      uploadUrl: result.alreadyUploaded ? null : presign("PUT", result.storageKey, 900),
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
