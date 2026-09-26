/**
 * Entity-resolution clustering — pure name/contact/address matching (Round 11,
 * M3-config/39-entity-resolution.sql). No db, no I/O: every function here takes plain
 * data and returns a plain decision, so scripts/verify-entity-resolution.mjs pins the
 * rules with no database, same idiom as integrity.js.
 *
 * Distinct from (but built on top of) integrity.js's evaluateCustomerMatch/
 * findDuplicateCustomerPairs, which already power the Customers-tab "possible
 * duplicate" chip and profile banner. That existing pairwise checker is reused
 * directly (see resolve.js) as one input signal; this file adds the two things
 * it does not do:
 *   1. Name matching robust to word ORDER ("Smith, John" vs "John Smith" — already
 *      handled by integrity.js's compareNamesStrict, reused here), INITIALS
 *      ("J. Smith" vs "John Smith"), and GENERATIONAL SUFFIXES (Jr/Sr/II/III —
 *      a hard negative: same core name, different person, never merged).
 *   2. Company-suffix-aware tokens (LLC/Inc/Corp/...) so "Desert Ridge Dental
 *      LLC" and "Desert Ridge Dental" block and compare on the same core name
 *      without the suffix reading as a differing token.
 *   3. Candidate-generation BLOCKING (nameBlockingKeys/contactBlockingKeys) so a
 *      tenant-wide scan does not have to score every O(n^2) pair — see
 *      generateCandidatePairs.
 *
 * Every reason/evidence field a caller sees traces back to one of these plain
 * functions — never a magic score with no explanation.
 */
import {
  normalizePhoneKey, normalizeEmailKey, normalizeSurname, compareNamesStrict,
  damerauLevenshteinDistance, SURNAME_FUZZY_MIN_LENGTH, SURNAME_FUZZY_MAX_DISTANCE,
} from '../integrity.js';
import { jobKeyParts } from '../financials/jobKey.js';

// ------------------------------------------------------------------- names

const COMPANY_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'pllc', 'pc', 'plc', 'llp',
]);

/** Generational suffixes — same core name, a DIFFERENT person when they disagree
 *  (a father/son "John Smith Sr." / "John Smith Jr." pair). Order matters for
 *  nothing here; just membership. */
const GENERATION_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'dr', 'the']);

/**
 * "Smith, John" / "John Smith" / "Desert Ridge Dental LLC" -> {tokens, generation,
 * isCompany}. `tokens` is the name's core word list with company suffixes,
 * honorifics and a lone generational suffix all stripped out (order-independent
 * comparison is the caller's job — see sameTokenSet/tokensSubsetWithInitials
 * below); `generation` is the stripped suffix (or null); `isCompany` is true iff
 * a company suffix token was present at all (kept even though the token itself is
 * dropped, so callers can tell "Plaza Dental" apart from a plain personal name
 * when that matters).
 */
export function parseNameTokens(raw) {
  let s = String(raw ?? '').toLowerCase().trim();
  if (!s) return { tokens: [], generation: null, isCompany: false };
  if (s.includes(',')) {
    // "Smith, John" -> "John Smith" — reorder around the FIRST comma only, so a
    // trailing ", Jr" ("Smith, John, Jr") still ends up after the given name and
    // is caught by the generation-suffix strip below, not swallowed into it.
    const [first, ...rest] = s.split(',').map((p) => p.trim()).filter(Boolean);
    s = [...rest, first].join(' ');
  }
  s = s.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const rawTokens = s.split(' ').filter(Boolean);
  const isCompany = rawTokens.some((t) => COMPANY_SUFFIXES.has(t));
  let generation = null;
  const tokens = [];
  for (const t of rawTokens) {
    if (COMPANY_SUFFIXES.has(t) || HONORIFICS.has(t)) continue;
    if (GENERATION_SUFFIXES.has(t) && !generation) { generation = t; continue; }
    tokens.push(t);
  }
  return { tokens, generation, isCompany };
}

/** Order-independent token-set equality. */
function sameTokenSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) && new Set(a).size === setB.size;
}

/** A single-letter token ("j") is compatible with any full token starting with
 *  that letter ("john") — an initial standing in for a spelled-out name. Two
 *  full tokens must match exactly. */
function tokensCompatible(a, b) {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/** True when every token of the SHORTER list is compatible with some distinct
 *  token of the longer list (bipartite-ish greedy match — name lists here are
 *  always tiny, 1-4 tokens, so a greedy first-fit is exact in practice) AND the
 *  longer list's LAST token (the surname, by convention) is compatible with the
 *  shorter list's last token — otherwise "J Smith" would spuriously subset-match
 *  "J Jones" off the initial alone. Covers "John Smith" / "J. Smith" and
 *  "Ray & Linda Castillo" / "R Castillo" alike. */
function tokensSubsetWithInitials(shortTokens, longTokens) {
  if (!shortTokens.length || !longTokens.length) return false;
  const short = shortTokens.length <= longTokens.length ? shortTokens : longTokens;
  const long = shortTokens.length <= longTokens.length ? longTokens : shortTokens;
  if (!tokensCompatible(short[short.length - 1], long[long.length - 1])) return false;
  const used = new Array(long.length).fill(false);
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used[i] && tokensCompatible(t, u));
    if (idx < 0) return false;
    used[idx] = true;
  }
  return true;
}

/**
 * Explainable name relation between two raw name strings — the richer,
 * initials/generation/company-aware counterpart to integrity.js's
 * compareNamesStrict (reused here for the 'surname-fuzzy' typo case, since
 * re-deriving Damerau-Levenshtein distance a second time would just drift).
 * Returns `{relation, hardNegative}`:
 *   'equal'            — same token set, any order ("Castillo, Ray" / "Ray Castillo")
 *   'initials'         — one side's tokens are all initials/subset-compatible
 *                         with the other's ("J. Smith" / "John Smith")
 *   'typo'             — surnames are a likely 1-edit misspelling (reuses
 *                         integrity.js's SURNAME_FUZZY_* bar exactly)
 *   'surname-only'     — same surname, different given name/tokens — weak on
 *                         its own, never enough alone (owner "strict rules" rule,
 *                         same bar integrity.js already applies)
 *   'no-match'         — nothing in common
 *   'unknown'          — either side has no usable name
 * `hardNegative`, when true (relation is always 'equal' in this case): the two
 * names share every token EXCEPT a differing generational suffix (Jr vs Sr,
 * II vs III, ...) — a father/son pair, never the same customer regardless of
 * any other signal. Callers must veto the whole pair on this, exactly like
 * integrity.js's identity-field conflicts.
 */
export function nameRelation(aRaw, bRaw) {
  const a = parseNameTokens(aRaw);
  const b = parseNameTokens(bRaw);
  if (!a.tokens.length || !b.tokens.length) return { relation: 'unknown', hardNegative: false };

  const sameCore = sameTokenSet(a.tokens, b.tokens);
  if (sameCore) {
    if (a.generation && b.generation && a.generation !== b.generation) {
      return { relation: 'equal', hardNegative: true };
    }
    return { relation: 'equal', hardNegative: false };
  }

  if (tokensSubsetWithInitials(a.tokens, b.tokens)) {
    return { relation: 'initials', hardNegative: false };
  }

  const strict = compareNamesStrict(aRaw, bRaw);
  if (strict === 'surname-fuzzy') return { relation: 'typo', hardNegative: false };
  if (strict === 'surname') return { relation: 'surname-only', hardNegative: false };

  const sa = normalizeSurname(aRaw);
  const sb = normalizeSurname(bRaw);
  if (sa && sb && sa === sb) return { relation: 'surname-only', hardNegative: false };
  if (sa && sb && sa.length >= SURNAME_FUZZY_MIN_LENGTH && sb.length >= SURNAME_FUZZY_MIN_LENGTH
    && damerauLevenshteinDistance(sa, sb) <= SURNAME_FUZZY_MAX_DISTANCE) {
    return { relation: 'typo', hardNegative: false };
  }
  return { relation: 'no-match', hardNegative: false };
}

// ------------------------------------------------------------------ address

/**
 * Canonical address key for entity resolution: house number + street words +
 * UNIT + city (reuses financials/jobKey.js's jobKeyParts — the SAME
 * canonicalizer job-costing and the knowledge graph's `site` node already use,
 * rather than a fourth address normalizer). A different unit at the same
 * street ("100 Main St Apt 2" vs "100 Main St Apt 3") gets a DIFFERENT key —
 * jobKeyParts' `core` already folds the unit designator in — so two
 * apartments at one building are never blocked or matched together on address
 * alone (integrity.js's own normalizeAddressKey, used by the existing
 * Customers-tab duplicate banner, deliberately drops the unit; this file needs
 * the sharper key so "same address, different unit" is a hard negative here
 * rather than merely "known limitation, accepted").
 * Falls back to `null` when the address doesn't parse (no leading house
 * number) — never guessed.
 */
export function addressKey(raw) {
  return jobKeyParts(raw)?.full ?? null;
}

// -------------------------------------------------------------- blocking

/**
 * Blocking keys for one customer entity — {name, phone, email, address}, raw
 * text. Two entities are only ever SCORED against each other (evaluatePair, in
 * resolve.js) when they share at least one of these keys — this is what keeps
 * candidate generation sub-quadratic instead of comparing every pair in a
 * tenant's customer list. Every key is prefixed by kind so two coincidentally
 * equal-looking keys of different kinds (unlikely, but cheap to rule out)
 * never collide.
 */
export function nameBlockingKeys(name) {
  const { tokens } = parseNameTokens(name);
  if (!tokens.length) return [];
  const keys = new Set();
  const sorted = [...tokens].sort().join(' ');
  keys.add(`name:${sorted}`);
  // Surname alone (last token) + first-token initial — the same bar an
  // initials/typo match would need anyway, wide enough to catch "J. Smith"
  // against "John Smith" without also blocking every unrelated "Smith".
  const surname = tokens[tokens.length - 1];
  if (surname) keys.add(`surname:${surname}:${tokens[0]?.[0] ?? ''}`);
  return [...keys];
}

export function contactBlockingKeys({ phone, email, address } = {}) {
  const keys = [];
  const p = normalizePhoneKey(phone);
  if (p) keys.push(`phone:${p}`);
  const e = normalizeEmailKey(email);
  if (e) keys.push(`email:${e}`);
  const addr = addressKey(address);
  if (addr) keys.push(`address:${addr}`);
  return keys;
}

/** All blocking keys for one entity — the union callers index candidate pairs
 *  by. Exported so resolve.js's indexing and scripts/verify-entity-resolution.mjs
 *  agree on exactly what "shares a block" means. */
export function blockingKeys(entity) {
  return [...nameBlockingKeys(entity?.name), ...contactBlockingKeys(entity)];
}

/**
 * Candidate pairs: every pair of entities sharing >= 1 blocking key, each pair
 * emitted once (order-independent, i and j deduped). `entities`:
 * [{id, name, phone, email, address}]. O(n) indexing + O(candidates), not
 * O(n^2) — a tenant with thousands of customers still only scores pairs that
 * plausibly refer to the same person, per the blocking keys above.
 */
export function generateCandidatePairs(entities) {
  const list = Array.isArray(entities) ? entities.filter((e) => e?.id) : [];
  const byKey = new Map();
  for (const e of list) {
    for (const k of blockingKeys(e)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(e.id);
    }
  }
  const seen = new Set();
  const pairs = [];
  for (const ids of byKey.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        if (a === b) continue;
        const key = `${a}::${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

// --------------------------------------------------------------- pair score

/** Weights are additive and capped at 1 — see evaluatePair's doc comment for
 *  why each is worth what it is. Exported for scripts/verify-entity-resolution.mjs. */
export const WEIGHTS = {
  nameEqual: 0.5,
  nameInitials: 0.4,
  nameTypo: 0.35,
  nameSurnameOnly: 0.1,
  address: 0.4,
  phone: 0.45,
  email: 0.45,
};

/** Floor for a pair to be worth including in a cluster at all — see
 *  buildClusters. Below CUSTOMER_SUGGEST_THRESHOLD-style bars in integrity.js
 *  intentionally left alone; this is this module's own, independently tuned
 *  bar so raising/lowering one never silently moves the other. */
export const ENTITY_SUGGEST_THRESHOLD = 0.55;

/**
 * Pure pairwise evaluation for entity resolution. `a`/`b`: {name, phone, email,
 * address} raw text (unnormalized, straight off entities.data).
 * Returns `{score, reasons, evidenceFields, hardNegative}`:
 *   - HARD NEGATIVES (score forced to 0, reasons explain why, regardless of any
 *     other signal): a generational-suffix conflict (nameRelation's own
 *     hardNegative — father/son), OR phone/email/address each present and
 *     DIFFERING on both sides (the exact same "an identity field conflicts ->
 *     never a duplicate" rule as integrity.js's evaluateCustomerMatch, applied
 *     here to the sharper unit+city address key instead of the street-only
 *     one — so "same street, different unit" is vetoed here even in the one
 *     case integrity.js's own street-only key would have let through).
 *   - otherwise additive: name relation contributes WEIGHTS.name<relation>,
 *     each of phone/email/address matching EXACTLY contributes its own
 *     weight — summed and capped at 1.
 * `evidenceFields`: which of name/phone/email/address contributed a positive
 * signal, for the UI's "why these two" line.
 */
export function evaluatePair(a, b) {
  const reasons = [];
  const evidenceFields = [];

  const nr = nameRelation(a?.name, b?.name);
  if (nr.hardNegative) {
    return { score: 0, reasons: ['different generation (Jr/Sr/II/III) — likely a parent/child, not the same person'], evidenceFields: [], hardNegative: 'generation' };
  }

  const phoneA = normalizePhoneKey(a?.phone);
  const phoneB = normalizePhoneKey(b?.phone);
  const phoneConflict = phoneA && phoneB && phoneA !== phoneB;
  const phoneMatch = !!phoneA && phoneA === phoneB;

  const emailA = normalizeEmailKey(a?.email);
  const emailB = normalizeEmailKey(b?.email);
  const emailConflict = emailA && emailB && emailA !== emailB;
  const emailMatch = !!emailA && emailA === emailB;

  const addrA = addressKey(a?.address);
  const addrB = addressKey(b?.address);
  const addrConflict = addrA && addrB && addrA !== addrB;
  const addrMatch = !!addrA && addrA === addrB;

  if (phoneConflict) return { score: 0, reasons: ['phone number conflicts — different customers on file'], evidenceFields: [], hardNegative: 'phone' };
  if (emailConflict) return { score: 0, reasons: ['email conflicts — different customers on file'], evidenceFields: [], hardNegative: 'email' };
  if (addrConflict) return { score: 0, reasons: ['different address (or same street, different unit) — different customers on file'], evidenceFields: [], hardNegative: 'address' };

  let score = 0;
  if (nr.relation === 'equal') { score += WEIGHTS.nameEqual; reasons.push('same name'); evidenceFields.push('name'); }
  else if (nr.relation === 'initials') { score += WEIGHTS.nameInitials; reasons.push('name matches allowing for an initial'); evidenceFields.push('name'); }
  else if (nr.relation === 'typo') { score += WEIGHTS.nameTypo; reasons.push('name is a likely misspelling of the other'); evidenceFields.push('name'); }
  else if (nr.relation === 'surname-only') { score += WEIGHTS.nameSurnameOnly; reasons.push('same last name, different first name'); }

  if (addrMatch) { score += WEIGHTS.address; reasons.push('same address (including unit and city)'); evidenceFields.push('address'); }
  if (phoneMatch) { score += WEIGHTS.phone; reasons.push('same phone number'); evidenceFields.push('phone'); }
  if (emailMatch) { score += WEIGHTS.email; reasons.push('same email address'); evidenceFields.push('email'); }

  return { score: Math.min(1, score), reasons, evidenceFields, hardNegative: null };
}

// -------------------------------------------------------------- clustering

/** Union-Find (disjoint set), the standard "connected components over
 *  high-confidence pairs" primitive this module's clustering is built on —
 *  small helper, no external dependency needed for a handful of ids per
 *  tenant. Exported for scripts/verify-entity-resolution.mjs. */
export class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) { const next = this.parent.get(cur); this.parent.set(cur, root); cur = next; }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Connected components over candidate pairs scoring >= threshold —
 * TRANSITIVE clustering: if A~B and B~C score high enough, {A, B, C} cluster
 * together even when A and C never shared a blocking key directly (blocking
 * only has to catch ONE edge per eventual cluster member, not every pairwise
 * edge). Never auto-merges anything — this only groups; a human still accepts
 * or rejects the group (see resolve.js).
 *
 * `pairScores`: [{aId, bId, score, reasons, evidenceFields}] — already scored
 * (evaluatePair), already filtered to real customer ids. Returns
 * [{entityIds: string[], pairs: [...only the >= threshold pairs inside this
 * cluster], score: the cluster's own top pair score}], sorted by score
 * descending. A cluster of exactly 2 is the ordinary "these two look like
 * duplicates" case; 3+ is the multi-record case blocking-only pairwise
 * checking (integrity.js's own findDuplicateCustomerPairs) cannot express.
 */
export function buildClusters(pairScores, { threshold = ENTITY_SUGGEST_THRESHOLD } = {}) {
  const kept = (pairScores ?? []).filter((p) => p && p.score >= threshold && p.aId && p.bId && p.aId !== p.bId);
  const uf = new UnionFind();
  for (const p of kept) uf.union(p.aId, p.bId);

  const groups = new Map(); // root -> Set(ids)
  for (const p of kept) {
    const root = uf.find(p.aId);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(p.aId);
    groups.get(root).add(p.bId);
  }

  const clusters = [];
  for (const [root, idSet] of groups) {
    const entityIds = [...idSet].sort();
    const pairs = kept.filter((p) => uf.find(p.aId) === root);
    const score = Math.max(...pairs.map((p) => p.score));
    clusters.push({ entityIds, pairs, score });
  }
  return clusters.sort((a, b) => b.score - a.score);
}
