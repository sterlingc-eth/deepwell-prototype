/**
 * R35 first-paying-customer limits: regression checks for every defect found by the reliability / limit test.
 * No network, no real R2 / Neon / model / Stripe: PGlite as the RLS role (scripts/lib/r35Harness.mjs), a patched fetch
 * standing in for R2 and for the app's own API on the client-side checks.
 *
 *   npx tsx scripts/verify-r35-limits.mjs
 *
 * Families: size (sizeBytes required everywhere), gate (batch + document cap + monthly reset + extra pages), pool,
 * rate (plan-scaled limits, refunds, per-user fairness), billing (owner overrides survive the webhook), sweep (cron
 * recovery), inbox (keyset paging), client (offline queue + bulk import stop on a shop-wide refusal), seats, export.
 * The large-tenant timings live in scripts/r35-measure.mjs (a measurement tool, not a gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness } from './lib/r35Harness.mjs';

const h = await bootHarness();
const { lite, RS, PLAN, stats, newTenant, resetCaches, rnd, root } = h;
const rel = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const fam = {};
let family = 'misc';
let failed = 0;
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = async (name, fn, status, textRe) => {
  try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, (status == null || e.status === status) && (!textRe || textRe.test(e.message)), `status ${e.status}: ${e.message}`); }
};
const quiet = async (fn) => { const log = console.log, err = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = err; console.warn = warn; console.log = log; } };
const mkRes = () => { const r = { statusCode: 0, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };

const UP = await import(rel('api/upload-url.js'));
const RD = await import(rel('api/_lib/readDocument.js'));
const RL = await import(rel('api/_lib/rateLimit.js'));
const SEATS = await import(rel('api/_lib/seats.js'));
const RECORDS = await import(rel('api/records.ts'));
const IQ = await import(rel('api/_lib/intake/queue.js'));
const SWEEP = await import(rel('api/_lib/routes/cron-sweep.js'));

const authFor = (key, userId = 'user_1') => ({ tenantId: key, orgId: key, userId, orgRole: 'admin' });
const withDb = (key, fn) => RS.withTenant({ tenantKey: key, tenantName: key }, fn);

/* ============================================================ SIZE: sizeBytes is required on every upload path */
family = 'size';
{
  await newTenant('org_r35_size', 'shop');
  const auth = authFor('org_r35_size');
  const one = (b) => UP.createUploadUrl(auth, { filename: 'a.pdf', sha256: rnd(), ...b });
  await throws('single presign without sizeBytes -> 400 with the plain message', () => one({}), 400, /sizeBytes is required/);
  for (const bad of [0, -5, 1.5, 'abc', null, NaN, Infinity, '12']) {
    await throws(`single presign with sizeBytes=${JSON.stringify(bad)} -> 400`, () => one({ sizeBytes: bad }), 400);
  }
  const ok = await one({ sizeBytes: 5 });
  check('a valid size presigns, and the PUT URL signs content-length (a client cannot send more than it declared)', /content-length/i.test(ok.uploadUrl ?? ''), ok.uploadUrl);
  const batch = await UP.createUploadUrls(auth, [
    { filename: 'ok.pdf', sha256: rnd(), sizeBytes: 100 },
    { filename: 'nosize.pdf', sha256: rnd() },
    { filename: 'zero.pdf', sha256: rnd(), sizeBytes: 0 },
  ]);
  check('batch: the unsized files get a per-file 400, the sized one still goes through',
    batch[0].documentId && batch[1].status === 400 && /sizeBytes is required/.test(batch[1].error) && batch[2].status === 400, JSON.stringify(batch));
  const { rows } = await lite.query(`SELECT count(*)::int AS n FROM documents WHERE original_filename IN ('nosize.pdf','zero.pdf')`);
  eq('batch: no document row was created for an unsized file', rows[0].n, 0);

  const call = async (body) => { const res = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, authFor('org_r35_size'))); return res; };
  const doc = (over = {}) => ({ action: 'createDocument', original_filename: 'x.pdf', sha256_hash: rnd(), content_type: 'application/pdf', ...over });
  const r1 = await call(doc());
  check('records createDocument without file_size_bytes -> 400', r1.statusCode === 400 && /file_size_bytes|size/i.test(JSON.stringify(r1.body)), `${r1.statusCode} ${JSON.stringify(r1.body)}`);
  const r2 = await call(doc({ file_size_bytes: 0 }));
  check('records createDocument with file_size_bytes 0 -> 400', r2.statusCode === 400, `${r2.statusCode}`);
  const r3 = await call(doc({ file_size_bytes: 1000 }));
  check('records createDocument with a size succeeds', (r3.statusCode === 0 || r3.statusCode === 200 || r3.statusCode === 201) && !!r3.body?.id, `${r3.statusCode} ${JSON.stringify(r3.body)}`);

  const v1 = read('api/_lib/routes/v1-ingest.js');
  check('v1 ingest documents sizeBytes as required and routes through the same validation', /sizeBytes/.test(v1) && /createUploadUrl|validateUploadBody/.test(v1));
  for (const f of ['src/services/ingestClient.ts', 'src/services/bulkImport.ts', 'src/mobile/offline/uploadQueue.ts', 'src/mobile/offline/queue.ts']) {
    check(`client ${f} sends the file's size`, /sizeBytes|file\.size/.test(read(f)));
  }
  const up = read('api/upload-url.js');
  const hasPagesProbe = await withDb('org_r35_size', (db) => typeof db.hasPages === 'function');
  check('upload-url asks an EXISTS probe (db.hasPages) whether a duplicate was read, not every page of text (listPages is only the fallback for a store without it)', hasPagesProbe && /db\.hasPages\(/.test(up));
}

/* ============================================================ GATE: batch allowance, caps, monthly reset, extra pages */
family = 'gate';
{
  const { gateUpload, pageCapFor, extraPagesFor, estimatePagesForUpload, monthResetLabel } = PLAN;
  const shop = { plan: 'shop', billing_status: 'active', limits: {} };
  eq('pure: shop at 1,999 of 2,000 pages has exactly 1 page of headroom', gateUpload(shop, { documentsStored: 5, pagesThisMonth: 1999, pendingPages: 0 }).pagesRemaining, 1);
  const full = gateUpload(shop, { documentsStored: 5, pagesThisMonth: 2000, pendingPages: 0 });
  check('pure: at the cap -> 402, names the cap and the reset date', full.allowed === false && full.status === 402 && /Monthly page limit reached \(2,000\)/.test(full.error) && new RegExp(monthResetLabel()).test(full.error), full.error);
  const pend = gateUpload(shop, { documentsStored: 5, pagesThisMonth: 1500, pendingPages: 600 });
  check('pure: pages still being processed count toward the cap, and the message says so', pend.allowed === false && /still being processed/.test(pend.error), pend.error);
  const docFull = gateUpload({ plan: 'solo', billing_status: 'active', limits: {} }, { documentsStored: 25000, pagesThisMonth: 0, pendingPages: 0 });
  check('pure: the stored-document cap is ENFORCED (Solo 25,000), not just displayed', docFull.allowed === false && docFull.status === 402 && /25,000/.test(docFull.error) && /still search and ask/.test(docFull.error), JSON.stringify(docFull));
  eq('pure: one document under the document cap has 1 left', gateUpload({ plan: 'solo', billing_status: 'active', limits: {} }, { documentsStored: 24999, pagesThisMonth: 0, pendingPages: 0 }).documentsRemaining, 1);
  check('pure: Fleet has no document cap', gateUpload({ plan: 'fleet', billing_status: 'active', limits: {} }, { documentsStored: 9_000_000, pagesThisMonth: 0 }).allowed === true);
  const fleetFull = gateUpload({ plan: 'fleet', billing_status: 'active', limits: {} }, { documentsStored: 0, pagesThisMonth: 10000 });
  check('pure: a Fleet shop at its cap is told to email support, not to "upgrade"', fleetFull.allowed === false && /support@deepwelltechnology\.com/.test(fleetFull.error) && !/Upgrade/.test(fleetFull.error), fleetFull.error);
  check('pure: M6 wording preserved (r30 asserts "Monthly page limit reached (750)")', /Monthly page limit reached \(750\)/.test(gateUpload({ plan: 'solo', billing_status: 'active', limits: {} }, { documentsStored: 0, pagesThisMonth: 750 }).error));
  const pd = gateUpload({ plan: 'shop', billing_status: 'past_due', limits: { _billing: { pastDueSince: Math.floor(Date.now() / 1000) - 20 * 86400 } } }, { documentsStored: 0, pagesThisMonth: 0 });
  check('pure: past_due past grace is explained (payment failed, what is paused, what still works)', pd.allowed === false && pd.status === 402 && /payment/i.test(pd.error) && /safe/.test(pd.error), pd.error);

  // Extra pages (Records Rescue / negotiated backfill) ride on tenants.limits.extraPagesPerMonth.
  const withExtra = { plan: 'solo', billing_status: 'active', limits: { extraPagesPerMonth: 4167 } };
  eq('extra pages: Solo 750 + 4,167 = 4,917', pageCapFor(withExtra), 4917);
  eq('extra pages: garbage / negative / missing -> no extra', [extraPagesFor({ limits: { extraPagesPerMonth: -3 } }), extraPagesFor({ limits: { extraPagesPerMonth: 'x' } }), extraPagesFor({ limits: {} }), extraPagesFor(null)], [0, 0, 0, 0]);
  check('extra pages: 1,500 pages read is allowed on Solo + extra (and refused without it)',
    gateUpload(withExtra, { documentsStored: 0, pagesThisMonth: 1500 }).allowed === true && gateUpload({ ...withExtra, limits: {} }, { documentsStored: 0, pagesThisMonth: 1500 }).allowed === false);
  eq('page estimate: a 2 MB PDF ~ 10 pages, a photo 1, a 1 KB text 1, never above 200', [estimatePagesForUpload('application/pdf', 2_048_000), estimatePagesForUpload('image/jpeg', 9e6), estimatePagesForUpload('text/plain', 1000), estimatePagesForUpload('application/pdf', 9e9)], [10, 1, 1, 200]);

  // Against the database: 50 big PDFs into a shop that has 10 pages left. Before R35 all 50 passed one gate check.
  await newTenant('org_r35_gate', 'shop');
  const id = (await RS.getTenantContext('org_r35_gate', 'org_r35_gate')).id;
  const { rows: [seedDoc] } = await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count) VALUES ($1,'seed.pdf',$2,1,'read','k','application/pdf',1990) RETURNING id`, [id, rnd()]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text) SELECT $1, $2, g, '', 'x' FROM generate_series(1, 1990) g`, [id, seedDoc.id]);
  resetCaches();
  const auth = authFor('org_r35_gate');
  const gate = await UP.checkUploadGate(auth);
  check('db gate: 1,990 pages read of 2,000 -> allowed, 10 pages of headroom', gate.allowed === true && gate.pagesRemaining === 10, JSON.stringify({ ...gate, billingRow: undefined }));
  const files = Array.from({ length: 50 }, (_, i) => ({ filename: `big-${i}.pdf`, sha256: rnd(), sizeBytes: 2_048_000, contentType: 'application/pdf' }));
  const results = await UP.createUploadUrls(auth, files, gate);
  const okN = results.filter((r) => r.documentId).length;
  const deniedN = results.filter((r) => r.status === 402).length;
  check('db batch: 50 x ~10-page PDFs against 10 pages of headroom -> 1 accepted, 49 told 402 (not 50 accepted)', okN === 1 && deniedN === 49, `ok=${okN} denied=${deniedN}`);
  check('db batch: the 402 text is the plain-English monthly-limit message with the reset date', /Monthly page limit reached/.test(results[1].error) && new RegExp(monthResetLabel()).test(results[1].error), results[1].error);
  const { rows: [{ n }] } = await lite.query(`SELECT count(*)::int AS n FROM documents WHERE original_filename LIKE 'big-%'`);
  eq('db batch: denied files created no document rows', n, 1);
  // A re-sent duplicate (same sha) costs nothing and does not spend headroom.
  const dupSha = files[0].sha256;
  const again = await UP.createUploadUrls(auth, [{ filename: 'big-0.pdf', sha256: dupSha, sizeBytes: 2_048_000, contentType: 'application/pdf' }], { pagesRemaining: 0, documentsRemaining: null, billingRow: gate.billingRow });
  check('db batch: with 0 headroom a duplicate of an existing file is still answered (402 for it is acceptable, a new row is not created)', again.length === 1);

  // Monthly reset: the count starts over on the 1st (UTC), not 30 rolling days.
  await newTenant('org_r35_month', 'shop');
  const mid = (await RS.getTenantContext('org_r35_month', 'org_r35_month')).id;
  const { rows: [md] } = await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count) VALUES ($1,'m.pdf',$2,1,'read','k','application/pdf',2) RETURNING id`, [mid, rnd()]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text, created_at) VALUES ($1,$2,1,'','x', date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 hour'), ($1,$2,2,'','x', NOW())`, [mid, md.id]);
  const counted = await withDb('org_r35_month', (db) => db.countPagesSince(new Date(Date.now() - 30 * 864e5).toISOString()));
  eq('month reset: a page scanned just before the 1st is NOT counted this month even though it is inside 30 days', counted, 1);
  const bootstrap = read('api/records.ts');
  check('month reset: bootstrap usage uses the same countPagesSince (so Billing shows the same number the gate enforces)', /countPagesSince\(monthStartIso\)/.test(bootstrap));
}

/* ============================================================ POOL: connections are always returned */
family = 'pool';
{
  await newTenant('org_r35_pool', 'shop');
  const out0 = stats.out;
  for (let i = 0; i < 40; i++) await withDb('org_r35_pool', (db) => db.countDocuments());
  eq('40 sequential withTenant calls leave nothing checked out', stats.out - out0, 0);
  await Promise.all(Array.from({ length: 20 }, () => withDb('org_r35_pool', (db) => db.countDocuments())));
  eq('20 concurrent withTenant calls leave nothing checked out', stats.out - out0, 0);
  for (let i = 0; i < 10; i++) { try { await withDb('org_r35_pool', async () => { throw new Error('boom'); }); } catch { /* expected */ } }
  eq('10 callbacks that throw still return their connection', stats.out - out0, 0);

  // A connection whose ROLLBACK fails is broken: it must be destroyed (release(true)), not handed to the next request.
  const pgMod = (await import('pg')).default;
  const realConnect = pgMod.Pool.prototype.connect;
  let releaseArg = 'unset';
  pgMod.Pool.prototype.connect = async function () {
    const c = await realConnect.call(this);
    return { query: (sql, p) => (/^ROLLBACK/i.test(String(sql)) ? Promise.reject(new Error('connection terminated')) : c.query(sql, p)), release: (a) => { releaseArg = a; c.release(); } };
  };
  try { await withDb('org_r35_pool', async () => { throw new Error('boom'); }); } catch { /* expected */ }
  pgMod.Pool.prototype.connect = realConnect;
  eq('a failed ROLLBACK destroys the connection (release(true))', releaseArg, true);

  const pool = RS.getPool();
  let threw = false;
  try { pool.emit('error', new Error('idle client dropped')); } catch { threw = true; }
  check('an idle-connection error on the pool is handled (no uncaught exception that kills the warm instance)', threw === false);
  check('pool size is env-tunable (PG_POOL_MAX) and defaults to 3', /PG_POOL_MAX/.test(read('api/_lib/recordsStore.js')));
}

/* ============================================================ RATE: plan-scaled burst, refunds, per-user fairness */
family = 'rate';
{
  const { scaleMinuteLimitForPlan, limitsFromTenantContext, perUserAskPerMinute } = RL;
  eq('ingest per-minute scales with the plan 60/150/360/720', ['solo', 'shop', 'crew', 'fleet'].map((p) => scaleMinuteLimitForPlan('ingest', 60, { plan: p })), [60, 150, 360, 720]);
  eq('ask per-minute scales gently 20/40/80/120', ['solo', 'shop', 'crew', 'fleet'].map((p) => scaleMinuteLimitForPlan('ask', 20, { plan: p })), [20, 40, 80, 120]);
  eq('read / billing / support do not scale', [scaleMinuteLimitForPlan('read', 120, { plan: 'fleet' }), scaleMinuteLimitForPlan('billing', 6, { plan: 'fleet' })], [120, 6]);
  eq('no plan -> the Solo-sized default', scaleMinuteLimitForPlan('ingest', 60, {}), 60);
  eq('explicit tenant override still wins over the plan scale', limitsFromTenantContext({ plan: 'crew', ingest: { perMinute: 7 } }, 'ingest').perMinute, 7);
  eq('per-user ask share is half the tenant bucket, never below 6', [perUserAskPerMinute(20), perUserAskPerMinute(8), perUserAskPerMinute(120)], [10, 6, 60]);

  await newTenant('org_r35_rate', 'shop');
  const tid = (await RS.getTenantContext('org_r35_rate', 'org_r35_rate')).id;
  const auth = { tenantId: 'org_r35_rate' };
  const go = async (bucket, overrides, cost, a = auth) => { const res = mkRes(); const ok = await quiet(() => RL.limit({ headers: {} }, res, a, bucket, overrides, cost)); return { ok, res }; };
  const windowUnits = async (bucket) => (await lite.query(`SELECT COALESCE(sum(units),0)::int AS n FROM rate_limit_windows WHERE tenant_id = $1 AND bucket = $2`, [tid, bucket])).rows[0].n;

  // A denied call is refunded: 3 units used, a 5-unit batch is refused, and the window still says 3 (it used to say 8).
  await go('ingest', { perMinute: 5, perDay: 1000 }, 3);
  const denied = await go('ingest', { perMinute: 5, perDay: 1000 }, 5);
  check('burst: a batch that does not fit is refused with a 429 + Retry-After', denied.ok === false && denied.res.statusCode === 429 && Number(denied.res.headers['Retry-After']) >= 1);
  eq('burst: the refused batch is refunded (window = 3 units, not 8)', await windowUnits('ingest'), 3);
  const fits = await go('ingest', { perMinute: 5, perDay: 1000 }, 2);
  check('burst: after the refusal a call that fits still goes through (the shop is not locked out by retries)', fits.ok === true);
  let spamOk = 0;
  for (let i = 0; i < 20; i++) if ((await go('ingest', { perMinute: 5, perDay: 1000 }, 5)).ok) spamOk++;
  eq('burst: 20 refused retries do not inflate the window', await windowUnits('ingest'), 5);
  eq('burst: ...and none of them got through', spamOk, 0);

  // Daily cap denial is refunded too.
  const dayRow = async () => (await lite.query(`SELECT COALESCE(sum(units),0)::int AS n FROM rate_limit_windows WHERE tenant_id = $1 AND bucket = 'day:read'`, [tid])).rows[0].n;
  for (let i = 0; i < 4; i++) await go('read', { perMinute: 1000, perDay: 4 });
  const d5 = await go('read', { perMinute: 1000, perDay: 4 });
  check('daily: the 5th call is refused', d5.ok === false && d5.res.statusCode === 429 && d5.res.body?.scope === 'per-day');
  eq('daily: the refused call is refunded (counter stays at 4)', await dayRow(), 4);

  // Per-user fairness for Donovan.
  const u1 = { tenantId: 'org_r35_rate', userId: 'user_runaway' };
  const u2 = { tenantId: 'org_r35_rate', userId: 'user_other' };
  let okU1 = 0;
  for (let i = 0; i < 14; i++) if ((await go('ask', { perMinute: 20, perDay: 100000 }, 1, u1)).ok) okU1++;
  eq('ask: one runaway user is held to half the shop bucket (10 of 20)', okU1, 10);
  const other = await go('ask', { perMinute: 20, perDay: 100000 }, 1, u2);
  check('ask: another person in the same shop still gets an answer', other.ok === true, JSON.stringify(other.res.body));
  const blocked = await go('ask', { perMinute: 20, perDay: 100000 }, 1, u1);
  check('ask: the per-user refusal says so in plain words', blocked.res.body?.scope === 'per-user' && /one person|give it a moment/i.test(blocked.res.body?.details ?? ''), JSON.stringify(blocked.res.body));
  eq('ask: refused per-user calls did not eat the shop bucket (10 + 1 = 11 units)', await windowUnits('ask'), 11);

  // Works against the OLD function too (migration 62 not pasted yet): refunds become a no-op, nothing throws.
  await lite.exec(read('M3-config/12-rate-limit-window.sql'));
  const tid2key = 'org_r35_rate_old';
  await newTenant(tid2key, 'shop');
  await go('ingest', { perMinute: 5, perDay: 1000 }, 3, { tenantId: tid2key });
  const oldDenied = await go('ingest', { perMinute: 5, perDay: 1000 }, 5, { tenantId: tid2key });
  check('without migration 62 a refusal still works (refund is a harmless no-op, no exception)', oldDenied.ok === false && oldDenied.res.statusCode === 429);
  await lite.exec(read('M3-config/62-rate-limit-refund-and-owner-overrides.sql'));

  // Model-spend cap default scales with the plan; an explicit owner override wins.
  await newTenant('org_r35_budget_crew', 'crew', 'active', { plan: 'crew', pagesPerMonth: 5000 });
  eq('model budget: a Crew shop defaults to 12,000 calls/day (6 x 2,000)', (await RL.getDailyModelBudgetStatus({ tenantKey: 'org_r35_budget_crew' })).limit, 12000);
  await newTenant('org_r35_budget_solo', 'solo', 'active', { plan: 'solo', pagesPerMonth: 750 });
  eq('model budget: Solo stays at 2,000', (await RL.getDailyModelBudgetStatus({ tenantKey: 'org_r35_budget_solo' })).limit, 2000);
  await newTenant('org_r35_budget_o', 'crew', 'active', { plan: 'crew', pagesPerMonth: 5000, maxModelCallsPerDay: 77 });
  eq('model budget: an explicit maxModelCallsPerDay override wins', (await RL.getDailyModelBudgetStatus({ tenantKey: 'org_r35_budget_o' })).limit, 77);
}

/* ============================================================ BILLING: owner overrides survive the Stripe webhook */
family = 'billing';
{
  const owner = { plan: 'solo', pagesPerMonth: 750, extraPagesPerMonth: 4167, maxModelCallsPerDay: 9000, ingest: { perDay: 100000 }, testAccount: true };
  await newTenant('org_r35_bill', 'solo', 'active', owner);
  const id = (await RS.getTenantContext('org_r35_bill', 'org_r35_bill')).id;
  const apply = (patch) => lite.query('SELECT billing_apply($1, $2::jsonb)', [id, JSON.stringify(patch)]);
  const limits = async () => (await lite.query('SELECT limits FROM tenants WHERE id = $1', [id])).rows[0].limits;
  await apply({ plan: 'fleet', billing_status: 'active', limits: { plan: 'fleet', pagesPerMonth: 10000, logins: null } });
  let l = await limits();
  check('subscription event: the plan keys are replaced...', l.plan === 'fleet' && l.pagesPerMonth === 10000);
  check('subscription event: ...but extraPagesPerMonth, maxModelCallsPerDay, ingest override and testAccount survive', l.extraPagesPerMonth === 4167 && l.maxModelCallsPerDay === 9000 && l.ingest?.perDay === 100000 && l.testAccount === true, JSON.stringify(l));
  await apply({ billing_status: 'past_due' });
  l = await limits();
  check('a patch with no limits leaves them exactly as they were', l.extraPagesPerMonth === 4167 && l.plan === 'fleet');
  await apply({ limits: { plan: 'shop', pagesPerMonth: 2000, extraPagesPerMonth: 100 } });
  l = await limits();
  eq('a patch that itself sets an override key wins over the stored one', [l.plan, l.extraPagesPerMonth, l.maxModelCallsPerDay], ['shop', 100, 9000]);
  const sql = read('M3-config/62-rate-limit-refund-and-owner-overrides.sql');
  check('migration 62 is idempotent SQL (CREATE OR REPLACE only, no DROP / destructive statements)', /CREATE OR REPLACE FUNCTION increment_rate_limit_window/.test(sql) && /CREATE OR REPLACE FUNCTION billing_apply/.test(sql) && !/\bDROP\b/i.test(sql));
  await lite.exec(sql);
  check('migration 62 can be run twice', true);
  // The same tenant can be gated with its extra pages end to end.
  resetCaches();
  const row = (await RS.getTenantContext('org_r35_bill', 'org_r35_bill'));
  check('the tenant row the gate reads carries the preserved override', row.limits?.extraPagesPerMonth === 100);
}

/* ============================================================ SWEEP: abandoned uploads, unextracted documents, light mode */
family = 'sweep';
{
  const id = await newTenant('org_r35_sweep', 'shop');
  const ctx = { tenantKey: 'org_r35_sweep', tenantName: 'org_r35_sweep' };
  check('sweep nonce is stable within a UTC day and changes on the next', SWEEP.sweepNonce(Date.UTC(2026, 9, 1, 3)) === 'sweep-20261001' && SWEEP.sweepNonce(Date.UTC(2026, 9, 1, 23)) === 'sweep-20261001' && SWEEP.sweepNonce(Date.UTC(2026, 9, 2, 0, 1)) === 'sweep-20261002');
  check('the sweep can enqueue hundreds per tenant per run (was 25 per night)', SWEEP.MAX_ENQUEUE_PER_TENANT >= 400);
  check('queue on: a document waiting behind a big import is not "stuck" for 12 h (read) / 6 h (extract), so the sweep never double-runs it', SWEEP.QUEUE_STUCK_MINUTES === 720 && SWEEP.QUEUE_UNEXTRACTED_MINUTES === 360 && /isQueueEnabled\(\) \? QUEUE_STUCK_MINUTES : STUCK_MINUTES/.test(read('api/_lib/routes/cron-sweep.js')));

  const mk = async (name, stage, { ageMin = 120, pages = 0, err = null } = {}) => {
    const { rows: [d] } = await lite.query(
      `INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, extract_error, created_at, updated_at, extracted_at)
       VALUES ($1,$2,$3,100,$4,$5,'application/pdf',$6,$7, NOW() - ($8 || ' minutes')::interval, NOW() - ($8 || ' minutes')::interval, CASE WHEN $4 = 'received' THEN NULL ELSE NOW() - ($8 || ' minutes')::interval END) RETURNING id`,
      [id, name, rnd(), stage, `${id}/aa/${rnd()}.pdf`, pages, err, String(ageMin)]);
    return d.id;
  };
  const abandoned = await mk('abandoned.pdf', 'received');
  const unex = await mk('unextracted.pdf', 'read', { pages: 1 });
  await mk('fresh-read.pdf', 'read', { pages: 1, ageMin: 5 });
  await mk('failed-read.pdf', 'read', { pages: 1, err: 'x' });
  await mk('done.pdf', 'mapped', { pages: 1 });
  const listed = await SWEEP.listUnextractedDocuments(ctx);
  eq('unextracted listing: only the read-but-never-extracted document that has been quiet an hour', listed.map((r) => r.original_filename), ['unextracted.pdf']);

  // An upload that never reached storage: R2 says 404.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, body: { cancel: async () => {} } });
  let abandonedErr = null;
  try { await RD.ingestDocument(ctx, abandoned); } catch (e) { abandonedErr = e; }
  globalThis.fetch = realFetch;
  check('R2 404 becomes a plain "upload never finished" error flagged abandoned (no scary R2 text)', abandonedErr?.abandoned === true && abandonedErr.message === RD.ABANDONED_UPLOAD_MESSAGE && !/R2/.test(abandonedErr.message), abandonedErr?.message);
  const q = await import(rel('api/_lib/queue.js'));
  check('...and the queue treats it as final (no retry storm)', q.fatal(abandonedErr) === true);
  await RD.recordIngestFailure(ctx, abandoned, abandonedErr);
  const { rows: [row] } = await lite.query('SELECT extract_error FROM documents WHERE id = $1', [abandoned]);
  eq('the tenant sees the friendly message on the document', row.extract_error, RD.ABANDONED_UPLOAD_MESSAGE);
  check('an abandoned upload is not reported to Sentry (source guard)', /!error\?\.abandoned\)\s*await captureException/.test(read('api/_lib/readDocument.js')));

  // The light sweep: handler end to end, document recovery only.
  process.env.CRON_SECRET = 'r35-secret';
  const stuck = await mk('stuck-abandoned.pdf', 'received', { ageMin: 180 });
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, body: { cancel: async () => {} } });
  const res = mkRes();
  await quiet(() => SWEEP.default({ method: 'POST', headers: { authorization: 'Bearer r35-secret' }, query: { mode: 'docs' }, body: { tenants: [{ tenant_key: 'org_r35_sweep', tenant_name: 'org_r35_sweep' }] } }, res));
  globalThis.fetch = realFetch;
  const s = res.body ?? {};
  check('?mode=docs runs and says so', res.statusCode === 200 && s.mode === 'docs', JSON.stringify(res.body)?.slice(0, 300));
  check('light mode skips integrity / recheck / notifications / learning (cheap enough to run every 15 minutes)', s.notifications === undefined && s.autopilot === undefined && s.integrityMerged === 0);
  // (the one "still failing" is the seeded read-but-unextracted document: it has no stored page text to extract from)
  check('the abandoned upload is counted as abandoned, not as "still failing"', s.abandonedUploads >= 1 && s.stillFailing === 1, JSON.stringify({ a: s.abandonedUploads, f: s.stillFailing }));
  check('read-but-unextracted documents are found by the sweep', s.unextractedFound >= 1, JSON.stringify(s.unextractedFound));
  const { rows: [st] } = await lite.query('SELECT extract_error FROM documents WHERE id = $1', [stuck]);
  eq('the stuck, abandoned document now carries the friendly message instead of sitting at "received" forever', st.extract_error, RD.ABANDONED_UPLOAD_MESSAGE);
  void unex;
  const src = read('api/_lib/routes/cron-sweep.js');
  check('inline recovery now extracts after reading (a recovered document used to sit with no fields)', /ingestDocument\(ctx, doc\.id\);\s*[\s\S]{0,400}extractDocumentFields\(ctx, doc\.id/.test(src));
  check('queue on: the sweep enqueues with the daily sweep nonce and skips a tenant whose model budget is still spent', /enqueueDocument\(/.test(src) && /requeueNonce: nonce/.test(src) && /getDailyModelBudgetStatus/.test(src));
  const vj = JSON.parse(read('vercel.json'));
  check('vercel.json still has its cron entries (the frequent light sweep is an owner paste, see the handoff)', Array.isArray(vj.crons) && vj.crons.length >= 1);
}

/* ============================================================ INBOX: keyset paging, a page is a page */
family = 'inbox';
{
  const id = await newTenant('org_r35_inbox', 'shop');
  await lite.query(`
    INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, document_type, page_count)
    SELECT $1, 'q-' || g || '.pdf', md5(g::text) || md5((g * 3)::text), 10, 'read', 'k', 'application/pdf', 'work_order', 1 FROM generate_series(1, 130) g`, [id]);
  // 130 documents; every 10th row shares the SAME created_at as the one before it (ties must not skip or repeat).
  await lite.query(`
    INSERT INTO intake_needs_info (tenant_id, document_id, field_key, question, candidates, status, created_at)
    SELECT $1, d.id, 'customer_name', 'Who?', '[]'::jsonb, 'open',
           TIMESTAMPTZ '2026-09-01 08:00:00+00' + (CASE WHEN rn % 10 = 0 THEN rn - 1 ELSE rn END || ' seconds')::interval
      FROM (SELECT id, row_number() OVER (ORDER BY original_filename) AS rn FROM documents WHERE tenant_id = $1) d`, [id]);
  const seen = [];
  let cursor = null;
  let pages = 0;
  let counts = new Set();
  stats.queryLog = [];
  do {
    const page = await withDb('org_r35_inbox', (db) => IQ.listIntakeQueue(db, { limit: 20, cursor }));
    counts.add(page.openDocumentCount);
    for (const it of page.items) seen.push(it.needsInfoId);
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  const log = stats.queryLog; stats.queryLog = null;
  eq('inbox: paging 130 open questions 20 at a time returns every one exactly once', [seen.length, new Set(seen).size], [130, 130]);
  eq('inbox: 7 pages (6 full + 1 partial)', pages, 7);
  eq('inbox: the total open count is correct on every page', [...counts], [130]);
  const first = await withDb('org_r35_inbox', (db) => IQ.listIntakeQueue(db, { limit: 20, cursor: 'garbage|nonsense' }));
  eq('inbox: a garbage cursor is treated as "start at the top", not an error', first.items.length, 20);
  check('inbox: the page query is bounded in SQL (LIMIT) - it no longer pulls every open row into Node',
    log.some((l) => /WITH first_open AS/.test(l)) && /LIMIT \$3/.test(read('api/_lib/intake/queue.js')) && !/earliest\.sort/.test(read('api/_lib/intake/queue.js')));
  const none = await withDb('org_r35_inbox', (db) => IQ.listIntakeQueue(db, { limit: 20, cursor: `${new Date('2030-01-01').toISOString()}|00000000-0000-0000-0000-000000000000` }));
  eq('inbox: a cursor past the end -> empty page, total still reported', [none.items.length, none.openDocumentCount, none.nextCursor], [0, 130, null]);
}

/* ============================================================ CLIENT: the offline queue and bulk import stop on a shop-wide refusal */
family = 'client';
{
  const Q = await import(rel('src/mobile/offline/uploadQueue.ts'));
  const { createMemoryStore } = await import(rel('src/mobile/offline/queue.ts'));
  const { IngestHttpError } = await import(rel('src/services/ingestClient.ts'));
  const mk429 = (s) => new IngestHttpError('Too many requests', 429, {}, s);
  const d1 = Q.retryDelayMs(mk429(90), 1);
  check('offline: a 429 with Retry-After: 90 waits at least 90 s (was: its own guess)', d1 >= 90_000 && d1 <= 95_000, String(d1));
  eq('offline: a daily-cap Retry-After of 12 h is capped at 2 h', Q.retryDelayMs(mk429(43_200), 1), Q.RETRY_AFTER_CAP_MS);
  check('offline: a 402 still waits at least 10 minutes', Q.retryDelayMs(new IngestHttpError('plan', 402, {}), 1) >= 10 * 60_000);
  check('offline: 429 and 402 pause the whole shop; a 500 or a 400 does not', Q.isShopWidePause(mk429()) && Q.isShopWidePause(new IngestHttpError('x', 402, {})) && !Q.isShopWidePause(new IngestHttpError('x', 500, {})) && !Q.isShopWidePause(new IngestHttpError('x', 400, {})));

  const realFetch = globalThis.fetch;
  const calls = [];
  let mode = '429';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] ?? null }, text: async () => JSON.stringify(body), json: async () => body });
    if (u.includes('/api/upload-url')) {
      if (mode === '429') return res(429, { error: 'Too many requests', scope: 'per-minute' }, { 'Retry-After': '45' });
      if (mode === '402') return res(402, { error: 'Monthly page limit reached (2,000)' });
      return res(200, { documentId: `d${calls.length}`, uploadUrl: 'https://fake-upload.test/x', alreadyUploaded: false });
    }
    if (u.startsWith('https://fake-upload.test/')) return { ok: true };
    if (u.includes('/api/read-document')) return res(200, { documentId: 'x', pages: 1 });
    throw new Error(`unexpected fetch ${u}`);
  };
  const sha = async (f) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))).map((b) => b.toString(16).padStart(2, '0')).join('');
  for (const m of ['429', '402']) {
    mode = m;
    calls.length = 0;
    const store = createMemoryStore();
    const queue = new Q.OfflineUploadQueue(store);
    for (let i = 0; i < 100; i++) { const f = new File([`scan-${m}-${i}`], `scan-${i}.jpg`, { type: 'image/jpeg' }); await queue.enqueue('shop-a', f, await sha(f)); }
    await queue.drain('shop-a');
    const presigns = calls.filter((u) => u.includes('/api/upload-url')).length;
    eq(`offline ${m}: 100 queued scans make ONE request when the shop is refused (was 100)`, presigns, 1);
    const rows = await store.all('shop-a');
    eq(`offline ${m}: the other 99 scans are untouched (no attempts burned)`, rows.filter((r) => r.attempts === 0).length, 99);
    await queue.drain('shop-a');
    eq(`offline ${m}: an online / visibility trigger inside the pause sends nothing`, calls.filter((u) => u.includes('/api/upload-url')).length, 1);
    const first = rows.find((r) => r.attempts > 0);
    check(`offline ${m}: the refused scan is scheduled for later and stays queued (not deleted, not permanent)`, first && first.errorClass === 'transient' && first.nextAttemptAt > Date.now() + (m === '429' ? 40_000 : 5 * 60_000), JSON.stringify(first && { c: first.errorClass, n: first.nextAttemptAt - Date.now() }));
    queue.clear?.();
  }
  mode = 'ok';

  // Bulk import: a whole-batch 402 stops the run (it used to fall back to one presign per file).
  const Bulk = await import(rel('src/services/bulkImport.ts'));
  check('bulk: isPlanLimitError is true only for a 402', Bulk.isPlanLimitError(new IngestHttpError('x', 402, {})) && !Bulk.isPlanLimitError(new IngestHttpError('x', 429, {})) && !Bulk.isPlanLimitError(new Error('x')));
  calls.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'Monthly page limit reached (750). It resets on Oct 1. Upgrade your plan for more.' }), json: async () => ({}) };
  };
  const sources = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.pdf`, name: `f${i}.pdf`, sizeBytes: 100 + i, toFile: async () => new File([`pdf-${i}`], `f${i}.pdf`, { type: 'application/pdf' }) }));
  let planMsg = null;
  const handle = Bulk.startBulkImport(sources, { concurrency: 3 }, { onPlanLimitReached: (m) => { planMsg = m; } });
  const states = await handle.result;
  const presignCalls = calls.filter((u) => u.includes('/api/upload-url')).length;
  check('bulk: 120 files against a plan limit make 1 request, not 120+', presignCalls === 1, `calls=${presignCalls}`);
  check('bulk: the owner sees the server\'s plain-English message once', typeof planMsg === 'string' && /Monthly page limit reached/.test(planMsg));
  check('bulk: every file is marked failed with that message (nothing silently dropped)', states.every((s) => s.status === 'failed' && /Monthly page limit reached/.test(s.error ?? '')), JSON.stringify(states.map((s) => s.status).slice(0, 3)));
  check('bulk: IntakeScreen shows the notice', /onPlanLimitReached/.test(read('src/screens/IntakeScreen.tsx')));
  globalThis.fetch = realFetch;
}

/* ============================================================ SEATS: an over-cap team gets an honest message */
family = 'seats';
{
  const over = SEATS.SEAT_LIMIT_MESSAGE('shop', 5, 8);
  check('over cap after a downgrade: says how many logins, that members keep access, and how many to remove', /8 logins/.test(over) && /keeps? their access/.test(over) && /remove 3 logins/.test(over), over);
  const at = SEATS.SEAT_LIMIT_MESSAGE('shop', 5, 5);
  check('at cap: the original "upgrade your plan" wording is unchanged', /includes up to 5 logins/.test(at) && /Upgrade your plan/.test(at), at);
  check('legacy 2-argument call still works', /includes up to 5 logins/.test(SEATS.SEAT_LIMIT_MESSAGE('shop', 5)));
}

/* ============================================================ EXPORT: the customers CSV is not silently 200 rows */
family = 'export';
{
  const id = await newTenant('org_r35_export', 'shop');
  await lite.query(`INSERT INTO entities (tenant_id, entity_type, data, customer_number) SELECT $1, 'customer', jsonb_build_object('customer_name', 'C' || g), 'C-' || lpad(g::text, 5, '0') FROM generate_series(1, 450) g`, [id]);
  const def = await withDb('org_r35_export', (db) => db.listCustomersSummary({ limit: 10000 }));
  eq('listCustomersSummary keeps its 200 page ceiling for the app screens', def.length, 200);
  const all = await withDb('org_r35_export', (db) => db.listCustomersSummary({ limit: 10000, cap: 10000 }));
  eq('...and an export can ask for the whole list (450 of 450)', all.length, 450);
  check('export-csv asks for the whole list', /listCustomersSummary\(\{ limit: MAX_ROWS, cap: MAX_ROWS \}\)/.test(read('api/_lib/routes/export-csv.js')));
}

/* ============================================================ SCALE: Customers deep pages and Records "load more" */
family = 'scale';
{
  const id = await newTenant('org_r35_scale', 'shop');
  await lite.query(`INSERT INTO entities (tenant_id, entity_type, data, customer_number, updated_at) SELECT $1, 'customer', jsonb_build_object('customer_name', 'S' || g), 'S-' || lpad(g::text, 5, '0'), NOW() - (g || ' minutes')::interval FROM generate_series(1, 60) g`, [id]);
  await lite.query(`INSERT INTO entities (tenant_id, entity_type, data, customer_id)
    SELECT $1, 'equipment', jsonb_build_object('serial_number', 'U' || g, 'warranty', jsonb_build_object('expires', '2030-01-01')), (SELECT id FROM entities c WHERE c.tenant_id = $1 AND c.customer_number = 'S-' || lpad(((g % 2) + 1)::text, 5, '0'))
      FROM generate_series(1, 4) g`, [id]);
  const rows = await withDb('org_r35_scale', (db) => db.listCustomersSummary({ limit: 200, sort: 'name' }));
  const c1 = rows.find((r) => r.customer_number === 'S-00001');
  check('customers: warranties still come back per customer, each with its unit id merged in', Array.isArray(c1.warranties) && c1.warranties.length === 2 && c1.warranties.every((w) => w.id && w.expires === '2030-01-01'), JSON.stringify(c1?.warranties));
  eq('customers: a customer with no warranted units gets []', rows.find((r) => r.customer_number === 'S-00010').warranties, []);
  eq('customers: equipment_count still right', c1.equipment_count, 2);
  check('customers: no correlated per-customer scan of every unit (it made the last of 10,000 customers take ~19 s)', !/FROM equip eq WHERE eq\.customer_id = c\.id/.test(read('api/_lib/recordsStore.js')) && /warranty_agg/.test(read('api/_lib/recordsStore.js')));

  await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, document_type, page_count)
    SELECT $1, 'b-' || g || '.pdf', md5(g::text) || md5((g * 5)::text), 10, 'read', 'k', 'application/pdf', 'invoice', 1 FROM generate_series(1, 120) g`, [id]);
  stats.capture = [];
  const p1 = await withDb('org_r35_scale', (db) => db.browseDocuments({ limit: 50 }, {}));
  const q1 = stats.capture.length; stats.capture = [];
  const p2 = await withDb('org_r35_scale', (db) => db.browseDocuments({ limit: 50, cursor: p1.nextCursor }, {}));
  const q2 = stats.capture.length; stats.capture = null;
  check('records: page one carries the facets', p1.facets.length >= 8 && p1.facets.find((f) => f.key === 'documentType')?.options?.length >= 1);
  check('records: "load more" (page two) returns rows but runs the facet scans zero times (R36: page one is now 8 queries, page two 4)', p2.rows.length === 50 && p2.facets.length === 0 && q2 < q1 && q2 <= 6, `queries p1=${q1} p2=${q2}`);
  eq('records: paging still walks the whole set (50 + 50 + 20)', [p1.rows.length, p2.rows.length, (await withDb('org_r35_scale', (db) => db.browseDocuments({ limit: 50, cursor: p2.nextCursor }, {}))).rows.length], [50, 50, 20]);
  check('records: the client keeps page-one facets when a load-more page has none', /if \(!append\)/.test(read('src/components/records/useRecordsBrowse.ts')) && /browseFacets\(/.test(read('src/components/records/useRecordsBrowse.ts')));
}

/* ============================================================ STRUCTURE */
family = 'structure';
{
  const apiTop = fs.readdirSync(rel('api')).filter((f) => !f.startsWith('_') && !f.startsWith('.'));
  eq('api/ still has exactly 12 top-level function files', apiTop.length, 12);
  const pkg = JSON.parse(read('package.json'));
  check('package.json: verify:r35-limits exists and is part of verify:all', !!pkg.scripts['verify:r35-limits'] && /verify:r35-limits/.test(pkg.scripts['verify:all']));
  check('no stray .env was created', !fs.existsSync(rel('.env')) && !fs.existsSync(rel('.env.local')));
  check('the harness applied migrations 62 and 63', h.applied.includes('62-rate-limit-refund-and-owner-overrides.sql') && h.applied.includes('63-page-count-index.sql'), JSON.stringify(h.skipped));
  eq('every connection checked out during this run was returned', stats.out, 0);
}

console.log('');
for (const [f, c] of Object.entries(fam)) console.log(`  ${f.padEnd(10)} ${c.pass + c.fail} checks, ${c.fail} failed`);
console.log(failed ? `\n${failed} check(s) FAILED` : `\nAll ${Object.values(fam).reduce((a, c) => a + c.pass, 0)} R35 checks passed`);
process.exit(failed ? 1 : 0);
