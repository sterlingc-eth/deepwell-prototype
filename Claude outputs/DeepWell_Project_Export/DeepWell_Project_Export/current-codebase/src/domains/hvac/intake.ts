/**
 * HVAC intake helpers: classify a file by name (mock of the classifier), and
 * decide where a filled-in field should land in the entity graph.
 */
import type { Doc, FieldTarget } from '../../core/types';
import type { GraphSnapshot } from '../../core/entityGraph';
import { HVAC_FIELD_ALIASES } from './schema';

export function classifyByFilename(filename: string): string {
  const f = filename.toLowerCase();
  if (/warranty|warrantyreg|registration/.test(f)) return 'warranty-registration';
  if (/\bwo[-_]|work[-_]?order/.test(f)) return 'work-order';
  if (/invoice|inv[-_]/.test(f)) return 'invoice';
  if (/permit/.test(f)) return 'permit';
  if (/startup|start-up/.test(f)) return 'startup-sheet';
  if (/agreement|maint/.test(f)) return 'maintenance-agreement';
  if (/nameplate|plate|img_|\.jpe?g$|\.png$|\.heic$/.test(f)) return 'nameplate-photo';
  return 'other';
}

export function fileTypeOf(filename: string): Doc['fileType'] {
  const f = filename.toLowerCase();
  if (/\.(jpe?g|png|heic|webp|gif)$/.test(f)) return 'image';
  if (/\.(xlsx?|csv)$/.test(f)) return 'spreadsheet';
  if (/\.pdf$/.test(f)) return 'pdf';
  return 'text';
}

/** Which entity field a document field should populate, given what the doc is linked to. */
export function targetFor(doc: Doc, fieldName: string, g: GraphSnapshot): FieldTarget | undefined {
  const key = HVAC_FIELD_ALIASES[fieldName];
  if (!key) return undefined;
  const wantType = key === 'address' || key === 'customerName' ? 'property' : ['serial', 'model', 'manufacturer', 'installDate', 'warrantyExpiry'].includes(key) ? 'equipment' : null;
  if (!wantType) return undefined;
  const entityId = doc.linkedEntityIds.find((id) => g.entities[id]?.type === wantType);
  return entityId ? { entityId, field: key } : undefined;
}

/** Filenames used by the "Add sample files" button, so the flow can be demoed without a file picker. */
export const SAMPLE_UPLOADS = [
  'WarrantyReg_York_YCG36_SN-YRK-990011.pdf',
  'WO-20260909-8765-w-thunderbird.pdf',
  'IMG_4502_nameplate.jpg',
  'Invoice_2026-0912_Indian_School.pdf',
];
