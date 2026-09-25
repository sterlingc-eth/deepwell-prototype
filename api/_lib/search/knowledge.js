/**
 * searchKnowledge — THE search interface for enterprise-scale tenants
 * (100+ employees, hundreds of thousands of documents). This is the
 * function Team T1's Sonnet research agent (read_document/follow_links/
 * timeline tools) calls to find candidate pages; it is also what
 * mapReduceAnswer (./mapReduce.js) uses to select the document set for a
 * synthesis question.
 *
 * ---------------------------------------------------------------- INTERFACE
 *
 *   import { searchKnowledge } from './knowledge.js';
 *   const hits = await withTenant(ctx, (db) => searchKnowledge(db, {
 *     query: 'any complaints about noise at Plaza Dental',
 *     filters: {
 *       customerIds: ['<entity-id>'],   // entities.entity_type='customer'
 *       unitIds: ['<entity-id>'],       // entities.entity_type='equipment'
 *       docTypes: ['service-ticket'],   // documents.document_type values
 *       dateFrom: '2024-01-01', dateTo: '2024-12-31', // see TIME SEMANTICS below
 *       technician: 'Maria',            // extractions.field_key='technician'
 *     },
 *     k: 10,
 *     rerank: true,                     // default true; Voyage rerank when VOYAGE_API_KEY is set
 *   }));
 *
 * `db` is the SAME tenant-scoped store object every other module in this
 * codebase already has (the value withTenant(ctx, fn) hands to fn, or the
 * `db` api/ask.js already threads through docLookup/contactLookup/
 * runAnalyticsQuestion) — searchKnowledge is not a new database
 * abstraction, it is a thin, documented layer ON TOP of
 * db.searchPassages(), which already does hybrid FTS + pgvector + RRF +
 * identifier pinning + tenant RLS (api/_lib/search/hybrid.js).
 *
 * Returns, best first:
 *   Promise<{ doc: { id, filename, docType, stage }, page: number,
 *             excerpt: string, score: number, matchedBy: string,
 *             collapsed?: number }[]>
 *
 * `matchedBy` is one of searchPassages' own labels ("text", "semantic",
 * "identifier:<token>", or a "+"-joined combination) — see hybrid.js.
 * `collapsed` (only present when > 0) is how many near-duplicate pages
 * (the same templated form filled out differently) were folded into this
 * one — see collapseNearDuplicates below.
 *
 * -------------------------------------------------------------- WHAT THIS ADDS
 *
 * 1. ENTITY-FIRST FILTERING: `filters` are resolved to a concrete document-id
 *    set BEFORE retrieval runs (resolveFilterDocumentIds), using the exact
 *    tables the rest of the app already trusts for identity
 *    (document_entity_links, extractions.entity_id) — not a second, looser
 *    text match. When the caller gives no filters at all but the query text
 *    itself names a customer/address or an explicit date range, entity-first
 *    resolution (resolveQueryEntities) tries the SAME deterministic resolvers
 *    api/ask.js already uses (contactLookup.resolveContactCandidates /
 *    resolveAddressCandidates, analytics.resolveAnyTimeRange) and restricts
 *    automatically when — and only when — exactly one entity matches. This
 *    never guesses: an ambiguous or absent match leaves the search
 *    unrestricted, same "never hijack" discipline as docLookup/contactLookup.
 * 2. RERANK BY DEFAULT: unlike the base semantic-search feature (which
 *    requires BOTH VOYAGE_API_KEY and DONOVAN_RERANK_MODEL — a deliberate
 *    double opt-in for the raw feature, see embed.js), searchKnowledge
 *    reranks its top candidate pool by default whenever VOYAGE_API_KEY is
 *    present, using DONOVAN_RERANK_MODEL if set, else DEFAULT_RERANK_MODEL
 *    ('rerank-2.5-lite'; pass rerank:false to opt out). If hybrid.js already
 *    reran internally (DONOVAN_RERANK_MODEL was set), this layer skips its
 *    own pass rather than paying for a second one.
 * 3. NEAR-DUPLICATE COLLAPSE: enterprise corpora are full of the same
 *    template (a standard maintenance checklist, a boilerplate permit form)
 *    filled out hundreds of times — without collapsing them, one popular
 *    template can occupy an entire top-k with near-identical excerpts.
 *    collapseNearDuplicates folds pages whose excerpts are near-identical
 *    (same document_type, high shingle overlap) down to the best-ranked one.
 *
 * TIME SEMANTICS: dateFrom/dateTo are matched against
 * extractions.service_date / installation_date first (falling back to
 * documents.created_at for a document with neither) — the same "serviced
 * vs. added" distinction api/_lib/scope.js's module comment documents.
 *
 * SCALE NOTE: resolveFilterDocumentIds caps the id list it hands to
 * searchPassages at MAX_FILTER_DOCS (5,000). A customer/unit-scoped search
 * (the common case) is always far under that. A tenant-wide filter with no
 * customer/unit scope (e.g. "every Trane install last year") at true
 * hundreds-of-thousands-of-documents scale is capped to the most recent
 * MAX_FILTER_DOCS rather than left unbounded — a real limitation, called out
 * here rather than silently truncating: `filtered.truncated` is set on the
 * result when this happened (see searchKnowledge's return value shape,
 * checked via db.raw directly by callers that need to know).
 */
import { documentTypeLabel, docTypeFromWord } from '../documentTypes.js';
import { resolveContactCandidates, resolveAddressCandidates } from '../contactLookup.js';
import { significantAddressTokens } from '../fastPath.js';
import { resolveAnyTimeRange } from '../analytics.js';
import { embedConfig } from './embed.js';
import { rerankDocuments } from './rerank.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** Hard cap on how many document ids a filter is allowed to restrict a search to (see SCALE NOTE above). */
export const MAX_FILTER_DOCS = 5000;
/** Default cross-encoder when the caller wants rerank and a key is present but no model is configured. */
export const DEFAULT_RERANK_MODEL = 'rerank-2.5-lite';
/** How many candidates we pull before reranking/collapsing, regardless of the final k (spec: "top 50 -> k"). */
const RERANK_POOL = 50;
const EXCERPT_FOR_RERANK_CHARS = 1200;

/* ============================================================== entity-first */

const STOPWORDS_TITLECASE = new Set([
  'the', 'a', 'an', 'what', 'who', 'where', 'when', 'how', 'why', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'show', 'list', 'find', 'get', 'tell', 'i', 'we', 'us', 'me', 'any', 'all', 'everything', 'about', 'for', 'and', 'or',
]);

/** Runs of 2+ consecutive Title-Case words ("Plaza Dental", "Bill Whitmore") — candidate proper-noun phrases. Pure. */
export function extractProperNounPhrases(text) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const phrase = run.join(' ');
      if (!run.every((w) => STOPWORDS_TITLECASE.has(w.toLowerCase()))) out.push(phrase);
    }
    run = [];
  };
  const tokens = String(text ?? '').split(/\s+/);
  for (const t of tokens) {
    const w = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (/^[A-Z][a-zA-Z0-9'&.-]*$/.test(w) && !STOPWORDS_TITLECASE.has(w.toLowerCase())) run.push(w);
    else flush();
  }
  flush();
  return [...new Set(out)];
}

/** A leading "<number> <word...>" run (a street address written into the question). Pure. */
export function extractAddressPhrase(text) {
  const m = /\b(\d{1,6}\s+[A-Za-z][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9.'-]+){0,4})/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** Doc-type words mentioned in the query ("invoice", "permit", ...), via the same synonym table documentTypes.js already exposes. Pure-ish (no I/O). */
export function extractDocTypeMentions(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
  const found = new Set();
  for (const w of words) {
    const t = docTypeFromWord(w.replace(/s$/, '')) || docTypeFromWord(w);
    if (t) found.add(t);
  }
  return [...found];
}

/**
 * Deterministic, no-model entity-first resolution: tries to turn plain
 * query text into filters, the same way docLookup.js/contactLookup.js
 * resolve a question — NEVER guesses (only restricts on an UNAMBIGUOUS
 * single match), so a miss here just means "unrestricted", not wrong.
 * @returns {Promise<{customerIds?: string[], dateFrom?: string, dateTo?: string, docTypes?: string[]}>}
 */
export async function resolveQueryEntities(db, query, { today } = {}) {
  const out = {};
  const addr = extractAddressPhrase(query);
  let resolved = false;
  if (addr) {
    const tokens = significantAddressTokens(addr);
    if (tokens.length) {
      const rows = await resolveAddressCandidates(db, addr).catch(() => []);
      if (rows.length === 1) { out.customerIds = [rows[0].id]; resolved = true; }
    }
  }
  if (!resolved) {
    for (const phrase of extractProperNounPhrases(query)) {
      const rows = await resolveContactCandidates(db, phrase).catch(() => []);
      if (rows.length === 1) { out.customerIds = [rows[0].id]; resolved = true; break; }
      if (rows.length > 1) break; // ambiguous on this phrase — don't keep trying other phrases and guess differently
    }
  }
  const range = resolveAnyTimeRange(query, today ?? new Date().toISOString().slice(0, 10));
  if (range?.from) { out.dateFrom = range.from; out.dateTo = range.to ?? range.from; }
  const docTypes = extractDocTypeMentions(query);
  if (docTypes.length) out.docTypes = docTypes;
  return out;
}

/* ============================================================ filter -> docIds */

/**
 * Every document id reachable through document_entity_links or
 * extractions.entity_id for ANY of `entityIds` — works uniformly for a
 * customer entity or a unit (equipment) entity, since both link the same way.
 */
export async function documentIdsForEntities(db, entityIds) {
  if (!entityIds?.length) return null;
  const { rows } = await db.raw(
    `SELECT DISTINCT document_id FROM (
        SELECT document_id FROM document_entity_links WHERE entity_id = ANY($1::uuid[]) AND ${TENANT_SQL}
        UNION
        SELECT document_id FROM extractions WHERE entity_id = ANY($1::uuid[]) AND ${TENANT_SQL}
     ) t`,
    [entityIds]
  );
  return rows.map((r) => r.document_id);
}

async function documentIdsForDocTypes(db, docTypes) {
  if (!docTypes?.length) return null;
  const { rows } = await db.raw(
    `SELECT id AS document_id FROM documents WHERE document_type = ANY($1::text[]) AND ${TENANT_SQL}`,
    [docTypes]
  );
  return rows.map((r) => r.document_id);
}

/** TIME SEMANTICS: service_date/installation_date first, documents.created_at as the fallback for a document with neither. */
async function documentIdsForDateRange(db, dateFrom, dateTo) {
  if (!dateFrom) return null;
  const to = dateTo ?? dateFrom;
  const { rows } = await db.raw(
    `SELECT document_id FROM extractions
       WHERE field_key IN ('service_date', 'installation_date') AND ${TENANT_SQL}
         AND value ~ '^\\d{4}-\\d{2}-\\d{2}' AND substring(value from 1 for 10)::date BETWEEN $1::date AND $2::date
     UNION
     SELECT id AS document_id FROM documents d
       WHERE ${TENANT_SQL.replace('tenant_id', 'd.tenant_id')} AND d.created_at::date BETWEEN $1::date AND $2::date
         AND NOT EXISTS (
           SELECT 1 FROM extractions x
            WHERE x.document_id = d.id AND x.field_key IN ('service_date', 'installation_date')
              AND ${TENANT_SQL.replace('tenant_id', 'x.tenant_id')})`,
    [dateFrom, to]
  );
  return rows.map((r) => r.document_id);
}

async function documentIdsForTechnician(db, technician) {
  if (!technician) return null;
  const { rows } = await db.raw(
    `SELECT document_id FROM extractions WHERE field_key = 'technician' AND value ILIKE $1 AND ${TENANT_SQL}`,
    [`%${String(technician).replace(/[\\%_]/g, '\\$&')}%`]
  );
  return rows.map((r) => r.document_id);
}

/**
 * Resolves `filters` to a single document-id list (intersection across every
 * filter dimension supplied), or `null` when no filter restricts anything
 * (searchPassages then searches the whole tenant, as it always has).
 * Exported for mapReduceAnswer, which needs the same document set to select
 * what it maps over.
 * @returns {Promise<{documentIds: string[]|null, truncated: boolean}>}
 */
export async function resolveFilterDocumentIds(db, filters = {}) {
  const parts = [];
  const entityIds = [...(filters.customerIds ?? []), ...(filters.unitIds ?? [])];
  if (entityIds.length) parts.push(await documentIdsForEntities(db, entityIds));
  if (filters.docTypes?.length) parts.push(await documentIdsForDocTypes(db, filters.docTypes));
  if (filters.dateFrom) parts.push(await documentIdsForDateRange(db, filters.dateFrom, filters.dateTo));
  if (filters.technician) parts.push(await documentIdsForTechnician(db, filters.technician));

  const active = parts.filter((p) => p !== null);
  if (!active.length) return { documentIds: null, truncated: false };

  let ids = active[0];
  for (let i = 1; i < active.length; i++) {
    const s = new Set(active[i]);
    ids = ids.filter((id) => s.has(id));
  }
  const truncated = ids.length > MAX_FILTER_DOCS;
  return { documentIds: truncated ? ids.slice(0, MAX_FILTER_DOCS) : ids, truncated };
}

/* ================================================================= near-dup */

/** Lowercase, digits collapsed to '#', punctuation stripped — so "Invoice #4021" and "Invoice #9873" shingle the same. */
function normalizeForShingle(text) {
  return String(text ?? '').toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigramSet(text) {
  const words = normalizeForShingle(text).split(' ').filter(Boolean);
  const s = new Set();
  for (let i = 0; i < words.length - 1; i++) s.add(`${words[i]}_${words[i + 1]}`);
  if (!s.size && words.length) s.add(words[0]);
  return s;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Collapses near-identical excerpts (the same filled-out template) to the
 * best-ranked one within each document_type, so one popular boilerplate form
 * doesn't crowd out real diversity in the top-k. `rows` must already be
 * ranked best-first. Pure; exported for tests.
 */
export function collapseNearDuplicates(rows, { threshold = 0.88 } = {}) {
  const kept = [];
  const shingles = [];
  for (const r of rows) {
    const sh = bigramSet(r.excerpt);
    let dupOf = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].document_type === r.document_type && jaccard(sh, shingles[i]) >= threshold) { dupOf = i; break; }
    }
    if (dupOf === -1) { kept.push({ ...r, _collapsed: 0 }); shingles.push(sh); }
    else kept[dupOf]._collapsed += 1;
  }
  return kept;
}

/* =============================================================== the interface */

/**
 * @param db  a tenant-scoped store (withTenant(ctx, db => ...)'s db, or any
 *   object exposing .searchPassages and .raw with the same contract).
 * @param {{query:string, filters?:object, k?:number, rerank?:boolean}} opts
 */
export async function searchKnowledge(db, { query, filters = {}, k = 10, rerank = true } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];

  let effectiveFilters = filters;
  const hasAnyFilter = Boolean(
    filters.customerIds?.length || filters.unitIds?.length || filters.docTypes?.length ||
    filters.dateFrom || filters.technician
  );
  if (!hasAnyFilter) {
    const inferred = await resolveQueryEntities(db, q).catch(() => ({}));
    if (Object.keys(inferred).length) effectiveFilters = { ...filters, ...inferred };
  }

  const { documentIds } = await resolveFilterDocumentIds(db, effectiveFilters);
  if (documentIds && documentIds.length === 0) return []; // filter matched nothing — never fall through to "everything"

  const poolSize = Math.max(k, RERANK_POOL);
  const raw = await db.searchPassages(q, poolSize, { documentIds });
  let collapsed = collapseNearDuplicates(raw);

  const cfg = embedConfig();
  const upstreamAlreadyReranked = Boolean(cfg.rerankModel); // hybrid.js already reranked internally in this case
  if (rerank && cfg.enabled && !upstreamAlreadyReranked && collapsed.length > 1) {
    const model = process.env.DONOVAN_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL;
    const docs = collapsed.map((r) => String(r.excerpt ?? '').slice(0, EXCERPT_FOR_RERANK_CHARS));
    const rr = await rerankDocuments(q, docs, { ...cfg, rerankModel: model }).catch(() => null);
    if (rr) {
      const seen = new Set(rr.order);
      collapsed = [...rr.order.map((i) => collapsed[i]), ...collapsed.filter((_, i) => !seen.has(i))];
    }
  }

  return collapsed.slice(0, k).map((r) => ({
    doc: { id: r.document_id, filename: r.original_filename, docType: r.document_type, docTypeLabel: documentTypeLabel(r.document_type), stage: r.stage },
    page: r.page_no,
    excerpt: r.excerpt,
    score: r.rank,
    matchedBy: r.matched_by,
    ...(r._collapsed ? { collapsed: r._collapsed } : {}),
  }));
}
