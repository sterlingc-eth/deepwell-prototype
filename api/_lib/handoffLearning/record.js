/**
 * handoffLearning/record.js - step (a): keep a handed-off question when Claude's answer is grounded in the organization's records.
 * Called after the model's answer is sent. Off unless DONOVAN_HANDOFF_LEARNING is on. Never throws, never blocks the answer.
 *
 *   recordHandoff(db, {question, vocab, answer: {text, citedRecords:[{id, type, audience, ...}]}, reading})
 *     -> {ok:true, id} | {ok:false, reason}
 * What is kept: the question (blanked once the job has read it, gone after 14 days), the question with names / numbers / dates masked, a value-free reading, and the numbers and record
 * ids of the answer. Never the answer sentence. Nothing is kept when a cited paper is private (HR letters, internal notes) or came from a Google Drive / Gmail sync, when the question holds personal data, or when the answer cites no record.
 */
import { handoffLearningEnabled } from './flag.js';
import { maskQuestion } from './mask.js';
import { answerSignature } from './sig.js';
import { insertHandoff } from './store.js';
import { isPrivateDoc } from '../privacy/privateDocs.js';
import { isGoogleSourced } from './source.js';

/** a reading with nothing in it but structure: op / entity / docType / groupBy / measure */
export function cleanReading(r) {
  const o = {}; if (!r || typeof r !== 'object') return o;
  for (const k of ['op', 'entity', 'docType', 'measure']) if (typeof r[k] === 'string' && /^[a-z0-9_-]{1,40}$/i.test(r[k])) o[k] = r[k];
  if (Array.isArray(r.groupBy)) o.groupBy = r.groupBy.filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,30}$/i.test(x)).slice(0, 3);
  return o;
}

export async function recordHandoff(db, { question, vocab = null, answer, reading = null, env = process.env } = {}) {
  try {
    if (!handoffLearningEnabled(env)) return { ok: false, reason: 'off' };
    // Industry demo companies never feed handoff learning (a prospect's questions stay out of every learning set).
    try { const { rows } = await db.raw("SELECT plan, billing_status FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid", []); if (rows?.[0]?.plan === 'demo' && rows?.[0]?.billing_status === 'demo') return { ok: false, reason: 'demo' }; } catch { /* fall through: unknown is not demo */ }
    const q = String(question ?? '').replace(/\s+/g, ' ').trim();
    if (!q || q.length > 240) return { ok: false, reason: 'question-shape' };
    const cited = (answer?.citedRecords ?? []).filter((r) => r && (r.id || r.documentId));
    if (!cited.length || !String(answer?.text ?? '').trim()) return { ok: false, reason: 'not-grounded' };
    if (cited.some((r) => isPrivateDoc(r))) return { ok: false, reason: 'private-document' };
    if (cited.some((r) => isGoogleSourced(r)) || (answer?.sources ?? []).some((r) => isGoogleSourced(r))) return { ok: false, reason: 'google-source' }; // Google policy: synced Drive / Gmail content never feeds learning
    const m = maskQuestion(q, vocab);
    if (m.blocked) return { ok: false, reason: 'personal-data' };
    const sig = answerSignature(answer.text, cited);
    if (!sig.nums.length && !sig.ids.length) return { ok: false, reason: 'no-values' };
    const r = await insertHandoff(db, { questionText: q, questionMasked: m.masked, reading: cleanReading(reading), answerSig: sig, groundedN: cited.length });
    return r.ok ? { ok: true, id: r.id } : { ok: false, reason: 'store' };
  } catch { return { ok: false, reason: 'error' }; }
}
