/**
 * Round 7 (2026-09-26) — before/after illustration for THIS round's own two fixes: the contentCount.js
 * "replaced X" fast path (root cause 1: content 13/27, connect/content questions 20-51s) and loopV2.js's
 * no-progress/soft-deadline early exits (root cause 2: p95 29.1s).
 *
 * HONESTY NOTE (same standard as scripts/eval/agent-latency.mjs, which this file follows and extends —
 * read that file's own header too): nothing here touches a real model or a real database. Turn counts and
 * tool-call counts for the "after" code are REAL, measured outputs of the actual code path. The "before"
 * turn counts for loopV2's early-exit scenarios are computed by the documented old arithmetic (this file
 * cannot re-run code that no longer exists), never fabricated. Per-stage MILLISECOND figures are this
 * script's own assumed constants (below, matching agent-latency.mjs's numbers so the two reports are
 * comparable), not measurements of Anthropic's API or Neon under load.
 *
 * Usage: node scripts/eval/r7-latency.mjs
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

const ASSUMPTIONS = { MODEL_CALL_MS: 1300, TOOL_CALL_MS: 140 }; // same assumed constants as agent-latency.mjs
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
for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* some depend on later files */ } }
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
const { runResearchAgent, MAX_TURNS_V2 } = await import('../../api/_lib/agent/loopV2.js');
const { parseContentCountQuestion, runContentCount } = await import('../../api/_lib/contentCount.js');
const { ANSWER_TOOL_NAME } = await import('../../api/_lib/agent/tools.js');

const OLD_MAX_TURNS_V2 = 8; // documented: this round trimmed it to 6 (see loopV2.js's own comment)

const TODAY = '2026-09-26';
const ctx = { tenantKey: 'org_eval_r7_latency', tenantName: 'R7 Latency Eval Shop' };
const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (k, n) => `f${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed() {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  await ent(uid('c', 1), 'customer', { customer_name: 'Karen Abernathy', service_address: '412 Elm St, Mesa, AZ 85201' }, { number: 'C-00001' });
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [uid('d', 1), tenantId, 'karen-service.pdf', 'service-ticket', 'eval-hash-1', 'verified']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid('d', 1), uid('c', 1)]);
  await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid('d', 1), tenantId, 1, 'Tested the run capacitor, found it weak, and replaced capacitor on site.']);
}
await seed();

let toolUseCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
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

// ---- scenario 1: content-count fast path replaces the agent entirely -----------------------------------
// BEFORE this round: "Which customers had the capacitor replaced?" never matched parseContentCountQuestion
// (see contentCount.js's own round-7 comment) and fell all the way through to the research agent, which —
// per R7_MEASURE.md's observed failure mode — typically burned several search rounds before giving up.
// AFTER: it is answered by runContentCount directly, a single indexed regex scan, ZERO model calls.
{
  const parsed = parseContentCountQuestion('Which customers had the capacitor replaced?');
  const t0 = Date.now();
  const answer = await withTenant(ctx, (db) => runContentCount(db, parsed));
  const afterMs = Date.now() - t0; // a real measurement, not an assumption — this path makes no model call at all
  // Before: a representative "the agent eventually gives up empty-handed" run — the exact shape R7_MEASURE.md
  // calls out (connect/content questions 20-51s, often "nothing in your records answers that") — modeled here
  // at the OLD 8-turn ceiling with zero-progress throughout (no early exit existed before this round).
  const beforeTurns = OLD_MAX_TURNS_V2;
  const beforeMs = beforeTurns * ASSUMPTIONS.MODEL_CALL_MS + beforeTurns * ASSUMPTIONS.TOOL_CALL_MS;
  report('content-count fast path ("which customers had the capacitor replaced?") replaces the agent entirely', {
    beforeTurns, afterTurns: 0, beforeMs, afterMs,
    note: `after: 0 model calls (measured for real, ${afterMs}ms wall clock in this harness), answer.recordsTotal=${answer?.recordsTotal ?? 'n/a'}; before: OLD_MAX_TURNS_V2=${OLD_MAX_TURNS_V2} turns of a stuck agent run, the exact shape R7_MEASURE.md observed`,
  });
}

// ---- scenario 2: no-progress early exit (a genuinely stuck agent run) -----------------------------------
{
  const ANSWER_INPUT = { status: 'none_found', text: 'Nothing in your records answers that.' };
  let turn = 0;
  const model = async () => {
    turn++;
    if (turn <= 2) return { content: [tu('search_documents', { query: 'no-such-term-anywhere-xyz' })], usage: { input_tokens: 3000, output_tokens: 200 }, stop_reason: 'tool_use' };
    return { content: [tu(ANSWER_TOOL_NAME, ANSWER_INPUT)], usage: { input_tokens: 3000, output_tokens: 200 }, stop_reason: 'tool_use' };
  };
  const after = await run('a question with no matching evidence anywhere', model);
  const afterTurns = after.modelCalls; // measured for real: stops at 3 (2 no-progress rounds + forced answer)
  // Before this round, the same stuck pattern (never finding new evidence) had no early exit and simply ran
  // out the OLD_MAX_TURNS_V2 ceiling — this is exactly R7_MEASURE's "spend 40s to say nothing found".
  const beforeTurns = OLD_MAX_TURNS_V2;
  const beforeMs = beforeTurns * ASSUMPTIONS.MODEL_CALL_MS + (beforeTurns - 1) * ASSUMPTIONS.TOOL_CALL_MS;
  const afterMs = afterTurns * ASSUMPTIONS.MODEL_CALL_MS + (afterTurns - 1) * ASSUMPTIONS.TOOL_CALL_MS;
  report('no-progress early exit (stuck agent run, e.g. "callback within 14 days" style multi-hop miss)', {
    beforeTurns, afterTurns, beforeMs, afterMs,
    note: `after-turns (${afterTurns}) measured for real via the actual early-exit code; before-turns is the documented OLD_MAX_TURNS_V2 ceiling this round replaced`,
  });
}

// ---- scenario 3: turn/tool-call ceiling itself (8/15 -> 6/12) -------------------------------------------
{
  const model = scripted([() => [tu('search_documents', { query: 'capacitor' })]]); // keeps finding SOME evidence every round, so no-progress never fires — isolates the raw ceiling change
  const after = await run('a question the model keeps searching on', model);
  report('raw turn ceiling (a run that keeps finding some evidence every round, so only the cap itself matters)', {
    beforeTurns: OLD_MAX_TURNS_V2, afterTurns: after.modelCalls,
    beforeMs: OLD_MAX_TURNS_V2 * ASSUMPTIONS.MODEL_CALL_MS + OLD_MAX_TURNS_V2 * ASSUMPTIONS.TOOL_CALL_MS,
    afterMs: after.modelCalls * ASSUMPTIONS.MODEL_CALL_MS + after.modelCalls * ASSUMPTIONS.TOOL_CALL_MS,
    note: `after-turns (${after.modelCalls}) measured for real against the new MAX_TURNS_V2=${MAX_TURNS_V2}; before is the documented old 8-turn ceiling`,
  });
}

realLog('Scenario                                                                       | before turns | after turns | before ms | after ms | change');
realLog('-'.repeat(135));
for (const r of rows) {
  realLog(`${r.name.padEnd(78)} | ${String(r.beforeTurns).padStart(12)} | ${String(r.afterTurns).padStart(12)} | ${String(r.beforeMs).padStart(9)} | ${String(r.afterMs).padStart(8)} | ${r.pct}%`);
  realLog(`  note: ${r.note}`);
}
realLog('');
const totalBefore = rows.reduce((s, r) => s + r.beforeMs, 0);
const totalAfter = rows.reduce((s, r) => s + r.afterMs, 0);
realLog(`Summed across these 3 scenarios: ${totalBefore}ms -> ${totalAfter}ms (${Math.round((1 - totalAfter / totalBefore) * 1000) / 10}% lower) — a simulated illustration, not a production SLA.`);
