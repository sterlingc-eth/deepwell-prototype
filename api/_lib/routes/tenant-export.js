import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";
import { streamTenantExport, parseExportResume, EXPORT_TIME_BUDGET_MS } from "../opsStore.js";
import { captureException } from "../telemetry.js";

/**
 * POST /api/tenant-export      body (optional): { resume: { key, after } }
 *
 * The export half of the promise the marketing page makes: "export your data." Streams everything the
 * tenant's own documents, pages, extractions, entities, links, facets, financials and audit log hold as one
 * downloadable JSON file (storage_key excluded — see opsStore.exportTenant), paging through every table, so a
 * 20,000-document shop gets all of it rather than the first 5,000 rows per table.
 *
 * The file's `manifest.originals` lists every stored original (document id, filename, sha256, size); the
 * original files themselves are NOT embedded — fetch each on demand with a short-lived signed link
 * (POST /api/upload-url { mode: "get", documentId }). Follow-up (not built): an async job that zips originals
 * into R2 and emails a signed link.
 *
 * Time budget: streams for at most EXPORT_TIME_BUDGET_MS; if a huge tenant hits it the file ends cleanly with
 * `truncated: true` and an `incomplete` resume point, and POSTing `{ resume: <incomplete> }` continues from
 * that row. Never silently short.
 *
 * ADMIN-GATED: inside a shop only the admin role may export the whole corpus;
 * a solo tenant (no org, no roles) is its own admin and may always export.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "16kb" } },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
    // A shop's data is the owner's to export, wipe or hand out keys for —
    // not any technician's. Solo tenants have no roles and are their own admin.
    if (hasShop(auth)) requireRole(auth, "admin");
  } catch (err) {
    return denyAuth(res, err);
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  // Body is optional (the app POSTs none): only a well-formed `resume` is honoured.
  const resume = parseExportResume(req.body?.resume);
  if (req.body?.resume && !resume) {
    return handleCors(res, req).status(400).json({ error: "Invalid resume token." });
  }

  try {
    const deadlineAt = Date.now() + EXPORT_TIME_BUDGET_MS;

    // Headers are held back until the first 256 KB (or the end) so a failure BEFORE any real data is still a
    // clean JSON error response, not a "successful" download of an error stub. After that it streams straight
    // through with backpressure — a very large export is never buffered whole in the function's memory.
    let started = false;
    let held = [];
    let heldSize = 0;
    const start = () => {
      started = true;
      const cors = handleCors(res, req);
      cors.setHeader("Content-Type", "application/json; charset=utf-8");
      cors.setHeader("Content-Disposition", `attachment; filename="deepwell-export-${auth.tenantId}.json"`);
      cors.setHeader("Cache-Control", "no-store");
      cors.status(200);
    };
    const write = async (chunk) => {
      let out = chunk;
      if (!started) {
        held.push(chunk);
        heldSize += chunk.length;
        if (heldSize < 256 * 1024) return;
        start();
        out = held.join("");
        held = [];
      }
      if (res.destroyed || res.writableEnded) throw new Error("export client disconnected");
      if (!res.write(out) && typeof res.once === "function") {
        if (res.destroyed) throw new Error("export client disconnected");
        await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
      }
    };

    const summary = await streamTenantExport(ctx, write, { resume, shouldStop: () => Date.now() > deadlineAt });
    if (!started) { start(); res.write(held.join("")); }
    res.end();

    if (!summary.ok) await captureException(new Error(summary.error), { route: "/api/tenant-export", tenantId: auth.tenantId });

    // Best-effort: a customer who asked for their own export must not be
    // denied it because the audit write failed.
    await withTenant(ctx, (db) =>
      db.logAction({
        action: "tenant.exported",
        resource_type: "tenant",
        clerk_user_id: auth.userId,
        changes: { documents: summary.counts?.documents ?? 0, truncated: summary.truncated, resumed: Boolean(resume) },
      })
    ).catch((err) => console.error("Failed to write tenant.exported audit row:", err?.message));
  } catch (error) {
    if (res.headersSent) { try { res.end(); } catch { /* client gone */ } return; }
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
