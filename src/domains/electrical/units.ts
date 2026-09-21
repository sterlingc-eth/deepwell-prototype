/**
 * Groups a document's extracted fields by unit (one panel per group) —
 * mirrors src/domains/hvac/units.ts exactly, with UNIT_SCOPED_FIELDS swapped
 * for electrical's nameplate fields (amperage/voltage/phase instead of
 * tonnage/refrigerant). See that file for the full rationale; this is a
 * scaffold with no extraction backend behind it yet (see documentTypes.ts
 * header), so `unitIndex` will never actually be populated today — the
 * single-implicit-unit fallback path is the only one exercised.
 */
import type { ExtractedField } from '../../core/types';

const UNIT_SCOPED_FIELDS = new Set([
  'equipment_id',
  'serial_number',
  'model',
  'manufacturer',
  'equipment_type',
  'amperage',
  'voltage',
  'phase',
  'installation_date',
]);

export interface UnitGroup<F> {
  unitIndex: number;
  label: string;
  fields: F[];
  equipmentEntityId: string | null;
}

export interface GroupedExtractions<F> {
  shared: F[];
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
  const amps = get('amperage');
  if (amps) parts.push(`${amps}A`);
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
