#!/usr/bin/env node
/**
 * PROOF, offline: load the Wave 1 sample paperwork through DeepWell's real upload + reading pipeline, exactly the way
 * scripts/demo-acct/seed-demo.mjs will against staging, but against a local PGlite database and in-memory storage.
 *
 *   npx tsx scripts/demo-acct/local-seed.mjs --docs <generated docs dir> --out <state file> [--only hvac,plumbing]
 *
 * Per industry: D1 makes the organization a demo company (plan demo, loading window open) -> an import key is created
 * (what Sterling does in the app) -> the REAL staff import tool runs as a child process against a local HTTP server
 * routing to the REAL /api/upload-url and /api/read-document handlers -> each read document then goes through the same
 * extraction step the queue worker runs (extractDocumentFields + financials, api/_lib/queue.js) -> D2 records the seed and
 * closes the loading window. No fact is ever inserted directly. The resulting database is saved for the QA run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bootLocal, startApiServer, createImportKey, runD1, WAVE1, localOrgId, ROOT } from './lib/local-env.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const DOCS = args.docs ?? process.env.DEMO_DOCS ?? path.join(ROOT, 'demo-wave1');
const OUT = args.out ?? path.join(os.tmpdir(), 'deepwell-demo-seeded.tar');
const ONLY = args.only ? String(args.only).split(',') : null;

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const quiet = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"(route|event|t|timestamp|level|stage)"/.test(a[0])) return; quiet(...a); };
console.warn = () => {};
const realError = console.error;
console.error = (...a) => { if (process.env.SEED_DEBUG) realError(...a); };

const env = await bootLocal();
const { lite, model } = env;
await runD1(lite);
const RS = await import(path.join(ROOT, 'api/_lib/recordsStore.js'));
const PLAN = await import(path.join(ROOT, 'api/_lib/plan.js'));
const { extractDocumentFields } = await import(path.join(ROOT, 'api/_lib/extractDocument.js'));
const { extractFinancialsDeterministicFirst } = await import(path.join(ROOT, 'api/_lib/modelAvoidance/financialsHook.js'));
const api = await startApiServer();
log(`local API on http://127.0.0.1:${api.port}`);

const report = { generatedAt: new Date().toISOString(), industries: {} };
for (const ind of WAVE1) {
  if (ONLY && !ONLY.includes(ind.slug)) continue;
  const folder = path.join(DOCS, ind.slug, 'files');
  if (!fs.existsSync(folder)) { log(`skip ${ind.slug}: no ${folder}`); continue; }
  const orgId = localOrgId(ind.slug);
  const ctx = { tenantKey: orgId, tenantName: orgId };
  const tenant = await RS.getTenantContext(orgId, orgId);
  RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.();
  await lite.exec('RESET ROLE');
  const key = await createImportKey(lite, tenant.id);
  const state = path.join(path.dirname(OUT), `.import-${ind.slug}.jsonl`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(state, { force: true });
  const t0 = Date.now();
  const ocrBefore = model.ocrCalls;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/import/deepwell-import.mjs'), '--folder', folder, '--base-url', `http://127.0.0.1:${api.port}`, '--yes', '--concurrency', '2', '--state', state],
      { env: { ...process.env, DEEPWELL_IMPORT_KEY: key, DEEPWELL_IMPORT_BACKOFF_MS: '50', DEEPWELL_IMPORT_POLL_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (c) => { fs.writeFileSync(path.join(path.dirname(OUT), `import-${ind.slug}.log`), out); resolve(c); });
  });
  // The extraction step the queue worker runs after each read (api/_lib/queue.js "extract-fields").
  await lite.exec('RESET ROLE');
  const { rows: docs } = await lite.query('SELECT id, original_filename, page_count, extract_error, extracted_at FROM documents WHERE tenant_id = $1 ORDER BY original_filename', [tenant.id]);
  const per = [];
  for (const d of docs) {
    const row = { file: d.original_filename, pages: d.page_count, readError: d.extract_error ?? null, extract: null, fields: 0, method: null };
    if (d.page_count > 0 && !d.extract_error) {
      try {
        const r = await extractDocumentFields(ctx, d.id, { modelAttempts: 1 });
        row.fields = r.fields?.length ?? 0; row.method = r.model ?? r.method ?? null; row.extract = 'ok';
      } catch (e) { row.extract = `error: ${String(e?.message ?? e).slice(0, 120)}`; }
      try { await extractFinancialsDeterministicFirst(ctx, d.id, { modelAttempts: 1 }); } catch { /* best effort, as in the queue */ }
    }
    per.push(row);
  }
  await lite.exec('RESET ROLE');
  const { rows: [{ n_ex }] } = await lite.query('SELECT count(*)::int AS n_ex FROM extractions WHERE tenant_id = $1', [tenant.id]);
  report.industries[ind.slug] = {
    orgId, importExitCode: code, documents: docs.length, read: per.filter((p) => p.pages > 0).length,
    extractedOk: per.filter((p) => p.extract === 'ok' && p.fields > 0).length, extractions: n_ex, ocrStandInCalls: model.ocrCalls - ocrBefore,
    seconds: Math.round((Date.now() - t0) / 1000), perDocument: per,
  };
  log(`${ind.slug}: tool exit ${code}, ${docs.length} documents, ${report.industries[ind.slug].read} read, ${report.industries[ind.slug].extractedOk} with fields, ${n_ex} facts, ${report.industries[ind.slug].seconds}s`);
}

// D2: record the seed + close the loading windows (as the migration owner).
await lite.exec('RESET ROLE');
await lite.exec(fs.readFileSync(path.join(ROOT, 'M3-config/demo/D2-finish-seeding.sql'), 'utf8'));
const { rows: seedRows } = await lite.query(`SELECT t.clerk_org_id, (SELECT count(*)::int FROM demo_seed_documents s WHERE s.tenant_id = t.id) AS seed, (t.limits->'staffImport' ? 'endedAt') AS closed FROM tenants t WHERE t.plan = 'demo' ORDER BY 1`);
report.seed = seedRows;
report.modelBlockedCalls = model.blocked;
log('seed:', JSON.stringify(seedRows));
await api.close();
const blob = await lite.dumpDataDir('none');
fs.writeFileSync(OUT, Buffer.from(await blob.arrayBuffer()));
fs.writeFileSync(OUT.replace(/\.tar$/, '.report.json'), JSON.stringify(report, null, 1));
log(`saved ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB), model calls blocked: ${model.blocked}`);
process.exit(0);
