/**
 * Dossiers — precomputed, rolling, CITED knowledge per customer or unit
 * (TEAM T2, 2026-09-25). A dossier is the fast-path answer to a broad
 * question a single retrieval call answers badly ("everything we've done
 * for Plaza Dental", "history of the rooftop unit at 88 Whitmore Ave"):
 * instead of re-reading every one of a customer's documents on every ask,
 * the answer is already a short, cited paragraph kept up to date as
 * documents arrive.
 *
 * getDossier(db, entityId) — read side. `db` is the usual tenant-scoped
 *   store; entityId is an entities.id (customer OR equipment/"unit" — both
 *   share one id space, so the caller doesn't need to know which before
 *   asking). Returns null when there is no dossier yet (T1's agent should
 *   then fall back to searchKnowledge over that entity's documents).
 *
 * updateDossierForDocument(ctx, documentId) — the INGEST HOOK, called from
 *   readDocument.js right after a document is linked to its customer/unit,
 *   same "never fatal, the document is already stored either way" contract
 *   as embedDocumentPages. Rebuilds the dossier for every entity that
 *   document is newly linked to, incrementally (only the NEW documents for
 *   that entity are ever sent to the model — the existing summary's
 *   sentences are kept and merged, not regenerated from scratch).
 *
 * runDossierCatchup(ctx, opts) — the NIGHTLY CATCH-UP, called from
 *   cron-sweep.js inside its existing per-tenant loop. Rotates through
 *   entities oldest-checked-first (dossiers.updated_at ASC NULLS FIRST, so
 *   an entity with no dossier yet always goes first) and rebuilds anything
 *   the ingest hook missed or deferred — a hook call that fails, an entity
 *   whose document set changed some other way (a merge, a re-link),
 *   or an entity that simply has more new documents than one hook call's
 *   per-entity budget allows. An entity whose document set hasn't changed
 *   costs one cheap query and a timestamp bump, no model call.
 *
 * runDossierBackfillPage(ctx, opts) — the OPERATOR/ADMIN BACKFILL ACTION
 *   (wired into api/review.js as 'dossierBackfill', same admin-gated +
 *   billed + rate-limited shape as 'semanticBackfill'): one page of work,
 *   paged and budget-aware exactly like search/store.js's runBackfill —
 *   the caller (the Team screen) calls it in a loop until `done`.
 *
 * COST: one Haiku call per (entity, batch-of-new-documents), capped output.
 * Every sentence a dossier ever states carries its own citations
 * ({documentId, page}) — never a bare claim — and the prompt instructs the
 * model to skip anything it can't cite to a specific page. PRIVACY: no
 * question text ever passes through here (there is none); page excerpts
 * are the customer's own already-stored documents, same trust boundary as
 * search/store.js's embedding calls.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { estimateCostUsd, recordModelCall } from '../usage.js';
import { documentIdsForEntities } from './knowledge.js';
import { withTenantRaw } from './store.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** Same env vars getApiKey() reads, but a boolean check that never throws — every entry point below
 *  is a non-fatal hook/sweep, not a request that should surface a ConfigError. */
function hasApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  return Boolean(key) && !key.includes('YOUR_API_KEY');
}

export const DOSSIER_MODEL = process.env.DONOVAN_DOSSIER_MODEL || 'claude-haiku-4-5';
/** entities.entity_type -> dossiers.entity_type. A "unit" IS an equipment entity; the dossier just
 *  speaks the domain word the rest of the product uses for it. */
const DOSSIER_TYPE_OF = { customer: 'customer', equipment: 'unit' };
export const MAX_SENTENCES = 40;
const HOOK_MAX_NEW_DOCS = 6; // ingest hook: small and inline-safe
const BACKFILL_MAX_NEW_DOCS = 20; // catch-up/backfill: a whole batch, off the request path
const MAX_PAGE_CHARS_PER_DOC = 3500; // bound how much of one document's text goes into one prompt
const MAX_OUTPUT_TOKENS = 700;

/* =============================================================== schema probe */

let probe = null;
const PROBE_FALSE_TTL_MS = 5 * 60_000;
export function _resetDossierProbe() { probe = null; }

/** Callers pass either a raw pg client (.query, inside withTenantRaw) or the tenant-scoped store
 *  object every other module in api/_lib uses (.raw) — same duality docLookup.js/store.js already
 *  live with. Normalize once here instead of every call site. */
function runQuery(db, sql, params) {
  return typeof db.query === 'function' ? db.query(sql, params) : db.raw(sql, params);
}

/** Same "tolerate the migration not being pasted" contract as search/store.js's semanticSchemaReady. */
export async function dossierSchemaReady(db, now = Date.now()) {
  if (probe && (probe.ok || now - probe.at < PROBE_FALSE_TTL_MS)) return probe.ok;
  try {
    const r = await runQuery(db,
      `SELECT to_regclass('public.dossiers') IS NOT NULL AS dossiers,
              to_regclass('public.knowledge_reports') IS NOT NULL AS reports`
    );
    const row = r.rows[0] ?? {};
    probe = { ok: Boolean(row.dossiers && row.reports), at: now };
  } catch {
    return false;
  }
  return probe.ok;
}

/* ==================================================================== read side */

function rowToDossier(row) {
  if (!row) return null;
  return {
    entityId: row.entity_id,
    entityType: row.entity_type,
    summary: row.summary,
    sentences: row.sentences ?? [],
    sourceDocumentIds: row.source_document_ids ?? [],
    model: row.model,
    builtAt: row.built_at,
    updatedAt: row.updated_at,
  };
}

/** @returns {Promise<null|{entityId,entityType,summary,sentences,sourceDocumentIds,model,builtAt,updatedAt}>} */
export async function getDossier(db, entityId) {
  if (!(await dossierSchemaReady(db))) return null;
  const { rows } = await runQuery(db, `SELECT * FROM dossiers WHERE entity_id = $1 AND ${TENANT}`, [entityId]);
  return rowToDossier(rows[0]);
}

/* =================================================================== building */

function sha1(text) {
  // Small, dependency-free content signature — collision risk here only matters for "did the doc set
  // change", not cryptographic security.
  return createHash('md5').update(text).digest('hex');
}

async function computeSourceSignature(client, entityId) {
  const docIds = (await documentIdsForEntities({ raw: (sql, p) => client.query(sql, p) }, [entityId])) ?? [];
  if (!docIds.length) return { docIds: [], hash: null };
  const { rows } = await client.query(
    `SELECT id, sha256_hash FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT}`,
    [docIds]
  );
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const hash = sha1(sorted.map((r) => `${r.id}:${r.sha256_hash}`).join('|'));
  return { docIds: sorted.map((r) => r.id), hash };
}

const SUMMARIZE_TOOL = {
  name: 'dossier_sentences',
  description: 'Cited one-sentence facts extracted from these documents, for a rolling customer/unit knowledge summary.',
  input_schema: {
    type: 'object',
    properties: {
      sentences: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'One factual sentence, plain English, no hedging.' },
            page: { type: 'integer', description: 'The page number within THIS document that supports it.' },
          },
          required: ['text', 'page'],
        },
      },
    },
    required: ['sentences'],
  },
};

/** One Haiku call: cited sentences for ONE new document's page text. Never throws. */
async function summarizeDocument(client, deadlineAt, doc) {
  try {
    const text = doc.pages.map((p) => `[page ${p.page_no}] ${p.text}`.slice(0, MAX_PAGE_CHARS_PER_DOC)).join('\n\n');
    if (!text.trim()) return { sentences: [], costUsd: 0 };
    const response = await withBackoff(
      () => client.messages.create(
        {
          model: DOSSIER_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          system: 'Extract at most 4 short, factual sentences a technician would want to remember from this ' +
            'document, each citing the page it came from. Skip boilerplate (form headers, signatures). If ' +
            'nothing is worth remembering, return an empty list. Never invent a page number.',
          tools: [SUMMARIZE_TOOL],
          tool_choice: { type: 'tool', name: 'dossier_sentences' },
          messages: [{ role: 'user', content: `Document type: ${doc.documentType ?? 'unknown'}\n\n${text}` }],
        },
        { timeout: Math.max(1000, deadlineAt - Date.now()) }
      ),
      { deadlineAt }
    );
    const usage = response.usage ?? {};
    const toolUse = response.content?.find((b) => b.type === 'tool_use');
    const sentences = (toolUse?.input?.sentences ?? [])
      .filter((s) => s?.text && Number.isInteger(s.page))
      .map((s) => ({ text: String(s.text).slice(0, 300), citations: [{ documentId: doc.id, page: s.page }] }));
    return { sentences, costUsd: estimateCostUsd({ inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 }) };
  } catch (err) {
    return { sentences: [], costUsd: 0, error: err?.message };
  }
}

/**
 * Rebuilds ONE entity's dossier from whatever new documents it has since the
 * last build, merging into the existing sentence list (FIFO-capped at
 * MAX_SENTENCES — the oldest sentences are dropped first when a dossier grows
 * past that). `sourceDocumentIds` (dossiers.source_document_ids) tracks only
 * documents ACTUALLY SUMMARIZED so far (the "covered" set) — never the
 * entity's full current document set — so a later call can tell "new since
 * last time" apart from "already covered" even when one hook/sweep pass
 * can't fit every new document under `maxNewDocs`; `source_hash` (a digest of
 * the entity's FULL current set) is only ever stored once the covered set
 * catches all the way up, so an entity with a backlog bigger than one pass
 * keeps getting picked up (by staleness) until it does.
 * @returns {Promise<{status:'unchanged'|'built'|'no-schema'|'no-docs'|'error', added?:number, costUsd?:number}>}
 */
export async function rebuildOneDossier(ctx, entityId, { maxNewDocs = HOOK_MAX_NEW_DOCS, deadlineMs = 20_000 } = {}) {
  if (!hasApiKey()) return { status: 'no-key' };
  const started = Date.now();
  try {
    const found = await withTenantRaw(ctx, async (client, tenantId) => {
      if (!(await dossierSchemaReady(client))) return { schema: false };
      const entityRow = await client.query(`SELECT id, entity_type FROM entities WHERE id = $1 AND ${TENANT}`, [entityId]);
      const entityType = DOSSIER_TYPE_OF[entityRow.rows[0]?.entity_type];
      if (!entityType) return { schema: true, noEntity: true };
      const sig = await computeSourceSignature(client, entityId);
      const existing = await client.query(`SELECT * FROM dossiers WHERE entity_id = $1 AND ${TENANT}`, [entityId]);
      const prev = existing.rows[0] ?? null;
      if (prev && prev.source_hash === sig.hash) return { schema: true, tenantId, unchanged: true, entityType };
      if (!sig.docIds.length) return { schema: true, tenantId, noDocs: true, entityType };
      const fullSet = new Set(sig.docIds);
      const coveredSoFar = (prev?.source_document_ids ?? []).filter((id) => fullSet.has(id)); // drop any doc removed/unlinked since
      const coveredSet = new Set(coveredSoFar);
      const newIds = sig.docIds.filter((id) => !coveredSet.has(id)).slice(0, maxNewDocs);
      const docs = newIds.length
        ? await client.query(
            `SELECT d.id, d.document_type, p.page_no, p.text FROM documents d
               JOIN document_pages p ON p.document_id = d.id
              WHERE d.id = ANY($1::uuid[]) AND d.${TENANT} ORDER BY d.id, p.page_no`,
            [newIds]
          )
        : { rows: [] };
      const byDoc = new Map();
      for (const r of docs.rows) {
        if (!byDoc.has(r.id)) byDoc.set(r.id, { id: r.id, documentType: r.document_type, pages: [] });
        byDoc.get(r.id).pages.push({ page_no: r.page_no, text: r.text ?? '' });
      }
      const coveredAfter = [...coveredSoFar, ...newIds];
      return {
        schema: true, tenantId, entityType, prev, sig, pending: [...byDoc.values()], coveredAfter,
        fullyCovered: coveredAfter.length >= sig.docIds.length,
      };
    });

    if (!found.schema) return { status: 'no-schema' };
    if (found.noEntity) return { status: 'no-docs' };
    if (found.unchanged) {
      await withTenantRaw(ctx, (client) => client.query(`UPDATE dossiers SET updated_at = NOW() WHERE entity_id = $1 AND ${TENANT}`, [entityId]));
      return { status: 'unchanged' };
    }
    if (found.noDocs) return { status: 'no-docs' };

    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0, fetch: (...args) => globalThis.fetch(...args) });
    const deadlineAt = started + deadlineMs;
    let costUsd = 0;
    const newSentences = [];
    for (const doc of found.pending) {
      if (Date.now() > deadlineAt - 2000) break;
      const r = await summarizeDocument(client, deadlineAt, doc);
      costUsd += r.costUsd;
      newSentences.push(...r.sentences);
    }
    const merged = [...(found.prev?.sentences ?? []), ...newSentences].slice(-MAX_SENTENCES);
    const summaryText = merged.map((s) => s.text).join(' ');

    await withTenantRaw(ctx, (client2, tenantId) => client2.query(
      `INSERT INTO dossiers (tenant_id, entity_type, entity_id, summary, sentences, source_document_ids, source_hash, model, built_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,NOW(),NOW())
       ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE
         SET summary = EXCLUDED.summary, sentences = EXCLUDED.sentences, source_document_ids = EXCLUDED.source_document_ids,
             source_hash = EXCLUDED.source_hash, model = EXCLUDED.model, built_at = NOW(), updated_at = NOW()`,
      [tenantId, found.entityType, entityId, summaryText, JSON.stringify(merged), JSON.stringify(found.coveredAfter), found.fullyCovered ? found.sig.hash : null, DOSSIER_MODEL]
    ));
    if (costUsd > 0) await recordModelCall(ctx, { model: DOSSIER_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => {}); // token detail already folded into costUsd above; this call attributes SOME spend to the tenant meter even when usage.input/output_tokens weren't threaded through
    console.log(JSON.stringify({ route: 'dossier', t: 'rebuilt', entityType: found.entityType, newDocs: found.pending.length, sentences: merged.length, costUsd: Math.round(costUsd * 10000) / 10000 }));
    return { status: 'built', added: newSentences.length, costUsd, fullyCovered: found.fullyCovered };
  } catch (err) {
    console.warn(`dossier: rebuild failed (${err?.name ?? 'Error'}); will retry on the next hook/sweep`);
    return { status: 'error', error: err?.message };
  }
}

/**
 * INGEST HOOK. Never throws. Finds every customer/unit entity `documentId`
 * is (now) linked to and rebuilds each one's dossier incrementally.
 */
export async function updateDossierForDocument(ctx, documentId, { maxNewDocs = HOOK_MAX_NEW_DOCS } = {}) {
  if (!hasApiKey()) return { status: 'off' };
  try {
    const entityIds = await withTenantRaw(ctx, async (client) => {
      if (!(await dossierSchemaReady(client))) return null;
      const r = await client.query(
        `SELECT DISTINCT entity_id FROM (
            SELECT entity_id FROM document_entity_links WHERE document_id = $1 AND ${TENANT}
            UNION
            SELECT entity_id FROM extractions WHERE document_id = $1 AND entity_id IS NOT NULL AND ${TENANT}
         ) t`,
        [documentId]
      );
      return r.rows.map((row) => row.entity_id);
    });
    if (!entityIds) return { status: 'no-schema' };
    const results = [];
    for (const id of entityIds) results.push(await rebuildOneDossier(ctx, id, { maxNewDocs }));
    return { status: 'done', entities: results.length, built: results.filter((r) => r.status === 'built').length };
  } catch (err) {
    console.warn(`dossier: ingest hook failed (${err?.name ?? 'Error'}); the nightly catch-up will retry`);
    return { status: 'error' };
  }
}

/**
 * NIGHTLY CATCH-UP — one tenant, one deadline slice, called from
 * cron-sweep.js's existing per-tenant loop. Rotates oldest-checked-first.
 */
export async function runDossierCatchup(ctx, { deadlineMs = 8000, maxEntities = 25 } = {}) {
  const started = Date.now();
  const out = { checked: 0, built: 0, unchanged: 0, errors: 0 };
  if (!hasApiKey()) return { ...out, status: 'off' };
  let candidates;
  try {
    candidates = await withTenantRaw(ctx, async (client) => {
      if (!(await dossierSchemaReady(client))) return null;
      const r = await client.query(
        `SELECT e.id FROM entities e
           LEFT JOIN dossiers ds ON ds.entity_id = e.id AND ds.${TENANT}
          WHERE e.entity_type IN ('customer','equipment') AND e.${TENANT} AND e.merged_into IS NULL
          ORDER BY ds.updated_at ASC NULLS FIRST
          LIMIT $1`,
        [maxEntities]
      );
      return r.rows.map((row) => row.id);
    });
  } catch (err) {
    return { ...out, status: 'error', error: err?.message };
  }
  if (candidates === null) return { ...out, status: 'no-schema' };
  for (const id of candidates) {
    if (Date.now() - started > deadlineMs) break;
    out.checked++;
    const r = await rebuildOneDossier(ctx, id, { maxNewDocs: BACKFILL_MAX_NEW_DOCS, deadlineMs: Math.max(5000, deadlineMs - (Date.now() - started)) });
    if (r.status === 'built') out.built++;
    else if (r.status === 'unchanged') out.unchanged++;
    else if (r.status === 'error') out.errors++;
  }
  return { ...out, status: 'done' };
}

/**
 * OPERATOR/ADMIN BACKFILL — one page of work across every stale entity,
 * paged and idempotent exactly like search/store.js's runBackfill: the
 * Team screen calls this in a loop until `stoppedBy === 'done'`.
 */
export async function runDossierBackfillPage(ctx, { deadlineMs = 25_000, maxEntities = 40 } = {}) {
  const r = await runDossierCatchup(ctx, { deadlineMs, maxEntities });
  const stoppedBy = r.status === 'off' || r.status === 'no-schema' ? r.status : (r.checked < maxEntities ? 'done' : 'deadline');
  return { stoppedBy, ...r };
}

/** Progress numbers for the Team-screen card. */
export async function dossierStatus(ctx) {
  if (!hasApiKey()) return { configured: false, ready: false, reason: 'not-configured' };
  return withTenantRaw(ctx, async (client) => {
    if (!(await dossierSchemaReady(client))) return { configured: true, ready: false, reason: 'migration-pending' };
    const r = await client.query(
      `SELECT
         (SELECT count(*) FROM entities e WHERE e.entity_type IN ('customer','equipment') AND e.${TENANT} AND e.merged_into IS NULL)::int AS entities,
         (SELECT count(*) FROM dossiers WHERE ${TENANT})::int AS dossiers`
    );
    const { entities, dossiers } = r.rows[0];
    return { configured: true, ready: true, entities, dossiers, remaining: Math.max(0, entities - dossiers) };
  });
}
