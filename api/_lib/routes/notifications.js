import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { getPool, getTenantContext } from "../recordsStore.js";
import { limit as rateLimit } from "../rateLimit.js";
import { startTimer } from "../timing.js";
import { logStage } from "../perf.js";

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
  // API_PERF_2026-09-22: tenant id comes from the shared, cached context
  // (recordsStore.js's getTenantContext) instead of this route running its
  // own resolve_tenant() query on every call — same optimization as
  // recordsStore.js's own withTenant(), which this hand-rolled copy exists
  // alongside only because `notifications` has no curated store method (see
  // the file header).
  const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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

/**
 * API_PERF_2026-09-22: the three queries this used to run in sequence (the
 * page of items, the unread count, and the tenant's emailDigest setting) are
 * independent reads against the same RLS-scoped connection — collapsed here
 * into one round trip via three CTEs, rather than three separate awaits each
 * paying their own network latency to Neon.
 */
async function listNotifications(client, tenantId) {
  const { rows } = await client.query(
    `WITH items AS (
       SELECT id, kind, title, body, link, created_at, read_at
         FROM notifications
        ORDER BY (read_at IS NULL) DESC, created_at DESC
        LIMIT $1
     ),
     unread AS (
       SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL
     ),
     tenant AS (
       SELECT settings FROM tenants WHERE id = $2
     )
     SELECT (SELECT COALESCE(json_agg(i ORDER BY (i.read_at IS NULL) DESC, i.created_at DESC), '[]'::json)
               FROM items i) AS items,
            (SELECT n FROM unread) AS unread_count,
            (SELECT settings FROM tenant) AS settings`,
    [MAX_ITEMS, tenantId]
  );
  const row = rows[0] ?? {};
  const emailDigest = (row.settings ?? {}).emailDigest !== false;
  return {
    items: (row.items ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.created_at,
      readAt: r.read_at,
    })),
    unreadCount: Number(row.unread_count ?? 0),
    emailDigest,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // API_PERF_2026-09-22 (DW_TIMING=1 only): one JSON line per request.
  const timer = startTimer();
  let statusSent = 0;
  try {
    let auth;
    try {
      auth = await timer.time("auth", () => requireAuth(req));
    } catch (err) {
      statusSent = err?.status ?? 401;
      return denyAuth(res, err);
    }

    // QA_APP_API_2026-09-21: every other write/scan route in this codebase
    // rate-limits itself; this one didn't, despite being reachable by any
    // signed-in member (not just admins) and polled automatically every 5
    // minutes by NotificationsPanel.tsx. 'read' bucket, same fallback bucket
    // envLimits() already gives an unrecognized name — cheap enough traffic
    // that it doesn't deserve its own dedicated bucket.
    if (!(await timer.time("limit", () => rateLimit(req, res, auth, "read")))) {
      statusSent = 429;
      return; // 429 already written
    }

    const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

    if (req.method === "GET") {
      const out = await timer.time("handler", () => withTenantTx(ctx, (client, tenantId) => listNotifications(client, tenantId)));
      statusSent = 200;
      return handleCors(res, req).status(200).json(out);
    }

    const body = req.body ?? {};

    if (body.settings && typeof body.settings === "object") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const emailDigest = body.settings.emailDigest;
      if (typeof emailDigest !== "boolean") {
        statusSent = 400;
        return handleCors(res, req).status(400).json({ error: "settings.emailDigest must be a boolean" });
      }
      const settings = await timer.time("handler", () =>
        withTenantTx(ctx, async (client, tenantId) => {
          const { rows } = await client.query(
            `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('emailDigest', $2::boolean)
               WHERE id = $1
             RETURNING settings`,
            [tenantId, emailDigest]
          );
          return rows[0]?.settings ?? {};
        })
      );
      statusSent = 200;
      return handleCors(res, req).status(200).json({ settings });
    }

    let updated = 0;
    if (body.all === true) {
      updated = await timer.time("handler", () =>
        withTenantTx(ctx, async (client) => {
          const { rowCount } = await client.query(`UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL`);
          return rowCount;
        })
      );
    } else if (Array.isArray(body.markRead)) {
      const ids = body.markRead.filter((id) => typeof id === "string" && id).slice(0, MAX_MARK_IDS);
      if (ids.length) {
        updated = await timer.time("handler", () =>
          withTenantTx(ctx, async (client) => {
            const { rowCount } = await client.query(
              `UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL AND id = ANY($1::uuid[])`,
              [ids]
            );
            return rowCount;
          })
        );
      }
    } else {
      statusSent = 400;
      return handleCors(res, req).status(400).json({ error: "Expected { markRead: [...] }, { all: true }, or { settings: {...} }" });
    }

    statusSent = 200;
    return handleCors(res, req).status(200).json({ updated });
  } catch (error) {
    statusSent = error?.status ?? 500;
    return handleError(res, error, req);
  } finally {
    logStage({ t: "request", route: "account-notifications", method: req.method, status: statusSent, ...timer.snapshot() });
  }
}
