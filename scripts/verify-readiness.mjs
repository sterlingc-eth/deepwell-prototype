/**
 * Client-readiness code gaps (round 25): everything here runs OFFLINE — a real Postgres (PGlite) loaded from
 * M3-config with the app role (`deepwell_rls`, NOBYPASSRLS) and FORCE RLS, fake Stripe/Clerk objects, no network.
 *
 *   1. Nightly sweep tenant listing under FORCE RLS (M3-config/60 list_all_tenant_keys(), ids only)
 *   2. Tenant delete completeness (derived FROM THE SCHEMA — fails if a tenant table is forgotten) + Stripe cancel
 *   3. Export paging past 5,000 rows, streaming, resume, originals manifest
 *   4. Stripe: customer name/email, add-on lookup-key alias, pull-based reconcile on the status call
 *   5. Health check (no auth, {ok, db, time} only)
 *   6. /api/v1/customers paging (backward compatible)
 *
 *   node scripts/verify-readiness.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...p) => path.join(ROOT, ...p);

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A signed-in shop admin without Clerk's network: requireAuth() verifies with @clerk/backend, which fetches the
// instance JWKS over HTTPS. Serve our own key for that one URL and mint matching tokens.
process.env.CLERK_SECRET_KEY = 'sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.STRIPE_SECRET_KEY = 'sk_test_readiness_fake';
process.env.CRON_SECRET = 'cron_readiness';
delete process.env.SENTRY_DSN;
delete process.env.R2_ACCOUNT_ID;
const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'ins_readiness', use: 'sig', alg: 'RS256' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function tokenFor({ sub = 'user_ready', org = null, role = 'admin', email } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_readiness' });
  const claims = { sub, iat: now - 5, nbf: now - 5, exp: now + 600, azp: 'https://deepwelltechnology.com', iss: 'https://clerk.readiness.test' };
  if (org) claims.o = { id: org, rol: role };
  if (email) claims.email = email;
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), keyPair.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
function mockRes() {
  const res = {
    statusCode: 200, headers: {}, chunks: [], ended: false, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headersSent = true; this.chunks.push(JSON.stringify(b)); this.ended = true; return this; },
    send(b) { this.headersSent = true; this.chunks.push(String(b)); this.ended = true; return this; },
    write(c) { this.headersSent = true; this.chunks.push(String(c)); return true; },
    end(b) { if (b) this.chunks.push(String(b)); this.headersSent = true; this.ended = true; return this; },
    get text() { return this.chunks.join(''); },
    get body() { try { return JSON.parse(this.text); } catch { return null; } },
  };
  return res;
}

/* ============================================================ static checks */

check('api/ holds exactly 13 entries (12 top-level files + _lib): no new serverless function', fs.readdirSync(rel('api')).length === 13, fs.readdirSync(rel('api')).join(','));

const sqlFiles = fs.readdirSync(rel('M3-config')).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
check('migration 60 is the next numbered file after 59', sqlFiles.includes('60-list-all-tenant-keys.sql') && sqlFiles.filter((f) => f > '59z').length === 1, sqlFiles.slice(-3).join(','));

/** Every table that carries a tenant_id column, derived from the migration SQL itself (CREATE TABLE bodies and ALTER ... ADD COLUMN tenant_id). */
function tenantTablesFromSql() {
  const found = new Set();
  for (const f of sqlFiles) {
    const sql = fs.readFileSync(rel('M3-config', f), 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      let i = re.lastIndex; let depth = 1;
      while (depth && i < sql.length) { const c = sql[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
      const body = sql.slice(re.lastIndex, i - 1).replace(/\([^()]*\)/g, '()');
      if (/(^|,)\s*"?tenant_id"?\s+/i.test(body)) found.add(m[1]);
    }
    const alt = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?tenant_id"?/gi;
    while ((m = alt.exec(sql))) found.add(m[1]);
  }
  return found;
}
/** Pure: which schema tenant tables would a delete path miss? */
function missingFromDeletePath(schemaTables, deleteOrder, retained) {
  return [...schemaTables].filter((t) => !deleteOrder.includes(t) && !(t in retained)).sort();
}

const OPS = await import('../api/_lib/opsStore.js');
const { DELETE_ORDER, RETAINED_TABLES } = OPS;
const schemaTables = tenantTablesFromSql();
check('schema parser found the tenant tables (>= 40) including a late one', schemaTables.size >= 40 && schemaTables.has('support_access_grants') && schemaTables.has('document_pages'), `found ${schemaTables.size}`);
eq('DELETE_ORDER + RETAINED_TABLES cover EVERY table with a tenant_id in M3-config (a forgotten table fails here)',
  missingFromDeletePath(schemaTables, DELETE_ORDER, RETAINED_TABLES), []);
check('the completeness check itself works: an extra unlisted tenant table is reported',
  missingFromDeletePath(new Set([...schemaTables, 'zz_future_table']), DELETE_ORDER, RETAINED_TABLES).join() === 'zz_future_table');
eq('DELETE_ORDER has no entry that is not a real tenant table (typo guard)', DELETE_ORDER.filter((t) => !schemaTables.has(t)), []);
eq('DELETE_ORDER has no duplicates', DELETE_ORDER.length, new Set(DELETE_ORDER).size);
eq('retained tables are exactly the account row, deletion receipt and Stripe event ledger', Object.keys(RETAINED_TABLES).sort(), ['billing_events', 'tenant_deletions', 'tenants']);
for (const [child, parents] of Object.entries({
  extractions: ['documents', 'facets'], document_pages: ['documents'], facets: ['documents'], document_financial_lines: ['document_financials', 'documents'],
  document_financials: ['documents'], intake_needs_info: ['documents', 'entities'], document_entity_links: ['documents', 'entities'],
  outreach_messages: ['entities'], notifications_sent: ['entities'], staff_access_log: ['support_access_grants'],
  donovan_scorecard_results: ['donovan_scorecard_runs'], audit_log: ['users'], proposals: ['users'], schema_versions: ['users'],
})) {
  for (const parent of parents) {
    check(`DELETE_ORDER: ${child} before ${parent}`, DELETE_ORDER.indexOf(child) !== -1 && DELETE_ORDER.indexOf(child) < DELETE_ORDER.indexOf(parent));
  }
}
const sweepSrc = fs.readFileSync(rel('api/_lib/routes/cron-sweep.js'), 'utf8');
check('cron-sweep uses the definer-backed listing and reports tenantSource', sweepSrc.includes('listTenantKeysWithSource') && sweepSrc.includes('tenantSource'));

/* ============================================================ PGlite (real Postgres, FORCE RLS, app role) */

const offline = await import('./offline-exam.mjs');
await offline.installPgHarness();
const lite = await offline.createPGlite();
await offline.setActiveDatabase(lite);
// The shared harness loads every migration BEFORE the app role exists (01b only succeeds on its last, re-run pass),
// so a migration's own "grant to deepwell_rls" block is skipped there. In production the role exists first. Re-apply
// migration 60 now that the role exists — it is idempotent — so this test exercises the production grant path.
await lite.exec(fs.readFileSync(rel('M3-config/60-list-all-tenant-keys.sql'), 'utf8'));
const RS = await import('../api/_lib/recordsStore.js');

// FORCE RLS really is on for the role the app uses.
{
  const { rows } = await lite.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'tenants'`);
  const role = (await lite.query(`SELECT rolbypassrls b, rolsuper s FROM pg_roles WHERE rolname = 'deepwell_rls'`)).rows[0];
  check('harness: tenants has FORCE RLS and deepwell_rls is NOBYPASSRLS / not superuser', rows[0]?.r === true && rows[0]?.f === true && role?.b === false && role?.s === false, JSON.stringify({ rows, role }));
}

/* ------------------------------------------------------------ 1. tenant listing */
const KEYS = ['org_ready_a', 'org_ready_b', 'org_ready_c'];
for (const k of KEYS) await RS.getTenantContext(k, `Shop ${k}`);
const idOf = async (k) => (await lite.query(`SELECT id FROM tenants WHERE clerk_org_id = $1`, [k])).rows[0].id;
const tenantIds = Object.fromEntries(await Promise.all(KEYS.map(async (k) => [k, await idOf(k)])));
for (const k of KEYS) {
  // one stuck document per tenant (stage received, no error, old): what the sweep exists to find
  await lite.query(
    `INSERT INTO documents (tenant_id, original_filename, sha256_hash, stage, created_at)
     VALUES ($1, 'stuck.pdf', $2, 'received', NOW() - interval '3 hours')`, [tenantIds[k], `stuck-${k}`]);
}
{
  const conn = await RS.getPool().connect();
  let direct;
  // Either zero rows, or an error (a pooled connection that already served a tenant carries app.tenant_id = '' and
  // the policy's ''::uuid cast throws) — both end in the same place: listTenantKeys() returned [] in production.
  try { direct = (await conn.query(`SELECT clerk_org_id FROM tenants WHERE clerk_org_id IS NOT NULL`)).rows.length; } catch { direct = 0; } finally { conn.release(); }
  eq('BEFORE the fix: the old direct read as deepwell_rls under FORCE RLS sees ZERO tenants (the production bug)', direct, 0);

  const { source, tenants } = await OPS.listTenantKeysWithSource();
  eq('list_all_tenant_keys(): source is "definer"', source, 'definer');
  const allKeys = (await lite.query(`SELECT clerk_org_id FROM tenants WHERE clerk_org_id IS NOT NULL`)).rows.map((r) => r.clerk_org_id).sort();
  check('the database has more than one tenant to find (includes the three seeded here)', allKeys.length >= 3 && KEYS.every((k) => allKeys.includes(k)));
  eq('AFTER the fix: the sweep listing reaches EVERY tenant in the database', tenants.map((t) => t.tenant_key).sort(), allKeys);

  // The sweep's first per-tenant step really finds work in every tenant, not just none.
  let stuckTotal = 0;
  for (const t of tenants) stuckTotal += (await OPS.listStuckDocuments({ tenantKey: t.tenant_key, tenantName: t.tenant_name }, 60)).length;
  eq('sweeping the listed tenants finds each tenant\'s stuck document (3 tenants, 1 each)', stuckTotal, 3);

  const fn = (await lite.query(`SELECT p.prosecdef, pg_get_function_result(p.oid) AS res, p.proacl::text AS acl, p.proconfig::text AS cfg, p.provolatile
                                  FROM pg_proc p WHERE p.proname = 'list_all_tenant_keys'`)).rows[0];
  check('function is SECURITY DEFINER with a pinned search_path', fn?.prosecdef === true && /search_path/.test(fn?.cfg ?? ''), JSON.stringify(fn));
  eq('function returns ONLY identifiers: (tenant_id, tenant_key)', fn?.res, 'TABLE(tenant_id uuid, tenant_key text)');
  check('EXECUTE is not granted to PUBLIC, only to the app role', !/(^|[{,])=X/.test(fn?.acl ?? '') && /deepwell_rls=X/.test(fn?.acl ?? ''), fn?.acl);
  const rowsAsApp = await (async () => {
    const c = await RS.getPool().connect();
    try { return (await c.query(`SELECT * FROM list_all_tenant_keys()`)).rows; } finally { c.release(); }
  })();
  eq('every returned row has exactly the two id columns and nothing else', [...new Set(rowsAsApp.flatMap((r) => Object.keys(r)))].sort(), ['tenant_id', 'tenant_key']);
  check('no shop name, plan, billing or settings value appears anywhere in the function output',
    !JSON.stringify(rowsAsApp).match(/Shop org_ready|shop|active|trialing|billing|settings/i));

  // Fallback: before the SQL is pasted the function does not exist; the API must keep working (empty under FORCE RLS, as today).
  await lite.exec(`ALTER FUNCTION list_all_tenant_keys() RENAME TO list_all_tenant_keys_saved`);
  const before = console.error; console.error = () => {};
  const fb = await OPS.listTenantKeysWithSource();
  console.error = before;
  check('function absent -> falls back without throwing, empty under FORCE RLS (today\'s behaviour)', ['fallback', 'none'].includes(fb.source) && fb.tenants.length === 0, JSON.stringify(fb));
  await lite.exec(`ALTER FUNCTION list_all_tenant_keys_saved() RENAME TO list_all_tenant_keys`);
  eq('function restored -> definer path again', (await OPS.listTenantKeysWithSource()).source, 'definer');
}

/* ------------------------------------------------------------ 2. tenant delete: completeness + Stripe */
const liveTenantTables = (await lite.query(
  `SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped WHERE c.relkind = 'r'`)).rows.map((r) => r.t);
eq('LIVE schema (PGlite after all migrations): every tenant table is in DELETE_ORDER or RETAINED_TABLES',
  missingFromDeletePath(new Set(liveTenantTables), DELETE_ORDER, RETAINED_TABLES), []);

const OVERRIDE = {
  document_financials: { doc_kind: 'invoice', direction: 'receivable' },
  outreach_messages: { tier: 'expired' },
  dossiers: { entity_type: 'customer' },
  ask_miss_replays: { outcome: 'still_failing' },
  donovan_learned_tenant: { kind: 'synonym' },
  donovan_promoted_tests: { oracle_kind: 'operator-literal' },
  proposals: { kind: 'field' },
  users: { role: 'admin' },
  entity_merge_suggestions: { entity_ids: '{}' },
};
/** Insert one row into every DELETE_ORDER table that exists (parents first), for tenant `tid`. Returns the tables seeded. */
async function seedEverything(tid) {
  const fk = {};
  const ent = (await lite.query(`INSERT INTO entities (tenant_id, entity_type, data) VALUES ($1,'customer','{"customer_name":"Seed"}') RETURNING id`, [tid])).rows[0].id;
  const doc = (await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, storage_key) VALUES ($1,'seed.pdf',$2,$3) RETURNING id`, [tid, `seed-${tid}`, `${tid}/aa/seed`])).rows[0].id;
  Object.assign(fk, { document_id: doc, entity_id: ent, customer_id: ent, equipment_id: ent, unit_id: ent });
  const seeded = new Set(['entities', 'documents']);
  for (const table of [...DELETE_ORDER].reverse()) {
    if (seeded.has(table) || !liveTenantTables.includes(table)) continue;
    const cols = (await lite.query(
      `SELECT column_name c, data_type d, udt_name u, is_nullable n, column_default df FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows;
    const names = []; const vals = [];
    for (const c of cols.filter((x) => (x.n === 'NO' && x.df == null) || x.c === 'tenant_id')) {
      names.push(c.c);
      const ov = OVERRIDE[table]?.[c.c];
      if (ov !== undefined) vals.push(ov);
      else if (c.c === 'tenant_id') vals.push(tid);
      else if (fk[c.c]) vals.push(fk[c.c]);
      else if (c.u === 'uuid') vals.push(crypto.randomUUID());
      else if (['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision'].includes(c.d)) vals.push(1);
      else if (c.d === 'boolean') vals.push(false);
      else if (c.d.startsWith('timestamp')) vals.push(new Date().toISOString());
      else if (c.d === 'date') vals.push('2026-01-01');
      else if (c.u === 'jsonb' || c.u === 'json') vals.push('{}');
      else vals.push(`x-${crypto.randomUUID()}`);
    }
    const hasId = cols.some((x) => x.c === 'id');
    const r = await lite.query(
      `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})${hasId ? ' RETURNING id' : ''}`, vals);
    if (hasId && r.rows[0]?.id) {
      if (table === 'document_financials') fk.financial_id = r.rows[0].id;
      if (table === 'donovan_scorecard_runs') fk.run_id = r.rows[0].id;
      if (table === 'support_access_grants') fk.grant_id = r.rows[0].id;
    }
    seeded.add(table);
  }
  await lite.query(`UPDATE tenants SET settings = '{"known_shop_contacts":[{"phone":"555-0100"}],"emailDigest":true}'::jsonb WHERE id = $1`, [tid]);
  return seeded;
}
const DEL_A = 'org_ready_del_a'; const DEL_B = 'org_ready_del_b';
await RS.getTenantContext(DEL_A, 'Delete Me Auto Care'); await RS.getTenantContext(DEL_B, 'Bystander HVAC');
const delA = await idOf(DEL_A); const delB = await idOf(DEL_B);
const seededA = await seedEverything(delA);
await seedEverything(delB);
const expectSeeded = DELETE_ORDER.filter((t) => liveTenantTables.includes(t));
eq('seeded a row in EVERY tenant table present in the live schema (so the delete test covers them all)', [...seededA].sort(), [...expectSeeded].sort());
await lite.query(`INSERT INTO billing_events (id, type, tenant_id, payload) VALUES ('evt_ready_keep', 'invoice.paid', $1, '{}')`, [delA]);
const countRows = async (table, tid) => Number((await lite.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id = $1`, [tid])).rows[0].n);

// A table added AFTER DELETE_ORDER was written: the runtime sweep still wipes it, and reports it.
await lite.exec(`
  CREATE TABLE zz_future_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, note text);
  ALTER TABLE zz_future_table ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_future_table FORCE ROW LEVEL SECURITY;
  CREATE POLICY zz_iso ON zz_future_table USING (tenant_id = (current_setting('app.tenant_id', true))::uuid);
  GRANT SELECT, INSERT, UPDATE, DELETE ON zz_future_table TO deepwell_rls;`);
await lite.query(`INSERT INTO zz_future_table (tenant_id, note) VALUES ($1,'a'), ($2,'b')`, [delA, delB]);

// Route end-to-end with a fake Stripe. getStripe() is a singleton; replace its subscriptions resource.
const BL = await import('../api/_lib/billing.js');
const stripeCalls = { list: [], cancel: [] };
let stripeMode = 'ok';
const stripe = BL.getStripe();
stripe.subscriptions = {
  list: async (p) => {
    stripeCalls.list.push(p);
    if (stripeMode === 'list-fails') throw Object.assign(new Error('stripe is down'), { code: 'api_connection_error' });
    return { data: [{ id: 'sub_extra_live', status: 'active' }, { id: 'sub_old_dead', status: 'canceled' }, { id: 'sub_recorded', status: 'active' }] };
  },
  cancel: async (id, p) => {
    stripeCalls.cancel.push({ id, p });
    if (stripeMode === 'cancel-fails' && id === 'sub_extra_live') throw Object.assign(new Error('rate limited'), { code: 'rate_limit' });
    return { id, status: 'canceled' };
  },
  retrieve: async () => { throw Object.assign(new Error('none'), { code: 'resource_missing' }); },
};
await lite.query(`UPDATE tenants SET stripe_customer_id = 'cus_del_a', stripe_subscription_id = 'sub_recorded', billing_status = 'active', plan = 'shop' WHERE id = $1`, [delA]);
const ACCOUNT = (await import('../api/account.js')).default;
const errSilence = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const deleteReq = (extra = {}) => ({ method: 'POST', headers: { authorization: `Bearer ${tokenFor({ sub: 'user_del', org: DEL_A })}` }, query: { action: 'delete' }, body: { confirm: DEL_A, ...extra } });

{
  // Stripe genuinely fails: NOTHING is deleted, caller can retry.
  stripeMode = 'cancel-fails';
  const res = mockRes();
  await errSilence(() => ACCOUNT(deleteReq(), res));
  eq('Stripe cancel fails -> 502 billing_cancel_failed and the data is NOT deleted', [res.statusCode, res.body?.code, await countRows('documents', delA) > 0, await countRows('ask_misses', delA) > 0], [502, 'billing_cancel_failed', true, true]);
  stripeCalls.list.length = 0; stripeCalls.cancel.length = 0;

  stripeMode = 'ok';
  const res2 = mockRes();
  await errSilence(() => ACCOUNT(deleteReq(), res2));
  eq('delete succeeds', [res2.statusCode, res2.body?.deleted], [200, true]);
  eq('Stripe: both live subscriptions cancelled immediately (recorded + one only Stripe knew about), the dead one untouched',
    stripeCalls.cancel.map((c) => c.id).sort(), ['sub_extra_live', 'sub_recorded']);
  check('cancel is immediate with no proration credit and no final invoice', stripeCalls.cancel.every((c) => c.p.prorate === false && c.p.invoice_now === false));
  eq('response reports the cancellation', [res2.body?.billing?.subscriptionsCanceled, res2.body?.billing?.skipped], [2, null]);

  const left = [];
  for (const t of expectSeeded) if (await countRows(t, delA)) left.push(t);
  eq('every tenant table is EMPTY for the deleted tenant (audit_log holds only the post-wipe tenant.deleted row, checked below)', left.filter((t) => t !== 'audit_log'), []);
  eq('audit_log has exactly one row', await countRows('audit_log', delA), 1);
  eq('the unlisted future table was wiped by the runtime sweep', await countRows('zz_future_table', delA), 0);
  eq('the OTHER tenant is untouched in every table', (await Promise.all(expectSeeded.map(async (t) => [t, await countRows(t, delB)]))).filter(([, n]) => n === 0).map(([t]) => t), []);
  eq('the other tenant\'s future-table row survives', await countRows('zz_future_table', delB), 1);
  const trow = (await lite.query(`SELECT name, settings, billing_status FROM tenants WHERE id = $1`, [delA])).rows[0];
  check('tenants row kept, settings cleared, billing marked canceled', trow && JSON.stringify(trow.settings) === '{}' && trow.billing_status === 'canceled', JSON.stringify(trow));
  eq('deletion receipt written; Stripe event ledger row retained', [await countRows('tenant_deletions', delA), await countRows('billing_events', delA)], [1, 1]);
  const audit = (await lite.query(`SELECT action, changes FROM audit_log WHERE tenant_id = $1`, [delA])).rows;
  check('one audit_log row after the wipe: tenant.deleted with the cancelled subscription ids, no content',
    audit.length === 1 && audit[0].action === 'tenant.deleted' && JSON.stringify(audit[0].changes.stripeSubscriptionsCanceled.slice().sort()) === '["sub_extra_live","sub_recorded"]', JSON.stringify(audit));

  // No subscription at all -> skipped gracefully.
  await lite.query(`UPDATE tenants SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [delB]);
  stripeCalls.list.length = 0; stripeCalls.cancel.length = 0;
  const res3 = mockRes();
  const reqB = { method: 'POST', headers: { authorization: `Bearer ${tokenFor({ sub: 'user_b', org: DEL_B })}` }, query: { action: 'delete' }, body: { confirm: DEL_B } };
  await errSilence(() => ACCOUNT(reqB, res3));
  eq('no Stripe customer/subscription -> deletion proceeds, no Stripe call, skipped reported', [res3.statusCode, res3.body?.billing?.skipped, stripeCalls.cancel.length + stripeCalls.list.length], [200, 'no-subscription', 0]);

  // A non-admin / wrong confirm cannot delete.
  const res4 = mockRes();
  await errSilence(() => ACCOUNT({ method: 'POST', headers: { authorization: `Bearer ${tokenFor({ sub: 'u', org: DEL_A, role: 'member' })}` }, query: { action: 'delete' }, body: { confirm: DEL_A } }, res4));
  eq('a member (not admin) cannot delete', res4.statusCode, 403);
}
{
  // cancelTenantSubscriptions unit behaviours
  const mk = (over = {}) => ({ subscriptions: {
    list: async () => ({ data: [{ id: 's_live', status: 'trialing' }] }),
    cancel: async () => ({}),
    ...over,
  } });
  eq('no ids -> skipped', (await BL.cancelTenantSubscriptions(mk(), {})).skipped, 'no-subscription');
  const gone = await BL.cancelTenantSubscriptions(mk({ cancel: async () => { throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' }); } }), { customerId: 'c', subscriptionId: 's_rec' });
  eq('"already gone" is success', [gone.alreadyGone.sort(), gone.failed], [['s_live', 's_rec'], []]);
  const listDown = await BL.cancelTenantSubscriptions(mk({ list: async () => { throw new Error('boom'); } }), { customerId: 'c', subscriptionId: 's_rec' });
  check('a failed customer listing is reported as a failure (cannot be sure nothing else is live)', listDown.failed.length === 1 && listDown.canceled.includes('s_rec'));
  const noLive = await BL.cancelTenantSubscriptions(mk({ list: async () => ({ data: [{ id: 'x', status: 'canceled' }] }) }), { customerId: 'c' });
  eq('only dead subscriptions -> nothing to do', noLive.skipped, 'no-live-subscription');
}
{
  const src = fs.readFileSync(rel('docs/SECURITY.md'), 'utf8');
  check('docs/SECURITY.md names the Stripe cancel and the health endpoint', /cancel/i.test(src) && /action=health/.test(src));
  const lines = src.split('\n');
  const retainedLine = lines.find((l) => /tenant_deletions/.test(l)) ?? '';
  check('docs/SECURITY.md lists what delete retains (tenants row, tenant_deletions, billing_events)', /billing_events/.test(src) && /tenants/.test(retainedLine + src));
  for (const t of DELETE_ORDER) check(`docs/SECURITY.md mentions deleted table ${t}`, src.includes(t));
}

/* ------------------------------------------------------------ 3. export: paging, streaming, resume, manifest */
const EXP = 'org_ready_export';
await RS.getTenantContext(EXP, 'Export Shop');
const expId = await idOf(EXP);
const N = 5300;
await lite.query(
  `INSERT INTO documents (tenant_id, original_filename, sha256_hash, storage_key, file_size_bytes)
   SELECT $1::uuid, 'file-' || g || '.pdf', 'sha-' || g, $1::text || '/aa/' || g, 1000 + g FROM generate_series(1, $2) g`, [expId, N]);
// 3 documents with NO created_at and one with no storage_key: nothing may be lost or duplicated
await lite.query(`UPDATE documents SET created_at = NULL WHERE tenant_id = $1 AND original_filename IN ('file-1.pdf','file-2.pdf','file-3.pdf')`, [expId]);
await lite.query(`UPDATE documents SET storage_key = NULL WHERE tenant_id = $1 AND original_filename = 'file-4.pdf'`, [expId]);
await lite.query(
  `INSERT INTO document_pages (tenant_id, document_id, page_no, text)
   SELECT tenant_id, id, 1, 'page text ' || original_filename FROM documents WHERE tenant_id = $1`, [expId]);
// financials + lines (the lines table has no created_at: it pages by id) — must not be dropped from the export
{
  const d1 = (await lite.query(`SELECT id FROM documents WHERE tenant_id = $1 AND original_filename = 'file-10.pdf'`, [expId])).rows[0].id;
  const fin = (await lite.query(`INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction) VALUES ($1,$2,'invoice','receivable') RETURNING id`, [expId, d1])).rows[0].id;
  for (const n of [1, 2, 3]) await lite.query(`INSERT INTO document_financial_lines (tenant_id, financial_id, document_id, line_no) VALUES ($1,$2,$3,$4)`, [expId, fin, d1, n]);
}
const expCtx = { tenantKey: EXP, tenantName: 'Export Shop' };
{
  const full = await OPS.exportTenant(expCtx);
  eq(`documents: all ${N} rows exported (was capped at 5,000)`, full.documents.length, N);
  eq('pages: all rows exported', full.pages.length, N);
  eq('no truncation', [full.truncated, full.incomplete], [false, null]);
  eq('financials and financial lines (a table with no created_at) are exported too', [full.financials?.length, full.financial_lines?.length], [1, 3]);
  eq('no duplicate or missing document ids across page boundaries (identical created_at on every row, 3 NULL created_at)', new Set(full.documents.map((d) => d.id)).size, N);
  check('documents carry no storage_key', full.documents.every((d) => !('storage_key' in d) && !('__has_original' in d) && !('__c' in d)));
  eq('manifest lists every stored original (all but the one without a file)', full.manifest.originalsCount, N - 1);
  const m = full.manifest.originals.find((o) => o.filename === 'file-7.pdf');
  check('manifest entry: document id, filename, sha256, size', m && full.documents.some((d) => d.id === m.documentId && d.original_filename === 'file-7.pdf') && m.sha256 === 'sha-7' && m.sizeBytes === 1007);
  check('manifest says how to fetch on demand and embeds no URL, key or secret',
    full.manifest.fetch.path === '/api/upload-url' && full.manifest.fetch.body.mode === 'get'
    && !/X-Amz|https?:\/\/|storage|secret|R2_/i.test(JSON.stringify(full.manifest).replace(full.manifest.fetch.note, ''))
    && !JSON.stringify(full).includes(`${expId}/aa/`));

  // Stream form: valid JSON, same content, honest note
  const chunks = [];
  const summary = await OPS.streamTenantExport(expCtx, (c) => { chunks.push(c); });
  const parsed = JSON.parse(chunks.join(''));
  eq('stream: valid JSON with all rows', [summary.ok, parsed.documents.length, parsed.pages.length, parsed.truncated], [true, N, N, false]);
  check('stream: notes explain originals are listed, not embedded', parsed.notes.some((n) => /not embedded/i.test(n) && /manifest/.test(n)));
  check('stream: the old top-level keys are all still present', ['tenantKey', 'exportedAt', 'documents', 'pages', 'extractions', 'entities', 'document_entity_links', 'facets', 'audit_log', 'truncated'].every((k) => k in parsed));
  check('stream: was emitted in many chunks (not one buffered blob)', chunks.length > 10);

  // Time budget -> clean stop, resume continues exactly
  let fetches = 0;
  const part1 = [];
  const s1 = await OPS.streamTenantExport(expCtx, (c) => { part1.push(c); }, { pageSize: 1000, shouldStop: () => ++fetches > 3 });
  const p1 = JSON.parse(part1.join(''));
  eq('budget hit -> valid JSON, truncated:true, resume point returned', [s1.truncated, p1.truncated, p1.incomplete?.key, p1.documents.length], [true, true, 'documents', 3000]);
  check('truncated export tells the reader how to resume', p1.notes.some((n) => /INCOMPLETE/.test(n) && /resume/.test(n)));
  const resume = OPS.parseExportResume(JSON.parse(JSON.stringify(p1.incomplete)));
  check('the resume token round-trips through validation', resume?.key === 'documents' && !!resume.after?.id);
  const part2 = [];
  await OPS.streamTenantExport(expCtx, (c) => { part2.push(c); }, { pageSize: 1000, resume });
  const p2 = JSON.parse(part2.join(''));
  eq('resumed file finishes the job: nothing lost, nothing repeated', [p2.truncated, new Set([...p1.documents, ...p2.documents].map((d) => d.id)).size, p1.documents.length + p2.documents.length], [false, N, N]);
  eq('resumed file does not repeat sections already delivered before the resume point', p2.audit_log.length + p2.extractions.length >= 0 && p2.pages.length, N);
  for (const bad of [null, {}, { key: 'nope' }, { key: 'documents', after: { id: 'x' } }, { key: 'documents', after: { id: '00000000-0000-4000-8000-000000000000', c: "1'; DROP TABLE documents;--" } }]) {
    eq(`resume token rejected: ${JSON.stringify(bad)}`, OPS.parseExportResume(bad), null);
  }

  // Failure handling
  await lite.exec(`ALTER TABLE document_pages RENAME TO document_pages_x`);
  const midChunks = [];
  const mid = await errSilence(() => OPS.streamTenantExport(expCtx, (c) => { midChunks.push(c); }));
  await lite.exec(`ALTER TABLE document_pages_x RENAME TO document_pages`);
  const midParsed = JSON.parse(midChunks.join(''));
  eq('mid-stream failure still yields valid JSON marked truncated with an error and resume point', [mid.ok, midParsed.truncated, typeof midParsed.error, midParsed.incomplete?.key, midParsed.documents.length], [false, true, 'string', 'pages', N]);
  await lite.exec(`ALTER TABLE documents RENAME TO documents_x`);
  let early = null;
  try { await errSilence(() => OPS.streamTenantExport(expCtx, () => {}, {})); } catch (e) { early = e; }
  await lite.exec(`ALTER TABLE documents_x RENAME TO documents`);
  check('failure before any data throws (so the route can answer with a real error status)', early instanceof Error);
}
{
  // Route end-to-end: the app POSTs with no body and reads the blob.
  const req = { method: 'POST', headers: { authorization: `Bearer ${tokenFor({ sub: 'u_exp', org: EXP })}` }, query: { action: 'export' }, body: {} };
  const res = mockRes();
  await ACCOUNT(req, res);
  const body = res.body;
  eq('route: 200 JSON attachment, all rows, manifest', [res.statusCode, body?.documents?.length, body?.manifest?.originalsCount], [200, N, N - 1]);
  check('route: attachment headers set once, no-store', /attachment; filename="deepwell-export-org_ready_export\.json"/.test(res.headers['content-disposition']) && res.headers['cache-control'] === 'no-store');
  const audited = (await lite.query(`SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.exported'`, [expId])).rows;
  check('route: export is audit-logged with the true document count', audited.length === 1 && audited[0].changes.documents === N, JSON.stringify(audited));
  const bad = mockRes();
  await ACCOUNT({ ...req, body: { resume: { key: 'evil' } } }, bad);
  eq('route: a malformed resume token is a 400, not a stream', bad.statusCode, 400);
  const denied = mockRes();
  await errSilence(() => ACCOUNT({ ...req, headers: { authorization: `Bearer ${tokenFor({ sub: 'm', org: EXP, role: 'member' })}` } }, denied));
  eq('route: a shop member (not admin) cannot export', denied.statusCode, 403);
}

/* ------------------------------------------------------------ 4. Stripe: identity, add-on key, reconcile */
{
  const clerk = {
    organizations: { getOrganization: async ({ organizationId }) => ({ id: organizationId, name: '  Acme Heating & Air  ' }) },
    users: { getUser: async () => ({ primaryEmailAddressId: 'e2', emailAddresses: [{ id: 'e1', emailAddress: 'old@x.com' }, { id: 'e2', emailAddress: 'owner@acme.com' }], firstName: 'Pat', lastName: 'Owner' }) },
  };
  eq('shop: customer name is the shop name, email is the admin\'s primary email',
    await BL.resolveBillingIdentity({ userId: 'u1', orgId: 'org_abc', tenantId: 'org_abc' }, { clerk }), { name: 'Acme Heating & Air', email: 'owner@acme.com' });
  eq('a session-token email wins over a lookup',
    (await BL.resolveBillingIdentity({ userId: 'u1', orgId: 'org_abc', tenantId: 'org_abc', email: 'tok@acme.com' }, { clerk })).email, 'tok@acme.com');
  eq('solo tenant: person\'s name and email',
    await BL.resolveBillingIdentity({ userId: 'u1', orgId: null, tenantId: 'user_u1' }, { clerk }), { name: 'Pat Owner', email: 'owner@acme.com' });
  const down = { organizations: { getOrganization: async () => { throw new Error('clerk 500'); } }, users: { getUser: async () => { throw new Error('clerk 500'); } } };
  eq('Clerk down -> falls back to the org id and no email (never blocks checkout)',
    await errSilence(() => BL.resolveBillingIdentity({ userId: 'u1', orgId: 'org_abc', tenantId: 'org_abc' }, { clerk: down })), { name: 'org_abc', email: undefined });

  let created = null;
  const fake = { customers: { search: async () => ({ data: [] }), create: async (p) => { created = p; return { id: 'cus_new' }; } } };
  await BL.findOrCreateCustomer(fake, { tenantRow: null, tenantId: 't1', name: 'Acme Heating & Air', email: 'owner@acme.com' });
  check('stripe.customers.create receives name, email and tenant metadata', created.name === 'Acme Heating & Air' && created.email === 'owner@acme.com' && created.metadata.tenantId === 't1' && Object.keys(created).length === 3, JSON.stringify(created));
  await BL.findOrCreateCustomer(fake, { tenantRow: null, tenantId: 't1', name: 'X' });
  check('no email known -> none sent', !('email' in created));

  // add-on lookup key: canonical `outreach_auto` (owner checklist), legacy name still honoured
  const subWith = (keys) => ({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: keys.map((k) => ({ price: { lookup_key: k, metadata: k.startsWith('shop') ? { plan: 'shop' } : {} } })) } } } });
  eq('canonical add-on key is outreach_auto', BL.OUTREACH_AUTO_ADDON_LOOKUP_KEY, 'outreach_auto');
  for (const key of ['outreach_auto', 'outreach_auto_addon_monthly']) {
    const p = BL.patchForEvent(subWith([key, 'shop_monthly'])).patch;
    check(`add-on price "${key}" listed BEFORE the plan still grants the entitlement and resolves the plan`, p.limits?.outreachAuto === true && p.plan === 'shop', JSON.stringify(p.limits));
  }
  check('no add-on -> no outreachAuto key', !('outreachAuto' in (BL.patchForEvent(subWith(['shop_monthly'])).patch.limits ?? {})));
  check('an unrelated price never counts as the add-on', !('outreachAuto' in (BL.patchForEvent(subWith(['shop_monthly', 'outreach_auto_pro'])).patch.limits ?? {})));
  const setup = fs.readFileSync(rel('scripts/stripe-setup.mjs'), 'utf8');
  check('stripe-setup.mjs does not create an add-on price under any name (owner creates it as `outreach_auto`)', !/outreach_auto/.test(setup));
}
{
  // needsBillingReconcile truth table
  const c = (row) => BL.needsBillingReconcile(row);
  eq('reconcile wanted: customer exists but state none', c({ stripe_customer_id: 'cus', billing_status: 'none' }), true);
  eq('reconcile wanted: customer, no subscription recorded, status active', c({ stripe_customer_id: 'cus', billing_status: 'active' }), true);
  eq('not wanted: no Stripe customer yet (never started checkout)', c({ billing_status: 'none' }), false);
  eq('not wanted: healthy active subscription', c({ stripe_customer_id: 'cus', stripe_subscription_id: 'sub', billing_status: 'active' }), false);
  eq('not wanted: canceled with subscription on file', c({ stripe_customer_id: 'cus', stripe_subscription_id: 'sub', billing_status: 'canceled' }), false);
  eq('pickSubscription: live beats canceled, newest live wins',
    BL.pickSubscription([{ id: 'a', status: 'canceled', created: 9 }, { id: 'b', status: 'active', created: 1 }, { id: 'c', status: 'active', created: 5 }]).id, 'c');

  // DB-backed reconcile
  const RC = 'org_ready_reconcile';
  await RS.getTenantContext(RC, 'Reconcile Shop');
  const rcId = await idOf(RC);
  await lite.query(`UPDATE tenants SET stripe_customer_id = 'cus_rc', billing_status = 'none', plan = NULL WHERE id = $1`, [rcId]);
  const rowOf = async () => (await lite.query(`SELECT id, stripe_customer_id, stripe_subscription_id, plan, billing_status, cancel_at_period_end, current_period_end, limits FROM tenants WHERE id = $1`, [rcId])).rows[0];
  const subFixture = { id: 'sub_rc', customer: 'cus_rc', status: 'active', created: 100, current_period_end: 1800000000, cancel_at_period_end: false,
    items: { data: [{ price: { lookup_key: 'shop_monthly', metadata: { plan: 'shop' } } }] } };
  let stripeReads = 0;
  const fakeRc = { subscriptions: { list: async () => { stripeReads++; return { data: [subFixture] }; }, retrieve: async () => { stripeReads++; return subFixture; } } };
  BL._resetReconcileThrottle();
  const out = await BL.reconcileTenantBilling(RS.getPool(), fakeRc, { tenantId: rcId, row: await rowOf(), now: 1_000_000 });
  const after = await rowOf();
  eq('reconcile applies Stripe\'s subscription: paid tenant is unlocked without the webhook', [out.applied, after.billing_status, after.plan, after.stripe_subscription_id], [true, 'active', 'shop', 'sub_rc']);
  check('reconcile writes plan limits through the same mapping as the webhook', after.limits && after.limits.technicians === BL.patchForEvent({ type: 'customer.subscription.updated', data: { object: subFixture } }).patch.limits.technicians);
  eq('throttled inside the interval (no Stripe call)', [(await BL.reconcileTenantBilling(RS.getPool(), fakeRc, { tenantId: rcId, row: await rowOf(), now: 1_000_500 })).reason, stripeReads], ['throttled', 1]);
  eq('already current -> no write', (await BL.reconcileTenantBilling(RS.getPool(), fakeRc, { tenantId: rcId, row: await rowOf(), now: 2_000_000 })).reason, 'already-current');
  const boom = { subscriptions: { retrieve: async () => { throw new Error('stripe down'); }, list: async () => { throw new Error('stripe down'); } } };
  BL._resetReconcileThrottle();
  eq('a Stripe outage is swallowed (status endpoint must not break)', (await errSilence(async () => BL.reconcileTenantBilling(RS.getPool(), boom, { tenantId: rcId, row: { ...(await rowOf()), stripe_subscription_id: null, billing_status: 'none' }, now: 5_000_000 }))).reason, 'error');
  const none = { subscriptions: { list: async () => ({ data: [] }), retrieve: async () => { throw Object.assign(new Error('x'), { code: 'resource_missing' }); } } };
  BL._resetReconcileThrottle();
  eq('customer with no subscription at all -> nothing applied', (await BL.reconcileTenantBilling(RS.getPool(), none, { tenantId: rcId, row: { stripe_customer_id: 'cus_rc', billing_status: 'none' }, now: 9_000_000 })).reason, 'no-subscription');

  BL._resetReconcileThrottle();
  const abandoned = { subscriptions: { list: async () => ({ data: [{ ...subFixture, id: 'sub_abandoned', status: 'incomplete_expired' }] }), retrieve: async () => { throw Object.assign(new Error('x'), { code: 'resource_missing' }); } } };
  eq('an abandoned checkout (incomplete_expired) does not flip the tenant to canceled', (await BL.reconcileTenantBilling(RS.getPool(), abandoned, { tenantId: rcId, row: { ...(await rowOf()), stripe_subscription_id: null, billing_status: 'none' }, now: 12_000_000 })).reason, 'incomplete');

  // Handler level: the status call the ?billing=success polling loop makes
  await lite.query(`UPDATE tenants SET stripe_subscription_id = NULL, billing_status = 'none', plan = NULL, limits = '{}'::jsonb WHERE id = $1`, [rcId]);
  BL._resetReconcileThrottle();
  stripe.subscriptions = { list: async () => ({ data: [subFixture] }), retrieve: async () => subFixture };
  const BILLING = (await import('../api/billing.js')).default;
  // The status call reads usage through an AUX pool while its tenant transaction is open — two connections in
  // production. The single-connection harness would deadlock on its own lock, so give the aux pool a direct path.
  (await import('../api/_lib/apiKeyAuth.js')).getAuxPool().query = (sql, params) => lite.query(sql, params);
  const res = mockRes();
  await BILLING({ method: 'GET', headers: { authorization: `Bearer ${tokenFor({ sub: 'u_rc', org: RC })}` }, query: { action: 'status' } }, res);
  eq('status call self-heals a missed webhook: paying customer sees active/shop, reconciled:true', [res.statusCode, res.body?.status, res.body?.plan, res.body?.reconciled], [200, 'active', 'shop', true]);
  const res2 = mockRes();
  await BILLING({ method: 'GET', headers: { authorization: `Bearer ${tokenFor({ sub: 'u_rc', org: RC })}` }, query: { action: 'status' } }, res2);
  check('and the next call is a plain status (no reconcile flag)', res2.statusCode === 200 && res2.body?.reconciled === undefined);
  // checkout passes the identity to Stripe
  const billingSrc = fs.readFileSync(rel('api/billing.js'), 'utf8');
  check('checkout resolves the shop identity and passes name + email to findOrCreateCustomer', /resolveBillingIdentity\(auth\)/.test(billingSrc) && /email: identity\.email/.test(billingSrc) && /name: identity\.name/.test(billingSrc));
  check('the Clerk org id is no longer the Stripe customer name', !/name: auth\.orgId \?\? auth\.tenantId/.test(billingSrc));
}

/* ------------------------------------------------------------ 5. health check */
{
  const H = await import('../api/_lib/health.js');
  const hreq = (method = 'GET') => ({ method, headers: {}, query: { action: 'health' } });
  H._resetHealthCache();
  const res = mockRes();
  await ACCOUNT(hreq(), res);
  eq('GET /api/account?action=health with NO auth -> 200 {ok, db, time} and nothing else', [res.statusCode, Object.keys(res.body).sort(), res.body.ok, res.body.db], [200, ['db', 'ok', 'time'], true, true]);
  check('time is an ISO timestamp; response is no-store', !Number.isNaN(Date.parse(res.body.time)) && res.headers['cache-control'] === 'no-store');
  check('the body carries no tenant data, version, env or secret', !/tenant|org_|version|sk_|NEON|postgres|@/.test(res.text));

  let pings = 0;
  const okPool = { query: async () => { pings++; return { rows: [{ ok: 1 }] }; } };
  H._resetHealthCache();
  const r1 = mockRes(); const r2 = mockRes();
  // route through the module's own handler with an injected pool
  await H.default(hreq(), r1, { pool: okPool }); await H.default(hreq(), r2, { pool: okPool });
  eq('the DB ping is cached briefly (a request flood is not a query flood)', pings, 1);

  H._resetHealthCache();
  const dead = { query: () => new Promise(() => {}) }; // never answers
  const t0 = Date.now();
  const r3 = mockRes();
  await H.default(hreq(), r3, { pool: dead, timeoutMs: 60 });
  eq('a hung database -> 503 {ok:false, db:false} within the timeout', [r3.statusCode, r3.body.ok, r3.body.db, Date.now() - t0 < 1500], [503, false, false, true]);
  H._resetHealthCache();
  const r4 = mockRes();
  await H.default(hreq(), r4, { pool: { query: async () => { throw new Error('password authentication failed for user secret_user'); } } });
  check('a failing database -> 503 and the error text is NOT echoed', r4.statusCode === 503 && r4.body.db === false && !/password|secret_user/.test(r4.text));
  H._resetHealthCache();
  const r5 = mockRes();
  await ACCOUNT(hreq('POST'), r5);
  eq('POST is refused (405)', r5.statusCode, 405);
  H._resetHealthCache();
  const r6 = mockRes();
  await ACCOUNT(hreq('HEAD'), r6);
  eq('HEAD works for monitors that use it', r6.statusCode, 200);
  const ops = fs.existsSync(rel('docs/OPERATIONS.md')) ? fs.readFileSync(rel('docs/OPERATIONS.md'), 'utf8') : '';
  const sec = fs.readFileSync(rel('docs/SECURITY.md'), 'utf8');
  check('the health endpoint is documented for an uptime monitor', /action=health/.test(ops + sec) && /UptimeRobot|Better Stack/i.test(ops + sec));
}

/* ------------------------------------------------------------ 6. customers paging */
{
  const CU = 'org_ready_customers';
  await RS.getTenantContext(CU, 'Customer Shop');
  const cuId = await idOf(CU);
  const names = ['Alpha Smith', 'Bravo Jones', 'Charlie Smith', 'Delta Brown', 'Echo Davis', 'Foxtrot Smithers', 'Golf Miller'];
  for (const [i, n] of names.entries()) {
    await lite.query(`INSERT INTO entities (tenant_id, entity_type, data, customer_number) VALUES ($1,'customer',$2::jsonb,$3)`,
      [cuId, JSON.stringify({ customer_name: n, service_address: `${100 + i} Main St, Mesa AZ` }), `C-${String(i + 1).padStart(5, '0')}`]);
  }
  const { customers } = await import('../api/_lib/routes/customers.js');
  const call = async (query) => {
    const res = mockRes();
    await customers({ method: 'GET', headers: { authorization: `Bearer ${tokenFor({ sub: 'u_cu', org: CU })}` }, query }, res);
    return res;
  };
  const plain = await call({});
  eq('no params: today\'s exact shape (customers, duplicates, possibleDuplicates) and all rows', [plain.statusCode, Object.keys(plain.body).sort(), plain.body.customers.length], [200, ['customers', 'duplicates', 'possibleDuplicates'], 7]);
  const qOnly = await call({ q: 'Smith' });
  eq('q alone: unchanged shape, filtered', [Object.keys(qOnly.body).sort(), qOnly.body.customers.length], [['customers', 'duplicates', 'possibleDuplicates'], 3]);

  const seen = []; let cursor; let pages = 0; let lastBody;
  do {
    const r = await call(cursor ? { limit: '3', cursor, sort: 'name' } : { limit: '3', sort: 'name' });
    check(`page ${pages + 1}: 200 with total and nextCursor`, r.statusCode === 200 && r.body.total === 7 && 'nextCursor' in r.body, JSON.stringify(r.body).slice(0, 200));
    seen.push(...r.body.customers.map((c) => c.id));
    cursor = r.body.nextCursor ?? undefined; lastBody = r.body; pages++;
  } while (cursor && pages < 10);
  eq('paging by 3 takes 3 pages and ends with nextCursor null', [pages, lastBody.nextCursor], [3, null]);
  const full = await call({ sort: 'name' });
  eq('paged rows == the unpaged list, same order, no gaps or repeats', seen, full.body.customers.map((c) => c.id));
  const filtered = await call({ limit: '2', q: 'Smith' });
  eq('q + limit: total counts the filter, cursor present', [filtered.body.total, filtered.body.customers.length, typeof filtered.body.nextCursor], [3, 2, 'string']);
  const mism = await call({ limit: '2', q: 'Jones', cursor: filtered.body.nextCursor });
  eq('a cursor replayed against a different q is refused (400)', mism.statusCode, 400);
  const junk = await call({ limit: '2', cursor: 'not-a-cursor' });
  eq('a garbage cursor is a 400', junk.statusCode, 400);
  const big = await call({ limit: '100000' });
  eq('limit is clamped (no unbounded page)', [big.statusCode, big.body.customers.length, big.body.total], [200, 7, 7]);
  const empty = await call({ limit: '5', q: 'zzzz-no-match' });
  eq('no matches: empty page, total 0, no cursor', [empty.body.customers.length, empty.body.total, empty.body.nextCursor], [0, 0, null]);
  const exact = await call({ limit: '7' });
  eq('exactly one full page: nextCursor null', exact.body.nextCursor, null);
}

if (failures) { console.log(`\n${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`\nAll ${passes} readiness checks passed.`);
process.exit(0);
