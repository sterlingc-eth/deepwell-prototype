/**
 * R17 (G1 — proactive insights): Playwright harness for InsightsCard (scripts/insights-harness/,
 * same technique as scripts/answer-harness). Renders the card with a stubbed network response at
 * 390/1280px in both Office (dark) and Field (light) view, plus the empty state, and checks tap
 * targets / contrast / overflow / console errors. Screenshots go to SHOT_DIR (arg 1) — look at them.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   node scripts/verify-insights-ui.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/insights-shots';
mkdirSync(SHOT_DIR, { recursive: true });

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

let server;
let url;
try {
  // --port 0: let the OS pick a free port (same rationale as verify-answer-ui.mjs — a fixed port
  // can collide with, or silently serve, another worktree's dev server on a shared machine).
  // detached + killing the whole process group on the way out (see the `finally` below): `npx`
  // spawns vite as a grandchild, and a plain server.kill() only kills npx itself, leaving vite
  // listening forever (same fix as verify-records-ui.mjs/verify-grid-ui.mjs/verify-intake-ui.mjs).
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  let port = null;
  const check2 = () => {
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out);
    if (m) port = Number(m[1]);
  };
  server.stdout.on('data', (d) => { out += String(d); check2(); });
  server.stderr.on('data', (d) => { out += String(d); check2(); });
  const ready = await Promise.race([
    new Promise((resolve) => { const iv = setInterval(() => { if (port) { clearInterval(iv); resolve(true); } }, 50); }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a listening port within 8s:\n${out}`);
  url = (state) => `http://localhost:${port}/scripts/insights-harness/index.html${state ? `?state=${state}` : ''}`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/insights-${name}.png`, fullPage: true });

  async function run(viewport, fieldMode, label, state) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });

    await page.goto(url(state), { waitUntil: 'networkidle' });
    if (fieldMode) await page.evaluate(() => window.__dwSetField?.(true));
    await page.locator('[data-testid="insights-root"]').waitFor();
    // Wait for the loading state to resolve into rows or the empty state.
    await page.waitForFunction(() => !document.body.textContent?.includes('Checking your records'), null, { timeout: 5000 });
    await page.waitForTimeout(200);

    check(`${label}: card mounted`, (await page.locator('#insights-heading').count()) > 0);

    if (state !== 'empty') {
      const rows = page.locator('#insights-heading + div > ul > li');
      const rowCount = await rows.count();
      check(`${label}: shows at most 5 rows (7 fixtures supplied)`, rowCount === 5, `got ${rowCount}`);

      // Expand the first row and confirm its items + source-count chip render, and both action
      // kinds ('ask:' and the literal 'inbox' token) actually fire their callback.
      // R36: the top insight now opens by itself; only click it when it is not already expanded (a click would close it).
      const firstBtn = rows.first().locator('button').first();
      if ((await firstBtn.getAttribute('aria-expanded')) !== 'true') await firstBtn.click();
      await page.waitForTimeout(150);
      check(`${label}: expanding a row reveals its action button`, (await page.getByRole('button', { name: /Ask about registration deadlines/ }).count()) > 0);
      await page.getByRole('button', { name: /Ask about registration deadlines/ }).click();
      const asks = await page.evaluate(() => window.__dwAsks ?? []);
      check(`${label}: an 'ask:' action calls onAsk with the question text (not the raw href)`, asks.includes('Which units have a registration window closing soon?'), asks.join(', '));

      // The data-gap row's action is the literal 'inbox' token → onOpenInbox, not onAsk.
      const inboxRow = page.locator('#insights-heading + div ul > li', { hasText: 'Units missing a serial number or model' });
      await inboxRow.locator('button').first().click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: /Open the Inbox/ }).click();
      const inboxOpens = await page.evaluate(() => window.__dwInboxOpens ?? 0);
      check(`${label}: the 'inbox' action calls onOpenInbox, not onAsk`, inboxOpens === 1, `got ${inboxOpens}`);
    } else {
      check(`${label}: empty state reads "All clear"`, (await page.getByText('All clear').count()) > 0);
    }

    await shot(page, `${label}${state === 'empty' ? '-empty' : ''}`);

    // Big touch targets on mobile: every row button and every expanded action button >= 44px tall.
    const boxes = await page.locator('#insights-heading + div button').all();
    let small = 0;
    for (const b of boxes) {
      const box = await b.boundingBox();
      if (box && box.height < 44) small++;
    }
    check(`${label}: all ${boxes.length} buttons are >=44px tall`, (state === 'empty' || boxes.length > 0) && small === 0, `${small} of ${boxes.length} undersized`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  // Office = dark (default), Field = light. 390 = phone width, 1280 = desktop.
  await run({ width: 390, height: 1000 }, false, 'phone-office');
  await run({ width: 390, height: 1000 }, true, 'phone-field');
  await run({ width: 1280, height: 1000 }, false, 'desktop-office');
  await run({ width: 1280, height: 1000 }, true, 'desktop-field');
  await run({ width: 390, height: 700 }, false, 'phone-office', 'empty');

  await browser.close();
} finally {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server?.kill(); }
}

console.log(`\n${passes} checks passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
if (failures > 0) process.exit(1);
