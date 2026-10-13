/**
 * followup/readerfu.js (round 21) - a follow-up to a "what does the paper say" question stays on the SAME paper.
 *
 *   "who signed it" / "who signed that"            -> "who signed <the paper the earlier question named>"
 *   "and what about late fees" / "what about X"    -> "what does <the paper> say about late fees"
 *   "which page is that on" / "point me to the spot in the paper" / "show me the exact line" / "where did that come from"
 *                                                  -> the earlier question again (the reader quotes with file, date and page)
 *
 * The paper is the earlier question's own words ("the lease for Joyce Ward", "exam record for Ryan Griffin dated Jun 13 2023"), never a guess.
 * Anything else returns null. Pure: no database, no model.
 */
import { clauseAsk } from '../dql/families/reader.js';
import { isSourceFollowup } from '../dql/cite.js';

const strip = (t) => String(t ?? '').trim().replace(/[?.!\s]+$/, '');
const SAY = '(?:say|says|mention|mentions|state|states|specify|specifies|include|includes|cover|covers|contain|contains|provide|provides)';
const DOC_WORD = /\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement)\b/i;
const SOURCE_ASK = /\b(?:which|what)\s+(?:page|file|paper|document)\b|\bwhere\s+(?:in\s+(?:the|that)\s+\w+\s+)?(?:did|does|is)\s+(?:that|this|it)\b|\bpoint\s+(?:me\s+)?to\s+(?:the\s+)?(?:spot|line|place|part)\b|\b(?:show|find|give)\s+(?:me\s+)?(?:the\s+)?(?:exact\s+)?(?:line|spot|source|wording|text)\b|\bwhere\s+did\s+(?:that|this|it)\s+come\s+from\b|\bwhich\s+(?:documents?|files?|papers?)\s+(?:say|says|show|shows|is\s+that)\b|\bspot\s+in\s+(?:the|that)\s+(?:paper|document|file)\b|\bpage\s+(?:is\s+(?:that|it)\s+on|number)\b/i;
const PAGE_ASK = /\b(?:which|what)\s+page\b|\bpoint\s+(?:me\s+)?to\s+(?:the\s+)?(?:spot|line|place|part)\b|\b(?:show|find|give)\s+(?:me\s+)?(?:the\s+)?(?:exact\s+)?(?:line|spot|wording)\b|\bspot\s+in\s+(?:the|that)\s+(?:paper|document|file)\b/i;
// (kept for reference) const READERISH = /\b(?:say|says|part\s+(?:about|on)|agreed|regarding|pull|read\s+the|clause|tell\s+me\s+the|what\s+(?:number|is\s+the|was\s+the|does)|wording|dated)\b/i;
const COUNTISH = /\b(?:how\s+many|how\s+much|total|average|count|list|biggest|largest|smallest|most|least)\b/i;
const WHO = /^(?:(?:and|ok|okay|so|hey|also)\s+)*(?:who\s+(?:signed|executed|countersigned)(?:\s+(?:it|that|this|them|the\s+\w+))?|who\s+was\s+(?:the\s+)?signer|who\s+are\s+the\s+signers)$/i;
const WHATABOUT = /^(?:(?:and|ok|okay|so|hey|also)\s+)*(?:what|how)\s+about\s+(?:the\s+)?([a-z][a-z' -]{2,40})$/i;

/** The paper the earlier question named, in its own words, or null. */
export function paperOf(prev) {
  const P = strip(prev).replace(/^(?:hey|hi|please|pls|can you|could you|tell me|show me)\s*,?\s*/i, '');
  let m = new RegExp(`^(?:what|which)?\\s*(?:does|do|did)\\s+(.+?)\\s+${SAY}\\b`, 'i').exec(P);
  if (m && DOC_WORD.test(m[1]) || m && /\b(?:for|with|of)\b/i.test(m[1]) && m[1].split(' ').length >= 3) return m[1].replace(/^(?:the\s+)?/i, 'the ');
  // "does NAME have deposit in their lease": the paper is NAME's lease
  m = /^(?:does|do|did)\s+(.+?)\s+have\b.*\b(?:in|on|under|within|inside)\s+(?:their|his|her|its)\s+([A-Za-z -]*?\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement))$/i.exec(P);
  if (m && clauseAsk(P.toLowerCase())) return `the ${m[2].trim()} for ${m[1].trim()}`;
  m = /\b(?:in|on|under|within|inside|of)\s+((?:the\s+|this\s+|that\s+)?(?:[A-Za-z0-9' .-]+?'s\s+)?[A-Za-z -]*?\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement)\b(?:\s+(?:for|with|of)\s+.+)?)$/i.exec(P);
  if (m && clauseAsk(P.toLowerCase())) return m[1].replace(/^(?:this|that)\s+/i, 'the ');
  return null;
}

export function readerFollowup(turns, question) {
  if (!Array.isArray(turns) || !turns.length) return null;
  const q = strip(question);
  if (!q || q.length > 90) return null;
  // the paper: the nearest earlier question that names one (the turns in between may themselves be follow-ups on it)
  let paper = null; let last = null;
  for (let i = turns.length - 1; i >= 0 && i >= turns.length - 4; i--) {
    const t = strip(turns[i]?.question);
    if (!t || t.length > 240) return null;
    const p = paperOf(t);
    if (i === turns.length - 1) {
      last = t;
      if (p) { paper = p; break; }
      if (WHO.test(t) || WHATABOUT.test(t) || SOURCE_ASK.test(t)) continue; // a follow-up of the reader's own: keep looking back
      return null;
    }
    if (p) { paper = p; break; }
    if (!(WHO.test(t) || WHATABOUT.test(t) || SOURCE_ASK.test(t))) return null;
  }
  if (!paper) {
    // an own-vocabulary paper ("the keg bill for X dated ...", "pull the weight from the visit record ..."): a page / exact-line ask re-asks the earlier question, which the reader answers with file, date and page
    const lastQ = strip(turns[turns.length - 1]?.question);
    if (PAGE_ASK.test(q) && !isSourceFollowup(q) && lastQ.length <= 240 && !COUNTISH.test(lastQ)) return { query: lastQ };
    return null;
  }
  // the question the previous turn really asked, rebuilt from its follow-up words
  const prevQuery = WHO.test(last) ? `who signed ${paper}` : (WHATABOUT.exec(last) ? `what does ${paper} say about ${WHATABOUT.exec(last)[1].trim()}` : (paperOf(last) ? last : null));
  if (WHO.test(q)) return { query: `who signed ${paper}` };
  const wa = WHATABOUT.exec(q);
  if (wa) return { query: `what does ${paper} say about ${wa[1].trim()}` };
  if (SOURCE_ASK.test(q) && !/\b(?:how many|total|average)\b/i.test(q) && prevQuery) return { query: prevQuery };
  return null;
}
