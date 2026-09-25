/**
 * Checks for full-corpus content-count questions (api/_lib/contentCount.js, Team E 2026-09-24):
 * "how many jobs mention a capacitor", "which customers had a coil issue on file", jobs-vs-documents
 * scoping, the HVAC synonym map, tenant isolation, and the `count_documents_mentioning` agent tool.
 *
 * No network, no Anthropic key. The database is a REAL Postgres (PGlite, in process) loaded from the
 * actual M3-config/*.sql migrations, queried as the app's non-superuser NOBYPASSRLS role
 * (deepwell_rls) so row-level security is genuinely in force. Harness copied from
 * scripts/verify-agent.mjs.
 *
 *   node scripts/verify-content.mjs
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

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };

const content = await import('../api/_lib/contentCount.js');
const {
  HVAC_TERM_SYNONYMS, expandTerms, buildTermPattern, extractKnownTerms, canonicalizeTerm, parseContentCountQuestion,
} = content;

/* ================================================================== 1. pure: vocabulary + expansion */
{
  check('vocab: capacitor group includes cap and dual run cap', HVAC_TERM_SYNONYMS.capacitor.includes('cap') && HVAC_TERM_SYNONYMS.capacitor.includes('dual run cap'));
  check('vocab: noise group includes rattle/squeal/loud', ['rattle', 'squeal', 'loud'].every((w) => HVAC_TERM_SYNONYMS.noise.includes(w)));
  eq('canonicalizeTerm: a plural/variant spelling resolves to its group key', [canonicalizeTerm('capacitors'), canonicalizeTerm('loud'), canonicalizeTerm('leaking')], ['capacitor', 'noise', 'leak']);
  eq('canonicalizeTerm: an unrecognized word passes through unchanged', canonicalizeTerm('gizmo'), 'gizmo');
  check('expandTerms: a canonical key expands to its whole group', expandTerms(['capacitor']).includes('cap') && expandTerms(['capacitor']).includes('dual run cap'));
  eq('expandTerms: an unrecognized key is kept as a literal, single-word term', expandTerms(['gizmo']), ['gizmo']);
  const pattern = buildTermPattern(['cap', 'capacitor']);
  check('buildTermPattern: word-boundary anchored on both ends', pattern.startsWith('\\y(') && pattern.endsWith(')\\y'));
  const known = extractKnownTerms('replaced the cap and cleared a leak');
  check('extractKnownTerms: finds every group mentioned (capacitor via "cap", leak), none it is not', known.length === 2 && known.every((g) => ['capacitor', 'leak'].includes(g)), JSON.stringify(known));
  eq('extractKnownTerms: no known term -> empty', extractKnownTerms('what is the weather like today'), []);
}

/* ================================================================== 2. pure: question shape (never-hijack) */
{
  const cases = [
    ['how many jobs mention a capacitor', { scope: 'jobs', mode: 'count', groupBy: null, terms: ['capacitor'] }],
    ['How many jobs mention a refrigerant?', { scope: 'jobs', mode: 'count', groupBy: null, terms: ['refrigerant'] }],
    ['how many documents mention a coil', { scope: 'documents', mode: 'count', groupBy: null, terms: ['coil'] }],
    ['which customers had a capacitor issue or repair on file', { scope: 'documents', mode: 'list', groupBy: 'customer', terms: ['capacitor'] }],
    ['list jobs where we replaced the compressor', { scope: 'jobs', mode: 'list', groupBy: null, terms: ['compressor'] }],
    ['any complaints about noise', { scope: 'documents', mode: 'list', groupBy: null, terms: ['noise'] }],
  ];
  for (const [q, want] of cases) {
    const got = parseContentCountQuestion(q);
    check(`parse: "${q}" -> scope/mode/groupBy`, got && got.scope === want.scope && got.mode === want.mode && got.groupBy === want.groupBy, JSON.stringify(got));
    check(`parse: "${q}" -> terms`, got && JSON.stringify([...got.terms].sort()) === JSON.stringify([...want.terms].sort()), JSON.stringify(got?.terms));
  }
  const neverHijack = [
    'how many invoices are unpaid',
    'how many invoices are overdue',
    'which customers have no email on file',
    'how many documents do we have',
    'how much have we billed year to date',
    'do we have any overdue invoices',
    'which customers are overdue for maintenance',
  ];
  for (const q of neverHijack) check(`parse: never hijacks "${q}"`, parseContentCountQuestion(q) === null);
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const harnessNotes = [];
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); harnessNotes.push('01b-app-role.sql: re-run after the rest (dependency order)'); }
catch (err) { harnessNotes.push(`01b re-run failed: ${err.message}`); }
for (const line of harnessNotes) console.log(`NOTE  migration harness: ${line}`);
const role = (await lite.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'deepwell_rls'")).rows[0];
check('harness: the app role deepwell_rls exists, is not a superuser and does not bypass RLS', Boolean(role) && !role.rolsuper && !role.rolbypassrls, JSON.stringify(role));

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
const { runContentCount } = content;
const { createToolbox } = await import('../api/_lib/agent/tools.js');

const ctxA = { tenantKey: 'org_content_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_content_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedTenant(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address }, { number: `C-0000${c.n}` });
  for (const e of world.equipment ?? []) await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr ?? 'Trane', equipment_type: 'condenser' }, { customerId: uid(t, 'c', e.customer) });
  for (const d of world.docs) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, 'verified']);
    for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
    for (const [i, text] of (d.pages ?? []).entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid(t, 'd', d.n), tenantId, i + 1, text]);
  }
}

const worldA = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701' },
    { n: 4, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 5, name: 'Old Timer', address: '5 Oak Rd, Phoenix, AZ 85001' },
  ],
  equipment: [{ n: 4, customer: 4, mfr: 'Carrier' }],
  docs: [
    { n: 1, file: 'karen-service.pdf', type: 'service-ticket', links: [uid('a', 'c', 1)], pages: ['Replaced the dual run capacitor on the condenser. Unit runs fine now.'] },
    { n: 2, file: 'whitmore-invoice.pdf', type: 'invoice', links: [uid('a', 'c', 2)], pages: ['Customer reports the unit is very loud and rattles at startup. Invoice total $180.'] },
    { n: 3, file: 'thornton-quote.pdf', type: 'proposal-quote', links: [uid('a', 'c', 3)], pages: ['Quote includes a new cap for the compressor. Not yet approved.'] },
    // linked only through its equipment, never a direct customer link — exercises the equipment->customer join.
    { n: 4, file: 'plaza-workorder.pdf', type: 'work-order', links: [uid('a', 'e', 4)], pages: ['Found a refrigerant leak at the evaporator coil, recharged with R-410A.'] },
    { n: 5, file: 'oldtimer-permit.pdf', type: 'permit', links: [uid('a', 'c', 5)], pages: ['City permit for a water heater replacement, nothing HVAC-related here.'] },
  ],
};
const worldB = {
  customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501' }],
  docs: [{ n: 1, file: 'b-service.pdf', type: 'service-ticket', links: [uid('b', 'c', 1)], pages: ['Replaced capacitor and cleared a drain line at the secret location.'] }],
};
await seedTenant('a', tenA, worldA);
await seedTenant('b', tenB, worldB);

const run = (parsed) => withTenant(ctxA, (db) => runContentCount(db, parsed));

/* ================================================================== 3. document-scope counts + synonyms */
{
  const r = await run({ terms: ['capacitor'], scope: 'documents', groupBy: null });
  eq('documents scope: "capacitor" finds the literal word AND its "cap" synonym (2 documents: Karen + Thornton)', r.recordsTotal, 2);
  check('documents scope: text names the term and a real count, never "Found N matching records"', r.text.includes('capacitor') && !/^Found \d+ matching records/i.test(r.text));
  check('documents scope: basis states the rule (what was counted, by what field)', /mentions?\s+capacitor/i.test(r.basis) || /capacitor/i.test(r.basis));
  check('documents scope: at least one citation record carries a documentId and page', r.records.some((x) => x.documentId && x.page));

  const j = await run({ terms: ['capacitor'], scope: 'jobs', groupBy: null });
  eq('jobs scope excludes the proposal-quote (not a job) - only the service-ticket counts', j.recordsTotal, 1);
  check('jobs scope: basis states the jobs-vs-documents rule', /job/i.test(j.basis));
}

/* ================================================================== 4. multi-term groups (leak/refrigerant/coil on one doc) */
{
  const r = await run({ terms: ['leak', 'refrigerant', 'coil'], scope: 'documents', groupBy: null });
  eq('a document mentioning several requested groups is counted once, not three times', r.recordsTotal, 1);
  check('the matched document is Plaza\'s (linked only via its equipment)', r.records.some((x) => /plaza/i.test(x.group ?? '') || r.text.toLowerCase().includes('1 customer')));
}

/* ================================================================== 5. groupBy customer */
{
  const r = await run({ terms: ['noise'], scope: 'documents', groupBy: 'customer' });
  eq('groupBy customer: exactly one customer (Whitmore) had a noise mention', r.facts.length, 1);
  check('groupBy customer: names the customer in the text', r.text.includes('Whitmore'));
  // Whitmore's matching document is an invoice, so its record type is 'invoice' (documentRecord's own auto-detection
  // — see citations/records.js), not the generic 'document'; either is a valid document-shaped citation here.
  check('groupBy customer: a customer record and a document/invoice record are both present', r.records.some((x) => x.type === 'customer') && r.records.some((x) => x.type === 'document' || x.type === 'invoice'));
}

/* ================================================================== 6. honest zero */
{
  const r = await run({ terms: ['contactor'], scope: 'documents', groupBy: null });
  eq('no matches -> recordsTotal 0', r.recordsTotal, 0);
  eq('no matches -> recordsKind is "searched" (an honest zero, not a basis)', r.recordsKind, 'searched');
  check('no matches -> a real sentence, never blank', r.text.length > 10 && /contactor/i.test(r.text));
}

/* ================================================================== 7. tenant isolation */
{
  const rA = await run({ terms: ['capacitor'], scope: 'documents', groupBy: null });
  check("tenant A's count never includes tenant B's matching document", !rA.records.some((x) => /secret/i.test(x.sublabel ?? '')));
  const rB = await withTenant(ctxB, (db) => runContentCount(db, { terms: ['capacitor'], scope: 'documents', groupBy: null }));
  eq("tenant B sees its own single matching document", rB.recordsTotal, 1);
}

/* ================================================================== 8. the agent tool (count_documents_mentioning) */
{
  const toolbox = createToolbox({ withTenant, ctxArg: ctxA, today: '2026-09-24' });
  const r = await toolbox.execute('count_documents_mentioning', { terms: ['capacitors'], documentType: 'jobs' }); // plural, on purpose
  check('agent tool: ok, and a plural spelling still canonicalizes to the capacitor group', r.ok);
  const parsed = JSON.parse(r.content);
  eq('agent tool: jobs-scoped capacitor count matches the deterministic path (1)', parsed.recordsTotal, 1);
  check('agent tool: rowCount mirrors recordsTotal', r.rowCount === parsed.recordsTotal);

  const rZero = await toolbox.execute('count_documents_mentioning', { terms: ['blower motor'] });
  check('agent tool: an honest zero is still ok:true with rowCount 0', rZero.ok && rZero.rowCount === 0 && rZero.empty === true);

  const rBad = await toolbox.execute('count_documents_mentioning', { terms: [] });
  check('agent tool: no terms -> a clear error, not a crash', !rBad.ok && /terms/i.test(rBad.content));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
