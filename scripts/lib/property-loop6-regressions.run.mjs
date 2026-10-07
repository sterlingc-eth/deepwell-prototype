/**
 * Loop 6 regressions: certificates / contracts / leases whose own paper says lapsed, inactive, suspended, terminated, vacated;
 * rent roll rows with a space in the unit label; cleared invoice fields with a financial record; resolved / closed inspections;
 * a human-corrected policy date; subtenants; unreadable documents and absent record types in the attention answer; initialisms.
 * (A previous-balance or late-fee line on an invoice deliberately does NOT change its amount: the balance belongs to earlier invoices.)
 */
import crypto from 'node:crypto';
const TODAY = '2026-10-06';
let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };
const { startMixedHarness } = await import('./mixed-company-harness.mjs');
const { classifyProperty, runProperty } = await import('../../api/_lib/industry/property/lane.js');
const { extractProperty } = await import('../../api/_lib/industry/property/extract.js');
const { getTenantContext } = await import('../../api/_lib/recordsStore.js');
const H = await startMixedHarness({ industries: ['property'] });
const ctxB = { tenantKey: 'org_review_property_two', tenantName: 'Review property two Co' };
await getTenantContext(ctxB.tenantKey, ctxB.tenantName);
await H.withTenant(ctxB, (db) => H.R.setTenantIndustry(db, 'property', { tenantKey: ctxB.tenantKey }));
H.R.resetPacksCacheForTests(); H.I.resetPackForTenantCacheForTests();
let counter = 0;
async function load(db, rows) {
  await db.raw('DELETE FROM documents', []);
  for (const r of rows) {
    const f = r.f.map(([k, v, c]) => (c === undefined ? { k, v: String(v) } : { k, v: String(v), c: String(c) }));
    const sha = crypto.createHash('sha256').update(`rr${counter++}`).digest('hex');
    const { rows: ids } = await db.raw(`WITH d AS (INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 'mapped') RETURNING id),
      x AS (INSERT INTO extractions (tenant_id, document_id, field_key, value, corrected_value, created_at) SELECT (current_setting('app.tenant_id', true))::uuid, d.id, e->>'k', e->>'v', e->>'c', NOW() + (t.ord * interval '1 millisecond') FROM d, jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(e, ord) RETURNING 1) SELECT id FROM d`, [`${r.type}-${counter}.pdf`, r.type, sha, JSON.stringify(f)]);
    if (r.fin) { const x = r.fin; await db.raw(`INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, currency, invoice_number, total, status, due_date, corrections) VALUES ((current_setting('app.tenant_id', true))::uuid, $1, 'invoice', $2, 'USD', $3, $4, $5, $6, $7::jsonb)`, [ids[0].id, x.direction ?? 'payable', r.f.find((a) => a[0] === 'invoice_number')?.[1] ?? null, x.total ?? null, x.status ?? 'unpaid', x.due ?? null, JSON.stringify(x.corr ?? {})]); }
  }
}
const ask = async (db, q) => { const i = classifyProperty(q, { today: TODAY }); return i ? runProperty(db, i, { today: TODAY }) : null; };
const doc = (type, f, extra = {}) => ({ type, f, ...extra });
const lease = (unit, tenant, end, prop, addr, rent = '1000') => doc('lease-agreement', [['tenant_name', tenant], ...(unit ? [['unit_number', unit]] : []), ['property_name', prop], ['service_address', addr], ['lease_start_date', '2026-01-01'], ['lease_end_date', end], ['rent_amount', rent]]);
const conv = (text) => { const r = extractProperty([{ page_no: 1, text }], { today: TODAY }); return r ? { type: r.type, f: r.fields.map((x) => [x.key, x.value]) } : null; };
const inv = (v, no, cost, st, due, fin = {}) => doc('invoice', [['vendor', v], ['invoice_number', no], ['cost', cost], ['status', st], ['invoice_due', due], ['property_name', 'Maple Court']], { fin: { total: String(cost).replace(/[$,]/g, ''), status: /^paid/i.test(st) ? 'paid' : 'unpaid', due, ...fin } });
const text = (r) => (r ? String(r.text) : null);
const coi = (v, exp, extra = []) => doc('certificate-of-insurance', [['vendor', v], ['coi_expires', ...(Array.isArray(exp) ? exp : [exp])], ...extra]);
const HC = 'CERTIFICATE OF LIABILITY INSURANCE\nINSURED: Kestrel Landscaping LLC\nInsurer: Acme Mutual\nPolicy Number: P-1\nGeneral Liability Expiration Date: 12/31/2026\n';
const CT = (x) => `VENDOR SERVICE CONTRACT\nVendor: Amend Pest LLC\nProperty: Maple Court\nStart Date: 01/01/2025\nEnd Date: 12/31/2027\nMonthly Fee: $500.00\n${x}\n`;
const LH = (x) => `RESIDENTIAL LEASE AGREEMENT\nTenant: Ann Lee\nUnit: 1B\nProperty: Maple Court, 12 Maple St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: $1,000.00\n${x}\n`;
const wo9 = (no, prop, vendor) => doc('work-order', [['work_order_number', no], ['status', 'Open'], ['property_name', prop], ...(vendor ? [['vendor', vendor]] : [])]);
const val = (r, k) => r?.f.find((a) => a[0] === k)?.[1];
{
  for (const x of ['Status: Lapsed', 'Policy Status: Inactive', 'Status: Expired', 'Coverage not in force', 'Policy lapsed 06/01/2026', 'Policy Status: Not in force', 'Status: Suspended']) check(`Z1 certificate: ${x} is not read as current`, conv(HC + x) === null);
  for (const x of ['Status: Terminated', 'Status: Expired', 'Contract Status: Inactive', 'Terminated effective 09/01/2026', 'Notice of termination given 09/01/2026', 'Contract terminated by mutual agreement']) check(`Z1 contract: ${x} is not read as live`, conv(CT(x)) === null);
  check('Z1 contract boilerplate "until terminated by either party" is still read', val(conv(CT('This agreement continues until terminated by either party.')), 'contract_end') === '2027-12-31');
  for (const x of ['Lease terminated 08/01/2026', 'Tenant vacated 08/15/2026', 'Unit vacated', 'Lease broken', 'Lease Status: Inactive']) { const r = conv(LH(x)); check(`Z2 lease: ${x} carries a terminated status or is unread`, r === null || /terminated/i.test(String(val(r, 'status'))), String(val(r, 'status'))); }
  check('Z2 subtenant: lease not read as a sole tenant', conv(LH('Subtenant: Bob Ray')) === null);
  for (const x of ['Status: Resolved', 'Status: Closed']) check(`Z6 inspection ${x} not read`, conv(`INSPECTION REPORT\nProperty: Maple Court\nUnit: 4A\nInspection Date: 09/01/2026\nResult: Failed\nReinspection Due: 10/01/2026\n${x}\n`) === null);
  const rr = conv('RENT ROLL\nProperty: Maple Court\nUnit  Tenant  Rent  Lease End\nA-101  Ann Lee  1000  12/31/2026\nB 202  Bob Ray  1050  12/31/2026\nC-303  Cy Doe  900  12/31/2026\nPH 1  Di Fox  900  12/31/2026\n');
  const nRows = (rr?.f ?? []).filter((a) => a[0] === 'rent_roll_row').length; const unread = Number(val(rr, 'rent_roll_unread') ?? 0);
  check('Z3 every row is read or counted unread', nRows + unread === 4, `${nRows} read, ${unread} unread`);
}
const L6 = [
  ['Z5 a cleared invoice field is unknown even with a financial record', [doc('invoice', [['vendor', 'Cl Co'], ['invoice_number', 'C-1'], ['cost', '700.00', ''], ['status', 'Unpaid'], ['invoice_due', '2026-09-01'], ['property_name', 'Maple Court']], { fin: { total: '700.00', status: 'unpaid', due: '2026-09-01' } })], async (ask) => {
    for (const q of ['How much do we owe in unpaid invoices?', 'How many invoices are overdue?']) { const r = text(await ask(q)); check(`Z5 ${q}`, r === null || !/700\.00|^1 invoice overdue/.test(r), r); }
  }],
  ['Z7 a human-corrected policy date counts', [doc('certificate-of-insurance', [['vendor', 'Fog Co'], ['coi_expires', '2026-12-01'], ['policy_expiry', '2026-12-01', '2026-08-01'], ['policy_expiry', '2027-06-01']])], async (ask) => {
    const r = text(await ask('Is Fog Co insured?')); check('Z7 not "Yes ... December 1"', r === null || !/^Yes/.test(r), r);
  }],
  ['Z8 attention: an unreadable document and absent types are named, never a bare None', [doc('invoice', [], { fin: { total: '50.00', status: 'unpaid', due: '2027-01-01' } })], async (ask) => {
    const t = text(await ask('What needs attention?')); check('Z8 unreadable document named', t === null || /could not be read/.test(t), t);
  }],
  ['Z9 overdue-only None names what is not on file', [lease('1', 'Ann Lee', '2028-05-31', 'Maple Court', '12 Maple St, Mesa AZ')], async (ask) => {
    const t = text(await ask('What is overdue?')); check('Z9 not a bare None', t === null || !/^None/.test(t) || /Nothing is on file yet/.test(t), t);
  }],
  ['Z10 initialisms keep their capitals; no doubled "inspection inspection"', [doc('inspection-report', [['inspection_type', 'HOA'], ['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_date', '2026-09-01'], ['inspection_result', 'Failed']]), doc('inspection-report', [['unit_number', '2B'], ['property_name', 'Maple Court'], ['service_date', '2026-09-02'], ['inspection_result', 'Failed']])], async (ask) => {
    const t = text(await ask('Which inspections failed?')); check('Z10 HOA capitals, no doubled word', t === null || (!/\bhoa\b/.test(t) && !/inspection inspection/i.test(t)), t);
  }],
  ['Z11 the same invoice number at two places is two invoices (or declined)', [inv('Acme Co', '100', '$500.00', 'Unpaid', '2026-09-01'), doc('invoice', [['vendor', 'Acme Co'], ['invoice_number', '100'], ['cost', '$500.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01'], ['property_name', 'Oak Park'], ['service_address', '9 Oak Rd, Mesa AZ']], { fin: { total: '500.00', status: 'unpaid', due: '2026-09-01' } })], async (ask) => {
    const r = text(await ask('How much do we owe in unpaid invoices?')); check('Z11 never $500 across 1', r === null || !/^\$500\.00 across 1 /.test(r), r);
  }],
  ['Z12 one work-order number on two units is two work orders (or declined)', [doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open'], ['unit_number', '1A'], ['vendor', 'Acme'], ['property_name', 'Maple Court']]), doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open'], ['unit_number', '2B'], ['vendor', 'Beta'], ['property_name', 'Maple Court']]), doc('work-order', [['work_order_number', 'WO-2'], ['status', 'Open'], ['unit_number', '3C'], ['property_name', 'Maple Court']])], async (ask) => {
    const r = text(await ask('How many open work orders do we have?')); check('Z12 3 or declined', r === null || /^3 work orders open/.test(r), r);
  }],
  ['Z13 one contract at two properties with two fees is two contracts', [doc('vendor-contract', [['vendor', 'Acme Pest'], ['contract_start', '2025-01-01'], ['contract_end', '2026-11-15'], ['monthly_amount', '500'], ['property_name', 'Maple Court']]), doc('vendor-contract', [['vendor', 'Acme Pest'], ['contract_start', '2025-01-01'], ['contract_end', '2026-11-15'], ['monthly_amount', '750'], ['property_name', 'Oak Park']])], async (ask) => {
    const r = text(await ask('How many contracts expire soon?')); check('Z13 2 or declined', r === null || /^2 vendor contracts/.test(r), r);
  }],
  ['Z14 a rent roll with no readable rows is never "0 vacant"', [doc('rent-roll', [['property_name', 'Maple Court']])], async (ask) => {
    const r = text(await ask('How many units are vacant?')); check('Z14 declines', r === null || !/^0 vacant/.test(r), r);
  }],
  ['Z15 scoped None keeps its scope; a vendor word shared by two vendors is never summed; receivables are not vendors', [lease('2A', 'Ann Lee', '2026-10-20', 'Maple Court', '12 Maple St, Mesa AZ'), lease('3', 'Cy Doe', '2028-10-20', 'Oak Park', '9 Oak Rd, Mesa AZ'), inv('Hank Plumbing', 'H-1', '$100.00', 'Unpaid', '2026-09-01'), inv('Ivy Electric', 'I-1', '$250.00', 'Unpaid', '2026-09-01'), doc('invoice', [['vendor', 'Rent Co'], ['invoice_number', 'R-1'], ['cost', '$900.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01'], ['property_name', 'Maple Court']], { fin: { total: '900.00', status: 'unpaid', due: '2026-09-01', direction: 'receivable' } })], async (ask) => {
    const a = text(await ask('Which leases expire in the next 30 days at Oak Park?')); check('Z15a scope kept', a === null || !/^None\. No leases ending within 30 days\.$/.test(a), a);
    const b = text(await ask('How much do we owe Hank Electric?')); check('Z15b no union of two vendors', b === null || !/Ivy Electric, Hank Plumbing|350\.00/.test(b), b);
    const c = text(await ask('Which vendors have no certificate of insurance?')); check('Z15c Rent Co is not a vendor', c === null || !/Rent Co/.test(c), c);
  }],
  ['Z16 a failed inspection of one kind is not cleared by a pass of another kind', [doc('inspection-report', [['inspection_type', 'Fire Safety'], ['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_date', '2026-03-01'], ['inspection_result', 'Failed']]), doc('move-in-inspection', [['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_date', '2026-05-01'], ['inspection_result', 'Pass'], ['tenant_name', 'Ann Lee'], ['service_address', '12 Maple St, Mesa AZ']])], async (ask) => {
    const r = text(await ask('How many inspections failed?')); check('Z16 counts the fire-safety failure (or declines)', r === null || /^1 inspection failed/.test(r), r);
  }],
  ['Z17 two differently named properties at one address are never merged in a scoped answer', [lease('202', 'Cy Doe', '2027-05-31', 'Sunset Villas', '500 Sunset Blvd, Mesa AZ'), lease('101', 'Di Fox', '2027-05-31', 'Sunset Tower', '500 Sunset Blvd, Mesa AZ')], async (ask) => {
    const r = text(await ask('Who lives in unit 202 at Sunset Tower?')); check('Z17 declines (never Cy Doe at Sunset Villas)', r === null || !/Cy Doe/.test(r), r);
  }],
  ['Z18 an unread newer rent roll never leaves the older roll as the current word', [conv('RENT ROLL\nProperty: Oak Plaza\nUnit | Tenant | Lease End | Rent | Status\n102 | Cy Doe | 05/31/2027 | $1,100.00 | Occupied\n'), conv('RENT ROLL\nProperty: Oak Plaza\nUnit | Tenant | Lease End | Rent | Status\n102 | Vacant | | $0.00 | Vacant\n103 | Di Fox | 05/31/2027 | $900.00 | Occupied\n')], async (ask) => {
    const r = text(await ask('Who lives in unit 102?')); check('Z18 not Cy Doe as current', r === null || !/Cy Doe is the tenant/.test(r), r);
  }],
  ['Z19 a shorter property name inside a longer one is the longer property only', [wo9('W1', 'Maple Court'), wo9('W2', 'Maple Court Annex'), wo9('W3', 'Maple Court Annex'), wo9('W4', 'Oak Lane North'), wo9('W5', 'Oak Lane')], async (ask) => {
    const a = text(await ask('Which work orders are open at Maple Court Annex?')); check('Z19a 2 at the Annex', a === null || /^2 work orders open at Maple Court Annex\b/.test(a), a);
    const b = text(await ask('How many open work orders at Oak Lane North?')); check('Z19b 1 at Oak Lane North', b === null || /^1 work order/.test(b), b);
    const c = text(await ask('How many open work orders at Maple Court?')); check('Z19c Maple Court alone is 1 or declined', c === null || /^1 work order/.test(c), c);
  }],
  ['Z20 a certificate with no readable vendor never drops out of a list', [coi('Live Pest', '2027-06-01'), doc('certificate-of-insurance', [['vendor', 'Old Roofing', ''], ['coi_expires', '2026-01-01']])], async (ask) => {
    for (const q of ['Which certificates have expired?', 'How many certificates have expired?', 'Which vendors have no current COI?']) { const r = text(await ask(q)); check(`Z20 ${q}`, r === null || (!/^None/.test(r) && !/^0\b/.test(r)), r); }
    const a = text(await ask('What needs attention?')); check('Z20 attention names it', a === null || /no readable vendor/.test(a), a);
  }],
  ['Z21 failing inspection results the extractor accepts count as failed; mixed results are never read', [['Unsatisfactory', '1B'], ['Not approved', '2B'], ['Non-compliant', '3B']].map(([r, u]) => doc('inspection-report', [['unit_number', u], ['property_name', 'Maple Court'], ['service_date', '2026-09-01'], ['inspection_result', r]])).concat([doc('inspection-report', [['unit_number', '4B'], ['property_name', 'Maple Court'], ['service_date', '2026-09-01'], ['inspection_result', 'Passed - no failed items']])]), async (ask) => {
    const r = text(await ask('How many inspections failed?')); check('Z21 never 0 and never counts the pass', r === null || /^3 inspections failed/.test(r), r);
  }],
  ['Z22 an invoice with no property is named in a property-scoped total', [inv('Acme Co', 'A-1', '$500.00', 'Unpaid', '2026-09-01'), doc('invoice', [['vendor', 'Acme Co'], ['invoice_number', 'A-3'], ['cost', '$100.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01']], { fin: { total: '100.00', status: 'unpaid', due: '2026-09-01' } })], async (ask) => {
    const r = text(await ask('How much do we owe at Maple Court?')); check('Z22 note about the unplaced invoice', r === null || /no readable property/.test(r), r);
  }],
  ['Z23 a vendor two edits from another is never told it has no certificate', [wo9('W-9', 'Maple Court', 'Fix Co'), coi('Fixed Co', '2027-06-01')], async (ask) => {
    const r = text(await ask('Which vendors have no certificate of insurance?')); check('Z23 declines or does not list Fix Co as missing', r === null || !/Fix Co/.test(r), r);
  }],
  ['Z24 a vendor sharing a word with a property is not a hidden second filter', [wo9('W1', 'Maple Court', 'Acme'), wo9('W2', 'Oak Park', 'Maple Services'), inv('Acme', 'A-1', '$30.00', 'Unpaid', '2026-09-01'), doc('invoice', [['vendor', 'Maple Services'], ['invoice_number', 'M-1'], ['cost', '$100.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01'], ['property_name', 'Oak Park']], { fin: { total: '100.00', status: 'unpaid', due: '2026-09-01' } })], async (ask) => {
    const a = text(await ask('How many open work orders at Maple Court?')); check('Z24a 1 or declined', a === null || /^1 work order/.test(a) && !/Maple Services/.test(a), a);
    const b = text(await ask('How much do we owe at Maple Court?')); check('Z24b $30 or declined', b === null || /^\$30\.00 across 1 /.test(b), b);
  }],
  ['Z25 a vendor with a lapsed general-liability certificate and a live workers-comp one is never "none expired"', [coi('Alpha Roofing', '2026-09-01', [['coverage_type', 'General Liability']]), coi('Alpha Roofing', '2027-09-01', [['coverage_type', 'Workers Compensation']]), coi('Zed Co', '2027-01-01')], async (ask) => {
    for (const q of ['Which certificates have expired?', 'How many certificates have expired?', 'Which vendors have no current COI?']) { const r = text(await ask(q)); check(`Z25 ${q}`, r === null || (!/^None/.test(r) && !/^0\b/.test(r)), r); }
    const a = text(await ask('What needs attention?')); check('Z25 attention names Alpha Roofing', a === null || /Alpha Roofing/.test(a), a);
  }],
  ['Z26 a vendor with two contracts: end / auto-renew are never joined', [doc('vendor-contract', [['vendor', 'Hex Co'], ['contract_scope', 'Windows'], ['contract_end', '2026-11-01'], ['auto_renew', 'Yes'], ['property_name', 'Maple Court']]), doc('vendor-contract', [['vendor', 'Hex Co'], ['contract_scope', 'Doors'], ['contract_end', '2027-11-01'], ['auto_renew', 'No'], ['property_name', 'Maple Court']])], async (ask) => {
    for (const q of ['Does the Hex Co contract auto renew?', 'When does the Hex Co contract end?']) check(`Z26 declines: ${q}`, (await ask(q)) === null);
  }],
];
for (const [, rows0, run] of L6) for (const as of [(fn) => H.as('property', fn), (fn) => H.withTenant(ctxB, fn)]) await as(async (db) => { await load(db, rows0.filter(Boolean)); await run((q) => ask(db, q)); });
await H.stop?.();
console.log(`property loop 6 regressions: ${failures ? failures + ' FAILED, ' : ''}${passes} passed`);
if (failures) process.exit(1);
