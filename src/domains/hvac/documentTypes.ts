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
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

/**
 * Required extraction field_keys per type. A `a|b` entry means either
 * satisfies the requirement. Keys match api/_lib/extractFields.js's
 * FIELD_KEYS.
 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  'work-order': ['service_address', 'service_date', 'technician'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  invoice: ['service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date'],
  permit: ['service_address', 'permit_number'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['service_address', 'customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'inspection-report': ['service_address', 'service_date'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  correspondence: ['customer_name'],
  other: [],
};

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
  shop_address: 'Shop address',
  shop_phone: 'Shop phone',
  shop_email: 'Shop email',
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
  minConfidence: number;
  complete: boolean;
}

/** Required-field completeness for one document. Mirrors api/_lib/documentTypes.js's completenessFor exactly. */
export function completenessFor(typeId: string, fields: CompletenessField[]): Completeness {
  const type = normalizeDocumentType(typeId);
  const required = REQUIRED_FIELDS[type] ?? [];

  const byKey = new Map<string, { field_key: string; confidence: number }>();
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string') continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    const confidence = Number(f.confidence);
    const entry = { field_key: f.field_key, confidence: Number.isFinite(confidence) ? confidence : 0 };
    const prev = byKey.get(f.field_key);
    if (!prev || entry.confidence > prev.confidence) byKey.set(f.field_key, entry);
  }

  const present: string[] = [];
  const missing: string[] = [];
  const satisfiedConfidences: number[] = [];

  for (const requirement of required) {
    const hit = requirement.split('|').map((k) => byKey.get(k)).find((x): x is { field_key: string; confidence: number } => !!x);
    if (hit) {
      present.push(hit.field_key);
      satisfiedConfidences.push(hit.confidence);
    } else {
      missing.push(requirement);
    }
  }

  const minConfidence = satisfiedConfidences.length
    ? Math.min(...satisfiedConfidences)
    : required.length
      ? 0
      : 1;

  return { type, required, present, missing, minConfidence, complete: missing.length === 0 };
}
