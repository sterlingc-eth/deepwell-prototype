import { handleCors, handleError } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";

/**
 * POST /api/document-status
 * body: { documentIds: string[] }
 * -> { documents: [{ id, stage, page_count, extracted_at, extract_error, fields }] }
 *
 * What the browser polls once ingestion is queued. Before the queue existed the
 * upload request itself was the progress bar; now the work outlives the request
 * that started it, so there has to be something to ask.
 *
 * POST rather than GET with a query string: a batch of forty ids does not fit
 * comfortably in a URL, and this is a read either way.
 */
export const config = { api: { bodyParser: { sizeLimit: "32kb" } } };

const MAX_IDS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const { documentIds } = req.body ?? {};
  if (!Array.isArray(documentIds) || !documentIds.length) {
    return res.status(400).json({ error: "documentIds is required" });
  }
  if (documentIds.length > MAX_IDS) {
    return res.status(400).json({ error: "Too many ids in one request" });
  }
  // Filter to well-formed uuids before they reach Postgres: a malformed one
  // makes the ::uuid cast raise and turns a status poll into a 500.
  const ids = documentIds.filter((id) => typeof id === "string" && UUID.test(id));
  if (!ids.length) return handleCors(res, req).status(200).json({ documents: [] });

  try {
    const documents = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      (db) => db.getIngestStatus(ids)
    );
    return handleCors(res, req).status(200).json({ documents });
  } catch (error) {
    return handleError(res, error, req);
  }
}
