// npm run verify:google-picker
// DEFAULT "picker" mode of Google Drive import (only the drive.file permission), against a PRETEND Google that behaves the way
// drive.file is documented to behave (only picked files are visible; a picked folder is the folder itself, not its contents) and a
// real Postgres (PGlite from M3-config/*.sql, queried as the app's NOBYPASSRLS role). No real Google call is possible here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
console.log('verify:google-picker');

globalThis.fetch = (async () => { throw new Error('real network call attempted in a test'); }) as any;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEEPWELL_GOOGLE_SYNC;
delete process.env.DEEPWELL_GOOGLE_SCOPE_MODE; // the DEFAULT is what is under test
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.test';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-xyz';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.test/api/google-sync/callback';
process.env.GOOGLE_PICKER_API_KEY = 'picker-key';
process.env.GOOGLE_CLOUD_PROJECT_NUMBER = '123456';

const cfg: any = await import('../api/_lib/googleSync/config.js');
const cr: any = await import('../api/_lib/googleSync/crypto.js');
const gapi: any = await import('../api/_lib/googleSync/googleApi.js');
// @ts-expect-error plain JS fixture
const { FakeGoogle } = await import('./lib/fakeGoogle.mjs');

/** drive.file as Google documents it: an app sees ONLY the files the user picked (granted). A picked folder is the folder itself:
 *  listing it returns only files that were themselves picked. Anything else answers 404. */
class ScopedGoogle extends FakeGoogle {
  granted = new Set<string>();
  grant(...ids: string[]) { ids.forEach((i) => this.granted.add(i)); }
  async drive(u: URL) {
    const p = u.pathname.slice('/drive/v3/'.length);
    const m = /^files\/([^/]+)/.exec(p);
    const no = () => new Response(JSON.stringify({ error: { message: 'File not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (m && !this.granted.has(decodeURIComponent(m[1]))) return no();
    if (p === 'files') { // a listing only ever shows files that were themselves picked
      const j: any = await super.drive(u).json();
      const files = (j.files ?? []).filter((f: any) => this.granted.has(f.id));
      return new Response(JSON.stringify({ ...j, files }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return super.drive(u);
  }
}

/* ============================================================ 1. pure: default mode and scopes */
eq('default mode (nothing set) is picker', cfg.scopeMode({}), 'picker');
eq('"picker" is picker', cfg.scopeMode({ DEEPWELL_GOOGLE_SCOPE_MODE: 'picker' }), 'picker');
eq('only the word "full" turns full mode on', [cfg.scopeMode({ DEEPWELL_GOOGLE_SCOPE_MODE: 'full' }), cfg.scopeMode({ DEEPWELL_GOOGLE_SCOPE_MODE: 'FULL ' }), cfg.scopeMode({ DEEPWELL_GOOGLE_SCOPE_MODE: 'yes' }), cfg.scopeMode({ DEEPWELL_GOOGLE_SCOPE_MODE: '1' })], ['full', 'full', 'picker', 'picker']);
eq('picker mode offers Drive only; full mode offers Drive and Gmail', [cfg.providersFor({}), cfg.providersFor({ DEEPWELL_GOOGLE_SCOPE_MODE: 'full' })], [['drive'], ['drive', 'gmail']]);
eq('flag is OFF when unset', cfg.isGoogleSyncEnabled({}), false);
const L = cfg.limits({});
check('default caps: initial import 500, monthly 2000, 500 picked files', L.initialImportCap === 500 && L.maxFilesPerMonth === 2000 && L.maxPickedFiles === 500);
check('caps are configurable and bounded', cfg.limits({ GOOGLE_SYNC_INITIAL_CAP: '120', GOOGLE_SYNC_MONTHLY_CAP: '900' }).initialImportCap === 120 && cfg.limits({ GOOGLE_SYNC_MONTHLY_CAP: '900' }).maxFilesPerMonth === 900 && cfg.limits({ GOOGLE_SYNC_INITIAL_CAP: '999999' }).initialImportCap === 500);
const banned = /token|scope|oauth|\bapi\b|sha|checksum|inngest|restricted|verification|encrypt|credential/i;
check('customer wording has no technical or security-internal terms', Object.values(cfg.WORDING).every((s) => !banned.test(String(s))), Object.values(cfg.WORDING).find((s) => banned.test(String(s))) as string);
const gcss = read('src/services/googleSyncClient.ts');
const card = read('src/components/ConnectedSourcesCard.tsx');
check('Google window: folders can be opened but not selected; origin set; only supported types offered', /setSelectFolderEnabled\(false\)/.test(gcss) && /setOrigin\(/.test(gcss) && /PICKER_MIME_TYPES/.test(gcss) && /application\/pdf/.test(gcss));
check('Settings card: the honest folder sentence is on screen in picker mode', card.includes(cfg.WORDING.pickerFolderNote) && card.includes(cfg.WORDING.pickerFoldersNotTaken) && /status\.scopeMode !== 'picker' && <SourceBlock provider="gmail"/.test(card));
const vj = JSON.parse(read('vercel.json'));
const csp = vj.headers.find((h: any) => h.source === '/(.*)').headers.find((h: any) => h.key === 'Content-Security-Policy').value;
const cd = (n: string) => csp.split(';').map((x: string) => x.trim()).find((x: string) => x.startsWith(n + ' ')) ?? '';
check('page security policy lets Google\'s file window load (script, frame) and nothing broader', cd('script-src').includes('https://apis.google.com') && cd('frame-src').includes('https://docs.google.com') && !/\*\.google\.com|\bhttps:\s|\bhttps:;/.test(csp.replace(/img-src[^;]*/, '')));
check('api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
const srcFiles = fs.readdirSync(path.join(ROOT, 'api/_lib/googleSync')).map((f) => ({ f, s: read(`api/_lib/googleSync/${f}`) }));
check('only googleApi.js and importer.js make network requests', srcFiles.filter((x) => /\bfetch\(|fetchImpl\(/.test(x.s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))).map((x) => x.f).sort().join() === 'googleApi.js,importer.js');

/* ============================================================ 5. database-backed behaviour */
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
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (e) { if (f.startsWith('71')) console.log('  (71 failed:', (e as Error).message, ')'); }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after resolve_tenant() exists */ }
  await lite.exec(fs.readFileSync(path.join(cfgDir, '71-google-sync.sql'), 'utf8')); // again, now that the app role exists (grants)
  const pgMod = ((await import('pg')) as any).default;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (s: string, params: unknown[]) => lite.query(s, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(s: string, params: unknown[]) {
    const release = await lock();
    try { return await lite.query(s, params); } finally { release(); }
  };
  const q = async (s: string, p: unknown[] = []) => (await lite.query(s, p)).rows as any[];

  const { getTenantContext, withTenant } = await import('../api/_lib/recordsStore.js') as any;
  const { hrGateSql } = await import('../api/_lib/companyFilesStore.js') as any;
  const route: any = await import('../api/_lib/googleSync/route.js');
  const sync: any = await import('../api/_lib/googleSync/sync.js');
  const S: any = await import('../api/_lib/googleSync/store.js');
  const { UploadGateRefusal } = await import('../api/upload-url.js') as any;
  const accountHandler: any = (await import('../api/account.js')).default;

  const KA = 'org_gs_a';
  const KB = 'org_gs_b';
  const tenA = (await getTenantContext(KA, KA)).id;
  const tenB = (await getTenantContext(KB, KB)).id;
  const adminA = { userId: 'admin_a', tenantId: KA, orgId: KA, orgRole: 'admin', email: 'owner@example.com' };
  const memberA = { userId: 'member_a', tenantId: KA, orgId: KA, orgRole: 'member' };
  const adminB = { userId: 'admin_b', tenantId: KB, orgId: KB, orgRole: 'admin' };
  const soloC = { userId: 'solo_c', tenantId: 'user_solo_c', orgId: null, orgRole: null };
  const ctxA = { tenantKey: KA, tenantName: KA };
  const ctxB = { tenantKey: KB, tenantName: KB };

  // ---- shared test doubles
  const R2: Map<string, Buffer> = new Map();
  const enqueued: string[] = [];
  let putFailures = 0;
  let enqueueThrows = false;
  const importDeps = (over: Record<string, unknown> = {}) => ({
    putObject: async (key: string, bytes: Buffer) => { if (putFailures > 0) { putFailures--; throw new Error('r2 down'); } R2.set(key, bytes); },
    loadBillingRow: async () => undefined,
    assertRoom: async () => {},
    enqueue: async (_c: unknown, id: string) => { if (enqueueThrows) throw new Error('queue down'); enqueued.push(id); return 'queued'; },
    ...over,
  });
  let fake = new ScopedGoogle();
  const sleeps: number[] = [];
  const mkClient = () => gapi.createGoogleClient({ env: process.env, fetchImpl: fake.fetch, sleep: async (ms: number) => { sleeps.push(ms); }, rand: () => 0.5 });
  let client = mkClient();
  const D = (over: Record<string, unknown> = {}) => ({ google: client, importDeps: importDeps(), assertBilling: async () => ({ allowed: true }), ...over });
  const fresh = () => { fake = new ScopedGoogle(); client = mkClient(); sleeps.length = 0; };
  const mkRes = () => { const r: any = { statusCode: 0, body: null, headers: {}, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader(k: string, v: string) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

  async function connect(auth: any, provider: 'drive' | 'gmail', mode = 'narrow', token = 'rt-A') {
    const s = await route.handleOp(auth, { op: 'start', provider, scopeMode: mode }, { google: client });
    const state = new URL(s.body.url).searchParams.get('state');
    fake.grantScope = cfg.scopesFor(provider, mode).join(' ');
    fake.validRefresh.add(token);
    return route.handleCallback({ code: 'good-code', state }, { google: client });
  }
  const choose = (auth: any, body: Record<string, unknown>) => route.handleOp(auth, { op: 'choices', ...body }, { google: client });
  const docsOf = (tenant: string) => q('SELECT * FROM documents WHERE tenant_id = $1 ORDER BY created_at, original_filename', [tenant]);
  const itemsOf = (tenant: string, provider?: string) => q(`SELECT i.* FROM google_sync_items i JOIN google_connections c ON c.id = i.connection_id WHERE i.tenant_id = $1 ${provider ? `AND c.provider = '${provider}'` : ''} ORDER BY i.external_id`, [tenant]);
  const connOf = async (tenant: string, provider: string) => (await q('SELECT * FROM google_connections WHERE tenant_id = $1 AND provider = $2', [tenant, provider]))[0];
  const status = async (auth: any) => (await route.handleOp(auth, { op: 'status' }, { google: client })).body;
  const pick = (...ids: string[]) => ids.map((id) => ({ id, name: `name-${id}`, kind: 'file' as const }));
  const setup = async (auth: any, ten: string) => { fresh(); fake.validRefresh.add('rt-A'); await connect(auth, 'drive'); fake.validRefresh.add('rt-A'); return ten; };
  const audit = (tenant: string, resourceId: string) => q(`SELECT changes FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action = 'document.synced_from_google'`, [tenant, resourceId]);
  fake = new ScopedGoogle(); client = mkClient();
  const flagOff = await route.handleOp(adminA, { op: 'status' }, { google: client });
  eq('OFF by default: status says enabled:false and nothing is offered', flagOff.body, { enabled: false });
  process.env.DEEPWELL_GOOGLE_SYNC = '1';

  /* ---------------- 1. picker mode asks Google for drive.file ONLY */
  let r: any = await route.handleOp(adminA, { op: 'start', provider: 'drive' }, { google: client });
  const scopes = new URL(r.body.url).searchParams.get('scope')!.split(' ').sort();
  eq('picker mode requests exactly: openid, email, drive.file', scopes, ['email', 'https://www.googleapis.com/auth/drive.file', 'openid']);
  r = await route.handleOp(adminA, { op: 'start', provider: 'drive', scopeMode: 'full' }, { google: client });
  eq('picker mode ignores a browser asking for full access (still drive.file only)', new URL(r.body.url).searchParams.get('scope')!.split(' ').sort(), ['email', 'https://www.googleapis.com/auth/drive.file', 'openid']);
  check('no restricted permission appears anywhere in the consent URL', !/readonly|gmail|drive\.metadata|\/auth\/drive(\s|&|$)/.test(decodeURIComponent(r.body.url)));
  r = await route.handleOp(adminA, { op: 'start', provider: 'gmail' }, { google: client });
  eq('picker mode: Gmail cannot be started (404)', r.status, 404);
  r = await route.handleOp(adminA, { op: 'labels' }, { google: client });
  eq('picker mode: Gmail label listing is not available (404)', r.status, 404);
  r = await route.handleOp(adminA, { op: 'folders' }, { google: client });
  eq('picker mode: whole-Drive folder browsing is not available (404)', r.status, 404);
  const sFull = await route.handleOp(adminA, { op: 'start', provider: 'drive', scopeMode: 'full' }, { google: client, env: { ...process.env, DEEPWELL_GOOGLE_SCOPE_MODE: 'full' } });
  check('full mode is still there behind DEEPWELL_GOOGLE_SCOPE_MODE=full (drive.readonly)', new URL(sFull.body.url).searchParams.get('scope')!.includes('drive.readonly'));
  const st0 = cr.signState({ t: KA, p: 'drive', m: 'full' });
  r = await route.handleCallback({ code: 'good-code', state: st0 }, { google: client });
  eq('a connection started in full mode is refused by picker mode at the callback', r.redirect, '/app/?screen=team&google=error');
  r = await connect(adminA, 'drive');
  eq('connect (picker mode) completes', r.redirect, '/app/?screen=team&google=connected');
  let row = await connOf(tenA, 'drive');
  check('token is stored encrypted, bound to its own company', cr.looksEncrypted(row.refresh_token_enc) && cr.decryptToken(row.refresh_token_enc, tenA) === 'rt-A' && row.scope_mode === 'narrow');
  let stat = await status(adminA);
  check('status: picker mode, Drive only, caps and counts shown, no token', stat.scopeMode === 'picker' && stat.providers.join() === 'drive' && stat.monthlyLimit === 2000 && stat.initialCap === 500 && stat.usedThisMonth === 0 && stat.pickedLimit === 500 && !JSON.stringify(stat).includes('rt-A'));
  r = await route.handleOp(adminA, { op: 'picker-token' }, { google: client });
  check('the Google window gets a short-lived access token plus the picker key and app id (never the refresh token)', r.status === 200 && /^at-/.test(r.body.accessToken) && r.body.apiKey === 'picker-key' && r.body.appId === '123456' && !JSON.stringify(r.body).includes('rt-A'));

  /* ---------------- 2. what drive.file gives for a picked FOLDER */
  const g: any = fake;
  g.addFolder('fold1', 'Customer files');
  g.addFile({ id: 'in1', name: 'Inside 1.pdf', parents: ['fold1'], content: 'inside one' });
  g.addFile({ id: 'in2', name: 'Inside 2.pdf', parents: ['fold1'], content: 'inside two' });
  g.grant('fold1'); // the user picked the FOLDER only
  const sess = client.session(await client.refreshAccessToken('rt-A'), () => client.refreshAccessToken('rt-A'));
  check('picking a folder gives the folder itself', (await sess.getFile('fold1')).id === 'fold1');
  eq('picking a folder does NOT list its contents', ((await sess.listChildren('fold1')).files ?? []).length, 0);
  let blocked = 0; try { await sess.getFile('in1'); } catch (e: any) { blocked = e.status; }
  eq('a file inside a picked folder cannot be opened unless it was picked too', blocked, 404);
  g.addFile({ id: 'in3', name: 'Added later.pdf', parents: ['fold1'], content: 'later' });
  blocked = 0; try { await sess.getFile('in3'); } catch (e: any) { blocked = e.status; }
  eq('a file added to the folder later is not visible either', blocked, 404);
  r = await choose(adminA, { provider: 'drive', picked: [{ id: 'fold1', name: 'Customer files', kind: 'folder' }] });
  check('so a folder choice is refused with the plain explanation (never silently empty)', r.status === 400 && r.body.error === cfg.WORDING.pickerFoldersNotTaken);
  eq('nothing was saved by the refused folder choice', (await connOf(tenA, 'drive')).config.picked ?? [], []);
  // a folder that was somehow stored: the pass runs, imports nothing, and says what to do
  await q(`UPDATE google_connections SET config = $2::jsonb WHERE tenant_id = $1 AND provider = 'drive'`, [tenA, JSON.stringify({ picked: [{ id: 'fold1', name: 'Customer files', kind: 'folder' }] })]);
  const lc0 = g.callsMatching(/files\?q=/);
  let out = await sync.syncConnection(ctxA, 'drive', D());
  check('a stored folder is never expanded: no import, a plain "choose the files" note, no Drive listing call', out.ok && out.tally.created === 0 && /Choose the files/.test(out.result) && g.callsMatching(/files\?q=/) === lc0);
  await choose(adminA, { provider: 'drive', picked: [] });

  /* ---------------- 3. import: PDFs, photos, Google Doc and Sheet exports, unsupported types */
  fresh(); fake = new ScopedGoogle(); client = mkClient(); fake.validRefresh.add('rt-A');
  await connect(adminA, 'drive'); fake.validRefresh.add('rt-A');
  const G: any = fake;
  G.addFile({ id: 'pdf1', name: 'Invoice 1001.pdf', content: 'PDF invoice one' });
  G.addFile({ id: 'photo1', name: 'Nameplate.jpg', mimeType: 'image/jpeg', content: 'JPEGDATA nameplate' });
  G.addFile({ id: 'gdoc1', name: 'Lease', mimeType: 'application/vnd.google-apps.document', content: 'lease text' });
  G.addFile({ id: 'gsheet1', name: 'Job costs', mimeType: 'application/vnd.google-apps.spreadsheet', content: 'costs' });
  G.addFile({ id: 'exe1', name: 'setup.exe', mimeType: 'application/octet-stream', content: 'MZ' });
  G.addFile({ id: 'zip1', name: 'all.zip', mimeType: 'application/zip', content: 'PK' });
  G.addFile({ id: 'form1', name: 'Survey', mimeType: 'application/vnd.google-apps.form', content: 'form' });
  G.addFile({ id: 'other', name: 'Not picked.pdf', content: 'never picked' });
  G.grant('pdf1', 'photo1', 'gdoc1', 'gsheet1', 'exe1', 'zip1', 'form1'); // 'other' was never picked
  r = await choose(adminA, { provider: 'drive', picked: pick('pdf1', 'photo1', 'gdoc1', 'gsheet1', 'exe1', 'zip1', 'form1') });
  eq('choosing files saves them', r.status, 200);
  const dl0 = G.downloads;
  out = await sync.syncConnection(ctxA, 'drive', D());
  let docs = await docsOf(tenA);
  eq('PDF, photo, Google Doc and Google Sheet are imported (4 documents)', [out.ok, out.tally.created, docs.length], [true, 4, 4]);
  check('the Google Doc was EXPORTED to PDF through Drive\'s export endpoint, not downloaded', G.callsMatching(/files\/gdoc1\/export\?mimeType=application%2Fpdf/) === 1 && docs.some((d: any) => d.original_filename === 'Lease.pdf' && d.content_type === 'application/pdf'));
  check('the Google Sheet was exported (workbook) and named .xlsx', G.callsMatching(/files\/gsheet1\/export\?mimeType=application%2Fvnd\.openxmlformats/) === 1 && docs.some((d: any) => d.original_filename === 'Job costs.xlsx'));
  eq('exactly 2 downloads (PDF, photo) + 2 exports', [G.downloads - dl0, G.exports], [2, 2]);
  check('documents enter the normal upload path (stage received, tenant key, no type guessed, queued for reading)', docs.every((d: any) => d.stage === 'received' && d.storage_key.startsWith(`${tenA}/`) && d.document_type === null && d.uploaded_by === 'google-sync' && enqueued.includes(d.id)));
  let items = await itemsOf(tenA, 'drive');
  check('each document is tagged with its Drive file id (item row) and source=google_drive (audit log)', items.filter((i: any) => i.state === 'imported').map((i: any) => i.external_id).sort().join() === 'gdoc1,gsheet1,pdf1,photo1' && (await Promise.all(docs.map((d: any) => audit(tenA, d.id)))).every((a: any) => a.length === 1 && a[0].changes.source === 'google_drive' && ['gdoc1', 'gsheet1', 'pdf1', 'photo1'].includes(a[0].changes.driveFileId)));
  const skipped = items.filter((i: any) => i.state === 'skipped');
  check('program, archive and Google Form are skipped with a plain reason, and never downloaded', skipped.length === 3 && skipped.every((i: any) => (i.note ?? '').length > 10) && G.downloads - dl0 === 2, JSON.stringify(skipped.map((s: any) => s.external_id)));
  check('a file that was not picked is never fetched', G.callsMatching(/files\/other/) === 0 && !docs.some((d: any) => d.original_filename === 'Not picked.pdf'));
  check('only the picked files were checked: the changes feed is never used in picker mode', G.callsMatching(/\/changes/) === 0);
  stat = await status(adminA);
  check('status gives the Settings card its counts (read, not brought in, chosen, month)', stat.connections[0].importedCount === 4 && stat.connections[0].skippedCount === 3 && stat.connections[0].choices.picked.length === 7 && stat.usedThisMonth === 4);

  /* ---------------- 4. dedupe on Drive file id + modifiedTime; re-check of picked files */
  const dl1 = G.downloads; const ex1 = G.exports; const ndocs = docs.length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('re-check with nothing changed: up to date, no download, no export, no new document', out.result === 'Up to date.' && G.downloads === dl1 && G.exports === ex1 && (await docsOf(tenA)).length === ndocs);
  G.touch('pdf1'); // new modifiedTime, same bytes
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('modifiedTime changed but bytes identical: re-read once, still ONE document', (await docsOf(tenA)).length === ndocs && out.tally.created === 0 && out.tally.duplicate === 1);
  const dl2 = G.downloads;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('the new modifiedTime is remembered: the next re-check does not download again', G.downloads === dl2 && out.result === 'Up to date.');
  G.edit('pdf1', 'PDF invoice one - REVISED');
  out = await sync.syncConnection(ctxA, 'drive', D());
  items = await itemsOf(tenA, 'drive'); docs = await docsOf(tenA);
  const it1 = items.find((i: any) => i.external_id === 'pdf1');
  check('modifiedTime changed with new content: re-imported as version 2, the earlier version kept', out.tally.created === 1 && it1.version === 2 && it1.previous_document_ids.length === 1 && docs.length === ndocs + 1);
  G.addFile({ id: 'pdf1copy', name: 'Copy of Invoice.pdf', content: 'PDF invoice one - REVISED' }); G.grant('pdf1copy');
  await choose(adminA, { provider: 'drive', picked: pick('pdf1', 'photo1', 'gdoc1', 'gsheet1', 'exe1', 'zip1', 'form1', 'pdf1copy') });
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('same bytes under a second Drive file: one document, two Drive ids pointing at it', out.tally.duplicate >= 1 && (await docsOf(tenA)).length === ndocs + 1 && (await itemsOf(tenA, 'drive')).filter((i: any) => i.content_sha256 === sha('PDF invoice one - REVISED')).length === 2);
  G.trash('photo1');
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('a picked file trashed in Drive is flagged "no longer in Google"; the DeepWell copy stays', out.tally.removed === 1 && (await itemsOf(tenA, 'drive')).find((i: any) => i.external_id === 'photo1').state === 'removed-in-source' && (await docsOf(tenA)).some((d: any) => d.original_filename === 'Nameplate.jpg'));
  G.granted.delete('pdf1copy');
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('a picked file the customer stopped giving access to is flagged the same way (not an error)', (await itemsOf(tenA, 'drive')).find((i: any) => i.external_id === 'pdf1copy').state === 'removed-in-source');

  /* ---------------- 5. caps */
  fresh(); fake = new ScopedGoogle(); client = mkClient(); fake.validRefresh.add('rt-A');
  await withTenant(ctxA, (db: any) => db.raw(`DELETE FROM google_sync_items WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid`, []));
  await connect(adminA, 'drive'); fake.validRefresh.add('rt-A');
  await q(`UPDATE google_connections SET files_imported = 0, sync_state = '{}'::jsonb WHERE tenant_id = $1 AND provider = 'drive'`, [tenA]);
  const C: any = fake;
  const cids = Array.from({ length: 6 }, (_, i) => `cap${i + 1}`);
  for (const id of cids) { C.addFile({ id, name: `Cap ${id}.pdf`, content: `cap content ${id}` }); C.grant(id); }
  await choose(adminA, { provider: 'drive', picked: pick(...cids) });
  const baseDocs = (await docsOf(tenA)).length;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { initialImportCap: 4, maxFilesPerRun: 100 } }));
  check('initial import cap: only 4 of 6 files come in, with the plain message', out.tally.created === 4 && (await docsOf(tenA)).length === baseDocs + 4 && /first import is limited/.test(out.result), JSON.stringify([out.tally, out.result]));
  const calls1 = C.calls.length;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { initialImportCap: 4, maxFilesPerRun: 100 } }));
  check('initial cap reached: later passes in the same month make no Google call and import nothing', out.tally.created === 0 && C.calls.length === calls1 && /first import is limited/.test(out.result));
  await q(`UPDATE google_connections SET sync_state = sync_state || '{"initialCapMonth":"2000-01"}'::jsonb WHERE tenant_id = $1 AND provider = 'drive'`, [tenA]);
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { initialImportCap: 4, maxFilesPerRun: 100 } }));
  check('when the monthly allowance renews, the rest comes in', out.tally.created === 2 && (await docsOf(tenA)).length === baseDocs + 6 && (await connOf(tenA, 'drive')).sync_state.initialDone === true);
  // monthly cap (organization-wide, all sources)
  for (const id of ['mo1', 'mo2', 'mo3']) { C.addFile({ id, name: `Month ${id}.pdf`, content: `month ${id}` }); C.grant(id); }
  await choose(adminA, { provider: 'drive', picked: pick(...cids, 'mo1', 'mo2', 'mo3') });
  const usedMonth = (await status(adminA)).usedThisMonth;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerMonth: usedMonth + 2, maxFilesPerRun: 100 } }));
  check('monthly cap: stops at the organization\'s monthly allowance with the plain message', out.tally.created === 2 && /month's allowance/.test(out.result), JSON.stringify([out.tally, out.result]));
  const calls2 = C.calls.length;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerMonth: usedMonth + 2, maxFilesPerRun: 100 } }));
  check('monthly cap reached: no Google call, nothing imported', out.tally.created === 0 && C.calls.length === calls2 && /month's allowance/.test(out.result));
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerMonth: usedMonth + 100 } }));
  check('allowance restored: the last file comes in', out.tally.created === 1);
  r = await choose(adminA, { provider: 'drive', picked: Array.from({ length: 501 }, (_, i) => ({ id: `big${i}abc`, kind: 'file' })) });
  eq('more than the picked-file limit (500) is refused', r.status, 400);

  /* ---------------- 6. revocation */
  const tokenBefore = (await connOf(tenA, 'drive')).refresh_token_enc;
  const docsBefore = (await docsOf(tenA)).length;
  r = await route.handleOp(adminA, { op: 'disconnect', provider: 'drive' }, { google: client });
  row = await connOf(tenA, 'drive');
  check('disconnect: Google is told to drop the grant, DeepWell\'s copy of the token is deleted, choices cleared', r.body.disconnected === true && C.revoked.includes('rt-A') && row.status === 'disconnected' && row.refresh_token_enc === null && JSON.stringify(row.config) === '{}' && !!tokenBefore);
  eq('disconnect: documents already imported stay', (await docsOf(tenA)).length, docsBefore);
  const callsRev = C.calls.length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('after disconnect a sync does nothing and makes no Google call', out.skipped === 'not-connected' || out.skipped === 'disconnected' || !!out.skipped, JSON.stringify(out));
  const sweep = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: KA, tenant_name: KA }] }) });
  check('the scheduled sweep skips a disconnected company', C.calls.length === callsRev && sweep.created === 0);
  r = await route.handleOp(adminA, { op: 'picker-token' }, { google: client });
  eq('after disconnect the picker cannot get a token (409)', r.status, 409);
  r = await route.handleOp(adminA, { op: 'sync-now', provider: 'drive' }, { google: client });
  eq('after disconnect "sync now" says to connect first (409)', r.status, 409);
  // revoked on Google's side
  fresh(); fake = new ScopedGoogle(); client = mkClient(); fake.validRefresh.add('rt-A');
  await connect(adminA, 'drive'); fake.validRefresh.add('rt-A');
  (fake as any).addFile({ id: 'rvk1', name: 'Rv.pdf', content: 'rv' }); (fake as any).grant('rvk1');
  await choose(adminA, { provider: 'drive', picked: pick('rvk1') });
  fake.validRefresh.delete('rt-A');
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('access withdrawn at Google: the connection asks the admin to sign in again and syncing stops', out.ok === false && (await connOf(tenA, 'drive')).status === 'needs-reconnect');
  const callsNR = fake.calls.length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('a connection that needs sign-in makes no further Google calls', fake.calls.length === callsNR && !!out.skipped);

  /* ---------------- 7. tenant isolation */
  const A: any = new ScopedGoogle(); const B: any = new ScopedGoogle();
  A.validRefresh.add('rt-A'); B.validRefresh.add('rt-A');
  await withTenant(ctxA, (db: any) => db.raw(`DELETE FROM google_sync_items WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid`, []));
  const mk = (f: any) => gapi.createGoogleClient({ env: process.env, fetchImpl: f.fetch, sleep: async () => {}, rand: () => 0.5 });
  const cA = mk(A); const cB = mk(B);
  const connectWith = async (auth: any, f: any, c: any) => {
    const s = await route.handleOp(auth, { op: 'start', provider: 'drive' }, { google: c });
    f.grantScope = new URL(s.body.url).searchParams.get('scope'); f.validRefresh.add('rt-A');
    return route.handleCallback({ code: 'good-code', state: new URL(s.body.url).searchParams.get('state') }, { google: c });
  };
  await connectWith(adminA, A, cA); await connectWith(adminB, B, cB);
  A.addFile({ id: 'secretA', name: 'Company A payroll.pdf', content: 'A ONLY CONTENT' }); A.grant('secretA');
  B.addFile({ id: 'bfile', name: 'Company B quote.pdf', content: 'B ONLY CONTENT' }); B.grant('bfile');
  await choose(adminA, { provider: 'drive', picked: [{ id: 'secretA', name: 'Company A payroll.pdf', kind: 'file' }] });
  await route.handleOp(adminB, { op: 'choices', provider: 'drive', picked: [{ id: 'bfile', name: 'Company B quote.pdf', kind: 'file' }] }, { google: cB });
  await sync.syncConnection(ctxA, 'drive', D({ google: cA }));
  await sync.syncConnection(ctxB, 'drive', D({ google: cB }));
  const docsA = await docsOf(tenA); const docsB = await docsOf(tenB);
  check('each company\'s documents come only from its own Drive', docsA.some((d: any) => d.original_filename === 'Company A payroll.pdf') && !docsA.some((d: any) => /Company B/.test(d.original_filename)) && docsB.length === 1 && docsB[0].original_filename === 'Company B quote.pdf');
  const stA = await status(adminA); const stB = await route.handleOp(adminB, { op: 'status' }, { google: cB });
  check('company B\'s Settings card never shows company A\'s files or counts, and the reverse', !JSON.stringify(stB.body).includes('Company A') && !JSON.stringify(stA).includes('Company B') && stB.body.connections[0].choices.picked.length === 1);
  const aConnId = (await connOf(tenA, 'drive')).id;
  eq('database level: B cannot read A\'s connection or file rows (RLS)', [(await withTenant(ctxB, (db: any) => db.raw(`SELECT * FROM google_connections WHERE id = $1`, [aConnId]))).rows.length, (await withTenant(ctxB, (db: any) => db.raw(`SELECT * FROM google_sync_items WHERE external_id = 'secretA'`, []))).rows.length], [0, 0]);
  const swapped = await connOf(tenA, 'drive');
  await q(`UPDATE google_connections SET refresh_token_enc = $2 WHERE tenant_id = $1 AND provider = 'drive'`, [tenB, swapped.refresh_token_enc]);
  A.addFile({ id: 'secretA2', name: 'Company A second.pdf', content: 'A SECOND' }); A.grant('secretA2');
  await route.handleOp(adminB, { op: 'choices', provider: 'drive', picked: [{ id: 'secretA2', kind: 'file' }] }, { google: cB });
  const docsBBefore = (await docsOf(tenB)).length;
  const outB = await sync.syncConnection(ctxB, 'drive', D({ google: cA }));
  check('even a copied token (A\'s ciphertext put in B\'s row) cannot open under B: nothing from A reaches B', outB.ok === false && (await docsOf(tenB)).length === docsBBefore && !(await docsOf(tenB)).some((d: any) => /Company A/.test(d.original_filename)));
  const ptB = await route.handleOp(adminB, { op: 'picker-token' }, { google: cA }).catch((e: any) => ({ status: 500, e }));
  check('and B cannot get a picker token from it either', ptB.status !== 200);
  await q(`UPDATE google_connections SET refresh_token_enc = $2 WHERE tenant_id = $1 AND provider = 'drive'`, [tenB, cr.encryptToken('rt-A', tenB)]);
  const sameId: any = await route.handleOp(adminB, { op: 'choices', provider: 'drive', picked: [{ id: 'secretA', kind: 'file' }] }, { google: cB });
  const outB2 = await sync.syncConnection(ctxB, 'drive', D({ google: cB }));
  check('B naming one of A\'s Drive ids gets nothing: B\'s own Google account has no such file, so it is flagged missing, never fetched', sameId.status === 200 && !(await docsOf(tenB)).some((d: any) => /Company A/.test(d.original_filename)) && B.callsMatching(/secretA\b.*alt=media/) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
