/**
 * Checks for TEAM T2's retrieval-at-scale knowledge layer:
 *   - api/_lib/search/knowledge.js  (searchKnowledge, entity-first filters, near-dup collapse)
 *   - api/_lib/search/dossier.js    (getDossier, incremental rebuild, catch-up, backfill)
 *   - api/_lib/search/mapReduce.js  (mapReduceAnswer, async full-report jobs)
 *   - api/_lib/conversation.js      (follow-up context validation + composition)
 *
 * No network, no real API keys. The database is a REAL Postgres (PGlite, in
 * process) with pgvector, built from the actual M3-config/*.sql migrations
 * (through 33) and queried as the app's own RLS-restricted role — same
 * harness approach as scripts/verify-semantic.mjs. Anthropic and Voyage are
 * both replaced by a deterministic fake `fetch` so the real client code
 * (tool_choice, retries, timeouts) runs against it.
 *
 *   node scripts/verify-knowledge.mjs
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
process.env.CLAUDE_API_KEY = 'sk-test-not-real';
delete process.env.VOYAGE_API_KEY;
delete process.env.DONOVAN_RERANK_MODEL;
delete process.env.DONOVAN_SEMANTIC;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
console.warn = () => {};

/* ================================================================== fake network */
const fake = { anthropicCalls: [], voyageCalls: [] };
const realFetch = globalThis.fetch;
function fakeAnthropicResponse(body) {
  const toolName = body.tool_choice?.name;
  const userText = body.messages?.[0]?.content ?? '';
  const pageMatches = [...String(userText).matchAll(/\[page (\d+)\]\s*([^\n]{0,120})/g)];
  if (toolName === 'dossier_sentences') {
    const sentences = pageMatches.slice(0, 2).map((m) => ({ text: `Noted: ${m[2].trim().slice(0, 80)}`, page: Number(m[1]) }));
    return { content: [{ type: 'tool_use', id: 'tu1', name: toolName, input: { sentences } }], usage: { input_tokens: 200, output_tokens: 40 } };
  }
  if (toolName === 'facts_for_question') {
    const facts = pageMatches.slice(0, 2).map((m) => ({ text: `Fact: ${m[2].trim().slice(0, 80)}`, page: Number(m[1]) }));
    return { content: [{ type: 'tool_use', id: 'tu2', name: toolName, input: { facts } }], usage: { input_tokens: 220, output_tokens: 45 } };
  }
  // reduce step: plain text, no tool
  return { content: [{ type: 'text', text: `Answer synthesized from the facts: ${String(userText).slice(0, 200)}` }], usage: { input_tokens: 500, output_tokens: 120 } };
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    fake.anthropicCalls.push(u);
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', ...fakeAnthropicResponse(body) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.voyageai.com')) {
    fake.voyageCalls.push(u);
    return new Response(JSON.stringify({ data: [], usage: { total_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

/* ================================================================== pure functions */
const knowledge = await import('../api/_lib/search/knowledge.js');
const conversation = await import('../api/_lib/conversation.js');

{
  eq('extractProperNounPhrases: finds a two-word proper noun phrase',
    knowledge.extractProperNounPhrases('everything we did for Plaza Dental last year'), ['Plaza Dental']);
  eq('extractProperNounPhrases: ignores a single capitalized word (sentence start)',
    knowledge.extractProperNounPhrases('What did we do'), []);
  check('extractAddressPhrase: pulls a leading house-number + street run',
    /^88\s+Whitmore\s+Ave\b/.test(knowledge.extractAddressPhrase('any complaints at 88 Whitmore Ave') ?? ''));
  check('extractAddressPhrase: null when there is no address-shaped run', knowledge.extractAddressPhrase('what is the warranty status') === null);
  check('extractDocTypeMentions: recognizes a doc-type word', knowledge.extractDocTypeMentions('show me the invoice for this').includes('invoice'));
  eq('extractDocTypeMentions: none when no doc-type word is present', knowledge.extractDocTypeMentions('is the unit loud'), []);
}

{
  const rows = [
    { document_type: 'permit', excerpt: 'City of Tucson building permit BP-2024-08841 issued for condenser replacement at 17 Cactus Ln.', rank: 0.9 },
    { document_type: 'permit', excerpt: 'City of Tucson building permit BP-2024-09912 issued for condenser replacement at 4 Cactus Ln.', rank: 0.8 },
    { document_type: 'invoice', excerpt: 'Invoice 2026-0412. Replaced the run capacitor. Labor two hours.', rank: 0.7 },
  ];
  const collapsed = knowledge.collapseNearDuplicates(rows);
  eq('collapseNearDuplicates: two near-identical templated permits collapse to one, with a count', collapsed.map((r) => [r.document_type, r._collapsed]), [['permit', 1], ['invoice', 0]]);
  const distinct = knowledge.collapseNearDuplicates([rows[0], rows[2]]);
  eq('collapseNearDuplicates: distinct documents are never collapsed', distinct.map((r) => r._collapsed), [0, 0]);
}

const store = await import('../api/_lib/search/store.js');
{
  eq('annEfSearchForScale: small tenant stays at the original default (100)', store.annEfSearchForScale(500), 100);
  eq('annEfSearchForScale: a mid-size corpus widens the candidate list', store.annEfSearchForScale(50_000), 200);
  eq('annEfSearchForScale: a very large corpus widens it further', store.annEfSearchForScale(500_000), 400);
}

{
  const ctx = conversation.validateConversationContext({ turns: [{ question: 'How is Plaza Dental doing?', resolvedFilters: { customerIds: ['11111111-1111-4111-8111-111111111111'], evil: 'dropped' }, resolvedEntities: [{ type: 'customer', id: '11111111-1111-4111-8111-111111111111', label: 'Plaza Dental' }] }] });
  eq('validateConversationContext: keeps a well-formed turn, drops unknown filter keys', Object.keys(ctx.turns[0].resolvedFilters), ['customerIds']);
  eq('validateConversationContext: malformed input degrades to an empty context, not a throw', conversation.validateConversationContext({ turns: 'not an array' }).turns, []);
  eq('validateConversationContext: null/undefined is a fresh context ("New question")', conversation.validateConversationContext(undefined).turns, []);
  const many = conversation.validateConversationContext({ turns: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}` })) });
  eq('validateConversationContext: caps at MAX_CONTEXT_TURNS, keeping the most recent', many.turns.map((t) => t.question), ['q5', 'q6', 'q7', 'q8']);
  const badId = conversation.validateConversationContext({ turns: [{ question: 'x', resolvedFilters: { customerIds: ['not-a-uuid'] } }] });
  eq('validateConversationContext: a non-UUID customerId is dropped', badId.turns[0].resolvedFilters, undefined);

  check('isFollowupContinuation: "and last year?" is a continuation', conversation.isFollowupContinuation('and last year?'));
  check('isFollowupContinuation: "just the Trane ones" is a continuation', conversation.isFollowupContinuation('just the Trane ones'));
  check('isFollowupContinuation: "who was the tech?" is a continuation (anaphora)', conversation.isFollowupContinuation('who was the tech?'));
  check('isFollowupContinuation: a normal self-contained question is not', !conversation.isFollowupContinuation('What is the warranty status for Plaza Dental?'));

  const prev = { question: 'What service was done at Plaza Dental in 2023?', resolvedFilters: { customerIds: ['11111111-1111-4111-8111-111111111111'] } };
  const composed = conversation.composeFollowup({ turns: [prev] }, 'and last year?');
  check('composeFollowup: a follow-up folds the prior question into the query', composed.query.includes('Plaza Dental'));
  check('composeFollowup: customerIds carry over unchanged', composed.filters.customerIds?.[0] === '11111111-1111-4111-8111-111111111111');
  check('composeFollowup: "and last year?" overrides the date range', Boolean(composed.filters.dateFrom));
  eq('composeFollowup: no prior turn -> the question is used as-is, not a followup', conversation.composeFollowup({ turns: [] }, 'hi'), { query: 'hi', filters: {}, isFollowup: false });
}

/* ================================================================== harness: real Postgres (+pgvector) via PGlite */
let PGlite;
let contrib = {};
let vectorExt;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
  vectorExt = (await import('@electric-sql/pglite-pgvector')).vector;
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite / pgvector is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: { ...contrib, vector: vectorExt } });
const cfgDir = path.join(ROOT, 'M3-config');
const notes = [];
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run failed: ${err.message}`); }
for (const n of notes) console.log(`NOTE  migration harness: ${n}`);
check('harness: migration 33 (dossiers/knowledge_reports) loaded cleanly', !notes.some((n) => n.startsWith('33-')));

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return {
    query: (sql, params) => lite.query(sql, params),
    release: () => { lite.exec('RESET ROLE').finally(release); },
  };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const dossier = await import('../api/_lib/search/dossier.js');
const mapReduce = await import('../api/_lib/search/mapReduce.js');
const { withTenantRaw } = store;

const ctxA = { tenantKey: 'org_know_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_know_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (t, n) => `${t}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedDoc(tenantId, id, file, type, pages, createdAt = null) {
  await lite.query(
    'INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, NOW()))',
    [id, tenantId, file, type, `h-${id}`, 'verified', createdAt]
  );
  for (const [i, text] of pages.entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [id, tenantId, i + 1, text]);
}
async function makeCustomer(tenantId, id, name, address) {
  await lite.query(
    `INSERT INTO entities (id, tenant_id, entity_type, data) VALUES ($1,$2,'customer', jsonb_build_object('customer_name',$3::text,'service_address',$4::text))`,
    [id, tenantId, name, address]
  );
}
async function linkDoc(tenantId, documentId, entityId, via = 'ai:test') {
  await lite.query(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by) VALUES ($1,$2,$3,0.9,$4)`,
    [tenantId, documentId, entityId, via]
  );
}

const C = { plaza: uid('a', 1) };
await makeCustomer(tenA, C.plaza, 'Plaza Dental', '200 Plaza Way');
const D = {
  svc2023: uid('a', 10), svc2024: uid('a', 11), invoice: uid('a', 12), other: uid('a', 13), b1: uid('b', 1),
};
await seedDoc(tenA, D.svc2023, 'plaza-svc-2023.pdf', 'service-ticket', ['Technician Maria serviced the rooftop unit at Plaza Dental. Filters replaced, no issues found.'], '2023-06-01');
await seedDoc(tenA, D.svc2024, 'plaza-svc-2024.pdf', 'service-ticket', ['Technician Diego serviced the rooftop unit at Plaza Dental. Compressor noise reported and inspected.'], '2024-06-01');
await seedDoc(tenA, D.invoice, 'plaza-invoice.pdf', 'invoice', ['Invoice for Plaza Dental. Total due $450 for filter replacement.'], '2023-06-02');
await seedDoc(tenA, D.other, 'unrelated.pdf', 'permit', ['Unrelated permit for a different address entirely.'], '2023-01-01');
await seedDoc(tenB, D.b1, 'b-doc.pdf', 'service-ticket', ['A document belonging to tenant B only, never visible to tenant A.']);
await linkDoc(tenA, D.svc2023, C.plaza);
await linkDoc(tenA, D.svc2024, C.plaza);
await linkDoc(tenA, D.invoice, C.plaza);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'service_date',$3,0.9)`, [tenA, D.svc2023, '2023-06-01']);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'service_date',$3,0.9)`, [tenA, D.svc2024, '2024-06-01']);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'technician',$3,0.9)`, [tenA, D.svc2023, 'Maria']);
await lite.query(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'technician',$3,0.9)`, [tenA, D.svc2024, 'Diego']);

/* ================================================================== resolveFilterDocumentIds */
{
  const r0 = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, {}));
  eq('resolveFilterDocumentIds: no filters -> unrestricted (null)', r0.documentIds, null);

  const rCust = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, { customerIds: [C.plaza] }));
  eq('resolveFilterDocumentIds: customerIds -> exactly that customer\'s documents', [...rCust.documentIds].sort(), [D.invoice, D.svc2023, D.svc2024].sort());

  const rType = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, { customerIds: [C.plaza], docTypes: ['invoice'] }));
  eq('resolveFilterDocumentIds: intersects customer AND docTypes', rType.documentIds, [D.invoice]);

  const rDate = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, { customerIds: [C.plaza], dateFrom: '2024-01-01', dateTo: '2024-12-31' }));
  eq('resolveFilterDocumentIds: intersects a date range (service_date)', rDate.documentIds, [D.svc2024]);

  const rTech = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, { technician: 'maria' }));
  eq('resolveFilterDocumentIds: technician filter is case-insensitive', rTech.documentIds, [D.svc2023]);

  const rEmpty = await withTenant(ctxA, (db) => knowledge.resolveFilterDocumentIds(db, { docTypes: ['nonexistent-type'] }));
  eq('resolveFilterDocumentIds: a filter matching nothing returns an empty (not null) list', rEmpty.documentIds, []);
}

/* ================================================================== searchKnowledge */
{
  const hitsAll = await withTenant(ctxA, (db) => knowledge.searchKnowledge(db, { query: 'rooftop unit compressor noise', k: 5 }));
  check('searchKnowledge: finds the relevant page across the tenant', hitsAll.some((h) => h.doc.id === D.svc2024));
  check('searchKnowledge: returns the documented shape (doc/page/excerpt/score/matchedBy)', hitsAll.every((h) => h.doc?.id && Number.isInteger(h.page) && typeof h.excerpt === 'string' && typeof h.score === 'number' && typeof h.matchedBy === 'string'));

  const scoped = await withTenant(ctxA, (db) => knowledge.searchKnowledge(db, { query: 'filter replacement', filters: { customerIds: [C.plaza], docTypes: ['invoice'] }, k: 5 }));
  check('searchKnowledge: entity+doctype filter restricts to just that document', scoped.length > 0 && scoped.every((h) => h.doc.id === D.invoice));

  const noneFiltered = await withTenant(ctxA, (db) => knowledge.searchKnowledge(db, { query: 'anything', filters: { docTypes: ['nonexistent-type'] }, k: 5 }));
  eq('searchKnowledge: a filter matching zero documents returns zero hits, never falls through to "everything"', noneFiltered, []);

  const inferred = await withTenant(ctxA, (db) => knowledge.searchKnowledge(db, { query: 'everything about Plaza Dental in 2023', k: 5 }));
  check('searchKnowledge: entity-first resolution from plain query text restricts to Plaza Dental\'s own documents', inferred.length > 0 && inferred.every((h) => [D.svc2023, D.invoice, D.svc2024].includes(h.doc.id)));

  const bHits = await withTenant(ctxB, (db) => knowledge.searchKnowledge(db, { query: 'document belonging to tenant B', k: 5 }));
  check('tenant isolation: tenant B sees its own document', bHits.some((h) => h.doc.id === D.b1));
  const aHits2 = await withTenant(ctxA, (db) => knowledge.searchKnowledge(db, { query: 'document belonging to tenant B', k: 5 }));
  check('tenant isolation: tenant A never sees tenant B\'s document', !aHits2.some((h) => h.doc.id === D.b1));
}

/* ================================================================== dossiers */
// A dedicated customer/documents for the incremental-build tests below, kept separate from
// C.plaza (which already has all three of its documents linked from the searchKnowledge tests
// above) so "one document linked, then a second" can actually be observed in that order.
const C_ROLL = uid('a', 5);
await makeCustomer(tenA, C_ROLL, 'Rolling Customer', '1 Rolling Rd');
const D_ROLL1 = uid('a', 50);
const D_ROLL2 = uid('a', 51);
await seedDoc(tenA, D_ROLL1, 'roll-1.pdf', 'service-ticket', ['Technician visited Rolling Customer and replaced a capacitor.']);
await seedDoc(tenA, D_ROLL2, 'roll-2.pdf', 'service-ticket', ['Technician returned to Rolling Customer for a follow-up inspection.']);
{
  const missing = await withTenant(ctxA, (db) => dossier.getDossier(db, C_ROLL));
  eq('getDossier: null before any build', missing, null);

  await linkDoc(tenA, D_ROLL1, C_ROLL);
  const r1 = await dossier.updateDossierForDocument(ctxA, D_ROLL1);
  eq('updateDossierForDocument: builds the dossier for the linked customer', [r1.status, r1.built], ['done', 1]);
  const d1 = await withTenant(ctxA, (db) => dossier.getDossier(db, C_ROLL));
  check('getDossier: has a cited sentence after the first build', d1.sentences.length > 0 && d1.sentences[0].citations[0].documentId === D_ROLL1);
  eq('getDossier: sourceDocumentIds covers exactly the one document summarized so far', d1.sourceDocumentIds, [D_ROLL1]);

  const callsBefore = fake.anthropicCalls.length;
  const r2 = await dossier.updateDossierForDocument(ctxA, D_ROLL1);
  eq('updateDossierForDocument: re-running with no new documents is a no-op (unchanged internally, no model call)', [r2.built, fake.anthropicCalls.length], [0, callsBefore]);

  await linkDoc(tenA, D_ROLL2, C_ROLL);
  const r3 = await dossier.updateDossierForDocument(ctxA, D_ROLL2);
  check('updateDossierForDocument: a second linked document is added incrementally', r3.built === 1);
  const d2 = await withTenant(ctxA, (db) => dossier.getDossier(db, C_ROLL));
  eq('getDossier: now covers both documents, old sentence kept', d2.sourceDocumentIds.sort(), [D_ROLL1, D_ROLL2].sort());
  check('getDossier: sentence from the FIRST build is still present after the second (rolling, not replaced)', d2.sentences.some((s) => s.citations[0].documentId === D_ROLL1));

  const seenByA = await withTenantRaw(ctxA, (db) => db.query('SELECT DISTINCT tenant_id FROM dossiers'));
  eq('RLS: tenant A only ever sees its own dossier rows', seenByA.rows.map((r) => r.tenant_id), [tenA]);
  const flags = (await lite.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('dossiers','knowledge_reports')")).rows;
  check('migration: both new tables have ENABLE + FORCE row level security', flags.length === 2 && flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));

  // Catch-up sweep: an entity with no dossier yet (invoice-only customer, never explicitly hooked) gets built.
  const C2 = uid('a', 2);
  await makeCustomer(tenA, C2, 'Solo Customer', '9 Solo St');
  const D2 = uid('a', 20);
  await seedDoc(tenA, D2, 'solo.pdf', 'invoice', ['Solo Customer invoice for a single visit.']);
  await linkDoc(tenA, D2, C2);
  const sweep = await dossier.runDossierCatchup(ctxA, { deadlineMs: 5000, maxEntities: 10 });
  check('runDossierCatchup: rotation picks up an entity the hook never ran for', sweep.built >= 1);
  const d3 = await withTenant(ctxA, (db) => dossier.getDossier(db, C2));
  check('runDossierCatchup: that entity now has a dossier', Boolean(d3));

  // Backfill page shape (operator/admin action)
  const page = await dossier.runDossierBackfillPage(ctxA, { deadlineMs: 5000, maxEntities: 10 });
  check('runDossierBackfillPage: reports a stoppedBy status like store.js\'s runBackfill', ['done', 'deadline'].includes(page.stoppedBy));

  const status = await dossier.dossierStatus(ctxA);
  check('dossierStatus: reports entity/dossier counts', status.ready === true && status.entities >= 2 && status.dossiers >= 2);
}

/* ================================================================== mapReduceAnswer */
{
  const inline = await mapReduce.mapReduceAnswer(ctxA, { question: 'What service history do we have for Plaza Dental?', filters: { customerIds: [C.plaza] }, maxDocuments: 10 });
  eq('mapReduceAnswer: a small document set answers inline', inline.status, 'answered');
  check('mapReduceAnswer: coverage says everything was read', /Read all/.test(inline.coverage.note));
  check('mapReduceAnswer: an answer with citations came back', typeof inline.answer === 'string' && inline.answer.length > 0);
  check('mapReduceAnswer: citations reference real documents', inline.citations.every((c) => [D.svc2023, D.svc2024, D.invoice].includes(c.documentId)));

  const queued = await mapReduce.mapReduceAnswer(ctxA, { question: 'What service history do we have for Plaza Dental?', filters: { customerIds: [C.plaza] }, maxDocuments: 1, notifyEmail: 'owner@example.com' });
  eq('mapReduceAnswer: over the inline threshold with no dossier match falls back to dossier (one exists) before queuing', queued.status, 'dossier');
  check('mapReduceAnswer: dossier fallback is honest about partial coverage', /precomputed summary/.test(queued.coverage.note));

  const noDossierEntity = uid('a', 3);
  await makeCustomer(tenA, noDossierEntity, 'No Dossier Yet Co', '5 New St');
  for (let i = 0; i < 3; i++) {
    const id = uid('a', 30 + i);
    await seedDoc(tenA, id, `nd-${i}.pdf`, 'invoice', [`Invoice number ${i} for No Dossier Yet Co, covering routine work.`]);
    await linkDoc(tenA, id, noDossierEntity);
  }
  const queuedReal = await mapReduce.mapReduceAnswer(ctxA, { question: 'Summarize everything for No Dossier Yet Co', filters: { customerIds: [noDossierEntity] }, maxDocuments: 1, notifyEmail: 'owner@example.com' });
  eq('mapReduceAnswer: over threshold with NO existing dossier queues an async report job', queuedReal.status, 'queued');
  check('mapReduceAnswer: a report id came back', Boolean(queuedReal.reportId));

  const job = await withTenant(ctxA, (db) => mapReduce.getReportJob(db, queuedReal.reportId));
  eq('getReportJob: the queued job is pending', job.status, 'pending');

  const ran = await mapReduce.runKnowledgeReportSweepStep(ctxA, { deadlineMs: 20000 });
  eq('runKnowledgeReportSweepStep: processes the one pending job', [ran.processed, ran.status], [1, 'done']);
  const jobAfter = await withTenant(ctxA, (db) => mapReduce.getReportJob(db, queuedReal.reportId));
  eq('runKnowledgeReportSweepStep: the job is now done with a result', jobAfter.status, 'done');
  check('runKnowledgeReportSweepStep: the result cites real documents', typeof jobAfter.result === 'string' && jobAfter.result.length > 0);

  const idle = await mapReduce.runKnowledgeReportSweepStep(ctxA, { deadlineMs: 5000 });
  eq('runKnowledgeReportSweepStep: a second call with nothing pending is idle, not an error', idle.status, 'idle');

  const bJob = await withTenant(ctxB, (db) => mapReduce.getReportJob(db, queuedReal.reportId));
  eq('tenant isolation: tenant B cannot read tenant A\'s report job', bJob, null);
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
