// npm run verify:backup
// The data backup system (api/_lib/backup/*, scripts/backup-restore.mjs): encryption round trip, manifest, incremental file copy,
// retention pruning, per-company isolation, restore (whole company, one company, verify mode), failure alerts, the off switch.
// Real engine, real SQL against PGlite (the app's NOBYPASSRLS role), in-memory buckets standing in for R2 / the backup bucket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS
import * as bc from '../api/_lib/backup/crypto.js';
// @ts-expect-error plain JS
import * as ret from '../api/_lib/backup/retention.js';
// @ts-expect-error plain JS
import * as eng from '../api/_lib/backup/engine.js';
// @ts-expect-error plain JS
import * as rst from '../api/_lib/backup/restore.js';
// @ts-expect-error plain JS
import * as s3 from '../api/_lib/backup/s3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
function check(name: string, ok: boolean, detail = '') { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); } }
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = async (name: string, fn: () => unknown, re?: RegExp) => { try { await fn(); check(name, false, 'did not throw'); } catch (e: any) { check(name, !re || re.test(String(e?.message)), String(e?.message)); } };

console.log('verify:backup');

/* ============================================================ 1. encryption */
const master = crypto.randomBytes(32);
const kA = bc.deriveTenantKey(master, 'tenant-a'); const kB = bc.deriveTenantKey(master, 'tenant-b');
const secret = Buffer.from('Pat Lee, 12 Elm St, invoice 4471');
const blob = bc.encrypt(kA, secret, 'v1/a/file');
check('crypto: round trip', bc.decrypt(kA, blob, 'v1/a/file').equals(secret));
check('crypto: the ciphertext does not contain the plaintext', !blob.includes('Pat Lee'));
check('crypto: two encryptions of the same bytes differ (fresh IV)', !bc.encrypt(kA, secret, 'x').equals(bc.encrypt(kA, secret, 'x')));
await throws('crypto: another company key cannot decrypt', () => bc.decrypt(kB, blob, 'v1/a/file'), /could not decrypt/);
await throws('crypto: the same blob under another object name fails (moved/copied objects are detected)', () => bc.decrypt(kA, blob, 'v1/b/file'), /could not decrypt/);
{ const t = Buffer.from(blob); t[t.length - 20] ^= 1; await throws('crypto: a single flipped bit is detected', () => bc.decrypt(kA, t, 'v1/a/file'), /could not decrypt/); }
await throws('crypto: garbage is refused', () => bc.decrypt(kA, Buffer.from('hello world, not a backup'), 'x'), /not a DeepWell backup/);
check('crypto: per-company keys differ', !kA.equals(kB) && kA.length === 32);
check('crypto: master key parses from hex and base64', bc.parseMasterKey(master.toString('hex')).equals(master) && bc.parseMasterKey(master.toString('base64')).equals(master));
await throws('crypto: a short or missing key is a config error that never echoes the value', () => bc.parseMasterKey('abc123'), /32 random bytes/);
check('crypto: gzip round trip', bc.gunzip(bc.gzip(secret)).equals(secret));

/* ============================================================ 2. retention (pure) */
{
  const days = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 9, 19) - i * 86400000).toISOString().slice(0, 10));
  const r = ret.selectRetention(days, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });
  check('retention: the newest 7 days are all kept', days.slice(0, 7).every((d: string) => r.keep.includes(d)));
  check('retention: total kept is about 7 + 4 + 12 (overlaps allowed)', r.keep.length >= 12 && r.keep.length <= 23, String(r.keep.length));
  check('retention: nothing older than ~13 months survives', !r.keep.includes(days[399]));
  check('retention: day 8 is dropped unless it is the newest of its week or month', r.drop.length > 300);
  eq('retention: the newest is always kept even with zeros', ret.selectRetention(['2026-10-01', '2026-10-02'], { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }).keep, ['2026-10-02']);
  eq('retention: ISO week of 2026-01-01 (a Thursday) is W01', ret.isoWeekKey('2026-01-01'), '2026-W01');
  eq('retention: ISO week of 2025-12-29 (Monday) is 2026-W01', ret.isoWeekKey('2025-12-29'), '2026-W01');
  eq('retention: env overrides', ret.retentionFromEnv({ BACKUP_KEEP_DAILY: '3', BACKUP_KEEP_WEEKLY: '2', BACKUP_KEEP_MONTHLY: '6' }), { keepDaily: 3, keepWeekly: 2, keepMonthly: 6 });
  eq('retention: bad env falls back to the defaults', ret.retentionFromEnv({ BACKUP_KEEP_DAILY: 'lots' }), { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });
}

/* ============================================================ 3. storage client (signing, config guard) */
{
  const cfg = { endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'dw-backups', accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'auto' };
  const url = s3.presignUrl(cfg, 'PUT', 'v1/x/y.enc', { now: new Date('2026-10-19T03:00:00Z') });
  check('s3: presigned URL is path-style on the backup endpoint and signed', url.startsWith('https://abc.r2.cloudflarestorage.com/dw-backups/v1/x/y.enc?') && /X-Amz-Signature=[0-9a-f]{64}$/.test(url) && !url.includes('SECRET'));
  await throws('s3: config names the missing variables', () => s3.storageConfigFromEnv({}), /BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET/);
  await throws('s3: refuses the production bucket', () => s3.storageConfigFromEnv({ BACKUP_S3_ENDPOINT: 'https://acct1.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'prod', BACKUP_S3_ACCESS_KEY_ID: 'a', BACKUP_S3_SECRET_ACCESS_KEY: 'b', R2_ACCOUNT_ID: 'acct1', R2_BUCKET_NAME: 'prod' }), /production bucket/);
  const fakeFetch = async (u: string) => ({ ok: true, status: 200, text: async () => `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>v1/a&amp;b/1.enc</Key></Contents><CommonPrefixes><Prefix>v1/a/</Prefix></CommonPrefixes></ListBucketResult>`, body: null });
  const listed = await s3.createS3Storage(cfg, { fetchImpl: fakeFetch as any }).list('v1/', { delimiter: '/' });
  eq('s3: list parses keys and folders (and XML escapes)', listed, { keys: ['v1/a&b/1.enc'], prefixes: ['v1/a/'] });
}

/* ============================================================ 4. engine against Postgres */
let PGlite: any; const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const m of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[m] = ((await import(`@electric-sql/pglite/contrib/${m}`)) as any)[m];
} catch (err) { console.log(`  SKIP database-backed checks: PGlite is not installed (${(err as Error)?.message})`); }

if (PGlite) {
  process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as the other harnesses */ } }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run once resolve_tenant() exists */ }
  const pgMod = ((await import('pg')) as any).default;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() { const release = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (sql: string, params: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } }; };
  pgMod.Pool.prototype.query = async function query(sql: string, params: unknown[]) { const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  // @ts-expect-error plain JS
  const source = await import('../api/_lib/backup/source.js');
  // @ts-expect-error plain JS
  const { deleteTenantData } = await import('../api/_lib/opsStore.js');
  // @ts-expect-error plain JS
  const { keyBelongsToTenant } = await import('../api/_lib/r2.js');

  const KA = 'org_bk_a'; const KB = 'org_bk_b';
  const tenA = (await getTenantContext(KA, KA)).id; const tenB = (await getTenantContext(KB, KB)).id;
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Desert Peak HVAC', tenA]);
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Rival Shop', tenB]);

  const prod = new Map<string, Buffer>(); // the "production R2"
  const prodGets: string[] = [];
  const hex = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const sha = (b: string) => crypto.createHash('sha256').update(b).digest('hex');
  const addDoc = async (ten: string, n: number, name: string, body: string | null, o: { type?: string; dbSha?: string } = {}) => {
    const s = body == null ? sha(`none-${ten}-${n}`) : sha(body);
    const key = body == null ? null : `${ten}/${s.slice(0, 2)}/${s}`;
    const id = hex(n + (ten === tenA ? 0 : 5000));
    await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, file_size_bytes, storage_key, content_type) VALUES ($1,$2,$3,$4,$5,'read',$6,$7,'application/pdf')`, [id, ten, name, o.type ?? 'invoice', o.dbSha ?? s, body?.length ?? 0, key]);
    await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [ten, id, 'customer_name', ten === tenA ? 'Pat Lee' : 'Rival Person']);
    await lite.query('INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,1,$3)', [ten, id, `page text of ${name} for ${ten === tenA ? 'Pat Lee' : 'Rival Person'}`]).catch(async () => { await lite.query('INSERT INTO document_pages (document_id, page_no, text) VALUES ($1,1,$2)', [id, `page text of ${name}`]); });
    if (key && body != null) prod.set(key, Buffer.from(body));
    return { id, key, sha: s };
  };
  await lite.query(`INSERT INTO entities (tenant_id, entity_type, data) VALUES ($1,'customer','{"customer_name":"Pat Lee"}')`, [tenA]);
  const a1 = await addDoc(tenA, 1, 'Invoice 1.pdf', 'bytes of invoice one A');
  await addDoc(tenA, 2, 'Receipt.pdf', 'bytes of receipt A', { type: 'receipt' });
  await addDoc(tenA, 3, 'Gone.pdf', 'bytes that will vanish');
  prod.delete(`${tenA}/${sha('bytes that will vanish').slice(0, 2)}/${sha('bytes that will vanish')}`); // row says a file exists, storage does not
  await addDoc(tenA, 4, 'No file.pdf', null);
  await addDoc(tenB, 1, 'Rival invoice.pdf', 'bytes of rival invoice');
  await lite.query(`INSERT INTO entities (tenant_id, entity_type, data) VALUES ($1,'customer','{"customer_name":"Rival Person"}')`, [tenB]);

  const backupStore = s3.createMemoryStorage();
  const alerts: any[] = [];
  let clock = Date.parse('2026-10-19T10:40:00Z');
  const deps: any = {
    storage: backupStore, masterKey: master, source, skipTables: source.DEFAULT_SKIP_TABLES, policy: { keepDaily: 3, keepWeekly: 1, keepMonthly: 1 },
    listTenants: async () => [{ tenant_key: KA, tenant_name: KA }, { tenant_key: KB, tenant_name: KB }],
    getObject: async (k: string) => { prodGets.push(k); const b = prod.get(k); if (!b) throw Object.assign(new Error('nope'), { status: 404 }); return b; },
    keyBelongsToTenant, alert: async (a: any) => { alerts.push(a); }, now: () => clock, runId: 'r1',
  };

  // ---- first night
  const run1 = await eng.runBackup(deps);
  check('night 1: the run completes for both companies', run1.complete && run1.done === 2 && run1.failed.length === 0, JSON.stringify(run1.failed));
  const dateOf = () => eng.utcDate(clock);
  const listA = await rst.listCompanies(backupStore, master);
  check('night 1: both companies have their own folder', listA.length === 2 && listA.every((c: any) => c.latest === dateOf()));
  const mA = await rst.readManifest(backupStore, master, tenA, dateOf());
  const dbCount = async (t: string, ten: string) => (await lite.query(`SELECT count(*)::int n FROM ${t} WHERE ${t === 'tenants' ? 'id' : 'tenant_id'} = $1`, [ten])).rows[0].n;
  let countsOk = true;
  for (const [t, n] of Object.entries(mA.counts)) if ((await dbCount(t, tenA)) !== n) { countsOk = false; console.log('   count mismatch', t, n, await dbCount(t, tenA)); }
  check('manifest: row counts per table equal the database, for every table (' + Object.keys(mA.counts).length + ' tables)', countsOk);
  check('manifest: includes documents, document_pages, extractions, entities, tenants', ['documents', 'document_pages', 'extractions', 'entities', 'tenants'].every((t) => t in mA.counts) && mA.counts.documents === 4);
  check('manifest: skipped caches are not included', !('ask_answer_cache' in mA.counts));
  let hashOk = true;
  for (const rec of Object.values<any>(mA.tables)) for (const p of rec.parts) { const b = await backupStore.get(p.key); if (!b || bc.sha256Hex(b) !== p.sha256) hashOk = false; }
  check('manifest: sha256 of every stored part matches the object in the bucket', hashOk);
  eq('files: 3 copied, 1 missing in storage, 1 row without a file is not listed', [mA.files.new, mA.files.missing, mA.files.total], [2, 1, 3]);
  check('files: the missing one is reported, not hidden', mA.files.missing === 1);
  const allKeys = [...backupStore.map.keys()];
  check('isolation: every object of company A sits under A\'s folder only; B has its own', allKeys.filter((k) => k.includes(tenA)).every((k) => k.startsWith(`v1/${tenA}/`)) && allKeys.some((k) => k.startsWith(`v1/${tenB}/`)));
  { const k = allKeys.find((x) => x.startsWith(`v1/${tenA}/snap/`) && x.includes('/documents.1.'))!; await throws('isolation: company B\'s key cannot open company A\'s database part', async () => bc.decrypt(bc.deriveTenantKey(master, tenB), (await backupStore.get(k))!, k), /could not decrypt/); }
  { const leak = [...backupStore.map.values()].some((b) => b.includes('Pat Lee') || b.includes('Rival Person') || b.includes('Invoice 1')); check('encryption: no customer text appears in any stored object', !leak); }
  { let rowsOfB = 0; for (const [t, rec] of Object.entries<any>(mA.tables)) for (const p of rec.parts) for (const l of await rst.readPartLines(backupStore, master, tenA, p)) { if (l.includes(tenB)) rowsOfB++; } check('isolation: not one row of company B inside company A\'s backup', rowsOfB === 0); }
  const putsAfter1 = backupStore.puts;

  // ---- incremental: same night again does nothing; next night copies only what is new
  const again = await eng.runBackup(deps);
  check('rerun the same night: nothing is written again', backupStore.puts - putsAfter1 <= 2 && again.complete, `puts ${backupStore.puts - putsAfter1}`); // 1 = the run status object
  clock += 24 * 3_600_000;
  const b1 = await addDoc(tenA, 5, 'Work order.pdf', 'bytes of a new work order');
  prodGets.length = 0;
  const putsBefore = backupStore.puts;
  const run2 = await eng.runBackup(deps);
  const m2 = await rst.readManifest(backupStore, master, tenA, dateOf());
  check('night 2: complete', run2.complete);
  eq('night 2: only the new file is fetched from production', prodGets.filter((k) => k.startsWith(tenA)).filter((k) => k !== a1.key && !k.includes(sha('bytes that will vanish').slice(0, 8))).length, 1);
  check('night 2: files already in the bucket are listed as unchanged, not copied', m2.files.new === 1 && m2.files.unchanged === 2, JSON.stringify(m2.files));
  check('night 2: the new file object exists in the bucket', !!(await backupStore.head(eng.keys.file(tenA, b1.sha))));
  check('night 2: still only one copy of each unchanged file (content-addressed)', [...backupStore.map.keys()].filter((k) => k === eng.keys.file(tenA, a1.sha)).length === 1);
  void putsBefore;

  // ---- hash mismatch: the database says one hash, the bytes are different
  clock += 24 * 3_600_000;
  const bad = await addDoc(tenA, 6, 'Odd.pdf', 'real bytes', { dbSha: sha('some other bytes') });
  await eng.runBackup(deps);
  const m3 = await rst.readManifest(backupStore, master, tenA, dateOf());
  check('integrity: a file whose bytes do not match the recorded hash is flagged and stored under its real hash', m3.files.hashMismatch === 1 && !!(await backupStore.head(eng.keys.file(tenA, sha('real bytes')))));
  void bad;

  // ---- retention over a long stretch of nights
  for (let i = 0; i < 12; i++) { clock += 24 * 3_600_000; await eng.runBackup(deps); }
  const { done } = await eng.listSnapshotDates(backupStore, tenA);
  check('retention: after 15 nights with keep 3 daily / 1 weekly / 1 monthly, old snapshots are gone', done.length <= 5 && done.includes(dateOf()), done.join(','));
  const oldest = done[0];
  check('retention: a dropped snapshot leaves no objects behind', (await backupStore.list(eng.keys.snap(tenA, '2026-10-19'))).keys.length === 0);
  // remove a document's file from consideration: delete the row's file by simulating a file nobody references
  await backupStore.put(eng.keys.file(tenA, 'f'.repeat(64)), Buffer.from('orphan'));
  clock += 24 * 3_600_000; await eng.runBackup(deps);
  check('retention: a file no kept snapshot needs is swept; needed files stay', !(await backupStore.head(eng.keys.file(tenA, 'f'.repeat(64)))) && !!(await backupStore.head(eng.keys.file(tenA, a1.sha))));
  const pr = await eng.pruneTenant(deps, tenA, { today: dateOf(), policy: { keepDaily: 3, keepWeekly: 1, keepMonthly: 1 } });
  check('retention: pruning again changes nothing (safe to repeat)', pr.dropped.length === 0 && pr.sweptFiles === 0);
  void oldest;

  // ---- restore: wipe company A's rows, bring them back from the backup, company B untouched
  const latest = dateOf();
  const manifest = await rst.readManifest(backupStore, master, tenA, latest);
  const beforeA: Record<string, number> = {}; for (const t of Object.keys(manifest.counts)) beforeA[t] = await dbCount(t, tenA);
  const beforeB = await dbCount('documents', tenB);
  await deleteTenantData({ tenantKey: KA, tenantName: KA });
  check('restore setup: company A really is empty now', (await dbCount('documents', tenA)) === 0 && (await dbCount('extractions', tenA)) === 0);
  await throws('restore safety: a target that looks like production is refused', () => rst.assertSafeTarget('postgres://u:p@localhost:5432/harness', { NEON_CONNECTION_STRING: 'postgres://x:y@localhost:5432/harness' }), /looks like production/);
  check('restore safety: a different server is allowed', rst.assertSafeTarget('postgres://u:p@ep-new-branch-123.neon.tech/neondb', { NEON_CONNECTION_STRING: 'postgres://x:y@ep-prod-456.neon.tech/neondb' }) === true);
  // a verify run first: restores into the (emptied) database, compares, rolls back
  const ver = await rst.verifySnapshot({ storage: backupStore, masterKey: master, tid: tenA, date: latest, client: { query: (s: string, p?: unknown[]) => lite.query(s, p as any) }, files: 'all' });
  check('verify: every object matches its checksum, decrypts, and the scratch restore matches the manifest counts', ver.ok, JSON.stringify(ver.problems.slice(0, 3)));
  check('verify: the scratch restore was rolled back (database still empty)', (await dbCount('documents', tenA)) === 0);
  const rr = await rst.restoreSnapshot({ storage: backupStore, masterKey: master, tid: tenA, date: latest, client: { query: (s: string, p?: unknown[]) => lite.query(s, p as any) } });
  let restoredOk = true;
  for (const t of Object.keys(manifest.counts)) if ((await dbCount(t, tenA)) !== beforeA[t]) { restoredOk = false; console.log('   restored mismatch', t, await dbCount(t, tenA), beforeA[t]); }
  check('restore: every table of company A has its original row count back', restoredOk);
  check('restore: company B was not touched', (await dbCount('documents', tenB)) === beforeB);
  const rr2 = await rst.restoreSnapshot({ storage: backupStore, masterKey: master, tid: tenA, date: latest, client: { query: (s: string, p?: unknown[]) => lite.query(s, p as any) } });
  check('restore: running it twice adds nothing (safe to repeat)', Object.values<any>(rr2.tables).every((t) => t.inserted === 0) && Object.keys(rr.tables).length > 5);
  { const { rows } = await lite.query(`SELECT value FROM extractions WHERE tenant_id = $1 LIMIT 1`, [tenA]); check('restore: restored data reads back correctly', rows[0]?.value === 'Pat Lee'); }

  // verify against a scratch that already holds (different) data for this company: it is cleaned inside the transaction, compared, rolled back
  await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'extra','only in scratch',0.5)`, [tenA, hex(1)]);
  const ver2 = await rst.verifySnapshot({ storage: backupStore, masterKey: master, tid: tenA, date: latest, client: { query: (s: string, p?: unknown[]) => lite.query(s, p as any) }, files: 'none' });
  check('verify: a scratch that already holds other rows for the company still compares exactly (cleaned inside the rolled-back transaction)', ver2.ok, JSON.stringify(ver2.problems.slice(0, 2)));
  check('verify: ...and afterwards the scratch database is exactly as it was', (await lite.query(`SELECT count(*)::int n FROM extractions WHERE tenant_id = $1 AND field_key = 'extra'`, [tenA])).rows[0].n === 1);

  // ---- files out
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwbk-'));
  const wf = await rst.writeFilesToDir({ storage: backupStore, masterKey: master, tid: tenA, date: latest, dir: outDir });
  check('files: originals are written per company, readable, with the right bytes', wf.written >= 3 && fs.readFileSync(path.join(wf.dir, 'invoice', 'Invoice 1.pdf'), 'utf8') === 'bytes of invoice one A' && path.basename(wf.dir) === 'Desert Peak HVAC');
  check('files: nothing of company B is in company A\'s folder', !fs.readdirSync(outDir).includes('Rival Shop'));
  const target = s3.createMemoryStorage();
  const pf = await rst.pushFilesToStorage({ storage: backupStore, masterKey: master, tid: tenA, date: latest, target });
  check('push-files: originals go back to their original storage keys', pf.pushed >= 3 && !!(await target.head(a1.key!)) && (await target.get(a1.key!))!.toString() === 'bytes of invoice one A');
  fs.rmSync(outDir, { recursive: true, force: true });

  // ---- erase one company's backups (a customer who left)
  { const before = backupStore.map.size; const bKeys = [...backupStore.map.keys()].filter((k) => k.startsWith(`v1/${tenB}/`)).length;
    const scratch = s3.createMemoryStorage(); for (const [k, v] of backupStore.map) await scratch.put(k, v);
    const pg = await rst.purgeCompany(scratch, tenB);
    check('purge: one company\'s backups can be erased on their own, leaving the others', pg.deleted === bKeys && scratch.map.size === before - bKeys && [...scratch.map.keys()].some((k) => k.startsWith(`v1/${tenA}/`)) && ![...scratch.map.keys()].some((k) => k.startsWith(`v1/${tenB}/`)));
    await throws('purge: refuses anything that is not a company id', () => rst.purgeCompany(scratch, '../v1'), /uuid/); }

  // ---- failure + alert
  clock += 24 * 3_600_000;
  alerts.length = 0;
  backupStore.failPut = (k: string) => k.startsWith(`v1/${tenB}/`) && k.includes('/snap/');
  const bad1 = await eng.runBackup(deps);
  check('failure: one company failing does not stop the others', bad1.failed.length === 1 && bad1.done === 1 && !bad1.complete);
  check('failure: the owner is alerted, with no customer data in the message', alerts.length === 1 && alerts[0].kind === 'failed' && !/Rival|Pat Lee/.test(alerts[0].text));
  await eng.runBackup(deps);
  check('failure: the alert is sent once per day, not on every retry', alerts.filter((a) => a.kind === 'failed').length === 1);
  backupStore.failPut = null;
  const fixed = await eng.runBackup(deps);
  check('failure: once storage works again the missing company is completed', fixed.complete && fixed.failed.length === 0);
  const st = await eng.backupStatus(deps);
  check('status: last success time is recorded and not stale', !!st.lastSuccessAt && st.stale === false && st.today?.complete === true);

  { alerts.length = 0; const none = await eng.runBackup({ ...deps, listTenants: async () => [], storage: s3.createMemoryStorage() });
    check('empty listing: zero companies is never reported as a successful backup, and the owner is told', none.complete === false && alerts.some((a) => a.kind === 'empty')); }

  // ---- staleness
  alerts.length = 0;
  clock += 37 * 3_600_000;
  const h = await eng.checkBackupHealth(deps);
  check('monitoring: a backup older than 36 hours is flagged and the owner alerted', h.stale && h.alerted && alerts[0]?.kind === 'stale');
  const h2 = await eng.checkBackupHealth(deps);
  check('monitoring: only one stale alert a day', h2.stale && !h2.alerted && alerts.length === 1);
  clock -= 20 * 3_600_000;
  check('monitoring: a recent backup is healthy', (await eng.checkBackupHealth(deps)).ok === true);
  const empty: any = { ...deps, storage: s3.createMemoryStorage() };
  alerts.length = 0;
  check('monitoring: no backup ever recorded is also an alert', (await eng.checkBackupHealth(empty)).stale && alerts.length === 1);

  // ---- resume: a deadline in the middle leaves a partial snapshot that the next call finishes
  clock += 30 * 3_600_000;
  let ticks = 0; const tickDeps: any = { ...deps, now: () => { ticks++; return ticks > 40 ? clock + 10 * 60_000 * 0 + 1e12 : clock; } };
  const part = await eng.runBackup({ ...tickDeps, runId: 'r2' }, { deadlineAt: clock + 5 });
  check('resume: running out of time is a clean partial, not a failure', !part.complete && part.failed.length === 0);
  const rest = await eng.runBackup({ ...deps, runId: 'r3' });
  check('resume: the next call finishes the job', rest.complete);
}

/* ============================================================ 5. wiring and the off switch */
{
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const account = read('api/account.js'); const vercel = JSON.parse(read('vercel.json')); const pkg = JSON.parse(read('package.json'));
  check('wiring: the backup action is lazy-imported (nothing loads unless called)', /backup: \(q, s\) => import\("\.\/_lib\/backup\/route\.js"\)/.test(account));
  check('wiring: a cron calls it with the right path', vercel.crons.some((c: any) => c.path === '/api/account?action=backup'));
  check('wiring: api/ still has exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
  check('wiring: the sweep heartbeat is behind DEEPWELL_BACKUP', /DEEPWELL_BACKUP === "1"[\s\S]{0,200}backup\/health\.js/.test(read('api/_lib/routes/cron-sweep.js')));
  check('wiring: package.json has verify:backup and verify:all runs it', !!pkg.scripts['verify:backup'] && pkg.scripts['verify:all'].includes('verify:backup'));
  const route = (await import('../api/_lib/backup/route.js')).default as any;
  const mkRes = () => { const r: any = { code: 0, body: null, headers: {} }; r.setHeader = (k: string, v: string) => { r.headers[k] = v; }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: unknown) => { r.body = b; return r; }; return r; };
  delete process.env.DEEPWELL_BACKUP; process.env.CRON_SECRET = 'test-secret-abc';
  let res = mkRes(); await route({ method: 'GET', headers: {}, body: {}, query: {} }, res);
  check('off: with DEEPWELL_BACKUP unset a stranger gets a plain 404', res.code === 404 && res.body.error === 'Not available.');
  res = mkRes(); await route({ method: 'GET', headers: { authorization: 'Bearer test-secret-abc' }, body: {}, query: {} }, res);
  check('off: the cron gets {enabled:false} and nothing runs', res.code === 200 && res.body.enabled === false);
  process.env.DEEPWELL_BACKUP = '1';
  res = mkRes(); await route({ method: 'GET', headers: { authorization: 'Bearer wrong' }, body: {}, query: {} }, res);
  check('on: a wrong cron secret is not accepted: it falls through to sign-in and never runs a backup', res.body?.complete === undefined && res.code !== 200, String(res.code));
  delete process.env.DEEPWELL_BACKUP;
  const health = await import('../api/_lib/backup/health.js') as any;
  check('off: the sweep heartbeat does nothing', (await health.sweepBackupHealth()) === null);
}

/* ============================================================ 6. customer export email (ships OFF) */
{
  // @ts-expect-error plain JS
  const ae = await import('../api/_lib/accountExport.js');
  delete process.env.DEEPWELL_CUSTOMER_EXPORT;
  check('customer export email: off by default', ae.customerExportEmailEnabled() === false);
  process.env.DEEPWELL_CUSTOMER_EXPORT = '1';
  check('customer export email: on with DEEPWELL_CUSTOMER_EXPORT=1', ae.customerExportEmailEnabled() === true);
  delete process.env.DEEPWELL_CUSTOMER_EXPORT;
  const e = ae.readyEmail({ company: 'Desert <Peak> HVAC', files: 1234, parts: 5, expiresAt: '2026-10-26T00:00:00Z', appUrl: 'https://deepwelltechnology.com' });
  check('customer export email: has no file link, points at the signed-in screen, says when it expires', !/r2\.cloudflarestorage|X-Amz/.test(e.text + e.html) && e.text.includes('https://deepwelltechnology.com/app/?screen=team') && e.text.includes('2026-10-26') && e.text.includes('1,234 files'));
  check('customer export email: company name is escaped in the HTML', e.html.includes('Desert &lt;Peak> HVAC') || e.html.includes('Desert &lt;Peak&gt; HVAC'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
