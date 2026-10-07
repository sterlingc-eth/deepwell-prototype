// Round 28 — Support widget browser check. Serves public/ with the production CSP + a mocked /api/support,
// then drives the widget at 1440x900 and 390x844, light and dark. Screenshots: $SUPPORT_SHOTS_DIR or ./support-shots.
// Needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/verify-support-widget.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const SHOTS = process.env.SUPPORT_SHOTS_DIR || path.join(ROOT, 'support-shots');
mkdirSync(SHOTS, { recursive: true });
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const CSP = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${extra}`); } };

const apiLog = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/support') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (code, o, delay = 0) => setTimeout(() => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }, delay);
      if (req.method === 'GET') return send(200, { greeting: "Hi, I'm the DeepWell Support Assistant, an AI. Ask me about plans, setup or security.", suggestions: ['How much does DeepWell cost?', 'Is there a free trial?', 'How does DeepWell work?'] });
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* */ }
      apiLog.push(b);
      if (b.action === 'handoff') return send(200, { ok: true });
      const m = String(b.message || '').toLowerCase();
      if (m.includes('cost')) return send(200, { reply: 'Solo is $99/month, Shop $199/month, Crew $399/month and Fleet $899+/month. See https://deepwelltechnology.com/#pricing for details.', sources: [{ id: 'plans-and-pricing', title: 'Plans and pricing' }], mode: 'faq', suggestions: ['Is there a free trial?', 'Is there annual pricing?'] }, 150);
      if (m.includes('slow')) return send(200, { reply: 'Slow answer.', sources: [], mode: 'faq' }, 700);
      return send(200, { reply: "I'm not sure about that one — want me to pass it to the team?", sources: [], mode: 'fallback', handoff: { offered: true, reason: 'no-answer' } }, 120);
    });
    return;
  }
  let p = decodeURIComponent(u.pathname);
  let f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!existsSync(f) && existsSync(`${f}.html`)) f = `${f}.html`;
  if (!existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  const h = { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' };
  if (f.endsWith('.html')) h['Content-Security-Policy'] = CSP;
  res.writeHead(200, h); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const inPanel = (page) => page.evaluate(() => { const p = document.getElementById('dwh-panel'); return Boolean(p && p.contains(document.activeElement)); });

async function newPage(vp, scheme, reducedMotion = 'no-preference') {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion, deviceScaleFactor: 1, hasTouch: vp.width < 600, isMobile: vp.width < 600 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/_vercel/')) errors.push(`HTTP ${r.status()} ${r.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`); });
  page.on('console', (m) => { if (/Failed to load resource/.test(m.text())) return; if (m.type() === 'error' || /Refused to|Content Security Policy/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`.slice(0, 200)));
  await ctx.route((url) => !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), (route) => route.fulfill({ status: 200, contentType: route.request().url().includes('css') ? 'text/css' : 'text/plain', body: '' }));
  return { ctx, page, errors };
}

const combos = [
  { name: 'desktop-light', vp: { width: 1440, height: 900 }, scheme: 'light' },
  { name: 'desktop-dark', vp: { width: 1440, height: 900 }, scheme: 'dark' },
  { name: 'mobile-light', vp: { width: 390, height: 844 }, scheme: 'light' },
  { name: 'mobile-dark', vp: { width: 390, height: 844 }, scheme: 'dark' },
];

for (const c of combos) {
  const mobile = c.vp.width < 600;
  const { ctx, page, errors } = await newPage(c.vp, c.scheme);
  await page.goto(`${BASE}/security.html`, { waitUntil: 'load' });
  await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), c.scheme);
  await page.waitForSelector('.dwh-launcher');
  const L = page.locator('.dwh-launcher');
  const box = await L.boundingBox();
  check(`${c.name}: launcher is a 56px circle`, Math.abs(box.width - 56) < 1 && Math.abs(box.height - 56) < 1);
  check(`${c.name}: launcher sits bottom-right with >=16px margin`, c.vp.width - (box.x + box.width) >= 15.5 && c.vp.height - (box.y + box.height) >= 15.5);
  check(`${c.name}: pulse runs after load`, await page.evaluate(() => document.querySelector('.dwh-launcher').classList.contains('dwh-pulse')));
  await page.screenshot({ path: path.join(SHOTS, `${c.name}-1-closed.png`) });
  if (!mobile && c.name === 'desktop-light') {
    await page.waitForSelector('.dwh-tip', { timeout: 9000 }).then(() => check('desktop: tooltip appears after ~6s', true), () => check('desktop: tooltip appears after ~6s', false));
    await page.screenshot({ path: path.join(SHOTS, `${c.name}-2-tooltip.png`) });
  }
  if (mobile) check(`${c.name}: no tooltip on mobile`, (await page.locator('.dwh-tip').count()) === 0);

  await L.click();
  await page.waitForSelector('#dwh-panel:not([hidden])');
  await page.waitForTimeout(350); // entrance animation
  const panel = await page.locator('#dwh-panel').boundingBox();
  check(`${c.name}: dialog role + label`, await page.evaluate(() => { const p = document.getElementById('dwh-panel'); return p.getAttribute('role') === 'dialog' && Boolean(p.getAttribute('aria-label')); }));
  if (mobile) {
    check(`${c.name}: bottom sheet is full width, <=85dvh, flush bottom`, Math.abs(panel.width - 390) < 1 && panel.height <= 844 * 0.85 + 1 && Math.abs(panel.y + panel.height - 844) < 2, JSON.stringify(panel));
    check(`${c.name}: aria-modal on the sheet`, (await page.getAttribute('#dwh-panel', 'aria-modal')) === 'true');
    check(`${c.name}: launcher hidden while sheet open`, !(await L.isVisible()));
  } else {
    check(`${c.name}: panel is 380 wide, <=560 tall`, Math.abs(panel.width - 380) < 1 && panel.height <= 561, JSON.stringify(panel));
  }
  check(`${c.name}: no tooltip left open`, (await page.locator('.dwh-tip').count()) === 0);
  check(`${c.name}: focus lands in the panel`, await inPanel(page));
  await page.waitForSelector('.dwh-chip');
  check(`${c.name}: starter chips shown`, (await page.locator('.dwh-chip').count()) >= 3);
  const small = await page.evaluate(() => [...document.querySelectorAll('#dwh-panel button, #dwh-panel textarea, #dwh-panel input')].filter((n) => n.getClientRects().length).map((n) => [n.className || n.tagName, n.getBoundingClientRect().height]).filter(([, h]) => h < 43.5));
  check(`${c.name}: every control >=44px tall`, small.length === 0, JSON.stringify(small));
  await page.screenshot({ path: path.join(SHOTS, `${c.name}-3-open.png`) });

  // focus trap
  let escaped = false;
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); if (!(await inPanel(page))) escaped = true; }
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inPanel(page))) escaped = true; }
  check(`${c.name}: Tab / Shift+Tab never leave the panel`, !escaped);

  // conversation
  await page.locator('.dwh-chip', { hasText: 'How much does DeepWell cost?' }).first().click();
  await page.waitForSelector('.dwh-src');
  check(`${c.name}: answer shows "From:" source`, /From: Plans and pricing/.test(await page.locator('.dwh-src').first().innerText()));
  const link = page.locator('.dwh-b a').first();
  check(`${c.name}: links open in new tab with noopener`, (await link.getAttribute('target')) === '_blank' && /noopener/.test((await link.getAttribute('rel')) || ''));
  check(`${c.name}: user bubble right, assistant left`, await page.evaluate(() => { const u = document.querySelector('.dwh-m.u .dwh-b').getBoundingClientRect(), a = document.querySelector('.dwh-m.a .dwh-b').getBoundingClientRect(); return u.left > a.left; }));
  // Enter sends, Shift+Enter is a newline
  await page.locator('#dwh-panel textarea').first().fill('');
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  check(`${c.name}: Shift+Enter inserts a newline`, (await page.locator('#dwh-panel textarea').first().inputValue()) === 'line one\nline two');
  await page.locator('#dwh-panel textarea').first().fill('');
  await page.keyboard.type('something unknown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dwh-offer');
  check(`${c.name}: request sent {message, history, surface:'public', page}`, (() => { const b = apiLog.filter((x) => x.message === 'something unknown').pop(); return b && b.surface === 'public' && Array.isArray(b.history) && typeof b.page === 'string'; })());
  await page.locator('.dwh-offer').click();
  await page.waitForSelector('.dwh-form-h');
  await page.locator('.dwh-form-h button[type=submit]').click();
  check(`${c.name}: handoff rejects an empty email`, /valid email/i.test(await page.locator('.dwh-err').innerText()));
  await page.locator('.dwh-form-h input[type=email]').fill('pat@example.com');
  await page.screenshot({ path: path.join(SHOTS, `${c.name}-4-handoff.png`) });
  await page.locator('.dwh-form-h button[type=submit]').click();
  await page.waitForFunction(() => /Sent/.test(document.querySelector('.dwh-log').innerText));
  check(`${c.name}: handoff confirmation names the email`, /Sent .* we'll reply to pat@example\.com\./.test(await page.locator('.dwh-log').innerText()));
  const ho = apiLog.filter((x) => x.action === 'handoff').pop();
  check(`${c.name}: handoff body {email,message,surface,transcript<=12}`, ho && ho.email === 'pat@example.com' && ho.message && ho.surface === 'public' && ho.transcript.length <= 12);
  await page.screenshot({ path: path.join(SHOTS, `${c.name}-5-conversation.png`) });

  // Esc + focus return
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dwh-panel', { state: 'hidden' });
  check(`${c.name}: Esc closes and focus returns to the launcher`, await page.evaluate(() => document.activeElement === document.querySelector('.dwh-launcher')));
  // reopen restores the conversation (sessionStorage)
  await L.click();
  check(`${c.name}: reopen keeps the conversation`, /pat@example\.com/.test(await page.locator('.dwh-log').innerText()));
  await page.locator('.dwh-x').click();

  // launcher must not cover page controls at the bottom of the page
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  const overlaps = await page.evaluate(() => {
    const l = document.querySelector('.dwh-launcher').getBoundingClientRect();
    return [...document.querySelectorAll('a, button, input, textarea, select')].filter((n) => !n.closest('.dwh-root')).map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && r.left < l.right && r.right > l.left && r.top < l.bottom && r.bottom > l.top)
      .map(({ n }) => `${n.tagName} ${(n.textContent || '').trim().slice(0, 30)}`);
  });
  check(`${c.name}: launcher covers no page link/button at page bottom`, overlaps.length === 0, JSON.stringify(overlaps));
  check(`${c.name}: no console or CSP errors`, errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

// reduced motion
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 }, 'light', 'reduce');
  await page.goto(`${BASE}/security.html`, { waitUntil: 'load' });
  await page.waitForSelector('.dwh-launcher');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const l = document.querySelector('.dwh-launcher');
    return { cls: l.classList.contains('dwh-pulse'), before: getComputedStyle(l, '::before').animationName, circle: getComputedStyle(l.querySelector('circle')).animationName };
  });
  check('reduced-motion: no pulse class and no animation on launcher', !r.cls && r.before === 'none' && r.circle === 'none', JSON.stringify(r));
  await page.locator('.dwh-launcher').click();
  await page.waitForSelector('#dwh-panel:not([hidden])');
  check('reduced-motion: panel has no entrance animation', (await page.evaluate(() => getComputedStyle(document.getElementById('dwh-panel')).animationName)) === 'none');
  await ctx.close();
}

// pulse stops while open (normal motion) + 429 handling + busy state
{
  const { ctx, page } = await newPage({ width: 1440, height: 900 }, 'light');
  await page.goto(`${BASE}/security.html`, { waitUntil: 'load' });
  await page.waitForSelector('.dwh-launcher');
  await page.locator('.dwh-launcher').click();
  check('pulse stops while the panel is open', !(await page.evaluate(() => document.querySelector('.dwh-launcher').classList.contains('dwh-pulse'))));
  await page.route(`${BASE}/api/support`, (route) => route.request().method() === 'POST' ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'slow down', retryAfterSec: 42 }) }) : route.continue());
  await page.locator('#dwh-panel textarea').first().fill('hello there');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /42 seconds/.test(document.querySelector('.dwh-log').innerText));
  check('429 shows a wait message using retryAfterSec', true);
  const cnt = await page.evaluate(() => { const t = document.querySelector('#dwh-panel textarea'); t.value = 'x'.repeat(590); t.dispatchEvent(new Event('input')); return document.querySelector('.dwh-count').textContent; });
  check('char counter appears near the limit', cnt === '590/600', cnt);
  await ctx.close();
}

// every page that carries the widget loads it cleanly (desktop light)
for (const p of ['/security.html', '/terms.html', '/privacy.html', '/industries/hvac.html', '/industries/electrical.html', '/industries/plumbing.html', '/industries/property-management.html', '/industries/any-business.html', '/industries/contractors.html', '/industries/offices.html', '/industries/nonprofits.html', '/get/']) {
  const { ctx, page, errors } = await newPage({ width: 1440, height: 900 }, 'light');
  await page.goto(`${BASE}${p}`, { waitUntil: 'load' });
  const ok = await page.waitForSelector('.dwh-launcher', { timeout: 4000 }).then(() => true, () => false);
  check(`${p}: launcher present, no console/CSP errors`, ok && errors.length === 0, JSON.stringify(errors));
  await ctx.close();
}

// index.html is owned by another engineer: report whether the tags are there yet, never edit it.
const idx = existsSync(path.join(ROOT, 'index.html')) ? readFileSync(path.join(ROOT, 'index.html'), 'utf8') : '';
console.log(`INFO  index.html has widget tags: ${idx.includes('/support/widget.js') && idx.includes('/support/widget.css')} (owner adds them)`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${SHOTS}`);
process.exit(fail ? 1 : 0);
