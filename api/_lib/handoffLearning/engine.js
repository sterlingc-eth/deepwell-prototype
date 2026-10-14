/**
 * handoffLearning/engine.js - Donovan's OWN engine, run offline over one organization's records, so the job can ask "does the engine, with this candidate learning, read this question
 * and get the same answer?". One snapshot of the records is read once; each run is the parser (dql/parse.js) plus the families' executor (answerFromSnapshot). No model, no network.
 */
import { parseDql } from '../dql/parse.js';
import { loadSnapshot } from '../dql/load.js';
import { answerFromSnapshot } from '../dql/index.js';
import { buildTenantVocab } from '../vocab/tenantVocab.js';

export async function makeEngine(db, { pack = null, today = '2026-10-07', tenantVocab = null } = {}) {
  const tv = tenantVocab ?? (await buildTenantVocab(db, pack));
  const snap = await loadSnapshot(db, { today });
  if (snap.truncated) throw new Error('records too large for an offline read');
  const base = { ...tv }; delete base.handoff; // the learnings under test are given explicitly; none are read from the vocabulary
  const run = (question, overlay = null, { debug = false } = {}) => {
    const dbg = debug ? {} : undefined;
    let intent = null;
    try { intent = parseDql(question, { tenantVocab: base, pack, today, original: question, handoff: overlay ?? null, debug: dbg }); } catch { intent = null; }
    if (!intent?.plan) return { plan: null, ans: null, why: dbg?.why ?? null, left: dbg?.feat?.left ?? null, debug: dbg };
    let ans = null;
    try { ans = answerFromSnapshot(snap, intent.plan, today); } catch { ans = null; }
    return { plan: intent.plan, ans, why: dbg?.why ?? null, left: dbg?.feat?.left ?? null, debug: dbg };
  };
  return { tv: base, snap, run, today, pack };
}

/** A comparable form of an answer: its text plus the records it lists (ids). */
export function answerKey(ans) {
  if (!ans) return null;
  const ids = (ans.records ?? ans.sources ?? []).map((r) => r.id ?? r.documentId).filter(Boolean).sort();
  return JSON.stringify([String(ans.text ?? '').replace(/\s+/g, ' ').trim(), ids]);
}
