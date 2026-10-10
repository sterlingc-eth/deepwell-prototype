#!/usr/bin/env node
/**
 * Read-only analysis of a tenant export (the app's Export file): groups the
 * customers into exact duplicates, near duplicates and the company's own name,
 * and counts the documents / links / equipment each group touches. Uses the
 * same grouping rules the app uses (integrity.js groupDuplicateCustomers).
 *   node scripts/analyse-customer-export.mjs <export.json> "<company name>" [out.md]
 */
import fs from 'node:fs';
import { groupDuplicateCustomers } from '../api/_lib/integrity.js';

const [file, company = '', out] = process.argv.slice(2);
if (!file) { console.error('usage: analyse-customer-export.mjs <export.json> "<company name>" [out.md]'); process.exit(1); }
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const custs = d.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into);
const equip = d.entities.filter((e) => e.entity_type === 'equipment');
const linksBy = new Map(); for (const l of d.links) { if (!linksBy.has(l.entity_id)) linksBy.set(l.entity_id, []); linksBy.get(l.entity_id).push(l); }
const exBy = new Map(); for (const x of d.extractions) if (x.entity_id) exBy.set(x.entity_id, (exBy.get(x.entity_id) ?? 0) + 1);
const eqBy = new Map(); for (const e of equip) if (e.customer_id) eqBy.set(e.customer_id, (eqBy.get(e.customer_id) ?? 0) + 1);
const rec = custs.map((e) => ({
  id: e.id, customerNumber: e.customer_number, name: e.data?.customer_name ?? '', address: e.data?.service_address ?? '',
  phone: e.data?.phone ?? '', email: e.data?.email ?? '',
  docCount: new Set((linksBy.get(e.id) ?? []).map((l) => l.document_id)).size,
  linkCount: (linksBy.get(e.id) ?? []).length, equipmentCount: eqBy.get(e.id) ?? 0, extractionCount: exBy.get(e.id) ?? 0,
}));
const byId = new Map(rec.map((r) => [r.id, r]));
const g = groupDuplicateCustomers(rec, { ownNames: company ? [company] : [] });
const sum = (ids, f) => ids.reduce((n, id) => n + (byId.get(id)?.[f] ?? 0), 0);
const docsOf = (ids) => new Set(ids.flatMap((id) => (linksBy.get(id) ?? []).map((l) => l.document_id))).size;
const stat = (ids) => ({ records: ids.length, docs: docsOf(ids), links: sum(ids, 'linkCount'), equipment: sum(ids, 'equipmentCount'), extractions: sum(ids, 'extractionCount') });
const total = (groups, pick) => { const t = { groups: groups.length, records: 0, extra: 0, docs: 0, links: 0, equipment: 0 }; for (const x of groups) { const s = stat(pick(x)); t.records += s.records; t.extra += s.records - 1; t.docs += s.docs; t.links += s.links; t.equipment += s.equipment; } return t; };
const selfIds = g.self.map((s) => s.id);
const L = [];
L.push(`# Customer duplicate analysis`, '', `Source: \`${file}\` (exported ${d.exportedAt}). Company name used for the "this is us" check: **${company || '(none)'}**.`, '',
  `- Customers (not merged away): **${rec.length}**; documents: ${d.documents.length}; links: ${d.links.length}; equipment: ${equip.length}.`,
  `- Exact-name duplicate groups: **${g.exact.length}** (${g.exact.filter((x) => x.safe).length} safe for one-click merge, ${g.exact.filter((x) => !x.safe).length} need a look because a phone, email or city disagrees).`,
  `- Near-duplicate groups (spelling, Inc/LLC/Co, typo, same email/phone): **${g.near.length}**.`,
  `- Records carrying the company's own name: **${g.self.length}**.`, '');
const te = total(g.exact, (x) => x.ids), tn = total(g.near, (x) => x.ids), ts = stat(selfIds);
L.push('## Totals', '', '| Kind | Groups | Records | Extra records removed by merging | Documents touched | Links touched | Equipment touched |', '|---|---|---|---|---|---|---|',
  `| Exact | ${te.groups} | ${te.records} | ${te.extra} | ${te.docs} | ${te.links} | ${te.equipment} |`,
  `| Near | ${tn.groups} | ${tn.records} | ${tn.extra} | ${tn.docs} | ${tn.links} | ${tn.equipment} |`,
  `| Company's own name | 1 | ${ts.records} | ${ts.records} (all leave the customer list) | ${ts.docs} | ${ts.links} | ${ts.equipment} |`, '');
L.push('## A. Exact duplicates', '', '| Name | Records | Docs | Links | Equip | Suggested main | Safe? |', '|---|---|---|---|---|---|---|');
for (const x of g.exact) { const s = stat(x.ids); L.push(`| ${x.name} | ${s.records} | ${s.docs} | ${s.links} | ${s.equipment} | ${byId.get(x.mainId).customerNumber} | ${x.safe ? 'yes' : 'review: ' + x.conflicts.join('/')} |`); }
L.push('', '## B. Near duplicates', '', '| Names in the group | Why | Records | Docs | Links | Equip | Suggested main |', '|---|---|---|---|---|---|---|');
for (const x of g.near) { const s = stat(x.ids); const names = [...new Set(x.ids.map((id) => byId.get(id).name))].join(' / '); L.push(`| ${names} | ${x.reasons.join(', ')} | ${s.records} | ${s.docs} | ${s.links} | ${s.equipment} | ${byId.get(x.mainId).customerNumber} |`); }
L.push('', '## C. The company itself as a customer', '', `${g.self.length} records named "${company}": ${g.self.map((s) => s.customerNumber).join(', ')}.`, '',
  `They hold ${ts.docs} documents (${ts.links} links) and ${ts.equipment} pieces of equipment. "This is us" moves those documents to company papers and takes the records out of the customer list.`, '');
const ph = rec.filter((r) => /^customer at /i.test(r.name)); L.push(`Address-only placeholder records ("Customer at ...") are left out of the groups above: ${ph.length}.`, '');
const out2 = L.join('\n'); if (out) fs.writeFileSync(out, out2); else console.log(out2);
console.log(JSON.stringify({ exact: g.exact.length, safe: g.exact.filter((x) => x.safe).length, near: g.near.length, self: g.self.length, te, tn, ts }));
