/**
 * Property-management fixture set (Build 2, stage 2D part A): a seeded, deterministic paper trail for ONE property
 * management company ("Desert Ridge Property Management LLC", Arizona), rendered as page text, plus a TRUTH spec per
 * document written from the generator's raw SPECS only (never from the extractor, the lane or any model).
 *
 * PUBLIC API
 *   TODAY                  fixed 'today' (YYYY-MM-DD) for every expiry / due / overdue question
 *   buildDocs()            -> [{ id, filename, style, pages:[{page_no,text}], truth }]   (deterministic: same output every call)
 *   truth()                -> { docs, byType, cois, leases, contracts, ... derived answers, see the end of the file }
 *   long / us / addDays / money   small formatting helpers shared with the selfcheck
 *
 *   doc.truth = {
 *     type:     the document's real type id (pack document types) or a wrong-type id ('correspondence', 'other', 'internal',
 *               'purchase-order'). Wrong-type docs have wrongType:true and must read as NOTHING (null) from the extractor.
 *     fields:   { key: { value, page } }  what a perfect reader gets. value = ISO date (date keys) | number (money keys) |
 *               string | string[] (repeatable keys: work_performed, coverage_type, deficiency, policy_expiry, rent_roll_row)
 *     mustRead: true when the page is clean enough that the extractor MUST read it (type + every non-optional field)
 *     optional: keys the extractor may leave out (messy / unreadable); anything it DOES return must equal the truth
 *     note:     why this doc exists (near-duplicate, messy, wrong type, ...)
 *   }
 *
 * SEMANTIC DECISIONS (the contract between fixture author and engineers)
 *  D1  COI: coi_expires = the EARLIEST policy expiry printed (the date coverage first lapses). When a certificate lists
 *      policies with different expiries every one is also kept as policy_expiry. policy_number = the general liability
 *      policy (or the one policy printed). A vendor's CURRENT COI is the one with the latest coi_expires; older certificates
 *      for the same vendor are history and never count toward expired / expiring answers (see truth().cois).
 *  D2  EXPIRED: date < TODAY. EXPIRES TODAY: date == TODAY (not expired yet). EXPIRING WITHIN N DAYS: TODAY <= date <= TODAY+N.
 *  D3  Lease: lease_end_date < TODAY and status not month-to-month = expired. A month-to-month lease prints no end date.
 *  D4  Work order: service_date = the scheduled/service date when printed, otherwise the date opened; opened_date and
 *      completed_date are kept separately. status is exactly as printed.
 *  D5  Invoice: invoice_due is only ever a printed date (never computed from "Net 30"); cost = the printed TOTAL, never a
 *      subtotal or a balance line.
 *  D6  Rent roll: one rent_roll_row per printed unit row, "unit=4B; tenant=Jane Roe; lease_start=2026-01-01;
 *      lease_end=2026-12-31; rent=1450.00; deposit=1450.00; status=Occupied" (only the parts printed; a vacant unit has
 *      only unit, rent and status as printed).
 *  D7  Counts of documents by type count every document of that type on file, near-duplicates and history included.
 *      Wrong-type documents carry NO data fields and count only under the type they really are.
 *  D8  Dates are written in the answer long ("March 4, 2026"); pages show US, long, ISO or two-digit-year dates.
 *  D9  Coverage names are canonical: General Liability, Workers Compensation, Automobile Liability, Umbrella Liability
 *      (pages print CGL, WC, Business Auto, Excess Liability, ... and the truth is the canonical name).
 */
import { makeRng } from './rng.mjs';

export const TODAY = '2026-10-06';
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const long = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
export const us = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const us2 = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y.slice(2)}`; };
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${+d}-${MON[m - 1].slice(0, 3)}-${y}`; };
const fmtDate = (iso, k) => [us, long, (i) => i, us2, dmy][k](iso);
const D = (n) => addDays(TODAY, n);

export const COMPANY = 'Desert Ridge Property Management LLC';
export const PROPS = [
  { id: 'p1', name: 'Saguaro Ridge Apartments', addr: '1200 Mesa Drive', city: 'Mesa', owner: 'Saguaro Ridge Holdings LLC' },
  { id: 'p2', name: 'Palo Verde Villas', addr: '455 Palo Verde Lane', city: 'Tempe', owner: 'Bellweather Capital LLC' },
  { id: 'p3', name: 'Copper Canyon Townhomes', addr: '80 Copper Canyon Road', city: 'Chandler', owner: 'Marquez Family Trust' },
  { id: 'p4', name: 'Desert Willow Plaza', addr: '3100 Willow Boulevard', city: 'Gilbert', owner: 'Desert Willow Investors LP' },
];
export const prop = (id) => PROPS.find((p) => p.id === id);
export const VENDORS = {
  rios: 'Rios Plumbing LLC', sun: 'Sun Valley Landscaping Inc', apex: 'Apex Pest Control Services', summit: 'Summit Elevator Co',
  bright: 'Bright Path Janitorial LLC', cool: 'Coolwave HVAC Services LLC', iron: 'Ironclad Roofing Inc',
};
const INSURERS = ['Hartford Fire Insurance Company', 'Travelers Indemnity Company', 'Liberty Mutual Insurance', 'Nationwide Mutual Insurance Company'];
const COV_PRINT = {
  'General Liability': ['General Liability', 'Commercial General Liability', 'CGL'],
  'Workers Compensation': ['Workers Compensation', "Workers' Comp", 'WC'],
  'Automobile Liability': ['Automobile Liability', 'Business Auto', 'Commercial Auto'],
  'Umbrella Liability': ['Umbrella Liability', 'Umbrella', 'Excess Liability'],
};

/* ---------- RAW SPECS ---------- */
const pol = (cov, no, eff, exp, limit) => ({ cov, no, eff, exp, limit });
export const COIS = [
  { file: 'coi-rios-2026.pdf', vendor: VENDORS.rios, ins: 0, layout: 'vertical', wc: 'Statutory', policies: [pol('General Liability', 'GL-4471209', D(-345), D(20), 1000000), pol('Workers Compensation', 'WC-8812033', D(-345), D(20))] },
  { file: 'coi-sun-2026.pdf', vendor: VENDORS.sun, ins: 1, layout: 'table', policies: [pol('General Liability', 'CPP-993011', D(-200), D(165), 2000000), pol('Automobile Liability', 'BA-440192', D(-200), D(165)), pol('Workers Compensation', 'WC-220871', D(-120), D(245))] },
  { file: 'coi-apex-2025.pdf', vendor: VENDORS.apex, ins: 2, layout: 'vertical', policies: [pol('General Liability', 'GLP-6628101', D(-410), D(-45), 1000000)] },
  { file: 'coi-summit-2026.pdf', vendor: VENDORS.summit, ins: 3, layout: 'range', policies: [pol('General Liability', 'SE-770412', D(-360), D(5), 3000000), pol('Umbrella Liability', 'UMB-118820', D(-360), D(5))] },
  { file: 'coi-bright-2026.pdf', vendor: VENDORS.bright, ins: 0, layout: 'vertical', wc: 'Yes', policies: [pol('General Liability', 'BP-5530021', D(-165), D(200), 1000000), pol('Workers Compensation', 'WC-5530022', D(-165), D(200))] },
  { file: 'coi-cool-2026.pdf', vendor: VENDORS.cool, ins: 1, layout: 'table', pages: 2, policies: [pol('General Liability', 'CG-3319047', D(-30), D(335), 1000000), pol('Workers Compensation', 'WC-3319048', D(-30), D(400)), pol('Automobile Liability', 'AU-3319049', D(-30), D(335))] },
  { file: 'coi-rios-2025-old.pdf', vendor: VENDORS.rios, ins: 0, layout: 'vertical', wc: 'Statutory', policies: [pol('General Liability', 'GL-3380114', D(-710), D(-340), 1000000), pol('Workers Compensation', 'WC-7710021', D(-710), D(-340))], note: 'near-duplicate: the older certificate of the same vendor (history)' },
  { file: 'coi-iron-2025.pdf', vendor: VENDORS.iron, ins: 2, layout: 'range', policies: [pol('General Liability', 'IR-290144', D(-366), D(-1), 1000000)] },
  { file: 'coi-apex-2026.pdf', vendor: VENDORS.apex, ins: 2, layout: 'vertical', policies: [pol('General Liability', 'GLP-6629955', D(-1), D(0), 1000000)], note: 'expires today; also a near-duplicate renewal of the same vendor' },
  { file: 'coi-dmy-2digit.pdf', vendor: VENDORS.iron, ins: 3, external: true, policies: [pol(null, 'IR-300777', null, D(120), null)], note: 'renewal of the expired Ironclad certificate (built as its own date-format document below; prints no coverage types)' },
  { file: 'coi-noexp.pdf', vendor: VENDORS.bright, ins: 0, layout: 'noexp', policies: [pol('General Liability', 'BP-5530099', null, null, 1000000)], note: 'no expiry printed: unreadable, never guessed' },
];

const ls = (file, p, unit, tenant, start, end, rent, dep, o = {}) => ({ file, p, unit, tenant, start, end, rent, dep, ...o });
export const LEASES = [
  ls('lease-4b.pdf', 'p1', '4B', 'Jordan Ellis', D(-200), D(165), 1450, 1450),
  ls('lease-12c.pdf', 'p1', '12C', 'Priya Natarajan', D(-340), D(25), 1625, 1000, { layout: 'range' }),
  ls('lease-7a.pdf', 'p2', '7A', 'Marcus Delgado and Tessa Delgado', D(-400), D(-35), 1380, 1380, { note: 'expired lease' }),
  ls('lease-7a-renewal.pdf', 'p2', '7A', 'Marcus Delgado and Tessa Delgado', D(-34), D(331), 1420, 1380, { note: 'near-duplicate: renewal of the expired 7A lease' }),
  ls('lease-210.pdf', 'p4', '210', 'Cactus Corner Cafe LLC', D(-60), D(670), 3250, 6500, { layout: 'range', pages: 2 }),
  ls('lease-3.pdf', 'p3', '3', 'Rhonda Ashby', D(-300), D(-6), 1750, 1750, { unitInAddress: true }),
  ls('lease-9d.pdf', 'p1', '9D', 'Lamar Whitfield', D(-90), D(275), 1495, 750, { twoDigitYear: true }),
  ls('lease-mtm.pdf', 'p2', '2F', 'Imani Okoro', D(-700), null, 1310, 1310, { mtm: true, note: 'month to month: prints no end date' }),
];

const rrr = (unit, tenant, start, end, rent, dep, status) => ({ unit, tenant, start, end, rent, dep, status });
export const RENTROLLS = [
  { file: 'rentroll-saguaro.pdf', p: 'p1', layout: 'pipe', rows: [
    rrr('1A', 'Carla Mendes', D(-100), D(265), 1395, 1395, 'Occupied'), rrr('1B', 'Devon Price', D(-250), D(115), 1395, 1000, 'Occupied'), rrr('2A', null, null, null, 1450, null, 'Vacant'),
    rrr('2B', 'Hye-jin Park', D(-30), D(335), 1475, 1475, 'Occupied'), rrr('3A', 'Samuel Okafor', D(-310), D(55), 1425, 1425, 'Occupied'), rrr('3B', 'Elena Vasquez', D(-20), D(345), 1500, 1500, 'Occupied'),
    rrr('4A', null, null, null, 1450, null, 'Vacant'), rrr('4B', 'Jordan Ellis', D(-200), D(165), 1450, 1450, 'Occupied'),
  ], pages: 2 },
  { file: 'rentroll-palo-verde.pdf', p: 'p2', layout: 'aligned', rows: [
    rrr('2F', 'Imani Okoro', D(-700), null, 1310, 1310, 'Month-to-month'), rrr('7A', 'Marcus Delgado', D(-34), D(331), 1420, 1380, 'Occupied'), rrr('7B', 'Nia Thompson', D(-400), D(-35), 1380, 1380, 'Expired'),
    rrr('8A', null, null, null, 1425, null, 'Vacant'), rrr('8B', 'Greg Holloway', D(-120), D(245), 1440, 1440, 'Occupied'),
  ] },
  { file: 'rentroll-copper.pdf', p: 'p3', layout: 'pipe', rows: [
    rrr('1', 'Adaeze Nwosu', D(-60), D(305), 1690, 1690, 'Occupied'), rrr('2', null, null, null, 1725, null, 'Vacant'), rrr('3', 'Rhonda Ashby', D(-300), D(-6), 1750, 1750, 'Occupied'),
  ], messy: true },
];

const ins = (file, kind, p, unit, tenant, date, o = {}) => ({ file, kind, p, unit, tenant, date, ...o });
export const INSPECTIONS = [
  ins('movein-4b.pdf', 'move-in', 'p1', '4B', 'Jordan Ellis', D(-200), { result: 'Satisfactory', def: ['Scuff on hallway wall', 'Bedroom blind slat bent'] }),
  ins('movein-9d.pdf', 'move-in', 'p1', '9D', 'Lamar Whitfield', D(-90), { result: 'Satisfactory', def: [] }),
  ins('moveout-7b.pdf', 'move-out', 'p2', '7B', 'Nia Thompson', D(-33), { result: 'Needs repairs', def: ['Carpet stain in living room', 'Broken closet door track', 'Missing smoke detector cover'] }),
  ins('moveout-3b.pdf', 'move-out', 'p3', '3B', 'Quentin Boyd', D(-12), { result: 'Satisfactory', def: [] }),
  { file: 'insp-annual-unit-12c.pdf', kind: 'annual', p: 'p1', unit: '12C', date: D(-75), result: 'Passed', def: [] },
  { file: 'insp-fire-saguaro.pdf', kind: 'fire', p: 'p1', date: D(-20), result: 'Failed', def: ['Fire extinguisher tag expired in stairwell B', 'Emergency light out on third floor'], reinspect: D(10), pages: 2 },
  { file: 'insp-fire-willow.pdf', kind: 'fire', p: 'p4', date: D(-200), result: 'Passed with deficiencies', def: ['Exit sign dim at north door'], reinspect: D(-150) },
  { file: 'insp-annual-copper.pdf', kind: 'annual', p: 'p3', unit: '3', date: D(-9), result: 'Failed', def: ['GFCI outlet in bathroom does not trip'], reinspect: D(21) },
];

const wo = (file, p, unit, no, opened, status, priority, work, o = {}) => ({ file, p, unit, no, opened, status, priority, work, ...o });
export const WORKORDERS = [
  wo('wo-4b-leak.pdf', 'p1', '4B', 'WO-20418', D(-14), 'Completed', 'Urgent', ['Repair leaking kitchen faucet', 'Replace supply line'], { completed: D(-12), vendor: VENDORS.rios, cost: 285.5, notes: 'Resident reports water under sink' }),
  wo('wo-7a-hvac.pdf', 'p2', '7A', 'WO-20431', D(-5), 'In Progress', 'High', ['Diagnose AC not cooling'], { sched: D(2), vendor: VENDORS.cool }),
  wo('wo-12c-turn.pdf', 'p1', '12C', 'WO-20377', D(-40), 'Completed', 'Routine', ['Paint unit', 'Deep clean', 'Replace carpet in bedroom'], { completed: D(-30), vendor: VENDORS.bright, cost: 1840, kind: 'make-ready' }),
  wo('wo-210-door.pdf', 'p4', '210', 'WO-20440', D(-1), 'Open', 'Low', ['Adjust suite entry door closer'], {}),
  wo('wo-roof.pdf', 'p3', null, 'WO-20399', D(-25), 'On Hold', 'High', ['Patch roof leak above building 2'], { vendor: VENDORS.iron, notes: 'Waiting on owner approval', pages: 2 }),
  wo('wo-9d-pest.pdf', 'p1', '9D', 'WO-20445', D(0), 'Scheduled', 'Normal', ['Treat for ants in kitchen'], { sched: D(4), vendor: VENDORS.apex }),
  wo('wo-4b-leak-v2.pdf', 'p1', '4B', 'WO-20418', D(-14), 'Closed', 'Urgent', ['Repair leaking kitchen faucet', 'Replace supply line'], { completed: D(-12), vendor: VENDORS.rios, cost: 285.5, note: 'near-duplicate: the same work order printed again with status Closed' }),
  wo('wo-3-lock.pdf', 'p3', '3', 'WO-20450', D(-3), 'Completed', 'Emergency', ['Rekey front door lock'], { completed: D(-3), cost: 95 }),
];

const iv = (file, vendor, no, date, due, p, unit, total, status, work, o = {}) => ({ file, vendor, no, date, due, p, unit, total, status, work, ...o });
export const INVOICES = [
  iv('inv-rios-5001.pdf', VENDORS.rios, 'INV-5001', D(-12), D(18), 'p1', '4B', 285.5, 'Unpaid', ['Repair leaking kitchen faucet', 'Replace supply line'], { wo: 'WO-20418', sub: true }),
  iv('inv-sun-0912.pdf', VENDORS.sun, 'SV-0912', D(-45), D(-15), 'p2', null, 1200, 'Overdue', ['Monthly landscape maintenance - September']),
  iv('inv-bright-3320.pdf', VENDORS.bright, 'BP-3320', D(-35), D(-5), 'p1', '12C', 1840, 'Paid', ['Paint unit', 'Deep clean', 'Replace carpet in bedroom'], { wo: 'WO-20377' }),
  iv('inv-apex-771.pdf', VENDORS.apex, '771', D(-3), D(27), 'p4', null, 425, 'Unpaid', ['Quarterly pest treatment, all suites'], { pages: 2 }),
  iv('inv-cool-8802.pdf', VENDORS.cool, 'CW-8802', D(-8), D(22), 'p2', '7A', 612.75, 'Open', ['Replace capacitor', 'Recharge refrigerant'], { wo: 'WO-20431', sub: true }),
  iv('inv-rios-5001-copy.pdf', VENDORS.rios, 'INV-5001', D(-12), D(18), 'p1', '4B', 285.5, 'Unpaid', ['Repair leaking kitchen faucet', 'Replace supply line'], { wo: 'WO-20418', sub: true, note: 'near-duplicate: resent copy of the same invoice' }),
  iv('inv-rios-5002.pdf', VENDORS.rios, 'INV-5002', D(-12), D(18), 'p3', '3', 95, 'Paid', ['Rekey front door lock'], { note: 'near-duplicate look: same vendor and dates, different invoice' }),
  iv('inv-iron-221.pdf', VENDORS.iron, 'IR-221', D(-20), null, 'p3', null, 2750, 'Unpaid', ['Roof leak patch, building 2'], { noDue: true, note: 'no due date printed' }),
];

const ct = (file, vendor, scope, start, end, auto, monthly, o = {}) => ({ file, vendor, scope, start, end, auto, monthly, ...o });
export const CONTRACTS = [
  ct('contract-sun.pdf', VENDORS.sun, 'Weekly landscape maintenance of common areas', D(-300), D(65), 'yes', 1200, { p: 'p2' }),
  ct('contract-apex.pdf', VENDORS.apex, 'Quarterly pest control for all suites', D(-400), D(-35), 'no', 425, { layout: 'range', p: 'p4', note: 'ended contract' }),
  ct('contract-summit.pdf', VENDORS.summit, 'Monthly elevator inspection and maintenance', D(-30), D(335), 'yes', 780, { sentence: true, p: 'p1', pages: 2 }),
  ct('contract-bright.pdf', VENDORS.bright, 'Weekly janitorial service for common areas and lobby', D(-120), D(245), 'no', 950, { sentence: true, p: 'p4' }),
  ct('contract-cool.pdf', VENDORS.cool, 'Semi-annual HVAC preventive maintenance', D(-10), D(355), null, 640, { p: 'p3' }),
];

/* ---------- RENDERING ---------- */
const NOISE = ['Scanned by CamScanner', 'Pg 1/1  ~~ 300dpi ~~', 'Doc ID 44-71B', 'FAX RECEIVED 10/04 08:12', 'Page scanned - skew corrected', 'Printed from field tablet'];
const L = {
  prop: ['Property', 'Property Address', 'Premises'], pname: ['Community', 'Property Name', 'Community Name'], unit: ['Unit', 'Unit No', 'Apt #'], owner: ['Owner', 'Landlord', 'Landlord/Owner'],
  tenant: ['Tenant', 'Resident', 'Lessee'], vendor: ['Vendor', 'Contractor', 'Vendor Name'], insured: ['Insured', 'Named Insured', 'Insured'], insurer: ['Insurer', 'Insurance Company', 'Carrier'],
  policy: ['Policy Number', 'Policy No', 'Policy #'], exp: ['Policy Expiration', 'Expiration Date', 'Policy Expires'], limit: ['Each Occurrence', 'General Liability Limit', 'GL Limit'],
  wc: ['Workers Compensation', "Workers' Comp", 'Workers Comp'], cov: ['Coverage', 'Coverage Types', 'Coverages'], period: ['Policy Period', 'Coverage Period', 'Policy Term'],
};
/** Render one document. fn({style,idx,d,addr}) -> {titles:[3], rows:[{key,labels,v,date?,money?,truth?,page?,keep?}], raw?:[{t,page}], extra?:[{t,page}], truthExtra?:{key:{value,page}}} */
function mkDoc(R, docs, filename, type, idx, fn, spec = {}) {
  const style = idx % 3;
  const dk = spec.dateFmt ?? (idx + style) % 4;
  const ctx = { style, idx, d: (iso) => fmtDate(iso, spec.twoDigitYear ? 3 : dk), addr: (p, withCity) => (withCity ?? style !== 2 ? `${p.addr}, ${p.city} AZ` : p.addr) };
  const { titles, rows: rr, raw = [], extra = [], truthExtra = {} } = fn(ctx);
  let rows = rr.slice();
  if (style > 0) { const head = rows.filter((r) => r.keep); const rest = rows.filter((r) => !r.keep); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } rows = [...head, ...rest]; }
  const sep = style === 0 ? ': ' : style === 1 ? ' : ' : ':  ';
  const maxPage = Math.max(1, ...rows.map((r) => r.page ?? 1), ...raw.map((r) => r.page ?? 1));
  const ocrIdx = style === 2 && R() < 0.5 ? Math.floor(R() * rows.length) : -1;
  const fields = { ...truthExtra }; const pages = [];
  for (let p = 1; p <= maxPage; p++) {
    const lines = [];
    const t = titles[style]; lines.push(style === 2 ? t[0] + t.slice(1).toLowerCase() : t);
    if (maxPage > 1) lines.push(p === 1 ? `Page 1 of ${maxPage}` : `Page ${p} of ${maxPage} (continued)`);
    rows.forEach((r, ri) => {
      if ((r.page ?? 1) !== p) return;
      let lab = r.labels[style]; if (ri === ocrIdx && /[lO]/.test(lab.slice(1))) lab = lab[0] + lab.slice(1).replace('l', '1').replace('O', '0');
      if (Array.isArray(r.v)) { lines.push(`${lab}${sep.trim()}`); r.v.forEach((x, k) => lines.push(style === 1 ? `- ${x}` : `${k + 1}. ${x}`)); }
      else lines.push(`${lab}${sep}${r.date ? ctx.d(r.v) : r.money ? money(r.v) : r.v}`);
      if (r.key) fields[r.key] = { value: r.truth ?? r.v, page: p };
      if (r.also) for (const [k, v] of Object.entries(r.also)) fields[k] = { value: v, page: p };
    });
    raw.filter((e) => (e.page ?? 1) === p).forEach((e) => lines.push(typeof e.t === 'function' ? e.t(ctx) : e.t));
    extra.filter((e) => (e.page ?? 1) === p).forEach((e) => lines.push(e.t));
    if (style > 0) lines.push(NOISE[Math.floor(R() * NOISE.length)]);
    pages.push({ page_no: p, text: lines.join('\n') });
  }
  docs.push({ id: filename.replace(/\.pdf$/, ''), filename, style, pages, truth: { type, fields, mustRead: !!spec.mustRead, optional: spec.optional ?? [], partial: spec.partial ?? [], wrongType: !!spec.wrongType, mustBeNull: !!spec.mustBeNull, note: spec.note ?? null } });
}
const row = (key, labels, v, o = {}) => ({ key, labels, v, ...o });
const same = (s) => [s, s, s];
const propRows = (p, unit, ctx) => {
  // style 0: address and community on separate labelled lines; style 1: one "Property Address: Name, address" line (the reader splits it);
  // style 2: address without a city plus a community line
  const rows = ctx.style === 1
    ? [row('service_address', L.prop, `${p.name}, ${ctx.addr(p, true)}`, { truth: ctx.addr(p, true), also: { property_name: p.name }, keep: true })]
    : [row('service_address', L.prop, ctx.addr(p, ctx.style === 0), { keep: true }), row('property_name', L.pname, p.name)];
  if (unit) rows.push(row('unit_number', L.unit, unit));
  return rows;
};

const mustRead = { mustRead: true };

export function buildDocs() {
  const R = makeRng(20261006);
  const docs = []; let idx = 0;
  const add = (filename, type, fn, spec) => { mkDoc(R, docs, filename, type, idx++, fn, spec); };

  // ---- certificates of insurance
  for (const c of COIS) {
    if (c.external) continue;
    add(c.file, 'certificate-of-insurance', (ctx) => {
      const ex = c.policies.map((p) => p.exp).filter(Boolean);
      const first = ex.length ? ex.reduce((a, b) => (a < b ? a : b)) : null;
      const gl = c.policies.find((p) => p.cov === 'General Liability');
      const cp = c.pages ?? 1;
      const pn = (cov) => COV_PRINT[cov][ctx.idx % 3];
      const rows = [row('vendor', L.insured, c.vendor, { keep: true, page: 1 }), row('insurer', L.insurer, INSURERS[c.ins], { page: 1 })];
      const raw = []; const truthExtra = {};
      const covs = c.policies.map((p) => p.cov);
      if (c.layout === 'noexp') {
        rows.push(row('policy_number', L.policy, gl.no, { page: 1 }), row('gl_limit', L.limit, gl.limit, { money: true, page: 1 }), row('coverage_type', L.cov, covs.map((x) => pn(x)).join(', '), { truth: covs, page: 1 }));
      } else if (c.layout === 'vertical') {
        rows.push(row('policy_number', L.policy, gl.no, { page: 1 }), row('coi_expires', L.exp, first, { date: true, page: 1 }), row('gl_limit', L.limit, gl.limit, { money: true, page: 1 }), row('coverage_type', L.cov, covs.map((x) => pn(x)).join(', '), { truth: covs, page: 1 }));
        if (c.wc) rows.push(row('workers_comp', L.wc, c.wc, { page: 1 }));
        raw.push({ t: 'Certificate Holder: Desert Ridge Property Management LLC', page: 1 });
      } else if (c.layout === 'range') {
        const g = gl;
        rows.push(row('policy_number', L.policy, g.no, { page: 1 }), row('coi_expires', L.period, g.exp, { page: 1, truth: g.exp, rangeFrom: g.eff, date: false, v: `${ctx.d(g.eff)} to ${ctx.d(g.exp)}` }), row('gl_limit', L.limit, g.limit, { money: true, page: 1 }), row('coverage_type', L.cov, covs.map((x) => pn(x)).join('; '), { truth: covs, page: 1 }));
        raw.push({ t: 'Certificate Holder: Desert Ridge Property Management LLC', page: 1 });
      } else {
        for (const p of c.policies) raw.push({ page: p.cov === 'Workers Compensation' && cp > 1 ? 2 : 1, t: (cx) => `${pn(p.cov)} | Policy No: ${p.no} | Eff: ${cx.d(p.eff)} | Exp: ${cx.d(p.exp)}${p.limit ? ` | Each Occurrence: ${money(p.limit)}` : ''}` });
        truthExtra.policy_number = { value: gl.no, page: 1 }; truthExtra.coverage_type = { value: covs, page: 1 };
        truthExtra.gl_limit = { value: gl.limit, page: 1 };
        truthExtra.coi_expires = { value: first, page: 1 };
        if (new Set(ex).size > 1) truthExtra.policy_expiry = { value: [...new Set(ex)], page: 1 };
        const tr = c.policies.map((p) => p.cov === 'Workers Compensation' && cp > 1 ? 2 : 1);
        if (cp > 1) { truthExtra.coi_expires.page = Math.min(...tr); }
      }
      if (c.layout === 'vertical' || c.layout === 'range') { const exs = [...new Set(ex)]; if (exs.length > 1) truthExtra.policy_expiry = { value: exs, page: 1 }; }
      if (c.layout === 'range' && c.policies.length > 1) { truthExtra.policy_expiry = { value: [...new Set(ex)], page: 1 }; if (new Set(ex).size === 1) delete truthExtra.policy_expiry; }
      return { titles: ['CERTIFICATE OF LIABILITY INSURANCE', 'CERTIFICATE OF INSURANCE', 'Certificate of Liability Insurance (ACORD 25)'], rows, raw, truthExtra, extra: cp > 1 ? [{ t: 'Authorized Representative: Diane Foster', page: 2 }] : [] };
    }, { mustRead: c.layout !== 'noexp', note: c.note, optional: c.layout === 'noexp' ? ['policy_number', 'gl_limit', 'coverage_type', 'insurer', 'vendor'] : [], ...(c.layout === 'noexp' ? {} : {}) });
  }

  // ---- leases
  for (const l of LEASES) {
    const p = prop(l.p);
    add(l.file, 'lease-agreement', (ctx) => {
      const rows = [row('customer_name', L.owner, p.owner, { page: 1 }), row('tenant_name', L.tenant, l.tenant, { page: 1 })];
      if (l.unitInAddress) { rows.push(row('service_address', L.prop, `${p.addr}, Unit ${l.unit}, ${p.city} AZ`, { truth: `${p.addr}, ${p.city} AZ`, keep: true, page: 1 }), row('unit_number', ['x', 'x', 'x'], l.unit, { noPrint: true })); }
      else rows.push(...propRows(p, l.unit, ctx).map((r) => ({ ...r, page: 1 })));
      const pg = l.pages ?? 1;
      if (l.layout === 'range') rows.push({ key: null, labels: ['Lease Term', 'Lease Term', 'Term'], v: `${ctx.d(l.start)} to ${ctx.d(l.end)}`, page: 1 });
      else { rows.push(row('lease_start_date', ['Lease Start', 'Lease Start Date', 'Commencement Date'], l.start, { date: true, page: 1 })); if (l.end) rows.push(row('lease_end_date', ['Lease End', 'Lease End Date', 'Expiration Date'], l.end, { date: true, page: 1 })); }
      rows.push(row('rent_amount', ['Monthly Rent', 'Rent', 'Monthly Rent Amount'], l.rent, { money: true, page: pg }), row('security_deposit', ['Security Deposit', 'Deposit', 'Security Deposit Amount'], l.dep, { money: true, page: pg }));
      if (l.mtm) rows.push(row('status', ['Lease Status', 'Status', 'Tenancy Status'], 'Month-to-month', { page: 1 }));
      const f = {};
      if (l.layout === 'range') { f.lease_start_date = { value: l.start, page: 1 }; f.lease_end_date = { value: l.end, page: 1 }; }
      if (l.unitInAddress) f.unit_number = { value: l.unit, page: 1 };
      return { titles: ['RESIDENTIAL LEASE AGREEMENT', 'APARTMENT LEASE AGREEMENT', 'Residential Lease'], rows: rows.filter((r) => !r.noPrint), truthExtra: f, extra: pg > 1 ? [{ t: 'Tenant and Landlord acknowledge receipt of the house rules.', page: 2 }] : [] };
    }, { mustRead: true, note: l.note, twoDigitYear: l.twoDigitYear });
  }
  // ---- rent rolls
  for (const r of RENTROLLS) {
    const p = prop(r.p);
    const fmtRow = (x, d) => ['unit=' + x.unit, x.tenant && `tenant=${x.tenant}`, x.start && `lease_start=${x.start}`, x.end && `lease_end=${x.end}`, x.rent != null && `rent=${x.rent.toFixed(2)}`, (r.layout === 'pipe' && x.dep != null) && `deposit=${x.dep.toFixed(2)}`, x.status && `status=${x.status}`].filter(Boolean).join('; ');
    add(r.file, 'rent-roll', (ctx) => {
      const header = r.layout === 'pipe' ? 'Unit | Tenant | Lease Start | Lease End | Rent | Deposit | Status' : 'Unit   Tenant   Lease Start   Lease End   Rent   Status';
      const line = (x) => (r.layout === 'pipe'
        ? [x.unit, x.tenant ?? 'VACANT', x.start ? ctx.d(x.start) : '', x.end ? ctx.d(x.end) : '', money(x.rent), x.dep != null ? money(x.dep) : '', x.status].join(' | ')
        : [x.unit.padEnd(6), (x.tenant ?? 'VACANT').padEnd(18), (x.start ? ctx.d(x.start) : '').padEnd(12), (x.end ? ctx.d(x.end) : '').padEnd(12), money(x.rent).padEnd(10), x.status].join('  '));
      const half = r.pages === 2 ? Math.ceil(r.rows.length / 2) : r.rows.length;
      const raw = [{ t: header, page: 1 }, ...r.rows.slice(0, half).map((x) => ({ t: line(x), page: 1 }))];
      if (r.pages === 2) raw.push({ t: header, page: 2 }, ...r.rows.slice(half).map((x) => ({ t: line(x), page: 2 })), { t: `Total units: ${r.rows.length}`, page: 2 });
      const rowsT = r.rows.map((x, i) => ({ x, page: r.pages === 2 && i >= half ? 2 : 1 }));
      // the pipe layout leaves empty cells ("| |"), so the extractor must keep the row aligned
      return { titles: ['RENT ROLL', 'UNIT LIST / RENT ROLL', 'Rent Roll'], rows: [row('property_name', L.pname, p.name, { keep: true, page: 1 }), row('customer_name', L.owner, p.owner, { page: 1 })], raw, truthExtra: { rent_roll_row: { value: rowsT.map(({ x }) => fmtRow(x)), page: 1, pages: rowsT.map((o) => o.page) } } };
    }, { mustRead: true, note: r.messy ? 'messy' : null, partial: r.layout === 'aligned' ? ['rent_roll_row'] : [] });
  }
  // ---- inspections
  for (const n of INSPECTIONS) {
    const p = prop(n.p);
    const titles = { 'move-in': ['MOVE-IN INSPECTION REPORT', 'MOVE-IN CONDITION CHECKLIST', 'Move-In Inspection'], 'move-out': ['MOVE-OUT INSPECTION REPORT', 'MOVE-OUT CONDITION CHECKLIST', 'Move-Out Inspection'], annual: ['ANNUAL UNIT INSPECTION REPORT', 'ANNUAL INSPECTION REPORT', 'Annual Unit Inspection'], fire: ['FIRE SAFETY INSPECTION REPORT', 'FIRE-SAFETY INSPECTION', 'Fire Safety Inspection Report'] }[n.kind];
    const type = n.kind === 'move-in' ? 'move-in-inspection' : n.kind === 'move-out' ? 'move-out-inspection' : 'inspection-report';
    add(n.file, type, (ctx) => {
      const pg = n.pages ?? 1;
      const rows = [...propRows(p, n.unit, ctx).map((r) => ({ ...r, page: 1 }))];
      if (n.tenant) rows.push(row('tenant_name', L.tenant, n.tenant, { page: 1 }));
      rows.push(row('service_date', ['Inspection Date', 'Date of Inspection', 'Inspected On'], n.date, { date: true, page: 1 }));
      if (type === 'inspection-report') rows.push(row('inspection_type', ['Inspection Type', 'Type of Inspection', 'Inspection'], n.kind === 'annual' ? 'Annual' : 'Fire safety', { page: 1 }));
      rows.push(row('inspection_result', ['Result', 'Overall Result', 'Outcome'], n.result, { page: 1 }));
      if (n.def.length) rows.push(row('deficiency', n.kind === 'move-out' ? ['Damages Noted', 'Damages', 'Damages Noted'] : ['Deficiencies', 'Deficiencies Found', 'Violations'], n.def, { page: pg }));
      if (n.reinspect) rows.push(row('reinspection_due', ['Reinspection Due', 'Reinspect By', 'Reinspection Date'], n.reinspect, { date: true, page: pg }));
      return { titles, rows, extra: pg > 1 ? [{ t: 'Inspector signature on file.', page: 2 }] : [] };
    }, { mustRead: true });
  }
  // ---- work orders
  for (const w of WORKORDERS) {
    const p = prop(w.p);
    add(w.file, 'work-order', (ctx) => {
      const pg = w.pages ?? 1;
      const rows = [row('work_order_number', ['Work Order #', 'WO No', 'Maintenance Request #'], w.no, { keep: true, page: 1 }), ...propRows(p, w.unit, ctx).map((r) => ({ ...r, page: 1 })),
        row('opened_date', ['Date Opened', 'Opened', 'Date Submitted'], w.opened, { date: true, page: 1 }), row('priority', ['Priority', 'Urgency', 'Priority Level'], w.priority, { page: 1 }), row('status', ['Status', 'Work Order Status', 'Current Status'], w.status, { page: 1 }),
        row('work_performed', ['Work Requested', 'Description of Work', 'Scope of Work'], w.work, { page: 1 })];
      if (w.sched) rows.push(row('service_date', ['Scheduled Date', 'Scheduled For', 'Scheduled'], w.sched, { date: true, page: 1 }));
      else rows.push({ key: 'service_date', labels: same(null), v: w.opened, noPrint: true, page: 1 });
      if (w.vendor) rows.push(row('vendor', ['Assigned Vendor', 'Vendor', 'Contractor'], w.vendor, { page: 1 }));
      if (w.completed) rows.push(row('completed_date', ['Date Completed', 'Completed On', 'Completion Date'], w.completed, { date: true, page: pg }));
      if (w.cost != null) rows.push(row('cost', ['Total Cost', 'Actual Cost', 'Total'], w.cost, { money: true, page: pg }));
      if (w.notes) rows.push(row('notes', ['Resident Notes', 'Notes', 'Comments'], w.notes, { page: pg }));
      const f = {}; const pr = rows.filter((r) => !r.noPrint);
      if (!w.sched) f.service_date = { value: w.opened, page: 1 };
      return { titles: w.kind === 'make-ready' ? ['MAKE-READY WORK ORDER', 'WORK ORDER - MAKE READY', 'Make-Ready Work Order'] : ['MAINTENANCE WORK ORDER', 'MAINTENANCE REQUEST', 'Work Order'], rows: pr, truthExtra: f, extra: pg > 1 ? [{ t: 'Vendor signature: ____________', page: 2 }] : [] };
    }, { mustRead: true, note: w.note, optional: [] });
  }
  // ---- invoices
  for (const v of INVOICES) {
    const p = prop(v.p);
    add(v.file, 'invoice', (ctx) => {
      const pg = v.pages ?? 1;
      const rows = [row('invoice_number', ['Invoice No', 'Invoice #', 'Inv No.'], v.no, { keep: true, page: 1 }), row('vendor', ['Vendor', 'Invoice From', 'Remit To'], v.vendor, { page: 1 }), row('invoice_date', ['Invoice Date', 'Date Billed', 'Date Invoiced'], v.date, { date: true, page: 1 }),
        ...propRows(p, v.unit, ctx).map((r) => ({ ...r, page: 1 })), row('work_performed', ['Description', 'Services', 'Description of Work'], v.work, { page: 1 }), row('cost', ['Total', 'Invoice Total', 'Total Due'], v.total, { money: true, page: pg }), row('status', ['Status', 'Payment Status', 'Paid Status'], v.status, { page: pg })];
      if (!v.noDue) rows.push(row('invoice_due', ['Due Date', 'Payment Due', 'Date Due'], v.due, { date: true, page: 1 }));
      if (v.wo) rows.push(row('work_order_number', ['Work Order', 'WO #', 'Work Order No'], v.wo, { page: 1 }));
      const raw = [{ t: 'Terms: Net 30', page: 1 }];
      if (v.sub) raw.push({ t: `Subtotal: ${money(v.total - 12)}`, page: pg }, { t: 'Tax: $12.00', page: pg });
      return { titles: ['INVOICE', 'INVOICE', 'Invoice'], rows, raw, extra: [{ t: v.vendor, page: 1 }] };
    }, { mustRead: true, note: v.note });
  }
  // ---- vendor contracts
  for (const c of CONTRACTS) {
    const p = prop(c.p);
    add(c.file, 'vendor-contract', (ctx) => {
      const pg = c.pages ?? 1;
      const rows = [row('vendor', L.vendor, c.vendor, { keep: true, page: 1 }), row('contract_scope', ['Scope of Services', 'Services', 'Scope'], c.scope, { page: 1 }), row('service_address', L.prop, ctx.addr(p, ctx.style !== 2), { page: 1 })];
      if (c.layout === 'range') rows.push({ key: null, labels: ['Contract Term', 'Term', 'Term'], v: `${ctx.d(c.start)} to ${ctx.d(c.end)}`, page: 1 });
      else rows.push(row('contract_start', ['Contract Start', 'Effective Date', 'Start Date'], c.start, { date: true, page: 1 }), row('contract_end', ['Contract End', 'Expiration Date', 'End Date'], c.end, { date: true, page: 1 }));
      rows.push(row('monthly_amount', ['Monthly Fee', 'Monthly Amount', 'Monthly Service Fee'], c.monthly, { money: true, page: 1 }));
      const f = {}; const raw = [];
      if (c.layout === 'range') { f.contract_start = { value: c.start, page: 1 }; f.contract_end = { value: c.end, page: 1 }; }
      if (c.auto != null) {
        if (c.sentence) { raw.push({ t: c.auto === 'yes' ? 'This Agreement automatically renews for successive 12 month terms unless either party gives 60 days written notice.' : 'This Agreement does not automatically renew and ends on the date above.', page: pg }); f.auto_renew = { value: c.auto, page: pg }; }
        else rows.push(row('auto_renew', ['Auto-Renew', 'Automatic Renewal', 'Renewal'], c.auto === 'yes' ? 'Yes' : 'No', { truth: c.auto, page: pg }));
      }
      return { titles: ['VENDOR SERVICE AGREEMENT', 'SERVICE CONTRACT', 'Vendor Contract'], rows, raw, truthExtra: f };
    }, { mustRead: true, note: c.note });
  }

  // ---- adversarial near-misses: the page prints something unsafe or unclear, so the reader must drop it (or read nothing)
  const p1 = prop('p1'); const p2 = prop('p2'); const p3 = prop('p3'); const p4 = prop('p4');
  add('lease-bad-dates.pdf', 'lease-agreement', (ctx) => ({ titles: ['RESIDENTIAL LEASE AGREEMENT', 'APARTMENT LEASE AGREEMENT', 'Residential Lease'], rows: [row('customer_name', L.owner, p1.owner), row('tenant_name', L.tenant, 'Wanda Pruitt'), ...propRows(p1, '5A', ctx), row(null, ['Lease Start', 'Lease Start Date', 'Commencement Date'], D(100), { date: true }), row(null, ['Lease End', 'Lease End Date', 'Expiration Date'], D(-265), { date: true }), row('rent_amount', ['Monthly Rent', 'Rent', 'Monthly Rent Amount'], 1400, { money: true })] }), { optional: ['customer_name', 'tenant_name', 'service_address', 'property_name', 'unit_number', 'rent_amount'], note: 'lease end printed before lease start: both dates dropped, never guessed' });
  add('lease-rent-conflict.pdf', 'lease-agreement', (ctx) => ({ titles: ['RESIDENTIAL LEASE AGREEMENT', 'APARTMENT LEASE AGREEMENT', 'Residential Lease'], rows: [row('customer_name', L.owner, p2.owner), row('tenant_name', L.tenant, 'Odell Brooks'), ...propRows(p2, '5D', ctx), row('lease_start_date', ['Lease Start', 'Lease Start Date', 'Commencement Date'], D(-30), { date: true }), row('lease_end_date', ['Lease End', 'Lease End Date', 'Expiration Date'], D(335), { date: true }), row(null, ['Monthly Rent', 'Rent', 'Monthly Rent'], 1500, { money: true }), row(null, ['Base Rent', 'Base Rent', 'Base Rent'], 1450, { money: true }), row('security_deposit', ['Security Deposit', 'Deposit', 'Security Deposit Amount'], 1450, { money: true })] }), { mustRead: true, note: 'two different rent amounts printed: rent_amount is left out' });
  add('coi-no-year.pdf', 'certificate-of-insurance', () => ({ titles: ['CERTIFICATE OF INSURANCE', 'CERTIFICATE OF LIABILITY INSURANCE', 'Certificate of Insurance'], rows: [row('vendor', L.insured, VENDORS.sun), row('insurer', L.insurer, INSURERS[1]), row('policy_number', L.policy, 'CPP-100234'), row(null, L.exp, '12/31')] }), { optional: ['vendor', 'insurer', 'policy_number'], note: 'expiry printed without a year: dropped' });
  add('inv-two-in-one.pdf', 'invoice', () => ({ titles: same('INVOICE'), rows: [row(null, ['Invoice No', 'Invoice #', 'Inv No.'], 'INV-7001', { page: 1 }), row(null, ['Vendor', 'Vendor', 'Vendor'], VENDORS.rios, { page: 1 }), row(null, ['Total', 'Total', 'Total'], 120, { money: true, page: 1 }), row(null, ['Invoice No', 'Invoice #', 'Inv No.'], 'INV-7002', { page: 2 }), row(null, ['Vendor', 'Vendor', 'Vendor'], VENDORS.rios, { page: 2 }), row(null, ['Total', 'Total', 'Total'], 340, { money: true, page: 2 })] }), { mustBeNull: true, note: 'two invoices in one file: never read as one' });
  add('inv-partial-pay.pdf', 'invoice', (ctx) => ({ titles: same('INVOICE'), rows: [row(null, ['Invoice No', 'Invoice #', 'Inv No.'], 'INV-7010'), row(null, ['Vendor', 'Vendor', 'Vendor'], VENDORS.cool), row(null, ['Invoice Date', 'Invoice Date', 'Invoice Date'], D(-9), { date: true }), row(null, ['Amount Due', 'Amount Due', 'Amount Due'], 200, { money: true }), row(null, ['Amount Paid', 'Amount Paid', 'Amount Paid'], 100, { money: true })] }), { optional: ['invoice_number', 'vendor', 'invoice_date'], note: 'only a balance line: never a total' });
  add('wo-nte.pdf', 'work-order', (ctx) => ({ titles: ['MAINTENANCE WORK ORDER', 'MAINTENANCE REQUEST', 'Work Order'], rows: [row('work_order_number', ['Work Order #', 'WO No', 'Maintenance Request #'], 'WO-20460', { keep: true }), ...propRows(p4, '110', ctx), row('opened_date', ['Date Opened', 'Opened', 'Date Submitted'], D(-2), { date: true }), row('service_date', ['Scheduled Date', 'Scheduled For', 'Scheduled'], D(3), { date: true }), row('status', ['Status', 'Work Order Status', 'Current Status'], 'Scheduled'), row('priority', ['Priority', 'Urgency', 'Priority Level'], 'Normal'), row(null, ['NTE', 'NTE', 'NTE'], 500, { money: true }), row(null, ['Estimated Cost', 'Estimated Cost', 'Estimated Cost'], 450, { money: true }), row(null, ['Assigned To', 'Assigned To', 'Assigned To'], 'Mike R. (in-house maintenance)'), row('work_performed', ['Work Requested', 'Description of Work', 'Scope of Work'], ['Replace suite lighting ballast'])] }), { mustRead: true, note: 'not-to-exceed and estimate are not a cost; an in-house name is not a vendor' });
  add('wo-completed-before-opened.pdf', 'work-order', (ctx) => ({ titles: ['MAINTENANCE WORK ORDER', 'MAINTENANCE REQUEST', 'Work Order'], rows: [row('work_order_number', ['Work Order #', 'WO No', 'Maintenance Request #'], 'WO-20461', { keep: true }), ...propRows(p1, '8C', ctx), row('opened_date', ['Date Opened', 'Opened', 'Date Submitted'], D(-10), { date: true }), row('status', ['Status', 'Work Order Status', 'Current Status'], 'Completed'), row(null, ['Date Completed', 'Completed On', 'Completion Date'], D(-40), { date: true }), row('service_date', ['Scheduled Date', 'Scheduled For', 'Scheduled'], D(-9), { date: true }), row('work_performed', ['Work Requested', 'Description of Work', 'Scope of Work'], ['Replace bathroom exhaust fan'])] }), { mustRead: true, note: 'completed before it was opened: completed_date dropped' });
  add('contract-term-only.pdf', 'vendor-contract', () => ({ titles: ['VENDOR SERVICE AGREEMENT', 'SERVICE CONTRACT', 'Vendor Contract'], rows: [row('vendor', L.vendor, VENDORS.bright), row('contract_scope', ['Scope of Services', 'Services', 'Scope'], 'Janitorial service for the leasing office'), row('agreement_term', ['Contract Term', 'Term', 'Term'], '12 months'), row('monthly_amount', ['Monthly Fee', 'Monthly Amount', 'Monthly Service Fee'], 400, { money: true })] }), { mustRead: true, note: 'a term in months is never turned into dates' });
  add('coi-dmy-2digit.pdf', 'certificate-of-insurance', () => ({ titles: ['CERTIFICATE OF INSURANCE', 'CERTIFICATE OF INSURANCE', 'Certificate of Insurance'], rows: [row('vendor', L.insured, VENDORS.iron), row('insurer', L.insurer, INSURERS[3]), row('policy_number', L.policy, 'IR-300777'), row('coi_expires', L.exp, D(120), { date: true })] }), { mustRead: true, dateFmt: 4, note: 'day-month-name-year dates' });
  add('lease-dmy.pdf', 'lease-agreement', (ctx) => ({ titles: ['RESIDENTIAL LEASE AGREEMENT', 'APARTMENT LEASE AGREEMENT', 'Residential Lease'], rows: [row('customer_name', L.owner, p3.owner), row('tenant_name', L.tenant, 'Noor Haddad'), ...propRows(p3, '5', ctx), row('lease_start_date', ['Lease Start', 'Lease Start Date', 'Commencement Date'], D(-15), { date: true }), row('lease_end_date', ['Lease End', 'Lease End Date', 'Expiration Date'], D(350), { date: true }), row('rent_amount', ['Monthly Rent', 'Rent', 'Monthly Rent Amount'], 1710, { money: true })] }), { mustRead: true, dateFmt: 4 });
  add('rentroll-conflict.pdf', 'rent-roll', () => ({ titles: same('RENT ROLL'), rows: [row('property_name', L.pname, p4.name, { keep: true })], raw: [{ t: 'Unit | Tenant | Lease Start | Lease End | Rent | Status' }, { t: `101 | Ava Chen | ${us(D(-50))} | ${us(D(315))} | $2,100.00 | Occupied` }, { t: `102 | Ben Ortiz | ${us(D(-20))} | ${us(D(345))} | $2,150.00 | Occupied` }, { t: `102 | Ben Ortiz | ${us(D(-20))} | ${us(D(345))} | $2,250.00 | Occupied` }, { t: `103 | Cara Voss | ${us(D(-70))} | $2,100.00 | Occupied` }, { t: 'Total units: 4' }], truthExtra: { rent_roll_row: { value: [`unit=101; tenant=Ava Chen; lease_start=${D(-50)}; lease_end=${D(315)}; rent=2100.00; status=Occupied`], page: 1 } } }), { mustRead: true, partial: [], note: 'a unit printed twice with different rents and a ragged row are both left out' });
  add('notice-annual-inspection.pdf', 'correspondence', () => ({ titles: same('NOTICE OF ANNUAL UNIT INSPECTION'), rows: [], raw: [{ t: 'Date: ' + us(D(-3)) }, { t: 'Property: Saguaro Ridge Apartments, 1200 Mesa Drive, Mesa AZ' }, { t: 'Unit: 4B' }, { t: 'Dear Resident, we will inspect your unit on ' + us(D(12)) + ' between 9am and noon.' }] }), { wrongType: true, mustBeNull: true, note: 'an advance notice of an inspection is not an inspection report' });
  add('insp-future-date.pdf', 'inspection-report', (ctx) => ({ titles: ['ANNUAL UNIT INSPECTION REPORT', 'ANNUAL INSPECTION REPORT', 'Annual Unit Inspection'], rows: [...propRows(p2, '8B', ctx), row('inspection_type', ['Inspection Type', 'Type of Inspection', 'Inspection'], 'Annual'), row('inspection_result', ['Result', 'Overall Result', 'Outcome'], 'Passed'), row(null, ['Inspection Date', 'Date of Inspection', 'Inspected On'], D(400), { date: true })] }), { optional: ['service_address', 'property_name', 'unit_number', 'inspection_type', 'inspection_result'], note: 'an inspection dated more than a month in the future is a misread: dropped' });
  add('moveout-ambiguous.pdf', 'move-out-inspection', (ctx) => ({ titles: ['MOVE-OUT INSPECTION REPORT', 'MOVE-OUT CONDITION CHECKLIST', 'Move-Out Inspection'], rows: [...propRows(p1, '6B', ctx), row('tenant_name', L.tenant, 'Felix Armstrong'), row('service_date', ['Inspection Date', 'Date of Inspection', 'Inspected On'], D(-4), { date: true }), row(null, ['Result', 'Overall Result', 'Outcome'], 'Pass/Fail pending review')] }), { mustRead: true, note: 'an unclear result is left out' });

  // ---- wrong-type documents: carry no data fields; must never be read as data
  const wrong = (file, type, titles, lines, note) => add(file, type, () => ({ titles, rows: [], raw: lines.map((t) => ({ t, page: 1 })) }), { wrongType: true, note });
  wrong('letter-vendor-coi-request.pdf', 'correspondence', same('LETTER'), ['Date: ' + us(D(-4)), 'To: Rios Plumbing LLC', 'Dear Rios Plumbing,', 'Our records show your Certificate of Insurance expires ' + us(D(20)) + '. Please send a renewed certificate with Desert Ridge Property Management LLC as certificate holder.', 'Thank you, Desert Ridge Property Management'], 'letter that merely mentions a COI and its expiry');
  wrong('hvac-tuneup-saguaro.pdf', 'other', ['A/C TUNE-UP SHEET', 'AC TUNE UP SHEET', 'A/C Tune-Up Sheet'], ['Site Address: 1200 Mesa Drive, Mesa AZ', 'Tonnage: 3', 'Refrigerant: R-410A', 'Filter replaced: yes'], 'HVAC sheet');
  wrong('cover-fax.pdf', 'internal', same('FAX COVER SHEET'), ['Pages: 1', 'From: Desert Ridge Property Management'], 'cover page');
  wrong('letter-lease-renewal.pdf', 'correspondence', same('LEASE RENEWAL NOTICE'), ['Dear Jordan Ellis,', 'Your lease for Unit 4B at Saguaro Ridge Apartments ends on ' + long(D(165)) + '. Your renewal rent would be $1,495.00 per month.', 'Please reply by ' + long(D(100)) + '.'], 'letter about a lease, not a lease');
  wrong('form-w9-blank.pdf', 'other', same('REQUEST FOR TAXPAYER IDENTIFICATION NUMBER AND CERTIFICATION'), ['Name: ', 'Business name: ', 'Address: ', 'Signature: '], 'blank tax form');
  wrong('po-8841.pdf', 'purchase-order', same('PURCHASE ORDER'), ['PO Number: PO-8841', 'Vendor: Ferguson Enterprises', 'Item: Kitchen faucet 6 each', 'Total: $612.00', 'Property: 1200 Mesa Drive, Mesa AZ'], 'a document type the deterministic reader does not own');
  wrong('checklist-annual-blank.pdf', 'inspection-report', same('ANNUAL UNIT INSPECTION CHECKLIST'), ['Property: ', 'Unit: ', 'Inspector: ', 'Smoke detectors tested  ____', 'Filters replaced  ____'], 'blank checklist template');
  wrong('coi-request-form.pdf', 'other', same('CERTIFICATE OF INSURANCE REQUEST'), ['Vendor: ', 'Insurer: ', 'Policy Number: ', 'Please complete and return.'], 'blank COI request form');
  return docs;
}

/* ---------- TRUTH (from specs only) ---------- */
export function truth() {
  const docs = buildDocs();
  const byType = {}; for (const d of docs) byType[d.truth.type] = (byType[d.truth.type] ?? 0) + 1;
  const minExp = (c) => c.policies.map((p) => p.exp).filter(Boolean).reduce((a, b) => (a < b ? a : b), null);
  // current COI per vendor = the one with the latest coi_expires (D1)
  const byVendor = new Map();
  for (const c of COIS) { const e = minExp(c); if (!e) continue; const cur = byVendor.get(c.vendor); if (!cur || e > cur.exp) byVendor.set(c.vendor, { vendor: c.vendor, exp: e, file: c.file }); }
  const cois = [...byVendor.values()];
  const within = (arr, key, n) => arr.filter((x) => x[key] >= TODAY && x[key] <= addDays(TODAY, n));
  const before = (arr, key) => arr.filter((x) => x[key] < TODAY);
  const leases = LEASES.filter((l) => l.end).map((l) => ({ ...l, p: prop(l.p) }));
  const contracts = CONTRACTS.map((c) => ({ ...c }));
  const invoices = INVOICES.filter((i) => i.due);
  return {
    docs, byType, cois,
    coisExpiringWithin: (n) => within(cois, 'exp', n), coisExpired: () => before(cois, 'exp'), coisExpiringToday: () => cois.filter((c) => c.exp === TODAY),
    leases, leasesExpiringWithin: (n) => within(leases, 'end', n), leasesExpired: () => before(leases, 'end'),
    contracts, contractsEndingWithin: (n) => within(contracts, 'end', n), contractsEnded: () => before(contracts, 'end'),
    invoicesPastDue: () => invoices.filter((i) => i.due < TODAY && !/^paid$/i.test(i.status)),
    reinspectionsOverdue: () => INSPECTIONS.filter((x) => x.reinspect && x.reinspect < TODAY),
    vendors: Object.values(VENDORS), properties: PROPS,
  };
}
