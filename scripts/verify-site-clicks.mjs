// verify:site-clicks - every clickable thing on the public marketing site must go somewhere real.
//
// STATIC part (plain Node, always runs): parses every public page, checks every <a> (no '#'/empty/javascript: hrefs,
//   anchors point at existing ids, internal paths resolve through vercel.json redirects/rewrites to a real file,
//   mailto/tel valid, target=_blank has rel=noopener), checks every "Try ..." button goes to /demo/ (or /demo/?industry=<slug>
//   with a real demo slug), that the industries nav dropdown lists + links every demo industry and the hub with no
//   disabled / "soon" items, that the homepage has no leftover interactive "Try it" sample, and that /demo is wired
//   (vercel.json rewrite, demo/index.html, vite.config flag gate).
// BROWSER part (Playwright, runs when it is installed): at 1440 and 390 it opens the dropdown by click / keyboard / tap,
//   closes it (Esc, outside click), clicks every Try button and checks it lands on a loading demo page, checks no overlay
//   covers a nav/CTA control, no disabled nav item, and no console errors on load.
// Usage: node scripts/verify-site-clicks.mjs [--dist <dir>] [--audit <out.json>] [--shots <dir>] [--no-browser]
//   --dist  serve a built dist/ (needed to really load /demo/); default serves the source tree like Vercel would.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const DIST = arg('--dist') ? path.resolve(arg('--dist')) : null;
const AUDIT_OUT = arg('--audit');
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
const NO_BROWSER = process.argv.includes('--no-browser');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/industries-site/data.json'), 'utf8'));
const DEMO_SLUGS = data.industries.map((i) => i.slug);
const EXISTING = { 'plumbing-hvac': 'hvac.html', electrical: 'electrical.html', 'property-management': 'property-management.html', 'general-contractor': 'contractors.html', nonprofit: 'nonprofits.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

const failures = [];
const rows = []; // audit table rows
const fail = (page, el, expected, actual, fix) => { failures.push({ page, el, expected, actual, fix }); rows.push({ page, el, expected, actual, status: 'FAIL', fix }); };
const ok = (page, el, expected, actual) => rows.push({ page, el, expected, actual, status: 'ok', fix: '' });

// ---------- Vercel-like routing over the source tree (or a dist) ----------
function lookupFile(p) {
  const clean = decodeURIComponent(p.split('?')[0].split('#')[0]);
  const tryFile = (f) => (fs.existsSync(f) && fs.statSync(f).isFile() ? f : null);
  const dirIdx = (f) => (fs.existsSync(f) && fs.statSync(f).isDirectory() ? tryFile(path.join(f, 'index.html')) : null);
  if (DIST) { const f = path.join(DIST, clean); return tryFile(f) || dirIdx(f); }
  const pub = path.join(ROOT, 'public', clean);
  const hit = tryFile(pub) || dirIdx(pub);
  if (hit) return hit;
  if (clean === '/' || clean === '/index.html') return tryFile(path.join(ROOT, 'index.html'));
  if (clean === '/patch-notes.html') return tryFile(path.join(ROOT, 'patch-notes.html'));
  const m = /^\/(app|m|expenses|demo)(\/index\.html|\/)?$/.exec(clean); // built entry pages (source copies exist at the repo root)
  if (m) return tryFile(path.join(ROOT, m[1], 'index.html'));
  return null;
}
function compile(source) {
  let re = source.replace(/[.+^${}|[\]\\]/g, '\\$&').replace(/\//g, '\\/').replace(/:([A-Za-z_]+)/g, '([^/]+)').replace(/\(\.\*\)/g, '(.*)');
  return new RegExp('^' + re + '$');
}
function route(pathname) {
  for (const r of cfg.redirects || []) if (compile(r.source).test(pathname)) return { kind: 'redirect', status: r.permanent ? 308 : 307, to: r.destination };
  if (pathname.startsWith('/api/') || pathname === '/api') return { kind: 'api' };
  let f = lookupFile(pathname);
  if (f) return { kind: 'file', file: f };
  for (const r of cfg.rewrites || []) {
    if (compile(r.source).test(pathname)) {
      const dest = r.destination.split('?')[0];
      f = lookupFile(dest);
      return f ? { kind: 'file', file: f, rewritten: dest } : { kind: 'missing', why: `rewrite ${r.source} -> ${r.destination} but that file does not exist` };
    }
  }
  return { kind: 'missing', why: 'no file and no rewrite' };
}
function resolveUrl(href, fromPath) {
  const u = new URL(href, 'http://local' + fromPath);
  let r = route(u.pathname), hops = 0;
  while (r.kind === 'redirect' && hops++ < 5) r = route(new URL(r.to, 'http://local').pathname);
  return { u, r };
}
const idsCache = new Map();
function idsOf(file) {
  if (!idsCache.has(file)) { const h = fs.readFileSync(file, 'utf8'); idsCache.set(file, new Set([...h.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]))); }
  return idsCache.get(file);
}

// ---------- pages ----------
const smLocs = [...fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8').matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || '/');
const pageSet = new Set(['/', '/who.html', '/industries/', '/get', ...smLocs]);
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) if (f.endsWith('.html') && f !== '404.html') pageSet.add('/' + f);
for (const f of fs.readdirSync(path.join(ROOT, 'public/industries'))) if (f.endsWith('.html')) pageSet.add(f === 'index.html' ? '/industries/' : '/industries/' + f);
pageSet.add('/patch-notes.html');
const PAGES = [...pageSet].filter((p) => !/^\/(app|m|expenses|demo)(\/|$)/.test(p) && !p.startsWith('/api/')).sort();

// sitemap entries must resolve
for (const p of smLocs) { const { r } = resolveUrl(p, '/'); if (r.kind !== 'file') fail('sitemap.xml', p, 'resolves', r.why || r.kind, 'remove from sitemap or add the page'); }

// ---------- static link checks ----------
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const TRY_RE = /^\s*(try\b|open the (full )?demo|start the demo|see the demo)/i;
const tryTargets = [];
for (const p of PAGES) {
  const r0 = resolveUrl(p, '/');
  if (r0.r.kind !== 'file') { fail(p, '(page)', 'page loads', r0.r.why || r0.r.kind, 'fix route'); continue; }
  const html = fs.readFileSync(r0.r.file, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, (m) => (/type=["']application\/json/.test(m) ? '' : '<script></script>')).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const ids = idsOf(r0.r.file);
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const m of anchors) {
    const attrs = m[1], text = stripTags(m[2]) || (/aria-label=["']([^"']+)/.exec(attrs) || [])[1] || '(icon)';
    const hm = /\shref=(?:"([^"]*)"|'([^']*)')/.exec(' ' + attrs);
    if (!hm) { fail(p, text, 'has href', 'anchor without href (dead click)', 'add href or make it a button'); continue; }
    const href = (hm[1] ?? hm[2]).trim().replace(/&amp;/g, '&');
    const tgt = (/\starget=["']([^"']+)/.exec(' ' + attrs) || [])[1];
    const rel = (/\srel=["']([^"']+)/.exec(' ' + attrs) || [])[1] || '';
    if (TRY_RE.test(text)) tryTargets.push({ p, text, href });
    if (href === '' || href === '#' || /^javascript:/i.test(href)) { fail(p, text, 'real destination', `href="${href}"`, 'point at a real page/anchor'); continue; }
    if (/^mailto:/i.test(href)) { (/^mailto:[^@\s?]+@[^@\s?]+\.[a-z]{2,}(\?.*)?$/i.test(href) || /^mailto:\?(subject|body)=/i.test(href)) ? ok(p, text, 'valid mailto', href) : fail(p, text, 'valid mailto', href, 'fix address'); continue; }
    if (/^tel:/i.test(href)) { /^tel:\+?[0-9][0-9\-\s().]{6,}$/.test(href) ? ok(p, text, 'valid tel', href) : fail(p, text, 'valid tel', href, 'fix number'); continue; }
    if (/^https?:\/\//i.test(href)) {
      const host = new URL(href).host;
      if (/(^|\.)deepwelltechnology\.com$/.test(host) && !host.startsWith('status.')) { fail(p, text, 'relative internal link', href, 'use a root-relative path'); continue; }
      if (tgt === '_blank' && !/noopener/.test(rel)) { fail(p, text, 'target=_blank has rel=noopener', `rel="${rel}"`, 'add rel="noopener noreferrer"'); continue; }
      ok(p, text, 'external', href); continue;
    }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      ids.has(id) || id === 'top' && /<body/i.test(html) ? ok(p, text, 'anchor exists', href) : fail(p, text, `id "${id}" exists on this page`, 'no such id', 'fix anchor or add the id');
      continue;
    }
    const { u, r } = resolveUrl(href, p);
    if (r.kind === 'api') { ok(p, text, 'api route', href); continue; }
    if (r.kind !== 'file') { fail(p, text, 'route exists in vercel.json/public', `${href}: ${r.why}`, 'add page or rewrite, or fix href'); continue; }
    if (u.hash && u.hash.length > 1 && /\.html$/.test(r.r?.file || r.file)) {
      const id = decodeURIComponent(u.hash.slice(1));
      if (!idsOf(r.file).has(id)) { fail(p, text, `anchor ${u.hash} exists on ${u.pathname}`, 'no such id there', 'fix anchor'); continue; }
    }
    ok(p, text, 'resolves', href);
  }
  // buttons that look like links (type=button without any handler cannot be seen statically; the browser part covers them)
  if (/class=["'][^"']*\bsoon\b[^"']*["']/.test(html) && /nav-dropdown|class=["']hub/.test(html) && /<a[^>]*class=["'][^"']*tag soon/.test(html)) fail(p, 'industry tag', 'no soon tag', 'tag soon present', 'remove');
}
// Try buttons
for (const t of tryTargets) {
  const m = /^\/demo\/(\?industry=([a-z0-9-]+))?$/.exec(t.href);
  if (!m) fail(t.p, t.text, '/demo/ or /demo/?industry=<slug>', t.href, 'point the button at the demo');
  else if (m[2] && !DEMO_SLUGS.includes(m[2])) fail(t.p, t.text, 'known demo slug', t.href, 'use a valid slug');
  else ok(t.p, t.text, 'Try -> demo', t.href);
}
// demo wiring
{
  const rw = (cfg.rewrites || []).filter((r) => r.source === '/demo' && r.destination === '/demo/index.html');
  rw.length ? ok('vercel.json', '/demo rewrite', 'present', '/demo -> /demo/index.html') : fail('vercel.json', '/demo rewrite', 'rewrite /demo -> /demo/index.html', 'missing', 'add rewrite');
  fs.existsSync(path.join(ROOT, 'demo/index.html')) ? ok('demo/index.html', 'entry', 'exists', 'yes') : fail('demo/index.html', 'entry', 'exists', 'missing', 'restore');
  for (const u of ['/demo', '/demo/', '/demo/?industry=realty', '/demo?industry=hotel']) { const { r } = resolveUrl(u, '/'); r.kind === 'file' ? ok('routing', u, 'serves demo page', r.file.replace(ROOT, '')) : fail('routing', u, 'serves demo page', r.why, 'fix rewrite'); }
  const vc = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  /VITE_DEEPWELL_DEMO/.test(vc) && /demo\/index\.html/.test(vc) ? ok('vite.config.ts', 'demo build entry', 'built when VITE_DEEPWELL_DEMO=true', 'gated (set VITE_DEEPWELL_DEMO=true in Vercel env)') : fail('vite.config.ts', 'demo build entry', 'demo page in build', 'missing', 'restore');
}
// nav dropdown static contract + homepage leftovers
const allowedNoDropdown = new Set(['/404.html']);
const needPages = DEMO_SLUGS.map((s) => '/industries/' + (EXISTING[s] || s + '.html'));
for (const p of PAGES) {
  const r0 = resolveUrl(p, '/'); if (r0.r.kind !== 'file') continue;
  const html = fs.readFileSync(r0.r.file, 'utf8');
  if (!/nav-dropdown-toggle/.test(html)) continue; // simple legal/status pages carry only Industries + Contact + Home
  const dm = /<div class="nav-dropdown-menu"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  if (!dm) { fail(p, 'Any Business, One App', 'dropdown present', 'missing', 'add dropdown'); continue; }
  const links = [...dm[0].matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/#.*/, ''));
  const miss = needPages.filter((h) => !links.includes(h));
  const hub = links.includes('/industries/');
  if (miss.length || !hub) fail(p, 'Any Business, One App dropdown', `links all ${DEMO_SLUGS.length} industries + hub`, `${miss.length} missing${hub ? '' : ', no hub link'}`, 'regenerate nav (node scripts/industries-site/build.mjs)');
  else ok(p, 'Any Business, One App dropdown', `all ${DEMO_SLUGS.length} industries + hub`, `${links.length} links`);
  if (/class="tag soon|aria-disabled|\sdisabled[\s>]|pointer-events:\s*none/.test(dm[0])) fail(p, 'dropdown item', 'no disabled/soon items', 'disabled or soon marker', 'remove');
}
{
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (/id="tryit-data"|id="docs-row"|id="ind-label"|<section id="demo"/.test(home)) fail('/', 'inline Try it sample', 'removed from homepage', 'still present', 'remove the section and its data');
  else ok('/', 'inline Try it sample', 'removed', 'absent');
  const hrefs = [...home.matchAll(/href="(#demo)"/g)];
  if (hrefs.length) fail('/', '#demo links', 'none', `${hrefs.length} link(s) to removed #demo`, 'point at /demo/');
  // a primary Try the demo CTA high on the page (inside <header class="hero"> / first 40% of body)
  const body = home.slice(home.indexOf('<main'));
  const i = body.search(/<a[^>]*href="\/demo\/"[^>]*>\s*Try the demo/i);
  i > -1 && i < body.length * 0.4 ? ok('/', 'primary Try the demo', 'high on page', '/demo/') : fail('/', 'primary Try the demo', 'a "Try the demo" button to /demo/ in the hero', 'missing', 'add to hero');
}

// ---------- browser part ----------
async function browserPart() {
  let chromium;
  try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { console.log('site-clicks: Playwright not installed, browser part skipped (static part ran).'); return; }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let r = route(u.pathname);
    if (r.kind === 'redirect') { res.writeHead(r.status, { location: r.to }); return res.end(); }
    if (r.kind === 'api') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (r.kind === 'file') { res.writeHead(200, { 'content-type': MIME[path.extname(r.file)] || 'application/octet-stream' }); return fs.createReadStream(r.file).pipe(res); }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('Not found');
  });
  await new Promise((o) => srv.listen(0, '127.0.0.1', o));
  const base = 'http://127.0.0.1:' + srv.address().port;
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log('site-clicks: chromium unavailable, browser part skipped: ' + String(e.message).split('\n')[0]); srv.close(); return; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const demoBuilt = !!lookupFile('/demo/index.html') && (DIST ? true : false);
  for (const vp of [{ w: 1440, h: 900, tag: '1440' }, { w: 390, h: 844, tag: '390', touch: true }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: !!vp.touch, isMobile: !!vp.touch });
    const errs = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); });
    const openMenuIfPhone = async () => { if (vp.touch) { const t = page.locator('#navMenuToggle'); if (await t.count() && (await t.getAttribute('aria-expanded')) !== 'true') await t.tap().catch(() => t.click()); } };
    const pn = (p) => `${p} @${vp.tag}`;
    for (const p of PAGES) {
      errs.length = 0;
      const resp = await page.goto(base + p, { waitUntil: 'load' }).catch((e) => ({ status: () => 'ERR ' + e.message }));
      if (!resp || resp.status() !== 200) { fail(pn(p), '(page)', '200', String(resp && resp.status()), 'fix'); continue; }
      await page.waitForTimeout(150);
      const errsLoad = errs.filter((e) => !/\/api\/|clerk|Content Security|Refused to/i.test(e));
      errsLoad.length ? fail(pn(p), '(console)', 'no errors', errsLoad[0].slice(0, 120), 'fix script error') : ok(pn(p), '(console)', 'no errors', 'clean');
      // disabled / pointer-events:none / covered controls in the nav and hero
      const bad = await page.evaluate(() => {
        const out = [];
        const sel = 'nav a, nav button, header a.btn, header button, .hero a.btn, main a.btn';
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return;
          const t = (el.textContent || '').trim().slice(0, 40);
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push([t, 'disabled']);
          if (cs.pointerEvents === 'none') out.push([t, 'pointer-events:none']);
          if (r.bottom < 0 || r.top > innerHeight * 3) return;
          const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = r.top + r.height / 2;
          if (cy < 0 || cy > innerHeight) return;
          const top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) out.push([t, 'covered by <' + top.tagName.toLowerCase() + ' class="' + (top.className || '').toString().slice(0, 30) + '">']);
        });
        return out;
      });
      for (const [t, why] of bad) fail(pn(p), t, 'enabled and not covered', why, 'fix css/z-index');
    }
    // every button / summary / [role=button] outside the dropdown: click it and see that something happens (WARN rows, listed in the audit; hard failures are disabled / covered / throwing handlers)
    for (const p of PAGES) {
      await page.goto(base + p, { waitUntil: 'load' }); await page.waitForTimeout(120);
      const n = await page.locator('button, summary, [role="button"]').count();
      for (let i = 0; i < n; i++) {
        let cur = page.locator('button, summary, [role="button"]').nth(i);
        const info = await cur.evaluate((e) => ({ t: ((e.textContent || e.getAttribute('aria-label') || e.id || e.tagName) + '').trim().replace(/\s+/g, ' ').slice(0, 40), skip: !!e.closest('.nav-dropdown-menu') || (e.type === 'submit' && !!e.closest('form')) || e.id === 'navMenuToggle' || e.classList.contains('nav-dropdown-toggle'), dis: e.disabled || e.getAttribute('aria-disabled') === 'true', vis: !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== 'hidden' })).catch(() => null);
        if (!info || info.skip || !info.vis) continue;
        if (info.dis) { fail(pn(p), 'button: ' + info.t, 'enabled', 'disabled', 'enable or remove'); continue; }
        const before = await page.evaluate(() => { window.__mut = 0; window.__mo && window.__mo.disconnect(); window.__mo = new MutationObserver((l) => { window.__mut += l.length; }); window.__mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); return { u: location.href, y: Math.round(scrollY) }; });
        const urlBefore = page.url();
        try { await cur.scrollIntoViewIfNeeded({ timeout: 2000 }); vp.touch ? await cur.tap({ timeout: 3000 }) : await cur.click({ timeout: 3000 }); }
        catch (e) { fail(pn(p), 'button: ' + info.t, 'clickable', String(e.message).split('\n')[0].slice(0, 110), 'fix overlay / visibility'); continue; }
        await page.waitForTimeout(250);
        if (page.url() !== urlBefore) { ok(pn(p), 'button: ' + info.t, 'does something', 'navigated ' + new URL(page.url()).pathname); await page.goto(base + p, { waitUntil: 'load' }); continue; }
        const after = await page.evaluate(() => ({ m: window.__mut || 0, y: Math.round(scrollY) })).catch(() => ({ m: 1, y: 0 }));
        after.m > 0 || after.y !== before.y ? ok(pn(p), 'button: ' + info.t, 'does something', `dom changes ${after.m}, scroll ${before.y}->${after.y}`) : rows.push({ page: pn(p), el: 'button: ' + info.t, expected: 'does something', actual: 'no visible effect (check handler)', status: 'WARN', fix: 'review' });
      }
    }
    // dropdown behaviour on a few representative pages (home, hub, a generated industry page, who)
    for (const p of ['/', '/industries/', '/industries/hotel.html', '/who.html']) {
      await page.goto(base + p, { waitUntil: 'load' }); await page.waitForTimeout(100);
      await openMenuIfPhone();
      const toggle = page.locator('.nav-dropdown-toggle').first();
      if (!(await toggle.count())) { fail(pn(p), 'dropdown toggle', 'present', 'missing', 'add'); continue; }
      vp.touch ? await toggle.tap() : await toggle.click();
      await page.waitForTimeout(250);
      const st = await page.evaluate(() => {
        const dd = document.querySelector('.nav-dropdown'); const menu = dd.querySelector('.nav-dropdown-menu');
        const items = [...menu.querySelectorAll('a')]; const mr = menu.getBoundingClientRect();
        const vis = items.filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
        const cs = getComputedStyle(menu);
        return { open: dd.classList.contains('open'), expanded: dd.querySelector('.nav-dropdown-toggle').getAttribute('aria-expanded'), n: items.length, vis, vismenu: cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.9, scrolls: menu.scrollHeight > menu.clientHeight, w: Math.round(mr.width), inView: mr.left >= -1 && mr.right <= innerWidth + 1 };
      });
      st.open && st.expanded === 'true' && st.vismenu && st.n >= DEMO_SLUGS.length + 1 && st.inView ? ok(pn(p), 'dropdown opens on click/tap', 'open, all items', `${st.n} items, scrollable=${st.scrolls}`) : fail(pn(p), 'dropdown opens on click/tap', 'open with all items visible', JSON.stringify(st), 'fix dropdown');
      if (SHOTS && (p === '/' || p === '/industries/hotel.html')) await page.screenshot({ path: path.join(SHOTS, `nav_dropdown_open${p === '/' ? '' : '_industry_page'}_${vp.tag}.png`) });
      // last item reachable by scrolling and clickable (not covered)
      const last = page.locator('.nav-dropdown-menu a').last(); await last.scrollIntoViewIfNeeded().catch(() => {});
      const lastOk = await last.evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === el || el.contains(t)); });
      lastOk ? ok(pn(p), 'last dropdown item reachable', 'clickable', 'yes') : fail(pn(p), 'last dropdown item reachable', 'clickable', 'covered / off-screen', 'fix menu height/scroll');
      // Escape closes + returns focus
      await page.keyboard.press('Escape'); await page.waitForTimeout(100);
      let closed = await page.evaluate(() => !document.querySelector('.nav-dropdown').classList.contains('open'));
      if (!closed) { fail(pn(p), 'dropdown Escape', 'closes', 'still open', 'fix key handler'); }
      // reopen with keyboard, arrow nav, then outside click closes
      await openMenuIfPhone(); await toggle.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
      const focusedFirst = await page.evaluate(() => document.activeElement && document.activeElement.closest('.nav-dropdown-menu') !== null);
      focusedFirst ? ok(pn(p), 'dropdown keyboard open', 'focus moves into menu', 'yes') : fail(pn(p), 'dropdown keyboard open', 'focus moves into menu', 'no', 'fix key handler');
      await page.keyboard.press('ArrowDown');
      await page.mouse.click(vp.w - 5, vp.h - 5); await page.waitForTimeout(150);
      closed = await page.evaluate(() => !document.querySelector('.nav-dropdown').classList.contains('open'));
      closed ? ok(pn(p), 'dropdown outside click', 'closes', 'yes') : fail(pn(p), 'dropdown outside click', 'closes', 'still open', 'fix outside click');
    }
    // click every dropdown link on the home page: lands on 200 page
    await page.goto(base + '/', { waitUntil: 'load' });
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('.nav-dropdown-menu a')].map((a) => a.getAttribute('href')));
    for (const h of hrefs) {
      await page.goto(base + '/', { waitUntil: 'load' }); await openMenuIfPhone();
      const t = page.locator('.nav-dropdown-toggle').first(); vp.touch ? await t.tap() : await t.click();
      const a = page.locator(`.nav-dropdown-menu a[href="${h}"]`).first(); await a.scrollIntoViewIfNeeded();
      const [nav] = await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null), vp.touch ? a.tap() : a.click()]);
      const st = nav ? nav.status() : (h.startsWith('#') ? 'hash' : 'no navigation');
      (st === 200 || st === 'hash') ? ok(pn('/'), 'dropdown -> ' + h, '200', String(st)) : fail(pn('/'), 'dropdown -> ' + h, '200', String(st), 'fix link');
    }
    // real clicks on every Try button on key pages
    for (const p of ['/', '/industries/', '/industries/hotel.html', '/industries/hvac.html', '/industries/any-business.html', '/who.html']) {
      await page.goto(base + p, { waitUntil: 'load' });
      const tries = await page.evaluate(() => [...document.querySelectorAll('a,button')].filter((e) => /^\s*try\b/i.test(e.textContent || '')).map((e, i) => ({ t: (e.textContent || '').trim().slice(0, 50), h: e.getAttribute('href') })));
      for (let i = 0; i < tries.length; i++) {
        await page.goto(base + p, { waitUntil: 'load' });
        const el = page.locator('a,button').filter({ hasText: /^\s*try\b/i }).nth(i);
        if (await el.evaluate((e) => !!e.closest('nav'))) await openMenuIfPhone(); // nav links live behind the Menu button on phones
        if (!(await el.isVisible())) { /* hidden at this width by design (industry pages hide nav links on phones) */ continue; }
        await el.scrollIntoViewIfNeeded();
        const [nav] = await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null), vp.touch ? el.tap() : el.click()]);
        const url = new URL(page.url());
        const good = nav && nav.status() === 200 && url.pathname === '/demo/' ;
        let body = ''; if (good && DIST) { await page.waitForTimeout(600); body = await page.evaluate(() => document.body.innerText.slice(0, 400)); }
        const loaded = !DIST || (good && !/not available/i.test(body) && body.length > 20);
        good && loaded ? ok(pn(p), 'Try: ' + tries[i].t, '/demo/ loads', url.pathname + url.search) : fail(pn(p), 'Try: ' + tries[i].t, '/demo/ loads', `${url.pathname} status ${nav && nav.status()} ${body.slice(0, 60)}`, 'point at /demo/');
        if (SHOTS && i === 0 && (p === '/' || p === '/industries/') && good) { /* shot of destination */ await page.screenshot({ path: path.join(SHOTS, `try_destination${p === '/' ? '_home' : '_hub'}_${vp.tag}.png`) }); }
      }
    }
    if (SHOTS) {
      await page.goto(base + '/', { waitUntil: 'load' }); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, `home_hero_${vp.tag}.png`) });
      await page.locator('#industries').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, `home_find_industry_${vp.tag}.png`) });
    }
    await ctx.close();
  }
  await browser.close(); srv.close();
}
if (!NO_BROWSER) await browserPart();

if (AUDIT_OUT) fs.writeFileSync(AUDIT_OUT, JSON.stringify({ rows, failures }, null, 1));
const passN = rows.filter((r) => r.status === 'ok').length;
if (failures.length) {
  console.log(`site-clicks: ${failures.length} FAIL, ${passN} ok`);
  for (const f of failures.slice(0, 60)) console.log(`  FAIL [${f.page}] ${f.el} -> expected ${f.expected}; got ${f.actual}`);
  if (failures.length > 60) console.log(`  ... ${failures.length - 60} more (use --audit out.json)`);
  process.exit(1);
}
console.log(`site-clicks: OK (${passN} checks, ${PAGES.length} pages, demo slugs ${DEMO_SLUGS.length})`);
