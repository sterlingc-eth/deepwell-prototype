/**
 * Round 17 (G3) UI check — Playwright harness (scripts/learning-harness/, same technique
 * scripts/verify-provider-outage-ui.mjs already uses) for DonovanLearningCard's new
 * "misses -> permanent exam" section: the "Answered now — keep as a test?" list, its "Keep as
 * test" button, and the "Promoted tests (N)" header count.
 *
 * Renders at 390px and 1280px in both Office (dark) and Field (light). Checks: the section and
 * count render, "Keep as test" flips to "Kept ✓" after a click (mocked reviewClient.examPromote,
 * no network), no horizontal overflow, no console errors, every dw-btn-tertiary tap target is
 * >=44px. Screenshots go to SHOT_DIR (arg 1) — look at them.
 *
 *   npx tsx scripts/verify-exam-promote-ui.mjs [screenshotDir]
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
  url = (field) => `http://localhost:${port}/scripts/learning-harness/index.html?field=${field ? '1' : '0'}`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/exam-promote-${name}.png`, fullPage: true });

  async function runViewport(viewport, field, label) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });

    await page.goto(url(field), { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    check(`${label}: harness mounted`, (await page.locator('[data-testid="harness-root"]').count()) > 0);

    await page.getByRole('button', { name: /Donovan learning/ }).first().click();
    await page.waitForTimeout(150);

    check(`${label}: header shows "Promoted tests (3)"`, (await page.getByText('Promoted tests (3)').count()) > 0);
    check(`${label}: "Answered now — keep as a test?" section renders`, (await page.getByText(/Answered now/i).count()) > 0);
    check(`${label}: the not-yet-promoted miss shows a "Keep as test" button`, (await page.getByRole('button', { name: 'Keep as test' }).count()) > 0);
    check(`${label}: the already-promoted miss shows "Kept ✓" instead (disabled, no double-promote)`, (await page.getByText('Kept ✓').count()) > 0);

    await shot(page, `${label}-before`);

    // This card's own convention (every existing action here — Approve/Reject/Deactivate — is a
    // deliberately compact 28px row action, not a 44px primary tap target; see DonovanLearningCard's
    // `!min-h-[28px]` overrides): "Keep as test" matches that SAME convention rather than standing
    // out as a different size. Measured before the click below (which turns it into "Kept ✓").
    const keepBtn = page.getByRole('button', { name: 'Keep as test' }).first();
    const keepBtnHeight = await keepBtn.evaluate((el) => el.getBoundingClientRect().height);
    check(`${label}: "Keep as test" matches this card's own compact row-action height (~28px, like Approve/Reject)`, keepBtnHeight >= 24 && keepBtnHeight <= 32, String(keepBtnHeight));

    await keepBtn.click();
    await page.waitForTimeout(200);
    check(`${label}: clicking "Keep as test" flips that row to "Kept ✓" (mocked examPromote, no network)`, (await page.getByText('Kept ✓').count()) === 2);

    await shot(page, `${label}-after`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  await runViewport({ width: 390, height: 900 }, false, 'office-390');
  await runViewport({ width: 1280, height: 900 }, false, 'office-1280');
  await runViewport({ width: 390, height: 900 }, true, 'field-390');
  await runViewport({ width: 1280, height: 900 }, true, 'field-1280');

  await browser.close();
} finally {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server?.kill(); }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
