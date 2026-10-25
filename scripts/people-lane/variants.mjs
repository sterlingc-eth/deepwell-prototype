// Held-out synthetic variants for the people / ID lane (round 3). SYNTHETIC: every name, number, place and phrase is invented.
//
// WHY: the earlier fixes were narrow word lists, so each new variant of the same failure got through. This generator produces many variants
// of every failure class from a FIXED SEED, in two disjoint vocabularies:
//   dev      the vocabulary the code was developed against (tuning allowed)
//   holdout  a different vocabulary (other phrases, other towns, other title nouns, other wrapping), never used for tuning
// Classes (the verifier's failure families):
//   C1 name   a holder / employee / manager value that is not a person's name (instruction phrase, place, title fragment, organisation)
//   C1p       the same templates with a real name: the name must still be read (recall)
//   C2 ctl    the form's own OMB / form-number / revision / "Expires" block, wrapped over 1-4 lines, must never become a date
//   C3 hr     an HR sheet or licence never carries customer_* / service_* facts; the inline "Start Date" is the HR start date
//   C4 type   a policy / checklist / memo / flyer that merely names a certificate or a new hire is not typed as an ID / HR paper; real ones still are (C4p)
//   C5 lane   Donovan's people lane abstains where it must (W1 other licence, W2 same-name customer, W3 collisions, ties) and answers the clear cases
//   C6 retype a permit / inspection / work order with a licence-number row is not a licence
//   C7 mut    boundary cases that kill the surviving mutations (expiry today, tie, surname without capital, ...)
// Pure data. Run through scripts/verify-people-variants.mjs.

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const mdy = (y, m, d) => `${pad(m)}/${pad(d)}/${y}`;
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const randDate = (r, y0 = 2026, y1 = 2031) => { const y = y0 + Math.floor(r() * (y1 - y0 + 1)); const m = 1 + Math.floor(r() * 12); const d = 1 + Math.floor(r() * 28); return { y, m, d, mdy: mdy(y, m, d), iso: iso(y, m, d) }; };
const caseOf = (r, s) => { const k = Math.floor(r() * 3); return k === 0 ? s : k === 1 ? s.replace(/\b([a-z])/g, (m) => m.toUpperCase()) : s.toUpperCase(); };

const POOLS = {
  dev: {
    first: ['Alex', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Taylor', 'Avery', 'Quinn', 'Rowan', 'Sasha', 'Devon', 'Kendall', 'Marisol', 'Teodoro', 'Imani', 'Harlan', 'Beatrix', 'Cormac', 'Dalia', 'Emilio'],
    last: ['Tester', 'Sampleton', 'Example', 'Larkspur', 'Penhallow', 'Mondragon', 'Wexford', 'Villanueva', 'Konkwo-Reyes', "O'Brien", 'Castellano', 'Fairweather', 'Brightwater', 'Okafor', 'Lindqvist', 'Haverford', 'Stillwell', 'Quarles', 'Tamarack', 'Whitcombe'],
    instr: ['see attached', 'must be printed in ink', 'must be on file', 'to be completed by HR', 'as shown on license', 'same as above', 'print clearly', 'sign here', 'not provided', 'left blank intentionally', 'refer to handbook', 'per company policy', 'see page 2', 'enter below'],
    cities: ['Mesa', 'Tempe', 'Chandler', 'Gilbert', 'Phoenix', 'Glendale', 'Scottsdale'],
    states: [['AZ', 'Arizona'], ['CA', 'California'], ['NV', 'Nevada'], ['TX', 'Texas']],
    titleHead: ['New Hire', 'Employee', 'New Employee'],
    titleTail: ['Orientation Agenda', 'Bonus Program', 'Referral Bonus Plan', 'Handbook Acknowledgement', 'Safety Orientation'],
    orgs: ['Sidewinder Equipment Rental', 'Mesa Cool Air', 'Desert Peak HVAC', 'Ironwood Supply Co', 'Copperline Plumbing Inc'],
    certHeads: ["Medical Examiner's Certificate", 'Driver License', 'CDL', 'Medical Card', 'DOT Medical Certificate'],
    flyerTitles: ['New hire bonus program', 'New Hire Orientation Agenda', 'New hire referral flyer'],
    ctl: [
      (d) => ['OMB No. 2126-0006', `Expiration Date: ${d}`],
      (d) => ['OMB No.', '2126-0006', 'Expires:', d],
      (d) => [`OMB No. 2126-0006 Expires ${d}`],
      (d) => ['OMB Control No.', '2126-0006', 'Exp. Date', d],
      (d) => ['Form MCSA-5876 (Rev. 6-2015)', 'Expiration Date', d],
    ],
    unlicensed: ['contractor', 'plumbing', 'business', 'real estate', 'liquor', 'electrical', 'ROC'],
    nonHrStart: ['maintenance agreement', 'warranty', 'service', 'job at the house', 'lease'],
    startLabels: ['Start Date', 'Date of Hire', 'Hire Date', 'First Day', 'Starting Date'],
    permitRows: ['License #   CO EC-218745', 'Contractor License No: ROC-318822', 'Lic. #: PL-77120'],
    permitTitles: ['ELECTRICAL PERMIT', 'Building Permit', 'Mechanical Permit Card'],
    issuers: ['City of Aurora Building Division', 'County Development Services Department', 'Town Licensing Board'],
  },
  holdout: {
    first: ['Bernadette', 'Callum', 'Dolores', 'Ezekiel', 'Fiona', 'Gideon', 'Hana', 'Ignatius', 'Jasmine', 'Kofi', 'Lorna', 'Mateo', 'Nadia', 'Osvaldo', 'Priya', 'Reuben', 'Soledad', 'Thaddeus', 'Ursula', 'Wendell'],
    last: ['Abernathy', 'Bellweather', 'Cavanaugh', 'Dunmore', 'Echeverria', 'Fontaine', 'Gallagher', 'Hollingsworth', 'Iyer', 'Jablonski', 'Kowalczyk', 'Lombardi', 'McAllister', 'Nakamura', 'Oyelaran', 'Pemberton', 'Ramaswamy', 'Szymanski', 'Thibodeaux', 'Yamamoto-Cole'],
    instr: ['please write legibly', 'provided at orientation', 'pending background results', 'awaiting clearance', 'supplied by the recruiter', 'available on request', 'will be assigned later', 'to be determined by payroll', 'copy of passport required', 'enter legal name exactly', 'name withheld at request', 'use block capitals only', 'attach photo id', 'reviewed by supervisor', 'unavailable for scan', 'issued separately', 'verified at check-in', 'confirm with manager'],
    cities: ['Tucson', 'Flagstaff', 'Yuma', 'Peoria', 'Surprise', 'Goodyear', 'Prescott Valley', 'Casa Grande', 'Bullhead City', 'Sierra Vista'],
    states: [['UT', 'Utah'], ['NM', 'New Mexico'], ['CO', 'Colorado'], ['OR', 'Oregon'], ['WA', 'Washington'], ['ID', 'Idaho'], ['OK', 'Oklahoma']],
    titleHead: ['New Hire', 'Employee', 'Hiring', 'Staff'],
    titleTail: ['Welcome Roster', 'Benefits Overview', 'Safety Briefing', 'Training Syllabus', 'Wellness Plan', 'Parking Schedule', 'Culture Calendar'],
    orgs: ['Canyon Ridge Trucking', 'Blue Heron Logistics', 'Saguaro Freight Lines', 'Copper State Rentals Inc', 'Red Mesa Heating & Cooling', 'Palo Verde Staffing Group'],
    certHeads: ["U.S. DOT Medical Examiner's Certificate (Form MCSA-5876)", 'Commercial Driver License', 'Medical Examiner Certificate', "Driver's License", 'Medical Examination Report', 'Chauffeur License', "Operator's License"],
    flyerTitles: ['New hires get a signing bonus', 'Welcome new hires', 'New hire parking and badge information'],
    ctl: [
      (d) => ['Approved OMB 1545-0074', 'Expiration:', d],
      (d) => ['OMB Number 2900-0123', 'Expires', d],
      (d) => ['OMB No. 2126-0006', 'Expiration', 'Date:', d],
      (d) => ['FORM APPROVED', 'OMB NO. 2126-0006', `EXPIRES: ${d}`],
      (d) => ['Control Number: 1234-5678', 'Expiration Date:', d],
      (d) => [`Public reporting burden for this collection is estimated at 15 minutes. OMB Control No. 2126-0006 (expires ${d})`],
      (d) => ['Form W-4 (Rev. 04/2024)', 'Expires', d],
    ],
    unlicensed: ['pest control', 'nursing', 'cosmetology', 'fishing', 'boat', 'pilot', 'notary', 'general contractor', 'mortgage'],
    nonHrStart: ['installation', 'repair', 'trial membership', 'subscription', 'appointment', 'inspection', 'project', 'quote'],
    startLabels: ['Start Date', 'Date Started', 'Employment Start', 'Report Date', 'Effective Start Date', 'Hire Date'],
    permitRows: ['Licence #   AZ-ROC 884120', 'License Number: ELEC-55-0932', 'License No.  TX-18822   Contractor   Brightline Builders'],
    permitTitles: ['PLUMBING PERMIT', 'Certificate of Occupancy', 'Inspection Report', 'Work Order', 'Demolition Permit'],
    issuers: ['State Department of Licensing', 'Regional Building Authority', 'Board of Contractors', 'City Planning Division'],
  },
};

const person = (r, P) => {
  const f = pick(r, P.first); const l = pick(r, P.last); const mi = r() < 0.35 ? String.fromCharCode(65 + Math.floor(r() * 26)) : null;
  const printed = r() < 0.2 ? `${l}, ${f}${mi ? ' ' + mi : ''}` : r() < 0.15 ? `${f.toUpperCase()}${mi ? ' ' + mi : ''} ${l.toUpperCase()}` : `${f}${mi ? ' ' + mi + '.' : ''} ${l}`;
  return { first: f, last: l, mi, printed, key: `${f} ${l}`.toLowerCase() };
};
const num = (r) => `${pick(r, ['D', 'X', 'T', 'B'])}${Math.floor(10000000 + r() * 89999999)}`;
const phone = (r) => `(${pick(r, ['480', '602', '623'])}) 555-${pad(Math.floor(r() * 10000), 4)}`;

/* ---------------------------------------------------------------- C1 name value */
const badName = (r, P, kindHint) => {
  const k = Math.floor(r() * 4);
  if (k === 0) return { v: caseOf(r, pick(r, P.instr)), why: 'instruction' };
  if (k === 1) { const city = pick(r, P.cities); const [ab, full] = pick(r, P.states); const v = pick(r, [`${city} ${ab}`, `${city}, ${ab}`, `${city} ${full}`, `${city}, ${full}`]); return { v: r() < 0.3 ? v.toUpperCase() : v, why: 'place' }; }
  if (k === 2 && kindHint !== 'holder-org-less') return { v: pick(r, P.orgs), why: 'organisation' };
  return { v: caseOf(r, pick(r, P.instr)), why: 'instruction' };
};
const HOLDER_FRAMES = [
  (v) => [`Driver's Name: ${v}`], (v) => ["Driver's Name", v], (v) => [`Licensee: ${v}`], (v) => [`Holder: ${v}`], (v) => ['Name of Driver', v], (v) => [`Name ${v}`], (v) => ["Driver's Name   Driver's License Number", `${v}   X1234567`],
];
const EMP_FRAMES = [
  (v) => [`Employee Name: ${v}`], (v) => ['Employee Name', v], (v) => [`New Hire: ${v}`], (v) => [`Name: ${v}`], (v) => ['Name of Employee', v], (v) => [`Employee ${v}`], (v) => ['New Hire Name', v],
];
const MGR_FRAMES = [(v) => [`Supervisor: ${v}`], (v) => ['Manager', v], (v) => [`Reports To: ${v}`], (v) => [`Hiring Manager: ${v}`]];
const mecDoc = (holderLines, { exp = '05/05/2026', exam = '05/05/2024', head = [], tail = [] } = {}) => [
  "Medical Examiner's Certificate", ...head, ...holderLines, "Driver's License Number", 'X1234567', `Date of Examination ${exam}`, `Medical Examiner's Certificate Expiration Date ${exp}`, ...tail].join('\n');
const tradeDoc = (holderLines, { exp = '2027-08-30' } = {}) => ['Plumbing License', 'State Board of Examples', `License No: JP-860244   Expires: ${exp}`, ...holderLines].join('\n');
const hrDoc = (nameLines, { extra = [], head = 'New Hire Checklist' } = {}) => [head, ...nameLines, 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Rate of Pay $27.50/hr', 'Supervisor', 'Dana Sample', ...extra].join('\n');

function genC1(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = badName(r, P);
    const t = i % 4;
    if (t === 0) { const fr = pick(r, HOLDER_FRAMES); out.push({ cls: 'C1', split, id: `c1-h${i}`, text: r() < 0.5 ? mecDoc(fr(b.v)) : tradeDoc(fr(b.v)), expect: { absent: ['holder_name'], noValue: b.v }, note: `${b.why} as holder` }); }
    else if (t === 1) { const fr = pick(r, EMP_FRAMES); out.push({ cls: 'C1', split, id: `c1-e${i}`, text: hrDoc(fr(b.v)), expect: { absent: ['employee_name'], noValue: b.v }, note: `${b.why} as employee` }); }
    else if (t === 2) { const fr = pick(r, MGR_FRAMES); const nm = person(r, P); out.push({ cls: 'C1', split, id: `c1-m${i}`, text: ['New Hire Checklist', 'Employee Name', nm.printed.includes(',') ? `${nm.first} ${nm.last}` : nm.printed, 'Position', 'Field Technician', 'Start Date 06/03/2025', ...fr(b.v)].join('\n'), expect: { absent: ['manager'], noValue: b.v }, note: `${b.why} as manager` }); }
    else {
      // title fragment: the page title is "<head> <tail>", read as a name by a no-colon "<head> <rest>" label
      const head = pick(r, P.titleHead); const tail = pick(r, P.titleTail);
      const title = `${head} ${tail}`;
      out.push({ cls: 'C1', split, id: `c1-t${i}`, text: [title, 'Position   Start Date   Manager', 'Field Technician   06/03/2025   Dana Sample', 'Supervisor', 'Dana Sample'].join('\n'), expect: { absent: ['employee_name'], noValue: tail }, note: 'title fragment' });
    }
  }
  return out;
}
function genC1p(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const nm = person(r, P);
    const t = i % 2;
    if (t === 0) {
      const k = Math.floor(r() * HOLDER_FRAMES.length);
      out.push({ cls: 'C1p', split, id: `c1p-h${i}`, text: r() < 0.5 ? mecDoc(HOLDER_FRAMES[k](nm.printed)) : tradeDoc(HOLDER_FRAMES[k](nm.printed)), expect: { name: { key: 'holder_name', person: nm } }, note: 'holder name read' });
    } else {
      // frame 5 ("Employee Casey Example" with no colon, no gap) reads like a page title on purpose: precision over recall, so it is not a recall case
      const POS = EMP_FRAMES.filter((_, j) => j !== 5); const k = Math.floor(r() * POS.length);
      out.push({ cls: 'C1p', split, id: `c1p-e${i}`, text: hrDoc(POS[k](nm.printed)), expect: { name: { key: 'employee_name', person: nm } }, note: 'employee name read' });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- C2 form-control block */
function genC2(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ctlDate = randDate(r, 2027, 2031); const real = randDate(r, 2025, 2026);
    const block = pick(r, P.ctl)(ctlDate.mdy);
    const withReal = r() < 0.6;
    const nm = person(r, P);
    const holder = ["Driver's Name", nm.printed.includes(',') ? `${nm.first} ${nm.last}` : nm.printed];
    const where = i % 3; // top / after the title / bottom
    const body = [...holder, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', ...(withReal ? [`Medical Examiner's Certificate Expiration Date ${real.mdy}`] : [])];
    const lines = where === 0 ? [...block, "Medical Examiner's Certificate", ...body] : where === 1 ? ["Medical Examiner's Certificate", ...block, ...body] : ["Medical Examiner's Certificate", ...body, ...block];
    out.push({ cls: 'C2', split, id: `c2-${i}`, text: lines.join('\n'), expect: { endDateIn: withReal ? [real.iso] : [null], noDate: ctlDate.iso }, note: `control block ${block.length} line(s) at ${['top', 'after title', 'bottom'][where]}` });
  }
  return out;
}

/* ---------------------------------------------------------------- C3 HR guard */
function genC3(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const nm = person(r, P); const d = randDate(r, 2025, 2026); const lbl = pick(r, P.startLabels);
    const name = nm.printed.includes(',') ? `${nm.first} ${nm.last}` : nm.printed;
    const ph = phone(r); const em = `${nm.first.toLowerCase()}.${nm.last.toLowerCase().replace(/[^a-z]/g, '')}@example.test`;
    const layout = i % 4;
    const lines = layout === 0 ? ['New Hire Information Sheet', `Employee Name: ${name}`, `Phone: ${ph}`, `Email: ${em}`, `${lbl}: ${d.mdy}`, 'Position: Installer', 'Rate of Pay: $28.00/hr', 'Supervisor: Dana Sample']
      : layout === 1 ? ['New Hire Checklist', 'Employee Name', name, 'Phone', ph, 'Email', em, lbl, d.mdy, 'Position', 'Installer']
      : layout === 2 ? ['Employee Onboarding Checklist', `Name   ${name}`, `Telephone   ${ph}`, `${lbl}   ${d.mdy}`, 'Customer Name   ' + name, 'Job Title   Installer']
      : ['Acme Heating - New Hire Information Sheet', 'FULL NAME   PHONE', ` ${name}   ${ph}`, `POSITION   DEPARTMENT   ${lbl.toUpperCase()}`, ` Installer   Field   ${d.mdy}`, 'REPORTS TO / MANAGER   HOURLY RATE', ' Sam Ortiz   $31.00'];
    out.push({ cls: 'C3', split, id: `c3-${i}`, text: lines.join('\n'), filename: layout === 3 ? 'newhire.pdf' : 'scan.pdf', expect: { noKeyPrefix: ['customer_', 'service_'], startDateOptional: d.iso, typeIs: 'hr-letter' }, note: `HR layout ${layout}, "${lbl}"` });
  }
  // person-ID papers: a licence never carries customer_* / service_*
  for (let i = 0; i < Math.ceil(n / 4); i++) {
    const nm = person(r, P); const d = randDate(r, 2026, 2031);
    const name = nm.printed.includes(',') ? `${nm.first} ${nm.last}` : nm.printed;
    out.push({ cls: 'C3', split, id: `c3l-${i}`, text: ['Plumbing License', 'State Board of Examples', `Holder: ${name}`, `License No: JP-${Math.floor(100000 + r() * 800000)}   Expires: ${d.iso}`, `Date of Service: ${d.mdy}`, `Customer: ${name}`].join('\n'), expect: { noKeyPrefix: ['customer_', 'service_'] }, note: 'licence has no customer / service facts' });
  }
  return out;
}

/* ---------------------------------------------------------------- C4 typing by structure */
const FILL = ['All drivers must keep paperwork current and report changes to their supervisor within five days.', 'Managers review this list at the start of each quarter.', 'Records are kept in the personnel file for the length of employment.', 'Contact the office with any questions about this document.', 'Reviewed 06/30/2026. Effective 01/01/2026.'];
function genC4(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const head = pick(r, P.certHeads);
    const k = i % 6;
    let text; let note;
    if (k === 0) { text = ['Driver Safety Policy', pick(r, FILL), head, pick(r, FILL), pick(r, FILL)].join('\n'); note = 'heading inside a policy'; }
    else if (k === 1) { text = ['Annual Compliance Checklist', `[ ] ${head}`, '[ ] Safety training', head, 'Verify before dispatch', pick(r, FILL)].join('\n'); note = 'heading inside a checklist'; }
    else if (k === 2) { text = [pick(r, FILL), head, pick(r, FILL), 'Questions? Call the office.'].join('\n'); note = 'untitled page with the bare line'; }
    else if (k === 3) { text = ['Staff Memo', 'To: All drivers', `Please bring your ${head.replace(/ \(.*/, '')} to the next safety meeting.`, head, pick(r, FILL)].join('\n'); note = 'memo'; }
    else if (k === 4) { const t = pick(r, P.flyerTitles); text = [t, 'Position: Installer', 'Start Date: next month', 'Manager: see your lead', 'Salary: competitive', 'Rate of pay: depends on experience', 'Apply at the front desk.'].join('\n'); note = 'new-hire flyer with labels'; }
    else { const t = pick(r, P.titleHead) + ' ' + pick(r, P.titleTail); text = [t, 'Position: Installer', 'Start Date: 06/03/2025', 'Manager: Dana Sample', 'Salary: see HR', 'Details to follow.'].join('\n'); note = 'new-hire agenda / programme with labels'; }
    out.push({ cls: 'C4', split, id: `c4-${i}`, text, expect: { typeNot: ['license-certification', 'hr-letter'] }, note });
  }
  return out;
}
function genC4p(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const nm = person(r, P); const name = nm.printed.includes(',') ? `${nm.first} ${nm.last}` : nm.printed; const d = randDate(r, 2026, 2031);
    const k = i % 5;
    let text; let want;
    if (k === 0) { text = mecDoc(["Driver's Name", name], { exp: d.mdy }); want = 'license-certification'; }
    else if (k === 1) { text = ['DRIVER LICENSE', 'STATE OF EXAMPLEVILLE', 'DLN', num(r), 'CLASS', 'B', 'DOB 01/02/1980', 'ISS 03/15/2022', `4b EXP ${d.mdy}`, 'Name', `${nm.last}, ${nm.first}`].join('\n'); want = 'license-certification'; }
    else if (k === 2) { text = hrDoc(['Employee Name', name]); want = 'hr-letter'; }
    else if (k === 3) { text = tradeDoc([`Holder: ${name}`], { exp: d.iso }); want = 'license-certification'; }
    else { text = ['Employee Onboarding Checklist', 'Name', name, 'Start Date', d.mdy, 'Position', 'Installer']; text = text.join('\n'); want = 'hr-letter'; }
    out.push({ cls: 'C4p', split, id: `c4p-${i}`, text, expect: { typeIs: want }, note: `real paper kind ${k}` });
  }
  return out;
}

/* ---------------------------------------------------------------- C6 permit / licence-number row */
function genC6(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = pick(r, P.permitTitles); const row = pick(r, P.permitRows); const iss = pick(r, P.issuers);
    const text = [iss, '3778 Magnolia Cir', t, 'Warehouse lighting retrofit', `Permit No.   ELC25-${Math.floor(10000 + r() * 80000)}   Date Issued   3 Jan 2026`, 'Expires   2 Jul 2026', row, 'Owner   Verde Apartments LLC', 'All work shall comply with the adopted code.'].join('\n');
    out.push({ cls: 'C6', split, id: `c6-${i}`, text, expect: { typeNot: ['license-certification', 'hr-letter'], retypeNot: 'license-certification' }, note: `${t} with a licence-number row` });
  }
  return out;
}

/* ---------------------------------------------------------------- C5 / C7 lane */
const LANE_DOCS = (r, P) => {
  const a = person(r, P); const b = person(r, P);
  return { a, b };
};
function genC5(r, P, n, split) {
  const out = [];
  const nm = (p) => `${p.first} ${p.last}`;
  for (let i = 0; i < n; i++) {
    const k = i % 6;
    const a = person(r, P); let b = person(r, P); while (b.key === a.key || b.last === a.last || b.first === a.first) b = person(r, P);
    const cdl = { id: 'cdl', type: 'license-certification', text: `COMMERCIAL DRIVER LICENSE\nDLN: ${num(r)}   CLASS: A\nISS 03/15/2022   EXP 03/15/2032\nName: ${nm(a)}` };
    const hire = (p, d = '2026-09-01') => ({ id: 'hire-' + p.key, type: 'hr-letter', text: ['New Hire Checklist', 'Employee Name', nm(p), 'Position', 'Installer', `Start Date ${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`, 'Rate of Pay $27.50/hr', 'Supervisor', 'Dana Sample'].join('\n') });
    let docs; let q; let expect; let note;
    if (k === 0) { const qual = pick(r, P.unlicensed); docs = [cdl]; q = pick(r, [`When does ${nm(a)}'s ${qual} license expire?`, `What is ${nm(a)}'s ${qual} license number?`, `Is ${nm(a)}'s ${qual} license still current?`]); expect = { abstain: true }; note = `W1 ${qual} licence`; }
    else if (k === 1) { const what = pick(r, P.nonHrStart); docs = [hire(a)]; q = pick(r, [`When does ${nm(a)}'s ${what} start?`, `When did ${nm(a)}'s ${what} start?`, `What is the start date of ${nm(a)}'s ${what}?`]); expect = { abstain: true }; note = `W2 ${what}`; }
    else if (k === 2) { // the surname of one person is the first name of another: "Lee" for Ann Lee (CDL) and Lee Chang (new hire)
      const x = pick(r, P.first); const f1 = pick(r, P.first.filter((f) => f !== x)); const l2 = pick(r, P.last);
      docs = [{ ...cdl, text: cdl.text.replace(`Name: ${nm(a)}`, `Name: ${f1} ${x}`) }, hire({ first: x, last: l2, key: 'k2' })]; q = pick(r, [`When does ${x}'s CDL expire?`, `When does ${x}'s commercial driver license expire?`]); expect = { abstain: true }; note = 'W3 surname of one = first name of another'; }
    else if (k === 3) { // two people share a surname: "Smith's CDL"
      const c2 = { id: 'cdl2', type: 'license-certification', text: `COMMERCIAL DRIVER LICENSE\nDLN: ${num(r)}   CLASS: B\nISS 03/15/2022   EXP 03/15/2031\nName: ${b.first} ${a.last}` };
      docs = [cdl, c2]; q = pick(r, [`When does ${a.last}'s CDL expire?`, `When does ${a.last} CDL expire?`]); expect = { abstain: true }; note = 'tie: shared surname'; }
    else if (k === 4) { docs = [cdl]; q = pick(r, [`When does ${nm(a)}'s CDL expire?`, `When does ${nm(a)}'s commercial driver license expire?`, `Is ${nm(a)}'s CDL current?`]); expect = { answer: /2032|Yes/ }; note = 'positive: CDL expiry'; }
    else { docs = [hire(a)]; q = pick(r, [`What is ${nm(a)}'s start date?`, `When is ${nm(a)}'s first day?`, `What is ${a.first} ${a.last}'s hire date?`]); expect = { answer: /September 1, 2026/ }; note = 'positive: hire date'; }
    out.push({ cls: 'C5', split, id: `c5-${i}`, lane: { docs, q }, expect, note });
  }
  return out;
}

export function generate({ seed = 20261025, perClass = 60 } = {}) {
  const cases = { dev: [], holdout: [] };
  const sizes = { C1: perClass, C1p: Math.ceil(perClass / 2), C2: perClass, C3: perClass, C4: perClass, C4p: Math.ceil(perClass / 2), C6: perClass, C5: perClass };
  for (const split of ['dev', 'holdout']) {
    const r = rng(seed + (split === 'holdout' ? 7919 : 0)); const P = POOLS[split];
    cases[split].push(...genC1(r, P, sizes.C1, split), ...genC1p(r, P, sizes.C1p, split), ...genC2(r, P, sizes.C2, split), ...genC3(r, P, sizes.C3, split), ...genC4(r, P, sizes.C4, split), ...genC4p(r, P, sizes.C4p, split), ...genC6(r, P, sizes.C6, split), ...genC5(r, P, sizes.C5, split));
  }
  return cases;
}
