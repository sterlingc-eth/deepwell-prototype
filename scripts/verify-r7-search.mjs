/**
 * Round 7 (2026-09-26, R7_MEASURE.md: content 13/27, p95 29.1 s) — checks for this round's own fixes,
 * scoped to the files this engineer owns:
 *
 *   api/_lib/contentCount.js
 *     - the "replaced/repaired/installed X" proximity shape (breadth-content-021/022/025/026/028), which
 *       previously never matched parseContentCountQuestion at all and fell through to the slow agent
 *     - the "drain problem" / "freeze-up" synonym groups (breadth-content-017/018/019) and the
 *       QUESTION_ALIASES split (detection-only phrasing vs. what actually gets searched for)
 *     - the refrigerant group's precision fix (recharg~ stem, r-454b, dropped over-broad "charge") and
 *       the stem ('~') mechanism in buildTermPattern/buildProximityPattern generally
 *     - isJobDocType: "jobs mention X" now uses a local, oracle-matching allow-list instead of scope.js's
 *       broader isVisitType (which counts equipment-record/other as visit types)
 *     - never-hijack: a plain "issue or repair on file" mention question is NOT captured by the new
 *       replaced-proximity shape
 *
 *   api/_lib/agent/loopV2.js
 *     - the no-progress early exit (two evidence-tool rounds with zero rows forces the next turn to answer)
 *     - the soft wall-clock deadline (forces an answer once a run's own elapsed time passes it, after at
 *       least one real tool round) — this is the actual "provisional answer / never spend 40s to say
 *       nothing found" behavior, exercised here with a mocked slow model (no real Anthropic call)
 *     - capToolResultContent (tool-output-size cap)
 *
 * Same harness style as scripts/verify-content.mjs / verify-agent-v2.mjs: a REAL Postgres via PGlite, no
 * network, no Anthropic key.
 *
 *   node scripts/verify-r7-search.mjs
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
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
// Small soft deadline so the latency-budget section below runs in well under a second of real wall-clock
// time instead of the real 14s default — read once, at module-eval time, by loopV2.js's export.
process.env.DONOVAN_RESEARCH_SOFT_DEADLINE_MS = '120';
process.env.DONOVAN_RESEARCH_DAILY_USD = process.env.DONOVAN_RESEARCH_DAILY_USD ?? '10';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;
delete process.env.VOYAGE_API_KEY;

const realLog = console.log;
const routeLines = [];
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) { routeLines.push(JSON.parse(a[0])); return; }
  realLog(...a);
};

/* ================================================================== 1. pure: contentCount vocabulary/parse */
const content = await import('../api/_lib/contentCount.js');
const {
  HVAC_TERM_SYNONYMS, expandTerms, buildTermPattern, buildProximityPattern, extractKnownTerms,
  parseContentCountQuestion,
} = content;

{
  check('vocab: refrigerant group is tight (no bare "charge") and carries the recharg~ stem + r-454b',
    !HVAC_TERM_SYNONYMS.refrigerant.includes('charge') && HVAC_TERM_SYNONYMS.refrigerant.includes('recharg~') && HVAC_TERM_SYNONYMS.refrigerant.includes('r-454b'),
    JSON.stringify(HVAC_TERM_SYNONYMS.refrigerant));
  check('vocab: drain group matches the oracle exactly (drain line/condensate/clog~), no bare "drain"',
    !HVAC_TERM_SYNONYMS.drain.includes('drain') && HVAC_TERM_SYNONYMS.drain.includes('clog~') && HVAC_TERM_SYNONYMS.drain.includes('condensate'));
  check('vocab: freeze group matches the oracle (frozen/freez~/iced)', HVAC_TERM_SYNONYMS.freeze.includes('freez~') && HVAC_TERM_SYNONYMS.freeze.includes('frozen'));
  check('vocab: a bare "motor" is its own group, distinct from "blower motor"', HVAC_TERM_SYNONYMS.motor.includes('motor') && !HVAC_TERM_SYNONYMS['blower motor'].includes('motor'));

  eq('extractKnownTerms: "a drain problem" recognizes the drain group via QUESTION_ALIASES (detection-only)', extractKnownTerms('which customers had a drain problem'), ['drain']);
  eq('extractKnownTerms: "a freeze-up" recognizes the freeze group via QUESTION_ALIASES', extractKnownTerms('how many jobs mention a freeze-up'), ['freeze']);
  check('expandTerms: the drain/freeze DB-search variants never include the QUESTION_ALIASES phrasing itself',
    !expandTerms(['drain']).includes('drain problem') && !expandTerms(['freeze']).includes('freeze-up'));

  const stemPattern = buildTermPattern(['recharg~', 'freon']);
  check('buildTermPattern: a "~" stem gets a leading boundary but NOT a trailing one', stemPattern.includes('\\y(recharg)') && !stemPattern.includes('\\y(recharg)\\y'), stemPattern);
  check('buildTermPattern: a plain (non-stem) variant still gets both boundaries', stemPattern.includes('\\y(freon)\\y'), stemPattern);
  const stemRe = new RegExp(buildTermPattern(['recharg~']).replace(/\\y/g, '\\b'), 'i');
  check('buildTermPattern: the recharg~ stem actually matches "recharged" (no literal "recharge" needed)', stemRe.test('we recharged the unit'));

  const proxPattern = buildProximityPattern('replac', ['capacitor', 'cap']);
  check('buildProximityPattern: matches verb-then-term and term-then-verb, both within the same sentence', proxPattern.includes('replac') && proxPattern.includes('capacitor') && proxPattern.includes('[^.]{0,100}'));

  eq('parseContentCountQuestion: "which customers had the capacitor replaced" -> replaced/list/customer', (({ mode, groupBy, replaceVerb }) => ({ mode, groupBy, replaceVerb }))(parseContentCountQuestion('Which customers had the capacitor replaced?')), { mode: 'list', groupBy: 'customer', replaceVerb: 'replac' });
  eq('parseContentCountQuestion: "how many times have we replaced a motor" -> replaced/count', (({ mode, groupBy, replaceVerb, terms }) => ({ mode, groupBy, replaceVerb, terms }))(parseContentCountQuestion('How many times have we replaced a motor?')), { mode: 'count', groupBy: null, replaceVerb: 'replac', terms: ['motor'] });
  check('parseContentCountQuestion: never hijacks a plain "issue or repair on file" mention question into the replaced-proximity shape', !('replaceVerb' in (parseContentCountQuestion('Which customers had a drain problem issue or repair on file?') ?? {})));
  check('parseContentCountQuestion: a bare-noun "repair"/"install" (not a verb form) never triggers the replaced shape on its own', parseContentCountQuestion('What is the repair and install policy for a capacitor?')?.replaceVerb === undefined);
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
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* some depend on later files; see verify-content.mjs */ } }
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

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { runContentCount } = content;
const ctxA = { tenantKey: 'org_r7_a', tenantName: 'Desert Peak HVAC (r7)' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const uid = (k, n) => `a${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenA, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid('c', c.n), 'customer', { customer_name: c.name, service_address: c.address }, { number: `C-0000${c.n}` });
  for (const d of world.docs) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid('d', d.n), tenA, d.file, d.type, `r7-hash-${d.n}`, 'verified']);
    for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenA, uid('d', d.n), link]);
    for (const [i, text] of (d.pages ?? []).entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid('d', d.n), tenA, i + 1, text]);
  }
}

const world = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701' },
  ],
  docs: [
    // Round 7 #1: recharg~ stem — "recharged" (never the literal word "recharge") must still count.
    { n: 1, file: 'karen-service.pdf', type: 'service-ticket', links: [uid('c', 1)], pages: ['Found low charge, recharged the system with R-410A.'] },
    // Round 7 #2: equipment-record is NOT a job (isJobDocType), even though it mentions the term.
    { n: 2, file: 'karen-nameplate-scan.pdf', type: 'equipment-record', links: [uid('c', 1)], pages: ['Refrigerant: R-410A. Model plate scan, no service performed.'] },
    // Round 7 #3: drain group via the clog~ stem ("clogged", never the literal word "clog").
    { n: 3, file: 'whitmore-service.pdf', type: 'service-ticket', links: [uid('c', 2)], pages: ['The condensate line was clogged; cleared it and tested drainage.'] },
    // Round 7 #4: freeze group via freez~ stem ("freezing").
    { n: 4, file: 'thornton-service.pdf', type: 'service-ticket', links: [uid('c', 3)], pages: ['Evaporator coil was freezing over; found a low airflow issue.'] },
    // Round 7 #5: replaced-proximity — capacitor actually replaced (same sentence).
    { n: 5, file: 'karen-capacitor.pdf', type: 'service-ticket', links: [uid('c', 1)], pages: ['Tested the run capacitor, found it weak, and replaced capacitor on site.'] },
    // Round 7 #6: capacitor MENTIONED but never replaced (different sentence / no verb nearby) — must be excluded from the replaced-proximity count even though it would count for a plain "mention" question.
    { n: 6, file: 'whitmore-capacitor-quote.pdf', type: 'proposal-quote', links: [uid('c', 2)], pages: ['Capacitor is original to the unit and untested. We discussed several other repairs on file for another system entirely.'] },
    // Round 7 #7: motor replaced (bare "motor" group).
    { n: 7, file: 'thornton-motor.pdf', type: 'work-order', links: [uid('c', 3)], pages: ['Blower ran rough; replaced the motor and rebalanced the wheel.'] },
  ],
};
await seed(world);
const run = (parsed) => withTenant(ctxA, (db) => runContentCount(db, parsed));

/* ================================================================== 2. DB: refrigerant recharg~ stem + isJobDocType */
{
  const parsedJobs = parseContentCountQuestion('How many jobs mention a refrigerant?');
  const r = await run(parsedJobs);
  eq('jobs mention refrigerant: only the service-ticket counts (recharg~ matches "recharged")', r.recordsTotal, 1);
  check('jobs mention refrigerant: the equipment-record (isJobDocType fix) is excluded even though it has the literal word', !r.records.some((x) => x.documentId === uid('d', 2)), JSON.stringify(r.records.map((x) => x.documentId)));

  const parsedDocs = parseContentCountQuestion('How many documents mention a refrigerant?');
  const rDocs = await run(parsedDocs);
  eq('documents mention refrigerant: BOTH the service-ticket and the equipment-record count (no job-type restriction at document scope)', rDocs.recordsTotal, 2);
}

/* ================================================================== 3. DB: drain / freeze groups (question aliases + stems) */
{
  const r = await run(parseContentCountQuestion('How many jobs mention a drain problem?'));
  eq('jobs mention "a drain problem" finds the clogged condensate line (clog~ stem)', r.recordsTotal, 1);
  check('drain: cites Whitmore\'s document', r.records.some((x) => x.documentId === uid('d', 3)));

  const rFreeze = await run(parseContentCountQuestion('How many jobs mention a freeze-up?'));
  eq('jobs mention "a freeze-up" finds the freezing coil (freez~ stem)', rFreeze.recordsTotal, 1);
  check('freeze: cites Thornton\'s document', rFreeze.records.some((x) => x.documentId === uid('d', 4)));
}

/* ================================================================== 4. DB: replaced-proximity (021/022/025/026/028 shape) */
{
  const rWhich = await run(parseContentCountQuestion('Which customers had the capacitor replaced?'));
  eq('which customers had the capacitor replaced: exactly one customer (Karen) — mention-only doc excluded', rWhich.records.filter((x) => x.type === 'customer').length, 1);
  check('replaced/list: names Karen', rWhich.text.includes('Karen'));
  check('replaced/list: never counts the doc that only mentions capacitor without "replac" nearby', !rWhich.records.some((x) => x.documentId === uid('d', 6)), JSON.stringify(rWhich.records.map((x) => x.documentId)));

  const rTimes = await run(parseContentCountQuestion('How many times have we replaced a capacitor?'));
  eq('how many times have we replaced a capacitor: 1 (the mention-only doc does not count)', rTimes.recordsTotal, 1);

  const rMotor = await run(parseContentCountQuestion('Which customers had the motor replaced?'));
  eq('which customers had the motor replaced: exactly one customer (Thornton)', rMotor.records.filter((x) => x.type === 'customer').length, 1);
  check('replaced/list motor: names Thornton', rMotor.text.includes('Thornton'));

  const rZero = await run(parseContentCountQuestion('How many times have we replaced a thermostat?'));
  eq('how many times have we replaced a thermostat: honest zero (none on file)', rZero.recordsTotal, 0);
  check('replaced/zero: a real sentence naming the term, never blank', rZero.text.length > 5 && /thermostat/i.test(rZero.text));
}

/* ================================================================== 5. loopV2: latency budget (mocked model, no network) */
{
  const { createToolbox } = await import('../api/_lib/agent/tools.js');
  const { ANSWER_TOOL_NAME } = await import('../api/_lib/agent/tools.js');
  const {
    runResearchAgent, MAX_TURNS_V2, MAX_TOOL_CALLS_V2, SOFT_DEADLINE_MS_V2, NO_PROGRESS_ROUND_LIMIT_V2,
    capToolResultContent, MAX_TOOL_RESULT_CHARS_V2,
  } = await import('../api/_lib/agent/loopV2.js');

  eq('R7 latency pass: MAX_TURNS_V2 trimmed to 6, MAX_TOOL_CALLS_V2 to 12 (was 8/15)', [MAX_TURNS_V2, MAX_TOOL_CALLS_V2], [6, 12]);
  eq('R7 latency pass: NO_PROGRESS_ROUND_LIMIT_V2 is 2', NO_PROGRESS_ROUND_LIMIT_V2, 2);
  check('R7 latency pass: SOFT_DEADLINE_MS_V2 picked up the test env override', SOFT_DEADLINE_MS_V2 === 120, SOFT_DEADLINE_MS_V2);

  {
    const long = 'x'.repeat(MAX_TOOL_RESULT_CHARS_V2 + 500);
    const capped = capToolResultContent(long);
    check('capToolResultContent: truncates a huge tool result and notes how much was cut', capped.length < long.length && capped.includes('truncated') && capped.startsWith('x'.repeat(50)));
    eq('capToolResultContent: leaves a short result untouched', capToolResultContent('short'), 'short');
    eq('capToolResultContent: passes through non-string content unchanged (never crashes on it)', capToolResultContent({ a: 1 }), { a: 1 });
  }

  let toolUseCounter = 0;
  const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
  const ANSWER_INPUT = { status: 'none_found', text: 'Nothing in your records answers that.' };

  // --- no-progress early exit: two rounds of a real (zero-hit) search_documents must force turn 3 to answer.
  {
    const calls = [];
    let turn = 0;
    const model = async (req) => {
      calls.push({ tool_choice: req.tool_choice });
      turn++;
      if (turn <= 2) return { content: [tu('search_documents', { query: 'no-such-term-anywhere-xyz' })], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'tool_use' };
      return { content: [tu(ANSWER_TOOL_NAME, ANSWER_INPUT)], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'tool_use' };
    };
    routeLines.length = 0;
    const result = await runResearchAgent({ withTenant, ctxArg: ctxA, question: 'anything unmatched at all', today: '2026-09-26', callModel: model, env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' } });
    check('no-progress: the run stopped at 3 model calls, not the full 6-turn budget', calls.length === 3, `calls=${calls.length}`);
    check('no-progress: turn 3 (after two zero-hit search rounds) was forced to the answer tool', JSON.stringify(calls[2].tool_choice) === JSON.stringify({ type: 'tool', name: ANSWER_TOOL_NAME }), JSON.stringify(calls[2]));
    check('no-progress: turn 1 was NOT forced (still free to explore)', calls[0].tool_choice?.type !== 'tool');
    const line = routeLines.find((l) => l.research_agent);
    check('no-progress: diagnostics record the no-progress early exit (never question/answer content)', line?.early_exit === 'no-progress', JSON.stringify(line));
    check('no-progress: run is still marked handled (a real none_found answer, not a crash)', result.handled === true || result.reason === 'answered');
  }

  // --- soft deadline: a slow (but real) first turn must force turn 2 to answer, well before the turn cap.
  {
    const calls = [];
    let turn = 0;
    const model = async (req) => {
      calls.push({ tool_choice: req.tool_choice });
      turn++;
      if (turn === 1) {
        await new Promise((resolve) => setTimeout(resolve, SOFT_DEADLINE_MS_V2 + 60));
        return { content: [tu('search_documents', { query: 'capacitor' })], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'tool_use' };
      }
      return { content: [tu(ANSWER_TOOL_NAME, { status: 'answered', text: 'x', facts: [] })], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'tool_use' };
    };
    routeLines.length = 0;
    await runResearchAgent({ withTenant, ctxArg: ctxA, question: 'a slow question', today: '2026-09-26', callModel: model, env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' } });
    check('soft-deadline: only 2 model calls were made (forced to answer right after the slow first round)', calls.length === 2, `calls=${calls.length}`);
    check('soft-deadline: turn 2 was forced to the answer tool once elapsed time passed SOFT_DEADLINE_MS_V2', JSON.stringify(calls[1].tool_choice) === JSON.stringify({ type: 'tool', name: ANSWER_TOOL_NAME }));
    const line = routeLines.find((l) => l.research_agent);
    check('soft-deadline: diagnostics record the soft-deadline early exit', line?.early_exit === 'soft-deadline', JSON.stringify(line));
  }

  // --- sanity: a normal, fast, single-turn answer is completely unaffected by either early-exit mechanism.
  {
    const calls = [];
    const model = async (req) => { calls.push(req); return { content: [tu(ANSWER_TOOL_NAME, { status: 'answered', text: 'x', facts: [] })], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'tool_use' }; };
    routeLines.length = 0;
    const result = await runResearchAgent({ withTenant, ctxArg: ctxA, question: 'a normal question', today: '2026-09-26', callModel: model, env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' } });
    // (facts:[] never satisfies shape.js's own grounding for status "answered" — irrelevant here, this
    // section only checks the LOOP stopped after turn 1 on its own, not shape.js's separate validation.)
    check('sanity: a clean one-turn answer is untouched by the new early exits (loop stopped right after the model answered)', calls.length === 1 && result.reason === 'answered', JSON.stringify({ calls: calls.length, reason: result.reason }));
    const line = routeLines.find((l) => l.research_agent);
    check('sanity: no early_exit recorded when nothing forced one', line?.early_exit == null, JSON.stringify(line));
  }

  void createToolbox; // imported for parity with the other v2 suites' toolbox helpers; not needed directly here
}

console.log = realLog;
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
