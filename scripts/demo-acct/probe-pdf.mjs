// Dev probe: text layer of each PDF -> deterministic extractor verdict.  node probe-pdf.mjs <pack> <own name> <pdf...>
import fs from 'node:fs';
import { readPdfTextLayer } from '../../api/_lib/modelAvoidance/pdfText.js';
import { extractFromText } from '../../api/_lib/modelAvoidance/textExtract.js';
import { getPack } from '../../api/_lib/industry/index.js';
const [packId, own, ...files] = process.argv.slice(2);
const show = process.env.SHOW === '1';
for (const f of files) {
  const r = readPdfTextLayer(fs.readFileSync(f));
  if (!r.ok) { console.log(`== ${f.split('/').pop()}: TEXTLAYER ${r.reason}`); continue; }
  const pages = r.pages.map((p, i) => ({ page_no: i + 1, text: p.text ?? p }));
  const x = extractFromText(pages, { pack: getPack(packId), ownNames: [own], generic: true });
  console.log(`== ${f.split('/').pop()}: ${x.accepted ? 'ACCEPT ' + x.type + ' ' + x.toolInput.fields.map((y) => y.key + '=' + y.value).join('; ') : 'REFUSE ' + x.reason + ' / ' + x.genericReason + ' (' + x.type + ')'}`);
  if (show) console.log(pages.map((p) => p.text).join('\n----\n'));
}
