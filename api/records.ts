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

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

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
