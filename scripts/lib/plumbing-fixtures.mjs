/**
 * Plumbing fixture set (Build 2, stage 2C): a seeded, deterministic paper trail for ONE plumbing contractor
 * ("Canyon State Plumbing LLC", Arizona), rendered as page text, plus TRUTH worked out from the raw SPECS only
 * (never from any lane or extractor). TODAY is fixed so due/overdue/expiry answers are stable.
 *
 * SEMANTIC DECISIONS (the contract between fixture author and engineer; the questions file repeats the ones it relies on):
 *  D1  A backflow DEVICE is identified by serial number (the same serial on several certificates = one device). Only the
 *      LATEST test (by test date, i.e. service_date) per device is current; older certificates for the same device are history
 *      and never count toward due/overdue/result/tester answers.
 *  D2  OVERDUE: next_test_due < TODAY. DUE TODAY: next_test_due == TODAY (not overdue). DUE WITHIN N DAYS: TODAY <= due <= TODAY+N
 *      (inclusive at both ends, so a device due exactly TODAY+30 is inside "next 30 days"; overdue devices are NOT in a due-soon list).
 *  D3  A device whose current (latest) test FAILED is "failed, needs retest". Failed certificates in this fixture print no
 *      next_test_due, and failed devices never appear in due-soon or overdue lists; they appear only in the failed list.
 *      A device that failed and was later retested and PASSED is current = passed (the failed certificate is history).
 *  D4  WATER HEATER warranty: warranty_expires is what the warranty-registration prints (install date + term). A heater with no
 *      registration on file has NO known warranty (a null answer, never computed from brand/age). UNDER WARRANTY = expires >= TODAY;
 *      EXPIRED = expires < TODAY. EXPIRING WITHIN N DAYS: TODAY <= expires <= TODAY+N (heaters with a registration only).
 *  D5  PERMIT state (from the printed status and the printed expiry date): status Final or Closed = finished (never open, never
 *      expired, whatever the expiry date). Otherwise permit_expires < TODAY = EXPIRED (even if the paper still says "Open");
 *      otherwise OPEN. Expiring within N days: open permits with TODAY <= permit_expires <= TODAY+N.
 *  D6  Counts of documents by type count every document of that type on file, near-duplicates and history included (14 backflow
 *      certificates = 12 distinct devices). Wrong-type documents (HVAC sheet, cover page, a letter that merely mentions a backflow
 *      test) carry NO data fields and never count as data: they count only under the type they really are.
 *  D7  A tank heater's size is gallons; tankless heaters have no gallons (a size question about one is not asked).
 *  D8  Invoice total for a customer = sum of the printed totals of every invoice on file for that customer.
 *  D9  Dates in answers are written long ("March 4, 2026"); pages show ISO, long or US dates, so the selfcheck compares dates by value.
 */
export const TODAY = '2026-10-05';
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const long = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
export const us = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const addYears = (iso, n) => { const [y, m, d] = iso.split('-'); return `${Number(y) + n}-${m}-${d}`; };
export const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmts = [(i) => i, long, us];

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const COMPANY = 'Canyon State Plumbing LLC';
export const SITES = [
  { id: 's1', addr: '412 Elm Street', city: 'Tempe', cust: 'Harlan Moss' },
  { id: 's2', addr: '88 Harmon Street', city: 'Mesa', cust: 'Pruitt Dental Group' },
  { id: 's3', addr: '1907 Oak Ridge Drive', city: 'Chandler', cust: 'Lena Okafor' },
  { id: 's4', addr: '5530 Warehouse Way', city: 'Gilbert', cust: 'Tillman Freight LLC' },
  { id: 's5', addr: '23 Juniper Court', city: 'Phoenix', cust: 'Corliss Bakery' },
  { id: 's6', addr: '740 Birchwood Lane', city: 'Scottsdale', cust: 'Nadine Ferrara' },
  { id: 's7', addr: '3300 Granite Parkway', city: 'Tempe', cust: 'Basalt Brewing Co' },
  { id: 's8', addr: '61 Sagebrush Trail', city: 'Queen Creek', cust: 'Orin Vasquez' },
  { id: 's9', addr: '9000 Ridge View Boulevard', city: 'Peoria', cust: 'Saguaro Ridge HOA' },
  { id: 's10', addr: '150 Main Street', city: 'Glendale', cust: 'Mesquite Grill' },
  { id: 's11', addr: '2210 Cactus Wren Way', city: 'Mesa', cust: 'Delgado Family' },
  { id: 's12', addr: '700 Thornbird Way', city: 'Gilbert', cust: 'Thornbird Apartments' },
];
export const site = (id) => SITES.find((s) => s.id === id);
export const TESTERS = [{ name: 'Marcus Bell', cert: 'AZ-BF-20411' }, { name: 'Tonya Reyes', cert: 'AZ-BF-18877' }, { name: 'Dale Whitaker', cert: 'AZ-BF-22190' }];

/* ---------- RAW SPECS ---------- */
const KIND_LONG = { RPZ: 'RPZ - Reduced Pressure Zone', DCVA: 'DCVA - Double Check Valve Assembly', PVB: 'PVB - Pressure Vacuum Breaker' };
const dev = (id, siteId, kind, make, model, size, loc, util, serial, t, certs) => ({ id, site: siteId, kind, make, model, size, loc, util, serial, tester: TESTERS[t], certs });
const pass = (file, testOff) => { const test = addDays(TODAY, testOff); return { file, test, result: true, due: addDays(test, 365) }; };
const fail = (file, testOff) => ({ file, test: addDays(TODAY, testOff), result: false, due: null });
export const DEVICES = [
  dev('bf1', 's2', 'RPZ', 'Watts', '909', '1 inch', 'front yard by meter', 'City of Mesa Water', 'WT-909-48213', 0, [pass('bf1-cert.pdf', 20 - 365)]),
  dev('bf2', 's4', 'DCVA', 'Febco', '765', '2 inch', 'north side of building', 'Town of Gilbert Water', 'FB-765-30977', 1, [pass('bf2-cert.pdf', 75 - 365)]),
  dev('bf3', 's5', 'PVB', 'Watts', '800M4', '3/4 inch', 'rear patio hose bib line', 'City of Phoenix Water Services', 'WT-800-11452', 2, [pass('bf3-cert.pdf', 45 - 365)]),
  dev('bf4', 's9', 'RPZ', 'Zurn Wilkins', '375', '4 inch', 'irrigation main at Ridge View Boulevard', 'City of Peoria Utilities', 'ZW-375-70418', 0, [pass('bf4-cert.pdf', -15 - 365)]),
  dev('bf5', 's10', 'DCVA', 'Wilkins', '350', '1-1/2 inch', 'alley side by grease trap', 'City of Glendale Water', 'WK-350-26690', 1, [pass('bf5-cert.pdf', -60 - 365)]),
  dev('bf6', 's7', 'RPZ', 'Watts', '009', '1 inch', 'brewhouse water entry', 'City of Tempe Water Utilities', 'WT-009-55120', 2, [fail('bf6-cert-old.pdf', -120), pass('bf6-cert.pdf', -100)]),
  dev('bf7', 's3', 'PVB', 'Febco', '720', '1 inch', 'front yard sprinkler valve box', 'City of Chandler Water', 'FB-720-81334', 1, [fail('bf7-cert.pdf', -8)]),
  dev('bf8', 's1', 'DCVA', 'Watts', '007', '3/4 inch', 'garage wall near meter', 'City of Tempe Water Utilities', 'WT-007-90021', 0, [pass('bf8-cert.pdf', -365)]),
  dev('bf9', 's6', 'PVB', 'Zurn Wilkins', '720A', '3/4 inch', 'side yard hose bib', 'City of Scottsdale Water', 'ZW-720-64502', 1, [pass('bf9-cert.pdf', 30 - 365)]),
  dev('bf10', 's11', 'RPZ', 'Watts', '909', '2 inch', 'front yard by meter', 'City of Mesa Water', 'WT-909-73660', 2, [pass('bf10-cert-old.pdf', -700), pass('bf10-cert.pdf', -300)]),
  dev('bf11', 's9', 'DCVA', 'Febco', '850', '2 inch', 'clubhouse landscape line', 'City of Peoria Utilities', 'FB-850-22741', 0, [fail('bf11-cert.pdf', -30)]),
  dev('bf12', 's8', 'RPZ', 'Watts', '009', '1 inch', 'south side by meter', 'Town of Queen Creek Utilities', 'WT-009-38815', 1, [pass('bf12-cert.pdf', 90 - 365)]),
];

const wh = (id, siteId, make, model, serial, tankless, gal, fuel, install, term, reg, inv) => ({ id, site: siteId, make, model, serial, tankless, gal, fuel, install, term, reg, inv, exp: reg ? addYears(install, term) : null, regDate: reg ? addDays(install, 14) : null, startFile: `${id}-startup.pdf`, regFile: reg ? `${id}-warranty.pdf` : null });
export const HEATERS = [
  wh('w1', 's1', 'Rheem', 'XG50T06EC36U1', 'RH-W2043-1190', false, 50, 'gas', '2020-11-12', 6, true, 'INV-3101'),
  wh('w2', 's3', 'A.O. Smith', 'ENT-40', 'AO-K1603-4471', false, 40, 'electric', '2016-03-04', 6, true, null),
  wh('w3', 's4', 'Bradford White', 'RG250T6', 'BW-DB2101-3358', false, 50, 'gas', '2021-01-20', 10, false, null),
  wh('w4', 's6', 'Navien', 'NPE-240A2', 'NV-2406-18803', true, null, 'gas', '2024-06-18', 10, true, 'INV-3102'),
  wh('w5', 's8', 'Rinnai', 'RU199iN', 'RN-1612-90417', true, null, 'gas', '2016-12-20', 10, true, null),
  wh('w6', 's10', 'Rheem', 'PROE40T2RH95', 'RH-W1909-5526', false, 40, 'electric', '2019-09-30', 6, true, null),
  wh('w7', 's11', 'A.O. Smith', 'GCR-75', 'AO-M2604-7712', false, 75, 'gas', '2026-04-14', 10, true, 'INV-3103'),
  wh('w8', 's5', 'Navien', 'NPE-180A', 'NV-2502-60934', true, null, 'gas', '2025-02-11', 10, false, null),
  wh('w9', 's2', 'Bradford White', 'RE330T6', 'BW-DC2012-8841', false, 30, 'electric', '2020-12-28', 6, true, null),
  wh('w10', 's7', 'Rheem', 'RTEX-18', 'RH-T2307-2250', true, null, 'electric', '2023-07-07', 10, true, 'INV-3104'),
];

const pm = (id, siteId, no, jur, type, issued, expires, status, rough, final) => ({ id, site: siteId, no, jur, type, issued, expires, status, rough, final, file: `${id}-permit.pdf`, roughFile: rough ? `${id}-rough.pdf` : null, finalFile: final ? `${id}-final.pdf` : null });
export const PERMITS = [
  pm('p1', 's7', 'PL-26-03300', 'City of Tempe Building Safety', 'repipe', '2026-02-02', '2026-08-01', 'Final', { date: '2026-03-12', result: 'Passed' }, { date: '2026-06-23', result: 'Passed' }),
  pm('p2', 's2', 'PL-26-07788', 'City of Mesa Development Services', 'sewer', '2026-08-10', '2027-02-06', 'Open', { date: '2026-09-02', result: 'Passed' }, null),
  pm('p3', 's4', 'PL-26-05530', 'Town of Gilbert Development Services', 'gas line', '2026-04-01', '2026-09-28', 'Expired', { date: '2026-05-06', result: 'Passed' }, null),
  pm('p4', 's11', 'PL-26-01107', 'City of Mesa Development Services', 'water heater', '2026-04-12', '2026-10-09', 'Open', null, null),
  pm('p5', 's3', 'PL-26-01907', 'City of Chandler Building Services', 'repipe', '2026-01-12', '2026-07-11', 'Open', { date: '2026-02-19', result: 'Failed' }, null),
  pm('p6', 's9', 'PL-26-09000', 'City of Peoria Building Safety', 'sewer', '2026-09-01', '2027-02-28', 'Open', null, null),
  pm('p7', 's5', 'PL-25-00023', 'City of Phoenix Planning and Development', 'water heater', '2025-02-05', '2025-08-04', 'Closed', null, { date: '2025-02-20', result: 'Passed' }),
];

export const CAMERAS = [
  { id: 'c1', site: 's1', date: '2026-05-19', loc: 'main sewer line from cleanout to street', len: '86 ft', findings: ['Root intrusion at 42 ft', 'Offset joint at 61 ft'], rec: 'Hydro-jet the line and repair the joint at 61 ft', footage: 'VID-0519-412ELM.mp4', pages: 1 },
  { id: 'c2', site: 's9', date: '2026-08-27', loc: 'clubhouse lateral to main in Ridge View Boulevard', len: '212 ft', findings: ['Cracked clay pipe at 74 ft', 'Heavy scale buildup from 120 to 140 ft', 'Belly (sag) at 188 ft'], rec: 'Line the pipe from 70 to 80 ft and descale the line', footage: 'VID-0827-RIDGEVIEW-CLUB.mp4', pages: 2 },
  { id: 'c3', site: 's10', date: '2026-02-03', loc: 'kitchen drain line to grease interceptor', len: '54 ft', findings: ['No defects observed'], rec: 'No action required', footage: 'VID-0203-150MAIN.mp4', pages: 1 },
  { id: 'c4', site: 's3', date: '2026-09-14', loc: 'main sewer line from house to property line', len: '97 ft', findings: ['Belly (sag) at 28 ft', 'Cracked pipe at 55 ft'], rec: 'Replace the 12 ft section starting at 52 ft', footage: 'VID-0914-1907OAK.mp4', pages: 1 },
];

export const TICKETS = [
  { id: 't1', site: 's6', date: '2026-09-22', tech: 'Jenna Pike', work: ['Cleared kitchen drain stoppage', 'Replaced P-trap'], cost: 215.0, type: 'drain cleaning' },
  { id: 't2', site: 's1', date: '2026-08-03', tech: 'Rafael Ortiz', work: ['Replaced toilet fill valve'], cost: 148.5, type: 'repair' },
  { id: 't3', site: 's10', date: '2026-09-30', tech: 'Marcus Bell', work: ['Jetted grease line', 'Pumped grease trap'], cost: 389.0, type: 'drain cleaning' },
  { id: 't4', site: 's5', date: '2026-07-15', tech: 'Jenna Pike', work: ['Replaced hose bib at rear wall'], cost: 132.0, type: 'repair' },
  { id: 't5', site: 's8', date: '2026-10-01', tech: 'Rafael Ortiz', work: ['Repaired supply leak under kitchen sink'], cost: 176.25, type: 'leak repair' },
];
export const WORKORDERS = [
  { id: 'wo1', site: 's2', date: '2026-10-12', tech: 'Dale Whitaker', work: ['Install two lavatory faucets', 'Replace angle stops'] },
  { id: 'wo2', site: 's7', date: '2026-09-18', tech: 'Jenna Pike', work: ['Replace brewhouse floor drain grate'] },
  { id: 'wo3', site: 's11', date: '2026-08-25', tech: 'Rafael Ortiz', work: ['Install pressure reducing valve'] },
];
const inv = (n, siteId, amount, desc, date) => ({ n, site: siteId, amount, desc, date, file: `invoice-${n.slice(4)}.pdf` });
export const INVOICES = [
  inv('INV-3101', 's1', 1845.0, 'Water heater replacement', '2020-11-13'),
  inv('INV-3102', 's6', 3420.5, 'Tankless water heater installation', '2024-06-19'),
  inv('INV-3103', 's11', 2260.0, 'Water heater replacement', '2026-04-15'),
  inv('INV-3104', 's7', 3980.0, 'Tankless water heater installation', '2023-07-08'),
  inv('INV-3105', 's2', 385.0, 'Backflow test and report', '2026-09-16'),
  inv('INV-3106', 's2', 612.75, 'Drain cleaning', '2026-09-28'),
  inv('INV-3107', 's9', 1150.0, 'Backflow tests, two devices', '2026-09-08'),
  inv('INV-3108', 's9', 4730.25, 'Irrigation repipe', '2026-09-22'),
  inv('INV-3109', 's10', 295.0, 'Backflow annual test', '2026-08-30'),
  inv('INV-3110', 's4', 5215.0, 'Gas line extension', '2026-04-29'),
];
export const PROPOSAL = { file: 'proposal-q2210.pdf', site: 's9', no: 'Q-2210', amount: 18400.0, scope: 'Repipe clubhouse and pool house with PEX', date: '2026-09-10' };
export const AGREEMENT = { file: 'agreement-mesquite.pdf', site: 's10', term: '12 months', start: '2026-03-01', scope: 'Annual backflow test and quarterly grease trap pumping' };
export const PO = { file: 'po-7745.pdf', no: 'PO-7745', vendor: 'Ferguson Enterprises', date: '2026-09-29', item: 'Navien NPE-240A2 tankless water heater', cost: 1695.0 };
export const DISPATCH = { file: 'dispatch-1005.pdf', site: 's8', date: '2026-10-06', tech: 'Rafael Ortiz', note: 'Check low water pressure at kitchen sink' };

/* ---------- RENDERING ---------- */
const NOISE = ['Scanned by CamScanner', 'Pg 1/1  ~~ 300dpi ~~', 'Doc ID 44-71B', 'FAX RECEIVED 10/04 08:12', 'Page scanned - skew corrected', 'Printed from field tablet'];
const L = {
  addr: ['Service Address', 'Site Address', 'Property'], cust: ['Customer', 'Owner', 'Account'],
  tester: ['Tester Name', 'Tested By', 'Tester'], cert: ['Tester Cert No', 'Cert #', 'AZ Cert No.'],
  serial: ['Serial Number', 'Assembly Serial #', 'Serial No.'], model: ['Model', 'Model No', 'Mdl'], make: ['Manufacturer', 'Make', 'Mfr'],
  size: ['Size', 'Device Size', 'Assy Size'], loc: ['Device Location', 'Location', 'Installed At'], util: ['Water Utility', 'Filed With', 'Utility'],
  tdate: ['Test Date', 'Date Tested', 'Tested On'], result: ['Result', 'Pass/Fail', 'Test Result'], due: ['Next Test Due', 'Annual Test Due', 'Retest Due'],
  dtype: ['Device Type', 'Type', 'Assembly'],
};
/** Render one document. fn({style,d,addrText}) -> {titles:[3], rows:[{key,labels,v,page,date,keep}], extra?:[{t,page}]}. Field specs record the true value (ISO for dates) and page. */
function mkDoc(R, docs, filename, type, idx, fn, spec = {}) {
  const style = idx % 3;
  const ctx = { style, idx, d: (iso) => fmts[(idx + style) % 3](iso), addrText: (s) => (style === 2 && idx % 2 === 0 ? s.addr : `${s.addr}, ${s.city} AZ`) };
  const { titles, rows: rr, extra = [] } = fn(ctx);
  let rows = rr.slice();
  if (style > 0) { const head = rows.filter((r) => r.keep); const rest = rows.filter((r) => !r.keep); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } rows = [...head, ...rest]; }
  const sep = style === 0 ? ': ' : style === 1 ? ' : ' : ':  ';
  const maxPage = Math.max(1, ...rows.map((r) => r.page ?? 1));
  const ocrIdx = style === 2 && R() < 0.5 ? Math.floor(R() * rows.length) : -1;
  const fields = {}; const pages = [];
  for (let p = 1; p <= maxPage; p++) {
    const lines = [];
    const t = titles[style]; lines.push(style === 2 ? t[0] + t.slice(1).toLowerCase() : t);
    if (maxPage > 1) lines.push(p === 1 ? `Page 1 of ${maxPage}` : `Page ${p} of ${maxPage} (continued)`);
    rows.forEach((r, ri) => {
      if ((r.page ?? 1) !== p) return;
      let lab = r.labels[style]; if (ri === ocrIdx && /[lO]/.test(lab.slice(1))) lab = lab[0] + lab.slice(1).replace('l', '1').replace('O', '0');
      if (Array.isArray(r.v)) { lines.push(`${lab}${sep.trim()}`); r.v.forEach((x, k) => lines.push(style === 1 ? `- ${x}` : `${k + 1}. ${x}`)); }
      else lines.push(`${lab}${sep}${r.date ? ctx.d(r.v) : r.v}`);
      if (r.key) fields[r.key] = { value: r.v, page: p, date: !!r.date };
    });
    extra.filter((e) => (e.page ?? 1) === p).forEach((e) => lines.push(e.t));
    if (style > 0) lines.push(NOISE[Math.floor(R() * NOISE.length)]);
    pages.push(lines.join('\n'));
  }
  docs.push({ filename, type, pages, fields, style, ...spec });
}
const row = (key, labels, v, o = {}) => ({ key, labels, v, ...o });
const addrRows = (s, ctx) => [row('service_address', L.addr, ctx.addrText(s)), row('customer_name', L.cust, s.cust)];

export function buildDocs() {
  const R = rng(20261005);
  const docs = []; let idx = 0;
  const add = (filename, type, fn, spec) => { mkDoc(R, docs, filename, type, idx++, fn, spec); };
  // backflow certificates (several devices; failed-then-retested and older/newer pairs are near-duplicates)
  for (const dv of DEVICES) {
    const s = site(dv.site);
    for (const c of dv.certs) add(c.file, 'backflow-test-certificate', (ctx) => {
      const res = ctx.style === 0 ? (c.result ? 'Passed' : 'Failed') : ctx.style === 1 ? (c.result ? 'Pass' : 'Fail') : (c.result ? 'PASS' : 'FAIL');
      const rows = [
        row('equipment_type', L.dtype, KIND_LONG[dv.kind]), ...addrRows(s, ctx),
        row('manufacturer', L.make, dv.make), row('model', L.model, dv.model), row('serial_number', L.serial, dv.serial), row('device_size', L.size, dv.size),
        row('device_location', L.loc, dv.loc), row('water_utility', L.util, dv.util),
        row('technician', L.tester, dv.tester.name), row('tester_cert_number', L.cert, dv.tester.cert),
        row('service_date', L.tdate, c.test, { date: true }), row('backflow_test_result', L.result, res),
      ];
      if (c.due) rows.push(row('next_test_due', L.due, c.due, { date: true }));
      return { titles: ['BACKFLOW PREVENTION ASSEMBLY TEST REPORT', 'BACKFLOW TEST CERTIFICATE', 'BACKFLOW ASSEMBLY TEST AND MAINTENANCE REPORT'], rows, extra: c.due ? [] : [{ t: ctx.style === 0 ? 'Notes: Assembly failed. Repair and retest required.' : 'Assembly failed - repair and retest required' }] };
    }, { device: dv.id, cert: c });
  }
  // water heater startup / installation records (w7 is two pages: make, model, serial on page 2)
  HEATERS.forEach((w, wi) => {
    const s = site(w.site); const pg = w.id === 'w7' ? 2 : 1;
    add(w.startFile, 'startup-sheet', (ctx) => {
      const rows = [
        ...addrRows(s, ctx),
        row('manufacturer', L.make, w.make, { page: pg }), row('model', L.model, w.model, { page: pg }), row('serial_number', L.serial, w.serial, { page: pg }),
        row('equipment_type', ['Type', 'Heater Type', 'Style'], w.tankless ? 'Tankless' : 'Tank'),
        row('fuel_type', ['Fuel', 'Fuel Type', 'Energy Source'], w.fuel === 'gas' ? (ctx.style === 2 ? 'Natural Gas' : 'gas') : 'electric'),
        row('installation_date', ['Installation Date', 'Date Installed', 'Install Date'], w.install, { date: true }),
        row('technician', ['Technician', 'Installed By', 'Tech'], ['Rafael Ortiz', 'Jenna Pike', 'Dale Whitaker'][wi % 3]),
      ];
      if (!w.tankless) rows.push(row('gallons', ['Tank Size', 'Capacity', 'Gallons'], `${w.gal} gallon`));
      return { titles: wi >= 6 ? ['WATER HEATER INSTALLATION RECORD', 'WATER HEATER INSTALL RECORD', 'WH INSTALLATION RECORD'] : ['WATER HEATER STARTUP SHEET', 'WATER HEATER START-UP SHEET', 'WATER HEATER STARTUP CHECKLIST'], rows };
    }, { heater: w.id });
  });
  for (const w of HEATERS.filter((x) => x.reg)) {
    const s = site(w.site);
    add(w.regFile, 'warranty-registration', (ctx) => ({
      titles: ['WARRANTY REGISTRATION', 'LIMITED WARRANTY REGISTRATION CARD', 'Product Warranty Registration'],
      rows: [...addrRows(s, ctx), row('manufacturer', L.make, w.make), row('model', L.model, w.model), row('serial_number', L.serial, w.serial),
        row('warranty_term', ['Warranty Term', 'Coverage', 'Term of Warranty'], `${w.term} year limited`),
        row('warranty_registered_date', ['Date Registered', 'Registered On', 'Registration Date'], w.regDate, { date: true }),
        row('warranty_expires', ['Warranty Expires', 'Coverage Ends', 'Expiration Date'], w.exp, { date: true })],
    }), { heater: w.id });
  }
  for (const iv of INVOICES) {
    const s = site(iv.site);
    add(iv.file, 'invoice', (ctx) => ({
      titles: ['INVOICE', 'INVOICE', 'Invoice'],
      rows: [row('invoice_number', ['Invoice No', 'Invoice #', 'Inv No.'], iv.n, { keep: true }), ...addrRows(s, ctx), row('work_performed', ['Description', 'Work', 'Services'], [iv.desc]),
        row('service_date', ['Date', 'Invoice Date', 'Date Billed'], iv.date, { date: true }), row('cost', ['Total', 'Amount Due', 'Total Due'], money(iv.amount))],
      extra: [{ t: COMPANY }],
    }), { invoice: iv.n });
  }
  for (const p of PERMITS) {
    const s = site(p.site);
    add(p.file, 'permit', (ctx) => ({
      titles: ['PLUMBING PERMIT', 'PLUMBING PERMIT CARD', 'PERMIT - PLUMBING'],
      rows: [row('permit_number', ['Permit No', 'Permit #', 'Permit Number'], p.no, { keep: true }), row('jurisdiction', ['Issued by', 'Jurisdiction', 'Agency'], p.jur), ...addrRows(s, ctx),
        row('permit_type', ['Permit Type', 'Type of Work', 'Work Type'], p.type), row('permit_issued_date', ['Date Issued', 'Issued', 'Issue Date'], p.issued, { date: true }),
        row('permit_expires', ['Permit Expires', 'Expiration', 'Expires On'], p.expires, { date: true }), row('permit_status', ['Status', 'Permit Status', 'Current Status'], p.status)],
    }), { permit: p.id });
    for (const [stage, ins, file] of [['Rough-in', p.rough, p.roughFile], ['Final', p.final, p.finalFile]]) if (ins) add(file, 'inspection-report', (ctx) => ({
      titles: ['INSPECTION REPORT', 'INSPECTION RESULT NOTICE', 'Plumbing Inspection Report'],
      rows: [row('permit_number', ['Permit No', 'Permit #', 'Permit Number'], p.no, { keep: true }), ...addrRows(s, ctx), row('inspection_type', ['Inspection Type', 'Type of Inspection', 'Inspection'], stage),
        row('service_date', ['Date of Inspection', 'Inspected On', 'Inspection Date'], ins.date, { date: true }), row('inspection_result', ['Result', 'Inspection Result', 'Outcome'], ins.result)],
    }), { permit: p.id, stage });
  }
  for (const c of CAMERAS) {
    const s = site(c.site); const pg = c.pages;
    add(`${c.id}-camera.pdf`, 'sewer-camera-report', (ctx) => ({
      titles: ['SEWER CAMERA INSPECTION REPORT', 'VIDEO LINE INSPECTION REPORT', 'SEWER LINE CAMERA REPORT'],
      rows: [...addrRows(s, ctx), row('service_date', ['Inspection Date', 'Date of Inspection', 'Date Inspected'], c.date, { date: true }), row('line_location', ['Line Inspected', 'Location', 'Area Inspected'], c.loc),
        row('line_length', ['Length Inspected', 'Footage', 'Run Length'], c.len), row('footage_ref', ['Video File', 'Footage Ref', 'Recording'], c.footage),
        row('line_findings', ['Findings', 'Observations', 'Defects Found'], c.findings, { page: pg }), row('recommendation', ['Recommendation', 'Recommended Action', 'Tech Recommendation'], c.rec, { page: pg })],
    }), { camera: c.id });
  }
  for (const t of TICKETS) {
    const s = site(t.site);
    add(`${t.id}-ticket.pdf`, 'service-ticket', (ctx) => ({
      titles: ['SERVICE TICKET', 'SERVICE CALL TICKET', 'Service Ticket'],
      rows: [...addrRows(s, ctx), row('service_date', ['Service Date', 'Date of Service', 'Date'], t.date, { date: true }), row('technician', ['Technician', 'Tech', 'Serviced By'], t.tech), row('service_type', ['Service Type', 'Call Type', 'Type'], t.type),
        row('work_performed', ['Work Performed', 'Work Done', 'Description of Work'], t.work), row('cost', ['Total', 'Amount', 'Ticket Total'], money(t.cost))],
    }), { ticket: t.id });
  }
  for (const w of WORKORDERS) {
    const s = site(w.site);
    add(`${w.id}-workorder.pdf`, 'work-order', (ctx) => ({
      titles: ['WORK ORDER', 'WORK ORDER', 'Work Order'],
      rows: [...addrRows(s, ctx), row('service_date', ['Scheduled Date', 'Scheduled For', 'Date'], w.date, { date: true }), row('technician', ['Assigned To', 'Technician', 'Tech'], w.tech), row('work_performed', ['Scope of Work', 'Work To Be Done', 'Work Order Items'], w.work)],
    }), { workorder: w.id });
  }
  add(PROPOSAL.file, 'proposal-quote', (ctx) => ({ titles: ['PROPOSAL', 'QUOTE', 'Proposal and Quote'], rows: [row('invoice_number', ['Quote No', 'Quote #', 'Proposal No'], PROPOSAL.no, { keep: true }), ...addrRows(site(PROPOSAL.site), ctx), row('work_performed', ['Scope', 'Scope of Work', 'Proposed Work'], [PROPOSAL.scope]), row('service_date', ['Date', 'Quote Date', 'Date Prepared'], PROPOSAL.date, { date: true }), row('cost', ['Total Price', 'Quoted Total', 'Price'], money(PROPOSAL.amount))] }), { oneoff: 'proposal' });
  add(AGREEMENT.file, 'maintenance-agreement', (ctx) => ({ titles: ['MAINTENANCE AGREEMENT', 'ANNUAL MAINTENANCE AGREEMENT', 'Service Agreement'], rows: [...addrRows(site(AGREEMENT.site), ctx), row('agreement_term', ['Agreement Term', 'Term', 'Length of Agreement'], AGREEMENT.term), row('service_date', ['Start Date', 'Effective', 'Begins'], AGREEMENT.start, { date: true }), row('work_performed', ['Services Included', 'Scope', 'Covered Services'], [AGREEMENT.scope])] }), { oneoff: 'agreement' });
  add(PO.file, 'purchase-order', () => ({ titles: ['PURCHASE ORDER', 'PURCHASE ORDER', 'Purchase Order'], rows: [row('invoice_number', ['PO Number', 'PO #', 'Order No'], PO.no, { keep: true }), row(null, ['Vendor', 'Supplier', 'Ordered From'], PO.vendor), row('service_date', ['Order Date', 'Date', 'Ordered'], PO.date, { date: true }), row('part_number', ['Item', 'Description', 'Ordered Item'], PO.item), row('cost', ['Total', 'Order Total', 'Amount'], money(PO.cost))] }), { oneoff: 'po' });
  add(DISPATCH.file, 'dispatch-note', (ctx) => ({ titles: ['DISPATCH NOTE', 'DISPATCH', 'Dispatch Note'], rows: [...addrRows(site(DISPATCH.site), ctx), row('service_date', ['Dispatch Date', 'Date', 'Scheduled'], DISPATCH.date, { date: true }), row('technician', ['Dispatched To', 'Technician', 'Tech'], DISPATCH.tech), row('notes', ['Notes', 'Call Notes', 'Comments'], DISPATCH.note)] }), { oneoff: 'dispatch' });
  // wrong-type documents: carry no data fields; must never count as data
  add('letter-thornbird.pdf', 'correspondence', () => ({ titles: ['LETTER', 'LETTER', 'Letter'], rows: [row(null, ['Date', 'Dated', 'Date'], '2026-09-12', { date: true }), row(null, ['To', 'To', 'To'], 'Thornbird Apartments, 700 Thornbird Way, Gilbert AZ')], extra: [{ t: 'Dear Thornbird Apartments, thank you for calling. Your annual backflow test is coming up in March, and we will send a reminder. A tune-up of the water heater was mentioned but nothing has been scheduled yet. Sincerely, Canyon State Plumbing' }] }), { decoy: true });
  add('hvac-tuneup-thornbird.pdf', 'other', () => ({ titles: ['A/C TUNE-UP SHEET', 'AC TUNE UP SHEET', 'A/C Tune-Up Sheet'], rows: [row(null, ['Site Address', 'Site Address', 'Site Address'], '700 Thornbird Way, Gilbert AZ'), row(null, ['Tonnage', 'Tonnage', 'Tonnage'], '3 ton'), row(null, ['Serial Number', 'Serial Number', 'Serial Number'], 'CX-7781-0092'), row(null, ['Model', 'Model', 'Model'], 'CA17NA036'), row(null, ['Refrigerant', 'Refrigerant', 'Refrigerant'], 'R-410A'), row(null, ['Date Serviced', 'Date Serviced', 'Date Serviced'], '2026-06-10', { date: true }), row(null, ['Next Service Due', 'Next Service Due', 'Next Service Due'], '2027-06-10', { date: true })] }), { decoy: true });
  add('cover-fax.pdf', 'internal', () => ({ titles: ['FAX COVER SHEET', 'FAX COVER SHEET', 'Fax Cover Sheet'], rows: [], extra: [{ t: 'Pages: 1' }] }), { decoy: true });
  return docs;
}

/* ---------- TRUTH (from specs only) ---------- */
export function truth() {
  const lastOf = (d) => [...d.certs].sort((a, b) => (a.test < b.test ? -1 : 1)).at(-1);
  const devices = DEVICES.map((d) => {
    const current = lastOf(d); const history = d.certs.filter((c) => c !== current);
    return { ...d, s: site(d.site), current, history, status: current.result ? 'passed' : 'failed', due: current.result ? current.due : null, tested: current.test, nAtSite: DEVICES.filter((x) => x.site === d.site).length };
  });
  const dueWithin = (n) => devices.filter((d) => d.status === 'passed' && d.due >= TODAY && d.due <= addDays(TODAY, n));
  const overdue = () => devices.filter((d) => d.status === 'passed' && d.due < TODAY);
  const dueToday = () => devices.filter((d) => d.status === 'passed' && d.due === TODAY);
  const failedNoRetest = () => devices.filter((d) => d.status === 'failed');
  const heaters = HEATERS.map((w) => ({ ...w, s: site(w.site) }));
  const whExpiring = (n) => heaters.filter((w) => w.reg && w.exp >= TODAY && w.exp <= addDays(TODAY, n));
  const whExpired = () => heaters.filter((w) => w.reg && w.exp < TODAY);
  const permits = PERMITS.map((p) => ({ ...p, s: site(p.site), state: /^(final|closed)$/i.test(p.status) ? 'finished' : p.expires < TODAY ? 'expired' : 'open' }));
  const openPermits = () => permits.filter((p) => p.state === 'open');
  const expiredPermits = () => permits.filter((p) => p.state === 'expired');
  const permitsExpiring = (n) => openPermits().filter((p) => p.expires >= TODAY && p.expires <= addDays(TODAY, n));
  const customers = [...new Set(INVOICES.map((i) => site(i.site).cust))];
  const invByCust = (cust) => INVOICES.filter((i) => site(i.site).cust === cust);
  const custTotal = (cust) => invByCust(cust).reduce((a, i) => a + i.amount, 0);
  const docs = buildDocs();
  const byType = {}; for (const d of docs) byType[d.type] = (byType[d.type] ?? 0) + 1;
  return { docs, devices, dueWithin, overdue, dueToday, failedNoRetest, heaters, whExpiring, whExpired, permits, openPermits, expiredPermits, permitsExpiring, customers, invByCust, custTotal, byType, site };
}
