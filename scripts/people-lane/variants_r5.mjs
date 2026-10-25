// Round 5 variants: the evidence rule for a person's name (a given name people have, or the name printed twice). SYNTHETIC.
//   J    fresh 2-4 word name-shaped JUNK (equipment, crews, places, ranks, letters and numbers) on a holder / employee / manager / examiner label. Must read NOTHING.
//   Jtwo the same junk printed twice on the paper (header + label): by the rule that IS corroboration; reported apart so the cost is visible, not a gate.
//   R    real people: common names (must be read) and uncommon names (a recall MISS is allowed, a WRONG value is not); each reported.
// Fixed seeds; dev / holdout / blind use disjoint word lists so a rule tuned on one is measured on another.
import { rng } from './variants.mjs';
const pick = (r, a) => a[Math.floor(r() * a.length)];
const POOL = {
  dev: { adj: ['Standby', 'Night', 'Spare', 'Backup', 'Shared', 'Mobile', 'Rental', 'Loaner', 'Express', 'Primary'], noun: ['Tank', 'Cart', 'Hub', 'Van', 'Rig', 'Crew', 'Desk', 'Bay', 'Lot', 'Zone', 'Skid', 'Trailer'], tail: ['East', 'West', 'Alpha', 'Lead', 'Seven', 'Prime', 'Unit', 'Group', 'Pool'] },
  holdout: { adj: ['Yard', 'Satellite', 'Depot', 'Bulk', 'Main', 'Auxiliary', 'Temp', 'Overflow', 'Field', 'Remote'], noun: ['Forklift', 'Generator', 'Compressor', 'Pallet', 'Dock', 'Cage', 'Locker', 'Shed', 'Gate', 'Panel', 'Ladder', 'Scaffold'], tail: ['Bravo', 'North', 'Two', 'Captain', 'Section', 'Annex', 'Block', 'Row', 'Stack'] },
  blind: { adj: ['Quarry', 'Harbor', 'Summit', 'Canyon', 'Ridge', 'Metro', 'Orbit', 'Vertex', 'Granite', 'Cobalt'], noun: ['Dispatch', 'Ledger', 'Console', 'Kiosk', 'Terminal', 'Beacon', 'Relay', 'Vault', 'Bunker', 'Silo', 'Turbine', 'Boiler'], tail: ['Delta', 'South', 'Nine', 'Chief', 'Hall', 'Wing', 'Court', 'Level', 'Bench'] },
};
const NAMES = {
  common: ['Michael Johnson', 'Jennifer Davis', 'Robert Miller', 'Linda Wilson', 'David Moore', 'Sarah Taylor', 'Daniel Anderson', 'Maria Hernandez', 'Carlos Ramirez', 'Jose Martinez', 'Emily Clark', 'Brian Lewis', 'Karen Walker', 'Jason Hall', 'Laura Allen', 'Kevin Young', 'Amanda King', 'Steven Wright', 'Rachel Scott', 'Eric Green', 'Angela Baker', 'Justin Adams', 'Megan Nelson', 'Ryan Carter', 'Nicole Mitchell'],
  uncommon: ['Ximena Orozco', 'Thaddeus Bright', 'Marguerite Doyle', 'Lorcan Whelan', 'Yevgenia Marek', 'Tamsin Pryce', 'Evander Cole', 'Odalys Fuentes', 'Casimir Nowak', 'Perpetua Lund', 'Idris Okoro', 'Soledad Rivas', 'Anselm Fraser', 'Bronwyn Hale', 'Dashiell Park', 'Calliope Reyes', 'Lazarus Boone', 'Ottoline Grey', 'Jovan Petrovic', 'Marisela Duran'],
};
const FR = [
  (v, k) => k === 'holder' ? [`Driver's Name: ${v}`] : [`Employee Name: ${v}`], (v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v], (v, k) => k === 'holder' ? [`Holder: ${v}`] : [`Name: ${v}`], (v, k) => k === 'holder' ? [`Licensee: ${v}`] : ['New Hire Name', v],
];
const mec = (lines, extra = []) => ["Medical Examiner's Certificate", ...extra, ...lines, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026"].join('\n');
const hr = (lines, extra = []) => ['New Hire Checklist', ...extra, ...lines, 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Supervisor', 'Dana Sample'].join('\n');
const junk = (r, P) => { const n = 2 + Math.floor(r() * 3); const parts = [pick(r, P.adj), pick(r, P.noun), pick(r, P.tail)]; return (n === 2 ? [parts[0], parts[1]] : n === 3 ? parts : [...parts, pick(r, P.tail)]).join(' '); };
export function generateR5({ seed = 20261201, perClass = 60 } = {}) {
  const out = { dev: [], holdout: [], blind: [] };
  for (const split of ['dev', 'holdout', 'blind']) {
    const r = rng(seed + (split === 'holdout' ? 15485863 : split === 'blind' ? 32452843 : 0)); const P = POOL[split];
    for (let i = 0; i < perClass; i++) {
      const v = junk(r, P); const k = i % 3 === 0 ? 'holder' : 'emp'; const f = pick(r, FR)(v, k);
      out[split].push({ cls: 'J', split, id: `j-${i}`, text: k === 'holder' ? mec(f) : hr(f), expect: { noValue: v }, note: `junk "${v}" (${k})` });
      const v2 = junk(r, P); const f2 = pick(r, FR)(v2, k);
      out[split].push({ cls: 'Jmgr', split, id: `jm-${i}`, text: ['New Hire Checklist', 'New Hire Name', 'Alex Tester', 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Supervisor', v2].join('\n'), expect: { noValue: v2 }, note: `manager junk "${v2}"` });
      const v3 = junk(r, P); const f3 = pick(r, FR)(v3, k);
      out[split].push({ cls: 'Jtwo', split, id: `jt-${i}`, text: k === 'holder' ? mec(f3, [v3]) : hr(f3, [v3]), expect: { noValue: v3 }, note: `junk printed twice "${v3}"` });
    }
    for (const g of ['common', 'uncommon']) for (let i = 0; i < Math.ceil(perClass / 2); i++) {
      const nm = pick(r, NAMES[g]); const [first, last] = nm.split(' '); const k = i % 2 ? 'holder' : 'emp'; const f = pick(r, FR)(nm, k);
      out[split].push({ cls: g === 'common' ? 'Rc' : 'Ru', split, id: `r${g[0]}-${i}`, text: k === 'holder' ? mec(f) : hr(f), expect: { name: { key: k === 'holder' ? 'holder_name' : 'employee_name', person: { first, last } } }, note: `${g} name ${nm}` });
    }
  }
  return out;
}
