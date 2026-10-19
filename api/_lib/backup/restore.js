/**
 * Reading backups back: list, verify, restore into a database, write a company's files out. Used by scripts/backup-restore.mjs
 * (the owner's tool) and by the tests. Talks to Postgres through a plain `client.query(sql, params)` so it works with `pg`
 * and with the test database alike. Never connects to anything by itself, and refuses a target that looks like production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveTenantKey, decrypt, gunzip, sha256Hex } from './crypto.js';
import { keys, getJson, listSnapshotDates } from './engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/* ---------------------------------------------------------------- finding things */

export async function listCompanies(storage, masterKey) {
  const { prefixes } = await storage.list('v1/', { delimiter: '/' });
  const out = [];
  for (const p of prefixes) {
    const tid = p.slice(3, -1);
    if (!UUID_RE.test(tid)) continue;
    const { done } = await listSnapshotDates(storage, tid);
    const latest = done[done.length - 1] ?? null;
    let m = null;
    if (latest) m = await readManifest(storage, masterKey, tid, latest).catch(() => null);
    out.push({ tenantId: tid, tenantKey: m?.tenantKey ?? null, companyName: m?.companyName ?? null, snapshots: done, latest });
  }
  return out;
}

/** selector: the company's uuid or its Clerk org key. */
export async function findCompany(storage, masterKey, selector) {
  const all = await listCompanies(storage, masterKey);
  const hit = all.find((c) => c.tenantId === selector || c.tenantKey === selector);
  if (!hit) throw new Error(`No backup found for "${selector}". Run "list" to see what exists.`);
  return hit;
}

export async function readManifest(storage, masterKey, tid, date) {
  const m = await getJson(storage, keys.manifest(tid, date), deriveTenantKey(masterKey, tid));
  if (!m) throw new Error(`No finished backup for ${tid} on ${date}`);
  return m;
}

export async function readPartLines(storage, masterKey, tid, part, { checkHash = true } = {}) {
  const blob = await storage.get(part.key);
  if (!blob) throw new Error(`Backup object is missing: ${part.key}`);
  if (checkHash && sha256Hex(blob) !== part.sha256) throw new Error(`Backup object failed its checksum: ${part.key}`);
  const text = gunzip(decrypt(deriveTenantKey(masterKey, tid), blob, part.key)).toString('utf8');
  return text.split('\n').filter(Boolean);
}

/* ---------------------------------------------------------------- safety */

const hostDb = (url) => { try { const u = new URL(url); return `${u.hostname.toLowerCase()}${u.pathname}`; } catch { return null; } };

/** Throws if `target` is (or looks like) the production database. env names only; values are compared, never printed. */
export function assertSafeTarget(target, env = process.env) {
  const t = hostDb(target);
  if (!t) throw new Error('The target must be a postgres:// connection string.');
  for (const name of ['NEON_CONNECTION_STRING', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) {
    const prod = env[name] ? hostDb(env[name]) : null;
    if (prod && (prod === t || prod.split('/')[0].replace(/-pooler/, '') === t.split('/')[0].replace(/-pooler/, ''))) {
      throw new Error(`Refusing to restore: the target looks like production (same server as ${name}). Restore into a NEW Neon branch or a local database.`);
    }
  }
  return true;
}

/* ---------------------------------------------------------------- restore into a database */

async function columnsOf(client, table) {
  if (!SAFE_IDENT.test(table)) throw new Error('unsafe table name');
  const { rows } = await client.query(
    `SELECT a.attname AS name, a.attgenerated AS gen, a.attidentity AS ident
       FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [`public."${table}"`]);
  return rows;
}

/**
 * Put one company's snapshot into `client`'s database (inside the caller's transaction if it already BEGAN; otherwise this
 * opens and commits its own). Existing rows are left alone (ON CONFLICT DO NOTHING), so it is safe to run twice.
 * @returns {{tables: Record<string,{expected:number, inserted:number, present:number}>, warnings: string[]}}
 */
export async function restoreSnapshot({ storage, masterKey, tid, date, client, tables = null, batchRows = 500, ownTransaction = true, clean = false, onProgress = () => {} }) {
  const m = await readManifest(storage, masterKey, tid, date);
  const warnings = [];
  if (ownTransaction) await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tid]); // so row-level security lets this company's rows in
    try {
      await client.query('SAVEPOINT rep');
      await client.query(`SET LOCAL session_replication_role = 'replica'`); // load parents and children in any order; skip derived-data triggers
      await client.query('RELEASE SAVEPOINT rep');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT rep');
      warnings.push('Could not switch off triggers (needs a superuser role); tables are loaded parents-first instead.');
    }
    // clean: empty this company's rows first. Only for verify mode, which runs inside a transaction that is rolled back.
    if (clean) {
      if (ownTransaction) throw new Error('clean needs a surrounding transaction that the caller rolls back');
      for (const table of Object.keys(m.tables).reverse()) {
        if (!SAFE_IDENT.test(table) || (tables && !tables.includes(table))) continue;
        await client.query(`DELETE FROM "${table}" WHERE ${table === 'tenants' ? 'id' : 'tenant_id'} = $1`, [tid]);
      }
    }
    const report = {};
    for (const [table, rec] of Object.entries(m.tables)) {
      if (tables && !tables.includes(table)) continue;
      const cols = await columnsOf(client, table);
      if (!cols.length) throw new Error(`The target database has no table "${table}". Run the app's migrations (M3-config/*.sql) on it first.`);
      const usable = cols.filter((c) => !c.gen).map((c) => `"${c.name}"`);
      const override = cols.some((c) => c.ident === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
      let inserted = 0;
      for (const part of rec.parts) {
        const lines = await readPartLines(storage, masterKey, tid, part);
        for (let i = 0; i < lines.length; i += batchRows) {
          const res = await client.query(
            `INSERT INTO "${table}" (${usable.join(', ')})${override} SELECT ${usable.join(', ')} FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb) ON CONFLICT DO NOTHING`,
            [`[${lines.slice(i, i + batchRows).join(',')}]`]);
          inserted += res.rowCount ?? 0;
        }
        onProgress({ table, part: part.key });
      }
      const scope = table === 'tenants' ? 'id' : 'tenant_id';
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${scope} = $1`, [tid]);
      report[table] = { expected: rec.rows, inserted, present: rows[0].n };
    }
    if (ownTransaction) await client.query('COMMIT');
    return { manifest: m, tables: report, warnings };
  } catch (err) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/* ---------------------------------------------------------------- verify */

/**
 * Check a snapshot end to end. Always: every database part and every file object exists, matches its checksum and decrypts.
 * With `client` (a scratch database): also restores into it inside a transaction, compares each table's row count with the
 * manifest, and ROLLS BACK, so the scratch database stays empty.
 * @param {{files?: 'all'|'sample'|'none', sample?: number}} [opts]
 */
export async function verifySnapshot({ storage, masterKey, tid, date, client = null, files = 'sample', sample = 25 }) {
  const problems = [];
  const m = await readManifest(storage, masterKey, tid, date);
  const k = deriveTenantKey(masterKey, tid);
  let partsChecked = 0; let filesChecked = 0;
  const entries = [];
  for (const [table, rec] of Object.entries(m.tables)) {
    for (const part of rec.parts) {
      try {
        const lines = await readPartLines(storage, masterKey, tid, part);
        if (lines.length !== part.rows) problems.push(`${part.key}: ${lines.length} rows, manifest says ${part.rows}`);
        partsChecked++;
      } catch (err) { problems.push(`${table}: ${err.message}`); }
    }
  }
  for (const part of m.files.parts) {
    try { (await readPartLines(storage, masterKey, tid, part)).forEach((l) => entries.push(JSON.parse(l))); partsChecked++; } catch (err) { problems.push(`file list: ${err.message}`); }
  }
  const stored = entries.filter((e) => e.backupKey);
  const toCheck = files === 'all' ? stored : files === 'none' ? [] : stored.filter((_, i) => i < sample || i % Math.ceil(stored.length / sample) === 0);
  for (const e of stored) if (!(await storage.head(e.backupKey))) problems.push(`file object missing: ${e.backupKey}`);
  for (const e of toCheck) {
    try {
      const blob = await storage.get(e.backupKey);
      if (!blob || sha256Hex(decrypt(k, blob, e.backupKey)) !== e.sha256) problems.push(`file failed its checksum: ${e.backupKey}`);
      filesChecked++;
    } catch (err) { problems.push(`file ${e.backupKey}: ${err.message}`); }
  }
  if (m.files.total !== entries.length) problems.push(`file list has ${entries.length} entries, manifest says ${m.files.total}`);
  let restored = null;
  if (client) {
    await client.query('BEGIN');
    try {
      const r = await restoreSnapshot({ storage, masterKey, tid, date, client, ownTransaction: false, clean: true });
      restored = r.tables;
      for (const [t, v] of Object.entries(r.tables)) if (v.present !== v.expected) problems.push(`table ${t}: restored ${v.present} rows, manifest says ${v.expected}`);
    } catch (err) { problems.push(`restore failed: ${err.message}`); } finally { await client.query('ROLLBACK').catch(() => {}); }
  }
  return { ok: problems.length === 0, tenantId: tid, date, partsChecked, filesChecked, filesListed: entries.length, problems, restored };
}

/* ---------------------------------------------------------------- files out */

const safeName = (s, fb) => String(s ?? fb).replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100) || fb;

/** Write a company's original files to `dir/<Company>/<type>/<name>` (plain, readable), plus files.csv. Returns counts. */
export async function writeFilesToDir({ storage, masterKey, tid, date, dir, only = null }) {
  const m = await readManifest(storage, masterKey, tid, date);
  const k = deriveTenantKey(masterKey, tid);
  const root = path.join(dir, safeName(m.companyName, tid));
  const used = new Set(); const rows = ['document_id,file,type,date,size,sha256,status'];
  let written = 0; let skipped = 0;
  for (const part of m.files.parts) {
    for (const line of await readPartLines(storage, masterKey, tid, part)) {
      const e = JSON.parse(line);
      if (only && !only(e)) continue;
      let rel = null;
      if (e.backupKey) {
        const blob = await storage.get(e.backupKey);
        if (!blob) { skipped++; rows.push([e.documentId, e.filename, e.type, e.createdAt, e.sizeBytes, e.sha256, 'backup-object-missing'].join(',')); continue; }
        const plain = decrypt(k, blob, e.backupKey);
        if (sha256Hex(plain) !== e.sha256) { skipped++; continue; }
        const base = safeName(e.filename, e.documentId); let n = 1; let cand;
        do { cand = path.join(safeName(e.type, 'other'), n === 1 ? base : base.replace(/(\.[^.]*)?$/, ` (${n})$1`)); n++; } while (used.has(cand.toLowerCase()));
        used.add(cand.toLowerCase()); rel = cand;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), plain);
        written++;
      } else skipped++;
      rows.push([e.documentId, `"${String(rel ?? e.filename ?? '').replace(/"/g, '""')}"`, e.type, e.createdAt, e.sizeBytes, e.sha256, e.status].join(','));
    }
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'files.csv'), rows.join('\r\n') + '\r\n');
  return { dir: root, written, skipped };
}

/** Put a company's originals back into an object store at their ORIGINAL storage keys (disaster recovery of the production bucket). */
export async function pushFilesToStorage({ storage, masterKey, tid, date, target }) {
  const m = await readManifest(storage, masterKey, tid, date);
  const k = deriveTenantKey(masterKey, tid);
  let pushed = 0; let skipped = 0;
  for (const part of m.files.parts) {
    for (const line of await readPartLines(storage, masterKey, tid, part)) {
      const e = JSON.parse(line);
      if (!e.backupKey || !e.storageKey || !e.storageKey.startsWith(`${tid}/`)) { skipped++; continue; }
      const blob = await storage.get(e.backupKey);
      if (!blob) { skipped++; continue; }
      const plain = decrypt(k, blob, e.backupKey);
      if (sha256Hex(plain) !== e.sha256) { skipped++; continue; }
      if (await target.head(e.storageKey)) { skipped++; continue; }
      await target.put(e.storageKey, plain);
      pushed++;
    }
  }
  return { pushed, skipped };
}

/** Decrypt a company's database tables to plain JSON-lines files in `dir` (the "hand it back" bundle). */
export async function writeTablesToDir({ storage, masterKey, tid, date, dir }) {
  const m = await readManifest(storage, masterKey, tid, date);
  const root = path.join(dir, safeName(m.companyName, tid), 'data');
  fs.mkdirSync(root, { recursive: true });
  for (const [table, rec] of Object.entries(m.tables)) {
    const out = [];
    for (const part of rec.parts) out.push(...(await readPartLines(storage, masterKey, tid, part)));
    fs.writeFileSync(path.join(root, `${table}.jsonl`), out.join('\n') + (out.length ? '\n' : ''));
  }
  fs.writeFileSync(path.join(root, '_manifest.json'), JSON.stringify({ ...m, tables: Object.fromEntries(Object.entries(m.tables).map(([t, r]) => [t, r.rows])) }, null, 2));
  return { dir: root, tables: Object.keys(m.tables).length };
}

/** Erase every backup object of ONE company (a customer who left and asked for their data to be erased). Returns how many objects went. */
export async function purgeCompany(storage, tid) {
  if (!UUID_RE.test(tid)) throw new Error('company id must be a uuid');
  const { keys: all } = await storage.list(`v1/${tid}/`);
  for (const k of all) await storage.del(k);
  return { deleted: all.length };
}
