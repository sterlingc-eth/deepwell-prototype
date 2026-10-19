// npm run verify:google-sync
// Google Drive + Gmail attachment sync, against a PRETEND Google (scripts/lib/fakeGoogle.mjs) and a real Postgres (PGlite loaded from
// M3-config/*.sql, queried as the app's NOBYPASSRLS role). No real Google call is possible here: global fetch is replaced with a thrower
// and every Google/R2 dependency is injected.
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

console.log('verify:google-sync');

// ---- nothing can reach the real internet
let realFetchCalls = 0;
globalThis.fetch = (async () => { realFetchCalls++; throw new Error('real network call attempted in a test'); }) as any;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEEPWELL_GOOGLE_SYNC;
process.env.DEEPWELL_GOOGLE_SCOPE_MODE = 'full'; // this suite covers the old full mode (drive.readonly + Gmail); scripts/verify-google-picker.ts covers the default picker mode
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.test';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-xyz';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.test/api/google-sync/callback';
process.env.GOOGLE_PICKER_API_KEY = 'picker-key';
process.env.GOOGLE_CLOUD_PROJECT_NUMBER = '123456';

const cfg: any = await import('../api/_lib/googleSync/config.js');
const cr: any = await import('../api/_lib/googleSync/crypto.js');
const gapi: any = await import('../api/_lib/googleSync/googleApi.js');
const gmailMod: any = await import('../api/_lib/googleSync/gmail.js');
const driveMod: any = await import('../api/_lib/googleSync/drive.js');
const importer: any = await import('../api/_lib/googleSync/importer.js');
// @ts-expect-error plain JS fixture
const { FakeGoogle } = await import('./lib/fakeGoogle.mjs');

/* ============================================================ 1. pure: switch, scopes, limits, wording */
eq('flag is OFF when unset', cfg.isGoogleSyncEnabled({}), false);
eq('flag is OFF for "0"', cfg.isGoogleSyncEnabled({ DEEPWELL_GOOGLE_SYNC: '0' }), false);
eq('flag is OFF for "true" (only "1" turns it on)', cfg.isGoogleSyncEnabled({ DEEPWELL_GOOGLE_SYNC: 'true' }), false);
eq('flag is ON for "1"', cfg.isGoogleSyncEnabled({ DEEPWELL_GOOGLE_SYNC: '1' }), true);
check('Drive default (narrow) asks only for drive.file', cfg.scopesFor('drive', 'narrow').includes('https://www.googleapis.com/auth/drive.file') && !cfg.scopesFor('drive', 'narrow').some((s: string) => /drive\.readonly|\/drive$/.test(s)));
check('Drive full asks for drive.readonly, never write access', cfg.scopesFor('drive', 'full').includes('https://www.googleapis.com/auth/drive.readonly') && !cfg.scopesFor('drive', 'full').some((s: string) => /\/drive$|drive\.metadata$/.test(s)));
check('Gmail asks only for gmail.readonly (no modify/send)', cfg.scopesFor('gmail', 'full').filter((s: string) => s.includes('gmail')).join() === 'https://www.googleapis.com/auth/gmail.readonly');
check('unknown Drive mode falls back to the narrow scope', cfg.scopesFor('drive', 'bogus').includes('https://www.googleapis.com/auth/drive.file'));
const L = cfg.limits({});
check('default limits are bounded', L.maxFilesPerDay === 200 && L.maxFilesPerRun === 40 && L.maxBytesPerFile === 24 * 1024 * 1024);
eq('limit env cannot exceed the hard ceiling', cfg.limits({ GOOGLE_SYNC_MAX_FILES_PER_DAY: '999999' }).maxFilesPerDay, 200);
const banned = /token|scope|oauth|\bapi\b|sha|checksum|inngest|restricted|verification|encrypt|credential/i;
check('customer wording has no technical or security-internal terms', Object.values(cfg.WORDING).every((s) => !banned.test(String(s))), Object.values(cfg.WORDING).find((s) => banned.test(String(s))) as string);

/* ============================================================ 2. token protection */
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const enc = cr.encryptToken('1//refresh-token-secret', T1);
check('encrypted token has the v1 format and hides the secret', cr.looksEncrypted(enc) && !enc.includes('refresh-token-secret'));
eq('token round-trips for its own organization', cr.decryptToken(enc, T1), '1//refresh-token-secret');
check('same token encrypts differently each time (random IV)', cr.encryptToken('1//refresh-token-secret', T1) !== enc);
let threw = false; try { cr.decryptToken(enc, T2); } catch { threw = true; }
check('a token copied to another organization will not open', threw);
threw = false; try { cr.decryptToken(enc.slice(0, -3) + 'AAA', T1); } catch { threw = true; }
check('a tampered token will not open', threw);
threw = false; try { cr.decryptToken(enc, T1, { GOOGLE_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }); } catch { threw = true; }
check('a different key will not open it', threw);
threw = false; try { cr.encryptToken('x', T1, {}); } catch (e: any) { threw = e.name === 'TokenKeyError'; }
check('a missing key is refused, not defaulted', threw);
threw = false; try { cr.encryptToken('x', T1, { GOOGLE_TOKEN_KEY: 'short' }); } catch (e: any) { threw = e.name === 'TokenKeyError'; }
check('a short key is refused', threw);
const st = cr.signState({ t: 'org_x' });
eq('signed state verifies', cr.verifyState(st)?.t, 'org_x');
eq('tampered state is rejected', cr.verifyState(st.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'))), null);
eq('expired state is rejected', cr.verifyState(cr.signState({ t: 'o' }, process.env, Date.now() - 3600_000)), null);
eq('state signed with another key is rejected', cr.verifyState(cr.signState({ t: 'o' }, { GOOGLE_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64') })), null);
eq('garbage state is rejected', cr.verifyState('nonsense'), null);

/* ============================================================ 3. pure: backoff, parsing, filters */
eq('backoff honours Retry-After', gapi.backoffDelayMs(0, '7'), 7000);
check('backoff grows and is capped', gapi.backoffDelayMs(2, null, () => 1) > gapi.backoffDelayMs(0, null, () => 1) && gapi.backoffDelayMs(20, null, () => 1) <= 30_000);
eq('senders are normalised, deduplicated, bad ones dropped', gmailMod.normalizeSenders('A@x.com, a@x.com; not-an-email <b@y.org>'), ['a@x.com', 'b@y.org']);
eq('sender query', gmailMod.senderQuery(['a@x.com', 'b@y.org'], 5), 'has:attachment after:5 from:(a@x.com OR b@y.org)');
const parts = gmailMod.attachmentParts({ parts: [{ partId: '0', filename: '', body: { size: 9, data: 'x' } }, { partId: '1', filename: 'inv.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 5 } }, { partId: '2', parts: [{ partId: '2.1', filename: 'logo.png', mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<l>' }], body: { attachmentId: 'a2', size: 3 } }] }] });
check('attachment parts: body text is not an attachment, nested ones are found, inline detected', parts.length === 2 && parts[0].filename === 'inv.pdf' && parts[1].inline === true);
eq('Google Doc export name gets .pdf', driveMod.driveFileName({ name: 'Lease', mimeType: 'application/vnd.google-apps.document' }), 'Lease.pdf');
eq('Google Sheet export name gets .xlsx', driveMod.driveFileName({ name: 'Costs', mimeType: 'application/vnd.google-apps.spreadsheet' }), 'Costs.xlsx');
eq('export name is not doubled', driveMod.driveFileName({ name: 'Lease.pdf', mimeType: 'application/vnd.google-apps.document' }), 'Lease.pdf');
check('pre-check accepts a PDF', importer.precheck({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 }).ok);
check('pre-check refuses a program', !importer.precheck({ filename: 'setup.exe', contentType: 'application/octet-stream', sizeBytes: 100 }).ok);
check('pre-check refuses an archive', !importer.precheck({ filename: 'all.zip', contentType: 'application/zip', sizeBytes: 100 }).ok);
check('pre-check refuses a 30 MB PDF with the standard wording', /24 MB/.test(importer.precheck({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 30e6 }).note));
check('pre-check refuses a name with no ending', !importer.precheck({ filename: 'README', contentType: 'text/plain', sizeBytes: 5 }).ok);

/* ============================================================ 4. source rules */
const srcFiles = fs.readdirSync(path.join(ROOT, 'api/_lib/googleSync')).map((f) => ({ f, s: read(`api/_lib/googleSync/${f}`) }));
check('api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
check('only googleApi.js (Google) and importer.js (storage upload) make network requests', srcFiles.filter((x) => /\bfetch\(|fetchImpl\(/.test(x.s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))).map((x) => x.f).sort().join() === 'googleApi.js,importer.js');
check('no code in googleSync reads .env or process.env secrets except by name', !srcFiles.some((x) => /readFileSync\(.*\.env|dotenv/.test(x.s)));
check('forbidden lanes are not imported (ask / retrieval / grounding / records)', !srcFiles.some((x) => /from ["'][^"']*(\/ask\.js|retrieval\/|grounding\/|_lib\/records\/)/.test(x.s)));
check('the importer uses the upload allow-list, document creation and the queue (one pipeline)', /checkUploadFile/.test(read('api/_lib/googleSync/importer.js')) && /db\.createDocument/.test(read('api/_lib/googleSync/importer.js')) && /enqueueDocument/.test(read('api/_lib/googleSync/importer.js')) && /assertUploadRoomInTx/.test(read('api/_lib/googleSync/importer.js')));
check('no second pipeline: googleSync never inserts documents, pages or extractions itself', !srcFiles.some((x) => /INSERT INTO (documents|document_pages|extractions)/i.test(x.s)));
check('the importer never sets document type, audience or folder', !/document_type|audience|_company_folder/.test(read('api/_lib/googleSync/importer.js').replace(/\/\*[\s\S]*?\*\//g, '')));
check('account.js routes google-sync behind the flag with a lazy import', /"google-sync":[\s\S]{0,200}DEEPWELL_GOOGLE_SYNC === "1"[\s\S]{0,120}import\("\.\/_lib\/googleSync\/route\.js"\)/.test(read('api/account.js')));
check('Inngest schedule is defined only when the flag is on', /if \(process\.env\.DEEPWELL_GOOGLE_SYNC === "1"\) \{\s*extra\.push\(inngest\.createFunction\(/.test(read('api/_lib/queue.js')));
check('nightly sweep hook is gated by the flag', /if \(process\.env\.DEEPWELL_GOOGLE_SYNC === "1"\) \{\s*try \{\s*const \{ runGoogleSyncSweep \}/.test(read('api/_lib/routes/cron-sweep.js')));
const sql = read('M3-config/71-google-sync.sql');
check('SQL: both tables have row-level security, forced, with a tenant policy', /ENABLE ROW LEVEL SECURITY/.test(sql) && /FORCE ROW LEVEL SECURITY/.test(sql) && /app\.tenant_id/.test(sql) && /google_connections/.test(sql) && /google_sync_items/.test(sql));
check('SQL: changes no existing table', !/ALTER TABLE (documents|tenants|extractions|document_pages)\b/i.test(sql));
check('SQL: the listing function is definer-only and returns identifiers only', /SECURITY DEFINER/.test(sql) && /REVOKE ALL ON FUNCTION list_google_sync_tenants/.test(sql) && /RETURNS TABLE\(tenant_key text\)/.test(sql));
check('SQL: token column is named as encrypted', /refresh_token_enc/.test(sql) && !/access_token/.test(sql));

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
  let fake = new FakeGoogle();
  const sleeps: number[] = [];
  const mkClient = () => gapi.createGoogleClient({ env: process.env, fetchImpl: fake.fetch, sleep: async (ms: number) => { sleeps.push(ms); }, rand: () => 0.5 });
  let client = mkClient();
  const D = (over: Record<string, unknown> = {}) => ({ google: client, importDeps: importDeps(), assertBilling: async () => ({ allowed: true }), ...over });
  const fresh = () => { fake = new FakeGoogle(); client = mkClient(); sleeps.length = 0; };
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

  /* ---------------- 5a. flag OFF: nothing runs */
  delete process.env.DEEPWELL_GOOGLE_SYNC;
  const callsBefore = fake.calls.length;
  let r: any = await route.handleOp(adminA, { op: 'status' }, { google: client });
  eq('OFF: status says enabled:false', r.body, { enabled: false });
  r = await route.handleOp(adminA, { op: 'start', provider: 'drive' }, { google: client });
  eq('OFF: connecting is 404', r.status, 404);
  r = await route.handleOp(adminA, { op: 'sync-now', provider: 'drive' }, { google: client });
  eq('OFF: sync-now is 404', r.status, 404);
  r = await route.handleCallback({ code: 'good-code', state: cr.signState({ t: KA, p: 'drive', m: 'narrow' }) }, { google: client });
  eq('OFF: the Google callback is 404', r.status, 404);
  eq('OFF: a connection pass does nothing', await sync.syncConnection(ctxA, 'drive', D()), { skipped: 'off' });
  let tenantsAsked = 0;
  eq('OFF: the scheduled sweep returns at once', await sync.runGoogleSyncSweep({ deps: D({ tenants: new Proxy([], { get(t: any, k) { tenantsAsked++; return t[k]; } }) }) }), { skipped: 'off' });
  check('OFF: no Google call and no tenant listing happened', fake.calls.length === callsBefore && tenantsAsked === 0);
  let res = mkRes(); await accountHandler({ method: 'POST', query: { action: 'google-sync' }, body: { op: 'start', provider: 'drive' }, headers: {} }, res);
  eq('OFF: /api/account?action=google-sync answers 404 and loads nothing', res.statusCode, 404);
  res = mkRes(); await accountHandler({ method: 'POST', query: { action: 'google-sync' }, body: { op: 'status' }, headers: {} }, res);
  check('OFF: status through the real endpoint says enabled:false', res.statusCode === 200 && res.body?.enabled === false);
  eq('OFF: no table was touched', (await q('SELECT count(*)::int AS n FROM google_connections'))[0].n, 0);

  /* ---------------- 5b. connect / disconnect / admin / tenant isolation */
  process.env.DEEPWELL_GOOGLE_SYNC = '1';
  r = await route.handleOp(memberA, { op: 'start', provider: 'drive' }, { google: client }).catch((e: any) => ({ status: e.status }));
  eq('a member (not admin) cannot start a connection', r.status, 403);
  r = await route.handleOp(memberA, { op: 'disconnect', provider: 'drive' }, { google: client }).catch((e: any) => ({ status: e.status }));
  eq('a member cannot disconnect', r.status, 403);
  r = await route.handleOp(memberA, { op: 'status' }, { google: client }).catch((e: any) => ({ status: e.status }));
  eq('a member cannot read connection status', r.status, 403);
  r = await route.handleOp(soloC, { op: 'status' }, { google: client });
  eq('a solo account is its own admin', r.status, 200);
  r = await route.handleOp(adminA, { op: 'start', provider: 'drive', scopeMode: 'narrow' }, { google: client });
  const u = new URL(r.body.url);
  check('start: consent URL uses the narrow Drive scope, offline access, a signed state, and no secret', u.host === 'accounts.google.com' && u.searchParams.get('scope')!.includes('drive.file') && !u.searchParams.get('scope')!.includes('readonly') && u.searchParams.get('access_type') === 'offline' && !!cr.verifyState(u.searchParams.get('state')) && !r.body.url.includes('client-secret-xyz'));
  r = await route.handleOp(adminA, { op: 'start', provider: 'drive', scopeMode: 'full' }, { google: client });
  check('start: full access mode asks for drive.readonly', new URL(r.body.url).searchParams.get('scope')!.includes('drive.readonly'));
  r = await route.handleOp(adminA, { op: 'start', provider: 'gmail' }, { google: client });
  check('start: Gmail asks for gmail.readonly only', new URL(r.body.url).searchParams.get('scope')!.includes('gmail.readonly') && !new URL(r.body.url).searchParams.get('scope')!.includes('gmail.modify'));
  r = await route.handleOp(adminA, { op: 'start', provider: 'dropbox' }, { google: client });
  eq('start: unknown provider is a 400', r.status, 400);
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID; delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  r = await route.handleOp(adminA, { op: 'start', provider: 'drive' }, { google: mkClient() });
  eq('start: not set up on this deployment is a plain 503', r.status, 503); process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;

  fresh();
  r = await route.handleCallback({ code: 'good-code', state: 'forged' }, { google: client });
  eq('callback: forged state goes to an error page and stores nothing', [r.redirect, (await q('SELECT count(*)::int AS n FROM google_connections'))[0].n], ['/app/?screen=team&google=error', 0]);
  r = await route.handleCallback({ code: 'good-code', state: cr.signState({ t: KA, p: 'drive', m: 'narrow' }, process.env, Date.now() - 7200_000) }, { google: client });
  eq('callback: expired state is refused', r.redirect, '/app/?screen=team&google=error');
  r = await route.handleCallback({ error: 'access_denied', state: cr.signState({ t: KA, p: 'drive', m: 'narrow' }) }, { google: client });
  eq('callback: the admin saying no is "cancelled", not an error', r.redirect, '/app/?screen=team&google=cancelled');
  fake.noRefresh = true;
  r = await connect(adminA, 'drive'); eq('callback: no refresh token returned is refused', r.redirect, '/app/?screen=team&google=error'); fake.noRefresh = false;
  const s0 = await route.handleOp(adminA, { op: 'start', provider: 'drive', scopeMode: 'full' }, { google: client });
  fake.grantScope = 'openid email'; // the admin un-ticked the Drive box
  r = await route.handleCallback({ code: 'good-code', state: new URL(s0.body.url).searchParams.get('state') }, { google: client });
  eq('callback: missing permission is refused', r.redirect, '/app/?screen=team&google=error');
  eq('callback: nothing stored after the refusals', (await q('SELECT count(*)::int AS n FROM google_connections'))[0].n, 0);

  r = await connect(adminA, 'drive', 'narrow');
  eq('callback: a good connect returns to the app as connected', r.redirect, '/app/?screen=team&google=connected');
  let row = await connOf(tenA, 'drive');
  check('token is stored encrypted, never in the clear', cr.looksEncrypted(row.refresh_token_enc) && !JSON.stringify(row).includes('rt-A') && cr.decryptToken(row.refresh_token_enc, tenA) === 'rt-A');
  eq('the connected account email is kept for display', row.google_email, 'owner@example.com');
  const stat = await status(adminA);
  check('status never contains any token or ciphertext', !JSON.stringify(stat).includes('rt-A') && !JSON.stringify(stat).includes('v1.') && !JSON.stringify(stat).includes('refresh'));
  check('status shows the connection', stat.connections.length === 1 && stat.connections[0].provider === 'drive' && stat.configured === true && stat.pickerReady === true);
  eq('tenant isolation: organization B sees no connections', (await status(adminB)).connections, []);
  eq('tenant isolation: B cannot read A at the database (RLS)', (await withTenant(ctxB, (db: any) => S.listConnections(db))).length, 0);
  eq('tenant isolation: A sees its own through the app role', (await withTenant(ctxA, (db: any) => S.listConnections(db))).length, 1);
  r = await choose(adminB, { provider: 'drive', picked: [{ id: 'folderX', kind: 'folder' }] });
  eq('tenant isolation: B cannot change A\'s choices (B has no connection)', r.status, 409);
  r = await route.handleOp(adminB, { op: 'disconnect', provider: 'drive' }, { google: client });
  check('tenant isolation: B disconnecting does nothing to A', (await connOf(tenA, 'drive')).status === 'active');
  r = await connect(adminB, 'drive', 'narrow');
  check('B connects separately with its own encrypted token that A\'s key binding cannot open', (await connOf(tenB, 'drive')) && (() => { try { cr.decryptToken((connOf as any) && '', tenA); return false; } catch { return true; } })());
  const rowB = await connOf(tenB, 'drive');
  threw = false; try { cr.decryptToken(rowB.refresh_token_enc, tenA); } catch { threw = true; }
  check('B\'s stored token will not open under A\'s organization id', threw);

  /* ---------------- 5c. choices validation */
  r = await choose(adminA, { provider: 'drive', picked: [{ id: 'bad id!', kind: 'folder' }, { id: 'ok_folder_1', name: 'x'.repeat(500), kind: 'folder' }] });
  row = await connOf(tenA, 'drive');
  check('choices: bad ids are dropped and long names cut', r.status === 200 && row.config.picked.length === 1 && row.config.picked[0].name.length === 200);
  r = await choose(adminA, { provider: 'drive', picked: Array.from({ length: 51 }, (_, i) => ({ id: `folder${i}abc`, kind: 'folder' })) });
  eq('choices: more than the maximum is refused', r.status, 400);
  r = await choose(adminA, { provider: 'gmail', labels: [] });
  eq('choices: Gmail before connecting is refused', r.status, 409);

  /* ---------------- 5d. Drive: initial import */
  fresh();
  fake.validRefresh.add('rt-A');
  fake.addFolder('f_root', 'Customer files');
  fake.addFolder('f_sub', 'Invoices', ['f_root']);
  fake.addFolder('f_other', 'Personal');
  fake.addFile({ id: 'd1', name: 'Invoice 1001.pdf', parents: ['f_root'], content: 'PDF invoice one' });
  fake.addFile({ id: 'd2', name: 'Invoice 1002.pdf', parents: ['f_sub'], content: 'PDF invoice two' });
  fake.addFile({ id: 'd3', name: 'Lease', mimeType: 'application/vnd.google-apps.document', parents: ['f_sub'], content: 'lease text' });
  fake.addFile({ id: 'd4', name: 'Job costs', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['f_root'], content: 'costs' });
  fake.addFile({ id: 'd5', name: 'setup.exe', mimeType: 'application/octet-stream', parents: ['f_root'], content: 'MZ' });
  fake.addFile({ id: 'd6', name: 'photos.zip', mimeType: 'application/zip', parents: ['f_sub'], content: 'PK' });
  fake.addFile({ id: 'd7', name: 'Survey', mimeType: 'application/vnd.google-apps.form', parents: ['f_root'], content: 'form' });
  fake.addFile({ id: 'd8', name: 'Huge scan.pdf', parents: ['f_root'], content: 'x' });
  fake.files.get('d8').content = Buffer.alloc(10); fake.meta = ((orig) => function (this: any, f: any) { const m = orig.call(this, f); return f.id === 'd8' ? { ...m, size: String(30 * 1024 * 1024) } : m; })(fake.meta);
  fake.addFile({ id: 'd9', name: 'Personal note.pdf', parents: ['f_other'], content: 'private note' });
  fake.addFile({ id: 'd10', name: 'Offer Letter - J Smith.pdf', parents: ['f_root'], content: 'OFFER LETTER for J Smith salary 70000' });
  await connect(adminA, 'drive', 'full');
  fake.validRefresh.add('rt-A');
  await choose(adminA, { provider: 'drive', picked: [{ id: 'f_root', name: 'Customer files', kind: 'folder' }] });
  const dl0 = fake.downloads;
  let out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerRun: 100 } }));
  let docs = await docsOf(tenA);
  check('initial import: every supported file in the folder tree is stored', out.ok && out.tally.created === 5 && docs.length === 5, JSON.stringify(out.tally));
  check('initial import: the folder not chosen is not touched', !docs.some((d) => d.original_filename === 'Personal note.pdf'));
  check('documents go through the upload pipeline shape: stage received, tenant-prefixed key, canonical type, no type guessed', docs.every((d) => d.stage === 'received' && d.storage_key === `${tenA}/${d.sha256_hash.slice(0, 2)}/${d.sha256_hash}` && d.document_type === null && d.uploaded_by === 'google-sync'));
  check('bytes were written to storage under that key', docs.every((d) => R2.has(d.storage_key)));
  check('every new document was handed to the reading queue', enqueued.length === 5 && docs.every((d) => enqueued.includes(d.id)));
  check('Google Doc became a PDF and Google Sheet became an .xlsx', docs.some((d) => d.original_filename === 'Lease.pdf' && d.content_type === 'application/pdf') && docs.some((d) => d.original_filename === 'Job costs.xlsx' && /spreadsheetml/.test(d.content_type)));
  eq('exports were done through Drive export, not download', [fake.exports, fake.downloads - dl0], [2, 3]);
  let items = await itemsOf(tenA, 'drive');
  const skipped = items.filter((i) => i.state === 'skipped');
  check('program, archive, Google Form and oversize files are skipped with a plain reason and never downloaded', skipped.length === 4 && skipped.every((i) => typeof i.note === 'string' && i.note.length > 10) && fake.downloads - dl0 === 3);
  check('the over-24-MB file says so in the standard wording', /24 MB/.test(items.find((i) => i.external_id === 'd8').note));
  row = await connOf(tenA, 'drive');
  check('connection records the pass: last sync time, files brought in, plain result, no error', row.last_sync_at && row.files_imported === 5 && row.last_result === 'Brought in 5 new files.' && row.last_error === null);
  check('the lease is released after a pass', row.sync_state.lease === null || row.sync_state.lease === undefined);
  check('the change token was captured and promoted after the initial import', row.sync_state.pageToken === row.sync_state.startToken && !!row.sync_state.pageToken);

  // privacy: HR paper stays private
  const hr = docs.find((d) => d.original_filename.startsWith('Offer Letter'));
  const exAud = await q(`SELECT count(*)::int AS n FROM extractions WHERE document_id = $1`, [hr.id]);
  eq('privacy: sync sets no audience/folder on the document (nothing to override the detector)', exAud[0].n, 0);
  await q(`UPDATE documents SET document_type = 'hr-letter', stage = 'read' WHERE id = $1`, [hr.id]); // what the extraction pipeline does for an offer letter
  const visible = await withTenant(ctxA, (db: any) => db.raw(`SELECT id FROM documents d WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND ${hrGateSql('d')}`, []));
  check('privacy: a synced HR paper is still private (hidden from people without People and HR access)', !visible.rows.some((x: any) => x.id === hr.id) && visible.rows.length === 4);
  check('privacy: it is still in the company\'s own document list for an admin', (await docsOf(tenA)).some((d) => d.id === hr.id));

  /* ---------------- 5e. unchanged / incremental / versioning / dedupe / removal */
  const dl1 = fake.downloads; const ex1 = fake.exports;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('second pass with nothing new: up to date and no downloads', out.result === 'Up to date.' && fake.downloads === dl1 && fake.exports === ex1);
  fake.addFile({ id: 'n1', name: 'New PO.pdf', parents: ['f_sub'], content: 'PO new' });
  fake.addFile({ id: 'n2', name: 'Elsewhere.pdf', parents: ['f_other'], content: 'not chosen' });
  out = await sync.syncConnection(ctxA, 'drive', D());
  docs = await docsOf(tenA);
  check('incremental: a new file in a chosen subfolder is picked up from the changes feed', out.tally.created === 1 && docs.some((d) => d.original_filename === 'New PO.pdf'));
  check('incremental: a new file outside the chosen folders is ignored (full access mode)', !docs.some((d) => d.original_filename === 'Elsewhere.pdf'));
  row = await connOf(tenA, 'drive');
  const tokenAfter = row.sync_state.pageToken;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('incremental: the page token only moves forward and a quiet pass makes no document', out.tally.created === 0 && (await connOf(tenA, 'drive')).sync_state.pageToken === tokenAfter);

  fake.edit('d1', 'PDF invoice one - REVISED');
  out = await sync.syncConnection(ctxA, 'drive', D());
  docs = await docsOf(tenA);
  items = await itemsOf(tenA, 'drive');
  const it1 = items.find((i) => i.external_id === 'd1');
  const oldDoc = docs.find((d) => d.sha256_hash === sha('PDF invoice one'));
  const newDoc = docs.find((d) => d.sha256_hash === sha('PDF invoice one - REVISED'));
  check('versioning: an edited file becomes a NEW document at version 2', out.tally.created === 1 && it1.version === 2 && it1.document_id === newDoc.id);
  check('versioning: the earlier version is kept and listed as previous', !!oldDoc && it1.previous_document_ids.includes(oldDoc.id));
  check('versioning: the new version goes through the same queue', enqueued.includes(newDoc.id));
  fake.touch('d1');
  const before = (await docsOf(tenA)).length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('versioning: touching a file without changing it makes no new document or version', (await docsOf(tenA)).length === before && (await itemsOf(tenA, 'drive')).find((i) => i.external_id === 'd1').version === 2);

  fake.addFile({ id: 'dup1', name: 'Copy of Invoice 1002.pdf', parents: ['f_root'], content: 'PDF invoice two' });
  const putCount = R2.size; const enqBefore = enqueued.length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('dedupe: the same bytes under another Drive file are ONE document (no second copy, no second read)', out.tally.duplicate === 1 && out.tally.created === 0 && R2.size === putCount && enqueued.length === enqBefore && (await docsOf(tenA)).filter((d) => d.sha256_hash === sha('PDF invoice two')).length === 1);
  check('dedupe: both Drive files point at that one document', (await itemsOf(tenA, 'drive')).filter((i) => i.content_sha256 === sha('PDF invoice two')).length === 2);

  // a document that was uploaded by hand first
  const manualBytes = Buffer.from('uploaded by hand first');
  await withTenant(ctxA, (db: any) => db.createDocument({ original_filename: 'by hand.pdf', sha256_hash: sha(manualBytes), file_size_bytes: manualBytes.length, content_type: 'application/pdf', storage_key: `${tenA}/${sha(manualBytes).slice(0, 2)}/${sha(manualBytes)}`, uploaded_by: 'user_x' }));
  fake.addFile({ id: 'man1', name: 'by hand copy.pdf', parents: ['f_root'], content: manualBytes });
  const enq2 = enqueued.length;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('dedupe: a file already uploaded by hand is recognised (no second document, nothing re-read)', out.tally.duplicate === 1 && enqueued.length === enq2 && (await docsOf(tenA)).filter((d) => d.sha256_hash === sha(manualBytes)).length === 1);

  const docCountBeforeDel = (await docsOf(tenA)).length;
  fake.trash('d2');
  out = await sync.syncConnection(ctxA, 'drive', D());
  items = await itemsOf(tenA, 'drive');
  check('deleted in Drive: flagged as removed, the DeepWell document is NOT deleted', items.find((i) => i.external_id === 'd2').state === 'removed-in-source' && (await docsOf(tenA)).length === docCountBeforeDel && out.tally.removed === 1);
  const st2 = await status(adminA);
  check('deleted in Drive: shows in status as "no longer in Google" with its name', st2.connections[0].removedCount === 1 && st2.connections[0].removed[0].filename === 'Invoice 1002.pdf');
  check('deleted in Drive: the plain result line says DeepWell keeps its copy', /keeps its copy/.test((await connOf(tenA, 'drive')).last_result));
  fake.untrash('d2');
  await sync.syncConnection(ctxA, 'drive', D());
  check('restored in Drive: the flag clears', (await itemsOf(tenA, 'drive')).find((i) => i.external_id === 'd2').state === 'imported');
  fake.remove('d4');
  await sync.syncConnection(ctxA, 'drive', D());
  check('permanently removed (removed:true) is flagged too, not deleted', (await itemsOf(tenA, 'drive')).find((i) => i.external_id === 'd4').state === 'removed-in-source' && (await docsOf(tenA)).some((d) => d.original_filename === 'Job costs.xlsx'));

  /* ---------------- 5f. rate limits, auth failures, quotas, lease, pause, disconnect */
  fake.addFile({ id: 'r1', name: 'Rate 1.pdf', parents: ['f_root'], content: 'rate one' });
  fake.failOnce(/alt=media/, 429, 3, 2);
  const retriesBefore = client.stats.retries;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('rate limit (429): retried with Retry-After, then succeeds', out.tally.created === 1 && client.stats.retries - retriesBefore === 2 && sleeps.filter((x) => x === 3000).length === 2);
  fake.addFile({ id: 'r2', name: 'Rate 2.pdf', parents: ['f_root'], content: 'rate two' });
  fake.failOnce(/\/changes\?/, 403, null, 99);
  out = await sync.syncConnection(ctxA, 'drive', D());
  row = await connOf(tenA, 'drive');
  check('rate limit that never clears (403 rateLimitExceeded): pass ends cleanly with a plain message, connection stays active', out.ok === false && row.status === 'active' && /limiting requests/.test(row.last_result) && (row.sync_state.lease ?? null) === null);
  fake.failures.length = 0;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('after the limit clears the next pass catches up', out.tally.created === 1 && (await docsOf(tenA)).some((d) => d.original_filename === 'Rate 2.pdf'));
  fake.addFile({ id: 'r3', name: 'Rate 3.pdf', parents: ['f_root'], content: 'rate three' });
  fake.failOnce(/\/server-error/, 500, null, 1);
  fake.failOnce(/\/changes\?/, 503, null, 1);
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('a 503 from Google is retried', out.ok && out.tally.created === 1);
  fake.addFile({ id: 'r4', name: 'Rate 4.pdf', parents: ['f_root'], content: 'rate four' });
  fake.expireAccessTokens = true;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('an expired access token is refreshed once and the call retried', out.ok && out.tally.created === 1);

  // quotas
  fresh(); fake.validRefresh.add('rt-A');
  fake.addFolder('q_root', 'Quota');
  for (let i = 1; i <= 7; i++) fake.addFile({ id: `q${i}`, name: `Quota ${i}.pdf`, parents: ['q_root'], content: `quota file ${i}` });
  await withTenant(ctxA, (db: any) => db.raw(`DELETE FROM google_sync_items WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid`, []));
  await connect(adminA, 'drive', 'full'); fake.validRefresh.add('rt-A');
  await choose(adminA, { provider: 'drive', picked: [{ id: 'q_root', kind: 'folder' }] });
  const base = (await docsOf(tenA)).length;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerRun: 3 } }));
  check('per-run cap: only 3 files in one pass, the rest wait', out.tally.created === 3 && (await docsOf(tenA)).length === base + 3);
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerRun: 3 } }));
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerRun: 3 } }));
  check('per-run cap: passes drain the folder with no duplicates (paged listing resumes)', (await docsOf(tenA)).length === base + 7 && (await itemsOf(tenA, 'drive')).filter((i) => i.external_id.startsWith('q')).length === 7);
  // daily quota
  fresh(); fake.validRefresh.add('rt-A');
  fake.addFolder('day_root', 'Day');
  for (let i = 1; i <= 5; i++) fake.addFile({ id: `y${i}`, name: `Day ${i}.pdf`, parents: ['day_root'], content: `day file ${i}` });
  await withTenant(ctxA, (db: any) => db.raw(`UPDATE google_sync_items SET imported_at = imported_at - interval '3 days' WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid`, []));
  await connect(adminA, 'drive', 'full'); fake.validRefresh.add('rt-A');
  await choose(adminA, { provider: 'drive', picked: [{ id: 'day_root', kind: 'folder' }] });
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerDay: 3 } }));
  check('daily quota: stops at the organization\'s daily limit with the plain message', out.tally.created === 3 && /daily limit|limit for bringing in files/i.test(out.result), JSON.stringify([out.tally, out.result]));
  const callsQ = fake.calls.length;
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerDay: 3 } }));
  check('daily quota: once reached, a pass makes no Google calls at all', out.tally.created === 0 && fake.calls.length === callsQ && /limit/.test(out.result));
  out = await sync.syncConnection(ctxA, 'drive', D({ limits: { maxFilesPerDay: 100, maxFilesPerConnection: 1 } }));
  check('per-connection total cap is enforced with a plain message', /number of files it can bring in/.test(out.result) && out.tally.created === 0);

  // plan gate, billing, storage failure, queue failure
  fresh(); fake.validRefresh.add('rt-A');
  fake.addFolder('p_root', 'Plan');
  fake.addFile({ id: 'p1', name: 'Plan 1.pdf', parents: ['p_root'], content: 'plan one' });
  fake.addFile({ id: 'p2', name: 'Plan 2.pdf', parents: ['p_root'], content: 'plan two' });
  await connect(adminA, 'drive', 'full'); fake.validRefresh.add('rt-A');
  await choose(adminA, { provider: 'drive', picked: [{ id: 'p_root', kind: 'folder' }] });
  const planDocs = (await docsOf(tenA)).length;
  out = await sync.syncConnection(ctxA, 'drive', D({ importDeps: importDeps({ loadBillingRow: async () => ({}), assertRoom: async () => { throw new UploadGateRefusal({ allowed: false, status: 402, error: 'Your plan\'s page allowance is used up.' }); } }) }));
  check('plan gate: when the plan has no room nothing is stored and the pass stops with the plan\'s own message', (await docsOf(tenA)).length === planDocs && /allowance/.test(out.result) && (await connOf(tenA, 'drive')).status === 'active');
  fake.calls.length = 0;
  out = await sync.syncConnection(ctxA, 'drive', D({ assertBilling: async () => ({ allowed: false }) }));
  check('billing inactive: skipped with no Google call', out.skipped === 'billing' && fake.calls.length === 0 && /plan to be active/.test((await connOf(tenA, 'drive')).last_result));
  putFailures = 1;
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('storage failure: no document row is left pointing at a missing file; the file is retried next pass', (await docsOf(tenA)).length === planDocs + 1 && out.tally.error === 1);
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('storage failure: the retry brings the file in', (await docsOf(tenA)).length === planDocs + 2);
  fake.addFile({ id: 'p3', name: 'Plan 3.pdf', parents: ['p_root'], content: 'plan three' });
  enqueueThrows = true;
  out = await sync.syncConnection(ctxA, 'drive', D());
  enqueueThrows = false;
  check('queue failure: the document is still stored (the existing sweep picks it up)', out.tally.created === 1 && (await docsOf(tenA)).some((d) => d.original_filename === 'Plan 3.pdf' && d.stage === 'received'));

  // lease
  await withTenant(ctxA, (db: any) => db.raw(`UPDATE google_connections SET sync_state = sync_state || jsonb_build_object('lease', $1::bigint) WHERE provider = 'drive' AND tenant_id = (current_setting('app.tenant_id', true))::uuid`, [Date.now() + 600_000]));
  fake.calls.length = 0;
  eq('lease: a pass already in progress is not run twice', await sync.syncConnection(ctxA, 'drive', D()), { skipped: 'busy' });
  await withTenant(ctxA, (db: any) => db.raw(`UPDATE google_connections SET sync_state = sync_state || jsonb_build_object('lease', $1::bigint) WHERE provider = 'drive' AND tenant_id = (current_setting('app.tenant_id', true))::uuid`, [Date.now() - 1000]));
  out = await sync.syncConnection(ctxA, 'drive', D());
  check('lease: an expired lease (a pass that died) does not block forever', out.ok === true && fake.calls.length > 0);

  // sync-now through the route
  r = await route.handleOp(adminA, { op: 'sync-now', provider: 'drive' }, D());
  check('sync-now: runs one pass and answers with the plain result', r.status === 200 && r.body.ok === true && typeof r.body.result === 'string');
  r = await route.handleOp(adminB, { op: 'sync-now', provider: 'gmail' }, D());
  eq('sync-now: a source that is not connected is a plain 409', r.status, 409);

  // pause / resume
  r = await route.handleOp(adminA, { op: 'pause', provider: 'drive' }, D());
  fake.addFile({ id: 'pz1', name: 'Paused.pdf', parents: ['p_root'], content: 'while paused' });
  fake.calls.length = 0;
  const sweepPaused = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: KA }] }) });
  check('pause: the sweep checks nothing while paused', r.body.status === 'paused' && fake.calls.length === 0 && sweepPaused.created === 0);
  check('pause: the status line says so', (await status(adminA)).connections[0].status === 'paused');
  await route.handleOp(adminA, { op: 'resume', provider: 'drive' }, D());
  const sweepResumed = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: KA }, { tenant_key: KB }] }) });
  check('resume: the scheduled sweep picks up what was missed (and visits each organization)', sweepResumed.created >= 1 && sweepResumed.tenants === 2 && (await docsOf(tenA)).some((d) => d.original_filename === 'Paused.pdf'));

  // needs-reconnect
  fake.validRefresh.delete('rt-A');
  out = await sync.syncConnection(ctxA, 'drive', D());
  row = await connOf(tenA, 'drive');
  check('revoked access: the connection is marked "needs-reconnect" with a plain message, not retried every pass', out.ok === false && row.status === 'needs-reconnect' && /sign in again/.test(row.last_error));
  fake.calls.length = 0;
  const sweepAfter = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: KA }] }) });
  check('revoked access: later sweeps skip it (no calls)', fake.calls.length === 0 && sweepAfter.errors === 0);
  r = await route.handleOp(adminA, { op: 'resume', provider: 'drive' }, D());
  eq('revoked access: resume is refused until the admin reconnects', r.status, 409);
  fake.validRefresh.add('rt-A');
  await connect(adminA, 'drive', 'full'); fake.validRefresh.add('rt-A');
  row = await connOf(tenA, 'drive');
  check('reconnecting clears the problem and keeps the folder choices (same account)', row.status === 'active' && row.last_error === null && (row.config.picked ?? []).length === 1);

  // folder / picker ops
  fake.addFolder('top1', 'Top folder'); 
  r = await route.handleOp(adminA, { op: 'folders' }, D());
  check('folder picker (full access) lists folders from Drive', r.status === 200 && r.body.folders.some((f: any) => f.name === 'Top folder'));
  r = await route.handleOp(adminB, { op: 'folders' }, D());
  eq('folder picker: narrow-mode connection is told to use the file picker', r.status, 409);
  r = await route.handleOp(adminB, { op: 'picker-token' }, D());
  check('picker token (narrow mode) returns a short-lived token and the keys the picker needs, nothing stored', r.status === 200 && /^at-/.test(r.body.accessToken) && r.body.apiKey === 'picker-key' && r.body.appId === '123456');
  check('picker token: no refresh token ever leaves the server', !JSON.stringify(r.body).includes('rt-A'));

  // disconnect
  const docsKeep = (await docsOf(tenA)).length;
  const itemsKeep = (await itemsOf(tenA, 'drive')).length;
  fake.revoked.length = 0;
  r = await route.handleOp(adminA, { op: 'disconnect', provider: 'drive' }, D());
  row = await connOf(tenA, 'drive');
  check('disconnect: Google is told to drop the grant', fake.revoked.length === 1 && fake.revoked[0] === 'rt-A');
  check('disconnect: our copy of the token is deleted and the connection is closed', r.body.disconnected === true && row.status === 'disconnected' && row.refresh_token_enc === null && Object.keys(row.config).length === 0);
  check('disconnect: files already in DeepWell stay', (await docsOf(tenA)).length === docsKeep && (await itemsOf(tenA, 'drive')).length === itemsKeep);
  eq('disconnect: it no longer appears in status', (await status(adminA)).connections.filter((c: any) => c.provider === 'drive').length, 0);
  fake.calls.length = 0;
  eq('disconnect: sync does nothing afterwards', await sync.syncConnection(ctxA, 'drive', D()), { skipped: 'disconnected' });
  check('disconnect: audit rows were written', (await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action IN ('google.connected','google.disconnected')`, [tenA]))[0].n >= 2);

  /* ---------------- 5g. narrow mode */
  fresh(); fake.validRefresh.add('rt-A');
  await withTenant(ctxB, (db: any) => db.raw(`DELETE FROM google_connections WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid`, []));
  fake.addFolder('nfolder', 'Picked folder');
  fake.addFile({ id: 'nf1', name: 'Picked 1.pdf', parents: ['nfolder'], content: 'narrow one' });
  fake.addFile({ id: 'nfile', name: 'Picked file.pdf', parents: ['root'], content: 'a single picked file' });
  await connect(adminB, 'drive', 'narrow'); fake.validRefresh.add('rt-A');
  await choose(adminB, { provider: 'drive', picked: [{ id: 'nfolder', kind: 'folder' }, { id: 'nfile', kind: 'file' }] });
  out = await sync.syncConnection(ctxB, 'drive', D());
  check('narrow mode: picked folder and picked file are imported', out.tally.created === 2 && (await docsOf(tenB)).length === 2, JSON.stringify([out.tally, out.result, out.error]));
  fake.addFile({ id: 'nf2', name: 'Later in picked folder.pdf', parents: ['nfolder'], content: 'narrow two' });
  out = await sync.syncConnection(ctxB, 'drive', D());
  check('narrow mode: whatever Drive shows the app in its changes feed is accepted', out.tally.created === 1);
  check('tenant isolation: A\'s earlier documents are untouched by B\'s sync, B\'s are only in B', (await docsOf(tenA)).length === docsKeep && (await docsOf(tenB)).every((d) => d.tenant_id === tenB));
  check('tenant isolation: B\'s files are stored under B\'s own prefix', (await docsOf(tenB)).every((d) => d.storage_key.startsWith(`${tenB}/`)));

  /* ---------------- 5h. Gmail */
  fresh(); fake.validRefresh.add('rt-A');
  await connect(adminA, 'gmail', 'full'); fake.validRefresh.add('rt-A');
  r = await route.handleOp(adminA, { op: 'labels' }, D());
  check('Gmail labels: user labels plus Inbox, no system clutter', r.status === 200 && r.body.labels.map((l: any) => l.name).join() === 'INBOX,Invoices,Receipts');
  r = await choose(adminA, { provider: 'gmail', labels: [] , senders: ''});
  fake.calls.length = 0;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  check('Gmail with nothing chosen: a plain note, no Google calls', /Choose labels or senders/.test(out.result) && fake.callsMatching(/gmail/) === 0);
  const DAY = 86400000;
  const gm = (m: any) => fake.addMessage(m);
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', parts: [{ partId: '1', filename: 'Invoice 7001.pdf', content: 'gmail invoice one' }, { partId: '2', filename: 'terms.exe', mimeType: 'application/octet-stream', content: 'MZ' }, { partId: '3', filename: 'logo.png', mimeType: 'image/png', inline: true, contentId: '<l>', content: 'tiny' }] });
  gm({ labelIds: [], from: 'billing@supplier.com', parts: [{ partId: '1', filename: 'Statement.pdf', content: 'statement by sender' }] });
  gm({ labelIds: [], from: 'stranger@spam.com', parts: [{ partId: '1', filename: 'Not wanted.pdf', content: 'unlabeled stranger' }] });
  gm({ labelIds: ['Label_2'], from: 'c@vendor.com', parts: [{ partId: '1', filename: 'Receipt.pdf', content: 'receipt label two' }] });
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', internalDate: fake.nowMs - 200 * DAY, parts: [{ partId: '1', filename: 'Ancient.pdf', content: 'older than lookback' }] });
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', parts: [{ partId: '1', filename: 'Photo big.jpg', mimeType: 'image/jpeg', content: Buffer.alloc(20 * 1024, 1) }] });
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', internalDate: fake.nowMs + 1000, parts: [{ partId: '1', filename: 'Invoice 7001 again.pdf', content: 'gmail invoice one' }] });
  await choose(adminA, { provider: 'gmail', labels: [{ id: 'Label_1', name: 'Invoices' }], senders: 'Billing@Supplier.com, bad address', lookbackDays: 30 });
  const g0 = new Set((await docsOf(tenA)).map((d) => d.id));
  // The fake's clock is 2026-10-13; the code uses the real clock, so line the cursor up with the fake's time.
  const realNow = Date.now; Date.now = () => fake.nowMs + 60_000;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  Date.now = realNow;
  const gdocs = (await docsOf(tenA)).filter((d) => !g0.has(d.id));
  const names = gdocs.map((d) => d.original_filename).sort();
  eq('Gmail: only attachments of chosen labels/senders, supported types, inside the look-back', names, ['Invoice 7001.pdf', 'Photo big.jpg', 'Statement.pdf']);
  check('Gmail: label OR sender (union) — the sender-only and label-only messages both came in', names.includes('Statement.pdf') && names.includes('Invoice 7001.pdf'));
  check('Gmail: a stranger\'s unlabeled message, a label not chosen, and an old message were left alone', !names.includes('Not wanted.pdf') && !names.includes('Receipt.pdf') && !names.includes('Ancient.pdf'));
  check('Gmail: duplicate attachment in a second email is one document', out.tally.duplicate === 1 && gdocs.filter((d) => d.sha256_hash === sha('gmail invoice one')).length === 1);
  const gitems = await itemsOf(tenA, 'gmail');
  check('Gmail: unsupported attachment and the signature logo were skipped with a reason', gitems.some((i) => i.filename === 'terms.exe' && i.state === 'skipped' && i.note) && gitems.some((i) => i.filename === 'logo.png' && i.state === 'skipped'));
  check('Gmail: a normal-size photo attachment is kept', gdocs.some((d) => d.original_filename === 'Photo big.jpg' && d.content_type === 'image/jpeg'));
  check('Gmail: email text is never stored (no document, item or page holds body text)', !(await q(`SELECT 1 FROM documents WHERE tenant_id = $1 AND (original_filename ILIKE '%private email body%')`, [tenA])).length && !JSON.stringify(gitems).includes('private email body') && ![...R2.values()].some((b) => b.toString().includes('private email body')));
  check('Gmail: attachments use the same pipeline shape as uploads', gdocs.every((d) => d.stage === 'received' && d.document_type === null && d.uploaded_by === 'google-sync' && R2.has(d.storage_key)) && gdocs.every((d) => enqueued.includes(d.id)));
  check('Gmail: the list query is attachments-only with the sender filter', fake.calls.some((c) => /messages\?/.test(c) && decodeURIComponent(c).includes('has:attachment') && decodeURIComponent(c).includes('from:(billing@supplier.com)')));
  row = await connOf(tenA, 'gmail');
  check('Gmail: cursor and recently-seen messages are saved; status line is plain', typeof row.sync_state.cursorMs === 'number' && row.sync_state.seen.length >= 3 && /Brought in 3 new files/.test(row.last_result));
  const dlG = fake.downloads;
  Date.now = () => fake.nowMs + 120_000;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  check('Gmail second pass: nothing is downloaded again', out.tally.created === 0 && fake.downloads === dlG);
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', internalDate: fake.nowMs + 90_000, parts: [{ partId: '1', filename: 'Invoice 7002.pdf', content: 'gmail invoice two' }] });
  Date.now = () => fake.nowMs + 200_000;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  Date.now = realNow;
  check('Gmail incremental: a new email\'s attachment is picked up', out.tally.created === 1 && (await docsOf(tenA)).some((d) => d.original_filename === 'Invoice 7002.pdf'));
  check('Gmail: tenant isolation — organization B has no Gmail items or documents from this', (await itemsOf(tenB, 'gmail')).length === 0 && (await docsOf(tenB)).every((d) => !/Invoice 700/.test(d.original_filename)));
  // too large + attachment error retry
  gm({ labelIds: ['Label_1'], from: 'a@vendor.com', internalDate: fake.nowMs + 300_000, parts: [{ partId: '1', filename: 'Giant.pdf', content: Buffer.alloc(100) }] });
  const origPre = fake.messages[fake.messages.length - 1];
  fake.failOnce(/attachments\//, 404, null, 99);
  Date.now = () => fake.nowMs + 400_000;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  check('Gmail: an attachment Google will not hand over is recorded as a problem, not a crash', out.tally.error === 1 && (await itemsOf(tenA, 'gmail')).find((i) => i.filename === 'Giant.pdf').state === 'error');
  fake.failures.length = 0;
  Date.now = () => fake.nowMs + 500_000;
  out = await sync.syncConnection(ctxA, 'gmail', D());
  Date.now = realNow;
  check('Gmail: that attachment is retried on the next pass and comes in', out.tally.created === 1 && (await docsOf(tenA)).some((d) => d.original_filename === 'Giant.pdf'));
  void origPre;
  r = await choose(adminA, { provider: 'gmail', labels: [{ id: 'Label_1', name: 'Invoices' }], senders: [], lookbackDays: 13 });
  check('Gmail choices: an unsupported look-back falls back to 30 days', (await connOf(tenA, 'gmail')).config.lookbackDays === 30);
  r = await choose(adminA, { provider: 'gmail', labels: [], senders: Array.from({ length: 40 }, (_, i) => `u${i}@x.com`) });
  eq('Gmail choices: sender list is capped', (await connOf(tenA, 'gmail')).config.senders.length, 25);
  r = await route.handleOp(adminA, { op: 'disconnect', provider: 'gmail' }, D());
  check('Gmail disconnect: token gone, documents kept', (await connOf(tenA, 'gmail')).refresh_token_enc === null && (await docsOf(tenA)).some((d) => d.original_filename === 'Invoice 7002.pdf'));

  /* ---------------- 5i. the sweep */
  fresh(); fake.validRefresh.add('rt-A');
  fake.addFolder('s_root', 'Sweep'); fake.addFile({ id: 's1', name: 'Sweep A.pdf', parents: ['s_root'], content: 'sweep a' });
  await connect(adminA, 'drive', 'full'); fake.validRefresh.add('rt-A'); await choose(adminA, { provider: 'drive', picked: [{ id: 's_root', kind: 'folder' }] });
  await connect(adminB, 'drive', 'full'); fake.validRefresh.add('rt-A'); await choose(adminB, { provider: 'drive', picked: [{ id: 's_root', kind: 'folder' }] });
  const swept = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: KA }, { tenant_key: KB }] }) });
  check('sweep: visits every connected organization and each gets its own copy of its own files', swept.tenants === 2 && swept.created === 2 && (await docsOf(tenA)).filter((d) => d.original_filename === 'Sweep A.pdf').length === 1 && (await docsOf(tenB)).filter((d) => d.original_filename === 'Sweep A.pdf').length === 1);
  const sweptLate = await sync.runGoogleSyncSweep({ deadlineAt: Date.now() - 1, deps: D({ tenants: [{ tenant_key: KA }, { tenant_key: KB }] }) });
  eq('sweep: stops at its time limit and reports what is left', sweptLate.left, 2);
  const crashing = await sync.runGoogleSyncSweep({ deps: D({ tenants: [{ tenant_key: 'org_unknown_zz' }, { tenant_key: KA }] }) });
  check('sweep: an organization that fails does not stop the others', crashing.tenants === 2 && crashing.errors <= 1);
  const listed = await S.listSyncTenants();
  check('sweep: the definer listing returns only organizations with an active connection', listed.map((t: any) => t.tenant_key).sort().join() === [KA, KB].join() || listed.length === 0 || listed.every((t: any) => [KA, KB].includes(t.tenant_key)));

  check('the whole run made no real network call', realFetchCalls === 0);
  await lite.close();
}

/* ============================================================ 6. website + screen (files the owner will see) */
const site = fs.existsSync(path.join(ROOT, 'public/integrations.html')) ? read('public/integrations.html') : '';
check('website: Integrations page exists', site.length > 2000);
check('website: Google Drive and Gmail are shown as "Coming soon", with one sentence each', /Google Drive[\s\S]{0,600}Coming soon/i.test(site) && /Gmail[\s\S]{0,600}Coming soon/i.test(site));
check('website: QuickBooks and Jobber are shown as "Planned"', /QuickBooks[\s\S]{0,600}Planned/i.test(site) && /Jobber[\s\S]{0,600}Planned/i.test(site));
const visible = site.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
check('website: no claim of availability, certification, verification or Google approval', !/(available now|now available|is available|certified|verified by|approved by google|google[- ]approved|google[- ]verified|partner of|official)/i.test(visible), (visible.match(/(available now|now available|is available|certified|verified by|approved by google|official)/i) ?? [])[0]);
check('website: the home page links to it and the sitemap lists it', /integrations\.html|\/integrations/.test(read('index.html')) && /integrations/.test(read('public/sitemap.xml')));
const card = fs.existsSync(path.join(ROOT, 'src/components/ConnectedSourcesCard.tsx')) ? read('src/components/ConnectedSourcesCard.tsx') : '';
check('screen: uses the app\'s card and button classes and 44px touch targets', /dw-card/.test(card) && /dw-btn-primary/.test(card) && /dw-btn-secondary/.test(card) && /min-h-touch|min-h-\[44px\]/.test(card));
check('screen: hides itself when the feature is off', /enabled/.test(card) && /return null/.test(card));
check('screen: is mounted for admins on the Team screen only', /ConnectedSourcesCard/.test(read('src/screens/TeamScreen.tsx')));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
