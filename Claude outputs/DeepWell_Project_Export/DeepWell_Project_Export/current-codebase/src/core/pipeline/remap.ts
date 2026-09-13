/**
 * Re-map on promotion — "re-map, not re-OCR" (claude/STORAGE_AND_RETRIEVAL_MODEL.md §3).
 *
 * When a `field` or `synonym` Proposal is confirmed, `useGraph.confirmProposal`
 * calls this to re-run the mapping pass *locally* (no model call, no
 * re-reading the source document) over every facet already tagged as
 * evidence for that proposal, against the now-updated registry. Matching
 * facets become extractions on their document, exactly as the mapping pass
 * (`map.ts`) would have produced had the registry known about the field or
 * synonym at read time.
 */
import type { Doc, DocumentId, DomainSchema, ExtractedField, Facet, Proposal } from '../types';

function findFieldForLabel(schema: DomainSchema, labelRaw: string): { entityType: string; key: string } | undefined {
  const norm = labelRaw.trim().toLowerCase();
  for (const et of schema.entityTypes) {
    for (const f of et.fields) {
      if (f.label.toLowerCase() === norm) return { entityType: et.id, key: f.key };
      if ((f.synonyms ?? []).some((s) => s.toLowerCase() === norm)) return { entityType: et.id, key: f.key };
    }
  }
  return undefined;
}

export interface RemapResult {
  docs: Record<DocumentId, Doc>;
  facets: Record<string, Facet>;
  /** Facets that changed — for the caller to persist without rewriting everything. */
  touchedFacetIds: string[];
  /** Docs that changed — for the caller to persist without rewriting everything. */
  touchedDocIds: DocumentId[];
}

/**
 * Pure re-map: given the proposal's evidence facet ids, the full facets/docs
 * maps, the updated schema and the registry version this promotion landed
 * on, returns updated copies of only the affected facets and documents.
 */
export function remap(proposal: Proposal, docs: Record<DocumentId, Doc>, facets: Record<string, Facet>, schema: DomainSchema, schemaVersion: number): RemapResult {
  const nextFacets = { ...facets };
  const nextDocs = { ...docs };
  const touchedFacetIds: string[] = [];
  const touchedDocIds: DocumentId[] = [];

  for (const facetId of proposal.evidence.facetIds) {
    const facet = nextFacets[facetId];
    if (!facet || facet.mappedFieldKey) continue;
    const match = findFieldForLabel(schema, facet.labelRaw);
    if (!match) continue;

    const updatedFacet: Facet = {
      ...facet,
      mappedEntityType: match.entityType,
      mappedFieldKey: match.key,
      mappingConfidence: 0.85,
      mappingMethod: 'learned',
      schemaVersionAtMapping: schemaVersion,
      proposalId: undefined,
    };
    nextFacets[facetId] = updatedFacet;
    touchedFacetIds.push(facetId);

    const doc = nextDocs[facet.documentId];
    if (!doc) continue;
    const alreadyExtracted = doc.extracted.some((f) => f.name === facet.labelRaw);
    const newExtraction: ExtractedField = { name: facet.labelRaw, value: facet.valueRaw, confidence: updatedFacet.mappingConfidence ?? 0.85, location: { page: facet.page, field: facet.labelRaw } };
    const docFacets = (doc.facets ?? []).map((f) => (f.id === facet.id ? updatedFacet : f));
    nextDocs[facet.documentId] = { ...doc, facets: docFacets, extracted: alreadyExtracted ? doc.extracted : [...doc.extracted, newExtraction] };
    touchedDocIds.push(facet.documentId);
  }

  return { docs: nextDocs, facets: nextFacets, touchedFacetIds: Array.from(new Set(touchedFacetIds)), touchedDocIds: Array.from(new Set(touchedDocIds)) };
}
