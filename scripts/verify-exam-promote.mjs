/**
 * Checks for "misses -> permanent exam" (Round 17, G3; R16 D3 research item 3): a resolved
 * production miss can be turned into a permanent, structurally re-checkable exam question, and
 * scripts/offline-exam.mjs's nightly loop merges a tenant's own promoted set only when grading THAT
 * tenant's own export.
 *
 * No network, no Anthropic key, no DATABASE_URL: pure-function checks for the builder, plus a REAL
 * Postgres (PGlite, via offline-exam.mjs's own harness — the same one every offline-exam run uses)
 * for the DB store, RLS tenant isolation, and re-running the built oracle against seeded data.
 *
 *   node scripts/verify-exam-promote.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

/* ================================================================== 1. pure: the builder */

const EP = await import('../api/_lib/learning/examPromote.js');
const { validQuestions } = await import('../api/_lib/scorecard/exam.js');

{
  check('guessShape: a street address reads as address-lookup', EP.guessShape('whats the model on the unit at 100 e main st') === 'address-lookup');
  check('guessShape: "how many" reads as count', EP.guessShape('how many customers have an email on file') === 'count');
  check('guessShape: a serial-number question with no address reads as unit-field-lookup', EP.guessShape('what is the serial number for that unit') === 'unit-field-lookup');
  check('guessShape: an address takes priority over an incidental "serial" mention', EP.guessShape('serial number for the unit at 322 n greenfield rd') === 'address-lookup');
  check('guessShape: nothing recognizable falls back to generic', EP.guessShape('what do you know about this shop') === 'generic');

  const idA1 = EP.promotedQuestionId('acme-hvac', 'model at 100 e main st');
  const idA2 = EP.promotedQuestionId('acme-hvac', 'model at 100 e main st');
  const idB = EP.promotedQuestionId('other-shop', 'model at 100 e main st');
  check('promotedQuestionId is deterministic for the same (tenant, question)', idA1 === idA2, `${idA1} vs ${idA2}`);
  check('promotedQuestionId differs across tenants for the same question (never shared cross-tenant)', idA1 !== idB);
  check('promotedQuestionId is a valid exam id (schema: a plain string)', typeof idA1 === 'string' && idA1.startsWith('promoted-') && idA1.length <= 60, idA1);

  const singleFieldAnswer = {
    kind: 'answer', text: "It's a RAP12345.",
    facts: [{ label: 'Model', value: 'RAP12345', entityId: 'aaaaaaaa-0000-4000-8000-000000000001', sources: [{ documentId: 'bbbbbbbb-0000-4000-8000-000000000001', location: { field: 'model' } }] }],
  };
  const built = EP.buildStructuralOracle(singleFieldAnswer);
  check('buildStructuralOracle: a single cited field-lookup fact builds a value oracle', built?.cmp === 'value' && built.oracleKind === 'structural-extraction' && built.citationRequired === true, JSON.stringify(built));
  check('buildStructuralOracle: the oracle SQL scopes by BOTH the cited document and entity', built.oracle.params[0] === 'bbbbbbbb-0000-4000-8000-000000000001' && built.oracle.params[1] === 'model' && built.oracle.params[2] === 'aaaaaaaa-0000-4000-8000-000000000001', JSON.stringify(built.oracle));
  check('buildStructuralOracle: carries a requires-guard scoped to the same document+field', built.oracle.requires?.sql?.includes('extractions') && built.oracle.requires.params.length === 2);

  const noEntityAnswer = { kind: 'answer', text: 'x', facts: [{ label: 'Model', value: 'RAP12345', sources: [{ documentId: 'bbbbbbbb-0000-4000-8000-000000000001', location: { field: 'model' } }] }] };
  const builtNoEntity = EP.buildStructuralOracle(noEntityAnswer);
  check('buildStructuralOracle: no entityId still builds (document+field alone is enough)', builtNoEntity?.oracle?.params?.length === 2);

  check('buildStructuralOracle: a multi-fact answer (a list) refuses (no single re-checkable cell)', EP.buildStructuralOracle({ kind: 'answer', facts: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }] }) === null);
  check('buildStructuralOracle: a fact with no citation refuses (nothing to re-derive from)', EP.buildStructuralOracle({ kind: 'answer', facts: [{ label: 'a', value: '1' }] }) === null);
  check('buildStructuralOracle: no answer at all refuses', EP.buildStructuralOracle(null) === null);

  const litValue = EP.buildOperatorLiteralOracle('Trane', 'value');
  check('buildOperatorLiteralOracle(value): wraps the literal as a constant-SQL oracle', litValue?.oracleKind === 'operator-literal' && litValue.oracle.params[0] === 'Trane');
  const litNumber = EP.buildOperatorLiteralOracle('7', 'number');
  check('buildOperatorLiteralOracle(number): parses a numeric literal', litNumber?.cmp === 'number' && litNumber.oracle.params[0] === 7);
  check('buildOperatorLiteralOracle(number): a non-numeric literal refuses (never a silent 0)', EP.buildOperatorLiteralOracle('not a number', 'number') === null);
  check('buildOperatorLiteralOracle: an empty literal refuses', EP.buildOperatorLiteralOracle('   ', 'value') === null);

  const noAnswerNoLiteral = EP.promoteMissToExamCandidate({ question: 'what model is at 100 e main st', questionNormalized: 'model at 100 e main st', tenantKey: 'acme-hvac' });
  check('promoteMissToExamCandidate: no answer and no operator literal refuses, never invents a value', noAnswerNoLiteral.ok === false && /replay it first|supply/.test(noAnswerNoLiteral.reason), JSON.stringify(noAnswerNoLiteral));

  const unstructurable = EP.promoteMissToExamCandidate({
    question: 'who all has current warranties', questionNormalized: 'who all has current warranties',
    answer: { kind: 'answer', facts: [{ label: 'Karen', value: 'XR14' }, { label: 'Bill', value: 'GSX' }] }, tenantKey: 'acme-hvac',
  });
  check('promoteMissToExamCandidate: an answer that cannot be structurally re-checked refuses without a literal', unstructurable.ok === false && /operator|supply/.test(unstructurable.reason), JSON.stringify(unstructurable));

  const withLiteral = EP.promoteMissToExamCandidate({
    question: 'who all has current warranties', questionNormalized: 'who all has current warranties',
    tenantKey: 'acme-hvac', operatorLiteral: '2', operatorCmp: 'number',
  });
  check('promoteMissToExamCandidate: an operator-supplied literal promotes even with no structural answer (the documented exception)', withLiteral.ok === true && withLiteral.oracleKind === 'operator-literal' && withLiteral.question.cmp === 'number', JSON.stringify(withLiteral));

  const structuralCandidate = EP.promoteMissToExamCandidate({
    question: 'whats the model on the unit at 100 e main st', questionNormalized: 'model at 100 e main st',
    outcome: 'answered_now', answer: singleFieldAnswer, tenantKey: 'acme-hvac',
  });
  check('promoteMissToExamCandidate: a structural candidate is ok and self-validates against the exam schema', structuralCandidate.ok === true && validQuestions([structuralCandidate.question]).length === 1, JSON.stringify(structuralCandidate));
  check('promoteMissToExamCandidate: the id is tenant-scoped and stable', structuralCandidate.question.id === EP.promotedQuestionId('acme-hvac', 'model at 100 e main st'));
  check('promoteMissToExamCandidate: category comes from the SAME classifier gapReport.js uses (reused, not reinvented)', typeof structuralCandidate.question.category === 'string' && structuralCandidate.question.category.length > 0);

  const exportShape = EP.buildPromotedExport('acme-hvac', [structuralCandidate.question]);
  check('buildPromotedExport: same {version, category, questions} shape generalization files use, plus tenantKey', exportShape.tenantKey === 'acme-hvac' && exportShape.category === 'promoted' && exportShape.questions.length === 1);
}

/* ================================================================== 2. offline-exam.mjs loader (tenant-scoped merge) */

const offline = await import('./offline-exam.mjs');
const { installPgHarness, createPGlite, setActiveDatabase, loadFullExam, loadPromotedCategoryQuestions } = offline;

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promoted-fixture-'));
  try {
    const qFor = (tenantKey, n) => ({ id: `promoted-${tenantKey}-fixture-${n}`, text: `fixture question ${n}`, category: 'promoted', shape: 'generic', cmp: 'value', oracle: { sql: 'SELECT $1::text AS v', params: ['x'] } });
    fs.writeFileSync(path.join(tmp, 'tenant-a.json'), JSON.stringify({ version: 'test', tenantKey: 'tenant-a', category: 'promoted', questions: [qFor('tenant-a', 1), qFor('tenant-a', 2)] }));
    fs.writeFileSync(path.join(tmp, 'tenant-b.json'), JSON.stringify({ version: 'test', tenantKey: 'tenant-b', category: 'promoted', questions: [qFor('tenant-b', 1)] }));
    fs.writeFileSync(path.join(tmp, 'no-tenant-key.json'), JSON.stringify({ version: 'test', category: 'promoted', questions: [qFor('unscoped', 1)] }));
    fs.writeFileSync(path.join(tmp, 'not-json.json'), '{ not valid json');

    const forA = await loadPromotedCategoryQuestions(new Set(), 'tenant-a', tmp);
    check('loadPromotedCategoryQuestions: merges only the matching tenant\'s file', forA.length === 2 && forA.every((q) => q.id.startsWith('promoted-tenant-a-')), JSON.stringify(forA.map((q) => q.id)));

    const forC = await loadPromotedCategoryQuestions(new Set(), 'tenant-c-has-no-file', tmp);
    check('loadPromotedCategoryQuestions: a tenant with no promoted file merges nothing (no crash)', forC.length === 0);

    const forNull = await loadPromotedCategoryQuestions(new Set(), null, tmp);
    check('loadPromotedCategoryQuestions: no tenantKey given merges nothing at all (every file skipped, not just unmatched ones)', forNull.length === 0);

    const dup = await loadPromotedCategoryQuestions(new Set(['promoted-tenant-a-fixture-1']), 'tenant-a', tmp);
    check('loadPromotedCategoryQuestions: an id already used elsewhere in the exam is dropped, not duplicated', dup.length === 1 && dup[0].id === 'promoted-tenant-a-fixture-2', JSON.stringify(dup.map((q) => q.id)));

    check('loadPromotedCategoryQuestions: malformed JSON is skipped, never throws', true); // the calls above already ran past not-json.json without throwing
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Sanity against the REAL (checked-in) directory: it holds no *.json fixtures (only its own
  // README), so loadFullExam must behave exactly as it did before this round for every existing
  // caller (verify-golden.mjs/verify-field-phrasing.mjs call it with no tenantKey at all).
  const base = await loadFullExam();
  const withUnmatchedTenant = await loadFullExam('some-tenant-with-nothing-promoted-yet');
  check('loadFullExam: an unset tenantKey and one that matches nothing checked in yield the same question count', base.questions.length === withUnmatchedTenant.questions.length, `${base.questions.length} vs ${withUnmatchedTenant.questions.length}`);
  check('loadFullExam: still returns exam.json\'s own questions (this feature never shrinks the base exam)', base.questions.length > 0);
}

/* ================================================================== 3. PGlite: store, RLS isolation, oracle re-check */

await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);

const migrationOk = fs.existsSync(path.join(ROOT, 'M3-config', '56-donovan-promoted-tests.sql'));
check('migration 56 (donovan_promoted_tests) file exists and is loaded by the standard harness', migrationOk);

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { runOracle } = await import('../api/_lib/scorecard/oracle.js');

const ctxA = { tenantKey: 'org_exam_a', tenantName: 'Shop A' };
const ctxB = { tenantKey: 'org_exam_b', tenantName: 'Shop B' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
await getTenantContext(ctxB.tenantKey, ctxB.tenantName); // registers shop B's tenant row; only ctxA's data is seeded below

{
  // Table proof, same shape the migration's own header proof queries use.
  const { rows: relRows } = await lite.query(
    `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'donovan_promoted_tests'`
  );
  check('donovan_promoted_tests: RLS enabled and forced', relRows[0]?.rls === true && relRows[0]?.force === true, JSON.stringify(relRows));
  const { rows: polRows } = await lite.query(`SELECT polname FROM pg_policy WHERE polrelid = 'donovan_promoted_tests'::regclass`);
  check('donovan_promoted_tests: the tenant-isolation policy is present', polRows.some((r) => r.polname === 'tenants_isolate_donovan_promoted_tests'), JSON.stringify(polRows));
}

const DOC_ID = 'cccccccc-0000-4000-8000-000000000001';
const EQUIP_ID = 'dddddddd-0000-4000-8000-000000000001';
await lite.query(
  `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,'wo-1.pdf','work-order','sha-exam-promote-1','verified')`,
  [DOC_ID, tenA]
);
await lite.query(
  `INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'equipment',$3::jsonb)`,
  [EQUIP_ID, tenA, JSON.stringify({ model: 'RAP12345', manufacturer: 'Trane' })]
);
await lite.query(
  `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,'model','RAP12345',0.92)`,
  [tenA, DOC_ID, EQUIP_ID]
);

const liveAnswer = {
  kind: 'answer', text: "It's a RAP12345.",
  facts: [{ label: 'Model', value: 'RAP12345', entityId: EQUIP_ID, sources: [{ documentId: DOC_ID, location: { field: 'model' } }] }],
};
const candidate = EP.promoteMissToExamCandidate({
  question: 'whats the model on the unit at 100 e main st', questionNormalized: 'model at 100 e main st',
  outcome: 'answered_now', answer: liveAnswer, tenantKey: ctxA.tenantKey,
});
check('promoteMissToExamCandidate: builds a structural candidate from the seeded answer', candidate.ok === true, JSON.stringify(candidate));

{
  const oracleResult = await runOracle(withTenant, ctxA, candidate.question, { today: '2026-09-26' });
  check('the built oracle RE-RUNS against the tenant\'s own data and recovers the cited value', oracleResult.ok === true && Array.isArray(oracleResult.expected) && oracleResult.expected.includes('RAP12345'), JSON.stringify(oracleResult));
}

{
  // A drifted/stale promoted test (the cited row no longer exists — a re-extraction changed its
  // field_key, say) SKIPS via its own requires-guard rather than failing outright.
  const stale = EP.promoteMissToExamCandidate({
    question: 'whats the model on the unit at 200 e other st', questionNormalized: 'model at 200 e other st',
    outcome: 'answered_now',
    answer: { kind: 'answer', text: 'x', facts: [{ label: 'Model', value: 'XYZ', sources: [{ documentId: 'eeeeeeee-0000-4000-8000-000000000099', location: { field: 'model' } }] }] },
    tenantKey: ctxA.tenantKey,
  });
  check('promoteMissToExamCandidate: builds even for a citation that will not resolve (caller decides whether to keep it)', stale.ok === true);
  const staleResult = await runOracle(withTenant, ctxA, stale.question, { today: '2026-09-26' });
  check('a promoted test whose cited row no longer exists SKIPS at grading time (its own requires-guard), never a false wrong', staleResult.ok === true && staleResult.skip === true, JSON.stringify(staleResult));
}

{
  const row = await EP.insertPromotedTest(ctxA, {
    examId: candidate.question.id, questionNormalized: 'model at 100 e main st', question: candidate.question.text,
    category: candidate.question.category, shape: candidate.question.shape, cmp: candidate.question.cmp,
    oracle: candidate.question.oracle, citationRequired: true, oracleKind: candidate.oracleKind, sourceOutcome: 'answered_now', createdBy: 'test-operator',
  });
  check('insertPromotedTest: writes and returns the stored exam id', row?.examId === candidate.question.id, JSON.stringify(row));

  const listedA = await EP.listPromotedTests(ctxA);
  check('listPromotedTests: the promoting tenant sees its own row', listedA.length === 1 && listedA[0].exam_id === candidate.question.id, JSON.stringify(listedA));

  const listedB = await EP.listPromotedTests(ctxB);
  check('TENANT ISOLATION: a different tenant sees none of shop A\'s promoted tests (RLS)', listedB.length === 0, JSON.stringify(listedB));

  const again = await EP.insertPromotedTest(ctxA, {
    examId: candidate.question.id, questionNormalized: 'model at 100 e main st', question: candidate.question.text,
    category: candidate.question.category, shape: candidate.question.shape, cmp: candidate.question.cmp,
    oracle: candidate.question.oracle, citationRequired: true, oracleKind: candidate.oracleKind, sourceOutcome: 'answered_now', createdBy: 'test-operator',
  });
  const listedAfterReplay = await EP.listPromotedTests(ctxA);
  check('re-promoting the same question is an UPSERT, never a duplicate row (idempotent)', Boolean(again) && listedAfterReplay.length === 1, JSON.stringify(listedAfterReplay));

  const exported = EP.buildPromotedExport(ctxA.tenantKey, EP.rowsToQuestions(listedAfterReplay));
  check('rowsToQuestions/buildPromotedExport: round-trips to the same schema-valid question', exported.questions.length === 1 && validQuestions(exported.questions).length === 1, JSON.stringify(exported));

  // End-to-end: the offline-exam loader actually merges this tenant's (freshly exported) promoted
  // set when the export's own tenantKey matches, and not otherwise.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'promoted-e2e-'));
  try {
    fs.writeFileSync(path.join(tmp2, `${ctxA.tenantKey}.json`), JSON.stringify(exported));
    const merged = await loadPromotedCategoryQuestions(new Set(), ctxA.tenantKey, tmp2);
    check('END-TO-END: an exported promoted file merges back in for its own tenant', merged.length === 1 && merged[0].id === candidate.question.id);
    const notMerged = await loadPromotedCategoryQuestions(new Set(), ctxB.tenantKey, tmp2);
    check('END-TO-END: the same file does NOT merge for a different tenant', notMerged.length === 0);
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
