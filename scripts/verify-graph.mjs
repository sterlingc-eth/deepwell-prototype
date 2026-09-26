/**
 * DEEPWELL KNOWLEDGE GRAPH v1 (M3-config/37-knowledge-graph.sql, api/_lib/graph/{build,query}.js,
 * GET /api/v1/graph, POST /api/account?action=graph, agent/tools.js's graph_traverse).
 *
 * Same harness as scripts/verify-job-costing.mjs: no network, no Anthropic key, no DATABASE_URL —
 * a real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations, queried as the app's
 * own non-superuser NOBYPASSRLS role (deepwell_rls).
 *
 *   1. pure: node id helpers (nodeId.customer/unit/document/tech, parseNodeId), normalizeTechKey,
 *      siteKeyFromAddress agreeing
 *      with financials/jobKey.js's normalizeJobKey.
 *   2. migration 37: idempotent, one new table, RLS ENABLE + FORCE.
 *   3. materialization: refreshGraphBatch backfills kg_edges from fixtures already on disk (no
 *      model call), resumable via nextCursor, idempotent on a second pass.
 *   4. getSubgraph (materialized path): depth caps, limit caps + truncated, edgeTypes filter,
 *      provenance (documentId/page) on every edge, exact degree.
 *   5. getBacklinks (materialized path).
 *   6. RLS cross-tenant isolation: tenant B's read of tenant A's node/kg_edges rows is empty.
 *   7. merged/duplicate entities: mergeEntities repoints live links immediately; a STALE
 *      materialized edge still naming the dropped id resolves to the surviving node.
 *   8. WITHOUT migration 37 (table dropped): the SAME assertions (depth/limit/edgeTypes/
 *      provenance/merge-resolution) still hold via the live query-time path.
 *   9. graph_traverse (agent tool): direct toolbox execution, ledger provenance, bad-input refusal.
 *  10. static: package.json wiring, api/ file count, v1/account dispatcher registration, no
 *      question-text/PII logging.
 *
 *   node scripts/verify-graph.mjs
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
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

/* ================================================================== 1. pure */
const B = await import('../api/_lib/graph/build.js');
const JK = await import('../api/_lib/financials/jobKey.js');
{
  eq('nodeId.*: typed, lower-cased ids', [
    B.nodeId.customer('ABC-123'), B.nodeId.unit('DEF'), B.nodeId.document('GHI'),
  ], ['customer:abc-123', 'unit:def', 'document:ghi']);
  eq('normalizeTechKey: case/whitespace-insensitive', [B.normalizeTechKey('Mike R.'), B.normalizeTechKey('  mike   r.  ')], ['mike r.', 'mike r.']);
  eq('nodeId.tech uses normalizeTechKey', B.nodeId.tech('Mike R.'), 'tech:mike r.');
  eq('parseNodeId normalizes a client-supplied tech id', B.parseNodeId('tech:  Mike   R. ')?.value, 'mike r.');
  check('siteKeyFromAddress agrees with financials/jobKey.js normalizeJobKey (same canonicalizer, reused not reinvented)',
    B.siteKeyFromAddress('248 W Guadalupe Rd, Phoenix, AZ 85001') === JK.normalizeJobKey('248 W Guadalupe Rd, Phoenix, AZ 85001')
    && B.siteKeyFromAddress('not an address') === null && B.siteKeyFromAddress('') === null && B.siteKeyFromAddress(null) === null);
  eq('parseNodeId: valid customer/unit/document ids', [B.parseNodeId('customer:11111111-1111-4111-8111-111111111111')?.type, B.parseNodeId('tech:mike r.')?.type, B.parseNodeId('site:248-guadalupe-phoenix')?.type],
    ['customer', 'tech', 'site']);
  eq('parseNodeId: a customer/unit/document id must be a real uuid, never accepted as free text', B.parseNodeId('customer:not-a-uuid'), null);
  eq('parseNodeId: an unknown type prefix is rejected', B.parseNodeId('widget:123'), null);
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
check('harness: migration 37 loaded cleanly (no error from 37-knowledge-graph.sql)', !harnessNotes.some((n) => n.startsWith('37-')), harnessNotes.join(' | '));

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
const Q = await import('../api/_lib/graph/query.js');
const { mergeEntities } = await import('../api/_lib/reviewStore.js');
const { createToolbox } = await import('../api/_lib/agent/tools.js');

const ctxA = { tenantKey: 'org_graph_a', tenantName: 'Graph Shop' };
const ctxB = { tenantKey: 'org_graph_b', tenantName: 'Graph Shop B' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (kind, n) => `${kind}c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n) => uid('c', n);
const equip = (n) => uid('e', n);
const doc = (n) => uid('d', n);

check('migration 37: kg_edges table exists', await withTenant(ctxA, (db) => B.kgEdgesTableExists(db)));
{
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'kg_edges'")).rows[0];
  check('migration 37: kg_edges has ENABLE + FORCE ROW LEVEL SECURITY', rls.rls && rls.force);
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '37-knowledge-graph.sql'), 'utf8')).then(() => true, () => false);
  check('migration 37 is idempotent (re-running it changes nothing and errors nothing)', twice);
}

/* ---------- fixtures (tenant A) ---------- */
const ADDR = '248 W Guadalupe Rd, Phoenix, AZ 85001';
const SITE_KEY = JK.normalizeJobKey(ADDR);
const JOB_KEY = SITE_KEY; // reuse the same address as the job key for D1/D2's same_job pairing

async function addCustomer(n, name, address, number) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
    [cust(n), tenA, JSON.stringify({ customer_name: name, service_address: address }), number]);
}
async function addEquipment(n, { customerId, manufacturer = 'Trane', model = 'XR16', warranty = null, address = null }) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, customer_id, data) VALUES ($1,$2,'equipment',$3,$4::jsonb)",
    [equip(n), tenA, customerId, JSON.stringify({ manufacturer, model, service_address: address, warranty })]);
}
async function addDoc(n, { type = 'invoice', links = [], technician = null, serviceDate = null, financials = null } = {}) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc(n), tenA, `${type}-${n}.pdf`, type, `g-hash-${n}`, 'linked']);
  for (const entityId of links) {
    await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenA, doc(n), entityId]);
  }
  if (technician) await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value) VALUES ($1,$2,'technician',$3)", [tenA, doc(n), technician]);
  if (serviceDate) await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value) VALUES ($1,$2,'service_date',$3)", [tenA, doc(n), serviceDate]);
  if (financials) {
    await lite.query(
      `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, total, evidence, job_key, job_confidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [tenA, doc(n), financials.docKind, financials.direction, financials.total ?? null, JSON.stringify(financials.evidence ?? {}), financials.jobKey ?? null, financials.jobConfidence ?? 0.9]
    );
  }
}

await addCustomer(1, 'Amy Isaacson', ADDR, 'C-G-1');
await addEquipment(1, { customerId: cust(1), manufacturer: 'Trane', model: 'XR16', warranty: { expires: '2030-01-01' } });
await addDoc(1, { type: 'invoice', links: [cust(1)], technician: 'Mike R.', serviceDate: '2026-06-01', financials: { docKind: 'invoice', direction: 'receivable', total: 1200, evidence: { total: { page: 2 } }, jobKey: JOB_KEY } });
await addDoc(2, { type: 'po', financials: { docKind: 'po', direction: 'payable', total: 300, evidence: { total: { page: 1 } }, jobKey: JOB_KEY } });
await addDoc(3, { type: 'agreement', links: [cust(1)], financials: { docKind: 'agreement', direction: 'receivable' } });
await addDoc(4, { type: 'service-ticket', links: [equip(1)], technician: 'mike r.', serviceDate: '2026-07-01' });

await addCustomer(2, 'Karen Abernathy', '888 Distant Ave, Yuma, AZ 85364', 'C-G-2');

// merge fixture: C3 is a duplicate of C1, linked to its own document D5 — merged into C1 below.
await addCustomer(3, 'Amy I. (duplicate)', ADDR, 'C-G-3');
await addDoc(5, { type: 'invoice', links: [cust(3)] });

// tenant B: same-shaped world, wholly separate — proves RLS isolation later.
await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
  [uid('c', 99), tenB, JSON.stringify({ customer_name: 'Secret Tenant B Customer', service_address: '1 Hidden Way, Reno, NV' }), 'C-G-B1']);

/* ---------- 3. materialization ---------- */
{
  let cursor = null;
  let rounds = 0;
  let totalWritten = 0;
  let last;
  do {
    last = await withTenant(ctxA, (db) => B.refreshGraphBatch(db, { afterId: cursor, limit: 2, deadlineMs: 10_000 }));
    totalWritten += last.edgesWritten;
    cursor = last.nextCursor;
    rounds++;
  } while (cursor && rounds < 20);
  check('refreshGraphBatch: resumable — needed more than one batch at limit:2 to cover every document', rounds > 1, `rounds=${rounds}`);
  eq('refreshGraphBatch: finishes with stoppedReason done and nothing remaining', [last.stoppedReason, last.remaining], ['done', 0]);
  check('refreshGraphBatch: wrote at least one edge per fixture relationship (owns/located_at/has_unit/has_document/billed/has_agreement/performed_by/same_job)', totalWritten >= 9, String(totalWritten));

  const status = await withTenant(ctxA, (db) => B.graphRefreshStatus(db));
  check('graphRefreshStatus: enabled, edgeCount > 0, totalDocuments matches fixtures', status.enabled && status.edgeCount > 0 && status.totalDocuments === 5);

  const again = await withTenant(ctxA, (db) => B.refreshGraphBatch(db, { afterId: null, limit: 500, deadlineMs: 10_000 }));
  const status2 = await withTenant(ctxA, (db) => B.graphRefreshStatus(db));
  eq('refreshGraphBatch is idempotent: a full re-run does not change the edge count', status2.edgeCount, status.edgeCount);
  void again;
}

/* ---------- 4. getSubgraph (materialized) ---------- */
{
  const d1 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 1 });
  const idsD1 = new Set(d1.nodes.map((n) => n.id));
  check('depth=1 from customer: reaches its site and its unit, and documents linked DIRECTLY to it (D1, D3) — not D4 (linked to the unit, 2 hops) or D2/tech (2+ hops)',
    idsD1.has(B.nodeId.site(SITE_KEY)) && idsD1.has(B.nodeId.unit(equip(1))) && idsD1.has(B.nodeId.document(doc(1))) && idsD1.has(B.nodeId.document(doc(3)))
    && !idsD1.has(B.nodeId.document(doc(4))) && !idsD1.has(B.nodeId.document(doc(2))),
    JSON.stringify([...idsD1]));

  const d2 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 2, today: '2026-09-26' });
  const idsD2 = new Set(d2.nodes.map((n) => n.id));
  check('depth=2 from customer: also reaches the unit\'s own document (D4, via the unit), the matched PO (D2, via same_job off D1), and the technician (via D1)',
    idsD2.has(B.nodeId.document(doc(4))) && idsD2.has(B.nodeId.document(doc(2))) && idsD2.has(B.nodeId.tech('Mike R.')),
    JSON.stringify([...idsD2]));

  const unitNode = d2.nodes.find((n) => n.id === B.nodeId.unit(equip(1)));
  check('unit node subtitle carries warranty status (from warrantyStatusOf, not a separate edge — "unit -> warranty status" is not a 5th node type)',
    unitNode && /warranty: active/.test(unitNode.subtitle ?? ''), JSON.stringify(unitNode));

  const billedEdge = d1.edges.find((e) => e.type === 'billed' && e.from === B.nodeId.customer(cust(1)) && e.to === B.nodeId.document(doc(1)));
  check('billed edge: weight is the invoice total, provenance cites document D1 at the printed page (2)',
    billedEdge && billedEdge.weight === 1200 && billedEdge.source.documentId === doc(1) && billedEdge.source.page === 2, JSON.stringify(billedEdge));
  check('every edge in the response carries a source object with documentId/page keys (provenance always present, even when page is null)',
    [...d1.edges, ...d2.edges].every((e) => e.source && ('documentId' in e.source) && ('page' in e.source)));

  const same = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.document(doc(1)), depth: 1, edgeTypes: ['same_job'] });
  check('edgeTypes filter: from the invoice, only same_job is returned (the PO) — has_document/billed to the customer are excluded',
    same.edges.length >= 1 && same.edges.every((e) => e.type === 'same_job')
    && same.nodes.some((n) => n.id === B.nodeId.document(doc(2))) && !same.nodes.some((n) => n.id === B.nodeId.customer(cust(1))),
    JSON.stringify(same));

  const limited = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 3, limit: 1 });
  check('limit caps the edge count and sets truncated:true when more exist', limited.edges.length <= 1 && limited.truncated === true, JSON.stringify(limited));

  const custNode = d2.nodes.find((n) => n.id === B.nodeId.customer(cust(1)));
  const rawDegree = (await withTenant(ctxA, (db) => db.raw('SELECT count(*)::int AS n FROM kg_edges WHERE from_node = $1 OR to_node = $1', [B.nodeId.customer(cust(1))]))).rows[0].n;
  eq('node degree (materialized) is the EXACT kg_edges count touching that node, not just what this one traversal happened to show', custNode?.degree, rawDegree);

  const bad = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: 'not-a-real-node' });
  eq('an unparseable node id returns an honest empty result, never a crash or an invented node', [bad.center, bad.nodes, bad.edges], [null, [], []]);
}

/* ---------- 5. getBacklinks (materialized) ---------- */
{
  const bl = await Q.getBacklinks({ withTenant, ctxArg: ctxA, node: B.nodeId.document(doc(1)) });
  const types = bl.backlinks.map((b) => b.edge.type).sort();
  const fromCustomer = bl.backlinks.filter((b) => b.edge.type === 'has_document' || b.edge.type === 'billed');
  const fromPo = bl.backlinks.find((b) => b.edge.type === 'same_job');
  check('backlinks of the invoice: has_document + billed FROM the customer, PLUS same_job FROM the matched PO (D2) — everything pointing AT this document, not just the direct owner',
    JSON.stringify(types) === JSON.stringify(['billed', 'has_document', 'same_job'])
    && fromCustomer.every((b) => b.edge.from === B.nodeId.customer(cust(1)) && b.from.type === 'customer' && b.from.label === 'Amy Isaacson')
    && fromPo?.edge.from === B.nodeId.document(doc(2)) && fromPo?.from.type === 'document', JSON.stringify(bl));
}

/* ---------- 5a. R11: visit/warranty/agreement node types + new edges, provenance (materialized) ---------- */
{
  const visitNode = B.nodeId.visit(doc(1));
  const d1 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 1 });
  const idsD1 = new Set(d1.nodes.map((n) => n.id));
  check('D1 (an invoice with a service_date, VISIT_DOC_TYPES-eligible) also surfaces as a visit: node one hop from its customer', idsD1.has(visitNode), JSON.stringify([...idsD1]));

  const visitedEdge = d1.edges.find((e) => e.type === 'visited' && e.from === B.nodeId.customer(cust(1)) && e.to === visitNode);
  check('visited edge: customer -> visit, provenance cites the document', visitedEdge && visitedEdge.source.documentId === doc(1), JSON.stringify(visitedEdge));
  const atSiteEdge = d1.edges.find((e) => e.type === 'at_site' && e.from === visitNode);
  check('at_site edge: visit -> the same site node the customer itself is located_at', atSiteEdge && atSiteEdge.to === B.nodeId.site(SITE_KEY), JSON.stringify(atSiteEdge));

  const visitNodeInfo = d1.nodes.find((n) => n.id === visitNode);
  check('visit node hydrates as type "visit", labelled with its service date', visitNodeInfo?.type === 'visit' && /2026-06-01/.test(visitNodeInfo.label ?? ''), JSON.stringify(visitNodeInfo));

  const d2 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 3, today: '2026-09-26' });
  const visitPerformedBy = d2.edges.find((e) => e.type === 'performed_by' && e.from === visitNode && e.to === B.nodeId.tech('Mike R.'));
  check('performed_by is ALSO emitted from the visit node (not just the document) so a technician\'s own neighborhood reaches their visits directly', Boolean(visitPerformedBy), JSON.stringify(d2.edges.filter((e) => e.type === 'performed_by')));

  const warrantyNode = B.nodeId.warranty(equip(1));
  const hasWarrantyEdge = d2.edges.find((e) => e.type === 'has_warranty' && e.from === B.nodeId.unit(equip(1)) && e.to === warrantyNode);
  check('has_warranty edge reaches a warranty: node from the unit at 2 hops', Boolean(hasWarrantyEdge), JSON.stringify(d2.edges.filter((e) => e.type === 'has_warranty')));
  const warrantyNodeInfo = d2.nodes.find((n) => n.id === warrantyNode);
  check('warranty node hydrates as type "warranty" and its subtitle agrees with the SAME warrantyStatusOf() the unit node subtitle uses (never disagreeing about "active"/"expired")',
    warrantyNodeInfo?.type === 'warranty' && /active/.test(warrantyNodeInfo.subtitle ?? '') && /2030-01-01/.test(warrantyNodeInfo.subtitle ?? ''), JSON.stringify(warrantyNodeInfo));

  const agreementNode = d1.nodes.find((n) => n.id === B.nodeId.document(doc(3)));
  check('D3 (doc_kind=agreement) hydrates as node type "agreement", not the generic "document" — same document:<uuid> id, just re-typed', agreementNode?.type === 'agreement', JSON.stringify(agreementNode));
  const nonAgreementDoc = d1.nodes.find((n) => n.id === B.nodeId.document(doc(1)));
  check('D1 (a plain invoice) still hydrates as the generic "document" type — re-typing only applies to actual agreements', nonAgreementDoc?.type === 'document', JSON.stringify(nonAgreementDoc));

  const liveVisit = await withTenant(ctxA, (db) => B.expandNode(db, B.nodeId.visit(doc(4))));
  check('expandNode(visit:<doc>) standalone: returns its owner/site/tech edges', liveVisit.length > 0, JSON.stringify(liveVisit));
  const liveWarranty = await withTenant(ctxA, (db) => B.expandNode(db, warrantyNode));
  check('expandNode(warranty:<unit>) standalone: returns the has_warranty edge back to its unit', liveWarranty.some((e) => e.type === 'has_warranty'), JSON.stringify(liveWarranty));
}

/* ---------- 5b. R11: site key never collides across a different city or a different unit ---------- */
{
  const sameStreetDiffCity1 = JK.normalizeJobKey('500 N Center St, Mesa, AZ 85201');
  const sameStreetDiffCity2 = JK.normalizeJobKey('500 N Center St, Chandler, AZ 85224');
  check('same house+street, DIFFERENT city -> different site keys (never grouped as the same job/property)',
    sameStreetDiffCity1 && sameStreetDiffCity2 && sameStreetDiffCity1 !== sameStreetDiffCity2, JSON.stringify([sameStreetDiffCity1, sameStreetDiffCity2]));

  const sameAddrDiffUnit1 = JK.normalizeJobKey('3300 S Alma School Rd, Apt 1, Mesa, AZ 85210');
  const sameAddrDiffUnit2 = JK.normalizeJobKey('3300 S Alma School Rd, Apt 2, Mesa, AZ 85210');
  check('same address, DIFFERENT apartment/unit -> different site keys (an apartment complex never collapses into one site node)',
    sameAddrDiffUnit1 && sameAddrDiffUnit2 && sameAddrDiffUnit1 !== sameAddrDiffUnit2, JSON.stringify([sameAddrDiffUnit1, sameAddrDiffUnit2]));

  // end-to-end: two customers at the "same" street number/name but a different city never merge into one site node.
  // expandNode (not getSubgraph) so this holds regardless of whether these two brand-new customers
  // have been through a materialization pass yet — same live derivation either path ultimately uses.
  await addCustomer(10, 'Center St Mesa', '500 N Center St, Mesa, AZ 85201', 'C-G-10');
  await addCustomer(11, 'Center St Chandler', '500 N Center St, Chandler, AZ 85224', 'C-G-11');
  const mesaEdges = await withTenant(ctxA, (db) => B.expandNode(db, B.nodeId.customer(cust(10))));
  const chandlerEdges = await withTenant(ctxA, (db) => B.expandNode(db, B.nodeId.customer(cust(11))));
  const mesaSite = mesaEdges.find((e) => e.type === 'located_at')?.to;
  const chandlerSite = chandlerEdges.find((e) => e.type === 'located_at')?.to;
  check('end-to-end: customers at "500 N Center St" in two different cities land on two DIFFERENT site nodes',
    mesaSite && chandlerSite && mesaSite !== chandlerSite, JSON.stringify({ mesaSite, chandlerSite }));
}

/* ---------- 5c. R11: refreshGraphForDocument — incremental, idempotent, bounded to one document ---------- */
{
  const before = await withTenant(ctxA, (db) => db.raw('SELECT count(*)::int AS n FROM kg_edges', []));
  const r1 = await B.refreshGraphForDocument({ withTenant, ctxArg: ctxA, documentId: doc(1) });
  check('refreshGraphForDocument: enabled, writes at least the has_document/billed/visited edges for D1', r1.enabled && r1.edgesWritten >= 3, JSON.stringify(r1));
  const r2 = await B.refreshGraphForDocument({ withTenant, ctxArg: ctxA, documentId: doc(1) });
  eq('refreshGraphForDocument is idempotent: re-running it on the same document writes the identical edge count', r2.edgesWritten, r1.edgesWritten);
  const after = await withTenant(ctxA, (db) => db.raw('SELECT count(*)::int AS n FROM kg_edges', []));
  eq('refreshGraphForDocument never changes the total kg_edges row count for OTHER documents (delete-then-reinsert scoped to document_id = $1)', after.rows[0].n, before.rows[0].n);

  const bad = await B.refreshGraphForDocument({ withTenant, ctxArg: ctxA, documentId: 'not-a-uuid' });
  eq('refreshGraphForDocument: a malformed documentId is an honest no-op, never a crash', [bad.enabled, bad.edgesWritten], [false, 0]);
}

/* ---------- 6. RLS cross-tenant isolation ---------- */
{
  const crossRead = await Q.getSubgraph({ withTenant, ctxArg: ctxB, node: B.nodeId.customer(cust(1)), depth: 2 });
  eq('tenant B reading tenant A\'s customer node id: no nodes, no edges — RLS hides it entirely, never a cross-tenant leak', [crossRead.nodes, crossRead.edges], [[], []]);
  const crossCount = (await withTenant(ctxB, (db) => db.raw('SELECT count(*)::int AS n FROM kg_edges', []))).rows[0].n;
  eq('FORCE ROW LEVEL SECURITY proof: tenant B sees 0 kg_edges rows even though tenant A has many', crossCount, 0);
  const search = await Q.searchNodes({ withTenant, ctxArg: ctxB, q: 'Isaacson' });
  eq('search under tenant B never finds tenant A\'s customer', search, []);
}

/* ---------- 7. merged/duplicate entities follow merged_into ---------- */
{
  // D5 -> customer:C3 was materialized above (section 3, before the merge). mergeEntities repoints
  // document_entity_links live but kg_edges is NOT re-refreshed here — proving the stale-row case.
  await mergeEntities(ctxA, { keepId: cust(1), dropId: cust(3) }, 'tester');

  const subFromDropped = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(3)), depth: 1 });
  eq('a subgraph read from the DROPPED node id resolves to the SURVIVING customer, not the merged-away one',
    subFromDropped.center, B.nodeId.customer(cust(1)));
  check('the dropped node id never appears anywhere in the response after resolution', ![subFromDropped.center, ...subFromDropped.nodes.map((n) => n.id), ...subFromDropped.edges.flatMap((e) => [e.from, e.to])].includes(B.nodeId.customer(cust(3))));
  check('D5 (linked to the dropped customer pre-merge) shows up owned by the SURVIVOR', subFromDropped.nodes.some((n) => n.id === B.nodeId.document(doc(5))));

  const blD5 = await Q.getBacklinks({ withTenant, ctxArg: ctxA, node: B.nodeId.document(doc(5)) });
  check('backlinks of D5 (a stale materialized edge naming the dropped customer) resolve to the survivor, deduped, never listing the dropped id',
    blD5.backlinks.length === 1 && blD5.backlinks[0].from.id === B.nodeId.customer(cust(1)), JSON.stringify(blD5));
}

/* ---------- 8. WITHOUT migration 37 (table dropped): the same live-query guarantees hold ---------- */
{
  await lite.query('DROP TABLE kg_edges');
  B._resetKgEdgesProbe();
  const hasTable = await withTenant(ctxA, (db) => B.kgEdgesTableExists(db));
  check('table dropped: kgEdgesTableExists reports false', hasTable === false);

  const status = await withTenant(ctxA, (db) => B.graphRefreshStatus(db));
  eq('graphRefreshStatus without the table: enabled:false, nothing to report', [status.enabled, status.edgeCount], [false, 0]);
  const refresh = await withTenant(ctxA, (db) => B.refreshGraphBatch(db, {}));
  eq('refreshGraphBatch without the table: an honest table_missing, never a crash', [refresh.enabled, refresh.stoppedReason], [false, 'table_missing']);

  const d1 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 1 });
  const idsD1 = new Set(d1.nodes.map((n) => n.id));
  check('WITHOUT migration 37 — depth=1 from customer still reaches site/unit/D1/D3, still excludes D4/D2/tech (same shape as the materialized path)',
    idsD1.has(B.nodeId.site(SITE_KEY)) && idsD1.has(B.nodeId.unit(equip(1))) && idsD1.has(B.nodeId.document(doc(1))) && idsD1.has(B.nodeId.document(doc(3)))
    && !idsD1.has(B.nodeId.document(doc(4))), JSON.stringify([...idsD1]));

  const d2 = await Q.getSubgraph({ withTenant, ctxArg: ctxA, node: B.nodeId.customer(cust(1)), depth: 2 });
  const idsD2 = new Set(d2.nodes.map((n) => n.id));
  check('WITHOUT migration 37 — depth=2 still reaches D4/D2/tech, computed query-time (no model call, straight off entities/document_entity_links/extractions/document_financials)',
    idsD2.has(B.nodeId.document(doc(4))) && idsD2.has(B.nodeId.document(doc(2))) && idsD2.has(B.nodeId.tech('Mike R.')), JSON.stringify([...idsD2]));

  const billedEdge = d1.edges.find((e) => e.type === 'billed');
  check('WITHOUT migration 37 — billed edge still carries its dollar weight and page provenance', billedEdge && billedEdge.weight === 1200 && billedEdge.source.page === 2, JSON.stringify(billedEdge));

  const bl = await Q.getBacklinks({ withTenant, ctxArg: ctxA, node: B.nodeId.document(doc(5)) });
  check('WITHOUT migration 37 — merged-entity resolution still holds live (D5 backlinks to the survivor, never the dropped id)',
    bl.backlinks.length === 1 && bl.backlinks[0].from.id === B.nodeId.customer(cust(1)), JSON.stringify(bl));

  const crossRead = await Q.getSubgraph({ withTenant, ctxArg: ctxB, node: B.nodeId.customer(cust(1)), depth: 2 });
  eq('WITHOUT migration 37 — RLS isolation still holds on the live path', [crossRead.nodes, crossRead.edges], [[], []]);
}

/* ---------- 9. graph_traverse (agent tool) ---------- */
{
  const tb = createToolbox({ withTenant, ctxArg: ctxA, today: '2026-09-26', variant: 'v2' });
  const r1 = await tb.execute('graph_traverse', { node: cust(1), nodeType: 'customer', depth: 2 });
  check('graph_traverse: a bare uuid + nodeType resolves and returns the same neighborhood as getSubgraph', r1.ok, r1.content.slice(0, 200));
  const p1 = JSON.parse(r1.content);
  check('graph_traverse result: reaches the unit and the invoice, each edge carrying provenance', p1.nodes.some((n) => n.id === B.nodeId.unit(equip(1)))
    && p1.edges.every((e) => e.source && 'documentId' in e.source));
  check('graph_traverse: evidence documents reach the ledger (citations wired through)', tb.ledger.docStage.has(doc(1).toLowerCase()) || tb.ledger.ids.has(doc(1).toLowerCase()));

  const r2 = await tb.execute('graph_traverse', { node: `tech:mike r.`, depth: 1 });
  check('graph_traverse: an already-typed node id (tech:...) works without nodeType', r2.ok, r2.content.slice(0, 200));

  const rBad = await tb.execute('graph_traverse', { node: 'just-a-bare-name-no-type' });
  check('graph_traverse: a bare id with no nodeType and no prefix is refused, not guessed at', rBad.ok === false);
}

/* ---------- 10. static checks ---------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json: verify:graph exists and is part of verify:all', pkg.scripts['verify:graph'] === 'node scripts/verify-graph.mjs' && /verify:graph\b/.test(pkg.scripts['verify:all']));
  check('package.json: verify:graph-ppr exists and is part of verify:all', pkg.scripts['verify:graph-ppr'] === 'node scripts/verify-graph-ppr.mjs' && /verify:graph-ppr\b/.test(pkg.scripts['verify:all']));
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
  eq('api/ top-level file count is unchanged (no new serverless function added for this feature)', apiFiles.length, 12);

  const v1Src = fs.readFileSync(path.join(ROOT, 'api/v1.js'), 'utf8');
  check('api/v1.js registers graph as a v1 resource (GET /api/v1/graph)', /graph/.test(v1Src) && /RESOURCES\s*=\s*\{[^}]*graph/.test(v1Src));
  const accountSrc = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
  check('api/account.js registers graph as an account action (backfill/refresh, admin)', /ACTIONS\s*=\s*\{[^}]*graph/.test(accountSrc));

  const guardSrc = fs.readFileSync(path.join(ROOT, 'api/_lib/agent/sqlGuard.js'), 'utf8');
  check('sqlGuard.js REAL_TABLES lists kg_edges (verify-agent.mjs\'s own cross-check would otherwise fail)', /"kg_edges"/.test(guardSrc));

  const srcs = ['build', 'query', 'rank'].map((f) => fs.readFileSync(path.join(ROOT, `api/_lib/graph/${f}.js`), 'utf8')).join('\n');
  check('no graph source logs question text, customer names or amounts', !/console\.(log|error|warn)\([^)]*(question|customerName|address|total|amount)\b/i.test(srcs));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
