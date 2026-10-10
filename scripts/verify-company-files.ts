// npm run verify:company-files
// Company Files: which folder a paper lives in, over-filing safety, People and HR access (server side, in every path that can
// return a document), move / undo / "always file {vendor} here", tenant scoping, and that the browser and server copies agree.
// Pure checks first, then the real SQL against Postgres (PGlite, loaded from M3-config/*.sql, queried as the app's NOBYPASSRLS role).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as dt from '../src/domains/hvac/documentTypes.ts';
import * as cfTs from '../src/core/companyFiles.ts';
// @ts-expect-error plain JS module without types
import * as cf from '../api/_lib/companyFiles.js';
// @ts-expect-error plain JS module without types
import * as backendDocTypes from '../api/_lib/documentTypes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('verify:company-files');

/* ============================================================ 1. mapping: every document type, with the deciding rules */
type Case = { name: string; type: string; fields?: Record<string, string>; title?: string; linked?: boolean; want: string | null };
const OWN = ['Desert Peak HVAC'];
const CASES: Case[] = [
  // always customer paper
  { name: 'work-order', type: 'work-order', fields: { service_address: '1 Elm St' }, want: null },
  { name: 'service-ticket (even with no customer)', type: 'service-ticket', want: null },
  { name: 'startup-sheet', type: 'startup-sheet', want: null },
  { name: 'nameplate-photo', type: 'nameplate-photo', want: null },
  { name: 'equipment-record', type: 'equipment-record', want: null },
  { name: 'warranty-registration', type: 'warranty-registration', want: null },
  { name: 'inspection-report', type: 'inspection-report', want: null },
  { name: 'maintenance-agreement', type: 'maintenance-agreement', fields: { customer_name: 'Pat Lee' }, want: null },
  // proposal / quote: ours = customer, one received from a vendor = vendor
  { name: 'proposal-quote for a customer', type: 'proposal-quote', fields: { customer_name: 'Pat Lee' }, want: null },
  { name: 'proposal-quote received from a vendor', type: 'proposal-quote', fields: { vendor: 'Carrier Supply' }, want: 'suppliers-vendors' },
  // dispatch note
  { name: 'dispatch-note with a customer', type: 'dispatch-note', fields: { customer_name: 'Pat Lee' }, want: null },
  { name: 'dispatch-note with no customer', type: 'dispatch-note', want: 'schedules-operations' },
  // invoice: bill-to / issuer
  { name: 'invoice billed to a customer', type: 'invoice', fields: { customer_name: 'Acme Roofing', cost: '10' }, want: null },
  { name: 'invoice with a service address', type: 'invoice', fields: { vendor: 'Hale Law', service_address: '5 Elm St' }, want: null },
  { name: 'invoice from a law firm', type: 'invoice', fields: { vendor: 'Hale Law', cost: '900' }, want: 'money-in-out' },
  { name: 'invoice from a bookkeeper', type: 'invoice', fields: { vendor: 'Ledger Bookkeeping LLC', cost: '300' }, want: 'money-in-out' },
  { name: 'invoice from a supplier', type: 'invoice', fields: { vendor: 'Beacon Roofing Supply', cost: '300' }, want: 'suppliers-vendors' },
  { name: 'invoice billed to the company itself', type: 'invoice', fields: { vendor: 'Beacon Roofing Supply', customer_name: 'Desert Peak HVAC, LLC', cost: '300' }, want: 'suppliers-vendors' },
  { name: 'invoice with no vendor and no customer evidence is not guessed as a supplier', type: 'invoice', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24332 - Perkins (copy).pdf', type: 'invoice', title: 'Invoice 24332 - Perkins (copy).pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24338 - Bridgeway.pdf', type: 'invoice', title: 'Invoice 24338 - Bridgeway.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24342 - Gomez.pdf', type: 'invoice', title: 'Invoice 24342 - Gomez.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24316 - Saguaro.xlsx', type: 'invoice', title: 'Invoice 24316 - Saguaro.xlsx', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24350 - Hartwell Dental.pdf', type: 'invoice', title: 'Invoice 24350 - Hartwell Dental.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24361 - Mesa Bakery.pdf', type: 'invoice', title: 'Invoice 24361 - Mesa Bakery.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24370 - Lopez.docx', type: 'invoice', title: 'Invoice 24370 - Lopez.docx', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24377 - Ridgeline HOA.pdf', type: 'invoice', title: 'Invoice 24377 - Ridgeline HOA.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Pay App 3 - Meridian.pdf', type: 'invoice', title: 'Pay App 3 - Meridian.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Pay App 7.pdf', type: 'invoice', title: 'Pay App 7.pdf', want: null },
  { name: 'outgoing customer invoice by file name: Invoice 24399.pdf', type: 'invoice', title: 'Invoice 24399.pdf', want: null },
  // receipt
  { name: 'receipt', type: 'receipt', fields: { vendor: 'Desert Supply', cost: '48' }, want: 'money-in-out' },
  { name: 'receipt with only a bill-to name stays a company file', type: 'receipt', fields: { vendor: 'Desert Supply', customer_name: 'Pat Lee' }, want: 'money-in-out' },
  { name: 'receipt with a service address is customer paper', type: 'receipt', fields: { vendor: 'Desert Supply', service_address: '5 Elm St' }, want: null },
  // statement: by issuer
  { name: 'statement from a bank', type: 'statement', fields: { vendor: 'Chase Bank' }, want: 'money-in-out' },
  { name: 'fuel card statement', type: 'statement', fields: { vendor: 'FleetCor Fuel Card' }, want: 'money-in-out' },
  { name: 'statement from a vendor', type: 'statement', fields: { vendor: 'Beacon Roofing Supply' }, want: 'suppliers-vendors' },
  { name: 'statement we sent a customer', type: 'statement', fields: { customer_name: 'Acme Roofing' }, want: null },
  // purchasing
  { name: 'purchase-order', type: 'purchase-order', fields: { vendor: 'Carrier Supply', cost: '334' }, want: 'purchasing' },
  { name: 'purchase-order with a job number is customer paper', type: 'purchase-order', fields: { vendor: 'Carrier Supply', job_number: 'J-77' }, want: null },
  { name: 'delivery-ticket from a vendor', type: 'delivery-ticket', fields: { vendor: 'Valley Freight' }, want: 'purchasing' },
  { name: 'delivery-ticket naming a customer job', type: 'delivery-ticket', fields: { customer_name: 'Lena Ortiz' }, want: null },
  { name: 'price-list', type: 'price-list', fields: { vendor: 'Beacon Roofing Supply' }, want: 'suppliers-vendors' },
  // agreements: by counterparty
  { name: 'agreement with a customer', type: 'agreement', fields: { customer_name: 'Acme Roofing' }, want: null },
  { name: 'NDA with a company', type: 'agreement', fields: { vendor: 'Acme Holdings' }, title: 'NDA - Acme.pdf', want: 'insurance-legal' },
  { name: 'lease', type: 'agreement', fields: { vendor: 'Sunset Properties' }, title: 'Office Lease.pdf', want: 'company-admin' },
  { name: 'rental agreement', type: 'agreement', fields: { vendor: 'Mesa Equipment Rental' }, want: 'company-admin' },
  { name: 'grant agreement', type: 'agreement', fields: { vendor: 'State Grants Office' }, title: 'Grant agreement.pdf', want: 'insurance-legal' },
  // permit: by service address
  { name: 'permit with a service address', type: 'permit', fields: { service_address: '5 Elm St', permit_number: 'BP-1' }, want: null },
  { name: 'company license / permit', type: 'permit', fields: { permit_number: 'LIC-9' }, want: 'insurance-legal' },
  // people, insurance, schedules
  { name: 'hr-letter', type: 'hr-letter', fields: { customer_name: 'J Smith' }, want: 'people-hr' },
  { name: 'hr-letter stays in People and HR even with an address', type: 'hr-letter', fields: { service_address: '9 Home Ave' }, linked: true, want: 'people-hr' },
  { name: 'insurance-certificate', type: 'insurance-certificate', fields: { vendor: 'Acme Insurance' }, want: 'insurance-legal' },
  { name: 'schedule', type: 'schedule', fields: { notes: 'Mon Ana' }, want: 'schedules-operations' },
  // correspondence: by customer found
  { name: 'correspondence naming a customer', type: 'correspondence', fields: { customer_name: 'Pat Lee' }, want: null },
  { name: 'correspondence with no customer', type: 'correspondence', fields: { notes: 'Welcome' }, want: 'company-admin' },
  { name: 'internal', type: 'internal', fields: { shop_address: '2210 E Main' }, want: 'company-admin' },
  { name: 'other with nothing on it goes to Company and admin', type: 'other', want: 'company-admin' },
  { name: 'unclassified (no type yet) is not a company file', type: '', want: null },
];
const typeIds = new Set(dt.DOCUMENT_TYPES.map((t: { id: string }) => t.id));
for (const c of CASES) {
  const doc = { type: c.type, fields: c.fields, title: c.title, linkedCustomer: c.linked };
  eq(`mapping: ${c.name}`, cf.companyFolderFor(doc, { companyNames: OWN }), c.want);
  eq(`mapping (browser copy): ${c.name}`, cfTs.companyFolderFor(doc, { companyNames: OWN }), c.want);
  check(`isCompanyFile agrees: ${c.name}`, cf.isCompanyFile(doc, { companyNames: OWN }) === (c.want !== null));
}
const covered = new Set(CASES.map((c) => c.type));
check('every document type has at least one mapping case', [...typeIds].every((t) => covered.has(t as string)), [...typeIds].filter((t) => !covered.has(t as string)).join(', '));
eq('stored spellings resolve ("service_report", "Maintenance_Plan")', [cf.companyFolderFor({ type: 'service_report' }), cf.companyFolderFor({ type: 'Maintenance_Plan', fields: { vendor: 'X' } })], [null, null]);
eq('folders: seven, approved names, in order', cf.COMPANY_FOLDERS.map((f: { label: string }) => f.label), [
  'Suppliers and vendors', 'Purchasing', 'Money in and out', 'People and HR', 'Insurance and legal', 'Company and admin', 'Schedules and operations',
]);
eq('layouts: vendor for the first three, month for schedules', cf.COMPANY_FOLDERS.map((f: { layout: string }) => f.layout), ['vendor', 'vendor', 'vendor', 'kind', 'kind', 'kind', 'month']);

/* ============================================================ 2. over-filing safety */
{
  // Customer evidence wins for every type that is not always company paper.
  for (const t of ['invoice', 'agreement', 'permit', 'correspondence', 'internal', 'other', 'statement', 'delivery-ticket', 'dispatch-note']) {
    eq(`over-filing: ${t} with a customer name is customer paper`, cf.companyFolderFor({ type: t, fields: { customer_name: 'Pat Lee', vendor: t === 'statement' ? undefined : 'Acme Co' } }), null);
    eq(`over-filing: ${t} with a service address is customer paper`, cf.companyFolderFor({ type: t, fields: { service_address: '5 Elm St', vendor: 'Acme Co' } }), null);
    eq(`over-filing: ${t} with a job number is customer paper`, cf.companyFolderFor({ type: t, fields: { job_number: 'J-9', vendor: 'Acme Co' } }), null);
    eq(`over-filing: ${t} linked to a customer is customer paper`, cf.companyFolderFor({ type: t, fields: { vendor: 'Acme Co' }, linkedCustomer: true }), null);
  }
  // Always-company types are not pulled by a vendor / bill-to name or a link, but an address or job number does pull them.
  for (const t of ['receipt', 'purchase-order', 'schedule', 'price-list', 'insurance-certificate']) {
    check(`over-filing: ${t} is never pulled to a customer by a name or a link`, cf.companyFolderFor({ type: t, fields: { vendor: 'Beacon', customer_name: 'Pat Lee' }, linkedCustomer: true }) !== null);
    eq(`over-filing: ${t} with a service address is customer paper`, cf.companyFolderFor({ type: t, fields: { service_address: '5 Elm St' } }), null);
    eq(`over-filing: ${t} with a job number is customer paper`, cf.companyFolderFor({ type: t, fields: { job_number: 'J-9' } }), null);
  }
  // Customer types are never company files unless a person moves them.
  eq('over-filing: a work order is never a company file by itself', cf.companyFolderFor({ type: 'work-order', fields: { vendor: 'Beacon' } }), null);
  eq('a person can move a customer-type paper into a folder', cf.companyFolderFor({ type: 'work-order', override: 'purchasing' }), 'purchasing');
  eq('a person can send a company paper to the customer side', cf.companyFolderFor({ type: 'price-list', fields: { vendor: 'Beacon' }, override: 'customer' }), null);
  check('titleNamesCustomer: dash-customer and Pay App names', cf.titleNamesCustomer('Invoice 24332 - Perkins (copy)') && cf.titleNamesCustomer('Pay App 3') && cfTs.titleNamesCustomer('Invoice 24338 - Bridgeway') && !cf.titleNamesCustomer('Beacon Statement'));
  eq('a bogus saved choice is ignored', cf.companyFolderFor({ type: 'price-list', fields: { vendor: 'Beacon' }, override: 'nope' }), 'suppliers-vendors');
  // Reuses documentTypes flags: everything the app already calls company paperwork is a company file here (no customer evidence).
  const flagged = [...backendDocTypes.COMPANY_RECORD_TYPES] as string[];
  check('every company-record type from documentTypes.js is a company file', flagged.every((t) => cf.companyFolderFor({ type: t, fields: { vendor: 'Acme' } }) !== null), flagged.join(','));
  eq('flags mirror: browser and server list the same company-record and link-optional types', [cf.RELIED_ON_FLAGS, cfTs.RELIED_ON_FLAGS].map((x: unknown) => JSON.stringify(x)).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).length, 1);
  check('company-record types in the server table are the ones this module relies on', JSON.stringify(cf.RELIED_ON_FLAGS.companyRecordTypes) === JSON.stringify([...backendDocTypes.COMPANY_RECORD_TYPES].sort()));
  check('"other" (no customer, no address) is company paper in both copies and in the document-type table', JSON.stringify(cf.RELIED_ON_FLAGS.companyIfNoCustomerOrAddressTypes) === JSON.stringify([...backendDocTypes.COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES].sort()) && cf.companyFolderFor({ type: 'other', fields: {} }) === 'company-admin' && cfTs.companyFolderFor({ type: 'other', fields: {} }) === 'company-admin' && cf.companyFolderFor({ type: 'other', fields: { service_address: '5 Elm St' } }) === null);
  check('link-optional types in the server table are the ones this module relies on', JSON.stringify(cf.RELIED_ON_FLAGS.linkOptionalTypes) === JSON.stringify([...backendDocTypes.LINK_OPTIONAL_TYPES].sort()));
}

/* ============================================================ 3. Check these, copies, dates */
{
  const info = (type: string, fields: Record<string, string>) => cf.companyFolderInfo({ type, fields });
  eq('no total on a receipt', cf.checkReasons({ type: 'receipt', fields: { vendor: 'X' }, info: info('receipt', { vendor: 'X' }) }), ['no-total']);
  eq('a total clears it', cf.checkReasons({ type: 'receipt', fields: { cost: '4' }, info: info('receipt', { cost: '4' }) }), []);
  eq('unreadable beats no total', cf.checkReasons({ type: 'invoice', fields: {}, info: info('invoice', { vendor: 'Hale Law' }), unreadable: true }), ['hard-to-read']);
  eq('a copy', cf.checkReasons({ type: 'invoice', fields: { cost: '1' }, info: info('invoice', { vendor: 'V', cost: '1' }), copy: true }), ['might-be-copy']);
  eq('"other" is a best guess: Not sure this is the right folder', cf.checkReasons({ type: 'other', fields: {}, info: info('other', {}) }), ['unsure-folder']);
  eq('a person-chosen folder is never "not sure"', cf.checkReasons({ type: 'other', fields: {}, info: cf.companyFolderInfo({ type: 'other', override: 'company-admin' }) }), []);
  eq('labels are the approved wording', cf.CHECK_REASON_LABEL, { 'hard-to-read': 'Hard to read', 'no-total': 'No total found', 'might-be-copy': 'Might be a copy', 'unsure-folder': 'Not sure this is the right folder' });
  eq('copy key needs vendor, number and total', [cf.copyKey('invoice', { vendor: 'Beacon Inc.', invoice_number: 'A1', cost: '$10.00' }), cf.copyKey('invoice', { vendor: 'Beacon', invoice_number: 'A1' })], ['invoice|beacon|a1|10.00', '']);
  eq('vendor key merges spellings', [cf.vendorKey('Beacon Roofing Supply, Inc.'), cf.vendorKey('BEACON ROOFING SUPPLY'), cf.vendorKey('The Beacon Co')], ['beacon roofing supply', 'beacon roofing supply', 'beacon']);
  eq('end date from a term range', cf.parseEndDate('01/01/2025 - 12/31/2025'), '2025-12-31');
  eq('end date from ISO and long forms', [cf.parseEndDate('2026-11-15'), cf.parseEndDate('Valid through March 3, 2027')], ['2026-11-15', '2027-03-03']);
  eq('expiry keys read the existing fields', [cf.expiryDateFor({ coi_expires: '2026-11-15' }), cf.expiryDateFor({ lease_end_date: '2027-01-31' }), cf.expiryDateFor({ agreement_term: '01/01/2026 - 06/30/2026' }), cf.expiryDateFor({})], ['2026-11-15', '2027-01-31', '2026-06-30', null]);
  eq('coming up: 60 days ahead, expired, far away', [cf.expiryState('2026-12-01', '2026-10-09'), cf.expiryState('2026-12-08', '2026-10-09'), cf.expiryState('2026-12-09', '2026-10-09'), cf.expiryState('2026-10-08', '2026-10-09'), cf.expiryState(null, '2026-10-09')], ['upcoming', 'upcoming', null, 'expired', null]);
}

/* ============================================================ 4. People and HR access (pure) */
{
  const admin = { userId: 'a', orgId: 'org', orgRole: 'admin' };
  const member = { userId: 'm', orgId: 'org', orgRole: 'member' };
  const solo = { userId: 's', orgId: null, orgRole: null };
  const none = cf.normalizeCompanyFilesSettings(undefined);
  const allMembers = cf.normalizeCompanyFilesSettings({ hrAccess: { roles: ['member', 'owner'], members: [] } });
  const oneMember = cf.normalizeCompanyFilesSettings({ hrAccess: { roles: [], members: ['m'] } });
  eq('default: admin yes, member no, solo yes', [cf.canSeeHr(admin, none), cf.canSeeHr(member, none), cf.canSeeHr(solo, none)], [true, false, true]);
  eq('granted to members: all members yes', [cf.canSeeHr(member, allMembers), cf.canSeeHr({ ...member, userId: 'z' }, allMembers)], [true, true]);
  eq('granted to one member: only that member', [cf.canSeeHr(member, oneMember), cf.canSeeHr({ ...member, userId: 'z' }, oneMember)], [true, false]);
  eq('signed out sees nothing', cf.canSeeHr(null, none), false);
  eq('unknown roles in settings are dropped', allMembers.hrAccess.roles, ['member']);
  eq('without access People and HR is not a folder', cf.visibleFolders(false).map((f: { id: string }) => f.id).includes('people-hr'), false);
  eq('with access it is the fourth folder', cf.visibleFolders(true)[3].id, 'people-hr');
  eq('vendor rules never point at People and HR', Object.keys(cf.normalizeCompanyFilesSettings({ vendorRules: { a: 'people-hr', b: 'purchasing', c: 'bogus' } }).vendorRules), ['b']);
}

/* ============================================================ 5. move, undo, vendor memory (pure) */
{
  const s0 = cf.normalizeCompanyFilesSettings({});
  const plan = cf.planMove({ to: 'purchasing' }, { vendor: 'Beacon Roofing Supply, Inc.', canHr: false, currentFolder: 'suppliers-vendors' });
  eq('move: "always file here" is on by default', plan.rule, { key: 'beacon roofing supply', folder: 'purchasing' });
  eq('move: switched off keeps no rule', cf.planMove({ to: 'purchasing', alwaysFile: false }, { vendor: 'Beacon', canHr: false, currentFolder: null }).rule, null);
  eq('move: no vendor, no rule', cf.planMove({ to: 'purchasing' }, { vendor: null, canHr: false, currentFolder: null }).rule, null);
  eq('move: to a customer keeps no rule', cf.planMove({ to: 'customer' }, { vendor: 'Beacon', canHr: false, currentFolder: null }).rule, null);
  eq('move: unknown folder refused', cf.planMove({ to: 'nope' }, { vendor: null, canHr: true, currentFolder: null }).ok, false);
  eq('move: into People and HR needs access', [cf.planMove({ to: 'people-hr' }, { vendor: null, canHr: false, currentFolder: null }).ok, cf.planMove({ to: 'people-hr' }, { vendor: null, canHr: true, currentFolder: null }).ok], [false, true]);
  eq('move: out of People and HR needs access', cf.planMove({ to: 'company-admin' }, { vendor: null, canHr: false, currentFolder: 'people-hr' }).ok, false);
  eq('move: People and HR never gets a vendor rule', cf.planMove({ to: 'people-hr' }, { vendor: 'Beacon', canHr: true, currentFolder: null }).rule, null);
  const applied = cf.applyMoveToSettings(s0, plan);
  eq('rule saved', applied.settings.vendorRules, { 'beacon roofing supply': 'purchasing' });
  eq('rule makes the next paper from that vendor follow', cf.companyFolderFor({ type: 'price-list', fields: { vendor: 'BEACON ROOFING SUPPLY' } }, { vendorRules: applied.settings.vendorRules }), 'purchasing');
  eq('rule never pulls customer paper in', cf.companyFolderFor({ type: 'invoice', fields: { vendor: 'Beacon Roofing Supply', customer_name: 'Pat' } }, { vendorRules: applied.settings.vendorRules }), null);
  eq('a person-chosen folder beats the rule', cf.companyFolderFor({ type: 'price-list', fields: { vendor: 'Beacon Roofing Supply' }, override: 'money-in-out' }, { vendorRules: applied.settings.vendorRules }), 'money-in-out');
  eq('undo removes the rule it added', cf.undoRuleInSettings(applied.settings, applied.ruleKey, applied.previousRule).vendorRules, {});
  const again = cf.applyMoveToSettings(applied.settings, cf.planMove({ to: 'money-in-out' }, { vendor: 'Beacon Roofing Supply', canHr: false, currentFolder: null }));
  eq('undo restores the previous rule', cf.undoRuleInSettings(again.settings, again.ruleKey, again.previousRule).vendorRules, { 'beacon roofing supply': 'purchasing' });
}

/* ============================================================ 6. browser copy and server copy are the same */
{
  const bodyOf = (code: string) => code.slice(code.indexOf('// ---- SHARED BODY'));
  const norm = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}();,:=<>+\-*&|?]) ?/g, '$1').trim();
  const tsSrc = read('src/core/companyFiles.ts');
  const transpiled = ts.transpileModule(tsSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const jsSrc = read('api/_lib/companyFiles.js');
  check('the shared body below the marker is the same text (types stripped)', norm(bodyOf(transpiled)) === norm(bodyOf(jsSrc)), 'edit both files together');
  eq('same exports', Object.keys(cf).sort(), Object.keys(cfTs).sort());
  eq('same folders and labels', cf.COMPANY_FOLDERS, cfTs.COMPANY_FOLDERS);
  // behaviour: both copies on a generated matrix
  const types = [...typeIds, '', 'weird'] as string[];
  const factSets = [{}, { vendor: 'Beacon Inc' }, { customer_name: 'Pat Lee' }, { service_address: '5 Elm' }, { vendor: 'Hale Law', cost: '9' }, { job_number: 'J1', vendor: 'V' }, { vendor: 'Chase Bank' }, { customer_name: 'Desert Peak HVAC' }];
  let same = true;
  for (const t of types) for (const f of factSets) for (const linked of [false, true]) for (const override of [null, 'purchasing', 'customer']) {
    const d = { type: t, fields: f, linkedCustomer: linked, override, title: 'Lease' };
    if (JSON.stringify(cf.companyFolderInfo(d, { companyNames: OWN })) !== JSON.stringify(cfTs.companyFolderInfo(d, { companyNames: OWN }))) same = false;
  }
  check('both copies agree on every type x facts x link x saved-choice combination', same);
  check('the screen imports the browser copy, the server the shared JS', read('src/components/companyFiles/CompanyFilesPanel.tsx').includes("'../../core/companyFiles'") && read('api/_lib/companyFilesStore.js').includes("'./companyFiles.js'"));
}

/* ============================================================ 7. SQL text: tenant scoped, parameterised */
{
  const store = read('api/_lib/companyFilesStore.js');
  const sqls = [...store.matchAll(/(?:query|q)\(\s*`([\s\S]*?)`/g)].map((m) => m[1] as string);
  check('the store has SQL to check', sqls.length >= 10, String(sqls.length));
  const tableStmts = sqls.filter((s) => /\b(FROM|UPDATE|INTO)\s+(documents|extractions|tenants|entities|document_entity_links)\b/i.test(s));
  check('every statement that touches a table carries the tenant predicate', tableStmts.every((s) => /tenantOf\(|\$\{TENANT|\$\{TENANT\.replace|app\.tenant_id/.test(s)), tableStmts.filter((s) => !/tenantOf\(|\$\{TENANT|app\.tenant_id/.test(s)).join('\n---\n'));
  check('no caller text is spliced into SQL (only constants and helpers)', ![...sqls.join('\n').matchAll(/\$\{([^}]+)\}/g)].some((m) => /\b(payload|documentId|to|q|folder|vendor|req|body)\b/.test(m[1] as string) && !/tenantOf|TENANT|nameCol|overrideExists|CANDIDATE_CAP|docIdExpr|alias|COMPANY_FOLDER_FIELD_KEY|HR_FOLDER_ID/.test(m[1] as string)));
  check('the hr gate reads the saved choice and the HR type, tenant scoped', /hrGateSql[\s\S]*?hx\.tenant_id = /.test(store) || (store.match(/function hrGateSql[\s\S]*?\n}/)?.[0] ?? '').includes('tenant_id'));
  check('writes: delete-then-insert of the saved choice, tenant scoped', /DELETE FROM extractions WHERE document_id = \$1 AND field_key = \$2 AND \$\{TENANT\}/.test(store) && store.includes("(current_setting('app.tenant_id', true))::uuid"));
  check('settings are written with a bound jsonb, to this tenant only', /UPDATE tenants SET settings = COALESCE\(settings, '\{\}'::jsonb\) \|\| jsonb_build_object\('companyFiles', \$1::jsonb\)\s+WHERE \$\{TENANT\.replace\('tenant_id', 'id'\)\}/.test(store));
  const rs = read('api/_lib/recordsStore.js');
  check('records browse: the HR fragment is added to every query form', rs.includes("if (f.hideHr) add('hrGate', hrGateSql('d'))") && rs.includes("'q', 'hrGate'"));
  const rec = read('api/records.ts');
  check('records.ts: every read that can return a document passes hideHr', ['getDocument(payload.id, { hideHr })', 'getPage(payload.id, n, { hideHr })', 'listDocuments(payload.filters, { hideHr })', "facets: payload.facets === false ? 'none' : 'inline', hideHr", 'browseFacets(payload.filters, { currentUserId: auth.userId, hideHr })', 'limit: payload.limit, hideHr', 'listFacetsByDocument(payload.documentId, { hideHr })', 'getFacet(payload.id, { hideHr })', 'getExtraction(payload.id, { hideHr })', 'listExtractionsByDocument(payload.documentId, { hideHr })', 'listExtractionsByDocuments(payload.documentIds, { hideHr })', 'listExtractionsByEntity(payload.entityId, { hideHr })', 'runBootstrap(db, auth, payload, hideHr)'].every((x) => rec.includes(x)));
  check('records.ts: the access decision comes from the verified token and tenant settings, never the payload', /const hideHr = isAdmin \|\| !HR_AWARE_ACTIONS\.has\(String\(action\)\) \? false : !\(await db\.hrAllowed\(auth\)\)/.test(rec) && !/payload\.(canHr|hideHr|canSeeHr)/.test(rec));
  check('records.ts: the HR access setting is an admin action', /RECORDS_ADMIN_ACTIONS[\s\S]*?'setCompanyFilesHrAccess'[\s\S]*?\]\);/.test(rec));
  check('api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
  check('forbidden lanes untouched by this file set', !/companyFiles/.test(read('api/ask.js')));
}

/* ============================================================ 8. the real SQL, in Postgres */
let PGlite: any;
const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const m of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[m] = ((await import(`@electric-sql/pglite/contrib/${m}`)) as any)[m];
} catch (err) {
  console.log(`  SKIP database-backed checks: PGlite is not installed (${(err as Error)?.message})`);
}
if (PGlite) {
  process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
  delete process.env.ANTHROPIC_API_KEY;
  const lite = new PGlite({ extensions: contrib });
  const cfgDir = path.join(ROOT, 'M3-config');
  for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
    try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as verify-records-browse */ }
  }
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after resolve_tenant() exists */ }
  const pgMod = ((await import('pg')) as any).default;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql: string, params: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql: string, params: unknown[]) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };

  const RECORDS: any = await import('../api/records.ts');
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const KA = 'org_cf_a';
  const KB = 'org_cf_b';
  const tenA = (await getTenantContext(KA, KA)).id;
  const tenB = (await getTenantContext(KB, KB)).id;
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Desert Peak HVAC', tenA]);
  await lite.query('UPDATE tenants SET name = $1 WHERE id = $2', ['Rival Shop', tenB]);

  const today = new Date().toISOString().slice(0, 10);
  const plus = (n: number) => cf.addDaysIso(today, n);
  const hex = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const id = (t: 'a' | 'b', n: number) => (t === 'a' ? hex(n) : hex(1000 + n));
  const doc = async (t: 'a' | 'b', n: number, type: string | null, fields: Record<string, string>, o: { created?: string; stage?: string; err?: string; file?: string } = {}) => {
    const tenantId = t === 'a' ? tenA : tenB;
    await lite.query(
      `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, extract_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id(t, n), tenantId, o.file ?? `file-${t}${n}.pdf`, type, `h-${t}-${n}`, o.stage ?? 'read', o.created ?? `2026-09-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00Z`, o.err ?? null]
    );
    for (const [k, v] of Object.entries(fields)) {
      await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.95)', [tenantId, id(t, n), k, v]);
    }
  };
  // Tenant A
  await doc('a', 1, 'price-list', { vendor: 'Beacon Roofing Supply', service_date: '2026-08-01' }, { file: 'Beacon price list Aug.pdf' });
  await doc('a', 2, 'price-list', { vendor: 'Beacon Roofing Supply, Inc.', service_date: '2026-10-01' }, { file: 'Beacon price list Oct.pdf' });
  await doc('a', 3, 'hr-letter', { customer_name: 'J Smith' }, { file: 'Offer Letter - J Smith.pdf' });
  await doc('a', 4, 'receipt', { vendor: 'Desert Supply', cost: '48.20' });
  await doc('a', 5, 'invoice', { customer_name: 'Acme Roofing', cost: '500' });
  await doc('a', 6, 'invoice', { vendor: 'Hale Law', cost: '900', invoice_number: 'L-1' });
  await doc('a', 7, 'insurance-certificate', { vendor: 'Acme Insurance', coi_expires: plus(20) }, { file: 'COI new.pdf', created: '2026-10-02T00:00:00Z' });
  await doc('a', 8, 'insurance-certificate', { vendor: 'Acme Insurance', coi_expires: plus(-30) }, { file: 'COI old.pdf', created: '2026-01-02T00:00:00Z' });
  await doc('a', 9, 'work-order', { service_address: '1 Elm St' });
  await doc('a', 10, 'receipt', { vendor: 'Desert Supply' }, { file: 'Receipt no total.pdf' });
  await doc('a', 11, 'invoice', { vendor: 'Beacon Roofing Supply', invoice_number: 'INV-1', cost: '100' });
  await doc('a', 12, 'invoice', { vendor: 'Beacon Roofing Supply', invoice_number: 'INV-1', cost: '100' }, { file: 'copy of INV-1.pdf' });
  await doc('a', 13, 'other', {}, { stage: 'received', err: 'ocr failed', file: 'blank scan.pdf' });
  await doc('a', 14, 'schedule', { notes: 'Mon Ana', service_date: '2026-10-06' });
  await doc('a', 15, 'invoice', { vendor: 'Hale Law', customer_name: 'Desert Peak HVAC LLC', cost: '75' }, { file: 'Hale bill to us.pdf' });
  await doc('a', 16, 'agreement', { vendor: 'Sunset Properties', lease_end_date: plus(45) }, { file: 'Office Lease.pdf' });
  await doc('a', 17, 'hr-letter', { customer_name: 'K Jones' }, { file: 'Award Letter - K Jones.pdf' });
  await doc('a', 18, 'price-list', { vendor: 'Far Supplier', service_date: '2026-09-02' });
  // Tenant B
  await doc('b', 1, 'price-list', { vendor: 'Rival Vendor' });
  await doc('b', 2, 'hr-letter', { customer_name: 'Rival Person' });

  const admin = { userId: 'admin_1', tenantId: KA, orgId: KA, orgRole: 'admin' };
  const member = { userId: 'member_1', tenantId: KA, orgId: KA, orgRole: 'member' };
  const bAdmin = { userId: 'b_admin', tenantId: KB, orgId: KB, orgRole: 'admin' };
  const mkRes = () => { const r: any = { statusCode: 0, body: null, headers: {}, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader(k: string, v: string) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };
  const origErr = console.error;
  const call = async (auth: any, body: Record<string, unknown>) => {
    const res = mkRes();
    console.error = () => {};
    try { await RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, auth); } finally { console.error = origErr; }
    return res;
  };
  const home = async (auth: any) => (await call(auth, { action: 'companyFiles', view: 'home' })).body;
  const folder = async (auth: any, f: string) => call(auth, { action: 'companyFiles', view: 'folder', folder: f });
  const ids = (docs: { id: string }[]) => docs.map((d) => d.id);

  // ---- admin's home
  const ha = await home(admin);
  const count = (h: any, f: string) => h.folders.find((x: any) => x.id === f)?.count;
  eq('admin: seven folders, People and HR included', ha.folders.map((f: any) => f.id), cf.COMPANY_FOLDERS.map((f: any) => f.id));
  eq('admin: People and HR counts both HR letters', count(ha, 'people-hr'), 2);
  eq('admin: Suppliers and vendors = 3 price lists + Beacon invoices x2 (not the law/bill-to ones)', count(ha, 'suppliers-vendors'), 5);
  check('customer paper (work order, invoice to a customer) is in no folder', !JSON.stringify(ha).includes(id('a', 9)) && count(ha, 'suppliers-vendors') + count(ha, 'purchasing') + count(ha, 'money-in-out') + count(ha, 'people-hr') + count(ha, 'insurance-legal') + count(ha, 'company-admin') + count(ha, 'schedules-operations') === ha.total);
  eq('own-name bill-to: the invoice Hale billed to the company is filed under Money in and out, not customer', (await folder(admin, 'money-in-out')).body.docs.some((d: any) => d.id === id('a', 15)), true);
  eq('admin may edit the HR access setting; default admins only', [ha.canEditHrAccess, ha.hrAccess], [true, { roles: [], members: [] }]);

  // ---- Suppliers and vendors: Beacon card, newest first, older marked
  const sup = (await folder(admin, 'suppliers-vendors')).body;
  const beacon = sup.docs.filter((d: any) => d.type === 'price-list' && d.vendorKey === 'beacon roofing supply');
  eq('Beacon price lists: newest first', ids(beacon), [id('a', 2), id('a', 1)]);
  eq('Beacon price lists: the older one is marked Older, the newest is not', beacon.map((d: any) => d.older), [false, true]);
  check('vendor cards exist for Beacon with the merged spelling', sup.vendors.some((v: any) => v.key === 'beacon roofing supply' && v.count >= 3));

  // ---- Check these
  const reasons = (h: any) => Object.fromEntries(h.checkThese.items.map((d: any) => [d.id, d.flags]));
  const r = reasons(ha);
  eq('Check these: unreadable scan', r[id('a', 13)]?.includes('hard-to-read'), true);
  eq('Check these: receipt with no total', r[id('a', 10)], ['no-total']);
  eq('Check these: the later duplicate is "Might be a copy", the first is not', [r[id('a', 12)] ?? r[id('a', 11)] ? true : false, !!(r[id('a', 11)]?.includes('might-be-copy') && r[id('a', 12)]?.includes('might-be-copy'))], [true, false]);
  eq('Check these: nothing else is flagged for a clean receipt', r[id('a', 4)], undefined);

  // ---- Coming up: certificate in 20 days, lease in 45, expired certificate replaced so not listed
  const up = ha.comingUp.items;
  eq('Coming up: soonest first (certificate 20 days, lease 45 days)', ids(up).slice(0, 2), [id('a', 7), id('a', 16)]);
  check('Coming up: an older, replaced certificate is not listed as expired', !ids(up).includes(id('a', 8)));
  eq('Coming up: the old certificate is marked Replaced in its folder', (await folder(admin, 'insurance-legal')).body.docs.find((d: any) => d.id === id('a', 8))?.replaced, true);

  // ---- HR: members cannot see it anywhere
  const hm = await home(member);
  eq('member: no People and HR folder, no HR count', [hm.folders.some((f: any) => f.id === 'people-hr'), hm.total], [false, ha.total - 2]);
  eq('member: opening the HR folder is not found', (await folder(member, 'people-hr')).statusCode, 404);
  const s1 = (await call(member, { action: 'companyFiles', view: 'search', q: 'smith' })).body;
  eq('member: search for an HR letter finds nothing', s1.total, 0);
  const s2 = (await call(admin, { action: 'companyFiles', view: 'search', q: 'smith' })).body;
  eq('admin: the same search finds it', ids(s2.docs), [id('a', 3)]);
  check('member: the strips never carry an HR paper', ![...hm.comingUp.items, ...hm.checkThese.items].some((d: any) => d.folder === 'people-hr'));
  const rowsOf = (res: any) => (res.body?.rows ?? res.body ?? []);
  for (const aud of ['customer', 'internal', 'all']) {
    const bm = await call(member, { action: 'browseDocuments', filters: { audience: aud, limit: 200 } });
    const ba = await call(admin, { action: 'browseDocuments', filters: { audience: aud, limit: 200 } });
    check(`Records browse (${aud}): member never sees an HR paper`, !ids(rowsOf(bm)).includes(id('a', 3)) && !ids(rowsOf(bm)).includes(id('a', 17)), JSON.stringify(ids(rowsOf(bm))));
    if (aud !== 'internal') check(`Records browse (${aud}): admin does`, ids(rowsOf(ba)).includes(id('a', 3)));
  }
  for (const sort of ['upload-date', 'type', 'amount']) {
    const bm = await call(member, { action: 'browseDocuments', filters: { audience: 'all', sort, limit: 200 } });
    check(`Records browse sort ${sort}: no HR for a member`, !ids(rowsOf(bm)).includes(id('a', 3)));
  }
  const bq = await call(member, { action: 'browseDocuments', filters: { audience: 'all', q: 'Smith' } });
  eq('Records browse search: a member searching an HR name gets nothing', rowsOf(bq).length, 0);
  const bqa = await call(admin, { action: 'browseDocuments', filters: { audience: 'all', q: 'Smith' } });
  check('Records browse search: the admin finds it', ids(rowsOf(bqa)).includes(id('a', 3)));
  const bf = await call(member, { action: 'browseFacets', filters: { audience: 'all' } });
  const bfa = await call(admin, { action: 'browseFacets', filters: { audience: 'all' } });
  const typeCount = (res: any, t: string) => res.body?.facets?.find((f: any) => f.key === 'documentType')?.options?.find((o: any) => o.value === t)?.count ?? 0;
  eq('Records browse facets: the HR type count differs for a member (cache keyed by access)', [typeCount(bf, 'hr-letter'), typeCount(bfa, 'hr-letter')], [0, 2]);
  eq('getDocument: an HR paper is null for a member, present for an admin', [(await call(member, { action: 'getDocument', id: id('a', 3) })).body, (await call(admin, { action: 'getDocument', id: id('a', 3) })).body?.id], [null, id('a', 3)]);
  eq('listDocuments: no HR paper for a member', ids((await call(member, { action: 'listDocuments' })).body).includes(id('a', 3)), false);
  eq('listExtractionsByDocument: an HR paper has no fields for a member', (await call(member, { action: 'listExtractionsByDocument', documentId: id('a', 3) })).body.length, 0);
  eq('listExtractionsByDocuments: HR fields are left out for a member', (await call(member, { action: 'listExtractionsByDocuments', documentIds: [id('a', 3), id('a', 4)] })).body.every((e: any) => e.document_id === id('a', 4)), true);
  eq('listUnverifiedDocuments: no HR paper for a member', ids((await call(member, { action: 'listUnverifiedDocuments' })).body.rows).includes(id('a', 3)), false);
  const boot = await call(member, { action: 'bootstrap', recordsLimit: 100 });
  if (boot.statusCode === 0 || boot.statusCode === 200) eq('bootstrap: no HR paper in the first page for a member', ids(boot.body.records.rows).includes(id('a', 3)), false);
  else check('bootstrap ran', false, String(boot.statusCode));
  eq('moving: a member cannot move an HR paper (not found), nor move anything into HR (403)', [
    (await call(member, { action: 'moveCompanyFile', documentId: id('a', 3), to: 'company-admin' })).statusCode,
    (await call(member, { action: 'moveCompanyFile', documentId: id('a', 4), to: 'people-hr' })).statusCode,
  ], [404, 403]);
  eq('HR setting: a member cannot change it', (await call(member, { action: 'setCompanyFilesHrAccess', roles: ['member'] })).statusCode, 403);

  // ---- admin grants members access
  const g = await call(admin, { action: 'setCompanyFilesHrAccess', roles: ['member'] });
  eq('HR setting: the admin can grant members', g.body?.hrAccess?.roles, ['member']);
  const hm2 = await home(member);
  eq('after the grant a member sees People and HR (2 letters)', [count(hm2, 'people-hr'), (await folder(member, 'people-hr')).statusCode === 0 || (await folder(member, 'people-hr')).body?.total === 2], [2, true]);
  eq('after the grant Records browse shows the HR paper to a member', ids(rowsOf(await call(member, { action: 'browseDocuments', filters: { audience: 'all', limit: 200 } }))).includes(id('a', 3)), true);
  eq('after the grant a member cannot change the setting', (await call(member, { action: 'setCompanyFilesHrAccess', roles: [] })).statusCode, 403);
  await call(admin, { action: 'setCompanyFilesHrAccess', roles: [] });
  eq('revoked again: hidden again', count(await home(member), 'people-hr'), undefined);
  await call(admin, { action: 'setCompanyFilesHrAccess', roles: [], members: ['member_1'] });
  eq('granted to one named member: that member sees it, another member does not', [count(await home(member), 'people-hr'), count(await home({ ...member, userId: 'member_2' }), 'people-hr')], [2, undefined]);
  await call(admin, { action: 'setCompanyFilesHrAccess', roles: [], members: [] });

  // ---- an HR letter moved out is no longer HR; a paper moved in becomes HR
  const mvOut = await call(admin, { action: 'moveCompanyFile', documentId: id('a', 17), to: 'company-admin', alwaysFile: true });
  eq('admin moves an HR letter to Company and admin', [mvOut.body?.to, mvOut.body?.ruleKey], ['company-admin', null]);
  eq('moved out of HR: now visible to a member in Records browse', ids(rowsOf(await call(member, { action: 'browseDocuments', filters: { audience: 'all', limit: 200 } }))).includes(id('a', 17)), true);
  await call(admin, { action: 'undoCompanyFileMove', documentId: id('a', 17), previousOverride: mvOut.body.previousOverride });
  eq('undo puts it back in People and HR (hidden from the member again)', ids(rowsOf(await call(member, { action: 'browseDocuments', filters: { audience: 'all', limit: 200 } }))).includes(id('a', 17)), false);
  const mvIn = await call(admin, { action: 'moveCompanyFile', documentId: id('a', 4), to: 'people-hr' });
  eq('a receipt filed into People and HR is hidden from a member everywhere', [mvIn.statusCode === 0 || mvIn.statusCode === 200, ids(rowsOf(await call(member, { action: 'browseDocuments', filters: { audience: 'all', limit: 200 } }))).includes(id('a', 4))], [true, false]);
  await call(admin, { action: 'undoCompanyFileMove', documentId: id('a', 4), previousOverride: mvIn.body.previousOverride });

  // ---- move, vendor memory, undo (member)
  const mv = await call(member, { action: 'moveCompanyFile', documentId: id('a', 2), to: 'purchasing', alwaysFile: true });
  eq('move: member moves a Beacon price list to Purchasing', [mv.body?.to, mv.body?.toLabel, mv.body?.ruleKey, mv.body?.previousOverride], ['purchasing', 'Purchasing', 'beacon roofing supply', null]);
  const afterMove = await folder(member, 'purchasing');
  check('move: it is now in Purchasing', ids(afterMove.body.docs).includes(id('a', 2)));
  check('move: the other Beacon price list followed the vendor ("always file here")', ids(afterMove.body.docs).includes(id('a', 1)));
  const settingsRow = (await lite.query(`SELECT settings->'companyFiles' AS cf FROM tenants WHERE id = $1`, [tenA])).rows[0].cf;
  eq('vendor memory is stored in tenants.settings.companyFiles', settingsRow.vendorRules, { 'beacon roofing supply': 'purchasing' });
  const ovRow = (await lite.query(`SELECT value FROM extractions WHERE document_id = $1 AND field_key = '_company_folder'`, [id('a', 2)])).rows;
  eq('the choice is one extraction row with a synthetic key', ovRow.map((x: any) => x.value), ['purchasing']);
  const hz = await home(member);
  eq('counts moved with the vendor (2 price lists + 2 invoices follow Beacon)', [count(hz, 'purchasing'), count(hz, 'suppliers-vendors')], [4, 1]);
  const und = await call(member, { action: 'undoCompanyFileMove', documentId: id('a', 2), previousOverride: mv.body.previousOverride, ruleKey: mv.body.ruleKey, previousRule: mv.body.previousRule, ruleFolder: mv.body.ruleFolder });
  eq('undo: succeeds', und.statusCode === 0 || und.statusCode === 200, true);
  const back = await folder(member, 'suppliers-vendors');
  check('undo: both price lists are back in Suppliers and vendors', ids(back.body.docs).includes(id('a', 2)) && ids(back.body.docs).includes(id('a', 1)));
  eq('undo: the saved choice and the vendor rule are gone', [(await lite.query(`SELECT 1 FROM extractions WHERE document_id = $1 AND field_key = '_company_folder'`, [id('a', 2)])).rows.length, (await lite.query(`SELECT settings->'companyFiles'->'vendorRules' AS v FROM tenants WHERE id = $1`, [tenA])).rows[0].v], [0, {}]);
  const mv2 = await call(member, { action: 'moveCompanyFile', documentId: id('a', 2), to: 'purchasing', alwaysFile: false });
  eq('move with "Always file" switched off keeps no vendor rule', [mv2.body?.ruleKey, ids((await folder(member, 'suppliers-vendors')).body.docs).includes(id('a', 1))], [null, true]);
  const mv3 = await call(member, { action: 'moveCompanyFile', documentId: id('a', 2), to: 'money-in-out', alwaysFile: false });
  eq('a second move remembers the first choice for Undo', mv3.body?.previousOverride, 'purchasing');
  await call(member, { action: 'undoCompanyFileMove', documentId: id('a', 2), previousOverride: mv3.body.previousOverride });
  eq('undo of the second move goes back to Purchasing', ids((await folder(member, 'purchasing')).body.docs).includes(id('a', 2)), true);
  await call(member, { action: 'undoCompanyFileMove', documentId: id('a', 2), previousOverride: null });
  const toCust = await call(member, { action: 'moveCompanyFile', documentId: id('a', 12), to: 'customer' });
  eq('move to a customer: leaves Company Files', [toCust.body?.toLabel, ids((await folder(member, 'suppliers-vendors')).body.docs).includes(id('a', 12))], ['a customer', false]);
  await call(member, { action: 'undoCompanyFileMove', documentId: id('a', 12), previousOverride: null });
  eq('move: bad inputs', [
    (await call(member, { action: 'moveCompanyFile', documentId: 'not-a-uuid', to: 'purchasing' })).statusCode,
    (await call(member, { action: 'moveCompanyFile', documentId: id('a', 4), to: 'nowhere' })).statusCode,
    (await call(member, { action: 'moveCompanyFile', documentId: id('a', 999), to: 'purchasing' })).statusCode,
  ], [400, 400, 404]);

  // ---- tenant scoping
  const hb = await home(bAdmin);
  eq('tenant B sees only its own: one price list, its own HR letter (admin)', [hb.total, count(hb, 'suppliers-vendors'), count(hb, 'people-hr')], [2, 1, 1]);
  eq('tenant B cannot move tenant A\'s paper', (await call(bAdmin, { action: 'moveCompanyFile', documentId: id('a', 4), to: 'purchasing' })).statusCode, 404);
  eq('tenant B cannot read tenant A\'s paper', (await call(bAdmin, { action: 'getDocument', id: id('a', 4) })).body, null);
  check('tenant B\'s search finds none of tenant A\'s', (await call(bAdmin, { action: 'companyFiles', view: 'search', q: 'beacon' })).body.total === 0);
  check('tenant A never sees tenant B\'s vendor', !JSON.stringify((await folder(admin, 'suppliers-vendors')).body).includes('Rival Vendor'));
  eq('tenant B settings untouched by A\'s vendor rule and HR grant', (await lite.query(`SELECT settings->'companyFiles' AS cf FROM tenants WHERE id = $1`, [tenB])).rows[0].cf, null);
  eq('empty folder state', (await folder(bAdmin, 'schedules-operations')).body.total, 0);
  eq('unknown folder', (await folder(admin, 'nope')).statusCode, 404);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
process.exit(0);
