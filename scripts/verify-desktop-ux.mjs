/**
 * R17 (UX-D1, part 2): Playwright harness for the desktop UX audit fixes (scripts/desktop-harness/,
 * adapted from the U2 desktop audit's read-only scratch harness — see its own file comments).
 * Mounts the REAL AppShell + real screens against the app's own HVAC demo fixture, with
 * '@clerk/clerk-react' aliased to a local mock (no live Clerk session needed) and the three
 * customer-API endpoints stubbed (see fixtures.ts) so the customer -> equipment-tab click path
 * runs for real instead of hitting a load-error screen.
 *
 * Re-counts the two audited tasks the R17 contract calls out and screenshots every screen this
 * round touched at 1280x800 / 1440x900, both themes — LOOK at them (SHOT_DIR below).
 *
 *   npx playwright install chromium   (once, if not already present)
 *   node scripts/verify-desktop-ux.mjs [screenshotDir]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.argv[2] ?? path.join(REPO, '..', 'desktop-ux-shots');
mkdirSync(SHOT_DIR, { recursive: true });
// tailwind v3 resolves its `content` globs relative to process.cwd(), not the config file's own
// directory (same rationale as the original ux17-harness/serve-and-shoot.mjs).
process.chdir(REPO);

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const { createServer } = await import('vite');
const reactPlugin = (await import('@vitejs/plugin-react')).default;
const { chromium } = await import('playwright');
const tailwindcss = (await import('tailwindcss')).default;
const autoprefixer = (await import('autoprefixer')).default;

const HARNESS = path.join(REPO, 'scripts', 'desktop-harness');

const server = await createServer({
  root: REPO,
  configFile: false,
  envFile: false,
  logLevel: 'warn',
  define: {
    'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true'),
  },
  resolve: {
    alias: [{ find: '@clerk/clerk-react', replacement: path.join(HARNESS, 'clerk-mock.tsx') }],
  },
  css: {
    postcss: {
      plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()],
    },
  },
  plugins: [reactPlugin()],
  // A fixed starting port (not 0 — vite's own port option isn't "ask the OS
  // for any free port", it's "try this one, then increment") with
  // strictPort:false so a collision with another worktree's dev server just
  // moves on to the next port instead of failing.
  server: { port: 5190, strictPort: false, fs: { allow: [REPO] } },
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : address;
  if (!port) throw new Error('vite dev server did not report a listening port');
  const base = `http://localhost:${port}/scripts/desktop-harness/index.html`;

  const browser = await chromium.launch();

  // ---------------------------------------------------------------- helpers
  async function newPage(viewport) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (text.includes('Failed to load resource')) return;
      // Pre-existing, outside UX-D1's ownership (AppShell.tsx's nav icons pass a boolean
      // `active` prop straight to lucide-react's underlying <svg>) — present on r17base
      // before this round's changes too. Not this round's regression; don't fail on it.
      if (text.includes('non-boolean attribute `active`') || text.includes('non-boolean attribute `%s`')) return;
      consoleErrors.push(`console: ${text}`);
    });
    page.__consoleErrors = consoleErrors;
    await page.goto(base, { waitUntil: 'networkidle' });
    return page;
  }
  const dark = (page, on) => page.evaluate((v) => window.__dwDark?.(v), on);
  const go = (page, screen) => page.evaluate((s) => window.__dwGo?.(s), screen);

  // --------------------------------------------------- functional: task 2 --
  // "Find all warranties expiring this quarter and export" (R17 contract:
  // export 12 expiring units in <= 6 actions). The demo fixture has exactly
  // 12 units with a known warranty expiry (7 expired + 5 active) out of 15
  // on record — "Select all shown" on the (already-open-by-default)
  // Warranty expiry table is the one-click bulk-select fix #1/#2 ask for.
  {
    const page = await newPage({ width: 1440, height: 900 });
    let actions = 0;
    const click = async (locator) => { await locator.click(); actions++; };

    await click(page.getByRole('button', { name: 'Dashboard' }));
    await page.waitForSelector('#expiry-heading');

    const allCount = await page.locator('table thead input[type=checkbox]').first().getAttribute('aria-label');
    check('task 2: header checkbox is "select all shown" (not per-row)', allCount === 'Select all shown units for export', String(allCount));

    await click(page.locator('table thead input[type=checkbox]').first());
    await click(page.getByRole('button', { name: /Prepare claim packet/ }));

    await page.waitForSelector('#units-heading');
    const unitsHeading = await page.locator('#units-heading').innerText();
    check('task 2: exports exactly the 12 units with a known expiry (not a hardcoded 3)', /·\s*12$/.test(unitsHeading.trim()), unitsHeading);
    check(`task 2: export reached in <= 6 actions (got ${actions})`, actions <= 6, `actions: ${actions}`);

    await page.screenshot({ path: path.join(SHOT_DIR, 'task2-warranty-export-result.png'), fullPage: true });
    check('task 2: no console errors', page.__consoleErrors.length === 0, page.__consoleErrors.join(' | '));
    await page.close();
  }

  // --------------------------------------------------- functional: task 4 --
  // "Find a customer and see their equipment" (R17 contract: <= 2 clicks).
  // Records already lands on Customers by default (BrowseScreen.tsx:162,
  // unchanged) — the fix is CustomerProfileScreen's default tab (was
  // 'documents', now 'equipment').
  {
    const page = await newPage({ width: 1440, height: 900 });
    let clicks = 0;
    const click = async (locator) => { await locator.click(); clicks++; };

    await click(page.getByRole('button', { name: 'Records' }));
    await page.waitForSelector('table');
    await click(page.getByText('Harbor Point Apartments'));

    await page.waitForSelector('[role="tablist"]');
    const equipmentTab = page.getByRole('tab', { name: 'Equipment' });
    check('task 4: reached a customer profile in <= 2 clicks', clicks <= 2, `clicks: ${clicks}`);
    check('task 4: Equipment tab is selected by default (was Documents)', await equipmentTab.getAttribute('aria-selected') === 'true');
    check('task 4: Equipment tab content is visible with no extra click', (await page.getByText('SN-LEN-345678').count()) > 0);

    await page.screenshot({ path: path.join(SHOT_DIR, 'task4-customer-equipment-default.png'), fullPage: true });
    check('task 4: no console errors', page.__consoleErrors.length === 0, page.__consoleErrors.join(' | '));
    await page.close();
  }

  // ------------------------------------------------------- collapse memory --
  {
    const page = await newPage({ width: 1440, height: 900 });
    await go(page, 'dashboard');
    await page.waitForSelector('#expiry-heading');
    check('financials collapsed by default', (await page.locator('#financials-body').count()) === 0);
    check('at-risk collapsed by default', (await page.locator('#at-risk-body').count()) === 0);
    check('warranty expiry open by default (primary section)', (await page.locator('#expiry-body').count()) === 1);
    await page.getByRole('button', { name: /^Equipment at risk/ }).click();
    await page.waitForSelector('#at-risk-body');
    await page.reload({ waitUntil: 'networkidle' });
    await go(page, 'dashboard');
    await page.waitForSelector('#expiry-heading');
    check('collapse state remembered across a reload (localStorage)', (await page.locator('#at-risk-body').count()) === 1);
    await page.close();
  }

  // ------------------------------------------------------------ screenshots
  const screens = [
    { screen: 'dashboard', name: 'dashboard', ready: '#expiry-heading' },
    { screen: 'browse', name: 'records-customers', ready: 'table' },
    { screen: 'warranty-export', name: 'warranty-export', ready: '#units-heading' },
  ];
  const viewports = [{ w: 1280, h: 800, tag: '1280x800' }, { w: 1440, h: 900, tag: '1440x900' }];
  const themes = [{ isDark: true, tag: 'office-dark' }, { isDark: false, tag: 'field-light' }];

  for (const vp of viewports) {
    const page = await newPage({ width: vp.w, height: vp.h });
    for (const th of themes) {
      await dark(page, th.isDark);
      for (const s of screens) {
        await go(page, s.screen);
        await page.waitForSelector(s.ready);
        await page.waitForTimeout(150);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        check(`${s.name} ${th.tag} ${vp.tag}: no horizontal overflow`, !overflowX);
        await page.screenshot({ path: path.join(SHOT_DIR, `${s.name}_${th.tag}_${vp.tag}.png`), fullPage: true });
      }
    }
    check(`${vp.tag}: no console errors across the run`, page.__consoleErrors.length === 0, page.__consoleErrors.join(' | '));
    await page.close();
  }

  await browser.close();
} finally {
  await server.close();
}

console.log(`\n${passes} checks passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
if (failures > 0) process.exit(1);
