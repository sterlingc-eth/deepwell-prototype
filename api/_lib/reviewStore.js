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
 *   aiVerifyDocument — recomputes completeness from stored extractions and
 *                       promotes to verified_by='ai' with no re-extraction;
 *                       see documentTypes.js and recordsStore.js's verifyByAi.
 *   reclassifyDocuments — batch, model-free document_type cleanup for rows
 *                       whose type is null or a legacy id; never touches an
 *                       already-canonical value.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getPool, withTenant as withRecordsTenant, linkDocumentToCustomer } from './recordsStore.js';
import { getApiKey, withBackoff } from './claude.js';
import { getDailyModelBudgetStatus } from './rateLimit.js';
import { withCache } from './promptCache.js';
import {
  normalizeDocumentType,
  inferDocumentType,
  isReclassifiable,
  completenessFor,
  toCompletenessFields,
  AI_VERIFY_MIN_CONFIDENCE,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_DEFINITIONS,
  DOCUMENT_TYPE_IDS,
} from './documentTypes.js';

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

/**
 * Recompute completeness from stored extractions and promote to AI-verified
 * if it now clears the bar — no re-extraction, no model call. Lets a document
 * extracted before this build (or corrected since) get promoted without
 * going back through /api/extract. Uses recordsStore.js's curated store
 * (getDocument/listExtractionsByDocument/verifyByAi) rather than this file's
 * own raw-client withTenant — nothing here is a bespoke transition.
 */
export async function aiVerifyDocument(ctx, { documentId }, actorClerkId) {
  assertUuid('documentId', documentId);

  return withRecordsTenant(ctx, async (db) => {
    const doc = await db.getDocument(documentId);
    if (!doc) throw new ReviewError('Document not found', 404);

    const rows = await db.listExtractionsByDocument(documentId); // SELECT * includes corrected_value
    const completenessFields = toCompletenessFields(rows);

    // Repair a document stuck unlinked (no equipment entity, so nothing ever
    // ran findOrCreateCustomer for it, or it ran before this existed) — same
    // helper extractDocument.js calls right after extraction, so pressing
    // "Reclassify & verify all" fixes old documents with no re-extraction.
    // Skipped once the document already has any link — cheap, no-op writes.
    if (doc.stage !== 'linked' && doc.stage !== 'verified' && !rows.some((r) => r.entity_id)) {
      const facts = Object.fromEntries(completenessFields.map((f) => [f.field_key, f.value]));
      const customer = await db.findOrCreateCustomer(facts);
      if (customer?.id) {
        const customerFields = completenessFields.filter((f) => f.field_key === 'customer_name' || f.field_key === 'service_address');
        const confidence = customerFields.length ? Math.max(...customerFields.map((f) => f.confidence)) : 0.6;
        await linkDocumentToCustomer(db, { documentId, entityId: null, customerId: customer.id, confidence });
      }
    }

    const type = normalizeDocumentType(doc.document_type);
    const completeness = completenessFor(type, completenessFields);

    let verified = false;
    if (completeness.complete && completeness.minConfidence >= AI_VERIFY_MIN_CONFIDENCE) {
      verified = (await db.verifyByAi(documentId)) > 0;
    }

    if (verified) {
      await db.logAction({
        clerk_user_id: actorClerkId,
        action: 'review.ai_verified',
        resource_type: 'document',
        resource_id: documentId,
        changes: { completeness },
      });
    }

    // Re-fetch rather than trusting the pre-repair `doc`: the link-repair
    // above (or verifyByAi) may have changed stage since it was read.
    const document = (await db.getDocument(documentId)) ?? doc;
    return { document, completeness, verified };
  });
}

/** Pure: did a human ever explicitly set this document's CURRENT type? An
 *  automated reclassification must never overwrite that, even when the type
 *  is 'other' or otherwise looks reclassifiable. `classificationRows` is a
 *  set of audit_log rows for action='review.document_classified' on this
 *  document; only their `changes.documentType` is consulted. Exported so the
 *  rule is testable with no database (scripts/verify-review.mjs). */
export function wasClassifiedByHuman(currentType, classificationRows) {
  // A human choosing 'other' means "nothing fit", not a decision to protect —
  // 'other' is the one type the pipeline must keep trying to improve on.
  if (!currentType || currentType === 'other') return false;
  return (classificationRows ?? []).some((r) => r?.changes?.documentType === currentType);
}

const RECLASSIFY_MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5';
const MAX_RECLASSIFY_MODEL_CALLS = 20;
const RECLASSIFY_TEXT_CHARS = 1500;

/**
 * Overall wall-clock budget for ALL of reclassifyDocuments' model calls in
 * one request — api/review.js's function ceiling is 60s (maxDuration); 45s
 * leaves headroom for the DB round-trips around each call and the response
 * itself. MIN_BUDGET_MS: once less than this remains, a fresh model call
 * (its own request + possible retry) would not reliably finish before the
 * ceiling, so it is skipped rather than risked — that document just counts
 * toward `remaining`. MAX_CALL_TIMEOUT_MS caps any single call so one slow
 * response can't eat the whole remaining budget.
 */
export const RECLASSIFY_DEADLINE_MS = 45_000;
export const MODEL_CALL_MIN_BUDGET_MS = 8_000;
export const MODEL_CALL_MAX_TIMEOUT_MS = 12_000;

/**
 * Pure: given how much time remains before reclassifyDocuments' overall
 * deadline, decide whether another model call is worth attempting and, if
 * so, what per-call timeout to give it. Returns null to mean "don't call —
 * count this document toward `remaining` instead". Exported so the budgeting
 * rule is testable with no clock, no network (scripts/verify-review.mjs).
 */
export function modelCallBudget(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs < MODEL_CALL_MIN_BUDGET_MS) return null;
  return Math.min(remainingMs, MODEL_CALL_MAX_TIMEOUT_MS);
}

const RECLASSIFY_TOOL = {
  name: 'classify_document',
  description: 'Pick exactly one canonical document type id for this HVAC business document.',
  input_schema: {
    type: 'object',
    properties: { document_type: { type: 'string', enum: DOCUMENT_TYPES.map((t) => t.id) } },
    required: ['document_type'],
  },
};

// Static first, so this is the cacheable half of the prompt (see
// promptCache.js) — identical on every call, for every document, forever.
const RECLASSIFY_SYSTEM_PROMPT = `You classify HVAC business documents into exactly one type.

TYPES:
${DOCUMENT_TYPES.map((t) => `- ${t.id}: ${DOCUMENT_TYPE_DEFINITIONS[t.id] ?? ''}`).join('\n')}

Use "other" only when nothing above clearly fits. Reply using the classify_document tool.`;

/** One cheap Haiku call, bounded by `timeoutMs` (from modelCallBudget) both
 *  as the request's own timeout and as withBackoff's deadline, so a retry
 *  inside this call can never overrun the caller's remaining budget. Returns
 *  a canonical type id, or null on any failure or unusable answer — never
 *  throws, since one bad classification must not fail the whole batch. */
async function classifyByModel(client, { filename, text, timeoutMs }) {
  try {
    const dynamicPrompt = `Filename: ${filename || '(none)'}\n\nText:\n${text}`;
    const response = await withBackoff(() => client.messages.create({
      model: RECLASSIFY_MODEL,
      max_tokens: 50,
      system: [withCache({ type: 'text', text: RECLASSIFY_SYSTEM_PROMPT }, RECLASSIFY_MODEL)],
      tools: [withCache(RECLASSIFY_TOOL, RECLASSIFY_MODEL)],
      tool_choice: { type: 'tool', name: RECLASSIFY_TOOL.name },
      messages: [{ role: 'user', content: dynamicPrompt }],
    }, { timeout: timeoutMs }), { deadlineAt: Date.now() + timeoutMs });
    const raw = response.content.find((b) => b.type === 'tool_use')?.input?.document_type;
    return typeof raw === 'string' && DOCUMENT_TYPE_IDS.has(raw) ? raw : null;
  } catch (err) {
    console.error('reclassify model call failed:', err?.message);
    return null;
  }
}

/**
 * Batch reclassification. Touches documents whose document_type is null, a
 * legacy/free-text value, or the canonical-but-meaningless 'other' — see
 * isReclassifiable. Never overwrites a type a HUMAN explicitly set to what it
 * currently is (wasClassifiedByHuman, checked against this document's own
 * audit_log rows). For each eligible document: (1) the deterministic
 * heuristic (facts, then filename); (2) if that still says 'other' and the
 * document has page text, one Haiku call — bounded by MAX_RECLASSIFY_MODEL_CALLS
 * AND by the shared RECLASSIFY_DEADLINE_MS wall-clock budget (modelCallBudget)
 * — `remaining` tells the caller how many documents still need another pass.
 * Capped at 100 ids per call.
 *
 * ONE TRANSACTION PER DOCUMENT, not one for the whole batch: up to 20 model
 * calls plus their DB round-trips can approach api/review.js's 60s function
 * ceiling, and a single all-or-nothing transaction would roll back every
 * already-processed document if a later one errored or the function was
 * killed mid-call. A document that fails is logged and skipped, not fatal to
 * the rest of the batch.
 */
export async function reclassifyDocuments(ctx, { documentIds } = {}, actorClerkId) {
  const ids = [...new Set((documentIds ?? []).filter(isUuid))].slice(0, 100);
  if (!ids.length) return { changes: [], remaining: 0 };

  const deadlineAt = Date.now() + RECLASSIFY_DEADLINE_MS;
  let modelCalls = 0;
  let client = null;
  const changes = [];
  let remaining = 0;

  // B1 (2026-09-19 adversarial audit): reclassify's Haiku fallback was the
  // fourth billed call site with no daily-budget check at all. Checked ONCE,
  // before the loop, not per document: the whole point of this loop is that
  // its heuristic-only path (facts/filename, no model call) keeps working for
  // every eligible document regardless of budget, so this doesn't throw and
  // abort the batch — it just makes `budget` below always resolve to "don't
  // call the model", which is exactly what an exhausted tenant should get:
  // every document the heuristic can place still gets reclassified, and the
  // rest count toward `remaining` (the same signal a genuinely exhausted
  // MAX_RECLASSIFY_MODEL_CALLS already produces) rather than a 429 that would
  // also block the heuristic-only documents in the same batch.
  const budgetStatus = await getDailyModelBudgetStatus(ctx);

  for (const id of ids) {
    try {
      const change = await withRecordsTenant(ctx, async (db) => {
        const doc = await db.getDocument(id);
        if (!doc) return null;
        if (!isReclassifiable(doc.document_type)) return null;

        const classificationRows = await db.getAuditLog({
          action: 'review.document_classified', resource_type: 'document', resource_id: id,
        });
        if (wasClassifiedByHuman(doc.document_type, classificationRows)) return null;

        const rows = await db.listExtractionsByDocument(id);
        const facts = Object.fromEntries(
          toCompletenessFields(rows).map((f) => [f.field_key, f.value])
        );
        let resolved = doc.document_type ? normalizeDocumentType(doc.document_type, facts) : 'other';
        if (resolved === 'other') resolved = inferDocumentType(facts, doc.original_filename);

        if (resolved === 'other') {
          const budget = modelCalls < MAX_RECLASSIFY_MODEL_CALLS && !budgetStatus.exceeded
            ? modelCallBudget(deadlineAt - Date.now())
            : null;
          if (budget != null) {
            const pages = await db.listPages(id);
            const text = pages.map((p) => p.text).filter(Boolean).join('\n').slice(0, RECLASSIFY_TEXT_CHARS).trim();
            if (text) {
              modelCalls++;
              client ??= new Anthropic({ apiKey: getApiKey(), timeout: MODEL_CALL_MAX_TIMEOUT_MS, maxRetries: 0 });
              const modelType = await classifyByModel(client, { filename: doc.original_filename, text, timeoutMs: budget });
              if (modelType && modelType !== 'other') resolved = modelType;
            }
          }
          if (resolved === 'other') { remaining++; return null; }
        }

        if (resolved === doc.document_type) return null;
        await db.updateDocument(id, { document_type: resolved });
        return { documentId: id, from: doc.document_type, to: resolved };
      });
      if (change) changes.push(change);
    } catch (err) {
      console.error('reclassifyDocuments: document failed, continuing:', id, err?.message);
    }
  }

  if (changes.length) {
    // Its own short transaction: the summary log must not be lost just
    // because it runs after the per-document loop, but it also must not
    // force the per-document work back into one shared transaction.
    await withRecordsTenant(ctx, async (db) => {
      await db.logAction({
        clerk_user_id: actorClerkId,
        action: 'review.reclassified',
        resource_type: 'document',
        changes: { count: changes.length, changes },
      });
    });
  }

  return { changes, remaining };
}

// ---------------------------------------------------------------------------
// Customer profile actions (handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md
// section C). Written here rather than recordsStore.js for the same reason
// as every other action in this file: each is a guarded, audited state
// change (a customer_number assignment, a document's customer link replaced,
// a merge's number housekeeping), not a generic column update.
// ---------------------------------------------------------------------------

/** Allowlisted updateCustomer patch keys -> the `data` jsonb key they write.
 *  Exported so the allowlist itself is testable with no database. */
export const CUSTOMER_PATCH_KEYS = Object.freeze(['name', 'serviceAddress', 'phone', 'email', 'notes']);
const PATCH_TO_DATA_KEY = {
  name: 'customer_name', serviceAddress: 'service_address',
  phone: 'phone', email: 'email', notes: 'notes',
};

/** Pure: turn a caller's patch into {data_key: value}, dropping anything not
 *  in CUSTOMER_PATCH_KEYS and any key whose value is null/undefined (omit a
 *  field to leave it unchanged; pass '' to explicitly clear it). */
export function filterCustomerPatch(patch) {
  const out = {};
  for (const k of CUSTOMER_PATCH_KEYS) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = patch[k];
    if (v == null) continue;
    out[PATCH_TO_DATA_KEY[k]] = String(v).trim();
  }
  return out;
}

/** Pure: which of two customer_number values survives a merge, and which
 *  retires into the survivor's data.former_numbers. The LOWER number wins —
 *  it's the older-registered identity — with either input allowed to be
 *  missing (a pre-migration-15 row that somehow has none). Exported so the
 *  "keep the lower number" rule is checked with no database. */
export function chooseSurvivorNumber(keepNumber, dropNumber) {
  const kn = typeof keepNumber === 'string' ? Number(keepNumber.replace(/^C-/, '')) : NaN;
  const dn = typeof dropNumber === 'string' ? Number(dropNumber.replace(/^C-/, '')) : NaN;
  if (!Number.isFinite(kn) && !Number.isFinite(dn)) return { survivorNumber: null, retiredNumber: null };
  if (!Number.isFinite(kn)) return { survivorNumber: dropNumber, retiredNumber: null };
  if (!Number.isFinite(dn)) return { survivorNumber: keepNumber, retiredNumber: null };
  return dn < kn
    ? { survivorNumber: dropNumber, retiredNumber: keepNumber }
    : { survivorNumber: keepNumber, retiredNumber: dropNumber };
}

/** `createCustomer {name, serviceAddress?, phone?, email?, notes?}` — a
 *  human creating a customer record directly, distinct from
 *  findOrCreateCustomer's document-driven inference (recordsStore.js): here
 *  the human IS the source of truth, so there is no name/address matching to
 *  do, only a fresh row and a fresh number. */
export async function createCustomer(ctx, { name, serviceAddress, phone, email, notes } = {}, actorClerkId) {
  assertNonEmptyString('name', name);

  return withTenant(ctx, async (client, tenantId) => {
    const data = { customer_name: name.trim() };
    for (const [k, v] of [['service_address', serviceAddress], ['phone', phone], ['email', email], ['notes', notes]]) {
      if (isNonEmptyString(v)) data[k] = v.trim();
    }

    const numRow = await client.query('SELECT next_customer_number($1) AS num', [tenantId]);
    const number = numRow.rows[0]?.num ?? null;

    const created = await client.query(
      `INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
       VALUES ($1,'customer',$2,$3,NOW(),NOW()) RETURNING *`,
      [tenantId, data, number]
    );

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.customer_created',
      resourceType: 'entity',
      resourceId: created.rows[0].id,
      changes: { name: name.trim(), customerNumber: number },
    });

    return { customer: created.rows[0] };
  });
}

/** `updateCustomer {customerId, patch:{name?, serviceAddress?, phone?,
 *  email?, notes?}}` — allowlisted via filterCustomerPatch; never touches
 *  customer_number (mergeCustomers owns that). */
export async function updateCustomer(ctx, { customerId, patch } = {}, actorClerkId) {
  assertUuid('customerId', customerId);
  const dataPatch = filterCustomerPatch(patch);
  if (!Object.keys(dataPatch).length) throw new ReviewError('patch has no allowed fields');

  return withTenant(ctx, async (client, tenantId) => {
    const row = (await client.query(
      `SELECT id, data FROM entities WHERE id = $1 AND entity_type = 'customer' AND ${TENANT}`,
      [customerId]
    )).rows[0];
    if (!row) throw new ReviewError('Customer not found', 404);

    const data = { ...(row.data ?? {}), ...dataPatch };
    const updated = await client.query(
      `UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT} RETURNING *`,
      [customerId, data]
    );

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.customer_updated',
      resourceType: 'entity',
      resourceId: customerId,
      changes: { patch: dataPatch },
    });

    return { customer: updated.rows[0] };
  });
}

/**
 * `assignDocumentCustomer {documentId, customerId}` — replaces any existing
 * CUSTOMER link on the document (a document names exactly one customer;
 * unlike equipment, there is no legitimate multi-customer case here) and
 * advances stage forward-only, same idiom as linkDocument above. If the
 * document is also linked to equipment with no customer yet, backfills that
 * equipment's customer_id — the same repair aiVerifyDocument's link-recovery
 * path does, just triggered by a human picking a customer instead of a
 * name/address match.
 */
export async function assignDocumentCustomer(ctx, { documentId, customerId }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertUuid('customerId', customerId);

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id, stage FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);
    const cust = (await client.query(
      `SELECT id FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}`,
      [customerId]
    )).rows[0];
    if (!cust) throw new ReviewError('Customer not found', 404);

    await client.query(
      `DELETE FROM document_entity_links l
        USING entities e
       WHERE l.document_id = $1 AND l.entity_id = e.id AND e.entity_type = 'customer'
         AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid`,
      [documentId]
    );
    await client.query(
      `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
       VALUES ($1,$2,$3,1.0,'human',NOW())
       ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
      [tenantId, documentId, customerId]
    );
    await client.query(
      `UPDATE documents SET stage = 'linked'
        WHERE id = $1 AND ${TENANT} AND stage IN ('received', 'read', 'mapped')`,
      [documentId]
    );

    // Backfill: any equipment this document already names (via link or
    // extraction) that has no customer yet gets this one — fill-only, same
    // rule as recordsStore.js's setEquipmentCustomer.
    const equipmentIds = (await client.query(
      `SELECT DISTINCT e.id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
        WHERE l.document_id = $1 AND e.entity_type = 'equipment' AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT DISTINCT e.id FROM extractions x JOIN entities e ON e.id = x.entity_id
        WHERE x.document_id = $1 AND e.entity_type = 'equipment' AND x.tenant_id = (current_setting('app.tenant_id', true))::uuid`,
      [documentId]
    )).rows.map((r) => r.id);
    for (const equipmentId of equipmentIds) {
      await client.query(
        `UPDATE entities SET customer_id = $2, updated_at = NOW()
          WHERE id = $1 AND entity_type = 'equipment' AND customer_id IS NULL AND ${TENANT}`,
        [equipmentId, customerId]
      );
    }

    const documentRow = (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_customer_assigned',
      resourceType: 'document',
      resourceId: documentId,
      changes: { customerId, equipmentBackfilled: equipmentIds },
    });

    return { document: documentRow };
  });
}

/**
 * `mergeCustomers {keepId, dropId}` — wraps mergeEntities (rejecting anything
 * that isn't two customer rows) and then does the customer_number
 * housekeeping mergeEntities itself knows nothing about: the survivor keeps
 * whichever number is numerically lower, and the OTHER number is retired
 * (cleared to NULL — freeing it under the partial unique index — and
 * recorded in the survivor's data.former_numbers) rather than left dangling
 * on a row nothing can find by number anymore.
 *
 * Two sequential transactions, not one: mergeEntities is a complete, already
 * — tested unit of work on its own (repointing extractions/links, setting
 * merged_into), and the number housekeeping is additive to it, not a rewrite
 * of it — matching reclassifyDocuments' own "per-unit transaction, then a
 * small follow-up transaction" shape elsewhere in this file. A failure
 * between the two leaves both customer_numbers exactly as they were
 * (unchanged, still valid) with the merge itself already durable — a
 * survivor keeping its original (higher) number until a retry is a cosmetic
 * gap, not a data-integrity one.
 */
export async function mergeCustomers(ctx, { keepId, dropId }, actorClerkId) {
  assertUuid('keepId', keepId);
  assertUuid('dropId', dropId);
  if (keepId === dropId) throw new ReviewError('keepId and dropId must differ');

  const pre = await withTenant(ctx, async (client) => (await client.query(
    `SELECT id, entity_type, customer_number FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
    [[keepId, dropId]]
  )).rows);
  const keepPre = pre.find((r) => r.id === keepId);
  const dropPre = pre.find((r) => r.id === dropId);
  if (!keepPre || !dropPre) throw new ReviewError('Both entities must exist in this tenant', 404);
  if (keepPre.entity_type !== 'customer' || dropPre.entity_type !== 'customer') {
    throw new ReviewError('mergeCustomers requires two customer records', 400);
  }

  const merged = await mergeEntities(ctx, { keepId, dropId }, actorClerkId);

  const { survivorNumber, retiredNumber } = chooseSurvivorNumber(keepPre.customer_number, dropPre.customer_number);
  if (retiredNumber) {
    await withTenant(ctx, async (client, tenantId) => {
      // Clear BOTH rows' numbers first, unconditionally — not just the
      // retired one. Whichever number survives (it can be EITHER keep's or
      // drop's own original number, depending on which was lower) is about
      // to be written onto keepId; if the row that already holds that exact
      // value were left alone, the very next UPDATE would collide with it
      // under the partial unique index (tenant_id, customer_number) WHERE
      // entity_type='customer'. Two NULLs never conflict with each other or
      // with anything else, so clearing both first makes the reassignment
      // below unconditionally safe regardless of which number won.
      await client.query(
        `UPDATE entities SET customer_number = NULL
          WHERE id = ANY($1::uuid[]) AND entity_type = 'customer' AND ${TENANT}`,
        [[keepId, dropId]]
      );
      await client.query(
        `UPDATE entities
            SET customer_number = $2,
                data = jsonb_set(COALESCE(data, '{}'::jsonb), '{former_numbers}',
                         COALESCE(data->'former_numbers', '[]'::jsonb) || to_jsonb($3::text))
          WHERE id = $1 AND ${TENANT}`,
        [keepId, survivorNumber, retiredNumber]
      );
      await logAction(client, tenantId, {
        clerkUserId: actorClerkId,
        action: 'review.customer_number_reassigned',
        resourceType: 'entity',
        resourceId: keepId,
        changes: { survivorNumber, retiredNumber },
      });
    });
  }

  const kept = await withTenant(ctx, async (client) => (await client.query(
    `SELECT * FROM entities WHERE id = $1 AND ${TENANT}`, [keepId]
  )).rows[0]);

  return { ...merged, keep: kept };
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
