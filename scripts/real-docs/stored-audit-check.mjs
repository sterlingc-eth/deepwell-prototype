// Docread2: the stored-value audit (api/_lib/modelAvoidance/storedAudit.js) run over values an OLDER reader stored.
// node scripts/real-docs/stored-audit-check.mjs [--tree <older checkout>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPipeline, runDoc } from './pipeline.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const treeArg = args.indexOf('--tree') >= 0 ? path.resolve(args[args.indexOf('--tree') + 1]) : null;
const { auditStoredFacts } = await import(pathToFileURL(path.join(ROOT, 'api/_lib/modelAvoidance/storedAudit.js')).href);
const docs = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/real-docs/pages.json'), 'utf8')).docs;
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/real-docs/GOLD.json'), 'utf8'));
const P = await loadPipeline(treeArg ?? ROOT);
const byRule = {}; const flagged = []; let docsFlagged = 0;
for (const doc of docs) {
  const r = runDoc(P, doc);
  const fl = auditStoredFacts({ pages: doc.pages, fields: r.fields });
  if (fl.length) docsFlagged++;
  for (const f of fl) { byRule[f.rule] = (byRule[f.rule] ?? 0) + 1; flagged.push({ file: doc.filename, ...f }); }
}
// of the known-wrong values the older reader produced (GOLD.forbidden), how many does the audit flag when stored?
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
let forbiddenStored = 0, forbiddenFlagged = 0; const missedForbidden = [];
for (const fb of gold.forbidden ?? []) {
  const doc = docs.find((d) => d.filename === fb.filename); if (!doc) continue;
  const r = runDoc(P, doc);
  const stored = r.fields.find((f) => f.field_key === fb.key && norm(f.value) === norm(fb.value));
  if (!stored) continue;
  forbiddenStored++;
  const hit = auditStoredFacts({ pages: doc.pages, fields: r.fields }).some((x) => x.field_key === fb.key && norm(x.value) === norm(fb.value));
  if (hit) forbiddenFlagged++; else missedForbidden.push(`${fb.filename} ${fb.key}="${fb.value}"`);
}
const out = { tree: treeArg ?? '.', documents: docs.length, documentsFlagged: docsFlagged, flags: flagged.length, byRule, forbiddenStored, forbiddenFlagged, missedForbidden };
if (args.includes('--json')) console.log(JSON.stringify({ ...out, flagged }, null, 1));
else { console.log(JSON.stringify(out, null, 1)); for (const f of flagged.slice(0, 40)) console.log(`  ${f.rule} | ${f.file} | ${f.field_key}="${f.value}" | ${f.reason} | p${f.page} "${(f.quote ?? '').slice(0, 90)}"`); }
