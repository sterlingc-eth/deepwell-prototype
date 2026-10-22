// Dev probe: run the deterministic extractor over text files (one page per "\f").  node probe-extract.mjs <pack> <file...>
import fs from 'node:fs';
import { extractFromText } from '../../api/_lib/modelAvoidance/textExtract.js';
import { getPack } from '../../api/_lib/industry/index.js';
const [packId, ...files] = process.argv.slice(2);
const pack = getPack(packId);
const own = (process.env.OWN || '').split('|').filter(Boolean);
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const pages = txt.split('\f').map((t, i) => ({ page_no: i + 1, text: t }));
  const r = extractFromText(pages, { pack, ownNames: own, generic: true });
  console.log(`== ${f.split('/').pop()}: ${r.accepted ? 'ACCEPT ' + r.type : 'REFUSE ' + r.reason + ' / ' + r.genericReason + ' (' + r.type + ')'}`);
  if (r.accepted) for (const x of r.toolInput.fields) console.log(`   ${x.key} = ${x.value} (p${x.page_no})`);
}
