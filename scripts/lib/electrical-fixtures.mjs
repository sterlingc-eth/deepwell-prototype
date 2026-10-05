/**
 * Electrical fixture set (Build 2, 2B): a seeded, deterministic electrical contractor's paperwork as page text, plus the
 * TRUTH worked out from the specs (never from the lane or the extractor). TODAY is fixed so expiry answers are stable.
 */
export const TODAY = '2026-10-05';
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const long = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
const us = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmts = [(i) => i, long, us];

export const SITES = [
  { id: 's1', addr: '412 Elm Street', city: 'Tempe', cust: 'Harlan Moss', jur: 'City of Tempe Building Safety', no: 'EL-26-04412', amps: '200 A', volt: '120/240 V', phase: 'single phase', ed: '2023 NEC', rough: 'Passed', final: 'Passed', cert: false, load: { conn: '38,400 VA', dem: '24,150 VA' } },
  { id: 's2', addr: '88 Harmon Street', city: 'Mesa', cust: 'Pruitt Dental Group', jur: 'City of Mesa Development Services', no: 'EL-26-07788', amps: '400 A', volt: '277/480 V', phase: 'three phase', ed: '2020 NEC', rough: 'Failed', final: null, cert: false, corr: ['Missing GFCI protection at kitchen counter receptacles', 'Panel directory not labeled', 'Bonding jumper required at water meter'], load: { conn: '152,000 VA', dem: '98,400 VA' } },
  { id: 's3', addr: '1907 Oak Ridge Drive', city: 'Chandler', cust: 'Lena Okafor', jur: 'City of Chandler Building Services', no: 'EL-26-01907', amps: '200 A', volt: '120/240 V', phase: 'single phase', ed: '2023 NEC', rough: 'Passed', final: null, cert: false },
  { id: 's4', addr: '5530 Warehouse Way', city: 'Gilbert', cust: 'Tillman Freight LLC', jur: 'Town of Gilbert Development Services', no: 'EL-26-05530', amps: '800 A', volt: '277/480 V', phase: 'three phase', ed: '2020 NEC', rough: 'Passed', final: 'Passed', cert: true, load: { conn: '412,500 VA', dem: '301,200 VA' } },
  { id: 's5', addr: '23 Juniper Court', city: 'Phoenix', cust: 'Corliss Bakery', jur: 'City of Phoenix Planning and Development', no: 'EL-26-00023', amps: '225 A', volt: '120/208 V', phase: 'three phase', ed: '2023 NEC', rough: 'Corrections Required', final: null, cert: false, corr: ['Arc-fault protection missing on bedroom circuits', 'Exposed conductors at junction box'] },
  { id: 's6', addr: '740 Birchwood Lane', city: 'Scottsdale', cust: 'Nadine Ferrara', jur: 'City of Scottsdale Building Inspection', no: 'EL-26-00740', amps: '150 A', volt: '120/240 V', phase: 'single phase', ed: '2017 NEC', rough: 'Passed', final: 'Failed', cert: false, corr: ['Smoke alarm interconnect not verified'] },
  { id: 's7', addr: '3300 Granite Parkway', city: 'Tempe', cust: 'Basalt Brewing Co', jur: 'City of Tempe Building Safety', no: 'EL-26-03300', amps: '600 A', volt: '120/208 V', phase: 'three phase', ed: '2023 NEC', rough: 'Approved', final: 'Approved', cert: false },
  { id: 's8', addr: '61 Sagebrush Trail', city: 'Queen Creek', cust: 'Orin Vasquez', jur: 'Town of Queen Creek Building Safety', no: 'EL-26-00061', amps: '100 A', volt: '120/240 V', phase: 'single phase', ed: '2023 NEC', rough: null, final: null, cert: false },
];
const pn = (s) => s.no;
const issued = (i) => addDays('2026-03-02', i * 11);

/** The page text of every document, in order, plus the spec that made it. */
export function buildDocs() {
  const docs = [];
  const add = (filename, type, pages, spec = {}) => docs.push({ filename, type, pages, ...spec });
  SITES.forEach((s, i) => {
    const iss = issued(i); const exp = addDays(iss, 180); const f = fmts[i % 3];
    s.issued = iss; s.expires = exp;
    add(`${s.id}-permit.pdf`, 'permit', [`ELECTRICAL PERMIT\nPermit No: ${s.no}\nIssued by: ${s.jur}\nSite Address: ${s.addr}, ${s.city} AZ\nOwner: ${s.cust}\nDate Issued: ${f(iss)}\nPermit Expires: ${f(exp)}\nCode: ${s.ed}\nScope: Electrical service and branch wiring`], { site: s });
    if (s.rough) {
      const d = addDays(iss, 20 + i);
      s.roughDate = d;
      add(`${s.id}-rough.pdf`, 'inspection-report', [`INSPECTION REPORT\nPermit No: ${s.no}\nSite Address: ${s.addr}, ${s.city} AZ\nCustomer: ${s.cust}\nInspection Type: Rough-in\nDate of Inspection: ${fmts[(i + 1) % 3](d)}\nResult: ${s.rough}${s.rough !== 'Passed' && s.rough !== 'Approved' && s.corr ? '\nCorrections:\n' + s.corr.map((c, k) => `${k + 1}. ${c}`).join('\n') : ''}`], { site: s, stage: 'rough' });
    }
    if (s.final) {
      const d = addDays(iss, 60 + i);
      s.finalDate = d;
      add(`${s.id}-final.pdf`, 'inspection-report', [`INSPECTION REPORT\nPermit No: ${s.no}\nSite Address: ${s.addr}, ${s.city} AZ\nCustomer: ${s.cust}\nInspection Type: Final\nDate of Inspection: ${fmts[(i + 2) % 3](d)}\nResult: ${s.final}${s.final === 'Failed' && s.corr ? '\nCorrections:\n' + s.corr.map((c, k) => `${k + 1}. ${c}`).join('\n') : ''}`], { site: s, stage: 'final' });
    }
    if (s.cert) add(`${s.id}-cert.pdf`, 'certificate-of-completion', [`CERTIFICATE OF COMPLETION\nPermit No: ${s.no}\nSite Address: ${s.addr}, ${s.city} AZ\nOwner: ${s.cust}\nDate Completed: ${long(addDays(iss, 75))}`], { site: s });
    add(`${s.id}-panel.pdf`, 'panel-schedule', [`PANEL SCHEDULE\nSite Address: ${s.addr}, ${s.city} AZ\nCustomer: ${s.cust}\nMain Breaker: ${s.amps}\nVoltage: ${s.volt}\nPhase: ${s.phase}\nCircuits: ${24 + i * 2}`], { site: s });
    if (s.load) add(`${s.id}-loadcalc.pdf`, 'load-calculation', [`LOAD CALCULATION\nSite Address: ${s.addr}, ${s.city} AZ\nCustomer: ${s.cust}\nTotal Connected Load: ${s.load.conn}\nCalculated Demand Load: ${s.load.dem}\nService Size: ${s.amps}`], { site: s });
  });
  // credentials (relative to TODAY)
  const lic = { num: 'ROC-318244', holder: 'Desert Line Electric LLC', exp: addDays(TODAY, 31) };
  add('license-2025.pdf', 'contractor-license', [`CONTRACTOR LICENSE\nLicense No: ROC-318244\nLicensee: Desert Line Electric LLC\nLicense Expires: ${long(addDays(TODAY, -334))}`], { cred: 'license', key: 'ROC-318244', exp: addDays(TODAY, -334) });
  add('license-2026.pdf', 'contractor-license', [`CONTRACTOR LICENSE\nLicense No: ROC-318244\nLicensee: Desert Line Electric LLC\nLicense Expires: ${long(lic.exp)}`], { cred: 'license', key: 'ROC-318244', exp: lic.exp, newest: true });
  const coi = [
    { n: 'GL-4410-2291', ins: 'Summit Mutual Insurance', exp: addDays(TODAY, -12), what: 'general liability' },
    { n: 'WC-7712-0035', ins: 'Ironwood Casualty', exp: addDays(TODAY, 44), what: 'workers comp' },
    { n: 'GL-5520-1180', ins: 'Summit Mutual Insurance', exp: addDays(TODAY, 210), what: 'umbrella' },
  ];
  coi.forEach((c, i) => add(`coi-${i + 1}.pdf`, 'certificate-of-insurance', [`CERTIFICATE OF LIABILITY INSURANCE\nInsurer: ${c.ins}\nPolicy No: ${c.n}\nPolicy Expires: ${fmts[i % 3](c.exp)}`], { cred: 'coi', key: c.n, exp: c.exp, newest: true }));
  const bond = { n: 'SB-90311', exp: addDays(TODAY, 58) };
  add('bond-2026.pdf', 'surety-bond', [`CONTRACTOR LICENSE BOND\nBond No: ${bond.n}\nBond Expires: ${long(bond.exp)}`], { cred: 'bond', key: bond.n, exp: bond.exp, newest: true });
  const tests = [
    { eq: 'Generator', addr: '5530 Warehouse Way', due: addDays(TODAY, 20), title: 'GENERATOR LOAD TEST REPORT', n: 1 },
    { eq: 'Transfer Switch', addr: '88 Harmon Street', due: addDays(TODAY, -5), title: 'TRANSFER SWITCH TEST REPORT', n: 2 },
    { eq: 'Thermography', addr: '3300 Granite Parkway', due: addDays(TODAY, 300), title: 'THERMOGRAPHY TEST REPORT', n: 3 },
  ];
  tests.forEach((t) => add(`test-${t.n}.pdf`, 'test-report', [`${t.title}\nSite Address: ${t.addr}\nDate Tested: ${long(addDays(t.due, -365))}\nNext Test Due: ${long(t.due)}`], { test: t }));
  // filler paperwork the lane must ignore
  for (let k = 1; k <= 3; k++) add(`invoice-${k}.pdf`, 'invoice', [`INVOICE\nInvoice No: INV-${1000 + k}\nCustomer: ${SITES[k].cust}\nSite Address: ${SITES[k].addr}, ${SITES[k].city} AZ\nTotal: $${k * 420}.00`], {});
  return { docs, lic, coi, bond, tests };
}

const closed = (s) => s.cert || s.final === 'Passed' || s.final === 'Approved';
export function truth() {
  const B = buildDocs();
  const open = SITES.filter((s) => !closed(s));
  const failedInsp = [];
  for (const s of SITES) { if (/fail|correction/i.test(s.rough ?? '')) failedInsp.push({ s, stage: 'Rough-in' }); if (/fail/i.test(s.final ?? '')) failedInsp.push({ s, stage: 'Final' }); }
  const creds = [
    ...B.coi.map((c) => ({ label: c.n, exp: c.exp, kind: 'coi' })),
    { label: B.bond.n, exp: B.bond.exp, kind: 'bond' },
    { label: B.lic.num, exp: B.lic.exp, kind: 'license' },
  ];
  return { B, open, failedInsp, creds, closed };
}
