/**
 * followup/provenance.js - "where did that come from", "which documents say that", "show me the source", "show your work":
 * a follow-up that only asks for the papers behind the previous answer. It becomes the previous question again with the source request
 * added ("how many invoices in 2022 and which files that came from"), which the DQL engine reads (dql/cite.js): the same answer, plus the
 * papers it was built from, named with their date and page when stored. When the engine cannot read the earlier question the follow-up is
 * released like any other merge it cannot explain.
 * Pure. No database, no model.
 */
import { isSourceFollowup } from '../dql/cite.js';
import { isSourceAsk } from './readerfu.js';

export function provenanceFollowup(turns, question) {
  if (!Array.isArray(turns) || !turns.length) return null;
  if (!isSourceAsk(question)) return null;
  // the nearest earlier question that is not itself a source ask (a second "where did that come from" goes back to the same root)
  let prev = '';
  for (let i = turns.length - 1; i >= 0 && i >= turns.length - 4; i--) {
    const t = String(turns[i]?.question ?? '').trim().replace(/[?.!\s]+$/, '');
    if (t && !isSourceAsk(t)) { prev = t; break; }
  }
  if (!prev || prev.length > 220 || isSourceAsk(prev)) return null;
  return { query: `${prev} and which files that came from` };
}
