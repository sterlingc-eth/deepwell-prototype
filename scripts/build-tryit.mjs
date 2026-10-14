// Copies src/data/tryIt.json into index.html (the page has no build step for its inline script, so the
// example content is embedded once, between the tryit-data markers). Keeps the file's line endings.
// Usage: node scripts/build-tryit.mjs [--check]   (--check fails if index.html is out of step)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/tryIt.json'), 'utf8'));
const body = JSON.stringify(data).replace(/</g, '\\u003c');
const html = fs.readFileSync(htmlPath, 'utf8');
const nl = html.includes('\r\n') ? '\r\n' : '\n';
const re = /(<!-- tryit-data:start -->\r?\n<script type="application\/json" id="tryit-data">)[\s\S]*?(<\/script>\r?\n<!-- tryit-data:end -->)/;
if (!re.test(html)) { console.error('index.html: tryit-data markers not found'); process.exit(1); }
const next = html.replace(re, (_m, a, b) => a + body + b);
if (process.argv.includes('--check')) {
  if (next !== html) { console.error('index.html is out of step with src/data/tryIt.json. Run: node scripts/build-tryit.mjs'); process.exit(1); }
  console.log('tryit data in index.html is up to date');
} else {
  if (next !== html) fs.writeFileSync(htmlPath, next);
  console.log(next === html ? 'already up to date' : 'index.html updated (' + nl.length + '-char line endings kept)');
}
