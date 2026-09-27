/**
 * SQL fragment for excluding internal (tech-only) documents from a customer-scoped query —
 * shared by every retrieval/browse path that needs to keep internal documents out of customer
 * answers (owner ask (a), round 18 part 2). Exported so OTHER engines can adopt the exact same
 * fragment in files this round's contract doesn't let this engineer touch directly — see the
 * final report's "adoption list" for the precise call sites (fastPath/analytics/relations/
 * docLookup/recordsStore.js's searchPassages).
 *
 * PRE-MIGRATION FALLBACK (M3-config/57 may not be pasted yet): before `documents.audience`
 * exists, the same fact is written to `extractions` as a synthetic field_key
 * (AUDIENCE_FALLBACK_FIELD_KEY, '_audience') by ./store.js — a table that has existed since
 * 01-create-schema.sql and needs no migration of its own. Both branches below are safe, parameter-
 * free SQL TEXT (never string-interpolated user input — `alias` is always a literal table alias
 * the CALLER chose in their own query, same trust model as recordsStore.js's own STAGE_BUCKET_CASE/
 * WARRANTY_BUCKET_CASE constants) meant to be AND-ed into an existing WHERE clause.
 */

/** The extractions.field_key used to record a document's audience before M3-config/57's
 *  `documents.audience` column exists. Never a real extracted fact — see documentTypes.js's
 *  REQUIRED_FIELDS/FIELD_LABELS, which deliberately does NOT list it (see the FIELD_LABELS entry
 *  added there, which IS user-facing, for the *question* text, not this key). */
export const AUDIENCE_FALLBACK_FIELD_KEY = '_audience';

/** Same idea, for the "have we already notified about this document" dedupe marker (see
 *  ./notify.js) — also stored as a synthetic extractions row, never a real field. */
export const AUDIENCE_NOTIFIED_FIELD_KEY = '_audience_notified';

/**
 * A WHERE-safe SQL fragment that is TRUE exactly for documents a customer-scoped answer should
 * see: every 'customer'-audience document, and (`teamScoped: true`) everything, unfiltered — the
 * owner's own example of a team-scoped question ("any memos for Carlos this week", "what did
 * dispatch send the techs").
 *
 * @param {object} opts
 * @param {string} [opts.docAlias]  the documents table's alias in the caller's query (default 'd')
 * @param {boolean} opts.hasAudienceColumn  result of ./store.js's documentsHaveAudience(db) probe
 * @param {boolean} [opts.teamScoped]  true when the question itself is about internal/team
 *   documents — skips the exclusion entirely (the caller decides this; this file only renders SQL)
 * @returns {string}
 */
export function audienceFilterSql({ docAlias = 'd', hasAudienceColumn, teamScoped = false } = {}) {
  if (teamScoped) return 'TRUE';
  if (hasAudienceColumn) {
    return `COALESCE(${docAlias}.audience, 'customer') <> 'internal'`;
  }
  return `NOT EXISTS (
    SELECT 1 FROM extractions ax
     WHERE ax.document_id = ${docAlias}.id AND ax.tenant_id = ${docAlias}.tenant_id
       AND ax.field_key = '${AUDIENCE_FALLBACK_FIELD_KEY}' AND ax.value = 'internal'
  )`;
}
