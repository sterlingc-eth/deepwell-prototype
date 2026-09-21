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
 * Usage:
 *   node scripts/synth-business.mjs                                  (default: 120 customers, test-docs/business/ -- UNCHANGED shape/output from before --customers existed)
 *   node scripts/synth-business.mjs --customers 30 --out test-docs/business-small
 *     (a cheaper ~150-doc subset for testing: still 3 AZ counties, >=1
 *     out-of-state customer, all 8 brands, all 15 document types, mixed
 *     warranty tiers, a scaled-down apartment complex, one name-variant
 *     household, one near-miss surname pair, 2 letterhead-only docs, and a
 *     40-question (20 analytics + 20 lookup) answer key. Also switches
 *     correspondence docs to .txt instead of .pdf -- cheaper to extract,
 *     same content -- since "cheap testing" is the point of this mode; the
 *     default 120-customer run is untouched by this flag.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGeo, warrantyStatusOf } from '../api/_lib/analytics.js';
import { deriveWarranty, normalizeBrand } from '../api/_lib/warrantyRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TODAY = '2026-09-21';

// Bumped whenever a change deliberately alters what the DEFAULT (120-customer)
// output contains -- e.g. the 2026-09-21 fix that (a) caps every printed
// document date at TODAY and (b) starts printing customer phone/email. Stored
// in ANSWER_KEY.json so a stale key is easy to spot.
const CORPUS_VERSION = 2;

/* ------------------------------------------------------------------ CLI -- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    // A boolean flag (e.g. --contacts-topup) has no value of its own -- only
    // consume the next token as this flag's value when it isn't itself
    // another --flag (or absent, at the end of argv).
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
const cliArgs = parseArgs(process.argv.slice(2));
const CUSTOMER_COUNT = cliArgs.customers ? Math.max(4, Math.trunc(Number(cliArgs.customers))) : 120;
const IS_DEFAULT_SCALE = CUSTOMER_COUNT === 120 && !cliArgs.out;
// Cheap-forms only kicks in for a non-default (--customers) run, so the
// default 120-customer output is byte-for-byte unchanged from before this
// flag existed.
const CHEAP_FORMS = !IS_DEFAULT_SCALE;
const OUT_DIR = cliArgs.out ? path.resolve(ROOT, cliArgs.out) : path.join(ROOT, 'test-docs', 'business');

// --contacts-topup: writes ONLY new contact-proving invoices into
// `${OUT_DIR}-topup/`. It never touches OUT_DIR at all (no mkdir, no cleanup,
// no ANSWER_KEY.json write, and every writePdf/writeTxt call below becomes a
// no-op on disk) -- the whole generator still runs normally IN MEMORY so the
// exact same deterministic customer/unit/contact facts are available to build
// the topup invoices from. See the TOPUP_MODE block at the end of this file.
const TOPUP_MODE = Boolean(cliArgs['contacts-topup']);

// Whether this run shares its customer IDENTITY (names, addresses, units --
// everything a --contacts-topup invoice must agree with the base corpus on)
// with the already-uploaded 30-customer/144-file corpus at
// test-docs/business-small. True for BOTH the frozen base run and its
// --contacts-topup run, since the topup writes new documents FOR THOSE SAME
// customers and must never invent a different name for one of them.
const IS_SMALL_BASE_IDENTITY = CUSTOMER_COUNT === 30 && OUT_DIR === path.join(ROOT, 'test-docs', 'business-small');
// The already-uploaded 144 files themselves must not change text on disk
// except where the 2026-09-21 date fix (a) forces it -- printing customer
// phone/email into those same 144 files would mean re-ingesting them at cost
// for no reason (the --contacts-topup mode exists specifically so contact
// extraction can be proven via NEW documents instead). So contact info is
// always COMPUTED and stored in the answer key (both corpora), but only
// PRINTED into documents when this is not that exact, already-shipped
// combination -- topup invoices are new documents, so they DO print it.
const IS_FROZEN_SMALL_BASE = IS_SMALL_BASE_IDENTITY && !TOPUP_MODE;
const PRINT_CONTACTS = !IS_FROZEN_SMALL_BASE;

if (CUSTOMER_COUNT < 15) {
  console.warn(`--customers ${CUSTOMER_COUNT} is small enough that full document-type/brand coverage cannot be guaranteed (need at least ~15). Proceeding anyway.`);
}

if (!TOPUP_MODE) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Clean any previous run's generated docs + answer key, but leave a built
  // bundle.json/bundle-manifest.json (scripts/build-bundle.mjs's output) alone
  // -- re-running this generator (e.g. from verify-business-corpus.mjs) should
  // not silently delete a bundle someone already built from the prior run.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^bundle(\.\d+)?\.json$/.test(f) || f === 'bundle-manifest.json') continue;
    fs.rmSync(path.join(OUT_DIR, f), { force: true });
  }
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
// ISO YYYY-MM-DD strings compare correctly with plain `>` (zero-padded, fixed
// width), so this is a real "is this in the future" clamp, not a string hack.
// Applied to every date that ends up PRINTED on a document (service/invoice/
// work-order/memo/dispatch dates); install dates go through this too since a
// unit cannot have been installed after today.
function capToday(iso) {
  return iso > TODAY ? TODAY : iso;
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
  // TOPUP_MODE runs this whole generator only to recompute the same
  // deterministic customer/unit facts in memory -- it must never write (or
  // overwrite) anything under OUT_DIR itself.
  if (!TOPUP_MODE) fs.writeFileSync(path.join(OUT_DIR, name), buildPdf(lines));
  filesWritten.push(name);
  return name;
}
function writeTxt(type, slug, lines) {
  const name = nextName(type, slug, 'txt');
  if (!TOPUP_MODE) fs.writeFileSync(path.join(OUT_DIR, name), lines.join('\n') + '\n', 'utf8');
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
function warrantyRegDoc({ nameVariant, address, email, unit, registeredDate, term, expires }) {
  const lines = [...LETTERHEAD, '', 'WARRANTY REGISTRATION', `Customer: ${nameVariant}`, `Service Address: ${address}`];
  if (email) lines.push(`Homeowner email: ${email}`);
  lines.push('', `Manufacturer: ${unit.manufacturer}`, `Model: ${unit.model}`, `Serial: ${unit.serial}`,
    `Tonnage: ${unit.tonnage}`, `Refrigerant: ${unit.refrigerant}`, '',
    `Installation Date: ${mdY(unit.installDate)}`, `Registered on file: ${mdY(registeredDate)}`,
    `Warranty Term: ${term}`, expires ? `Valid through: ${mdY(expires)}` : 'Valid through: per manufacturer terms');
  return lines;
}
function startupSheetDoc({ nameVariant, address, unit, tech }) {
  return [...LETTERHEAD, '', 'STARTUP / COMMISSIONING SHEET', `Customer: ${nameVariant}`, `Service Address: ${address}`, '',
    `Equipment: ${unit.manufacturer} ${unit.model}`, `Serial: ${unit.serial}`, `Tonnage: ${unit.tonnage}`,
    `Refrigerant charge: ${unit.refrigerant}`, `Installation Date: ${mdY(unit.installDate)}`, '',
    'Startup readings recorded, system operating normally.',
    `Technician: ${tech}`, `Service Date: ${mdY(unit.installDate)}`];
}
function serviceTicketDoc({ nameVariant, address, phone, date, tech, unit, items, notes, serviceType = 'Repair' }) {
  const lines = [...LETTERHEAD, '', 'SERVICE TICKET', `Date of Service: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`];
  if (phone) lines.push(`Customer phone: ${phone}`);
  lines.push('', `Equipment: ${unit.manufacturer} ${unit.model}  Serial: ${unit.serial}`,
    `Visit Type: ${serviceType}`, '', 'Work Performed:');
  for (const it of items) lines.push(`- ${it}`);
  lines.push('', `Notes: ${notes}`, `Technician: ${tech}`, 'Status: Completed');
  return lines;
}
function workOrderDoc({ nameVariant, address, phone, date, task, tech, status = 'Completed', woNo }) {
  const lines = [...LETTERHEAD, '', 'WORK ORDER', `Work Order #: ${woNo}`, `Date: ${mdY(date)}`, `Customer: ${nameVariant}`,
    `Service Address: ${address}`];
  if (phone) lines.push(`Customer phone: ${phone}`);
  lines.push('', `Task: ${task}`, `Assigned Technician: ${tech}`, `Status: ${status}`);
  return lines;
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
function correspondenceDoc({ nameVariant, address, phone, email, date, body }) {
  const lines = [...LETTERHEAD, '', mdY(date), '', `Dear ${nameVariant},`, '', body, '', 'Sincerely,', 'Sonoran Comfort Air'];
  if (email) lines.splice(4, 0, `Email on file: ${email}`);
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
const FULL_CITIES = [
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

/**
 * A reduced, representative city plan for `--customers N` (N != 120): one
 * city per AZ county -- Mesa/Maricopa, Casa Grande/Pinal, Tucson/Pima --
 * guaranteeing all 3 counties every time, plus one out-of-state city (Las
 * Vegas, NV). Reuses the EXACT SAME zips as the matching entries in
 * FULL_CITIES, so geo derivation resolves identically to the full corpus.
 * No commercial (dental/restaurant/church/school) customers at this scale --
 * not one of the required capabilities for the small subset, and every
 * document type is already reachable through the residential rotation alone
 * (see EXTRA_TYPE_POOL below) once there are enough residential customers.
 */
function smallCityPlan(n) {
  const outOfState = 1;
  const minResidentialForFullTypeCoverage = 11; // == EXTRA_TYPE_POOL.length below
  const apartmentUnits = n >= 60 ? 8 : Math.min(4, Math.max(0, n - outOfState - minResidentialForFullTypeCoverage));
  const residential = Math.max(0, n - outOfState - apartmentUnits);
  if (residential < minResidentialForFullTypeCoverage) {
    console.warn(`--customers ${n}: only ${residential} residential customers after reserving the apartment ` +
      `complex/out-of-state slots -- fewer than the ${minResidentialForFullTypeCoverage} needed to guarantee ` +
      'every document type appears. Consider a larger --customers value.');
  }
  const per = Math.floor(residential / 3);
  const rem = residential - per * 3;
  return {
    apartmentUnits,
    cities: [
      { name: 'Mesa', state: 'AZ', zip: '85201', residential: per + (rem > 0 ? 1 : 0), apartmentUnits },
      { name: 'Casa Grande', state: 'AZ', zip: '85122', residential: per + (rem > 1 ? 1 : 0) },
      { name: 'Tucson', state: 'AZ', zip: '85701', residential: per },
      { name: 'Las Vegas', state: 'NV', zip: '89101', residential: outOfState },
    ],
  };
}
const SMALL_PLAN = IS_DEFAULT_SCALE ? null : smallCityPlan(CUSTOMER_COUNT);
const CITIES = IS_DEFAULT_SCALE ? FULL_CITIES : SMALL_PLAN.cities;
const APARTMENT_UNIT_COUNT = IS_DEFAULT_SCALE ? 8 : SMALL_PLAN.apartmentUnits;
// Full scale: 2 mustNotMerge pairs, 3 name-variant households, 4 letterhead-
// only docs. Small scale: 1 of each (or 1/1/2 per the brief's small-subset
// requirements).
const WANT_MERGE_PAIRS = IS_DEFAULT_SCALE ? 2 : 1;
const WANT_NAME_VARIANTS = IS_DEFAULT_SCALE ? 3 : 1;
const WANT_SHOP_ONLY_DOCS = IS_DEFAULT_SCALE ? 4 : 2;
const WANT_QUESTIONS_PER_TYPE = IS_DEFAULT_SCALE ? 30 : 20;

/* ---- trap (c): near-miss surname pairs, resolved BEFORE any document is
 * rendered -------------------------------------------------------------- *
 * A previous version left residential customers' real names in place while
 * building their documents, then overwrote just the ANSWER_KEY.json
 * canonicalName afterwards to a deliberately near-miss surname pair (e.g.
 * "Sorensen"/"Sorenson") to exercise dedup. That was the same class of bug as
 * the earlier brand mismatch: the documents had already been written with
 * the customer's REAL name (e.g. "Donna Thornton"), so the key described a
 * name no document actually printed. Fixed by resolving which residential
 * index gets which forced surname HERE, before buildResidential runs, and
 * having nameFor() apply it -- so the forced surname is what actually gets
 * typed onto every one of that customer's documents, and the key can never
 * describe anything other than what was printed.
 *
 * residentialTotal is computed statically from CITIES (every entry's
 * `residential` count is a literal, known before any building happens) so
 * the index clamping below doesn't need to wait for the build loop to run.
 */
const residentialTotal = CITIES.reduce((sum, c) => sum + (c.residential ?? 0), 0);
function clampIdx(want) { return Math.min(want, Math.max(0, residentialTotal - 1)); }
// The small base's 144 files are already generated and must not change text
// -- so its real, un-trapped names (whatever nameFor() naturally produced)
// are left alone, and mustNotMerge is correctly left empty for that corpus
// rather than describing a pair the documents don't contain. Gated on
// IS_SMALL_BASE_IDENTITY (not IS_FROZEN_SMALL_BASE) so a --contacts-topup run
// -- which recomputes the SAME customers in memory to write new documents FOR
// THEM -- agrees on every name with the base run it's topping up, instead of
// independently re-rolling the near-miss trap and inventing a different name
// for res_2/res_11 than the base corpus's real documents already printed.
const APPLY_NAME_TRAPS = !IS_SMALL_BASE_IDENTITY;
const NEAR_MISS_PAIRS = (APPLY_NAME_TRAPS ? [
  { idxA: 2, idxB: 11, nameA: 'Sorensen', nameB: 'Sorenson' }, // Phoenix / Mesa
  { idxA: 20, idxB: 33, nameA: 'Whitfield', nameB: 'Whitford' }, // Gilbert / Tempe
] : []).slice(0, WANT_MERGE_PAIRS).map((p) => ({ ...p, idxA: clampIdx(p.idxA), idxB: clampIdx(p.idxB) }))
  .filter((p) => p.idxA !== p.idxB);
const NEAR_MISS_SURNAME_BY_IDX = new Map();
for (const p of NEAR_MISS_PAIRS) { NEAR_MISS_SURNAME_BY_IDX.set(p.idxA, p.nameA); NEAR_MISS_SURNAME_BY_IDX.set(p.idxB, p.nameB); }

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
  // 2026 x (month, day) can land after TODAY (2026-09-21) -- a unit cannot
  // have been installed in the future, so clamp it (per the brief: "install
  // dates unchanged unless > today").
  return capToday(ymd(year, month, day));
}

/* -------------------------------------------------------------- contacts
 * ~80% of customers get a phone on file, ~50% an email -- independently, and
 * never printed for the frozen small-corpus base (see PRINT_CONTACTS above).
 * Deterministic off the same `i` used for everything else about that
 * customer, so a re-run is byte-identical.
 */
const AREA_BY_STATE = { AZ: '480', NV: '702', NM: '505', CA: '213' };
const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com', 'aol.com', 'hotmail.com', 'comcast.net'];
function phoneVariant(i, area, last4) {
  const forms = [
    `(${area}) 555-${last4}`,
    `${area}-555-${last4}`,
    `Ph: ${area}.555.${last4}`,
    `Cell: ${area}-555-${last4}`,
  ];
  return forms[i % forms.length];
}
function contactFor(i, city, name) {
  const hasPhone = (i * 37) % 100 < 80;
  const hasEmail = (i * 53) % 100 < 50;
  const area = AREA_BY_STATE[city.state] || '480';
  // Always "01xx" so it can never collide with the shop's own "555-0199".
  const last4 = `01${String(10 + (i % 88)).padStart(2, '0')}`;
  const phone = hasPhone ? phoneVariant(i, area, last4) : null;
  let email = null;
  if (hasEmail) {
    const domain = EMAIL_DOMAINS[i % EMAIL_DOMAINS.length];
    const sep = i % 2 === 0 ? '.' : '';
    email = `${name.first.toLowerCase()}${sep}${name.last.toLowerCase()}${i % 5}@${domain}`.toLowerCase();
  }
  return { phone, email };
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
  // Near-miss surname trap (resolved above, before any document is built):
  // this index's surname is forced to a deliberately near-miss spelling, so
  // it's baked into `full` BEFORE buildResidential renders this customer's
  // first document -- never patched onto the key afterwards.
  if (NEAR_MISS_SURNAME_BY_IDX.has(i)) {
    const forcedLast = NEAR_MISS_SURNAME_BY_IDX.get(i);
    const forcedFull = `${FIRST_NAMES[fi]} ${forcedLast}`;
    usedNames.add(forcedFull);
    return { first: FIRST_NAMES[fi], last: forcedLast, full: forcedFull };
  }
  return { first: FIRST_NAMES[fi], last: LAST_NAMES[li], full: name };
}

// Kept at 11 entries -- smallCityPlan's minResidentialForFullTypeCoverage
// above assumes this length.
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
  if (registered) unit.registeredDate = capToday(addDaysIso(installDate, 15 + (i % 20)));

  const { phone, email } = contactFor(i, city, name);
  const printPhone = PRINT_CONTACTS ? phone : null;
  const printEmail = PRINT_CONTACTS ? email : null;

  const docs = [];
  docs.push(writePdf('invoice', `c${i}`, invoiceDoc({
    nameVariant: name.full, address, phone: printPhone, email: printEmail, invoiceNo, date: installDate,
    cost: (2800 + (i * 137) % 5200).toFixed(2), workDesc: `Install ${unit.tonnage} ${brand} system, ${unit.refrigerant} charge`,
    tech, unit,
  })));

  if (registered) {
    docs.push(writePdf('warranty-registration', `c${i}`, warrantyRegDoc({
      nameVariant: name.full, address, email: printEmail, unit, registeredDate: unit.registeredDate,
      term: normalizeBrand(brand) ? '5-10 year parts (per manufacturer terms)' : 'not verified',
      expires: null,
    })));
  } else {
    docs.push(writePdf('proposal-quote', `c${i}`, proposalQuoteDoc({
      nameVariant: name.full, address, date: capToday(addDaysIso(installDate, 400 + (i % 300))),
      desc: 'Annual maintenance agreement enrollment', cost: (280 + (i % 6) * 25).toFixed(2),
    })));
  }

  const serviceDate = capToday(addDaysIso(installDate, 500 + ((i * 13) % 1600)));
  docs.push(writePdf('service-ticket', `c${i}`, serviceTicketDoc({
    nameVariant: name.full, address, phone: printPhone, date: serviceDate, tech: TECHS[(i + 2) % TECHS.length], unit,
    serviceType: i % 3 === 0 ? 'Preventive Maintenance' : 'Repair',
    items: i % 3 === 0 ? ['Annual PM: cleaned coil, checked charge'] : ['Checked refrigerant charge', 'Replaced air filter'],
    notes: 'System operating normally after visit',
  })));

  const extraType1 = EXTRA_TYPE_POOL[i % EXTRA_TYPE_POOL.length];
  docs.push(buildExtraDoc(extraType1, { i, name, address, city, unit, tech, phone: printPhone, email: printEmail }));
  const extraType2 = EXTRA_TYPE_POOL[(i + 5) % EXTRA_TYPE_POOL.length];
  docs.push(buildExtraDoc(extraType2, { i, name, address, city, unit, tech, phone: printPhone, email: printEmail }));

  addCustomer({ key: `res_${i}`, canonicalName: name.full, address, phone, email, units: [unit], docFilenames: docs });
}

function buildExtraDoc(type, { i, name, address, city, unit, tech, phone = null, email = null }) {
  switch (type) {
    case 'work-order':
      return writePdf('work-order', `c${i}`, workOrderDoc({
        nameVariant: name.full, address, phone, date: capToday(addDaysIso(unit.installDate, 600 + (i % 400))),
        woNo: `WO-${40000 + i}`, task: 'No cooling, dispatch for diagnosis', tech,
      }));
    case 'permit':
      return writePdf('permit', `p${i}`, permitDoc({
        city: city.name, stateName: STATE_NAMES[city.state], permitNumber: `BP-2026-${10000 + i}`,
        address, workDesc: 'Residential AC change-out',
      }));
    case 'inspection-report':
      return writePdf('inspection-report', `c${i}`, inspectionReportDoc({
        nameVariant: name.full, address, date: capToday(addDaysIso(unit.installDate, 900 + (i % 500))), tech,
        findings: ['Coil clean, no leaks found', 'Refrigerant charge within spec'],
      }));
    case 'correspondence': {
      // Cheap-forms mode (--customers, any non-default scale) writes this as
      // .txt instead of .pdf -- same content, cheaper to extract, and the
      // default 120-customer run is untouched (CHEAP_FORMS is false there).
      const writer = CHEAP_FORMS ? writeTxt : writePdf;
      return writer('correspondence', `c${i}`, correspondenceDoc({
        nameVariant: name.full, address, phone, email, date: capToday(addDaysIso(unit.installDate, 700 + (i % 300))),
        body: 'Thank you for your business. Let us know if the system needs anything further.',
      }));
    }
    case 'purchase-order':
      return writePdf('purchase-order', `c${i}`, purchaseOrderDoc({
        poNumber: `PO-${9000 + i}`, date: capToday(addDaysIso(unit.installDate, 650 + (i % 300))),
        vendor: i % 2 === 0 ? 'Baker Distributing' : 'Watsco Supply', address, nameVariant: name.full,
        parts: ['Capacitor', 'Filter drier'], cost: (60 + (i % 10) * 8).toFixed(2),
      }));
    case 'startup-sheet':
      return writePdf('startup-sheet', `c${i}`, startupSheetDoc({ nameVariant: name.full, address, unit, tech }));
    case 'dispatch-note':
      return writeTxt('dispatch-note', `c${i}`, dispatchNoteDoc({
        nameVariant: name.full, address, date: capToday(addDaysIso(unit.installDate, 550 + (i % 300))),
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
        date: capToday(addDaysIso(unit.installDate, 800)), subject: 'Filter stock check',
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
  const contactName = nameFor(i);
  const contact = contactName.full;
  const { phone, email } = contactFor(i, city, contactName);
  const printPhone = PRINT_CONTACTS ? phone : null;
  const printEmail = PRINT_CONTACTS ? email : null;
  const unitCount = COMMERCIAL_UNITS[type];
  const installDate = installDateFor(i);
  const units = [];
  for (let u = 0; u < unitCount; u++) {
    const brand = BRANDS[(i + u) % BRANDS.length];
    units.push(makeUnit({ i: i + u, brand, installDate: capToday(addDaysIso(installDate, u * 3)), equipmentId: `RTU-${u + 1}` }));
  }

  const docs = [];
  docs.push(writePdf('maintenance-agreement', `${type}${commercialSeq}`, maintenanceAgreementDoc({
    nameVariant: label, address, contact, term: '01/01/2025 - 12/31/2027', cost: (1200 + unitCount * 250).toFixed(2), units,
  })));
  docs.push(writePdf('invoice', `${type}${commercialSeq}`, invoiceDoc({
    nameVariant: label, address, phone: printPhone, email: printEmail, invoiceNo: `INV-${30000 + i}`, date: capToday(addDaysIso(installDate, 400)),
    cost: (600 + unitCount * 120).toFixed(2),
    workDesc: `${units[0].equipmentId} (Serial ${units[0].serial}) filter change and capacitor check`,
    tech: TECHS[commercialSeq % TECHS.length], unit: units[0],
  })));
  docs.push(writePdf('service-ticket', `${type}${commercialSeq}`, serviceTicketDoc({
    nameVariant: label, address, phone: printPhone, date: capToday(addDaysIso(installDate, 900)), tech: TECHS[(commercialSeq + 1) % TECHS.length],
    unit: units[units.length - 1], serviceType: 'Repair',
    items: [`Diagnosed ${units[units.length - 1].equipmentId} compressor issue, recommended service`],
    notes: 'Customer approved follow-up repair',
  })));
  docs.push(writePdf('work-order', `${type}${commercialSeq}`, workOrderDoc({
    nameVariant: label, address, phone: printPhone, date: capToday(addDaysIso(installDate, 905)), woNo: `WO-${50000 + i}`,
    task: `Service ${units[units.length - 1].equipmentId}`, tech: TECHS[(commercialSeq + 1) % TECHS.length],
  })));
  docs.push(writePdf('proposal-quote', `${type}${commercialSeq}`, proposalQuoteDoc({
    nameVariant: label, address, date: capToday(addDaysIso(installDate, 890)),
    desc: `Replace aging rooftop unit (${units[units.length - 1].equipmentId})`, cost: (7500 + unitCount * 400).toFixed(2),
  })));
  docs.push(writePdf('permit', `${type}${commercialSeq}`, permitDoc({
    city: city.name, stateName: STATE_NAMES[city.state], permitNumber: `BP-2026-${20000 + i}`,
    address, workDesc: 'Commercial RTU change-out',
  })));
  docs.push(writePdf('startup-sheet', `${type}${commercialSeq}`, startupSheetDoc({
    nameVariant: label, address, unit: units[0], tech: TECHS[commercialSeq % TECHS.length],
  })));

  addCustomer({ key: `${type}_${commercialSeq}`, canonicalName: label, address, phone, email, units, docFilenames: docs });
  return label;
}

/* ---- apartment complex (trap b, scaled): unitCount units, one address --- */
function buildApartmentComplex(city, unitCount = 8) {
  const streetNo = 3300;
  const street = 'S Alma School Rd';
  const created = [];
  for (let u = 1; u <= unitCount; u++) {
    const i = 6000 + u;
    const name = nameFor(i);
    const address = `${streetNo} ${street}, Apt ${100 + u}, ${city.name}, ${city.state} ${city.zip}`;
    const brand = BRANDS[u % BRANDS.length];
    const installDate = installDateFor(i);
    const unit = makeUnit({ i, brand, installDate, equipmentId: 'Unit 1' });
    if (u % 2 === 0) unit.registeredDate = capToday(addDaysIso(installDate, 18));
    const tech = TECHS[u % TECHS.length];
    const { phone, email } = contactFor(i, city, name);
    const printPhone = PRINT_CONTACTS ? phone : null;
    const docs = [];
    docs.push(writePdf('invoice', `apt${u}`, invoiceDoc({
      nameVariant: name.full, address, phone: printPhone, email: PRINT_CONTACTS ? email : null,
      invoiceNo: `INV-${60000 + u}`, date: installDate,
      cost: (3200 + u * 90).toFixed(2), workDesc: `Install ${unit.tonnage} ${brand} condenser`, tech, unit,
    })));
    docs.push(writePdf('service-ticket', `apt${u}`, serviceTicketDoc({
      nameVariant: name.full, address, phone: printPhone, date: capToday(addDaysIso(installDate, 700 + u * 20)), tech,
      unit, items: ['Checked refrigerant charge', 'Replaced air filter'], notes: 'Airflow restored',
    })));
    if (u % 2 === 0) {
      docs.push(writeTxt('dispatch-note', `apt${u}`, dispatchNoteDoc({
        nameVariant: name.full, address, date: capToday(addDaysIso(installDate, 750 + u * 20)),
        note: 'Tenant reports no cold air, unit running constantly. Send tech today.', tech,
      })));
    } else {
      docs.push(writePdf('work-order', `apt${u}`, workOrderDoc({
        nameVariant: name.full, address, phone: printPhone, date: capToday(addDaysIso(installDate, 750 + u * 20)),
        woNo: `WO-${60000 + u}`, task: 'No cooling, dispatch for diagnosis', tech,
      })));
    }
    addCustomer({ key: `apt_${u}`, canonicalName: name.full, address, phone, email, units: [unit], docFilenames: docs });
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
const apartmentKeys = buildApartmentComplex(cityByName.Mesa, APARTMENT_UNIT_COUNT);
// residentialTotal/clampIdx/NEAR_MISS_PAIRS were resolved BEFORE the build
// loop above (see the comment near their definitions) precisely so nameFor()
// could bake the forced near-miss surname into each customer's documents as
// they were written, instead of patching the key afterwards. All that's left
// now is to record the (already-correct) mustNotMerge pairs.
function findByKey(key) { return answerCustomers.find((c) => c.key === key); }
for (const p of NEAR_MISS_PAIRS) {
  const a = findByKey(`res_${p.idxA}`);
  const b = findByKey(`res_${p.idxB}`);
  if (a && b && a.key !== b.key) mustNotMerge.push([a.key, b.key]);
}

/* ---- trap (a): household written 3 ways, must resolve to ONE customer --
 * (documented here; the underlying documents already carry the customer's
 * legal name consistently on every template, matching how synth-corpus.mjs's
 * Nguyen trap varies the "nameVariant" string per document type, not the
 * canonicalName stored in the answer key.) Full scale flags three; a
 * --customers subset flags WANT_NAME_VARIANTS of them (deduped/clamped the
 * same way as the near-miss pairs above). */
const nameVariantCustomers = [...new Set([5, 40, 55].slice(0, WANT_NAME_VARIANTS).map((idx) => `res_${clampIdx(idx)}`))]
  .filter((k) => findByKey(k));

/* ---- trap (i): flag one "expiring" and one "expired" case for lookup
 * questions, WITHOUT ever touching brand/model/installDate --------------- *
 * A previous version forced a specific brand/model/installDate onto
 * res_3/res_9's KEY entry to guarantee an "expiring within 90 days" and an
 * "already expired" example, exactly like synth-corpus.mjs's Whitmore/Bell.
 * That was wrong: buildResidential() had ALREADY written that customer's
 * actual PDFs (with their real, un-forced brand/model/installDate) before
 * this block ran, so it silently forked the key away from what the
 * documents actually print (e.g. res_3's docs print "Lennox ML14XC1-046-230"
 * dated 2012, while the key claimed "Goodman GSX163261FB" dated 2021 -- same
 * serial, since that field was untouched, which is what made the mismatch
 * visible). The documents are what actually gets ingested and extracted, so
 * they are the source of truth; the key must describe THEM, never a fact
 * invented after the fact. Fixed by never mutating a unit's facts here --
 * only find whichever customer the NORMAL brand/date spread already made
 * "expiring" or "expired" (every run has some, per the natural
 * install-year/registration mix) and flag `expectedAlert` on it, purely as
 * metadata for the trap-summary log below. */
{
  const firstWithStatus = (status) => answerCustomers.find((c) => c.key.startsWith('res_') && c.units.some((u) => u.warrantyStatus === status));
  const expiring = firstWithStatus('expiring');
  if (expiring) expiring.expectedAlert = 'expiring';
  const expired = firstWithStatus('expired');
  if (expired) expired.expectedAlert = 'expired';
}

/* ---- trap (f): shop-letterhead-only documents, no customer ------------- */
// Full scale writes all 4; a --customers subset writes the first
// WANT_SHOP_ONLY_DOCS (2, per the brief) of the same set.
{
  const shopOnlyWriters = [
    () => writeTxt('dispatch-note', 'shop-truck', [
      `Dispatch note - ${mdY('2026-08-03')}`, `Shop: ${SHOP.name}`, `Address: ${SHOP.address}`, '',
      'Truck #4 due for oil change and AC recharge. Take to the Baseline Rd shop bay before end of week.', '',
      'Tech: Kevin Pratt',
    ]),
    () => writePdf('other', 'parts-count', shopMemoDoc({
      date: '2026-08-10', subject: 'Quarterly parts inventory count',
      body: 'Count all capacitors, filters, and refrigerant cylinders in the Baseline Rd warehouse by Friday.',
    })),
    () => writeTxt('dispatch-note', 'shop-radio', [
      `Dispatch note - ${mdY('2026-05-14')}`, `Shop: ${SHOP.name}`, `Address: ${SHOP.address}`, '',
      'New dispatch radios arrived at the shop, hand out at Monday morning meeting.', '', 'Tech: Ray Sutton',
    ]),
    () => writePdf('other', 'holiday-schedule', shopMemoDoc({
      date: '2026-09-10', subject: 'Holiday on-call schedule', body: 'On-call rotation for the holiday week posted on the shop board.',
    })),
  ];
  for (const write of shopOnlyWriters.slice(0, WANT_SHOP_ONLY_DOCS)) docsWithoutCustomer.push(write());
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

// ---- analytics: counts/lists/groupBy over the closed vocabulary ----------
// Full scale (120 customers, all 19 cities) keeps the exact original 30
// questions unchanged. A --customers subset only has Mesa/Casa Grande/Tucson
// + Las Vegas (see smallCityPlan above), so it gets its own city-safe list
// instead of one that would reference a city (Gilbert, Chandler, Scottsdale,
// Oro Valley) that doesn't exist at that scale -- everything else (state,
// the 3 AZ counties, all 8 brands, warranty status, document/customer/unit
// totals) is guaranteed present at either scale by construction.
if (IS_DEFAULT_SCALE) {
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
} else {
  analyticsQuestions.push(
    { q: 'How many customers do we have in Arizona?', expectedContains: [String(byState.AZ), `${byState.AZ} customers`] },
    { q: 'How many customers do we have in Maricopa County?', expectedContains: [String(byCounty.Maricopa), `${byCounty.Maricopa} customers`] },
    { q: 'How many customers do we have in Pinal County?', expectedContains: [String(byCounty.Pinal), `${byCounty.Pinal} customers`] },
    { q: 'How many customers do we have in Pima County?', expectedContains: [String(byCounty.Pima), `${byCounty.Pima} customers`] },
    { q: 'How many customers do we have in Nevada?', expectedContains: [String(byState.NV || 0)] },
    { q: 'How many customers do we have in Yuma County?', expectedContains: ['0'] }, // ambiguity rule
    { q: 'List customers in Tucson', expectedContains: answerCustomers.filter((c) => c.city === 'Tucson').slice(0, 3).map((c) => c.canonicalName) },
    { q: 'List customers in Mesa', expectedContains: answerCustomers.filter((c) => c.city === 'Mesa').slice(0, 3).map((c) => c.canonicalName) },
    { q: 'How many customers do we have in Mesa?', expectedContains: [String(byCity.Mesa)] },
    { q: 'How many customers do we have in Casa Grande?', expectedContains: [String(byCity['Casa Grande'])] },
    { q: 'How many units are out of warranty?', expectedContains: [String(warrantyStatusCounts.expired)] },
    { q: 'How many units are still under warranty?', expectedContains: [String(warrantyStatusCounts.active)] },
    { q: 'How many units are expiring soon?', expectedContains: [String(warrantyStatusCounts.expiring)] },
    { q: 'How many units have an unknown warranty status?', expectedContains: [String(warrantyStatusCounts.unknown)] },
    { q: 'Which customers have Trane units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'Trane')).slice(0, 3).map((c) => c.canonicalName) },
    { q: 'Which customers have Goodman units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'Goodman')).slice(0, 3).map((c) => c.canonicalName) },
    { q: 'Which customers have York units?', expectedContains: answerCustomers.filter((c) => c.units.some((u) => u.brand === 'York')).slice(0, 3).map((c) => c.canonicalName) },
    { q: 'How many documents did we add this month?', expectedContains: [String(totalDocs)] },
    { q: 'How many customers do we have in total?', expectedContains: [String(answerCustomers.length)] },
    { q: 'Group equipment by brand', expectedContains: ['Trane', String(equipmentByBrand.Trane)] },
  );
}

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

for (const c of lookupSubjects.slice(0, WANT_QUESTIONS_PER_TYPE)) {
  const u = c.units[0];
  if (c.units.length > 1) {
    lookupQuestions.push({ q: `What equipment is installed at ${c.canonicalName}?`, expectedContains: c.units.map((x) => x.serial) });
  } else {
    lookupQuestions.push({ q: `What's the serial number of the unit at ${c.address}?`, expectedContains: [u.serial] });
  }
}
// top up to exactly WANT_QUESTIONS_PER_TYPE with brand/model-style lookups if short
let li = 0;
while (lookupQuestions.length < WANT_QUESTIONS_PER_TYPE && li < answerCustomers.length) {
  const c = answerCustomers[li];
  li += 1;
  if (!c || !c.units.length) continue;
  lookupQuestions.push({ q: `Who makes the unit at ${c.address}?`, expectedContains: [c.units[0].brand] });
}
lookupQuestions.length = Math.min(lookupQuestions.length, WANT_QUESTIONS_PER_TYPE);

// ---- contact questions (2026-09-21 fix): 3 phone + 3 email lookups (6 total,
// per key) plus 1 analytics question, appended AFTER the normal slice above so
// they add to the question count rather than displacing an existing question.
// Recorded on both corpora's keys regardless of PRINT_CONTACTS -- the small
// corpus's base documents don't print these values, but the --contacts-topup
// invoices do, so these become answerable once the topup is ingested too.
const customersWithPhone = answerCustomers.filter((c) => c.phone);
const customersWithEmail = answerCustomers.filter((c) => c.email);
const contactLookups = [
  ...customersWithPhone.slice(0, 3).map((c) => ({ q: `What's the phone number on file for ${c.canonicalName}?`, expectedContains: [c.phone] })),
  ...customersWithEmail.slice(0, 3).map((c) => ({ q: `What's the email for ${c.canonicalName}?`, expectedContains: [c.email] })),
];
const contactAnalytics = [
  { q: 'How many customers have an email on file?', expectedContains: [String(customersWithEmail.length)] },
];

const questions = [
  ...analyticsQuestions.slice(0, WANT_QUESTIONS_PER_TYPE).map((q) => ({ ...q, type: 'analytics' })),
  ...contactAnalytics.map((q) => ({ ...q, type: 'analytics' })),
  ...lookupQuestions.slice(0, WANT_QUESTIONS_PER_TYPE).map((q) => ({ ...q, type: 'lookup' })),
  ...contactLookups.map((q) => ({ ...q, type: 'lookup' })),
];

/* ------------------------------------------------------------ answer key */
const answerKey = {
  corpusVersion: CORPUS_VERSION,
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

/* ============================================================ TOPUP MODE ==
 * --contacts-topup: everything above ran purely in memory (writePdf/writeTxt
 * were no-ops on disk, OUT_DIR was never created/cleaned/written). Now write
 * ONLY new, distinctly-numbered invoices -- one per customer who has a phone
 * or email on file -- into `${OUT_DIR}-topup/`, plus a TOPUP_KEY.json. This
 * never touches OUT_DIR itself.
 * ========================================================================= */
if (TOPUP_MODE) {
  const TOPUP_DIR = `${OUT_DIR}-topup`;
  fs.mkdirSync(TOPUP_DIR, { recursive: true });
  for (const f of fs.readdirSync(TOPUP_DIR)) fs.rmSync(path.join(TOPUP_DIR, f), { force: true });

  const topupCustomers = answerCustomers.filter((c) => c.phone || c.email);
  const topupEntries = [];
  let topupSeq = 200; // filenames start at 201, per the brief's own example
  for (const c of topupCustomers) {
    topupSeq += 1;
    const u = c.units[0];
    const slug = c.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const name = `${topupSeq}-invoice-topup-${slug}.pdf`;
    const date = capToday(addDaysIso(TODAY, -(topupSeq % 30)));
    const lines = invoiceDoc({
      nameVariant: c.canonicalName, address: c.address, phone: c.phone, email: c.email,
      invoiceNo: `INV-T${topupSeq}`, date,
      cost: (200 + (topupSeq % 12) * 15).toFixed(2),
      workDesc: 'Seasonal maintenance check; confirmed customer contact info on file',
      tech: TECHS[topupSeq % TECHS.length], unit: u,
    });
    fs.writeFileSync(path.join(TOPUP_DIR, name), buildPdf(lines));
    topupEntries.push({ key: c.key, canonicalName: c.canonicalName, address: c.address, phone: c.phone, email: c.email, filename: name });
  }
  fs.writeFileSync(path.join(TOPUP_DIR, 'TOPUP_KEY.json'), JSON.stringify({
    generatedAt: TODAY,
    baseDir: path.relative(ROOT, OUT_DIR),
    customers: topupEntries,
  }, null, 2));

  console.log(`Wrote ${topupEntries.length} contact-topup invoices to ${path.relative(ROOT, TOPUP_DIR)}/ (base dir ${path.relative(ROOT, OUT_DIR)}/ untouched)`);
  console.log('Wrote', path.join(path.relative(ROOT, TOPUP_DIR), 'TOPUP_KEY.json'));
  process.exit(0);
}

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
console.log(`Questions: ${questions.length} (${questions.filter((q) => q.type === 'analytics').length} analytics, ${questions.filter((q) => q.type === 'lookup').length} lookup)`);
console.log(`Contacts: ${customersWithPhone.length} customers with phone, ${customersWithEmail.length} with email (printed in documents: ${PRINT_CONTACTS})`);
const pdfCount = filesWritten.filter((f) => f.endsWith('.pdf')).length;
const txtCount = filesWritten.filter((f) => f.endsWith('.txt')).length;
const estCost = pdfCount * 0.012 + txtCount * 0.006;
console.log(`Document forms: ${pdfCount} PDF, ${txtCount} txt`);
console.log(`Estimated Haiku extraction cost: $${estCost.toFixed(2)} (${pdfCount} x $0.012/PDF + ${txtCount} x $0.006/txt)`);
console.log('Wrote', path.join(path.relative(ROOT, OUT_DIR), 'ANSWER_KEY.json'));
