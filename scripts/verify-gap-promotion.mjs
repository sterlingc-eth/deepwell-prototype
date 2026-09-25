/**
 * Checks for Donovan's Workstream A additions: the EXAM GATE (examGate.js), the GAP PROMOTER
 * (gapPromoter.js), and PARAMETRIC recipes/few-shots (recipes.js).
 *
 *   1. Pure: examGate.js's stratifiedSample/gateDecision/perCategoryCounts.
 *   2. Pure: gapPromoter.js's clustersWorthPromoting + synthesizeProposalForCluster (mocked model).
 *   3. Pure: recipes.js's buildParametricRecipe/matchParametricRecipe/matchParametricExamples — a
 *      parametric example matches a paraphrase with a DIFFERENT city.
 *   4. Database-backed (PGlite, mocked runScorecard — no network, no Anthropic key, no DATABASE_URL,
 *      same harness as scripts/verify-learning-loop.mjs):
 *        (a) cluster -> few_shot proposal -> gate improves -> promoted + a donovan_gap_promotions audit row.
 *        (b) a candidate that regresses ANY category is rejected even with DONOVAN_AUTO_LEARN=all.
 *        (c) [pure, see 3 above] a parametric example matches a paraphrase with a different city.
 *        (d) migration 34 not yet applied -> store.recordExamResult/insertGapPromotion degrade, no crash.
 *
 *   node scripts/verify-gap-promotion.mjs
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
delete process.env.DONOVAN_AUTO_LEARN;
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;

const realWarn = console.warn;
const realError = console.error;
console.warn = () => {};
console.error = () => {};

/* ================================================================== 1. examGate.js: pure */
const gate = await import('../api/_lib/learning/examGate.js');
{
  const qs = [
    { id: 'a1', category: 'cat1' }, { id: 'a2', category: 'cat1' }, { id: 'a3', category: 'cat1' },
    { id: 'b1', category: 'cat2' }, { id: 'b2', category: 'cat2' },
    { id: 'c1', category: 'cat3' },
  ];
  const sample = gate.stratifiedSample(qs, 4);
  check('stratifiedSample: at most `size`, round-robin across categories (never all of one category first)', sample.length === 4 && new Set(sample.map((q) => q.category)).size >= 3, JSON.stringify(sample.map((q) => q.id)));
  eq('stratifiedSample: no-op when the pool is already <= size', gate.stratifiedSample(qs, 100).map((q) => q.id), qs.map((q) => q.id));
  eq('stratifiedSample: empty in, empty out', gate.stratifiedSample([], 10), []);

  const before = { pageResults: [{ category: 'cat1', passed: true }, { category: 'cat1', passed: false }, { category: 'cat2', passed: true }, { category: 'cat2', passed: true }] };
  const improved = { pageResults: [{ category: 'cat1', passed: true }, { category: 'cat1', passed: true }, { category: 'cat2', passed: true }, { category: 'cat2', passed: true }] };
  const regressed = { pageResults: [{ category: 'cat1', passed: true }, { category: 'cat1', passed: false }, { category: 'cat2', passed: true }, { category: 'cat2', passed: false }] };
  const same = { pageResults: before.pageResults };
  const incomplete = { pageResults: before.pageResults.slice(0, 2) };

  const di = gate.gateDecision(before, improved);
  check('gateDecision: strictly better (3/4 -> 4/4) is ok and improved', di.ok === true && di.improved === true && di.regressions.length === 0, JSON.stringify(di));
  const dr = gate.gateDecision(before, regressed);
  check('gateDecision: a category that drops (cat2 2->1) is never ok, even though overall rate is unchanged', dr.ok === false && dr.regressions.some((r) => r.category === 'cat2'), JSON.stringify(dr));
  const ds = gate.gateDecision(before, same);
  check('gateDecision: identical before/after is ok (never blocked for merely not improving)', ds.ok === true, JSON.stringify(ds));
  const dinc = gate.gateDecision(before, incomplete);
  check('gateDecision: an incomplete "after" run (fewer questions answered than "before") is never ok', dinc.ok === false, JSON.stringify(dinc));

  eq('perCategoryCounts: skipped rows are excluded', gate.perCategoryCounts([{ category: 'x', passed: true }, { category: 'x', skipped: true }]), { x: { passed: 1, total: 1 } });
}

/* ================================================================== 2. gapPromoter.js: pure + mocked model */
const gp = await import('../api/_lib/learning/gapPromoter.js');
{
  const clusters = [
    { capability: 'content-count', count: 5, tenantCount: 3, examples: ['how many customers in phoenix have an email', 'how many customers in tucson have an email'] },
    { capability: 'content-count', count: 1, tenantCount: 1, examples: ['one-off question'] }, // not enough evidence
    { capability: 'no-answer', count: 9, tenantCount: 5, examples: ['a', 'b'] }, // never actionable (needs a human, not a guess)
    { capability: 'other', count: 9, tenantCount: 5, examples: ['a', 'b'] }, // never actionable (uncategorized)
  ];
  const worth = gp.clustersWorthPromoting(clusters);
  eq('clustersWorthPromoting: only the well-evidenced, actionable cluster survives', worth.map((c) => c.capability), ['content-count']);

  const fewShotModel = async (capability, examples) => ({
    raw: { kind: 'few_shot', question: examples[0], plan: { entity: 'customers', op: 'count' } },
    usage: { inputTokens: 200, outputTokens: 60 },
  });
  const r1 = await gp.synthesizeProposalForCluster(worth[0], { callModel: fewShotModel });
  check('synthesizeProposalForCluster: a valid model proposal validates and verifies', r1.valid === true && r1.kind === 'few_shot' && r1.costUsd > 0, JSON.stringify(r1));

  const gapModel = async () => ({ raw: { kind: 'capability_gap', title: 't', example: 'e', note: 'n' }, usage: { inputTokens: 10, outputTokens: 10 } });
  const r2 = await gp.synthesizeProposalForCluster(worth[0], { callModel: gapModel });
  check('synthesizeProposalForCluster: the model finding no generalized fix (capability_gap) never becomes a proposal', r2.valid === false && /no generalized fix/.test(r2.reason), JSON.stringify(r2));

  const badPlanModel = async () => ({ raw: { kind: 'few_shot', question: worth[0].examples[0], plan: { entity: 'not-a-real-entity', op: 'count' } }, usage: { inputTokens: 10, outputTokens: 10 } });
  const r3 = await gp.synthesizeProposalForCluster(worth[0], { callModel: badPlanModel });
  check('synthesizeProposalForCluster: an invalid plan is rejected by the SAME validateProposal every other proposal uses', r3.valid === false, JSON.stringify(r3));

  const failModel = async () => ({ skipped: 'model-error', error: 'boom' });
  const r4 = await gp.synthesizeProposalForCluster(worth[0], { callModel: failModel });
  check('synthesizeProposalForCluster: a failed model call never throws', r4.valid === false && /skipped\/failed/.test(r4.reason));
}

/* ================================================================== 3. recipes.js: parametric (test c) */
const R = await import('../api/_lib/learning/recipes.js');
{
  const question = 'how many customers in mesa have an email on file';
  const sql = "SELECT count(*) AS n FROM customers WHERE city = 'Mesa' AND email IS NOT NULL";
  const param = R.buildParametricRecipe({ question, sql });
  check('buildParametricRecipe: a city literal that also appears in the question becomes parametric', Boolean(param) && param.paramType === 'city' && param.questionTemplate.includes('{city}') && param.sqlTemplate.includes("'{city}'"), JSON.stringify(param));

  const recipe = { question: R.normalizeRecipeQuestion(question), sqls: [sql], columns: ['n'], rowCount: 1, signature: 's', template: { mode: 'count', column: 'n', text: 'You have {n} customers with an email on file.', label: 'n' }, parametric: param };

  const paraphrase = 'how many customers in tucson have an email on file';
  const m = R.matchParametricRecipe(recipe, paraphrase);
  check('matchParametricRecipe: a paraphrase with a DIFFERENT (but known) city matches, extracting the new value', m?.value === 'tucson' && m.paramType === 'city', JSON.stringify(m));

  const resolved = R.matchParametricExamples(paraphrase, [recipe]);
  check('matchParametricExamples: returns a resolved, executable recipe with the new city substituted in — no model call needed', resolved?.sqls?.[0] === "SELECT count(*) AS n FROM customers WHERE city = 'Tucson' AND email IS NOT NULL", JSON.stringify(resolved));

  check('matchParametricExamples: a question that is not the same shape at all does not match', R.matchParametricExamples('what colour is the van', [recipe]) === null);
  check('matchParametricExamples: a value NOT in the closed vocabulary (not a known city) does not match', R.matchParametricExamples('how many customers in atlantis have an email on file', [recipe]) === null);
  check('findExactRecipe still requires the EXACT original question (parametric does not loosen it)', R.findExactRecipe([recipe], paraphrase) === null && Boolean(R.findExactRecipe([recipe], question)));

  // A recipe with more than one literal, or a literal outside the closed vocab, never becomes parametric.
  check('buildParametricRecipe: two literals -> never parametric (ambiguous which one is the parameter)', R.buildParametricRecipe({ question: 'x', sql: "SELECT 1 FROM t WHERE a = 'mesa' AND b = 'tucson'" }) === null);
  check('buildParametricRecipe: a literal not in ANY closed vocabulary -> never parametric', R.buildParametricRecipe({ question: 'customers named karen', sql: "SELECT 1 FROM t WHERE name = 'Karen'" }) === null);
  check('buildParametricRecipe: a literal not echoed in the question -> never parametric', R.buildParametricRecipe({ question: 'how many customers have an email', sql: "SELECT 1 FROM t WHERE city = 'Mesa'" }) === null);

  // Tampered SQL substitution is still caught by the guard/literal-safety gate before it is ever returned.
  const tampered = { ...recipe, parametric: { ...param, sqlTemplate: "DELETE FROM entities WHERE city = '{city}'" } };
  check('matchParametricExamples: a tampered sqlTemplate is rejected by sqlGuard (never returned)', R.matchParametricExamples(paraphrase, [tampered]) === null);
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
  console.warn = realWarn; console.error = realError;
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

async function buildLite(includeMigration34) {
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  const migrations = fs.readdirSync(cfgDir)
    .filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99') && (includeMigration34 || f !== '34-learning-exam-gate.sql'))
    .sort();
  const notes = {};
  for (const f of migrations) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
    catch (err) { notes[f] = String(err.message).slice(0, 200); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ordering note */ }
  return { lite, notes };
}

function installPgHarness(lite) {
  const pgMod = pgModRef;
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
}

const pgModRef = (await import('pg')).default;

// Modules imported ONCE (same idiom as scripts/verify-learning-loop.mjs): recordsStore.js's own `pool`
// is a single pg.Pool whose connect/query are prototype methods, so swapping WHICH PGlite database they
// talk to (installPgHarness, below, called again with a different `lite`) redirects every existing
// import at once — no per-block re-import needed, and each test block below uses its OWN tenant key so
// recordsStore.js's tenantContextCache never confuses one block's tenant with another's.
const { getTenantContext } = await import('../api/_lib/recordsStore.js');
const store = await import('../api/_lib/learning/store.js');
const examGate = await import('../api/_lib/learning/examGate.js');
const gapPromoter = await import('../api/_lib/learning/gapPromoter.js');
const { getActiveOverlay, resetActiveOverlayCacheForTests } = await import('../api/_lib/learning/overlay.js');

/* ---------- (a): migration 34 applied — cluster -> few_shot -> gate improves -> promoted + audit row ---------- */
{
  const { lite, notes } = await buildLite(true);
  check('migration 34 applies cleanly on top of 26/29/32', !notes['34-learning-exam-gate.sql'], JSON.stringify(notes));
  installPgHarness(lite);

  const ctx = { tenantKey: 'org_gate_a', tenantName: 'Gate Shop' };
  await getTenantContext(ctx.tenantKey, ctx.tenantName);

  const cluster = {
    capability: 'content-count', count: 5, tenantCount: 3,
    examples: ['how many customers in phoenix have an email on file', 'how many customers in tucson have an email on file', 'how many customers in mesa have an email on file'],
  };
  const model = async (capability, examples) => ({ raw: { kind: 'few_shot', question: examples[0], plan: { entity: 'customers', op: 'count' } }, usage: { inputTokens: 150, outputTokens: 50 } });
  const promo = await gapPromoter.proposeFixesForClusters([cluster], { callModel: model });
  check('(a) gap-promoter: the cluster is proposed as a pending few_shot proposal', promo.proposed === 1 && promo.proposals[0].valid, JSON.stringify(promo));
  const pendingBefore = await store.listProposals({ status: 'pending' });
  check('(a) the proposal is stored PENDING (never decided by the promoter itself)', pendingBefore.some((p) => p.id === promo.proposals[0].id && p.status === 'pending'));

  const improvingStub = (() => {
    let call = 0;
    return async () => {
      call++;
      const passed = call === 1
        ? [{ category: 'lookups', passed: true }, { category: 'lookups', passed: false }, { category: 'counts-geo', passed: true }]
        : [{ category: 'lookups', passed: true }, { category: 'lookups', passed: true }, { category: 'counts-geo', passed: true }];
      return { runId: `stub-${call}`, pageResults: passed, spentUsd: 0.001, done: true, nextOffset: null };
    };
  })();
  process.env.DONOVAN_AUTO_LEARN = 'vocab';
  const gated = await examGate.promotePendingWithExamGate(ctx, { cap: 1, sampleSize: 4, handler: async () => ({}), runScorecard: improvingStub });
  check('(a) exam gate: an improving candidate is promoted (auto_approved), NOT left pending, even under \'vocab\'', gated.attempted === 1 && gated.promoted === 1 && gated.rejected === 0, JSON.stringify(gated));

  const afterDecision = await store.getProposal(promo.proposals[0].id);
  check('(a) the proposal row now carries its exam before/after result (migration 34 columns)', afterDecision.status === 'auto_approved' && afterDecision.exam_before && afterDecision.exam_after && Number(afterDecision.exam_sample) === 4, JSON.stringify({ status: afterDecision.status, before: afterDecision.exam_before, after: afterDecision.exam_after, sample: afterDecision.exam_sample }));

  const ov = await getActiveOverlay();
  check('(a) the promoted few_shot is live in the active overlay (learning_decide still fires as before)', ov.fewShot.some((f) => f.question === cluster.examples[0]), JSON.stringify(ov.fewShot));

  const promotions = await store.listGapPromotions(ctx);
  check('(a) a donovan_gap_promotions audit row was written for this tenant', promotions.length === 1 && promotions[0].proposal_id === promo.proposals[0].id && promotions[0].kind === 'few_shot', JSON.stringify(promotions));

  resetActiveOverlayCacheForTests();
  delete process.env.DONOVAN_AUTO_LEARN;
}

/* ---------- (b): a regressing candidate is rejected even under DONOVAN_AUTO_LEARN=all ---------- */
{
  const { lite } = await buildLite(true);
  installPgHarness(lite);

  const ctx = { tenantKey: 'org_gate_b', tenantName: 'Gate Shop B' };
  await getTenantContext(ctx.tenantKey, ctx.tenantName);

  const id = await store.insertProposal({
    kind: 'synonym', payload: { entity: 'equipment', word: 'condenser-unit' },
    evidence: { source: 'test' }, verification: { ok: true }, status: 'pending',
  });
  check('(b) setup: a pending synonym proposal is stored', Boolean(id));

  const regressingStub = (() => {
    let call = 0;
    return async () => {
      call++;
      const passed = call === 1
        ? [{ category: 'lookups', passed: true }, { category: 'lookups', passed: true }, { category: 'counts-geo', passed: true }]
        : [{ category: 'lookups', passed: true }, { category: 'lookups', passed: false }, { category: 'counts-geo', passed: true }];
      return { runId: `stub-${call}`, pageResults: passed, spentUsd: 0.001, done: true, nextOffset: null };
    };
  })();
  process.env.DONOVAN_AUTO_LEARN = 'all';
  const gated = await examGate.promotePendingWithExamGate(ctx, { cap: 1, sampleSize: 4, handler: async () => ({}), runScorecard: regressingStub });
  check('(b) exam gate: a regressing candidate is rejected even with DONOVAN_AUTO_LEARN=all', gated.attempted === 1 && gated.rejected === 1 && gated.promoted === 0, JSON.stringify(gated));

  const row = await store.getProposal(id);
  check('(b) the proposal stays PENDING (a gate rejection is not a final verdict)', row.status === 'pending');
  const ov = await getActiveOverlay();
  check('(b) nothing was written to the active overlay for the rejected candidate', !(ov.synonyms.equipment ?? []).includes('condenser-unit'));

  process.env.DONOVAN_AUTO_LEARN = 'off';
  const offRun = await examGate.promotePendingWithExamGate(ctx, { cap: 5 });
  check('(b) DONOVAN_AUTO_LEARN=off: the gate does not even attempt a candidate', offRun.skipped === 'auto-learn-off' && offRun.attempted === 0, JSON.stringify(offRun));
  delete process.env.DONOVAN_AUTO_LEARN;
  resetActiveOverlayCacheForTests();
}

/* ---------- (d): migration 34 NOT applied -> no crash, graceful degrade ---------- */
{
  const { lite, notes } = await buildLite(false);
  void notes;
  installPgHarness(lite);

  const ctx = { tenantKey: 'org_gate_d', tenantName: 'Gate Shop D' };
  await getTenantContext(ctx.tenantKey, ctx.tenantName);

  const id = await store.insertProposal({ kind: 'synonym', payload: { entity: 'equipment', word: 'condensing-unit' }, evidence: {}, verification: { ok: true }, status: 'pending' });
  check('(d) setup: donovan_proposals itself still works without migration 34', Boolean(id));

  let threw = false;
  let ok;
  try { ok = await store.recordExamResult(id, { examBefore: { rate: 1 }, examAfter: { rate: 1 }, examSample: 4, examRunId: 'x' }); }
  catch { threw = true; }
  check('(d) recordExamResult never throws when migration 34 is missing, and reports failure honestly', !threw && ok === false);

  let threw2 = false;
  let ok2;
  try { ok2 = await store.insertGapPromotion(ctx, { proposalId: id, kind: 'synonym', examBefore: {}, examAfter: {}, examSample: 4 }); }
  catch { threw2 = true; }
  check('(d) insertGapPromotion never throws when migration 34 is missing (donovan_gap_promotions absent)', !threw2 && ok2 === false);

  const list = await store.listGapPromotions(ctx);
  eq('(d) listGapPromotions degrades to an empty array, never throws', list, []);

  // The gate's own decision-making must still complete a run (promote/reject) even though the audit
  // trail cannot be written — the exam result is simply not persisted.
  const stub = async () => ({ runId: 'x', pageResults: [{ category: 'c', passed: true }], spentUsd: 0, done: true, nextOffset: null });
  let gated;
  let threw3 = false;
  try { gated = await examGate.promotePendingWithExamGate(ctx, { cap: 1, sampleSize: 4, handler: async () => ({}), runScorecard: stub }); }
  catch { threw3 = true; }
  check('(d) promotePendingWithExamGate completes normally (no crash) even though migration 34 is missing', !threw3 && gated && gated.attempted === 1, JSON.stringify(gated));
}

console.warn = realWarn; console.error = realError;
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`All ${passes} checks passed.`);
process.exit(0);
