/**
 * R25 app QA: guards the front-end defects found by the first-paying-client QA pass. Mounts the REAL
 * src/App.tsx (non-demo path, VITE_ANSWER_PROVIDER=claude) and the real src/mobile/MobileApp.tsx via
 * scripts/app-qa-harness/ (mutable Clerk mock + a Playwright-routed fake backend, backend.mjs), then
 * drives the states a demo fixture never reaches: billing gates, offline / 4xx / 5xx, brand-new empty
 * shop, failed uploads, long names, narrow + mid-width viewports, both themes.
 *
 *   npx playwright install chromium   (once, if not already present)
 *   node scripts/verify-app-qa.mjs [screenshotDir]
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startServer, REPO } from './app-qa-harness/serve.mjs';
import { installBackend } from './app-qa-harness/backend.mjs';

const SHOT_DIR = process.argv[2] ?? path.join(REPO, '..', 'app-qa-shots');
mkdirSync(SHOT_DIR, { recursive: true });

let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const { chromium } = await import('playwright');
const { server, base } = await startServer();
const mobileBase = base.replace('index.html', 'mobile.html');
const browser = await chromium.launch();

async function open({ auth = {}, backend = {}, vp = { width: 1280, height: 800 }, field = false, mobile = false, url = '' } = {}) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(`console: ${m.text().slice(0, 160)}`);
  });
  await page.addInitScript(({ a, f }) => {
    window.__QA_AUTH = a;
    if (f) localStorage.setItem('deepwell.fieldMode', '1');
  }, { a: auth, f: field });
  await installBackend(page, backend);
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
const mainText = async (page) => (await page.locator('main').first().innerText()).replace(/\s+/g, ' ');
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

try {
  // ------------------------------------------------ 1. header never clips (was 744px wide at 390)
  for (const [w, field] of [[390, false], [390, true], [768, false], [1024, false], [1100, false], [1280, false], [1440, true]]) {
    for (const [name, backend] of [['signed-in', {}], ['gated', { billing: 'none' }]]) {
      const page = await open({ vp: { width: w, height: 844 }, field, backend });
      const ow = await overflow(page);
      const signOut = await page.getByRole('button', { name: 'Sign out' }).boundingBox();
      check(`header ${name} @${w}${field ? ' field' : ''}: no horizontal overflow`, ow <= 0, `overflow ${ow}px`);
      check(`header ${name} @${w}${field ? ' field' : ''}: Sign out is inside the viewport`, !!signOut && signOut.x >= 0 && signOut.x + signOut.width <= w + 1, JSON.stringify(signOut));
      if (name === 'gated' && w === 390) {
        const label = await page.locator('header + div').first().innerText().catch(() => '');
        check('gated @390: sub-bar names Billing, not the stale "Ask"', label.trim() === 'Billing', label);
        await shot(page, 'gated-390');
      }
      if (name === 'signed-in' && w === 390) await shot(page, 'header-390');
      await page.context().close();
    }
  }

  // ------------------------------------------------ 2. Ask: samples never skeleton forever; honest empty text
  {
    const page = await open({ backend: { docs: 0, customers: 0 } });
    await go(page, 'ask');
    await page.waitForTimeout(600);
    check('empty shop Ask: no endless sample skeleton', (await page.locator('[data-testid="sample-prompts-placeholder"]').count()) === 0);
    check('empty shop Ask: says nothing added yet + offers Add a document', /Nothing added yet/.test(await mainText(page)) && (await page.getByRole('button', { name: /Add a document/ }).count()) === 1);
    await shot(page, 'ask-empty-shop');
    await page.context().close();
  }
  {
    const page = await open({ backend: { docs: 12, customers: 6 } });
    await page.waitForTimeout(600);
    const t = await mainText(page);
    check('shop WITH documents Ask: never says "Nothing added yet"', !/Nothing added yet/.test(t), t.slice(0, 300));
    check('shop WITH documents Ask: no endless sample skeleton', (await page.locator('[data-testid="sample-prompts-placeholder"]').count()) === 0);
    await page.context().close();
  }
  {
    const page = await open({ backend: { offline: true } });
    await page.waitForTimeout(800);
    check('offline Ask: no endless sample skeleton', (await page.locator('[data-testid="sample-prompts-placeholder"]').count()) === 0);
    await page.context().close();
  }

  // ------------------------------------------------ 3. Ask + records errors read as plain language
  const askErr = async (name, backend, expect) => {
    const page = await open({ backend: { docs: 12, ...backend } });
    const box = page.locator('textarea, input:not([type=checkbox])').first();
    await box.fill('What is the serial number at 1000 N 20th St?');
    await box.press('Enter');
    await page.waitForTimeout(1200);
    const t = await mainText(page);
    check(`Ask ${name}: ${expect.desc}`, expect.ok(t), t.slice(0, 260));
    await shot(page, `ask-err-${name}`);
    await page.context().close();
  };
  await askErr('offline', { offline: true }, { desc: 'plain "couldn\'t reach" (not "Failed to fetch")', ok: (t) => /Couldn't reach DeepWell/.test(t) && !/Failed to fetch/.test(t) });
  await askErr('500', { fail: { status: 500, html: true, match: /api\/ask/ } }, { desc: 'no raw "500 Internal Server Error"', ok: (t) => /couldn't get an answer/i.test(t) && !/500 Internal/.test(t) && /Something went wrong on our end/.test(t) });
  await askErr('402', { fail: { status: 402, match: /api\/ask/, message: 'A subscription is required', url: '/app/?screen=billing' } }, { desc: 'keeps server message + See plans', ok: (t) => /A subscription is required/.test(t) && /See plans/.test(t) });
  await askErr('429', { fail: { status: 429, match: /api\/ask/, message: 'Too many requests' } }, { desc: 'keeps the server rate-limit message', ok: (t) => /Too many requests/.test(t) });
  {
    const page = await open({ backend: { fail: { status: 500, html: true, match: /api\/records/ } } });
    const alert = await page.getByRole('alert').first().innerText().catch(() => '');
    check('records sync 500: banner is plain language with a sentence break', /Couldn't load your records\./.test(alert) && !/\b500\b/.test(alert) && /\.\s+Showing whatever/.test(alert), alert);
    await shot(page, 'sync-500-banner');
    await page.context().close();
  }
  {
    const page = await open({ backend: { offline: true } });
    const alert = await page.getByRole('alert').first().innerText().catch(() => '');
    check('records sync offline: banner says "couldn\'t reach", not "Failed to fetch"', /Couldn't reach DeepWell/.test(alert) && !/Failed to fetch/.test(alert) && /\.\s+Showing whatever/.test(alert), alert);
    await page.context().close();
  }

  // ------------------------------------------------ 4. a crashed screen offers "Try again"
  {
    const page = await open({ backend: { docs: 12 } });
    await page.route('**/api/account?action=insights', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await go(page, 'dashboard');
    await page.waitForTimeout(600);
    check('crashed screen: "Something went wrong" card has Try again + Reload', (await page.getByRole('button', { name: 'Try again' }).count()) === 1 && (await page.getByRole('button', { name: 'Reload' }).count()) === 1);
    await page.context().close();
  }

  // ------------------------------------------------ 5. failed uploads leave no phantom documents
  {
    const page = await open({ backend: { docs: 0, customers: 0, fail: { status: 402, match: /upload-url/, message: 'A subscription is required to upload.', url: '/app/?screen=billing' } } });
    await page.locator('input[type=file]').first().setInputFiles([
      { name: 'invoice-1.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a') },
      { name: 'invoice-2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 b') },
    ]);
    await page.waitForTimeout(2200);
    const t = await mainText(page);
    check('failed upload: the reason is shown per file', (t.match(/A subscription is required to upload\./g) ?? []).length >= 2, t.slice(0, 500));
    check('failed upload: pipeline does not claim files were uploaded', /1\. Uploaded 0\b/.test(t), (t.match(/1\. Uploaded \d+/) ?? [''])[0]);
    const badge = await page.locator('nav[aria-label="Primary"]').innerText();
    check('failed upload: Inbox badge does not count files that were never stored', !/\b2\b/.test(badge), badge.replace(/\s+/g, ' '));
    const alertTop = await page.getByTestId('bulk-failed-alert').boundingBox();
    check('failed upload: a summary alert sits at the top of Inbox (above the fold) with See plans', !!alertTop && alertTop.y < 300 && (await page.getByTestId('bulk-failed-alert').getByRole('button', { name: 'See plans' }).count()) === 1, JSON.stringify(alertTop));
    await shot(page, 'upload-failed');
    await page.context().close();
  }

  // ------------------------------------------------ 6. billing copy for a canceled / active tenant
  {
    const page = await open({ backend: { billing: 'canceled' } });
    const t = await mainText(page);
    check('canceled gate: no "30-day trial" offer (trial is already used)', !/30-day/.test(t), t.slice(0, 260));
    check('canceled gate: still lists plans', /Choose plan/.test(t));
    await page.context().close();
  }
  {
    const page = await open({ backend: { billing: 'none' } });
    const t = await mainText(page);
    check('new shop gate: leads with the 30-day trial', /Start 30-day free trial/.test(t) && /30-day free trial/.test(t));
    await page.context().close();
  }
  {
    const page = await open({ backend: { billing: 'active' } });
    await go(page, 'billing');
    const t = await mainText(page);
    check('active subscriber: Solo tile does not advertise a free trial', !/30-day free trial/.test(t), t.slice(0, 200));
    await page.context().close();
  }

  // ------------------------------------------------ 7. Team login-limit alert readable in the dark theme
  {
    const page = await open({ backend: { billing: 'active' } });
    await go(page, 'team');
    const alert = page.getByRole('alert').filter({ hasText: /login limit/ }).first();
    const color = await alert.evaluate((el) => getComputedStyle(el).color);
    check('Team login-limit alert (Office/dark) text is light enough to read', luminance(color) > 0.35, color);
    await shot(page, 'team-seat-limit-dark');
    await page.context().close();
  }

  // ------------------------------------------------ 8. customers: number never wraps; profile has call/email links
  {
    const page = await open({ backend: { docs: 12, customers: 6, longNames: true } });
    await go(page, 'browse');
    const numCell = page.locator('tbody tr').first().locator('td').first();
    const text = await numCell.innerText();
    // Text lines actually drawn (distinct client-rect tops of the cell's text), not the stretched cell height.
    const lines = await numCell.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size; });
    check('customers table: "C-00001" stays on one line beside a very long name', text.trim() === 'C-00001' && lines === 1, `${text} lines=${lines}`);
    check('customers table: long name/address wrap, no page overflow @1280', (await overflow(page)) <= 0);
    await page.getByText('Carol Rios').first().click();
    await page.waitForTimeout(900);
    const tel = await page.locator('a[href^="tel:"]').first().getAttribute('href');
    const mail = await page.locator('a[href^="mailto:"]').first().getAttribute('href');
    check('customer profile: phone has a tap-to-call link', tel === 'tel:4805550101', String(tel));
    check('customer profile: email has a mailto link', mail === 'mailto:c1@example.com', String(mail));
    await shot(page, 'customer-profile-links');
    await page.context().close();
  }

  // ------------------------------------------------ 9. mobile: first-run, errors, gate
  {
    const page = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { docs: 0, customers: 0 }, url: '?tab=ask' });
    await page.waitForTimeout(500);
    const hint = page.getByTestId('mobile-first-run');
    check('mobile empty shop: Ask tab points at Scan instead of "All clear"', (await hint.count()) === 1 && !/All clear/.test(await page.locator('main').innerText()));
    await shot(page, 'mobile-first-run');
    await hint.getByRole('button', { name: /Scan your first document/ }).click();
    await page.waitForTimeout(300);
    check('mobile empty shop: the button opens the Scan tab', /Scan paperwork/.test(await page.locator('main').innerText()));
    check('mobile empty shop: no endless sample skeleton', (await page.locator('[data-testid="sample-prompts-placeholder"]').count()) === 0);
    await page.context().close();
  }
  {
    const page = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { billing: 'none' }, url: '?tab=ask' });
    check('mobile plan gate: account menu (sign out / switch shop) is reachable', (await page.getByRole('button', { name: 'User menu' }).count()) === 1 && /Choose a plan to continue/.test(await page.locator('body').innerText()));
    await page.context().close();
  }
  {
    const page = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { docs: 12, customers: 6 }, url: '?tab=ask' });
    check('mobile shop with documents: no first-run card', (await page.getByTestId('mobile-first-run').count()) === 0);
    await page.context().close();
  }
  {
    const page = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { docs: 12, fail: { status: 500, html: true, match: /api\/ask/ } }, url: '?tab=ask' });
    const box = page.locator('textarea, input:not([type=checkbox])').first();
    await box.fill('serial at 1000 N 20th St');
    await box.press('Enter');
    await page.waitForTimeout(1200);
    const t = await page.locator('main').innerText();
    check('mobile Ask 500: no raw "500 Internal Server Error"', !/500 Internal/.test(t) && /Something went wrong on our end/.test(t), t.slice(0, 200));
    await page.context().close();
  }
  {
    const page = await open({ mobile: true, vp: { width: 390, height: 844 }, backend: { fail: { status: 500, html: true, match: /api\/records/ } }, url: '?tab=docs' });
    const alert = await page.getByRole('alert').first().innerText().catch(() => '');
    check('mobile records 500: banner is plain language', /Couldn't load your records: Something went wrong on our end\./.test(alert.replace(/\s+/g, ' ')), alert);
    await page.context().close();
  }

  // ------------------------------------------------ 9b. onboarding (no shop yet) is readable in the default dark theme
  for (const field of [false, true]) {
    const page = await open({ auth: { orgId: null }, field, vp: { width: 390, height: 844 } });
    const rgbOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
    const plateBg = await page.locator('main, div').filter({ hasText: /DeepWell accounts belong to a shop/ }).last().evaluate((el) => getComputedStyle(el.closest('[style*="background"]') ?? el).backgroundColor);
    for (const [label, loc] of [
      ['intro paragraph', page.getByText(/DeepWell accounts belong to a shop/)],
      ['"Create your shop" option', page.getByText('Create your shop', { exact: true })],
      ['option helper text', page.getByText(/You're the first one here/)],
    ]) {
      const ratio = (luminance(plateBg) + 0.05) / (luminance(await rgbOf(loc)) + 0.05);
      check(`onboarding (${field ? 'Field' : 'Office'}): ${label} contrast >= 4.5 on the plate`, ratio >= 4.5, `ratio ${ratio.toFixed(2)}`);
    }
    if (!field) await shot(page, 'onboarding-390');
    await page.context().close();
  }

  // ------------------------------------------------ 10. sanity: the healthy app raises no console errors on any screen
  for (const field of [false, true]) {
    const page = await open({ field, backend: { docs: 12, customers: 6 } });
    for (const s of ['ask', 'dashboard', 'ingest', 'browse', 'billing', 'team', 'outreach', 'warranty-export']) await go(page, s);
    check(`healthy app (${field ? 'Field' : 'Office'} theme): no console/page errors across every screen`, page.__errs.length === 0, page.__errs.join(' | '));
    await page.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
process.exit(failures ? 1 : 0);
