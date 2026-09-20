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

/** 'match' | 'differ' | 'unknown' (either side has no usable address). */
function compareAddresses(a, b) {
  const ka = normalizeAddressKey(a);
  const kb = normalizeAddressKey(b);
  if (!ka || !kb) return 'unknown';
  return ka === kb ? 'match' : 'differ';
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

/** 'match' | 'no-match' | 'unknown' (either side has no usable name). */
function compareNames(a, b) {
  const na = normalizeNamePlain(a);
  const nb = normalizeNamePlain(b);
  if (!na || !nb) return 'unknown';
  if (na === nb || na.includes(nb) || nb.includes(na)) return 'match'; // "Plaza Dental" / "Plaza Dental Group"
  const sa = normalizeSurname(a);
  const sb = normalizeSurname(b);
  if (sa && sb && sa === sb) return 'match';
  return 'no-match';
}

// ------------------------------------------------------------------- score

/**
 * Pure duplicate-customer score, 0..1. `a`/`b` are {name, address} — raw,
 * unnormalized text straight off a customer entity's data.
 *
 * Rules (handoffs/DATA_INTEGRITY_2026-09-20.md bug A):
 *   - addresses that normalize to DIFFERENT street lines -> always low,
 *     whatever the names say: two houses are two households
 *     ("1519 W Juniper" vs "1519 E Juniper" must never merge).
 *   - same normalized street line + matching name/surname -> high (>=0.95):
 *     the Castillo case, and "Plaza Dental Group" / "Plaza Dental".
 *   - same street line, names unrelated -> moderate-low: two different
 *     families sharing one apartment address (unit stripped) must not merge
 *     just because the street line matched.
 *   - matching name with no usable address on either side -> moderate: a
 *     hint worth a human's look, never enough to auto-merge alone.
 */
export function customerMatchScore(a, b) {
  const addr = compareAddresses(a?.address, b?.address);
  const name = compareNames(a?.name, b?.name);

  if (addr === 'differ') return 0.15;
  if (addr === 'match') return name === 'match' ? 0.97 : name === 'unknown' ? 0.6 : 0.3;
  // addr === 'unknown'
  return name === 'match' ? 0.55 : 0;
}

export const CUSTOMER_MATCH_THRESHOLD = 0.9;

/** 'C-00003' -> 3; anything unparseable sorts last (never chosen as the keep
 *  side over a real number). Local, standalone copy of the same "keep the
 *  lower number" rule as reviewStore.js's chooseSurvivorNumber — duplicated
 *  rather than imported so this file stays dependency-free and independently
 *  testable. */
function customerNumberOrdinal(customerNumber) {
  const m = typeof customerNumber === 'string' && customerNumber.match(/^C-(\d+)$/);
  return m ? Number(m[1]) : Infinity;
}

/**
 * All same-household pairs among a tenant's customers. `customers`:
 * [{id, name, address, customerNumber}]. Returns
 * [{keepId, dropId, score, reason}], keep = the lower customer_number (older
 * identity). O(n^2) — fine for an HVAC tenant's customer list; the caller
 * caps `customers` before calling this (routes/integrity.js).
 */
export function findDuplicateCustomerPairs(customers, { threshold = CUSTOMER_MATCH_THRESHOLD } = {}) {
  const list = Array.isArray(customers) ? customers : [];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a?.id || !b?.id || a.id === b.id) continue;
      const score = customerMatchScore(a, b);
      if (score < threshold) continue;
      const [keep, drop] = customerNumberOrdinal(a.customerNumber) <= customerNumberOrdinal(b.customerNumber)
        ? [a, b] : [b, a];
      pairs.push({
        keepId: keep.id,
        dropId: drop.id,
        score,
        reason: score >= 0.95 ? 'same address, matching name' : 'likely same household',
      });
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
 *   - `customer_name`: kept as-is when both sides agree or `keep` has one;
 *     a differing drop-side name is preserved as an alias, never overwritten.
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
    const aliases = new Set((Array.isArray(k.aliases) ? k.aliases : []).map(String));
    aliases.add(dropName);
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
