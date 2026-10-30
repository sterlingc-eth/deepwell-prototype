/**
 * Database half of the connectors. createStore(tx) returns the store the core uses; tx(fn) runs fn(db) inside one tenant
 * transaction (withTenant). Tables: donovan-training/CONNECTORS_TABLES.sql (owner runs it). Secrets come back only as stored
 * (encrypted) text; publicLink() is the only shape that leaves the server.
 */
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const rows = async (db, sql, p = []) => (await db.raw(sql, p)).rows ?? [];
const one = async (db, sql, p = []) => (await rows(db, sql, p))[0] ?? null;

export function createStore(tx) {
  return {
    listLinks: () => tx((db) => rows(db, `SELECT * FROM connector_links WHERE ${TENANT} AND status <> 'disconnected' ORDER BY created_at`)),
    getLink: (id) => tx((db) => one(db, `SELECT * FROM connector_links WHERE ${TENANT} AND id = $1`, [id])),
    createLink: (l) => tx((db) => one(db,
      `INSERT INTO connector_links (tenant_id, provider, account_ref, folder_ref, folder_name, secrets_enc, mapping, connected_by)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [l.provider, l.accountRef, l.folderRef, l.folderName ?? null, l.secretsEnc, JSON.stringify(l.mapping ?? {}), l.userId ?? null])),
    setMapping: (id, mapping) => tx((db) => one(db, `UPDATE connector_links SET mapping = $2::jsonb, updated_at = NOW() WHERE ${TENANT} AND id = $1 RETURNING *`, [id, JSON.stringify(mapping)])),
    setFolder: (id, f) => tx((db) => one(db, `UPDATE connector_links SET folder_ref = $2, folder_name = $3, status = 'active', cursor = '{}'::jsonb, updated_at = NOW() WHERE ${TENANT} AND id = $1 RETURNING *`, [id, f.folderRef, f.folderName ?? null])),
    setStatus: (id, status) => tx((db) => one(db,
      `UPDATE connector_links SET status = $2, secrets_enc = CASE WHEN $2 = 'disconnected' THEN NULL ELSE secrets_enc END, updated_at = NOW()
        WHERE ${TENANT} AND id = $1 RETURNING *`, [id, status])),
    /** Lease so two passes never overlap. Returns the row, or null when busy / not active. */
    claim: (id, leaseMs, now = Date.now()) => tx(async (db) => {
      const r = await one(db, `SELECT * FROM connector_links WHERE ${TENANT} AND id = $1 FOR UPDATE`, [id]);
      if (!r || r.status !== "active") return null;
      if (r.lease_until && new Date(r.lease_until).getTime() > now) return null;
      return one(db, `UPDATE connector_links SET lease_until = to_timestamp($2 / 1000.0) WHERE ${TENANT} AND id = $1 RETURNING *`, [id, now + leaseMs]);
    }),
    saveSecrets: (id, enc) => tx((db) => db.raw(`UPDATE connector_links SET secrets_enc = $2, updated_at = NOW() WHERE ${TENANT} AND id = $1`, [id, enc])),
    finish: (id, f) => tx((db) => db.raw(
      `UPDATE connector_links SET status = $2, last_message = $3, cursor = COALESCE($4::jsonb, cursor), lease_until = NULL, last_run_at = NOW(),
              imported_total = imported_total + $5, updated_at = NOW() WHERE ${TENANT} AND id = $1`,
      [id, f.status ?? "active", f.message ?? null, f.cursor ? JSON.stringify(f.cursor) : null, f.tally?.created ?? 0])),
    getItem: (linkId, ref) => tx((db) => one(db, `SELECT *, item_ref AS ref FROM connector_items WHERE ${TENANT} AND link_id = $1 AND item_ref = $2`, [linkId, ref])),
    itemByProviderHash: (kind, hash) => tx((db) => one(db,
      `SELECT *, item_ref AS ref FROM connector_items WHERE ${TENANT} AND provider_hash_kind = $1 AND provider_hash = $2 AND document_id IS NOT NULL AND state = 'imported' LIMIT 1`, [kind, hash])),
    upsertItem: (it) => tx((db) => one(db,
      `INSERT INTO connector_items (tenant_id, link_id, item_ref, filename, change_marker, provider_hash, provider_hash_kind, content_sha256, document_id, target_folder, state, note, imported_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::bigint IS NULL THEN NULL ELSE to_timestamp($12::bigint / 1000.0) END)
       ON CONFLICT (tenant_id, link_id, item_ref) DO UPDATE
         SET filename = EXCLUDED.filename, change_marker = EXCLUDED.change_marker, provider_hash = EXCLUDED.provider_hash, provider_hash_kind = EXCLUDED.provider_hash_kind,
             content_sha256 = COALESCE(EXCLUDED.content_sha256, connector_items.content_sha256), document_id = COALESCE(EXCLUDED.document_id, connector_items.document_id),
             target_folder = EXCLUDED.target_folder, state = EXCLUDED.state, note = EXCLUDED.note,
             imported_at = COALESCE(EXCLUDED.imported_at, connector_items.imported_at), updated_at = NOW()
       RETURNING *`,
      [it.linkId, it.ref, it.filename ?? null, it.marker ?? null, it.providerHash ?? null, it.providerHashKind ?? null, it.contentSha256 ?? null, it.documentId ?? null,
       it.targetFolder ?? null, it.state ?? "imported", it.note ?? null, it.importedAt ?? null])),
    markRemoved: (linkId, ref) => tx((db) => one(db, `UPDATE connector_items SET state = 'removed-in-source', updated_at = NOW() WHERE ${TENANT} AND link_id = $1 AND item_ref = $2 AND state = 'imported' RETURNING *`, [linkId, ref])),
    markReturned: (linkId, ref) => tx((db) => one(db, `UPDATE connector_items SET state = 'imported', updated_at = NOW() WHERE ${TENANT} AND link_id = $1 AND item_ref = $2 AND state = 'removed-in-source' RETURNING *`, [linkId, ref])),
    // ---- email-in
    getEmail: () => tx((db) => one(db, `SELECT * FROM connector_email WHERE ${TENANT}`)),
    saveEmail: (e) => tx((db) => one(db,
      `INSERT INTO connector_email (tenant_id, token_hash, token_hint, allowed_senders) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3::text[])
       ON CONFLICT (tenant_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint, rotated_at = NOW() RETURNING *`,
      [e.tokenHash, e.tokenHint, e.allowedSenders ?? []])),
    setEmail: (patch) => tx((db) => one(db,
      `UPDATE connector_email SET allowed_senders = COALESCE($1::text[], allowed_senders), enabled = COALESCE($2::boolean, enabled) WHERE ${TENANT} RETURNING *`,
      [patch.allowedSenders ?? null, patch.enabled ?? null])),
    /** Records the message id once. Returns false when it was already seen (duplicate delivery). */
    recordEmailEvent: (messageId, outcome, files = 0) => tx(async (db) => {
      const r = await one(db, `INSERT INTO connector_email_events (tenant_id, message_id, outcome, files) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [messageId, outcome, files]);
      if (r && outcome === "quarantined") await db.raw(`UPDATE connector_email SET quarantined_count = quarantined_count + 1 WHERE ${TENANT}`, []);
      return !!r;
    }),
    emailCountSince: (sinceMs) => tx(async (db) => Number((await one(db, `SELECT COUNT(*)::int AS n FROM connector_email_events WHERE ${TENANT} AND received_at > to_timestamp($1 / 1000.0)`, [sinceMs]))?.n ?? 0)),
  };
}

/** Cross-tenant lookups through the SECURITY DEFINER functions (identifiers only). `rootDb` = a plain query runner outside any tenant. */
export const listConnectorTenants = async (rootDb) => (await rootDb.query("SELECT tenant_key FROM list_connector_tenants()")).rows.map((r) => r.tenant_key);
export const emailLookup = async (rootDb, tokenHash) => (await rootDb.query("SELECT tenant_key, allowed_senders FROM connector_email_lookup($1)", [tokenHash])).rows[0] ?? null;

/** The only link shape that leaves the server: no secret, no cursor. */
export const publicLink = (r) => ({ id: r.id, provider: r.provider, folderName: r.folder_name, status: r.status, message: r.last_message, lastRunAt: r.last_run_at, importedTotal: r.imported_total, mapping: r.mapping });
