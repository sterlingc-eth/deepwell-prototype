/**
 * Canonical document types — HAND-MIRRORED copy of api/_lib/documentTypes.js
 * (that file is the single source of truth per handoffs/TEAM_BRIEF_2026-09-19.md;
 * agent-backend owns it). `src/` builds standalone from `api/` (no allowJs,
 * different tsconfig root), so this cannot just import that module — it must
 * match it BY HAND. scripts/verify-ui.ts imports the real JS module via tsx
 * and asserts the two stay in sync; run `npm run verify:ui` after editing
 * either file.
 */

export interface DocumentTypeDef {
  id: string;
  label: string;
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
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
  { id: 'receipt', label: 'Receipt' },
  { id: 'agreement', label: 'Agreement / contract' },
  { id: 'delivery-ticket', label: 'Delivery / pickup ticket' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'price-list', label: 'Price list' },
  { id: 'statement', label: 'Statement' },
  { id: 'insurance-certificate', label: 'Insurance certificate' },
  { id: 'hr-letter', label: 'HR / employment letter' },
  { id: 'license-certification', label: 'License / certification' },
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

/**
 * Required extraction field_keys per type. A `a|b` entry means either
 * satisfies the requirement. Keys match api/_lib/extractFields.js's
 * FIELD_KEYS.
 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  // Address is required only where work happened at a place (work order, service ticket, inspection, permit).
  'work-order': ['service_address', 'service_date|invoice_number'],
  // A fleet or shop-owned unit is identified by its serial number, and a ticket can name a part instead of describing the work.
  'service-ticket': ['service_address|serial_number', 'service_date|invoice_number', 'work_performed|part_number'],
  invoice: ['customer_name|vendor', 'service_date', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date'],
  permit: ['service_address', 'permit_number'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address|vendor', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'inspection-report': ['service_address', 'service_date|invoice_number|permit_number'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  correspondence: [],
  internal: [],
  // Inbox round (2026-10-21): walk-in receipts name no customer; agreements need only who they are with.
  receipt: ['service_date|invoice_number', 'cost'],
  agreement: ['customer_name|vendor', 'agreement_term|service_date'],
  'delivery-ticket': ['customer_name|vendor|invoice_number', 'service_date|invoice_number'],
  schedule: [],
  'price-list': [],
  // Company paperwork: page text is what makes these readable, so no party is demanded of them.
  statement: [],
  'insurance-certificate': [],
  'hr-letter': [],
  'license-certification': [],
  other: [],
};

/** Company paperwork (never "Not linked"; leaves Needs you once its own required fields are present).
 *  Mirrors api/_lib/documentTypes.js; verify:ui checks parity. */
export const COMPANY_RECORD_TYPES = new Set([
  'purchase-order', 'internal', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter', 'license-certification',
]);
/** Company paperwork only while no customer is named on it. */
export const COMPANY_RECORD_IF_NO_CUSTOMER_TYPES = new Set(['agreement']);
/** Types that need no link when they carry no service address. */
export const LINK_OPTIONAL_TYPES = new Set(['invoice', 'receipt', 'delivery-ticket', 'correspondence', 'agreement']);
/** Company paperwork only while NO customer and NO address is named on it. */
export const COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES = new Set(['other']);

/** True when the document is company paperwork. `present` = set of non-empty extracted field keys. */
export function isCompanyRecordType(typeId: string | undefined | null, present: ReadonlySet<string> = new Set()): boolean {
  const t = String(typeId ?? '');
  if (COMPANY_RECORD_TYPES.has(t)) return true;
  if (COMPANY_RECORD_IF_NO_CUSTOMER_TYPES.has(t) && !present.has('customer_name')) return true;
  return COMPANY_RECORD_IF_NO_CUSTOMER_OR_ADDRESS_TYPES.has(t) && !present.has('customer_name') && !present.has('service_address');
}

/** True when a missing customer/equipment link must not be flagged or stop an automatic check. */
export function linkNotRequired(typeId: string | undefined | null, present: ReadonlySet<string> = new Set()): boolean {
  const t = String(typeId ?? '');
  if (isCompanyRecordType(t, present)) return true;
  return LINK_OPTIONAL_TYPES.has(t) && !present.has('service_address');
}

/** Display labels for field_keys, used wherever "missing" fields are shown. */
export const FIELD_LABELS: Record<string, string> = {
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
  start_date: 'Start / effective date',
  end_date: 'End / expiry date',
  license_number: 'License number',
  policy_number: 'Policy number',
  holder_name: 'Holder name',
  license_class: 'License class',
  issued_by: 'Issued by / examiner',
  employee_name: 'Employee name',
  employee_phone: 'Employee phone',
  employee_email: 'Employee email',
  signed_date: 'Date signed',
  position: 'Position',
  pay_rate: 'Pay rate',
  manager: 'Manager',
  agreement_term: 'Agreement term',
  vendor: 'Vendor',
  reminder_text: 'Reminder',
  reminder_customer_name: 'Reminder — customer',
  reminder_trigger: 'Reminder trigger',
  // R33: printed far-future dates parked for a person to confirm (api/_lib/extractFields.js UNCONFIRMED_SUFFIX).
  service_date_unconfirmed: 'Service date (unconfirmed: printed date is in the future)',
  installation_date_unconfirmed: 'Installation date (unconfirmed: printed date is in the future)',
  warranty_registered_date_unconfirmed: 'Warranty registered (unconfirmed: printed date is in the future)',
};

export function fieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

/** Display label for a requirement, which may be `a|b`. */
export function requirementLabel(requirement: string): string {
  return requirement.split('|').map(fieldLabel).join(' or ');
}

export const AI_VERIFY_MIN_CONFIDENCE = 0.85;

const LEGACY_MAP: Record<string, string> = {
  warranty: 'warranty-registration',
  document: 'other',
  unclassified: 'other',
};

/** True when `raw` is missing, a legacy backend id, or free text — i.e. NOT
 *  already one of our canonical ids. */
export function isLegacyOrUnknownType(raw: unknown): boolean {
  if (raw == null || raw === '') return true;
  return !DOCUMENT_TYPE_IDS.has(String(raw).trim());
}

/**
 * canonical / legacy / free-text -> canonical id. Never returns null or
 * 'unclassified' — the fallback is always 'other'. `facts` is only consulted
 * for the one legacy id (`install_record`) whose mapping depends on what was
 * extracted.
 */
export function normalizeDocumentType(raw: unknown, facts: Record<string, unknown> = {}): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return 'other';
  if (DOCUMENT_TYPE_IDS.has(s)) return s;
  if (s === 'install-record') {
    return facts?.cost || facts?.invoice_number ? 'invoice' : 'startup-sheet';
  }
  return LEGACY_MAP[s] ?? 'other';
}

export interface CompletenessField {
  field_key: string;
  value: unknown;
  confidence?: number;
}

export interface Completeness {
  type: string;
  required: string[];
  present: string[];
  missing: string[];
  /** R33: requirements met only by an unconfirmed far-future date. Optional so older payloads still type-check. */
  unconfirmed?: string[];
  minConfidence: number;
  complete: boolean;
}

/** Required-field completeness for one document. Mirrors api/_lib/documentTypes.js's completenessFor exactly. */
export function completenessFor(typeId: string, fields: CompletenessField[], opts: { filename?: string | null; title?: string | null } = {}): Completeness {
  const type = normalizeDocumentType(typeId);
  const required = requiredFieldsFor(type, opts.filename ?? null, opts.title ?? null);

  const byKey = new Map<string, { field_key: string; confidence: number }>();
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string' || f.field_key.startsWith('_')) continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    if ((f.field_key === 'customer_name' || f.field_key === 'vendor') && isLabelValue(f.value)) continue;
    const confidence = Number(f.confidence);
    const entry = { field_key: f.field_key, confidence: Number.isFinite(confidence) ? confidence : 0 };
    const prev = byKey.get(f.field_key);
    if (!prev || entry.confidence > prev.confidence) byKey.set(f.field_key, entry);
  }

  const present: string[] = [];
  const missing: string[] = [];
  const satisfiedConfidences: number[] = [];

  // R33: an unconfirmed far-future date (service_date_unconfirmed) is printed and on file — never "missing" —
  // but keeps `complete` false until a person confirms it. Mirrors api/_lib/documentTypes.js.
  const unconfirmed: string[] = [];
  for (const requirement of required) {
    const alts = requirement.split('|');
    // The alternative the document reads best wins (not the first one listed).
    const hit = alts
      .map((k) => byKey.get(k))
      .filter((x): x is { field_key: string; confidence: number } => !!x)
      .reduce<{ field_key: string; confidence: number } | null>((b, h) => (!b || h.confidence > b.confidence ? h : b), null);
    // Inbox round: an unconfirmed printed date is never bypassed by the "or number" alternative. Mirrors the server.
    const waiting = alts.filter((k) => byKey.has(`${k}_unconfirmed`) && !byKey.has(k));
    if (waiting.length) { unconfirmed.push(waiting.join('|')); continue; }
    if (hit) {
      present.push(hit.field_key);
      satisfiedConfidences.push(hit.confidence);
    } else if (alts.some((k) => byKey.has(`${k}_unconfirmed`))) {
      unconfirmed.push(requirement);
    } else {
      missing.push(requirement);
    }
  }

  const minConfidence = satisfiedConfidences.length
    ? Math.min(...satisfiedConfidences)
    : required.length
      ? 0
      : 1;

  return { type, required, present, missing, unconfirmed, minConfidence, complete: missing.length === 0 && unconfirmed.length === 0 };
}

/* ------------------------------------------------------------------ document kinds (inbox round, 2026-10-21) */
/** Hand-mirrored from api/_lib/documentTypes.js DOCUMENT_KINDS (verify:ui checks parity). A kind is derived from the file
 *  name / title line and never stored: it only changes the label shown and the facts the paper must carry. */
export interface DocumentKindDef { id: string; type: string; label: string; re: RegExp; requires?: string[] }
export const DOCUMENT_KINDS: DocumentKindDef[] = [
  { id: 'pay-application', type: 'invoice', label: 'Pay application', re: /pay[-_ ]?app(?:lication)?\b|application[-_ ]for[-_ ]payment|progress[-_ ]billing|\bg70[23]\b/, requires: ['customer_name|vendor', 'cost'] },
  { id: 'credit-memo', type: 'invoice', label: 'Credit memo', re: /credit[-_ ]?(?:memo|note)|(?:^|[^a-z0-9])cm[-_ ]\d/, requires: ['customer_name|vendor', 'cost'] },
  { id: 'return-slip', type: 'receipt', label: 'Return slip', re: /return[-_ ]?(?:slip|receipt)|refund[-_ ]?(?:slip|receipt)/, requires: ['cost|invoice_number'] },
  { id: 'retainer-receipt', type: 'receipt', label: 'Retainer receipt', re: /retainer/, requires: ['cost'] },
  { id: 'in-kind-receipt', type: 'receipt', label: 'In-kind gift receipt', re: /in[-_ ]?kind/, requires: [] },
  { id: 'filing-receipt', type: 'receipt', label: 'Filing receipt', re: /filing[-_ ]?(?:receipt|fee)/, requires: ['cost|invoice_number|service_date'] },
  { id: 'pickup-ticket', type: 'delivery-ticket', label: 'Pickup / rental ticket', re: /pick[-_ ]?up|rental[-_ ]?(?:ticket|out|return)|will[-_ ]?call|(?:^|[^a-z0-9])pt[-_ ]?\d/ },
  { id: 'packing-slip', type: 'delivery-ticket', label: 'Packing slip', re: /packing[-_ ]?(?:slip|list)|pack[-_ ]?list|(?:^|[^a-z0-9])ps[-_ ]?\d/ },
  { id: 'grant-agreement', type: 'agreement', label: 'Grant agreement / award', re: /grant|award[-_ ]letter|notice[-_ ]of[-_ ]award|(?:^|[^a-z0-9])(?:gr|aw|cg)[-_ ]\d/, requires: [] },
  { id: 'mou', type: 'agreement', label: 'Memorandum of understanding', re: /\bmou\b|memorandum[-_ ]of[-_ ]understanding/, requires: [] },
  { id: 'volunteer-agreement', type: 'agreement', label: 'Volunteer agreement', re: /volunteer/, requires: [] },
  { id: 'pledge', type: 'agreement', label: 'Pledge form', re: /pledge/, requires: [] },
  { id: 'engagement-letter', type: 'agreement', label: 'Engagement letter', re: /engagement|letter[-_ ]of[-_ ]engagement/, requires: [] },
  { id: 'nda', type: 'agreement', label: 'Non-disclosure agreement', re: /\bnda\b|non[-_ ]?disclosure|confidentiality[-_ ]agreement/, requires: [] },
  { id: 'subcontract', type: 'agreement', label: 'Subcontract', re: /sub[-_ ]?contract|(?:^|[^a-z0-9])sc[-_ ]\d/, requires: [] },
  { id: 'amendment', type: 'agreement', label: 'Amendment / addendum', re: /amendment|addendum/, requires: [] },
  { id: 'change-order', type: 'proposal-quote', label: 'Change order', re: /change[-_ ]?order|(?:^|[^a-z0-9])co[-_ ]\d/, requires: ['cost|work_performed'] },
  { id: 'consignor-statement', type: 'statement', label: 'Consignor statement', re: /consign/ },
  { id: 'inventory-count', type: 'internal', label: 'Inventory count', re: /inventory|stock[-_ ]?count|cycle[-_ ]?count/ },
  { id: 'backflow-test', type: 'inspection-report', label: 'Backflow test', re: /backflow|(?:^|[^a-z0-9])bf[-_ ]?\d/, requires: ['service_address|serial_number|customer_name'] },
  { id: 'insurance-policy', type: 'insurance-certificate', label: 'Insurance policy / declarations', re: /declarations?|\bpolicy\b|floater|inland[-_ ]marine/ },
];

export function documentKindFor(typeId: string | null | undefined, filename?: string | null, title?: string | null): DocumentKindDef | null {
  const t = normalizeDocumentType(typeId);
  const hay = `${String(filename ?? '')} ${String(title ?? '')}`.toLowerCase();
  if (!hay.trim()) return null;
  return DOCUMENT_KINDS.find((k) => k.type === t && k.re.test(hay)) ?? null;
}

/** Required facts for one paper: its kind's list when a kind matches and sets one, else the type's own list. */
export function requiredFieldsFor(typeId: string | null | undefined, filename?: string | null, title?: string | null): string[] {
  const t = normalizeDocumentType(typeId);
  const kind = documentKindFor(t, filename, title);
  return kind && Array.isArray(kind.requires) ? kind.requires : (REQUIRED_FIELDS[t] ?? []);
}

const VOID_NAME_RE = /(?:^|[^a-z])void(?:ed)?(?:[^a-z]|$)/i;
/** A VOID paper (file name or title says VOID / VOIDED): kept on file, never counted, never asks a person. Mirrors the server. */
export function isVoidMarked(filename?: string | null, title?: string | null): boolean {
  return VOID_NAME_RE.test(String(filename ?? '').replace(/\.[A-Za-z0-9]{2,5}$/, '')) || VOID_NAME_RE.test(String(title ?? ''));
}

const LABEL_AS_VALUE_RE = /^(?:(?:delivered|deliver|ship(?:ped)?|sold|bill(?:ed)?|remit|invoice[ds]?|paid|received|issued|sent|prepared|attn|attention)(?:\s+(?:to|from|by|for))?|customer(?:\s+name)?|client(?:\s+name)?|vendor(?:\s+name)?|name|payee|payer|tenant|owner|(?:service|project|job|pickup|return|delivery|drop[-\s]?off|billing|mailing|shipping|work)\s+(?:location|address|site)|project|job\s*site|premises|property|certificate\s+holder|insured|n\/?a|none|tbd|unknown|see\s+above|walk[-\s]?in(?:\s+customer)?|cash(?:\s+(?:sale|customer))?)\s*[:#.-]*$/i;
/** A label read as a value ("DELIVERED TO", "N/A", "Walk-in") is never a party. Mirrors the server. */
/** Docread round: a value made only of party-role words ("FUNDER GRANTEE", "OWNER MANAGER" - two column titles read as one
 *  name) or a payment method ("Credit card" under "Paid By") is never a party either. */
const ROLE_WORDS_ONLY_RE = /^(?:(?:funder|grantor|grantee|landlord|tenant|lessor|lessee|shop|store|consignor|consignee|owner|manager|agent|insured|certificate|holder|contractor|subcontractor|client|customer|vendor|supplier|buyer|seller|purchaser|licensee|licensor|provider|recipient|member|company|party|parties|project|site|location|address|service|job|premises|claimant|partner|alliance|firm|attorney|bill|ship|remit|sold|to|from|and|&)\s*)+$/i;
const PAYMENT_METHOD_RE = /^(?:credit\s+card|debit\s+card|card|cash|check|cheque|money\s+order|ach(?:\s+transfer)?|wire(?:\s+transfer)?|bank\s+transfer|online(?:\s+(?:payment|gift|transfer))?|visa|mastercard|amex|american\s+express|discover|paypal|venmo|zelle|eft|in[-\s]kind)(?:\s*[#x*]+\s*\d{0,4})?$/i;
export function isLabelValue(value: unknown): boolean {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  return !v || LABEL_AS_VALUE_RE.test(v) || ROLE_WORDS_ONLY_RE.test(v) || PAYMENT_METHOD_RE.test(v);
}
