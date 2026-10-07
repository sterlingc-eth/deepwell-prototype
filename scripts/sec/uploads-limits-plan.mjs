import crypto from 'node:crypto';
import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('uploads');
const { default: upload } = await H.importApi('api/upload-url.js');
const { default: readDoc } = await H.importApi('api/read-document.js');
const { default: extract } = await H.importApi('api/extract.js');
const { default: ask } = await H.importApi('api/ask.js');
const { default: records } = await H.importApi('api/records.ts');
const { default: status } = await H.importApi('api/document-status.js');
const { default: v1 } = await H.importApi('api/v1.js');
const { default: account } = await H.importApi('api/account.js');
const { default: billing } = await H.importApi('api/billing.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tu = H.tenantUuid;
const body = (s) => ({ filename: 'a.pdf', sha256: sha(s), contentType: 'application/pdf', sizeBytes: 5000 });
const reset = async () => { await H.lite.query('DELETE FROM rate_limit_windows'); await H.lite.query('DELETE FROM usage_counters'); H.reset(); };

/* ================= 8. RATE LIMITS ================= */
await H.setTenant('A', "plan='solo', billing_status='active'"); await H.setTenant('B', "plan='solo', billing_status='active'");
await reset();
let first429 = 0; const spoofed = [];
for (let i = 1; i <= 90; i++) {
  const r = await H.call(upload, { token: H.tok.adminA, body: { filename: '', sha256: 'x' }, headers: { 'x-forwarded-for': `10.9.${i % 250}.${i}` } });
  if (r.status === 429 && !first429) first429 = i;
}
R.check('L1-minute', 'solo ingest limit (60/min) triggers a 429 even when every request spoofs a different X-Forwarded-For', first429 > 0 && first429 <= 62, { severity: 'High', route: 'upload-url', detail: `first 429 at request ${first429}` });
const afterSpoof = await H.call(upload, { token: H.tok.adminA, body: base0(), headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'x-vercel-forwarded-for': '9.9.9.9' } });
function base0() { return { filename: 'a.pdf', sha256: sha('r1'), contentType: 'application/pdf', sizeBytes: 1000 }; }
R.check('L1-spoof', 'still limited after exhausting with new spoofed IP headers', afterSpoof.status === 429, { severity: 'High', route: 'upload-url', detail: String(afterSpoof.status) });
const memberSame = await H.call(upload, { token: H.tok.memberA, body: base0() });
R.check('L2-org-shared', 'limit is per company, not per user (another user of A is also limited)', memberSame.status === 429, { severity: 'Medium', route: 'upload-url', detail: String(memberSame.status) });
const bOk = await H.call(upload, { token: H.tok.adminB, body: { ...base0(), sha256: sha('b1') } });
R.check('L3-noisy-neighbour', "A exhausting its limit does not 429 company B", bOk.status === 200, { severity: 'High', route: 'upload-url', detail: String(bOk.status) });
// batch cost
await reset();
const bt = await H.call(upload, { token: H.tok.adminA, body: { files: Array.from({ length: 50 }, (_, i) => ({ ...base0(), sha256: sha('bt' + i) })) } });
const bt2 = await H.call(upload, { token: H.tok.adminA, body: { files: Array.from({ length: 50 }, (_, i) => ({ ...base0(), sha256: sha('bu' + i) })) } });
R.check('L4-batch-cost', 'a 50-file batch costs 50 units (second 50-file batch in the same minute on solo(60) is 429)', bt.status === 200 && bt2.status === 429, { severity: 'Medium', route: 'upload-url', detail: `${bt.status} ${bt2.status}` });
// per-day cap via counters
await reset();
await H.lite.query("SELECT increment_rate_limit_window($1, 'day:ingest', $2::timestamptz, 99999)", [tu.A, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())).toISOString()]);
const day = await H.call(upload, { token: H.tok.adminA, body: base0() });
R.check('L5-daily', 'per-day ingest cap enforced (429 after counter is over the daily limit)', day.status === 429, { severity: 'Medium', route: 'upload-url', detail: `${day.status} ${day.text.slice(0, 80)}` });
// body-size: declared sizes are per-route config (not executable offline) -> list
// Fail-closed
await reset();
await H.lite.query('ALTER FUNCTION increment_rate_limit_window(uuid, text, timestamptz, integer) RENAME TO irlw_broken');
let n429 = 0; for (let i = 0; i < 90; i++) { const r = await H.call(upload, { token: H.tok.adminA, body: { filename: '', sha256: 'x' } }); if (r.status === 429) n429++; }
await H.lite.query('ALTER FUNCTION irlw_broken(uuid, text, timestamptz, integer) RENAME TO increment_rate_limit_window');
R.check('L6-failclosed-ratelimit', 'when the rate-limit store errors, requests are refused (fail closed)', n429 > 0, { severity: 'Medium', route: 'rateLimit.limit (all routes)', detail: `90 requests with the rate-limit function broken: ${n429} refused (limit() logs "failing open" and lets all through, so the 60/min cap vanishes)` });
// model budget fail-open
await reset();
await H.lite.query("INSERT INTO usage_counters (tenant_id, day, requests, model_calls) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 0, 999999) ON CONFLICT (tenant_id, day) DO UPDATE SET model_calls = 999999", [tu.A]);
const { assertModelBudget } = await H.importApi('api/_lib/rateLimit.js');
let budgetBlocks = false; try { await assertModelBudget({ tenantKey: H.orgA, tenantName: H.orgA }); } catch (e) { budgetBlocks = e.name === 'ModelBudgetExceededError'; }
R.check('L7-budget-enforced', 'daily model-call budget refuses when used >= limit', budgetBlocks, { severity: 'High', route: 'rateLimit.assertModelBudget' });
await H.lite.query('ALTER FUNCTION get_usage_counters(uuid, integer) RENAME TO guc_broken');
let blocksBroken = false; try { await assertModelBudget({ tenantKey: H.orgA, tenantName: H.orgA }); } catch (e) { blocksBroken = e.name === 'ModelBudgetExceededError'; }
await H.lite.query('ALTER FUNCTION guc_broken(uuid, integer) RENAME TO get_usage_counters');
R.check('L8-failclosed-budget', 'when the usage store errors the model budget check refuses rather than allowing spend', blocksBroken, { severity: 'Medium', route: 'rateLimit.getDailyModelBudgetStatus (read-document inline, extract, queue)', detail: 'getDailyModelBudgetStatus catch returns exceeded:false ("allowing ingestion")' });
await reset();
// unmetered routes
let rec429 = 0; for (let i = 0; i < 400; i++) { const r = await H.call(records, { token: H.tok.memberA, body: { action: 'getSchemaVersion' } }); if (r.status === 429) rec429++; }
R.check('L9-records-unmetered', 'api/records (all read/list/update actions) has a rate limit (400 calls/min from one member)', rec429 > 0, { severity: 'Low', route: 'records', detail: `${rec429}/400 limited; only createDocument is metered` });
let st429 = 0; for (let i = 0; i < 400; i++) { const r = await H.call(status, { token: H.tok.memberA, body: { documentIds: [crypto.randomUUID()] } }); if (r.status === 429) st429++; }
R.check('L10-status-unmetered', 'document-status has a rate limit (400 polls/min)', st429 > 0, { severity: 'Low', route: 'document-status', detail: `${st429}/400 limited; route calls no limit()` });
/* ================= 9. PLAN / BILLING STATE ================= */
await H.setTenant('A', "plan='fleet', billing_status='active'");
await reset();
const own = await H.call(upload, { token: H.tok.adminA, body: { ...base0(), sha256: sha('plan-doc') } });
const docId = own.body.documentId;
const states = {
  canceled: "billing_status='canceled'",
  none: "billing_status='none'",
  trial_expired: "billing_status='trialing', trial_ends_at = now() - interval '10 days'",
  past_due_old: "billing_status='past_due', current_period_end = now() - interval '40 days', limits = jsonb_set(coalesce(limits,'{}'::jsonb), '{_billing}', '{\"pastDueSince\": 1}')",
};
for (const [name, sets] of Object.entries(states)) {
  await H.setTenant('A', `plan='fleet', ${sets}`);
  await reset();
  const calls = {
    upload: await H.call(upload, { token: H.tok.adminA, body: { ...base0(), sha256: sha('p' + name) } }),
    batch: await H.call(upload, { token: H.tok.adminA, body: { files: [{ ...base0(), sha256: sha('pb' + name) }] } }),
    createDoc: await H.call(records, { token: H.tok.adminA, body: { action: 'createDocument', original_filename: 'x.pdf', sha256_hash: sha('pc' + name), content_type: 'application/pdf', file_size_bytes: 100 } }),
    read: await H.call(readDoc, { token: H.tok.adminA, body: { documentId: docId, sync: true, force: true } }),
    extract: await H.call(extract, { token: H.tok.adminA, body: { documentId: docId } }),
    askq: await H.call(ask, { token: H.tok.adminA, body: { question: 'how many customers do I have', today: '2026-09-25' } }),
  };
  const batchBlocked = calls.batch.status === 402 || (calls.batch.status === 200 && (calls.batch.body?.results ?? []).every((x) => x.status === 402 || x.error));
  const stateBlocksModel = name !== 'past_due_old';
  R.check(`P1-${name}-upload`, `${name}: new uploads refused`, calls.upload.status === 402, { severity: 'High', route: 'upload-url', detail: String(calls.upload.status) });
  R.check(`P1-${name}-batch`, `${name}: batch uploads refused`, batchBlocked, { severity: 'High', route: 'upload-url batch', detail: `${calls.batch.status} ${calls.batch.text.slice(0, 80)}` });
  R.check(`P1-${name}-createDocument`, `${name}: records.createDocument refused`, calls.createDoc.status === 402, { severity: 'High', route: 'records createDocument', detail: String(calls.createDoc.status) });
  R.check(`P1-${name}-read`, `${name}: read-document (model spend) refused`, calls.read.status === 402 || !stateBlocksModel, { severity: 'High', route: 'read-document', detail: String(calls.read.status) });
  R.check(`P1-${name}-extract`, `${name}: extract (model spend) refused`, calls.extract.status === 402 || !stateBlocksModel, { severity: 'High', route: 'extract', detail: String(calls.extract.status) });
  R.check(`P1-${name}-ask`, `${name}: ask refused`, calls.askq.status === 402 || name === 'past_due_old' || name === 'none' && false, { severity: 'High', route: 'ask', detail: String(calls.askq.status) });
  if (name === 'past_due_old') console.log('  NOTE past_due(40d, past grace): read', calls.read.status, 'extract', calls.extract.status, 'ask', calls.askq.status);
  // existing-doc open original still works (intended)
}
/* API key: minted on fleet, tenant then downgrades/cancels */
await H.setTenant('A', "plan='fleet', billing_status='active'"); await reset();
const key = await H.mintKey('A', ['read', 'ingest', 'ask']);
const kc = (q) => H.call(v1, { method: 'GET', headers: { authorization: `Bearer ${key}` }, query: q });
const kOk = await kc({ resource: 'customers' });
await H.setTenant('A', "plan='shop', billing_status='active'");
const kShop = await kc({ resource: 'customers' });
const kIngestShop = await H.call(upload, { headers: { authorization: `Bearer ${key}` }, body: { ...base0(), sha256: sha('kshop') } });
R.check('P2-api-fleet-only', 'API key stops working when the plan drops below Fleet', kOk.status === 200 && kShop.status === 403 && kIngestShop.status === 403, { severity: 'High', route: 'v1/* + apiKeyAuth', detail: `fleet ${kOk.status}, shop ${kShop.status}, upload ${kIngestShop.status}` });
await H.setTenant('A', "plan='fleet', billing_status='canceled'");
const kCanc = await kc({ resource: 'customers' });
const kCancUp = await H.call(upload, { headers: { authorization: `Bearer ${key}` }, body: { ...base0(), sha256: sha('kcanc') } });
R.check('P2-api-canceled-ingest', 'API key cannot ingest when billing is canceled', kCancUp.status === 402, { severity: 'High', route: 'upload-url via key', detail: String(kCancUp.status) });
console.log('  NOTE canceled tenant API key read of customers ->', kCanc.status);
/* page cap enforced server side */
await H.setTenant('A', "plan='solo', billing_status='active'"); await reset();
const docRow = (await H.lite.query('SELECT id FROM documents WHERE tenant_id=$1 LIMIT 1', [tu.A])).rows[0].id;
await H.lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) SELECT $1, $2, 100000+g, 'x' FROM generate_series(1, 800) g`, [tu.A, docRow]).catch((e) => console.log('pages insert', e.message));
const cap1 = await H.call(upload, { token: H.tok.adminA, body: { ...base0(), sha256: sha('cap1') } });
const cap2 = await H.call(upload, { token: H.tok.adminA, body: { files: [{ ...base0(), sha256: sha('cap2') }] } });
const cap3 = await H.call(records, { token: H.tok.adminA, body: { action: 'createDocument', original_filename: 'x.pdf', sha256_hash: sha('cap3'), content_type: 'application/pdf', file_size_bytes: 100 } });
R.check('P3-pagecap-single', 'solo over 750 pages/month: upload refused server-side', cap1.status === 402, { severity: 'High', route: 'upload-url', detail: `${cap1.status} ${cap1.text.slice(0, 80)}` });
R.check('P3-pagecap-batch', 'over page cap: batch item refused', cap2.status === 402 || (cap2.body?.results ?? []).every((x) => x.status === 402), { severity: 'High', route: 'upload-url batch', detail: cap2.text.slice(0, 100) });
R.check('P3-pagecap-createDocument', 'over page cap: records.createDocument refused', cap3.status === 402, { severity: 'High', route: 'records createDocument', detail: `${cap3.status}` });
const cap4 = await H.call(readDoc, { token: H.tok.adminA, body: { documentId: (await H.lite.query("SELECT id FROM documents WHERE tenant_id=$1 AND page_count=0 LIMIT 1", [tu.A])).rows[0]?.id ?? docId, sync: true, force: true } });
console.log('  NOTE over-cap read-document on an already-uploaded doc ->', cap4.status);
/* client-side-only toggles: tenant limits JSON writable by tenant user? */
const lim = await H.call(records, { token: H.tok.adminA, body: { action: 'updateEntity', id: tu.A, updates: { limits: { extraPagesPerMonth: 999999 } } } });
const limRow = (await H.lite.query('SELECT limits FROM tenants WHERE id=$1', [tu.A])).rows[0];
R.check('P4-limits-not-writable', 'a tenant admin cannot raise own limits/plan via records or account routes', !JSON.stringify(limRow.limits ?? {}).includes('999999'), { severity: 'High', route: 'records' });
const planWrite = await H.lite.query("UPDATE tenants SET plan='fleet' WHERE id=$1 RETURNING id", [tu.A]).catch((e) => ({ rows: [] }));
// via RLS role: can tenant context update tenants table? attempt through the app role
const { withTenant } = await H.importApi('api/_lib/recordsStore.js');
let canWrite = false;
try { await withTenant({ tenantKey: H.orgA, tenantName: H.orgA }, async (db) => { const r = await db.raw("UPDATE tenants SET plan='fleet', billing_status='active', limits='{\"extraPagesPerMonth\":99999999}' WHERE id=(current_setting('app.tenant_id', true))::uuid RETURNING id", []); canWrite = r.rows.length > 0; }); } catch { canWrite = false; }
await H.setTenant('A', "plan='fleet', billing_status='active'");
R.finish();
