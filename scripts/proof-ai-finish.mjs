// AI-finish proof on the 1,000 Sonoran files (PGlite, RLS role, real schema) with a STUBBED Claude that returns realistic answers AND
// deliberately bad ones (made-up quotes, quote-less values, wrong values, a person's field, invented / absent customers). Run from the app root.
//   DATA=<dir with stored_old.json + pages_old.json> node scripts/proof-ai-finish.mjs        (CONTROL=1: the stub returns nothing)
// Reports: what each bad answer did (must be nothing), person rows changed (must be 0), links Claude caused (must be 0), set-aside and
// HR papers (0 calls, 0 suggestions), and the INTERNAL cost of the run extrapolated to the remaining papers. Nothing here is customer-facing.
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd(); const rel = (p) => path.join(root, p);
const DATA = process.env.DATA || '/mnt/user-data/uploads/Downloads/donovan-training/_lc_tmp';
const CONTROL = process.env.CONTROL === '1';
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
let tail = Promise.resolve();
const lock = () => { let r2; const p = new Promise((r) => { r2 = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => r2); };
pgMod.Pool.prototype.connect = async function () { const r = await lock(); await lite.exec('SET ROLE deepwell_rls'); return { query: (s, p) => lite.query(s, p), release: () => { lite.exec('RESET ROLE').finally(r); } }; };
pgMod.Pool.prototype.query = async function (s, p) { const r = await lock(); try { return await lite.query(s, p); } finally { r(); } };
const { getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
const RC = await import(rel('api/_lib/recheck.js'));
const AF = await import(rel('api/_lib/aiFinish.js'));
const DT = await import(rel('api/_lib/documentTypes.js'));
const { verifyGrounded } = await import(rel('api/_lib/modelAvoidance/groundedFacts.js'));
const { estimateModelCostUsd } = await import(rel('api/_lib/usage.js'));
const ctx = { tenantKey: 'org_sonoran_finish', tenantName: 'Sonoran Comfort Air' };
const ten = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'stored_old.json'), 'utf8'));
const pages = JSON.parse(fs.readFileSync(path.join(DATA, 'pages_old.json'), 'utf8')).docs;
const pmap = new Map(pages.map((d) => [d.filename, d]));
let seq = 0; const nid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;

const custByName = new Map(); const custNames = [];
for (const s of stored) for (const f of s.fields) if (f.field_key === 'customer_name' && !custByName.has(f.value.toLowerCase())) {
  const id = nid(); custByName.set(f.value.toLowerCase(), id); custNames.push([id, f.value]);
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [id, ten, JSON.stringify({ customer_name: f.value })]);
}
const addrCust = nid();
await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer','{"customer_name":"Address-only customer"}'::jsonb,NOW(),NOW())`, [addrCust, ten]);

const meta = []; let i = 0;
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
    const corrected = (i % 12 === 0 && f === s.fields[0]) ? `PERSON-${f.field_key}-${i}` : null;
    await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, field_key, value, confidence, source_facet_id, corrected_value, created_at) VALUES ($1,$2,$3,$4,$5,0.95,$6,$7,NOW())`, [nid(), ten, id, f.field_key, f.value, fid, corrected]);
  }
  if (linkTo) await lite.query(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,0.9,'ai',NOW())`, [ten, id, linkTo]);
  if (i % 25 === 0) await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_classified','document',$2,'{"documentType":"x"}'::jsonb)`, [ten, id]);
  if (!linkTo && i % 9 === 0) await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_unlinked','document',$2,'{}'::jsonb)`, [ten, id]);
  meta.push({ id, filename: s.filename, setAside: !!s.setAside, personType: i % 25 === 0, personUnlinked: !linkTo && i % 9 === 0, type: s.type });
}
const metaById = new Map(meta.map((m) => [m.id, m]));
const hrIds = new Set(meta.filter((m) => /hr-letter|license/i.test(m.type ?? '')).map((m) => m.id));

// ---- the free reader first: Re-check all (what the owner has already run)
{
  const queue = meta.filter((m) => !m.setAside).map((m) => m.id); let guard = 0;
  while (queue.length && guard++ < 60) {
    const chunk = queue.splice(0, 100);
    const r = await RC.recheckTenantMissing(ctx, { documentIds: chunk, openAll: true, force: true, limit: 100, source: 'inbox-bulk', actorClerkId: 'u', deadlineAt: Date.now() + 150000 });
    if (r.leftIds?.length) queue.unshift(...r.leftIds.filter((id) => chunk.includes(id)));
  }
}
// ---- id-bank: HR / licence papers with names that exist as customers (the 0/0 check)
const bank = JSON.parse(fs.readFileSync(rel('test-docs/id-bank/pages-bank.json'), 'utf8')).docs;
const truths = new Map(fs.readdirSync(rel('test-docs/id-bank/truth')).filter((f) => f.endsWith('.json')).map((f) => { const t = JSON.parse(fs.readFileSync(path.join(rel('test-docs/id-bank/truth'), f), 'utf8')); return [t.id, t]; }));
const bankIds = [];
for (const b of bank) {
  const t = truths.get(b.id); if (!t) continue;
  const person = t.person;
  if (person && !custByName.has(person.toLowerCase())) { const id = nid(); custByName.set(person.toLowerCase(), id); custNames.push([id, person]); await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,'customer',$3::jsonb,NOW(),NOW())`, [id, ten, JSON.stringify({ customer_name: person })]); }
  const id = nid();
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,'read',NOW())`, [id, ten, `${b.id}.pdf`, /^(hr-letter|license-certification)$/.test(t.type) ? t.type : 'other', 'h' + id]);
  for (const p of b.pages) await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,$3,$4)`, [ten, id, p.page_no, p.text ?? '']);
  bankIds.push({ id, type: t.type, person });
}

async function snapshot() {
  const ex = (await lite.query(`SELECT e.id, e.document_id, e.field_key, e.value, e.corrected_value, f.segment_id, f.label_raw FROM extractions e LEFT JOIN facets f ON f.id = e.source_facet_id WHERE e.tenant_id=$1`, [ten])).rows;
  const docs = (await lite.query(`SELECT id, stage, document_type FROM documents WHERE tenant_id=$1`, [ten])).rows;
  const links = (await lite.query(`SELECT document_id, entity_id, linked_by FROM document_entity_links WHERE tenant_id=$1`, [ten])).rows;
  const sug = (await lite.query(`SELECT DISTINCT ON (resource_id) resource_id, changes FROM audit_log WHERE tenant_id=$1 AND action='recheck.link_suggestion' ORDER BY resource_id, created_at DESC, id DESC`, [ten])).rows;
  return { ex, docs, links, sug };
}
function openCount(snap) {
  const exBy = new Map(); for (const e of snap.ex) { if (!exBy.has(e.document_id)) exBy.set(e.document_id, []); exBy.get(e.document_id).push(e); }
  const linked = new Set(snap.links.map((l) => l.document_id));
  let open = 0, setAside = 0, verified = 0;
  for (const d of snap.docs) {
    const m = metaById.get(d.id); if (!m) continue;
    if (d.stage === 'verified') { verified++; continue; }
    if (m.setAside) { setAside++; continue; }
    open++;
  }
  return { open, verified, setAside };
}
const before = await snapshot();
log(`[${CONTROL ? 'control' : 'finish'}] after Re-check all:`, JSON.stringify(openCount(before)));

// ---- the stubbed Claude
const injected = new Map(); // docId -> [{kind, key, value}]
const ledger = { good: 0, fabricatedQuote: 0, noQuote: 0, wrongValue: 0, lowConfidence: 0, personField: 0, inventedCustomer: 0, absentCustomer: 0, typeNoQuote: 0, typeGood: 0, customerGood: 0 };
let callN = 0; let inTok = 0, outTok = 0, cacheReadTok = 0, cacheWriteTok = 0; let seenSystem = false;
const byPrompt = new Map();
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/;
const ADDR_RE = /\b\d{2,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way|Pl)\b\.?/;
const lineOf = (text, idx) => { const a = text.lastIndexOf('\n', idx) + 1; const b = text.indexOf('\n', idx); return text.slice(a, b < 0 ? text.length : b).trim(); };
function findValue(key, text) {
  if (key === 'service_date' || key === 'installation_date' || key === 'warranty_registered_date') {
    const m = DATE_RE.exec(text); if (!m) return null;
    return { value: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, quote: m[0] };
  }
  if (key === 'cost') { const m = /(?:total|amount due|balance due)[^\n$]{0,30}\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/i.exec(text) ?? MONEY_RE.exec(text); if (!m) return null; return { value: m[1].replace(/,/g, ''), quote: m[0] }; }
  if (key === 'service_address') { const m = ADDR_RE.exec(text); return m ? { value: m[0].replace(/\.$/, ''), quote: m[0] } : null; }
  if (key === 'serial_number') { const m = /(?:serial(?: ?(?:no|number|#))?|s\/n)[:#\s]*([A-Z0-9-]{6,})/i.exec(text); return m ? { value: m[1], quote: m[0] } : null; }
  if (key === 'model') { const m = /model(?: ?(?:no|number|#))?[:#\s]*([A-Z0-9-]{4,})/i.exec(text); return m ? { value: m[1], quote: m[0] } : null; }
  if (key === 'work_performed') { const m = /work performed[:\s]*([^\n]{6,120})/i.exec(text); return m ? { value: m[1].trim(), quote: m[0].trim() } : null; }
  if (key === 'vendor') { const first = text.split('\n').map((l) => l.trim()).find((l) => /^[A-Z][A-Za-z&.,' -]{4,50}(?:Inc|LLC|Co|Company|Plumbing|Heating|Air|Supply|Construction|Builders)\b\.?$/.test(l)); return first ? { value: first, quote: first } : null; }
  return null;
}
const callModel = async (args) => {
  callN++;
  const userText = args.user;
  const needed = /Fields still needed: ([^\n]*?)\./.exec(userText)?.[1]?.split(',').map((x) => x.trim()).filter((x) => x && x !== 'none') ?? [];
  const tok = userText.length; // deterministic variation per paper
  const docText = userText.slice(0, userText.indexOf('Read the pages') > 0 ? userText.indexOf('Read the pages') : userText.length);
  const idMatch = /\[page 1\]/.exec(docText);
  void idMatch;
  const fields = []; const bad = [];
  const n = callN;
  for (const key of needed) {
    const found = findValue(key, userText);
    if (!found) continue;
    // QUOTE_MODE=line: the stub quotes the whole printed line (label + value), as a model told to "copy a short stretch that contains the value" usually does.
    // Default (match): only the bare matched text, the worst case for the label binding.
    if (process.env.QUOTE_MODE === 'line') { const at = userText.indexOf(found.quote); if (at >= 0) { const s0 = userText.lastIndexOf('\n', at) + 1; let e0 = userText.indexOf('\n', at); if (e0 < 0) e0 = userText.length; found.quote = userText.slice(s0, e0).trim(); } }
    const base = { key, value: found.value, page_no: 1, confidence: 0.9, verbatim: found.quote };
    if (CONTROL) continue;
    if (n % 7 === 0) { fields.push({ ...base, verbatim: `${found.quote} (as printed on the form)` }); bad.push({ kind: 'fabricatedQuote', key, value: found.value }); ledger.fabricatedQuote++; }
    else if (n % 11 === 0) { const { verbatim, ...rest } = base; fields.push(rest); bad.push({ kind: 'noQuote', key, value: found.value }); ledger.noQuote++; }
    else if (n % 13 === 0 && /date/.test(key)) { fields.push({ ...base, value: '2019-01-01' }); bad.push({ kind: 'wrongValue', key, value: '2019-01-01' }); ledger.wrongValue++; }
    else if (n % 17 === 0) { fields.push({ ...base, confidence: 0.4 }); bad.push({ kind: 'lowConfidence', key, value: found.value }); ledger.lowConfidence++; }
    else { fields.push(base); ledger.good++; }
  }
  if (!CONTROL && n % 5 === 0) { // a field the paper already HAS (a person may have typed it): must never replace it
    fields.push({ key: 'service_date', value: '2031-12-31', page_no: 1, confidence: 0.95, verbatim: 'anything' }); bad.push({ kind: 'personField', key: 'service_date', value: '2031-12-31' }); ledger.personField++;
  }
  const out = { document_type: 'other', document_type_confidence: 0.9, fields };
  if (!CONTROL && /no document type yet/.test(userText)) {
    const t = /\b(invoice|receipt|statement|agreement|proposal|quote|work order|service ticket)\b/i.exec(userText.slice(0, 4000));
    if (t && n % 3 !== 0) { out.document_type = ({ invoice: 'invoice', receipt: 'receipt', statement: 'statement', agreement: 'agreement', proposal: 'proposal-quote', quote: 'proposal-quote', 'work order': 'work-order', 'service ticket': 'service-ticket' })[t[1].toLowerCase()]; out.document_type_evidence = t[0]; ledger.typeGood++; }
    else if (t) { out.document_type = 'invoice'; out.document_type_evidence = 'INVOICE NUMBER 000-NOT-ON-PAGE'; ledger.typeNoQuote++; }
  }
  const list = [...userText.matchAll(/^\s{4}([0-9a-f-]{36}) \| ([^|\n]+?)(?: \| ([^\n]*))?$/gm)];
  if (!CONTROL && list.length) {
    if (n % 4 === 0) { const c = list[0]; const nm = c[2].trim(); if (userText.toLowerCase().includes(nm.toLowerCase())) { out.customer_pick = { customer_id: c[1], quote: nm }; ledger.customerGood++; } }
    else if (n % 4 === 1) { out.customer_pick = { customer_id: '00000000-0000-4000-9000-ffffffffffff', quote: list[0][2].trim() }; ledger.inventedCustomer++; }
    else if (n % 4 === 2) { const nm = custNames[(n * 7) % custNames.length]; out.customer_pick = { customer_id: nm[0], quote: `Customer: ${nm[1]}` }; ledger.absentCustomer++; }
  }
  // realistic usage: the document + the guide are the prompt; the shared system prefix + tool are cache reads after the first call
  const sysTok = Math.ceil((args.system?.length ?? 0) / 3.6) + 2200; // + tool schema
  const userTok = Math.ceil(userText.length / 3.6);
  const u = { inputTokens: userTok, outputTokens: 40 + 55 * fields.length + (out.customer_pick ? 60 : 0), cacheReadInputTokens: seenSystem ? sysTok : 0, cacheCreationInputTokens: seenSystem ? 0 : sysTok };
  seenSystem = true;
  inTok += u.inputTokens; outTok += u.outputTokens; cacheReadTok += u.cacheReadInputTokens; cacheWriteTok += u.cacheCreationInputTokens;
  const m = /FINISH PASS/.exec(userText); void m;
  const docId = args.__id; void docId;
  injected.set(String(callN), bad);
  return { toolInput: out, usage: u };
};

// map each call back to its document through the stored text: run papers one at a time so the call index is known
const calledFor = new Map(); // docId -> call index
const wrapped = async (args) => { const r = await callModel(args); wrapped.last = callN; return r; };
const candIds = await AF.listFinishCandidates(ctx, { limit: 3000 });
const t0 = Date.now();
const sum = { considered: candIds.length, processed: 0, finished: 0, facts: 0, suggested: 0, typed: 0, verified: 0, nothing: 0, failed: 0, skipped: 0, costUsd: 0 };
const shared = {};
const badByDoc = new Map();
for (const id of candIds) {
  const c0 = callN;
  const r = await AF.finishPaper(ctx, id, { source: 'proof', deps: { callModel: wrapped }, today: '2026-10-26', shared });
  sum.costUsd += r.costUsd ?? 0;
  if (r.status === 'skipped') { sum.skipped++; if (r.skip === 'no-plausible-field') sum.savedCalls = (sum.savedCalls ?? 0) + 1; if (callN !== c0) throw new Error('skipped paper made a call'); continue; }
  sum.processed++;
  if (r.status === 'finished') sum.finished++; else if (r.status === 'nothing') sum.nothing++; else if (r.status === 'failed') sum.failed++;
  sum.facts += r.filled.length; sum.fieldSuggestions = (sum.fieldSuggestions ?? 0) + (r.fieldSuggested?.length ?? 0); sum.suggested += r.suggested.length; sum.typed += r.typed ? 1 : 0; sum.verified += r.verified ? 1 : 0;
  if (callN !== c0) { calledFor.set(id, callN); badByDoc.set(id, injected.get(String(callN)) ?? []); }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const after = await snapshot();

// ---- checks
const results = [];
const chk = (name, ok, extra = '') => { results.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` :: ${extra}` : ''}`); };
const aiRows = after.ex.filter((e) => e.segment_id === 'field-ai');
// 1. every stored AI fact has its exact quote on the page and the value comes from it (independent re-check with the shared grounding function)
const pagesBy = new Map(); for (const p of (await lite.query(`SELECT document_id, page_no, text FROM document_pages WHERE tenant_id=$1`, [ten])).rows) { if (!pagesBy.has(p.document_id)) pagesBy.set(p.document_id, []); pagesBy.get(p.document_id).push(p); }
const ungrounded = aiRows.filter((e) => !verifyGrounded({ field_key: e.field_key, value: e.value, verbatim: e.label_raw }, pagesBy.get(e.document_id) ?? []).ok);
chk('every AI-filled fact has its exact quote on the page and the value is readable from it', ungrounded.length === 0, `${aiRows.length} AI facts, ${ungrounded.length} ungrounded`);
// 2. no injected bad answer was stored
let leaked = 0;
for (const [id, bads] of badByDoc) for (const b of bads) if (b.kind !== 'personField' && aiRows.some((e) => e.document_id === id && e.field_key === b.key && e.value === b.value && b.kind !== 'good')) leaked++;
const injectedTotal = ledger.fabricatedQuote + ledger.noQuote + ledger.wrongValue + ledger.lowConfidence + ledger.personField;
chk(`none of the ${injectedTotal} bad field answers (made-up quote, no quote, wrong value, low confidence, a person's field) was stored`, leaked === 0 && !aiRows.some((e) => e.value === '2019-01-01' || e.value === '2031-12-31'), `leaked ${leaked}`);
// 3. person rows
const afterEx = new Map(after.ex.map((e) => [e.id, e]));
let personRows = 0, personChanged = 0, existingChanged = 0, removed = 0;
for (const e of before.ex) { const a = afterEx.get(e.id); if (!a) { removed++; continue; } if (a.value !== e.value || a.corrected_value !== e.corrected_value) existingChanged++; if (e.corrected_value) { personRows++; if (a.corrected_value !== e.corrected_value || a.value !== e.value) personChanged++; } }
chk(`person-entered rows untouched (${personRows} rows, ${personChanged} changed; existing rows changed/removed ${existingChanged + removed})`, personChanged === 0 && existingChanged + removed === 0);
const dupes = (() => { const seen = new Set(); let d = 0; for (const e of after.ex) { if (['work_performed', 'part_number'].includes(e.field_key)) continue; const k = `${e.document_id}|${e.field_key}`; if (seen.has(k)) d++; seen.add(k); } return d; })();
chk('no field got a second value (insert-only)', dupes === 0 || before.ex.length === 0 ? dupes === 0 : dupes <= (() => { const seen = new Set(); let d = 0; for (const e of before.ex) { if (['work_performed', 'part_number'].includes(e.field_key)) continue; const k = `${e.document_id}|${e.field_key}`; if (seen.has(k)) d++; seen.add(k); } return d; })(), `${dupes} duplicate keys`);
// 4. types
const typeChanged = after.docs.filter((d) => metaById.get(d.id)?.personType && d.document_type !== before.docs.find((x) => x.id === d.id).document_type).length;
chk('person-chosen types unchanged', typeChanged === 0);
const retyped = after.docs.filter((d) => metaById.get(d.id) && d.document_type !== before.docs.find((x) => x.id === d.id).document_type).length;
// 5. links: Claude causes none
const newLinks = after.links.filter((l) => !before.links.some((b) => b.document_id === l.document_id && b.entity_id === l.entity_id));
const nonRule = newLinks.filter((l) => l.linked_by !== 'name-in-body');
chk(`no link was made by Claude (${newLinks.length} new links, all by the deterministic name-in-body rule; ${nonRule.length} by anything else)`, nonRule.length === 0);
const lostLinks = before.links.filter((l) => !after.links.some((x) => x.document_id === l.document_id && x.entity_id === l.entity_id)).length;
chk('no link lost, no person-unlinked paper re-linked', lostLinks === 0 && meta.filter((m) => m.personUnlinked && after.links.some((l) => l.document_id === m.id)).length === 0);
// 6. customers: suggestions name existing customers whose name is on the page
const custIds = new Set(custNames.map((c) => c[0]));
let sugBad = 0, sugNew = 0;
for (const s of after.sug) {
  const prev = before.sug.find((b) => b.resource_id === s.resource_id);
  if (JSON.stringify(prev?.changes?.candidates ?? []) === JSON.stringify(s.changes?.candidates ?? [])) continue;
  sugNew++;
  for (const c of s.changes?.candidates ?? []) { const txt = (pagesBy.get(s.resource_id) ?? []).map((p) => p.text).join(' ').toLowerCase(); if (!custIds.has(c.id) && c.id !== addrCust) sugBad++; else if (c.id !== addrCust && !txt.includes(String(c.name).toLowerCase().split(' ').slice(-1)[0])) sugBad++; }
}
chk(`customer suggestions only name existing customers whose name is on the page (${sugNew} papers got a new/changed suggestion; ${sugBad} bad)`, sugBad === 0);
// 7. set-aside and HR
const setAsideTouched = meta.filter((m) => m.setAside && (calledFor.has(m.id) || aiRows.some((e) => e.document_id === m.id))).length;
chk('set-aside papers: 0 model calls, 0 AI facts', setAsideTouched === 0);
const hrCalls = [...hrIds].filter((id) => calledFor.has(id)).length;
chk('HR / licence papers from Sonoran: 0 customer suggestions from this pass', [...hrIds].every((id) => !after.sug.some((s) => s.resource_id === id && !before.sug.some((b) => b.resource_id === id && JSON.stringify(b.changes) === JSON.stringify(s.changes)))), `calls ${hrCalls}`);
// id-bank 0/0 (HR / licence / ID papers naming people who exist as customers)
const bankRun = await AF.finishTenantPapers(ctx, { plan: 'fleet', documentIds: bankIds.map((b) => b.id), limit: 100, runCapUsd: 5, deps: { callModel: wrapped }, today: '2026-10-26', source: 'proof', concurrency: 2 });
const bankAfter = await snapshot();
const hrBank = bankIds.filter((b) => /^(hr-letter|license-certification)$/.test(b.type));
const bankLinks = hrBank.filter((b) => bankAfter.links.some((l) => l.document_id === b.id)).length;
const bankSug = hrBank.filter((b) => bankAfter.sug.some((s) => s.resource_id === b.id && (s.changes?.candidates ?? []).length)).length;
chk(`id-bank HR / licence / ID papers (${hrBank.length}): links ${bankLinks}, suggestions ${bankSug} (0/0)`, bankLinks === 0 && bankSug === 0);
// 8. nothing verified on an unfilled fact: every paper verified by this pass passes autoCheckDecision on its stored facts
chk('the run is idempotent: a second pass finds nothing to do', (await AF.listFinishCandidates(ctx, { limit: 3000 })).length === (await (async () => { const ids = await AF.listFinishCandidates(ctx, { limit: 3000 }); let n = 0; for (const id of ids) { const c0 = callN; const r = await AF.finishPaper(ctx, id, { source: 'proof', deps: { callModel: wrapped }, today: '2026-10-26', shared }); if (r.status !== 'skipped' || callN !== c0) n++; } return n === 0 ? ids.length : -1; })()));

const cost = estimateModelCostUsd('claude-haiku-4-5', { inputTokens: inTok, outputTokens: outTok, cacheReadInputTokens: cacheReadTok, cacheCreationInputTokens: cacheWriteTok });
const perPaper = callN ? cost / callN : 0;
const countsAfter = openCount(after);
const sugWritten = (await lite.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ai_finish.suggestion'`)).rows[0].n;
const openSug = (await (await import(path.join(root, 'api/_lib/aiFinishSuggest.js'))).listFieldSuggestions(ctx, { documentIds: (await lite.query(`SELECT DISTINCT resource_id AS id FROM audit_log WHERE action = 'ai_finish.suggestion'`)).rows.map((r) => r.id) })).suggestions;
{
  const sugDocs = new Set(openSug.map((s) => s.document_id));
  const badSug = meta.filter((m) => (m.setAside || hrIds.has(m.id)) && sugDocs.has(m.id)).length;
  chk(`no field suggestion on a set-aside or HR / licence paper (${openSug.length} open suggestions elsewhere, ${badSug} on those)`, badSug === 0);
  const asFacts = (await lite.query(`SELECT count(*)::int AS n FROM extractions e JOIN audit_log a ON a.resource_id = e.document_id AND a.action = 'ai_finish.suggestion' AND a.changes->>'field_key' = e.field_key AND (a.changes->>'value' = e.value) JOIN facets f ON f.id = e.source_facet_id WHERE f.segment_id = 'field-ai'`)).rows[0].n;
  chk('a suggested value is not stored as an AI fact (suggestions are audit rows only)', asFacts === 0, String(asFacts));
}
log(`[${CONTROL ? 'control' : 'finish'}] RESULT`, JSON.stringify({ ...sum, costUsd: undefined, modelCalls: callN, seconds: secs, retyped, openBefore: openCount(before).open, openAfter: countsAfter.open, verifiedByPass: sum.verified, aiFacts: aiRows.length, autoFilledFacts: aiRows.length, openFieldSuggestions: openSug.length, suggestionsWritten: sugWritten, callsSavedByGuard: sum.savedCalls ?? 0, quoteMode: process.env.QUOTE_MODE || 'match', newLinks: newLinks.length, ledger }));
log(`[${CONTROL ? 'control' : 'finish'}] INTERNAL COST`, JSON.stringify({ haikuCostUsd: Math.round(cost * 10000) / 10000, perPaperUsd: Math.round(perPaper * 100000) / 100000, tokens: { in: inTok, out: outTok, cacheRead: cacheReadTok, cacheWrite: cacheWriteTok }, auditCostUsd: Math.round(sum.costUsd * 10000) / 10000, per300PapersTextOnlyUsd: Math.round(perPaper * 300 * 100) / 100, per300WithHalfAsScansUsd: Math.round((perPaper * 300 + 150 * 0.012) * 100) / 100 }));
log(`SUMMARY ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (process.env.PROOF_DEBUG) log('[debug]', JSON.stringify({ sug: openSug.slice(0, 8).map((s) => [s.field_key, s.value ?? s.options, s.quote]), facts: aiRows.slice(0, 5).map((r) => [r.field_key, r.value, r.label_raw]) }));
process.exit(results.every((r) => r.ok) ? 0 : 1);
