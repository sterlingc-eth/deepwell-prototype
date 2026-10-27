// Industry demo data builder (pure, deterministic). Turns ONE industry pack (v2loop/packs/<id>/pack.json, see
// packs/INDUSTRY_PACK_SPEC.md) into a small, fully synthetic demo workspace:
//   - records in the same export shape the Donovan reader reads (documents, pages, extractions, entities, links, financials)
//   - candidate suggested questions with gold answers computed from those records (checked against the real reader by the caller)
// Every company, person, street and city name comes from the invented lists below; phones are 555-01xx, e-mails are @example.com.
// Nothing here reads customer data, a database or the network.

export const DEMO_TODAY = '2026-10-20';

// ---- invented names (obviously fictional, never real customers) ----
export const PLACES = ['Lantern Bay', 'Thistle Creek', 'Pinecone Hollow', 'Bramblewood', 'Marigold Flats', 'Juniper Glen', 'Copperkettle', 'Fernsby Ridge', 'Willowmere', 'Sparrowgate', 'Pebbleworth', 'Quillback', 'Honeycomb Hill', 'Moonpenny', 'Starling Point', 'Larkspur Vale', 'Nettlefield', 'Tumbleby', 'Kettleby Springs', 'Zephyr Crossing'];
export const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Harper', 'Rowan', 'Sage', 'Emery', 'Parker', 'Reese', 'Skyler', 'Finley', 'Hayden', 'Dakota', 'Marlowe', 'Tatum', 'Ellis', 'Juniper', 'Wren', 'Arden', 'Blair', 'Remy'];
export const SURNAMES = ['Quillfeather', 'Thistledown', 'Bramblewood', 'Copperkettle', 'Puddleby', 'Wickerby', 'Fernsby', 'Pebbleworth', 'Bumblethorn', 'Juniperfield', 'Kettleby', 'Marbleworth', 'Nettlefield', 'Pippinwood', 'Rosethorn', 'Sparrowgate', 'Tumbleby', 'Willowmere', 'Zephyrton', 'Lanternby', 'Moonpenny', 'Honeyvale', 'Starlingford', 'Gingerbrook'];
export const STREETS = ['Lantern Ln', 'Pinecone Way', 'Fable Ct', 'Thimble St', 'Marigold Ave', 'Teacup Dr', 'Kite Rd', 'Puzzle Pl', 'Biscuit Blvd', 'Lullaby Ln', 'Sprocket St', 'Meadowlark Way'];
export const CITIES = [['Fableton', '85001'], ['Lantern Bay', '85002'], ['Maple Hollow', '85003']];
export const STATE = 'AZ';

export function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(f() * arr.length)];
  const shuffle = (arr) => { const x = arr.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  let n = 0; const uid = (tag) => { n++; const h = (hash32(tag + ':' + seed + ':' + n).toString(16).padStart(8, '0') + hash32('b' + n + tag + seed).toString(16).padStart(8, '0')); return `dea0${h.slice(0, 4)}-${h.slice(4, 8)}-4${h.slice(9, 12)}-a${h.slice(12, 15)}-${String(n).padStart(12, '0')}`; };
  return { f, int, pick, shuffle, uid };
}
const d2n = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
const n2d = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const mdy = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
const money2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
export const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addMonths = (s, m) => { const y = +s.slice(0, 4), mo = +s.slice(5, 7) - 1 + m; const d = new Date(Date.UTC(y + Math.floor(mo / 12), ((mo % 12) + 12) % 12, 1)); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); return n2d(Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(+s.slice(8, 10), dim)) / 86400000)); };
// ---- money: every amount is handled in whole cents (integers), so sums never drift, and every dollar amount is shown as $1,234.00
export const toC = (n) => Math.round(Number(n) * 100);
export const fromC = (c) => c / 100;
/** Canonical display of any dollar amount found in generated text: $5 -> $5.00, $2445 -> $2,445.00, $1,230 -> $1,230.00 */
export const normMoney = (t) => String(t).replace(/\$(\d[\d,]*)(?:\.(\d{1,2}))?(?![\d])/g, (m, a, b) => fmtMoney(Number(a.replace(/,/g, '')) + (b ? Number('0.' + b.padEnd(2, '0')) : 0)));
/** Documents that are bills (they get payment status, due date, aging and count in Billed / Collected / Open). The pack marks contracts, orders, claims
 *  and citations as "invoice" too (so the reader can read their totals); those are NOT bills and are not counted as billed. */
export const BILL_RE = /(^|-)invoice$|^guest-folio$|^draw-request$|^payment-request$|^superbill$|^banquet-event-order$|^catering-order-form$|^(rent|patient-balance|patient-ledger|client-account|family-account|charge-account|monthly-lab|monthly-billing)-statement$/;
export const PRICED_RE = /(estimate|quote|proposal|change-order)$/;
export const isBillable = (type, fin) => !!fin && fin[1] === 'receivable' && (fin[0] === 'invoice' || fin[0] === 'statement') && BILL_RE.test(type);
const isPriced = (type, fin) => !!fin && fin[1] === 'receivable' && fin[0] === 'estimate' && PRICED_RE.test(type);
const FAMILY_ITEMS = { trades_field_service: ['Labor', 'Parts and materials', 'Trip and disposal'], professional_office: ['Professional services', 'Expenses', 'Administrative fees'], food_goods_logistics: ['Goods and services', 'Delivery', 'Handling fees'] };
const ITEMS_DEFAULT = ['Services', 'Supplies and materials', 'Fees'];
/** Industries that charge sales tax on what they bill (invented rate); the rest bill without tax. */
export const TAXED = new Set(['auto', 'brewery', 'feedstore', 'foodtruck', 'restaurant', 'plumbing-hvac', 'electrical', 'general-contractor', 'roofing', 'landscaping', 'poolservice', 'pestcontrol', 'petgroomco', 'photostudio', 'warehouse', 'mfgqa']);
export const SALES_TAX_PER_MILLE = 86;     // 8.6%
export const LODGING_TAX_PER_MILLE = 105;  // 10.5%
const PAYTIME_TOPIC = /pay|due|term|net\b|late|overdue|interest|discount|credit|remit|balance|grace|invoice|billing/i;
const HAS_DAYS = /\b\d+\s*(?:business\s+)?days?\b|\bnet\s*\d+|\b\d+(?:st|nd|rd|th)\b|\b(?:15|30|45)\b/i;
const r5 = (c) => Math.round(c / 500) * 500;

export const hum = (t) => String(t).replace(/[_-]+/g, ' ');
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const pluralOf = (w) => (/[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /is$/.test(w) ? w.slice(0, -2) + 'es' : /(?:s|x|z|ch|sh)$/.test(w) ? w + 'es' : w + 's');
const CLRE = /\{([^{}]+)\}/g;
function fillClause(r, t, c) { return fillRaw(r, t, c).replace(/(\d+)% percent/g, '$1 percent'); }
function fillRaw(r, t, c) { return t.replace(CLRE, (m, k) => { if (k[0] === '=') { const v = c[k.slice(1)]; return v !== undefined ? String(v) : ''; } if (c[k] !== undefined) return c[k]; let mm; if ((mm = /^n:(\d+)-(\d+)$/.exec(k))) return String(r.int(+mm[1], +mm[2])); if ((mm = /^\$:(\d+)-(\d+)$/.exec(k))) return '$' + Math.max(5, Math.round(r.int(+mm[1], +mm[2]) / 5) * 5); if ((mm = /^pct:(\d+)-(\d+)$/.exec(k))) return r.int(+mm[1], +mm[2]) + '%'; if (k.includes('|')) return r.pick(k.split('|')); return m; }); }


/**
 * Works out every dollar figure of one paper from the paper's own numbers, in whole cents:
 *   - a paper with charges lists them as lines; the lines add up to the subtotal; subtotal + tax is the total (and the total is what every screen shows)
 *   - a money field that is part of the charges (admin fee, late fee, resort fee, prior balance...) IS one of the lines; one that is only a reference (deductible,
 *     deposit paid) is kept inside the total
 *   - amounts are written with cents, thousands separators and a $, the same way everywhere (money2 in the extractions, fmtMoney on screen)
 * Sets d.total, d.lines [{desc, amount}], d.subtotal, d.tax, d.taxRate, d.taxLabel, d.moneyKeys, d.billable, d.depositC.
 */
function reconcileMoney(d, ctx) {
  const e = d.ext, s = d.spec, { slug, rf, family } = ctx;
  d.moneyKeys = (d.t.fields ?? []).filter((f) => (f.t === 'money' || f.t === 'total') && !/_pct$/.test(f.k)).map((f) => f.k);
  if (s.extra === 'lease') d.moneyKeys.push('rent_amount', 'security_deposit');
  const val = (k) => (e[k] !== undefined && e[k] !== '' ? Number(e[k]) : null);
  const has = (k) => val(k) != null;
  let lines = null, taxC = 0, taxRate = null, taxLabel = null;
  const L = (desc, c) => (c !== 0 ? [desc, c] : null);
  if (d.total != null) {
    const baseC = toC(d.total);
    const priced = isPriced(d.type, s.fin), bill = ctx.billable;
    if (s.extra === 'lease' && has('rent_amount')) {
      const rent = val('rent_amount'); lines = [[`Rent (12 months at ${fmtMoney(rent)})`, toC(rent) * 12]];
    } else if (has('linehaul_rate') && has('fuel_surcharge')) {
      lines = [L('Linehaul rate', toC(val('linehaul_rate'))), L('Fuel surcharge', toC(val('fuel_surcharge')))];
    } else if (has('net_to_owner') && has('management_fee')) {
      lines = [L('Net paid to owner', toC(val('net_to_owner'))), L('Management fee', toC(val('management_fee')))];
    } else if (has('weekly_rate')) {
      const wk = val('weekly_rate'); const weeks = Math.max(1, Math.min(12, Math.round(d.total / wk))); lines = [[`Tuition (${weeks} ${weeks === 1 ? 'week' : 'weeks'} at ${fmtMoney(wk)})`, toC(wk) * weeks]];
    } else if (has('room_nights') && has('resort_fee') && has('lodging_tax')) {
      const n = Math.max(1, Math.round(val('room_nights'))); const rate = Math.max(55, r5(baseC / n) / 100); const roomC = toC(rate) * n; const resC = toC(val('resort_fee'));
      lines = [[`Room (${n} ${n === 1 ? 'night' : 'nights'} at ${fmtMoney(rate)})`, roomC], L('Resort fee', resC)];
      taxC = Math.round(((roomC + resC) * LODGING_TAX_PER_MILLE) / 1000); taxRate = LODGING_TAX_PER_MILLE / 1000; taxLabel = 'Lodging tax';
    } else if (has('nights') && d.type === 'reservation-confirmation') {
      const n = Math.max(1, Math.round(val('nights'))); const rate = Math.max(55, r5(baseC / n) / 100); const roomC = toC(rate) * n;
      lines = [[`Room (${n} ${n === 1 ? 'night' : 'nights'} at ${fmtMoney(rate)})`, roomC]];
      taxC = Math.round((roomC * LODGING_TAX_PER_MILLE) / 1000); taxRate = LODGING_TAX_PER_MILLE / 1000; taxLabel = 'Lodging tax';
    } else if (has('admin_fee') && has('lock_purchase')) {
      lines = [['Rent and other charges', baseC], L('Admin fee', toC(val('admin_fee'))), L('Lock purchase', toC(val('lock_purchase')))];
    } else if (has('late_fee_assessed')) {
      lines = [['Past-due balance', baseC], L('Late fee', toC(val('late_fee_assessed')))];
    } else if (has('prior_balance')) {
      lines = [L('Prior balance', toC(val('prior_balance'))), ['Current charges', baseC]];
    } else if (bill || priced) {
      const items = FAMILY_ITEMS[family] ?? ITEMS_DEFAULT; const parts = [];
      if (baseC >= 40000) { const three = baseC >= 200000; const sh = three ? [0.65 + rf.f() * 0.1, 0.08 + rf.f() * 0.07] : [0.75 + rf.f() * 0.15]; let left = baseC; for (const f of sh) { const c = Math.round((baseC * f) / 500) * 500; parts.push(c); left -= c; } parts.push(left); } else parts.push(baseC);
      lines = parts.map((c, i) => [items[i], c]);
    }
    if (lines) {
      lines = lines.filter(Boolean);
      if (taxRate == null && TAXED.has(slug) && (bill || priced) && !s.extra) { taxRate = SALES_TAX_PER_MILLE / 1000; taxLabel = 'Sales tax'; taxC = Math.round((lines.reduce((a, l) => a + l[1], 0) * SALES_TAX_PER_MILLE) / 1000); }
      const subC = lines.reduce((a, l) => a + l[1], 0);
      d.lines = lines.map(([desc, c]) => ({ desc, amount: fromC(c) })); d.subtotal = fromC(subC);
      d.tax = taxRate != null ? fromC(taxC) : null; d.taxRate = taxRate; d.taxLabel = taxLabel; d.total = fromC(subC + (taxRate != null ? taxC : 0));
    }
    // a lodging-tax field is the tax line itself
    if (taxLabel === 'Lodging tax' && has('lodging_tax')) e.lodging_tax = money2(d.tax);
    // reference amounts can never exceed what they are part of
    const totC = toC(d.total);
    if (has('deductible') && toC(val('deductible')) > Math.round(totC * 0.4)) e.deductible = Math.max(100, r5(Math.round(totC * 0.4)) / 100);
    if (has('deposit_paid') || has('deposit_requested')) {
      const k = has('deposit_paid') ? 'deposit_paid' : 'deposit_requested'; const depC = Math.max(500, r5(Math.round(totC * rf.pick([0.25, 0.3, 0.4, 0.5]))));
      e[k] = money2(fromC(Math.min(depC, Math.round(totC * 0.5)))); if (k === 'deposit_paid') d.depositC = toC(e[k]);
    }
    for (const k of d.moneyKeys) if (has(k) && !['rent_amount', 'security_deposit'].includes(k) && toC(val(k)) > totC) e[k] = money2(Math.max(5, r5(Math.round(totC * 0.4))) / 100);
  }
  for (const k of d.moneyKeys) if (has(k)) e[k] = money2(val(k));
  if (d.total != null) for (const f of d.t.fields ?? []) if (f.t === 'total') e[f.k] = money2(d.total);
  d.billable = !!ctx.billable && d.total != null;
}

/** Payment status of one bill, measured against DEMO_TODAY: paid, partly paid or open, the due date and the date the payment came in. */
function payFor(d, rf) {
  const today = d2n(DEMO_TODAY), age = today - d2n(d.date), totC = toC(d.total);
  let st = age > 120 ? 'paid' : age > 75 ? (rf.f() < 0.2 ? 'unpaid' : 'paid') : rf.pick(['paid', 'unpaid', 'partial']);   // nothing older than four months is left open
  const share = rf.pick([0.4, 0.5, 0.6]); const terms = rf.pick([15, 30, 30, 45]); const lag = rf.int(2, 40);
  let paidC = st === 'paid' ? totC : st === 'partial' ? Math.floor((totC * share) / 100) * 100 : 0;
  if (d.depositC != null && st !== 'paid') { paidC = Math.min(d.depositC, totC - 100); st = 'partial'; }
  if (paidC > 0 && paidC < totC) st = 'partial'; else if (paidC === 0) st = 'unpaid'; else st = 'paid';
  const paidOn = paidC > 0 ? n2d(d2n(d.date) + Math.min(lag, Math.max(0, age))) : null;
  return { status: st, paid: fromC(paidC), balance: fromC(totC - paidC), dueOn: n2d(d2n(d.date) + terms), paidOn };
}

/** A demo with bills should show at least one open and one overdue bill (that is what the product is for): if the draw produced none, the nearest fitting bill is left open. */
function ensureOpenAndOverdue(D) {
  const today = d2n(DEMO_TODAY); const bills = D.filter((d) => d.billable && d.pay);
  if (!bills.length) return;
  const overdue = (d) => d.pay.balance > 0 && d2n(d.pay.dueOn) < today;
  const leave = (d) => {
    const totC = toC(d.total); const paidC = d.depositC != null ? Math.min(d.depositC, totC - 100) : 0;   // a deposit already paid stays paid
    d.pay = { status: paidC > 0 ? 'partial' : 'unpaid', paid: fromC(paidC), balance: fromC(totC - paidC), dueOn: d.pay.dueOn, paidOn: paidC > 0 ? (d.pay.paidOn ?? d.date) : null };
  };
  if (!bills.some(overdue)) { const cand = bills.filter((d) => d2n(d.pay.dueOn) < today && today - d2n(d.date) <= 120).sort((a, b) => (a.date < b.date ? 1 : -1))[0]; if (cand) leave(cand); }
  if (!bills.some((d) => d.pay.balance > 0 && !overdue(d))) { const cand = bills.filter((d) => d2n(d.pay.dueOn) >= today).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? bills.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0]; if (cand && !overdue(cand)) leave(cand); }
}

/** Short, friendly industry label from a pack title ("Auto trades (independent repair shop...)" -> "Auto trades"). */
export function labelOf(pack) { return String(pack.title || pack.id).split(/[:(]/)[0].trim(); }

/**
 * Build one demo workspace.
 * spec: { slug, label, pack, variants: [variant names], seed? }
 */
export function buildWorkspace(spec) {
  const { slug, pack } = spec; const r = rng(hash32('demo:' + slug + ':' + (spec.seed ?? 1)));
  const vnames = spec.variants?.length ? spec.variants : [Object.keys(pack.variants)[0]];
  const V0 = pack.variants[vnames[0]];
  // document types: highest weight first across the chosen variants, restricted/personnel files never included
  const seenRole = new Set(); const all = [];
  for (const vn of vnames) for (const d of pack.variants[vn].doc_types) { if (seenRole.has(d.role) || d.standard?.hr) continue; seenRole.add(d.role); all.push({ ...d, variant: vn }); }
  const fin = all.filter((d) => d.standard?.fin && d.standard?.num && d.standard?.cust).sort((a, b) => b.weight - a.weight);
  const rest = all.filter((d) => !fin.includes(d)).sort((a, b) => b.weight - a.weight);
  const types = [...fin.slice(0, 3), ...rest.filter((d) => d.standard?.cust).slice(0, 4)].slice(0, 7);
  for (const d of rest) if (types.length < 6 && !types.includes(d)) types.push(d);
  const place = PLACES[hash32(slug) % PLACES.length];
  const company = `${place} ${r.pick(V0.name_suffixes)}`;
  const custNoun = V0.customer_noun || 'customer'; const staffNoun = V0.staff_noun || 'team member';
  // field name aliases: index 0 (index 3 is the training loop's reserved exam wording and is never used here)
  const fk = {}; for (const [k, e] of Object.entries(pack.field_names?.standard ?? {})) fk[k] = e.aliases?.[0] ?? k;
  const F = (k) => fk[k] ?? k;
  const rf = rng(hash32('demo-fin:' + slug + ':' + (spec.seed ?? 1)));   // all money decisions come from this stream, so the people, dates and wording stay exactly as before
  const family = pack.team_family ?? 'other';
  // people
  const usedN = new Set(); const person = () => { for (;;) { const n = `${r.pick(FIRST)} ${r.pick(SURNAMES)}`; if (!usedN.has(n) && !usedN.has(n.split(' ')[1])) { usedN.add(n); usedN.add(n.split(' ')[1]); return n; } } };
  const staff = [person(), person(), person()];
  const orgSuffix = pack.entities?.customer?.orgs?.[1] ?? ['Holdings LLC'];
  const custs = [];
  const nInd = 6, nOrg = 2;
  for (let i = 0; i < nInd + nOrg; i++) {
    const org = i >= nInd; const name = org ? `${PLACES[(hash32(slug) + 3 + i * 5) % PLACES.length]} ${r.pick(orgSuffix)}` : person();
    const cy = CITIES[i % CITIES.length]; const unit = custNoun === 'tenant' || custNoun === 'resident' ? `, Unit ${r.int(1, 9)}${r.pick(['A', 'B', 'C'])}` : '';
    const addr = `${r.int(100, 989)} ${STREETS[(i * 7 + hash32(slug)) % STREETS.length]}${unit}, ${cy[0]}, ${STATE} ${cy[1]}`;
    const em = org ? `office@${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 18)}.example.com` : `${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}@example.com`;
    custs.push({ id: r.uid('cust'), num: `C-${String(i + 1).padStart(5, '0')}`, name, org, addr, phone: `(480) 555-01${String(10 + i).padStart(2, '0')}`, email: em });
  }
  // documents: about 22, spread over the last 18 months, the first customer is the "regular" with several papers of one kind
  const D = []; const lo = d2n('2025-05-01'), hi = d2n('2026-10-10');
  const plan = []; types.forEach((t, i) => { const n = i < 3 ? 4 : 2; for (let k = 0; k < n; k++) plan.push(t); });
  const planS = r.shuffle(plan);
  planS.forEach((t, i) => {
    const date = n2d(lo + Math.floor(((hi - lo) * (i + r.f())) / planS.length));
    const nth = planS.slice(0, i).filter((x) => x === t).length;
    const cust = t.standard?.cust ? (t === types[0] && nth < 2 ? custs[0] : t === types[1] && nth < 2 ? custs[1] : custs[2 + ((i * 3 + r.int(0, 2)) % (custs.length - 2))]) : null;
    D.push({ id: r.uid('doc'), t, spec: t.standard ?? {}, type: t.names[0], date, cust, ext: {}, total: null, num: null, moneyKeys: [], lines: null, subtotal: null, tax: null, taxRate: null, taxLabel: null, billable: false, pay: null });
  });
  D.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const counters = {}; const T = pack.texts ?? {}; const bank = {}; for (const c of pack.clause_banks ?? []) if (c.bank === 'v1') (bank[c.role] ??= []).push(c);
  for (const d of D) {
    const s = d.spec, e = d.ext; const tag = (k, v) => { if (v != null && v !== '') e[k] = String(v); };
    const finDated = s.fin && ['invoice', 'estimate', 'receipt', 'statement', 'po', 'change_order'].includes(s.fin[0]);
    if (s.visit) tag('service_date', d.date); else if (finDated) tag('invoice_date', d.date);
    if (s.num) { counters[d.type] = (counters[d.type] ?? 1040 + r.int(0, 30)) + r.int(1, 3); d.num = (s.pre ?? 'NO-') + (s.num === 'permit_number' ? d.date.slice(0, 4) + '-' : '') + counters[d.type]; tag(s.num, d.num); }
    if (s.vendor) tag('vendor_name', `${PLACES[(hash32(slug + d.type) % PLACES.length)]} Supply Co`);
    if (s.tech) tag('technician', staff[r.int(0, staff.length - 1)]);
    if (s.status) tag('status', s.status[r.int(0, Math.min(2, s.status.length - 1))]);
    if (s.work && T.work?.[s.work]) tag('work_performed', r.pick(T.work[s.work]));
    if (s.svctype) tag('service_type', r.pick(s.svctype));
    if (s.notes && T.notes?.[s.notes]) tag('notes', r.pick(T.notes[s.notes]));
    if (s.extra === 'lease') { const t = 12; const end = addMonths(d.date, t); const rent = Math.round(r.int(s.amt?.[0] ?? 900, s.amt?.[1] ?? 2400) / 25) * 25; tag('lease_start_date', d.date); tag('lease_end_date', end); tag('agreement_term', `${mdy(d.date)} - ${mdy(end)}`); tag('rent_amount', rent); tag('security_deposit', rent); d.total = rent * t; d.endsOn = end; }
    if (s.extra === 'agreement') { const t = r.pick([12, 12, 24]); const end = addMonths(d.date, t); tag('agreement_term', `${mdy(d.date)} - ${mdy(end)}`); d.endsOn = end; }
    if (s.extra === 'coi') { const end = addMonths(d.date, 12); tag('coi_expires', end); d.endsOn = end; }
    if (s.extra === 'warranty') { tag('warranty_registered_date', d.date); tag('warranty_term', r.pick(['1 year', '5 years', '10 years'])); }
    if (s.fin && d.total == null) { const [a, b] = s.amt ?? [100, 5000]; const v = s.pts?.length && r.f() < 0.3 ? r.pick(s.pts) : a + (b - a) * Math.pow(r.f(), 2.2); d.total = Math.max(5, Math.round(v / 5) * 5); }
    for (const x of d.t.fields ?? []) {
      if (x.t === 'enum') tag(x.k, r.pick(x.v)); else if (x.t === 'int') tag(x.k, r.int(x.lo, x.hi)); else if (x.t === 'money') tag(x.k, Math.round(r.int(x.lo, x.hi) / 5) * 5);
      else if (x.t === 'date+') tag(x.k, n2d(d2n(d.date) + r.int(x.lo, x.hi))); else if (x.t === 'total' && d.total != null) tag(x.k, d.total);
    }
    // Money: from here every amount on the paper is worked out from the paper's own numbers (lines add to the subtotal, subtotal plus tax is the total).
    reconcileMoney(d, { slug, rf, family, billable: isBillable(d.type, d.spec.fin) && !!V0.pay_status });
    if (d.billable) d.pay = payFor(d, rf);
    // page text, laid out the way the reader expects (same order as the training generator)
    const title = d.type.replace(/-/g, ' ').toUpperCase(); const c = d.cust;
    const head = [company, title, c ? `${cap(custNoun)}: ${c.name}` : e.vendor_name ? `Vendor: ${e.vendor_name}` : '', d.num ? `Document no: ${d.num}` : '', `Date: ${mdy(d.date)}`, e.technician ? `${cap(staffNoun)}: ${e.technician}` : '', e.status ? `Status: ${e.status}` : ''].filter(Boolean);
    const xl = []; for (const x of d.t.fields ?? []) { const v = e[x.k]; if (v === undefined) continue; xl.push(`${cap(hum(x.k))}: ${d.moneyKeys.includes(x.k) ? fmtMoney(v) : v}`); }
    const body = []; const w = e.work_performed ?? e.notes; if (w) body.push(w); if (e.work_performed && e.notes) body.push('Note: ' + e.notes);
    const cx = { cust: c ? c.name : '', date: mdy(d.date), num: d.num ?? '', total: d.total != null ? fmtMoney(d.total) : '', tech: e.technician ?? '', vendor: e.vendor_name ?? '', term: e.agreement_term ?? '', ...Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v])) };
    const topics = r.shuffle(bank[d.t.role] ?? []).slice(0, Math.min((bank[d.t.role] ?? []).length, r.int(2, 3)));
    // A paper that carries money (a total or a money field) states no other lump-sum dollar figure in its terms, so no clause can contradict its own numbers
    // (a policy clause such as "a $135 fee" on a $120 invoice). The draws from r are made exactly as before; only the wording that is kept changes.
    // A bill states its own due date (below), so no clause on it may give a different payment deadline.
    const moneyDoc = d.total != null || d.moneyKeys.length > 0;
    const hasDeposit = d.ext.deposit_paid !== undefined || d.ext.deposit_requested !== undefined;
    const clashes = (txt) => (moneyDoc && /\$/.test(txt)) || (d.billable && PAYTIME_TOPIC.test(t0) && HAS_DAYS.test(txt))
      || (d.taxRate != null && /tax/i.test(txt) && /%/.test(txt)) || (hasDeposit && /%/.test(txt) && /deposit|retainer|date|book|reserv|paid|pay|due/i.test(txt));   // a percentage that would contradict the paper's own tax or deposit
    let t0 = '';
    d.clauses = topics.map((t) => {
      t0 = t.topic;
      const text = fillClause(r, t.variants[r.int(0, 2)], cx);
      if (!moneyDoc) return { topic: t.topic, text: normMoney(text), paraphrases: t.paraphrases };
      if (!clashes(text)) return { topic: t.topic, text, paraphrases: t.paraphrases };
      const alt = rng(hash32('alt:' + d.id + t.topic));
      for (const v of t.variants) { const x = fillClause(alt, v, cx); if (!clashes(x)) return { topic: t.topic, text: x, paraphrases: t.paraphrases }; }
      return null;
    }).filter(Boolean);
    const p1 = [...head, ...xl, '', ...body], p2 = [];
    const twoPage = d.clauses.length >= 3 || (s.pages === 2 && d.clauses.length >= 2);
    d.clauses.forEach((t, i) => { if (twoPage && i > 0) { p2.push(t.text); t.page = 2; } else { p1.push(t.text); t.page = 1; } });
    if (d.lines) { if (p1[p1.length - 1] !== '') p1.push(''); p1.push('Charges'); for (const l of d.lines) p1.push(`${l.desc}: ${fmtMoney(l.amount)}`); if (d.tax != null) { p1.push(`Subtotal: ${fmtMoney(d.subtotal)}`); p1.push(`${d.taxLabel} (${(d.taxRate * 100).toFixed(1)}%): ${fmtMoney(d.tax)}`); } }
    if (d.pay) p1.push(`Payment terms: net ${d2n(d.pay.dueOn) - d2n(d.date)} days. Due date: ${mdy(d.pay.dueOn)}`);
    if (d.total != null) p1.push(`TOTAL: ${fmtMoney(d.total)}`);
    if (p2.length) { p2.unshift(`${company} - ${title} - page 2`, 'Terms and conditions'); p2.push('', c ? `Signed: ${c.name}   Date: ${mdy(d.date)}` : 'Authorized signature on file'); }
    d.pages = [p1.join('\n'), ...(p2.length ? [p2.join('\n')] : [])];
    // payment status of a bill: paid, partly paid or open, with the dates the paper and the dashboard both use (everything is measured against DEMO_TODAY)
    if (s.fin?.[0] === 'invoice' && V0.pay_status && d.total != null && d2n(DEMO_TODAY) - d2n(d.date) <= 75) r.pick(['paid', 'unpaid', 'partial']);   // keeps the people, dates and wording drawn after this paper exactly as before
  }
  ensureOpenAndOverdue(D);
  // ---- export rows (reader format)
  const exported = DEMO_TODAY + 'T12:00:00.000Z'; const rows = { documents: [], pages: [], extractions: [], entities: [], document_entity_links: [], facets: [], audit_log: [], financials: [], financial_lines: [] };
  D.forEach((d, i) => {
    const at = d.date + 'T12:00:00Z';
    rows.documents.push({ id: d.id, batch_id: null, original_filename: `${String(i + 1).padStart(2, '0')}-${d.type}${d.num ? '-' + d.num.toLowerCase() : ''}.pdf`, document_type: d.type, sha256_hash: (hash32(d.id).toString(16).padStart(8, '0')).repeat(8), file_size_bytes: 900 + d.pages.join('').length, stage: 'linked', created_at: at, processed_at: at });
    d.pages.forEach((text, k) => rows.pages.push({ id: r.uid('pg'), document_id: d.id, page_no: k + 1, text, created_at: at }));
    for (const [k, v] of Object.entries(d.ext)) rows.extractions.push({ id: r.uid('ex'), document_id: d.id, entity_id: null, field_key: F(k), value: v, confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: at });
    if (d.cust) rows.document_entity_links.push({ id: r.uid('ln'), document_id: d.id, entity_id: d.cust.id, confidence: 0.9, linked_by: 'demo', created_at: exported });
    if (d.spec.fin) { const [kind, dir] = d.spec.fin; rows.financials.push({ id: r.uid('fn'), document_id: d.id, doc_kind: kind, direction: dir, currency: 'USD', invoice_number: d.ext.invoice_number ?? null, po_number: d.ext.po_number ?? null, invoice_date: d.spec.visit ? null : d.date, due_date: d.pay ? d.pay.dueOn : null, period_start: null, period_end: null, agreement_term: d.ext.agreement_term ?? null, subtotal: d.subtotal == null ? null : money2(d.subtotal), tax: d.tax == null ? null : money2(d.tax), total: d.total == null ? null : money2(d.total), amount_paid: d.pay ? money2(d.pay.paid) : null, balance_due: d.pay ? money2(d.pay.balance) : null, status: d.pay?.status ?? 'unknown', customer_name: d.cust?.name ?? null, vendor_name: d.ext.vendor_name ?? null, confidence: 0.9, flags: [], evidence: {}, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: 'demo', extracted_at: at, created_at: at, job_key: null, job_key_source: null, job_confidence: 0, job_raw: null }); }
  });
  for (const c of custs) rows.entities.push({ id: c.id, entity_type: 'customer', merged_into: null, customer_number: c.num, data: { customer_name: c.name, service_address: c.addr, phone: c.phone, email: c.email }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  const records = { industry: slug, tenantKey: 'demo-' + slug, tenantName: company, exportedAt: exported, ...rows, truncated: false };
  return { slug, company, custNoun, staffNoun, staff, custs, docs: D, types, records, fieldKey: F };
}

/** Candidate suggested questions, each with its gold computed from the workspace records. Each intent offers several options (different
 *  papers, customers, phrasings); the caller keeps the first option the reader answers correctly. */
export function candidateQuestions(ws) {
  const out = []; const D = ws.docs; const lab = (d) => hum(d.type); const year = '2026'; const used = new Set();
  const finDocs = D.filter((d) => d.num && d.total != null);
  const add = (intent, label, options) => { if (options.length) out.push({ intent, label, options }); };
  // 1. total on a numbered paper (invoice first)
  add('total', 'Look up a total', [...finDocs.filter((d) => d.spec.fin?.[0] === 'invoice'), ...finDocs.filter((d) => d.spec.fin?.[0] !== 'invoice')].slice(0, 3).map((d) => ({ gold: { kind: 'money', value: d.total, docs: [d.id] }, phrasings: [`What's the total on ${d.num}?`, `How much is ${d.num}?`] })));
  // 2. a stored detail on a paper (pack field)
  add('field', 'Find a detail', D.filter((d) => d.num).flatMap((d) => (d.t.fields ?? []).filter((x) => d.ext[x.k] !== undefined && x.t !== 'total' && x.t !== 'date+').map((x) => ({ gold: { kind: x.t === 'money' ? 'money' : 'text', value: x.t === 'money' ? Number(d.ext[x.k]) : d.ext[x.k], docs: [d.id] }, phrasings: [`${hum(x.k).split(' ').some((w) => /[^su]s$/.test(w)) ? 'What are' : 'What is'} the ${hum(x.k)} on ${d.num}?`, `What's the ${hum(x.k)} on ${d.num}?`, `what does ${d.num} list as the ${hum(x.k)}`] }))).slice(0, 4));
  // 3. sum across one customer's papers of one kind
  const byCT = new Map(); for (const d of finDocs) { if (!d.cust) continue; const k = d.cust.name + '|' + d.type; (byCT.get(k) ?? byCT.set(k, []).get(k)).push(d); }
  add('sum', 'Add up a customer', [...byCT.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length).slice(0, 3).map((g) => { const c = g[0].cust.name, p = pluralOf(lab(g[0])); return { customer: c, gold: { kind: 'money', value: g.reduce((s, d) => s + d.total, 0), docs: g.map((d) => d.id) }, phrasings: [`How much in total across ${c}'s ${p}?`, `What do ${c}'s ${p} come to in total?`] }; }));
  // 4. count of one kind this year
  add('count', 'Count records', [...new Set(D.map((d) => d.type))].map((t) => [t, D.filter((d) => d.type === t && d.date.startsWith(year))]).filter(([, a]) => a.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 3).map(([t, a]) => { const p = pluralOf(hum(t)); return { gold: { kind: 'count', value: a.length, docs: a.map((d) => d.id) }, phrasings: [`How many ${p} were created in ${year}?`, `how many ${p} in ${year}`] }; }));
  // 5. latest paper of one kind for one person (also the base of the "did you mean" example)
  const byC = new Map(); for (const d of D) { if (!d.cust || d.cust.org) continue; const k = d.cust.name + '|' + d.type; (byC.get(k) ?? byC.set(k, []).get(k)).push(d); }
  add('latest', 'Find the latest', [...byC.values()].sort((a, b) => b.length - a.length).slice(0, 4).map((g) => { const last = g.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0]; const c = last.cust.name; return { customer: c, gold: { kind: 'date', value: last.date, docs: [last.id] }, phrasings: [`When was ${c}'s latest ${lab(last)}?`, `${c}'s latest ${lab(last)} is dated when`] }; }));
  // 6. what a paper says about a clause topic
  add('clause', 'Read the fine print', D.filter((d) => d.num && d.clauses?.length).flatMap((d) => d.clauses.map((cl) => ({ gold: { kind: 'clause', value: cl.text, docs: [d.id], page: cl.page }, phrasings: [`What does ${d.num} say about ${cl.topic}?`, `tell me the ${cl.topic} terms in ${d.num}`, `pull the ${cl.topic} wording from ${d.num}`, `${d.num} ${cl.topic} details`] }))).slice(0, 6));
  // 7. who is at an address
  add('who_addr', 'Who is at an address', ws.custs.filter((c) => D.some((d) => d.cust === c) && !c.org).slice(1, 4).map((c) => ({ customer: c.name, gold: { kind: 'text', value: c.name, docs: [] }, phrasings: [`Who is the ${ws.custNoun} at ${c.addr}?`, `who lives at ${c.addr}`] })));
  return out;
}

/** A one-letter-swap misspelling of a surname, used for the "did you mean" example ("Quillfaether"). */
export function misspell(name) { const [f, ...rest] = name.split(' '); const l = rest.join(' '); const i = Math.max(2, Math.floor(l.length / 2)); const a = l.split(''); [a[i], a[i + 1]] = [a[i + 1], a[i]]; const t = a.join(''); return `${f} ${t === l ? l + 'e' : t}`; }

/** Does the reader's text carry the gold answer? */
export function goldMatches(gold, text, docs) {
  const t = String(text ?? '');
  const docOk = !gold.docs?.length || gold.docs.every((id) => (docs ?? []).includes(id)) || (gold.kind === 'count' && (docs ?? []).length === 0);
  if (gold.kind === 'money') return t.includes(fmtMoney(gold.value)) && (gold.docs.length > 1 || docOk);
  if (gold.kind === 'count') return new RegExp(`(^|\\D)${gold.value} `).test(t);
  if (gold.kind === 'date') return t.includes(gold.value) && docOk;
  if (gold.kind === 'clause') return t.includes(gold.value) && docOk;
  return t.toLowerCase().includes(String(gold.value).toLowerCase()) && docOk;
}

/** Presentation of the reader's text (same as the app's reader hook: correct plurals) plus trade acronyms in capitals. */
export const ACRO = [['Hvac', 'HVAC'], ['hvac', 'HVAC'], ['Coi', 'COI'], [' coi', ' COI'], ['Hoa', 'HOA'], [' hoa', ' HOA'], ['Ev ', 'EV '], [' po ', ' PO '], ['Po ', 'PO ']];
export const acro = (t) => { for (const [a, b] of ACRO) t = t.split(a).join(b); return t; };
export const polish = (text, types) => { let t = String(text); for (const type of types) { const base = hum(type); const wrong = base + 's', right = pluralOf(base); if (wrong !== right) t = t.split(wrong).join(right).split(cap(wrong)).join(cap(right)); } return acro(t); };
