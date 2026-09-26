/**
 * Round 11, item 2 (literature #6/#7) — vocab/tenantVocab.js + its nlNormalize.js/analytics.js hooks.
 *
 * Same harness convention as scripts/verify-relations.mjs / verify-job-costing.mjs: a REAL Postgres
 * (PGlite, from the actual M3-config/*.sql migrations, through the app's own RLS role), no network, no
 * Anthropic key.
 *
 *   node scripts/verify-vocab.mjs
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};

/* ================================================================== 1. pure */
const Vocab = await import('../api/_lib/vocab/tenantVocab.js');
const NL = await import('../api/_lib/nlNormalize.js');
const A = await import('../api/_lib/analytics.js');

{
  const g = Vocab.buildNameGlossary(['Danny Ochoa', 'Marisol Vega', '']);
  eq('buildNameGlossary: full phrases captured', g.phrases.slice().sort(), ['Danny Ochoa', 'Marisol Vega']);
  check('buildNameGlossary: individual words (>=3 letters) captured for word-level correction', g.words.has('danny') && g.words.has('ochoa') && g.words.has('vega'));
}

{
  const vocab = { technicians: Vocab.buildNameGlossary(['Danny Ochoa']), customers: Vocab.buildNameGlossary(['Marisol Vega']) };
  const a = Vocab.correctTenantNameTypos("How many of Denny Ochoa's jobs had a callback within 30 days?", vocab);
  check('correctTenantNameTypos: possessive technician-name typo corrected ("Denny Ochoa\'s" -> "Danny Ochoa\'s")',
    a.corrected.includes("Danny Ochoa's") && a.corrections.some((c) => c.category === 'technician'), a.corrected);

  const b = Vocab.correctTenantNameTypos('Did Vaga\'s jobs have a repeat visit?', { technicians: Vocab.buildNameGlossary([]), customers: Vocab.buildNameGlossary(['Marisol Vega']) });
  check('correctTenantNameTypos: possessive customer-name typo corrected ("Vaga\'s" -> "Vega\'s")', /Vega's/.test(b.corrected), b.corrected);

  const c = Vocab.correctTenantNameTypos("Did Danny Ochoa have a repeat visit?", vocab);
  eq('correctTenantNameTypos: an already-correct name is never touched', c.corrections, []);

  const d = Vocab.correctTenantNameTypos('How many customers do we have?', vocab);
  eq('correctTenantNameTypos: a question with no possessive/verb-name span makes no correction at all', d.corrections, []);

  // "Main" is a real word (VOCAB via geo streets etc. is irrelevant here - "main" is a real English
  // word) sitting one edit from a fictitious technician "Maine" - never rewritten into a name guess for
  // a word that already reads fine on its own.
  const e = Vocab.correctTenantNameTypos('Did Main have a repeat visit?', { technicians: Vocab.buildNameGlossary(['Maine']), customers: Vocab.buildNameGlossary([]) });
  eq('correctTenantNameTypos: a real word is never "corrected" into an unrelated name', e.corrections, []);
}

{
  const vocab = { brands: ['Zephyrion'], docTypePhrases: [{ id: 'maintenance-agreement', phrase: 'maintenance agreement' }], cities: ['Somewhereville'] };
  check('schemaLinkedVocabLines: mentions the tenant brand actually present in the question', /Zephyrion/.test(Vocab.schemaLinkedVocabLines('how many zephyrion units do we have', vocab)));
  check('schemaLinkedVocabLines: mentions the tenant doc type actually present in the question', /maintenance agreement/.test(Vocab.schemaLinkedVocabLines('who has a maintenance agreement', vocab)));
  check('schemaLinkedVocabLines: returns null when nothing in the tenant vocab matches the question at all', Vocab.schemaLinkedVocabLines('how many customers do we have', vocab) === null);
  eq('schemaLinkedVocabLines: no vocab at all -> null (never throws)', Vocab.schemaLinkedVocabLines('anything', null), null);
}

{
  const tenantVocab = { brands: ['Zephyrion'], models: [] };
  const { normalized } = NL.normalizeQuestion('how many zephyrian units do we have', { tenantVocab });
  check('normalizeQuestion + tenantVocab: a tenant-only brand typo is fuzzy-corrected ("zephyrian" -> "zephyrion")', normalized.includes('zephyrion'), normalized);
  const plain = NL.normalizeQuestion('how many zephyrian units do we have').normalized;
  check('normalizeQuestion with NO tenantVocab: byte-identical to before this existed (never corrects a word no vocab knows)', plain === 'how many zephyrian units do we have', plain);
}

{
  // buildAnalyticsSystemPrompt: additive-only, never changes output when vocabLines is omitted/empty.
  const base = A.buildAnalyticsSystemPrompt({});
  check('buildAnalyticsSystemPrompt: no vocabLines -> byte-identical to ANALYTICS_SYSTEM_PROMPT', base === A.ANALYTICS_SYSTEM_PROMPT);
  const widened = A.buildAnalyticsSystemPrompt({ vocabLines: "This tenant's own brands on file: Zephyrion." });
  check('buildAnalyticsSystemPrompt: vocabLines appended, base prompt still present verbatim', widened.includes(A.ANALYTICS_SYSTEM_PROMPT) && widened.includes('Zephyrion'));
}

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
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* notes printed elsewhere */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as other verify-*.mjs */ }

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
const tenIdA = (await getTenantContext('org_vocab_a', 'Vocab Shop A')).id;
const tenIdB = (await getTenantContext('org_vocab_b', 'Vocab Shop B')).id;
const uid = (t, kind, n) => `dab00000-0000-4000-8${kind}00-${t}${String(n).padStart(11, '0')}`;

async function addCustomer(tenId, tag, n, name) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,\'customer\',$3::jsonb)',
    [uid(tag, 'c', n), tenId, JSON.stringify({ customer_name: name })]);
}
async function addTechnician(tenId, tag, n, tech) {
  const docId = uid(tag, 'd', n);
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [docId, tenId, `doc-${tag}-${n}.pdf`, 'service-ticket', `hash-vocab-${tag}-${n}`, 'verified']);
  await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [tenId, docId, 'technician', tech]);
}

await addCustomer(tenIdA, '1', 1, 'Marisol Vega');
await addTechnician(tenIdA, '1', 1, 'Danny Ochoa');

{
  const vocab = await withTenant({ tenantKey: 'org_vocab_a', tenantName: 'Vocab Shop A' }, (db) => Vocab.getTenantVocab(db, 'org_vocab_a', null));
  check('getTenantVocab: technician names built from this tenant\'s own extractions', vocab.technicians.phrases.includes('Danny Ochoa'), JSON.stringify(vocab.technicians));
  check('getTenantVocab: customer names built from this tenant\'s own entities', vocab.customers.phrases.includes('Marisol Vega'), JSON.stringify(vocab.customers));
}

await addCustomer(tenIdB, '2', 1, 'Someone Else');
{
  const vocabB = await withTenant({ tenantKey: 'org_vocab_b', tenantName: 'Vocab Shop B' }, (db) => Vocab.getTenantVocab(db, 'org_vocab_b', null));
  check('getTenantVocab: per-tenant isolation — tenant B never sees tenant A\'s names', !vocabB.customers.phrases.includes('Marisol Vega') && vocabB.customers.phrases.includes('Someone Else'), JSON.stringify(vocabB.customers));
}

{
  const ctxA = { tenantKey: 'org_vocab_a', tenantName: 'Vocab Shop A' };
  const v1 = await withTenant(ctxA, (db) => Vocab.computeDataVersion(db));
  await addCustomer(tenIdA, '1', 2, 'Extra Customer');
  const v2 = await withTenant(ctxA, (db) => Vocab.computeDataVersion(db));
  check('computeDataVersion: cache invalidation — the data-version key changes after a new customer is added', v1 !== v2, `${v1} vs ${v2}`);
  Vocab.resetTenantVocabCacheForTests();
  const refreshed = await withTenant({ tenantKey: 'org_vocab_a', tenantName: 'Vocab Shop A' }, (db) => Vocab.getTenantVocab(db, 'org_vocab_a', null));
  check('getTenantVocab: rebuilds and picks up the new customer after invalidation', refreshed.customers.phrases.includes('Extra Customer'), JSON.stringify(refreshed.customers));
}

console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
