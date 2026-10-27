// Synthetic import for the bulk-import autopilot measurements: N papers with KNOWN answers (the model is stubbed: the "read" fields are given).
// Deterministic (seeded). Every paper carries a truth record so the run can count wrong links and wrong values exactly.
//   kinds: clean (linked, passes every check) · company (no link needed) · newcust (names a customer that does not exist yet) ·
//          suggest (the page weakly points at ONE existing customer) · suggest2 (two candidates) · datefix (only the service date is missing, invoice
//          date on file) · copyfiled / copyopen (a copy of a filed / of an open paper) · revision (same name + (2), other cost) · typeq (name and page
//          disagree on the type) · hard (unreadable / unsure value / future date / missing cost / lone new customer) · trap (must never be linked,
//          created, filed or changed) · hr (a person's paper naming a customer)
export function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const FIRST = ['Maria', 'James', 'Linda', 'Robert', 'Patricia', 'Michael', 'Barbara', 'William', 'Susan', 'David', 'Karen', 'Richard', 'Nancy', 'Joseph', 'Lisa', 'Thomas', 'Betty', 'Charles', 'Helen', 'Daniel', 'Sandra', 'Paul', 'Donna', 'Mark', 'Carol', 'Steven', 'Ruth', 'Kevin', 'Sharon', 'Brian', 'Laura', 'George', 'Cynthia', 'Edward', 'Amy', 'Ronald', 'Angela', 'Timothy', 'Brenda', 'Jason'];
const LAST = ['Lopez', 'Nguyen', 'Prentiss', 'Okafor', 'Whitfield', 'Castillo', 'Brennan', 'Hartley', 'Yamamoto', 'Delgado', 'Fischer', 'Granger', 'Holloway', 'Iverson', 'Jaramillo', 'Kowalski', 'Lindqvist', 'Marchetti', 'Novak', 'Ortega', 'Pemberton', 'Quigley', 'Ramirez', 'Sandoval', 'Tran', 'Underwood', 'Vasquez', 'Wexler', 'Xiong', 'Yoder', 'Zamora', 'Abbott', 'Bishop', 'Calloway', 'Dunmore', 'Ellison', 'Fontaine', 'Gutierrez', 'Hendricks', 'Ibarra'];
const BIZ_A = ['Bluff Creek', 'Saguaro Ridge', 'Palo Verde', 'Copper Basin', 'Red Mesa', 'Canyon Vista', 'Ironwood', 'Desert Bloom', 'Camelback', 'Sunrise Valley', 'Pinnacle', 'Mesquite Grove', 'Superstition', 'High Desert', 'Cactus Flat', 'Verde Mountain', 'Tonto Rim', 'Salt River', 'Apache Wells', 'Agave Hills', 'Gila Bend', 'Sonoita'];
const BIZ_B = ['Plumbing', 'Dental Group', 'Property Management', 'Logistics', 'Realty', 'Veterinary Clinic', 'Bakery', 'Storage', 'Apartments', 'Medical Center', 'Auto Repair', 'Hardware', 'Church', 'Charter School', 'Bistro', 'Fitness'];
const STREETS = ['Elm St', 'Oak Ave', 'Desert Willow Dr', 'Cactus Rd', 'Mesa Blvd', 'Palm Ln', 'Sunset Way', 'Ironwood Ct', 'Saguaro Pl', 'Canyon Rd'];
const SHOP = 'Mesa Mechanical Services';

export function buildSynthetic(N = 5000, seed = 20261026) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  let seq = 0;
  const id = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
  const day = () => `2026-${String(int(1, 9)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
  const street = () => `${int(100, 9899)} ${pick(STREETS)}`;
  const money = () => (int(80, 4800) + (int(0, 99) / 100)).toFixed(2);

  // ---- customers
  const existing = []; const usedNames = new Set();
  const personName = () => { for (;;) { const n = `${pick(FIRST)} ${pick(LAST)}`; if (!usedNames.has(n)) { usedNames.add(n); return n; } } };
  const bizName = () => { for (;;) { const n = `${pick(BIZ_A)} ${pick(BIZ_B)}`; if (!usedNames.has(n)) { usedNames.add(n); return n; } } };
  const nExisting = Math.max(60, Math.round(N * 0.044));
  for (let i = 0; i < nExisting; i++) existing.push({ id: id(), name: i % 4 === 3 ? bizName() : personName(), address: `${street()}, Mesa, AZ 852${int(10, 99)}` });
  const docs = []; const links = []; const suggestions = []; const audits = [];
  const truth = new Map(); // docId -> {kind, customer: name|null, serviceDate, mustNotChange?:true}
  const add = (d) => { d.id = id(); d.fields = d.fields.filter((f) => f.value != null && f.value !== ''); docs.push(d); truth.set(d.id, { kind: d.kind, customer: d.truthCustomer ?? null, serviceDate: d.truthDate ?? null, type: d.truthType ?? d.type }); return d; };

  const letter = (title, num, date, extra) => `${SHOP}\n8953 W Timber Blvd, Mesa, AZ 85292  |  480.555.0144  |  info@mesamechanical.example.com\n${title}\n${extra.numLabel ?? 'Invoice #'} | ${num} | Date Issued | ${mdy(date)}\n${extra.body}`;
  function body(kind, c, o) {
    const billTo = o.labelStyle === 'inline' ? `Customer: ${c.name}\n${c.address}` : `BILL TO\n${c.name}\n${c.address}`;
    return `${billTo}\n${o.service ? `Service Date: ${mdy(o.service)}\n` : ''}Description of Work | Amount\n${o.work ?? 'Service and repair per customer request'} | $${o.cost ?? money()}\nTotal $${o.cost ?? money()}`;
  }
  const TYPES = ['service-ticket', 'work-order', 'invoice', 'proposal-quote', 'maintenance-agreement'];
  function paper(kind, c, o = {}) {
    const type = o.type ?? pick(TYPES);
    const num = o.num ?? String(int(10000, 99999));
    const date = o.date ?? day();
    const cost = o.cost ?? money();
    const fields = [];
    const f = (key, value, conf = 0.95) => fields.push({ key, value, conf });
    if (type !== 'maintenance-agreement') f('vendor', SHOP);
    if (o.printName !== false) f('customer_name', o.printedName ?? c.name);
    if (type === 'service-ticket') { f('service_address', c.address.split(',')[0]); f('service_date', o.noService ? null : (o.service ?? date)); f('work_performed', 'Replaced capacitor and checked refrigerant'); f('invoice_number', num); }
    if (type === 'work-order') { f('service_address', c.address.split(',')[0]); f('service_date', o.noService ? null : (o.service ?? date)); f('invoice_number', num); }
    if (type === 'invoice') { f('invoice_number', num); if (o.address !== false) f('service_address', c.address.split(',')[0]); f('service_date', o.noService ? null : (o.service ?? date)); if (!o.noCost) f('cost', cost, o.costConf ?? 0.95); if (o.invoiceDate) f('invoice_date', o.invoiceDate); }
    if (type === 'proposal-quote') { f('cost', cost); f('service_address', c.address.split(',')[0]); }
    if (type === 'maintenance-agreement') { f('agreement_term', '12 months from 01/01/2026'); f('service_address', c.address.split(',')[0]); }
    const title = { 'service-ticket': 'SERVICE TICKET', 'work-order': 'WORK ORDER', invoice: 'INVOICE', 'proposal-quote': 'PROPOSAL', 'maintenance-agreement': 'MAINTENANCE AGREEMENT' }[type];
    const text = o.text ?? letter(title, num, date, { numLabel: type === 'invoice' ? 'Invoice #' : 'Ref #', body: body(kind, c, { labelStyle: o.labelStyle, service: o.noService ? null : (o.service ?? date), cost, work: o.work }) });
    const name = o.name ?? `${c.name.split(' ').slice(-1)[0]} ${title.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())} ${num}.pdf`;
    return { kind, name, type, fields, text, stage: o.stage ?? 'read', batch: true, truthCustomer: o.truthCustomer !== undefined ? o.truthCustomer : c.name, truthDate: o.truthDate ?? (o.noService ? null : (o.service ?? date)), num, cost };
  }
  const company = (kind, o = {}) => {
    const type = o.type ?? pick(['purchase-order', 'statement', 'price-list', 'insurance-certificate', 'correspondence']);
    const vendor = o.vendor ?? `${pick(BIZ_A)} Supply Co`;
    const num = String(int(1000, 99999));
    const fields = [];
    if (type === 'purchase-order') { fields.push({ key: 'vendor', value: vendor, conf: 0.95 }, { key: 'cost', value: money(), conf: 0.95 }, { key: 'invoice_number', value: num, conf: 0.9 }); }
    else fields.push({ key: 'vendor', value: vendor, conf: 0.95 }, { key: 'service_date', value: day(), conf: 0.9 });
    const title = { 'purchase-order': 'PURCHASE ORDER', statement: 'STATEMENT OF ACCOUNT', 'price-list': 'PRICE LIST', 'insurance-certificate': 'CERTIFICATE OF LIABILITY INSURANCE', correspondence: 'LETTER' }[type];
    return { kind, name: `${vendor.split(' ')[0]} ${title.toLowerCase()} ${num}.pdf`, type, fields, text: `${vendor}\n4400 E Industrial Way, Phoenix, AZ 85040\n${title}\nBill To: ${SHOP}\nTotal $${money()}`, stage: 'read', batch: true, truthCustomer: null, truthDate: null };
  };

  const plan = (p) => Math.round(N * p);
  const nSuggest = plan(0.04), nSuggest2 = plan(0.01), nDate = plan(0.05), nCopyFiled = plan(0.03), nCopyOpen = Math.max(4, plan(0.006)), nRev = Math.max(4, plan(0.008)),
    nTypeq = plan(0.012), nHard = plan(0.04), nTrap = Math.max(10, plan(0.02)), nHr = Math.max(4, plan(0.004)), nNew = plan(0.07), nCompany = plan(0.08);

  // ---- new customers (do not exist yet): a few big groups, a tail of small ones
  const newGroups = []; let left = nNew; let sizeSeed = Math.max(6, Math.round(nNew * 0.26));
  while (left >= 2 && newGroups.length < 40) { const n = Math.min(left, Math.max(2, sizeSeed)); newGroups.push({ id: null, name: newGroups.length % 3 === 2 ? personName() : bizName(), address: `${street()}, Gilbert, AZ 852${int(10, 99)}`, n }); left -= n; sizeSeed = Math.round(sizeSeed * 0.72); }
  if (left > 0 && newGroups.length) newGroups[0].n += left;
  const NEWTYPES = ['service-ticket', 'work-order', 'proposal-quote', 'maintenance-agreement'];
  for (const g of newGroups) for (let i = 0; i < g.n; i++) add(paper('newcust', g, { type: NEWTYPES[i % 4], labelStyle: i % 3 === 0 ? 'inline' : 'billto' }));

  // ---- weak suggestion to exactly one existing customer (page names the customer only in a sentence; a person must say yes)
  const sugTargets = existing.slice(0, 14); let sl = nSuggest; let si = 0;
  while (sl > 0) { const c = sugTargets[si % sugTargets.length]; si++; const n = 'service-ticket'; const d = paper('suggest', c, { type: n, printName: false, text: `${SHOP}\n8953 W Timber Blvd, Mesa, AZ 85292  |  480.555.0144\nSERVICE TICKET\nRef # | ${int(10000, 99999)} | Date Issued | ${mdy(day())}\nTech notes: unit at the ${c.name.split(' ').slice(-1)[0]} residence, ${c.address.split(',')[0]}. Replaced capacitor.\nService Date: ${mdy(day())}` });
    const doc = add(d); suggestions.push({ doc: doc.id, candidates: [{ id: c.id, name: c.name }] }); sl--; }
  // ---- two candidates (never a decision)
  for (let i = 0; i < nSuggest2; i++) { const a = existing[(20 + i) % existing.length], b = existing[(21 + i + 7) % existing.length]; const doc = add(paper('suggest2', a, { type: 'service-ticket', printName: false, truthCustomer: null, text: `${SHOP}\nSERVICE TICKET\nTech notes: ${a.name.split(' ').slice(-1)[0]} or ${b.name.split(' ').slice(-1)[0]} unit, replaced capacitor.\nService Date: ${mdy(day())}` })); suggestions.push({ doc: doc.id, candidates: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }] }); }

  // ---- date fix: only the service date is missing, the invoice date is on file
  for (let i = 0; i < nDate; i++) { const c = existing[(i * 7) % existing.length]; const inv = day(); const d = add(paper('datefix', c, { type: 'invoice', address: false, noService: true, invoiceDate: inv, date: inv, truthDate: inv, text: letter('INVOICE', String(int(10000, 99999)), inv, { body: `BILL TO\n${c.name}\n${c.address}\nDescription of Work | Amount\nService and repair | $${money()}` }) })); d.link = c.id; }

  // ---- copies
  for (let i = 0; i < nCopyFiled; i++) { const c = existing[(i * 11) % existing.length]; const o = add({ ...paper('copyorig', c, { type: 'invoice', address: false }), stage: 'verified', verified: true }); o.link = c.id; const cp = add(paper('copyfiled', c, { type: 'invoice', address: false, num: o.num, cost: o.cost, name: o.name.replace(/\.pdf$/, ' (copy).pdf'), text: o.text, service: o.fields.find((f) => f.key === 'service_date')?.value })); cp.fields = o.fields.map((f) => ({ ...f })); cp.link = c.id; cp.truthCustomer = c.name; }
  for (let i = 0; i < nCopyOpen; i++) { const c = existing[(i * 13 + 3) % existing.length]; const o = add(paper('copyopen-orig', c, { type: 'invoice', address: false })); o.link = c.id; const cp = add(paper('copyopen', c, { type: 'invoice', address: false, num: o.num, cost: o.cost, name: o.name.replace(/\.pdf$/, ' (copy).pdf'), text: o.text })); cp.fields = o.fields.map((f) => ({ ...f })); cp.link = c.id; }
  for (let i = 0; i < nRev; i++) { const c = existing[(i * 17 + 5) % existing.length]; const o = add(paper('revision-orig', c, { type: 'invoice', address: false })); o.link = c.id; const rv = add(paper('revision', c, { type: 'invoice', address: false, num: o.num, name: o.name.replace(/\.pdf$/, ' (2).pdf') })); rv.link = c.id; }

  // ---- type question: the name and the page disagree
  const coiPage = (n) => `${n} Insurance Agency\nCERTIFICATE OF LIABILITY INSURANCE\nDATE ${mdy(day())}\nPRODUCER\nINSURED  ${SHOP}\nCOVERAGES  POLICY NUMBER  ${int(1000000, 9999999)}`;
  for (let i = 0; i < nTypeq; i++) { const half = i < nTypeq / 2; const nm = pick(BIZ_A); add({ kind: 'typeq', name: half ? `COI - ${nm} 2025.pdf` : `Certificate ${nm} ${i}.pdf`, type: 'warranty-registration', truthType: 'insurance-certificate', fields: [{ key: 'serial_number', value: `SN${int(100000, 999999)}`, conf: 0.9 }, { key: 'model', value: `MX${int(100, 999)}`, conf: 0.9 }, { key: 'warranty_term', value: '1 year', conf: 0.9 }, { key: 'vendor', value: `${nm} Insurance Agency`, conf: 0.9 }], text: coiPage(nm), stage: 'read', batch: true, truthCustomer: null }); }

  // ---- hard / one-by-one
  const hardKinds = ['unreadable', 'lowconf', 'nocost', 'future', 'lone', 'blurry'];
  for (let i = 0; i < nHard; i++) {
    const k = hardKinds[i % hardKinds.length]; const c = existing[(i * 5 + 9) % existing.length];
    if (k === 'unreadable') add({ kind: 'hard', name: `scan ${i}.pdf`, type: 'other', fields: [], text: '', stage: 'read', batch: true, truthCustomer: null });
    else if (k === 'blurry') add({ kind: 'hard', name: `IMG_${i}.jpg`, type: 'service-ticket', fields: [], text: 'serv1ce t1cket\n###\n', stage: 'read', batch: true, truthCustomer: null });
    else if (k === 'lowconf') { const d = add(paper('hard', c, { type: 'invoice', address: false, costConf: 0.55 })); d.link = c.id; }
    else if (k === 'nocost') { const d = add(paper('hard', c, { type: 'invoice', address: false, noCost: true })); d.link = c.id; }
    else if (k === 'future') { const d = add(paper('hard', c, { type: 'service-ticket', service: '2031-04-02' })); d.fields = d.fields.filter((f) => f.key !== 'service_date').concat([{ key: 'service_date_unconfirmed', value: '2031-04-02', conf: 0.9 }]); d.link = c.id; }
    else { const g = { name: bizName(), address: `${street()}, Tempe, AZ 85281` }; add(paper('hard', g, { type: 'work-order' })); }
  }

  // ---- traps: must never be linked, created, filed or changed
  for (let i = 0; i < nTrap; i++) {
    const k = i % 5;
    if (k === 0) add(paper('trap', { name: SHOP, address: '8953 W Timber Blvd, Mesa, AZ 85292' }, { type: 'work-order', truthCustomer: null }));            // our own company as "customer"
    else if (k === 1) add(paper('trap', { name: 'PROJECT LOCATION', address: street() }, { type: 'work-order', truthCustomer: null }));                   // a form label
    else if (k === 2) { const v = `${pick(BIZ_A)} Supply Co`; add(paper('trap', { name: v, address: street() }, { type: 'proposal-quote', truthCustomer: null, text: `${v}\n4400 E Industrial Way, Phoenix, AZ 85040\nPROPOSAL\nBILL TO\n${v}\nTotal $${money()}` })); } // the issuer billing itself
    else if (k === 3) add(paper('trap', { name: 'Walk-in', address: street() }, { type: 'proposal-quote', truthCustomer: null }));                      // a placeholder
    else { const c = existing[i % existing.length]; const d = add(paper('trap', c, { type: 'work-order', printedName: 'Someone Else', truthCustomer: null })); d.keepNoLink = true; }          // printed name disagrees with the page
  }
  for (let i = 0; i < nHr; i++) { const c = existing[(i * 3) % existing.length]; add({ kind: 'hr', name: `Offer letter ${i}.pdf`, type: 'hr-letter', fields: [{ key: 'customer_name', value: c.name, conf: 0.9 }], text: `${SHOP}\nOFFER OF EMPLOYMENT\nDear ${c.name},\nWe are pleased to offer you the position of Technician.\nSincerely, Owner`, stage: 'read', batch: true, truthCustomer: null }); }

  // ---- company papers (no customer needed)
  for (let i = 0; i < nCompany; i++) add(company('company'));

  // ---- the rest are clean: linked, complete, confident
  while (docs.length < N) { const c = existing[docs.length % existing.length]; const d = add(paper('clean', c, { stage: 'linked' })); d.link = c.id; }
  for (const d of docs) if (d.kind === 'clean') d.stage = 'linked';
  for (const d of docs) if (d.link && d.stage !== 'verified') d.stage = 'linked';
  return { shop: SHOP, existing, newGroups, docs, links, suggestions, truth, id };
}
