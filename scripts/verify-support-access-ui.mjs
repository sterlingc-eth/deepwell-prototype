/**
 * Round 22 (S2, privacy) UI check — Playwright harness (scripts/support-access-harness/, same
 * technique scripts/verify-exam-promote-ui.mjs already uses) for Settings → "Support access" +
 * "Access log" (src/screens/TeamScreen.tsx's SupportAccessCard).
 *
 * Renders at 390px and 1280px in both Office (dark) and Field (light). Checks: the card opens, an
 * ACTIVE grant shows its expiry + reason + a "Revoke now" button, the Access log lists staff/action/
 * record-count/timestamp with an emergency access visibly flagged, no horizontal overflow, no console
 * errors. A second pass (no active grant) checks the grant form (duration + reason + "Grant support
 * access"). Screenshots go to SHOT_DIR (arg 1) — look at them.
 *
 *   npx tsx scripts/verify-support-access-ui.mjs [screenshotDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

let url = () => { throw new Error('url() called before the dev server reported its port'); };
let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  let port = null;
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  const ready = await Promise.race([
    new Promise((resolve) => {
      const chk = () => { const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out); if (m) { port = Number(m[1]); resolve(true); } };
      server.stdout.on('data', chk);
      chk();
    }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a listening port within 8s:\n${out}`);
  url = (state, field) => `http://localhost:${port}/scripts/support-access-harness/index.html?state=${state}&field=${field ? '1' : '0'}`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/support-access-${name}.png`, fullPage: true });

  async function runActiveState(viewport, field, label) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });

    await page.goto(url('active', field), { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);

    check(`${label}: harness mounted`, (await page.locator('[data-testid="harness-root"]').count()) > 0);

    await page.getByRole('button', { name: /Support access/ }).first().click();
    await page.waitForTimeout(250);

    check(`${label}: shows the active grant's expiry`, (await page.getByText(/Access active until/).count()) > 0);
    check(`${label}: shows the grant's reason`, (await page.getByText(/Reason: Helping debug/).count()) > 0);
    check(`${label}: a "Revoke now" button is present`, (await page.getByRole('button', { name: 'Revoke now' }).count()) > 0);

    await page.getByRole('button', { name: /Access log/ }).first().click();
    await page.waitForTimeout(200);

    check(`${label}: Access log lists the granted access (action + record count)`, (await page.getByText(/examList/).count()) > 0 && (await page.getByText(/12 records/).count()) > 0);
    check(`${label}: Access log flags the emergency access visibly`, (await page.getByText(/emergency/i).count()) > 0);
    check(`${label}: the emergency access shows its reason`, (await page.getByText(/Customer called in/).count()) > 0);
    check(`${label}: a non-emergency row shows no emergency flag confusion (exactly one emergency badge)`, (await page.locator('.dw-pill-warn').count()) === 1);

    await shot(page, `${label}-active`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  await runActiveState({ width: 390, height: 900 }, false, 'office-390');
  await runActiveState({ width: 1280, height: 900 }, false, 'office-1280');
  await runActiveState({ width: 390, height: 900 }, true, 'field-390');
  await runActiveState({ width: 1280, height: 900 }, true, 'field-1280');

  // Empty state (no active grant yet): the grant form itself, sanity-checked once.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(url('empty', false), { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /Support access/ }).first().click();
    await page.waitForTimeout(200);
    check('empty state: shows the duration selector', (await page.locator('#support-access-hours').count()) > 0);
    check('empty state: shows a "Grant support access" button', (await page.getByRole('button', { name: 'Grant support access' }).count()) > 0);
    check('empty state: no "Revoke now" button when nothing is active', (await page.getByRole('button', { name: 'Revoke now' }).count()) === 0);
    await shot(page, 'office-1280-empty');
    await page.close();
  }

  await browser.close();
} finally {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server?.kill(); }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
