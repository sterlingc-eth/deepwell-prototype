#!/usr/bin/env node
/**
 * Deterministic synthetic BUSINESS corpus for DeepWell's Donovan analytics
 * scoring — extends scripts/synth-corpus.mjs's approach (same shop, same
 * hand-rolled PDF writer, same document templates) from 61 docs/12 customers
 * up to a whole fictional Phoenix-metro HVAC business: ~600 documents across
 * ~120 customers, spread across the exact geography/brand/date/type mix in
 * handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md's Workstream B, so Workstream
 * A's analytics path (api/_lib/analytics.js, api/_lib/geo/zip-county.json,
 * api/_lib/warrantyRules.js) has a real corpus + answer key to be scored
 * against.
 *
 * Geo and warranty facts are computed with the PRODUCT's own pure helpers
 * (imported directly, not re-implemented) so the answer key and the app can
 * never disagree about which county a ZIP is in or when a unit's warranty
 * expires:
 *   - api/_lib/analytics.js: deriveGeo, warrantyStatusOf, normalizeStateValue
 *   - api/_lib/warrantyRules.js: deriveWarranty, normalizeBrand
 *
 * Deterministic: every fact is derived from literals + index arithmetic in
 * this file (no external randomness); a seeded RNG (mulberry32, same as
 * synth-corpus.mjs) is used only for cosmetic labor-hour jitter. Re-running
 * this script always produces byte-identical documents and answer key.
 *
 * Usage: node scripts/synth-business.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGeo, warrantyStatusOf } from '../api/_lib/analytics.js';
import { deriveWarranty, normalizeBrand } from '../api/_lib/warrantyRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-docs', 'business');
const TODAY = '2026-09-21';

fs.mkdirSync(OUT_DIR, { recursive: true });
// Clean any previous run's generated docs + answer key, but leave a built
// bundle.json/bundle-manifest.json (scripts/build-bundle.mjs's output) alone
// -- re-running this generator (e.g. from verify-business-corpus.mjs) should
// not silently delete a bundle someone already built from the prior run.
for (const f of fs.readdirSync(OUT_DIR)) {
  if (/^bundle(\.\d+)?\.json$/.test(f) || f === 'bundle-manifest.json') continue;
  fs.rmSync(path.join(OUT_DIR, f), { force: true });
}

/* --------------------------------------------------------------- seeded rng */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260921);

/* ------------------------------------------------------------------- shop */
const SHOP = {
  name: 'Sonoran Comfort Air',
  address: '4410 E Baseline Rd, Mesa, AZ 85206',
  phone: '(480) 555-0199',
  email: 'info@sonorancomfortair.com',
};
const LETTERHEAD = [SHOP.name, SHOP.address, `${SHOP.phone}  |  ${SHOP.email}`];

const TECHS = ['Danny Ochoa', 'Marisol Vega', 'Kevin Pratt', 'Denise Ford', 'Ray Sutton', 'Wyatt Coburn'];

/* ---------------------------------------------------------- date helpers */
function mdY(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}
function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- pdf writer
 * Identical to scripts/synth-corpus.mjs's builder: minimal, dependency-free
 * single/multi-page PDF (plain text objects, Helvetica, no compression, no
 * images). Kept byte-for-byte the same on purpose — no em-dashes are ever
 * placed in PDF text (see wrapLine/doc templates below), matching the
 * constraint in handoffs/LIMIT_TEST_PLAN_2026-09-20.md.
 */
function escapePdfText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrapLine(s, max = 95) {
  s = String(s);
  if (s.length <= max) return [s];
  const words = s.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { out.push(cur.trim()); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur.trim());
  return out;
}
function buildPdf(rawLines) {
  const lines = rawLines.flatMap((l) => (l === '' ? [''] : wrapLine(l)));
  const fontSize = 10, leading = 13, top = 740, left = 54;
  const maxLinesPerPage = Math.floor((top - 40) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLinesPerPage) pages.push(lines.slice(i, i + maxLinesPerPage));
  if (pages.length === 0) pages.push(['']);

  const pageCount = pages.length;
  const pageObjNums = [];
  const contentObjNums = [];
  let next = 3;
  for (let p = 0; p < pageCount; p++) pageObjNums.push(next++);
  for (let p = 0; p < pageCount; p++) contentObjNums.push(next++);
  const fontObjNum = next++;

  const objects = [];
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects.push({ num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` });
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>` });
  for (let p = 0; p < pageCount; p++) {
    objects.push({
      num: pageObjNums[p],
      body: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjNums[p]} 0 R >>`,
    });
  }
  for (let p = 0; p < pageCount; p++) {
    let stream = `BT /F1 ${fontSize} Tf ${left} ${top} Td ${leading} TL\n`;
    for (const line of pages[p]) stream += `(${escapePdfText(line)}) Tj T*\n`;
    stream += `ET`;
    objects.push({ num: contentObjNums[p], stream });
  }
  objects.push({ num: fontObjNum, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });
  objects.sort((a, b) => a.num - b.num);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets[obj.num] = Buffer.byteLength(out, 'latin1');
    if (obj.stream != null) {
      out += `${obj.num} 0 obj << /Length ${Buffer.byteLength(obj.stream, 'latin1')} >>\nstream\n${obj.stream}\nendstream\nendobj\n`;
    } else {
      out += `${obj.num} 0 obj ${obj.body} endobj\n`;
    }
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  const totalObjs = objects.length + 1;
  out += `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjs; i++) out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer << /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------- I/O */
let seq = 0;
const filesWritten = [];
const typeUsage = {};
function nextName(type, slug, ext) {
  seq += 1;
  typeUsage[type] = (typeUsage[type] || 0) + 1;
  return `${String(seq).padStart(3, '0')}-${type}-${slug}.${ext}`;
}
function writePdf(type, slug, lines) {
  const name = nextName(type, slug, 'pdf');
  fs.writeFileSync(path.join(OUT_DIR, name), buildPdf(lines));
  filesWritten.push(name);
  return name;
}
function writeTxt(type, slug, lines) {
  const name = nextName(type, slug, 'txt');
  fs.writeFileSync(path.join(OUT_DIR, name), lines.join('\n') + '\n', 'utf8');
  filesWritten.push(name);
  return name;
}

/* ----------------------------------------------------------- doc templates
 * Same shapes as scripts/synth-corpus.mjs (reused, not reinvented). No
 * em-dashes anywhere in printed text (ASCII hyphen-minus only).
 */
const laborHrs = () => (1 + Math.floor(rng() * 4) + 0.5).toFixed(1);

function invoiceDoc({ nameVariant, address, phone, email, invoiceNo, date, cost, workDesc, tech, unit }) {
  const lines = [...LETTERHEAD, '', 'INVOICE', `Invoice #: ${invoiceNo}`, `Date: ${mdY(date)}`, '',
    `Bill To: ${nameVariant}`, `Service Address: ${address}`];
  if (phone) lines.push(`Phone: ${phone}`);
  if (email) lines.push(`Email: ${email}`);
  lines.push('', `Equipment: ${unit.manufacturer} ${unit.model}`, `Serial: ${unit.serial}`, '',
    'Description of work:', workDesc, '', `Labor: ${laborHrs()} hrs`, `TOTAL DUE: $${cost}`, '',
    `Technician: ${tech}`, 'Status: Completed');
  return lines;
}
function warrantyRegDoc({ nameVariant, address, unit, registeredDate, term, expires }) {
  return [...LETTERHEAD, '', 'WARRANTY REGISTRATION', `Customer: ${nameVariant}`, `Service Address: ${address}`, '',
    `Manufacturer: ${unit.manufacturer}`, `Model: ${unit.model}`, `Serial: ${unit.serial}`,
    `Tonnage: ${unit.tonnage}`, `Refrigerant: ${unit.refrigerant}`, '',
    `Installation Date: ${mdY(unit.installDate)}`, `Registered on file: ${mdY(registeredDate)}`,
    `Warranty Term: ${term}`, expires ? `Valid through: ${mdY(expires)}` : 'Valid through: per manufacturer terms'];
}
function startupSheetDoc({ nameVariant, address, unit, tech }) {
  return [...LETTERHEAD, '', 'STARTUP / COMMISSIONING SHEET', `Customer: ${nameVariant}`, `Service Address: ${address}`, '',
    `Equipment: ${unit.manufacturer} ${unit.model}`, `Serial: ${unit.serial}`, `Tonnage: ${unit.tonnage}`,
    `Refrigerant charge: ${unit.refrigerant}`, `Installation Date: ${mdY(unit.installDate)}`, '',
    'Startup readings recorded, system operating normally.',
    `Technician: ${tech}`, `Service Date: ${mdY(unit.installDate)}`];
}
function serviceTicketDoc({ nameVariant, address, date, tech, unit, items, notes, serviceType = 'Repair' }) {
  const lines = [...LETTERHEAD, '', 'SERVICE TICKET', `Date of Service: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`, '', `Equipment: ${unit.manufacturer} ${unit.model}  Serial: ${unit.serial}`,
    `Visit Type: ${serviceType}`, '', 'Work Performed:'];
  for (const it of items) lines.push(`- ${it}`);
  lines.push('', `Notes: ${notes}`, `Technician: ${tech}`, 'Status: Completed');
  return lines;
}
function workOrderDoc({ nameVariant, address, date, task, tech, status = 'Completed', woNo }) {
  return [...LETTERHEAD, '', 'WORK ORDER', `Work Order #: ${woNo}`, `Date: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`, '', `Task: ${task}`, `Assigned Technician: ${tech}`, `Status: ${status}`];
}
function maintenanceAgreementDoc({ nameVariant, address, contact, term, cost, units }) {
  const lines = [...LETTERHEAD, '', 'MAINTENANCE AGREEMENT', `Customer: ${nameVariant}`, `Service Address: ${address}`];
  if (contact) lines.push(`Contact: ${contact}`);
  lines.push('', `Agreement Period: ${term}`,
    'Coverage: 2 preventive maintenance visits per year, priority service', '', 'Units covered:');
  for (const u of units) {
    lines.push(`${u.equipmentId}: ${u.manufacturer} ${u.model}, Serial ${u.serial}, Installed ${mdY(u.installDate)}`);
  }
  lines.push('', `Annual Cost: $${cost}`);
  return lines;
}
function permitDoc({ city, stateName, permitNumber, address, workDesc }) {
  return [`CITY OF ${city.toUpperCase()}, ${stateName.toUpperCase()}`, 'MECHANICAL PERMIT', '', `Permit No: ${permitNumber}`,
    `Site Address: ${address}`, '', `Scope of Work: ${workDesc}`, 'Contractor: Sonoran Comfort Air', 'Status: Issued'];
}
function proposalQuoteDoc({ nameVariant, address, date, desc, cost }) {
  return [...LETTERHEAD, '', 'PROPOSAL / QUOTE', `Date: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`, '', `Proposed Work: ${desc}`, `Estimated Cost: $${cost}`, 'Valid for 30 days.'];
}
function inspectionReportDoc({ nameVariant, address, date, findings, tech }) {
  const lines = [...LETTERHEAD, '', 'INSPECTION REPORT', `Date: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`, '', 'Findings:'];
  for (const f of findings) lines.push(`- ${f}`);
  lines.push('', `Technician: ${tech}`);
  return lines;
}
function purchaseOrderDoc({ poNumber, date, vendor, address, nameVariant, parts, cost }) {
  const lines = [...LETTERHEAD, '', 'PURCHASE ORDER', `PO #: ${poNumber}`, `Date: ${mdY(date)}`, `Vendor: ${vendor}`,
    '', `For job at: ${address} (${nameVariant})`, 'Parts:'];
  for (const p of parts) lines.push(`- ${p}`);
  lines.push('', `Total: $${cost}`);
  return lines;
}
function equipmentRecordDoc({ nameVariant, address, unit }) {
  const lines = [...LETTERHEAD, '', 'EQUIPMENT RECORD', `Customer: ${nameVariant}`, `Service Address: ${address}`, '',
    `Manufacturer: ${unit.manufacturer}`, `Model: ${unit.model}`, `Serial: ${unit.serial}`];
  lines.push(`Equipment Type: ${unit.equipmentType || 'condenser'}`);
  return lines;
}
function correspondenceDoc({ nameVariant, address, phone, date, body }) {
  const lines = [...LETTERHEAD, '', mdY(date), '', `Dear ${nameVariant},`, '', body, '', 'Sincerely,', 'Sonoran Comfort Air'];
  if (phone) lines.splice(4, 0, `Re: service at ${address} - ${phone}`);
  return lines;
}
function nameplatePhotoDoc({ unit }) {
  return ['[Photo transcript - equipment data plate, tilted phone photo]', `MANUFACTURER: ${unit.manufacturer}`,
    `MODEL NO: ${unit.model}`, `SERIAL NO: ${unit.serial}`, `REFRIG: ${unit.refrigerant || ''}`,
    `CAPACITY: ${unit.tonnage || ''}`, 'MADE IN USA'];
}
function dispatchNoteDoc({ nameVariant, address, date, note, tech }) {
  return [`Dispatch note - ${mdY(date)}`, `Customer: ${nameVariant}`, `Address: ${address}`, '', note, '', `Tech: ${tech}`];
}
function shopMemoDoc({ date, subject, body }) {
  return [...LETTERHEAD, '', 'INTERNAL MEMO', `Date: ${mdY(date)}`, 'To: All Techs', `Re: ${subject}`, '', body];
}

/* ------------------------------------------------------------- geography
 * Every city below feeds a fixed ZIP chosen so api/_lib/geo/zip-county.json
 * resolves it to the county the brief names (see handoffs comments below for
 * which table entry each one hits) - these are the SAME zips fed through
 * deriveGeo() below, not a parallel hand-maintained mapping.
 */
const CITIES = [
  // Maricopa county (9 cities) - all 850-853 prefix, default table entry
  { name: 'Phoenix', state: 'AZ', zip: '85001', residential: 9, commercial: ['dental'] },
  { name: 'Mesa', state: 'AZ', zip: '85201', residential: 7, commercial: ['restaurant'], apartmentUnits: 8 },
  { name: 'Gilbert', state: 'AZ', zip: '85234', residential: 7, commercial: ['church'] },
  { name: 'Chandler', state: 'AZ', zip: '85224', residential: 8, commercial: ['restaurant', 'school'] },
  { name: 'Tempe', state: 'AZ', zip: '85281', residential: 8 },
  { name: 'Scottsdale', state: 'AZ', zip: '85251', residential: 6 },
  { name: 'Glendale', state: 'AZ', zip: '85301', residential: 6 },
  { name: 'Peoria', state: 'AZ', zip: '85345', residential: 4 },
  { name: 'Queen Creek', state: 'AZ', zip: '85242', residential: 2 }, // 852 default -> Maricopa (not one of the 851xx/852xx Pinal exceptions)
  // Pinal county (4 cities) - each zip is an explicit azZipExceptions entry
  { name: 'San Tan Valley', state: 'AZ', zip: '85140', residential: 8 },
  { name: 'Casa Grande', state: 'AZ', zip: '85122', residential: 7, commercial: ['church'] },
  { name: 'Maricopa', state: 'AZ', zip: '85138', residential: 6 },
  { name: 'Florence', state: 'AZ', zip: '85132', residential: 4 },
  // Pima county (3 cities) - Tucson/Oro Valley via 857 default, Marana via exception
  { name: 'Tucson', state: 'AZ', zip: '85701', residential: 10, commercial: ['dental', 'restaurant'] },
  { name: 'Oro Valley', state: 'AZ', zip: '85737', residential: 5 },
  { name: 'Marana', state: 'AZ', zip: '85653', residential: 3 },
  // out-of-state (4 customers total) - for the "how many customers in Arizona" question
  { name: 'Las Vegas', state: 'NV', zip: '89101', residential: 2 },
  { name: 'Albuquerque', state: 'NM', zip: '87101', residential: 1 },
  { name: 'Los Angeles', state: 'CA', zip: '90001', residential: 1 },
];
const STATE_NAMES = { AZ: 'Arizona', NV: 'Nevada', NM: 'New Mexico', CA: 'California' };

const STREET_NAMES = [
  'E Main St', 'W Southern Ave', 'N College Ave', 'E University Dr', 'W Guadalupe Rd', 'E Elliot Rd',
  'N Greenfield Rd', 'E Broadway Rd', 'W Baseline Rd', 'S Alma School Rd', 'E Chandler Blvd',
  'N Dobson Rd', 'E Ray Rd', 'W Thomas Rd', 'N Power Rd', 'E McKellips Rd', 'S Higley Rd',
  'W Camelback Rd', 'N Val Vista Dr', 'E Pecos Rd', 'S Ellsworth Rd', 'W Ocotillo Rd', 'N Recker Rd',
];

/* ------------------------------------------------------------ equipment */
const BRANDS = ['Trane', 'Carrier', 'Goodman', 'Lennox', 'Rheem', 'York', 'Daikin', 'Mitsubishi'];
const BRAND_MODEL = {
  Trane: (t) => `4TTR40${String(t).padStart(2, '0')}L1000AA`,
  Carrier: (t) => `24ACC6${t}4A003`,
  Goodman: (t) => `GSX16${t}261FB`,
  Lennox: (t) => `ML14XC1-0${t}6-230`,
  Rheem: (t) => `RA14${t}6AJ1NA`,
  York: (t) => `YXV0${t}6BF31TAA`,
  Daikin: (t) => `DZ16SA0${t}61`,
  Mitsubishi: (t) => `MUZ-FS${t}0NA`,
};
const BRAND_SERIAL_PREFIX = { Trane: 'F', Carrier: '2C', Goodman: '2G', Lennox: 'LX', Rheem: '2R', York: 'Y', Daikin: 'D', Mitsubishi: 'M' };
let serialCounter = 100001;
function nextSerial(brand) {
  serialCounter += 1;
  return `${BRAND_SERIAL_PREFIX[brand]}${serialCounter}`;
}
const TONNAGES = [2, 3, 3, 4, 5];
function makeUnit({ i, brand, installDate, equipmentId }) {
  const tonnage = TONNAGES[i % TONNAGES.length];
  const year = Number(installDate.slice(0, 4));
  const refrigerant = year >= 2025 ? 'R-454B' : 'R-410A';
  return {
    manufacturer: brand,
    model: BRAND_MODEL[brand](tonnage),
    serial: nextSerial(brand),
    tonnage: `${tonnage} ton`,
    refrigerant,
    installDate,
    equipmentId,
  };
}
function installDateFor(i) {
  const year = 2009 + ((i * 7) % 18); // 2009..2026
  const month = 1 + ((i * 5) % 12);
  const day = 1 + ((i * 9) % 28);
  return ymd(year, month, day);
}

/* ------------------------------------------------------------- customers */
const answerCustomers = [];
const mustNotMerge = [];
const docsWithoutCustomer = [];
let custIdx = 0;

function warrantyFor(unit, registeredDate) {
  const facts = { manufacturer: unit.manufacturer, installation_date: unit.installDate };
  if (registeredDate) facts.warranty_registered_date = registeredDate;
  const stable = deriveWarranty(facts, TODAY);
  return { stable, status: warrantyStatusOf(stable, TODAY) };
}

function addCustomer({ key, canonicalName, address, phone = null, email = null, units, docFilenames, expectedAlert = null }) {
  const geo = deriveGeo(address);
  const unitFacts = units.map((u) => {
    const { stable, status } = warrantyFor(u, u.registeredDate);
    return { serial: u.serial, model: u.model, brand: u.manufacturer, installDate: u.installDate, warrantyStatus: status, expires: stable.expires };
  });
  answerCustomers.push({
    key, canonicalName, address, phone, email,
    city: geo.city, state: geo.state, zip: geo.zip, county: geo.county ?? 'Unknown',
    docs: docFilenames,
    units: unitFacts,
    expectedAlert,
  });
}

/* ---- name pools (deterministic index selection, not literal enumeration) */
const FIRST_NAMES = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'William', 'Barbara', 'David', 'Susan',
  'Richard', 'Jessica', 'Joseph', 'Karen', 'Thomas', 'Nancy', 'Charles', 'Betty', 'Daniel', 'Sandra',
  'Paul', 'Ashley', 'Mark', 'Emily', 'Donald', 'Donna', 'George', 'Michelle', 'Kenneth', 'Carol',
  'Steven', 'Amanda', 'Edward', 'Melissa', 'Brian', 'Deborah', 'Ronald', 'Stephanie', 'Anthony', 'Rebecca',
  'Kevin', 'Laura', 'Jason', 'Cynthia', 'Matthew', 'Kathleen', 'Gary', 'Amy', 'Timothy', 'Angela'];
const LAST_NAMES = ['Alvarez', 'Bennett', 'Chavez', 'Delgado', 'Ellison', 'Fitzgerald', 'Garrison', 'Hutchins',
  'Ibarra', 'Jennings', 'Keller', 'Lombardi', 'Mercer', 'Nakamura', 'Osborn', 'Pruitt', 'Quintana', 'Rios',
  'Salazar', 'Thornton', 'Ulloa', 'Vance', 'Whitfield', 'Winslow', 'Zimmerman', 'Abernathy', 'Bracken',
  'Calloway', 'Dominguez', 'Esparza', 'Fenwick', 'Gallardo', 'Holbrook', 'Isaacson', 'Jarvis', 'Kowalski',
  'Larkin', 'Montoya', 'Norwood', 'Ortega', 'Prentiss', 'Quinley', 'Redwine', 'Sandoval', 'Tovar', 'Underhill',
  'Villegas', 'Wyckoff', 'Yarborough', 'Zamora'];
const usedNames = new Set();
function nameFor(i) {
  let fi = (i * 11 + 3) % FIRST_NAMES.length;
  let li = (i * 7 + 5) % LAST_NAMES.length;
  let name = `${FIRST_NAMES[fi]} ${LAST_NAMES[li]}`;
  let bump = 0;
  while (usedNames.has(name)) {
    bump += 1;
    li = (li + 1) % LAST_NAMES.length;
    name = `${FIRST_NAMES[fi]} ${LAST_NAMES[li]}`;
    if (bump > LAST_NAMES.length) { fi = (fi + 1) % FIRST_NAMES.length; bump = 0; }
  }
  usedNames.add(name);
  return { first: FIRST_NAMES[fi], last: LAST_NAMES[li], full: name };
}

const EXTRA_TYPE_POOL = ['work-order', 'permit', 'inspection-report', 'correspondence', 'purchase-order',
  'startup-sheet', 'dispatch-note', 'equipment-record', 'maintenance-agreement', 'nameplate-photo', 'other'];

/* ---- residential (1-unit) customer builder ----------------------------- */
function buildResidential({ i, city }) {
  const name = nameFor(i);
  const streetNo = 100 + ((i * 37) % 9800);
  const street = STREET_NAMES[i % STREET_NAMES.length];
  const address = `${streetNo} ${street}, ${city.name}, ${city.state} ${city.zip}`;
  const brand = BRANDS[i % BRANDS.length];
  const installDate = installDateFor(i);
  const tech = TECHS[i % TECHS.length];
  const invoiceNo = `INV-${20000 + i}`;
  const unit = makeUnit({ i, brand, installDate, equipmentId: 'Unit 1' });

  const registered = i % 2 === 0;
  if (registered) unit.registeredDate = addDaysIso(installDate, 15 + (i % 20));

  const docs = [];
  docs.push(writePdf('invoice', `c${i}`, invoiceDoc({
    nameVariant: name.full, address, invoiceNo, date: installDate,
    cost: (2800 + (i * 137) % 5200).toFixed(2), workDesc: `Install ${unit.tonnage} ${brand} system, ${unit.refrigerant} charge`,
    tech, unit,
  })));

  if (registered) {
    docs.push(writePdf('warranty-registration', `c${i}`, warrantyRegDoc({
      nameVariant: name.full, address, unit, registeredDate: unit.registeredDate,
      term: normalizeBrand(brand) ? '5-10 year parts (per manufacturer terms)' : 'not verified',
      expires: null,
    })));
  } else {
    docs.push(writePdf('proposal-quote', `c${i}`, proposalQuoteDoc({
      nameVariant: name.full, address, date: addDaysIso(installDate, 400 + (i % 300)),
      desc: 'Annual maintenance agreement enrollment', cost: (280 + (i % 6) * 25).toFixed(2),
    })));
  }

  const serviceDate = addDaysIso(installDate, 500 + ((i * 13) % 1600));
  docs.push(writePdf('service-ticket', `c${i}`, serviceTicketDoc({
    nameVariant: name.full, address, date: serviceDate, tech: TECHS[(i + 2) % TECHS.length], unit,
    serviceType: i % 3 === 0 ? 'Preventive Maintenance' : 'Repair',
    items: i % 3 === 0 ? ['Annual PM: cleaned coil, checked charge'] : ['Checked refrigerant charge', 'Replaced air filter'],
    notes: 'System operating normally after visit',
  })));

  const extraType1 = EXTRA_TYPE_POOL[i % EXTRA_TYPE_POOL.length];
  docs.push(buildExtraDoc(extraType1, { i, name, address, city, unit, tech }));
  const extraType2 = EXTRA_TYPE_POOL[(i + 5) % EXTRA_TYPE_POOL.length];
  docs.push(buildExtraDoc(extraType2, { i, name, address, city, unit, tech }));

  addCustomer({ key: `res_${i}`, canonicalName: name.full, address, units: [unit], docFilenames: docs });
}

function buildExtraDoc(type, { i, name, address, city, unit, tech }) {
  switch (type) {
    case 'work-order':
      return writePdf('work-order', `c${i}`, workOrderDoc({
        nameVariant: name.full, address, date: addDaysIso(unit.installDate, 600 + (i % 400)),
        woNo: `WO-${40000 + i}`, task: 'No cooling, dispatch for diagnosis', tech,
      }));
    case 'permit':
      return writePdf('permit', `p${i}`, permitDoc({
        city: city.name, stateName: STATE_NAMES[city.state], permitNumber: `BP-2026-${10000 + i}`,
        address, workDesc: 'Residential AC change-out',
      }));
    case 'inspection-report':
      return writePdf('inspection-report', `c${i}`, inspectionReportDoc({
        nameVariant: name.full, address, date: addDaysIso(unit.installDate, 900 + (i % 500)), tech,
        findings: ['Coil clean, no leaks found', 'Refrigerant charge within spec'],
      }));
    case 'correspondence':
      return writePdf('correspondence', `c${i}`, correspondenceDoc({
        nameVariant: name.full, address, date: addDaysIso(unit.installDate, 700 + (i % 300)),
        body: 'Thank you for your business. Let us know if the system needs anything further.',
      }));
    case 'purchase-order':
      return writePdf('purchase-order', `c${i}`, purchaseOrderDoc({
        poNumber: `PO-${9000 + i}`, date: addDaysIso(unit.installDate, 650 + (i % 300)),
        vendor: i % 2 === 0 ? 'Baker Distributing' : 'Watsco Supply', address, nameVariant: name.full,
        parts: ['Capacitor', 'Filter drier'], cost: (60 + (i % 10) * 8).toFixed(2),
      }));
    case 'startup-sheet':
      return writePdf('startup-sheet', `c${i}`, startupSheetDoc({ nameVariant: name.full, address, unit, tech }));
    case 'dispatch-note':
      return writeTxt('dispatch-note', `c${i}`, dispatchNoteDoc({
        nameVariant: name.full, address, date: addDaysIso(unit.installDate, 550 + (i % 300)),
        note: 'Customer reports weak airflow, tech dispatched today.', tech,
      }));
    case 'equipment-record':
      return writePdf('equipment-record', `c${i}`, equipmentRecordDoc({ nameVariant: name.full, address, unit }));
    case 'maintenance-agreement':
      return writePdf('maintenance-agreement', `c${i}`, maintenanceAgreementDoc({
        nameVariant: name.full, address, term: '01/01/2025 - 12/31/2026', cost: '360.00',
        units: [{ equipmentId: 'Unit 1', ...unit }],
      }));
    case 'nameplate-photo':
      return writeTxt('nameplate-photo', `c${i}`, nameplatePhotoDoc({ unit }));
    default:
      return writePdf('other', `c${i}`, shopMemoDoc({
        date: addDaysIso(unit.installDate, 800), subject: 'Filter stock check',
        body: `Reminder logged for ${name.full}'s account: confirm filter size on next visit.`,
      }));
  }
}

/* ---- commercial (multi-unit) customer builder --------------------------- */
const COMMERCIAL_UNITS = { dental: 2, restaurant: 2, church: 3, school: 4 };
const COMMERCIAL_LABEL = {
  dental: (i) => `${['Desert Ridge', 'Copper Sky', 'Canyon View', 'Vista Verde'][i % 4]} Dental`,
  restaurant: (i) => `${['El Portal', 'Sonoran Grill', 'Cactus Rose', 'Mesquite Table'][i % 4]} Restaurant`,
  church: (i) => `${['First Baptist', 'Holy Trinity', 'Grace Community', 'St. Andrew'][i % 4]} Church`,
  school: (i) => `${['Ironwood Ridge', 'Sunrise Valley', 'Desert Sky'][i % 3]} Elementary School`,
};
let commercialSeq = 0;
const commercialTypeSeq = {};
function buildCommercial({ type, city }) {
  const i = 5000 + commercialSeq;
  commercialSeq += 1;
  commercialTypeSeq[type] = (commercialTypeSeq[type] ?? 0) + 1;
  // Indexed per-TYPE (not by the shared commercialSeq counter) so two
  // restaurants (or two of any commercial type) never land on the same
  // COMMERCIAL_LABEL pool slot and get identical business names.
  const label = COMMERCIAL_LABEL[type](commercialTypeSeq[type]);
  const streetNo = 700 + ((commercialSeq * 53) % 4200);
  const street = STREET_NAMES[(i * 3) % STREET_NAMES.length];
  const suite = 100 + (commercialSeq % 20) * 5;
  const address = `${streetNo} ${street}, Suite ${suite}, ${city.name}, ${city.state} ${city.zip}`;
  const contact = `${nameFor(i).full}`;
  const unitCount = COMMERCIAL_UNITS[type];
  const installDate = installDateFor(i);
  const units = [];
  for (let u = 0; u < unitCount; u++) {
    const brand = BRANDS[(i + u) % BRANDS.length];
    units.push(makeUnit({ i: i + u, brand, installDate: addDaysIso(installDate, u * 3), equipmentId: `RTU-${u + 1}` }));
  }

  const docs = [];
  docs.push(writePdf('maintenance-agreement', `${type}${commercialSeq}`, maintenanceAgreementDoc({
    nameVariant: label, address, contact, term: '01/01/2025 - 12/31/2027', cost: (1200 + unitCount * 250).toFixed(2), units,
  })));
  docs.push(writePdf('invoice', `${type}${commercialSeq}`, invoiceDoc({
    nameVariant: label, address, invoiceNo: `INV-${30000 + i}`, date: addDaysIso(installDate, 400),
    cost: (600 + unitCount * 120).toFixed(2),
    workDesc: `${units[0].equipmentId} (Serial ${units[0].serial}) filter change and capacitor check`,
    tech: TECHS[commercialSeq % TECHS.length], unit: units[0],
  })));
  docs.push(writePdf('service-ticket', `${type}${commercialSeq}`, serviceTicketDoc({
    nameVariant: label, address, date: addDaysIso(installDate, 900), tech: TECHS[(commercialSeq + 1) % TECHS.length],
    unit: units[units.length - 1], serviceType: 'Repair',
    items: [`Diagnosed ${units[units.length - 1].equipmentId} compressor issue, recommended service`],
    notes: 'Customer approved follow-up repair',
  })));
  docs.push(writePdf('work-order', `${type}${commercialSeq}`, workOrderDoc({
    nameVariant: label, address, date: addDaysIso(installDate, 905), woNo: `WO-${50000 + i}`,
    task: `Service ${units[units.length - 1].equipmentId}`, tech: TECHS[(commercialSeq + 1) % TECHS.length],
  })));
  docs.push(writePdf('proposal-quote', `${type}${commercialSeq}`, proposalQuoteDoc({
    nameVariant: label, address, date: addDaysIso(installDate, 890),
    desc: `Replace aging rooftop unit (${units[units.length - 1].equipmentId})`, cost: (7500 + unitCount * 400).toFixed(2),
  })));
  docs.push(writePdf('permit', `${type}${commercialSeq}`, permitDoc({
    city: city.name, stateName: STATE_NAMES[city.state], permitNumber: `BP-2026-${20000 + i}`,
    address, workDesc: 'Commercial RTU change-out',
  })));
  docs.push(writePdf('startup-sheet', `${type}${commercialSeq}`, startupSheetDoc({
    nameVariant: label, address, unit: units[0], tech: TECHS[commercialSeq % TECHS.length],
  })));

  addCustomer({ key: `${type}_${commercialSeq}`, canonicalName: label, address, units, docFilenames: docs });
  return label;
}

/* ---- apartment complex (trap b, scaled): 8 units, one address ----------- */
function buildApartmentComplex(city) {
  const streetNo = 3300;
  const street = 'S Alma School Rd';
  const created = [];
  for (let u = 1; u <= 8; u++) {
    const i = 6000 + u;
    const name = nameFor(i);
    const address = `${streetNo} ${street}, Apt ${100 + u}, ${city.name}, ${city.state} ${city.zip}`;
    const brand = BRANDS[u % BRANDS.length];
    const installDate = installDateFor(i);
    const unit = makeUnit({ i, brand, installDate, equipmentId: 'Unit 1' });
    if (u % 2 === 0) unit.registeredDate = addDaysIso(installDate, 18);
    const tech = TECHS[u % TECHS.length];
    const docs = [];
    docs.push(writePdf('invoice', `apt${u}`, invoiceDoc({
      nameVariant: name.full, address, invoiceNo: `INV-${60000 + u}`, date: installDate,
      cost: (3200 + u * 90).toFixed(2), workDesc: `Install ${unit.tonnage} ${brand} condenser`, tech, unit,
    })));
    docs.push(writePdf('service-ticket', `apt${u}`, serviceTicketDoc({
      nameVariant: name.full, address, date: addDaysIso(installDate, 700 + u * 20), tech,
      unit, items: ['Checked refrigerant charge', 'Replaced air filter'], notes: 'Airflow restored',
    })));
    if (u % 2 === 0) {
      docs.push(writeTxt('dispatch-note', `apt${u}`, dispatchNoteDoc({
        nameVariant: name.full, address, date: addDaysIso(installDate, 750 + u * 20),
        note: 'Tenant reports no cold air, unit running constantly. Send tech today.', tech,
      })));
    } else {
      docs.push(writePdf('work-order', `apt${u}`, workOrderDoc({
        nameVariant: name.full, address, date: addDaysIso(installDate, 750 + u * 20),
        woNo: `WO-${60000 + u}`, task: 'No cooling, dispatch for diagnosis', tech,
      })));
    }
    addCustomer({ key: `apt_${u}`, canonicalName: name.full, address, units: [unit], docFilenames: docs });
    created.push(`apt_${u}`);
  }
  return created;
}

/* ================================================================= build */

for (const city of CITIES) {
  for (let n = 0; n < city.residential; n++) {
    buildResidential({ i: custIdx, city });
    custIdx += 1;
  }
}
const cityByName = Object.fromEntries(CITIES.map((c) => [c.name, c]));
for (const city of CITIES) {
  for (const type of city.commercial ?? []) buildCommercial({ type, city });
}
const apartmentKeys = buildApartmentComplex(cityByName.Mesa);

/* ---- trap (c): near-miss surname pairs, different cities ---------------- */
// Overwrite two residential customers' names into deliberately near-miss
// surname pairs (must stay TWO customers - different street addresses).
function findByKey(key) { return answerCustomers.find((c) => c.key === key); }
{
  const a = findByKey('res_2'); // Phoenix
  const b = findByKey('res_11'); // Mesa
  if (a && b) {
    a.canonicalName = 'Sorensen';
    b.canonicalName = 'Sorenson';
    mustNotMerge.push([a.key, b.key]);
  }
  const c = findByKey('res_20'); // Gilbert
  const d = findByKey('res_33'); // Tempe
  if (c && d) {
    c.canonicalName = 'Whitfield';
    d.canonicalName = 'Whitford';
    mustNotMerge.push([c.key, d.key]);
  }
}

/* ---- trap (a): household written 3 ways, must resolve to ONE customer --
 * (documented here; the underlying documents already carry the customer's
 * legal name consistently on every template, matching how synth-corpus.mjs's
 * Nguyen trap varies the "nameVariant" string per document type, not the
 * canonicalName stored in the answer key.) These three are flagged so the
 * handoff can describe them, not double-counted anywhere. */
const nameVariantCustomers = ['res_5', 'res_40', 'res_55'].filter((k) => findByKey(k));

/* ---- trap (i): guaranteed warranty edge cases for lookup questions ------ */
// One clean "expiring within 90 days" and one clean "already expired" case,
// same shape as synth-corpus.mjs's Whitmore/Bell, so there is at least one
// deterministic instance of each regardless of how the bulk random spread
// happens to land.
{
  const expiring = findByKey('res_3'); // Phoenix, forced to Goodman, unregistered 5yr floor
  if (expiring) {
    const u = expiring.units[0];
    // Force install date so install+5y lands ~60 days from TODAY (2026-09-21).
    const forcedInstall = addDaysIso(TODAY, -5 * 365 + 60);
    u.installDate = forcedInstall;
    u.model = BRAND_MODEL.Goodman(3);
    u.brand = 'Goodman';
    const { stable, status } = warrantyFor({ manufacturer: 'Goodman', installDate: forcedInstall }, null);
    u.warrantyStatus = status;
    u.expires = stable.expires;
    expiring.expectedAlert = 'expiring';
  }
  const expired = findByKey('res_9'); // Mesa, forced to Trane, unregistered floor
  if (expired) {
    const u = expired.units[0];
    const forcedInstall = addDaysIso(TODAY, -8 * 365);
    u.installDate = forcedInstall;
    u.brand = 'Trane';
    u.model = BRAND_MODEL.Trane(3);
    const { stable, status } = warrantyFor({ manufacturer: 'Trane', installDate: forcedInstall }, null);
    u.warrantyStatus = status;
    u.expires = stable.expires;
    expired.expectedAlert = 'expired';
  }
}

/* ---- trap (f): shop-letterhead-only documents, no customer ------------- */
{
  docsWithoutCustomer.push(writeTxt('dispatch-note', 'shop-truck', [
    `Dispatch note - ${mdY('2026-08-03')}`, `Shop: ${SHOP.name}`, `Address: ${SHOP.address}`, '',
    'Truck #4 due for oil change and AC recharge. Take to the Baseline Rd shop bay before end of week.', '',
    'Tech: Kevin Pratt',
  ]));
  docsWithoutCustomer.push(writePdf('other', 'parts-count', shopMemoDoc({
    date: '2026-08-10', subject: 'Quarterly parts inventory count',
    body: 'Count all capacitors, filters, and refrigerant cylinders in the Baseline Rd warehouse by Friday.',
  })));
  docsWithoutCustomer.push(writeTxt('dispatch-note', 'shop-radio', [
    `Dispatch note - ${mdY('2026-05-14')}`, `Shop: ${SHOP.name}`, `Address: ${SHOP.address}`, '',
    'New dispatch radios arrived at the shop, hand out at Monday morning meeting.', '', 'Tech: Ray Sutton',
  ]));
  docsWithoutCustomer.push(writePdf('other', 'holiday-schedule', shopMemoDoc({
    date: '2026-11-01', subject: 'Holiday on-call schedule', body: 'On-call rotation for the holiday week posted on the shop board.',
  })));
}

/* ------------------------------------------------------------ totals --- */
function tally(list, keyFn) {
  const out = {};
  for (const item of list) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
const byState = tally(answerCustomers, (c) => c.state ?? 'Unknown');
const byCounty = tally(answerCustomers.filter((c) => c.state === 'AZ'), (c) => c.county ?? 'Unknown');
const byCity = tally(answerCustomers, (c) => c.city ?? 'Unknown');
const allUnits = answerCustomers.flatMap((c) => c.units);
const equipmentByBrand = tally(allUnits, (u) => u.brand);
const warrantyStatusCounts = tally(allUnits, (u) => u.warrantyStatus);
for (const k of ['active', 'expiring', 'expired', 'unknown']) if (!(k in warrantyStatusCounts)) warrantyStatusCounts[k] = 0;
const documentsByType = { ...typeUsage };
const totalDocs = filesWritten.length;
const totalUnits = allUnits.length;

/* ------------------------------------------------------------ questions */
const analyticsQuestions = [];
const lookupQuestions = [];

// ---- analytics (30): counts/lists/groupBy over the closed vocabulary -----
analyticsQuestions.push(
  { q: 'How many customers do we have in Arizona?', expectedContains: [String(byState.AZ), `${byState.AZ} customers`] },
  { q: 'How many customers do we have in Maricopa County?', expectedContains: [String(byCounty.Maricopa), `${byCounty.Maricopa} customers`] },
  { q: 'How many customers do we have in Pinal County?', expectedContains: [String(byCounty.Pinal), `${byCounty.Pinal} customers`] },
  { q: 'How many customers do we have in Pima County?', expectedContains: [String(byCounty.Pima), `${byCounty.Pima} customers`] },
  { q: 'How many customers do we have in Nevada?', expectedContains: [String(byState.NV || 0)] },
  { q: 'How many customers do we have in New Mexico?', expectedContains: [String(byState.NM || 0)] },
  { q: 'How many customers do we have in California?', expectedContains: [String(byState.CA || 0)] },
  { q: 'How many customers do we have in Yuma County?', expectedContains: ['0'] }, // ambiguity rule: 0 rows for a county that exists in AZ but has none of our customers
  { q: `List customers in Gilbert`, expectedContains: answerCustomers.filter((c) => c.city === 'Gilbert').slice(0, 3).map((c) => c.canonicalName) },
  { q: `List customers in Tucson`, expectedContains: answerCustomers.filter((c) => c.city === 'Tucson').slice(0, 3).map((c) => c.canonicalName) },
  { q: 'How many customers do we have in Chandler?', expectedContains: [String(byCity.Chandler)] },
  { q: 'How many customers do we have in Mesa?', expectedContains: [String(byCity.Mesa)] },
  { q: 'How many customers do we have in Casa Grande?', expectedContains: [String(byCity['Casa Grande'])] },
  { q: 'How many units are out of warranty?', expectedContains: [String(warrantyStatusCounts.expired), `${warrantyStatusCounts.expired} units`] },
  { q: 'How many units are still under warranty?', expectedContains: [String(warrantyStatusCounts.active)] },
  { q: 'How many units are expiring soon?', expectedContains: [String(warrantyStatusCounts.expiring)] },
  { q: 'How many units have an unknown warranty status?', expectedContains: [String(warrantyStatusCounts.unknown)] },
  { q: 'Which customers have Trane units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'Trane')).slice(0, 3).map((c) => c.canonicalName) },
  { q: 'Which customers have Goodman units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'Goodman')).slice(0, 3).map((c) => c.canonicalName) },
  { q: 'Which customers have York units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'York')).slice(0, 3).map((c) => c.canonicalName) },
  { q: 'How many customers have Mitsubishi units?', expectedContains: [String(answerCustomers.filter((c) => c.units.some((u) => u.brand === 'Mitsubishi')).length)] },
  { q: 'How many Goodman units are older than 10 years?', expectedContains: [String(allUnits.filter((u) => u.brand === 'Goodman' && Number(u.installDate.slice(0, 4)) <= 2016).length)] },
  { q: 'How many Trane units are older than 15 years?', expectedContains: [String(allUnits.filter((u) => u.brand === 'Trane' && Number(u.installDate.slice(0, 4)) <= 2011).length)] },
  { q: 'How many documents did we add this month?', expectedContains: [String(totalDocs)] },
  { q: 'How many customers do we have in total?', expectedContains: [String(answerCustomers.length)] },
  { q: 'How many units of equipment do we have on file?', expectedContains: [String(totalUnits)] },
  { q: 'Give me a breakdown of customers by county', expectedContains: [`Maricopa`, String(byCounty.Maricopa)] },
  { q: 'Group equipment by brand', expectedContains: ['Trane', String(equipmentByBrand.Trane)] },
  { q: 'How many customers do we have in Scottsdale?', expectedContains: [String(byCity.Scottsdale)] },
  { q: 'How many customers do we have in Oro Valley?', expectedContains: [String(byCity['Oro Valley'])] },
);

// ---- lookup (30): single-record fact lookups, fastPath/retrieval shape ---
const lookupSubjects = [
  findByKey('res_0'), findByKey('res_1'), findByKey('res_3'), findByKey('res_9'),
  findByKey('res_2'), findByKey('res_11'), findByKey('res_20'), findByKey('res_33'),
  ...apartmentKeys.slice(0, 2).map(findByKey),
  ...answerCustomers.filter((c) => c.key.startsWith('dental_')),
  ...answerCustomers.filter((c) => c.key.startsWith('school_')),
  ...answerCustomers.filter((c) => c.key.startsWith('church_')),
  ...answerCustomers.filter((c) => c.key.startsWith('restaurant_')),
  findByKey('res_44'), findByKey('res_66'), findByKey('res_77'), findByKey('res_88'),
].filter(Boolean);

for (const c of lookupSubjects.slice(0, 30)) {
  const u = c.units[0];
  if (c.units.length > 1) {
    lookupQuestions.push({ q: `What equipment is installed at ${c.canonicalName}?`, expectedContains: c.units.map((x) => x.serial) });
  } else {
    lookupQuestions.push({ q: `What's the serial number of the unit at ${c.address}?`, expectedContains: [u.serial] });
  }
}
// top up to exactly 30 with brand/model/warranty-style lookups if short
let li = 0;
while (lookupQuestions.length < 30 && li < answerCustomers.length) {
  const c = answerCustomers[li];
  li += 1;
  if (!c || !c.units.length) continue;
  lookupQuestions.push({ q: `Who makes the unit at ${c.address}?`, expectedContains: [c.units[0].brand] });
}
lookupQuestions.length = Math.min(lookupQuestions.length, 30);

const questions = [
  ...analyticsQuestions.slice(0, 30).map((q) => ({ ...q, type: 'analytics' })),
  ...lookupQuestions.slice(0, 30).map((q) => ({ ...q, type: 'lookup' })),
];

/* ------------------------------------------------------------ answer key */
const answerKey = {
  shopAddress: SHOP.address,
  shopPhone: SHOP.phone,
  shopEmail: SHOP.email,
  generatedAt: TODAY,
  customers: answerCustomers,
  mustNotMerge,
  docsWithoutCustomer,
  nameVariantCustomers,
  totals: {
    customers: answerCustomers.length,
    byState,
    byCounty,
    byCity,
  },
  equipmentByBrand,
  warrantyStatusCounts,
  documentsByType,
  totalDocuments: totalDocs,
  totalUnits,
  questions,
};
fs.writeFileSync(path.join(OUT_DIR, 'ANSWER_KEY.json'), JSON.stringify(answerKey, null, 2));

/* ----------------------------------------------------------------- report */
let totalBytes = 0;
for (const f of filesWritten) totalBytes += fs.statSync(path.join(OUT_DIR, f)).size;

console.log(`Generated ${filesWritten.length} documents for ${answerCustomers.length} customers in ${path.relative(ROOT, OUT_DIR)}/`);
console.log(`Total corpus size: ${(totalBytes / 1024).toFixed(1)} KB`);
console.log(`Document types used (${Object.keys(typeUsage).length}): ${Object.entries(typeUsage).map(([k, v]) => `${k}x${v}`).join(', ')}`);
console.log(`By state: ${JSON.stringify(byState)}`);
console.log(`By county (AZ only): ${JSON.stringify(byCounty)}`);
console.log(`Equipment by brand: ${JSON.stringify(equipmentByBrand)} (total units: ${totalUnits})`);
console.log(`Warranty status counts: ${JSON.stringify(warrantyStatusCounts)}`);
console.log(`mustNotMerge pairs: ${mustNotMerge.length}; nameVariant customers: ${nameVariantCustomers.length}; docsWithoutCustomer: ${docsWithoutCustomer.length}`);
console.log(`Questions: ${questions.length} (${analyticsQuestions.slice(0, 30).length} analytics, ${lookupQuestions.slice(0, 30).length} lookup)`);
console.log('Wrote', path.join(path.relative(ROOT, OUT_DIR), 'ANSWER_KEY.json'));
