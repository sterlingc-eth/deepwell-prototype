/**
 * Tenant-scoped street-name fuzzy correction (live miss cluster 4, 2026-09-21
 * 270-question sample): "when was the unit at 766 n val ivsta dr, tucson
 * installed" / "what's the serial number of the unit at 248 w huard rd" /
 * "model number of the unit at 174 n collehe av" all came back with no
 * answer — the address SHAPE was recognized fine (fastPath.js's own
 * ADDRESS_RE needs only a number + words + a street-suffix word), but the
 * typo'd street NAME never matched any real address token during DB
 * resolution, so both fastPath and the retrieval fallback came up empty.
 *
 * nlNormalize.js's own fuzzy-typo correction deliberately SKIPS every word of
 * a single-record-reference question (see that file's `singleRecord` guard)
 * — a general, tenant-agnostic word list has no business rewriting an
 * address's own words; a real but rare street name looks exactly like a typo
 * to it. What CAN safely correct a street-name typo is the tenant's OWN
 * street vocabulary: the actual street-name tokens already sitting in this
 * tenant's own customer addresses. A token one edit away from a real word in
 * THAT list is a typo of a street this business actually has, not a guess.
 *
 * Wired into api/ask.js after normalizeQuestion, only for a question
 * looksLikeSingleRecordReference already flags (analytics.js) — a plain
 * aggregate/analytics question has no address to correct in the first place,
 * so this never costs anything on that path.
 */
import { VOCAB } from "./nlNormalize.js";
import { STREET_ADDRESS_RE, AT_ADDRESS_RE } from "./analytics.js";

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const VOCAB_SCAN_LIMIT = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Module-level, per-tenant cache — same "cheap in-process cache, no new
// infra" idiom askCache.js/promptCache.js already use elsewhere in this
// codebase. Keyed by the same tenantKey withTenant() itself is called with,
// so this can never leak one tenant's street names into another's lookup.
const cacheByTenant = new Map();

/** Every distinct alphabetic token >= 5 letters found in this tenant's own
 *  customers.service_address text — the closed, tenant-specific vocabulary a
 *  street-name typo can be corrected back to. Pure JS work over a small,
 *  LIMIT-capped row set, so this never scales with corpus size beyond that
 *  cap. Exported for scripts/verify-analytics.mjs to exercise with no
 *  database. */
export function extractStreetTokens(addresses) {
  const words = new Set();
  for (const addr of addresses ?? []) {
    for (const w of String(addr ?? "").toLowerCase().match(/[a-z]+/g) ?? []) {
      if (w.length >= 5) words.add(w);
    }
  }
  return words;
}

/**
 * Tenant-scoped street vocabulary, cached in-process for CACHE_TTL_MS. `db`
 * is a recordsStore.js store (has `.raw`), called from inside a withTenant
 * transaction, the same convention every other tenant-scoped read in this
 * codebase already follows.
 */
export async function getStreetVocab(db, tenantKey) {
  const now = Date.now();
  const cached = cacheByTenant.get(tenantKey);
  if (cached && cached.expiresAt > now) return cached.vocab;

  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'service_address' AS service_address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'service_address' IS NOT NULL
      LIMIT ${VOCAB_SCAN_LIMIT}`,
    []
  );
  const vocab = extractStreetTokens(rows.map((r) => r.service_address));
  cacheByTenant.set(tenantKey, { vocab, expiresAt: now + CACHE_TTL_MS });
  return vocab;
}

/** Test-only: drop every cached tenant vocabulary so a unit test that seeds
 *  its own fake db/tenant key isn't fighting a previous test's cache entry. */
export function clearStreetVocabCache() {
  cacheByTenant.clear();
}

/* ============================================================ pure correction */

/** True when `a`/`b` are the same word, one substitution/transposition apart
 *  (equal length), or one insertion/deletion apart (length differs by 1) —
 *  Damerau-Levenshtein distance <= 1. Duplicated from nlNormalize.js's own
 *  (unexported) withinEditDistance1 rather than adding a cross-file
 *  dependency for six lines of pure string math — same idiom that file's own
 *  header comment already establishes for this codebase. */
function withinEditDistance1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffCount = 0;
    let i1 = -1;
    let i2 = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        if (diffCount === 1) i1 = i;
        else if (diffCount === 2) i2 = i;
        else return false;
      }
    }
    if (diffCount <= 1) return true;
    return i2 === i1 + 1 && a[i1] === b[i2] && a[i2] === b[i1];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let usedSkip = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

/**
 * Pure: correct every token in `question` that is (a) alphabetic, (b) >= 5
 * letters, (c) NOT already in the global vocabulary (nlNormalize.js's own
 * VOCAB — a word real English/HVAC/geo terms already cover needs no
 * "correction"), (d) NOT already a token in this tenant's own street
 * vocabulary (already correct, nothing to fix), and (e) within
 * Damerau-Levenshtein <= 1 of some word that IS in the tenant's street
 * vocabulary. Everything else — digits, short words, punctuation, a token
 * with no close match — passes through unchanged. Returns the corrected
 * text plus the list of corrections actually made, for logging (never for
 * silently trusting a bad match: this file's own caller in api/ask.js logs
 * every correction it makes).
 */
// Reviewer NO-GO (2026-09-21, round 5, item 3): the old version ran its
// per-word replace across the WHOLE question, so a trailing, unrelated word
// that happened to be one edit away from a tenant street token (e.g.
// "Chander" in "...ask for Chander in accounting") got silently rewritten
// too. A typo correction is only trustworthy for tokens that are actually
// part of the address itself, so correction is now restricted to the
// address span located by STREET_ADDRESS_RE/AT_ADDRESS_RE (the same regexes
// analytics.js uses to detect a single-record address reference), extended
// through one optional trailing comma-separated city segment.
const ADDRESS_WORD_RUN_RE = /^(\d{1,6}(?:\s+[A-Za-z]+){1,4})/;
const TRAILING_CITY_RE = /^(\s*,\s*[A-Za-z]+(?:\s+[A-Za-z]+)?)/;

/** Pure: locate the {start, end} character span of `q` that is the address
 *  itself, or null when the question has no address token at all. Exported
 *  for scripts/verify-analytics.mjs to exercise directly with no database. */
export function findAddressSpan(q) {
  const strMatch = STREET_ADDRESS_RE.exec(q);
  let start;
  let end;
  if (strMatch) {
    start = strMatch.index;
    end = start + strMatch[0].length;
  } else {
    const atMatch = AT_ADDRESS_RE.exec(q);
    if (!atMatch) return null;
    const digitOffset = atMatch[0].search(/\d/);
    start = atMatch.index + digitOffset;
    const runMatch = ADDRESS_WORD_RUN_RE.exec(q.slice(start));
    end = runMatch ? start + runMatch[0].length : atMatch.index + atMatch[0].length;
  }

  const trailing = TRAILING_CITY_RE.exec(q.slice(end));
  if (trailing) end += trailing[0].length;

  return { start, end };
}

export function correctStreetTypos(question, streetVocab) {
  const q = String(question ?? "");
  if (!streetVocab || streetVocab.size === 0) return { corrected: q, corrections: [] };

  const span = findAddressSpan(q);
  if (!span) return { corrected: q, corrections: [] };

  const byLen = new Map();
  for (const w of streetVocab) {
    if (w.length < 4) continue;
    if (!byLen.has(w.length)) byLen.set(w.length, []);
    byLen.get(w.length).push(w);
  }

  const corrections = [];
  const before = q.slice(0, span.start);
  const inside = q.slice(span.start, span.end);
  const after = q.slice(span.end);

  const correctedInside = inside.replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    if (lower.length < 5) return word;
    if (VOCAB.has(lower)) return word; // a recognized general/HVAC/geo word — not this file's job
    if (streetVocab.has(lower)) return word; // already a real street token for this tenant

    for (const len of [lower.length - 1, lower.length, lower.length + 1]) {
      const candidates = byLen.get(len);
      if (!candidates) continue;
      for (const cand of candidates) {
        if (withinEditDistance1(lower, cand)) {
          corrections.push({ from: lower, to: cand });
          return cand;
        }
      }
    }
    return word;
  });

  return { corrected: before + correctedInside + after, corrections };
}
