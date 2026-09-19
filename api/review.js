/**
 * POST /api/review — persistence for the review screen's six actions.
 *
 * A sibling of api/records.ts, not a case added to it: the build brief that
 * created this route (see HANDOFF.md) was explicit that review actions must
 * not join records.ts's generic { action, ...payload } -> store method
 * dispatch, because every one of them is a guarded state transition
 * (extractions.corrected_*, documents.verified_*, entities.merged_into,
 * document_entity_links) that a generic column-allowlist updater cannot
 * express safely — see api/_lib/reviewStore.js's module comment.
 *
 * Same two rules as api/records.ts:
 *   1. The store is imported from ./_lib/ so Vercel bundles it into this
 *      function.
 *   2. The tenant AND the acting user's Clerk id come only from the verified
 *      token, never the request body. reviewStore.js's `by` parameters
 *      (corrected_by, linked_by, verified_by) are a client-supplied DISPLAY
 *      label — plain text like "You" or a technician's name, no different
 *      from what ReviewScreen already showed before anything persisted — and
 *      are not a trust boundary; the audit_log actor (`actorClerkId` below)
 *      is a separate value this file derives from `auth.userId` and appends
 *      itself, exactly as api/records.ts appends `clerk_user_id`.
 */
import { requireAuth, denyAuth } from './_lib/auth.js';
import * as reviewStore from './_lib/reviewStore.js';
import { deleteDocuments } from './_lib/routes/document-delete.js';

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' } },
  // reclassify can make up to 20 sequential model calls (see reviewStore.js's
  // RECLASSIFY_DEADLINE_MS); the platform default ceiling is shorter than
  // that could need.
  maxDuration: 60,
};

const ACTIONS = new Set([
  'correctField',
  'classifyDocument',
  'linkDocument',
  'unlinkDocument',
  'verifyDocument',
  'unverifyDocument',
  'mergeEntities',
  'listLinks',
  'listCorrections',
  'deleteDocuments',
  'aiVerify',
  'reclassify',
]);

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const { action, ...rest } = req.body ?? {};
  if (!action || !ACTIONS.has(action)) {
    return res.status(400).json({ error: `Unknown action: ${action ?? ''}` });
  }

  // Same stripping as api/records.ts: whatever the client thinks the tenant
  // or the acting user's Clerk id is, drop it before it reaches the store.
  const payload = { ...rest };
  for (const k of ['tenantId', 'tenant_id', 'tenantID', 'TenantId', 'actorClerkId', 'clerk_user_id']) {
    delete payload[k];
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    let result;
    switch (action) {
      case 'correctField':
        result = await reviewStore.correctField(ctx, payload, auth.userId);
        break;
      case 'classifyDocument':
        result = await reviewStore.classifyDocument(ctx, payload, auth.userId);
        break;
      case 'linkDocument':
        result = await reviewStore.linkDocument(ctx, payload, auth.userId);
        break;
      case 'unlinkDocument':
        result = await reviewStore.unlinkDocument(ctx, payload, auth.userId);
        break;
      case 'verifyDocument':
        result = await reviewStore.verifyDocument(ctx, payload, auth.userId);
        break;
      case 'unverifyDocument':
        result = await reviewStore.unverifyDocument(ctx, payload, auth.userId);
        break;
      case 'mergeEntities':
        result = await reviewStore.mergeEntities(ctx, payload, auth.userId);
        break;
      case 'listLinks':
        result = await reviewStore.listLinks(ctx, payload);
        break;
      case 'listCorrections':
        result = await reviewStore.listCorrections(ctx, payload);
        break;
      case 'deleteDocuments':
        result = await deleteDocuments(ctx, payload, auth);
        break;
      case 'aiVerify':
        result = await reviewStore.aiVerifyDocument(ctx, payload, auth.userId);
        break;
      case 'reclassify':
        result = await reviewStore.reclassifyDocuments(ctx, payload, auth.userId);
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.json(result ?? null);
  } catch (err) {
    if (err instanceof reviewStore.ReviewError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Log the detail, return none of it — same reasoning as api/records.ts.
    console.error('review API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
