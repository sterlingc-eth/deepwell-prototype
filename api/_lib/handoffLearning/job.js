/**
 * handoffLearning/job.js - step (b)+(c)+(d), offline: turns the recorded handoffs of ONE organization into adopted learnings.
 *
 *   runHandoffLearningJob(db, {engine, agree?, regression?, limits?})
 *     1. reads the handoffs not yet used (raw question text still present)
 *     2. checks the learnings already active against the new handoffs (a mismatch retires them)
 *     3. mines candidate learnings (mine.js), keeps the supported, conflict-free ones (adopt.js selectCandidates)
 *     4. adopts only those the engine re-derives (adopt.js verifyCandidates); the rest are discarded
 *     5. blanks the raw question text of every handoff it read and removes old ones
 * `engine` = makeEngine(db, ...) (engine.js). `agree(engineAnswer, handoff)` defaults to the answer signature Claude's answer left behind (numbers and record ids).
 * Returns a plain report; nothing in it is question text.
 */
import { listNewHandoffs, markHandoffs, purgeOldHandoffs, adoptLearning, listLearnings, countActive } from './store.js';
import { mineHandoff } from './mine.js';
import { selectCandidates, verifyCandidates } from './adopt.js';
import { retireOnMismatch } from './feedback.js';
import { agreesWithSignature } from './sig.js';
import { LIMITS, handoffLearningEnabled } from './flag.js';

export async function runHandoffLearningJob(db, { engine, agree = null, regression = [], limits = LIMITS, env = process.env, maxHandoffs = 3000, trace = null } = {}) {
  const rep = { handoffs: 0, already: 0, mismatch: 0, noLead: 0, found: 0, none: 0, candidates: 0, adopted: [], rejected: [], retired: [], purged: 0 };
  if (!handoffLearningEnabled(env)) return { ...rep, skipped: 'off' };
  const rows = await listNewHandoffs(db, maxHandoffs);
  const agreeFn = agree ?? ((ans, h) => agreesWithSignature(ans, h.sig));
  const handoffs = new Map(rows.map((r) => [String(r.id), { id: String(r.id), question: r.question_text, reading: r.reading ?? {}, sig: r.answer_sig ?? {} }]));
  rep.handoffs = handoffs.size;
  rep.retired = await retireOnMismatch(db, engine, [...handoffs.values()], agreeFn);
  const existing = (await listLearnings(db, { status: 'active' })).map((l) => ({ phrase: l.phrase, kind: l.kind, canonical: l.canonical }));
  const room = Math.max(0, limits.maxActivePerTenant - (await countActive(db)));
  const used = []; const dropped = []; const adoptedRows = []; let pending = [...handoffs.values()];
  // several rounds: what the first round learned (chatter, the plain words) leaves the later questions with one unknown word instead of two
  for (let round = 0; round < (limits.rounds ?? 3) && pending.length; round++) {
    const cands = []; const next = [];
    for (const h of pending) {
      const m = mineHandoff(engine, h, agreeFn, { base: adoptedRows });
      if (trace && round === 0) trace.push({ q: h.question, status: m.status, why: m.why ?? null, cands: m.cands.map((c) => `${c.kind}:${c.phrase}->${c.canonical}`) });
      if (round === 0) rep[{ already: 'already', mismatch: 'mismatch', 'no-lead': 'noLead', none: 'none', found: 'found' }[m.status]]++;
      if (m.status === 'already') { if (round === 0) dropped.push(h.id); else used.push(h.id); }
      else if (m.status === 'mismatch') dropped.push(h.id);
      else { cands.push(...m.cands); next.push(h); }
    }
    rep.candidates += cands.length;
    const sel = selectCandidates(cands, { existing: [...existing, ...adoptedRows], limits });
    if (round === 0) rep.rejected.push(...sel.rejected);
    const ver = verifyCandidates(engine, sel.selected.slice(0, Math.max(0, room - adoptedRows.length)), { handoffs, agree: agreeFn, regression, limits, base: adoptedRows });
    rep.rejected.push(...ver.rejected.map((r) => ({ ...r, round })));
    if (!ver.adopted.length) { for (const h of next) dropped.push(h.id); pending = []; break; }
    for (const c of ver.adopted) adoptedRows.push({ kind: c.kind, phrase: c.phrase, canonical: c.canonical, targetKind: c.targetKind, targetValue: c.targetValue, support: c.support, evidence: c.evidence, hids: c.hids ?? [] });
    pending = next;
  }
  for (const h of pending) dropped.push(h.id);
  for (const c of adoptedRows) {
    const id = await adoptLearning(db, c);
    if (id) rep.adopted.push({ id, kind: c.kind, phrase: c.phrase, canonical: c.canonical, targetKind: c.targetKind, support: c.support });
  }
  for (const c of adoptedRows) for (const i of c.hids ?? []) used.push(i);
  const usedSet = new Set(used); await markHandoffs(db, used, 'used'); await markHandoffs(db, dropped.filter((i) => !usedSet.has(i)), 'dropped');
  rep.purged = await purgeOldHandoffs(db);
  return rep;
}
