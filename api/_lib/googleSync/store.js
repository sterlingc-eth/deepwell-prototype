/**
 * Database half of Google sync. Every function takes the tenant-scoped store handle from withTenant() (db.raw runs inside the
 * transaction that already has app.tenant_id set) and still carries the tenant predicate itself, next to row-level security.
 * Tables: M3-config/71-google-sync.sql. No token is ever returned from here except as stored (encrypted) text, and publicConnection()
 * is the only shape that leaves the server.
 */
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

const q = async (db, sql, params = []) => (await db.raw(sql, params)).rows ?? [];
const one = async (db, sql, params = []) => (await q(db, sql, params))[0] ?? null;

export const getConnection = (db, provider) =>
  one(db, `SELECT * FROM google_connections WHERE ${TENANT} AND provider = $1`, [provider]);

export const listConnections = (db) =>
  q(db, `SELECT * FROM google_connections WHERE ${TENANT} AND status <> 'disconnected' ORDER BY provider`);

export async function saveConnection(db, { provider, scopeMode, email, tokenEnc, userId }) {
  return one(
    db,
    `INSERT INTO google_connections (tenant_id, provider, scope_mode, google_email, refresh_token_enc, status, connected_by)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, 'active', $5)
     ON CONFLICT (tenant_id, provider) DO UPDATE
       SET scope_mode = EXCLUDED.scope_mode, google_email = EXCLUDED.google_email, refresh_token_enc = EXCLUDED.refresh_token_enc,
           status = 'active', connected_by = EXCLUDED.connected_by, last_error = NULL,
           -- a different Google account or a changed access level starts over; the same one keeps its choices
           config = CASE WHEN google_connections.google_email IS NOT DISTINCT FROM EXCLUDED.google_email AND google_connections.scope_mode = EXCLUDED.scope_mode THEN google_connections.config ELSE '{}'::jsonb END,
           sync_state = CASE WHEN google_connections.google_email IS NOT DISTINCT FROM EXCLUDED.google_email AND google_connections.scope_mode = EXCLUDED.scope_mode THEN google_connections.sync_state ELSE '{}'::jsonb END,
           updated_at = NOW()
     RETURNING *`,
    [provider, scopeMode, email ?? null, tokenEnc, userId ?? null]
  );
}

const PATCHABLE = { status: "text", config: "jsonb", sync_state: "jsonb", last_sync_at: "timestamptz", last_result: "text", last_error: "text", refresh_token_enc: "text" };
export async function patchConnection(db, id, patch, { addImported = 0 } = {}) {
  const sets = [];
  const params = [id];
  for (const [k, type] of Object.entries(PATCHABLE)) {
    if (!(k in patch)) continue;
    params.push(type === "jsonb" ? JSON.stringify(patch[k] ?? {}) : patch[k]);
    // sync_state is MERGED (a pass can never wipe the lease another step holds); config and the rest are replaced.
    sets.push(k === "sync_state" ? `sync_state = COALESCE(sync_state, '{}'::jsonb) || $${params.length}::jsonb` : `${k} = $${params.length}::${type}`);
  }
  if (addImported) { params.push(addImported); sets.push(`files_imported = files_imported + $${params.length}::int`); }
  sets.push("updated_at = NOW()");
  return one(db, `UPDATE google_connections SET ${sets.join(", ")} WHERE id = $1 AND ${TENANT} RETURNING *`, params);
}

export const getItem = (db, connectionId, externalId) =>
  one(db, `SELECT * FROM google_sync_items WHERE ${TENANT} AND connection_id = $1 AND external_id = $2`, [connectionId, externalId]);

export async function upsertItem(db, it) {
  return one(
    db,
    `INSERT INTO google_sync_items (tenant_id, connection_id, external_id, filename, source_checksum, content_sha256, document_id,
                                    version, previous_document_ids, state, note, source_modified_at, imported_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11, $12)
     ON CONFLICT (tenant_id, connection_id, external_id) DO UPDATE
       SET filename = EXCLUDED.filename, source_checksum = EXCLUDED.source_checksum, content_sha256 = EXCLUDED.content_sha256,
           document_id = EXCLUDED.document_id, version = EXCLUDED.version, previous_document_ids = EXCLUDED.previous_document_ids,
           state = EXCLUDED.state, note = EXCLUDED.note, source_modified_at = EXCLUDED.source_modified_at,
           imported_at = COALESCE(EXCLUDED.imported_at, google_sync_items.imported_at), updated_at = NOW()
     RETURNING *`,
    [it.connectionId, it.externalId, it.filename ?? null, it.sourceChecksum ?? null, it.contentSha256 ?? null, it.documentId ?? null,
     it.version ?? 1, it.previousDocumentIds ?? [], it.state ?? "imported", it.note ?? null, it.sourceModifiedAt ?? null, it.importedAt ?? null]
  );
}

export const markRemoved = (db, connectionId, externalId) =>
  one(db, `UPDATE google_sync_items SET state = 'removed-in-source', updated_at = NOW()
            WHERE ${TENANT} AND connection_id = $1 AND external_id = $2 AND state = 'imported' RETURNING *`, [connectionId, externalId]);

export const markReturned = (db, connectionId, externalId) =>
  one(db, `UPDATE google_sync_items SET state = 'imported', updated_at = NOW()
            WHERE ${TENANT} AND connection_id = $1 AND external_id = $2 AND state = 'removed-in-source' RETURNING *`, [connectionId, externalId]);

/** Files brought in from Google today (UTC), all sources: the per-organization daily quota. */
export async function importedToday(db) {
  const r = await one(db, `SELECT COUNT(*)::int AS n FROM google_sync_items WHERE ${TENANT} AND imported_at >= date_trunc('day', NOW() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`);
  return r?.n ?? 0;
}

export async function itemCounts(db, connectionId) {
  const rows = await q(db, `SELECT state, COUNT(*)::int AS n FROM google_sync_items WHERE ${TENANT} AND connection_id = $1 GROUP BY state`, [connectionId]);
  const out = { imported: 0, removed: 0, skipped: 0, error: 0 };
  for (const r of rows) {
    if (r.state === "imported") out.imported = r.n;
    else if (r.state === "removed-in-source") out.removed = r.n;
    else if (r.state === "skipped") out.skipped = r.n;
    else if (r.state === "error") out.error = r.n;
  }
  return out;
}

export const recentProblems = (db, connectionId, limit = 5) =>
  q(db, `SELECT filename, state, note FROM google_sync_items WHERE ${TENANT} AND connection_id = $1 AND state IN ('error','skipped')
          ORDER BY updated_at DESC LIMIT $2`, [connectionId, limit]);

export const removedFiles = (db, connectionId, limit = 20) =>
  q(db, `SELECT filename, document_id FROM google_sync_items WHERE ${TENANT} AND connection_id = $1 AND state = 'removed-in-source'
          ORDER BY updated_at DESC LIMIT $2`, [connectionId, limit]);

/** Whether a document with these exact bytes is already stored for this organization. */
export const documentBySha = (db, sha) =>
  one(db, `SELECT id, storage_key, stage FROM documents WHERE ${TENANT} AND sha256_hash = $1`, [sha]);

/** The only shape that leaves the server: no token, no ciphertext, no internal cursor. */
export function publicConnection(row, counts = {}, extra = {}) {
  if (!row) return null;
  const cfg = row.config ?? {};
  return {
    provider: row.provider,
    scopeMode: row.scope_mode,
    email: row.google_email ?? null,
    status: row.status,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    lastResult: row.last_result ?? null,
    lastError: row.last_error ?? null,
    filesImported: Number(row.files_imported) || 0,
    importedCount: counts.imported ?? 0,
    removedCount: counts.removed ?? 0,
    errorCount: counts.error ?? 0,
    choices: row.provider === "drive"
      ? { picked: (cfg.picked ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind })) }
      : { labelIds: cfg.labelIds ?? [], labelNames: cfg.labelNames ?? [], senders: cfg.senders ?? [], lookbackDays: cfg.lookbackDays ?? 30 },
    ...extra,
  };
}

/** Lock the connection row and, when nobody else is mid-pass, take a lease on it. Returns {row} or {busy:true} / {none:true} / {inactive:status}. */
export async function claimConnection(db, provider, leaseMs, now = Date.now()) {
  const row = await one(db, `SELECT * FROM google_connections WHERE ${TENANT} AND provider = $1 FOR UPDATE`, [provider]);
  if (!row) return { none: true };
  if (row.status !== "active") return { inactive: row.status };
  const lease = Number(row.sync_state?.lease);
  if (Number.isFinite(lease) && lease > now) return { busy: true };
  const claimed = await patchConnection(db, row.id, { sync_state: { lease: now + leaseMs } });
  return { row: claimed };
}

/** Organizations that have a connection switched on (M3-config/71 definer function). Empty until that file has been run. */
export async function listSyncTenants() {
  const { getPool } = await import("../recordsStore.js");
  const { serializeClient } = await import("../util/pgClient.js");
  const client = serializeClient(await getPool().connect());
  try {
    const { rows } = await client.query("SELECT tenant_key FROM list_google_sync_tenants() WHERE tenant_key IS NOT NULL");
    return rows.map((r) => ({ tenant_key: r.tenant_key, tenant_name: r.tenant_key }));
  } catch (err) {
    console.error("google sync: list_google_sync_tenants() unavailable (run M3-config/71-google-sync.sql):", err?.message);
    return [];
  } finally {
    client.release();
  }
}
