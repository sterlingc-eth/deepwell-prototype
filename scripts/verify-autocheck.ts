/**
 * AUTOMATIC CHECK + RE-SORT RULES (fixer F2). No network, no model call.
 *   1. pure: autoCheckDecision / mayVerifyWithoutLink / completenessFor / resortDecision / filename rules
 *   2. DB-backed (PGlite, real migrations): resortDocuments retypes documents that already have fields, never a type a
 *      person chose, re-extracts through the injected hook, auto-checks, and groups the skipped by reason
 *   npm run verify:autocheck
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dt from '../api/_lib/documentTypes.js';

process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const f = (field_key: string, confidence = 0.95, value = 'x') => ({ field_key, value, confidence });

/* ---------------- 1. pure ---------------- */
{
  // judges required + name facts only
  const po = [f('vendor', 0.95), f('cost', 0.95), f('invoice_number', 0.7), f('shop_phone', 0.4)];
  check('purchase order: a weak invoice number / letterhead row no longer blocks the check', dt.mayVerifyWithoutLink('purchase-order', po));
  check('purchase order: a weak required fact still blocks', !dt.mayVerifyWithoutLink('purchase-order', [f('vendor', 0.6), f('cost', 0.95)]));
  // synthetic keys
  check('_audience_notified does not break isShopInternalDocument', dt.isShopInternalDocument([f('shop_address'), f('_audience_notified', 1, 'yes')]));
  check('_audience_notified is not a fact: internal needs text to be readable', !dt.mayVerifyWithoutLink('internal', [f('_audience_notified', 1, 'yes')]));
  check('_audience_notified plus page text: internal company paper is readable', dt.mayVerifyWithoutLink('internal', [f('_audience_notified', 1, 'yes')], { hasText: true, filename: 'Inventory Count 2025-07-18.pdf' }));
  check('unreadable: no facts and no text is never checked', !dt.mayVerifyWithoutLink('internal', []));
  eq('unreadable reason', dt.autoCheckDecision('price-list', []).reason, 'unreadable');
  check('company paper with page text and no facts is checked', dt.mayVerifyWithoutLink('hr-letter', [], { hasText: true, filename: 'Offer Letter - Kim Tran.pdf' }));
  check('a non-company type is not made readable by text alone', !dt.mayVerifyWithoutLink('invoice', [], { hasText: true }));
}
{
  // completeness picks the best alternative
  const c = dt.completenessFor('maintenance-agreement', [f('customer_name', 0.95), f('warranty_term', 0.6), f('agreement_term', 0.9)]);
  eq('best-confidence alternative wins (agreement_term 0.9 over warranty_term 0.6)', [c.present.includes('agreement_term'), c.minConfidence], [true, 0.9]);
  eq('synthetic keys are not facts in completeness', dt.completenessFor('equipment-record', [f('_audience_notified', 1)]).complete, false);
}
{
  eq('statement requires nothing', dt.REQUIRED_FIELDS.statement, []);
  eq('insurance certificate requires nothing', dt.REQUIRED_FIELDS['insurance-certificate'], []);
  check('statement with page text and no facts is checked', dt.mayVerifyWithoutLink('statement', [], { hasText: true, filename: 'Fuel Card Statement 2026-09.pdf' }));
  check('invoice with no amount is still incomplete', !dt.completenessFor('invoice', [f('customer_name'), f('service_date')]).complete);
  check('an address with no link is still refused', !dt.autoCheckDecision('work-order', [f('service_address'), f('service_date')]).ok);
  eq('...for the right reason', dt.autoCheckDecision('work-order', [f('service_address'), f('service_date')]).reason, 'needs-link');
  check('...and passes once linked', dt.autoCheckDecision('work-order', [f('service_address'), f('service_date')], { hasLink: true }).ok);
  check('service ticket: serial number stands in for the address', dt.completenessFor('service-ticket', [f('serial_number'), f('service_date'), f('work_performed')]).complete);
  check('service ticket: part number stands in for the work', dt.completenessFor('service-ticket', [f('service_address'), f('service_date'), f('part_number')]).complete);
  check('service ticket still needs a date', !dt.completenessFor('service-ticket', [f('serial_number'), f('part_number')]).complete);
}
{
  // other
  check('other with no customer or address is company paper and needs no link', dt.linkNotRequired('other', new Set(['notes'])) && dt.isCompanyRecordType('other', new Set()));
  check('other with an address needs a link', !dt.linkNotRequired('other', new Set(['service_address'])));
  check('other with a customer is not company paper', !dt.isCompanyRecordType('other', new Set(['customer_name'])));
  check('other: readable with one confident fact is checked', dt.mayVerifyWithoutLink('other', [f('notes', 0.9)]));
  eq('other: only low-confidence facts needs a person to pick the type', dt.autoCheckDecision('other', [f('notes', 0.5)], { hasText: true }).reason, 'needs-type');
  eq('other: no facts needs a person to pick the type', dt.autoCheckDecision('other', [], { hasText: true }).reason, 'needs-type');
  eq('other: unreadable is never checked', dt.autoCheckDecision('other', []).reason, 'unreadable');
  eq('other with an address and no link', dt.autoCheckDecision('other', [f('service_address')]).reason, 'needs-link');
}
{
  // money
  const inv = (c: number, extra: object = {}) => [f('customer_name'), f('service_date'), { ...f('cost', c), ...extra }];
  check('invoice amount at 0.85 is checked', dt.mayVerifyWithoutLink('invoice', inv(0.85)));
  check('invoice amount at 0.84 is not checked', !dt.mayVerifyWithoutLink('invoice', inv(0.84)));
  check('a corroborated amount below 0.85 is accepted', dt.moneyAmountsConfident(inv(0.7, { corroborated: true })));
  eq('amount reason', dt.autoCheckDecision('statement', [f('cost', 0.6)], { hasText: true }).reason, 'amount-not-confirmed');
}
{
  // re-sort rules
  const R = dt.resortDecision;
  eq('invoice named receipt -> receipt', R({ currentType: 'invoice', filename: 'Receipt R-20135.pdf' }), 'receipt');
  eq('invoice named statement -> statement', R({ currentType: 'invoice', filename: 'Account Statement Oct.pdf' }), 'statement');
  eq('a person-chosen type is never changed', R({ currentType: 'invoice', filename: 'Receipt R-20135.pdf', humanChosen: true }), null);
  eq('title and name disagree -> leave', R({ currentType: 'invoice', filename: 'Receipt 1.pdf', titleType: 'agreement' }), null);
  eq('COI filed as warranty registration -> insurance certificate', R({ currentType: 'warranty-registration', filename: 'COI - Palo 2025.pdf' }), 'insurance-certificate');
  eq('floater filed as warranty registration -> insurance certificate', R({ currentType: 'warranty-registration', filename: 'Equipment Floater Declarations 2026-2027.pdf' }), 'insurance-certificate');
  eq('licence filed as warranty registration -> other (company paper)', R({ currentType: 'warranty-registration', filename: 'Plumbing License - Chloe Alvarez.pdf' }), 'other');
  eq('subcontract filed as warranty registration -> agreement', R({ currentType: 'warranty-registration', filename: 'Subcontract SC-133 - Meridian.pdf' }), 'agreement');
  eq('a real warranty card (serial on file) is not moved', R({ currentType: 'warranty-registration', filename: 'COI copy.pdf', hasEquipmentFacts: true }), null);
  eq('internal -> schedule by name', R({ currentType: 'internal', filename: 'Schedule Week of 2026-06-08.pdf' }), 'schedule');
  eq('internal -> price list by name', R({ currentType: 'internal', filename: 'Patel Price List.pdf' }), 'price-list');
  eq('hr-letter source: a grant award letter is an agreement', R({ currentType: 'hr-letter', filename: 'Award Letter - Copperline GR-24-1008.jpg' }), 'agreement');
  eq('schedule source: pledge form named schedule stays unless name says otherwise', R({ currentType: 'schedule', filename: 'Pledge Form Bishop.pdf' }), null);
  eq('award letter is not an HR letter', dt.inferTypeFromFilename('Award Letter - Silverleaf AW-25-1797.pdf'), 'agreement');
  eq('offer letter is still an HR letter', dt.inferTypeFromFilename('Offer Letter - Camila Ibarra.pdf'), 'hr-letter');
  eq('a lone warranty_expires is not a warranty registration', dt.inferDocumentType({ warranty_expires: '2027-01-01' }, 'scan.pdf') === 'warranty-registration', false);
  eq('serial + expiry still is', dt.inferDocumentType({ warranty_expires: '2027-01-01', serial_number: 'A1' }, 'scan.pdf'), 'warranty-registration');
}

/* ---------------- 2. DB-backed ---------------- */
let PGlite: any;
const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err: any) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}).`);
  console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} checks passed (database-backed skipped)`);
  process.exit(failures ? 1 : 0);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();
const lite = new PGlite({ extensions: contrib });
for (const m of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, m), 'utf8')); } catch { /* harness quirk */ } }
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* harness quirk */ }
const pg: any = (await import('pg')).default;
{
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release: () => void; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release!); };
  pg.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql: string, params: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pg.Pool.prototype.query = async function query(sql: string, params: unknown[]) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}
const RS: any = await import('../api/_lib/recordsStore.js');
const RV: any = await import('../api/_lib/reviewStore.js');
const ctx = { tenantKey: 'org_autocheck', tenantName: 'Desert Peak HVAC' };
const tenant = (await RS.getTenantContext(ctx.tenantKey, ctx.tenantName)).id;

let n = 0;
const uid = (k: number) => `f2${String(k).padStart(6, '0')}-0000-4000-8000-000000000001`;
async function doc(filename: string, type: string, facts: [string, number][] = [], text: string | null = 'page text', stage = 'mapped') {
  n++;
  const id = uid(n);
  await lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [id, tenant, filename, type, `h-${n}`, stage]);
  if (text != null) await lite.query(`INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)`, [id, tenant, text]);
  for (const [k, c] of facts) await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5)`, [tenant, id, k, k === 'cost' ? '55.00' : k === 'service_date' ? '2026-01-02' : 'Acme', c]);
  return id;
}
const stageOf = async (id: string) => (await lite.query(`SELECT stage, document_type, verified_by FROM documents WHERE id=$1`, [id])).rows[0];

const dReceipt = await doc('Receipt R-20135.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]]);
const dHuman = await doc('Receipt R-99999.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.7]]);
await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes) VALUES ($1,'review.document_classified','document',$2,$3::jsonb)`, [tenant, dHuman, JSON.stringify({ documentType: 'invoice' })]);
const dCoi = await doc('COI - Palo 2025.pdf', 'warranty-registration', [['warranty_expires', 0.9]]);
const dPo = await doc('PO-3104 Ridgeline.pdf', 'purchase-order', [['vendor', 0.95], ['cost', 0.95], ['invoice_number', 0.7]]);
const dInternal = await doc('Inventory Count 2025-07-18.pdf', 'internal', [['shop_address', 0.5], ['_audience_notified', 1]]);
const dUnreadable = await doc('photo_0146.jpg', 'other', [], null);
const dOtherOk = await doc('Reimbursement RR-2001.pdf', 'other', [['notes', 0.9]]);
const dOtherTextOnly = await doc('Misc.pdf', 'other', [], 'some text');
const dLowMoney = await doc('Invoice 24320.pdf', 'invoice', [['customer_name', 0.95], ['service_date', 0.95], ['cost', 0.7]]);
const dAddr = await doc('Work Order WO-1.pdf', 'work-order', [['service_address', 0.95], ['service_date', 0.95]]);

const reextracted: string[] = [];
const out = await RV.resortDocuments(ctx, { limit: 100 }, 'user_test', { reextract: async (_c: unknown, id: string) => { reextracted.push(id); } });

eq('receipt-named invoice with fields is retyped to receipt', (await stageOf(dReceipt)).document_type, 'receipt');
check('...and checked automatically afterwards', (await stageOf(dReceipt)).stage === 'verified');
check('...and was re-extracted after the retype', reextracted.includes(dReceipt));
eq('a type a person chose is not changed', (await stageOf(dHuman)).document_type, 'invoice');
eq('COI filed as warranty registration is retyped', (await stageOf(dCoi)).document_type, 'insurance-certificate');
check('...and checked (company paper, page text)', (await stageOf(dCoi)).stage === 'verified');
check('purchase order with a weak invoice number is checked', (await stageOf(dPo)).stage === 'verified');
check('internal with a weak letterhead and a synthetic row is checked', (await stageOf(dInternal)).stage === 'verified');
check('unreadable image is never checked', (await stageOf(dUnreadable)).stage === 'mapped');
check('other with a confident fact is checked', (await stageOf(dOtherOk)).stage === 'verified');
check('other with text but no confident fact waits for a person', (await stageOf(dOtherTextOnly)).stage === 'mapped');
check('an uncertain money amount is not checked', (await stageOf(dLowMoney)).stage === 'mapped');
check('an address with no link is still refused', (await stageOf(dAddr)).stage === 'mapped');
const bucket = (r: string) => (out.skipped[r] ?? []).map((x: any) => x.documentId);
check('skipped: type chosen by a person', bucket('type-chosen-by-person').includes(dHuman), JSON.stringify(out.skippedCounts));
check('skipped: unreadable', bucket('unreadable').includes(dUnreadable));
check('skipped: other needs a type', bucket('needs-type').includes(dOtherTextOnly));
check('skipped: amount not confirmed', bucket('amount-not-confirmed').includes(dLowMoney));
check('skipped: needs a link', bucket('needs-link').includes(dAddr));
check('counts match the lists', Object.entries(out.skippedCounts).every(([k, v]) => (out.skipped[k] ?? []).length === v));
eq('retyped count', out.retyped, 2);
const again = await RV.resortDocuments(ctx, { limit: 100 }, 'user_test', { reextract: null });
eq('idempotent: a second run retypes and checks nothing', [again.retyped, again.checked], [0, 0]);


/* ---- QA-fix round: privacy (HR), verified papers, dry run, undo ---- */
const hrNames: [string, string][] = [
  ['Pay Statement - Jane Doe.pdf', 'statement'], ['Severance Agreement - R Smith.pdf', 'agreement'], ['Receipt for relocation.pdf', 'receipt'],
  ['Offer Letter - Kim Tran.pdf', 'agreement'], ['Employment Agreement - L Cruz.pdf', 'agreement'], ['Termination Letter - P Ray.pdf', 'agreement'],
];
for (const [name] of hrNames) eq(`B1: HR letter "${name}" is never moved`, dt.resortDecision({ currentType: 'hr-letter', filename: name }), null);
eq('B1: HR source type removed', dt.RESORT_SOURCE_TYPES.has('hr-letter'), false);
eq('B1: award letter typed HR moves to agreement', dt.resortDecision({ currentType: 'hr-letter', filename: 'Grant Award Letter 2026.pdf' }), 'agreement');
eq('B1: ...by title text too', dt.resortDecision({ currentType: 'hr-letter', filename: 'scan.pdf', titleText: 'award letter' }), 'agreement');
eq('B1: ...but not with a People and HR choice', dt.resortDecision({ currentType: 'hr-letter', filename: 'Award Letter.pdf', hrOverride: true }), null);
eq('B1: an HR choice blocks any type', dt.resortDecision({ currentType: 'invoice', filename: 'Receipt R-1.pdf', hrOverride: true }), null);
eq('B2: a checked paper is never retyped', dt.resortDecision({ currentType: 'invoice', filename: 'Receipt R-1.pdf', verified: true }), null);
const F = (k: string, c = 0.95) => ({ field_key: k, value: 'x', confidence: c });
eq('S2: zero facts + unsupported name is not checked', dt.autoCheckDecision('schedule', [], { hasText: true, filename: 'Pledge Form PL-2025-019 Bishop.pdf' }).reason, 'needs-type');
eq('S2: ...Scan 163 (retail store).jpg typed schedule', dt.autoCheckDecision('schedule', [], { hasText: true, filename: 'Scan 163 (retail store).jpg' }).ok, false);
eq('S2: zero facts + supporting name is checked', dt.autoCheckDecision('price-list', [], { hasText: true, filename: 'Summit Price List Aug 2026.csv' }).ok, true);
eq('S2: zero facts + supporting title is checked', dt.autoCheckDecision('price-list', [], { hasText: true, filename: 'scan.pdf', title: 'Price list' }).ok, true);
eq('S2: zero facts with no name at all is not checked', dt.autoCheckDecision('price-list', [], { hasText: true }).ok, false);
for (const n of ['Consignment Agreement - Little Kiln Studio (2).pdf', 'Invoice 1 (copy).pdf', 'Copy of Price List.pdf', 'Budget FY2026 v2.csv'])
  eq(`S2: likely copy "${n}" is never checked`, dt.autoCheckDecision('agreement', [F('customer_name'), F('agreement_term')], { hasText: true, filename: n }).reason, 'likely-copy');
eq('S2: a plain name with facts still checks', dt.autoCheckDecision('price-list', [F('vendor')], { hasText: true, filename: 'Beacon Price List.pdf' }).ok, true);

const RUN = '9a000000-0000-4000-8000-0000000000aa';
const hrIds: string[] = [];
for (const [name, ty] of [['Pay Statement - Jane Doe.pdf', 'hr-letter'], ['Severance Agreement - R Smith.pdf', 'hr-letter'], ['Receipt for relocation.pdf', 'hr-letter']] as const) hrIds.push(await doc(name, ty, [['employee_name', 0.9]]));
const dHrOv = await doc('Receipt R-55555.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]]);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'_company_folder','people-hr',1)`, [tenant, dHrOv]);
const dVerHuman = await doc('Receipt R-20117.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]], 'page text', 'verified');
await lite.query(`UPDATE documents SET verified_by='user_x' WHERE id=$1`, [dVerHuman]);
const dVerAi = await doc('Receipt R-20118.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]], 'page text', 'verified');
await lite.query(`UPDATE documents SET verified_by='ai' WHERE id=$1`, [dVerAi]);
const dMove = await doc('Receipt R-60001.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]]);
const dTouched = await doc('Receipt R-60002.pdf', 'invoice', [['vendor', 0.95], ['service_date', 0.95], ['cost', 0.95]]);
const snap = async () => JSON.stringify((await lite.query(`SELECT id, document_type, stage, verified_by FROM documents ORDER BY id`)).rows) + (await lite.query(`SELECT count(*)::int AS c FROM audit_log`)).rows[0].c;
const before = await snap();
const plan = await RV.resortDocuments(ctx, { limit: 200, dryRun: true }, 'user_test', { reextract: null });
eq('dryRun writes nothing', await snap(), before);
check('dryRun lists the planned moves and checks', plan.dryRun === true && plan.wouldMove >= 2 && plan.wouldCheck >= 2 && plan.moves.some((m: any) => m.documentId === dMove), JSON.stringify([plan.wouldMove, plan.wouldCheck]));
check('dryRun never plans an HR paper, an HR-choice paper or a checked paper', ![...hrIds, dHrOv, dVerHuman, dVerAi].some((id) => plan.moves.some((m: any) => m.documentId === id)));
const run2 = await RV.resortDocuments(ctx, { limit: 200, runId: RUN }, 'user_test', { reextract: null });
for (const id of hrIds) eq('B1: HR paper keeps its type after the real run', (await stageOf(id)).document_type, 'hr-letter');
eq('B1: a paper with a People and HR choice is not moved', (await stageOf(dHrOv)).document_type, 'invoice');
eq('B2: person-checked paper keeps its type', (await stageOf(dVerHuman)).document_type, 'invoice');
eq('B2: AI-checked paper keeps its type', (await stageOf(dVerAi)).document_type, 'invoice');
eq('real run moves the plain receipt', (await stageOf(dMove)).document_type, 'receipt');
check('the run reports its id', run2.runId === RUN);
await lite.query(`UPDATE documents SET stage='verified', verified_by='user_y' WHERE id=$1`, [dTouched]);
await lite.query(`INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at) VALUES ($1,'review.field_corrected','document',$2,'{}'::jsonb, NOW() + interval '1 minute')`, [tenant, dTouched]);
const wasAiChecked = (await stageOf(dMove)).verified_by === 'ai';
const und = await RV.undoResort(ctx, { runId: RUN }, 'user_test');
eq('undo restores the earlier type', (await stageOf(dMove)).document_type, 'invoice');
if (wasAiChecked) eq('undo un-checks what the run checked', (await stageOf(dMove)).stage === 'verified', false);
eq('undo leaves a paper a person has since checked alone', (await stageOf(dTouched)).verified_by, 'user_y');
check('undo reports counts', und.restoredTypes >= 2, JSON.stringify(und));
let badRun = false; try { await RV.undoResort(ctx, { runId: 'nope' }, 'u'); } catch { badRun = true; }
check('undo needs a valid run id', badRun);

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} checks passed`);
process.exit(failures ? 1 : 0);
