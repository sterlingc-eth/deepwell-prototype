/**
 * Round 14 K1 — api/_lib/suggest/{classify,templates,vocabExtras}.js + api/_lib/routes/ask-suggest.js.
 *
 * Same harness convention as scripts/verify-vocab.mjs: pure checks first (no database at all), then a
 * REAL Postgres (PGlite, from the actual M3-config/*.sql migrations, through the app's own RLS role) for
 * the tenant-scoped vocabExtras cache. No network, no Anthropic key.
 *
 *   node scripts/verify-ask-suggest.mjs
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
console.error = () => {};

/* ================================================================== 1. pure: classify.js */
const Classify = await import('../api/_lib/suggest/classify.js');
const Templates = await import('../api/_lib/suggest/templates.js');

{
  const meta = Classify.routesWithoutModel('How many documents do we have?');
  check('routesWithoutModel: a meta-router question is model-free (route: meta)', meta.matched && meta.route === 'meta', JSON.stringify(meta));

  const gibberish = Classify.routesWithoutModel('purple elephants dance quietly forever maybe');
  check('routesWithoutModel: a shapeless, anchor-less question matches nothing', !gibberish.matched, JSON.stringify(gibberish));

  const empty = Classify.routesWithoutModel('   ');
  check('routesWithoutModel: blank input never matches', !empty.matched);
}

{
  check('classifyPreflight: empty text -> null (nothing to hint about yet)', Classify.classifyPreflight('') === null);
  check('classifyPreflight: whitespace-only -> null', Classify.classifyPreflight('   ') === null);

  const instant = Classify.classifyPreflight('How many customers do we have?');
  check('classifyPreflight: a meta question is INSTANT', instant?.level === Classify.PREFLIGHT.INSTANT, JSON.stringify(instant));

  const vocab = { customers: Templates.TEMPLATE_DEFS ? { phrases: ['Marisol Vega'] } : null };
  const anchored = Classify.classifyPreflight('tell me something interesting about Marisol Vega', { tenantVocab: vocab });
  check('classifyPreflight: an unmatched question NAMING a real tenant customer is SLOW, not NEEDS_ANCHOR',
    anchored?.level === Classify.PREFLIGHT.SLOW, JSON.stringify(anchored));

  const bare = Classify.classifyPreflight('tell me something interesting', { tenantVocab: { customers: { phrases: [] }, technicians: { phrases: [] } } });
  check('classifyPreflight: an unmatched question with NO anchor at all asks for one',
    bare?.level === Classify.PREFLIGHT.NEEDS_ANCHOR, JSON.stringify(bare));

  const dated = Classify.classifyPreflight('tell me something interesting from 2024');
  check('classifyPreflight: a bare year counts as an anchor -> SLOW, not NEEDS_ANCHOR', dated?.level === Classify.PREFLIGHT.SLOW, JSON.stringify(dated));
}

{
  const vocab = { customers: { phrases: ['Marisol Vega'] }, technicians: { phrases: [] } };
  check('hasAnchor: a real customer name on file is an anchor', Classify.hasAnchor('anything about Marisol Vega', vocab));
  check('hasAnchor: an address-shaped span is an anchor', Classify.hasAnchor('the unit at 214 Mercer St', null));
  check('hasAnchor: a 5-digit zip is an anchor', Classify.hasAnchor('customers in 85122', null));
  check('hasAnchor: no name/address/date/zip at all is not an anchor', !Classify.hasAnchor('tell me something interesting', vocab));
}

/* ================================================================== 2. pure: templates.js */
const FULL_VOCAB = {
  serials: ['M900123'],
  addresses: ['214 Mercer St'],
  customers: { phrases: ['Marisol Vega'] },
  technicians: { phrases: ['Danny Ochoa'] },
  brands: ['Trane'],
  docTypePhrases: [{ id: 'warranty', phrase: 'warranty registration' }],
};

{
  const tech = Templates.buildValidatedPrompts(FULL_VOCAB, { role: 'tech' });
  check('buildValidatedPrompts: tech role returns at least one prompt from a full tenant vocab', tech.length > 0, JSON.stringify(tech));
  check('buildValidatedPrompts: every returned prompt actually validates (routesWithoutModel)', tech.every((p) => Classify.routesWithoutModel(p.text).matched), JSON.stringify(tech));
  check('buildValidatedPrompts: tech role never returns an office-only template', tech.every((p) => !['brand-count', 'doctype-count'].includes(p.category)), JSON.stringify(tech.map((p) => p.category)));

  const office = Templates.buildValidatedPrompts(FULL_VOCAB, { role: 'office' });
  check('buildValidatedPrompts: office role returns at least one prompt', office.length > 0, JSON.stringify(office));
  check('buildValidatedPrompts: office role never returns a tech-only template', office.every((p) => !['warranty-serial', 'contact-customer'].includes(p.category)), JSON.stringify(office.map((p) => p.category)));

  const empty = Templates.buildValidatedPrompts({}, { role: 'tech' });
  check('buildValidatedPrompts: an empty vocab still offers the no-fill-needed templates, never a template with a blank slot',
    empty.every((p) => !p.text.includes('undefined') && !p.text.includes('null')), JSON.stringify(empty));

  const all = Templates.buildValidatedPrompts(FULL_VOCAB, { role: null });
  check('buildValidatedPrompts: role=null merges both personas', all.length >= tech.length && all.length >= office.length);
}

{
  const candidates = [
    { id: 'a', text: 'Is M900123 still under warranty?', category: 'warranty-serial' },
    { id: 'b', text: "What's the phone number on file for Marisol Vega?", category: 'contact-customer' },
    { id: 'c', text: 'How many documents do we have on file?', category: 'doc-count' },
  ];
  const byPrefix = Templates.rankTypeahead('is m9', candidates);
  check('rankTypeahead: a prefix match ranks first', byPrefix[0]?.id === 'a', JSON.stringify(byPrefix));

  const byWord = Templates.rankTypeahead('vega', candidates);
  check('rankTypeahead: a mid-sentence word match still surfaces the right candidate', byWord.some((c) => c.id === 'b'), JSON.stringify(byWord));

  const noMatch = Templates.rankTypeahead('zzzzzz', candidates);
  check('rankTypeahead: nothing matching returns nothing (never a wrong guess)', noMatch.length === 0);

  const blank = Templates.rankTypeahead('', candidates, 2);
  check('rankTypeahead: empty text just returns the first N candidates unranked', blank.length === 2 && blank[0].id === 'a');
}

{
  const chips = Templates.buildDidYouMean('what is the phone number for vaga', FULL_VOCAB, {}, {
    correctTenantNameTypos: () => ({ corrected: 'what is the phone number for Marisol Vega' }),
  });
  check('buildDidYouMean: a spelling-fix chip is offered when it changes the text', chips.some((c) => c.text.includes('Marisol Vega')), JSON.stringify(chips));

  const noCorrection = Templates.buildDidYouMean('tell me something', FULL_VOCAB, {}, {});
  check('buildDidYouMean: with no correction available, an "add the missing entity" chip is still offered',
    noCorrection.some((c) => c.text.includes('214 Mercer St') || c.text.includes('Marisol Vega')), JSON.stringify(noCorrection));
  check('buildDidYouMean: never repeats the original question verbatim', !noCorrection.some((c) => c.text.toLowerCase() === 'tell me something'));

  const nothing = Templates.buildDidYouMean('', FULL_VOCAB, {}, {});
  check('buildDidYouMean: blank input -> no chips', nothing.length === 0);

  const capped = Templates.buildDidYouMean('what is the phone number for vaga', FULL_VOCAB, {}, {
    correctTenantNameTypos: () => ({ corrected: 'what is the phone number for Marisol Vega' }),
  });
  check('buildDidYouMean: caps at 3 chips', capped.length <= 3);
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
const VocabExtras = await import('../api/_lib/suggest/vocabExtras.js');
const tenIdA = (await getTenantContext('org_suggest_a', 'Suggest Shop A')).id;
const tenIdB = (await getTenantContext('org_suggest_b', 'Suggest Shop B')).id;
const uid = (t, kind, n) => `da500000-0000-4000-8${kind}00-${t}${String(n).padStart(11, '0')}`;

async function addCustomer(tenId, tag, n, name, address) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,\'customer\',$3::jsonb)',
    [uid(tag, 'c', n), tenId, JSON.stringify({ customer_name: name, service_address: address })]);
}
async function addEquipment(tenId, tag, n, serial, manufacturer) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,\'equipment\',$3::jsonb)',
    [uid(tag, 'e', n), tenId, JSON.stringify({ serial_number: serial, manufacturer })]);
}

await addCustomer(tenIdA, '1', 1, 'Marisol Vega', '214 Mercer St, Mesa, AZ 85201');
await addEquipment(tenIdA, '1', 1, 'M900123', 'Trane');
await addCustomer(tenIdB, '2', 1, 'Someone Else', '900 Other Rd, Tempe, AZ 85281');

{
  const extrasA = await withTenant({ tenantKey: 'org_suggest_a', tenantName: 'Suggest Shop A' }, (db) => VocabExtras.getSuggestVocabExtras(db, 'org_suggest_a'));
  check('getSuggestVocabExtras: this tenant\'s own address is present', extrasA.addresses.some((a) => a.includes('214 Mercer St')), JSON.stringify(extrasA));
  check('getSuggestVocabExtras: this tenant\'s own serial is present', extrasA.serials.includes('M900123'), JSON.stringify(extrasA));
  check('getSuggestVocabExtras: zip derived from the address', extrasA.zips.includes('85201'), JSON.stringify(extrasA));

  const extrasB = await withTenant({ tenantKey: 'org_suggest_b', tenantName: 'Suggest Shop B' }, (db) => VocabExtras.getSuggestVocabExtras(db, 'org_suggest_b'));
  check('getSuggestVocabExtras: TENANT ISOLATION — tenant B never sees tenant A\'s address', !extrasB.addresses.some((a) => a.includes('Mercer')), JSON.stringify(extrasB));
  check('getSuggestVocabExtras: TENANT ISOLATION — tenant B never sees tenant A\'s serial', !extrasB.serials.includes('M900123'), JSON.stringify(extrasB));
  check('getSuggestVocabExtras: tenant B sees only its own address', extrasB.addresses.some((a) => a.includes('Other Rd')), JSON.stringify(extrasB));
}

{
  const ctxA = { tenantKey: 'org_suggest_a', tenantName: 'Suggest Shop A' };
  const v1 = await withTenant(ctxA, (db) => VocabExtras.getSuggestVocabExtras(db, 'org_suggest_a'));
  await addEquipment(tenIdA, '1', 2, 'ZZ999', 'Carrier');
  VocabExtras.resetSuggestVocabExtrasCacheForTests();
  const v2 = await withTenant(ctxA, (db) => VocabExtras.getSuggestVocabExtras(db, 'org_suggest_a'));
  check('getSuggestVocabExtras: rebuilds and picks up a newly added serial after invalidation', v2.serials.includes('ZZ999') && !v1.serials.includes('ZZ999'), `${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`);
}

console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
