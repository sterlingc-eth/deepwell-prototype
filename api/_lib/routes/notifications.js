import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { getPool } from "../recordsStore.js";

/**
 * GET  /api/account?action=notifications  -> { items: [...unread first, <=50], unreadCount }
 * POST /api/account?action=notifications
 *   { markRead: string[] }         -> { updated: n }
 *   { all: true }                  -> { updated: n }
 *   { settings: { emailDigest } }  -> { settings: {...} }   (admin only, shop tenants)
 *
 * Shapes documented in handoffs/NOTIFICATIONS.md. `notifications` isn't in
 * recordsStore.js's curated store (owned by another engineer, no method for
 * it there), so — same as api/_lib/routes/keys.js does for api_keys — this
 * route runs its own resolve_tenant()/SET LOCAL transaction on a raw client
 * from recordsStore.js's shared pool, and RLS (FORCE on `notifications`,
 * M3-config/16-notifications.sql) does the tenant isolation.
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

const MAX_ITEMS = 50;
const MAX_MARK_IDS = 200;

async function withTenantTx(ctx, fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT resolve_tenant($1, $2) AS id", [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    const tenantId = rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client, tenantId);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listNotifications(client, tenantId) {
  const { rows } = await client.query(
    `SELECT id, kind, title, body, link, created_at, read_at
       FROM notifications
      ORDER BY (read_at IS NULL) DESC, created_at DESC
      LIMIT $1`,
    [MAX_ITEMS]
  );
  const { rows: countRows } = await client.query(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`);
  const { rows: tenantRows } = await client.query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  const emailDigest = (tenantRows[0]?.settings ?? {}).emailDigest !== false;
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.created_at,
      readAt: r.read_at,
    })),
    unreadCount: Number(countRows[0]?.n ?? 0),
    emailDigest,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    if (req.method === "GET") {
      const out = await withTenantTx(ctx, (client, tenantId) => listNotifications(client, tenantId));
      return handleCors(res, req).status(200).json(out);
    }

    const body = req.body ?? {};

    if (body.settings && typeof body.settings === "object") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const emailDigest = body.settings.emailDigest;
      if (typeof emailDigest !== "boolean") {
        return handleCors(res, req).status(400).json({ error: "settings.emailDigest must be a boolean" });
      }
      const settings = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(
          `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('emailDigest', $2::boolean)
             WHERE id = $1
           RETURNING settings`,
          [tenantId, emailDigest]
        );
        return rows[0]?.settings ?? {};
      });
      return handleCors(res, req).status(200).json({ settings });
    }

    let updated = 0;
    if (body.all === true) {
      updated = await withTenantTx(ctx, async (client) => {
        const { rowCount } = await client.query(`UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL`);
        return rowCount;
      });
    } else if (Array.isArray(body.markRead)) {
      const ids = body.markRead.filter((id) => typeof id === "string" && id).slice(0, MAX_MARK_IDS);
      if (ids.length) {
        updated = await withTenantTx(ctx, async (client) => {
          const { rowCount } = await client.query(
            `UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL AND id = ANY($1::uuid[])`,
            [ids]
          );
          return rowCount;
        });
      }
    } else {
      return handleCors(res, req).status(400).json({ error: "Expected { markRead: [...] }, { all: true }, or { settings: {...} }" });
    }

    return handleCors(res, req).status(200).json({ updated });
  } catch (error) {
    return handleError(res, error, req);
  }
}
