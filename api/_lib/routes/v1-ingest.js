import { handleCors } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit, refundPlanRefusal } from "../rateLimit.js";
import { createUploadUrl, respondUploadError, checkUploadGate } from "../../upload-url.js";

/**
 * POST /api/v1-ingest
 * body: { filename, sha256, sizeBytes, contentType? }   (sizeBytes is REQUIRED - R35 owner decision)
 * -> { documentId, uploadUrl, then: '/api/read-document' }
 *
 * `sizeBytes` is the file's exact size in bytes. It is signed into the upload URL as the Content-Length R2 will accept
 * (a PUT of any other size is refused), so send the same number you PUT. A missing or invalid value is a 400 with a
 * plain message, never a silently unsized upload.
 *
 * The clean public surface for ingestion — same idea as v1-equipment.js and
 * v1-warranty.js, but POST, because a file upload URL is not something a
 * query string can carry. This is /api/upload-url in every respect that
 * matters (same validation, same idempotent-by-sha256 document creation,
 * same presigned PUT url — reused via createUploadUrl(), not
 * reimplemented) with a response shaped for an external caller: `then`
 * spells out that /api/read-document is the next call once the PUT
 * completes, which /api/upload-url's own response leaves implicit because
 * the app's own client already knows its own pipeline.
 *
 * Requires the 'ingest' scope and is rate-limited on the 'ingest' bucket,
 * exactly like /api/upload-url.
 */
export const config = { api: { bodyParser: { sizeLimit: "16kb" } } };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "ingest");
  } catch (err) {
    return denyAuth(res, err);
  }

  if (!(await limit(req, res, auth, "ingest"))) return; // 429 already written

  // Same billing gate api/upload-url.js's own handler runs before its
  // createUploadUrl() call — this route calls createUploadUrl() directly and
  // was missing it entirely (Reviewer NO-GO, 2026-09-21). Fails OPEN, same as
  // upload-url.js: a billing lookup error here must never turn into a hard
  // failure for an already-paying partner integration.
  const gate = await checkUploadGate(auth);
  if (!gate.allowed) {
    if (gate.status === 402) await refundPlanRefusal(req); // a plan refusal does not spend the rate-limit unit (bounded, see rateLimit.js)
    return handleCors(res, req).status(gate.status).json({ error: gate.error, url: gate.url });
  }

  try {
    const { documentId, uploadUrl, alreadyUploaded } = await createUploadUrl(auth, req.body);
    return handleCors(res, req).status(200).json({
      documentId,
      uploadUrl,
      alreadyUploaded,
      then: "/api/read-document",
    });
  } catch (error) {
    // omitCode: this route has never put the import "code" in its 402 body; the in-transaction recheck keeps it that way.
    return await respondUploadError(res, req, error, { omitCode: true });
  }
}
