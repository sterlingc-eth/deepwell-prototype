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
  if (!res || res.abstain) return null;
  const said = fam.say(res, plan, { snap, today });
  if (!said || !said.text) return null;
  const data = answerEnvelope({ text: said.text, facts: said.facts ?? [] });
  return attachCitations(data, { records: said.records ?? [], total: said.total, claimedCount: said.claimedCount ?? null, basis: said.basis, kind: (said.records?.length ? 'basis' : 'searched') });
}
