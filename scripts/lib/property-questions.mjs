/**
 * Property-management question set (Build 2, stage 2D). buildQuestions(T) -> [{kind, question, must, mustNot?, optional?, alt?, cite?, computed?, mode?, modelOk?, expectEmpty?, note?}]
 * T = truth() from property-fixtures.mjs. Every expected value is computed from the RAW fixture specs (PROPS, COIS, LEASES, RENTROLLS, INSPECTIONS,
 * WORKORDERS, INVOICES, CONTRACTS + the handful of adversarial extras whose D() offsets are restated below), with the fixed TODAY. Never from any lane.
 *  - must       strings the answer must contain (case-insensitive); dates are written long ("March 4, 2026"); money as "$1,450.00"
 *  - mustNot    strings the answer must not contain (history values of an older near-duplicate document, other properties' units, ...)
 *  - optional   strings that are fine to include but not required (a list item the fixtures make legitimately debatable)
 *  - alt        [[...],[...]] other acceptable must-sets: the answer passes if it satisfies must OR every string of any one alt set
 *  - cite       [[filename, field_key, page?]] (page defaults to 1)
 *  - computed   must-strings that are counts / sums / state words, not copied from a page (the selfcheck exempts them)
 *  - mode:'null'  not on file or out of scope: the answer must NOT be produced from records
 *  - modelOk    legitimately left to the model path (messy / ambiguous document): score leniently, never gate on it
 *  - expectEmpty  the correct answer is "none"; mustNot lists every name that would be wrong
 *  - kind  coi | lease | rent | vacancy | workorder | contract | inspection | invoice | count | attention | ambiguous | tricky | unanswerable | otherindustry | general
 * Decisions follow D1-D9 in property-fixtures.mjs (expired = date < TODAY; due/expiring today is NOT expired; windows inclusive; current COI = latest expiry
 * per vendor; near-duplicates and history count in document counts but never in expired/expiring answers).
 * Ironclad's current certificate is the renewal coi-dmy-2digit.pdf (expires February 3, 2027), now part of COIS (flagged external: built as its own date-format document); the old one (Oct 5, 2026) is history.
 */
import { TODAY, addDays, long, money, PROPS, VENDORS, COIS, LEASES, RENTROLLS, INSPECTIONS, WORKORDERS, INVOICES, CONTRACTS } from './property-fixtures.mjs';

const D = (n) => addDays(TODAY, n);
const INSURERS = ['Hartford Fire Insurance Company', 'Travelers Indemnity Company', 'Liberty Mutual Insurance', 'Nationwide Mutual Insurance Company'];
const SHORT = { [VENDORS.rios]: 'Rios Plumbing', [VENDORS.sun]: 'Sun Valley Landscaping', [VENDORS.apex]: 'Apex Pest Control', [VENDORS.summit]: 'Summit Elevator', [VENDORS.bright]: 'Bright Path Janitorial', [VENDORS.cool]: 'Coolwave HVAC', [VENDORS.iron]: 'Ironclad Roofing' };
const TRADE = { [VENDORS.rios]: 'plumber', [VENDORS.sun]: 'landscaper', [VENDORS.apex]: 'pest control company', [VENDORS.summit]: 'elevator company', [VENDORS.bright]: 'janitorial company', [VENDORS.cool]: 'HVAC company', [VENDORS.iron]: 'roofer' };
const sh = (v) => SHORT[v];
const pr = (id) => PROPS.find((p) => p.id === id);
const SLANG = { p1: ['Saguaro Ridge', '1200 Mesa Drive', 'the Mesa property'], p2: ['Palo Verde Villas', '455 Palo Verde Lane', 'the Tempe property'], p3: ['Copper Canyon Townhomes', '80 Copper Canyon Road', 'the Chandler property'], p4: ['Desert Willow Plaza', '3100 Willow Boulevard', 'the Gilbert property'] };
const sl = (p, i) => SLANG[p][i % 3];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const cents = (n) => Math.round(n * 100) / 100;

/* ---- adversarial extras (offsets restated from property-fixtures.mjs; the selfcheck verifies them against the documents' truth) ---- */
const EXTRA_LEASES = [
  { file: 'lease-rent-conflict.pdf', p: 'p2', unit: '5D', tenant: 'Odell Brooks', start: D(-30), end: D(335), rent: 1500, base: 1450, dep: 1450 },
  { file: 'lease-dmy.pdf', p: 'p3', unit: '5', tenant: 'Noor Haddad', start: D(-15), end: D(350), rent: 1710, dep: null },
];
const WILLOW_ROWS = [{ unit: '101', tenant: 'Ava Chen', start: D(-50), end: D(315), rent: 2100 }, { unit: '102', tenant: 'Ben Ortiz', start: D(-20), end: D(345), rent: null }, { unit: '103', tenant: 'Cara Voss', start: D(-70), end: null, rent: 2100 }];

export function buildQuestions(T) {
  const out = [];
  const q = (kind, question, o = {}) => out.push({ kind, question, ...o });
  const pageOf = (file, key) => { const d = T.docs.find((x) => x.filename === file); return d?.truth.fields[key]?.page ?? 1; };
  const c = (file, key) => { const pg = pageOf(file, key); return pg === 1 ? [file, key] : [file, key, pg]; };
  const inWin = (date, n) => date >= TODAY && date <= D(n);
  const names = (arr) => arr.map((x) => x);

  /* ================= COI ================= */
  // current COI per vendor (latest earliest-expiry) from the raw specs, plus the Ironclad renewal extra (D1)
  const minExp = (x) => x.policies.map((p) => p.exp).filter(Boolean).reduce((a, b) => (a < b ? a : b), null);
  const cur = new Map();
  for (const x of COIS) { const e = minExp(x); if (!e) continue; const k = cur.get(x.vendor); if (!k || e > k.exp) cur.set(x.vendor, { vendor: x.vendor, exp: e, file: x.file, insurer: INSURERS[x.ins], policy: x.policies[0].no, limit: x.policies[0].limit ?? null, covs: x.policies.map((p) => p.cov) }); }
  const cois = [...cur.values()];
  const hist = (v) => COIS.filter((x) => x.vendor === v && x.file !== cur.get(v).file && minExp(x)).map((x) => ({ exp: minExp(x), policy: x.policies[0].no, file: x.file }));
  const coiFiles = (arr) => arr.map((x) => c(x.file, 'coi_expires'));
  const notIn = (arr, all) => all.filter((x) => !arr.includes(x));
  const vn = (arr) => arr.map((x) => sh(x.vendor));
  const allVn = cois.map((x) => sh(x.vendor));
  const status = (e) => (e < TODAY ? 'expired' : e === TODAY ? 'today' : null);

  cois.forEach((k, i) => {
    const s = sh(k.vendor); const t = TRADE[k.vendor]; const old = hist(k.vendor); const mn = old.map((h) => long(h.exp));
    const cv = c(k.file, 'coi_expires');
    q('coi', `When does ${s}'s insurance expire?`, { must: [long(k.exp)], mustNot: mn, cite: [cv] });
    q('coi', `${s} COI expiration date`, { must: [long(k.exp)], mustNot: mn, cite: [cv] });
    q('coi', [`Is ${s} insured right now?`, `Do we have a current certificate of insurance for ${s}?`, `is the ${t} still covered on their insurance`][i % 3], { must: [long(k.exp)], mustNot: mn, computed: status(k.exp) ? [status(k.exp)] : [], cite: [cv] });
    if (k.insurer && k.vendor !== VENDORS.iron) q('coi', `Who is ${s}'s insurance carrier?`, { must: [k.insurer], cite: [c(k.file, 'insurer')] });
    if (k.limit) q('coi', `What is the general liability limit on ${s}'s certificate?`, { must: [money(k.limit)], cite: [c(k.file, 'gl_limit')] });
    if (k.vendor !== VENDORS.iron) q('coi', i % 2 ? `${s} policy number` : `What's the policy number on the ${t}'s COI?`, { must: [k.policy], mustNot: old.map((h) => h.policy), cite: [c(k.file, 'policy_number')] });
    const hasWC = k.covs.includes('Workers Compensation');
    if (k.vendor !== VENDORS.iron) q('coi', `Does ${s} carry workers comp?`, hasWC ? { must: ['workers'], cite: [c(k.file, 'coverage_type')] } : { must: ['no'], computed: ['no'], modelOk: true, cite: [c(k.file, 'coverage_type')], note: 'only the coverages listed on the certificate are known' });
  });
  // near-duplicate history: the older certificate must not drive the answer
  q('coi', 'What was the policy number on the old Rios Plumbing certificate?', { must: ['GL-3380114'], cite: [c('coi-rios-2025-old.pdf', 'policy_number')] });
  q('coi', 'Does Apex have more than one certificate on file, and which one is the newest?', { must: ['GLP-6629955'], mustNot: [], modelOk: true, cite: [c('coi-apex-2026.pdf', 'coi_expires')] });
  q('coi', 'When did the older Apex Pest Control certificate expire?', { must: ['August 22, 2026'], cite: [c('coi-apex-2025.pdf', 'coi_expires')] });
  q('tricky', 'Ironclad Roofing COI status', { must: ['February 3, 2027'], cite: [c('coi-dmy-2digit.pdf', 'coi_expires')], note: 'an older certificate expired yesterday, a renewal (3-Feb-2027) is on file: current = renewal' });
  q('tricky', "When does Bright Path Janitorial's certificate with no expiration printed expire?", { must: [], mode: 'null', note: 'coi-noexp.pdf prints no expiry; Bright has a readable current COI (April 24, 2027) so either answer must not invent a date for the blank one', modelOk: true });
  q('tricky', 'When does the Sun Valley certificate that says 12/31 expire?', { must: ['2027'], mode: 'null', modelOk: true, note: 'coi-no-year.pdf prints 12/31 with no year: never guess a year (but the readable Sun COI is March 20, 2027)' });

  // lists
  const expired = cois.filter((x) => x.exp < TODAY);
  q('coi', 'Which vendors have expired insurance?', { must: [], expectEmpty: true, mustNot: allVn, note: 'Ironclad expired yesterday but renewed (renewal on file); Apex expires today (not expired)', cite: [] });
  for (const ph of ['Any expired COIs?', 'which vendors let their insurance lapse', 'Show me vendors with a COI that is out of date']) q('coi', ph, { must: [], expectEmpty: true, mustNot: allVn, modelOk: true });
  q('coi', 'Whose insurance expires today?', { must: ['Apex'], mustNot: allVn.filter((n) => n !== 'Apex Pest Control'), cite: coiFiles(cois.filter((x) => x.exp === TODAY)) });
  q('coi', 'Is any vendor COI expiring today?', { must: ['Apex'], computed: [], cite: coiFiles(cois.filter((x) => x.exp === TODAY)) });
  for (const n of [7, 14, 30, 60, 90, 180, 365]) {
    const set = cois.filter((x) => inWin(x.exp, n));
    const m = { must: vn(set), mustNot: notIn(vn(set), allVn), cite: coiFiles(set) };
    q('coi', `Which vendor COIs expire in the next ${n} days?`, m);
    q('coi', n % 2 ? `who is expiring within ${n} days insurance wise` : `Which certificates of insurance are expiring in ${n} days?`, m);
  }
  q('coi', 'Which COIs expire this month?', { must: vn(cois.filter((x) => x.exp.slice(0, 7) === TODAY.slice(0, 7))), mustNot: notIn(vn(cois.filter((x) => x.exp.slice(0, 7) === TODAY.slice(0, 7))), allVn), cite: coiFiles(cois.filter((x) => x.exp.slice(0, 7) === TODAY.slice(0, 7))) });
  q('coi', 'Which certificates expire in November?', { must: [], expectEmpty: true, mustNot: allVn });
  q('coi', 'Which COIs expire before the end of the year?', { must: vn(cois.filter((x) => x.exp <= '2026-12-31')), mustNot: notIn(vn(cois.filter((x) => x.exp <= '2026-12-31')), allVn), cite: coiFiles(cois.filter((x) => x.exp <= '2026-12-31')) });
  const first = [...cois].sort((a, b) => (a.exp < b.exp ? -1 : 1))[0];
  q('coi', 'Which vendor COI expires next?', { must: [sh(first.vendor)], cite: [c(first.file, 'coi_expires')] });
  q('coi', 'Who is the vendor with the latest COI expiration?', { must: [sh([...cois].sort((a, b) => (a.exp < b.exp ? 1 : -1))[0].vendor)], computed: [], cite: [] });
  q('coi', 'Which vendors do not have workers comp on their certificate?', { must: ['Apex', 'Summit'], optional: ['Ironclad'], mustNot: ['Rios', 'Sun Valley', 'Bright', 'Coolwave'], modelOk: true, note: 'cois with no workers comp printed: Apex, Summit (Ironclad renewal prints no coverages)' });
  q('coi', 'Which vendors have workers comp on file?', { must: ['Rios', 'Sun Valley', 'Bright', 'Coolwave'], mustNot: ['Apex', 'Summit'] });
  q('coi', 'Which vendors have umbrella coverage?', { must: ['Summit'], mustNot: ['Rios', 'Sun Valley', 'Apex', 'Bright', 'Coolwave'] });
  q('coi', 'Who carries commercial auto liability?', { must: ['Sun Valley', 'Coolwave'], mustNot: ['Rios', 'Apex', 'Summit', 'Bright'] });
  q('coi', 'Which vendors have a $3,000,000 general liability limit?', { must: ['Summit'], mustNot: ['Rios', 'Apex'] });
  q('coi', 'Which vendors have a $2,000,000 each occurrence limit?', { must: ['Sun Valley'], mustNot: ['Rios', 'Summit', 'Apex'] });
  q('coi', 'Which vendors do we not have a certificate of insurance for?', { must: [], expectEmpty: true, mustNot: allVn, note: 'every vendor with work on file has a COI' });
  for (const [qq, v] of [['Do we have a COI for Ferguson Enterprises?', 'Ferguson'], ['Is Mike R. insured?', 'Mike'], ['Do we have insurance paperwork for Desert Mesa Electric?', 'Desert Mesa']]) q('unanswerable', qq, { mode: 'null', note: `${v} has no certificate on file` });
  q('coi', 'How many certificates of insurance are on file?', { must: [String(T.docs.filter((d) => d.truth.type === 'certificate-of-insurance').length)], alt: [[String(cois.length)]], computed: [String(T.docs.filter((d) => d.truth.type === 'certificate-of-insurance').length)], note: 'every certificate counts (D7); 7 distinct vendors accepted' });
  q('coi', 'How many vendors have insurance on file?', { must: [String(cois.length)], computed: [String(cois.length)] });

  /* ================= LEASES / RENT / TENANTS ================= */
  const L1 = LEASES.filter((l) => l.file !== 'lease-7a.pdf').map((l) => ({ file: l.file, p: l.p, unit: l.unit, tenant: l.tenant, start: l.start, end: l.end, rent: l.rent, dep: l.dep, mtm: !!l.mtm }));
  const histLease = LEASES.find((l) => l.file === 'lease-7a.pdf');
  for (const e of EXTRA_LEASES) L1.push({ ...e, mtm: false });
  const U = (l) => (/^\d+$/.test(l.unit) ? `unit ${l.unit}` : `unit ${l.unit}`);
  L1.filter((l) => !['lease-rent-conflict.pdf'].includes(l.file)).forEach((l, i) => {
    const P = pr(l.p); const first = l.tenant.split(' and ')[0]; const lf = l.file;
    const mnEnd = lf === 'lease-7a-renewal.pdf' ? [long(histLease.end)] : [];
    q('rent', [`What is the rent for ${U(l)} at ${sl(l.p, i)}?`, `how much does ${first} pay a month`, `monthly rent ${U(l)} ${P.name}`][i % 3], { must: [money(l.rent)], cite: [c(lf, 'rent_amount')] });
    if (l.dep != null) q('rent', [`What is ${first}'s security deposit?`, `How much deposit did we collect on ${U(l)} at ${sl(l.p, 0)}?`][i % 2], { must: [money(l.dep)], cite: [c(lf, 'security_deposit')] });
    if (l.end) {
      q('lease', [`When does ${first}'s lease end?`, `lease end date for ${U(l)} at ${sl(l.p, 1)}`, `When is the lease up on ${U(l)}, ${P.name}?`][i % 3], { must: [long(l.end)], mustNot: mnEnd, cite: [c(lf, 'lease_end_date')] });
      q('lease', `When did ${first}'s lease start?`, { must: [long(l.start)], mustNot: lf === 'lease-7a-renewal.pdf' ? [long(histLease.start)] : [], cite: [c(lf, 'lease_start_date')] });
    }
    q('lease', [`Who is in ${U(l)} at ${P.name}?`, `who lives in ${U(l)} ${sl(l.p, 2)}`, `Who's the tenant in ${U(l)} at ${sl(l.p, 1)}?`][i % 3], { must: [first], cite: [c(lf, 'tenant_name')] });
  });
  q('lease', 'Is Imani Okoro month to month?', { must: ['month-to-month'], computed: [], cite: [c('lease-mtm.pdf', 'status')] });
  q('lease', 'Which tenants are month-to-month?', { must: ['Imani Okoro'], mustNot: ['Jordan Ellis', 'Priya', 'Lamar'], cite: [c('lease-mtm.pdf', 'status')] });
  q('lease', "When does Imani Okoro's lease end?", { must: ['month-to-month'], computed: ['month-to-month'], mustNot: [], note: 'no end date is printed' });
  q('lease', 'When did Imani Okoro start renting?', { must: ['November 5, 2024'], cite: [c('lease-mtm.pdf', 'lease_start_date')].filter(() => false) });
  q('lease', "What's the original lease on 7A that ended in September?", { must: [long(histLease.end), money(histLease.rent)], cite: [c('lease-7a.pdf', 'lease_end_date')] });
  q('lease', 'Did the Delgados renew their lease?', { must: [long(LEASES.find((l) => l.file === 'lease-7a-renewal.pdf').end)], cite: [c('lease-7a-renewal.pdf', 'lease_end_date')] });
  q('rent', 'How much did the rent go up on 7A with the renewal?', { must: ['1,420.00'], alt: [['$40']], computed: ['40'], modelOk: true });
  q('tricky', 'What is the rent for 5D at Palo Verde?', { must: ['1,500.00'], alt: [['1,450.00']], modelOk: true, note: 'lease prints both Monthly Rent $1,500.00 and Base Rent $1,450.00; either is defensible, a good answer says there are two figures' });
  q('tricky', 'When does Wanda Pruitt lease on 5A end?', { must: [], modelOk: true, mode: 'null', note: 'lease-bad-dates.pdf prints an end date a year before the start: an honest answer flags the conflict rather than picking one' });
  q('lease', "What's Jordan Ellis's renewal rent?", { must: ['1,495.00'], cite: [], note: 'from the renewal notice letter' });
  q('lease', 'When do I need to hear back from Jordan Ellis about renewing?', { must: ['January 14, 2027'] });
  // lists of lease ends (union of lease documents and rent roll rows; the superseded 7A lease is dropped)
  const rrRows = RENTROLLS.flatMap((r) => r.rows.map((x) => ({ ...x, p: r.p, file: r.file })));
  const U1 = new Map();
  for (const r of rrRows) U1.set(`${r.p}|${r.unit}`, { p: r.p, unit: r.unit, tenant: r.tenant, end: r.end, file: r.file, key: 'rent_roll_row' });
  for (const w of WILLOW_ROWS) U1.set(`p4|${w.unit}`, { p: 'p4', unit: w.unit, tenant: w.tenant, end: w.end, file: 'rentroll-conflict.pdf', key: 'rent_roll_row' });
  for (const l of L1) if (l.end && l.file !== 'lease-rent-conflict.pdf') U1.set(`${l.p}|${l.unit}`, { p: l.p, unit: l.unit, tenant: l.tenant, end: l.end, file: l.file, key: 'lease_end_date' });
  const ends = [...U1.values()].filter((x) => x.end);
  const tn = (x) => x.tenant.split(' and ')[0];
  const endCite = (arr) => arr.map((x) => c(x.file, x.key));
  for (const n of [30, 45, 60, 90, 120, 180]) {
    const set = ends.filter((x) => inWin(x.end, n));
    q('lease', [`Which leases are ending in the next ${n} days?`, `who has a lease expiring within ${n} days`][n % 2], { must: set.map(tn), mustNot: ends.filter((x) => !set.includes(x) && x.tenant !== 'Rhonda Ashby' && x.tenant !== 'Nia Thompson').map(tn), cite: endCite(set) });
    if (n === 60 || n === 90) q('lease', `Which units have leases ending within ${n} days?`, { must: set.map((x) => x.unit), computed: set.map((x) => x.unit), mustNot: [], cite: endCite(set) });
  }
  q('lease', 'Which leases have expired?', { must: ['Rhonda Ashby'], optional: ['Nia Thompson', 'Delgado'], mustNot: ['Jordan Ellis', 'Priya', 'Lamar'], cite: [c('lease-3.pdf', 'lease_end_date')], note: 'Rhonda Ashby (ended Sept 30, rent roll still shows Occupied) and Nia Thompson 7B (Expired); the old 7A lease was renewed' });
  q('lease', 'Which tenants are past their lease end date?', { must: ['Rhonda Ashby'], optional: ['Nia Thompson'], mustNot: ['Jordan Ellis', 'Priya', 'Lamar'], modelOk: true });
  q('lease', 'When did Rhonda Ashby lease end?', { must: ['September 30, 2026'], cite: [c('lease-3.pdf', 'lease_end_date')] });
  q('lease', 'Is unit 3 at Copper Canyon still under lease?', { must: ['September 30, 2026'], computed: [], cite: [c('lease-3.pdf', 'lease_end_date')], note: 'lease ended six days ago, still listed Occupied' });
  q('lease', 'Which leases end this year?', { must: ends.filter((x) => x.end >= TODAY && x.end <= '2026-12-31').map(tn), mustNot: [], optional: ['Rhonda Ashby'], cite: endCite(ends.filter((x) => x.end >= TODAY && x.end <= '2026-12-31')) });
  q('lease', 'Whose lease ends first?', { must: [tn(ends.filter((x) => x.end >= TODAY).sort((a, b) => (a.end < b.end ? -1 : 1))[0])], cite: [] });
  q('lease', 'What lease ends latest?', { must: ['Cactus Corner'], cite: [c('lease-210.pdf', 'lease_end_date')] });
  q('count', 'How many lease agreements are on file?', { must: [String(T.docs.filter((d) => d.truth.type === 'lease-agreement').length)], computed: [String(T.docs.filter((d) => d.truth.type === 'lease-agreement').length)], note: 'counts every lease document incl. the old 7A lease and messy ones' });
  q('count', 'How many rent rolls do we have?', { must: [String(T.docs.filter((d) => d.truth.type === 'rent-roll').length)], computed: [String(T.docs.filter((d) => d.truth.type === 'rent-roll').length)] });
  q('rent', 'What is the biggest deposit we are holding?', { must: [money(6500)], mustNot: [], cite: [c('lease-210.pdf', 'security_deposit', pageOf('lease-210.pdf', 'security_deposit'))].map(([f, k, pg]) => (pg ? [f, k, pg] : [f, k])) });
  q('rent', 'Who pays the most rent?', { must: ['Cactus Corner', money(3250)], cite: [c('lease-210.pdf', 'rent_amount')] });
  q('rent', 'Which commercial tenant do we have?', { must: ['Cactus Corner Cafe'], cite: [c('lease-210.pdf', 'tenant_name')] });

  /* ---- rent roll rows ---- */
  const occ = rrRows.filter((r) => r.tenant && r.status !== 'Vacant');
  const leaseUnits = new Set(L1.map((l) => `${l.p}|${l.unit}`));
  occ.forEach((r, i) => {
    if (leaseUnits.has(`${r.p}|${r.unit}`) || r.unit === '7B') return; // answered from the lease above
    const P = pr(r.p); const un = `unit ${r.unit}`;
    q('rent', [`What does ${r.tenant} pay in rent?`, `rent for ${un} at ${P.name}`, `How much is ${r.tenant}'s monthly rent?`][i % 3], { must: [money(r.rent)], cite: [c(r.file, 'rent_roll_row')] });
    if (r.dep) q('rent', `What is ${r.tenant}'s deposit on ${un}?`, { must: [money(r.dep)], cite: [c(r.file, 'rent_roll_row')] });
    if (r.end) q('lease', `When does ${r.tenant}'s lease run out?`, { must: [long(r.end)], cite: [c(r.file, 'rent_roll_row')] });
    q('lease', `Who is in ${un} at ${sl(r.p, 1)}?`, { must: [r.tenant], cite: [c(r.file, 'rent_roll_row')] });
  });
  q('lease', 'Who is in unit 7B at Palo Verde?', { must: ['Nia Thompson'], optional: ['Expired', 'move-out'], cite: [c('rentroll-palo-verde.pdf', 'rent_roll_row')] });
  q('lease', 'Did Nia Thompson move out of 7B?', { must: ['September 3, 2026'], cite: [c('moveout-7b.pdf', 'service_date')] });
  q('rent', "What is Nia Thompson's rent?", { must: ['1,380.00'], cite: [c('rentroll-palo-verde.pdf', 'rent_roll_row')] });
  q('rent', 'What is the rent on the 2 bedroom ... unit 102 at Desert Willow Plaza?', { must: [], modelOk: true, alt: [['2,150.00'], ['2,250.00']], note: 'rentroll-conflict.pdf lists unit 102 twice with different rents: flag, do not choose silently' });
  q('lease', 'When does Cara Voss lease end?', { must: [], modelOk: true, mode: 'null', note: 'rentroll-conflict row 103 prints no end date' });

  /* ---- vacancy ---- */
  const vac = rrRows.filter((r) => r.status === 'Vacant');
  q('vacancy', 'Which units are vacant?', { must: vac.map((r) => r.unit), mustNot: occ.map((r) => r.tenant), cite: vac.map((r) => c(r.file, 'rent_roll_row')) });
  q('vacancy', 'What units do we have available to rent?', { must: vac.map((r) => r.unit), mustNot: occ.map((r) => r.tenant), cite: vac.map((r) => c(r.file, 'rent_roll_row')) });
  q('vacancy', 'Any empty apartments?', { must: vac.map((r) => r.unit), mustNot: occ.map((r) => r.tenant), cite: vac.map((r) => c(r.file, 'rent_roll_row')) });
  q('vacancy', 'How many vacant units do we have?', { must: [String(vac.length)], computed: [String(vac.length)], note: 'across the three clean rent rolls' });
  for (const pid of ['p1', 'p2', 'p3']) {
    const vv = vac.filter((r) => r.p === pid); const P = pr(pid);
    q('vacancy', `Which units are vacant at ${P.name}?`, { must: vv.map((r) => r.unit), mustNot: occ.filter((r) => r.p === pid).map((r) => r.tenant), cite: vv.map((r) => c(r.file, 'rent_roll_row')) });
    q('vacancy', `What is the asking rent on the vacant unit${vv.length > 1 ? 's' : ''} at ${sl(pid, 2)}?`, { must: vv.map((r) => money(r.rent)), cite: vv.map((r) => c(r.file, 'rent_roll_row')) });
  }
  q('vacancy', 'Any vacancies at Desert Willow Plaza?', { must: [], modelOk: true, note: 'the only Willow rent roll (messy) shows no vacant unit' });
  q('vacancy', 'What is the rent for unit 2A at Saguaro Ridge?', { must: ['$1,450.00'], cite: [c('rentroll-saguaro.pdf', 'rent_roll_row')] });
  q('vacancy', 'Is 8A at Palo Verde occupied?', { must: ['vacant'], computed: ['vacant'], cite: [c('rentroll-palo-verde.pdf', 'rent_roll_row')] });
  q('vacancy', 'Is unit 4B at Saguaro vacant?', { must: ['Jordan Ellis'], optional: ['occupied'], mustNot: [] });
  const sag = RENTROLLS[0].rows;
  q('vacancy', 'How many units does Saguaro Ridge have?', { must: [String(sag.length)], computed: [String(sag.length)], cite: [] });
  q('vacancy', 'How many units are occupied at Saguaro Ridge?', { must: [String(sag.filter((r) => r.status === 'Occupied').length)], computed: [String(sag.filter((r) => r.status === 'Occupied').length)] });
  const sagOcc = sum(sag.filter((r) => r.status === 'Occupied').map((r) => r.rent)); const sagAll = sum(sag.map((r) => r.rent));
  q('rent', 'What is the total monthly rent roll at Saguaro Ridge?', { must: [cents(sagOcc).toLocaleString('en-US') + '.00'], alt: [[cents(sagAll).toLocaleString('en-US') + '.00']], computed: [cents(sagOcc).toLocaleString('en-US')], modelOk: true, note: 'occupied rent vs including the asking rent of the 2 vacant units' });
  q('rent', 'How many properties do we manage?', { must: ['4'], computed: ['4'] });
  PROPS.forEach((P, i) => {
    q('count', [`Who owns ${P.name}?`, `who is the owner of ${sl(P.id, 1)}`, `Landlord for ${P.name}`][i % 3], { must: [P.owner], cite: [] });
    q('count', `What's the address of ${P.name}?`, { must: [P.addr, P.city] });
  });
  q('count', 'Which property is at 455 Palo Verde Lane?', { must: ['Palo Verde Villas'] });

  /* ================= WORK ORDERS ================= */
  const W = WORKORDERS.map((w) => ({ file: w.file, no: w.no, p: w.p, unit: w.unit, opened: w.opened, status: w.status, pri: w.priority, vendor: w.vendor ?? null, cost: w.cost ?? null, completed: w.completed ?? null, sched: w.sched ?? null, work: w.work }));
  W.push({ file: 'wo-nte.pdf', no: 'WO-20460', p: 'p4', unit: '110', opened: D(-2), status: 'Scheduled', pri: 'Normal', vendor: null, cost: null, completed: null, sched: D(3), work: ['Replace suite lighting ballast'] });
  const wCur = W.filter((w) => w.file !== 'wo-4b-leak-v2.pdf');
  const wno = (arr) => arr.map((w) => w.no);
  const wC = (arr, key) => arr.map((w) => c(w.file, key));
  for (const w of wCur) {
    const P = pr(w.p); const un = w.unit ? `unit ${w.unit}` : 'the building';
    const nearDup = w.no === 'WO-20418';
    q('workorder', `What is the status of ${w.no}?`, { must: [w.status], alt: nearDup ? [['Closed']] : undefined, cite: [c(w.file, 'status')] });
    q('workorder', `What work is on ${w.no}?`, { must: w.work.slice(0, 1), cite: [c(w.file, 'work_performed')] });
    if (w.vendor) q('workorder', `Who is assigned to ${w.no}?`, { must: [w.vendor], cite: [c(w.file, 'vendor')] });
    q('workorder', `What priority is ${w.no}?`, { must: [w.pri], cite: [c(w.file, 'priority')] });
    if (w.cost) q('workorder', `How much was ${w.no}?`, { must: [money(w.cost)], cite: [c(w.file, 'cost')] });
    if (w.completed) q('workorder', `When was ${w.no} completed?`, { must: [long(w.completed)], cite: [c(w.file, 'completed_date')] });
    q('workorder', `When was ${w.no} opened?`, { must: [long(w.opened)], cite: [c(w.file, 'opened_date')] });
    if (w.unit) q('workorder', [`Any work orders on ${un} at ${sl(w.p, 0)}?`, `what's going on with ${un} at ${P.name} maintenance wise`][w.no.length % 2], { must: [w.no], cite: [c(w.file, 'work_order_number')] });
  }
  q('workorder', "What's the status of the roof repair at Copper Canyon?", { must: ['On Hold', 'owner approval'], cite: [c('wo-roof.pdf', 'status')] });
  q('workorder', 'What is the AC problem at 7A?', { must: ['AC not cooling'], cite: [c('wo-7a-hvac.pdf', 'work_performed')] });
  q('workorder', 'When is Coolwave scheduled to come out to 7A?', { must: [long(D(2))], cite: [c('wo-7a-hvac.pdf', 'service_date')] });
  q('workorder', 'When is the pest treatment at 9D?', { must: [long(D(4))], cite: [c('wo-9d-pest.pdf', 'service_date')] });
  q('workorder', 'Who is doing the ballast replacement at Desert Willow Plaza?', { must: ['Mike R'], cite: [], note: 'in-house maintenance, not a vendor with a legal suffix' });
  q('workorder', 'What is the not-to-exceed on WO-20460?', { must: ['$500.00'], cite: [] });
  q('tricky', 'When was WO-20461 completed?', { must: [], modelOk: true, note: 'wo-completed-before-opened.pdf: completion (Aug 27) before opened (Sept 26): flag, never state as clean' });
  const openStatus = W.filter((w) => w.status === 'Open');
  const notDone = wCur.filter((w) => !['Completed', 'Closed'].includes(w.status));
  const done = wCur.filter((w) => ['Completed', 'Closed'].includes(w.status));
  q('workorder', 'Which work orders are open?', { must: wno(notDone.filter((w) => w.status === 'Open')), alt: [wno(notDone)], optional: wno(notDone), cite: wC(notDone, 'status'), note: 'strict status Open = WO-20440; the wider outstanding set (Open, In Progress, On Hold, Scheduled) accepted via alt' });
  q('workorder', 'Show me open work orders', { must: wno(openStatus), alt: [wno(notDone)], optional: wno(notDone), cite: wC(notDone, 'status') });
  q('workorder', 'Which work orders still need to be done?', { must: wno(notDone), mustNot: wno(done), cite: wC(notDone, 'status') });
  q('workorder', "Which work orders aren't completed yet?", { must: wno(notDone), mustNot: wno(done), cite: wC(notDone, 'status') });
  q('workorder', 'Which work orders are completed?', { must: wno(done), mustNot: wno(notDone), optional: ['WO-20461'], cite: wC(done, 'status') });
  q('workorder', 'What maintenance has been finished?', { must: wno(done), mustNot: wno(notDone), optional: ['WO-20461'], modelOk: true });
  q('workorder', 'Which work orders are in progress?', { must: ['WO-20431'], mustNot: ['WO-20418', 'WO-20377'], cite: [c('wo-7a-hvac.pdf', 'status')] });
  q('workorder', 'Which work orders are on hold?', { must: ['WO-20399'], mustNot: ['WO-20418', 'WO-20431'], cite: [c('wo-roof.pdf', 'status')] });
  q('workorder', 'Which work orders are scheduled?', { must: ['WO-20445', 'WO-20460'], optional: ['WO-20431'], mustNot: ['WO-20418', 'WO-20377'], cite: [c('wo-9d-pest.pdf', 'status'), c('wo-nte.pdf', 'status')] });
  q('workorder', 'Are there any overdue work orders?', { must: [], expectEmpty: true, modelOk: true, optional: ['WO-20399'], mustNot: ['WO-20418', 'WO-20377', 'WO-20450'], note: 'no open work order has a scheduled date in the past; WO-20399 has been on hold 25 days' });
  q('workorder', 'What is the oldest open work order?', { must: ['WO-20399'], cite: [c('wo-roof.pdf', 'opened_date')] });
  q('workorder', 'Which work orders are urgent or emergency?', { must: ['WO-20418', 'WO-20450'], mustNot: ['WO-20440', 'WO-20377'] });
  q('workorder', 'Which work orders are high priority?', { must: ['WO-20431', 'WO-20399'], mustNot: ['WO-20440', 'WO-20377'] });
  for (const p of ['p1', 'p2', 'p3', 'p4']) {
    const set = wCur.filter((w) => w.p === p); const P = pr(p);
    q('workorder', `What work orders do we have at ${P.name}?`, { must: wno(set), mustNot: wno(wCur.filter((w) => w.p !== p)), optional: p === 'p1' ? ['WO-20461'] : [], cite: wC(set, 'work_order_number') });
    const od = set.filter((w) => !['Completed', 'Closed'].includes(w.status));
    q('workorder', `Any open work orders at ${sl(p, 0)}?`, od.length ? { must: wno(od), mustNot: wno(set.filter((w) => !od.includes(w))), cite: wC(od, 'status') } : { must: [], expectEmpty: true, mustNot: wno(wCur) });
  }
  for (const v of [VENDORS.rios, VENDORS.cool, VENDORS.iron, VENDORS.apex, VENDORS.bright]) {
    const set = wCur.filter((w) => w.vendor === v);
    q('workorder', `What work orders does ${sh(v)} have?`, { must: wno(set), mustNot: wno(wCur.filter((w) => w.vendor !== v)), cite: wC(set, 'vendor') });
  }
  q('workorder', 'Which work orders have no vendor assigned?', { must: ['WO-20440', 'WO-20450'], optional: ['WO-20461', 'WO-20460'], mustNot: ['WO-20418', 'WO-20431'], modelOk: true });
  q('workorder', 'What work orders were opened this month?', { must: wno(wCur.filter((w) => w.opened.slice(0, 7) === '2026-10')), mustNot: ['WO-20418', 'WO-20377', 'WO-20399'], cite: wC(wCur.filter((w) => w.opened.slice(0, 7) === '2026-10'), 'opened_date') });
  q('workorder', 'Which work orders were completed in September?', { must: wno(wCur.filter((w) => w.completed && w.completed.slice(0, 7) === '2026-09')), mustNot: ['WO-20450'], optional: ['WO-20461'], cite: wC(wCur.filter((w) => w.completed && w.completed.slice(0, 7) === '2026-09'), 'completed_date') });
  const doneCost = cents(sum(done.filter((w) => w.cost && w.no !== 'WO-20461').map((w) => w.cost)));
  q('workorder', 'What is the total cost of completed work orders?', { must: [doneCost.toLocaleString('en-US') + '0'.repeat(0)].map((s) => (s.includes('.') ? s : s + '.00')), computed: [String(doneCost.toLocaleString('en-US'))], modelOk: true, note: 'WO-20418 counted once (its Closed copy is the same work order)' });
  q('count', 'How many work orders do we have?', { must: [String(T.docs.filter((d) => d.truth.type === 'work-order').length)], alt: [[String(new Set(W.map((w) => w.no)).size + 1)]], computed: [String(T.docs.filter((d) => d.truth.type === 'work-order').length)], note: 'document count (the Closed copy of WO-20418 counts); distinct work orders accepted via alt' });
  q('tricky', 'Is WO-20418 completed or closed?', { must: ['Completed'], alt: [['Closed']], mustNot: [], cite: [c('wo-4b-leak.pdf', 'status')], note: 'the same work order is on file twice: Completed and Closed; a good answer notes both' });
  q('workorder', 'Was the 4B leak fixed?', { must: ['September 24, 2026'], cite: [c('wo-4b-leak.pdf', 'completed_date')] });
  q('workorder', 'What did Rios charge for the faucet at 4B?', { must: ['$285.50'], cite: [c('wo-4b-leak.pdf', 'cost')] });

  /* ================= CONTRACTS ================= */
  const CT = CONTRACTS.map((x) => ({ ...x }));
  const cnames = (arr) => arr.map((x) => sh(x.vendor));
  const allC = cnames(CT);
  for (const x of CT) {
    const s = sh(x.vendor); const t = TRADE[x.vendor]; const P = pr(x.p);
    q('contract', [`When does ${s}'s contract end?`, `contract end date for the ${t}`, `When does the ${s} agreement expire?`][CT.indexOf(x) % 3], { must: [long(x.end)], cite: [c(x.file, 'contract_end')] });
    q('contract', `What is the monthly fee for ${s}?`, { must: [money(x.monthly)], mustNot: x.vendor === VENDORS.bright ? [] : [], alt: x.vendor === VENDORS.bright ? [[money(x.monthly), money(400)]] : undefined, cite: [c(x.file, 'monthly_amount')], note: x.vendor === VENDORS.bright ? 'Bright has two contracts ($950 Willow, $400 leasing office); naming both is best' : undefined });
    if (x.auto) q('contract', [`Does ${s}'s contract auto-renew?`, `is the ${t} agreement automatically renewing`][CT.indexOf(x) % 2], { must: [x.auto], computed: [x.auto], cite: [c(x.file, 'auto_renew')] });
    else q('contract', `Does ${s}'s contract auto-renew?`, { must: [], modelOk: true, note: 'contract-cool.pdf prints no renewal term: never answer yes/no confidently' });
    q('contract', `What does ${s} do for us at ${sl(x.p, 2)}?`, { must: [x.scope.split(' ').slice(0, 2).join(' ')], cite: [c(x.file, 'contract_scope')] });
    q('contract', `When did the ${s} contract start?`, { must: [long(x.start)], cite: [c(x.file, 'contract_start')] });
  }
  q('contract', 'Who does our landscaping?', { must: ['Sun Valley'], cite: [c('contract-sun.pdf', 'vendor')] });
  q('contract', 'Who handles the elevator at Saguaro Ridge?', { must: ['Summit Elevator'], cite: [c('contract-summit.pdf', 'vendor')] });
  q('contract', 'Who is our HVAC maintenance contractor at Copper Canyon?', { must: ['Coolwave'], cite: [c('contract-cool.pdf', 'vendor')] });
  for (const n of [30, 60, 90, 180, 365]) {
    const set = CT.filter((x) => inWin(x.end, n));
    q('contract', [`Which vendor contracts end in the next ${n} days?`, `contracts expiring within ${n} days`][n % 2], set.length ? { must: cnames(set), mustNot: notIn(cnames(set), allC), cite: set.map((x) => c(x.file, 'contract_end')) } : { must: [], expectEmpty: true, mustNot: allC });
  }
  q('contract', 'Which vendor contracts have ended?', { must: ['Apex'], mustNot: ['Sun Valley', 'Summit', 'Coolwave'], cite: [c('contract-apex.pdf', 'contract_end')] });
  q('contract', 'Is the Apex pest control contract still active?', { must: ['September 1, 2026'], computed: [], cite: [c('contract-apex.pdf', 'contract_end')], note: 'ended 35 days ago with no auto-renew, yet a new Apex invoice (INV 771) is dated Oct 3' });
  q('contract', 'Which contracts renew automatically?', { must: ['Sun Valley', 'Summit'], mustNot: ['Apex', 'Bright'], optional: ['Coolwave'], cite: [c('contract-sun.pdf', 'auto_renew'), c('contract-summit.pdf', 'auto_renew')] });
  q('contract', 'Which contracts do not auto-renew?', { must: ['Apex', 'Bright'], mustNot: ['Sun Valley', 'Summit'], optional: ['Coolwave'], cite: [c('contract-apex.pdf', 'auto_renew'), c('contract-bright.pdf', 'auto_renew')] });
  q('contract', 'Which vendors have auto-renew turned off?', { must: ['Apex', 'Bright'], mustNot: ['Sun Valley', 'Summit'], optional: ['Coolwave'], modelOk: true });
  const act = CT.filter((x) => x.end >= TODAY);
  const mAct = cents(sum(act.map((x) => x.monthly)));
  q('contract', 'What is the total monthly amount of our active vendor contracts?', { must: [mAct.toLocaleString('en-US') + '.00'], alt: [[cents(mAct + 400).toLocaleString('en-US') + '.00']], computed: [mAct.toLocaleString('en-US')], modelOk: true, note: 'alt includes the $400 leasing-office contract that prints only a term (12 months)' });
  q('contract', 'Which vendor contract costs the most per month?', { must: ['Sun Valley', '1,200.00'], cite: [c('contract-sun.pdf', 'monthly_amount')] });
  q('contract', 'What contracts do we have at Desert Willow Plaza?', { must: ['Apex', 'Bright'], mustNot: ['Sun Valley', 'Summit', 'Coolwave'], cite: [c('contract-apex.pdf', 'vendor'), c('contract-bright.pdf', 'vendor')] });
  q('contract', 'What are we paying Bright Path each month?', { must: ['950.00'], alt: [['950.00', '400.00']], modelOk: true });
  q('contract', 'What is the length of the Bright Path leasing office contract?', { must: ['12 months'], cite: [c('contract-term-only.pdf', 'agreement_term')], note: 'term in months only: never converted to dates' });
  q('contract', 'When does the Bright Path leasing office contract end?', { must: [], mode: 'null', modelOk: true, note: 'only a 12 month term is printed, no start date' });
  q('count', 'How many vendor contracts do we have?', { must: [String(T.docs.filter((d) => d.truth.type === 'vendor-contract').length)], computed: [String(T.docs.filter((d) => d.truth.type === 'vendor-contract').length)] });
  q('contract', 'Which vendors do not have a contract with us?', { must: ['Rios', 'Ironclad'], mustNot: ['Sun Valley', 'Summit', 'Coolwave'], computed: [], modelOk: true });
  q('contract', 'How long is the Summit Elevator agreement renewal term?', { must: ['12 month'], cite: [c('contract-summit.pdf', 'auto_renew', pageOf('contract-summit.pdf', 'auto_renew'))].map(([f, k, pg]) => (pg ? [f, k, pg] : [f, k])) });

  /* ================= INSPECTIONS ================= */
  const nm = (i) => `${i.kind === 'fire' ? 'fire inspection' : i.kind === 'annual' ? 'annual inspection' : i.kind + ' inspection'}`;
  for (const i of INSPECTIONS) {
    const P = pr(i.p); const unit = i.unit ? `unit ${i.unit} at ${P.name}` : P.name; const cf = (k) => c(i.file, k);
    q('inspection', `What was the result of the ${nm(i)} for ${unit}?`, { must: [i.result], cite: [cf('inspection_result')] });
    q('inspection', `When was the ${nm(i)} done for ${unit}?`, { must: [long(i.date)], cite: [cf('service_date')] });
    if (i.def.length) q('inspection', `What deficiencies were found in the ${nm(i)} for ${unit}?`, { must: i.def, cite: [cf('deficiency')] });
    else q('inspection', `Were there any deficiencies on the ${nm(i)} for ${unit}?`, { must: ['no'], computed: ['no'], modelOk: true, cite: [cf('inspection_result')] });
    if (i.reinspect) q('inspection', `When is the reinspection due for ${unit}?`, { must: [long(i.reinspect)], cite: [cf('reinspection_due')] });
  }
  const failed = INSPECTIONS.filter((i) => i.result === 'Failed');
  q('inspection', 'Which inspections failed?', { must: ['Saguaro', 'Copper'], alt: [['1200 Mesa', '80 Copper Canyon']], mustNot: ['12C', 'Desert Willow', '9D'], cite: failed.map((i) => c(i.file, 'inspection_result')) });
  q('inspection', 'What failed inspection do we have?', { must: ['Fire extinguisher tag expired', 'GFCI'], alt: [['fire', 'unit 3']], modelOk: true });
  q('inspection', 'Show failed inspections that need a reinspection', { must: ['October 16, 2026', 'October 27, 2026'], cite: failed.map((i) => c(i.file, 'reinspection_due')) });
  q('inspection', 'What reinspections are coming up in the next 30 days?', { must: ['October 16, 2026', 'October 27, 2026'], mustNot: ['May 9, 2026'], cite: failed.map((i) => c(i.file, 'reinspection_due')) });
  q('inspection', 'Which reinspections are overdue?', { must: ['Desert Willow'], alt: [['May 9, 2026']], mustNot: ['October 16', 'October 27'], cite: [c('insp-fire-willow.pdf', 'reinspection_due')] });
  q('inspection', 'Is anything past due on inspections?', { must: ['May 9, 2026'], alt: [['Desert Willow']], cite: [c('insp-fire-willow.pdf', 'reinspection_due')] });
  q('inspection', 'Which properties passed their fire inspection?', { must: ['Desert Willow'], mustNot: ['Copper'], optional: ['deficienc'], note: 'Willow passed WITH deficiencies; Saguaro failed' });
  q('inspection', 'What did the fire inspection at Saguaro Ridge find?', { must: ['Fire extinguisher tag expired in stairwell B', 'Emergency light out on third floor'], cite: [c('insp-fire-saguaro.pdf', 'deficiency', pageOf('insp-fire-saguaro.pdf', 'deficiency'))].map(([f, k, pg]) => (pg ? [f, k, pg] : [f, k])) });
  q('inspection', 'Which units had damages at move-out?', { must: ['7B'], mustNot: ['3B', '4B'], optional: ['6B'], cite: [c('moveout-7b.pdf', 'deficiency')] });
  q('inspection', 'What was damaged in 7B when Nia Thompson moved out?', { must: ['Carpet stain', 'closet door track', 'smoke detector cover'], cite: [c('moveout-7b.pdf', 'deficiency')] });
  q('inspection', 'What condition issues were noted at move-in for 4B?', { must: ['Scuff on hallway wall', 'Bedroom blind slat bent'], cite: [c('movein-4b.pdf', 'deficiency')] });
  q('inspection', 'Was unit 9D in good condition at move-in?', { must: ['Satisfactory'], cite: [c('movein-9d.pdf', 'inspection_result')] });
  q('inspection', 'What was the move-out result for Quentin Boyd?', { must: ['Satisfactory'], cite: [c('moveout-3b.pdf', 'inspection_result')] });
  q('tricky', 'What was the move-out inspection result for Felix Armstrong in 6B?', { must: [], modelOk: true, note: 'result prints "Pass/Fail pending review": unclear, never read as pass or fail', cite: [] });
  q('tricky', 'What was the 8B annual inspection result at Palo Verde?', { must: ['Passed'], mustNot: ['2027'], modelOk: true, note: 'insp-future-date.pdf is dated Nov 2027, more than a month in the future: a misread, flag it' });
  q('inspection', 'When is the annual inspection for 4B?', { must: ['October 18, 2026'], note: 'a notice letter, not a report; the date is an upcoming appointment' });
  q('inspection', 'When was the last annual inspection at unit 12C?', { must: ['July 23, 2026'], cite: [c('insp-annual-unit-12c.pdf', 'service_date')] });
  q('inspection', 'Which properties have no failed inspections?', { must: ['Palo Verde', 'Desert Willow'], mustNot: [], optional: ['Saguaro', 'Copper'], modelOk: true });
  q('count', 'How many inspections do we have on file?', { must: [String(INSPECTIONS.length + 4)], computed: [String(INSPECTIONS.length + 4)], alt: [[String(INSPECTIONS.length + 5)], [String(INSPECTIONS.length + 3)]], modelOk: true, note: 'move-in, move-out and inspection reports: 8 clean + ambiguous move-out + future-dated annual + blank checklist' });
  q('count', 'How many move-out inspections do we have?', { must: [String(T.docs.filter((d) => d.truth.type === 'move-out-inspection').length)], computed: [String(T.docs.filter((d) => d.truth.type === 'move-out-inspection').length)] });
  q('count', 'How many move-in inspections do we have?', { must: [String(T.docs.filter((d) => d.truth.type === 'move-in-inspection').length)], computed: [String(T.docs.filter((d) => d.truth.type === 'move-in-inspection').length)] });

  /* ================= INVOICES ================= */
  const IV = INVOICES.map((v) => ({ file: v.file, vendor: v.vendor, no: v.no, date: v.date, due: v.due, p: v.p, unit: v.unit, total: v.total, status: v.status, work: v.work, dup: v.note?.startsWith('near-duplicate: resent') }));
  const IVu = IV.filter((v) => !v.dup);
  for (const v of IVu) {
    const s = sh(v.vendor); const P = pr(v.p); const i = IVu.indexOf(v);
    q('invoice', [`What is the total on invoice ${v.no}?`, `how much is the ${s} invoice ${v.no}`, `${v.no} amount`][i % 3], { must: [money(v.total)], mustNot: v.no === 'INV-5001' ? ['$273.50'] : [], cite: [c(v.file, 'cost')] });
    q('invoice', `What is the status of invoice ${v.no} from ${s}?`, { must: [v.status], cite: [c(v.file, 'status')] });
    if (v.due) q('invoice', [`When is invoice ${v.no} due?`, `due date ${s} ${v.no}`][i % 2], { must: [long(v.due)], cite: [c(v.file, 'invoice_due')] });
    q('invoice', `What was invoice ${v.no} for?`, { must: [v.work[0]], cite: [c(v.file, 'work_performed')] });
    if (i % 2 === 0) q('invoice', `Which property is invoice ${v.no} for?`, { must: [P.name], alt: [[P.addr]], cite: [c(v.file, 'property_name')].filter(() => v.file !== 'inv-sun-0912.pdf') });
  }
  q('tricky', 'When is invoice IR-221 due?', { must: [], modelOk: true, mode: 'null', note: 'inv-iron-221.pdf prints Net 30 but no due date: D5 says never computed (a computed Oct 16, 2026 is tolerated by modelOk)' });
  q('tricky', 'How many Rios invoices are for the 4B faucet repair?', { must: ['INV-5001'], computed: [], modelOk: true, note: 'the same invoice INV-5001 is on file twice (resent copy): one invoice, $285.50, not two' });
  q('tricky', 'What is the subtotal vs the total on INV-5001?', { must: ['285.50'], alt: [['273.50']], modelOk: true, note: 'total includes $12.00 tax; the answer to "total" is $285.50' });
  q('tricky', 'What is the total on invoice INV-7010 from Coolwave?', { must: [], modelOk: true, mode: 'null', note: 'inv-partial-pay.pdf prints only Amount Due $200 and Amount Paid $100: no total; never read the balance as a total' });
  q('tricky', 'What is the total on invoice INV-7001?', { must: ['120.00'], modelOk: true, note: 'inv-two-in-one.pdf holds INV-7001 ($120) and INV-7002 ($340) in one file: either flag or answer each; never merge' });
  const unpaid = IVu.filter((v) => !/^paid$/i.test(v.status));
  const un = (arr) => arr.map((v) => v.no);
  const paid = IVu.filter((v) => /^paid$/i.test(v.status));
  for (const ph of ['Which invoices are unpaid?', 'what do we still owe vendors', 'Show me open invoices', 'Which invoices have not been paid?']) q('invoice', ph, { must: un(unpaid), mustNot: un(paid), cite: unpaid.map((v) => c(v.file, 'status')), note: 'unpaid = Unpaid, Overdue and Open statuses; the resent copy of INV-5001 is the same invoice' });
  const od = IVu.filter((v) => v.due && v.due < TODAY && !/^paid$/i.test(v.status));
  for (const ph of ['Which invoices are overdue?', 'any past due invoices?', 'What bills are late?']) q('invoice', ph, { must: un(od), mustNot: un(IVu.filter((v) => !od.includes(v))), cite: od.map((v) => c(v.file, 'invoice_due')) });
  q('invoice', 'Which invoices are paid?', { must: un(paid), mustNot: un(unpaid), cite: paid.map((v) => c(v.file, 'status')) });
  q('invoice', 'Which invoices are not overdue?', { must: ['771'], optional: [], mustNot: ['SV-0912'], modelOk: true });
  q('invoice', 'Which invoices are due in the next 7 days?', { must: [], expectEmpty: true, mustNot: un(IVu), note: 'earliest unpaid due date is Oct 24, 2026' });
  q('invoice', 'Which invoices are due in the next 30 days?', { must: un(unpaid.filter((v) => v.due && inWin(v.due, 30))), mustNot: ['SV-0912', 'BP-3320'], cite: unpaid.filter((v) => v.due && inWin(v.due, 30)).map((v) => c(v.file, 'invoice_due')) });
  q('invoice', 'Which unpaid invoice has no due date?', { must: ['IR-221'], cite: [c('inv-iron-221.pdf', 'status')] });
  const tot = (arr) => cents(sum(arr.map((v) => v.total)));
  const fmt = (n) => money(n);
  q('invoice', 'What is the total of all unpaid invoices?', { must: [fmt(tot(unpaid))], computed: [fmt(tot(unpaid))], alt: [[fmt(tot(unpaid) + 285.5)]], cite: unpaid.map((v) => c(v.file, 'cost')), note: 'alt = double counting the resent INV-5001 copy' });
  q('invoice', 'How much do we owe in total?', { must: [tot(unpaid).toLocaleString('en-US')], computed: [tot(unpaid).toLocaleString('en-US')], alt: [[tot(unpaid.filter((v) => v.status === 'Unpaid')).toLocaleString('en-US')]], modelOk: true });
  q('invoice', 'What is the total of overdue invoices?', { must: [fmt(tot(od))], computed: [fmt(tot(od))], cite: od.map((v) => c(v.file, 'cost')) });
  q('invoice', 'What is the total of all invoices on file?', { must: [fmt(tot(IVu))], computed: [fmt(tot(IVu))], alt: [[fmt(tot(IVu) + 285.5)]], modelOk: true, note: 'excludes the resent copy and the two messy invoices (two-in-one, partial)' });
  q('invoice', 'What is the total of paid invoices?', { must: [fmt(tot(paid))], computed: [fmt(tot(paid))], cite: paid.map((v) => c(v.file, 'cost')) });
  for (const P of PROPS) {
    const set = IVu.filter((v) => v.p === P.id);
    if (!set.length) continue;
    q('invoice', `What invoices do we have for ${P.name}?`, { must: un(set), mustNot: un(IVu.filter((v) => v.p !== P.id)), cite: set.map((v) => c(v.file, 'invoice_number')) });
    q('invoice', `What is the total of invoices at ${sl(P.id, 2)}?`, { must: [tot(set).toLocaleString('en-US', { minimumFractionDigits: 2 })], computed: [tot(set).toLocaleString('en-US', { minimumFractionDigits: 2 })], cite: set.map((v) => c(v.file, 'cost')) });
  }
  q('invoice', 'Any unpaid invoices at Palo Verde Villas?', { must: ['SV-0912', 'CW-8802'], cite: [c('inv-sun-0912.pdf', 'status'), c('inv-cool-8802.pdf', 'status')] });
  q('invoice', 'What have we been billed for unit 4B?', { must: ['INV-5001', '$285.50'], cite: [c('inv-rios-5001.pdf', 'cost')] });
  q('invoice', 'Invoices for unit 7A', { must: ['CW-8802', '$612.75'], cite: [c('inv-cool-8802.pdf', 'cost')] });
  q('invoice', 'What was billed for unit 12C?', { must: ['BP-3320', '$1,840.00'], cite: [c('inv-bright-3320.pdf', 'cost')] });
  for (const v of [VENDORS.rios, VENDORS.sun, VENDORS.bright, VENDORS.apex, VENDORS.cool, VENDORS.iron]) {
    const set = IVu.filter((x) => x.vendor === v);
    q('invoice', `What invoices has ${sh(v)} sent us?`, { must: un(set), mustNot: un(IVu.filter((x) => x.vendor !== v)), optional: v === VENDORS.rios ? ['INV-7001', 'INV-7002'] : v === VENDORS.cool ? ['INV-7010'] : [], cite: set.map((x) => c(x.file, 'invoice_number')) });
    q('invoice', `How much have we been billed by ${sh(v)} in total?`, { must: [tot(set).toLocaleString('en-US', { minimumFractionDigits: 2 })], computed: [tot(set).toLocaleString('en-US', { minimumFractionDigits: 2 })], modelOk: v === VENDORS.rios || v === VENDORS.cool, alt: v === VENDORS.rios ? [[(tot(set) + 460).toLocaleString('en-US', { minimumFractionDigits: 2 })]] : v === VENDORS.cool ? [[(tot(set) + 200).toLocaleString('en-US', { minimumFractionDigits: 2 })]] : undefined, cite: set.map((x) => c(x.file, 'cost')) });
  }
  q('invoice', 'Does Summit Elevator have any invoices?', { must: [], expectEmpty: true, mustNot: ['INV', '$780'], modelOk: true, note: 'no Summit invoice on file' });
  q('invoice', 'Has Sun Valley been paid for September landscaping?', { must: ['Overdue'], alt: [['not been paid']], cite: [c('inv-sun-0912.pdf', 'status')] });
  q('invoice', 'Which vendors have no invoices on file?', { must: ['Summit'], mustNot: ['Rios', 'Sun Valley', 'Bright', 'Apex', 'Coolwave', 'Ironclad'], modelOk: true });
  q('invoice', 'Did we pay the Bright Path invoice for the 12C make ready?', { must: ['Paid', 'BP-3320'], cite: [c('inv-bright-3320.pdf', 'status')] });
  q('invoice', 'Which invoice goes with WO-20377?', { must: ['BP-3320'], cite: [c('inv-bright-3320.pdf', 'work_order_number')] });
  q('invoice', 'Which invoice goes with work order WO-20431?', { must: ['CW-8802'], cite: [c('inv-cool-8802.pdf', 'work_order_number')] });
  q('invoice', 'Does the Rios invoice for 4B match the work order cost?', { must: ['285.50'], computed: [], modelOk: true });
  q('count', 'How many invoices do we have on file?', { must: [String(T.docs.filter((d) => d.truth.type === 'invoice').length)], alt: [[String(IVu.length)]], computed: [String(T.docs.filter((d) => d.truth.type === 'invoice').length)], note: 'every invoice file (incl. the resent copy and messy ones); distinct readable accepted' });

  /* ================= ATTENTION ================= */
  const atn = { must: ['Apex', 'Summit', 'SV-0912'], optional: ['Rios', 'Sun Valley', '12C', 'WO-20399', 'Desert Willow', 'Copper', 'Rhonda'], alt: [['Apex', 'Summit', 'Sun Valley']], modelOk: true, note: 'COIs expiring within 30 days (Apex today, Summit Oct 11, Rios Oct 26), overdue invoice SV-0912, failed inspections (Saguaro fire, Copper unit 3), overdue reinspection (Willow), lease 12C ending Oct 31, Rhonda Ashby expired lease, WO-20399 on hold' };
  for (const ph of ['What needs my attention?', 'what do I need to deal with this week', 'Give me a rundown of problems across the properties', 'Is anything urgent today?']) q('attention', ph, atn);
  q('attention', 'What compliance issues do we have?', { must: ['Apex', 'Summit'], optional: ['Rios', 'Willow', 'Saguaro', 'Copper'], modelOk: true });
  q('attention', 'What is expiring soon?', { must: ['Apex', 'Summit', 'Rios', '12C'], optional: ['3A', 'Samuel Okafor'], modelOk: true, note: 'COIs and leases expiring within 30 days' });
  q('attention', 'What do we owe that is late?', { must: ['Sun Valley', '1,200.00'], mustNot: ['Bright', 'Coolwave'], cite: [c('inv-sun-0912.pdf', 'invoice_due')] });

  /* ================= AMBIGUOUS ================= */
  q('ambiguous', 'Who is in unit 3B?', { must: ['Elena Vasquez'], alt: [['Quentin Boyd'], ['which property'], ['Saguaro', 'Copper']], modelOk: true, note: '3B exists at Saguaro Ridge (Elena Vasquez, occupied) and Copper Canyon (Quentin Boyd moved out): a clarifying question or both answers' });
  q('ambiguous', 'Is 7A occupied?', { must: ['Delgado'], note: 'only Palo Verde has a 7A; the old and renewed leases are the same tenants' });
  q('ambiguous', 'What is the rent on unit 3?', { must: ['1,750.00'], alt: [['which property'], ['unit 3A', 'unit 3B']], modelOk: true, note: 'unit 3 only at Copper Canyon but 3A/3B exist at Saguaro: acceptable to answer or clarify' });
  q('ambiguous', 'Any work orders for unit 3?', { must: ['WO-20450'], optional: ['WO-20399'], alt: [['which property']], modelOk: true });
  q('ambiguous', 'What is the status of the work order for 4B?', { must: ['Completed'], alt: [['Closed']], cite: [c('wo-4b-leak.pdf', 'status')] });
  q('ambiguous', "What's the rent for 5?", { must: [], modelOk: true, alt: [['1,710.00'], ['which']], note: 'bare "5": unit 5 at Copper Canyon only, but 5A and 5D exist elsewhere' });
  q('ambiguous', 'When does the contract end?', { must: [], modelOk: true, alt: [['which vendor'], ['Sun Valley']], note: 'five vendor contracts: should clarify or list them' });
  q('ambiguous', 'Who is the tenant at 1200 Mesa Drive?', { must: [], modelOk: true, alt: [['Jordan Ellis'], ['which unit']], note: 'many tenants at one address' });
  q('ambiguous', 'What is the invoice total for Rios?', { must: ['285.50'], optional: ['95.00', '380.50'], modelOk: true, note: 'Rios has INV-5001 ($285.50) and INV-5002 ($95.00)' });
  q('ambiguous', 'Is the roof done?', { must: ['On Hold'], cite: [c('wo-roof.pdf', 'status')] });

  /* ================= NOT ANSWERABLE / OTHER INDUSTRY / GENERAL ================= */
  for (const n of [
    'What is the phone number for Jordan Ellis?', 'What is the pet policy at Saguaro Ridge?', 'Which tenants are late on rent this month?', 'How much rent did we collect last month?',
    'What is the late fee at Palo Verde Villas?', 'Who is the leasing agent at Copper Canyon?', 'What are the property taxes on Desert Willow Plaza?', 'What is the lease end date for unit 14B?',
    'Who lives in unit 9Z at Saguaro Ridge?', 'What was the invoice total for Desert Mesa Plumbing?', 'Did Rios Plumbing submit their W-9?', 'What was the insurance premium for Saguaro Ridge?',
    'How many bedrooms is unit 4B?', 'What is the square footage of unit 210?', 'When was Saguaro Ridge built?', 'What is the mortgage balance on Copper Canyon?', 'What is the occupancy rate at Desert Willow Plaza last year?',
    'Was Jordan Ellis late on rent?', 'What is the work order history for unit 11A?', 'Who is the superintendent at Palo Verde?', 'Did Nia Thompson get her security deposit back?', 'What is the elevator permit number at Saguaro Ridge?',
    'What did we spend on landscaping in 2024?', 'How many parking spaces at Copper Canyon?', 'Does unit 12C allow pets?'])
    q('unanswerable', n, { mode: 'null' });
  q('unanswerable', 'What is on purchase order PO-8841?', { must: ['612.00'], modelOk: true, note: 'a PO is on file (Ferguson Enterprises, kitchen faucets, $612.00) even though the property lane does not read purchase orders' });
  q('unanswerable', 'What is the tonnage of the AC at 1200 Mesa Drive?', { must: ['3'], modelOk: true, note: 'an HVAC tune-up sheet (3 tons, R-410A) is on file but is not a property document type' });
  for (const n of ['When is the next backflow test due at Pruitt Dental?', 'What is the serial number of the water heater at 412 Elm?', 'Which RPZ backflow devices are overdue for testing?', 'What size breaker panel is installed at 88 Harmon Street?', 'Show me electrical permits expiring this month', 'When was the sewer camera inspection at Basalt Street?', 'What refrigerant does the Carrier unit at Tillman Freight use?', 'Which service tickets are open for HVAC customers?'])
    q('otherindustry', n, { mode: 'null' });
  for (const g of ['Tell me about the weather', 'What is the capital of Arizona?', 'Write me a poem about apartments', 'What are the Arizona landlord tenant laws on eviction notice?', 'How do I price a one bedroom apartment in Tempe?', 'Who is the best property manager in Mesa?'])
    q('general', g, { mode: 'null' });

  const seen = new Set(); return out.filter((e) => { if (seen.has(e.question)) return false; seen.add(e.question); return true; });
}
