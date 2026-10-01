/**
 * POST /api/records — the app's single data endpoint.
 *
 * Two things this file must never get wrong:
 *
 * 1. The store is imported from ./_lib/. Vercel bundles each function from its
 *    own directory, so the previous `../src/services/postgresRecordsStore`
 *    import was never shipped and every request died with ERR_MODULE_NOT_FOUND
 *    before a line of handler code ran.
 *
 * 2. The tenant comes from the verified Clerk token and nothing else. Every
 *    spelling of a caller-supplied tenant is stripped from the payload below,
 *    and the real one is stamped on after. Stripping only `tenantId` was not
 *    enough — the inserts read `tenant_id` (snake_case), so a caller could POST
 *    { action: 'createDocument', tenant_id: '<victim uuid>', ... }.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth, denyAuth, hasShop, requireRole } from './_lib/auth.js';
import { withTenant } from './_lib/recordsStore.js';
import { handleCors, scrubErrorForLog } from './_lib/claude.js';
import { limit } from './_lib/rateLimit.js';
import { checkUploadGate } from './upload-url.js';
import { clientLimits, planStateFor } from './_lib/plan.js';
import { getAsksThisMonth, resetsOnIso } from './_lib/usage.js';
import { normalizeContentType, sanitizeUploadFilename } from './_lib/r2.js';
import { DOCUMENT_TYPE_IDS } from './_lib/documentTypes.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

const BOOTSTRAP_RECORDS_LIMIT = 20;
const BOOTSTRAP_NOTIFICATIONS_LIMIT = 10;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * R30 L2: which actions any signed-in member may call, and which need the shop admin.
 *
 * The app's screens only ever READ through this endpoint (browseDocuments, listDocuments, listEntities,
 * listExtractionsByDocument(s), getDocument, bootstrap - see src/services/recordsStoreClient.ts callers), so
 * every read stays open to every member. Everything that writes (or reads the audit trail) used to be open to
 * any member too, which let a technician forge audit_log rows, rewrite extractions/entities, and so on: those
 * now need the admin role in a shop (a solo tenant has no org role and is its own owner, same rule as
 * billing/keys/delete - `hasShop(auth) ? requireRole(auth, 'admin')`).
 * createDocument is the one member-level write (it is what an upload does); it is billing-gated and
 * rate-limited exactly like /api/upload-url, and never accepts a client storage_key (see the case below).
 */
export const RECORDS_READ_ACTIONS: ReadonlySet<string> = new Set([
  'getDocument', 'listDocuments', 'browseDocuments', 'browseFacets',
  'reviewSummary', 'listUnverifiedDocuments', 'listEntitiesByIds',
  'getFacet', 'listFacetsByDocument',
  'getExtraction', 'listExtractionsByDocument', 'listExtractionsByDocuments', 'listExtractionsByEntity',
  'getEntity', 'listEntities',
  'getProposal', 'listProposals',
  'getSchemaVersion', 'bootstrap',
]);
export const RECORDS_MEMBER_WRITE_ACTIONS: ReadonlySet<string> = new Set(['createDocument']);
export const RECORDS_ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  'updateDocument',
  'createFacet', 'updateFacet',
  'createExtraction', 'updateExtraction',
  'createEntity', 'updateEntity',
  'createProposal', 'updateProposal',
  'logAction', 'getAuditLog',
  'incrementSchemaVersion',
]);

/** Pure: is this action allowed for this caller? Returns 'ok' | 'forbidden' | 'unknown'. */
export function recordsActionAccess(action: string, auth: { orgId?: string | null; orgRole?: string | null }): 'ok' | 'forbidden' | 'unknown' {
  if (RECORDS_READ_ACTIONS.has(action) || RECORDS_MEMBER_WRITE_ACTIONS.has(action)) return 'ok';
  if (RECORDS_ADMIN_ACTIONS.has(action)) return !auth?.orgId || auth.orgRole === 'admin' ? 'ok' : 'forbidden';
  return 'unknown';
}

const MAX_CREATE_BYTES = 100 * 1024 * 1024;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R34 (pure): the createDocument payload a member may send, validated the way /api/upload-url validates its own body. It used
 * to be handed to the INSERT as typed, so a NUL byte in the filename, a non-uuid batch_id, a 10^20 file size or a 5,000-character
 * content type each ended as a raw Postgres error (a 500, with the detail in the server log), and a 60 KB filename or a
 * right-to-left override in it was stored as typed. Only the columns an upload sets are passed on.
 */
export function cleanCreateDocumentPayload(p: any): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const filename = sanitizeUploadFilename(p?.original_filename);
  if (!filename) return { ok: false, error: 'original_filename is required' };
  if (typeof p?.sha256_hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256_hash)) return { ok: false, error: 'sha256_hash must be a 64-character hex digest' };
  const size = p?.file_size_bytes;
  // R35 (owner decision): every upload states its size - this path included. The pending-pages estimate behind the monthly
  // page cap reads file_size_bytes, and a row with none counted as a single page.
  if (size == null) return { ok: false, error: 'file_size_bytes is required: send the original file\'s exact size in bytes' };
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_CREATE_BYTES) return { ok: false, error: 'file_size_bytes must be a whole number of bytes between 1 and 100 MB' };
  if (p?.content_type != null && typeof p.content_type !== 'string') return { ok: false, error: 'content_type must be a string' };
  if (p?.batch_id != null && (typeof p.batch_id !== 'string' || !UUID_SHAPE.test(p.batch_id))) return { ok: false, error: 'batch_id must be a uuid' };
  const dt = typeof p?.document_type === 'string' ? p.document_type.trim().toLowerCase().replace(/[\s_]+/g, '-') : null;
  return {
    ok: true,
    value: {
      original_filename: filename,
      sha256_hash: p.sha256_hash,
      file_size_bytes: size,
      content_type: normalizeContentType(p?.content_type),
      batch_id: p?.batch_id ?? null,
      // A type is kept only when it is a known id; anything else is left for classification to decide.
      document_type: dt && DOCUMENT_TYPE_IDS.has(dt) ? dt : null,
    },
  };
}

const TENANT_PRED = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Startup performance (see handoffs/STARTUP_PERF_R13.md): everything the app
 * shell needs to show a real (non-skeleton) header + Ask screen + nav badges
 * in ONE round trip instead of the five staggered ones (billing, records x2,
 * review, document-status, account) the browser used to fire in sequence.
 * Runs inside the SAME withTenant transaction/connection as every other
 * action — the reads below are independent of each other (none depends on
 * another's result), so they run concurrently via Promise.all rather than
 * one-at-a-time, while still only ever holding open the one connection
 * `withTenant` already checked out for this request.
 *
 * Deliberately skips anything expensive, or that nothing on the client
 * actually consumes yet:
 *   - billing's aiCostEstimateUsd (a second, separate pool connection in
 *     billing.js's handleStatus) — BillingScreen fetches full status itself.
 *   - Records Browse's facets/financials joins — this returns plain
 *     `documents.*` rows (same shape usePostgresSync's DocumentRow already
 *     expects), enough to paint a first page while the fuller sync (with
 *     extractions/links/corrections) fills in behind it.
 *   - a documents-by-stage summary (reviewer NO-GO 2026-09-26): an earlier
 *     version of this endpoint computed one and returned it as
 *     `documentStatus`, but nothing on the client reads that field — dead
 *     work on every single bootstrap call. Add it back, consumed, the day
 *     a header pill or similar actually wants it.
 * A failure in any ONE of the reads must not take down the others — see the
 * `.catch` on each below — so this degrades exactly like the old
 * per-endpoint calls did when one of them failed.
 */
async function runBootstrap(db: any, auth: any, payload: any): Promise<any> {
  const recordsLimit = Math.min(Math.max(Number(payload?.recordsLimit) || BOOTSTRAP_RECORDS_LIMIT, 1), 100);
  const monthStartIso = new Date(Date.now() - MONTH_MS).toISOString();

  const [tenantRow, documentsStored, pagesThisMonth, asksThisMonth, recordsRows, notifRows] = await Promise.all([
    db.raw(
      `SELECT plan, billing_status, trial_ends_at, current_period_end, cancel_at_period_end, limits
         FROM tenants WHERE id = $1`,
      [db.tenantId]
    ).then((r: any) => r.rows[0] ?? null).catch(() => null),
    db.countDocuments().catch(() => 0),
    db.countPagesSince(monthStartIso).catch(() => 0),
    getAsksThisMonth(db).catch(() => 0),
    db.raw(`SELECT * FROM documents WHERE ${TENANT_PRED} ORDER BY created_at DESC LIMIT $1`, [recordsLimit])
      .then((r: any) => r.rows).catch(() => []),
    db.raw(
      `WITH items AS (
         SELECT id, kind, title, body, link, created_at, read_at FROM notifications
          ORDER BY (read_at IS NULL) DESC, created_at DESC LIMIT $1
       ), unread AS (SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL)
       SELECT (SELECT COALESCE(json_agg(i ORDER BY (i.read_at IS NULL) DESC, i.created_at DESC), '[]'::json) FROM items i) AS items,
              (SELECT n FROM unread) AS unread_count`,
      [BOOTSTRAP_NOTIFICATIONS_LIMIT]
    ).then((r: any) => r.rows[0] ?? { items: [], unread_count: 0 }).catch(() => ({ items: [], unread_count: 0 })),
  ]);

  return {
    billing: {
      plan: tenantRow?.plan ?? null,
      status: planStateFor(tenantRow ?? {}),
      trialEndsAt: tenantRow?.trial_ends_at ?? null,
      currentPeriodEnd: tenantRow?.current_period_end ?? null,
      cancelAtPeriodEnd: !!tenantRow?.cancel_at_period_end,
      limits: clientLimits(tenantRow),
      usage: { documentsStored, pagesThisMonth, asksThisMonth, resetsOn: resetsOnIso() },
    },
    notifications: { items: notifRows.items ?? [], unreadCount: Number(notifRows.unread_count) || 0 },
    records: { rows: recordsRows, total: documentsStored },
  };
}

export default async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  return processRecords(req, res, auth);
};

/**
 * Everything after authentication. Split out (R30) so scripts/verify-r30-audit-fixes.mjs can drive the real
 * dispatcher - role allowlist, createDocument hardening, gates - with a fabricated `auth` and no Clerk token.
 */
export async function processRecords(req: VercelRequest, res: VercelResponse, auth: any) {
  const { action, ...rest } = (req.body ?? {}) as Record<string, any>;
  if (!action) {
    return res.status(400).json({ error: 'action required' });
  }

  // Deliberately `any`: this is a generic dispatcher over ~24 differently
  // shaped payloads. Narrowing would mean a discriminated union per action,
  // which is not worth it while the shapes are still moving.
  const payload: any = { ...rest };
  for (const k of ['tenantId', 'tenant_id', 'tenantID', 'TenantId', 'user_id', 'userId']) {
    delete payload[k];
  }
  payload.clerk_user_id = auth.userId;

  const access = recordsActionAccess(String(action), auth);
  if (access === 'unknown') {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  if (access === 'forbidden') {
    return handleCors(res, req).status(403).json({ error: "This action requires the 'admin' role in your company." });
  }

  if (action === 'createDocument') {
    // R30 H1: the object key, the uploader and the stage are the SERVER's to set. A client-supplied storage_key
    // was inserted (and overwritten on conflict) unvalidated, so a member could point their own document at
    // another tenant's R2 object and then presign / read / delete it. upload-url.js derives the key from the
    // tenant + hash; nothing else may supply one.
    delete payload.storage_key;
    delete payload.stage;
    const cleaned = cleanCreateDocumentPayload(payload);
    if (!cleaned.ok) return handleCors(res, req).status(400).json({ error: cleaned.error });
    for (const k of Object.keys(payload)) delete payload[k];
    Object.assign(payload, cleaned.value);
    payload.clerk_user_id = auth.userId;
    payload.uploaded_by = auth.userId;
    // R30: this path used to skip the billing gate and the ingest rate limit that /api/upload-url applies, so a
    // member could create documents without either. Same gate, same bucket.
    const gate = await checkUploadGate(auth);
    if (!gate.allowed) {
      return handleCors(res, req).status(gate.status ?? 402).json({ error: gate.error, url: gate.url });
    }
    if (!(await limit(req, res, auth, 'ingest'))) return; // 429 already written
  }
  if (action === 'logAction') {
    // Client-originated audit rows are namespaced so they can never be mistaken for a server-written one.
    const a = typeof payload.action === 'string' ? payload.action.slice(0, 80) : 'unspecified';
    payload.action = a.startsWith('client.') ? a : `client.${a}`;
  }

  try {
    const result = await withTenant(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      async (db) => {
        switch (action) {
          // ---- documents ----
          case 'createDocument': return { id: (await db.createDocument(payload))?.id };
          case 'getDocument': return await db.getDocument(payload.id);
          case 'listDocuments': return await db.listDocuments(payload.filters);
          // Records Browse (round 12 contract): the paginated/filtered/faceted
          // list behind the records screen. `payload.filters` is caller input,
          // normalized and validated inside browseDocuments itself — nothing
          // here is trusted directly. `currentUserId` comes from the verified
          // token (never the payload) so "My uploads" can't be spoofed.
          case 'browseDocuments': return await db.browseDocuments(payload.filters, { currentUserId: auth.userId, facets: payload.facets === false ? 'none' : 'inline' });
          // R36: the filter-chip counts on their own (one pass, 60 s cache), so the first page need not wait for them.
          case 'browseFacets': return await db.browseFacets(payload.filters, { currentUserId: auth.userId });
          // R36: shop-wide counts and the uncapped needs-review list (the client graph only holds the newest 500).
          case 'reviewSummary': return await db.reviewSummary();
          case 'listUnverifiedDocuments': return await db.listUnverifiedDocuments({ cursor: payload.cursor ?? null, limit: payload.limit });
          case 'listEntitiesByIds': return await db.listEntitiesByIds(payload.ids);
          case 'updateDocument':
            await db.updateDocument(payload.id, payload.updates); return { success: true };

          // ---- facets ----
          case 'createFacet': return { id: (await db.createFacet(payload))?.id };
          case 'getFacet': return await db.getFacet(payload.id);
          case 'listFacetsByDocument': return await db.listFacetsByDocument(payload.documentId);
          case 'updateFacet':
            await db.updateFacet(payload.id, payload.updates); return { success: true };

          // ---- extractions ----
          case 'createExtraction': return { id: (await db.createExtraction(payload))?.id };
          case 'getExtraction': return await db.getExtraction(payload.id);
          case 'listExtractionsByDocument': return await db.listExtractionsByDocument(payload.documentId);
          case 'listExtractionsByDocuments': return await db.listExtractionsByDocuments(payload.documentIds);
          case 'listExtractionsByEntity': return await db.listExtractionsByEntity(payload.entityId);
          case 'updateExtraction':
            await db.updateExtraction(payload.id, payload.updates); return { success: true };

          // ---- entities ----
          case 'createEntity': return { id: (await db.createEntity(payload))?.id };
          case 'getEntity': return await db.getEntity(payload.id);
          case 'listEntities': return await db.listEntities(payload.type);
          case 'updateEntity':
            await db.updateEntity(payload.id, payload.updates); return { success: true };

          // ---- proposals ----
          case 'createProposal': return { id: (await db.createProposal(payload))?.id };
          case 'getProposal': return await db.getProposal(payload.id);
          case 'listProposals': return await db.listProposals(payload.status);
          case 'updateProposal':
            await db.updateProposal(payload.id, payload.updates); return { success: true };

          // ---- audit ----
          case 'logAction':
            await db.logAction(payload); return { success: true };
          case 'getAuditLog': return await db.getAuditLog(payload.filters);

          // ---- schema version ----
          case 'getSchemaVersion': return { version: await db.getSchemaVersion() };
          case 'incrementSchemaVersion':
            return { version: await db.incrementSchemaVersion(payload.description, payload.changeKind) };

          // ---- bootstrap (perf: one round trip / one tenant transaction for
          // everything the app shell needs before it can show anything real —
          // see handoffs/STARTUP_PERF_R13.md) ----
          case 'bootstrap': return await runBootstrap(db, auth, payload);

          default:
            return { __unknownAction: true };
        }
      }
    );

    if (result && (result as any).__unknownAction) {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.json(result ?? null);
  } catch (err) {
    // Log the detail, return none of it — raw messages leak schema and
    // connection internals to anonymous callers.
    console.error('API error:', scrubErrorForLog(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
}
