// Desktop IA build (round 17, U2/D2): Playwright checks against the real
// AppShell + real screens (TeamScreen, DonovanScreen, BrowseScreen/Records,
// InboxScreen/ReviewScreen, CustomersScreen), mounted in
// scripts/desktop-ia-harness/ (adapted from ../ux17-harness/, the auditor's
// own read-only harness — real components, the app's own HVAC demo fixture,
// '@clerk/clerk-react' aliased to a local mock). No repo files are
// written/committed by this script; it only reads the built app.
//
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-desktop-ia.mjs [screenshotDir]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/ux17-verify';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(REPO, 'scripts/desktop-ia-harness');
const require = createRequire(import.meta.url);
// tailwind v3 resolves its `content` globs relative to process.cwd() — chdir
// into the repo so tailwind.config.ts's relative globs actually match.
process.chdir(REPO);

const PORT = 5231; // unlikely to collide with another engineer's own dev server (see verify-records-ui.mjs's own port comment)

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

async function main() {
  const { createServer } = await import(pathToFileURL(path.join(REPO, 'node_modules/vite/dist/node/index.js')).href);
  const reactPlugin = await import(pathToFileURL(path.join(REPO, 'node_modules/@vitejs/plugin-react/dist/index.js')).href);
  const { chromium } = require(path.join(REPO, 'node_modules/playwright'));
  const tailwindcss = require(path.join(REPO, 'node_modules/tailwindcss'));
  const autoprefixer = require(path.join(REPO, 'node_modules/autoprefixer'));

  const server = await createServer({
    root: HARNESS,
    configFile: false,
    envFile: false,
    logLevel: 'warn',
    define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true') },
    resolve: {
      alias: [
        { find: '@clerk/clerk-react', replacement: path.join(HARNESS, 'clerk-mock.tsx') },
        { find: '/repo', replacement: REPO },
      ],
    },
    css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
    plugins: [reactPlugin.default()],
    server: { port: PORT, strictPort: true, fs: { allow: [HARNESS, REPO] } },
  });
  await server.listen();
  console.log(`vite dev server up on ${PORT}`);

  let executablePath;
  try {
    fs.accessSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
    executablePath = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  } catch { /* fall back to Playwright's own managed download */ }
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  const consoleErrors = [];
  const newPage = async (vp) => {
    const page = await browser.newPage({ viewport: vp, reducedMotion: 'reduce' });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !t.includes('Failed to load resource') && !t.includes('404')) {
        consoleErrors.push(`console: ${t}`);
      }
    });
    return page;
  };
  const go = (page, screen) => page.evaluate((s) => window.__dwGo?.(s), screen);
  const dark = (page, on) => page.evaluate((v) => window.__dwDark?.(v), on);
  const setAdmin = (page, on) => page.evaluate((v) => window.__dwSetAdmin?.(v), on);

  // ---------------------------------------------------------- functional --
  {
    const page = await newPage({ width: 1440, height: 900 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await dark(page, true);
    await setAdmin(page, true);

    // ---- Team: fits one 1440x900 viewport, keeps people/seats content ----
    await go(page, 'team');
    await page.waitForTimeout(400);
    check('Team: Phone app install card still there', (await page.getByText('Phone app for your team').count()) > 0);
    check('Team: Follow-ups card still there', (await page.getByText('Follow-ups').count()) > 0);
    check('Team: a collapsed Settings section exists (notifications + data export)', (await page.getByRole('button', { name: 'Settings', exact: true }).count()) > 0);
    check('Team: Donovan misses is NOT on this screen any more', (await page.getByText('Donovan misses').count()) === 0);
    check('Team: Search by meaning is NOT on this screen any more', (await page.getByText('Search by meaning').count()) === 0);
    check('Team: Possible duplicate customers is NOT on this screen any more', (await page.getByText('Possible duplicate customers').count()) === 0);
    const teamScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    check(`Team: fits (or nearly fits) one 1440x900 viewport (scrollHeight=${teamScrollHeight})`, teamScrollHeight <= 900 + 40, `scrollHeight was ${teamScrollHeight}px`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'team_office-dark_1440x900.png'), fullPage: true });

    // Settings expands and both moved pieces are inside it
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(150);
    check('Team Settings: notifications toggle reachable', (await page.getByText('Mute my daily digest').first().count()) > 0);
    check('Team Settings: data export reachable', (await page.getByText('Download data export (JSON)').count()) > 0);

    // ---- Donovan (2026-10-10): customers get NO Donovan tab; only a platform operator does ----
    let operator = false;
    await page.route('**/api/review', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'donovanSharing') return route.fulfill({ json: { sharing: false, isOperator: operator } });
      if (body.action === 'donovanScores') return route.fulfill({ json: { configured: true, days: 30, total: 120, tenantsReporting: 3, tenantsOptedIn: 3, rates: { answered_from_records: 0.7, declined: 0.1, ai_fallback: 0.15, marked_wrong: 0.05 }, byOutcome: { answered_from_records: 84, declined: 12, ai_fallback: 18, marked_wrong: 6 }, byShape: [{ shape: 'count', n: 50, answeredRate: 0.8 }, { shape: 'list', n: 40, answeredRate: 0.7 }, { shape: 'date', n: 30, answeredRate: 0.5 }], trend: [{ day: '2026-10-08', n: 40, answeredRate: 0.7, declinedRate: 0.1, aiRate: 0.15, wrongRate: 0.05, avgLatencyMs: 900, costUsd: 0.2 }, { day: '2026-10-09', n: 80, answeredRate: 0.71, declinedRate: 0.09, aiRate: 0.15, wrongRate: 0.05, avgLatencyMs: 850, costUsd: 0.4 }], latencyMs: { p50: 700, p95: 2400 }, costUsd: 0.6 } });
      return route.fulfill({ status: 404, json: { error: 'mock' } });
    });
    await setAdmin(page, false);
    await setAdmin(page, true);
    await go(page, 'team');
    await page.waitForTimeout(400);
    check('Donovan: account-row button HIDDEN for a customer admin (not an operator)', (await page.getByRole('button', { name: 'Donovan', exact: true }).count()) === 0);
    operator = true;
    await setAdmin(page, false);
    await setAdmin(page, true);
    await page.waitForTimeout(400);
    const donovanButton = page.getByRole('button', { name: 'Donovan', exact: true });
    check('Donovan: account-row button visible for a platform operator', (await donovanButton.count()) > 0);
    await donovanButton.click();
    await page.waitForTimeout(400);
    check('Donovan: operator screen shows the shared performance scores', (await page.getByText('Shared performance scores').count()) > 0);
    check('Donovan: opens with Donovan misses reachable', (await page.getByText('Donovan misses').count()) > 0);
    check('Donovan: opens with Donovan learning reachable', (await page.getByText('Donovan learning').count()) > 0);
    check('Donovan: opens with Search by meaning reachable', (await page.getByText('Search by meaning').count()) > 0);
    await page.screenshot({ path: path.join(SHOT_DIR, 'donovan_office-dark_1440x900.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Donovan: Escape closes the overlay', (await page.getByText('Donovan misses').count()) === 0);

    // ---- Donovan: hidden for a non-admin ----
    await setAdmin(page, false);
    await go(page, 'team');
    await page.waitForTimeout(300);
    check('Donovan: account-row button hidden for a non-admin', (await page.getByRole('button', { name: 'Donovan', exact: true }).count()) === 0);
    check('Team (non-admin): admin-only Settings section hidden', (await page.getByRole('button', { name: 'Settings', exact: true }).count()) === 0);
    await setAdmin(page, true);
    operator = false;

    // ---- Opt-in sharing switch lives in Team > Settings, off by default, one control ----
    await go(page, 'team');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(200);
    const sw = page.getByRole('switch', { name: 'Share Donovan performance scores with DeepWell' });
    check('Settings: "Share Donovan performance scores with DeepWell" switch exists', (await sw.count()) === 1);
    check('Settings: the sharing switch is OFF by default', (await sw.getAttribute('aria-checked')) === 'false');

    // ---- Customers: whole-shop duplicate scan folded in (admin) ----
    await go(page, 'browse');
    await page.waitForTimeout(300);
    await page.getByRole('tab', { name: /^Customers$/ }).click();
    await page.waitForTimeout(300);
    check('Customers tab: whole-company "Possible duplicate customers" scan reachable', (await page.getByText('Possible duplicate customers').count()) > 0);
    await page.screenshot({ path: path.join(SHOT_DIR, 'records-customers_office-dark_1440x900.png'), fullPage: true });

    // ---- Records: 5 tabs -> 4, no standalone Search tab ----
    const recordTabs = await page.getByRole('tablist', { name: 'Records view' }).getByRole('tab').allTextContents();
    // Graph was removed (round T2); Company Files was added. The intended set, in order:
    const wantTabs = ['Documents', 'Customers', 'Company Files', 'Grid'];
    check('Records: exactly 4 tabs (Documents/Customers/Company Files/Grid)', recordTabs.length === 4 && wantTabs.every((w, i) => (recordTabs[i] ?? '').trim() === w), `got: ${JSON.stringify(recordTabs)}`);
    check('Records: no standalone "Search" tab', !recordTabs.some((t) => t.trim() === 'Search'));

    // ---- Inbox: 2 tabs, one merged "Needs you" chip row ----
    await go(page, 'ingest');
    await page.waitForTimeout(400);
    const inboxTabs = await page.getByRole('tablist', { name: 'Inbox view' }).getByRole('tab').allTextContents();
    check('Inbox: exactly 2 top tabs (Add files/Needs you)', inboxTabs.length === 2, `got: ${JSON.stringify(inboxTabs)}`);
    check('Inbox: no separate "Needs a decision" tab', !inboxTabs.some((t) => t.includes('Needs a decision')));
    await page.getByRole('tab', { name: /^Needs you/ }).click();
    await page.waitForTimeout(400);
    // Needs-you redesign: the 5 most-used groups sit on the bar; Conflicts / Duplicates / Company files / Money / All
    // are one click away under "More" (every filter is still reachable, just not all on screen at once).
    await page.getByRole('button', { name: /^More/ }).click();
    await page.waitForTimeout(150);
    const chipTexts = await page.getByRole('tablist', { name: 'Needs you filters' }).getByRole('tab').allTextContents();
    check('Inbox "Needs you": one row has "Decisions" + the original 9 filters (Money hidden when empty)', chipTexts.length >= 9, `got ${chipTexts.length}: ${JSON.stringify(chipTexts)}`);
    check('Inbox "Needs you": "Decisions" chip present (folds in the old Add-files-adjacent decision queue)', chipTexts.some((t) => t.includes('Decisions')));
    for (const label of ['Needs a person', 'Missing info', 'Needs linking', 'Conflicts', 'Duplicates', 'Ready to verify', 'Company files', 'All']) {
      check(`Inbox "Needs you": "${label}" filter still reachable`, chipTexts.some((t) => t.includes(label)));
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'inbox_office-dark_1440x900.png'), fullPage: true });

    // Decisions chip swaps in the autofill-exception queue without crashing.
    await page.getByRole('tab', { name: 'Decisions' }).click();
    await page.waitForTimeout(300);
    check('Inbox "Decisions" chip: renders (no page crash)', consoleErrors.filter((e) => e.includes('pageerror')).length === 0, consoleErrors.join(' | '));

    // ---- Inbox nav badge: a count, with no click into the screen ----
    await go(page, 'dashboard');
    await page.waitForTimeout(300);
    const badgeText = await page.locator('text=/need your attention/').first().textContent().catch(() => null);
    check('Inbox nav item: shows a "N need your attention" badge from anywhere in the app', !!badgeText, 'no badge text found next to the Inbox nav item');

    // -------------------------------------------------------- Command palette --
    const SERIAL = 'SN-CAR-234567'; // src/mocks/data.ts equipment fixture
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    check('⌘K: dialog opens', (await page.getByRole('dialog', { name: 'Jump to' }).count()) > 0);
    await page.keyboard.type(SERIAL);
    await page.waitForTimeout(250);
    check('⌘K: typing a serial surfaces it as the top (or a) result', (await page.getByText(SERIAL).count()) > 0);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('⌘K + serial + Enter: 0 clicks reaches that unit’s entity page', (await page.getByText(SERIAL).count()) > 0 && (await page.getByRole('dialog', { name: 'Jump to' }).count()) === 0);
    await page.screenshot({ path: path.join(SHOT_DIR, 'command-palette-result_office-dark_1440x900.png'), fullPage: false });

    // Fallback row for a query that matches nothing.
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await page.keyboard.type('zzz-nothing-matches-this-zzz');
    await page.waitForTimeout(250);
    check('⌘K: "Ask Donovan: <text>" fallback row appears when nothing matches', (await page.getByText(/Ask Donovan: /).count()) > 0);
    await page.screenshot({ path: path.join(SHOT_DIR, 'command-palette-fallback_office-dark_1440x900.png'), fullPage: false });
    await page.keyboard.press('Escape');

    await page.close();
  }

  // ------------------------------------------------------ screenshots (both viewports/themes) --
  const viewports = [{ w: 1280, h: 800, tag: '1280x800' }, { w: 1440, h: 900, tag: '1440x900' }];
  const themes = [{ dark: true, tag: 'office-dark' }, { dark: false, tag: 'field-light' }];
  const screens = [
    { screen: 'team', name: 'team' },
    { screen: 'ingest', name: 'inbox' },
    { screen: 'browse', name: 'records' },
    { screen: 'dashboard', name: 'dashboard' },
  ];
  for (const vp of viewports) {
    const page = await newPage({ width: vp.w, height: vp.h });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await setAdmin(page, true);
    for (const th of themes) {
      await dark(page, th.dark);
      for (const s of screens) {
        await go(page, s.screen);
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(SHOT_DIR, `${s.name}_${th.tag}_${vp.tag}.png`), fullPage: true });
      }
    }
    await page.close();
  }

  check('no console/page errors across the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 20).join(' | '));

  await browser.close();
  await server.close();
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    console.log(`Screenshots in ${SHOT_DIR} — look at them before calling this done.`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
