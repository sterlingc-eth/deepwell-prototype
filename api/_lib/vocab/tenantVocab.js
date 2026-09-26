/**
 * vocab/tenantVocab.js — Round 11, item 2 (literature #6 schema-linking / #7 tenant vocabulary).
 *
 * Every deterministic router in this codebase (compose.js, relations/questions.js, deterministicRouter.js)
 * already knows the CLOSED, generic vocabulary a question can use: brand names (warrantyRules.js's
 * BRAND_RULES, widened per industry pack — nlNormalize.js's tablesForPack), document-type phrases (the
 * tenant's own industry pack), and street names (streetVocab.js, built from this tenant's own customer
 * addresses). What none of them build is a glossary of this tenant's own PROPER NOUNS that appear nowhere
 * in any generic list at all — technician names ("Danny Ochoa") and customer names ("Marisol Vega") — so a
 * misspelled one ("Denny Ochoa's jobs", "Vaga's jobs") had no vocabulary to fuzzy-correct back to, the exact
 * gap streetVocab.js already closed for street names. This module is that glossary for the other two:
 *
 *   getTenantVocab(db, tenantKey, pack)  -> the cached {technicians, customers, brands, docTypePhrases,
 *                                            cities} glossary for the calling tenant, rebuilt only when
 *                                            this tenant's own DATA has actually changed (see
 *                                            computeDataVersion below) — never a blind time-based guess.
 *   correctTenantNameTypos(question, vocab)  -> pure: fixes a misspelled technician/customer name
 *                                            immediately before "'s jobs/units/customers/visits" or right
 *                                            after "did"/"is"/"was" naming a person, the same
 *                                            edit-distance-<=1, unambiguous-winner-only rule
 *                                            streetVocab.js's correctStreetTypos already uses — conservative
 *                                            by construction: a token already spelled correctly (a real
 *                                            word, or already an exact name this tenant has on file) is
 *                                            never touched, and a token equidistant from two different
 *                                            names is left alone rather than guessed at.
 *   schemaLinkedVocabLines(question, vocab)  -> a short, question-relevant subset of this tenant's own
 *                                            brand/document-type/city vocabulary, formatted as extra
 *                                            system-prompt lines (see analytics.js's buildAnalyticsSystemPrompt)
 *                                            — "schema linking": grounding the planner in what THIS tenant's
 *                                            data actually contains instead of a generic vocabulary list.
 *
 * No model call anywhere in this file — every read is a bounded, tenant-scoped SQL query (recordsStore.js's
 * withTenant convention, same as every other router in this codebase), and every correction is pure JS
 * string/edit-distance math over the glossary already fetched.
 */
import { TENANT_SQL } from '../scope.js';
import { deriveGeo } from '../analytics.js';
import { withinEditDistance1, VOCAB } from '../nlNormalize.js';

const VOCAB_SCAN_LIMIT = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000; // backstop only — the data-version key is what really invalidates this

// tenantKey -> {version, vocab, expiresAt} — same in-process, per-tenant cache idiom as streetVocab.js /
// industry/index.js's packForTenant, keyed so one tenant's names can never leak into another's lookup.
const cacheByTenant = new Map();

/**
 * A cheap, tenant-scoped fingerprint of "the data this glossary is built from" — customers, technician
 * extractions and equipment brands/models. Recomputing this is one small aggregate query; recomputing the
 * WHOLE glossary (a handful of DISTINCT scans) only happens when this string actually changes, or the
 * CACHE_TTL_MS backstop expires (belt-and-suspenders, matching every other TTL cache in this codebase, in
 * case a write path this fingerprint doesn't cover ever changes the underlying rows).
 */
export async function computeDataVersion(db) {
  const { rows } = await db.raw(
    `SELECT
        (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM entities
          WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}) AS c,
        (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM entities
          WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}) AS e,
        (SELECT count(*)::text || ':' || coalesce(max(created_at)::text, '') FROM extractions
          WHERE field_key = 'technician' AND ${TENANT_SQL}) AS t`,
    []
  );
  const r = rows[0] ?? {};
  return `${r.c ?? ''}|${r.e ?? ''}|${r.t ?? ''}`;
}

/** Every distinct, trimmed value for one jsonb text field across a tenant's own entities of one type. */
async function distinctEntityValues(db, entityType, field, limit = VOCAB_SCAN_LIMIT) {
  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'${field}' AS v FROM entities
      WHERE entity_type = $1 AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'${field}' IS NOT NULL
      LIMIT ${Number(limit) || VOCAB_SCAN_LIMIT}`,
    [entityType]
  );
  return rows.map((r) => String(r.v ?? '').trim()).filter(Boolean);
}

/** Every distinct technician name ever extracted for this tenant. */
async function distinctTechnicians(db, limit = VOCAB_SCAN_LIMIT) {
  const { rows } = await db.raw(
    `SELECT DISTINCT COALESCE(NULLIF(corrected_value, ''), value) AS v FROM extractions
      WHERE field_key = 'technician' AND ${TENANT_SQL} AND coalesce(value, '') <> ''
      LIMIT ${Number(limit) || VOCAB_SCAN_LIMIT}`,
    []
  );
  return rows.map((r) => String(r.v ?? '').trim()).filter(Boolean);
}

/** {id, name}[] for building name -> customer resolution (never guessed, only fuzzy-CORRECTED text). */
async function distinctCustomerNames(db, limit = VOCAB_SCAN_LIMIT) {
  const { rows } = await db.raw(
    `SELECT DISTINCT data->>'customer_name' AS v FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'customer_name' IS NOT NULL
      LIMIT ${Number(limit) || VOCAB_SCAN_LIMIT}`,
    []
  );
  return rows.map((r) => String(r.v ?? '').trim()).filter(Boolean);
}

/** Pure: builds the {tokens, phrases} shape a name glossary needs from a list of full names — every
 *  whole name (for exact/near-exact phrase matching) plus its individual words of >=3 letters (for
 *  correcting one misspelled word inside an otherwise-fine name). Exported for scripts/verify-vocab.mjs
 *  to exercise with no database. */
export function buildNameGlossary(fullNames) {
  const phrases = new Set();
  const words = new Set();
  for (const name of fullNames ?? []) {
    const clean = String(name ?? '').trim();
    if (!clean) continue;
    phrases.add(clean);
    for (const w of clean.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (w.length >= 3) words.add(w);
    }
  }
  return { phrases: [...phrases], words };
}

/**
 * Pure: the tenant's own brand/model VALUES actually present in equipment data (not the generic pack
 * list — the values this tenant's corpus really has), for schema-linking (only surface what's actually
 * on file for THIS tenant, not the full generic enum).
 */
function dedupCi(values) {
  const seen = new Map();
  for (const v of values ?? []) {
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()];
}

/**
 * Builds the full glossary for the calling tenant, no caching — see getTenantVocab for the cached,
 * data-version-keyed entry point every caller should actually use.
 */
export async function buildTenantVocab(db, pack) {
  const [brandsRaw, modelsRaw, technicians, customerNames, addresses] = await Promise.all([
    distinctEntityValues(db, 'equipment', 'manufacturer'),
    distinctEntityValues(db, 'equipment', 'model'),
    distinctTechnicians(db),
    distinctCustomerNames(db),
    distinctEntityValues(db, 'customer', 'service_address'),
  ]);
  const cities = dedupCi(addresses.map((a) => deriveGeo(a).city).filter(Boolean));
  const docTypePhrases = (pack?.documentTypes ?? [])
    .map((t) => ({ id: t.id, phrase: String(t.label ?? t.id).toLowerCase().trim() }))
    .filter((t) => t.phrase);
  return {
    brands: dedupCi(brandsRaw),
    models: dedupCi(modelsRaw),
    cities,
    docTypePhrases,
    technicians: buildNameGlossary(technicians),
    customers: buildNameGlossary(customerNames),
  };
}

/**
 * Cached, data-version-keyed tenant glossary. `pack` (the tenant's industry pack — see
 * industry/index.js's packForTenant) only affects docTypePhrases; passing a different pack object for the
 * same tenant does not by itself bust the cache (docTypePhrases only ever varies with the tenant's OWN
 * industry setting, which computeDataVersion doesn't need to track separately — an industry change is
 * vanishingly rare and the CACHE_TTL_MS backstop still bounds how stale that edge case can ever get).
 */
export async function getTenantVocab(db, tenantKey, pack) {
  const now = Date.now();
  const cached = cacheByTenant.get(tenantKey);
  let version = null;
  try {
    version = await computeDataVersion(db);
  } catch {
    version = null; // a probe failure never blocks the caller — fall back to whatever's cached (or rebuild)
  }
  if (cached && cached.expiresAt > now && (version === null || cached.version === version)) return cached.vocab;
  const vocab = await buildTenantVocab(db, pack);
  cacheByTenant.set(tenantKey, { version, vocab, expiresAt: now + CACHE_TTL_MS });
  return vocab;
}

/** Test-only: drop every cached tenant glossary. */
export function resetTenantVocabCacheForTests() {
  cacheByTenant.clear();
}

/* ============================================================ pure correction */

/** byLen index over a name glossary's individual words, built once per call (glossaries are small — a
 *  few hundred words at most — so this is cheap even uncached). */
function wordsByLen(words) {
  const byLen = new Map();
  for (const w of words) {
    if (w.length < 3) continue;
    if (!byLen.has(w.length)) byLen.set(w.length, []);
    byLen.get(w.length).push(w);
  }
  return byLen;
}

/** The single unambiguous fix for `lower` against `byLen`, or null (no match, or more than one — never
 *  guessed between two different names). */
function singleFix(lower, byLen) {
  let match = null;
  for (const len of [lower.length - 1, lower.length, lower.length + 1]) {
    for (const cand of byLen.get(len) ?? []) {
      if (!withinEditDistance1(lower, cand)) continue;
      if (match && match !== cand) return null; // ambiguous — leave the word alone
      match = cand;
    }
  }
  return match;
}

// "<Name>'s jobs/units/customers/visits/equipment/warranty" (possessive), or "did/was/is <Name>" (a
// person named right after one of this router chain's own question-starter verbs) — the same two shapes
// the R11 brief's own "Vega's jobs" example and every technician-name question in this codebase already
// use (relations/questions.js's own NAME_RE). Scanning is restricted to these shapes for the same reason
// streetVocab.js restricts correction to the address span: a general word list has no business rewriting
// an unrelated word that merely happens to be one edit from a name.
const POSSESSIVE_NAME_RE = /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})'s\b/g;
const VERB_NAME_RE = /\b(?:did|is|was|has|had)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Za-z.'-]*){0,2})\b/g;

/** One name phrase corrected against a glossary's exact phrases first (case-insensitive), then word by
 *  word against its individual tokens — never touching a word that's already a real word (nlNormalize's
 *  own VOCAB) or already exactly on file. */
function correctNamePhrase(phrase, glossary) {
  const exact = glossary.phrases.find((p) => p.toLowerCase() === phrase.toLowerCase());
  if (exact) return exact === phrase ? null : exact;
  const byLen = wordsByLen(glossary.words);
  let changed = false;
  const fixedWords = phrase.split(/\s+/).map((w) => {
    const lower = w.toLowerCase();
    if (lower.length < 3 || VOCAB.has(lower) || glossary.words.has(lower)) return w;
    const fix = singleFix(lower, byLen);
    if (!fix) return w;
    changed = true;
    return w[0] === w[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
  });
  return changed ? fixedWords.join(' ') : null;
}

/**
 * Pure: corrects a misspelled technician or customer name in `question`, restricted to a possessive
 * ("Vaga's jobs" -> "Vega's jobs") or question-starter-verb ("did Denny Ochoa have..." -> "did Danny
 * Ochoa have...") phrase — never a bare capitalized word anywhere else in the text, and never a name
 * ambiguous between two different people on file. Tries technicians first, then customers (a name that
 * matches neither glossary exactly or fuzzily passes through unchanged). Returns
 * {corrected, corrections: [{from, to, category}]}.
 */
export function correctTenantNameTypos(question, vocab) {
  const q = String(question ?? '');
  if (!vocab || (!vocab.technicians?.phrases?.length && !vocab.customers?.phrases?.length)) {
    return { corrected: q, corrections: [] };
  }
  const corrections = [];
  const spans = [];
  for (const re of [POSSESSIVE_NAME_RE, VERB_NAME_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(q))) {
      spans.push({ start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length, phrase: m[1] });
    }
  }
  if (!spans.length) return { corrected: q, corrections: [] };
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // overlapping match from the second regex — first one wins
    const fixTech = vocab.technicians?.phrases?.length ? correctNamePhrase(span.phrase, vocab.technicians) : null;
    const fixCust = !fixTech && vocab.customers?.phrases?.length ? correctNamePhrase(span.phrase, vocab.customers) : null;
    const fix = fixTech ?? fixCust;
    out += q.slice(cursor, span.start);
    if (fix) {
      out += fix;
      corrections.push({ from: span.phrase, to: fix, category: fixTech ? 'technician' : 'customer' });
    } else {
      out += span.phrase;
    }
    cursor = span.end;
  }
  out += q.slice(cursor);
  return { corrected: out, corrections };
}

/* ============================================================ schema linking */

/**
 * A short, question-relevant subset of this tenant's own vocabulary, as extra system-prompt lines for the
 * analytics planner (analytics.js's buildAnalyticsSystemPrompt) — literature #6's "schema linking": ground
 * the planner in what THIS tenant's data actually contains instead of the generic brand/doc-type list
 * every tenant's prompt otherwise shares. ADDITIVE only (never removes a valid closed-vocabulary choice
 * from the tool schema itself) — a tenant with no matching brand/doc-type/city for this question gets no
 * extra line at all, never a wrong or empty one. Capped small so this can never meaningfully grow the
 * prompt's token cost.
 */
export function schemaLinkedVocabLines(question, vocab) {
  if (!vocab) return null;
  const q = String(question ?? '').toLowerCase();
  const lines = [];
  const brandHits = (vocab.brands ?? []).filter((b) => q.includes(b.toLowerCase())).slice(0, 6);
  if (brandHits.length) lines.push(`This tenant's own brands on file (use these exact names): ${brandHits.join(', ')}.`);
  const docHits = (vocab.docTypePhrases ?? []).filter((t) => q.includes(t.phrase)).slice(0, 6);
  if (docHits.length) lines.push(`This tenant's own document types matching the question: ${docHits.map((t) => t.phrase).join(', ')}.`);
  const cityHits = (vocab.cities ?? []).filter((c) => q.includes(c.toLowerCase())).slice(0, 6);
  if (cityHits.length) lines.push(`This tenant's own cities on file matching the question: ${cityHits.join(', ')}.`);
  return lines.length ? lines.join(' ') : null;
}
