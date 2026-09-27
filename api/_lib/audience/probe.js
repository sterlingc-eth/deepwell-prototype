/**
 * Column probes for M3-config/57 (documents.audience / assigned_member / assigned_tech_name) —
 * split out from ./store.js into their own leaf file (no imports of its own) so that any file
 * needing only "has 57 been pasted yet" — api/_lib/recordsStore.js (browse filter), api/_lib/
 * search/store.js, api/_lib/search/knowledge.js — can ask without pulling in ./store.js's own
 * import chain (classify.js -> notify.js -> ../followups.js, and -> ../intake/audienceQuestions.js
 * -> ../intake/autofill.js -> ../recordsStore.js). THAT chain is exactly why this had to be its
 * own file: recordsStore.js importing ./store.js directly would close a real import cycle
 * (recordsStore.js -> audience/store.js -> intake/audienceQuestions.js -> intake/autofill.js ->
 * recordsStore.js). Importing this leaf file instead has no such risk.
 *
 * Same "detect once, memoize per warm instance, _reset for tests" contract as every other
 * migration-tolerance probe in this codebase (recordsStore.js's documentsHaveUpdatedAt/
 * documentsHaveDisplayName/documentsHaveUploadedBy) — every function here takes a plain
 * `{query: (sql, params) => ...}` (a raw pg client, or the same adapter recordsStore.js's
 * financialsTableExists call and intake/queue.js's asQueryable already use elsewhere).
 */

let hasAudienceColumn = null;
export async function documentsHaveAudience(db) {
  if (hasAudienceColumn !== null) return hasAudienceColumn;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'audience'`
    );
    hasAudienceColumn = r.rowCount > 0;
  } catch {
    return false; // don't memoize a transient failure
  }
  return hasAudienceColumn;
}
export function _resetAudienceColumnProbe() { hasAudienceColumn = null; }

let hasAssignedColumns = null;
export async function documentsHaveAssignedTech(db) {
  if (hasAssignedColumns !== null) return hasAssignedColumns;
  try {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'documents'
          AND column_name IN ('assigned_member', 'assigned_tech_name')`
    );
    hasAssignedColumns = Number(r.rows?.[0]?.n) >= 2;
  } catch {
    return false;
  }
  return hasAssignedColumns;
}
export function _resetAssignedColumnsProbe() { hasAssignedColumns = null; }

/** Test-only: clear every probe this file memoizes, between fixtures. */
export function _resetAudienceProbesForTests() {
  hasAudienceColumn = null;
  hasAssignedColumns = null;
}
