/**
 * followup/correction.js - a correction of the previous question: "no, I meant 2024", "oh wait I wanted Lakewood", "scratch that, letters",
 * "not Linda, Lisa", "actually the dollar amount". The correction words are removed and what is left (the new value) is merged into the
 * previous question by the same merge the other follow-ups use (followup/dqlmerge.js): the slot of the same kind is REPLACED, never added.
 * When the remainder is not a short value, or the merge cannot explain it, the follow-up is released exactly as before.
 * Pure. No database, no model.
 */
import { dqlMergeFollowup } from './dqlmerge.js';

const CUE = /(?:\b(?:scratch|scrap|ignore|forget)\s+(?:that|it)|\bo+h+\s+w[a-z]{2,5}\b|\bwait\b|\bno\b(?!\s+(?:one|more|longer|other))|\bnope\b|\bnah\b|\bactually\b|\bi\s+(?:meant|mean|said|want|w[a-z]{3,7})\b|\bmake\s+(?:that|it)\b|\bsorry\b|\bcorrection\b|\bmy\s+bad\b|\bwrong\b|\bnot\b|\boops\b|\bscratch\s+th\w+)/gi;
const TRAIL = /\s*(?:,\s*)?(?:if\s+(?:it'?s|its|that'?s|thats|you\s+can|possible)\s+(?:in\s+there|there|ok(?:ay)?|possible)?|thanks?(?:\s+(?:you|a\s+lot|in\s+advance))?|thx|please|pls|por\s+favor|asap|right\s+now|going\s+by\s+what'?s\s+on\s+file|when\s+you\s+can|if\s+(?:that'?s|its)\s+ok)\W*$/i;
const LEADWORDS = /^(?:(?:i|we)\s+(?:meant|mean|wanted|want|said)|it'?s|its|that'?s|thats|should\s+be|was|is|for|in|the|a|an|to|of|i\s+meant\s+to\s+say)\s+/i;
const MEASURE_RE = /^(?:the\s+)?(?:dollar\s+(?:amount|total)|total(?:\s+(?:amount|dollars?))?|amount|dollars?|sum|count|number|how\s+many)$/i;

/** The corrected value inside a correction ("no, I meant 2024" -> "2024"), or null when the sentence is not a short correction. */
export function correctionPayload(question) {
  const q = String(question ?? '').normalize('NFC').trim();
  if (!q || q.length > 200) return null;
  if (/\b(?:how\s+many|how\s+much|what\s+is|what\s+was|which|who|when|where|list|show|total\s+of)\b/i.test(q) && !/\b(?:meant|wanted)\b/i.test(q)) return null;
  // the LAST correction cue: everything before it is lead-in, everything after it is the new value
  let last = null; CUE.lastIndex = 0;
  for (let m; (m = CUE.exec(q));) last = m;
  if (!last) return null;
  let payload = q.slice(last.index + last[0].length).replace(/^[\s,:;.\-–—!]+/, '');
  const cue = last[0].toLowerCase();
  if (cue === 'not') {
    // "not Linda, Lisa" / "not 2023 but 2024": the value after the comma (or "but" / "i meant")
    const m = payload.match(/^(.+?)\s*(?:,|;|\bbut\b|\bi\s+(?:meant|mean|wanted)\b)\s*(.+)$/i);
    if (!m) return null;
    payload = m[2];
  }
  payload = payload.replace(TRAIL, '').replace(LEADWORDS, '').replace(LEADWORDS, '').replace(/^[\s,:;.\-–—!]+|[\s.!]+$/g, '').trim();
  if (!payload || payload.split(/\s+/).length > 5) return null;
  return payload;
}

export function correctionFollowup(turns, question) {
  if (!Array.isArray(turns) || !turns.length) return null;
  const payload = correctionPayload(question);
  if (!payload) return null;
  const measure = MEASURE_RE.test(payload);
  const tries = measure ? [`and ${payload}?`, `what about ${payload}?`, `${payload}?`, `and the ${payload.replace(/^the\s+/i, '')}?`] : [`and ${payload}?`, `what about ${payload}?`, `${payload}?`];
  for (const t of tries) {
    const r = dqlMergeFollowup(turns, t);
    if (r?.query) return { query: r.query, slot: 'correction' };
  }
  return null;
}
