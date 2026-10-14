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
import { CHATTER } from './noise.js';

const strip = (t) => String(t ?? '').trim().replace(/[?.!\s]+$/, '');
const SAY = '(?:say|says|mention|mentions|state|states|specify|specifies|include|includes|cover|covers|contain|contains|provide|provides)';
const DOC_WORD = /\b(?:agreement|contract|lease|invoice|policy|quote|estimate|proposal|warranty|permit|statement)\b/i;
const SOURCE_ASK0 = /\b(?:which|what)\s+(?:page|file|paper|document)\b|\bwhere\s+(?:in\s+(?:the|that)\s+\w+\s+)?(?:did|does|is)\s+(?:that|this|it)\b|\bpoint\s+(?:me\s+)?to\s+(?:the\s+)?(?:spot|line|place|part)\b|\b(?:show|find|give)\s+(?:me\s+)?(?:the\s+)?(?:exact\s+)?(?:line|spot|source|wording|text)\b|\bwhere\s+did\s+(?:that|this|it)\s+come\s+from\b|\bwhich\s+(?:documents?|files?|papers?)\s+(?:say|says|show|shows|is\s+that)\b|\bspot\s+in\s+(?:the|that)\s+(?:paper|document|file)\b|\bpage\s+(?:is\s+(?:that|it)\s+on|number)\b/i;
// R22: more ways to ask where the previous answer came from ("what's your source", "show me the page", "where'd you get that number", "which document says that", "can you cite that")
const SOURCE_MORE = /\b(?:what(?:'s|s|\s+is|\s+are)?\s+(?:your|the|that|this)\s+sources?|which\s+(?:documents?|files?|papers?|records?)\s+(?:says?|shows?|has|have|states?|mentions?)\s+(?:that|this|it)|show\s+me\s+(?:the|that)\s+(?:page|source|paper|document|file)|(?:give|show)\s+me\s+(?:the\s+)?page\s+number|where(?:'?d|\s+did)\s+you\s+(?:get|pull|find|take|see|read)\s+(?:that|this|it|the\s+(?:number|figure|total|count|answer))(?:\s+(?:number|figure|total|count|answer))?|can\s+you\s+(?:cite|source)\s+(?:that|this|it)|cite\s+(?:your|the)\s+sources?|show\s+me\s+where\s+(?:it|that|this)\s+(?:says?|said|is)(?:\s+(?:that|this|it))?)\b/i;
const PAGE_ASK = /\b(?:which|what)\s+page\b|\bpoint\s+(?:me\s+)?to\s+(?:the\s+)?(?:spot|line|place|part)\b|\b(?:show|find|give)\s+(?:me\s+)?(?:the\s+)?(?:exact\s+)?(?:line|spot|wording)\b|\bspot\s+in\s+(?:the|that)\s+(?:paper|document|file)\b/i;
const SOURCE_ASK = { test: (t) => SOURCE_ASK0.test(t) || SOURCE_MORE.test(t), exec: (t) => SOURCE_ASK0.exec(t) ?? SOURCE_MORE.exec(t) };
// (kept for reference) const READERISH = /\b(?:say|says|part\s+(?:about|on)|agreed|regarding|pull|read\s+the|clause|tell\s+me\s+the|what\s+(?:number|is\s+the|was\s+the|does)|wording|dated)\b/i;
const COUNTISH = /\b(?:how\s+many|how\s+much|total|average|count|list|biggest|largest|smallest|most|least)\b/i;
const WHO = /^(?:(?:and|ok|okay|so|hey|also)\s+)*(?:who\s+(?:signed|executed|countersigned)(?:\s+(?:it|that|this|them|the\s+\w+))?|who\s+was\s+(?:the\s+)?signer|who\s+are\s+the\s+signers)$/i;
const WHATABOUT = /^(?:(?:and|ok|okay|so|hey|also)\s+)*(?:what|how)\s+about\s+(?:the\s+)?([a-z][a-z' -]{2,40})$/i;


/* ---------------------------------------------------------------------------------------------- round 22
 * A source / page follow-up often arrives dressed in chatter and typos ("my bookkeeper is asking: can you pont me to the spot in the pper",
 * "necesito saber point to spot in paper gracias", "... - from the documents we have"). sourceCore() reads it the way the parser reads a
 * question: misspelled words are repaired against the source vocabulary and the chatter list (unique nearest word only), the source ask must
 * then be found, and EVERY word left over must be chatter. A digit, a name or any other word means it is a new question: null.
 */
const SRC_WORDS = ["where'd", "what's", 'whats', "that's", 'cite', 'sources', 'pages', 'records', 'record', 'shows', 'states', 'mentions', 'has', 'pull', 'take', 'see', 'read', 'said', 'figure', 'answer', 'those', 'sentence', 'point', 'spot', 'paper', 'page', 'line', 'show', 'find', 'give', 'wording', 'text', 'source', 'document', 'documents', 'file', 'files', 'papers', 'where', 'which', 'what', 'come', 'came', 'exact', 'number', 'tell', 'you', 'your', 'can', 'could', 'me', 'to', 'the', 'in', 'on', 'is', 'it', 'that', 'this', 'did', 'does', 'from', 'asap', 'we', 'have', 'got', 'get', 'part', 'place', 'location', 'quote', 'say', 'says'];
const LEX = new Set([...CHATTER, ...SRC_WORDS]);
const LEX_LIST = [...LEX];
function ed(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const ALIAS = { u: 'you', ur: 'your', asp: 'asap', pls: 'please', plz: 'please', pleas: 'please', hlp: 'help', spt: 'spot', pge: 'page' };
function repairToken(t) {
  if (ALIAS[t]) return ALIAS[t];
  if (LEX.has(t)) return t;
  if (t.length < 4) return null;
  const max = t.length >= 8 ? 2 : (t.length >= 5 ? 1 : 1);
  const hits = LEX_LIST.filter((w) => w.length >= 4 && Math.abs(w.length - t.length) <= max && ed(t, w) <= max);
  // a four-letter word is repaired only into a source word (spot, page, line): never into chatter
  const pool = t.length <= 5 ? hits.filter((w) => SRC_WORDS.includes(w) || (t.length === 5 && w[0] === t[0] && w[w.length - 1] === t[t.length - 1])) : hits;
  return pool.length === 1 ? pool[0] : null;
}
/** The canonical source ask inside a noisy follow-up ("can you point me to the spot in the paper"), or null when anything else is in it. */
export function sourceCore(question) {
  const raw = String(question ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!raw.trim() || raw.length > 260 || /\d/.test(raw)) return null;
  const toks = raw.replace(/['’]/g, "'").replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 40) return null;
  const fixed = [];
  for (const t of toks) { const r = repairToken(t); if (r === null) return null; fixed.push(r); }
  const text = fixed.join(' ');
  const m = PAGE_ASK.exec(text) ?? SOURCE_ASK.exec(text);
  if (!m) return null;
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).split(/\s+/).filter(Boolean);
  if (rest.some((w) => !LEX.has(w))) return null;
  return text;
}

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


/**
 * R22: a page / spot / line ask puts the first earlier question that is not itself a source ask back, word for word: the reader answers it with the file,
 * date and page of the very paper it read. Never for a count, a total or a list (those have no single spot), never when the follow-up also asks for a source in a
 * way the citation lane reads (that lane names the papers behind the answer instead).
 */
function rootReask(turns, q) {
  if (!PAGE_ASK.test(q) || isSourceFollowup(q)) return null;
  for (let i = turns.length - 1; i >= 0 && i >= turns.length - 4; i--) {
    const t = strip(turns[i]?.question);
    if (!t || t.length > 260) return null;
    if (sourceCore(t) || WHO.test(t) || WHATABOUT.test(t)) continue;
    if (COUNTISH.test(t) || /\b(?:and|also|plus)\s+(?:which|what)\s+(?:files?|documents?|papers?)\b/i.test(t)) return null;
    return { query: t };
  }
  return null;
}

export const isSourceAsk = (question) => isSourceFollowup(question) || Boolean(sourceCore(question));

export function readerFollowup(turns, question) {
  if (!Array.isArray(turns) || !turns.length) return null;
  // R22: the source ask without its chatter and typos ("my bookkeeper is asking: can you pont me to the spot in the pper" -> "can you point me to the spot in the paper")
  const core = sourceCore(question);
  const q = core ?? strip(question);
  // R22: the broader wordings count only when nothing else is in the question ("show me the page for the lease of Bob Jones" is a new question)
  if (!core && SOURCE_MORE.test(q) && !SOURCE_ASK0.test(q) && !WHO.test(q) && !WHATABOUT.test(q)) return null;
  if (!q || (!core && q.length > 90)) return null;
  // the paper: the nearest earlier question that names one (the turns in between may themselves be follow-ups on it)
  let paper = null; let last = null;
  for (let i = turns.length - 1; i >= 0 && i >= turns.length - 4; i--) {
    const t = strip(turns[i]?.question);
    if (!t || t.length > 240) return null;
    const p = paperOf(t);
    if (i === turns.length - 1) {
      last = t;
      if (p) { paper = p; break; }
      if (WHO.test(t) || WHATABOUT.test(t) || SOURCE_ASK.test(t) || sourceCore(t)) continue; // a follow-up of the reader's own: keep looking back
      return core ? rootReask(turns, q) : null;
    }
    if (p) { paper = p; break; }
    if (!(WHO.test(t) || WHATABOUT.test(t) || SOURCE_ASK.test(t) || sourceCore(t))) return core ? rootReask(turns, q) : null;
  }
  if (!paper) {
    // an own-vocabulary paper ("the keg bill for X dated ...", "pull the weight from the visit record ..."): a page / exact-line ask re-asks the earlier question, which the reader answers with file, date and page
    const lastQ = strip(turns[turns.length - 1]?.question);
    if (PAGE_ASK.test(q) && !isSourceFollowup(q) && lastQ.length <= 240 && !COUNTISH.test(lastQ)) return { query: lastQ };
    return core ? rootReask(turns, q) : null;
  }
  // the question the previous turn really asked, rebuilt from its follow-up words
  const prevQuery = WHO.test(last) ? `who signed ${paper}` : (WHATABOUT.exec(last) ? `what does ${paper} say about ${WHATABOUT.exec(last)[1].trim()}` : (paperOf(last) ? last : null));
  if (WHO.test(q)) return { query: `who signed ${paper}` };
  const wa = WHATABOUT.exec(q);
  if (wa) return { query: `what does ${paper} say about ${wa[1].trim()}` };
  if (SOURCE_ASK.test(q) && !/\b(?:how many|total|average)\b/i.test(q) && prevQuery) return { query: prevQuery };
  return null;
}
