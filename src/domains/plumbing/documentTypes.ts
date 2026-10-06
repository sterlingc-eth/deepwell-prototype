/**
 * Plumbing domain — document types (SCAFFOLD, not wired to any backend).
 * See src/domains/electrical/documentTypes.ts's header — same caveats apply:
 * no api/_lib backend counterpart exists yet, these are a research-informed
 * draft (handoffs/INDUSTRY_EXPANSION_2026-09-21.md), not a synced contract.
 */

export interface DocumentTypeDef {
  id: string;
  label: string;
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  { id: 'work-order', label: 'Work order' },
  { id: 'invoice', label: 'Invoice' },
  { id: 'warranty-registration', label: 'Warranty registration' },
  { id: 'startup-sheet', label: 'Commissioning / startup report' },
  { id: 'permit', label: 'Permit' },
  { id: 'inspection-report', label: 'Inspection report' },
  // Plumbing-specific: most jurisdictions require annual/biennial backflow
  // testing, reported to the water utility. Structurally this is a due-date
  // record like a warranty, not a one-time inspection — see rules.ts.
  { id: 'backflow-test-certificate', label: 'Backflow test certificate' },
  // Plumbing-specific: a video + notes deliverable, increasingly standard
  // for drain/sewer diagnosis and pre-sale inspections.
  { id: 'sewer-camera-report', label: 'Sewer/drain camera report' },
  { id: 'nameplate-photo', label: 'Nameplate photo' },
  { id: 'maintenance-agreement', label: 'Maintenance agreement' },
  { id: 'service-ticket', label: 'Service ticket' },
  { id: 'dispatch-note', label: 'Dispatch note' },
  { id: 'proposal-quote', label: 'Proposal / quote' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'equipment-record', label: 'Equipment record' },
  { id: 'correspondence', label: 'Correspondence' },
  { id: 'internal', label: 'Company record' },
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

export const REQUIRED_FIELDS: Record<string, string[]> = {
  'work-order': ['service_address', 'service_date', 'technician'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  invoice: ['service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date|installation_date'],
  permit: ['service_address', 'permit_number'],
  'inspection-report': ['service_address', 'service_date'],
  'backflow-test-certificate': ['service_address', 'service_date', 'backflow_test_result', 'serial_number|device_location'],
  'sewer-camera-report': ['service_address', 'service_date', 'line_findings|recommendation'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['service_address', 'customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'purchase-order': ['invoice_number|part_number|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  correspondence: ['customer_name'],
  internal: [],
  other: [],
};

export const FIELD_LABELS: Record<string, string> = {
  serial_number: 'Serial number',
  model: 'Model',
  manufacturer: 'Manufacturer',
  equipment_type: 'Equipment type',
  fixture_type: 'Fixture type',
  service_address: 'Service address',
  customer_name: 'Customer',
  installation_date: 'Installation date',
  warranty_expires: 'Warranty expires',
  warranty_term: 'Warranty term',
  service_date: 'Service date',
  backflow_test_result: 'Backflow test result',
  next_test_due: 'Next test due',
  tester_cert_number: 'Tester certification number',
  device_size: 'Device size',
  device_location: 'Device location',
  water_utility: 'Water utility',
  jurisdiction: 'Jurisdiction',
  permit_issued_date: 'Permit issued',
  permit_expires: 'Permit expires',
  permit_status: 'Permit status',
  permit_type: 'Permit type',
  inspection_type: 'Inspection type',
  inspection_result: 'Inspection result',
  fuel_type: 'Fuel type',
  gallons: 'Tank size (gallons)',
  line_location: 'Line location',
  line_findings: 'Line findings',
  recommendation: 'Recommendation',
  footage_ref: 'Footage reference',
  line_length: 'Line length inspected',
  technician: 'Technician',
  work_performed: 'Work performed',
  cost: 'Cost',
  invoice_number: 'Invoice number',
  notes: 'Notes',
  permit_number: 'Permit number',
  agreement_term: 'Maintenance agreement term',
  vendor: 'Vendor',
  equipment_id: 'Equipment ID',
  shop_address: 'Company address',
  shop_phone: 'Company phone',
  shop_email: 'Company email',
  customer_phone: 'Customer phone',
  customer_email: 'Customer email',
  warranty_registered_date: 'Warranty registered',
  service_type: 'Service type',
  part_number: 'Part number',
  labor_hours: 'Labor hours',
  status: 'Status',
  pipe_material: 'Pipe material',
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
