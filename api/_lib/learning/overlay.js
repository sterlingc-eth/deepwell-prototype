/**
 * Donovan self-learning loop, Tier 2 Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * the ACTIVE overlay — every learned abbreviation/typo/vocab word/synonym/
 * few-shot example an operator has approved (donovan_learned, M3-config/
 * 26-donovan-learning.sql) — loaded once per process and cached for 10
 * minutes, so an ordinary /api/ask request never pays a DB round trip for
 * this. The pure consumers (nlNormalize.js/analytics.js/contactLookup.js)
 * never read the DB or this cache themselves — they only ever see whatever
 * explicit `overlay` object a caller (this file in production,
 * scripts/verify-learning.mjs with a synthetic one in tests) hands them.
 *
 * Tolerant of the learning tables/functions not existing yet (migration 26
 * not applied): getActiveOverlay() returns an empty overlay on any error —
 * same missStore.js/missDigest.js "warn once, never throw" convention.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../recordsStore.js';

const CACHE_MS = 10 * 60 * 1000;
const EMPTY_OVERLAY = Object.freeze({ abbreviations: {}, typos: {}, vocab: [], synonyms: {}, fewShot: [] });

let cached = null; // { overlay, expiresAt }
let warnedMissing = false;

function warnOnce(err) {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    'learning: learning_list_active() failed (migration M3-config/26-donovan-learning.sql may not be applied yet):',
    err?.message
  );
}

/** donovan_learned rows -> the overlay shape nlNormalize.js/analytics.js
 *  expect. One row per learned item: {kind, key, value}. `capability_gap`
 *  rows never reach donovan_learned at all (learning_decide only inserts
 *  abbreviation/typo/synonym/few_shot — see M3-config/26) but an unknown
 *  kind here is still ignored defensively rather than throwing. */
function rowsToOverlay(rows) {
  const overlay = { abbreviations: {}, typos: {}, vocab: [], synonyms: {}, fewShot: [] };
  const vocabSet = new Set();
  for (const row of rows ?? []) {
    const value = row?.value;
    switch (row?.kind) {
      case 'abbreviation':
        if (value?.from && value?.to) overlay.abbreviations[value.from] = value.to;
        break;
      case 'typo':
        if (value?.from && value?.to) overlay.typos[value.from] = value.to;
        break;
      case 'synonym':
        if (value?.entity && value?.word) {
          if (!overlay.synonyms[value.entity]) overlay.synonyms[value.entity] = [];
          overlay.synonyms[value.entity].push(value.word);
          vocabSet.add(value.word);
        }
        break;
      case 'few_shot':
        if (value?.question && value?.plan) overlay.fewShot.push({ question: value.question, plan: value.plan });
        break;
      default:
        break;
    }
  }
  // Every learned synonym word is new vocabulary by definition (that's the
  // point of the synonym kind — see proposals.js) — folded into `vocab` too
  // so fuzzyCorrect (nlNormalize.js) never "corrects" it back OUT again.
  overlay.vocab = [...vocabSet];
  return overlay;
}

/**
 * The process-wide active overlay, cached CACHE_MS. Returns the SAME object
 * reference across calls within the cache window — nlNormalize.js/
 * analytics.js key their own per-overlay compiled-table caches off object
 * IDENTITY, so a stable reference is what makes that caching actually work
 * instead of recompiling every request.
 */
export async function getActiveOverlay() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.overlay;
  try {
    const { rows } = await getPool().query('SELECT * FROM learning_list_active()');
    const overlay = rowsToOverlay(rows);
    cached = { overlay, expiresAt: now + CACHE_MS };
    return overlay;
  } catch (err) {
    warnOnce(err);
    // Cache the empty result too (same TTL) so a missing migration costs at
    // most one DB attempt per 10-minute window, not one per request.
    cached = { overlay: EMPTY_OVERLAY, expiresAt: now + CACHE_MS };
    return EMPTY_OVERLAY;
  }
}

/** Test-only: drops the process cache so the next getActiveOverlay() call
 *  re-reads the DB. Never called by production code. */
export function resetActiveOverlayCacheForTests() {
  cached = null;
}

/**
 * A short, stable fingerprint of the active overlay's few-shot examples —
 * mixed into the analytics cache's promptVersion (api/_lib/routes/
 * analytics.js) so approving (or retiring) a few-shot example invalidates
 * every previously-cached plan instead of silently serving a stale one built
 * under the old prompt. An empty overlay hashes to a fixed constant (not an
 * empty string), so it's still visible as a distinct value in a cache-key
 * diff.
 */
export function overlayFewShotHash(overlay) {
  const items = Array.isArray(overlay?.fewShot) ? overlay.fewShot : [];
  if (!items.length) return 'no-fewshot';
  const canonical = items
    .map((ex) => `${ex.question}=>${JSON.stringify(ex.plan)}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
