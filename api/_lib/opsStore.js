/**
 * Operational data access: cron sweeps, tenant export, tenant deletion.
 *
 * Deliberately its OWN module, with its OWN pool and its OWN withTenant, and
 * does not import recordsStore.js's internal store object. Two reasons:
 *
 *   1. recordsStore.js's makeStore() exposes a curated set of methods, each
 *      one column-allowlisted on purpose (see DOCUMENT_UPDATE_COLUMNS and the
 *      comment above it) — that curation is a security boundary for the
 *      product's normal read/write paths, and it is exactly what an ops tool
 *      needs to step around: exportTenant reads whole rows across five
 *      tables, and deleteTenantData deletes across eight. Bolting that onto
 *      the product's store would mean widening a boundary that exists for a
 *      good reason, for the benefit of code that runs on a cron schedule
 *      and admin action, not a customer request.
 *   2. It keeps this file's blast radius contained: everything an operator
 *      can do to a tenant's data lives in one file, reviewable on its own,
 *      never touching recordsStore.js.
 *
 * The tenancy mechanics below (deepwell_rls, resolve_tenant(),
 * SET LOCAL app.tenant_id) are copied from recordsStore.js's withTenant
 * rather than shared with it, which is a real duplication cost — but the
 * alternative was exporting recordsStore's private makeStore(), which would
 * have made recordsStore.js's "only these methods touch the database"
 * property untrue for its own callers. `client` here is the raw `pg` client,
 * not that curated store object, because ops queries (arbitrary WHERE
 * clauses, cross-table exports, multi-table deletes) don't fit a fixed
 * per-entity method shape. If recordsStore.js's tenancy setup ever changes (a
 * new resolve_tenant signature, a different session variable), this block has
 * to change with it.
 *
 * POOL CONSOLIDATION (scale-readiness build, 2026-09): this used to open its
 * own pg.Pool (max: 2). recordsStore.js now exports `getPool()` for exactly
 * this — one Postgres pool per warm instance instead of one per file that
 * needs a raw client. The transaction/RLS-scoping logic below is unchanged;
 * only where the connection comes from moved.
 */
import { getPool } from './recordsStore.js';

/**
 * Run `fn(client, tenantId)` inside a transaction scoped to the caller's
 * tenant. Unlike recordsStore.js's withTenant, `client` here is the raw `pg`
 * client — callers write their own SQL — because ops queries (arbitrary
 * WHERE clauses, cross-table exports, multi-table deletes) don't fit a fixed
 * per-entity method shape.
 * @param {{tenantKey: string, tenantName?: string}} ctx
 */
export async function withTenant(ctx, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    const tenantId = rows[0].id;
    // `true` = SET LOCAL: reverts on COMMIT/ROLLBACK, never outlives this request.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const result = await fn(client, tenantId);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Stuck documents: stage never advanced past 'received' and nothing recorded
 * why. Before this, two such documents sat in production indistinguishable
 * from ones still mid-upload — nothing polled for them, nothing found them.
 */
export async function listStuckDocuments(ctx, olderThanMinutes) {
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query(
      `SELECT id, original_filename, created_at
         FROM documents
        WHERE stage = 'received'
          AND extract_error IS NULL
          AND created_at < NOW() - ($1 || ' minutes')::interval
          AND ${TENANT}
        ORDER BY created_at ASC
        LIMIT 200`,
      [olderThanMinutes]
    );
    return rows;
  });
}

/**
 * Documents the ingest queue deliberately deferred because the tenant's
 * daily model-spend cap was already spent (queue.js's cost guard —
 * DAILY_BUDGET_EXCEEDED_MESSAGE), as opposed to ones that genuinely failed.
 *
 * Matched by the EXACT message queue.js stamps, passed in by the caller
 * rather than hardcoded here — opsStore.js does not own queue.js and must
 * never let the two copies of that string drift apart silently. A document
 * that failed for a real, permanent reason (a corrupt PDF, an unsupported
 * type) has a DIFFERENT extract_error and is correctly left alone by this
 * query; only listStuckDocuments' "no reason at all" case and this exact,
 * deliberate, resume-tomorrow case are ever auto-retried.
 *
 * No age filter (unlike listStuckDocuments): a budget-capped document was
 * never "stuck" in the sense of something having silently gone wrong — it is
 * exactly where it is supposed to be, waiting for the next day's cron sweep,
 * however recently it was capped.
 */
export async function listBudgetDeferredDocuments(ctx, message) {
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query(
      `SELECT id, original_filename, created_at
         FROM documents
        WHERE stage = 'received'
          AND extract_error = $1
          AND ${TENANT}
        ORDER BY created_at ASC
        LIMIT 200`,
      [message]
    );
    return rows;
  });
}

/**
 * Cross-tenant tenant listing, for the cron sweep — which has to visit every
 * tenant, not one at a time by request.
 *
 * KNOWN LIMITATION, DOCUMENTED RATHER THAN HIDDEN: the application connects
 * as `deepwell_rls`, which is NOBYPASSRLS (M3-config/01b-app-role.sql), and
 * `tenants` carries FORCE ROW LEVEL SECURITY with a policy of
 * `id = current_setting('app.tenant_id')::uuid` (M3-config/02-tenancy-fix.sql).
 * With no tenant set — which is the whole point of a CROSS-tenant read —
 * current_setting(..., true) is NULL and that policy matches zero rows for
 * this role. In production this function returns an empty array every time.
 * See HANDOFF.md for the fix this needs (a narrow, read-only, cross-tenant
 * role or view) and cron-sweep.js for the request-body fallback that lets the
 * sweep run against a named tenant list until that lands.
 */
export async function listTenantKeys() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT clerk_org_id AS tenant_key, name AS tenant_name
         FROM tenants
        WHERE clerk_org_id IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 500`
    );
    return rows;
  } catch (err) {
    console.error('listTenantKeys: cross-tenant read blocked or failed:', err?.message);
    return [];
  } finally {
    client.release();
  }
}

const EXPORT_ROW_CAP = 5000;

function capped(rows) {
  return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP };
}

/**
 * Everything a tenant is entitled to see about their own data, as one JSON
 * structure. storage_key is deliberately excluded from `documents` — it is an
 * internal R2 object key, not tenant-facing data, and handing it out would
 * leak the bucket's internal layout for no benefit to the tenant reading
 * their own export.
 *
 * Row-capped per table (EXPORT_ROW_CAP, +1 fetched so "was this truncated"
 * doesn't need a second COUNT(*) query) with a top-level `truncated` flag —
 * an export is a debugging/compliance tool, not a backup mechanism, and an
 * unbounded query here against a large tenant would be the next stuck-document
 * incident.
 */
export async function exportTenant(ctx) {
  return withTenant(ctx, async (client) => {
    const { rows: docCols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'documents' AND column_name <> 'storage_key'
        ORDER BY ordinal_position`
    );
    const docColList = docCols.map((c) => `"${c.column_name}"`).join(', ');

    const documents = capped(
      (await client.query(
        `SELECT ${docColList} FROM documents WHERE ${TENANT} ORDER BY created_at LIMIT $1`,
        [EXPORT_ROW_CAP + 1]
      )).rows
    );
    const pages = capped(
      (await client.query(
        `SELECT id, document_id, page_no, text, created_at FROM document_pages
          WHERE ${TENANT} ORDER BY created_at LIMIT $1`,
        [EXPORT_ROW_CAP + 1]
      )).rows
    );
    const extractions = capped(
      (await client.query(
        `SELECT * FROM extractions WHERE ${TENANT} ORDER BY created_at LIMIT $1`,
        [EXPORT_ROW_CAP + 1]
      )).rows
    );
    const entities = capped(
      (await client.query(
        `SELECT * FROM entities WHERE ${TENANT} ORDER BY created_at LIMIT $1`,
        [EXPORT_ROW_CAP + 1]
      )).rows
    );
    const audit_log = capped(
      (await client.query(
        `SELECT * FROM audit_log WHERE ${TENANT} ORDER BY created_at LIMIT $1`,
        [EXPORT_ROW_CAP + 1]
      )).rows
    );

    // `links` does not exist in this schema today (M3-config/01..06 define no
    // such table) — checked at read time, from information_schema, rather
    // than assumed, so this export keeps working unchanged the day one is
    // added, and never queries a table that isn't there.
    const { rows: linksTable } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'links'`
    );
    let links;
    if (linksTable.length) {
      const { rows: hasTenantCol } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'links' AND column_name = 'tenant_id'`
      );
      const { rows } = hasTenantCol.length
        ? await client.query(`SELECT * FROM links WHERE ${TENANT} LIMIT $1`, [EXPORT_ROW_CAP + 1])
        : await client.query(`SELECT * FROM links LIMIT $1`, [EXPORT_ROW_CAP + 1]);
      links = capped(rows);
    }

    const truncated =
      documents.truncated || pages.truncated || extractions.truncated ||
      entities.truncated || audit_log.truncated || Boolean(links?.truncated);

    const out = {
      tenantKey: ctx.tenantKey,
      exportedAt: new Date().toISOString(),
      documents: documents.rows,
      pages: pages.rows,
      extractions: extractions.rows,
      entities: entities.rows,
      audit_log: audit_log.rows,
      truncated,
    };
    if (links) out.links = links.rows;
    // FINANCIALS layer (M3-config/22): the owner's invoice/quote/PO/agreement numbers are their data too.
    // Included only when the table exists, so an export before the migration is byte-for-byte what it was.
    const { rows: finTable } = await client.query(`SELECT to_regclass('public.document_financials') IS NOT NULL AS ok`);
    if (finTable[0]?.ok) {
      out.financials = (await client.query(`SELECT * FROM document_financials WHERE ${TENANT} ORDER BY created_at LIMIT $1`, [EXPORT_ROW_CAP])).rows;
      out.financial_lines = (await client.query(`SELECT * FROM document_financial_lines WHERE ${TENANT} ORDER BY financial_id, line_no LIMIT $1`, [EXPORT_ROW_CAP])).rows;
    }
    return out;
  });
}

/**
 * FK-safe delete order for a tenant's content tables, child-before-parent, as
 * a pure exported constant — see scripts/verify-ops.mjs, which asserts this
 * order against the FK graph in M3-config/01-create-schema.sql rather than
 * trusting it by inspection alone.
 *
 * Derived from the schema's actual foreign keys:
 *   - extractions.document_id  -> documents  (CASCADE) — delete before documents
 *   - extractions.source_facet_id -> facets  (SET NULL) — delete before facets
 *     anyway, so the SET NULL trigger never has anything left to act on
 *   - document_pages.document_id -> documents (CASCADE) — delete before documents
 *   - facets.document_id       -> documents  (CASCADE) — delete before documents
 *   - entities.customer_id     -> entities   (SET NULL, self-referential) —
 *     order-independent; a single DELETE handles all of a tenant's rows
 *   - proposals, schema_versions, audit_log -> tenants only (CASCADE) — no
 *     dependency on the document tree, safe at the end
 *
 * `tenants` is deliberately NOT in this list. This function
 * erases a tenant's DATA — the promise the marketing page makes ("export and
 * delete your data") — not the tenant's account or its Clerk-backed sign-in,
 * which this codebase does not own the lifecycle of. tenant_id stays valid
 * (resolve_tenant() still resolves it) so the account can keep operating on
 * an empty slate, or be followed up with an account-level deprovisioning step
 * elsewhere if that is ever wanted.
 */
export const DELETE_ORDER = Object.freeze([
  'extractions',
  'facets',
  'document_pages',
  'documents',
  'proposals',
  'schema_versions',
  'entities',
  'audit_log',
  // These three have no incoming FKs (or only ON DELETE SET NULL ones), so
  // their position does not matter — but their PRESENCE does. The tenants row
  // itself is deliberately kept (resolve_tenant must keep working), which
  // means the ON DELETE CASCADE from these tables never fires. Without them
  // here, a "delete all my data" request left every member's email address
  // and every API key's metadata behind. That is not deleting all the data.
  'users',
  'api_keys',
  'usage_counters',
  'document_entity_links',
]);

/**
 * Delete every row belonging to a tenant, in FK-safe order, inside one
 * transaction. Returns the storage_keys those documents pointed at so the
 * CALLER can delete them from R2 — deliberately AFTER this commits; see
 * tenant-delete.js for why that ordering matters.
 */
export async function deleteTenantData(ctx) {
  return withTenant(ctx, async (client, tenantId) => {
    const { rows: docRows } = await client.query(
      `SELECT storage_key FROM documents WHERE tenant_id = $1 AND storage_key IS NOT NULL`,
      [tenantId]
    );
    const storageKeys = docRows.map((r) => r.storage_key);

    const counts = {};
    for (const table of DELETE_ORDER) {
      // Tables from later migrations (users' constraint changes, api_keys,
      // usage_counters, document_entity_links) may not exist on a database
      // that has not run them yet. A missing table is zero rows, not a reason
      // to abort a deletion that has already removed the documents.
      const { rows: present } = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      if (!present.length) { counts[table] = 0; continue; }
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      counts[table] = rowCount;
    }

    return { tenantId, storageKeys, counts };
  });
}

/**
 * The one row a tenant-data deletion is allowed to leave behind — see
 * M3-config/09-ops.sql. Written in its own transaction, separately from
 * deleteTenantData, so a failure recording the confirmation can never roll
 * back a deletion that already succeeded (or vice versa: the deletion is the
 * one-way door, not this receipt).
 */
export async function recordTenantDeletion(ctx, { documents, objects, failedObjects }) {
  return withTenant(ctx, async (client, tenantId) => {
    await client.query(
      `INSERT INTO tenant_deletions (tenant_id, tenant_key, documents, objects, failed_objects)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, ctx.tenantKey, documents, objects, JSON.stringify(failedObjects ?? [])]
    );
  });
}
