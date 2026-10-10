// npm run verify:account-export
// "Download all my files" (api/_lib/accountExport.js): the pure pieces (paths, de-duplication, chunking, manifest, keys, wording),
// then the real engine against Postgres (PGlite, the app's NOBYPASSRLS role) with an in-memory bucket: tenant scoping, the admin
// gate, People and HR, chunking into parts, the manifest, links that expire, the audit trail and the bell notice.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS module without types
import * as ae from '../api/_lib/accountExport.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throwsStatus = async (name: string, status: number, fn: () => Promise<unknown>) => {
  try { await fn(); check(name, false, 'did not throw'); } catch (e: any) { check(name, e?.status === status, `status ${e?.status}: ${e?.message}`); }
};

console.log('verify:account-export');

/* ============================================================ 1. pure pieces */
eq('path segment: separators and reserved characters removed', ae.safeSegment('A/B\\C:D*E?F"G<H>I|J'), 'A B C D E F G H I J');
eq('path segment: leading dots and trailing dots/spaces trimmed', ae.safeSegment('  ..hidden. '), 'hidden');
eq('path segment: empty falls back', ae.safeSegment('///', 'Customer'), 'Customer');
eq('path segment: Windows reserved name is made safe', ae.safeSegment('CON'), 'CON_');
check('path segment: traversal cannot survive', !ae.safeSegment('../../etc/passwd').includes('/') && !ae.safeSegment('../../etc/passwd').startsWith('.'));
check('file name: long name keeps its extension', ae.safeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf') && ae.safeFileName('x'.repeat(300) + '.pdf').length <= 120);
eq('file name: a client-style path is cut to the name', ae.safeFileName('C:\\Users\\me\\Invoice 1.pdf'), 'Invoice 1.pdf');

const used = new Set<string>();
eq('first file keeps its name', ae.uniqueZipPath(['Customers', 'Pat Lee', 'Invoice'], 'a.pdf', used), 'Customers/Pat Lee/Invoice/a.pdf');
eq('same folder, same name: (2)', ae.uniqueZipPath(['Customers', 'Pat Lee', 'Invoice'], 'a.pdf', used), 'Customers/Pat Lee/Invoice/a (2).pdf');
eq('same name, different case, counts as the same file', ae.uniqueZipPath(['Customers', 'Pat Lee', 'Invoice'], 'A.PDF', used), 'Customers/Pat Lee/Invoice/A (3).PDF');
eq('another folder is fine', ae.uniqueZipPath(['Customers', 'Sam Roe', 'Invoice'], 'a.pdf', used), 'Customers/Sam Roe/Invoice/a.pdf');

const base = { type: 'invoice', typeLabel: 'Invoice' };
eq('customer paper goes under the customer and the type', ae.folderPathFor({ ...base, customerName: 'Pat Lee', companyFolder: null }, { canHr: true }), ['Customers', 'Pat Lee', 'Invoice']);
eq('company paper goes under Company Files', ae.folderPathFor({ ...base, companyFolder: 'money-in-out' }, { canHr: true })?.[0], 'Company Files');
eq('no customer, no folder: Other files', ae.folderPathFor({ ...base, customerName: null, companyFolder: null }, { canHr: true }), ['Other files', 'Invoice']);
eq('People and HR is included for someone with HR access', ae.folderPathFor({ ...base, companyFolder: 'people-hr' }, { canHr: true }), ['Company Files', 'People and HR']);
eq('People and HR is never exported without HR access', ae.folderPathFor({ ...base, companyFolder: 'people-hr' }, { canHr: false }), null);

const ents = (n: number, size: number | null) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, sizeBytes: size }));
eq('chunking: stops at the file limit', ae.planChunk(ents(10, 1), { maxBytes: 1e9, maxFiles: 4 }).take.length, 4);
eq('chunking: stops at the size limit', ae.planChunk(ents(10, 30), { maxBytes: 100, maxFiles: 400 }).take.length, 3);
eq('chunking: the rest is what is left', ae.planChunk(ents(10, 30), { maxBytes: 100, maxFiles: 400 }).rest.length, 7);
eq('chunking: one huge file still makes a part of its own (the job always moves on)', ae.planChunk(ents(3, 500), { maxBytes: 100, maxFiles: 400 }).take.length, 1);
eq('chunking: a file with no recorded size is planned at 2 MB', ae.planChunk(ents(100, null), { maxBytes: 10 * 1024 * 1024, maxFiles: 400 }).take.length, 5);
let left = ents(1000, 1_000_000); let parts = 0; let seen = 0;
while (left.length) { const p = ae.planChunk(left); seen += p.take.length; left = p.rest; parts++; }
check('chunking: 1,000 files of 1 MB are all placed exactly once, in 10 parts', seen === 1000 && parts === 10, `seen ${seen}, parts ${parts}`);
eq('estimate: 0 files is 0 parts', ae.estimateParts(0, 0), 0);
eq('estimate: counts by files and by size, whichever is more', [ae.estimateParts(401, 1), ae.estimateParts(10, 250 * 1024 * 1024)], [2, 3]);

const mcsv = ae.manifestCsv([ae.manifestRow({ id: 'x', filename: 'a, "b".pdf', typeLabel: 'Invoice', customerName: 'Pat Lee', customerNumber: 'C-1', createdAt: '2026-09-01T00:00:00Z', sizeBytes: 10, sha256: 'abc' }, { path: 'Customers/Pat Lee/Invoice/a.pdf', part: 'deepwell-files-part-001.zip', status: 'included' })]);
check('manifest: header lists every column', mcsv.replace('\uFEFF', '').split('\r\n')[0] === ae.MANIFEST_COLUMNS.join(','));
check('manifest: type, customer, date and quoting are right', mcsv.includes('"a, ""b"".pdf",Invoice,C-1,Pat Lee') && mcsv.includes('2026-09-01T00:00:00.000Z'));
eq('part file names are numbered', [ae.partFileName(1), ae.partFileName(12)], ['deepwell-files-part-001.zip', 'deepwell-files-part-012.zip']);

const TEN = '11111111-1111-4111-8111-111111111111';
const JOB = 'a'.repeat(32);
check('keys: every key is under the tenant prefix', Object.values({ ...ae.jobKeys(TEN, JOB), part: ae.jobKeys(TEN, JOB).part(3), manifest: ae.jobKeys(TEN, JOB).manifest(1) }).every((k: any) => k.startsWith(`${TEN}/exports/`)));
check('keys: a job id from a request cannot reach outside (traversal / wrong length refused)', ['../x', 'a'.repeat(31), 'A'.repeat(32), `${JOB}/..`, 7, null].every((v) => !ae.isJobId(v)) && ae.isJobId(JOB));
let bad = false; try { ae.jobKeys('../other', JOB); } catch { bad = true; }
check('keys: a tenant id that is not a uuid is refused', bad);

const st = { jobId: JOB, tenantId: TEN, createdBy: 'u', status: 'done', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z', parts: [{ n: 1, name: 'p', files: 2, bytes: 3 }], canHr: true, indexReady: true, totalFiles: 2 };
const pub = JSON.stringify(ae.publicJob(st, Date.parse('2026-10-02T00:00:00Z')));
check('public job: no tenant id, user id or storage key', !pub.includes(TEN) && !pub.includes('"u"') && !/storage|exports\//.test(pub));
eq('public job: shows expired after the keep-for date', ae.publicJob(st, Date.parse('2026-10-09T00:00:00Z')).status, 'expired');
eq('public job: a running job that has not moved is "stuck"', ae.publicJob({ ...st, status: 'running', updatedAt: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-01T01:00:00Z')).status, 'stuck');
eq('state machine: files -> index -> none', [ae.nextAction({ status: 'running', phase: 'files' }), ae.nextAction({ status: 'running', phase: 'index' }), ae.nextAction({ status: 'done', phase: 'done' }), ae.nextAction({ status: 'failed' })], ['files', 'index', 'none', 'none']);
eq('keep-for window is seven days', ae.EXPORT_TTL_DAYS, 7);
eq('links last one hour', ae.LINK_TTL_SECONDS, 3600);

// admin gate (pure)
const gate = (a: any) => { try { ae.assertAdmin(a); return 'ok'; } catch (e: any) { return e.status; } };
eq('admin gate: shop admin ok, shop member 403, no auth 403, solo tenant ok', [gate({ orgId: 'o', orgRole: 'admin' }), gate({ orgId: 'o', orgRole: 'member' }), gate(null), gate({ userId: 'u' })], ['ok', 403, 403, 'ok']);

// wording
const notice = ae.readyNotice({ parts: 3, files: 1200, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
eq('bell notice', notice, { title: 'Your files are ready to download', body: '1,200 files are packed into 3 zip files. Open Team and Settings to download them. They stay available for 7 days.', link: '/app/?screen=team' });
const readme = ae.readmeText({ company: 'Desert Peak HVAC', files: 10, parts: 2, included: 9, missing: 1, createdAt: '2026-10-01', expiresAt: '2026-10-08' });
check('readme: explains how to put the parts together and names the 3 folders', /same folder/i.test(readme) && readme.includes('Customers/') && readme.includes('Company Files/') && readme.includes('Other files/'));
check('readme: reports files that could not be included', readme.includes('1 file is listed'));

/* ============================================================ 2. wiring */
const account = read('api/account.js');
const route = read('api/_lib/routes/account-export.js');
const queue = read('api/_lib/queue.js');
const client = read('src/services/exportClient.ts');
const team = read('src/screens/TeamScreen.tsx');
const pkg = JSON.parse(read('package.json'));
check('wiring: routed through the existing /api/account endpoint', /"export-files": accountExport/.test(account));
const top = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
eq('api/ still has exactly 12 top-level files', top.length, 12);
check('route: admin gate before any work, tenant from the token', /assertAdmin\(auth\)/.test(route) && /tenantKey: auth\.tenantId/.test(route) && !/body\.tenant/.test(route));
check('route: every op answers uncached', /no-store/.test(route));
check('queue: the job is not billing-gated (a cancelled customer still gets their files)', !/assertActiveBilling[^]*account-export/.test(queue.slice(queue.indexOf('const accountExport'))) );
check('queue: one job per tenant at a time, files removed after the keep-for window', /key: "event\.data\.tenantKey", limit: 1/.test(queue) && /removeIfExpired/.test(queue));
check('client: starts, polls and asks for fresh links', /export-files/.test(client) && /op: 'link'/.test(client));
check('screen: the button sits under Your data next to the CSV buttons', team.includes('AccountFilesExport') && team.indexOf('<DataExportButtons />') > 0);
check('package.json: script and verify:all entry', pkg.scripts['verify:account-export'] && pkg.scripts['verify:all'].includes('verify:account-export'));

/* ============================================================ 3. the engine, against Postgres */
let PGlite: any;
const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const m of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[m] = ((await import(`@electric-sql/pglite/contrib/${m}`)) as any)[m];
} catch (err) {
  console.log(`  SKIP database-backed checks: PGlite is not installed (${(err as Error)?.message})`);
}
if (PGlite) {
  process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
  delete process.env.ANTHROPIC_API_KEY;
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as verify-company-files */ }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run once resolve_tenant() exists */ }
  const pgMod = ((await import('pg')) as any).default;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql: string, params: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql: string, params: unknown[]) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const JSZip = (await import('jszip')).default;

  // An in-memory bucket with the same surface as the real storage.
  const bucket = new Map<string, Buffer>();
  const gets: string[] = [];
  const storage = {
    async get(key: string) { gets.push(key); const b = bucket.get(key); if (!b) throw Object.assign(new Error('nope'), { status: 404 }); return b; },
    async put(key: string, body: Buffer | string) { bucket.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)); },
    async del(key: string) { bucket.delete(key); },
    link(key: string, filename: string, ttl: number) { return `https://r2.example/${key}?name=${encodeURIComponent(filename)}&expires=${ttl}`; },
  };

  const KA = 'org_ex_a'; const KB = 'org_ex_b'; const KC = 'org_ex_c';
  const ctxOf = (k: string) => ({ tenantKey: k, tenantName: k });
  const tenA = (await getTenantContext(KA, KA)).id;
  const tenB = (await getTenantContext(KB, KB)).id;
  const tenC = (await getTenantContext(KC, KC)).id;
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Desert Peak HVAC', tenA]);
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Rival Shop', tenB]);

  const hex = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let seq = 0;
  const addDoc = async (ten: string, n: number, type: string, fields: Record<string, string>, o: { file?: string; created?: string; size?: number | null; bytes?: string | null; key?: string | null } = {}) => {
    const sha = `${ten.slice(0, 4)}${String(n).padStart(8, '0')}`.padEnd(64, 'f');
    const key = o.key === undefined ? `${ten}/${sha.slice(0, 2)}/${sha}` : o.key;
    await lite.query(
      `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, file_size_bytes, storage_key, content_type) VALUES ($1,$2,$3,$4,$5,'read',$6,$7,$8,'application/pdf')`,
      [hex(n + (ten === tenA ? 0 : ten === tenB ? 10000 : 20000)), ten, o.file ?? `file-${n}.pdf`, type, sha, o.created ?? `2026-09-${String(1 + (seq++ % 27)).padStart(2, '0')}T00:00:00Z`, o.size ?? 100, key]
    );
    if (key && o.bytes !== null) bucket.set(key, Buffer.from(o.bytes ?? `bytes of ${o.file ?? n}`));
    for (const [k, v] of Object.entries(fields)) await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.95)', [ten, hex(n + (ten === tenA ? 0 : ten === tenB ? 10000 : 20000)), k, v]);
  };
  // A customer with a linked invoice
  const cust = (await lite.query(`INSERT INTO entities (tenant_id, entity_type, data) VALUES ($1,'customer','{"customer_name":"Pat Lee"}') RETURNING id`, [tenA])).rows[0].id;
  await addDoc(tenA, 1, 'invoice', { customer_name: 'Pat Lee', cost: '10' }, { file: 'Invoice 1.pdf' });
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenA, hex(1), cust]);
  await addDoc(tenA, 2, 'invoice', { customer_name: 'Pat Lee', cost: '20' }, { file: 'Invoice 1.pdf' }); // same name, same customer: needs "(2)"
  await addDoc(tenA, 3, 'receipt', { vendor: 'Desert Supply', cost: '48' }, { file: 'Receipt.pdf' });
  await addDoc(tenA, 4, 'hr-letter', { customer_name: 'J Smith' }, { file: 'Offer Letter.pdf' });
  await addDoc(tenA, 5, 'work-order', { service_address: '1 Elm St' }, { file: 'WO 5.pdf' });
  await addDoc(tenA, 6, 'invoice', { customer_name: 'Pat Lee' }, { file: 'Gone.pdf', bytes: null }); // row says a file exists, storage does not have it
  await addDoc(tenA, 7, 'invoice', { customer_name: 'Pat Lee' }, { file: 'Stolen.pdf', key: `${tenB}/zz/${'e'.repeat(62)}`, bytes: null }); // a key under ANOTHER tenant
  await addDoc(tenA, 8, 'invoice', { customer_name: 'Pat Lee' }, { file: 'No file at all.pdf', key: null });
  bucket.set(`${tenB}/zz/${'e'.repeat(62)}`, Buffer.from('B SECRET'));
  await addDoc(tenB, 1, 'invoice', { customer_name: 'Rival Person' }, { file: 'Rival invoice.pdf' });
  await addDoc(tenB, 2, 'hr-letter', {}, { file: 'Rival HR.pdf' });

  const adminA = { userId: 'admin_a', tenantId: KA, orgId: KA, orgRole: 'admin' };
  const memberA = { userId: 'member_a', tenantId: KA, orgId: KA, orgRole: 'member' };
  const adminB = { userId: 'admin_b', tenantId: KB, orgId: KB, orgRole: 'admin' };

  // ---- admin gate
  await throwsStatus('a member cannot start an export', 403, () => ae.startExport(ctxOf(KA), memberA, { storage }));

  // ---- tenant A: whole run
  const started = await ae.startExport(ctxOf(KA), adminA, { storage });
  eq('start: the count is the files that have a stored original (7 of 8; the row with no file is not counted)', started.state.totalFiles, 7);
  check('start: HR papers are included for the admin', started.state.canHr === true);
  const again = await ae.startExport(ctxOf(KA), adminA, { storage });
  check('start twice: the running job is returned, not a second one', again.reused && again.state.jobId === started.state.jobId);

  const jobId = started.state.jobId;
  await throwsStatus('link before it is ready: not ready', 409, () => ae.downloadLink(ctxOf(KA), adminA, jobId, 1, { storage }));
  let steps = 0; let last: any;
  for (; steps < 20; steps++) { const r = await ae.runExportStep(ctxOf(KA), jobId, { storage }); last = r; if (r.job.status === 'done') break; }
  eq('run: finishes (one part step plus the index step)', [last.job.status, steps], ['done', 2]);
  eq('run: no stolen or missing file is counted as included', [last.job.includedFiles, last.job.skippedFiles], [5, 2]);

  const keysA = ae.jobKeys(tenA, jobId);
  const part1 = await JSZip.loadAsync(bucket.get(keysA.part(1))!);
  const names = Object.keys(part1.files).filter((n) => !part1.files[n].dir).sort();
  check('part 1: customer paper is under Customers/<name>/<type>', names.includes('Customers/Pat Lee/Invoice/Invoice 1.pdf'));
  check('part 1: the second file with the same name gets "(2)"', names.includes('Customers/Pat Lee/Invoice/Invoice 1 (2).pdf'));
  check('part 1: company paper is under Company Files', names.some((n) => n.startsWith('Company Files/') && n.endsWith('Receipt.pdf')));
  check('part 1: the HR letter is included for the admin, in People and HR', names.includes('Company Files/People and HR/Offer Letter.pdf'));
  check('part 1: a paper with no customer goes to Other files', names.some((n) => n.startsWith('Other files/') && n.endsWith('WO 5.pdf')));
  check('part 1: the original bytes are unchanged', (await part1.file('Customers/Pat Lee/Invoice/Invoice 1.pdf')!.async('string')) === 'bytes of Invoice 1.pdf');
  check('scoping: nothing of tenant B is in the zip and its object was never read', !names.some((n) => /Stolen|Rival/.test(n)) && !gets.some((k) => k.startsWith(`${tenB}/`)));

  const idx = await JSZip.loadAsync(bucket.get(keysA.index)!);
  eq('index: README, manifest and the three spreadsheets', Object.keys(idx.files).sort(), ['README.txt', 'customers.csv', 'documents.csv', 'manifest.csv', 'units.csv']);
  const manifest = (await idx.file('manifest.csv')!.async('string')).replace('\uFEFF', '').trim().split('\r\n');
  eq('manifest: header', manifest[0], ae.MANIFEST_COLUMNS.join(','));
  eq('manifest: one row per file that has a stored original', manifest.length - 1, 7);
  check('manifest: included files name their path and part', manifest.some((l) => l.startsWith('Customers/Pat Lee/Invoice/Invoice 1.pdf,deepwell-files-part-001.zip,')));
  check('manifest: a missing file is listed as missing', manifest.some((l) => l.includes('Gone.pdf') && l.endsWith(',missing')));
  check('manifest: another company\'s file is listed as not exportable, not read', manifest.some((l) => l.includes('Stolen.pdf') && l.endsWith(',not-exportable')));
  check('manifest: no row from another tenant', !manifest.some((l) => /Rival/.test(l)));
  check('CSV: the documents spreadsheet is in the zip', (await idx.file('documents.csv')!.async('string')).includes('Invoice 1.pdf'));
  check('CSV: the other company\'s documents are not in it', !(await idx.file('documents.csv')!.async('string')).includes('Rival'));

  // ---- notification + audit
  const notes = (await lite.query(`SELECT kind, title, link FROM notifications WHERE tenant_id = $1`, [tenA])).rows;
  eq('bell: exactly one notice, to this company', notes.map((n: any) => [n.kind, n.title, n.link]), [['export', 'Your files are ready to download', '/app/?screen=team']]);
  eq('bell: nothing for the other company', (await lite.query(`SELECT 1 FROM notifications WHERE tenant_id = $1`, [tenB])).rows.length, 0);
  const acts = (await lite.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'account.files_export.%' ORDER BY created_at`, [tenA])).rows.map((r: any) => r.action);
  eq('audit: requested and completed are logged', acts, ['account.files_export.requested', 'account.files_export.completed']);

  // ---- links
  await throwsStatus('a member cannot get a link', 403, () => ae.downloadLink(ctxOf(KA), memberA, jobId, 1, { storage }));
  const link = await ae.downloadLink(ctxOf(KA), adminA, jobId, 1, { storage });
  check('link: expires in an hour, points at this company\'s part', link.expiresInSeconds === 3600 && link.url.includes(`/${tenA}/exports/${jobId}/deepwell-files-part-001.zip`) && link.url.includes('expires=3600'));
  check('link: the index has one too', (await ae.downloadLink(ctxOf(KA), adminA, jobId, 'index', { storage })).name === ae.INDEX_FILE_NAME);
  await throwsStatus('link: a part that does not exist', 404, () => ae.downloadLink(ctxOf(KA), adminA, jobId, 99, { storage }));
  check('audit: each link issued is logged', (await lite.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'account.files_export.link'`, [tenA])).rows.length === 2);

  // ---- another company
  await throwsStatus('another company cannot see this job', 404, () => ae.jobStatus(ctxOf(KB), jobId, { storage }));
  await throwsStatus('another company cannot get a link to it', 404, () => ae.downloadLink(ctxOf(KB), adminB, jobId, 1, { storage }));
  await throwsStatus('another company cannot run it', 404, () => ae.runExportStep(ctxOf(KB), jobId, { storage }));
  bucket.set(ae.jobKeys(tenB, jobId).state, bucket.get(keysA.state)!); // a copy of A's state planted under B's prefix
  await throwsStatus('a state file carrying another company\'s id is never honoured', 404, () => ae.jobStatus(ctxOf(KB), jobId, { storage }));
  bucket.delete(ae.jobKeys(tenB, jobId).state);
  const bStart = await ae.startExport(ctxOf(KB), adminB, { storage });
  check('company B starts its own job: 2 files, its own prefix', bStart.state.totalFiles === 2 && bStart.state.tenantId === tenB && bStart.state.jobId !== jobId);
  check('company B: still no job of A\'s as "latest"', (await ae.jobStatus(ctxOf(KB), null, { storage })).jobId === bStart.state.jobId);

  // ---- People and HR is left out when the job has no HR access
  const noHrId = 'b'.repeat(32);
  const stateNoHr = { ...started.state, jobId: noHrId, status: 'queued', phase: 'files', cursor: null, parts: [], manifestParts: 0, filesDone: 0, includedFiles: 0, skippedFiles: 0, indexReady: false, canHr: false };
  bucket.set(ae.jobKeys(tenA, noHrId).state, Buffer.from(JSON.stringify(stateNoHr)));
  for (let i = 0; i < 5; i++) { const r = await ae.runExportStep(ctxOf(KA), noHrId, { storage, notify: false }); if (r.job.status === 'done') break; }
  const noHrZip = await JSZip.loadAsync(bucket.get(ae.jobKeys(tenA, noHrId).part(1))!);
  check('without HR access: no People and HR paper in the zip', !Object.keys(noHrZip.files).some((n) => /People and HR|Offer Letter/.test(n)));
  const noHrManifest = (await (await JSZip.loadAsync(bucket.get(ae.jobKeys(tenA, noHrId).index)!)).file('manifest.csv')!.async('string'));
  check('without HR access: not in the manifest either', !noHrManifest.includes('Offer Letter'));
  eq('without HR access: the count leaves HR out', (await ae.countExportable(ctxOf(KA), { canHr: false })).files, 6);

  // ---- chunking by size: 24 MB declared each -> 4 per 100 MB part
  for (let i = 0; i < 9; i++) await addDoc(tenC, i + 1, 'invoice', { customer_name: `Cust ${i % 3}` }, { file: `Big ${i + 1}.pdf`, size: 24 * 1024 * 1024, created: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
  const cAuth = { userId: 'admin_c', tenantId: KC, orgId: KC, orgRole: 'admin' };
  const cj = (await ae.startExport(ctxOf(KC), cAuth, { storage })).state;
  let r: any;
  for (let i = 0; i < 30; i++) { r = await ae.runExportStep(ctxOf(KC), cj.jobId, { storage, notify: false }); if (r.job.status === 'done') break; }
  eq('chunking (size): 9 files of 24 MB make 3 parts of 4, 4 and 1', r.job.parts.map((p: any) => p.files), [4, 4, 1]);
  const everyName: string[] = [];
  for (const p of r.job.parts) everyName.push(...Object.keys((await JSZip.loadAsync(bucket.get(ae.jobKeys(tenC, cj.jobId).part(p.n))!)).files).filter((n) => !n.endsWith('/')));
  check('chunking (size): every file is in exactly one part', everyName.length === 9 && new Set(everyName).size === 9);

  // ---- chunking by count, and name de-duplication across parts
  for (let i = 0; i < 405; i++) await addDoc(tenC, 100 + i, 'receipt', { vendor: 'Desert Supply' }, { file: 'Receipt.pdf', size: 10, created: `2026-07-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, bytes: 'x' });
  const cj2 = (await ae.startExport(ctxOf(KC), cAuth, { storage, now: Date.now() + 3600_000 })).state;
  for (let i = 0; i < 30; i++) { r = await ae.runExportStep(ctxOf(KC), cj2.jobId, { storage, notify: false }); if (r.job.status === 'done') break; }
  check('chunking (count): 414 files split across parts, no part over 400 files', r.job.parts.length >= 2 && r.job.parts.every((p: any) => p.files <= 400) && r.job.parts.reduce((s: number, p: any) => s + p.files, 0) === 414, JSON.stringify(r.job.parts.map((p: any) => p.files)));
  const all2: string[] = [];
  for (const p of r.job.parts) all2.push(...Object.keys((await JSZip.loadAsync(bucket.get(ae.jobKeys(tenC, cj2.jobId).part(p.n))!)).files).filter((n) => !n.endsWith('/')));
  check('names stay unique across parts (405 files called Receipt.pdf)', new Set(all2.map((n) => n.toLowerCase())).size === 414);
  const m2 = (await (await JSZip.loadAsync(bucket.get(ae.jobKeys(tenC, cj2.jobId).index)!)).file('manifest.csv')!.async('string')).trim().split('\r\n');
  eq('manifest: one row per file across all parts', m2.length - 1, 414);

  // ---- a crash between steps: the same step run twice does not duplicate anything
  const redoId = (await ae.startExport(ctxOf(KA), adminA, { storage, now: Date.now() + 2 * 3600_000 })).state.jobId;
  await ae.runExportStep(ctxOf(KA), redoId, { storage, notify: false });
  const stRaw = JSON.parse(bucket.get(ae.jobKeys(tenA, redoId).state)!.toString());
  stRaw.cursor = null; stRaw.parts = []; stRaw.manifestParts = 0; stRaw.filesDone = 0; stRaw.includedFiles = 0; stRaw.skippedFiles = 0; // as if the state write had been lost
  bucket.set(ae.jobKeys(tenA, redoId).state, Buffer.from(JSON.stringify(stRaw)));
  bucket.delete(ae.jobKeys(tenA, redoId).paths);
  for (let i = 0; i < 5; i++) { const x = await ae.runExportStep(ctxOf(KA), redoId, { storage, notify: false }); if (x.job.status === 'done') break; }
  check('re-running a lost step rewrites the same part (still one part, 5 files)', (await ae.jobStatus(ctxOf(KA), redoId, { storage })).parts.length === 1 && (await ae.jobStatus(ctxOf(KA), redoId, { storage })).includedFiles === 5);

  // ---- expiry
  const future = Date.now() + 8 * 86_400_000;
  await throwsStatus('an expired job gives no link', 410, () => ae.downloadLink(ctxOf(KA), adminA, jobId, 1, { storage, now: future }));
  check('an expired job is deleted from storage', ![...bucket.keys()].some((k) => k.startsWith(`${tenA}/exports/${jobId}/`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
