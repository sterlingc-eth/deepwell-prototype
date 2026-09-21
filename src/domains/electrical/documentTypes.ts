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
