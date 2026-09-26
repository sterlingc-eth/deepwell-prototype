/**
 * Straight-through-processing metric (Round 12 contract, item 5): "docs auto-completed without
 * human / total". Pure read against tables autofill.js already writes (M3-config/43) plus the
 * documents/verified_by column 08-review.sql already added — no new state, no model call.
 *
 * A document counts as STRAIGHT-THROUGH when it reached stage='verified' with verified_by='ai'
 * (documentTypes.js's completenessFor said every required field was present and confident — see
 * extractDocument.js and autofill.js, the only two writers of verifyByAi) AND it never left an
 * open question behind for a human (no OPEN intake_needs_info row). A document that got to
 * 'verified' only after a human answered a needs-info question, or corrected a field, is real
 * work that got done, but it is not the "nobody touched it" case the owner asked to measure.
 *
 * Tolerant of intake_needs_info not existing yet (migration 43 unpasted): the STP rate is then
 * simply verified_by='ai' over total, with `needsInfoTracked: false` so a caller can say so.
 */
import { TENANT_SQL } from "../scope.js";

async function needsInfoTableExists(db) {
  try {
    const r = await db.raw("SELECT to_regclass('public.intake_needs_info') IS NOT NULL AS ok", []);
    return Boolean(r.rows[0]?.ok);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{
 *   total: number, autoVerified: number, autoVerifiedCount: number, humanVerified: number,
 *   openQuestions: number, resolvedQuestions: number, straightThroughRate: number,
 *   needsInfoTracked: boolean,
 * }>}
 *   `total` is every document that finished ingestion (stage past 'received'); a document still
 *   uploading has not had a chance to auto-complete yet and would only ever drag the rate down.
 */
export async function intakeStatus(db) {
  const { rows } = await db.raw(
    `SELECT
        count(*) FILTER (WHERE stage IN ('read','mapped','linked','verified'))::int AS total,
        count(*) FILTER (WHERE stage = 'verified' AND verified_by = 'ai')::int AS auto_verified,
        count(*) FILTER (WHERE stage = 'verified' AND verified_by = 'human')::int AS human_verified
       FROM documents WHERE ${TENANT_SQL}`,
    []
  );
  const { total = 0, auto_verified: autoVerified = 0, human_verified: humanVerified = 0 } = rows[0] ?? {};

  const needsInfoTracked = await needsInfoTableExists(db);
  let openQuestions = 0;
  let resolvedQuestions = 0;
  let autoVerifiedCount = autoVerified;
  if (needsInfoTracked) {
    const q = await db.raw(
      `SELECT
          count(*) FILTER (WHERE status = 'open')::int AS open_q,
          count(*) FILTER (WHERE status <> 'open')::int AS resolved_q
         FROM intake_needs_info WHERE ${TENANT_SQL}`,
      []
    );
    openQuestions = q.rows[0]?.open_q ?? 0;
    resolvedQuestions = q.rows[0]?.resolved_q ?? 0;

    // Straight-through excludes any auto-verified document that STILL has an open question on
    // file — the ai:autofill pass got it to 'verified' via the strength rule (a confident lead
    // candidate) while a DIFFERENT field on the same document remained a genuine, still-open
    // conflict. Rare (verifyByAi requires every required field satisfied), but excluded on
    // purpose rather than assumed impossible.
    const clean = await db.raw(
      `SELECT count(*)::int AS n FROM documents d
        WHERE d.${TENANT_SQL} AND d.stage = 'verified' AND d.verified_by = 'ai'
          AND NOT EXISTS (SELECT 1 FROM intake_needs_info n WHERE n.document_id = d.id AND n.status = 'open')`,
      []
    );
    autoVerifiedCount = clean.rows[0]?.n ?? 0;
  }

  const straightThroughRate = total > 0 ? autoVerifiedCount / total : 0;
  return {
    total, autoVerified, autoVerifiedCount, humanVerified,
    openQuestions, resolvedQuestions, straightThroughRate, needsInfoTracked,
  };
}
