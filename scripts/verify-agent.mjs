/**
 * Checks for the Donovan agent fallback (api/_lib/agent/*).
 *
 * No network, no Anthropic key, no DATABASE_URL: the model is scripted and the
 * database is a REAL Postgres (PGlite, in process) loaded from the actual
 * M3-config/*.sql migrations, queried as the app's non-superuser
 * NOBYPASSRLS role (deepwell_rls) so row-level security is genuinely in force.
 * api/_lib/recordsStore.js's real withTenant()/makeStore() run unmodified: only
 * pg.Pool is swapped for a PGlite-backed connection (see "harness" below).
 *
 *   1. SQL guard (pure): every bypass we could think of is rejected; normal
 *      queries pass.
 *   2. Cross-tenant isolation, read-only, timeout, savepoint recovery.
 *   3. Scripted-model loop: multi-step tool use, error-then-retry, turn/token
 *      caps, budget refusal, usage recording, citation grounding.
 *   4. Real miss questions as scripted trajectories over seeded data.
 *
 *   node scripts/verify-agent.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
const { guardSql, REAL_TABLES, VIEW_NAMES } = await import('../api/_lib/agent/sqlGuard.js');

/* ================================================================== 1. SQL guard (pure) */
{
  const bad = {
    'multi-statement': 'SELECT 1; SELECT 2',
    'trailing semicolon': 'SELECT 1;',
    'line comment': 'SELECT 1 -- hi',
    'block comment': 'SELECT /* x */ 1',
    'comment hiding a keyword': 'SELECT 1 /*!*/',
    'pg_sleep': 'select pg_sleep(5)',
    'pg_sleep, mixed case + space before paren': 'SeLeCt PG_SLEEP (1)',
    'pg_ prefix split by whitespace': 'select pg_\nsleep(1)',
    'set_config on the tenant': "SELECT set_config('app.tenant_id', 'x', false)",
    'current_setting': "SELECT current_setting('app.tenant_id')",
    'tenants table': 'SELECT * FROM tenants',
    'users table': 'SELECT * FROM users',
    'UNION on users': 'SELECT customer_id, name FROM customers UNION SELECT id, email FROM users',
    'UNION on tenants': 'SELECT name FROM customers UNION SELECT name FROM tenants',
    'real table documents': 'SELECT * FROM documents',
    'real table entities': 'SELECT * FROM entities',
    'comma join of a real table': 'SELECT * FROM customers, api_keys',
    'INSERT': "INSERT INTO entities(entity_type) VALUES ('customer')",
    'UPDATE': "UPDATE entities SET data = '{}'",
    'DELETE': 'DELETE FROM entities',
    'DROP': 'DROP TABLE entities',
    'ALTER': 'ALTER TABLE entities DISABLE ROW LEVEL SECURITY',
    'CREATE': 'CREATE TABLE x(a int)',
    'GRANT': 'GRANT ALL ON entities TO public',
    'TRUNCATE': 'TRUNCATE entities',
    'COPY': "COPY entities TO '/tmp/x'",
    'DO block': "DO $$ BEGIN PERFORM 1; END $$",
    'CALL': 'CALL foo()',
    'SET': "SET ROLE postgres",
    'SET starting a select-like string': "SET app.tenant_id = 'x'",
    'writable CTE INSERT': "WITH x AS (INSERT INTO entities(entity_type) VALUES ('customer') RETURNING *) SELECT * FROM x",
    'writable CTE DELETE': 'WITH x AS (DELETE FROM entities RETURNING *) SELECT * FROM x',
    'writable CTE UPDATE': "WITH x AS (UPDATE entities SET data='{}' RETURNING *) SELECT * FROM x",
    'SELECT INTO': 'SELECT * INTO newtable FROM customers',
    'quoted identifier schema': 'SELECT * FROM "pg_catalog"."pg_shadow"',
    'quoted identifier hiding a table': 'SELECT * FROM "Users"',
    'pg_shadow bare': 'SELECT * FROM pg_shadow',
    'pg_catalog': 'SELECT * FROM pg_catalog.pg_tables',
    'information_schema': 'SELECT * FROM information_schema.tables',
    'dollar quoting': 'SELECT $$x$$',
    'tagged dollar quoting': 'SELECT $tag$x$tag$',
    'positional parameter': 'SELECT $1',
    'fullwidth semicolon': 'SELECT 1；DROP TABLE x',
    'NBSP as whitespace': 'SELECT 1',
    'zero-width space inside keyword': 'sel​ect 1',
    'cyrillic homoglyph': 'ѕelect 1',
    'unicode line separator': 'SELECT 1',
    'NUL byte': 'SELECT 1\u0000',
    'control char (vertical tab)': 'SELECT\u000b1',
    'E-string': "SELECT E'\\x27'",
    'E-string lowercase': "select e'a'",
    'unicode-escape string': "SELECT U&'\\0041'",
    'backslash in a literal': "SELECT 'a\\'",
    'unterminated literal': "SELECT 'abc",
    'unbalanced closing paren': 'SELECT 1) q; DROP',
    'unbalanced closing paren, no semicolon': 'SELECT 1) q UNION ALL SELECT 2 FROM (SELECT 3',
    'unbalanced open paren': 'SELECT (1',
    'EXPLAIN ANALYZE': 'EXPLAIN ANALYZE SELECT 1',
    'starts with a paren': '(SELECT 1)',
    'FOR UPDATE': 'SELECT * FROM customers FOR UPDATE',
    'WITH RECURSIVE': 'WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT 1 FROM r) SELECT * FROM r',
    'current_user': 'SELECT current_user',
    'lo_import': "SELECT lo_import('/etc/passwd')",
    'dblink': "SELECT dblink('host=x','select 1')",
    'query_to_xml runs a string as SQL': "SELECT query_to_xml('select * from tenants', true, true, '')",
    'app SECURITY DEFINER function': "SELECT resolve_tenant('a', 'b')",
    'cross-tenant digest function': 'SELECT * FROM list_ask_misses_window(now(), now())',
    'nextval': "SELECT nextval('x')",
    'regclass cast': "SELECT 'pg_shadow'::regclass",
    'unknown function': 'SELECT some_random_func(1)',
    'generate_series alias trick with unknown fn': 'SELECT * FROM generate_series(1,2) g, random_thing(1)',
    'too long': `SELECT ${'1,'.repeat(3000)}1`,
    'empty': '   ',
    'not a string': null,
    'starts with a keyword that is not select': 'VALUES (1)',
  };
  for (const [name, sql] of Object.entries(bad)) {
    const r = guardSql(sql);
    check(`guard rejects: ${name}`, r.ok === false, r.ok ? `was accepted: ${JSON.stringify(sql).slice(0, 80)}` : '');
  }

  const good = {
    'plain select on a view': 'SELECT name FROM customers ORDER BY name',
    'leading whitespace and newlines': '\n  \tselect count(*) from customers  ',
    'aggregate + group by': "SELECT zip, count(*) AS n FROM customers WHERE zip IS NOT NULL GROUP BY zip ORDER BY n DESC LIMIT 3",
    'a semicolon inside a string literal': "SELECT name FROM customers WHERE name = 'a;b'",
    'comment markers inside a literal': "SELECT name FROM customers WHERE address = 'x -- y /* z */'",
    'a keyword inside a literal': "SELECT name FROM customers WHERE city = 'Set' OR city = 'Insert Drop'",
    'apostrophe escaping': "SELECT name FROM customers WHERE name = 'O''Brien'",
    'non-ASCII inside a literal': "SELECT name FROM customers WHERE name = 'José'",
    'CTE of the model\'s own': 'WITH a AS (SELECT customer_id FROM customers) SELECT count(*) FROM a',
    'date functions': "SELECT count(*) FROM documents_v WHERE service_date >= '2026-01-01' AND left(service_date, 7) = '2026-09'",
    'EXISTS / NOT EXISTS subqueries': 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM doc_links l WHERE l.customer_id = c.customer_id) AND NOT EXISTS (SELECT 1 FROM equipment e WHERE e.customer_id = c.customer_id)',
    'extract(year from ...)': 'SELECT extract(year from created_at) AS y, count(*) FROM documents_v GROUP BY 1',
    'casts with a length': 'SELECT CAST(tonnage AS numeric(4,1)) FROM equipment',
    'window function': 'SELECT name, row_number() OVER (ORDER BY name) FROM customers',
    'CTE column list alias': 'WITH t(a) AS (SELECT 1) SELECT a FROM t',
    'IN list and lower()': "SELECT * FROM documents_v WHERE lower(document_type) IN ('permit', 'invoice')",
    'ILIKE and coalesce': "SELECT coalesce(name, 'x') FROM customers WHERE address ILIKE '%mesa%'",
    'column named created_at is not CREATE': 'SELECT created_at FROM customers',
    'jsonb operator': "SELECT to_jsonb(name) ->> 0 FROM customers",
  };
  for (const [name, sql] of Object.entries(good)) {
    const r = guardSql(sql);
    check(`guard accepts: ${name}`, r.ok === true, r.ok ? '' : r.error);
  }

  // Every real table in the migrations is on the deny list (so a new table cannot be forgotten).
  const cfg = path.join(ROOT, 'M3-config');
  const created = new Set();
  for (const f of fs.readdirSync(cfg).filter((x) => x.endsWith('.sql'))) {
    for (const m of fs.readFileSync(path.join(cfg, f), 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)) created.add(m[1].toLowerCase());
  }
  const missing = [...created].filter((tname) => !REAL_TABLES.includes(tname) && tname !== 'playing_with_neon');
  eq('every CREATE TABLE in M3-config is in the guard\'s REAL_TABLES deny list', missing, []);
  check('view names never collide with real tables', VIEW_NAMES.every((v) => !REAL_TABLES.includes(v)));
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const harnessNotes = [];
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
// 01b creates the app role and grants on tables, but depends on resolve_tenant() from a later file; re-run it last.
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); harnessNotes.push('01b-app-role.sql: re-run after the rest (dependency order)'); }
catch (err) { harnessNotes.push(`01b re-run failed: ${err.message}`); }
for (const line of harnessNotes) console.log(`NOTE  migration harness: ${line}`);
const role = (await lite.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'deepwell_rls'")).rows[0];
check('harness: the app role deepwell_rls exists, is not a superuser and does not bypass RLS', Boolean(role) && !role.rolsuper && !role.rolbypassrls, JSON.stringify(role));

// ---- pg.Pool -> PGlite (one session, so a mutex stands in for "one connection per client") ----
const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
const statementLog = [];
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return {
    query: (sql, params) => { statementLog.push(String(sql).trim()); return lite.query(sql, params); },
    release: () => { lite.exec('RESET ROLE').finally(release); },
  };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { createToolbox, VIEW_DOCS: VIEW_DOCS_TEXT } = await import('../api/_lib/agent/tools.js');
const { runDonovanAgent, MAX_TURNS, agentDebugTrace, agentQuestionHash, AGENT_PROMPT_VERSION, AGENT_SYSTEM_PROMPT } = await import('../api/_lib/agent/loop.js');
const { shapeAgentAnswer } = await import('../api/_lib/agent/shape.js');
const { EvidenceLedger } = await import('../api/_lib/agent/tools.js');
const { ModelBudgetExceededError } = await import('../api/_lib/rateLimit.js');
const { NO_ANSWER_TEXT } = await import('../api/_lib/answer.js');

const TODAY = '2026-09-23';
const ctxA = { tenantKey: 'org_harness_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_harness_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedTenant(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address, phone: c.phone ?? null, email: c.email ?? null }, { number: `C-0000${c.n}` });
  for (const e of world.equipment) {
    await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) }, { customerId: uid(t, 'c', e.customer) });
  }
  for (const d of world.docs) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, d.stage ?? 'verified']);
    for (const link of d.links ?? []) {
      await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
    }
    for (const [i, x] of (d.facts ?? []).entries()) {
      await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, corrected_value, confidence) VALUES ($1,$2,$3,$4,$5,$6,0.9)',
        [tenantId, uid(t, 'd', d.n), x.entity ?? null, x.key, x.value, x.corrected ?? null]);
      void i;
    }
    for (const [i, text] of (d.pages ?? []).entries()) {
      await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid(t, 'd', d.n), tenantId, i + 1, text]);
    }
  }
}

const worldA = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201', phone: '(480) 555-0148' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 4, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701' },
    { n: 5, name: 'Old Timer', address: '5 Oak Rd, Phoenix, AZ 85001' },
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1001', type: 'condenser', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01', registrationOnFile: '2020-06-01' } },
    { n: 2, customer: 2, mfr: 'Goodman', model: 'GSX140361K', serial: 'GD-2002', type: 'condenser', installed: '2016-10-15', address: '88 Whitmore Ave, Mesa, AZ 85201', warranty: { expires: '2026-10-15' } },
    { n: 3, customer: 3, mfr: 'Carrier', model: '24ACC636', serial: 'CR-3003', type: 'condenser', installed: '2014-01-01', address: '2210 E Main St, Gilbert, AZ 85234', warranty: { expires: '2024-01-01' } },
    { n: 4, customer: 4, mfr: 'Lennox', model: 'EL16XC1', serial: 'LX-4004', type: 'condenser', installed: '2019-03-03', address: '17 Cactus Ln, Tucson, AZ 85701' },
    { n: 5, customer: 1, mfr: 'Trane', model: 'S9V2', serial: 'TR-1005', type: 'furnace', installed: '2021-01-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2029-01-01' } },
  ],
  docs: [
    { n: 1, file: 'karen-service-sep.pdf', type: 'service-ticket', links: [uid('a', 'c', 1)], facts: [{ key: 'service_date', value: '2026-09-10' }, { key: 'technician', value: 'D. Ramirez' }], pages: ['Service ticket Karen Abernathy 412 Elm St'] },
    { n: 2, file: 'karen-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 1)], facts: [{ key: 'agreement_term', value: '01/01/2026 - 12/31/2026' }] },
    { n: 3, file: 'whitmore-service-2025.pdf', type: 'service-ticket', links: [uid('a', 'c', 2)], facts: [{ key: 'service_date', value: '2025-11-02' }] },
    { n: 4, file: 'whitmore-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 2)], facts: [{ key: 'agreement_term', value: '01/01/2025 - 12/31/2025' }] },
    { n: 5, file: 'plaza-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 3)] },
    { n: 6, file: 'thornton-permit.pdf', type: 'permit', links: [uid('a', 'c', 4)], facts: [{ key: 'permit_number', value: 'BP-2024-08841' }], pages: ['City of Tucson building permit BP-2024-08841 issued for 17 Cactus Ln condenser replacement'] },
    { n: 7, file: 'plaza-service-sep.pdf', type: 'service-ticket', links: [uid('a', 'e', 3)], facts: [{ key: 'service_date', value: '2026-09-15' }] },
    { n: 8, file: 'thornton-workorder.pdf', type: 'work-order', links: [uid('a', 'c', 4)], stage: 'read',
      facts: [{ key: 'service_date', value: '2026-03-05' }, { key: 'work_performed', value: 'Replaced capacitor' }, { key: 'work_performed', value: 'Cleared drain line' }, { key: 'technician', value: 'wrong name', corrected: 'M. Ortiz' }],
      pages: ['Work order Thornton 17 Cactus Ln. Replaced capacitor. Cleared drain line.'] },
  ],
};
const worldB = {
  customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501' }, { n: 2, name: 'Other Tenant Two', address: '2 Secret Way, Reno, NV 89501' }],
  equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9', type: 'condenser', installed: '2022-01-01', address: '1 Secret Way, Reno, NV 89501', warranty: { expires: '2035-01-01' } }],
  docs: [{ n: 1, file: 'b-secret-permit.pdf', type: 'permit', links: [uid('b', 'c', 1)], facts: [{ key: 'permit_number', value: 'B-SECRET-1' }, { key: 'service_date', value: '2026-09-12' }], pages: ['Secret permit B-SECRET-1 Zed Competitor'] }],
};
await seedTenant('a', tenA, worldA);
await seedTenant('b', tenB, worldB);
const countA = (await lite.query('SELECT count(*)::int AS n FROM entities WHERE tenant_id = $1', [tenA])).rows[0].n;
eq('harness: tenant A has 10 entities (5 customers + 5 units), tenant B 3', [countA, (await lite.query('SELECT count(*)::int AS n FROM entities WHERE tenant_id = $1', [tenB])).rows[0].n], [10, 3]);

const toolboxA = () => createToolbox({ withTenant, ctxArg: ctxA, today: TODAY });
const parse = (r) => JSON.parse(r.content);
const cell = (parsed, col) => parsed.rows.map((row) => row[parsed.columns.indexOf(col)]);

/* ================================================================== 2. RLS / read-only / timeout */
{
  const rls = (await lite.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows;
  const touched = ['entities', 'extractions', 'documents', 'document_entity_links', 'facets', 'document_pages'];
  for (const tname of touched) {
    const row = rls.find((r) => r.relname === tname);
    check(`FORCE ROW LEVEL SECURITY is on for ${tname} (a table the views/tools read)`, Boolean(row?.rls && row?.force), JSON.stringify(row));
  }
  const lacking = rls.filter((r) => !r.rls || !r.force).map((r) => r.relname);
  console.log(`NOTE  public tables without ENABLE+FORCE RLS in this harness (none are reachable by the agent): ${lacking.join(', ') || '(none)'}`);

  const tb = toolboxA();
  const viaViews = await tb.execute('run_query', { sql: 'SELECT name FROM customers ORDER BY name', purpose: 'isolation' });
  check('run_query as tenant A sees only tenant A customers via the views', viaViews.ok && cell(parse(viaViews), 'name').join('|') === 'Bill Whitmore|Donna Thornton|Karen Abernathy|Old Timer|Plaza Dental Group', viaViews.content);
  const docsView = await tb.execute('run_query', { sql: 'SELECT filename FROM documents_v', purpose: 'isolation' });
  check('documents_v never shows tenant B documents', docsView.ok && !docsView.content.includes('b-secret') && parse(docsView).rowCount === 8, docsView.content.slice(0, 200));
  const factsView = await tb.execute('run_query', { sql: "SELECT value FROM facts WHERE field_key = 'permit_number'", purpose: 'isolation' });
  eq('facts never shows tenant B facts (permit numbers)', cell(parse(factsView), 'value'), ['BP-2024-08841']);

  const superSees = (await lite.query('SELECT count(*)::int AS n FROM documents')).rows[0].n;
  eq('control: the same table read WITHOUT the app role (superuser) shows both tenants (9 documents), so the 8 above is RLS at work', superSees, 9);

  // Guard bypassed (skipGuard is a test-only switch): RLS + read-only must still hold.
  const raw = (sql, opts) => tb._runQueryForTests({ sql }, { skipGuard: true, ...opts });
  const rawDocs = await raw('SELECT original_filename FROM documents');
  check('UNGUARDED SELECT * FROM documents as tenant A: still only A rows (RLS)', rawDocs.ok && parse(rawDocs).rowCount === 8 && !rawDocs.content.includes('b-secret'), rawDocs.content.slice(0, 160));
  const rawEnt = await raw('SELECT count(*)::int AS n FROM entities');
  eq('UNGUARDED count(*) FROM entities is 10 (tenant A), not 13', cell(parse(rawEnt), 'n'), [10]);
  const rawTen = await raw('SELECT name FROM tenants');
  check('UNGUARDED SELECT FROM tenants shows only the caller\'s own row', rawTen.ok && parse(rawTen).rowCount === 1, rawTen.content.slice(0, 160));
  const rawUsers = await raw('SELECT count(*)::int AS n FROM users');
  check('UNGUARDED users table is empty for tenant A (RLS)', rawUsers.ok && cell(parse(rawUsers), 'n')[0] === 0, rawUsers.content.slice(0, 160));
  const rawPages = await raw('SELECT text FROM document_pages');
  check('UNGUARDED document_pages: no tenant B page text', rawPages.ok && !rawPages.content.includes('Secret permit'), rawPages.content.slice(0, 120));

  // The one thing RLS itself cannot stop is a call that switches the tenant GUC; the executor discards that result.
  const hop = await raw(`SELECT set_config('app.tenant_id', '${tenB}', true) AS x, (SELECT count(*) FROM customers) AS n`);
  check('UNGUARDED set_config tenant hop: result is discarded, no tenant B rows returned', hop.ok === false && !hop.content.includes('Zed'), hop.content.slice(0, 160));
  const afterHop = await tb.execute('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'after' });
  eq('the next query is unaffected by the attempted hop (still tenant A: 5 customers)', cell(parse(afterHop), 'n').map(Number), [5]);

  // Read-only
  const wr = await raw("INSERT INTO entities (tenant_id, entity_type, data) VALUES ('" + tenA + "', 'customer', '{}')");
  check('UNGUARDED INSERT is refused: transaction is read-only', wr.ok === false && /read-only/i.test(wr.content), wr.content);
  const wr2 = await raw("DELETE FROM entities");
  check('UNGUARDED DELETE is refused: transaction is read-only', wr2.ok === false && /read-only/i.test(wr2.content), wr2.content);
  const wr3 = await raw("UPDATE documents SET stage = 'received'");
  check('UNGUARDED UPDATE is refused: transaction is read-only', wr3.ok === false && /read-only/i.test(wr3.content), wr3.content);
  const still = (await lite.query('SELECT count(*)::int AS n FROM entities WHERE tenant_id = $1', [tenA])).rows[0].n;
  eq('nothing was written by any of the above', still, 10);

  // Timeout + savepoint recovery. PGlite (WASM Postgres) does not honour statement_timeout, so the
  // timeout is verified by asserting the executor SETs it (and READ ONLY, and a SAVEPOINT) before the
  // model's SQL runs; the SET LOCAL semantics themselves are stock Postgres.
  statementLog.length = 0;
  await raw('SELECT 1 AS one', { timeoutMs: 250 });
  const iRO = statementLog.findIndex((q) => /SET LOCAL transaction_read_only = on/.test(q));
  const iTO = statementLog.findIndex((q) => /SET LOCAL statement_timeout = 250/.test(q));
  const iSP = statementLog.findIndex((q) => /^SAVEPOINT agent_query/.test(q));
  const iQ = statementLog.findIndex((q) => /^SELECT 1 AS one/.test(q));
  check('the executor sets READ ONLY, then statement_timeout, then a SAVEPOINT, all before the model\'s SQL', iRO >= 0 && iRO < iTO && iTO < iSP && iSP < iQ, JSON.stringify(statementLog.slice(0, 8)));
  const defaultTimeout = statementLog.length && (await (async () => { statementLog.length = 0; await tb.execute('run_query', { sql: 'SELECT 1 AS one', purpose: 't' }); return statementLog.some((q) => /SET LOCAL statement_timeout = 3000/.test(q)); })());
  check('the default statement_timeout is 3000 ms', defaultTimeout === true);
  console.log('NOTE  statement_timeout cannot be exercised in PGlite (it does not enforce it); verify against real Postgres/Neon.');
  const bad = await tb.execute('run_query', { sql: 'SELECT no_such_column FROM customers', purpose: 'error' });
  check('a DB error comes back as an is-error result with the message', bad.ok === false && /no_such_column/.test(bad.content), bad.content);
  const good = await tb.execute('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'retry' });
  check('the next query after an error works (nothing poisoned)', good.ok === true, good.content);
  const capped = await tb.execute('run_query', { sql: 'SELECT generate_series(1, 500) AS n', purpose: 'cap' });
  check('rows are capped at 100 and the result text stays under ~6k chars', parse(capped).rowCount === 100 && capped.content.length <= 6200, `${parse(capped).rowCount} rows, ${capped.content.length} chars`);
  const wide = await tb.execute('run_query', { sql: "SELECT repeat_free FROM (SELECT 'x'::text AS repeat_free) q", purpose: 'x' });
  void wide;

  // Other tools are tenant-scoped too
  const foreign = await tb.execute('get_customer', { customerId: uid('b', 'c', 1) });
  check('get_customer with a tenant B id under tenant A returns "no such customer"', foreign.ok && parse(foreign).customer === null, foreign.content);
  const foreignFind = await tb.execute('find_customers', { name: 'Zed Competitor' });
  eq('find_customers never returns a tenant B customer', parse(foreignFind).rowCount, 0);
  const foreignSearch = await tb.execute('search_documents', { query: 'Zed Competitor B-SECRET-1' });
  eq('search_documents never returns tenant B pages', parse(foreignSearch).resultCount, 0);
}

/* ================================================================== views semantics */
{
  const tb = toolboxA();
  const eqv = await tb.execute('run_query', { sql: 'SELECT c.name, e.model, e.warranty_status, e.warranty_current, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id ORDER BY e.model', purpose: 'warranty' });
  const p = parse(eqv);
  const byModel = Object.fromEntries(p.rows.map((r) => [r[1], r[2]]));
  eq('equipment.warranty_status uses the analytics executor\'s deterministic status (active / expiring / expired / unknown)', Object.entries(byModel).sort(), Object.entries({ XR14: 'active', GSX140361K: 'expiring', '24ACC636': 'expired', EL16XC1: 'unknown', S9V2: 'active' }).sort());
  const facts = await tb.execute('run_query', { sql: "SELECT value FROM facts WHERE field_key = 'technician' ORDER BY value", purpose: 'corrected' });
  eq('facts.value applies corrected_value (M. Ortiz, not "wrong name")', cell(parse(facts), 'value'), ['D. Ramirez', 'M. Ortiz']);
  const dv = await tb.execute('run_query', { sql: 'SELECT filename, customer_name, service_date FROM documents_v WHERE service_date IS NOT NULL ORDER BY service_date', purpose: 'docs' });
  const dp = parse(dv);
  eq('documents_v resolves the customer through an equipment link (plaza ticket)', dp.rows.find((r) => r[0] === 'plaza-service-sep.pdf')?.[1], 'Plaza Dental Group');
  const geo = await tb.execute('run_query', { sql: 'SELECT city, state, zip FROM customers WHERE name = \'Karen Abernathy\'', purpose: 'geo' });
  eq('customers geography comes from analytics deriveGeo', parse(geo).rows[0], ['Mesa', 'AZ', '85201']);
  const desc = await tb.execute('describe_data', {});
  const dd = parse(desc);
  check('describe_data reports counts, document types, field keys with examples and the service-date range',
    dd.entities.customer === 5 && dd.entities.equipment === 5 && dd.documents.some((d) => d.type === 'permit' && d.count === 1)
      && dd.fields.some((f) => f.key === 'permit_number' && f.examples?.includes('BP-2024-08841')) && dd.serviceDates?.last === '2026-09-15', desc.content.slice(0, 300));
  const search = await tb.execute('search_documents', { query: 'permit BP-2024-08841', documentType: 'permit' });
  const sp = parse(search);
  check('search_documents returns excerpts with document id, page, type and customer name', sp.resultCount >= 1 && sp.results[0].documentType === 'permit' && sp.results[0].customer === 'Donna Thornton' && sp.results[0].page === 1, search.content.slice(0, 300));
  const fc = await tb.execute('find_customers', { address: '17 Cactus Ln' });
  eq('find_customers by address resolves through the existing contactLookup helpers', parse(fc).rows.map((r) => r[2]), ['Donna Thornton']);
  const gc = await tb.execute('get_customer', { customerId: uid('a', 'c', 4) });
  const gp = parse(gc);
  check('get_customer lists equipment (with warranty status) and documents with dates', gp.equipment.length === 1 && gp.equipment[0].warrantyStatus === 'unknown' && gp.documentCount === 2 && gp.lastServiceDate === '2026-03-05', gc.content.slice(0, 300));
}

/* ================================================================== 3. loop with a scripted model */
let toolUseCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
const lastToolResult = (messages) => {
  const last = messages[messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { text: block.content, isError: Boolean(block.is_error) } : null;
};
function scripted(turns, usage = { input_tokens: 1200, output_tokens: 120 }) {
  let i = 0;
  const calls = [];
  const fn = async (req) => {
    calls.push({ tool_choice: req.tool_choice, temperature: req.temperature, model: req.model, nMessages: req.messages.length, tools: req.tools.map((t) => t.name), system: req.system, lastResult: lastToolResult(req.messages) });
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const out = typeof turn === 'function' ? turn(req.messages, req) : turn;
    const content = Array.isArray(out) ? out : out.content;
    return { content, usage: out.usage ?? usage, stop_reason: 'tool_use' };
  };
  fn.calls = calls;
  return fn;
}
// Escalation is off here: these checks pin the behaviour of ONE agent run (Sonnet escalation is covered by verify-scorecard.mjs).
const run = (question, callModel, extra = {}) => runDonovanAgent({ withTenant, ctxArg: ctxA, question, today: TODAY, callModel, env: { DONOVAN_ESCALATION: '0' }, ...extra });
const usageRow = async (tenantId) => (await lite.query('SELECT model_calls, model_input_tokens, model_output_tokens FROM usage_counters WHERE tenant_id = $1', [tenantId])).rows[0];

{
  // --- multi-step tool use + error-then-retry SQL --------------------------------------------
  const model = scripted([
    () => [tu('run_query', { sql: 'SELECT * FROM documents', purpose: 'first try, real table' })],
    (m) => { const r = lastToolResult(m); return r.isError && /views/.test(r.text) ? [tu('run_query', { sql: 'SELECT no_such FROM customers', purpose: 'second try, bad column' })] : [tu('answer', { status: 'cannot_answer', text: 'x' })]; },
    (m) => { const r = lastToolResult(m); return r.isError && /no_such/.test(r.text) ? [tu('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'count customers' })] : [tu('answer', { status: 'cannot_answer', text: 'x' })]; },
    () => [tu('answer', { status: 'answered', text: 'You have 5 customers.', facts: [{ label: 'Customers', value: '5' }], confidence: 0.9 })],
  ]);
  const before = await usageRow(tenA);
  const r = await run('how many customers do we have on file', model);
  check('loop: multi-step + error-then-retry ends in a grounded answer', r.handled && r.data.kind === 'answer' && r.data.facts[0].value === '5' && r.data.text === 'You have 5 customers.', JSON.stringify(r).slice(0, 300));
  eq('loop: 4 model calls (the catalogue is in the system prompt, no describe round), 3 tool steps (2 of them errors fed back to the model)', [r.modelCalls, r.steps.length, r.steps.filter((s) => s.error).length], [4, 3, 2]);
  check('loop: temperature 0, auto tool_choice until the final turn, answer tool offered', model.calls.every((c) => c.temperature === 0) && model.calls[0].tool_choice.type === 'auto' && model.calls[0].tools.includes('answer'), JSON.stringify(model.calls[0].tool_choice));
  check('loop: system prompt + tool schemas are sent as blocks (planCacheBreakpoints shape)', Array.isArray(model.calls[0].system) && model.calls[0].system[0].type === 'text', '');
  const after = await usageRow(tenA);
  eq('loop: every model call went through recordModelCall (usage counters +4 calls)', Number(after.model_calls) - Number(before?.model_calls ?? 0), 4);
  const dbg = agentDebugTrace(r);
  check('debug trace has steps[{tool,inputSummary,rowCount,ms}], modelCalls, inputTokens, outputTokens, costUsd and no question text',
    dbg.steps.length === 3 && ['tool', 'inputSummary', 'rowCount', 'ms'].every((k) => k in dbg.steps[0]) && dbg.modelCalls === 4 && dbg.inputTokens === 4800 && dbg.outputTokens === 480 && typeof dbg.costUsd === 'number' && !JSON.stringify(dbg).includes('how many customers'), JSON.stringify(dbg));
}
{
  // --- turn cap ------------------------------------------------------------------------------
  const respectful = scripted([(m, req) => req.tool_choice.type === 'tool'
    ? [tu('answer', { status: 'none_found', text: 'nothing' })] : [tu('describe_data', {})]]);
  const r1 = await run('anything at all', respectful);
  eq('turn cap: a model that keeps calling tools gets the answer tool forced on the last call (4)', [r1.modelCalls, respectful.calls.map((c) => c.tool_choice.type).join(',')], [MAX_TURNS, 'auto,auto,auto,tool']);
  check('turn cap: forced call names the answer tool', respectful.calls[3].tool_choice.name === 'answer');
  const stubborn = scripted([() => [tu('describe_data', {})]]);
  const r2 = await run('anything at all', stubborn);
  check('turn cap: a model that ignores tool_choice stops at 4 calls with no answer', !r2.handled && r2.modelCalls === MAX_TURNS && r2.reason === 'turn-cap', `${r2.reason} ${r2.modelCalls}`);
  const r3 = await run('anything at all', stubborn, { limits: { maxTurns: 2 } });
  eq('turn cap: limits.maxTurns is honoured', r3.modelCalls, 2);
}
{
  // --- token cap -------------------------------------------------------------------------------
  const big = scripted([() => [tu('describe_data', {})]], { input_tokens: 20000, output_tokens: 50 });
  const r = await run('anything at all', big);
  check('token cap: stops before exceeding 40k cumulative input tokens (2 calls), no answer', !r.handled && r.reason === 'token-cap' && r.modelCalls === 2 && r.inputTokens === 40000, `${r.reason} calls=${r.modelCalls} in=${r.inputTokens}`);
  const mid = scripted([() => [tu('describe_data', {})], () => [tu('describe_data', {})], (m, req) => (req.tool_choice.type === 'tool' ? [tu('answer', { status: 'none_found', text: 'n' })] : [tu('describe_data', {})])], { input_tokens: 16000, output_tokens: 50 });
  await run('anything at all', mid);
  check('token cap: past 75% of the cap the next call is forced to the answer tool', mid.calls[2].tool_choice.type === 'tool', JSON.stringify(mid.calls.map((c) => c.tool_choice.type)));
  const cached = scripted([() => [tu('answer', { status: 'cannot_answer', text: 'x' })]], { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000 });
  const rc = await run('anything at all', cached);
  eq('token cap counts cache reads and writes as input', rc.inputTokens, 35100);
}
{
  // --- text-only replies, model errors, honest no-answer ----------------------------------------
  const chatty = scripted([[{ type: 'text', text: 'I think the answer is 42.' }], [{ type: 'text', text: 'Really it is 42.' }]]);
  const r = await run('anything at all', chatty);
  check('a model that never calls a tool is nudged once, then gives up (no free text ever surfaces)', !r.handled && r.data === null && r.modelCalls === 2 && r.reason === 'no-tool', `${r.reason} ${r.modelCalls}`);
  const boom = async () => { throw new Error('upstream 500'); };
  const rb = await run('anything at all', boom);
  check('a model error becomes {handled:false, reason:"error"} instead of throwing', !rb.handled && rb.reason === 'error' && /upstream/.test(rb.error), JSON.stringify(rb));
  const cant = scripted([() => [tu('answer', { status: 'cannot_answer', text: 'I made this up: 12 permits', missing: 'permit numbers' })]]);
  const rn = await run('anything at all', cant);
  check('cannot_answer is not handled (caller falls back to today\'s behaviour)', !rn.handled && rn.data === null, JSON.stringify(rn.data));
}
{
  // --- budget refusal --------------------------------------------------------------------------
  await lite.query(`UPDATE tenants SET limits = '{"maxModelCallsPerDay": 1}'::jsonb WHERE id = $1`, [tenB]);
  const u = await lite.query('SELECT * FROM increment_usage_counters($1, $2::date, 0, 1, 10, 10)', [tenB, new Date().toISOString().slice(0, 10)]);
  void u;
  const never = scripted([() => [tu('answer', { status: 'none_found', text: 'n' })]]);
  let thrown = null;
  try { await runDonovanAgent({ withTenant, ctxArg: ctxB, question: 'anything at all', today: TODAY, callModel: never }); } catch (err) { thrown = err; }
  check('budget refusal: assertModelBudget throws ModelBudgetExceededError before any model call', thrown instanceof ModelBudgetExceededError && never.calls.length === 0, String(thrown));
}

/* ================================================================== citation grounding */
{
  const tb = toolboxA();
  const search = await tb.execute('search_documents', { query: 'permit BP-2024-08841' });
  const doc = parse(search).results[0];
  const good = shapeAgentAnswer({ status: 'answered', text: 'The permit number is BP-2024-08841.', facts: [{ label: 'Permit', value: 'BP-2024-08841', sources: [{ documentId: doc.documentId, location: { page: doc.page } }] }] }, tb.ledger, { question: 'permit for 17 Cactus', today: TODAY });
  check('grounding: a fact citing a returned document + returned page is kept (with filename)', good.answered && good.data.facts.length === 1 && good.data.sources[0].filename === 'thornton-permit.pdf', JSON.stringify(good.data));
  const fake = shapeAgentAnswer({ status: 'answered', text: 'The permit number is BP-2024-08841.', facts: [{ label: 'Permit', value: 'BP-2024-08841', sources: [{ documentId: uid('a', 'd', 99), location: { page: 1 } }] }] }, tb.ledger, { question: 'q', today: TODAY });
  check('grounding: a fabricated documentId is dropped -> honest no-answer with the fixed text', !fake.answered && fake.data.kind === 'no-answer' && fake.data.text === NO_ANSWER_TEXT && fake.data.facts.length === 0, JSON.stringify(fake.data));
  const foreignDoc = shapeAgentAnswer({ status: 'answered', text: 'x', facts: [{ label: 'Permit', value: 'B-SECRET-1', sources: [{ documentId: uid('b', 'd', 1), location: { page: 1 } }] }] }, tb.ledger, { question: 'q', today: TODAY });
  check('grounding: another tenant\'s real document id that no tool returned is dropped', !foreignDoc.answered);
  const badPage = shapeAgentAnswer({ status: 'answered', text: 'x', facts: [{ label: 'Permit', value: 'BP-2024-08841', sources: [{ documentId: doc.documentId, location: { page: 7 } }] }] }, tb.ledger, { question: 'q', today: TODAY });
  check('grounding: a real document with a page nothing returned is dropped', !badPage.answered);
  const invented = shapeAgentAnswer({ status: 'answered', text: 'There are 999 permits.', facts: [{ label: 'Permits', value: '999' }] }, tb.ledger, { question: 'how many permits', today: TODAY });
  check('grounding: an unsourced aggregate whose number appears in no tool result is dropped', !invented.answered && invented.dropped.facts === 1, JSON.stringify(invented));
  const noTools = shapeAgentAnswer({ status: 'answered', text: 'You have 5 customers.', facts: [{ label: 'Customers', value: '5' }] }, new EvidenceLedger(), { question: 'how many customers', today: TODAY });
  check('grounding: with no tool evidence at all, nothing is answered', !noTools.answered);
  const liar = shapeAgentAnswer({ status: 'none_found', text: 'Nothing.' }, new EvidenceLedger(), { question: 'q', today: TODAY });
  check('grounding: none_found without any real empty result is refused', !liar.answered);
  // free text that contradicts the evidence does not surface
  const q = await tb.execute('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'count' });
  void q;
  const padded = shapeAgentAnswer({ status: 'answered', text: 'You have 5 customers and they spent $48,000 last year.', facts: [{ label: 'Customers', value: '5' }] }, tb.ledger, { question: 'how many customers', today: TODAY });
  check('grounding: model prose with a number no tool returned is replaced by text composed from the grounded facts', padded.answered && padded.data.text === 'Customers: 5.' && padded.dropped.textRewritten, padded.data.text);
  const forgedId = shapeAgentAnswer({ status: 'answered', text: 'x', facts: [{ label: 'Customers', value: '5', entityId: uid('b', 'c', 1) }] }, tb.ledger, { question: 'q', today: TODAY });
  check('grounding: an entityId no tool returned is stripped (no link into another record)', forgedId.answered && forgedId.data.facts[0].entityId === undefined && forgedId.dropped.entityIds === 1);
  const honestZero = await (async () => {
    const t2 = toolboxA();
    await t2.execute('run_query', { sql: "SELECT name FROM customers WHERE name = 'Nobody Here'", purpose: 'zero' });
    return shapeAgentAnswer({ status: 'none_found', text: 'No customer is named Nobody Here.', interpretation: 'customer by name' }, t2.ledger, { question: 'is there a customer named Nobody Here', today: TODAY });
  })();
  check('grounding: none_found after a real zero-row query is a kind "answer" (honest zero, the shape analytics uses)', honestZero.answered && honestZero.data.kind === 'answer' && honestZero.data.facts.length === 0 && /Nobody Here/.test(honestZero.data.text), JSON.stringify(honestZero.data));
}

/* ================================================================== 4. real miss questions, scripted trajectories */
const answerTool = (input) => [tu('answer', input)];
const rowsOf = (m) => JSON.parse(lastToolResult(m).text);
const col = (p, name) => p.rows.map((r) => r[p.columns.indexOf(name)]);
let missBefore = 0;
{
  // "who all has current warranties"  (39 "No answer" misses were mostly this shape)
  const model = scripted([
    () => [tu('run_query', { purpose: 'customers with a current warranty', sql: 'SELECT c.customer_id, c.name, e.model, e.warranty_status, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name, e.model' })],
    (m) => { const p = rowsOf(m); const names = [...new Set(col(p, 'name'))];
      return answerTool({ status: 'answered', text: `${names.length} customers have a current warranty.`, interpretation: 'customers with at least one active or expiring warranty',
        facts: names.map((n) => { const rows = p.rows.filter((r) => r[1] === n); return { label: n, value: rows.map((r) => `${r[2]} ${r[3]} until ${r[4]}`).join('; '), entityId: rows[0][0], status: rows.some((r) => r[3] === 'expiring') ? 'warn' : 'ok' }; }) }); },
  ]);
  const r = await run('who all has current warranties', model);
  check('miss: "who all has current warranties" -> Karen (2 units) and Whitmore (expiring); not Plaza (expired) or Donna (unknown)',
    r.handled && r.data.facts.map((f) => f.label).join('|') === 'Bill Whitmore|Karen Abernathy' && r.data.text === '2 customers have a current warranty.' && r.data.facts[0].status === 'warn' && r.data.facts[1].value.includes('2030-05-01') && r.data.facts[1].entityId === uid('a', 'c', 1),
    JSON.stringify(r.data ?? r).slice(0, 400));
  check('miss: aggregate answers use the existing unsourced-fact shape (sources: [], kind answer)', r.data.kind === 'answer' && r.data.facts.every((f) => f.sources.length === 0) && r.data.sources.length === 0 && r.data.closest.length === 0);
}
{
  // "which units had service this month"
  const model = scripted([
    () => [tu('run_query', { purpose: 'service visits this month', sql: "SELECT document_id, customer_id, customer_name, filename, service_date FROM documents_v WHERE service_date >= '2026-09-01' AND service_date < '2026-10-01' ORDER BY service_date DESC" })],
    (m) => { const p = rowsOf(m);
      return answerTool({ status: 'answered', text: `${p.rowCount} visits this month.`, facts: p.rows.map((r) => ({ label: r[2], value: r[4], entityId: r[1], sources: [{ documentId: r[0], location: { field: 'document' } }] })) }); },
  ]);
  const r = await run('which units had service this month', model);
  check('miss: "which units had service this month" -> Plaza (via unit link) and Karen, each cited to its document',
    r.handled && r.data.facts.map((f) => f.label).join('|') === 'Plaza Dental Group|Karen Abernathy' && r.data.sources.length === 2 && r.data.sources[0].filename === 'plaza-service-sep.pdf' && r.data.text === '2 visits this month.',
    JSON.stringify(r.data ?? r).slice(0, 400));
  check('miss: the cited documents count toward verified/unverified from their real stage', r.data.verifiedCount === 2 && r.data.unverifiedCount === 0, `${r.data.verifiedCount}/${r.data.unverifiedCount}`);
}
{
  // "how many customers are on a maintenance plan but haven't been serviced this year"
  const model = scripted([
    () => [tu('describe_data', {})],
    () => [tu('run_query', { purpose: 'maintenance-plan customers with no 2026 service', sql: "SELECT count(DISTINCT c.customer_id) AS n FROM customers c WHERE EXISTS (SELECT 1 FROM doc_links l JOIN documents_v d ON d.document_id = l.document_id WHERE l.customer_id = c.customer_id AND d.document_type = 'maintenance-agreement') AND NOT EXISTS (SELECT 1 FROM doc_links l JOIN documents_v d ON d.document_id = l.document_id WHERE l.customer_id = c.customer_id AND d.service_date >= '2026-01-01')" })],
    () => [tu('run_query', { purpose: 'who they are', sql: "SELECT c.customer_id, c.name FROM customers c WHERE EXISTS (SELECT 1 FROM doc_links l JOIN documents_v d ON d.document_id = l.document_id WHERE l.customer_id = c.customer_id AND d.document_type = 'maintenance-agreement') AND NOT EXISTS (SELECT 1 FROM doc_links l JOIN documents_v d ON d.document_id = l.document_id WHERE l.customer_id = c.customer_id AND d.service_date >= '2026-01-01')" })],
    (m) => { const p = rowsOf(m); return answerTool({ status: 'answered', text: '1 customer is on a maintenance plan with no service this year.', facts: [{ label: 'Customers', value: '1' }, ...p.rows.map((r) => ({ label: r[1], value: 'no 2026 service', entityId: r[0] }))] }); },
  ]);
  const r = await run("how many customers are on a maintenance plan but haven't been serviced this year", model);
  check('miss: maintenance plan + not serviced this year -> 1 (Bill Whitmore); Karen and Plaza were serviced in 2026',
    r.handled && r.data.facts[0].value === '1' && r.data.facts[1].label === 'Bill Whitmore' && r.data.facts.length === 2, JSON.stringify(r.data ?? r).slice(0, 400));
}
{
  // "which zip code has the most customers"
  const model = scripted([
    () => [tu('run_query', { purpose: 'customers per zip', sql: 'SELECT zip, count(*) AS customers FROM customers WHERE zip IS NOT NULL GROUP BY zip ORDER BY customers DESC, zip LIMIT 3' })],
    (m) => { const p = rowsOf(m); return answerTool({ status: 'answered', text: `${p.rows[0][0]} has the most customers (${p.rows[0][1]}).`, facts: p.rows.map((r) => ({ label: String(r[0]), value: String(r[1]) })) }); },
  ]);
  const r = await run('which zip code has the most customers', model);
  check('miss: "which zip code has the most customers" -> 85201 with 2', r.handled && r.data.text === '85201 has the most customers (2).' && r.data.facts[0].label === '85201' && r.data.facts[0].value === '2', JSON.stringify(r.data ?? r).slice(0, 300));
}
{
  // "what did we do at 17 Cactus Ln last visit"
  const model = scripted([
    () => [tu('find_customers', { address: '17 Cactus Ln' })],
    (m) => { const p = rowsOf(m); return [tu('get_customer', { customerId: p.rows[0][0] })]; },
    (m) => { const p = rowsOf(m); return [tu('run_query', { purpose: 'work performed at the last visit',
      sql: `SELECT f.document_id, f.field_key, f.value, d.service_date FROM facts f JOIN documents_v d ON d.document_id = f.document_id WHERE d.customer_id = '${p.customer.customerId}' AND d.service_date = '${p.lastServiceDate}' AND f.field_key IN ('work_performed', 'technician') ORDER BY f.field_key, f.value` })]; },
    (m) => { const p = rowsOf(m);
      return answerTool({ status: 'answered', text: 'On Mar 5, 2026 the tech replaced the capacitor and cleared the drain line.',
        facts: p.rows.map((r) => ({ label: r[1] === 'technician' ? 'Technician' : 'Work performed', value: r[2], sources: [{ documentId: r[0], location: { field: r[1] } }] })) }); },
  ]);
  const r = await run('what did we do at 17 Cactus Ln last visit', model);
  const vals = r.data?.facts?.map((f) => f.value).sort().join('|');
  check('miss: "what did we do at <address> last visit" -> capacitor + drain line + corrected technician, each cited to the work order',
    r.handled && vals === 'Cleared drain line|M. Ortiz|Replaced capacitor' && r.data.sources.every((s) => s.filename === 'thornton-workorder.pdf') && r.data.unverifiedCount === 1 && r.data.verifiedCount === 0, JSON.stringify(r.data ?? r).slice(0, 500));
}
{
  // a permit lookup the old pipeline calls "can't do yet"
  const model = scripted([
    () => [tu('search_documents', { query: 'permit number 17 Cactus Ln', documentType: 'permit' })],
    (m) => { const d = rowsOf(m).results[0]; return answerTool({ status: 'answered', text: 'The permit on file for 17 Cactus Ln is BP-2024-08841.', facts: [{ label: 'Permit', value: 'BP-2024-08841', sources: [{ documentId: d.documentId, location: { page: d.page } }] }] }); },
  ]);
  const r = await run('what is the permit number for 17 Cactus Ln', model);
  check('miss: permit lookup via search_documents -> cited to page 1 of the permit', r.handled && r.data.sources[0].location.page === 1 && r.data.facts[0].value === 'BP-2024-08841', JSON.stringify(r.data ?? r).slice(0, 300));
}
{
  // "what's the newest unit we've installed" (live defect: a contact-lookup route answered with the wrong unit)
  const model = scripted([
    () => [tu('run_query', { purpose: 'newest unit', sql: 'SELECT e.equipment_id, e.manufacturer, e.model, e.serial_number, e.installation_date, e.address FROM equipment e WHERE e.installation_date IS NOT NULL ORDER BY e.installation_date DESC LIMIT 5' })],
    (m) => { const p = rowsOf(m); const r = p.rows[0]; return answerTool({ status: 'answered', text: `The newest unit is the ${r[1]} ${r[2]} installed ${r[4]} at ${r[5]}.`, facts: [{ label: `${r[1]} ${r[2]}`, value: `installed ${r[4]}`, entityId: r[0] }] }); },
  ]);
  const r = await run("what's the newest unit we've installed", model);
  check('newest unit: ORDER BY installation_date DESC over the equipment view -> the Trane S9V2 (2021-01-01), grounded', r.handled && /Trane S9V2 installed 2021-01-01/.test(r.data.text) && r.data.facts[0].entityId === uid('a', 'e', 5), JSON.stringify(r.data ?? r).slice(0, 300));
}
{
  // documents-by-brand: the definition is stated, and the count follows it (units' customers' documents)
  const model = scripted([
    () => [tu('run_query', { purpose: 'trane documents', sql: "SELECT count(DISTINCT dl.document_id) AS n FROM doc_links dl WHERE dl.customer_id IN (SELECT customer_id FROM equipment WHERE lower(manufacturer) = 'trane')" })],
    (m) => { const n = rowsOf(m).rows[0][0]; return answerTool({ status: 'answered', text: `${n} documents belong to customers who own a Trane unit (documents linked to a Trane customer or unit).`, facts: [{ label: 'Trane documents', value: String(n) }] }); },
  ]);
  const r = await run('Trane documents', model);
  check('brand documents: the answer states its definition and the count matches it (Karen owns both Trane units -> 2 documents)', r.handled && r.data.facts[0].value === '2' && /customers who own a Trane unit/.test(r.data.text), JSON.stringify(r.data ?? r).slice(0, 300));
  check('the prompt tells the model the brand-documents definition to use and state', /documents of a brand/.test(VIEW_DOCS_TEXT) && /State that definition/.test(VIEW_DOCS_TEXT));
}
{
  // The model fabricates a citation mid-trajectory: the run ends in the honest no-answer (handled: false)
  const model = scripted([
    () => [tu('run_query', { purpose: 'permits', sql: "SELECT document_id FROM documents_v WHERE document_type = 'permit'" })],
    () => answerTool({ status: 'answered', text: 'Permit BP-2024-08841.', facts: [{ label: 'Permit', value: 'BP-2024-08841', sources: [{ documentId: uid('a', 'd', 77), location: { field: 'permit_number' } }] }] }),
  ]);
  const r = await run('what is the permit number for 17 Cactus Ln', model);
  check('miss: fabricated citation in a full run -> not handled (caller keeps today\'s no-answer text)', !r.handled && r.data === null && r.dropped.facts === 1, JSON.stringify(r.dropped));
}
{
  // cache key namespacing
  check('agent cache hash is namespaced (never equals a retrieval or analytics hash) and stable', agentQuestionHash('Who all has warranties?') === agentQuestionHash('  who all has warranties '), '');
  check('agent prompt version is a 12-char fingerprint', /^[0-9a-f]{12}$/.test(AGENT_PROMPT_VERSION));
  const { analyticsQuestionHash } = await import('../api/_lib/analytics.js');
  check('agent cache hash differs from the analytics hash for the same text', agentQuestionHash('who all has warranties') !== analyticsQuestionHash('who all has warranties'));
  const { isCountableAskSource } = await import('../api/_lib/usage.js');
  check('an agent run counts against the monthly allowance (usage.js COUNTABLE_ASK_SOURCES)', isCountableAskSource('agent'));
  const { MISS_OUTCOMES } = await import('../api/_lib/missStore.js');
  check('AGENT_NO_ANSWER is a new plain-text outcome (no DDL: ask_misses.outcome has no CHECK)', MISS_OUTCOMES.AGENT_NO_ANSWER === 'agent-no-answer' && !/CHECK\s*\(\s*outcome/i.test(fs.readFileSync(path.join(cfgDir, '23-ask-misses.sql'), 'utf8')));
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
  eq('exactly 12 files directly under api/ (Vercel Hobby limit)', apiFiles, 12);
}
void missBefore;


/* ================================================================== 5. round 2: list completeness, catalogue, scoped search, intents */
{
  // --- a shop with 13 warrantied customers (15 units) - live defect: 5 were returned, phrased as complete ---
  const ctxC = { tenantKey: 'org_harness_c', tenantName: 'Warranty Heavy HVAC' };
  const tenC = (await getTenantContext(ctxC.tenantKey, ctxC.tenantName)).id;
  const names = ['Ada Lovelace', 'Ben Franklin', 'Cara Mendez', 'Dan Whitaker', 'Eve Hollis', 'Finn Corrigan', 'Gia Romano', 'Hal Brooks', 'Ida Nakamura', 'Jon Pruitt', 'Kim Alvarez', 'Lou Stanton', 'Mae Fitzgerald', 'Ned Ostrander', 'Opal Reyes'];
  const worldC = { customers: [], equipment: [], docs: [] };
  names.forEach((nm, i) => worldC.customers.push({ n: i + 1, name: nm, address: `${100 + i} Palm Way, Mesa, AZ 85201` }));
  let un = 0;
  names.forEach((nm, i) => {
    const cur = i < 13; // 13 customers hold a current warranty, 2 are expired
    const units = i < 2 ? 2 : 1; // two customers hold two units -> 15 current units
    for (let k = 0; k < units; k++) {
      un++;
      worldC.equipment.push({ n: un, customer: i + 1, mfr: 'Rheem', model: `RA${1000 + un}`, serial: `SN-C-${un}`, type: 'condenser', installed: '2024-01-01', address: worldC.customers[i].address,
        warranty: { expires: cur ? '2031-01-01' : '2020-01-01' } });
    }
  });
  await seedTenant('c', tenC, worldC);
  const runC = (q, model, extra = {}) => runDonovanAgent({ withTenant, ctxArg: ctxC, question: q, today: TODAY, callModel: model, ...extra });
  const currentSql = 'SELECT c.customer_id, c.name, e.model, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name, e.model';
  const listModel = (textOverride) => scripted([
    () => [tu('run_query', { purpose: 'current warranties', sql: currentSql })],
    (m) => { const p = rowsOf(m); const distinct = [...new Set(col(p, 'name'))];
      return answerTool({ status: 'answered', text: textOverride ?? `${distinct.length} customers have a current warranty.`,
        facts: distinct.map((n) => { const rows = p.rows.filter((r) => r[1] === n); return { label: n, value: rows.map((r) => `${r[2]} until ${r[3]}`).join('; '), entityId: rows[0][0] }; }) }); },
  ]);
  const full = await runC('who all has current warranties', listModel());
  check('list: 13 warrantied customers (15 units) -> ALL 13 come back as facts, none dropped', full.handled && full.data.facts.length === 13 && full.dropped.facts === 0, `${full.data?.facts?.length} dropped=${full.dropped?.facts}`);
  check('list: the true total (13) is stated in the sentence', /\b13\b/.test(full.data.text) && full.data.text === '13 customers have a current warranty.', full.data.text);
  const noNumber = await runC('who all has current warranties', listModel('These customers hold a current warranty.'));
  check('list: a sentence with no total gets the true total appended (never an unqualified list)', noNumber.handled && /\b13 in all\b/.test(noNumber.data.text), noNumber.data.text);
  const garbage = await runC('who all has current warranties', listModel('They spent $99,999 with us.'));
  check('list: an ungroundable sentence is replaced by a real sentence - never "N results."', garbage.handled && !/^\d+ results\.?$/.test(garbage.data.text) && /13/.test(garbage.data.text) && garbage.data.text.length > 20, garbage.data.text);
  const five = shapeAgentAnswer({ status: 'answered', text: 'Nope', facts: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((n) => ({ label: n, value: `${n} unit` })) }, (() => { const l = new EvidenceLedger(); l.addShown('Alpha Bravo Charlie Delta Echo unit'); l.dataCalls = 1; return l; })(), { question: 'q', today: TODAY });
  check('list: the composed fallback for 5 facts is a sentence, not "5 results."', five.answered && !/^\d+ results\.$/.test(five.data.text) && /5/.test(five.data.text), five.data.text);

  // more rows than fit in the result text -> the model is told, and the answer says how much it shows
  const big = createToolbox({ withTenant, ctxArg: ctxC, today: TODAY });
  const rowsBig = await big.execute('run_query', { purpose: 'wide', sql: "SELECT customer_id, name, address, name || ' ' || address || ' ' || address || ' ' || address AS pad FROM customers c CROSS JOIN generate_series(1, 6) g ORDER BY name" });
  const pb = parse(rowsBig);
  check('list: a result too wide to fit says truncated + tells the model to narrow the query', pb.truncated === true && pb.shown < pb.rowCount && /narrow/.test(pb.note), rowsBig.content.slice(-200));
  const trunc = shapeAgentAnswer({ status: 'answered', text: 'Here are the customers.', facts: [{ label: 'Ada Lovelace', value: '100 Palm Way' }, { label: 'Ben Franklin', value: '101 Palm Way' }] }, big.ledger, { question: 'q', today: TODAY });
  check('list: an answer built on a truncated result says "Showing N of M" instead of implying completeness', trunc.answered && /Showing 2 of 90/.test(trunc.data.text), trunc.data.text);
  const cap = createToolbox({ withTenant, ctxArg: ctxC, today: TODAY });
  await cap.execute('run_query', { purpose: 'all', sql: 'SELECT customer_id, name FROM customers ORDER BY name' });
  const fortyOne = shapeAgentAnswer({ status: 'answered', text: 'Everyone.', facts: Array.from({ length: 45 }, (_, i) => ({ label: names[i % 15], value: names[i % 15] })) }, cap.ledger, { question: 'q', today: TODAY });
  check('list: more than 40 facts -> first 40 with an honest "Showing 40 of 45"', fortyOne.answered && fortyOne.data.facts.length === 40 && /Showing 40 of 45/.test(fortyOne.data.text), `${fortyOne.data?.facts?.length} ${fortyOne.data?.text}`);
  check('answer tool allows up to 40 facts', (await import('../api/_lib/agent/tools.js')).ANSWER_TOOL_DEF.input_schema.properties.facts.maxItems === 40);

  // --- catalogue rides in the cached system prompt, per tenant, for ~10 minutes (no describe round) ---
  const { resetCatalogueCacheForTests } = await import('../api/_lib/agent/loop.js');
  resetCatalogueCacheForTests();
  const cm = scripted([() => answerTool({ status: 'cannot_answer', text: 'x' })]);
  statementLog.length = 0;
  await runC('anything at all', cm);
  const sysA = cm.calls[0].system;
  check('catalogue: the system prompt carries a second, cached block with this shop\'s entity counts and field keys', sysA.length === 2 && /CATALOGUE/.test(sysA[1].text) && /"customer":15/.test(sysA[1].text) && /"equipment":17/.test(sysA[1].text), JSON.stringify(sysA[1]?.text).slice(0, 200));
  check('catalogue: the block never includes today\'s date (stable => cacheable)', !/"today"/.test(sysA[1].text));
  const describeQueries = () => statementLog.filter((q) => /GROUP BY 1 ORDER BY 1/.test(q) && /entity_type, count/.test(q)).length;
  const firstCount = describeQueries();
  const cm2 = scripted([() => answerTool({ status: 'cannot_answer', text: 'x' })]);
  await runC('another question', cm2);
  eq('catalogue: a second run for the same shop within 10 minutes does not re-query it', [firstCount, describeQueries()], [1, 1]);
  const cmA = scripted([() => answerTool({ status: 'cannot_answer', text: 'x' })]);
  await run('anything at all', cmA);
  check('catalogue: another shop gets its own catalogue (no leakage between tenants)', /"customer":5/.test(cmA.calls[0].system[1].text) && !/Ada Lovelace|Warranty Heavy/.test(cmA.calls[0].system[1].text) && !/"customer":15/.test(cmA.calls[0].system[1].text));
  check('the agent system prompt tells the model the catalogue is provided, and states the list + history rules', /catalogue of this shop/i.test(AGENT_SYSTEM_PROMPT) && /EVERY row/.test(AGENT_SYSTEM_PROMPT) && /History questions/.test(AGENT_SYSTEM_PROMPT) && /SAY which in text/.test(AGENT_SYSTEM_PROMPT));
}
{
  // --- search_documents scoped to one customer's documents (repair-history questions) ---
  const tb = toolboxA();
  const scoped = await tb.execute('search_documents', { query: 'replaced capacitor', customerId: uid('a', 'c', 4) });
  const sp = parse(scoped);
  check('search_documents with customerId reads that customer\'s own documents (Thornton work order)', sp.resultCount >= 1 && sp.results.every((r) => r.filename === 'thornton-workorder.pdf' || r.customer === 'Donna Thornton') && /capacitor/i.test(sp.results[0].excerpt), scoped.content.slice(0, 300));
  const wrong = await tb.execute('search_documents', { query: 'replaced capacitor', customerId: uid('a', 'c', 1) });
  eq('search_documents scoped to a customer with no such text returns nothing (honest empty)', parse(wrong).resultCount, 0);
  const foreign = await tb.execute('search_documents', { query: 'secret permit', customerId: uid('b', 'c', 1) });
  eq('search_documents scoped to another tenant\'s customer id finds nothing (RLS)', parse(foreign).resultCount, 0);
  const bad = await tb.execute('search_documents', { query: 'x', customerId: 'not-a-uuid' });
  check('search_documents rejects a customerId that is not an id a tool returned', bad.ok === false && /customer_id/.test(bad.content));
  // a repair-history trajectory: address -> customer -> scoped search -> cited quote / honest none
  const hist = scripted([
    () => [tu('find_customers', { address: '17 Cactus Ln' })],
    (m) => [tu('search_documents', { query: 'capacitor replaced', customerId: rowsOf(m).rows[0][0] })],
    (m) => { const d = rowsOf(m).results[0]; return answerTool({ status: 'answered', text: 'Yes - the work order says the capacitor was replaced (no compressor).', facts: [{ label: 'Work order', value: 'Replaced capacitor', sources: [{ documentId: d.documentId, location: { page: d.page } }] }] }); },
  ]);
  const rh = await run('has this unit had a capacitor replaced? 17 Cactus Ln', hist);
  check('history: address -> scoped search -> answer cites the work order page', rh.handled && rh.data.sources[0].filename === 'thornton-workorder.pdf' && rh.modelCalls === 3, JSON.stringify(rh.data ?? rh).slice(0, 300));
  const none = scripted([
    () => [tu('find_customers', { address: '17 Cactus Ln' })],
    (m) => [tu('search_documents', { query: 'compressor', customerId: rowsOf(m).rows[0][0] })],
    () => answerTool({ status: 'none_found', text: 'No document on file for 17 Cactus Ln mentions a compressor replacement.' }),
  ]);
  const rn = await run('has this unit had a compressor replaced? 17 Cactus Ln', none);
  check('history: nothing found after a real scoped search -> an honest sentence, not a no-answer', rn.handled && rn.data.kind === 'answer' && /compressor replacement/.test(rn.data.text), JSON.stringify(rn.data ?? rn).slice(0, 300));
}
{
  const { isEnumerationQuestion, isRepairHistoryQuestion, isAgentFirstQuestion } = await import('../api/_lib/agent/intents.js');
  const yes = ['who all has current warranties', 'list every customer in Mesa with a Trane', 'which customers have a maintenance agreement', 'show me all units installed this year'];
  const no = ['what is the phone number for Donna Thornton', 'when was the unit at 17 Cactus Ln installed', 'how many customers do we have'];
  check('intents: enumeration questions are agent-first', yes.every(isEnumerationQuestion), yes.filter((q) => !isEnumerationQuestion(q)).join(' | '));
  check('intents: single-field lookups are not enumerations', no.every((q) => !isEnumerationQuestion(q)), no.filter(isEnumerationQuestion).join(' | '));
  check('intents: repair-history questions are agent-first', isRepairHistoryQuestion('has this unit had a compressor replaced? 12 Main St') && isAgentFirstQuestion('did they ever replace the capacitor at 17 Cactus Ln') && !isRepairHistoryQuestion('when was the unit at 17 Cactus Ln installed'));
  const { isUnitRankingQuestion } = await import('../api/_lib/agent/intents.js');
  check('intents: "newest/oldest unit" questions are agent-first (ranking the fleet needs ORDER BY)', isUnitRankingQuestion("what's the newest unit we've installed") && isAgentFirstQuestion("what's the oldest system we still service") && !isUnitRankingQuestion('who is our biggest customer'));
  const { parseContactLookupQuestion } = await import('../api/_lib/contactLookup.js');
  check('"what\'s the newest unit we\'ve installed" is no longer parsed as a contact lookup for a customer named "newest"', parseContactLookupQuestion("what's the newest unit we've installed") === null && parseContactLookupQuestion("what's the oldest unit we've installed") === null);
  check('a real name lookup still parses', parseContactLookupQuestion("what's the phone number on file for donna thornton")?.namePhrase === 'donna thornton');
}

/* ================================================================== static wiring checks on api/ask.js */
{
  const ask = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  const loop = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'agent', 'loop.js'), 'utf8');
  check('ask.js: agent wiring is behind DONOVAN_AGENT via isAgentEnabled() (default on, "0" disables)', /isAgentEnabled\(\)/.test(ask) && /DONOVAN_AGENT !== "0"/.test(loop));
  check('ask.js: the agent is tried from five places (incl. money gate) + agent-first (analytics fallback / unhandled, no retrieval, model no-answer, enumeration/history before retrieval)', (ask.match(/await tryAgent\(/g) ?? []).length === 6, String((ask.match(/await tryAgent\(/g) ?? []).length));
  check('ask.js: the money gate is left alone (money-fallback never goes to the agent)', /missOutcome !== MISS_OUTCOMES\.MONEY_FALLBACK/.test(ask));
  check('ask.js: data.debug needs an operator AND body.debug === true', /req\.body\?\.debug === true && isPlatformOperator\(auth\)/.test(ask));
  check('ask.js: agent answers are cached under their own hash + prompt version', /agentQuestionHash\(question\)/.test(ask) && /promptVersion: AGENT_PROMPT_VERSION/.test(ask));
  check('ask.js: the agent path never logs question text', !/console\.(log|error)\([^)]*question[^)]*\)/.test(ask.slice(ask.indexOf('const tryAgent'), ask.indexOf('// ---- overlap, not a chain'))));
  check('agent loop logs counts only (no question / answer text)', !/JSON\.stringify\(\{[^}]*(question|text)/.test(loop.slice(loop.indexOf('console.log('))));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
process.exit(0);
