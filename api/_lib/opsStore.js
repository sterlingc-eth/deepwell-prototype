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
 *      needs to step around: exportTenant reads whole rows across seven
 *      tables (plus financials when present), and deleteTenantData deletes
 *      across eight. Bolting that onto
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
import { serializeClient, assertTenantUuid } from './util/pgClient.js';
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
  const client = serializeClient(await getPool().connect());
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    const tenantId = rows[0].id;
    // `true` = SET LOCAL: reverts on COMMIT/ROLLBACK, never outlives this request.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [assertTenantUuid(tenantId)]);

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
 * WHY A PLAIN `SELECT ... FROM tenants` CANNOT WORK: the application connects
 * as `deepwell_rls`, which is NOBYPASSRLS (M3-config/01b-app-role.sql), and
 * `tenants` carries FORCE ROW LEVEL SECURITY with a policy of
 * `id = current_setting('app.tenant_id')::uuid` (M3-config/02-tenancy-fix.sql).
 * With no tenant set — the whole point of a CROSS-tenant read —
 * current_setting(..., true) is NULL and that policy matches zero rows.
 *
 * THE FIX (M3-config/60-list-all-tenant-keys.sql): list_all_tenant_keys(), a
 * narrow SECURITY DEFINER function returning ONLY (tenant_id, tenant_key) —
 * identifiers, no names/plans/settings/content. This function calls it first
 * and only falls back to the old direct read (empty under FORCE RLS in
 * production, but correct on a database without RLS) when the function is
 * absent or errors — so the API keeps working before the SQL is pasted.
 *
 * `source` says which path answered ('definer' | 'fallback' | 'none') so the
 * sweep summary can report it instead of silently visiting nobody.
 */
export async function listTenantKeysWithSource() {
  const client = serializeClient(await getPool().connect());
  try {
    try {
      const { rows } = await client.query(
        `SELECT tenant_key FROM list_all_tenant_keys() WHERE tenant_key IS NOT NULL`
      );
      // tenant_name is intentionally not returned by the function; the key doubles as the name
      // (resolve_tenant() only uses the name when it has to create a row, which it never does here).
      return { source: 'definer', tenants: rows.map((r) => ({ tenant_key: r.tenant_key, tenant_name: r.tenant_key })) };
    } catch (err) {
      console.error('listTenantKeys: list_all_tenant_keys() unavailable, falling back to a direct read (run M3-config/60):', err?.message);
    }
    try {
      const { rows } = await client.query(
        `SELECT clerk_org_id AS tenant_key, name AS tenant_name
           FROM tenants
          WHERE clerk_org_id IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 500`
      );
      return { source: 'fallback', tenants: rows };
    } catch (err) {
      console.error('listTenantKeys: cross-tenant read blocked or failed:', err?.message);
      return { source: 'none', tenants: [] };
    }
  } finally {
    client.release();
  }
}

export async function listTenantKeys() {
  return (await listTenantKeysWithSource()).tenants;
}

/* ------------------------------------------------------------------ export */
//
// The export used to be ONE query per table capped at 5,000 rows with a `truncated` flag: a 20,000-document
// shop got a silently incomplete file. It now PAGES every table by keyset (created_at, id) — one short
// tenant-scoped transaction per page, EXPORT_PAGE_SIZE rows each — and the route STREAMS the JSON to the client
// as the pages arrive, so neither the function's memory nor a single query grows with the tenant.
//
// Time budget: the caller passes a deadline (the route uses 240 s of the 300 s function ceiling). If it is hit
// the export ends cleanly with `truncated: true` and `incomplete: { key, after }`; POSTing that back as
// `{ resume: { key, after } }` continues from exactly that row. Nothing is silently dropped.
//
// ORIGINAL FILES: the bytes live in R2 and are NOT embedded. `manifest.originals` lists every document that has a
// stored original (document id, filename, sha256, size) and how to fetch each one on demand with a short-lived
// signed link (POST /api/upload-url { mode: "get", documentId }). No URL, key or secret is written into the
// export — a link embedded in a file would either expire or have to be long-lived.

export const EXPORT_PAGE_SIZE = 1000;
/** Time the route gives the export before it ends cleanly and offers `resume` (function ceiling is 300 s). */
export const EXPORT_TIME_BUDGET_MS = 240_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** [outputKey, table, select-list] — order is FK-friendly for an importer (parents before children). */
const EXPORT_SECTIONS = Object.freeze([
  { key: 'documents', table: 'documents' },
  { key: 'pages', table: 'document_pages', select: 'id, document_id, page_no, text, created_at' },
  { key: 'extractions', table: 'extractions' },
  { key: 'entities', table: 'entities' },
  // document_entity_links: which customer/unit each document belongs to — every deterministic (no-model)
  // answerer that groups documents by customer joins through it, so an export without it cannot reproduce
  // those answers offline (2026-09 offline-exam build).
  { key: 'document_entity_links', table: 'document_entity_links' },
  // facets: raw OCR segments each extraction was mapped from; the source `extractions.source_facet_id`
  // points at, included so that foreign key does not dangle.
  { key: 'facets', table: 'facets' },
  { key: 'audit_log', table: 'audit_log' },
  // `links` does not exist in this schema today; included only if a future migration adds it.
  { key: 'links', table: 'links', optional: true },
  // FINANCIALS layer (M3-config/22): the owner's invoice/quote/PO/agreement numbers are their data too.
  { key: 'financials', table: 'document_financials', optional: true },
  { key: 'financial_lines', table: 'document_financial_lines', optional: true },
]);

/** The section keys, for the route's `resume` validation. */
export const EXPORT_SECTION_KEYS = Object.freeze(EXPORT_SECTIONS.map((x) => x.key));

/** Validate a client-supplied resume token; returns a clean {key, after} or null. */
export function parseExportResume(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { key, after } = raw;
  if (typeof key !== 'string' || !EXPORT_SECTION_KEYS.includes(key)) return null;
  if (after == null) return { key, after: null };
  if (typeof after !== 'object' || typeof after.id !== 'string' || !UUID_RE.test(after.id)) return null;
  const c = after.c ?? null;
  if (c !== null && (typeof c !== 'string' || c.length > 64 || !/^[0-9T:.+\- Z]+$/.test(c))) return null;
  return { key, after: { c, id: after.id } };
}

/**
 * One keyset page for a section. Rows carry `__c` (created_at as text, microsecond-exact; null for tables with no
 * created_at) and `__id` for the cursor. Tables that have created_at page by (created_at, id) — the order the
 * export always used, parents before children — and the few that do not (document_financial_lines) page by id.
 */
async function fetchExportPage(ctx, spec, cols, cursor, pageSize, byCreated) {
  return withTenant(ctx, async (client) => {
    if (!byCreated) {
      const { rows } = await client.query(
        `SELECT ${cols}, NULL::text AS "__c", id::text AS "__id"
           FROM ${spec.table}
          WHERE ${TENANT} AND (NOT $1::boolean OR id > $2::uuid)
          ORDER BY id ASC
          LIMIT $3`,
        [Boolean(cursor), cursor?.id ?? '00000000-0000-0000-0000-000000000000', pageSize]
      );
      return rows;
    }
    const { rows } = await client.query(
      `SELECT ${cols}, created_at::text AS "__c", id::text AS "__id"
         FROM ${spec.table}
        WHERE ${TENANT}
          AND ( NOT $1::boolean
             OR ($2::text IS NOT NULL AND (created_at > $2::timestamptz
                                          OR (created_at = $2::timestamptz AND id > $3::uuid)
                                          OR created_at IS NULL))
             OR ($2::text IS NULL AND created_at IS NULL AND id > $3::uuid) )
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT $4`,
      [Boolean(cursor), cursor?.c ?? null, cursor?.id ?? '00000000-0000-0000-0000-000000000000', pageSize]
    );
    return rows;
  });
}

/**
 * Async generator over the whole export. Events:
 *   { event: 'start', key } / { event: 'rows', key, rows, cursor } / { event: 'end', key }
 *   { event: 'summary', truncated, incomplete, counts, manifest }   (always last)
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{pageSize?: number, shouldStop?: () => boolean, resume?: {key: string, after: {c: string|null, id: string}|null}|null}} [opts]
 */
export async function* exportEvents(ctx, opts = {}) {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? EXPORT_PAGE_SIZE, 5000));
  const shouldStop = opts.shouldStop ?? (() => false);
  const resume = opts.resume ?? null;

  // Which optional tables exist, and documents' column list (storage_key is an internal R2 key: never exported).
  const meta = await withTenant(ctx, async (client) => {
    const { rows: docCols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'documents' AND column_name <> 'storage_key'
        ORDER BY ordinal_position`
    );
    const { rows: present } = await client.query(
      `SELECT c.relname AS t,
              bool_or(a.attname = 'tenant_id') AS has_tenant,
              bool_or(a.attname = 'created_at') AS has_created,
              bool_or(a.attname = 'id') AS has_id
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
        GROUP BY c.relname`,
      [EXPORT_SECTIONS.map((x) => x.table)]
    );
    return { docCols: docCols.map((c) => `"${c.column_name}"`).join(', '), present: new Map(present.map((r) => [r.t, r])) };
  });

  const counts = {};
  const originals = [];
  let incomplete = null;
  const resumeIdx = resume ? EXPORT_SECTION_KEYS.indexOf(resume.key) : -1;

  for (const [idx, spec] of EXPORT_SECTIONS.entries()) {
    const probe = meta.present.get(spec.table);
    if (spec.optional && (!probe || !probe.has_tenant || !probe.has_id)) continue; // absent (or not exportable): not part of the file
    const byCreated = Boolean(probe?.has_created);
    yield { event: 'start', key: spec.key };
    counts[spec.key] = 0;
    // Sections before the resume point were delivered by the earlier file; after an interruption, later
    // sections are empty in this file and are listed in `incomplete` for the follow-up.
    if (idx < resumeIdx || incomplete) {
      yield { event: 'end', key: spec.key };
      continue;
    }
    let cursor = resume && idx === resumeIdx ? resume.after : null;
    const cols = spec.key === 'documents'
      ? `${meta.docCols}, (storage_key IS NOT NULL) AS "__has_original"`
      : (spec.select ?? '*');
    for (;;) {
      if (shouldStop()) { incomplete = { key: spec.key, after: cursor }; break; }
      const page = await fetchExportPage(ctx, spec, cols, cursor, pageSize, byCreated);
      if (!page.length) break;
      const last = page[page.length - 1];
      cursor = { c: last.__c ?? null, id: last.__id };
      const rows = page.map((r) => {
        const { __c, __id, __has_original, ...rest } = r;
        if (spec.key === 'documents' && __has_original) {
          originals.push({
            documentId: rest.id,
            filename: rest.original_filename ?? null,
            displayName: rest.display_name ?? null,
            sha256: rest.sha256_hash ?? null,
            sizeBytes: rest.file_size_bytes ?? null,
          });
        }
        return rest;
      });
      counts[spec.key] += rows.length;
      yield { event: 'rows', key: spec.key, rows, cursor };
      if (page.length < pageSize) break;
    }
    yield { event: 'end', key: spec.key };
  }

  const manifest = {
    format: 'deepwell-export-manifest-v1',
    originalsCount: originals.length,
    originals,
    fetch: {
      method: 'POST',
      path: '/api/upload-url',
      body: { mode: 'get', documentId: '<documentId from this list>' },
      note:
        'Original files are not embedded in this export. Each entry above has a stored original; request a fresh signed download link ' +
        '(valid about 15 minutes) with the call shown, signed in as a shop admin, or use "Open original" on the document in the app. ' +
        'No link or key is stored in this file.',
    },
  };
  yield { event: 'summary', truncated: Boolean(incomplete), incomplete, counts, manifest };
}

/**
 * Stream the export as ONE valid JSON document through `write(chunk)` (which may return a promise, for
 * backpressure). Same top-level keys as the old buffered export, plus `manifest`, `incomplete`, `counts`,
 * `notes` — and `truncated` is now written last (it is only known at the end). Mid-stream failure still
 * leaves valid JSON: the open array is closed and `truncated`, `error` and the resume point are appended.
 * @returns {Promise<{ok: boolean, truncated: boolean, counts: object, incomplete: object|null, error?: string}>}
 */
export async function streamTenantExport(ctx, write, opts = {}) {
  const exportedAt = new Date().toISOString();
  await write(`{"format":"deepwell-export-v2","tenantKey":${JSON.stringify(ctx.tenantKey)},"exportedAt":${JSON.stringify(exportedAt)}`);
  if (opts.resume) await write(`,"resumedFrom":${JSON.stringify(opts.resume)}`);
  let openKey = null;
  let first = true;
  let lastCursor = null;
  let wroteRows = false;
  const counts = {};
  try {
    for await (const ev of exportEvents(ctx, opts)) {
      if (ev.event === 'start') { openKey = ev.key; first = true; lastCursor = opts.resume?.key === ev.key ? opts.resume.after : null; await write(`,${JSON.stringify(ev.key)}:[`); }
      else if (ev.event === 'rows') {
        counts[ev.key] = (counts[ev.key] ?? 0) + ev.rows.length;
        await write((first ? '' : ',') + ev.rows.map((r) => JSON.stringify(r)).join(','));
        first = false;
        wroteRows = true;
        lastCursor = ev.cursor;
      } else if (ev.event === 'end') { await write(']'); openKey = null; }
      else if (ev.event === 'summary') {
        const notes = [
          'Original files (PDFs, photos) are listed in manifest.originals with their document ids; they are not embedded. ' +
          'Download each one on demand with the signed-link call described in manifest.fetch, or use "Open original" in the app.',
        ];
        if (ev.truncated) {
          notes.push('This export stopped at its time limit and is INCOMPLETE. POST { "resume": <incomplete> } to /api/tenant-export to continue from that row.');
        }
        await write(
          `,"manifest":${JSON.stringify(ev.manifest)},"counts":${JSON.stringify(ev.counts)},` +
          `"truncated":${ev.truncated},"incomplete":${JSON.stringify(ev.incomplete)},"notes":${JSON.stringify(notes)}}`
        );
        return { ok: true, truncated: ev.truncated, counts: ev.counts, incomplete: ev.incomplete };
      }
    }
    throw new Error('export ended without a summary');
  } catch (err) {
    // Nothing but the file's opening has been written: let the caller answer with a real error status.
    if (!wroteRows && !opts.tolerateEarlyFailure) throw err;
    if (openKey) await write(']');
    const incomplete = openKey ? { key: openKey, after: lastCursor } : null;
    await write(
      `,"truncated":true,"incomplete":${JSON.stringify(incomplete)},` +
      `"error":"The export failed part-way and is incomplete. Nothing was changed. Please retry.","notes":[]}`
    );
    return { ok: false, truncated: true, counts, incomplete, error: err?.message ?? String(err) };
  }
}

/**
 * Everything a tenant is entitled to see about their own data, as one JSON structure (the buffered form of
 * streamTenantExport — same pages, same manifest). storage_key is deliberately excluded from `documents`: it is an
 * internal R2 object key, not tenant-facing data. No row cap: pages through every table. Pass `shouldStop` to
 * bound it; an early stop is reported in `truncated` / `incomplete`, never silent.
 */
export async function exportTenant(ctx, opts = {}) {
  const out = { tenantKey: ctx.tenantKey, exportedAt: new Date().toISOString() };
  let summary = null;
  for await (const ev of exportEvents(ctx, opts)) {
    if (ev.event === 'start') out[ev.key] = [];
    else if (ev.event === 'rows') out[ev.key].push(...ev.rows);
    else if (ev.event === 'summary') summary = ev;
  }
  out.truncated = Boolean(summary?.truncated);
  out.incomplete = summary?.incomplete ?? null;
  out.manifest = summary?.manifest;
  return out;
}

/* ------------------------------------------------------------------ delete */

/**
 * FK-safe delete order for EVERY tenant-scoped table (every table with a `tenant_id` column in M3-config),
 * child-before-parent, as a pure exported constant — see scripts/verify-ops.mjs (FK order) and
 * scripts/verify-readiness.mjs, which derives the table list FROM THE SCHEMA and FAILS if any tenant table
 * is neither here nor in RETAINED_TABLES, so a future migration cannot forget one.
 *
 * FK notes (M3-config/01-create-schema.sql and later):
 *   - extractions.document_id -> documents (CASCADE), extractions.source_facet_id -> facets (SET NULL)
 *   - document_pages / facets / page_chunks / financials / intake_* -> documents (CASCADE)
 *   - notifications_sent, outreach_messages, document_entity_links -> entities (CASCADE)
 *   - entities.customer_id -> entities (SET NULL, self-referential): one DELETE handles all of a tenant's rows
 *   - audit_log / proposals / schema_versions -> users (SET NULL); staff_access_log -> support_access_grants (SET NULL)
 *
 * The `tenants` ROW is deliberately kept (see RETAINED_TABLES): this erases a tenant's DATA, not its
 * account, so tenant_id stays valid (resolve_tenant() still resolves it) and the Clerk sign-in, which this
 * codebase does not own the lifecycle of, keeps working on an empty slate.
 */
export const DELETE_ORDER = Object.freeze([
  // leaves that hang off documents / facets
  'extractions',
  'facets',
  'document_pages',
  'page_chunks',
  'document_financial_lines',
  'document_financials',
  'intake_needs_info',
  'intake_field_inferences',
  'document_entity_links',
  'kg_edges',
  'documents',
  // hang off entities (or nothing)
  'notifications_sent',
  'notifications',
  'outreach_messages',
  'tenant_outreach_settings',
  'entity_merge_suggestions',
  'dossiers',
  'knowledge_reports',
  'tenant_rollups',
  'tenant_insights_cache',
  // Q&A history and caches (question text and cached answers can hold customer names/phones)
  'ask_miss_replays',
  'ask_misses',
  'ask_answer_cache',
  'ask_semantic_cache',
  'embedding_usage',
  'rate_limit_windows',
  // Donovan per-tenant learning / test data
  'donovan_gap_promotions',
  'donovan_learned_tenant',
  'donovan_promoted_tests',
  'donovan_scorecard_results',
  'donovan_scorecard_runs',
  // support access records (about this tenant's data; the log first, it points at grants)
  'staff_access_log',
  'support_access_grants',
  // content tables that predate the list above
  'proposals',
  'schema_versions',
  'entities',
  'audit_log',
  // members, API keys and counters: no incoming FKs that matter, but their PRESENCE is what makes "delete all my data"
  // true (the tenants row is kept, so ON DELETE CASCADE from tenants never fires).
  'users',
  'api_keys',
  'usage_counters',
]);

/**
 * Tenant-scoped tables a delete deliberately leaves behind, and why. Anything else with a tenant_id column
 * that is not in DELETE_ORDER is a bug (and the readiness test fails on it); at runtime deleteTenantData
 * also sweeps such stragglers so a table added after this list was written is still wiped.
 */
export const RETAINED_TABLES = Object.freeze({
  tenants: 'the account row itself (id, name, plan, Stripe ids): resolve_tenant() and billing must keep working',
  tenant_deletions: 'the deletion receipt: proof that the deletion happened (counts and object keys only)',
  billing_events: 'Stripe webhook idempotency ledger (event id + event type only; no content, no payload)',
});

/**
 * Delete every row belonging to a tenant, in FK-safe order, inside one transaction (all-or-nothing: a failure on
 * any table rolls the whole thing back and throws). Also clears tenants.settings (shop contact list, follow-up
 * and digest settings). Returns the storage_keys those documents pointed at so the CALLER can delete them from R2
 * — deliberately AFTER this commits; see tenant-delete.js for why that ordering matters.
 */
export async function deleteTenantData(ctx) {
  return withTenant(ctx, async (client, tenantId) => {
    const { rows: docRows } = await client.query(
      `SELECT storage_key FROM documents WHERE tenant_id = $1 AND storage_key IS NOT NULL`,
      [tenantId]
    );
    const storageKeys = docRows.map((r) => r.storage_key);

    // One catalog read for "which tables exist and carry a tenant_id" (a database that has not run a later
    // migration simply lacks the table: zero rows, not a reason to abort). Catalog, not information_schema:
    // information_schema hides columns of tables the role holds no privilege on.
    const { rows: tenantTables } = await client.query(
      `SELECT c.relname AS t
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p')`
    );
    const existing = new Set(tenantTables.map((r) => r.t));

    const counts = {};
    for (const table of DELETE_ORDER) {
      if (!existing.has(table)) { counts[table] = 0; continue; }
      const { rowCount } = await client.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenantId]);
      counts[table] = rowCount;
    }
    // Stragglers: a tenant table added by a migration after DELETE_ORDER was written.
    const stragglers = [...existing].filter((t) => !DELETE_ORDER.includes(t) && !(t in RETAINED_TABLES)).sort();
    for (const table of stragglers) {
      const { rowCount } = await client.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenantId]);
      counts[table] = rowCount;
    }

    await client.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenantId]);

    return { tenantId, storageKeys, counts, stragglers };
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
