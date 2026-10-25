// Round 6 variants. SYNTHETIC. Fixed seeds; dev / holdout / blind use disjoint vocabularies.
//   O    a given-name-first ORGANISATION / PLACE / UNIT phrase ("Dallas Branch", "Jordan Valley Clinic") on a holder / employee label. Must read NOTHING. The class words in holdout / blind are NOT in the rule's word list, on purpose.
//   T    junk (or a given-name-first phrase) printed TWICE as a header and a body line, no signature. Must read NOTHING (two arbitrary repeats are not corroboration).
//   Us   uncommon REAL names (Spanish, Vietnamese, Navajo, Arabic, hyphenated, Polynesian ...) on the label's own line. Recall: reported, a miss is allowed.
//   Ug   the same people whose first AND last names the lists do not know, label + signature line (rule b). Recall: reported.
//   Un   the same unknown names with NO signature. A miss is the design (reported as recall cost, never a wrong value).
import { rng } from './variants.mjs';
const pick = (r, a) => a[Math.floor(r() * a.length)];
const GIVEN = { dev: ['Dallas', 'Austin', 'Jordan', 'Madison', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Jamie', 'Cameron'], holdout: ['Sydney', 'Phoenix', 'Reagan', 'Parker', 'Logan', 'Dakota', 'Skyler', 'Emerson', 'Rowan', 'Harper', 'Blake', 'Kendall'], blind: ['Aspen', 'Sage', 'Finley', 'Drew', 'Devon', 'Shannon', 'Lindsay', 'Peyton', 'Tracy', 'Kelly', 'Sidney', 'Robin'] };
const CLS = { dev: ['Branch', 'Office', 'Clinic', 'Center', 'Team', 'Fleet', 'Program', 'Dept', 'Warehouse', 'Depot', 'Crew', 'Annex'], holdout: ['Outpost', 'Substation', 'Pavilion', 'Roundhouse', 'Refinery', 'Foundry', 'Cooperative', 'Brigade', 'Detachment', 'Chapter', 'Wharf', 'Hangar', 'Branch', 'Office', 'Team', 'Program', 'Clinic', 'Center'], blind: ['Granary', 'Hatchery', 'Creamery', 'Depository', 'Mortuary', 'Aquarium', 'Pottery', 'Plantation', 'Lighthouse', 'Greenway', 'Stockyard', 'Boathouse', 'Courtyard', 'Playground', 'Treatment', 'Restaurant'] };
const MID = { dev: ['Valley', 'North', 'Metro', 'East'], holdout: ['Lakeside', 'Harbor', 'Summit', 'Central'], blind: ['Granite', 'Pioneer', 'Heritage', 'Coastal'] };
const NAMES = {
  dev: ['Dzung Pham', 'Yazmin Begay', 'Khalid Al-Hamdan', 'Nizhoni Yazzie', 'Rashid Haddad', 'Xochitl Mendoza', 'Siosaia Tupou', 'Quang Huynh', 'Itzel Castillo', 'Hyun-Woo Kim', 'Kele Tsosie', 'Mansour Saleh', 'Thanh-Binh Vo', 'Yaretzi Salazar', 'Dilnoza Karimi'],
  holdout: ['Bao-Ngoc Truong', 'Lyle Benally', 'Zaid Mansour', 'Citlali Vasquez', 'Ahlam Najjar', 'Duc Dang', 'Tahnee Nez', 'Mele Fonoa', 'Jun-Seo Park', 'Anselmo Delgado', 'Hamza Qureshi', 'Ngoc-Lan Bui', 'Shandiin Largo', 'Farida Aziz', 'Xitlali Guerrero'],
  blind: ['Tuyet Ngo', 'Kaleb Chee', 'Samir Awad', 'Ixchel Ibarra', 'Phuong Duong', 'Marisela Zuniga', 'Naalnish Etsitty', 'Omar Khoury', 'Se-Yeon Choi', 'Leilani Leota', 'Yasmin Siddiqui', 'Bao Hoang', 'Teodoro Valenzuela', 'Haneen Habib', 'Vui Lam'],
};
const UNK = {
  dev: ['Thaddeus Wrenfield', 'Eilidh Cunninghame', 'Tamsin Pryce', 'Lorcan Whelan', 'Evander Cole', 'Odalys Thornbury'],
  holdout: ['Gwendolyn Aldershot', 'Aoife Mulcahy', 'Marguerite Doyle', 'Anselm Fraser', 'Perpetua Wolverton', 'Casimir Hartnell'],
  blind: ['Ottoline Marchbanks', 'Cormac Tierney', 'Wilhelmina Ashgrove', 'Leopold Brannigan', 'Philomena Quigley', 'Barnaby Pettigrew'],
};
const FR = [(v, k) => k === 'holder' ? [`Driver's Name: ${v}`] : [`Employee Name: ${v}`], (v, k) => k === 'holder' ? [`Holder: ${v}`] : [`Name: ${v}`], (v, k) => k === 'holder' ? [`Licensee: ${v}`] : [`New Hire Name: ${v}`], (v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v]];
const mec = (lines, extra = [], tail = []) => ["Medical Examiner's Certificate", ...extra, ...lines, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026", ...tail].join('\n');
const hr = (lines, extra = [], tail = []) => ['New Hire Checklist', ...extra, ...lines, 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Supervisor', 'Dana Sample', ...tail].join('\n');
const SIG = [(v) => [`Employee Signature: ${v}`], (v) => ['Printed Name', v], (v) => ['__________________', v], (v) => [`Signed: ${v}`]];
const phrase = (r, s) => { const g = pick(r, GIVEN[s]); const t = r(); return t < 0.4 ? `${g} ${pick(r, CLS[s])}` : t < 0.8 ? `${g} ${pick(r, MID[s])} ${pick(r, CLS[s])}` : `${g} ${pick(r, GIVEN[s])} ${pick(r, CLS[s])}`; };
export function generateR6({ seed = 20261301, perClass = 60 } = {}) {
  const out = { dev: [], holdout: [], blind: [] };
  for (const split of ['dev', 'holdout', 'blind']) {
    const r = rng(seed + (split === 'holdout' ? 15485863 : split === 'blind' ? 32452843 : 0));
    for (let i = 0; i < perClass; i++) {
      const k = i % 2 ? 'holder' : 'emp';
      const v = phrase(r, split); const f = pick(r, FR)(v, k);
      out[split].push({ cls: 'O', split, id: `o-${i}`, text: k === 'holder' ? mec(f) : hr(f), expect: { noValue: v }, note: `org/place phrase "${v}" (${k})` });
      const v2 = phrase(r, split); const f2 = pick(r, FR)(v2, k);
      out[split].push({ cls: 'T', split, id: `t-${i}`, text: k === 'holder' ? mec(f2, [v2], [v2]) : hr(f2, [v2], [v2]), expect: { noValue: v2 }, note: `phrase printed twice "${v2}" (${k})` });
    }
    for (let i = 0; i < perClass; i++) {
      const nm = pick(r, NAMES[split]); const [first, ...rest] = nm.split(' '); const last = rest.join(' '); const k = i % 2 ? 'holder' : 'emp'; const f = pick(r, FR)(nm, k);
      out[split].push({ cls: 'Us', split, id: `us-${i}`, text: k === 'holder' ? mec(f) : hr(f), expect: { name: { key: k === 'holder' ? 'holder_name' : 'employee_name', person: { first, last } } }, note: `uncommon "${nm}" (${k})` });
    }
    for (let i = 0; i < Math.ceil(perClass / 2); i++) {
      const nm = pick(r, UNK[split]); const [first, last] = nm.split(' '); const k = i % 2 ? 'holder' : 'emp'; const f = pick(r, FR)(nm, k); const key = k === 'holder' ? 'holder_name' : 'employee_name';
      out[split].push({ cls: 'Ug', split, id: `ug-${i}`, text: k === 'holder' ? mec(f, [], pick(r, SIG)(nm)) : hr(f, [], pick(r, SIG)(nm)), expect: { name: { key, person: { first, last } } }, note: `unknown name + signature "${nm}" (${k})` });
      out[split].push({ cls: 'Un', split, id: `un-${i}`, text: k === 'holder' ? mec(f) : hr(f), expect: { name: { key, person: { first, last } } }, note: `unknown name, no signature "${nm}" (${k})` });
    }
  }
  return out;
}
