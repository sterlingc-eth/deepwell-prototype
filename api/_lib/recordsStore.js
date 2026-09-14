/**
 * Postgres records store.
 *
 * Lives in api/_lib/ as plain JS on purpose. The previous implementation was
 * imported from ../src/services/postgresRecordsStore, outside the function's
 * own directory — Vercel bundles each function from its folder, so that module
 * was never shipped and every request died with ERR_MODULE_NOT_FOUND before a
 * line of handler code ran.
 *
 * Isolation model, matching M3-config/02-tenancy-fix.sql:
 *   - connect as a NON-OWNER role with NOBYPASSRLS (deepwell_rls)
 *   - every request runs in its own transaction
 *   - `SET LOCAL app.tenant_id` scopes RLS to that transaction only, so a warm
 *     serverless instance can never leak one request's tenant into the next
 *   - resolve_tenant() maps a Clerk org id (a string) to the tenant uuid; it is
 *     SECURITY DEFINER because the caller cannot read `tenants` until the
 *     context is set, which is the chicken-and-egg this solves
 *   - by-id reads and updates ALSO carry an explicit tenant predicate. RLS
 *     should make that redundant; it is here so a future `NO FORCE` or a
 *     platform role with BYPASSRLS cannot silently open a cross-tenant read.
 */
import pg from 'pg';

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.NEON_CONNECTION_STRING;
    if (!connectionString) throw new Error('NEON_CONNECTION_STRING is not set');
    pool = new pg.Pool({
      connectionString,
      max: 3,                       // serverless: keep well under Neon's pooler limits
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

const TENANT = 'tenant_id = (current_setting(\'app.tenant_id\', true))::uuid';

/**
 * Run `fn` inside a transaction scoped to the caller's tenant.
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {(store: ReturnType<typeof makeStore>) => Promise<any>} fn
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
    // `true` = SET LOCAL: reverts on COMMIT/ROLLBACK, never outlives the request.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const result = await fn(makeStore(client, tenantId));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function makeStore(db, tenantId) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  const many = async (sql, params) => (await db.query(sql, params)).rows;

  /** Build "SET a=$2, b=$3" from an allowlist. Never interpolates caller keys. */
  const setClause = (updates, allowed, startAt = 2) => {
    const cols = Object.keys(updates).filter((k) => allowed.includes(k));
    const sets = cols.map((c, i) => `${c} = $${i + startAt}`);
    return { sets, values: cols.map((c) => updates[c]) };
  };

  const updater = (table, allowed) => async (id, updates) => {
    const { sets, values } = setClause(updates, allowed);
    if (!sets.length) return;
    await db.query(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND ${TENANT}`,
      [id, ...values]
    );
  };

  return {
    tenantId,

    // ---- documents ----
    createDocument: (d) => one(
      `INSERT INTO documents (tenant_id, batch_id, original_filename, document_type,
                              sha256_hash, file_size_bytes, stage, storage_key,
                              content_type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'received'),$8,$9,NOW())
       ON CONFLICT (tenant_id, sha256_hash) DO UPDATE
         SET storage_key = COALESCE(EXCLUDED.storage_key, documents.storage_key)
       RETURNING id`,
      [tenantId, d.batch_id ?? null, d.original_filename, d.document_type ?? null,
       d.sha256_hash, d.file_size_bytes ?? null, d.stage,
       d.storage_key ?? null, d.content_type ?? null]
    ),
    getDocument: (id) => one(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [id]),
    listDocuments: (f = {}) => {
      const where = [TENANT];
      const vals = [];
      for (const [k, col] of [['stage', 'stage'], ['document_type', 'document_type'], ['batch_id', 'batch_id']]) {
        if (f[k] != null) { vals.push(f[k]); where.push(`${col} = $${vals.length}`); }
      }
      return many(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, vals);
    },
    updateDocument: updater('documents', ['stage', 'document_type', 'processed_at', 'file_size_bytes', 'storage_key', 'content_type', 'page_count']),

    // ---- facets ----
    createFacet: (f) => one(
      `INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw, value_raw,
                           value_type_guess, confidence, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [tenantId, f.document_id, f.page_no ?? null, f.segment_id ?? null,
       f.label_raw, f.value_raw, f.value_type_guess ?? null, f.confidence ?? null]
    ),
    getFacet: (id) => one(`SELECT * FROM facets WHERE id = $1 AND ${TENANT}`, [id]),
    listFacetsByDocument: (documentId) =>
      many(`SELECT * FROM facets WHERE document_id = $1 AND ${TENANT} ORDER BY page_no, id`, [documentId]),
    updateFacet: updater('facets', ['mapped_entity_type', 'mapped_field_key', 'mapping_confidence', 'mapping_method', 'value_raw']),

    // ---- extractions ----
    createExtraction: (e) => one(
      `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                confidence, source_facet_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
      [tenantId, e.document_id, e.entity_id ?? null, e.field_key, e.value ?? null,
       e.confidence ?? null, e.source_facet_id ?? null]
    ),
    getExtraction: (id) => one(`SELECT * FROM extractions WHERE id = $1 AND ${TENANT}`, [id]),
    listExtractionsByDocument: (documentId) =>
      many(`SELECT * FROM extractions WHERE document_id = $1 AND ${TENANT} ORDER BY id`, [documentId]),
    listExtractionsByEntity: (entityId) =>
      many(`SELECT * FROM extractions WHERE entity_id = $1 AND ${TENANT} ORDER BY id`, [entityId]),
    updateExtraction: updater('extractions', ['value', 'confidence', 'entity_id']),

    // ---- entities ----
    createEntity: (e) => one(
      `INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id`,
      [tenantId, e.entity_type, e.data ?? {}]
    ),
    getEntity: (id) => one(`SELECT * FROM entities WHERE id = $1 AND ${TENANT}`, [id]),
    listEntities: (type) => type
      ? many(`SELECT * FROM entities WHERE entity_type = $1 AND ${TENANT} ORDER BY updated_at DESC LIMIT 500`, [type])
      : many(`SELECT * FROM entities WHERE ${TENANT} ORDER BY updated_at DESC LIMIT 500`, []),
    updateEntity: async (id, updates) => {
      if (updates.data === undefined) return;
      await db.query(
        `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
        [id, updates.data]
      );
    },

    // ---- proposals ----
    createProposal: (p) => one(
      `INSERT INTO proposals (tenant_id, kind, label, target_entity_type, target_field_key,
                              evidence, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'pending'),NOW()) RETURNING id`,
      [tenantId, p.kind, p.label, p.target_entity_type ?? null,
       p.target_field_key ?? null, p.evidence ?? {}, p.status]
    ),
    getProposal: (id) => one(`SELECT * FROM proposals WHERE id = $1 AND ${TENANT}`, [id]),
    listProposals: (status) => status
      ? many(`SELECT * FROM proposals WHERE status = $1 AND ${TENANT} ORDER BY created_at DESC`, [status])
      : many(`SELECT * FROM proposals WHERE ${TENANT} ORDER BY created_at DESC`, []),
    updateProposal: updater('proposals', ['status', 'resolved_at', 'resolved_by', 'label']),

    // ---- audit ----
    logAction: async (a) => {
      // audit_log.user_id is a uuid FK into `users`; the caller only has a
      // Clerk user id (a string like "user_2ab..."). Resolve it, and fall back
      // to NULL rather than failing the write — an audit row with an unknown
      // actor is worth more than no audit row.
      let userId = null;
      if (a.clerk_user_id) {
        const u = await one(
          `SELECT id FROM users WHERE clerk_user_id = $1 AND ${TENANT}`,
          [a.clerk_user_id]
        );
        userId = u?.id ?? null;
      }
      const changes = { ...(a.changes ?? {}) };
      if (!userId && a.clerk_user_id) changes.clerk_user_id = a.clerk_user_id;
      await db.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [tenantId, userId, a.action, a.resource_type ?? null,
         a.resource_id ?? null, changes]
      );
    },
    getAuditLog: (f = {}) => {
      const where = [TENANT];
      const vals = [];
      for (const k of ['action', 'resource_type', 'resource_id', 'user_id']) {
        if (f[k] != null) { vals.push(f[k]); where.push(`${k} = $${vals.length}`); }
      }
      return many(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, vals);
    },

    // ---- pages: what the documents actually say -------------------------
    //
    // This is the retrieval half of the system. R2 holds the bytes; these rows
    // hold the text plus a pointer back, so every answer can name the document
    // and page it came from.

    upsertPages: async (documentId, pages) => {
      // One statement, not one per page: a 40-page PDF should be one round trip.
      if (!pages?.length) return 0;
      const vals = [];
      const tuples = pages.map((pg, i) => {
        const b = i * 5;
        vals.push(tenantId, documentId, pg.page_no, pg.text ?? null, pg.r2_path ?? null);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      const r = await db.query(
        `INSERT INTO document_pages (tenant_id, document_id, page_no, text, r2_path)
         VALUES ${tuples.join(',')}
         ON CONFLICT (document_id, page_no)
         DO UPDATE SET text = EXCLUDED.text, r2_path = COALESCE(EXCLUDED.r2_path, document_pages.r2_path)`,
        vals
      );
      return r.rowCount;
    },

    listPages: (documentId) => many(
      `SELECT id, page_no, text, r2_path FROM document_pages
        WHERE document_id = $1 AND ${TENANT} ORDER BY page_no`, [documentId]
    ),

    /**
     * Find the passages that could answer `question`.
     *
     * Two passes on purpose. Full-text ranking is right for prose ("when was
     * the compressor replaced"), and wrong for identifiers — Postgres's english
     * config mangles "CG-4021-A" into tokens that rank badly or not at all, and
     * a serial number is the single most common thing an HVAC dispatcher asks
     * about. So identifier-shaped tokens get a separate trigram/ILIKE pass and
     * are merged in, deduplicated by page.
     *
     * Returns excerpts via ts_headline, not whole pages: a scanned page can be
     * 4 KB of text, and shipping 20 of them into a prompt is what made the old
     * client-side "send everything" approach cost what it did.
     */
    searchPassages: async (question, limit = 12) => {
      const rows = new Map();
      const push = (list, source) => {
        for (const r of list) if (!rows.has(r.id)) rows.set(r.id, { ...r, matched_by: source });
      };

      // OR, not AND. websearch_to_tsquery ANDs every term, so a real question
      // like "when does the warranty on the Whitmore Ave condenser expire"
      // matched nothing: the address is on page 1 and the warranty on page 2.
      // Building an OR query from the question's lexemes lets ts_rank_cd do the
      // work it is for — the page matching the most terms wins — instead of
      // requiring one page to contain all of them.
      const ftsSql = `
        WITH q AS (
          SELECT NULLIF(array_to_string(
                   tsvector_to_array(to_tsvector('english', $1)), ' | '
                 ), '')::tsquery AS tsq
        )
        SELECT p.id, p.document_id, p.page_no,
               d.original_filename, d.document_type,
               ts_headline('english', p.text, q.tsq,
                 'MaxFragments=2, MaxWords=55, MinWords=20, FragmentDelimiter=" … ", StartSel="", StopSel=""') AS excerpt,
               ts_rank_cd(p.tsv, q.tsq) AS rank
          FROM document_pages p
          JOIN documents d ON d.id = p.document_id
          CROSS JOIN q
         WHERE p.${TENANT} AND q.tsq IS NOT NULL AND p.tsv @@ q.tsq
         ORDER BY rank DESC
         LIMIT $2`;
      push((await db.query(ftsSql, [question, limit])).rows, 'text');

      // Identifier-shaped tokens: anything with a digit and some length.
      // "1234ABC", "CG-4021-A", "40x25x1", "2019" all qualify; "the" does not.
      const ids = [...new Set(
        (question.match(/[A-Za-z0-9][A-Za-z0-9/-]{3,}/g) ?? [])
          .filter((t) => /\d/.test(t))
      )].slice(0, 5);

      for (const token of ids) {
        const like = `%${token}%`;
        const r = await db.query(
          `SELECT p.id, p.document_id, p.page_no,
                  d.original_filename, d.document_type,
                  substring(p.text from greatest(1, position($2 in p.text) - 120) for 320) AS excerpt,
                  1.0 AS rank
             FROM document_pages p
             JOIN documents d ON d.id = p.document_id
            WHERE p.${TENANT} AND p.text ILIKE $1
            LIMIT 5`,
          [like, token]
        );
        push(r.rows, `identifier:${token}`);
      }

      return [...rows.values()].sort((a, b) => b.rank - a.rank).slice(0, limit);
    },

    /**
     * Structured facts the tenant already has mapped. Cheaper and far more
     * reliable than re-reading a page when the question is about a field the
     * pipeline has already extracted ("what's the model on unit 3").
     */
    searchExtractions: async (question, limit = 25) => {
      const tokens = [...new Set(
        (question.match(/[A-Za-z0-9][A-Za-z0-9/-]{3,}/g) ?? []).filter((t) => /\d/.test(t))
      )].slice(0, 5);
      if (!tokens.length) return [];
      return many(
        `SELECT x.id, x.document_id, x.entity_id, x.field_key, x.value, x.confidence,
                d.original_filename, e.entity_type, e.data
           FROM extractions x
           JOIN documents d ON d.id = x.document_id
      LEFT JOIN entities  e ON e.id = x.entity_id
          WHERE x.${TENANT} AND x.value ILIKE ANY($1::text[])
          LIMIT $2`,
        [tokens.map((t) => `%${t}%`), limit]
      );
    },

    markExtracted: async (documentId, { page_count, error } = {}) => {
      await db.query(
        `UPDATE documents
            SET extracted_at = CASE WHEN $3::text IS NULL THEN NOW() ELSE extracted_at END,
                extract_error = $3,
                page_count = COALESCE($2, page_count),
                stage = CASE WHEN $3::text IS NULL AND stage = 'received' THEN 'read' ELSE stage END
          WHERE id = $1 AND ${TENANT}`,
        [documentId, page_count ?? null, error ?? null]
      );
    },

    // ---- schema version ----
    getSchemaVersion: async () => {
      const r = await one(`SELECT version FROM schema_versions WHERE ${TENANT} ORDER BY version DESC LIMIT 1`, []);
      return r?.version ?? 1;
    },
    incrementSchemaVersion: async (description, changeKind) => {
      const r = await one(`SELECT version FROM schema_versions WHERE ${TENANT} ORDER BY version DESC LIMIT 1`, []);
      const next = (r?.version ?? 0) + 1;
      await db.query(
        `INSERT INTO schema_versions (tenant_id, version, change_kind, description, created_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [tenantId, next, changeKind ?? 'manual', description ?? null]
      );
      return next;
    },
  };
}
