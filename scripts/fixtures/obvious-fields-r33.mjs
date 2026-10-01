/**
 * R33 (2026-09-30) — "obvious" required-field fixtures: the printed value is RIGHT THERE next to a label a person would
 * recognise, and the pipeline must not call it missing.
 *
 * Born from Sonoran Comfort Air's "118-service-ticket-c23.pdf" (prints "Date of Service: 10/19/2028"; the Inbox said
 * "Missing information — Service date"). Every case carries page text exactly as the text layer / transcript would
 * deliver it, the document type, and the expected value of every REQUIRED field that is printed (documentTypes.js
 * REQUIRED_FIELDS). Used by scripts/verify-r33-dates.mjs to measure extractor + validator end to end, before/after.
 *
 *   buildObviousFieldCases({ root }) -> case[]
 *     case = { id, type, source: 'synthetic'|'corpus'|'corpus-mutated'|'r32-labels', pages: [{page_no, text}],
 *              expect: {field_key: value}, mustNotEmit?: {field_key: value[]}, recallExempt?: field_key[], tags: string[] }
 *   Expected values are the canonical normalized form: dates ISO YYYY-MM-DD, money "1234.56", text as printed,
 *   work_performed an array of items.
 *
 * Coverage (deterministic, seeded): 9 document types (service ticket, work order, invoice, warranty registration,
 * startup sheet, inspection report, dispatch note, purchase order, maintenance agreement) x every required field,
 * >= 120 cases per required field key; label variants (SERVICE_DATE_LABELS etc.), every common US date format
 * (DATE_FORMATS), past / today / scheduled-future / far-future years, and adversarial layouts: a second date on the page
 * ("Next Service Due", "Printed on", "Follow-up", "Due Date"), label on one line and value on the next, two-column
 * lines, table header + value row, no-colon date labels, prose lines that force the model path, D/M hints, swappable
 * dates with conflicting hints (must NOT be guessed), label typos (recall-exempt) and impossible dates (must not emit).
 */
import fs from 'node:fs';
import path from 'node:path';

export const TODAY = '2026-09-30';

/* ------------------------------------------------------------------ deterministic PRNG */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ------------------------------------------------------------------ variant tables */
export const SERVICE_DATE_LABELS = [
  'Date of Service', 'Service Date', 'DOS', 'Svc Date', 'Svc. Date', 'Date Performed', 'Completed', 'Date Completed',
  'Visit Date', 'Date of Visit', 'Serviced On', 'Work Date', 'Job Date', 'Completion Date', 'DATE OF SERVICE', 'Service Performed',
];
export const INSPECTION_DATE_LABELS = ['Inspection Date', 'Date of Inspection', 'Date of Service', 'Date', 'Inspected On'];
export const STARTUP_DATE_LABELS = ['Startup Date', 'Start-up Date', 'Commissioning Date', 'Service Date', 'Date of Service'];
export const BARE_DATE_LABELS = ['Date', 'DATE', 'Dated'];
export const ADDRESS_LABELS = ['Service Address', 'Job Address', 'Job Site', 'Site Address', 'Service Location', 'Property Address', 'SERVICE ADDRESS'];
export const TECH_LABELS = ['Technician', 'Tech', 'Assigned Technician', 'Serviced By', 'Performed By'];
export const WORK_LABELS = ['Work Performed', 'Description of Work', 'Work Completed', 'Services Performed', 'Work Done', 'Repairs Performed'];
export const COST_LABELS = ['TOTAL DUE', 'Total Due', 'Amount Due', 'Grand Total', 'Invoice Total', 'Total'];
export const SERIAL_LABELS = ['Serial', 'Serial #', 'S/N', 'Serial Number', 'Serial No.'];
export const MODEL_LABELS = ['Model', 'Model #', 'Model Number', 'M/N', 'Model No.'];
export const OTHER_DATE_LABELS = ['Next Service Due', 'Next Service Date', 'Printed on', 'Follow-up Date', 'Next Visit', 'Print Date', 'Scheduled For'];

const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ord = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
/** Every common way a US form prints a date. `fn(y, m, d)` -> printed string. */
export const DATE_FORMATS = [
  ['MM/DD/YYYY', (y, m, d) => `${pad(m)}/${pad(d)}/${y}`],
  ['M/D/YYYY', (y, m, d) => `${m}/${d}/${y}`],
  ['M/D/YY', (y, m, d) => `${m}/${d}/${String(y).slice(2)}`],
  ['MM-DD-YYYY', (y, m, d) => `${pad(m)}-${pad(d)}-${y}`],
  ['MM.DD.YYYY', (y, m, d) => `${pad(m)}.${pad(d)}.${y}`],
  ['ISO', (y, m, d) => `${y}-${pad(m)}-${pad(d)}`],
  ['Mon D, YYYY', (y, m, d) => `${MON[m - 1]} ${d}, ${y}`],
  ['Mon. Dth, YYYY', (y, m, d) => `${MON[m - 1]}. ${ord(d)}, ${y}`],
  ['Month D YYYY', (y, m, d) => `${MONTH[m - 1]} ${d} ${y}`],
  ['D-Mon-YY', (y, m, d) => `${d}-${MON[m - 1]}-${String(y).slice(2)}`],
  ['D Mon YYYY', (y, m, d) => `${d} ${MON[m - 1]} ${y}`],
  ['Weekday, Month D, YYYY', (y, m, d) => `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTH[m - 1]} ${d}, ${y}`],
  ['MM/DD/YYYY h:mm AM', (y, m, d) => `${pad(m)}/${pad(d)}/${y} 2:30 PM`],
];

/* ------------------------------------------------------------------ people / shops / units */
const SHOPS = [
  ['Sonoran Comfort Air', '4410 E Baseline Rd, Mesa, AZ 85206', '(480) 555-0199  |  info@sonorancomfortair.com'],
  ['Desert Peak Heating & Cooling', '2210 E Main St, Mesa, AZ 85213', '(480) 555-0177  |  dispatch@desertpeakhvac.com'],
  ['Valley Air Pros', '880 W Broadway Rd, Tempe, AZ 85282', '(602) 555-0140  |  office@valleyairpros.com'],
];
const PEOPLE = [
  ['William Quintana', '951 E Main St, Chandler, AZ 85224'], ['Margaret Henderson', '3247 Elm St, Mesa, AZ 85201'],
  ['Robert Castillo', '918 W Palm Ln, Tempe, AZ 85281'], ['Priya Natarajan', '77 N Cedar Ct, Gilbert, AZ 85234'],
  ["Walter O'Brien", '4501 S Ash Ave, Chandler, AZ 85248'], ['Linda Fitzgerald', '100 E Main St, Phoenix, AZ 85001'],
  ['Plaza Dental Group', '2150 W Southern Ave, Mesa, AZ 85202'], ['Amy Isaacson', '248 W Guadalupe Rd, Phoenix, AZ 85001'],
  ['Thomas Mercer', '137 W Southern Ave, Phoenix, AZ 85001'], ['Donna Sorensen', '174 N College Ave, Phoenix, AZ 85001'],
  ['Carlos Rios', '581 W Thomas Rd, Phoenix, AZ 85013'], ['Karen Abernathy', '6120 E Brown Rd, Mesa, AZ 85205'],
];
const UNITS = [
  ['Mitsubishi', 'MUZ-FS40NA', 'M100025'], ['Carrier', '24ACC636A003', '4N2119-08772'], ['Trane', '4TTR4002L1000AA', 'F100002'],
  ['Goodman', 'GSX160361', '2105556781'], ['Rheem', 'RA1436AJ1NA', 'RH0219Q4471'], ['Lennox', 'ML14XC1-046-230', 'LX100005'],
];
const TECHS = ['Marisol Vega', 'Danny Ochoa', 'Kevin Pratt', 'Denise Ford', 'Ray Sutton', 'Wyatt Coburn'];
const WORK = ['Checked refrigerant charge', 'Replaced air filter', 'Replaced run capacitor', 'Cleared condensate drain line', 'Cleaned condenser coil', 'Tightened electrical connections'];
const VENDORS = ['Baker Distributing', 'Johnstone Supply', 'Ferguson HVAC Supply', 'Russell Sigler Inc', 'Watsco'];
const PARTS = ['Capacitor', 'Filter drier', 'Contactor', 'Blower motor'];

/* ------------------------------------------------------------------ helpers */
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function pickDate(r, kind) {
  // past | today | scheduled (within window) | far (beyond the 18-month service window: the Sonoran case)
  if (kind === 'today') return [2026, 9, 30];
  if (kind === 'far') { const y = 2028 + Math.floor(r() * 4); return [y, 1 + Math.floor(r() * 12), 1 + Math.floor(r() * 28)]; }
  if (kind === 'scheduled') { const t = Date.UTC(2026, 9, 5) + Math.floor(r() * 300) * 86400000; const dt = new Date(t); return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()]; }
  return [2012 + Math.floor(r() * 14), 1 + Math.floor(r() * 12), 1 + Math.floor(r() * 28)];
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function dateKind(r) { const x = r(); return x < 0.45 ? 'past' : x < 0.55 ? 'today' : x < 0.7 ? 'scheduled' : 'far'; }
/** A numeric date whose day and month are both <= 12 reads differently D/M vs M/D; the fixtures keep these only where
 * the case is ABOUT that ambiguity (dmy-hint / strict), so a format choice never smuggles in an untested reading. */
function unambiguous(fmt, y, m, d) { return !/^(MM|M)[/.-]/.test(fmt[0]) || d > 12 || m === d; }

function letterhead(r) { const s = pick(r, SHOPS); return [s[0], s[1], s[2], '']; }

/** One labelled line in a chosen layout. Returns lines[]. */
function labelled(label, value, layout) {
  if (layout === 'nextline') return [`${label}:`, value];
  if (layout === 'nocolon') return [`${label}    ${value}`];
  if (layout === 'dash') return [`${label} - ${value}`];
  return [`${label}: ${value}`];
}

/* ------------------------------------------------------------------ per-type synthetic generators */
function genDate(r, labels, { allowBare = false } = {}) {
  const fmt = pick(r, DATE_FORMATS);
  let [y, m, d] = pickDate(r, dateKind(r));
  if (!unambiguous(fmt, y, m, d)) d = 13 + Math.floor(r() * 15);
  const label = allowBare && r() < 0.2 ? pick(r, BARE_DATE_LABELS) : pick(r, labels);
  const bare = BARE_DATE_LABELS.includes(label);
  const x = r();
  const layout = bare ? 'colon' : x < 0.62 ? 'colon' : x < 0.77 ? 'nextline' : x < 0.9 ? 'nocolon' : 'dash';
  return { iso: isoOf(y, m, d), printed: fmt[1](y, m, d), fmt: fmt[0], label, layout, bare };
}

function adversarialDates(r, serviceIso, lines, tags) {
  // A second (different) date on the same page that must NEVER be read as the service date.
  if (r() < 0.45) {
    const lbl = pick(r, OTHER_DATE_LABELS);
    const [y, m, d] = pickDate(r, r() < 0.5 ? 'scheduled' : 'far');
    let iso = isoOf(y, m, Math.max(13, d));
    if (iso === serviceIso) iso = isoOf(y + 1, m, Math.max(13, d));
    lines.push(`${lbl}: ${pad(m)}/${iso.slice(8)}/${y}`);
    tags.push(`second-date:${lbl}`);
    return iso;
  }
  return null;
}
function maybeProse(r, lines, tags) {
  if (r() < 0.35) { lines.push(pick(r, ['Customer said the unit rattles at night; checked attic fan as a courtesy.', 'Tenant was not home, office let us in through the side gate.', 'Recommend coil cleaning before next summer, customer will call back.'])); tags.push('prose'); }
}

function serviceTicket(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const [brand, model, serial] = pick(r, UNITS);
  const dt = genDate(r, SERVICE_DATE_LABELS, { allowBare: true }); tags.push(`fmt:${dt.fmt}`, `label:${dt.label}`, `layout:${dt.layout}`);
  const addrLabel = pick(r, ADDRESS_LABELS); const addrLayout = r() < 0.15 ? 'nextline' : 'colon';
  const work = WORK.filter(() => r() < 0.4).slice(0, 3); if (!work.length) work.push(pick(r, WORK));
  const wl = pick(r, WORK_LABELS);
  const lines = [...letterhead(r), pick(r, ['SERVICE TICKET', 'Service Ticket', 'SERVICE REPORT', 'HVAC SERVICE TICKET'])];
  if (r() < 0.2) { lines.push(`Customer: ${name}      ${dt.label}: ${dt.printed}`); tags.push('two-column'); dt.layout = 'two-column'; }
  else { lines.push(...labelled(dt.label, dt.printed, dt.layout)); lines.push(`Customer: ${name}`); }
  lines.push(...labelled(addrLabel, addr, addrLayout), '', `Equipment: ${brand} ${model}  Serial: ${serial}`, `Visit Type: ${pick(r, ['Repair', 'PM', 'Maintenance'])}`, '');
  if (work.length === 1 && r() < 0.4) lines.push(`${wl}: ${work[0]}`); else lines.push(`${wl}:`, ...work.map((w) => `- ${w}`));
  lines.push('', `Technician: ${pick(r, TECHS)}`, 'Status: Completed');
  const other = adversarialDates(r, dt.iso, lines, tags); maybeProse(r, lines, tags);
  return { id: `st-${i}`, type: 'service-ticket', lines, expect: { service_date: dt.iso, service_address: addr, work_performed: work }, mustNotEmit: other ? { service_date: [other] } : undefined, tags };
}

function workOrder(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const tech = pick(r, TECHS);
  const dt = genDate(r, SERVICE_DATE_LABELS, { allowBare: true }); tags.push(`fmt:${dt.fmt}`, `label:${dt.label}`, `layout:${dt.layout}`);
  const lines = [...letterhead(r), pick(r, ['WORK ORDER', 'Work Order', 'SERVICE WORK ORDER']), `Work Order #: WO-${40000 + i}`];
  const tableLayout = r() < 0.15;
  if (tableLayout) {
    lines.push(`Customer: ${name}`, `${pick(r, ADDRESS_LABELS)}: ${addr}`, '', `Date of Service   |   Technician   |   Status`, `${dt.printed}   |   ${tech}   |   Completed`);
    tags.push('table'); dt.iso = dt.iso; // label fixed to "Date of Service" in the table header
  } else {
    lines.push(...labelled(dt.label, dt.printed, dt.layout), `Customer: ${name}`, ...labelled(pick(r, ADDRESS_LABELS), addr, r() < 0.15 ? 'nextline' : 'colon'), '',
      `Task: ${pick(r, ['No cooling, dispatch for diagnosis', 'Annual PM visit', 'Replace thermostat'])}`, ...labelled(pick(r, TECH_LABELS), tech, r() < 0.1 ? 'nextline' : 'colon'), 'Status: Completed');
  }
  const other = adversarialDates(r, dt.iso, lines, tags); maybeProse(r, lines, tags);
  return { id: `wo-${i}`, type: 'work-order', lines, expect: { service_date: dt.iso, service_address: addr, technician: tech }, mustNotEmit: other ? { service_date: [other] } : undefined, tags };
}

function invoice(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const [brand, model, serial] = pick(r, UNITS);
  const cents = 4000 + Math.floor(r() * 400000); const cost = (cents / 100).toFixed(2);
  const printedCost = r() < 0.5 ? `$${Number(cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `$${cost}`;
  const [y, m, d] = pickDate(r, dateKind(r));
  const lines = [...letterhead(r), 'INVOICE', `Invoice #: INV-${20000 + i}`, `Date: ${pad(m)}/${pad(Math.max(d, 13))}/${y}`, '', `Bill To: ${name}`,
    ...labelled(pick(r, ADDRESS_LABELS), addr, r() < 0.15 ? 'nextline' : 'colon'), '', `Equipment: ${brand} ${model}`, `Serial: ${serial}`, '',
    'Description of work:', pick(r, ['Replace contactor', 'Diagnose no-cool call', 'Annual maintenance visit']), '', 'Labor: 1.5 hrs'];
  if (r() < 0.3) { lines.push(`Subtotal: ${printedCost}`, 'Tax: $0.00'); tags.push('subtotal+tax'); }
  lines.push(`${pick(r, COST_LABELS)}: ${printedCost}`);
  if (r() < 0.3) { lines.push(`Due Date: ${pad(m)}/${pad(Math.max(d, 13))}/${y + 1}`); tags.push('second-date:Due Date'); }
  lines.push('', `Technician: ${pick(r, TECHS)}`, 'Status: Completed');
  maybeProse(r, lines, tags);
  return { id: `inv-${i}`, type: 'invoice', lines, expect: { service_address: addr, cost }, tags };
}

function warrantyReg(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const [brand, model, serial] = pick(r, UNITS);
  const [y, m, d] = pickDate(r, 'past'); const inst = isoOf(y, m, Math.max(13, d));
  const lines = [...letterhead(r), 'WARRANTY REGISTRATION', `Customer: ${name}`, `Service Address: ${addr}`, '', `Manufacturer: ${brand}`,
    ...labelled(pick(r, MODEL_LABELS), model, r() < 0.12 ? 'nextline' : 'colon'), ...labelled(pick(r, SERIAL_LABELS), serial, r() < 0.12 ? 'nextline' : 'colon'), '',
    `Installation Date: ${pad(m)}/${inst.slice(8)}/${y}`];
  const expect = { serial_number: serial, model };
  if (r() < 0.5) { const term = pick(r, ['10 year parts limited', '5 year parts', '10 year parts, 1 year labor']); lines.push(`Warranty Term: ${term}`); expect.warranty_term = term; }
  else { const ey = y + 10; lines.push(`${pick(r, ['Valid through', 'Warranty Expires', 'Expiration Date', 'Coverage Ends'])}: ${pad(m)}/${inst.slice(8)}/${ey}`); expect.warranty_expires = isoOf(ey, m, Math.max(13, d)); }
  // Registration date: sometimes in the far future (a typo'd year) — must be KEPT as unconfirmed, never dropped.
  if (r() < 0.5) { const far = r() < 0.4; const ry = far ? 2029 : y; lines.push(`Registered on file: ${pad(m)}/${inst.slice(8)}/${ry}`); expect.warranty_registered_date = isoOf(ry, m, Math.max(13, d)); if (far) tags.push('far-future-registration'); }
  maybeProse(r, lines, tags);
  return { id: `wr-${i}`, type: 'warranty-registration', lines, expect, tags };
}

function startupSheet(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const [brand, model, serial] = pick(r, UNITS);
  const dt = genDate(r, STARTUP_DATE_LABELS); tags.push(`fmt:${dt.fmt}`, `label:${dt.label}`, `layout:${dt.layout}`);
  const lines = [...letterhead(r), pick(r, ['STARTUP / COMMISSIONING SHEET', 'STARTUP SHEET', 'Start-Up Report']), `Customer: ${name}`, `Service Address: ${addr}`, '',
    `Equipment: ${brand} ${model}`, ...labelled(pick(r, SERIAL_LABELS), serial, r() < 0.12 ? 'nextline' : 'colon'), 'Tonnage: 3 ton', 'Refrigerant: R-410A',
    ...labelled(dt.label, dt.printed, dt.layout), '', 'Startup readings recorded, system operating normally.', `Technician: ${pick(r, TECHS)}`];
  maybeProse(r, lines, tags);
  return { id: `su-${i}`, type: 'startup-sheet', lines, expect: { serial_number: serial, service_date: dt.iso }, tags };
}

function inspection(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE);
  const dt = genDate(r, INSPECTION_DATE_LABELS); tags.push(`fmt:${dt.fmt}`, `label:${dt.label}`, `layout:${dt.layout}`);
  if (dt.bare || dt.label === 'Date') dt.layout = 'colon';
  const lines = [...letterhead(r), pick(r, ['INSPECTION REPORT', 'HVAC Inspection Report', 'SYSTEM INSPECTION REPORT']), ...labelled(dt.label, dt.printed, dt.layout),
    `Customer: ${name}`, ...labelled(pick(r, ADDRESS_LABELS), addr, r() < 0.15 ? 'nextline' : 'colon'), '', 'Findings:', '- Coil clean, no leaks found', '- Refrigerant charge within spec', '', `Technician: ${pick(r, TECHS)}`];
  const other = adversarialDates(r, dt.iso, lines, tags); maybeProse(r, lines, tags);
  return { id: `ins-${i}`, type: 'inspection-report', lines, expect: { service_date: dt.iso, service_address: addr }, mustNotEmit: other ? { service_date: [other] } : undefined, tags };
}

function dispatchNote(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE);
  const fmt = pick(r, DATE_FORMATS); let [y, m, d] = pickDate(r, dateKind(r)); if (!unambiguous(fmt, y, m, d)) d = 13 + Math.floor(r() * 15);
  const iso = isoOf(y, m, d); const printed = fmt[1](y, m, d); tags.push(`fmt:${fmt[0]}`);
  const inTitle = r() < 0.5;
  const lines = inTitle ? [`Dispatch note - ${printed}`] : [pick(r, ['DISPATCH NOTE', 'Dispatch Note']), `Date: ${printed}`];
  tags.push(inTitle ? 'date-in-title' : 'bare-date');
  lines.push(`Customer: ${name}`, `${pick(r, ['Address', 'Service Address', 'Site'])}: ${addr}`, '', pick(r, ['Customer reports weak airflow, tech dispatched today.', 'No heat, send first available tech.', 'Thermostat blank, check breaker first.']), '', `Tech: ${pick(r, TECHS)}`);
  return { id: `dn-${i}`, type: 'dispatch-note', lines, expect: { service_date: iso, customer_name: name, service_address: addr }, tags };
}

function purchaseOrder(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const vendor = pick(r, VENDORS);
  const cost = (900 + Math.floor(r() * 90000)) / 100; const c = cost.toFixed(2);
  const [y, m, d] = pickDate(r, 'past');
  const lines = [...letterhead(r), 'PURCHASE ORDER', `PO #: PO-${9000 + i}`, `Date: ${pad(m)}/${pad(Math.max(13, d))}/${y}`, `${pick(r, ['Vendor', 'Supplier', 'Vendor', 'Ordered From'])}: ${vendor}`, '',
    r() < 0.5 ? `For job at: ${addr} (${name})` : `Customer: ${name}`, 'Parts:', ...PARTS.filter(() => r() < 0.5).map((p) => `- ${p}`), '', `Total: $${c}`];
  return { id: `po-${i}`, type: 'purchase-order', lines, expect: { vendor, customer_name: name, cost: c }, tags };
}

function maintenanceAgreement(r, i) {
  const tags = []; const [name, addr] = pick(r, PEOPLE); const [brand, model, serial] = pick(r, UNITS);
  const y = 2024 + Math.floor(r() * 4); const period = `01/01/${y} - 12/31/${y}`;
  const useTerm = r() < 0.5;
  const lines = [...letterhead(r), pick(r, ['MAINTENANCE AGREEMENT', 'Service Agreement', 'PREVENTIVE MAINTENANCE AGREEMENT']), `${pick(r, ['Customer', 'Customer Name', 'Account Name'])}: ${name}`,
    ...labelled(pick(r, ADDRESS_LABELS), addr, r() < 0.15 ? 'nextline' : 'colon'), '',
    useTerm ? `Contract Term: 12 months` : `Agreement Period: ${period}`, 'Coverage: 2 preventive maintenance visits per year', '', 'Units covered:',
    `Unit 1: ${brand} ${model}, Serial ${serial}`, '', `Annual Cost: $${(240 + Math.floor(r() * 300)).toFixed(2)}`];
  maybeProse(r, lines, tags);
  return { id: `ma-${i}`, type: 'maintenance-agreement', lines, expect: { service_address: addr, customer_name: name, agreement_term: useTerm ? '12 months' : period }, tags };
}

/* ------------------------------------------------------------------ hand-written adversarial cases */
function handCases() {
  const lh = [...SHOPS[0], ''];
  const out = [];
  const add = (id, type, lines, expect, extra = {}) => out.push({ id: `adv-${id}`, type, lines, expect, tags: ['adversarial', ...(extra.tags ?? [])], ...extra });
  // THE production case, verbatim shape.
  add('sonoran-118', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 10/19/2028', 'Customer: William Quintana', 'Service Address: 951 E Main St, Chandler, AZ 85224',
    'Customer phone: Cell: 480-555-0133', '', 'Equipment: Mitsubishi MUZ-FS40NA  Serial: M100025', 'Visit Type: Repair', '', 'Work Performed:', '- Checked refrigerant charge', '- Replaced air filter', '',
    'Notes: System operating normally after visit', 'Technician: Marisol Vega', 'Status: Completed'],
  { service_date: '2028-10-19', service_address: '951 E Main St, Chandler, AZ 85224', work_performed: ['Checked refrigerant charge', 'Replaced air filter'] }, { tags: ['sonoran', 'far-future'] });
  // Three dates on one page.
  add('three-dates', 'service-ticket', [...lh, 'SERVICE TICKET', 'Printed on: 09/30/2026', 'Date of Service: 10/19/2028', 'Next Service Due: 04/19/2029', 'Customer: William Quintana',
    'Service Address: 951 E Main St, Chandler, AZ 85224', 'Work Performed: Checked refrigerant charge', 'Technician: Marisol Vega'],
  { service_date: '2028-10-19', service_address: '951 E Main St, Chandler, AZ 85224', work_performed: ['Checked refrigerant charge'] }, { mustNotEmit: { service_date: ['2026-09-30', '2029-04-19'] } });
  // Next Service Date BEFORE the real one, in the header zone.
  add('next-first', 'work-order', [...lh, 'WORK ORDER', 'Next Service Date: 03/15/2027', 'Date: 09/15/2026', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Technician: Danny Ochoa'],
    { service_date: '2026-09-15', service_address: '100 E Main St, Phoenix, AZ 85001', technician: 'Danny Ochoa' }, { mustNotEmit: { service_date: ['2027-03-15'] } });
  // Explicit service-date label beats the bare document date.
  add('explicit-beats-bare', 'work-order', [...lh, 'WORK ORDER', 'Date: 09/01/2026', 'Date Performed: 09/14/2026', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Technician: Danny Ochoa', 'Customer said thanks.'],
    { service_date: '2026-09-14', service_address: '100 E Main St, Phoenix, AZ 85001', technician: 'Danny Ochoa' }, { mustNotEmit: { service_date: ['2026-09-01'] } });
  // Two DIFFERENT explicit service dates: ambiguous -> must not guess.
  add('two-service-dates', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 09/14/2026', 'Service Date: 09/16/2026', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { recallExempt: ['service_date'], mustNotEmit: { service_date: ['2026-09-14', '2026-09-16'] } });
  // D/M document: an unambiguous day-first date elsewhere on the page is the hint.
  add('dmy-hint', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 05/11/2028', 'Printed on: 25/09/2026', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_date: '2028-11-05', service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { mustNotEmit: { service_date: ['2028-05-11'] } });
  // Swappable date AND conflicting hints (one M/D, one D/M): no hint left -> must not guess.
  add('strict-conflict', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 05/11/2028', 'Printed on: 25/09/2026', 'Next Service Due: 12/25/2028', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { recallExempt: ['service_date'], mustNotEmit: { service_date: ['2028-05-11', '2028-11-05'] } });
  // Swappable date, NO hint: US default (M/D).
  add('us-default', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 05/11/2028', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_date: '2028-05-11', service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] });
  // Impossible / typo'd dates: never emitted.
  add('impossible-date', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 13/45/2028', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { recallExempt: ['service_date'] });
  add('ocr-typo-date', 'service-ticket', [...lh, 'SERVICE TICKET', 'Date of Service: 1O/19/2O28', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter'],
    { service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { recallExempt: ['service_date'] });
  // Label typos: recognised? not required (recall-exempt) — but never a WRONG value.
  for (const [n, lbl] of [['typo1', 'Date of Servce'], ['typo2', 'Serivce Date'], ['typo3', 'Dat of Service']]) {
    add(n, 'service-ticket', [...lh, 'SERVICE TICKET', `${lbl}: 10/19/2028`, 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Work Performed: Replaced air filter', 'Next Service Due: 04/19/2029'],
      { service_address: '100 E Main St, Phoenix, AZ 85001', work_performed: ['Replaced air filter'] }, { recallExempt: ['service_date'], mustNotEmit: { service_date: ['2029-04-19'] } });
  }
  // Billing/mailing address next to the service address: only the service address counts.
  add('billing-vs-service', 'invoice', [...lh, 'INVOICE', 'Invoice #: INV-1', 'Date: 09/14/2026', 'Bill To: Plaza Dental Group', 'Billing Address: 9 Corporate Dr, Scottsdale, AZ 85251', 'Job Site: 2150 W Southern Ave, Mesa, AZ 85202', 'Replaced contactor today.', 'TOTAL DUE: $412.50'],
    { service_address: '2150 W Southern Ave, Mesa, AZ 85202', cost: '412.50' }, { mustNotEmit: { service_address: ['9 Corporate Dr, Scottsdale, AZ 85251'] } });
  // Subtotal + total: total wins.
  add('subtotal-total', 'invoice', [...lh, 'INVOICE', 'Bill To: Plaza Dental Group', 'Service Address: 2150 W Southern Ave, Mesa, AZ 85202', 'Line items below.', 'Subtotal: $380.00', 'Sales Tax: $32.50', 'TOTAL DUE: $412.50'],
    { service_address: '2150 W Southern Ave, Mesa, AZ 85202', cost: '412.50' }, { mustNotEmit: { cost: ['380.00', '32.50'] } });
  // Letterhead-only address on a dispatch note: never the service address.
  add('letterhead-only', 'dispatch-note', ['Sonoran Comfort Air', '4410 E Baseline Rd, Mesa, AZ 85206', 'Dispatch note - 09/29/2026', 'Customer: Thomas Mercer', 'Unit making noise, send tech.'],
    { service_date: '2026-09-29', customer_name: 'Thomas Mercer' }, { mustNotEmit: { service_address: ['4410 E Baseline Rd, Mesa, AZ 85206'] } });
  // Two technicians: ambiguous, never merged/guessed.
  add('two-techs', 'work-order', [...lh, 'WORK ORDER', 'Date of Service: 09/14/2026', 'Customer: Linda Fitzgerald', 'Service Address: 100 E Main St, Phoenix, AZ 85001', 'Technician: Danny Ochoa', 'Technician: Kevin Pratt'],
    { service_date: '2026-09-14', service_address: '100 E Main St, Phoenix, AZ 85001' }, { recallExempt: ['technician'], mustNotEmit: { technician: ['Danny Ochoa', 'Kevin Pratt'] } });
  return out.map((c) => ({ ...c, source: 'synthetic' }));
}

/* ------------------------------------------------------------------ corpus-derived */
/** Pull the printed value after an exact label on a line — an INDEPENDENT reading of the fixture (not the extractor). */
function grab(text, re) { const m = re.exec(text); return m ? m[1].trim() : null; }
function usToIso(s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; }

async function corpusCases(root) {
  const dir = path.join(root, 'test-docs', 'business');
  if (!fs.existsSync(dir)) return [];
  const { readPdfTextLayer } = await import(path.join(root, 'api/_lib/modelAvoidance/pdfText.js'));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}-(service-ticket|work-order|invoice|warranty-registration|startup-sheet|inspection-report|dispatch-note|purchase-order|maintenance-agreement)-/.test(f)).sort();
  const out = [];
  const r = rng(3302);
  for (const f of files) {
    const type = /^\d{3}-([a-z-]+?)-(?:c|p)\d+\./.exec(f)?.[1];
    if (!type) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    const pages = f.endsWith('.txt') ? [{ page_no: 1, text: buf.toString('utf8') }] : readPdfTextLayer(buf).pages;
    if (!pages?.length) continue;
    const text = pages.map((p) => p.text).join('\n');
    const expect = {};
    const addr = grab(text, /^(?:Service Address|Site Address|Address):\s*(.+)$/m) ?? grab(text, /^For job at:\s*(.+?\d{5})/m);
    const dateLine = grab(text, /^(?:Date of Service|Service Date):\s*(\d{2}\/\d{2}\/\d{4})$/m) ?? (/(service-ticket|work-order|inspection-report)/.test(type) ? grab(text, /^Date:\s*(\d{2}\/\d{2}\/\d{4})$/m) : null)
      ?? (type === 'dispatch-note' ? grab(text, /^Dispatch note - (\d{2}\/\d{2}\/\d{4})$/m) : null);
    const req = {
      'service-ticket': ['service_address', 'service_date', 'work_performed'], 'work-order': ['service_address', 'service_date', 'technician'], invoice: ['service_address', 'cost'],
      'warranty-registration': ['serial_number', 'model'], 'startup-sheet': ['serial_number', 'service_date'], 'inspection-report': ['service_address', 'service_date'],
      'dispatch-note': ['service_date', 'customer_name'], 'purchase-order': ['vendor', 'cost'], 'maintenance-agreement': ['service_address', 'customer_name', 'agreement_term'],
    }[type];
    if (req.includes('service_address') && addr) expect.service_address = addr;
    if (req.includes('service_date') && dateLine) expect.service_date = usToIso(dateLine);
    if (req.includes('technician')) { const t = grab(text, /^(?:Assigned Technician|Technician|Tech):\s*(.+)$/m); if (t) expect.technician = t; }
    if (req.includes('work_performed')) { const blk = /^Work Performed:\s*\n((?:- .+\n?)+)/m.exec(text); if (blk) expect.work_performed = blk[1].trim().split('\n').map((l) => l.replace(/^- /, '').trim()); }
    if (req.includes('cost')) { const c = grab(text, /^(?:TOTAL DUE|Total|Amount Due):\s*\$([\d,]+\.\d{2})$/m); if (c) expect.cost = c.replace(/,/g, ''); }
    if (req.includes('serial_number')) { const s = grab(text, /^Serial(?: #)?:\s*(\S+)$/m) ?? grab(text, /Serial:\s*(\S+)\s*$/m); if (s) expect.serial_number = s; }
    if (req.includes('model')) { const m = grab(text, /^Model:\s*(\S+)$/m); if (m) expect.model = m; }
    if (req.includes('customer_name')) { const c = grab(text, /^Customer:\s*(.+)$/m); if (c) expect.customer_name = c; }
    if (req.includes('vendor')) { const v = grab(text, /^Vendor:\s*(.+)$/m); if (v) expect.vendor = v; }
    if (req.includes('agreement_term')) { const a = grab(text, /^Agreement Period:\s*(.+)$/m); if (a) expect.agreement_term = a; }
    if (!Object.keys(expect).length) continue;
    out.push({ id: `corpus-${f}`, type, source: 'corpus', pages, expect, tags: ['corpus'] });

    // Corpus-MUTATED: the same real document with its service date re-printed in another format, label and year
    // (one in three lands in the far future — the Sonoran case on real corpus layouts).
    if (expect.service_date && /^(?:Date of Service|Service Date|Date):\s*\d{2}\/\d{2}\/\d{4}$/m.test(text)) {
      const fmt = pick(r, DATE_FORMATS); let [y, m, d] = pickDate(r, r() < 0.35 ? 'far' : dateKind(r)); if (!unambiguous(fmt, y, m, d)) d = 13 + Math.floor(r() * 15);
      const label = type === 'inspection-report' ? pick(r, INSPECTION_DATE_LABELS.filter((x) => x !== 'Date')) : type === 'dispatch-note' ? null : pick(r, SERVICE_DATE_LABELS);
      if (!label) continue;
      const mutated = pages.map((p) => ({ ...p, text: p.text.replace(/^(?:Date of Service|Service Date|Date):\s*\d{2}\/\d{2}\/\d{4}$/m, `${label}: ${fmt[1](y, m, d)}`) }));
      out.push({ id: `corpus-mut-${f}`, type, source: 'corpus-mutated', pages: mutated, expect: { ...expect, service_date: isoOf(y, m, d) }, tags: ['corpus', `fmt:${fmt[0]}`, `label:${label}`] });
    }
  }
  return out;
}

/** R32's hand-checked labels (truth from ANSWER_KEY.json): every REQUIRED field they carry, scored the same way. */
async function r32LabelCases(root) {
  const lp = path.join(root, 'scripts/r32/labels.json');
  if (!fs.existsSync(lp)) return [];
  const { readPdfTextLayer } = await import(path.join(root, 'api/_lib/modelAvoidance/pdfText.js'));
  const labels = JSON.parse(fs.readFileSync(lp, 'utf8'));
  const { REQUIRED_FIELDS } = await import(path.join(root, 'api/_lib/documentTypes.js'));
  const out = [];
  for (const d of labels.docs) {
    if (!BENCH_TYPES.includes(d.type)) continue;
    const fp = path.join(root, 'scripts/r32/fixtures', d.file);
    if (!fs.existsSync(fp)) continue;
    const buf = fs.readFileSync(fp);
    const pages = d.file.endsWith('.txt') ? [{ page_no: 1, text: buf.toString('utf8') }] : readPdfTextLayer(buf).pages;
    if (!pages?.length) continue;
    const req = (REQUIRED_FIELDS[d.type] ?? []).flatMap((x) => x.split('|'));
    const expect = Object.fromEntries(Object.entries(d.truth).filter(([k]) => req.includes(k)));
    // R32's truth predates the `vendor` field: read the printed vendor line independently so the PO's
    // "vendor|customer_name" requirement is scored against what is actually printed.
    if (d.type === 'purchase-order') { const v = grab(pages.map((p) => p.text).join('\n'), /^Vendor:\s*(.+)$/m); if (v) expect.vendor = v; }
    if (Object.keys(expect).length) out.push({ id: `r32-${d.file}`, type: d.type, source: 'r32-labels', pages, expect, tags: ['r32'] });
  }
  return out;
}

/** The nine document types this benchmark covers. */
export const BENCH_TYPES = ['service-ticket', 'work-order', 'invoice', 'warranty-registration', 'startup-sheet', 'inspection-report', 'dispatch-note', 'purchase-order', 'maintenance-agreement'];

/* ------------------------------------------------------------------ build */
export async function buildObviousFieldCases({ root, perType = 130 } = {}) {
  const r = rng(33);
  const gens = [serviceTicket, workOrder, invoice, warrantyReg, startupSheet, inspection, dispatchNote, purchaseOrder, maintenanceAgreement];
  const synthetic = [];
  for (const g of gens) for (let i = 0; i < perType; i++) {
    const c = g(r, i);
    synthetic.push({ ...c, source: 'synthetic', pages: [{ page_no: 1, text: c.lines.join('\n') }] });
  }
  const hand = handCases().map((c) => ({ ...c, pages: [{ page_no: 1, text: c.lines.join('\n') }] }));
  const corpus = root ? await corpusCases(root) : [];
  const r32 = root ? await r32LabelCases(root) : [];
  return [...hand, ...synthetic, ...corpus, ...r32].map(({ lines, ...c }) => c);
}
