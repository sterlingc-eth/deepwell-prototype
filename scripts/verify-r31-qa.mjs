/**
 * R31 QA regression checks: one section per fix from the R31 QA / continuous-improvement rounds
 * (handoffs/QA_R31.md has the findings table; section numbers here match its IDs).
 *
 *   L1-A  Customers tab pages through the whole customer list (was: first 200 only, rest unfindable)
 *   L1-B  status ink tokens readable on the DARK surface (error lines, "Empty this shop's documents" card + button)
 *   L1-C  Field (light) phone theme: accent text/labels meet 4.5:1
 *   L1-D  desktop header: labels never wrap onto two lines; long shop name cannot stretch it; no overflow 1024-1920
 *   L1-E  phone header no longer shows a shop name truncated to "Sunris…"
 *   L1-F  website hero demo: focusing the field mid-animation lets the visitor's text replace the demo text
 *   L2-A  browser error reporter: scrubbing, noise filter, ring buffer, diagnostics block (pure)
 *   L2-B  server: client-error validation/limiter/route, handoff accepts kind:'problem' + diagnostics
 *   L2-C  in-app "Report a problem" (desktop + phone) and the automatic crash report
 *   L2-D  Billing: usage meters + near-limit nudge, unambiguous cancel date
 *   L2-E  phone-width layout: warranty-export unit picker and footer clear of the Help launcher
 *   L3-A  a crashed screen: card offers a mailto to support, and the render error is auto-reported once (scrubbed)
 *
 *   npx tsx scripts/verify-r31-qa.mjs [screenshotDir]
 */
import path from 'node:path';
import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { startServer, REPO } from './app-qa-harness/serve.mjs';
import { installBackend, makeData } from './app-qa-harness/backend.mjs';
import { scrubText, deviceFamily, whereFrom, recordClientError, getRecentClientErrors, buildDiagnostics, _resetForTest } from '../src/services/errorReporter.ts';
import { usageMeter, longDate } from '../src/core/usageMeter.ts';
import { validateClientError, clientErrorLogLine } from '../api/_lib/support/clientError.js';
import { validateHandoff, buildHandoffEmail } from '../api/_lib/support/handoff.js';
import { createLimiter } from '../api/_lib/support/limits.js';
import { mergeCustomerPages, mergeDuplicatePairs, customerCountLabel, CUSTOMER_PAGE_SIZE } from '../src/core/customerPaging.ts';

const SHOT_DIR = process.argv[2] ?? path.join(REPO, '..', 'qa-r31-shots', 'verify');
mkdirSync(SHOT_DIR, { recursive: true });

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* ---------------------------------------------------------------- shared browser helpers */
const { chromium } = await import('playwright');
const { server, base } = await startServer();
const mobileBase = base.replace('index.html', 'mobile.html');
const browser = await chromium.launch();

async function open({ auth = {}, backend = {}, vp = { width: 1280, height: 800 }, field = false, mobile = false, url = '', setup } = {}) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(`console: ${m.text().slice(0, 160)}`);
  });
  await page.addInitScript(({ a, f }) => {
    window.__QA_AUTH = a;
    window.__DEEPWELL_FORCE_ERROR_REPORT__ = true; // R34: harness pages (localhost) never report unless they opt in; this suite asserts the report payload
    if (f) localStorage.setItem('deepwell.fieldMode', '1');
  }, { a: auth, f: field });
  await installBackend(page, backend);
  if (setup) await setup(page); // routes registered after installBackend win
  await page.goto((mobile ? mobileBase : base) + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  page.__errs = errs;
  return page;
}
const go = async (page, screen) => {
  await page.evaluate((s) => window.__store.getState().setCurrentScreen(s), screen);
  await page.waitForTimeout(500);
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });

/** WCAG contrast of an element's text against its first opaque ancestor background (in page context). */
const contrastOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bg = null;
    for (let cur = el; cur && cur.nodeType === 1 && !bg; cur = cur.parentElement) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a >= 0.99) bg = c; }
    bg ??= { r: 255, g: 255, b: 255, a: 1 };
    const fg = parse(getComputedStyle(el).color);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }, selector);

try {
  /* ============================================ L1-A: customers paging ============================================ */
  {
    // unit: helpers
    const c = (id, name = id) => ({ id, name });
    const merged = mergeCustomerPages([c('a'), c('b')], [c('b'), c('c')]);
    check('L1-A unit: mergeCustomerPages keeps order and drops repeats', merged.map((x) => x.id).join() === 'a,b,c');
    check('L1-A unit: mergeCustomerPages(existing, []) is the same array', (() => { const e = [c('a')]; return mergeCustomerPages(e, []) === e; })());
    const dp = (k, d) => ({ keepId: k, dropId: d, score: 1, tier: 'auto', evidence: {}, reason: '' });
    check('L1-A unit: a duplicate pair reported by two pages is kept once (either order)', mergeDuplicatePairs([dp('a', 'b')], [dp('b', 'a'), dp('c', 'd')]).length === 2);
    check('L1-A unit: label complete', customerCountLabel({ shown: 450, loaded: 450, total: 450, activeCount: 0, loadingMore: false }) === '450 customers');
    check('L1-A unit: label 1 customer is singular', customerCountLabel({ shown: 1, loaded: 1, total: 1, activeCount: 0, loadingMore: false }) === '1 customer');
    check('L1-A unit: label filtered', customerCountLabel({ shown: 3, loaded: 450, total: 450, activeCount: 2, loadingMore: false }) === '3 of 450 customers · 2 filters');
    check('L1-A unit: label loading more never claims a full list', /^Showing 200 of 1,530 customers · loading the rest…$/.test(customerCountLabel({ shown: 200, loaded: 200, total: 1530, activeCount: 0, loadingMore: true })));
    check('L1-A unit: label incomplete + idle says search covers everyone', /search looks through all 1,530$/.test(customerCountLabel({ shown: 200, loaded: 200, total: 1530, activeCount: 0, loadingMore: false })));
    check('L1-A unit: label surfaces a page failure', /couldn't load the rest/.test(customerCountLabel({ shown: 200, loaded: 200, total: 1530, activeCount: 0, loadingMore: false, moreError: "couldn't load the rest (x)" })));
    check('L1-A unit: page size is the API max (200)', CUSTOMER_PAGE_SIZE === 200);

    // browser: fake paged /api/v1/customers with 450 customers
    const N = 450;
    const all = makeData({ docs: 0, customers: N }).custRows.map((r, i) => ({ ...r, name: `Customer ${String(i + 1).padStart(3, '0')}`, phone: `480555${String(1000 + i)}` }));
    const requests = [];
    const pagedRoute = (failAfterFirst) => async (page) => {
      await page.route('**/api/v1/customers**', (route) => {
        const u = new URL(route.request().url());
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const limit = Number(u.searchParams.get('limit') || 200);
        const offset = u.searchParams.get('cursor') ? Number(u.searchParams.get('cursor')) : 0;
        requests.push(`${q ? 'q=' + q + ' ' : ''}offset=${offset} limit=${limit}`);
        if (failAfterFirst && !q && offset > 0) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
        const pool = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
        const rows = pool.slice(offset, offset + limit);
        const next = offset + rows.length < pool.length ? String(offset + rows.length) : null;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ customers: rows, duplicates: [], possibleDuplicates: [], total: pool.length, nextCursor: next }) });
      });
    };
    const openCustomers = async (failAfterFirst) => {
      requests.length = 0;
      const page = await open({ backend: { docs: 5, customers: 6 }, setup: pagedRoute(failAfterFirst) });
      await go(page, 'browse');
      await page.getByRole('tab', { name: 'Customers' }).click();
      await page.waitForTimeout(1500);
      return page;
    };

    let page = await openCustomers(false);
    const count = async () => (await page.getByTestId('customers-count').innerText()).replace(/\s+/g, ' ').trim();
    check('L1-A: all 450 customers are loaded (3 pages) and the footer says so', (await count()) === '450 customers', `${await count()} | ${requests.join(' ; ')}`);
    check('L1-A: pages were requested with a cursor, 200 at a time', requests.length === 3 && requests[1] === 'offset=200 limit=200' && requests[2] === 'offset=400 limit=200', requests.join(' ; '));
    await page.getByLabel('Search customers').fill('Customer 433');
    await page.waitForTimeout(400);
    check('L1-A: customer #433 (beyond the first 200) is findable by name', (await page.locator('tbody tr').count()) === 1 && /Customer 433/.test(await page.locator('tbody').innerText()));
    await page.getByLabel('Search customers').fill('4805551433'); // phone of #434 index 433 -> phone search stays client-side
    await page.waitForTimeout(300);
    check('L1-A: phone search also reaches beyond the first 200', (await page.locator('tbody tr').count()) === 1, `${await page.locator('tbody tr').count()} rows`);
    await shot(page, 'customers-paged-450');
    await page.context().close();

    page = await openCustomers(true);
    check('L1-A: a failed later page keeps the first 200 rows and says what happened', /^Showing 200 of 450 customers · couldn't load the rest/.test(await count()), await count());
    await page.getByLabel('Search customers').fill('Customer 433');
    await page.waitForTimeout(900);
    check('L1-A: with rows missing, search asks the server and still finds #433', (await page.locator('tbody tr').count()) === 1 && requests.some((r) => r.startsWith('q=customer 433')), `${await page.locator('tbody tr').count()} rows | ${requests.join(' ; ')}`);
    await page.getByLabel('Search customers').fill('');
    await page.waitForTimeout(300);
    check('L1-A: clearing the search drops the server-only rows again', (await page.locator('tbody tr').count()) === 200);
    await page.context().close();

    page = await open({ backend: { docs: 5, customers: 6 } }); // plain harness route: no total/nextCursor -> bare list, no paging UI claims
    await go(page, 'browse');
    await page.getByRole('tab', { name: 'Customers' }).click();
    await page.waitForTimeout(600);
    check('L1-A: an API that returns no total still reads "6 customers"', (await page.getByTestId('customers-count').innerText()).trim() === '6 customers');
    await page.context().close();
  }

  /* ============================================ L1-B: status ink on the dark surface ============================================ */
  {
    const page = await open({ backend: { docs: 12, customers: 6 } });
    await go(page, 'browse');
    const emptyCard = page.getByText("Empty this shop's documents");
    check('L1-B: the "Empty this shop\'s documents" card is on screen (admin, shop has documents)', (await emptyCard.count()) === 1);
    const heading = await contrastOf(page, 'p.text-bad-ink');
    check('L1-B: its heading is readable in Office (dark): >= 4.5:1', heading >= 4.5, `ratio ${heading}`);
    const btn = await contrastOf(page, 'button.dw-btn-primary.\\!bg-bad');
    check('L1-B: its danger button label is readable: >= 4.5:1', btn >= 4.5, `ratio ${btn}`);
    await shot(page, 'dark-danger-card');
    // every status-ink token on a bare dark card (error lines, saved notes)
    await page.evaluate(() => {
      const host = document.querySelector('main');
      for (const k of ['ok', 'warn', 'bad', 'info']) {
        const p = document.createElement('p'); p.id = `probe-${k}`; p.className = `text-caption text-${k}-ink`; p.textContent = `${k} probe`; host.appendChild(p);
      }
      const chip = document.createElement('p'); chip.id = 'probe-chip'; chip.className = 'text-bad-ink bg-bad-bg'; chip.textContent = 'chip'; host.appendChild(chip);
    });
    for (const k of ['ok', 'warn', 'bad', 'info']) {
      const r = await contrastOf(page, `#probe-${k}`);
      check(`L1-B: bare text-${k}-ink on the dark surface >= 4.5:1`, r >= 4.5, `ratio ${r}`);
    }
    const chipR = await contrastOf(page, '#probe-chip');
    check('L1-B: a pastel chip (bg-bad-bg + text-bad-ink) keeps its dark ink >= 4.5:1', chipR >= 4.5, `ratio ${chipR}`);
    await page.context().close();
    const light = await open({ field: true, backend: { docs: 12, customers: 6 } });
    await go(light, 'browse');
    const lh = await contrastOf(light, 'p.text-bad-ink');
    check('L1-B: Field (light) heading unchanged and readable', lh >= 4.5, `ratio ${lh}`);
    await light.context().close();
  }

  /* ============================================ L1-C: Field phone accent text ============================================ */
  {
    const page = await open({ mobile: true, field: true, vp: { width: 390, height: 844 }, backend: { docs: 12, customers: 6 } });
    const active = await contrastOf(page, 'nav[aria-label="Main"] button[aria-current="page"]');
    check('L1-C: Field theme active tab label >= 4.5:1', active >= 4.5, `ratio ${active}`);
    await page.getByRole('button', { name: 'Scan', exact: true }).click();
    await page.waitForTimeout(400);
    const link = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Choose photos or PDFs/.test(x.textContent || ''));
      if (!b) return null;
      b.id = 'probe-choose';
      return true;
    });
    check('L1-C: "Choose photos or PDFs" is on the Scan tab', link === true);
    const choose = await contrastOf(page, '#probe-choose');
    check('L1-C: Field theme "Choose photos or PDFs" >= 4.5:1', choose >= 4.5, `ratio ${choose}`);
    await shot(page, 'phone-field-scan');
    await page.context().close();
    const dark = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { docs: 12, customers: 6 } });
    const da = await contrastOf(dark, 'nav[aria-label="Main"] button[aria-current="page"]');
    check('L1-C: Office (dark) active tab label still >= 4.5:1', da >= 4.5, `ratio ${da}`);
    await dark.context().close();
  }

  /* ============================================ L1-D: desktop header ============================================ */
  {
    for (const w of [1024, 1100, 1280, 1440, 1536, 1920]) {
      const page = await open({ vp: { width: w, height: 800 }, auth: { orgName: 'Sunrise Heating & Air Conditioning of Greater Phoenix' }, backend: {} });
      const m = await page.evaluate(() => {
        const row = document.querySelector('header').firstElementChild;
        const buttons = [...row.querySelectorAll('button')];
        const wrapped = buttons.filter((b) => [...b.querySelectorAll('span:not(.sr-only)')].some((s) => s.getClientRects().length > 1)).map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20));
        return { overflow: document.documentElement.scrollWidth - innerWidth, h: Math.round(document.querySelector('header').getBoundingClientRect().height), wrapped };
      });
      check(`L1-D @${w}: no horizontal overflow`, m.overflow <= 0, `overflow ${m.overflow}`);
      check(`L1-D @${w}: no header label wraps onto two lines`, m.wrapped.length === 0, m.wrapped.join(', '));
      if (w >= 1280) check(`L1-D @${w}: header is one row even with a 50-character shop name`, m.h <= 66, `height ${m.h}`);
      if (w === 1440) await shot(page, 'header-1440-long-shop-name');
      await page.context().close();
    }
    const page = await open({ vp: { width: 1440, height: 800 } });
    const titles = await page.evaluate(() => ['Billing', 'Team', 'Donovan', 'Sign out'].map((n) => document.querySelector(`header button[aria-label="${n}"]`)?.getAttribute('title')));
    check('L1-D: icon-only account buttons carry a tooltip title (Billing, Team, Donovan, Sign out)', titles.join('|') === 'Billing|Team|Donovan|Sign out', titles.join('|'));
    await page.context().close();
  }

  /* ============================================ L1-E: phone header shop name ============================================ */
  {
    for (const [w, expectVisible] of [[360, false], [390, false], [430, false], [768, true]]) {
      const page = await open({ mobile: true, vp: { width: w, height: 800 }, backend: { docs: 12, customers: 6 } });
      const shown = await page.evaluate(() => {
        const s = [...document.querySelectorAll('header span')].find((x) => /Sunrise HVAC/.test(x.textContent || ''));
        return !!s && getComputedStyle(s).display !== 'none';
      });
      check(`L1-E @${w}: header shop name ${expectVisible ? 'shown' : 'hidden (no more "Sunris…")'}`, shown === expectVisible, `visible=${shown}`);
      if (w === 390) {
        await page.getByTestId('account-button').click();
        await page.waitForTimeout(300);
        check('L1-E @390: the Account sheet still names the shop', /Sunrise HVAC/.test(await page.getByTestId('account-current-shop').innerText()));
      }
      await page.context().close();
    }
  }

  /* ============================================ L1-F: website hero demo ============================================ */
  {
    const src = read('index.html');
    check('L1-F: hero demo cancels its run when the field takes focus', /input\.addEventListener\('focus',\(\)=>\{if\(activeIdx>=0\)\{cancelRun\(\);input\.select\(\);\}\}\)/.test(src));
  }

  /* ============================================ L2-A: error reporter (pure) ============================================ */
  {
    check('L2-A: scrubText removes emails', scrubText('failed for jo.smith+x@acme-hvac.com now') === 'failed for [email] now');
    check('L2-A: scrubText removes phone numbers', !/555/.test(scrubText('call (555) 123-4567 or 555-123-4567')));
    check('L2-A: scrubText removes long numbers and tokens', !/\d{7}/.test(scrubText('id 12345678 tok ' + 'a'.repeat(40))) && !/a{32}/.test(scrubText('tok ' + 'a'.repeat(40))));
    check('L2-A: scrubText drops URL query strings', scrubText('GET https://x.test/api/a?email=q&k=1 failed') === 'GET https://x.test/api/a failed');
    check('L2-A: scrubText caps length', scrubText('x '.repeat(500), 50).length <= 50);
    check('L2-A: whereFrom keeps file:line only', whereFrom('at f (https://app.deepwelltechnology.com/assets/index-ab12.js:1:2345)') === '/assets/index-ab12.js:1:2345');
    check('L2-A: deviceFamily is coarse', deviceFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605 Version/17.4 Mobile/15E148 Safari/604.1') === 'iPhone iOS 17 Safari');
    _resetForTest();
    check('L2-A: ResizeObserver / offline noise is not recorded', recordClientError('error', new Error('ResizeObserver loop completed with undelivered notifications.')) === null && recordClientError('rejection', new TypeError('Failed to fetch')) === null && getRecentClientErrors().length === 0);
    for (let i = 0; i < 14; i++) recordClientError('error', new Error(`boom ${i} for x${i}@y.com`));
    const ring = getRecentClientErrors();
    check('L2-A: ring keeps the newest 10, scrubbed', ring.length === 10 && ring[9].message === 'boom 13 for [email]' && !ring.some((e) => e.message.includes('@')), JSON.stringify(ring.slice(-1)));
    recordClientError('error', new Error('boom 13 for x13@y.com'));
    check('L2-A: an identical repeat is folded, not duplicated', getRecentClientErrors().length === 10);
    const globalAny = globalThis;
    globalAny.window = { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }) };
    Object.defineProperty(globalAny, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', onLine: false }, configurable: true });
    const d = buildDiagnostics('mobile', 'tab:scan');
    delete globalAny.window;
    check('L2-A: diagnostics carry screen, device, viewport, offline flag and recent errors', /Screen: tab:scan \(mobile\)/.test(d) && /Android 14 Chrome/.test(d) && /390x844/.test(d) && /offline/.test(d) && /Recent errors \(5\)/.test(d) && d.length <= 1200, d);
    check('L2-A: diagnostics never include an email or long digit run', !/@|\d{7}/.test(d));
    _resetForTest();
  }

  /* ============================================ L2-B: server side ============================================ */
  {
    check('L2-B: client-error is refused for the public surface', validateClientError({ surface: 'public', message: 'x' }).ok === false);
    check('L2-B: client-error needs a message', validateClientError({ surface: 'app', message: '  ' }).ok === false);
    const v = validateClientError({ surface: 'mobile', kind: 'weird', message: 'oops\nfor bob@x.com\r\nline 2', where: '/a.js:1:2', page: 'tab:ask', device: 'Android', build: 'index-1.js' });
    check('L2-B: client-error is one-lined, kind-clamped and scrubbed again server side', v.ok && v.value.kind === 'error' && !/[\r\n]/.test(v.value.message) && !/bob@/.test(v.value.message), JSON.stringify(v));
    const line = clientErrorLogLine(v.value, 'abc');
    check('L2-B: the log line is one JSON line with a tenant hash and no raw ids', !line.includes('\n') && JSON.parse(line).tenant_h === 'abc');
    let bumps = 0;
    const lim = createLimiter({ now: () => 1_700_000_000_000, env: { SUPPORT_CLIENT_ERROR_PER_DAY: '3' }, tenant: { bumpWindow: async (_a, b) => { bumps++; return /^support_e_/.test(b) ? bumps : null; } } });
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push((await lim.checkClientError({ auth: { userId: 'u1' } })).ok);
    check('L2-B: checkClientError allows the daily cap then drops (3 ok, then blocked)', outs.join() === 'true,true,true,false,false', outs.join());
    const unavailable = createLimiter({ tenant: { bumpWindow: async () => null } });
    check('L2-B: an unreadable counter never blocks reporting', (await unavailable.checkClientError({ auth: { userId: 'u1' } })).ok === true);
    const h = validateHandoff({ email: 'a@b.co', message: 'The scan button does nothing', surface: 'app', kind: 'problem', page: 'ingest', diagnostics: 'Screen: ingest (app)\nDevice: Windows Chrome\nRecent errors: none recorded\ncall 555-123-4567 sk_' + 'live_abcdefghijklmnopqrstuv' });
    check('L2-B: handoff accepts kind:problem + multi-line diagnostics, redacted', h.ok && h.value.kind === 'problem' && h.value.diagnostics.split('\n').length === 4 && !/555-123-4567|sk_live/.test(h.value.diagnostics), JSON.stringify(h.value?.diagnostics));
    check('L2-B: the real entry points install the reporter', /installErrorReporter\('app'/.test(read('src/main.tsx')) && /installErrorReporter\('mobile'/.test(read('src/mobile/main.tsx')) && /recordRenderError/.test(read('src/components/ScreenLoadBoundary.tsx')));
    const em = buildHandoffEmail(h.value, { ref: 'DW-1', account: null });
    check('L2-B: problem email is tagged and carries the diagnostics', /^\[DeepWell Problem DW-1\]/.test(em.subject) && /Diagnostics \(attached automatically/.test(em.text) && /Device: Windows Chrome/.test(em.text));
    const plain = validateHandoff({ email: 'a@b.co', message: 'How do I add a tech?', surface: 'app' });
    check('L2-B: an ordinary help handoff is unchanged (kind help, no diagnostics section)', plain.ok && plain.value.kind === 'help' && !/Diagnostics/.test(buildHandoffEmail(plain.value, { ref: 'DW-2' }).text) && /^\[DeepWell Help DW-2\]/.test(buildHandoffEmail(plain.value, { ref: 'DW-2' }).subject));
    check('L2-B: the route wires client-error + checkClientError (source)', /action === 'client-error'/.test(read('api/_lib/support/route.js')) && /checkClientError/.test(read('api/_lib/support/route.js')));
  }

  /* ============================================ L2-C: Report a problem + crash report in the browser ============================================ */
  {
    for (const [label, mobile, vp] of [['desktop', false, { width: 1280, height: 800 }], ['phone', true, { width: 390, height: 844 }]]) {
      const posts = [];
      const page = await open({
        mobile, vp, backend: { docs: 6, customers: 3 },
        setup: async (pg) => {
          await pg.route('**/api/support*', async (r) => {
            const req = r.request();
            if (req.method() === 'POST') { try { posts.push(JSON.parse(req.postData() || '{}')); } catch { /* ignore */ } return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); }
            return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ greeting: 'Hi', suggestions: [] }) });
          });
        },
      });
      // open the chat
      if (mobile) { await page.getByRole('button', { name: /help/i }).first().click(); } else { await page.getByLabel('Open DeepWell Help chat').click(); }
      await page.waitForTimeout(500);
      const btn = page.getByRole('button', { name: 'Report a problem' });
      check(`L2-C ${label}: the chat footer offers "Report a problem"`, (await btn.count()) === 1);
      const box = await btn.boundingBox();
      check(`L2-C ${label}: the button is a >=44px target`, !!box && box.height >= 43.5, JSON.stringify(box));
      await btn.click();
      await page.waitForTimeout(300);
      const form = page.getByRole('form', { name: 'Report a problem' });
      check(`L2-C ${label}: opens a problem form that says what is attached`, (await form.count()) === 1 && /Never your customers or documents/.test(await form.innerText()));
      await form.locator('input[type=email]').fill('tech@shop.test');
      await form.locator('textarea').fill('Scan button does nothing on my phone');
      await shot(page, `L2C-${label}-form`);
      await form.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(500);
      const h = posts.find((b) => b.action === 'handoff');
      check(`L2-C ${label}: the send posts kind:problem with a diagnostics block and no transcript`, !!h && h.kind === 'problem' && /Screen: /.test(h.diagnostics || '') && /Device: /.test(h.diagnostics || '') && (h.transcript ?? []).length === 0, JSON.stringify(h));
      check(`L2-C ${label}: it confirms it was sent`, /Sent to the DeepWell team/.test(await page.locator('body').innerText()));
      // automatic crash report
      await page.evaluate(() => { setTimeout(() => { throw new Error('QA crash for tech@shop.test 5551234567'); }, 0); });
      await page.waitForTimeout(600);
      const ce = posts.find((b) => b.action === 'client-error');
      check(`L2-C ${label}: an uncaught error is reported once, scrubbed`, !!ce && ce.surface === (mobile ? 'mobile' : 'app') && /QA crash for \[email\]/.test(ce.message) && !/5551234567/.test(JSON.stringify(ce)), JSON.stringify(ce));
      await page.evaluate(() => { setTimeout(() => { throw new Error('QA crash for tech@shop.test 5551234567'); }, 0); });
      await page.waitForTimeout(400);
      check(`L2-C ${label}: the same error is not re-sent`, posts.filter((b) => b.action === 'client-error').length === 1);
      await page.context().close();
    }
    // keyboard: cancelling the form must not drop focus to <body>
    const kp = await open({ backend: { docs: 6, customers: 3 }, setup: async (pg) => { await pg.route('**/api/support*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r.request().method() === 'GET' ? { greeting: 'Hi', suggestions: [] } : { ok: true }) })); } });
    await kp.getByLabel('Open DeepWell Help chat').click();
    await kp.waitForTimeout(400);
    await kp.getByRole('button', { name: 'Report a problem' }).click();
    await kp.waitForTimeout(300);
    await kp.getByRole('button', { name: 'Cancel' }).focus();
    await kp.keyboard.press('Enter');
    await kp.waitForTimeout(300);
    const tag = await kp.evaluate(() => document.activeElement?.tagName);
    check('L2-C keyboard: cancelling the problem form keeps focus in the chat (not <body>)', tag === 'TEXTAREA', String(tag));
    await kp.context().close();
  }

  /* ============================================ L2-D: billing meters ============================================ */
  {
    const m = usageMeter(745, 750);
    check('L2-D unit: 745/750 is 99% and near, not over', m.pct === 99 && m.near && !m.over && m.tone === 'warn');
    check('L2-D unit: over the cap clamps to 100 and turns bad', usageMeter(900, 750).pct === 100 && usageMeter(900, 750).tone === 'bad');
    check('L2-D unit: unlimited caps have no meter', usageMeter(5, null) === null && usageMeter(5, 0) === null);
    check('L2-D unit: 40/750 is calm', usageMeter(40, 750).tone === 'ok' && !usageMeter(40, 750).near);
    check('L2-D unit: longDate is unambiguous', longDate('2026-10-09T12:00:00Z') === 'Oct 9, 2026' && longDate('junk') === null && longDate(null) === null);
    const day = 86400000;
    const iso = (d) => new Date(d).toISOString();
    const billingFor = (extra) => ({ plan: 'solo', status: 'active', trialEndsAt: null, currentPeriodEnd: iso(Date.now() + 9 * day), cancelAtPeriodEnd: false, limits: { logins: 2, documentsStored: 25000, pagesPerMonth: 750 }, usage: { documentsStored: 12, pagesThisMonth: 40, asksThisMonth: 3, resetsOn: iso(Date.now() + 9 * day) }, ...extra });
    for (const [name, extra, expectNudge, expectPct] of [['calm', {}, false, 5], ['near', { usage: { documentsStored: 12, pagesThisMonth: 745, asksThisMonth: 3, resetsOn: iso(Date.now() + 9 * day) } }, true, 99], ['over', { usage: { documentsStored: 12, pagesThisMonth: 750, asksThisMonth: 3, resetsOn: iso(Date.now() + 9 * day) } }, true, 100]]) {
      const billing = billingFor({ ...extra, cancelAtPeriodEnd: name === 'near' });
      const page = await open({
        backend: { docs: 12, customers: 3 },
        setup: async (pg) => {
          await pg.route('**/api/billing*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(billing) }));
          await pg.route('**/api/records', async (r) => { let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch { /* */ } if (body.action === 'bootstrap') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ billing, notifications: { items: [], unreadCount: 0 }, records: { rows: [], total: 12 } }) }); return r.fallback(); });
        },
      });
      await go(page, 'billing');
      const meter = page.getByRole('meter', { name: 'Pages this month used' });
      check(`L2-D ${name}: pages meter shows ${expectPct}%`, (await meter.count()) === 1 && Number(await meter.getAttribute('aria-valuenow')) === expectPct, String(await meter.count()));
      check(`L2-D ${name}: near-limit nudge ${expectNudge ? 'shown' : 'absent'}`, (await page.getByTestId('usage-nudge').count()) === (expectNudge ? 1 : 0));
      if (name === 'near') {
        const txt = await page.locator('main').innerText();
        check('L2-D near: cancel date reads "cancels Xxx D, YYYY" not 10/9/2026', /cancels [A-Z][a-z]{2} \d{1,2}, \d{4}; you keep access/.test(txt) && !/\d+\/\d+\/\d{4}/.test(txt), txt.slice(0, 300));
        const nudge = await contrastOf(page, '[data-testid="usage-nudge"]');
        check('L2-D near: nudge text is readable on Office (dark): >= 4.5:1', nudge >= 4.5, `ratio ${nudge}`);
        await shot(page, 'L2D-billing-near');
      }
      await page.context().close();
    }
  }

  /* ============================================ L2-E: phone-width layout ============================================ */
  {
    check('L2-E: warranty-export unit picker cannot exceed its container', /id="unit-picker" className="[^"]*max-w-full min-w-0"/.test(read('src/screens/WarrantyExportScreen.tsx')));
    check('L2-E: desktop footer leaves room under the floating Help launcher below lg', /pt-4 pb-20 lg:pb-4/.test(read('src/components/AppShell.tsx')));
    const page = await open({ vp: { width: 390, height: 844 }, backend: { docs: 12, customers: 6 } });
    await go(page, 'warranty-export');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('L2-E @390: warranty export has no horizontal page scroll', over <= 1, `overflow ${over}px`);
    await shot(page, 'L2E-warranty-390');
    await page.context().close();
  }

  /* ============================================ L3-A: crashed screen ============================================ */
  {
    const posts = [];
    const page = await open({
      backend: { docs: 12 },
      setup: async (pg) => {
        await pg.route('**/api/support*', (r) => { try { posts.push(JSON.parse(r.request().postData() || '{}')); } catch { /* */ } return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
        await pg.route('**/api/account?action=insights', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      },
    });
    await go(page, 'dashboard');
    await page.waitForTimeout(800);
    const link = page.getByRole('link', { name: 'support@deepwelltechnology.com' });
    check('L3-A: the crash card offers an email link to support', (await link.count()) === 1 && /^mailto:support@deepwelltechnology\.com/.test((await link.getAttribute('href')) || ''));
    const reports = posts.filter((b) => b.action === 'client-error');
    check('L3-A: the render error is reported automatically, once, (React also fires window.onerror: still one report) on the right screen', reports.length === 1 && reports[0].page === 'dashboard' && /error|render/.test(reports[0].kind), JSON.stringify(reports));
    await shot(page, 'L3A-crash-card');
    await page.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
