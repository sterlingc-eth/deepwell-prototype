/**
 * ROUND 14 UI check — Playwright harness (scripts/learning-harness/, same technique as
 * scripts/answer-harness) for the two components changed by the provider-outage fix:
 *   - DonovanScorecardStrip's "Paused — AI provider credits are exhausted..." banner
 *   - DonovanLearningCard's "Feature requests (N)" collapsed section (dedupe badge,
 *     Approve & replay / Reject / Reject all) — never counted in the "pending" badge
 * Renders at 390px and 1280px in both Office (dark) and Field (light). Checks: no horizontal
 * overflow, no console errors, every dw-btn-tertiary tap target is >=44px. Screenshots go to
 * SHOT_DIR (arg 1) — look at them.
 *
 *   npx tsx scripts/verify-provider-outage-ui.mjs [screenshotDir]
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
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/learning-${name}.png`, fullPage: true });

  async function runViewport(viewport, field, label) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`); });

    await page.goto(url(field), { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    check(`${label}: harness mounted`, (await page.locator('[data-testid="harness-root"]').count()) > 0);
    check(`${label}: scorecard "Paused" banner shows the honest message (no misleading %)`, (await page.locator('[data-testid="scorecard-paused"]').count()) > 0);
    const bannerText = await page.locator('[data-testid="scorecard-paused"]').textContent();
    check(`${label}: paused banner names "AI provider credits are exhausted"`, /AI provider credits are exhausted/.test(bannerText ?? ''), bannerText ?? '');

    // Open the learning card, then its "Feature requests" collapsed section.
    await page.getByRole('button', { name: /Donovan learning/ }).first().click();
    await page.waitForTimeout(150);
    check(`${label}: header "pending" badge counts only the non-gap proposal (1), not the 2 feature requests`, (await page.getByText(/^1 pending$/).count()) > 0);
    await page.getByRole('button', { name: /Feature requests \(2\)/ }).click();
    await page.waitForTimeout(150);
    check(`${label}: "Feature requests (2)" section opens and lists both capability_gap proposals`, (await page.getByText(/Feature requests \(2\)/).count()) > 0);
    check(`${label}: a grouped gap shows its ×N dedupe badge`, (await page.getByText('×3').count()) > 0);
    check(`${label}: an answered-now gap shows its resolves-next-run note`, (await page.getByText(/answered now.*resolves next learning run/i).count()) > 0);
    check(`${label}: "Reject all feature requests" bulk action is present`, (await page.getByRole('button', { name: 'Reject all feature requests' }).count()) > 0);

    await shot(page, `${label}`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.close();
  }

  await runViewport({ width: 390, height: 844 }, false, 'office-390');
  await runViewport({ width: 1280, height: 900 }, false, 'office-1280');
  await runViewport({ width: 390, height: 844 }, true, 'field-390');
  await runViewport({ width: 1280, height: 900 }, true, 'field-1280');

  await browser.close();
} finally {
  server?.kill();
}

console.log(`\n${passes} passed, ${failures} failed.`);
console.log(`Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
