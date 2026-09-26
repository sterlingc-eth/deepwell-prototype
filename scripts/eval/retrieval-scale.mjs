/**
 * TEAM T2 — retrieval-at-scale eval: does searchKnowledge (api/_lib/search/
 * knowledge.js) actually earn its complexity on a corpus the size a real
 * enterprise tenant would have?
 *
 * Generates a synthetic single-tenant corpus of --pages pages (default
 * 50,000; override for a quick smoke run), split across many customers:
 *   - a handful of TEMPLATED FILLER documents per customer (the same annual-
 *     maintenance-checklist boilerplate, customer name/visit number swapped
 *     in) — the bulk of the page count, and exactly the kind of repeated
 *     template that near-duplicate collapse exists for.
 *   - exactly ONE "incident" document per LABELED customer: a unique,
 *     paraphrase-worthy service note (a noise/leak/heat complaint) that
 *     becomes the answer key for one labeled query.
 *
 * For each labeled query it runs BOTH:
 *   BEFORE — db.searchPassages(query, k, {documentIds:null}) directly: hybrid
 *            FTS+pgvector+RRF exactly as it existed before this build, with
 *            no entity-first scoping, no rerank layer, no dedup collapse.
 *   AFTER  — searchKnowledge(db, {query, k, rerank:true}): the same
 *            underlying hybrid search, but scoped first to the customer the
 *            query names (resolveQueryEntities), reranked, and collapsed.
 * and reports recall@10 / MRR for each, so the delta is a number, not an
 * argument — and specifically a number that should widen as the corpus
 * grows, because BEFORE has to find the right page in the whole tenant while
 * AFTER only has to find it inside one customer's handful of documents.
 *
 * Embeddings: a deterministic fake Voyage (bag-of-words hash with a small
 * synonym map, same technique as scripts/verify-semantic.mjs) UNLESS
 * VOYAGE_API_KEY is already set in the environment, in which case real
 * Voyage is used for both embedding and rerank (slower, costs pennies on the
 * free tier, gives a real-embedding number alongside the deterministic one).
 * No model (Haiku/Sonnet) is called anywhere in this script.
 *
 * Usage:
 *   node scripts/eval/retrieval-scale.mjs                  # ~50k pages
 *   node scripts/eval/retrieval-scale.mjs --pages=2000      # quick smoke run
 *   node scripts/eval/retrieval-scale.mjs --customers=300 --queries=200
 *   VOYAGE_API_KEY=voy-... node scripts/eval/retrieval-scale.mjs --pages=2000
 *
 * Runs entirely against PGlite (in-process Postgres + pgvector) — no
 * NEON_CONNECTION_STRING, no live database, nothing left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const TARGET_PAGES = arg('pages', 50_000);
const N_LABELED = arg('queries', 200);
const N_CUSTOMERS = Math.max(arg('customers', N_LABELED + 60), N_LABELED);
const K = arg('k', 10);

const usingRealVoyage = Boolean(process.env.VOYAGE_API_KEY);
if (!usingRealVoyage) process.env.VOYAGE_API_KEY = 'eval-fake-key-not-real';
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.CLAUDE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_RERANK_MODEL; // keep hybrid.js's own internal rerank OFF so searchKnowledge's rerank pass is the one under test

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
console.warn = () => {};

/* ============================================================== deterministic fake Voyage */
const DIM = 1024;
const SYN = {
  loud: 'NOISE', noisy: 'NOISE', noise: 'NOISE', rattles: 'NOISE', rattling: 'NOISE', buzzing: 'NOISE', banging: 'NOISE', humming: 'NOISE', clanking: 'NOISE', squealing: 'NOISE',
  leaking: 'WATER', leak: 'WATER', dripping: 'WATER', puddle: 'WATER', water: 'WATER', moisture: 'WATER', condensation: 'WATER',
  warm: 'HEAT', hot: 'HEAT', overheating: 'HEAT', heat: 'HEAT', warming: 'HEAT',
  short: 'ELEC', tripping: 'ELEC', breaker: 'ELEC', sparking: 'ELEC', electrical: 'ELEC',
  weak: 'FLOW', airflow: 'FLOW', restricted: 'FLOW', clogged: 'FLOW',
};
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'any', 'about', 'very', 'for', 'with', 'it', 'that', 'this', 'what', 'does', 'say', 'did', 'we', 'have', 'has', 'ever', 'complaints', 'complaint']);
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => SYN[t] ?? t);
function fakeVec(text) {
  const v = new Array(DIM).fill(0);
  for (const t of tokensOf(text)) v[fnv(t) % DIM] += 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

if (!usingRealVoyage) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith('https://api.voyageai.com/v1/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const respond = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/embeddings')) {
      return respond(200, {
        data: body.input.map((t, index) => ({ index, embedding: fakeVec(t) })),
        usage: { total_tokens: body.input.reduce((a, t) => a + tokensOf(t).length + 1, 0) },
      });
    }
    if (u.endsWith('/rerank')) {
      const qv = fakeVec(body.query);
      const scored = body.documents.map((d, index) => ({ index, relevance_score: cosine(qv, fakeVec(d)) }));
      return respond(200, { data: scored, usage: { total_tokens: 100 } });
    }
    return respond(404, {});
  };
}

/* ============================================================== harness: real Postgres (PGlite + pgvector) */
const { PGlite } = await import('@electric-sql/pglite');
const contrib = {};
for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
  contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
}
const vectorExt = (await import('@electric-sql/pglite-pgvector')).vector;
const lite = new PGlite({ extensions: { ...contrib, vector: vectorExt } });

const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* some are Neon-only; harmless here */ }
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

const { withTenant, getTenantContext } = await import('../../api/_lib/recordsStore.js');
const { runBackfill, embedDocumentPages } = await import('../../api/_lib/search/store.js');
const { embedConfig } = await import('../../api/_lib/search/embed.js');
const { searchKnowledge } = await import('../../api/_lib/search/knowledge.js');

const ctx = { tenantKey: 'org_eval_scale', tenantName: 'Retrieval Scale Eval' };
const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
console.log(`embedConfig: enabled=${embedConfig().enabled} model=${embedConfig().model} (${usingRealVoyage ? 'REAL Voyage' : 'deterministic fake'})`);

/* ============================================================== corpus generation */
const NOUNS = ['Dental', 'Clinic', 'Plaza', 'Residence', 'Apartments', 'Office', 'Warehouse', 'School', 'Bakery', 'Diner', 'Garage', 'Studio'];
const TECHS = ['Maria', 'Diego', 'Carlos', 'Angela', 'Wei', 'Priya', 'Samir', 'Jordan', 'Elena', 'Marcus'];
const EQUIP = ['rooftop unit', 'condenser', 'furnace', 'heat pump', 'mini-split', 'air handler'];
const ISSUES = [
  { cat: 'noise', page: 'The {equip} at {name} was rattling and buzzing loudly during the visit; a worn bearing was suspected.', ask: 'Did {name} ever have any noise complaints about the {equip}?' },
  { cat: 'water', page: 'A puddle was found near the {equip} at {name}; condensate line was dripping and needed clearing.', ask: 'Was there ever a leak or water issue at {name}?' },
  { cat: 'heat', page: 'The {equip} at {name} was overheating and running hot to the touch, well above normal operating range.', ask: 'Did the equipment at {name} ever overheat?' },
  { cat: 'elec', page: 'The breaker feeding the {equip} at {name} kept tripping; a possible short was noted for follow-up.', ask: 'Was there ever an electrical issue with the {equip} at {name}?' },
  { cat: 'flow', page: 'Airflow from the {equip} at {name} was weak; the filter was found clogged and restricted.', ask: 'Was airflow ever weak or restricted at {name}?' },
];

console.log(`Generating ${N_CUSTOMERS} customers, targeting ~${TARGET_PAGES} pages (${N_LABELED} labeled)...`);
const t0 = Date.now();

// Monotonic-counter UUIDs (the leading hex digit is just a visual category
// marker — c=customer, d=filler doc, e=incident doc — the rest is a
// zero-padded counter; dashes go at the standard 8-4-4-4-12 positions).
let uuidCounter = 0;
const mkUuid = (tag) => {
  const hex = tag + (uuidCounter++).toString(16).padStart(31, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const customers = [];
for (let i = 0; i < N_CUSTOMERS; i++) {
  const noun = NOUNS[i % NOUNS.length];
  customers.push({ idx: i, id: mkUuid('c'), name: `Bellview${i} ${noun}` });
}

// Insert customer entities in one batched statement.
await lite.query(
  `INSERT INTO entities (id, tenant_id, entity_type, data)
     SELECT id::uuid, $1::uuid, 'customer', jsonb_build_object('customer_name', name)
       FROM unnest($2::uuid[], $3::text[]) AS t(id, name)`,
  [tenantId, customers.map((c) => c.id), customers.map((c) => c.name)]
);

const fillerDocsPerCustomer = 8;
const fillerPagesPerDoc = Math.max(4, Math.round((TARGET_PAGES - N_LABELED) / N_CUSTOMERS / fillerDocsPerCustomer));

const labels = []; // { query, documentId, page }
let docCount = 0;
let pageCount = 0;
const BATCH = 40; // customers per DB round-trip batch

for (let start = 0; start < N_CUSTOMERS; start += BATCH) {
  const batchCustomers = customers.slice(start, start + BATCH);
  const docRows = { ids: [], filenames: [], types: [] };
  const pageRows = { docIds: [], nos: [], texts: [] };
  const linkRows = { docIds: [], entityIds: [] };
  const extractionRows = { docIds: [], keys: [], values: [] };

  for (const cust of batchCustomers) {
    // filler documents (templated boilerplate — the bulk of the corpus)
    for (let d = 0; d < fillerDocsPerCustomer; d++) {
      const docId = mkUuid('d');
      docRows.ids.push(docId); docRows.filenames.push(`${cust.name}-maintenance-${d}.pdf`); docRows.types.push('maintenance-checklist');
      linkRows.docIds.push(docId); linkRows.entityIds.push(cust.id);
      for (let p = 0; p < fillerPagesPerDoc; p++) {
        pageRows.docIds.push(docId); pageRows.nos.push(p + 1);
        pageRows.texts.push(`Annual Maintenance Checklist for ${cust.name}. Visit #${d}-${p}. Filters inspected and replaced. Belts checked. Refrigerant levels nominal. No issues found. Technician signature on file.`);
      }
      docCount++; pageCount += fillerPagesPerDoc;
    }
    // one incident document for the first N_LABELED customers
    if (cust.idx < N_LABELED) {
      const issue = ISSUES[cust.idx % ISSUES.length];
      const tech = TECHS[cust.idx % TECHS.length];
      const equip = EQUIP[cust.idx % EQUIP.length];
      const pageText = `Technician ${tech} inspected the ${equip} at ${cust.name}. ` + issue.page.replace('{equip}', equip).replace('{name}', cust.name);
      const docId = mkUuid('e');
      docRows.ids.push(docId); docRows.filenames.push(`${cust.name}-incident.pdf`); docRows.types.push('service-ticket');
      linkRows.docIds.push(docId); linkRows.entityIds.push(cust.id);
      pageRows.docIds.push(docId); pageRows.nos.push(1); pageRows.texts.push(pageText);
      extractionRows.docIds.push(docId); extractionRows.keys.push('technician'); extractionRows.values.push(tech);
      docCount++; pageCount += 1;
      labels.push({
        query: issue.ask.replace('{equip}', equip).replace('{name}', cust.name),
        documentId: docId,
        page: 1,
      });
    }
  }

  await lite.query(
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage)
       SELECT id::uuid, $1::uuid, fn, dt, 'h-' || id, 'verified'
         FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(id, fn, dt)`,
    [tenantId, docRows.ids, docRows.filenames, docRows.types]
  );
  await lite.query(
    `INSERT INTO document_pages (document_id, tenant_id, page_no, text)
       SELECT doc_id::uuid, $1::uuid, no, txt
         FROM unnest($2::uuid[], $3::int[], $4::text[]) AS t(doc_id, no, txt)`,
    [tenantId, pageRows.docIds, pageRows.nos, pageRows.texts]
  );
  await lite.query(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by)
       SELECT $1::uuid, doc_id::uuid, ent_id::uuid, 0.9, 'eval:seed'
         FROM unnest($2::uuid[], $3::uuid[]) AS t(doc_id, ent_id)`,
    [tenantId, linkRows.docIds, linkRows.entityIds]
  );
  if (extractionRows.docIds.length) {
    await lite.query(
      `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
         SELECT $1::uuid, doc_id::uuid, k, v, 0.9
           FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(doc_id, k, v)`,
      [tenantId, extractionRows.docIds, extractionRows.keys, extractionRows.values]
    );
  }
  if ((start / BATCH) % 5 === 0) console.log(`  seeded ${Math.min(start + BATCH, N_CUSTOMERS)}/${N_CUSTOMERS} customers, ${pageCount} pages so far...`);
}
console.log(`Corpus: ${docCount} documents, ${pageCount} pages, ${labels.length} labeled queries. (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

/* ============================================================== embed the corpus */
const t1 = Date.now();
console.log('Embedding pages (deterministic fake Voyage, batched via runBackfill)...');
let embedded = 0;
for (;;) {
  const r = await runBackfill(ctx, { deadlineMs: 20_000, pagesPerBatch: 400 });
  embedded += r.pagesDone;
  if (r.stoppedBy === 'done' || r.pagesDone === 0) break;
  console.log(`  embedded ${embedded} pages so far (stoppedBy=${r.stoppedBy})...`);
}
console.log(`Embedding done: ${embedded} pages, ${((Date.now() - t1) / 1000).toFixed(1)}s.`);

/* ============================================================== before/after retrieval */
function recallAndRank(hits, want) {
  const idx = hits.findIndex((h) => h.documentId === want.documentId && h.page === want.page);
  return { hit: idx !== -1 && idx < K, rank: idx === -1 ? null : idx + 1 };
}

const t2 = Date.now();
let beforeHits = 0, beforeRR = 0, afterHits = 0, afterRR = 0;
const misses = [];
for (const label of labels) {
  const before = await withTenant(ctx, (db) => db.searchPassages(label.query, K, { documentIds: null }));
  const beforeMapped = before.map((r) => ({ documentId: r.document_id, page: r.page_no }));
  const b = recallAndRank(beforeMapped, label);
  if (b.hit) { beforeHits++; beforeRR += 1 / b.rank; }

  const after = await withTenant(ctx, (db) => searchKnowledge(db, { query: label.query, k: K, rerank: true }));
  const afterMapped = after.map((r) => ({ documentId: r.doc.id, page: r.page }));
  const a = recallAndRank(afterMapped, label);
  if (a.hit) { afterHits++; afterRR += 1 / a.rank; }
  else misses.push({ query: label.query, beforeRank: b.rank, afterRank: a.rank });
}
const n = labels.length;
const report = {
  corpus: { documents: docCount, pages: pageCount, labeledQueries: n, embeddingMode: usingRealVoyage ? 'real-voyage' : 'deterministic-fake' },
  before: { recallAtK: +(beforeHits / n).toFixed(3), mrr: +(beforeRR / n).toFixed(3) },
  after: { recallAtK: +(afterHits / n).toFixed(3), mrr: +(afterRR / n).toFixed(3) },
  k: K,
  timingSec: { seed: +((t1 - t0) / 1000).toFixed(1), embed: +((t2 - t1) / 1000).toFixed(1), search: +((Date.now() - t2) / 1000).toFixed(1) },
  stillMissedAfter: misses.length,
};
console.log(JSON.stringify(report, null, 2));

/* ============================================================== r10c: keyword-heavy + contextual-header eval
 *
 * The BEFORE/AFTER above measures entity-first scoping + rerank + dedup — a different mechanism,
 * already resolved (searchKnowledge auto-scopes to the ONE customer a query names). This section
 * measures something the mechanism above would quietly launder away: whether a page whose OWN raw
 * text carries none of a document's identifying facts (page 2 of a two-page visit, where the
 * customer/address/unit are only ever printed on the cover page) is findable at all — and whether
 * exact identifiers (serials, invoice numbers) still surface regardless. It runs db.searchPassages
 * directly (NOT searchKnowledge), so entity-first auto-scoping never narrows the search space and
 * masks what is being measured here.
 *
 * Deliberately its OWN customer names (never customers[], whose "Bellview{i} {noun}" scheme bakes
 * a digit into a single token — that token alone gets treated as an IDENTIFIER by the keyword pass
 * and pins that customer's unrelated pre-existing filler documents to the top by itself, which would
 * measure the identifier pass, not the header; ordinary human names carry no such digit).
 *
 * BURIED_N documents are seeded, EACH ONE PAGE, and every one of them uses the exact SAME
 * boilerplate repair sentence — deliberately adversarial: with no chunk-context header, the page's
 * own raw text names no customer and no address at all (only a serial number, which the identifier
 * pass already finds on its own), so a query naming the customer has NOTHING on the page itself to
 * match against — every buried document's page is an exact tie with every other one. This is the
 * real gap the header exists for: a page whose OWN text carries none of the identifying facts the
 * pipeline already extracted about it. `noContext` embeds with DONOVAN_CHUNK_CONTEXT=0 (this
 * build's chunks look exactly like every chunk embedded before this feature existed); `withContext`
 * re-embeds the SAME page with it back on (the default) — the document's own header (built from its
 * `extractions` rows, never printed on the page) is what tells otherwise-identical pages apart.
 */
console.log('\nSeeding keyword-heavy + buried-context eval set...');
const BURIED_N = Math.min(60, N_LABELED);
const buriedLabels = []; // { query, documentId, page } — customer name + a boilerplate issue; the page names no customer at all
const identLabels = [];  // { query, documentId, page } — an exact serial number, printed on the page itself (identifier pass, unaffected by headers)
const BOILERPLATE_NOTES = 'Replaced the failed run capacitor and cleared the condensate drain line during the scheduled visit; airflow was restored to normal operation and the system was left in working order.';
const BURIED_FIRST = ['Carol', 'Karen', 'Bill', 'Diane', 'Marcus', 'Priya', 'Samir', 'Elena', 'Jordan', 'Angela'];
const BURIED_LAST = ['Rios', 'Abernathy', 'Whitmore', 'Castillo', 'Webb', 'Nakamura', 'Delgado', 'Fitzgerald', 'Okafor', 'Larsen'];
for (let i = 0; i < BURIED_N; i++) {
  const name = `${BURIED_FIRST[i % BURIED_FIRST.length]} ${BURIED_LAST[Math.floor(i / BURIED_FIRST.length) % BURIED_LAST.length]}`;
  const serial = `SN-${100000 + i}`;
  const docId = mkUuid('f');
  await lite.query(
    `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,'service-ticket',$4,'verified')`,
    [docId, tenantId, `${name}-buried.pdf`, `h-buried-${docId}`]
  );
  await lite.query(
    `INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)`,
    [docId, tenantId, `Serial ${serial}: ${BOILERPLATE_NOTES}`]
  );
  await lite.query(
    `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
       SELECT $1::uuid, $2::uuid, k, v, 0.9 FROM unnest($3::text[], $4::text[]) AS t(k, v)`,
    [tenantId, docId, ['customer_name', 'manufacturer', 'model', 'serial_number'], [name, 'Trane', 'XR16', serial]]
  );
  buriedLabels.push({ query: `Was there ever a capacitor or airflow issue reported for ${name}?`, documentId: docId, page: 1 });
  identLabels.push({ query: `What was serviced under serial ${serial}?`, documentId: docId, page: 1 });
}
const buriedDocIds = buriedLabels.map((l) => l.documentId);
console.log(`Seeded ${BURIED_N} buried-context documents (${buriedLabels.length} buried queries, ${identLabels.length} identifier queries).`);

const K5 = 5;
function recallAndRankK(hits, want, k) {
  const idx = hits.findIndex((h) => h.documentId === want.documentId && h.page === want.page);
  return { hit: idx !== -1 && idx < k, rank: idx === -1 ? null : idx + 1 };
}
async function measure(labelSet, k) {
  let hits = 0, rr = 0;
  for (const label of labelSet) {
    const rows = await withTenant(ctx, (db) => db.searchPassages(label.query, k, { documentIds: null }));
    const mapped = rows.map((r) => ({ documentId: r.document_id, page: r.page_no }));
    const r = recallAndRankK(mapped, label, k);
    if (r.hit) { hits++; rr += 1 / r.rank; }
  }
  return { recallAtK: +(hits / labelSet.length).toFixed(3), mrr: +(rr / labelSet.length).toFixed(3) };
}

console.log('Embedding the buried-context set WITHOUT chunk-context headers (DONOVAN_CHUNK_CONTEXT=0)...');
process.env.DONOVAN_CHUNK_CONTEXT = '0';
for (const docId of buriedDocIds) await embedDocumentPages(ctx, docId, { cfg: embedConfig() });
const noContext = { buried: await measure(buriedLabels, K5), identifier: await measure(identLabels, K5) };

console.log('Re-embedding the SAME pages WITH chunk-context headers (the default)...');
delete process.env.DONOVAN_CHUNK_CONTEXT;
for (const docId of buriedDocIds) await embedDocumentPages(ctx, docId, { cfg: embedConfig() });
const withContext = { buried: await measure(buriedLabels, K5), identifier: await measure(identLabels, K5) };

const contextReport = { corpus: { buriedDocuments: BURIED_N, k: K5 }, noContext, withContext };
console.log(JSON.stringify(contextReport, null, 2));

/* ============================================================== handoff doc */
const handoffPath = path.join(ROOT, 'handoffs', 'RETRIEVAL_AT_SCALE_2026-09-25.md');
const md = `# Retrieval at scale — eval results (TEAM T2, 2026-09-25)

Synthetic single-tenant corpus generated by \`scripts/eval/retrieval-scale.mjs\`,
against PGlite (real Postgres + pgvector, no live database, nothing left
behind). Embeddings: **${usingRealVoyage ? 'real Voyage (voyage-4-lite)' : 'deterministic fake (bag-of-words hash + small synonym map)'}**.
No model (Haiku/Sonnet) is called anywhere in this eval.

## Corpus

- ${docCount.toLocaleString()} documents, **${pageCount.toLocaleString()} pages**
- ${N_CUSTOMERS} customers; each has ${fillerDocsPerCustomer} templated "annual maintenance
  checklist" filler documents (the bulk of the page count, and exactly the
  kind of repeated boilerplate near-duplicate collapse exists for)
- ${N_LABELED} of those customers additionally have one unique incident page
  (a noise/leak/heat/electrical/airflow complaint) — the answer key for one
  labeled query each, phrased as a paraphrase of the page text (a query
  asking about "noise" against a page that says "rattling and buzzing")

## Method

For every labeled query, two searches ran over the SAME corpus:

- **BEFORE** — \`db.searchPassages(query, ${K}, {documentIds:null})\` directly:
  hybrid FTS+pgvector+RRF exactly as it existed before this build, with no
  entity-first scoping, no rerank layer, no near-dup collapse. It has to find
  the one right page among the whole tenant's ${pageCount.toLocaleString()} pages.
- **AFTER** — \`searchKnowledge(db, {query, k:${K}, rerank:true})\`: the same
  underlying hybrid search, but first scoped to the one customer the query
  names (via \`resolveQueryEntities\`, the same deterministic resolver
  \`docLookup.js\`/\`contactLookup.js\` already use — never guesses), then
  reranked, then near-dup collapsed. It only has to find the right page among
  that one customer's ${fillerDocsPerCustomer + 1} documents.

## Results (recall@${K} / MRR, ${n} labeled queries)

| | recall@${K} | MRR |
|---|---|---|
| BEFORE (plain hybrid search, tenant-wide) | ${report.before.recallAtK} | ${report.before.mrr} |
| AFTER (searchKnowledge: entity-first + rerank + dedup) | ${report.after.recallAtK} | ${report.after.mrr} |

${misses.length} quer${misses.length === 1 ? 'y' : 'ies'} still missed after AFTER's improvements
(printed above if any — usually a paraphrase the synonym map doesn't cover).

## Why this is the right comparison

The whole point of entity-first filtering is that it should matter MORE as a
tenant's document count grows — a plain hybrid search has to rank the right
page against every other page in the tenant, while a search that first
resolves "Bellview42 Clinic" to one customer only has to rank it against that
customer's own ${fillerDocsPerCustomer + 1} documents. This corpus deliberately makes that gap
large (${N_CUSTOMERS} customers, ${(fillerDocsPerCustomer * fillerPagesPerDoc + 1)} pages each) so the BEFORE/AFTER delta reflects
that mechanism specifically, not just "reranking helps a little."

## Timing

Seed: ${report.timingSec.seed}s · Embed: ${report.timingSec.embed}s · Search (${n} labeled queries × 2 passes): ${report.timingSec.search}s.

## Keyword-heavy + contextual chunk headers (r10c)

A separate, adversarial eval set, measured with \`db.searchPassages\` directly
(NOT \`searchKnowledge\`) so entity-first auto-scoping never narrows the search
space and masks what this specifically measures. ${BURIED_N} ONE-PAGE
documents were seeded, every one of them the exact SAME boilerplate repair
sentence plus a unique serial number — no customer name anywhere in the page
text at all (the customer is known only via that document's own
\`extractions\` row, exactly the real-world case a technician's notes page
never restates the customer's name). Each is the answer key for two labeled
queries:

- **buried** — the customer's name + a generic issue phrase, expecting that
  customer's own page. With no header, every page embeds to (very nearly) the
  same vector, and none of them mention any customer name at all — the right
  one is an exact tie with ${BURIED_N - 1} others.
- **identifier** — an exact serial number, which the page's own text DOES
  carry. This should hold up regardless of the header setting — identifier
  matches are pinned by the existing keyword pass (recordsStore.js's
  searchPassages), not the embedding.

**noContext** embeds with \`DONOVAN_CHUNK_CONTEXT=0\` (every chunk looks exactly
like a chunk embedded before this feature existed). **withContext** then
re-embeds the SAME page with it back on (the default) — the document's own
header, built from its \`extractions\` row and never printed on the page
itself, is what tells otherwise-identical pages apart.

| category | recall@${K5} (no context) | MRR (no context) | recall@${K5} (with context) | MRR (with context) |
|---|---|---|---|---|
| buried (customer name never on the page itself) | ${noContext.buried.recallAtK} | ${noContext.buried.mrr} | ${withContext.buried.recallAtK} | ${withContext.buried.mrr} |
| identifier (exact serial, printed on the page) | ${noContext.identifier.recallAtK} | ${noContext.identifier.mrr} | ${withContext.identifier.recallAtK} | ${withContext.identifier.mrr} |

Labelled honestly: the **identifier** row is expected to stay high in both
columns (the mechanism it exercises does not depend on chunk embeddings at
all) — it is here to show headers do not regress exact-match retrieval, not to
show them improving it. The **buried** row is where a header should matter:
without one, a page that never mentions its own customer has no way to be told
apart from ${BURIED_N - 1} other pages that read identically.

## Reproduce

\`\`\`
node scripts/eval/retrieval-scale.mjs                    # ~50k pages (this run)
node scripts/eval/retrieval-scale.mjs --pages=2000        # quick smoke run
VOYAGE_API_KEY=voy-... node scripts/eval/retrieval-scale.mjs --pages=2000   # real embeddings
\`\`\`
`;
fs.writeFileSync(handoffPath, md);
console.log(`\nWrote ${handoffPath}`);

await lite.close?.();
process.exit(0);
