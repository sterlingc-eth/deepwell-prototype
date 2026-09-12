// End-to-end checks of the flows the prototype promises. Run after `npm run build`.
//   node scripts/e2e.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));

const askAndRead = async (q) => {
  await page.getByRole('button', { name: 'Ask', exact: true }).first().click(); // nav
  const input = page.getByLabel('Ask anything');
  await input.fill(q);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  return (await page.locator('#answer-text').textContent()) ?? '';
};

try {
  await page.goto('http://localhost:4174/', { waitUntil: 'networkidle' });

  // 1. Before: the nameplate serial is unknown
  let text = await askAndRead('SN-CAR-567898');
  check('unknown serial is an honest no-answer', /nothing in your records/i.test(text), text);

  // 2. Resolve the conflict in review, choosing the nameplate value
  await page.getByRole('button', { name: 'Intake' }).click();
  await page.getByRole('button', { name: 'Review queue' }).click();
  await page.getByRole('tab', { name: /Conflicts/ }).click();
  await page.getByRole('button', { name: /IMG_4402_nameplate/ }).click();
  await page.getByRole('button', { name: /SN-CAR-567898/ }).click();
  await page.waitForTimeout(200);
  const conflictCount = await page.getByRole('tab', { name: /Conflicts/ }).textContent();
  check('conflict count drops to 1', /1\s*$/.test(conflictCount.trim()), conflictCount);

  // 3. After: the same question now resolves to the unit
  text = await askAndRead('SN-CAR-567898');
  check('resolved value changes the answer', /carrier ac/i.test(text) && /alma school/i.test(text), text);

  // 4. Fill a required-field gap, advance, link, verify → unverified visit becomes answerable
  await page.getByRole('button', { name: 'Intake' }).click();
  await page.getByRole('button', { name: 'Review queue' }).click();
  await page.getByRole('tab', { name: /Missing fields/ }).click();
  await page.getByRole('button', { name: /IMG_4451_workorder/ }).click();
  await page.getByPlaceholder('Technician').fill('Maria Santos');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(200);
  const gapsCount = await page.getByRole('tab', { name: /Missing fields/ }).textContent();
  check('gap cleared', /1\s*$/.test(gapsCount.trim()), gapsCount);
  await page.getByLabel('Record to link').selectOption('PROP006');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: /Mark verified/ }).click();
  await page.waitForTimeout(200);

  // 5. Unverified toggle changes the answer for a Linked-only visit
  text = await askAndRead('When were we last at 4321 S Price Rd?');
  check('verified-only answer uses Apr 2025 visit', /apr 15, 2025/i.test(text), text);
  await page.getByLabel('Include unverified').check();
  await page.waitForTimeout(500);
  text = (await page.locator('#answer-text').textContent()) ?? '';
  check('include-unverified reveals Jun 2026 visit', /jun 10, 2026/i.test(text), text);
  await page.getByLabel('Include unverified').uncheck();

  // 6. Keyboard: Tab to input, type, Enter, Escape clears
  await page.getByLabel('Ask anything').focus();
  await page.keyboard.press('Escape'); // clears the previous question
  await page.keyboard.type('James Mitchell');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  text = (await page.locator('#answer-text').textContent()) ?? '';
  check('bare customer name → full story', /4521 e camelback/i.test(text), text);
  await page.keyboard.press('Escape');
  check('Escape clears the question', (await page.getByLabel('Ask anything').inputValue()) === '');

  // 7. Entity link from a fact
  await askAndRead('SN-RHE-012345');
  await page.getByRole('button', { name: /3210 E Broadway Rd/ }).first().click();
  await page.waitForTimeout(300);
  check('fact link opens the property record', await page.getByText('Equipment here').isVisible());

  // 8. No "AI" anywhere in the UI
  const bodyText = (await page.locator('body').innerText()).replace(/DeepWell/g, '');
  check('UI never says "AI"', !/\bAI\b/.test(bodyText));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
