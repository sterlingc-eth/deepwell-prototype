// Tables lane: builds test-docs/real-docs/tables/pages-tables.json from the output of make-degraded-tables.py.
// Clean PDFs are read with the app's own text-layer reader (pdfText.js, with word-run lines for x anchoring); degraded images
// carry the tesseract stand-in text. usage: node scripts/real-docs/build-tables-pages.mjs <work dir from make-degraded-tables.py>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdfTextLayer } from '../../api/_lib/modelAvoidance/pdfText.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.resolve(process.argv[2]);
const raw = JSON.parse(fs.readFileSync(path.join(WORK, 'tables-raw.json'), 'utf8'));
const OUT = path.join(ROOT, 'test-docs/real-docs/tables');
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true }); fs.mkdirSync(path.join(OUT, 'clean'), { recursive: true });
const round = (n) => Math.round(n * 10) / 10;
const docs = [];
for (const d of raw.docs) {
  if (d.variant === 'clean-pdf') {
    const pdf = path.join(WORK, 'clean', d.filename);
    const r = readPdfTextLayer(fs.readFileSync(pdf), { keepLines: true });
    if (!r.ok) throw new Error('clean pdf not readable: ' + d.filename + ' ' + r.reason);
    fs.copyFileSync(pdf, path.join(OUT, 'clean', d.filename));
    d.route = 'text-layer';
    d.pages = r.pages.map((p) => ({ page_no: p.page_no, text: p.text, lines: p.lines.map((l) => ({ text: l.text, cw: round(l.cw), cells: l.cells.map((c) => ({ t: c.t, x: round(c.x), x2: round(c.x2) })) })) }));
  } else {
    for (const im of d.image ?? []) fs.copyFileSync(path.join(WORK, 'img', im), path.join(OUT, 'img', im));
  }
  docs.push(d);
}
fs.writeFileSync(path.join(OUT, 'pages-tables.json'), JSON.stringify({ about: raw.about + ' Built by scripts/real-docs/build-tables-pages.mjs.', built: new Date().toISOString().slice(0, 10), docs }));
console.log('wrote', docs.length, 'documents ->', path.relative(ROOT, OUT));
