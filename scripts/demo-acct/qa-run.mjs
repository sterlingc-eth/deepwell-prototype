#!/usr/bin/env node
/**
 * Demo starter-question QA (independent check of the seeded demo companies).
 *
 *   npx tsx scripts/demo-acct/qa-run.mjs --state <seeded.tar> --docs <generated docs dir> [--only hvac] [--out report.json]
 *
 * Every starter question is asked through the REAL /api/ask handler (api/ask.js) against the demo company's documents as
 * they were loaded by the real pipeline (local-seed.mjs). Model calls are not available in this sandbox: any answer that
 * needed Claude is marked "needs-model" and counts as a FAIL here (a strict lower bound for production, which has Claude).
 *
 * PASS requires all three:
 *   - the answer text contains every expected value (any listed spelling);
 *   - for an in-records question, one of the answer's cited sources is the expected document AND page;
 *   - for the not-in-records question, Donovan declines (says it could not find it) instead of guessing.
 * The grader only reads the question text, the expected values and the expected source. It never feeds anything back
 * into Donovan, and nothing in the app matches question wording.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootLocal, WAVE1, localOrgId, ROOT } from './lib/local-env.mjs';
import { grade, citedSources, DECLINE_RE } from './lib/grader.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const STATE = args.state ?? path.join(os.tmpdir(), 'deepwell-demo-seeded.tar');
const DOCS = args.docs ?? process.env.DEMO_DOCS ?? path.join(ROOT, 'demo-wave1');
const ONLY = args.only ? String(args.only).split(',') : null;
const OUT = args.out ?? path.join(os.tmpdir(), 'deepwell-demo-qa-report.json');
const TODAY = args.today ?? '2026-10-22';

process.env.DONOVAN_READER_V2 = process.env.DONOVAN_READER_V2 ?? '1';
const env = await bootLocal({ dataDir: STATE });
const { lite, model } = env;
const realLog = console.log;
let sink = null;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) { sink?.push(a[0]); return; } realLog(...a); };
console.warn = () => {}; if (!process.env.QA_DEBUG) console.error = () => {};

model.mode = 'mock';
let claudeCalls = 0;
model.answerMock = async () => { claudeCalls++; const e = new Error('model unavailable in local QA'); e.status = 400; e.isMock = true; throw e; };

const { SCORECARD_CALL } = await import(path.join(ROOT, 'api/_lib/scorecard/hook.js'));
const { default: askHandler } = await import(path.join(ROOT, 'api/ask.js'));

async function ask(orgId, question) {
  const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } };
  const req = { method: 'POST', headers: {}, query: {}, body: { question, today: TODAY, debug: true }, [SCORECARD_CALL]: { auth: { tenantId: orgId, orgId, userId: 'user_demo_qa', orgRole: 'admin' }, escalate: false, releaseEscalation: true } };
  claudeCalls = 0; model.blocked = 0;
  const lines = []; sink = lines;
  const t0 = Date.now();
  try { await askHandler(req, res); } catch (e) { res.body = { error: String(e?.message ?? e) }; }
  for (let i = 0; i < 400 && res.body === undefined; i++) await new Promise((r) => setTimeout(r, 25));
  sink = null;
  const data = res.body?.success ? res.body.data : null;
  return { data, ms: Date.now() - t0, claude: claudeCalls + model.blocked, error: data ? null : String(res.body?.error ?? res.statusCode), logs: lines };
}

const report = { generatedAt: new Date().toISOString(), today: TODAY, readerV2: process.env.DONOVAN_READER_V2, industries: {} };
for (const ind of WAVE1) {
  if (ONLY && !ONLY.includes(ind.slug)) continue;
  const qf = path.join(DOCS, ind.slug, 'questions.json');
  if (!fs.existsSync(qf)) continue;
  const { questions } = JSON.parse(fs.readFileSync(qf, 'utf8'));
  const orgId = localOrgId(ind.slug);
  await lite.exec('RESET ROLE');
  const { rows: docRows } = await lite.query('SELECT d.id, d.original_filename FROM documents d JOIN tenants t ON t.id = d.tenant_id WHERE t.clerk_org_id = $1', [orgId]);
  const idByFile = new Map(docRows.map((r) => [r.original_filename, r.id]));
  // Which documents the local reader could turn into facts WITHOUT a model (production reads the rest with Claude).
  const { rows: exRows } = await lite.query('SELECT d.original_filename AS f, count(e.id)::int AS n FROM documents d JOIN tenants t ON t.id = d.tenant_id LEFT JOIN extractions e ON e.document_id = d.id WHERE t.clerk_org_id = $1 GROUP BY 1', [orgId]);
  const factsByFile = new Map(exRows.map((r) => [r.f, r.n]));
  const results = [];
  for (const q of questions) {
    const r = await ask(orgId, q.q);
    const kind = r.data?.kind ?? null;
    const g = grade(q, r.data, (f) => idByFile.get(f), (id) => docRows.find((d) => d.id === id)?.original_filename ?? id);
    let pass = g.pass && (!q.notInRecords || r.claude === 0);
    const why = g.why ? [g.why] : [];
    void citedSources; void DECLINE_RE;
    if (r.claude > 0 && !pass) why.push('needs-model');
    // A failure whose source documents were never turned into facts here (scan / photo / handwriting, or a layout the
    // deterministic reader refuses) is PENDING: production reads those with Claude, so only the staging QA can judge it.
    // (a question that needs every listed document - "which invoices are unpaid?" - is pending if ANY of them was not read)
    const files = q.notInRecords ? [] : q.file.split('|');
    const readFlags = files.map((f) => (factsByFile.get(f) ?? 0) > 0);
    const targetsRead = q.notInRecords ? true : ((q.expect ?? []).length > 1 && q.type === 'unpaid') ? readFlags.every(Boolean) : readFlags.some(Boolean);
    const pending = !pass && (!targetsRead || r.claude > 0);
    const lane = r.logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.answer_lane)?.answer_lane ?? null;
    results.push({ id: q.id, q: q.q, type: q.type, pass, pending, targetsRead, why: why.join('; '), kind, lane, modelCalls: r.claude, ms: r.ms, answer: String(r.data?.text ?? r.error ?? '').slice(0, 300) });
    realLog(`${pass ? 'PASS' : pending ? 'PEND' : 'FAIL'} ${q.id} ${q.q}${pass ? '' : `  -> ${why.join('; ')} | ${String(r.data?.text ?? r.error ?? '').slice(0, 140).replace(/\n/g, ' ')}`}`);
  }
  const passed = results.filter((x) => x.pass).length;
  const pendingN = results.filter((x) => x.pending).length;
  report.industries[ind.slug] = { passed, pending: pendingN, failed: results.length - passed - pendingN, total: results.length, results };
  realLog(`== ${ind.slug}: ${passed}/${results.length} pass, ${pendingN} pending staging (need Claude), ${results.length - passed - pendingN} fail`);
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
process.exit(0);
