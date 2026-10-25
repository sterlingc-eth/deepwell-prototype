// Round 4 variants for the people / ID lane (verifier round 3 defects). SYNTHETIC: every name, number and place is invented. Fixed seed, two disjoint vocabularies
// (dev = tuned on, holdout = never looked at while fixing). Classes:
//   N1 names    real names that earlier rules rejected: -ed / -ing words, accents, a "Dr." / "Mrs." prefix, hyphen and particle names  (must be READ)
//   N2 junk     name-shaped junk (a vehicle pool, a crew, a seat) in a name field  (must NOT be read; vocabulary-bound residual, reported but not a gate)
//   N3 place    "City, State" where the state word may also be a first name ("Tucson, Washington")  (must NOT be read as a person)
//   N4 reg      vehicle registration: the issue date is kept ONCE (start_date), never as service_date; the company owner is not the holder
//   N5 hrc      an employee's phone, email and signed date are kept under HR keys (employee_phone / employee_email / signed_date), never customer_* / service_*
//   N6 typing   a noisy scan of a real new-hire sheet / photographed licence card keeps its type; flyers, bonus pages and policies that name them do not get it
import { rng } from './variants.mjs';

const pick = (r, a) => a[Math.floor(r() * a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const POOLS = {
  dev: {
    first: ['Mildred', 'Irving', 'Winnifred', 'Sinead', 'Ronald', 'Reginald', 'José', 'María', 'Zoë', 'Renée', 'Björn', 'Łukasz', 'Anneliese', 'Mohammed'],
    last: ['Ratched', 'Berlin', 'Thackeray-Lowe', 'Fielding', 'Walking', 'Waring', 'Booking', 'García', 'Martínez', 'Müller', 'Okonkwo', 'De La Cruz', 'Harding'],
    junk: ['Fleet Pool Vehicle', 'Spare Truck Eleven', 'Hourly Staff Member', 'Shared Crew Lead', 'Temp Labor Pool', 'General Fleet Unit'],
    cities: ['Tucson', 'Flagstaff', 'Yuma', 'Prescott', 'Kingman', 'Sedona'],
    states: [['WA', 'Washington'], ['VA', 'Virginia'], ['GA', 'Georgia'], ['IN', 'Indiana'], ['MT', 'Montana'], ['AZ', 'Arizona'], ['TX', 'Texas']],
    regLabel: ['Date Issued', 'Issue Date', 'Issued'],
    titles: ['New Hire Information Sheet', 'New Employee Intake Form', 'New Hire Worksheet'],
    flyers: ['New hire bonus program', 'New hire referral flyer', 'New Hire Orientation Agenda'],
  },
  holdout: {
    first: ['Winifred', 'Sterling', 'Manfred', 'Aurélie', 'Søren', 'Ángel', 'Inés', 'Dolores', 'Hildegard', 'Raymond', 'Clifford', 'Zacharias', 'Olufemi', 'Eilidh'],
    last: ['Pickering', 'Kipling', 'Manning', 'Gutiérrez', 'Hernández', 'Lindgren', 'Hayward', 'Trinity', 'Cushing', 'Abernathy', 'Van Der Berg', 'Nwosu-Bell', 'Redding'],
    junk: ['Backup Van Twelve', 'Yard Loaner Three', 'Open Seat Pending', 'Rental Generator Two', 'Shop Mule Four', 'Bench Stock Lot'],
    cities: ['Bisbee', 'Payson', 'Casa Grande', 'Lake Havasu', 'Show Low', 'Nogales'],
    states: [['WA', 'Washington'], ['CA', 'California'], ['NM', 'New Mexico'], ['OH', 'Ohio'], ['MI', 'Michigan'], ['VA', 'Virginia'], ['DC', 'Columbia']],
    regLabel: ['Registration Issued', 'Date of Issue', 'Issued On'],
    titles: ['Employee Onboarding Information Form', 'New Hire Setup Form', 'New Staff Data Sheet'],
    flyers: ['New hire welcome event', 'New hire parking policy', 'New Hire Pay Day Reminder'],
  },
  // BLIND: a third vocabulary written after the fixes and run once (--blind); nothing was tuned on it
  blind: {
    first: ['Gwendolyn', 'Lamar', 'Rosalind', 'Bertrand', 'Jesús', 'Zoé', 'Ingeborg', 'Fitzgerald', 'Alistair', 'Ximena', 'Wilhelmina', 'Cornelius', 'Désirée', 'Radhika'],
    last: ['Wakeling', 'Pettibone', 'Hollander', 'Ibáñez', 'Nuñez', 'Stirling', 'Greenleaf', 'Thorsen', 'Ballard', 'MacAllister', 'Oyelaran', 'Abdel-Rahman', 'Quintanilla'],
    junk: ['Loaner Sedan Nine', 'Warehouse Cart Two', 'Overflow Desk Lead', 'Contract Hire Slot', 'Standby Rig Five', 'Parts Cage Zone'],
    cities: ['Douglas', 'Wickenburg', 'Globe', 'Safford', 'Winslow', 'Cottonwood'],
    states: [['WA', 'Washington'], ['CO', 'Colorado'], ['OR', 'Oregon'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['MD', 'Maryland'], ['GA', 'Georgia']],
    regLabel: ['Registered On', 'Issued Date', 'Date Issued'],
    titles: ['Newly Hired Employee Information Form', 'New Hire Data Record', 'New Hire Details Sheet'],
    flyers: ['New hire lunch invitation', 'New hire bonus rules', 'New Hire Dress Code'],
  },
};
const mdy = (y, m, d) => `${pad(m)}/${pad(d)}/${String(y).slice(2)}`;
const rd = (r) => { const y = 2026 + Math.floor(r() * 4); const m = 1 + Math.floor(r() * 12); const d = 1 + Math.floor(r() * 28); return { mdy: mdy(y, m, d), iso: `${y}-${pad(m)}-${pad(d)}`, y, m, d }; };
const fix = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');

const HOLDER = [(v) => [`Driver's Name: ${v}`], (v) => ["Driver's Name", v], (v) => [`Licensee: ${v}`], (v) => [`Holder: ${v}`], (v) => ['Name of Driver', v]];
const EMP = [(v) => [`Employee Name: ${v}`], (v) => ['Employee Name', v], (v) => [`New Hire: ${v}`], (v) => [`Name: ${v}`], (v) => ['New Hire Name', v]];
const mec = (holder) => ["Medical Examiner's Certificate", ...holder, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026"].join('\n');
const hr = (nm) => ['New Hire Checklist', ...nm, 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Rate of Pay $27.50/hr', 'Supervisor', 'Dana Sample'].join('\n');

function N1(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = pick(r, P.first), l = pick(r, P.last);
    const pre = r() < 0.3 ? pick(r, ['Dr.', 'Mrs.', 'Mr.', 'Ms.']) + ' ' : '';
    const printed = r() < 0.2 ? `${f.toUpperCase()} ${l.toUpperCase()}` : `${pre}${f} ${l}`;
    const person = { first: f, last: l };
    if (i % 2) { const k = Math.floor(r() * HOLDER.length); out.push({ cls: 'N1', split, id: `n1-h${i}`, text: mec(HOLDER[k](printed)), expect: { name: { key: 'holder_name', person } }, note: `holder "${printed}"` }); }
    else { const k = Math.floor(r() * EMP.length); out.push({ cls: 'N1', split, id: `n1-e${i}`, text: hr(EMP[k](printed)), expect: { name: { key: 'employee_name', person } }, note: `employee "${printed}"` }); }
  }
  return out;
}
function N2(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = pick(r, P.junk);
    if (i % 2) { const k = Math.floor(r() * HOLDER.length); out.push({ cls: 'N2', split, id: `n2-h${i}`, text: mec(HOLDER[k](v)), expect: { noValue: v }, note: `holder junk "${v}"` }); }
    else { const k = Math.floor(r() * EMP.length); out.push({ cls: 'N2', split, id: `n2-e${i}`, text: hr(EMP[k](v)), expect: { noValue: v }, note: `employee junk "${v}"` }); }
  }
  return out;
}
function N3(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = pick(r, P.cities); const [ab, full] = pick(r, P.states);
    const v = pick(r, [`${c}, ${full}`, `${c}, ${ab}`, `${c.toUpperCase()}, ${full.toUpperCase()}`]);
    const t = i % 3;
    if (t === 0) out.push({ cls: 'N3', split, id: `n3-h${i}`, text: mec(pick(r, HOLDER)(v)), expect: { noValue: c }, note: `holder place "${v}"` });
    else if (t === 1) out.push({ cls: 'N3', split, id: `n3-e${i}`, text: hr(pick(r, EMP)(v)), expect: { noValue: c }, note: `employee place "${v}"` });
    else out.push({ cls: 'N3', split, id: `n3-m${i}`, text: ['New Hire Checklist', 'New Hire Name', 'Alex Tester', 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Supervisor', v].join('\n'), expect: { noValue: c }, note: `manager place "${v}"` });
  }
  return out;
}
function N4(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const iss = rd(r); const exp = { ...iss, y: iss.y + 1, iso: `${iss.y + 1}-${pad(iss.m)}-${pad(iss.d)}` }; const expS = mdy(exp.y, exp.m, exp.d);
    const lab = pick(r, P.regLabel); const company = pick(r, ['Sidewinder Equipment Rental', 'Ridgeline Hauling Co', 'Mesa Pipe and Supply LLC', 'Bright Desert Landscaping']);
    const layout = i % 3;
    const body = layout === 0
      ? [`Year / Make / Model: 2019 Ironbell Trailers IB-14D Dump ${lab}: ${iss.mdy}`, 'Trailer 14 ft', '', `Expiration: ${expS} Registration Fee: $110.50`]
      : layout === 1 ? [`${lab}: ${iss.mdy}`, `Expiration: ${expS}`, 'Gross Vehicle Weight: 14,000 lb']
      : [`${lab}: ${iss.mdy}   Expiration: ${expS}`, 'Gross Vehicle Weight: 14,000 lb'];
    const text = ['Valley Vehicle Titles and Registration Office', '7065 N Windmill Pkwy', 'Phoenix, AZ 85001', '', 'VEHICLE REGISTRATION', '', 'Commercial / trailer', 'Plate:', `MCA ${1000 + Math.floor(r() * 8999)}`, `VIN: 1HGCM82633A${100000 + Math.floor(r() * 899999)}`, ...body, '', 'REGISTERED OWNER', company, '3789 E Cactus Ln', 'Chandler, AZ 85272'].join('\n');
    out.push({ cls: 'N4', split, id: `n4-${i}`, filename: 'Registration.jpg', text, expect: { fieldEq: { start_date: iso(iss), end_date: iso(exp) }, noKeyPrefix: ['service_', 'customer_'], noValue: 'zzz' }, note: `layout ${layout} "${lab}"` });
  }
  return out;
}
const iso = (d) => d.iso;
const NHT = (name, phone, email, start, mgr = 'Dana Sample') => `Blue Agave Catering - New Hire Information Sheet\nPlease print clearly. Return to HR on your first day.\n\n\n Employee\n\nFULL NAME                                                                  PHONE\n\n ${name}                                                           ${phone}\nHOME ADDRESS                                                               EMAIL\n\n 8392 S Verde Alamo Ave, Mesa, AZ 85201                                      ${email}\nPOSITION                                            DEPARTMENT                          START DATE\n\n HVAC Installer                                         Transportation                     ${start}\nREPORTS TO / MANAGER\n\n ${mgr}\n`;
const DDF = (name, date) => `Direct Deposit Authorization Form\nKestrel Ridge Plumbing - Payroll Department\n\n\nI authorize the employer named above to deposit my net pay into the account listed below. This\nauthorization remains in effect until I cancel it in writing. (SAMPLE FORM - routing and account\nnumbers are invented and invalid.)\nEMPLOYEE NAME                                                               DATE\n\n ${name}                                                           ${date}\nBANK NAME                                                                   ACCOUNT TYPE\n\n Sample Desert Bank                                                         Savings\nABA ROUTING NUMBER (9 DIGITS)                                               ACCOUNT NUMBER\n\n 021000021                                                                  000123456789\n`;
function N5(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = pick(r, P.first), l = pick(r, P.last); const d = rd(r);
    const ph = `(${pick(r, ['480', '602', '623'])}) 555-${pad(Math.floor(r() * 10000), 4)}`; const em = `${fix(f).toLowerCase().replace(/[^a-z]/g, "")}.${fix(l).toLowerCase().replace(/[^a-z]/g, "")}@example.com`;
    if (i % 2) out.push({ cls: 'N5', split, id: `n5-n${i}`, text: NHT(`${f} ${l}`, ph, em, `${pad(d.m)}/${pad(d.d)}/${d.y}`), expect: { fieldEq: { employee_phone: ph, employee_email: em }, noKeyPrefix: ['customer_', 'service_'] }, note: 'new-hire sheet phone + email' });
    else out.push({ cls: 'N5', split, id: `n5-d${i}`, text: DDF(`${f} ${l}`, `${pad(d.m)}/${pad(d.d)}/${d.y}`), expect: { fieldEq: { signed_date: d.iso }, noKeyPrefix: ['customer_', 'service_'] }, note: 'direct-deposit signed date' });
  }
  return out;
}
// OCR noise: the label survives, what handwriting or a photo adds after it is junk
const NOISE = ['(_} \\a', 'Y \\aa ) L', '= ee Nea', '|_ Raa', ':( AE a', '— ;', 'oO.'];
function N6(r, P, n, split) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const nz = () => pick(r, NOISE);
    const title = pick(r, P.titles);
    const labels = [`New Hire Name:${nz()}`, `Position: ${nz()}`, `Start Date: ${nz()}`, `Employee Number: ${nz()}`];
    const drop = Math.floor(r() * 4); // always keep the name label and at least two of the other three HR labels, plus an Email line (not an HR label)
    const keep = labels.filter((_, j) => j === 0 || j !== drop || r() < 0.3); keep.push(`Email: ${nz()}`);
    out.push({ cls: 'N6', split, id: `n6-h${i}`, text: [title.replace(/^(New Hire|Employee|New Staff|New Employee)/, 'New Hire'), ...keep].join('\n'), expect: { typeIs: 'hr-letter' }, note: 'noisy new-hire sheet keeps hr-letter' });
    const d1 = rd(r), d2 = rd(r);
    const card = [nz(), 'a Aaa', `${pick(r, ['DRIVER LICENSE', "DRIVER'S LICENSE", 'ARIZONA DRIVER LICENSE'])} ${nz()}`, `${Math.floor(10000000 + r() * 89999999)} A AAA |`, `DOB ${d1.mdy.replace(/\/\d\d$/, '/19' + (60 + Math.floor(r() * 30)))}`, nz(), `${d1.mdy.replace(/\/\d\d$/, '/' + d1.y)} ${d2.mdy.replace(/\/\d\d$/, '/' + d2.y)}`, nz()].join('\n');
    out.push({ cls: 'N6', split, id: `n6-c${i}`, text: card, expect: { typeIs: 'license-certification' }, note: 'noisy licence photo keeps license-certification' });
    const fl = pick(r, P.flyers);
    out.push({ cls: 'N6', split, id: `n6-f${i}`, text: [fl, 'Position: Installer', 'Start Date: next month', 'Manager: see your lead', 'Salary: competitive', 'Apply at the front desk.'].join('\n'), expect: { typeNot: ['hr-letter', 'license-certification'] }, note: 'flyer / bonus page is not an HR paper' });
    out.push({ cls: 'N6', split, id: `n6-p${i}`, text: ['Driver Safety Policy', 'Every driver must carry a valid driver license while on duty.', 'Renewal is due before the expiration date shown on the card.', `Reviewed ${d1.mdy.replace(/\/\d\d$/, '/' + d1.y)} and ${d2.mdy.replace(/\/\d\d$/, '/' + d2.y)}.`, 'Call 480-555-0100 with questions.'].join('\n'), expect: { typeNot: ['license-certification', 'hr-letter'] }, note: 'driver policy with dates is not a licence' });
  }
  return out;
}
export function generateR4({ seed = 20261031, perClass = 40 } = {}) {
  const cases = { dev: [], holdout: [], blind: [] };
  for (const split of ['dev', 'holdout', 'blind']) {
    const r = rng(seed + (split === 'holdout' ? 104729 : split === 'blind' ? 1299709 : 0)); const P = POOLS[split];
    cases[split].push(...N1(r, P, perClass, split), ...N2(r, P, perClass, split), ...N3(r, P, perClass, split), ...N4(r, P, perClass, split), ...N5(r, P, perClass, split), ...N6(r, P, perClass, split));
  }
  return cases;
}
