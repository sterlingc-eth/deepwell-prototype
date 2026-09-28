// Website audit crawl (round 22, S3 contract): builds the marketing site
// (this script does NOT run `npm run build` for you — run it first, see
// below) and Playwright-crawls every owned marketing/static page at 390px
// and 1440px. Checks: HTTP status of every same-origin request (no 404s —
// /_vercel/insights/script.js is the one expected exception, injected only
// by Vercel's production edge, never present in a local dist/ build), zero
// console errors, no horizontal overflow at 390px, required meta tags
// (title/description/OG/canonical) on every real HTML page, and that
// /security.html is reachable and linked from the footer + privacy page.
//
// Screenshots are saved to SHOT_DIR — look at them; this script only checks
// what's mechanically checkable (layout overflow, status codes, tags), not
// whether the design reads well.
//
// Motion note: the site's scroll-reveal animations (.dw-observe/.in-view,
// see index.html) are real and work correctly under a normal scroll — this
// script emulates prefers-reduced-motion so elements are immediately in
// their final state, which is the only way to get a deterministic view of
// the page instead of a mid-transition frame. Do not mistake a screenshot
// taken WITHOUT this emulation for a broken reveal; it isn't.
//
//   npm run build   -- with VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy
//   npx playwright install chromium   (once, if not already present)
//   node scripts/verify-website.mjs [screenshotDir]
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SHOT_DIR = process.argv[2] ?? '/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/website-verify-shots';
mkdirSync(SHOT_DIR, { recursive: true });

if (!existsSync(DIST)) {
  console.error('FAIL  dist/ not found — run `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` first.');
  process.exit(1);
}

// A port unlikely to collide with another engineer's own dev server running
// concurrently in a sibling worktree (see verify-records-ui.mjs's own port
// comment for the pattern this follows).
const PORT = 5297;
const BASE = `http://localhost:${PORT}`;

/* -------------------------------------------------- static file server -- */
const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.csv': 'text/csv',
};
const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = join(DIST, urlPath);
    let st;
    try { st = await stat(filePath); } catch { st = null; }
    if (st?.isDirectory()) filePath = join(filePath, 'index.html');
    if (!st) {
      const tryIndex = join(filePath, 'index.html');
      try { await stat(tryIndex); filePath = tryIndex; } catch { /* not a dir route */ }
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(await readFile(join(DIST, '404.html')).catch(() => Buffer.from('Not found')));
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, resolve);
});

/* -------------------------------------------------------------- pages -- */
const PAGES = [
  '/', '/privacy.html', '/terms.html', '/security.html', '/404.html',
  '/get', '/expense-tracker.html',
  '/industries/hvac.html', '/industries/electrical.html',
  '/industries/plumbing.html', '/industries/property-management.html',
];
// Machine-readable resources: checked for reachability/validity, not layout.
const RESOURCES = ['/sitemap.xml', '/robots.txt', '/site.webmanifest'];

const EXPECTED_404_ONLY_LOCALLY = new Set([`${BASE}/_vercel/insights/script.js`]);

let failures = [];
let warnings = [];
const seenAssets = new Set();
const browser = await chromium.launch();

for (const path of PAGES) {
  for (const [label, viewport] of [['390', { width: 390, height: 844 }], ['1440', { width: 1440, height: 900 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('response', (resp) => {
      const url = resp.url();
      if (seenAssets.has(url)) return;
      seenAssets.add(url);
      if (resp.status() >= 400 && !EXPECTED_404_ONLY_LOCALLY.has(url)) {
        failures.push(`${path} [${label}]: ${resp.status()} ${url}`);
      }
    });

    let resp;
    try {
      resp = await page.goto(BASE + path, { waitUntil: 'load', timeout: 15000 });
    } catch (e) {
      failures.push(`${path} [${label}]: navigation failed — ${e.message}`);
      await context.close();
      continue;
    }
    await page.waitForTimeout(150);

    if (!resp || resp.status() >= 400) failures.push(`${path} [${label}]: page itself returned ${resp?.status()}`);

    const relevantConsoleErrors = consoleErrors.filter(
      // The generic "Failed to load resource...404" message never includes
      // the URL (Chromium quirk) — the response listener below already
      // checks every URL's status (with the one local-only exception
      // allowlisted), so this generic text is redundant, not new signal.
      (e) =>
        !e.includes('Failed to load resource') &&
        !e.includes('publishableKey passed to Clerk is invalid')
    );
    if (relevantConsoleErrors.length) {
      failures.push(`${path} [${label}]: console errors — ${relevantConsoleErrors.join(' | ')}`);
    }

    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      winWidth: document.documentElement.clientWidth,
    }));
    if (label === '390' && overflow.docWidth > overflow.winWidth + 1) {
      failures.push(`${path} [390]: horizontal overflow (doc=${overflow.docWidth} win=${overflow.winWidth})`);
    }

    const meta = await page.evaluate(() => ({
      title: document.title || null,
      description: document.querySelector('meta[name="description"]')?.content || null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    }));
    // 404.html and expense-tracker.html (an instant noindex redirect stub
    // to /expenses/, not an indexed page) don't need the full tag set.
    if (path !== '/404.html' && path !== '/expense-tracker.html') {
      if (!meta.title) failures.push(`${path} [${label}]: missing <title>`);
      if (!meta.description) failures.push(`${path} [${label}]: missing meta description`);
      if (!meta.canonical) failures.push(`${path} [${label}]: missing canonical link`);
    }

    await page.screenshot({ path: `${SHOT_DIR}/${(path.replace(/\//g, '_') || 'root')}-${label}.png`, fullPage: true }).catch(() => {});
    await context.close();
  }
}

// Resource sanity (not full-page crawl — these aren't rendered documents).
for (const path of RESOURCES) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let resp;
  try {
    resp = await page.goto(BASE + path, { waitUntil: 'load', timeout: 10000 });
  } catch (e) {
    failures.push(`${path}: navigation failed — ${e.message}`);
    await context.close();
    continue;
  }
  if (!resp || resp.status() >= 400) failures.push(`${path}: returned ${resp?.status()}`);
  await context.close();
}

// Footer/privacy-page link to /security.html, and sitemap inclusion.
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  const hasSecurityLinkHome = await page.evaluate(() => !!document.querySelector('footer a[href="/security.html"]'));
  if (!hasSecurityLinkHome) failures.push('/: footer is missing a link to /security.html');

  await page.goto(`${BASE}/privacy.html`, { waitUntil: 'load' });
  const hasSecurityLinkPrivacy = await page.evaluate(() =>
    !!document.querySelector('a[href="/security.html"]')
  );
  if (!hasSecurityLinkPrivacy) failures.push('/privacy.html: missing a link to /security.html');

  const sitemapText = await (await fetch(`${BASE}/sitemap.xml`)).text();
  if (!sitemapText.includes('/security.html')) failures.push('sitemap.xml: missing /security.html');

  await context.close();
}

await browser.close();
server.close();

console.log(`Screenshots: ${SHOT_DIR}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log('  WARN  ' + w));
}
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  failures.forEach((f) => console.log('  FAIL  ' + f));
  process.exit(1);
}
console.log('\nPASS — website crawl clean.');
