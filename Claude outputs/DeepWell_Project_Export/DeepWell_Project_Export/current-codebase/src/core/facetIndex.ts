/**
 * Facet index — index #3 in claude/STORAGE_AND_RETRIEVAL_MODEL.md ("Facet
 * index (key/value + text)"), the one that makes unmapped and long-tail
 * facets answerable before anyone has defined a field for them. Identifier
 * (exact) and structured (typed) indexes are #1–2, already covered by
 * `api/_lib/retrieve.js`'s entity-field matching.
 *
 * Lexical/substring for the prototype; embeddings are an M3 concern.
 */
import type { DocumentId, EntityId, ValueTypeGuess } from './types';
import type { GraphSnapshot } from './entityGraph';

export interface FacetIndexEntry {
  facetId: string;
  documentId: DocumentId;
  entityIds: EntityId[];
  labelRaw: string;
  valueRaw: string;
  valueTypeGuess: ValueTypeGuess;
  /** Lowercased "label value", for substring/lexical matching. */
  searchText: string;
}

/** Builds the facet index from every facet in the graph snapshot, mapped or not. */
export function buildFacetIndex(g: GraphSnapshot): FacetIndexEntry[] {
  return Object.values(g.facets).map((f) => ({
    facetId: f.id,
    documentId: f.documentId,
    entityIds: f.linkedEntityIds,
    labelRaw: f.labelRaw,
    valueRaw: f.valueRaw,
    valueTypeGuess: f.valueTypeGuess,
    searchText: `${f.labelRaw} ${f.valueRaw}`.toLowerCase(),
  }));
}

/** Substring match against every search term (AND across terms, case-insensitive). */
export function searchFacets(index: FacetIndexEntry[], terms: string[]): FacetIndexEntry[] {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return [];
  return index.filter((entry) => needles.every((n) => entry.searchText.includes(n)));
}

/** Facet-index entries touching any of the given entities — the shape `unmappedFacets` on an Ask request needs. */
export function facetsForEntities(index: FacetIndexEntry[], entityIds: EntityId[]): FacetIndexEntry[] {
  const wanted = new Set(entityIds);
  return index.filter((entry) => entry.entityIds.some((id) => wanted.has(id)));
}
