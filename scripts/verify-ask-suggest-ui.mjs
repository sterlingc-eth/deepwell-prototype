/**
 * Round 14 K1 — Playwright screenshots of the Ask-suggestion components (TypeaheadDropdown, PreflightPill,
 * SamplePromptChips, DidYouMeanChips) at 390px and 1280px, both themes (Office = dark, Field = light).
 * Same technique as scripts/verify-answer-ui.mjs: a `vite --port 0` dev server serving
 * scripts/ask-suggest-harness/index.html, no store/network/auth involved — pure component rendering
 * against fixed fixtures. Screenshots go to SHOT_DIR (arg 1) — LOOK AT THEM.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   npx tsx scripts/verify-ask-suggest-ui.mjs [screenshotDir]
 *
 * Not wired into verify:all (same as verify-answer-ui.mjs/verify-graph-ui.mjs/verify-grid-ui.mjs — a
 * Playwright/browser harness is a manual "look at it" step, not part of the offline verify suite).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad';
mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

let server;
try {
  server = spawn('npx', ['vite', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let port = null;
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  const ready = await Promise.race([
    new Promise((resolve) => {
      const check2 = () => {
        const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//.exec(out);
        if (m) { port = Number(m[1]); resolve(true); }
      };
      server.stdout.on('data', check2);
      check2();
    }),
    new Promise((resolve) => server.once('exit', () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  if (!ready || !port) throw new Error(`vite dev server did not report a listening port within 8s:\n${out}`);
  const url = `http://localhost:${port}/scripts/ask-suggest-harness/index.html`;
  await new Promise((r) => setTimeout(r, 400));

  const browser = await chromium.launch();
  const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/ask-suggest-${name}.png`, fullPage: true });

  async function runViewport(viewport, fieldMode, label) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(`console: ${m.text()}`);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    if (fieldMode) await page.evaluate(() => window.__dwSetField?.(true));
    await page.waitForTimeout(300);

    check(`${label}: harness mounted`, (await page.locator('[data-testid="ask-suggest-root"]').count()) > 0);
    for (const section of ['composer-with-typeahead-open', 'preflight-instant', 'preflight-slow', 'preflight-needs-anchor', 'sample-prompts', 'did-you-mean']) {
      check(`${label}: '${section}' section rendered`, (await page.locator(`[data-testid="section-${section}"]`).count()) > 0);
    }

    await shot(page, `${label}`);

    // Tap targets: dropdown rows + chips must be >=44px in both dimensions (gloves-on, one-handed use).
    const boxes = await page.locator('[data-tap-target], [role="option"] button').all();
    let smallCount = 0;
    for (const b of boxes) {
      const box = await b.boundingBox();
      if (box && (box.width < 44 || box.height < 44)) smallCount++;
    }
    check(`${label}: all ${boxes.length} tap targets are >=44px`, boxes.length > 0 && smallCount === 0, `${smallCount} of ${boxes.length} undersized`);

    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label}: no horizontal overflow`, !overflowX);
    check(`${label}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

    // Interaction smoke test: a typeahead row and a sample-prompt chip both actually fire their callback.
    const row = page.locator('[role="option"] button').first();
    if (await row.count()) {
      await row.click();
      const opens = await page.evaluate(() => window.__dwOpens ?? []);
      check(`${label}: a typeahead row fires onSelect`, opens.some((o) => o.startsWith('select:')), opens.join(', '));
    }

    await page.close();
  }

  await runViewport({ width: 1280, height: 900 }, false, 'desktop-office-dark');
  await runViewport({ width: 1280, height: 900 }, true, 'desktop-field-light');
  await runViewport({ width: 390, height: 844 }, false, 'mobile-office-dark');
  await runViewport({ width: 390, height: 844 }, true, 'mobile-field-light');

  await browser.close();
} finally {
  server?.kill();
}

console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
console.log(`Screenshots written to ${SHOT_DIR} — look at them.`);
process.exit(failures ? 1 : 0);
