/**
 * Selfcheck for the property fixtures + the deterministic property reader (Build 2, stage 2D part A).
 * Fixture checks: determinism, size, unique names, every truth value really is on its page. Extractor checks: against the
 * TRUTH written from the generator's specs (never from the extractor): NO wrong value, no value the truth does not have,
 * wrong-type documents read as nothing, clean documents must be read. Unreadable / messy parts may be missing.
 *   node scripts/lib/property-fixtures.selfcheck.mjs [--verbose]
 */
import assert from 'node:assert/strict';
import { buildDocs, truth, TODAY, long, us, addDays } from './property-fixtures.mjs';
import { extractProperty, missingRequired } from '../../api/_lib/industry/property/extract.js';
import propertyPack from '../../api/_lib/industry/packs/property.js';

const verbose = process.argv.includes('--verbose');
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) { fails++; console.log(`FAIL ${name} ${detail}`); } };

const d1 = buildDocs(); const d2 = buildDocs();
assert.deepEqual(d1, d2, 'buildDocs is not deterministic');
check('at least 40 docs', d1.length >= 40, String(d1.length));
check('unique filenames', new Set(d1.map((d) => d.filename)).size === d1.length);

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const norm = (s) => String(s).toLowerCase().replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${+d}-${MON[m - 1].slice(0, 3)}-${y}`; };
const us2 = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y.slice(2)}`; };
const onPage = (page, v, key) => {
  const t = norm(page); const raw = page.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return raw.includes(v) || raw.includes(us(v)) || raw.includes(long(v).toLowerCase()) || raw.includes(us2(v)) || raw.includes(dmy(v).toLowerCase());
  if (typeof v === 'number') return t.includes(money(v).toLowerCase());
  if (key === 'service_address') return String(v).split(',').every((c) => t.includes(norm(c)));
  return t.includes(norm(v));
};
const SKIP_GROUND = new Set(['coverage_type', 'rent_roll_row', 'auto_renew']);
const DATE_KEYS = new Set(['coi_expires', 'policy_expiry', 'lease_start_date', 'lease_end_date', 'contract_start', 'contract_end', 'invoice_date', 'invoice_due', 'service_date', 'opened_date', 'completed_date', 'reinspection_due']);
const MONEY_KEYS = new Set(['cost', 'rent_amount', 'security_deposit', 'monthly_amount', 'gl_limit']);
const MULTI = new Set(['work_performed', 'coverage_type', 'deficiency', 'policy_expiry', 'rent_roll_row']);

for (const d of d1) {
  check(`${d.filename} wrong-type docs carry no fields`, !d.truth.wrongType || Object.keys(d.truth.fields).length === 0);
  for (const [k, f] of Object.entries(d.truth.fields)) {
    if (SKIP_GROUND.has(k)) continue;
    if (MULTI.has(k)) { for (const v of f.value) check(`${d.filename} ${k} item on a page`, d.pages.some((p) => onPage(p.text, v, k)), String(v)); continue; }
    check(`${d.filename} ${k} on page ${f.page}`, !!d.pages[f.page - 1] && onPage(d.pages[f.page - 1].text, f.value, k), JSON.stringify(f.value));
  }
}

// ---- the extractor against the truth
const sameVal = (key, got, want) => {
  if (MONEY_KEYS.has(key)) return Number(got) === Number(want);
  if (DATE_KEYS.has(key)) return got === want;
  return norm(got) === norm(want);
};
const stats = { docs: d1.length, read: 0, nullOk: 0, fieldsOk: 0, wrong: 0, missingMust: 0, gateAccepted: 0, gateTotalReadable: 0 };
const typeCount = {};
for (const d of d1) {
  const t = d.truth;
  const r = extractProperty(d.pages, { today: TODAY });
  if (t.wrongType || t.mustBeNull) { if (r) { stats.wrong++; check(`${d.filename} wrong-type must read as nothing`, false, `${r.type} ${JSON.stringify(r.fields.map((f) => f.key))}`); } else stats.nullOk++; continue; }
  if (!r) { if (t.mustRead) { stats.missingMust++; check(`${d.filename} must be read`, false, 'null'); } continue; }
  stats.read++; typeCount[r.type] = (typeCount[r.type] ?? 0) + 1;
  if (r.type !== t.type) { stats.wrong++; check(`${d.filename} type`, false, `${r.type} != ${t.type}`); continue; }
  const gate = r.confidence >= 0.9 && r.fields.length >= 3 && missingRequired(r.type, r.fields, propertyPack).length === 0;
  if (t.mustRead) { stats.gateTotalReadable++; if (gate) stats.gateAccepted++; }
  const got = new Map();
  for (const f of r.fields) { if (!got.has(f.key)) got.set(f.key, []); got.get(f.key).push(f); }
  for (const [k, fs] of got) {
    const want = t.fields[k];
    if (!want && k === 'rent_roll_unread') continue; // meta field: how many rent roll rows were skipped
    if (!want) { stats.wrong++; check(`${d.filename} unexpected field ${k}`, false, JSON.stringify(fs.map((f) => f.value))); continue; }
    if (MULTI.has(k)) {
      const wantSet = new Set(want.value.map(norm));
      for (const f of fs) { const ok = wantSet.has(norm(f.value)) || (DATE_KEYS.has(k) && want.value.includes(f.value)); if (ok) stats.fieldsOk++; else { stats.wrong++; check(`${d.filename} ${k} value`, false, `${f.value} not in ${JSON.stringify(want.value)}`); } }
      const missing = want.value.filter((w) => !fs.some((f) => norm(f.value) === norm(w) || f.value === w));
      if (missing.length && t.mustRead && !t.optional.includes(k) && !t.partial.includes(k)) check(`${d.filename} ${k} missing items`, false, JSON.stringify(missing));
      continue;
    }
    if (fs.length > 1) { stats.wrong++; check(`${d.filename} ${k} returned twice`, false); continue; }
    const f = fs[0];
    if (!sameVal(k, f.value, want.value)) { stats.wrong++; check(`${d.filename} ${k}`, false, `got ${JSON.stringify(f.value)} want ${JSON.stringify(want.value)}`); continue; }
    if (f.page_no !== want.page) check(`${d.filename} ${k} page`, false, `got ${f.page_no} want ${want.page}`);
    check(`${d.filename} ${k} has verbatim`, !!f.verbatim);
    stats.fieldsOk++;
  }
  if (t.mustRead) for (const k of Object.keys(t.fields)) if (!got.has(k) && !t.optional.includes(k)) { stats.missingMust++; check(`${d.filename} missing field ${k}`, false, JSON.stringify(t.fields[k].value)); }
  if (verbose) console.log(`${d.filename}: ${r.type} ${r.fields.length} fields gate=${gate}`);
}
const T = truth();
console.log(`TODAY ${TODAY}; docs ${d1.length}:`, JSON.stringify(T.byType));
console.log(`extractor: ${JSON.stringify(stats)}; read by type ${JSON.stringify(typeCount)}`);
console.log(`cois: current ${T.cois.length}, expired ${T.coisExpired().length}, today ${T.coisExpiringToday().length}, within30 ${T.coisExpiringWithin(30).length}, within60 ${T.coisExpiringWithin(60).length}; leases expired ${T.leasesExpired().length}, within60 ${T.leasesExpiringWithin(60).length}; contracts ended ${T.contractsEnded().length}, within60 ${T.contractsEndingWithin(60).length}; invoices past due ${T.invoicesPastDue().length}; reinspections overdue ${T.reinspectionsOverdue().length}`);
check('no wrong values', stats.wrong === 0, String(stats.wrong));
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log('selfcheck OK');
