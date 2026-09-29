/**
 * PRODUCTION HARDENING (2026-09-28 runtime-error round). One check per Vercel log cluster:
 *
 *  #2  Stripe webhook "operator does not exist: boolean > integer" — billing_record_event() (SQL)
 *      compared a boolean to 0. Reproduced against a REAL Postgres (PGlite) loaded from M3-config,
 *      then every handled subscription event type is applied through the real webhook handler.
 *  #1  debounceLinkSweep "could not determine data type of parameter $2".
 *  #3  concurrent client.query on one client (serializeClient).
 *  #4/#6 empty-string uuid (getTenantContext / rateLimit / set_config guard).
 *  #5  ask.js todayResolved ReferenceError (static regression guard).
 *  #7  response watchdog + cron-sweep deadline.
 *  #8  explicit ssl (no pg SECURITY WARNING, same verify-full semantics).
 *  #10 Anthropic 4xx/5xx -> friendly message, never raw JSON.
 *
 * No network, no Anthropic key, no real Stripe/Neon.  node scripts/verify-prod-hardening.mjs
 */
delete process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_prod_hardening_fixture';
process.env.NEON_CONNECTION_STRING = 'postgres://fixture_user:fixture_pw@db.fixture.invalid:5432/fixture?sslmode=require&channel_binding=require';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
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

/* ============================================================ pure: pgClient helpers (#3, #4, #8) */
const PC = await import('../api/_lib/util/pgClient.js');

// #3 — overlapping queries on ONE client must never overlap on the wire.
{
  let active = 0, maxActive = 0;
  const order = [];
  const fake = {
    async query(sql) {
      active++; maxActive = Math.max(maxActive, active);
      order.push(`start:${sql}`);
      await new Promise((r) => setTimeout(r, sql === 'slow' ? 25 : 2));
      order.push(`end:${sql}`);
      active--;
      if (sql === 'boom') throw new Error('boom');
      return { rows: [{ sql }] };
    },
    release() {},
  };
  const c = PC.serializeClient(fake);
  check('serializeClient returns the same client (drop-in)', c === fake);
  const results = await Promise.allSettled([c.query('slow'), c.query('boom'), c.query('fast')]);
  eq('overlapping Promise.all queries run strictly one at a time (max 1 in flight)', maxActive, 1);
  eq('queries run in call order', order, ['start:slow', 'end:slow', 'start:boom', 'end:boom', 'start:fast', 'end:fast']);
  eq('results/rejections still reach the right caller', results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  check('a failed query does not wedge the queue', (await c.query('after')).rows[0].sql === 'after');
  check('re-wrapping a pooled client is a no-op (no double queue)', PC.serializeClient(fake).query === c.query);
}

// #4/#6 — id guards.
{
  for (const bad of ['', '   ', null, undefined, 'not-a-uuid', 42]) {
    let err; try { PC.assertTenantUuid(bad); } catch (e) { err = e; }
    check(`assertTenantUuid(${JSON.stringify(bad)}) throws a 401 NO_TENANT`, err?.status === 401 && err?.code === 'NO_TENANT');
  }
  check('assertTenantUuid passes a real uuid through', PC.assertTenantUuid('123e4567-e89b-42d3-a456-426614174000') === '123e4567-e89b-42d3-a456-426614174000');
  check('isNonBlankId', PC.isNonBlankId('org_1') && !PC.isNonBlankId('') && !PC.isNonBlankId('  ') && !PC.isNonBlankId(null));
}

// #8 — explicit ssl with identical (verify-full) semantics, and no pg warning.
{
  const a = PC.explicitPgSsl('postgres://u:p@h.example/db?sslmode=require&channel_binding=require');
  eq('sslmode=require is dropped from the string, other params kept', a.connectionString, 'postgres://u:p@h.example/db?channel_binding=require');
  eq('...and replaced by an explicit verifying ssl config', a.ssl, { rejectUnauthorized: true });
  const b = PC.explicitPgSsl('postgres://u:p@h.example/db?sslmode=verify-ca');
  eq('sole sslmode param removed cleanly', [b.connectionString, b.ssl?.rejectUnauthorized], ['postgres://u:p@h.example/db', true]);
  for (const cs of ['postgres://u:p@h/db', 'postgres://u:p@h/db?sslmode=disable', 'postgres://u:p@h/db?sslmode=verify-full', 'postgres://u:p@h/db?sslmode=no-verify', 'postgres://u:p@h/db?sslmode=require&uselibpqcompat=true']) {
    const r = PC.explicitPgSsl(cs);
    check(`left untouched: ${cs.replace(/^.*?db/, 'db')}`, r.connectionString === cs && !r.ssl);
  }
  // Prove (in a fresh process, since pg warns once per process) that the raw string warns and the cleaned one does not.
  const { spawnSync } = await import('node:child_process');
  const runProbe = (cs) => {
    const r = spawnSync(process.execPath, ['-e', "require('pg-connection-string').parse(process.argv[1])", cs], { cwd: ROOT, encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`;
  };
  check('(control) the raw sslmode=require string makes pg-connection-string print the SECURITY WARNING', /SECURITY WARNING/.test(runProbe('postgres://u:p@h.example/db?sslmode=require')));
  check('cleaned connection string parses with NO ssl-mode security warning', !/SECURITY WARNING/.test(runProbe(a.connectionString)));
}

/* ============================================================ pure: provider error messages (#10) */
const CL = await import('../api/_lib/claude.js');
{
  const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_011CXYZ"}';
  const credit = Object.assign(new Error(raw), { name: 'BadRequestError', status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
  const overloaded = Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { name: 'APIError', status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } });
  const server500 = Object.assign(new Error('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_1"}'), { name: 'InternalServerError', status: 500, error: { type: 'api_error', message: 'Internal server error' } });
  const bad400 = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}'), { name: 'BadRequestError', status: 400, error: { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' } });
  const rate = Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}'), { name: 'RateLimitError', status: 429, error: { type: 'rate_limit_error', message: 'rate limited' } });
  const conn = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
  const ownPgError = Object.assign(new Error('duplicate key'), { code: '23505', status: 500 });
  const ownReviewError = Object.assign(new Error('bad input'), { name: 'ReviewError', status: 400 });

  const mkRes = () => {
    const r = { statusCode: 0, body: null, headers: {}, headersSent: false };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };
  const origErr = console.error; console.error = () => {};
  try {
    for (const [name, err, wantStatus] of [['credits 400', credit, 503], ['overloaded 529', overloaded, 503], ['api 500', server500, 503], ['non-credit 400', bad400, 503], ['429 rate limit', rate, 429], ['connection error', conn, 503]]) {
      const res = mkRes();
      await CL.handleError(res, err, { url: '/api/ask' });
      const text = JSON.stringify(res.body);
      check(`ask/handleError: ${name} -> ${wantStatus}, friendly text, no raw JSON / request id`, res.statusCode === wantStatus && !/[{]"type"|req_0|invalid_request_error|"error":\{/.test(String(res.body?.error ?? '') + String(res.body?.details ?? '')) && typeof res.body?.error === 'string' && text.length < 400, `${res.statusCode} ${text}`);
    }
    CL.resetProviderOutageForTests();
    const res500 = mkRes();
    await CL.handleError(res500, server500, { url: '/api/ask' });
    check('a single provider 500 does NOT flip the process-wide outage flag', CL.getProviderOutage() === null);
    const resOwn = mkRes();
    await CL.handleError(resOwn, ownPgError, { url: '/x' });
    check('our own (non-Anthropic) 500 keeps the generic handler', resOwn.statusCode === 500 && resOwn.body?.error === 'Processing failed');
    check('isAnthropicApiError ignores our own errors', !CL.isAnthropicApiError(ownPgError) && !CL.isAnthropicApiError(ownReviewError));
  } finally { console.error = origErr; }
  check('providerFailureMessage: credits -> plain text, honest (says unavailable), no JSON', /temporarily unavailable/.test(CL.providerFailureMessage(credit)) && !/[{]/.test(CL.providerFailureMessage(credit)));
  eq('providerFailureMessage: not a provider error -> null (caller keeps its own message)', CL.providerFailureMessage(ownPgError), null);
  // Non-ask code paths: the stored document.error the UI shows must not be the SDK's raw JSON.
  check('recordIngestFailure stores the friendly text, not error.message', /providerFailureMessage\(error\) \?\? String\(error\?\.message/.test(read('api/_lib/readDocument.js')));
  check('streaming ask error event uses providerFailureMessage', /providerFailureMessage\(error\) \?\? "Something went wrong answering that\."/.test(read('api/ask.js')));
}

/* ============================================================ #5 ask.js todayResolved regression guard */
{
  const ask = read('api/ask.js');
  const sendFn = ask.slice(ask.indexOf('const send = (status, body) => {'), ask.indexOf('const send = (status, body) => {') + 1400);
  check('#5 send() closure uses claimsToday (declared in handler scope), not the block-scoped todayResolved', /claimsToday \?\? new Date/.test(sendFn) && !/today: todayResolved/.test(sendFn));
  check('#5 claimsToday is declared before send()', ask.indexOf('let claimsToday = null;') > 0 && ask.indexOf('let claimsToday = null;') < ask.indexOf('const send = (status, body) => {'));
}

/* ============================================================ #7 response watchdog (pure) */
{
  const DL = await import('../api/_lib/util/deadline.js');
  const mk = () => {
    const r = new EventEmitter();
    r.headersSent = false; r.writableEnded = false; r.statusCode = 0; r.body = null; r.written = [];
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; };
    r.write = (s) => { r.written.push(s); return true; };
    r.end = () => { r.writableEnded = true; return r; };
    return r;
  };
  const r1 = mk();
  DL.armResponseDeadline(r1, 20);
  await new Promise((r) => setTimeout(r, 60));
  check('watchdog: unanswered request gets a 504 with an honest message', r1.statusCode === 504 && r1.body?.code === 'timeout' && /longer than expected/.test(r1.body.error));
  let threw = false; try { r1.status(200).json({ late: true }); r1.setHeader('x', 'y'); } catch { threw = true; }
  check('watchdog: late writes from the still-running handler are harmless no-ops', !threw && r1.body?.late === undefined);

  const r2 = mk();
  DL.armResponseDeadline(r2, 20);
  r2.emit('finish');
  await new Promise((r) => setTimeout(r, 60));
  check('watchdog: a request that finishes in time is never touched', r2.statusCode === 0 && r2.body === null);

  const r3 = mk(); r3.headersSent = true; // streaming NDJSON already started
  DL.armResponseDeadline(r3, 20);
  await new Promise((r) => setTimeout(r, 60));
  check('watchdog: streaming response gets a final failure event, then ends', r3.written.length === 1 && JSON.parse(r3.written[0]).type === 'final' && JSON.parse(r3.written[0]).success === false && r3.writableEnded);

  const mock = { status() { return this; }, json() { return this; } }; // in-process scorecard/test res: no once()
  check('watchdog: mock responses (no once) are never armed', typeof DL.armResponseDeadline(mock, 10) === 'function');

  const acct = read('api/account.js'), ask = read('api/ask.js'), rev = read('api/review.js');
  check('watchdog wired: ask (not for scorecard calls), review, account (not sweep/export), v1, extract, read-document',
    /if \(!scorecardCall\) armResponseDeadline\(res, 290_000\)/.test(ask) && /armResponseDeadline\(res, 290_000\)/.test(rev)
    && /action !== "sweep" && action !== "export"\) armResponseDeadline/.test(acct) && /armResponseDeadline/.test(read('api/v1.js'))
    && /armResponseDeadline/.test(read('api/extract.js')) && /armResponseDeadline/.test(read('api/read-document.js')));
  check('cron-sweep stuck-document retries are deadline-aware', /docRetryDeadlineAt/.test(read('api/_lib/routes/cron-sweep.js')) && /docsLeftForNextRun/.test(read('api/_lib/routes/cron-sweep.js')));
}

/* ============================================================ database-backed: PGlite */
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
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();
const lite = new PGlite({ extensions: contrib });
const notes = [];
for (const f of allMigrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk */ }
check('harness: billing + request-context + integrity migrations loaded cleanly', !notes.some((n) => /^(14|24|27|59)-/.test(n)), notes.join(' | '));

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
const BILL = await import('../api/billing.js');
const BL = await import('../api/_lib/billing.js');

// getPool() must build with the explicit-ssl config from the sslmode=require fixture string above (never connects here).
{
  const pool = RS.getPool();
  check('getPool builds with explicit verifying ssl and without the sslmode param', pool.options.ssl?.rejectUnauthorized === true && !/sslmode/.test(String(pool.options.connectionString)));
}

/* ------------------------------------------------------- #4 / #6: empty id never reaches SQL */
{
  const seen = [];
  const origQuery = pgMod.Pool.prototype.query;
  pgMod.Pool.prototype.query = function spy(sql, params) { seen.push(String(sql)); return origQuery.call(this, sql, params); };
  for (const bad of ['', '   ', null, undefined]) {
    let err; try { await RS.getTenantContext(bad, bad); } catch (e) { err = e; }
    check(`getTenantContext(${JSON.stringify(bad)}) -> clean 401, no SQL`, err?.status === 401 && err?.code === 'NO_TENANT');
  }
  pgMod.Pool.prototype.query = origQuery;
  eq('no query was issued for any blank tenant key', seen.length, 0);

  const RL = await import('../api/_lib/rateLimit.js');
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  const ok = await RL.limit({ headers: {} }, res, { tenantId: '' }, 'ask');
  check('rateLimit.limit with an empty tenant id -> 401, request refused, no SQL', ok === false && res.statusCode === 401);
  const res2 = { ...res, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  check('rateLimit.limit with a whitespace tenant id -> 401', (await RL.limit({ headers: {} }, res2, { tenantId: '  ' }, 'read')) === false && res2.statusCode === 401);

  // withTenant with a blank key must fail the same way (never SET LOCAL app.tenant_id = '').
  let err; try { await RS.withTenant({ tenantKey: '' }, async () => 1); } catch (e) { err = e; }
  check('withTenant({tenantKey: ""}) -> 401, never opens a transaction', err?.status === 401);
}

/* ------------------------------------------------------- #1 debounceLinkSweep parameter types */
{
  const IF = await import('../api/_lib/routes/integrity.js');
  const ctx = { tenantKey: 'org_prodhard_sweep', tenantName: 'Sweep Shop' };
  const tenantId = (await RS.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const errors = [];
  const origErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  let r1, r2;
  try {
    r1 = await IF.integrityFixTenant(ctx, { apply: ['linkDocuments'], dryRun: false });
  } finally { console.error = origErr; }
  check('debounceLinkSweep: the tenants.settings compare-and-swap no longer errors (no "could not determine data type")', !errors.some((e) => /could not determine data type|check failed/.test(e)), errors.join(' | '));
  const row = (await lite.query(`SELECT settings->>'integrity_last_link_sweep' AS ts FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  check('debounceLinkSweep: the last-sweep timestamp is persisted to tenants.settings', Boolean(row?.ts) && !Number.isNaN(Date.parse(row.ts)), JSON.stringify(row));
  check('debounceLinkSweep: first sweep ran (not skipped)', r1?.skipped !== true);
  r2 = await IF.integrityFixTenant(ctx, { apply: ['linkDocuments'], dryRun: false });
  eq('debounceLinkSweep: an immediate second sweep is skipped as recent', [r2?.skipped, r2?.reason], [true, 'recent']);
  // Same statement, straight to the database, proving the DB-side (cross-instance) debounce path too.
  const sql = `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('integrity_last_link_sweep', $2::text)
     WHERE id = $3::uuid AND ( settings->>'integrity_last_link_sweep' IS NULL OR (settings->>'integrity_last_link_sweep')::timestamptz < $1::timestamptz ) RETURNING 1`;
  const recent = await lite.query(sql, [new Date(Date.now() - 600_000).toISOString(), new Date().toISOString(), tenantId]);
  eq('debounceLinkSweep SQL: a sweep inside the debounce window updates nothing (DB-side debounce)', recent.rowCount, 0);
  const stale = await lite.query(sql, [new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString(), tenantId]);
  eq('debounceLinkSweep SQL: a sweep past the window updates the row', stale.rowCount, 1);
  // The buggy form really failed on this Postgres — proves the test can catch a regression.
  const buggy = await lite.query(`SELECT jsonb_build_object('k', $1)`, ['x']).then(() => 'ok', (e) => e.message);
  check('(control) the untyped $n inside jsonb_build_object errors on Postgres, as in production', /could not determine data type of parameter/.test(String(buggy)), String(buggy));
  check('no other untyped $n inside jsonb_build_object in api/**', !(function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (scan(p)) return true; continue; }
      if (!/\.(js|ts)$/.test(e.name)) continue;
      if (/jsonb_build_object\([^)]*'[a-z_A-Z]+',\s*\$\d+\s*\)/.test(fs.readFileSync(p, 'utf8'))) return true;
    }
    return false;
  })(path.join(ROOT, 'api')));
}

/* ------------------------------------------------------- #2 Stripe webhook against real Postgres */
const CUS = 'cus_prodhard_1';
const ctxBill = { tenantKey: 'org_prodhard_billing', tenantName: 'Paying Shop' };
const billTenant = (await RS.getTenantContext(ctxBill.tenantKey, ctxBill.tenantName)).id;
await lite.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [CUS, billTenant]);

let evtSeq = 0;
async function postEvent(type, object, id = `evt_prodhard_${++evtSeq}`) {
  const payload = JSON.stringify({ id, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`, 'utf8').digest('hex');
  const req = Readable.from([Buffer.from(payload, 'utf8')]);
  req.method = 'POST'; req.query = { action: 'webhook' }; req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() {} };
  const errors = [];
  const origErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try { await BILL.default(req, res); } finally { console.error = origErr; }
  return { res, id, errors };
}
const tenantRow = async () => (await lite.query(`SELECT plan, billing_status, stripe_customer_id, stripe_subscription_id, trial_used, cancel_at_period_end, trial_ends_at, current_period_end, limits FROM tenants WHERE id = $1`, [billTenant])).rows[0];
const ledger = async (id) => (await lite.query(`SELECT count(*)::int AS n FROM billing_events WHERE id = $1`, [id])).rows[0].n;

const inFuture = (days) => Math.floor(Date.now() / 1000) + days * 86400;
const planItem = (plan, lookup = `${plan}_monthly`, withMeta = true) => ({ price: { lookup_key: lookup, ...(withMeta ? { metadata: { plan } } : {}) } });
const ADDON = { price: { lookup_key: BL.OUTREACH_AUTO_ADDON_LOOKUP_KEY, metadata: {} } };
const sub = (over = {}) => ({ id: 'sub_prodhard_1', customer: CUS, status: 'active', current_period_end: inFuture(30), trial_end: null, cancel_at_period_end: false, items: { data: [planItem('solo')] }, ...over });

// -- reproduce the production bug with the pre-fix function body (what Neon has today) --
await lite.exec(`
CREATE OR REPLACE FUNCTION billing_record_event(p_id text, p_type text, p_tenant_id uuid, p_payload jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inserted boolean;
BEGIN
  INSERT INTO billing_events (id, type, tenant_id, payload) VALUES (p_id, p_type, p_tenant_id, p_payload) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END; $$;`);
{
  const e = await lite.query(`SELECT billing_record_event('evt_probe_old', 'probe', NULL, '{}'::jsonb)`).then(() => 'ok', (x) => x.message);
  check('(control) the pre-fix billing_record_event reproduces "operator does not exist: boolean > integer"', /operator does not exist: boolean > integer/.test(String(e)), String(e));

  // Even on the OLD (unmigrated) function, a paying client's subscription must still apply.
  const r = await postEvent('customer.subscription.created', sub({ status: 'trialing', trial_end: inFuture(30), items: { data: [planItem('solo')] } }));
  check('PRE-MIGRATION: subscription.created still returns 200 handled and applies', r.res.statusCode === 200 && r.res.body?.handled === true, JSON.stringify(r.res.body));
  const row = await tenantRow();
  eq('PRE-MIGRATION: tenant is trialing on solo with limits set', [row.plan, row.billing_status, row.trial_used, row.limits?.asksPerMonth], ['solo', 'trialing', true, 3000]);
  check('PRE-MIGRATION: the ledger outage was logged (not silent) and did not fail the webhook', r.errors.some((m) => /idempotency ledger unavailable/.test(m)));
  eq('PRE-MIGRATION: no dedupe row (ledger unavailable) — expected', await ledger(r.id), 0);
  await lite.query(`UPDATE tenants SET plan = NULL, billing_status = NULL, trial_used = false, limits = '{}'::jsonb, stripe_subscription_id = NULL WHERE id = $1`, [billTenant]);
}

// -- apply the shipped fix --
await lite.exec(fs.readFileSync(path.join(cfgDir, '59-billing-record-event-fix.sql'), 'utf8'));
check('migration 59 is idempotent', await lite.exec(fs.readFileSync(path.join(cfgDir, '59-billing-record-event-fix.sql'), 'utf8')).then(() => true, () => false));
{
  const a = (await lite.query(`SELECT billing_record_event('evt_probe_new', 'probe', NULL, '{}'::jsonb) AS fresh`)).rows[0].fresh;
  const b = (await lite.query(`SELECT billing_record_event('evt_probe_new', 'probe', NULL, '{}'::jsonb) AS fresh`)).rows[0].fresh;
  eq('billing_record_event: true on first sight, false on replay (typed boolean, no operator error)', [a, b], [true, false]);
}
check('14-billing.sql (fresh installs) now carries the same fix', /v_rows integer/.test(read('M3-config/14-billing.sql')) && !/v_inserted boolean/.test(read('M3-config/14-billing.sql')));

// -- every handled event type, through the real handler --
{
  let r = await postEvent('checkout.session.completed', { customer: CUS, subscription: 'sub_prodhard_1', mode: 'subscription' });
  check('checkout.session.completed -> 200 handled', r.res.statusCode === 200 && r.res.body?.handled === true, JSON.stringify(r.res.body));
  eq('checkout.session.completed: subscription id stored', (await tenantRow()).stripe_subscription_id, 'sub_prodhard_1');
  eq('checkout.session.completed: ledger row written', await ledger(r.id), 1);

  const trialEnd = inFuture(30);
  r = await postEvent('customer.subscription.created', sub({ status: 'trialing', trial_end: trialEnd, items: { data: [planItem('solo')] } }));
  let row = await tenantRow();
  eq('subscription.created (trial): 200 + plan/status/trial flags applied', [r.res.statusCode, row.plan, row.billing_status, row.trial_used, row.cancel_at_period_end], [200, 'solo', 'trialing', true, false]);
  eq('subscription.created (trial): trial_ends_at and limits applied', [Math.abs(new Date(row.trial_ends_at).getTime() / 1000 - trialEnd) < 2, row.limits?.technicians], [true, 1]);
  check('subscription.created: no apply error logged', !r.errors.length, r.errors.join('|'));

  r = await postEvent('customer.subscription.updated', sub({ status: 'active', trial_end: trialEnd, items: { data: [planItem('shop')] } }));
  row = await tenantRow();
  eq('subscription.updated (trial -> active, shop): applied', [r.res.statusCode, row.plan, row.billing_status, row.limits?.asksPerMonth], [200, 'shop', 'active', BL.patchForEvent({ type: 'customer.subscription.updated', data: { object: sub({ items: { data: [planItem('shop')] } }) } }).patch.limits.asksPerMonth]);

  r = await postEvent('customer.subscription.updated', sub({ status: 'active', items: { data: [ADDON, planItem('crew')] } }));
  row = await tenantRow();
  eq('subscription.updated with the auto-send add-on listed FIRST still resolves the base plan + outreachAuto', [row.plan, row.limits?.outreachAuto], ['crew', true]);

  r = await postEvent('customer.subscription.updated', sub({ status: 'active', items: { data: [planItem('fleet', 'fleet_annual', false)] } }));
  eq('price without metadata.plan falls back to the lookup_key scheme', (await tenantRow()).plan, 'fleet');

  r = await postEvent('customer.subscription.updated', sub({ status: 'past_due', current_period_end: undefined, items: { data: [{ ...planItem('fleet'), current_period_end: inFuture(20) }] } }));
  row = await tenantRow();
  eq('subscription.updated (past_due): status applied, period end read from the item on newer API versions', [r.res.statusCode, row.billing_status, row.current_period_end !== null], [200, 'past_due', true]);

  r = await postEvent('customer.subscription.updated', sub({ status: 'active', cancel_at_period_end: true, items: { data: [planItem('fleet')] } }));
  row = await tenantRow();
  eq('subscription.updated (cancel_at_period_end): applied', [row.billing_status, row.cancel_at_period_end], ['active', true]);

  r = await postEvent('invoice.payment_failed', { customer: CUS, subscription: 'sub_prodhard_1' });
  eq('invoice.payment_failed -> past_due', [r.res.statusCode, (await tenantRow()).billing_status], [200, 'past_due']);
  r = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_prodhard_1' });
  eq('invoice.paid -> active (recovers past_due)', [r.res.statusCode, (await tenantRow()).billing_status], [200, 'active']);

  r = await postEvent('customer.subscription.deleted', { id: 'sub_prodhard_1', customer: CUS, status: 'canceled' });
  row = await tenantRow();
  eq('subscription.deleted -> canceled', [r.res.statusCode, row.billing_status, row.cancel_at_period_end], [200, 'canceled', true]);
  check('trial stays spent after cancellation (no second free trial)', row.trial_used === true);

  // -- idempotency + atomicity --
  const dupId = 'evt_prodhard_dup';
  await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_prodhard_1' }, dupId);
  await lite.query(`UPDATE tenants SET billing_status = 'past_due' WHERE id = $1`, [billTenant]);
  r = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_prodhard_1' }, dupId);
  eq('replayed event id -> 200 duplicate and NOT re-applied', [r.res.statusCode, r.res.body?.reason, (await tenantRow()).billing_status], [200, 'duplicate', 'past_due']);

  // A failing apply must roll the ledger row back, so Stripe's retry is applied instead of dropped as a duplicate.
  await lite.exec(`ALTER FUNCTION billing_apply(uuid, jsonb) RENAME TO billing_apply_real;
    CREATE FUNCTION billing_apply(p_tenant_id uuid, p_patch jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RAISE EXCEPTION 'simulated apply failure'; END $$;
    GRANT EXECUTE ON FUNCTION billing_apply(uuid, jsonb) TO deepwell_rls;`);
  const flakyId = 'evt_prodhard_flaky';
  r = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_prodhard_1' }, flakyId);
  eq('apply failure -> 500 (Stripe will retry) and NO ledger row left behind', [r.res.statusCode, await ledger(flakyId)], [500, 0]);
  await lite.exec(`DROP FUNCTION billing_apply(uuid, jsonb); ALTER FUNCTION billing_apply_real(uuid, jsonb) RENAME TO billing_apply;`);
  r = await postEvent('invoice.paid', { customer: CUS, subscription: 'sub_prodhard_1' }, flakyId);
  eq('the retry of that same event id then applies (not dropped as a duplicate)', [r.res.statusCode, r.res.body?.handled, (await tenantRow()).billing_status, await ledger(flakyId)], [200, true, 'active', 1]);

  // -- unhandled / unknown --
  r = await postEvent('customer.created', { id: CUS });
  eq('unhandled event type -> 200 handled:false (never a retry storm)', [r.res.statusCode, r.res.body?.handled], [200, false]);
  r = await postEvent('customer.subscription.updated', sub({ customer: 'cus_unknown_xyz' }));
  eq('unknown customer -> 200 handled:false', [r.res.statusCode, r.res.body?.reason], [200, 'unknown customer']);
}

if (failures) { console.log(`\n${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`\nAll ${passes} prod-hardening checks passed.`);
process.exit(0);
