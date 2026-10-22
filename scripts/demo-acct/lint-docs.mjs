// Which generated sample documents the deterministic reader accepts (= read with NO model, identical locally and in production).
//   node scripts/demo-acct/lint-docs.mjs <docs dir> [slug...]
import fs from 'node:fs';
import path from 'node:path';
import { readPdfTextLayer } from '../../api/_lib/modelAvoidance/pdfText.js';
import { extractFromText } from '../../api/_lib/modelAvoidance/textExtract.js';
import { getPack } from '../../api/_lib/industry/index.js';
const [dir, ...slugs] = process.argv.slice(2);
for (const slug of slugs.length ? slugs : fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'manifest.json')))) {
  const { meta, documents } = JSON.parse(fs.readFileSync(path.join(dir, slug, 'manifest.json'), 'utf8'));
  const { questions } = JSON.parse(fs.readFileSync(path.join(dir, slug, 'questions.json'), 'utf8'));
  const targets = new Set(questions.flatMap((q) => (q.file ? q.file.split('|') : [])));
  let ok = 0;
  const lines = [];
  for (const d of documents) {
    let verdict;
    if (d.kind !== 'pdf') verdict = `IMAGE (${d.kind}) -> vision reader`;
    else {
      const r = readPdfTextLayer(fs.readFileSync(path.join(dir, slug, 'files', d.file)));
      if (!r.ok) verdict = `TEXTLAYER ${r.reason}`;
      else {
        const x = extractFromText(r.pages.map((p, i) => ({ page_no: i + 1, text: p.text ?? p })), { pack: meta.pack ? getPack(meta.pack) : getPack(null), ownNames: [meta.company], generic: true });
        if (x.accepted) { ok++; verdict = `ok ${x.type}: ${x.toolInput.fields.filter((f) => !/^shop_/.test(f.key)).map((f) => `${f.key}=${f.value}`).join('; ').slice(0, 150)}`; }
        else verdict = `MODEL ${x.reason} / ${x.genericReason ?? ''} (${x.type})`;
      }
    }
    lines.push(`${targets.has(d.file) ? '*' : ' '} ${d.file.padEnd(52)} ${verdict}`);
  }
  console.log(`=== ${slug}: ${ok}/${documents.length} read without a model`);
  console.log(lines.join('\n'));
}
