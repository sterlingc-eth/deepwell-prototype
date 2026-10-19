/**
 * Reading ONE company's data out of the live database for a backup. Read-only SELECTs, always inside the company's own
 * RLS-scoped transaction (opsStore.withTenant: the app role, app.tenant_id set), so a bug here cannot read another company's
 * rows - Postgres refuses. The table list comes from the catalog (every table with a tenant_id column), parents first, so a
 * table added by a future migration is backed up without anyone remembering to list it (the same idea as tenant delete).
 */
import { withTenant, DELETE_ORDER } from '../opsStore.js';

/** Pure caches and counters that are rebuilt by the app; not worth the space. Override with BACKUP_SKIP_TABLES (comma list). */
export const DEFAULT_SKIP_TABLES = Object.freeze(['ask_answer_cache', 'ask_semantic_cache', 'rate_limit_windows', 'tenant_insights_cache', 'embedding_usage', 'customer_activity_dirty']);
export const PAGE_ROWS = 2000;

export function skipTablesFromEnv(env = process.env) {
  const raw = env.BACKUP_SKIP_TABLES;
  if (raw == null || raw === '') return [...DEFAULT_SKIP_TABLES];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => /^[a-z_][a-z0-9_]*$/.test(s));
}

/** Pure: tenants first, then DELETE_ORDER reversed (parents before children), then any straggler, minus the skipped. */
export function orderTables(present, skip = DEFAULT_SKIP_TABLES) {
  const have = new Set(present);
  const ordered = ['tenants', ...[...DELETE_ORDER].reverse(), ...[...have].filter((t) => t !== 'tenants' && !DELETE_ORDER.includes(t)).sort()];
  return [...new Set(ordered)].filter((t) => have.has(t) && !skip.includes(t));
}

/** { tenantId, tables: [{ name, idType|null }] } for this company. */
export async function describeTenant(ctx, skip = DEFAULT_SKIP_TABLES) {
  return withTenant(ctx, async (client, tenantId) => {
    const { rows } = await client.query(
      `SELECT c.relname AS t,
              bool_or(a.attname = 'tenant_id') AS has_tenant,
              max(CASE WHEN a.attname = 'id' THEN format_type(a.atttypid, a.atttypmod) END) AS id_type
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p')
        GROUP BY c.relname
       HAVING bool_or(a.attname = 'tenant_id') OR c.relname = 'tenants'`
    );
    const byName = new Map(rows.map((r) => [r.t, r.id_type ?? null]));
    return { tenantId, tables: orderTables([...byName.keys()], skip).map((name) => ({ name, idType: byName.get(name) })) };
  });
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const SAFE_TYPE = /^[a-z][a-z0-9 ()]*$/;

/**
 * One page of a table as JSON lines, resuming after `after` (the last id of the previous page).
 * @returns {Promise<{lines: string[], last: string|null, done: boolean}>}
 */
export async function readTablePage(ctx, table, { idType, after = null, limit = PAGE_ROWS } = {}) {
  if (!SAFE_IDENT.test(table.name ?? table)) throw new Error('unsafe table name');
  const name = table.name ?? table;
  return withTenant(ctx, async (client) => {
    const scope = name === 'tenants' ? `t.id = (current_setting('app.tenant_id', true))::uuid` : `t.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
    if (!idType) { // no id column: these are small per-company tables; read them whole in one go
      const { rows } = await client.query(`SELECT row_to_json(t)::text AS j FROM "${name}" t WHERE ${scope}`);
      return { lines: rows.map((r) => r.j), last: null, done: true };
    }
    if (!SAFE_TYPE.test(idType)) throw new Error('unsafe id type');
    const { rows } = await client.query(
      `SELECT row_to_json(t)::text AS j, t.id::text AS id FROM "${name}" t
        WHERE ${scope} AND ($1::text IS NULL OR t.id > $1::${idType})
        ORDER BY t.id ASC LIMIT $2`,
      [after, limit]
    );
    return { lines: rows.map((r) => r.j), last: rows.length ? rows[rows.length - 1].id : after, done: rows.length < limit };
  });
}

/** One page of documents that have a stored original, for the file phase. */
export async function readDocumentFilePage(ctx, { after = null, limit = 200 } = {}) {
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query(
      `SELECT id::text AS id, original_filename, document_type, sha256_hash, file_size_bytes, storage_key, created_at::text AS created_at
         FROM documents
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND storage_key IS NOT NULL
          AND ($1::text IS NULL OR id > $1::uuid)
        ORDER BY id ASC LIMIT $2`,
      [after, limit]
    );
    return { rows, last: rows.length ? rows[rows.length - 1].id : after, done: rows.length < limit };
  });
}

/** The company's Clerk key, for the manifest (so a restore can find a company by its Clerk org id). */
export async function readTenantIdentity(ctx) {
  return withTenant(ctx, async (client, tenantId) => {
    const { rows } = await client.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]).catch(() => ({ rows: [] }));
    return { tenantId, tenantKey: ctx.tenantKey, name: rows[0]?.name ?? null };
  });
}
