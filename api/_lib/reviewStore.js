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
import { serializeClient, assertTenantUuid } from './util/pgClient.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  getPool, withTenant as withRecordsTenant, linkDocumentToCustomer, documentsHaveUpdatedAt, linkedByForMatchBasis,
  findCustomerNameCandidates,
} from './recordsStore.js';
import { getApiKey, withBackoff } from './claude.js';
import { getDailyModelBudgetStatus } from './rateLimit.js';
import { withCache } from './promptCache.js';
import { coalesceEntityData, normalizePhoneKey, normalizeEmailKey, normalizeAddressKey, possibleDuplicatePairKey } from './integrity.js';
import {
  normalizeDocumentType,
  inferDocumentType,
  isReclassifiable,
  isShopInternalDocument,
  mayVerifyWithoutLink,
  linkNotRequired,
  resortDecision,
  inferTypeFromFilename,
  completenessFor,
  toCompletenessFields,
  AI_VERIFY_MIN_CONFIDENCE,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_DEFINITIONS,
  DOCUMENT_TYPE_IDS,
} from './documentTypes.js';
import { classifyFromText } from './modelAvoidance/textExtract.js';
import { isDeterministicClassifyEnabled } from './modelAvoidance/switches.js';
import { listOpenReminders, REMINDER_ELIGIBLE_DOCUMENT_TYPES } from './reminders.js';
import { normalizeReminderTrigger, normalizeDate, UNCONFIRMED_SUFFIX, validateCorrection } from './extractFields.js';
import { recheckDocumentTx } from './recheck.js';
import { deriveWarranty } from './warrantyRules.js';
import { packForTenant } from './industry/index.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** Thrown for both bad input (400) and a refused state transition (409).
 *  `details` (optional): structured data a caller can act on beyond the
 *  message string — e.g. createCustomer's address-duplicate refusal carries
 *  the existing customer's id/name so the client can offer "Open it" without
 *  a second round trip. api/review.js spreads it into the JSON error body
 *  when present. */
export class ReviewError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.details = details;
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
export function canVerify(doc, links, { noLinkNeeded = false } = {}) {
  if (!doc) return false;
  if (noLinkNeeded) return doc.stage === 'linked' || doc.stage === 'read' || doc.stage === 'mapped';
  return doc.stage === 'linked' && Array.isArray(links) && links.length > 0;
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
  const client = serializeClient(await getPool().connect());
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT resolve_tenant($1, $2) AS id', [
      ctx.tenantKey,
      ctx.tenantName ?? ctx.tenantKey,
    ]);
    const tenantId = rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [assertTenantUuid(tenantId)]);
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
export async function correctField(ctx, { documentId, fieldKey: rawFieldKey, value: rawValue, by: rawBy }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('fieldKey', rawFieldKey);
  assertNonEmptyString('value', rawValue);
  assertNonEmptyString('by', rawBy);
  // R34: `by` is a display label; strip control characters (a NUL is a raw Postgres error) and bound it.
  const by = String(rawBy).replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, 120);
  if (!by) throw new ReviewError('by is required');

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id, stage FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);

    // R34: a correction OVERRIDES the extracted value wherever it is read, so it gets the same vocabulary + per-kind rules
    // extraction applies (known field, real date, real number, bounded text, no control/NUL/override characters).
    const checked = validateCorrection(rawFieldKey, rawValue, await packForTenant(client).catch(() => null));
    if (!checked.ok) throw new ReviewError(checked.error, 400);
    const fieldKey = checked.fieldKey;
    const value = checked.value;

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

    // R33: a person writing the canonical date (the Inbox's "Confirm" on a "Service date 10/19/2028 is in the future —
    // check the year" chip, or a corrected year) settles the parked far-future reading: its <key>_unconfirmed row
    // goes, so the document stops asking. Only ever the SAME field's parked twin; nothing else is touched.
    let unconfirmedCleared = 0;
    if (!fieldKey.endsWith(UNCONFIRMED_SUFFIX)) {
      unconfirmedCleared = (await client.query(
        `DELETE FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT}`,
        [documentId, `${fieldKey}${UNCONFIRMED_SUFFIX}`]
      )).rowCount;
    }

    // R33: confirming (or fixing the year of) a parked install date is the moment it may reach the warranty clock —
    // the same fill-only rule ingest uses: only when the document's unit has NO install date yet, only for a date
    // the unit-install-date rules accept (never the future), via the same patch the unit page writes.
    let unitInstallFilled = null;
    if (fieldKey === 'installation_date' && unconfirmedCleared) {
      const checked = validateInstallDateInput(String(value).trim());
      if (checked.ok) {
        const unitRow = (await client.query(
          `SELECT e.id, e.data FROM extractions x JOIN entities e ON e.id = x.entity_id AND e.${TENANT}
            WHERE x.document_id = $1 AND x.${TENANT} AND e.entity_type = 'equipment' AND e.merged_into IS NULL
            ORDER BY x.created_at LIMIT 1`,
          [documentId]
        )).rows[0];
        if (unitRow && !(typeof unitRow.data?.installation_date === 'string' && unitRow.data.installation_date)) {
          const pack = await packForTenant(client);
          const { patch } = installDatePatch(unitRow.data, checked.ymd, { by, byUserId: actorClerkId ?? null, pack });
          await client.query(
            `UPDATE entities SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
            [unitRow.id, JSON.stringify(patch)]
          );
          unitInstallFilled = unitRow.id;
        }
      }
    }

    const unverified = await unverifyTx(client, documentId);
    const documentRow = unverified
      ?? (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.field_corrected',
      resourceType: 'document',
      resourceId: documentId,
      changes: { fieldKey, value, by, unverified: !!unverified, ...(unconfirmedCleared ? { unconfirmed_cleared: true } : {}), ...(unitInstallFilled ? { unit_install_date_filled: unitInstallFilled } : {}) },
    });

    return { document: documentRow, extraction };
  });
}

// ---------------------------------------------------------------------------
// Unit install date (R30, product feedback: the Dashboard's "Add install date" opened a page with no
// field to add one to).
//
// A unit's install date normally arrives from a scanned document (entities.data.installation_date is
// filled once by findOrCreateEquipment). This is the HUMAN path: a person types the date on the unit's
// own page. It is a correction in every sense the review store already uses — attributed ("entered by"),
// audited (audit_log 'review.unit_install_date_entered', with the previous value), and it replaces a
// scanned value only on purpose (the previous value is kept in the audit row and on the entry itself).
// The warranty is then re-derived exactly as extractDocument.js does (deriveWarranty + the tenant's
// industry pack), keeping a PRINTED expiry a document already gave, so entering a date can never erase
// or invent one: a brand with no verified rule still gets a stored install date and no computed expiry.
// entities.updated_at is bumped, which is what api/_lib/askCache.js's corpus_stamp reads.
// No migration: provenance lives in entities.data (`installation_date_entered`).
// ---------------------------------------------------------------------------

const INSTALL_DATE_MIN = '1950-01-01';
const INSTALL_DATE_FUTURE_MONTHS = 3; // same window extractFields.js gives a scanned installation_date

/**
 * Pure: validate what a person typed into the install-date box. Only a real calendar day in ISO
 * YYYY-MM-DD form is accepted (the browser's date input always sends that); not before 1950, and not more
 * than three months ahead of `today` (a scheduled install is real, next year's is a typo).
 * @returns {{ok: true, ymd: string} | {ok: false, error: string}}
 */
export function validateInstallDateInput(raw, today = new Date().toISOString().slice(0, 10)) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: 'Enter the install date as a full date (year, month and day).' };
  const parsed = normalizeDate(s);
  if (!parsed || parsed !== s) return { ok: false, error: 'That is not a real calendar date.' };
  if (s < INSTALL_DATE_MIN) return { ok: false, error: 'That install date is too far back. Check the year.' };
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() + INSTALL_DATE_FUTURE_MONTHS);
  if (s > limit.toISOString().slice(0, 10)) return { ok: false, error: 'That install date is in the future. Check the year.' };
  return { ok: true, ymd: s };
}

/**
 * Pure: the entities.data patch for a typed install date — the flat date, its "entered by" provenance,
 * and the re-derived warranty. Exported so scripts/verify-r30-app-fixes.mjs can check the rules with no
 * database (printed expiry kept, unverified brand keeps no computed expiry, provenance shape).
 */
export function installDatePatch(data, ymd, { by, byUserId = null, now = new Date(), pack = null } = {}) {
  const current = data && typeof data === 'object' ? data : {};
  const previous = typeof current.installation_date === 'string' && current.installation_date ? current.installation_date : null;
  const known = { ...current, installation_date: ymd };
  // A printed expiry is what a document said; it must survive a human adding the install date.
  const w = current.warranty;
  if (w && typeof w === 'object' && w.expiresBasis === 'printed' && w.expires) known.warranty_expires = w.expires;
  const warranty = deriveWarranty(known, null, pack);
  return {
    previous,
    warranty,
    patch: {
      installation_date: ymd,
      installation_date_entered: { by: String(by).slice(0, 120), byUserId: byUserId ?? null, at: now.toISOString(), previous },
      warranty,
    },
  };
}

export async function setUnitInstallDate(ctx, { entityId, installDate, by }, actorClerkId) {
  assertUuid('entityId', entityId);
  assertNonEmptyString('by', by);
  const checked = validateInstallDateInput(installDate);
  if (!checked.ok) throw new ReviewError(checked.error, 400);

  return withTenant(ctx, async (client, tenantId) => {
    const row = (await client.query(
      `SELECT id, entity_type, merged_into, data FROM entities WHERE id = $1 AND ${TENANT} FOR UPDATE`,
      [entityId]
    )).rows[0];
    if (!row) throw new ReviewError('Unit not found', 404);
    if (row.entity_type !== 'equipment') throw new ReviewError('An install date can only be set on a unit (equipment) record.', 400);
    if (row.merged_into) throw new ReviewError('That unit was merged into another record. Open the surviving record.', 409);

    const pack = await packForTenant(client);
    const { previous, warranty, patch } = installDatePatch(row.data, checked.ymd, { by, byUserId: actorClerkId ?? null, pack });

    const updated = (await client.query(
      `UPDATE entities SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND ${TENANT} RETURNING id, entity_type, data, customer_id`,
      [entityId, JSON.stringify(patch)]
    )).rows[0];

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.unit_install_date_entered',
      resourceType: 'entity',
      resourceId: entityId,
      changes: { installDate: checked.ymd, previous, by, warrantyExpires: warranty?.expires ?? null },
    });

    return { entity: updated, installDate: checked.ymd, previous, warranty };
  });
}

export async function classifyDocument(ctx, { documentId, documentType: rawDocumentType }, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('documentType', rawDocumentType);

  return withTenant(ctx, async (client, tenantId) => {
    // R34: only a real type id (the base list, or the tenant's industry pack's own) - not "<script>", not 100 KB of text.
    // A recognised alias/legacy spelling is stored in its canonical form.
    const pack = await packForTenant(client).catch(() => null);
    const wanted = String(rawDocumentType).trim().toLowerCase().replace(/[\s_]+/g, '-');
    const documentType = normalizeDocumentType(wanted, {}, pack);
    if (documentType === 'other' && wanted !== 'other') throw new ReviewError(`Unknown document type: ${wanted.slice(0, 40)}`, 400);
    // updated_at bump (M3-config/17-ask-cache-and-search-index.sql): a
    // reclassification changes document_type, which changes the label shown
    // on every answer that cites this document, but touches no other table
    // and no other timestamp — this is the one write path
    // api/_lib/askCache.js's corpus_stamp would otherwise miss entirely.
    const touch = (await documentsHaveUpdatedAt(client)) ? ', updated_at = NOW()' : '';
    const r = await client.query(
      `UPDATE documents SET document_type = $2${touch} WHERE id = $1 AND ${TENANT} RETURNING *`,
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
    const doc = (await client.query(`SELECT id, stage, document_type FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);
    const links = (await client.query(`SELECT id FROM document_entity_links WHERE document_id = $1 AND ${TENANT}`, [documentId])).rows;
    // Company paperwork and address-less invoices/receipts have nothing to link to: a person may still check them.
    const keys = new Set((await client.query(
      `SELECT field_key FROM extractions WHERE document_id = $1 AND ${TENANT} AND TRIM(COALESCE(corrected_value, value, '')) <> ''`, [documentId])).rows.map((r) => r.field_key));
    const noLinkNeeded = linkNotRequired(normalizeDocumentType(doc.document_type), keys);

    if (!canVerify(doc, links, { noLinkNeeded })) {
      throw new ReviewError('Document must be linked to at least one record before it can be verified', 409);
    }

    // Re-guards with the same WHERE the pre-check just evaluated in JS: never
    // trust the client's idea of the current stage, and close the race where
    // something else changed the stage between the SELECT above and here.
    const r = await client.query(
      `UPDATE documents SET stage = 'verified', verified_by = $2, verified_at = NOW()
        WHERE id = $1 AND ${TENANT} AND stage = ANY($3::text[])
        RETURNING *`,
      [documentId, by, noLinkNeeded ? ['linked', 'read', 'mapped'] : ['linked']]
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
      `SELECT id, entity_type, merged_into, data FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
      [[keepId, dropId]]
    )).rows;
    const keep = rows.find((r) => r.id === keepId);
    const drop = rows.find((r) => r.id === dropId);
    if (!keep || !drop) throw new ReviewError('Both entities must exist in this tenant', 404);
    if (keep.entity_type !== drop.entity_type) throw new ReviewError('Cannot merge entities of different types', 400);
    if (drop.merged_into) throw new ReviewError('Entity has already been merged', 409);

    // Fill-only: the survivor never loses a value the dropped row had
    // (phone/email/notes/aliases) — see integrity.js's coalesceEntityData.
    // Round-3 fix (2026-09-21): for a customer merge, also pass the tenant's
    // shop-contact signal, so a dropped row's leaked shop phone/email never
    // fills a blank field on the survivor. Queried directly on this same
    // client/transaction (not recordsStore.js's withTenant, which would open
    // a second pool connection mid-transaction) — cheap, one tenant row.
    let contactCtx;
    if (keep.entity_type === 'customer') {
      const t = (await client.query(
        `SELECT settings->>'phone' AS phone, settings->>'email' AS email, settings->'known_shop_contacts' AS known_shop_contacts
           FROM tenants WHERE id = $1`,
        [tenantId]
      )).rows[0];
      const known = t?.known_shop_contacts ?? {};
      contactCtx = {
        tenantPhoneKey: normalizePhoneKey(t?.phone ?? '') || null,
        tenantEmailKey: normalizeEmailKey(t?.email ?? '') || null,
        knownShopPhoneKeys: Array.isArray(known?.phones) ? known.phones : [],
        knownShopEmailKeys: Array.isArray(known?.emails) ? known.emails : [],
      };
    }
    const coalescedData = coalesceEntityData(keep.data, drop.data, contactCtx);
    await client.query(`UPDATE entities SET data = $2, updated_at = NOW() WHERE id = $1 AND ${TENANT}`, [keepId, coalescedData]);

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
/**
 * Does this document already carry a DIRECT customer link (a
 * document_entity_links row pointed at a 'customer' entity) — not merely an
 * equipment link whose entity happens to have a customer_id? Pulled out of
 * aiVerifyDocument (below) so reclassifyDocuments and routes/integrity.js's
 * classifyShopRecords fix can ask the same "no customer link" question a
 * shop-internal document is defined by, without re-deriving the JOIN.
 * Tenant-scoped like every other query in this file.
 */
export async function hasDirectCustomerLink(db, documentId) {
  const r = await db.raw(
    `SELECT 1 FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.document_id = $1 AND e.entity_type = 'customer'
        AND l.${TENANT}
      LIMIT 1`,
    [documentId]
  );
  return r.rowCount > 0;
}

/**
 * Pure decision for the shop-internal reclassification branch shared by
 * reclassifyDocuments and routes/integrity.js's classifyShopRecords: should
 * THIS document be classified 'internal' and marked AI-verified? All three
 * inputs are resolved by the caller (isShopInternalDocument is itself pure;
 * hasCustomerLink/humanClassified each need a query) so the RULE — no
 * customer link, never human-classified, and the shop-internal shape itself
 * — is pinned as a plain function scripts/verify-review.mjs can test with no
 * database, same idiom as this file's other pure state-machine helpers
 * (canVerify, wasClassifiedByHuman).
 */
export function shouldClassifyAsShopInternal({ humanClassified, hasCustomerLink, isShopInternal }) {
  return !humanClassified && !hasCustomerLink && !!isShopInternal;
}

/**
 * Classify a document with no customer link, not human-classified, whose
 * extraction rows satisfy isShopInternalDocument, as 'internal' and mark it
 * AI-verified — the same outcome extractDocument.js gives a freshly-ingested
 * shop-internal document (source 'shop-internal': document_type 'internal',
 * `no_customer: true` on its audit entry), for a document that was extracted
 * before the 'internal' type existed (round 5, 2026-09-22).
 *
 * The verify step is guarded on `document_type = 'internal'` rather than
 * recordsStore.js's verifyByAi's own link-or-entity guard: a shop-internal
 * document names no customer, unit or job (isShopInternalDocument's whole
 * definition) and so will NEVER acquire the link verifyByAi requires —
 * reusing it verbatim would classify the document and then leave it stuck
 * unverified forever, the exact fate this fix exists to end. Otherwise the
 * same idiom as verifyByAi: forward-only ('read'/'mapped'/'linked' ->
 * 'verified'), and never re-stamps a document already verified.
 *
 * Shared by reclassifyDocuments (per-id, human-triggered) and
 * routes/integrity.js's classifyShopRecords (tenant-wide sweep) so the
 * classify+verify+audit sequence is defined exactly once.
 */
export async function applyShopInternalClassification(db, { documentId, fromType, actorClerkId }) {
  // Defense in depth (reviewer, 2026-09-22): the "no customer link" rule is
  // re-derived HERE in SQL, not only in the caller's JS guard, so a link
  // created between the caller's check and this write — or any future caller
  // that skips shouldClassifyAsShopInternal — can never relabel a customer's
  // document as a shop record. NOT EXISTS mirrors hasDirectCustomerLink.
  const NO_CUSTOMER_LINK = `NOT EXISTS (
        SELECT 1 FROM document_entity_links l
        JOIN entities e ON e.id = l.entity_id AND e.entity_type = 'customer' AND e.tenant_id = documents.tenant_id
       WHERE l.document_id = documents.id AND l.tenant_id = documents.tenant_id)`;
  const typed = await db.raw(
    `UPDATE documents SET document_type = 'internal'
      WHERE id = $1 AND ${TENANT} AND ${NO_CUSTOMER_LINK}`,
    [documentId]
  );
  if (!(typed.rowCount > 0)) return null; // a customer link appeared — leave the document alone
  const verifiedResult = await db.raw(
    `UPDATE documents SET stage = 'verified', verified_by = 'ai', verified_at = NOW()
      WHERE id = $1 AND ${TENANT} AND stage IN ('read','mapped','linked') AND document_type = 'internal'
        AND ${NO_CUSTOMER_LINK}`,
    [documentId]
  );
  const verified = verifiedResult.rowCount > 0;
  await db.logAction({
    clerk_user_id: actorClerkId,
    action: 'review.shop_record_classified',
    resource_type: 'document',
    resource_id: documentId,
    changes: { from: fromType ?? null, to: 'internal', source: 'shop-internal', no_customer: true, verified },
  });
  return { documentId, from: fromType ?? null, to: 'internal' };
}

export async function aiVerifyDocument(ctx, { documentId }, actorClerkId) {
  assertUuid('documentId', documentId);

  return withRecordsTenant(ctx, async (db) => {
    const doc = await db.getDocument(documentId);
    if (!doc) throw new ReviewError('Document not found', 404);

    // R33: "Verify with AI" on a document showing "Missing information" first re-reads its own page for the missing
    // field ($0, no model — recheck.js). The Sonoran Comfort Air ticket printed "Date of Service: 10/19/2028" and this
    // button answered "Not confident enough yet"; now it finds the date, parks it as unconfirmed (far future) and
    // says exactly that. Only runs when something required is missing, so a complete document is unaffected.
    let recheck = null;
    {
      const pre = completenessFor(normalizeDocumentType(doc.document_type), toCompletenessFields(await db.listExtractionsByDocument(documentId)));
      if (pre.missing.length && doc.stage !== 'verified') {
        recheck = await recheckDocumentTx(db, documentId, { actorClerkId, source: 'ai-verify' });
      }
    }

    const rows = await db.listExtractionsByDocument(documentId); // SELECT * includes corrected_value
    const completenessFields = toCompletenessFields(rows);

    // Repair a document with no DIRECT customer link — same helper
    // extractDocument.js calls right after extraction, so pressing
    // "Reclassify & verify all" fixes old documents with no re-extraction.
    //
    // ROOT CAUSE FIX (2026-09-20, handoffs/LINKING_ROOT_CAUSE_2026-09-20.md):
    // this used to gate on `!rows.some((r) => r.entity_id)` — i.e. only ran
    // when the document had NO equipment link at all. A document already
    // linked to its equipment (`doc.stage === 'linked'`, the ordinary case)
    // was assumed to be "already fine" and skipped, even when its equipment
    // had a customer_id but no document_entity_links row pointed at that
    // customer directly — the "Margaret Henderson" defect: equipment linked,
    // customer not, and this repair never even looked because an equipment
    // link already existed. Gated on the actual thing that matters instead:
    // does a DIRECT customer link exist yet.
    if (!(await hasDirectCustomerLink(db, documentId))) {
      const facts = Object.fromEntries(completenessFields.map((f) => [f.field_key, f.value]));
      const customer = await db.findOrCreateCustomer(facts);
      if (customer?.id) {
        const customerFields = completenessFields.filter((f) => f.field_key === 'customer_name' || f.field_key === 'service_address');
        const confidence = customerFields.length ? Math.max(...customerFields.map((f) => f.confidence)) : 0.6;
        await linkDocumentToCustomer(db, {
          documentId, customerId: customer.id, confidence,
          linkedBy: linkedByForMatchBasis(customer.matchBasis),
        });
      }
    }

    const type = normalizeDocumentType(doc.document_type);
    const completeness = completenessFor(type, completenessFields);

    let verified = false;
    if (completeness.complete && completeness.minConfidence >= AI_VERIFY_MIN_CONFIDENCE) {
      verified = (await db.verifyByAi(documentId, { allowUnlinked: mayVerifyWithoutLink(type, completenessFields) })) > 0;
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
    // R33: say WHY it is not verified when the reason is an unconfirmed printed date, so the panel can show "Service
    // date 10/19/2028 is in the future — check the year" instead of a generic "still needs a person".
    const unconfirmedDates = rows
      .filter((r) => typeof r.field_key === 'string' && r.field_key.endsWith(UNCONFIRMED_SUFFIX) && (r.corrected_value ?? r.value))
      .map((r) => ({ fieldKey: r.field_key.slice(0, -UNCONFIRMED_SUFFIX.length), value: r.corrected_value ?? r.value }));
    return { document, completeness, verified: verified || !!recheck?.aiVerified, unconfirmedDates, recheck: recheck ? { filled: recheck.filled, ambiguous: recheck.ambiguous ?? [] } : null };
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
 * Round 5 (2026-09-22): a shop-internal check (isShopInternalDocument) runs
 * FIRST for every requested id, regardless of isReclassifiable — see the
 * comment at that check below for why a canonical-but-wrong pre-'internal'
 * type would otherwise never be touched.
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

        const classificationRows = await db.getAuditLog({
          action: 'review.document_classified', resource_type: 'document', resource_id: id,
        });
        const humanClassified = wasClassifiedByHuman(doc.document_type, classificationRows);

        const rows = await db.listExtractionsByDocument(id);
        const completenessFields = toCompletenessFields(rows);

        // Round 5 (2026-09-22, live founder-account defect): a document
        // ingested BEFORE the 'internal' type existed — typed 'dispatch-note'
        // or 'correspondence' by the old heuristic, naming no customer at
        // all — is a canonical type, so isReclassifiable below says "someone
        // already decided this" and leaves it alone forever. Checked for
        // EVERY requested id, ahead of that gate: isShopInternalDocument is a
        // stronger, purely factual signal (same precedence extractDocument.js
        // gives it over the model's own guess), and a document meeting it can
        // never acquire a customer link no matter how many times it's
        // reclassified — the very reason it's stuck in "Needs linking".
        const isShopInternal = isShopInternalDocument(completenessFields);
        if (!humanClassified && isShopInternal) {
          const hasCustomerLink = await hasDirectCustomerLink(db, id);
          if (shouldClassifyAsShopInternal({ humanClassified, hasCustomerLink, isShopInternal })) {
            return applyShopInternalClassification(db, { documentId: id, fromType: doc.document_type, actorClerkId });
          }
        }

        if (!isReclassifiable(doc.document_type)) return null;
        if (humanClassified) return null;

        const facts = Object.fromEntries(completenessFields.map((f) => [f.field_key, f.value]));
        let resolved = doc.document_type ? normalizeDocumentType(doc.document_type, facts) : 'other';
        if (resolved === 'other') resolved = inferDocumentType(facts, doc.original_filename);

        // R32 (Team M): a document whose own TITLE line names its type ("Service Ticket", "Purchase Order"...) is
        // classified from the stored page text at $0 before any model call. CLASSIFY_DETERMINISTIC=0 turns this off.
        if (resolved === 'other' && isDeterministicClassifyEnabled()) {
          const pages = await db.listPages(id);
          const hit = classifyFromText(pages.map((p) => ({ page_no: p.page_no, text: p.text ?? '' })));
          if (hit && hit.type !== 'other' && hit.type !== 'internal' && DOCUMENT_TYPES.some((t) => t.id === hit.type)) resolved = hit.type;
        }

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

/**
 * ONE-TIME RE-SORT (document-rules round, 2026-10-09). Owner-triggered from Needs you ("Sort my documents") and
 * admin-only. For one bounded page of this tenant's documents it:
 *   1. moves documents typed invoice / other / correspondence / dispatch-note to a better type ONLY when a title line
 *      on the stored page text or the file name confidently says so (documentTypes.js resortDecision) - never a
 *      document a person classified, and no model call at all;
 *   2. then runs the same automatic check a new document gets: a complete, readable document that needs no
 *      customer link (company paperwork, an address-less invoice or receipt) is marked checked by "ai".
 * Tenant-scoped (RLS + explicit tenant filters), no schema change, idempotent (a second run finds nothing to move and
 * nothing to check), keyset-paged: the caller passes back `nextAfterId` until `done`. $0.
 */
export const RESORT_SOURCE_LIST = ['invoice', 'other', 'correspondence', 'dispatch-note'];
export async function resortDocuments(ctx, { afterId = null, limit = 100 } = {}, actorClerkId) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  if (afterId != null && !isUuid(afterId)) throw new ReviewError('afterId must be a uuid', 400);
  const types = [...RESORT_SOURCE_LIST, 'proposal-quote', 'purchase-order', 'internal', 'receipt', 'agreement', 'delivery-ticket', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter'];

  const page = await withRecordsTenant(ctx, async (db) => {
    const r = await db.raw(
      `SELECT id, document_type, original_filename, stage FROM documents
        WHERE ${TENANT} AND document_type = ANY($1::text[]) AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id LIMIT $3`,
      [types, afterId, cap + 1]
    );
    return r.rows;
  });
  const hasMore = page.length > cap;
  const docs = page.slice(0, cap);
  const summary = { scanned: docs.length, retyped: 0, checked: 0, byType: {}, errors: 0, done: !hasMore, nextAfterId: hasMore ? docs[docs.length - 1].id : null };
  const changes = [];

  for (const d of docs) {
    try {
      const out = await withRecordsTenant(ctx, async (db) => {
        const doc = await db.getDocument(d.id);
        if (!doc) return null;
        let type = normalizeDocumentType(doc.document_type);
        let moved = null;
        if (RESORT_SOURCE_LIST.includes(type)) {
          const classificationRows = await db.getAuditLog({ action: 'review.document_classified', resource_type: 'document', resource_id: d.id });
          if (!wasClassifiedByHuman(doc.document_type, classificationRows)) {
            const pages = await db.listPages(d.id);
            const hit = classifyFromText(pages.map((p) => ({ page_no: p.page_no, text: p.text ?? '' })));
            const next = resortDecision({ currentType: type, filename: doc.original_filename, titleType: hit?.type ?? null });
            if (next) {
              await db.updateDocument(d.id, { document_type: next });
              await db.logAction({
                clerk_user_id: actorClerkId, action: 'review.document_resorted', resource_type: 'document', resource_id: d.id,
                changes: { from: type, to: next, source: hit?.type === next ? 'title' : 'filename', model_calls: 0 },
              });
              moved = { documentId: d.id, from: type, to: next };
              type = next;
            }
          }
        }
        let checked = false;
        if (doc.stage !== 'verified') {
          const fields = toCompletenessFields(await db.listExtractionsByDocument(d.id));
          const c = completenessFor(type, fields);
          if (c.complete && c.minConfidence >= AI_VERIFY_MIN_CONFIDENCE && mayVerifyWithoutLink(type, fields)) {
            checked = (await db.verifyByAi(d.id, { allowUnlinked: true })) > 0;
            if (checked) {
              await db.logAction({
                clerk_user_id: actorClerkId, action: 'review.ai_verified', resource_type: 'document', resource_id: d.id,
                changes: { completeness: c, source: 'resort' },
              });
            }
          }
        }
        return { moved, checked };
      });
      if (out?.moved) { summary.retyped++; summary.byType[out.moved.to] = (summary.byType[out.moved.to] ?? 0) + 1; changes.push(out.moved); }
      if (out?.checked) summary.checked++;
    } catch (err) {
      summary.errors++;
      console.error('resortDocuments: document failed, continuing:', d.id, err?.message);
    }
  }

  if (changes.length) {
    await withRecordsTenant(ctx, async (db) => {
      await db.logAction({ clerk_user_id: actorClerkId, action: 'review.resorted', resource_type: 'document', changes: { count: changes.length, byType: summary.byType } });
    });
  }
  return summary;
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

/**
 * `createCustomer {name, serviceAddress?, phone?, email?, notes?,
 * confirmDuplicate?}` — a human creating a customer record directly, distinct
 * from findOrCreateCustomer's document-driven inference (recordsStore.js):
 * here the human IS the source of truth, so there is no name/address
 * matching to do, only a fresh row and a fresh number.
 *
 * Owner defect report (2026-09-22): the manual "Add customer" form used to
 * create a second record outright when an address already had one on file
 * (this is exactly how "Sorensen" ended up alongside "Donna Thornton" at 174
 * N College Ave) — no different-name-same-address duplicates were CAUSED by
 * this path alone, but nothing stopped it from causing more. When
 * `serviceAddress` is given and matches an EXISTING non-merged customer's
 * address (normalizeAddressKey — same identity rule the integrity scan
 * uses), this refuses with a 409 and `details: {existingCustomerId,
 * existingCustomerName}` so the client can offer "Open it" / "Add anyway"
 * (the CustomersScreen create form's job, not this function's). Passing
 * `confirmDuplicate: true` is exactly "Add anyway" — creates the record
 * regardless, same as if no address had matched at all. A customer with NO
 * address given never has anything to check against.
 */
/** Pure: which (if any) of `rows` ([{id, customer_number, name, address}])
 *  already sits at `addrKey` (a normalizeAddressKey() result) — the exact
 *  search createCustomer's address-conflict check runs, split out so it's
 *  checkable against a plain array, no database. Exported for
 *  scripts/verify-review.mjs. */
export function findExistingByAddress(rows, addrKey) {
  if (!addrKey) return null;
  return (rows ?? []).find((r) => normalizeAddressKey(r.address) === addrKey) ?? null;
}

export async function createCustomer(ctx, { name, serviceAddress, phone, email, notes, confirmDuplicate } = {}, actorClerkId) {
  assertNonEmptyString('name', name);

  const trimmedAddress = isNonEmptyString(serviceAddress) ? serviceAddress.trim() : '';
  if (trimmedAddress && !confirmDuplicate) {
    const addrKey = normalizeAddressKey(trimmedAddress);
    if (addrKey) {
      const existing = await withRecordsTenant(ctx, async (db) => {
        const rows = await db.raw(
          `SELECT id, customer_number, data->>'customer_name' AS name, data->>'service_address' AS address
             FROM entities
            WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
              AND data->>'service_address' IS NOT NULL AND data->>'service_address' <> ''
            LIMIT 2000`,
          []
        );
        return findExistingByAddress(rows.rows, addrKey);
      });
      if (existing) {
        throw new ReviewError(
          `A customer already exists at this address: ${existing.name || existing.customer_number || 'Unnamed'}`,
          409,
          { existingCustomerId: existing.id, existingCustomerName: existing.name ?? null, existingCustomerNumber: existing.customer_number ?? null }
        );
      }
    }
  }

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

/**
 * `keepCustomersSeparate {aId, bId}` — the flip side of mergeCustomers for a
 * possible-duplicate pair (routes/customers.js's planPossibleDuplicates): a
 * person looked at "Donna Thornton" / "Sorensen" sharing an address and
 * confirmed they are genuinely two different customers. Writes a durable
 * audit_log row (no DDL — same everything-lives-in-existing-tables pattern as
 * reminders.js) keyed by the pair's order-independent
 * possibleDuplicatePairKey, so planPossibleDuplicates (and the customer
 * profile's own duplicate list) can exclude it forever without a schema
 * change. Any signed-in tenant member may decide this — unlike a merge, it
 * is not destructive and has nothing to undo, so it gets no admin gate.
 */
export async function keepCustomersSeparate(ctx, { aId, bId } = {}, actorClerkId) {
  assertUuid('aId', aId);
  assertUuid('bId', bId);
  if (aId === bId) throw new ReviewError('aId and bId must differ');

  return withTenant(ctx, async (client, tenantId) => {
    const rows = (await client.query(
      `SELECT id FROM entities WHERE id = ANY($1::uuid[]) AND entity_type = 'customer' AND ${TENANT}`,
      [[aId, bId]]
    )).rows;
    if (rows.length < 2) throw new ReviewError('Both customers must exist in this tenant', 404);

    const pairKey = possibleDuplicatePairKey(aId, bId);
    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'customers.keep_separate',
      resourceType: 'entity',
      resourceId: aId,
      changes: { pairKey, aId, bId },
    });
    return { ok: true, pairKey };
  });
}

/** The alert tiers a dismissal can ever be recorded against — the same set
 *  api/_lib/warrantyRules.js's `alertTier` can bucket a unit into. Kept as a
 *  plain array (not imported from warrantyRules.js) so this file's only
 *  coupling to that module stays "the string happens to match", the same
 *  arm's-length relationship reviewStore.js already keeps with every other
 *  pure-rules file it writes audit_log rows about. */
const DISMISSIBLE_ALERT_TIERS = new Set([
  'expired', 'expiring-30', 'expiring-90', 'expiring-365', 'unregistered-window-closing',
]);

/**
 * `dismissAlert {equipmentId, tier, dismissed}` (owner defect report
 * 2026-09-22, item 2a): Dismiss (dismissed: true, the default) or Undo
 * (dismissed: false) one unit's alert at one tier. An ordinary audit_log row
 * (action 'alert.dismissed', resource_type 'equipment') — routes/
 * customers.js's resolveDismissedAlertKeys takes the LATEST row per
 * {equipmentId, tier} as the current state, so Undo never has to delete
 * anything and a NEW tier (expiring-90 -> expired) always re-alerts, since
 * it is a different key. No admin gate: dismissing an alert is reversible
 * and affects nobody's data, only what this tenant's alert lists show.
 */
export async function dismissAlert(ctx, { equipmentId, tier, dismissed = true } = {}, actorClerkId) {
  assertUuid('equipmentId', equipmentId);
  if (!DISMISSIBLE_ALERT_TIERS.has(tier)) {
    throw new ReviewError(`tier must be one of: ${[...DISMISSIBLE_ALERT_TIERS].join(', ')}`);
  }

  return withTenant(ctx, async (client, tenantId) => {
    const rows = (await client.query(
      `SELECT id FROM entities WHERE id = $1 AND entity_type = 'equipment' AND ${TENANT}`,
      [equipmentId]
    )).rows;
    if (rows.length < 1) throw new ReviewError('Equipment not found', 404);

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'alert.dismissed',
      resourceType: 'equipment',
      resourceId: equipmentId,
      changes: { tier, dismissed: !!dismissed },
    });
    return { ok: true };
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

// ---------------------------------------------------------------------------
// Customer reminders (build 2026-09-22). State lives entirely in existing
// tables — see reminders.js's own module comment — so nothing here is a new
// state machine, just three thin actions over it: list the open ones, mark
// one done, and the "Fix this document" one-click that creates (or reuses) a
// customer for a reminder that named someone extraction never linked.
// ---------------------------------------------------------------------------

/** `remindersList {customerId?, limit?}` — every open reminder on file,
 *  optionally scoped to one customer. Tenant-scoped; any member may read it
 *  (same as listLinks/listCorrections above — no admin gate). */
export async function remindersList(ctx, { customerId, limit } = {}) {
  if (customerId != null) assertUuid('customerId', customerId);
  return withTenant(ctx, async (client) => {
    const reminders = await listOpenReminders({ raw: (sql, params) => client.query(sql, params) }, { customerId, limit });
    return { reminders };
  });
}

/** `reminderDone {documentId}` — marks a reminder resolved by writing an
 *  audit_log row (action 'reminder.done'); reminders.js's
 *  resolveOpenReminders reads it back out. Any member may do this. */
export async function reminderDone(ctx, { documentId } = {}, actorClerkId) {
  assertUuid('documentId', documentId);
  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'reminder.done',
      resourceType: 'document',
      resourceId: documentId,
      changes: {},
    });
    return { ok: true, documentId };
  });
}

/**
 * `createCustomerAndAttachReminder {documentId, name}` — the "Fix this
 * document" one-click for a reminder that named a customer extraction could
 * not find (see extractDocument.js's own reminder-linking step). Reuses
 * findCustomerNameCandidates (recordsStore.js — the same exact/fuzzy-surname
 * match findOrCreateCustomer and contactLookup.js both use) so this can never
 * create a duplicate of a customer that already exists:
 *   - exactly one candidate  -> attach to it (no new row)
 *   - 2+ candidates          -> refuse to guess; return them for the person
 *                               to pick (the client then calls
 *                               assignDocumentCustomer with the chosen id)
 *   - zero candidates        -> create a fresh customer, then attach
 */
export async function createCustomerAndAttachReminder(ctx, { documentId, name } = {}, actorClerkId) {
  assertUuid('documentId', documentId);
  assertNonEmptyString('name', name);
  const trimmedName = name.trim();

  return withTenant(ctx, async (client, tenantId) => {
    const doc = (await client.query(`SELECT id FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    if (!doc) throw new ReviewError('Document not found', 404);

    const raw = (sql, params) => client.query(sql, params);
    const candidates = await findCustomerNameCandidates({ raw }, trimmedName);
    if (candidates.length > 1) {
      return {
        usedExisting: false,
        ambiguous: true,
        candidates: candidates.map((c) => ({ id: c.id, name: c.customer_name, address: c.service_address })),
      };
    }

    let customerRow = candidates[0] ?? null;
    const usedExisting = !!customerRow;
    if (!customerRow) {
      const numRow = await client.query('SELECT next_customer_number($1) AS num', [tenantId]);
      const created = await client.query(
        `INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
         VALUES ($1,'customer',$2,$3,NOW(),NOW()) RETURNING *`,
        [tenantId, { customer_name: trimmedName }, numRow.rows[0]?.num ?? null]
      );
      customerRow = created.rows[0];
      await logAction(client, tenantId, {
        clerkUserId: actorClerkId,
        action: 'review.customer_created',
        resourceType: 'entity',
        resourceId: customerRow.id,
        changes: { name: trimmedName, customerNumber: customerRow.customer_number, source: 'reminder' },
      });
    }

    await client.query(
      `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
       VALUES ($1,$2,$3,1.0,'ai:reminder',NOW())
       ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
      [tenantId, documentId, customerRow.id]
    );
    await client.query(
      `UPDATE documents SET stage = 'linked' WHERE id = $1 AND ${TENANT} AND stage IN ('received','read','mapped')`,
      [documentId]
    );

    await logAction(client, tenantId, {
      clerkUserId: actorClerkId,
      action: 'review.document_customer_assigned',
      resourceType: 'document',
      resourceId: documentId,
      changes: { customerId: customerRow.id, usedExisting, source: 'reminder' },
    });

    const documentRow = (await client.query(`SELECT * FROM documents WHERE id = $1 AND ${TENANT}`, [documentId])).rows[0];
    return { usedExisting, ambiguous: false, customer: customerRow, document: documentRow };
  });
}

const REMINDER_EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5';
const MAX_REMINDER_MODEL_CALLS = 20;
const REMINDER_SOURCE_TEXT_CHARS = 4000;

const REMINDER_TOOL = {
  name: 'extract_reminder',
  description: 'Pull one actionable reminder for a customer\'s next visit out of this HVAC shop document, if it states one.',
  input_schema: {
    type: 'object',
    properties: {
      reminder_text: { type: 'string', description: 'The actionable instruction, in the words of the document, 200 characters or fewer. Omit entirely if the document states no forward-looking reminder.' },
      reminder_customer_name: { type: 'string', description: 'The customer the reminder is about, if the document names one. Omit if reminder_text is omitted, or names no customer.' },
      reminder_trigger: { type: 'string', description: '"next_visit" if the reminder should happen on the customer\'s next visit, or a specific date as YYYY-MM-DD. Omit if reminder_text is omitted.' },
    },
  },
};

const REMINDER_SYSTEM_PROMPT = `Some HVAC shop documents (internal memos, dispatch notes, correspondence) carry a reminder for whoever visits a customer next — e.g. "Reminder logged for Karen Abernathy's account: confirm filter size on next visit." Read the text and report one with the extract_reminder tool, if there is one. Never invent one from a routine work-performed line describing what was already done. If the document states no forward-looking reminder, call the tool with no fields set.`;

/** One cheap Haiku call, same bounded-timeout/never-throws contract as
 *  reclassifyDocuments' own classifyByModel. Returns the tool's raw input
 *  object (still needs extractFields.js's normalizers applied), or null. */
async function extractReminderByModel(client, { filename, text, timeoutMs }) {
  try {
    const dynamicPrompt = `Filename: ${filename || '(none)'}\n\nText:\n${text}`;
    const response = await withBackoff(() => client.messages.create({
      model: REMINDER_EXTRACT_MODEL,
      max_tokens: 300,
      system: [withCache({ type: 'text', text: REMINDER_SYSTEM_PROMPT }, REMINDER_EXTRACT_MODEL)],
      tools: [withCache(REMINDER_TOOL, REMINDER_EXTRACT_MODEL)],
      tool_choice: { type: 'tool', name: REMINDER_TOOL.name },
      messages: [{ role: 'user', content: dynamicPrompt }],
    }, { timeout: timeoutMs }), { deadlineAt: Date.now() + timeoutMs });
    return response.content.find((b) => b.type === 'tool_use')?.input ?? null;
  } catch (err) {
    console.error('extractReminders model call failed:', err?.message);
    return null;
  }
}

/**
 * `extractReminders {documentIds}` — the backfill admin action (build brief
 * item 5): a document extracted BEFORE this build only ever gets a
 * reminder_text if this is run on it explicitly. Modeled directly on
 * reclassifyDocuments above (same per-document transaction, same
 * modelCallBudget wall-clock/call-count ceiling, same "never throws, a failed
 * document is skipped not fatal") — billing-gated the same way in
 * api/review.js (MODEL_BILLED_ACTIONS).
 *
 * Deliberately does NOT use recordsStore.js's replaceDocumentFields: that
 * function REPLACES every extraction on the document, which would silently
 * erase every field a prior extraction pass already wrote. A plain INSERT
 * (no facet — same "add one that was never extracted" shape correctField
 * above already uses) is additive instead.
 */
export async function extractReminders(ctx, { documentIds } = {}, actorClerkId) {
  const ids = [...new Set((documentIds ?? []).filter(isUuid))].slice(0, 100);
  if (!ids.length) return { changes: [], remaining: 0 };

  const deadlineAt = Date.now() + RECLASSIFY_DEADLINE_MS;
  let modelCalls = 0;
  let client = null;
  const changes = [];
  let remaining = 0;
  const budgetStatus = await getDailyModelBudgetStatus(ctx);

  for (const id of ids) {
    try {
      const change = await withTenant(ctx, async (pgClient, tenantId) => {
        const doc = (await pgClient.query(
          `SELECT id, document_type, original_filename FROM documents WHERE id = $1 AND ${TENANT}`,
          [id]
        )).rows[0];
        if (!doc) return null;
        if (!REMINDER_ELIGIBLE_DOCUMENT_TYPES.has(normalizeDocumentType(doc.document_type))) return null;

        const already = (await pgClient.query(
          `SELECT 1 FROM extractions WHERE document_id = $1 AND field_key = 'reminder_text' AND ${TENANT} LIMIT 1`,
          [id]
        )).rowCount > 0;
        if (already) return null; // never re-extract a reminder already on file

        const budget = modelCalls < MAX_REMINDER_MODEL_CALLS && !budgetStatus.exceeded
          ? modelCallBudget(deadlineAt - Date.now())
          : null;
        if (budget == null) { remaining++; return null; }

        const pages = (await pgClient.query(
          `SELECT text FROM document_pages WHERE document_id = $1 AND ${TENANT} ORDER BY page_no`,
          [id]
        )).rows;
        const text = pages.map((p) => p.text).filter(Boolean).join('\n').slice(0, REMINDER_SOURCE_TEXT_CHARS).trim();
        if (!text) return null;

        modelCalls++;
        client ??= new Anthropic({ apiKey: getApiKey(), timeout: MODEL_CALL_MAX_TIMEOUT_MS, maxRetries: 0 });
        const result = await extractReminderByModel(client, { filename: doc.original_filename, text, timeoutMs: budget });

        const { fields: normalized } = normalizeFieldsForReminder(result);
        const reminderText = normalized.reminder_text ?? null;
        if (!reminderText) return null;

        for (const [fieldKey, value] of Object.entries(normalized)) {
          if (!value) continue;
          await pgClient.query(
            `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
             VALUES ($1,$2,$3,$4,0.7,NOW())`,
            [tenantId, id, fieldKey, value]
          );
        }

        // Link to the named customer if we can — same exact/fuzzy-surname
        // match extractDocument.js's own pipeline uses; never creates one.
        let linked = false;
        if (normalized.reminder_customer_name) {
          const raw = (sql, params) => pgClient.query(sql, params);
          const candidates = await findCustomerNameCandidates({ raw }, normalized.reminder_customer_name);
          if (candidates.length === 1) {
            const inserted = await pgClient.query(
              `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
               VALUES ($1,$2,$3,0.6,'ai:reminder',NOW())
               ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
              [tenantId, id, candidates[0].id]
            );
            linked = inserted.rowCount > 0;
            if (linked) {
              await pgClient.query(
                `UPDATE documents SET stage = 'linked' WHERE id = $1 AND ${TENANT} AND stage IN ('received','read','mapped')`,
                [id]
              );
            }
          }
        }

        await logAction(pgClient, tenantId, {
          clerkUserId: actorClerkId,
          action: 'review.reminder_extracted',
          resourceType: 'document',
          resourceId: id,
          changes: { reminderText, reminderCustomerName: normalized.reminder_customer_name ?? null, reminderTrigger: normalized.reminder_trigger ?? null, linked },
        });

        return { documentId: id, reminderText };
      });
      if (change) changes.push(change);
    } catch (err) {
      console.error('extractReminders: document failed, continuing:', id, err?.message);
    }
  }

  return { changes, remaining };
}

/** Pure: apply extractFields.js's own reminder normalization rules
 *  (200-char cap, reminder_trigger validation) to one model tool-call result,
 *  without going through normalizeFields' full array shape (this is always
 *  exactly the three reminder keys, never a mixed batch). Exported so the
 *  rule is testable with no database. */
export function normalizeFieldsForReminder(raw) {
  const text = typeof raw?.reminder_text === 'string' ? raw.reminder_text.trim().slice(0, 200) : '';
  const customerName = typeof raw?.reminder_customer_name === 'string' ? raw.reminder_customer_name.trim().slice(0, 500) : '';
  const trigger = normalizeReminderTrigger(raw?.reminder_trigger);
  return {
    fields: {
      reminder_text: text || null,
      reminder_customer_name: customerName || null,
      // A trigger with no reminder_text at all is meaningless — never stored.
      reminder_trigger: text ? trigger : null,
    },
  };
}
