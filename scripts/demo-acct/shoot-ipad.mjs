#!/usr/bin/env node
// iPad-size screenshots of the demo picker and a Donovan answer (portrait 1024x1366 iPad Pro 12.9" and 820x1180 iPad Air),
// rendered from the REAL components with the Clerk mock (scripts/demo-acct/ui-harness). Answers are the exact bodies the
// REAL /api/ask handler returned on the locally seeded demo companies (capture-answers.mjs).
//   node scripts/demo-acct/shoot-ipad.mjs <answers.json> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [answersFile, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const answers = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
const { createServer } = await import('vite');
const react = (await import('@vitejs/plugin-react')).default;
const tailwindcss = (await import('tailwindcss')).default;
const autoprefixer = (await import('autoprefixer')).default;
const { chromium } = await import('playwright');
const H = path.join(REPO, 'scripts/demo-acct/ui-harness');
const server = await createServer({
  root: REPO, configFile: false, envDir: false, logLevel: 'warn',
  define: { 'import.meta.env.VITE_ANSWER_PROVIDER': JSON.stringify('claude') },
  resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(H, 'clerk-mock.tsx') }] },
  css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
  plugins: [react()], server: { port: 5291, strictPort: false, fs: { allow: [REPO] } },
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/scripts/demo-acct/ui-harness/index.html`;
const browser = await chromium.launch();
const errors = [];
const shots = [];
for (const [w, h, tag] of [[1024, 1366, 'ipad-pro-12.9'], [820, 1180, 'ipad-air']]) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: false });
    page.on('pageerror', (e) => errors.push(`${tag}/${theme}: ${e.message}`));
    await page.addInitScript(({ a, t }) => { window.__ANSWERS = a; try { localStorage.setItem('deepwell.fieldMode', t === 'light' ? '1' : '0'); sessionStorage.clear(); } catch {} }, { a: answers, t: theme });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.waitForSelector('text=Pick your industry');
    const pf = path.join(OUT, `picker-${tag}-${theme}.png`);
    await page.screenshot({ path: pf, fullPage: true }); shots.push(pf);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) errors.push(`${tag}/${theme}: picker scrolls sideways`);
    const tile = page.getByRole('button', { name: /HVAC/ }).first();
    const box = await tile.boundingBox();
    if (!box || box.height < 48) errors.push(`${tag}: tile tap target too small (${box?.height})`);
    await tile.click();
    await page.waitForSelector('text=Try asking');
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    const af = path.join(OUT, `ask-start-${tag}-${theme}.png`);
    await page.screenshot({ path: af, fullPage: true }); shots.push(af);
    const q = "When does Harlan Whitcombe's maintenance agreement expire?";
    await page.getByRole('button', { name: q }).first().click();
    await page.waitForTimeout(1200);
    const qf = path.join(OUT, `ask-answer-${tag}-${theme}.png`);
    await page.screenshot({ path: qf, fullPage: true }); shots.push(qf);
    const ov2 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (ov2) errors.push(`${tag}/${theme}: ask screen scrolls sideways`);
    if (theme === 'light') {
      await page.getByRole('button', { name: 'Clear my scans' }).first().click();
      await page.waitForSelector('text=Remove every document scanned');
      const cf = path.join(OUT, `clear-scans-${tag}.png`);
      await page.screenshot({ path: cf }); shots.push(cf);
    }
    await page.close();
  }
}
await browser.close();
await server.close();
console.log(JSON.stringify({ shots, errors }, null, 1));
process.exit(errors.length ? 1 : 0);
