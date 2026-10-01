/**
 * R36 scale checks: the five risks R35 left open before a first big customer import.
 * No network, no real R2 / Neon / model / Stripe: PGlite as the RLS role (scripts/lib/r35Harness.mjs), a patched fetch
 * standing in for the app's own API on the client-side checks.
 *
 *   npx tsx scripts/verify-r36-scale.mjs
 *
 * Families
 *   search    Records search: equals a plain-SQL oracle (sparse, dense, file name, technician, injection, none), keyset paging,
 *             totals, filters + search, tenant isolation, facet parity (inline vs browseFacets), the legacy offset cursor,
 *             and the same answers with and without records_search_candidates() (M3-config/64)
 *   counts    reviewSummary / listUnverifiedDocuments / listEntitiesByIds exact and tenant-scoped; the client graph
 *             hydrates older needs-review documents and carries the server's totals
 *   rescue    Records Rescue credit: pure grant rule, once per Stripe event, survives owner-override preservation and plan
 *             changes, consumed only above the plan allowance, tenant-scoped, fails closed
 *   canceled  a canceled shop still signs in and exports everything, and can do nothing else
 *   expenses  receipt uploads need a size, refuse an oversize one, and sign content-length
 * The large-tenant timings live in scripts/r35-measure.mjs (a measurement tool, not a gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness } from './lib/r35Harness.mjs';

const h = await bootHarness();
const { lite, RS, PLAN, stats, newTenant, resetCaches, rnd, root } = h;
const rel = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const fam = {};
let family = 'misc';
let failed = 0;
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const throws = async (name, fn, status, textRe) => {
  try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, (status == null || e.status === status) && (!textRe || textRe.test(e.message)), `status ${e.status}: ${e.message}`); }
};
const quiet = async (fn) => { const err = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = err; console.warn = warn; } };
const mkRes = () => { const r = { statusCode: 0, body: null, headers: {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; return r; }, end() { return r; } }; return r; };
const authFor = (key, userId = 'user_1', orgRole = 'admin') => ({ tenantId: key, orgId: key, userId, orgRole });
const withDb = (key, fn) => RS.withTenant({ tenantKey: key, tenantName: key }, fn);

// The harness applies the migrations BEFORE it creates the app role, so 64's GRANT found no role to grant. Do it here, the way
// pasting the file into a database that already has the role would.
await lite.exec(`GRANT EXECUTE ON FUNCTION records_search_candidates(text, text) TO deepwell_rls`);

const RECORDS = await import(rel('api/records.ts'));
const BILLING = await import(rel('api/_lib/billing.js'));
const UP = await import(rel('api/upload-url.js'));
const OPS = await import(rel('api/_lib/opsStore.js'));
const EXP = await import(rel('api/_lib/routes/expenses.js'));

/* ============================================================ SEARCH */
family = 'search';
const NDOC = 2400;
const SA = 'org_r36_search';
const SB = 'org_r36_other';
const idA = await newTenant(SA, 'shop');
const idB = await newTenant(SB, 'shop');
{
  for (const [tid, tag, n] of [[idA, 'A', NDOC], [idB, 'B', 300]]) {
    await lite.exec(`
      INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
      SELECT '${tid}', 'customer', jsonb_build_object('customer_name', 'Customer ' || g || ' HVAC ${tag}', 'service_address', g || ' Main St, Phoenix AZ'),
             'C-${tag}-' || lpad(g::text, 5, '0'), NOW(), NOW() FROM generate_series(1, 400) g;
      WITH ins AS (
        INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, extracted_at, created_at, updated_at)
        SELECT '${tid}', 'scan-' || g || '${tag === 'B' ? '-other' : ''}.pdf', (ARRAY['work_order','invoice','service_ticket','warranty','startup_sheet'])[1 + g % 5],
               md5(g::text || '${tag}') || md5((g*7)::text || '${tag}'), 1000, (ARRAY['verified','linked','mapped','read'])[1 + g % 4],
               '${tid}/' || md5(g::text) || '/s.pdf', 'application/pdf', 1, NOW(),
               -- every 40th document shares one timestamp: ties must page without a dropped or doubled row
               CASE WHEN g % 40 = 0 THEN TIMESTAMPTZ '2026-01-01 00:00:00+00' ELSE NOW() - (g || ' minutes')::interval END, NOW()
          FROM generate_series(1, ${n}) g RETURNING id, original_filename
      ), pg AS (
        INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text)
        SELECT '${tid}', id, 1, 'x', 'Service call compressor capacitor replaced contactor ' || original_filename || (CASE WHEN original_filename ~ 'scan-(17|23)[0-9]-?' THEN ' refrigerant leak found' ELSE '' END) FROM ins RETURNING 1
      ), ex AS (
        INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
        SELECT '${tid}', id, 'technician', CASE WHEN (regexp_replace(original_filename, '\\D', '', 'g'))::int % 97 = 0 THEN 'Marisol Quintanilla' ELSE 'Tech ' || (regexp_replace(original_filename, '\\D', '', 'g'))::int % 5 END, 0.9 FROM ins RETURNING 1
      )
      INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by)
      SELECT '${tid}', i.id, c.id, 0.9, 'ai' FROM ins i JOIN entities c ON c.tenant_id = '${tid}' AND c.customer_number = '${'C-' + tag + '-'}' || lpad((((regexp_replace(i.original_filename, '\\D', '', 'g'))::int % 400) + 1)::text, 5, '0');
    `);
  }
  await lite.exec('ANALYZE');

  // The oracle: the same four arms as plain SQL as the table owner (no RLS, no function), newest first.
  const oracle = async (q, { type = null } = {}) => {
    const like = `%${q}%`;
    const { rows } = await lite.query(
      `SELECT d.id FROM documents d
        WHERE d.tenant_id = $1 AND COALESCE(d.audience, 'customer') = 'customer' ${type ? 'AND d.document_type = $4' : ''}
          AND (d.original_filename ILIKE $2 OR d.display_name ILIKE $2
            OR EXISTS (SELECT 1 FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE l.document_id = d.id AND e.merged_into IS NULL
                         AND (e.data->>'customer_name' ILIKE $2 OR e.data->>'service_address' ILIKE $2 OR e.data->>'manufacturer' ILIKE $2))
            OR EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'technician' AND x.value ILIKE $2)
            OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tsv @@ websearch_to_tsquery('english', $3)))
        ORDER BY d.created_at DESC, d.id DESC`,
      type ? [idA, like, q, type] : [idA, like, q]
    );
    return rows.map((r) => r.id);
  };
  // Pages through a browse until it ends; returns {ids, totals, pages}.
  const pageAll = async (filters, limit = 50, opts = { facets: 'none' }) => {
    const ids = [];
    const totals = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await withDb(SA, (db) => db.browseDocuments({ ...filters, limit, cursor }, opts));
      ids.push(...r.rows.map((x) => x.id));
      totals.push(r.total);
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 400);
    return { ids, totals, pages };
  };

  const queries = [
    ['sparse customer name', 'Customer 77 HVAC'],
    ['file name', 'scan-123'],
    ['technician (extraction value)', 'Marisol'],
    ['page text, mid-density', 'refrigerant leak'],
    ['page text, dense (every document)', 'capacitor'],
    ['no match', 'zzzqx'],
    ['quote, semicolon and comment', `O'Brien'; DROP TABLE documents; --`],
    ['percent and underscore', '100% _done_'],
  ];
  const runSuite = async (label) => {
    for (const [what, q] of queries) {
      const want = await oracle(q);
      const got = await pageAll({ q });
      check(`${label}: "${q.slice(0, 28)}" (${what}) returns exactly the oracle's documents, in order, none twice`, JSON.stringify(got.ids) === JSON.stringify(want), `got ${got.ids.length}, want ${want.length}`);
      check(`${label}: "${q.slice(0, 28)}" total is the same on every page and equals the true count`, got.totals.every((t) => t === want.length), JSON.stringify([...new Set(got.totals)]) + ` vs ${want.length}`);
    }
  };

  const fnSeen = await withDb(SA, (db) => db.raw(`SELECT has_function_privilege('records_search_candidates(text,text)', 'EXECUTE') AS ok`, []));
  check('M3-config/64 installed records_search_candidates() and the app role may call it', fnSeen.rows[0].ok === true);
  RS._resetSearchFnProbe();
  await runSuite('with M3-config/64');

  // The same answers with the function unavailable (SQL 64 not pasted yet / role without the grant): the inline arms.
  await lite.exec(`REVOKE EXECUTE ON FUNCTION records_search_candidates(text, text) FROM deepwell_rls`);
  RS._resetSearchFnProbe();
  await runSuite('before 64 is pasted (inline arms)');
  await lite.exec(`GRANT EXECUTE ON FUNCTION records_search_candidates(text, text) TO deepwell_rls`);
  RS._resetSearchFnProbe();

  // The function is tenant-scoped by app.tenant_id, never by an argument, and returns nothing without one.
  {
    await lite.exec(`SET ROLE deepwell_rls`);
    await lite.query(`SELECT set_config('app.tenant_id', $1, false)`, [idB]);
    const b = await lite.query(`SELECT count(*)::int AS n FROM records_search_candidates('%scan-%', 'scan')`);
    await lite.query(`SELECT set_config('app.tenant_id', '', false)`);
    const none = await lite.query(`SELECT count(*)::int AS n FROM records_search_candidates('%scan-%', 'scan')`);
    await lite.exec(`RESET ROLE`);
    const bIds = new Set((await lite.query(`SELECT id FROM documents WHERE tenant_id = $1`, [idB])).rows.map((r) => r.id));
    check('records_search_candidates: shop B asking for "scan-" sees only its own 300 documents', b.rows[0].n === 300, `n=${b.rows[0].n}`);
    eq('records_search_candidates: with no shop set it returns nothing (it never answers across shops)', none.rows[0].n, 0);
    const viaApi = await pageAll({ q: 'scan-' });
    check('browse as shop A never returns a shop B document', viaApi.ids.length > 0 && viaApi.ids.every((id) => !bIds.has(id)));
  }

  // Filters + search, the legacy offset cursor, other sorts, facets.
  {
    const want = await oracle('Customer 77 HVAC', { type: 'invoice' });
    const got = await pageAll({ q: 'Customer 77 HVAC', documentType: 'invoice' });
    check('search + a type filter equals the oracle', JSON.stringify(got.ids) === JSON.stringify(want) && want.length > 0, `${got.ids.length} vs ${want.length}`);

    const all = await pageAll({});
    const everyDoc = (await lite.query(`SELECT id FROM documents WHERE tenant_id = $1 AND COALESCE(audience,'customer')='customer' ORDER BY created_at DESC, id DESC`, [idA])).rows.map((r) => r.id);
    check(`no search: all ${NDOC} documents newest first by keyset, none twice, total ${NDOC}`, JSON.stringify(all.ids) === JSON.stringify(everyDoc) && all.totals.every((t) => t === NDOC), `${all.ids.length}`);

    const f0 = RS.normalizeBrowseFilters({});
    const legacy = await withDb(SA, (db) => db.browseDocuments({ limit: 50, cursor: RS.encodeBrowseCursor(50, RS.browseFiltersKey({ ...f0, currentUserId: null })) }, { facets: 'none' }));
    eq('a legacy OFFSET cursor still works (rows 51-100)', legacy.rows.map((r) => r.id), everyDoc.slice(50, 100));
    check('a garbage cursor restarts at the first page, it does not error', (await withDb(SA, (db) => db.browseDocuments({ limit: 5, cursor: 'zz!!' }, { facets: 'none' }))).rows.map((r) => r.id).join() === everyDoc.slice(0, 5).join());

    const byCust = await withDb(SA, (db) => db.browseDocuments({ q: 'Customer 77 HVAC', sort: 'customer', limit: 200 }, { facets: 'none' }));
    eq('another sort with a search returns the same set', [new Set(byCust.rows.map((r) => r.id)).size === byCust.rows.length, byCust.total], [true, (await oracle('Customer 77 HVAC')).length]);

    for (const filters of [{}, { q: 'Customer 77 HVAC' }, { q: 'capacitor', documentType: 'invoice' }, { stageBucket: 'verified' }]) {
      const inline = await withDb(SA, (db) => db.browseDocuments({ ...filters, limit: 10 }, { facets: 'inline' }));
      const sep = await withDb(SA, (db) => db.browseFacets(filters));
      eq(`browseFacets equals the inline facets (${JSON.stringify(filters)})`, sep.facets, inline.facets);
    }
    const again = await withDb(SA, (db) => db.browseFacets({ q: 'capacitor', documentType: 'invoice' }));
    check('a repeat of the same facet request is answered from the 60 s cache', again.cached === true);
    const other = await withDb(SB, (db) => db.browseFacets({ q: 'capacitor', documentType: 'invoice' }));
    check('...and the cache is per shop (shop B is not given shop A\'s counts)', other.cached === false && JSON.stringify(other.facets) !== JSON.stringify(again.facets));
    const none = await withDb(SA, (db) => db.browseDocuments({ limit: 10 }, { facets: 'none' }));
    eq('facets: "none" returns the page with no facets', none.facets, []);

    // The first page is not built from every document: it asks for limit+1 rows and carries the total in the cursor.
    stats.capture = [];
    const first = await withDb(SA, (db) => db.browseDocuments({ limit: 50 }, { facets: 'none' }));
    const pageSql = stats.capture.filter((c) => /LIMIT 51/.test(c.sql));
    stats.capture = null;
    check('first page of a plain browse is one LIMIT 51 page query (no whole-shop aggregate)', pageSql.length === 1 && !/WITH linked AS/.test(pageSql[0].sql));
    stats.capture = [];
    await withDb(SA, (db) => db.browseDocuments({ limit: 50, cursor: first.nextCursor }, { facets: 'none' }));
    const counted = stats.capture.filter((c) => /count\(\*\)/i.test(c.sql) && /documents/.test(c.sql) && !/information_schema/.test(c.sql));
    stats.capture = null;
    eq('"load more" does not count the shop again (the cursor carries the total)', counted.length, 0);
  }
}

/* ============================================================ COUNTS */
family = 'counts';
{
  const K = 'org_r36_counts';
  const id = await newTenant(K, 'shop');
  const idOther = await newTenant('org_r36_counts_other', 'shop');
  // 1,300 documents: 700 verified (newest), 600 not (received/read/mapped/linked, the OLDEST - the case the newest-500 window missed).
  await lite.exec(`
    INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, created_at, updated_at)
    SELECT '${id}', 'c-' || g || '.pdf', 'invoice', md5('c' || g::text) || md5('d' || g::text), 10,
           CASE WHEN g <= 700 THEN 'verified' ELSE (ARRAY['received','read','mapped','linked'])[1 + g % 4] END,
           'k/' || g, 'application/pdf', 1,
           -- older = higher g: the verified ones are the newest 700, so the newest-500 window holds NO not-verified document; 25 of the old ones share a timestamp (ties)
           CASE WHEN g > 700 AND g % 24 = 0 THEN TIMESTAMPTZ '2026-02-02 00:00:00+00' ELSE NOW() - (g || ' minutes')::interval END, NOW()
      FROM generate_series(1, 1300) g;
    INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, created_at, updated_at)
    SELECT '${idOther}', 'o-' || g || '.pdf', 'invoice', md5('o' || g::text) || md5('p' || g::text), 10, 'read', 'k/o' || g, 'application/pdf', 1, NOW(), NOW() FROM generate_series(1, 40) g;
    INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
    SELECT '${id}', 'customer', jsonb_build_object('customer_name', 'Cnt ' || g), 'K-' || g, NOW(), NOW() FROM generate_series(1, 5) g;
    INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
    SELECT '${idOther}', 'customer', jsonb_build_object('customer_name', 'Other ' || g), 'X-' || g, NOW(), NOW() FROM generate_series(1, 5) g;
  `);
  const truth = (await lite.query(`SELECT stage, count(*)::int AS n FROM documents WHERE tenant_id = $1 GROUP BY stage`, [id])).rows;
  const t = Object.fromEntries(truth.map((r) => [r.stage, r.n]));
  const sum = await withDb(K, (db) => db.reviewSummary());
  eq('reviewSummary: total, every stage and the not-verified count are exact (and only this shop\'s)', [sum.total, sum.byStage.received, sum.byStage.read, sum.byStage.mapped, sum.byStage.linked, sum.byStage.verified, sum.needsReview, sum.verified],
    [1300, t.received, t.read, t.mapped, t.linked, 700, 600, 700]);

  const want = (await lite.query(`SELECT id FROM documents WHERE tenant_id = $1 AND stage <> 'verified' ORDER BY created_at DESC, id DESC`, [id])).rows.map((r) => r.id);
  const got = [];
  const totals = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await withDb(K, (db) => db.listUnverifiedDocuments({ cursor, limit: 200 }));
    got.push(...r.rows.map((x) => x.id));
    totals.push(r.total);
    cursor = r.nextCursor;
    pages++;
  } while (cursor && pages < 50);
  check('listUnverifiedDocuments: pages through all 600 not-verified documents, newest first, each exactly once (ties included)', JSON.stringify(got) === JSON.stringify(want), `${got.length} vs ${want.length}`);
  check('listUnverifiedDocuments: the total is 600 on every page and 3 pages of <= 200 cover it', totals.every((n) => n === 600) && pages === 3, `${JSON.stringify(totals)} pages=${pages}`);
  const small = await withDb(K, (db) => db.listUnverifiedDocuments({ limit: 7 }));
  check('listUnverifiedDocuments: a small limit is honoured and a next cursor is offered', small.rows.length === 7 && !!small.nextCursor);
  const big = await withDb(K, (db) => db.listUnverifiedDocuments({ limit: 99999 }));
  eq('listUnverifiedDocuments: an oversize limit is clamped to 200', big.rows.length, 200);
  const junk = await withDb(K, (db) => db.listUnverifiedDocuments({ cursor: 'not-a-cursor', limit: 3 }));
  eq('listUnverifiedDocuments: a garbage cursor restarts at the first page', junk.rows.map((r) => r.id), want.slice(0, 3));
  const otherCur = (await withDb(K, (db) => db.browseDocuments({ limit: 5 }, { facets: 'none' }))).nextCursor;
  const wrongKind = await withDb(K, (db) => db.listUnverifiedDocuments({ cursor: otherCur, limit: 3 }));
  eq('listUnverifiedDocuments: a Records-browse cursor is not accepted here (restarts)', wrongKind.rows.map((r) => r.id), want.slice(0, 3));
  const rowShape = Object.keys(big.rows[0]);
  check('listUnverifiedDocuments: rows are plain documents rows (no internal helper column leaks)', !rowShape.includes('_created_at_raw') && rowShape.includes('stage') && rowShape.includes('original_filename'));
  const othersSum = await withDb('org_r36_counts_other', (db) => db.reviewSummary());
  eq('another shop\'s summary is its own (40 documents, all not verified)', [othersSum.total, othersSum.needsReview], [40, 40]);

  const mine = (await lite.query(`SELECT id FROM entities WHERE tenant_id = $1`, [id])).rows.map((r) => r.id);
  const theirs = (await lite.query(`SELECT id FROM entities WHERE tenant_id = $1`, [idOther])).rows.map((r) => r.id);
  const ents = await withDb(K, (db) => db.listEntitiesByIds([...mine.slice(0, 3), ...theirs, 'not-a-uuid', "'; DROP TABLE entities;--", mine[0]]));
  eq('listEntitiesByIds: returns this shop\'s requested entities (once each), never another shop\'s, ignores junk ids', ents.map((e) => e.id).sort(), mine.slice(0, 3).sort());
  eq('listEntitiesByIds: nothing in, nothing out', await withDb(K, (db) => db.listEntitiesByIds([])), []);

  // The actions are reads (any member) and answer through the records route.
  const call = async (body, role = 'member') => { const res = mkRes(); await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, authFor(K, 'user_x', role))); return res; };
  for (const body of [{ action: 'reviewSummary' }, { action: 'listUnverifiedDocuments', limit: 5 }, { action: 'listEntitiesByIds', ids: mine.slice(0, 2) }, { action: 'browseFacets', filters: {} }]) {
    const r = await call(body);
    check(`records route: ${body.action} answers a plain member with 200`, r.statusCode === 0 || r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  check('records route: all four are in the READ set (no admin needed)', ['reviewSummary', 'listUnverifiedDocuments', 'listEntitiesByIds', 'browseFacets'].every((a) => RECORDS.RECORDS_READ_ACTIONS.has(a)));

  // ---- the client graph, end to end, against this database through the real route handler ----
  const realFetch = globalThis.fetch;
  const calls = [];
  const asAuth = authFor(K, 'user_x', 'admin');
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${u} ${body.action ?? ''}`);
    const respond = (status, payload) => ({ ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload });
    if (u.endsWith('/api/records')) {
      const res = mkRes();
      await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body }, res, asAuth));
      return respond(res.statusCode || 200, res.body);
    }
    if (u.endsWith('/api/review')) return respond(200, body.action === 'listLinks' ? { links: [] } : { corrections: [] });
    if (u.endsWith('/api/document-status')) return respond(200, { documents: [] });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const SYNC = await import(rel('src/hooks/usePostgresSync.ts'));
    const G = await import(rel('src/core/entityGraph.ts'));
    const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

    SYNC.resetGraphForTenantSwitch();
    await SYNC.loadGraphFromServer(K, { hydrateOlder: true });
    const docsNow = () => Object.keys(G.useGraph.getState().docs).length;
    check('graph: the first paint holds the newest 500 documents (the old behaviour is the start, not the end)', docsNow() >= 500);
    const hydrated = await waitFor(() => G.useGraph.getState().serverCounts?.needsReviewNotLoaded === 0 && docsNow() === 1100);
    const st = G.useGraph.getState();
    check('graph: older needs-review documents are paged in behind the first paint (the 500 newest verified + all 600 not-verified = 1,100 held)', hydrated, `docs=${docsNow()} counts=${JSON.stringify(st.serverCounts)}`);
    eq('graph: server counts carry the shop-wide totals', [st.serverCounts?.documents, st.serverCounts?.needsReview, st.serverCounts?.verified], [1300, 600, 700]);
    eq('graph: documentTotalFor says 1,300, not 500', G.documentTotalFor(st), 1300);
    const unverifiedHeld = Object.values(st.docs).filter((d) => d.stage !== 'verified').length;
    eq('graph: every not-verified document is in the graph (the Inbox / Review lists can show them)', unverifiedHeld, 600);
    check('graph: pages were requested 200 at a time, not one request per document', calls.filter((c) => /listUnverifiedDocuments/.test(c)).length <= 5, `${calls.filter((c) => /listUnverifiedDocuments/.test(c)).length}`);

    // A tenant switch abandons a hydration in flight and clears the counts.
    SYNC.resetGraphForTenantSwitch();
    check('graph: a tenant switch clears the server counts and the graph', G.useGraph.getState().serverCounts == null && docsNow() === 0);

    // The phone app takes the counts only.
    calls.length = 0;
    await SYNC.loadGraphFromServer(K, { hydrateOlder: false });
    await waitFor(() => G.useGraph.getState().serverCounts != null, 5000);
    await new Promise((r) => setTimeout(r, 150));
    check('graph (phone): shop-wide counts are fetched but no older documents are paged in', G.useGraph.getState().serverCounts?.documents === 1300 && docsNow() < 1300 && !calls.some((c) => /listUnverifiedDocuments/.test(c)), `docs=${docsNow()} calls=${calls.join('|')}`);
    check('graph (phone): the totals still say 1,300', G.documentTotalFor(G.useGraph.getState()) === 1300);
    SYNC.resetGraphForTenantSwitch();
  } finally {
    globalThis.fetch = realFetch;
  }
  check('Intake and Browse screens read their totals from documentTotalFor (server counts)', /documentTotalFor/.test(read('src/screens/IntakeScreen.tsx')) && /documentTotalFor/.test(read('src/screens/BrowseScreen.tsx')));
  check('Records fetches the page first and the facets after it', /facets: false/.test(read('src/components/records/useRecordsBrowse.ts')) && /browseFacets/.test(read('src/components/records/useRecordsBrowse.ts')));
}

/* ============================================================ RESCUE */
family = 'rescue';
{
  const ev = (over = {}, objOver = {}) => ({
    id: `evt_${rnd().slice(0, 12)}`,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', mode: 'payment', payment_status: 'paid', customer: 'cus_1', amount_subtotal: 60000, metadata: { tenantId: 'x', plan: 'records_rescue', pages: '5000' }, ...objOver } },
    ...over,
  });
  const grant = BILLING.rescueGrantForEvent;
  eq('rescueGrantForEvent: a paid rescue checkout grants the pages in its metadata', grant(ev()), { pages: 5000, sessionId: 'cs_test_1' });
  eq('rescueGrantForEvent: async_payment_succeeded (a delayed method that later cleared) grants too', grant(ev({ type: 'checkout.session.async_payment_succeeded' }))?.pages, 5000);
  eq('rescueGrantForEvent: a session made before `pages` existed is derived from the subtotal at 12 cents a page', grant(ev({}, { metadata: { plan: 'records_rescue' }, amount_subtotal: 12 * 8000 }))?.pages, 8000);
  eq('rescueGrantForEvent: an unpaid session (completed but payment pending) grants nothing', grant(ev({}, { payment_status: 'unpaid' })), null);
  eq('rescueGrantForEvent: async_payment_failed grants nothing', grant(ev({ type: 'checkout.session.async_payment_failed' })), null);
  eq('rescueGrantForEvent: a subscription checkout grants nothing', grant(ev({}, { mode: 'subscription' })), null);
  eq('rescueGrantForEvent: another plan\'s payment grants nothing', grant(ev({}, { metadata: { plan: 'solo', pages: '5000' } })), null);
  eq('rescueGrantForEvent: below the 4,167-page minimum grants nothing', grant(ev({}, { metadata: { plan: 'records_rescue', pages: '4166' }, amount_subtotal: 4166 * 12 })), null);
  eq('rescueGrantForEvent: a non-whole or absurd page count grants nothing', [grant(ev({}, { metadata: { plan: 'records_rescue', pages: '5000.5' }, amount_subtotal: 1 })), grant(ev({}, { metadata: { plan: 'records_rescue', pages: '2000000' } })), grant(ev({}, { metadata: { plan: 'records_rescue', pages: '-9' }, amount_subtotal: 0 }))], [null, null, null]);
  eq('rescueGrantForEvent: other event types and empty input grant nothing', [grant(ev({ type: 'invoice.paid' })), grant(null), grant({})], [null, null, null]);
  const patched = BILLING.patchForEvent(ev());
  check('patchForEvent: a rescue purchase records the customer but never changes the plan or status', patched && !patched.patch.plan && !patched.patch.billing_status, JSON.stringify(patched));
  check('async_payment_succeeded is read by the plan patcher too (same shape as completed)', BILLING.patchForEvent(ev({ type: 'checkout.session.async_payment_succeeded' }))?.customerId === 'cus_1');

  // The checkout session carries the page count.
  let sent = null;
  const fakeStripe = { prices: { list: async () => ({ data: [{ id: 'price_x' }] }) }, checkout: { sessions: { create: async (p) => { sent = p; return { url: 'https://stripe.test/c' }; } } } };
  await BILLING.createCheckoutSession(fakeStripe, { plan: 'records_rescue', quantity: 6000, tenantId: 't1', customerId: 'cus_1', successUrl: 'https://x/s', cancelUrl: 'https://x/c' }).catch((e) => { sent = sent ?? { error: e.message }; });
  check('createCheckoutSession (rescue): metadata.pages is the quantity bought', sent?.metadata?.pages === '6000' && sent?.mode === 'payment', JSON.stringify(sent).slice(0, 200));

  // ---- the ledger, the credit and the gate ----
  const pg = (await import('pg')).default;
  const pool = new pg.Pool();
  const K = 'org_r36_rescue';
  const owner = { plan: 'solo', pagesPerMonth: 750, extraPagesPerMonth: 100, maxModelCallsPerDay: 9000, testAccount: true };
  const id = await newTenant(K, 'solo', 'active', owner);
  const credit = async (row) => withDb(K, (db) => PLAN.loadRescueCredit(db, row ?? { plan: 'solo', limits: owner }));
  const apply = (event) => BILLING.recordAndApplyEvent(pool, event, id, BILLING.patchForEvent(event).patch);

  const e1 = ev({ id: 'evt_resc_1' });
  eq('webhook: the first delivery of a paid rescue order is applied', await apply(e1), 'applied');
  eq('credit: 5,000 pages granted, none used yet', await credit(), { granted: 5000, used: 0, remaining: 5000 });
  eq('webhook: a retried / replayed delivery of the SAME event is a duplicate (Stripe retries for days)', await apply(e1), 'duplicate');
  eq('credit: ...and adds nothing', (await credit()).granted, 5000);
  await apply(ev({ id: 'evt_resc_2' }, { id: 'cs_test_2', metadata: { tenantId: 'x', plan: 'records_rescue', pages: '4167' }, amount_subtotal: 4167 * 12 }));
  eq('credit: a second order adds its own pages (9,167)', (await credit()).granted, 9167);

  const ledger = (await lite.query(`SELECT id, payload FROM billing_events WHERE tenant_id = $1 AND payload ? 'rescuePages' ORDER BY id`, [id])).rows;
  check('the ledger row IS the credit: one row per paid order, with the pages and the Stripe session id', ledger.length === 2 && ledger[0].payload.sessionId === 'cs_test_1' && ledger[0].payload.rescuePages === 5000, JSON.stringify(ledger));

  // Survives the R35 owner-override preservation and a plan change, because it never lived in tenants.limits.
  await lite.query('SELECT billing_apply($1, $2::jsonb)', [id, JSON.stringify({ plan: 'shop', billing_status: 'active', limits: { plan: 'shop', pagesPerMonth: 2000 } })]);
  const lim = (await lite.query('SELECT limits FROM tenants WHERE id = $1', [id])).rows[0].limits;
  check('a subscription event replaces the plan keys but the owner overrides survive (R35 contract still holds)', lim.pagesPerMonth === 2000 && lim.extraPagesPerMonth === 100 && lim.maxModelCallsPerDay === 9000, JSON.stringify(lim));
  eq('credit: a plan change does not touch it', (await credit({ plan: 'shop', limits: lim })).granted, 9167);
  await lite.query('SELECT billing_apply($1, $2::jsonb)', [id, JSON.stringify({ plan: 'solo', billing_status: 'active', limits: { plan: 'solo', pagesPerMonth: 750 } })]);
  resetCaches();

  // Consumption: only the part of a past month above the plan + extra allowance is drawn from the credit.
  const { rows: [{ id: docId }] } = await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count) VALUES ($1,'bulk.pdf',$2,1,'read','k','application/pdf',1) RETURNING id`, [id, rnd()]);
  await lite.query(`UPDATE billing_events SET received_at = NOW() - INTERVAL '75 days' WHERE tenant_id = $1 AND payload ? 'rescuePages'`, [id]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text, created_at)
                    SELECT $1, $2, g, '', 'p', date_trunc('month', NOW() - INTERVAL '2 months') + INTERVAL '3 days' FROM generate_series(1, 1850) g`, [id, docId]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text, created_at)
                    SELECT $1, $2, 5000 + g, '', 'p', date_trunc('month', NOW() - INTERVAL '1 month') + INTERVAL '3 days' FROM generate_series(1, 300) g`, [id, docId]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text) SELECT $1, $2, 9000 + g, '', 'p' FROM generate_series(1, 4000) g`, [id, docId]);
  const c2 = await credit();
  eq('credit: 1,850 pages two months ago (850 allowance) used 1,000; 300 last month used none; this month is headroom, not spent', [c2.used, c2.remaining], [1000, 8167]);
  const capRow = { plan: 'solo', billing_status: 'active', limits: { extraPagesPerMonth: 100 }, rescuePagesRemaining: c2.remaining };
  eq('gate: the monthly cap is plan 750 + extra 100 + unused rescue pages', PLAN.pageCapFor(capRow), 750 + 100 + 8167);
  check('gate: 5,000 pages read this month is allowed on that credit, and refused without it', PLAN.gateUpload(capRow, { documentsStored: 0, pagesThisMonth: 5000 }).allowed === true && PLAN.gateUpload({ ...capRow, rescuePagesRemaining: 0 }, { documentsStored: 0, pagesThisMonth: 5000 }).allowed === false);
  eq('gate: a garbage rescue balance counts as none', [PLAN.rescuePagesFor({ rescuePagesRemaining: -5 }), PLAN.rescuePagesFor({ rescuePagesRemaining: 'x' }), PLAN.rescuePagesFor(null)], [0, 0, 0]);
  await lite.query(`INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text, created_at)
                    SELECT $1, $2, 20000 + g, '', 'p', date_trunc('month', NOW() - INTERVAL '1 month') + INTERVAL '5 days' FROM generate_series(1, 12000) g`, [id, docId]);
  const c3 = await credit();
  eq('credit: usage past the whole balance clamps to zero left, never negative', [c3.used, c3.remaining], [9167, 0]);

  // End to end through the cached billing row the upload gate reads.
  resetCaches();
  const row = await PLAN.getCachedBillingRow({ tenantKey: K, tenantName: K });
  check('the billing row the upload gate reads carries rescuePagesRemaining (0 after the clamp)', row.rescuePagesRemaining === 0, JSON.stringify({ ...row, limits: undefined }));
  await lite.query(`DELETE FROM document_pages WHERE tenant_id = $1 AND page_no >= 20000 AND page_no < 40000`, [id]);
  resetCaches();
  const row2 = await PLAN.getCachedBillingRow({ tenantKey: K, tenantName: K });
  eq('...and 8,167 once that usage is removed', row2.rescuePagesRemaining, 8167);

  // Tenant scoped; fails closed.
  await newTenant('org_r36_rescue_b', 'solo', 'active');
  eq('credit: another shop has none', await withDb('org_r36_rescue_b', (db) => PLAN.loadRescueCredit(db, { plan: 'solo', limits: {} })), { granted: 0, used: 0, remaining: 0 });
  const quietCredit = await quiet(() => PLAN.loadRescueCredit({ raw: async () => { throw new Error('boom'); } }, { plan: 'solo', limits: {} }));
  eq('credit: a database error means "no credit" (the plain plan cap), never a crash or a free pass', quietCredit, { granted: 0, used: 0, remaining: 0 });

  // A paid order must not be acknowledged when the ledger is down (Stripe retries); everything else keeps the old behaviour.
  const downPool = (failLedger) => ({
    connect: async () => ({
      query: async (sql) => {
        if (/billing_record_event/.test(sql) && failLedger) throw new Error('ledger down');
        if (/billing_record_event/.test(sql)) return { rows: [{ fresh: true }] };
        return { rows: [] };
      },
      release() {},
    }),
  });
  let threw = false;
  await quiet(() => BILLING.recordAndApplyEvent(downPool(true), ev({ id: 'evt_down_1' }), id, { stripe_customer_id: 'cus_1' })).catch(() => { threw = true; });
  check('a paid rescue order with the ledger unavailable is refused (Stripe retries) instead of being acknowledged uncredited', threw);
  const plainSub = { id: 'evt_down_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } } };
  let ok2 = true;
  await quiet(() => BILLING.recordAndApplyEvent(downPool(true), plainSub, id, { stripe_customer_id: 'cus_1' })).catch(() => { ok2 = false; });
  check('...but an ordinary subscription event still applies without the ledger (unchanged R30 behaviour)', ok2);
  await pool.end?.();

  const status = read('api/billing.js');
  check('GET /api/billing reports rescuePagesRemaining, rescuePagesPurchased and extraPagesPerMonth', /rescuePagesRemaining/.test(status) && /rescuePagesPurchased/.test(status) && /extraPagesPerMonth/.test(status));
  check('the webhook event list still handles checkout.session.completed (async_payment_succeeded is read too if Stripe is set to send it: a dashboard step)', BILLING.WEBHOOK_EVENTS.includes('checkout.session.completed'));
}

/* ============================================================ CANCELED */
family = 'canceled';
{
  const K = 'org_r36_canceled';
  const id = await newTenant(K, 'shop', 'canceled');
  await lite.exec(`
    INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at) SELECT '${id}', 'customer', jsonb_build_object('customer_name', 'Gone ' || g), 'G-' || g, NOW(), NOW() FROM generate_series(1, 30) g;
    INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, created_at, updated_at)
    SELECT '${id}', 'gone-' || g || '.pdf', 'invoice', md5('g' || g::text) || md5('h' || g::text), 10, 'verified', '${id}/orig/' || g, 'application/pdf', 1, NOW(), NOW() FROM generate_series(1, 120) g;
  `);
  resetCaches();

  // Export: the whole file, through the same function the route streams, with no billing check in front of it.
  let out = '';
  const summary = await OPS.streamTenantExport({ tenantKey: K, tenantName: K }, async (s) => { out += s; }, {});
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* reported below */ }
  check('canceled shop: the export is complete, valid JSON', summary?.ok === true && !summary.truncated && !!parsed, `${summary && JSON.stringify(summary)} ${out.slice(0, 80)}`);
  const keys = parsed ? Object.keys(parsed) : [];
  check('canceled shop: every document (120) is in it', parsed?.documents?.length === 120, `keys=${keys.join(',')} docs=${parsed?.documents?.length}`);
  check('canceled shop: every customer (30) is in it', JSON.stringify(parsed ?? {}).split('"Gone ').length - 1 >= 30);
  const originals = parsed?.manifest?.originals ?? [];
  check('canceled shop: the originals manifest lists every file (so each can be fetched on demand)', originals.length === 120, `${originals.length} ${JSON.stringify(originals[0])}`);
  check('canceled shop: no internal storage key is in the export', !/\/orig\//.test(out));

  // Everything else is refused.
  const gate = await UP.checkUploadGate(authFor(K));
  check('canceled shop: uploading is refused with a 402', gate.allowed === false && gate.status === 402, JSON.stringify({ ...gate, billingRow: undefined }));
  const paid = await PLAN.assertActiveBilling({ tenantKey: K, tenantName: K });
  check('canceled shop: assertActiveBilling refuses with a 402 (ask, read-document, extract and the review writes use it)', paid.allowed === false && paid.status === 402, JSON.stringify(paid));

  // The routes behind the export have no billing gate, and the way to the files is reachable from a canceled shop's screens.
  for (const f of ['api/_lib/routes/tenant-export.js', 'api/_lib/routes/export-csv.js']) {
    check(`${f} has no billing gate (a canceled shop can always take its data out)`, !/assertActiveBilling|requireActiveBilling|checkUploadGate|planStateFor/.test(read(f)));
  }
  const team = read('src/screens/TeamScreen.tsx');
  check('Team (reachable when canceled): the JSON export (documents + originals manifest) and the three CSVs are both there', /tenant-export|downloadTenantExport|exportClient/i.test(team) && /DataExportButtons/.test(team));
  const btn = read('src/components/records/DataExportButtons.tsx');
  check('DataExportButtons offers documents, customers and units as CSV', ['documents', 'customers', 'equipment'].every((k) => new RegExp(`kind: '${k}'`).test(btn)) && /downloadExportCsv/.test(btn));
}

/* ============================================================ EXPENSES */
family = 'expenses';
{
  const V = EXP.validateReceiptSize;
  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.status ?? e.message; } };
  eq('receipt size: missing / null -> 400', [code(() => V(undefined)), code(() => V(null))], [400, 400]);
  check('receipt size: the message is the one the customer upload paths use', (() => { try { V(undefined); } catch (e) { return /sizeBytes is required/.test(e.message); } return false; })());
  eq('receipt size: 0, negative, fractional, a string, NaN -> 400', [0, -1, 1.5, '12', NaN].map((x) => code(() => V(x))), [400, 400, 400, 400, 400]);
  eq('receipt size: 24 MB exactly is fine, one byte more is 413', [code(() => V(24 * 1024 * 1024)), code(() => V(24 * 1024 * 1024 + 1))], ['ok', 413]);
  eq('receipt size: a normal receipt photo is returned as is', V(3_200_000), 3_200_000);

  const call = (b) => EXP.handleReceiptUploadUrl(b);
  await throws('receiptUploadUrl without sizeBytes -> 400', () => call({ contentType: 'application/pdf' }), 400, /sizeBytes is required/);
  await throws('receiptUploadUrl over the cap -> 413 before any URL is made', () => call({ contentType: 'image/jpeg', sizeBytes: 30 * 1024 * 1024 }), 413);
  await throws('receiptUploadUrl with a bad content type -> 400', () => call({ contentType: 'text/html', sizeBytes: 100 }), 400);
  const ok = await call({ contentType: 'image/jpeg', sizeBytes: 123456 });
  check('receiptUploadUrl: a valid size signs content-length into the PUT URL (storage refuses any other length)', /content-length/i.test(ok.uploadUrl ?? '') && /^platform\/expenses\//.test(ok.receiptKey ?? ''), ok.uploadUrl);
  const client = read('src/services/expensesClient.ts');
  check('the client sends the size', /requestReceiptUploadUrl\([^)]*sizeBytes/.test(client));
  check('every caller passes file.size', (read('src/screens/ExpensesScreen.tsx').match(/requestReceiptUploadUrl\([^)]*file\.size\)/g) ?? []).length >= 2);
}

/* ============================================================ STRUCTURE */
family = 'structure';
{
  const top = fs.readdirSync(rel('api')).filter((f) => fs.statSync(rel(`api/${f}`)).isFile());
  eq('api/ still has exactly 12 top-level files (the Vercel function ceiling)', top.length, 12);
  const sql = read('M3-config/64-records-search-indexes.sql');
  const code = sql.replace(/--.*$/gm, '');
  check('M3-config/64 is idempotent (IF NOT EXISTS / CREATE OR REPLACE only, nothing destructive)', !/\bDROP\b/i.test(code) && /CREATE OR REPLACE FUNCTION records_search_candidates/.test(code) && !/CREATE INDEX(?! IF NOT EXISTS)/.test(code));
  check('M3-config/64: the function is SECURITY DEFINER, pins its search_path, and is revoked from PUBLIC', /SECURITY DEFINER/.test(code) && /SET search_path = public, pg_temp/.test(code) && /REVOKE ALL ON FUNCTION records_search_candidates\(text, text\) FROM PUBLIC/.test(code));
  const body = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION records_search_candidates'), code.indexOf('REVOKE ALL ON FUNCTION records_search_candidates'));
  const tenantRefs = (body.match(/tenant_id = NULLIF\(current_setting\('app\.tenant_id', true\), ''\)::uuid/g) ?? []).length;
  check('M3-config/64: every table the function reads is filtered by the caller\'s tenant (4 explicit predicates)', tenantRefs === 4, `${tenantRefs}`);
  await lite.exec(sql);
  check('M3-config/64 runs a second time without error', true);
}

console.log('');
for (const [f, c] of Object.entries(fam)) console.log(`${f.padEnd(10)} ${c.pass} passed${c.fail ? `, ${c.fail} FAILED` : ''}`);
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll R36 scale checks passed.');
process.exit(failed ? 1 : 0);
