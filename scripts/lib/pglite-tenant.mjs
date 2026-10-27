// Shared in-process Postgres (PGlite) with the real DeepWell schema, row-level security and the real app role, for scripts that run the real
// server code (recordsStore, reviewStore, recheck, importAutopilot) without a database. Used by verify-import-autopilot.mjs and
// proof-import-autopilot.mjs. Nothing here talks to a network. Run from the app root.
import fs from 'node:fs';
import path from 'node:path';

export async function startPglite(root) {
  process.env.NEON_CONNECTION_STRING ||= 'postgres://verify:verify@localhost-pooler/verify';
  process.env.DATABASE_URL ||= process.env.NEON_CONNECTION_STRING;
  const { PGlite } = await import('@electric-sql/pglite');
  const contrib = {};
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
  const lite = new PGlite({ extensions: contrib });
  const cfg = path.join(root, 'M3-config');
  for (const f of fs.readdirSync(cfg).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) { try { await lite.exec(fs.readFileSync(path.join(cfg, f), 'utf8')); } catch { /* optional migrations */ } }
  try { await lite.exec(fs.readFileSync(path.join(cfg, '01b-app-role.sql'), 'utf8')); } catch { /* already there */ }
  const pgMod = (await import('pg')).default;
  let tail = Promise.resolve();
  const lock = () => { let r2; const p = new Promise((r) => { r2 = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => r2); };
  pgMod.Pool.prototype.connect = async function () { const r = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (s, p) => lite.query(s, p), release: () => { lite.exec('RESET ROLE').finally(r); } }; };
  pgMod.Pool.prototype.query = async function (s, p) { const r = await lock(); try { return await lite.query(s, p); } finally { r(); } };
  const rs = await import(path.join(root, 'api/_lib/recordsStore.js'));
  let seq = 0;
  const nid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
  return { lite, nid, getTenantContext: rs.getTenantContext, rs };
}

/** Bulk inserts with unnest, so 5,000 papers load in seconds. rows: [{id, name, type, stage, batch, sha}] */
export async function insertDocs(lite, tenantId, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const p = rows.slice(i, i + 500);
    await lite.query(
      `INSERT INTO documents (id, tenant_id, batch_id, original_filename, document_type, sha256_hash, stage, created_at, extracted_at, page_count)
       SELECT x.id, $1::uuid, x.batch, x.name, x.type, x.sha, x.stage, NOW() - (x.ord * INTERVAL '1 second'), NOW() - INTERVAL '2 hours', 1
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[]) AS x(id, batch, name, type, sha, stage, ord)`,
      [tenantId, p.map((r) => r.id), p.map((r) => r.batch ?? null), p.map((r) => r.name), p.map((r) => r.type ?? null), p.map((r) => r.sha ?? `h-${r.id}`), p.map((r) => r.stage ?? 'read'), p.map((_, k) => i + k)]);
  }
}
export async function insertPages(lite, tenantId, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const p = rows.slice(i, i + 500);
    await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) SELECT $1::uuid, x.d, x.n, x.t FROM unnest($2::uuid[], $3::int[], $4::text[]) AS x(d, n, t)`,
      [tenantId, p.map((r) => r.id), p.map((r) => r.page ?? 1), p.map((r) => r.text)]);
  }
}
/** fields: [{doc, key, value, conf}] -> plain extraction rows (no facet), like a finished read */
export async function insertFields(lite, tenantId, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const p = rows.slice(i, i + 500);
    await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at) SELECT $1::uuid, x.d, x.k, x.v, x.c, NOW() FROM unnest($2::uuid[], $3::text[], $4::text[], $5::float8[]) AS x(d, k, v, c)`,
      [tenantId, p.map((r) => r.doc), p.map((r) => r.key), p.map((r) => r.value), p.map((r) => r.conf ?? 0.95)]);
  }
}
export async function insertCustomers(lite, tenantId, rows) {
  for (const r of rows) await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [r.id, tenantId, JSON.stringify({ customer_name: r.name, ...(r.address ? { service_address: r.address } : {}) })]);
}
export async function insertLinks(lite, tenantId, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const p = rows.slice(i, i + 500);
    await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) SELECT $1::uuid, x.d, x.e, 0.9, 'ai', NOW() FROM unnest($2::uuid[], $3::uuid[]) AS x(d, e)`,
      [tenantId, p.map((r) => r.doc), p.map((r) => r.entity)]);
  }
}
