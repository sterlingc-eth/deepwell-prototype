/**
 * Checks for Donovan's LEARNING LOOP - the part that makes "Donovan learns" true:
 * miss replay, recipes (worked examples + exact-match no-model replay), the recipe activation
 * policy, the thumbs feedback, and the honest miss/learning data the UI shows.
 *
 * No network, no Anthropic key, no DATABASE_URL: the model is a scripted fake and the database is a
 * REAL Postgres (PGlite) loaded from the actual M3-config/*.sql migrations (including the optional
 * 29-donovan-recipes.sql), queried as the NOBYPASSRLS app role, same harness as verify-agent.mjs.
 *
 *   node scripts/verify-learning-loop.mjs
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
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_AUTO_LEARN;
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;

// Everything the code logs goes here so we can prove no question text is ever logged.
const logged = [];
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
console.log = (...a) => { logged.push(a.map(String).join(' ')); if (typeof a[0] === 'string' && (a[0].startsWith('{"route"'))) return; realLog(...a); };
console.warn = (...a) => { logged.push(a.map(String).join(' ')); };
console.error = (...a) => { logged.push(a.map(String).join(' ')); };

/* ================================================================== 1. pure: recipes.js + policy */
const R = await import('../api/_lib/learning/recipes.js');
const { decideRecipeStatus } = await import('../api/_lib/learning/policy.js');
const { rowsToOverlay } = await import('../api/_lib/learning/overlay.js');

{
  eq('normalizeRecipeQuestion: case, spacing and trailing punctuation do not matter', R.normalizeRecipeQuestion('  Who ALL has current warranties?? '), R.normalizeRecipeQuestion('who all has current warranties'));
  check('a single-record question never becomes a recipe', R.recipeQuestionBlocker('what is the model at 17 Cactus Ln') === 'single-record question');
  check('a question carrying an email or a phone never becomes a recipe', R.recipeQuestionBlocker('customers like bob@example.com in mesa') !== null && R.recipeQuestionBlocker('who is 480-555-0148 in mesa') !== null);
  check('a money question never becomes a recipe', R.recipeQuestionBlocker('what is the total dollar amount of our open invoices') === 'money question');
  eq('an ordinary aggregate question has no blocker', R.recipeQuestionBlocker('how many customers have an email on file'), null);

  const lit = (sql, q, opts) => R.literalsAllowed(sql, q, opts).ok;
  check('SQL literals: dates, zips, document types and brands are fine', lit("SELECT 1 FROM documents_v WHERE service_date >= '2026-01-01' AND document_type = 'permit' AND lower(manufacturer) = 'trane' AND zip = '85201'", 'permits since january for trane in 85201'));
  check('SQL literals: a word taken from the question is fine (a city)', lit("SELECT 1 FROM customers WHERE city = 'Mesa'", 'customers in mesa with a phone'));
  check('SQL literals: a word NOT in the question or the vocabulary is refused (data literal)', !lit("SELECT 1 FROM customers WHERE name = 'Karen Abernathy'", 'customers with a phone'));
  check('SQL literals: a customer-name word is refused even when the question contains it', !lit("SELECT 1 FROM customers WHERE name ILIKE '%abernathy%'", 'customers named abernathy', { nameTokens: new Set(['abernathy', 'karen']) }));
  check('SQL literals: anything with digits that is not a date/zip is refused (serial, phone, address)', !lit("SELECT 1 FROM equipment WHERE serial_number = 'GD-2002'", 'units with serial gd-2002') && !lit("SELECT 1 FROM customers WHERE address ILIKE '%412 Elm%'", 'who lives at 412 elm'));

  const cols = ['customer_id', 'name', 'model', 'warranty_expires'];
  const rows = [
    { customer_id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Karen', model: 'XR14', warranty_expires: '2030-05-01' },
    { customer_id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Karen', model: 'S9V2', warranty_expires: '2029-01-01' },
    { customer_id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Bill', model: 'GSX', warranty_expires: '2026-10-15' },
  ];
  eq('resultSignature: same rows in a different order give the same signature', R.resultSignature(cols, rows), R.resultSignature(cols, [...rows].reverse()));
  check('resultSignature: different data gives a different signature', R.resultSignature(cols, rows) !== R.resultSignature(cols, rows.slice(1)));
  const facts = [
    { label: 'Karen', value: 'XR14 2030-05-01; S9V2 2029-01-01', entityId: 'aaaaaaaa-0000-4000-8000-000000000001' },
    { label: 'Bill', value: 'GSX 2026-10-15', entityId: 'aaaaaaaa-0000-4000-8000-000000000002' },
  ];
  const tpl = R.deriveTemplate({ text: '2 customers have a current warranty.', facts, columns: cols, rows, question: 'who all has current warranties' });
  check('deriveTemplate(list): label/value/id columns found, the count becomes {n}, no data in the template', tpl?.mode === 'list' && tpl.labelCol === 'name' && tpl.idCol === 'customer_id' && tpl.text === '{n} customers have a current warranty.' && !/Karen|Bill|\d{4}/.test(tpl.text), JSON.stringify(tpl));
  const recipe = { question: 'who all has current warranties', sqls: ['SELECT customer_id, name, model, warranty_expires FROM equipment'], columns: cols, rowCount: 3, signature: 'x', template: tpl };
  const fresh = R.composeFromRecipe(recipe, cols, [...rows, { customer_id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Cara', model: 'Z9', warranty_expires: '2031-01-01' }]);
  check('composeFromRecipe(list): fresh rows compose ALL groups with the fresh total', fresh.ok && fresh.input.facts.length === 3 && fresh.input.text === '3 customers have a current warranty.' && fresh.input.facts[0].value === 'XR14 · 2030-05-01; S9V2 · 2029-01-01', JSON.stringify(fresh.input ?? fresh));
  check('composeFromRecipe: a different column set (schema drift) is refused', R.composeFromRecipe(recipe, ['a', 'b'], rows).ok === false);
  check('composeFromRecipe: zero fresh rows is refused (the agent must say none_found itself)', R.composeFromRecipe(recipe, cols, []).ok === false);
  const cnt = R.deriveTemplate({ text: 'You have 7 customers with an email in Mesa.', facts: [{ label: 'Mesa customers with email', value: '7' }], columns: ['n'], rows: [{ n: 7 }], question: 'how many mesa customers have an email' });
  check('deriveTemplate(count): "You have {n} customers with an email in Mesa."', cnt?.mode === 'count' && cnt.text === 'You have {n} customers with an email in Mesa.', JSON.stringify(cnt));
  check('deriveTemplate(count): a sentence with a name that is not in the question yields no template', R.deriveTemplate({ text: 'Karen Abernathy is 1 of them.', facts: [{ label: 'x', value: '1' }], columns: ['n'], rows: [{ n: 1 }], question: 'how many customers' }) === null);
  check('deriveTemplate(count): a sentence with a second number yields no template', R.deriveTemplate({ text: 'You have 7 of 9 customers.', facts: [{ label: 'x', value: '7' }], columns: ['n'], rows: [{ n: 7 }], question: 'how many customers' }) === null);

  check('verifyRecipe accepts a clean recipe', R.verifyRecipe(recipe).ok === true, JSON.stringify(R.verifyRecipe(recipe)));
  const tampered = R.verifyRecipe({ ...recipe, sqls: ['SELECT * FROM tenants'] });
  check('verifyRecipe refuses a recipe whose SQL the guard rejects (tampered row)', tampered.ok === false && /guard/.test(tampered.reasons.join(' ')), JSON.stringify(tampered));
  check('verifyRecipe refuses a malformed payload', R.verifyRecipe({ question: 'x' }).ok === false && R.verifyRecipe(null).ok === false);

  // Activation policy
  eq('policy: one sighting stays pending', decideRecipeStatus({ seen: 1 }, { ok: true }, 'vocab').status, 'pending');
  eq('policy: the same result signature twice auto-approves', decideRecipeStatus({ seen: 2 }, { ok: true }, 'vocab').status, 'auto_approved');
  eq('policy: an operator approval activates after one sighting', decideRecipeStatus({ seen: 1, operatorApproved: true }, { ok: true }, 'vocab').status, 'approved');
  eq('policy: a user thumbs-up on top of one grounded run auto-approves', decideRecipeStatus({ seen: 1, thumbsUp: 1 }, { ok: true }, 'vocab').status, 'auto_approved');
  eq('policy: a thumbs-up with no grounded run behind it stays pending', decideRecipeStatus({ seen: 0, thumbsUp: 1 }, { ok: true }, 'vocab').status, 'pending');
  eq('policy: DONOVAN_AUTO_LEARN=off blocks both automatic routes', [decideRecipeStatus({ seen: 5 }, { ok: true }, 'off').status, decideRecipeStatus({ seen: 1, thumbsUp: 2 }, { ok: true }, 'off').status], ['pending', 'pending']);
  eq('policy: a failed verification is never activated, even by an operator', decideRecipeStatus({ seen: 9, operatorApproved: true }, { ok: false, reasons: ['bad'] }, 'all').status, 'auto_rejected');

  // Overlay only ever exposes ACTIVE learned rows
  const ov = rowsToOverlay([{ kind: 'recipe', key: 'k', value: recipe }, { kind: 'recipe', key: 'bad', value: { nope: true } }, { kind: 'typo', key: 'a', value: { from: 'waranty', to: 'warranty' } }]);
  check('overlay: an active recipe row lands in overlay.recipes; a malformed one and other kinds do not', ov.recipes.length === 1 && ov.typos.waranty === 'warranty');

  const bank = [
    { question: 'who all has current warranties', sqls: ['SELECT c.name FROM customers c'], columns: ['name'], signature: 's' },
    { question: 'how many customers have an email on file', sqls: ['SELECT count(*) AS n FROM customers'], columns: ['n'], signature: 's' },
    { question: 'which units were installed in 2024', sqls: ['SELECT model FROM equipment'], columns: ['model'], signature: 's' },
    { question: 'list documents by type', sqls: ['SELECT document_type FROM documents_v'], columns: ['document_type'], signature: 's' },
  ];
  const top = R.selectWorkedExamples(bank, 'who has current warranties in mesa', 3);
  check('selectWorkedExamples: the closest recipe by token overlap comes first; an unrelated one is not chosen', top[0]?.question === 'who all has current warranties' && !top.some((t) => t.question.includes('installed')), JSON.stringify(top.map((t) => t.question)));
  eq('selectWorkedExamples: nothing similar -> nothing injected', R.selectWorkedExamples(bank, 'what colour is the van', 3), []);
  check('selectWorkedExamples: at most n', R.selectWorkedExamples(bank, 'how many customers have current warranties documents installed', 2).length <= 2);
  check('formatWorkedExamples is small and names the shape-not-value rule', R.formatWorkedExamples(top).length < 1500 && /never copy a value/.test(R.formatWorkedExamples(top)));
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
  console.log = realLog;
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
  catch (err) { migrationNotes[f] = String(err.message).slice(0, 120); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ordering note, same as verify-agent */ }
check('migration 29 (optional recipes/replays) applies cleanly on top of 26', !migrationNotes['29-donovan-recipes.sql'] && !migrationNotes['26-donovan-learning.sql'], JSON.stringify(migrationNotes));

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
const statementLog = [];
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return {
    query: (sql, params) => { statementLog.push(String(sql).trim()); return lite.query(sql, params); },
    release: () => { lite.exec('RESET ROLE').finally(release); },
  };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { statementLog.push(String(sql).trim()); return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const store = await import('../api/_lib/learning/store.js');
const replayStore = await import('../api/_lib/learning/replayStore.js');
const { replayMisses, submitRecipe, applyThumbsUp, applyThumbsDown, replayCapabilityGap, missKey } = await import('../api/_lib/learning/replay.js');
const { getActiveOverlay, resetActiveOverlayCacheForTests } = await import('../api/_lib/learning/overlay.js');
const { runDonovanAgent, resetCatalogueCacheForTests } = await import('../api/_lib/agent/loop.js');
const { runRecipeFastPath } = await import('../api/_lib/agent/fastReplay.js');
const { recordAskMiss, MISS_OUTCOMES } = await import('../api/_lib/missStore.js');
const { normalizeQuestion } = await import('../api/_lib/nlNormalize.js');

const TODAY = '2026-09-23';
const ctxA = { tenantKey: 'org_loop_a', tenantName: 'Founder Shop' };
const ctxB = { tenantKey: 'org_loop_b', tenantName: 'Other Shop' };
const ctxC = { tenantKey: 'org_loop_c', tenantName: 'Budget Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const tenC = (await getTenantContext(ctxC.tenantKey, ctxC.tenantName)).id;
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address, phone: null, email: c.email ?? null }, { number: `C-0000${c.n}` });
  for (const e of world.equipment) await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: 'condenser', installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) }, { customerId: uid(t, 'c', e.customer) });
}
await seed('a', tenA, {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201', email: 'karen@example.com' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201', email: 'bill@example.com' },
    { n: 3, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 4, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701', email: 'donna@example.com' },
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01' } },
    { n: 2, customer: 2, mfr: 'Goodman', model: 'GSX14', serial: 'GD-2', installed: '2016-10-15', address: '88 Whitmore Ave, Mesa, AZ 85201', warranty: { expires: '2026-10-15' } },
    { n: 3, customer: 3, mfr: 'Carrier', model: '24ACC', serial: 'CR-3', installed: '2014-01-01', address: '2210 E Main St, Gilbert, AZ 85234', warranty: { expires: '2024-01-01' } },
  ],
});
await seed('b', tenB, {
  customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501', email: 'zed@example.com' }, { n: 2, name: 'Yara Rival', address: '2 Secret Way, Reno, NV 89501', email: 'yara@example.com' }, { n: 3, name: 'Xavier Other', address: '3 Secret Way, Reno, NV 89501', email: 'x@example.com' }, { n: 4, name: 'Wren Other', address: '4 Secret Way, Reno, NV 89501', email: 'w@example.com' }, { n: 5, name: 'Vic Other', address: '5 Secret Way, Reno, NV 89501', email: 'v@example.com' }],
  equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9', installed: '2022-01-01', address: '1 Secret Way, Reno, NV 89501', warranty: { expires: '2035-01-01' } }],
});
await seed('c', tenC, { customers: [{ n: 1, name: 'Cee Cee', address: '1 Palm Way, Mesa, AZ 85201', email: 'cc@example.com' }], equipment: [] });

/* ------------------------------------------------------------------ the scripted brain */
let tuId = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++tuId}`, name, input });
const lastResult = (messages) => { const last = messages[messages.length - 1]; const b = Array.isArray(last.content) ? last.content.find((x) => x.type === 'tool_result') : null; return b ? JSON.parse(b.content) : null; };

const Q_COUNT = 'how many customers have an email on file';
const Q_LIST = 'who all has current warranties';
const Q_LIFE = 'what is the meaning of life';
const Q_MONEY = 'what is the total revenue this year';
const SQL_COUNT = "SELECT count(*) AS n FROM customers WHERE email IS NOT NULL AND email <> ''";
const SQL_LIST = 'SELECT c.customer_id, c.name, e.model, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name, e.model';

const scripts = {
  [Q_COUNT]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'count', sql: SQL_COUNT })]
    : [tu('answer', { status: 'answered', text: `You have ${lastResult(req.messages).rows[0][0]} customers with an email on file.`, facts: [{ label: 'Customers with email', value: String(lastResult(req.messages).rows[0][0]) }] })],
  [Q_LIST]: (i, req) => {
    if (i === 0) return [tu('run_query', { purpose: 'warranties', sql: SQL_LIST })];
    const p = lastResult(req.messages);
    const names = [...new Set(p.rows.map((r) => r[1]))];
    return [tu('answer', { status: 'answered', text: `${names.length} customers have a current warranty.`, facts: names.map((n) => { const rs = p.rows.filter((r) => r[1] === n); return { label: n, value: rs.map((r) => `${r[2]} ${r[3]}`).join('; '), entityId: rs[0][0] }; }) })];
  },
  [Q_LIFE]: () => [tu('answer', { status: 'cannot_answer', text: 'x', missing: 'the records do not say' })],
};

function brain(extraScripts = {}) {
  const all = { ...scripts, ...extraScripts };
  const state = new Map();
  const seen = [];
  const fn = async (req) => {
    const text = req.messages[0].content[0].text;
    const q = /QUESTION: (.*?)(?:\n\nREVIEWER NOTE|$)/s.exec(text)[1].trim();
    if (req.messages.length === 1) state.set(q, 0);
    const i = state.get(q) ?? 0;
    state.set(q, i + 1);
    seen.push({ q, firstText: text, turn: i });
    const script = all[q];
    if (!script) throw new Error(`no script for ${q}`);
    return { content: script(i, req), usage: { input_tokens: 1500, output_tokens: 150 }, stop_reason: 'tool_use' };
  };
  fn.seen = seen;
  fn.runsFor = (q) => seen.filter((s) => s.q === q && s.turn === 0).length;
  return fn;
}
const noModel = async () => { throw new Error('the model must not be called here'); };
const missRow = (ctx, q, outcome = MISS_OUTCOMES.NO_ANSWER) => recordAskMiss(ctx, { question: q, questionNormalized: normalizeQuestion(q).normalized, outcome });
const activeRecipes = async () => (await store.listActiveLearned()).filter((r) => r.kind === 'recipe');

/* ================================================================== 2. storage: migration 29 */
{
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'ask_miss_replays'")).rows[0];
  check('ask_miss_replays has ENABLE + FORCE row level security and a tenant policy', rls?.rls && rls?.force && (await lite.query("SELECT 1 FROM pg_policy WHERE polrelid = 'ask_miss_replays'::regclass")).rows.length === 1);
  const id = await store.insertProposal({ kind: 'recipe', payload: { question: 'storage probe question', sqls: ['SELECT 1'], columns: ['x'], signature: 's' }, evidence: { seen: 1 }, verification: { ok: true }, status: 'pending' });
  check('donovan_proposals accepts kind recipe (CHECK widened)', Boolean(id));
  check('a pending recipe is NOT in the active overlay', (await activeRecipes()).length === 0);
  await store.decideProposal(id, 'approved', 'test');
  const act = await activeRecipes();
  check('approving a recipe writes a donovan_learned row (learning_decide) that learning_list_active returns', act.length === 1 && act[0].value.question === 'storage probe question', JSON.stringify(act));
  await store.deactivateLearned(act[0].id);
  check('a deactivated recipe leaves the active list', (await activeRecipes()).length === 0);
  const found = await store.findRecipes('storage probe question');
  check('findRecipes returns the proposal by question; updateRecipeProposal only edits PENDING ones', found.length === 1 && (await store.updateRecipeProposal(found[0].id, found[0].payload, { seen: 9 })) === false);
}

/* ================================================================== 3. MISS REPLAY: success, failure, recipes */
{
  for (const q of [Q_COUNT, Q_LIST, Q_LIFE, Q_MONEY]) await missRow(ctxA, q, q === Q_MONEY ? MISS_OUTCOMES.MONEY_FALLBACK : MISS_OUTCOMES.NO_ANSWER);
  await missRow(ctxA, Q_COUNT); // asked twice
  await missRow(ctxB, 'which other shop question should never run for shop a'); // tenant B miss
  const model = brain({ 'which other shop question should never run for shop a': () => [tu('answer', { status: 'cannot_answer', text: 'x' })] });
  const beforeAsks = (await lite.query("SELECT coalesce(sum(units), 0)::int AS n FROM rate_limit_windows WHERE tenant_id = $1 AND bucket LIKE '%ask%'", [tenA])).rows[0].n;
  const s = await replayMisses({ ctxArg: ctxA, callModel: model, today: TODAY });
  check('replay: 3 open misses replayed (duplicate collapsed, money-gated miss skipped, other shop\'s miss untouched)', s.attempted === 3 && s.remaining === 0 && !model.seen.some((x) => x.q.includes('other shop')) && !model.seen.some((x) => x.q === Q_MONEY), JSON.stringify(s));
  check('replay: 2 answered now, 1 still failing (with a human reason)', s.answeredNow === 2 && s.stillFailing === 1 && s.items.find((i) => i.outcome === 'still_failing')?.reason === 'the records cannot answer it, or the answer was not grounded', JSON.stringify(s.items));
  const rep = await replayStore.listReplays(ctxA, [Q_COUNT, Q_LIST, Q_LIFE].map((q) => normalizeQuestion(q).normalized));
  const rc = rep.get(normalizeQuestion(Q_COUNT).normalized);
  check('replay: outcome recorded per miss - answered_now carries the answer, still_failing the reason', rc?.outcome === 'answered_now' && rc.answer?.text === 'You have 3 customers with an email on file.' && rep.get(normalizeQuestion(Q_LIFE).normalized)?.outcome === 'still_failing' && rep.get(normalizeQuestion(Q_LIFE).normalized)?.reason, JSON.stringify([...rep.values()]).slice(0, 300));
  const afterAsks = (await lite.query("SELECT coalesce(sum(units), 0)::int AS n FROM rate_limit_windows WHERE tenant_id = $1 AND bucket LIKE '%ask%'", [tenA])).rows[0].n;
  eq('replay never counts against the allowance (no asks-this-month increment)', afterAsks, beforeAsks);
  check('replay records real model usage through recordModelCall (2 grounded questions x 2 runs + 1 failing run > 0 calls)', (await lite.query('SELECT model_calls FROM usage_counters WHERE tenant_id = $1', [tenA])).rows.reduce((n, r) => n + Number(r.model_calls), 0) >= 9);
  const open = await replayStore.listOpenMisses(ctxA, {});
  check('the open-miss list now carries each miss\'s replay outcome', open.find((m) => m.normalized === normalizeQuestion(Q_COUNT).normalized)?.replay?.outcome === 'answered_now' && open.find((m) => m.normalized === normalizeQuestion(Q_LIFE).normalized)?.replay?.outcome === 'still_failing');

  // Recipes: confirmation run -> same signature twice -> auto-approved -> live
  const rec = await activeRecipes();
  check('recipes: both grounded answers produced the SAME result signature twice -> auto-approved and ACTIVE', rec.length === 2 && rec.every((r) => r.value.signature && r.value.sqls.length === 1), JSON.stringify(rec.map((r) => r.value.question)));
  check('recipes: the failing question produced no recipe', !rec.some((r) => r.value.question.includes('meaning of life')));
  const proposals = await store.listProposals({ limit: 50 });
  const recProps = proposals.filter((p) => p.kind === 'recipe' && p.payload.question !== 'storage probe question');
  check('recipes: stored as auto_approved recipe proposals with evidence seen=2', recProps.length === 2 && recProps.every((p) => p.status === 'auto_approved' && p.evidence.seen === 2), JSON.stringify(recProps.map((p) => [p.status, p.evidence])));
  const blob = JSON.stringify(rec.map((r) => r.value));
  check('recipes carry no shop data (no customer names, emails, addresses, ids)', !/Karen|Whitmore|Plaza|Thornton|example\.com|Elm St|aaaaaaaa|-0000-4000/.test(blob), blob.slice(0, 300));
  const ov = await getActiveOverlay();
  check('the active overlay picked the new recipes up immediately (cache invalidated on activation)', ov.recipes.length === 2);
  check('nothing logged during replays contains question text (counts only)', !logged.some((l) => l.includes('email on file') || l.includes('current warranties') || l.includes('meaning of life')), logged.filter((l) => l.includes('warranties')).join('|').slice(0, 200));
}

/* ================================================================== 4. worked examples + exact-match fast replay */
{
  const ov = await getActiveOverlay();
  const seenReq = [];
  const spy = async (req) => { seenReq.push(req.messages[0].content[0].text); return { content: [tu('answer', { status: 'cannot_answer', text: 'x' })], usage: { input_tokens: 1000, output_tokens: 50 }, stop_reason: 'tool_use' }; };
  const r = await runDonovanAgent({ withTenant, ctxArg: ctxA, question: 'how many customers in mesa have an email on file', today: TODAY, overlay: ov, callModel: spy });
  check('injection: a similar question gets the worked example (question + SQL) in its prompt, top-3 only', /WORKED EXAMPLES/.test(seenReq[0]) && seenReq[0].includes(SQL_COUNT) && r.examplesInjected >= 1 && r.examplesInjected <= 3 && !seenReq[0].includes(SQL_LIST), seenReq[0].slice(0, 400));
  check('injection: the block is small', seenReq[0].length < 2500, String(seenReq[0].length));
  const seenReq2 = [];
  await runDonovanAgent({ withTenant, ctxArg: ctxA, question: 'what colour is the office van', today: TODAY, overlay: ov, callModel: async (req) => { seenReq2.push(req.messages[0].content[0].text); return { content: [tu('answer', { status: 'cannot_answer', text: 'x' })], usage: { input_tokens: 1000, output_tokens: 50 }, stop_reason: 'tool_use' }; } });
  check('injection: an unrelated question gets no examples', !/WORKED EXAMPLES/.test(seenReq2[0]));

  // Exact-match fast replay: no model call, fresh SQL, deterministic answer
  const { findExactRecipe } = await import('../api/_lib/learning/recipes.js');
  const recipe = findExactRecipe(ov.recipes, Q_COUNT);
  check('fast replay: an ACTIVE single-query recipe is found for the exact question (case/punctuation-insensitive)', Boolean(recipe) && findExactRecipe(ov.recipes, 'How many customers have an email on file?') === recipe);
  check('fast replay: not found for a merely similar question', findExactRecipe(ov.recipes, 'how many customers in mesa have an email on file') === null);
  const fast = await runRecipeFastPath({ withTenant, ctxArg: ctxA, recipe, question: Q_COUNT, today: TODAY });
  check('fast replay: answered from FRESH rows with the recipe template and zero model calls', fast.handled && fast.modelCalls === 0 && fast.costUsd === 0 && fast.data.text === 'You have 3 customers with an email on file.' && fast.data.facts[0].value === '3', JSON.stringify(fast.data ?? fast));
  await seed('a', tenA, { customers: [{ n: 9, name: 'New Customer', address: '9 New St, Mesa, AZ 85201', email: 'new@example.com' }], equipment: [] });
  const fast2 = await runRecipeFastPath({ withTenant, ctxArg: ctxA, recipe, question: Q_COUNT, today: TODAY });
  check('fast replay: fresh data is reflected (4 after a new customer with an email), not a cached number', fast2.handled && fast2.data.facts[0].value === '4' && /You have 4 customers/.test(fast2.data.text));
  const listRecipe = findExactRecipe(ov.recipes, Q_LIST);
  const fastList = await runRecipeFastPath({ withTenant, ctxArg: ctxA, recipe: listRecipe, question: Q_LIST, today: TODAY });
  check('fast replay: a list recipe returns every row with the true total', fastList.handled && fastList.data.facts.length === 2 && /^2 customers/.test(fastList.data.text) && fastList.data.facts.every((f) => f.entityId), JSON.stringify(fastList.data ?? fastList).slice(0, 300));
  // Tampered recipe SQL is rejected by the guard, and the caller falls back
  for (const [name, sql] of Object.entries({ 'real table': 'SELECT count(*) AS n FROM tenants', 'tenant hop': "SELECT set_config('app.tenant_id', 'x', true) AS n", 'DML': 'DELETE FROM entities', 'multi-statement': 'SELECT 1 AS n; SELECT 2' })) {
    const bad = await runRecipeFastPath({ withTenant, ctxArg: ctxA, recipe: { ...recipe, sqls: [sql] }, question: Q_COUNT, today: TODAY });
    check(`fast replay: a tampered recipe (${name}) is rejected by sqlGuard -> not handled (falls back to the agent)`, !bad.handled && bad.reason === 'query-failed', JSON.stringify(bad));
  }
  const drift = await runRecipeFastPath({ withTenant, ctxArg: ctxA, recipe: { ...recipe, sqls: ['SELECT count(*) AS total FROM customers'] }, question: Q_COUNT, today: TODAY });
  check('fast replay: a result whose columns differ from the recipe falls back', !drift.handled && drift.reason === 'shape-changed');
  const stillThere = (await lite.query('SELECT count(*)::int AS n FROM entities WHERE tenant_id = $1', [tenA])).rows[0].n;
  check('fast replay: none of the tampered attempts changed any data', stillThere === 8, String(stillThere));

  // Same recipe, other shop: its own rows, never shop A's
  const asB = await runRecipeFastPath({ withTenant, ctxArg: ctxB, recipe, question: Q_COUNT, today: TODAY });
  check('cross-tenant: shop B replaying the shared recipe gets B\'s own count (5), never A\'s', asB.handled && asB.data.facts[0].value === '5' && !JSON.stringify(asB.data).includes('Karen'), JSON.stringify(asB.data ?? asB));
}

/* ================================================================== 5. unapproved recipes are never used */
{
  const Q_PENDING = 'which customers have a trane unit';
  const model = brain({ [Q_PENDING]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'trane owners', sql: "SELECT c.customer_id, c.name, e.model FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE lower(e.manufacturer) = 'trane' ORDER BY c.name" })]
    : [tu('answer', { status: 'answered', text: '1 customer has a Trane unit.', facts: lastResult(req.messages).rows.map((r) => ({ label: r[1], value: r[2], entityId: r[0] })) })] });
  const s = await replayMisses({ ctxArg: ctxA, questions: [Q_PENDING], confirm: false, callModel: model, today: TODAY });
  const props = await store.findRecipes(R.normalizeRecipeQuestion(Q_PENDING));
  check('policy: one grounded run (no confirmation) leaves the recipe PENDING', s.answeredNow === 1 && props.length === 1 && props[0].status === 'pending' && props[0].evidence.seen === 1, JSON.stringify(props.map((p) => [p.status, p.evidence])));
  const ov = await getActiveOverlay();
  check('policy: a pending recipe is not in the overlay, so it can never be injected or replayed', !ov.recipes.some((r) => r.question === R.normalizeRecipeQuestion(Q_PENDING)) && R.findExactRecipe(ov.recipes, Q_PENDING) === null);
  const spyText = [];
  await runDonovanAgent({ withTenant, ctxArg: ctxA, question: 'which customers have a trane unit in mesa', today: TODAY, overlay: ov, callModel: async (req) => { spyText.push(req.messages[0].content[0].text); return { content: [tu('answer', { status: 'cannot_answer', text: 'x' })], usage: { input_tokens: 10, output_tokens: 1 }, stop_reason: 'tool_use' }; } });
  check('policy: a similar question does not see the pending recipe as a worked example', !/WORKED EXAMPLES/.test(spyText[0]) || !spyText[0].includes("lower(e.manufacturer) = 'trane'"));
  // a second observation with the same signature activates it (a) ...
  const again = await replayMisses({ ctxArg: ctxA, questions: [Q_PENDING], confirm: false, callModel: model, today: TODAY });
  const after = await store.findRecipes(R.normalizeRecipeQuestion(Q_PENDING));
  check('policy (a): the same question with the same result signature a second time activates the recipe', again.answeredNow === 1 && after[0].status === 'auto_approved' && (await getActiveOverlay()).recipes.some((r) => r.question === R.normalizeRecipeQuestion(Q_PENDING)));

  // DONOVAN_AUTO_LEARN=off: nothing activates automatically
  process.env.DONOVAN_AUTO_LEARN = 'off';
  const Q_OFF = 'which customers have a goodman unit';
  const offModel = brain({ [Q_OFF]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'goodman owners', sql: "SELECT c.customer_id, c.name, e.model FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE lower(e.manufacturer) = 'goodman' ORDER BY c.name" })]
    : [tu('answer', { status: 'answered', text: '1 customer has a Goodman unit.', facts: lastResult(req.messages).rows.map((r) => ({ label: r[1], value: r[2], entityId: r[0] })) })] });
  await replayMisses({ ctxArg: ctxA, questions: [Q_OFF], confirm: true, callModel: offModel, today: TODAY });
  const offProps = await store.findRecipes(R.normalizeRecipeQuestion(Q_OFF));
  check('policy: DONOVAN_AUTO_LEARN=off keeps even a twice-confirmed recipe pending', offProps.length === 1 && offProps[0].status === 'pending' && offProps[0].evidence.seen === 2, JSON.stringify(offProps.map((p) => [p.status, p.evidence])));
  delete process.env.DONOVAN_AUTO_LEARN;
}

/* ================================================================== 6. privacy: literals, single-record, money -> no recipe */
{
  const Q_NAME = 'customers named karen with an email';
  const model = brain({ [Q_NAME]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'karen', sql: "SELECT customer_id, name FROM customers WHERE name ILIKE '%karen%'" })]
    : [tu('answer', { status: 'answered', text: '1 customer is named Karen.', facts: lastResult(req.messages).rows.map((r) => ({ label: r[1], value: 'Karen', entityId: r[0] })) })] });
  const s = await replayMisses({ ctxArg: ctxA, questions: [Q_NAME], callModel: model, today: TODAY });
  check('privacy: a grounded answer whose SQL filters on a customer name still answers, but creates NO recipe', s.answeredNow === 1 && (await store.findRecipes(R.normalizeRecipeQuestion(Q_NAME))).length === 0, JSON.stringify(s.items));
  const Q_ADDR = 'what is the model at 412 elm st';
  const m2 = brain({ [Q_ADDR]: (i, req) => i === 0 ? [tu('run_query', { purpose: 'unit', sql: "SELECT e.equipment_id, e.model FROM equipment e WHERE e.address ILIKE '%412 Elm%'" })] : [tu('answer', { status: 'answered', text: 'It is an XR14.', facts: lastResult(req.messages).rows.map((r) => ({ label: 'Model', value: r[1], entityId: r[0] })) })] });
  const s2 = await replayMisses({ ctxArg: ctxA, questions: [Q_ADDR], callModel: m2, today: TODAY });
  check('privacy: a single-record (address) question answers but never becomes a recipe', s2.answeredNow === 1 && (await store.findRecipes(R.normalizeRecipeQuestion(Q_ADDR))).length === 0);
}

/* ================================================================== 7. isolation, budgets */
{
  const rowsB = await replayStore.listReplays(ctxB, [normalizeQuestion(Q_COUNT).normalized]);
  check('isolation: shop A\'s replays are invisible to shop B (RLS on ask_miss_replays)', rowsB.size === 0);
  const asA = await replayStore.listReplays(ctxA, [normalizeQuestion(Q_COUNT).normalized]);
  check('isolation: ...and visible to shop A', asA.size === 1);
  const raw = (await lite.query('SELECT tenant_id FROM ask_miss_replays')).rows.map((r) => r.tenant_id);
  check('isolation: every replay row belongs to shop A (B\'s miss was never replayed)', raw.length > 0 && raw.every((t) => t === tenA));

  // budget refusal: tenant C has a 1-call daily budget and has spent it
  await lite.query(`UPDATE tenants SET limits = '{"maxModelCallsPerDay": 1}'::jsonb WHERE id = $1`, [tenC]);
  await lite.query('SELECT * FROM increment_usage_counters($1, $2::date, 0, 1, 10, 10)', [tenC, new Date().toISOString().slice(0, 10)]);
  await missRow(ctxC, Q_LIFE);
  const never = brain();
  const s = await replayMisses({ ctxArg: ctxC, callModel: never, today: TODAY });
  check('budget: a shop over its daily model budget is refused - no model call, no outcome recorded, run stops with model-budget', s.stopped === 'model-budget' && never.seen.length === 0 && s.attempted === 0 && (await replayStore.listReplays(ctxC, [normalizeQuestion(Q_LIFE).normalized])).size === 0, JSON.stringify(s));

  // cost ceiling
  const Q1 = 'how many customers have a phone number';
  const Q2 = 'how many customers have a fax number';
  const cheap = brain({ [Q1]: () => [tu('answer', { status: 'cannot_answer', text: 'x' })], [Q2]: () => [tu('answer', { status: 'cannot_answer', text: 'x' })] });
  const s2 = await replayMisses({ ctxArg: ctxA, questions: [Q1, Q2], maxCostUsd: 0.0001, callModel: cheap, today: TODAY });
  check('cost ceiling: a per-run ceiling stops the run and reports what is left', s2.stopped === 'cost-ceiling' && s2.remaining >= 1 && s2.attempted <= 1, JSON.stringify(s2));
  const s3 = await replayMisses({ ctxArg: ctxA, questions: Array.from({ length: 20 }, (_, i) => `how many customers have thing number ${i}`), maxCostUsd: 0, callModel: cheap, today: TODAY });
  check('cap: at most 15 misses per run, the rest reported as remaining', s3.attempted + s3.remaining === 15 || s3.stopped === 'cost-ceiling', JSON.stringify({ a: s3.attempted, r: s3.remaining, s: s3.stopped }));
  process.env.DONOVAN_AGENT = '0';
  const off = await replayMisses({ ctxArg: ctxA, questions: [Q1], callModel: noModel, today: TODAY });
  check('DONOVAN_AGENT=0: replay does nothing', off.stopped === 'agent-disabled' && off.attempted === 0);
  delete process.env.DONOVAN_AGENT;
}

/* ================================================================== 8. feedback: thumbs */
{
  const Q_UP = 'how many customers have no email on file';
  const upModel = brain({ [Q_UP]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'no email', sql: "SELECT count(*) AS n FROM customers WHERE email IS NULL OR email = ''" })]
    : [tu('answer', { status: 'answered', text: `${lastResult(req.messages).rows[0][0]} customers have no email on file.`, facts: [{ label: 'Customers without email', value: String(lastResult(req.messages).rows[0][0]) }] })] });
  await replayMisses({ ctxArg: ctxA, questions: [Q_UP], confirm: false, callModel: upModel, today: TODAY });
  const key = R.normalizeRecipeQuestion(Q_UP);
  eq('thumbs: a recipe with one grounded run is pending', (await store.findRecipes(key))[0].status, 'pending');
  const up = await applyThumbsUp({ ctxArg: ctxA, question: Q_UP, isOperator: false, decidedBy: 'user' });
  check('thumbs-up (normal user) counts as the second confirmation -> recipe approved and live', up.status === 'auto_approved' && (await getActiveOverlay()).recipes.some((r) => r.question === key), JSON.stringify(up));
  const none = await applyThumbsUp({ ctxArg: ctxA, question: 'a question with no recipe at all', isOperator: true, decidedBy: 'op' });
  eq('thumbs-up on an answer that taught no recipe is a no-op', none.status, 'no-recipe');

  const Q_OP = 'how many customers have a maintenance agreement';
  const opModel = brain({ [Q_OP]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'agreements', sql: "SELECT count(DISTINCT customer_id) AS n FROM doc_links dl WHERE EXISTS (SELECT 1 FROM documents_v d WHERE d.document_id = dl.document_id AND d.document_type = 'maintenance-agreement')" })]
    : [tu('answer', { status: 'answered', text: `${lastResult(req.messages).rows[0][0]} customers have a maintenance agreement.`, facts: [{ label: 'Customers', value: String(lastResult(req.messages).rows[0][0]) }] })] });
  // documents_v is empty so the count is 0: a zero result is not a reusable recipe query -> use a list instead
  void opModel;

  // thumbs-down: correction miss, live recipe retired, replay with the user's note as a hint
  const hints = [];
  const downModel = brain({ [Q_UP]: (i, req) => { hints.push(req.messages[0].content[0].text); return i === 0 ? [tu('run_query', { purpose: 'no email', sql: "SELECT count(*) AS n FROM customers WHERE email IS NULL OR email = ''" })] : [tu('answer', { status: 'answered', text: `${lastResult(req.messages).rows[0][0]} customers have no email on file.`, facts: [{ label: 'Customers without email', value: String(lastResult(req.messages).rows[0][0]) }] })]; } });
  const down = await applyThumbsDown({ ctxArg: ctxA, question: Q_UP, note: 'you forgot the customers with a blank email', callModel: downModel, today: TODAY });
  check('thumbs-down: the live recipe for that question is retired (a wrong shortcut stops being replayed)', down.retired === true && !(await getActiveOverlay()).recipes.some((r) => r.question === key));
  check('thumbs-down: a correction miss is recorded', (await lite.query("SELECT 1 FROM ask_misses WHERE tenant_id = $1 AND outcome = 'user-marked-wrong'", [tenA])).rows.length === 1);
  check('thumbs-down: the question is re-run once with the note as a reviewer hint', hints.length >= 1 && /REVIEWER NOTE/.test(hints[0]) && /blank email/.test(hints[0]) && down.replay?.outcome === 'answered_now');
  const stored = (await replayStore.listReplays(ctxA, [missKey(Q_UP)])).get(missKey(Q_UP));
  check('thumbs-down: the replay outcome + the note are recorded for the Misses card', stored?.outcome === 'answered_now' && /blank email/.test(stored.note ?? ''), JSON.stringify(stored));
  check('thumbs-down: a hinted run never creates a recipe by itself', (await store.findRecipes(key)).every((p) => p.status !== 'pending' || p.evidence.seen === 1));
  const overBudget = await applyThumbsDown({ ctxArg: ctxC, question: 'how many vans do we own', note: '', callModel: noModel, today: TODAY });
  check('thumbs-down over the daily budget: correction still recorded, replay refused (no model call)', overBudget.budget === true && overBudget.replay === null);
}

/* ================================================================== 9. capability-gap approval does something */
{
  const Q_GAP = 'which customers have a rheem unit';
  const gapModel = brain({ [Q_GAP]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'rheem', sql: "SELECT c.customer_id, c.name, e.model FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE lower(e.manufacturer) = 'rheem'" })]
    : [tu('answer', { status: 'answered', text: 'x', facts: [{ label: 'n', value: '1' }] })] });
  const gapNone = brain({ [Q_GAP]: () => [tu('answer', { status: 'cannot_answer', text: 'x' })] });
  const fail = await replayCapabilityGap({ ctxArg: ctxA, proposal: { payload: { title: 'brand lists', example: Q_GAP, note: '' } }, decidedBy: 'op', callModel: gapNone, today: TODAY });
  check('capability gap: approving replays the example question and reports still-failing honestly', fail.replayed && fail.outcome === 'still_failing' && fail.reason);
  void gapModel;
  const Q_GAP2 = 'which customers have a carrier unit';
  const ok = brain({ [Q_GAP2]: (i, req) => i === 0
    ? [tu('run_query', { purpose: 'carrier', sql: "SELECT c.customer_id, c.name, e.model FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE lower(e.manufacturer) = 'carrier' ORDER BY c.name" })]
    : [tu('answer', { status: 'answered', text: '1 customer has a Carrier unit.', facts: lastResult(req.messages).rows.map((r) => ({ label: r[1], value: r[2], entityId: r[0] })) })] });
  const good = await replayCapabilityGap({ ctxArg: ctxA, proposal: { payload: { title: 'brand lists', example: Q_GAP2, note: '' } }, decidedBy: 'op', callModel: ok, today: TODAY });
  check('capability gap: an answered example is shown AND its recipe is created and activated (operator approval is the confirmation)', good.outcome === 'answered_now' && good.answer?.facts?.[0]?.label === 'Plaza Dental Group' && good.recipe === 'approved' && (await getActiveOverlay()).recipes.some((r) => r.question === R.normalizeRecipeQuestion(Q_GAP2)), JSON.stringify(good));
  const nx = await replayCapabilityGap({ ctxArg: ctxA, proposal: { payload: { title: 't', example: '' } }, decidedBy: 'op' });
  check('capability gap: a proposal with no example replays nothing', nx.replayed === false);
}

/* ================================================================== 10. the nightly sweep replays too */
{
  process.env.DEEPWELL_FOUNDER_TENANT_ID = ctxA.tenantKey;
  process.env.DONOVAN_LEARN_MAX_CALLS = '1';
  const Q_SWEEP = 'how many customers have an email address';
  await missRow(ctxA, Q_SWEEP);
  const sweep = await import('../api/_lib/learning/sweep.js');
  const model = brain({ [Q_SWEEP]: scripts[Q_COUNT] });
  const core = await sweep.runLearningCore({ ctxArg: ctxA, callModel: model }).catch((e) => ({ error: String(e?.message) }));
  check('sweep: runLearningCore includes a replay summary (runs even on a night with nothing new for the proposer)', core.replay && typeof core.replay === 'object', JSON.stringify(core).slice(0, 200));
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  delete process.env.DONOVAN_LEARN_MAX_CALLS;
}

/* ================================================================== 11. wiring (static) */
{
  const review = fs.readFileSync(path.join(ROOT, 'api', 'review.js'), 'utf8');
  const ask = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('review.js: learningReplay is an OPERATOR action and rate-limited', /OPERATOR_ACTIONS = new Set\([^)]*'learningReplay'/.test(review) && /INTEGRITY_RATE_LIMIT_ACTIONS = new Set\([^)]*'learningReplay'/.test(review));
  check('review.js: askFeedback is a normal-user action (not operator-gated), rate-limited, billing-gated for thumbs-down', /'askFeedback'/.test(review) && !/OPERATOR_ACTIONS = new Set\([^)]*'askFeedback'/.test(review) && /INTEGRITY_RATE_LIMIT_ACTIONS = new Set\([^)]*'askFeedback'/.test(review) && /askFeedback[\s\S]{0,200}rating === 'down'|rating === 'down'[\s\S]{0,300}assertActiveBilling/.test(review));
  check('ask.js: a recipe replay skips the allowance increment', /!result\.fastReplay && isCountableAskSource\("agent"\)/.test(ask));
  check('ask.js: enumeration / repair-history questions go to the agent before the retrieval model', /isAgentFirstQuestion\(question\) && \(await tryAgent\(/.test(ask));
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
  eq('exactly 12 files directly under api/', apiFiles, 12);
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'components', 'DonovanMissesCard.tsx'), 'utf8');
  check('UI: the Misses card shows "Answered now" / "Still failing" and a "Replay all now" button', /Answered now/.test(ui) && /Still failing/.test(ui) && /Replay all now/.test(ui));
  check('the replay path never logs question text', !/console\.(log|warn|error)\([^)]*question/.test(fs.readFileSync(path.join(ROOT, 'api', '_lib', 'learning', 'replay.js'), 'utf8')));
}

console.log = realLog; console.warn = realWarn; console.error = realError;
resetActiveOverlayCacheForTests();
resetCatalogueCacheForTests();
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`All ${passes} checks passed.`);
process.exit(0);
