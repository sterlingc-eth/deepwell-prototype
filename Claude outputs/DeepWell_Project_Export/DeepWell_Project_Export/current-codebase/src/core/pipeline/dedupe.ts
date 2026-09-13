/**
 * Pipeline step 6 — dedupe (near): exact-hash dedup already happened in
 * `receive.ts`; this step catches near-duplicates via a field signature
 * (`adapter.dedupeSignature`), falling back to a facet signature
 * (`adapter.facetSignature`) when the doc has no mapped type yet.
 * See docs/INGEST_API.md, "Pipeline", item 6.
 */
import type { Doc } from '../types';
import type { PipelineContext, StepPatch } from './runner';

/** A signature with no real content (every key field blank, or a facet signature over zero facets) would match every other blank/empty doc — never flag those. */
function hasSubstance(signature: string): boolean {
  if (signature.startsWith('facets:')) {
    const count = Number(signature.split(':').pop());
    return Number.isFinite(count) && count > 0;
  }
  const [, ...fieldParts] = signature.split('|');
  return fieldParts.some((p) => /[a-z0-9]/i.test(p.split(':').slice(1).join(':')));
}

export async function dedupe(doc: Doc, context: PipelineContext): Promise<StepPatch> {
  if (doc.issues.some((i) => i.kind === 'duplicate' || i.kind === 'possible-duplicate')) return {};

  const signature = doc.typeId ? context.adapter.dedupeSignature(doc) : context.adapter.facetSignature(doc);
  if (!signature || !hasSubstance(signature)) return {};

  const match = Object.values(context.graph.docs).find((d) => {
    if (d.id === doc.id || d.issues.some((i) => i.kind === 'duplicate')) return false;
    const theirs = d.typeId ? context.adapter.dedupeSignature(d) : context.adapter.facetSignature(d);
    return theirs === signature;
  });
  if (!match) return {};

  return { issues: [...doc.issues, { kind: 'possible-duplicate', of: match.id }] };
}
