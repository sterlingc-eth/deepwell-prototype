/**
 * Pure rules behind the integrity scan/fix (handoffs/DATA_INTEGRITY_2026-09-20.md).
 * No db, no I/O — every function here takes plain data and returns a plain
 * decision, so scripts/verify-integrity.mjs pins the rules with no database.
 * api/_lib/routes/integrity.js is the only caller that touches Postgres.
 */

// ---------------------------------------------------------------- addresses

const ADDRESS_SUFFIXES = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard',
  'ln', 'lane', 'ct', 'court', 'way', 'pl', 'place', 'cir', 'circle',
  'pkwy', 'parkway', 'hwy', 'highway', 'ter', 'terrace',
]);

/**
 * Street-line identity key: house number + street name (+ direction),
 * suffix/unit/city/state/zip stripped. "1519 W Juniper" and "1519 W Juniper
 * Ave, Mesa AZ 85202" both normalize to "1519 w juniper"; "1519 E Juniper"
 * does NOT — direction is kept as part of the street name on purpose, it is
 * the one thing that tells two real addresses apart.
 *
 * Known limitation, accepted: two different families at the same street
 * address in different apartments normalize to the SAME key (unit is
 * dropped). customerMatchScore below relies on the NAME differing to keep
 * those apart, not on the address.
 */
export function normalizeAddressKey(raw) {
  let s = String(raw ?? '').toLowerCase();
  if (!s.trim()) return '';
  s = s.split(',')[0]; // drop city/state/zip — the street line is the identity
  s = s.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // drop a unit/suite/apt marker and everything after it
  s = s.replace(/\b(unit|suite|ste|apt|apartment|no|number)\b.*$/i, '').trim();
  const tokens = s.split(' ').filter(Boolean);
  if (tokens.length > 1 && ADDRESS_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Unit/suite/apt number pulled out of a full address string — the one
 *  piece normalizeAddressKey deliberately drops. "100 Main St Apt 2" -> "2".
 *  Exported for scripts/verify-integrity.mjs. */
export function normalizeUnitKey(raw) {
  const m = String(raw ?? '').match(/\b(?:unit|suite|ste|apt|apartment|no\.?|number)\.?\s*#?\s*([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Leading house number off a raw address string ("544 E Ray Rd..." -> "544"),
 * or null when the address doesn't start with one (rare — a rural route, a
 * lot number). Round 3 fix (2026-09-21, reviewer NO-GO item 1): the ONE piece
 * both recordsStore.js's findOrCreateCustomerByAddress and
 * routes/integrity.js's loadAddressPlaceholderCandidates need to narrow a
 * candidate query in SQL BEFORE the exact normalizeAddressKey(+unit) match
 * decides anything — a customer at a genuinely different street essentially
 * never shares this exact house-number prefix, so filtering on it in SQL is
 * a cheap, safe narrowing, never a guess. Shared here so both call sites
 * narrow the identical way instead of drifting apart. */
export function houseNumberOf(address) {
  const m = String(address ?? '').trim().match(/^(\d{1,6})\b/);
  return m ? m[1] : null;
}

/** City + zip pulled out of the "city, state zip" tail of an address string
 *  (everything after the first comma). No comma at all -> both empty
 *  (a bare street line like "1519 W Juniper" carries no city/zip either
 *  side can conflict on — that's `missing`, never `conflict`). */
function parseCityZip(raw) {
  const parts = String(raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { city: '', zip: '' };
  const tail = parts[parts.length - 1];
  const zipMatch = tail.match(/(\d{5})(?:-\d{4})?/);
  const zip = zipMatch ? zipMatch[1] : '';
  let rest = (zip ? tail.replace(zipMatch[0], '') : tail).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && /^[a-z]{2}$/i.test(tokens[tokens.length - 1])) tokens.pop(); // drop state abbrev
  let city = tokens.join(' ').toLowerCase();
  if (!city && parts.length >= 3) city = parts[parts.length - 2].toLowerCase(); // "St, Suite 2, Mesa, AZ 85202"
  return { city, zip };
}

/** Exported for scripts/verify-integrity.mjs. */
export function normalizeCityKey(raw) { return parseCityZip(raw).city; }
export function normalizeZipKey(raw) { return parseCityZip(raw).zip; }

/** Digits only — "(480) 555-1234" and "480-555-1234" compare equal. */
export function normalizePhoneKey(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

export function normalizeEmailKey(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

// -------------------------------------------------------------------- names

function normalizeNamePlain(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'dr', 'the']);

/**
 * Best-effort surname: "Ray & Linda Castillo" / "Castillo, Ray" /
 * "R. Castillo" / "The Castillos" all -> "castillo". A heuristic, not a name
 * parser — it exists to widen a candidate search, never to merge on its own
 * (customerMatchScore always also weighs the address).
 */
export function normalizeSurname(raw) {
  let s = String(raw ?? '').toLowerCase().trim();
  if (!s) return '';
  const hadThe = /^the\s+/.test(s);
  if (s.includes(',')) s = s.split(',')[0]; // "Castillo, Ray" -> "Castillo"
  s = s.replace(/^the\s+/, '').replace(/\./g, '');
  const tokens = s.split(/[\s&]+|\band\b/i).map((t) => t.trim()).filter(Boolean)
    .filter((t) => t.length > 1 && !HONORIFICS.has(t));
  let surname = tokens[tokens.length - 1] ?? '';
  // "Castillos" (from "The Castillos") -> "Castillo": only de-pluralize the
  // explicit "The X's family" pattern, never a surname that just happens to
  // end in 's' (Williams, Jones, ...).
  if (hadThe && surname.endsWith('s') && surname.length > 3) surname = surname.slice(0, -1);
  return surname;
}

/** How many "name tokens" a name carries — "Ray & Linda Castillo" -> 3,
 *  "Castillo" -> 1. Used to prefer a fuller name over a surname-only one.
 *  Exported so preferFullerName and findDuplicateCustomerPairs's keep/drop
 *  ordering are checked against the exact same count
 *  (scripts/verify-integrity.mjs). */
export function nameTokenCount(raw) {
  return normalizeNamePlain(raw).split(' ').filter(Boolean).length;
}

/**
 * Pure: which of two matching customer_name values should survive a merge
 * (owner request 2026-09-20 follow-up: "keep 'Ray & Linda Castillo', not
 * just 'Castillo'"). Strict-subset rule only — this is name ADOPTION, not
 * general dedup, so it only fires when both sides plainly name the same
 * family (same surname via normalizeSurname): the record naming more people
 * wins. Two equally-full names ("Castillo, Ray" vs "Ray Castillo") are left
 * as `keepName` — nothing to gain by picking one over the other. A
 * different surname (company names: "Plaza Dental" vs "Plaza Dental Group")
 * is untouched — preserving that as an alias is coalesceEntityData's own
 * job, not this rule's. Exported for scripts/verify-integrity.mjs.
 */
/**
 * Pure: which of two address strings should survive when both name the SAME
 * building (same normalizeAddressKey street identity) — the fuller string
 * wins, e.g. "1519 W Juniper" -> "1519 W Juniper Ave, Mesa AZ 85202" (owner
 * 2026-09-20: a merge run before this fix kept the terse address a customer
 * happened to be created with, over the fuller one a later document supplied
 * for the dropped record). A DIFFERENT street key means a different address
 * entirely, not a fuller version of this one — untouched. Exported for
 * scripts/verify-integrity.mjs.
 */
// ---------------------------------------------------- address-only customers
// (2026-09-20 root-cause fix, handoffs/LINKING_ROOT_CAUSE_2026-09-20.md):
// findOrCreateCustomer used to return null outright when a document named a
// service_address but no customer_name (a permit, a dispatch note, a
// nameplate photo) — the document then never linked to an owner at all, for
// its whole life, since nothing ever revisits a document once extracted.
// These two are the pure naming/flagging rules; the DB matching/creation
// itself lives in recordsStore.js's findOrCreateCustomer.

/** Display name for a customer created from an address alone — never
 *  presented as a real name, always distinguishable at a glance. */
export function addressOnlyCustomerName(address) {
  const a = String(address ?? '').trim();
  return a ? `Customer at ${a}` : 'Customer (address unknown)';
}

/** True when `data` is a placeholder created by addressOnlyCustomerName —
 *  the one case a LATER document's real customer_name is allowed to replace
 *  the name outright (an upgrade, not a fill-only merge) rather than create a
 *  second customer at the same address. */
export function isAddressOnlyCustomer(data) {
  return !!data && data.name_source === 'address';
}

/**
 * Reviewer NO-GO (2026-09-21, round 2, gap 4) — pure decision for the
 * `absorbAddressPlaceholders` heal step (routes/integrity.js): which
 * address-only placeholder customers should be merged INTO an existing named
 * customer at the exact same address, because recordsStore.js's own write-
 * time match (findOrCreateCustomerByAddress) missed them — live case:
 * "Customer at 544 E Ray Rd..." sitting alongside "Deborah Ortega @ 544 E Ray
 * Rd...", the identical address.
 *
 * `customers`: {id, address, isPlaceholder, isLocked?}[] — every non-merged
 * customer with a service_address on file (or, at scale, the narrowed subset
 * routes/integrity.js's loadAddressPlaceholderCandidates fetches — see its
 * own doc comment). Matching is EXACT (normalizeAddressKey, narrowed by
 * normalizeUnitKey when a placeholder's own address names a unit) — the same
 * "don't know, so don't guess" rule findOrCreateCustomerByAddress itself
 * already applies: a placeholder whose street matches MORE THAN ONE named
 * customer (with no unit to break the tie) is left alone for a human, never
 * guessed at.
 *
 * Reviewer NO-GO (2026-09-21, round 3, item 2): a placeholder is excluded
 * outright when `isLocked` is true — set by the caller (routes/integrity.js)
 * when ANY document linked to that placeholder fails `isEligibleForRelink`
 * (a human-made link, or a document a human has already verified). A human
 * touching that document implicitly confirmed the placeholder as ITS OWN
 * customer; silently merging it into a different named customer would
 * override that human judgment, exactly what relinkMismatchedNames itself
 * refuses to do unattended.
 *
 * Returns [{keepId, dropId}] — dropId is always the placeholder, ready to
 * pass straight to reviewStore.js's mergeCustomers (docs/units move onto
 * keepId; dropId ends up `merged_into` keepId).
 */
export function planAddressPlaceholderAbsorptions(customers) {
  const rows = (customers ?? []).filter((c) => c && c.id && c.address);
  const named = rows.filter((c) => !c.isPlaceholder);
  const placeholders = rows.filter((c) => c.isPlaceholder && !c.isLocked);

  const namedByStreet = new Map();
  for (const c of named) {
    const key = normalizeAddressKey(c.address);
    if (!key) continue;
    if (!namedByStreet.has(key)) namedByStreet.set(key, []);
    namedByStreet.get(key).push(c);
  }

  const plans = [];
  for (const p of placeholders) {
    const key = normalizeAddressKey(p.address);
    if (!key) continue;
    let candidates = namedByStreet.get(key) ?? [];
    if (candidates.length > 1) {
      const unitKey = normalizeUnitKey(p.address);
      candidates = unitKey ? candidates.filter((c) => normalizeUnitKey(c.address) === unitKey) : [];
    }
    if (candidates.length === 1) plans.push({ keepId: candidates[0].id, dropId: p.id });
  }
  return plans;
}

// ---------------------------------------------------------- shop addresses
// Reviewer follow-up (2026-09-20, NO-GO on the first pass of the fix above):
// the address-only path can create a "customer" out of the CONTRACTOR'S OWN
// letterhead address when a document prints no separate service address —
// every one of Desert Peak's own invoices would otherwise mint (or keep
// re-matching) a bogus "Customer at 2210 E Main St" using the shop's own
// address, and then attribute other customers' documents to it by address
// coincidence. Two independent signals, either sufficient:
//   1. it matches the tenant's own configured address, when one is on file.
//   2. it shows the LETTERHEAD PATTERN: extracted as shop_address on at least
//      one document (the model was asked to tell the two apart — see
//      extractFields.js's service_address/shop_address guide), OR extracted
//      as service_address on >=3 distinct documents naming >=3 distinct
//      customer_names — a real customer's service address does not repeat
//      across that many different people; a shop's own address, printed on
//      every form it produces, does.

/** Minimum evidence for signal 2 above — both floors must be met together
 *  (3 documents is not evidence by itself if they're all the same customer;
 *  3 different customer names is not evidence by itself off a single
 *  document). Exported so scripts/verify-linking.mjs pins the exact bar. */
export const SHOP_ADDRESS_DOC_FLOOR = 3;
export const SHOP_ADDRESS_CUSTOMER_FLOOR = 3;

/**
 * Pure. `addrKey` is an already-normalizeAddressKey'd value. `tenantAddressKey`
 * is the tenant's own address (also normalizeAddressKey'd), or falsy when none
 * is on file. `letterheadCounts` is `{[addrKey]: {shopAddressDocs, serviceAddressDocs,
 * distinctCustomerNames}}` — one pre-aggregated row per address key, built by
 * routes/integrity.js from a single SQL query per request (see
 * loadLetterheadCounts) and cached there; this function never touches the
 * database, so it is directly testable with a plain object.
 */
export function isLikelyShopAddress(addrKey, { tenantAddressKey, letterheadCounts } = {}) {
  if (!addrKey) return false;
  if (tenantAddressKey && addrKey === tenantAddressKey) return true;
  const counts = letterheadCounts?.[addrKey];
  if (!counts) return false;
  if ((counts.shopAddressDocs ?? 0) >= 1) return true;
  return (counts.serviceAddressDocs ?? 0) >= SHOP_ADDRESS_DOC_FLOOR
    && (counts.distinctCustomerNames ?? 0) >= SHOP_ADDRESS_CUSTOMER_FLOOR;
}

export function preferFullerAddress(keepAddr, dropAddr) {
  const keep = String(keepAddr ?? '').trim();
  const drop = String(dropAddr ?? '').trim();
  if (!keep) return drop;
  if (!drop || keep === drop) return keep;
  if (normalizeAddressKey(keep) !== normalizeAddressKey(drop)) return keep;
  return drop.length > keep.length ? drop : keep;
}

export function preferFullerName(keepName, dropName) {
  const keep = String(keepName ?? '').trim();
  const drop = String(dropName ?? '').trim();
  if (!keep) return drop;
  if (!drop || keep.toLowerCase() === drop.toLowerCase()) return keep;

  const keepSurname = normalizeSurname(keep);
  const dropSurname = normalizeSurname(drop);
  if (!keepSurname || keepSurname !== dropSurname) return keep;

  return nameTokenCount(drop) > nameTokenCount(keep) ? drop : keep;
}

/**
 * Pure: Round-3 live-retest fix (2026-09-21) — recordsStore.js's
 * findOrCreateCustomer used to freeze the survivor's customer_name at
 * whatever the FIRST document happened to spell it ("Nguyen, T."), because
 * its existing-match branch only ever fills a BLANK field, never upgrades a
 * non-blank one. This decides whether an incoming name should REPLACE an
 * already-stored one: only ever upgrades to something FULLER of the same
 * person/family — compareNamesStrict must say the two names are the same at
 * some level (equal/subset/surname; never a bare surname-fuzzy near-miss or
 * no-match) AND the incoming name must have MORE tokens than the stored one
 * — then defers to preferFullerName (the same fuller-wins rule
 * coalesceEntityData and the Customers-tab duplicates chooser already use)
 * for the actual pick, so a name can never get shorter through this path.
 * Returns the name that should be stored (`storedName` itself, unchanged,
 * when no upgrade applies). Pinned as a plain function, same pattern as
 * isEligibleForRelink, so it is unit-testable without a database — see
 * scripts/verify-integrity.mjs.
 */
export function chooseUpgradedCustomerName(storedName, incomingName) {
  const stored = String(storedName ?? '').trim();
  const incoming = String(incomingName ?? '').trim();
  if (!stored || !incoming || stored.toLowerCase() === incoming.toLowerCase()) return stored;
  const rel = compareNamesStrict(incoming, stored);
  if ((rel === 'equal' || rel === 'subset' || rel === 'surname') && nameTokenCount(incoming) > nameTokenCount(stored)) {
    return preferFullerName(stored, incoming);
  }
  return stored;
}

/**
 * Damerau-Levenshtein distance (insertions, deletions, substitutions and
 * adjacent transpositions each cost 1) between two strings. No dependency —
 * this is the only place that needs it (compareNamesStrict's 'surname-fuzzy'
 * relation, limit-test defect B: "Paterson" vs "Patterson"), and both inputs
 * are already-normalized surnames, well under 100 characters.
 */
export function damerauLevenshteinDistance(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  const al = s.length;
  const bl = t.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

/** Both surnames need at least this many characters before a 1-edit
 *  difference is trusted as a misspelling rather than two genuinely
 *  different short names ("Li" vs "Lu" is 1 edit and two different people).
 *  Exported for scripts/verify-integrity.mjs. */
export const SURNAME_FUZZY_MIN_LENGTH = 5;
export const SURNAME_FUZZY_MAX_DISTANCE = 1;

/**
 * 'equal' (same set of name tokens, any order — "Castillo, Ray" / "Ray
 *   Castillo") | 'subset' (one name's tokens are a strict subset of the
 *   other's — "Castillo" ⊂ "Ray & Linda Castillo", "Plaza Dental" ⊂ "Plaza
 *   Dental Group") | 'surname' (same last name via normalizeSurname, but
 *   NOT a subset — different first names: "John Smith" vs "Jane Smith")
 *   | 'surname-fuzzy' (surnames differ by at most SURNAME_FUZZY_MAX_DISTANCE
 *   edits, both at least SURNAME_FUZZY_MIN_LENGTH characters — "Paterson" vs
 *   "Patterson"; a likely misspelling, not the same string) | 'no-match'
 *   | 'unknown' (either side has no usable name).
 * Owner rule (2026-09-20 "strict rules" follow-up): 'surname' alone is never
 * enough to auto-merge — only 'equal'/'subset' are. Limit-test defect B
 * (2026-09-20): 'surname-fuzzy' is even weaker evidence than 'surname' and is
 * never enough either — see evaluateCustomerMatch's scoring below.
 * Exported for recordsStore.js's selectCustomerMatch (bug C fix) and
 * scripts/verify-*.mjs.
 */
export function compareNamesStrict(a, b) {
  const na = normalizeNamePlain(a);
  const nb = normalizeNamePlain(b);
  if (!na || !nb) return 'unknown';
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const setA = new Set(ta);
  const setB = new Set(tb);
  if (setA.size === setB.size && [...setA].every((t) => setB.has(t))) return 'equal';
  if (ta.length < tb.length && ta.every((t) => setB.has(t))) return 'subset';
  if (tb.length < ta.length && tb.every((t) => setA.has(t))) return 'subset';
  const sa = normalizeSurname(a);
  const sb = normalizeSurname(b);
  if (sa && sb && sa === sb) return 'surname';
  if (
    sa && sb && sa.length >= SURNAME_FUZZY_MIN_LENGTH && sb.length >= SURNAME_FUZZY_MIN_LENGTH &&
    damerauLevenshteinDistance(sa, sb) <= SURNAME_FUZZY_MAX_DISTANCE
  ) {
    return 'surname-fuzzy';
  }
  return 'no-match';
}

/**
 * Round 4 item 4 (2026-09-21): a document sometimes names its customer only
 * by MENTIONING them in free text — "Sarah Chen's account", "for Mike
 * Torres" — rather than the model extracting a customer_name fact. Matches
 * "<First Last[ Last2]>'s account|home|house|unit|system|property" or
 * "for <First Last[ Last2]>". First match wins; pure, no I/O.
 * See recordsStore.js's findOrCreateCustomer for where this feeds in, and
 * scripts/verify-integrity.mjs for coverage.
 */
// Exactly "First Last" (two tokens), per the brief's literal pattern. A wider
// {1,2}-extra-word version also swallowed a capitalized sentence-initial verb
// with nothing but a name between it and "'s" ("Inspected Bob Nguyen's
// property" read as candidate "Inspected Bob Nguyen") — fixed-width avoids
// that ambiguity entirely: the regex engine simply slides its start position
// forward until "'s"/"for" lines up immediately before a two-token name.
const NAME_MENTION_RE =
  /\b([A-Z][a-z]+\s+[A-Z][a-z]+)'s\s+(?:account|home|house|unit|system|property)\b|\bfor\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/;

export function extractNameMention(text) {
  const m = String(text ?? '').match(NAME_MENTION_RE);
  if (!m) return null;
  return (m[1] || m[2] || '').trim() || null;
}

/**
 * Given a name mentioned in a document's free text (extractNameMention) and
 * a narrow set of same-surname customer candidates, returns the single
 * customer it unambiguously names — compareNamesStrict must say 'equal' or
 * 'subset', the same strict bar 'ai:name-only' already applies — or null when
 * zero or two-or-more match (left for a person, never guessed). Pure.
 *
 * @param {string|null} candidateName
 * @param {{id: string, name: string}[]} customers
 * @returns {{id: string}|null}
 */
export function matchNameMention(candidateName, customers) {
  if (!candidateName) return null;
  const matches = (customers ?? []).filter((c) => {
    const rel = compareNamesStrict(candidateName, c?.name);
    return rel === 'equal' || rel === 'subset';
  });
  return matches.length === 1 ? { id: matches[0].id } : null;
}

// ------------------------------------------------------------------- score

// The 6 identity fields a hard veto is checked against (owner "strict
// rules" follow-up, 2026-09-20): a value present and DIFFERING on both
// sides on any one of these means never a duplicate, whatever else matches.
// A value missing on one side is not a conflict — fill-only merge still
// applies to it.
const IDENTITY_FIELD_CHECKS = [
  { key: 'phone', get: (c) => c?.phone, normalize: normalizePhoneKey },
  { key: 'email', get: (c) => c?.email, normalize: normalizeEmailKey },
  { key: 'street', get: (c) => c?.address, normalize: normalizeAddressKey },
  { key: 'unit', get: (c) => c?.address, normalize: normalizeUnitKey },
  { key: 'city', get: (c) => c?.address, normalize: normalizeCityKey },
  { key: 'zip', get: (c) => c?.address, normalize: normalizeZipKey },
];

/**
 * Pure: compares `a`/`b` field by field over IDENTITY_FIELD_CHECKS.
 * `{matches, missing, conflicts}` — each a list of field keys. A field
 * absent on BOTH sides is left out of all three lists (nothing to say about
 * it either way).
 *
 * `ctx`, when passed (routes/integrity.js's shop-contact context — see
 * isLikelyShopPhone/isLikelyShopEmail above), makes phone/email that are a
 * likely SHOP value on BOTH sides count for nothing at all — not a match,
 * not a conflict, not missing. Limit-test defect A follow-up: before every
 * customer's `phone` carried the same leaked shop number, that number read as
 * strong positive identity evidence (`matches.includes('phone')`), so every
 * pair of customers "matched" on phone and the hard veto/auto-tier logic
 * below treated coincidence as confirmation. A shop number tells you nothing
 * about whether two CUSTOMERS are the same customer, so it is excluded
 * entirely rather than scored either way. Exported for scripts/verify-integrity.mjs.
 */
export function buildMatchEvidence(a, b, ctx) {
  const matches = [];
  const missing = [];
  const conflicts = [];
  for (const f of IDENTITY_FIELD_CHECKS) {
    const na = f.normalize(f.get(a));
    const nb = f.normalize(f.get(b));
    if (ctx && f.key === 'phone' && isLikelyShopPhone(na, ctx) && isLikelyShopPhone(nb, ctx)) continue;
    if (ctx && f.key === 'email' && isLikelyShopEmail(na, ctx) && isLikelyShopEmail(nb, ctx)) continue;
    if (!na && !nb) continue;
    if (!na || !nb) { missing.push(f.key); continue; }
    (na === nb ? matches : conflicts).push(f.key);
  }
  return { matches, missing, conflicts };
}

/** True when phone or email positively confirms these are the same
 *  customer, OR neither side has any contact info to check at all (nothing
 *  to confirm — name + address alone stand, same as before this rule
 *  existed). False whenever contact info exists but is only PARTIALLY on
 *  file (present on one side, missing on the other) — not proof either way,
 *  so a human decides. */
function contactConfirmed(a, b, evidence) {
  if (evidence.matches.includes('phone') || evidence.matches.includes('email')) return true;
  const noContactEitherSide =
    !normalizePhoneKey(a?.phone) && !normalizePhoneKey(b?.phone) &&
    !normalizeEmailKey(a?.email) && !normalizeEmailKey(b?.email);
  return noContactEitherSide;
}

/** Short human-readable line for the duplicates banner, e.g. "Same address
 *  and name" or "Same address; one name is part of the other; phone missing
 *  on one record". */
function describeMatch({ addrMatch, nameRel, evidence }) {
  const bits = [];
  if (addrMatch) bits.push('same address');
  if (nameRel === 'equal') bits.push('same name');
  else if (nameRel === 'subset') bits.push('one name is part of the other');
  else if (nameRel === 'surname') bits.push('same surname, different first name');
  else if (nameRel === 'surname-fuzzy') bits.push('surname is a likely misspelling of the other');
  let base = bits.join(' and ') || (addrMatch ? 'same address' : 'possible match');
  base = base.charAt(0).toUpperCase() + base.slice(1);
  const missingBits = evidence.missing.map((k) => `${k} missing on one record`);
  return [base, ...missingBits].join('; ');
}

// ------------------------------------------------------- shop contact leaks
// Limit-test defect A (2026-09-20): the contractor's own letterhead
// phone/email leaking into `customer_phone`/`customer_email` extractions and
// from there into every customer's `data.phone`/`data.email` (fill-once, so
// once it lands it never self-heals). Same two-signal shape as
// isLikelyShopAddress above: the tenant's own configured phone/email, OR a
// pattern signal — but for contact info the pattern lives on the CUSTOMER
// rows themselves (a phone/email is a shop number when it sits on several
// customers at DIFFERENT street addresses; no real household has 3 addresses)
// rather than on extraction letterhead tags, since a phone/email has no
// document-scoped "shop_address"-style counterpart worth aggregating the same
// way (shop_phone/shop_email are still recorded — see extractFields.js — and
// used directly at write time in recordsStore.js's findOrCreateCustomer,
// which is the cheaper, per-document check; this pure pair is for the
// tenant-wide scan/veto, where the "on file" list of customers is what's
// available).

/** Minimum number of DISTINCT normalized street addresses one phone/email
 *  must appear on, across a tenant's customers, to be treated as a shared
 *  shop number rather than a coincidence. Exported for scripts/verify-integrity.mjs. */
export const SHOP_CONTACT_ADDRESS_FLOOR = 3;

/**
 * Pure. `customers`: [{address, phone?, email?}] (a tenant's customer list,
 * e.g. routes/integrity.js's loadCustomersForScan). `extra` (round 4,
 * 2026-09-21): additional [{address, phone?, email?}]-shaped evidence from
 * somewhere OTHER than a customer's own consolidated phone/email field — the
 * live-retest gap this closes is a number that only ever shows up in
 * customer_phone/shop_phone/shop_email EXTRACTIONS on a customer's linked
 * documents, never written to that customer's own `data.phone`. Each entry
 * (real customer row or `extra` row) contributes its address to the SAME
 * per-value address set, so a value spread across, say, two customers' own
 * `phone` fields plus one more customer's document extraction still clears
 * the floor. Returns `{phoneAddressCounts, emailAddressCounts}` — one count
 * per normalized phone/email key, of how many DISTINCT normalized street
 * addresses it appears on. An entry with no address on file contributes
 * nothing (there is no address to count), same "nothing to say either way"
 * treatment as buildMatchEvidence's `missing`.
 */
export function buildContactAddressCounts(customers, extra) {
  const phoneBuckets = new Map();
  const emailBuckets = new Map();
  const addEntry = (address, phone, email) => {
    const streetKey = normalizeAddressKey(address);
    if (!streetKey) return;
    const phoneKey = normalizePhoneKey(phone);
    if (phoneKey) {
      if (!phoneBuckets.has(phoneKey)) phoneBuckets.set(phoneKey, new Set());
      phoneBuckets.get(phoneKey).add(streetKey);
    }
    const emailKey = normalizeEmailKey(email);
    if (emailKey) {
      if (!emailBuckets.has(emailKey)) emailBuckets.set(emailKey, new Set());
      emailBuckets.get(emailKey).add(streetKey);
    }
  };
  for (const c of Array.isArray(customers) ? customers : []) addEntry(c?.address, c?.phone, c?.email);
  for (const e of Array.isArray(extra) ? extra : []) addEntry(e?.address, e?.phone, e?.email);
  const toCounts = (buckets) => Object.fromEntries([...buckets].map(([k, set]) => [k, set.size]));
  return { phoneAddressCounts: toCounts(phoneBuckets), emailAddressCounts: toCounts(emailBuckets) };
}

/**
 * True when `phone` looks like the contractor's own shop number rather than
 * a real customer's: it matches the tenant's own configured phone (`ctx.
 * tenantPhoneKey`), or it sits on SHOP_CONTACT_ADDRESS_FLOOR or more distinct
 * customer addresses (`ctx.phoneAddressCounts`, from buildContactAddressCounts).
 * `phone` may be raw or already-normalized — normalizePhoneKey is idempotent
 * on a digits-only string. Exported for scripts/verify-integrity.mjs and
 * routes/integrity.js's stripShopContact.
 */
export function isLikelyShopPhone(phone, ctx = {}) {
  const key = normalizePhoneKey(phone);
  if (!key) return false;
  if (ctx.tenantPhoneKey && key === ctx.tenantPhoneKey) return true;
  // Round-3 fix (2026-09-21): a value recorded in tenants.settings.
  // known_shop_contacts (recordsStore.js's recordKnownShopContact) is a shop
  // number REGARDLESS of how many customer addresses it currently sits on —
  // this is what keeps a once-leaked number recognized even after
  // stripShopContact has cleaned every customer up and the address-count
  // signal below can no longer see it (only one customer left carrying it,
  // never enough to clear the floor again).
  if (Array.isArray(ctx.knownShopPhoneKeys) && ctx.knownShopPhoneKeys.includes(key)) return true;
  return (ctx.phoneAddressCounts?.[key] ?? 0) >= SHOP_CONTACT_ADDRESS_FLOOR;
}

/** Email counterpart of isLikelyShopPhone — see its doc comment. */
export function isLikelyShopEmail(email, ctx = {}) {
  const key = normalizeEmailKey(email);
  if (!key) return false;
  if (ctx.tenantEmailKey && key === ctx.tenantEmailKey) return true;
  if (Array.isArray(ctx.knownShopEmailKeys) && ctx.knownShopEmailKeys.includes(key)) return true;
  return (ctx.emailAddressCounts?.[key] ?? 0) >= SHOP_CONTACT_ADDRESS_FLOOR;
}

/**
 * Pure duplicate-customer evaluation. `a`/`b` are {name, address, phone?,
 * email?} — raw, unnormalized text straight off a customer entity's data.
 * Returns `{score, tier, evidence, reason}`:
 *   - HARD VETO first (owner "strict rules" follow-up, 2026-09-20): any
 *     identity field (phone/email/street/unit/city/zip) present and
 *     DIFFERING on both sides -> score 0, tier null, reason
 *     'conflict:<field>' — never a duplicate, whatever else matches. A
 *     phone/email that is a likely SHOP value on both sides (`ctx`) is
 *     excluded from this check entirely — see buildMatchEvidence.
 *   - otherwise scored by address + name relation (compareNamesStrict):
 *     same street + equal/subset name -> 0.97; same street + surname-only,
 *     surname-fuzzy (a likely misspelling — limit-test defect B), or name
 *     unknown -> 0.6; same street, unrelated names -> 0.3 (two families
 *     sharing a building); no usable address + equal/subset name -> 0.55 (a
 *     hint); anything else -> 0.
 *   - `tier: 'auto'` only when the street matches, the name is equal/subset
 *     (never surname-only or surname-fuzzy), AND phone or email positively
 *     confirms it (or neither side has contact info to check) — see
 *     contactConfirmed. Otherwise `tier: 'suggest'` (or null when vetoed): a
 *     human decides.
 *
 * `ctx`, optional (default none — every existing caller is unaffected):
 * routes/integrity.js's shop-contact context (tenantPhoneKey/tenantEmailKey +
 * phoneAddressCounts/emailAddressCounts, see isLikelyShopPhone/isLikelyShopEmail
 * and buildContactAddressCounts above), threaded through to buildMatchEvidence.
 */
export function evaluateCustomerMatch(a, b, ctx) {
  const evidence = buildMatchEvidence(a, b, ctx);
  if (evidence.conflicts.length) {
    return { score: 0, tier: null, evidence, reason: `conflict:${evidence.conflicts[0]}` };
  }

  const addrMatch = evidence.matches.includes('street');
  const nameRel = compareNamesStrict(a?.name, b?.name);
  const nameIsFull = nameRel === 'equal' || nameRel === 'subset';
  const nameIsWeakHint = nameRel === 'surname' || nameRel === 'surname-fuzzy' || nameRel === 'unknown';

  let score;
  if (addrMatch) score = nameIsFull ? 0.97 : nameIsWeakHint ? 0.6 : 0.3;
  else score = nameIsFull ? 0.55 : 0;

  const tier = addrMatch && nameIsFull && contactConfirmed(a, b, evidence) ? 'auto' : 'suggest';
  return { score, tier, evidence, reason: describeMatch({ addrMatch, nameRel, evidence }) };
}

/** Backward-compatible score-only entry point (recordsStore.js's
 *  findOrCreateCustomer fuzzy match uses just the number). */
export function customerMatchScore(a, b) {
  return evaluateCustomerMatch(a, b).score;
}

export const CUSTOMER_MATCH_THRESHOLD = 0.9;
/** Floor for even SUGGESTING a duplicate pair in the banner/scan — well
 *  below CUSTOMER_MATCH_THRESHOLD (which stays the bar for auto-linking a
 *  document to an existing customer, recordsStore.js). Auto- vs
 *  suggest-tier is decided by `tier` above, not by this score alone. */
export const CUSTOMER_SUGGEST_THRESHOLD = 0.55;

/** 'C-00003' -> 3; anything unparseable sorts last (never chosen as the keep
 *  side over a real number). Local, standalone copy of the same "keep the
 *  lower number" rule as reviewStore.js's chooseSurvivorNumber — duplicated
 *  rather than imported so this file stays dependency-free and independently
 *  testable. */
function customerNumberOrdinal(customerNumber) {
  const m = typeof customerNumber === 'string' && customerNumber.match(/^C-(\d+)$/);
  return m ? Number(m[1]) : Infinity;
}

/** Same default the Customers-tab duplicates chooser uses (src/core/duplicates.ts
 *  defaultKeepId): the fuller name wins ("Ray & Linda Castillo" beats
 *  "Castillo"); a tie goes to the lower customer_number. Nightly auto-merge
 *  and "Fix everything" go through this function with no human in the loop,
 *  so it must pick the same survivor a human would by default. */
function pickKeepDrop(a, b) {
  const ta = nameTokenCount(a?.name);
  const tb = nameTokenCount(b?.name);
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  return customerNumberOrdinal(a?.customerNumber) <= customerNumberOrdinal(b?.customerNumber) ? [a, b] : [b, a];
}

/**
 * All same-household pairs among a tenant's customers. `customers`:
 * [{id, name, address, customerNumber, phone?, email?}]. Returns
 * [{keepId, dropId, score, tier, evidence, reason}], keep = the fuller name
 * (tie: the lower customer_number — see pickKeepDrop). `threshold` defaults
 * to CUSTOMER_SUGGEST_THRESHOLD — low enough to surface a suggest-tier pair
 * in the banner; the score-0 hard veto (evaluateCustomerMatch) already keeps
 * out anything with a conflicting identity field regardless of threshold.
 * mergeDuplicates (routes/integrity.js) filters the result to `tier ===
 * 'auto'` itself before merging anything — this function never decides
 * who's allowed to auto-merge, only who's worth mentioning. O(n^2) — fine
 * for an HVAC tenant's customer list; the caller caps `customers` before
 * calling this (routes/integrity.js).
 */
export function findDuplicateCustomerPairs(customers, { threshold = CUSTOMER_SUGGEST_THRESHOLD, ctx } = {}) {
  const list = Array.isArray(customers) ? customers : [];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a?.id || !b?.id || a.id === b.id) continue;
      const { score, tier, evidence, reason } = evaluateCustomerMatch(a, b, ctx);
      if (score < threshold) continue;
      const [keep, drop] = pickKeepDrop(a, b);
      pairs.push({ keepId: keep.id, dropId: drop.id, score, tier, evidence, reason });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

// --------------------------------------------------------------- documents

/** Does this document look like it should have a customer link but doesn't?
 *  `linkedToCustomer` is true when ANY path already resolves this document to
 *  a customer — a direct document_entity_links row to a customer entity, OR
 *  a link/extraction to equipment whose entities.customer_id is set. */
export function isUnlinkedDocument({ hasCustomerName, hasAddress, linkedToCustomer }) {
  return !!(hasCustomerName || hasAddress) && !linkedToCustomer;
}

/** Equipment that names a customer in its OWN data (service_address /
 *  customer_name — findOrCreateEquipment's fill-once fields) but has no
 *  customer_id set. */
export function isEquipmentMissingCustomer({ hasCustomerId, hasCustomerNameOrAddress }) {
  return !hasCustomerId && !!hasCustomerNameOrAddress;
}

/**
 * A document whose extractions carry more distinct serial_number VALUES than
 * it has distinct linked equipment entities — the multi-unit under-linking
 * bug (C), for a document extracted before per-unit grouping existed.
 */
export function multiUnitUnderLinked({ serialValues, linkedEquipmentCount }) {
  const distinct = new Set(
    (serialValues ?? []).map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean)
  );
  return distinct.size >= 2 && distinct.size > (linkedEquipmentCount ?? 0);
}

// ------------------------------------------------------------- unit_index --
// M3-config/19 (extractions.unit_index). Pure grouping/backfill-planning
// logic for a multi-unit document's STORED extraction rows — the read-time
// counterpart to extractFields.js's groupFieldsByUnit, which groups a fresh
// model response before anything is written. Used by
// api/_lib/routes/integrity.js's createMissingUnits / backfill.

/** Fields that describe ONE piece of equipment, not the whole document —
 *  duplicated from extractFields.js's UNIT_SCOPED_FIELDS (kept here rather
 *  than imported so this file stays dependency-free; see the module header). */
const UNIT_SCOPED_KEYS = [
  'equipment_id', 'serial_number', 'model', 'manufacturer',
  'equipment_type', 'tonnage', 'refrigerant', 'installation_date',
];

/**
 * Assign each DISTINCT serial_number value a 1-based unit number by order of
 * FIRST APPEARANCE in `serialValues` (already appearance-ordered — the
 * caller passes rows in id/insertion order). Returns a
 * Map<lowercasedValue, unitNumber>, or null when there are fewer than two
 * distinct values (nothing to number).
 */
export function unitIndexAssignments(serialValues) {
  const seen = new Map();
  let next = 1;
  for (const raw of serialValues ?? []) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v) continue;
    if (!seen.has(v)) { seen.set(v, next++); }
  }
  return seen.size >= 2 ? seen : null;
}

/**
 * Which existing extraction rows should be stamped with a unit_index, and
 * what value — a document with >=2 distinct serial_number values but none
 * tagged yet (a row written before M3-config/19, or before
 * extractDocument.js started persisting the tag). `rows`:
 * [{id, field_key, value, unit_index}] for ONE document, in appearance
 * (id/insertion) order, `value` already resolved (corrected_value ?? value).
 *
 * Assigns serial_number rows by order of appearance (unitIndexAssignments);
 * every OTHER unit-scoped field is paired positionally only when its row
 * count matches the serial count exactly — otherwise left untagged rather
 * than guessing which unit it belongs to. Returns [] (nothing to do) once
 * any serial row already carries a unit_index, or there's nothing to group —
 * so applying this plan twice is a no-op the second time.
 */
export function unitIndexBackfillPlan(rows) {
  const list = (rows ?? []).filter((r) => r && r.field_key && r.value != null && String(r.value).trim() !== '');
  const serialRows = list.filter((r) => r.field_key === 'serial_number');
  if (serialRows.some((r) => r.unit_index != null)) return [];

  const assignments = unitIndexAssignments(serialRows.map((r) => r.value));
  if (!assignments) return [];

  const plan = [];
  for (const r of serialRows) {
    const idx = assignments.get(String(r.value).trim().toLowerCase());
    if (idx) plan.push({ id: r.id, unitIndex: idx });
  }
  const distinctCount = assignments.size;
  for (const key of UNIT_SCOPED_KEYS) {
    if (key === 'serial_number') continue;
    const keyRows = list.filter((r) => r.field_key === key);
    if (keyRows.length !== distinctCount) continue;
    keyRows.forEach((r, i) => plan.push({ id: r.id, unitIndex: i + 1 }));
  }
  return plan;
}

/**
 * Group a document's extraction rows into per-unit buckets for
 * `createMissingUnits`. `rows`: [{field_key, value, unit_index}], `value`
 * already resolved (corrected_value ?? value). Groups by the stored
 * unit_index when any serial_number row carries one (exact — no guessing);
 * otherwise falls back to the same order-of-appearance + positional-pairing
 * rule as unitIndexBackfillPlan, for rows unit_index still doesn't cover.
 * Returns [{index, facts}], sorted by index, one entry per unit that has a
 * serial_number.
 */
export function groupExtractionRowsByUnit(rows) {
  const list = (rows ?? []).filter((r) => r && r.field_key && r.value != null && String(r.value).trim() !== '');
  const serialRows = list.filter((r) => r.field_key === 'serial_number');
  const hasUnitIndex = serialRows.some((r) => r.unit_index != null);

  if (hasUnitIndex) {
    const byIndex = new Map();
    for (const r of list) {
      if (r.unit_index == null) continue;
      if (!byIndex.has(r.unit_index)) byIndex.set(r.unit_index, {});
      byIndex.get(r.unit_index)[r.field_key] = r.value;
    }
    return [...byIndex.entries()]
      .filter(([, facts]) => facts.serial_number)
      .sort((a, b) => a[0] - b[0])
      .map(([index, facts]) => ({ index, facts }));
  }

  const assignments = unitIndexAssignments(serialRows.map((r) => r.value));
  if (!assignments) return [];
  const buckets = new Map([...assignments.values()].map((i) => [i, {}]));
  for (const r of serialRows) {
    const idx = assignments.get(String(r.value).trim().toLowerCase());
    if (idx) buckets.get(idx).serial_number = r.value;
  }
  const distinctCount = assignments.size;
  for (const key of UNIT_SCOPED_KEYS) {
    if (key === 'serial_number') continue;
    const keyRows = list.filter((r) => r.field_key === key);
    if (keyRows.length !== distinctCount) continue;
    keyRows.forEach((r, i) => { buckets.get(i + 1)[key] = r.value; });
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([index, facts]) => ({ index, facts }));
}

// ------------------------------------------------------------------- merge

// Keys unioned as arrays rather than fill-or-keep scalars.
const ARRAY_UNION_KEYS = ['aliases', 'former_numbers'];
const isBlank = (v) => v == null || String(v).trim() === '';

/**
 * Fill-only coalesce of a merge's two `entities.data` JSON blobs — the
 * survivor (`keep`) never loses a value. Rules (handoffs NO-GO, bug: merge
 * silently dropped phone/email/notes present only on the dropped row):
 *   - any scalar key blank/missing on `keep` is filled from `drop` (phone,
 *     email, billing_address, service_address, ...); a key already non-blank
 *     on `keep` is never overwritten.
 *   - `aliases` and `former_numbers` are unioned (deduped, order-stable).
 *   - `notes` are concatenated (drop's notes appended on a new line) rather
 *     than fill-or-keep, so neither side's notes are lost.
 *   - `customer_name`: kept as-is when both sides agree, or filled from
 *     `drop` when `keep` has none. When `drop`'s name is strictly fuller
 *     than `keep`'s (same family, more people named — see preferFullerName),
 *     the fuller name is ADOPTED onto the survivor and `keep`'s original
 *     (shorter) name is preserved as an alias instead. Any other differing
 *     name (including an unrelated one, e.g. a company name) is preserved as
 *     an alias, never overwritten.
 *   - `service_address`/`billing_address`: fill-only when one side is blank;
 *     when BOTH name the same building (preferFullerAddress), the fuller
 *     string is adopted even though `keep`'s wasn't blank — a terse address
 *     is never allowed to shadow a fuller one for the same place.
 * Pure — no db, no mutation of the inputs. `ctx`, optional (round-3 fix,
 * 2026-09-21): the same shop-contact context isLikelyShopPhone/isLikelyShopEmail
 * take — when passed, a `phone`/`email` on `drop` that looks like a shop
 * value is never filled into a blank `keep.phone`/`keep.email`. Without this,
 * merging a duplicate customer that still carries the leaked shop number
 * back INTO one that had already been cleaned up (stripShopContact) would
 * silently reintroduce it. Left undefined, every existing caller keeps its
 * old behavior.
 */
const ADDRESS_KEYS = ['service_address', 'billing_address'];

export function coalesceEntityData(keep, drop, ctx) {
  const k = { ...(keep ?? {}) };
  const d = drop ?? {};

  for (const [key, value] of Object.entries(d)) {
    if (key === 'notes' || key === 'customer_name' || ARRAY_UNION_KEYS.includes(key) || ADDRESS_KEYS.includes(key)) continue;
    if (ctx && key === 'phone' && isLikelyShopPhone(value, ctx)) continue;
    if (ctx && key === 'email' && isLikelyShopEmail(value, ctx)) continue;
    if (isBlank(k[key]) && !isBlank(value)) k[key] = value;
  }

  for (const key of ADDRESS_KEYS) {
    if (!isBlank(d[key])) k[key] = preferFullerAddress(k[key], d[key]);
  }

  for (const key of ARRAY_UNION_KEYS) {
    const merged = [...new Set([
      ...(Array.isArray(k[key]) ? k[key] : []).map(String),
      ...(Array.isArray(d[key]) ? d[key] : []).map(String),
    ])];
    if (merged.length) k[key] = merged;
  }

  const keepNotes = String(k.notes ?? '').trim();
  const dropNotes = String(d.notes ?? '').trim();
  if (dropNotes && dropNotes !== keepNotes) k.notes = keepNotes ? `${keepNotes}\n${dropNotes}` : dropNotes;

  const keepName = String(k.customer_name ?? '').trim();
  const dropName = String(d.customer_name ?? '').trim();
  if (!keepName && dropName) {
    k.customer_name = dropName;
  } else if (dropName && dropName.toLowerCase() !== keepName.toLowerCase()) {
    const chosen = preferFullerName(keepName, dropName);
    const aliases = new Set((Array.isArray(k.aliases) ? k.aliases : []).map(String));
    if (chosen.toLowerCase() === dropName.toLowerCase()) {
      // drop's name is the fuller one (e.g. "Ray & Linda Castillo" over
      // "Castillo") — adopt it, keep the shorter name as an alias instead
      // of discarding it.
      k.customer_name = chosen;
      aliases.add(keepName);
    } else {
      aliases.add(dropName);
    }
    k.aliases = [...aliases];
  }

  return k;
}

// -------------------------------------------------------------------- csv

// A cell starting with one of these (after leading spaces) is a live formula
// to Excel/Sheets when the CSV is opened there — DDE/formula injection. A
// leading single quote neutralizes it without changing the visible value.
// Tradeoff accepted: a genuine negative number ("-42.50") also gets quoted;
// safety over a cosmetic apostrophe.
const DANGEROUS_LEADING = /^[=+\-@\t\r]/;

/** RFC4180-ish cell quoting: wrap in quotes when the value contains a comma,
 *  quote, or newline; a literal quote doubles. null/undefined -> ''. */
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (DANGEROUS_LEADING.test(s.replace(/^ +/, ''))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values) {
  return values.map(csvCell).join(',') + '\r\n';
}
