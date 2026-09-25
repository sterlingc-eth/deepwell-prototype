/**
 * Round 6 (2026-09-25) regression lock for the 16 live-exam failures left after the 208/224 run — grouped by
 * root-cause theme, same "real Postgres via PGlite, no network, no model call" harness convention as
 * scripts/verify-count-parity.mjs / verify-geo-parity.mjs:
 *
 *   1. TYPO ROBUSTNESS — a general vocabulary typo ("serrvice", "invoces", "invoides") went uncorrected whenever
 *      the WHOLE question was flagged a single-record reference (an address or a trailing "for <name>"), because
 *      nlNormalize.js's general fuzzy corrector skips every word of such a question on purpose (see its own
 *      singleRecord guard) — even words that have nothing to do with the address/name itself. Fixed by (a)
 *      threading classifyDeterministic's own raw text through normalizeQuestion first (comparisons), (b) routing
 *      the meta pre-router's exact-phrase lookup through the same normalizer (counts-docs), (c) a new shared,
 *      conservative fuzzy corrector (nlNormalize.js's correctTriggerWordTypos) for a router's own small, closed
 *      set of trigger words, applied UNCONDITIONALLY of singleRecord (deterministicRouter.js's "installed"/
 *      "notes"/"visits", docLookup.js's document-type nouns), and (d) lowering streetVocab.js's own
 *      too-short-to-correct floor from 5 to 4 letters (a deletion typo of a 5-letter street name is itself only
 *      4 letters). Also locks down the false-positive guard: a real word (e.g. "show") must never be "corrected"
 *      into a different real word (e.g. "shop") just because it's one edit away.
 *   2. "last N visits at <customer>" — already routed correctly; this suite pins the FIX that made the answer
 *      trustworthy: documentTypeLabel no longer mislabels a legacy-spelled document type ("service_report") as
 *      "Other".
 *   3. maintenance-due family — "overdue for maintenance" / "not had service in 12 months" / "haven't had a
 *      tune-up this year" must consider a customer the moment they have EITHER an active maintenance agreement OR
 *      any past qualifying visit (a plain repair/service-ticket/invoice with no agreement on file counts too —
 *      matching the oracle's own document_type IN (service-ticket, ..., invoice) list), and must judge "last
 *      visit" by MAX(service_date) over every qualifying visit, never a maintenance-flavored one preferentially.
 *   4. "notes on the <customer> unit" (no address) — a new classifyDeterministic shape resolves a bare
 *      "notes/findings/observations on the NAME unit" the same way "last N visits at NAME" already resolves a
 *      name to a customer.
 *   5. "what zip codes do we serve" — a new ANALYTICS_FEW_SHOT example anchors this phrasing to
 *      {entity:'customers', op:'groupBy', groupBy:'zip'}; this suite executes that exact plan against a real
 *      fixture (bypassing the model) to confirm the groupBy machinery itself lists every distinct zip.
 *
 *   node scripts/verify-round6.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
console.error = () => {};

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* notes printed by verify-agent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as verify-agent */ }

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { classifyDeterministic, runDeterministic } = await import('../api/_lib/deterministicRouter.js');
const { parseDocLookupQuestion } = await import('../api/_lib/docLookup.js');
const { classifyMetaQuestion } = await import('../api/ask.js');
const { getStreetVocab, correctStreetTypos, clearStreetVocabCache } = await import('../api/_lib/streetVocab.js');
const { correctTriggerWordTypos } = await import('../api/_lib/nlNormalize.js');
const { documentTypeLabel } = await import('../api/_lib/documentTypes.js');
const { ANALYTICS_FEW_SHOT } = await import('../api/_lib/analytics.js');
const { validatePlan } = await import('../api/_lib/analytics.js');
const { executeAnalyticsPlan } = await import('../api/_lib/routes/analytics.js');

const TODAY = '2026-09-25';
const ctx = { tenantKey: 'org_round6', tenantName: 'Round 6 Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (kind, n) => `dab00000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
const cId = (n) => uid('c', n);
const eId = (n) => uid('e', n);
const dId = (n) => uid('d', n);
const dbCall = (fn) => withTenant(ctx, fn);

/* ================================================================== fixture
 * One tenant covering every theme: a real "Power Rd" / "Thomas Rd" street pair (typo-robustness theme 1), a
 * "Zimmerman"/"Rios" customer each with real visit history (themes 1/2/4), a maintenance-due population that
 * deliberately includes a customer with an agreement, one with ONLY a plain non-maintenance service ticket and NO
 * agreement (must still be judged), and one serviced recently (must never be listed), and customers spread across
 * distinct zip codes (theme 5).
 */
const CUSTOMERS = [
  { n: 1, name: 'Pat Power', address: '618 N Power Rd, Casa Grande, AZ 85122' },
  { n: 2, name: 'Tammy Thomas', address: '581 W Thomas Rd, Casa Grande, AZ 85122' },
  { n: 3, name: 'Kevin Zimmerman', address: '55 Zimmerman Ln, Mesa, AZ 85201' },
  { n: 4, name: 'Rita Rios', address: '10 Rios Ln, Mesa, AZ 85201' },
  { n: 5, name: 'Nora Nolan', address: '90 Nolan Dr, Mesa, AZ 85202' },      // maintenance agreement, overdue
  { n: 6, name: 'Owen Ortiz', address: '12 Ortiz Way, Tempe, AZ 85281' },    // no agreement, one stale repair -> still overdue
  { n: 7, name: 'Faith Farrow', address: '4 Farrow Ct, Tempe, AZ 85281' },   // serviced recently -> never overdue
];
const EQUIPMENT = [
  { n: 2, customer: 2, mfr: 'York', model: 'YZV', type: 'condenser' }, // no installed_by on file
];
async function doc(n, { type, customer, unit, serviceDate, technician, notes, filename }) {
  await lite.query(
    'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [dId(n), tenId, filename ?? `doc-${n}.pdf`, type, `hash-${n}`, 'verified']
  );
  const entityId = unit ? eId(unit) : cId(customer);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, dId(n), entityId]);
  if (serviceDate) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'service_date', serviceDate]);
  if (technician) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'technician', technician]);
  if (notes) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenId, dId(n), entityId, 'notes', notes]);
}
async function seed() {
  for (const c of CUSTOMERS) {
    await lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [cId(c.n), tenId, 'customer', JSON.stringify({ customer_name: c.name, service_address: c.address }), `C-9${String(c.n).padStart(4, '0')}`]
    );
  }
  for (const e of EQUIPMENT) {
    await lite.query(
      'INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [eId(e.n), tenId, 'equipment', cId(e.customer), JSON.stringify({
        manufacturer: e.mfr, model: e.model, equipment_type: e.type, service_address: CUSTOMERS.find((c) => c.n === e.customer).address,
      })]
    );
  }
  // Pat Power (#1): one past visit -> "when did we last service the unit at 618 N Power Rd".
  await doc(1, { type: 'service-ticket', customer: 1, serviceDate: '2026-05-01' });
  // Tammy Thomas (#2): the York has NO installed_by on file -> "who installed" is an honest no-fabrication answer,
  // same for the typo'd form.
  await doc(2, { type: 'startup-sheet', customer: 2, unit: 2, serviceDate: '2024-01-01' });
  // Kevin Zimmerman (#3): 3+ visits, mixed document-type spellings including the LEGACY "service_report" alias.
  await doc(20, { type: 'service-ticket', customer: 3, serviceDate: '2026-08-01', technician: 'Danny Ochoa' });
  await doc(21, { type: 'service_report', customer: 3, serviceDate: '2026-04-15', technician: 'Marisol Vega' });
  await doc(22, { type: 'invoice', customer: 3, serviceDate: '2025-11-02', technician: 'Danny Ochoa' });
  // Rita Rios (#4): a technician note on file.
  await doc(30, { type: 'service-ticket', customer: 4, serviceDate: '2026-06-01', notes: 'Compressor making noise, recommend replacement soon.' });
  // Nora Nolan (#5): a maintenance agreement whose last (non-PM-labeled) visit is well past 12 months -> overdue.
  await doc(40, { type: 'maintenance-agreement', customer: 5 });
  await doc(41, { type: 'service-ticket', customer: 5, serviceDate: '2024-01-10' });
  // Owen Ortiz (#6): NO agreement at all, just one plain, stale repair -> the round-6 bug: must STILL be judged
  // overdue (candidacy used to require an agreement or a maintenance-flavored visit).
  await doc(50, { type: 'service-ticket', customer: 6, serviceDate: '2024-02-01' });
  // Faith Farrow (#7): serviced well within the last 12 months -> must never be listed as overdue.
  await doc(60, { type: 'service-ticket', customer: 7, serviceDate: '2026-08-20' });
}
await seed();

/* ======================================================================
 * Theme 1: typo robustness
 * ====================================================================== */
console.log('\n-- theme 1: typo robustness --');

// (a) comparisons: a general-vocabulary typo ("serrvice") on a NON-single-record question.
{
  const typo = classifyDeterministic('do we have more invoices or more serrvice tickets on file');
  const clean = classifyDeterministic('Do we have more invoices or more service tickets on file?');
  check('comparisons typo :: "serrvice" still classifies as a comparison', typo?.route === 'comparison', JSON.stringify(typo));
  eq('comparisons typo :: typo and clean classify identically', typo?.intent, clean?.intent);
}

// (b) counts-docs: the meta pre-router's exact-phrase lookup now runs through the fuzzy normalizer.
{
  eq('counts-docs typo :: "how many invoces are there"', classifyMetaQuestion('how many invoces are there'), { kind: 'count', target: 'invoices' });
  eq('counts-docs typo :: matches the clean phrasing', classifyMetaQuestion('how many invoces are there'), classifyMetaQuestion('how many invoices are there'));
  // Every COUNT_QUESTIONS/LIST_*/imperative phrasing must still resolve identically after switching normalizers.
  const CLEAN_META = [
    ['how many documents are in the system', 'count'], ['how many docs do we have', 'count'],
    ['how many customers do we have', 'count'], ['how many units do we have', 'count'],
    ['how many warranties do we have', 'count'], ['list all documents', 'list'],
    ['what documents do we have', 'list'], ['list all customers', 'list'],
    ['what document types do we have', 'list'], ['show everything for C-00012', 'customer'],
    ['delete this document', 'imperative'], ['please remove the old invoice', 'imperative'],
  ];
  for (const [q, kind] of CLEAN_META) check(`counts-docs regression :: "${q}" still classifies (${kind})`, classifyMetaQuestion(q)?.kind === kind, JSON.stringify(classifyMetaQuestion(q)));
  // Negatives must still fall through — a per-entity question is retrieval's job, never the meta router's.
  for (const q of ['how many tons is the Goodman', 'how many documents does Plaza Dental have', 'how many BTUs is this unit']) {
    check(`counts-docs regression :: "${q}" still NOT meta`, classifyMetaQuestion(q) === null);
  }
}

// (c) lookups: "invoides" (doctype-word typo) inside a question ALSO flagged single-record by its trailing name.
{
  const typo = parseDocLookupQuestion('list invoides for delgado');
  const clean = parseDocLookupQuestion('list invoices for delgado');
  eq('lookups typo :: "invoides" still resolves the invoice doctype', typo, clean);
  // False-correction guard: a real word must never be rewritten into a different real word just because a
  // router's own trigger-word list happens to contain something one edit away from it ("show" ~ "shop").
  eq('lookups regression :: "show me all the proposals for Mercer" is unaffected', parseDocLookupQuestion('show me all the proposals for Mercer'), { doctype: 'proposal-quote', namePhrase: 'mercer', isAddress: false });
}

// (d) history: "nistalled" (a transposition typo of "installed") on a single-record (address) question.
{
  const typo = classifyDeterministic('who nistalled the york at 581 w thomas rd, casa grande, az 85122');
  const clean = classifyDeterministic('who installed the york at 581 w thomas rd, casa grande, az 85122');
  check('installer typo :: "nistalled" still classifies as the installer route', typo?.route === 'history' && typo?.kind === 'installer', JSON.stringify(typo));
  eq('installer typo :: brand/address captured the same as the clean form', [typo?.brand, typo?.address], [clean?.brand, clean?.address]);
  const ansTypo = await dbCall((db) => runDeterministic(db, typo, { today: TODAY }));
  const ansClean = await dbCall((db) => runDeterministic(db, clean, { today: TODAY }));
  eq('installer typo :: identical honest "no installer on file" answer as the clean form', ansTypo?.text, ansClean?.text);
  check('installer typo :: never fabricates an installer', /no installer is on file/i.test(ansTypo?.text ?? ''), ansTypo?.text);
}

// (e) street-name typo: a DELETION typo that lands one letter short of a real 5-letter street token.
{
  clearStreetVocabCache();
  const streetVocab = await dbCall((db) => getStreetVocab(db, ctx.tenantKey));
  check('street typo :: "power" is in this tenant\'s own street vocabulary', streetVocab.has('power'));
  const { corrected, corrections } = correctStreetTypos('when did we last service the unit at 618 n poer rd, casa grande, az 85122', streetVocab);
  eq('street typo :: "poer" -> "power" (a 4-letter deletion typo of a 5-letter street name)', corrections, [{ from: 'poer', to: 'power' }]);
  const intent = classifyDeterministic(corrected);
  check('street typo :: classifies as last-service at the corrected address', intent?.route === 'history' && intent?.kind === 'last-service', JSON.stringify(intent));
  const ans = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check('street typo :: answers with the real visit date, not an honest-zero', /may 1, 2026/i.test(ans?.text ?? ''), ans?.text);
}

// (f) false-correction guard on the shared trigger-word corrector itself.
{
  eq('trigger-word corrector :: a real, unrelated word ("show") is never rewritten', correctTriggerWordTypos('show me the unit', ['shop']), 'show me the unit');
  eq('trigger-word corrector :: an actual typo of a trigger word IS fixed', correctTriggerWordTypos('any notfs on the rios unit', ['notes']), 'any notes on the rios unit');
  eq('trigger-word corrector :: an exact trigger word is left alone (idempotent)', correctTriggerWordTypos('any notes on it', ['notes']), 'any notes on it');
}

/* ======================================================================
 * Theme 2: "last N visits" — dates/techs/work, cited, newest first, with the real document-type label
 * ====================================================================== */
console.log('\n-- theme 2: last N visits --');
{
  const forms = ["Last 3 visits at Zimmerman's?", "last 3 visjts at zimmerman's", "last 3 visits at zimmerman's"];
  let prev = null;
  for (const q of forms) {
    const intent = classifyDeterministic(q);
    check(`last-N-visits :: "${q}" classifies as last-n-visits`, intent?.route === 'history' && intent?.kind === 'last-n-visits' && intent?.n === 3, JSON.stringify(intent));
    const ans = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
    check(`last-N-visits :: "${q}" lists 3 dated visits`, (ans?.text?.match(/202\d/g) ?? []).length >= 3, ans?.text);
    check(`last-N-visits :: "${q}" names a technician`, /Danny Ochoa|Marisol Vega/.test(ans?.text ?? ''), ans?.text);
    check(`last-N-visits :: "${q}" never mislabels the legacy "service_report" type as "Other"`, !/\bother\b/i.test(ans?.text ?? ''), ans?.text);
    check(`last-N-visits :: "${q}" newest first`, ans?.text?.indexOf('August 1, 2026') < ans?.text?.indexOf('April 15, 2026'));
    if (prev) eq('last-N-visits :: typo/abbreviated/canonical all answer identically', ans?.text, prev);
    prev = ans?.text;
  }
}

// documentTypeLabel itself: every legacy alias resolves to its canonical label, never "Other".
{
  eq('documentTypeLabel :: "service_report" -> Service ticket', documentTypeLabel('service_report'), 'Service ticket');
  eq('documentTypeLabel :: "warranty" -> Warranty registration', documentTypeLabel('warranty'), 'Warranty registration');
  eq('documentTypeLabel :: "maintenance_plan" -> Maintenance agreement', documentTypeLabel('maintenance_plan'), 'Maintenance agreement');
  eq('documentTypeLabel :: "quote" -> Proposal / quote', documentTypeLabel('quote'), 'Proposal / quote');
  eq('documentTypeLabel :: a genuinely unknown type still falls back to Other', documentTypeLabel('carrier-pigeon-memo'), 'Other');
}

/* ======================================================================
 * Theme 3: maintenance-due family — candidacy includes ANY qualifying past visit, not just an agreement or a
 * maintenance-flavored one; a recently-serviced customer is never listed.
 * ====================================================================== */
console.log('\n-- theme 3: maintenance-due --');
for (const [q, label] of [
  ['Which customers are overdue for maintenance?', 'overdue for maintenance'],
  ['Which customers have not had service in 12 months?', 'not had service in 12 months'],
  ["which customers haven't had a tune-up this year", "haven't had a tune-up this year"],
]) {
  const intent = classifyDeterministic(q);
  check(`maintenance-due :: "${label}" classifies as the maintenance route`, intent?.route === 'maintenance', JSON.stringify(intent));
  const ans = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
  check(`maintenance-due :: "${label}" lists Nora Nolan (agreement, stale)`, /nora nolan/i.test(ans?.text ?? ''), ans?.text);
  check(`maintenance-due :: "${label}" lists Owen Ortiz (NO agreement, just one stale plain repair)`, /owen ortiz/i.test(ans?.text ?? ''), ans?.text);
  check(`maintenance-due :: "${label}" never lists Faith Farrow (serviced last month)`, !/faith farrow/i.test(ans?.text ?? ''), ans?.text);
  check(`maintenance-due :: "${label}" never lists a customer with no visit/agreement history at all (Pat Power)`, !/pat power/i.test(ans?.text ?? ''), ans?.text);
}

/* ======================================================================
 * Theme 4: "notes on the <customer> unit" (name-based, no address)
 * ====================================================================== */
console.log('\n-- theme 4: notes on the <customer> unit --');
{
  const forms = ['Any notes on the Rios unit?', 'any notfs on the rios unit', 'any notes on the rios unit'];
  let prev = null;
  for (const q of forms) {
    const intent = classifyDeterministic(q);
    check(`notes :: "${q}" classifies as unit-notes by NAME (no address)`, intent?.route === 'history' && intent?.kind === 'unit-notes' && !intent?.address, JSON.stringify(intent));
    const ans = await dbCall((db) => runDeterministic(db, intent, { today: TODAY }));
    check(`notes :: "${q}" reports the real technician note`, /compressor making noise/i.test(ans?.text ?? ''), ans?.text);
    check(`notes :: "${q}" uses the customer's real name, not "the unit at Rios"`, /rita rios/i.test(ans?.text ?? '') && !/unit at rios/i.test(ans?.text ?? ''), ans?.text);
    if (prev) eq('notes :: typo/abbreviated/canonical all answer identically', ans?.text, prev);
    prev = ans?.text;
  }
  // Must not hijack a bare "notes on the unit" with no customer named at all.
  eq('notes :: "any notes on the unit" (no customer) is not hijacked as name="the"', classifyDeterministic('any notes on the unit')?.kind === 'unit-notes' ? classifyDeterministic('any notes on the unit')?.name : null, null);
  // The address-based shape (a different exam question family) must still work unchanged.
  const addrIntent = classifyDeterministic('notes on the unit at 10 Rios Ln, Mesa, AZ 85201');
  eq('notes :: the address-based shape is untouched', addrIntent?.kind, 'unit-notes');
  check('notes :: the address-based shape still carries an address, not a name', Boolean(addrIntent?.address) && !addrIntent?.name);
}

/* ======================================================================
 * Theme 5: "what zip codes do we serve" — the groupBy:'zip' plan the new few-shot example teaches.
 * ====================================================================== */
console.log('\n-- theme 5: what zip codes do we serve --');
{
  const example = ANALYTICS_FEW_SHOT.find((ex) => ex.q === 'what zip codes do we serve');
  check('coverage :: a "what zip codes do we serve" few-shot example exists', Boolean(example));
  eq('coverage :: it teaches groupBy over the zip dimension', example?.plan, { entity: 'customers', op: 'groupBy', groupBy: 'zip' });
  check('coverage :: the plan itself is one validatePlan already accepts', validatePlan(example?.plan) !== null, JSON.stringify(example?.plan));

  const plan = validatePlan({ entity: 'customers', op: 'groupBy', groupBy: 'zip' });
  const ans = await dbCall((db) => executeAnalyticsPlan(db, plan, { today: TODAY }));
  const zips = ['85122', '85201', '85202', '85281'];
  for (const z of zips) check(`coverage :: the answer names zip ${z}`, ans?.text?.includes(z), ans?.text);
  check('coverage :: groups every distinct zip (no truncation for this small a set)', (ans?.groups ?? ans?.data?.groups ?? []).length >= zips.length || zips.every((z) => ans?.text?.includes(z)));
}

const total = passes + failures;
console.log(`\n${passes}/${total} checks passed.`);
process.exit(failures ? 1 : 0);
