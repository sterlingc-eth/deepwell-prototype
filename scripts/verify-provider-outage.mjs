/**
 * ROUND 14 (owner: "71 pending" / 36% scorecard / "70 new misses ... 153 learning proposals" — all
 * caused by Anthropic credits being exhausted, not by Donovan actually failing): checks the whole
 * provider-outage path end to end —
 *   1. classifyProviderError's three shapes (credits/auth/overloaded) vs a generic error (null)
 *   2. the in-process flag's TTL lifecycle (record/get/clear/seed), fully injectable-`now`
 *   3. normalizeGapTitle (capability_gap dedupe key)
 *   4. missStore.insertAskMiss transparently rewriting a model-dependent outcome to
 *      'provider-unavailable' while the flag is up (the mechanism that fixes ask.js's miss recording
 *      WITHOUT editing ask.js)
 *   5. grader.js's gradeRubric returning a skipped/providerUnavailable result instead of a hard failure
 *   6. compare.js's scoreResults excluding skipped results from the percentage (sanity)
 *   7. migration 48 (donovan_provider_status + provider_status_mark/current/clear +
 *      learning_decide_reason + list_ask_misses_window excluding the new outcome), against a REAL
 *      Postgres (PGlite) built from the actual M3-config/*.sql migrations — same harness as
 *      verify-agent.mjs / verify-learning-loop.mjs.
 *   8. learning/replay.js: replayOne/replayMisses/replayCapabilityGap never mark an outage as
 *      "still failing", and autoResolveCapabilityGaps both resolves a gap whose example now answers
 *      and stops cleanly (leaving it pending) on a credits error.
 *
 * No network, no Anthropic key, no DATABASE_URL.
 *
 *   node scripts/verify-provider-outage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;

/* ================================================================== 1. classifyProviderError (pure) */
const claude = await import('../api/_lib/claude.js');
const { classifyProviderError, recordProviderOutage, getProviderOutage, clearProviderOutage, seedProviderOutage, resetProviderOutageForTests, ProviderUnavailableError } = claude;

{
  const credits = classifyProviderError({ status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Claude API.' } });
  check('classifyProviderError: 400 + credit-balance message -> credits', credits?.reason === 'credits', JSON.stringify(credits));
  const billing = classifyProviderError({ status: 400, type: 'invalid_request_error', message: 'This organization has been suspended for a billing issue.' });
  check('classifyProviderError: 400 + billing-issue message -> credits (flat shape, no .error wrapper)', billing?.reason === 'credits', JSON.stringify(billing));
  const auth401 = classifyProviderError({ status: 401, message: 'invalid x-api-key' });
  const auth403 = classifyProviderError({ status: 403, message: 'forbidden' });
  check('classifyProviderError: 401/403 -> auth', auth401?.reason === 'auth' && auth403?.reason === 'auth', JSON.stringify([auth401, auth403]));
  const overloaded = classifyProviderError({ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } });
  check('classifyProviderError: 529/overloaded_error -> overloaded', overloaded?.reason === 'overloaded', JSON.stringify(overloaded));
  check('classifyProviderError: a malformed-request 400 (no credit wording) is NOT a provider outage', classifyProviderError({ status: 400, error: { type: 'invalid_request_error', message: 'max_tokens is too large' } }) === null);
  check('classifyProviderError: a plain 500 is not a provider outage', classifyProviderError({ status: 500, message: 'internal error' }) === null);
  check('classifyProviderError: null/undefined -> null', classifyProviderError(null) === null && classifyProviderError(undefined) === null);
  const pue = new ProviderUnavailableError('credits', 'out of credits');
  check('ProviderUnavailableError: carries reason/detail and a named error', pue.name === 'ProviderUnavailableError' && pue.reason === 'credits' && pue.detail === 'out of credits' && /out of credits/i.test(pue.message));
}

/* ================================================================== 2. in-process TTL flag lifecycle */
{
  resetProviderOutageForTests();
  check('getProviderOutage: nothing recorded -> null', getProviderOutage(1_000) === null);
  recordProviderOutage({ reason: 'credits', detail: 'x' }, 1_000);
  const first = getProviderOutage(1_000);
  eq('recordProviderOutage: first sighting -> since === now', first && { reason: first.reason, since: first.since }, { reason: 'credits', since: 1_000 });
  recordProviderOutage({ reason: 'credits', detail: 'y' }, 60_000); // seen again, still inside TTL
  const second = getProviderOutage(60_000);
  eq('recordProviderOutage: a second sighting inside the TTL keeps the ORIGINAL "since" (honest "exhausted since")', second?.since, 1_000);
  check('getProviderOutage: still up just under the 3-minute TTL from the last sighting', getProviderOutage(60_000 + 3 * 60_000 - 1) !== null);
  check('getProviderOutage: aged out just past the 3-minute TTL clears itself', getProviderOutage(60_000 + 3 * 60_000 + 1) === null);
  resetProviderOutageForTests();
  clearProviderOutage();
  check('clearProviderOutage: immediately clears regardless of TTL', getProviderOutage(1_000) === null);

  resetProviderOutageForTests();
  seedProviderOutage({ reason: 'auth', detail: 'bad key', since: 5_000 }, 100_000);
  const seeded = getProviderOutage(100_000);
  eq('seedProviderOutage: keeps the TRUE first-sighting "since" but starts the TTL clock fresh from "now"', seeded && seeded.since, 5_000);
  check('seedProviderOutage: fresh TTL clock (does not immediately expire) even though "since" is old', getProviderOutage(100_000 + 3 * 60_000 - 1) !== null);
  seedProviderOutage({ reason: 'overloaded', detail: 'z', since: 1 }, 100_000);
  check('seedProviderOutage: never overwrites an existing local sighting', getProviderOutage(100_000)?.reason === 'auth');
  resetProviderOutageForTests();
}

/* ================================================================== 3. normalizeGapTitle (pure) */
const proposalsMod = await import('../api/_lib/learning/proposals.js');
{
  const a = proposalsMod.normalizeGapTitle('Compare two customers’ spend side-by-side!');
  const b = proposalsMod.normalizeGapTitle('  compare TWO customers spend side by side  ');
  eq('normalizeGapTitle: case, punctuation and spacing do not matter', a, b);
  check('normalizeGapTitle: empty/undefined -> empty string, never throws', proposalsMod.normalizeGapTitle(undefined) === '' && proposalsMod.normalizeGapTitle('') === '');
}

/* ================================================================== 4. missStore rewrite (fake db) */
const missStoreMod = await import('../api/_lib/missStore.js');
{
  const calls = [];
  const fakeDb = { raw: async (sql, params) => { calls.push({ sql: String(sql).trim(), params }); return { rows: [] }; } };
  resetProviderOutageForTests();
  await missStoreMod.insertAskMiss(fakeDb, { question: 'q1', outcome: missStoreMod.MISS_OUTCOMES.NO_ANSWER });
  const insertCall = () => calls.find((c) => c.sql.startsWith('INSERT INTO ask_misses'));
  check('insertAskMiss: no outage -> outcome recorded as given', insertCall()?.params?.[2] === missStoreMod.MISS_OUTCOMES.NO_ANSWER, JSON.stringify(insertCall()));

  calls.length = 0;
  recordProviderOutage({ reason: 'credits', detail: 'x' });
  await missStoreMod.insertAskMiss(fakeDb, { question: 'q2', outcome: missStoreMod.MISS_OUTCOMES.NO_ANSWER });
  check('insertAskMiss: outage up -> a model-dependent outcome is rewritten to provider-unavailable', insertCall()?.params?.[2] === 'provider-unavailable', JSON.stringify(insertCall()));

  calls.length = 0;
  await missStoreMod.insertAskMiss(fakeDb, { question: 'q3', outcome: missStoreMod.MISS_OUTCOMES.CONTACT_ZERO });
  check('insertAskMiss: a NON-model-dependent outcome (contact-lookup-zero) is left alone even during an outage', insertCall()?.params?.[2] === missStoreMod.MISS_OUTCOMES.CONTACT_ZERO, JSON.stringify(insertCall()));
  resetProviderOutageForTests();
}

/* ================================================================== 5. grader.js: gradeRubric outage branch */
const graderMod = await import('../api/_lib/scorecard/grader.js');
{
  resetProviderOutageForTests();
  const creditErr = { status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } };
  const throwingModel = async () => { throw creditErr; };
  const g = await graderMod.gradeRubric({ question: 'x', rubric: 'x', reference: [], answerText: 'x', callModel: throwingModel });
  check('gradeRubric: a credit-balance error is classified, not a generic grader failure', g.error === 'provider-unavailable' && g.providerUnavailable === true, JSON.stringify(g));
  check('gradeRubric: classifying a provider outage sets the in-process flag too', getProviderOutage()?.reason === 'credits');
  resetProviderOutageForTests();
  const genericErr = { status: 500, message: 'boom' };
  const g2 = await graderMod.gradeRubric({ question: 'x', rubric: 'x', reference: [], answerText: 'x', callModel: async () => { throw genericErr; } });
  check('gradeRubric: a genuinely unrelated failure is NOT reported as provider-unavailable', g2.error !== 'provider-unavailable' && !g2.providerUnavailable, JSON.stringify(g2));
}

/* ================================================================== 6. compare.js: scoreResults excludes skipped */
const compareMod = await import('../api/_lib/scorecard/compare.js');
{
  const results = [
    { category: 'a', passed: true, skipped: false },
    { category: 'a', passed: false, skipped: false },
    { category: 'b', passed: false, skipped: true }, // must not count against 'b'
  ];
  const scored = compareMod.scoreResults(results);
  check('scoreResults: a skipped (provider-unavailable) result does not drag the score down', scored.total === 2 && scored.passed === 1, JSON.stringify(scored));
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
const migrationNotes = {};
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { migrationNotes[f] = String(err.message).slice(0, 160); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ordering note, same as verify-agent/verify-learning-loop */ }
check('migration 48 applies cleanly on top of 25/26', !migrationNotes['48-donovan-provider-status.sql'], JSON.stringify(migrationNotes));

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return {
    query: (sql, params) => lite.query(sql, params),
    release: () => { lite.exec('RESET ROLE').finally(release); },
  };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

/* -------- 7. migration 48's SQL surface: RLS shape + the four functions */
{
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'donovan_provider_status'")).rows[0];
  const pol = (await lite.query("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'donovan_provider_status'::regclass")).rows[0];
  check('donovan_provider_status: ENABLE + FORCE row level security and ZERO policies (the function is the only door in)', rls?.rls && rls?.force && pol?.n === 0, JSON.stringify({ rls, pol }));

  await lite.query('SELECT provider_status_mark($1,$2)', ['credits', 'credit balance is too low']);
  const cur1 = (await lite.query('SELECT * FROM provider_status_current()')).rows[0];
  check('provider_status_mark + provider_status_current: round-trips reason/detail', cur1?.reason === 'credits' && cur1?.detail === 'credit balance is too low', JSON.stringify(cur1));

  const before = (await lite.query('SELECT count(*)::int AS n FROM donovan_provider_status WHERE cleared_at IS NULL')).rows[0].n;
  await lite.query('SELECT provider_status_mark($1,$2)', ['credits', 'credit balance is too low again']); // within 60s -> reuses the open sighting
  const after = (await lite.query('SELECT count(*)::int AS n FROM donovan_provider_status WHERE cleared_at IS NULL')).rows[0].n;
  eq('provider_status_mark: a re-sighting within 60s reuses the open row instead of piling up new ones', after, before);
  const cur2 = (await lite.query('SELECT * FROM provider_status_current()')).rows[0];
  check('provider_status_current: reusing an open sighting keeps its ORIGINAL detected_at (the true "since" time), even as detail is refreshed', +new Date(cur2?.detected_at) === +new Date(cur1?.detected_at) && cur2?.detail === 'credit balance is too low again', JSON.stringify({ cur1, cur2 }));

  const closed = (await lite.query('SELECT provider_status_clear() AS n')).rows[0].n;
  check('provider_status_clear: closes the open sighting(s) and reports how many', Number(closed) >= 1);
  check('provider_status_current: nothing open after clear', !(await lite.query('SELECT * FROM provider_status_current()')).rows[0]);

  const pid = (await lite.query(
    `INSERT INTO donovan_proposals (kind, payload, evidence, verification, status)
     VALUES ('capability_gap', '{"title":"probe gap","example":"probe question","note":"x"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'pending') RETURNING id`
  )).rows[0].id;
  const ok = (await lite.query('SELECT learning_decide_reason($1,$2,$3,$4) AS ok', [pid, 'auto_approved', 'system:test', 'fixed — answered now'])).rows[0].ok;
  const row = (await lite.query('SELECT status, reason FROM donovan_proposals WHERE id = $1', [pid])).rows[0];
  check('learning_decide_reason: sets BOTH status and reason in one call, and a capability_gap never writes a donovan_learned overlay row', ok && row.status === 'auto_approved' && row.reason === 'fixed — answered now'
    && (await lite.query('SELECT count(*)::int AS n FROM donovan_learned')).rows[0].n === 0, JSON.stringify(row));

  const { getTenantContext: getTenantContextProbe } = await import('../api/_lib/recordsStore.js');
  const probeTenant = await getTenantContextProbe('org_outage_probe', 'Outage Probe');
  const missSql = `INSERT INTO ask_misses (tenant_id, question, question_normalized, outcome) VALUES ($1,$2,$3,$4)`;
  await lite.query(missSql, [probeTenant.id, 'q outage', 'q-outage-norm', 'provider-unavailable']);
  await lite.query(missSql, [probeTenant.id, 'q real miss', 'q-real-miss-norm', 'no-answer']);
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  const windowRows = (await lite.query('SELECT * FROM list_ask_misses_window($1,$2)', [from, to])).rows;
  check('list_ask_misses_window: excludes provider-unavailable rows (fixes both the miss digest and the learning proposer\'s fodder)',
    windowRows.some((r) => r.question_normalized === 'q-real-miss-norm') && !windowRows.some((r) => r.question_normalized === 'q-outage-norm'), JSON.stringify(windowRows.map((r) => r.question_normalized)));
}

/* -------- 8. learning/replay.js: outage never becomes "still failing"; autoResolveCapabilityGaps */
{
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const store = await import('../api/_lib/learning/store.js');
  const replayStore = await import('../api/_lib/learning/replayStore.js');
  const { replayMisses, replayCapabilityGap, autoResolveCapabilityGaps } = await import('../api/_lib/learning/replay.js');
  const { recordAskMiss, MISS_OUTCOMES } = await import('../api/_lib/missStore.js');
  const { normalizeQuestion } = await import('../api/_lib/nlNormalize.js');

  const ctx = { tenantKey: 'org_outage_replay', tenantName: 'Outage Replay Shop' };
  const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const uid = (k, n) => `bbbbbbbb-000${k}-4000-8000-${String(n).padStart(12, '0')}`;
  // Same seed shape as verify-learning-loop.mjs's own tenant A / Q_LIST fixture (a proven grounded,
  // agent-answerable "who has a current warranty" question) — reused here rather than re-deriving
  // agent/tools.js's warranty_status computation from scratch.
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer','{\"customer_name\":\"Karen Abernathy\",\"service_address\":\"412 Elm St, Mesa, AZ 85201\",\"email\":\"karen@example.com\"}'::jsonb,'C-00001')",
    [uid('c', 1), tenId]
  );
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,'equipment','{\"manufacturer\":\"Trane\",\"model\":\"XR14\",\"serial_number\":\"TR-1\",\"equipment_type\":\"condenser\",\"installation_date\":\"2020-05-01\",\"service_address\":\"412 Elm St, Mesa, AZ 85201\",\"warranty\":{\"expires\":\"2030-05-01\"}}'::jsonb,$3)",
    [uid('e', 1), tenId, uid('c', 1)]
  );

  const Q = 'who all has current warranties';
  const SQL = 'SELECT c.customer_id, c.name, e.model, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name, e.model';
  let tuId = 0;
  const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++tuId}`, name, input });
  const lastResult = (messages) => { const last = messages[messages.length - 1]; const b = Array.isArray(last.content) ? last.content.find((x) => x.type === 'tool_result') : null; return b ? JSON.parse(b.content) : null; };
  const answeringModel = async (req) => {
    if (req.messages.length === 1) return { content: [tu('run_query', { purpose: 'warranties', sql: SQL })], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' };
    const p = lastResult(req.messages);
    const names = [...new Set(p.rows.map((r) => r[1]))];
    return {
      content: [tu('answer', { status: 'answered', text: `${names.length} customer(s) have a current warranty.`, facts: names.map((n) => { const rs = p.rows.filter((r) => r[1] === n); return { label: n, value: rs.map((r) => `${r[2]} ${r[3]}`).join('; '), entityId: rs[0][0] }; }) })],
      usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use',
    };
  };

  resetProviderOutageForTests();
  const creditErr = { status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Claude API.' } };
  await recordAskMiss(ctx, { question: Q, questionNormalized: normalizeQuestion(Q).normalized, outcome: MISS_OUTCOMES.NO_ANSWER });
  const throwingModel = async () => { throw creditErr; };

  const rm = await replayMisses({ ctxArg: ctx, callModel: throwingModel, today: '2026-09-26' });
  check('replayMisses: a provider outage stops the batch with stopReason model-credits, nothing "attempted"', rm.stopped === 'model-credits' && rm.attempted === 0 && (rm.providerUnavailable ?? 0) >= 1, JSON.stringify(rm));
  const rep = await replayStore.listReplays(ctx, [normalizeQuestion(Q).normalized]);
  check('replayOne: an outage writes NO replay row at all (the miss stays "not replayed yet", never "still failing")', !rep.get(normalizeQuestion(Q).normalized));

  const gapPayload = { title: 'probe capability gap', example: Q, note: 'cannot compare yet' };
  const gapId = await store.insertProposal({ kind: 'capability_gap', payload: gapPayload, evidence: { count: 1, tenantCount: 1 }, verification: {}, status: 'pending' });
  const rcg = await replayCapabilityGap({ ctxArg: ctx, proposal: { id: gapId, payload: gapPayload }, callModel: throwingModel });
  check('replayCapabilityGap: an outage is reported as "stopped: model-credits", never a false "still failing"', rcg.replayed === false && rcg.stopped === 'model-credits');

  const arg1 = await autoResolveCapabilityGaps({ ctxArg: ctx, callModel: throwingModel });
  const stillPending1 = (await store.listProposals({ status: 'pending', limit: 500 })).find((p) => p.id === gapId);
  check('autoResolveCapabilityGaps: stops on a credits error and leaves the gap exactly as it was (pending)', arg1.stopped === 'model-credits' && arg1.resolved === 0 && Boolean(stillPending1), JSON.stringify(arg1));

  resetProviderOutageForTests();
  const arg2 = await autoResolveCapabilityGaps({ ctxArg: ctx, callModel: answeringModel });
  const resolved = (await store.listProposals({ status: 'auto_approved', limit: 500 })).find((p) => p.id === gapId);
  check('autoResolveCapabilityGaps: a gap whose example is now answered auto-resolves with the "fixed" note', arg2.resolved >= 1 && resolved?.reason === 'fixed — answered now', JSON.stringify({ arg2, resolved }));
}

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
