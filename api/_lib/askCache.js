/**
 * Per-tenant answer cache for POST /api/ask (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md).
 * Table: M3-config/17-ask-cache-and-search-index.sql (owner-applied; this
 * file degrades to "always a miss" gracefully until then — see tableExists
 * below).
 *
 * INVARIANT this whole file exists to protect: a cached answer is reused
 * ONLY when (a) the question hashes the same (api/ask.js computes
 * `hashQuestion(normalizeQuestion(question))` and hands us the result — this
 * file never touches question text itself, only its hash), (b) `today`
 * matches exactly (date-relative answers like "days left" must not survive
 * past midnight), (c) `corpus_stamp` still matches the tenant's current
 * data (see STAMP_EXPR below), and (d) the row is under 24h old. All four are
 * checked; a mismatch on any one is an ordinary cache miss, never an error.
 *
 * corpus_stamp composition — one cheap query, four tenant-scoped aggregates:
 *   documents:            count + count(stage='verified') + max(updated_at)
 *                          -> catches ingest, verify/unverify (via the
 *                             verified-count), and classifyDocument (the one
 *                             write path with no other signal — see its
 *                             updated_at bump in reviewStore.js).
 *   extractions:           count + max(corrected_at, else created_at)
 *                          -> catches (re)extraction and field correction.
 *   document_entity_links: count + max(created_at)
 *                          -> catches linking/unlinking/assignDocumentCustomer
 *                             (delete+insert, never an in-place update).
 *   entities:              count + max(updated_at)
 *                          -> catches merges (the dropped entity's
 *                             merged_into + updated_at) and customer/
 *                             equipment field fills.
 * Any answer-changing write not covered by one of these four is a real gap;
 * see scripts/verify-ask-cache.mjs's "stamp composition" tests for the list
 * this was checked against on 2026-09-20 (extraction writes, verify/
 * unverify, field correction, delete, merge, assignDocumentCustomer).
 * `delete` needs no explicit column — a deleted document's row is simply
 * gone, which count() already reflects.
 */
import { logOnce } from "./rateLimit.js";
import { createHash } from "node:crypto";
import { SYSTEM_PROMPT, ANSWER_TOOL } from "./answer.js";

/** Any change to the prompt, the tool schema, or the model invalidates every
 *  cached answer: a cached "no-answer" from an older prompt outlived the fix
 *  that would have answered it (2026-09-20). Mixed into corpus_stamp. */
export const PROMPT_VERSION = createHash("sha256")
  .update(String(process.env.ASK_MODEL || "claude-haiku-4-5"))
  .update(SYSTEM_PROMPT)
  .update(JSON.stringify(ANSWER_TOOL))
  .digest("hex")
  .slice(0, 12);

/** Pure: the stamp compared/stored is the DB stamp plus the prompt version. */
export function withPromptVersion(dbStamp, promptVersion = PROMPT_VERSION) {
  return dbStamp == null ? null : `${dbStamp}:${promptVersion}`;
}

export const ASK_CACHE_ENABLED = process.env.ASK_CACHE !== "0";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

const STAMP_EXPR = `md5(concat_ws('|',
  (SELECT count(*)::text || ':' || count(*) FILTER (WHERE stage = 'verified')::text || ':' || coalesce(max(updated_at)::text,'') FROM documents WHERE ${TENANT_SQL}),
  (SELECT count(*)::text || ':' || coalesce(max(coalesce(corrected_at, created_at))::text,'') FROM extractions WHERE ${TENANT_SQL}),
  (SELECT count(*)::text || ':' || coalesce(max(created_at)::text,'') FROM document_entity_links WHERE ${TENANT_SQL}),
  (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text,'') FROM entities WHERE ${TENANT_SQL})
))`;

const STAMP_ONLY_SQL = `SELECT ${STAMP_EXPR} AS corpus_stamp`;

// LEFT JOIN off a dummy single-row source: `corpus_stamp` must come back even
// when no cache row matches (a real miss), not just when one does.
const COMBINED_SQL = `
  SELECT ${STAMP_EXPR} AS corpus_stamp, c.corpus_stamp AS cached_stamp, c.answer, c.created_at
    FROM (SELECT 1) AS dummy
    LEFT JOIN ask_answer_cache c
      ON c.question_hash = $1 AND c.today = $2::date AND c.${TENANT_SQL}`;

// Per-warm-instance memoized "does the table exist yet" flag (same idiom as
// rateLimit.js's `lastLogged` map). null = unknown (probe with a SAVEPOINT so
// a missing table can't poison the caller's shared retrieval transaction);
// true/false = known, skip the SAVEPOINT round trip from then on. Reset only
// by a fresh cold start — a false-positive "known missing" would self-heal
// on the next cold start after the owner applies the migration, at worst a
// few extra minutes of no caching, never a wrong answer.
let tableExists = null;

/** Exported for scripts/verify-ask-cache.mjs to reset between test cases. */
export function _resetTableExistsForTests() {
  tableExists = null;
}

/**
 * One round trip in steady state: fetches the tenant's current corpus_stamp
 * and, if present and matching (tenant, question_hash, today), the cached
 * row alongside it. `db` is a recordsStore.js store (has `.raw`), called
 * from INSIDE api/ask.js's retrieval `withTenant` transaction.
 *
 * `promptVersion` defaults to this file's own PROMPT_VERSION (the
 * retrieval+model path's fingerprint) so every existing caller is unchanged.
 * A caller with its own prompt/schema — api/_lib/routes/analytics.js passes
 * `ANALYTICS_PROMPT_VERSION` — passes it explicitly, so its cache rows react
 * to ITS OWN prompt/schema changing, not retrieval's (2026-09-21 reviewer
 * fix, handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md: analytics answers used to
 * mix in retrieval's prompt version even though they share nothing with it).
 *
 * @returns {Promise<{corpusStamp: string|null, row: {cached_stamp: string, answer: any, created_at: Date}|null}>}
 */
export async function getCacheEntry(db, { questionHash, today, promptVersion = PROMPT_VERSION }) {
  if (!ASK_CACHE_ENABLED) return { corpusStamp: null, row: null };

  if (tableExists === false) {
    const { rows } = await db.raw(STAMP_ONLY_SQL, []);
    return { corpusStamp: withPromptVersion(rows[0].corpus_stamp, promptVersion), row: null };
  }

  const run = async () => {
    const { rows } = await db.raw(COMBINED_SQL, [questionHash, today]);
    const row = rows[0];
    return { corpusStamp: withPromptVersion(row.corpus_stamp, promptVersion), row: row.cached_stamp != null ? row : null };
  };

  if (tableExists === true) return run();

  // Unknown: the table may not exist yet (deploy landed before the owner
  // pasted the migration). A SAVEPOINT confines that failure to itself, so
  // the shared retrieval transaction can keep going with the rest of its
  // real queries instead of aborting on "relation does not exist".
  try {
    await db.raw("SAVEPOINT ask_cache_probe", []);
    const result = await run();
    tableExists = true;
    return result;
  } catch (err) {
    if (err?.code === "42P01") {
      await db.raw("ROLLBACK TO SAVEPOINT ask_cache_probe", []).catch(() => {});
      tableExists = false;
      logOnce("ask_answer_cache", err);
      const { rows } = await db.raw(STAMP_ONLY_SQL, []);
      return { corpusStamp: withPromptVersion(rows[0].corpus_stamp, promptVersion), row: null };
    }
    throw err;
  }
}

/**
 * Pure: does `row` (from getCacheEntry) still apply? `today` equality is
 * already enforced by COMBINED_SQL's WHERE clause (a mismatch just means no
 * row came back), so this only checks the stamp and the 24h TTL — both
 * cheap to get wrong, so both are exercised with no database in
 * scripts/verify-ask-cache.mjs.
 */
export function isCacheHit(row, corpusStamp, nowMs = Date.now()) {
  if (!row || row.cached_stamp == null || corpusStamp == null) return false;
  if (row.cached_stamp !== corpusStamp) return false;
  const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs < CACHE_TTL_MS;
}

/**
 * Pure: should this answer be written to the cache at all? Documents may
 * still be processing — an honest "nothing yet" built from zero evidence
 * must not get pinned in the cache and outlive the ingest that would have
 * answered it. Everything else (including a model "no-answer" reached WITH
 * real evidence in hand) is cacheable.
 */
export function shouldCache(kind, passageCount, extractionCount) {
  // Never pin a no-answer (2026-09-20): whether from zero evidence or from a
  // model that declined, it is the answer most likely to be wrong or
  // transient, and a wrong "nothing found" is worse than one more model call.
  if (kind === "no-answer") return false;
  void passageCount; void extractionCount;
  return true;
}

/**
 * Upsert the answer for (tenant, question_hash). Runs in its OWN withTenant
 * transaction (called from api/ask.js's post-response bookkeeping, after the
 * retrieval transaction that computed corpusStamp has already committed).
 * Silently no-ops if the table still doesn't exist — same graceful-miss
 * contract as getCacheEntry, logged at most once per 10 minutes.
 */
export async function upsertCacheEntry(db, { questionHash, corpusStamp, today, answer }) {
  if (!ASK_CACHE_ENABLED || tableExists === false) return;
  try {
    await db.raw(
      `INSERT INTO ask_answer_cache (tenant_id, question_hash, corpus_stamp, today, answer, created_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3::date, $4::jsonb, NOW())
       ON CONFLICT (tenant_id, question_hash) DO UPDATE
         SET corpus_stamp = EXCLUDED.corpus_stamp,
             today        = EXCLUDED.today,
             answer       = EXCLUDED.answer,
             created_at   = NOW()`,
      [questionHash, corpusStamp, today, JSON.stringify(answer)]
    );
    tableExists = true;
  } catch (err) {
    if (err?.code === "42P01") {
      tableExists = false;
      logOnce("ask_answer_cache", err);
      return;
    }
    throw err;
  }
}
