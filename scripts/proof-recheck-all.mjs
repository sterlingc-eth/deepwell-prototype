// Re-check-all proof on the 1,000 Sonoran files (PGlite, RLS role, real schema). MODE=old: original code + original button (missing-field ids only).
// MODE=new: new code + new button (every open paper, chunks of 100, leftIds re-queued). Run from the app root (cwd) of the tree under test.
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd(); const rel = (p) => path.join(root, p);
const MODE = process.env.MODE || 'new';
const DATA = process.env.DATA || '/tmp/claude-0/rc';
process.env.NEON_CONNECTION_STRING ||= 'postgres://verify:verify@localhost-pooler/verify';
process.env.DATABASE_URL ||= process.env.NEON_CONNECTION_STRING;
const log = console.log; console.log = () => {}; console.error = () => {};
const { PGlite } = await import('@electric-sql/pglite');
const contrib = {};
for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
const lite = new PGlite({ extensions: contrib });
const cfg = rel('M3-config');
for (const f of fs.readdirSync(cfg).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) { try { await lite.exec(fs.readFileSync(path.join(cfg, f), 'utf8')); } catch {} }
try { await lite.exec(fs.readFileSync(path.join(cfg, '01b-app-role.sql'), 'utf8')); } catch {}
const pgMod = (await import('pg')).default;
let tail = Promise.resolve(); let qCount = 0; const qBy = {};
const qTag = (sql) => { qCount++; const k = String(sql).replace(/\s+/g, ' ').trim().slice(0, 60); qBy[k] = (qBy[k] ?? 0) + 1; };
const lock = () => { let rel2; const p = new Promise((r) => { rel2 = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => rel2); };
pgMod.Pool.prototype.connect = async function () { const r = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (s, p) => { qTag(s); return lite.query(s, p); }, release: () => { lite.exec('RESET ROLE').finally(r); } }; };
pgMod.Pool.prototype.query = async function (s, p) { qTag(s); const r = await lock(); try { return await lite.query(s, p); } finally { r(); } };
const { getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
const RC = await import(rel('api/_lib/recheck.js'));
const DT = await import(rel('api/_lib/documentTypes.js'));
const ctx = { tenantKey: 'org_sonoran', tenantName: 'Sonoran Comfort Air' };
const ten = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'stored_old.json'), 'utf8'));
const pages = JSON.parse(fs.readFileSync(path.join(DATA, 'pages_old.json'), 'utf8')).docs;
const pmap = new Map(pages.map((d) => [d.filename, d]));
let seq = 0; const nid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;

// Customers: one entity per distinct customer_name already read from the files (what ingest would have created).
const custByName = new Map();
for (const s of stored) for (const f of s.fields) if (f.field_key === 'customer_name' && !custByName.has(f.value.toLowerCase())) {
  const id = nid(); custByName.set(f.value.toLowerCase(), id);
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [id, ten, JSON.stringify({ customer_name: f.value })]);
}
const addrCust = nid();
await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer','{"customer_name":"Address-only customer"}'::jsonb,NOW(),NOW())`, [addrCust, ten]);

const meta = [];
let i = 0;
for (const s of stored) {
  i++;
  const id = nid(); const d = pmap.get(s.filename);
  const keys = new Set(s.fields.map((f) => f.field_key));
  const cn = s.fields.find((f) => f.field_key === 'customer_name');
  const linkTo = cn ? custByName.get(cn.value.toLowerCase()) : keys.has('service_address') ? addrCust : null;
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [id, ten, s.filename, s.type, 'h' + id, linkTo ? 'linked' : 'read']);
  for (const p of d.pages) await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,$3,$4)`, [ten, id, p.page_no, p.text ?? '']);
  for (const f of s.fields) {
    const fid = nid();
    await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,1,'field-extract',$4,$5,0.95,$4,'registry',NOW())`, [fid, ten, id, f.field_key, f.value]);
    // person-entered: every 12th paper has its first fact corrected by a person
    const corrected = (i % 12 === 0 && f === s.fields[0]) ? `PERSON-${f.field_key}-${i}` : null;
    await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, field_key, value, confidence, source_facet_id, corrected_value, created_at) VALUES ($1,$2,$3,$4,$5,0.95,$6,$7,NOW())`, [nid(), ten, id, f.field_key, f.value, fid, corrected]);
  }
  if (linkTo) await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'ai',NOW())`, [ten, id, linkTo]);
  // person-chosen type on every 25th paper; person-unlinked on every 9th unlinked paper
  if (i % 25 === 0) await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_classified','document',$2,'{"to":"x"}'::jsonb)`, [ten, id]);
  if (!linkTo && i % 9 === 0) await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_unlinked','document',$2,'{}'::jsonb)`, [ten, id]);
  meta.push({ id, filename: s.filename, setAside: !!s.setAside, personType: i % 25 === 0, personUnlinked: !linkTo && i % 9 === 0 });
}
const metaById = new Map(meta.map((m) => [m.id, m]));

async function snapshot() {
  const ex = (await lite.query(`SELECT id, document_id, field_key, value, corrected_value FROM extractions WHERE tenant_id=$1`, [ten])).rows;
  const docs = (await lite.query(`SELECT id, stage, document_type FROM documents WHERE tenant_id=$1`, [ten])).rows;
  const links = (await lite.query(`SELECT document_id, entity_id, linked_by FROM document_entity_links WHERE tenant_id=$1`, [ten])).rows;
  return { ex, docs, links };
}
function counts(snap, tag) {
  const exBy = new Map(); for (const e of snap.ex) { if (!exBy.has(e.document_id)) exBy.set(e.document_id, []); exBy.get(e.document_id).push(e); }
  const linked = new Set(snap.links.map((l) => l.document_id));
  const c = { verified: 0, missingInfo: 0, needsLinking: 0, readyToVerify: 0, setAside: 0 };
  const reasons = {};
  for (const d of snap.docs) {
    const m = metaById.get(d.id);
    if (d.stage === 'verified') { c.verified++; continue; }
    if (m.setAside) { c.setAside++; continue; }
    const fields = DT.toCompletenessFields(exBy.get(d.id) ?? []);
    const type = DT.normalizeDocumentType(d.document_type);
    const comp = DT.completenessFor(type, fields, null, { filename: m.filename });
    let bucket;
    if (comp.missing.length) bucket = 'missingInfo'; else if (!linked.has(d.id)) bucket = 'needsLinking'; else bucket = 'readyToVerify';
    c[bucket]++;
    const v = DT.autoCheckDecision(type, fields, { hasText: true, hasLink: linked.has(d.id), filename: m.filename });
    const r = bucket === 'missingInfo' ? 'missing-required' : (v.reason ?? 'ready-for-person');
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  c.needsAPerson = c.missingInfo + c.needsLinking + c.readyToVerify;
  log(tag, JSON.stringify(c), 'reasons', JSON.stringify(reasons));
  return c;
}
const before = await snapshot();
// Round 2: how many links do the new safety rules refuse? Every unlinked paper a person has not unlinked is judged twice on its page text: by
// the old whole-page rule and by the new customer-side rule (own company, vendor block, printed customer, set-aside).
{
  const { findCustomersInBody, isSetAsidePaper } = await import(rel('api/_lib/bodyNameLink.js'));
  const custs = (await lite.query(`SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities WHERE tenant_id=$1 AND entity_type='customer'`, [ten])).rows.map((r) => ({ id: r.id, name: r.name ?? '', address: r.address ?? '' }));
  let wouldOld = 0, wouldNew = 0, refused = 0; const byReason = {};
  for (let k = 0; k < stored.length; k++) {
    const m = meta[k]; const sRow = stored[k]; const pg = pmap.get(sRow.filename).pages.map((p) => ({ page_no: p.page_no, text: p.text ?? '' }));
    if (m.personUnlinked || before.links.some((l) => l.document_id === m.id)) continue;
    const printed = sRow.fields.find((f) => f.field_key === 'customer_name')?.value ?? null;
    const old = findCustomersInBody(pg, custs, { zones: false });
    const nu = isSetAsidePaper({ filename: sRow.filename, text: pg.map((p) => p.text).join('\n') }) ? { status: 'none', refused: 'set-aside' } : findCustomersInBody(pg, custs, { ownNames: ['Sonoran Comfort Air'], printedName: printed });
    if (old.status === 'unique') wouldOld++;
    if (nu.status === 'unique') wouldNew++;
    if (old.status === 'unique' && !(nu.status === 'unique' && nu.matches[0].customerId === old.matches[0].customerId)) { refused++; const r = nu.refused ?? 'not-on-customer-side'; byReason[r] = (byReason[r] ?? 0) + 1; }
  }
  log(`[${MODE}] LINKS REFUSED BY ROUND-2 RULES`, JSON.stringify({ oldRuleWouldLink: wouldOld, newRuleWouldLink: wouldNew, refused, byReason }));
}
counts(before, `[${MODE}] BEFORE`);

// ---- the button
const open = before.docs.filter((d) => d.stage !== 'verified' && !metaById.get(d.id).setAside).map((d) => d.id);
const exBefore = new Map(); for (const e of before.ex) { if (!exBefore.has(e.document_id)) exBefore.set(e.document_id, []); exBefore.get(e.document_id).push(e); }
const missingIds = open.filter((id) => { const d = before.docs.find((x) => x.id === id); return DT.completenessFor(DT.normalizeDocumentType(d.document_type), DT.toCompletenessFields(exBefore.get(id) ?? []), null, { filename: metaById.get(id).filename }).missing.length > 0; });
const target = MODE === 'old' ? missingIds : open;
const tot = { calls: 0, sent: target.length, rechecked: 0, filled: 0, fields: 0, retyped: 0, linked: 0, verified: 0, errors: 0 };
const queue = [...target]; let maxCallMs = 0; const t0 = Date.now(); let guard = 0;
while (queue.length && guard++ < 200) {
  const chunk = queue.splice(0, 100);
  const tc = Date.now();
  const r = await RC.recheckTenantMissing(ctx, { documentIds: chunk, force: true, openAll: MODE === 'new', actorClerkId: 'u', source: 'inbox-bulk', limit: 100, deadlineAt: Date.now() + 150000 });
  maxCallMs = Math.max(maxCallMs, Date.now() - tc);
  tot.calls++; for (const k of ['rechecked', 'filled', 'fields', 'retyped', 'linked', 'verified', 'errors']) tot[k] += r[k] ?? 0;
  if (r.leftIds?.length) queue.unshift(...r.leftIds);
}
log(`[${MODE}] button`, JSON.stringify(tot), 'ms', Date.now() - t0, 'slowest call ms', maxCallMs);
log(`[${MODE}] SQL statements in the button run: ${qCount} (${(qCount / Math.max(1, tot.rechecked)).toFixed(1)} per paper); top: ${JSON.stringify(Object.entries(qBy).sort((a, b) => b[1] - a[1]).slice(0, 40))}`);
const after = await snapshot();
counts(after, `[${MODE}] AFTER `);

// ---- person-entered safety
const afterEx = new Map(after.ex.map((e) => [e.id, e]));
let changed = 0, personRows = 0, personChanged = 0, removed = 0;
for (const e of before.ex) {
  const a = afterEx.get(e.id);
  if (!a) { removed++; continue; }
  if (a.value !== e.value || a.corrected_value !== e.corrected_value) changed++;
  if (e.corrected_value) { personRows++; if (a.corrected_value !== e.corrected_value || a.value !== e.value) personChanged++; }
}
const afterDoc = new Map(after.docs.map((d) => [d.id, d]));
const typeChanged = meta.filter((m) => m.personType && afterDoc.get(m.id).document_type !== before.docs.find((d) => d.id === m.id).document_type).length;
const linkedByDoc = new Set(after.links.map((l) => l.document_id));
const unlinkedRelinked = meta.filter((m) => m.personUnlinked && linkedByDoc.has(m.id)).length;
const newRows = after.ex.length - before.ex.length;
const linksBefore = new Set(before.links.map((l) => `${l.document_id}|${l.entity_id}`));
const linksLost = before.links.filter((l) => !after.links.some((x) => x.document_id === l.document_id && x.entity_id === l.entity_id)).length;
log(`[${MODE}] SAFETY`, JSON.stringify({ personRows, personChanged, existingRowsChangedOrRemoved: changed + removed, personTypeDocs: meta.filter((m) => m.personType).length, personTypeChanged: typeChanged, personUnlinkedDocs: meta.filter((m) => m.personUnlinked).length, personUnlinkedRelinked: unlinkedRelinked, linksLost, newFactRows: newRows, newLinks: after.links.length - before.links.length }));
process.exit(0);
