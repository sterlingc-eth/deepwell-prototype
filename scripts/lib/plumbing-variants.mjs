/**
 * Plumbing CLASS variants (generator style). Two random plumbing companies (same trade, one database) get backflow certificates,
 * water heater warranties, permits and invoices in the data states the app really produces: human corrections (empty = cleared),
 * whitespace-only / zero-width values, two conflicting readings, tech-only (internal) documents, a permit with no number,
 * payable / non-USD / credit money, a serial shared with the OTHER company, 230 and 620 records, leftover words and negations.
 * Truth is computed here from the raw rows by the rule in class-variants-core (eff / val), not by product code. A lane answer
 * must match by leading number and wording, or decline.
 */
import { rng, pick, chance, eff, val, seedDocs, seedBulk, runCases, addSecondCompany } from './class-variants-core.mjs';

export const TODAY = '2026-10-05';
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const STREETS = ['Elm Street', 'Harmon Street', 'Oak Ridge Drive', 'Granite Parkway', 'Juniper Court', 'Birchwood Lane', 'Cedar Avenue', 'Mesquite Road'];
const NAMES = ['Harlan Moss', 'Pruitt Dental Group', 'Lena Okafor', 'Tillman Freight LLC', 'Corliss Bakery', 'Nadine Ferrara', 'Basalt Brewing Co', 'Orin Vasquez', 'Marta Quill', 'Kestrel Storage'];
const ZWS = '​'; const NB = ' ';
const WS_ONLY = ['   ', NB, ' ', ZWS, ` ${NB}${ZWS} `, '\t', '　'];
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isPass = (v) => /pass/i.test(v) && !/fail|not/i.test(v);
const isFail = (v) => /fail/i.test(v);
const visible = (d) => d.audience !== 'internal';

export function buildOrg(seed, tag, { n = 10, mut = 1, shareSerial = null } = {}) {
  const r = rng(seed); const mr = () => (mut > 0 ? r() / mut : 9); const docs = []; const used = new Set();
  const addrOf = () => { let a; do { a = `${10 + Math.floor(r() * 4000)} ${pick(r, STREETS)}`; } while (used.has(a)); used.add(a); return a; };
  const org = { tag, devices: [], heaters: [], permits: [], invoices: [], docs };
  for (let i = 0; i < n; i++) {
    const addr = addrOf(); const cust = pick(r, NAMES);
    // ---- backflow device: 1-3 certificates on distinct dates
    const serial = i === 0 && shareSerial ? shareSerial : `BF${tag.toUpperCase()}${100 + i}${Math.floor(r() * 90)}`;
    const dev = { serial, addr, certs: [] }; const k = 1 + Math.floor(r() * 3);
    for (let c = 0; c < k; c++) {
      const passIt = chance(r, 0.6); const date = addDays(TODAY, -400 + c * 120 + Math.floor(r() * 50));
      const d = { filename: `${tag}-bf${i}-${c}.pdf`, type: 'backflow-test-certificate', fields: [{ key: 'serial_number', value: serial }, { key: 'service_address', value: `${addr}, Mesa AZ` }, { key: 'customer_name', value: cust }, { key: 'service_date', value: date }, { key: 'backflow_test_result', value: passIt ? pick(r, ['Passed', 'Pass']) : pick(r, ['Failed', 'Fail']) }, { key: 'next_test_due', value: addDays(date, 365) }, { key: 'equipment_type', value: 'RPZ backflow preventer' }] };
      const m = mr(); const rf = d.fields[4];
      if (m < 0.08) { rf.corrected = passIt ? 'Failed' : 'Passed'; }
      else if (m < 0.14) { rf.corrected = ''; }
      else if (m < 0.19) { rf.value = pick(r, WS_ONLY); }
      else if (m < 0.24) { d.fields.push({ key: 'backflow_test_result', value: passIt ? 'Failed' : 'Passed' }); }
      else if (m < 0.32) { d.audience = 'internal'; }
      else if (m < 0.36) { rf.corrected = `  ${rf.value}${ZWS} `; }
      dev.certs.push(d); docs.push(d);
    }
    org.devices.push(dev);
    // ---- water heater with a registration
    const wsn = `WH${tag.toUpperCase()}${200 + i}`; const waddr = addrOf();
    const exp = addDays(TODAY, Math.floor(r() * 700) - 250);
    const reg = { filename: `${tag}-wr${i}.pdf`, type: 'warranty-registration', fields: [{ key: 'serial_number', value: wsn }, { key: 'service_address', value: `${waddr}, Mesa AZ` }, { key: 'customer_name', value: pick(r, NAMES) }, { key: 'equipment_type', value: 'Water Heater (tank)' }, { key: 'warranty_expires', value: exp }, { key: 'warranty_registered_date', value: addDays(exp, -2190) }] };
    { const m = mr(); const ef = reg.fields[4];
      if (m < 0.08) ef.corrected = addDays(exp, 400);
      else if (m < 0.14) ef.corrected = '';
      else if (m < 0.19) ef.value = pick(r, WS_ONLY);
      else if (m < 0.24) reg.fields.push({ key: 'warranty_expires', value: addDays(exp, 90) });
      else if (m < 0.31) reg.audience = 'internal';
      else if (m < 0.35) ef.value = 'sometime in 2027'; }
    org.heaters.push({ serial: wsn, reg }); docs.push(reg);
    // ---- permit
    const no = `PL-26-${10000 + Math.floor(r() * 89999)}`; const paddr = addrOf();
    const pexp = addDays(TODAY, Math.floor(r() * 400) - 120); const stat = pick(r, ['Open', 'Issued', 'Final', 'Closed', 'Open']);
    const p = { filename: `${tag}-pm${i}.pdf`, type: 'permit', fields: [{ key: 'permit_number', value: no }, { key: 'service_address', value: `${paddr}, Mesa AZ` }, { key: 'customer_name', value: cust }, { key: 'permit_status', value: stat }, { key: 'permit_expires', value: pexp }] };
    { const m = mr(); const sf = p.fields[3];
      if (m < 0.07) sf.corrected = stat === 'Final' || stat === 'Closed' ? 'Open' : 'Final';
      else if (m < 0.12) sf.corrected = '';
      else if (m < 0.16) sf.value = pick(r, WS_ONLY);
      else if (m < 0.21) p.fields.push({ key: 'permit_status', value: stat === 'Final' ? 'Open' : 'Final' });
      else if (m < 0.28) p.audience = 'internal';
      else if (m < 0.31) p.fields[0].corrected = ''; }
    org.permits.push(p); docs.push(p);
    // ---- invoice
    const amt = Math.round((50 + r() * 4000) * 100) / 100; const inv = `INV-${tag}${3000 + i}`;
    const iv = { filename: `${tag}-inv${i}.pdf`, type: 'invoice', fields: [{ key: 'invoice_number', value: inv }, { key: 'service_address', value: `${addr}, Mesa AZ` }, { key: 'customer_name', value: cust }, { key: 'cost', value: String(amt) }, { key: 'service_date', value: addDays(TODAY, -30 - i) }] };
    iv.amt = amt; iv.inv = inv;
    { const m = mr(); const cf = iv.fields[3];
      if (m < 0.08) { iv.amt = amt + 100; cf.corrected = String(iv.amt); }
      else if (m < 0.13) cf.corrected = '';
      else if (m < 0.18) cf.value = pick(r, WS_ONLY);
      else if (m < 0.23) iv.fields.push({ key: 'cost', value: String(amt + 7) });
      else if (m < 0.29) iv.audience = 'internal';
      else if (m < 0.34) iv.fields.push({ key: 'status', value: 'Payable to vendor' });
      else if (m < 0.39) cf.value = `CAD ${amt}`;
      else if (m < 0.44) cf.value = `(${amt})`;
      else if (m < 0.48) cf.value = `-${amt}`; }
    org.invoices.push(iv); docs.push(iv);
  }
  return org;
}

/** current visible certificate of a device by the independent rule: newest date among visible certificates */
function devTruth(dev) {
  const vis = dev.certs.filter(visible);
  if (!vis.length) return null;
  const sorted = [...vis].sort((a, b) => String(val(a, 'service_date')).localeCompare(String(val(b, 'service_date'))));
  const cur = sorted[sorted.length - 1]; const res = val(cur, 'backflow_test_result');
  const clash = vis.some((d) => ['service_date', 'backflow_test_result'].some((k) => val(d, k) === 'CONFLICT'));
  const status = res == null ? 'other' : res === 'CONFLICT' ? 'other' : isFail(res) ? 'failed' : isPass(res) ? 'passed' : 'other';
  const due = val(cur, 'next_test_due');
  return { serial: dev.serial, status, due, clash };
}

function casesFor(org, other) {
  const C = []; const add = (cls, q, exp) => C.push({ cls, q, exp });
  // ---- backflow
  const dts = org.devices.map(devTruth).filter(Boolean);
  const bfClash = dts.some((d) => d.clash);
  const allOther = (xs) => xs.some((d) => d.status === 'other');
  const overdue = dts.filter((d) => d.status === 'passed' && d.due && d.due < TODAY);
  const notOverdue = dts.filter((d) => !overdue.includes(d));
  const failed = dts.filter((d) => d.status === 'failed');
  if (bfClash) { add('bf-overdue', 'Which backflow tests are overdue?', { decline: true }); add('bf-failed', 'Which backflow tests failed?', { decline: true }); }
  else {
    add('bf-overdue', 'Which backflow tests are overdue?', overdue.length ? { must: overdue.map((d) => d.serial), mustNot: notOverdue.filter((d) => d.status !== 'other').map((d) => d.serial) } : { mustNot: dts.filter((d) => d.status !== 'other').map((d) => d.serial) });
    add('bf-failed', 'Which backflow tests failed?', failed.length ? { ...(allOther(dts) ? {} : { lead: failed.length }), must: failed.map((d) => d.serial), mustNot: dts.filter((d) => d.status === 'passed').map((d) => d.serial) } : { mustNot: dts.filter((d) => d.status === 'passed').map((d) => d.serial) });
    const serials = new Set(org.devices.flatMap((d) => d.certs.filter(visible).map((c) => val(c, 'serial_number'))).filter(Boolean));
    add('bf-count', 'How many backflow devices do we track?', { lead: serials.size });
  }
  // ---- warranties
  const hs = org.heaters.filter((h) => visible(h.reg));
  const hclash = hs.some((h) => val(h.reg, 'warranty_expires') === 'CONFLICT');
  const hunread = hs.some((h) => { const e = val(h.reg, 'warranty_expires'); return e != null && e !== 'CONFLICT' && !/^\d{4}-\d{2}-\d{2}$/.test(e); });
  if (hclash || hunread) { add('wh-expired', 'How many water heaters have an expired warranty?', { decline: true }); add('wh-soon', 'Which water heater warranties are expiring in the next 90 days?', { decline: true }); }
  else {
    const exps = hs.map((h) => ({ s: h.serial, e: val(h.reg, 'warranty_expires') })).filter((x) => x.e);
    const ex = exps.filter((x) => x.e < TODAY); const soon = exps.filter((x) => x.e >= TODAY && x.e <= addDays(TODAY, 90));
    add('wh-expired', 'How many water heaters have an expired warranty?', { lead: ex.length });
    add('wh-soon', 'Which water heater warranties are expiring in the next 90 days?', soon.length ? { lead: soon.length, mustNot: exps.filter((x) => !soon.includes(x)).map((x) => x.s) } : { mustNot: exps.map((x) => x.s) });
  }
  // ---- permits
  const ps = org.permits.filter(visible);
  const pclash = ps.some((p) => ['permit_status', 'permit_expires', 'permit_number'].some((k) => val(p, k) === 'CONFLICT'));
  const pnoNo = ps.some((p) => val(p, 'permit_number') == null);
  const stateOf = (p) => { const st = val(p, 'permit_status'); const ex = val(p, 'permit_expires'); if (st && /^(final|closed)$/i.test(st)) return 'finished'; if (ex && ex < TODAY) return 'expired'; return 'open'; };
  if (pclash || pnoNo) { for (const q of ['How many permits are open?', 'Which permits are still open?', 'How many permits have expired?']) add('pm', q, { decline: true }); }
  else {
    const open = ps.filter((p) => stateOf(p) === 'open'); const expd = ps.filter((p) => stateOf(p) === 'expired');
    add('pm', 'How many permits are open?', { lead: open.length });
    add('pm', 'Which permits are still open?', open.length ? { lead: open.length, must: open.map((p) => val(p, 'permit_number')), mustNot: ps.filter((p) => stateOf(p) !== 'open').map((p) => val(p, 'permit_number')) } : { leadNone: true });
    add('pm', 'How many permits have expired?', { lead: expd.length });
  }
  // ---- invoices
  for (const iv of org.invoices) {
    const cost = val(iv, 'cost'); const inv = iv.inv; const seesNo = visible(iv);
    if (!seesNo) { add('inv-total', `What is the total on invoice ${inv}?`, { decline: true }); continue; }
    const status = eff(iv.fields.find((x) => x.key === 'status') ?? { value: '' }) ?? '';
    if (cost === 'CONFLICT' || cost == null || !/^\$?\s?\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(cost) || /payable|vendor/i.test(status)) { add('inv-total', `What is the total on invoice ${inv}?`, { decline: true }); continue; }
    add('inv-total', `What is the total on invoice ${inv}?`, { must: [money(Number(cost))] });
  }
  { const n = org.invoices.filter(visible).length; add('inv-count', 'How many invoices do we have on file?', { lead: n }); }
  // ---- leftover / negation / foreign names
  add('leftover', 'How many permits are open in Narnia?', { decline: true });
  add('leftover', 'Which backflow tests are overdue for Zzyzx Industrial Holdings?', { decline: true });
  add('negation', 'Which permits are not open?', { decline: true });
  add('negation', 'Which backflow tests have not failed?', { decline: true });
  if (other) {
    const fi = other.invoices.find((iv) => !org.invoices.some((o) => o.inv === iv.inv));
    if (fi) add('other-org', `What is the total on invoice ${fi.inv}?`, { decline: true });
    const fs = other.devices.find((d) => !org.devices.some((o) => o.serial === d.serial));
    if (fs) add('other-org', `When is the backflow test due for serial ${fs.serial}?`, { decline: true });
  }
  return C;
}

const wipe = (db) => db.raw(`DELETE FROM extractions`, []).then(() => db.raw(`DELETE FROM facets`, [])).then(() => db.raw(`DELETE FROM documents`, []));

export async function runPlumbingVariants({ H, seeds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], lane, log }) {
  const stats = {};
  const B2 = await addSecondCompany(H, 'plumbing', 'b');
  for (const seed of seeds) {
    const rate = [0, 0.04, 0.12, 0.35, 1][seed % 5];
    const shared = `BFSHARED${seed}`; // one serial in BOTH companies, opposite histories
    const A = buildOrg(seed * 7 + 1, 'a', { mut: rate, shareSerial: shared }); const B = buildOrg(seed * 13 + 5, 'b', { mut: rate, shareSerial: shared });
    await H.as('plumbing', wipe); await B2.as(wipe);
    await H.as('plumbing', (db) => seedDocs(db, A.docs));
    await B2.as((db) => seedDocs(db, B.docs));
    await runCases((fn) => H.as('plumbing', fn), lane, casesFor(A, B), TODAY, stats, (m) => log(`seed ${seed} org A ${m}`));
    await runCases((fn) => B2.as(fn), lane, casesFor(B, A), TODAY, stats, (m) => log(`seed ${seed} org B ${m}`));
  }
  if (process.env.NOBULK) return stats;
  // volume: counts past 200 and past 500 come from the whole table, never from a limited list
  for (const n of [230, 620]) {
    await H.as('plumbing', wipe);
    await H.as('plumbing', async (db) => {
      await seedBulk(db, { n, type: 'permit', prefix: 'bp', fields: { permit_number: `'PL-BULK-' || g::text`, service_address: `g::text || ' Bulk Street, Mesa AZ'`, permit_status: `CASE WHEN g % 3 = 0 THEN 'Final' ELSE 'Open' END`, permit_expires: `'2027-12-31'` } });
      await seedBulk(db, { n, type: 'invoice', prefix: 'bv', fields: { invoice_number: `'INV-B' || g::text`, cost: `'10.00'` } });
    });
    const open = n - Math.floor(n / 3);
    await runCases((fn) => H.as('plumbing', fn), lane, [
      { cls: 'bulk-count', q: 'How many permits do we have?', exp: { lead: n } },
      { cls: 'bulk-count', q: 'How many invoices do we have on file?', exp: { lead: n } },
      { cls: 'bulk-open', q: 'How many permits are open?', exp: { lead: open } },
      { cls: 'bulk-open', q: 'Which permits are still open?', exp: { lead: open } },
    ], TODAY, stats, (m) => log(`bulk ${n} ${m}`));
  }
  return stats;
}
