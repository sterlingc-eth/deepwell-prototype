import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
const IMG = resolve('public/m/icon-192.png'), IMG2 = resolve('public/m/icon-512.png');
const SHOT = process.argv[2] ?? '/tmp/lt-shots';
import { mkdirSync } from 'node:fs'; mkdirSync(SHOT, { recursive: true });
// Phone-app limit test attacks (run: VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npx tsx scripts/lt-attack.mjs [shotDir]).
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : '\n      ' + d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let out = ''; let port;
server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 80 && !port; i++) { await sleep(150); const m = /localhost:(\d+)\//.exec(out); if (m) port = m[1]; }
const URL = `http://localhost:${port}/scripts/offline-queue-harness/harness.html`;
await sleep(500);
// shared fake server (state survives pages/contexts)
const S = { readDone: new Set(), bySha: new Map(), id: 1, calls: { uploadUrl: 0, put: 0, read: 0 }, putMode: 'ok', putDelay: 0, uploadUrlMode: 'ok', rejectNext: 0 };
async function install(target) {
  await target.route('**/api/upload-url', async (route) => {
    S.calls.uploadUrl++;
    const req = JSON.parse(route.request().postData() || '{}');
    if (S.uploadUrlMode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    const ex = S.bySha.get(req.sha256);
    if (ex && S.readDone.has(ex)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentId: ex, alreadyUploaded: true }) });
    if (ex) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentId: ex, uploadUrl: `https://fake-upload.test/${ex}`, alreadyUploaded: false }) });
    const documentId = `doc-${S.id++}`; S.bySha.set(req.sha256, documentId);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentId, uploadUrl: `https://fake-upload.test/${documentId}`, alreadyUploaded: false }) });
  });
  await target.route('https://fake-upload.test/**', async (route) => {
    S.calls.put++;
    if (S.putDelay) await sleep(S.putDelay);
    if (S.putMode === 'abort') return route.abort('connectionreset');
    route.fulfill({ status: 200, body: '' });
  });
  await target.route('**/api/read-document', async (route) => { S.calls.read++; const r = JSON.parse(route.request().postData() || '{}'); S.readDone.add(r.documentId); route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentId: r.documentId, pages: 1 }) }); });
  await target.route('**/api/v1/intake-status**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"documents":[]}' }));
}
const reset = () => { S.bySha.clear(); S.readDone.clear(); S.id = 1; S.calls = { uploadUrl: 0, put: 0, read: 0 }; S.putMode = 'ok'; S.putDelay = 0; S.uploadUrlMode = 'ok'; };
const strip = (p) => p.locator('[data-testid="offline-queue-strip"]');
async function waitFor(fn, t = 8000) { const e = Date.now() + t; while (Date.now() < e) { if (await fn()) return true; await sleep(150); } return false; }
async function scanOffline(page, img) {
  await page.context().setOffline(true);
  await page.setInputFiles('[data-testid="scan-files-input"]', img);
  await page.getByRole('button', { name: /^Upload/ }).click();
  return waitFor(async () => (await strip(page).count()) > 0);
}
const browser = await chromium.launch();
const mk = async (ctx) => { const p = await ctx.newPage(); await install(p); return p; };
const newCtx = () => browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });

// A. two tabs
{ reset(); const ctx = await newCtx(); const p1 = await mk(ctx);
  await p1.goto(URL, { waitUntil: 'networkidle' });
  const p2 = await mk(ctx); await p2.goto(URL, { waitUntil: 'networkidle' });
  check('A two tabs: scan offline in tab 1 is queued', await scanOffline(p1, IMG));
  S.putDelay = 400; await ctx.setOffline(false);
  const d1 = await waitFor(async () => (await strip(p1).count()) === 0, 12000);
  const d2 = await waitFor(async () => (await strip(p2).count()) === 0, 12000);
  check('A two tabs: both tabs drain', d1 && d2, `p1=${d1} p2=${d2}`);
  check('A two tabs: exactly ONE document created server-side', S.bySha.size === 1, `docs=${S.bySha.size}`);
  console.log(`INFO  A two tabs calls: ${JSON.stringify(S.calls)} (PUT/read >1 means both tabs sent it)`);
  console.log(`KNOWN-OPEN  A two tabs: both tabs uploaded and read it (put=${S.calls.put} read=${S.calls.read}); server dedupes the document, but the AI read runs twice (no cross-tab lock)`);
  await p1.screenshot({ path: `${SHOT}/A-two-tabs.png` }); await ctx.close(); }

// B. kill mid-upload (page closed while PUT is in flight), then reopen
{ reset(); const ctx = await newCtx(); const p = await mk(ctx);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await scanOffline(p, IMG); S.putDelay = 3000; await ctx.setOffline(false);
  await waitFor(async () => S.calls.put >= 1, 6000);
  check('B kill mid-upload: PUT was in flight', S.calls.put >= 1);
  await p.close({ runBeforeUnload: false });
  S.putDelay = 0; const p2 = await mk(ctx); await p2.goto(URL, { waitUntil: 'networkidle' });
  const ok = await waitFor(async () => (await strip(p2).count()) === 0 && S.calls.read >= 1, 12000);
  check('B kill mid-upload: reopened app finishes the scan (queue empties, read called)', ok, JSON.stringify(S.calls));
  check('B kill mid-upload: still exactly one document', S.bySha.size === 1, `docs=${S.bySha.size}`);
  await ctx.close(); }

// C. flip signal repeatedly with random PUT aborts
{ reset(); const ctx = await newCtx(); const p = await mk(ctx);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await scanOffline(p, IMG); S.putMode = 'abort';
  for (let i = 0; i < 8; i++) { await ctx.setOffline(false); await sleep(250); await ctx.setOffline(true); await sleep(150); }
  check('C flip x8: scan still listed (not lost) mid-flapping', (await strip(p).count()) > 0);
  S.putMode = 'ok'; await ctx.setOffline(false);
  const ok = await waitFor(async () => (await strip(p).count()) === 0, 40000);
  check('C flip x8: finally uploads and queue empties', ok, JSON.stringify(S.calls));
  check('C flip x8: one document, one successful read', S.bySha.size === 1 && S.calls.read === 1, `docs=${S.bySha.size} read=${S.calls.read}`);
  await ctx.close(); }

// D. storage full: IndexedDB writes throw QuotaExceededError
{ reset(); const ctx = await newCtx(); const p = await mk(ctx);
  await p.addInitScript(() => { const orig = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function (...a) { if (window.__fullDisk) { throw new DOMException('quota', 'QuotaExceededError'); } return orig.apply(this, a); }; });
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.evaluate(() => { window.__fullDisk = true; });
  await ctx.setOffline(true);
  await p.setInputFiles('[data-testid="scan-files-input"]', IMG);
  await p.getByRole('button', { name: /^Upload/ }).click(); await sleep(2500);
  const txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  const thumb = await p.locator('img[alt="Page 1"]').count();
  console.log('INFO  D storage full UI text:', txt.slice(0, 300));
  await p.screenshot({ path: `${SHOT}/D-storage-full.png` });
  check('D storage full: user is told the scan was NOT saved (message mentions storage/full/not saved) or photo still in Picked list', /storage|full|not saved|couldn.t save|space/i.test(txt) || thumb > 0, txt.slice(0, 200));
  check('D storage full: it does not claim "Saved" / "Waiting to upload" when nothing was stored', !/waiting to upload \(1\)/i.test(txt) , txt.slice(0, 200));
  await ctx.close(); }

// E. delete without confirm
{ reset(); const ctx = await newCtx(); const p = await mk(ctx); await p.goto(URL, { waitUntil: 'networkidle' });
  await scanOffline(p, IMG);
  await strip(p).locator('button[aria-label^="Remove"]').first().click();
  await sleep(500);
  const gone = (await strip(p).count()) === 0;
  check('E delete a waiting scan: first tap does NOT delete (asks to confirm)', !gone, 'one tap deleted the only copy');
  const armed = strip(p).locator('button[aria-label^="Tap again"]'); const bx = await armed.boundingBox();
  check('E armed button shows Delete? and is >=44px', (await armed.count()) === 1 && bx && bx.height >= 44 && bx.width >= 44);
  await p.screenshot({ path: `${SHOT}/E-delete-armed.png` });
  await sleep(4500);
  check('E armed state times out (no accidental later delete)', (await strip(p).locator('button[aria-label^="Remove"]').count()) === 1 && (await strip(p).count()) === 1);
  await strip(p).locator('button[aria-label^="Remove"]').first().click(); await strip(p).locator('button[aria-label^="Tap again"]').first().click();
  check('E second tap deletes', await waitFor(async () => (await strip(p).count()) === 0, 3000));
  await ctx.close(); }

// F. real browser restart (persistent profile), offline, then relaunch online
{ reset(); const dir = mkdtempSync('/tmp/lt-prof-');
  const opts = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' };
  let ctx = await chromium.launchPersistentContext(dir, opts); const p = await ctx.newPage(); await install(p); await p.goto(URL, { waitUntil: 'networkidle' });
  check('F restart: scan queued offline', await scanOffline(p, IMG2));
  await ctx.close();
  ctx = await chromium.launchPersistentContext(dir, opts); const p2 = await ctx.newPage(); await install(p2); await p2.goto(URL, { waitUntil: 'networkidle' });
  const ok = await waitFor(async () => (await strip(p2).count()) === 0 && S.calls.read >= 1, 12000);
  check('F restart: after full browser restart the scan uploads on its own', ok, JSON.stringify(S.calls));
  check('F restart: exactly one doc', S.bySha.size === 1);
  await ctx.close(); }

// G. server 500 on upload-url with live signal then reload: stays queued, retries later
{ reset(); const ctx = await newCtx(); const p = await mk(ctx); await p.goto(URL, { waitUntil: 'networkidle' });
  S.uploadUrlMode = '500';
  await p.setInputFiles('[data-testid="scan-files-input"]', IMG);
  await p.getByRole('button', { name: /^Upload/ }).click();
  await waitFor(async () => (await strip(p).count()) > 0, 6000);
  check('G 500 while online: scan kept in queue', (await strip(p).count()) > 0);
  await p.reload({ waitUntil: 'networkidle' });
  check('G 500 + reload: scan still listed', await waitFor(async () => (await strip(p).count()) > 0, 4000));
  S.uploadUrlMode = 'ok';
  const ok = await waitFor(async () => (await strip(p).count()) === 0, 90000);
  check('G 500 recovers: uploads automatically once the server is back (<=90 s)', ok, JSON.stringify(S.calls));
  await ctx.close(); }


// H. multi-page offline with jsPDF chunk unavailable (prior defect H1) -> must queue, never lose
{ reset(); const ctx = await newCtx(); const p = await mk(ctx);
  await p.route(/jspdf/, (r) => r.abort());
  await p.goto(URL, { waitUntil: 'networkidle' });
  await ctx.setOffline(true);
  await p.setInputFiles('[data-testid="scan-files-input"]', [IMG, IMG2, resolve('public/m/icon-192.png')]);
  await p.getByRole('button', { name: /^Upload/ }).click();
  const q = await waitFor(async () => (await strip(p).count()) > 0, 8000);
  const txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  console.log('INFO  H text:', txt.slice(0, 200));
  check('H offline 3 photos with PDF library blocked: scans are queued (not lost)', q && /Waiting to upload \((\d)\)/.test(txt), txt.slice(0, 200));
  await ctx.setOffline(false);
  check('H ... and upload once back online', await waitFor(async () => (await strip(p).count()) === 0, 12000), JSON.stringify(S.calls));
  console.log('INFO  H calls', JSON.stringify(S.calls), 'docs', S.bySha.size);
  await ctx.close(); }
// I. 402 plan block while online keeps the scan and shows See plans
{ reset(); const ctx = await newCtx(); const p = await mk(ctx);
  await p.unroute('**/api/upload-url'); await p.route('**/api/upload-url', (r) => r.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'Choose a plan to continue.', code: 'plan-none', url: '/app/?screen=billing' }) }));
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.setInputFiles('[data-testid="scan-files-input"]', IMG);
  await p.getByRole('button', { name: /^Upload/ }).click(); await sleep(2500);
  const txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  await p.screenshot({ path: `${SHOT}/I-402.png` });
  console.log('INFO  I text:', txt.slice(0, 300));
  check('I 402: See plans link shown', (await p.getByRole('link', { name: /See plans/ }).count()) > 0);
  check('I 402: scan kept (listed under Waiting to upload)', /Waiting to upload \(1\)/.test(txt));
  check('I 402: says why, not just "No signal"', /plan/i.test(txt));
  await ctx.close(); }

console.log(`\n${pass} passed, ${fail} failed.`);
await browser.close(); try { process.kill(-server.pid); } catch {}
