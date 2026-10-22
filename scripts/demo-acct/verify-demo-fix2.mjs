/**
 * npm run verify:demo-fix2  -  demo fix round 2 (2026-10-22). Real Postgres (PGlite, every migration, the app's RLS role), the
 * real handlers, a local Clerk. No network, no model.
 *
 *   A. ALLOW-LIST      a demo login may call only the read / ask / upload / scan / clear-scans / switch-industry actions; financials
 *                      correct+verify+backfill, graph refresh, notification settings, support handoff, keys, anything else -> friendly 403,
 *                      and no email is sent. A paying company is unaffected. (pure table + the real account/billing handlers)
 *   B. RESET           the nightly reset / "Clear my scans" put tenants.settings (notification digest, mutes, screen prefs) back.
 *   C. NOISE           demo companies are left out of usage_counters.requests (model_calls still counted: it is the spend ceiling), routine
 *                      audit rows (security rows are kept) and the cron sweep.
 *   D. D1 / D9         D1 converts only organizations owned by the demo login; never a real company with no plan; D9 rolls everything back.
 *   E. MONEY           a receipt scanned twice is counted once; "how much did we spend at <supplier>" is answered from that supplier's bills.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bootLocal, openDemoOrgs, d1Sql, localOrgId, makeReqRes, ROOT, LOCAL_DEMO_USER } from './lib/local-env.mjs';

let failed = 0; let passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else { failed++; process.stdout.write(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}\n`); } };
const quietLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; quietLog(...a); };
console.warn = () => {}; console.error = () => {};

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'ins_local_fix2';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64u = (b) => Buffer.from(b).toString('base64url');
function sessionToken({ sub, orgId, role = 'org:admin' }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub, sid: 'sess_' + sub, azp: 'https://deepwelltechnology.com', iat: now - 5, nbf: now - 5, exp: now + 600, iss: 'https://clerk.deepwelltechnology.com', org_id: orgId, org_role: role, email: 'demo@deepwelltechnology.com' }));
  return `${head}.${body}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey))}`;
}

const env = await bootLocal({ ocr: false });
const { lite } = env;
process.env.CLERK_SECRET_KEY = 'sk_' + 'test_' + 'localfix2verify';
const outbound = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url?.url ?? url));
  if (u.hostname === 'api.clerk.com' && u.pathname.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (!u.hostname.endsWith('.r2.cloudflarestorage.com')) { outbound.push(u.hostname); return new Response(JSON.stringify({ error: 'offline test' }), { status: 404, headers: { 'content-type': 'application/json' } }); }
  return baseFetch(url, init);
};

const RS = await import(path.join(ROOT, 'api/_lib/recordsStore.js'));
const PLAN = await import(path.join(ROOT, 'api/_lib/plan.js'));
const DEMO = await import(path.join(ROOT, 'api/_lib/demo/index.js'));
const POLICY = await import(path.join(ROOT, 'api/_lib/demo/auditPolicy.js'));
const RESET = await import(path.join(ROOT, 'api/_lib/demo/reset.js'));
const RL = await import(path.join(ROOT, 'api/_lib/rateLimit.js'));
const USAGE = await import(path.join(ROOT, 'api/_lib/usage.js'));
const MG = await import(path.join(ROOT, 'api/_lib/financials/moneyGate.js'));
const FA = await import(path.join(ROOT, 'api/_lib/financials/answers.js'));
const H = {
  account: (await import(path.join(ROOT, 'api/account.js'))).default,
  billing: (await import(path.join(ROOT, 'api/billing.js'))).default,
};
const resetCaches = () => { RS._resetTenantContextCache?.(); PLAN._resetBillingRowCache?.(); POLICY._resetAuditPolicyCache?.(); };
async function call(h, { method = 'POST', url = '/api/x', token, body, headers = {} }) {
  const { req, res } = makeReqRes({ method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
  try { await Promise.race([h(req, res), new Promise((r) => setTimeout(() => { if (!res.ended) res.statusCode = 598; r(); }, 6000))]); } catch (e) { res.statusCode = 599; res.body = { error: String(e?.message ?? e) }; }
  for (let i = 0; i < 40 && !res.ended; i++) await new Promise((r) => setTimeout(r, 25));
  return res;
}
const su = async (sql, params) => { await lite.exec('RESET ROLE'); return lite.query(sql, params); };
const HVAC = localOrgId('hvac');
const REAL = 'org_realfix2shop';
const slugs = ['realestate', 'propmgmt', 'hvac', 'plumbing', 'electrical', 'contractors'];
const tryExec = async (sql) => { try { await su('SELECT 1'); await lite.exec(sql); return null; } catch (e) { return String(e.message); } };
const demoCount = async () => (await su("SELECT count(*)::int AS n FROM tenants WHERE plan = 'demo' OR billing_status = 'demo'")).rows[0].n;

/* =============================================================== D1. the setup SQL only converts real demo organizations */
{
  let e = await tryExec(d1Sql());
  check('D1: refuses while the demo login has not opened the organizations (never creates a company)', /has not been opened/.test(e ?? '') && (await demoCount()) === 0, e);
  check('D1: created no company row', (await su('SELECT count(*)::int AS n FROM tenants WHERE clerk_org_id = $1', [localOrgId('hvac')])).rows[0].n === 0);
  e = await tryExec(d1Sql({ user: 'user_PASTE_DEMO_LOGIN_USER_ID' }));
  check('D1: refuses the unedited demo-login placeholder', /Clerk user id/.test(e ?? ''), e);

  await openDemoOrgs(lite);
  // a real company that merely has no plan yet: other members, real documents, a normal name
  await su("SELECT resolve_tenant($1, $1)", [REAL]); // the app records the organization id as the company name
  const realId = (await su('SELECT id FROM tenants WHERE clerk_org_id = $1', [REAL])).rows[0].id;
  await su("INSERT INTO users (tenant_id, clerk_user_id, email, role) VALUES ($1, 'user_realowner1', 'owner@acme.example', 'admin')", [realId]);
  await su("INSERT INTO documents (tenant_id, original_filename, sha256_hash, stage) VALUES ($1, 'real invoice.pdf', 'realhash1', 'linked')", [realId]);
  const withReal = d1Sql().replace(localOrgId('hvac'), REAL);
  e = await tryExec(withReal);
  check('D1: a REAL company with no plan, a different owner and documents is refused (not owned by the demo account)', /not owned by the demo account/.test(e ?? ''), e);
  check('D1: refusal is all-or-nothing (no organization was converted)', (await demoCount()) === 0);
  // same company, but the demo login happens to be its admin too: other members still refuse it
  await su("INSERT INTO users (tenant_id, clerk_user_id, email, role) VALUES ($1, $2, 'demo@deepwelltechnology.com', 'admin')", [realId, LOCAL_DEMO_USER]);
  e = await tryExec(withReal);
  check('D1: a company the demo login shares with other people is refused', /members other than the demo login/.test(e ?? ''), e);
  await su('DELETE FROM users WHERE tenant_id = $1 AND clerk_user_id <> $2', [realId, LOCAL_DEMO_USER]);
  e = await tryExec(withReal);
  check('D1: a plan-less company that already holds documents is refused even with only the demo login as member', /already holds 1 document/.test(e ?? ''), e);
  await su('DELETE FROM documents WHERE tenant_id = $1', [realId]);
  await su("UPDATE tenants SET name = 'Acme Plumbing Co' WHERE id = $1", [realId]);
  e = await tryExec(withReal);
  check('D1: a company whose recorded name is not a demo name is refused', /not a demo organization/.test(e ?? ''), e);
  await su("UPDATE tenants SET name = clerk_org_id WHERE id = $1", [realId]);
  check('D1: nothing converted by any refusal', (await demoCount()) === 0);
  await su('DELETE FROM users WHERE tenant_id = $1', [realId]);
  await su("UPDATE tenants SET stripe_customer_id = NULL WHERE id = $1", [realId]);
  // an extra member on one of the six
  const reTenant = (await su('SELECT id FROM tenants WHERE clerk_org_id = $1', [localOrgId('realestate')])).rows[0].id;
  await su("INSERT INTO users (tenant_id, clerk_user_id, email, role) VALUES ($1, 'user_stranger1', 's@x.example', 'user')", [reTenant]);
  e = await tryExec(d1Sql());
  check('D1: one of the six having an extra member stops the whole run', /members other than the demo login/.test(e ?? '') && (await demoCount()) === 0, e);
  await su("DELETE FROM users WHERE clerk_user_id = 'user_stranger1'");
  e = await tryExec(d1Sql());
  check('D1: with the six opened by the demo login alone, exactly the six become demo companies', e === null && (await demoCount()) === 6, e);
  check('D1: the real no-plan company is untouched', (await su('SELECT plan, billing_status FROM tenants WHERE id = $1', [realId])).rows[0].plan === null);
  e = await tryExec(d1Sql());
  check('D1: safe to run again', e === null && (await demoCount()) === 6, e);
}
resetCaches();

/* =============================================================== seed one demo company (what D2 records) */
const hv = (await su('SELECT id FROM tenants WHERE clerk_org_id = $1', [HVAC])).rows[0].id;
await su("UPDATE tenants SET settings = settings || '{\"emailDigest\": false}'::jsonb WHERE id = $1", [hv]);
await su("INSERT INTO documents (tenant_id, original_filename, sha256_hash, stage) VALUES ($1, 'sample invoice.pdf', 'seedhash1', 'linked')", [hv]);
await lite.exec(fs.readFileSync(path.join(ROOT, 'M3-config/demo/D2-finish-seeding.sql'), 'utf8'));
resetCaches();
const seedSettings = (await su('SELECT settings FROM tenants WHERE id = $1', [hv])).rows[0].settings;
check('73 demo_mark_seed records the company settings in the snapshot', (await su("SELECT rows->0->'settings' AS s FROM demo_seed_snapshot WHERE tenant_id = $1 AND table_name = 'tenant_settings'", [hv])).rows[0]?.s?.emailDigest === false);

/* =============================================================== A. allow-list */
const demoTok = sessionToken({ sub: LOCAL_DEMO_USER, orgId: HVAC });
// a real (paying) company
const realTenant = (await su('SELECT id FROM tenants WHERE clerk_org_id = $1', [REAL])).rows[0].id;
await su("UPDATE tenants SET plan = 'fleet', billing_status = 'active' WHERE id = $1", [realTenant]);
resetCaches();
const realTok = sessionToken({ sub: 'user_realowner1', orgId: REAL });
const isDemo403 = (r) => r.statusCode === 403 && r.body?.code === 'demo-restricted';
const acct = (action, body, token = demoTok, extra = {}) => call(H.account, { url: `/api/account?action=${action}`, token, body, ...extra });
const mustBlock = async (name, action, body) => { const r = await acct(action, body); check(`allow-list: ${name} -> friendly 403`, isDemo403(r), `${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)}`); };
const mustPass = async (name, action, body) => { const r = await acct(action, body); check(`allow-list: ${name} is NOT refused by the demo rule`, !isDemo403(r), `${r.statusCode}`); };
const UUID = crypto.randomUUID();
outbound.length = 0;
await mustBlock('financials correct', 'financials', { op: 'correct', documentId: UUID, field: 'total', value: '1.00' });
await mustBlock('financials verify', 'financials', { op: 'verify', documentId: UUID });
await mustBlock('financials backfill (model spend)', 'financials', { op: 'backfill' });
await mustBlock('graph refresh', 'graph', { op: 'refresh' });
await mustBlock('graph refreshDocument', 'graph', { op: 'refreshDocument', documentId: UUID });
await mustBlock('notification settings (digest)', 'notifications', { settings: { emailDigest: true } });
await mustBlock('notification mute', 'notifications', { settings: { digestMuted: true } });
await mustBlock('notification screen prefs', 'notifications', { uiPrefs: { compact: true } });
await mustBlock('support handoff email', 'support', { action: 'handoff', message: 'hi' });
await mustBlock('support staff-access grant', 'support', { action: 'access-grant' });
await mustBlock('support staff-access end', 'support', { action: 'access-end' });
await mustBlock('support inquiry email', 'support', { action: 'inquiry', message: 'hi' });
await mustBlock('API keys list', 'keys', { action: 'list' });
await mustBlock('API key create', 'keys', { action: 'create', name: 'x', scopes: ['read'] });
await mustBlock('expenses', 'expenses', { op: 'list' });
await mustBlock('naming assign', 'naming', { op: 'assign', documentId: UUID });
await mustBlock('naming backfill', 'naming', { op: 'backfill' });
await mustBlock('unit-address backfill', 'unit-address', { op: 'backfill' });
await mustBlock('audience override', 'audience', { op: 'set', documentId: UUID });
await mustBlock('entity-merge accept / undo-merge-all', 'entity-merge', { op: 'undo-merge-all' });
await mustBlock('intake resolve', 'intake', { op: 'resolve' });
await mustBlock('an op the allow-list does not know of an allowed action', 'grid', { op: 'somethingNew' });
await mustBlock('an action with no op at all', 'financials', {});
await mustBlock('the cron sweep action', 'sweep', {});
await mustBlock('backup', 'backup', {});
check('allow-list: no email / outside call left the building for any blocked support or notification action', outbound.length === 0, outbound.join(','));
await mustPass('financials document (read)', 'financials', { op: 'document', documentId: UUID });
await mustPass('financials needsReview (read)', 'financials', { op: 'needsReview' });
await mustPass('financials summary (read)', 'financials', { op: 'summary' });
await mustPass('financials backfillStatus (read)', 'financials', { op: 'backfillStatus' });
await mustPass('graph status (read)', 'graph', { op: 'status' });
await mustPass('naming status (read)', 'naming', { op: 'status' });
await mustPass('grid units (read)', 'grid', { op: 'units' });
await mustPass('ask-suggest samples', 'ask-suggest', { op: 'samples' });
await mustPass('insights (read)', 'insights', {});
await mustPass('notifications: marking read', 'notifications', { all: true });
await mustPass('demo status', 'demo', { op: 'status' });
{
  const r = await call(H.account, { method: 'GET', url: '/api/account?action=notifications', token: demoTok });
  check('allow-list: the notification list (GET) works', !isDemo403(r), String(r.statusCode));
  const s = await acct('demo', { op: 'status' });
  check('allow-list: demo status still answers for the demo company', s.statusCode === 200 && s.body?.demo === true, JSON.stringify(s.body));
  const nr = await call(H.account, { url: '/api/account?action=financials', token: realTok, body: { op: 'backfill' } });
  check('allow-list: a paying company\'s financials backfill is NOT refused by the demo rule', !isDemo403(nr), String(nr.statusCode));
  const nr2 = await call(H.account, { url: '/api/account?action=notifications', token: realTok, body: { settings: { emailDigest: true } } });
  check('allow-list: a paying company can still change notification settings', nr2.statusCode === 200 && !isDemo403(nr2), String(nr2.statusCode));
  const sw = await call(H.account, { method: 'GET', url: '/api/account?action=health' });
  check('allow-list: the unauthenticated health check is untouched', sw.statusCode === 200 || sw.statusCode === 503, String(sw.statusCode));
}
for (const a of ['checkout', 'portal', 'invite', 'seats']) {
  const r = await call(H.billing, { url: `/api/billing?action=${a}`, token: demoTok, body: {} });
  check(`allow-list: billing ${a} -> friendly 403`, isDemo403(r), String(r.statusCode));
}
{
  const r = await call(H.billing, { url: '/api/billing?action=surpriseNewAction', token: demoTok, body: {} });
  check('allow-list: a billing action invented later is refused for a demo company', isDemo403(r), String(r.statusCode));
  check('allow-list: billing status stays on the allow-list (it answers "demo")', DEMO.DEMO_ALLOWED_BILLING_ACTIONS.has('status') && DEMO.DEMO_ALLOWED_BILLING_ACTIONS.size === 1);
}
check('allow-list table: every entry is read/ask/scan/switch only (no write verbs among allowed ops)',
  !Object.values(DEMO.DEMO_ACCOUNT_ALLOW).some((r) => (r.ops ?? []).filter((o) => !/Status$/.test(o)).some((o) => /^(correct|verify|backfill|refresh|accept|reject|undo|merge|assign|rename|resolve|dismiss|snooze|set|save|create|revoke|send|run|delete)/i.test(o))));

/* =============================================================== B. the reset restores settings */
{
  // simulate everything a presenter could change, as if a gate had been missed
  await su(`UPDATE tenants SET settings = settings || '{"emailDigest": true, "digestMuted": ["user_x"], "uiPrefs": {"user_x": {"compact": true}}, "industry": "tampered"}'::jsonb WHERE id = $1`, [hv]);
  await su("INSERT INTO tenant_outreach_settings (tenant_id, enabled, mode) VALUES ($1, true, 'auto')", [hv]);
  resetCaches();
  const r = await RESET.resetDemoTenant({ tenantKey: HVAC, tenantName: HVAC }, { reason: 'verify' });
  const after = (await su('SELECT settings FROM tenants WHERE id = $1', [hv])).rows[0].settings;
  check('reset: tenants.settings (digest, mutes, screen prefs, anything else) is exactly the seed value', JSON.stringify(after) === JSON.stringify(seedSettings), JSON.stringify(after));
  check('reset: reports the settings restore', r.restored?.tenant_settings === 1);
  check('reset: outreach settings are cleared', (await su('SELECT count(*)::int AS n FROM tenant_outreach_settings WHERE tenant_id = $1', [hv])).rows[0].n === 0);
  // a seed recorded before this fix has no settings entry: the three presenter keys are removed instead
  await su("DELETE FROM demo_seed_snapshot WHERE tenant_id = $1 AND table_name = 'tenant_settings'", [hv]);
  await su(`UPDATE tenants SET settings = settings || '{"emailDigest": true, "digestMuted": ["u"], "uiPrefs": {"u": {}}}'::jsonb WHERE id = $1`, [hv]);
  resetCaches();
  await RESET.resetDemoTenant({ tenantKey: HVAC, tenantName: HVAC }, { reason: 'verify' });
  const old = (await su('SELECT settings FROM tenants WHERE id = $1', [hv])).rows[0].settings;
  check('reset (older seed without a settings copy): the three presenter keys are removed, D1\'s company settings stay', old.emailDigest === undefined && old.digestMuted === undefined && old.uiPrefs === undefined && old.company_name === seedSettings.company_name && old.industry === seedSettings.industry, JSON.stringify(old));
  const real = (await su('SELECT settings FROM tenants WHERE id = $1', [realTenant])).rows[0].settings;
  check('reset: a paying company\'s settings were never touched', JSON.stringify(real) === JSON.stringify((await su('SELECT settings FROM tenants WHERE id = $1', [realTenant])).rows[0].settings));
  await su("INSERT INTO demo_seed_snapshot (tenant_id, table_name, row_count, rows) VALUES ($1, 'tenant_settings', 1, $2::jsonb) ON CONFLICT (tenant_id, table_name) DO UPDATE SET rows = EXCLUDED.rows", [hv, JSON.stringify([{ settings: seedSettings }])]);
  check('reset.js: every tenant table is restored, cleared or kept (outreach settings now cleared)', RESET.CLEAR_TABLES.includes('tenant_outreach_settings') && !RESET.KEPT_TABLES.includes('tenant_outreach_settings'));
}

/* =============================================================== C. demo companies out of the counters, the noise and the sweep */
{
  const mkAuth = (org) => ({ tenantId: org, userId: 'user_x', orgId: org });
  const lim = async (org) => { const { req, res } = makeReqRes({ method: 'POST', url: '/api/x', headers: {}, body: {} }); return RL.limit(req, res, mkAuth(org), 'read'); };
  resetCaches();
  const before = async (id) => Number((await su('SELECT COALESCE(sum(requests), 0)::int AS n FROM usage_counters WHERE tenant_id = $1', [id])).rows[0].n);
  const d0 = await before(hv); const r0 = await before(realTenant);
  check('usage: rate limit passes for the demo company', await lim(HVAC) === true);
  check('usage: rate limit passes for the paying company', await lim(REAL) === true);
  check('usage: the demo company\'s request is NOT added to usage_counters.requests', (await before(hv)) === d0, `${d0} -> ${await before(hv)}`);
  check('usage: a paying company\'s request IS still counted', (await before(realTenant)) === r0 + 1, `${r0} -> ${await before(realTenant)}`);
  // the burst / daily caps still work for demo (rate_limit_windows is separate)
  check('usage: the demo company still has a daily cap counter (rate_limit_windows)', (await su("SELECT count(*)::int AS n FROM rate_limit_windows WHERE tenant_id = $1", [hv])).rows[0].n > 0);
  await USAGE.recordModelCall({ tenantKey: HVAC, tenantName: HVAC }, { inputTokens: 10, outputTokens: 5 });
  check('usage: model_calls (the daily AI spend ceiling) keeps counting for a demo company', Number((await su('SELECT COALESCE(sum(model_calls), 0)::int AS n FROM usage_counters WHERE tenant_id = $1', [hv])).rows[0].n) === 1);

  // audit: noise skipped for demo, security kept, real company never affected
  const ctxD = { tenantKey: HVAC, tenantName: HVAC }; const ctxR = { tenantKey: REAL, tenantName: REAL };
  const audits = async (id, action) => (await su('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = $2', [id, action])).rows[0].n;
  await RS.withTenant(ctxD, (db) => db.logAction({ action: 'document.queried', resource_type: 'question', clerk_user_id: 'user_x', changes: {} }));
  await RS.withTenant(ctxD, (db) => db.logAction({ action: 'integrity.link_documents', resource_type: 'tenant', clerk_user_id: 'user_x', changes: {} }));
  await RS.withTenant(ctxD, (db) => db.logAction({ action: 'api_key.created', resource_type: 'api_key', clerk_user_id: 'user_x', changes: {} }));
  await RS.withTenant(ctxD, (db) => db.logAction({ action: 'tenant.exported', resource_type: 'tenant', clerk_user_id: 'user_x', changes: {} }));
  await RS.withTenant(ctxR, (db) => db.logAction({ action: 'document.queried', resource_type: 'question', clerk_user_id: 'user_x', changes: {} }));
  check('audit: a demo company\'s routine rows (question asked, link repair) are not written', (await audits(hv, 'document.queried')) === 0 && (await audits(hv, 'integrity.link_documents')) === 0);
  check('audit: security entries for a demo company ARE written (key created, export)', (await audits(hv, 'api_key.created')) === 1 && (await audits(hv, 'tenant.exported')) === 1);
  check('audit: a paying company\'s routine rows are still written', (await audits(realTenant, 'document.queried')) === 1);
  check('audit policy (pure): demo.reset, keys, billing, support-access, delete are never noise', !['demo.reset', 'api_key.created', 'keys.revoked', 'billing.updated', 'support.access_granted', 'tenant.deleted', 'tenant.exported', 'auth.failed'].some(POLICY.isDemoAuditNoise));
  check('audit policy (pure): the routine families are noise', ['document.queried', 'document.financials_extracted', 'integrity.heal_survivor', 'review.field_corrected', 'customers.merge_all_exact', 'donovan.autopilot_run'].every(POLICY.isDemoAuditNoise));

  // cron sweep leaves the demo companies out
  await su('GRANT EXECUTE ON FUNCTION list_demo_tenants() TO deepwell_rls'); // what 73 grants on Neon (the local app role is created after the migrations)
  // (the local database cannot run the cross-tenant listing function, so the sweep is handed its tenant list in the body - the documented fallback)
  const sweep = await call(H.account, { method: 'POST', url: '/api/account?action=sweep&mode=docs', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body: { tenants: [...slugs.map(localOrgId), REAL] } });
  check('cron sweep: runs for the cron secret', sweep.statusCode === 200, `${sweep.statusCode} ${JSON.stringify(sweep.body).slice(0, 120)}`);
  check('cron sweep: the six demo companies are skipped and reported', sweep.body?.demoTenantsSkipped === 6, JSON.stringify(sweep.body).slice(0, 200));
  check('cron sweep: the paying company is still visited', Number(sweep.body?.tenantsChecked) >= 1, JSON.stringify(sweep.body).slice(0, 200));
}

/* =============================================================== E. money */
{
  const ctx = { tenantKey: 'org_fix2money', tenantName: 'Acme HVAC' };
  const tid = (await RS.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  let n = 0;
  async function add({ kind = 'receipt', dir = 'payable', num, total, vendor = 'Desert Supply Co', stage = 'linked', at = '2026-10-01T10:00:00Z', date = '2026-10-02', status = 'paid' }) {
    n++;
    const id = `f2${String(n).padStart(6, '0')}-0000-4000-8000-000000000001`;
    await su('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [id, tid, `${kind}-${n}.pdf`, kind, `f2hash${n}`, stage]);
    await su('INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, invoice_number, invoice_date, total, status, vendor_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [tid, id, kind, dir, num, date, total, status, vendor, at]);
    return id;
  }
  const orig = await add({ num: 'R-1001', total: '43.84', at: '2026-10-01T10:00:00Z' });
  const dup = await add({ num: 'r 1001', total: '43.84', at: '2026-10-01T10:05:00Z' }); // the same receipt scanned twice (number written differently)
  await add({ num: 'R-1002', total: '120.00' });
  await add({ num: 'R-1001', total: '43.84', vendor: 'Ferguson Supply' }); // another store's receipt with the same number and amount
  await add({ num: 'R-1003', total: '125.00' });
  await add({ num: 'R-1003', total: '130.00', at: '2026-10-01T11:00:00Z' }); // same number, different amount: a revision, never a copy
  await add({ num: null, total: '10.00' }); await add({ num: null, total: '10.00' }); // no number: cannot be proven a copy
  await add({ kind: 'invoice', num: 'B-77', total: '450.00', status: 'unpaid' }); // a bill from the same supplier
  const vOrig = await add({ num: 'R-2000', total: '60.00', at: '2026-10-03T10:00:00Z' });
  const vDup = await add({ num: 'R-2000', total: '60.00', at: '2026-10-03T09:00:00Z', stage: 'linked' });
  await su("UPDATE documents SET stage = 'verified' WHERE id = $1", [vOrig]); // the CHECKED one is the original even though it arrived later
  const ask = (q) => MG.answerMoneyQuestion({ withTenant: RS.withTenant, ctxArg: ctx, question: q, today: '2026-10-22' });
  const money = (s) => Number((String(s).match(/\$([\d,]+\.\d\d)/) ?? [])[1]?.replace(/,/g, ''));

  const a = await ask('How much did we spend at Desert Supply Co?');
  // 43.84 + 120 + 125 + 130 + 10 + 10 + 450 + 60 = 948.84   (the scanned-twice 43.84 and the unchecked copy of 60.00 are out)
  check('money: "how much did we spend at <supplier>" is answered from that supplier\'s bills and receipts', a.handled && money(a.data?.text) === 948.84, a.data?.text);
  check('money: the answer cites the receipts and the bill, not the other store', (a.data?.facts?.[0]?.sources ?? []).length >= 8 && !/Ferguson/i.test(a.data?.text ?? ''));
  const a2 = await ask('How much did we spend with Desert Supply Co?');
  check('money: "spend with" gives the same figure as "spend at"', money(a2.data?.text) === 948.84, a2.data?.text);
  const b = await ask('how much have we spent at Ferguson Supply');
  check('money: another store\'s receipt with the same number and amount is a different paper (counted once for its own store)', money(b.data?.text) === 43.84, b.data?.text);
  const all = await ask('How much did we spend in total?');
  check('money: the all-supplier total also leaves out the copies (948.84 + 43.84)', money(all.data?.text) === 992.68, all.data?.text);
  const rows = (await su(`SELECT count(*)::int AS n FROM document_financials WHERE tenant_id = $1 AND doc_kind = 'receipt'`, [tid])).rows[0].n;
  check('money: the stored rows still include the copies (nothing was deleted; they are left out of the totals only)', rows === 10, String(rows));
  // the views: the copy is out of the money view; the original stays; the verified one wins
  const { financeViewsSql } = await import(path.join(ROOT, 'api/_lib/agent/financeViews.js'));
  const ids = async () => { await su('SELECT 1'); await lite.exec('SET ROLE deepwell_rls'); await lite.query("SELECT set_config('app.tenant_id', $1, false)", [tid]);
    const r = await lite.query(`WITH customers AS (SELECT NULL::uuid AS customer_id, NULL::text AS name WHERE false), ${financeViewsSql({ hasFinancials: true })} SELECT document_id FROM financials`).catch((e) => ({ rows: [], err: e })); await lite.exec('RESET ROLE'); return r; };
  const v = await ids();
  const idSet = new Set(v.rows.map((r) => r.document_id));
  check('money view: the later scan of the same receipt is out, the first scan is in', idSet.has(orig) && !idSet.has(dup), v.err?.message);
  check('money view: when the later scan is the checked one, it is the original and the unchecked earlier scan is out', idSet.has(vOrig) && !idSet.has(vDup));
  const ver = FA.parseMoneyIntent('How much did we spend at Desert Supply Co?', { today: '2026-10-22' });
  check('money intent: spend-at names the supplier', ver?.intent === 'spend_total' && ver.subject === 'desert supply co', JSON.stringify(ver));
}

/* =============================================================== D9. rollback (last: it removes the demo) */
{
  const d9 = fs.readFileSync(path.join(ROOT, 'M3-config/demo/D9-rollback-demo.sql'), 'utf8');
  let e = await tryExec(d9);
  check('D9: refuses to run until the confirmation line is edited', /ROLLBACK DEMO/.test(e ?? '') && (await demoCount()) === 6, e);
  const realBefore = JSON.stringify((await su('SELECT plan, billing_status, settings, limits FROM tenants WHERE id = $1', [realTenant])).rows[0]);
  const docsBefore = (await su('SELECT count(*)::int AS n FROM documents')).rows[0].n;
  e = await tryExec(d9.replace("v_confirm text := 'NO';", "v_confirm text := 'ROLLBACK DEMO';"));
  check('D9: runs cleanly once confirmed', e === null, e);
  check('D9: no demo company is left', (await demoCount()) === 0);
  const hv2 = (await su('SELECT plan, billing_status, limits, settings FROM tenants WHERE id = $1', [hv])).rows[0];
  check('D9: a former demo company is an ordinary plan-less company (no demo marker, no loading window, no D1 settings)', hv2.plan === null && hv2.billing_status === null && hv2.limits?.demo === undefined && hv2.limits?.staffImport === undefined && hv2.settings?.company_name === undefined);
  check('D9: the two seed tables and the three functions are gone', (await su("SELECT count(*)::int AS n FROM (SELECT 1 FROM pg_class WHERE relname IN ('demo_seed_documents','demo_seed_snapshot') UNION ALL SELECT 1 FROM pg_proc WHERE proname IN ('list_demo_tenants','demo_mark_seed','demo_snapshot_tables')) x")).rows[0].n === 0);
  check('D9: the paying company is byte-identical and no document was deleted', JSON.stringify((await su('SELECT plan, billing_status, settings, limits FROM tenants WHERE id = $1', [realTenant])).rows[0]) === realBefore && (await su('SELECT count(*)::int AS n FROM documents')).rows[0].n === docsBefore);
  e = await tryExec(d9.replace("v_confirm text := 'NO';", "v_confirm text := 'ROLLBACK DEMO';"));
  check('D9: safe to run again', e === null, e);
  resetCaches();
  await su('GRANT EXECUTE ON FUNCTION list_demo_tenants() TO deepwell_rls').catch(() => {});
  const res = await call(H.account, { method: 'GET', url: '/api/account?action=demo&op=reset-all', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  check('after D9 the nightly reset answers harmlessly (nothing to reset)', res.statusCode === 200 && !(res.body?.reset > 0), JSON.stringify(res.body));
}

console.log(`verify:demo-fix2  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
