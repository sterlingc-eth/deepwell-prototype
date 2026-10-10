/**
 * R30 AUDIT FIXES - one regression check per finding (H1, H2, M1-M11, L1-L6) plus the test-infra fixes.
 *
 * Runs against a REAL Postgres (PGlite, loaded from M3-config) with signed Stripe events posted through the real
 * webhook handler; no network, no real Stripe/Clerk/R2/Neon.  Needs tsx (it imports api/records.ts):
 *     npx tsx scripts/verify-r30-audit-fixes.mjs          (npm run verify:r30-audit-fixes)
 */
for (const k of ['STRIPE_SECRET_KEY', 'CLERK_SECRET_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_r30_fixture';
process.env.NEON_CONNECTION_STRING = 'postgres://fixture_user:fixture_pw@db.fixture.invalid:5432/fixture?sslmode=require&channel_binding=require';
process.env.DEEPWELL_FOUNDER_TENANT_ID = 'org_founder_fixture';
delete process.env.DEEPWELL_OPERATOR_USER_IDS;
delete process.env.TENANT_DEFAULT_TZ;
delete process.env.NOTIFY_SWEEP_MAX_TENANTS;
Object.assign(process.env, { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAFIXTURE', R2_SECRET_ACCESS_KEY: 'secretfixture', R2_BUCKET_NAME: 'fixture-bucket' });

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const quiet = async (fn) => { const o = console.error; const l = console.log; console.error = () => {}; try { return await fn(); } finally { console.error = o; void l; } };
const mkRes = () => {
  const r = { statusCode: 0, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, end() { return r; } };
  return r;
};

/* ============================================================ env guard (verify scripts never load .env.local) */
{
  const { shouldLoadEnvLocal } = await import('../api/_lib/util/envGuard.js');
  check('envGuard: normal dev server run loads .env.local', shouldLoadEnvLocal({ env: {}, argv: ['node', '/repo/dev.js'] }) === true);
  check('envGuard: scripts/verify-*.mjs never loads it', shouldLoadEnvLocal({ env: {}, argv: ['node', '/repo/scripts/verify-billing.mjs'] }) === false);
  check('envGuard: scripts/verify-*.ts (tsx) never loads it', shouldLoadEnvLocal({ env: {}, argv: ['node', '/repo/scripts/verify-ui.ts'] }) === false);
  check('envGuard: npm run verify:* never loads it', shouldLoadEnvLocal({ env: { npm_lifecycle_event: 'verify:auth' }, argv: ['node', 'x.js'] }) === false);
  check('envGuard: on Vercel never loads it', shouldLoadEnvLocal({ env: { VERCEL: '1' }, argv: ['node', 'x.js'] }) === false);
  check('envGuard: DEEPWELL_SKIP_ENV_LOCAL=1 wins', shouldLoadEnvLocal({ env: { DEEPWELL_SKIP_ENV_LOCAL: '1' }, argv: ['node', 'x.js'] }) === false);
  check('envGuard: DEEPWELL_LOAD_ENV_LOCAL=1 opts a verify script back in (live tests)', shouldLoadEnvLocal({ env: { DEEPWELL_LOAD_ENV_LOCAL: '1' }, argv: ['node', '/repo/scripts/verify-x.mjs'] }) === true);
  check('claude.js consults the guard before reading .env.local', /if \(!shouldLoadEnvLocal\(\)\) return null;/.test(read('api/_lib/claude.js')));
  check('verify:ui runs through the css stub loader', /verify:ui": "tsx --import \.\/scripts\/lib\/register-css-stub\.mjs scripts\/verify-ui\.ts"/.test(read('package.json')));
  check('NAV lives in a css-free module (verify-ui imports it from there)', /from '\.\.\/src\/components\/nav'/.test(read('scripts/verify-ui.ts')) && !/^\s*import\s.*\.css/m.test(read('src/components/nav.ts')));
}

/* ============================================================ H1: keys, prefixes */
const R2 = await import('../api/_lib/r2.js');
const TA = '11111111-1111-4111-8111-111111111111';
const TB = '22222222-2222-4222-8222-222222222222';
{
  const { keyBelongsToTenant: kb } = R2;
  check('H1 keyBelongsToTenant: own key ok', kb(`${TA}/ab/abcdef.pdf`, TA));
  check('H1 keyBelongsToTenant: another tenant\'s key refused', !kb(`${TB}/ab/abcdef.pdf`, TA));
  check('H1 keyBelongsToTenant: prefix-only / no separator / traversal / backslash / control chars refused',
    !kb(`${TA}/`, TA) && !kb(`${TA}x/a`, TA) && !kb(`${TA}/../${TB}/a`, TA) && !kb(`${TA}/a/./b`, TA) && !kb(`${TA}//a`, TA) && !kb(`${TA}/a\\b`, TA) && !kb(`${TA}/a\u0000b`, TA));
  check('H1 keyBelongsToTenant: non-strings refused', !kb(null, TA) && !kb(undefined, TA) && !kb(42, TA) && !kb(`${TA}/a`, ''));
  let e; try { R2.assertKeyInTenant(`${TB}/x/y`, TA); } catch (x) { e = x; }
  check('H1 assertKeyInTenant throws R2Error 403 for a foreign key', e?.status === 403 && e instanceof R2.R2Error);
  check('H1 objectKey (the only key builder) is always under the tenant prefix', R2.keyBelongsToTenant(R2.objectKey(TA, 'a'.repeat(64), 'My File.pdf'), TA));

  // Every place a stored key reaches R2 re-checks the tenant prefix.
  check('H1 readDocument asserts the key belongs to the document\'s tenant', /keyBelongsToTenant\(doc\.storage_key, doc\.tenant_id\)/.test(read('api/_lib/readDocument.js')));
  check('H1 viewPage (agent) asserts the key, and has no unchecked default fetcher', /keyBelongsToTenant|assertKeyInTenant/.test(read('api/_lib/agent/viewPage.js')));
  check('H1 upload-url get-original refuses a foreign key', /keyBelongsToTenant|assertKeyInTenant/.test(read('api/upload-url.js')));
  check('H1 document-delete only deletes objects under the tenant prefix', /keyBelongsToTenant|assertKeyInTenant/.test(read('api/_lib/routes/document-delete.js')));
  check('H1 tenant-delete only deletes objects under the tenant prefix', /keyBelongsToTenant|assertKeyInTenant/.test(read('api/_lib/routes/tenant-delete.js')));
}

/* ============================================================ PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}
const cfgDir = path.join(ROOT, 'M3-config');
const lite = new PGlite({ extensions: contrib });
const notes = [];
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* harness quirk */ }
check('harness: core migrations loaded', !notes.some((n) => /^(14|24|27|59)-/.test(n)), notes.join(' | '));

const pgMod = (await import('pg')).default;
{
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}

const RS = await import('../api/_lib/recordsStore.js');
const PLAN = await import('../api/_lib/plan.js');
const RL = await import('../api/_lib/rateLimit.js');
const BL = await import('../api/_lib/billing.js');
const BILL = await import('../api/billing.js');
const RECORDS = await import('../api/records.ts');

const newTenant = async (key, sql = '', params = []) => {
  const ctx = await RS.getTenantContext(key, key);
  if (sql) await lite.query(sql.replace('$T', '$1'), [ctx.id, ...params]);
  RS._resetTenantContextCache?.();
  PLAN._resetBillingRowCache?.();
  return ctx.id;
};

/* ============================================================ H1: /api/records createDocument */
{
  const idA = await newTenant('org_r30_a', `UPDATE tenants SET billing_status='active', plan='solo' WHERE id = $T`);
  const idB = await newTenant('org_r30_b', `UPDATE tenants SET billing_status='active', plan='solo' WHERE id = $T`);
  const victimKey = `${idB}/aa/${'b'.repeat(64)}.pdf`;
  const member = { userId: 'user_member_a', tenantId: 'org_r30_a', orgId: 'org_r30_a', orgRole: 'member' };
  const doc = (over = {}) => ({ action: 'createDocument', original_filename: 'x.pdf', sha256_hash: crypto.randomBytes(32).toString('hex'), file_size_bytes: 1000, content_type: 'application/pdf', ...over });
  const call = async (auth, body) => { const res = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, auth)); return res; };

  const hash = 'c'.repeat(64);
  let res = await call(member, doc({ sha256_hash: hash, storage_key: victimKey, stage: 'mapped', uploaded_by: 'someone_else', tenant_id: idB }));
  check('H1 records.createDocument with a foreign storage_key succeeds without it (200)', res.statusCode === 0 || res.statusCode === 200, JSON.stringify(res.body));
  const row = (await lite.query(`SELECT tenant_id, storage_key, stage, uploaded_by FROM documents WHERE sha256_hash = $1`, [hash])).rows[0];
  check('H1 the row is in the caller\'s tenant, storage_key NOT taken from the client', row?.tenant_id === idA && row?.storage_key == null, JSON.stringify(row));
  check('H1 stage forced to received, uploaded_by is the token user (not the payload)', row?.stage === 'received' && row?.uploaded_by === 'user_member_a', JSON.stringify(row));
  eq('H1 nothing was written into the victim tenant', (await lite.query(`SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1`, [idB])).rows[0].n, 0);

  // Store-level defence in depth (a future caller that forgets to strip).
  let err;
  await RS.withTenant({ tenantKey: 'org_r30_a', tenantName: 'a' }, (db) => db.createDocument({ original_filename: 'y.pdf', sha256_hash: 'd'.repeat(64), storage_key: victimKey })).catch((e) => { err = e; });
  check('H1 store.createDocument itself rejects a foreign key (400)', err?.status === 400, String(err?.message));
  let ok;
  await RS.withTenant({ tenantKey: 'org_r30_a', tenantName: 'a' }, (db) => db.createDocument({ original_filename: 'y.pdf', sha256_hash: 'e'.repeat(64), storage_key: `${idA}/ee/${'e'.repeat(64)}.pdf` })).then((r) => { ok = r; });
  check('H1 store.createDocument accepts the tenant\'s own key', Boolean(ok?.id));

  // Billing gate: a tenant with no subscription cannot create documents through this path any more.
  await newTenant('org_r30_nosub');
  res = await call({ userId: 'u', tenantId: 'org_r30_nosub', orgId: 'org_r30_nosub', orgRole: 'member' }, doc());
  check('H1 records.createDocument applies the billing gate (402 when not subscribed)', res.statusCode === 402, `${res.statusCode} ${JSON.stringify(res.body)}`);

  // Rate limit: same ingest bucket as /api/upload-url.
  await newTenant('org_r30_rl', `UPDATE tenants SET billing_status='active', plan='solo', limits = '{"ingest":{"perMinute":1,"perDay":1000}}'::jsonb WHERE id = $T`);
  const rlAuth = { userId: 'u', tenantId: 'org_r30_rl', orgId: 'org_r30_rl', orgRole: 'member' };
  const r1 = await call(rlAuth, doc());
  const r2 = await call(rlAuth, doc());
  check('H1 records.createDocument is rate limited on the ingest bucket (2nd call 429)', (r1.statusCode === 0 || r1.statusCode === 200) && r2.statusCode === 429, `${r1.statusCode} / ${r2.statusCode}`);
}

/* ============================================================ L2: records action allowlist */
{
  const { recordsActionAccess: acc, RECORDS_READ_ACTIONS, RECORDS_MEMBER_WRITE_ACTIONS, RECORDS_ADMIN_ACTIONS } = RECORDS;
  const member = { orgId: 'o', orgRole: 'member' }, admin = { orgId: 'o', orgRole: 'admin' }, solo = { orgId: null, orgRole: null };
  eq('L2 member: reads + createDocument ok', [...RECORDS_READ_ACTIONS, ...RECORDS_MEMBER_WRITE_ACTIONS].map((a) => acc(a, member)).every((v) => v === 'ok'), true);
  eq('L2 member: every write/audit action forbidden', [...RECORDS_ADMIN_ACTIONS].map((a) => acc(a, member)).every((v) => v === 'forbidden'), true);
  eq('L2 org admin: everything ok', [...RECORDS_READ_ACTIONS, ...RECORDS_MEMBER_WRITE_ACTIONS, ...RECORDS_ADMIN_ACTIONS].map((a) => acc(a, admin)).every((v) => v === 'ok'), true);
  eq('L2 solo user (no org) is its own admin', [...RECORDS_ADMIN_ACTIONS].map((a) => acc(a, solo)).every((v) => v === 'ok'), true);
  eq('L2 unknown action -> unknown', [acc('dropTable', admin), acc('', admin)], ['unknown', 'unknown']);
  check('L2 every action the switch handles is classified (no unclassified case)', (() => {
    const cases = [...read('api/records.ts').matchAll(/case '(\w+)'/g)].map((m) => m[1]);
    const all = new Set([...RECORDS_READ_ACTIONS, ...RECORDS_MEMBER_WRITE_ACTIONS, ...RECORDS_ADMIN_ACTIONS]);
    return cases.every((c) => all.has(c)) && [...all].every((c) => cases.includes(c));
  })());
  // The UI: nothing in src/ (outside the two store files) calls a write/audit action, so members lose nothing.
  const used = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !/services\/(postgresRecordsStore|recordsStoreClient)\.ts$/.test(p)) { const s = fs.readFileSync(p, 'utf8'); for (const a of RECORDS_ADMIN_ACTIONS) if (new RegExp(`\\.${a}\\(|action:\\s*['"]${a}['"]`).test(s)) used.add(a); } } };
  walk(path.join(ROOT, 'src'));
  // Company Files: the "who can open People and HR" setting is an admin control (shown only when useCanAdmin() is true).
  const ADMIN_ONLY_UI_ACTIONS = new Set(['setCompanyFilesHrAccess']);
  eq('L2 no UI code calls an admin-only records action (members unaffected)', [...used].filter((a) => !ADMIN_ONLY_UI_ACTIONS.has(a)), []);
  const res = mkRes();
  await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: { action: 'logAction', action_name: 'x' } }, res, { userId: 'u', tenantId: 'org_r30_a', orgId: 'org_r30_a', orgRole: 'member' }));
  check('L2 processRecords: a member calling logAction gets 403 before any DB work', res.statusCode === 403);
  const res2 = mkRes();
  await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: { action: 'logAction', action: 'logAction' } }, res2, { userId: 'u', tenantId: 'org_r30_a', orgId: 'org_r30_a', orgRole: 'admin' }));
  check('L2 processRecords: client audit rows are namespaced client.* (source guard)', /client\.\$\{a\}/.test(read('api/records.ts')));
}

/* ============================================================ H2: per-bucket daily counters */
{
  const tid = await newTenant('org_r30_h2');
  const auth = { tenantId: 'org_r30_h2' };
  const go = async (bucket, overrides) => { const res = mkRes(); const ok = await quiet(() => RL.limit({ headers: {} }, res, auth, bucket, overrides)); return { ok, res }; };
  // Spend 100 "ask" requests: with the old shared counter the billing bucket (perDay 60) would now be locked out.
  for (let i = 0; i < 100; i++) await go('ask', { perMinute: 100000, perDay: 100000 });
  const b = await go('billing', { perMinute: 100000 });
  check('H2 100 unrelated ask requests do not consume the billing bucket\'s daily allowance', b.ok === true && b.res.statusCode === 0, `${b.res.statusCode} ${JSON.stringify(b.res.body)}`);
  // The bucket's own daily cap still applies, exactly.
  let last;
  for (let i = 0; i < 4; i++) last = await go('read', { perMinute: 100000, perDay: 3 });
  check('H2 a bucket still stops at ITS OWN perDay (4th call over a cap of 3 -> 429 per-day)', last.ok === false && last.res.statusCode === 429 && last.res.body?.scope === 'per-day', JSON.stringify(last.res.body));
  const rows = (await lite.query(`SELECT bucket, units FROM rate_limit_windows WHERE tenant_id = $1 AND bucket LIKE 'day:%' ORDER BY bucket`, [tid])).rows;
  check('H2 daily counters live in rate_limit_windows under day:<bucket> (no new table/column)', rows.some((r) => r.bucket === 'day:ask') && rows.some((r) => r.bucket === 'day:billing') && rows.some((r) => r.bucket === 'day:read'), JSON.stringify(rows));
  // Old-style counters must not block after deploy: a huge legacy usage_counters.requests total for today.
  const tid2 = await newTenant('org_r30_h2b');
  await lite.query(`INSERT INTO usage_counters (tenant_id, day, requests) VALUES ($1, CURRENT_DATE, 999999) ON CONFLICT (tenant_id, day) DO UPDATE SET requests = 999999`, [tid2]);
  const res = mkRes();
  const ok = await quiet(() => RL.limit({ headers: {} }, res, { tenantId: 'org_r30_h2b' }, 'billing', { perMinute: 100000 }));
  check('H2 a legacy usage_counters.requests total (pre-deploy) never blocks a request', ok === true);
  eq('H2 dailyBucketKey / utcDayStartIso', [RL.dailyBucketKey('ask'), RL.utcDayStartIso(Date.UTC(2026, 8, 29, 23, 59))], ['day:ask', '2026-09-29T00:00:00.000Z']);
}

/* ============================================================ M1 / M3: Stripe webhook ordering + past_due grace */
const CUS = 'cus_r30_1';
const billId = await newTenant('org_r30_billing', `UPDATE tenants SET stripe_customer_id = '${CUS}' WHERE id = $T`);
let evtSeq = 0;
async function postEvent(type, object, created, id = `evt_r30_${++evtSeq}`) {
  const payload = JSON.stringify({ id, type, created, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`, 'utf8').digest('hex');
  const req = Readable.from([Buffer.from(payload, 'utf8')]);
  req.method = 'POST'; req.query = { action: 'webhook' }; req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
  const res = mkRes();
  await quiet(() => BILL.default(req, res));
  return { res, id };
}
const trow = async () => (await lite.query(`SELECT plan, billing_status, stripe_subscription_id, limits FROM tenants WHERE id = $1`, [billId])).rows[0];
const meta = async () => (await trow()).limits?._billing ?? {};
const ledger = async (id) => (await lite.query(`SELECT count(*)::int AS n FROM billing_events WHERE id = $1`, [id])).rows[0].n;
const inFuture = (d) => Math.floor(Date.now() / 1000) + d * 86400;
const T0 = Math.floor(Date.now() / 1000) - 10_000;
const sub = (id, over = {}) => ({ id, customer: CUS, status: 'active', current_period_end: inFuture(30), trial_end: null, cancel_at_period_end: false, items: { data: [{ price: { lookup_key: 'solo_monthly', metadata: { plan: 'solo' } } }] }, ...over });
{
  let r = await postEvent('customer.subscription.created', sub('sub_A'), T0);
  let row = await trow();
  check('M1 baseline: subscription.created applies', r.res.body?.handled === true && row.billing_status === 'active' && row.stripe_subscription_id === 'sub_A', JSON.stringify([r.res.body, row.billing_status]));
  eq('M1 ordering state stored in limits._billing (no new column)', [(await meta()).eventAt, (await meta()).subId], [T0, 'sub_A']);
  check('M1 plan limits survive (limits still carries the plan caps)', row.limits && typeof row.limits === 'object');

  r = await postEvent('customer.subscription.updated', sub('sub_A', { status: 'past_due' }), T0 - 500);
  check('M1 a STALE event (older than one already applied) is ignored, ledger row kept', r.res.body?.handled === false && r.res.body?.reason === 'ignored' && (await trow()).billing_status === 'active' && (await ledger(r.id)) === 1, JSON.stringify(r.res.body));

  r = await postEvent('customer.subscription.deleted', { id: 'sub_OLD', customer: CUS, status: 'canceled' }, T0 + 100);
  check('M1 deletion of a DIFFERENT (old) subscription does not cancel the tenant', (await trow()).billing_status === 'active' && r.res.body?.reason === 'ignored');

  r = await postEvent('invoice.payment_failed', { customer: CUS, subscription: 'sub_A', amount_paid: 0 }, T0 + 200);
  check('M3 payment_failed -> past_due, pastDueSince recorded at the event time', (await trow()).billing_status === 'past_due' && (await meta()).pastDueSince === T0 + 200, JSON.stringify(await meta()));
  await postEvent('invoice.payment_failed', { customer: CUS, subscription: 'sub_A' }, T0 + 300);
  eq('M3 a second dunning failure does not restart the grace clock', (await meta()).pastDueSince, T0 + 200);
  await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_A', amount_paid: 2900 }, T0 + 400);
  check('M3 payment clears past_due and the clock', (await trow()).billing_status === 'active' && (await meta()).pastDueSince == null, JSON.stringify(await meta()));

  await postEvent('customer.subscription.deleted', { id: 'sub_A', customer: CUS, status: 'canceled' }, T0 + 500);
  check('M1 the current subscription\'s deletion cancels', (await trow()).billing_status === 'canceled');
  r = await postEvent('invoice.payment_failed', { customer: CUS, subscription: 'sub_A' }, T0 + 600);
  check('M1 a late payment_failed after deletion does NOT resurrect a canceled tenant', (await trow()).billing_status === 'canceled' && r.res.body?.reason === 'ignored');

  await postEvent('customer.subscription.created', sub('sub_B', { status: 'trialing', trial_end: inFuture(14) }), T0 + 700);
  check('M1 a NEW subscription after cancellation is adopted', (await trow()).billing_status === 'trialing' && (await trow()).stripe_subscription_id === 'sub_B');
  r = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_B', amount_paid: 0 }, T0 + 800);
  check('M1 the $0 trial-start invoice does not turn a trial into "active"', (await trow()).billing_status === 'trialing' && r.res.body?.reason === 'ignored');
  await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_B', amount_paid: 2900 }, T0 + 900);
  check('M1 a real payment does (trialing -> active)', (await trow()).billing_status === 'active');

  // Duplicate delivery of the same event id is still a no-op (idempotency ledger untouched by the guard).
  const dup = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_B', amount_paid: 2900 }, T0 + 950, 'evt_r30_dup');
  const dup2 = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_B', amount_paid: 2900 }, T0 + 950, 'evt_r30_dup');
  check('M1 duplicate event id is deduplicated', dup.res.statusCode === 200 && dup2.res.statusCode === 200 && (await ledger('evt_r30_dup')) === 1);
}
{
  // Pure: decideBillingEvent
  const ev = (type, created, obj = {}) => ({ type, created, data: { object: obj } });
  const d = BL.decideBillingEvent({ event: ev('customer.subscription.updated', 50, { id: 's1' }), patch: { billing_status: 'active' }, row: { billing_status: 'active', stripe_subscription_id: 's1', limits: { _billing: { eventAt: 100 } } } });
  eq('M1 decideBillingEvent: created < eventAt -> stale', [d.apply, d.reason], [false, 'stale']);
  const d2 = BL.decideBillingEvent({ event: ev('customer.subscription.updated', 100, { id: 's1' }), patch: { billing_status: 'active' }, row: { billing_status: 'active', stripe_subscription_id: 's1', limits: { _billing: { eventAt: 100 } } } });
  check('M1 decideBillingEvent: equal timestamp (same-second events) still applies', d2.apply === true);
  const d3 = BL.decideBillingEvent({ event: { type: 'checkout.session.completed', data: { object: { subscription: 'zzz' } } }, patch: { stripe_customer_id: 'c' }, row: { stripe_subscription_id: 's1', billing_status: 'active' } });
  check('M1 checkout.session.completed is not order-gated', d3.apply === true);
  const d4 = BL.decideBillingEvent({ event: ev('customer.subscription.updated', 5, { id: 's1' }), patch: { billing_status: 'active' }, row: { billing_status: 'active', stripe_subscription_id: 's1' } });
  check('M1 rows with no _billing yet (pre-deploy tenants) still accept events', d4.apply === true && d4.patch.limits._billing.eventAt === 5);
}
{
  const now = new Date('2026-09-29T12:00:00Z');
  const secs = (dt) => Math.floor(dt.getTime() / 1000);
  const days = (n) => new Date(now.getTime() - n * 86400_000);
  const row = (n, extra = {}) => ({ plan: 'solo', billing_status: 'past_due', current_period_end: new Date(now.getTime() + 25 * 86400_000).toISOString(), limits: { _billing: { pastDueSince: secs(days(n)) } }, ...extra });
  check('M3 renewal failure 3 days ago: still inside grace even though current_period_end is 25 days ahead', PLAN.isPastGrace(row(3), now) === false);
  check('M3 renewal failure 8 days ago: past grace (the old rule waited ~37 days)', PLAN.isPastGrace(row(8), now) === true);
  check('M3 legacy past_due row (no _billing) falls back to the old reference', PLAN.isPastGrace({ plan: 'solo', billing_status: 'past_due', current_period_end: days(9).toISOString() }, now) === true && PLAN.isPastGrace({ plan: 'solo', billing_status: 'past_due', current_period_end: days(2).toISOString() }, now) === false);
  eq('M3 pastDueSinceFor', [PLAN.pastDueSinceFor(row(1))?.toISOString(), PLAN.pastDueSinceFor({})], [days(1).toISOString(), null]);
  eq('M3 gateUpload blocks a past-grace past_due tenant (402)', PLAN.gateUpload(row(8), { documentsStored: 0, pagesThisMonth: 0 }, now).status, 402);
  eq('M3 gateUpload allows a within-grace past_due tenant', PLAN.gateUpload(row(3), { documentsStored: 0, pagesThisMonth: 0 }, now).allowed, true);
}

/* ============================================================ M4: trial-end grace + reconcile */
{
  const now = new Date('2026-09-29T12:00:00Z');
  const trial = (hoursAgo) => ({ plan: 'solo', billing_status: 'trialing', trial_ends_at: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), stripe_customer_id: 'cus_x', stripe_subscription_id: 'sub_x' });
  eq('M4 trial ended 1h ago -> still trialing (conversion lag)', PLAN.planStateFor(trial(1), now), 'trialing');
  eq('M4 trial ended 47h ago -> still trialing', PLAN.planStateFor(trial(47), now), 'trialing');
  eq('M4 trial ended 49h ago -> none', PLAN.planStateFor(trial(49), now), 'none');
  eq('M4 TRIAL_END_GRACE_HOURS is 48', PLAN.TRIAL_END_GRACE_HOURS, 48);
  eq('M4 needsBillingReconcile: expired trial still marked trialing -> ask Stripe', BL.needsBillingReconcile(trial(1), now), true);
  eq('M4 needsBillingReconcile: live trial with subscription -> no', BL.needsBillingReconcile({ ...trial(0), trial_ends_at: new Date(now.getTime() + 86400_000).toISOString() }, now), false);
}

/* ============================================================ M2: checkout vs live subscription */
{
  const f = BILL.checkoutBlockedByLiveSubscription;
  check('M2 checkout blocked for active / trialing / past_due subscribers', ['active', 'trialing', 'past_due'].every((s) => f('shop', { billing_status: s, trial_ends_at: new Date(Date.now() + 86400_000).toISOString() }) === true));
  check('M2 checkout allowed for none / canceled', f('shop', { billing_status: 'none' }) === false && f('shop', { billing_status: 'canceled' }) === false);
  check('M2 records_rescue (one-time) is never blocked', f('records_rescue', { billing_status: 'active' }) === false);
  const src = read('api/billing.js');
  check('M2 handleCheckout answers with a portal URL or a 409, and parses the body safely', /portal: true/.test(src) && /409/.test(src) && /readJsonBody/.test(src));
}

/* ============================================================ M5: upload size */
{
  const now = new Date('2026-09-29T00:00:00Z');
  const withLen = R2.presign('PUT', `${TA}/aa/x.pdf`, 900, {}, now, { contentLength: 1234 });
  const noLen = R2.presign('PUT', `${TA}/aa/x.pdf`, 900, {}, now);
  check('M5 PUT presign signs content-length when the client declared a size', /X-Amz-SignedHeaders=content-length%3Bhost/.test(withLen));
  check('M5 without a size the URL is the previous host-only signature (compatible)', /X-Amz-SignedHeaders=host(&|$)/.test(noLen));
  check('M5 a different declared size gives a different signature', withLen !== R2.presign('PUT', `${TA}/aa/x.pdf`, 900, {}, now, { contentLength: 1235 }));
  check('M5 GET presign ignores contentLength', R2.presign('GET', `${TA}/aa/x.pdf`, 900, {}, now, { contentLength: 5 }) === R2.presign('GET', `${TA}/aa/x.pdf`, 900, {}, now));
  check('M5 upload-url requires an integer sizeBytes when present and passes it to the signer', /contentLength: sizeBytes/.test(read('api/upload-url.js')));

  const realFetch = globalThis.fetch;
  const mk = (bytes, headerLen) => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' && headerLen != null ? String(headerLen) : null) }, body: new Response(bytes).body, arrayBuffer: async () => new Uint8Array(bytes).buffer });
  try {
    globalThis.fetch = async () => mk(new Uint8Array(100), 100);
    eq('M5 getObject under the cap returns the bytes', (await R2.getObject('k/a', { maxBytes: 1000 })).length, 100);
    globalThis.fetch = async () => mk(new Uint8Array(10), 5_000_000_000);
    let e; await R2.getObject('k/a').catch((x) => { e = x; });
    check('M5 getObject refuses on a declared Content-Length over the cap (413, before reading)', e?.status === 413, String(e?.message));
    globalThis.fetch = async () => mk(new Uint8Array(5000), null);
    e = undefined; await R2.getObject('k/a', { maxBytes: 1000 }).catch((x) => { e = x; });
    check('M5 getObject cuts off a body with no/lying length header while streaming (413)', e?.status === 413, String(e?.message));
  } finally { globalThis.fetch = realFetch; }
  eq('M5 MAX_OBJECT_BYTES is 25 MiB', R2.MAX_OBJECT_BYTES, 25 * 1024 * 1024);
  const Q = await import('../api/_lib/queue.js');
  check('M5 an oversize object is fatal (not retried) in the ingest worker', Q.fatal(new R2.R2Error('big', 413)) === true);
}

/* ============================================================ M6: pending pages count toward the cap */
{
  const id = await newTenant('org_r30_m6', `UPDATE tenants SET billing_status='active', plan='solo' WHERE id = $T`);
  const ins = (name, type, size, extra = '') => lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, stage, created_at ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1,$2,$3,$4,$5,'received', NOW() ${extra ? ', ' + extra.split('=')[1] : ''})`, [id, name, crypto.randomBytes(16).toString('hex'), size, type]);
  await ins('a.jpg', 'image/jpeg', 3_000_000);
  await ins('b.pdf', 'application/pdf', 2_048_000); // 10 pages
  await ins('c.txt', 'text/plain', 12_000);          // 2 pages
  await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, stage, created_at) VALUES ($1,'old.pdf',$2,2048000,'application/pdf','received', NOW() - INTERVAL '3 days')`, [id, crypto.randomBytes(16).toString('hex')]);
  const n = await RS.withTenant({ tenantKey: 'org_r30_m6', tenantName: 'm6' }, (db) => db.estimatePendingPages());
  eq('M6 estimatePendingPages: image 1 + pdf 10 + text 2 (a stale 3-day-old doc is ignored)', n, 13);
  const row = { plan: 'solo', billing_status: 'active' };
  const g = PLAN.gateUpload(row, { documentsStored: 3, pagesThisMonth: 700, pendingPages: 60 });
  check('M6 700 read + 60 queued >= 750 cap -> 402 with a clear message', g.allowed === false && g.status === 402 && /still being processed/.test(g.error), JSON.stringify(g));
  check('M6 700 read + 30 queued is fine', PLAN.gateUpload(row, { documentsStored: 3, pagesThisMonth: 700, pendingPages: 30 }).allowed === true);
  check('M6 without pendingPages the old behaviour is unchanged', PLAN.gateUpload(row, { documentsStored: 3, pagesThisMonth: 700 }).allowed === true && PLAN.gateUpload(row, { documentsStored: 3, pagesThisMonth: 750 }).error.includes('Monthly page limit reached (750)'));
}

/* ============================================================ M7: Inngest event ids */
{
  const Q = await import('../api/_lib/queue.js');
  eq('M7 default event id is stable (dedupe kept for bulk imports / double clicks)', [Q.eventIdFor('read', 'd1'), Q.eventIdFor('extract', 'd1')], ['read-d1', 'extract-d1']);
  eq('M7 an explicit re-queue carries a nonce', Q.eventIdFor('read', 'd1', 'k9x'), 'read-d1-k9x');
  const now = Date.now();
  check('M7 shouldRequeue: explicit -> yes; failed doc -> yes', Q.shouldRequeue({}, { explicit: true, now }) && Q.shouldRequeue({ extract_error: 'boom' }, { now }));
  check('M7 shouldRequeue: fresh unread doc (run in flight) -> no', !Q.shouldRequeue({ page_count: 0, created_at: new Date(now - 60_000).toISOString() }, { now }));
  check('M7 shouldRequeue: unread for > 10 min -> yes; already has pages -> no', Q.shouldRequeue({ page_count: 0, created_at: new Date(now - 3600_000).toISOString() }, { now }) && !Q.shouldRequeue({ page_count: 3, created_at: new Date(now - 3600_000).toISOString() }, { now }));
  check('M7 the extract event id honours the nonce', /eventIdFor\("extract", documentId, nonce/.test(read('api/_lib/queue.js')));
  check('M7 read-document passes a nonce only for a re-queue', /requeueNonce/.test(read('api/read-document.js')) && /shouldRequeue/.test(read('api/read-document.js')));
}

/* ============================================================ M8: digest email is not lost */
const N = await import('../api/_lib/notify.js');
{
  const item = (u, tier = 'expiring-30') => ({ unitId: u, tier, serial: 'S' + u, brand: 'B', model: 'M', customer: 'C', address: 'A', expires: '2026-10-20', daysLeft: 21 });
  const merged = N.mergePendingDigest([{ ...item('u1'), queuedAt: 1 }], [item('u1'), item('u2')], 1000);
  eq('M8 mergePendingDigest de-duplicates by (unit, tier)', merged.map((m) => m.unitId).sort(), ['u1', 'u2']);
  check('M8 readPendingDigest drops entries older than the TTL', N.readPendingDigest({ digestPending: [{ ...item('u1'), queuedAt: 0 }, { ...item('u2'), queuedAt: Date.now() }] }).length === 1);

  // Drive the real per-tenant flow with the store/E-mail/Clerk seams.
  const tenantId = await newTenant('org_r30_notify');
  const tenant = (settings = {}) => ({ tenant_id: tenantId, tenant_key: 'org_r30_notify', tenant_name: 'Notify Shop', settings });
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type) VALUES ('33333333-3333-4333-8333-333333333333', $1, 'equipment')`, [tenantId]);
  const items = [{ unitId: '33333333-3333-4333-8333-333333333333', tier: 'expiring-30', serial: 'S1', brand: 'Trane', model: 'X', customer: 'Bob', address: '1 Main', expires: '2026-10-20', daysLeft: 21 }];
  let saved = null, sends = 0, sendOk = false, recips = { emails: ['owner@example.com'], ok: true };
  const deps = () => ({ computeItems: async () => items, getRecipients: async () => recips, send: async () => { sends++; return sendOk ? { sent: true, channel: 'email' } : { sent: false, channel: 'email', error: 'provider 500' }; }, savePending: async (_t, list) => { saved = list; } });
  const sentMark = async () => (await lite.query(`SELECT settings->>'lastDigestSentAt' AS t FROM tenants WHERE id = $1`, [tenantId])).rows[0].t;

  sendOk = false;
  let r = await quiet(() => N.runWarrantyNotificationSweepForTenant(tenant(), '2026-09-29', deps()));
  check('M8 failed send: item stays pending, digest NOT marked sent', r.emailed === false && r.emailSkippedReason === 'send-failed' && saved?.length === 1 && (await sentMark()) == null, JSON.stringify([r, saved]));
  // Next sweep: the in-app row exists so nothing is "new", but the pending item is retried and succeeds.
  sendOk = true;
  const pendingSettings = { digestPending: saved };
  r = await quiet(() => N.runWarrantyNotificationSweepForTenant(tenant(pendingSettings), '2026-09-30', deps()));
  check('M8 next sweep retries the pending item and the send succeeds', r.emailed === true && r.newlyNotified === 0 && sends === 2, JSON.stringify(r));
  check('M8 only after a successful send: pending cleared and digest marked sent', Array.isArray(saved) && saved.length === 0 && (await sentMark()) != null);
  // Clerk down: not "no recipients" - keep pending, do not send.
  saved = null; sends = 0; recips = { emails: [], ok: false };
  r = await quiet(() => N.runWarrantyNotificationSweepForTenant(tenant({ digestPending: [{ ...items[0], queuedAt: Date.now() }] }), '2026-10-01', deps()));
  check('M8 recipients lookup failed (Clerk down): keep pending, no send', r.emailSkippedReason === 'recipients-unavailable' && sends === 0 && saved?.length === 1, JSON.stringify(r));

  // Recipients: pagination beyond 100 + failure reporting.
  const mem = (i, role = 'org:admin') => ({ role, publicUserData: { userId: `u${i}`, identifier: `a${i}@x.com` } });
  const pages = { 0: Array.from({ length: 100 }, (_, i) => mem(i, 'org:member')), 100: [mem(100), mem(101)] };
  const fake = { organizations: { getOrganizationMembershipList: async ({ offset }) => ({ data: pages[offset] ?? [] }) } };
  const d = await N.getOrgAdminEmailsDetailed('org_x', [], { clerk: fake });
  eq('M8/L6 admins beyond the first 100 memberships are found', [d.ok, d.emails.sort()], [true, ['a100@x.com', 'a101@x.com']]);
  const bad = { organizations: { getOrganizationMembershipList: async () => { throw new Error('clerk down'); } } };
  eq('M8 a Clerk failure is reported as ok:false, not as "no admins"', await quiet(() => N.getOrgAdminEmailsDetailed('org_x', [], { clerk: bad })), { emails: [], ok: false });
  eq('M8 getOrgAdminEmails wrapper still returns just addresses', await N.getOrgAdminEmails('org_x', [], { clerk: fake }).then((a) => a.sort()), ['a100@x.com', 'a101@x.com']);
}

/* ============================================================ M9 / M10: today */
{
  const L = await import('../api/_lib/util/localDate.js');
  const now = new Date('2026-09-30T02:30:00Z'); // 7:30pm the previous evening in Mesa AZ
  eq('M10 a Mesa (America/Phoenix, UTC-7) evening is still "today" locally, not tomorrow', L.tenantToday(null, now, {}), '2026-09-29');
  eq('M10 tenant settings.timezone wins', L.tenantToday({ settings: { timezone: 'Pacific/Auckland' } }, now, {}), '2026-09-30');
  eq('M10 TENANT_DEFAULT_TZ env is the next fallback', L.tenantToday(null, now, { TENANT_DEFAULT_TZ: 'Pacific/Auckland' }), '2026-09-30');
  eq('M10 an invalid tenant/env zone falls back to America/Phoenix', L.tenantToday({ settings: { timezone: 'Mars/Base' } }, now, { TENANT_DEFAULT_TZ: 'nope' }), '2026-09-29');
  eq('M9 a valid client date is kept', L.resolveToday('2026-09-15', null, now, {}), '2026-09-15');
  for (const bad of ['garbage', '2026-13-45', '9999-01-01', ' 2026-09-15', '2026-9-5', ['2026-09-15'], { a: 1 }, null, undefined, 20260915, '2026-02-30', 'x'.repeat(5000)]) {
    eq(`M9 resolveToday(${JSON.stringify(bad)?.slice(0, 24)}) falls back to the tenant-local date`, L.resolveToday(bad, null, now, {}), '2026-09-29');
  }
  check('M9 ask.js resolves today through resolveToday', /resolveToday\(today\)/.test(read('api/ask.js')));
  check('M10 warranty-attention defaults to the tenant-local date, not toISOString()', /tenantToday\(/.test(read('api/warranty-attention.js')));
  const { localYmd } = await import('../src/core/localDate.ts');
  const d = new Date(2026, 8, 29, 23, 30); // 11:30pm LOCAL
  eq('M10 client localYmd uses the device\'s local calendar date', localYmd(d), '2026-09-29');
  check('M10 the client screens use localYmd (no toISOString().slice(0,10) for "today")', ['src/services/answerService.claude.ts', 'src/screens/IntakeScreen.tsx', 'src/screens/ExpensesScreen.tsx'].every((f) => /localYmd\(/.test(read(f))));
  check('M10 digest already-sent check is timezone aware', N.alreadySentDigestToday({ lastDigestSentAt: '2026-09-30T02:00:00Z' }, '2026-09-29', 'America/Phoenix') === true && N.alreadySentDigestToday({ lastDigestSentAt: '2026-09-30T02:00:00Z' }, '2026-09-29') === false);
}

/* ============================================================ M11: sweep coverage */
{
  eq('M11 sweepMaxTenants default 200 (was 8), env override, junk ignored', [N.sweepMaxTenants({}), N.sweepMaxTenants({ NOTIFY_SWEEP_MAX_TENANTS: '50' }), N.sweepMaxTenants({ NOTIFY_SWEEP_MAX_TENANTS: 'abc' })], [200, 50, 200]);
  let active = 0, peak = 0; const seen = [];
  const tenants = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  const out = await N.sweepWithDeadline(tenants, { deadlineAt: Date.now() + 60_000, perTenantMs: 1, concurrency: 3, processTenant: async (t) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); seen.push(t.id); active--; } });
  check('M11 30 tenants all visited, at most 3 in flight', out.processed.length === 30 && out.skipped.length === 0 && peak <= 3 && peak > 1, `peak ${peak}`);
  let clock = 0; const seq = [];
  const out2 = await N.sweepWithDeadline(Array.from({ length: 10 }, (_, i) => ({ id: i })), { deadlineAt: 50, perTenantMs: 10, now: () => clock, processTenant: async (t) => { seq.push(t.id); clock += 10; } });
  check('M11 the deadline still bounds the run (rest skipped, not dropped)', out2.processed.length + out2.skipped.length === 10 && out2.skipped.length > 0 && out2.processed.length <= 5);
  const outSeq = await N.sweepWithDeadline([{ id: 1 }, { id: 2 }], { deadlineAt: Date.now() + 1000, perTenantMs: 1, processTenant: async () => {} });
  check('M11 default concurrency 1 keeps the old sequential behaviour', outSeq.processed.length === 2);
  check('M11 cron-sweep declares the real 300s budget', /maxDuration:\s*300/.test(read('api/_lib/routes/cron-sweep.js')));
}

/* ============================================================ L1: platform operator */
{
  const { isPlatformOperator: op } = await import('../api/_lib/missDigest.js');
  const F = 'org_founder_fixture';
  check('L1 a plain MEMBER of the founder shop is not an operator', op({ tenantId: F, orgId: F, orgRole: 'member', userId: 'u1' }) === false);
  check('L1 an ADMIN of the founder shop is', op({ tenantId: F, orgId: F, orgRole: 'admin', userId: 'u1' }) === true);
  check('L1 a solo founder tenant (no org) is its own owner', op({ tenantId: F, userId: 'u1' }) === true);
  check('L1 an API key on the founder tenant is not', op({ tenantId: F, viaKey: true, userId: 'k' }) === false);
  check('L1 another tenant\'s admin is not', op({ tenantId: 'org_other', orgId: 'org_other', orgRole: 'admin', userId: 'u1' }) === false);
  process.env.DEEPWELL_OPERATOR_USER_IDS = 'user_op1, user_op2';
  check('L1 the explicit DEEPWELL_OPERATOR_USER_IDS allowlist still works (even as a member)', op({ tenantId: F, orgId: F, orgRole: 'member', userId: 'user_op2' }) === true && op({ tenantId: 'x', userId: 'user_op1' }) === true);
  delete process.env.DEEPWELL_OPERATOR_USER_IDS;
}

/* ============================================================ L3: scope for original download */
{
  const src = read('api/upload-url.js');
  check('L3 upload-url needs the READ scope to mint a download URL (mode get) and INGEST otherwise', /assertScope\(auth, mode === "get" \? "read" : "ingest"\)/.test(src));
}

/* ============================================================ L4: offline queue */
{
  const UQ = await import('../src/mobile/offline/uploadQueue.ts');
  const { IngestHttpError: Err } = await import('../src/services/ingestClient.ts');
  const e = (status) => new Err(`http ${status}`, status, {});
  eq('L4 402 (choose a plan / page cap) is transient, not permanent', UQ.classifyUploadError(e(402)), 'transient');
  eq('L4 403 is a per-scan failure', UQ.classifyUploadError(e(403)), 'permanent');
  check('L4 a 402 is retried no sooner than 10 minutes', UQ.retryDelayMs(e(402), 1) >= 10 * 60_000 && UQ.retryDelayMs(e(500), 1) < 10 * 60_000);
  eq('L4 401 stays permanent for the item (queue pause is handled in drain)', UQ.classifyUploadError(e(401)), 'permanent');
  const s = read('src/mobile/offline/uploadQueue.ts');
  check('L4 only a 401 pauses the queue as "signed out" (403 no longer does)', /return err instanceof IngestHttpError && err\.status === 401\s*\n\}/.test(s));
}

/* ============================================================ L5: sqlGuard */
{
  const G = await import('../api/_lib/agent/sqlGuard.js');
  const created = new Set();
  for (const f of fs.readdirSync(cfgDir).filter((x) => /\.sql$/.test(x))) for (const m of fs.readFileSync(path.join(cfgDir, f), 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)/gi)) created.add(m[1]);
  const missing = [...created].filter((t) => !G.REAL_TABLES.includes(t));
  eq('L5 every table created in M3-config is in REAL_TABLES', missing, []);
  check('L5 support_public_windows is blocked for agent SQL', G.REAL_TABLES.includes('support_public_windows'));
}

/* ============================================================ L6: misc */
{
  const CL = await import('../api/_lib/claude.js');
  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "u" DETAIL: Key (email)=(secret@customer.com) already exists.'), { name: 'error', code: '23505', table: 'documents', constraint: 'u', detail: 'Key (email)=(secret@customer.com) already exists.', where: 'row (secret)', routine: 'x'.repeat(10) });
  const scrubbed = JSON.stringify(CL.scrubErrorForLog(pgErr));
  check('L6 scrubErrorForLog keeps code/table/constraint but drops pg detail/where row values', /23505/.test(scrubbed) && /documents/.test(scrubbed) && !/detail|where/.test(scrubbed));
  check('L6 scrubErrorForLog message is truncated', JSON.stringify(CL.scrubErrorForLog(Object.assign(new Error('m'.repeat(5000)), { code: '23505' }))).length < 700);
  check('L6 records.ts logs through scrubErrorForLog', /scrubErrorForLog\(err\)/.test(read('api/records.ts')));

  // JSON parse -> 400, not 500 (the handler authenticates first, so this is a source guard on both parse sites).
  const bsrc = read('api/billing.js');
  check('L6 billing.js: checkout parses its body via readJsonBody (400 on garbage); the invite parse was already try/caught',
    /const body = await readJsonBody\(req\);\s*\n\s*if \(body === null\) return res\.status\(400\)/.test(bsrc) && /catch \{\s*\n\s*return res\.status\(400\)\.json\(\{ error: "Invalid request body" \}\)/.test(bsrc));

  // Origins: one shared list.
  const { APP_ORIGINS } = await import('../api/_lib/util/origins.js');
  check('L6 ALLOWED_ORIGINS (CORS) and Clerk authorizedParties share one list', /ALLOWED_ORIGINS = APP_ORIGINS/.test(read('api/_lib/claude.js')) && /\[\.\.\.APP_ORIGINS\]/.test(read('api/_lib/auth.js')) && APP_ORIGINS.includes('https://deepwellinc.vercel.app'));

  // guardedInvite: two admins inviting at once must not both slip under the cap.
  const S = await import('../api/_lib/seats.js');
  const cap = PLAN.PLAN_LIMITS.solo.logins; // 2
  const invitations = [];
  const memberships = [{ role: 'org:admin', createdAt: 1, publicUserData: { userId: 'owner' } }];
  const clerk = {
    organizations: {
      getOrganization: async () => ({ createdBy: 'owner' }),
      getOrganizationMembershipList: async () => ({ data: memberships }),
      getOrganizationInvitationList: async () => { await new Promise((r) => setTimeout(r, 5)); return { data: invitations.map((i) => ({ ...i, status: 'pending' })) }; },
      createOrganizationInvitation: async ({ emailAddress }) => { await new Promise((r) => setTimeout(r, 5)); const inv = { id: 'inv_' + invitations.length, emailAddress }; invitations.push(inv); return inv; },
    },
  };
  for (let i = 0; i < cap - 1; i++) invitations.push({ id: `pre${i}`, emailAddress: `pre${i}@x.com` });
  const results = await quiet(() => Promise.all([S.guardedInvite({ orgId: 'org_seat', plan: 'solo', email: 'a@x.com', clerk }), S.guardedInvite({ orgId: 'org_seat', plan: 'solo', email: 'b@x.com', clerk })]));
  eq('L6 two concurrent invites with ONE seat left: exactly one succeeds, the other gets 402', [results.filter((r) => r.ok).length, results.filter((r) => !r.ok && r.status === 402).length], [1, 1]);
  eq('L6 only one invitation was actually created', invitations.length, cap);
}

if (failures) { console.log(`\n${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`\nAll ${passes} R30 audit-fix checks passed.`);
process.exit(0);
