/**
 * verify:stored-audit (2026-10-23) - the READ-ONLY audit of values already stored (api/_lib/storedAuditStore.js).
 *
 * Against a real Postgres (PGlite, as the RLS role): seeds documents whose STORED values are wrong in each way the audit knows
 * (signer taken as customer, a column title as the customer, a COI start on the certificate date, a term that does not add up,
 * an amount that is not the total), plus correct controls, a person-corrected value and an HR-filed paper, then proves:
 *   1. dry run (owner switch off): counts only - no flag rows, nothing visible, one run row;
 *   2. nothing is EVER overwritten: extractions / facets / documents are byte-identical after every run;
 *   3. switch on: one flag per wrong value with the evidence quote and page; correct controls and corrected values untouched;
 *   4. idempotent; resumable (cursor); a corrected value or a dismissal removes the flag and it does not come back;
 *   5. another account's papers are never read or flagged.
 * No network, no model, no DATABASE_URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
const realLog = console.log;
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; realLog(`PASS  ${name}`); } else { fail++; realLog(`FAIL  ${name}${extra ? `\n      ${extra}` : ''}`); } };

process.env.NEON_CONNECTION_STRING ||= 'postgres://verify:verify@localhost-pooler/verify';
process.env.DATABASE_URL ||= process.env.NEON_CONNECTION_STRING;

let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  realLog(`FAIL  PGlite is not installed (${err?.message}); this regression needs a real Postgres.`);
  process.exit(1);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = rel('M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as verify-r33-dates */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }

// Route the app's pg Pool through PGlite as the RLS role. Also record every statement whose bound parameter count
// exceeds the highest $n it references (the exact class of bug that broke production).
const unusedParamStatements = [];
const audit = (sql, params) => {
  if (!Array.isArray(params) || !params.length) return;
  const refs = [...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = refs.length ? Math.max(...refs) : 0;
  const used = new Set(refs);
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) { unusedParamStatements.push({ sql: String(sql).slice(0, 120), params: params.length, max, missing: i }); break; }
};
const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => { audit(sql, params); return lite.query(sql, params); }, release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) { audit(sql, params); const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };

const { getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
const AS = await import(rel('api/_lib/storedAuditStore.js'));
const RC = await import(rel('api/_lib/recheck.js'));

const ctxA = { tenantKey: 'org_sonoran_audit', tenantName: 'Sonoran Comfort Air' };
const ctxB = { tenantKey: 'org_other_audit', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

let seq = 0;
const nid = () => `00000000-0000-4000-9100-${String(++seq).padStart(12, '0')}`;
const NOW = '2026-10-20T12:00:00Z';
async function makeDoc(tenantId, { name, type = 'agreement', stage = 'linked', pagesText, fields }) {
  const id = nid();
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`, [id, tenantId, name, type, `h-${id}`, stage, NOW]);
  pagesText.forEach((t, i) => lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, text) VALUES ($1,$2,$3,$4)`, [tenantId, id, i + 1, t]));
  for (const f of fields) {
    const fid = nid();
    await lite.query(`INSERT INTO facets (id, tenant_id, document_id, page_no, segment_id, label_raw, value_raw, confidence, mapped_field_key, mapping_method, created_at) VALUES ($1,$2,$3,$4,'field-extract',$5,$6,0.95,$7,'registry',$8::timestamptz)`, [fid, tenantId, id, f.page ?? 1, f.quote ?? f.key, f.value, f.key, NOW]);
    await lite.query(`INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, corrected_value, confidence, source_facet_id, created_at) VALUES ($1,$2,$3,NULL,$4,$5,$6,0.95,$7,$8::timestamptz)`, [nid(), tenantId, id, f.key, f.value, f.corrected ?? null, fid, NOW]);
  }
  return id;
}
const EVT = 'EVENT AGREEMENT\nThis Agreement is made 03/13/2026 between the Venue and Harborlight Neighbors Alliance (the Client).\n\n__________________________________   __________________________________\nVenue: Cecilia Reeves Date: ________   Client: Colin Dunn Date: ________';
const INV = 'INVOICE\nInvoice #: 4411   Date: 03/02/2026\nBill To: Desert Car Wash Co\nService call   1   $100.00\nSubtotal $100.00\nTax $8.00\nTotal $108.00';
const COI = 'CERTIFICATE OF LIABILITY INSURANCE\nCertificate Date: 2026-01-25   Insurer:   Ironwood Casualty Mutual\nGeneral Liability GL-1   Policy Effective: 2025-12-03\nPolicy Expires:   2026-12-03\nINSURED   CERTIFICATE HOLDER\nAcme Plumbing LLC   Desert Car Wash Co';
const LEASE = 'LEASE AGREEMENT\nThis Lease is made between Mesa Holdings LLC (Landlord) and Desert Car Wash Co (Tenant) for a term of 60 months beginning 02/10/2023 and ending 02/09/2028.';

const d = {};
d.signer = await makeDoc(tenA, { name: 'Event Contract - Fun Run.pdf', pagesText: [EVT], fields: [{ key: 'customer_name', value: 'Colin Dunn', quote: 'Venue: Cecilia Reeves Date: ________ Client: Colin Dunn Date: ________' }] });
d.label = await makeDoc(tenA, { name: 'Invoice 4411.pdf', type: 'invoice', pagesText: [INV], fields: [{ key: 'customer_name', value: 'SERVICE LOCATION' }] });
d.subtotal = await makeDoc(tenA, { name: 'Invoice 4412.pdf', type: 'invoice', pagesText: [INV], fields: [{ key: 'cost', value: '100.00', quote: 'Subtotal $100.00' }] });
d.coi = await makeDoc(tenA, { name: 'COI - Acme.pdf', type: 'insurance-certificate', pagesText: [COI], fields: [{ key: 'start_date', value: '2026-01-25' }, { key: 'end_date', value: '2026-12-03' }] });
d.term = await makeDoc(tenA, { name: 'Lease - Mesa.pdf', pagesText: [LEASE], fields: [{ key: 'agreement_term', value: '60 months (02/10/2023 - 02/09/2027)' }, { key: 'start_date', value: '2023-02-10' }, { key: 'end_date', value: '2027-02-09' }] });
d.okInv = await makeDoc(tenA, { name: 'Invoice 4413.pdf', type: 'invoice', pagesText: [INV], fields: [{ key: 'cost', value: '108.00' }, { key: 'customer_name', value: 'Desert Car Wash Co' }] });
d.okEvt = await makeDoc(tenA, { name: 'Event Contract - ok.pdf', pagesText: [EVT], fields: [{ key: 'customer_name', value: 'Harborlight Neighbors Alliance' }] });
d.person = await makeDoc(tenA, { name: 'Event Contract - person.pdf', pagesText: [EVT], fields: [{ key: 'customer_name', value: 'Colin Dunn', corrected: 'Colin Dunn' }] });
d.hr = await makeDoc(tenA, { name: 'HR - offer.pdf', pagesText: [EVT], fields: [{ key: 'customer_name', value: 'Colin Dunn' }, { key: '_company_folder', value: 'people-hr' }] });
d.verified = await makeDoc(tenA, { name: 'Invoice 4414.pdf', type: 'invoice', stage: 'verified', pagesText: [INV], fields: [{ key: 'cost', value: '100.00' }] });
d.other = await makeDoc(tenB, { name: 'Event Contract - other.pdf', pagesText: [EVT], fields: [{ key: 'customer_name', value: 'Colin Dunn' }] });
const WRONG = [d.signer, d.label, d.subtotal, d.coi, d.term, d.verified];

const snapshot = async () => JSON.stringify([
  (await lite.query(`SELECT id, field_key, value, corrected_value, confidence FROM extractions ORDER BY id`)).rows,
  (await lite.query(`SELECT id, value_raw, label_raw FROM facets ORDER BY id`)).rows,
  (await lite.query(`SELECT id, document_type, stage FROM documents ORDER BY id`)).rows,
]);
const auditRows = async (action) => (await lite.query(`SELECT resource_id, changes FROM audit_log WHERE action = $1 ORDER BY created_at, id`, [action])).rows;
const before = await snapshot();
check('fixture: documents seeded', Number((await lite.query(`SELECT count(*)::int AS c FROM documents`)).rows[0].c) === 11);

// ---- 1. dry run (the owner switch is off): counts only
delete process.env.STORED_FACT_FLAGS;
const dry = await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, source: 'verify' });
check('dry run: reports counts per rule', dry.dryRun === true && dry.scanned === 10 && dry.flagged >= 6 && dry.byRule.signer >= 1 && dry.byRule.label >= 1 && dry.byRule.total >= 1 && dry.byRule.period >= 1 && dry.byRule.term >= 1, JSON.stringify(dry));
check('dry run: writes NO flag rows even when asked to commit', (await auditRows(AS.FLAG_ACTION)).length === 0);
check('dry run: leaves one count row', (await auditRows(AS.RUN_ACTION)).length === 1 && (await auditRows(AS.RUN_ACTION))[0].changes.dry_run === true);
check('dry run: nothing is visible in the Inbox list', (await AS.listStoredFlags(ctxA)).visible === false);
check('dry run: no value, quote or type changed', (await snapshot()) === before);

const dry2 = await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, afterId: '', source: 'verify' });
check('dry run twice: the second pass reports 0 NEW flags and the same distinct count', dry2.newFlags === 0 && dry2.distinctFlags === dry.newFlags && dry2.distinctFlaggedPapers === dry.documentsFlagged, JSON.stringify([dry.newFlags, dry.documentsFlagged, dry2.newFlags, dry2.distinctFlags, dry2.distinctFlaggedPapers]));

// ---- 2. owner switch on
process.env.STORED_FACT_FLAGS = '1';
const live = await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, afterId: '', source: 'verify' });
const flags = await AS.listStoredFlags(ctxA);
const flaggedDocs = new Set(flags.flags.map((f) => f.documentId));
check('switch on: every wrong value is flagged', WRONG.every((id) => flaggedDocs.has(id)), JSON.stringify([...flaggedDocs]));
check('switch on: correct values, a person-corrected value and an HR paper are not', ![d.okInv, d.okEvt, d.person, d.hr].some((id) => flaggedDocs.has(id)));
check('switch on: another account is never read', !flaggedDocs.has(d.other));
const sg = flags.flags.find((f) => f.documentId === d.signer);
check('flag carries the evidence quote and page', sg && /Client: Colin Dunn/.test(sg.quote) && sg.page === 1 && sg.rule === 'signer', JSON.stringify(sg));
check('flag for a wrong total names the page total', (flags.flags.find((f) => f.documentId === d.subtotal)?.expected) === '108.00');
check('a paper already checked still gets the flag (and stays checked)', flaggedDocs.has(d.verified) && (await lite.query(`SELECT stage FROM documents WHERE id = $1`, [d.verified])).rows[0].stage === 'verified');
check('switch on: still no value, quote or type changed', (await snapshot()) === before);
const n1 = (await auditRows(AS.FLAG_ACTION)).length;
await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, afterId: '', source: 'verify' });
check('running again is idempotent (no duplicate flags)', (await auditRows(AS.FLAG_ACTION)).length === n1 && n1 === live.written);

// ---- 3. resumable batches
const run1 = await AS.auditStoredTenant(ctxA, { limit: 2, commit: false, afterId: '', source: 'verify' });
const run2 = await AS.auditStoredTenant(ctxA, { limit: 2, commit: false, source: 'verify' });
check('batches resume from where the last run stopped', run1.scanned === 2 && !run1.done && run1.nextAfter && run2.scanned === 2, JSON.stringify([run1, run2]));

// ---- 4. a correction or a dismissal removes the flag, for good
await lite.query(`UPDATE extractions SET corrected_value = 'Harborlight Neighbors Alliance' WHERE document_id = $1 AND field_key = 'customer_name'`, [d.signer]);
let after = await AS.listStoredFlags(ctxA);
check('a person correcting the value clears its flag', !after.flags.some((f) => f.documentId === d.signer));
await AS.dismissStoredFlag(ctxA, { documentId: d.label, field: 'customer_name', value: 'SERVICE LOCATION' }, 'user_owner');
after = await AS.listStoredFlags(ctxA);
check('"this value is fine" clears the flag', !after.flags.some((f) => f.documentId === d.label));
await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, afterId: '', source: 'verify' });
check('...and a dismissed value is not flagged again', !(await AS.listStoredFlags(ctxA)).flags.some((f) => f.documentId === d.label) && (await auditRows(AS.FLAG_ACTION)).length === n1);

// ---- 5. Re-check calls the audit and still never overwrites
await lite.query(`UPDATE extractions SET corrected_value = NULL WHERE document_id = $1`, [d.signer]);
const rc = await RC.recheckDocument(ctxA, d.coi, { actorClerkId: 'user_owner', source: 'verify' });
check('Re-check still works and reports suspect values without changing them', rc && Array.isArray(rc.suspect), JSON.stringify(rc?.suspect));

// ---- 5b. an SQL error inside the audit can never undo Re-check's fill (the audit runs in a SAVEPOINT)
const fillDoc = await makeDoc(tenA, { name: 'Lease - Savepoint.pdf', pagesText: [LEASE], fields: [{ key: 'customer_name', value: 'SERVICE LOCATION' }] });
await lite.exec('RESET ROLE');
await lite.exec(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$ BEGIN IF NEW.action = 'review.stored_fact_flagged' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS boom_t ON audit_log; CREATE TRIGGER boom_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION boom();`);
const realErr = console.error; const errs = []; console.error = (...a) => { errs.push(a.join(' ')); };
let rcBoom = null, rcThrew = null;
try { rcBoom = await RC.recheckDocument(ctxA, fillDoc, { actorClerkId: 'user_owner', source: 'verify' }); } catch (err) { rcThrew = err?.message; }
console.error = realErr;
const filledKeys = (await lite.query(`SELECT field_key FROM extractions WHERE document_id = $1`, [fillDoc])).rows.map((r) => r.field_key);
check('forced audit SQL error: Re-check does not throw', !rcThrew, rcThrew ?? '');
check('...the audit failure was logged, not hidden', errs.some((e) => /stored-value audit skipped/.test(e)), errs.join(' | ').slice(0, 200));
check('...Re-check still committed its filled fields', filledKeys.includes('start_date') && filledKeys.includes('end_date') && rcBoom?.status === 'filled', JSON.stringify([filledKeys, rcBoom?.status]));
check('...and its own audit row (document.fields_rechecked) was committed', (await auditRows('document.fields_rechecked')).some((r) => r.resource_id === fillDoc));
await lite.exec('DROP TRIGGER boom_t ON audit_log');

// ---- 6. hard off switch
process.env.STORED_FACT_AUDIT = '0';
const off = await AS.auditStoredTenant(ctxA, { limit: 100, commit: true, source: 'verify' });
check('STORED_FACT_AUDIT=0 turns the audit off completely', off.disabled === true && off.scanned === 0);
delete process.env.STORED_FACT_AUDIT;

realLog(`\nverify:stored-audit  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
