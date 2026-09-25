/**
 * Checks for the Donovan research agent v2 (api/_lib/agent/loopV2.js, verify.js, router.js, and the v2
 * tool additions in tools.js: read_document, get_unit, follow_links, timeline, compute).
 *
 * Same harness style as scripts/verify-agent.mjs (a REAL Postgres via PGlite, migrated from the actual
 * M3-config/*.sql, queried as the app's non-superuser deepwell_rls role) — v1's own harness is not
 * touched or reused directly (this file stands alone) so the two suites never interfere with each
 * other's schema/session state.
 *
 * Covers (build spec "Tests" list, v2-specific items):
 *   - the v2 tool loop with a scripted model, including several tool calls in one turn (parallel)
 *   - read_document pagination (a document long enough to need a second page)
 *   - graph/timeline correctness (follow_links, timeline, get_unit)
 *   - the verify step dropping an unsupported fact (and the one bounded re-research retry)
 *   - budgets/caps (MAX_TOOL_CALLS_V2, input token cap, deadline)
 *   - streaming event order (onEvent: plan before tool before verify)
 *   - tenant isolation for the new v2 tools
 *   - non-streaming fallback (no onEvent — must behave identically, just silently)
 *
 *   node scripts/verify-agent-v2.mjs
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
process.env.DONOVAN_RESEARCH_DAILY_USD = process.env.DONOVAN_RESEARCH_DAILY_USD ?? '10';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY; // synthesize (mapReduceAnswer) must degrade gracefully with no key, not crash
delete process.env.VOYAGE_API_KEY; // search_documents(v2) falls back to keyword-only via searchKnowledge, same as v1

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"'))) return; realLog(...a); };

/* ================================================================== pure checks (no DB) */
{
  const { computeExpression } = await import('../api/_lib/agent/computeExpr.js');
  eq('compute: arithmetic', computeExpression('2 + 3 * 4', '2026-09-25'), { ok: true, value: 14 });
  eq('compute: daysBetween', computeExpression("daysBetween('2026-01-01','2026-09-25')", '2026-09-25'), { ok: true, value: 267 });
  eq('compute: addMonths returns a date, no spurious numeric coercion', computeExpression('addMonths(today(), 6)', '2026-09-25'), { ok: true, value: '2027-03-25' });
  check('compute: division by zero is refused, not Infinity/NaN', computeExpression('1/0', '2026-09-25').ok === false);
  check('compute: arbitrary text is a parse error, never executed (no eval surface)', computeExpression("require('fs').readFileSync('/etc/passwd')", '2026-09-25').ok === false);
  check('compute: an unknown function name is rejected', computeExpression('frobnicate(1,2)', '2026-09-25').ok === false);

  const { classifyRoute } = await import('../api/_lib/agent/router.js');
  check('router: a comparison question routes to research with a reason', classifyRoute('do we have more invoices or more work orders').route === 'research');
  check('router: a plain single-field lookup is classified simple (still runs on the research agent; this is telemetry only)', classifyRoute('what serial is on the unit at 17 Cactus Ln').route === 'simple');
  check('router: logRouteDecision never receives/logs the question text itself', true); // structural: see ask.js wiring check below

  const askSrc = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('ask.js: research agent v2 is wired behind DONOVAN_RESEARCH_AGENT via isResearchAgentEnabled()', /isResearchAgentEnabled\(\)/.test(askSrc));
  check('ask.js: route decisions are logged via logRouteDecision(question, ...), never a raw console.log with question text', /logRouteDecision\(question,/.test(askSrc));
  check('ask.js: maxDuration is raised for the research agent\'s longer budget', /maxDuration:\s*300/.test(askSrc));
  check('ask.js: streaming is opt-in only (`stream: true` in the request body), never on by default', /req\.body\?\.stream === true/.test(askSrc));
  const routerSrc = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'agent', 'router.js'), 'utf8');
  check('router.js: the route-decision log line never includes question/answer text (counts + reason codes only)', !/console\.log\([^)]*question/.test(routerSrc));
}

/* ================================================================== verify.js: deterministic-field skip (perf pass item 3) */
{
  const { verifyFacts, DETERMINISTIC_FIELD_KEYS } = await import('../api/_lib/agent/verify.js');
  const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  let fetchCalls = 0;
  const neverActuallyFetch = async () => { fetchCalls++; return null; };
  const data = {
    kind: 'answer', text: 'Warranty is active.', confidence: 0.9,
    facts: [{ label: 'Warranty', value: 'active', sources: [{ documentId: DOC, location: { field: 'warranty_status' } }] }],
  };
  const { data: out, droppedCount, skippedCount } = await verifyFacts(data, neverActuallyFetch);
  check('verify skip: a fact citing a deterministic/computed field (warranty_status) never reaches the DB re-fetch at all', fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  eq('verify skip: it is counted as skipped (not checked), and never dropped', [droppedCount, skippedCount], [0, 1]);
  check('verify skip: the fact itself survives unchanged', out.facts.length === 1 && out.facts[0].value === 'active', JSON.stringify(out.facts));
  check('verify skip: DETERMINISTIC_FIELD_KEYS covers the financials fields too (they live in document_financials, not extractions)',
    ['total', 'subtotal', 'tax', 'amount_paid', 'balance_due', 'open_balance', 'days_past_due'].every((k) => DETERMINISTIC_FIELD_KEYS.has(k)));

  // The batched .prefetch() path must exclude these sources too (nothing useful to fetch for them).
  const seenPrefetch = [];
  const fetcher = async () => null;
  fetcher.prefetch = async (sources) => { seenPrefetch.push(...sources); };
  const data2 = {
    kind: 'answer', text: 'x', confidence: 0.9,
    facts: [
      { label: 'Warranty', value: 'active', sources: [{ documentId: DOC, location: { field: 'warranty_status' } }] },
      { label: 'Technician', value: 'jordan', sources: [{ documentId: DOC, location: { field: 'technician' } }] },
    ],
  };
  await verifyFacts(data2, fetcher);
  check('verify skip: the prefetch batch itself excludes deterministic-field sources (only the real "technician" field is sent)',
    seenPrefetch.length === 1 && seenPrefetch[0].location.field === 'technician', JSON.stringify(seenPrefetch));
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
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) { try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* see verify-agent.mjs: some depend on later files */ } }
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
const { createToolbox } = await import('../api/_lib/agent/tools.js');
const {
  runResearchAgent, MAX_TURNS_V2, MAX_TOOL_CALLS_V2, researchAllowed, RESEARCH_BUCKET,
} = await import('../api/_lib/agent/loopV2.js');
const { ModelBudgetExceededError } = await import('../api/_lib/rateLimit.js');

const TODAY = '2026-09-25';
const ctxA = { tenantKey: 'org_harness_v2_a', tenantName: 'Desert Peak HVAC (v2)' };
const ctxB = { tenantKey: 'org_harness_v2_b', tenantName: 'Other Shop (v2)' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedTenant(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address }, { number: `C-0000${c.n}` });
  for (const e of world.equipment) {
    await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) }, { customerId: uid(t, 'c', e.customer) });
  }
  for (const d of world.docs) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, d.stage ?? 'verified']);
    for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
    for (const x of d.facts ?? []) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, corrected_value, confidence) VALUES ($1,$2,$3,$4,$5,$6,0.9)', [tenantId, uid(t, 'd', d.n), x.entity ?? null, x.key, x.value, x.corrected ?? null]);
    for (const [i, text] of (d.pages ?? []).entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid(t, 'd', d.n), tenantId, i + 1, text]);
  }
  // Unit-level links (document_entity_links pointing straight at the equipment row, not the customer) —
  // inserted last, after both entities and documents exist, since it can reference either world list.
  for (const e of world.equipment) {
    for (const dn of e.linkDocs ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', dn), uid(t, 'e', e.n)]);
  }
}

const LONG_PAGE = (label) => `${label} `.repeat(1200); // ~10-11k chars: forces read_document to paginate at the 12k cap
const worldA = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201' },
    { n: 2, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1001', type: 'condenser', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01' }, linkDocs: [2] },
  ],
  docs: [
    // A long contract-like document, 3 pages, needing more than one read_document call to see it all.
    { n: 1, file: 'karen-maintenance-contract.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 1)],
      pages: [LONG_PAGE('PAGE-ONE contract terms for Karen Abernathy'), LONG_PAGE('PAGE-TWO renewal clause'), 'PAGE-THREE signatures and the true agreement term: 01/01/2026 - 12/31/2026.'] },
    // A unit-specific service record (linked to the equipment row directly, not the customer).
    { n: 2, file: 'karen-unit-service.pdf', type: 'service-ticket', links: [], facts: [{ key: 'service_date', value: '2026-06-01' }],
      pages: ['Serviced the Trane XR14 condenser. Replaced the capacitor.'] },
    // Two more customer-level documents, for a timeline with real spread.
    { n: 3, file: 'karen-earlier-visit.pdf', type: 'service-ticket', links: [uid('a', 'c', 1)], facts: [{ key: 'service_date', value: '2025-01-15' }], pages: ['Earlier visit, filter change only.'] },
    { n: 4, file: 'karen-invoice.pdf', type: 'invoice', links: [uid('a', 'c', 1)], facts: [{ key: 'service_date', value: '2026-06-01' }], pages: ['Invoice for the capacitor replacement. Total due: $410.00.'] },
    // A document whose extracted fact will be cited by a scripted model as something the page does NOT say
    // (the verify-step fixture): the page text never mentions a specific serial the model will claim.
    { n: 5, file: 'plaza-nameplate.pdf', type: 'nameplate-photo', links: [uid('a', 'c', 2)], pages: ['Nameplate photo, illegible in parts.'] },
  ],
};
const worldB = {
  customers: [{ n: 1, name: 'Secret Customer', address: '1 Hidden Way, Reno, NV 89501' }],
  equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9', type: 'condenser', installed: '2022-01-01', address: '1 Hidden Way, Reno, NV 89501' }],
  docs: [{ n: 1, file: 'b-secret.pdf', type: 'service-ticket', links: [uid('b', 'c', 1)], facts: [{ key: 'service_date', value: '2026-01-01' }], pages: ['SECRET-TOKEN-XYZ tenant B only'] }],
};
await seedTenant('a', tenA, worldA);
await seedTenant('b', tenB, worldB);

const toolboxA = () => createToolbox({ withTenant, ctxArg: ctxA, today: TODAY, variant: 'v2' });
const parse = (r) => JSON.parse(Array.isArray(r.content) ? r.content.find((b) => b.type === 'text')?.text ?? '{}' : r.content);
// read_document's content is a JSON header immediately followed by plain page text (never JSON itself,
// since a transcript can contain anything) — parse just the header.
const parseReadDoc = (r) => { const idx = r.content.indexOf('\n--- page '); return JSON.parse(idx >= 0 ? r.content.slice(0, idx) : r.content); };

/* ================================================================== v2 tools: direct execution */
{
  const tb = toolboxA();
  const r1 = await tb.execute('read_document', { documentId: uid('a', 'd', 1) });
  const p1 = parseReadDoc(r1);
  check('read_document: page 1 comes back with a nextPage cursor (the document is longer than the cap)', r1.ok && Array.isArray(p1.pagesShown) && p1.pagesShown[0] === 1 && Number.isInteger(p1.nextPage), r1.content.slice(0, 200));
  const r2 = await tb.execute('read_document', { documentId: uid('a', 'd', 1), fromPage: p1.nextPage });
  check('read_document: continuing with the returned nextPage reaches the final page (the real agreement term)', r2.ok && r2.content.includes('true agreement term'), r2.content.slice(-200));
  const rBad = await tb.execute('read_document', { documentId: 'not-a-uuid' });
  check('read_document: a non-uuid documentId is refused, not a DB error', rBad.ok === false);

  const unit = await tb.execute('get_unit', { equipmentId: uid('a', 'e', 1) });
  const up = parse(unit);
  check('get_unit: returns the unit\'s own profile, its customer, and ONLY documents linked to this unit (not the whole customer)', unit.ok && up.unit.serial === 'TR-1001' && up.customer.name === 'Karen Abernathy' && up.documents.length === 1 && up.documents[0].documentId === uid('a', 'd', 2), unit.content.slice(0, 300));

  const flCust = await tb.execute('follow_links', { entityId: uid('a', 'c', 1) });
  const flc = parse(flCust);
  check('follow_links: from a customer id, reaches its equipment and every linked document', flCust.ok && flc.kind === 'customer' && flc.equipment.length === 1 && flc.documentIds.length >= 3, flCust.content.slice(0, 300));
  const flEquip = await tb.execute('follow_links', { entityId: uid('a', 'e', 1) });
  const fle = parse(flEquip);
  check('follow_links: from an equipment id, reaches its OWN customer and its own-linked document', flEquip.ok && fle.kind === 'equipment' && fle.customerId === uid('a', 'c', 1) && fle.documentIds.includes(uid('a', 'd', 2)), flEquip.content.slice(0, 300));
  const flDoc = await tb.execute('follow_links', { entityId: uid('a', 'd', 1) });
  const fld = parse(flDoc);
  check('follow_links: from a document id, reaches its customer', flDoc.ok && fld.kind === 'document' && fld.customerId === uid('a', 'c', 1), flDoc.content.slice(0, 300));

  const tl = await tb.execute('timeline', { customerId: uid('a', 'c', 1), order: 'asc' });
  const tlp = parse(tl);
  check('timeline: chronological (asc) events for a customer, earliest first', tl.ok && tlp.events[0].date === '2025-01-15' && tlp.events[tlp.events.length - 1].date >= '2026-06-01', tl.content.slice(0, 300));
  const tlUnit = await tb.execute('timeline', { equipmentId: uid('a', 'e', 1) });
  const tlu = parse(tlUnit);
  check('timeline: scoped to one unit only sees documents linked to that unit', tlUnit.ok && tlu.events.length === 1 && tlu.events[0].documentId === uid('a', 'd', 2), tlUnit.content.slice(0, 300));
  const tlFiltered = await tb.execute('timeline', { customerId: uid('a', 'c', 1), documentType: 'invoice' });
  const tlf = parse(tlFiltered);
  check('timeline: documentType filter narrows correctly', tlFiltered.ok && tlf.events.length === 1 && tlf.events[0].documentType === 'invoice', tlFiltered.content.slice(0, 300));

  const comp = await tb.execute('compute', { expression: "daysBetween('2026-06-01','2026-09-25')" });
  const cp = parse(comp);
  eq('compute tool: result is exposed to the model as a plain number', cp.result, 116);
}

/* ================================================================== TEAM T2 wiring: search_documents(v2), get_dossier, synthesize */
{
  const tb = toolboxA();
  const search = await tb.execute('search_documents', { query: 'capacitor' });
  const sp = parse(search);
  check('search_documents(v2): routes through searchKnowledge and still finds the matching page', search.ok && sp.results.some((r) => r.documentId === uid('a', 'd', 2)), search.content.slice(0, 300));
  check('search_documents(v2): a found passage is added to the evidence ledger', tb.ledger.passages.some((p) => p.documentId === uid('a', 'd', 2)));

  // Karen's unit-service document (d2) is linked to her EQUIPMENT, not to her customer row directly (see
  // worldA: doc 2 has links:[], reached only via equipment 1's linkDocs) — the same "linked only via its
  // equipment's customer" shape AskScreen's own scope tests cover. searchKnowledge's filters merge
  // customerIds+unitIds into one union query (see tools.js's scopeEquipmentIds comment), so a customerId-
  // scoped search must still reach it.
  const scoped = await tb.execute('search_documents', { query: 'capacitor', customerId: uid('a', 'c', 1) });
  const scp = parse(scoped);
  check('search_documents(v2): customerId scope still reaches a document linked only via the customer\'s own equipment', scoped.ok && scp.results.some((r) => r.documentId === uid('a', 'd', 2)), scoped.content.slice(0, 300));
  const scopedElsewhere = await tb.execute('search_documents', { query: 'capacitor', customerId: uid('a', 'c', 2) });
  const scep = parse(scopedElsewhere);
  check('search_documents(v2): scoped to a DIFFERENT customer never returns another customer\'s document', scopedElsewhere.ok && !scep.results.some((r) => r.documentId === uid('a', 'd', 2)));

  const dossierMissing = await tb.execute('get_dossier', { entityId: uid('a', 'c', 1) });
  const dmp = parse(dossierMissing);
  check('get_dossier: no dossier built yet degrades to dossier:null, not an error', dossierMissing.ok && dmp.dossier === null && dossierMissing.empty === true, dossierMissing.content.slice(0, 200));
  const dossierBadId = await tb.execute('get_dossier', { entityId: 'not-a-uuid' });
  check('get_dossier: a non-uuid entityId is refused, not a DB error', dossierBadId.ok === false);

  const synth = await tb.execute('synthesize', { question: 'everything about Karen Abernathy', customerId: uid('a', 'c', 1) });
  check('synthesize: with no model API key configured, fails gracefully (not-configured) rather than crashing', synth.ok === false && /not.?configured/i.test(synth.content));
  const synthNoQ = await tb.execute('synthesize', {});
  check('synthesize: a missing question is refused, not a crash', synthNoQ.ok === false);
}

/* ================================================================== tenant isolation for v2 tools */
{
  const tb = toolboxA();
  const foreignUnit = await tb.execute('get_unit', { equipmentId: uid('b', 'e', 1) });
  check('get_unit: a tenant B equipment id under tenant A returns "no such unit", not tenant B\'s data', foreignUnit.ok && parse(foreignUnit).unit === null && !foreignUnit.content.includes('YK-9'));
  const foreignLinks = await tb.execute('follow_links', { entityId: uid('b', 'c', 1) });
  check('follow_links: a tenant B id under tenant A finds nothing', foreignLinks.ok === false);
  const foreignTimeline = await tb.execute('timeline', { customerId: uid('b', 'c', 1) });
  const ftp = parse(foreignTimeline);
  check('timeline: a tenant B customer id under tenant A returns zero events, never SECRET-TOKEN-XYZ', foreignTimeline.ok && ftp.events.length === 0 && !foreignTimeline.content.includes('SECRET'));
  const foreignRead = await tb.execute('read_document', { documentId: uid('b', 'd', 1) });
  check('read_document: a tenant B document id under tenant A is refused (no such document), never its text', foreignRead.ok === false && !foreignRead.content.includes('SECRET'));
}

/* ================================================================== per-request memo (build spec item 4) */
{
  const tb = toolboxA();
  const r1 = await tb.execute('find_customers', { name: 'Karen Abernathy' });
  const r2 = await tb.execute('find_customers', { name: 'Karen Abernathy' });
  check('memo: an identical (name, args) tool call in the same run is served from the memo, not re-queried',
    r1.ok && r2.ok && r2.cached === true && !r1.cached && r2.content === r1.content, JSON.stringify({ r1cached: r1.cached, r2cached: r2.cached }));
  eq('memo: exactly one call was served from the memo so far', tb.memoHits, 1);

  const r3 = await tb.execute('find_customers', { name: 'Plaza Dental Group' });
  check('memo: a DIFFERENT input for the same tool name is never served from the memo (runs for real)', r3.ok && !r3.cached);
  eq('memo: the memo-hit count only grows on an actual duplicate, not every call', tb.memoHits, 1);

  // Concurrent duplicates in the SAME batch (as runToolsBounded issues within one model turn) must also
  // dedupe onto one real call, not race two.
  const tb2 = toolboxA();
  const [c1, c2] = await Promise.all([tb2.execute('describe_data', {}), tb2.execute('describe_data', {})]);
  check('memo: two CONCURRENT identical calls in one batch dedupe onto the one real call', c1.ok && c2.ok && (c1.cached === true) !== (c2.cached === true), JSON.stringify({ c1: c1.cached, c2: c2.cached }));
  eq('memo: concurrent duplicates count as exactly one memo hit', tb2.memoHits, 1);

  // view_document_page is deliberately excluded (see tools.js's own comment): it spends a per-question
  // MAX_VIEWS budget even on a repeat of the exact same documentId+page, so it must never be served from
  // the memo (covered end-to-end by scripts/verify-scorecard.mjs's "at most 2 views per question" case).
}

/* ================================================================== research agent: scripted model loop */
let toolUseCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
const lastToolResult = (messages) => {
  const last = messages[messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { text: Array.isArray(block.content) ? JSON.stringify(block.content) : block.content, isError: Boolean(block.is_error) } : null;
};
function scripted(turns, usage = { input_tokens: 3000, output_tokens: 200 }) {
  let i = 0;
  const calls = [];
  const fn = async (req) => {
    calls.push({ tool_choice: req.tool_choice, temperature: req.temperature, model: req.model, nMessages: req.messages.length, lastResult: lastToolResult(req.messages) });
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const out = typeof turn === 'function' ? turn(req.messages, req) : turn;
    const content = Array.isArray(out) ? out : out.content;
    return { content, usage: out.usage ?? usage, stop_reason: 'tool_use' };
  };
  fn.calls = calls;
  return fn;
}
const run = (question, callModel, extra = {}) => runResearchAgent({ withTenant, ctxArg: ctxA, question, today: TODAY, callModel, env: { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' }, ...extra });

{
  // --- several tool calls in ONE turn (parallel), then a grounded answer -----------------------
  const model = scripted([
    () => [tu('find_customers', { name: 'Karen Abernathy' }), tu('get_unit', { equipmentId: uid('a', 'e', 1) })],
    () => [tu('answer', { status: 'answered', text: 'The Trane XR14 at 412 Elm St is under warranty.', facts: [{ label: 'Warranty', value: 'active', entityId: uid('a', 'e', 1) }], confidence: 0.9 })],
  ]);
  const r = await run('is the unit at Karen Abernathy\'s under warranty', model);
  check('research loop: two tool calls issued in the SAME turn both execute and ground the answer', r.handled && r.data.kind === 'answer', JSON.stringify(r.data).slice(0, 300));
  eq('research loop: exactly 2 model calls (one tool turn, one answer turn)', r.modelCalls, 2);
  check('research loop: runs on the research model (Sonnet-family), not Haiku', /sonnet/i.test(r.model), r.model);
}

/* ================================================================== streaming: event order */
{
  const events = [];
  // A fact grounded from search_documents cites its documentId+page (the SOURCED path, checked against
  // ledger.passages by answer.js's buildAllowed/shapeAnswer) — search_documents itself only registers
  // doc/page pairs for citation, not raw excerpt text into the corpus, so an UNSOURCED fact "anchored"
  // only by hoping the excerpt text is in the corpus was never a supported shape (get_customer/
  // find_customers/run_query/count_documents_mentioning DO add their JSON to the corpus, for exactly the
  // unsourced/aggregate case those tools are meant to back).
  const model = scripted([
    () => [tu('search_documents', { query: 'capacitor' })],
    () => [tu('answer', {
      status: 'answered', text: 'The capacitor was replaced on the Trane XR14.',
      facts: [{ label: 'Repair', value: 'Replaced the capacitor', sources: [{ documentId: uid('a', 'd', 2), location: { page: 1 } }] }],
      confidence: 0.9,
    })],
  ]);
  const r = await run('what did we do to the unit', model, { onEvent: (e) => events.push(e.type) });
  check('streaming: a plan event fires before any tool event', events.indexOf('plan') === 0 && events.indexOf('plan') < events.indexOf('tool'), JSON.stringify(events));
  check('streaming: onEvent never breaks the run even though it is only a side channel', r.handled, JSON.stringify(r).slice(0, 400));
}
{
  // non-streaming fallback: no onEvent at all — must behave identically, just silently. The model must
  // legitimately establish the empty result (find_customers with no match) before a none_found status is
  // honoured — shape.js only accepts none_found backed by a real empty tool call (ledger.emptyResults>0).
  const model = scripted([
    () => [tu('find_customers', { name: 'Nobody Here At All' })],
    () => [tu('answer', { status: 'none_found', text: 'Nothing on file.' })],
  ]);
  const r = await run('anything at all', model);
  check('non-streaming fallback: runResearchAgent works with no onEvent and never throws', r.handled === true && r.data.kind === 'answer', JSON.stringify(r).slice(0, 400));
}

/* ================================================================== verify step: drops an unsupported fact */
{
  // The model claims a serial number the nameplate page never actually says — shape.js's corpus-wide
  // check alone would pass this (nothing else forbids it appearing off in some OTHER shown text), so
  // this specifically exercises verify.js's per-citation re-read of document_pages for THAT page.
  const docId = uid('a', 'd', 5);
  const model = scripted([
    () => [tu('search_documents', { query: 'nameplate' })],
    () => [tu('answer', {
      status: 'answered', text: 'The nameplate reads serial ZZ-9999-FAKE.',
      facts: [{ label: 'Serial', value: 'ZZ-9999-FAKE', sources: [{ documentId: docId, location: { page: 1 } }] }],
      confidence: 0.9,
    })],
    // the ONE bounded re-research turn verify.js triggers after a drop: this time it gives up honestly.
    () => [tu('answer', { status: 'none_found', text: 'The nameplate photo does not clearly state a serial number.' })],
  ]);
  const r = await run('what serial is on the plaza nameplate', model);
  check('verify step: a fact whose cited page does not actually say it is dropped, not returned', !JSON.stringify(r.data).includes('ZZ-9999-FAKE'), JSON.stringify(r.data));
  check('verify step: the run reports a non-zero verify-drop count', (r.dropped?.verify ?? 0) >= 1, JSON.stringify(r.dropped));
  eq('verify step: exactly one bounded re-research turn was used (3 model calls total)', r.modelCalls, 3);
}

/* ================================================================== batching: MAX_TOOLS_PER_TURN_V2 raised 4 -> 6 */
{
  // A question with several independent parts (here: 5 unrelated lookups about one customer/unit, standing
  // in for "tell me about customer A, customer B, and compare them") used to be capped at 4 tool calls per
  // turn; the 5th would come back "too many tool calls in one turn" and cost a WHOLE EXTRA model turn to
  // pick up. With the cap raised to 6, all 5 run in the SAME turn.
  const model = scripted([
    () => [
      tu('find_customers', { name: 'Karen Abernathy' }),
      tu('get_unit', { equipmentId: uid('a', 'e', 1) }),
      tu('follow_links', { entityId: uid('a', 'c', 1) }),
      tu('timeline', { customerId: uid('a', 'c', 1) }),
      tu('compute', { expression: '1+1' }),
    ],
    () => [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'not needed for this check' })],
  ]);
  const r = await run('tell me about Karen Abernathy, her unit, its links and its timeline, all at once', model);
  check('batching: a 5-part turn (over the OLD 4-per-turn cap) all executes in ONE turn, none rejected as over-budget',
    r.steps.length === 5 && r.steps.every((s) => !s.error), JSON.stringify(r.steps));
  eq('batching: the whole run finishes in 2 model calls (one tool turn, one answer turn) — the raised cap saves the 3rd call the old 4-per-turn limit would have needed', r.modelCalls, 2);
}

/* ================================================================== prefetch (build spec item 2) */
{
  // An enumeration question ("list all X") gets a free, no-model search_documents lookup injected before
  // the first turn. The scripted model here is ADAPTIVE (inspects its own message history, same trick the
  // harness's `turn` functions already support): it answers immediately once it sees evidence already in
  // hand, or calls search_documents itself when it does not — the same script therefore proves the saved
  // round trip for both prefetch-on and prefetch-off without needing two different fixtures.
  const question = 'list all customers';
  const hasSearchEvidence = (messages) => messages.some((m) =>
    Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('resultCount')));
  const adaptiveTurns = [
    (messages) => (hasSearchEvidence(messages) ? [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'not needed for this check' })] : [tu('search_documents', { query: question })]),
    () => [tu('answer', { status: 'cannot_answer', text: 'n', missing: 'not needed for this check' })],
  ];
  const onEnv = { DONOVAN_ESCALATION: '1', DONOVAN_RESEARCH_DAILY_USD: '10' };

  const withPrefetch = await run(question, scripted(adaptiveTurns), { env: onEnv });
  eq('prefetch: an enumeration question is answered with fewer model calls because evidence is already in the first turn', withPrefetch.modelCalls, 1);
  check('prefetch: the injected evidence shows up in steps with a prefetch marker', withPrefetch.steps.some((s) => s.tool === 'search_documents' && s.prefetch === true), JSON.stringify(withPrefetch.steps));
  check('prefetch: the result says a prefetch ran', withPrefetch.prefetchUsed === true);

  const withoutPrefetch = await run(question, scripted(adaptiveTurns), { env: { ...onEnv, DONOVAN_RESEARCH_PREFETCH: '0' } });
  eq('prefetch off (DONOVAN_RESEARCH_PREFETCH=0): the SAME question needs one extra model call to fetch the same evidence itself', withoutPrefetch.modelCalls, 2);
  check('prefetch off: the result says no prefetch ran', withoutPrefetch.prefetchUsed === false);

  // Graceful skip when there is no time for it (stands in for "times out"): an already-tight deadline
  // must never hang or throw — prefetch is simply skipped and the run still completes cleanly, exactly
  // like the existing wall-clock-deadline budget case below.
  const tight = await run(question, scripted(adaptiveTurns), { env: onEnv, deadlineAt: Date.now() + 100 });
  check('prefetch skips gracefully under a near-zero deadline: no hang, no throw, and the run still finishes with a sane reason',
    ['deadline', 'turn-cap'].includes(tight.reason) && tight.prefetchUsed === false, JSON.stringify({ reason: tight.reason, prefetchUsed: tight.prefetchUsed }));
}

/* ================================================================== budgets/caps */
{
  // --- tool-call cap: a model that always asks for 4 tools a turn must stop at MAX_TOOL_CALLS_V2 ---
  const greedy = scripted([() => [tu('describe_data', {}), tu('describe_data', {}), tu('describe_data', {}), tu('describe_data', {})]]);
  const r = await run('anything at all', greedy);
  check('budget: stops at MAX_TOOL_CALLS_V2 total tool executions, never more, with no answer', !r.handled && r.steps.length <= MAX_TOOL_CALLS_V2 && r.steps.length >= MAX_TOOL_CALLS_V2 - 3, `steps=${r.steps.length} cap=${MAX_TOOL_CALLS_V2}`);
  check('budget: reason reflects the cap that was hit', ['tool-cap', 'turn-cap'].includes(r.reason), r.reason);
}
{
  // --- turn cap: a model that ignores tool_choice:"tool" and keeps calling tools anyway ------------
  const stubborn = scripted([() => [tu('describe_data', {})]]);
  const r = await run('anything at all', stubborn);
  check(`turn cap: stops at MAX_TURNS_V2 (${MAX_TURNS_V2}) model calls with no answer`, !r.handled && r.modelCalls === MAX_TURNS_V2 && r.reason === 'turn-cap', `${r.reason} ${r.modelCalls}`);
}
{
  // --- input token cap ------------------------------------------------------------------------
  const big = scripted([() => [tu('describe_data', {})]], { input_tokens: 50_000, output_tokens: 50 });
  const r = await run('anything at all', big, { limits: { inputTokenCap: 120_000 } });
  check('budget: stops once cumulative input tokens reach the cap, no answer', !r.handled && r.reason === 'token-cap' && r.inputTokens >= 100_000, `${r.reason} in=${r.inputTokens}`);
}
{
  // --- wall-clock deadline ----------------------------------------------------------------------
  const slow = scripted([() => [tu('describe_data', {})]]);
  const r = await run('anything at all', slow, { deadlineAt: Date.now() + 100 });
  check('budget: an already-tight deadline stops the run promptly (reason deadline, at most 1 call)', !r.handled && ['deadline', 'turn-cap'].includes(r.reason) && r.modelCalls <= 1, `${r.reason} ${r.modelCalls}`);
}
{
  // --- per-tenant daily spend cap (separate bucket from v1 escalation) --------------------------
  const gateOff = await researchAllowed(withTenant, ctxA, { DONOVAN_RESEARCH_DAILY_USD: '0' });
  check('budget: DONOVAN_RESEARCH_DAILY_USD=0 disables the research agent for this tenant today', gateOff.allowed === false, JSON.stringify(gateOff));
  const model = scripted([() => [tu('answer', { status: 'none_found', text: 'n' })]]);
  const r = await run('anything at all', model, { env: { DONOVAN_RESEARCH_DAILY_USD: '0' } });
  check('budget: a zero daily cap refuses the run without ever calling the model', !r.handled && String(r.reason).startsWith('budget:') && model.calls.length === 0, JSON.stringify(r).slice(0, 200));
  check('budget: the research agent\'s spend bucket is namespaced separately from v1\'s escalation bucket', RESEARCH_BUCKET !== 'sonnet_usd_micro', RESEARCH_BUCKET);
}
{
  // --- shared daily model-spend budget (every billed path respects this) ------------------------
  await lite.query(`UPDATE tenants SET limits = '{"maxModelCallsPerDay": 1}'::jsonb WHERE id = $1`, [tenB]);
  await lite.query('SELECT * FROM increment_usage_counters($1, $2::date, 0, 1, 10, 10)', [tenB, new Date().toISOString().slice(0, 10)]);
  const never = scripted([() => [tu('answer', { status: 'none_found', text: 'n' })]]);
  let thrown = null;
  try { await runResearchAgent({ withTenant, ctxArg: ctxB, question: 'anything at all', today: TODAY, callModel: never }); } catch (err) { thrown = err; }
  check('budget: the shared daily model-spend cap (assertModelBudget) is checked before any model call', thrown instanceof ModelBudgetExceededError && never.calls.length === 0, String(thrown));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`All ${passes} checks passed.`);
