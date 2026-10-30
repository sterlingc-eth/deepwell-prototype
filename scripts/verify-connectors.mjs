// node scripts/verify-connectors.mjs
// Stub-provider checks for api/_lib/connectors: no network, no database, no real credentials. Exit 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ': ' + d : ''}`); } };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
console.log('verify:connectors');
globalThis.fetch = async () => { throw new Error('real network call attempted in a test'); };

const KEY = Buffer.alloc(32, 9).toString('base64');
const ENV = { DEEPWELL_CONNECTORS: '1', DEEPWELL_CONNECTOR_GDRIVE: '1', DEEPWELL_CONNECTOR_DROPBOX: '1', DEEPWELL_CONNECTOR_ONEDRIVE: '1', DEEPWELL_CONNECTOR_EMAILIN: '1',
  CONNECTORS_TOKEN_KEY: KEY, GOOGLE_TOKEN_KEY: KEY, EMAILIN_DOMAIN: 'in.example.test', EMAILIN_ADDRESS_KEY: 'k'.repeat(32), EMAILIN_WEBHOOK_SECRET: 'whsec_' + Buffer.from('s'.repeat(24)).toString('base64'),
  DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REDIRECT_URI: 'https://x.test/cb', MS_GRAPH_CLIENT_ID: 'c', MS_GRAPH_CLIENT_SECRET: 's', MS_GRAPH_REDIRECT_URI: 'https://x.test/cb', MS_GRAPH_CLIENT_STATE: 'st',
  RESEND_API_KEY: 'r', GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 'g', GOOGLE_OAUTH_REDIRECT_URI: 'https://x.test/g' };

// ---- structure rules (APP_APPLY)
const apiTop = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
eq('api/ has exactly 12 top-level files', apiTop.length, 12);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isSymbolicLink() ? [d + '/' + e.name + ' (symlink)'] : e.isDirectory() ? walk(path.join(d, e.name)) : []);
eq('no symlinks under connectors/', walk(path.join(ROOT, 'api/_lib/connectors')), []);
const src = walk; void src;
const allSrc = fs.readdirSync(path.join(ROOT, 'api/_lib/connectors'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib/connectors', f), 'utf8')).join('\n');
check('no TODO/FIXME/XXX markers', !/\b(TODO|FIXME|XXX)\b/.test(allSrc));
check('no secret-looking literals', !/(sk_live|AKIA[0-9A-Z]{12}|-----BEGIN)/.test(allSrc));

const cfg = await imp('api/_lib/connectors/config.js');
const C = await imp('api/_lib/connectors/contract.js');
const core = await imp('api/_lib/connectors/core.js');
const { createMemoryStore } = await imp('api/_lib/connectors/memoryStore.js');
const map = await imp('api/_lib/connectors/mapping.js');
const sec = await imp('api/_lib/connectors/secrets.js');

// ---- flags
check('master flag unset -> disabled', !cfg.isConnectorsEnabled({}));
check('provider flag needs master', !cfg.isProviderEnabled('dropbox', { DEEPWELL_CONNECTOR_DROPBOX: '1' }));
eq('all four providers on with flags', cfg.enabledProviders(ENV), ['gdrive', 'dropbox', 'onedrive', 'emailin']);
eq('default (nothing set) -> none enabled', cfg.enabledProviders({}), []);
eq('missingEnv lists names only', cfg.missingEnv('dropbox', {}).includes('DROPBOX_APP_KEY'), true);

// ---- secrets
const enc = sec.sealSecrets('dropbox', 'tenantA', { refreshToken: 'r1' }, ENV);
check('secret is not stored in the clear', !enc.includes('r1') && enc.startsWith('v1.'));
eq('secret round-trips', sec.openSecrets('dropbox', 'tenantA', enc, ENV), { refreshToken: 'r1' });
let crossOk = false; try { sec.openSecrets('dropbox', 'tenantB', enc, ENV); } catch { crossOk = true; }
check('another tenant cannot open it (AAD)', crossOk);

// ---- mapping
eq('mapping rule match', map.targetFolder({ rules: [{ match: 'invoice', folder: 'Invoices' }], defaultFolder: 'Inbox' }, { name: 'Acme Invoice 4.pdf' }), 'Invoices');
eq('mapping default', map.targetFolder({ defaultFolder: 'Inbox' }, { name: 'x.pdf' }), 'Inbox');
eq('mapping none', map.targetFolder({}, { name: 'x.pdf' }), null);

// ---- stub provider + core
const importerFor = (docs, calls) => ({
  precheck: ({ filename, contentType }) => /\.(pdf|txt|png)$/i.test(filename) ? { ok: true, filename, contentType: contentType || 'application/octet-stream' } : { ok: false, note: 'Not a supported file type' },
  importOne: async (_c, f) => { calls.push(f); const sha = C.sha256Hex(f.bytes); if (docs.has(sha)) return { outcome: 'duplicate', documentId: docs.get(sha), sha256: sha }; const id = 'doc' + (docs.size + 1); docs.set(sha, id); return { outcome: 'created', documentId: id, sha256: sha }; },
});
function stubAdapter(script) {
  const state = { downloads: 0, refreshes: 0, authFailOnce: false, pages: script };
  return Object.assign(state, {
    descriptor: { id: 'stub', label: 'Stub', authKind: 'oauth', folderIdentity: 'id', pushKind: 'none', maxFileBytes: 1e6 },
    beginLink: () => ({ url: 'https://stub.test/auth' }), completeLink: async () => ({ accountRef: 'acct', secrets: { refreshToken: 'r' } }),
    listFolders: async () => [], revoke: async () => {},
    async listChanges(conn, folder, cursor) {
      if (state.authFailOnce) { state.authFailOnce = false; throw new C.AuthLostError(); }
      if (state.hardAuthFail) throw new C.AuthLostError();
      const i = cursor?.i ?? 0; const page = state.pages[i] ?? { items: [] };
      return { items: page.items, nextCursor: { i: i + 1 }, hasMore: i + 1 < state.pages.length && !page.stop };
    },
    async download(conn, item) { state.downloads++; if (item.fail) throw new Error('boom'); if (item.big) throw new C.TooLargeError(); return Buffer.from(item.content ?? item.ref); },
    async refreshSecrets() { state.refreshes++; if (state.hardAuthFail) throw new C.AuthLostError(); return { secrets: { refreshToken: 'r2' } }; },
  });
}
const it = (ref, name, o = {}) => ({ ref, name, mime: 'application/pdf', size: 10, changeMarker: o.marker ?? 'm1', ...o });
async function run(adapter, { store = createMemoryStore(), docs = new Map(), calls = [], link, allowed = true, limits } = {}) {
  const l = link ?? store.addLink({ provider: 'gdrive', account_ref: 'acct', folder_ref: 'F', folder_name: 'Docs', secrets_enc: sec.sealSecrets('gdrive', 'T', { refreshToken: 'r' }, ENV), mapping: { rules: [{ match: 'invoice', folder: 'Invoices' }] } });
  const deps = { store, importer: importerFor(docs, calls), adapter, env: ENV, limits: { ...cfg.limits(ENV), ...(limits ?? {}) }, now: () => 1_000_000,
    openSecrets: (x) => sec.openSecrets('gdrive', 'T', x.secrets_enc, ENV), sealSecrets: (s) => sec.sealSecrets('gdrive', 'T', s, ENV), allowance: async () => ({ allowed }) };
  const res = await core.runSync({ tenantKey: 'T', tenantId: 'T' }, store._links.get(l.id), deps);
  return { res, store, docs, calls, link: l };
}
const A = stubAdapter([{ items: [it('1', 'Invoice A.pdf', { content: 'AAA', providerHash: 'h1', providerHashKind: 'stub' }), it('2', 'notes.txt', { content: 'BBB' }), it('3', 'virus.exe')] }, { items: [it('4', 'Copy of A.pdf', { content: 'AAA', providerHash: 'h1', providerHashKind: 'stub' }), it('5', 'big.pdf', { big: true })] }]);
assertAdapterOk(A);
function assertAdapterOk(a) { let ok = true; try { C.assertAdapter(a); } catch (e) { ok = false; } check('stub satisfies the interface', ok); }
let r = await run(A);
eq('first pass tally', [r.res.tally.created, r.res.tally.duplicate, r.res.tally.skipped], [2, 1, 2]);
eq('two documents, identical bytes deduped', r.docs.size, 2);
eq('provider-hash twin skipped the download', A.downloads, 2 + 1 /* big.pdf attempted */ );
eq('folder mapping reached the importer', r.calls.find((c) => c.filename === 'Invoice A.pdf').folderHint, 'Invoices');
eq('cursor saved after clean pages', r.store._links.get(r.link.id).cursor, { i: 2 });
check('lease released', r.store._links.get(r.link.id).lease_until === null);
check('message has no cost or token text', !/\$|token|usd/i.test(r.res.message));
// second pass: unchanged -> no downloads, nothing created; removal flagged; new marker re-imports as new bytes
const B = stubAdapter([{ items: [it('1', 'Invoice A.pdf', { content: 'AAA' }), it('2', 'notes.txt', { content: 'BBB2', marker: 'm2' }), { ref: '4', removed: true, name: '', changeMarker: 'removed' }] }]);
r.store._links.get(r.link.id).cursor = {};
r = await run(B, { store: r.store, docs: r.docs, calls: r.calls, link: r.link });
eq('unchanged skipped, changed re-imported, removal flagged', [r.res.tally.unchanged, r.res.tally.created, r.res.tally.removed], [1, 1, 1]);
eq('removed item keeps its copy (state flag only)', r.store._items.get(`${r.link.id}|4`).state, 'removed-in-source');
// busy lease
const store2 = createMemoryStore(); const l2 = store2.addLink({ provider: 'gdrive', account_ref: 'a', folder_ref: 'F', secrets_enc: sec.sealSecrets('gdrive', 'T', {}, ENV), lease_until: 9_999_999 });
r = await run(stubAdapter([{ items: [] }]), { store: store2, link: l2 });
eq('overlapping pass is refused', r.res.skipped, 'busy');
// allowance gate
r = await run(stubAdapter([{ items: [it('9', 'z.pdf')] }]), { allowed: false });
eq('allowance used -> nothing imported', [r.res.skipped, r.calls.length], ['allowance', 0]);
// token refresh then success, and rotation stored
const R = stubAdapter([{ items: [it('7', 'r.pdf', { content: 'R' })] }]); R.authFailOnce = true;
r = await run(R);
eq('auth error -> refresh -> retry succeeds', [R.refreshes, r.res.tally.created], [1, 1]);
check('rotated secret stored encrypted before use', sec.openSecrets('gdrive', 'T', r.store._links.get(r.link.id).secrets_enc, ENV).refreshToken === 'r2');
// revoked
const D = stubAdapter([{ items: [] }]); D.hardAuthFail = true;
r = await run(D);
eq('revoked token -> access-lost', r.res.status, 'access-lost');
// rate limit
const RL = stubAdapter([{ items: [] }]); RL.listChanges = async () => { throw new C.RateLimitedError('x', 5000); };
r = await run(RL);
check('429 -> friendly wait message, link stays active', r.res.status === 'active' && /limiting/.test(r.res.message));
// error page does not advance cursor
const E = stubAdapter([{ items: [it('e1', 'e.pdf', { fail: true })] }, { items: [it('e2', 'f.pdf')] }]);
r = await run(E);
eq('download error holds the cursor (retry next pass)', [r.res.tally.error, r.store._links.get(r.link.id).cursor], [1, {}]);
// per-pass cap
const cap = stubAdapter([{ items: [it('c1', 'a.pdf', { content: '1' }), it('c2', 'b.pdf', { content: '2' }), it('c3', 'c.pdf', { content: '3' })] }]);
r = await run(cap, { limits: { maxFilesPerPass: 2 } });
eq('per-pass file cap defers the rest', [r.res.tally.created, r.res.tally.deferred], [2, 1]);

// ---- real adapters against fake HTTP
const jres = (o, h = {}) => ({ ok: true, status: 200, headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => o });
const bres = (b) => ({ ok: true, status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b });
const dbx = (await imp('api/_lib/connectors/adapters/dropbox.js')).createDropboxAdapter();
C.assertAdapter(dbx);
const dbxCalls = [];
const dbxFetch = async (url, init) => {
  dbxCalls.push(url);
  if (url.endsWith('/list_folder')) return jres({ entries: [{ '.tag': 'file', name: 'A.pdf', path_lower: '/docs/a.pdf', path_display: '/Docs/Invoices/A.pdf', size: 3, rev: 'r1', content_hash: 'ch1' }, { '.tag': 'folder', name: 'Sub', path_lower: '/docs/sub' }, { '.tag': 'deleted', name: 'Old.pdf', path_lower: '/docs/old.pdf' }], cursor: 'C1', has_more: true });
  if (url.endsWith('/list_folder/continue')) return jres({ entries: [], cursor: 'C2', has_more: false });
  if (url.includes('/files/download')) { check('dropbox download sends path arg', JSON.parse(init.headers['Dropbox-API-Arg']).path === '/docs/a.pdf'); return bres(Buffer.from('PDF')); }
  if (url.endsWith('/oauth2/token')) return jres({ access_token: 'new', expires_in: 100 });
  throw new Error('unexpected ' + url);
};
const dconn = { secrets: { accessToken: 'x', refreshToken: 'y' }, fetchImpl: dbxFetch, env: ENV };
let pg = await dbx.listChanges(dconn, { ref: '/docs' }, null);
eq('dropbox first page maps file/folder/deleted', [pg.items[0].ref, pg.items[0].providerHashKind, pg.items[1].isFolder, pg.items[2].removed, pg.hasMore], ['/docs/a.pdf', 'dropbox_content_hash', true, true, true]);
pg = await dbx.listChanges(dconn, { ref: '/docs' }, pg.nextCursor);
check('dropbox continues from saved cursor', dbxCalls.at(-1).endsWith('/list_folder/continue') && pg.nextCursor.cursor === 'C2');
eq('dropbox download bytes', (await dbx.download(dconn, pg.items[0] ?? { ref: '/docs/a.pdf' }, 100)).toString(), 'PDF');
eq('dropbox refresh keeps refresh token', (await dbx.refreshSecrets(dconn)).secrets.refreshToken, 'y');
const body = '{"list_folder":{"accounts":["dbid:1"]}}';
const sig = createHmac('sha256', 's').update(body).digest('hex');
check('dropbox webhook signature ok / bad', dbx.verifyPush({ headers: { 'x-dropbox-signature': sig }, rawBody: body }, ENV) && !dbx.verifyPush({ headers: { 'x-dropbox-signature': 'x'.repeat(64) }, rawBody: body }, ENV));
check('dropbox content_hash of empty input is the SHA-256 of nothing-blocks', C.dropboxContentHash(Buffer.alloc(0)).length === 64);
// 401 -> AuthLostError; 429 -> retry then ok
let n = 0; const f429 = async () => (n++ < 1 ? { ok: false, status: 429, headers: { get: () => '0' } } : jres({ ok: 1 }));
eq('429 honoured then success', (await C.httpJson({ secrets: { accessToken: 't' }, fetchImpl: f429 }, 'https://x', {}, { sleep: async () => {} })).ok, 1);
let lost = false; try { await C.httpJson({ secrets: {}, fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null } }) }, 'https://x'); } catch (e) { lost = e instanceof C.AuthLostError; }
check('401 -> AuthLostError', lost);

const od = (await imp('api/_lib/connectors/adapters/onedrive.js')).createOnedriveAdapter();
C.assertAdapter(od);
const odFetch = async (url) => {
  if (url.includes('/root/delta?token=latest')) return jres({ '@odata.deltaLink': 'https://graph/delta?t=1' });
  if (url.includes('/items/FOLD/children')) return jres({ value: [{ id: 'f1', name: 'a.pdf', size: 3, file: { hashes: { quickXorHash: 'qx' } }, cTag: 'c1', parentReference: { driveId: 'D' } }, { id: 'sub', name: 'S', folder: { childCount: 1 } }] });
  if (url.includes('/items/sub/children')) return jres({ value: [{ id: 'f2', name: 'b.pdf', size: 3, file: {}, cTag: 'c2', parentReference: { driveId: 'D' } }] });
  if (url === 'https://graph/delta?t=1') return jres({ value: [{ id: 'f3', name: 'in.pdf', file: {}, cTag: 'c3', parentReference: { id: 'sub', driveId: 'D' } }, { id: 'x9', name: 'out.pdf', file: {}, cTag: 'c9', parentReference: { id: 'ELSEWHERE', driveId: 'D' } }, { id: 'f1', deleted: {} }], '@odata.deltaLink': 'https://graph/delta?t=2' });
  if (url.includes('/items/ELSEWHERE')) return jres({ id: 'ELSEWHERE', parentReference: { id: 'root2' } });
  if (url.includes('/items/root2')) return jres({ id: 'root2', parentReference: {} });
  if (url.includes('/content')) return bres(Buffer.from('X'));
  throw new Error('unexpected ' + url);
};
const oc = { secrets: { accessToken: 'a' }, fetchImpl: odFetch, env: ENV };
const seen = []; let cur = null, more = true, guard = 0;
while (more && guard++ < 10) { const p = await od.listChanges(oc, { ref: 'D/FOLD' }, cur); seen.push(...p.items); cur = p.nextCursor; more = p.hasMore; }
eq('onedrive walk finds nested files', seen.filter((i) => !i.isFolder).map((i) => i.ref), ['f1', 'f2']);
eq('onedrive hash kind recorded as pre-check only', seen[0].providerHashKind, 'ms_quickXorHash');
eq('onedrive cursor switched to delta', cur.phase, 'delta');
const dp = await od.listChanges(oc, { ref: 'D/FOLD' }, cur);
eq('onedrive delta keeps subtree files, drops outside, reports delete', dp.items.map((i) => i.ref + (i.removed ? '-' : '')), ['f3', 'f1-']);
eq('onedrive download path uses drive id', (await od.download(oc, { ref: 'f3', driveId: 'D' }, 100)).toString(), 'X');

const gd = await imp('api/_lib/connectors/adapters/gdrive.js');
const fakeClient = { refreshAccessToken: async () => 'tok', revoke: async () => true, session: () => ({
  startPageToken: async () => 'PT0',
  listChildren: async (id, pt) => id === 'ROOT' ? { files: [{ id: 'g1', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: 't' }, { id: 'sf', name: 'S', mimeType: 'application/vnd.google-apps.folder' }] } : { files: [{ id: 'g2', name: 'b.pdf', mimeType: 'application/pdf', md5Checksum: 'm', size: '3' }] },
  listChanges: async () => ({ changes: [{ fileId: 'g3', file: { id: 'g3', name: 'c.pdf', mimeType: 'application/pdf', parents: ['sf'] } }, { fileId: 'gx', file: { id: 'gx', name: 'out.pdf', mimeType: 'application/pdf', parents: ['other'] } }, { fileId: 'g1', removed: true }], newStartPageToken: 'PT1' }),
  getFile: async (id) => id === 'sf' ? { id: 'sf', parents: ['ROOT'] } : { id, parents: ['top'] },
  download: async () => Buffer.from('G'), exportFile: async () => Buffer.from('E') }) };
const gad = gd.createGdriveAdapter({ clientFactory: () => fakeClient });
C.assertAdapter(gad);
let gcur = null, gitems = [], gmore = true, gg = 0;
while (gmore && gg++ < 10) { const p = await gad.listChanges({ secrets: { refreshToken: 'r' } }, { ref: 'ROOT' }, gcur); gitems.push(...p.items); gcur = p.nextCursor; gmore = p.hasMore; }
eq('gdrive walk lists nested files and exports Google Docs as files', gitems.filter((i) => !i.isFolder).map((i) => i.name), ['Doc.pdf', 'b.pdf']);
eq('gdrive cursor switched to changes with the pre-walk token', gcur, { phase: 'changes', pageToken: 'PT0' });
const gc = await gad.listChanges({ secrets: { refreshToken: 'r' } }, { ref: 'ROOT' }, gcur);
eq('gdrive changes filtered to the linked subtree', gc.items.map((i) => i.ref + (i.removed ? '-' : '')), ['g3', 'g1-']);
eq('gdrive export download', (await gad.download({ secrets: { refreshToken: 'r' } }, { ref: 'g1', exportAs: 'x' }, 100)).toString(), 'E');

// ---- email-in
const em = await imp('api/_lib/connectors/emailIn.js');
const token = em.newToken(); const addr = em.addressFor(token, ENV);
check('address shape + token entropy', /^docs\+[a-f0-9]{48}@in\.example\.test$/.test(addr));
check('token hash differs from token and is keyed', em.tokenHash(token, ENV) !== token && em.tokenHash(token, ENV) !== em.tokenHash(token, { ...ENV, EMAILIN_ADDRESS_KEY: 'z'.repeat(32) }));
eq('token parsed from recipient list', em.tokenFromRecipients(['Bob <x@y.z>', `Docs <${addr}>`], ENV), token);
eq('wrong domain ignored', em.tokenFromRecipients([`docs+${token}@evil.test`], ENV), null);
check('sender allow-list exact / domain / none', em.senderAllowed('A <a@x.com>', ['a@x.com']) && em.senderAllowed('b@x.com', ['@x.com']) && !em.senderAllowed('c@y.com', ['@x.com']) && !em.senderAllowed('a@x.com', []));
check('auth must pass', em.authPassed('mx; dkim=pass; spf=fail') && !em.authPassed('dkim=fail; spf=fail') && !em.authPassed(null));
const wh = (bodyStr, secret = ENV.EMAILIN_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) => ({ 'svix-id': 'm1', 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`m1.${ts}.${bodyStr}`).digest('base64') });
check('webhook signature good', em.verifyWebhook(wh('{}'), '{}', ENV.EMAILIN_WEBHOOK_SECRET));
check('webhook signature bad body / stale / wrong key rejected', !em.verifyWebhook(wh('{}'), '{"a":1}', ENV.EMAILIN_WEBHOOK_SECRET) && !em.verifyWebhook(wh('{}', undefined, 1000), '{}', ENV.EMAILIN_WEBHOOK_SECRET) && !em.verifyWebhook(wh('{}'), '{}', 'whsec_' + Buffer.from('q'.repeat(24)).toString('base64')));
const estore = createMemoryStore(); await estore.saveEmail({ tokenHash: em.tokenHash(token, ENV), tokenHint: token.slice(-4), allowedSenders: ['@client.com'] });
const edocs = new Map(), ecalls = [];
const edeps = (over = {}) => ({ env: ENV, importer: importerFor(edocs, ecalls), lookup: async (h) => (h === em.tokenHash(token, ENV) ? { tenantKey: 'T', allowedSenders: ['@client.com'] } : null), storeFor: () => estore, allowance: async () => ({ allowed: true }), fetchAttachment: async () => Buffer.from('PDFBYTES'), ...over });
const msg = (o = {}) => ({ messageId: '<m1@x>', from: 'Pat <pat@client.com>', to: [addr], subject: 'Invoice', authResults: 'dkim=pass', attachments: [{ id: 'a1', filename: 'inv.pdf', contentType: 'application/pdf', size: 50000 }, { id: 'a2', filename: 'logo.png', contentType: 'image/png', size: 900, inline: true }, { id: 'a3', filename: 'x.exe', contentType: 'application/octet-stream', size: 5000 }], ...o });
let e = await em.handleInbound(msg(), edeps());
eq('email: attachment imported, logo + exe skipped', [e.outcome, e.files, ecalls.length], ['imported', 1, 1]);
eq('email: provenance tag + folder hint', [ecalls[0].source, ecalls[0].folderHint], ['connector_emailin', 'Email']);
e = await em.handleInbound(msg(), edeps()); eq('email: redelivered message id is a duplicate', e.outcome, 'duplicate');
e = await em.handleInbound(msg({ messageId: '<m2@x>', from: 'evil@other.com' }), edeps()); eq('email: unknown sender quarantined, nothing imported', [e.outcome, ecalls.length, estore._email?.quarantined_count ?? (await estore.getEmail()).quarantined_count], ['quarantined', 1, 1]);
e = await em.handleInbound(msg({ messageId: '<m3@x>', authResults: 'dkim=fail; spf=fail' }), edeps()); eq('email: spoofed From (auth fails) quarantined', e.outcome, 'quarantined');
e = await em.handleInbound(msg({ to: ['docs+' + 'f'.repeat(48) + '@in.example.test'] }), edeps()); eq('email: unknown address ignored silently', e.outcome, 'ignored');
e = await em.handleInbound(msg({ messageId: '<m4@x>' }), edeps({ allowance: async () => ({ allowed: false }) })); eq('email: allowance used -> 503 so the provider retries, nothing recorded', [e.status, (await estore.recordEmailEvent('<m4@x>', 'x'))], [503, true]);
e = await em.handleInbound(msg({ messageId: '<m5@x>' }), edeps({ env: { ...ENV, EMAILIN_PER_HOUR: '1' } })); eq('email: hourly cap', e.outcome, 'rate-limited');

// ---- route (flag off / on, admin ops, no leaks)
const route = await imp('api/_lib/connectors/route.js');
const rd = (store, over = {}) => ({ env: ENV, store, tenantId: 'T', userId: 'u', publicLink: (r) => ({ id: r.id, provider: r.provider, status: r.status }), emailTools: em,
  loadAdapter: async () => stubAdapter([]), signState: (p) => JSON.stringify(p), verifyState: (s) => JSON.parse(s), sealSecrets: (p, s) => sec.sealSecrets(p, 'T', s, ENV), openSecrets: (l) => sec.openSecrets(l.provider, 'T', l.secrets_enc, ENV), nonce: () => 'n', ...over });
let rr = await route.handleOp({}, { op: 'status' }, rd(createMemoryStore(), { env: {} })); eq('route: flag off -> {enabled:false}', rr.body, { enabled: false });
rr = await route.handleOp({}, { op: 'start', provider: 'dropbox' }, rd(createMemoryStore(), { env: {} })); eq('route: flag off -> 404', rr.status, 404);
const rs = createMemoryStore();
rr = await route.handleOp({}, { op: 'start', provider: 'dropbox' }, rd(rs)); eq('route: start returns provider url', [rr.status, rr.body.url], [200, 'https://stub.test/auth']);
rr = await route.handleOp({}, { op: 'start', provider: 'bogus' }, rd(rs)); eq('route: unknown provider 404', rr.status, 404);
rs.createLink = async (l) => rs.addLink({ provider: l.provider, account_ref: l.accountRef, folder_ref: l.folderRef, secrets_enc: l.secretsEnc, status: 'active' });
rr = await route.handleOp({}, { op: 'callback', code: 'c', state: JSON.stringify({ t: 'T', p: 'dropbox' }) }, rd(rs)); check('route: callback links paused until a folder is chosen', rr.status === 200 && rr.redirect && [...rs._links.values()][0].status === 'paused');
rr = await route.handleOp({}, { op: 'callback', code: 'c', state: JSON.stringify({ t: 'OTHER', p: 'dropbox' }) }, rd(rs)); eq('route: state for another tenant refused', rr.status, 400);
const lid = [...rs._links.values()][0].id;
rr = await route.handleOp({}, { op: 'choose', linkId: lid, folderRef: '/docs', folderName: 'Docs' }, rd(rs)); eq('route: choose activates', rr.body.link.status, 'active');
rr = await route.handleOp({}, { op: 'mapping', linkId: lid, mapping: { rules: [{ match: 'Tax', folder: 'Taxes' }, { match: '', folder: 'x' }] } }, rd(rs)); eq('route: mapping normalized', rs._links.get(lid).mapping.rules, [{ match: 'tax', folder: 'Taxes' }]);
rr = await route.handleOp({}, { op: 'status' }, rd(rs)); check('route: status leaks no secret, cursor or cost', !/secrets|cursor|usd|cost|v1\./i.test(JSON.stringify(rr.body)));
rr = await route.handleOp({}, { op: 'email-setup' }, rd(rs)); check('route: email-setup shows address once, stores only a hash', /^docs\+/.test(rr.body.address) && !JSON.stringify(await rs.getEmail()).includes(rr.body.address.split('+')[1].split('@')[0]));
rr = await route.handleOp({}, { op: 'email-senders', senders: ['@ok.com', 'bad', 'a@b.co'] }, rd(rs)); eq('route: senders validated', rr.body.senders, ['@ok.com', 'a@b.co']);
rr = await route.handleOp({}, { op: 'disconnect', linkId: lid }, rd(rs)); eq('route: disconnect', rr.body.link.status, 'disconnected');
rr = await route.handleOp({}, { op: 'pause', linkId: 'nope' }, rd(rs)); eq('route: unknown link 404 (no cross-tenant probing)', rr.status, 404);
rr = await route.handleInboundWebhook({ headers: {}, rawBody: '{}' }, { env: ENV, emailTools: em }); eq('webhook: unsigned request rejected before parsing', rr.status, 401);
const wbody = JSON.stringify({ type: 'email.received', data: { message_id: '<w1@x>', from: 'p@client.com', to: [addr], headers: { 'authentication-results': 'dkim=pass' }, attachments: [{ id: 'z', filename: 'w.pdf', content_type: 'application/pdf', size: 20000 }] } });
rr = await route.handleInboundWebhook({ headers: wh(wbody), rawBody: wbody }, { env: ENV, emailTools: em, inbound: edeps() }); eq('webhook: signed mail accepted and imported', [rr.status, ecalls.length], [200, 2]);

// ---- files the owner must not edit by hand
const allow = await imp('api/_lib/connectors/allowance.js');
const ran = []; const wt = async (_c, fn) => fn({ tenantId: 'T', raw: async (sql) => ({ rows: sql.includes('FROM tenants') ? [{ plan: 'solo', billing_status: 'active' }] : [{ units: 25_000_000 }] }) });
const d1 = await allow.paidCall(wt, {}, 0.05, async () => { ran.push(1); return {}; }, { ...ENV });
eq('paidCall blocks when the monthly ceiling is reached (solo=$20, spent $25)', [d1.ran, ran.length], [false, 0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
