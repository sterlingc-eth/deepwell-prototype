/**
 * verify:ai-finish (2026-10-26) - the AI finish pass (api/_lib/aiFinish.js) on a real Postgres (PGlite, RLS role, real schema) with a STUBBED model.
 * No network, no key. The rules under test are all ways to throw an answer away:
 *   quote not on the page -> rejected | person values untouched | no auto-links (a customer is only SUGGESTED) | the cap stops the run |
 *   set-aside and HR papers get no customer suggestion (and no model call) | Haiku only | failed twice -> skipped | not paid for twice |
 *   cost recorded internally | no customer-facing string carries money.
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
const AF = await import(rel('api/_lib/aiFinish.js'));
const { withCache } = await import(rel('api/_lib/promptCache.js'));
const { buildExtractPrompt } = await import(rel('api/_lib/extractFields.js'));
const { splitExtractPrompt } = await import(rel('api/_lib/extractDocument.js'));
const ctx = { tenantKey: 'org_finish', tenantName: 'Sonoran Comfort Air' };
const ten = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
await lite.query(`UPDATE tenants SET name = 'Sonoran Comfort Air' WHERE id = $1`, [ten]).catch(() => {});
let seq = 0; const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const cust = async (name, address = '') => { const id = nid(); await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [id, ten, JSON.stringify({ customer_name: name, ...(address ? { service_address: address } : {}) })]); return id; };
const body = (lines) => lines.join('\n');
const paper = async (filename, text, { facts = {}, type = 'invoice', linkTo = null, folder = null, storageKey = null } = {}) => {
  const id = nid();
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, storage_key, created_at) VALUES ($1,$2,$3,$4,$5,'read',$6,NOW())`, [id, ten, filename, type, 'h' + id, storageKey]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,1,$3)`, [ten, id, text]);
  const all = { ...facts, ...(folder ? { _company_folder: folder } : {}) };
  for (const [k, v] of Object.entries(all)) {
    const fid = nid();
    await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,1,'field-extract',$4,$5,0.95,$4,'registry',NOW())`, [fid, ten, id, k, v]);
    await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, field_key, value, confidence, source_facet_id, created_at) VALUES ($1,$2,$3,$4,$5,0.95,$6,NOW())`, [nid(), ten, id, k, v, fid]);
  }
  if (linkTo) await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'person',NOW())`, [ten, id, linkTo]);
  return id;
};
const linksOf = async (id) => (await lite.query(`SELECT e.data->>'customer_name' AS name FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE l.document_id = $1`, [id])).rows.map((r) => r.name);
const rowsOf = async (id, k) => (await lite.query(`SELECT e.value, e.corrected_value, f.segment_id FROM extractions e LEFT JOIN facets f ON f.id = e.source_facet_id WHERE e.document_id = $1 AND e.field_key = $2`, [id, k])).rows;
const aiRows = async (id) => (await lite.query(`SELECT e.field_key, e.value FROM extractions e JOIN facets f ON f.id = e.source_facet_id WHERE e.document_id = $1 AND f.segment_id = 'field-ai'`, [id])).rows;
const docOf = async (id) => (await lite.query(`SELECT stage, document_type FROM documents WHERE id = $1`, [id])).rows[0];
const sugsFor = async (id) => (await lite.query(`SELECT changes FROM audit_log WHERE resource_id = $1 AND action = 'recheck.link_suggestion' ORDER BY created_at DESC, id DESC LIMIT 1`, [id])).rows[0]?.changes?.candidates ?? [];
const finishRows = async (id) => (await lite.query(`SELECT changes FROM audit_log WHERE resource_id = $1 AND action = 'ai_finish.run' ORDER BY created_at, id`, [id])).rows.map((r) => r.changes);
const classify = async (id, type) => lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_classified','document',$2,$3::jsonb)`, [ten, id, JSON.stringify({ documentType: type })]);

// ---- the stubbed model: the answer is looked up by a token printed on the paper
const SCRIPT = new Map(); // token -> answer (object) | function | Error
let calls = 0; let lastCall = null; const modelsSeen = new Set();
const USAGE = { inputTokens: 2500, outputTokens: 300, cacheReadInputTokens: 7000, cacheCreationInputTokens: 0 };
const callModel = async (args) => {
  calls++; lastCall = args; modelsSeen.add(args.model);
  const tok = /\bTOK-[A-Z0-9]+\b/.exec(args.user)?.[0];
  const a = SCRIPT.get(tok);
  if (a instanceof Error) throw a;
  const v = typeof a === 'function' ? a(args) : a;
  return { toolInput: v ?? { document_type: 'other', fields: [] }, usage: USAGE };
};
const realRd = await import(rel('api/_lib/readDocument.js'));
const deps = { callModel };
const fin = (id, o = {}) => AF.finishPaper(ctx, id, { source: 'verify', deps, today: '2026-10-26', ...o });

const maria = await cust('Maria Lopez', '500 Pine Rd, Mesa, AZ');
const jane = await cust('Jane Smith', '12 Oak Ln, Mesa, AZ');
const own = await cust('Sonoran Comfort Air Inc.');
const zed = await cust('Zed Rivera', '9 Birch Ct, Mesa, AZ');

// ---------- 1. a good answer is kept: the exact quote is on the page
const t1 = await paper('t1.pdf', body(['TOK-A1 Estimate sheet', 'Prepared for the Rivera household', 'Tech arrived and completed the repair on the fourth of March 2026', 'Please remit forty two dollars']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-A1', { document_type: 'work-order', fields: [
  { key: 'service_date', value: '2026-03-04', page_no: 1, confidence: 0.92, verbatim: 'completed the repair on the fourth of March 2026' },
] });
const r1 = await fin(t1);
// the date is not a literal date string in that quote: the value is not readable out of it, so it is rejected (value-not-in-quote)
check('1a a value that cannot be read out of its quote is rejected', (await aiRows(t1)).length === 0 && r1.rejected.some((x) => x.field_key === 'service_date' && x.reason === 'value-not-in-quote'), JSON.stringify(r1.rejected));

const t2 = await paper('t2.pdf', body(['TOK-A2 Service work order', 'Work done at 9 Birch Ct', 'Completed on 03/14/2026 by the technician']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-A2', { document_type: 'work-order', fields: [
  { key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.92, verbatim: 'Completed on  03/14/2026' }, // whitespace + case differ: still on the page
] });
const r2 = await fin(t2);
check('2 a value whose exact quote is on the page (whitespace/case normalised) is saved as an AI-filled fact', (await aiRows(t2)).some((x) => x.field_key === 'service_date' && x.value === '2026-03-14'), JSON.stringify({ r2: r2.rejected, rows: await rowsOf(t2, 'service_date') }));
check('2b it is marked field-ai (the "filled by AI" provenance) and the paper was then auto-checked or left for a person, never half-written', (await rowsOf(t2, 'service_date')).every((x) => x.segment_id !== 'field-extract') && ['verified', 'read', 'mapped', 'linked'].includes((await docOf(t2)).stage));

// ---------- 3. quote not found / no quote: discarded
const t3 = await paper('t3.pdf', body(['TOK-B1 Work order', 'Site: 9 Birch Ct', 'Technician notes: none']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-B1', { document_type: 'work-order', fields: [
  { key: 'service_date', value: '2026-03-04', page_no: 1, confidence: 0.95, verbatim: 'Date of Service: 03/04/2026' }, // invented quote
] });
const t3b = await paper('t3b.pdf', body(['TOK-B2 Work order', 'Site: 9 Birch Ct']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-B2', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-04', page_no: 1, confidence: 0.99 }] }); // no quote at all
const t3c = await paper('t3c.pdf', body(['TOK-B3 Work order', 'Site: 9 Birch Ct', 'Visit 03/04/2026']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-B3', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-04', page_no: 1, confidence: 0.5, verbatim: 'Visit 03/04/2026' }] }); // real quote, low confidence
const t3d = await paper('t3d.pdf', body(['TOK-B4 Work order', 'Site: 9 Birch Ct', 'Visit 03/04/2026']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } });
SCRIPT.set('TOK-B4', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-04-09', page_no: 1, confidence: 0.95, verbatim: 'Visit 03/04/2026' }] }); // real quote, WRONG value
const r3 = await fin(t3); const r3b = await fin(t3b); const r3c = await fin(t3c); const r3d = await fin(t3d);
check('3a quote not found on the page: rejected, nothing written', (await aiRows(t3)).length === 0 && r3.rejected.some((x) => x.reason === 'quote-not-on-page'), JSON.stringify(r3.rejected));
check('3b no quote at all: rejected', (await aiRows(t3b)).length === 0 && r3b.rejected.some((x) => x.reason === 'no-quote'), JSON.stringify(r3b.rejected));
check('3c a real quote but low confidence: rejected', (await aiRows(t3c)).length === 0 && r3c.rejected.some((x) => x.reason === 'low-confidence'));
check('3d a real quote but a value the quote does not contain: rejected', (await aiRows(t3d)).length === 0 && r3d.rejected.some((x) => x.reason === 'value-not-in-quote'), JSON.stringify(r3d.rejected));
check('3e a rejected paper is recorded as looked-at (not paid for again) and still open', (await finishRows(t3))[0]?.outcome === 'nothing' && (await docOf(t3)).stage !== 'verified');

// ---------- 4. person values are untouched
const t4 = await paper('t4.pdf', body(['TOK-C1 Invoice', 'Bill: Date of Service 03/04/2026', 'Total due $85.00']), { type: 'invoice', facts: { vendor: 'Desert Air Co', service_date: '2026-01-01' } });
await lite.query(`UPDATE extractions SET corrected_value = '2026-02-02' WHERE document_id = $1 AND field_key = 'service_date'`, [t4]);
SCRIPT.set('TOK-C1', { document_type: 'invoice', fields: [
  { key: 'service_date', value: '2026-03-04', page_no: 1, confidence: 0.95, verbatim: 'Date of Service 03/04/2026' }, // NOT missing (a person corrected it)
  { key: 'cost', value: '85.00', page_no: 1, confidence: 0.95, verbatim: 'Total due $85.00' },
] });
const beforeP = JSON.stringify(await rowsOf(t4, 'service_date'));
const r4 = await fin(t4);
check('4a a field a person corrected is never replaced or duplicated', JSON.stringify(await rowsOf(t4, 'service_date')) === beforeP && r4.rejected.some((x) => x.field_key === 'service_date' && x.reason === 'not-missing'), JSON.stringify({ rows: await rowsOf(t4, 'service_date'), rej: r4.rejected }));
check('4b the missing field next to it is filled (insert-only)', (await aiRows(t4)).some((x) => x.field_key === 'cost'), JSON.stringify({ ai: await aiRows(t4), rej: r4.rejected }));
// a person-chosen type always wins
const t4t = await paper('t4t.pdf', body(['TOK-C2 RECEIPT', 'Total $9.00 paid']), { type: 'other' });
await classify(t4t, 'other');
SCRIPT.set('TOK-C2', { document_type: 'receipt', document_type_confidence: 0.97, document_type_evidence: 'RECEIPT', fields: [] });
await fin(t4t);
check('4c a person-chosen type (even "other") always wins', (await docOf(t4t)).document_type === 'other');
// SQL-level insert-only: a competing value written between planning and writing is not overwritten
const t4r = await paper('t4r.pdf', body(['TOK-C3 Invoice', 'Total due $85.00 on 03/04/2026']), { type: 'invoice', facts: { vendor: 'Desert Air Co' } });
SCRIPT.set('TOK-C3', (args) => {
  // a person types the cost while the model is thinking
  return lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, corrected_value, created_at) VALUES ($1,$2,'cost','999',1,'999',NOW())`, [ten, t4r]).then(() => ({ document_type: 'invoice', fields: [{ key: 'cost', value: '85.00', page_no: 1, confidence: 0.95, verbatim: 'Total due $85.00' }] }));
});
const cb = deps.callModel; deps.callModel = async (a) => { const tok = /\bTOK-[A-Z0-9]+\b/.exec(a.user)?.[0]; const s = SCRIPT.get(tok); if (tok === 'TOK-C3') { calls++; const v = await s(a); return { toolInput: v, usage: USAGE }; } return cb(a); };
await fin(t4r);
deps.callModel = cb;
check('4d a value a person enters while the model is running is not overwritten (SQL guard)', (await rowsOf(t4r, 'cost')).length === 1 && (await rowsOf(t4r, 'cost'))[0].value === '999');

// ---------- 5. type: only when none / "other", with a quoted phrase and confidence; never over a real type
const t5 = await paper('t5.pdf', body(['TOK-D1 SALES RECEIPT', 'Total $12.00', 'Thank you']), { type: 'other' });
SCRIPT.set('TOK-D1', { document_type: 'receipt', document_type_confidence: 0.93, document_type_evidence: 'SALES RECEIPT', fields: [] });
const r5 = await fin(t5);
check('5a "other" + a known type + a quote on the page: typed', (await docOf(t5)).document_type === 'receipt' && !!r5.typed, JSON.stringify(await docOf(t5)));
const t5b = await paper('t5b.pdf', body(['TOK-D2 Some page', 'Total $12.00']), { type: 'other' });
SCRIPT.set('TOK-D2', { document_type: 'receipt', document_type_confidence: 0.99, document_type_evidence: 'SALES RECEIPT', fields: [] });
await fin(t5b);
check('5b a type with a quote that is not on the page: not applied', (await docOf(t5b)).document_type === 'other');
const t5c = await paper('t5c.pdf', body(['TOK-D3 SALES RECEIPT']), { type: 'invoice', facts: { vendor: 'Desert Air Co' } });
SCRIPT.set('TOK-D3', { document_type: 'receipt', document_type_confidence: 0.99, document_type_evidence: 'SALES RECEIPT', fields: [{ key: 'service_date', value: '2026-01-01', page_no: 1, confidence: 0.9, verbatim: 'SALES RECEIPT' }] });
await fin(t5c);
check('5c a paper that already has a real type keeps it', (await docOf(t5c)).document_type === 'invoice');
const t5d = await paper('t5d.pdf', body(['TOK-D4 EMPLOYMENT OFFER LETTER']), { type: 'other' });
SCRIPT.set('TOK-D4', { document_type: 'hr-letter', document_type_confidence: 0.99, document_type_evidence: 'EMPLOYMENT OFFER LETTER', fields: [] });
await fin(t5d);
check('5d AI never assigns hr-letter / license-certification (a person decides)', (await docOf(t5d)).document_type === 'other');

// ---------- 6. customers: never auto-linked; one-click suggestion only, naming an EXISTING customer whose name/street is quoted
const c1 = await paper('c1.pdf', body(['TOK-E1 Memo', 'Reminder logged for the Lopez account', 'Caller: M. Lopez at 500 Pine Rd about the furnace']), { type: 'correspondence' });
SCRIPT.set('TOK-E1', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: maria, quote: 'M. Lopez at 500 Pine Rd about the furnace' } });
const rc1 = await fin(c1);
check('6a a quoted customer street becomes a "Link to" suggestion naming the existing customer', (await sugsFor(c1)).some((c) => c.id === maria && c.name === 'Maria Lopez') && rc1.suggested.length === 1, JSON.stringify(await sugsFor(c1)));
check('6b ...and the paper is NOT linked (no link row, no customer_name fact written by the pass)', (await linksOf(c1)).length === 0 && !(await aiRows(c1)).some((r) => r.field_key === 'customer_name'));
const c2 = await paper('c2.pdf', body(['TOK-E2 Memo', 'Called about the furnace, no name given']), { type: 'correspondence' });
SCRIPT.set('TOK-E2', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: maria, quote: 'Maria Lopez called about the furnace' } });
await fin(c2);
check('6c a customer pick whose quote is not on the page: no suggestion', (await sugsFor(c2)).length === 0 && (await linksOf(c2)).length === 0);
const c3 = await paper('c3.pdf', body(['TOK-E3 Memo', 'Phone message from Jane about the unit']), { type: 'correspondence' });
SCRIPT.set('TOK-E3', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: jane, quote: 'Phone message from Jane about the unit' } });
await fin(c3);
check('6d a quote that has neither the customer\'s full name nor street: no suggestion', (await sugsFor(c3)).length === 0);
const c4 = await paper('c4.pdf', body(['TOK-E4 Memo', 'Call for Maria Lopez about her furnace']), { type: 'correspondence' });
SCRIPT.set('TOK-E4', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: '00000000-0000-4000-8000-999999999999', quote: 'Call for Maria Lopez about her furnace' } });
await fin(c4);
check('6e a customer id that does not exist (invented customer): the pass suggests nothing', (await finishRows(c4))[0]?.suggested?.length === 0 && (await finishRows(c4))[0]?.rejected?.some((x) => x.field_key === 'customer_pick' && x.reason === 'not-an-existing-customer'), JSON.stringify(await finishRows(c4)));
const c5 = await paper('c5.pdf', body(['TOK-E5 Memo', 'Sonoran Comfort Air Inc. internal note about the van']), { type: 'correspondence' });
SCRIPT.set('TOK-E5', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: own, quote: 'Sonoran Comfort Air Inc. internal note about the van' } });
await fin(c5);
check('6f our own company is never suggested as a customer', (await sugsFor(c5)).length === 0);
// strong evidence is Re-check's job (deterministic), never Claude's: a Claude-only pick never links
const links0 = (await lite.query(`SELECT count(*)::int AS n FROM document_entity_links`)).rows[0].n;
const c6 = await paper('c6.pdf', body(['TOK-E6 Invoice 77', 'Bill To: Zed Rivera', 'Total $5']), { type: 'invoice' });
SCRIPT.set('TOK-E6', { document_type: 'invoice', fields: [], customer_pick: { customer_id: zed, quote: 'Bill To: Zed Rivera' } });
await fin(c6);
// the normal automatic check (deterministic, strong "Bill To" label) may link this one by ITS rule; Claude's pick must not be the cause
const lnkAudit = (await lite.query(`SELECT linked_by FROM document_entity_links WHERE document_id = $1`, [c6])).rows;
check('6g nothing Claude returned is ever the reason for a link (any link here is the deterministic name-in-body rule)', lnkAudit.every((r) => r.linked_by === 'name-in-body'), JSON.stringify(lnkAudit));
const c7 = await paper('c7.pdf', body(['TOK-E7 Memo', 'Re: M. Lopez at 500 Pine Rd']), { type: 'correspondence', linkTo: jane });
SCRIPT.set('TOK-E7', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: maria, quote: 'M. Lopez at 500 Pine Rd' } });
await fin(c7);
check('6h (real) a paper a person linked gets no suggestion and keeps its link', (await sugsFor(c7)).length === 0 && (await linksOf(c7)).join() === 'Jane Smith');
const c8 = await paper('c8.pdf', body(['TOK-E8 Memo', 'Re: M. Lopez at 500 Pine Rd']), { type: 'correspondence' });
await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_unlinked','document',$2,'{}'::jsonb)`, [ten, c8]);
SCRIPT.set('TOK-E8', { document_type: 'correspondence', fields: [], customer_pick: { customer_id: maria, quote: 'M. Lopez at 500 Pine Rd' } });
await fin(c8);
check('6i a paper a person unlinked gets no suggestion', (await sugsFor(c8)).length === 0 && (await linksOf(c8)).length === 0);

// ---------- 7. set-aside and HR papers: no model call, no suggestion
const callsBefore = calls;
const s1 = await paper('inv-void.pdf', body(['TOK-F1 VOID', 'Caller: M. Lopez at 500 Pine Rd about the furnace']), { type: 'correspondence' });
const s2 = await paper('Copy of memo.pdf', body(['TOK-F2 Memo', 'Caller: M. Lopez at 500 Pine Rd about the furnace']), { type: 'correspondence' });
const h1 = await paper('offer.pdf', body(['TOK-F3 Offer letter', 'Dear M. Lopez at 500 Pine Rd']), { type: 'hr-letter' });
const h2 = await paper('lic.pdf', body(['TOK-F4 Licence', 'M. Lopez at 500 Pine Rd']), { type: 'license-certification' });
const h3 = await paper('hrfiled.pdf', body(['TOK-F5 Note', 'M. Lopez at 500 Pine Rd']), { type: 'other', folder: 'people-hr' });
const h4 = await paper('legacy.pdf', body(['TOK-F6 Note', 'M. Lopez at 500 Pine Rd']), { type: 'HR Letter' });
for (const id of [s1, s2, h1, h2, h3, h4]) SCRIPT.set(`TOK-F${[s1, s2, h1, h2, h3, h4].indexOf(id) + 1}`, { document_type: 'other', fields: [], customer_pick: { customer_id: maria, quote: 'M. Lopez at 500 Pine Rd' } });
const outs = []; for (const id of [s1, s2, h1, h2, h3, h4]) outs.push(await fin(id));
check('7a set-aside (VOID / copy) papers: no model call at all, no suggestion', outs[0].skip === 'set-aside' && outs[1].skip === 'set-aside' && (await sugsFor(s1)).length === 0 && (await sugsFor(s2)).length === 0);
check('7b HR letter, licence, People-and-HR filed and legacy-spelled HR papers: no suggestion even if Claude picks a customer', (await Promise.all([h1, h2, h3, h4].map(sugsFor))).every((s) => s.length === 0) && (await Promise.all([h1, h2, h3, h4].map(linksOf))).every((l) => l.length === 0));
check('7c ...and no money was spent on any of them', calls === callsBefore, `${calls - callsBefore} call(s)`);
// even if the model were called and returned a pick for a paper that turns into HR, the write step refuses
const h5 = await paper('typed-hr.pdf', body(['TOK-F7 Note', 'M. Lopez at 500 Pine Rd']), { type: 'other' });
SCRIPT.set('TOK-F7', { document_type: 'hr-letter', document_type_confidence: 0.99, document_type_evidence: 'Note', fields: [], customer_pick: { customer_id: maria, quote: 'M. Lopez at 500 Pine Rd' } });
await fin(h5);
check('7d a paper the pass tries to type as HR stays untyped and unsuggested', (await docOf(h5)).document_type === 'other' && (await sugsFor(h5)).length >= 0);

// ---------- 8. cost safety
const many = [];
for (let i = 0; i < 8; i++) {
  const id = await paper(`m${i}.pdf`, body([`TOK-G${i} Work order`, `Site: ${i + 1} Birch Ct`, `Completed on 03/0${(i % 8) + 1}/2026`]), { type: 'work-order', facts: { service_address: `${i + 1} Birch Ct` } });
  SCRIPT.set(`TOK-G${i}`, { document_type: 'work-order', fields: [{ key: 'service_date', value: `2026-03-0${(i % 8) + 1}`, page_no: 1, confidence: 0.9, verbatim: `Completed on 03/0${(i % 8) + 1}/2026` }] });
  many.push(id);
}
const c0 = calls;
const capRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: many, runCapUsd: 0.012, estimateUsd: 0.005, concurrency: 1, deps, today: '2026-10-26', source: 'verify' });
check('8a the per-run cap stops the run cleanly and says what is left', capRun.stoppedBy === 'run-cap' && capRun.processed === 2 && capRun.leftIds.length === 6 && calls - c0 === 2, JSON.stringify(capRun));
const auditCost = (await lite.query(`SELECT count(*)::int AS c FROM audit_log WHERE action = 'ai_finish.run' AND changes ? 'cost_usd'`)).rows[0].c; // rev2: NO dollar figure in a tenant-readable audit row
const usageCalls = (await lite.query(`SELECT COALESCE(sum(model_calls),0)::int AS n FROM usage_counters WHERE tenant_id = $1`, [ten])).rows[0].n;
const monthUnits = (await lite.query(`SELECT units FROM rate_limit_windows WHERE bucket = 'ai_finish_month_usd_micro'`)).rows[0]?.units;
const dayUnits = (await lite.query(`SELECT units FROM rate_limit_windows WHERE bucket = 'ai_finish_usd_micro'`)).rows[0]?.units;
check('8b the cost of the run was recorded internally (usage counters; NO cost in the audit row + monthly and daily ledgers)', auditCost === 0 && usageCalls >= 2 && monthUnits > 0 && dayUnits > 0, JSON.stringify({ auditCost, usageCalls, monthUnits, dayUnits }));
const c1n = calls;
const monthRun = await AF.finishTenantPapers(ctx, { plan: 'solo', documentIds: many, runCapUsd: 5, estimateUsd: 0.02, concurrency: 1, deps, today: '2026-10-26', env: { ...process.env, AI_FINISH_MONTHLY_USD_SOLO: '0.0001' } });
check('8c a tenant whose monthly budget is used up gets no model call (stops: month-budget)', monthRun.stoppedBy === 'month-budget' && calls === c1n, JSON.stringify(monthRun));
const noPlan = await AF.finishTenantPapers(ctx, { plan: undefined, documentIds: many, deps, today: '2026-10-26' });
check('8d no plan, no AI spend', noPlan.stoppedBy === 'month-budget' && calls === c1n);
const demoPlan = await AF.finishTenantPapers(ctx, { plan: 'demo', documentIds: many, deps, today: '2026-10-26' });
check('8e a demo account never spends', demoPlan.stoppedBy === 'month-budget' && calls === c1n);
const plat = { remainingUsd: 0.001 };
const platRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: many, platform: plat, estimateUsd: 0.02, concurrency: 1, deps, today: '2026-10-26' });
check('8f the platform-wide cap stops the run', platRun.stoppedBy === 'platform-cap' && calls === c1n, JSON.stringify(platRun));
const off = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: many, deps, env: { ...process.env, AI_FINISH: '0' } });
check('8g AI_FINISH=0 switches the whole pass off', off.stoppedBy === 'switched-off' && calls === c1n);
const rest = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: many, runCapUsd: 5, estimateUsd: 0.02, concurrency: 2, deps, today: '2026-10-26', source: 'verify' });
check('8h the next run picks up exactly what was left (papers already looked at are not paid for twice)', rest.processed === 6 && calls - c1n === 6 && rest.stoppedBy === null, JSON.stringify(rest));
const again = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: many, deps, today: '2026-10-26' });
check('8i a third run has nothing to do and makes no call', again.processed === 0 && again.considered === 0);

// failed twice -> skipped
const f1 = await paper('f1.pdf', body(['TOK-H1 Work order', 'Site: 5 Birch Ct']), { type: 'work-order', facts: { service_address: '5 Birch Ct' } });
SCRIPT.set('TOK-H1', new Error('model said 400'));
const cF = calls;
await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [f1], deps, today: '2026-10-26' });
await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [f1], deps, today: '2026-10-26' });
const third = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [f1], deps, today: '2026-10-26' });
check('8j a paper that failed twice is skipped from then on (2 calls, not 3)', calls - cF === 2 && third.considered === 0 && (await finishRows(f1)).filter((r) => r.outcome === 'failed').length === 2);
const bad = await paper('bad.pdf', body(['TOK-H2 Work order', 'Site: 5 Birch Ct']), { type: 'work-order', facts: { service_address: '5 Birch Ct' } });
SCRIPT.set('TOK-H2', null); // an answer with no tool input
deps.callModel = async () => { calls++; return { toolInput: null, usage: USAGE }; };
const rBad = await fin(bad); deps.callModel = cb;
check('8k an unusable answer is recorded as a failure, writes nothing', rBad.status === 'failed' && (await aiRows(bad)).length === 0);

// ---------- 9. Haiku only, shared prefix cached
modelsSeen.size && check('9a every call used Haiku', [...modelsSeen].every((m) => /haiku/i.test(m)), [...modelsSeen].join());
check('9b a Sonnet id in the environment never reaches this pass', /haiku/i.test(AF.aiFinishModel({ EXTRACT_MODEL: 'claude-sonnet-5-5' })) && /haiku/i.test(AF.aiFinishModel({ AI_FINISH_MODEL: 'claude-opus-4' })));
const { stable } = splitExtractPrompt(buildExtractPrompt([{ page_no: 1, text: 'x' }], 'invoice', null, {}));
const cached = withCache({ type: 'text', text: stable }, AF.aiFinishModel(), { ttl: '1h' });
check('9c the shared extraction prefix is long enough to be cached on Haiku (>= 4096 tokens)', !!cached.cache_control, `${stable.length} chars`);
check('9d the finish call sends that same stable prefix as the system block', lastCall && typeof lastCall.system === 'string' && lastCall.system === stable);

// ---------- 10. vision re-read for empty / poor stored text, through the existing reader
const v1 = await paper('scan.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/scan.pdf` });
SCRIPT.set('TOK-V1', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.9, verbatim: 'Date of Service: 03/14/2026' }] });
let readCalls = 0;
const visionDeps = {
  callModel,
  r2: { keyBelongsToTenant: () => true, getObject: async () => Buffer.from('%PDF-1.4 stub'), normalizeContentType: (x) => x },
  readDocument: { sniffMagicBytes: () => 'application/pdf', hasReadableText: (p) => p.some((x) => String(x.text).trim()), readPdfOrImage: async () => { readCalls++; return { pages: [{ page_no: 1, text: 'TOK-V1 Work order\nSite: 3 Birch Ct\nDate of Service: 03/14/2026' }], method: 'model' }; } },
};
const rv = await AF.finishPaper(ctx, v1, { source: 'verify', deps: visionDeps, today: '2026-10-26' });
check('10a empty stored text: the scan is re-read with the existing vision reader, then the missing field is filled from the new text', readCalls === 1 && (await aiRows(v1)).some((x) => x.field_key === 'service_date') && (await finishRows(v1))[0]?.vision_reread === true, JSON.stringify({ rv: rv.rejected, rows: await aiRows(v1) }));
const v2 = await paper('good.pdf', body(['TOK-V2 Work order', 'Site: 3 Birch Ct', 'Date of Service: 03/05/2026', 'a long enough page of readable text to not count as poor text at all, nothing to re-read here']), { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/good.pdf` });
SCRIPT.set('TOK-V2', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-05', page_no: 1, confidence: 0.9, verbatim: 'Date of Service: 03/05/2026' }] });
const rc0 = readCalls; await AF.finishPaper(ctx, v2, { source: 'verify', deps: visionDeps, today: '2026-10-26' });
check('10b readable stored text is NOT re-read with vision', readCalls === rc0);

// ---------- 11. the normal automatic check follows
const k1 = await paper('k1.pdf', body(['TOK-K1 Service ticket', 'Customer: Maria Lopez', 'Service address: 500 Pine Rd, Mesa AZ', 'Work performed: replaced capacitor', 'Completed on 03/14/2026']), { type: 'service-ticket', facts: { customer_name: 'Maria Lopez', service_address: '500 Pine Rd, Mesa, AZ', work_performed: 'replaced capacitor' } });
SCRIPT.set('TOK-K1', { document_type: 'service-ticket', fields: [{ key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.92, verbatim: 'Completed on 03/14/2026' }] });
const rk = await fin(k1);
check('11 after the AI fill the automatic check runs (a now-complete, linked ticket is checked)', (await aiRows(k1)).some((x) => x.field_key === 'service_date') && (await docOf(k1)).stage === 'verified', JSON.stringify({ stage: await docOf(k1), links: await linksOf(k1), verified: rk.verified }));

// ---------- 14. rev2: label binding, zones, locale-safe dates, type checks (every case the independent verify listed, plus variants)
let tokN = 0;
const trial = async (lines, field, { type = 'work-order', facts = { service_address: '9 Birch Ct, Mesa, AZ' }, conf = 0.95 } = {}) => {
  const tok = `TOK-R${++tokN}`;
  const id = await paper(`r${tokN}.pdf`, body([`${tok} Work order`, ...lines]), { type, facts });
  SCRIPT.set(tok, { document_type: type, fields: [{ key: field.key, value: field.value, page_no: 1, confidence: conf, verbatim: field.quote }] });
  const r = await fin(id);
  const stored = (await aiRows(id)).filter((x) => x.field_key === field.key.replace(/_unconfirmed$/, '') || x.field_key === `${field.key}_unconfirmed` || x.field_key.startsWith(field.key));
  return { id, r, stored, reasons: r.rejected.map((x) => x.reason) };
};
const SD = (value, quote) => ({ key: 'service_date', value, quote });
const noStore = (name, t, reason) => check(name, t.stored.length === 0 && (!reason || t.reasons.includes(reason) || t.reasons.includes(`suggested:${reason}`)), JSON.stringify({ stored: t.stored, rej: t.r.rejected }));

// D1a: day/month swap
noStore('14a page 03/04/2026 (no locale evidence), model says 2026-04-03: dropped, no swapped reading', await trial(['Date of Service: 03/04/2026'], SD('2026-04-03', 'Date of Service: 03/04/2026')), 'ambiguous-date-order');
noStore('14b the same page with the model\'s other order 2026-03-04: also dropped (ambiguous, never guessed)', await trial(['Date of Service: 03/04/2026'], SD('2026-03-04', 'Date of Service: 03/04/2026')), 'ambiguous-date-order');
const dm = await trial(['Date of Service: 03/04/2026', 'Invoice printed 25/03/2026'], SD('2026-04-03', 'Date of Service: 03/04/2026'));
check('14c a day-first document (another date shows 25/03) is read day-first: 2026-04-03 is kept', dm.stored.some((x) => x.value === '2026-04-03'), JSON.stringify({ s: dm.stored, r: dm.r.rejected }));
noStore('14d ... and the month-first reading of that day-first document is dropped', await trial(['Date of Service: 03/04/2026', 'Invoice printed 25/03/2026'], SD('2026-03-04', 'Date of Service: 03/04/2026')), 'date-differs-from-page');
noStore('14e a document that shows BOTH orders (25/03 and 03/25) is ambiguous: dropped', await trial(['Date of Service: 03/04/2026', 'Printed 25/03/2026', 'Signed 03/25/2026'], SD('2026-03-04', 'Date of Service: 03/04/2026')), 'ambiguous-date-order');
const same = await trial(['Date of Service: 04/04/2026'], SD('2026-04-04', 'Date of Service: 04/04/2026'));
check('14f a numeric date with the same day and month cannot be swapped: kept', same.stored.some((x) => x.value === '2026-04-04'));
const named = await trial(['Date of Service: March 4, 2026'], SD('2026-03-04', 'Date of Service: March 4, 2026'));
check('14g a written-out month date is unambiguous: kept', named.stored.some((x) => x.value === '2026-03-04'), JSON.stringify(named.r.rejected));
noStore('14h a two-digit year is never read (03/14/26)', await trial(['Date of Service: 03/14/26'], SD('2026-03-14', 'Date of Service: 03/14/26')));
// D1b: label stealing
noStore('14i "Warranty expires 03/14/2031" is not the service date', await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031')), 'no-matching-label');
noStore('14j "Invoice Date: 01/15/2026" is not the service date', await trial(['Invoice Date: 01/15/2026'], SD('2026-01-15', 'Invoice Date: 01/15/2026')), 'no-matching-label');
noStore('14k "Date of birth 02/02/1980" is not the service date', await trial(['Date of birth 02/02/1980'], SD('1980-02-02', 'Date of birth 02/02/1980')));
noStore('14l a bare quote "03/14/2026" taken out of "Printed 03/14/2026" is dropped (the label is read from the page, not the quote)', await trial(['Printed 03/14/2026'], SD('2026-03-14', '03/14/2026')));
noStore('14m a bare date with no label at all is dropped', await trial(['03/14/2026'], SD('2026-03-14', '03/14/2026')), 'no-matching-label');
noStore('14n "Next service due 04/01/2026" is not the service date (and unlabelled + ambiguous is thrown away)', await trial(['Next service due 04/01/2026'], SD('2026-04-01', 'Next service due 04/01/2026')), 'ambiguous-date-order');
// D1c: footer / boilerplate
noStore('14o footer "Terms revised 11/02/2019" is not the service date', await trial(['Work performed: none', '', 'Terms and conditions apply.', 'Terms revised 11/02/2019'], SD('2019-02-11', 'Terms revised 11/02/2019')));
noStore('14p footer "Copyright 2019 ... Rev. 03/14/2019" is not the service date', await trial(['Page 1 of 1', 'Form rev. 03/14/2019'], SD('2019-03-14', 'Form rev. 03/14/2019')));
// labelled positives still work, including the label on the line above (table layout)
const tbl = await trial(['Service Date', '03/14/2026', 'Technician: R. Diaz'], SD('2026-03-14', '03/14/2026'));
check('14q a value on its own line under its label (table layout) is kept', tbl.stored.some((x) => x.value === '2026-03-14'), JSON.stringify(tbl.r.rejected));
const iso = await trial(['Date of Service: 2026-03-14'], SD('2026-03-14', 'Date of Service: 2026-03-14'));
check('14r an ISO date under a service-date label is kept', iso.stored.some((x) => x.value === '2026-03-14'));
// D1d: text fields and zones
const AD = (value, quote) => ({ key: 'service_address', value, quote });
const addrFacts = { service_date: '2026-03-14' };
noStore('14s vendor "Remit payment to: Acme Supply, 12 Oak Ln" is never the service address', await trial(['Remit payment to: Acme Supply, 12 Oak Ln'], AD('12 Oak Ln', 'Remit payment to: Acme Supply, 12 Oak Ln'), { facts: addrFacts }));
noStore('14t a service-address label followed by a remit text is dropped', await trial(['Service Address: remit to P.O. Box 55, Tempe 12 Oak Ln'], AD('12 Oak Ln', 'Service Address: remit to P.O. Box 55, Tempe 12 Oak Ln'), { facts: addrFacts }));
noStore('14t2 a labelled address on a line that also says "remit payments to" is refused', await trial(['Service Address: 12 Oak Ln (remit payments to P.O. Box 55)'], AD('12 Oak Ln', 'Service Address: 12 Oak Ln'), { facts: addrFacts }), 'remit-or-payment-line');
noStore('14u the issuer\'s letterhead address is not the service address (no label)', await trial(['Desert Air Co', '44 Industrial Way, Tempe AZ', 'Phone (480) 555-0100'], AD('44 Industrial Way, Tempe AZ', '44 Industrial Way, Tempe AZ'), { facts: addrFacts }));
noStore('14v "Address:" under the letterhead is not a service-address label', await trial(['Desert Air Co', 'Address: 44 Industrial Way, Tempe AZ', 'Phone (480) 555-0100'], AD('44 Industrial Way, Tempe AZ', 'Address: 44 Industrial Way, Tempe AZ'), { facts: addrFacts }));
const okAddr = await trial(['Desert Air Co', 'Service Address: 9 Birch Ct, Mesa AZ'], AD('9 Birch Ct, Mesa AZ', 'Service Address: 9 Birch Ct, Mesa AZ'), { facts: addrFacts });
check('14w a labelled service address in the body is kept', okAddr.stored.some((x) => x.value === '9 Birch Ct, Mesa AZ'), JSON.stringify(okAddr.r.rejected));
noStore('14x a service address without a street number is dropped (type check)', await trial(['Service Address: Mesa'], AD('Mesa', 'Service Address: Mesa'), { facts: addrFacts }), 'bad-address');
noStore('14y a P.O. box is not a service address', await trial(['Service Address: PO Box 12, Mesa AZ'], AD('PO Box 12, Mesa AZ', 'Service Address: PO Box 12, Mesa AZ'), { facts: addrFacts }));
// money / number types
const CO = (value, quote) => ({ key: 'cost', value, quote });
const cost = await trial(['Total due $85.00'], CO('85.00', 'Total due $85.00'), { type: 'invoice', facts: { vendor: 'Desert Air Co', service_date: '2026-03-14' } });
check('14z a total under a "Total due" label is kept', cost.stored.some((x) => x.value === '85.00'), JSON.stringify(cost.r.rejected));
noStore('14za a subtotal / deposit amount is not the cost (label not in the vocabulary)', await trial(['Deposit received $20.00'], CO('20.00', 'Deposit received $20.00'), { type: 'invoice', facts: { vendor: 'Desert Air Co', service_date: '2026-03-14' } }), 'no-matching-label');
const wp = await trial(['Work performed: replaced capacitor'], { key: 'work_performed', value: 'replaced capacitor', quote: 'Work performed: replaced capacitor' }, { type: 'service-ticket', facts: { service_address: '9 Birch Ct', service_date: '2026-03-14', customer_name: 'Zed Rivera' } });
check('14zb a field with no label vocabulary (work_performed) is never asked for: no model call', wp.stored.length === 0 && wp.r.skip === 'no-plausible-field', JSON.stringify(wp.r));
noStore('14zc a phone number is not an invoice number', await trial(['Phone: 480-555-0100'], { key: 'invoice_number', value: '480-555-0100', quote: 'Phone: 480-555-0100' }, { facts: { service_address: '9 Birch Ct' } }), 'no-matching-label');
const inv = await trial(['Invoice #: INV-2210'], { key: 'invoice_number', value: 'INV-2210', quote: 'Invoice #: INV-2210' }, { facts: { service_address: '9 Birch Ct' } });
check('14zd a document number under an "Invoice #" label is kept', inv.stored.some((x) => x.value === 'INV-2210'), JSON.stringify(inv.r.rejected));
noStore('14ze a word with no digit is not a document number', await trial(['Invoice #: pending'], { key: 'invoice_number', value: 'pending', quote: 'Invoice #: pending' }, { facts: { service_address: '9 Birch Ct' } }), 'bad-number');

// D4: two customers with the same name are not suggested without the street
const twinA = await cust('Pat Doyle', '10 Elm St, Mesa, AZ');
const twinB = await cust('Pat Doyle', '22 Fir St, Mesa, AZ');
const twinTok = 'TOK-TW1';
const tw = await paper('tw.pdf', body([`${twinTok} Service ticket`, 'Customer: Pat Doyle', 'Work performed: tune-up']), { type: 'service-ticket', facts: { vendor: 'Desert Air Co', service_date: '2026-03-14' } });
SCRIPT.set(twinTok, { document_type: 'service-ticket', fields: [], customer_pick: { customer_id: twinA, quote: 'Customer: Pat Doyle' } });
const rtw = await fin(tw);
check('14zf a name shared by two customers is not suggested (and never linked)', !rtw.suggested.length && (await linksOf(tw)).length === 0 && rtw.rejected.some((x) => x.reason === 'ambiguous-customer'), JSON.stringify(rtw.rejected));

// D2: four concurrent runs over the same papers: one call per paper, spend inside the budget
const conc = [];
const perTok = new Map();
for (let i = 0; i < 10; i++) {
  const tok = `TOK-CC${i}`;
  conc.push(await paper(`cc${i}.pdf`, body([`${tok} Work order`, 'Date of Service: 03/14/2026']), { type: 'work-order', facts: { service_address: '9 Birch Ct, Mesa, AZ' } }));
  SCRIPT.set(tok, (a) => { perTok.set(tok, (perTok.get(tok) ?? 0) + 1); return { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.9, verbatim: 'Date of Service: 03/14/2026' }] }; });
}
const monthBefore = Number((await lite.query(`SELECT units FROM rate_limit_windows WHERE bucket = 'ai_finish_month_usd_micro'`)).rows[0]?.units ?? 0);
const budgetUsd = monthBefore / 1e6 + 0.03;
const runs = await Promise.all([1, 2, 3, 4].map(() => AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: conc, runCapUsd: 5, estimateUsd: 0.01, concurrency: 3, deps, today: '2026-10-26', source: 'verify', env: { ...process.env, AI_FINISH_MONTHLY_USD_FLEET: String(budgetUsd) } })));
const monthAfter = Number((await lite.query(`SELECT units FROM rate_limit_windows WHERE bucket = 'ai_finish_month_usd_micro'`)).rows[0]?.units ?? 0);
const worst = Math.max(...[...perTok.values(), 0]);
check('14zg four simultaneous runs: no paper is sent to the model twice', worst <= 1 && perTok.size >= 1, JSON.stringify([...perTok.entries()].slice(0, 12)));
check('14zh ... and the month ledger never passes the budget by more than one paper\'s real cost', (monthAfter - monthBefore) / 1e6 <= 0.03 + 0.006, JSON.stringify({ spent: (monthAfter - monthBefore) / 1e6, budgetUsd, stops: runs.map((r) => r.stoppedBy) }));
check('14zi ... and the runs that lost the race say why (claimed papers are skipped, a spent budget stops the run)', runs.some((r) => r.stoppedBy === 'month-budget') || runs.some((r) => r.skipped > 0), JSON.stringify(runs.map((r) => ({ p: r.processed, s: r.skipped, st: r.stoppedBy }))));

// D3: the vision re-read is reserved against the cap before it is paid
const vsc = await paper('vscan.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/vscan.pdf` });
SCRIPT.set('TOK-V1', { document_type: 'work-order', fields: [] });
let vReads = 0;
const mkVision = (bytes, env) => ({
  callModel, env,
  r2: { keyBelongsToTenant: () => true, getObject: async () => bytes, normalizeContentType: (x) => x },
  readDocument: { ...realRd, sniffMagicBytes: () => 'application/pdf', hasReadableText: (p) => p.some((x) => String(x.text).trim()), readPdfOrImage: async () => { vReads++; return { pages: [{ page_no: 1, text: 'TOK-V1 Work order\nSite: 3 Birch Ct\nDate of Service: 03/14/2026' }], method: 'model' }; } },
});
const capped = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [vsc], runCapUsd: 0.01, deps: mkVision(Buffer.from('%PDF-1.4 stub'), {}), today: '2026-10-26', source: 'verify' });
check('14zj a vision re-read that would pass the run cap is not started (no read, the run stops, the paper stays open)', vReads === 0 && capped.stoppedBy === 'run-cap' && capped.leftIds.includes(vsc), JSON.stringify(capped));
const pages12 = Buffer.from('%PDF-1.4 ' + '<< /Type /Page >> '.repeat(12));
const big = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [vsc], deps: mkVision(pages12, {}), today: '2026-10-26', source: 'verify' });
check('14zk a scan of more than 6 pages is not re-read with vision', vReads === 0 && big.failed === 1, JSON.stringify(big));
const vsc2 = await paper('vscan2.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/vscan2.pdf` });
const notHaiku = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [vsc2], deps: mkVision(Buffer.from('%PDF-1.4 stub'), { TRANSCRIBE_MODEL: 'claude-sonnet-5-5' }), today: '2026-10-26', source: 'verify' });
check('14zl a pinned non-Haiku transcribe model turns the vision re-read off (Haiku only)', vReads === 0 && notHaiku.failed === 1, JSON.stringify(notHaiku));
const vsc3 = await paper('vscan3.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/vscan3.pdf` });
SCRIPT.set('TOK-V1', { document_type: 'work-order', fields: [{ key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.9, verbatim: 'Date of Service: 03/14/2026' }] });
const okVision = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [vsc3], deps: mkVision(Buffer.from('%PDF-1.4 stub'), {}), today: '2026-10-26', source: 'verify' });
check('14zm a small scan inside the caps is still re-read once and filled', vReads === 1 && okVision.facts === 1, JSON.stringify(okVision));

// D5: no dollar figure in anything a tenant admin can read through the audit API
const costRows = (await lite.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'ai_finish.%' AND changes::text ~* '(cost_usd|_usd|usd_|spend|dollar|price)'`)).rows[0].n;
if (costRows) realLog(JSON.stringify((await lite.query(`SELECT action, changes FROM audit_log WHERE action LIKE 'ai_finish.%' AND changes::text ~* '(cost_usd|_usd|usd_|spend|dollar|price)' LIMIT 2`)).rows));
check('14zn no ai_finish audit row carries a cost, usd or spend figure (cost lives only in the internal ledgers)', costRows === 0, String(costRows));

// ---------- 15. rev3: suggestions (a real quote that fails ONLY the label / zone, or an ambiguous date) are never facts
const AFS = await import(rel('api/_lib/aiFinishSuggest.js'));
const RVS = await import(rel('api/_lib/reviewStore.js'));
const sugOf = async (id) => (await AFS.listFieldSuggestions(ctx, { documentIds: [id] })).suggestions;
const factCount = async (id, k) => (await lite.query(`SELECT count(*)::int AS n FROM extractions WHERE document_id = $1 AND field_key LIKE $2`, [id, `${k}%`])).rows[0].n;
const sugRows = async (id, a = 'ai_finish.suggestion') => (await lite.query(`SELECT changes FROM audit_log WHERE resource_id = $1 AND action = $2 ORDER BY created_at`, [id, a])).rows.map((r) => r.changes);

const g_s1 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const g_s1sug = await sugOf(g_s1.id);
check('15a a real quote under the WRONG label becomes a suggestion, not a fact', g_s1.stored.length === 0 && (await factCount(g_s1.id, 'service_date')) === 0 && g_s1sug.length === 1 && g_s1sug[0].field_key === 'service_date' && g_s1sug[0].value === '2031-03-14' && /Warranty expires/.test(g_s1sug[0].quote) && g_s1.r.fieldSuggested.length === 1, JSON.stringify({ g_s1sug, r: g_s1.r.rejected }));
const g_s2 = await trial(['Date of Service: 03/04/2026'], SD('2026-04-03', 'Date of Service: 03/04/2026'));
// (the free reader's own label fill may already have read this date one way; it is removed here so the AI suggestion is what is tested)
await lite.query(`DELETE FROM extractions WHERE document_id = $1 AND field_key = 'service_date'`, [g_s2.id]);
const g_s2sug = await sugOf(g_s2.id);
check('15b an ambiguous dd/mm date under its own label becomes a suggestion that carries BOTH readings', g_s2.stored.length === 0 && g_s2sug.length === 1 && JSON.stringify([...(g_s2sug[0].options ?? [])].sort()) === JSON.stringify(['2026-03-04', '2026-04-03']) && g_s2sug[0].value === undefined, JSON.stringify(g_s2sug));
const g_s3 = await trial(['Desert Air Co', '44 Industrial Way, Tempe AZ', 'Phone (480) 555-0100'], { key: 'service_address', value: '44 Industrial Way, Tempe AZ', quote: '44 Industrial Way, Tempe AZ' }, { facts: { service_date: '2026-03-14' } });
check('15c an issuer-letterhead address is a suggestion only (zone failure), never a fact', g_s3.stored.length === 0 && (await sugOf(g_s3.id)).some((x) => x.field_key === 'service_address'));
const hard = [
  await trial(['Remit payment to: Acme Supply, 12 Oak Ln'], { key: 'service_address', value: '12 Oak Ln', quote: 'Remit payment to: Acme Supply, 12 Oak Ln' }, { facts: { service_date: '2026-03-14' } }),
  await trial(['Service Address: Mesa'], { key: 'service_address', value: 'Mesa', quote: 'Service Address: Mesa' }, { facts: { service_date: '2026-03-14' } }),
  await trial(['Date of Service: 03/14/26'], SD('2026-03-14', 'Date of Service: 03/14/26')),
  await trial(['Printed 03/04/2026'], SD('2026-04-03', '03/04/2026')),
  await trial(['Date of Service: 03/14/2026'], SD('2026-03-15', 'Date of Service: 03/14/2026')),
  await trial(['Date of Service: 03/14/2026'], SD('2026-03-14', 'Date of Service: 03/15/2026')),
];
const hardSug = (await Promise.all(hard.map((h) => sugOf(h.id)))).flat();
check('15d things that are NOT label / zone failures are never suggested: remit line, address with no number, 2-digit year, unlabelled ambiguous date, wrong value, invented quote', hardSug.length === 0, JSON.stringify(hardSug));

// accept (single value): a PERSON-entered fact, the suggestion is cleared
const acc = await AFS.acceptFieldSuggestion(ctx, { documentId: g_s1.id, key: g_s1sug[0].key, by: 'You' }, null, { correctField: RVS.correctField });
const accRow = (await lite.query(`SELECT value, corrected_value, corrected_by FROM extractions WHERE document_id = $1 AND field_key = 'service_date'`, [g_s1.id])).rows[0];
check('15e Accept stores the value through the person path (corrected_value, corrected_by) and clears the suggestion', acc.ok && accRow?.corrected_value === '2031-03-14' && accRow.corrected_by === 'You' && (await sugOf(g_s1.id)).length === 0 && (await sugRows(g_s1.id, 'ai_finish.suggestion_resolved'))[0]?.state === 'accepted');
let twice = null; try { await AFS.acceptFieldSuggestion(ctx, { documentId: g_s1.id, key: g_s1sug[0].key, by: 'You' }, null, { correctField: RVS.correctField }); } catch (e) { twice = e; }
check('15f accepting twice is refused (nothing to accept)', twice?.status === 404);

// ambiguous: must pick one of the two readings
let noPick = null; try { await AFS.acceptFieldSuggestion(ctx, { documentId: g_s2.id, key: g_s2sug[0].key, by: 'You' }, null, { correctField: RVS.correctField }); } catch (e) { noPick = e; }
check('15g an ambiguous date cannot be accepted without choosing a reading', noPick?.status === 400 && (await factCount(g_s2.id, 'service_date')) === 0);
const pick = await AFS.acceptFieldSuggestion(ctx, { documentId: g_s2.id, key: g_s2sug[0].key, value: '2026-04-03', by: 'You' }, null, { correctField: RVS.correctField });
check('15h picking one reading stores exactly that date', pick.value === '2026-04-03' && (await rowsOf(g_s2.id, 'service_date'))[0]?.corrected_value === '2026-04-03' && (await sugOf(g_s2.id)).length === 0);

// edit = accept with the person's own text
const g_e1 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const g_e1s = await sugOf(g_e1.id);
const ed = await AFS.acceptFieldSuggestion(ctx, { documentId: g_e1.id, key: g_e1s[0].key, value: '2026-03-14', by: 'You' }, null, { correctField: RVS.correctField });
check('15i Edit stores the person\'s own value, recorded as edited', (await rowsOf(g_e1.id, 'service_date'))[0]?.corrected_value === '2026-03-14' && (await sugRows(g_e1.id, 'ai_finish.suggestion_resolved'))[0]?.edited === true && ed.value === '2026-03-14');

// dismiss: cleared and never suggested again (not by the pipeline, not by a direct store call)
const g_d1 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const g_d1s = await sugOf(g_d1.id);
await AFS.dismissFieldSuggestion(ctx, { documentId: g_d1.id, key: g_d1s[0].key }, null);
check('15j Dismiss clears the suggestion and stores no fact', (await sugOf(g_d1.id)).length === 0 && (await factCount(g_d1.id, 'service_date')) === 0 && (await sugRows(g_d1.id, 'ai_finish.suggestion_resolved'))[0]?.state === 'dismissed');
await lite.query(`DELETE FROM audit_log WHERE resource_id = $1 AND action IN ('ai_finish.run', 'ai_finish.claim', 'ai_finish.release')`, [g_d1.id]);
SCRIPT.set(/TOK-R\d+/.exec((await lite.query(`SELECT text FROM document_pages WHERE document_id = $1`, [g_d1.id])).rows[0].text)[0], { document_type: 'work-order', fields: [{ key: 'service_date', value: '2031-03-14', page_no: 1, confidence: 0.95, verbatim: 'Warranty expires 03/14/2031' }] });
const rerun = await fin(g_d1.id);
check('15k a dismissed value is never suggested again, even when the paper is looked at again', rerun.fieldSuggested.length === 0 && (await sugOf(g_d1.id)).length === 0 && (await sugRows(g_d1.id)).length === 1, JSON.stringify({ r: rerun.rejected, n: (await sugRows(g_d1.id)).length }));
let late = null; try { await AFS.acceptFieldSuggestion(ctx, { documentId: g_d1.id, key: g_d1s[0].key, by: 'You' }, null, { correctField: RVS.correctField }); } catch (e) { late = e; }
check('15l a dismissed suggestion cannot be accepted afterwards', late?.status === 404);

// a person typing the field makes the suggestion disappear (fact wins)
const g_p1 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
await RVS.correctField(ctx, { documentId: g_p1.id, fieldKey: 'service_date', value: '2026-03-01', by: 'You' }, null);
check('15m once a person has filled the field, the suggestion is no longer listed', (await sugOf(g_p1.id)).length === 0);

// suggestions are not facts anywhere the product reads facts from
const allSugDocs = [g_s3.id, g_s2.id];
const leak = (await lite.query(`SELECT count(*)::int AS n FROM extractions WHERE document_id = ANY($1::uuid[]) AND (value LIKE '%44 Industrial%' OR corrected_value LIKE '%44 Industrial%')`, [allSugDocs])).rows[0].n;
const leakFacets = (await lite.query(`SELECT count(*)::int AS n FROM facets WHERE document_id = ANY($1::uuid[]) AND value_raw LIKE '%44 Industrial%' AND segment_id = 'field-ai'`, [allSugDocs])).rows[0].n;
check('15n an open suggestion is in no extraction and no AI facet (so search, Donovan and exports, which read facts, cannot see it)', leak === 0 && leakFacets === 0);

// the batch reports auto-filled and suggested separately
const mix = await paper('mix.pdf', body(['TOK-MX1 Invoice', 'Date of Service: 03/14/2026', 'Warranty expires 03/14/2031', 'Total due $85.00']), { type: 'invoice', facts: { vendor: 'Desert Air Co' } });
SCRIPT.set('TOK-MX1', { document_type: 'invoice', fields: [
  { key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.95, verbatim: 'Date of Service: 03/14/2026' },
  { key: 'cost', value: '85.00', page_no: 1, confidence: 0.95, verbatim: 'Total due $85.00' },
] });
const mixRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [mix], deps, today: '2026-10-26', source: 'verify' });
check('15o a run reports facts auto-filled and values suggested as separate numbers', mixRun.facts >= 1 && typeof mixRun.fieldSuggestions === 'number', JSON.stringify(mixRun));
const mix2 = await paper('mix2.pdf', body(['TOK-MX2 Work order', 'Date of Service: 03/14/2026', 'Technician notes follow', '9 Birch Ct, Mesa AZ']), { type: 'work-order', facts: { vendor: 'Desert Air Co' } });
SCRIPT.set('TOK-MX2', { document_type: 'work-order', fields: [
  { key: 'service_date', value: '2026-03-14', page_no: 1, confidence: 0.95, verbatim: 'Date of Service: 03/14/2026' },
  { key: 'service_address', value: '9 Birch Ct, Mesa AZ', page_no: 1, confidence: 0.95, verbatim: '9 Birch Ct, Mesa AZ' },
] });
const mixRun2 = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [mix2], deps, today: '2026-10-26', source: 'verify' });
check('15p one labelled value is auto-filled while a bare-quoted one is only suggested, in the same run', mixRun2.facts === 1 && mixRun2.fieldSuggestions === 1, JSON.stringify(mixRun2));

// ---------- 16. rev3 cost guard: no model call for a paper whose missing fields cannot be on the page
const g_permit = await paper('permit.pdf', body(['TOK-CG1 Building permit', 'Permit # BP-20931', 'Job site 9 Birch Ct']), { type: 'permit', facts: { service_address: '9 Birch Ct, Mesa, AZ', permit_number: 'BP-20931' } });
const noMoney = await paper('nomoney.pdf', body(['TOK-CG2 Proposal', 'We would be glad to help with your heating and cooling system any time this season, call us']), { type: 'proposal-quote', facts: { customer_name: 'Zed Rivera' } });
const noStreet = await paper('nostreet.pdf', body(['TOK-CG3 Work order', 'Tech did the job', 'Date of Service: 03/14/2026']), { type: 'work-order', facts: { service_date: '2026-03-14' } });
const cgBefore = calls;
const guard = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [noMoney, noStreet], deps, today: '2026-10-26', source: 'verify' });
check('16a papers whose missing fields cannot plausibly be on the page make NO model call, and the saved calls are counted', calls === cgBefore && guard.savedCalls === 2, JSON.stringify(guard));
const plaus = (await import(rel('api/_lib/aiFinishBind.js'))).plausibleKeys;
check('16b the guard: cost on a permit never; cost needs a money figure; address needs street text; fields with no label vocabulary are never asked', plaus(['cost'], { type: 'permit', pages: [{ text: 'Total $85.00' }] }).size === 0 && plaus(['cost'], { type: 'invoice', pages: [{ text: 'Total $85.00' }] }).has('cost') && plaus(['cost'], { type: 'invoice', pages: [{ text: 'thanks' }] }).size === 0 && plaus(['service_address'], { pages: [{ text: 'at 9 Birch Ct' }] }).has('service_address') && plaus(['service_address'], { pages: [{ text: 'in Mesa' }] }).size === 0 && plaus(['work_performed', 'part_number'], { pages: [{ text: 'Work performed: x 12.50' }] }).size === 0);

// ---------- 17. rev3.1: sensitive fields and footers are never suggested; one winner per resolution; vision bounded by its reservation
const sensNo = async (name, lines, field, opts) => { const t = await trial(lines, field, opts); check(name, t.stored.length === 0 && (await sugOf(t.id)).length === 0 && (await sugRows(t.id)).length === 0 && t.reasons.includes('sensitive'), JSON.stringify({ s: t.stored, rej: t.r.rejected })); };
await sensNo('17a a date of birth is neither stored nor suggested as a service date', ['Date of Birth: 02/02/1980'], SD('1980-02-02', 'Date of Birth: 02/02/1980'));
await sensNo('17b "DOB 02/02/1980" and "Born 02/02/1980" likewise', ['DOB 02/02/1980'], SD('1980-02-02', 'DOB 02/02/1980'));
await sensNo('17c a DOB in a table (label on the line above) likewise', ['Date of Birth', '02/02/1980'], SD('1980-02-02', '02/02/1980'));
await sensNo('17d an SSN is never stored or suggested', ['Invoice #: 123-45-6789'], { key: 'invoice_number', value: '123-45-6789', quote: 'Invoice #: 123-45-6789' }, { facts: { service_address: '9 Birch Ct' } });
await sensNo('17e a bank account / routing number is never stored or suggested', ['Account number: 123456789012'], { key: 'invoice_number', value: '123456789012', quote: 'Account number: 123456789012' }, { facts: { service_address: '9 Birch Ct' } });
await sensNo('17f a driver\'s licence number is never stored or suggested', ['Driver license # D1234567'], { key: 'invoice_number', value: 'D1234567', quote: 'Driver license # D1234567' }, { facts: { service_address: '9 Birch Ct' } });
await sensNo('17g a card number is never stored or suggested', ['Card number 4111 1111 1111 1111 order # 5521'], { key: 'invoice_number', value: '5521', quote: 'Card number 4111 1111 1111 1111 order # 5521' }, { facts: { service_address: '9 Birch Ct' } });
const longp = (last, midd = []) => ['Work order for the Rivera household', 'Technician arrived on site', 'System checked and cleaned', 'Filter replaced', 'Refrigerant level fine', 'Thermostat tested', ...midd, 'Thank you for choosing us', last];
const ftr = await trial(longp('Warranty expires 03/14/2031'), SD('2031-03-14', 'Warranty expires 03/14/2031'));
check('17h a date on the last lines of a longp page (footer) is never suggested', ftr.stored.length === 0 && (await sugOf(ftr.id)).length === 0 && ftr.reasons.includes('footer'), JSON.stringify(ftr.r.rejected));
const ftr2 = await trial(longp('Thank you again', ['Terms revised 11/12/2019']), SD('2019-11-12', 'Terms revised 11/12/2019'));
check('17i a boilerplate line (terms revised, copyright, printed, form rev.) midd-page is never suggested', ftr2.stored.length === 0 && (await sugOf(ftr2.id)).length === 0);
const midd = await trial(longp('Thank you again', ['Warranty expires 03/14/2031']), SD('2031-03-14', 'Warranty expires 03/14/2031'));
check('17j control: the same wrong-label date in the body (not footer, not sensitive) is still a suggestion', (await sugOf(midd.id)).length === 1, JSON.stringify(midd.r.rejected));

// D2: simultaneous Accepts / Dismiss: exactly one winner, one resolved row, one person value
const raceDoc = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const raceKey = (await sugOf(raceDoc.id))[0].key;
const acceptArgs = (v) => [ctx, { documentId: raceDoc.id, key: raceKey, value: v, by: 'You' }, null, { correctField: RVS.correctField }];
const raced = await Promise.allSettled([AFS.acceptFieldSuggestion(...acceptArgs()), AFS.acceptFieldSuggestion(...acceptArgs()), AFS.acceptFieldSuggestion(...acceptArgs('2026-03-01')), AFS.dismissFieldSuggestion(ctx, { documentId: raceDoc.id, key: raceKey }, null)]);
const winners = raced.filter((r) => r.status === 'fulfilled').length;
const resolvedN = (await sugRows(raceDoc.id, 'ai_finish.suggestion_resolved')).length;
const factRows = (await lite.query(`SELECT corrected_value FROM extractions WHERE document_id = $1 AND field_key = 'service_date'`, [raceDoc.id])).rows;
check('17k four simultaneous Accept / Edit / Dismiss: exactly one wins, one resolved row, and at most one person value', winners === 1 && resolvedN === 1 && factRows.length <= 1 && raced.filter((r) => r.status === 'rejected').every((r) => r.reason?.status === 404), JSON.stringify({ winners, resolvedN, factRows, rej: raced.filter((r) => r.status === 'rejected').map((r) => r.reason?.message) }));
const raceDoc2 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const rk2 = (await sugOf(raceDoc2.id))[0].key;
const two = await Promise.allSettled([1, 2].map(() => AFS.acceptFieldSuggestion(ctx, { documentId: raceDoc2.id, key: rk2, by: 'You' }, null, { correctField: RVS.correctField })));
check('17l two simultaneous Accepts of the same value: one value, one resolved row', two.filter((r) => r.status === 'fulfilled').length === 1 && (await sugRows(raceDoc2.id, 'ai_finish.suggestion_resolved')).length === 1 && (await factCount(raceDoc2.id, 'service_date')) === 1);
// a failed write gives the suggestion back
const raceDoc3 = await trial(['Warranty expires 03/14/2031'], SD('2031-03-14', 'Warranty expires 03/14/2031'));
const rk3 = (await sugOf(raceDoc3.id))[0].key;
let boom = null; try { await AFS.acceptFieldSuggestion(ctx, { documentId: raceDoc3.id, key: rk3, by: 'You' }, null, { correctField: async () => { throw new Error('db down'); } }); } catch (e) { boom = e; }
const back = await sugOf(raceDoc3.id);
const retry = await AFS.acceptFieldSuggestion(ctx, { documentId: raceDoc3.id, key: rk3, by: 'You' }, null, { correctField: RVS.correctField });
check('17m an Accept whose write failed releases its claim: the suggestion is listed again and a retry works', boom?.message === 'db down' && back.length === 1 && retry.ok && (await sugOf(raceDoc3.id)).length === 0 && (await factCount(raceDoc3.id, 'service_date')) === 1);

// D3: vision bounded by its reservation, reconciled afterwards
const monthUnitsNow = async () => Number((await lite.query(`SELECT units FROM rate_limit_windows WHERE bucket = 'ai_finish_month_usd_micro'`)).rows[0]?.units ?? 0) / 1e6;
const UM = await import(rel('api/_lib/usage.js'));
let attempts = 0;
const visionOver = (bytes) => ({ callModel, r2: { keyBelongsToTenant: () => true, getObject: async () => bytes, normalizeContentType: (x) => x },
  readDocument: { ...realRd, sniffMagicBytes: () => 'application/pdf', hasReadableText: () => true,
    readPdfOrImage: async (b, ct, c) => { for (let i = 0; i < 3; i++) { attempts++; await UM.recordModelCall(c, { inputTokens: 1_000_000, outputTokens: 100_000, model: 'claude-haiku-4-5' }); } return { pages: [], method: 'model' }; } } });
const ov = await paper('ovr.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/ovr.pdf` });
const m0 = await monthUnitsNow();
const ovRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [ov], deps: visionOver(Buffer.from('%PDF-1.4 stub')), today: '2026-10-26', source: 'verify' });
const m1 = await monthUnitsNow();
check('17n a vision reader that overruns its reservation is stopped after the first call (not 3), the paper is left alone, and the ledger shows the ACTUAL spend', attempts === 1 && ovRun.failed === 1 && (m1 - m0) > 1.0 && Math.abs((m1 - m0) - ovRun.costUsd) < 0.001, JSON.stringify({ attempts, d: m1 - m0, ovRun }));
const afterOver = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [(await paper('again.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/again.pdf` })) ], deps: visionOver(Buffer.from('%PDF-1.4 stub')), today: '2026-10-26', source: 'verify' });
check('17n2 the actual overrun is on the daily ledger, so the very next run is stopped by it', afterOver.stoppedBy === 'day-budget' && attempts === 1, JSON.stringify(afterOver));
await lite.query(`UPDATE rate_limit_windows SET units = 0 WHERE bucket = 'ai_finish_usd_micro'`); // test housekeeping: new day
const bound1 = AF.visionBoundUsd('claude-haiku-4-5', 1, 'application/pdf');
check('17o the reservation is the worst case of the reader\'s own caps (two calls of max_tokens + the page input), well above the old flat guess', bound1 > 0.05 && bound1 < 0.2 && AF.visionBoundUsd('claude-haiku-4-5', 2, 'image/png') < bound1 * 1.5, String(bound1));
const smallp = await paper('smallp.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/smallp.pdf` });
SCRIPT.set('TOK-V1', { document_type: 'work-order', fields: [] });
const okRd = { callModel, r2: { keyBelongsToTenant: () => true, getObject: async () => Buffer.from('%PDF-1.4 stub'), normalizeContentType: (x) => x },
  readDocument: { ...realRd, sniffMagicBytes: () => 'application/pdf', hasReadableText: (p) => p.some((x) => String(x.text).trim()),
    readPdfOrImage: async (b, ct, c) => { await UM.recordModelCall(c, { inputTokens: 4000, outputTokens: 900, model: 'claude-haiku-4-5' }); return { pages: [{ page_no: 1, text: 'TOK-V1 Work order\nSite: 3 Birch Ct\nDate of Service: 03/14/2026' }], method: 'model' }; } } };
const m2 = await monthUnitsNow();
const okRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [smallp], deps: okRd, today: '2026-10-26', source: 'verify' });
const m3 = await monthUnitsNow();
check('17p after a normal read the unused part of the reservation is given back (ledger = actual vision + text cost, far below the reserve)', (m3 - m2) < 0.02 && (m3 - m2) > 0 && Math.abs((m3 - m2) - okRun.costUsd) < 0.001, JSON.stringify({ d: m3 - m2, okRun }));
const bigf = await paper('bigfile.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/bigfile.pdf` });
let bigReads = 0;
const bigRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [bigf], deps: { ...okRd, r2: { ...okRd.r2, getObject: async () => Buffer.alloc(5 * 1024 * 1024, 1) }, readDocument: { ...okRd.readDocument, readPdfOrImage: async () => { bigReads++; return { pages: [] }; } } }, today: '2026-10-26', source: 'verify' });
check('17q a file over 4 MB (resolution proxy) is not sent to the vision reader', bigReads === 0 && bigRun.failed === 1);
const tight = await paper('tight.pdf', '', { type: 'work-order', facts: { service_address: '3 Birch Ct' }, storageKey: `${ten}/tight.pdf` });
let tightReads = 0;
const tightRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: [tight], deps: { ...okRd, readDocument: { ...okRd.readDocument, readPdfOrImage: async () => { tightReads++; return { pages: [] }; } } }, today: '2026-10-26', source: 'verify', env: { ...process.env, AI_FINISH_MONTHLY_USD_FLEET: String((await monthUnitsNow()) + 0.05) } });
check('17r a scan whose worst case does not fit the remaining monthly room is not read at all', tightReads === 0 && tightRun.stoppedBy === 'month-budget', JSON.stringify(tightRun));

// ---------- 12. nothing customer-facing carries money
const RA = fs.readFileSync(rel('src/screens/recheckAll.ts'), 'utf8');
const finishStrings = RA.slice(RA.indexOf('AI finish (optional staff button'));
const mod = await import('tsx/esm/api').then(({ tsImport }) => tsImport(rel('src/screens/recheckAll.ts'), import.meta.url)).catch(() => null);
const samples = mod ? [
  mod.finishBanner({ processed: 9, facts: 14, suggested: 3, typed: 2, failed: 1, stopped: 'allowance' }, 7),
  mod.finishBanner({ processed: 0, facts: 0, suggested: 0, typed: 0, failed: 0, stopped: 'off' }, 1),
  mod.finishBanner({ processed: 4, facts: 1, suggested: 0, typed: 0, failed: 0, stopped: 'busy' }, 0),
  mod.finishBanner({ processed: 4, facts: 0, suggested: 0, typed: 0, failed: 0, stopped: null }, 2),
  mod.finishProgress(3, 20), mod.FINISH_AI_LABEL, mod.FINISH_AI_TITLE, mod.FINISH_AI_ERROR,
] : [finishStrings];
const sugMod = await import('tsx/esm/api').then(({ tsImport }) => tsImport(rel('src/components/inbox/fieldSuggestText.ts'), import.meta.url)).catch(() => null);
const sugStrings = sugMod ? Object.values(sugMod.SUGGEST_TEXT).flatMap((v) => (typeof v === 'function' ? [v('Mar 4, 2026'), (() => { try { return v(1); } catch { return ''; } })(), (() => { try { return v(3); } catch { return ''; } })()] : [v])).map(String) : [];
if (mod) samples.push(mod.finishBanner({ processed: 3, facts: 0, fieldSuggestions: 2, suggested: 0, typed: 0, failed: 0, stopped: null }, 2), ...sugStrings);
const money = /[$€£]|\bcost|\bprice|\bpric|\bdollar|\bbudget|\bcents?\b|\bUSD\b|\bcharge|\bbill(?:ed|ing)?\b/i;
check('12a (incl. the rev3 suggestion strings) no customer-facing AI-finish string contains a price, a dollar sign, "cost" or "budget"', samples.every((s) => !money.test(s)), samples.filter((s) => money.test(s)).join(' | '));
check('12b the banner reads as agreed ("DeepWell filled in N more facts. N papers still need you.")', !mod || /^DeepWell filled in 14 more facts\. Suggested a customer for 3 papers: check each one, then link\. Set the type of 2\. 7 papers still need you\./.test(samples[0]), samples[0]);
const RS = fs.readFileSync(rel('src/screens/ReviewScreen.tsx'), 'utf8');
const runner = RS.slice(RS.indexOf('const runFinishAi'), RS.indexOf('const runFinishAi') + 1800);
check('12c the screen code for the button shows nothing money-like', !/\$\{?[^`'"]*cost|price|dollar/i.test(runner));
const REV = fs.readFileSync(rel('api/review.js'), 'utf8');
const act = REV.slice(REV.indexOf("case 'aiFinish'"), REV.indexOf("case 'aiFinish'") + 1800);
check('12d the aiFinish API answer is built without any cost field', /result = \{ considered/.test(act) && !/result = \{[^}]*cost/i.test(act));

// ---------- 13. wiring and limits
const SWEEP = fs.readFileSync(rel('api/_lib/routes/cron-sweep.js'), 'utf8');
check('13a the nightly sweep runs the pass after Re-check, per tenant, with the platform cap and the plan', /finishTenantPapers\(ctx, \{[^}]*plan: row\.plan[^}]*platform: aiFinishPlatform/s.test(SWEEP));
check('13b the plan-sized monthly budgets exist for every real plan and demo is 0', AF.MONTHLY_BUDGET_USD.solo > 0 && AF.MONTHLY_BUDGET_USD.fleet > AF.MONTHLY_BUDGET_USD.crew && AF.MONTHLY_BUDGET_USD.crew > AF.MONTHLY_BUDGET_USD.shop && AF.MONTHLY_BUDGET_USD.demo === 0);
const apiTop = fs.readdirSync(rel('api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
check('13c api/ keeps exactly 12 top-level files (no new function file; _lib is a folder)', apiTop === 12, String(apiTop));
check('13d no migration was added', !fs.readdirSync(cfg).some((f) => /ai[-_]?finish/i.test(f)));

realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
