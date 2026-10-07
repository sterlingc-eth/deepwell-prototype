/**
 * Loop 3 regressions (property lane), each a CLASS: certificates that cannot be judged are never skipped or turned into "Yes";
 * a vendor with several certificates is never spoken for by the latest alone; contracts that auto-renew are never "ended";
 * a noun that is not work orders is never answered with a work-order list; lease counts never ignore rent-roll leases.
 * Truth is written by hand per case. A declined answer (null) is always acceptable where "or declines" is stated.
 * Run by scripts/verify-industry-property.mjs.
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
const coi = (v, exp, extra = []) => doc('certificate-of-insurance', [['vendor', v], ['coi_expires', exp], ...extra]);
const wo = (no, st, v) => doc('work-order', [['work_order_number', no], ['status', st], ...(v ? [['vendor', v]] : []), ['property_name', 'Maple Court']]);
const L3 = [
  ['attention never says "None" while certificates cannot be judged', [coi('Apex Pest Control', '2026-09-01'), coi('Apex Pest Controls', '2027-09-01')], async (ask) => {
    const r = text(await ask('What needs attention?')); check('L3a attention declines or names the unchecked vendors', r === null || (!/^None/.test(r) && /could not be checked/.test(r) && /Apex Pest Control/.test(r)), r);
  }],
  ['attention lists a real item and still names the vendors it could not check', [coi('Apex Pest Control', '2027-09-01'), coi('Apex Pest Controls', '2027-09-01'), coi('Old Roofing', '2026-10-20')], async (ask) => {
    const r = text(await ask('What needs attention?')); check('L3b real item plus note', r === null || (/^1 item needs attention/.test(r) && /could not be checked/.test(r) && /Apex Pest Control/.test(r)), r);
  }],
  ['a certificate with no readable expiry is named in the attention answer', [coi('Old Roofing', '2026-10-20'), doc('certificate-of-insurance', [['vendor', 'Blank Paint Co'], ['coi_expires', 'pending']])], async (ask) => {
    const r = text(await ask('What needs attention?')); check('L3c names the unreadable one', r === null || /Blank Paint Co/.test(r), r);
  }],
  ['workers comp: only an affirmative entry is a yes', [coi('Rho LLC', '2027-03-01', [['coverage_type', 'General Liability'], ['workers_comp', 'Waived']]), coi('Nu LLC', '2027-03-01', [['workers_comp', 'N/A']]), coi('Xi LLC', '2027-03-01', [['workers_comp', 'Excluded']]), coi('Sig LLC', '2027-03-01', [['workers_comp', 'Yes']]), coi('Tau LLC', '2027-03-01', [['policy_number', 'P1']]), coi('Ups LLC', '2027-03-01', [['coverage_type', 'General Liability']]), coi('Pi LLC', '2027-03-01', [['coverage_type', 'Workers Compensation']])], async (ask) => {
    for (const v of ['Rho', 'Nu', 'Xi', 'Tau']) check(`L3d ${v} declines`, (await ask(`Does ${v} LLC carry workers comp?`)) === null);
    check('L3d Sig is yes', /^Yes\. Workers compensation is listed on Sig LLC/.test(text(await ask('Does Sig LLC carry workers comp?')) ?? ''));
    check('L3d Pi is yes', /^Yes\./.test(text(await ask('Does Pi LLC carry workers comp?')) ?? ''));
    const u = text(await ask('Does Ups LLC carry workers comp?')); check('L3d Ups not listed', u === null || /^Workers compensation is not listed on Ups LLC/.test(u), u);
  }],
  ['two certificates for one vendor (general liability expired, workers comp live) never speak as one', [coi('Phi LLC', '2026-09-01', [['coverage_type', 'General Liability']]), coi('Phi LLC', '2027-09-01', [['coverage_type', 'Workers Compensation']])], async (ask) => {
    for (const q of ['Is Phi LLC insured?', 'When does Phi LLC insurance expire?', 'Does Phi LLC carry workers comp?', 'Is Phi LLC COI current']) check(`L3e declines: ${q}`, (await ask(q)) === null);
  }],
  ['a renewal that repeats the coverage still answers from the newest certificate', [coi('Mu LLC', '2026-01-01', [['coverage_type', 'General Liability']]), coi('Mu LLC', '2027-06-01', [['coverage_type', 'General Liability']])], async (ask) => {
    const r = text(await ask('Is Mu LLC insured?')); check('L3f renewal answered', r === null || /^Yes\..*June 1, 2027/.test(r), r);
  }],
  ['the list form says when a listed certificate holds policies with different dates', [coi('Chi LLC', '2026-11-01', [['policy_expiry', '2026-11-01'], ['policy_expiry', '2027-05-01']])], async (ask) => {
    const r = text(await ask('Which certificates expire in the next 60 days?')); check('L3g caveat', r === null || /different expiry dates/.test(r), r);
  }],
  ['a lease count never ignores leases that live on a rent roll', [conv('RENT ROLL\nProperty: Maple Court\nUnit | Tenant | Lease End | Rent | Status\n101 | Bob Ray | 05/31/2027 | $1,000.00 | Occupied\n102 | Cy Doe | 05/31/2027 | $1,000.00 | Occupied\n')], async (ask) => {
    for (const q of ['How many leases are on file?', 'How many leases do we have?']) { const r = text(await ask(q)); check(`L3h not zero: ${q}`, r === null || !/^0 /.test(r), r); }
  }],
  ['a lease and a rent roll that name different tenants for one unit never answer who lives there', [lease('101', 'Ann Lee', '2027-05-31', 'Maple Court', '12 Maple St, Mesa AZ'), conv('RENT ROLL\nProperty: Maple Court\nUnit | Tenant | Lease End | Rent | Status\n101 | Bob Ray | 05/31/2027 | $1,000.00 | Occupied\n')], async (ask) => {
    const r = text(await ask('Who lives in unit 101?')); check('L3i names neither or both', r === null || (/Ann Lee/.test(r) && /Bob Ray/.test(r)), r);
  }],
  ['an auto-renewing contract past its term is never called ended', [doc('vendor-contract', [['vendor', 'Zed Landscaping'], ['contract_end', '2026-08-01'], ['auto_renew', 'Yes']]), doc('vendor-contract', [['vendor', 'Yew Pest'], ['contract_end', '2026-08-01'], ['auto_renew', 'No']])], async (ask) => {
    const z = text(await ask('When does the Zed Landscaping contract end?')); check('L3j Zed not "ended"', z === null || !/ended/.test(z), z);
    const e = text(await ask('Which contracts have ended?')); check('L3j list never includes Zed as ended', e === null || !/Zed/.test(e), e);
    const y = text(await ask('When does the Yew Pest contract end?')); check('L3j Yew (no auto-renew) ended', y === null || /ended August 1, 2026/.test(y), y);
  }],
  ['"which vendors have open work orders" is never a list of work orders', [wo('W1', 'Open', 'Hank Plumbing'), wo('W2', 'Open', 'Ivy Electric')], async (ask) => {
    for (const q of ['Which vendors have open work orders?', 'Which properties have open work orders?', 'which units have open work orders?', 'which tenants have open work orders']) check(`L3k declines: ${q}`, (await ask(q)) === null);
    check('L3k work orders still counted', /^2 work orders open/.test(text(await ask('How many open work orders do we have?')) ?? ''));
  }],
  ['credit memos and part-paid invoices are never a plain overdue amount', [inv('Qux Inc', 'Q-1', '-$200.00', 'Unpaid', '2026-09-01', { total: '-200.00' })], async (ask) => {
    for (const q of ['Which invoices are overdue?', 'How much do we owe Qux Inc?', 'How much do we owe in unpaid invoices?']) { const r = text(await ask(q)); check(`L3l no negative dollar amount: ${q}`, r === null || !/\$-/.test(r), r); }
  }],
  ['a part-paid overdue invoice never shows its full total as what is owed', [inv('Rax Inc', 'R-1', '$500.00', 'Partial', '2026-09-01', { status: 'partial' })], async (ask) => {
    for (const q of ['Which invoices are overdue?', 'How much do we owe Rax Inc?', 'How much do we owe in unpaid invoices?']) { const r = text(await ask(q)); check(`L3m no $500 as owed: ${q}`, r === null || !/\$500\.00/.test(r) || /partial|part/i.test(r), r); }
  }],
];
for (const [, rows, run] of L3) for (const as of [(fn) => H.as('property', fn), (fn) => H.withTenant(ctxB, fn)]) await as(async (db) => { await load(db, rows.filter(Boolean)); await run((q) => ask(db, q)); });
await H.stop?.();
console.log(`property loop 3 regressions: ${failures ? failures + ' FAILED, ' : ''}${passes} passed`);
if (failures) process.exit(1);
