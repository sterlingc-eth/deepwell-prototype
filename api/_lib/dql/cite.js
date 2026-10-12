/**
 * dql/cite.js - "where did that come from": a request to see the papers behind an answer.
 *
 *   stripSourceAsk(question)   -> {q, cite}   the question without the source request ("... and which files that came from", "with sources",
 *                                              "which documents say how many ..."), and whether one was made. The base question is answered as usual.
 *   sourcesSentence(records)   -> text        the papers behind an answer, named with their date and (when stored) page.
 *   isSourceFollowup(question) -> boolean     a short follow-up that only asks for the source of the previous answer ("where did that come from").
 * Pure: no database, no model.
 */
const FILES = '(?:files?|documents?|docs?|papers?|paperwork|records?|pdfs?)';
const TAIL = [
  new RegExp(`(?:[,;]\\s*)?(?:\\b(?:and|plus|also|then)\\s+)?\\b(?:which|what)\\s+(?:${FILES}|\\w+\\s+${FILES})\\s+(?:that|it|this|those|they)\\s+(?:came|come|coming|was|were|is|are)?\\s*(?:from|pulled\\s+from|based\\s+on|taken\\s+from)\\b`, 'gi'),
  /(?:[,;]\s*)?\b(?:and|plus|also|then|with)\s+(?:the\s+)?(?:sources?|source\s+documents?|source\s+files?|citations?)\b/gi,
  /(?:[,;]\s*)?\b(?:and|plus|also|then)\s+(?:show|give|cite|list|name)\s+(?:me\s+)?(?:the\s+)?(?:sources?|source\s+documents?|source\s+files?|documents?\s+(?:behind|used))\b/gi,
];
const PREFIX = new RegExp(`\\b(?:which|what)\\s+${FILES}\\s+(?:say|says|show|shows|tell|tells|state|states|list|lists|have)\\s+(?:me\\s+)?(?=(?:how\\s+many|the\\s+(?:total|number|count)|total|number|count|what))`, 'i');

export function stripSourceAsk(question) {
  let q = String(question ?? ''); let cite = false;
  if (PREFIX.test(q)) { q = q.replace(PREFIX, ''); cite = true; }
  for (const re of TAIL) { re.lastIndex = 0; if (re.test(q)) { re.lastIndex = 0; q = q.replace(re, ' '); cite = true; } }
  // "... based on our uploaded papers" / "off the files" only says where to look: it must not be read as a word to search for
  if (cite) q = q.replace(/[,]?\s*\b(?:based\s+on|going\s+by|according\s+to|from|off|out\s+of|in)\s+(?:all\s+)?(?:our|the|my)?\s*(?:uploaded\s+)?(?:papers|documents|docs|files|records|paperwork)(?:\s+(?:we\s+have|we'?ve\s+uploaded|on\s+file|we\s+uploaded))?\s*(?=[?.!]*\s*$)/i, ' ');
  return { q: q.replace(/\s+/g, ' ').replace(/[,;]\s*$/, '').trim(), cite };
}

const THAT = '(?:that|taht|tht|thta|htat|this|thsi|it|the\\s+(?:number|figure|answer|total|count|result)|that\\s+(?:number|figure|answer|total|count|result))';
const SRC_RES = [
  new RegExp(`\\bwhere(?:'?s|s|\\s+is|\\s+did|\\s+does|\\s+do|\\s+was|\\s+are|'?d)?\\s*${THAT}\\b[^?]{0,30}\\b(?:from|come|came|coming|pulled|taken|got)\\b`, 'i'),
  /\b(?:what(?:'?s|s|\s+is|\s+are)?|give\s+me|show\s+me|show|got|need|cite|list|name|pull\s+up|open)\s+(?:the\s+)?(?:sources?|source\s+(?:documents?|files?|papers?))\b/i,
  /^\W*(?:please\s+)?sources?\W*$/i,
  /\b(?:show|shw|syow)\s+(?:me\s+)?(?:your|ur|the)\s+(?:work|woek)\b/i,
  /\bprove\s+it\b/i,
  /\bhow\s+did\s+you\s+(?:get|come\s+up\s+with|work\s+out)\s+(?:that|this)\b/i,
  /\bwhat\s+(?:are\s+)?you\s+basing\s+(?:that|this|it)\s+on\b/i,
  /\bwhat(?:'?s|\s+is)\s+(?:backing|behind)\s+(?:that|this)\b/i,
  new RegExp(`\\b(?:${THAT})\\s+(?:is\\s+|was\\s+)?(?:built|made\\s+up|based|pulled|coming|come|came)\\s*(?:from|on|of)?\\b`, 'i'),
  new RegExp(`\\b(?:which|what|cuales)\\s+(?:[\\w'-]+\\s+){0,4}?(?:is|are|was|were)\\s+(?:in\\s+)?${THAT}\\s*(?:from|number|pulled\\s+from|based\\s+on|built\\s+from|coming\\s+from)?\\b`, 'i'),
  /\b(?:which|what|cuales)\s+(?:[\w'-]+\s+){0,4}?(?:did|do)\s+you\s+(?:count|use|used|look(?:ed)?\s+at|pull|add(?:ed)?\s+up)\b/i,
  new RegExp(`\\b(?:pull\\s+up|show\\s+me|open|list|name|see|give\\s+me|can\\s+i\\s+see|please\\s+show\\s+me)\\s+(?:the\\s+)?(?:[\\w'-]+\\s+){0,4}?(?:that\\s+)?(?:made\\s+up|behind|used\\s+for|you\\s+used|(?:that\\s+)?(?:number|figure|total|count)\\s+(?:is\\s+)?(?:built|made)\\s+(?:up\\s+)?(?:from|of)|add\\s+up\\s+to)\\s+${THAT}\\b`, 'i'),
  new RegExp(`\\b(?:which|what)\\s+(?:${FILES})\\s+(?:answer|number|figure|total)\\s+(?:came|come)\\s+from\\b`, 'i'),
  new RegExp(`\\b(?:name|list|show)\\s+(?:me\\s+)?the\\s+${FILES}\\s+(?:that\\s+)?(?:answer|number|figure)\\s+(?:came|come)\\s+from\\b`, 'i'),
];
/** A short question that is only a request for the source of the previous answer. */
export function isSourceFollowup(question) {
  const q = String(question ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’]/g, "'").trim();
  if (!q || q.length > 220) return false;
  if (/\d/.test(q)) return false; // a new number, year or id is a new question
  if (/\b(?:how\s+many|how\s+much|total\s+of|average|what\s+is\s+the\s+total)\b/i.test(q)) return false;
  return SRC_RES.some((re) => re.test(q));
}

const fmtN = (n) => Number(n).toLocaleString('en-US');
/** "Sources: 0504-invoice.pdf (Invoice, Sep 3, 2024, page 2); ... and 8 more." Only papers (not customers) are named. */
export function sourcesSentence(records, total) {
  const docs = (records ?? []).filter((r) => r && r.documentId);
  if (!docs.length) return '';
  const show = docs.slice(0, 5).map((r) => `${r.label}${r.sublabel || r.page ? ` (${[r.sublabel, r.page ? `page ${r.page}` : null].filter(Boolean).join(', ')})` : ''}`);
  const all = Math.max(Number(total) || 0, docs.length);
  const more = all - show.length;
  return `Sources: ${show.join('; ')}${more > 0 ? `; and ${fmtN(more)} more` : ''}.`;
}
