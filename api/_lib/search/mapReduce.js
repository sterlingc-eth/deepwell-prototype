/**
 * mapReduceAnswer — synthesis over dozens-to-hundreds of documents (TEAM T2,
 * 2026-09-25). searchKnowledge (./knowledge.js) is built to find the RIGHT
 * pages for a question about one thing; a question like "how many
 * compressor failures did we have across all Trane units last year" needs an
 * answer built FROM many documents, not a top-k of the most similar pages.
 *
 *   mapReduceAnswer(ctx, { question, filters, maxDocuments, deadlineMs, budgetUsd, notifyEmail })
 *
 * Unlike searchKnowledge/getDossier, this takes `ctx` rather than an
 * already-open `db` — deliberately: a synthesis run makes dozens of slow
 * model calls, and this codebase's own convention (see extractDocument.js)
 * is that a live model call never happens while a tenant transaction is held
 * open. Every DB touch here is its own short-lived withTenant() call, exactly
 * bracketing one read or write; the map/reduce model calls in between hold no
 * connection at all.
 *
 * Pipeline:
 *   1. SELECT — filters (./knowledge.js's resolveFilterDocumentIds) narrow
 *      the corpus first; a broad search (db.searchPassages) then ranks
 *      candidate documents by relevance to `question` within that corpus.
 *   2. Too large for one request (> maxDocuments, default MAX_INLINE_DOCS)?
 *        -> a single customer/unit filter with an existing dossier answers
 *           from that instead (getDossier), with an HONEST coverage line
 *           saying so (not silently passed off as a fresh read); otherwise
 *        -> queued as an async knowledge_reports row (queueFullReportJob)
 *           that runKnowledgeReportSweepStep (called from cron-sweep.js)
 *           works through later, emailing `notifyEmail` when it's ready.
 *   3. MAP — Haiku, one short call per document, in budgeted parallel
 *      batches (MAP_CONCURRENCY at a time), each returning cited bullet
 *      facts relevant to `question` (never a bare claim — see MAP_TOOL).
 *      Stops early on the wall-clock deadline or the $ budget; whatever
 *      didn't get mapped is reported, not hidden (`coverage.skippedDocuments`).
 *   4. REDUCE — Sonnet turns the map bullets into one cited answer.
 *
 * Returned shape (both the inline and the queued-job path use it):
 *   { status: 'answered'|'dossier'|'queued', answer?, citations?: [{documentId,page}],
 *     coverage: { consideredDocuments, mappedDocuments, skippedDocuments, note },
 *     reportId?, costUsd }
 *
 * PRIVACY: no question text is ever logged (only counts/cost, same discipline
 * as api/_lib/search/{embed,store}.js).
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { escalationModel } from '../agent/escalation.js';
import { estimateCostUsd, recordModelCall } from '../usage.js';
import { sendEmail } from '../email.js';
import { withTenant } from '../recordsStore.js';
import { resolveFilterDocumentIds } from './knowledge.js';
import { getDossier, dossierSchemaReady } from './dossier.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export const MAP_MODEL = process.env.DONOVAN_MAPREDUCE_MAP_MODEL || 'claude-haiku-4-5';
export const MAX_INLINE_DOCS = Number(process.env.DONOVAN_MAPREDUCE_MAX_INLINE_DOCS) || 150;
export const MAX_QUEUED_DOCS = Number(process.env.DONOVAN_MAPREDUCE_MAX_QUEUED_DOCS) || 800;
const MAP_CONCURRENCY = 6;
const MAX_PAGE_CHARS = 2500;
const MAP_MAX_OUTPUT_TOKENS = 300;
const REDUCE_MAX_OUTPUT_TOKENS = 1000;

function hasApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  return Boolean(key) && !key.includes('YOUR_API_KEY');
}

/* ============================================================= document selection */

/** Candidate documents for `question` within `documentIds` (or the whole tenant when null),
 *  ranked by the best-scoring page found for each — the same hybrid retrieval searchKnowledge
 *  uses, just aggregated to the document level since map-reduce works one document at a time. */
async function selectCandidateDocuments(db, question, documentIds, limit) {
  const poolPages = Math.min(Math.max(limit * 3, 60), 1000); // enough pages to surface `limit` distinct documents
  const rows = await db.searchPassages(question, poolPages, { documentIds });
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.document_id)) {
      byDoc.set(r.document_id, { documentId: r.document_id, documentType: r.document_type, filename: r.original_filename, pages: [] });
    }
    byDoc.get(r.document_id).pages.push({ page_no: r.page_no, excerpt: r.excerpt });
  }
  // Filters with no search hits at all (a pure metadata restriction, e.g. "every invoice last year"
  // with nothing lexically/semantically close to the question) still need every document considered —
  // fall back to the filtered id list itself, one representative page each (first page).
  if (!byDoc.size && documentIds?.length) {
    const { rows: docs } = await db.raw(
      `SELECT d.id AS document_id, d.document_type, d.original_filename,
              (SELECT p.page_no FROM document_pages p WHERE p.document_id = d.id ORDER BY p.page_no LIMIT 1) AS page_no
         FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT}`,
      [documentIds]
    );
    for (const d of docs) byDoc.set(d.document_id, { documentId: d.document_id, documentType: d.document_type, filename: d.original_filename, pages: d.page_no ? [{ page_no: d.page_no, excerpt: '' }] : [] });
  }
  return [...byDoc.values()].slice(0, limit);
}

/* ===================================================================== map step */

const MAP_TOOL = {
  name: 'facts_for_question',
  description: 'Cited facts from this one document that bear on the question. Empty if it has nothing relevant.',
  input_schema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, page: { type: 'integer' } },
          required: ['text', 'page'],
        },
      },
    },
    required: ['facts'],
  },
};

async function mapOneDocument(client, deadlineAt, question, doc, pageTextByPage) {
  try {
    const text = doc.pages
      .map((p) => `[page ${p.page_no}] ${(pageTextByPage.get(p.page_no) ?? p.excerpt ?? '').slice(0, MAX_PAGE_CHARS)}`)
      .join('\n\n');
    if (!text.trim()) return { facts: [], costUsd: 0 };
    const response = await withBackoff(
      () => client.messages.create(
        {
          model: MAP_MODEL,
          max_tokens: MAP_MAX_OUTPUT_TOKENS,
          temperature: 0,
          system: 'You are given one excerpt from ONE document and a question spanning many documents. Return only ' +
            'facts THIS document actually states that bear on the question, each citing its page. Never speculate ' +
            'and never answer the overall question — that happens later, once every document has been read.',
          tools: [MAP_TOOL],
          tool_choice: { type: 'tool', name: 'facts_for_question' },
          messages: [{ role: 'user', content: `QUESTION: ${question}\n\nDOCUMENT (${doc.documentType ?? 'unknown type'}):\n${text}` }],
        },
        { timeout: Math.max(1000, deadlineAt - Date.now()) }
      ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const toolUse = response.content?.find((b) => b.type === 'tool_use');
    const facts = (toolUse?.input?.facts ?? [])
      .filter((f) => f?.text && Number.isInteger(f.page))
      .map((f) => ({ text: String(f.text).slice(0, 300), documentId: doc.documentId, page: f.page }));
    return { facts, costUsd: estimateCostUsd({ inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 }) };
  } catch (err) {
    return { facts: [], costUsd: 0, error: err?.message };
  }
}

/** Runs mapOneDocument over `docs` in budgeted, bounded-concurrency batches. Never throws. */
async function mapDocuments(question, docs, { deadlineAt, budgetUsd }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0, fetch: (...args) => globalThis.fetch(...args) });
  const allFacts = [];
  let costUsd = 0;
  let mapped = 0;
  for (let i = 0; i < docs.length; i += MAP_CONCURRENCY) {
    if (Date.now() > deadlineAt - 2000 || costUsd >= budgetUsd) break;
    const batch = docs.slice(i, i + MAP_CONCURRENCY);
    const results = await Promise.all(batch.map((doc) => mapOneDocument(client, deadlineAt, question, doc, new Map())));
    for (const r of results) {
      costUsd += r.costUsd;
      allFacts.push(...r.facts);
      mapped++;
    }
  }
  return { facts: allFacts, costUsd, mapped };
}

/* ==================================================================== reduce step */

async function reduceFacts(question, facts, { deadlineAt }) {
  if (!facts.length) return { answer: null, costUsd: 0 };
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0, fetch: (...args) => globalThis.fetch(...args) });
  const model = escalationModel();
  const listing = facts.map((f, i) => `${i + 1}. [doc ${f.documentId.slice(0, 8)} p.${f.page}] ${f.text}`).join('\n');
  try {
    const response = await withBackoff(
      () => client.messages.create(
        {
          model, max_tokens: REDUCE_MAX_OUTPUT_TOKENS, temperature: 0,
          system: 'Synthesize these cited facts (drawn from many documents) into a direct answer to the question. ' +
            'Every claim must keep its citation inline as (doc <id> p.<page>). If the facts don\'t fully answer the ' +
            'question, say plainly what is and isn\'t covered — never fill a gap with something not in the facts.',
          messages: [{ role: 'user', content: `QUESTION: ${question}\n\nFACTS:\n${listing}` }],
        },
        { timeout: Math.max(1000, deadlineAt - Date.now()) }
      ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const answer = response.content?.find((b) => b.type === 'text')?.text ?? null;
    return { answer, model, costUsd: estimateCostUsd({ inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 }) };
  } catch (err) {
    return { answer: null, costUsd: 0, error: err?.message };
  }
}

/* ================================================================= core map-reduce */

/** Runs select->map->reduce over an ALREADY-decided document budget. Shared by the inline path
 *  (mapReduceAnswer) and the async job runner (runKnowledgeReportJob), which simply allows a
 *  bigger maxDocuments/budgetUsd since it isn't holding a request open. Opens its own short-lived
 *  withTenant() just for the SELECT step — the map/reduce model calls that follow hold no connection. */
async function computeMapReduce(ctx, { question, documentIds, maxDocuments, deadlineMs, budgetUsd }) {
  const deadlineAt = Date.now() + deadlineMs;
  const candidates = await withTenant(ctx, (db) => selectCandidateDocuments(db, question, documentIds, maxDocuments));
  const { facts, costUsd: mapCost, mapped } = await mapDocuments(question, candidates, { deadlineAt, budgetUsd });
  const { answer, costUsd: reduceCost } = await reduceFacts(question, facts, { deadlineAt });
  const costUsd = mapCost + reduceCost;
  if (costUsd > 0) await recordModelCall(ctx, { model: MAP_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => {});
  const skipped = candidates.length - mapped;
  const citations = [...new Map(facts.map((f) => [`${f.documentId}:${f.page}`, { documentId: f.documentId, page: f.page }])).values()];
  const coverage = {
    consideredDocuments: candidates.length,
    mappedDocuments: mapped,
    skippedDocuments: Math.max(0, skipped),
    note: skipped > 0
      ? `Read ${mapped} of ${candidates.length} matching documents (stopped by the time/cost budget for this request); the rest were not considered.`
      : `Read all ${mapped} matching document${mapped === 1 ? '' : 's'}.`,
  };
  return {
    answer: answer ?? (facts.length ? null : "No document matched this question closely enough to answer from."),
    citations, coverage, costUsd: Math.round(costUsd * 10000) / 10000,
  };
}

/* ==================================================================== entry points */

/**
 * @param ctx  {tenantKey, tenantName}
 * @param {{question:string, filters?:object, maxDocuments?:number, deadlineMs?:number, budgetUsd?:number, notifyEmail?:string, requestedBy?:string}} opts
 */
export async function mapReduceAnswer(ctx, {
  question, filters = {}, maxDocuments = MAX_INLINE_DOCS, deadlineMs = 45_000, budgetUsd = 0.75, notifyEmail, requestedBy,
} = {}) {
  if (!hasApiKey()) return { status: 'error', error: 'not-configured' };
  const pool = await withTenant(ctx, async (db) => {
    const { documentIds } = await resolveFilterDocumentIds(db, filters);
    return selectCandidateDocuments(db, question, documentIds, MAX_QUEUED_DOCS + 1);
  });

  if (pool.length > maxDocuments) {
    const entityIds = [...(filters.customerIds ?? []), ...(filters.unitIds ?? [])];
    if (entityIds.length === 1) {
      const dossier = await withTenant(ctx, (db) => getDossier(db, entityIds[0])).catch(() => null);
      if (dossier) {
        return {
          status: 'dossier',
          answer: dossier.summary,
          citations: (dossier.sentences ?? []).flatMap((s) => s.citations ?? []),
          coverage: {
            consideredDocuments: pool.length,
            mappedDocuments: (dossier.sourceDocumentIds ?? []).length,
            skippedDocuments: Math.max(0, pool.length - (dossier.sourceDocumentIds ?? []).length),
            note: `${pool.length} documents match — answered from the precomputed summary ` +
              `(covers ${(dossier.sourceDocumentIds ?? []).length} of them as of ${dossier.builtAt ?? 'an earlier build'}), not a fresh read of every one.`,
          },
          costUsd: 0,
        };
      }
    }
    const reportId = await withTenant(ctx, (db) => queueFullReportJob(db, { question, filters, notifyEmail, requestedBy, documentCount: pool.length }));
    return {
      status: 'queued',
      reportId,
      coverage: {
        consideredDocuments: pool.length, mappedDocuments: 0, skippedDocuments: pool.length,
        note: `${pool.length} documents match — too many to answer inline. A full report has been queued` +
          `${notifyEmail ? ` and will be emailed to ${notifyEmail} when ready` : ''}.`,
      },
      costUsd: 0,
    };
  }

  const result = await computeMapReduce(ctx, { question, documentIds: pool.map((d) => d.documentId), maxDocuments, deadlineMs, budgetUsd });
  return { status: 'answered', ...result };
}

/* ============================================================== async full-report job */

// knowledge_reports ships in the same migration (and is probed together with) dossiers.
const reportSchemaReady = dossierSchemaReady;

/**
 * Takes the SAME `db` the caller (mapReduceAnswer) already has open — never opens its own
 * transaction. That matters: mapReduceAnswer is always called with a `db` a caller already
 * obtained via withTenant, and this codebase's tenant-scoped connections come from a single
 * shared pool, so nesting a second withTenant/withTenantRaw INSIDE that callback risks starving
 * the pool (and deadlocks outright against a pool of size 1, as the PGlite test harness uses).
 */
export async function queueFullReportJob(db, { question, filters, notifyEmail, requestedBy, documentCount } = {}) {
  if (!(await reportSchemaReady(db))) return null;
  const { rows } = await db.raw(
    `INSERT INTO knowledge_reports (tenant_id, requested_by, question, filters, status, document_count, notify_email)
     VALUES ($1,$2,$3,$4::jsonb,'pending',$5,$6) RETURNING id`,
    [db.tenantId, requestedBy ?? null, question, JSON.stringify(filters ?? {}), documentCount ?? null, notifyEmail ?? null]
  );
  return rows[0]?.id ?? null;
}

export async function getReportJob(db, reportId) {
  const { rows } = await db.raw(`SELECT * FROM knowledge_reports WHERE id = $1 AND ${TENANT}`, [reportId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, question: row.question, filters: row.filters, status: row.status,
    documentCount: row.document_count, coverage: row.coverage, result: row.result, error: row.error,
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

/**
 * Processes at most one pending report per call — called from cron-sweep.js's
 * existing per-tenant loop, one shot per tenant per sweep (a full report is
 * inherently rare and expensive; nothing here needs to race through a queue).
 * Never throws. Takes only `ctx` — see the file header for why (every DB
 * touch is its own short withTenant() call; the map/reduce model calls in
 * between, which can run for tens of seconds, hold no connection at all).
 */
export async function runKnowledgeReportSweepStep(ctx, { deadlineMs = 60_000 } = {}) {
  if (!hasApiKey()) return { processed: 0, status: 'off' };
  try {
    const job = await withTenant(ctx, async (db) => {
      if (!(await reportSchemaReady(db))) return null;
      const claimed = await db.raw(
        `UPDATE knowledge_reports SET status = 'running', updated_at = NOW()
           WHERE id = (SELECT id FROM knowledge_reports WHERE status = 'pending' AND ${TENANT} ORDER BY created_at LIMIT 1)
         RETURNING *`
      );
      return claimed.rows[0] ?? undefined; // undefined: schema ready but nothing pending
    });
    if (job === null) return { processed: 0, status: 'no-schema' };
    if (!job) return { processed: 0, status: 'idle' };

    const documentIds = await withTenant(ctx, (db) => resolveFilterDocumentIds(db, job.filters ?? {})).then((r) => r.documentIds);
    const result = await computeMapReduce(ctx, {
      question: job.question, documentIds, maxDocuments: MAX_QUEUED_DOCS, deadlineMs, budgetUsd: 3,
    });
    await withTenant(ctx, (db) => db.raw(
      `UPDATE knowledge_reports SET status = 'done', result = $2, coverage = $3::jsonb, cost_usd = $4, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND ${TENANT}`,
      [job.id, result.answer, JSON.stringify(result.coverage), result.costUsd]
    ));
    if (job.notify_email) {
      await sendEmail({
        to: job.notify_email,
        subject: 'Your DeepWell full report is ready',
        text: `${result.answer ?? 'No answer could be produced.'}\n\n${result.coverage.note}`,
      }).catch(() => {});
    }
    return { processed: 1, status: 'done', reportId: job.id };
  } catch (err) {
    console.warn(`knowledge-report: sweep step failed (${err?.name ?? 'Error'})`);
    return { processed: 0, status: 'error', error: err?.message };
  }
}
