/**
 * DELETE CONTRACT (handoffs/TEAM_BRIEF_2026-09-19.md). Owned by
 * agent-docs-access. Called from api/review.js's `case 'deleteDocuments'`
 * (agent-backend's dispatch, not touched here).
 *
 *   deleteDocuments(ctx, { documentIds }, auth) -> { deleted, failedStorage }
 *
 * Tenant-scoped, using the same raw-client withTenant idiom as
 * reviewStore.js (own transaction on recordsStore.js's shared pool,
 * `SET LOCAL app.tenant_id`, an explicit tenant predicate on every
 * statement) rather than recordsStore.js's curated store — a batch delete
 * across several tables is exactly the kind of bespoke transition
 * reviewStore.js's module comment says does not belong behind a generic
 * column-allowlist updater.
 *
 * Children of `documents` (document_pages, facets, extractions,
 * document_entity_links — see M3-config/01-create-schema.sql and
 * 08-review.sql) all declare `ON DELETE CASCADE`, so one
 * `DELETE FROM documents` removes every one of them; nothing here deletes
 * them by hand. `audit_log.resource_id` is a bare uuid column with no FK, so
 * past audit rows naming a deleted document are left alone on purpose — an
 * audit trail must survive the thing it describes.
 *
 * R2 objects are removed best-effort AFTER the transaction commits — same
 * split, same reasoning, as tenant-delete.js's deleteTenantData/deleteObject:
 * Postgres and R2 share no transaction, so the source of truth (the row
 * saying the document is gone) must land first. A storage failure here is
 * reported back, never thrown — the Postgres delete already succeeded and
 * must not be reported as failed because of an orphaned object.
 *
 * Admin required when the tenant is a Clerk org (hasShop/requireRole, same
 * pattern as api/_lib/routes/keys.js and tenant-delete.js); a solo tenant is
 * its own admin. requireRole throws auth.js's AuthError, which
 * api/review.js's catch does not special-case (only reviewStore.ReviewError
 * gets its status/message through) — so failures here are re-thrown as
 * ReviewError to get the right HTTP status back to the caller instead of a
 * generic 500.
 */
import { getPool } from '../recordsStore.js';
import { deleteObject } from '../r2.js';
import { hasShop, requireRole, AuthError } from '../auth.js';
import { ReviewError, isUuid } from '../reviewStore.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const MAX_IDS = 100;

/** Pure, exported for scripts/verify-docaccess.mjs. */
export function validateDocumentIds(documentIds) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    throw new ReviewError('documentIds must be a non-empty array');
  }
  const ids = [...new Set(documentIds)];
  if (ids.length > MAX_IDS) {
    throw new ReviewError(`A delete is limited to ${MAX_IDS} documents at a time`, 413);
  }
  if (!ids.every(isUuid)) {
    throw new ReviewError('documentIds must all be uuids');
  }
  return ids;
}

async function logAction(client, tenantId, { clerkUserId, action, resourceType, changes }) {
  let userId = null;
  if (clerkUserId) {
    const { rows } = await client.query(`SELECT id FROM users WHERE clerk_user_id = $1 AND ${TENANT}`, [clerkUserId]);
    userId = rows[0]?.id ?? null;
  }
  const payload = { ...(changes ?? {}) };
  if (!userId && clerkUserId) payload.clerk_user_id = clerkUserId;
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, changes, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [tenantId, userId, action, resourceType ?? null, payload]
  );
}

export async function deleteDocuments(ctx, { documentIds } = {}, auth) {
  try {
    if (hasShop(auth)) requireRole(auth, 'admin');
  } catch (err) {
    if (err instanceof AuthError) throw new ReviewError(err.message, err.status);
    throw err;
  }

  const ids = validateDocumentIds(documentIds);

  const client = await getPool().connect();
  let tenantId;
  let storageKeys;
  let deletedCount;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    tenantId = rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    // Collect storage keys BEFORE the delete — there is no row left to read
    // them from after.
    const found = await client.query(
      `SELECT id, storage_key FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
      [ids]
    );
    storageKeys = found.rows.filter((r) => r.storage_key).map((r) => r.storage_key);
    const foundIds = found.rows.map((r) => r.id);

    const del = await client.query(
      `DELETE FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
      [ids]
    );
    deletedCount = del.rowCount;

    await logAction(client, tenantId, {
      clerkUserId: auth.userId,
      action: 'review.documents_deleted',
      resourceType: 'document',
      changes: { documentIds: foundIds, requested: ids.length, deleted: deletedCount },
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const failedStorage = [];
  for (const key of storageKeys) {
    try {
      await deleteObject(key);
    } catch (err) {
      failedStorage.push(key);
      console.error('document-delete: R2 deleteObject failed:', key, err?.message);
    }
  }

  return { deleted: deletedCount, failedStorage };
}
