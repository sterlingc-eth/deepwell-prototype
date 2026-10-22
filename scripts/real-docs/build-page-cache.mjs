// Builds test-docs/real-docs/pages.json from the ORIGINAL test files, using the app's own readers
// (api/_lib/modelAvoidance/pdfText.js for PDFs, api/_lib/office for docx/xlsx/csv). Files the app sends to the
// vision model (photos, scanned PDFs) are recorded as {route:'vision'} with no text: the gate cannot run the paid model.
// Usage: node scripts/real-docs/build-page-cache.mjs <dir-with-originals>   (synthetic test data; never Donovan training)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readPdfTextLayer } from '../../api/_lib/modelAvoidance/pdfText.js';
import { readOfficeFile } from '../../api/_lib/office/index.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: build-page-cache.mjs <dir>'); process.exit(2); }
const out = { source: path.basename(path.resolve(dir)), built: new Date().toISOString().slice(0, 10), docs: [] };
for (const name of fs.readdirSync(dir).sort()) {
  const p = path.join(dir, name);
  if (!fs.statSync(p).isFile()) continue;
  const bytes = fs.readFileSync(p);
  const ext = name.split('.').pop().toLowerCase();
  const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  let rec = { filename: name, sha, route: 'vision', reason: 'image', pages: [] };
  if (ext === 'pdf') {
    const r = readPdfTextLayer(bytes);
    rec = r.ok ? { filename: name, sha, route: 'text-layer', pages: r.pages } : { filename: name, sha, route: 'vision', reason: r.reason, pages: [] };
  } else if (['docx', 'xlsx', 'csv', 'tsv'].includes(ext)) {
    const r = readOfficeFile(bytes, { filename: name });
    rec = r.ok ? { filename: name, sha, route: 'office', pages: r.pages.map((x, i) => ({ page_no: x.page_no ?? i + 1, text: x.text ?? '' })) } : { filename: name, sha, route: 'refused', reason: r.reason, pages: [] };
  }
  // Stand-in for the paid vision transcription (production sends these to the model): poppler's pdftotext for PDFs the
  // text-layer reader refused, tesseract for photos. Marked route 'vision-standin' so reports keep them apart.
  if (rec.route === 'vision' && process.argv.includes('--standin')) {
    try {
      const txt = ext === 'pdf'
        ? execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
        : execFileSync('tesseract', [p, 'stdout', '--psm', '4'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
      const pages = txt.split('\f').map((t, i) => ({ page_no: i + 1, text: t.replace(/[ \t]+$/gm, '').trimEnd() })).filter((x, i, a) => x.text.trim() || i === 0);
      rec = { ...rec, route: 'vision-standin', standin: ext === 'pdf' ? 'pdftotext' : 'tesseract', pages };
    } catch (e) { rec.standinError = String(e?.message ?? e).slice(0, 80); }
  }
  out.docs.push(rec);
}
fs.writeFileSync(new URL('../../test-docs/real-docs/pages.json', import.meta.url), JSON.stringify(out));
out.note = 'route vision-standin = text from pdftotext/tesseract standing in for the paid vision transcription.';
fs.writeFileSync(new URL('../../test-docs/real-docs/pages.json', import.meta.url), JSON.stringify(out));
const by = {}; for (const d of out.docs) by[d.route] = (by[d.route] ?? 0) + 1;
console.log(out.docs.length, 'docs', by);
