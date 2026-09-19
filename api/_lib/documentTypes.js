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
  { id: 'other', label: 'Other' },
];

export const DOCUMENT_TYPE_IDS = new Set(DOCUMENT_TYPES.map((t) => t.id));
const TYPE_LABEL = new Map(DOCUMENT_TYPES.map((t) => [t.id, t.label]));

export function documentTypeLabel(typeId) {
  return TYPE_LABEL.get(typeId) ?? TYPE_LABEL.get('other');
}

/** One-line definitions for the model's classification prompt. Static text —
 *  part of extractFields.js's cacheable prompt block, never per-document. */
export const DOCUMENT_TYPE_DEFINITIONS = {
  'work-order': 'A dispatched job: address, date, technician, and what to do — not yet completed.',
  'invoice': 'A bill for work or equipment: a customer, a charge, a total cost.',
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
  'other': 'Does not clearly fit any type above.',
};

/**
 * Required extraction field_keys per type. A `a|b` entry means either
 * satisfies the requirement. Keys match api/_lib/extractFields.js's
 * FIELD_KEYS (plus permit_number, added there for exactly this).
 */
export const REQUIRED_FIELDS = {
  'work-order': ['service_address', 'service_date', 'technician'],
  'service-ticket': ['service_address', 'service_date', 'work_performed'],
  'invoice': ['service_address', 'cost'],
  'warranty-registration': ['serial_number', 'model', 'warranty_expires|warranty_term'],
  'startup-sheet': ['serial_number', 'service_date'],
  'permit': ['service_address', 'permit_number'],
  'nameplate-photo': ['serial_number', 'model'],
  'maintenance-agreement': ['service_address', 'customer_name', 'warranty_term|agreement_term'],
  'dispatch-note': ['customer_name|service_address', 'service_date'],
  'proposal-quote': ['customer_name|service_address', 'cost'],
  'inspection-report': ['service_address', 'service_date'],
  'purchase-order': ['vendor|customer_name', 'cost'],
  'equipment-record': ['serial_number|model'],
  'correspondence': ['customer_name'],
  'other': [],
};

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

export function fieldLabel(fieldKey) {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

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
 * canonical / legacy / free-text -> canonical id. Never returns null or
 * 'unclassified' — the fallback is always 'other'.
 *
 * `facts` is optional and only consulted for the one legacy id
 * (`install_record`) whose correct mapping depends on what was extracted.
 */
export function normalizeDocumentType(raw, facts = {}) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return 'other';
  if (DOCUMENT_TYPE_IDS.has(s)) return s;
  if (s === 'install-record') {
    return (facts?.cost || facts?.invoice_number) ? 'invoice' : 'startup-sheet';
  }
  return LEGACY_MAP[s] ?? 'other';
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
    return 'warranty-registration';
  }
  if (has('invoice_number') || has('cost')) return 'invoice';
  if (has('work_performed')) return 'service-ticket';
  if (has('service_date') && has('technician')) return 'work-order';
  if (has('installation_date')) return 'startup-sheet';
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
export function resolveDocumentType(toolInput, facts, filename) {
  const raw = toolInput?.document_type;
  const rawConf = Number(toolInput?.document_type_confidence);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.6;

  if (typeof raw === 'string' && raw.trim()) {
    const normalized = normalizeDocumentType(raw, facts);
    if (DOCUMENT_TYPE_IDS.has(normalized) && normalized !== 'other') {
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
export function completenessFor(typeId, fields) {
  const type = normalizeDocumentType(typeId);
  const required = REQUIRED_FIELDS[type] ?? [];

  const byKey = new Map();
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field_key !== 'string') continue;
    if (f.value == null || String(f.value).trim() === '') continue;
    const confidence = Number(f.confidence);
    const entry = { field_key: f.field_key, confidence: Number.isFinite(confidence) ? confidence : 0 };
    const prev = byKey.get(f.field_key);
    if (!prev || entry.confidence > prev.confidence) byKey.set(f.field_key, entry);
  }

  const present = [];
  const missing = [];
  const satisfiedConfidences = [];

  for (const requirement of required) {
    const hit = requirement.split('|').map((k) => byKey.get(k)).find(Boolean);
    if (hit) {
      present.push(hit.field_key);
      satisfiedConfidences.push(hit.confidence);
    } else {
      missing.push(requirement);
    }
  }

  // No requirements to satisfy (type 'other') counts as fully confident, not
  // zero — there is nothing here for a low confidence to be ABOUT.
  const minConfidence = satisfiedConfidences.length
    ? Math.min(...satisfiedConfidences)
    : (required.length ? 0 : 1);

  return { type, required, present, missing, minConfidence, complete: missing.length === 0 };
}
