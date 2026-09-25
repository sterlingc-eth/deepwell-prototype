/**
 * Donovan research agent (v2) — latency estimate for the 2026-09-25 ask-latency pass (workstream B).
 *
 * HONESTY NOTE (read this before trusting a number below): this is NOT a production benchmark. It never
 * touches a real model or a real database — everything runs against a local, in-memory PGlite instance
 * (the same harness scripts/verify-agent-v2.mjs uses) with a scripted `callModel`, so the TURN COUNTS and
 * TOOL-CALL COUNTS it prints are real, measured outputs of the actual code path (api/_lib/agent/loopV2.js),
 * but the per-stage MILLISECOND figures are this script's own ASSUMED constants (below), not measurements
 * of Anthropic's API or Neon under load. Treat "simulated ms" as "what these turn/tool counts would cost
 * at plausible-but-assumed per-stage latencies", not as a promised wall-clock number. Where this script
 * cannot re-run the OLD code (a constant was simply changed, e.g. MAX_TOOLS_PER_TURN_V2 4 -> 6), the
 * "before" turn count is computed by the same documented arithmetic the old code used, not re-executed.
 *
 * Usage: node scripts/eval/agent-latency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;
delete process.env.VOYAGE_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };

// ---- assumed per-stage latencies (ms) — documented, not measured; see the file header. ------------------
const ASSUMPTIONS = {
  MODEL_CALL_MS: 1300,     // one Anthropic tool-use round trip at this prompt's cached-system-prompt size
  TOOL_CALL_MS: 140,       // one withTenant() query (connect-from-pool + SET LOCAL + query + release)
  PREFETCH_MS: 220,        // search_documents (embeddings + entity-first filter), run before turn 1
  VERIFY_LOOKUP_MS: 45,    // one indexed document_pages/extractions point lookup in verify.js
};
realLog('ASSUMPTIONS (documented estimates, not measurements):', JSON.stringify(ASSUMPTIONS));
realLog('');

let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  realLog(`SKIP: PGlite is not installed (${err?.message}). Run npm ci. No simulated numbers to report.`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* some depend on later files, same as verify-agent-v2.mjs */ } }
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after the rest */ }

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../../api/_lib/recordsStore.js');
const { runResearchAgent, MAX_TOOLS_PER_TURN_V2 } = await import('../../api/_lib/agent/loopV2.js');

// The cap this workstream raised FROM. Not re-derived from git history — just documented here once,
// next to the number (MAX_TOOLS_PER_TURN_V2, imported above) it is being compared against.
const OLD_MAX_TOOLS_PER_TURN_V2 = 4;
realLog(`MAX_TOOLS_PER_TURN_V2: ${OLD_MAX_TOOLS_PER_TURN_V2} -> ${MAX_TOOLS_PER_TURN_V2}`);
realLog('');

const TODAY = '2026-09-25';
const ctx = { tenantKey: 'org_eval_agent_latency', tenantName: 'Latency Eval Shop' };
const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (k, n) => `f${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`; // k must be a hex char (c/e/d)

async function seed() {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  await ent(uid('c', 1), 'customer', { customer_name: 'Karen Abernathy', service_address: '412 Elm St, Mesa, AZ 85201' }, { number: 'C-00001' });
  await ent(uid('e', 1), 'equipment', { manufacturer: 'Trane', model: 'XR14', serial_number: 'TR-1001', equipment_type: 'condenser', installation_date: '2020-05-01', service_address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01' } }, { customerId: uid('c', 1) });
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [uid('d', 1), tenantId, 'karen-service.pdf', 'service-ticket', 'eval-hash-1', 'verified']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid('d', 1), uid('c', 1)]);
  await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, corrected_value, confidence) VALUES ($1,$2,$3,$4,$5,$6,0.9)', [tenantId, uid('d', 1), null, 'service_date', '2026-06-01', null]);
  await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid('d', 1), tenantId, 1, 'Serviced the Trane XR14 condenser. Replaced the capacitor.']);
  // A minimal financials row (M3-config/22-document-financials.sql) so scenario 4 below has a REAL
  // total/subtotal-style fact to verify — those fields live in document_financials, not extractions (see
  // verify.js's DETERMINISTIC_FIELD_KEYS), so a fact citing them is a genuine, reachable case of the skip.
  try {
    await lite.query(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, total, status) VALUES ($1,$2,'invoice','receivable',$3,'unpaid')`,
      [tenantId, uid('d', 1), '410.00']);
  } catch { /* migration 22 not present in this checkout — scenario 4 just reports 0 skipped, still honest */ }
}
await seed();

let toolUseCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
const hasSearchEvidence = (messages) => messages.some((m) =>
  Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('resultCount')));
function scripted(turns) {
  let i = 0;
  return async (req) => {
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const out = typeof turn === 'function' ? turn(req.messages) : turn;
    return { content: out, usage: { input_tokens: 3000, output_tokens: 200 }, stop_reason: 'tool_use' };
  };
}
const run = (question, callModel, extra = {}) => runResearchAgent({
  withTenant, ctxArg: ctx, question, today: TODAY, callModel,
  env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' }, ...extra,
});

const rows = [];
function report(name, { beforeTurns, afterTurns, beforeMs, afterMs, note }) {
  const pct = beforeMs > 0 ? Math.round((1 - afterMs / beforeMs) * 1000) / 10 : 0;
  rows.push({ name, beforeTurns, afterTurns, beforeMs, afterMs, pct, note });
}

// ---- scenario 1: batching (MAX_TOOLS_PER_TURN_V2 4 -> 6) --------------------------------------------
{
  const N = 5; // a question with 5 independent parts, e.g. a 3-part question needing 2 extra lookups
  const model = scripted([
    () => Array.from({ length: N }, (_, i) => tu(i % 2 ? 'compute' : 'find_customers', i % 2 ? { expression: `${i}+1` } : { name: 'Karen Abernathy' })),
    () => [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'eval only' })],
  ]);
  const after = await run('a 5-part question about Karen Abernathy', model);
  const afterTurns = after.modelCalls;
  const afterToolCalls = after.steps.length;
  // Before (cap=4): ceil(N/4) tool-turns, each followed by one more turn to continue/answer.
  const beforeToolTurns = Math.ceil(N / OLD_MAX_TOOLS_PER_TURN_V2);
  const beforeTurns = beforeToolTurns + 1; // + the final answer turn
  const beforeMs = beforeTurns * ASSUMPTIONS.MODEL_CALL_MS + afterToolCalls * ASSUMPTIONS.TOOL_CALL_MS;
  const afterMs = afterTurns * ASSUMPTIONS.MODEL_CALL_MS + afterToolCalls * ASSUMPTIONS.TOOL_CALL_MS;
  report('batching (5-part question, MAX_TOOLS_PER_TURN_V2 4 -> 6)', {
    beforeTurns, afterTurns, beforeMs, afterMs,
    note: `${afterToolCalls} tool calls measured for real; before-turns computed as ceil(${N}/${OLD_MAX_TOOLS_PER_TURN_V2})+1, after-turns (${afterTurns}) measured for real`,
  });
}

// ---- scenario 2: prefetch (enumeration question) ------------------------------------------------------
{
  const question = 'list all customers';
  const adaptive = [
    (messages) => (hasSearchEvidence(messages) ? [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'eval only' })] : [tu('search_documents', { query: question })]),
    () => [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'eval only' })],
  ];
  const before = await run(question, scripted(adaptive), { env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10', DONOVAN_RESEARCH_PREFETCH: '0' } });
  const after = await run(question, scripted(adaptive), { env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' } });
  const beforeMs = before.modelCalls * ASSUMPTIONS.MODEL_CALL_MS + before.steps.length * ASSUMPTIONS.TOOL_CALL_MS;
  const afterMs = after.modelCalls * ASSUMPTIONS.MODEL_CALL_MS + (after.steps.length - 1) * ASSUMPTIONS.TOOL_CALL_MS + ASSUMPTIONS.PREFETCH_MS;
  report('prefetch (enumeration question, evidence injected before turn 1)', {
    beforeTurns: before.modelCalls, afterTurns: after.modelCalls, beforeMs, afterMs,
    note: 'both turn counts measured for real (DONOVAN_RESEARCH_PREFETCH=0 vs default-on)',
  });
}

// ---- scenario 3: per-request memo (duplicate tool call across turns) ----------------------------------
{
  const model = scripted([
    () => [tu('find_customers', { name: 'Karen Abernathy' })],
    () => [tu('find_customers', { name: 'Karen Abernathy' })], // the model re-asks for the same thing
    () => [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'eval only' })],
  ]);
  const after = await run('a question that re-asks for the same lookup twice', model);
  const memoHits = after.memoHits ?? 0;
  const beforeMs = after.modelCalls * ASSUMPTIONS.MODEL_CALL_MS + after.steps.length * ASSUMPTIONS.TOOL_CALL_MS;
  const afterMs = beforeMs - memoHits * ASSUMPTIONS.TOOL_CALL_MS;
  report('per-request memo (duplicate find_customers call across turns)', {
    beforeTurns: after.modelCalls, afterTurns: after.modelCalls, beforeMs, afterMs,
    note: `turn count unchanged by design (memo saves DB work, not model turns); ${memoHits} of ${after.steps.length} tool calls served from the memo (measured for real)`,
  });
}

// ---- scenario 4: verify-skip on a deterministic (non-extractions) field --------------------------------
{
  const docId = uid('d', 1);
  // run_query against `financials` (registers `total` as a citable field — see tools.js's registerRows)
  // is the realistic path a money question takes; get_unit's own warranty fields are not registered as
  // citable this way today, so this is the fixture that actually exercises verify.js's skip end-to-end.
  const model = scripted([
    () => [tu('run_query', { sql: `SELECT document_id, total FROM financials WHERE document_id = '${docId}'`, purpose: 'eval' })],
    () => [tu('answer', {
      status: 'answered', text: 'The invoice totals $410.00.',
      facts: [{ label: 'Invoice total', value: '410.00', sources: [{ documentId: docId, location: { field: 'total' } }] }],
      confidence: 0.9,
    })],
  ]);
  const after = await run('what is the total on the invoice for Karen Abernathy', model);
  const verifySkipped = after.dropped?.verifySkipped ?? 0;
  const baseMs = after.modelCalls * ASSUMPTIONS.MODEL_CALL_MS + after.steps.length * ASSUMPTIONS.TOOL_CALL_MS;
  const beforeMs = baseMs + verifySkipped * ASSUMPTIONS.VERIFY_LOOKUP_MS; // before: this would have been looked up (and always failed open) anyway
  report('verify-skip ("total" is document_financials data, never sent to the extractions-only DB re-fetch)', {
    beforeTurns: after.modelCalls, afterTurns: after.modelCalls, beforeMs, afterMs: baseMs,
    note: `${verifySkipped} deterministic-field verify lookup(s) skipped (measured for real; would have always failed open anyway, see verify.js). handled=${after.handled}`,
  });
}

realLog('Scenario                                                              | before turns | after turns | before ms | after ms | change');
realLog('-'.repeat(120));
for (const r of rows) {
  realLog(
    `${r.name.padEnd(70)} | ${String(r.beforeTurns).padStart(12)} | ${String(r.afterTurns).padStart(12)} | ${String(r.beforeMs).padStart(9)} | ${String(r.afterMs).padStart(8)} | ${r.pct}%`
  );
  realLog(`  note: ${r.note}`);
}
realLog('');
const totalBefore = rows.reduce((s, r) => s + r.beforeMs, 0);
const totalAfter = rows.reduce((s, r) => s + r.afterMs, 0);
realLog(`Summed across these 4 scenarios: ${totalBefore}ms -> ${totalAfter}ms (${Math.round((1 - totalAfter / totalBefore) * 1000) / 10}% lower) — a simulated illustration, not a production SLA.`);
