/**
 * Loop 5 regressions: two-digit-year day-first documents, space thousands separators, trailing-minus / CR credits, amended or extended
 * lines under unknown labels, reinspection results printed as sentences, an ended lease with a later lease on file, overlapping live
 * leases, annotated tenant names, credit memos in the attention list, unread rent rolls in the attention list, future-start certificates,
 * several policy dates on one certificate. Truth by hand; null (declined / unread document) is acceptable where stated.
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
const val = (r, k) => r?.f.find((a) => a[0] === k)?.[1];
const HC = 'CERTIFICATE OF LIABILITY INSURANCE\nINSURED: Kestrel Landscaping LLC\nInsurer: Acme Mutual\nPolicy Number: P-1\n';
const LH = (x, unit = '1B') => `RESIDENTIAL LEASE AGREEMENT\nTenant: Ann Lee\nUnit: ${unit}\nProperty: Maple Court, 12 Maple St, Mesa AZ\n${x}\n`;
const CT = (x) => `VENDOR SERVICE CONTRACT\nVendor: Amend Pest LLC\nProperty: Maple Court\nStart Date: 01/01/2025\nEnd Date: 12/31/2025\nMonthly Fee: $500.00\n${x}\n`;
{
  check('Y1 day-first proved by a two-digit-year date', val(conv(HC + 'Effective: 15/01/26\nExpiration: 05/11/26'), 'coi_expires') === '2026-11-05');
  check('Y1 lease two-digit day-first', val(conv(LH('Lease Start Date: 01/02/26\nLease End Date: 31/01/27\nMonthly Rent: $1,250.00')), 'lease_start_date') === '2026-02-01');
  for (const m of ['$1 250.00', '1 250.00', '$1 250.00', '$1 250.00', '1k']) { const r = conv(LH(`Lease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: ${m}`)); check(`Y2 rent "${m}" is never read as 1`, r === null || val(r, 'rent_amount') == null || val(r, 'rent_amount') === '1250.00', String(val(r, 'rent_amount'))); }
  for (const m of ['900.00-', '$900.00 CR']) { const r = conv(`INVOICE\nVendor: Zed Co\nInvoice #: Z-9\nTotal: ${m}\nStatus: Unpaid\nProperty: Maple Court\n`); check(`Y3 total "${m}" is never a positive charge`, r === null || val(r, 'cost') == null, String(val(r, 'cost'))); }
  for (const x of ['Amended End Date: 12/31/2027', 'Extended to: 11/15/2027', 'Extended Through: 12/31/2028', 'Addendum: contract extended to 06/30/2027']) check(`Y4 contract: ${x} never leaves the old end date standing`, conv(CT(x)) === null);
  for (const x of ['Rent after 07/01/2026: $1,300.00', 'Rent Increase: $1,300.00 effective 07/01/2026', 'Extended Through: 12/31/2027']) check(`Y4 lease: ${x}`, conv(LH(`Lease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: $1,250.00\n${x}`)) === null);
  for (const x of ['Reinspected 10/02/2026 - PASSED', 'Reinspection Passed', 'All items corrected 09/20/2026']) check(`Y5 inspection: ${x}`, conv(`INSPECTION REPORT\nProperty: Maple Court\nUnit: 4A\nInspection Date: 09/01/2026\nResult: Fail\nReinspection Due: 10/01/2026\n${x}\n`) === null);
  for (const t of ['Jane Roe (moved out 08/2026)', 'Bob Ray - EVICTED', 'Dee Fox (Guarantor: Al Fox)', 'Cy Doe 555-123-4567']) check(`Y8 tenant "${t}" is not a plain name`, conv(`RESIDENTIAL LEASE AGREEMENT\nTenant: ${t}\nUnit: 1B\nProperty: Maple Court, 12 Maple St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: $1,000.00\n`) === null);
  check('Y11 a certificate that starts next year is not read as current', conv(HC + 'Effective Date: 01/01/2027\nExpiration Date: 01/01/2028') === null);
  check('Y10 "continues on a month-to-month basis" is a renewal', val(conv(CT('Thereafter this agreement continues on a month-to-month basis.')), 'auto_renew') != null);
}
const L5 = [
  ['Y6 an ended lease with a later lease on file never names the old tenant as the resident', [lease('1A', 'Ann Lee', '2025-12-31', 'Maple Court', '12 Maple St, Mesa AZ'), doc('lease-agreement', [['tenant_name', 'Bob Ray'], ['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_address', '12 Maple St, Mesa AZ'], ['lease_start_date', '2027-01-01'], ['lease_end_date', '2027-12-31'], ['rent_amount', '1100']])], async (ask) => {
    const r = text(await ask('Who lives in unit 1A?')); check('Y6 declines or does not say "latest lease on file" for Ann', r === null || !/Ann Lee is the tenant on the latest/.test(r), r);
  }],
  ['Y7 two running leases for different people are never one answer', [doc('lease-agreement', [['tenant_name', 'Ann Lee'], ['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_address', '12 Maple St, Mesa AZ'], ['lease_start_date', '2025-01-01'], ['lease_end_date', '2026-12-31'], ['rent_amount', '1000']]), doc('lease-agreement', [['tenant_name', 'Bob Ray'], ['unit_number', '1A'], ['property_name', 'Maple Court'], ['service_address', '12 Maple St, Mesa AZ'], ['lease_start_date', '2026-06-01'], ['lease_end_date', '2027-05-31'], ['rent_amount', '1100']])], async (ask) => {
    for (const q of ['Who lives in unit 1A?', 'What is the rent for unit 1A?']) { const r = text(await ask(q)); check(`Y7 ${q}`, r === null || (/Ann Lee/.test(r) && /Bob Ray/.test(r)), r); }
  }],
  ['Y9 a credit memo is never an overdue item; a part-paid one is not shown at its full total', [inv('Qux Inc', 'Q-1', '-$200.00', 'Unpaid', '2026-09-01', { total: '-200.00' }), inv('Rex Inc', 'R-1', '$900.00', 'Partial', '2026-09-01', { status: 'partial' })], async (ask) => {
    const r = await ask('What needs attention?'); const t = text(r);
    check('Y9 credit not listed', t === null || /^1 item needs attention/.test(t), t);
    check('Y9 no negative dollar format, no full $900 for the part-paid', !r || !JSON.stringify(r).includes('$-') && !/\$900\.00/.test(JSON.stringify(r.facts ?? [])), JSON.stringify(r?.facts));
  }],
  ['Y12 attention names a rent roll with unread rows, and what is not on file when it says None', [conv('RENT ROLL\nProperty: Maple Court\nUnit  Rent  Status\n101  1000  Occupied\n102  Vacant  1,100.00\n')], async (ask) => {
    const t = text(await ask('What needs attention?')); check('Y12 not a bare None', t === null || (/could not be read/.test(t) && /Nothing is on file yet/.test(t)), t);
  }],
  ['Y13 one certificate with several policy dates and the earliest lapsed is never a flat No', [coi2('Umb LLC', '2026-01-01', ['2026-01-01', '2027-01-01'])], async (ask) => {
    const r = text(await ask('Is Umb LLC insured?')); check('Y13 declines', r === null || !/^No\./.test(r), r);
  }],
];
function coi2(v, exp, pol) { return doc('certificate-of-insurance', [['vendor', v], ['coi_expires', exp], ...pol.map((x) => ['policy_expiry', x])]); }
for (const [, rows0, run] of L5) for (const as of [(fn) => H.as('property', fn), (fn) => H.withTenant(ctxB, fn)]) await as(async (db) => { await load(db, rows0.filter(Boolean)); await run((q) => ask(db, q)); });
await H.stop?.();
console.log(`property loop 5 regressions: ${failures ? failures + ' FAILED, ' : ''}${passes} passed`);
if (failures) process.exit(1);
