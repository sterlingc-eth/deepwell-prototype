/**
 * Loop 4 regressions (property lane + extractor), each a CLASS found by hostile reviewers: a status word read as a tenant (column order),
 * a certificate whose own coverage line is expired / cancelled / dateless, evergreen contracts, a bare work-order date read as "scheduled",
 * printed lease statuses (ended, expired, pending...), calendar-impossible or ambiguous typed dates, noun changes on invoices,
 * unpaid invoices without a due date, and an empty company. Truth is written by hand; a declined answer (null) is acceptable where stated.
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
const rrx = (t) => conv(`RENT ROLL\nProperty: Birch Terrace\n${t}`);
const val = (r, k) => r?.f.find((a) => a[0] === k)?.[1];
const rows = (r) => (r?.f ?? []).filter((a) => a[0] === 'rent_roll_row').map((a) => a[1]);
const HC = 'CERTIFICATE OF LIABILITY INSURANCE\nINSURED: Kestrel Landscaping LLC\nInsurer: Acme Mutual\nPolicy Number: P-1\n';
const CT = (x) => conv(`VENDOR SERVICE CONTRACT\nVendor: Kestrel Landscaping LLC\nProperty: Birch Terrace\nStart Date: 01/01/2025\nEnd Date: 12/31/2025\nMonthly Fee: $500.00\n${x}\n`);
// extractor-only checks (no database)
{
  const rr = rrx('Unit   Status   Tenant   Rent   Lease End\n101   Occupied   Bob Ray   $1,000.00\n102   Occupied   Cy Doe   $1,100.00   12/31/2026\n');
  check('X1 a ragged row never makes a status the tenant', !rows(rr).some((x) => /tenant=Occupied/i.test(x)), rows(rr).join(' | '));
  const rr2 = rrx('Unit | Status | Tenant | Rent | Lease End\n204 | Month-to-month | Dee Fox | 900.00 |\n205 | Occupied | Ed Ng | 950.00 | 12/31/2026\n');
  check('X1b month-to-month before tenant never swaps', !rows(rr2).some((x) => /tenant=Month/i.test(x)), rows(rr2).join(' | '));
  for (const x of ['General Liability Expiration Date: Expired 09/01/2026\nWorkers Comp Expires: 03/01/2027', 'General Liability: Cancelled\nWorkers Comp Expires: 03/01/2027', 'General Liability Expires: N/A\nWorkers Comp Expires: 03/01/2027', 'General Liability: Lapsed\nWorkers Comp Expires: 03/01/2027']) {
    const r = conv(HC + x); check(`X2 a certificate with a lapsed / dateless coverage is not read as current: ${x.split('\n')[0]}`, r === null || val(r, 'coi_expires') == null);
  }
  check('X2 a plain certificate is still read', val(conv(HC + 'General Liability Expires: 03/01/2027'), 'coi_expires') === '2027-03-01');
  for (const x of ['Renewal: Evergreen', 'Renews annually', 'Renews: Automatically', 'This agreement will renew automatically for successive one year terms.', 'Renewal terms: 1 year\nAutomatic Renewal: Opt-out required']) {
    const r = CT(x); const a = val(r, 'auto_renew'); check(`X3 renewal wording is never silently dropped: ${x.split('\n')[0]}`, r && a != null && a !== 'no', String(a));
  }
  check('X3 an explicit no stays no', val(CT('Auto-Renew: No'), 'auto_renew') === 'no');
  const w = conv('WORK ORDER\nWO #: 9001\nProperty: Birch Terrace\nUnit: 6\nStatus: Open\nVendor: Jay Fence LLC\nDate: 10/03/2026\n');
  check('X4 a bare Date on a work order is not the scheduled date', val(w, 'service_date') == null, String(val(w, 'service_date')));
}
const L4 = [
  ['X5 a lease that says it ended / expired / is pending / holdover is never a plain running lease', ['Ended', 'Expired', 'Pending', 'Holdover', 'Evicted'].map((st, i) => doc('lease-agreement', [['tenant_name', `Quinn Hall${'abcde'[i]}`], ['unit_number', `${i + 6}`], ['property_name', 'Maple Court'], ['service_address', '12 Maple St, Mesa AZ'], ['lease_start_date', '2026-02-01'], ['lease_end_date', '2027-01-31'], ['rent_amount', '1300'], ['status', st]])), async (ask) => {
    for (let i = 0; i < 5; i++) { const w = text(await ask(`Who lives in unit ${i + 6}?`)); check(`X5 who unit ${i + 6}`, w === null || !/is the tenant of/.test(w), w); const rn = text(await ask(`What is the rent for unit ${i + 6}?`)); check(`X5 rent unit ${i + 6}`, rn === null || !/1,300/.test(rn), rn); }
    const e = text(await ask('Which leases are expired?')); check("X5 expired list is not a plain None", e === null || !/^None/.test(e) || /disagree/.test(e), e);
  }],
  ['X6 who-lives never states a lease end the rent roll contradicts', [lease('1A', 'Ann Lee', '2027-12-31', 'Maple Court', '12 Maple St, Mesa AZ'), conv('RENT ROLL\nProperty: Maple Court\nUnit | Tenant | Lease End | Rent | Status\n1A | Ann Lee | 12/31/2026 | $1,000.00 | Occupied\n')], async (ask) => {
    const r = text(await ask('Who lives in unit 1A?')); check('X6 no single end date', r === null || !/lease through/.test(r), r);
  }],
  ['X7 calendar-impossible typed dates are unreadable, never a date', ['2026-02-30', '2026-11-31', '2026-13-01', '2026-00-10'].map((d, i) => doc('certificate-of-insurance', [['vendor', `Bad Date ${'ABCD'[i]} LLC`], ['coi_expires', '2027-03-01', d]])), async (ask) => {
    for (const v of 'ABCD') { const r = text(await ask(`When does Bad Date ${v} LLC insurance expire?`)); check(`X7 ${v} no NaN / undefined / invented date`, r === null || !/undefined|NaN|February 30|November 31/.test(r), r); }
    const l = text(await ask('Which certificates expire in the next 60 days?')); check('X7 list never lists November 31', l === null || !/November 31/.test(l) && !/^None/.test(l), l);
    const a = text(await ask('What needs attention?')); check('X7 attention not "None."', a === null || !/^None/.test(a), a);
  }],
  ['X8 a typed slash date whose order is unknown is never read month-first', [doc('certificate-of-insurance', [['vendor', 'Slash Co'], ['coi_expires', '2027-03-01', '5/6/2027']])], async (ask) => {
    const r = text(await ask('When does Slash Co insurance expire?')); check('X8 declines or states neither guess', r === null || !/May 6/.test(r), r);
  }],
  ['X9 invoices: a different noun is never answered with an invoice list', [inv('Qux Inc', 'Q-1', '$300.00', 'Unpaid', '2026-09-01'), inv('Rax Inc', 'R-1', '$500.00', 'Unpaid', '2026-09-02')], async (ask) => {
    for (const q of ['Which vendors have unpaid invoices?', 'Which properties have overdue invoices?', 'Which units have unpaid invoices?', 'which tenants have unpaid invoices']) check(`X9 declines: ${q}`, (await ask(q)) === null);
    check('X9 invoices still counted', /^2 invoices overdue/.test(text(await ask('How many invoices are overdue?')) ?? ''));
  }],
  ['X10 an unpaid invoice with no due date is named, never "all clear"', [doc('invoice', [['vendor', 'Zed Co'], ['invoice_number', 'Z-1'], ['cost', '$5.00'], ['status', 'Unpaid'], ['property_name', 'Maple Court']])], async (ask) => {
    const r = text(await ask('Which invoices are overdue?')); check('X10 overdue list says it could not check', r === null || /no readable due date/.test(r), r);
    const a = text(await ask('What needs attention?')); check('X10 attention says it could not check', a === null || /no readable due date/.test(a), a);
  }],
  ['X11 a company with no vendors is never "every vendor has a certificate"', [], async (ask) => {
    const r = text(await ask('Which vendors have no certificate of insurance?')); check('X11 declines or says nothing on file', r === null || !/^None\. Every vendor/.test(r), r);
  }],
  ['X12 workers-comp fact never contradicts the text', [coi('Moss Electric', '2027-03-01', [['workers_comp', 'Yes']])], async (ask) => {
    const r = await ask('Does Moss Electric carry workers comp?'); check('X12 no "none listed" fact beside a Yes', !r || !/^Yes/.test(r.text) || !r.facts?.some((f) => /none listed/.test(String(f.value))), JSON.stringify(r?.facts));
  }],
];
for (const [, rows0, run] of L4) for (const as of [(fn) => H.as('property', fn), (fn) => H.withTenant(ctxB, fn)]) await as(async (db) => { await load(db, rows0.filter(Boolean)); await run((q) => ask(db, q)); });
await H.stop?.();
console.log(`property loop 4 regressions: ${failures ? failures + ' FAILED, ' : ''}${passes} passed`);
if (failures) process.exit(1);
