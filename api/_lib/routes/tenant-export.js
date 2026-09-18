import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";
import { exportTenant } from "../opsStore.js";

/**
 * POST /api/tenant-export
 *
 * The export half of the promise the marketing page already makes and this
 * codebase never built: "export your data." Returns everything the tenant's
 * own documents, pages, extractions, entities and audit log hold, as one
 * downloadable JSON file, with storage_key excluded (see opsStore.exportTenant).
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

  try {
    const data = await exportTenant(ctx);

    // Best-effort: a customer who asked for their own export must not be
    // denied it because the audit write failed.
    await withTenant(ctx, (db) =>
      db.logAction({
        action: "tenant.exported",
        resource_type: "tenant",
        clerk_user_id: auth.userId,
        changes: { documents: data.documents.length, truncated: data.truncated },
      })
    ).catch((err) => console.error("Failed to write tenant.exported audit row:", err?.message));

    const cors = handleCors(res, req);
    cors.setHeader("Content-Disposition", `attachment; filename="deepwell-export-${auth.tenantId}.json"`);
    return cors.status(200).json(data);
  } catch (error) {
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
