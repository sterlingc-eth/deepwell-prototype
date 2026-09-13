/**
 * Pipeline step 3 — map: the schema-aware mapping pass. Calls
 * `POST /api/ingest/map` with the doc's unmapped facets and a snapshot of
 * the current registry; returns which facets matched (→ extractions) and
 * which stayed unmapped, plus a document-type/aspect guess. See
 * docs/INGEST_API.md, "Pipeline", item 3 and "`POST /api/ingest/map`".
 *
 * Returns the raw mapping result — `useGraph.ingestMap` (src/core/entityGraph.ts)
 * is what actually turns matches into extractions and advances the stage,
 * per the contract's named ingestion actions.
 */
import type { Doc, DocumentTypeSpec, ValueTypeGuess } from '../types';
import type { PipelineContext } from './runner';
import type { IngestMapMatch, IngestMapResult } from '../entityGraph';

interface RegistryField {
  entityType: string;
  key: string;
  label: string;
  synonyms: string[];
}
interface RegistryPayload {
  documentTypes: DocumentTypeSpec[];
  fields: RegistryField[];
}

interface MapApiMatch {
  facetIndex: number;
  entityType: string;
  fieldKey: string;
  valueNorm: string;
  confidence: number;
  method: 'registry' | 'synonym' | 'learned';
}
interface MapApiResponse {
  documentType: { id: string; confidence: number } | null;
  aspects: string[];
  matches: MapApiMatch[];
  unmatchedIndices: number[];
}

function buildRegistry(context: PipelineContext): RegistryPayload {
  const schema = context.adapter.schema;
  return {
    documentTypes: schema.documentTypes,
    fields: schema.entityTypes.flatMap((et) => et.fields.map((f) => ({ entityType: et.id, key: f.key, label: f.label, synonyms: f.synonyms ?? [] }))),
  };
}

/** Runs the mapping pass for every facet on `doc` that isn't mapped yet. Returns an empty result when there's nothing to map. */
export async function map(doc: Doc, context: PipelineContext): Promise<IngestMapResult> {
  const facets = doc.facets ?? [];
  const unmapped = facets.filter((f) => !f.mappedFieldKey);
  if (!unmapped.length) return { documentType: null, aspects: [], matches: [] };

  const body = {
    documentId: doc.id,
    facets: unmapped.map((f, index) => ({ index, labelRaw: f.labelRaw, valueRaw: f.valueRaw, valueTypeGuess: f.valueTypeGuess as ValueTypeGuess })),
    registry: buildRegistry(context),
    filenameHint: doc.filename,
  };

  const res = await fetch('/api/ingest/map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST /api/ingest/map failed: ${res.status}`);
  const result = (await res.json()) as MapApiResponse;

  const matches: IngestMapMatch[] = [];
  for (const m of result.matches) {
    const facet = unmapped[m.facetIndex];
    if (!facet) continue; // server should never send an out-of-range index, but never trust it either
    matches.push({ facetId: facet.id, entityType: m.entityType, fieldKey: m.fieldKey, valueNorm: m.valueNorm, confidence: m.confidence, method: m.method });
  }

  // A guess of the schema's own catch-all type ("other") backed by zero
  // matched fields isn't a classification — it's the model saying "I found
  // nothing that fits", which is exactly the park-with-no-type case (a
  // flyer, a blank cover page). Only accept "other" when it's carrying at
  // least one real match; otherwise leave the document unclassified rather
  // than force it into a type that means nothing here.
  const isEmptyFallback = result.documentType?.id === context.adapter.schema.fallbackDocumentType && matches.length === 0;
  const documentType = isEmptyFallback ? null : result.documentType;

  return { documentType, aspects: result.aspects ?? [], matches };
}
