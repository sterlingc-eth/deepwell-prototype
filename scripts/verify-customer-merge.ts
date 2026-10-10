/**
 * DUPLICATE CUSTOMERS: grouping, bulk merge, "This is us", prevention, sample data.
 *   tsx scripts/verify-customer-merge.ts
 *
 * No network, no Anthropic key, no DATABASE_URL: a real Postgres (PGlite) loaded from the actual
 * M3-config/*.sql migrations, queried as the app's own non-superuser role (deepwell_rls), same
 * harness as scripts/verify-entity-resolution.mjs.
 *
 *   1. grouping (pure): exact, near (spelling / Inc-LLC / typo / same email or phone), the company itself
 *   2. prevention (pure + createCustomer + findOrCreateCustomer): a new customer matches an existing one
 *   3. database: review -> merge all exact -> every link/document/extraction/unit moved -> logged -> undo
 *   4. database: "This is us" -> documents become company papers, record leaves the list, undo restores
 *   5. tenant isolation
 *   6. sample data: no committed sample set names one customer twice
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ' - ' + JSON.stringify(detail)}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

/* ================================================================ 1. grouping */
// @ts-ignore plain JS module
const I: any = await import('../api/_lib/integrity.js');
const rec = (n: number, name: string, extra: Record<string, unknown> = {}) => ({
  id: `r${n}`, customerNumber: `C-${String(n).padStart(5, '0')}`, name, address: '', phone: '', email: '', docCount: 0, ...extra,
});
{
  check('customerNameKey ignores case, punctuation, & vs and, a leading The, and a trailing Inc/LLC/Co',
    I.customerNameKey('The Brightwater Painting Co.') === 'brightwater painting' && I.customerNameKey('Larkspur Ledger Bookkeeping & Tax, LLC') === I.customerNameKey('larkspur ledger bookkeeping and tax'));
  check('customerNameKey keeps real words (Plumbing / Group are part of the name)', I.customerNameKey('Bishop Plumbing Group') === 'bishop plumbing group');
  check('isCompanyOwnName: matches with Inc/LLC and case differences', I.isCompanyOwnName('juniper lane mercantile, LLC', ['Juniper Lane Mercantile']) && !I.isCompanyOwnName('Juniper Lane Bakery', ['Juniper Lane Mercantile']));

  const list = [
    rec(1, 'Cardinal Ridge Construction', { docCount: 1 }),
    rec(2, 'Cardinal Ridge Construction', { address: '1 A St, Mesa, AZ 85201' }),
    rec(3, 'Cardinal Ridge Construction'),
    rec(4, 'Dennis Nash', { address: '7 Prairie Way, Round Rock, TX 78688' }),
    rec(5, 'Dennis Nash', { address: '8 Bluebonnet Ct, Austin, TX 78716' }),
    rec(6, 'Sofia Calloway', { phone: '(520) 555-0178' }),
    rec(7, 'Sofia Calloway', { phone: '(520) 555-0999' }),
    rec(8, 'Bridgeway Brewing Inc.'),
    rec(9, 'bridgeway brewing, inc'),
    rec(10, 'Harborlight Neighbors Alliance'),
    rec(11, 'Harboright Neighbors Alliance'),
    rec(12, 'Camila Nguyen', { email: 'c@example.org' }),
    rec(13, 'Nguyen, T.', { email: 'c@example.org' }),
    rec(14, 'Juniper Lane Mercantile'),
    rec(15, 'Juniper Lane Mercantile, LLC'),
    rec(16, 'Customer at 544 E Ray Rd'), rec(17, 'Customer at 544 E Ray Rd'),
    rec(18, 'Unique Person'),
  ];
  const g = I.groupDuplicateCustomers(list, { ownNames: ['Juniper Lane Mercantile'] });
  const ex = (name: string) => g.exact.find((x: any) => x.name === name);
  check('exact: the identical names form groups', ex('Cardinal Ridge Construction')?.ids.length === 3 && g.exact.length === 3, g.exact.map((x: any) => x.name));
  check('exact: the main record is the one with documents', ex('Cardinal Ridge Construction').mainId === 'r1');
  check('exact: a business with several sites is safe to merge', ex('Cardinal Ridge Construction').safe === true);
  check('exact: two people of one name in different cities need a look (not safe)', ex('Dennis Nash').safe === false && ex('Dennis Nash').conflicts.includes('city'));
  check('exact: different phones on one name need a look (not safe)', ex('Sofia Calloway').safe === false && ex('Sofia Calloway').conflicts.includes('phone'));
  const near = (re: RegExp) => g.near.find((x: any) => x.ids.some((id: string) => re.test(list.find((l) => l.id === id)!.name)));
  check('near: Inc / comma / case spelling variants', near(/Bridgeway/)?.ids.length === 2 && near(/Bridgeway/).reasons.includes('spelling'));
  check('near: a one-letter typo in a long name', near(/Harbor/)?.ids.length === 2 && near(/Harbor/).reasons.includes('typo'));
  check('near: the same email on two different names', near(/Camila/)?.ids.length === 2 && near(/Camila/).reasons.includes('same email'));
  check('company: records with the company name (any suffix) go to self, never to a group', g.self.length === 2 && !g.exact.some((x: any) => /juniper/i.test(x.name)) && !g.near.some((x: any) => /juniper/i.test(x.name)));
  check('placeholders ("Customer at ...") and unique names are never grouped', !g.exact.some((x: any) => /Customer at/.test(x.name)) && !near(/Unique/));
  check('a phone shared by many unrelated names is a shared line, not a person',
    I.groupDuplicateCustomers([1, 2, 3, 4, 5].map((n) => rec(n, `Person${n} Lastname${n}x`, { phone: '(520) 555-1111' }))).near.length === 0);
}

/* ============================================================ 2. prevention (pure) */
{
  const existing = [
    { id: 'e1', customerNumber: 'C-00001', name: 'Brightwater Painting Co.', address: '1 A St, Mesa, AZ 85201', phone: '(480) 555-0100', email: '' },
    { id: 'e2', customerNumber: 'C-00002', name: 'Dana Whitfield', address: '9 B St, Tempe, AZ 85281', phone: '', email: 'dana@example.com' },
  ];
  const f = (c: any, o?: any) => I.findExistingCustomerForCreate(c, existing, o);
  check('create: same name with Inc/LLC/Co/case differences finds the existing record', f({ name: 'BRIGHTWATER PAINTING, LLC' })?.match?.id === 'e1');
  check('create: the same name but a different phone is not the same customer', f({ name: 'Brightwater Painting', phone: '(480) 555-0999' }) === null);
  check('create: same name and same phone is confirmed by contact', f({ name: 'Brightwater Painting', phone: '480-555-0100' })?.basis === 'name-and-contact');
  check('create: a different spelling needs the same email or phone', f({ name: 'D. Whitfield', email: 'DANA@example.com' })?.match?.id === 'e2' && f({ name: 'D. Whitfield' }) === null);
  check('create: the company\'s own name is refused as a customer', f({ name: 'Acme Co' }, { ownNames: ['Acme Company'] })?.kind === 'self');
  check('create: a brand-new name finds nothing', f({ name: 'Totally New Customer' }) === null);
}
// @ts-ignore
const RS: any = await import('../api/_lib/recordsStore.js');
{
  const cands = [{ id: 'k1', customer_number: 'C-00005', data: { customer_name: 'Cardinal Ridge Construction' } }, { id: 'k2', customer_number: 'C-00009', data: { customer_name: 'Cardinal Ridge Construction', service_address: '2678 Ironwood St, Phoenix, AZ' } }];
  check('document match: a business name with no address on file matches the lowest-numbered record, not "don\'t know"',
    RS.selectCustomerMatch(cands, { name: 'Cardinal Ridge Construction', address: '77 New Site Rd, Gilbert, AZ' })?.id === 'k1');
  check('document match: a business name with no address in the document still resolves to one record',
    RS.selectCustomerMatch(cands, { name: 'Cardinal Ridge Construction', address: '' })?.id === 'k1');
  const people = [{ id: 'p1', customer_number: 'C-00001', data: { customer_name: 'Alex Rivera', service_address: '1 A St, Mesa, AZ 85201' } }];
  check('document match: two people of one name at different addresses stay separate (privacy rule kept)',
    RS.selectCustomerMatch(people, { name: 'Alex Rivera', address: '9 Z Ave, Tucson, AZ 85701' }) === null);
  check('document match: the same person with the same email is matched even at a new address',
    RS.selectCustomerMatch([{ id: 'p1', customer_number: 'C-00001', data: { customer_name: 'Alex Rivera', service_address: '1 A St, Mesa, AZ 85201', email: 'alex@example.com' } }], { name: 'Alex Rivera', address: '9 Z Ave, Tucson, AZ 85701', email: 'alex@example.com' })?.id === 'p1');
}

/* ================================================================== database */
let PGlite: any;
const contrib: Record<string, unknown> = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err: any) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log(`${passes} checks passed, ${failures} failed (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same pre-existing harness quirks as the other PGlite scripts */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* ignore */ }
// @ts-ignore
const pgMod: any = (await import('pg')).default;
let tail: Promise<unknown> = Promise.resolve();
const lock = () => { let release: () => void = () => {}; const p = new Promise<void>((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql: string, params?: unknown[]) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql: string, params?: unknown[]) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

// @ts-ignore
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
// @ts-ignore
const B: any = await import('../api/_lib/entities/bulkMerge.js');
// @ts-ignore
const R: any = await import('../api/_lib/entities/resolve.js');
// @ts-ignore
const RV: any = await import('../api/_lib/reviewStore.js');

const ctxA = { tenantKey: 'org_cm_a', tenantName: 'Juniper Lane Mercantile' };
const ctxB = { tenantKey: 'org_cm_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (kind: string, n: number) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n: number) => uid('c', n);
const docId = (n: number) => uid('d', n);

async function addCustomer(tenant: string, n: number, name: string, number: string, data: Record<string, unknown> = {}) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
    [cust(n), tenant, JSON.stringify({ customer_name: name, ...data }), number]);
}
async function addDoc(tenant: string, n: number, entityId: string, type = 'invoice') {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [docId(n), tenant, `doc-${n}.pdf`, type, `cm-hash-${n}`, 'linked']);
  await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,1.0,$4,NOW())', [tenant, docId(n), entityId, 'ai']);
}
async function addExtraction(tenant: string, n: number, entityId: string, key: string, value: string) {
  const { rows } = await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tenant, docId(n), entityId, key, value]);
  return rows[0].id as string;
}
async function addEquipment(tenant: string, n: number, customerId: string) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,'equipment',$3,$4::jsonb)", [uid('a', n), tenant, customerId, JSON.stringify({ serial_number: `S${n}` })]);
  return uid('a', n);
}

// Group X: a business with three records, three different sites, documents/units/extractions on each.
await addCustomer(tenA, 1, 'Cardinal Ridge Construction', 'C-00001', { email: 'office@cardinalridge.example' });
await addCustomer(tenA, 2, 'Cardinal Ridge Construction', 'C-00002', { email: 'office@cardinalridge.example', service_address: '2678 Ironwood St, Phoenix, AZ 85036', phone: '(602) 555-0111' });
await addCustomer(tenA, 3, 'Cardinal Ridge Construction', 'C-00003', { email: 'office@cardinalridge.example', service_address: '7777 Canyon Way, Gilbert, AZ 85219' });
await addDoc(tenA, 1, cust(1)); await addDoc(tenA, 2, cust(2)); await addDoc(tenA, 3, cust(3)); await addDoc(tenA, 4, cust(3));
const x1 = await addExtraction(tenA, 2, cust(2), 'notes', 'on drop 2');
const e2 = await addEquipment(tenA, 1, cust(2)); const e3 = await addEquipment(tenA, 2, cust(3));
// Group Y: another exact pair.
await addCustomer(tenA, 4, 'Verde Logistics Inc.', 'C-00004', { phone: '(480) 555-0142' }); await addCustomer(tenA, 5, 'Verde Logistics Inc.', 'C-00005', { phone: '480-555-0142' });
// Group W: two people of one name and nothing else in common -> stays "Check first".
await addCustomer(tenA, 14, 'Pat Rivera', 'C-00014'); await addCustomer(tenA, 15, 'Pat Rivera', 'C-00015');
await addDoc(tenA, 5, cust(5));
// Group Z: same name but different phones -> needs a look, must NOT be merged by "merge all".
await addCustomer(tenA, 6, 'Sofia Calloway', 'C-00006', { phone: '(520) 555-0178' }); await addCustomer(tenA, 7, 'Sofia Calloway', 'C-00007', { phone: '(520) 555-0999' });
// Near: a spelling variant.
await addCustomer(tenA, 8, 'Bridgeway Brewing Inc.', 'C-00008'); await addCustomer(tenA, 9, 'Bridgeway Brewing', 'C-00009');
// The company itself, three times, with papers and a unit.
await addCustomer(tenA, 10, 'Juniper Lane Mercantile', 'C-00010'); await addCustomer(tenA, 11, 'Juniper Lane Mercantile', 'C-00011', { service_address: '5243 E Copper Ct, Franklin, TN 37040' });
await addCustomer(tenA, 12, 'Juniper Lane Mercantile', 'C-00012');
await addDoc(tenA, 10, cust(10), 'receipt'); await addDoc(tenA, 11, cust(11), 'invoice'); await addDoc(tenA, 12, cust(12), 'invoice');
await addDoc(tenA, 13, cust(12), 'invoice'); await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at) VALUES ($1,$2,$3,1.0,$4,NOW())', [tenA, docId(13), cust(5), 'ai']); // doc 13 also names a real customer
const ownEq = await addEquipment(tenA, 3, cust(11));
// A person who already chose a folder for a company paper keeps it.
await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'_company_folder','insurance-legal',1)", [tenA, docId(12)]);
// Tenant B: an unrelated tenant with the same names.
await addCustomer(tenB, 90, 'Cardinal Ridge Construction', 'C-00001', { phone: '602-555-0111' }); await addCustomer(tenB, 91, 'Cardinal Ridge Construction', 'C-00002', { phone: '(602) 555-0111' });
await addCustomer(tenB, 92, 'Juniper Lane Mercantile', 'C-00003'); await addDoc(tenB, 90, cust(92));

const migrated39 = (await lite.query("SELECT to_regclass('public.entity_merge_suggestions') IS NOT NULL AS ok")).rows[0].ok;
check('harness: migration 39 (undo snapshots) is loaded', migrated39);

/* ---------- review ---------- */
let review: any;
{
  review = await withTenant(ctxA, (db: any) => B.reviewDuplicates(db));
  check('review: the whole customer list is scanned (no 200 cap) and the company name comes from the account', review.companyName === 'Juniper Lane Mercantile' && review.summary.customers === 14, review.summary);
  const gx = review.exact.find((g: any) => g.name === 'Cardinal Ridge Construction');
  check('review: exact group lists every record with documents / links / units counted', gx.ids.length === 3 && gx.totals.documents === 4 && gx.totals.links === 4 && gx.totals.equipment === 2, gx.totals);
  check('review: suggested main record is the one with the most documents', gx.mainId === cust(3));
  check('review: groups with conflicting phones are flagged, not safe', review.exact.find((g: any) => g.name === 'Sofia Calloway').safe === false);
  const pat = review.exact.find((g: any) => g.name === 'Pat Rivera');
  check('review: same name with nothing else in common is "check first", not safe', pat.safe === false && pat.nameOnly === true);
  check('review: same name with a shared email or phone is safe', review.exact.find((g: any) => g.name === 'Verde Logistics Inc.').safe === true);
  check('review: spelling variants land in "similar names"', review.near.length === 1 && review.near[0].ids.length === 2);
  check('review: the three company-name records are listed as "this is us" candidates', review.self.length === 3 && review.summary.selfRecords === 3);
}

/* ---------- merge all exact ---------- */
let bulk: any;
const beforeLinks = (await lite.query('SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1', [tenA])).rows[0].n;
{
  bulk = await B.mergeAllExact(ctxA, 'user_cm_admin');
  check('merge all: only the safe groups merged (2), the conflicting group left for a look', bulk.merged.length === 2 && bulk.remaining === 0 && bulk.needsReview === 2 && bulk.failed.length === 0, bulk);
  const keep = cust(3);
  const links = (await lite.query('SELECT entity_id, count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1 AND document_id = ANY($2::uuid[]) GROUP BY entity_id', [tenA, [1, 2, 3, 4].map(docId)])).rows;
  check('merge: every document link of the group now points at the kept record', links.length === 1 && links[0].entity_id === keep && links[0].n === 4, links);
  const eq = (await lite.query('SELECT id, customer_id FROM entities WHERE id = ANY($1::uuid[])', [[e2, e3]])).rows;
  check('merge: every unit now belongs to the kept record', eq.every((r: any) => r.customer_id === keep));
  const ex = (await lite.query('SELECT entity_id FROM extractions WHERE id = $1', [x1])).rows[0];
  check('merge: extractions moved to the kept record', ex.entity_id === keep);
  const dropped = (await lite.query("SELECT id, merged_into FROM entities WHERE entity_type = 'customer' AND id = ANY($1::uuid[])", [[cust(1), cust(2)]])).rows;
  check('merge: the other records are marked merged into the kept one, not deleted', dropped.length === 2 && dropped.every((r: any) => r.merged_into === keep));
  const kept = (await lite.query('SELECT data FROM entities WHERE id = $1', [keep])).rows[0].data;
  check('merge: phone is filled in and the other sites are kept as other addresses', kept.phone === '(602) 555-0111' && (kept.other_addresses ?? []).length === 1 && /Ironwood/.test(kept.other_addresses[0]), kept);
  const left = (await lite.query("SELECT count(*)::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = $1 AND data->>'customer_name' = 'Sofia Calloway'", [tenA])).rows[0].n;
  check('merge all: the conflicting same-name pair was not touched', left === 2);
  check('merge: no document link was lost (counts only move, never disappear)', (await lite.query('SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1', [tenA])).rows[0].n <= beforeLinks);
  const logged = (await lite.query("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'customers.merge_all_exact'", [tenA])).rows;
  check('merge all: the run is written to the activity log with every group', logged.length === 1 && logged[0].changes.groups.length === 2);
  const merges = (await lite.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'review.entities_merged'", [tenA])).rows[0].n;
  check('merge: every individual merge is logged too', merges === 3, merges);
  const untouched = (await lite.query("SELECT count(*)::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = $1 AND data->>'customer_name' = 'Pat Rivera'", [tenA])).rows[0].n;
  check('merge all: the name-only pair was not touched', untouched === 2);
  const again = await B.mergeAllExact(ctxA, 'user_cm_admin');
  check('merge all: running it again finds nothing left to merge', again.merged.length === 0 && again.remaining === 0);
}

/* ---------- undo ---------- */
{
  const first = bulk.merged.find((m: any) => m.name === 'Cardinal Ridge Construction');
  check('undo: each merged group has an undo id', !!first?.suggestionId);
  const undone = await withTenant(ctxA, (db: any) => R.undoMergeSuggestion(db, { suggestionId: first.suggestionId }, 'user_cm_admin'));
  check('undo: the dropped records come back', undone.restoredIds.length === 2);
  const links = (await lite.query('SELECT document_id, entity_id FROM document_entity_links WHERE tenant_id = $1 AND document_id = ANY($2::uuid[]) ORDER BY document_id', [tenA, [1, 2, 3, 4].map(docId)])).rows;
  const want = [[docId(1), cust(1)], [docId(2), cust(2)], [docId(3), cust(3)], [docId(4), cust(3)]];
  check('undo: each document link is back on the record it came from', JSON.stringify(links.map((r: any) => [r.document_id, r.entity_id])) === JSON.stringify(want), links);
  const eq = (await lite.query('SELECT id, customer_id FROM entities WHERE id = ANY($1::uuid[]) ORDER BY id', [[e2, e3]])).rows;
  check('undo: each unit is back with its original customer', eq.find((r: any) => r.id === e2).customer_id === cust(2) && eq.find((r: any) => r.id === e3).customer_id === cust(3));
  const kept = (await lite.query('SELECT data FROM entities WHERE id = $1', [cust(3)])).rows[0].data;
  check('undo: the kept record\'s own details are restored (no merged phone or extra address)', !kept.phone && !kept.other_addresses, kept);
  const still = (await lite.query("SELECT count(*)::int AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND id = ANY($1::uuid[])", [[cust(1), cust(2), cust(3)]])).rows[0].n;
  check('undo: all three records are live again', still === 3);
}

/* ---------- prevention against the database ---------- */
{
  let refused: any = null;
  try { await RV.createCustomer(ctxA, { name: 'BRIGHTWATER?' }, 'u'); } catch (e) { refused = e; }
  await addCustomer(tenA, 20, 'Brightwater Painting Co.', 'C-00020', { phone: '(480) 555-0100' });
  let dup: any = null;
  try { await RV.createCustomer(ctxA, { name: 'Brightwater Painting LLC' }, 'u'); } catch (e) { dup = e; }
  check('create: a manual add of an existing name is refused with the existing record', dup?.status === 409 && dup?.details?.existingCustomerId === cust(20) && dup?.details?.reason === 'name', dup && { s: dup.status, d: dup.details });
  let different: any = null;
  try { different = await RV.createCustomer(ctxA, { name: 'Brightwater Painting', phone: '(480) 555-0999' }, 'u'); } catch (e) { different = e; }
  check('create: the same name with a different phone is allowed (a different customer)', !!different?.customer?.id);
  const forced = await RV.createCustomer(ctxA, { name: 'Brightwater Painting LLC', confirmDuplicate: true }, 'u');
  check('create: "Add anyway" still creates it', !!forced.customer?.id);
  let self: any = null;
  try { await RV.createCustomer(ctxA, { name: 'Juniper Lane Mercantile, Inc.' }, 'u'); } catch (e) { self = e; }
  check('create: the company\'s own name is not added as a customer', self?.status === 409 && self?.details?.reason === 'self', self && { s: self.status, d: self.details });
  check('create: an unrelated new name is created normally', !!(await RV.createCustomer(ctxA, { name: 'Fresh New Customer LLC' }, 'u')).customer?.id && refused === null);
  // document-driven: the same business named again with another site lands on the existing record
  const r1 = await withTenant(ctxA, (db: any) => db.findOrCreateCustomer({ customer_name: 'Verde Logistics Inc.', service_address: '1 New Dock Rd, Chandler, AZ 85224' }));
  const r2 = await withTenant(ctxA, (db: any) => db.findOrCreateCustomer({ customer_name: 'Verde Logistics Inc.', service_address: '2 Other Dock Rd, Tempe, AZ 85281' }));
  check('document: a business named again with a new site is the same customer (no new record)', r1.created === false && r2.created === false && r1.id === r2.id, { r1, r2 });
  const kept = (await lite.query('SELECT data FROM entities WHERE id = $1', [r1.id])).rows[0].data;
  check('document: the first site is the address and the later site is kept as another address', /New Dock/.test(kept.service_address) && (kept.other_addresses ?? []).length === 1 && /Other Dock/.test(kept.other_addresses[0]), kept);
}

/* ---------- This is us ---------- */
let us: any;
{
  us = await B.markAsCompany(ctxA, { entityIds: review.self.map((m: any) => m.id) }, 'user_cm_admin');
  check('this is us: documents became company papers; the paper that also names a real customer stayed with that customer',
    us.documentsMoved === 2 && us.documentsKeptWithCustomers === 1 && us.equipmentUnassigned === 1, us);
  const folders = (await lite.query("SELECT document_id, value FROM extractions WHERE tenant_id = $1 AND field_key = '_company_folder' ORDER BY document_id", [tenA])).rows;
  const byDoc = Object.fromEntries(folders.map((r: any) => [r.document_id, r.value]));
  check('this is us: papers go to Company and admin, a folder the person already chose is kept', byDoc[docId(10)] === 'company-admin' && byDoc[docId(11)] === 'company-admin' && byDoc[docId(12)] === 'insurance-legal' && !(docId(13) in byDoc), byDoc);
  const links = (await lite.query('SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[])', [tenA, [cust(10), cust(11), cust(12)]])).rows[0].n;
  check('this is us: the company records no longer hold any document link', links === 0);
  const list = await withTenant(ctxA, (db: any) => db.listCustomersSummary({}));
  check('this is us: the records are gone from the customer list', !list.some((r: any) => /Juniper Lane/.test(r.data?.customer_name ?? '')) && (await withTenant(ctxA, (db: any) => db.countCustomersSummary({}))) === list.length);
  const rv = await withTenant(ctxA, (db: any) => B.reviewDuplicates(db));
  check('this is us: the duplicate review no longer lists them', rv.self.length === 0);
  const eq = (await lite.query('SELECT customer_id FROM entities WHERE id = $1', [ownEq])).rows[0];
  check('this is us: the company\'s unit is left without a customer, not deleted', eq.customer_id === null);
  const logged = (await lite.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'customers.this_is_us'", [tenA])).rows[0].n;
  check('this is us: the action is written to the activity log', logged === 1 && !!us.logId);
  const match = await withTenant(ctxA, (db: any) => db.findOrCreateCustomer({ customer_name: 'Juniper Lane Mercantile', service_address: '1 Elsewhere Rd, Mesa, AZ 85201' }));
  const stillHidden = (await lite.query("SELECT data->>'is_company' AS c FROM entities WHERE id = $1", [cust(10)])).rows[0].c;
  check('this is us: a later document does not reattach to the hidden company record (our own name is never made a customer)', (match === null || match.id !== cust(10)) && stillHidden === 'true');
}
{
  const undone = await B.undoCompanyMark(ctxA, { logId: us.logId }, 'user_cm_admin');
  check('undo this is us: the records come back', undone.restoredIds.length === 3);
  const links = (await lite.query('SELECT document_id, entity_id FROM document_entity_links WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[]) ORDER BY document_id', [tenA, [cust(10), cust(11), cust(12)]])).rows;
  check('undo this is us: every link is back', links.length === 4, links);
  const folders = (await lite.query("SELECT document_id, value FROM extractions WHERE tenant_id = $1 AND field_key = '_company_folder' ORDER BY document_id", [tenA])).rows;
  check('undo this is us: the company-paper choices are removed and the earlier folder choice kept', folders.length === 1 && folders[0].value === 'insurance-legal', folders);
  check('undo this is us: the unit has its customer again', (await lite.query('SELECT customer_id FROM entities WHERE id = $1', [ownEq])).rows[0].customer_id === cust(11));
  const back = await withTenant(ctxA, (db: any) => db.listCustomersSummary({ like: '%Juniper Lane%' }));
  check('undo this is us: the three records are back in the customer list', [cust(10), cust(11), cust(12)].every((id) => back.some((r: any) => r.id === id)), back.length);
  let twice: any = null;
  try { await B.undoCompanyMark(ctxA, { logId: us.logId }, 'user_cm_admin'); } catch (e) { twice = e; }
  check('undo this is us: a second undo is refused', twice?.status === 409);
}

/* ---------- tenant isolation ---------- */
{
  const b = await withTenant(ctxB, (db: any) => B.reviewDuplicates(db));
  check('isolation: tenant B sees only its own groups', b.exact.length === 1 && b.exact[0].ids.length === 2 && b.companyName === 'Other Shop' && b.self.length === 0, b.summary);
  let cross: any = null;
  try { await B.markAsCompany(ctxB, { entityIds: [cust(10)] }, 'u'); } catch (e) { cross = e; }
  check('isolation: tenant B cannot mark tenant A\'s record', cross?.status === 404);
  const bLinks = (await lite.query('SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1', [tenB])).rows[0].n;
  const bOwn = (await lite.query("SELECT data->>'is_company' AS c FROM entities WHERE id = $1", [cust(92)])).rows[0].c;
  check('isolation: tenant B\'s records and links were never touched by tenant A\'s merges', bLinks === 1 && bOwn === null);
  const mergedB = await B.mergeAllExact(ctxB, 'u');
  const aStill = (await lite.query("SELECT count(*)::int AS n FROM entities WHERE tenant_id = $1 AND entity_type = 'customer' AND merged_into IS NOT NULL", [tenA])).rows[0].n;
  check('isolation: merging in tenant B changed nothing in tenant A (A keeps only its own earlier Verde merge)', mergedB.merged.length === 1 && aStill === 1, aStill);
}

/* ================================================================ sample data */
// @ts-ignore
const S: any = await import('./lib/sampleRoster.mjs');
{
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const sets: Array<[string, string, () => any[], string[]]> = [
    ['test-docs/business', 'test-docs/business/ANSWER_KEY.json', () => read('test-docs/business/ANSWER_KEY.json').customers.map((c: any) => ({ name: c.canonicalName, address: c.address, phone: c.phone, email: c.email })), ['Sonoran Comfort Air']],
    ['test-docs/business-small', 'test-docs/business-small/ANSWER_KEY.json', () => read('test-docs/business-small/ANSWER_KEY.json').customers.map((c: any) => ({ name: c.canonicalName, address: c.address, phone: c.phone, email: c.email })), ['Sonoran Comfort Air']],
    ['golden tenant', 'scripts/golden/golden-export.json', () => read('scripts/golden/golden-export.json').entities.filter((e: any) => e.entity_type === 'customer').map((e: any) => ({ name: e.data.customer_name, address: e.data.service_address, phone: e.data.phone, email: e.data.email })), ['Sonoran Comfort Air']],
    ['plumbing tenant', 'test-docs/tenants/plumbing/export.json', () => read('test-docs/tenants/plumbing/export.json').entities.filter((e: any) => e.entity_type === 'customer').map((e: any) => ({ name: e.data.customer_name, address: e.data.service_address, phone: e.data.phone, email: e.data.email })), ['Canyon State Plumbing']],
  ];
  for (const [label, file, load, own] of sets) {
    if (!fs.existsSync(path.join(ROOT, file))) { console.log(`SKIP  ${label}: ${file} not generated here`); continue; }
    const problems = S.rosterProblems(load(), { ownNames: own });
    check(`sample data: ${label} never names one customer twice`, problems.length === 0, problems);
  }
  check('sample data: the guard catches a duplicate, a look-alike and the company\'s own name',
    S.rosterProblems([{ name: 'Alpha Roofing' }, { name: 'alpha roofing' }, { name: 'Zed Plumbing LLC' }, { name: 'Zed Plumbing' }, { name: 'My Shop Ltd' }], { ownNames: ['My Shop'] }).length === 3);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('wiring: verify:customer-merge is in package.json and in verify:all', !!pkg.scripts['verify:customer-merge'] && pkg.scripts['verify:all'].includes('verify:customer-merge'));
  const fileCount = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((d) => d.isFile()).length;
  check('wiring: api/ still has exactly 12 top-level files', fileCount === 12, fileCount);
}

/* ---------- recent changes survive a reload ---------- */
{
  const recent = await withTenant(ctxA, (db: any) => B.recentChanges(db));
  const run = recent.items.find((i: any) => i.kind === 'merge-all');
  check('recent: the merge-all run is listed with groups left to undo (one group was undone above)', !!run && run.groups === 2 && run.undoable === 1, recent);
  const undone = await B.undoMergeAll(ctxA, { logId: run.id }, 'user_cm_admin');
  check('recent: Undo puts back the rest of the run', undone.restoredGroups === 1);
  const after = await withTenant(ctxA, (db: any) => B.recentChanges(db));
  check('recent: an undone run drops off the undoable list', after.items.find((i: any) => i.id === run.id)?.undoable === 0);
  let again = ''; try { await B.undoMergeAll(ctxA, { logId: run.id }, 'user_cm_admin'); } catch (e: any) { again = String(e.status); }
  check('recent: undoing twice is a plain 409', again === '409');
  check('recent: another company sees none of it', !(await withTenant(ctxB, (db: any) => B.recentChanges(db))).items.some((i: any) => i.id === run.id));
}

console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed.` : `\n${passes} checks passed.`);


process.exit(failures ? 1 : 0);
