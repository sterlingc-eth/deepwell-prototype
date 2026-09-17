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
 * Marks the facets this extractor owns, so a re-read replaces its own rows and
 * only its own. `mapping_method` would have been the natural home, but it
 * carries a CHECK constraint limited to registry/synonym/learned/human.
 */
export const FIELD_EXTRACT_SEGMENT = 'field-extract';

/**
 * Collapse whitespace and refuse a value that is only punctuation or
 * whitespace ("   ", "---", "—", "N/A" survives — it has letters, and whether
 * that's a real customer name is a data-quality problem the extractor should
 * catch, not this store). Used wherever customer-matching text is compared, so
 * "   " or "---" can never become a customer named "---".
 *
 * No length limit here on purpose: `extractFields.js` already caps a value at
 * 500 characters before it reaches this store, and equality comparison (never
 * ILIKE, never a functional index) is exactly as cheap on a 5-character string
 * as a 5,000-character one, so there is nothing here that needs defending by
 * truncating.
 *
 * Exported (with selectCustomerMatch below) purely so the customer-matching
 * decision can be unit tested without a database — see
 * scripts/verify-customer-link.mjs. Neither function touches `db`.
 */
/**
 * Serial values that identify nothing. Deliberately a small exact list rather
 * than a clever pattern: a real serial can look like almost anything, so
 * anything heuristic here risks discarding a genuine one. Compared after
 * lowercasing and collapsing every non-alphanumeric run to a single space.
 */
const PLACEHOLDER_SERIALS = new Set([
  'n a', 'na', 'none', 'no serial', 'no serial number', 'unknown', 'unk',
  'tbd', 'pending', 'illegible', 'unreadable', 'missing', 'not legible',
  'not readable', 'not available', 'nil', 'null', 'test', 'sample',
  'see photo', 'see above', 'see attached',
]);

export function isPlaceholderSerial(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return true;
  // The repeated-character test below is a backtracking regex: it overflows the
  // stack somewhere past a couple of million characters. normalizeFields caps
  // values at 500 chars today so nothing can reach that, but this function is
  // exported and a future bulk-import path would not go through that cap.
  // Returning false (not a placeholder) is the safe direction — a wrongly
  // rejected serial loses a unit's whole history.
  if (s.length > 200) return false;
  if (PLACEHOLDER_SERIALS.has(s)) return true;
  // A single repeated character once separators are gone ("-----", "0000",
  // "XXXX") is a filler mark on a form, not an identifier.
  const bare = s.replace(/ /g, '');
  if (/^(.)\1*$/.test(bare)) return true;
  return false;
}

/**
 * The only columns a generic update may touch on `documents`.
 *
 * Exported so a test can assert what is NOT here — `stage` and `storage_key`
 * are absent on purpose and their absence is a security boundary. The reasoning
 * is at the updateDocument call site.
 */
export const DOCUMENT_UPDATE_COLUMNS = Object.freeze([
  'document_type', 'processed_at', 'file_size_bytes', 'content_type', 'page_count',
]);

export function normalizeMatchText(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  // Unicode letters and numbers, not ASCII. The old test was /[A-Za-z0-9]/,
  // which meant a customer named Иванов, 王芳, محمد or Παπαδόπουλος normalized
  // to the empty string — and findOrCreateCustomer reads an empty string as
  // "this document names nobody", exactly as it reads "---" or "   ". So those
  // customers silently never got a record and their equipment was never linked
  // to them. Not an edge case: an ordinary customer list in most American
  // cities contains names this rejected, and it failed quietly every time.
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

/**
 * Given every existing customer whose name already matches (case-insensitive
 * — that filtering happens in SQL, findOrCreateCustomer's candidate query),
 * decide which one, if any, the incoming document is about.
 *
 * A candidate is disqualified only when it has an address ON FILE that
 * DISAGREES with the incoming one — a candidate with no address yet cannot
 * disagree, so it stays eligible. Exactly one eligible candidate is a match;
 * zero or several is treated as "don't know" and returns null, the same
 * "refuse rather than guess" rule as normalizeBrand() in warrantyRules.js.
 *
 * @param {{id: string, data: object}[]} candidates  same-name customer rows
 * @param {string} address  normalized incoming service_address, or '' if the
 *                          document did not state one
 * @returns {{id: string, data: object}|null}
 */
export function selectCustomerMatch(candidates, address) {
  if (!address) {
    // No address to disambiguate with. Only a single same-named candidate is
    // safe, and even that is a judgement call — see the header note.
    return candidates.length === 1 ? candidates[0] : null;
  }

  // The incoming document HAS an address, so require a positive match on it.
  //
  // This used to also accept a candidate with no address on file, on the
  // reasoning that it was probably the same person and we were just filling in
  // a blank. That is wrong often enough to matter: a customer whose first
  // document never captured an address (a phone quote, an informal ticket)
  // leaves a name-only row that then swallows the NEXT person of the same name,
  // and "Smith" is not rare. The result is one customer seeing another's
  // equipment and warranty dates, which this file calls a privacy defect
  // rather than an untidy table.
  //
  // The cost is real and accepted: the same person whose first document had no
  // address now gets a second customer row. That is a duplicate a human can see
  // and merge. A false merge is neither visible nor reversible.
  const eligible = candidates.filter((c) => {
    const existingAddr = normalizeMatchText(c.data?.service_address);
    return existingAddr && existingAddr.toLowerCase() === address.toLowerCase();
  });
  return eligible.length === 1 ? eligible[0] : null;
}

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
    // Cascades to document_pages, facets and extractions through their FKs.
    // The tenant predicate is belt-and-braces next to RLS: a delete that
    // silently crossed a tenant boundary is not a bug you find later.
    deleteDocument: async (id) => {
      const r = await db.query(`DELETE FROM documents WHERE id = $1 AND ${TENANT}`, [id]);
      return r.rowCount;
    },
    listDocuments: (f = {}) => {
      const where = [TENANT];
      const vals = [];
      for (const [k, col] of [['stage', 'stage'], ['document_type', 'document_type'], ['batch_id', 'batch_id']]) {
        if (f[k] != null) { vals.push(f[k]); where.push(`${col} = $${vals.length}`); }
      }
      return many(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, vals);
    },
    // `stage` and `storage_key` are DELIBERATELY NOT in this list, and that is
    // a security boundary rather than tidiness.
    //
    // api/records.ts hands `payload.updates` straight to this function, and
    // updater() allowlists column NAMES but never values. With `stage` here, an
    // authenticated caller could roll their own document backwards from
    // 'mapped' to 'received' — defeating the forward-only progression that
    // markExtracted and replaceDocumentFields carefully enforce everywhere else.
    //
    // `storage_key` was worse. This row is tenant-scoped, so a caller can only
    // update their OWN document — but the key it points at is not validated
    // against the tenant prefix anywhere, and getObject takes a bare key. Set
    // your own document's storage_key to another tenant's key, call
    // /api/read-document, and the pipeline fetches their bytes and transcribes
    // them into your account. A narrow primitive (it needs a known key) but a
    // real cross-tenant read, riding a column nobody meant to expose.
    //
    // Nothing legitimate loses anything: the only server-side caller of this
    // function writes document_type, and no client screen calls it at all.
    // Both columns are still written by the code that owns them —
    // markExtracted for stage, createDocument for storage_key.
    updateDocument: updater('documents', DOCUMENT_UPDATE_COLUMNS),

    /**
     * Clear a stale extraction error after a successful extraction.
     *
     * Deliberately its own function rather than a column added to the allowlist
     * above — see the note there. The asymmetry it fixes: extract_error is SET
     * by a failed extraction but was only ever CLEARED by a successful READ. So
     * a document that failed extraction once and then extracted fine on retry
     * kept its error forever, and the browser treats any extract_error as
     * terminal. The user was told a document had failed while looking at a row
     * that held all of its data.
     */
    clearExtractError: async (documentId) => {
      const r = await db.query(
        `UPDATE documents SET extract_error = NULL
          WHERE id = $1 AND ${TENANT} AND extract_error IS NOT NULL`,
        [documentId]
      );
      return r.rowCount;
    },

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

    /**
     * What the browser polls while ingestion runs in the queue.
     *
     * Reports the three things a progress row needs — did it finish, how many
     * pages, did it fail and why — plus how many fields came out, so a document
     * that read cleanly but yielded nothing is visibly different from one still
     * in flight.
     */
    getIngestStatus: (documentIds) => many(
      `SELECT d.id,
              d.original_filename,
              d.stage,
              d.page_count,
              d.extracted_at,
              d.extract_error,
              (SELECT count(*) FROM extractions x
                WHERE x.document_id = d.id AND x.${TENANT}) AS field_count
         FROM documents d
        WHERE d.id = ANY($1::uuid[]) AND d.${TENANT}`,
      [documentIds]
    ),

    // ---- structured field extraction ------------------------------------
    //
    // Two rows per field, on purpose. `facets` carries the raw observation and
    // the PAGE it was read from; `extractions` carries the canonical field_key
    // and points back at the facet through source_facet_id. `extractions` has
    // no page column, so without that hop a warranty date on the entity screen
    // would be a number with nothing behind it — the one thing this product
    // promises never to show.
    //
    // Replace, never append. Re-reading a document has to converge on one set
    // of fields rather than stacking a second copy on the first. The delete is
    // scoped by segment_id to this extractor's own rows, so a human correction
    // or another pipeline's facets are never swept away with it — and it runs
    // before the facet delete, because source_facet_id is ON DELETE SET NULL
    // and would otherwise erase the link the delete needs.
    //
    // Residual gap, deliberately left: if a facet is ever deleted by something
    // OTHER than this function, its extraction's source_facet_id becomes NULL
    // and no longer matches the IN (...) below, so that row survives every
    // future re-run. Nothing deletes facets independently today. The fix is a
    // marker column on `extractions`, not a wider delete here — widening it to
    // NULL source_facet_id would sweep away human-entered corrections, which is
    // a far worse failure than one stale row.

    replaceDocumentFields: async (documentId, fields, { entityId = null } = {}) => {
      const doc = await one(`SELECT id FROM documents WHERE id = $1 AND ${TENANT}`, [documentId]);
      if (!doc) throw new Error('Document not found');

      await db.query(
        `DELETE FROM extractions
          WHERE document_id = $1 AND ${TENANT}
            AND source_facet_id IN (
                  SELECT id FROM facets
                   WHERE document_id = $1 AND ${TENANT} AND segment_id = $2)`,
        [documentId, FIELD_EXTRACT_SEGMENT]
      );
      const delFacets = await db.query(
        `DELETE FROM facets WHERE document_id = $1 AND ${TENANT} AND segment_id = $2`,
        [documentId, FIELD_EXTRACT_SEGMENT]
      );

      // Advance the pipeline stage so the browser can tell "read but not yet
      // mapped" apart from "finished". Only ever forwards: a document a human
      // has already linked or verified must not be walked backwards by a
      // re-read.
      //
      // This runs BEFORE the empty-fields return, not only after the insert. A
      // document that genuinely states nothing extractable is a real answer,
      // and it HAS finished — if the stage only advanced on the insert path,
      // every such document would sit at 'read' forever and the browser, which
      // waits for 'mapped', would poll it until the timeout and then report a
      // failure on work that had actually succeeded.
      const advance = () => db.query(
        `UPDATE documents SET stage = 'mapped'
          WHERE id = $1 AND ${TENANT} AND stage IN ('received', 'read')`,
        [documentId]
      );

      if (!fields?.length) {
        await advance();
        return { facets: 0, extractions: 0, replaced: delFacets.rowCount };
      }

      // The CTE below joins each new extraction to its facet on
      // (mapped_field_key, value_raw). normalizeFields() already guarantees that
      // pair is unique, but the SQL does not enforce it: a duplicate would make
      // the join fan out and write N x N extraction rows with no error at all.
      // Fail loudly here rather than let a future caller corrupt the table.
      const seen = new Set();
      for (const f of fields) {
        const pair = `${f.field_key}\u0000${f.value}`;
        if (seen.has(pair)) {
          throw new Error(`Duplicate field ${f.field_key}="${f.value}" passed to replaceDocumentFields`);
        }
        seen.add(pair);
      }

      // One statement for the whole document. The CTE joins each new extraction
      // to its own facet on (mapped_field_key, value_raw), which is unique here
      // because normalizeFields() has already collapsed duplicates — relying on
      // RETURNING coming back in VALUES order would be relying on luck.
      const r = await db.query(
        `WITH input AS (
           SELECT * FROM unnest($3::text[], $4::text[], $5::int[], $6::numeric[], $7::text[])
                     AS t(field_key, value, page_no, confidence, verbatim)
         ), ins AS (
           INSERT INTO facets (tenant_id, document_id, page_no, segment_id, label_raw,
                               value_raw, confidence, mapped_field_key, mapping_method, created_at)
           SELECT $1, $2, i.page_no, $8, COALESCE(i.verbatim, i.field_key),
                  i.value, i.confidence, i.field_key, 'registry', NOW()
             FROM input i
           RETURNING id, mapped_field_key, value_raw
         )
         INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value,
                                  confidence, source_facet_id, created_at)
         SELECT $1, $2, $9, i.field_key, i.value, i.confidence, ins.id, NOW()
           FROM input i
           JOIN ins ON ins.mapped_field_key = i.field_key AND ins.value_raw = i.value
         RETURNING id`,
        [
          tenantId,
          documentId,
          fields.map((f) => f.field_key),
          fields.map((f) => f.value),
          fields.map((f) => f.page_no ?? null),
          fields.map((f) => f.confidence ?? null),
          fields.map((f) => f.verbatim ?? null),
          FIELD_EXTRACT_SEGMENT,
          entityId,
        ]
      );

      await advance();

      return { facets: fields.length, extractions: r.rowCount, replaced: delFacets.rowCount };
    },

    /**
     * The equipment this document is about, created if this is the first time
     * we have seen its serial.
     *
     * Serial number is the key because it is the only identifier an HVAC office
     * can be relied on to have: model numbers repeat across a fleet, addresses
     * change hands, and internal unit labels ("Unit 3") are only unique inside
     * one building. Returns null without one rather than inventing an entity.
     *
     * Merge is fill-only: a field already on the entity is never overwritten by
     * a later read. A blurry photo of a plate must not be able to clobber a
     * value a human already confirmed.
     */
    findOrCreateEquipment: async (facts) => {
      const serial = String(facts?.serial_number ?? '').trim();
      if (!serial) return null;
      // A placeholder is not an identity. "N/A" on an illegible nameplate is a
      // technician saying "I could not read this", and matching on it merges
      // every unreadable plate in the account into one entity — a Carrier
      // furnace and a Trane condenser at different addresses becoming a single
      // unit carrying one of their warranties. Treated the same as no serial.
      if (isPlaceholderSerial(serial)) return null;

      const incoming = {};
      // `warranty_expires` is deliberately NOT copied here. The warranty lives
      // in data.warranty, written by setEquipmentWarranty, which carries the
      // expiry together with whether it was printed or computed. Keeping a
      // second flat copy meant a fill-once field (never updated) sitting beside
      // a field rewritten on every extraction — two answers to the same
      // question on one row, guaranteed to disagree eventually.
      for (const k of ['serial_number', 'model', 'manufacturer', 'equipment_type',
                       'tonnage', 'refrigerant', 'service_address', 'customer_name',
                       'installation_date']) {
        const v = String(facts?.[k] ?? '').trim();
        if (v) incoming[k] = v;
      }

      const existing = await one(
        `SELECT id, data FROM entities
          WHERE entity_type = 'equipment' AND ${TENANT}
            AND lower(data->>'serial_number') = lower($1)
          ORDER BY created_at LIMIT 1`,
        [serial]
      );

      if (!existing) {
        const created = await one(
          `INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at)
           VALUES ($1,'equipment',$2,NOW(),NOW()) RETURNING id`,
          [tenantId, incoming]
        );
        return { id: created.id, created: true, data: incoming };
      }

      const data = { ...(existing.data ?? {}) };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (data[k] == null || String(data[k]).trim() === '') { data[k] = v; changed = true; }
      }
      if (changed) {
        await db.query(
          `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
          [existing.id, data]
        );
      }
      // `data` goes back to the caller so warranty derivation can see what the
      // entity already knows. Without it, a service ticket that names no
      // manufacturer derives an EMPTY warranty and overwrites a correct one.
      return { id: existing.id, created: false, data };
    },

    // ---- customers ----------------------------------------------------
    //
    // See M3-config/05-customer-link.sql for the other half of this: the
    // entities.customer_id column, and the trigger that stops it pointing
    // anywhere but a customer row in the SAME tenant. A CHECK constraint can
    // enforce the single-row part of that (customer_id only on an equipment
    // row); it cannot look up the target row to check its type and tenant,
    // so that part is a trigger, not written here.

    /**
     * Find-or-create the customer a document is about.
     *
     * There is no serial-number equivalent for a person. `customer_name` is
     * free text off an invoice or work order, and two people can share a name
     * the way no two units share a serial. So identity here is INFERRED, not
     * read off a plate, and the rule is built to fail toward MORE customer
     * rows rather than merging two different people into one — a customer
     * record that quietly carries someone else's equipment (and someone
     * else's warranty status) is a privacy problem, not just an untidy table.
     *
     * MATCHING KEY: normalized customer_name, narrowed by service_address
     * when both the incoming document and a same-named candidate have one.
     *
     *   1. Collect every existing customer whose name matches, case-
     *      insensitively, with whitespace collapsed.
     *   2. If the incoming document states an address, drop any candidate
     *      that already has a DIFFERENT address on file. A candidate with no
     *      address yet is kept — nothing on it disagrees with this document.
     *   3. Exactly one candidate left -> that's the customer; a fill-only
     *      merge backfills whatever it was missing, same rule as
     *      findOrCreateEquipment: a value already there is never overwritten.
     *      Zero, or more than one, candidate left -> create a new customer
     *      instead of guessing. Two-or-more IS the "two Smiths" case this
     *      function must not merge through; a duplicate row a human can
     *      merge later is a far smaller defect than showing one customer
     *      another's equipment.
     *
     * KNOWN LIMITATIONS — accepted trade-offs, not bugs:
     *   - Two genuinely different customers with the SAME name at the SAME
     *     address (a duplex, or a parent and child at one house) will merge.
     *     Nothing in the documents this pipeline reads can tell them apart.
     *   - One real customer whose documents spell their address two
     *     different ways ("123 Main St" vs "123 Main Street") gets a second
     *     customer row instead of being recognized as the same person.
     *     Chosen on purpose: fragmentation is a visible, fixable annoyance;
     *     a false merge is a silent leak between two customers.
     *   - A customer with equipment at several real addresses (a landlord, an
     *     HOA) is created once per address for the same reason — this
     *     function has no signal that would tell "one customer, several
     *     properties" apart from "two customers who happen to share a name".
     *   - Candidate lookup is capped at 200 same-named rows (LIMIT below). A
     *     tenant with more than 200 customers sharing one exact name — not a
     *     real HVAC office — degrades to "always create new" for that name,
     *     which is the same safe fallback as a genuine ambiguous match.
     *
     * Returns null, not a fabricated customer, when the document names
     * nobody — including a name that is only whitespace or punctuation
     * ("—", "...", "   ").
     */
    findOrCreateCustomer: async (facts) => {
      const name = normalizeMatchText(facts?.customer_name);
      if (!name) return null;
      const address = normalizeMatchText(facts?.service_address);

      const incoming = {};
      for (const k of ['customer_name', 'service_address']) {
        const v = String(facts?.[k] ?? '').trim();
        if (v) incoming[k] = v;
      }

      const candidates = await many(
        `SELECT id, data FROM entities
          WHERE entity_type = 'customer' AND ${TENANT}
            AND lower(data->>'customer_name') = lower($1)
          ORDER BY created_at LIMIT 200`,
        [name]
      );

      const existing = selectCustomerMatch(candidates, address);

      if (!existing) {
        const created = await one(
          `INSERT INTO entities (tenant_id, entity_type, data, created_at, updated_at)
           VALUES ($1,'customer',$2,NOW(),NOW()) RETURNING id`,
          [tenantId, incoming]
        );
        return { id: created.id, created: true };
      }

      const data = { ...(existing.data ?? {}) };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (data[k] == null || String(data[k]).trim() === '') { data[k] = v; changed = true; }
      }
      if (changed) {
        await db.query(
          `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
          [existing.id, data]
        );
      }
      return { id: existing.id, created: false };
    },

    /**
     * Link equipment to the customer a document said it belongs to.
     *
     * Fill-only, same principle as everywhere else in this file: it links
     * only when the equipment has NO customer yet (`customer_id IS NULL` is
     * part of the WHERE, not a separate read-then-write — one round trip, no
     * race between checking and setting). A later document naming a
     * different customer for the same serial — an OCR misread, or two
     * different customers' paperwork scanned into the same batch — does not
     * silently move the unit to someone else. Reassigning an already-linked
     * unit (a genuine resale) is a deliberate action this store does not
     * perform on the strength of one more document; it would need an
     * explicit admin action, out of scope here.
     *
     * Returns the row count (0 or 1) so a caller can tell "already linked,
     * no-op" apart from a real link — 0 is not an error.
     */
    setEquipmentCustomer: async (equipmentId, customerId) => {
      if (!equipmentId || !customerId) return 0;
      const r = await db.query(
        `UPDATE entities
            SET customer_id = $2, updated_at = NOW()
          WHERE id = $1 AND entity_type = 'equipment' AND customer_id IS NULL AND ${TENANT}`,
        [equipmentId, customerId]
      );
      return r.rowCount;
    },

    /**
     * Everything a customer screen needs in one query: each of the
     * customer's units together with the warranty state already computed and
     * stored on it (data->'warranty' — see setEquipmentWarranty). No join
     * back to `extractions` here on purpose: that table answers "what did
     * the paperwork say"; this answers "what units does this customer have
     * and is any of them due for something", which is exactly what already
     * lives on the equipment row.
     *
     * The TENANT predicate is the only tenancy check this needs. It is not
     * possible for an equipment row in tenant A to carry a customer_id
     * belonging to tenant B — the trigger in 05-customer-link.sql refuses
     * that at write time — so a caller cannot fish for another tenant's
     * equipment by guessing a foreign customerId: the WHERE below only ever
     * matches rows already confined to the caller's own tenant.
     */
    listCustomerEquipment: (customerId) => many(
      `SELECT id,
              data->>'serial_number'   AS serial_number,
              data->>'model'           AS model,
              data->>'manufacturer'    AS manufacturer,
              data->>'equipment_type'  AS equipment_type,
              data->>'service_address' AS service_address,
              data->'warranty'         AS warranty,
              updated_at
         FROM entities
        WHERE entity_type = 'equipment' AND customer_id = $1 AND ${TENANT}
        ORDER BY updated_at DESC`,
      [customerId]
    ),

    // ---- warranty ---------------------------------------------------------
    //
    // The derivation lives on the equipment entity, NOT in `extractions`.
    // `extractions` is the table of things a page actually said, and every row
    // in it points back at a facet and a page number. A computed expiry has no
    // page behind it, so putting it there would quietly turn arithmetic into a
    // citation — the exact failure this product exists to avoid.
    //
    // Only stable values are stored: dates, term length, and whether the expiry
    // was printed or calculated. Never day counts. "19 days left to register"
    // is true for one day; storing it would mean every row is wrong by
    // tomorrow. Urgency is computed at read time from the dates below.

    setEquipmentWarranty: async (entityId, warranty) => {
      if (!entityId) return 0;
      const r = await db.query(
        `UPDATE entities
            SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('warranty', $2::jsonb),
                updated_at = NOW()
          WHERE id = $1 AND entity_type = 'equipment' AND ${TENANT}`,
        [entityId, JSON.stringify(warranty ?? {})]
      );
      return r.rowCount;
    },

    /**
     * The units that need someone to do something, soonest first.
     *
     * Two populations in one pass:
     *   - registration deadline near or recently past, with nothing on file
     *     saying it was registered. This is the urgent one: the window is
     *     around 60 days from installation and missing it costs the homeowner
     *     five years of parts coverage.
     *   - parts warranty approaching its end, which is when an extended
     *     warranty is worth selling.
     *
     * All bounds are computed by the caller and passed as plain strings.
     * Comparisons are TEXT comparisons on ISO dates, which sort chronologically
     * — deliberately not a ::date cast, because a cast raises on any malformed
     * value and would turn one bad row into a 500 for the whole list.
     */
    listWarrantyAttention: ({ registerFrom, registerTo, expiringFrom, expiringTo, limit = 200 }) => many(
      `SELECT e.id,
              e.data->'warranty'            AS warranty,
              e.data->>'serial_number'      AS serial_number,
              e.data->>'model'              AS model,
              e.data->>'manufacturer'       AS manufacturer,
              e.data->>'service_address'    AS service_address,
              e.data->>'customer_name'      AS customer_name,
              e.data->'warranty'->>'registrationDeadline' AS registration_deadline,
              e.data->'warranty'->>'expires'              AS expires
         FROM entities e
        WHERE e.entity_type = 'equipment' AND e.${TENANT}
          AND (
                (    e.data->'warranty'->>'registrationOnFile' IS NULL
                 AND e.data->'warranty'->>'registrationDeadline' BETWEEN $1 AND $2 )
             OR (    e.data->'warranty'->>'expires' BETWEEN $3 AND $4 )
          )
        ORDER BY COALESCE(
                   e.data->'warranty'->>'registrationDeadline',
                   e.data->'warranty'->>'expires'
                 )
        LIMIT $5`,
      [registerFrom, registerTo, expiringFrom, expiringTo, limit]
    ),

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
