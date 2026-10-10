/**
 * Shared harness for the outreach / public-API / warranty scripts: a real Postgres (PGlite, in process) migrated from
 * M3-config, the real route handlers called with fake req/res objects, a Clerk token stub, and NO outbound email
 * (the Resend endpoint is intercepted and recorded; nothing leaves the process).
 *
 *   import { startHarness } from './lib/t5-harness.mjs';
 *   const h = await startHarness();           // must be the first thing a script does (it sets env and hooks)
 *
 * Nothing here talks to a real database, Anthropic or Resend. Keys are minted in-process and are throwaway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startHarness({ plan = 'fleet' } = {}) {
  process.env.NEON_CONNECTION_STRING = 'postgres://stub:stub@ep-stub-pooler.example.invalid/stub'; // never connected: Pool is patched onto PGlite below
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLERK_SECRET_KEY = 'sk_test_harness_stub';
  process.env.RESEND_API_KEY = 're_harness_stub_not_a_real_key';
  register('./clerk-stub-hooks.mjs', import.meta.url);

  // ---- outbound email stub: Resend is the only host the app mails through ----
  const sentEmails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init?.body ?? '{}');
      sentEmails.push({ to: body.to, subject: body.subject, text: body.text, replyTo: body.reply_to });
      return new Response(JSON.stringify({ id: `stub_${sentEmails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(String(url))) throw new Error(`harness: outbound call blocked: ${String(url).split('?')[0]}`);
    return realFetch(url, init);
  };

  // ---- PGlite ----
  const { PGlite } = await import('@electric-sql/pglite');
  const contrib = {};
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
  for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* some depend on later files */ } }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after the rest */ }

  const pgMod = (await import('pg')).default;
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

  const store = await import('../../api/_lib/recordsStore.js');
  const tenantKey = 'org_t5_harness';
  const tenant = await store.getTenantContext(tenantKey, 'Desert Peak HVAC');
  if (plan) await lite.query('UPDATE tenants SET plan = $2, billing_status = $3 WHERE id = $1', [tenant.id, plan, 'active']);
  store.bustTenantCache?.(tenant.id); // getTenantContext cached the pre-update plan
  const planMod = await import('../../api/_lib/plan.js');
  planMod._resetBillingRowCache?.();

  /** Unsigned stub token the stubbed verifyToken accepts. */
  const clerkToken = (claims = {}) =>
    'stub.' + Buffer.from(JSON.stringify({ sub: 'user_owner', org_id: tenantKey, org_role: 'org:admin', azp: 'http://localhost', ...claims })).toString('base64url');

  /** Call a Vercel-style handler with a fake request and capture the response. */
  async function call(handler, { method = 'GET', query = {}, body, token, headers = {} } = {}) {
    const res = {
      statusCode: 200, headers: {}, body: undefined, ended: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
      getHeader(k) { return this.headers[String(k).toLowerCase()]; },
      removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
      status(n) { this.statusCode = n; return this; },
      writeHead(n, h) { this.statusCode = n; Object.assign(this.headers, h ?? {}); return this; },
      json(b) { this.body = b; this.ended = true; return this; },
      send(b) { this.body = b; this.ended = true; return this; },
      end(b) { if (b !== undefined) this.body = b; this.ended = true; return this; },
      on() { return this; }, once() { return this; }, emit() { return false; },
      get headersSent() { return this.ended; },
    };
    const req = {
      method, query, body, url: '/', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': '203.0.113.9', ...headers },
      socket: { remoteAddress: '203.0.113.9' }, on() { return this; },
    };
    await handler(req, res);
    return res;
  }

  return { ROOT, lite, tenantId: tenant.id, tenantKey, clerkToken, call, sentEmails, store };
}

/** Insert one customer + equipment entity the way the extraction pipeline stores them. */
export async function seedCustomer(h, { id, number, name, address, email, phone, optedOut }) {
  await h.lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [id, h.tenantId, 'customer', JSON.stringify({ customer_name: name, service_address: address, ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(optedOut ? { opted_out: true } : {}) }), number]
  );
}
export async function seedEquipment(h, { id, customerId, mfr, model, serial, type, installed, address, customerName, warranty }) {
  await h.lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [id, h.tenantId, 'equipment', JSON.stringify({ manufacturer: mfr, model, serial_number: serial, equipment_type: type, installation_date: installed, service_address: address, customer_name: customerName, ...(warranty ? { warranty } : {}) }), customerId]
  );
}
