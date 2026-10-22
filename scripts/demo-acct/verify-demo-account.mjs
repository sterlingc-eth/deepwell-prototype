#!/usr/bin/env node
/**
 * npm run verify:demo-account
 *
 * The industry demo account, end to end, on a real Postgres (PGlite, every migration incl. 73) with the REAL handlers:
 *   A. setup SQL: D1 makes six organizations demo companies (and refuses Sonoran Comfort Air and a paying company);
 *      sample paperwork is loaded through the REAL staff import tool -> /api/upload-url -> storage -> /api/read-document
 *      -> extraction (no fact inserted directly); D2 records the seed.
 *   B. restrictions: a signed-in demo user (a real Clerk-style session token, verified by the real requireAuth against a
 *      local key set) is refused billing, plan changes, invites, exports, deletes, edits, outreach and new API keys, and
 *      still can upload, read, ask and run the automatic link repair. A paying company is unaffected.
 *   C. isolation: a demo company's key cannot reach a real company's document; the reset refuses a real company; the
 *      nightly listing returns demo companies only; demo companies are left out of the warranty-digest / outreach listings;
 *      a demo company's questions are never logged as misses.
 *   D. reset: after a simulated demo day (a prospect's scan, questions, link repair) "Clear my scans" and the nightly
 *      reset each return EVERY demo-day-changeable table to the exact seed state (row-for-row fingerprint), remove the
 *      scan's stored file, and leave the paying company byte-identical.
 *   E. consistency: the snapshot table list in reset.js equals demo_snapshot_tables() in the SQL, and every table with a
 *      tenant_id is classified (restore / clear / keep).
 * No network, no real Clerk / R2 / Neon / model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { bootLocal, startApiServer, createImportKey, runD1, localOrgId, makeReqRes, ROOT, LOCAL_DEMO_USER } from './lib/local-env.mjs';

let failed = 0; let passed = 0;
const check = (name, ok, detail = '') => { if (ok) { passed++; if (process.env.VERBOSE) process.stdout.write(`ok    ${name}
`); } else { failed++; process.stdout.write(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}
`); } };
const quietLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; quietLog(...a); };
console.warn = () => {}; console.error = () => {};
const log = (...a) => quietLog(...a);

// ------------------------------------------------------------------ a local Clerk: JWKS served to the real verifier
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'ins_local_demo_test';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
function sessionToken({ sub, orgId, role = 'org:admin' }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub, sid: 'sess_' + sub, azp: 'https://deepwelltechnology.com', iat: now - 5, nbf: now - 5, exp: now + 600, iss: 'https://clerk.deepwelltechnology.com', org_id: orgId, org_role: role, email: 'demo@deepwelltechnology.com' }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

const env = await bootLocal();
const { lite, store, model } = env;
process.env.CLERK_SECRET_KEY = 'sk_' + 'test_' + 'localdemoverify';
const r2Fetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url?.url ?? url));
  if (u.hostname === 'api.clerk.com' && u.pathname.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  // no other outside service exists here: answer at once instead of waiting on the network
  if (!u.hostname.endsWith('.r2.cloudflarestorage.com') && !['127.0.0.1', 'localhost'].includes(u.hostname)) return new Response(JSON.stringify({ error: 'offline test' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return r2Fetch(url, init);
};

const RS = await import(path.join(ROOT, 'api/_lib/recordsStore.js'));
const PLAN = await import(path.join(ROOT, 'api/_lib/plan.js'));
const DEMO = await import(path.join(ROOT, 'api/_lib/demo/index.js'));
const RESET = await import(path.join(ROOT, 'api/_lib/demo/reset.js'));
const { extractDocumentFields } = await import(path.join(ROOT, 'api/_lib/extractDocument.js'));
const { extractFinancialsDeterministicFirst } = await import(path.join(ROOT, 'api/_lib/modelAvoidance/financialsHook.js'));
const H = {
  account: (await import(path.join(ROOT, 'api/account.js'))).default,
  billing: (await import(path.join(ROOT, 'api/billing.js'))).default,
  review: (await import(path.join(ROOT, 'api/review.js'))).default,
  records: (await import(path.join(ROOT, 'api/records.ts'))).default,
  upload: (await import(path.join(ROOT, 'api/upload-url.js'))).default,
  read: (await import(path.join(ROOT, 'api/read-document.js'))).default,
  ask: (await import(path.join(ROOT, 'api/ask.js'))).default,
};
const resetCaches = () => { RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.(); };
async function call(h, { method = 'POST', url = '/api/x', token, key, body, headers = {} }) {
  const { req, res } = makeReqRes({ method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body });
  try { await h(req, res); } catch (e) { res.statusCode = 599; res.body = { error: String(e?.message ?? e) }; }
  for (let i = 0; i < 400 && !res.ended; i++) await new Promise((r) => setTimeout(r, 25));
  return res;
}
const asSu = async (sql, params) => { await lite.exec('RESET ROLE'); return lite.query(sql, params); };

/* =============================================================== A. setup */
await runD1(lite);
resetCaches();
const HVAC = localOrgId('hvac');
const REAL = 'org_realshopverify1';
const { rows: demoRows } = await asSu("SELECT clerk_org_id, plan, billing_status, settings->>'company_name' AS company, settings->>'industry' AS industry FROM tenants WHERE plan = 'demo' ORDER BY 1");
check('D1 makes exactly the six Wave 1 organizations demo companies', demoRows.length === 6 && demoRows.every((r) => r.billing_status === 'demo'), JSON.stringify(demoRows));
check('D1 stores the company name used for own-company detection', demoRows.find((r) => r.clerk_org_id === HVAC)?.company === 'Coppervane Heating & Air');
check('D1 sets the trade reading pack', demoRows.find((r) => r.clerk_org_id === HVAC)?.industry === 'hvac' && demoRows.find((r) => r.clerk_org_id === localOrgId('realestate'))?.industry == null);
{
  const d1 = fs.readFileSync(path.join(ROOT, 'M3-config/demo/D1-setup-demo-companies.sql'), 'utf8');
  const sonoran = d1.replace('user_PASTE_DEMO_LOGIN_USER_ID', LOCAL_DEMO_USER).replace('org_PASTE_REAL_ESTATE_ORG_ID', 'org_3JZNNONccwrYbVGY5wTekSRN6YZ').replace(/org_PASTE_(\w+)_ORG_ID/g, (_, k) => `org_x${k.toLowerCase().replace(/_/g, '')}`);
  let refused = false; try { await asSu('SELECT 1'); await lite.exec(sonoran); } catch (e) { refused = /Sonoran Comfort Air/.test(e.message); }
  check('D1 refuses Sonoran Comfort Air', refused);
  const real = await RS.getTenantContext(REAL, REAL);
  await asSu("UPDATE tenants SET plan = 'fleet', billing_status = 'active', stripe_customer_id = 'cus_verifydemo' WHERE id = $1", [real.id]);
  const paid = d1.replace('user_PASTE_DEMO_LOGIN_USER_ID', LOCAL_DEMO_USER).replace('org_PASTE_REAL_ESTATE_ORG_ID', REAL).replace(/org_PASTE_(\w+)_ORG_ID/g, (_, k) => `org_y${k.toLowerCase().replace(/_/g, '')}`);
  let refused2 = false; try { await lite.exec(paid); } catch (e) { refused2 = /real plan|Stripe customer/.test(e.message); }
  check('D1 refuses a paying company', refused2);
  const { rows: [st] } = await asSu('SELECT plan, billing_status FROM tenants WHERE id = $1', [real.id]);
  check('the refused paying company is unchanged', st.plan === 'fleet' && st.billing_status === 'active');
}
resetCaches();
check('plan.js: a demo row is active for reading/asking', PLAN.planStateFor({ plan: 'demo', billing_status: 'demo' }) === 'active' && PLAN.requireActiveBilling({ plan: 'demo', billing_status: 'demo' }).allowed);
check('plan.js: billing_status demo on a NON-demo plan is not active', PLAN.planStateFor({ plan: 'shop', billing_status: 'demo' }) === 'none');

// seed HVAC (8 sample documents) + the real company (2 documents) through the real import tool
const DOCS = process.env.DEMO_DOCS ?? path.join(ROOT, 'scripts/fixtures/demo-account');
const api = await startApiServer();
async function importFolder(orgId, files) {
  const t = await RS.getTenantContext(orgId, orgId);
  const key = await createImportKey(lite, t.id, ['ingest', 'read', 'ask']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demoseed-'));
  for (const f of files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  const state = path.join(os.tmpdir(), `st-${orgId}-${Date.now()}.jsonl`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/import/deepwell-import.mjs'), '--folder', dir, '--base-url', `http://127.0.0.1:${api.port}`, '--yes', '--state', state],
      { env: { ...process.env, DEEPWELL_IMPORT_KEY: key, DEEPWELL_IMPORT_BACKOFF_MS: '50' }, stdio: 'ignore' });
    child.on('close', resolve);
  });
  const { rows } = await asSu('SELECT id FROM documents WHERE tenant_id = $1', [t.id]);
  for (const r of rows) { try { await extractDocumentFields({ tenantKey: orgId, tenantName: orgId }, r.id, { modelAttempts: 1 }); } catch { /* model-only docs */ } try { await extractFinancialsDeterministicFirst({ tenantKey: orgId, tenantName: orgId }, r.id, { modelAttempts: 1 }); } catch { /* */ } }
  return { code, key, tenantId: t.id, docs: rows.length };
}
const hvacFiles = ['Invoice CV-24117 Whitcombe.pdf', 'Maintenance agreement MA-2025-031 Whitcombe.pdf', 'Warranty registration Whitcombe heat pump.pdf', 'Invoice CV-23990 Okafor final.pdf',
  'Proposal Q-2601 Okafor system replacement.pdf', 'Mechanical permit MP-26-01882 Okafor.pdf', 'Service ticket SV-4410 Whitcombe tune-up.pdf', 'Invoice CV-24037 Ruehl.pdf'].map((f) => path.join(DOCS, 'hvac/files', f));
const seedRun = await importFolder(HVAC, hvacFiles);
check('demo seeding: the real import tool loads the sample paperwork (exit 0, 8 documents)', seedRun.code === 0 && seedRun.docs === 8, JSON.stringify(seedRun));
const realRun = await importFolder(REAL, [path.join(DOCS, 'plumbing/files/Invoice BP-3166 Hendricks sewer repair.pdf'), path.join(DOCS, 'plumbing/files/Proposal BQ-121 Cottonwood water heaters.pdf')]);
check('a paying (Fleet) company loads its own documents the same way', realRun.code === 0 && realRun.docs === 2);
const { rows: [{ n: facts }] } = await asSu('SELECT count(*)::int AS n FROM extractions WHERE tenant_id = $1', [seedRun.tenantId]);
check('the pipeline produced facts for the demo company', facts > 20, String(facts));

// D2
await asSu('SELECT 1');
await lite.exec(fs.readFileSync(path.join(ROOT, 'M3-config/demo/D2-finish-seeding.sql'), 'utf8'));
resetCaches();
const { rows: [seed] } = await asSu("SELECT (SELECT count(*)::int FROM demo_seed_documents WHERE tenant_id = $1) AS docs, (SELECT count(*)::int FROM demo_seed_snapshot WHERE tenant_id = $1) AS tables, (SELECT limits->'staffImport' ? 'endedAt' FROM tenants WHERE id = $1) AS closed, (SELECT count(*)::int FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL) AS keys", [seedRun.tenantId]);
check('D2 records the seed (8 documents), snapshots the tables, closes the window and revokes the import key', seed.docs === 8 && seed.tables >= 12 && seed.closed === true && seed.keys === 0, JSON.stringify(seed));
const { rows: [realKeys] } = await asSu('SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL', [realRun.tenantId]);
check('D2 leaves the paying company\'s keys alone', realKeys.n === 1);

/* =============================================================== fingerprints */
const { rows: tenantTables } = await asSu("SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY 1");
const ALL = tenantTables.map((r) => r.t);
async function fingerprint(tenantId, tables) {
  const out = {};
  for (const t of tables) {
    const { rows: cols } = await asSu("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND COALESCE(is_generated,'NEVER') <> 'ALWAYS' ORDER BY ordinal_position", [t]);
    const sel = cols.map((c) => `"${c.column_name}"`).join(', ');
    const { rows: [r] } = await asSu(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM (SELECT row(${sel}) AS x FROM "${t}" WHERE tenant_id = $1) s`, [tenantId]);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const SEEDSTATE = [...RESET.SNAPSHOT_TABLES, ...RESET.CLEAR_TABLES, 'document_pages'].filter((t) => ALL.includes(t));
const seedFp = await fingerprint(seedRun.tenantId, SEEDSTATE);
for (const t of RESET.CLEAR_TABLES.filter((x) => ALL.includes(x))) seedFp[t] = (await fingerprint(seedRun.tenantId, [t]))[t];
const realFp0 = await fingerprint(realRun.tenantId, ALL.filter((t) => !['audit_log', 'usage_counters', 'rate_limit_windows', 'users'].includes(t)));

/* =============================================================== B. restrictions */
const demoTok = sessionToken({ sub: 'user_demo1', orgId: HVAC });
const realTok = sessionToken({ sub: 'user_owner1', orgId: REAL });
const st = async (h, opts) => (await call(h, opts)).statusCode;
const blocked = async (name, h, opts) => { const r = await call(h, { ...opts, token: demoTok }); check(`demo: ${name} is turned off (403 demo)`, r.statusCode === 403 && r.body?.code === 'demo-restricted', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 160)}`); };
await blocked('billing checkout', H.billing, { url: '/api/billing?action=checkout', body: { plan: 'shop' } });
await blocked('billing portal', H.billing, { url: '/api/billing?action=portal', body: {} });
await blocked('inviting a person', H.billing, { url: '/api/billing?action=invite', body: { email: 'x@example.com' } });
await blocked('seat management', H.billing, { url: '/api/billing?action=seats', body: {} });
await blocked('data export', H.account, { url: '/api/account?action=export', body: {} });
await blocked('export of original files', H.account, { url: '/api/account?action=export-files', body: {} });
await blocked('deleting the company', H.account, { url: '/api/account?action=delete', body: { confirm: 'DELETE' } });
await blocked('outreach emails', H.account, { url: '/api/account?action=outreach', body: { op: 'send' } });
await blocked('follow-up messages', H.account, { url: '/api/account?action=followups', body: { op: 'run' } });
await blocked('merging customers', H.account, { url: '/api/account?action=entity-merge', body: { op: 'accept' } });
await blocked('renaming documents', H.account, { url: '/api/account?action=naming', body: { op: 'rename' } });
await blocked('resolving inbox questions (fact edits)', H.account, { url: '/api/account?action=intake', body: { op: 'resolve' } });
await blocked('Google Drive connection', H.account, { url: '/api/account?action=google-sync', body: { op: 'status' } });
await blocked('correcting a fact', H.review, { url: '/api/review', body: { action: 'correctField' } });
await blocked('deleting documents', H.review, { url: '/api/review', body: { action: 'deleteDocuments', documentIds: [] } });
await blocked('a destructive integrity fix', H.review, { url: '/api/review', body: { action: 'integrityFix', apply: ['mergeDuplicates'] } });
await blocked('thumbs feedback into learning', H.review, { url: '/api/review', body: { action: 'askFeedback', rating: 'down' } });
await blocked('records write (updateExtraction)', H.records, { url: '/api/records', body: { action: 'updateExtraction', id: crypto.randomUUID(), value: 'x' } });
await blocked('records write (createEntity)', H.records, { url: '/api/records', body: { action: 'createEntity', entity_type: 'customer', data: { name: 'x' } } });
{
  const r = await call(H.account, { url: '/api/account?action=keys', token: demoTok, body: { action: 'create', name: 'x', scopes: ['read'] } });
  check('demo: a new API key is refused once the loading window is closed', r.statusCode === 403, `${r.statusCode}`);
}
check('demo: billing status is on the allow-list (it answers "demo")', DEMO.DEMO_ALLOWED_BILLING_ACTIONS.has('status'));
check('demo: records reads work', (await st(H.records, { url: '/api/records', token: demoTok, body: { action: 'listDocuments' } })) === 200);
check('demo: the automatic link repair a fresh scan uses is allowed', (await st(H.review, { url: '/api/review', token: demoTok, body: { action: 'integrityFix', apply: ['linkDocuments', 'linkEquipmentCustomers'] } })) === 200);
check('paying company: corrections are NOT blocked by the demo rule', (await call(H.review, { url: '/api/review', token: realTok, body: { action: 'correctField' } })).body?.code !== 'demo-restricted');
check('paying company: billing portal is NOT blocked by the demo rule', (await call(H.billing, { url: '/api/billing?action=portal', token: realTok, body: {} })).body?.code !== 'demo-restricted');
{
  const s = await call(H.account, { url: '/api/account?action=demo', token: demoTok, body: { op: 'status' } });
  check('demo status reports the industry, company and 0 scans', s.statusCode === 200 && s.body?.demo === true && s.body?.industry === 'HVAC' && s.body?.company === 'Coppervane Heating & Air' && s.body?.scans === 0, JSON.stringify(s.body));
  const sr = await call(H.account, { url: '/api/account?action=demo', token: realTok, body: { op: 'status' } });
  check('demo status says "not a demo" for a paying company', sr.statusCode === 200 && sr.body?.demo === false);
  const cr = await call(H.account, { url: '/api/account?action=demo', token: realTok, body: { op: 'clear-scans' } });
  check('"Clear my scans" is refused for a paying company', cr.statusCode === 403, String(cr.statusCode));
  let threw = false; try { await RESET.resetDemoTenant({ tenantKey: REAL, tenantName: REAL }); } catch (e) { threw = e.status === 403; }
  check('the reset itself refuses a paying company (even if called directly)', threw);
  const cron = await call(H.account, { method: 'GET', url: '/api/account?action=demo&op=reset-all', body: undefined });
  check('the nightly reset needs the cron secret', cron.statusCode === 401);
}

/* =============================================================== C. isolation */
{
  const { rows } = await asSu('SELECT tenant_key FROM list_demo_tenants() ORDER BY 1');
  check('list_demo_tenants() returns the six demo companies only', rows.length === 6 && !rows.some((r) => r.tenant_key === REAL));
  for (const fn of ['list_notification_eligible_tenants', 'list_outreach_enabled_tenants']) {
    const { rows: ex } = await asSu("SELECT 1 FROM pg_proc WHERE proname = $1", [fn]);
    if (!ex.length) continue;
    let ids = [];
    try { ({ rows: ids } = await asSu(`SELECT * FROM ${fn}()`)); } catch { ids = []; }
    check(`${fn}() leaves demo companies out`, !ids.some((r) => Object.values(r).includes(seedRun.tenantId) || Object.values(r).includes(HVAC)));
  }
  const { rows: [realDoc] } = await asSu('SELECT id FROM documents WHERE tenant_id = $1 LIMIT 1', [realRun.tenantId]);
  const k = await createImportKey(lite, seedRun.tenantId, ['read', 'ingest']);
  // window closed -> key refused outright; reopen the window briefly to prove RLS alone still isolates
  await asSu(`UPDATE tenants SET limits = jsonb_set(limits, '{staffImport}', (limits->'staffImport') - 'endedAt') WHERE id = $1`, [seedRun.tenantId]); resetCaches();
  const g = await call(H.upload, { url: '/api/upload-url', key: k, body: { mode: 'get', documentId: realDoc.id } });
  check('a demo company\'s key cannot open a paying company\'s document', g.statusCode === 404 || g.statusCode === 403, `${g.statusCode}`);
  await asSu(`UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [seedRun.tenantId]);
  await asSu(`UPDATE tenants SET limits = jsonb_set(limits, '{staffImport,endedAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id = $1`, [seedRun.tenantId]); resetCaches();
}

/* =============================================================== D. a demo day, then the resets */
async function demoDay(tag) {
  // the prospect scans a document of their own (the real browser path: Clerk session -> upload-url -> PUT -> read)
  const bytes = fs.readFileSync(path.join(DOCS, 'hvac/files/Invoice CV-24390 Brandvold duct cleaning.pdf'));
  const extra = Buffer.concat([bytes, Buffer.from(`\n%${tag}\n`)]);
  const sha = crypto.createHash('sha256').update(extra).digest('hex');
  const p = await call(H.upload, { url: '/api/upload-url', token: demoTok, body: { filename: `prospect scan ${tag}.pdf`, sha256: sha, sizeBytes: extra.length, contentType: 'application/pdf' } });
  const okUpload = p.statusCode === 200 && p.body?.uploadUrl;
  if (okUpload) await globalThis.fetch(p.body.uploadUrl, { method: 'PUT', body: extra });
  const rd = okUpload ? await call(H.read, { url: '/api/read-document', token: demoTok, body: { documentId: p.body.documentId, sync: true } }) : null;
  if (rd?.statusCode === 200) { try { await extractDocumentFields({ tenantKey: HVAC, tenantName: HVAC }, p.body.documentId, { modelAttempts: 1 }); } catch { /* */ } }
  for (const question of ['Who was the technician on invoice CV-24117?', 'When does Harlan Whitcombe\'s maintenance agreement expire?', 'What is the meaning of life?']) {
    await call(H.ask, { url: '/api/ask', token: demoTok, body: { question } });
  }
  await call(H.review, { url: '/api/review', token: demoTok, body: { action: 'integrityFix', apply: ['linkDocuments', 'linkEquipmentCustomers'] } });
  return { uploaded: okUpload && rd?.statusCode === 200, documentId: p.body?.documentId, key: p.body?.storageKey };
}
{
  const day = await demoDay('one');
  check('demo: a live scan uploads and is read', day.uploaded);
  const s = await call(H.account, { url: '/api/account?action=demo', token: demoTok, body: { op: 'status' } });
  check('demo status counts the scan', s.body?.scans === 1, JSON.stringify(s.body));
  const { rows: [m] } = await asSu('SELECT count(*)::int AS n FROM ask_misses WHERE tenant_id = $1', [seedRun.tenantId]);
  check('a demo company\'s questions are never logged as misses', m.n === 0, String(m.n));
  const objectsBefore = store.size;
  const c = await call(H.account, { url: '/api/account?action=demo', token: demoTok, body: { op: 'clear-scans' } });
  check('"Clear my scans" succeeds and removes 1 document', c.statusCode === 200 && c.body?.removedDocuments === 1, JSON.stringify(c.body));
  check('"Clear my scans" deletes the scan\'s stored file', store.size === objectsBefore - 1, `${objectsBefore} -> ${store.size}`);
  const fp = await fingerprint(seedRun.tenantId, SEEDSTATE);
  const diff = Object.keys(seedFp).filter((t) => fp[t] !== seedFp[t]);
  check('after "Clear my scans" every demo-day table is back to the exact seed state', diff.length === 0, diff.map((t) => `${t} ${seedFp[t]} -> ${fp[t]}`).join('; '));
}
{
  await demoDay('two');
  await demoDay('three');
  const cron = await call(H.account, { method: 'GET', url: '/api/account?action=demo&op=reset-all', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  check('nightly reset runs for the demo companies (unseeded ones report that they have no seed yet)', cron.statusCode === 200 && cron.body?.reset >= 1, JSON.stringify(cron.body).slice(0, 300));
  const fp = await fingerprint(seedRun.tenantId, SEEDSTATE);
  const diff = Object.keys(seedFp).filter((t) => fp[t] !== seedFp[t]);
  check('after the nightly reset every demo-day table is back to the exact seed state', diff.length === 0, diff.map((t) => `${t}`).join(', '));
  const { rows: [n] } = await asSu('SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1', [seedRun.tenantId]);
  check('after the nightly reset the demo company holds exactly its 8 seed documents', n.n === 8);
  const realFp = await fingerprint(realRun.tenantId, Object.keys(realFp0));
  const rdiff = Object.keys(realFp0).filter((t) => realFp[t] !== realFp0[t]);
  check('the paying company is byte-identical after demo days and resets', rdiff.length === 0, rdiff.join(', '));
}

/* =============================================================== E. consistency */
{
  const { rows: [r] } = await asSu('SELECT demo_snapshot_tables() AS t');
  check('reset.js SNAPSHOT_TABLES equals demo_snapshot_tables() in M3-config/73', JSON.stringify(r.t) === JSON.stringify(RESET.SNAPSHOT_TABLES));
  const known = new Set([...RESET.SNAPSHOT_TABLES, ...RESET.CLEAR_TABLES, ...RESET.KEPT_TABLES]);
  const unclassified = ALL.filter((t) => !known.has(t));
  check('every table with a tenant_id is classified restore / clear / keep in reset.js', unclassified.length === 0, unclassified.join(', '));
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  check('vercel.json schedules the nightly demo reset', vercel.crons.some((c) => c.path === '/api/account?action=demo&op=reset-all'));
  check('api/ still has exactly 12 function files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => !f.startsWith('_')).length === 12);
}

/* =============================================================== F. Donovan fixes found by the demo QA (general, not demo-specific) */
{
  const FH = await import(path.join(ROOT, 'api/_lib/modelAvoidance/financialsHook.js'));
  const FA = await import(path.join(ROOT, 'api/_lib/financials/answers.js'));
  const pg = (t) => [{ page_no: 1, text: t }];
  const pay = (t) => FH.printedPaymentFromText(pg(t));
  check('payment: "Balance Due" equal to the total reads as unpaid with the balance', pay('Total: $309.60\nBalance Due: $309.60').printed_status === 'unpaid' && pay('Total: $309.60\nBalance Due: $309.60').balance_due?.value === '309.60');
  check('payment: "Status: Paid in full" reads as paid', pay('Total: $133.26\nStatus: Paid in full').printed_status === 'paid');
  check('payment: a deposit and a balance are both read', pay('Total: $100.00\nDeposit Received: $40.00\nBalance Due: $60.00').amount_paid?.value === '40.00');
  check('payment: two different balances are ambiguous -> nothing read', Object.keys(pay('Balance Due: $10.00\nBalance Due: $20.00')).length === 0);
  check('payment: an unknown status word is not guessed', Object.keys(pay('Status: Pending review')).length === 0);
  check('due date: one printed due date is read', FH.printedDueDateFromText(pg('Due Date: 04/13/2026')) === '2026-04-13');
  check('due date: two different due dates -> none', FH.printedDueDateFromText(pg('Due Date: 04/13/2026\nDue Date: 05/13/2026')) === null);
  const bill = 'Haverline Lumber & Truss\n6100 S Kyrene Rd, Tempe, AZ 85283\n(480) 555-0167\nINVOICE\nInvoice #: HLT-58812\nInvoice Date: 04/09/2026\nBill To: Stonefield & Pike Builders\nRemit To: Haverline Lumber & Truss\nDescription   Qty   Rate   Amount\nFraming package   1   $13,140.00   $13,140.00\nDelivery   1   $1,080.00   $1,080.00\nSubtotal: $14,220.00\nTotal: $14,220.00\nBalance Due: $14,220.00';
  const withOwn = FH.financialsInputFromText(pg(bill), 'invoice', { ownNames: ['Stonefield & Pike Builders'] });
  check('a supplier bill addressed to us is money WE owe (payable), not a customer invoice', withOwn?.direction === 'payable' && withOwn?.vendor_name === 'Haverline Lumber & Truss' && !withOwn?.customer_name, JSON.stringify(withOwn));
  const toCustomer = FH.financialsInputFromText(pg(bill.replace('Bill To: Stonefield & Pike Builders', 'Bill To: Rafael Ocampo').replace('Remit To: Haverline Lumber & Truss\n', '')), 'invoice', { ownNames: ['Stonefield & Pike Builders'] });
  check('an invoice to a customer stays receivable', toCustomer?.direction === 'receivable' && toCustomer?.customer_name === 'Rafael Ocampo', JSON.stringify(toCustomer));
  const intent = (q) => FA.parseMoneyIntent(q, { today: '2026-10-22' })?.intent;
  check('"which invoices haven\'t been paid" is the open-invoices question (it used to count PAID invoices)', intent("Which invoices haven't been paid?") === 'open_invoices');
  check('"which vendor invoices haven\'t been paid" is the vendor-bills question', intent("Which vendor invoices haven't been paid?") === 'payables_open');
  check('"how many invoices are paid" is unchanged', intent('How many invoices are paid?') === 'payment_status');
  check('"which invoices are unpaid" is unchanged', intent('Which invoices are unpaid?') === 'open_invoices');
}

await api.close();
log(`verify:demo-account  ${passed} passed, ${failed} failed (model calls blocked: ${model.blocked})`);
process.exit(failed ? 1 : 0);
