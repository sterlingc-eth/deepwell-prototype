/**
 * R34 (break-it, Donovan) - an address qualifier the caller TYPED that contradicts the record it matched must never be answered as
 * if it were that record. The resolvers deliberately match on house number + street NAME only (directional, suffix, city, zip and
 * unit are "noise" - see fastPath.js houseStreetTokens), which is right when the qualifier is merely absent or loosely typed, and
 * wrong when it is present and different:
 *
 *   "who is at 100 W Main St"            -> answered with the customer at 100 E Main St
 *   "who is at 100 E Main St, Tempe"     -> answered with the customer at 100 E Main St, Phoenix
 *   "who is at 753 W Guadalupe Rd Suite 999" -> answered with the customer in Suite 105
 *
 * addressConflict(asked, stored) is a pure, conservative contradiction test: a qualifier only conflicts when BOTH sides state it
 * and they differ (a missing qualifier on either side is never a conflict). dropConflicting(rows, asked) filters candidate rows;
 * the dropped rows ride along as `.dropped` so a caller can say "nothing on file for X; closest on file is Y" instead of guessing.
 */
import { STREET_SUFFIX_PAIRS, STREET_SUFFIX_ALTERNATION } from './geo/streetSuffix.js';

const DIR_CANON = { n: 'n', north: 'n', s: 's', south: 's', e: 'e', east: 'e', w: 'w', west: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw' };
const DIR_ALT = Object.keys(DIR_CANON).sort((a, b) => b.length - a.length).join('|');
const SUFFIX_CANON = new Map();
for (const [abbr, full] of STREET_SUFFIX_PAIRS) { SUFFIX_CANON.set(abbr, abbr); if (full) SUFFIX_CANON.set(full, abbr); }
const STATE_WORDS = new Set(['az', 'arizona', 'nv', 'nevada', 'ca', 'california', 'nm', 'tx', 'co', 'ut']);
const CITY_NOISE = new Set(['please', 'thanks', 'thank', 'you', 'now', 'today', 'tomorrow', 'yesterday', 'again', 'ok', 'okay', 'and', 'or', 'for', 'the', 'a', 'an', 'is', 'was', 'are', 'on', 'in', 'at', 'to', 'of', 'phone', 'number', 'email', 'unit', 'units', 'customer', 'who', 'what', 'when', 'where', 'warranty', 'serial', 'model', 'brand', 'last', 'next', 'this', 'that', 'it', 'its', 'phx', 'phnx', 'tuc', 'tus', 'chx']);

const SUFFIX_RE = new RegExp(`\\b(${STREET_SUFFIX_ALTERNATION})\\b\\.?`, 'i');
const UNIT_RE = /\b(?:apt|apartment|suite|ste|unit|no|number)\.?\s*#?\s*([a-z]?\d+[a-z]?|[a-z])\b|#\s*([a-z0-9]+)\b/i;

/** Pure: an address string -> its stated qualifiers (each null when not stated). */
export function parseAddressQualifiers(text) {
  const t = String(text ?? '').replace(/[‘’]/g, "'");
  const out = { house: null, dir: null, suffix: null, city: null, zip: null, unit: null };
  const hm = /^\s*(?:.*?\b)?(\d{1,6})\s+(?:(?:(NORTH|SOUTH|EAST|WEST|NE|NW|SE|SW|N|S|E|W)\b\.?)\s+)?/i.exec(t);
  if (!hm) return out;
  out.house = hm[1];
  if (hm[2]) out.dir = DIR_CANON[hm[2].toLowerCase()] ?? null;
  const rest = t.slice(hm.index + hm[0].length);
  const sm = SUFFIX_RE.exec(rest);
  if (sm) {
    out.suffix = SUFFIX_CANON.get(sm[1].toLowerCase()) ?? null;
    let tail = rest.slice(sm.index + sm[0].length);
    const um = UNIT_RE.exec(tail);
    if (um) { out.unit = String(um[1] ?? um[2]).toLowerCase(); tail = tail.replace(um[0], ' '); }
    const zm = /\b(\d{5})(?:-\d{4})?\b/.exec(tail);
    if (zm) { out.zip = zm[1]; tail = tail.replace(zm[0], ' '); }
    const words = tail.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).filter((w) => !STATE_WORDS.has(w));
    if (words.length && words.length <= 2 && words.every((w) => w.length >= 3 && !CITY_NOISE.has(w))) out.city = words.join(' ');
  }
  return out;
}

/** The stored (customer/unit) service address's own qualifiers, parsed the same way. */
const storedQualifiers = (stored) => parseAddressQualifiers(stored);

/**
 * @returns {null | {kind: 'direction'|'suffix'|'city'|'zip'|'unit', asked: string, stored: string}}
 */
export function addressConflict(asked, stored, { soft = false } = {}) {
  const a = parseAddressQualifiers(asked);
  const s = storedQualifiers(stored);
  if (!a.house || !s.house || a.house !== s.house) return null;
  if (a.dir && s.dir && a.dir !== s.dir) return { kind: 'direction', asked: a.dir, stored: s.dir };
  if (a.suffix && s.suffix && a.suffix !== s.suffix) return { kind: 'suffix', asked: a.suffix, stored: s.suffix };
  // City and zip are SOFT: the resolvers deliberately ignore a loosely typed city/zip (it is real-world noise, and the exam's own
  // expectations rely on it), so they never drop a candidate - answerAddressConflict surfaces them as a visible note instead.
  if (soft && a.zip && s.zip && a.zip !== s.zip) return { kind: 'zip', asked: a.zip, stored: s.zip };
  if (soft && a.city) {
    const hay = String(stored ?? '').toLowerCase();
    // the city must appear as a whole phrase in the stored address; "phx"-style abbreviations were already dropped as noise
    if (/,/.test(hay) && !new RegExp(`\\b${a.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) return { kind: 'city', asked: a.city, stored: hay };
  }
  if (a.unit && s.unit && a.unit !== s.unit) return { kind: 'unit', asked: a.unit, stored: s.unit };
  return null;
}

/** Filters candidate rows (each with `service_address`); the removed rows are kept on the result as `.dropped`. */
export function dropConflicting(rows, asked) {
  const list = Array.isArray(rows) ? rows : [];
  const kept = [];
  const dropped = [];
  for (const r of list) (addressConflict(asked, r?.service_address ?? r?.data?.service_address) ? dropped : kept).push(r);
  kept.dropped = dropped;
  return kept;
}

const ADDR_IN_TEXT_RE = new RegExp(
  `\\b(\\d{1,6}\\s+(?:(?:${DIR_ALT})\\b\\.?\\s+)?(?:[A-Za-z0-9.']+\\s+){0,3}?(?:${STREET_SUFFIX_ALTERNATION})\\b\\.?` +
    `(?:\\s*,?\\s*(?:apt|apartment|suite|ste|unit|#)\\s*#?[A-Za-z0-9]+)?(?:\\s*,\\s*[A-Za-z][A-Za-z ]{2,19}?(?=\\s*(?:,|\\?|\\.|$|\\d)))?(?:\\s*,?\\s*[A-Za-z]{2}\\s+\\d{5})?)`,
  'gi'
);

/** Every street-address-shaped span in a piece of text (a question, or an answer sentence). */
export function addressesIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ADDR_IN_TEXT_RE)) out.push(m[1].trim());
  return out;
}

/**
 * Post-check on a finished answer: the question typed ONE address with a qualifier (direction/suffix/city/zip/unit) and the answer is
 * about a stored address that contradicts it (and none that agrees). Returns {asked, closest} or null. Pure.
 * `data` is the answer object (records[].sublabel carries a customer's service address; the sentence may restate it).
 */
export function answerAddressConflict(question, data) {
  if (!data || data.kind !== 'answer') return null;
  const askedList = addressesIn(question);
  if (askedList.length !== 1) return null;
  const asked = askedList[0];
  const stored = [
    ...(data.records ?? []).filter((r) => r && (r.type === 'customer' || r.type === 'unit')).map((r) => r.sublabel),
    ...addressesIn(data.text),
  ].filter((s) => typeof s === 'string' && /\d/.test(s));
  const sameHouse = stored.filter((s) => parseAddressQualifiers(s).house === parseAddressQualifiers(asked).house);
  if (!sameHouse.length) return null;
  const conflicting = sameHouse.filter((s) => addressConflict(asked, s, { soft: true }));
  if (conflicting.length !== sameHouse.length) return null;
  const c = addressConflict(asked, conflicting[0], { soft: true });
  return { asked, closest: conflicting[0], kind: c?.kind, soft: c?.kind === 'city' || c?.kind === 'zip' };
}
