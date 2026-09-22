import { handleCors, handleError } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { normalizeDocumentType, completenessFor, toCompletenessFields } from "./_lib/documentTypes.js";
import { startTimer } from "./_lib/timing.js";
import { logStage } from "./_lib/perf.js";

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

  // API_PERF_2026-09-22 (DW_TIMING=1 only): one JSON line per request. This
  // route has no rate limit or billing gate of its own (a status poll is
  // read-only against documents the tenant already owns) — its two real
  // costs are auth and the withTenant transaction, both timed below.
  const timer = startTimer();
  let statusSent = 0;
  let idCount = 0;
  try {
    let auth;
    try {
      auth = await timer.time("auth", () => requireAuth(req));
    } catch (err) {
      statusSent = err?.status ?? 401;
      return denyAuth(res, err);
    }

    const { documentIds } = req.body ?? {};
    if (!Array.isArray(documentIds) || !documentIds.length) {
      statusSent = 400;
      return res.status(400).json({ error: "documentIds is required" });
    }
    if (documentIds.length > MAX_IDS) {
      statusSent = 400;
      return res.status(400).json({ error: "Too many ids in one request" });
    }
    // Filter to well-formed uuids before they reach Postgres: a malformed one
    // makes the ::uuid cast raise and turns a status poll into a 500.
    const ids = documentIds.filter((id) => typeof id === "string" && UUID.test(id));
    idCount = ids.length;
    if (!ids.length) {
      statusSent = 200;
      return handleCors(res, req).status(200).json({ documents: [] });
    }

    const documents = await timer.time("handler", () =>
      withTenant(
        { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
        async (db) => {
          const rows = await db.getIngestStatus(ids);
          // One extra query for the whole batch, not one per document — same
          // shape as recordsStore.js's listExtractionsByDocuments, for the same
          // reason (this is polled repeatedly while ingestion runs).
          const extractions = await db.listExtractionsByDocuments(rows.map((d) => d.id));
          const byDoc = new Map();
          for (const e of extractions) {
            if (!byDoc.has(e.document_id)) byDoc.set(e.document_id, []);
            byDoc.get(e.document_id).push(e);
          }
          return rows.map((d) => {
            const type = normalizeDocumentType(d.document_type);
            // `d` (from getIngestStatus) never carried a `fields` column, only a
            // count — so the spread below never produced one either, and the
            // browser's default of [] made every document look field-less even
            // with extractions on file. toCompletenessFields already applies
            // corrected_value; reuse it for both completeness and the response.
            const docFields = toCompletenessFields(byDoc.get(d.id) ?? []);
            const completeness = completenessFor(type, docFields);
            return { ...d, document_type: type, completeness, fields: docFields };
          });
        }
      )
    );
    statusSent = 200;
    return handleCors(res, req).status(200).json({ documents });
  } catch (error) {
    statusSent = error?.status ?? 500;
    return handleError(res, error, req);
  } finally {
    logStage({ t: "request", route: "document-status", idCount, status: statusSent, ...timer.snapshot() });
  }
}
