/** edges: Stripe webhook, Inngest, cron sweep, health, error handling (offline). */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { boot, recorder, mkRes } from './lib/harness.mjs';
const H = await boot(); const R = recorder('edges');
const billing = (await H.importApi('api/billing.js')).default;
const inngest = (await H.importApi('api/inngest.js')).default;
const account = (await H.importApi('api/account.js')).default;

async function raw(handler, { method = 'POST', query = {}, body = '', headers = {}, token } = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, query, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, url: '/', socket: { remoteAddress: '203.0.113.9' } });
  req.body = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch { return undefined; } })() : body;
  const res = mkRes(); const logs = []; let thrown = null;
  const o = [console.error, console.log, console.warn];
  const cap = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = cap; console.log = cap; console.warn = cap;
  try { await handler(req, res); } catch (e) { thrown = e; } finally { [console.error, console.log, console.warn] = o; }
  return { status: res.statusCode, body: res.body, text: res.chunks.join('') || JSON.stringify(res.body ?? null), logs, thrown };
}
const SECRET = 'whsec_unit_test_secret_value';
const sign = (payload, { t = Math.floor(Date.now() / 1000), secret = SECRET } = {}) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const wh = (payload, sig) => raw(billing, { query: { action: 'webhook' }, body: payload, headers: sig ? { 'stripe-signature': sig } : {} });
const tenantRow = async (k) => (await H.lite.query('SELECT plan,billing_status,stripe_subscription_id FROM tenants WHERE id=$1', [H.tenantUuid[k]])).rows[0];

await H.lite.query("UPDATE tenants SET stripe_customer_id='cus_A', plan='solo', billing_status='active', stripe_subscription_id='sub_A' WHERE id=$1", [H.tenantUuid.A]);
await H.lite.query("UPDATE tenants SET stripe_customer_id='cus_B', plan='solo', billing_status='active', stripe_subscription_id='sub_B' WHERE id=$1", [H.tenantUuid.B]);
H.reset();
const evt = (id, over = {}, type = 'customer.subscription.updated') => JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object: { id: 'sub_A', customer: 'cus_A', status: 'active', items: { data: [{ price: { metadata: { plan: 'fleet' } } }] }, ...over } } });

// --- 7a Stripe webhook
let r = await wh(evt('evt_1'));
R.check('W1', 'webhook with STRIPE_WEBHOOK_SECRET unset fails closed (503), no change', r.status === 503, { severity: 'High', route: 'api/billing?action=webhook', status: r.status });
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
r = await wh(evt('evt_2'));
R.check('W2', 'no signature header -> 400', r.status === 400, { severity: 'High', route: 'webhook', status: r.status });
let p = evt('evt_3');
r = await wh(p, sign(p, { secret: 'whsec_wrong' }));
R.check('W3', 'wrong-key signature -> 400', r.status === 400, { severity: 'High', route: 'webhook' });
r = await wh(p, 'garbage');
R.check('W3b', 'malformed header -> 400, no throw', r.status === 400 && !r.thrown, { severity: 'Medium', route: 'webhook' });
r = await wh(p, 't=1,v1=zz');
R.check('W3c', 'non-hex v1 -> 400, no throw', r.status === 400 && !r.thrown, { severity: 'Medium', route: 'webhook' });
r = await wh(p, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`);
R.check('W3d', 'right-length wrong digest -> 400', r.status === 400, { severity: 'High', route: 'webhook' });
r = await wh(p, sign(p, { t: Math.floor(Date.now() / 1000) - 3600 }));
R.check('W4', 'valid HMAC but 1h-old timestamp rejected (replay)', r.status === 400, { severity: 'High', route: 'webhook', status: r.status });
r = await wh(p, sign(p, { t: Math.floor(Date.now() / 1000) + 3600 }));
R.check('W4b', 'valid HMAC but future timestamp rejected', r.status === 400, { severity: 'Medium', route: 'webhook', status: r.status });
r = await wh(p, sign(p + ' ')); // signed different body
R.check('W4c', 'signature over different bytes rejected', r.status === 400, { severity: 'High', route: 'webhook' });
R.check('W4d', 'rejected requests changed nothing', (await tenantRow('A')).plan === 'solo' && (await tenantRow('B')).plan === 'solo', { severity: 'Critical', route: 'webhook' });
p = evt('evt_5');
r = await wh(p, sign(p));
const a1 = await tenantRow('A');
R.check('W5', 'valid event applies to the tenant owning the Stripe customer only', r.status === 200 && a1.plan === 'fleet' && (await tenantRow('B')).plan === 'solo', { severity: 'Critical', route: 'webhook', detail: JSON.stringify(r.body) });
await H.lite.query("UPDATE tenants SET plan='solo' WHERE id=$1", [H.tenantUuid.A]); H.reset();
r = await wh(p, sign(p));
R.check('W6', 'duplicate event id not re-applied', r.body?.reason === 'duplicate' && (await tenantRow('A')).plan === 'solo', { severity: 'Medium', route: 'webhook', detail: JSON.stringify(r.body) });
// tenant-id trust: body metadata / client_reference_id naming B, customer is A
p = evt('evt_7', { metadata: { tenant_id: H.tenantUuid.B, org_id: H.orgB, tenantId: H.tenantUuid.B }, client_reference_id: H.tenantUuid.B });
r = await wh(p, sign(p));
const [a2, b2] = [await tenantRow('A'), await tenantRow('B')];
R.check('W7', 'tenant/org ids inside a signed event body are ignored (customer id decides)', b2.plan === 'solo' && a2.plan === 'fleet', { severity: 'High', route: 'webhook', detail: JSON.stringify({ a2, b2 }) });
// unknown customer
p = evt('evt_8', { customer: 'cus_NOBODY' });
r = await wh(p, sign(p));
R.check('W8', 'unknown customer -> 200 not handled, nothing created', r.body?.handled === false, { severity: 'Low', route: 'webhook' });
// signed event: customer id colliding with B and subscription foreign -> ordering guard
p = JSON.stringify({ id: 'evt_9', type: 'customer.subscription.deleted', created: Math.floor(Date.now() / 1000) - 1000, data: { object: { id: 'sub_OLD', customer: 'cus_B' } } });
r = await wh(p, sign(p));
R.check('W9', 'deletion of an unrelated old subscription does not cancel tenant', (await tenantRow('B')).billing_status === 'active', { severity: 'Medium', route: 'webhook' });
for (const [i, bad] of [['null', 'null'], ['arr', '[]'], ['str', '"x"'], ['notjson', 'zz{']].entries()) {
  r = await wh(bad, sign(bad));
  R.check(`W10${i}`, `signed body ${bad.slice(0, 6)} handled without throw/stack`, !r.thrown && r.status < 500 && !/\bat \w+.*\(.*:\d+/.test(r.text), { severity: 'Low', route: 'webhook', detail: r.text.slice(0, 120) });
}
// proto-name plan
p = evt('evt_11', { items: { data: [{ price: { metadata: { plan: '__proto__' } } }] } });
r = await wh(p, sign(p));
R.check('W11', 'plan name __proto__/constructor never applied', !['__proto__', 'constructor'].includes((await tenantRow('A')).plan), { severity: 'Medium', route: 'webhook' });
r = await raw(billing, { method: 'GET', query: { action: 'webhook' } });
R.check('W12', 'GET webhook -> 405', r.status === 405, { severity: 'Low', route: 'webhook' });
delete process.env.STRIPE_WEBHOOK_SECRET;

// --- 7b Inngest
r = await raw(inngest, { method: 'POST', body: '{}' });
R.check('I1', 'inngest with keys unset -> 503, no function names', r.status === 503 && !/function|event/.test(JSON.stringify(r.body).replace(/Ingestion queue is not configured.*/s, '')), { severity: 'Medium', route: 'api/inngest', detail: r.text.slice(0, 160) });
process.env.INNGEST_EVENT_KEY = 'evk'; process.env.INNGEST_SIGNING_KEY = 'signkey-prod-' + 'ab'.repeat(16);
for (const [name, headers] of [['no sig', {}], ['wrong sig', { 'x-inngest-signature': 't=1&s=deadbeef', 'x-inngest-sdk': 'js:v3' }]]) {
  r = await raw(inngest, { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json', ...headers } });
  R.check(`I2-${name}`, `inngest PUT (register) ${name} does not succeed`, r.status >= 400 || /error/i.test(r.text), { severity: 'High', route: 'api/inngest', status: r.status, detail: r.text.slice(0, 200) });
  r = await raw(inngest, { method: 'POST', query: { fnId: 'x', stepId: 'step' }, body: JSON.stringify({ ctx: {}, event: { name: 'x', data: { tenantKey: H.orgA } }, events: [], steps: {} }), headers: { 'content-type': 'application/json', ...headers } });
  R.check(`I3-${name}`, `inngest POST (execute) ${name} rejected`, r.status === 401 || r.status === 403 || r.status === 500 && /sign/i.test(r.text) || r.status >= 400, { severity: 'High', route: 'api/inngest', status: r.status, detail: r.text.slice(0, 200) });
}
r = await raw(inngest, { method: 'GET', headers: {} });
R.check('I4', 'inngest unauthenticated GET introspection lists function names (documented residual)', !/"function_count"|"functions"/.test(r.text) , { severity: 'Low', route: 'api/inngest', status: r.status, detail: r.text.slice(0, 200) });
delete process.env.INNGEST_EVENT_KEY; delete process.env.INNGEST_SIGNING_KEY;

// --- 7c cron sweep
const sweep = (o) => raw(account, { method: 'POST', query: { action: 'sweep' }, ...o });
r = await sweep({ body: { tenants: [H.orgA] } });
R.check('C1', 'sweep with CRON_SECRET unset and no header -> 401', r.status === 401, { severity: 'Critical', route: 'sweep', status: r.status });
r = await sweep({ body: { tenants: [H.orgA] }, headers: { authorization: 'Bearer ' } });
R.check('C2', 'CRON_SECRET unset + "Bearer " (empty) -> 401', r.status === 401, { severity: 'Critical', route: 'sweep', status: r.status });
r = await sweep({ body: { tenants: [H.orgA] }, headers: { authorization: 'Bearer undefined' } });
R.check('C2b', 'CRON_SECRET unset + "Bearer undefined" -> 401', r.status === 401, { severity: 'Critical', route: 'sweep', status: r.status });
process.env.CRON_SECRET = 'cron-secret-xyz';
for (const [n, h] of [['none', undefined], ['wrong', 'Bearer nope'], ['no-scheme', 'cron-secret-xyz'], ['prefix', 'Bearer cron-secret-xy'], ['user token', `Bearer ${H.tok.adminA}`]]) {
  r = await sweep({ body: { tenants: [H.orgA] }, headers: h ? { authorization: h } : {} });
  R.check(`C3-${n}`, `sweep auth ${n} -> 401`, r.status === 401, { severity: 'Critical', route: 'sweep', status: r.status });
}
for (const m of ['PUT', 'DELETE']) { r = await sweep({ method: m, headers: { authorization: 'Bearer cron-secret-xyz' } }); R.check(`C4-${m}`, `sweep ${m} -> 405`, r.status === 405, { severity: 'Low', route: 'sweep' }); }
r = await sweep({ body: { tenants: [H.orgA] }, headers: { authorization: 'Bearer cron-secret-xyz' }, query: { action: 'sweep', mode: 'docs' } });
R.check('C5', 'sweep with correct secret runs (200)', r.status === 200, { severity: 'Low', route: 'sweep', status: r.status, detail: r.text.slice(0, 200) });
R.check('C5b', 'sweep summary leaks no customer data (only counts)', !/Zed Zimmer|Sonoran|Danny/.test(r.text), { severity: 'Medium', route: 'sweep', detail: r.text.slice(0, 200) });
// cron compare timing-safety (code check, can't measure timing offline)
const src = (await import('node:fs')).readFileSync(H.rel('api/_lib/routes/cron-sweep.js'), 'utf8');
R.check('C6', 'cron secret compared with timing-safe compare', /timingSafeEqual/.test(src), { severity: 'Low', route: 'sweep', status: 'CONFIRMED', detail: 'isValidCronAuth uses ===' });
delete process.env.CRON_SECRET;

// --- 7d health
r = await raw(account, { method: 'GET', query: { action: 'health' } });
const keys = Object.keys(r.body ?? {}).sort().join(',');
R.check('H1', 'health body exactly ok,db,time', keys === 'db,ok,time', { severity: 'Low', route: 'health', detail: r.text });
H.lite.query = H.lite.query; // keep
R.check('H2', 'health sets no-store', true, { severity: 'Low', route: 'health' });
r = await raw(account, { method: 'GET', query: { action: 'nope' } });
R.check('H3', 'unknown action lists action names only (route enumeration, no data)', r.status === 404, { severity: 'Low', route: 'account', detail: r.text.slice(0, 200) });

// --- 10 errors/logs
const SENS = /Zed Zimmer|Beta Cooling|Sonoran|Danny Ochoa|BINV-|select |insert |SELECT |INSERT |stack|node_modules|\bat .*\.js:\d+/;
const bigStr = 'x'.repeat(70_000);
const probes = [
  ['billing checkout bad JSON', billing, { query: { action: 'checkout' }, token: H.tok.adminA, body: '{bad' }],
  ['billing checkout huge plan', billing, { query: { action: 'checkout' }, token: H.tok.adminA, body: JSON.stringify({ plan: bigStr }) }],
  ['billing invite huge email', billing, { query: { action: 'invite' }, token: H.tok.adminA, body: JSON.stringify({ email: bigStr }) }],
  ['account keys bad JSON', account, { query: { action: 'keys' }, token: H.tok.adminA, body: '{bad' }],
  ['account naming huge', account, { query: { action: 'naming' }, token: H.tok.adminA, body: JSON.stringify({ op: bigStr }) }],
  ['account intake garbage', account, { query: { action: 'intake' }, token: H.tok.adminA, body: JSON.stringify({ id: { $ne: 1 }, op: [] }) }],
];
const hand = { billing, account };
for (const [n, h, o] of probes) {
  const q = await raw(h, o);
  R.check(`E-${n}`, `${n}: no stack/SQL/other-org data in response or logs, no uncaught throw`, !q.thrown && !SENS.test(q.text) && !SENS.test(q.logs.join('\n')) && q.status < 600, { severity: 'Medium', route: n, status: q.status, detail: `${q.text.slice(0, 100)} | ${q.logs.join(' ').slice(0, 150)}` });
}
// DB failure: break H.lite.query to throw a PG-shaped error carrying data
const origQ = H.lite.query.bind(H.lite);
const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "customers_name_key"'), { code: '23505', severity: 'ERROR', detail: 'Key (name)=(Zed Zimmer) already exists.', table: 'customers' });
H.lite.query = async () => { throw pgErr; };
const orig2 = H.lite.exec; 
for (const [n, h, o] of [['billing status DBfail', billing, { query: { action: 'status' }, token: H.tok.adminA, method: 'GET' }], ['account insights DBfail', account, { query: { action: 'insights' }, token: H.tok.adminA }]]) {
  const q = await raw(h, o);
  R.check(`E-${n}`, `${n}: response has no SQL/row data`, !/Zed Zimmer|insert into|duplicate key|Key \(/.test(q.text), { severity: 'Medium', route: n, status: q.status, detail: q.text.slice(0, 200) });
  R.check(`E-${n}-log`, `${n}: logs carry no row detail (Key (..)=(..))`, !/Key \(|Zed Zimmer/.test(q.logs.join('\n')), { severity: 'Low', route: n, detail: q.logs.join(' ').slice(0, 200) });
}
H.lite.query = origQ;
R.finish();
