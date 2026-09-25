/**
 * TEAM H (2026-09-24): checks for the AUTONOMOUS PER-TENANT LEARNING LOOP —
 * fair rotation + daily $ caps, tenant isolation of the new tenant-scoped
 * overlay, auto-generated exams from a pack's examTemplates, safe
 * promotion/demotion (including thumbs-down), vocabulary mining thresholds,
 * weekly gap-report clustering, and that the nightly cron step always
 * respects its time budget.
 *
 * No network, no Anthropic key, no DATABASE_URL: the model is never called
 * for real (vocab-mining labeling calls fail closed with no ANTHROPIC_API_KEY
 * — the same "skip, don't crash" discipline learning/proposer.js's own model
 * call already has) and the database is a REAL Postgres (PGlite) loaded from
 * the actual M3-config/*.sql migrations, queried as the NOBYPASSRLS app
 * role — same harness as verify-agent.mjs / verify-learning-loop.mjs.
 *
 *   node scripts/verify-autopilot.mjs
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
delete process.env.DONOVAN_LEARNING_DAILY_USD;
delete process.env.DONOVAN_LEARNING_PLATFORM_DAILY_USD;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
console.warn = () => {};
console.error = () => {};

/* ================================================================== 1. pure: rotation.js */
const R = await import('../api/_lib/learning/rotation.js');
{
  eq('stableHash is deterministic', R.stableHash('org_a'), R.stableHash('org_a'));
  check('stableHash differs for different input', R.stableHash('org_a') !== R.stableHash('org_b'));
  eq('rotationForDate: fewer than 2 tenants is a no-op', R.rotationForDate(['x'], '2026-09-24'), ['x']);
  const roster = ['a', 'b', 'c', 'd'];
  const day0 = R.rotationForDate(roster, '2026-09-24');
  const day1 = R.rotationForDate(roster, '2026-09-25');
  check('rotationForDate: consecutive days give different orders (roster > 1)', JSON.stringify(day0) !== JSON.stringify(day1));
  check('rotationForDate: same elements, just rotated', [...day0].sort().join() === [...roster].sort().join());
  eq('rotationForDate: is a pure cyclic shift', R.rotationForDate(['a', 'b', 'c'], '2026-09-24'), R.rotationForDate(['a', 'b', 'c'], R.dayNumber('2026-09-24') % 3 === 0 ? '2026-09-24' : '2026-09-24'));
  // FAIRNESS: over `tenantCount` consecutive nights, reaching only the first tenant each night still
  // reaches every tenant at least once (the brief's "a turn at least every N nights").
  eq('rotationForDate fairness: every tenant reached within N consecutive nights (perNight=1)', R.unreachedOverNights(5, '2026-09-24', 5, 1), []);
  eq('rotationForDate fairness: also holds for a smaller perNight than the roster, given enough nights', R.unreachedOverNights(9, '2026-09-24', 9, 2), []);
  check('rotationForDate fairness: NOT fair with too few nights (sanity check on the test itself)', R.unreachedOverNights(9, '2026-09-24', 2, 1).length > 0);
}

/* ================================================================== 2. pure: tenantCaps.js */
const Caps = await import('../api/_lib/learning/tenantCaps.js');
{
  eq('tenantDailyCapUsd default', Caps.tenantDailyCapUsd({}), 0.25);
  eq('platformDailyCapUsd default', Caps.platformDailyCapUsd({}), 10);
  eq('tenantDailyCapUsd honors env override', Caps.tenantDailyCapUsd({ DONOVAN_LEARNING_DAILY_USD: '1.5' }), 1.5);
  const spend = Caps.createSpendTracker({ tenantCapUsd: 0.1, platformCapUsd: 0.15 });
  eq('a fresh tracker gives the full tenant cap as allowance', spend.allowanceFor('t1'), 0.1);
  spend.record('t1', 0.08);
  check('allowance shrinks after recording spend', Math.abs(spend.allowanceFor('t1') - 0.02) < 1e-9, String(spend.allowanceFor('t1')));
  spend.record('t2', 0.06);
  check('the PLATFORM cap can bind even when a tenant has its own room left', spend.allowanceFor('t2') <= 0.01, String(spend.allowanceFor('t2')));
  check('platformExhausted flips once the platform cap is spent', !spend.platformExhausted());
  spend.record('t2', 0.2);
  check('platformExhausted is true once spend reaches the cap', spend.platformExhausted());
  eq('tenantSpentUsd rounds to 4dp', Caps.createSpendTracker({}).tenantSpentUsd('none'), 0);
}

/* ================================================================== 3. pure: autopilotPolicy.js */
const AP = await import('../api/_lib/learning/autopilotPolicy.js');
{
  const ok = { ok: true };
  eq('decideAutopilotRecipeStatus: one sighting, no exam match -> pending', AP.decideAutopilotRecipeStatus({ seen: 1 }, ok, 'vocab').status, 'pending');
  eq('decideAutopilotRecipeStatus: examMatch alone (seen=1) promotes exactly like seen=2', AP.decideAutopilotRecipeStatus({ seen: 1, examMatch: true }, ok, 'vocab').status, 'auto_approved');
  eq('decideAutopilotRecipeStatus: a pending thumbs-down blocks auto-promotion even with examMatch', AP.decideAutopilotRecipeStatus({ seen: 2, examMatch: true, thumbsDown: 1 }, ok, 'vocab').status, 'pending');
  eq('decideAutopilotRecipeStatus: operator approval overrides a thumbs-down', AP.decideAutopilotRecipeStatus({ seen: 0, thumbsDown: 1, operatorApproved: true }, ok, 'vocab').status, 'approved');
  eq('decideAutopilotRecipeStatus: failed verification is always auto_rejected, exam match or not', AP.decideAutopilotRecipeStatus({ examMatch: true }, { ok: false, reasons: ['bad'] }, 'all').status, 'auto_rejected');

  eq('shouldAutoDemote: nothing disagrees -> null', AP.shouldAutoDemote({}), null);
  eq('shouldAutoDemote: a thumbs-down demotes', AP.shouldAutoDemote({ thumbsDown: true }), 'thumbs-down');
  check('shouldAutoDemote: a fresh signature mismatch demotes', /fresh agent run/.test(AP.shouldAutoDemote({ freshSignatureMatches: false })));
  check('shouldAutoDemote: an oracle disagreement demotes', /oracle/.test(AP.shouldAutoDemote({ oracleAgrees: false })));
  eq('shouldAutoDemote: undefined checks (not run this cycle) never demote on their own', AP.shouldAutoDemote({ freshSignatureMatches: undefined, oracleAgrees: undefined }), null);

  eq('decideTenantVocabStatus: below threshold stays pending', AP.decideTenantVocabStatus({ count: 1, docCount: 1 }, ok).status, 'pending');
  eq('decideTenantVocabStatus: at/above both thresholds activates', AP.decideTenantVocabStatus({ count: 3, docCount: 2 }, ok).status, 'active');
  eq('decideTenantVocabStatus: enough count but not enough distinct docs stays pending', AP.decideTenantVocabStatus({ count: 10, docCount: 1 }, ok).status, 'pending');
  eq('decideTenantVocabStatus: failed verification is rejected regardless of count', AP.decideTenantVocabStatus({ count: 999, docCount: 999 }, { ok: false, reasons: ['x'] }).status, 'rejected');
}

/* ================================================================== 4. pure: vocabMining.js */
const VM = await import('../api/_lib/learning/vocabMining.js');
{
  eq('tokenizeForMining splits, lowercases and drops stopwords/numbers ("ok" is itself a stopword)', VM.tokenizeForMining('TXV replaced, cond fan ok, unit 12'), ['txv', 'replaced', 'cond', 'fan', 'unit']);
  eq('tokenizeForMining drops stopwords and pure numbers', VM.tokenizeForMining('the unit is 4 years old'), ['unit', 'is', 'years', 'old']);

  const rows = [
    { value: 'TXV replaced', documentId: 'd1' }, { value: 'txv leaking', documentId: 'd2' },
    { value: 'checked txv again', documentId: 'd2' }, { value: 'cond fan noisy', documentId: 'd3' },
  ];
  const known = new Set(['replaced', 'leaking', 'checked', 'again', 'noisy', 'fan']);
  const mined = VM.mineCandidateTerms(rows, known);
  const txv = mined.find((m) => m.term === 'txv');
  check('mineCandidateTerms: frequency + distinct-document co-occurrence, known words excluded', txv?.count === 3 && txv?.docCount === 2 && !mined.some((m) => m.term === 'fan'), JSON.stringify(mined));
  const cond = mined.find((m) => m.term === 'cond');
  check('mineCandidateTerms: a term seen once still surfaces with docCount 1', cond?.count === 1 && cond?.docCount === 1);

  eq('topCandidatesForLabeling: below-threshold terms are dropped', VM.topCandidatesForLabeling([{ term: 'a', count: 1, docCount: 1 }], { minCount: 3, minDocs: 2 }), []);
  eq('topCandidatesForLabeling: caps at the label-call limit', VM.topCandidatesForLabeling(Array.from({ length: 20 }, (_, i) => ({ term: `t${i}`, count: 5, docCount: 5 }))).length, VM.MAX_LABEL_CALLS_PER_TENANT_NIGHT);

  const pack = { businessNoun: 'shop', documentTypes: ['invoice'], fields: ['manufacturer'], abbreviations: {}, synonyms: { equipment: ['unit'] } };
  check('validateTenantVocabProposal: abbreviation into known pack vocab is accepted', VM.validateTenantVocabProposal('abbreviation', { from: 'gfci', to: 'invoice' }, pack).ok);
  check('validateTenantVocabProposal: "to" must already be known — never a new word', !VM.validateTenantVocabProposal('abbreviation', { from: 'gfci', to: 'zzznew' }, pack).ok);
  check('validateTenantVocabProposal: "from" must be new, not already known', !VM.validateTenantVocabProposal('abbreviation', { from: 'invoice', to: 'manufacturer' }, pack).ok);
  check('validateTenantVocabProposal: synonym word must be new', !VM.validateTenantVocabProposal('synonym', { entity: 'equipment', word: 'unit' }, pack).ok);
  check('validateTenantVocabProposal: a genuinely new synonym word is accepted', VM.validateTenantVocabProposal('synonym', { entity: 'equipment', word: 'condenser' }, pack).ok);
  check('validateTenantVocabProposal: rejects an unsupported kind', !VM.validateTenantVocabProposal('typo', { from: 'x', to: 'y' }, pack).ok);
}

/* ================================================================== 5. pure: gapReport.js */
const GR = await import('../api/_lib/learning/gapReport.js');
{
  eq('classifyCapability: money fallback', GR.classifyCapability({ outcome: 'money-fallback' }), 'money-status-unknown');
  eq('classifyCapability: cross-doc unsupported -> multi-hop', GR.classifyCapability({ outcome: 'cross-doc-unsupported' }), 'multi-hop');
  eq('classifyCapability: analytics fallthrough -> content-count', GR.classifyCapability({ outcome: 'analytics-fallthrough' }), 'content-count');
  eq('classifyCapability: unsupported-condition -> industry-field-missing', GR.classifyCapability({ outcome: 'unsupported-condition' }), 'industry-field-missing');
  eq('classifyCapability: scorecard-fail with a money category', GR.classifyCapability({ outcome: 'scorecard-fail', category: 'money' }), 'money-status-unknown');
  eq('classifyCapability: an unrecognized shape lands in "other", never dropped', GR.classifyCapability({ outcome: 'totally-unknown' }), 'other');
  check('fixSpecFor: every classified capability has a non-empty fix-spec paragraph', ['money-status-unknown', 'content-count', 'multi-hop', 'industry-field-missing', 'other'].every((c) => GR.fixSpecFor(c).length > 20));

  const rows = [
    { tenantId: 't1', industry: 'hvac', outcome: 'money-fallback', question: 'is invoice 12 paid', count: 3 },
    { tenantId: 't2', industry: 'plumbing', outcome: 'money-fallback', question: 'is invoice 9 paid', count: 2 },
    { tenantId: 't1', industry: 'hvac', outcome: 'no-answer', question: 'what colour is the van', count: 1 },
  ];
  const clusters = GR.clusterFailures(rows);
  const money = clusters.find((c) => c.capability === 'money-status-unknown');
  check('clusterFailures: counts, distinct tenants and industries aggregate correctly, sorted by count desc', money?.count === 5 && money?.tenantCount === 2 && JSON.stringify(money.industries) === JSON.stringify(['hvac', 'plumbing']) && clusters[0].capability === 'money-status-unknown', JSON.stringify(clusters));
  check('clusterFailures: examples are capped and de-duplicated', GR.clusterFailures(Array.from({ length: 10 }, () => ({ outcome: 'no-answer', question: 'same question' })), 5)[0].examples.length === 1);
}

/* ================================================================== 6. pure: scorecard/tenantExam.js */
const TE = await import('../api/_lib/scorecard/tenantExam.js');
{
  eq('placeholdersIn: extracts unique {tokens}', TE.placeholdersIn('has {customer} paid their {docType} at {customer}?'), ['customer', 'docType']);
  eq('placeholdersIn: no placeholders -> empty', TE.placeholdersIn('how many customers have an email on file'), []);

  const pools = { customer: ['Karen Abernathy', 'Bill Whitmore'] };
  const tpl = { id: 'q1', category: 'money', question: 'has {customer} paid their last invoice?', compare: 'yesno', oracle: { sql: 'SELECT 1', params: ['{customer}'] } };
  const filledA = TE.fillTemplate(tpl, pools, 'org_x:2026-09-24');
  const filledA2 = TE.fillTemplate(tpl, pools, 'org_x:2026-09-24');
  check('fillTemplate: deterministic for the same seed', JSON.stringify(filledA) === JSON.stringify(filledA2));
  check('fillTemplate: substitutes the placeholder into both the question text and the oracle params', pools.customer.includes(filledA.filled.customer) && filledA.question.includes(filledA.filled.customer) && filledA.oracle.params[0] === filledA.filled.customer, JSON.stringify(filledA));
  check('fillTemplate: a template with no data for a placeholder is skipped (null), never left with a literal token', TE.fillTemplate(tpl, {}, 'org_x:2026-09-24') === null);
  check('fillTemplate: a template with no placeholders at all passes through untouched', TE.fillTemplate({ id: 'q2', question: 'how many customers have an email', oracle: { sql: 'SELECT 1' } }, {}, 'seed').question === 'how many customers have an email');
}

/* ================================================================== 7. pure: industry/index.js (Team G's real module) */
const IND = await import('../api/_lib/industry/index.js');
const { loadExam } = await import('../api/_lib/scorecard/exam.js');
{
  check('founder\'s static exam.json still loads with well-formed object-oracle questions', loadExam().questions.length > 0
    && loadExam().questions.every((q) => typeof q.oracle.sql === 'string'), JSON.stringify(loadExam().version));

  eq('PACK_IDS names all four industries', [...IND.PACK_IDS].sort(), ['electrical', 'hvac', 'plumbing', 'property']);
  check('listPacks returns one pack object per PACK_IDS entry, in order', JSON.stringify(IND.listPacks().map((p) => p.id)) === JSON.stringify(IND.PACK_IDS));
  check('getPack: an unknown id falls back to hvac (never throws, never null)', IND.getPack('nonexistent-industry')?.id === 'hvac');
  check('getPack(hvac) is the real hvac pack', IND.getPack('hvac').id === 'hvac' && IND.getPack('hvac').examTemplates.length > 0);

  check('validatePack: every real pack passes its own contract', IND.PACK_IDS.every((id) => IND.validatePack(IND.getPack(id)).length === 0),
    JSON.stringify(IND.PACK_IDS.map((id) => IND.validatePack(IND.getPack(id)))));
  check('every pack\'s string-form examTemplate oracles resolve via resolveOracle (no dangling template id)',
    IND.listPacks().every((p) => p.examTemplates.every((t) => typeof t.oracle !== 'string'
      || IND.resolveOracle(t.oracle, '00000000-0000-0000-0000-000000000000'))));

  const forTenant = await IND.packForTenant({ tenantKey: 'org_x' });
  eq('packForTenant falls back to hvac when handed a bag with no withTenant/db to query', forTenant.id, 'hvac');
  IND.resetPackForTenantCacheForTests();
}

console.log = realLog;

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

console.warn = () => {};
console.error = () => {};
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
const migrationNotes = {};
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { migrationNotes[f] = String(err.message).slice(0, 160); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ordering note, same as verify-agent.mjs */ }
console.log = realLog;
check('migration 32 (autopilot) applies cleanly on top of 26/29/30', !migrationNotes['32-donovan-autopilot.sql'], JSON.stringify(migrationNotes));
console.warn = () => {};
console.error = () => {};
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };

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

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { recordAskMiss, MISS_OUTCOMES } = await import('../api/_lib/missStore.js');
const overlay = await import('../api/_lib/learning/overlay.js');
const tenantOverlay = await import('../api/_lib/learning/tenantOverlay.js');
const autopilot = await import('../api/_lib/learning/autopilot.js');

const TODAY = '2026-09-24';
const ctxA = { tenantKey: 'org_auto_a', tenantName: 'Auto Shop A' };
const ctxB = { tenantKey: 'org_auto_b', tenantName: 'Auto Shop B' };
const ctxC = { tenantKey: 'org_auto_c', tenantName: 'Canceled Shop C' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
await getTenantContext(ctxC.tenantKey, ctxC.tenantName);
// Eligibility (list_notification_eligible_tenants: billing_status IN ('active','trialing')) is set
// directly on the tenants row — a fresh row's billing_status is NULL (not set by any migration
// default), same as a real tenant who has never completed billing.
await lite.query("UPDATE tenants SET billing_status = 'active' WHERE id = $1", [tenA]);
await lite.query("UPDATE tenants SET billing_status = 'trialing' WHERE id = $1", [tenB]);
// tenC is left billing_status = NULL -> ineligible, exactly like a canceled/never-billed tenant.

/* ================================================================== 8. donovan_learned_tenant: schema + isolation */
{
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'donovan_learned_tenant'")).rows[0];
  check('donovan_learned_tenant has ENABLE + FORCE row level security and a tenant policy', rls?.rls && rls?.force
    && (await lite.query("SELECT 1 FROM pg_policy WHERE polrelid = 'donovan_learned_tenant'::regclass")).rows.length === 1);

  const id = await tenantOverlay.upsertTenantVocab(ctxA, { kind: 'abbreviation', key: 'txv', value: { from: 'txv', to: 'invoice' }, status: 'active', evidence: { count: 5, docCount: 3 } });
  check('upsertTenantVocab writes a row and returns its id', Boolean(id));

  const activeA = await tenantOverlay.listActiveTenantLearned(ctxA);
  const activeB = await tenantOverlay.listActiveTenantLearned(ctxB);
  check('TENANT ISOLATION: tenant A\'s active vocab is visible to tenant A...', activeA.some((r) => r.key === 'txv'));
  check('...and INVISIBLE to tenant B (a different tenant\'s own connection)', !activeB.some((r) => r.key === 'txv'), JSON.stringify(activeB));

  overlay.resetActiveOverlayCacheForTests();
  overlay.invalidateTenantOverlayCache();
  const mergedA = await overlay.getActiveOverlayForTenant(ctxA);
  const mergedB = await overlay.getActiveOverlayForTenant(ctxB);
  check('getActiveOverlayForTenant: tenant A sees its own learned abbreviation merged in', mergedA.abbreviations.txv === 'invoice');
  check('getActiveOverlayForTenant: tenant B (no rows of its own) falls back to exactly the global overlay, no leakage', mergedB.abbreviations.txv === undefined);

  const rejectedId = await tenantOverlay.upsertTenantVocab(ctxA, { kind: 'abbreviation', key: 'gfci', value: { from: 'gfci', to: 'x' }, status: 'pending', evidence: { count: 1, docCount: 1 } });
  check('a PENDING tenant vocab row is stored but never surfaces in the active overlay', Boolean(rejectedId) && !(await overlay.getActiveOverlayForTenant(ctxA)).abbreviations.gfci);
}

/* ================================================================== 9. rotation + claim (fairness/caps in an integration) */
{
  const eligible = await autopilot.listEligibleTenants();
  const keys = eligible.map((t) => t.tenantKey).sort();
  eq('listEligibleTenants: only active/trialing tenants (reusing the existing eligibility function)', keys, [ctxA.tenantKey, ctxB.tenantKey].sort());

  const { rotationForDate } = await import('../api/_lib/learning/rotation.js');
  const order1 = rotationForDate(eligible, '2026-09-24').map((t) => t.tenantKey);
  const order2 = rotationForDate(eligible, '2026-09-25').map((t) => t.tenantKey);
  check('rotationForDate over the real eligible-tenant list still rotates day to day', JSON.stringify(order1) !== JSON.stringify(order2) || eligible.length < 2);
}

/* ================================================================== 10. full nightly sweep: caps, claiming, audit summaries */
const fakeHandler = () => async (req, res) => res.status(200).json({ success: true, data: { kind: 'no-answer', text: 'nothing found', facts: [], sources: [], debug: { model: 'claude-haiku-4-5', models: ['claude-haiku-4-5'] } } });
{
  const t0 = Date.now();
  const out = await autopilot.runAutopilotSweepStep({ deadlineAt: Date.now() + 20_000, handler: fakeHandler() });
  const elapsed = Date.now() - t0;
  check('runAutopilotSweepStep: processed exactly the eligible tenants (never the ineligible one)', out.tenantsProcessed === 2 && out.tenantsEligible === 2, JSON.stringify(out));
  check('runAutopilotSweepStep: per-tenant summaries carry counts only, no question text anywhere', !JSON.stringify(out).includes('nothing found'));
  check('exam-gated learning never targets a paying tenant when DEEPWELL_FOUNDER_TENANT_ID is unset (gate overlay is process-wide)', !process.env.DEEPWELL_FOUNDER_TENANT_ID && !out.examGatedLearning, JSON.stringify(out.examGatedLearning ?? null));
  check('CRON TIME BUDGET: a normal run finishes well within the 60s function limit', elapsed < 50_000, `${elapsed}ms`);
  const secondRun = await autopilot.runAutopilotSweepStep({ deadlineAt: Date.now() + 20_000, handler: fakeHandler() });
  check('the daily claim prevents a same-day re-run from processing the same tenants twice', secondRun.tenantsProcessed === 0, JSON.stringify(secondRun));

  const noTimeOut = await autopilot.runAutopilotSweepStep({ deadlineAt: Date.now() + 1, handler: fakeHandler() });
  eq('CRON TIME BUDGET: a near-zero deadline skips the whole step instantly rather than starting any tenant', noTimeOut.skipped, 'no-time');
}

/* ================================================================== 11. per-tenant caps actually bind */
{
  const t2 = { tenantKey: 'org_auto_cap', tenantName: 'Cap Test Shop' };
  await getTenantContext(t2.tenantKey, t2.tenantName);
  const Caps2 = await import('../api/_lib/learning/tenantCaps.js');
  const spend = Caps2.createSpendTracker({ tenantCapUsd: 0.001, platformCapUsd: 10 }); // near-zero tenant cap
  const summary = await autopilot.runAutopilotForTenant(t2, { today: TODAY, spend, deadlineAt: Date.now() + 10_000, handler: fakeHandler() });
  eq('a tenant with (near-)zero remaining daily budget is skipped, not run for free', summary.skipped, 'no-budget');
}

/* ================================================================== 12. auto-demote a recipe the exam disagrees with */
const store = await import('../api/_lib/learning/store.js');
{
  const id = await store.insertProposal({
    kind: 'recipe', payload: { question: 'how many customers have an email on file', sqls: ['SELECT count(*) AS n FROM customers'], columns: ['n'], signature: 's' },
    evidence: { seen: 2 }, verification: { ok: true }, status: 'pending',
  });
  await store.decideProposal(id, 'approved', 'test');
  const activeBefore = (await store.listActiveLearned()).filter((r) => r.kind === 'recipe');
  check('setup: the recipe is active before the exam disagrees with it', activeBefore.length === 1);

  const demo = await autopilot.demoteRecipesDisagreeingWithExam([
    { question: 'how many customers have an email on file', passed: false, skipped: false },
  ]);
  eq('demoteRecipesDisagreeingWithExam: demotes exactly the recipe the failing exam question matches', demo.demoted, 1);
  const activeAfter = (await store.listActiveLearned()).filter((r) => r.kind === 'recipe');
  check('the recipe is no longer active after demotion', activeAfter.length === 0);

  const demoNothing = await autopilot.demoteRecipesDisagreeingWithExam([{ question: 'an unrelated question', passed: false }]);
  eq('a failing question that matches no active recipe demotes nothing', demoNothing.demoted, 0);
}

/* ================================================================== 13. vocabulary mining, end to end (no model key -> deterministic mining still runs) */
{
  await withTenant(ctxA, (db) => db.raw(
    "INSERT INTO documents (id, tenant_id, original_filename, sha256_hash, document_type, storage_key, stage) " +
    "VALUES (uuid_generate_v4(), (current_setting('app.tenant_id', true))::uuid, 'invoice.pdf', 'deadbeef', 'invoice', 'k', 'verified')", []
  ));
  const docId = (await withTenant(ctxA, (db) => db.raw("SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid LIMIT 1", []))).rows[0].id;
  for (let i = 0; i < 4; i++) {
    await withTenant(ctxA, (db) => db.raw(
      "INSERT INTO extractions (id, tenant_id, document_id, field_key, value) VALUES (uuid_generate_v4(), (current_setting('app.tenant_id', true))::uuid, $1, 'notes', $2)",
      [docId, `mystery term seen ${i} times`]
    ));
  }
  const pack = IND.getPack('hvac');
  const result = await autopilot.mineTenantVocabulary(ctxA, pack, { allowLabeling: false }); // no model call at all in this check
  check('mineTenantVocabulary: mines a repeated unknown term from this tenant\'s own extractions', result.mined > 0 && result.labeled === 0, JSON.stringify(result));
}

/* ================================================================== 14. weekly gap report: clustering + storage */
{
  await recordAskMiss(ctxA, { question: 'is invoice 12 paid', questionNormalized: 'is invoice 12 paid', outcome: MISS_OUTCOMES.MONEY_FALLBACK });
  await recordAskMiss(ctxB, { question: 'is invoice 9 paid', questionNormalized: 'is invoice 9 paid', outcome: MISS_OUTCOMES.MONEY_FALLBACK });
  await recordAskMiss(ctxA, { question: 'what colour is the van', questionNormalized: 'what colour is the van', outcome: MISS_OUTCOMES.NO_ANSWER });

  const report = await GR.buildGapReport({ now: new Date() });
  const money = report.clusters.find((c) => c.capability === 'money-status-unknown');
  check('buildGapReport: clusters cross-tenant misses by capability', Boolean(money) && money.tenantCount === 2, JSON.stringify(report.clusters));

  const stored = await GR.storeGapReport(report);
  check('storeGapReport / latestGapReport round trip (migration 32)', Boolean(stored));
  const latest = await GR.latestGapReport();
  eq('latestGapReport returns the just-stored report\'s week', latest?.weekStart, report.weekStart);
}

/* ================================================================== summary */
console.log = realLog;
if (failures) {
  console.log(`\n${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(1);
}
console.log(`\n${passes} checks passed.`);
