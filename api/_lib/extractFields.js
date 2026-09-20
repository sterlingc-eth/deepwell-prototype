/**
 * Structured field extraction over stored page text.
 *
 * The job this does, and why it is not /api/read-document's job:
 *   read-document turns bytes into `document_pages.text` — what the paper SAYS.
 *   This turns that text into `extractions` rows — what the paper MEANS, keyed
 *   by a canonical field name the rest of the product can look up by.
 *
 * Also returns a document_type classification (see documentTypes.js) — the
 * model is shown the canonical type list right in this same cacheable prompt
 * and asked to pick one, since it has already read the page text needed to
 * tell a work order from an invoice.
 *
 * Provenance is the whole point, so the write is two rows deep, exactly as the
 * schema was designed for:
 *
 *   facets      — one raw observation: the label as printed, the value as
 *                 printed, and the PAGE it was printed on
 *   extractions — the same value under a canonical field_key, pointing back at
 *                 the facet via source_facet_id
 *
 * `extractions` has no page column; `facets` does. Without that hop, a warranty
 * date in the entity screen would be a number with nothing behind it, which is
 * the one thing this product promises never to show.
 *
 * Model: page text is already text, so this is a cheap read, not OCR. Haiku is
 * the default and Sonnet is a one-variable change (EXTRACT_MODEL) if an eval
 * ever shows Haiku dropping fields.
 */
import { DOCUMENT_TYPES, DOCUMENT_TYPE_DEFINITIONS } from './documentTypes.js';

/** The canonical vocabulary. `field_key` in `extractions` is always one of these. */
export const FIELD_SPECS = [
  { key: 'equipment_id',     kind: 'text', desc: 'Internal unit or asset ID the company uses for this equipment (e.g. "Unit 3", "RTU-2"). NOT the serial number.', example: 'Printed "Unit: RTU-2" -> value "RTU-2".' },
  { key: 'serial_number',    kind: 'text', desc: 'Manufacturer serial number, exactly as printed, including dashes.', example: 'Printed "S/N: 4A7B9231-XT" -> value "4A7B9231-XT" (copy every character, including the dash).' },
  { key: 'model',            kind: 'text', desc: 'Model name or number, exactly as printed.', example: 'Printed "MODEL NO. GSX140361K" -> value "GSX140361K".' },
  { key: 'manufacturer',     kind: 'text', desc: 'Manufacturer (Carrier, Trane, Lennox, Goodman, Rheem, York, Daikin, ...).', example: 'Printed "Mfr: Goodman Mfg. Co." -> value "Goodman Mfg. Co." (leave the legal suffix in; brand matching strips it downstream).' },
  { key: 'equipment_type',   kind: 'text', desc: 'What the unit is: condenser, furnace, air handler, rooftop unit, heat pump, mini-split, boiler, water heater.', example: 'A nameplate on an outdoor unit with a compressor and no burner -> value "condenser".' },
  { key: 'tonnage',          kind: 'text', desc: 'Nominal cooling capacity as printed, e.g. "3 ton", "36,000 BTU".', example: 'Printed "CAPACITY: 3 TON" -> value "3 ton".' },
  { key: 'refrigerant',      kind: 'text', desc: 'Refrigerant type, e.g. R-410A, R-22, R-454B.', example: 'Printed "REFRIG R-410A" -> value "R-410A".' },
  { key: 'service_address',  kind: 'text', desc: 'Street address where the equipment is installed or the work was performed — NOT the contractor\'s own letterhead/header address. If the only address printed on the page is the company header (the HVAC contractor\'s own office), leave service_address empty and put that address in shop_address instead.', example: 'Printed "Service Location: 412 Elm St, Mesa AZ 85201" -> value "412 Elm St, Mesa AZ 85201". A letterhead reading "Desert Peak HVAC, 2210 E Main St, Mesa AZ 85213" with no separate service/job-site address printed anywhere -> do NOT use that address as service_address; put it in shop_address instead.' },
  { key: 'shop_address',     kind: 'text', desc: 'The HVAC CONTRACTOR\'S OWN business/letterhead address, when that is the only address printed and there is no separate customer service address. Document-scoped, not a customer fact.', example: 'A form letterhead prints "Desert Peak HVAC, 2210 E Main St, Mesa AZ 85213" and the body names no other address -> value "2210 E Main St, Mesa AZ 85213".' },
  { key: 'shop_phone',       kind: 'text', desc: 'The HVAC CONTRACTOR\'S OWN business/letterhead phone number — the office or dispatch line printed in the form header, NOT a phone number for the customer.', example: 'A form letterhead prints "Desert Peak HVAC — (480) 555-0199" -> value "(480) 555-0199", even if no other phone appears on the page.' },
  { key: 'shop_email',       kind: 'text', desc: 'The HVAC CONTRACTOR\'S OWN business/letterhead email address — the office or dispatch address printed in the form header, NOT an email for the customer.', example: 'A form letterhead prints "Desert Peak HVAC — dispatch@desertpeakhvac.com" -> value "dispatch@desertpeakhvac.com".' },
  { key: 'customer_name',    kind: 'text', desc: 'Customer or account name.', example: 'Printed "Bill To: Plaza Dental Group" -> value "Plaza Dental Group".' },
  { key: 'customer_phone',   kind: 'text', desc: 'Customer phone number, exactly as printed — NOT the contractor\'s own letterhead/header phone number (see shop_phone). A phone number that only appears once, in the form header/letterhead, with no separate customer contact line, belongs in shop_phone instead.', example: 'Printed "Ph: (480) 555-0148" next to the customer/job info -> value "(480) 555-0148". A letterhead reading "Desert Peak HVAC — (480) 555-0199" with no other phone printed anywhere -> do NOT use that number as customer_phone; put it in shop_phone instead.' },
  { key: 'customer_email',   kind: 'text', desc: 'Customer email address, exactly as printed — NOT the contractor\'s own letterhead/header email address (see shop_email). An email that only appears once, in the form header/letterhead, with no separate customer contact line, belongs in shop_email instead.', example: 'Printed "Email: office@plazadental.com" next to the customer/job info -> value "office@plazadental.com". A letterhead reading "Desert Peak HVAC — dispatch@desertpeakhvac.com" with no other email printed anywhere -> do NOT use that address as customer_email; put it in shop_email instead.' },
  { key: 'installation_date', kind: 'date', desc: 'Date the equipment was installed.', example: 'Printed "Install Date: 03/04/2024" -> value "2024-03-04". Printed "Installed 06/2021" with no day -> value "2021-06".' },
  { key: 'warranty_expires', kind: 'date', desc: 'Date the warranty expires.', example: 'Printed "Warranty valid through 3/10/2034" -> value "2034-03-10". Only return this when a DATE is actually printed — do not compute one yourself.' },
  { key: 'warranty_term',    kind: 'text', desc: 'The MANUFACTURER warranty length for the equipment itself, as printed, e.g. "10 year parts limited". NOT the service contract period — see agreement_term.', example: 'Printed "10 YEAR PARTS LIMITED WARRANTY" -> value "10 year parts limited".' },
  { key: 'agreement_term',   kind: 'text', desc: 'The service/maintenance AGREEMENT period between the customer and the HVAC company, e.g. "01/01/2025 - 12/31/2025". This is a contract duration, never the manufacturer equipment warranty — see warranty_term.', example: 'Printed "Agreement Period: 01/01/2025 - 12/31/2025" -> value "01/01/2025 - 12/31/2025".' },
  { key: 'warranty_registered_date', kind: 'date', desc: 'Date the warranty was registered with the manufacturer.', example: 'Printed "Registered on file: 05/01/2024" -> value "2024-05-01".' },
  { key: 'service_date',     kind: 'date', desc: 'Date service was performed (service reports and invoices).', example: 'Printed "Date of Service: 9/12/2025" -> value "2025-09-12".' },
  { key: 'service_type',     kind: 'text', desc: 'Preventive Maintenance, Repair, Emergency, Installation, Inspection, Startup.', example: 'Printed "Visit Type: PM" -> value "Preventive Maintenance".' },
  { key: 'technician',       kind: 'text', desc: 'Name of the technician who performed the work.', example: 'Printed "Tech: D. Ramirez" -> value "D. Ramirez".' },
  { key: 'work_performed',   kind: 'text', desc: 'One work item performed. Return one field per item, not a joined list.', repeatable: true, example: 'A checklist with "[x] Replaced capacitor" and "[x] Cleared drain line" -> two separate fields, "Replaced capacitor" and "Cleared drain line", not one joined string.' },
  { key: 'part_number',      kind: 'text', desc: 'A part number referenced on the document. One field per part.', repeatable: true, example: 'Printed "Parts used: CAP-4550, FLT-2003" -> two fields, "CAP-4550" and "FLT-2003".' },
  { key: 'cost',             kind: 'money', desc: 'Total amount charged, in dollars.', example: 'Printed "TOTAL DUE: $412.50" -> value "412.50". A printed credit/discount like "-$25.00" -> value "-25.00" (keep the sign).' },
  { key: 'labor_hours',      kind: 'number', desc: 'Labor hours billed.', example: 'Printed "Labor: 2.5 hrs" -> value "2.5".' },
  { key: 'invoice_number',   kind: 'text', desc: 'Invoice, ticket, or work-order number.', example: 'Printed "Invoice #INV-10493" -> value "INV-10493".' },
  { key: 'status',           kind: 'text', desc: 'Completed, Pending, In Progress.', example: 'A checkbox next to "Completed" is marked -> value "Completed".' },
  { key: 'notes',            kind: 'text', desc: 'A short observation the technician recorded that does not fit another field.', example: 'Handwritten "customer requested callback next week" -> value "customer requested callback next week".' },
  { key: 'permit_number',    kind: 'text', desc: 'A government or utility permit number referenced on the document.', example: 'Printed "Permit No: BP-2024-08841" -> value "BP-2024-08841".' },
];

const SPEC_BY_KEY = new Map(FIELD_SPECS.map((s) => [s.key, s]));
export const FIELD_KEYS = FIELD_SPECS.map((s) => s.key);

/** Keys where several distinct values on one document are all correct. */
const REPEATABLE = new Set(FIELD_SPECS.filter((s) => s.repeatable).map((s) => s.key));

/**
 * Keys that describe ONE piece of equipment, not the document as a whole.
 * On a multi-unit document (a maintenance agreement covering an RTU and a
 * condenser, say) these are grouped per `unit_index`; everything else
 * (customer_name, service_address, warranty_term, agreement_term, cost, ...)
 * is shared across every unit the document mentions. See groupFieldsByUnit().
 */
const UNIT_SCOPED_FIELDS = new Set([
  'equipment_id', 'serial_number', 'model', 'manufacturer',
  'equipment_type', 'tonnage', 'refrigerant', 'installation_date',
]);

/** Hard cap on how many distinct units one document's extraction can fan out
 * into — a garbled unit_index (or a model hallucinating dozens of them)
 * must not create dozens of equipment entities from one document. */
export const MAX_UNITS_PER_DOCUMENT = 25;

export const EXTRACT_TOOL = {
  name: 'extract_fields',
  description:
    'Return every field you can read directly off the supplied document pages. ' +
    'Omit any field the pages do not state. Never infer, calculate, or fill in a typical value.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: {
        type: 'string',
        enum: DOCUMENT_TYPES.map((t) => t.id),
        description: 'Which one canonical type this document is. See DOCUMENT TYPE below.',
      },
      document_type_confidence: { type: 'number', description: '0 to 1 confidence in document_type.' },
      fields: {
        type: 'array',
        description: 'One entry per value found. Omit fields the document does not state.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: FIELD_KEYS, description: 'Which canonical field this value is.' },
            value: { type: 'string', description: 'The value. Dates as YYYY-MM-DD, or YYYY-MM if only the month and year are printed. Money and hours as bare numbers with no symbols or commas. Everything else exactly as printed.' },
            page_no: { type: 'number', description: 'The page number, from the [page N] marker above the text this came from.' },
            verbatim: { type: 'string', description: 'The short phrase on the page this was read from, copied exactly. Used to show the user where the value came from.' },
            confidence: { type: 'number', description: '0 to 1. Below 0.6 means the text was ambiguous, abbreviated, or partly illegible.' },
            unit_index: { type: 'number', description: 'Only for documents covering MULTIPLE pieces of equipment: which unit (1, 2, 3, ...) this field belongs to, so per-unit fields (serial_number, model, equipment_type, tonnage, installation_date) can be grouped correctly. Leave out for single-unit documents and for facts that apply to the whole document (customer_name, service_address, warranty_term, agreement_term, ...).' },
          },
          required: ['key', 'value', 'page_no', 'confidence'],
        },
      },
      uncertain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Field keys the document seems to mention but that you could not read confidently.',
      },
    },
    required: ['document_type', 'fields'],
  },
};

// Each field's worked example is included below its description — this is
// the "FIELD_SPECS guide with examples per field" the 2026-09-20 cost work
// added (see promptCache.js): it is what pushes this stable prompt above
// Haiku's 2048-token caching minimum, and it is also just a better field
// guide — a model told the exact input->output shape for "10 year parts
// limited" vs. a computed "warranty_expires" makes fewer of the mistakes
// FIELD_SPECS' own descriptions have to warn about in prose alone.
const FIELD_GUIDE = FIELD_SPECS.map((s) => `- ${s.key}: ${s.desc}${s.example ? `\n    e.g. ${s.example}` : ''}`).join('\n');
const DOCUMENT_TYPE_GUIDE = DOCUMENT_TYPES.map((t) => `- ${t.id}: ${DOCUMENT_TYPE_DEFINITIONS[t.id] ?? ''}`).join('\n');

export function buildExtractPrompt(pages, documentType) {
  const body = pages.map((p) => `[page ${p.page_no}]\n${p.text}`).join('\n\n');
  return `Below is the full text of a ${documentType || 'document'} belonging to an HVAC company, one page at a time.

${body}

Read the pages and return every field the text actually states, using the extract_fields tool.

FIELDS:
${FIELD_GUIDE}

DOCUMENT TYPE — pick exactly the one id that best fits this document:
${DOCUMENT_TYPE_GUIDE}

Rules:
- Copy serial numbers, model numbers, part numbers and dollar amounts character for character. They are what this document will be searched by.
- page_no must be the page the value appears on, taken from the [page N] marker above it.
- If the document does not state a field, leave it out. An omitted field is correct; a guessed one is a defect.
- Do not calculate. If the warranty term is "10 year" and the install date is 2024-03-04 but no expiry is printed, return warranty_term and installation_date and NOT warranty_expires.
- If a field appears more than once with conflicting values, return each occurrence with its own page_no and let confidence reflect the conflict.
- If only the month and year are printed for a date (e.g. "installed 06/2021" with no day), return it as YYYY-MM. Do not guess a day.
- If this document covers more than one piece of equipment, tag equipment_id, serial_number, model, manufacturer, equipment_type, tonnage, refrigerant and installation_date with unit_index (1, 2, 3, ...) so each unit's facts stay together. Fields that apply to the whole document (customer_name, service_address, shop_address, shop_phone, shop_email, warranty_term, agreement_term, cost, ...) do not need unit_index.
- customer_phone/customer_email are the CUSTOMER's own contact info, never the contractor's own letterhead phone/email. If the only phone or email on the page is the one printed in the company's own header/letterhead, with no separate line for the customer, record it as shop_phone/shop_email instead of customer_phone/customer_email.
- document_type must be exactly one id from the list above. If none clearly fits, use "other".
- document_type_confidence: 0 to 1, your confidence in that classification alone (independent of field confidences).
- OCR commonly confuses 0/O, 1/I/l, and 5/S in serial and model numbers. When the surrounding characters make one reading clearly right (a known manufacturer serial format, the same digit repeated elsewhere on the page), use it — but still lower confidence for that field rather than presenting a guess as certain.
- A subtotal, a tax line, and a total are different dollar amounts, often all on the same invoice. If only one dollar figure is printed, treat it as cost; if several are printed, prefer the one labeled total/amount due/balance due for cost, but you may still be shown only that one line depending on what the page contains.
- Do not merge two technicians' names into one field. If a document names more than one, return the one who signed or is listed first as technician and mention the others in notes.
- A document with more than one dollar figure that are line items, not a total and its components (e.g. several separate service calls listed on one recap sheet), is not this rule's "subtotal vs total" case — return each amount you can attribute to a distinct cost with its own page_no rather than guessing which one is "the" total.
- work_performed and part_number are repeatable: return one field per distinct item rather than joining them ("replaced capacitor, cleared drain" is two fields, not one). Every other field is single-valued per unit (or per document, for fields that are not unit-scoped) — if the same field appears to have two different values with no unit_index to separate them, return the one you are most confident in and note the conflict.
- A field's confidence should reflect how legible and unambiguous the specific value was, not the page as a whole — a page that is mostly clean but has one smudged digit in the serial number gets a high-confidence customer_name and a lower-confidence serial_number, not one blended score for both.`;
}

/* ---------------------------------------------------------------- normalize */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Coerce a date to YYYY-MM-DD, or return null.
 *
 * Deliberately not `new Date(s)`: that parses "13/04/2024" as a valid date in
 * some runtimes, silently turns "Unit 3" into a date in others, and treats a
 * bare YYYY-MM-DD as UTC midnight, which prints as the previous day anywhere
 * west of Greenwich — including Mesa, where this is being built.
 */
/**
 * Some fields record something that ALREADY HAPPENED. A unit cannot have been
 * installed next year, and a warranty cannot have been registered in 2030.
 *
 * Nothing checked this: normalizeDate validates that a date is a real calendar
 * date, and every year from 1900 to 2200 is real. So a document asserting
 * "installation_date: 2030-01-01" for a brand with verified rules produced a
 * complete, internally consistent, entirely fictional warranty — a registration
 * deadline, a term, an expiry, all computed correctly from a date that had not
 * happened. Wrong in the most convincing possible way.
 *
 * A generous grace window, because a clock can be wrong and a document can be
 * dated the day after it was scanned somewhere across a date line.
 */
const BACKWARD_LOOKING_FIELDS = new Set([
  'installation_date', 'warranty_registered_date', 'service_date',
]);
const FUTURE_GRACE_DAYS = 2;

export function isFutureDate(ymd, today = new Date().toISOString().slice(0, 10)) {
  if (typeof ymd !== 'string' || typeof today !== 'string') return false;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + FUTURE_GRACE_DAYS);
  return ymd > limit.toISOString().slice(0, 10);
}

export function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  // US order. HVAC paperwork in Arizona is month-first; 04/13/2024 confirms it.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    let [, a, b, y] = m;
    let mo = +a, day = +b;
    if (mo > 12 && day <= 12) { mo = +b; day = +a; } // unambiguously day-first
    return ymd(+y, mo, day);
  }

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? ymd(+m[3], mo, +m[2]) : null;
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? ymd(+m[3], mo, +m[1]) : null;
  }

  // Month-precision only: no day was ever printed ("installed 06/2021"). Real
  // HVAC paperwork does this constantly for install dates on multi-year-old
  // equipment. Returning null here (as this used to) throws the whole fact
  // away — an install month is the one thing warrantyRules can still compute
  // an alert tier from, so it is kept as YYYY-MM rather than discarded or
  // guessed into a fake day.
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return ym(+m[1], +m[2]);

  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) return ym(+m[2], +m[1]);

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? ym(+m[2], mo) : null;
  }

  return null;
}

function ym(y, mo) {
  if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12)) return null;
  return `${y}-${String(mo).padStart(2, '0')}`;
}

function ymd(y, mo, d) {
  if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  // Reject 2024-02-31 and friends.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A real thousands-comma is 1-3 leading digits, then groups of exactly 3.
// Anything else that merely CONTAINS commas is not a formatted number, it is
// punctuation from something else the model concatenated (three line items
// read as one string, a list, etc.) and coercing it fabricates a value that
// looks precise and is not. "150,200,75" fails this — good, it should.
const COMMA_NUMBER = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

// Above this, a number is not a plausible cost or hour count for one HVAC
// document — it is a hallucination or a transcription error — AND it is also
// well under the region where Number.prototype.toFixed starts returning
// exponential notation (>= 1e21) instead of a decimal string, which would
// otherwise get written to a money/number column as literal text like "1e+26".
// One guard removes both problems.
//
// Was 1e15, which was only ever the toFixed margin wearing the word
// "plausible": it let a garbled extraction store a cost of $999,999,999,999,999
// as a legitimate fact. 1e8 is $100,000,000 — orders of magnitude above any
// real line on any real HVAC document, and orders of magnitude below where the
// formatting problem starts.
const MAX_MAGNITUDE = 1e8;

/** Strip $ and trailing noise from a number. Returns a string or null. */
export function normalizeNumber(raw, { money }) {
  // Only a string or a bare number is a value, not something with a
  // toString() that HAPPENS to look numeric. normalizeFields already screens
  // this before calling in; this guard makes normalizeNumber safe to call
  // directly too, since it's exported and this is the one function this whole
  // fix exists to make trustworthy.
  if (raw != null && typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw ?? '').trim();
  s = s.replace(/^\$\s*/, '').replace(/\s*(hrs?|hours?|usd)$/i, '').trim();

  let numeric;
  if (COMMA_NUMBER.test(s)) numeric = s.replace(/,/g, '');
  else if (PLAIN_NUMBER.test(s)) numeric = s;
  else return null;

  const n = Number(numeric);
  if (!Number.isFinite(n) || Math.abs(n) >= MAX_MAGNITUDE) return null;
  return money ? n.toFixed(2) : String(n);
}

/** Strip control characters a text column should never hold. NUL (0x00) is
 * fatal to Postgres TEXT — it rejects the whole write, not just the byte —
 * and the rest are junk no field value or transcribed page has business
 * carrying. Tab, newline and carriage return are left alone; real documents
 * have them. */
export function stripControlChars(s) {
  // Written with explicit escapes on purpose: a copy of this regex with the
  // raw control bytes inline was once mangled into a literal space-to-hyphen
  // range by a file transfer, and stripped every space from page text.
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const MAX_VALUE_CHARS = 500;

/**
 * Turn whatever the model returned into rows we are willing to store.
 *
 * Everything that cannot be normalized is dropped, not stored as-is. A
 * warranty_expires of "sometime next spring" in the database is worse than no
 * warranty_expires, because the entity screen would render it as a fact.
 */
export function normalizeFields(rawFields, { pageCount, today } = {}) {
  const kept = [];
  const dropped = [];

  for (const f of Array.isArray(rawFields) ? rawFields : []) {
    const key = String(f?.key ?? '').trim();
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) { dropped.push({ key, reason: 'unknown field' }); continue; }

    // A value that isn't a string or number (an object, an array, ...) has no
    // business becoming a stored fact. String(rawValue) on an object silently
    // yields the literal text "[object Object]" — indistinguishable from a
    // real value once it's in the extractions table — so this is a drop, not
    // a coercion.
    const rawValue = f?.value;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      dropped.push({ key, reason: `non-string value (${typeof rawValue})` });
      continue;
    }
    let value = stripControlChars(String(rawValue)).trim().slice(0, MAX_VALUE_CHARS);
    if (!value) { dropped.push({ key, reason: 'empty' }); continue; }

    if (spec.kind === 'date') {
      const d = normalizeDate(value);
      if (!d) { dropped.push({ key, reason: `unparseable date "${value}"` }); continue; }
      // A record of something that already happened cannot be dated in the
      // future. Dropped rather than clamped: we do not know what the real date
      // was, and a guess here becomes a warranty deadline downstream.
      if (BACKWARD_LOOKING_FIELDS.has(key) && isFutureDate(d, today)) {
        dropped.push({ key, reason: `date is in the future ("${d}")` });
        continue;
      }
      value = d;
    } else if (spec.kind === 'money' || spec.kind === 'number') {
      const n = normalizeNumber(value, { money: spec.kind === 'money' });
      if (n === null) { dropped.push({ key, reason: `unparseable number "${value}"` }); continue; }
      value = n;
    }

    let confidence = Number(f?.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));

    let pageNo = Number(f?.page_no);
    if (!Number.isInteger(pageNo) || pageNo < 1) pageNo = null;
    // A page number outside the document is a hallucinated citation. Keep the
    // value, drop the citation — better an uncited fact than a false one.
    if (pageNo != null && pageCount && pageNo > pageCount) pageNo = null;

    // Only meaningful for UNIT_SCOPED_FIELDS (see dedupe()); carried through
    // for every field regardless, since it's harmless where it isn't used
    // (replaceDocumentFields ignores unrecognized properties on a field row).
    let unitIndex = Number(f?.unit_index);
    unitIndex = Number.isInteger(unitIndex) && unitIndex >= 1 && unitIndex <= MAX_UNITS_PER_DOCUMENT
      ? unitIndex
      : null;

    kept.push({
      field_key: key,
      value,
      confidence,
      page_no: pageNo,
      verbatim: stripControlChars(String(f?.verbatim ?? '')).trim().slice(0, MAX_VALUE_CHARS) || null,
      unit_index: unitIndex,
    });
  }

  return { fields: dedupe(kept), dropped };
}

/**
 * One value per field, except where several are legitimately true.
 *
 * Non-repeatable keys keep the highest-confidence reading; ties go to the
 * earlier page, because on HVAC paperwork the plate data is printed before the
 * summary that restates it, and the plate is the one that is right.
 *
 * UNIT_SCOPED_FIELDS are the second exception: a document naming two units
 * (unit_index 1 and 2) legitimately has two "best" serial_number readings,
 * one per unit — collapsing them to one globally is exactly the bug that
 * threw away every RTU but the first on a multi-unit maintenance agreement.
 * These still dedupe, just per (field_key, unit_index) instead of per
 * field_key alone; a field with no unit_index still collapses globally,
 * which is the entire single-unit-document case.
 */
function dedupe(fields) {
  const best = new Map();
  const out = [];

  for (const f of fields) {
    if (REPEATABLE.has(f.field_key)) {
      const id = `${f.field_key}::${f.value.toLowerCase()}`;
      if (best.has(id)) continue;
      best.set(id, f);
      out.push(f);
      continue;
    }
    const groupKey = UNIT_SCOPED_FIELDS.has(f.field_key) && f.unit_index != null
      ? `${f.field_key}::unit${f.unit_index}`
      : f.field_key;
    const prev = best.get(groupKey);
    if (!prev) { best.set(groupKey, f); continue; }
    const better =
      f.confidence > prev.confidence ||
      (f.confidence === prev.confidence && (f.page_no ?? 1e9) < (prev.page_no ?? 1e9));
    if (better) best.set(groupKey, f);
  }

  for (const f of best.values()) if (!REPEATABLE.has(f.field_key)) out.push(f);
  return out.sort((a, b) => FIELD_KEYS.indexOf(a.field_key) - FIELD_KEYS.indexOf(b.field_key));
}

/**
 * Group normalized fields (the array normalizeFields() returns) into
 * per-unit buckets for extractDocument.js's multi-unit handling.
 *
 * Pure, no I/O. Returns `{ shared, units }`:
 *   - `shared`: {field_key: value} for every field that applies to the whole
 *     document (customer_name, service_address, warranty_term,
 *     agreement_term, cost, ... — anything not in UNIT_SCOPED_FIELDS, plus
 *     any UNIT_SCOPED field the model didn't tag with a unit_index).
 *   - `units`: [{index, facts}], sorted by index, each `facts` a
 *     {field_key: value} map merging `shared` with that unit's own
 *     UNIT_SCOPED values — ready to pass straight into findOrCreateEquipment.
 *
 * A document with no unit_index anywhere (the ordinary case — nearly every
 * document) degrades to exactly one synthetic unit at index 1 carrying every
 * fact, which is byte-for-byte what extractDocument.js already did before
 * multi-unit support existed. Capped at MAX_UNITS_PER_DOCUMENT.
 */
export function groupFieldsByUnit(fields) {
  const shared = {};
  const perUnit = new Map();

  for (const f of Array.isArray(fields) ? fields : []) {
    if (UNIT_SCOPED_FIELDS.has(f.field_key) && f.unit_index != null) {
      if (!perUnit.has(f.unit_index)) perUnit.set(f.unit_index, {});
      perUnit.get(f.unit_index)[f.field_key] = f.value;
    } else {
      shared[f.field_key] = f.value;
    }
  }

  const units = perUnit.size === 0
    ? [{ index: 1, facts: { ...shared } }]
    : [...perUnit.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, MAX_UNITS_PER_DOCUMENT)
        .map(([index, facts]) => ({ index, facts: { ...shared, ...facts } }));

  return { shared, units };
}

/**
 * Collapse exact (field_key, value) duplicates immediately before
 * db.replaceDocumentFields — which throws on them, since its CTE joins each
 * new extraction back to its facet on that exact pair, and a duplicate would
 * make the join fan out silently.
 *
 * A multi-unit document can legitimately produce this: RTU-1 and RTU-2 on
 * the same rooftop are often the identical model number. groupFieldsByUnit()
 * above needs both rows kept (they belong to different units); the database
 * write does not care which unit a `model` fact came from, only that it does
 * not try to insert the same fact twice. Keeps the first (highest-confidence,
 * per dedupe()'s own ordering) occurrence.
 */
export function collapseDuplicateValues(fields) {
  const seen = new Set();
  const out = [];
  for (const f of fields ?? []) {
    const pair = `${f.field_key}\u0000${f.value}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push(f);
  }
  return out;
}

/* ------------------------------------------------------------ page budgeting */

/** Hard ceiling on what we will send in one extraction call. */
export const MAX_PROMPT_CHARS = 60_000;

// Below this many non-whitespace characters, a page is "clearly non-content"
// (a cover sheet, a logo/header-only page, a mostly-blank divider) UNLESS it
// still carries an identifier/date/dollar-shaped fragment — a short nameplate
// photo is exactly that exception, and must not be skipped. Pure cost cut:
// every page sent to extraction is billed input tokens whether or not it has
// anything extractable on it.
const MIN_CONTENT_CHARS = 20;

function looksLikeCoverPage(text) {
  const t = String(text ?? '').trim();
  if (t.length >= MIN_CONTENT_CHARS) return false;
  if (/\b[A-Z0-9]{2,}-?[A-Z0-9]*\d[A-Z0-9-]*\b/i.test(t)) return false; // serial/model-shaped
  if (/\$\s?\d/.test(t)) return false;
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t)) return false;
  return true;
}

/**
 * Choose which pages to send when a document is longer than one prompt.
 *
 * Not simply "the first N pages". On a 40-page maintenance packet the equipment
 * plate is on page 1 but the warranty registration is on page 37, so pages
 * carrying identifier- or date-shaped text are pulled forward ahead of prose
 * pages that would otherwise crowd them out. Page order is restored afterwards
 * so the [page N] markers still read in sequence.
 *
 * Before any of that: pages that are "clearly non-content" (looksLikeCoverPage
 * — a near-blank cover sheet, a page that's just a logo/header) are dropped
 * outright, regardless of budget, since sending them teaches extraction
 * nothing and still costs input tokens on every single call. Never lets this
 * empty out a whole document, though — a real one-page document that happens
 * to be short (a nameplate photo with only a few printed characters) falls
 * back to keeping every non-blank page it has.
 */
export function selectPages(pages, budget = MAX_PROMPT_CHARS) {
  const nonBlank = (pages ?? [])
    .filter((p) => typeof p?.text === 'string' && p.text.trim())
    .map((p) => ({ page_no: Number(p.page_no), text: p.text }));

  const contentful = nonBlank.filter((p) => !looksLikeCoverPage(p.text));
  const usable = contentful.length ? contentful : nonBlank;

  const total = usable.reduce((n, p) => n + p.text.length, 0);
  if (total <= budget) return { pages: usable, truncated: false };

  const score = (p) => {
    const t = p.text;
    let s = 0;
    if (/\b[A-Z0-9]{2,}-?[A-Z0-9]*\d[A-Z0-9-]*\b/.test(t)) s += 3;       // serial/model shaped
    if (/\b(serial|model|s\/n|m\/n)\b/i.test(t)) s += 3;
    if (/\b(warrant|expir|register)/i.test(t)) s += 3;
    if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t)) s += 2;
    if (/\$\s?\d/.test(t)) s += 1;
    if (p.page_no <= 2) s += 2;                                            // cover pages earn their place
    return s;
  };

  const ranked = [...usable].sort((a, b) => score(b) - score(a) || a.page_no - b.page_no);
  const chosen = [];
  let used = 0;
  for (const p of ranked) {
    if (used + p.text.length > budget) continue;
    chosen.push(p);
    used += p.text.length;
  }
  if (!chosen.length && usable.length) {
    chosen.push({ page_no: usable[0].page_no, text: usable[0].text.slice(0, budget) });
  }

  return { pages: chosen.sort((a, b) => a.page_no - b.page_no), truncated: true };
}
