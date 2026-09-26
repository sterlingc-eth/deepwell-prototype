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
import { requireAuth, denyAuth } from './_lib/auth.js';
import { withTenant } from './_lib/recordsStore.js';
import { PLAN_LIMITS, planStateFor } from './_lib/plan.js';
import { getAsksThisMonth, resetsOnIso } from './_lib/usage.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

const BOOTSTRAP_RECORDS_LIMIT = 20;
const BOOTSTRAP_NOTIFICATIONS_LIMIT = 10;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
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
      limits: {
        ...(tenantRow?.limits ?? (PLAN_LIMITS as any)[tenantRow?.plan] ?? {}),
        asksPerMonth: (PLAN_LIMITS as any)[tenantRow?.plan]?.asksPerMonth ?? null,
      },
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
          case 'browseDocuments': return await db.browseDocuments(payload.filters, { currentUserId: auth.userId });
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
    console.error('API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
