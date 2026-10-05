/**
 * Deterministic office-file fixture generator + the oracle (expected.json) built from the SAME source data, never from a reader.
 *
 *   node scripts/office-fixtures/gen.mjs                  write files/ (skips the big hostile zips if already present)
 *   node scripts/office-fixtures/gen.mjs --force          rewrite everything
 *   node scripts/office-fixtures/gen.mjs --write-expected (re)write expected.json + EXPECTED.sha256 (phase-1 only; never after a run)
 *
 * Without --write-expected the freshly computed oracle is compared with the committed expected.json and the run fails on any
 * difference (proves the generator is deterministic and the answers were not edited). Generated binaries are NOT committed:
 * add `scripts/office-fixtures/files/` to .gitignore locally. Hostile files are small zips that INFLATE huge; nothing big is
 * ever written to disk. Fixed seeds and fixed dates throughout; no clock, no network, no randomness.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  rng, esc, XMLDECL, zip, bombEntry, docx, P, TBL, xlsx, ole2, pdf, BIZ, makeCustomers, TECHS, money, moneyVariants, dateVariants,
  addDays, mdy, PARTS, BRANDS,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'files');
const FORCE = process.argv.includes('--force');
const WRITE_EXPECTED = process.argv.includes('--write-expected');

const files = new Map(); // name -> { bytes: Buffer, exp }
const EXPECT = {};
const CT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const ACCEPT_EXT = new Set(Object.keys(CT));
const ext = (n) => n.split('.').pop().toLowerCase();

/** Register a file and its oracle entry. */
function add(name, bytes, meta) {
  const e = ext(name);
  const exp = {
    type: e, upload: ACCEPT_EXT.has(e) ? 'accept' : 'reject', contentType: CT[e] ?? 'application/octet-stream',
    status: 'read', ...meta, keys: meta.keys ?? [], questions: [], bytes: bytes.length,
  };
  files.set(name, { bytes, exp });
  EXPECT[name] = exp;
  return exp;
}
/** Question helper. answers: array of (string | string[] anyOf). same: strings that must share the cited page with the answer. */
function q(exp, question, answers, where, o = {}) {
  exp.questions.push({
    question, answers: answers.map((a) => (Array.isArray(a) ? a : [a])), where, same: o.same ?? [], mustNot: o.mustNot ?? [],
    hard: o.hard ?? [], global: !!o.global, ...(o.kind ? { kind: o.kind } : {}), ...(o.allOf ? { allOf: o.allOf } : {}), ...(o.expectedCount != null ? { expectedCount: o.expectedCount } : {}),
    ...(o.markedHidden ? { markedHidden: true } : {}), ...(o.pageTolerance != null ? { pageTolerance: o.pageTolerance } : {}),
  });
}
const sheetMeta = (name, rows, state = 'visible') => ({ name, state, nonEmpty: rows.some((r) => r && r.some((c) => c != null && c !== '')), dataRows: rows.filter((r) => r && r.length).length });
const estChars = (sheets) => sheets.reduce((n, s) => n + (s.state === 'hidden' ? 0 : s.rows.reduce((m, r) => m + (r ?? []).reduce((k, c) => k + (c == null ? 0 : String(typeof c === 'object' ? c.v : c).length + 1), 0), 0)), 0);
const sheetPages = (sheets) => { const c = estChars(sheets); const est = Math.max(sheets.filter((s) => s.rows.length).length, c / 6000); return [Math.max(1, Math.floor(est * 0.5)), Math.ceil(est * 2) + 1]; };
const docPages = (chars) => [Math.max(1, Math.floor((chars / 3000) * 0.7)), Math.ceil((chars / 3000) * 1.4) + 1];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const longDate = (s) => { const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']; return `${M[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}, ${s.slice(0, 4)}`; };
const sheetOf = (name, rows, extra = {}) => ({ name, rows, ...extra });
const SHEET = (name, row, extra = {}) => ({ sheet: name, row, ...extra });
const CUST = makeCustomers(90, 7);
const UNIQ = CUST.slice(0, 30); // first 30 have unique last names: safe for name questions
const sampleKeys = (arr, n) => { const step = Math.max(1, Math.floor(arr.length / n)); return arr.filter((_, i) => i % step === 0).slice(0, n); };

/* ============================================================== 1. INVOICES (docx) */
function invoiceData(biz, no, cust, techIdx, date, seed) {
  const r = rng(seed); const n = r.int(3, 5);
  const lines = Array.from({ length: n }, () => { const part = r.pick(PARTS); const qty = r.int(1, 3); const unit = r.int(1800, 54000) / 100; return { desc: `${r.pick(BRANDS)} ${part}`, qty, unit, amt: Math.round(qty * unit * 100) / 100 }; });
  lines.unshift({ desc: 'Diagnostic and service call', qty: 1, unit: 89, amt: 89 });
  const sub = Math.round(lines.reduce((a, l) => a + l.amt, 0) * 100) / 100;
  const rate = 0.0805; const tax = Math.round(sub * rate * 100) / 100; const total = Math.round((sub + tax) * 100) / 100;
  return { biz, no, cust, tech: TECHS[techIdx], date, due: addDays(date, 15), lines, sub, rate, tax, total };
}
function addInvoiceDocx(name, inv) {
  const { biz } = inv;
  const body = [P('INVOICE', { style: 'Title' }), P(`Invoice No: ${inv.no}`), P(`Invoice Date: ${longDate(inv.date)}`), P(`Due Date: ${longDate(inv.due)}`),
    P({ t: 'Bill To:', b: true }), P(inv.cust.name), P(`${inv.cust.addr}, ${inv.cust.city}, AZ ${inv.cust.zip}`), P(`Phone: ${inv.cust.phone}`), P(`Technician: ${inv.tech}`),
    TBL([['Description', 'Qty', 'Unit Price', 'Amount'], ...inv.lines.map((l) => [l.desc, String(l.qty), money(l.unit), money(l.amt)]), ['Subtotal', '', '', money(inv.sub)], ['Tax (8.05%)', '', '', money(inv.tax)], ['Total Due', '', '', money(inv.total)]]),
    P('Please make checks payable to ' + biz.name + '.')];
  const d = docx({ body, header: [[{ t: `${biz.name}  |  ${biz.lic}  |  Phone ${biz.phone}`, b: true }]], footer: [[`Payment terms: Net 15. Late balances accrue 1.5% per month. Questions? Call ${biz.phone}.`]] });
  const chars = body.join('').replace(/<[^>]+>/g, '').length;
  const e = add(name, zip(d.entries), { structure: { pagesRange: docPages(chars + 200), docx: true }, keys: [inv.no, inv.cust.name, inv.cust.phone, inv.tech, ...inv.lines.map((l) => l.desc), money(inv.total), biz.lic] });
  const w = (kind, extra = {}) => ({ page: 1, kind, ...extra });
  q(e, `What is the total due on invoice ${inv.no}?`, [moneyVariants(inv.total)], w('table'), { hard: ['table', 'currency'], same: [inv.no] });
  q(e, `What is the phone number of customer ${inv.cust.name} on invoice ${inv.no}?`, [[inv.cust.phone, inv.cust.phone.replace('(', '').replace(') ', '-')]], w('body'), { same: [inv.cust.name] });
  q(e, `Who is the technician on invoice ${inv.no}?`, [inv.tech], w('body'), { same: [inv.no] });
  q(e, `When is invoice ${inv.no} due?`, [dateVariants(inv.due).concat([longDate(inv.due)])], w('body'), { same: [inv.no] });
  q(e, `What is the unit price of the ${inv.lines[1].desc} on invoice ${inv.no}?`, [moneyVariants(inv.lines[1].unit)], w('table'), { hard: ['table'], same: [inv.lines[1].desc] });
  q(e, `What is ${biz.name}'s contractor license number?`, [biz.lic], w('header'), { hard: ['header'] });
  q(e, `What are the payment terms and late fee on the ${biz.name} invoice ${inv.no}?`, ['Net 15', '1.5%'], w('footer'), { hard: ['footer', 'percent'] });
  return inv;
}
const invs = [
  addInvoiceDocx('invoice-saguaro-INV-20418.docx', invoiceData(BIZ.hvac, 'INV-20418', UNIQ[0], 0, '2026-03-14', 101)),
  addInvoiceDocx('invoice-ironwood-INV-5531.docx', invoiceData(BIZ.plumb, 'INV-5531', UNIQ[3], 1, '2026-02-27', 102)),
  addInvoiceDocx('invoice-paloverde-2026-0207.docx', invoiceData(BIZ.elec, 'PV-2026-0207', UNIQ[7], 2, '2026-04-02', 103)),
  addInvoiceDocx('invoice-mesquite-M-1180.docx', invoiceData(BIZ.prop, 'M-1180', UNIQ[11], 3, '2026-01-30', 104)),
  addInvoiceDocx('invoice-saguaro-INV-20977.docx', invoiceData(BIZ.hvac, 'INV-20977', UNIQ[15], 4, '2026-05-09', 105)),
];

/* ============================================================== 2. INVOICES (xlsx) */
function addInvoiceXlsx(name, inv) {
  const { biz } = inv;
  const L = inv.lines;
  const rows = [
    [{ v: biz.name, fmt: 'bold' }], [{ v: 'INVOICE', fmt: 'bold' }], [], ['Invoice No', inv.no], ['Date', { v: inv.date, fmt: 'date' }], ['Bill To', inv.cust.name], ['Phone', inv.cust.phone],
    ['Address', `${inv.cust.addr}, ${inv.cust.city}, AZ ${inv.cust.zip}`], ['Technician', inv.tech], [],
    [{ v: 'Description', fmt: 'bold' }, { v: 'Qty', fmt: 'bold' }, { v: 'Unit Price', fmt: 'bold' }, { v: 'Amount', fmt: 'bold' }],
    ...L.map((l, i) => [l.desc, l.qty, { v: l.unit, fmt: 'cur' }, { v: l.amt, fmt: 'cur', f: `B${12 + i}*C${12 + i}` }]),
    ['Subtotal', null, null, { v: inv.sub, fmt: 'cur', f: `SUM(D12:D${11 + L.length})` }],
    ['Tax rate', null, null, { v: inv.rate, fmt: 'pct' }],
    ['Tax', null, null, { v: inv.tax, fmt: 'cur', f: `D${12 + L.length}*D${13 + L.length}` }],
    ['Total Due', null, null, { v: inv.total, fmt: 'cur', f: `D${12 + L.length}+D${14 + L.length}` }],
  ];
  const sheets = [sheetOf('Invoice', rows, { cols: [34, 8, 12, 14] })];
  const e = add(name, zip(xlsx(sheets)), { structure: { sheets: [sheetMeta('Invoice', rows)], pagesRange: [1, 2] }, keys: [inv.no, inv.cust.name, inv.cust.phone, inv.tech, ...L.map((l) => l.desc), moneyVariants(inv.total), dateVariants(inv.date)] , mustNotAnywhere: ['SUM(', `B12*C12`] });
  const tr = 12 + L.length + 3;
  q(e, `What is the total due on invoice ${inv.no}?`, [moneyVariants(inv.total)], { sheet: 'Invoice', row: tr, kind: 'formula' }, { hard: ['formula', 'currency'], mustNot: ['SUM(', 'D12+D'], same: [inv.no] });
  q(e, `What is the date of invoice ${inv.no}?`, [dateVariants(inv.date)], { sheet: 'Invoice', row: 5 }, { hard: ['serial-date'], mustNot: [String(Math.round((Date.UTC(+inv.date.slice(0, 4), +inv.date.slice(5, 7) - 1, +inv.date.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000))], same: [inv.no] });
  q(e, `What tax rate was charged on invoice ${inv.no}?`, [['8.05%', '0.0805']], { sheet: 'Invoice', row: tr - 2 }, { hard: ['percent'], same: [inv.no] });
  q(e, `What is the phone number for ${inv.cust.name} on invoice ${inv.no}?`, [inv.cust.phone], { sheet: 'Invoice', row: 7 }, { same: [inv.cust.name] });
  q(e, `Which technician worked invoice ${inv.no}?`, [inv.tech], { sheet: 'Invoice', row: 9 }, { same: [inv.no] });
  q(e, `What is the subtotal before tax on invoice ${inv.no}?`, [moneyVariants(inv.sub)], { sheet: 'Invoice', row: tr - 3, kind: 'formula' }, { hard: ['formula'], mustNot: ['SUM(D12'], same: [inv.no] });
}
addInvoiceXlsx('invoice-saguaro-INV-20431.xlsx', invoiceData(BIZ.hvac, 'INV-20431', UNIQ[1], 0, '2026-03-20', 111));
addInvoiceXlsx('invoice-ironwood-INV-5540.xlsx', invoiceData(BIZ.plumb, 'INV-5540', UNIQ[4], 3, '2026-03-02', 112));
addInvoiceXlsx('invoice-paloverde-PV-2026-0215.xlsx', invoiceData(BIZ.elec, 'PV-2026-0215', UNIQ[8], 4, '2026-04-11', 113));
{ // multi-sheet batch workbook: invoice list + line items + notes
  const r = rng(120); const list = [];
  for (let i = 0; i < 14; i++) { const c = UNIQ[10 + (i % 16)]; list.push({ no: `INV-${30100 + i}`, date: addDays('2026-04-01', i * 2), cust: c, amt: r.int(15000, 260000) / 100, status: r.pick(['Paid', 'Paid', 'Open', 'Open', 'Void']) }); }
  const inv = [[{ v: 'Invoice No', fmt: 'bold' }, { v: 'Date', fmt: 'bold' }, { v: 'Customer', fmt: 'bold' }, { v: 'Amount', fmt: 'bold' }, { v: 'Status', fmt: 'bold' }], ...list.map((x) => [x.no, { v: x.date, fmt: 'date' }, x.cust.name, { v: x.amt, fmt: 'cur' }, x.status])];
  const li = [[{ v: 'Invoice No', fmt: 'bold' }, { v: 'Line', fmt: 'bold' }, { v: 'Description', fmt: 'bold' }, { v: 'Amount', fmt: 'bold' }], ...list.slice(0, 6).flatMap((x, i) => [[x.no, 1, 'Labor', { v: Math.round(x.amt * 0.4 * 100) / 100, fmt: 'cur' }], [x.no, 2, `${BRANDS[i % 5]} ${PARTS[i]}`, { v: Math.round((x.amt - Math.round(x.amt * 0.4 * 100) / 100) * 100) / 100, fmt: 'cur' }]])];
  const notes = [['Batch notes'], ['Prepared by the front office for Palo Verde Electric, April 2026 billing run.'], ['Warranty callbacks are billed at zero and marked Void.']];
  const sheets = [sheetOf('Invoices', inv), sheetOf('Line Items', li), sheetOf('Notes', notes)];
  const e = add('invoice-batch-paloverde-April.xlsx', zip(xlsx(sheets)), { structure: { sheets: [sheetMeta('Invoices', inv), sheetMeta('Line Items', li), sheetMeta('Notes', notes)], pagesRange: [3, 6] }, keys: [...list.map((x) => x.no), ...list.map((x) => x.cust.name), 'Warranty callbacks are billed at zero'] });
  const x3 = list[3]; const x9 = list[9]; const x0 = list[0];
  q(e, `What was invoice ${x3.no} for ${x3.cust.name}?`, [moneyVariants(x3.amt)], SHEET('Invoices', 5), { hard: ['currency'], same: [x3.no] });
  q(e, `What is the status of invoice ${x9.no}?`, [x9.status], SHEET('Invoices', 11), { same: [x9.no] });
  q(e, `What date was invoice ${x0.no} issued?`, [dateVariants(x0.date)], SHEET('Invoices', 2), { hard: ['serial-date'], same: [x0.no] });
  q(e, `How is a warranty callback billed according to the notes?`, ['billed at zero'], SHEET('Notes', 3), { same: ['Void'] });
  q(e, `What was the labor line amount on invoice ${list[2].no}?`, [moneyVariants(Math.round(list[2].amt * 0.4 * 100) / 100)], SHEET('Line Items', 6), { same: [list[2].no, 'Labor'] });
}

/* ============================================================== 3. WORK ORDERS */
function addWorkOrderDocx(name, wo, seed) {
  const r = rng(seed); const parts = Array.from({ length: 3 }, () => [`${r.pick(BRANDS)} ${r.pick(PARTS)}`, String(r.int(1, 3))]);
  const serial = `${r.int(1, 9)}N${r.int(1000, 9999)}-${r.int(10000, 99999)}`;
  const body = [P('WORK ORDER', { style: 'Title' }), P(`Work Order No: ${wo.no}`), P(`Scheduled: ${longDate(wo.date)}`), P(`Customer: ${wo.cust.name}`), P(`Service Address: ${wo.cust.addr}, ${wo.cust.city}, AZ ${wo.cust.zip}`), P(`Contact Phone: ${wo.cust.phone}`),
    P(`Assigned Technician: ${wo.tech}`), P(`Equipment: ${wo.equip}  Serial: ${serial}`), P('Reported Problem', { style: 'Heading2' }), P(wo.problem), P('Work Performed', { style: 'Heading2' }), P(wo.work),
    TBL([['Part Used', 'Qty'], ...parts]), P(`Priority: ${wo.priority}`)];
  const d = docx({ body, header: [[`${wo.biz.name} - Dispatch Copy`]], footer: [[`Technician signature on file for ${wo.tech}. License ${wo.biz.lic}.`]] });
  const e = add(name, zip(d.entries), { structure: { pagesRange: [1, 3], docx: true }, keys: [wo.no, wo.cust.name, wo.cust.phone, wo.tech, wo.equip, serial, wo.problem, ...parts.map((p) => p[0])] });
  q(e, `Who is the technician on work order ${wo.no}?`, [wo.tech], { page: 1, kind: 'body' }, { same: [wo.no] });
  q(e, `What is the phone number of the customer on work order ${wo.no}?`, [wo.cust.phone], { page: 1, kind: 'body' }, { same: [wo.cust.name] });
  q(e, `What equipment serial number is on work order ${wo.no}?`, [serial], { page: 1, kind: 'body' }, { same: [wo.equip] });
  q(e, `What was the reported problem on work order ${wo.no}?`, [wo.problem], { page: 1, kind: 'body' }, { same: [wo.no] });
  q(e, `What part was used first on work order ${wo.no}?`, [parts[0][0]], { page: 1, kind: 'table' }, { hard: ['table'], same: [parts[0][1]] });
  q(e, `Which technician signed work order ${wo.no}, and what licence is on it?`, [wo.tech, wo.biz.lic], { page: 1, kind: 'footer' }, { hard: ['footer'] });
}
addWorkOrderDocx('workorder-WO-3307.docx', { biz: BIZ.hvac, no: 'WO-3307', date: '2026-03-05', cust: UNIQ[2], tech: 'Dale Whitfield', equip: 'Carrier 24ACC636A003', problem: 'Condenser fan not spinning, unit tripping on high pressure.', work: 'Replaced run capacitor, cleaned condenser coil, verified amp draw within nameplate.', priority: 'High' }, 201);
addWorkOrderDocx('workorder-WO-3312.docx', { biz: BIZ.plumb, no: 'WO-3312', date: '2026-03-09', cust: UNIQ[5], tech: 'Sofia Brandt', equip: 'Rheem Performance Plus 50 gal water heater', problem: 'Water heater leaking at the temperature and pressure relief valve.', work: 'Replaced PRV valve and expansion tank, flushed tank sediment.', priority: 'Urgent' }, 202);
addWorkOrderDocx('workorder-WO-3320.docx', { biz: BIZ.elec, no: 'WO-3320', date: '2026-03-12', cust: UNIQ[9], tech: 'Terrance Oyelaran', equip: 'Square D QO 200A service panel', problem: 'Breaker 30A keeps tripping when the dryer starts.', work: 'Replaced breaker, tightened lugs, load tested the dryer circuit.', priority: 'Normal' }, 203);
{ // work orders xlsx (300 rows, status counts)
  const r = rng(210); const H = ['WO No', 'Opened', 'Customer', 'Site City', 'Technician', 'Status', 'Priority', 'Est Hours'];
  const data = Array.from({ length: 300 }, (_, i) => { const c = CUST[i % 90]; return { no: `WO-${4000 + i}`, opened: addDays('2026-01-05', Math.floor(i / 2)), cust: c.name, city: c.city, tech: TECHS[r.int(0, 4)], status: r.pick(['Open', 'Closed', 'Closed', 'In Progress']), pri: r.pick(['Normal', 'High', 'Urgent']), hrs: r.int(1, 16) / 2 }; });
  const rows = [H.map((h) => ({ v: h, fmt: 'bold' })), ...data.map((d) => [d.no, { v: d.opened, fmt: 'date' }, d.cust, d.city, d.tech, d.status, d.pri, d.hrs])];
  const e = add('workorders-open-closed-2026.xlsx', zip(xlsx([sheetOf('Work Orders', rows)])), { structure: { sheets: [sheetMeta('Work Orders', rows)], pagesRange: sheetPages([{ rows }]), headerRepeated: ['WO No', 'Technician'] }, keys: sampleKeys(data.map((d) => d.no), 40) });
  const d150 = data[150]; const d287 = data[287]; const open = data.filter((d) => d.status === 'Open');
  q(e, `Who is the technician on work order ${d150.no}?`, [d150.tech], SHEET('Work Orders', 152), { same: [d150.no] });
  q(e, `What is the status of work order ${d287.no}?`, [d287.status], SHEET('Work Orders', 289), { same: [d287.no] });
  q(e, `What date was work order ${data[40].no} opened?`, [dateVariants(data[40].opened)], SHEET('Work Orders', 42), { hard: ['serial-date'], same: [data[40].no] });
  q(e, `How many hours were estimated for work order ${data[222].no}?`, [[String(data[222].hrs), data[222].hrs.toFixed(1)]], SHEET('Work Orders', 224), { same: [data[222].no] });
  q(e, 'How many work orders have status Open?', [], { sheet: 'Work Orders' }, { kind: 'aggregate', expectedCount: open.length, allOf: sampleKeys(open.map((d) => d.no), 25) });
  q(e, `What city is work order ${data[299].no} in?`, [data[299].city], SHEET('Work Orders', 301), { hard: ['far-row'], same: [data[299].no] });
}

/* ============================================================== 4. PRICE LISTS */
{
  const r = rng(300); const H = ['Part No', 'Description', 'Brand', 'Unit', 'List Price', 'Contractor Price', 'Updated', 'Taxable'];
  const items = Array.from({ length: 2500 }, (_, i) => { const list = r.int(500, 189900) / 100; return { no: `HV-${String(10000 + i * 7).padStart(5, '0')}`, desc: `${PARTS[i % PARTS.length]} model ${r.int(100, 999)}${String.fromCharCode(65 + (i % 26))}`, brand: BRANDS[i % BRANDS.length], unit: r.pick(['ea', 'ea', 'ft', 'box']), list, cp: Math.round(list * 0.82 * 100) / 100, upd: addDays('2026-04-01', i % 20), tax: r.pick(['Y', 'N']) }; });
  const main = [H.map((h) => ({ v: h, fmt: 'bold' })), ...items.map((x) => [x.no, x.desc, x.brand, x.unit, { v: x.list, fmt: 'cur' }, { v: x.cp, fmt: 'cur' }, { v: x.upd, fmt: 'date' }, x.tax])];
  const labor = [[{ v: 'Service', fmt: 'bold' }, { v: 'Rate', fmt: 'bold' }, { v: 'Unit', fmt: 'bold' }], ['Service call / diagnostic', { v: 89, fmt: 'cur' }, 'flat'], ['Hourly labor, technician', { v: 125, fmt: 'cur' }, 'hour'], ['After-hours multiplier', { v: 1.5, fmt: 'general' }, 'x'], ['Refrigerant recovery fee', { v: 35, fmt: 'cur' }, 'flat'], ['Contractor discount over $500', { v: 0.15, fmt: 'pct0' }, 'order']];
  const readme = [['Saguaro Air & Heating wholesale price list'], ['Prices effective April 1, 2026 and supersede the January list.'], ['Restocking fee on returned parts is 20 percent.']];
  const sheets = [sheetOf('HVAC Parts', main), sheetOf('Labor Rates', labor), sheetOf('Read Me', readme)];
  const e = add('pricelist-hvac-2026.xlsx', zip(xlsx(sheets)), { structure: { sheets: [sheetMeta('HVAC Parts', main), sheetMeta('Labor Rates', labor), sheetMeta('Read Me', readme)], pagesRange: sheetPages(sheets), headerRepeated: ['Part No', 'Contractor Price'], minPages: 20 }, keys: [...sampleKeys(items.map((x) => x.no), 60), 'Hourly labor, technician', 'Restocking fee'] });
  const pick = [items[1800], items[40], items[2499], items[1203]];
  pick.forEach((x, k) => q(e, `What is the contractor price of part ${x.no}?`, [moneyVariants(x.cp)], SHEET('HVAC Parts', [1802, 42, 2501, 1205][k]), { hard: ['currency', k === 0 || k === 2 ? 'far-row' : 'table'], same: [x.no] }));
  q(e, `What is the list price and brand of part ${items[777].no}?`, [moneyVariants(items[777].list), items[777].brand], SHEET('HVAC Parts', 779), { same: [items[777].no] });
  q(e, 'What is our hourly labor rate for a technician?', [moneyVariants(125)], SHEET('Labor Rates', 3), { same: ['Hourly labor'] });
  q(e, 'What contractor discount applies to orders over $500?', [['15%', '0.15']], SHEET('Labor Rates', 6), { hard: ['percent'], same: ['Contractor discount'] });
  q(e, 'When do the new prices take effect?', [['April 1, 2026']], SHEET('Read Me', 2), { global: false });
}
{
  const r = rng(310); const H = ['SKU', 'Item', 'Size', 'Price', 'In Stock'];
  const items = Array.from({ length: 1200 }, (_, i) => ({ sku: `PL-${20000 + i * 3}`, item: `${PARTS[24 + (i % 12)]} ${r.pick(['1/2 in', '3/4 in', '1 in', '2 in'])}`, size: r.pick(['1/2', '3/4', '1']), price: r.int(300, 99900) / 100, stock: r.int(0, 80) }));
  const rows = [H.map((h) => ({ v: h, fmt: 'bold' })), ...items.map((x) => [x.sku, x.item, x.size, { v: x.price, fmt: 'cur' }, x.stock])];
  const e = add('pricelist-plumbing-2026.xlsx', zip(xlsx([sheetOf('Plumbing', rows)])), { structure: { sheets: [sheetMeta('Plumbing', rows)], pagesRange: sheetPages([{ rows }]), headerRepeated: ['SKU', 'Price'], minPages: 6 }, keys: sampleKeys(items.map((x) => x.sku), 40) });
  [[items[600], 602], [items[1199], 1201], [items[5], 7]].forEach(([x, row]) => q(e, `What is the price of SKU ${x.sku}?`, [moneyVariants(x.price)], SHEET('Plumbing', row), { hard: ['currency'], same: [x.sku] }));
  q(e, `How many are in stock of SKU ${items[900].sku}?`, [String(items[900].stock)], SHEET('Plumbing', 902), { same: [items[900].sku] });
  q(e, `What item is SKU ${items[300].sku}?`, [items[300].item], SHEET('Plumbing', 302), { same: [items[300].sku] });
}
{
  const r = rng(320); const H = 'Item Code,Description,Unit,Price,Supplier';
  const items = Array.from({ length: 800 }, (_, i) => ({ code: `EL-${30000 + i * 5}`, desc: `${PARTS[28 + (i % 8)]}, ${r.pick(['white', 'ivory', 'commercial grade', 'weatherproof'])}`, unit: r.pick(['ea', 'roll', 'box']), price: r.int(150, 74900) / 100, sup: r.pick(['Canyon Supply', 'Verde Wholesale', 'Sonoran Electrical Depot']) }));
  const csv = [H, ...items.map((x) => `${x.code},"${x.desc}",${x.unit},${x.price.toFixed(2)},${x.sup}`)].join('\r\n') + '\r\n';
  const e = add('pricelist-electrical.csv', Buffer.from(csv, 'utf8'), { structure: { csv: true, pagesRange: [Math.floor(csv.length / 6000 * 0.5), Math.ceil(csv.length / 6000 * 2) + 1], headerRepeated: ['Item Code', 'Supplier'] }, keys: sampleKeys(items.map((x) => x.code), 30) });
  [[items[400], 402], [items[799], 801], [items[10], 12]].forEach(([x, row]) => q(e, `What is the price of item ${x.code}?`, [[x.price.toFixed(2), '$' + x.price.toFixed(2)]], { row, kind: 'csv-row' }, { same: [x.code] }));
  q(e, `Which supplier sells item ${items[123].code}?`, [items[123].sup], { row: 125 }, { same: [items[123].code] });
  q(e, `What is the description of item ${items[650].code}?`, [items[650].desc], { row: 652, hard: ['quoted-comma'] }, { same: [items[650].code] });
}

/* ============================================================== 5. CUSTOMER LISTS */
{
  const H = ['Customer ID', 'Name', 'Phone', 'Address', 'City', 'Zip', 'Customer Since', 'Plan'];
  const rows = [H.map((h) => ({ v: h, fmt: 'bold' })), ...CUST.map((c) => [c.id, c.name, c.phone, c.addr, c.city, c.zip, { v: c.since, fmt: 'iso' }, c.plan])];
  const e = add('customers-clean.xlsx', zip(xlsx([sheetOf('Customers', rows)])), { structure: { sheets: [sheetMeta('Customers', rows)], pagesRange: sheetPages([{ rows }]) }, keys: CUST.map((c) => c.name).concat(CUST.map((c) => c.phone)) });
  [UNIQ[2], UNIQ[17], UNIQ[29]].forEach((c) => q(e, `What is the phone number of customer ${c.name}?`, [c.phone], SHEET('Customers', CUST.indexOf(c) + 2), { same: [c.name] }));
  q(e, `What address is on file for ${UNIQ[6].name}?`, [UNIQ[6].addr], SHEET('Customers', CUST.indexOf(UNIQ[6]) + 2), { same: [UNIQ[6].name] });
  q(e, `When did ${UNIQ[12].name} become a customer?`, [dateVariants(UNIQ[12].since)], SHEET('Customers', CUST.indexOf(UNIQ[12]) + 2), { hard: ['serial-date'], same: [UNIQ[12].name] });
  q(e, `What service plan is ${UNIQ[20].name} on?`, [UNIQ[20].plan], SHEET('Customers', CUST.indexOf(UNIQ[20]) + 2), { same: [UNIQ[20].name] });
}
{
  const H = 'Customer ID,Name,Phone,Address,City,Zip,Customer Since,Plan';
  const lines = CUST.map((c, i) => `${c.id},"${c.name}",${c.phone},"${c.addr}${i % 7 === 0 ? ', Unit ' + (i + 3) : ''}",${c.city},${c.zip},${mdy(c.since)},${c.plan}`);
  const csv = [H, ...lines].join('\n') + '\n';
  const e = add('customers.csv', Buffer.from(csv, 'utf8'), { structure: { csv: true, pagesRange: [1, 4] }, keys: CUST.map((c) => c.name).concat(CUST.map((c) => c.phone)) });
  [UNIQ[1], UNIQ[14], UNIQ[25]].forEach((c) => q(e, `What is the phone number of customer ${c.name}?`, [c.phone], { row: CUST.indexOf(c) + 2 }, { same: [c.name] }));
  q(e, `What city does ${UNIQ[9].name} live in?`, [UNIQ[9].city], { row: CUST.indexOf(UNIQ[9]) + 2 }, { same: [UNIQ[9].name] });
  q(e, `Which customers ID belongs to ${UNIQ[22].name}?`, [UNIQ[22].id], { row: CUST.indexOf(UNIQ[22]) + 2 }, { same: [UNIQ[22].name] });
}
{
  const H = ['Customer ID', 'Name', 'Phone', 'City', 'Plan'];
  const tsv = [H, ...CUST.slice(0, 60).map((c) => [c.id, c.name, c.phone, c.city, c.plan])].map((r) => r.join('\t')).join('\n') + '\n';
  const e = add('customers.tsv', Buffer.from(tsv, 'utf8'), { structure: { csv: true, pagesRange: [1, 3] }, keys: CUST.slice(0, 60).map((c) => c.name) });
  [UNIQ[0], UNIQ[10], UNIQ[28]].forEach((c) => q(e, `What is the phone number of ${c.name}?`, [c.phone], { row: CUST.indexOf(c) + 2 }, { same: [c.name] }));
  q(e, `What plan is ${UNIQ[5].name} on?`, [UNIQ[5].plan], { row: CUST.indexOf(UNIQ[5]) + 2 }, { same: [UNIQ[5].name] });
  q(e, `What is the customer ID of ${UNIQ[16].name}?`, [UNIQ[16].id], { row: CUST.indexOf(UNIQ[16]) + 2 }, { same: [UNIQ[16].name] });
}
{ // messy: title block, blank rows, notes in odd cells, mixed dates, text-stored numbers
  const r = rng(330); const cs = UNIQ.slice(0, 20);
  const rows = [[{ v: 'Mesquite Property Services', fmt: 'bold' }], ['Tenant & Owner Contacts - working copy'], ['Prepared by: front office   (DO NOT SEND)'], [], [],
    ['Name', 'Phone', 'Unit', 'Move-in', 'Deposit', 'Notes']];
  const meta = [];
  cs.forEach((c, i) => {
    if (i === 6 || i === 13) rows.push([]);
    const dt = addDays('2025-06-01', i * 9);
    const moveIn = i % 3 === 0 ? { v: dt, fmt: 'date' } : i % 3 === 1 ? { v: `${mdy(dt).slice(0, 6)}${mdy(dt).slice(8)}`, fmt: 'text' } : `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+dt.slice(5, 7) - 1]} ${+dt.slice(8)} ${dt.slice(0, 4)}`;
    const dep = r.int(5, 30) * 50; const depCell = i % 2 === 0 ? { v: dep, fmt: 'cur' } : { v: dep.toFixed(2), fmt: 'text' };
    const unit = i % 4 === 0 ? { v: String(100 + i).padStart(4, '0'), fmt: 'text' } : String(100 + i);
    const row = [c.name, c.phone, unit, moveIn, depCell, i === 9 ? null : null];
    if (i === 4) row[9] = 'check with Dale re: gate code before calling';
    rows.push(row); meta.push({ c, dt, dep, moveIn, unit, rowNo: rows.length });
  });
  rows.push([]); rows.push(['TOTAL deposits', null, null, null, { v: meta.reduce((a, m) => a + m.dep, 0), fmt: 'cur', f: 'SUM(E7:E40)' }]);
  const m4 = meta[4]; const m7 = meta[7]; const m10 = meta[10]; const m1 = meta[1]; const m3 = meta[3];
  const e = add('customers-messy-contacts.xlsx', zip(xlsx([sheetOf('Sheet1', rows)])), { structure: { sheets: [sheetMeta('Sheet1', rows)], pagesRange: [1, 3] }, keys: cs.map((c) => c.name).concat(cs.map((c) => c.phone)) });
  q(e, `What is the phone number of ${m7.c.name}?`, [m7.c.phone], SHEET('Sheet1', m7.rowNo), { hard: ['messy', 'title-block'], same: [m7.c.name] });
  q(e, `What does the note say about ${m4.c.name}?`, ['gate code'], SHEET('Sheet1', m4.rowNo, { col: 'J' }), { hard: ['messy', 'odd-cell'], same: [m4.c.name] });
  q(e, `What was the deposit for ${m3.c.name}?`, [moneyVariants(m3.dep)], SHEET('Sheet1', m3.rowNo), { hard: ['text-number', 'messy'], same: [m3.c.name] });
  q(e, `What was the deposit for ${m10.c.name}?`, [moneyVariants(m10.dep)], SHEET('Sheet1', m10.rowNo), { hard: ['currency', 'messy'], same: [m10.c.name] });
  q(e, `When did ${m1.c.name} move in?`, [[mdy(m1.dt).slice(0, 6) + mdy(m1.dt).slice(8), mdy(m1.dt), m1.dt]], SHEET('Sheet1', m1.rowNo), { hard: ['mixed-dates', 'messy'], same: [m1.c.name] });
  q(e, `What was the unit number for ${meta[8].c.name}?`, [meta[8].unit.v ?? meta[8].unit], SHEET('Sheet1', meta[8].rowNo), { hard: ['text-number'], same: [meta[8].c.name] });
}

/* ============================================================== 6. CONTRACTS */
function contractParts(redline) {
  const term = redline ? [{ t: 'Either party may terminate this Agreement upon ' }, { t: 'thirty (30)', del: true, id: 11 }, { t: 'sixty (60)', ins: true, id: 12 }, { t: ' days written notice to the other party.' }] : [{ t: 'Either party may terminate this Agreement upon thirty (30) days written notice to the other party.' }];
  const cl = [
    ['Scope of Service', ['Contractor will perform two preventive maintenance visits per year on the covered equipment listed in Schedule A.']],
    ['Term and Termination', [term, 'This Agreement renews automatically for successive one-year terms unless cancelled.']],
    ['Payment', ['Annual fees are invoiced in advance and are due within fifteen (15) days of the invoice date.', 'Balances unpaid after the due date accrue a late fee of 1.5% per month.']],
    ['Response Time', [redline ? [{ t: 'Contractor will respond to emergency calls within ' }, { t: '24 hours', del: true, id: 13 }, { t: '4 hours', ins: true, id: 14 }, { t: '.' }] : 'Contractor will respond to emergency calls within 24 hours of the request.']],
    ['Limitation', redline ? [[{ t: 'Customer waives all warranty claims arising from deferred maintenance.', del: true, id: 15 }], 'Liability is limited to the fees paid in the prior twelve months.'] : ['Liability is limited to the fees paid in the prior twelve months.']],
    ['Governing Law', ['This Agreement is governed by the laws of the State of Arizona. Venue lies in Maricopa County.']],
  ];
  return cl;
}
function addContract(name, redline) {
  const no = redline ? 'MA-2026-0452' : 'MA-2026-0417'; const cust = redline ? UNIQ[13] : UNIQ[4];
  const body = [P('Preventive Maintenance Agreement', { style: 'Title' }), P(`Agreement No. ${no} between ${BIZ.hvac.name} ("Contractor") and ${cust.name} ("Customer"), effective ${longDate(redline ? '2026-02-01' : '2026-01-15')}.`)];
  let n = 1;
  for (const [title, items] of contractParts(redline)) {
    body.push(P(`Section ${n}. ${title}`, { style: 'Heading1' })); n++;
    for (const it of items) body.push(P(it, { num: true }));
  }
  body.push(P('Schedule A: Covered Equipment and Annual Fees', { style: 'Heading1' }));
  body.push(TBL([['Plan', 'Visits per Year', 'Annual Fee'], ['Silver', '1', '$189.00'], ['Gold', '2', '$329.00'], ['Platinum', '4', '$589.00']]));
  body.push(P('Contractor signature: ____________   Customer signature: ____________'));
  const d = docx({ body, header: [[`Maintenance Agreement No. ${no}`]], footer: [['Confidential - Saguaro Air & Heating - Prepared for customer review']] });
  const text = body.join('').replace(/<w:delText[^>]*>[^<]*<\/w:delText>/g, '').replace(/<[^>]+>/g, '');
  const e = add(name, zip(d.entries), { structure: { pagesRange: docPages(text.length + 200), docx: true, trackedChanges: redline }, keys: [no, cust.name, 'Governing Law', 'State of Arizona', '$329.00'] });
  const termAns = redline ? 'sixty (60)' : 'thirty (30)';
  q(e, 'What is the termination notice period in the contract?', [termAns, 'days written notice'], { page: 1, kind: 'body' }, { same: ['terminate'], mustNot: redline ? ['thirty (30)'] : [], hard: redline ? ['tracked-change'] : [] });
  q(e, 'What is the late fee on unpaid balances?', ['1.5%'], { page: 1, kind: 'body' }, { hard: ['percent'] });
  q(e, 'What is the annual fee for the Gold plan?', ['$329.00'], { page: 1, kind: 'table' }, { hard: ['table', 'currency'], same: ['Gold'] });
  q(e, 'Which state law governs the agreement?', ['State of Arizona', 'Maricopa County'], { page: 1, kind: 'body' }, {});
  q(e, 'What is the agreement number?', [no], { page: 1, kind: 'header' }, { hard: ['header'] });
  q(e, 'How quickly will the contractor respond to emergency calls?', [redline ? '4 hours' : '24 hours'], { page: 1, kind: 'body' }, { mustNot: redline ? ['24 hours'] : [], hard: redline ? ['tracked-change'] : [] });
  if (redline) { q(e, 'Does the customer waive warranty claims arising from deferred maintenance?', ['Liability is limited'], { page: 1, kind: 'body' }, { mustNot: ['waives all warranty claims'], hard: ['tracked-change'] }); e.mustNotAnywhere = ['thirty (30)', 'waives all warranty claims']; }
}
addContract('contract-maintenance-agreement.docx', false);
addContract('contract-maintenance-redline.docx', true);

/* ============================================================== 7. JOB LOG (multi-sheet, hidden, merged, formulas) */
{
  const r = rng(400);
  const H = ['Job No', 'Date', 'Customer', 'Tech', 'Labor', 'Parts', 'Total', 'Status'];
  const groups = [['Residential - Mesa', 5], ['Commercial - Chandler', 4], ['Residential - Gilbert', 5]];
  const rows = [[{ v: 'Saguaro Air & Heating - Job Log 2026', fmt: 'bold' }], [], H.map((h) => ({ v: h, fmt: 'bold' }))];
  const merges = ['A1:H1']; const jobs = []; let jn = 2201; let ci = 0; const sumRows = [];
  for (const [label, n] of groups) {
    rows.push([{ v: label, fmt: 'bold' }]); merges.push(`A${rows.length}:H${rows.length}`);
    for (let k = 0; k < n; k++) {
      const labor = r.int(8900, 62500) / 100; const parts = r.int(0, 48000) / 100; const total = Math.round((labor + parts) * 100) / 100;
      const j = { no: `J-${jn++}`, date: addDays('2026-03-02', ci * 3), cust: UNIQ[ci % 30], tech: TECHS[ci % 5], labor, parts, total, status: r.pick(['Complete', 'Complete', 'Scheduled']), group: label };
      rows.push([j.no, { v: j.date, fmt: 'date' }, j.cust.name, j.tech, { v: labor, fmt: 'cur' }, { v: parts, fmt: 'cur' }, { v: total, fmt: 'cur', f: `E${rows.length + 1}+F${rows.length + 1}` }, j.status]);
      j.row = rows.length; jobs.push(j); ci++;
    }
  }
  const last = rows.length; const grand = Math.round(jobs.reduce((a, j) => a + j.total, 0) * 100) / 100;
  rows.push(['Grand Total', null, null, null, null, null, { v: grand, fmt: 'cur', f: `SUM(G4:G${last})` }]);
  const summary = [[{ v: 'Summary', fmt: 'bold' }], ['Jobs logged', { v: jobs.length, fmt: 'general', f: `COUNTA(Jobs!A4:A${last})` }], ['Gross margin target', { v: 0.38, fmt: 'pct0' }], ['Total billed', { v: grand, fmt: 'cur', f: `Jobs!G${last + 1}` }], ['Margin goal status', { v: 'On track', fmt: 'general', f: 'IF(B3>0.3,"On track","Review")' }]];
  const hidden = [[{ v: 'Internal cost rates - do not share', fmt: 'bold' }], ['Technician', 'Cost per hour'], ...TECHS.map((t, i) => [t, { v: 38 + i * 2.5, fmt: 'cur' }])];
  const sheets = [sheetOf('Jobs', rows, { merges }), sheetOf('Summary', summary), sheetOf('Rates (internal)', hidden, { state: 'hidden' })];
  const e = add('joblog-2026.xlsx', zip(xlsx(sheets)), { structure: { sheets: [sheetMeta('Jobs', rows), sheetMeta('Summary', summary), sheetMeta('Rates (internal)', hidden, 'hidden')], pagesRange: [3, 6] }, keys: [...jobs.map((j) => j.no), 'Residential - Mesa', 'Commercial - Chandler', 'Gross margin target'], mustNotAnywhere: ['SUM(', 'COUNTA(', 'IF(B3'] });
  const jc = jobs.find((j) => j.group.startsWith('Commercial')); const j7 = jobs[7]; const j2 = jobs[2];
  q(e, `What was the total for job ${j7.no}?`, [moneyVariants(j7.total)], SHEET('Jobs', j7.row, { kind: 'formula' }), { hard: ['formula', 'currency'], mustNot: ['E' + j7.row + '+F'], same: [j7.no] });
  q(e, `Which group is job ${jc.no} in?`, ['Commercial - Chandler'], SHEET('Jobs', jc.row), { hard: ['merged-label'], same: [jc.no] });
  q(e, `What date was job ${j2.no} done?`, [dateVariants(j2.date)], SHEET('Jobs', j2.row), { hard: ['serial-date'], same: [j2.no] });
  q(e, 'What is the gross margin target?', [['38%', '0.38']], SHEET('Summary', 3), { hard: ['percent'], same: ['Gross margin'] });
  q(e, 'What is the grand total billed for the year to date?', [moneyVariants(grand)], SHEET('Jobs', last + 1, { kind: 'formula' }), { hard: ['formula'], mustNot: [`SUM(G4:G${last})`] });
  q(e, `What is the internal cost per hour for ${TECHS[2]}?`, [moneyVariants(43)], SHEET('Rates (internal)', 5), { hard: ['hidden-sheet'], markedHidden: true, same: [TECHS[2]] });
  q(e, `Who was the technician on job ${j7.no} and what was the labor cost?`, [j7.tech, moneyVariants(j7.labor)], SHEET('Jobs', j7.row), { same: [j7.no] });
}

/* ============================================================== 8. REGISTERS + LARGE */
{
  const r = rng(500); const N = 3200; const H = ['Invoice No', 'Date', 'Customer', 'Job Type', 'Amount', 'Status', 'Technician', 'Paid Date'];
  const reg = Array.from({ length: N }, (_, i) => { const st = r.pick(['Paid', 'Paid', 'Paid', 'Open', 'Void']); const date = addDays('2025-07-01', Math.floor(i / 9)); return { no: `INV-${10000 + i}`, date, cust: CUST[(i * 7) % 90], type: r.pick(['AC repair', 'Furnace tune-up', 'Leak repair', 'Panel upgrade', 'Water heater', 'Drain clearing', 'Maintenance plan']), amt: r.int(6500, 480000) / 100, st, tech: TECHS[r.int(0, 4)], paid: st === 'Paid' ? addDays(date, r.int(3, 40)) : null }; });
  const rows = [H.map((h) => ({ v: h, fmt: 'bold' })), ...reg.map((x) => [x.no, { v: x.date, fmt: 'date' }, x.cust.name, x.type, { v: x.amt, fmt: 'cur' }, x.st, x.tech, x.paid ? { v: x.paid, fmt: 'date' } : null])];
  const open = reg.filter((x) => x.st === 'Open');
  const e = add('invoice-register-2026.xlsx', zip(xlsx([sheetOf('Register', rows)])), { structure: { sheets: [sheetMeta('Register', rows)], pagesRange: sheetPages([{ rows }]), headerRepeated: ['Invoice No', 'Amount'], minPages: 20 }, keys: sampleKeys(reg.map((x) => x.no), 80) });
  const at = (i) => reg[i - 2];
  q(e, `What was the amount of invoice ${at(2900).no}?`, [moneyVariants(at(2900).amt)], SHEET('Register', 2900), { hard: ['far-row', 'currency'], same: [at(2900).no] });
  q(e, `Who was the customer on invoice ${at(1500).no}?`, [at(1500).cust.name], SHEET('Register', 1500), { hard: ['far-row'], same: [at(1500).no] });
  q(e, `What is the status of invoice ${at(3201).no}?`, [at(3201).st], SHEET('Register', 3201), { hard: ['far-row'], same: [at(3201).no] });
  q(e, `Which technician handled invoice ${at(777).no}?`, [at(777).tech], SHEET('Register', 777), { same: [at(777).no] });
  q(e, `What type of job was invoice ${at(2).no}?`, [at(2).type], SHEET('Register', 2), { same: [at(2).no] });
  q(e, `On what date was invoice ${at(2500).no} issued?`, [dateVariants(at(2500).date)], SHEET('Register', 2500), { hard: ['serial-date', 'far-row'], same: [at(2500).no] });
  q(e, 'How many invoices in the register have status Open?', [], { sheet: 'Register' }, { kind: 'aggregate', expectedCount: open.length, allOf: sampleKeys(open.map((x) => x.no), 40) });
  // CSV twin (first 3,100 rows)
  const sub = reg.slice(0, 3100);
  const csv = [H.join(','), ...sub.map((x) => `${x.no},${mdy(x.date)},"${x.cust.name}",${x.type},${x.amt.toFixed(2)},${x.st},${x.tech},${x.paid ? mdy(x.paid) : ''}`)].join('\n') + '\n';
  const c = add('invoice-register-2026.csv', Buffer.from(csv, 'utf8'), { structure: { csv: true, pagesRange: [Math.floor(csv.length / 6000 * 0.5), Math.ceil(csv.length / 6000 * 2) + 1], headerRepeated: ['Invoice No', 'Amount'], minPages: 20 }, keys: sampleKeys(sub.map((x) => x.no), 60) });
  [2890, 1200, 3101].forEach((row) => q(c, `What was the amount of invoice ${at(row).no}?`, [[at(row).amt.toFixed(2), '$' + at(row).amt.toFixed(2)]], { row, kind: 'csv-row' }, { hard: ['far-row'], same: [at(row).no] }));
  q(c, `Who was the technician on invoice ${at(2000).no}?`, [at(2000).tech], { row: 2000 }, { same: [at(2000).no] });
  q(c, `What is the status of invoice ${at(2950).no}?`, [at(2950).st], { row: 2950 }, { same: [at(2950).no] });
}
{
  const r = rng(510); const N = 20000; const H = ['Record', 'Date', 'Customer', 'Unit Serial', 'Visit', 'Cost'];
  const recs = Array.from({ length: N }, (_, i) => ({ rec: `SH-${100000 + i}`, date: addDays('2024-01-02', Math.floor(i / 25)), cust: CUST[(i * 11) % 90].name, serial: `${r.pick(['4N', '5T', '2R'])}${r.int(1000, 9999)}-${r.int(10000, 99999)}`, visit: r.pick(['Repair', 'Tune-up', 'Install', 'Inspection']), cost: r.int(4900, 150000) / 100 }));
  const rows = [H.map((h) => ({ v: h, fmt: 'bold' })), ...recs.map((x) => [x.rec, { v: x.date, fmt: 'date' }, x.cust, x.serial, x.visit, { v: x.cost, fmt: 'cur' }])];
  const e = add('large-service-history-20000.xlsx', zip(xlsx([sheetOf('History', rows)])), { structure: { sheets: [sheetMeta('History', rows)], pagesRange: sheetPages([{ rows }]), headerRepeated: ['Record', 'Cost'], minPages: 150 }, keys: sampleKeys(recs.map((x) => x.rec), 100) });
  [[19500, 'far-row'], [10001, 'far-row'], [20001, 'last-row'], [2, 'first-row'], [14444, 'far-row']].forEach(([row, h]) => { const x = recs[row - 2]; q(e, `What did visit ${x.rec} cost?`, [moneyVariants(x.cost)], SHEET('History', row), { hard: [h, 'currency'], same: [x.rec] }); });
  q(e, `What unit serial number was serviced on record ${recs[15000].rec}?`, [recs[15000].serial], SHEET('History', 15002), { hard: ['far-row'], same: [recs[15000].rec] });
}
{ // 150-page manual
  const r = rng(520); const W = ['compressor', 'evaporator', 'airflow', 'static pressure', 'refrigerant', 'superheat', 'subcooling', 'blower', 'filter', 'damper', 'duct', 'thermostat', 'contactor', 'capacitor', 'condensate', 'coil', 'inspection', 'torque', 'clearance', 'ventilation'];
  const V = ['Check', 'Verify', 'Record', 'Inspect', 'Replace', 'Clean', 'Measure', 'Confirm'];
  const para = () => { const out = []; let len = 0; while (len < 560) { const s = `${r.pick(V)} the ${r.pick(W)} and the ${r.pick(W)} before ${r.pick(['startup', 'shutdown', 'handoff', 'recording the reading'])}; note the ${r.pick(W)} on the job ticket.`; out.push(s); len += s.length + 1; } return out.join(' '); };
  const facts = new Map([[40, 'The blower wheel set screw torque specification is 85 inch-pounds.'], [400, 'Never exceed a static pressure of 0.9 inches water column on the Model D14 air handler.'], [740, 'The factory warranty on the heat exchanger is twenty (20) years from the install date.']]);
  const body = []; let off = 0; const where = {}; let chapter = 1;
  for (let i = 0; i < 780; i++) {
    if (i % 26 === 0) { const h = `Chapter ${chapter}. ${r.pick(W)} procedures`; body.push(P(h, { style: 'Heading1' })); off += h.length; chapter++; }
    const t = facts.has(i) ? `${facts.get(i)} ${para()}` : para();
    if (facts.has(i)) where[i] = Math.floor(off / 3000) + 1;
    body.push(P(t)); off += t.length;
  }
  const d = docx({ body, header: [['Saguaro Air & Heating Technical Service Manual']], footer: [['Internal use only']] });
  const e = add('large-service-manual-150pages.docx', zip(d.entries), { structure: { pagesRange: [Math.floor(off / 3000 * 0.8), Math.ceil(off / 3000 * 1.25)], docx: true, minPages: 100 }, keys: ['Technical Service Manual', ...[...facts.values()].map((f) => f.split(' ').slice(0, 6).join(' '))] });
  q(e, 'What is the blower wheel set screw torque specification?', ['85 inch-pounds'], { page: where[40], kind: 'body' }, { pageTolerance: 3 });
  q(e, 'What static pressure must never be exceeded on the Model D14 air handler?', ['0.9 inches water column'], { page: where[400], kind: 'body', pageHint: 'deep' }, { hard: ['far-text'], pageTolerance: 4 });
  q(e, 'How long is the factory warranty on the heat exchanger?', ['twenty (20) years'], { page: where[740], kind: 'body' }, { hard: ['far-text'], pageTolerance: 5 });
  q(e, 'What is the manual called in the page header?', ['Technical Service Manual'], { page: 1, kind: 'header' }, { hard: ['header'], pageTolerance: 200 });
  q(e, 'Is the manual marked for internal use only?', ['Internal use only'], { page: 1, kind: 'footer' }, { hard: ['footer'], pageTolerance: 200 });
}

/* ============================================================== 9. MESSY SHEETS */
{
  const r = rng(600); const cs = UNIQ.slice(0, 14);
  const rows = [[{ v: 'Ironwood Plumbing Co.', fmt: 'bold' }], ['Accounts Receivable Aging'], ['As of 3/31/2026'], [], [], ['Customer', 'Invoice #', 'Inv Date', 'Amount', 'Days Out', 'Collector Notes']];
  const m = [];
  cs.forEach((c, i) => {
    if (i === 5) rows.push([]);
    const dt = addDays('2026-01-04', i * 6); const amt = r.int(8000, 220000) / 100;
    const inv = i % 2 ? `0${5500 + i}` : `${5500 + i}`;
    const dtCell = i % 4 === 0 ? { v: dt, fmt: 'date' } : i % 4 === 1 ? { v: mdy(dt), fmt: 'text' } : i % 4 === 2 ? { v: dt, fmt: 'iso' } : { v: `${['Jan', 'Feb', 'Mar'][+dt.slice(5, 7) - 1]} ${+dt.slice(8)} 2026`, fmt: 'text' };
    const amtCell = i % 3 === 0 ? { v: amt.toFixed(2), fmt: 'text' } : { v: amt, fmt: 'cur' };
    const row = [c.name, { v: inv, fmt: 'text' }, dtCell, amtCell, Math.round((Date.UTC(2026, 2, 31) - Date.UTC(+dt.slice(0, 4), +dt.slice(5, 7) - 1, +dt.slice(8))) / 86400000), null];
    if (i === 8) row[8] = 'promised check Friday - call Sofia if bounced';
    rows.push(row); m.push({ c, dt, amt, inv, dtCell, rowNo: rows.length });
  });
  rows.push([], ['TOTAL', null, null, { v: Math.round(m.reduce((a, x) => a + x.amt, 0) * 100) / 100, fmt: 'cur', f: 'SUM(D7:D30)' }]);
  const e = add('messy-ar-aging.xlsx', zip(xlsx([sheetOf('AR', rows)])), { structure: { sheets: [sheetMeta('AR', rows)], pagesRange: [1, 3] }, keys: cs.map((c) => c.name), mustNotAnywhere: ['SUM(D7'] });
  q(e, `How much does ${m[3].c.name} owe?`, [moneyVariants(m[3].amt)], SHEET('AR', m[3].rowNo), { hard: ['text-number', 'messy'], same: [m[3].c.name] });
  q(e, `How much does ${m[4].c.name} owe?`, [moneyVariants(m[4].amt)], SHEET('AR', m[4].rowNo), { hard: ['currency', 'messy'], same: [m[4].c.name] });
  q(e, `What is the note on ${m[8].c.name}?`, ['promised check Friday'], SHEET('AR', m[8].rowNo, { col: 'I' }), { hard: ['odd-cell'], same: [m[8].c.name] });
  q(e, `What is the invoice number for ${m[7].c.name}?`, [m[7].inv], SHEET('AR', m[7].rowNo), { hard: ['text-number'], same: [m[7].c.name] });
  q(e, `What date is the invoice for ${m[0].c.name}?`, [dateVariants(m[0].dt)], SHEET('AR', m[0].rowNo), { hard: ['serial-date', 'messy'], same: [m[0].c.name] });
  q(e, `What date is the invoice for ${m[2].c.name}?`, [dateVariants(m[2].dt)], SHEET('AR', m[2].rowNo), { hard: ['mixed-dates'], same: [m[2].c.name] });
  q(e, 'As of what date is the aging report?', [['3/31/2026']], SHEET('AR', 3), { hard: ['title-block'], same: ['Aging'] });
}
{ // price update: text numbers, mixed dates, percentage, empty sheet among full
  const r = rng(610);
  const mk = (n, base) => Array.from({ length: n }, (_, i) => ({ sku: `${base}-${i + 100}`, desc: `${PARTS[(i * 3) % PARTS.length]} kit`, old: r.int(1000, 90000) / 100, pct: r.int(2, 12) }));
  const a = mk(25, 'JAN'); const b = mk(25, 'FEB');
  const rowsOf = (list) => [[{ v: 'SKU', fmt: 'bold' }, { v: 'Description', fmt: 'bold' }, { v: 'Old Price', fmt: 'bold' }, { v: 'Increase %', fmt: 'bold' }, { v: 'New Price', fmt: 'bold' }], ...list.map((x) => { const np = Math.round(x.old * (1 + x.pct / 100) * 100) / 100; x.np = np; return [x.sku, x.desc, { v: x.old.toFixed(2), fmt: 'text' }, { v: x.pct / 100, fmt: 'pct0' }, { v: np, fmt: 'cur', f: `C${list.indexOf(x) + 2}*(1+D${list.indexOf(x) + 2})` }]; })];
  const ra = rowsOf(a); const rb = rowsOf(b);
  const sheets = [sheetOf('January', ra), sheetOf('Blank', []), sheetOf('February', rb)];
  const e = add('price-updates-one-empty-sheet.xlsx', zip(xlsx(sheets)), { structure: { sheets: [sheetMeta('January', ra), sheetMeta('Blank', []), sheetMeta('February', rb)], pagesRange: [2, 4], emptySheets: ['Blank'] }, keys: [...a.map((x) => x.sku), ...b.map((x) => x.sku)], mustNotAnywhere: ['*(1+D'] });
  q(e, `What is the new price of ${a[4].sku}?`, [moneyVariants(a[4].np)], SHEET('January', 6, { kind: 'formula' }), { hard: ['formula', 'currency'], mustNot: ['*(1+D'], same: [a[4].sku] });
  q(e, `What is the old price of ${a[9].sku}?`, [moneyVariants(a[9].old)], SHEET('January', 11), { hard: ['text-number'], same: [a[9].sku] });
  q(e, `What percentage increase applies to ${b[3].sku}?`, [[`${b[3].pct}%`, `${b[3].pct / 100}`]], SHEET('February', 5), { hard: ['percent'], same: [b[3].sku] });
  q(e, `What is the new price of ${b[20].sku}?`, [moneyVariants(b[20].np)], SHEET('February', 22), { hard: ['formula'], same: [b[20].sku] });
  q(e, `What is the description of ${b[12].sku}?`, [b[12].desc], SHEET('February', 14), { same: [b[12].sku] });
}

/* ============================================================== 10. TEXT, PDF, IMAGES (parity types) */
{
  const lines = ['DISPATCH NOTES - Saguaro Air & Heating - week of March 9, 2026', ''];
  const notes = [[UNIQ[2], 'Dale Whitfield', 'no cooling, capacitor swapped'], [UNIQ[6], 'Angela Ruiz', 'thermostat rewired'], [UNIQ[9], 'Marcus Bell', 'coil cleaned, refrigerant topped'], [UNIQ[14], 'Sofia Brandt', 'condensate line cleared'], [UNIQ[21], 'Terrance Oyelaran', 'blower motor replaced']];
  for (let i = 0; i < 60; i++) { const [c, t, w] = notes[i % 5]; lines.push(`Stop ${i + 1}: ${c.name}, ${c.addr} ${c.city}. Tech ${t}. Result: ${w} (ticket T-${7000 + i}).`); }
  const txt = lines.join('\n') + '\n';
  const e = add('dispatch-notes-week10.txt', Buffer.from(txt), { structure: { pagesRange: [Math.floor(txt.length / 6000 * 0.8), Math.ceil(txt.length / 6000 * 1.3) + 1] }, keys: sampleKeys(Array.from({ length: 60 }, (_, i) => `T-${7000 + i}`), 20) });
  q(e, 'Which technician was on ticket T-7003?', ['Sofia Brandt'], { page: 1 }, { same: ['T-7003'], pageTolerance: 2 });
  q(e, 'What was the result of ticket T-7042?', ['coil cleaned'], { page: Math.floor(txt.indexOf('T-7042') / 6000) + 1 }, { same: ['T-7042'], pageTolerance: 1 });
  q(e, 'What was the result of ticket T-7059?', ['blower motor replaced'], { page: Math.floor(txt.indexOf('T-7059') / 6000) + 1 }, { same: ['T-7059'], pageTolerance: 1 });
  q(e, 'Which address was stop 17 at?', [`${notes[16 % 5][0].addr} ${notes[16 % 5][0].city}`], { page: 1 }, { same: ['Stop 17'], pageTolerance: 1 });
  q(e, 'Who was on ticket T-7010?', [notes[0][1]],{ page: 1 }, { same: ['T-7010'], pageTolerance: 1 });
}
{
  const md = `# Quote Q-2026-114\n\nPrepared for ${UNIQ[3].name} by Ironwood Plumbing Co.\n\n| Item | Price |\n|---|---|\n| Repipe kitchen (PEX) | $1,840.00 |\n| Water softener install | $2,215.00 |\n\nValid for 30 days from March 3, 2026. Deposit due: 25%.\n`;
  const e = add('quote-Q-2026-114.md', Buffer.from(md), { structure: { pagesRange: [1, 1] }, keys: ['Q-2026-114', UNIQ[3].name] });
  q(e, 'What is the price of the water softener install in quote Q-2026-114?', ['$2,215.00', '2,215.00'], { page: 1 }, { same: ['Water softener'] });
  q(e, 'How much is the repipe in quote Q-2026-114?', ['$1,840.00', '1,840.00'], { page: 1 }, {});
  q(e, 'Who is quote Q-2026-114 prepared for?', [UNIQ[3].name], { page: 1 }, {});
  q(e, 'How long is quote Q-2026-114 valid?', ['30 days'], { page: 1 }, {});
  q(e, 'What deposit is due on quote Q-2026-114?', ['25%'], { page: 1 }, { hard: ['percent'] });
}
{
  const parts = PARTS.slice(0, 12).map((p, i) => ({ part_no: `JS-${700 + i}`, name: p, price: 10 + i * 7.5, bin: `A${i + 1}-${(i % 4) + 1}` }));
  const e = add('parts-bins.json', Buffer.from(JSON.stringify({ shop: 'Saguaro Air & Heating', parts }, null, 2)), { structure: { pagesRange: [1, 2] }, keys: parts.map((p) => p.part_no) });
  q(e, 'Which bin holds part JS-705?', [parts[5].bin], { page: 1 }, { same: ['JS-705'], pageTolerance: 1 });
  q(e, 'What is the price of part JS-709?', [String(parts[9].price)], { page: 1 }, { same: ['JS-709'], pageTolerance: 1 });
  q(e, 'What is part JS-702 called?', [parts[2].name], { page: 1 }, { same: ['JS-702'], pageTolerance: 1 });
  q(e, 'What is part JS-711 called?', [parts[11].name], { page: 1 }, { same: ['JS-711'], pageTolerance: 1 });
  q(e, 'Which shop owns this parts list?', ['Saguaro Air & Heating'], { page: 1 }, { pageTolerance: 1 });
}
{
  const c = UNIQ[18];
  const lines = [BIZ.hvac.name, 'SERVICE TICKET T-9012', 'Date of Service: 03/18/2026', `Customer: ${c.name}`, `Service Address: ${c.addr}, ${c.city}, AZ ${c.zip}`, `Phone: ${c.phone}`, 'Equipment: Trane XR14 Serial: 5T4471-20388', 'Technician: Angela Ruiz', 'Work Performed: replaced contactor and tested capacity', 'Total: $412.60'];
  const e = add('ticket-text-T-9012.pdf', pdf([lines]), { structure: { pagesRange: [1, 1] }, keys: ['T-9012', c.name, c.phone] });
  q(e, 'What is the phone number of the customer on service ticket T-9012?', [c.phone], { page: 1 }, { same: [c.name] });
  q(e, 'Who was the technician on ticket T-9012?', ['Angela Ruiz'], { page: 1 }, { same: ['T-9012'] });
  q(e, 'What was the total on ticket T-9012?', ['$412.60', '412.60'], { page: 1 }, { hard: ['currency'], same: ['T-9012'] });
  q(e, 'What serial number is on ticket T-9012?', ['5T4471-20388'], { page: 1 }, { same: ['T-9012'] });
  q(e, 'What work was performed on ticket T-9012?', ['replaced contactor'], { page: 1 }, { same: ['T-9012'] });
}
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
add('photo-nameplate.jpg', JPG, { status: 'model-path', reason: [], structure: {}, note: 'photo: needs the vision model; the harness checks upload + sniff only' });
add('scan-ticket.png', PNG, { status: 'model-path', reason: [], structure: {}, note: 'photo: needs the vision model; the harness checks upload + sniff only' });

/* ============================================================== 11. EMPTY / ZERO-BYTE */
const refused = (reason, extra = {}) => ({ status: 'refused', reason: Array.isArray(reason) ? reason : [reason], structure: {}, ...extra });
add('empty.docx', zip(docx({ body: [] }).entries), refused('empty'));
add('empty.xlsx', zip(xlsx([sheetOf('Sheet1', [])])), refused('empty'));
add('zero-byte.docx', Buffer.alloc(0), refused('empty', { upload: 'reject', note: 'a 0-byte file cannot be signed for upload (size must be > 0)' }));
add('zero-byte.xlsx', Buffer.alloc(0), refused('empty', { upload: 'reject', note: 'a 0-byte file cannot be signed for upload' }));
add('empty.csv', Buffer.alloc(0), refused('empty', { upload: 'reject', note: 'a 0-byte file cannot be signed for upload' }));

/* ============================================================== 12. CORRUPT */
{
  const good = zip(docx({ body: [P('Corrupt test: invoice INV-99001 for a boiler inspection.')] }).entries);
  add('corrupt-truncated.docx', good.subarray(0, Math.floor(good.length * 0.55)), refused('corrupt'));
  const d = docx({ body: [], rawDocument: `${XMLDECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Broken invoice INV-99002 text</w:t></w:r></w:p><w:p><w:r><w:t>never closed` });
  add('corrupt-badxml.docx', zip(d.entries), refused('corrupt'));
  const gx = zip(xlsx([sheetOf('Jobs', [['Job', 'Total'], ...Array.from({ length: 80 }, (_, i) => [`J-${i}`, i * 3])])]));
  const z = Buffer.from(gx); z.fill(0, 100, z.length - 60);
  add('corrupt-zeroed.xlsx', z, refused('corrupt'));
  add('corrupt-truncated.xlsx', gx.subarray(0, Math.floor(gx.length * 0.6)), refused('corrupt'));
}

/* ============================================================== 13. RENAMED / MISLABELLED */
{
  const realDocx = zip(docx({ body: [P('Real Word file renamed. Customer Odette Ibarra phone (480) 555-0188.')] }).entries);
  const realXlsx = zip(xlsx([sheetOf('S', [['a', 'b'], [1, 2]])]));
  add('renamed-exe.pdf', Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1'), Buffer.alloc(900, 0x41)]), refused(['mismatch', 'unsupported']));
  add('renamed-docx-as.xlsx', realDocx, refused('mismatch'));
  add('renamed-png-as.docx', PNG, refused('mismatch'));
  add('renamed-docx-as.pdf', realDocx, refused('mismatch'));
  add('renamed-xlsx-as.docx', realXlsx, refused('mismatch'));
}

/* ============================================================== 14. ENCRYPTED / LEGACY / MACRO / OTHER UPLOAD-ONLY */
{
  const encInfo = '\x04\x00\x04\x00\x40\x00\x00\x00';
  add('encrypted-ole.docx', ole2([{ name: 'EncryptionInfo', lead: encInfo, size: 4096 }, { name: 'EncryptedPackage', size: 4096 }]), refused('encrypted'));
  add('encrypted-ole.xlsx', ole2([{ name: 'EncryptionInfo', lead: encInfo, size: 4096 }, { name: 'EncryptedPackage', size: 8192 }]), refused('encrypted'));
  const biffFilepass = Buffer.concat([Buffer.from([0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0x2f, 0x00, 0x36, 0x00, 0x01, 0x00])]).toString('latin1');
  add('encrypted-legacy.xls', ole2([{ name: 'Workbook', lead: biffFilepass, size: 4096 }]), refused(['encrypted', 'legacy']));
  add('legacy-old.doc', ole2([{ name: 'WordDocument', lead: '\xec\xa5\xc1\x00', size: 4096 }, { name: '1Table', size: 4096 }]), refused('legacy'));
  add('legacy-old.xls', ole2([{ name: 'Workbook', lead: '\x09\x08\x10\x00\x00\x06\x05\x00', size: 4096 }]), refused('legacy'));
  add('legacy-old.ppt', ole2([{ name: 'PowerPoint Document', lead: '\x00\x00', size: 4096 }]), refused('legacy'));
  add('legacy-named.docx', ole2([{ name: 'WordDocument', lead: '\xec\xa5\xc1\x00', size: 4096 }, { name: '1Table', size: 4096 }]), refused(['legacy', 'mismatch']));
  const vba = { name: 'xl/vbaProject.bin', data: ole2([{ name: 'VBA', lead: 'Attribute VB_Name = "Module1"', size: 4096 }]) };
  add('macro.xlsm', zip(xlsx([sheetOf('S', [['Total', 5]])], { macroCt: true, extra: [vba], contentTypesExtra: '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' })), refused('macro'));
  add('macro-in-xlsx.xlsx', zip(xlsx([sheetOf('Jobs', [['Job', 'Total'], ['J-1', 10]])], { macroCt: true, extra: [vba], contentTypesExtra: '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' })), refused('macro'));
  add('macro-hidden-part.xlsx', zip(xlsx([sheetOf('Jobs', [['Job', 'Total'], ['J-1', 10]])], { extra: [vba] })), refused('macro'));
  const dm = docx({ body: [P('Macro enabled letter')], extra: [{ name: 'word/vbaProject.bin', data: vba.data }], contentTypesExtra: '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' });
  add('macro.docm', zip(dm.entries), refused('macro'));
  add('template.dotm', zip(dm.entries), refused('macro'));
  add('book.xlsb', zip([{ name: '[Content_Types].xml', data: XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' }, { name: 'xl/workbook.bin', data: Buffer.alloc(200, 1) }]), refused('unsupported'));
  add('installer.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(600, 0x90)]), refused('unsupported'));
  add('archive.zip', zip([{ name: 'inner.docx', data: zip(docx({ body: [P('inside a zip')] }).entries) }]), refused('unsupported'));
  add('scan.tiff', Buffer.concat([Buffer.from('II*\x00', 'latin1'), Buffer.alloc(300)]), refused('unsupported'));
  add('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200)), refused('unsupported'));
  add('picture.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(300)]), refused('unsupported'));
  add('heic-photo.heic', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'), Buffer.alloc(800, 0x5a)]), refused('unsupported'));
  add('heic-named.jpg', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'), Buffer.alloc(800, 0x5a)]), refused(['unsupported', 'mismatch']));
}

/* ============================================================== 15. HOSTILE (built small; inflate huge) */
const NSW = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
async function buildHostile() {
  // zip bombs: > 1 GB inflated from ~1 MB
  const bx = xlsx([sheetOf('Jobs', [['Job', 'Total'], ['J-1', 10]])]);
  const sheetBomb = await bombEntry('xl/worksheets/sheet1.xml', { prefix: `${XMLDECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>`, filler: ' ', total: 1100 * 1024 * 1024, suffix: '</t></is></c></row></sheetData></worksheet>' });
  add('hostile-zipbomb.xlsx', zip(bx.map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? sheetBomb : e))), refused('limit', { hostile: true }));
  const bd = docx({ body: [] });
  const docBomb = await bombEntry('word/document.xml', { prefix: `${XMLDECL}<w:document ${NSW}><w:body><w:p><w:r><w:t>`, filler: ' ', total: 1100 * 1024 * 1024, suffix: '</w:t></w:r></w:p></w:body></w:document>' });
  add('hostile-zipbomb.docx', zip(bd.entries.map((e) => (e.name === 'word/document.xml' ? docBomb : e))), refused('limit', { hostile: true }));
  const many = xlsx([sheetOf('Jobs', [['Job', 'Total'], ['J-1', 10]])]);
  for (let i = 0; i < 2600; i++) many.push({ name: `xl/media/pad${i}.txt`, data: '' });
  add('hostile-entries-bomb.xlsx', zip(many), refused('limit', { hostile: true }));
  const trav = docx({ body: [P('Traversal fixture: customer Hattie Quintero phone (480) 555-0191 boiler service.')] });
  const tr = [...trav.entries, { name: '../../evil.txt', data: 'pwned' }, { name: '/etc/cron.d/evil', data: 'pwned' }, { name: '..\\..\\win.ini', data: 'pwned' }, { name: 'word/../../escape.xml', data: 'pwned' }];
  add('hostile-traversal.docx', zip(tr), { status: 'either', reason: ['hostile', 'corrupt'], structure: {}, hostile: true, readQuestions: [['Traversal fixture customer phone', '(480) 555-0191']], neverWritePaths: true });
  // billion laughs
  let ents = '<!ENTITY lol0 "lol">'; for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${'&lol' + (i - 1) + ';'.repeat(1)}${('&lol' + (i - 1) + ';').repeat(9)}">`;
  const bl = docx({ body: [], rawDocument: `${XMLDECL}<!DOCTYPE lolz [${ents}]><w:document ${NSW}><w:body><w:p><w:r><w:t>Billion laughs fixture: tenant Ignacio Delgado deposit $750.00 &lol9;</w:t></w:r></w:p></w:body></w:document>` });
  add('hostile-billion-laughs.docx', zip(bl.entries), { status: 'either', reason: ['hostile', 'corrupt', 'limit'], structure: {}, hostile: true, mustNotAnywhere: ['lollollol'], timeLimitMs: 20000 });
  const xx = docx({ body: [], rawDocument: `${XMLDECL}<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY imds SYSTEM "http://169.254.169.254/latest/meta-data/iam/security-credentials/"><!ENTITY ext SYSTEM "http://localhost:1/x">]><w:document ${NSW}><w:body><w:p><w:r><w:t>XXE fixture: visible boiler inspection note for customer Paloma Fairbanks.</w:t></w:r></w:p><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p><w:p><w:r><w:t>&imds;</w:t></w:r></w:p><w:p><w:r><w:t>&ext;</w:t></w:r></w:p></w:body></w:document>` });
  add('hostile-xxe.docx', zip(xx.entries), { status: 'either', reason: ['hostile', 'corrupt'], structure: {}, hostile: true, mustNotAnywhere: ['root:x:', 'daemon:', 'AccessKeyId', 'nobody:'], neverFetch: true });
  const xs = xlsx([sheetOf('Jobs', [['Job', 'Total'], ['J-7', 10]])], { sstOverride: `${XMLDECL}<!DOCTYPE sst [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY imds SYSTEM "http://169.254.169.254/latest/meta-data/">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>Job</t></si><si><t>Total</t></si><si><t>J-7</t></si><si><t>&xxe;&imds;</t></si></sst>` });
  add('hostile-xxe.xlsx', zip(xs), { status: 'either', reason: ['hostile', 'corrupt'], structure: {}, hostile: true, mustNotAnywhere: ['root:x:', 'daemon:', 'ami-id', 'nobody:'], neverFetch: true });
  const deep = docx({ body: [], rawDocument: `${XMLDECL}<w:document ${NSW}><w:body><w:p>${'<w:r>'.repeat(100000)}<w:t>deep</w:t>${'</w:r>'.repeat(100000)}</w:p></w:body></w:document>` });
  add('hostile-deep-nesting.docx', zip(deep.entries), refused('limit', { hostile: true }));
  const big = await bombEntry('xl/sharedStrings.xml', { prefix: `${XMLDECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>`, filler: 'B', total: 50 * 1024 * 1024, suffix: '</t></si></sst>' });
  add('hostile-bigcell.xlsx', zip(xlsx([sheetOf('S', [['x']])]).map((e) => (e.name === 'xl/sharedStrings.xml' ? big : e))), refused('limit', { hostile: true }));
  { // external link + embedded OLE + nested zip + 100k paragraphs: readable files that must not be followed / executed / expanded
    const rows = [['Job', 'Customer', 'Total'], ['J-8801', UNIQ[24].name, { v: 1432.5, fmt: 'cur' }], ['J-8802', UNIQ[25].name, { v: 288, fmt: 'cur' }], ['J-8803', UNIQ[26].name, { v: 99.99, fmt: 'cur' }], ['J-8804', UNIQ[27].name, { v: 12000, fmt: 'cur' }], ['J-8805', UNIQ[28].name, { v: 45.1, fmt: 'cur' }]];
    const ext = [{ name: 'xl/externalLinks/externalLink1.xml', data: `${XMLDECL}<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"><sheetNames><sheetName val="Secrets"/></sheetNames></externalBook></externalLink>` },
      { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="http://169.254.169.254/latest/meta-data/" TargetMode="External"/></Relationships>` }];
    const e = add('hostile-external-link.xlsx', zip(xlsx([sheetOf('Jobs', rows)], { extra: ext, wbRelsExtra: '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>', definedNames: '' })), { structure: { sheets: [sheetMeta('Jobs', rows)], pagesRange: [1, 2] }, keys: ['J-8801', 'J-8805'], neverFetch: true, mustNotAnywhere: ['169.254', 'etc/passwd'] });
    [[1, 1432.5], [2, 288], [3, 99.99], [4, 12000], [5, 45.1]].forEach(([i, v]) => q(e, `What is the total for job J-880${i}?`, [moneyVariants(v)], SHEET('Jobs', i + 1), { hard: ['external-link'], same: [`J-880${i}`] }));
    const ole = ole2([{ name: 'Ole10Native', lead: 'MZ-looks-like-a-program', size: 4096 }]);
    const body = [P('Embedded object fixture: lift station inspection for customer Lucinda Pemberton, contact (602) 555-0166.'), P('The attached object is a vendor spreadsheet. Technician: Dale Whitfield. Permit number: P-55120.'), '<w:p><w:r><w:object><v:shape xmlns:v="urn:schemas-microsoft-com:vml" id="s1"/><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="Excel.Sheet.12" r:id="rId30"/></w:object></w:r></w:p>', P('Inspection passed with no deficiencies. Next visit: June 2, 2026.'), P('Billed amount: $640.00.')];
    const d = docx({ body, extra: [{ name: 'word/embeddings/oleObject1.bin', data: ole }, { name: 'word/embeddings/inner-archive.zip', data: zip([{ name: 'inner.txt', data: 'zip in zip SECRET-INNER-TEXT' }]) }], docRelsExtra: '<Relationship Id="rId30" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/>' });
    const e2 = add('hostile-embedded-ole-zipinzip.docx', zip(d.entries), { structure: { pagesRange: [1, 2], docx: true }, keys: ['Lucinda Pemberton', 'P-55120'], mustNotAnywhere: ['SECRET-INNER-TEXT', 'MZ-looks-like'] });
    q(e2, 'What is the permit number on the lift station inspection?', ['P-55120'], { page: 1 }, { hard: ['embedded-ole'] });
    q(e2, 'What phone number is given for Lucinda Pemberton?', ['(602) 555-0166'], { page: 1 }, { same: ['Lucinda Pemberton'] });
    q(e2, 'When is the next lift station visit?', [['June 2, 2026']], { page: 1 }, {});
    q(e2, 'What was billed for the lift station inspection?', ['$640.00', '640.00'], { page: 1 }, { hard: ['currency'] });
    q(e2, 'Who is the technician for the lift station inspection?', ['Dale Whitfield'], { page: 1 }, {});
    const paras = '<w:p/>'.repeat(100000);
    const ep = docx({ body: [], rawDocument: `${XMLDECL}<w:document ${NSW}><w:body><w:p><w:r><w:t>Empty paragraph flood fixture: boiler tag B-4471 for Wendell Montoya.</w:t></w:r></w:p>${paras}${TBL([['Item', 'Price'], ['Boiler flush', '$215.00']])}${paras}<w:p><w:r><w:t>Warranty registered under W-90210.</w:t></w:r></w:p></w:body></w:document>` });
    const e3 = add('hostile-empty-paragraphs.docx', zip(ep.entries), { structure: { pagesRange: [1, 1], docx: true, exactPages: 1 }, keys: ['B-4471', 'Wendell Montoya', 'W-90210'] });
    q(e3, 'What boiler tag is on the flood fixture?', ['B-4471'], { page: 1 }, { hard: ['empty-paragraphs'] });
    q(e3, 'Which customer owns boiler B-4471?', ['Wendell Montoya'], { page: 1 }, {});
    q(e3, 'What is the price of the boiler flush?', ['$215.00', '215.00'], { page: 1, kind: 'table' }, { hard: ['table'], same: ['Boiler flush'] });
    q(e3, 'What warranty number was registered?', ['W-90210'], { page: 1 }, {});
    q(e3, 'What was the empty paragraph flood fixture about?', ['boiler'], { page: 1 }, {});
  }
  const many2 = xlsx(Array.from({ length: 100 }, (_, i) => sheetOf(`Sheet${i + 1}`, [['Job', 'Total'], [`J-${i}`, i]])));
  add('hostile-sheet-count.xlsx', zip(many2), refused('limit', { hostile: true }));
}

/* ============================================================== finish */
await buildHostile();

// summary stats on the oracle
let nq = 0; const types = {};
for (const [n, f] of files) { nq += f.exp.questions.length; types[f.exp.type] = (types[f.exp.type] ?? 0) + 1; }
const finalExpected = { schema: 1, note: 'Oracle written from generator source data before any reader ran. Never edited after results; corrections go in errata/ files.', reasonClasses: ['empty', 'corrupt', 'mismatch', 'encrypted', 'legacy', 'macro', 'limit', 'hostile', 'unsupported'], files: Object.fromEntries([...files.keys()].sort().map((k) => [k, EXPECT[k]])) };
const expectedJson = JSON.stringify(finalExpected, null, 1) + '\n';

fs.mkdirSync(OUT, { recursive: true });
let wrote = 0; let total = 0;
for (const [name, { bytes }] of files) {
  const p = path.join(OUT, name); total += bytes.length;
  const big = bytes.length > 200_000 && /hostile/.test(name);
  if (!FORCE && big && fs.existsSync(p) && fs.statSync(p).size === bytes.length) continue;
  fs.writeFileSync(p, bytes); wrote++;
}
const expPath = path.join(HERE, 'expected.json');
if (WRITE_EXPECTED) {
  fs.writeFileSync(expPath, expectedJson);
  const sha = crypto.createHash('sha256').update(expectedJson).digest('hex');
  fs.writeFileSync(path.join(HERE, 'EXPECTED.sha256'), `${sha}  expected.json\nrecorded-at: ${new Date().toISOString()}\nnote: written by gen.mjs --write-expected BEFORE any reader ran against these fixtures (phase 1).\n`);
  console.log(`expected.json written (${nq} questions); sha256 ${sha}`);
} else {
  if (!fs.existsSync(expPath)) { console.error('expected.json missing: run with --write-expected (phase 1 only)'); process.exit(2); }
  const onDisk = fs.readFileSync(expPath, 'utf8');
  if (onDisk !== expectedJson) { console.error('FAIL: freshly generated oracle differs from committed expected.json (generator changed or expected.json edited). Use errata/ files instead of editing.'); process.exit(2); }
  const sha = crypto.createHash('sha256').update(onDisk).digest('hex');
  const rec = fs.readFileSync(path.join(HERE, 'EXPECTED.sha256'), 'utf8').split(/\s+/)[0];
  if (sha !== rec) { console.error('FAIL: expected.json hash does not match EXPECTED.sha256'); process.exit(2); }
}
console.log(`fixtures: ${files.size} files (${wrote} written), ${(total / 1024 / 1024).toFixed(1)} MB, ${nq} questions; by ext ${JSON.stringify(types)}`);
export { files, EXPECT };
