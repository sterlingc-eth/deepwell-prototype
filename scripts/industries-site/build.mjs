// Usage: node scripts/industries-site/build.mjs [--refresh]
//   --refresh  re-extract data.json from src/demo/fixtures, then rebuild pages
import fs from 'node:fs';
import path from 'node:path';
import { artFiles } from './art.mjs';
import { ROOT, DATA_FILE, extractData, loadData, renderAll, renderHandwritten, sitemapUrls, syncNav } from './lib.mjs';

if (process.argv.includes('--refresh')) fs.writeFileSync(DATA_FILE, JSON.stringify(extractData(), null, 1) + '\n');
// nav dropdown first: the generated pages lift their nav from public/industries/offices.html
const navChanged = syncNav(loadData());
console.log(`industries-site: nav dropdown synced in ${navChanged.length} files`);
let n = 0;
for (const [rel, content] of renderAll(loadData())) {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), content);
  n++;
}
console.log(`industries-site: wrote ${n} pages`);
// shared art css/js (one cached file each) used by every themed page
for (const [rel, content] of artFiles()) fs.writeFileSync(path.join(ROOT, rel), content);
// hand-written pages: content untouched, themed stage inserted/refreshed after the hero block
for (const [rel, content] of renderHandwritten(loadData())) fs.writeFileSync(path.join(ROOT, rel), content);
console.log('industries-site: themed stage applied to the hand-written pages');

// sitemap: append any missing industries URL (idempotent)
const smPath = path.join(ROOT, 'public/sitemap.xml');
let sm = fs.readFileSync(smPath, 'utf8');
const have = new Set([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
const add = sitemapUrls(loadData()).filter((u) => !have.has(u));
if (add.length) {
  const xml = add.map((u) => `  <url>\n    <loc>${u}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>${u.endsWith('/industries/') ? '0.7' : '0.5'}</priority>\n  </url>\n`).join('');
  sm = sm.replace('</urlset>', xml + '</urlset>');
  fs.writeFileSync(smPath, sm);
}
console.log(`industries-site: sitemap +${add.length} urls`);
