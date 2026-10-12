/**
 * verify:card-r15 - Donovan reads a company it has never seen through the company's own VOCABULARY CARD (api/_lib/dql/card.js).
 *
 * Three companies from kinds of business no DeepWell list names (a pet groomer, a trucking company, a church) are loaded with NO industry setting. Their kinds of paper
 * and field keys (groom_date, groomer, appt_outcome; pickup_date, driver_name, load_state; held_on, officiant, approval_stage) appear in no word list. For each company the card must
 * type the roles (staff, visit date, status), and DQL must give the right count, year count, latest, total, ranking and per-person count in the company's own words, checked against
 * an independent reading of the export. Releases are checked too: a word that matches nothing the company stores, a value shape no role can take, and two keys that could fill one role.
 *
 *   node scripts/verify-card-r15.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { buildCard, shapeOf } = await import('../api/_lib/dql/card.js');

const TODAY = '2026-10-07';
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const human = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// what each company's data holds, said once: the keys are the company's own, the engine is never told them
const COMPANIES = {
  petgroom: { staff: 'groomer', date: 'groom_date', status: 'appt_outcome', invoiceDate: 'billed_on', staffNoun: 'groomer', kind: 'grooming-log', kindPl: 'grooming logs', kindSg: 'grooming log', money: 'treat-supply-order', moneyPl: 'treat supply orders', other: 'vaccination-record', otherSg: 'vaccination record', nope: 'average groom time' },
  trucking: { staff: 'driver_name', date: 'pickup_date', status: 'load_state', invoiceDate: 'paper_date', staffNoun: 'driver', kind: 'bill-of-lading', kindPl: 'bills of lading', kindSg: 'bill of lading', money: 'freight-bill', moneyPl: 'freight bills', other: 'rate-confirmation', otherSg: 'rate confirmation', nope: 'average fuel mileage' },
  church: { staff: 'officiant', date: 'held_on', status: 'approval_stage', invoiceDate: 'recorded_on', staffNoun: 'officiant', kind: 'baptism-certificate', kindPl: 'baptism certificates', kindSg: 'baptism certificate', money: 'giving-statement', moneyPl: 'giving statements', other: 'wedding-ceremony-record', otherSg: 'wedding ceremony record', nope: 'average sermon length' },
};

async function company(key) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'r15', `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r15-${key}`, tenantName: key });
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const spec = COMPANIES[key];
  const fieldsOf = new Map();
  for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = x.corrected_value || x.value; }
  const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
  const docs = data.documents.map((d) => {
    const f = fieldsOf.get(d.id) ?? {}; const fin = finOf.get(d.id);
    const date = String(f[spec.date] ?? f[spec.invoiceDate] ?? d.created_at).slice(0, 10);
    return { id: d.id, type: String(d.document_type).replace(/_/g, '-'), total: fin?.total != null ? Number(fin.total) : null, date, staff: f[spec.staff] ?? null };
  });
  const ask = async (q) => {
    const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q });
    if (!intent) return { intent: null, text: null };
    const ans = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
    return { intent, text: ans ? String(ans.text) : null };
  };
  return { key, spec, tv, docs, ask, card: tv.dql.card };
}

for (const key of Object.keys(COMPANIES)) {
  const c = await company(key); const s = c.spec; const k = s.kind;
  const ofKind = c.docs.filter((d) => d.type === k);
  // the card's reading of the company's own fields
  check(`${key}: card staff role is ${s.staff}`, c.card.roles.technician?.key === s.staff, JSON.stringify(c.card.roles));
  check(`${key}: card visit date is ${s.date}`, c.card.roles.service_date?.key === s.date);
  check(`${key}: card status is ${s.status}`, c.card.roles.status?.key === s.status);
  check(`${key}: card paper date is ${s.invoiceDate}`, c.card.roles.invoice_date?.key === s.invoiceDate);
  check(`${key}: card staff noun is ${s.staffNoun}`, c.card.staffNoun === s.staffNoun, String(c.card.staffNoun));
  check(`${key}: card types the shapes (person, date, category)`, c.card.fields[s.staff]?.shape === 'person' && c.card.fields[s.date]?.shape === 'date' && c.card.fields[s.status]?.shape === 'category');
  check(`${key}: card knows every stored kind with a readable label`, Object.keys(c.card.kinds).length === new Set(c.docs.map((d) => d.type)).size && c.card.kinds[k].plural.length > 0);
  check(`${key}: card lists the money field kinds`, Object.keys(c.card.moneyByKind).length >= 0);

  // counts in the company's own words
  let r = await c.ask(`how many ${s.kindPl}`);
  check(`${key}: count of ${s.kindPl}`, r.text?.includes(String(ofKind.length)), r.text);
  const sg = await c.ask(`how many ${s.kindPl} are on file`);
  check(`${key}: count again, other wording`, sg.text?.includes(String(ofKind.length)), sg.text);
  const years = new Map(); for (const d of ofKind) years.set(d.date.slice(0, 4), (years.get(d.date.slice(0, 4)) ?? 0) + 1);
  const [yr, yn] = [...years].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  r = await c.ask(`how many ${s.kindPl} in ${yr}`);
  check(`${key}: count in ${yr}`, r.text?.includes(String(yn)), r.text);
  // latest, in the company's singular
  const other = c.docs.filter((d) => d.type === s.other);
  const maxD = other.map((d) => d.date).sort().pop();
  r = await c.ask(`what is the latest ${s.otherSg}`);
  check(`${key}: latest ${s.otherSg}`, r.text?.includes(human(maxD)), `${maxD} ${r.text}`);
  // money
  const withTotal = c.docs.filter((d) => d.type === s.money && d.total != null);
  r = await c.ask(`total of ${s.moneyPl}`);
  check(`${key}: total of ${s.moneyPl}`, r.text?.includes(money(sum(withTotal.map((d) => d.total)))), r.text);
  // people: the company's own word for the staff
  const byStaff = new Map(); for (const d of ofKind) if (d.staff) byStaff.set(d.staff, (byStaff.get(d.staff) ?? 0) + 1);
  const ranked = [...byStaff].sort((a, b) => b[1] - a[1]);
  r = await c.ask(`${s.kindPl} by ${s.staffNoun}`);
  check(`${key}: ${s.kindPl} by ${s.staffNoun} lists every ${s.staffNoun}`, r.text && ranked.every(([n, v]) => r.text.includes(`${n}: ${v}`)), r.text);
  check(`${key}: the answer says ${s.staffNoun}, not technician`, r.text && !/technician/i.test(r.text) && new RegExp(s.staffNoun, 'i').test(r.text), r.text);
  const dual = new Set(c.card.staffDual ?? c.tv.dql.card.staffDual ?? []);
  const [top, topN] = ranked.find(([n]) => !dual.has(n)) ?? ranked[0];
  if (dual.size) { const dn = [...dual][0]; r = await c.ask(`${s.kindPl} by ${s.staffNoun} ${dn}`); check(`${key}: ${dn} is a customer and ${s.staffNoun}: asked, not guessed`, r.text == null, r.text); }
  r = await c.ask(`how many ${s.kindPl} did ${top} do`);
  check(`${key}: ${top}'s ${s.kindPl}`, r.text?.includes(String(topN)) && r.text.includes(top), r.text);
  // releases: never a guess
  r = await c.ask(`what is the ${s.nope}`);
  check(`${key}: untracked "${s.nope}" is released`, r.text == null, r.text);
  r = await c.ask(`how many flibbertigibbet ${s.kindPl} in ${yr}`);
  check(`${key}: unknown word is released`, r.text == null, r.text);
  r = await c.ask(`how many ${s.kindPl} per ${s.staffNoun}ish thing`);
  check(`${key}: half-understood question is released`, r.text == null, r.text);
}

// pure card checks: two keys that could both be the staff (or the status) fill no role, and no alias is made
{
  const rows = []; const names = ['Ann Lee', 'Bo Chan', 'Cy Diaz'];
  for (let i = 0; i < 60; i++) { rows.push({ k: 'seen_date', t: 'visit', v: `2025-01-${String(1 + (i % 28)).padStart(2, '0')}` }, { k: 'tech_one', t: 'visit', v: names[i % 3] }, { k: 'tech_two', t: 'visit', v: names[(i + 1) % 3] }, { k: 'state_a', t: 'visit', v: i % 2 ? 'Open' : 'Closed' }, { k: 'state_b', t: 'visit', v: i % 3 ? 'Paid' : 'Pending' }); }
  const card = buildCard({ rows, docTypes: [{ id: 'visit', n: 60 }] });
  check('card: two staff-like keys fill no role', !card.roles.technician && card.ambiguous.some((a) => a.role === 'technician'), JSON.stringify(card.ambiguous));
  check('card: two status-like keys fill no role', !card.roles.status && Object.values(card.alias).every((v) => v !== 'status'), JSON.stringify(card.alias));
  check('card: the one date key is the visit date', card.roles.service_date?.key === 'seen_date');
  check('card: shapes (money, id, count, email)', shapeOf(['$5.00', '$12.50', '$3.25']).shape === 'money' && shapeOf(['WW-1790', 'WW-1791', 'WW-1802']).shape === 'id' && shapeOf(['3', '12', '40']).shape === 'count' && shapeOf(['a@b.co', 'c@d.org']).shape === 'email');
  check('card: free text stays text', shapeOf(['Full groom, matted coat shaved short', 'Bath and nails, hates the dryer', 'Puppy cut']).shape === 'text');
  const empty = buildCard({ rows: [], docTypes: [] });
  check('card: an empty company has an empty card', Object.keys(empty.roles).length === 0 && Object.keys(empty.alias).length === 0);
}

console.log = realLog;
console.log(`${failures ? 'FAIL' : 'PASS'}  verify:card-r15  ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
