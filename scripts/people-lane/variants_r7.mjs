// Round 7 variants. SYNTHETIC. Fixed seeds; dev / holdout / blind use disjoint vocabularies (the code was tuned on dev only).
//   Nx   uncommon REAL names (Spanish, Vietnamese given-first, Navajo, Arabic, Polynesian ...) with the value on the line AFTER a person-name label that stands alone. Recall.
//   Nj   a junk phrase on the line after a label that stands alone ("Driver's Name" / "Dallas Branch"). Must read NOTHING.
//   Vf   Vietnamese names written family-name-first, printed once, on the label's line or the line after it. Recall.
//   Vj / Kj / Cj   junk that starts with a Vietnamese / Korean / Chinese family name ("Dang Warehouse", "Kim Tool Room", "Lin Valve Room"). Must read NOTHING.
//   Kf / Cf        Korean / Chinese (pinyin) names family-name-first. Recall.
//   Pw / Ps        a given name + a short unseen noun ("Jordan Gear") on a WEAK label (Manager, Supervisor, Reports To, bare Name) / a STRONG label (Driver's Name, Employee Name). Wrong value = accepted.
//   Pq             the same phrases printed twice (header + body), no signature. Wrong value = accepted.
//   Pk             real Korean names ending in Park ("Ji-hoon Park") on weak and strong labels. Recall.
//   Pe             real English-word surnames the common list lacks ("Dana Bright", "Casey Silver") on strong and weak labels. Recall (cost of the ambiguous-word rule).
import { rng } from './variants.mjs';
const pick = (r, a) => a[Math.floor(r() * a.length)];
const mec = (lines, extra = [], tail = []) => ["Medical Examiner's Certificate", ...extra, ...lines, "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026", ...tail].join('\n');
const hr = (lines, extra = [], tail = [], noSup = false) => ['New Hire Checklist', ...extra, ...lines, 'Position', 'Field Technician', 'Start Date 06/03/2025', ...(noSup ? [] : ['Supervisor', 'Dana Sample']), ...tail].join('\n');
const sheet = (k, lines, extra, tail) => (k === 'holder' ? mec(lines, extra, tail) : hr(lines, extra, tail, lines.some((l) => /^(?:Supervisor|Reports To|Manager)\b/.test(l))));
const KEY = (k) => (k === 'holder' ? 'holder_name' : 'employee_name');
// strong person labels, label ALONE on its line with the value under it, and the same label with the value on its line
const nextFr = [(v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v], (v, k) => k === 'holder' ? ['Licensee', v] : ['New Hire Name', v], (v, k) => k === 'holder' ? ['Holder', v] : ['Employee Name', v], (v, k) => k === 'holder' ? ["Cardholder's Name", v] : ['Name', v]];
const sameFr = [(v, k) => k === 'holder' ? [`Driver's Name: ${v}`] : [`Employee Name: ${v}`], (v, k) => k === 'holder' ? [`Holder: ${v}`] : [`New Hire Name: ${v}`], (v, k) => k === 'holder' ? [`Licensee: ${v}`] : [`Employee Name: ${v}`]];
const WEAK_HR = [(v) => [`Supervisor: ${v}`], (v) => [`Reports To: ${v}`], (v) => [`Manager: ${v}`], (v) => [`Name: ${v}`]];
const weakFr = [(v, k, r) => (k === 'holder' ? [`Name: ${v}`] : WEAK_HR[Math.floor(r() * WEAK_HR.length)](v))];
const ANYKEY = ['holder_name', 'employee_name', 'manager'];
const strongFr = [(v, k) => k === 'holder' ? [`Driver's Name: ${v}`] : [`Employee Name: ${v}`], (v, k) => k === 'holder' ? [`Holder: ${v}`] : [`New Hire Name: ${v}`], (v, k) => k === 'holder' ? ["Driver's Name", v] : ['Employee Name', v]];

const NX = {
  dev: ['Xuan Hoang', 'Kiet Lam', 'Ixtli Zavala', 'Naomi Yazzie', 'Rafiq Mansour', 'Sione Faleolo', 'Anahi Ibarra', 'Tiare Vaiola', 'Bao-Chau Dinh', 'Jamal Hashemi', 'Esperanza Valenzuela', 'Thandi Mokoena'],
  holdout: ['Khoa Bui', 'Dinh Truong', 'Yolotzin Acosta', 'Alchesay Nakai', 'Karim Najjar', 'Lupe Leota', 'Citlalli Barrera', 'Hoang-Anh Ngo', 'Farah Siddiqui', 'Marisol Cervantes', 'Ahmad Habib', 'Oanh Duong', 'Oluwaseun Adebayo'],
  blind: ['Hieu Vo', 'Tuong Phan', 'Zitlali Campos', 'Nalani Tuilagi', 'Hamid Khoury', 'Dolores Maldonado', 'Anh Lam', 'Chenoa Begay', 'Idris Awad', 'Mele Tupou', 'Tendai Moyo'],
};
const VF = {
  dev: ['Nguyen Van Minh', 'Tran Thi Lan', 'Le Hoai Nam', 'Pham Duc Thanh', 'Hoang Minh Tuan', 'Phan Thi Ngoc', 'Vu Quang Huy', 'Dang Van Long', 'Bui Thi Mai', 'Do Van Hung', 'Ho Thanh Tam', 'Ngo Bao Chau', 'Duong Thi Hoa', 'Ly Minh Khoi'],
  holdout: ['Nguyen Thi Kim Anh', 'Tran Van Hieu', 'Le Thi Thu', 'Pham Quoc Bao', 'Hoang Van Dung', 'Phan Huu Phuoc', 'Vu Thi Hanh', 'Dang Thi Nhung', 'Bui Van Tuan', 'Do Thi Lien', 'Ho Dac Thang', 'Ngo Phuoc Loc', 'Duong Van Tai', 'Ly Gia Han', 'Trinh Cong Son', 'Dinh Tien Dung', 'Lam Hong Nhung', 'Truong Van Khanh', 'Vo Thanh Liem', 'Huynh Ngoc Trai'],
  blind: ['Nguyen Hoang Long', 'Tran Quoc Khanh', 'Le Van Hiep', 'Pham Thi Hanh', 'Hoang Thi Thuy', 'Vu Duc Anh', 'Dang Minh Quan', 'Bui Xuan Truong', 'Do Thi Thao', 'Ngo Van Tam', 'Luong Van Tien', 'Cao Thi Lien'],
};
const KF = {
  dev: ['Kim Min-jun', 'Park Ji-hoon', 'Lee Seo-yeon', 'Choi Hyun-woo', 'Jung Soo-jin', 'Kang Dong-hyun', 'Cho Eun-ji', 'Yoon Tae-yang', 'Jang Ye-rin', 'Lim Jae-won', 'Han Seul-gi', 'Shin Min-ho', 'Kim Min Jun'],
  holdout: ['Kim Do-yoon', 'Park Seo-jun', 'Lee Ha-eun', 'Choi Ji-woo', 'Jung Min-seo', 'Kang Hae-in', 'Cho Yu-na', 'Yoon Chae-won', 'Oh Seung-hyun', 'Hwang Bo-ra', 'Ahn Joo-won', 'Song Gun-woo', 'Baek Kyu-ri', 'Seo Ji-an', 'Lee Ji Hoon'],
  blind: ['Kim Ha-neul', 'Park Min-jae', 'Lee Do-hyun', 'Choi Seo-ah', 'Jung Yeon-woo', 'Kang Ji-min', 'Yoon Sung-min', 'Han Ye-jin', 'Lim So-young', 'Shin Hyo-jin'],
};
const CF = {
  dev: ['Wang Wei', 'Li Na', 'Zhang Min', 'Liu Yang', 'Chen Jing', 'Huang Lei', 'Zhao Hui', 'Wu Xiaoming', 'Zhou Jie', 'Sun Yan', 'Xu Ming', 'Lin Fang'],
  holdout: ['Zhang Wenjie', 'Li Shuhua', 'Wang Zhihao', 'Chen Meiling', 'Huang Yuxuan', 'Liu Qiang', 'Yang Xiaoyu', 'Zhu Jianguo', 'Gao Peiyi', 'Tang Zimo', 'Xie Haotian', 'Deng Siqi', 'Luo Yihan'],
  blind: ['Zhao Mingyu', 'Sun Weiwei', 'Zhou Ruoxi', 'Wu Jinyu', 'He Ziyi', 'Guo Xiaolong', 'Ma Chunhua', 'Hu Yuting', 'Lin Zhenhua', 'Feng Haoran'],
};
const VJ = {
  dev: ['Dang Warehouse', 'Bui Truck Lot', 'Ho Shift Lead', 'Ngo Tool Crib', 'Le Pump Room', 'Ly Bay Door', 'Mai Yard Gate', 'Truong Valve Stock', 'Lam Gear Box', 'Pham Fuel Tank', 'Vo Boiler Room', 'Phan Dock Door'],
  holdout: ['Duong Parts Cage', 'Dinh Loading Bay', 'Trinh Pipe Rack', 'Huynh Coil Shop', 'Cao Rail Yard', 'Doan Hose Reel', 'Luu Wire Cage', 'Ta Beam Lot', 'Ha Slab Pour', 'Tran Plug Test', 'Nguyen Joint Crew', 'Hoang Vent Hood', 'Do Cart Bay', 'Vu Fan Deck'],
  blind: ['Le Drum Store', 'Bui Crate Dock', 'Dang Flue Test', 'Pham Stack Line', 'Mai Rack Room', 'Vo Pipe Shop', 'Ngo Mill Room', 'Ho Lead Crew'],
};
const KJ = {
  dev: ['Kim Tool Room', 'Lee Pump Shed', 'Park Loading Dock', 'Song Bird Feeder', 'Moon Light Inn', 'Han Gear Box', 'Cho Fuel Tank', 'Yoon Boiler Room'],
  holdout: ['Kim Hose Reel', 'Lee Pipe Rack', 'Park Wire Cage', 'Song Coil Shop', 'Han Rail Yard', 'Choi Vent Hood', 'Jung Parts Cage', 'Kang Beam Lot', 'Oh Drum Store', 'Seo Flue Test'],
  blind: ['Kim Mill Room', 'Lee Lead Crew', 'Park Shift Lead', 'Yang Stack Line', 'Baek Rack Room', 'Shin Crate Dock'],
};
const CJ = {
  dev: ['Lin Valve Room', 'Hu Gear Box', 'Tang Shift Lead', 'Wu Pump Shed', 'Ma Boiler Room', 'Wang Tool Crib', 'Li Truck Lot', 'He Fuel Tank'],
  holdout: ['Lin Hose Reel', 'Li Pipe Rack', 'Wang Wire Cage', 'Zhang Coil Shop', 'Chen Rail Yard', 'Liu Vent Hood', 'Zhao Parts Cage', 'Sun Beam Lot', 'Zhou Drum Store', 'Xu Flue Test'],
  blind: ['Lin Mill Room', 'Wu Lead Crew', 'Ma Shift Lead', 'He Stack Line', 'Gao Rack Room', 'Guo Crate Dock'],
};
const GIVEN = { dev: ['Jordan', 'Carmen', 'Casey', 'Rich', 'Dana', 'Morgan', 'Riley', 'Austin', 'Dallas', 'Sierra', 'Madison', 'Florence'], holdout: ['Taylor', 'Sydney', 'Logan', 'Parker', 'Skyler', 'Kendall', 'Brooklyn', 'Savannah', 'Victoria', 'Lincoln', 'Jackson', 'Chandler'], blind: ['Avery', 'Quinn', 'Rowan', 'Harper', 'Blake', 'Cameron', 'Reagan', 'Emerson', 'Denver', 'Paris', 'Camden', 'Tyler'] };
// short nouns (the rule's reach), long nouns (outside it), and Park
const SHORT = { dev: ['Mill', 'Lead', 'Shift', 'Gear', 'Tank', 'Bolt', 'Fuel', 'Ramp', 'Bin', 'Crib', 'Hoist', 'Park'], holdout: ['Vent', 'Pipe', 'Rail', 'Stack', 'Slab', 'Joint', 'Flue', 'Hose', 'Plug', 'Drum', 'Coil', 'Beam', 'Duct', 'Cart', 'Rack', 'Crate', 'Valve', 'Wire', 'Park'], blind: ['Press', 'Lathe', 'Weld', 'Cable', 'Truss', 'Girder', 'Gauge', 'Shaft', 'Pallet', 'Bucket', 'Park'] };
const LONG = { dev: ['Hardware', 'Outfitters', 'Foreman', 'Tavern'], holdout: ['Forklift', 'Conveyor', 'Scaffold', 'Backhoe', 'Dumpster', 'Compressor', 'Greenway', 'Playground', 'Smelter'], blind: ['Excavator', 'Pavilion', 'Swingset', 'Trenchbox', 'Rebar', 'Girders'] };
const KPARK = { dev: ['Ji-hoon Park', 'Seo-yeon Park', 'Min Park', 'Hyun-woo Park', 'Soo-jin Park', 'Dong-hyun Park'], holdout: ['Eun-ji Park', 'Tae-yang Park', 'Ha-eun Park', 'Jae-won Park', 'Min-jun Park', 'Yu-na Park', 'Seul-gi Park'], blind: ['Do-yoon Park', 'Ye-rin Park', 'Joo-won Park', 'Chae-won Park'] };
const ENGSUR = { dev: ['Dana Bright', 'Casey Silver', 'Morgan Swan', 'Riley Bacon', 'Jamie Hammer', 'Taylor Glass'], holdout: ['Quinn Wren', 'Avery Fish', 'Logan Sage', 'Parker Hawk', 'Drew Moon', 'Blake Fern', 'Casey Lake', 'Rowan Hart', 'Jesse Pearl'], blind: ['Morgan Gale', 'Dana Swift', 'Riley Hope', 'Kendall Rudd'] };
const SIG = [(v) => [`Employee Signature: ${v}`], (v) => ['Printed Name', v], (v) => ['__________________', v], (v) => [`Signed: ${v}`]];

export function generateR7({ seed = 20261401, perClass = 60 } = {}) {
  const out = { dev: [], holdout: [], blind: [] };
  const add = (split, cls, id, text, expect, note) => out[split].push({ cls, split, id: `${cls.toLowerCase()}-${id}`, text, expect, note });
  for (const split of ['dev', 'holdout', 'blind']) {
    const r = rng(seed + (split === 'holdout' ? 15485863 : split === 'blind' ? 32452843 : 0));
    const kind = (i) => (i % 2 ? 'holder' : 'emp');
    const nameCase = (cls, list, frames, n = perClass, anyKey = false) => {
      for (let i = 0; i < n; i++) { const nm = pick(r, list); const [first, ...rest] = nm.split(' '); const k = kind(i); const f = pick(r, frames)(nm, k, r); add(split, cls, i, sheet(k, f), { name: { key: KEY(k), keys: anyKey ? ANYKEY : null, person: { first, last: rest.join(' ') } } }, `${cls} "${nm}" (${k})`); }
    };
    const junkCase = (cls, list, frames, { twice = false, n = perClass } = {}) => {
      for (let i = 0; i < n; i++) { const v = pick(r, list); const k = kind(i); const f = pick(r, frames)(v, k); add(split, cls, i, twice ? sheet(k, f, [v], [v]) : sheet(k, f), { noValue: v }, `${cls} junk "${v}" (${k})`); }
    };
    nameCase('Nx', NX[split], nextFr);
    const phraseJ = () => { const g = pick(r, GIVEN[split]); const t = r(); return t < 0.5 ? `${g} ${pick(r, SHORT[split])}` : t < 0.8 ? `${g} ${pick(r, LONG[split])}` : `${g} ${pick(r, GIVEN[split])} ${pick(r, SHORT[split])}`; };
    for (let i = 0; i < perClass; i++) { const v = phraseJ(); const k = kind(i); add(split, 'Nj', i, sheet(k, pick(r, nextFr)(v, k)), { noValue: v }, `Nj junk "${v}" on the line after a label (${k})`); }
    nameCase('Vf', VF[split], [...sameFr, ...nextFr]);
    junkCase('Vj', VJ[split], [...sameFr, ...nextFr]);
    nameCase('Kf', KF[split], [...sameFr, ...nextFr], Math.ceil(perClass / 2));
    junkCase('Kj', KJ[split], [...sameFr, ...nextFr], { n: Math.ceil(perClass / 2) });
    nameCase('Cf', CF[split], [...sameFr, ...nextFr], Math.ceil(perClass / 2));
    junkCase('Cj', CJ[split], [...sameFr, ...nextFr], { n: Math.ceil(perClass / 2) });
    // given name + short unseen noun on weak / strong labels; the same printed twice
    const GN = (list) => pick(r, list);
    for (let i = 0; i < perClass * 2; i++) { const v = `${GN(GIVEN[split])} ${pick(r, SHORT[split])}`; const k = kind(i); add(split, 'Pw', i, sheet(k, weakFr[0](v, k, r)), { noValue: v }, `Pw "${v}" weak label (${k})`); }
    for (let i = 0; i < perClass * 2; i++) { const v = `${GN(GIVEN[split])} ${pick(r, SHORT[split])}`; const k = kind(i); add(split, 'Ps', i, sheet(k, pick(r, strongFr)(v, k)), { noValue: v }, `Ps "${v}" strong label (${k})`); }
    for (let i = 0; i < perClass; i++) { const v = `${GN(GIVEN[split])} ${pick(r, SHORT[split])}`; const k = kind(i); add(split, 'Pq', i, sheet(k, (r() < 0.5 ? weakFr[0](v, k, r) : pick(r, strongFr)(v, k)), [v], [v]), { noValue: v }, `Pq "${v}" printed twice (${k})`); }
    for (let i = 0; i < perClass; i++) { const v = `${GN(GIVEN[split])} ${pick(r, LONG[split])}`; const k = kind(i); add(split, 'Pl', i, sheet(k, (r() < 0.5 ? weakFr[0](v, k, r) : pick(r, strongFr)(v, k))), { noValue: v }, `Pl "${v}" long noun (${k})`); }
    nameCase('Pk', KPARK[split], [...weakFr, ...strongFr], Math.ceil(perClass / 2), true);
    nameCase('Pe', ENGSUR[split], [...strongFr], Math.ceil(perClass / 2));
    nameCase('Pm', ENGSUR[split], weakFr, Math.ceil(perClass / 2), true); // the same English-word surnames on a weak label (cost of the rule)
    // a real name with the ambiguous word AND a signature line still reads
    for (let i = 0; i < Math.ceil(perClass / 3); i++) { const nm = pick(r, ENGSUR[split]); const [first, last] = nm.split(' '); const k = kind(i); add(split, 'Pg', i, sheet(k, weakFr[0](nm, k, r), [], pick(r, SIG)(nm)), { name: { key: KEY(k), keys: ANYKEY, person: { first, last } } }, `Pg "${nm}" weak label + signature`); }
  }
  return out;
}
