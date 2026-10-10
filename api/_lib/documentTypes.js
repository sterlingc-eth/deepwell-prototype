/**
 * Canonical document types — single source of truth for backend, browser and
 * review (see handoffs/TEAM_BRIEF_2026-09-19.md). Everything that classifies
 * or checks completeness of a document goes through this file.
 *
 * Why this exists: the backend used to invent its own ids
 * (warranty/invoice/service_ticket/install_record/equipment_record/document)
 * while the browser's schema used a different set entirely. Neither side ever
 * matched, so every document showed "Unclassified" no matter what the
 * pipeline actually determined.
 */

export const DOCUMENT_TYPES = [
  { id: 'work-order', label: 'Work order' },
  { id: 'invoice', label: 'Invoice' },
  { id: 'warranty-registration', label: 'Warranty registration' },
  { id: 'startup-sheet', label: 'Startup sheet' },
  { id: 'permit', label: 'Permit' },
  { id: 'nameplate-photo', label: 'Nameplate photo' },
  { id: 'maintenance-agreement', label: 'Maintenance agreement' },
  { id: 'service-ticket', label: 'Service ticket' },
  { id: 'dispatch-note', label: 'Dispatch note' },
  { id: 'proposal-quote', label: 'Proposal / quote' },
  { id: 'inspection-report', label: 'Inspection report' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'equipment-record', label: 'Equipment record' },
  { id: 'correspondence', label: 'Correspondence' },
  { id: 'internal', label: 'Company record' },
  // Generic business paperwork (any industry) — added with the document-rules round, 2026-10-09.
  { id: 'receipt', label: 'Receipt' },
  { id: 'agreement', label: 'Agreement / contract' },
  { id: 'delivery-ticket', label: 'Delivery / pickup ticket' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'price-list', label: 'Price list' },
  { id: 'statement', label: 'Statement' },
  { id: 'insurance-certificate', label: 'Insurance certificate' },
  { id: 'hr-letter', label: 'HR / employment letter' },
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));
const TYPE_LABEL = new Map(DOCUMENT_TYPES.map((t) => [t.id, t.label]));

/**
 * Every stored spelling (legacy ids, underscores) that means one canonical type above — the browser's older schema
 * and earlier ingestion runs used different ids for the same real-world document ("service_report" for what this
 * file canonically calls "service-ticket", a bare "warranty" for "warranty-registration", ...). Single source of
 * truth for this codebase: scope.js's own docTypeAliases() re-exports this table instead of keeping a second copy,
 * and documentTypeLabel (below) resolves through it before looking up a label.
 *
 * Round 6 (2026-09-25): documentTypeLabel used to look a raw stored type id up directly, so a document stored as
 * "service_report" (a real, common alias — see scope.js's own TYPE_ALIASES) displayed as "Other" everywhere its
 * label was shown in an answer (scope.js's describeVisit, most visibly: "the last 3 visits at Zimmerman: ...
 * (other, tech ...)" instead of "(service report, tech ...)") — every caller would otherwise have had to remember
 * to canonicalize first, which most never did (only comparison.js already built its own local version of this map).
 */
export const DOCUMENT_TYPE_ALIASES = {
  'maintenance-agreement': ['maintenance-agreement', 'maintenance-plan'],
  'warranty-registration': ['warranty-registration', 'warranty'],
  'service-ticket': ['service-ticket', 'service-report'],
  'proposal-quote': ['proposal-quote', 'proposal', 'quote'],
  'nameplate-photo': ['nameplate-photo', 'nameplate'],
};
const CANONICAL_TYPE_ID = new Map();
for (const [canon, aliases] of Object.entries(DOCUMENT_TYPE_ALIASES)) for (const alias of aliases) CANONICAL_TYPE_ID.set(alias, canon);

const normalizeStoredTypeId = (t) => String(t ?? '').trim().toLowerCase().replace(/_/g, '-');

/** The canonical type id a stored (possibly legacy/underscored/aliased) document_type means, e.g.
 *  "service_report" -> "service-ticket". Never throws; an id this table doesn't know passes through normalized but
 *  otherwise unchanged (documentTypeLabel then falls back to "Other" for it, same as always). */
export function canonicalTypeId(typeId) {
  const n = normalizeStoredTypeId(typeId);
  return CANONICAL_TYPE_ID.get(n) ?? n;
}

/**
 * `pack` (optional, Team G industry packs): the tenant's resolved pack
 * (api/_lib/industry/index.js's packForTenant). Every function below that
 * takes one defaults to null, meaning "today's hard-coded HVAC document
 * types" — every existing 1-arg caller is byte-for-byte unchanged. A
 * plumbing/electrical/property tenant's own document-type ids/labels/
 * required-fields (including the pack's own new types — panel-schedule,
 * lease-agreement, backflow-test-certificate, ...) only ever come from a
 * caller that resolved and passed that tenant's pack.
 */
function packTypeLabel(pack, typeId) {
  return pack?.documentTypes?.find((t) => t.id === typeId)?.label;
}

export function documentTypeLabel(typeId, pack = null) {
  const canon = canonicalTypeId(typeId);
  if (pack && pack.id !== 'hvac') return packTypeLabel(pack, canon) ?? packTypeLabel(pack, 'other') ?? typeId;
  return TYPE_LABEL.get(canon) ?? TYPE_LABEL.get('other');
}

/** One-line definitions for the model's classification prompt. Static text —
 *  part of extractFields.js's cacheable prompt block, never per-document. */
export const DOCUMENT_TYPE_DEFINITIONS = {
  'work-order': 'A dispatched job: address, date, technician, and what to do — not yet completed.',
  'invoice': 'A bill for work, goods or services: a customer or vendor, a date and a total amount. Credit memos belong here.',
  'warranty-registration': 'Registers equipment with the manufacturer for warranty coverage.',
  'startup-sheet': 'Records commissioning/startup readings for newly installed equipment.',
  'permit': 'A government or utility permit for HVAC work, carrying a permit number.',
  'nameplate-photo': 'A photo of an equipment data plate: just serial and model, no service context.',
  'maintenance-agreement': 'A recurring service contract with a customer and a coverage term.',
  'service-ticket': 'A completed service visit: what was found and what was done.',
  'dispatch-note': 'A short note dispatching a technician, with little other detail.',
  'proposal-quote': 'A proposed price for work not yet performed.',
  'inspection-report': 'Findings from inspecting equipment or a site.',
  'purchase-order': 'An order placed with a vendor for parts or equipment.',
  'equipment-record': 'Identifies a piece of equipment with no service or billing context.',
  'correspondence': 'A letter or email about a customer or job, not a paperwork form.',
  'internal': 'Company-only record with no customer on it at all — an inventory or parts count, a gift card log, a daily log, an internal memo.',
  'receipt': 'Proof of a purchase or payment: a store or vendor, a date and an amount. Includes return slips and retainer receipts.',
  'agreement': 'A signed or formal agreement between parties: rental, consignment, lease, subcontract, grant, NDA or MOU.',
  'delivery-ticket': 'A delivery, pickup or packing slip listing goods handed over, with a date and who it is for.',
  'schedule': 'A calendar of shifts, jobs, visits or deliveries for a period. No customer or amount.',
  'price-list': 'A list of items or services with their prices, rates or catalog.',
  'statement': 'A summary of an account over a period: a bank, card, fuel, consignor or rent ledger statement.',
  'insurance-certificate': 'A certificate of insurance or insurance policy document.',
  'hr-letter': 'An employment, offer, award or other HR letter about a person who works for the company.',
  'other': 'Does not clearly fit any type above.',
};

/**
 * Required extraction field_keys per type. A `a|b` entry means either
 * satisfies the requirement. Keys match api/_lib/extractFields.js's
 * FIELD_KEYS (plus permit_number, added there for exactly this).
 */
export const REQUIRED_FIELDS = {
  // Address is required only where work happened at a place (work order, service ticket, inspection, permit).
  'work-order': ['service_address', 'service_date'],
  // A fleet or shop-owned unit is identified by its serial number, and a ticket can name a part instead of describing the work.
  'service-ticket': ['service_address|serial_number', 'service_date', 'work_performed|part_number'],
  'invoice': ['customer_name|vendor', 'service_date', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date'],
  'permit': ['service_address', 'permit_number'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address|vendor', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'inspection-report': ['service_address', 'service_date'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  'correspondence': [],
  'internal': [],
  'receipt': ['vendor|customer_name', 'service_date', 'cost'],
  'agreement': ['customer_name|vendor', 'agreement_term|service_date'],
  'delivery-ticket': ['customer_name|vendor', 'service_date'],
  'schedule': [],
  'price-list': [],
  // Company paperwork: page text is what makes these readable, so no party is demanded of them.
  'statement': [],
  'insurance-certificate': [],
  'hr-letter': [],
  'other': [],
};

/**
 * Company paperwork: the business's own records, never "linked" to a customer. Documents of these types are never
 * flagged "Not linked" and leave Needs you once their own required fields are present (browser mirror:
 * src/domains/hvac/documentTypes.ts, parity checked by verify:ui).
 */
export const COMPANY_RECORD_TYPES = new Set([
  'purchase-order', 'internal', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter',
]);
/** Company paperwork only while no customer is named on it (an NDA/MOU/lease with the company's own counterparty). */
export const COMPANY_RECORD_IF_NO_CUSTOMER_TYPES = new Set(['agreement']);
/** Types that need no customer/equipment link when they also carry no service address (an address means a job at a
 *  place, which should link). */
export const LINK_OPTIONAL_TYPES = new Set(['invoice', 'receipt', 'delivery-ticket', 'correspondence']);
/** Company paperwork only while NO customer and NO address is named on it ("other": filed as company paper, needs no
 *  link; with a customer or an address it is a customer document and still needs one). */
export const COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES = new Set(['other']);

const hasKey = (present, k) => (present instanceof Set ? present.has(k) : !!present?.[k]);

/** Synthetic bookkeeping rows (e.g. `_audience_notified`) are not facts about the document: ignored everywhere. */
export const isSyntheticKey = (k) => typeof k === 'string' && k.startsWith('_');

/** True when the document is company paperwork. `present` = Set (or object) of non-empty extracted field keys. */
export function isCompanyRecordType(typeId, present = new Set()) {
  const t = canonicalTypeId(typeId);
  if (COMPANY_RECORD_TYPES.has(t)) return true;
  if (COMPANY_RECORD_IF_NO_CUSTOMER_TYPES.has(t) && !hasKey(present, 'customer_name')) return true;
  return COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES.has(t) && !hasKey(present, 'customer_name') && !hasKey(present, 'service_address');
}

/** True when a missing customer/equipment link must NOT be flagged and must not stop an automatic check. */
export function linkNotRequired(typeId, present = new Set()) {
  const t = canonicalTypeId(typeId);
  if (isCompanyRecordType(t, present)) return true;
  return LINK_OPTIONAL_TYPES.has(t) && !hasKey(present, 'service_address');
}

const MONEY_KEYS = ['cost'];
const NAME_KEYS = ['customer_name', 'vendor'];

/** Real facts only: non-empty value, no synthetic `_` keys. Confidence is a finite number (else 0). */
function realFacts(fields) {
  const out = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string' || isSyntheticKey(f.field_key)) continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    const c = Number(f.confidence);
    out.push({ key: f.field_key, conf: Number.isFinite(c) ? c : 0, corroborated: f.corroborated === true });
  }
  return out;
}
const bestOf = (facts, keys) => facts.filter((f) => keys.includes(f.key)).reduce((b, f) => (!b || f.conf > b.conf ? f : b), null);

/** A money amount is auto-checkable only at AI_VERIFY_MIN_CONFIDENCE or better, or when the page corroborates it. */
export function moneyAmountsConfident(fields) {
  return realFacts(fields).filter((f) => MONEY_KEYS.includes(f.key)).every((f) => f.corroborated || f.conf >= AI_VERIFY_MIN_CONFIDENCE);
}

/** Names that look like a second copy of a paper already on file: "(copy)", " (2)", "copy of", or a "v2"-style suffix. */
export function isLikelyCopyName(name) {
  const base = String(name ?? '').trim().replace(/\.[A-Za-z0-9]{2,5}$/, '');
  if (!base) return false;
  return /\(\s*copy\s*\)|\bcopy\s+of\b/i.test(base) || /\s\(\d{1,2}\)\s*$/.test(base) || /[\s_-]v\d{1,2}\s*$/i.test(base);
}

/** True when the file name or the title line says the paper is this type (existing filename and title patterns). */
export function nameSupportsType(typeId, filename, title) {
  const t = canonicalTypeId(typeId);
  if (filename && inferTypeFromFilename(filename) === t) return true;
  if (title) {
    const line = String(title).toLowerCase().replace(/[\s.:;,-]+$/, '').trim();
    if (inferTypeFromFilename(line) === t && line.length <= 60) return true;
    for (const [type, re] of GENERIC_TITLE_PATTERNS) if (type === t && re.test(line)) return true;
  }
  return false;
}

/**
 * The automatic check, as one pure verdict (used by upload, re-check, the Inbox button and the re-sort, and by the
 * simulation). Judges ONLY the required facts plus the name fact (customer_name / vendor): a low-confidence
 * letterhead or invoice-number row on the side never blocks a document whose own required facts are solid.
 *
 *   opts.hasText  page text is stored (makes a COMPANY document readable even with zero facts)
 *   opts.hasLink  the document is already linked to a customer / unit
 *   opts.filename / opts.title  the file name and title line: a paper with NO facts is checked only when one of them
 *                 supports its type, and a likely copy ("(copy)", " (2)", "v2") is never checked
 *   opts.pack     a non-hvac industry pack
 *
 * @returns {{ok:boolean, allowUnlinked:boolean, reason:string|null, detail?:string}}
 *   reason: unreadable | barely-readable | needs-type | needs-link | missing-required | date-unconfirmed |
 *           low-confidence | amount-not-confirmed | likely-copy
 */
export function autoCheckDecision(typeId, fields, opts = {}) {
  const { hasText = false, hasLink = false, pack = null, filename = null, title = null } = opts;
  const t = canonicalTypeId(typeId);
  const facts = realFacts(fields);
  const present = new Set(facts.map((f) => f.key));
  const fail = (reason, detail) => ({ ok: false, allowUnlinked: false, reason, ...(detail ? { detail } : {}) });
  if (!facts.length && !hasText) return fail('unreadable');
  // A likely copy ("(copy)", " (2)", "copy of", "v2") is never checked automatically: a person decides which one stays.
  if (isLikelyCopyName(filename) || isLikelyCopyName(title)) return fail('likely-copy');
  // Page text alone is not enough to check a paper that has no facts: its file name or title must also say it is this type.
  if (!facts.length && !nameSupportsType(t, filename, title)) return fail('needs-type');
  if (!moneyAmountsConfident(fields)) return fail('amount-not-confirmed', MONEY_KEYS.find((k) => present.has(k)));
  const company = isCompanyRecordType(t, present);
  const noLink = linkNotRequired(t, present);

  if (t === 'other') {
    // Undecided type. No customer and no address: company paper, checked on one confident fact. Otherwise a person picks the type.
    if (!noLink) return hasLink ? { ok: true, allowUnlinked: false, reason: null } : fail('needs-link');
    if (!facts.some((f) => f.conf >= AI_VERIFY_MIN_CONFIDENCE)) return fail('needs-type');
    const name = bestOf(facts, NAME_KEYS);
    if (name && name.conf < AI_VERIFY_MIN_CONFIDENCE) return fail('needs-type');
    return { ok: true, allowUnlinked: true, reason: null };
  }

  const c = completenessFor(t, facts.map((f) => ({ field_key: f.key, value: 'x', confidence: f.conf })), pack);
  if (!c.complete) return fail(c.unconfirmed?.length && !c.missing.length ? 'date-unconfirmed' : 'missing-required', c.missing.join(', '));
  // Judge the required facts (best alternative each) plus the name fact.
  const required = pack && pack.id !== 'hvac' ? (pack.documentTypes?.find((x) => x.id === t)?.requires ?? []) : (REQUIRED_FIELDS[t] ?? []);
  const judged = [];
  for (const req of required) { const h = bestOf(facts, req.split('|')); if (h) judged.push(h); }
  const name = bestOf(facts, NAME_KEYS);
  if (name) judged.push(name);
  const weak = judged.find((f) => f.conf < AI_VERIFY_MIN_CONFIDENCE);
  if (weak) return fail('low-confidence', weak.key);

  if (noLink) {
    const readable = present.size >= 2 || present.has('customer_name') || present.has('vendor') || (hasText && company);
    if (!readable) return fail('barely-readable');
    return { ok: true, allowUnlinked: true, reason: null };
  }
  return hasLink ? { ok: true, allowUnlinked: false, reason: null } : fail('needs-link');
}

/** Facts-array convenience: may this document be checked automatically with no link? (See autoCheckDecision.)
 *  Callers that know the page text exists should pass `{ hasText: true }` - it is what makes company paperwork
 *  readable when the extractor found no facts. */
export function mayVerifyWithoutLink(typeId, fields, opts = {}) {
  const d = autoCheckDecision(typeId, fields, { ...opts, hasLink: false });
  return d.ok && d.allowUnlinked;
}

/** Facts a shop-internal document is allowed to carry (see
 *  isShopInternalDocument below) — its own letterhead facts plus a free-text
 *  note or status, and nothing that ties it to any customer, unit or job.
 *  `technician` deliberately still disqualifies (see verify-doctypes.mjs):
 *  a NAMED technician tied to actual customer work is a job worth linking,
 *  not shop chatter. A truck-maintenance note's "Tech: Kevin Pratt" is
 *  pulled separately, from `notes`, by extractTechnicianFromNotes below —
 *  that never touches classification, only the Shop records chip/filter. */
const SHOP_INTERNAL_ALLOWED_FIELDS = new Set(['shop_address', 'shop_phone', 'shop_email', 'notes', 'status']);

/**
 * Best-effort technician name off an internal document's free-text `notes`
 * (owner defect report 2026-09-22, item 4) — "Truck #4 due for oil change,
 * see shop manager. Tech: Kevin Pratt" -> "Kevin Pratt". Deliberately NOT
 * the same signal as the `technician` field_key (which names whoever did
 * CUSTOMER work and rightly disqualifies isShopInternalDocument above) —
 * this only ever reads a shop-internal document's own notes, purely for
 * display: a chip on the Shop records list and something to filter it by.
 * Pure, no model call: internal notes are short and this one phrasing
 * ("Tech:" / "Technician:") is what the shop's own dispatch notes use.
 */
export function extractTechnicianFromNotes(notes) {
  const s = String(notes ?? '');
  // Prefix ("Tech:"/"Technician:", any case) located first; the name itself
  // is then read case-SENSITIVELY (each word must start with a capital) so
  // it stops at the next ordinary lowercase word ("Tech: Maria Alvarez
  // completed the count" -> "Maria Alvarez", not swallowing "completed").
  const prefixMatch = s.match(/\btech(?:nician)?s?\s*[:-]\s*/i);
  if (!prefixMatch) return null;
  const rest = s.slice(prefixMatch.index + prefixMatch[0].length);
  const nameMatch = rest.match(/^([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*){0,2})/);
  if (!nameMatch) return null;
  const name = nameMatch[1].replace(/\s+/g, ' ').trim();
  return name || null;
}

/**
 * True when a document's only non-empty extracted facts are its own shop_*
 * fields plus notes/status — e.g. a parts count, a truck dispatch note, an
 * internal memo to all techs. Such a document names no customer, unit or job
 * and can never be linked to one, so it must not sit in the human review
 * queue waiting for a link that will never come (Round 4, 2026-09-21).
 *
 * Pure: takes the same `{field_key, value}[]` shape extractFields.js's
 * normalizeFields() returns. Requires at least one non-empty shop_* fact —
 * a document with nothing extracted at all, or only a bare "notes"/"status"
 * value, is not this; it's simply unclassified.
 */
export function isShopInternalDocument(fields) {
  let hasShopFact = false;
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string' || isSyntheticKey(f.field_key)) continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    if (!SHOP_INTERNAL_ALLOWED_FIELDS.has(f.field_key)) return false;
    if (f.field_key.startsWith('shop_')) hasShopFact = true;
  }
  return hasShopFact;
}

/** Mirrors extractFields.js's UNCONFIRMED_SUFFIX (not imported: extractFields.js imports this module). */
const UNCONFIRMED_SUFFIX = '_unconfirmed';

/** Display labels for field_keys, used wherever "missing" fields are shown. */
export const FIELD_LABELS = {
  equipment_id: 'Equipment ID',
  serial_number: 'Serial number',
  model: 'Model',
  manufacturer: 'Manufacturer',
  equipment_type: 'Equipment type',
  tonnage: 'Tonnage',
  refrigerant: 'Refrigerant',
  service_address: 'Service address',
  shop_address: 'Company address',
  shop_phone: 'Company phone',
  shop_email: 'Company email',
  customer_name: 'Customer',
  installation_date: 'Installation date',
  warranty_expires: 'Warranty expires',
  warranty_term: 'Term',
  warranty_registered_date: 'Warranty registered',
  service_date: 'Service date',
  service_type: 'Service type',
  technician: 'Technician',
  work_performed: 'Work performed',
  part_number: 'Part number',
  cost: 'Cost',
  labor_hours: 'Labor hours',
  invoice_number: 'Invoice number',
  status: 'Status',
  notes: 'Notes',
  permit_number: 'Permit number',
  agreement_term: 'Agreement term',
  vendor: 'Vendor',
  reminder_text: 'Reminder',
  reminder_customer_name: 'Reminder — customer',
  reminder_trigger: 'Reminder trigger',
  // R33: printed far-future dates parked for a person to confirm (extractFields.js UNCONFIRMED_SUFFIX). The label
  // itself carries the caveat, so anything that renders field labels (dossiers, exports) never presents one as fact.
  service_date_unconfirmed: 'Service date (unconfirmed: printed date is in the future)',
  installation_date_unconfirmed: 'Installation date (unconfirmed: printed date is in the future)',
  warranty_registered_date_unconfirmed: 'Warranty registered (unconfirmed: printed date is in the future)',
};

export function fieldLabel(fieldKey, pack = null) {
  if (pack && pack.id !== 'hvac') {
    return pack.fields?.find((f) => f.key === fieldKey)?.label ?? FIELD_LABELS[fieldKey] ?? fieldKey;
  }
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

/**
 * Plain-English synonyms per canonical document type id — the single source
 * both api/_lib/docLookup.js (document-by-customer/type lookup) and
 * api/_lib/analytics.js (the "has X but no Y" cross-doc filter) key off, so a
 * synonym added here is recognized by both without hand-duplicating the list.
 * Longest-phrase-first ordering is handled by docTypeSynonymAlternation()
 * below, not by the order words are listed here.
 */
const BASE_DOCUMENT_TYPE_SYNONYMS = {
  'work-order': ['work order', 'work orders'],
  invoice: ['invoice', 'invoices'],
  'warranty-registration': ['warranty registration', 'warranty registrations', 'warranty reg', 'warranty regs'],
  'startup-sheet': ['startup sheet', 'startup sheets'],
  permit: ['permit', 'permits'],
  'nameplate-photo': ['nameplate photo', 'nameplate photos', 'nameplate', 'nameplates', 'photo', 'photos'],
  'maintenance-agreement': [
    'maintenance agreement', 'maintenance agreements', 'agreement', 'agreements',
    'contract', 'contracts', 'maintenance plan', 'maintenance plans',
  ],
  'service-ticket': ['service ticket', 'service tickets', 'ticket', 'tickets'],
  'dispatch-note': ['dispatch note', 'dispatch notes'],
  'proposal-quote': ['proposal', 'proposals', 'quote', 'quotes', 'estimate', 'estimates', 'proposal quote', 'proposal quotes'],
  'inspection-report': ['inspection report', 'inspection reports'],
  'purchase-order': ['purchase order', 'purchase orders', 'po'],
  'equipment-record': ['equipment record', 'equipment records'],
  correspondence: ['correspondence'],
  internal: ['shop record', 'shop records'],
};

/** Document types beyond the original service-trade set, as people say them: the same words as lookups/lexicon.js
 *  EXTRA_DOC_TYPE_WORDS, so a question and a filter agree. Used for PHRASE matching only (docTypeFromWord /
 *  docTypeSynonymAlternation / planner validation). NOT fed to DOCTYPE_TRIGGER_WORDS: single words such as "list",
 *  "insurance" or "letter" must not become typo-correction targets ("last visit" -> "list visit"). */
const EXTRA_DOCUMENT_TYPE_SYNONYMS = {
  receipt: ['receipt', 'receipts', 'sales slip', 'sales slips', 'payment receipt', 'payment receipts', 'return slip', 'return slips'],
  'delivery-ticket': ['delivery ticket', 'delivery tickets', 'delivery note', 'delivery notes', 'delivery slip', 'delivery slips', 'pickup ticket', 'pickup tickets', 'pick-up ticket', 'pick-up tickets', 'pick up ticket', 'pick up tickets', 'pickup slip', 'pickup slips', 'packing slip', 'packing slips', 'bill of lading', 'bills of lading'],
  schedule: ['schedule', 'schedules'],
  'price-list': ['price list', 'price lists', 'pricing sheet', 'pricing sheets', 'price sheet', 'price sheets', 'rate sheet', 'rate sheets', 'rate card', 'rate cards'],
  statement: ['statement', 'statements', 'account statement', 'account statements'],
  'insurance-certificate': ['insurance certificate', 'insurance certificates', 'certificate of insurance', 'certificates of insurance', 'insurance cert', 'insurance certs', 'insurance policy', 'insurance policies', 'coi', 'cois'],
  'hr-letter': ['hr letter', 'hr letters', 'hr document', 'hr documents', 'hr paperwork', 'employment letter', 'employment letters', 'offer letter', 'offer letters'],
  'maintenance-agreement': [
    'service plan', 'service plans', 'service agreement', 'service agreements', 'service contract', 'service contracts',
    'maintenance contract', 'maintenance contracts', 'membership', 'memberships', 'maintenance membership', 'maintenance memberships',
  ],
};

export const DOCUMENT_TYPE_SYNONYMS = Object.fromEntries(
  [...new Set([...Object.keys(BASE_DOCUMENT_TYPE_SYNONYMS), ...Object.keys(EXTRA_DOCUMENT_TYPE_SYNONYMS)])].map((id) => [
    id, [...(BASE_DOCUMENT_TYPE_SYNONYMS[id] ?? []), ...(EXTRA_DOCUMENT_TYPE_SYNONYMS[id] ?? [])],
  ])
);

/** Canonical id for a single matched word/phrase (already lowercase from the
 *  regex the alternation below builds), or null. Falls back to a literal
 *  DOCUMENT_TYPE_IDS member so a caller that already has a canonical id can
 *  pass it through unchanged. */
export function docTypeFromWord(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  for (const [id, words] of Object.entries(DOCUMENT_TYPE_SYNONYMS)) {
    if (words.includes(w)) return id;
  }
  return DOCUMENT_TYPE_IDS.has(w) ? w : null;
}

/** One regex-alternation string of every synonym word/phrase across every
 *  type, longest first so a multi-word phrase ("purchase order") matches
 *  before a shorter word that happens to be its own suffix could. */
export function docTypeSynonymAlternation() {
  const all = [];
  for (const words of Object.values(DOCUMENT_TYPE_SYNONYMS)) all.push(...words);
  return [...new Set(all)]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// R15 (Team C): every individual word across DOCUMENT_TYPE_SYNONYMS, flattened — used by BOTH
// docLookup.js and contactLookup.js to typo-correct a doctype word before either file's own
// shape-matching runs (a typo'd "invoides" must not be swallowed as a person name ahead of
// docLookup.js ever getting a turn). Defined here rather than in either of those two files
// because docLookup.js already imports from contactLookup.js — a reverse import of one from the
// other creates a real circular dependency that, depending on which file's own verify script (or
// api/ask.js) happens to import which one first, can evaluate one module's top-level code (e.g.
// nlNormalize.js's own module-level VOCAB build, several hops away) before the other side of the
// cycle has finished initializing. documentTypes.js has zero imports of its own, so it can never
// be part of a cycle.
export const DOCTYPE_TRIGGER_WORDS = [...new Set(Object.values(BASE_DOCUMENT_TYPE_SYNONYMS).flat().flatMap((phrase) => phrase.split(' ')))];

export const AI_VERIFY_MIN_CONFIDENCE = 0.85;

/**
 * Old backend ids -> canonical id. Anything not listed here that also isn't
 * already canonical falls through to 'other' in normalizeDocumentType.
 * `install_record` is handled separately below since its target depends on
 * facts (cost/invoice_number), not just the string.
 */
const LEGACY_MAP = {
  warranty: 'warranty-registration',
  document: 'other',
  unclassified: 'other',
};

/** Raw legacy/backend values that are not (and never were) canonical ids —
 *  used to decide "this document has never really been classified" without
 *  needing an audit_log lookup. */
export const LEGACY_TYPE_IDS = new Set(['warranty', 'service_ticket', 'install_record', 'equipment_record', 'document', 'unclassified']);

/** True when `raw` is missing, a legacy backend id, or free text — i.e. NOT
 *  already one of our canonical ids. Used to decide whether an automated
 *  reclassification is allowed to overwrite it (a canonical value already on
 *  the row means someone — human or a previous AI pass — already decided). */
export function isLegacyOrUnknownType(raw) {
  if (raw == null || raw === '') return true;
  return !DOCUMENT_TYPE_IDS.has(String(raw).trim());
}

/**
 * True when `raw` is a candidate for automated reclassification: missing, a
 * legacy id, free text, OR the canonical-but-meaningless 'other'. Unlike
 * isLegacyOrUnknownType above, this treats 'other' as NOT decided — 'other'
 * is what every document gets before anything actually classified it, so
 * reclassifyDocuments must not read it as "someone already decided this".
 */
export function isReclassifiable(raw) {
  if (raw == null || raw === '') return true;
  const s = String(raw).trim().toLowerCase();
  if (s === 'other') return true;
  return isLegacyOrUnknownType(raw);
}

/**
 * canonical / legacy / free-text -> canonical id. Never returns null or
 * 'unclassified' — the fallback is always 'other'.
 *
 * `facts` is optional and only consulted for the one legacy id
 * (`install_record`) whose correct mapping depends on what was extracted.
 */
export function normalizeDocumentType(raw, facts = {}, pack = null) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return 'other';
  if (DOCUMENT_TYPE_IDS.has(s)) return s;
  // A pack's own additional type ids (panel-schedule, lease-agreement, ...)
  // are canonical for that tenant even though they're not in the base
  // DOCUMENT_TYPE_IDS set above. Checked only for a non-hvac pack — the hvac
  // pack's own type set is exactly DOCUMENT_TYPE_IDS, already handled.
  if (pack && pack.id !== 'hvac' && pack.documentTypes?.some((t) => t.id === s)) return s;
  if (s === 'install-record') {
    return (facts?.cost || facts?.invoice_number) ? 'invoice' : 'startup-sheet';
  }
  return LEGACY_MAP[s] ?? 'other';
}

/**
 * Filename keyword -> canonical type. Checked only as a fallback, between the
 * strong per-field signals above and the weak single-fact guesses below (see
 * inferDocumentType) — a named file ("07-dispatch-note-....txt") is a better
 * signal than "has exactly one weak fact", but a real extracted fact (cost,
 * work_performed, a permit number) still wins outright. Order matters: more
 * specific patterns (purchase order, service ticket) are checked before the
 * generic ones they could otherwise collide with.
 */
// Document codes like "R-20120", "RA_0012", "PT 31": a short letter prefix, then digits, not glued to other letters.
const code = (prefixes) => new RegExp(`(?:^|[^a-z0-9])(?:${prefixes})[-_ ]\\d`, 'i');
const word = (w) => new RegExp(`(?:^|[^a-z])(?:${w})(?:[^a-z]|$)`, 'i');
const FILENAME_PATTERNS = [
  [/purchase[-_ ]?order|\bpo[-_]?\d+\b/i, 'purchase-order'],
  // Generic business paperwork. More specific phrases first so "rental agreement receipt" style names resolve sanely.
  [/packing[-_ ]?slip|delivery[-_ ](?:ticket|note|slip|receipt)|pick[-_ ]?up[-_ ](?:ticket|slip|receipt)|bill[-_ ]of[-_ ]lading/i, 'delivery-ticket'],
  [code('ps|pt|dt|pk'), 'delivery-ticket'],
  [/certificate[-_ ]of[-_ ]insurance|insurance[-_ ](?:certificate|policy)/i, 'insurance-certificate'],
  [word('coi|policy'), 'insurance-certificate'],
  [/equipment[-_ ]floater|inland[-_ ]marine|\bfloater\b/i, 'insurance-certificate'],
  [/offer[-_ ]letter|employment|termination[-_ ]letter|new[-_ ]hire|job[-_ ]offer|onboarding[-_ ]letter/i, 'hr-letter'],
  [/statement|ledger|account[-_ ]summary|remittance/i, 'statement'],
  [code('cs'), 'statement'],
  [/credit[-_ ]?(?:memo|note)|debit[-_ ]?memo/i, 'invoice'],
  [code('cm'), 'invoice'],
  [/receipt|return[-_ ]?slip|sales[-_ ]slip/i, 'receipt'],
  [code('rc|rcpt|r'), 'receipt'],
  [/price[-_ ]?list|rate[-_ ]?(?:card|sheet)|catalog(?:ue)?|fee[-_ ]schedule/i, 'price-list'],
  [/schedule|roster|timesheet/i, 'schedule'],
  [/inventory|stock[-_ ]?count|parts[-_ ]?count|gift[-_ ]?card|daily[-_ ]log/i, 'internal'],
  [code('p'), 'internal'],
  [/service[-_ ]?ticket/i, 'service-ticket'],
  [/dispatch/i, 'dispatch-note'],
  [/work[-_ ]?order/i, 'work-order'],
  [/(maintenance|service)[-_ ](?:agreement|contract|plan)|\bmsa\b/i, 'maintenance-agreement'],
  [/award[-_ ]letter|grant[-_ ]award|rental[-_ ]agreement|consign\w*[-_ ]agreement|grant[-_ ]agreement|non[-_ ]?disclosure|memorandum[-_ ]of|sub[-_ ]?contract|agreement|contract/i, 'agreement'],
  [code('ra|ca|sc'), 'agreement'],
  [word('lease|nda|mou'), 'agreement'],
  [/proposal|quote|estimate/i, 'proposal-quote'],
  [/inspection/i, 'inspection-report'],
  [/nameplate|data[-_ ]?plate/i, 'nameplate-photo'],
  [/warrant(y|ies)/i, 'warranty-registration'],
  [/permit/i, 'permit'],
  [/invoice/i, 'invoice'],
];

/** Title-line patterns (a document announcing its own type), tried against short lines in modelAvoidance/textExtract.js
 *  classifyFromText and by the one-time re-sort. Lowercase, trailing punctuation already stripped. */
export const GENERIC_TITLE_PATTERNS = [
  ['receipt', /^(?:sales\s+|payment\s+|retainer\s+|cash\s+|donation\s+|rent\s+|gift\s+|official\s+|customer\s+)?receipt(?:\s*(?:#|no\.?|number)\s*[\w-]+)?$|^return\s+slip$/],
  ['agreement', /^(?:rental|consignment|lease|subcontract(?:or)?|grant|service|vendor|independent\s+contractor)\s+(?:agreement|contract)$|^(?:non[-\s]?disclosure|confidentiality)\s+agreement$|^(?:mutual\s+)?nda$|^memorandum\s+of\s+understanding$|^(?:grant\s+)?award\s+letter$|^agreement$/],
  ['delivery-ticket', /^(?:packing\s+slip|delivery\s+(?:ticket|note|receipt)|pick[-\s]?up\s+(?:ticket|slip)|bill\s+of\s+lading)$/],
  ['schedule', /^(?:weekly\s+|monthly\s+|daily\s+|staff\s+|work\s+)?(?:schedule|roster)$/],
  ['price-list', /^(?:price\s+list|rate\s+(?:card|sheet)|fee\s+schedule|product\s+catalog(?:ue)?)$/],
  ['statement', /^(?:account\s+|monthly\s+|consignor\s+|card\s+)?statement(?:\s+of\s+account)?$|^rent\s+ledger$/],
  ['insurance-certificate', /^certificate\s+of\s+(?:liability\s+)?insurance$|^insurance\s+(?:certificate|policy)$/],
  ['hr-letter', /^(?:offer|employment|termination)\s+letter$|^employment\s+(?:agreement|offer)$/],
];

/** Types a one-time re-sort may move a document INTO when the rule is confident (a name or title says so). */
export const RESORT_TARGET_TYPES = new Set(['receipt', 'agreement', 'delivery-ticket', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter', 'purchase-order', 'internal']);
/** Types a re-sort may move a document OUT of (the catch-alls the old rules over-used, plus the types things get
 *  misfiled into: a COI or licence read as a warranty registration, a memo typed internal, an award letter typed HR). */
export const RESORT_SOURCE_TYPES = new Set(['invoice', 'other', 'correspondence', 'dispatch-note', 'warranty-registration', 'internal', 'schedule']);
/** HR papers are never moved out of People and HR, with one exception: a grant or contract "award letter" typed HR. */
const AWARD_LETTER_RE = /award[-_ ]letter/i;
/** A licence or permit-to-practise filed as a warranty registration has no better type than company paper. */
const LICENCE_RE = /\blicen[cs]e\b/i;

/**
 * Pure re-sort rule. `titleType` = type a title line announced (or null).
 * `humanChosen` = a person set the current type: never overridden. `hasEquipmentFacts` = serial/model on file: a real
 * warranty card is never moved. Returns the new type, or null to leave it.
 */
export function resortDecision({ currentType, filename, titleType = null, titleText = null, humanChosen = false, hasEquipmentFacts = false, hrOverride = false, verified = false }) {
  const cur = canonicalTypeId(currentType || 'other');
  if (humanChosen || hrOverride || verified) return null; // a person's choice, a People and HR paper, a checked paper: never moved
  if (cur === 'hr-letter') {
    // The only HR paper that may move: an award letter (grant or contract), by its file name or title.
    return AWARD_LETTER_RE.test(String(filename ?? '')) || AWARD_LETTER_RE.test(String(titleText ?? '')) ? 'agreement' : null;
  }
  if (!RESORT_SOURCE_TYPES.has(cur)) return null;
  if (cur === 'warranty-registration' && hasEquipmentFacts) return null;
  const nameType = inferTypeFromFilename(filename);
  const t1 = titleType && RESORT_TARGET_TYPES.has(titleType) ? titleType : null;
  const t2 = nameType && RESORT_TARGET_TYPES.has(nameType) ? nameType : null;
  if (t1 && t2 && t1 !== t2) return null; // the title and the name disagree: not confident
  let next = t1 || t2;
  if (!next && cur === 'warranty-registration' && LICENCE_RE.test(String(filename ?? ''))) next = 'other';
  return next && next !== cur ? next : null;
}

/** Pure: filename -> canonical type, or null if nothing matches. Exported so
 *  the pattern list itself is directly testable (scripts/verify-doctypes.mjs)
 *  independent of inferDocumentType's fact-priority ordering. */
export function inferTypeFromFilename(filename) {
  const name = String(filename ?? '').toLowerCase();
  if (!name) return null;
  for (const [re, type] of FILENAME_PATTERNS) {
    if (re.test(name)) return type;
  }
  return null;
}

/**
 * Deterministic fallback classifier from extracted facts (+ filename), used
 * when the model gives no usable document_type. Never returns null/unknown.
 * A human can always reclassify from review; the point is the column stops
 * being null, not that every guess is exactly right.
 */
export function inferDocumentType(facts = {}, filename = '') {
  const f = facts ?? {};
  const has = (k) => f[k] != null && String(f[k]).trim() !== '';
  const name = String(filename ?? '').toLowerCase();
  const isPhoto = /\.(jpe?g|png|heic|heif|webp|gif)$/.test(name);

  if (has('warranty_registered_date')) return 'warranty-registration';
  if (has('permit_number')) return 'permit';
  if (has('warranty_expires') || has('warranty_term')) {
    // A term/expiry attached to a customer+address with no serial reads as a
    // recurring service contract, not a one-time manufacturer registration.
    if (has('customer_name') && has('service_address') && !has('serial_number')) return 'maintenance-agreement';
    // A lone expiry date (no serial, model or maker) is a COI, licence or policy, not a manufacturer registration.
    if (has('serial_number') || has('model') || has('manufacturer')) return 'warranty-registration';
  }
  // A specific name ("Packing slip PS-31", "Rent ledger", "Offer letter") beats the blanket "has a cost -> invoice"
  // guess: stores, landlords and vendors print amounts on documents that are not invoices. A generic "invoice" name
  // is not specific, so it falls through to the fact rules below.
  const specificByName = inferTypeFromFilename(name);
  if (specificByName && specificByName !== 'invoice') return specificByName;
  if (has('invoice_number') || has('cost')) return 'invoice';
  if (has('work_performed')) return 'service-ticket';
  if (has('service_date') && has('technician')) return 'work-order';
  if (has('installation_date')) return 'startup-sheet';

  // Filename beats the weak single-fact guesses below (a lone service_date,
  // a lone customer_name) — those are the exact cases where 'other'/legacy
  // docs like a dispatch note with no technician were misclassified.
  const byName = inferTypeFromFilename(name);
  if (byName) return byName;

  if (has('service_date')) return 'inspection-report';
  if (isPhoto && (has('serial_number') || has('model'))) return 'nameplate-photo';
  if (has('serial_number') || has('model')) return 'equipment-record';
  if (has('customer_name')) return 'correspondence';
  return 'other';
}

/**
 * Turn the model's document_type/document_type_confidence tool output into a
 * trustworthy classification. Never returns an invalid or missing type — an
 * unusable model answer falls back to the deterministic heuristic above.
 */
export function resolveDocumentType(toolInput, facts, filename, pack = null) {
  const raw = toolInput?.document_type;
  const rawConf = Number(toolInput?.document_type_confidence);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.6;
  const validIds = pack && pack.id !== 'hvac' ? new Set(pack.documentTypes.map((t) => t.id)) : DOCUMENT_TYPE_IDS;

  if (typeof raw === 'string' && raw.trim()) {
    const normalized = normalizeDocumentType(raw, facts, pack);
    if (validIds.has(normalized) && normalized !== 'other') {
      return { documentType: normalized, confidence, source: 'model' };
    }
  }
  return { documentType: inferDocumentType(facts, filename), confidence: 0.5, source: 'heuristic' };
}

/**
 * Turn `extractions` rows (field_key, value, confidence, corrected_value?)
 * into the flat {field_key, value, confidence} shape completenessFor wants.
 * A human correction always wins over the model's value and is treated as
 * fully confident — it is no longer a guess.
 */
export function toCompletenessFields(rows) {
  return (rows ?? []).map((r) => {
    const corrected = r?.corrected_value;
    const hasCorrection = corrected != null && String(corrected).trim() !== '';
    return {
      field_key: r?.field_key,
      value: hasCorrection ? corrected : r?.value,
      confidence: hasCorrection ? 1 : Number(r?.confidence ?? 0),
      // M3-config/19: null on a row extracted before that migration, or for
      // a document-scoped field — passed through so the browser can group a
      // multi-unit document's per-unit fields (recordsStore.js's
      // listExtractionsByDocuments/listExtractionsByDocument both select it).
      unit_index: r?.unit_index ?? null,
    };
  });
}

/**
 * Required-field completeness for one document.
 *
 * @param {string} typeId  a document type id (normalized internally, so a
 *   legacy/raw value is safe to pass)
 * @param {{field_key: string, value: unknown, confidence?: number}[]} fields
 * @returns {{type: string, required: string[], present: string[],
 *            missing: string[], minConfidence: number, complete: boolean}}
 */
export function completenessFor(typeId, fields, pack = null) {
  const type = normalizeDocumentType(typeId, {}, pack);
  const required = pack && pack.id !== 'hvac'
    ? (pack.documentTypes.find((t) => t.id === type)?.requires ?? [])
    : (REQUIRED_FIELDS[type] ?? []);

  const byKey = new Map();
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string' || isSyntheticKey(f.field_key)) continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    const confidence = Number(f.confidence);
    const entry = { field_key: f.field_key, confidence: Number.isFinite(confidence) ? confidence : 0 };
    const prev = byKey.get(f.field_key);
    if (!prev || entry.confidence > prev.confidence) byKey.set(f.field_key, entry);
  }

  const present = [];
  const missing = [];
  const satisfiedConfidences = [];
  // R33: a requirement whose only reading is an UNCONFIRMED far-future date (service_date_unconfirmed — see
  // extractFields.js's UNCONFIRMED_SUFFIX) is NOT missing: the date is printed and on file. It is listed in
  // `unconfirmed` instead, and keeps `complete` false so the document is never auto-verified on a date nobody has
  // confirmed; the Inbox shows a "check the year" chip, never "Missing information".
  const unconfirmed = [];

  for (const requirement of required) {
    const alts = requirement.split('|');
    // The alternative the document reads best wins (not the first one listed).
    const hit = alts.map((k) => byKey.get(k)).filter(Boolean).reduce((b, h) => (!b || h.confidence > b.confidence ? h : b), null);
    if (hit) {
      present.push(hit.field_key);
      satisfiedConfidences.push(hit.confidence);
    } else if (alts.some((k) => byKey.has(`${k}${UNCONFIRMED_SUFFIX}`))) {
      unconfirmed.push(requirement);
    } else {
      missing.push(requirement);
    }
  }

  // No requirements to satisfy (type 'other') counts as fully confident, not
  // zero — there is nothing here for a low confidence to be ABOUT.
  const minConfidence = satisfiedConfidences.length
    ? Math.min(...satisfiedConfidences)
    : (required.length ? 0 : 1);

  return { type, required, present, missing, unconfirmed, minConfidence, complete: missing.length === 0 && unconfirmed.length === 0 };
}
