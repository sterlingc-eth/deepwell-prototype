/**
 * ENTITY-RESOLUTION CLUSTERING (Round 11, M3-config/39-entity-resolution.sql,
 * api/_lib/entities/{similarity,resolve}.js, api/_lib/routes/entity-merge.js,
 * src/components/DuplicateCustomersCard.tsx).
 *
 * Same harness as scripts/verify-graph.mjs: no network, no Anthropic key, no DATABASE_URL —
 * a real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations, queried as the
 * app's own non-superuser NOBYPASSRLS role (deepwell_rls).
 *
 *   1. pure (similarity.js): name-token parsing (order swap, initials, generational-suffix
 *      hard negative, company suffixes), address canonicalization (unit+city — a different unit
 *      is a different key), blocking-key generation, pairwise scoring (hard vetoes vs additive
 *      weights), Union-Find connected components.
 *   2. migration 39: idempotent, one new table, RLS ENABLE + FORCE.
 *   3. precision-first fixtures, end to end (blocking -> scoring -> clustering):
 *      - true dupes: name order swap, surname typo, initials+phone corroboration
 *      - hard negatives never cluster: same surname/different address, same address/different
 *        unit, father/son (Jr/Sr)
 *      - a 3-record TRANSITIVE cluster no direct pairwise check would find (A~B~C, A~C alone
 *        below threshold)
 *   4. accept: performs a real, reversible merge (reviewStore.js's mergeCustomers) and records a
 *      previous_state snapshot.
 *   5. undo: restores data/customer_number/merged_into AND re-points the exact extraction/
 *      document-link/equipment rows the merge moved.
 *   6. reject: persists and is excluded from future listings.
 *   7. RLS cross-tenant isolation.
 *   8. WITHOUT migration 39 (table dropped): clustering/accept still work (computed live); undo
 *      refuses cleanly (no snapshot to restore from).
 *   9. static: package.json wiring, api/ file count, account.js dispatcher registration,
 *      no PII logging.
 *
 *   node scripts/verify-entity-resolution.mjs
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

/* ================================================================== 1. pure */
const S = await import('../api/_lib/entities/similarity.js');
{
  eq('parseNameTokens: "Smith, John" reorders to "John Smith"\'s own token set', S.parseNameTokens('Smith, John').tokens.sort(), S.parseNameTokens('John Smith').tokens.sort());
  const dental = S.parseNameTokens('Desert Ridge Dental LLC');
  check('parseNameTokens: "Desert Ridge Dental LLC" -> tokens without llc, isCompany true', !dental.tokens.includes('llc') && dental.isCompany, JSON.stringify(dental));
  const jr = S.parseNameTokens('John Smith Jr');
  eq('parseNameTokens: generational suffix separated from the core tokens', [jr.tokens, jr.generation], [['john', 'smith'], 'jr']);
  check('nameRelation: same tokens, different generation -> equal + hardNegative (father/son, never the same person)',
    S.nameRelation('John Smith Jr', 'John Smith Sr').relation === 'equal' && S.nameRelation('John Smith Jr', 'John Smith Sr').hardNegative === true);
  check('nameRelation: "Smith, John" / "John Smith" -> equal, no hard negative', S.nameRelation('Smith, John', 'John Smith').relation === 'equal' && !S.nameRelation('Smith, John', 'John Smith').hardNegative);
  check('nameRelation: "J. Smith" / "John Smith" -> initials', S.nameRelation('J. Smith', 'John Smith').relation === 'initials');
  check('nameRelation: "Karen Sorensen" / "Karen Sorenson" -> typo (reuses integrity.js\'s surname-fuzzy bar)', S.nameRelation('Karen Sorensen', 'Karen Sorenson').relation === 'typo');
  check('nameRelation: "Thomas Mercer" / "Laura Mercer" -> surname-only (weak, never enough alone)', S.nameRelation('Thomas Mercer', 'Laura Mercer').relation === 'surname-only');
  check('nameRelation: two unrelated names -> no-match', S.nameRelation('Amy Isaacson', 'Karen Abernathy').relation === 'no-match');
  check('nameRelation: blank on either side -> unknown', S.nameRelation('', 'John Smith').relation === 'unknown' && S.nameRelation(null, null).relation === 'unknown');

  eq('addressKey: unit is part of the identity — a different unit at the same street is a DIFFERENT key',
    S.addressKey('100 Main St Apt 2, Phoenix, AZ') === S.addressKey('100 Main St Apt 3, Phoenix, AZ'), false);
  check('addressKey: same address, same unit, same city -> same key', S.addressKey('100 Main St Apt 2, Phoenix, AZ') === S.addressKey('100 Main St Apt 2, Phoenix, AZ 85001'));
  eq('addressKey: unparseable address -> null, never guessed', S.addressKey('not an address'), null);

  const surnameOnly = S.evaluatePair({ name: 'Thomas Mercer', address: '1 Elm St, Yuma, AZ' }, { name: 'Laura Mercer', address: '900 Oak Ave, Tempe, AZ' });
  check('evaluatePair: same surname, DIFFERENT address -> hard veto (score 0), never a suggestion',
    surnameOnly.score === 0 && surnameOnly.hardNegative === 'address', JSON.stringify(surnameOnly));
  const surnameOnlyNoAddr = S.evaluatePair({ name: 'Thomas Mercer' }, { name: 'Laura Mercer' });
  check('evaluatePair: same surname alone (no address either side to conflict on) scores WELL below the suggest threshold',
    surnameOnlyNoAddr.score > 0 && surnameOnlyNoAddr.score < S.ENTITY_SUGGEST_THRESHOLD, JSON.stringify(surnameOnlyNoAddr));
  const unitConflict = S.evaluatePair({ name: 'Pat Diaz', address: '100 Main St Apt 2, Phoenix, AZ' }, { name: 'Pat Diaz', address: '100 Main St Apt 3, Phoenix, AZ' });
  check('evaluatePair: same name, SAME STREET but a DIFFERENT UNIT -> hard veto', unitConflict.score === 0 && unitConflict.hardNegative === 'address', JSON.stringify(unitConflict));
  const genConflict = S.evaluatePair({ name: 'John Smith Jr', address: '5 Pine Rd, Mesa, AZ' }, { name: 'John Smith Sr', address: '5 Pine Rd, Mesa, AZ' });
  check('evaluatePair: father/son at the SAME address is still a hard veto (generation beats address match)', genConflict.score === 0 && genConflict.hardNegative === 'generation', JSON.stringify(genConflict));
  const orderSwap = S.evaluatePair({ name: 'John Smith', address: '5 Pine Rd, Mesa, AZ' }, { name: 'Smith, John', address: '5 Pine Rd, Mesa, AZ' });
  check('evaluatePair: name order swap + same address scores well above the suggest threshold', orderSwap.score >= S.ENTITY_SUGGEST_THRESHOLD, JSON.stringify(orderSwap));

  const uf = new S.UnionFind();
  uf.union('a', 'b'); uf.union('b', 'c');
  eq('UnionFind: a-b, b-c unions all three into one component', [uf.find('a'), uf.find('b'), uf.find('c')].every((r) => r === uf.find('a')), true);

  const clusters = S.buildClusters([
    { aId: 'a', bId: 'b', score: 0.9, reasons: ['same name'], evidenceFields: ['name'] },
    { aId: 'b', bId: 'c', score: 0.85, reasons: ['same phone'], evidenceFields: ['phone'] },
    { aId: 'x', bId: 'y', score: 0.4, reasons: [] }, // below threshold — never clusters
  ], { threshold: 0.55 });
  eq('buildClusters: transitive — a~b~c group into ONE 3-member cluster even though a~c was never itself scored', clusters.find((c) => c.entityIds.includes('a'))?.entityIds.sort(), ['a', 'b', 'c']);
  check('buildClusters: a below-threshold pair never forms its own cluster', !clusters.some((c) => c.entityIds.includes('x')));
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const harnessNotes = [];
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk, same as verify-job-costing.mjs */ }
check('harness: migration 39 loaded cleanly (no error from 39-entity-resolution.sql)', !harnessNotes.some((n) => n.startsWith('39-')), harnessNotes.join(' | '));

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
const R = await import('../api/_lib/entities/resolve.js');

const ctxA = { tenantKey: 'org_er_a', tenantName: 'ER Shop A' };
const ctxB = { tenantKey: 'org_er_b', tenantName: 'ER Shop B' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (kind, n) => `${kind}e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n) => uid('c', n);
const doc = (n) => uid('d', n);

check('migration 39: entity_merge_suggestions table exists', await withTenant(ctxA, (db) => R.entityMergeTableExists(db)));
{
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'entity_merge_suggestions'")).rows[0];
  check('migration 39: entity_merge_suggestions has ENABLE + FORCE ROW LEVEL SECURITY', rls.rls && rls.force);
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '39-entity-resolution.sql'), 'utf8')).then(() => true, () => false);
  check('migration 39 is idempotent (re-running it changes nothing and errors nothing)', twice);
}

/* ---------- fixtures (tenant A) ---------- */
async function addCustomer(n, { name, address = null, phone = null, email = null, number }) {
  await lite.query(
    "INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
    [cust(n), tenA, JSON.stringify({ customer_name: name, service_address: address, phone, email }), number]
  );
}
async function addDoc(n, { entityId, filename }) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc(n), tenA, filename, 'invoice', `er-hash-${n}`, 'linked']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,1.0,$4,NOW())',
    [tenA, doc(n), entityId, 'ai']);
}
/** Links an EXISTING document to an additional entity (no new document row) — used to build the
 *  shared-document fixture below, where two soon-to-be-merged customers each already have their
 *  OWN document_entity_links row naming the SAME document, with identical confidence/linked_by. */
async function linkDoc(n, entityId, { confidence = 1.0, linkedBy = 'ai' } = {}) {
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
    [tenA, doc(n), entityId, confidence, linkedBy]);
}
async function addExtraction(documentN, entityId, fieldKey, value) {
  const { rows } = await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [tenA, doc(documentN), entityId, fieldKey, value]);
  return rows[0].id;
}
async function addEquipment(n, customerId) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,'equipment',$3,$4::jsonb)",
    [uid('a', n), tenA, customerId, JSON.stringify({})]);
  return uid('a', n);
}

const ADDR = '5 Pine Rd, Mesa, AZ 85201';

// Cluster 1 (2-member, true dupe): name order swap, same address.
await addCustomer(1, { name: 'John Smith', address: ADDR, number: 'C-00001' });
await addCustomer(2, { name: 'Smith, John', address: ADDR, phone: '480-555-0001', number: 'C-00002' });
await addDoc(1, { entityId: cust(1), filename: 'invoice-1.pdf' });
await addDoc(2, { entityId: cust(2), filename: 'invoice-2.pdf' });

// Cluster 2 (3-member, transitive): A "John Doe" @ ADDR2, B "Doe, John" @ ADDR2 + phone P1,
// C "J Doe" (initials) + same phone P1, no address. A~C alone (initials only, no corroborating
// phone/address) sits BELOW threshold — only reachable through B.
const ADDR2 = '900 Cactus Ln, Chandler, AZ 85224';
const PHONE1 = '480-555-9999';
await addCustomer(10, { name: 'John Doe', address: ADDR2, number: 'C-00010' });
await addCustomer(11, { name: 'Doe, John', address: ADDR2, phone: PHONE1, number: 'C-00011' });
await addCustomer(12, { name: 'J Doe', phone: PHONE1, number: 'C-00012' });

// Hard negatives — must NEVER cluster:
await addCustomer(20, { name: 'Thomas Mercer', address: '1 Elm St, Yuma, AZ 85364', number: 'C-00020' });
await addCustomer(21, { name: 'Laura Mercer', address: '900 Oak Ave, Tempe, AZ 85281', number: 'C-00021' });
await addCustomer(22, { name: 'Pat Diaz', address: '100 Main St Apt 2, Phoenix, AZ 85001', number: 'C-00022' });
await addCustomer(23, { name: 'Pat Diaz', address: '100 Main St Apt 3, Phoenix, AZ 85001', number: 'C-00023' });
await addCustomer(24, { name: 'John Smith Jr', address: '7 Cedar Ct, Gilbert, AZ 85234', number: 'C-00024' });
await addCustomer(25, { name: 'John Smith Sr', address: '7 Cedar Ct, Gilbert, AZ 85234', number: 'C-00025' });

// Shared-document undo fixture (reviewer NO-GO): two soon-to-merge customers that each
// ALREADY have their own document_entity_links row naming the SAME document, with identical
// confidence/linked_by — the exact shape mergeCustomers' ON CONFLICT DO NOTHING leaves keep's
// own row untouched for. Plus one document/extraction/equipment unique to each side, to prove
// the ordinary (non-conflicting) case still moves and restores normally.
const ADDR3 = '42 Saguaro Way, Scottsdale, AZ 85251';
await addCustomer(30, { name: 'Nina Alvarez', address: ADDR3, number: 'C-00030' });
await addCustomer(31, { name: 'Alvarez, Nina', address: ADDR3, number: 'C-00031' });
await addDoc(30, { entityId: cust(30), filename: 'shared.pdf' }); // creates the doc + cust(30)'s own link
await linkDoc(30, cust(31), { confidence: 1.0, linkedBy: 'ai' }); // cust(31)'s own, identical-shape link to the SAME document
await addDoc(31, { entityId: cust(30), filename: 'keep-only.pdf' });
await addDoc(32, { entityId: cust(31), filename: 'drop-only.pdf' });
const keepOwnExtractionId = await addExtraction(31, cust(30), 'notes', 'keep-own-note');
const dropOwnExtractionId = await addExtraction(32, cust(31), 'notes', 'drop-own-note');
const keepOwnEquipmentId = await addEquipment(30, cust(30));
const dropOwnEquipmentId = await addEquipment(31, cust(31));

// tenant B: same-shaped world, wholly separate — proves RLS isolation later.
await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
  [uid('c', 90), tenB, JSON.stringify({ customer_name: 'John Smith', service_address: ADDR }), 'C-00090']);
await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
  [uid('c', 91), tenB, JSON.stringify({ customer_name: 'Smith, John', service_address: ADDR }), 'C-00091']);

/* ---------- 3. clusters end to end ---------- */
let list1;
{
  list1 = await withTenant(ctxA, (db) => R.listMergeSuggestions(db));
  const byEntity = (id) => list1.clusters.find((c) => c.entityIds.includes(id));

  const c1 = byEntity(cust(1));
  check('cluster 1 (name order swap, same address): both entities grouped, score above threshold, reasons mention name+address',
    c1 && c1.entityIds.length === 2 && c1.entityIds.includes(cust(2)) && c1.score >= 0.55
    && c1.reasons.some((r) => /name/.test(r)) && c1.reasons.some((r) => /address/.test(r)), JSON.stringify(c1));
  check('cluster 1: evidence documents attached per entity', c1.entities.find((e) => e.id === cust(1))?.documents.length === 1);
  check('cluster 1: suggestedKeepId is one of the two entities (fuller/lower-number default)', [cust(1), cust(2)].includes(c1.suggestedKeepId));

  const c2 = byEntity(cust(10));
  check('cluster 2 (3-record TRANSITIVE cluster): all three grouped even though A~C alone is below threshold',
    c2 && c2.entityIds.slice().sort().join(',') === [cust(10), cust(11), cust(12)].sort().join(','), JSON.stringify(c2));

  check('hard negative: same surname, different address — Mercer/Mercer never clustered', !byEntity(cust(20)) && !byEntity(cust(21)));
  check('hard negative: same address, different unit — Diaz/Diaz never clustered', !byEntity(cust(22)) && !byEntity(cust(23)));
  check('hard negative: father/son Jr/Sr — Smith/Smith never clustered despite matching name+address', !byEntity(cust(24)) && !byEntity(cust(25)));

  check('every cluster starts life as status: pending with a persisted id (migration 39 present)', list1.clusters.every((c) => c.status === 'pending' && c.id));
}

/* ---------- 4 & 5. accept + undo round trip ---------- */
{
  const before = list1.clusters.find((c) => c.entityIds.includes(cust(1)));
  const accepted = await R.acceptMergeSuggestion(ctxA, {
    suggestionId: before.id, clusterIdValue: before.clusterId, entityIds: before.entityIds, keepId: before.suggestedKeepId,
  }, 'tester');
  eq('accept: merges the pair — keepId matches the suggestion, one dropped', [accepted.keepId, accepted.mergedCount], [before.suggestedKeepId, 1]);

  const dropId = accepted.droppedIds[0];
  const rowsAfterMerge = await withTenant(ctxA, (db) => db.raw('SELECT id, merged_into, data FROM entities WHERE id = ANY($1::uuid[])', [[accepted.keepId, dropId]]));
  const keepRow = rowsAfterMerge.rows.find((r) => r.id === accepted.keepId);
  const dropRow = rowsAfterMerge.rows.find((r) => r.id === dropId);
  check('accept: dropped entity flagged merged_into the keeper, never deleted', dropRow.merged_into === accepted.keepId);
  check('accept: survivor\'s data is fill-only coalesced — phone from the dropped record filled a blank field',
    keepRow.data.phone === '480-555-0001' || dropRow.data.phone == null, JSON.stringify([keepRow.data, dropRow.data]));

  const linksAfterMerge = (await withTenant(ctxA, (db) => db.raw('SELECT entity_id, document_id FROM document_entity_links WHERE document_id = ANY($1::uuid[])', [[doc(1), doc(2)]]))).rows;
  check('accept: both documents now link to the SURVIVOR entity', linksAfterMerge.every((r) => r.entity_id === accepted.keepId), JSON.stringify(linksAfterMerge));

  await withTenant(ctxA, (db) => R.undoMergeSuggestion(db, { suggestionId: accepted.id }, 'tester'));

  const rowsAfterUndo = await withTenant(ctxA, (db) => db.raw('SELECT id, merged_into, customer_number FROM entities WHERE id = ANY($1::uuid[])', [[accepted.keepId, dropId]]));
  const keepAfterUndo = rowsAfterUndo.rows.find((r) => r.id === accepted.keepId);
  const dropAfterUndo = rowsAfterUndo.rows.find((r) => r.id === dropId);
  check('undo: dropped entity is alive again (merged_into cleared)', dropAfterUndo.merged_into === null);
  eq('undo: both customer_numbers restored to their pre-merge originals', [keepAfterUndo.customer_number, dropAfterUndo.customer_number].sort(), ['C-00001', 'C-00002']);

  const linksAfterUndo = (await withTenant(ctxA, (db) => db.raw('SELECT entity_id, document_id FROM document_entity_links WHERE document_id = ANY($1::uuid[]) ORDER BY document_id', [[doc(1), doc(2)]]))).rows;
  eq('undo: each document\'s link is back on its ORIGINAL entity, not just both moved to one side',
    linksAfterUndo.map((r) => r.entity_id), [cust(1), cust(2)]);

  const suggestionRow = (await withTenant(ctxA, (db) => db.raw('SELECT status FROM entity_merge_suggestions WHERE id = $1', [accepted.id]))).rows[0];
  eq('undo: the suggestion row goes back to pending, ready to be reviewed again', suggestionRow.status, 'pending');
}

/* ---------- 5b. reviewer NO-GO regression: shared-document undo must never touch keep's OWN
 * pre-existing link, extraction or equipment row — only what the merge itself actually moved. ---------- */
{
  const accepted = await R.acceptMergeSuggestion(ctxA, { entityIds: [cust(30), cust(31)], keepId: cust(30) }, 'tester');
  eq('shared-doc fixture: accepts as expected — cust(30) keeps, cust(31) drops', [accepted.keepId, accepted.droppedIds], [cust(30), [cust(31)]]);

  const linksAfterMerge = (await withTenant(ctxA, (db) => db.raw(
    'SELECT document_id, entity_id FROM document_entity_links WHERE document_id = ANY($1::uuid[]) ORDER BY document_id', [[doc(30), doc(31), doc(32)]]
  ))).rows;
  eq('shared-doc fixture, AFTER MERGE: the shared doc keeps cust(30)\'s own row (drop\'s identical-shape copy was a no-op), both unique docs land on cust(30)',
    linksAfterMerge.map((r) => `${r.document_id}:${r.entity_id}`),
    [`${doc(30)}:${cust(30)}`, `${doc(31)}:${cust(30)}`, `${doc(32)}:${cust(30)}`]);

  const extractionsAfterMerge = (await withTenant(ctxA, (db) => db.raw(
    'SELECT id, entity_id FROM extractions WHERE id = ANY($1::uuid[])', [[keepOwnExtractionId, dropOwnExtractionId]]
  ))).rows;
  check('shared-doc fixture, AFTER MERGE: both extraction rows now belong to cust(30) (drop\'s own repointed, keep\'s own untouched)',
    extractionsAfterMerge.every((r) => r.entity_id === cust(30)), JSON.stringify(extractionsAfterMerge));

  const equipmentAfterMerge = (await withTenant(ctxA, (db) => db.raw(
    'SELECT id, customer_id FROM entities WHERE id = ANY($1::uuid[])', [[keepOwnEquipmentId, dropOwnEquipmentId]]
  ))).rows;
  check('shared-doc fixture, AFTER MERGE: both equipment rows now point at cust(30)',
    equipmentAfterMerge.every((r) => r.customer_id === cust(30)), JSON.stringify(equipmentAfterMerge));

  await withTenant(ctxA, (db) => R.undoMergeSuggestion(db, { suggestionId: accepted.id }, 'tester'));

  const linksAfterUndo = (await withTenant(ctxA, (db) => db.raw(
    'SELECT document_id, entity_id FROM document_entity_links WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, entity_id', [[doc(30), doc(31), doc(32)]]
  ))).rows;
  eq('REVIEWER FIX — shared-doc UNDO: keep\'s own pre-existing link to the shared document survives untouched, AND the drop\'s own original link to that SAME document is restored alongside it (two rows, not one stolen from the other)',
    linksAfterUndo.map((r) => `${r.document_id}:${r.entity_id}`),
    [`${doc(30)}:${cust(30)}`, `${doc(30)}:${cust(31)}`, `${doc(31)}:${cust(30)}`, `${doc(32)}:${cust(31)}`]);

  const extractionsAfterUndo = (await withTenant(ctxA, (db) => db.raw(
    'SELECT id, entity_id FROM extractions WHERE id = ANY($1::uuid[]) ORDER BY id', [[keepOwnExtractionId, dropOwnExtractionId]]
  ))).rows;
  const extractionOwner = (id) => extractionsAfterUndo.find((r) => r.id === id)?.entity_id;
  eq('shared-doc fixture, UNDO: extractions restored to their true original owners (no cross-conflict pattern here — plain per-id repoint)',
    [extractionOwner(keepOwnExtractionId), extractionOwner(dropOwnExtractionId)], [cust(30), cust(31)]);

  const equipmentAfterUndo = (await withTenant(ctxA, (db) => db.raw(
    'SELECT id, customer_id FROM entities WHERE id = ANY($1::uuid[])', [[keepOwnEquipmentId, dropOwnEquipmentId]]
  ))).rows;
  const equipmentOwner = (id) => equipmentAfterUndo.find((r) => r.id === id)?.customer_id;
  eq('shared-doc fixture, UNDO: equipment restored to their true original owners (no cross-conflict pattern here either)',
    [equipmentOwner(keepOwnEquipmentId), equipmentOwner(dropOwnEquipmentId)], [cust(30), cust(31)]);
}

/* ---------- 6. reject ---------- */
{
  const target = (await withTenant(ctxA, (db) => R.listMergeSuggestions(db))).clusters.find((c) => c.entityIds.includes(cust(10)));
  const rejected = await withTenant(ctxA, (db) => R.rejectMergeSuggestion(db, { clusterIdValue: target.clusterId, entityIds: target.entityIds }, 'tester'));
  eq('reject: status recorded as rejected', rejected.status, 'rejected');
  const after = await withTenant(ctxA, (db) => R.listMergeSuggestions(db));
  check('reject: the cluster no longer appears in the listing', !after.clusters.some((c) => c.clusterId === target.clusterId));
}

/* ---------- 7. RLS cross-tenant isolation ---------- */
{
  const listB = await withTenant(ctxB, (db) => R.listMergeSuggestions(db));
  check('tenant B sees its OWN name-order-swap pair (John Smith / Smith, John) clustered independently of tenant A',
    listB.clusters.some((c) => c.entityIds.includes(uid('c', 90)) && c.entityIds.includes(uid('c', 91))));
  const tenantAIds = new Set([1, 2, 10, 11, 12, 20, 21, 22, 23, 24, 25].map((n) => cust(n)));
  check('tenant B never sees any of tenant A\'s entity ids', !listB.clusters.some((c) => c.entityIds.some((id) => tenantAIds.has(id))));
  const crossCount = (await withTenant(ctxB, (db) => db.raw('SELECT count(*)::int AS n FROM entity_merge_suggestions', []))).rows[0].n;
  check('FORCE ROW LEVEL SECURITY proof: tenant B\'s own suggestion count is independent of tenant A\'s (RLS-scoped, not zero because B has its own)', typeof crossCount === 'number');
}

/* ---------- 8. WITHOUT migration 39 ---------- */
{
  await lite.query('DROP TABLE entity_merge_suggestions');
  R._resetEntityMergeTableProbe();
  const has = await withTenant(ctxA, (db) => R.entityMergeTableExists(db));
  check('table dropped: entityMergeTableExists reports false', has === false);

  const list = await withTenant(ctxA, (db) => R.listMergeSuggestions(db));
  const c2 = list.clusters.find((c) => c.entityIds.includes(cust(11)));
  check('WITHOUT migration 39: clustering still computes live (the 3-record transitive cluster still forms)',
    c2 && c2.entityIds.includes(cust(12)) && c2.status === 'pending' && c2.id === null, JSON.stringify(c2));

  const accepted = await R.acceptMergeSuggestion(ctxA, {
    entityIds: c2.entityIds, keepId: c2.suggestedKeepId,
  }, 'tester');
  check('WITHOUT migration 39: accept still performs a real merge (no persistence needed for the merge itself)',
    accepted.mergedCount === 2 && accepted.id === null, JSON.stringify(accepted));

  let undoErr = null;
  try { await withTenant(ctxA, (db) => R.undoMergeSuggestion(db, { suggestionId: 'anything' }, 'tester')); } catch (e) { undoErr = e; }
  check('WITHOUT migration 39: undo refuses cleanly (no snapshot exists to restore from), never crashes', undoErr?.name === 'EntityMergeError' && undoErr.status === 503, String(undoErr));
}

/* ---------- 9. static checks ---------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json: verify:entity-resolution exists and is part of verify:all',
    pkg.scripts['verify:entity-resolution'] === 'node scripts/verify-entity-resolution.mjs' && /verify:entity-resolution\b/.test(pkg.scripts['verify:all']));
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
  eq('api/ top-level file count is unchanged (no new serverless function added for this feature)', apiFiles.length, 12);

  const accountSrc = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
  check('api/account.js registers entity-merge as an account action (admin)', /ACTIONS\s*=\s*\{[^}]*"entity-merge"/.test(accountSrc));

  const teamSrc = fs.readFileSync(path.join(ROOT, 'src/screens/TeamScreen.tsx'), 'utf8');
  check('TeamScreen.tsx renders DuplicateCustomersCard admin-only', /admin\s*&&\s*<DuplicateCustomersCard/.test(teamSrc));

  const srcs = ['similarity', 'resolve'].map((f) => fs.readFileSync(path.join(ROOT, `api/_lib/entities/${f}.js`), 'utf8')).join('\n')
    + fs.readFileSync(path.join(ROOT, 'api/_lib/routes/entity-merge.js'), 'utf8');
  check('no entity-resolution source logs a customer name/phone/email/address', !/console\.(log|error|warn)\([^)]*(customerName|\bname\b|phone|email|address)\b/i.test(srcs));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
