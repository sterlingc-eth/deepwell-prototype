// verify:industries-site — the Industries hub and per-industry pages (public/industries/*).
// Checks: every demo industry has a page and a working demo deep link, the hub lists them all, no broken internal links,
// the sitemap is complete, no dollar figures outside the demo data, no placeholders, no accuracy percentages.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, extractData, loadData, renderAll, sitemapUrls, pageFile, demoLink, GROUPS, EXISTING_PAGES, EXTRA_GUIDES } from './industries-site/lib.mjs';
import { artChecks } from './verify-industry-art.mjs';

let fails = 0;
let checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.error('FAIL: ' + msg); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const fixIndex = JSON.parse(read('src/demo/fixtures/index.json')).industries;
const data = loadData();
const slugs = fixIndex.map((i) => i.slug);
ok(slugs.length > 0, `demo has industries (found ${slugs.length})`);

// 1. data file is exactly what the fixtures say (no invented facts) and pages are exactly what the template renders
ok(JSON.stringify(data) === JSON.stringify(extractData()), 'scripts/industries-site/data.json matches the demo fixtures (run build.mjs --refresh)');
ok(data.industries.map((d) => d.slug).join() === slugs.join(), 'data.json covers every demo industry, in order');
const rendered = renderAll(data);
for (const [rel, content] of rendered) ok(exists(rel) && read(rel) === content, `${rel} is up to date with the template (run build.mjs)`);

// 2. grouping: every slug in exactly one group, none unknown
const grouped = GROUPS.flatMap((g) => g.slugs);
ok(new Set(grouped).size === grouped.length, 'no industry is in two hub groups');
for (const s of slugs) ok(grouped.includes(s), `hub group exists for ${s}`);
for (const s of grouped) ok(slugs.includes(s), `hub group slug ${s} is a real demo industry`);

// 3. demo deep link target works
const demoApp = read('src/demo/DemoApp.tsx');
ok(/searchParams|URLSearchParams/.test(demoApp) && /get\('industry'\)/.test(demoApp), 'DemoApp reads ?industry=');
ok(exists('demo/index.html') || exists('public/demo/index.html'), 'demo entry page exists');
const vercel = JSON.parse(read('vercel.json'));
ok(vercel.rewrites.some((r) => r.source === '/demo' && /demo\/index\.html/.test(r.destination)), 'vercel rewrites /demo to the demo entry');
const hub = read('public/industries/index.html');
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
for (const s of slugs) {
  const rel = `public/industries/${pageFile(s)}`;
  ok(exists(rel), `page exists for ${s} (${rel})`);
  ok(exists(`src/demo/fixtures/${s}.demo.json`), `demo fixture exists for ${s}`);
  ok(hub.includes(`href="/industries/${pageFile(s)}"`), `hub links the ${s} page`);
  ok(hub.includes(`href="${demoLink(s)}"`), `hub links the ${s} demo`);
  if (!EXISTING_PAGES[s]) {
    const html = read(rel);
    ok(html.includes(`href="${demoLink(s)}"`) && /Try the [^<]+ demo<\/a>/.test(html), `${s} page has a Try the demo button with its own deep link`);
    ok(html.includes(`<link rel="canonical" href="${SITE}/industries/${s}.html">`), `${s} canonical`);
    ok(/<title>[^<]{5,70}<\/title>/.test(html), `${s} title`);
    const m = html.match(/<meta name="description" content="([^"]+)"/);
    ok(m && m[1].length >= 60 && m[1].length <= 165, `${s} meta description length`);
    ok((html.match(/<h1>/g) ?? []).length === 1, `${s} has one h1`);
  }
}
const cards = (hub.match(/class="hub-item"/g) ?? []).length;
ok(cards === slugs.length, `hub lists every demo industry (found ${cards})`);
ok(/<h1>Any Business, One App<\/h1>/.test(hub), 'hub H1 is exactly Any Business, One App');
ok(/<title>Any Business, One App — DeepWell Technology<\/title>/.test(hub) && /og:title" content="Any Business, One App — DeepWell Technology"/.test(hub), 'hub title + og:title');
ok(!/\b\d+ (kinds of business|industries)\b/i.test(hub.replace(/<script[\s\S]*?<\/script>/g, '')), 'hub copy has no industry count');
for (const rel of [...rendered.keys(), ...Object.values(EXISTING_PAGES).map((f) => 'public/industries/' + f), 'public/industries/any-business.html', 'public/industries/offices.html', 'public/industries/fleet-equipment-rental.html', 'public/industries/plumbing.html']) { if (rel.endsWith('/index.html')) continue; const t = read(rel); const m = t.match(/<h1>[\s\S]*?<\/h1>/); const before = t.slice(0, m ? m.index : 0); ok(/<a class="crumb" href="\/industries\/">Any Business, One App<\/a>/.test(before.slice(before.lastIndexOf('class="eyebrow"') - 20)), `${rel} has the Any Business, One App breadcrumb above its H1`); }
ok(/<link rel="canonical" href="https:\/\/deepwelltechnology\.com\/industries\/">/.test(hub) && /<title>[^<]+<\/title>/.test(hub) && /<meta name="description"/.test(hub), 'hub has title, description, canonical');
for (const e of EXTRA_GUIDES) { ok(hub.includes(`href="${e.href}"`), `hub links guide ${e.href}`); ok(exists('public' + e.href), `guide exists ${e.href}`); }

// 4. internal links resolve
const rewriteSrc = vercel.rewrites.map((r) => r.source).concat(vercel.redirects.map((r) => r.source));
const matchesRule = (p) => rewriteSrc.some((s) => new RegExp('^' + s.replace(/\(\.\*\)/g, '.*').replace(/:[a-z]+/g, '[^/]+') + '$').test(p));
const idsOf = (rel) => new Set([...read(rel).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
function resolve(p) {
  if (p === '/') return 'index.html';
  const cands = [`public${p}`, p.replace(/^\//, ''), `public${p}.html`, `public${p.replace(/\/$/, '')}/index.html`, `${p.replace(/^\//, '').replace(/\/$/, '')}/index.html`];
  return cands.find((c) => exists(c) && fs.statSync(path.join(ROOT, c)).isFile());
}
const pages = [...rendered.keys()];
for (const rel of pages) {
  const html = read(rel);
  const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  for (const h of hrefs) {
    if (/^(https?:|mailto:|tel:|data:|#)/.test(h) || h.startsWith('//')) continue;
    if (!h.startsWith('/')) { ok(false, `${rel}: relative link ${h}`); continue; }
    const [pathAndQuery, frag] = h.split('#');
    const p = pathAndQuery.split('?')[0];
    if (p.startsWith('/_vercel/')) continue;
    const file = resolve(p);
    ok(file || matchesRule(p) || p === '/app/' || p === '/app', `${rel}: broken link ${h}`);
    if (frag && file && file.endsWith('.html')) ok(idsOf(file).has(frag), `${rel}: anchor #${frag} missing in ${file}`);
  }
}

// 5. sitemap complete
const sm = read('public/sitemap.xml');
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok(new Set(locs).size === locs.length, 'sitemap has no duplicate URLs');
for (const u of sitemapUrls(data)) ok(locs.includes(u), `sitemap lists ${u}`);
for (const e of EXTRA_GUIDES) ok(locs.includes(SITE + e.href), `sitemap lists ${e.href}`);
for (const f of fs.readdirSync(path.join(ROOT, 'public/industries')).filter((x) => x.endsWith('.html'))) ok(locs.includes(f === "index.html" ? `${SITE}/industries/` : `${SITE}/industries/${f}`), `sitemap lists public/industries/${f}`);
for (const u of locs) { const p = u.replace(SITE, ''); ok(p === '/' || resolve(p), `sitemap URL resolves: ${u}`); }

// 6. dollars only from demo data; no placeholders; no accuracy claims
const numsIn = (s) => new Set([...s.matchAll(/\d[\d,]*\.?\d*/g)].map((m) => parseFloat(m[0].replace(/,/g, ''))).filter((n) => !Number.isNaN(n)));
const PLACE = /\b(TODO|TBD|FIXME|lorem|ipsum|placeholder|undefined|NaN|null)\b|\[object|\{\{|\}\}|\$\{|General Office/i;
for (const rel of rendered.keys()) {
  const html = read(rel);
  const t = text(html);
  const slug = path.basename(rel, '.html');
  const money = [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  if (slug === 'index') ok(money.length === 0, `${rel}: hub has no dollar figures`);
  else {
    const allowed = numsIn(read(`src/demo/fixtures/${slug}.demo.json`));
    for (const v of money) ok(allowed.has(v), `${rel}: $${v} is not in the ${slug} demo data`);
  }
  const vis = t.replace(/<[^>]+>/g, ' ');
  ok(!PLACE.test(vis), `${rel}: placeholder text (${(vis.match(PLACE) ?? [''])[0]})`);
  const fxText = slug === 'index' ? '' : read(`src/demo/fixtures/${slug}.demo.json`);
  for (const pc of vis.match(/\d+(?:\.\d+)?\s?%/g) ?? []) ok(fxText.includes(pc.replace(/\s/g, '')), `${rel}: percentage ${pc} is not in the demo data`);
  ok(!/\b(accura|precision|guarantee|testimonial)/i.test(t), `${rel}: unsupported claim wording`);
  ok(!/<img /i.test(html), `${rel}: no images (no logos)`);
}

// 6b. themed industry heroes: a scene + palette per industry, reduced-motion fallback, a11y markup, size budget, links intact (details in verify-industry-art.mjs)
artChecks(ok, read, exists);

// 7. api/ keeps exactly 12 top-level files
const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
ok(apiFiles === 12, `api/ has exactly 12 top-level files (found ${apiFiles})`);

console.log(`verify-industries-site: ${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
