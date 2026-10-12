/**
 * verify:records-r12 - round 12 records-first lane: a decline or "nothing about X" is never built from filler words; the lane steps aside when it does not read the question;
 * ordinary words are never fuzzy-matched to people; private (HR) papers never reach a unit list, the inventory or a word check.
 *
 *   node scripts/verify-records-r12.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

// ---- pure pieces
const { isGlueWord, SHAPE_RE } = await import('../api/_lib/records/glueWords.js');
for (const w of ['dollars', 'days', 'during', 'random', 'located', 'whre', 'books', 'thx', 'back']) check(`glue word: ${w}`, isGlueWord(w));
for (const w of ['cfm', 'hoa', 'ductwork', 'mileage', 'markup', 'efficiency', 'refrigerant', 'Fitzgerald']) check(`not a glue word: ${w}`, !isGlueWord(w));
for (const q of ['list the estimates', 'what was the latest invoice', 'how many days since', 'share of invoices', 'second visit for him']) check(`shape: ${q}`, SHAPE_RE.test(q));
check('no shape in a plain ask', !SHAPE_RE.test('phone number for linda fitzgerald'));
const { normalizeText } = await import('../api/_lib/records/parse.js');
check('"invoice dated <date>" names the document', /invoice on 12\/3\/2021/.test(normalizeText("find Randy Hall's invoice dated 12/3/2021")), normalizeText("find Randy Hall's invoice dated 12/3/2021"));
check('"receipt from <full date>" names the day', /receipt on march 15, 2025|receipt on march 15 2025/.test(normalizeText('look up the receipt from March 15, 2025 for Daniel')), normalizeText('look up the receipt from March 15, 2025 for Daniel'));
check('"invoices from 2023" keeps its period', /invoices from 2023/.test(normalizeText('invoices from 2023')));
check('"co-1576 was done by who" asks who worked it', /who worked on/.test(normalizeText('change order CO-1576 was done by who')), normalizeText('change order CO-1576 was done by who'));
check('"whose change order is co-1624" asks the customer', /customer name for change order is co-1624/.test(normalizeText('whose change order is co-1624')), normalizeText('whose change order is co-1624'));

// ---- on a database
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
// a unit with linked papers: flip those papers to private HR letters and add two customers whose names are one letter from ordinary words
const equip = data.entities.find((e) => e.entity_type === 'equipment' && data.document_entity_links.some((l) => l.entity_id === e.id));
const flipped = new Set(data.document_entity_links.filter((l) => l.entity_id === equip.id).map((l) => l.document_id));
for (const d of data.documents) if (flipped.has(d.id)) d.document_type = 'hr-letter';
let cn = 90001; const mk = (name) => ({ ...JSON.parse(JSON.stringify(data.entities.find((e) => e.entity_type === 'customer'))), id: crypto.randomUUID(), customer_number: 'C-' + (cn++), data: { customer_name: name } });
data.entities.push(mk('Mary Daniels'), mk('Jack Brooks'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r12', tenantName: 'r12' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r12' };
const store = await import('../api/_lib/records/store.js');
const { loadInventory, clearInventoryCache } = await import('../api/_lib/records/orgMenu.js');
const { nameVerdict } = await import('../api/_lib/lookups/nameMatch.js');
clearInventoryCache();
await withTenant(ctxArg, async (db) => {
  const unitDocs = await store.docsForUnit(db, equip.id);
  check('docsForUnit leaves private papers out', !unitDocs.some((d) => flipped.has(d.document_id)), JSON.stringify(unitDocs.map((d) => d.document_type)));
  const inv = await loadInventory(db, {});
  check('inventory leaves private papers out', ![...(inv.docs instanceof Map ? inv.docs.keys() : inv.docs.map((d) => d.id))].some((k) => flipped.has(k)) && ![...(inv.lines?.keys?.() ?? [])].some((k) => flipped.has(k)));
  for (const w of ['many', 'back', 'books']) { const v = await nameVerdict(db, w); check(`"${w}" is not fuzzy-matched to a person`, v.deny === true, JSON.stringify(v.partial?.map((e) => e.name))); }
  const typo = await nameVerdict(db, 'Marry Daniels');
  check('a real misspelled name still resolves', !typo.deny, JSON.stringify(typo.asked));
});

// ---- asking
const { default: askHandler } = await import('../api/ask.js');
const { SCORECARD_CALL } = await import('../api/_lib/scorecard/hook.js');
const { createUsageMeter, runWithUsageMeter } = await import('../api/_lib/usage.js');
const auth = { tenantId: ctx.tenantKey, orgId: 'r12', userId: null };
async function ask(question) {
  const res = { statusCode: 200, headers: {}, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; }, end() { return res; } };
  const req = { method: 'POST', headers: {}, query: {}, body: { question, today: '2026-10-07' }, [SCORECARD_CALL]: { auth, escalate: false } };
  try { await runWithUsageMeter(createUsageMeter(), () => askHandler(req, res)); } catch { /* */ }
  return String(res.body?.data?.text ?? '');
}
const FILLER_DECLINE = /None of the stored fields is about|I don't have "(?:basic|quick|books|thx|boss|dollars|days|random|during|located|whre|second)"/;
for (const q of ['Quick one - everything on file for Linda Fitzgerald thx', 'Linda Fitzgerald basic info for the books', 'what was the most recent invoice of Linda Fitzgerald for 2009 in dollars', 'give me the second visit for Linda Fitzgerald', 'Linda Fitzgerald random thx boss']) {
  const t = await ask(q); check(`no filler-built decline: ${q}`, !FILLER_DECLINE.test(t), t);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
