/**
 * followup/provenance.js - "where did that come from", "which documents say that", "show me the source", "show your work":
 * a follow-up that only asks for the papers behind the previous answer. It becomes the previous question again with the source request
 * added ("how many invoices in 2022 and which files that came from"), which the DQL engine reads (dql/cite.js): the same answer, plus the
 * papers it was built from, named with their date and page when stored. When the engine cannot read the earlier question the follow-up is
 * released like any other merge it cannot explain.
 * Pure. No database, no model.
 */
import { isSourceFollowup } from '../dql/cite.js';

export function provenanceFollowup(turns, question) {
  if (!Array.isArray(turns) || !turns.length) return null;
  if (!isSourceFollowup(question)) return null;
  const prev = String(turns[turns.length - 1]?.question ?? '').trim().replace(/[?.!\s]+$/, '');
  if (!prev || prev.length > 220 || isSourceFollowup(prev)) return null;
  return { query: `${prev} and which files that came from` };
}
