/**
 * HVAC DomainAdapter — the vocabulary seed, tier-0 field registry,
 * normalizers and resolution rules the core pipeline (src/core/pipeline/*)
 * runs against. See docs/INGEST_API.md, "DomainAdapter".
 */
import type { Doc, EntityId, Facet, ValueTypeGuess } from '../../core/types';
import type { GraphSnapshot } from '../../core/entityGraph';
import { normalizeByType, normalizeSerialKey } from '../../core/normalize';
import { hvacSchema, HVAC_FIELD_ALIASES } from './schema';

/**
 * The seam every domain plugs into: vocabulary, tier-0 field registry,
 * normalizers, and resolution rules. The core pipeline (src/core/pipeline/*)
 * is written against this interface only, so M3 can move the runner
 * server-side without rewriting the steps.
 */
export interface DomainAdapter {
  schema: typeof hvacSchema;
  normalizeValue(kind: ValueTypeGuess, raw: string): string;
  resolveEntity(
    facetOrField: { labelRaw: string; valueRaw: string; mappedFieldKey?: string },
    graph: GraphSnapshot,
  ): { entityId: EntityId; confidence: number; reason: string } | { provisional: true; entityType: string; fields: Record<string, string> } | null;
  /** Field-signature for near-dup detection: type + normalized key fields, e.g. "warranty-registration|serial:sn-len-456789". */
  dedupeSignature(doc: Doc): string;
  /** Fallback dedupe signature built from unmapped facets when the doc has no mapped type yet. */
  facetSignature(doc: Doc): string;
}

/** Entity fields worth trying to resolve a facet against, per entity type. */
const RESOLVE_FIELDS: Record<string, string[]> = {
  equipment: ['serial', 'model'],
  property: ['address'],
  customer: ['name'],
  technician: ['name'],
};

function entityTypeForFieldKey(fieldKey: string): string | undefined {
  for (const t of hvacSchema.entityTypes) {
    if (t.fields.some((f) => f.key === fieldKey)) return t.id;
  }
  return undefined;
}

function fieldValueKey(valueTypeGuess: ValueTypeGuess | undefined, raw: string): string {
  const guess: ValueTypeGuess = valueTypeGuess ?? 'text';
  return guess === 'serial' || guess === 'identifier' ? normalizeSerialKey(raw) : normalizeByType(guess, raw).toLowerCase();
}

export const hvacAdapter: DomainAdapter = {
  schema: hvacSchema,

  normalizeValue(kind, raw) {
    return normalizeByType(kind, raw);
  },

  resolveEntity(facetOrField, graph) {
    const fieldKey = facetOrField.mappedFieldKey ?? HVAC_FIELD_ALIASES[facetOrField.labelRaw];
    if (!fieldKey) return null;

    const entityType = entityTypeForFieldKey(fieldKey);
    if (!entityType) return null;

    const candidates = Object.values(graph.entities).filter((e) => e.type === entityType);
    const wantKey = fieldValueKey(fieldKey === 'serial' ? 'serial' : fieldKey === 'address' ? 'address' : 'name', facetOrField.valueRaw);

    // Exact normalized match on the field itself.
    for (const e of candidates) {
      const raw = e.fields[fieldKey];
      if (raw === null || raw === undefined) continue;
      const key = fieldValueKey(fieldKey === 'serial' ? 'serial' : fieldKey === 'address' ? 'address' : 'name', String(raw));
      if (key && key === wantKey) return { entityId: e.id, confidence: 0.95, reason: `${fieldKey} exact match` };
    }

    // Fuzzy: substring either direction, on the same field or any of the type's resolve fields.
    const resolveFields = RESOLVE_FIELDS[entityType] ?? [fieldKey];
    let best: { entityId: EntityId; confidence: number; reason: string } | null = null;
    for (const e of candidates) {
      for (const rf of resolveFields) {
        const raw = e.fields[rf];
        if (raw === null || raw === undefined) continue;
        const key = fieldValueKey(rf === 'serial' ? 'serial' : rf === 'address' ? 'address' : 'name', String(raw));
        if (!key) continue;
        if (key.includes(wantKey) || wantKey.includes(key)) {
          const confidence = 0.6;
          if (!best || confidence > best.confidence) best = { entityId: e.id, confidence, reason: `${rf} partial match` };
        }
      }
    }
    if (best) return best;

    // No candidate at all: propose a provisional new entity only when this
    // facet is the entity type's own label field (serial for equipment,
    // address for property, name for customer/technician) — enough on its
    // own to identify a new thing, even before other fields are known.
    const typeSpec = hvacSchema.entityTypes.find((t) => t.id === entityType);
    if (typeSpec && typeSpec.labelField === fieldKey) {
      return { provisional: true, entityType, fields: { [fieldKey]: normalizeByType(fieldKey === 'serial' ? 'serial' : fieldKey === 'address' ? 'address' : 'name', facetOrField.valueRaw) } };
    }

    return null;
  },

  dedupeSignature(doc: Doc): string {
    const present = (name: string) => doc.extracted.find((f) => f.name === name || HVAC_FIELD_ALIASES[f.name] === HVAC_FIELD_ALIASES[name]);
    const keyFieldsByType: Record<string, string[]> = {
      'warranty-registration': ['Serial No.', 'Model'],
      'nameplate-photo': ['Serial No.', 'Model'],
      'startup-sheet': ['Serial No.', 'Date'],
      'work-order': ['Service address', 'Date'],
      invoice: ['Service address', 'Date', 'Total'],
      permit: ['Service address', 'Permit No.'],
      'maintenance-agreement': ['Customer', 'Service address'],
    };
    const keys = keyFieldsByType[doc.typeId ?? ''] ?? ['Service address', 'Date'];
    const parts = keys.map((k) => {
      const f = present(k);
      const raw = f ? (f.correctedValue ?? f.value) : '';
      const alias = HVAC_FIELD_ALIASES[k];
      const guess: ValueTypeGuess = alias === 'serial' ? 'serial' : alias === 'date' ? 'date' : alias === 'address' ? 'address' : alias === 'cost' ? 'money' : 'text';
      return `${alias ?? k}:${normalizeByType(guess, raw).toLowerCase()}`;
    });
    return `${doc.typeId ?? 'unclassified'}|${parts.join('|')}`;
  },

  facetSignature(doc: Doc): string {
    const facets: Facet[] = doc.facets ?? [];
    const parts = facets
      .map((f) => `${f.labelRaw.trim().toLowerCase()}:${normalizeByType(f.valueTypeGuess, f.valueRaw).toLowerCase()}`)
      .sort();
    let hash = 0;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return `facets:${(hash >>> 0).toString(36)}:${parts.length}`;
  },
};
