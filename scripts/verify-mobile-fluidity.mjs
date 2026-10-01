/**
 * Round 23 (M1) mobile FLUIDITY verification — jank, not correctness.
 * verify-mobile-ux.mjs already covers taps/behaviour; this one walks the same
 * real src/mobile/** components (via scripts/mobile-harness/, the same
 * "bare components, mocked network" shell used there and by
 * offline-queue-harness/records-harness) under real-world phone conditions —
 * 4x CPU throttle + "Slow 4G" network (Chrome DevTools' own preset: 400 Kbps
 * down/up, 400 ms RTT) — on three device emulations (iPhone 13, iPhone SE,
 * Pixel 7) and asserts:
 *
 *   1. No single long task > 80 ms during any key interaction (tab switch,
 *      sheet open/close, typing, ask submit + answer render, filter sheet).
 *      80 ms (tightened from 100 in R36; the usual 50 ms is unreachable here)
 *      because this budget is measured WHILE 4x-throttled — an unthrottled
 *      "no task > 50ms" turns into "no task > ~12.5ms real work", which is
 *      what actually keeps INP low once the throttle comes off; 80ms
 *      throttled catches genuine offenders without flagging React/dev-mode
 *      noise as failures. Each interaction prints its worst task ("[lt]")
 *      whether or not it passes, so a regression shows up as a creeping number.
 *   2. CLS < 0.05 specifically on answer render and on every sheet open
 *      (DocSheet, CustomerSheet, the Filters sheet) — measured as the delta
 *      logged during that one interaction, not the whole session, so an
 *      unrelated shift earlier in the walk can't mask (or fail) one later.
 *   3. The mobile entry chunk (dist/assets/mobile-*.js, gzip) stays under
 *      MOBILE_ENTRY_BUDGET_GZIP (23 KB since R36; the sheets, account menu
 *      and install guide are lazy chunks prefetched at idle) — this is the mobile-SPECIFIC bundle (the
 *      shared Clerk/Wordmark/jsx-runtime chunks it modulepreloads are common
 *      to every DeepWell surface, including desktop, and aren't this budget's
 *      job to police).
 *   4. Zero console errors / pageerrors across the entire walk, every device.
 *   5. Every <input>/<textarea>/<select> actually reachable on phone computes
 *      to >=16px font-size (the iOS auto-zoom guard) — swept live, not just
 *      grepped from mobile.css, so a future one-off inline style can't slip
 *      through unnoticed.
 *
 * Screenshots (before/after the walk, per device) go to SHOT_DIR — look at
 * them.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   npm run build   (VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy — for check 3)
 *   npx tsx scripts/verify-mobile-fluidity.mjs [screenshotDir]
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

const CUSTOMER_ID = '33333333-3333-4333-8333-000000000001';
const DOC_ID = '44444444-4444-4444-8444-000000000001';

/** Throttled-budget: see the file comment above for why this isn't 50ms. */
const LONG_TASK_BUDGET_MS = 80;
const CLS_BUDGET = 0.05;
/** The mobile entry chunk alone, gzip. R23 baseline ~22.5 KB; R36: 21.2 KB after moving the sheets out. */
const MOBILE_ENTRY_BUDGET_GZIP = 23 * 1024;

/** "Slow 4G" (Chrome DevTools' own preset: ~400 Kbps, 400ms RTT) applied as
 *  a per-response delay on every mocked API call below, rather than as a
 *  real CDP `Network.emulateNetworkConditions` on the whole page: this
 *  harness's dev-mode Vite server serves the app as hundreds of individual
 *  ES module requests (unlike the single bundled chunk a real phone would
 *  fetch from the production build), so throttling the actual transport
 *  makes the FIRST LOAD take minutes for a reason that has nothing to do
 *  with this app's own code — a real regression there would be invisible
 *  under that noise. Delaying each mocked response by the same round-trip
 *  time a slow-4G phone would see reproduces the thing that actually matters
 *  for jank — the app waiting on a real response, mid-interaction — without
 *  that confound. Cold-start's actual network cost is covered separately by
 *  the mobile-entry bundle-size budget above (check 3), which is what a real
 *  phone on Slow 4G would be waiting on. CPU throttling below IS the real
 *  CDP throttle, and it runs for the whole walk on every device.
 */
const SLOW_4G_RTT_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/* --------------------------------------------------------- bundle size -- */
function checkMobileEntryBudget() {
  let dir;
  try {
    dir = readdirSync('dist/assets');
  } catch {
    check('mobile entry chunk is under budget (gzip)', false, 'dist/assets not found — run the build first (npm run build)');
    return;
  }
  const mobileEntry = dir.find((f) => /^mobile-.*\.js$/.test(f));
  if (!mobileEntry) {
    check('mobile entry chunk is under budget (gzip)', false, 'no dist/assets/mobile-*.js — check vite.config.ts\'s mobile input');
    return;
  }
  const bytes = readFileSync(`dist/assets/${mobileEntry}`);
  const gzip = gzipSync(bytes).length;
  check(
    `mobile entry chunk (${mobileEntry}) is under ${(MOBILE_ENTRY_BUDGET_GZIP / 1024).toFixed(0)} KB gzip`,
    gzip <= MOBILE_ENTRY_BUDGET_GZIP,
    `${(gzip / 1024).toFixed(1)} KB gzip (${(bytes.length / 1024).toFixed(1)} KB raw)`
  );
  return { file: mobileEntry, rawBytes: bytes.length, gzipBytes: gzip };
}

/* ------------------------------------------------------------- mocks --- */
function jsonRoute(route, status, data) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

function installRecordsMock(page) {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i === 0 ? DOC_ID : `doc-${i}`,
    filename: i === 0 ? 'carol-warranty.pdf' : `work-order-${i}.pdf`,
    displayName: null,
    documentType: 'warranty-registration',
    stage: 'verified',
    stageBucket: 'verified',
    verifiedBy: null,
    uploadedBy: null,
    createdAt: '2026-06-12T00:00:00Z',
    serviceDate: '2026-06-12',
    customerId: CUSTOMER_ID,
    customerName: 'Carol Rios',
    siteAddress: '2847 N 24th St, Mesa, AZ 85213',
    technician: null,
    brand: 'Trane',
    warrantyExpiry: '2029-03-15',
    warrantyBucket: 'active',
    amount: null,
    balanceDue: null,
    moneyStatus: null,
    hasMoney: false,
  }));
  return page.route('**/api/records', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await sleep(SLOW_4G_RTT_MS);
    if (body.action !== 'browseDocuments') return jsonRoute(route, 200, {});
    await jsonRoute(route, 200, {
      rows, total: rows.length, hasMore: false, nextCursor: null,
      facets: [
        { key: 'documentType', options: [] }, { key: 'stageBucket', options: [] }, { key: 'warrantyBucket', options: [] }, { key: 'customerId', options: [] },
        { key: 'hasMoney', trueCount: 0 }, { key: 'openBalance', trueCount: 0 }, { key: 'uploadedByMe', trueCount: 0 },
      ],
      sort: body.filters?.sort || 'upload-date', limit: 50,
    });
  });
}

function installCustomerMock(page) {
  return page.route('**/api/v1/customer?**', async (route) => {
    const url = new URL(route.request().url());
    await sleep(SLOW_4G_RTT_MS);
    if (url.searchParams.get('id') !== CUSTOMER_ID) return jsonRoute(route, 404, { error: 'not found' });
    await jsonRoute(route, 200, {
      customer: { id: CUSTOMER_ID, customerNumber: 'C-00042', name: 'Carol Rios', serviceAddress: '2847 N 24th St, Mesa, AZ 85213', phone: '480-555-0148', email: 'carol@example.com', notes: null, billingAddress: null, formerNumbers: [] },
      equipment: [{ id: 'u-1', manufacturer: 'Trane', model: 'XR16', serial: 'SN-1', warranty: { daysLeft: 900, expires: '2029-03-15' } }],
      documents: [], timeline: [], duplicates: [], alertCount: 0,
    });
  });
}

function installIntakeMock(page) {
  return page.route('**/api/v1/intake-status**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('queue') === '1') {
      return jsonRoute(route, 200, {
        total: 0, autoVerified: 0, autoVerifiedCount: 0, humanVerified: 0, openQuestions: 0, resolvedQuestions: 0,
        straightThroughRate: 0, needsInfoTracked: true, queue: { items: [], nextCursor: null, openDocumentCount: 0, tracked: true },
      });
    }
    return jsonRoute(route, 200, { documents: [] });
  });
}

/* ------------------------------------------------------ perf plumbing -- */
/** Installed before any navigation: buffers long tasks and layout shifts so
 *  each phase of the walk can snapshot-and-reset its own window instead of
 *  fighting over one running total. Also counts INP-ish "event" entries for
 *  the report (informational only — no budget asserted on it here). */
function installPerfCollector(page) {
  return page.addInitScript(() => {
    window.__perf = { longTasks: [], cls: 0, clsEntries: [], events: [] };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__perf.cls += e.value;
          window.__perf.clsEntries.push({ start: e.startTime, value: e.value });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* not supported */ }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__perf.events.push({ start: e.startTime, dur: e.duration, name: e.name });
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch { /* not supported */ }
  });
}

async function resetPerf(page) {
  await page.evaluate(() => {
    window.__perf.longTasks = [];
    window.__perf.cls = 0;
    window.__perf.clsEntries = [];
  });
}

async function readPerf(page) {
  return page.evaluate(() => ({ longTasks: window.__perf.longTasks, cls: window.__perf.cls }));
}

/** Runs one interaction, settles a beat for observers to flush, then asserts
 *  the long-task budget (always) and, when `clsBudget` is given, CLS too. */
async function measure(page, label, clsBudget, fn) {
  await resetPerf(page);
  await fn();
  await page.waitForTimeout(250); // let layout-shift/longtask entries land
  const { longTasks, cls } = await readPerf(page);
  const worst = longTasks.reduce((m, t) => Math.max(m, t.dur), 0);
  console.log(`  [lt] ${label}: worst=${worst.toFixed(0)}ms n=${longTasks.length}${cls ? ` cls=${cls.toFixed(4)}` : ''}`);
  check(`${label}: no long task > ${LONG_TASK_BUDGET_MS}ms (4x CPU)`, worst <= LONG_TASK_BUDGET_MS, `worst=${worst.toFixed(1)}ms, count=${longTasks.length}`);
  if (clsBudget != null) {
    check(`${label}: CLS < ${clsBudget}`, cls < clsBudget, `cls=${cls.toFixed(4)}`);
  }
}

/* ------------------------------------------------------------------ run - */
let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  let port = null;
  server.stdout.on('data', (d) => (out += String(d)));
  server.stderr.on('data', (d) => (out += String(d)));
  const ready = await Promise.race([
    new Promise((resolve) => {
      const found = () => {
        const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out);
        if (m) {
          port = Number(m[1]);
          resolve(true);
        }
      };
      server.stdout.on('data', found);
      found();
    }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a listening port within 8s:\n${out}`);
  const base = () => `http://localhost:${port}/scripts/mobile-harness`;
  await new Promise((r) => setTimeout(r, 400));

  checkMobileEntryBudget();

  const browser = await chromium.launch();

  const DEVICE_PROFILES = [
    { name: 'iPhone-13', descriptor: devices['iPhone 13'] },
    { name: 'iPhone-SE', descriptor: devices['iPhone SE'] },
    { name: 'Pixel-7', descriptor: devices['Pixel 7'] },
  ];

  async function runDevice({ name, descriptor }) {
    const context = await browser.newContext({ ...descriptor, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });

    await installPerfCollector(page);
    installRecordsMock(page);
    installCustomerMock(page);
    installIntakeMock(page);

    // Cold start itself is measured unthrottled (see the SLOW_4G_RTT_MS
    // comment above for why real network throttling can't apply to this
    // dev-mode harness) — the 4x CPU throttle below then applies to every
    // interaction for the rest of the walk, which is where main-thread jank
    // actually shows up.
    const t0 = Date.now();
    await page.goto(`${base()}/index.html?scene=shell`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('[data-testid="mobile-shell"]', { timeout: 20000 });
    const coldStartMs = Date.now() - t0;
    console.log(`  ${name}: cold start to shell visible (unthrottled dev server) = ${coldStartMs}ms`);
    // The idle-time sheet-chunk prefetch (MobileApp.tsx does the same once signed in) settles in the seconds between
    // launching the app and the first tap on a real phone; wait for it here so a dev-server module compile of the
    // lazy sheets can't land inside a measured interaction. (Bounded: a prefetch that never finishes is itself a failure.)
    const prefetched = await page.waitForFunction(() => window.__dwPrefetchDone === true, null, { timeout: 15000 }).then(() => true, () => false);
    check(`${name}: sheet chunks prefetched during idle after launch`, prefetched);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/fluidity-${name}-1-launch.png` });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    // 2. Ask tab: typing must not spend a long task per keystroke (Composer
    //    owning its own state is the whole point of that pattern — this is
    //    what actually proves it under load).
    const composer = page.getByPlaceholder('Ask Donovan…');
    await measure(page, `${name}/ask-type`, null, async () => {
      await composer.click();
      await composer.type('Is the Trane under warranty at 2847 N 24th St', { delay: 30 });
    });

    // 3. Submit + answer render (mock provider, ~220ms deterministic delay) —
    //    the CLS-on-answer-render check.
    await measure(page, `${name}/ask-submit-answer-render`, CLS_BUDGET, async () => {
      await composer.press('Enter');
      await page.waitForSelector('[data-turn]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
    });
    await page.screenshot({ path: `${SHOT_DIR}/fluidity-${name}-2-answer.png` });

    // 4. Tab switches: Ask -> Scan -> Docs -> Ask (all three stay mounted;
    //    this is a display:none toggle, not a mount/unmount).
    await measure(page, `${name}/tab-switch-to-scan`, null, () => page.getByTestId('tab-scan').click());
    await measure(page, `${name}/tab-switch-to-docs`, null, () => page.getByTestId('tab-docs').click());
    await page.waitForTimeout(200);

    // 5. Docs list scroll (40-row fixture) — scroll performance / re-render check.
    const vp = page.viewportSize() ?? { width: 390, height: 844 };
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await measure(page, `${name}/docs-list-scroll`, null, async () => {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(150);
      await page.mouse.wheel(0, -1200);
    });

    // 6. Open DocSheet — sheet-open CLS + long-task check.
    await measure(page, `${name}/doc-sheet-open`, CLS_BUDGET, async () => {
      await page.getByText('carol-warranty.pdf').first().click();
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      await page.waitForTimeout(200);
    });
    await page.screenshot({ path: `${SHOT_DIR}/fluidity-${name}-3-docsheet.png` });

    // Sheet.tsx renders TWO elements with aria-label="Close" — the full-screen
    // backdrop button (tabIndex=-1, dismiss-by-tap-outside) and the real X
    // button in the header, in that DOM order — so `.last()` is the one an
    // actual thumb taps; `.first()` is often geometrically covered by the
    // panel itself (correct behaviour: tapping the panel must not dismiss it)
    // and Playwright's real hit-testing correctly refuses to "click" it.
    const closeSheetButton = () => page.getByRole('button', { name: 'Close' }).last();

    // 7. Doc's customer name -> CustomerSheet (replaces DocSheet — MobileApp
    //    only ever has one sheet open at a time, never stacked).
    await measure(page, `${name}/customer-sheet-open`, CLS_BUDGET, async () => {
      await page.getByTestId('doc-customer-name').click();
      await page.waitForTimeout(250);
    });

    // 8. Close the sheet.
    await measure(page, `${name}/sheet-close`, null, async () => {
      await closeSheetButton().click();
      await page.waitForTimeout(150);
    });

    // 9. Docs filter sheet open/close.
    await measure(page, `${name}/filter-sheet-open`, CLS_BUDGET, async () => {
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.waitForTimeout(200);
    });
    await measure(page, `${name}/filter-sheet-close`, null, async () => {
      await closeSheetButton().click();
      await page.waitForTimeout(150);
    });

    // 10. Keyboard open/close (focus/blur the search input) — tab bar hide/show.
    await measure(page, `${name}/keyboard-open-close`, null, async () => {
      await page.getByPlaceholder('Customer, address, serial…').click();
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByPlaceholder('Customer, address, serial…').blur();
      await page.waitForTimeout(150);
    });

    // 11. Input font-size sweep (iOS auto-zoom guard) — every reachable
    //     input/textarea/select actually gets to 16px, not just mobile.css's
    //     rule existing.
    await page.getByTestId('tab-ask').click().catch(() => {});
    const smallInputs = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, textarea, select'));
      return els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), fontSize: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((el) => el.fontSize < 16);
    });
    check(`${name}: every visible input/textarea/select is >=16px font-size (no iOS zoom-on-focus)`, smallInputs.length === 0, JSON.stringify(smallInputs));

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${name}: no horizontal overflow`, !overflowX);
    check(`${name}: zero console errors across the whole walk`, consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

    await context.close();
  }

  for (const profile of DEVICE_PROFILES) {
    console.log(`\n=== ${profile.name} (4x CPU, Slow 4G) ===`);
    await runDevice(profile);
  }

  await browser.close();
} finally {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server?.kill(); }
}

console.log(`\n${passes} passed, ${failures} failed.`);
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures === 0 ? 0 : 1);
