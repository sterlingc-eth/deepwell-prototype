/**
 * Semantic answer cache for POST /api/ask (R11 literature #7), layered AFTER
 * the existing exact-match cache (api/_lib/askCache.js / ask_answer_cache,
 * migration 17): api/ask.js should try getCacheEntry/isCacheHit FIRST, and
 * only fall through to lookupSemantic() below on an exact miss — see "ASK.JS
 * HOOK" at the bottom of this file for the exact 6 lines.
 *
 * Table: M3-config/40-rollups-and-semantic-cache.sql (ask_semantic_cache).
 * Owner-applied; this file degrades to "always a miss" gracefully until
 * then, same tableExists-probe idiom as askCache.js/search/store.js.
 *
 * THE INVARIANT THIS WHOLE FILE PROTECTS: a semantic hit is reused only when
 * (a) tenant matches (RLS — every query here runs inside the caller's
 * withTenant transaction, so this is enforced by Postgres itself, not just
 * application code), (b) corpus_stamp matches exactly (same expression
 * askCache.js's STAMP_EXPR computes — passed in by the caller, not
 * recomputed here, so the two caches can never disagree about "is the data
 * stale"), (c) the row is under TTL, and (d) — the one semantic-specific
 * rule — the SLOT SIGNATURE extracted from the new question is IDENTICAL,
 * as a plain string, to the slot signature stored with the cached row.
 * "Trane units in Mesa" (slots: brand=trane, city=mesa) can never hit
 * "Trane units in Tempe" (brand=trane, city=tempe) — different slot
 * signatures — no matter how close the two questions' embeddings are.
 * Slot equality is checked BOTH in the SQL WHERE clause and again in JS on
 * the row that comes back (defense in depth — see isSlotMatch below), so
 * this invariant holds even if a future edit ever loosens the SQL side.
 *
 * TWO LOOKUP PATHS, in order:
 *   1. Embedding nearest-neighbour (cosine, pgvector) — only when Voyage is
 *      configured (search/embed.js's embedConfig().enabled) and embedQuery
 *      doesn't fail/breaker-open. Hit requires similarity >= minSimilarity
 *      (conservative default 0.93 — see MIN_SIMILARITY below) AND matching
 *      slots/corpus/tenant.
 *   2. Deterministic fallback signature (sorted, de-stopworded token bag) —
 *      ALWAYS computed, embeddings or not. Used as the sole lookup path when
 *      embeddings are unavailable, and as a second try when the embedding
 *      path finds nothing above threshold. This is what makes "count of
 *      Trane units in Mesa" hit a cached "Trane units in Mesa count" even
 *      with zero model/API calls.
 *
 * NOTHING HERE TOUCHES ask.js — that file belongs to E3 (ask.js's pre-router
 * chain). See "ASK.JS HOOK" below for the exact call shape it should make.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logOnce } from '../rateLimit.js';
import { embedConfig, embedQuery, toVectorLiteral } from '../search/embed.js';
import { BRAND_RULES } from '../warrantyRules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ============================================================== slot vocab */

/** Every brand key + alias from warrantyRules.js's own BRAND_RULES (the ONE
 *  brand table the rest of the app trusts — never a second, drifting list). */
const BRAND_TERMS = Object.freeze(
  Object.entries(BRAND_RULES).flatMap(([key, rule]) => [key, ...(rule.aliases ?? [])])
);

/** City vocabulary reused verbatim from the bundled geo table (same asset
 *  api/_lib/nlNormalize.js and analytics.js's deriveGeo already read) —
 *  never a second, hand-typed city list that could drift from it. Read
 *  defensively: an unreadable/missing file degrades to an empty city
 *  vocabulary (slot extraction just finds fewer city slots), never a crash. */
function loadCityTerms() {
  try {
    const zipCounty = JSON.parse(readFileSync(join(__dirname, '..', 'geo', 'zip-county.json'), 'utf8'));
    const cities = new Set();
    for (const k of Object.keys(zipCounty.azCityCounty ?? {})) cities.add(k);
    for (const k of Object.keys(zipCounty.usCityCounty ?? {})) cities.add(String(k).split('|')[0]);
    return [...cities];
  } catch {
    return [];
  }
}
const CITY_TERMS = Object.freeze(loadCityTerms());

// NOTE: 'not'/'no' are deliberately NOT stopwords — negation flips the answer
// to a factually different question ("is there a service agreement on file"
// vs "is there NO service agreement on file") and must never be discarded.
// See NEGATION_TERMS/findNegators below, which also gate the slot signature.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have',
  'has', 'had', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'any', 'about', 'very', 'for', 'with',
  'it', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'many', 'much',
  'we', 'our', 'us', 'you', 'your', 'i', 'me', 'my', 'their', 'them', 'there', 'here', 'so', 'as',
  'from', 'by', 'all', 'can', 'could', 'would', 'should', 'will', 'shall', 'please',
]);

/* ==================================================== negation / comparatives / question-type
 * A cached answer must never be served to a question that negates, bounds, or asks a different
 * SHAPE of question than the one it was cached for, even when the embedding similarity is high
 * ("is there a service agreement on file" vs "is there NO service agreement on file" are near-
 * identical vectors but opposite answers). All three below feed slotSignature (checked in the SQL
 * WHERE clause AND again in JS by isSlotMatch, for both the embedding and fallback lookup paths),
 * so a mismatch here can never be papered over by a close-enough embedding score. */

/** Literal negator words/phrases, plus a generic "<verb>n't" catch-all for any contraction not
 *  explicitly listed, plus un-prefixed status words ("unpaid", "unregistered", ...) common in this
 *  domain's yes/no questions. Deliberately broad: over-differentiating only costs a cache hit,
 *  never a wrong answer. */
const NEGATION_WORDS = [
  'not', 'no', 'never', 'without', 'none', 'except', 'excluding', 'besides', 'other than',
];
const NEGATION_CONTRACTION_RE = /\b[a-z]+n['’]t\b/gi; // isn't, aren't, doesn't, can't, won't, ...
const UN_STATUS_RE =
  /\bun(?:paid|registered|resolved|licensed|verified|installed|approved|assigned|completed|confirmed|finished|opened|scheduled|signed|filed)\b/gi;

function findNegators(qLower) {
  const found = new Set(findTerms(qLower, NEGATION_WORDS));
  for (const m of qLower.matchAll(NEGATION_CONTRACTION_RE)) found.add(m[0]);
  for (const m of qLower.matchAll(UN_STATUS_RE)) found.add(m[0]);
  return [...found].sort();
}

/** Comparative/quantifier words that change WHICH records answer the question ("more than 5" vs
 *  "fewer than 5", "before" vs "after" a date) — kept as its own slot so they can never wash out
 *  in an embedding's overall similarity score. */
const COMPARATIVE_TERMS = [
  'more', 'less', 'fewer', 'over', 'under', 'before', 'after', 'since', 'last', 'next', 'first',
  'top', 'at least', 'at most', 'oldest', 'newest', 'older', 'newer', 'earliest', 'latest',
];
function findComparatives(qLower) {
  return findTerms(qLower, COMPARATIVE_TERMS);
}

/** The question's SHAPE — "how many" and "which" want structurally different answers even about
 *  the exact same records, so a cached count must never be handed back for a list question (or
 *  vice versa). Checked in order, most specific first. */
function questionType(qLower) {
  if (/\b(how many|count of|number of|total count)\b/.test(qLower)) return 'how_many';
  if (/\bhow much\b/.test(qLower)) return 'how_much';
  if (/\bwhich\b/.test(qLower)) return 'which';
  if (/\b(list|show me)\b/.test(qLower)) return 'list';
  if (/\bwho\b/.test(qLower)) return 'who';
  if (/\bwhen\b/.test(qLower)) return 'when';
  if (/^\s*(is|are|was|were|do|does|did|has|have|had|can|could|will|would|should)\b/.test(qLower)) return 'yesno';
  return 'other';
}

/** Longest-terms-first so a multi-word brand ("american standard") wins over
 *  any single-word substring before shorter terms get a chance to match. */
function findTerms(qLower, terms) {
  const found = new Set();
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    if (!term) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(qLower)) found.add(term.toLowerCase());
  }
  return [...found].sort();
}

/** "581 W Thomas Rd" / "1420 N 7th St" — a street-number address fragment.
 *  Conservative on purpose: only a real digit-led address-shaped run counts
 *  as an address slot (a bare "60 days" or "2 units" is caught by the number
 *  slot instead, not here). */
const ADDRESS_RE = /\b\d{2,6}\s+(?:[nsew]\.?\s+)?[a-z][a-z']*(?:\s+[a-z][a-z']*){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|cir|circle|pkwy|parkway)\b/gi;

/** ISO / US-style dates and bare month names, so "in June" and "since 2024"
 *  are captured even without a day. */
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4})\b/gi;

/** Bare numbers NOT already consumed by an address match (a street number
 *  alone must not ALSO count as a separate, order-shuffled number slot). */
function findNumbers(qLower, addresses) {
  let stripped = qLower;
  for (const a of addresses) stripped = stripped.split(a).join(' ');
  const out = new Set();
  for (const m of stripped.matchAll(/\b\d+(?:\.\d+)?\b/g)) out.add(m[0]);
  return [...out].sort();
}

/**
 * Pure: entity names/numbers/dates/addresses/brands found in `question`, as
 * arrays of lowercase strings, PLUS proper-noun-like capitalized words from
 * the ORIGINAL (un-lowercased) text as a stand-in for customer/entity names
 * (brand/city/month words are excluded from that set — they already have
 * their own dedicated slot and would otherwise double-count).
 * @returns {{brands: string[], cities: string[], dates: string[], addresses: string[], numbers: string[], names: string[], negators: string[], comparatives: string[], qType: string}}
 */
export function extractSlots(question) {
  const raw = String(question ?? '');
  const qLower = raw.toLowerCase();
  const addresses = [...new Set((raw.match(ADDRESS_RE) ?? []).map((s) => s.toLowerCase().trim()))].sort();
  const dates = [...new Set((qLower.match(DATE_RE) ?? []))].sort();
  const brands = findTerms(qLower, BRAND_TERMS);
  const cities = findTerms(qLower, CITY_TERMS);
  const numbers = findNumbers(qLower, addresses);
  const negators = findNegators(qLower);
  const comparatives = findComparatives(qLower);
  const qType = questionType(qLower);
  const excludeWords = new Set([...brands, ...cities].flatMap((t) => t.split(/\s+/)));
  const names = [...new Set(
    (raw.match(/\b[A-Z][a-z]+(?:['’][A-Za-z]+)?\b/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => !STOPWORDS.has(w) && !excludeWords.has(w) && !dates.includes(w))
  )].sort();
  return { brands, cities, dates, addresses, numbers, names, negators, comparatives, qType };
}

/** Pure: a stable, order-independent string built from extractSlots' output.
 *  Two questions with the SAME real-world subject produce the same
 *  signature; two questions differing in even one slot value — including
 *  negation ("no service agreement" vs "a service agreement"), a comparative/
 *  quantifier bound (before/after, more/fewer, top N), or the question's
 *  shape (how many vs which vs yes/no) — produce a DIFFERENT one; this is the
 *  string compared for exact equality, never a fuzzy/partial match. */
export function slotSignature(question) {
  const s = extractSlots(question);
  return [
    `b:${s.brands.join(',')}`,
    `c:${s.cities.join(',')}`,
    `d:${s.dates.join(',')}`,
    `a:${s.addresses.join(',')}`,
    `n:${s.numbers.join(',')}`,
    `m:${s.names.join(',')}`,
    `g:${s.negators.join(',')}`,
    `k:${s.comparatives.join(',')}`,
    `q:${s.qType}`,
  ].join('|');
}

/** Pure: sorted, de-stopworded, de-duplicated token bag — order-independent,
 *  so "Trane units count in Mesa" and "count of Trane units in Mesa" match,
 *  but this is STILL just a coarser exact-match key, never a similarity
 *  search — used only when no embedding is available. Negators are folded in
 *  as their own canonical tokens (on top of surviving as ordinary words,
 *  since 'not'/'no' are no longer stopwords) so a stripped-apart contraction
 *  ("isn't" -> "isn"/"t" once punctuation is split on) still leaves a
 *  negation marker in the bag either way. */
export function fallbackSignature(question) {
  const qLower = String(question ?? '').toLowerCase();
  const tokens = qLower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const negTokens = findNegators(qLower).map((n) => `neg_${n.replace(/[^a-z0-9]+/g, '_')}`);
  return [...new Set([...tokens, ...negTokens])].sort().join(' ');
}

/** Conservative on purpose (literature #7: a semantic cache that's too eager
 *  is worse than no cache — a wrong reused answer is worse than one extra
 *  model call). Override with DONOVAN_SEMANTIC_CACHE_MIN_SIM for testing. */
export function minSimilarity(env = process.env) {
  const n = Number(env.DONOVAN_SEMANTIC_CACHE_MIN_SIM);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.93;
}

export const SEMANTIC_CACHE_ENABLED = process.env.SEMANTIC_ANSWER_CACHE !== '0';
export function semanticCacheTtlMs(env = process.env) {
  const n = Number(env.SEMANTIC_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000; // 24h, matches ask_answer_cache's TTL
}

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

let tableExists = null;
/** Exported for scripts/verify-semantic-cache.mjs to reset between cases. */
export function _resetSemanticCacheStateForTests() {
  tableExists = null;
}

async function probeTable(db) {
  if (tableExists !== null) return tableExists;
  try {
    await db.raw('SAVEPOINT ask_semantic_cache_probe', []);
    await db.raw('SELECT 1 FROM ask_semantic_cache LIMIT 0', []);
    tableExists = true;
  } catch (err) {
    if (err?.code === '42P01') {
      await db.raw('ROLLBACK TO SAVEPOINT ask_semantic_cache_probe', []).catch(() => {});
      tableExists = false;
      logOnce('ask_semantic_cache', err);
    } else {
      throw err;
    }
  }
  return tableExists;
}

/** Defense-in-depth re-check of the one invariant that must never break, on
 *  top of whatever the SQL WHERE clause already enforced. Pure. */
export function isSlotMatch(rowSlotSignature, questionSlotSignature) {
  return typeof rowSlotSignature === 'string' && rowSlotSignature === questionSlotSignature;
}

/** Pure: TTL check, same shape as askCache.js's isCacheHit. */
export function withinTtl(createdAt, ttlMs, nowMs = Date.now()) {
  const createdAtMs = createdAt ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs < ttlMs;
}

/**
 * @param {*} db - a recordsStore.js store (has `.raw`), called INSIDE the
 *   caller's withTenant transaction (same contract as askCache.getCacheEntry).
 * @param {{question: string, corpusStamp: string, today?: string, env?: object, now?: number}} args
 * @returns {Promise<{hit: false} | {hit: true, answer: any, via: 'embedding'|'fallback', similarity?: number}>}
 */
export async function lookupSemantic(db, { question, corpusStamp, env = process.env, now = Date.now() } = {}) {
  const miss = { hit: false };
  if (!SEMANTIC_CACHE_ENABLED || corpusStamp == null) return miss;
  if (!(await probeTable(db))) return miss;

  const slotSig = slotSignature(question);
  const fallbackSig = fallbackSignature(question);
  const ttlMs = semanticCacheTtlMs(env);
  const threshold = minSimilarity(env);

  // Path 1: embedding nearest-neighbour, only when Voyage is configured and
  // actually answers (embedQuery NEVER throws — null means "keyword/exact
  // path only for this request", exactly like search/hybrid.js treats it).
  const cfg = embedConfig(env);
  if (cfg.enabled) {
    const embedded = await embedQuery(question, cfg, { now });
    if (embedded?.vector) {
      const lit = toVectorLiteral(embedded.vector);
      const { rows } = await db.raw(
        `SELECT answer, slot_signature, created_at, 1 - (embedding <=> $1::vector) AS similarity
           FROM ask_semantic_cache
          WHERE ${TENANT_SQL} AND slot_signature = $2 AND corpus_stamp = $3 AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector ASC
          LIMIT 1`,
        [lit, slotSig, corpusStamp]
      );
      const row = rows[0];
      if (
        row &&
        Number(row.similarity) >= threshold &&
        isSlotMatch(row.slot_signature, slotSig) &&
        withinTtl(row.created_at, ttlMs, now)
      ) {
        return { hit: true, answer: row.answer, via: 'embedding', similarity: Number(row.similarity) };
      }
    }
  }

  // Path 2: deterministic fallback signature — always tried (embeddings on
  // or off), since it costs nothing and catches reordered phrasing the exact-
  // match cache's hash (word-order-sensitive) would otherwise miss.
  const { rows } = await db.raw(
    `SELECT answer, slot_signature, created_at
       FROM ask_semantic_cache
      WHERE ${TENANT_SQL} AND slot_signature = $1 AND corpus_stamp = $2 AND fallback_signature = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [slotSig, corpusStamp, fallbackSig]
  );
  const row = rows[0];
  if (row && isSlotMatch(row.slot_signature, slotSig) && withinTtl(row.created_at, ttlMs, now)) {
    return { hit: true, answer: row.answer, via: 'fallback' };
  }
  return miss;
}

/**
 * Stores one answer. Runs in its own withTenant transaction (same contract
 * as askCache.upsertCacheEntry), called AFTER a real model/analytics answer
 * — never for a cache hit itself (nothing new to learn from a hit) and never
 * for a "no-answer" (same shouldCache('no-answer') rule askCache.js already
 * enforces for the exact-match cache — a wrong "nothing found" must not
 * outlive the ingest that would have answered it; callers should skip this
 * call entirely under that condition rather than this file re-deciding it).
 *
 * Silently no-ops if the table doesn't exist yet. Best-effort prunes this
 * tenant's own expired rows ~5% of the time (bounded cost, no separate cron
 * needed for a table nothing else depends on being small).
 */
export async function storeSemantic(db, { question, corpusStamp, answer, env = process.env, now = Date.now() } = {}) {
  if (!SEMANTIC_CACHE_ENABLED || corpusStamp == null) return;
  if (!(await probeTable(db))) return;

  const slotSig = slotSignature(question);
  const fallbackSig = fallbackSignature(question);
  const cfg = embedConfig(env);
  let vectorLit = null;
  let embedModel = null;
  if (cfg.enabled) {
    const embedded = await embedQuery(question, cfg, { now }).catch(() => null);
    if (embedded?.vector) {
      vectorLit = toVectorLiteral(embedded.vector);
      embedModel = cfg.model;
    }
  }

  await db.raw(
    `INSERT INTO ask_semantic_cache
       (tenant_id, corpus_stamp, slot_signature, fallback_signature, embedding, embed_model, question_norm, answer, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4::vector, $5, $6, $7::jsonb, NOW())`,
    [corpusStamp, slotSig, fallbackSig, vectorLit, embedModel, String(question ?? '').slice(0, 500), JSON.stringify(answer)]
  );

  if (Math.random() < 0.05) {
    const ttlMs = semanticCacheTtlMs(env);
    await db
      .raw(`DELETE FROM ask_semantic_cache WHERE ${TENANT_SQL} AND created_at < $1`, [new Date(now - ttlMs)])
      .catch(() => {});
  }
}

/* ============================================================== ASK.JS HOOK
 *
 * api/ask.js (owned by E3) should call this AFTER askCache.getCacheEntry/
 * isCacheHit report an exact miss, using the SAME corpusStamp that call
 * already computed (never recomputed here — one stamp, shared by both
 * caches):
 *
 *   import { lookupSemantic, storeSemantic } from './_lib/cache/semanticCache.js';
 *   ...
 *   if (!exactHit) {
 *     const semantic = await lookupSemantic(db, { question, corpusStamp });
 *     if (semantic.hit) return respondFromCache(semantic.answer, { source: 'semantic-cache', via: semantic.via });
 *   }
 *   ... (fall through to retrieval/model as today) ...
 *   // after a real answer is computed and askCache.upsertCacheEntry runs
 *   // (same shouldCache('no-answer') guard already used there):
 *   if (shouldCache(answerKind, passageCount, extractionCount)) {
 *     await storeSemantic(db2, { question, corpusStamp, answer });
 *   }
 */
