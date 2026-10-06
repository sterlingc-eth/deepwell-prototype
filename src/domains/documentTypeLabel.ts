import { DOCUMENT_TYPES as HVAC_TYPES, isPropertyLabelIndustry, labelIndustryId } from './hvac/documentTypes';
import { DOCUMENT_TYPES as PLUMBING_TYPES } from './plumbing/documentTypes';
import { DOCUMENT_TYPES as ELECTRICAL_TYPES } from './electrical/documentTypes';
import { DOCUMENT_TYPES as PROPERTY_TYPES } from './property/documentTypes';

const HVAC_LABELS = new Map(HVAC_TYPES.map((t) => [t.id, t.label]));
const PROPERTY_LABELS = new Map(PROPERTY_TYPES.map((t) => [t.id, t.label]));
const PLUMBING_LABELS = new Map(PLUMBING_TYPES.map((t) => [t.id, t.label]));
const ELECTRICAL_LABELS = new Map(ELECTRICAL_TYPES.map((t) => [t.id, t.label]));

/** An unknown id in plain words ("rent-roll-summary" -> "Rent roll summary"), never the raw id. */
export function plainTypeWords(id: string): string {
  const t = id.replace(/[-_]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Document';
}

/** The label for a document type id. Property companies read the property list (same setter as the field labels); every other
 *  company keeps the HVAC list exactly as before. Returns undefined for an unknown id when not a property company. */
export function documentTypeLabel(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  if (isPropertyLabelIndustry()) return PROPERTY_LABELS.get(id) ?? plainTypeWords(id);
  const ind = labelIndustryId();
  if (ind === 'plumbing') return PLUMBING_LABELS.get(id) ?? plainTypeWords(id);
  if (ind === 'electrical') return ELECTRICAL_LABELS.get(id) ?? plainTypeWords(id);
  return HVAC_LABELS.get(id);
}
