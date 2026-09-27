/**
 * Audience HTTP surface — the one-tap override ("anywhere a doc is shown", owner ask (a), item 1)
 * and a plain status read. Same `op`-dispatch shape as api/_lib/routes/naming.js/graph.js (this
 * round's contract groups this feature under a NEW api/_lib/audience/** directory rather than
 * routes/naming.js itself, which belongs to a different owner) — a new small HTTP handler here,
 * NOT yet wired into api/account.js's ACTIONS map (that file isn't this engineer's to edit this
 * round; see the final report for the exact two-line hook).
 *
 *   POST /api/account?action=audience
 *     { op: 'get', documentId }                    -> { audience }                     any member
 *     { op: 'override', documentId, audience }      -> { audience }                     any member
 *
 * `override` is the one-tap flip: any signed-in tenant member may call it, same bar as naming.js's
 * own `rename` (a person correcting what they can already see on a document they can already open
 * is not an admin-only action) — never gated behind requireRole('admin').
 */
import { requireAuth, denyAuth, AuthError } from '../auth.js';
import { handleCors, handleError } from '../claude.js';
import { limit as rateLimit } from '../rateLimit.js';
import { withTenant } from '../recordsStore.js';
import { getDocumentAudience, overrideDocumentAudience } from './store.js';
// BUGFIX (2026-09-27 R18 reviewer, blocking): overrideDocumentAudience only ever REMOVES the
// document_entity_links row (audience -> 'internal'); flipping a document back to 'customer' never
// restores it, because the document's own linking logic lives in recordsStore.js/routes/integrity.js,
// not in this feature's DB-agnostic audience/store.js. Left as-is, a document a human corrects from a
// false 'internal' back to 'customer' silently stays invisible to every entity-scoped customer answer
// (docLookup.js resolves a customer's documents ONLY through document_entity_links, never the audience
// column) even though the UI now shows it as a customer document — exactly the "real customer document
// vanishes" failure this feature exists to prevent, just reached through its own recovery path instead
// of the classifier. integrityFixDocument is the existing, already-tested, best-effort repair
// (extractDocument.js calls it the same way after every extraction) that re-derives a document's
// customer link from its own extracted customer_name/service_address when unlinked; it only acts when
// the document actually names a customer and isn't already linked (isUnlinkedDocument), and it never
// throws, so calling it here is safe even when the document has nothing to link (e.g. still no
// customer fields at all).
import { integrityFixDocument } from '../routes/integrity.js';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleCors(res, req).status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, 'write'))) return;

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const body = req.body ?? {};
  const op = typeof body.op === 'string' ? body.op : '';
  const ok = (data) => handleCors(res, req).status(200).json(data);

  if (typeof body.documentId !== 'string' || !UUID_RE.test(body.documentId)) {
    return res.status(400).json({ error: 'documentId must be a uuid' });
  }

  try {
    if (op === 'get') {
      const audience = await withTenant(ctx, (store) => getDocumentAudience({ query: (sql, p) => store.raw(sql, p) }, body.documentId));
      return ok({ audience });
    }
    if (op === 'override') {
      if (body.audience !== 'customer' && body.audience !== 'internal') {
        return res.status(400).json({ error: "audience must be 'customer' or 'internal'" });
      }
      const result = await withTenant(ctx, (store) =>
        overrideDocumentAudience(
          { query: (sql, p) => store.raw(sql, p) },
          body.documentId,
          body.audience,
          { resolvedBy: `human:${auth.userId ?? 'unknown'}` }
        )
      );
      // See the import above: restore the customer entity link that a PRIOR 'internal'
      // classification (right or wrong) may have removed. Best-effort, never throws.
      if (body.audience === 'customer') await integrityFixDocument(ctx, body.documentId);
      return ok(result);
    }
    return res.status(400).json({ error: 'op must be one of: get, override' });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
