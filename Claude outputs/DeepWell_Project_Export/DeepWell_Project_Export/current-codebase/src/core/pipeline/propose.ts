/**
 * Pipeline step 4 — propose: clusters unmapped facets into `Proposal` rows
 * per the promotion rules in claude/STORAGE_AND_RETRIEVAL_MODEL.md §4:
 *
 *   - synonym: auto-promote at 2 consistent occurrences against an existing
 *     field with a compatible value type.
 *   - field: auto-promote to "discovered" (tier 1) at ≥3 docs across ≥2
 *     batches with a consistent value type.
 *   - document type / aspect / entity type / relation / enum value: always
 *     left `pending` for a human decision in Review.
 *
 * Rejected proposals are remembered (by deterministic id) so the same noise
 * isn't proposed again.
 */
import type { Doc, DomainSchema, EntityTypeSpec, FieldKind, Proposal, ValueTypeGuess } from '../types';
import type { PipelineContext, StepPatch } from './runner';

function normalizeLabelForCompare(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slug(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '') || 'field'
  );
}

/** Loose compatibility between a shipped field's storage kind and a facet's reading-pass value-type guess. */
function compatibleKind(kind: FieldKind, guess: ValueTypeGuess): boolean {
  if (kind === 'date') return guess === 'date';
  if (kind === 'money') return guess === 'money';
  if (kind === 'serial') return guess === 'serial' || guess === 'identifier';
  if (kind === 'number') return guess === 'number';
  if (kind === 'text') return guess === 'text' || guess === 'name' || guess === 'address' || guess === 'checkbox';
  return false;
}

/** An unmapped label close enough to an existing field's label/synonyms to be a probable synonym, not a new field. */
function fuzzySynonymTarget(labelRaw: string, valueTypeGuess: ValueTypeGuess, schema: DomainSchema): { fieldKey: string } | undefined {
  const norm = normalizeLabelForCompare(labelRaw);
  if (norm.length < 2) return undefined;
  for (const et of schema.entityTypes) {
    for (const f of et.fields) {
      if (!compatibleKind(f.kind, valueTypeGuess)) continue;
      for (const candidateLabel of [f.label, ...(f.synonyms ?? [])]) {
        const c = normalizeLabelForCompare(candidateLabel);
        if (!c || c === norm) continue; // identical would already have been mapped
        if (c.length >= 3 && norm.length >= 3 && (c.includes(norm) || norm.includes(c))) return { fieldKey: f.key };
      }
    }
  }
  return undefined;
}

/** Best-guess entity type for a brand-new field proposal, from the facet's page-neighbor mentions — falls back to the first entity type the schema declares. */
function guessEntityType(schema: DomainSchema): string {
  const first: EntityTypeSpec | undefined = schema.entityTypes[0];
  return first?.id ?? 'unknown';
}

export async function propose(doc: Doc, context: PipelineContext): Promise<StepPatch> {
  const facets = doc.facets ?? [];
  const unmapped = facets.filter((f) => !f.mappedFieldKey && !f.proposalId);
  if (!unmapped.length) return {};

  const schema = context.adapter.schema;
  const allFacets = Object.values(context.graph.facets);
  const existingProposals = context.graph.proposals;

  const pending: Proposal[] = [];
  const autoPromote: Proposal[] = [];
  const facetProposalId = new Map<string, string>();

  for (const facet of unmapped) {
    const norm = normalizeLabelForCompare(facet.labelRaw);
    if (!norm) continue;

    const cluster = allFacets.filter((f) => !f.mappedFieldKey && f.valueTypeGuess === facet.valueTypeGuess && normalizeLabelForCompare(f.labelRaw) === norm);
    const clusterIds = new Set(cluster.map((f) => f.id));
    clusterIds.add(facet.id);
    const clusterDocIds = new Set([...cluster, facet].map((f) => f.documentId));
    const clusterBatchIds = new Set(Array.from(clusterDocIds).map((id) => context.graph.docs[id]?.batchId).filter((b): b is string => Boolean(b)));

    const synonymTarget = fuzzySynonymTarget(facet.labelRaw, facet.valueTypeGuess, schema);
    const kind: Proposal['kind'] = synonymTarget ? 'synonym' : 'field';
    const id = `proposal-${kind}-${slug(norm)}`;
    facetProposalId.set(facet.id, id);

    const existing = existingProposals[id];
    if (existing && existing.status !== 'pending') continue; // confirmed or rejected already — never re-propose identically

    const proposal: Proposal = {
      id,
      kind,
      label: facet.labelRaw,
      targetEntityType: kind === 'field' ? guessEntityType(schema) : undefined,
      targetFieldKey: synonymTarget?.fieldKey,
      evidence: {
        facetIds: Array.from(new Set([...(existing?.evidence.facetIds ?? []), ...clusterIds])),
        documentIds: Array.from(clusterDocIds),
        count: clusterDocIds.size,
        valueTypeGuess: facet.valueTypeGuess,
      },
      status: 'pending',
      createdAt: existing?.createdAt ?? context.now,
    };

    const eligible = kind === 'synonym' ? proposal.evidence.count >= 2 : proposal.evidence.count >= 3 && clusterBatchIds.size >= 2;
    if (eligible) autoPromote.push(proposal);
    else pending.push(proposal);
  }

  const patchedFacets = facets.map((f) => (facetProposalId.has(f.id) ? { ...f, proposalId: facetProposalId.get(f.id) } : f));

  return { facets: patchedFacets, newProposals: pending, autoPromote };
}
