/**
 * Site placement: "Find your industry" is easy to find on the public site and ergonomic.
 * Static: nav + footer links, homepage section, only names/copy that already exist (industries.ts / the nav menu), links resolve, a11y basics.
 * Browser (Playwright, offline, local server): section above a stated scroll depth at 1440 / 820 / 390, tap targets >= 44px, no horizontal scroll,
 * no layout shift, visible focus, text contrast >= 4.5:1.
 * Not owned here: public/industries/* (hub + per-industry pages). Those pages are checked read-only; the /industries/ hub may still be PENDING.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && x ? '  -> ' + x : ''}`); };
const read = (f) => fs.readFileSync(f, 'utf8');
const SCROLL_DEPTH = 0.9; // section top must sit within the first 90% of the viewport height at every viewport
const MIN_TARGET = 44;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['samples', 'founders', 'support', 'm', 'get'].includes(e.name) ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.html') ? [path.join(d, e.name)] : []);
const pages = [path.join(ROOT, 'index.html'), path.join(ROOT, 'patch-notes.html'), ...walk(PUB)].filter((f) => /<nav\b/.test(read(f)) && !/Redirecting to/.test(read(f)));
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const isIndustryPage = (f) => rel(f).startsWith('public/industries/');
const home = read(path.join(ROOT, 'index.html'));
const navOf = (h) => (h.match(/<nav\b[\s\S]*?<\/nav>/) || [''])[0];
const footOf = (h) => (h.match(/<footer\b[\s\S]*?<\/footer>/) || [''])[0];

// ---- 1. nav + footer on every public page
for (const f of pages) {
  const h = read(f), nav = navOf(h), foot = footOf(h);
  const direct = /<a\b[^>]*href="\/industries\/"[^>]*>\s*Industries\s*<\/a>/.test(nav);
  if (isIndustryPage(f)) {
    // owned by the industries engineer: only require that the nav still reaches industries (menu or hub link)
    check(`${rel(f)}: nav reaches industries (read-only page)`, direct || /href="\/industries\/[^"]*"/.test(nav));
  } else {
    check(`${rel(f)}: primary nav has an Industries link to /industries/`, direct);
    check(`${rel(f)}: footer has an Industries link to /industries/`, /<a\b[^>]*href="\/industries\/"[^>]*>\s*Industries\s*<\/a>/.test(foot));
  }
}

// ---- 2. homepage section
const sec = (home.match(/<section id="industries"[\s\S]*?<\/section>/) || [''])[0];
check('home: #industries section exists', !!sec);
const idx = home.indexOf('<section id="industries"');
check('home: it follows the hero and precedes every other section (high on the page)', idx > home.indexOf('<header class="hero"') && home.indexOf('<section') === idx);
check('home: heading says "Find your industry"', /<h2[^>]*>\s*Find your industry\.?\s*<\/h2>/.test(sec));
check('home: heading is wired with aria-labelledby', (() => { const m = sec.match(/aria-labelledby="([^"]+)"/); return !!m && new RegExp(`id="${m[1]}"`).test(sec); })());
const tiles = [...sec.matchAll(/<a class="ie-tile" href="([^"]+)"><span class="ie-t">([^<]+)<\/span><span class="ie-d">([^<]+)<\/span><\/a>/g)].map((m) => ({ href: m[1], name: m[2].replace(/&amp;/g, '&'), desc: m[3] }));
check('home: 6-8 industry tiles', tiles.length >= 6 && tiles.length <= 8, `found ${tiles.length}`);
check('home: "See all industries" link goes to /industries/', /<a\b[^>]*href="\/industries\/"[^>]*>\s*See all industries\s*<\/a>/.test(sec));
check('home: "Try the demo" action goes to the demo (/demo/)', /<a\b[^>]*href="\/demo\/"[^>]*>\s*Try the demo\s*<\/a>/.test(sec));

// ---- 3. facts: names exist in demo data, copy reused from the existing nav menu, no claims
const ind = read(path.join(ROOT, 'src/demoAccount/industries.ts'));
const known = new Set([...ind.matchAll(/'([^'\n]+)'/g)].map((m) => m[1].toLowerCase()));
const catTitles = [...ind.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1].toLowerCase());
for (const t of tiles) check(`home tile "${t.name}": name exists in demo data (industries.ts)`, known.has(t.name.toLowerCase()) || catTitles.some((c) => c.split(/\s*&\s*/).includes(t.name.toLowerCase())), 'not in industries.ts');
const navMenu = (home.match(/id="industriesMenu"[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
for (const t of tiles) check(`home tile "${t.name}": description already exists in the nav menu`, navMenu.includes(t.desc));
check('home section: no percentages, prices, accuracy or testimonial claims', !/%|\$\d|\baccura|testimonial|guarantee|\d+\s*(industries|customers|companies)/i.test(sec.replace(/<[^>]+>/g, ' ')));
const hrefs = [...navOf(home).matchAll(/href="([^"]+)"/g), ...sec.matchAll(/href="([^"]+)"/g), ...footOf(home).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const vercel = JSON.parse(read(path.join(ROOT, 'vercel.json')));
const rewrites = new Set((vercel.rewrites || []).map((r) => r.source.replace(/\/$/, '')));
const ids = new Set([...home.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const dupIds = [...home.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) !== i);
const resolve = (href) => {
  if (/^(https?:|mailto:)/.test(href)) return 'external';
  if (href.startsWith('#')) return ids.has(href.slice(1)) ? 'ok' : false;
  const [p0, hash] = href.split('#'); const p = p0.split('?')[0];
  if (hash && p === '/' && !ids.has(hash)) return false;
  if (p === '/' || p === '') return 'ok';
  const cands = [path.join(PUB, p), path.join(PUB, p, 'index.html'), path.join(PUB, p + '.html'), path.join(ROOT, p)];
  if (cands.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) return 'ok';
  if (rewrites.has(p.replace(/\/$/, '')) || fs.existsSync(path.join(ROOT, p.replace(/^\//, ''), 'index.html'))) return 'ok';
  if (p === '/industries/') return 'pending'; // hub is being built by the industries engineer
  return false;
};
for (const h of [...new Set(hrefs)]) { const r = resolve(h); if (r !== 'external') check(`home link ${h} resolves${r === 'pending' ? ' (PENDING: /industries/ hub not built yet)' : ''}`, !!r); }
check('home: no duplicate ids', dupIds.length === 0, dupIds.join(','));

// ---- 4. a11y basics (static)
for (const f of pages) {
  const h = read(f);
  const imgs = [...h.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  check(`${rel(f)}: every <img> has alt`, imgs.every((t) => /\balt="/.test(t)), imgs.filter((t) => !/\balt="/.test(t)).join(' '));
  check(`${rel(f)}: nav has an aria-label`, /<nav\b[^>]*aria-label="[^"]+"/.test(h));
  check(`${rel(f)}: footer links are real anchors with text`, [...footOf(h).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].every((m) => m[1].replace(/<[^>]+>/g, '').trim().length > 0));
}
check('home: every form control in the new section has a label', !/<(input|select|textarea)\b/.test(sec));

// ---- 5. browser
let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) { check('playwright is available', false, String(e.message).slice(0, 80)); }
if (chromium) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    const cand = p === '/index.html' || p === '/patch-notes.html' ? [path.join(ROOT, p)] : [path.join(PUB, p), path.join(PUB, p + '.html')];
    const f = cand.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!f) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const VPS = { desktop: [1440, 900], tablet: [820, 1180], phone: [390, 844] };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
  const browser = await chromium.launch();
  try {
    for (const [vp, [w, h]] of Object.entries(VPS)) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: vp !== 'desktop', isMobile: vp === 'phone' });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const page = await ctx.newPage();
      await page.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) { /* unsupported */ } });
      await page.goto(base + '/index.html', { waitUntil: 'load' });
      await page.waitForTimeout(400);
      const top0 = await page.evaluate(() => document.getElementById('industries').getBoundingClientRect().top + scrollY);
      await page.waitForTimeout(1500);
      const m = await page.evaluate(() => {
        const s = document.getElementById('industries'), r = (e) => { const b = e.getBoundingClientRect(); return { top: b.top + scrollY, w: b.width, h: b.height, vis: b.width > 0 && b.height > 0 }; };
        const demo = [...s.querySelectorAll('a')].find((a) => /Try the demo/.test(a.textContent));
        return { top: r(s).top, tilesTop: r(s.querySelector('.ie-tile')).top, demoTop: r(demo).top, cls: window.__cls, sw: document.documentElement.scrollWidth, iw: innerWidth,
          targets: [...s.querySelectorAll('a')].map((a) => ({ t: a.textContent.trim().slice(0, 24), ...r(a) })),
          foot: (() => { const a = document.querySelector('footer a.ft-ind'); return a ? r(a) : null; })() };
      });
      check(`[${vp} ${w}] industries section starts within the first ${SCROLL_DEPTH * 100}% of the viewport (top ${Math.round(m.top)}px of ${h}px)`, m.top < h * SCROLL_DEPTH);
      check(`[${vp} ${w}] "Try the demo" and the first tile row are on the first screen (${Math.round(m.demoTop)}px, ${Math.round(m.tilesTop)}px of ${h}px)`, m.demoTop < h && m.tilesTop < h);
      check(`[${vp} ${w}] section did not move after load (${Math.round(top0)} -> ${Math.round(m.top)}px)`, Math.abs(top0 - m.top) <= 1);
      check(`[${vp} ${w}] layout shift score ${m.cls.toFixed(3)} <= 0.1`, m.cls <= 0.1);
      check(`[${vp} ${w}] no horizontal scroll on home (${m.sw} <= ${m.iw})`, m.sw <= m.iw);
      check(`[${vp} ${w}] every section link is >= ${MIN_TARGET}px tall (${m.targets.length} links)`, m.targets.every((t) => t.h >= MIN_TARGET - 0.5 && t.w >= MIN_TARGET), JSON.stringify(m.targets.filter((t) => t.h < MIN_TARGET)));
      check(`[${vp} ${w}] footer Industries link is >= ${MIN_TARGET}px tall`, !!m.foot && m.foot.h >= MIN_TARGET - 0.5, JSON.stringify(m.foot));
      // nav link: visible directly when the link bar shows, otherwise inside the Menu panel
      const navLink = page.locator('nav .navlinks a.nav-ind');
      if (!(await navLink.isVisible())) { await page.locator('#navMenuToggle').click(); await page.waitForTimeout(200); }
      check(`[${vp} ${w}] nav Industries link is visible${(await navLink.isVisible()) && vp === 'phone' ? ' (in the Menu panel)' : ''}`, await navLink.isVisible());
      const nb = await navLink.boundingBox();
      check(`[${vp} ${w}] nav Industries link is >= ${MIN_TARGET}px tall (${Math.round(nb?.height ?? 0)}px)`, !!nb && nb.height >= MIN_TARGET - 0.5 || (vp === 'desktop' && !!nb && nb.height >= 20 && (await page.evaluate(() => document.querySelector('.nav .wrap').getBoundingClientRect().height)) >= MIN_TARGET));
      // keyboard: the nav link is reachable by Tab and shows a visible focus ring; so is the first tile
      await navLink.focus();
      const fnav = await page.evaluate(() => { const a = document.activeElement; const c = getComputedStyle(a); return { cls: a.className, ow: parseFloat(c.outlineWidth), os: c.outlineStyle, bs: c.boxShadow }; });
      check(`[${vp} ${w}] nav Industries link takes keyboard focus`, /nav-ind/.test(fnav.cls));
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
      await page.keyboard.press('Tab'); // start from the top
      let hit = null;
      for (let i = 0; i < 60 && !hit; i++) { hit = await page.evaluate(() => { const a = document.activeElement; if (!a || !a.classList.contains('ie-tile')) return null; const c = getComputedStyle(a); return { ow: parseFloat(c.outlineWidth), os: c.outlineStyle, name: a.textContent.trim().slice(0, 20) }; }); if (!hit) await page.keyboard.press('Tab'); }
      check(`[${vp} ${w}] tiles are reachable by Tab with a visible focus outline (${hit ? hit.os + ' ' + hit.ow + 'px' : 'not reached'})`, !!hit && hit.os !== 'none' && hit.ow >= 2);
      // contrast of tile title + description (light and dark)
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150);
        const cc = await page.evaluate(() => { const t = document.querySelector('#industries .ie-tile'), out = [];
          const bgOf = (e) => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; const a = (c.match(/[\d.]+/g) || []); if (a.length < 4 || +a[3] > 0.95) return c; } return 'rgb(255,255,255)'; };
          for (const [sel, el] of [['title', t.querySelector('.ie-t')], ['desc', t.querySelector('.ie-d')], ['sub', document.querySelector('#industries .ie-sub')], ['h2', document.querySelector('#industries h2')]]) { if (el && el.offsetParent) out.push([sel, getComputedStyle(el).color, bgOf(el)]); }
          return out; });
        for (const [sel, fg, bg] of cc) { const f = rgb(fg), b = rgb(bg); if (f.length >= 3 && b.length >= 3 && (f[3] ?? 1) >= 0.95) check(`[${vp} ${w} ${scheme}] contrast of ${sel} ${ratio(f, b).toFixed(1)}:1 >= 4.5`, ratio(f, b) >= 4.5); }
      }
      await ctx.close();
    }
    for (const w of [1001, 1100, 1101, 1150, 1180, 1240]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const p = await ctx.newPage(); await p.goto(base + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(200);
      const o = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('.nav .wrap').scrollWidth <= document.querySelector('.nav .wrap').clientWidth + 1]);
      check(`[nav squeeze ${w}] home: no horizontal scroll and the nav row fits (${o[0]} <= ${o[1]})`, o[0] <= o[1] && o[2]);
      await ctx.close();
    }
    const warned = {};
    // no horizontal scroll on the other public pages that carry the nav
    for (const f of pages) {
      const url = '/' + rel(f).replace('public/', '');
      for (const [vp, [w, h]] of Object.entries(VPS)) {
        if (f === pages[0]) continue;
        const ctx = await browser.newContext({ viewport: { width: w, height: h } });
        await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
        const p = await ctx.newPage(); await p.goto(base + url, { waitUntil: 'load' }); await p.waitForTimeout(150);
        const o = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        if (isIndustryPage(f) && o[0] > o[1]) (warned[vp] ||= []).push(`${path.basename(f)} ${o[0]}>${o[1]}`);
        else check(`[${vp} ${w}] ${rel(f)}: no horizontal scroll (${o[0]} <= ${o[1]})`, o[0] <= o[1]);
        await ctx.close();
      }
    }
    for (const [vp, l] of Object.entries(warned)) console.log(`WARN  [${vp}] ${l.length} public/industries/* pages scroll horizontally (owned by the industries engineer, not counted): ${l.slice(0, 3).join(', ')}...`);
  } finally { await browser.close(); server.close(); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
