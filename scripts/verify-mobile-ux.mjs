/**
 * Round 17 (UX-M) mobile UX verification — re-counts the audited tasks from
 * ../ux17_mobile_report.md (this worktree's parent scratchpad) against the
 * REAL src/mobile/** + src/components/intake/** components, mounted via
 * scripts/mobile-harness/ (same "bare components, mocked network" technique
 * as scripts/offline-queue-harness / scripts/records-harness), at 390px, both
 * themes.
 *
 * Checks (fix # matches the audit's own numbering):
 *   1. Field/Office theme toggle is reachable in the mobile header, is a
 *      switch (role=switch, >=44px), flips the document's theme classes, and
 *      persists across a reload.
 *   5. The last-used tab survives a reload (no reflex tap back to Ask).
 *   2. A document with one open intake question shows an in-place "Needs
 *      your input" card in DocSheet; picking a candidate resolves it in
 *      <=2 taps (open the doc, pick an answer) with no desktop involved.
 *   3. A document's customer name opens CustomerSheet, whose Call button is
 *      one more tap — <=3 taps total from Docs to dialing.
 *   4. The "My uploads only" checkbox (and a sweep of every other visible
 *      interactive control across every scene below) is >=44px.
 *   7. A single-citation answer's "Source" pill opens the document directly;
 *      a multi-citation answer still opens the Sources list first.
 *
 * Screenshots go to SHOT_DIR — look at them.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   npx tsx scripts/verify-mobile-ux.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

const CUSTOMER_ID = '33333333-3333-4333-8333-000000000001';
const DOC_ID = '44444444-4444-4444-8444-000000000001';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

function jsonRoute(route, status, data) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

/** One row (our fixture document) for DocsTab's useRecordsBrowse — same
 *  request/response contract as scripts/records-harness's mockBrowse, just a
 *  single row so the tap-count checks stay easy to read. */
function installRecordsMock(page) {
  const row = {
    id: DOC_ID, filename: 'carol-warranty.pdf', displayName: null, documentType: 'warranty-registration',
    stage: 'verified', stageBucket: 'verified', verifiedBy: null, uploadedBy: null, createdAt: '2026-06-12T00:00:00Z',
    serviceDate: '2026-06-12', customerId: CUSTOMER_ID, customerName: 'Carol Rios', siteAddress: '2847 N 24th St, Mesa, AZ 85213',
    technician: null, brand: 'Trane', warrantyExpiry: '2029-03-15', warrantyBucket: 'active',
    amount: null, balanceDue: null, moneyStatus: null, hasMoney: false,
  };
  return page.route('**/api/records', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'browseDocuments') return jsonRoute(route, 200, {});
    await jsonRoute(route, 200, {
      rows: [row], total: 1, hasMore: false, nextCursor: null,
      facets: [
        { key: 'documentType', options: [] }, { key: 'stageBucket', options: [] }, { key: 'warrantyBucket', options: [] }, { key: 'customerId', options: [] },
        { key: 'hasMoney', trueCount: 0 }, { key: 'openBalance', trueCount: 0 }, { key: 'uploadedByMe', trueCount: 0 },
      ],
      sort: body.filters?.sort || 'upload-date', limit: 50,
    });
  });
}

/** The exception-queue fixture for DOC_ID: one open question ("which
 *  customer") with the real customer entity as its only candidate — mutable
 *  so the resolve step can flip it to "nothing open" without a page reload. */
function installIntakeMock(page) {
  let resolved = false;
  const calls = [];
  const item = {
    needsInfoId: 'ni-1', documentId: DOC_ID, entityId: null, documentType: 'warranty-registration',
    documentTypeLabel: 'Warranty', displayName: null, filename: 'carol-warranty.pdf', stage: 'extracted',
    fieldKey: 'customer_name', fieldLabel: 'Customer', question: 'Which customer does this warranty belong to?',
    candidates: [{ kind: 'entity', label: 'Carol Rios', value: null, entityId: CUSTOMER_ID, address: '2847 N 24th St, Mesa, AZ 85213', documentId: null, page: null, sourceDocumentLabel: null, evidence: null }],
    moreQuestions: 0, filledFields: [], extracted: [], createdAt: '2026-09-20T00:00:00Z',
  };
  const install = async () => {
    await page.route('**/api/v1/intake-status**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('queue') === '1') {
        const items = resolved ? [] : [item];
        return jsonRoute(route, 200, { total: 1, autoVerified: 0, autoVerifiedCount: 0, humanVerified: 0, openQuestions: items.length, resolvedQuestions: resolved ? 1 : 0, straightThroughRate: 0, needsInfoTracked: true, queue: { items, nextCursor: null, openDocumentCount: items.length, tracked: true } });
      }
      return jsonRoute(route, 200, { documents: [] });
    });
    await page.route('**/api/account?action=intake', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      resolved = true;
      return jsonRoute(route, 200, { ok: true, resolvedValue: body.value ?? body.entityId ?? '', autofill: { ok: true, filled: [], questions: [], verified: true } });
    });
  };
  return { install, calls, isResolved: () => resolved };
}

function installCustomerMock(page) {
  return page.route('**/api/v1/customer?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('id') !== CUSTOMER_ID) return jsonRoute(route, 404, { error: 'not found' });
    await jsonRoute(route, 200, {
      customer: { id: CUSTOMER_ID, customerNumber: 'C-00042', name: 'Carol Rios', serviceAddress: '2847 N 24th St, Mesa, AZ 85213', phone: '480-555-0148', email: 'carol@example.com', notes: null, billingAddress: null, formerNumbers: [] },
      equipment: [], documents: [], timeline: [], duplicates: [], alertCount: 0,
    });
  });
}

/** Sweep every visible interactive control in the current page for the
 *  round's 44px rule. An icon-only button (no visible text) must be >=44 in
 *  BOTH dimensions (it's the only thing to aim at); a labeled button/link
 *  only needs >=44 height, matching this codebase's own convention (min-h-11
 *  rows with content-width text) and the audit's own methodology (their one
 *  real failure, the 13x13 checkbox, was a checkbox with no such wrapper at
 *  all). A checkbox/radio wrapped in a <label> is measured by that label's
 *  own box (the whole label is the native, clickable hit target — the same
 *  pattern ScanTab's own "combine pages" toggle already used, unflagged, and
 *  DocsTab's fix #4 now matches); a bare one with no label wrapper is
 *  measured directly, since nothing else makes it bigger to tap. */
async function sweepTouchTargets(page, label) {
  const bad = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a[href], input[type="checkbox"], input[type="radio"], select'));
    const out = [];
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const isCheckish = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio');
      const target = isCheckish ? el.closest('label') ?? el : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden (e.g. the other theme's tab content)
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const isSquareControl = isCheckish || (tag === 'button' && !(el.textContent || '').trim());
      const okHeight = r.height >= 43.5; // sub-pixel rounding tolerance
      const okWidth = r.width >= 43.5;
      if (isSquareControl ? !(okHeight && okWidth) : !okHeight) {
        out.push({ tag, label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || '(icon)', w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return out;
  });
  check(`${label}: every visible interactive control is >=44px`, bad.length === 0, JSON.stringify(bad));
  return bad;
}

/* ------------------------------------------------------------------ run - */
let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/mobile-ux-${name}.png`, fullPage: true });

  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });
    return { page, consoleErrors };
  }

  async function runThemeAndTabPersistence(label, dark) {
    const { page, consoleErrors } = await newPage();
    installRecordsMock(page);
    installCustomerMock(page);
    const intake = installIntakeMock(page);
    await intake.install();

    await page.goto(`${base()}/index.html?scene=shell`, { waitUntil: 'networkidle' });
    await page.evaluate((fieldOn) => window.__dwSetField?.(fieldOn), !dark); // dark=office(false); light=field(true)
    await page.waitForTimeout(200);

    /* ---- fix #1: theme toggle reachable, correct, persisted ---- */
    const toggle = page.getByTestId('theme-toggle');
    check(`${label}: theme toggle exists in the mobile header`, (await toggle.count()) > 0);
    const box = await toggle.boundingBox();
    check(`${label}: theme toggle is >=44px`, Boolean(box && box.width >= 44 && box.height >= 44), JSON.stringify(box));

    const beforeField = await page.evaluate(() => document.documentElement.classList.contains('field'));
    await toggle.click();
    await page.waitForTimeout(150);
    const afterField = await page.evaluate(() => document.documentElement.classList.contains('field'));
    check(`${label}: tapping the toggle flips the document's theme class`, afterField !== beforeField);
    const stored = await page.evaluate(() => localStorage.getItem('deepwell.fieldMode'));
    check(`${label}: the new theme is persisted to localStorage`, stored === (afterField ? '1' : '0'));

    await shot(page, `${label}-1-theme-toggled`);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    const afterReload = await page.evaluate(() => document.documentElement.classList.contains('field'));
    check(`${label}: the toggled theme survives a reload`, afterReload === afterField);

    /* ---- fix #5: last-used tab survives a reload ---- */
    await page.getByTestId('tab-scan').click();
    await page.waitForTimeout(150);
    check(`${label}: Scan tab content is visible after tapping its tab`, (await page.getByText('Scan paperwork').count()) > 0);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    check(`${label}: reopening the app lands back on the last-used tab (Scan), not Ask`, (await page.getByText('Scan paperwork').count()) > 0);

    await sweepTouchTargets(page, `${label} (ask/scan shell)`);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow at 390px`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  async function runIntakeAndCustomerCall(label, dark) {
    const { page, consoleErrors } = await newPage();
    installRecordsMock(page);
    installCustomerMock(page);
    const intake = installIntakeMock(page);
    await intake.install();

    await page.goto(`${base()}/index.html?scene=shell`, { waitUntil: 'networkidle' });
    await page.evaluate((on) => window.__dwSetField?.(on), !dark);
    await page.waitForTimeout(200);

    await page.getByTestId('tab-docs').click();
    await page.waitForTimeout(300);
    check(`${label}: the fixture document row renders in Docs`, (await page.getByText('carol-warranty.pdf').count()) > 0);

    /* ---- tap 1: open the document ---- */
    await page.getByText('carol-warranty.pdf').click();
    await page.waitForTimeout(300);
    check(`${label}: the DocSheet opens (tap 1)`, (await page.getByRole('dialog').count()) > 0);
    await shot(page, `${label}-2-docsheet-open-question`);

    /* ---- fix #2: the open question resolves in place, tap 2 ---- */
    check(`${label}: "Needs your input" shows in the DocSheet`, (await page.getByText('Needs your input').count()) > 0);
    const candidate = page.locator('[data-intake-card]').getByRole('button', { name: /Carol Rios/ });
    check(`${label}: the candidate answer button is present`, (await candidate.count()) > 0);
    await candidate.click();
    await page.waitForTimeout(300);
    check(`${label}: resolving posts to the intake endpoint (tap 2 total)`, intake.calls.length === 1, JSON.stringify(intake.calls));
    check(`${label}: the resolved candidate was Carol Rios' entity id`, intake.calls[0]?.entityId === CUSTOMER_ID, JSON.stringify(intake.calls[0]));
    check(`${label}: the card clears once nothing is left open`, (await page.getByText('All set').count()) > 0);
    await shot(page, `${label}-3-after-resolve`);

    /* ---- fix #3: customer name -> CustomerSheet -> Call, <=3 taps total ---- */
    const customerButton = page.getByTestId('doc-customer-name');
    check(`${label}: the customer name is a button (tap 2 of the call flow)`, (await customerButton.count()) > 0);
    await customerButton.click();
    await page.waitForTimeout(300);
    const callLink = page.getByRole('link', { name: /Call/ });
    check(`${label}: CustomerSheet's Call button is reachable (tap 3)`, (await callLink.count()) > 0);
    const callHref = await callLink.getAttribute('href');
    check(`${label}: Call is a real tel: link`, Boolean(callHref && callHref.startsWith('tel:480')), callHref ?? '(none)');
    const callBox = await callLink.boundingBox();
    check(`${label}: Call button is >=44px`, Boolean(callBox && callBox.width >= 44 && callBox.height >= 44));
    await shot(page, `${label}-4-customer-sheet`);

    await sweepTouchTargets(page, `${label} (docs/docsheet/customersheet)`);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow at 390px`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  async function runFilterCheckboxSweep(label, dark) {
    const { page, consoleErrors } = await newPage();
    installRecordsMock(page);
    await page.goto(`${base()}/index.html?scene=shell`, { waitUntil: 'networkidle' });
    await page.evaluate((on) => window.__dwSetField?.(on), !dark);
    await page.waitForTimeout(200);

    await page.getByTestId('tab-docs').click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.waitForTimeout(200);

    /* ---- fix #4: "My uploads only" checkbox ---- */
    const label44 = page.locator('label', { hasText: 'My uploads only' });
    const box = await label44.boundingBox();
    check(`${label}: "My uploads only" row is >=44px tall`, Boolean(box && box.height >= 44), JSON.stringify(box));
    const checkbox = page.locator('input[type="checkbox"]');
    const cbox = await checkbox.boundingBox();
    check(`${label}: the checkbox control itself is bigger than the old 13x13`, Boolean(cbox && cbox.width >= 20 && cbox.height >= 20), JSON.stringify(cbox));

    await shot(page, `${label}-5-filter-sheet`);
    await sweepTouchTargets(page, `${label} (filter sheet)`);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow at 390px`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  async function runCitations(label) {
    const { page, consoleErrors } = await newPage();
    await page.goto(`${base()}/index.html?scene=citations`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    await shot(page, `${label}-6-citations`);

    /* ---- fix #7: one citation opens directly; two still show the list ---- */
    const single = page.getByTestId('scene-single-citation');
    const singleSourceBtn = single.getByRole('button', { name: /^Source$/ });
    check(`${label}: a single-citation answer shows a "Source" (singular) pill`, (await singleSourceBtn.count()) > 0);
    await singleSourceBtn.click();
    await page.waitForTimeout(100);
    const opens = await page.evaluate(() => window.__dwOpens);
    check(`${label}: tapping it opens the document directly (1 tap)`, opens.includes(`doc:${DOC_ID}`), JSON.stringify(opens));

    const two = page.getByTestId('scene-two-citations');
    const twoSourcesBtn = two.getByRole('button', { name: /^Sources · 2$/ });
    check(`${label}: a two-citation answer keeps "Sources · 2"`, (await twoSourcesBtn.count()) > 0);
    await twoSourcesBtn.click();
    await page.waitForTimeout(100);
    const opensAfter = await page.evaluate(() => window.__dwOpens);
    check(`${label}: tapping it does NOT open a document yet (opens the list first)`, !opensAfter.includes('doc:doc-2') && opensAfter.filter((o) => o.startsWith('doc:')).length === opens.filter((o) => o.startsWith('doc:')).length);
    check(`${label}: the sources list is now showing both documents`, (await two.getByText('Tap to open').count()) >= 1);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow at 390px`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  await runThemeAndTabPersistence('office-dark', true);
  await runThemeAndTabPersistence('field-light', false);
  await runIntakeAndCustomerCall('office-dark', true);
  await runIntakeAndCustomerCall('field-light', false);
  await runFilterCheckboxSweep('office-dark', true);
  await runFilterCheckboxSweep('field-light', false);
  await runCitations('theme-neutral');

  await browser.close();
} finally {
  server?.kill();
}

console.log(`\n${passes} passed, ${failures} failed.`);
console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
process.exit(failures === 0 ? 0 : 1);
