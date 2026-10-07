/**
 * Electrical CLASS variants (generator style). Random electrical companies (two of them, same trade, one database) get permits,
 * inspections, certificates, licences, insurance, bonds and test reports with the data states the app really produces:
 * human corrections (empty = cleared), whitespace-only and zero-width values, two conflicting readings, tech-only (internal)
 * documents, near-identical addresses, the same address/permit number in the OTHER company, 600+ records, and questions with a
 * leftover place word or a negation. Truth is computed here from the raw rows (see class-variants-core.eff); a lane answer must
 * match it by leading number and wording, or decline.
 */
import { rng, pick, chance, shuffle, eff, val, seedDocs, seedBulk, runCases } from './class-variants-core.mjs';

export const TODAY = '2026-10-05';
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const human = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
const STREETS = ['Elm Street', 'Harmon Street', 'Oak Ridge Drive', 'Granite Parkway', 'Juniper Court', 'Birchwood Lane', 'Cedar Avenue', 'Mesquite Road', 'Willow Way'];
const NUMS = [8, 12, 88, 412, 23, 740, 1907, 3300, 61, 5530, 404, 4120];
const NAMES = ['Harlan Moss', 'Pruitt Dental Group', 'Lena Okafor', 'Tillman Freight LLC', 'Corliss Bakery', 'Nadine Ferrara', 'Basalt Brewing Co', 'Orin Vasquez', 'Marta Quill', 'Kestrel Storage', 'Dov Lindqvist', 'Final Draft Bakery', 'Open Door Cafe', 'Permit Pros LLC', 'Rough Cut Lumber'];
const PASS = ['Passed', 'Approved', 'Accepted', 'Satisfactory'];
const FAIL = ['Failed', 'Rejected', 'Corrections Required', 'Not Approved'];
const ZWS = '\u200b'; const NB = '\u00a0';
const WS_ONLY = ['   ', NB, '\u2003', ZWS, ` ${NB}${ZWS} `, '\t', '\u3000'];
const CITY = (i) => ['Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Phoenix'][i % 5];

export function buildOrg(seed, tag, { sites = 14, bulk = 0, mut = 1 } = {}) {
  const r0 = rng(seed); const r = r0; const mr = () => (mut > 0 ? r() / mut : 9); const docs = []; const specs = [];
  const used = new Set();
  for (let i = 0; i < sites + bulk; i++) {
    let addr; do { addr = `${pick(r, NUMS)} ${pick(r, STREETS)}`; } while (used.has(addr) && !chance(r, 0.0)); used.add(addr);
    const cust = pick(r, NAMES); const no = `EL-26-${String(10000 + Math.floor(r() * 89999))}`;
    const s = { i, addr, cust, no, city: CITY(i), tag, docs: {} };
    const loose = i >= sites; // bulk rows are plain
    // permit
    const exp = addDays(TODAY, Math.floor(r() * 400) - 100);
    docs.push({ filename: `${tag}-p${i}.pdf`, type: 'permit', fields: [{ key: 'permit_number', value: no }, { key: 'service_address', value: `${addr}, ${s.city} AZ` }, { key: 'customer_name', value: cust }, { key: 'permit_expiry', value: exp }] });
    s.permitDoc = docs[docs.length - 1];
    if (!loose && mr() < 0.06) { s.permitDoc.fields[0].corrected = ''; s.permitDoc.mut = 'nonumber'; }
    if (!loose && chance(r, 0.12)) docs.push({ filename: `${tag}-p${i}b.pdf`, type: 'permit', fields: [{ key: 'permit_number', value: no }, { key: 'service_address', value: `${addr}, ${s.city} AZ` }, { key: 'customer_name', value: cust }] }); // duplicate permit paper
    const mkInsp = (stage) => {
      const passIt = chance(r, 0.55); const res = passIt ? pick(r, PASS) : pick(r, FAIL);
      const d = { filename: `${tag}-${stage}${i}.pdf`, type: 'inspection-report', fields: [{ key: 'permit_number', value: no }, { key: 'service_address', value: `${addr}, ${s.city} AZ` }, { key: 'customer_name', value: cust }, { key: 'inspection_type', value: stage === 'rough' ? 'Rough-in' : 'Final' }, { key: 'service_date', value: addDays(TODAY, -Math.floor(r() * 120)) }, { key: 'inspection_result', value: res }], stage };
      if (!loose) {
        const m = mr();
        const rf = d.fields.find((x) => x.key === 'inspection_result');
        if (m < 0.10) { rf.corrected = passIt ? pick(r, FAIL) : pick(r, PASS); d.mut = 'corrected'; }
        else if (m < 0.17) { rf.corrected = ''; d.mut = 'cleared'; }
        else if (m < 0.22) { rf.value = pick(r, WS_ONLY); d.mut = 'ws'; }
        else if (m < 0.27) { d.fields.push({ key: 'inspection_result', value: passIt ? pick(r, FAIL) : pick(r, PASS) }); d.mut = 'conflict'; }
        else if (m < 0.33) { d.audience = 'internal'; d.mut = 'internal'; }
        else if (m < 0.37) { rf.corrected = `  ${rf.value}${ZWS}  `; d.mut = 'padded'; }
      }
      return d;
    };
    if (!loose && chance(r, 0.7)) { s.rough = mkInsp('rough'); docs.push(s.rough); }
    if (!loose && chance(r, 0.6)) { s.final = mkInsp('final'); docs.push(s.final); }
    if (!loose && chance(r, 0.12)) { s.cert = { filename: `${tag}-c${i}.pdf`, type: 'certificate-of-completion', fields: [{ key: 'permit_number', value: no }, { key: 'service_address', value: `${addr}, ${s.city} AZ` }, { key: 'service_date', value: addDays(TODAY, -10) }], audience: chance(r, 0.25) ? 'internal' : undefined }; docs.push(s.cert); }
    specs.push(s);
  }
  // other kinds of paper that carry the same keys must never count as permits, inspections or credentials
  if (!bulk) { const sp = specs[0]; if (sp) { docs.push({ filename: `${tag}-inv0.pdf`, type: 'invoice', fields: [{ key: 'permit_number', value: sp.no }, { key: 'inspection_result', value: 'Passed' }, { key: 'inspection_type', value: 'Final' }, { key: 'service_address', value: `${sp.addr}, ${sp.city} AZ` }, { key: 'license_expiry', value: addDays(TODAY, 3) }, { key: 'next_test_due', value: addDays(TODAY, -3) }] }, { filename: `${tag}-wo0.pdf`, type: 'work-order', fields: [{ key: 'status', value: 'Passed' }, { key: 'permit_number', value: sp.no }, { key: 'service_address', value: `${sp.addr}, ${sp.city} AZ` }] }); } }
  // credentials
  const creds = [];
  const mkCred = (kind, n, numKey, dateKey, expDays, extra = {}) => { const exp = addDays(TODAY, expDays); const d = { filename: `${tag}-${kind}-${n}-${creds.length}.pdf`, type: kind, fields: [{ key: numKey, value: n }, { key: dateKey, value: exp }], ...extra }; creds.push(d); docs.push(d); return d; };
  const L = ['ROC-318244', 'ROC-441100', 'ROC-129907', 'ROC-662031'];
  L.forEach((n, k) => {
    const base = Math.floor(r() * 160) - 50;
    mkCred('contractor-license', n, 'license_number', 'license_expiry', base);
    if (chance(r, 0.5)) mkCred('contractor-license', n, 'license_number', 'license_expiry', base + 365); // renewed: newest wins
  });
  ['GL-4410', 'WC-7712', 'GL-5520'].forEach((n) => mkCred('certificate-of-insurance', n, 'policy_number', 'policy_expiry', Math.floor(r() * 200) - 30));
  ['SB-90311', 'SB-11222'].forEach((n) => mkCred('surety-bond', n, 'bond_number', 'bond_expiry', Math.floor(r() * 150) - 20));
  if (!bulk) for (const d of creds) {
    const m = mr(); const dk = d.fields[1];
    if (m < 0.10) { dk.corrected = addDays(TODAY, Math.floor(r() * 300) - 60); d.mut = 'corrected'; }
    else if (m < 0.16) { dk.corrected = ''; d.mut = 'cleared'; }
    else if (m < 0.20) { dk.value = pick(r, WS_ONLY); d.mut = 'ws'; }
    else if (m < 0.24) { d.fields.push({ key: dk.key, value: addDays(TODAY, Math.floor(r() * 300) - 60) }); d.mut = 'conflict'; }
    else if (m < 0.30) { d.audience = 'internal'; d.mut = 'internal'; }
    else if (m < 0.34) { dk.value = `${human(dk.value)}`; d.mut = 'longform'; }
    else if (m < 0.40) { dk.value = pick(r, ['2027', '12/31/27', 'TBD', 'N/A', 'Q4 2026', 'see policy']); d.mut = 'unreadable'; }
  }
  // test reports
  const tests = [];
  [['Generator', 'a'], ['Transfer Switch', 'b'], ['Thermography', 'c']].forEach(([eq, k], j) => {
    const sp = specs[j % Math.max(1, specs.length)] ?? specs[0];
    const old = { filename: `${tag}-t${k}-old.pdf`, type: 'test-report', fields: [{ key: 'service_address', value: sp?.addr ?? '1 Test Street' }, { key: 'equipment_type', value: eq }, { key: 'service_date', value: addDays(TODAY, -400) }, { key: 'next_test_due', value: addDays(TODAY, -35) }] };
    const nw = { filename: `${tag}-t${k}-new.pdf`, type: 'test-report', fields: [{ key: 'service_address', value: sp?.addr ?? '1 Test Street' }, { key: 'equipment_type', value: eq }, { key: 'service_date', value: addDays(TODAY, -30) }, { key: 'next_test_due', value: addDays(TODAY, Math.floor(r() * 120) - 20) }] };
    tests.push(old, nw); docs.push(old, nw);
    if (!bulk) { const m = mr(); const f = nw.fields[3]; if (m < 0.15) { f.corrected = ''; nw.mut = 'cleared'; } else if (m < 0.3) { f.corrected = addDays(TODAY, Math.floor(r() * 120) - 20); nw.mut = 'corrected'; } else if (m < 0.38) { nw.audience = 'internal'; nw.mut = 'internal'; } }
  });
  return { docs, specs, creds, tests, tag };
}

const toIso = (v) => { const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(String(v ?? '')); if (!m) return v; const mo = MON.findIndex((x) => x === m[1]) + 1; return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`; };
const visible = (d) => d.audience !== 'internal';
const pass = (s) => PASS.some((p) => p.toLowerCase() === String(s).toLowerCase());
const fail = (s) => FAIL.some((p) => p.toLowerCase() === String(s).toLowerCase());

/** Truth from the raw rows. */
export function truthOf(org) {
  const vis = org.docs.filter(visible);
  const inspections = vis.filter((d) => d.type === 'inspection-report');
  const bad = inspections.some((d) => ['CONFLICT', null].includes(val(d, 'inspection_result')) || ['CONFLICT', null].includes(val(d, 'inspection_type')));
  const closedNo = new Set();
  for (const d of vis) {
    const no = val(d, 'permit_number'); if (!no || no === 'CONFLICT') continue;
    if (d.type === 'certificate-of-completion') closedNo.add(no.toLowerCase());
    if (d.type === 'inspection-report' && /final/i.test(val(d, 'inspection_type') ?? '') && pass(val(d, 'inspection_result') ?? '')) closedNo.add(no.toLowerCase());
  }
  const permitNos = [...new Set(vis.filter((d) => d.type === 'permit').map((d) => val(d, 'permit_number')).filter((x) => x && x !== 'CONFLICT'))];
  const nonum = vis.some((d) => d.type === 'permit' && [null, 'CONFLICT'].includes(val(d, 'permit_number')));
  const open = permitNos.filter((n) => !closedNo.has(n.toLowerCase()));
  const failedDocs = inspections.filter((d) => fail(val(d, 'inspection_result') ?? ''));
  return { bad, nonum, open, closed: permitNos.filter((n) => closedNo.has(n.toLowerCase())), permitDocs: vis.filter((d) => d.type === 'permit').length, failedDocs, permitNos };
}

function credTruth(org, type, numKey, dateKey, withinDays) {
  const vis = org.docs.filter((d) => visible(d) && d.type === type);
  const dv = (d) => { if (type !== 'certificate-of-insurance') { const v = val(d, dateKey); return v === 'CONFLICT' ? v : toIso(v); } const vs = [...new Set(d.fields.filter((x) => x.key === dateKey).map(eff).filter(Boolean).map(toIso))].sort(); return vs.length ? vs[0] : null; }; // several coverages on one certificate: the earliest decides
  const any = vis.some((d) => [null, 'CONFLICT'].includes(dv(d)) || d.mut === 'unreadable');
  if (any) return { decline: true };
  const best = new Map();
  for (const d of vis) { const n = String(val(d, numKey)).toLowerCase(); const e = dv(d); if (!best.has(n) || e >= best.get(n).e) best.set(n, { n: val(d, numKey), e }); }
  const lim = addDays(TODAY, withinDays);
  const picks = [...best.values()].filter((x) => x.e <= lim);
  return { picks, all: [...best.values()] };
}

export function casesFor(org, other) {
  const T = truthOf(org); const C = []; const add = (cls, q, exp) => C.push({ cls, q, exp });
  const openNos = T.open; const closedNos = T.closed;
  const ex = (ok, exp) => (ok ? exp : { decline: true });
  // open permits (global)
  for (const q of ['How many permits are still open?', 'How many permits are open?']) add('open-count', q, T.bad || T.nonum ? { decline: true } : { lead: openNos.length, must: [`${openNos.length} permit`] });
  for (const q of ['Which permits are still open?', 'Show me open permits', 'Which permits have no final inspection?']) add('open-list', q, T.bad || T.nonum ? { decline: true } : { lead: openNos.length, must: openNos, mustNot: closedNos });
  add('permit-count', 'How many permits do we have?', { lead: T.permitDocs, must: [`${T.permitDocs} permit`] });
  // failed inspections
  for (const q of ['Which inspections failed?', 'How many failed inspections do we have?']) add('failed', q, T.bad ? { decline: true } : { lead: T.failedDocs.length, must: [`${T.failedDocs.length} failed inspection`] });
  // per-site result questions
  for (const s of org.specs.slice(0, 14)) {
    const sameAddr = org.specs.filter((o) => o.addr === s.addr);
    if (sameAddr.length > 1) continue;
    for (const [stage, doc, word] of [['final', s.final, 'final'], ['rough', s.rough, 'rough-in']]) {
      const q = `Did ${s.addr} pass ${word} inspection?`;
      if (!doc || doc.audience === 'internal') { const certOk = stage === 'final' && s.cert && s.cert.audience !== 'internal'; add('site-result', q, certOk ? { must: ['certificate of completion'] } : { must: [`don't see a ${stage}`] }); continue; }
      const res = val(doc, 'inspection_result');
      if (res == null || res === 'CONFLICT') { add('site-result', q, { decline: true }); continue; }
      const rawBefore = doc.fields.find((x) => x.key === 'inspection_result');
      const mustNot = doc.mut === 'corrected' ? [String(rawBefore.value)].filter((v) => !res.toLowerCase().includes(v.toLowerCase())) : [];
      add('site-result', q, { must: [res], mustNot });
    }
    if (org.specs.filter((o) => o.cust === s.cust).length === 1 && s.permitDoc.audience !== 'internal' && !s.permitDoc.mut) add('site-cust', `What permit number does ${s.cust} have?`, { must: [s.no] });
    add('site-permit', `What is the permit number for ${s.addr}?`, s.permitDoc.audience === 'internal' ? { decline: true } : { must: [s.no] });
  }
  // credentials
  for (const [word, type, nk, dk] of [['licenses', 'contractor-license', 'license_number', 'license_expiry'], ['insurance certificates', 'certificate-of-insurance', 'policy_number', 'policy_expiry'], ['bonds', 'surety-bond', 'bond_number', 'bond_expiry']]) {
    for (const days of [60, 90]) {
      const ct = credTruth(org, type, nk, dk, days);
      const q = `Which ${word} expire in the next ${days} days?`;
      if (ct.decline) { add('cred-window', q, { decline: true }); continue; }
      add('cred-window', q, ct.picks.length ? { lead: ct.picks.length, must: ct.picks.map((x) => x.n), mustNot: ct.all.filter((x) => !ct.picks.includes(x)).map((x) => x.n) } : { leadNone: true });
    }
    const ex0 = credTruth(org, type, nk, dk, -1);
    const q2 = `Which ${word} have already expired?`;
    if (ex0.decline) add('cred-expired', q2, { decline: true });
    else add('cred-expired', q2, ex0.picks.length ? { lead: ex0.picks.length, must: ex0.picks.map((x) => x.n), mustNot: ex0.all.filter((x) => !ex0.picks.includes(x)).map((x) => x.n) } : { leadNone: true });
  }
  // tests due
  { const vis = org.tests.filter(visible); const groups = new Map();
    for (const d of vis) { const k = `${val(d, 'service_address')}|${val(d, 'equipment_type')}`.toLowerCase(); const cur = groups.get(k); if (!cur || val(d, 'service_date') >= val(cur, 'service_date')) groups.set(k, d); }
    const latest = [...groups.values()];
    const unreadable = latest.some((d) => [null, 'CONFLICT'].includes(val(d, 'next_test_due')));
    const hiddenNewer = org.tests.some((d) => !visible(d));
    const over = latest.filter((d) => val(d, 'next_test_due') && val(d, 'next_test_due') !== 'CONFLICT' && val(d, 'next_test_due') < TODAY);
    void unreadable; void hiddenNewer;
    add('tests-overdue', 'Which tests are overdue?', over.length ? { lead: over.length } : { leadNone: true });
  }
  // leftover / negation / foreign names: must decline
  add('leftover', 'How many permits are still open in Narnia?', { decline: true });
  add('leftover', 'Which permits are open for Zzyzx Industrial Holdings?', { decline: true });
  add('negation', 'Which permits are not open?', { decline: true });
  add('negation', 'Which inspections have not failed?', { decline: true });
  if (other) {
    const foreign = other.specs.find((s) => !org.specs.some((o) => o.addr === s.addr));
    if (foreign) {
      add('other-org', `Did ${foreign.addr} pass final inspection?`, { decline: true });
      add('other-org', `What is the permit number for ${foreign.addr}?`, { decline: true });
      const fcust = other.specs.find((s) => !org.specs.some((o) => o.cust === s.cust));
      if (fcust) add('other-org', `What permit number does ${fcust.cust} have?`, { decline: true });
    }
  }
  return C;
}

export async function runElectricalVariants({ H, seeds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], lane, log }) {
  const { addSecondCompany } = await import('./class-variants-core.mjs');
  const stats = {};
  const B2 = await addSecondCompany(H, 'electrical', 'b');
  for (const seed of seeds) {
    const rate = [0, 0.04, 0.12, 0.35, 1][seed % 5];
    const A = buildOrg(seed * 7 + 1, 'a', { mut: rate }); const B = buildOrg(seed * 13 + 5, 'b', { mut: rate });
    // an address and a permit number deliberately shared by both companies, with opposite results
    { const sh = A.specs[0]; const bs = B.specs[0]; if (sh && bs && !B.specs.some((o) => o.addr === sh.addr)) { for (const d of B.docs) for (const fl of d.fields) if (fl.key === 'service_address' && String(fl.value).startsWith(`${bs.addr},`)) fl.value = fl.value.replace(bs.addr, sh.addr); bs.addr = sh.addr; } }
    await H.as('electrical', async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); });
    await B2.as(async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); });
    await H.as('electrical', (db) => seedDocs(db, A.docs));
    await B2.as((db) => seedDocs(db, B.docs));
    await runCases((fn) => H.as('electrical', fn), lane, casesFor(A, B), TODAY, stats, (m) => log(`seed ${seed} org A ${m}`));
    await runCases((fn) => B2.as(fn), lane, casesFor(B, A), TODAY, stats, (m) => log(`seed ${seed} org B ${m}`));
  }
  if (process.env.NOBULK) return stats;
  // volume: records past 200 and past 500 are counted from the whole table (never the length of a limited list)
  for (const n of [230, 620]) {
    await H.as('electrical', async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); });
    const closedEvery = 3; const failedN = Math.floor(n / 4);
    await H.as('electrical', async (db) => {
      await seedBulk(db, { n, type: 'permit', prefix: 'bp', fields: { permit_number: `'EL-BULK-' || g::text`, service_address: `g::text || ' Bulk Street, Mesa AZ'` } });
      await seedBulk(db, { n: Math.floor(n / closedEvery), type: 'certificate-of-completion', prefix: 'bc', fields: { permit_number: `'EL-BULK-' || (g * ${closedEvery})::text`, service_date: `'2026-08-01'` } });
      await seedBulk(db, { n: failedN, type: 'inspection-report', prefix: 'bi', fields: { permit_number: `'EL-BULK-' || (g * 2)::text`, inspection_type: `'Rough-in'`, inspection_result: `'Failed'`, service_date: `'2026-07-01'` } });
      await seedBulk(db, { n: 90, type: 'contractor-license', prefix: 'bl', fields: { license_number: `'ROC-' || g::text`, license_expiry: `to_char(date '2026-10-05' + (g - 30), 'YYYY-MM-DD')` } });
    });
    const open = n - Math.floor(n / closedEvery); const licSoon = 30 + 60 + 1; // g-30 <= 60 -> g <= 90 -> all 90 within 60 days; expired g < 30 -> 29
    const cases = [
      { cls: 'bulk-count', q: 'How many permits do we have?', exp: { lead: n } },
      { cls: 'bulk-open', q: 'How many permits are still open?', exp: { lead: open } },
      { cls: 'bulk-open', q: 'Which permits are still open?', exp: { lead: open } },
      { cls: 'bulk-failed', q: 'How many failed inspections do we have?', exp: { lead: failedN } },
      { cls: 'bulk-cred', q: 'Which licenses expire in the next 60 days?', exp: { lead: 90 } },
      { cls: 'bulk-cred', q: 'Which licenses have already expired?', exp: { lead: 29 } },
    ];
    void licSoon;
    await runCases((fn) => H.as('electrical', fn), lane, cases, TODAY, stats, (m) => log(`bulk ${n} ${m}`));
  }
  return stats;
}
