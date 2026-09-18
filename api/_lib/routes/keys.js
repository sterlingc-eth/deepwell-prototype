import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { getAuxPool, generateKey, SCOPES } from "../apiKeyAuth.js";

/**
 * POST /api/keys
 * body: { action: 'create', name, scopes }  -> { id, name, keyPrefix, scopes, createdAt, key }
 *       { action: 'list' }                  -> { keys: [...] }        (never includes key material)
 *       { action: 'revoke', id }             -> { id, revoked: true }
 *
 * Minting, listing and revoking API keys. DELIBERATELY Clerk-session-only —
 * this route calls requireAuth() directly, never requireAuthOrKey() — because
 * a key that could mint more keys would let a single leaked credential
 * self-propagate into an unbounded number of credentials with the same or
 * wider scopes. Only a human with a real session can create or revoke one.
 *
 * A newly created key's raw value is returned exactly once, in this
 * response, and is never persisted or logged anywhere — only its sha256 hash
 * is stored (api_keys.key_hash), by generateKey() in ./_lib/apiKeyAuth.js.
 *
 * api_keys has no entry in recordsStore.js (owned by another engineer, not
 * edited here), so this route talks to it directly, on apiKeyAuth.js's small
 * auxiliary pool, reproducing the same three things withTenant() does for
 * every other table in this codebase: resolve the caller's tenant, SET LOCAL
 * app.tenant_id for the duration of one transaction, and let RLS (FORCE ROW
 * LEVEL SECURITY on api_keys — see M3-config/10-api-keys.sql) do the rest.
 * No policy is bypassed and no SECURITY DEFINER function is used here: unlike
 * apiKeyAuth.js's lookup, this route already knows its tenant (from a
 * verified Clerk session), so it needs nothing more than the ordinary
 * per-transaction tenant context every other write in this codebase uses.
 */
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

const NAME_RE = /^.{1,100}$/s;

async function withTenantTx(ctx, fn) {
  const client = await getAuxPool().connect();
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

async function logAudit(client, tenantId, { action, resource_type, resource_id, clerk_user_id, changes }) {
  let userId = null;
  if (clerk_user_id) {
    const { rows } = await client.query(
      "SELECT id FROM users WHERE clerk_user_id = $1 AND tenant_id = $2",
      [clerk_user_id, tenantId]
    );
    userId = rows[0]?.id ?? null;
  }
  const fullChanges = { ...(changes ?? {}) };
  if (!userId && clerk_user_id) fullChanges.clerk_user_id = clerk_user_id;
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [tenantId, userId, action, resource_type ?? null, resource_id ?? null, fullChanges]
  );
}

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

  const body = req.body ?? {};
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    if (body.action === "create") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!NAME_RE.test(name)) {
        return res.status(400).json({ error: "name is required (1-100 characters)" });
      }
      const scopes = [...new Set(Array.isArray(body.scopes) ? body.scopes : [])];
      if (!scopes.length || !scopes.every((s) => SCOPES.includes(s))) {
        return res.status(400).json({ error: `scopes must be a non-empty array drawn from: ${SCOPES.join(", ")}` });
      }

      const { rawKey, keyPrefix, keyHash } = generateKey();

      const result = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(
          `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           RETURNING id, name, key_prefix, scopes, created_at`,
          [tenantId, name, keyPrefix, keyHash, scopes, auth.userId]
        );
        const row = rows[0];
        await logAudit(client, tenantId, {
          action: "api_key.create",
          resource_type: "api_key",
          resource_id: row.id,
          clerk_user_id: auth.userId,
          changes: { name, scopes },
        });
        return row;
      });

      return handleCors(res, req).status(201).json({
        id: result.id,
        name: result.name,
        keyPrefix: result.key_prefix,
        scopes: result.scopes,
        createdAt: result.created_at,
        // Shown exactly once. The caller must copy it now — it cannot be
        // retrieved again, by anyone, ever; only its hash is stored.
        key: rawKey,
      });
    }

    if (body.action === "list") {
      const rows = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(
          `SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
             FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [tenantId]
        );
        return rows;
      });
      return handleCors(res, req).status(200).json({
        keys: rows.map((r) => ({
          id: r.id,
          name: r.name,
          keyPrefix: r.key_prefix,
          scopes: r.scopes,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          revoked: r.revoked_at != null,
          revokedAt: r.revoked_at,
        })),
      });
    }

    if (body.action === "revoke") {
      const id = typeof body.id === "string" ? body.id : null;
      if (!id) return res.status(400).json({ error: "id is required" });

      const revoked = await withTenantTx(ctx, async (client, tenantId) => {
        const { rows } = await client.query(
          `UPDATE api_keys SET revoked_at = NOW()
             WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
             RETURNING id`,
          [id, tenantId]
        );
        if (rows[0]) {
          await logAudit(client, tenantId, {
            action: "api_key.revoke",
            resource_type: "api_key",
            resource_id: id,
            clerk_user_id: auth.userId,
          });
        }
        return !!rows[0];
      });

      if (!revoked) return res.status(404).json({ error: "Key not found or already revoked" });
      return handleCors(res, req).status(200).json({ id, revoked: true });
    }

    return res.status(400).json({ error: "action must be one of: create, list, revoke" });
  } catch (error) {
    return handleError(res, error, req);
  }
}
