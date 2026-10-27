// Bulk import autopilot: one decision card's apply loop (chunked), and what it says when it stops part way. Run: tsx --import ./scripts/lib/register-css-stub.mjs scripts/verify-import-apply-run.ts
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, detail); } };

// ---- D7: a decision that stops part way keeps its run id and says exactly what happened ----
{
  const { runDecision } = await import('../src/components/inbox/importApplyRun');
  const d = { id: 'create-customer:acme', kind: 'create-customer' as const, params: { name: 'Acme' }, count: 250, samples: [], documentIds: Array.from({ length: 250 }, (_, i) => `d${i}`) };
  let n = 0;
  const api = async (a: { documentIds: string[]; runId?: string | null }) => { n++; if (n === 3) throw new Error('network'); return { applied: a.documentIds.length, skipped: [], runId: 'run-1', customerId: 'cust-1' }; };
  const r = await runDecision(api as never, 'b1', d, undefined, 'You');
  check('D7: part way failure keeps the run id and the number already changed', r.partial === true && r.runId === 'run-1' && r.applied === 200 && r.total === 250, JSON.stringify(r));
  n = 99;
  const ok2 = await runDecision((async (a: { documentIds: string[] }) => ({ applied: a.documentIds.length, skipped: [], runId: 'run-2' })) as never, 'b1', d, undefined, 'You');
  check('D7: a complete run is not partial', ok2.partial === false && ok2.applied === 250);
  n = 0;
  const first = await runDecision((async () => { throw new Error('down'); }) as never, 'b1', d, undefined, 'You');
  check('D7: a failure on the first chunk changed nothing and keeps no run', first.partial === false && first.applied === 0 && first.runId === null && !!first.error);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
