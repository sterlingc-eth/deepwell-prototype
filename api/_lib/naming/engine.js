/**
 * DOCUMENT NAMING ENGINE (Round 12, G3) — M3-config/41-document-display-names.sql.
 *
 * "Could Donovan rename records something simple, clear and legible once it confirms what it
 * is? e.g. if it's the warranty it should say Warranty instead of 34534895.pdf." (owner ask,
 * round 12 contract). This file is the deterministic, NO-MODEL-CALL half of that: given a
 * document's confirmed type, its extracted fields, and whatever entities it is linked to, produce
 * a short human title like "Warranty · Carol Rios · Trane XR16 · Jun 12, 2025".
 *
 * NEVER GUESSES: every value in a name is either a field this document's own extraction wrote, or
 * a fact already on file for a linked entity (customer/equipment). Nothing here reads a page,
 * calls a model, or invents a value the way a from-scratch classifier would.
 *
 * `computeDisplayName` is pure and synchronous — it takes plain data in, returns a string or null
 * out, no I/O. The caller (api/_lib/naming/assign.js) is what decides WHEN to call it (type
 * confirmed) and persists the result; `dedupeDisplayName` is the second pure half, applied only
 * once the caller knows what names sibling documents already carry.
 *
 * Client mirror: src/core/documentName.ts's `deriveName` implements a smaller subset of these
 * same per-type templates for the moment BEFORE the server has classified a document (or before
 * migration 41 is pasted) — see that file's own header. The two are not required to produce byte-
 * identical strings; `documentName()` always prefers the server's `displayName` when one exists.
 */

/** Keep in sync with api/_lib/documentTypes.js's DOCUMENT_TYPES ids — duplicated here (not
 *  imported) because this file must stay import-free/pure for scripts/verify-document-names.mjs's
 *  no-DB pure-function tests, and because it only needs the ids, never the classifier itself. */
export const NAMEABLE_TYPES = new Set([
  'work-order', 'invoice', 'warranty-registration', 'startup-sheet', 'permit',
  'nameplate-photo', 'maintenance-agreement', 'service-ticket', 'dispatch-note',
  'proposal-quote', 'inspection-report', 'purchase-order', 'equipment-record',
  'correspondence', 'internal',
]);

const TYPE_LABELS = {
  'work-order': 'Work order',
  invoice: 'Invoice',
  'warranty-registration': 'Warranty',
  'startup-sheet': 'Startup sheet',
  permit: 'Permit',
  'nameplate-photo': 'Nameplate photo',
  'maintenance-agreement': 'Maintenance agreement',
  'service-ticket': 'Service ticket',
  'dispatch-note': 'Dispatch note',
  'proposal-quote': 'Quote',
  'inspection-report': 'Inspection report',
  'purchase-order': 'Purchase order',
  'equipment-record': 'Equipment record',
  correspondence: 'Correspondence',
  internal: 'Shop record',
};

export const MAX_DISPLAY_NAME_LENGTH = 70;
const SEGMENT_SEP = ' · ';
const ELLIPSIS = '…';

/** Only characters safe to show in every UI surface and to store/search — letters, digits,
 *  whitespace, and a small punctuation allowlist a real name/address/amount can contain. Anything
 *  else (control characters, quotes a field's OCR mangled, stray markup) is dropped, not escaped —
 *  this is a display name, not a re-parseable value. */
function sanitizeSegment(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}\s.,'&()#$/:–—-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nonEmpty(value) {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return s.length > 0 ? s : null;
}

/** First non-empty value among several candidates (field values, then entity facts). */
function firstOf(...candidates) {
  for (const c of candidates) {
    const v = nonEmpty(c);
    if (v) return v;
  }
  return null;
}

function entityOfType(entities, type) {
  return (entities ?? []).find((e) => e && e.type === type) ?? null;
}

/** "Carol Rios" -> "Rios"; a single-word name is returned as-is. Used where a template
 *  deliberately favors brevity (maintenance agreements) over a full name. */
function surname(name) {
  const v = nonEmpty(name);
  if (!v) return null;
  const words = v.split(/\s+/);
  return words[words.length - 1];
}

/** "1240.00" / "-25.00" -> "$1,240.00" / "-$25.00". Null for anything that doesn't parse — a
 *  money field with a garbled value is left out of the name rather than shown as "$NaN". */
function formatMoney(value) {
  const v = nonEmpty(value);
  if (!v) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> 'Jun 12, 2025'; 'YYYY-MM' -> 'Jun 2025'; anything else short enough to read is
 *  passed through as-is; anything long/unparseable is left out (never shown half-garbled). */
function shortDate(value) {
  const v = nonEmpty(value);
  if (!v) return null;
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (full) {
    const [, y, m, d] = full;
    const mi = Number(m) - 1;
    if (mi >= 0 && mi < 12) return `${MONTHS[mi]} ${Number(d)}, ${y}`;
  }
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(v);
  if (monthOnly) {
    const [, y, m] = monthOnly;
    const mi = Number(m) - 1;
    if (mi >= 0 && mi < 12) return `${MONTHS[mi]} ${y}`;
  }
  return v.length <= 12 ? v : null;
}

/** An agreement/contract period ("01/01/2025 - 12/31/2025", "2025-01-01 to 2025-12-31") ->
 *  "2025–2026", or a single year when both ends fall in the same year. Reads the years out of
 *  whatever punctuation separates the two dates rather than assuming a format — the field is
 *  free text (extractFields.js's `agreement_term` spec), not a structured value. Null when fewer
 *  than one 4-digit year is present (never invents a span from nothing). */
function yearRange(value) {
  const v = nonEmpty(value);
  if (!v) return null;
  const years = [...v.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  if (years.length === 0) return null;
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? first : `${first}–${last}`;
}

/**
 * @param {{fields?: Record<string, string|null|undefined>,
 *          entities?: {type: 'customer'|'equipment'|'property'|'technician', name?: string,
 *                      address?: string, manufacturer?: string, model?: string}[]}} input
 * @returns {{customerName: ?string, address: ?string, manufacturer: ?string, model: ?string,
 *            cost: ?string, invoiceNumber: ?string, permitNumber: ?string, serviceDate: ?string,
 *            installDate: ?string, warrantyRegisteredDate: ?string, agreementTerm: ?string,
 *            reminderCustomerName: ?string}}
 */
function factsFrom({ fields = {}, entities = [] } = {}) {
  const customer = entityOfType(entities, 'customer');
  const equipment = entityOfType(entities, 'equipment');
  return {
    customerName: firstOf(fields.customer_name, customer?.name),
    address: firstOf(fields.service_address, customer?.address, equipment?.address),
    manufacturer: firstOf(fields.manufacturer, equipment?.manufacturer),
    model: firstOf(fields.model, equipment?.model),
    cost: firstOf(fields.cost),
    invoiceNumber: firstOf(fields.invoice_number),
    permitNumber: firstOf(fields.permit_number),
    serviceDate: firstOf(fields.service_date),
    installDate: firstOf(fields.installation_date),
    warrantyRegisteredDate: firstOf(fields.warranty_registered_date),
    agreementTerm: firstOf(fields.agreement_term),
    reminderCustomerName: firstOf(fields.reminder_customer_name),
  };
}

function equipmentSegment(f) {
  return firstOf([f.manufacturer, f.model].filter(Boolean).join(' '));
}

/** One ordered list of candidate segments per type, most important first — used both to BUILD
 *  the name and, when it runs long, to decide what to drop first (from the end). The label is
 *  always segments[0] and is never dropped. */
function segmentsFor(typeId, f) {
  const label = TYPE_LABELS[typeId];
  if (!label) return null;
  switch (typeId) {
    case 'work-order':
      return [label, firstOf(f.address, f.customerName), shortDate(f.serviceDate)];
    case 'invoice':
      return [
        f.invoiceNumber ? `${label} #${f.invoiceNumber}` : label,
        f.customerName, formatMoney(f.cost), shortDate(f.serviceDate),
      ];
    case 'warranty-registration':
      return [label, f.customerName, equipmentSegment(f), shortDate(firstOf(f.warrantyRegisteredDate, f.installDate))];
    case 'startup-sheet':
      return [label, f.customerName, equipmentSegment(f), shortDate(f.installDate)];
    case 'permit':
      return [
        f.permitNumber ? `${label} #${f.permitNumber}` : label,
        firstOf(f.address, f.customerName), shortDate(firstOf(f.serviceDate, f.installDate)),
      ];
    case 'nameplate-photo':
      return [label, equipmentSegment(f), f.customerName];
    case 'maintenance-agreement':
      return [label, surname(f.customerName), yearRange(f.agreementTerm)];
    case 'service-ticket':
      return [label, f.customerName, shortDate(f.serviceDate)];
    case 'dispatch-note':
      return [label, firstOf(f.customerName, f.address), shortDate(f.serviceDate)];
    case 'proposal-quote':
      return [label, f.customerName, formatMoney(f.cost), shortDate(f.serviceDate)];
    case 'inspection-report':
      return [label, firstOf(f.address, f.customerName), shortDate(f.serviceDate)];
    case 'purchase-order':
      return [
        f.invoiceNumber ? `${label} #${f.invoiceNumber}` : label,
        f.customerName, formatMoney(f.cost),
      ];
    case 'equipment-record':
      return [label, equipmentSegment(f), f.customerName];
    case 'correspondence':
      return [label, firstOf(f.customerName, f.reminderCustomerName), shortDate(f.serviceDate)];
    case 'internal':
      return [label, f.address, shortDate(firstOf(f.serviceDate, f.installDate))];
    default:
      return null;
  }
}

/** Drops trailing segments (never the label) until the joined, sanitized name fits
 *  MAX_DISPLAY_NAME_LENGTH; falls back to a hard ellipsis truncation if even the label alone
 *  (or label + the single most important detail) is too long. */
function assembleWithTruncation(segments) {
  const clean = segments.map((s) => (s == null ? null : sanitizeSegment(s))).filter((s) => s);
  if (clean.length < 2) return null; // label alone is no better than the filename

  // Never collapses below "label + one detail" (keep >= 2) — a label-only result is deliberately
  // NOT a valid outcome of this search (see the length check above); if even label + the single
  // most important detail overflows, that combination is hard-truncated below instead.
  for (let keep = clean.length; keep >= 2; keep--) {
    const candidate = clean.slice(0, keep).join(SEGMENT_SEP);
    if (candidate.length <= MAX_DISPLAY_NAME_LENGTH) return candidate;
  }
  const joined = clean.slice(0, 2).join(SEGMENT_SEP);
  return `${joined.slice(0, MAX_DISPLAY_NAME_LENGTH - 1)}${ELLIPSIS}`;
}

/**
 * Deterministic, no-model document title. Returns null when the type is not one that gets a
 * generated name (e.g. 'other' — see NAMEABLE_TYPES) or when too little is known to beat the
 * bare filename (fewer than two usable segments).
 *
 * @param {{typeId: string|null|undefined,
 *          fields?: Record<string, string|null|undefined>,
 *          entities?: {type: string, name?: string, address?: string, manufacturer?: string, model?: string}[]}} input
 * @returns {string|null}
 */
export function computeDisplayName({ typeId, fields = {}, entities = [] } = {}) {
  if (!typeId || !NAMEABLE_TYPES.has(typeId)) return null;
  const f = factsFrom({ fields, entities });
  const segments = segmentsFor(typeId, f);
  if (!segments) return null;
  return assembleWithTruncation(segments);
}

/**
 * Given a freshly computed base name and the display_names already in use among "sibling"
 * documents (same tenant + type + customer + date bucket — the store layer decides what counts
 * as a sibling; this function only disambiguates strings), appends " (2)", " (3)", … so two
 * distinct documents never show the identical title. Pure — takes a plain array/Set of strings.
 * @param {string} baseName
 * @param {Iterable<string>} existingNames
 * @returns {string}
 */
export function dedupeDisplayName(baseName, existingNames = []) {
  const used = existingNames instanceof Set ? existingNames : new Set(existingNames);
  if (!used.has(baseName)) return baseName;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseName} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return baseName; // pathological — 1000 duplicates; give up rather than loop forever
}

/** Sanitize + length-cap a single freestanding name (the manual-rename path — a person typing
 *  their own title, not a template join) — same safe-character rule as a generated name, same
 *  MAX_DISPLAY_NAME_LENGTH cap, hard ellipsis truncation instead of segment-dropping since there
 *  are no segments to drop. Returns '' for input that sanitizes away to nothing. */
export function sanitizeDisplayName(value) {
  const clean = sanitizeSegment(value);
  if (clean.length <= MAX_DISPLAY_NAME_LENGTH) return clean;
  return `${clean.slice(0, MAX_DISPLAY_NAME_LENGTH - 1)}${ELLIPSIS}`;
}

export const __internal = { sanitizeSegment, shortDate, formatMoney, yearRange, surname, segmentsFor };
