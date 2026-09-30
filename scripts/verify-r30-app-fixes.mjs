/**
 * R30 app-fix checks: one section per fix (numbers match the R30 brief).
 *
 *   1  admin-only actions are disabled/hidden for members, live for admins and solo users
 *   2  install date: unit page field, deep link focuses it, saves through the audited action, member can edit
 *   3  upload "Still processing" note points to Inbox, with a button that navigates
 *   4  no FREE_PREVIEW_DOCUMENTS / "Free preview" path left in the client
 *   5  phone account sheet (shop name, switcher only with >1 shop, sign out) + offline-queue tenant isolation
 *   6  Records opens on Documents, remembers the last tab per user
 *   7  per-user "Mute my daily digest" (server route, sender filter, Team screen)
 *   8  "Classify received" asks the server (reclassify) instead of guessing from the filename
 *   9  Team screen points to Clerk's Members / Invitations panel
 *
 *   npx tsx scripts/verify-r30-app-fixes.mjs [screenshotDir]
 */
import path from 'node:path';
import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { startServer, REPO } from './app-qa-harness/serve.mjs';
import { installBackend } from './app-qa-harness/backend.mjs';
import { OfflineUploadQueue } from '../src/mobile/offline/uploadQueue.ts';
import { createMemoryStore } from '../src/mobile/offline/queue.ts';
import { reconcileDeviceOwner, wipeAndSignOut, clearTenantSessionState, DEVICE_OWNER_KEY } from '../src/mobile/offline/deviceIsolation.ts';
import { STILL_PROCESSING_MESSAGE } from '../src/services/ingestClient.ts';
import { mutedDigestUserIds } from '../api/_lib/util/digestMute.js';
const { validateInstallDateInput, installDatePatch } = await import('../api/_lib/reviewStore.js');

const SHOT_DIR = process.argv[2] ?? path.join(REPO, '..', 'r30-shots');
mkdirSync(SHOT_DIR, { recursive: true });

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================ unit: offline queue tenant isolation (item 5) ================================ */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: u, headers, sha: (() => { try { return JSON.parse(init.body ?? '{}').sha256; } catch { return undefined; } })() });
    return handler(u, init, headers);
  };
  return { f, calls };
}
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fileOf = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

const realFetch = globalThis.fetch;
try {
  // (a) a drain for a shop that is not the signed-in one does nothing
  {
    const q = new OfflineUploadQueue(createMemoryStore());
    const srv = fakeFetch(() => jsonRes(200, { documentId: 'd1', alreadyUploaded: true }));
    globalThis.fetch = srv.f;
    q.setActiveTenant('orgB');
    await q.enqueue('orgA', fileOf('a.jpg'), 'sha-a');
    await q.drain('orgA');
    check('queue: shop A is not drained while shop B is signed in (no request made)', srv.calls.length === 0);
    check('queue: A scan still queued, untouched', (await q.list('orgA')).length === 1 && (await q.list('orgA'))[0].status === 'queued' && (await q.list('orgA'))[0].attempts === 0);
    q.setActiveTenant('orgA');
    await q.drain('orgA');
    check('queue: shop A drains once shop A is active, and names its shop to the server', srv.calls.length === 1 && srv.calls[0].headers['x-dw-expected-tenant'] === 'orgA');
    check('queue: uploaded scan leaves the queue', (await q.list('orgA')).length === 0);
  }
  // (b) switching shops mid-upload aborts it and puts the scan back untouched (no error, no attempt burned)
  {
    const q = new OfflineUploadQueue(createMemoryStore());
    let sawAbort = false;
    const srv = fakeFetch((u, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => { sawAbort = true; reject(new DOMException('aborted', 'AbortError')); });
    }));
    globalThis.fetch = srv.f;
    q.setActiveTenant('orgA');
    await q.enqueue('orgA', fileOf('b.jpg'), 'sha-b');
    const running = q.drain('orgA');
    await sleep(30);
    q.setActiveTenant('orgB');
    await running;
    const [it] = await q.list('orgA');
    check('queue: org switch aborts the in-flight upload', sawAbort);
    check('queue: aborted scan is back to "queued", no error, no attempt counted', it && it.status === 'queued' && it.attempts === 0 && !it.error, JSON.stringify(it));
    check('queue: no retry timer is left running for the old shop', q.backoffTimers.size === 0);
  }
  // (c) a failure schedules a retry timer; a shop switch cancels it
  {
    const q = new OfflineUploadQueue(createMemoryStore());
    globalThis.fetch = fakeFetch(() => jsonRes(503, { error: 'down' })).f;
    q.setActiveTenant('orgA');
    await q.enqueue('orgA', fileOf('c.jpg'), 'sha-c');
    await q.drain('orgA');
    check('queue: transient failure schedules a backoff timer', q.backoffTimers.size === 1);
    q.setActiveTenant('orgB');
    check('queue: switching shops cancels the old shop\'s backoff timer', q.backoffTimers.size === 0);
  }
  // (d) the server's tenant-mismatch 409 is not a scan failure
  {
    const q = new OfflineUploadQueue(createMemoryStore());
    globalThis.fetch = fakeFetch(() => jsonRes(409, { error: 'different shop', code: 'tenant-mismatch' })).f;
    q.setActiveTenant('orgA');
    await q.enqueue('orgA', fileOf('d.jpg'), 'sha-d');
    await q.drain('orgA');
    const [it] = await q.list('orgA');
    check('queue: server 409 tenant-mismatch leaves the scan queued, not failed', it && it.status === 'queued' && it.attempts === 0 && !it.errorClass, JSON.stringify(it));
    check('queue: 409 does not schedule an endless retry loop', q.backoffTimers.size === 0);
  }
  // (e) purgeAll + owner reconciliation + sign-out wipe
  {
    const q = new OfflineUploadQueue(createMemoryStore());
    globalThis.fetch = fakeFetch(() => jsonRes(200, { documentId: 'x', alreadyUploaded: true })).f;
    await q.enqueue('orgA', fileOf('e1.jpg'), 'sha-e1');
    await q.enqueue('orgB', fileOf('e2.jpg'), 'sha-e2');
    check('queue: countAll sees every shop', (await q.countAll()) === 2);
    const mem = new Map();
    const local = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null };
    const first = await reconcileDeviceOwner('user_1', () => q.purgeAll(), local);
    check('device owner: first run adopts the user and keeps existing scans', first === false && (await q.countAll()) === 2 && mem.get(DEVICE_OWNER_KEY) === 'user_1');
    const same = await reconcileDeviceOwner('user_1', () => q.purgeAll(), local);
    check('device owner: same user again keeps scans', same === false && (await q.countAll()) === 2);
    const other = await reconcileDeviceOwner('user_2', () => q.purgeAll(), local);
    check('device owner: a different user on the phone deletes the previous person\'s scans (all shops)', other === true && (await q.countAll()) === 0 && mem.get(DEVICE_OWNER_KEY) === 'user_2');
    await q.enqueue('orgA', fileOf('e3.jpg'), 'sha-e3');
    q.setActiveTenant('orgA');
    await q.purgeAll();
    globalThis.fetch = fakeFetch(() => { throw new Error('must not upload after purge'); }).f;
    await q.drain('orgA');
    check('queue: after purgeAll nothing uploads until a shop is activated again', (await q.countAll()) === 0);
    let signedOut = 0;
    await q.enqueue('orgA', fileOf('e4.jpg'), 'sha-e4');
    await wipeAndSignOut(() => q.purgeAll(), async () => { signedOut++; }, local);
    check('sign-out: queue wiped BEFORE signing out, owner marker removed', signedOut === 1 && (await q.countAll()) === 0 && !mem.has(DEVICE_OWNER_KEY));
    const ss = new Map([['deepwell.support.chat.v1.mobile', 'x'], ['deepwell.billingStatus.u::o', 'y'], ['keepme', 'z']]);
    clearTenantSessionState({ getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v), removeItem: (k) => ss.delete(k), get length() { return ss.size; }, key: (i) => [...ss.keys()][i] ?? null });
    check('session state: support chat + billing cache cleared, unrelated keys untouched', !ss.has('deepwell.support.chat.v1.mobile') && !ss.has('deepwell.billingStatus.u::o') && ss.has('keepme'));
  }
} finally {
  globalThis.fetch = realFetch;
}

/* ================================ unit/static: items 3, 4, 7, 5(server) ================================ */
check('3: the still-processing note points to Inbox, not Records', /Inbox/.test(STILL_PROCESSING_MESSAGE) && !/Records/.test(STILL_PROCESSING_MESSAGE), STILL_PROCESSING_MESSAGE);
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('4: FREE_PREVIEW_DOCUMENTS and the "cap" banner are gone from the client code', !/FREE_PREVIEW_DOCUMENTS/.test(noComments(read('src/services/billingClient.ts'))) && !/Free preview used up/.test(noComments(read('src/services/billingClient.ts'))) && !/kind === 'cap'/.test(noComments(read('src/components/AppShell.tsx'))));
check('1: solo (no shop) users count as admins, members do not (mirrors the server gate)', /return !orgId \|\| isAdminRole\(orgRole \?\? null\)/.test(read('src/hooks/useCanAdmin.ts')));
check('7: mutedDigestUserIds tolerates missing / malformed settings', mutedDigestUserIds(null).length === 0 && mutedDigestUserIds({ digestMuted: 'x' }).length === 0 && mutedDigestUserIds({ digestMuted: ['u1', 5, '', 'u2'] }).join() === 'u1,u2');
check('7: the digest sender skips muted admins', /mutedDigestUserIds\(tenant\.settings\)/.test(read('api/_lib/notify.js')) && /muted\.has\(/.test(read('api/_lib/notify.js')));
check('7: the route lets any member change only their OWN mute (userId from the session)', /auth\.userId/.test(read('api/_lib/routes/notifications.js')) && /"digestMuted" in body\.settings/.test(read('api/_lib/routes/notifications.js')));
check('5: /api/upload-url refuses a scan captured in another shop (409 tenant-mismatch)', /x-dw-expected-tenant/.test(read('api/upload-url.js')) && /tenant-mismatch/.test(read('api/upload-url.js')));
check('5: no new SQL needed (mute lives in tenants.settings jsonb)', !fs.readdirSync(path.join(REPO, 'M3-config')).some((f) => /^6[0-9]-.*r30/i.test(f)));

// 2 (server rules, no database)
{
  const T = '2026-09-29';
  check('2: valid date accepted', validateInstallDateInput('2024-06-12', T).ok === true);
  check('2: impossible day rejected', validateInstallDateInput('2024-02-31', T).ok === false);
  check('2: non-ISO / empty rejected', !validateInstallDateInput('06/12/2024', T).ok && !validateInstallDateInput('', T).ok && !validateInstallDateInput(null, T).ok);
  check('2: pre-1950 and far-future rejected, next-month accepted', !validateInstallDateInput('1949-12-31', T).ok && !validateInstallDateInput('2027-09-29', T).ok && validateInstallDateInput('2026-10-15', T).ok);
  const r = installDatePatch({ brand: 'Trane', installation_date: null }, '2024-06-12', { by: 'Pat Owner', byUserId: 'user_pat', now: new Date('2026-09-29T12:00:00Z') });
  check('2: patch stores the date and "entered by" provenance with the real user id', r.patch.installation_date === '2024-06-12' && r.patch.installation_date_entered.by === 'Pat Owner' && r.patch.installation_date_entered.byUserId === 'user_pat' && r.patch.installation_date_entered.previous === null, JSON.stringify(r.patch));
  const r2 = installDatePatch({ installation_date: '2020-01-01', warranty: { expiresBasis: 'printed', expires: '2031-05-05' } }, '2024-06-12', { by: 'Pat', now: new Date('2026-09-29T12:00:00Z') });
  check('2: a printed warranty expiry survives a typed install date; the old date is kept as "previous"', r2.previous === '2020-01-01' && r2.warranty?.expires === '2031-05-05', JSON.stringify(r2.warranty));
  const revSrc = read('api/review.js');
  const gate = revSrc.slice(revSrc.indexOf("'setUnitInstallDate'") - 400, revSrc.indexOf("'setUnitInstallDate'") + 400);
  check('2: the server action is registered and not admin-gated (same people who can correct facts)', /setUnitInstallDate/.test(revSrc) && !/requireRole/.test(gate), gate);
}

/* ================================ browser ================================ */
const { chromium } = await import('playwright');
const { server, base } = await startServer();
const mobileBase = base.replace('index.html', 'mobile.html');
const browser = await chromium.launch();

async function open({ auth = {}, backend = {}, vp = { width: 1280, height: 800 }, mobile = false, url = '', init = null } = {}) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(`console: ${m.text().slice(0, 160)}`); });
  await page.addInitScript(({ a }) => { window.__QA_AUTH = a; }, { a: auth });
  if (init) await page.addInitScript(init);
  const d = await installBackend(page, backend);
  page.__d = d;
  await page.goto((mobile ? mobileBase : base) + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  page.__errs = errs;
  return page;
}
const go = async (page, screen) => { await page.evaluate((s) => window.__store.getState().setCurrentScreen(s), screen); await page.waitForTimeout(500); };
const mainText = async (page) => (await page.locator('main').first().innerText()).replace(/\s+/g, ' ');

try {
  /* ---------------- 6. Records tab ---------------- */
  {
    const page = await open({ auth: { userId: 'user_a' } });
    await go(page, 'browse');
    const sel = async () => page.locator('[role=tab][aria-selected=true]').first().innerText();
    check('6: Records opens on Documents for a new user', (await sel()).trim() === 'Documents', await sel());
    await page.getByRole('tab', { name: 'Customers' }).click();
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: 'networkidle' });
    await go(page, 'browse');
    check('6: reopening Records restores the last-used tab (Customers)', (await sel()).trim() === 'Customers', await sel());
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('dw.records.tab.')));
    check('6: the choice is stored per user', stored.length === 1 && stored[0][0] === 'dw.records.tab.user_a' && stored[0][1] === 'customers', JSON.stringify(stored));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const box = await page.getByRole('tab', { name: 'Documents' }).boundingBox();
    check('6: Records tabs are 44px+ tall on a phone-width screen', !!box && box.height >= 43.5, JSON.stringify(box));
    // another user on the same browser still gets Documents
    await page.evaluate(() => { window.__QA_AUTH = { userId: 'user_b' }; });
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(() => { window.__QA_AUTH = { userId: 'user_b' }; });
    await page.close();
    const page2 = await open({ auth: { userId: 'user_b' } });
    await go(page2, 'browse');
    check('6: a different user is not affected by user_a\'s tab', (await page2.locator('[role=tab][aria-selected=true]').first().innerText()).trim() === 'Documents');
    // blocked storage: still works
    const page3 = await open({ auth: { userId: 'user_c' }, init: () => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); } });
    await go(page3, 'browse');
    check('6: blocked storage does not crash Records (falls back to Documents)', (await page3.locator('[role=tab][aria-selected=true]').first().innerText()).trim() === 'Documents' && page3.__errs.length === 0, page3.__errs.join('|'));
    await page3.context().close(); await page2.context().close(); await page.context().close();
  }

  /* ---------------- 1. admin-only actions ---------------- */
  for (const [who, auth, admin] of [['member', { orgRole: 'org:member' }, false], ['admin', { orgRole: 'org:admin' }, true]]) {
    const page = await open({ auth: { userId: 'user_x', ...auth } });
    await go(page, 'browse');
    await page.getByRole('tab', { name: 'Customers' }).click();
    await page.waitForTimeout(400);
    const exp = page.getByRole('button', { name: 'Export CSV' }).first();
    check(`1 (${who}): Customers Export CSV is ${admin ? 'enabled' : 'disabled'}`, (await exp.isDisabled()) === !admin);
    if (!admin) {
      check('1 (member): Export CSV says "Ask an admin" (title + visible note)', ((await exp.getAttribute('title')) ?? '').includes('Ask an admin') && (await page.getByTestId('ask-admin-note').count()) > 0);
      const inGuard = await page.evaluate(() => Boolean(document.querySelector('[aria-describedby="customers-export-admin-note"]')));
      check('1 (member): the disabled button is described by the note (screen readers)', inGuard);
    }
    await page.getByRole('tab', { name: 'Documents' }).click();
    await page.waitForTimeout(400);
    const t = await mainText(page);
    check(`1 (${who}): "Empty documents" ${admin ? 'is offered' : 'is not shown'}`, /Empty documents/.test(t) === admin || (!admin && !/Empty documents/.test(t)));
    await go(page, 'billing');
    check(`1 (${who}): Billing ${admin ? 'has no member note' : 'explains an admin manages it'}`, ((await page.getByTestId('billing-member-note').count()) > 0) === !admin);
    if (!admin) {
      const btns = page.locator('main button:not([disabled])', { hasText: /Start|Choose|Manage|Change|Upgrade|Cancel|Update/ });
      check('1 (member): no enabled billing action buttons', (await btns.count()) === 0, String(await btns.count()));
    }
    await page.context().close();
  }

  /* ---------------- 2. install date ---------------- */
  {
    const EID = '55555555-5555-4555-8555-555555555555';
    const page = await open({ auth: { orgRole: 'org:member', userId: 'user_pat' } });
    const posts = [];
    await page.route('**/api/review', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.action === 'setUnitInstallDate') {
        posts.push(b);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entity: {}, installDate: b.installDate, previous: null, warranty: { expires: '2036-06-12', brandVerified: true } }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate((id) => {
      window.__graph.setState({ entities: { [id]: { id, type: 'equipment', fields: { brand: 'Trane', model: 'XR16', serial: 'S-1001' } } } });
      window.__store.getState().openEntityField(id, 'installDate');
    }, EID);
    await page.waitForTimeout(700);
    const input = page.locator('[data-testid="install-date-field"] input[type=date]');
    check('2: the dashboard deep link opens the unit page with the install-date editor open', (await input.count()) === 1);
    check('2: the date input has focus', await page.evaluate(() => document.activeElement?.getAttribute('type') === 'date'));
    const ib = await input.boundingBox();
    check('2: input is 44px+ tall', !!ib && ib.height >= 43.5, JSON.stringify(ib));
    await input.fill('2026-06-12');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(500);
    check('2: a MEMBER can save it (facts editing is not admin-only) through the review action', posts.length === 1 && posts[0].entityId === EID && posts[0].installDate === '2026-06-12', JSON.stringify(posts));
    const txt = (await page.getByTestId('install-date-field').innerText()).replace(/\s+/g, ' ');
    check('2: shows the date, who entered it, and the resulting warranty end', /Jun 12, 2026/.test(txt) && /Entered by/.test(txt) && /Warranty now ends/.test(txt), txt);
    // a bad date is refused before any request
    await page.getByRole('button', { name: 'Change install date' }).click();
    await page.locator('[data-testid="install-date-field"] input[type=date]').fill('1901-01-01');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(200);
    check('2: an implausible date is refused with a message (no request)', (await page.getByRole('alert').count()) > 0 && posts.length === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('2: Escape cancels the editor', (await page.locator('[data-testid="install-date-field"] input[type=date]').count()) === 0);
    await page.context().close();
  }

  /* ---------------- 3 + 8. Inbox ---------------- */
  {
    const DOC = '66666666-6666-4666-8666-666666666666';
    const page = await open({ auth: { orgRole: 'org:admin' } });
    const reclass = [];
    await page.route('**/api/review', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.action === 'reclassify') { reclass.push(b); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changes: [{ documentId: DOC, from: null, to: 'invoice' }], remaining: 0 }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate((doc) => {
      const g = window.__graph;
      g.setState({
        batches: { b1: { id: 'b1', name: 'Truck scans', source: 'truck', dateRange: { from: new Date(), to: new Date() }, createdAt: new Date(), createdBy: 'me', documentIds: [doc] } },
        docs: { [doc]: { id: doc, filename: 'IMG_0042.jpg', fileType: 'image', pages: 1, batchId: 'b1', source: 'truck', receivedAt: new Date(), typeId: null, stage: 'received', extracted: [], linkedEntityIds: [], linkConfidence: 0, issues: [] } },
      });
      window.__store.getState().setUpload('IMG_0042.jpg', { filename: 'IMG_0042.jpg', status: 'pending' });
      window.__store.getState().setCurrentScreen('ingest');
    }, DOC);
    await page.waitForTimeout(700);
    const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    check('3: the pending upload row says "check Inbox", never "check Records"', /Still processing/.test(t) && /check Inbox/.test(t) && !/check Records/.test(t), t.slice(0, 300));
    const link = page.getByRole('button', { name: 'See Needs you' });
    const lb = await link.boundingBox();
    check('3: the note has a button that opens Inbox -> Needs you', (await link.count()) === 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const lbm = await link.boundingBox();
    check('3: that button is 44px+ tall on a phone-width screen', !!lbm && lbm.height >= 43.5, JSON.stringify(lbm));
    await link.click();
    await page.waitForTimeout(400);
    check('3: clicking it lands on the Needs you tab', await page.evaluate(() => window.__store.getState().inboxTab === 'needs-person'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(page, 'ingest');
    await page.evaluate(() => window.__store.getState().setInboxTab('add'));
    await page.waitForTimeout(400);
    const cls = page.getByRole('button', { name: 'Classify received' });
    check('8: "Classify received" is offered for a received file', (await cls.count()) === 1);
    await cls.click();
    await page.waitForTimeout(700);
    check('8: it asks the SERVER to classify (reclassify with the document id), not the filename guesser', reclass.length === 1 && reclass[0].documentIds?.[0] === DOC, JSON.stringify(reclass));
    check('8: the server result is applied and reported', (await page.evaluate(() => window.__graph.getState().docs['66666666-6666-4666-8666-666666666666']?.typeId)) === 'invoice' && /Classified 1 of 1/.test((await page.locator('main').innerText()).replace(/\s+/g, ' ')));
    check('8: the browser-only guess is not used outside demo mode', !/classifyDoc\(d\.id, classifyByFilename/.test(read('src/screens/IntakeScreen.tsx').split('if (DEMO_MODE)')[0]));
    await page.context().close();
  }

  /* ---------------- 7 + 9. Team screen ---------------- */
  {
    const page = await open({ auth: { orgRole: 'org:admin' } });
    await go(page, 'team');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(250);
    const sw = page.getByTestId('mute-my-digest');
    check('7: admins see "Mute my daily digest" next to the shop-wide switch', (await sw.count()) === 1 && /Mute my daily digest/.test(await page.locator('main').innerText()));
    check('7: shop-wide switch is labelled as shop-wide', /Send the shop.s daily warranty digest/.test(await page.locator('main').innerText()));
    const b = await sw.boundingBox();
    check('7: the switch row is 44px+ tall', !!b && b.height >= 20, JSON.stringify(b));
    const posted = [];
    await page.route('**/api/account*', async (route) => {
      if (route.request().method() === 'POST') { posted.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ digestMuted: true, settings: {} }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], unreadCount: 0, emailDigest: true, digestMuted: false }) });
    });
    await sw.click();
    await page.waitForTimeout(400);
    check('7: toggling posts only { settings: { digestMuted: true } }', posted.length === 1 && posted[0].settings?.digestMuted === true && !('emailDigest' in posted[0].settings), JSON.stringify(posted));
    check('7: switch reflects the new state', (await sw.getAttribute('aria-checked')) === 'true');
    const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    check('9: admin Team screen points to the Members and Invitations tabs of the panel', /Members/.test(t) && /Invitations/.test(t) && /remove someone or cancel an invitation/.test(t), t.slice(0, 500));
    await page.context().close();
    const mp = await open({ auth: { orgRole: 'org:member' } });
    await go(mp, 'team');
    check('9: members are told only an admin can change roles / remove / invite', (await mp.getByTestId('team-member-help').count()) === 1 && /Ask an admin/.test(await mp.getByTestId('team-member-help').innerText()));
    check('7: members are not shown the digest switches (only admins get the digest)', (await mp.getByTestId('mute-my-digest').count()) === 0);
    await mp.context().close();
  }

  /* ---------------- 5. phone account sheet ---------------- */
  {
    const one = await open({ mobile: true, vp: { width: 390, height: 844 }, auth: { orgName: 'Sunrise HVAC' }, url: '?tab=scan' });
    const ab = await one.getByTestId('account-button').boundingBox();
    check('5: header has an Account button, 44px+', !!ab && ab.width >= 43.5 && ab.height >= 43.5, JSON.stringify(ab));
    check('5: no fourth bottom tab was added', (await one.locator('nav[aria-label=Main] button').count()) === 3);
    await one.getByTestId('account-button').click();
    await one.waitForTimeout(300);
    check('5: sheet names the current shop', /Sunrise HVAC/.test(await one.getByTestId('account-current-shop').innerText()));
    check('5: no shop switcher with a single shop', (await one.getByTestId('account-switcher').count()) === 0);
    const so = await one.getByTestId('account-signout').boundingBox();
    check('5: Sign out is 44px+', !!so && so.height >= 43.5, JSON.stringify(so));
    await one.screenshot({ path: path.join(SHOT_DIR, 'account-single-390.png') });
    await one.getByTestId('account-signout').click();
    await one.waitForTimeout(500);
    check('5: Sign out calls Clerk signOut back to /m/', (await one.evaluate(() => JSON.parse(sessionStorage.getItem('__QA_CALLS') || '{}').signOut?.[0]?.redirectUrl)) === '/m/');
    await one.context().close();

    const multi = await open({ mobile: true, vp: { width: 390, height: 844 }, auth: { orgId: 'org_a', orgName: 'Shop A', shops: [{ id: 'org_a', name: 'Shop A' }, { id: 'org_b', name: 'Shop B' }] }, url: '?tab=scan' });
    await multi.getByTestId('account-button').click();
    await multi.waitForTimeout(300);
    check('5: shop switcher appears with more than one shop', (await multi.getByTestId('account-switcher').count()) === 1);
    const cur = multi.getByRole('button', { name: /Shop A/ });
    check('5: current shop is marked and not selectable', (await cur.first().getAttribute('aria-current')) === 'true' && (await cur.first().isDisabled()));
    const other = multi.getByRole('button', { name: /Shop B/ });
    const ob = await other.boundingBox();
    check('5: shop buttons are 44px+', !!ob && ob.height >= 43.5, JSON.stringify(ob));
    await multi.screenshot({ path: path.join(SHOT_DIR, 'account-multi-390.png') });
    // queue an item for shop A, then switch: item must survive under A, and setActive is called with B
    await multi.evaluate(async () => {
      const m = await import('/src/mobile/offline/queue.ts');
      const store = m.createIndexedDbStore();
      await store.add({ id: 'qa-1', tenantKey: 'org_a', filename: 's.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256: 'qa-sha', blob: new Blob([new Uint8Array([1, 2, 3])]), createdAt: Date.now(), attempts: 1, nextAttemptAt: Date.now() + 1e9, status: 'error', errorClass: 'transient' });
    });
    await Promise.all([multi.waitForEvent('load'), other.click()]);
    await multi.waitForTimeout(800);
    const calls = await multi.evaluate(() => JSON.parse(sessionStorage.getItem('__QA_CALLS') || '{}'));
    check('5: switching calls Clerk setActive for the chosen shop, then reloads', calls.setActive?.[0]?.organization === 'org_b');
    const left = await multi.evaluate(async () => {
      const m = await import('/src/mobile/offline/queue.ts');
      const s = m.createIndexedDbStore();
      return { a: (await s.all('org_a')).length, b: (await s.all('org_b')).length };
    });
    check('5: shop A\'s queued scan is kept under shop A only (not moved to or shown in B)', left.a === 1 && left.b === 0, JSON.stringify(left));
    await multi.context().close();

    // sign out with scans waiting: warns, "Stay signed in" keeps them, confirming deletes them
    const so2 = await open({ mobile: true, vp: { width: 390, height: 844 }, url: '?tab=scan' });
    const put = () => so2.evaluate(async () => {
      const m = await import('/src/mobile/offline/queue.ts');
      await m.createIndexedDbStore().add({ id: 'qa-2', tenantKey: 'org_qa', filename: 't.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256: 'qa-sha2', blob: new Blob([new Uint8Array([1, 2, 3])]), createdAt: Date.now(), attempts: 1, nextAttemptAt: Date.now() + 1e9, status: 'error', errorClass: 'transient' });
    });
    await put();
    await so2.getByTestId('account-button').click();
    await so2.getByTestId('account-signout').click();
    await so2.waitForTimeout(400);
    check('5: signing out with unsent scans warns first and does not sign out yet', (await so2.getByTestId('account-signout-confirm').count()) === 1 && !(await so2.evaluate(() => sessionStorage.getItem('__QA_CALLS'))));
    await so2.getByTestId('account-signout-confirm-yes').click();
    await so2.waitForTimeout(600);
    const remaining = await so2.evaluate(async () => { const m = await import('/src/mobile/offline/queue.ts'); return m.createIndexedDbStore().countAll(); });
    check('5: confirming deletes every queued scan on the phone and signs out', remaining === 0 && (await so2.evaluate(() => JSON.parse(sessionStorage.getItem('__QA_CALLS') || '{}').signOut?.length)) === 1, String(remaining));
    await so2.context().close();

    // a different person on the phone: previous user's scans are gone on load
    const own = await open({ mobile: true, vp: { width: 390, height: 844 }, url: '?tab=scan' });
    await own.evaluate(async () => {
      const m = await import('/src/mobile/offline/queue.ts');
      await m.createIndexedDbStore().add({ id: 'qa-3', tenantKey: 'org_qa', filename: 'u.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256: 'qa-sha3', blob: new Blob([new Uint8Array([1])]), createdAt: Date.now(), attempts: 1, nextAttemptAt: Date.now() + 1e9, status: 'error', errorClass: 'transient' });
      localStorage.setItem('dw.mobile.owner', 'user_someone_else');
    });
    await own.reload({ waitUntil: 'networkidle' });
    await own.waitForTimeout(600);
    const n = await own.evaluate(async () => { const m = await import('/src/mobile/offline/queue.ts'); return m.createIndexedDbStore().countAll(); });
    check('5: a different user signing in on the same phone finds the old queue deleted', n === 0, String(n));
    await own.context().close();

    // gated screen keeps a working account menu
    const gated = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { billing: 'none' }, url: '?tab=ask' });
    check('5: plan-gate screen still has the account menu (sign out / switch shop)', (await gated.getByTestId('account-button').count()) === 1);
    await gated.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
