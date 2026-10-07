/**
 * Regression cases found by an independent reviewer of the property lane (each one a CLASS of defect, run in two same-trade companies):
 * money owed TO the company, a lease + rent roll for one place, a lease with no unit, a street word read as a property name, names that look
 * like judgement words, noun changes ("tenants" vs leases), cleared money corrections, a bare letter for a building, and a few wording rules.
 * Wired into `npm run verify:industry-property`. Truth is stated per case; a declined answer (null) is always acceptable where "decline" is expected.
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

const SCENARIOS = [
  ['H1 money owed to us is never answered from payable invoices', [inv('Zephyr Glass LLC', 'Z1', '$100.00', 'Unpaid', '2026-09-01')], async (ask) => {
    for (const q of ['how much is owed to us?', 'how much does Zephyr Glass owe us?', 'which vendors owe us money?', 'does Zephyr Glass owe us?', 'who owes us money', 'what are our receivables']) check(`H1 declines: ${q}`, (await ask(q)) === null);
    check('H1 payable question still answered', /^\$100\.00 across 1 unpaid invoice/.test(text(await ask('how much do we owe in unpaid invoices?')) ?? ''), text(await ask('how much do we owe in unpaid invoices?')));
  }],
  ['H2 one lease + one rent roll (real extractor output) are one place', [
    conv('RESIDENTIAL LEASE AGREEMENT\nLandlord: Desert Ridge PM LLC\nTenant: Ava Chen\nUnit: 101\nProperty: Maple Court, 12 Maple St, Mesa AZ 85201\nLease Start Date: 01/01/2026\nLease End Date: 10/20/2026\nMonthly Rent: $2,100.00\nSecurity Deposit: $2,100.00\n'),
    conv('RENT ROLL\nProperty: Maple Court\nUnit | Tenant | Lease Start | Lease End | Rent | Status\n101 | Ava Chen | 01/01/2026 | 10/20/2026 | $2,100.00 | Occupied\n102 | VACANT | | | $2,150.00 | Vacant\n')], async (ask) => {
    check('H2 lease count is 1', /^1 lease ending within 30 days\b/.test(text(await ask('How many leases expire in the next 30 days?')) ?? ''), text(await ask('How many leases expire in the next 30 days?')));
    check('H2 who lives in 101', /^Ava Chen is the tenant of unit 101/.test(text(await ask('Who lives in unit 101?')) ?? ''), text(await ask('Who lives in unit 101?')));
    const v = text(await ask('How many vacant units?')); check('H2 vacancy has no false "no rent roll" note', /^1 vacant unit/.test(v ?? '') && !/no rent roll is on file/.test(v ?? ''), v);
  }],
  ['H3 a lease with no unit number is never silently left out', [lease('', 'Kay Roe', '2026-10-30', 'Birch House', '3 Elm Dr, Tempe AZ', '1500'), lease('2', 'Lee Ray', '2026-10-12', 'Maple Court', '12 Maple St, Mesa AZ', '1500')], async (ask) => {
    for (const q of ['Which leases expire in the next 30 days?', 'How many leases expire in the next 30 days?', 'Which leases are expired?', 'How many leases are month to month?']) { const r = text(await ask(q)); check(`H3 not a number that omits the unit-less lease: ${q}`, r === null || /\bno unit\b/i.test(r), r); }
  }],
  ['M1 a street word is the address, not the property whose name shares it', [lease('1', 'Ann Alpha', '2026-10-20', 'Maple Court', '12 Maple St, Mesa AZ'), lease('1', 'Bob Beta', '2026-10-21', 'Maple Court East', '14 Maple St, Mesa AZ')], async (ask) => {
    const r = text(await ask('Which leases expire in the next 30 days at 14 Maple St?')); check('M1 only the 14 Maple St lease', r === null || (/^1 lease\b/.test(r) && /Bob Beta/.test(r) && !/Ann Alpha/.test(r)), r);
  }],
  ['M2 record names that look like judgement words are names', [
    doc('certificate-of-insurance', [['vendor', 'Legal Eagle Plumbing LLC'], ['coi_expires', '2027-03-01']]), doc('certificate-of-insurance', [['vendor', 'Fair Housing Plumbing LLC'], ['coi_expires', '2027-04-01']]),
    lease('4', 'Sue Hill', '2027-05-31', 'Maple Court', '12 Maple St, Mesa AZ', '1234'), lease('5', 'Eve Liable', '2027-05-31', 'Maple Court', '12 Maple St, Mesa AZ', '1777')], async (ask) => {
    check('M2 Legal Eagle COI answered', /Legal Eagle Plumbing/.test(text(await ask('Is Legal Eagle Plumbing insured?')) ?? ''), text(await ask('Is Legal Eagle Plumbing insured?')));
    check('M2 Fair Housing Plumbing COI answered', /Fair Housing Plumbing/.test(text(await ask('Is Fair Housing Plumbing COI current')) ?? ''));
    check('M2 rent for Sue Hill answered', /1,234/.test(text(await ask('what is the rent for Sue Hill')) ?? ''), text(await ask('what is the rent for Sue Hill')));
    check('M2 rent for Eve Liable answered', /1,777/.test(text(await ask('What is the rent for Eve Liable')) ?? ''));
    const ev = await ask('Should we evict Sue Hill?'); check('M2 a real judgement question is still refused', ev && ev.decline === true, JSON.stringify(ev)?.slice(0, 120));
    const lg = await ask('Is it legal to evict Eve Liable?'); check('M2 a legal question about a named tenant is still refused', lg && lg.decline === true);
  }],
  ['M3 "how many tenants" is not a lease count', [lease('1', 'Ann Alpha', '2026-10-20', 'Maple Court', '12 Maple St, Mesa AZ'), lease('2', 'Bob Beta', '2026-10-21', 'Maple Court', '12 Maple St, Mesa AZ')], async (ask) => {
    for (const q of ['how many tenants have leases expiring in the next 30 days', 'how many residents have a lease ending in the next 30 days']) check(`M3 declines: ${q}`, (await ask(q)) === null);
    check('M3 the lease count itself still answers', /^2 leases ending within 30 days/.test(text(await ask('how many leases expire in the next 30 days')) ?? ''));
  }],
  ['M4 an emptied financial-record correction is cleared, not ignored', [inv('Quill Roofing Inc', 'Q-1', '$500.00', 'Unpaid', '2026-09-01'), inv('Pyre Boiler Co', 'P-2', '$60.00', 'Unpaid', '2026-09-01', { corr: { due_date: '' } })], async (ask) => {
    for (const q of ['How many invoices are overdue?', 'How many unpaid invoices do we have?', 'Which invoices are unpaid?']) { const r = text(await ask(q)); check(`M4 never counts the invoice whose record disagrees: ${q}`, r === null || !/^2 /.test(r), r); }
  }],
  ['M5 a building given only as a letter is never ignored', [lease('1', 'Ann Alpha', '2026-10-20', 'Maple Court', '12 Maple St, Mesa AZ'), lease('2', 'Bob Beta', '2026-10-21', 'Maple Court', '12 Maple St, Mesa AZ')], async (ask) => {
    for (const q of ['how many leases expire in the next 30 days in building A', 'how many leases expire in the next 30 days in unit A', 'how many leases expire in the next 30 days in the A building', 'how many leases expire in the next 30 days at the A property', 'how many leases expire in the next 30 days in Bldg A']) check(`M5 declines: ${q}`, (await ask(q)) === null);
  }],
  ['L1 work-order counts say when a number appears on more than one document', [doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open'], ['property_name', 'Maple Court']]), doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open'], ['property_name', 'Maple Court']]), doc('work-order', [['work_order_number', 'WO-2'], ['status', 'Open'], ['property_name', 'Maple Court']])], async (ask) => {
    const r = text(await ask('How many open work orders do we have?')); check('L1 2 distinct and a note', r === null || (/^2 work orders open/.test(r) && /distinct/.test(r)), r);
  }],
  ['L4 wording: agreement of the verb, possessive of a name ending in s', [doc('certificate-of-insurance', [['vendor', 'Ladle Foods'], ['coi_expires', '2026-10-12']]), lease('1', 'Ann Alpha', '2026-10-20', 'Maple Court', '12 Maple St, Mesa AZ')], async (ask) => {
    const c = text(await ask('Is Ladle Foods COI current')); check('L4 Ladle Foods\'', c === null || (/Ladle Foods' certificate/.test(c) && !/Foods's/.test(c)), c);
    const a = text(await ask('Which leases need attention?')); check('L4 "1 lease needs attention"', a === null || !/1 lease need\b/.test(a), a);
  }],
  ['L5 a month and year alone is never read as a month-end date', [doc('certificate-of-insurance', [['vendor', 'Ember Gas Co'], ['coi_expires', '2026-12']])], async (ask) => {
    const r = text(await ask('Is Ember Gas COI current')); check('L5 no December 31 invented', r === null || !/December 31/.test(r), r);
  }],
];
for (const [name, rows, run] of SCENARIOS) {
  const rs = rows.filter(Boolean);
  for (const [org, as] of [['A', (fn) => H.as('property', fn)], ['B', (fn) => H.withTenant(ctxB, fn)]]) {
    await as(async (db) => { await load(db, rs); await run((q) => ask(db, q)); });
    void org;
  }
  void name;
}

const RRT = (b) => conv(`RENT ROLL\nProperty: Maple Court\n${b}`);
const LSX = (x, unit = '101') => conv(`RESIDENTIAL LEASE AGREEMENT\nTenant: Ann Lee\nUnit: ${unit}\nProperty: 1 Main St, Mesa AZ\n${x}\nMonthly Rent: $1,000.00`);
const LOOP2 = [
  ['loop2 H1/H4 vacant row with no status column, an empty tenant cell, or a placeholder tenant: never a silent vacancy loss', [RRT('Unit | Tenant | Rent\n101 | Ann Lee | 1,000.00\n102 | Vacant | 1,100.00'), RRT('Unit\tTenant\tRent\tStatus\n201\tAnn Lee\t1000\tOccupied\n202\t\t1100\tVacant')], async (ask) => {
    const r = text(await ask('How many vacant units?')); check('H1 two vacant units counted (or declined), never 0', r === null || /^2 vacant units/.test(r), r);
  }],
  ['loop2 H1c a row the extractor cannot fully read is counted unread, so the lane declines', [RRT('Unit  Rent  Status\n101  1000  Occupied\n102  Vacant  1,100.00')], async (ask) => {
    const r = text(await ask('How many vacant units?')); check('H1c vacant count declines or says unread', r === null || /could not be read/.test(r), r);
  }],
  ['loop2 H4 placeholder tenants are not tenants', [RRT('Unit | Tenant | Rent | Status\n101 | Ann Lee | 1,000.00 | Occupied\n102 | (vacant) | 1,100.00 | Vacant\n103 | Model Unit | 1,000 | Model')], async (ask) => {
    const w = text(await ask('Who lives in unit 102?')); check('H4 nobody named "(vacant)"', w === null || !/\(vacant\) is the tenant/i.test(w), w);
    const m = text(await ask('Who lives in unit 103?')); check('H4 a model unit is not a tenant', m === null || !/Model Unit/.test(m), m);
  }],
  ['loop2 H3 month-to-month in the Lease End column', [RRT('Unit | Tenant | Lease Start | Lease End | Rent\n101 | Ann Lee | 01/01/2026 | Month-to-Month | 1,000.00\n102 | Bo Ray | 01/01/2026 | MTM | 1,100.00\n103 | Cy Doe | 01/01/2026 | M2M | 900.00\n104 | Di Fox | 01/01/2026 | 12/31/2026 | 950.00')], async (ask) => {
    const r = text(await ask('How many month-to-month leases?')); check('H3 three month-to-month', r === null || /^3 month-to-month leases/.test(r), r);
  }],
  ['loop2 L7 work-order count of documents says distinct', [doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open']]), doc('work-order', [['work_order_number', 'WO-1'], ['status', 'Open']])], async (ask) => {
    const r = text(await ask('How many work orders do we have on file?')); check('L7 distinct note', r === null || (/^2 work orders on file/.test(r) && /1 distinct work order/.test(r)), r);
  }],
  ['loop2 L8 "anything expiring" says how many are already expired', [doc('certificate-of-insurance', [['vendor', 'Ladle Foods'], ['coi_expires', '2026-10-12']]), doc('certificate-of-insurance', [['vendor', 'Old Roofing'], ['coi_expires', '2026-09-01']])], async (ask) => {
    const r = text(await ask('is anything expiring?')); check('L8 expired items are noted', r === null || /already expired or overdue/.test(r), r);
  }],
  ['loop2 L9 a spelling fix is never applied inside a record name', [doc('certificate-of-insurance', [['vendor', 'Expird Pest Control'], ['coi_expires', '2027-03-01']])], async (ask) => {
    check('L9 declines', (await ask('When does Expird Pest Control COI expire?')) === null);
  }],
];
for (const [name, rows, run] of LOOP2) {
  for (const as of [(fn) => H.as('property', fn), (fn) => H.withTenant(ctxB, fn)]) await as(async (db) => { await load(db, rows.filter(Boolean)); await run((q) => ask(db, q)); });
  void name;
}
{
  const g = (r, k) => r?.f.find((a) => a[0] === k)?.[1];
  const rows = (r) => (r?.f ?? []).filter((a) => a[0] === 'rent_roll_row').map((a) => a[1]);
  check('H2 a roll with two rent-like columns is not read', RRT('Unit | Tenant | Market Rent | Actual Rent | Status\n101 | Ann Lee | 1,100.00 | 1,000.00 | Occupied') === null || rows(RRT('Unit | Tenant | Market Rent | Actual Rent | Status\n101 | Ann Lee | 1,100.00 | 1,000.00 | Occupied')).every((x) => !/rent=/.test(x)));
  check('H2 Current / Previous Rent is not read as the rent', rows(RRT('Unit | Tenant | Current Rent | Previous Rent | Status\n101 | Ann Lee | 1,100.00 | 1,000.00 | Occupied')).length === 0);
  check('M5 day-first proved by another date in the document', g(LSX('Lease Start Date: 13/01/2026\nLease End Date: 12/02/2027'), 'lease_end_date') === '2027-02-12');
  check('M5 month-first proved by another date', g(LSX('Lease Start Date: 01/13/2026\nLease End Date: 12/02/2027'), 'lease_end_date') === '2027-12-02');
  check('M5 a document that proves both orders leaves an ambiguous date unreadable', g(LSX('Lease Start Date: 13/01/2026\nLease End Date: 12/02/2027\nSigned 01/31/2026'), 'lease_end_date') == null);
  for (const u of ['4 B', '12 A', 'PH 2', '3 BR', '4th floor', '4B & 4C', '101 and 102', '4, Building B']) check(`M6 unit "${u}" is not cut to its first token`, g(LSX('Lease Start Date: 01/01/2026\nLease End Date: 12/31/2026', u), 'unit_number') == null, String(g(LSX('Lease Start Date: 01/01/2026\nLease End Date: 12/31/2026', u), 'unit_number')));
  for (const u of ['4B', '4-B', '#4B', 'Apt 4B', '4B (1st floor)']) check(`M6 unit "${u}" is read`, g(LSX('Lease Start Date: 01/01/2026\nLease End Date: 12/31/2026', u), 'unit_number')?.replace(/-/g, '') === '4B');
}
/* extractor: co-tenants, ranges, increases */
{
  const L = (extra) => `RESIDENTIAL LEASE AGREEMENT\nTenant Name: Alma Arden\nUnit: 4B\nProperty: 1 Other St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\n${extra}\n`;
  const val = (r, k) => r?.fields.find((x) => x.key === k)?.value;
  check('extractor: a plain rent is read', val(extractProperty([{ page_no: 1, text: L('Monthly Rent: $1,450.00') }], { today: TODAY }), 'rent_amount') === '1450.00');
  for (const bad of ['Monthly Rent: $1,450 - $1,500', 'Monthly Rent: $1,450 to $1,500', 'Monthly Rent: $1,450.00 (increasing to $1,500.00 on 07/01/2026)']) {
    const r = extractProperty([{ page_no: 1, text: L(`${bad}\nSecurity Deposit: $500.00`) }], { today: TODAY }); check(`extractor: not one monthly amount: ${bad}`, r == null || val(r, 'rent_amount') == null, String(val(r, 'rent_amount')));
  }
  const co = extractProperty([{ page_no: 1, text: L('Co-Tenant: Jane Doe\nMonthly Rent: $1,450.00') }], { today: TODAY });
  check('extractor: a lease with a co-tenant is not read as a sole tenant', co == null || !(val(co, 'tenant_name') === 'Alma Arden' && !co.fields.some((x) => x.key === 'tenant_name' && x.value !== 'Alma Arden')));
}
await H.stop?.();
console.log(`property review regressions: ${failures ? failures + ' FAILED, ' : ''}${passes} passed`);
if (failures) process.exit(1);
