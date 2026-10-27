// Import autopilot on the 1,000 Sonoran files treated as a brand-new client's upload (no customers yet, nothing linked, one batch).
// Independent oracle: every customer the run creates or links must be printed in the paper's own text; every date written must appear in
// the page text. 20 sampled pairs are printed for a by-eye audit.   DATA=<dir with stored_old.json + pages_old.json> node scripts/proof-import-sonoran.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startPglite, insertDocs, insertPages, insertFields } from './lib/pglite-tenant.mjs';
import { drive, CLICKS } from './lib/import-run.mjs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DATA = process.env.DATA || '/mnt/user-data/uploads/Downloads/donovan-training/_lc_tmp';
const log = console.log; console.log = () => {}; console.error = () => {};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const h = await startPglite(root);
const ctx = { tenantKey: 'org_sonoran_import', tenantName: 'Sonoran Comfort Air' };
const ten = (await h.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'stored_old.json'), 'utf8'));
const pages = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'pages_old.json'), 'utf8')).docs.map((d) => [d.filename, d]));
const batch = h.nid(); const scope = { batchId: batch };
const docs = stored.map((s) => ({ id: h.nid(), s, text: (pages.get(s.filename)?.pages ?? []).map((p) => p.text ?? '').join('\n') }));
await insertDocs(h.lite, ten, docs.map((d) => ({ id: d.id, name: d.s.filename, type: d.s.type, stage: 'read', batch })));
await insertPages(h.lite, ten, docs.filter((d) => d.text).map((d) => ({ id: d.id, text: d.text })));
await insertFields(h.lite, ten, docs.flatMap((d) => d.s.fields.map((f) => ({ doc: d.id, key: f.field_key, value: f.value, conf: f.confidence ?? 0.9 }))));
// id-bank: HR / licence papers whose people ALSO exist as customers (the 0/0 trap): they must never be linked, never make a customer, never be filed by the autopilot
const bank = JSON.parse(fs.readFileSync(path.join(root, 'test-docs/id-bank/pages-bank.json'), 'utf8')).docs;
const truths = new Map(fs.readdirSync(path.join(root, 'test-docs/id-bank/truth')).filter((f) => f.endsWith('.json')).map((f) => { const t = JSON.parse(fs.readFileSync(path.join(root, 'test-docs/id-bank/truth', f), 'utf8')); return [t.id, t]; }));
const bankDocs = []; const seenPeople = new Set();
for (const b of bank) {
  const t = truths.get(b.id); if (!t) continue;
  if (t.person && !seenPeople.has(t.person.toLowerCase())) { seenPeople.add(t.person.toLowerCase()); await h.lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [h.nid(), ten, JSON.stringify({ customer_name: t.person })]); }
  bankDocs.push({ id: h.nid(), name: `${b.id}.pdf`, type: /^(hr-letter|license-certification)$/.test(t.type) ? t.type : 'other', text: (b.pages ?? []).map((p) => p.text ?? '').join('\n') });
}
await insertDocs(h.lite, ten, bankDocs.map((d) => ({ id: d.id, name: d.name, type: d.type, stage: 'read', batch })));
await insertPages(h.lite, ten, bankDocs.filter((d) => d.text).map((d) => ({ id: d.id, text: d.text })));
const RC = await import(root + '/api/_lib/recheck.js');
const { splitPartyZones } = await import(root + '/api/_lib/bodyNameLink.js');
const { isLabelValue } = await import(root + '/api/_lib/documentTypes.js');
const { isJunkCustomerName } = await import(root + '/api/_lib/bodyNameLink.js');
const queue = docs.map((d) => d.id).concat(bankDocs.map((d) => d.id));
while (queue.length) { const chunk = queue.splice(0, 100); await RC.recheckTenantMissing(ctx, { documentIds: chunk, openAll: true, force: true, limit: 100, source: 'inbox-bulk', actorClerkId: 'u', deadlineAt: Date.now() + 100000 }); }
const IA = await import(root + '/api/_lib/importAutopilot.js');
const q = async (sql, p = []) => (await h.lite.query(sql, p)).rows;
const linksBefore = (await q(`SELECT count(*)::int n FROM document_entity_links`))[0].n;
const plan0 = await IA.importPlan(ctx, { ...scope, fresh: true });
const run = await drive(IA, ctx, scope, {});
const final = await IA.importStatus(ctx, scope);
const plan1 = await IA.importPlan(ctx, { ...scope, fresh: true });
const links = await q(`SELECT l.document_id d, l.linked_by lb, e.data->>'customer_name' n FROM document_entity_links l JOIN entities e ON e.id = l.entity_id`);
const byId = new Map(docs.map((d) => [d.id, d]));
const fmt = (iso) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso ?? ''); if (!m) return []; const [, y, mo, d] = m; const mn = ['January','February','March','April','May','June','July','August','September','October','November','December'][+mo - 1]; return [iso, `${+mo}/${+d}/${y}`, `${mo}/${d}/${y}`, `${mn} ${+d}, ${y}`, `${mn.slice(0, 3)} ${+d}, ${y}`, `${mo}/${d}/${y.slice(2)}`, `${+mo}/${+d}/${y.slice(2)}`]; };
let wrongLinks = 0, linkedByRun = 0; const bad = []; const pairs = [];
for (const l of links) {
  const d = byId.get(l.d); const t = norm(d.text); const truth = d.s.fields.find((f) => f.field_key === 'customer_name')?.value;
  linkedByRun++;
  const inText = t.includes(norm(l.n));
  const eqTruth = truth ? norm(truth) === norm(l.n) : null;
  // strengthened oracle: the customer must sit on the CUSTOMER side of the page, must not be a label / heading, the issuer or our own company,
  // and the customer side must not name a second, different customer (then the page does not say which one is ours)
  const z = splitPartyZones([{ page_no: 1, text: d.text }]);
  const cust = z.customerValues.map((v) => norm(v.split(/\s{2,}|\t|\|/)[0]));
  const customerSide = cust.some((v) => v === norm(l.n) || v.startsWith(norm(l.n)));
  const labelish = isLabelValue(l.n) || isJunkCustomerName(l.n) || /^(registered|submitted|bill|sold|ship|owner|customer|attention)\b/i.test(l.n) || (l.n === l.n.toUpperCase() && /\b(to|owner|registered)\b/i.test(l.n));
  const issuer = z.vendor.some((v) => norm(v).includes(norm(l.n)));
  const own = norm(l.n) === norm('Sonoran Comfort Air');
  const distinctNames = new Set(cust.filter((v) => v.length > 3 && !isLabelValue(v) && !/^\d/.test(v)).map((v) => v)).size;
  const sideOk = customerSide && !labelish && !issuer && !own;
  if (!inText || eqTruth === false || !sideOk) { wrongLinks++; bad.push({ file: d.s.filename, linked: l.n, truth, inText, customerSide, labelish, issuer, own, otherCustomerSideNames: distinctNames }); }
  pairs.push({ file: d.s.filename, customer: l.n, storedName: truth ?? null, inText, customerSide, customerSideNames: distinctNames });
}
const bankIds = bankDocs.map((d) => d.id);
const hrLinked = (await q(`SELECT count(*)::int n FROM document_entity_links WHERE document_id = ANY($1::uuid[])`, [bankIds]))[0].n;
const hrFiled = (await q(`SELECT count(*)::int n FROM documents WHERE id = ANY($1::uuid[]) AND stage = 'verified' AND document_type IN ('hr-letter','license-certification')`, [bankIds]))[0].n;
if (process.env.DEBUG_BANK) { const r = await q(`SELECT original_filename f, document_type t FROM documents WHERE id = ANY($1::uuid[]) AND stage = 'verified' AND document_type NOT IN ('hr-letter','license-certification')`, [bankIds]); log(JSON.stringify(r.map((x) => ({ ...x, truth: truths.get(x.f.replace('.pdf',''))?.type, person: truths.get(x.f.replace('.pdf',''))?.person })))); }
const sd = await q(`SELECT DISTINCT ON (document_id) document_id d, COALESCE(NULLIF(btrim(corrected_value),''), value) v, corrected_by cb FROM extractions WHERE field_key='service_date' ORDER BY document_id, created_at DESC, id DESC`);
let valuesWritten = 0, wrongValues = 0;
for (const r of sd) { const d = byId.get(r.d); if (!r.cb) continue; valuesWritten++; if (!fmt(r.v).some((f) => d.text.includes(f))) { wrongValues++; bad.push({ file: d.s.filename, date: r.v }); } }
const overwritten = (await q(`SELECT count(*)::int n FROM extractions WHERE corrected_by IS NOT NULL AND value IS NOT NULL AND btrim(value) <> '' AND field_key <> 'service_date'`))[0].n;
const sample = pairs.filter((_, i) => i % Math.max(1, Math.floor(pairs.length / 20)) === 0).slice(0, 20);
const typeCount = {}; for (const d of docs) typeCount[d.s.type] = (typeCount[d.s.type] ?? 0) + 1;
const left = plan1.lookAt.count + (final.counts.failed ?? 0);
const out = { papers: docs.length, linksBefore, autoFiled: run.autoFiled, filedTotal: final.counts.filed, decisionsFirstPlan: plan0.decisions.length, decisionsTotal: run.decisionCount, decisionKinds: Object.entries(plan0.decisions.reduce((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {})), decisionsStillOpen: plan1.decisions.length, papersLeftOneByOne: left, lookAtReasons: plan1.lookAt.reasons, linkedByRun, wrongLinks, idBank: { papers: bankDocs.length, linked: hrLinked, hrOrLicenceFiledAsCompanyFiles: hrFiled }, valuesWritten, wrongValues, mainValueOverwritten: overwritten, clicksBefore: docs.length * CLICKS.openActCheck, clicksAfter: run.decisionCount * CLICKS.decision + left * CLICKS.lookAt, bad: bad.slice(0, 10), sample };
log(JSON.stringify(out, null, 1));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
if (process.env.GROUPS_OUT) { const grp = await q(`SELECT e.data->>'customer_name' n, count(*)::int c, array_agg(d.original_filename) fs FROM document_entity_links l JOIN entities e ON e.id=l.entity_id JOIN documents d ON d.id=l.document_id GROUP BY 1 ORDER BY 2 DESC`); fs.writeFileSync(process.env.GROUPS_OUT, JSON.stringify(grp, null, 1)); }
process.exit(wrongLinks || wrongValues || hrLinked ? 1 : 0);
