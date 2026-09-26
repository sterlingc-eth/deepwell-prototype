/**
 * Naming engine — assignment/backfill/rename (M3-config/41-document-display-names.sql).
 *
 * `assignDisplayName` is the hook G4's ingest pipeline calls right after classification/
 * extraction lands (same shape as api/_lib/graph/build.js's `refreshGraphForDocument`:
 * `{withTenant, ctxArg, documentId} -> result`, never throws on a document that isn't ready yet).
 * `runNamingBackfillBatch`/`namingBackfillStatus` are the admin bulk path (api/_lib/routes/
 * naming.js), bounded + resumable, same afterId-cursor shape as financials/backfill.js's
 * runJobKeyBackfill — no model call anywhere in this file, so no cost cap, only a deadline.
 *
 * "Only assign when the type is confirmed" (round 12 contract): confirmed means EITHER
 * documents.verified_by is set (a human, or `verifyByAi` — see extractDocument.js) OR the most
 * recent classification logged a confidence >= AI_VERIFY_MIN_CONFIDENCE (documentTypes.js's own
 * 0.85 bar — the SAME threshold `verifyByAi` itself requires, just checked independently here
 * since a document can be confidently typed while still missing a required field or two, which
 * keeps `aiVerified`/`verified_by` from ever being set even though the type itself is not in
 * doubt). Anything less and this returns without writing a name — the chain falls through to the
 * filename, exactly like a null answer falls through in api/ask.js.
 */
import { normalizeDocumentType, AI_VERIFY_MIN_CONFIDENCE } from '../documentTypes.js';
import { withTenant as defaultWithTenant } from '../recordsStore.js';
import { computeDisplayName, dedupeDisplayName, sanitizeDisplayName, MAX_DISPLAY_NAME_LENGTH } from './engine.js';
import {
  isUuid, getNamingDocument, getClassificationConfidence, getNamingFields, getNamingEntities,
  linkedCustomerId, siblingDisplayNames, writeDisplayName, listBackfillCandidates, namingCounts,
  displayNameColumnsExist,
} from './store.js';

export { namingCounts as namingBackfillStatusRaw };

/** True when this document's TYPE (not necessarily every required field) is confirmed enough to
 *  name — see this file's header. Exported for scripts/verify-document-names.mjs. */
export async function isTypeConfirmed(db, doc, documentId) {
  if (doc.verified_by) return { confirmed: true, basis: 'verified_by' };
  const classification = await getClassificationConfidence(db, documentId);
  if (classification && classification.confidence >= AI_VERIFY_MIN_CONFIDENCE) {
    return { confirmed: true, basis: 'confidence', confidence: classification.confidence };
  }
  return { confirmed: false, basis: null };
}

/** Core, non-transactional step: given a `db` already inside a tenant transaction (withTenant's
 *  store), compute and — unless something says not to — persist this one document's display
 *  name. Shared by `assignDisplayName` (opens its own transaction) and the backfill batch loop
 *  (one transaction, many documents) so the two never disagree about what "assign" means. */
async function assignOne(db, documentId) {
  const doc = await getNamingDocument(db, documentId);
  if (!doc) return { assigned: false, reason: 'not_found', documentId };
  if (doc.display_name_source === 'user') {
    return { assigned: false, reason: 'user_named', documentId, displayName: doc.display_name };
  }
  if (doc.display_name) {
    return { assigned: false, reason: 'already_named', documentId, displayName: doc.display_name };
  }
  if (!doc.document_type) return { assigned: false, reason: 'not_classified', documentId };

  const { confirmed } = await isTypeConfirmed(db, doc, documentId);
  if (!confirmed) return { assigned: false, reason: 'not_confirmed', documentId };

  const fields = await getNamingFields(db, documentId);
  const entities = await getNamingEntities(db, documentId);
  const typeId = normalizeDocumentType(doc.document_type, fields);
  const base = computeDisplayName({ typeId, fields, entities });
  if (!base) return { assigned: false, reason: 'insufficient_fields', documentId, typeId };

  const customerId = await linkedCustomerId(db, documentId);
  const dateKey = fields.service_date ?? fields.installation_date ?? null;
  const siblings = await siblingDisplayNames(db, { documentId, typeId, customerId, dateKey });
  const finalName = dedupeDisplayName(base, siblings);

  const wrote = await writeDisplayName(db, documentId, finalName, 'auto');
  return wrote
    ? { assigned: true, documentId, typeId, displayName: finalName }
    : { assigned: false, reason: 'columns_missing', documentId, typeId };
}

/**
 * Idempotent — a document that already has a display_name (auto OR user) is left untouched;
 * calling this twice on the same document does nothing the second time. Never throws: a
 * document that isn't ready to be named yet (wrong stage, low confidence, migration 41 not
 * pasted) is a normal, expected result, not an error the caller needs to catch.
 *
 * @param {{withTenant: Function, ctxArg: {tenantKey: string, tenantName?: string}, documentId: string}} opts
 */
export async function assignDisplayName({ withTenant, ctxArg, documentId }) {
  if (!isUuid(documentId)) return { assigned: false, reason: 'invalid_id', documentId };
  return withTenant(ctxArg, (db) => assignOne(db, documentId));
}

const BACKFILL_DEFAULTS = Object.freeze({ limit: 50, hardMaxLimit: 500, deadlineMs: 20_000 });

/**
 * One bounded, resumable batch over documents with a confirmed type and no display_name yet.
 * Same afterId-cursor / deadline shape as financials/backfill.js's runJobKeyBackfill and
 * graph/build.js's refreshGraphBatch — call repeatedly with the returned `nextCursor` until
 * `remaining` is 0. A document that turns out not to qualify after all (confidence too low,
 * insufficient fields) is still "processed" — its id advances the cursor — it just isn't
 * counted as `named`, so one unnameable document can never stall the batch.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{afterId?: string|null, limit?: number, deadlineMs?: number, withTenantFn?: Function}} [opts]
 */
export async function runNamingBackfillBatch(ctx, opts = {}) {
  const wt = opts.withTenantFn ?? defaultWithTenant;
  const limit = Math.max(1, Math.min(BACKFILL_DEFAULTS.hardMaxLimit, Math.trunc(Number(opts.limit)) || BACKFILL_DEFAULTS.limit));
  const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : BACKFILL_DEFAULTS.deadlineMs;
  const afterId = typeof opts.afterId === 'string' && isUuid(opts.afterId) ? opts.afterId : null;

  return wt(ctx, async (db) => {
    if (!(await displayNameColumnsExist(db))) {
      return { enabled: false, processed: 0, named: 0, skipped: 0, remaining: 0, nextCursor: null, stoppedReason: 'table_missing' };
    }
    const candidates = await listBackfillCandidates(db, { afterId, limit });
    const deadlineAt = Date.now() + deadlineMs;
    let processed = 0;
    let named = 0;
    let skipped = 0;
    let cursor = afterId;
    let stoppedReason = null;
    for (const id of candidates) {
      if (Date.now() > deadlineAt) { stoppedReason = 'deadline'; break; }
      const r = await assignOne(db, id);
      processed++;
      if (r.assigned) named++; else skipped++;
      if (cursor == null || id > cursor) cursor = id;
    }
    const counts = await namingCounts(db);
    return {
      enabled: true, processed, named, skipped,
      remaining: counts.remaining, eligible: counts.eligible,
      nextCursor: candidates.length ? cursor : null,
      stoppedReason: stoppedReason ?? (candidates.length === 0 ? 'done' : 'batch_complete'),
    };
  });
}

export async function namingBackfillStatus(ctx, { withTenantFn } = {}) {
  const wt = withTenantFn ?? defaultWithTenant;
  return wt(ctx, (db) => namingCounts(db));
}

/**
 * A person editing a document's title by hand (Review/EntityScreen "Rename" control) — always
 * source 'user', always wins over any future auto-assignment or backfill pass (assignOne's own
 * `display_name_source === 'user'` short-circuit, and writeDisplayName's own guard for anyone
 * else who tries to write 'auto' over it). An empty/whitespace-only name CLEARS the override
 * (falls back to documentName()'s own derivation) rather than storing an empty string.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{documentId: string, name: string}} opts
 */
export async function renameDocument(ctx, { documentId, name } = {}, { withTenantFn } = {}) {
  const wt = withTenantFn ?? defaultWithTenant;
  if (!isUuid(documentId)) return { renamed: false, reason: 'invalid_id' };
  const cleaned = sanitizeDisplayName(name);

  return wt(ctx, async (db) => {
    const doc = await getNamingDocument(db, documentId);
    if (!doc) return { renamed: false, reason: 'not_found' };
    if (!cleaned) {
      // Clearing a user-set name: revert to 'auto' (empty display_name means "let
      // documentName() derive one again", not "call this document nothing").
      const ok = await writeDisplayName(db, documentId, null, 'auto', { force: true });
      return ok ? { renamed: true, documentId, displayName: null } : { renamed: false, reason: 'columns_missing' };
    }
    const ok = await writeDisplayName(db, documentId, cleaned, 'user', { force: true });
    return ok
      ? { renamed: true, documentId, displayName: cleaned }
      : { renamed: false, reason: 'columns_missing' };
  });
}

export { MAX_DISPLAY_NAME_LENGTH };
