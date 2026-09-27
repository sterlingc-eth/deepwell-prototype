/**
 * Offline upload queue — Playwright harness (scripts/offline-queue-harness/):
 * mounts ScanTab alone against mocked /api/upload-url, /api/read-document and
 * /api/v1/intake-status calls, at 390px in both Office (dark) and Field
 * (light) theme (this feature is mobile-only — there is no desktop ScanTab
 * to check at 1280px).
 *
 * Per theme: emulate offline, capture a photo, confirm it lands in the
 * "Waiting to upload" strip (never lost, zero extra taps to get there); go
 * back online, confirm the queued upload actually fires and the strip
 * clears; then (dark theme only) a 413 ("file too large") scan is queued,
 * confirm it's kept with a plain message rather than retried forever, and
 * that the tech can delete it. Also checks: no horizontal overflow, no
 * console errors, every tap target (the strip's trash button) is >=44px.
 * Screenshots go to SHOT_DIR — look at them.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   npx tsx scripts/verify-offline-queue-ui.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

// A real, small image on disk already in the repo — used as the "photo" a
// tech captures. imagePrep.ts's preparePhoto() decodes it like any camera
// shot.
const FIXTURE_IMAGE = resolve(process.cwd(), 'public/m/icon-192.png');
// A second, DIFFERENT fixture (different bytes -> different sha256) for the
// 413 scenario below — reusing the first image would hash to the document
// already created in the online-recovery step and come back as an
// already-uploaded duplicate instead of ever reaching the fake 413 response.
const FIXTURE_IMAGE_2 = resolve(process.cwd(), 'public/m/icon-512.png');

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/* -------------------------------------------------------------- server -- */
// Same shape of fake server as scripts/verify-offline-queue.mjs, wired
// through Playwright's page.route instead of global.fetch — every "network"
// call the browser makes is inspected and counted so the test can assert not
// just what's on screen, but that the RIGHT calls did (or didn't) happen.
function makeFakeServer() {
  const bySha = new Map();
  let idSeq = 1;
  let mode = 'ok';
  const calls = { uploadUrl: 0, put: 0, readDocument: 0 };

  function body(status, data) {
    return { status, contentType: 'application/json', body: JSON.stringify(data) };
  }

  async function installOn(page) {
    await page.route('**/api/upload-url', async (route) => {
      calls.uploadUrl++;
      const req = JSON.parse(route.request().postData() || '{}');
      const existing = bySha.get(req.sha256);
      if (existing) return route.fulfill(body(200, { documentId: existing, alreadyUploaded: true }));
      if (mode === '413') return route.fulfill(body(413, { error: 'PDFs and photos have to be under 24 MB to be read.' }));
      const documentId = `doc-${idSeq++}`;
      bySha.set(req.sha256, documentId);
      return route.fulfill(body(200, { documentId, uploadUrl: `https://fake-upload.test/${documentId}`, alreadyUploaded: false }));
    });
    await page.route('https://fake-upload.test/**', async (route) => {
      calls.put++;
      return route.fulfill({ status: 200, body: '' });
    });
    await page.route('**/api/read-document', async (route) => {
      calls.readDocument++;
      const req = JSON.parse(route.request().postData() || '{}');
      return route.fulfill(body(200, { documentId: req.documentId, pages: 1 }));
    });
    await page.route('**/api/v1/intake-status**', async (route) => route.fulfill(body(200, { documents: [] })));
  }

  return { installOn, calls, setMode: (m) => (mode = m), documentCount: () => bySha.size };
}

/* ------------------------------------------------------------------ run - */
let url = () => {
  throw new Error('url() called before the dev server reported its port');
};

let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  let port = null;
  server.stdout.on('data', (d) => (out += String(d)));
  server.stderr.on('data', (d) => (out += String(d)));
  const ready = await Promise.race([
    new Promise((resolve) => {
      const check = () => {
        const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out);
        if (m) {
          port = Number(m[1]);
          resolve(true);
        }
      };
      server.stdout.on('data', check);
      check();
    }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a listening port within 8s:\n${out}`);
  url = () => `http://localhost:${port}/scripts/offline-queue-harness/harness.html`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/offline-queue-${name}.png`, fullPage: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(page, fn, { timeout = 6000, interval = 150 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > deadline) return false;
      await sleep(interval);
    }
  }

  async function run(label, dark) {
    const fake = makeFakeServer();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });
    await fake.installOn(page);

    await page.goto(url(), { waitUntil: 'networkidle' });
    await page.evaluate((on) => window.__dwSetDark?.(on), dark);
    await page.waitForTimeout(300);

    check(`${label}: harness mounted`, (await page.locator('[data-testid="scan-root"]').count()) > 0);

    /* ---- offline: capture -> saved to the queue, zero extra taps ---- */
    await page.context().setOffline(true);
    await page.setInputFiles('[data-testid="scan-files-input"]', FIXTURE_IMAGE);
    check(`${label}: the picked photo shows a thumbnail`, (await page.locator('img[alt="Page 1"]').count()) > 0);

    const uploadButton = page.getByRole('button', { name: /^Upload/ });
    await uploadButton.click();

    const reachedDone = await waitFor(page, async () => (await page.locator('[data-testid="offline-queue-strip"]').count()) > 0);
    check(`${label}: offline capture lands in the "Waiting to upload" strip`, reachedDone);
    check(`${label}: the strip shows exactly one waiting item`, (await page.getByText('Waiting to upload (1)').count()) > 0);
    check(`${label}: the result row explains why (no signal), not a raw error`, (await page.getByText(/no signal/i).count()) > 0);
    check(`${label}: no upload-url call was ever made while offline`, fake.calls.uploadUrl === 0, `calls=${fake.calls.uploadUrl}`);

    await shot(page, `${label}-1-offline`);

    /* ---- back online: the SAME queued item actually goes out on its own ---- */
    await page.context().setOffline(false);
    const drained = await waitFor(page, async () => (await page.locator('[data-testid="offline-queue-strip"]').count()) === 0);
    check(`${label}: back online, the queue drains on its own (no tap needed)`, drained);
    check(`${label}: the server actually received the upload`, fake.calls.uploadUrl >= 1 && fake.calls.readDocument >= 1, JSON.stringify(fake.calls));
    check(`${label}: exactly one document was created (the offline attempt never double-sent)`, fake.documentCount() === 1, `count=${fake.documentCount()}`);
    check(`${label}: onUploaded fired once the queued item landed`, (await page.evaluate(() => window.__dwUploaded)) > 0);

    await shot(page, `${label}-2-online`);

    if (label === 'dark') {
      /* ---- 413: kept, explained, deletable — never retried forever ---- */
      fake.setMode('413');
      await page.getByRole('button', { name: /Scan another/ }).click();
      await page.setInputFiles('[data-testid="scan-files-input"]', FIXTURE_IMAGE_2);
      await page.getByRole('button', { name: /^Upload/ }).click();
      const queued413 = await waitFor(page, async () => (await page.getByText(/too large|24 MB/i).count()) > 0);
      check(`${label}: a 413 is kept and plainly explained, not silently dropped`, queued413);

      const trash = page.locator('[data-testid="offline-queue-strip"] button[aria-label^="Remove"]').first();
      const box = await trash.boundingBox();
      check(`${label}: the delete control on a queued item is >=44px`, Boolean(box && box.width >= 44 && box.height >= 44));
      await trash.click();
      const removed = await waitFor(page, async () => (await page.locator('[data-testid="offline-queue-strip"]').count()) === 0);
      check(`${label}: the tech can delete a queued item`, removed);
      await shot(page, `${label}-3-413-deleted`);
    }

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow at 390px`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  await run('dark', true);
  await run('light', false);

  await browser.close();
} finally {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server?.kill(); }
}

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
