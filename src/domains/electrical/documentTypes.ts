/**
 * Electrical domain — document types (SCAFFOLD, not wired to any backend).
 *
 * Mirrors the shape of src/domains/hvac/documentTypes.ts, which is a
 * hand-mirrored copy of the real backend source of truth
 * (api/_lib/documentTypes.js). This file has no backend counterpart yet —
 * there is no api/_lib extraction pipeline for electrical documents, so
 * these ids and required-field lists are a research-informed starting point
 * (see handoffs/INDUSTRY_EXPANSION_2026-09-21.md), not a synced contract.
 * Before this domain goes live, whoever builds the electrical extraction
 * pipeline should treat this file as the draft and update it in place —
 * the same hand-mirror discipline hvac's file documents.
 */

export interface DocumentTypeDef {
  id: string;
  label: string;
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  { id: 'work-order', label: 'Work order' },
  { id: 'invoice', label: 'Invoice' },
  { id: 'warranty-registration', label: 'Warranty registration' },
  { id: 'permit', label: 'Permit' },
  { id: 'inspection-report', label: 'Inspection report' },
  // Electrical-specific: maps a panel's breakers to circuits/loads. No HVAC
  // equivalent — the closest analog (nameplate-photo) captures one
  // equipment record, not a whole panel's circuit map.
  { id: 'panel-schedule', label: 'Panel schedule' },
  { id: 'nameplate-photo', label: 'Nameplate photo' },
  { id: 'maintenance-agreement', label: 'Maintenance agreement' },
  { id: 'service-ticket', label: 'Service ticket' },
  { id: 'dispatch-note', label: 'Dispatch note' },
  { id: 'proposal-quote', label: 'Proposal / quote' },
  { id: 'purchase-order', label: 'Purchase order' },
  { id: 'equipment-record', label: 'Equipment record' },
  { id: 'correspondence', label: 'Correspondence' },
  { id: 'startup-sheet', label: 'Startup sheet' },
  { id: 'internal', label: 'Company record' },
  { id: 'correction-notice', label: 'Correction notice' },
  { id: 'certificate-of-completion', label: 'Certificate of completion' },
  { id: 'load-calculation', label: 'Load calculation' },
  { id: 'contractor-license', label: 'Contractor license' },
  { id: 'certificate-of-insurance', label: 'Certificate of insurance' },
  { id: 'surety-bond', label: 'Surety bond' },
  { id: 'test-report', label: 'Test or study report' },
  { id: 'utility-application', label: 'Utility application' },
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));

/** Required extraction field_keys per type — illustrative, see file header. */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  'work-order': ['service_address', 'service_date', 'technician'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  invoice: ['service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  permit: ['service_address', 'permit_number'],
  'inspection-report': ['service_address', 'service_date'],
  'panel-schedule': ['service_address', 'amperage'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['service_address', 'customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  correspondence: ['customer_name'],
  other: [],
};

export const FIELD_LABELS: Record<string, string> = {
  serial_number: 'Serial number',
  model: 'Model',
  manufacturer: 'Manufacturer',
  equipment_type: 'Equipment type',
  amperage: 'Amperage',
  voltage: 'Voltage',
  phase: 'Phase',
  service_address: 'Service address',
  customer_name: 'Customer',
  installation_date: 'Installation date',
  warranty_expires: 'Warranty expires',
  warranty_term: 'Term',
  service_date: 'Service date',
  technician: 'Technician',
  work_performed: 'Work performed',
  cost: 'Cost',
  invoice_number: 'Invoice number',
  notes: 'Notes',
  permit_number: 'Permit number',
  agreement_term: 'Agreement term',
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
  afci_gfci: 'AFCI/GFCI protection',
  jurisdiction: 'Jurisdiction',
  application_number: 'Application number',
  permit_issue_date: 'Permit issued',
  permit_expiry: 'Permit expires',
  inspection_type: 'Inspection type',
  inspection_result: 'Inspection result',
  correction_items: 'Correction item',
  correction_due: 'Correction due',
  license_number: 'License number',
  license_holder: 'License holder',
  license_expiry: 'License expires',
  insurer: 'Insurer',
  policy_number: 'Policy number',
  policy_expiry: 'Policy expires',
  bond_number: 'Bond number',
  bond_expiry: 'Bond expires',
  code_edition: 'Code edition',
  connected_load: 'Connected load',
  demand_load: 'Demand load',
  service_size: 'Service size',
  circuit_count: 'Circuits',
  next_test_due: 'Next test due',
  utility: 'Utility',
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

/** Required-field completeness for one document. Mirrors hvac's completenessFor. */
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
