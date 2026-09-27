/**
 * Raises/resolves the ONE audience question ("Is this for the team only?") in the EXISTING clean
 * exception queue (intake_needs_info, M3-config/43) — owner ask (a): a document classify.js
 * couldn't confidently place gets exactly this one precise question, shown in the same Inbox
 * queue every other autofill question already lives in (src/components/intake/**), never a
 * separate UI of its own.
 *
 * Deliberately its own small file rather than added to ./autofill.js's private upsertNeedsInfo:
 * that function isn't exported (it's `upsertNeedsInfo`'s own module-private helper, called only
 * from autofill.js's field-conflict/entity-pick flows, both of which shape `candidates` very
 * differently from this feature's plain two-way {value,label} choice) — same "new, small, focused
 * file under an owned directory" idiom this round's contract already uses for
 * ../search/knowledge.js's own additions. Only `needsInfoTableExists` is reused (imported,
 * read-only) since it's the exact same tolerance-of-migration-43-not-pasted-yet probe this file
 * needs too.
 */
import { TENANT_SQL } from '../scope.js';
import { needsInfoTableExists } from './autofill.js';

export const AUDIENCE_FIELD_KEY = 'audience';

/** ../audience/classify.js's own uses a `{query}`-shaped db (raw pg client or the same adapter
 *  ../audience/store.js's callers already pass); needsInfoTableExists wants `.raw` — same tiny
 *  adapter this codebase already uses in ./queue.js's own asQueryable(). */
function asRawQueryable(db) {
  return { raw: (sql, params) => db.query(sql, params) };
}

/**
 * Opens (or refreshes) an open 'audience' question for this document. A no-op when
 * intake_needs_info (M3-config/43) hasn't been pasted yet — same tolerance every other reader/
 * writer of that table already has (see autofill.js's own header) — the document's audience is
 * still set correctly by ../audience/store.js regardless; only the exception-queue prompt is
 * unavailable until the migration lands.
 */
export async function raiseAudienceQuestion(db, documentId, { question } = {}) {
  if (!(await needsInfoTableExists(asRawQueryable(db)))) return { raised: false };
  await db.query(
    `INSERT INTO intake_needs_info
        (tenant_id, document_id, entity_id, field_key, question, candidates, status, created_at, updated_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, NULL, $2, $3,
             '[{"value":"customer","label":"Customer"},{"value":"internal","label":"Team only"}]'::jsonb,
             'open', NOW(), NOW())
     ON CONFLICT (tenant_id, document_id, field_key) DO UPDATE SET
        question = EXCLUDED.question,
        status = CASE WHEN intake_needs_info.status = 'open' THEN 'open' ELSE intake_needs_info.status END,
        updated_at = NOW()`,
    [documentId, AUDIENCE_FIELD_KEY, question || 'Is this for the team only?']
  );
  return { raised: true };
}

/**
 * Closes this document's open 'audience' question, if any — called both by a person explicitly
 * answering it (the intake queue UI's own resolve action, once that route adopts this — see the
 * final report) and by the one-tap override (../audience/store.js's overrideDocumentAudience),
 * which counts as the person having answered it themselves. A no-op when there was never an open
 * question (the common case — most documents are never ambiguous) or the table doesn't exist yet.
 */
export async function resolveAudienceQuestion(db, documentId, { resolvedValue, resolvedBy = null } = {}) {
  if (!(await needsInfoTableExists(asRawQueryable(db)))) return { resolved: false };
  const r = await db.query(
    `UPDATE intake_needs_info SET status = 'resolved', resolved_value = $3, resolved_by = $4, resolved_at = NOW(), updated_at = NOW()
      WHERE ${TENANT_SQL} AND document_id = $1 AND field_key = $2 AND status = 'open'
      RETURNING id`,
    [documentId, AUDIENCE_FIELD_KEY, resolvedValue ?? null, resolvedBy]
  );
  return { resolved: r.rowCount > 0 };
}
