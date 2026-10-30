/** safetynet/cases.js - pure: build a structured learning case, and the personal-data-free export row (miss_teach-compatible shape). */
import { maskQuestion } from '../handoffLearning/mask.js';

export const SOURCES = ['audit_disagree', 'customer_report', 'claude_handoff', 'flag'];
export const STAGES = ['retrieval', 'label-match', 'extract/ocr', 'read', 'agent', 'unknown'];
export const stageFromWhy = (why) => ({ wrong_doc: 'retrieval', not_found: 'retrieval', wrong_field: 'label-match', wrong_value: 'extract/ocr' }[why] ?? 'unknown');

/** answerData = the `data` object sent to the customer. */
export function docRefs(data) {
  return (data?.sources ?? []).map((s) => ({ documentId: s.documentId ?? null, page: s.location?.page ?? null })).filter((r) => r.documentId).slice(0, 8);
}
export function buildCase({ source, question, given, expected = null, data = null, refs = null, stage = null, why = null, lane = null }) {
  return {
    source: SOURCES.includes(source) ? source : 'flag',
    question: String(question ?? '').slice(0, 300), given: String(given ?? data?.text ?? '').slice(0, 800), expected: expected == null ? null : String(expected).slice(0, 800),
    docRefs: refs ?? docRefs(data), stage: STAGES.includes(stage) ? stage : stageFromWhy(why), lane: lane ?? (data?.valueReader ? 'valuereader' : data?.docRecords ? 'docrecord' : 'agent'),
  };
}

const SCRUB = [[/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '{EMAIL}'], [/\b\d{3}-\d{2}-\d{4}\b/g, '{ID}'], [/\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '{PHONE}'], [/\b(?:\d[ -]?){13,19}\b/g, '{CARD}']];
export const scrub = (t) => SCRUB.reduce((s, [re, to]) => s.replace(re, to), String(t ?? ''));

/**
 * Export row for donovan-training/v2loop/misses. No tenant id, no document ids, no raw question: the question is name/number-masked, texts are scrubbed.
 * Returns null when the case holds personal data it cannot mask (question blocked) or was not opted in.
 */
export function toMissTeachRow(c, { salt = '' } = {}) {
  if (!c || c.export_ok !== true) return null;
  const m = maskQuestion(c.question, null);
  if (m.blocked) return null;
  let h = 0; const key = `${salt}|${c.id}|${m.masked}`; for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return { id: `sn-${(h >>> 0).toString(36)}`, source: c.source, lane: c.lane ?? 'unknown', stage: c.stage ?? 'unknown', question: m.masked, given: scrub(maskQuestion(c.given, null).masked), expected: c.expected == null ? null : scrub(maskQuestion(c.expected, null).masked), n_docs: Array.isArray(c.doc_refs) ? c.doc_refs.length : 0 };
}
