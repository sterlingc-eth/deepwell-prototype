/**
 * dql/index.js - the Donovan Query Language entry points.
 *
 *   parseDql(question, ctx)          pure: question -> {mode:'dql', plan, text} | null   (null = release, never a guess)
 *   runDql(db, intent, {today})      one tenant-scoped snapshot, the plan executed over it, the answer written with its basis and records
 *
 * Wired in router/classifyAll.js (after the wording model, only when no lane claimed the question, or when the only claim is the
 * model-planned analytics lane) and in decompose/index.js (runDecompose delegates mode 'dql' here). Kill switch: DONOVAN_DQL=0.
 */
import { answerEnvelope, todayIso } from '../scope.js';
import { attachCitations } from '../citations/records.js';
import { parseDql, dqlEnabled } from './parse.js';
import { loadSnapshot } from './load.js';
import { execute } from './exec.js';
import { familyForOp } from './registry.js';

export { parseDql, dqlEnabled };

export async function runDql(db, intent, { today } = {}) {
  if (!intent?.plan || !dqlEnabled()) return null;
  const t = todayIso(today);
  const snap = await loadSnapshot(db, { today: t });
  if (snap.truncated) return null; // more records than one read holds: no answer is better than a partial one
  return answerFromSnapshot(snap, intent.plan, t);
}

/** Pure half of runDql (the verify script and the dev harness run it over a snapshot built from an export file). */
export function answerFromSnapshot(snap, plan, today) {
  const fam = familyForOp(plan.op);
  if (!fam) return null;
  const res = execute(plan, snap, { today });
  // a full name on file twice (two customers called Judy Cruz): ask which one, with where each lives, instead of answering for one of them
  if (res?.abstain === 'ambiguous-name' && res.name) {
    const same = snap.customers.filter((c) => String(c.name).toLowerCase() === String(res.name).toLowerCase());
    if (same.length > 1) {
      const where = same.map((c) => `${c.name} (${c.city ?? c.address ?? c.number ?? 'no address'})`);
      const text = `${res.name} is on file ${same.length === 2 ? 'twice' : `${same.length} times`}: ${where.join(' and ')}. Which one do you mean?`;
      return attachCitations(answerEnvelope({ text, facts: [] }), { records: same.map((c) => ({ type: 'customer', id: c.id, label: c.name, sublabel: c.address ?? undefined })), total: same.length, basis: `Looked for ${res.name} among the customers on file.`, kind: 'basis' });
    }
  }
  if (!res || res.abstain) return null;
  const said = fam.say(res, plan, { snap, today });
  if (!said || !said.text) return null;
  // A long list is cut in the sentence ("... and 30 more"); the older lanes also listed every item as a fact, so the whole list stays readable and checkable.
  let facts = said.facts ?? [];
  if (/\band \d[\d,]* more\b/.test(said.text) && facts.length <= 1 && (said.records?.length ?? 0) > 1) {
    facts = said.records.slice(0, 200).map((r) => ({ label: String(r.label ?? ''), value: String(r.sublabel ?? '') })).filter((f) => f.label);
  }
  const data = answerEnvelope({ text: said.text, facts });
  return attachCitations(data, { records: said.records ?? [], total: said.total, claimedCount: said.claimedCount ?? null, basis: said.basis, kind: (said.records?.length ? 'basis' : 'searched') });
}
