/**
 * Pipeline step 8 — index: no-op beyond marking the doc indexed at
 * prototype scale. Retrieval reads the graph directly (as M1 does), plus
 * the facet index (`src/core/facetIndex.ts`) built on demand from
 * `GraphSnapshot.facets` — there is no separate build step required here.
 * See docs/INGEST_API.md, "Pipeline", item 8.
 */
import type { Doc } from '../types';
import type { PipelineContext, StepPatch } from './runner';

export async function index(_doc: Doc, _context: PipelineContext): Promise<StepPatch> {
  return {};
}
