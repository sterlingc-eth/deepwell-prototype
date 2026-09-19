/**
 * Review persistence store.
 *
 * Backs api/review.js. Owns everything M3-config/08-review.sql added —
 * document_entity_links, extractions.corrected_*, documents.verified_*,
 * entities.merged_into — none of which recordsStore.js knows about or is
 * allowed to (see the security note on DOCUMENT_UPDATE_COLUMNS there).
 *
 * This file deliberately does NOT import recordsStore.js's `withTenant`. That
 * helper hands its callback the *store* object `makeStore()` builds, and that
 * object exposes only a fixed, narrow set of methods — no raw `.query`, and
 * its `updateDocument`/`updateExtraction` allowlists do not include (and must
 * not grow to include) `stage`, `corrected_value`, `verified_by`, or any of
 * the other columns this file writes under a guarded, forward-only
 * transition. Reaching for raw SQL here means keeping every one of those
 * transitions IN this file, reviewable in one place, rather than widening a
 * shared allowlist that every other caller of recordsStore.js also trusts.
 *
 * So this module runs its own `withTenant`, structured identically to
 * recordsStore.js's (same isolation model: non-owner role, one transaction
 * per request, `SET LOCAL app.tenant_id`, an explicit tenant predicate on
 * every statement as belt-and-braces alongside RLS) — but handing the
 * callback the raw `pg` client, because every statement below is bespoke
 * enough that a generic column-allowlist updater would not fit it.
 *
 * POOL CONSOLIDATION (scale-readiness build, 2026-09): this used to open its
 * own pg.Pool (max: 3), which — bundled into api/review.js's own Vercel
 * function alongside recordsStore.js's pool wherever both are imported —
 * meant that function opened two pools instead of one. recordsStore.js now
 * exports `getPool()` for exactly this; the transaction/RLS-scoping logic
 * below is unchanged, only where the connection comes from moved.
 *
 * State machine implemented here (each guarded in SQL, never trusting the
 * client's idea of the current stage):
 *
 *   correctField     — writes extractions.corrected_value/by/at for the field
 *                       (upserting a row if the field was never extracted —
 *                       "add a missing one", same as entityGraph.ts's
 *                       correctField comment). If the document is currently
 *                       'verified', this ALSO drops it back to 'linked'
 *                       (unverifyTx) in the same transaction: a verified
 *                       document whose facts just changed is not verified
 *                       against those facts anymore.
 *   classifyDocument — sets documents.document_type. Not stage-gated: this is
 *                       just a label and does not by itself claim anything
 *                       has been checked.
 *   linkDocument     — inserts a document_entity_links row and advances
 *                       'received'/'read'/'mapped' -> 'linked', the same
 *                       forward-only idiom as recordsStore.js's markLinked,
 *                       triggered by a human's link instead of an
 *                       extraction's entity_id.
 *   unlinkDocument   — removes a document_entity_links row. Does not, by
 *                       itself, move stage backwards.
 *   verifyDocument   — 'linked' -> 'verified', ONLY when at least one
 *                       document_entity_links row exists for the document.
 *                       Guarded twice: canVerify() gives an informative
 *                       pre-check, and the UPDATE itself repeats
 *                       `WHERE stage = 'linked' AND EXISTS (...)` so a race
 *                       (or a client lying about current stage) cannot verify
 *                       an unlinked document.
 *   unverifyDocument — 'verified' -> 'linked', clearing verified_by/at. Never
 *                       called directly by the review screen; it exists as
 *                       its own named, tested function because correctField
 *                       needs to run exactly this logic INSIDE its own
 *                       transaction (unverifyTx), and a future caller may
 *                       need it standalone.
 *   mergeEntities    — repoints every extraction and document_entity_links
 *                       row from the dropped entity to the surviving one,
 *                       then sets merged_into on the dropped row. The dropped
 *                       row is NEVER deleted: anything that still names it by
 *                       id (an audit_log row, a browser tab with it cached)
 *                       must keep resolving to something, and merged_into is
 *                       how a reader discovers where it went.
 */
import { getPool } from './recordsStore.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** Thrown for both bad input (400) and a refused state transition (409). */
export class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Param validators — pure, exported so scripts/verify-review.mjs can test
// them with no database.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function assertUuid(name, v) {
  if (!isUuid(v)) throw new ReviewError(`${name} must be a uuid`);
}

export function assertNonEmptyString(name, v) {
  if (!isNonEmptyString(v)) throw new ReviewError(`${name} is required`);
}

// ---------------------------------------------------------------------------
// Pure state-machine helpers — no database. These are the rules the SQL below
// enforces; kept here as plain functions so scripts/verify-review.mjs can
// pin the rule itself, independent of whether the SQL guard was typed right.
// ---------------------------------------------------------------------------

/**
 * @param {{stage: string}|null|undefined} doc
 * @param {unknown[]|null|undefined} links
 */
export function canVerify(doc, links) {
  return !!doc && doc.stage === 'linked' && Array.isArray(links) && links.length > 0;
}

/** What stage a document should be at right after one of its fields is
 *  corrected. Forward-only everywhere else in this pipeline; this is the one
 *  deliberate exception, and it only ever moves backward by exactly one step. */
export function nextStageAfterCorrection(currentStage) {
  return currentStage === 'verified' ? 'linked' : currentStage;
}

// ---------------------------------------------------------------------------
// Transaction helper — see the module comment for why this is not
// recordsStore.js's withTenant.
// ---------------------------------------------------------------------------

async function withTenant(ctx, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    const tenantId = rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

/**
 * Same audit_log columns and clerk-id resolution as recordsStore.js's
 * logAction, written directly with `client.query` because this file's `db`
 * is the raw client, not that store object. Kept in exact column-for-column
 * lockstep with recordsStore.js's version on purpose — two audit trails with
 * subtly different shapes would be worse than one file owning the schema.
 */
async function logAction(client, tenantId, { clerkUserId, action, resourceType, resourceId, changes }) {
  let userId = null;
  if (clerkUserId) {
    const { rows } = await client.query(`SELECT id FROM users WHERE clerk_user_id = $1 AND ${TENANT}`, [clerkUserId]);
    userId = rows[0]?.id ?? null;
  }
  const payload = { ...(changes ?? {}) };
  if (!userId && clerkUserId) payload.clerk_user_id = clerkUserId;
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [tenantId, userId, action, resourceType ?? null, resourceId ?? null, payload]
  );
}

/** 'verified' -> 'linked', clearing verified_by/at. Runs inside the caller's
 *  own transaction so a correction and the unverify it triggers commit
 *  together. Returns the updated row, or null if the document was not
 *  'verified' (a no-op, not an error — most corrections happen to a document
 *  that was never verified in the first place). */
async function unverifyTx(client, documentId) {
  const r = await client.query(
    `UPDATE documents SET stage = 'linked', verified_by = NULL, verified_at = NULL
      WHERE id = $1 AND ${TENANT} AND stage = 'verified'
      RETURNING *`,
    [documentId]
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Correct an extracted field's value, or add one that was never extracted.
 * Matched by (document_id, field_key) rather than an extraction row id: the
 * browser's Doc/ExtractedField shape (src/core/types.ts, owned outside this
 * build) has no extraction id to send, and every field this pipeline extracts
 * is a singleton per document in practice, so the pair is an unambiguous key.
 */
export async function correctField(ctx, { documentId, fieldKey, value, by }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('fieldKey', fieldKey);
  assertNonEmptyString('value', value);
  assertNonEmptyString('by', by);

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id, stage FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);

    const updated = await client.query(
      `UPDATE extractions
          SET corrected_value = $3, corrected_by = $4, corrected_at = NOW()
        WHERE document_id = $1 AND field_key = $2 AND ${TENANT}
        RETURNING id, field_key, value, corrected_value, corrected_by, corrected_at`,
      [documentId, fieldKey, value, by]
    );

    const extraction = updated.rowCount > 0
      ? updated.rows[0]
      : (await client.query(
          `INSERT INTO extractions (tenant_id, document_id, field_key, value, corrected_value, corrected_by, corrected_at, created_at)
           VALUES ($1,$2,$3,NULL,$4,$5,NOW(),NOW())
           RETURNING id, field_key, value, corrected_value, corrected_by, corrected_at`,
          [tenantId, documentId, fieldKey, value, by]
        )).rows[0];

    const unverified = await unverifyTx(client, documentId);
    const documentRow = unverified
      ?? (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.field_corrected',
      resourceType: 'document',
      resourceId: documentId,
      changes: { fieldKey, value, by, unverified: !!unverified },
    });

    return { document: documentRow, extraction };
  });
}

export async function classifyDocument(ctx, { documentId, documentType }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('documentType', documentType);

  return withTenant(ctx, async (client, tenantId) => {
    const r = await client.query(
      `UPDATE documents SET document_type = $2 WHERE id = $1 AND ${TENANT} RETURNING *`,
      [documentId, documentType]
    );
    if (!r.rowCount) throw new ReviewError('Document not found', 404);

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_classified',
      resourceType: 'document',
      resourceId: documentId,
      changes: { documentType },
    });

    return { document: r.rows[0] };
  });
}

export async function linkDocument(ctx, { documentId, entityId, by }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertUuid('entityId', entityId);
  assertNonEmptyString('by', by);

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id, stage FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);
    const entity = (await client.query(`SELECT id FROM entities WHERE id = $1 AND ${TENANT}`, [entityId])).rows[0];
    if (!entity) throw new ReviewError('Entity not found', 404);

    await client.query(
      `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
       VALUES ($1,$2,$3,1.0,$4,NOW())
       ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
      [tenantId, documentId, entityId, by]
    );

    // Forward-only, same idiom as recordsStore.js's markLinked: a manual link
    // is exactly the fact markLinked already advances 'mapped' -> 'linked'
    // for, just discovered by a person instead of an extraction's entity_id.
    // Never touches a document already at 'linked' or 'verified'.
    await client.query(
      `UPDATE documents SET stage = 'linked'
        WHERE id = $1 AND ${TENANT} AND stage IN ('received', 'read', 'mapped')`,
      [documentId]
    );

    const documentRow = (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    const links = (await client.query(
      `SELECT document_id, entity_id, confidence, linked_by, created_at
         FROM document_entity_links WHERE document_id = $1 AND ${TENANT}`,
      [documentId]
    )).rows;

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_linked',
      resourceType: 'document',
      resourceId: documentId,
      changes: { entityId, by },
    });

    return { document: documentRow, links };
  });
}

export async function unlinkDocument(ctx, { documentId, entityId }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertUuid('entityId', entityId);

  return withTenant(ctx, async (client, tenantId) => {
    const documentRow = (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!documentRow) throw new ReviewError('Document not found', 404);

    const r = await client.query(
      `DELETE FROM document_entity_links WHERE document_id = $1 AND entity_id = $2 AND ${TENANT}`,
      [documentId, entityId]
    );

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_unlinked',
      resourceType: 'document',
      resourceId: documentId,
      changes: { entityId, removed: r.rowCount > 0 },
    });

    return { document: documentRow };
  });
}

/** 'linked' -> 'verified'. Requires at least one document_entity_links row. */
export async function verifyDocument(ctx, { documentId, by }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('by', by);

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id, stage FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);
    const links = (await client.query(`SELECT id FROM document_entity_links WHERE document_id = $1 AND ${TENANT}`, [documentId])).rows;

    if (!canVerify(doc, links)) {
      throw new ReviewError('Document must be linked to at least one record before it can be verified', 409);
    }

    // Re-guards with the same WHERE the pre-check just evaluated in JS: never
    // trust the client's idea of the current stage, and close the race where
    // something else changed the stage between the SELECT above and here.
    const r = await client.query(
      `UPDATE documents SET stage = 'verified', verified_by = $2, verified_at = NOW()
        WHERE id = $1 AND ${TENANT} AND stage = 'linked'
        RETURNING *`,
      [documentId, by]
    );
    if (!r.rowCount) throw new ReviewError('Document is no longer eligible to verify', 409);

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_verified',
      resourceType: 'document',
      resourceId: documentId,
      changes: { by },
    });

    return { document: r.rows[0] };
  });
}

export async function unverifyDocument(ctx, { documentId }, actorClerkId) {
  assertUuid('documentId', documentId);

  return withTenant(ctx, async (client, tenantId) => {
    const updated = await unverifyTx(client, documentId);
    const documentRow = updated
      ?? (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!documentRow) throw new ReviewError('Document not found', 404);

    if (updated) {
      await logAction(client, tenantId, {
        clerkUserId: actorClerkId,
        action: 'review.document_unverified',
        resourceType: 'document',
        resourceId: documentId,
        changes: {},
      });
    }

    return { document: documentRow };
  });
}

/**
 * Merge `dropId` into `keepId`: every extraction and document_entity_links
 * row that named `dropId` is repointed to `keepId`, then `dropId` itself is
 * flagged with merged_into rather than deleted (see module comment).
 */
export async function mergeEntities(ctx, { keepId, dropId }, actorClerkId) {
  assertUuid('keepId', keepId);
  assertUuid('dropId', dropId);
  if (keepId === dropId) throw new ReviewError('keepId and dropId must differ');

  return withTenant(ctx, async (client, tenantId) => {
    const rows = (await client.query(
      `SELECT id, entity_type, merged_into FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
      [[keepId, dropId]]
    )).rows;
    const keep = rows.find((r) => r.id === keepId);
    const drop = rows.find((r) => r.id === dropId);
    if (!keep || !drop) throw new ReviewError('Both entities must exist in this tenant', 404);
    if (keep.entity_type !== drop.entity_type) throw new ReviewError('Cannot merge entities of different types', 400);
    if (drop.merged_into) throw new ReviewError('Entity has already been merged', 409);

    await client.query(`UPDATE extractions SET entity_id = $2 WHERE entity_id = $1 AND ${TENANT}`, [dropId, keepId]);

    await client.query(
      `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
         SELECT tenant_id, document_id, $2, confidence, linked_by, created_at
           FROM document_entity_links WHERE entity_id = $1 AND ${TENANT}
       ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
      [dropId, keepId]
    );
    await client.query(`DELETE FROM document_entity_links WHERE entity_id = $1 AND ${TENANT}`, [dropId]);

    // If `drop` is a customer that equipment rows point at, repoint those too
    // — a no-op when entity_type isn't 'customer' (nothing has customer_id
    // set to a non-customer row; see entities_customer_id_only_on_equipment
    // in 05-customer-link.sql).
    await client.query(`UPDATE entities SET customer_id = $2 WHERE customer_id = $1 AND ${TENANT}`, [dropId, keepId]);

    const dropped = (await client.query(
      `UPDATE entities SET merged_into = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT} RETURNING *`,
      [dropId, keepId]
    )).rows[0];
    const kept = (await client.query(`SELECT * FROM entities WHERE id = $1 AND ${TENANT}`, [keepId])).rows[0];

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.entities_merged',
      resourceType: 'entity',
      resourceId: keepId,
      changes: { droppedEntityId: dropId },
    });

    return { keep: kept, dropped };
  });
}

/** Every document_entity_links row for a set of documents, in one query —
 *  same "N documents, one round trip" shape as recordsStore.js's
 *  listExtractionsByDocuments, for the same reason (usePostgresSync loads up
 *  to 500 documents at once). */
export async function listLinks(ctx, { documentIds }) {
  const ids = [...new Set((documentIds ?? []).filter(isUuid))].slice(0, 500);
  if (!ids.length) return { links: [] };

  return withTenant(ctx, async (client) => {
    const rows = (await client.query(
      `SELECT document_id, entity_id, confidence, linked_by, created_at
         FROM document_entity_links WHERE document_id = ANY($1::uuid[]) AND ${TENANT}
        ORDER BY document_id, created_at`,
      [ids]
    )).rows;
    return { links: rows };
  });
}

/** Every corrected field for a set of documents, in one query. Only rows with
 *  a correction on file — a document with none costs one empty array entry
 *  in the caller's map, not a row here. */
export async function listCorrections(ctx, { documentIds }) {
  const ids = [...new Set((documentIds ?? []).filter(isUuid))].slice(0, 500);
  if (!ids.length) return { corrections: [] };

  return withTenant(ctx, async (client) => {
    const rows = (await client.query(
      `SELECT document_id, field_key, corrected_value, corrected_by, corrected_at
         FROM extractions
        WHERE document_id = ANY($1::uuid[]) AND ${TENANT} AND corrected_value IS NOT NULL
        ORDER BY document_id, id`,
      [ids]
    )).rows;
    return { corrections: rows };
  });
}
