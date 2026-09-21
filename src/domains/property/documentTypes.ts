/**
 * Property management domain — document types (SCAFFOLD, not wired to any
 * backend). See src/domains/electrical/documentTypes.ts's header — same
 * caveats apply. This is the vertical with the least document-type overlap
 * with hvac (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md): leases,
 * inspections and vendor compliance replace most of hvac's field-ticket
 * paperwork, though invoice/purchase-order/correspondence/service-ticket
 * carry over almost unchanged.
 */

export interface DocumentTypeDef {
  id: string;
  label: string;
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  // Property-management-specific: no hvac equivalent.
  { id: 'lease-agreement', label: 'Lease agreement' },
  { id: 'move-in-inspection', label: 'Move-in inspection' },
  { id: 'move-out-inspection', label: 'Move-out inspection' },
  { id: 'certificate-of-insurance', label: 'Certificate of insurance' },
  // Carried over from hvac largely unchanged.
  { id: 'work-order', label: 'Work order' }, // unit turn / make-ready / maintenance
  { id: 'invoice', label: 'Invoice' },
  { id: 'warranty-registration', label: 'Warranty registration' }, // per-unit appliance
  { id: 'service-ticket', label: 'Service ticket' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'inspection-report', label: 'Inspection report' }, // code/HOA compliance
  { id: 'correspondence', label: 'Correspondence' }, // tenant/owner communication
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

export const REQUIRED_FIELDS: Record<string, string[]> = {
  'lease-agreement': ['unit_number|service_address', 'lease_start', 'lease_end'],
  'move-in-inspection': ['unit_number|service_address', 'inspection_date'],
  'move-out-inspection': ['unit_number|service_address', 'inspection_date'],
  'certificate-of-insurance': ['vendor', 'coi_expiry'],
  'work-order': ['service_address', 'service_date'],
  invoice: ['vendor|service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  'purchase-order': ['vendor', 'cost'],
  'inspection-report': ['service_address', 'inspection_date'],
  correspondence: ['tenant_name|customer_name'],
  other: [],
};

export const FIELD_LABELS: Record<string, string> = {
  serial_number: 'Serial number',
  model: 'Model',
  manufacturer: 'Manufacturer',
  equipment_type: 'Appliance type',
  service_address: 'Property address',
  unit_number: 'Unit',
  tenant_name: 'Tenant',
  customer_name: 'Owner',
  vendor: 'Vendor',
  lease_start: 'Lease start',
  lease_end: 'Lease end',
  rent_amount: 'Rent',
  security_deposit: 'Security deposit',
  coi_expiry: 'COI expires',
  installation_date: 'Installation date',
  warranty_expires: 'Warranty expires',
  warranty_term: 'Term',
  service_date: 'Service date',
  inspection_date: 'Inspection date',
  work_performed: 'Work performed',
  cost: 'Cost',
  invoice_number: 'Invoice number',
  notes: 'Notes',
};

export function fieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

export function requirementLabel(requirement: string): string {
  return requirement.split('|').map(fieldLabel).join(' or ');
}

export function isLegacyOrUnknownType(raw: unknown): boolean {
  if (raw == null || raw === '') return true;
  return !DOCUMENT_TYPE_IDS.has(String(raw).trim());
}

export function normalizeDocumentType(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return 'other';
  if (DOCUMENT_TYPE_IDS.has(s)) return s;
  return 'other';
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
