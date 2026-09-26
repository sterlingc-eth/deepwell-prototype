/**
 * Checks for the industry pack system (Team G, 2026-09-24):
 * api/_lib/industry/{index,packs/*}.js and the pack-aware surface each of
 * documentTypes.js / extractFields.js / contentCount.js / nlNormalize.js /
 * maintenanceDue.js / warrantyRules.js / agent/{tools,loop}.js now exposes.
 *
 *   1. Contract shape (pure): every pack validates; PACK_IDS/getPack/listPacks.
 *   2. The hvac pack reproduces today's hard-coded HVAC constants exactly —
 *      the "byte-identical for HVAC tenants" proof this build's brief calls
 *      for, checked by direct comparison against the modules those constants
 *      still live in.
 *   3. Every module's pack-aware functions: called with no pack (or the hvac
 *      pack), output is unchanged from before packs existed; called with a
 *      plumbing/electrical/property pack, output genuinely reflects that
 *      pack's own vocabulary.
 *   4. DB-backed (PGlite, same harness as scripts/verify-agent.mjs): a real
 *      tenant per industry (tenants.settings->>'industry'), packForTenant
 *      resolves it (both the `db` and `{withTenant,ctxArg}` call shapes),
 *      defaults to hvac when the column/row/key is missing, and a sample of
 *      each pack's own exam-template oracle SQL actually runs against seeded
 *      generic-table data.
 *
 *   node scripts/verify-industry.mjs
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

const {
  getPack, listPacks, PACK_IDS, packForTenant, resetPackForTenantCacheForTests,
  ORACLE_SQL_TEMPLATES, resolveOracle, validatePack,
} = await import('../api/_lib/industry/index.js');

/* ================================================================== 1. contract shape */
{
  eq('PACK_IDS', PACK_IDS, ['hvac', 'plumbing', 'electrical', 'property']);
  const packs = listPacks();
  eq('listPacks() returns one pack per PACK_IDS entry, in order', packs.map((p) => p.id), PACK_IDS);
  for (const pack of packs) {
    const problems = validatePack(pack);
    check(`${pack.id} pack validates against the contract`, problems.length === 0, problems.join('; '));
  }
  check('getPack falls back to hvac for an unknown id', getPack('nonexistent-industry').id === 'hvac');
  check('getPack falls back to hvac for empty/undefined', getPack('').id === 'hvac' && getPack(undefined).id === 'hvac' && getPack(null).id === 'hvac');
  check('getPack is case-insensitive', getPack('PLUMBING').id === 'plumbing');

  for (const id of ['plumbing', 'electrical', 'property']) {
    const pack = getPack(id);
    check(`${id}: at least 40 exam templates`, pack.examTemplates.length >= 40, `got ${pack.examTemplates.length}`);
    const maxPersonaQs = Math.max(...pack.personas.map((p) => p.sampleQuestions.length));
    check(`${id}: at least one persona with 25+ sample questions`, maxPersonaQs >= 25, `got ${maxPersonaQs}`);
    const ids = new Set();
    for (const t of pack.examTemplates) {
      check(`${id}: exam template ids unique (${t.id})`, !ids.has(t.id));
      ids.add(t.id);
    }
  }

  // Oracle SQL templates: written ONLY against the six generic tables named in the brief.
  const GENERIC_TABLES = ['documents', 'document_pages', 'extractions', 'entities', 'document_entity_links', 'document_financials'];
  const NON_GENERIC_HINTS = ['documents_v', 'equipment_v', 'customers', ' equipment ', 'financials_v'];
  for (const [name, build] of Object.entries(ORACLE_SQL_TEMPLATES)) {
    const { sql } = build('x', 'y', 'z');
    const usesGeneric = GENERIC_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(sql));
    check(`oracle template ${name} references a generic table`, usesGeneric, sql);
    const usesOnlyGeneric = !NON_GENERIC_HINTS.some((h) => sql.includes(h));
    check(`oracle template ${name} does not reference a non-generic view`, usesOnlyGeneric, sql);
  }
  // Every pack's own examTemplates resolve to a real oracle template.
  for (const pack of packs) {
    for (const t of pack.examTemplates) {
      const resolved = resolveOracle(t.oracle, '00000000-0000-0000-0000-000000000000');
      check(`${pack.id}/${t.id}: oracle "${t.oracle}" resolves`, Boolean(resolved), t.oracle);
    }
  }
}

/* ================================================================== 2. hvac pack === today's HVAC constants */
{
  const { DOCUMENT_TYPES, DOCUMENT_TYPE_DEFINITIONS, REQUIRED_FIELDS, FIELD_LABELS } = await import('../api/_lib/documentTypes.js');
  const { FIELD_SPECS, UNIT_SCOPED_FIELDS } = await import('../api/_lib/extractFields.js');
  const { HVAC_TERM_SYNONYMS } = await import('../api/_lib/contentCount.js');
  const { ABBREV } = await import('../api/_lib/nlNormalize.js');
  const { BRAND_RULES } = await import('../api/_lib/warrantyRules.js');
  const { NON_VISIT_TYPES } = await import('../api/_lib/scope.js');
  const hvac = getPack('hvac');

  eq('hvac pack businessNoun/unitNoun', [hvac.businessNoun, hvac.unitNoun], ['HVAC shop', 'unit']);
  eq('hvac pack documentTypes ids === DOCUMENT_TYPES ids, in order', hvac.documentTypes.map((t) => t.id), DOCUMENT_TYPES.map((t) => t.id));
  let dtMismatch = null;
  for (const t of hvac.documentTypes) {
    const label = DOCUMENT_TYPES.find((d) => d.id === t.id)?.label;
    const def = DOCUMENT_TYPE_DEFINITIONS[t.id] ?? '';
    const requires = REQUIRED_FIELDS[t.id] ?? [];
    const visitType = !NON_VISIT_TYPES.has(t.id);
    if (t.label !== label || t.definition !== def || JSON.stringify(t.requires) !== JSON.stringify(requires) || t.visitType !== visitType) {
      dtMismatch = t.id;
      break;
    }
  }
  check('hvac pack documentTypes match documentTypes.js label/definition/requires/visitType exactly', dtMismatch === null, dtMismatch);

  eq('hvac pack field keys === FIELD_SPECS keys, in order', hvac.fields.map((f) => f.key), FIELD_SPECS.map((s) => s.key));
  let fieldMismatch = null;
  for (const f of hvac.fields) {
    const spec = FIELD_SPECS.find((s) => s.key === f.key);
    const label = FIELD_LABELS[f.key] ?? f.key;
    if (f.description !== spec.desc || f.label !== label || f.perUnit !== UNIT_SCOPED_FIELDS.has(f.key)) { fieldMismatch = f.key; break; }
  }
  check('hvac pack fields match extractFields.js/documentTypes.js label/description/perUnit exactly', fieldMismatch === null, fieldMismatch);

  eq('hvac pack synonyms === HVAC_TERM_SYNONYMS (contentCount.js)', hvac.synonyms, HVAC_TERM_SYNONYMS);
  check('hvac pack synonyms is the SAME object as HVAC_TERM_SYNONYMS (single source of truth)', hvac.synonyms === HVAC_TERM_SYNONYMS);
  eq('hvac pack abbreviations === ABBREV (nlNormalize.js)', hvac.abbreviations, ABBREV);
  check('hvac pack abbreviations is the SAME object as ABBREV', hvac.abbreviations === ABBREV);
  check('hvac pack warranty.brandRules is the SAME object as BRAND_RULES (warrantyRules.js)', hvac.warranty.brandRules === BRAND_RULES);
}

/* ================================================================== 3. pack-aware modules: default unchanged, pack-driven when passed */
{
  const dt = await import('../api/_lib/documentTypes.js');
  const ef = await import('../api/_lib/extractFields.js');
  const cc = await import('../api/_lib/contentCount.js');
  const nl = await import('../api/_lib/nlNormalize.js');
  const md = await import('../api/_lib/maintenanceDue.js');
  const wr = await import('../api/_lib/warrantyRules.js');
  const { AGENT_SYSTEM_PROMPT, buildAgentSystemPrompt } = await import('../api/_lib/agent/loop.js');

  const plumbing = getPack('plumbing');
  const electrical = getPack('electrical');
  const property = getPack('property');
  const hvac = getPack('hvac');

  // documentTypes.js
  check('documentTypeLabel default unchanged', dt.documentTypeLabel('invoice') === 'Invoice');
  check('documentTypeLabel with hvac pack unchanged', dt.documentTypeLabel('invoice', hvac) === 'Invoice');
  check('documentTypeLabel recognizes a plumbing-only type', dt.documentTypeLabel('backflow-test-certificate', plumbing) === 'Backflow test certificate');
  check('normalizeDocumentType recognizes a plumbing-only type via pack', dt.normalizeDocumentType('backflow-test-certificate', {}, plumbing) === 'backflow-test-certificate');
  check('normalizeDocumentType default unaware of plumbing-only type (falls to other)', dt.normalizeDocumentType('backflow-test-certificate') === 'other');
  const compDefault = dt.completenessFor('invoice', [{ field_key: 'cost', value: '10' }]);
  const compPack = dt.completenessFor('invoice', [{ field_key: 'cost', value: '10' }], hvac);
  eq('completenessFor default === completenessFor(hvac pack)', compDefault, compPack);
  const compPlumb = dt.completenessFor('backflow-test-certificate', [{ field_key: 'service_address', value: '1 Main St' }, { field_key: 'service_date', value: '2026-01-01' }], plumbing);
  check('completenessFor plumbing backflow cert missing backflow_test_result', compPlumb.missing.includes('backflow_test_result'));

  // extractFields.js
  const promptDefault = ef.buildExtractPrompt([{ page_no: 1, text: 'x' }], 'invoice');
  check('buildExtractPrompt default says "an HVAC company" (byte-identical wording)', promptDefault.includes('belonging to an HVAC company'));
  const promptPlumb = ef.buildExtractPrompt([{ page_no: 1, text: 'x' }], 'invoice', plumbing);
  check('buildExtractPrompt(plumbing) says "a plumbing company" and lists gallons', promptPlumb.includes('belonging to a plumbing company') && promptPlumb.includes('gallons'));
  const promptElec = ef.buildExtractPrompt([{ page_no: 1, text: 'x' }], 'invoice', electrical);
  check('buildExtractPrompt(electrical) uses "an electrical contractor" and lists amperage', promptElec.includes('belonging to an electrical contractor') && promptElec.includes('amperage'));
  const toolDefault = ef.buildExtractToolForPack(null);
  check('buildExtractToolForPack(null) === EXTRACT_TOOL', toolDefault === ef.EXTRACT_TOOL);
  const toolPlumb = ef.buildExtractToolForPack(plumbing);
  check('buildExtractToolForPack(plumbing) exposes plumbing field keys + doc types', toolPlumb.input_schema.properties.fields.items.properties.key.enum.includes('gallons') && toolPlumb.input_schema.properties.document_type.enum.includes('sewer-camera-report'));
  const normPlumb = ef.normalizeFields([{ key: 'gallons', value: '50', page_no: 1, confidence: 0.9 }], { pack: plumbing });
  eq('normalizeFields(pack: plumbing) keeps a plumbing-only field key', normPlumb.fields.map((f) => f.field_key), ['gallons']);
  const normDefaultDropsPlumbField = ef.normalizeFields([{ key: 'gallons', value: '50', page_no: 1, confidence: 0.9 }]);
  eq('normalizeFields default (no pack) drops an unknown-to-hvac field key', normDefaultDropsPlumbField.fields, []);
  const grouped = ef.groupFieldsByUnit(normPlumb.fields, plumbing);
  check('groupFieldsByUnit(plumbing) treats gallons as unit-scoped (untagged -> shared, still carried onto unit 1)', grouped.shared.gallons === '50' && grouped.units[0].facts.gallons === '50');

  // contentCount.js
  check('extractKnownTerms default recognizes hvac term "capacitor"', cc.extractKnownTerms('how many jobs mention a capacitor').includes('capacitor'));
  check('extractKnownTerms(plumbing) recognizes "water heater"/"tankless"', cc.extractKnownTerms('how many jobs mention a tankless water heater', plumbing).includes('tankless') && cc.extractKnownTerms('how many jobs mention a water heater', plumbing).includes('water heater'));
  check('extractKnownTerms default does NOT know plumbing-only "backflow"', !cc.extractKnownTerms('how many jobs mention backflow').includes('backflow'));
  const parsedPlumb = cc.parseContentCountQuestion('how many jobs mention a water heater', plumbing);
  check('parseContentCountQuestion(plumbing) recognizes the shape', Boolean(parsedPlumb) && parsedPlumb.terms.includes('water heater'));
  eq('expandTerms(["tankless"], plumbing) includes on-demand phrasing', cc.expandTerms(['tankless'], plumbing).includes('on-demand water heater'), true);
  check('canonicalizeTerm(plumbing) maps a variant to its group', cc.canonicalizeTerm('rpz', plumbing) === 'backflow');

  // nlNormalize.js
  const nDefault = nl.normalizeQuestion('how many custs have a genrator installed');
  const nElec = nl.normalizeQuestion('how many custs have a genrator installed', { pack: electrical });
  check('normalizeQuestion default does not know "genrator"', !nDefault.corrections.some((c) => c.to === 'generator'));
  check('normalizeQuestion(electrical) fixes "genrator" -> "generator"', nElec.corrections.some((c) => c.to === 'generator'));
  check('normalizeQuestion(hvac pack) behaves like default (byte-identical normalized text)', nl.normalizeQuestion('how many custs have a genrator installed', { pack: hvac }).normalized === nDefault.normalized);

  // maintenanceDue.js
  eq('parseCadenceMonths default unaffected by an electrical-only cadence phrase', md.parseCadenceMonths('panel inspection every three years'), null);
  eq('parseCadenceMonths(electrical) recognizes its own cadence phrase', md.parseCadenceMonths('panel inspection every three years per code', electrical), 36);
  eq('parseCadenceMonths generic phrasing unaffected by a pack', md.parseCadenceMonths('quarterly service', plumbing), 3);
  const seasonDefault = md.seasonWindow('fall', '2026-01-01');
  const seasonHvac = md.seasonWindow('fall', '2026-01-01', hvac);
  eq('seasonWindow default === seasonWindow(hvac pack)', seasonDefault, seasonHvac);
  // Round 7 (maintenanceDue.js): the scorecard oracle's own query is an INNER JOIN from customers to a qualifying
  // visit (never an agreement alone) - a customer with an agreement and NO visit on file has no row for the
  // oracle to compute a "last visit" from and is never a candidate at all, so this fixture now gives 'c1' one
  // (past, qualifying) visit to be judged - the same candidacy rule scripts/verify-r7-guardrails.mjs and
  // scripts/verify-round6.mjs already pin. What this check itself verifies (unstated cadence -> the pack's own
  // defaultCadenceMonths, 12 when absent) is unchanged and still holds.
  const cadenceComputeDefault = md.computeMaintenanceDue(
    {
      customers: [{ id: 'c1', name: 'A', address: 'x' }],
      agreements: [{ customerId: 'c1', documentId: 'd1', term: '', cadenceMonths: null, start: null, end: null }],
      visits: [{ customerId: 'c1', documentId: 'v1', date: '2026-01-01', documentType: 'service-ticket' }],
    },
    { today: '2026-06-01', mode: 'cadence', season: null, months: null, sinceYear: null },
  );
  check('computeMaintenanceDue default: unstated cadence falls back to 12 months', cadenceComputeDefault.checked[0].cadenceMonths === 12);

  // warrantyRules.js
  check('normalizeBrand default does not know a plumbing-only brand (Navien)', wr.normalizeBrand('Navien Inc') === null);
  check('normalizeBrand(plumbing) knows Navien', wr.normalizeBrand('Navien Inc', plumbing) === 'navien');
  const derivedPlumb = wr.deriveWarranty({ manufacturer: 'Navien Inc', installation_date: '2024-01-01' }, '2024-06-01', plumbing);
  check('deriveWarranty(plumbing) verifies a plumbing-only brand', derivedPlumb.brandVerified === true && derivedPlumb.brand === 'navien');
  eq('brandRulesForPack(null) === BRAND_RULES', wr.brandRulesForPack(null), wr.BRAND_RULES);

  // agent/loop.js
  check('AGENT_SYSTEM_PROMPT === buildAgentSystemPrompt(hvac pack)', AGENT_SYSTEM_PROMPT === buildAgentSystemPrompt(hvac));
  check('AGENT_SYSTEM_PROMPT === buildAgentSystemPrompt(null) (default)', AGENT_SYSTEM_PROMPT === buildAgentSystemPrompt(null));
  check('buildAgentSystemPrompt(plumbing) names the plumbing company, not HVAC', buildAgentSystemPrompt(plumbing).includes('a plumbing company') && !buildAgentSystemPrompt(plumbing).includes('HVAC shop'));
  check('buildAgentSystemPrompt(property) uses "an" (property management company)', buildAgentSystemPrompt(property).startsWith('You are Donovan, the records assistant for a property management company'));
}

/* ================================================================== 4. harness: real Postgres via PGlite */
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
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerant harness as verify-agent.mjs */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after the rest */ }

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
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function makeTenant(key, name, industry) {
  const id = (await getTenantContext(key, name)).id;
  if (industry) {
    await lite.query("UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('industry', $2::text) WHERE id = $1", [id, industry]);
  }
  return id;
}

const ctxHvac = { tenantKey: 'org_industry_hvac', tenantName: 'Desert Peak HVAC' };
const ctxPlumb = { tenantKey: 'org_industry_plumbing', tenantName: 'Canyon Plumbing Co' };
const ctxElec = { tenantKey: 'org_industry_electrical', tenantName: 'Sonoran Electrical' };
const ctxProp = { tenantKey: 'org_industry_property', tenantName: 'Mesa Property Group' };
const ctxNoIndustry = { tenantKey: 'org_industry_unset', tenantName: 'No Industry Set' };

const _tenHvac = await makeTenant(ctxHvac.tenantKey, ctxHvac.tenantName, 'hvac');
const tenPlumb = await makeTenant(ctxPlumb.tenantKey, ctxPlumb.tenantName, 'plumbing');
const tenElec = await makeTenant(ctxElec.tenantKey, ctxElec.tenantName, 'electrical');
const tenProp = await makeTenant(ctxProp.tenantKey, ctxProp.tenantName, 'property');
const _tenUnset = await makeTenant(ctxNoIndustry.tenantKey, ctxNoIndustry.tenantName, null);

resetPackForTenantCacheForTests();

check('packForTenant({withTenant,ctxArg}) resolves plumbing', (await packForTenant({ withTenant, ctxArg: ctxPlumb })).id === 'plumbing');
check('packForTenant({withTenant,ctxArg}) resolves electrical', (await packForTenant({ withTenant, ctxArg: ctxElec })).id === 'electrical');
check('packForTenant({withTenant,ctxArg}) resolves property', (await packForTenant({ withTenant, ctxArg: ctxProp })).id === 'property');
check('packForTenant({withTenant,ctxArg}) resolves hvac', (await packForTenant({ withTenant, ctxArg: ctxHvac })).id === 'hvac');
check('packForTenant defaults to hvac when settings has no industry key', (await packForTenant({ withTenant, ctxArg: ctxNoIndustry })).id === 'hvac');
check('packForTenant tolerates a bogus ctx (no withTenant) -> hvac', (await packForTenant({ tenantKey: 'nope' })).id === 'hvac');

await withTenant(ctxPlumb, async (db) => {
  check('packForTenant(db) resolves plumbing from inside an open transaction', (await packForTenant(db)).id === 'plumbing');
});
await withTenant(ctxUnsetSafe(), async (db) => {
  check('packForTenant(db) defaults to hvac for a tenant with no settings.industry', (await packForTenant(db)).id === 'hvac');
});
function ctxUnsetSafe() { return ctxNoIndustry; }

/* ---- seed minimal generic-table data per industry tenant, then run each pack's own oracle SQL ---- */
async function seedGeneric(tenantId, key, rows) {
  for (const r of rows) {
    await lite.query(
      'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(key, 'd', r.n), tenantId, r.file, r.type, `${key}-hash-${r.n}`, 'verified']);
    for (const f of r.facts ?? []) {
      await lite.query(
        'INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)',
        [tenantId, uid(key, 'd', r.n), f.key, f.value]);
    }
  }
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer','{\"customer_name\":\"Test Owner\"}'::jsonb)",
    [uid(key, 'c', 1), tenantId]);
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'equipment','{}'::jsonb)",
    [uid(key, 'e', 1), tenantId]);
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'technician','{}'::jsonb)",
    [uid(key, 'f', 1), tenantId]);
}

await seedGeneric(tenPlumb, 'b', [
  { n: 1, file: 'backflow-1.pdf', type: 'backflow-test-certificate', facts: [{ key: 'backflow_test_result', value: 'pass' }, { key: 'next_test_due', value: '2026-10-01' }] },
  { n: 2, file: 'wh-invoice.pdf', type: 'invoice', facts: [{ key: 'cost', value: '450.00' }, { key: 'manufacturer', value: 'Rheem' }, { key: 'equipment_type', value: 'water heater (tankless)' }, { key: 'gallons', value: '0' }] },
]);
await seedGeneric(tenElec, 'c', [
  { n: 1, file: 'panel-schedule.pdf', type: 'panel-schedule', facts: [{ key: 'amperage', value: '200' }] },
  { n: 2, file: 'generator-invoice.pdf', type: 'invoice', facts: [{ key: 'cost', value: '3200.00' }, { key: 'manufacturer', value: 'Generac' }] },
]);
await seedGeneric(tenProp, 'e', [
  { n: 1, file: 'lease-4b.pdf', type: 'lease-agreement', facts: [{ key: 'tenant_name', value: 'J. Alvarez' }, { key: 'lease_end_date', value: '2026-12-01' }, { key: 'rent_amount', value: '1450' }] },
  { n: 2, file: 'coi-vendor.pdf', type: 'certificate-of-insurance', facts: [{ key: 'coi_expires', value: '2026-11-01' }] },
]);

async function runOracleSample(db, pack, sampleIds) {
  for (const id of sampleIds) {
    const t = pack.examTemplates.find((x) => x.id === id);
    if (!t) { check(`${pack.id}: exam template ${id} exists`, false); continue; }
    const resolved = resolveOracle(t.oracle, db.tenantId);
    try {
      const { rows } = await db.raw(resolved.sql, resolved.values);
      check(`${pack.id}/${t.id}: oracle SQL runs against generic tables`, rows.length >= 1, JSON.stringify(rows));
    } catch (err) {
      check(`${pack.id}/${t.id}: oracle SQL runs against generic tables`, false, String(err?.message ?? err));
    }
  }
}

await withTenant(ctxPlumb, async (db) => {
  const pack = await packForTenant(db);
  await runOracleSample(db, pack, ['plumb-count-backflow-tests', 'plumb-backflow-pass', 'plumb-count-invoices', 'plumb-sum-invoice-total', 'plumb-count-customers', 'plumb-mentions-tankless']);

  // content-count, pack-driven: a plumbing tenant's own vocabulary.
  const { parseContentCountQuestion, runContentCount } = await import('../api/_lib/contentCount.js');
  const parsed = parseContentCountQuestion('how many jobs mention a tankless water heater', pack);
  check('plumbing tenant: content-count recognizes "tankless water heater"', Boolean(parsed));
  if (parsed) {
    const data = await runContentCount(db, parsed, pack);
    check('plumbing tenant: content-count runs and returns an honest answer', Boolean(data) && typeof data.text === 'string', JSON.stringify(data));
  }
});

await withTenant(ctxElec, async (db) => {
  const pack = await packForTenant(db);
  await runOracleSample(db, pack, ['elec-count-panel-schedules', 'elec-200amp', 'elec-count-invoices', 'elec-sum-invoice-total', 'elec-count-customers', 'elec-mentions-generator']);
});

await withTenant(ctxProp, async (db) => {
  const pack = await packForTenant(db);
  await runOracleSample(db, pack, ['prop-count-leases', 'prop-leases-expiring-60', 'prop-count-coi', 'prop-coi-expiring-30', 'prop-count-owners', 'prop-avg-rent']);
});

// hvac tenant: prove the same oracle mechanism works for the original industry too.
await withTenant(ctxHvac, async (db) => {
  const pack = await packForTenant(db);
  check('hvac tenant resolves the hvac pack via packForTenant(db)', pack.id === 'hvac');
  await runOracleSample(db, pack, ['hvac-count-invoices', 'hvac-count-customers']);
});

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(1);
}
console.log(`${passes} checks passed.`);
