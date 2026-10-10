/**
 * Sample API usage: runs every READ endpoint of the public API (/api/v1/*) against a local harness and prints what a
 * caller gets back. Everything is in-process: a real Postgres (PGlite), the real route handlers, the real key code.
 * The API key is minted here, on a throwaway shop, with the app's own createApiKey(); it is not a real key and
 * touches no real data. No network call is made (outbound fetch is blocked by the harness).
 *
 *   node scripts/api-sample.mjs            # prints a readable report
 *   node scripts/api-sample.mjs --json     # prints one JSON object (used by the check at the bottom of this file's tests)
 *
 * Exit code is 0 only when every endpoint answered as documented.
 */
import { startHarness, seedCustomer, seedEquipment } from './lib/t5-harness.mjs';

const asJson = process.argv.includes('--json');
const out = [];
const say = (s = '') => { if (!asJson) console.log(s); };
let failures = 0;
const expect = (name, ok, detail = '') => { if (!ok) failures++; out.push({ name, ok, detail }); say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`); };

const h = await startHarness();
const v1 = (await import('../api/v1.js')).default;
const { createApiKey } = await import('../api/_lib/routes/keys.js');
const { _resetBillingRowCache } = await import('../api/_lib/plan.js');

/* ---------------------------------------------------------------- sample shop */
const u = (k, n) => `${k}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const shop = [
  { c: 1, number: 'C-00001', name: 'Carol Rios', address: '412 Elm St, Mesa, AZ 85201', email: 'carol.rios@example.com', phone: '(480) 555-0148', mfr: 'Trane', model: 'XR16', serial: 'TR2306A1234', left: 40 },
  { c: 2, number: 'C-00002', name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234', email: 'office@plazadental.example.com', phone: '(480) 555-0102', mfr: 'Lennox', model: 'XC21', serial: 'LX1905D9090', left: 900 },
  { c: 3, number: 'C-00003', name: 'Harbor Point Apartments', address: '5600 W Camelback Rd, Phoenix, AZ 85031', email: 'office@harborpoint.example.com', phone: '(602) 555-0190', mfr: 'Carrier', model: '24ACC636', serial: 'CA1807B7788', left: -100 },
];
for (const s of shop) {
  await seedCustomer(h, { id: u('c', s.c), number: s.number, name: s.name, address: s.address, email: s.email, phone: s.phone });
  await seedEquipment(h, { id: u('e', s.c), customerId: u('c', s.c), mfr: s.mfr, model: s.model, serial: s.serial, type: 'condensing unit', installed: day(s.left - 3650), address: s.address, customerName: s.name,
    warranty: { installDate: day(s.left - 3650), expires: day(s.left), expiresBasis: 'printed', termYears: 10, registrationOnFile: day(s.left - 3620) } });
  const docId = u('d', s.c);
  await h.lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [docId, h.tenantId, `${s.name.split(' ')[0].toLowerCase()}-warranty.pdf`, 'warranty-registration', `sample-${s.c}`, 'verified']);
  await h.lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [h.tenantId, docId, u('e', s.c)]);
  await h.lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [h.tenantId, docId, u('c', s.c)]);
}

/* ------------------------------------------------- mint a throwaway test key */
say('1. Create a test key (the app does this when an admin clicks "Create key"; here it is called directly)');
const made = await createApiKey({ tenantKey: h.tenantKey, tenantName: 'Sample HVAC' }, { userId: 'user_owner' }, { name: 'Sample read key', scopes: ['read'] });
expect('key created (201)', made.status === 201, String(made.status));
const KEY = made.body.key;
expect('key looks like dw_live_ + 64 hex characters', /^dw_live_[0-9a-f]{64}$/.test(KEY));
say(`  shown once: ${KEY.slice(0, 12)}…  (throwaway, only valid inside this run)`);
const ingestOnly = (await createApiKey({ tenantKey: h.tenantKey }, { userId: 'user_owner' }, { name: 'Sample ingest-only key', scopes: ['ingest'] })).body.key;

/* ------------------------------------------------------------------ the calls */
const get = (resource, query = {}, key = KEY) => h.call(v1, { method: 'GET', query: { resource, ...query }, token: key });
const shown = [];
async function run(label, curlPath, resource, query, summarise, key) {
  const r = await get(resource, query, key);
  const ok = r.statusCode === 200;
  const s = ok ? summarise(r.body) : JSON.stringify(r.body);
  shown.push({ label, curlPath, status: r.statusCode, summary: s });
  say(`  GET ${curlPath}\n      -> ${r.statusCode}  ${s}`);
  expect(`${label}: 200`, ok, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r;
}

say('\n2. Run every read endpoint');
const carolId = u('c', 1);
await run('equipment by serial', '/api/v1/equipment?serial=TR2306A1234', 'equipment', { serial: 'TR2306A1234' },
  (b) => `serial ${b.equipment?.serialNumber ?? b.serialNumber ?? '?'}, keys: ${Object.keys(b).join(', ')}`);
await run('equipment by customer', `/api/v1/equipment?customerId=${carolId}`, 'equipment', { customerId: carolId },
  (b) => `keys: ${Object.keys(b).join(', ')}`);
await run('warranty reminder list', '/api/v1/warranty?withinDays=365', 'warranty', { withinDays: '365' },
  (b) => `${b.items.length} item(s): ${b.items.map((i) => `${i.customerName} ${i.tier}`).join('; ')}`);
await run('customer list', '/api/v1/customers?limit=50', 'customers', { limit: '50' },
  (b) => `${b.customers.length} customer(s): ${b.customers.map((c) => c.name).join(', ')}`);
await run('customer search', '/api/v1/customers?q=carol', 'customers', { q: 'carol' },
  (b) => `${b.customers.length} match(es)`);
await run('one customer by number', '/api/v1/customer?number=C-00001', 'customer', { number: 'C-00001' },
  (b) => `keys: ${Object.keys(b).join(', ')}`);
await run('export customers (CSV)', '/api/v1/export?kind=customers', 'export', { kind: 'customers' },
  (b) => `${String(b).trim().split('\n').length - 1} row(s); header: ${String(b).split('\n')[0]}`);
await run('export equipment (CSV)', '/api/v1/export?kind=equipment', 'export', { kind: 'equipment' },
  (b) => `${String(b).trim().split('\n').length - 1} row(s)`);
await run('export documents (CSV)', '/api/v1/export?kind=documents', 'export', { kind: 'documents' },
  (b) => `${String(b).trim().split('\n').length - 1} row(s)`);
await run('knowledge graph search', '/api/v1/graph?q=carol', 'graph', { q: 'carol' },
  (b) => `${(b.matches ?? []).length} match(es)`);
await run('knowledge graph around a customer', `/api/v1/graph?node=customer:${carolId}&depth=2`, 'graph', { node: `customer:${carolId}`, depth: '2' },
  (b) => `${(b.nodes ?? []).length} node(s), ${(b.edges ?? []).length} edge(s)`);
await run('intake status', '/api/v1/intake-status', 'intake-status', {},
  (b) => `total ${b.total}, keys: ${Object.keys(b).slice(0, 6).join(', ')}`);

/* ----------------------------------------------- the guard rails, shown on purpose */
say('\n3. Guard rails');
{
  const none = await h.call(v1, { method: 'GET', query: { resource: 'warranty' } });
  expect('no key: 401', none.statusCode === 401, String(none.statusCode));
  const bad = await get('warranty', {}, 'dw_live_' + '0'.repeat(64));
  expect('unknown key: 401', bad.statusCode === 401, String(bad.statusCode));
  const wrong = await get('warranty', {}, ingestOnly);
  expect('ingest-only key cannot read: 403 naming the missing scope', wrong.statusCode === 403 && /"read" scope/.test(wrong.body?.error ?? ''), JSON.stringify(wrong.body));
  const post = await h.call(v1, { method: 'POST', query: { resource: 'warranty' }, token: KEY });
  expect('a read endpoint rejects POST: 405', post.statusCode === 405, String(post.statusCode));
  const unknown = await get('nope');
  expect('unknown resource: 404 listing the real ones', unknown.statusCode === 404 && Array.isArray(unknown.body?.resources));
  const noparam = await get('equipment', {});
  expect('equipment with no serial or customer: 400', noparam.statusCode === 400, String(noparam.statusCode));
  const mint = await h.call((await import('../api/account.js')).default, { method: 'POST', query: { action: 'keys' }, body: { action: 'create', name: 'x', scopes: ['read'] }, token: KEY });
  expect('a key cannot mint more keys: 401 (needs a signed-in person)', mint.statusCode === 401 || mint.statusCode === 403, String(mint.statusCode));
}

/* ------------------------------------------- revoke: a key stops working at once */
say('\n4. Revoking a key');
{
  const keys = await h.call((await import('../api/account.js')).default, { method: 'POST', query: { action: 'keys' }, body: { action: 'list' }, token: h.clerkToken() });
  expect('key list never contains key material', !JSON.stringify(keys.body).includes(KEY.slice(8)) && keys.body.keys.length === 2);
  const id = keys.body.keys.find((k) => k.name === 'Sample read key').id;
  const rev = await h.call((await import('../api/account.js')).default, { method: 'POST', query: { action: 'keys' }, body: { action: 'revoke', id }, token: h.clerkToken() });
  expect('revoke: 200', rev.statusCode === 200, String(rev.statusCode));
  const after = await get('warranty', {});
  expect('the revoked key is refused on its very next call', after.statusCode === 401, String(after.statusCode));
}

/* ----------------------------------------------------- rate limit, shown at a tiny setting */
say('\n5. Rate limit (read bucket: 120 a minute, 60,000 a day on Fleet; lowered to 3 a minute here to show the refusal)');
{
  const k2 = (await createApiKey({ tenantKey: h.tenantKey }, { userId: 'user_owner' }, { name: 'Rate demo', scopes: ['read'] })).body.key;
  await h.lite.query('DELETE FROM rate_limit_windows'); // start the demo with an empty minute
  process.env.RATE_LIMIT_READ_PER_MINUTE = '3';
  const codes = [];
  let retry = null;
  for (let i = 0; i < 5; i++) { const r = await get('warranty', {}, k2); codes.push(r.statusCode); if (r.statusCode === 429) retry ??= r.headers['retry-after']; }
  delete process.env.RATE_LIMIT_READ_PER_MINUTE;
  say(`  status codes for 5 quick calls: ${codes.join(', ')}  (Retry-After: ${retry}s)`);
  expect('the 4th call in a minute is refused with 429 and a Retry-After', codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429 && Number(retry) >= 1, codes.join(','));
}

if (asJson) console.log(JSON.stringify({ shown, checks: out, failures }));
else {
  say('');
  say(failures ? `${failures} check(s) FAILED.` : `All ${out.length} API sample checks passed.`);
}
process.exit(failures ? 1 : 0);
