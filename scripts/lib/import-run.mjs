// Drives the import autopilot the way a diligent person would, against the real server code: file what passes, then answer every decision card
// (one click each, in chunks of 100), then file again, until nothing is left to decide. Counts decisions, clicks and what changed.
import { MAX_APPLY } from '../../api/_lib/importAutopilot.js';

export const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export async function fileAll(IA, ctx, scope, actor = 'u_test') {
  let filed = 0;
  for (let g = 0; g < 200; g++) {
    const r = await IA.importAutoFile(ctx, { ...scope, limit: 200, source: 'test' }, actor);
    filed += r.filed;
    if (!r.filed) break;
  }
  return filed;
}

/** Answer one decision card. `chooser(decision)` picks the type for a choose-type card. Returns the run summary. */
export async function answer(IA, ctx, scope, d, { by = 'Test Person', actor = 'u_test', chooser = null } = {}) {
  let runId = null, customerId = null, applied = 0, filed = 0; const skipped = [];
  for (const part of chunks(d.documentIds, MAX_APPLY)) {
    const r = await IA.importApplyDecision(ctx, { ...scope, kind: d.kind, key: d.kind === 'create-customer' ? d.id.slice('create-customer:'.length) : d.kind === 'link-suggested' ? d.params.customerId : d.id.slice(d.kind.length + 1), documentIds: part, customerId: d.kind === 'link-suggested' ? d.params.customerId : customerId, name: d.params.name, choice: chooser ? chooser(d) : undefined, by, runId }, actor);
    runId = r.runId; customerId = r.customerId ?? customerId; applied += r.applied; filed += r.filed ?? 0; skipped.push(...r.skipped);
  }
  return { id: d.id, kind: d.kind, runId, applied, filed, skipped, customerId, count: d.count };
}

export async function drive(IA, ctx, scope, { maxRounds = 6, chooser = null, answerKinds = null, log = () => {} } = {}) {
  const answered = []; const decisionIds = new Set(); let autoFiled = 0;
  autoFiled += await fileAll(IA, ctx, scope);
  for (let round = 1; round <= maxRounds; round++) {
    const plan = await IA.importPlan(ctx, { ...scope, fresh: true });
    const todo = plan.decisions.filter((d) => !answerKinds || answerKinds.includes(d.kind));
    log(`round ${round}: ${plan.decisions.length} decisions (${todo.length} answered)`);
    if (!todo.length) break;
    for (const d of todo) { decisionIds.add(d.id); answered.push({ round, ...(await answer(IA, ctx, scope, d, { chooser })) }); }
    autoFiled += await fileAll(IA, ctx, scope);
  }
  return { answered, decisionCount: decisionIds.size, autoFiled };
}

/** The click model (a click = one press): see the report for what each number assumes. */
export const CLICKS = Object.freeze({
  // before: today's Inbox (open the paper, act, mark checked) — per paper
  openActCheck: 2, linkInDetail: 3, newCustomerForm: 4, typeDate: 4, chooseType: 3, setAside: 3, lookAt: 3,
  // after: a decision is one press plus one confirm
  decision: 2,
});
