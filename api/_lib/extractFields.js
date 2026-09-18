/**
 * Structured field extraction over stored page text.
 *
 * The job this does, and why it is not /api/read-document's job:
 *   read-document turns bytes into `document_pages.text` — what the paper SAYS.
 *   This turns that text into `extractions` rows — what the paper MEANS, keyed
 *   by a canonical field name the rest of the product can look up by.
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

/** The canonical vocabulary. `field_key` in `extractions` is always one of these. */
export const FIELD_SPECS = [
  { key: 'equipment_id',     kind: 'text', desc: 'Internal unit or asset ID the company uses for this equipment (e.g. "Unit 3", "RTU-2"). NOT the serial number.' },
  { key: 'serial_number',    kind: 'text', desc: 'Manufacturer serial number, exactly as printed, including dashes.' },
  { key: 'model',            kind: 'text', desc: 'Model name or number, exactly as printed.' },
  { key: 'manufacturer',     kind: 'text', desc: 'Manufacturer (Carrier, Trane, Lennox, Goodman, Rheem, York, Daikin, ...).' },
  { key: 'equipment_type',   kind: 'text', desc: 'What the unit is: condenser, furnace, air handler, rooftop unit, heat pump, mini-split, boiler, water heater.' },
  { key: 'tonnage',          kind: 'text', desc: 'Nominal cooling capacity as printed, e.g. "3 ton", "36,000 BTU".' },
  { key: 'refrigerant',      kind: 'text', desc: 'Refrigerant type, e.g. R-410A, R-22, R-454B.' },
  { key: 'service_address',  kind: 'text', desc: 'Street address where the equipment is installed.' },
  { key: 'customer_name',    kind: 'text', desc: 'Customer or account name.' },
  { key: 'installation_date', kind: 'date', desc: 'Date the equipment was installed.' },
  { key: 'warranty_expires', kind: 'date', desc: 'Date the warranty expires.' },
  { key: 'warranty_term',    kind: 'text', desc: 'Warranty length as printed, e.g. "10 year parts limited".' },
  { key: 'warranty_registered_date', kind: 'date', desc: 'Date the warranty was registered with the manufacturer.' },
  { key: 'service_date',     kind: 'date', desc: 'Date service was performed (service reports and invoices).' },
  { key: 'service_type',     kind: 'text', desc: 'Preventive Maintenance, Repair, Emergency, Installation, Inspection, Startup.' },
  { key: 'technician',       kind: 'text', desc: 'Name of the technician who performed the work.' },
  { key: 'work_performed',   kind: 'text', desc: 'One work item performed. Return one field per item, not a joined list.', repeatable: true },
  { key: 'part_number',      kind: 'text', desc: 'A part number referenced on the document. One field per part.', repeatable: true },
  { key: 'cost',             kind: 'money', desc: 'Total amount charged, in dollars.' },
  { key: 'labor_hours',      kind: 'number', desc: 'Labor hours billed.' },
  { key: 'invoice_number',   kind: 'text', desc: 'Invoice, ticket, or work-order number.' },
  { key: 'status',           kind: 'text', desc: 'Completed, Pending, In Progress.' },
  { key: 'notes',            kind: 'text', desc: 'A short observation the technician recorded that does not fit another field.' },
];

const SPEC_BY_KEY = new Map(FIELD_SPECS.map((s) => [s.key, s]));
export const FIELD_KEYS = FIELD_SPECS.map((s) => s.key);

/** Keys where several distinct values on one document are all correct. */
const REPEATABLE = new Set(FIELD_SPECS.filter((s) => s.repeatable).map((s) => s.key));

export const EXTRACT_TOOL = {
  name: 'extract_fields',
  description:
    'Return every field you can read directly off the supplied document pages. ' +
    'Omit any field the pages do not state. Never infer, calculate, or fill in a typical value.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'One entry per value found. Omit fields the document does not state.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: FIELD_KEYS, description: 'Which canonical field this value is.' },
            value: { type: 'string', description: 'The value. Dates as YYYY-MM-DD. Money and hours as bare numbers with no symbols or commas. Everything else exactly as printed.' },
            page_no: { type: 'number', description: 'The page number, from the [page N] marker above the text this came from.' },
            verbatim: { type: 'string', description: 'The short phrase on the page this was read from, copied exactly. Used to show the user where the value came from.' },
            confidence: { type: 'number', description: '0 to 1. Below 0.6 means the text was ambiguous, abbreviated, or partly illegible.' },
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
    required: ['fields'],
  },
};

const FIELD_GUIDE = FIELD_SPECS.map((s) => `- ${s.key}: ${s.desc}`).join('\n');

export function buildExtractPrompt(pages, documentType) {
  const body = pages.map((p) => `[page ${p.page_no}]\n${p.text}`).join('\n\n');
  return `Below is the full text of a ${documentType || 'document'} belonging to an HVAC company, one page at a time.

${body}

Read the pages and return every field the text actually states, using the extract_fields tool.

FIELDS:
${FIELD_GUIDE}

Rules:
- Copy serial numbers, model numbers, part numbers and dollar amounts character for character. They are what this document will be searched by.
- page_no must be the page the value appears on, taken from the [page N] marker above it.
- If the document does not state a field, leave it out. An omitted field is correct; a guessed one is a defect.
- Do not calculate. If the warranty term is "10 year" and the install date is 2024-03-04 but no expiry is printed, return warranty_term and installation_date and NOT warranty_expires.
- If a field appears more than once with conflicting values, return each occurrence with its own page_no and let confidence reflect the conflict.`;
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

  return null;
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
  return s.replace(/[ --]/g, '');
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

    kept.push({
      field_key: key,
      value,
      confidence,
      page_no: pageNo,
      verbatim: stripControlChars(String(f?.verbatim ?? '')).trim().slice(0, MAX_VALUE_CHARS) || null,
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
    const prev = best.get(f.field_key);
    if (!prev) { best.set(f.field_key, f); continue; }
    const better =
      f.confidence > prev.confidence ||
      (f.confidence === prev.confidence && (f.page_no ?? 1e9) < (prev.page_no ?? 1e9));
    if (better) best.set(f.field_key, f);
  }

  for (const f of best.values()) if (!REPEATABLE.has(f.field_key)) out.push(f);
  return out.sort((a, b) => FIELD_KEYS.indexOf(a.field_key) - FIELD_KEYS.indexOf(b.field_key));
}

/* ------------------------------------------------------------ page budgeting */

/** Hard ceiling on what we will send in one extraction call. */
export const MAX_PROMPT_CHARS = 60_000;

/**
 * Choose which pages to send when a document is longer than one prompt.
 *
 * Not simply "the first N pages". On a 40-page maintenance packet the equipment
 * plate is on page 1 but the warranty registration is on page 37, so pages
 * carrying identifier- or date-shaped text are pulled forward ahead of prose
 * pages that would otherwise crowd them out. Page order is restored afterwards
 * so the [page N] markers still read in sequence.
 */
export function selectPages(pages, budget = MAX_PROMPT_CHARS) {
  const usable = (pages ?? [])
    .filter((p) => typeof p?.text === 'string' && p.text.trim())
    .map((p) => ({ page_no: Number(p.page_no), text: p.text }));

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
