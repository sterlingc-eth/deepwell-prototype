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
  'work-order': ['service_address', 'service_date'],
  // A fleet or shop-owned unit is identified by its serial number, and a ticket can name a part instead of describing the work.
  'service-ticket': ['service_address|serial_number', 'service_date', 'work_performed|part_number'],
  invoice: ['customer_name|vendor', 'service_date', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date'],
  permit: ['service_address', 'permit_number'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address|vendor', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'inspection-report': ['service_address', 'service_date'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  correspondence: [],
  internal: [],
  receipt: ['vendor|customer_name', 'service_date', 'cost'],
  agreement: ['customer_name|vendor', 'agreement_term|service_date'],
  'delivery-ticket': ['customer_name|vendor', 'service_date'],
  schedule: [],
  'price-list': [],
  // Company paperwork: page text is what makes these readable, so no party is demanded of them.
  statement: [],
  'insurance-certificate': [],
  'hr-letter': [],
  other: [],
};

/** Company paperwork (never "Not linked"; leaves Needs you once its own required fields are present).
 *  Mirrors api/_lib/documentTypes.js; verify:ui checks parity. */
export const COMPANY_RECORD_TYPES = new Set([
  'purchase-order', 'internal', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter',
]);
/** Company paperwork only while no customer is named on it. */
export const COMPANY_RECORD_IF_NO_CUSTOMER_TYPES = new Set(['agreement']);
/** Types that need no link when they carry no service address. */
export const LINK_OPTIONAL_TYPES = new Set(['invoice', 'receipt', 'delivery-ticket', 'correspondence']);
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
export function completenessFor(typeId: string, fields: CompletenessField[]): Completeness {
  const type = normalizeDocumentType(typeId);
  const required = REQUIRED_FIELDS[type] ?? [];

  const byKey = new Map<string, { field_key: string; confidence: number }>();
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string' || f.field_key.startsWith('_')) continue;
    if (f.value == null || String(f.value).trim() === '') continue;
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
