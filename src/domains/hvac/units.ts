/**
 * Groups a document's extracted fields by unit for Review's panel (owner
 * request 2026-09-20, item 4): a multi-unit document (3 serials, 3 models)
 * currently renders duplicate flat rows ("Serial number", "Serial number")
 * because ReviewScreen lists `doc.extracted` flat. Extraction rows already
 * carry `unit_index` at extraction time (api/_lib/extractFields.js), but no
 * API path surfaces it to the browser yet — see handoffs/REQUESTS_frontend.md.
 * This is written to consume it the moment it is: with no `unitIndex` on any
 * field, single-unit documents (the overwhelming majority today) fall back
 * to one implicit unit (or none, if the document has no equipment fields at
 * all) rather than silently doing nothing.
 */
import type { ExtractedField } from '../../core/types';

/** Field keys that describe one physical piece of equipment rather than the
 *  whole document — mirrors api/_lib/extractFields.js's UNIT_SCOPED_FIELDS
 *  exactly, so grouping agrees with how the backend already dedupes these. */
const UNIT_SCOPED_FIELDS = new Set([
  'equipment_id',
  'serial_number',
  'model',
  'manufacturer',
  'equipment_type',
  'tonnage',
  'refrigerant',
  'installation_date',
]);

export interface UnitGroup<F> {
  unitIndex: number;
  /** "Unit 1 · RTU-1 · Trane YSC060E3RHA · serial 21341ABCD" — only the parts
   *  actually on file are joined in. */
  label: string;
  fields: F[];
  /** The entity id this unit's fields already resolved to, if any — read off
   *  whichever field in the group carries a `target` (see usePostgresSync's
   *  toDoc, which only sets `target` when the extraction row has an
   *  `entity_id`). Null means "not linked to an equipment record yet". */
  equipmentEntityId: string | null;
}

export interface GroupedExtractions<F> {
  /** Fields that apply to the whole document (customer_name, service_address,
   *  warranty_term, cost, …), not to any one unit. */
  shared: F[];
  /** In unit-index order. Empty for a document with no equipment fields at all. */
  units: UnitGroup<F>[];
}

type Groupable = Pick<ExtractedField, 'name' | 'value' | 'correctedValue' | 'target'> & { unitIndex?: number };

function fieldValue(f: Pick<Groupable, 'value' | 'correctedValue'>): string | null {
  const v = (f.correctedValue ?? f.value ?? '').trim();
  return v || null;
}

function labelFor(unitIndex: number, fields: Groupable[]): string {
  const get = (key: string) => fieldValue(fields.find((f) => f.name === key) ?? { value: '' });
  const parts = [`Unit ${unitIndex}`];
  const tag = get('equipment_id');
  if (tag) parts.push(tag);
  const nameplate = [get('manufacturer'), get('model')].filter(Boolean).join(' ');
  if (nameplate) parts.push(nameplate);
  const serial = get('serial_number');
  if (serial) parts.push(`serial ${serial}`);
  return parts.join(' · ');
}

function equipmentEntityIdFor(fields: Groupable[]): string | null {
  return fields.find((f) => f.target?.entityId)?.target?.entityId ?? null;
}

export function groupExtractionsByUnit<F extends Groupable>(fields: F[]): GroupedExtractions<F> {
  const tagged = fields.filter((f) => f.unitIndex != null);

  if (tagged.length === 0) {
    // No backend unit_index yet (or a genuinely single-unit document): treat
    // every UNIT_SCOPED field as one implicit "Unit 1" so a serial/model/
    // manufacturer trio still reads as one unit's nameplate, not three
    // unrelated document-level facts. A document with none of those fields
    // (an invoice, a permit) gets no unit section at all.
    const unitScoped = fields.filter((f) => UNIT_SCOPED_FIELDS.has(f.name));
    if (unitScoped.length === 0) return { shared: fields, units: [] };
    const shared = fields.filter((f) => !UNIT_SCOPED_FIELDS.has(f.name));
    return {
      shared,
      units: [{ unitIndex: 1, label: labelFor(1, unitScoped), fields: unitScoped, equipmentEntityId: equipmentEntityIdFor(unitScoped) }],
    };
  }

  const shared = fields.filter((f) => f.unitIndex == null);
  const byIndex = new Map<number, F[]>();
  for (const f of tagged) {
    const idx = f.unitIndex as number;
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    (byIndex.get(idx) as F[]).push(f);
  }
  const units = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([unitIndex, unitFields]) => ({
      unitIndex,
      label: labelFor(unitIndex, unitFields),
      fields: unitFields,
      equipmentEntityId: equipmentEntityIdFor(unitFields),
    }));
  return { shared, units };
}
