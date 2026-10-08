/**
 * R35 (owner decisions 2026-10-01): nicknames resolve, serial lookups are deterministic, "still under warranty" = not expired,
 * mistyped city/zip never blocks (visible note), short answers.
 *
 * No network, no model, no DATABASE_URL: PGlite + the golden tenant (A) + a second tenant (B) built from it with renamed serials
 * and a few hand-added hard-negative records (two customers a nickname can mean, "Will Smith" next to "William Smith", a serial
 * shared by two units, a serial printed only on a document). Every ask goes through the REAL api/ask.js handler (API-key auth).
 *   1. pure tables: nickname policy (positives and must-not-fire negatives), serial parsing / normalization, warranty wording
 *   2. golden tenant: nickname answers, serial answers (every typed form), warranty counts (37 / 33 / 4 / 79), short answers
 *   3. tenant B: ambiguous nickname -> "Did you mean", exact name wins over a nickname, serial collision listed, document-only
 *      serial, live records (a unit added after the first ask is found on the next), tenant isolation of serials
 *   2e/2f. the R35 learning loops (warranty wording, document numbers, judgment / false premise / unknown person, partial serials)
 *      and blue-collar brevity (list sentences, short declines)
 *   4. the seven frozen R35 blind sets (gen-blind-r35.mjs + gen-blind-r35b.mjs): wrong 0 and correct floors
 *   node scripts/verify-r35-donovan.mjs          (package.json: verify:r35-donovan)
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p);
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`);
};

process.env.TZ = 'America/Phoenix';
process.env.RATE_LIMIT_ASK_PER_MINUTE = '100000';
process.env.NEON_CONNECTION_STRING = process.env.NEON_CONNECTION_STRING || 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"t"'))) return; realLog(...a); };
console.error = () => {};
console.warn = () => {};
const TODAY = '2026-09-25';

const NK = await import(rel('api/_lib/vocab/nicknames.js'));
const SL = await import(rel('api/_lib/lookups/serialLookup.js'));
const AN = await import(rel('api/_lib/analytics.js'));
const AG = await import(rel('api/_lib/lookups/aggregates.js'));
const FR = await import(rel('api/_lib/router/frame.js'));

/* ============================================================================ 1. pure tables */
console.log('\n-- 1a. nickname policy (pure)');
const vocab = {
  customers: { phrases: ['Thomas Mercer', 'Laura Mercer', 'Betty Winslow', 'Amanda Quinley', 'William Rios', 'George Garrison', 'William Garrison', 'Will Smith', 'William Smith', 'Christopher Lee', 'Christina Lee', 'Daniel Keller', 'Thomas Hale', 'Thomas Hale ', 'Tommy Hale', 'Pat Ortega', 'Robert Mercado'] },
  technicians: { phrases: ['Danny Ochoa', 'Ray Sutton', 'Tom Vance'] },
};
const rw = (q) => NK.resolveNicknameInQuestion(q, vocab);
const res = (q) => rw(q)?.note?.resolved ?? null;
check('Tom Mercer -> Thomas Mercer', res('phone for Tom Mercer') === 'Thomas Mercer', JSON.stringify(rw('phone for Tom Mercer')));
check('lowercase + possessive: tom mercer\'s email -> Thomas Mercer\'s email', rw("tom mercer's email")?.question === "Thomas Mercer's email");
check('formal typed, nickname stored: Elizabeth Winslow -> Betty Winslow', res('email for Elizabeth Winslow') === 'Betty Winslow');
check('Bill Smith -> William Smith (Will Smith is a different person; Bill->Will is nickname-to-nickname)', res('phone for bill smith') === 'William Smith');
check('Will Smith exists exactly: never rewritten', rw('phone for will smith') === null);
check('nickname-to-nickname never assumed: Beth Winslow stays', rw('phone for Beth Winslow') === null);
check('Amy is a real name, not Amanda: Amy Quinley stays', rw('phone for Amy Quinley') === null);
check('ambiguous: Chris Lee (Christopher Lee, Christina Lee) stays', rw('phone for Chris Lee') === null);
check('two Thomas Hales: Tom Hale stays', rw('phone for Tom Hale') === null);
check('word-like nickname after a question word: "when will Garrison call" stays', rw('when will Garrison call') === null);
check('word-like nickname as the first word ("Will Garrison need a unit?") stays', rw('Will Garrison need a unit?') === null);
check('word-like nickname where a name stands: "phone for Will Garrison" -> William Garrison', res('phone for Will Garrison') === 'William Garrison');
check('"did Bill Rios pay" -> William Rios', res('what did Bill Rios pay') === 'William Rios');
check('quoted means as typed', rw('phone for "Tom Mercer"') === null);
check('surname typo via the typo rules: Tom Merser -> Thomas Mercer', res('phone for Tom Merser') === 'Thomas Mercer');
check('surname typo whose formal form is nobody on file never resolves (Rob Mercar: no Robert Mercer)', rw('phone for Rob Mercar') === null, JSON.stringify(rw('phone for Rob Mercar')));
check('technician in a work question: jobs by Raymond Sutton -> Ray Sutton', res('how many jobs did Raymond Sutton do') === 'Ray Sutton');
check('technician never resolved for contact details: phone for Raymond Sutton stays', rw('phone for Raymond Sutton') === null);
check('a technician and a customer with the same nickname form are not merged: Thomas Vance (tech Tom Vance) only in a work question', res('jobs done by Thomas Vance') === 'Tom Vance' && rw('email for Thomas Vance') === null);
check('Pat stored: Patricia/Patrick Ortega typed -> Pat Ortega (formal typed, nickname stored)', res('phone for Patricia Ortega') === 'Pat Ortega');
check('kill switch DONOVAN_NICKNAMES=0', (() => { process.env.DONOVAN_NICKNAMES = '0'; const r = rw('phone for Tom Mercer'); delete process.env.DONOVAN_NICKNAMES; return r === null; })());
check(`nickname table holds a few hundred entries (${NK.NICKNAME_TABLE_SIZE})`, NK.NICKNAME_TABLE_SIZE >= 300);
check('Hispanic diminutives: Pepe->José/Jose, Paco->Francisco, Lupe->Guadalupe', NK.isNicknamePair('pepe', 'jose') && NK.isNicknamePair('paco', 'francisco') && NK.isNicknamePair('lupe', 'guadalupe'));
check('frame stripper keeps a surname ending in "ok" (Holbrook)', FR.stripConversationalFrame('phone for Dan Holbrook') === null && FR.stripConversationalFrame('phone for X ok') === 'phone for X');

console.log('\n-- 1b. serial parsing / normalization (pure)');
const ps = (q) => SL.parseSerialQuestion(q);
const pcase = [
  ['what unit is serial Y100007', 'Y100007', 'unit'], ['model for serial F100002', 'F100002', 'model'], ['who has serial 2c100003', '2c100003', 'who'],
  ["where's S/N LX100005", 'LX100005', 'where'], ['sn 4N2119-08772', '4N2119-08772', 'unit'], ['serial Y 100103?', 'Y 100103', 'unit'],
  ['ser no 2R100006 - whose unit', '2R100006', 'who'], ['serial# 2c100003 make?', '2c100003', 'brand'], ['when was serial D100056 last serviced', 'D100056', 'service'],
  ['is s/n F100058 covered', 'F100058', 'warranty'], ['install date on sn M100017', 'M100017', 'install'], ['the serial number is 2C100011', '2C100011', 'unit'],
  ['is Y100007 under warranty', 'Y100007', 'warranty'],
];
for (const [q, s, f] of pcase) { const p = ps(q); check(`parse "${q}" -> ${s} (${f})`, p?.serial === s && p?.focus === f, JSON.stringify(p)); }
for (const q of ["what's the serial on Michael Sandoval's unit", 'serial number for Thomas Mercer', 'serial for model 4TTR4002L1000AA', "what's the model and serial at 285 E Elliot Rd", 'call C-00001', 'invoice INV-10023 total', 'what refrigerant is R-410A', 'how many units do we have', 'serial killer documentary']) {
  check(`no serial claim: "${q}"`, !ps(q) || ps(q).anchored === false, JSON.stringify(ps(q)));
}
check('canon: case, dashes, spaces, O->0, I->1', SL.canonSerial('lx-1OOO05') === SL.canonSerial('LX100005') && SL.canonSerial('2RI00046') === SL.canonSerial('2R100046') && SL.canonSerial('Y 100 103') === 'Y100103');

console.log('\n-- 1c. warranty wording (pure)');
check('"still under warranty" -> covered (not expired)', AN.warrantyStatusFromQuestion('how many units are still under warranty') === 'covered');
check('"active warranty" -> covered', AN.warrantyStatusFromQuestion('customers with an active warranty') === 'covered');
check('"more than a year left on warranty" -> active (strict bucket)', AN.warrantyStatusFromQuestion('units with more than a year left on warranty') === 'active');
check('"expired" stays expired; "expiring soon" stays expiring', AN.warrantyStatusFromQuestion('units with an expired warranty') === 'expired' && AN.warrantyStatusFromQuestion('units with warranties expiring soon') === 'expiring');
check('"not under warranty" stays ambiguous (never guessed)', AN.warrantyStatusFromQuestion('units not under warranty') === null);
check('covered filter = active OR expiring', AN.matchesFilter({ warrantyStatus: 'expiring' }, { field: 'warrantyStatus', op: 'eq', value: 'covered' }) && AN.matchesFilter({ warrantyStatus: 'active' }, { field: 'warrantyStatus', op: 'eq', value: 'covered' }) && !AN.matchesFilter({ warrantyStatus: 'expired' }, { field: 'warrantyStatus', op: 'eq', value: 'covered' }));
const ag = (q) => AG.parseAggregate(q);
check('agg: still under warranty -> active state', ag('how many units are still under warranty')?.state === 'active');
check('agg: over 12 months left -> over-year', ag('how many units have over 12 months of warranty left')?.state === 'over-year');
check('agg: expire within a year -> within-year', ag('how many warranties expire within a year')?.state === 'within-year');
check('agg: "haven\'t expired" -> active (not inverted)', ag("how many units have warranties that haven't expired")?.state === 'active');
check('agg: customers count', ag('how many customers have a unit still under warranty')?.customers === true);
check('agg: a time window is a different question ("expired so far this year")', ag('how many units warranty has expired so far this year') === null);

/* ============================================================================ 2/3. through the real handler */
const OE = await import(rel('scripts/offline-exam.mjs'));
const exportData = JSON.parse(fs.readFileSync(rel('scripts/golden/golden-export.json'), 'utf8'));
function buildB() {
  const d = JSON.parse(JSON.stringify(exportData));
  let str = JSON.stringify(d);
  const map = new Map();
  str = str.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => { if (!map.has(m)) map.set(m, crypto.randomUUID()); return map.get(m); });
  for (const sn of new Set(d.entities.filter((e) => e.entity_type === 'equipment').map((e) => e.data.serial_number).filter(Boolean))) str = str.split(`"${sn}"`).join(`"B${sn}"`).split(`Serial: ${sn}`).join(`Serial: B${sn}`).split(`Serial ${sn}`).join(`Serial B${sn}`);
  str = str.replace(/"sha256_hash":"[0-9a-f]{64}"/g, () => `"sha256_hash":"${crypto.randomBytes(32).toString('hex')}"`);
  const b = JSON.parse(str);
  const now = '2026-01-01T00:00:00Z';
  const cust = (name) => ({ id: crypto.randomUUID(), entity_type: 'customer', merged_into: null, customer_number: null, data: { customer_name: name, service_address: `${100 + b.entities.length} W Test Rd, Mesa, AZ 85201`, phone: `(480) 555-9${String(b.entities.length).padStart(3, '0')}` }, created_at: now, updated_at: now });
  const extra = ['Christopher Lee', 'Christina Lee', 'Will Smith', 'William Smith'].map(cust);
  b.entities.push(...extra);
  // a serial shared by two units (data-entry collision)
  const owners = b.entities.filter((e) => e.entity_type === 'customer').slice(0, 2);
  for (const o of owners) b.entities.push({ id: crypto.randomUUID(), entity_type: 'equipment', merged_into: null, customer_id: o.id, data: { serial_number: 'DUP-7781', model: 'TEST-M1', manufacturer: 'Trane' }, created_at: now, updated_at: now });
  // a serial printed only on a document (no unit record)
  const doc = b.documents[0];
  b.extractions.push({ id: crypto.randomUUID(), document_id: doc.id, entity_id: null, field_key: 'serial_number', value: 'DOC-55120', confidence: 0.9, source_facet_id: null, schema_version: 1, created_at: now });
  return { b, extra };
}
await OE.installPgHarness();
const counter = await OE.installModelBlock();
const lite = await OE.createPGlite();
await OE.setActiveDatabase(lite);
const { b: dataB } = buildB();
const { ctx: ctxA } = await OE.loadExportIntoNewTenant(lite, exportData, { tenantKey: 'tenantA', tenantName: 'Tenant A' });
await OE.loadExportIntoNewTenant(lite, dataB, { tenantKey: 'tenantB', tenantName: 'Tenant B' });
const { generateKey } = await import(rel('api/_lib/apiKeyAuth.js'));
const keys = {};
const tenantIds = {};
for (const tk of ['tenantA', 'tenantB']) {
  const { rows } = await lite.query('SELECT id FROM tenants WHERE clerk_org_id=$1', [tk]);
  tenantIds[tk] = rows[0].id;
  const g = generateKey();
  await lite.query("UPDATE tenants SET plan='fleet', billing_status='active' WHERE id=$1", [rows[0].id]);
  await lite.query("INSERT INTO api_keys (tenant_id,name,key_prefix,key_hash,scopes) VALUES ($1,'k',$2,$3,ARRAY['read','ingest','ask'])", [rows[0].id, g.keyPrefix, g.keyHash]);
  keys[tk] = g.rawKey;
}
try { (await import(rel('api/_lib/recordsStore.js')))._resetTenantContextCache(); (await import(rel('api/_lib/plan.js')))._resetBillingRowCache(); } catch { /* optional */ }
const { default: handler } = await import(rel('api/ask.js'));
function mkRes() { const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[k.toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[k.toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; }, write() { return true; } }; return res; }
async function ask(tenant, question) {
  const req = { method: 'POST', headers: { authorization: `Bearer ${keys[tenant]}` }, query: {}, body: { question, today: TODAY } };
  const res = mkRes();
  const before = counter.n;
  try { await handler(req, res); } catch (e) { return { text: `THREW ${e}`, model: 0, data: null }; }
  const d = res.body?.data;
  return { data: d, text: d?.text ?? '', model: counter.n - before, cites: (d?.citations?.records ?? d?.records ?? []).length };
}

console.log('\n-- 2a. nicknames (golden tenant)');
let r = await ask('tenantA', 'phone for Tom Mercer');
check('Tom Mercer: visible note + Thomas Mercer\'s phone, one short sentence', /^Showing results for Thomas Mercer \(you typed "Tom Mercer"\)\. Thomas Mercer's phone is 480-555-0111\.$/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'is Becca Montoya\'s unit still under warranty');
check('Becca Montoya -> Rebecca Montoya, warranty status', /^Showing results for Rebecca Montoya/.test(r.text) && /expired/.test(r.text), r.text);
r = await ask('tenantA', 'email for elizabeth zimmerman');
check('Elizabeth Zimmerman -> Betty Zimmerman (stored nickname)', /^Showing results for Betty Zimmerman/.test(r.text) && /betty\.zimmerman4@aol\.com/.test(r.text), r.text);
r = await ask('tenantA', 'phone for Bob Mercer');
check('Bob Mercer (no Robert Mercer): honest decline naming the Mercers, no phone', /^I couldn't find "bob mercer" as asked\. Did you mean Thomas Mercer, Laura Mercer\?$/.test(r.text) && !/\d{3}-\d{4}/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'phone for Amy Quinley');
check('Amy Quinley (Amy is a real name): never Amanda Quinley\'s phone', !/555-0158/.test(r.text) && /Did you mean/.test(r.text), r.text);
r = await ask('tenantA', 'phone for Dan Holbrook');
check('Dan Holbrook: Holbrook kept whole (frame fix), honest decline', /dan holbrook/.test(r.text) && /Maria Holbrook/.test(r.text) && !/555-0178/.test(r.text), r.text);
r = await ask('tenantA', 'phone for "Tom Mercer"');
check('quoted "Tom Mercer" is never rewritten', !/Showing results for Thomas Mercer/.test(r.text), r.text);
r = await ask('tenantA', 'when was tom mercer last serviced');
check('"when was <nickname> last serviced" answers deterministically', /^Showing results for Thomas Mercer/.test(r.text) && /Nov 5, 2017/.test(r.text) && r.model === 0, r.text);

console.log('\n-- 2b. serial lookups (golden tenant)');
r = await ask('tenantA', 'what unit is serial Y100007');
check('what unit is serial Y100007: unit, customer, address, install, warranty, last service, cited', /York YXV026BF31TAA/.test(r.text) && /David Prentiss/.test(r.text) && /285 E Elliot Rd/.test(r.text) && /February 18, 2026/.test(r.text) && /no warranty end date on file/.test(r.text) && /last serviced September 21, 2026/.test(r.text) && r.cites >= 2 && r.model === 0, r.text);
for (const [q, want] of [['model for serial F100002', /Trane 4TTR4002L1000AA/], ['who has serial 2c100003', /belongs to Thomas Mercer/], ["where's S/N LX100005", /211 E University Dr/], ['sn lx-1OOOO5', /LX100005/], ['serial 2RI00006 whose', /2R100006 belongs to/], ['serial Y 100007?', /David Prentiss/], ['is serial F100002 still under warranty', /^No — serial F100002 .*expired January 1, 2019/], ['when was serial Y100007 last serviced', /last serviced September 21, 2026/], ['is Y100007 under warranty', /no warranty end date on file/]]) {
  r = await ask('tenantA', q);
  check(`"${q}"`, want.test(r.text) && r.model === 0 && r.cites >= 1, r.text);
}
r = await ask('tenantA', 'sn 4N2119-08772');
check('not on file: "No unit with serial 4N2119-08772 on file."', r.text === 'No unit with serial 4N2119-08772 on file.' && r.model === 0 && r.data?.kind === 'no-answer', r.text);
r = await ask('tenantA', 'sn Y100070');
check('near miss: closest serial(s) within one edit named', /^No unit with serial Y100070 on file\. Closest serial on file: Y100007/.test(r.text), r.text);
r = await ask('tenantA', 'serial 4TTR4002L1000AA');
check('a model number typed as a serial is called out', /is a model number on file \(4 units\), not a serial/.test(r.text), r.text);
r = await ask('tenantA', "what's the serial on Thomas Mercer's unit");
check('forward "what\'s the serial on X\'s unit" still answered (2C100003)', /2C100003/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'whose unit has serial Y100007');
check('exam shape h001 still answered with the customer', /David Prentiss/.test(r.text), r.text);

console.log('\n-- 2c. "still under warranty" counts (golden tenant, today 2026-09-25)');
for (const [q, re] of [
  ['how many units are still under warranty', /^37 units are still under warranty — 4 of them run out in the next 12 months\./],
  ['how many units have more than a year left on warranty', /^33 units have more than a year of warranty left/],
  ['how many warranties expire within a year', /^4 units have warranties running out in the next 12 months/],
  ['how many units are out of warranty', /^79 units are out of warranty/],
  ['how many trane units are still under warranty', /^5 Trane units are still under warranty/],
  ['how many customers have a unit still under warranty', /^35 customers have a unit still under warranty/],
  ['how many active warranties do we have', /^37 units are still under warranty/],
  ["how many units have warranties that haven't expired", /^37 units/],
]) { r = await ask('tenantA', q); check(`"${q}"`, re.test(r.text) && r.model === 0 && r.cites > 0, r.text); }
r = await ask('tenantA', 'How many customers with a Trane or Carrier unit have an active warranty?');
check('"active warranty" in a multi-hop count = not expired (11)', /\b11 customers\b/.test(r.text), r.text);
r = await ask('tenantA', 'Patricia Esparza warranty still good?');
check('per-customer: still covered + "expiring within 12 months" qualifier', /active, under warranty until May 9, 2027 \(expiring within 12 months\)/.test(r.text), r.text);

console.log('\n-- 2d. short answers + city/zip note');
r = await ask('tenantA', 'address for linda fitzgerald');
check('contact field: one sentence, the field asked for only', r.text === "Linda Fitzgerald's address is 100 E Main St, Phoenix, AZ 85001." && (r.data?.facts ?? []).length === 1, r.text);
r = await ask('tenantA', 'is the unit at 100 E Main St still under warranty');
check('single-unit address warranty: fact first, match basis trailing', /^No — warranty expired January 1, 2019 \(computed\) — the only unit on file for 100 E Main St \(Linda Fitzgerald\)\.$/.test(r.text), r.text);
r = await ask('tenantA', 'what brand is the unit at 137 W Southern Ave, Mesa');
check('mistyped city never blocks: answered with a short visible note', /Carrier/.test(r.text) && /\(Note: on file in Phoenix, not Mesa\.\)$/.test(r.text), r.text);
r = await ask('tenantA', 'is the unit at 137 W Southern Ave, Mesa still under warranty');
check('mistyped city before "still under warranty": answered + the same short note', /expired/.test(r.text) && /\(Note: on file in Phoenix, not Mesa\.\)$/.test(r.text), r.text);
r = await ask('tenantA', 'is the unit at 100 E Main St, Mesa, AZ 85201 still under warranty');
check('mistyped city AND zip: one short note naming both', /\(Note: on file in Phoenix 85001, not Mesa 85201\.\)$/.test(r.text), r.text);
r = await ask('tenantA', 'what brand is the unit at 137 W Southern Ave, Phoenix');
check('right city typed: no note', !/Note:/.test(r.text) && /Carrier/.test(r.text), r.text);

console.log('\n-- 2e. R35 learning loops: warranty wording, document numbers, judgment / false premise / unknown person, partial serials');
for (const [q, re] of [
  ['how many units are covered', /^37 units are still under warranty/], ['how many units are warrantied', /^37 units are still under warranty/],
  ['how many carrier units are warrantied', /^6 Carrier units are still under warranty/], ['how many warranties are expiring soon', /^4 units have warranties running out/],
  ['how many units have no warranty on file', /^16 units have no warranty end date on file \(of 132\)\./], ["how many units don't have a warranty end date on file", /^16 units/],
]) { r = await ask('tenantA', q); check(`warranty wording: "${q}"`, re.test(r.text) && r.model === 0 && r.cites > 0, r.text); }
r = await ask('tenantA', 'how many units are covered by a maintenance agreement');
check('"covered by a maintenance agreement" is never answered as the warranty count (37) or every unit (132)', !/\b(?:37|132)\b/.test(r.text), r.text);
const DN = await import(rel('api/_lib/lookups/docNumberLookup.js'));
check('docnum parse: "invoice INV-20003" / "how much was PO-9004" / "invoice #20003" / "permit BP-2026-10001"', DN.parseDocNumberQuestion('invoice INV-20003')?.typed === 'INV-20003' && DN.parseDocNumberQuestion('how much was PO-9004')?.focus === 'total' && DN.parseDocNumberQuestion('invoice #20003')?.digitsOnly === true && DN.parseDocNumberQuestion('permit BP-2026-10001')?.kind === 'permit');
for (const q of ['how many invoices in 2024', 'invoices over $500', 'invoice for Linda Fitzgerald', 'total invoiced in 2025', 'what is serial INV-20003', 'compare INV-20003 and INV-20004', 'permit 2026']) check(`docnum never claims "${q}"`, DN.parseDocNumberQuestion(q) === null, JSON.stringify(DN.parseDocNumberQuestion(q)));
r = await ask('tenantA', 'invoice INV-20000');
check('invoice INV-20000: customer, total, date, cited, $0', /^Invoice INV-20000: Linda Fitzgerald, \$2,800\.00, January 1, 2009\.$/.test(r.text) && r.cites >= 1 && r.model === 0, r.text);
r = await ask('tenantA', 'how much was invoice INV-20000');
check('how much was INV-20000 -> "Invoice INV-20000 was $2,800.00 (Linda Fitzgerald)."', r.text === 'Invoice INV-20000 was $2,800.00 (Linda Fitzgerald).', r.text);
r = await ask('tenantA', 'who is work order WO-40000 for');
check('work order WO-40000 -> its customer', /^Work order WO-40000 is for Linda Fitzgerald/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'invoice #60005');
check('"invoice #60005" (INV-60005 and WO-60005 both on file) -> the invoice, not the work order', /^Invoice INV-60005/.test(r.text), r.text);
r = await ask('tenantA', 'how much was invoice INV-29999');
check('not on file: "No invoice INV-29999 on file." (no-answer, $0)', r.text === 'No invoice INV-29999 on file.' && r.data?.kind === 'no-answer' && r.model === 0, r.text);
const SG = await import(rel('api/_lib/router/safetyGate.js'));
for (const q of ['should we fire Danny Ochoa', "what's the best AC brand", 'what should I charge for a capacitor', 'is Linda Fitzgerald a good customer', 'is Trane better than Carrier', 'quick one - should I raise my prices', 'which brand should I recommend to customers']) check(`judgment: "${q}"`, SG.isJudgmentQuestion(q));
for (const q of ['should we service Linda Fitzgerald soon', 'is the unit at 100 E Main St worth repairing', 'how many units should be replaced', 'did we do better than last year', 'which brand do we install the most', 'who is our best customer', 'what did we charge Linda Fitzgerald', 'should I replace the unit at 100 E Main St']) check(`judgment never fires: "${q}"`, !SG.isJudgmentQuestion(q));
r = await ask('tenantA', 'should we fire Danny Ochoa');
check('judgment decline is one short line at $0', /^That's a judgment call/.test(r.text) && r.text.length < 110 && r.model === 0 && r.data?.kind === 'no-answer', r.text);
r = await ask('tenantA', 'why did Danny Ochoa replace the compressor at 100 E Main St');
check('false premise: no compressor work on file for 100 E Main St ($0)', /^No compressor work is on file for 100 E Main St/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'why did we replace the capacitor at 248 W Guadalupe Rd');
check('false premise never fires when a document there mentions the part', !/^No capacitor work/.test(r.text), r.text);
r = await ask('tenantA', 'who is Zaphod Beeblebrox');
check('unknown person: "who is X" declined at $0, short', /^I don't have anyone named "Zaphod Beeblebrox" on file or in any document/.test(r.text) && r.model === 0, r.text);
for (const q of ['whos our busiest technician', 'who is Linda Fitzgerald', 'who is Danny Ochoa']) { r = await ask('tenantA', q); check(`"${q}" is never the unknown-person decline`, !/I don't have anyone named/.test(r.text), r.text); }
r = await ask('tenantA', 'who is Ernest Holbrook');
check('"who is Ernest Holbrook" (a real surname, unknown first name) never answers with Maria Holbrook\'s details', !/555-0178|Maria Holbrook —/.test(r.text), r.text);
r = await ask('tenantA', 'who has serial 100091');
check('partial serial (unique): answered with the visible note', /^Showing results for serial 2C100091 \(you typed "100091"\)\. Serial 2C100091 belongs to Edward Esparza/.test(r.text) && r.model === 0, r.text);
r = await ask('tenantA', 'who has serial "100091"');
check('partial serial typed in quotes = exactly as typed (the "Not what you meant?" escape)', /^No unit with serial 100091 on file/.test(r.text), r.text);
r = await ask('tenantA', 'serial ending in 10012');
check('ambiguous partial: listed, none picked (no-answer)', /^More than one serial on file contains 10012/.test(r.text) && r.data?.kind === 'no-answer', r.text);
r = await ask('tenantA', 'sn 1000');
check('a fragment under 5 characters is never widened', !/Showing results for serial/.test(r.text), r.text);

for (const [q, who] of [['phone for Danny Ochoa', 'Danny Ochoa'], ['phone for Dan Ochoa', 'Danny Ochoa'], ['address for Raymond Sutton', 'Ray Sutton']]) {
  r = await ask('tenantA', q);
  check(`technician contact: "${q}" -> honest "${who} is one of your technicians" at $0`, r.text.startsWith(`${who} is one of your technicians`) && r.data?.kind === 'no-answer' && r.model === 0, r.text);
}

console.log('\n-- 2e+. adversarial-pass regressions');
r = await ask('tenantA', 'invoice 100 E Main St');
check('"invoice 100 E Main St" is an address, never invoice #100', !/invoice 100 on file/i.test(r.text), r.text);
check('"est 2026" is never an estimate number', DN.parseDocNumberQuestion('whats the est 2026 revenue') === null);
r = await ask('tenantA', 'how many units are not warrantied');
check('"not warrantied" is the expired bucket (79), never the 37 still covered', /^79 units are out of warranty/.test(r.text), r.text);
r = await ask('tenantA', 'how many units are covered by warranty but not registered');
check('"covered by warranty but not registered" is never answered as the bare warranty count', !/\b37\b/.test(r.text), r.text);
r = await ask('tenantA', '2026 revenue');
check('"2026 revenue" is 2026 only, never the all-time total', /in 2026/.test(r.text) && !/572,212/.test(r.text), r.text);
r = await ask('tenantA', 'is invoice INV-20000 paid');
check('"is invoice X paid" with no payment status printed: honest no-answer naming that', r.data?.kind === 'no-answer' && /no payment status on file/.test(r.text), r.text);
for (const q of ['is 4 E Main St still under warranty', 'how many 4 ton units do we have', 'top 4 customers by revenue']) check(`shorthand never turns a number into "for": "${q}"`, (await import(rel('api/_lib/router/rewrite.js'))).rewriteShorthand(q) === q);

console.log('\n-- 2f. brevity');
const BR = await import(rel('api/_lib/router/brevity.js'));
const names = ['Amy Larkin', 'Barbara Ellison', 'Betty Zimmerman', 'Charles Whitford', 'David Prentiss', 'James Underhill', 'Jessica Bennett', 'Joseph Ortega', 'Karen Abernathy'];
const listAns = () => ({ kind: 'answer', text: `9 customers were serviced this month: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`, facts: names.map((n) => ({ label: 'Customer', value: n })) });
let la = listAns(); BR.capInlineNameList(la);
check('list sentence keeps 5 names + "and 4 more" when every name is a fact row', la.text === '9 customers were serviced this month: Amy Larkin, Barbara Ellison, Betty Zimmerman, Charles Whitford, David Prentiss, and 4 more.', la.text);
la = listAns(); la.facts = la.facts.slice(0, 8); BR.capInlineNameList(la);
check('never shortened when a listed name is not among the facts', la.text === listAns().text, la.text);
la = listAns(); process.env.DONOVAN_BREVITY = '0'; BR.capInlineNameList(la); delete process.env.DONOVAN_BREVITY;
check('kill switch DONOVAN_BREVITY=0', la.text === listAns().text);
const CL = await import(rel('api/_lib/contactLookup.js'));
const ED = await import(rel('api/_lib/router/earlyDecline.js'));
check('off-domain / untracked / dangling declines are one short line (< 100 chars each)', [CL.buildOutOfDomainAnswer(), CL.buildUntrackedFieldAnswer(), ED.buildDanglingAnswer()].every((a) => a.kind === 'no-answer' && a.text.length < 100), [CL.buildOutOfDomainAnswer(), CL.buildUntrackedFieldAnswer(), ED.buildDanglingAnswer()].map((a) => a.text).join(' | '));

console.log('\n-- 3. tenant B: hard negatives, collisions, live records, isolation');
r = await ask('tenantB', 'phone for Chris Lee');
check('ambiguous nickname: one-tap "Did you mean" naming both, no phone', /^I couldn't find "chris lee" as asked\. Did you mean (?:Christopher Lee, Christina Lee|Christina Lee, Christopher Lee)\?$/.test(r.text) && !/555-9/.test(r.text), r.text);
r = await ask('tenantB', 'phone for Will Smith');
check('exact "Will Smith" wins over William Smith', /^Will Smith's phone is/.test(r.text) && !/Showing results/.test(r.text), r.text);
r = await ask('tenantB', 'phone for Bill Smith');
check('Bill Smith -> William Smith (not Will Smith)', /^Showing results for William Smith/.test(r.text), r.text);
r = await ask('tenantB', 'who has serial DUP-7781');
check('serial collision: both units listed, never one picked', /^2 units on file share serial DUP-7781/.test(r.text), r.text);
r = await ask('tenantB', 'sn DOC55120');
check('serial printed only on a document: reported from that document', /^Serial DOC-55120 appears on a document/.test(r.text) && r.cites >= 1, r.text);
r = await ask('tenantB', 'what unit is serial Y100007');
check('isolation: tenant A\'s serial Y100007 is never answered in tenant B (B\'s own BY100007 may be offered as a partial, visibly)', !/Serial Y100007\b/.test(r.text) && (/^No unit with serial Y100007 on file\./.test(r.text) || /^Showing results for serial BY100007 \(you typed "Y100007"\)/.test(r.text)), r.text);
r = await ask('tenantA', 'what unit is serial BY100007');
check('isolation: tenant B\'s serial is not on file in tenant A', /^No unit with serial BY100007 on file/.test(r.text), r.text);
r = await ask('tenantB', 'what unit is serial NEW-90001');
const before = r.text;
const custB = (await lite.query("SELECT id FROM entities WHERE tenant_id=$1 AND entity_type='customer' LIMIT 1", [tenantIds.tenantB])).rows[0].id;
await lite.query("INSERT INTO entities (tenant_id, entity_type, customer_id, data) VALUES ($1, 'equipment', $2, $3::jsonb)", [tenantIds.tenantB, custB, JSON.stringify({ serial_number: 'NEW-90001', model: 'GSXN3N3610', manufacturer: 'Goodman', installation_date: '2026-09-01' })]);
r = await ask('tenantB', 'what unit is serial NEW-90001');
check('live records: a unit added after the first ask is found on the next ask', /^No unit with serial NEW-90001/.test(before) && /Goodman GSXN3N3610/.test(r.text), `${before} || ${r.text}`);

const docA = (await lite.query('SELECT id FROM documents WHERE tenant_id=$1 LIMIT 1', [tenantIds.tenantA])).rows[0].id;
await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1, $2, 'invoice_number', 'INV-77777', 0.9)", [tenantIds.tenantA, docA]);
r = await ask('tenantA', 'invoice INV-77777');
const rB = await ask('tenantB', 'invoice INV-77777');
check('document numbers: live (a number added now is found) and tenant-isolated (B never sees A\'s)', /^Invoice INV-77777|^[A-Z][a-z ]+ INV-77777/.test(r.text) && rB.text === 'No invoice INV-77777 on file.', `${r.text} || ${rB.text}`);

console.log('\n-- 4. frozen R35 blind sets');
const { validQuestions } = await import(rel('api/_lib/scorecard/exam.js'));
const ctx = ctxA;
const FLOORS = { nick: { n: 166, correct: 165 }, serial: { n: 170, correct: 168 }, warr: { n: 104, correct: 102 },
  // R35 learning loops (scripts/gen-blind-r35b.mjs, frozen before each loop's rule)
  warr2: { n: 43, correct: 42 }, docnum: { n: 96, correct: 96 }, advice: { n: 52, correct: 44 }, serial2: { n: 38, correct: 38 }, short: { n: 47, correct: 47 } };
for (const [fam, floor] of Object.entries(FLOORS)) {
  const qs = validQuestions(JSON.parse(fs.readFileSync(rel(`test-docs/scorecard/blind/r35-${fam}.json`), 'utf8')).questions);
  const { overall } = await OE.runOfflineExam({ ctx, questions: qs, today: TODAY, modelCounter: counter });
  check(`blind r35-${fam}: ${qs.length} q, wrong 0 (got ${overall.wrong})`, overall.wrong === 0 && qs.length === floor.n);
  check(`blind r35-${fam}: correct >= ${floor.correct} (got ${overall.correct}; needs-model ${overall.needsModel})`, overall.correct >= floor.correct);
}

realLog(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
