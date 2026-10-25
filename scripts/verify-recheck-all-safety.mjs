/**
 * verify:recheck-all-safety (Re-check-all round 2, 2026-10-25) - the database side of the link safety rules, on a real Postgres
 * (PGlite, RLS role, real schema): own company, vendor block, printed customer, VOID / copy papers, a label-fill conflict, and
 * every path that runs the link step (recheckDocument, the bulk/nightly recheckTenantMissing, Verify with AI). No network, no model.
 */
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd(); const rel = (p) => path.join(root, p);
process.env.NEON_CONNECTION_STRING ||= 'postgres://verify:verify@localhost-pooler/verify';
process.env.DATABASE_URL ||= process.env.NEON_CONNECTION_STRING;
const realLog = console.log; let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; realLog(`PASS  ${name}`); } else { fail++; realLog(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`); } };
console.log = () => {}; console.error = () => {};
const { PGlite } = await import('@electric-sql/pglite');
const contrib = {};
for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
const lite = new PGlite({ extensions: contrib });
const cfg = rel('M3-config');
for (const f of fs.readdirSync(cfg).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) { try { await lite.exec(fs.readFileSync(path.join(cfg, f), 'utf8')); } catch { /* same tolerance as the other PGlite suites */ } }
try { await lite.exec(fs.readFileSync(path.join(cfg, '01b-app-role.sql'), 'utf8')); } catch { /* */ }
const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let r2; const p = new Promise((r) => { r2 = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => r2); };
pgMod.Pool.prototype.connect = async function () { const r = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (s, p) => lite.query(s, p), release: () => { lite.exec('RESET ROLE').finally(r); } }; };
pgMod.Pool.prototype.query = async function (s, p) { const r = await lock(); try { return await lite.query(s, p); } finally { r(); } };
const { getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
const RC = await import(rel('api/_lib/recheck.js'));
const RS = await import(rel('api/_lib/reviewStore.js'));
const BNL = await import(rel('api/_lib/bodyNameLink.js'));
const ctx = { tenantKey: 'org_sonoran_safety', tenantName: 'Sonoran Comfort Air' };
const ten = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
await lite.query(`UPDATE tenants SET name = 'Sonoran Comfort Air' WHERE id = $1`, [ten]).catch(() => {});
let seq = 0; const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const cust = async (name, address = '') => { const id = nid(); await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [id, ten, JSON.stringify({ customer_name: name, ...(address ? { service_address: address } : {}) })]); return id; };
const paper = async (filename, text, { facts = {}, type = 'invoice', linkTo = null } = {}) => {
  const id = nid();
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,'read',NOW())`, [id, ten, filename, type, 'h' + id]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,1,$3)`, [ten, id, text]);
  for (const [k, v] of Object.entries(facts)) {
    const fid = nid();
    await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,1,'field-extract',$4,$5,0.95,$4,'registry',NOW())`, [fid, ten, id, k, v]);
    await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, field_key, value, confidence, source_facet_id, created_at) VALUES ($1,$2,$3,$4,$5,0.95,$6,NOW())`, [nid(), ten, id, k, v, fid]);
  }
  if (linkTo) await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'person',NOW())`, [ten, id, linkTo]);
  return id;
};
const linksOf = async (id) => (await lite.query(`SELECT e.data->>'customer_name' AS name FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE l.document_id = $1`, [id])).rows.map((r) => r.name);
const stageOf = async (id) => (await lite.query(`SELECT stage FROM documents WHERE id = $1`, [id])).rows[0].stage;
const factsOf = async (id, k) => (await lite.query(`SELECT value FROM extractions WHERE document_id = $1 AND field_key = $2`, [id, k])).rows.map((r) => r.value);

const own = await cust('Sonoran Comfort Air Inc.');
const own2 = await cust('The Sonoran Comfort Air, LLC');
const jane = await cust('Jane Smith', '12 Oak Ln, Mesa, AZ');
const john = await cust('John Smith', '40 Cedar Dr, Mesa, AZ');
const maria = await cust('Maria Lopez', '500 Pine Rd, Mesa, AZ');
const body = (lines) => lines.join('\n');
const INV = (billTo) => body(['Invoice 1042', 'Date of Service: 03/04/2026', `Bill To: ${billTo}`, 'Work performed: replaced capacitor', 'Total $240.00']);

// D1 own company never links (through the single-document Re-check, the path the nightly sweep also uses)
const d1 = await paper('own-1.pdf', INV('Sonoran Comfort Air, Inc.'));
const d1b = await paper('own-2.pdf', INV('SONORAN COMFORT AIR LLC'));
const d1c = await paper('own-3.pdf', body(['Invoice 5', 'Customer: Jane Smith', 'Service Address: 12 Oak Ln, Mesa, AZ', 'Bill To: Sonoran Comfort Air']));
for (const id of [d1, d1b]) await RC.recheckDocument(ctx, id, { source: 'verify' });
check('D1 own company (Inc. / LLC variations) is not linked as a customer', (await linksOf(d1)).length === 0 && (await linksOf(d1b)).length === 0);
await RC.recheckDocument(ctx, d1c, { source: 'verify' });
check('D1 a real customer address on a paper billed to us still links to that customer', (await linksOf(d1c)).join() === 'Jane Smith', (await linksOf(d1c)).join());

// D2 vendor block
const d2a = await paper('v-1.pdf', body(['Vendor: John Smith Heating & Air', '40 Cedar Dr, Mesa AZ', 'Bill To: Walk-in customer', 'Total $90']));
const d2b = await paper('v-2.pdf', body(['From: Desert Air Co', '500 Pine Rd, Mesa AZ', 'Bill To: Walk-in customer', 'Total $90']));
const d2c = await paper('v-3.pdf', body(['FROM                  BILL TO', 'John Smith Heating    Maria Lopez', '40 Cedar Dr           500 Pine Rd', 'Total $90']));
for (const id of [d2a, d2b, d2c]) await RC.recheckDocument(ctx, id, { source: 'verify' });
check('D2 vendor name equal to a customer + walk-in bill-to: no link', (await linksOf(d2a)).length === 0);
check('D2 vendor address equal to a customer address + walk-in bill-to: no link', (await linksOf(d2b)).length === 0);
check('D2 two-column invoice: links the BILL TO column customer only', (await linksOf(d2c)).join() === 'Maria Lopez', (await linksOf(d2c)).join());

// D3 printed customer wins
const d3 = await paper('p-1.pdf', body(['Invoice 9', 'Customer: Zed Printed', 'Note: John Smith referred us', 'Bill To: Zed Printed', 'Total $50']), { facts: { customer_name: 'Zed Printed' } });
const d3b = await paper('p-2.pdf', body(['Invoice 10', 'Bill To: Maria Lopez', 'Total $50']), { facts: { customer_name: 'Maria Lopez' } });
for (const id of [d3, d3b]) await RC.recheckDocument(ctx, id, { source: 'verify' });
check('D3 printed customer Zed Printed is never linked to a body mention (John Smith)', (await linksOf(d3)).length === 0);
check('D3 printed customer that matches an existing customer does link', (await linksOf(d3b)).join() === 'Maria Lopez');
const d3c = await paper('p-3.pdf', body(['Invoice 11', 'Bill To: Maria Lopez']), { facts: { customer_name: 'person typed' } });
await lite.query(`UPDATE extractions SET corrected_value = 'Zed Person' WHERE document_id = $1`, [d3c]);
await RC.recheckDocument(ctx, d3c, { source: 'verify' });
check('D3 a person-corrected customer name beats the read value', (await linksOf(d3c)).length === 0);

// D4 set-aside papers: every path
const d4a = await paper('inv (copy).pdf', INV('Maria Lopez'), { facts: { customer_name: 'Maria Lopez' } });
const d4b = await paper('inv-void.pdf', body(['VOID', ...INV('Maria Lopez').split('\n')]), { facts: { customer_name: 'Maria Lopez' } });
const d4c = await paper('inv-3.pdf', body(['Invoice 3', 'This invoice has been voided', 'Bill To: Maria Lopez']));
const d4d = await paper('Copy of inv.pdf', INV('Maria Lopez'));
for (const id of [d4a, d4b, d4d]) await RC.recheckDocument(ctx, id, { source: 'direct' });
await RS.aiVerifyDocument(ctx, { documentId: d4a }, null).catch(() => {});
await RS.aiVerifyDocument(ctx, { documentId: d4d }, null).catch(() => {});
check('D4 a "(copy)" paper is never linked or checked, even sent by id / Verify with AI', (await linksOf(d4a)).length === 0 && (await stageOf(d4a)) !== 'verified');
check('D4 a VOID paper is never linked or checked', (await linksOf(d4b)).length === 0 && (await stageOf(d4b)) !== 'verified');
check('D4 "Copy of" paper is never linked or checked', (await linksOf(d4d)).length === 0 && (await stageOf(d4d)) !== 'verified');
const sweep = await RC.recheckTenantMissing(ctx, { limit: 100, source: 'cron', deadlineAt: Date.now() + 120000 });
check('D4/D5 the nightly sweep (no ids) still links nothing for set-aside papers', (await linksOf(d4a)).length === 0 && (await linksOf(d4b)).length === 0 && (await linksOf(d4d)).length === 0, JSON.stringify(sweep));
await RC.recheckTenantMissing(ctx, { documentIds: [d4a, d4b, d4c, d4d], openAll: true, force: true, source: 'inbox-bulk', limit: 100, deadlineAt: Date.now() + 120000 });
check('D4/D5 the bulk button (openAll) links nothing for set-aside papers', (await linksOf(d4a)).length === 0 && (await linksOf(d4b)).length === 0 && (await linksOf(d4c)).length === 0 && (await linksOf(d4d)).length === 0);

// D5 the other paths use the same rules
const d5 = await paper('p5.pdf', body(['Invoice 12', 'Vendor: John Smith Heating & Air', 'Bill To: Walk-in customer', 'Total $80']));
const d5b = await paper('p5b.pdf', INV('Sonoran Comfort Air Inc'));
await RS.aiVerifyDocument(ctx, { documentId: d5 }, null).catch(() => {});
await RS.aiVerifyDocument(ctx, { documentId: d5b }, null).catch(() => {});
await RC.recheckTenantMissing(ctx, { documentIds: [d5, d5b], force: true, source: 'cron', limit: 10, deadlineAt: Date.now() + 60000 });
check('D5 Verify-with-AI / the sweep never link a vendor-block name or our own company through the body-name step', !(await linksOf(d5)).includes('John Smith') && !(await linksOf(d5b)).some((n) => /sonoran/i.test(n)), `${await linksOf(d5)} / ${await linksOf(d5b)}`);

// D6 label-fill must not add a conflicting customer_name to a paper already linked to someone else
const d6 = await paper('lf.pdf', body(['Invoice 14', 'Customer: John Smith', 'Total $60']), { linkTo: jane });
await RC.recheckDocument(ctx, d6, { source: 'verify' });
check('D6 paper linked to Jane keeps her link and gets no "John Smith" customer_name fact', (await linksOf(d6)).join() === 'Jane Smith' && !(await factsOf(d6, 'customer_name')).includes('John Smith'), `${await linksOf(d6)} / ${await factsOf(d6, 'customer_name')}`);
const aud = (await lite.query(`SELECT changes FROM audit_log WHERE resource_id = $1 AND action = 'document.fields_rechecked'`, [d6])).rows[0]?.changes;
check('D6 the skipped fact is recorded in the audit entry', (aud?.customer_name_conflict_skipped ?? []).length === 1, JSON.stringify(aud?.customer_name_conflict_skipped));
const d6b = await paper('lf2.pdf', body(['Invoice 15', 'Customer: Jane Smith', 'Total $60']), { linkTo: jane });
await RC.recheckDocument(ctx, d6b, { source: 'verify' });
check('D6 a matching label-read name is still filled', (await factsOf(d6b, 'customer_name')).includes('Jane Smith'));

// person-unlinked, already-linked and verified papers untouched
const pu = await paper('pu.pdf', INV('Maria Lopez'));
await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_unlinked','document',$2,'{}'::jsonb)`, [ten, pu]);
await RC.recheckDocument(ctx, pu, { source: 'verify' });
check('a paper a person unlinked is not re-linked', (await linksOf(pu)).length === 0);
const keep = await paper('keep.pdf', INV('Maria Lopez'), { linkTo: jane });
await RC.recheckDocument(ctx, keep, { source: 'verify' });
check('an existing link is never moved', (await linksOf(keep)).join() === 'Jane Smith');

// Round 3: bleed, bare issuer line, collapsed line - through the bulk path (shared customer list / own names across the batch)
const acme = await cust('Acme Dental Group', '77 Mill Ave, Tempe, AZ');
const r3a = await paper('r3a.pdf', body(['Invoice 31', 'Bill To: Walk-in', 'John Smith Heating & Air', '(480) 555-0100', 'Total $75']));
const r3b = await paper('r3b.pdf', body(['Acme Dental Group', '77 Mill Ave', 'Tempe, AZ 85281', '', 'Minutes of the March meeting']), { type: 'other' });
const r3c = await paper('r3c.pdf', body(['Invoice 32', 'Bill To Walk-in From John Smith Heating 40 Cedar Dr', 'Total $75']));
const r3d = await paper('r3d.pdf', body(['Invoice 33', 'Bill To', 'Maria Lopez', '500 Pine Rd', 'Remit To: Desert Air Co', 'Total $75']));
await RC.recheckTenantMissing(ctx, { documentIds: [r3a, r3b, r3c, r3d], openAll: true, force: true, source: 'inbox-bulk', limit: 10, deadlineAt: Date.now() + 60000 });
check('W1 Bill To: Walk-in + vendor line below: vendor not linked', !(await linksOf(r3a)).includes('John Smith'), (await linksOf(r3a)).join());
check('W4 unlabelled paper with the issuer name alone on line 1: not linked', (await linksOf(r3b)).length === 0, (await linksOf(r3b)).join());
check('W3 collapsed "Bill To Walk-in From <vendor>": vendor not linked', !(await linksOf(r3c)).includes('John Smith'), (await linksOf(r3c)).join());
check('control: label alone, name on the next line, links the customer', (await linksOf(r3d)).join() === 'Maria Lopez', (await linksOf(r3d)).join());

// Round 5: weak evidence is kept as a suggestion for a person (never a link)
const sug = await paper('sug1.pdf', body(['Invoice 50', 'Service Address: 40 Cedar Dr, Mesa AZ', 'Total $5']));
const sug2 = await paper('sug2.pdf', body(['Invoice 51', 'Notes: spoke with Maria Lopez about the visit', '9 Birch St, Tempe AZ', 'Total $5']));
await RC.recheckDocument(ctx, sug, { source: 'verify' });
await RC.recheckDocument(ctx, sug2, { source: 'verify' });
const sugsFor = async (id) => (await RS.listLinks(ctx, { documentIds: [id] })).suggestions.filter((s) => s.document_id === id);
const sugRows = async (id) => (await sugsFor(id)).map((s) => JSON.stringify(s.candidates));
const sugAudit = async (id) => (await lite.query(`SELECT 1 FROM audit_log WHERE resource_id = $1 AND action = 'recheck.link_suggestion'`, [id])).rows.length;
check('R5 a street-only paper is not linked but keeps a suggestion naming that customer', (await linksOf(sug)).length === 0 && (await sugRows(sug)).length === 1 && (await sugRows(sug))[0].includes('John Smith'), (await sugRows(sug)).join());
check('R5 a customer named only in a note is suggested, not linked', (await linksOf(sug2)).length === 0 && (await sugRows(sug2)).length === 1 && /Maria Lopez/.test((await sugRows(sug2))[0]), (await sugRows(sug2)).join());
const auditBefore = await sugAudit(sug);
await RC.recheckDocument(ctx, sug, { source: 'verify' });
check('R5 re-checking again changes nothing (idempotent, no new record)', (await sugRows(sug)).length === 1 && (await sugAudit(sug)) === auditBefore);
const sugOk = await paper('sug3.pdf', body(['Invoice 52', 'Bill To: Maria Lopez', 'Total $5']));
await RC.recheckDocument(ctx, sugOk, { source: 'verify' });
check('R5 a strong link writes no suggestion', (await linksOf(sugOk)).join() === 'Maria Lopez' && (await sugAudit(sugOk)) === 0);
// R6: the suggestion is NOT a fact and reaches no fact path
const leak = async (id) => {
  const cand = (await sugsFor(id))[0]?.candidates ?? [];
  const tables = ['extractions', 'facets', 'documents', 'document_pages'];
  for (const tb of tables) {
    const rows = (await lite.query(`SELECT t::text AS s FROM ${tb} t WHERE ${tb === 'documents' ? 'id' : 'document_id'} = $1`, [id])).rows;
    if (rows.some((r) => /link_suggestion|recheck\.link/.test(r.s) || cand.some((c) => r.s.includes(c.id)))) return tb;
  }
  const ex = (await lite.query(`SELECT field_key FROM extractions WHERE document_id = $1`, [id])).rows.map((r) => r.field_key);
  return ex.some((k) => /suggest/i.test(k)) ? 'field_key' : null;
};
check('R6 the suggestion lives in no extraction, facet, document or page row (so no fact listing, search, Donovan fact view or export can see it)', (await leak(sug)) === null && (await leak(sug2)) === null, String(await leak(sug)));
const apiTree = fs.readdirSync(path.join(root, 'api'), { recursive: true }).filter((f) => /\.(js|mjs)$/.test(String(f)));
const srcTree = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(String(f)));
const mentions = [...apiTree.map((f) => path.join(root, 'api', String(f))), ...srcTree.map((f) => path.join(root, 'src', String(f)))].filter((f) => /_link_suggestion/.test(fs.readFileSync(f, 'utf8')));
check('R6 no code path reads or writes a "_link_suggestion" extraction any more', mentions.length === 0, mentions.join());
// R6: any link or unlink by a person clears it
const cid = (await sugsFor(sug))[0].candidates[0].id;
await RS.linkDocument(ctx, { documentId: sug, entityId: cid, by: 'person' }, null);
check('R6 a person linking the paper clears its suggestion', (await sugsFor(sug)).length === 0);
await RS.unlinkDocument(ctx, { documentId: sug, entityId: cid }, null);
check('R6 ...and it does not come back after the person unlinks', (await sugsFor(sug)).length === 0 && (await linksOf(sug)).length === 0);
await RC.recheckDocument(ctx, sug, { source: 'verify' });
check('R6 a person-unlinked paper is never re-suggested or relinked by Re-check', (await sugsFor(sug)).length === 0 && (await linksOf(sug)).length === 0);
// R6: junk entities and the issuer's own signer are not suggested
await cust('PROJECT LOCATION');
const junk = await paper('junk1.pdf', body(['Invoice 60', 'Notes: see PROJECT LOCATION for access', 'Total $5']));
await RC.recheckDocument(ctx, junk, { source: 'verify' });
check('R6 a junk customer ("PROJECT LOCATION") is never linked or suggested', (await linksOf(junk)).length === 0 && (await sugsFor(junk)).length === 0);
const signer = await paper('signer1.pdf', body(['Thank you for your gift', 'Sincerely,', 'Maria Lopez', 'Development Director', 'Total $0']));
const signer2 = await paper('signer2.pdf', body(['Thank you for your gift', 'Development Director: Maria Lopez', 'Total $0']));
await RC.recheckDocument(ctx, signer, { source: 'verify' });
await RC.recheckDocument(ctx, signer2, { source: 'verify' });
check('R6 the issuer\'s own signer is never linked or suggested', (await linksOf(signer)).length === 0 && (await sugsFor(signer)).length === 0 && (await linksOf(signer2)).length === 0 && (await sugsFor(signer2)).length === 0);

// R6.1: employees are not customers - HR letters and licence/ID papers (and People-and-HR filed papers) never link or get a suggestion
const hrBody = body(['Offer of employment', 'Bill To: Maria Lopez', 'Dear Maria Lopez, welcome aboard', 'Total $0']);
const hr1 = await paper('hr1.pdf', hrBody);
const hr2 = await paper('hr2.pdf', body(['Contractor license', 'Customer: Maria Lopez', 'License No 123']));
const hr3 = await paper('hr3.pdf', body(['Invoice 70', 'Bill To: Maria Lopez', 'Total $5']));
const hr4 = await paper('hr4.pdf', body(['Service Address: 40 Cedar Dr, Mesa AZ', 'Invoice 71', 'Total $5']));
await lite.query(`UPDATE documents SET document_type = 'hr-letter' WHERE id = $1`, [hr1]);
await lite.query(`UPDATE documents SET document_type = 'license-certification' WHERE id = $1`, [hr2]);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'_company_folder','people-hr',1)`, [ten, hr3]);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'_company_folder','people-hr',1)`, [ten, hr4]);
const hr5 = await paper('hr5.pdf', body(['Invoice 72', 'Bill To: Maria Lopez', 'Total $5']));
const hr6 = await paper('hr6.pdf', body(['Invoice 73', 'Bill To: Maria Lopez', 'Total $5']));
const hr7 = await paper('hr7.pdf', body(['Invoice 74', 'Bill To: Maria Lopez', 'Total $5']));
await lite.query(`UPDATE documents SET document_type = 'HR Letter' WHERE id = $1`, [hr5]);
await lite.query(`UPDATE documents SET document_type = 'License Certification' WHERE id = $1`, [hr6]);
await lite.query(`UPDATE documents SET document_type = 'hr_letter' WHERE id = $1`, [hr7]);
// ingest / nightly sweep path (no recheck): the shared planner itself must skip legacy spellings
const swept = await BNL.applyBodyNameLinks(ctx, { dryRun: true });
check('R6.1 legacy spellings (HR Letter, License Certification, hr_letter) are skipped by the shared planner', ![hr5, hr6, hr7].some((id) => swept.linked.some((l) => l.documentId === id) || swept.review.some((l) => l.documentId === id)), JSON.stringify(swept.linked.map((l) => l.documentId)));
for (const id of [hr1, hr2, hr3, hr4, hr5, hr6, hr7]) await RC.recheckDocument(ctx, id, { source: 'verify' });
const hrAll = [];
for (const id of [hr1, hr2, hr3, hr4, hr5, hr6, hr7]) hrAll.push((await linksOf(id)).length + (await sugsFor(id)).length);
check('R6.1 HR letters, licence/ID papers and People-and-HR filed papers are never linked and never get a suggestion', hrAll.every((n) => n === 0), hrAll.join());

// R6.2 the 2026-09-23 memo shape: a name in free text is not auto-linked, but it is offered as a one-click suggestion
const memo = await paper('memo.pdf', "Reminder logged for Maria Lopez's account: confirm filter size on next visit.", { type: 'correspondence' });
await RC.recheckDocument(ctx, memo, { source: 'verify' });
const memoSug = (await sugsFor(memo))[0]?.candidates ?? [];
check('R6.2 a memo naming a customer in free text is not linked but offers "Link to Maria Lopez" (one-click suggestion)', (await linksOf(memo)).length === 0 && memoSug.length === 1 && memoSug[0].name === 'Maria Lopez', JSON.stringify(memoSug));
// R6.2 a wrapped "Customer:" value (name split over two lines) links through the whole path
const wrap = await paper('wrap.pdf', body(['Invoice 80', 'Customer: Maria', 'Lopez', 'Total $5']));
await RC.recheckDocument(ctx, wrap, { source: 'verify' });
check('R6.2 "Customer: Maria" / "Lopez" on the next line links to Maria Lopez', (await linksOf(wrap)).join() === 'Maria Lopez', (await linksOf(wrap)).join());

// positive control
const ok = await paper('ok.pdf', INV('Maria Lopez'));
const r = await RC.recheckTenantMissing(ctx, { documentIds: [ok], openAll: true, force: true, source: 'inbox-bulk', limit: 10, deadlineAt: Date.now() + 60000 });
const addrOnly = await paper('addr-only.pdf', body(['Invoice 40', 'Service Address: 40 Cedar Dr, Mesa AZ', 'Total $5']));
await RC.recheckDocument(ctx, addrOnly, { source: 'verify' });
check('R4 a street alone (service address only) never links', (await linksOf(addrOnly)).length === 0, (await linksOf(addrOnly)).join());
check('control: an ordinary bill-to with one existing customer links', (await linksOf(ok)).join() === 'Maria Lopez' && r.linked === 1, JSON.stringify(r));
check('errored papers are listed for the caller (errorIds present)', Array.isArray(r.errorIds));
realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
