/**
 * Inbox redesign: screenshots + layout measurements over a synthetic inbox (scripts/inbox-harness/).
 *   node scripts/inbox-shoot.mjs <tag> <outDir> [papers=400]
 * Writes <outDir>/<tag>_<desktop|phone>_<unscrolled|scrolled>.png and prints what covers the bottom of the screen.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? 'run';
const OUT = process.argv[3] ?? path.join(REPO, '..', 'inbox-shots');
const N = Number(process.argv[4] ?? 400);
mkdirSync(OUT, { recursive: true });
process.chdir(REPO);

const { createServer } = await import('vite');
const reactPlugin = (await import('@vitejs/plugin-react')).default;
const { chromium } = await import('playwright');
const tailwindcss = (await import('tailwindcss')).default;
const autoprefixer = (await import('autoprefixer')).default;
const HARNESS = path.join(REPO, 'scripts', 'inbox-harness');

const server = await createServer({
  root: REPO, configFile: false, envFile: false, logLevel: 'warn',
  define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true') },
  resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(REPO, 'scripts', 'desktop-harness', 'clerk-mock.tsx') }] },
  css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
  plugins: [reactPlugin()],
  server: { port: 5191, strictPort: false, fs: { allow: [REPO] } },
});
await server.listen();
const addr = server.httpServer.address();
const port = typeof addr === 'object' && addr ? addr.port : addr;
const browser = await chromium.launch();
const report = {};
try {
  for (const [name, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://localhost:${port}/scripts/inbox-harness/index.html?n=${N}&theme=light`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${tag}_${name}_unscrolled.png`) });
    // Scroll the way a person does: the list's own area if it has one, and the page.
    const info = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="needs-list"]');
      const scrollables = [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4; }).map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.className.toString().slice(0, 40)}] ${el.scrollHeight}/${el.clientHeight}`);
      return { listFound: !!list, scrollables, docHeight: document.documentElement.scrollHeight, rows: document.querySelectorAll('[data-doc-id]').length };
    });
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="needs-list"]');
      if (list && list.scrollHeight > list.clientHeight) list.scrollTop = 600;
    });
    await page.mouse.move(vp.width / 3, vp.height / 2);
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${tag}_${name}_scrolled.png`) });
    // Scroll the PAGE to its very end (pointer outside the list) to look at the footer banner.
    await page.mouse.move(vp.width - 4, 4);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${tag}_${name}_page-end.png`) });
    // What sits at the bottom edge of the screen, and does any of it overlap the footer text or the content?
    const bottom = await page.evaluate(() => {
      const w = window.innerWidth, h = window.innerHeight;
      const pts = [[w * 0.1, h - 8], [w * 0.5, h - 8], [w * 0.9, h - 8], [w * 0.5, h - 40]];
      const hit = pts.map(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ').slice(0, 3).join('.')}` : 'none'; });
      const footer = [...document.querySelectorAll('footer')].pop();
      const fr = footer ? footer.getBoundingClientRect() : null;
      const fixed = [...document.querySelectorAll('*')].filter((el) => { const s = getComputedStyle(el); return (s.position === 'fixed' || s.position === 'sticky') && el.getBoundingClientRect().bottom >= h - 100 && el.getBoundingClientRect().height > 0; }).map((el) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()} pos=${getComputedStyle(el).position} z=${getComputedStyle(el).zIndex} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} :: ${(el.textContent ?? '').trim().slice(0, 40)}`; });
      const regionEl = document.querySelector('[data-testid="needs-list"]');
      const rr = regionEl ? regionEl.getBoundingClientRect() : null;
      const overlapsFooter = !!(fr && rr && rr.bottom > fr.top && rr.top < fr.bottom);
      const footerTopmost = footer ? (() => { const r = footer.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 40, r.top + r.height / 2); return !!el && footer.contains(el); })() : null;
      return { overlapsFooter, footerTopmost, listRect: rr ? [Math.round(rr.top), Math.round(rr.bottom)] : null, viewport: [w, h], scrollY: Math.round(window.scrollY), docHeight: document.documentElement.scrollHeight, bottomHits: hit, footerRect: fr ? [Math.round(fr.top), Math.round(fr.bottom)] : null, fixedOrStickyNearBottom: fixed };
    });
    // Redesign only: another group open, and the bulk confirm dialog (nothing is confirmed).
    if (await page.locator('[data-testid="inbox-triage"]').count()) {
      await page.evaluate(() => { document.querySelector('[data-testid="needs-list"]').scrollTop = 0; window.scrollTo(0, 0); });
      const g = page.locator('[data-testid="inbox-triage"] h3 button', { hasText: 'Check and approve' });
      await g.click();
      await page.waitForTimeout(250);
      await page.evaluate(() => { const l = document.querySelector('[data-testid="needs-list"]'); l.scrollIntoView({ block: 'start' }); });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, `${tag}_${name}_approve-group.png`) });
      await page.getByRole('button', { name: /^Approve all/ }).click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, `${tag}_${name}_confirm-dialog.png`) });
      await page.getByRole('button', { name: 'Cancel' }).click();
      const m2 = page.locator('[data-testid="inbox-triage"] h3 button', { hasText: 'Add missing info' });
      await m2.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, `${tag}_${name}_missing-group.png`) });
    }
    report[name] = { ...info, ...bottom, errors: errs };
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(path.join(OUT, `${tag}_measurements.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
