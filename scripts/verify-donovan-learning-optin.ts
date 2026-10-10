/**
 * Donovan performance sharing is opt-in and redacted (owner ask 2026-10-10: no extra work for the client; DeepWell only
 * needs scores). Checks: nothing leaks question/answer text, sharing is OFF by default, only an opted-in tenant is
 * recorded, rows land only in the founder tenant, and the cross-tenant view is operator-only. Real Postgres (PGlite) with
 * the repo's migrations; no network, no Anthropic.
 *
 *   tsx scripts/verify-donovan-learning-optin.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder_dw';
const warn = console.warn; console.warn = () => {};

const P: any = await import('../api/_lib/learning/perfShare.js');
const { isPlatformOperator } = await import('../api/_lib/missDigest.js');

/* ---- 1. redaction (pure) */
const SECRET_Q = 'How much does Karen Abernathy at 412 Elm Street owe? karen@example.com 480-555-0148 serial GD-2002';
const m = P.sanitizeMetric({ question: SECRET_Q, outcome: 'declined', latencyMs: 812, costUsd: 0.0021, tenantHash: 'h:3f9a2c1e (len 11)', answer: 'She owes $412', name: 'Karen', docText: 'secret' });
const blob = JSON.stringify(m);
check('sanitizeMetric keeps only the enumerated fields', JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['costUsd', 'latencyMs', 'len', 'outcome', 'shape', 't']), blob);
for (const leak of ['Karen', 'Abernathy', '412', 'Elm', 'karen@', '555', 'GD-2002', 'owes', 'secret', 'Street']) {
  check(`no text leaks into the metric: "${leak}" absent`, !blob.toLowerCase().includes(leak.toLowerCase()), blob);
}
check('shape is one of the fixed labels', P.SHAPES.includes(m.shape), m.shape);
check('an unknown outcome is refused (returns null)', P.sanitizeMetric({ question: 'x', outcome: 'whatever' }) === null);
check('outcome mapping: model/agent -> ai_fallback; cache/records -> answered_from_records', P.outcomeForSource('agent') === 'ai_fallback' && P.outcomeForSource('analytics') === 'answered_from_records');
check('miss mapping: user-marked-wrong -> marked_wrong; no-answer -> declined; exam and outage rows are never shared',
  P.outcomeForMiss('user-marked-wrong') === 'marked_wrong' && P.outcomeForMiss('no-answer') === 'declined' && P.outcomeForMiss('scorecard-fail') === null && P.outcomeForMiss('provider-unavailable') === null);

/* ---- 2. database behavior */
const offline: any = await import('./offline-exam.mjs');
await offline.installPgHarness();
const lite = await offline.createPGlite();
await offline.setActiveDatabase(lite);
const { getTenantContext, withTenant } = await import('../api/_lib/recordsStore.js');
const { insertAskMiss } = await import('../api/_lib/missStore.js');

const founder = { tenantKey: 'org_founder_dw', tenantName: 'DeepWell' };
const A = { tenantKey: 'org_optin_a', tenantName: 'Shop A' };
const B = { tenantKey: 'org_optin_b', tenantName: 'Shop B' };
for (const c of [founder, A, B]) await getTenantContext(c.tenantKey, c.tenantName);
const countMetrics = async () => (await withTenant(founder, (db: any) => db.raw(`SELECT count(*)::int AS n FROM audit_log WHERE action = '${P.METRIC_ACTION}'`, []))).rows[0].n as number;
const settle = () => new Promise((r) => setTimeout(r, 150));

check('sharing is OFF by default', (await P.getSharing(A)) === false);
check('an opted-out tenant records nothing', (await P.shareScore(A, { question: SECRET_Q, outcome: 'declined' })) === false && (await countMetrics()) === 0);
await withTenant(A, (db: any) => insertAskMiss(db, { question: SECRET_Q, questionNormalized: SECRET_Q.toLowerCase(), outcome: 'no-answer' }));
await settle();
check('an opted-out tenant\'s miss records no score row', (await countMetrics()) === 0);

await P.setSharing(A, true, undefined);
check('after the admin switches it on, sharing is ON', (await P.getSharing(A)) === true);
check('opted-in: a score row is written', (await P.shareScore(A, { question: SECRET_Q, outcome: 'ai_fallback', latencyMs: 900, costUsd: 0.01 })) === true && (await countMetrics()) === 1);
await withTenant(A, (db: any) => insertAskMiss(db, { question: SECRET_Q, questionNormalized: SECRET_Q.toLowerCase(), outcome: 'no-answer' }));
await withTenant(A, (db: any) => insertAskMiss(db, { question: SECRET_Q, questionNormalized: 'x', outcome: 'scorecard-fail' }));
await settle();
check('opted-in: a miss adds one declined row; an exam-failure row adds none', (await countMetrics()) === 2);
await P.shareScore(A, { question: 'when does the warranty expire', outcome: 'answered_from_records', latencyMs: 40 });

const raw = (await lite.query(`SELECT changes, tenant_id FROM audit_log WHERE action = '${P.METRIC_ACTION}'`)).rows;
const dump = JSON.stringify(raw.map((r: any) => r.changes));
check('stored rows hold no question text, names or addresses', !/karen|abernathy|elm|412|example\.com|555|GD-2002|owe/i.test(dump), dump);
check('stored rows carry a hashed tenant, never the raw tenant key', !dump.includes('org_optin_a') && /"t":"[0-9a-f]{12}"/.test(dump), dump);
const founderId = (await getTenantContext(founder.tenantKey, founder.tenantName)).id;
check('score rows live only in the founder tenant', raw.every((r: any) => r.tenant_id === founderId));
const aRows = await withTenant(A, (db: any) => db.raw(`SELECT action FROM audit_log WHERE action LIKE 'donovan.%'`, []));
check('the customer tenant holds only its own setting row, no score rows', aRows.rows.every((r: any) => r.action === P.SETTING_ACTION));
check('tenant B (never opted in) is still off and records nothing', (await P.getSharing(B)) === false && (await P.shareScore(B, { question: 'q', outcome: 'declined' })) === false);

const scores = await P.loadScores({ days: 30 });
check('operator aggregate: totals, rates and shape breakdown', scores.total === 3 && scores.tenantsReporting === 1 && scores.tenantsOptedIn === 1 && scores.byOutcome.declined === 1 && scores.byOutcome.ai_fallback === 1 && scores.byOutcome.answered_from_records === 1 && scores.byShape.length >= 1, JSON.stringify(scores));
check('operator aggregate holds no free text', !/karen|abernathy|owe|warranty/i.test(JSON.stringify(scores)));

await P.setSharing(A, false, undefined);
P.resetPerfShareForTests();
const before = await countMetrics();
await P.shareScore(A, { question: 'x', outcome: 'declined' });
check('switching it off stops recording at once', (await P.getSharing(A)) === false && (await countMetrics()) === before);
const agg2 = await P.loadScores({});
check('opt-out is reflected in the opted-in count', agg2.tenantsOptedIn === 0, JSON.stringify(agg2.tenantsOptedIn));

/* ---- 3. operator-only gate + wiring (source scan, same idea as verify-privacy) */
const review = fs.readFileSync(path.join(ROOT, 'api/review.js'), 'utf8');
const opSet = /const OPERATOR_ACTIONS = new Set\(\[([^\]]*)\]/.exec(review)?.[1] ?? '';
check("review.js: 'donovanScores' is in OPERATOR_ACTIONS (403 for non-operators before anything runs)", opSet.includes("'donovanScores'"));
const caseBlock = (name: string) => { const i = review.indexOf(`case '${name}'`); return i < 0 ? '' : review.slice(i, i + 700); };
check("review.js: 'donovanScores' calls requireOperator in its case block", /requireOperator\(auth\)/.test(caseBlock('donovanScores')));
check("review.js: 'donovanSharing' is admin-only (requireAdmin) and NOT an operator action", /requireAdmin\(auth\)/.test(caseBlock('donovanSharing')) && !opSet.includes('donovanSharing'));
check("review.js: both new actions are registered", review.includes("'donovanSharing',") && review.includes("'donovanScores',"));
check("review.js: 'donovanScores' carries its SUPPORT-ACCESS-EXEMPT note (aggregate, no tenant content)", /SUPPORT-ACCESS-EXEMPT[^\n]*\n[^\n]*\n\s*case 'donovanScores'/.test(review));
check('isPlatformOperator: a normal tenant admin is not an operator; the founder admin is', !isPlatformOperator({ tenantId: 'org_optin_a', userId: 'u1', orgId: 'o', orgRole: 'admin' }) && isPlatformOperator({ tenantId: 'org_founder_dw', userId: 'u2' }));
check('api/ still has exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
check('no migration file was added for this feature', !fs.readdirSync(path.join(ROOT, 'M3-config')).some((f) => /perf|score-?shar|optin/i.test(f)));

/* ---- 4. customer UI carries no work */
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const shell = read('src/components/AppShell.tsx');
check('AppShell: Donovan button only renders for an operator', /isAdmin && isOperator && !billingGateActive/.test(shell) && /donovanOpen && isOperator/.test(shell));
check('AnswerFeedback has no text box (one tap, optional)', !/<input|<textarea|<form/.test(read('src/components/AnswerFeedback.tsx')));
check('MobileAnswer feedback has no text box (one tap, optional)', !/<input|<textarea|<form/.test(read('src/mobile/MobileAnswer.tsx').slice(read('src/mobile/MobileAnswer.tsx').indexOf('function Feedback'), read('src/mobile/MobileAnswer.tsx').indexOf("Donovan's answer, phone-sized"))));
check('the customer-facing sharing control says it is off by default and shares no content', /Off by default/.test(read('src/components/DonovanSharingCard.tsx')) && /Never your questions, answers, documents or names/.test(read('src/components/DonovanSharingCard.tsx')));

{
  const card = read('src/components/DonovanScoresCard.tsx');
  check('operator scores: answered/AI rates are hidden until answered rows exist, with a waiting note', card.includes('hasAnswered') && card.includes('Waiting for answered-question data'));
}

console.warn = warn;
console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed.` : `\nAll ${passes} checks passed.`);
process.exit(failures ? 1 : 0);
