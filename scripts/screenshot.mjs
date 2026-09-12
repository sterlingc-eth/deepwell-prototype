// Dev helper: serve dist, walk the Ask flow, screenshot desk + phone + field mode.
// Usage: npm run build && node scripts/screenshot.mjs [outDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch();
const errors = [];
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

try {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(`${name} console: ${m.text()}`);
    });
    await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
    await shot(page, `${name}-1-ask-empty`);

    // Ask via keyboard only
    await page.getByLabel('Ask anything').fill('Is the furnace at 2847 N 24th St still under warranty?');
    await page.keyboard.press('Enter');
    await page.getByRole('article').waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${name}-2-answer`);

    // Open the first source, then Escape
    await page.getByRole('button', { name: /Open source 1/ }).first().click();
    await page.getByRole('dialog').waitFor();
    await shot(page, `${name}-3-source`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    // Honest empty state
    await page.getByLabel('Ask anything').fill('Is the boiler at 12 Main St under warranty?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await shot(page, `${name}-4-no-answer`);

    // Field mode
    await page.getByRole('switch').click();
    await page.getByLabel('Ask anything').fill('SN-RHE-012345');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await shot(page, `${name}-5-field-serial`);
    await page.getByRole('switch').click();
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) {
  console.error('RUNTIME ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('ok — screenshots in', out);
