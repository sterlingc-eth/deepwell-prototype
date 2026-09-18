import { requireAuth, denyAuth, hasShop } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";

/**
 * POST /api/merge-tenant   (-> /api/account?action=merge)
 *
 * Fold the caller's solo tenant (`user_<clerkUserId>`) into the shop they now
 * belong to. This is the migration path off auth.js's solo fallback: a
 * technician who uploaded a few tickets before the owner created the shop
 * would otherwise see them vanish the moment they accept the invite.
 *
 * Both keys come from the verified token, NEVER from the body. A caller who
 * could name `from_key` could pull any solo tenant's documents into their own
 * shop; M3-config/07-multi-user.sql's merge_tenant() additionally refuses any
 * from_key that is not `user_*`, so even a bug here cannot merge one shop into
 * another.
 *
 * Idempotent: with nothing ever uploaded solo, merge_tenant() returns zero
 * rows and this responds { moved: {} }. App.tsx fires it optimistically on
 * every org-scoped sign-in and ignores the result, so it must be cheap and
 * must never fail loudly for the common no-op case.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  if (!hasShop(auth)) {
    // Solo tenant: there is nothing to merge into. Not an error — the client
    // calls this unconditionally once an org is active.
    return res.status(200).json({ moved: {}, note: "No shop selected; nothing to merge." });
  }

  const fromKey = `user_${auth.userId}`;
  const toKey = auth.tenantId;

  try {
    // withTenant resolves (and, on first sight, creates) the destination
    // tenant, which merge_tenant() requires to exist. The function is
    // SECURITY DEFINER, so the RLS scope set here does not restrict it.
    const rows = await withTenant(
      { tenantKey: toKey, tenantName: auth.orgId },
      (store) => store.raw("SELECT moved_table, moved_rows FROM merge_tenant($1, $2)", [fromKey, toKey])
    );
    const moved = {};
    for (const r of rows.rows ?? []) moved[r.moved_table] = Number(r.moved_rows);
    return handleCors(res, req).status(200).json({ moved });
  } catch (error) {
    return handleError(res, error, req, { tenantId: toKey });
  }
}
