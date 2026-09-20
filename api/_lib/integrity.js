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
 * 'equal' (same set of name tokens, any order — "Castillo, Ray" / "Ray
 *   Castillo") | 'subset' (one name's tokens are a strict subset of the
 *   other's — "Castillo" ⊂ "Ray & Linda Castillo", "Plaza Dental" ⊂ "Plaza
 *   Dental Group") | 'surname' (same last name via normalizeSurname, but
 *   NOT a subset — different first names: "John Smith" vs "Jane Smith")
 *   | 'no-match' | 'unknown' (either side has no usable name).
 * Owner rule (2026-09-20 "strict rules" follow-up): 'surname' alone is never
 * enough to auto-merge — only 'equal'/'subset' are.
 */
function compareNamesStrict(a, b) {
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
  return 'no-match';
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
 * it either way). Exported for scripts/verify-integrity.mjs.
 */
export function buildMatchEvidence(a, b) {
  const matches = [];
  const missing = [];
  const conflicts = [];
  for (const f of IDENTITY_FIELD_CHECKS) {
    const na = f.normalize(f.get(a));
    const nb = f.normalize(f.get(b));
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
  let base = bits.join(' and ') || (addrMatch ? 'same address' : 'possible match');
  base = base.charAt(0).toUpperCase() + base.slice(1);
  const missingBits = evidence.missing.map((k) => `${k} missing on one record`);
  return [base, ...missingBits].join('; ');
}

/**
 * Pure duplicate-customer evaluation. `a`/`b` are {name, address, phone?,
 * email?} — raw, unnormalized text straight off a customer entity's data.
 * Returns `{score, tier, evidence, reason}`:
 *   - HARD VETO first (owner "strict rules" follow-up, 2026-09-20): any
 *     identity field (phone/email/street/unit/city/zip) present and
 *     DIFFERING on both sides -> score 0, tier null, reason
 *     'conflict:<field>' — never a duplicate, whatever else matches.
 *   - otherwise scored by address + name relation (compareNamesStrict):
 *     same street + equal/subset name -> 0.97; same street + surname-only
 *     or name unknown -> 0.6; same street, unrelated names -> 0.3 (two
 *     families sharing a building); no usable address + equal/subset name
 *     -> 0.55 (a hint); anything else -> 0.
 *   - `tier: 'auto'` only when the street matches, the name is equal/subset
 *     (never surname-only), AND phone or email positively confirms it (or
 *     neither side has contact info to check) — see contactConfirmed.
 *     Otherwise `tier: 'suggest'` (or null when vetoed): a human decides.
 */
export function evaluateCustomerMatch(a, b) {
  const evidence = buildMatchEvidence(a, b);
  if (evidence.conflicts.length) {
    return { score: 0, tier: null, evidence, reason: `conflict:${evidence.conflicts[0]}` };
  }

  const addrMatch = evidence.matches.includes('street');
  const nameRel = compareNamesStrict(a?.name, b?.name);
  const nameIsFull = nameRel === 'equal' || nameRel === 'subset';

  let score;
  if (addrMatch) score = nameIsFull ? 0.97 : (nameRel === 'surname' || nameRel === 'unknown') ? 0.6 : 0.3;
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
export function findDuplicateCustomerPairs(customers, { threshold = CUSTOMER_SUGGEST_THRESHOLD } = {}) {
  const list = Array.isArray(customers) ? customers : [];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a?.id || !b?.id || a.id === b.id) continue;
      const { score, tier, evidence, reason } = evaluateCustomerMatch(a, b);
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
 * Pure — no db, no mutation of the inputs.
 */
export function coalesceEntityData(keep, drop) {
  const k = { ...(keep ?? {}) };
  const d = drop ?? {};

  for (const [key, value] of Object.entries(d)) {
    if (key === 'notes' || key === 'customer_name' || ARRAY_UNION_KEYS.includes(key)) continue;
    if (isBlank(k[key]) && !isBlank(value)) k[key] = value;
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
