/**
 * Grid view — HTTP surface (POST /api/account?action=grid, dispatched by
 * `op`, same shape as financials.js/naming.js behind api/account.js). See
 * store.js for the two ops and their doc comments.
 *
 *   { op: 'documentCells', documentIds: string[], columns: string[] }
 *     -> { rowType: 'documents', cells: { [documentId]: { [column]: Cell } } }
 *   { op: 'units', filters?, columns?, cursor?, limit? }
 *     -> { rowType: 'units', columns, rows, total, hasMore, nextCursor }
 *
 * Every op is tenant-scoped through recordsStore.withTenant (RLS + a bound
 * tenant_id on every query in store.js). Read-only: no rate-limit budget
 * spent, same class as browseDocuments — a `read` limit is still applied so
 * one runaway client can't hammer the DB.
 */
import { requireAuth, denyAuth } from '../auth.js';
import { handleCors, handleError } from '../claude.js';
import { withTenant } from '../recordsStore.js';
import { limit as rateLimit } from '../rateLimit.js';
import { gridQuery } from './store.js';

export const config = { api: { bodyParser: { sizeLimit: '32kb' } }, maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleCors(res, req).status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, 'read'))) return; // 429 already written

  const body = req.body ?? {};
  const op = typeof body.op === 'string' ? body.op : '';
  if (op !== 'documentCells' && op !== 'units') {
    return res.status(400).json({ error: "op must be 'documentCells' or 'units'" });
  }
  if (op === 'units' && body.filters != null && (typeof body.filters !== 'object' || Array.isArray(body.filters))) {
    return res.status(400).json({ error: 'filters must be an object' });
  }
  if (op === 'documentCells' && !Array.isArray(body.documentIds)) {
    return res.status(400).json({ error: 'documentIds must be an array' });
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    const result = await withTenant(ctx, (db) => gridQuery(db, {
      op,
      documentIds: body.documentIds,
      columns: body.columns,
      filters: body.filters,
      cursor: typeof body.cursor === 'string' ? body.cursor : null,
      limit: body.limit,
    }));
    if (result?.error) return res.status(400).json(result);
    return handleCors(res, req).status(200).json(result);
  } catch (err) {
    return handleError(res, err, req, { tenantId: auth.tenantId, op });
  }
}
