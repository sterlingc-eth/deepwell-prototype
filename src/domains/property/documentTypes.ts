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
  { id: 'vendor-contract', label: 'Vendor contract' },
  { id: 'rent-roll', label: 'Rent roll' },
  // Carried over from hvac largely unchanged.
  { id: 'work-order', label: 'Work order' }, // unit turn / make-ready / maintenance
  { id: 'invoice', label: 'Invoice' },
  { id: 'warranty-registration', label: 'Appliance warranty' }, // per-unit appliance
  { id: 'service-ticket', label: 'Maintenance visit record' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'inspection-report', label: 'Inspection report' }, // code/HOA compliance
  { id: 'correspondence', label: 'Correspondence' }, // tenant/owner communication
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

export const REQUIRED_FIELDS: Record<string, string[]> = {
  'lease-agreement': ['unit_number|service_address', 'lease_start_date|lease_end_date'],
  'move-in-inspection': ['unit_number|service_address', 'service_date'],
  'move-out-inspection': ['unit_number|service_address', 'service_date'],
  'certificate-of-insurance': ['vendor', 'coi_expires'],
  'vendor-contract': ['vendor', 'contract_start|contract_end'],
  'rent-roll': ['rent_roll_row'],
  'work-order': ['service_address|property_name', 'service_date'],
  invoice: ['vendor|service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  'purchase-order': ['vendor', 'cost'],
  'inspection-report': ['service_address|property_name', 'service_date'],
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
  lease_start_date: 'Lease start',
  lease_end_date: 'Lease end',
  rent_amount: 'Rent',
  security_deposit: 'Security deposit',
  coi_expiry: 'Insurance certificate expires',
  coi_expires: 'Insurance certificate expires',
  property_name: 'Property name',
  opened_date: 'Opened',
  completed_date: 'Completed',
  work_order_number: 'Work order number',
  priority: 'Priority',
  invoice_date: 'Invoice date',
  invoice_due: 'Invoice due',
  insurer: 'Insurer',
  policy_number: 'Policy number',
  policy_expiry: 'Policy expires',
  coverage_type: 'Coverage',
  gl_limit: 'General liability limit',
  workers_comp: 'Workers compensation',
  contract_scope: 'Contract scope',
  contract_start: 'Contract start',
  contract_end: 'Contract end',
  agreement_term: 'Contract term',
  auto_renew: 'Auto-renews',
  monthly_amount: 'Monthly amount',
  inspection_type: 'Inspection type',
  inspection_result: 'Inspection result',
  deficiency: 'Deficiency',
  reinspection_due: 'Reinspection due',
  rent_roll_row: 'Rent roll unit',
  technician: "Vendor's technician",
  status: 'Status',
  installation_date: 'Installation date',
  warranty_expires: 'Warranty expires',
  warranty_term: 'Warranty term',
  service_date: 'Service date',
  inspection_date: 'Inspection date',
  work_performed: 'Work performed',
  cost: 'Cost',
  invoice_number: 'Invoice number',
  notes: 'Notes',
  permit_number: 'Permit number',
  rent_roll_unread: 'Rent roll rows not read',
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
  /** R33: requirements met only by an unconfirmed far-future date. Optional so older payloads still type-check. */
  unconfirmed?: string[];
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

  // R33: an unconfirmed far-future date (service_date_unconfirmed) is printed and on file — never "missing" —
  // but keeps `complete` false until a person confirms it. Mirrors api/_lib/documentTypes.js.
  const unconfirmed: string[] = [];
  for (const requirement of required) {
    const alts = requirement.split('|');
    const hit = alts.map((k) => byKey.get(k)).find((x): x is { field_key: string; confidence: number } => !!x);
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
