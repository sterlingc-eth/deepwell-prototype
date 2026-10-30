// Unit tests for the wrong-answer safety net. Stub provider, stub database: no paid call, no network. Run: node scripts/verify-safetynet.mjs
import assert from 'node:assert/strict';
import * as F from '../api/_lib/safetynet/flags.js';
import { parseVerdict, verifyAnswer, buildVerifierPrompt, groundedCorrection } from '../api/_lib/safetynet/verifier.js';
import { buildCase, toMissTeachRow, stageFromWhy } from '../api/_lib/safetynet/cases.js';
import { summarize } from '../api/_lib/safetynet/store.js';
import { afterAloneAnswer, recordReport, recordHandoffCase, costMicro } from '../api/_lib/safetynet/hook.js';

let pass = 0; const t = async (name, fn) => { await fn(); pass++; console.log('ok  ' + name); };
const on = { DONOVAN_AUDIT: '1' };

await t('flags default OFF and clamp', () => {
  assert.equal(F.auditOn({}), false); assert.equal(F.casesOn({}), false); assert.equal(F.correctOn({}), false);
  assert.equal(F.auditRate({}), 0.05); assert.equal(F.auditRate({ DONOVAN_AUDIT_RATE: '7' }), 1); assert.equal(F.auditRate({ DONOVAN_AUDIT_RATE: 'x' }), 0.05);
  assert.equal(F.optedIn('a', {}), false); assert.equal(F.optedIn('a', { DONOVAN_LEARNING_OPTIN_TENANTS: 'b, a' }), true);
});
await t('sampling: off never audits; rate; lowest band always', () => {
  assert.equal(F.decideAudit({ score: 0.1, rand: () => 0, env: {} }).audit, false);
  assert.equal(F.decideAudit({ score: 0.95, rand: () => 0.5, env: on }).audit, false);
  assert.equal(F.decideAudit({ score: 0.95, rand: () => 0.04, env: on }).audit, true);
  const low = F.decideAudit({ score: 0.7, rand: () => 0.99, env: on }); assert.equal(low.audit, true); assert.equal(low.forced, true);
  assert.equal(F.decideAudit({ rand: () => 0.99, env: on }).forced, false);
  let n = 0; for (let i = 0; i < 20000; i++) if (F.decideAudit({ score: 0.95, env: { ...on, DONOVAN_AUDIT_RATE: '0.05' } }).audit) n++;
  assert.ok(n > 800 && n < 1200, `rate ~5% got ${n}`);
});
await t('verdict parsing is tolerant and never invents a disagreement', () => {
  assert.equal(parseVerdict('{"verdict":"agree","why":"other","correct":""}').verdict, 'agree');
  assert.equal(parseVerdict('sure! {"verdict":"disagree","why":"wrong_value","correct":"$410"} ok').verdict, 'disagree');
  assert.equal(parseVerdict('garbage').verdict, 'unsure'); assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, 'unsure'); assert.equal(parseVerdict('{bad json}').verdict, 'unsure');
});
await t('verifier sees only question, answer, cited pages; correction must be verbatim', async () => {
  const pages = [{ page: 2, text: 'Total due $410.00 on 2026-01-04' }];
  let seen; const provider = async ({ user }) => { seen = user; return { text: '{"verdict":"disagree","why":"wrong_value","correct":"$410.00"}', usage: { inputTokens: 900, outputTokens: 40 } }; };
  const v = await verifyAnswer({ question: 'total due?', answerText: 'Total: $140.00', pages, provider });
  assert.equal(v.verdict, 'disagree'); assert.equal(v.correct, '$410.00'); assert.match(seen, /total due\?/); assert.match(seen, /--- page 2 ---/);
  assert.equal(groundedCorrection('$999', pages), '');
  const bad = await verifyAnswer({ question: 'q', answerText: 'a', pages, provider: async () => { throw new Error('boom'); } }); assert.equal(bad.verdict, 'unsure');
  assert.equal((await verifyAnswer({ question: 'q', answerText: 'a', pages: [], provider })).verdict, 'unsure');
});

// ---- hook flow with a stub database
function stubDb({ used = 0, noTable = false } = {}) {
  const log = [];
  const db = { log, async raw(sql, p) {
    log.push({ sql, p });
    if (/SAVEPOINT/.test(sql)) return { rows: [] };
    if (noTable && /donovan_/.test(sql)) throw new Error('relation does not exist');
    if (/count\(\*\)::int AS n FROM donovan_audits/.test(sql)) return { rows: [{ n: used }] };
    if (/INSERT INTO donovan_audits/.test(sql)) return { rows: [{ id: 1 }] };
    if (/INSERT INTO donovan_learning_cases/.test(sql)) return { rows: [{ id: 9 }] };
    return { rows: [] };
  } };
  return db;
}
const data = { kind: 'answer', text: 'Total: $140.00 (page 2 of Invoice A)', sources: [{ documentId: 'd1', location: { page: 2 } }], valueReader: true };
const mk = (db, verdict, extra = {}) => ({ withTenant: async (_c, fn) => fn(db), assertModelBudget: async () => {}, recordModelCall: async () => {}, loadPages: async () => [{ page: 2, text: 'Total due $410.00' }],
  provider: async () => ({ text: JSON.stringify({ verdict, why: 'wrong_value', correct: '$410.00' }), usage: { inputTokens: 1500, outputTokens: 50 } }), rand: () => 0, ...extra });
const run = async (env, db, d, args = {}) => { const keep = { ...process.env }; Object.assign(process.env, env); try { return await afterAloneAnswer({ tenantKey: 'ten1' }, { question: 'total due?', data, lane: 'valuereader', score: 0.95, ...args }, d); } finally { for (const k of Object.keys(env)) { if (k in keep) process.env[k] = keep[k]; else delete process.env[k]; } } };

await t('switch off: no database call at all', async () => { const db = stubDb(); const r = await run({}, db, mk(db, 'agree')); assert.equal(r.skipped, 'not-sampled'); assert.equal(db.log.length, 0); });
await t('agree is logged, no case, no note', async () => { const db = stubDb(); const r = await run({ ...on, DONOVAN_LEARNING_CASES: '1' }, db, mk(db, 'agree')); assert.equal(r.verdict, 'agree'); assert.equal(db.log.filter((l) => /learning_cases/.test(l.sql)).length, 0); });
await t('disagree writes audit + learning case (opt-in controls export)', async () => {
  const db = stubDb(); const r = await run({ ...on, DONOVAN_LEARNING_CASES: '1', DONOVAN_LEARNING_OPTIN_TENANTS: 'ten1' }, db, mk(db, 'disagree'));
  assert.equal(r.verdict, 'disagree'); assert.equal(r.stage, 'extract/ocr');
  const c = db.log.find((l) => /INSERT INTO donovan_learning_cases/.test(l.sql)); assert.equal(c.p[0], 'audit_disagree'); assert.equal(c.p[5], '$410.00'); assert.equal(c.p[7], true);
  const db2 = stubDb(); await run({ ...on, DONOVAN_LEARNING_CASES: '1' }, db2, mk(db2, 'disagree')); assert.equal(db2.log.find((l) => /INSERT INTO donovan_learning_cases/.test(l.sql)).p[7], false);
});
await t('correction note only with DONOVAN_AUDIT_CORRECT=1, grounded, and no cost leaks', async () => {
  const db = stubDb(); await run(on, db, mk(db, 'disagree')); assert.equal(db.log.find((l) => /INSERT INTO donovan_audits/.test(l.sql)).p[11], false);
  const db2 = stubDb(); await run({ ...on, DONOVAN_AUDIT_CORRECT: '1' }, db2, mk(db2, 'disagree')); const a = db2.log.find((l) => /INSERT INTO donovan_audits/.test(l.sql));
  assert.equal(a.p[11], true); assert.match(a.p[6], /\$410\.00/); assert.doesNotMatch(a.p[6], /cost|\$0\.|token/i);
});
await t('daily cap, missing table and model budget all skip without a model call', async () => {
  let calls = 0; const prov = async () => { calls++; return { text: '{"verdict":"agree"}' }; };
  let db = stubDb({ used: 100 }); assert.equal((await run(on, db, mk(db, 'agree', { provider: prov }))).skipped, 'daily-cap');
  db = stubDb({ noTable: true }); assert.equal((await run(on, db, mk(db, 'agree', { provider: prov }))).skipped, 'no-table');
  db = stubDb(); assert.equal((await run(on, db, mk(db, 'agree', { provider: prov, assertModelBudget: async () => { throw new Error('x'); } }))).skipped, 'model-budget');
  assert.equal(calls, 0);
  db = stubDb({ used: 3 }); assert.equal((await run({ ...on, DONOVAN_AUDIT_DAILY_MAX: '3' }, db, mk(db, 'agree', { provider: prov }))).skipped, 'daily-cap');
});
await t('lowest confidence band is always audited, still bounded by the cap', async () => {
  const db = stubDb(); const r = await run(on, db, mk(db, 'agree', { rand: () => 0.99 }), { score: 0.6 }); assert.equal(r.forced, true); assert.equal(r.verdict, 'agree');
});
await t('report + handoff cases are off by default and write when on', async () => {
  const db = stubDb(); const w = { withTenant: async (_c, fn) => fn(db) };
  assert.equal((await recordReport({ tenantKey: 't' }, { question: 'q', report: { answerText: 'a', sources: [{ documentId: 'd', page: 1 }] } }, w)).skipped, 'off');
  process.env.DONOVAN_LEARNING_CASES = '1';
  try {
    assert.equal((await recordReport({ tenantKey: 't' }, { question: 'q', report: { answerText: 'a', lane: 'valuereader', sources: [{ documentId: 'd', page: 1 }] } }, w)).id, 9);
    assert.equal((await recordHandoffCase({ tenantKey: 't' }, { question: 'q', data }, w)).id, 9);
    const ins = db.log.filter((l) => /INSERT INTO donovan_learning_cases/.test(l.sql)); assert.deepEqual(ins.map((l) => l.p[0]), ['customer_report', 'claude_handoff']);
    assert.equal(JSON.parse(ins[0].p[6])[0].page, 1);
  } finally { delete process.env.DONOVAN_LEARNING_CASES; }
});
await t('export row: opted-in only, masked, no ids or personal data', () => {
  const c = { id: 5, export_ok: true, source: 'customer_report', lane: 'valuereader', stage: 'unknown', question: 'what does Jane owe on invoice 4521?', given: 'Total $140.00, jane@x.com 555-123-4567', expected: null, doc_refs: [{ documentId: 'd1', page: 2 }] };
  const row = toMissTeachRow(c); const s = JSON.stringify(row);
  assert.doesNotMatch(s, /jane@|555-123|d1|4521|140/); assert.equal(row.n_docs, 1); assert.equal(row.source, 'customer_report');
  assert.equal(toMissTeachRow({ ...c, export_ok: false }), null); assert.equal(toMissTeachRow({ ...c, question: 'ssn 123-45-6789?' }), null);
});
await t('summary math: precision, disagreement rate, flag rate', () => {
  const s = summarize({ audits: [{ lane: 'valuereader', audited: 50, agree: 40, disagree: 4, unsure: 6, forced: 5, cost_micro_usd: 100000 }], cases: [{ source: 'customer_report', n: 6 }], aloneAnswers: 1000, days: 30 });
  assert.ok(Math.abs(s.disagreementRate - 4 / 44) < 1e-9); assert.ok(Math.abs(s.sampledPrecision - 40 / 44) < 1e-9); assert.equal(s.flagRate, 0.01); assert.equal(s.auditCostUsd, 0.1);
});
await t('cost model: ~2k tokens in, 60 out on haiku-class prices', () => { assert.equal(costMicro({ inputTokens: 2000, outputTokens: 60 }), 2300); });
await t('case builder + stage guess', () => { assert.equal(stageFromWhy('wrong_field'), 'label-match'); assert.equal(buildCase({ source: 'x', question: 'q', data }).source, 'flag'); assert.equal(buildCase({ source: 'customer_report', question: 'q', data }).lane, 'valuereader'); });
await t('valuereader answer carries score off the wire', async () => {
  const { answerFromPrepared, prepare } = await import('../api/_lib/valuereader/app.js');
  const lib = prepare([{ document_id: 'd1', page_no: 1, text: 'Invoice 100\nTotal Due: $410.00', original_filename: 'inv.pdf', display_name: 'Invoice' }]);
  const a = answerFromPrepared(lib, 'what is the total due on invoice 100');
  if (!a) { console.log('    (reader abstained on this toy page; wire check skipped)'); return; }
  assert.equal(typeof a._audit, 'object'); assert.equal(JSON.stringify(a).includes('_audit'), false);
});
console.log(`\n${pass} checks passed`);
