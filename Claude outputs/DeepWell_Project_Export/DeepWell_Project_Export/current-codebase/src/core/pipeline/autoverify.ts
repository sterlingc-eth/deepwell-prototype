/**
 * Pipeline step 8 — auto-verify: confidence-tiered auto-approval BY
 * CONSEQUENCE, not by one global threshold. This is layer 1 of
 * `claude/INGESTION_STRATEGY_AT_SCALE.md` — the answer to "a company is
 * trusting us with thousands of documents" can't be a single review queue
 * that treats a misread technician name the same as a misread warranty
 * date. See docs/INGEST_API.md, "Pipeline", item 8 (renumbers the old
 * no-op `index.ts` to item 9).
 *
 * Before this step existed, a document only ever reached 'linked' or
 * 'verified' when a person clicked Approve in Review — `ingestMap` computes
 * `maxStageFor` before `resolve.ts` has even run (so `linkedEntityIds` is
 * still empty), and no step after `resolve` ever recomputed `stage`. That's
 * maximally conservative but doesn't scale: at real volume it means a human
 * has to open every single document just to make it minimally answerable
 * as Unverified. This step splits that into two questions:
 *
 *   1. Is the document structurally complete? (required fields present,
 *      linked to an entity, no open conflicts — `maxStageFor`'s existing
 *      logic, unchanged.) If not, advance as far as that structurally
 *      allows — this alone makes "Unverified but answerable" available
 *      immediately instead of only after a human's first click.
 *   2. If it's structurally ready for 'verified' — the stage Ask treats as
 *      ground truth with no caveat — is every consequential fact on it
 *      trustworthy enough to skip a human? That depends on what the field
 *      controls, not how confident the model was:
 *        - high consequence (warranty expiry, serial — see
 *          `src/domains/hvac/schema.ts`): never auto-verify. A human must
 *          look at least once, ever, per (entity, field) — later documents
 *          reporting the same value can lean on that human look, but
 *          nothing skips the first one.
 *        - medium consequence (technician, service date, cost): auto-verify
 *          only once an independent document already reports the same
 *          normalized value for the same (entity, field) — one document's
 *          say-so is exactly the failure mode a 95%-aggregate-accuracy
 *          number hides. A prior human look also satisfies this.
 *        - low consequence (freeform notes, work-performed descriptions):
 *          unchanged — auto, no gate.
 *      A blocked document stays at 'linked' (still answerable as
 *      Unverified) with a `needs-verification` issue explaining which
 *      field and why; it shows up in Review's "Needs a person" queue. The
 *      *existing* Approve button always clears this — a human reviewing the
 *      whole document satisfies both the high-consequence "at least once"
 *      rule and the medium-consequence corroboration bar at once.
 *
 * Known limitation, honestly noted rather than hidden: corroboration is
 * only checked at *this* document's ingest time, against documents already
 * in the graph. A medium-consequence value that was the only observation
 * when *it* ran stays blocked even after a second, corroborating document
 * arrives later — it isn't retroactively re-evaluated (the same tradeoff
 * `remap.ts` makes for schema promotion: targeted, not a full re-scan). The
 * Approve button is always available as the escape hatch, so nothing is
 * ever stuck — it just means a document doesn't silently un-block itself.
 * A real fix (re-run this step over previously-blocked docs when a new
 * corroborating document lands) is a reasonable, bounded follow-up.
 */
import type { Doc, DocumentIssue, EntityId, Facet } from '../types';
import type { PipelineContext, StepPatch } from './runner';
import { fieldConsequence, maxStageFor } from '../entityGraph';
import { normalizeSerialKey } from '../normalize';

/** Has some OTHER document already carried this (entity, field) all the way to 'verified' under an actual person's name (not this same auto-verify step, which stamps `verifiedBy: 'system'`)? That prior human look is what the high-consequence tier requires at least once, ever, and what satisfies the medium-consequence tier outright. */
function priorHumanVerification(context: PipelineContext, entityId: EntityId, fieldKey: string, excludeDocId: string): boolean {
  for (const d of Object.values(context.graph.docs)) {
    if (d.id === excludeDocId || d.stage !== 'verified' || !d.verifiedBy || d.verifiedBy === 'system') continue;
    if ((d.facets ?? []).some((f) => f.mappedFieldKey === fieldKey && f.linkedEntityIds.includes(entityId))) return true;
  }
  return false;
}

/** Does some OTHER document, verified or not, independently report the same normalized value for this (entity, field)? Two documents agreeing is the medium-consequence tier's corroboration bar — mirrors `conflicts.ts`'s own same-entity-same-field comparison, including its confusable-tolerant serial/identifier matching. */
function hasCorroboration(context: PipelineContext, thisDocId: string, facet: Facet, entityId: EntityId, fieldKey: string): boolean {
  const mine = context.adapter.normalizeValue(facet.valueTypeGuess, facet.valueRaw);
  if (!mine) return false;
  const isIdish = facet.valueTypeGuess === 'serial' || facet.valueTypeGuess === 'identifier';
  const mineKey = isIdish ? normalizeSerialKey(facet.valueRaw) : mine;
  for (const d of Object.values(context.graph.docs)) {
    if (d.id === thisDocId) continue;
    for (const f of d.facets ?? []) {
      if (f.mappedFieldKey !== fieldKey || !f.linkedEntityIds.includes(entityId)) continue;
      const theirs = context.adapter.normalizeValue(f.valueTypeGuess, f.valueRaw);
      if (!theirs) continue;
      const theirsKey = f.valueTypeGuess === 'serial' || f.valueTypeGuess === 'identifier' ? normalizeSerialKey(f.valueRaw) : theirs;
      if (theirsKey === mineKey) return true;
    }
  }
  return false;
}

export async function autoVerify(doc: Doc, context: PipelineContext): Promise<StepPatch> {
  if (doc.issues.some((i) => i.kind === 'duplicate')) return {};

  const schema = context.adapter.schema;
  const target = maxStageFor(doc, schema);

  if (target !== 'verified') {
    // Not structurally ready for 'verified' yet (missing fields, unlinked, or an open conflict) —
    // nothing to consequence-gate. Auto-advance as far as it structurally goes, so an otherwise-complete
    // document becomes answerable as Unverified immediately rather than waiting on a human's first click.
    const issues = doc.issues.filter((i) => i.kind !== 'needs-verification');
    const changed = target !== doc.stage || issues.length !== doc.issues.length;
    return changed ? { stage: target, issues } : {};
  }

  const facets = (doc.facets ?? []).filter((f) => f.mappedFieldKey && f.linkedEntityIds.length > 0);
  const blocking: DocumentIssue[] = [];
  const blockedFields = new Set<string>();

  for (const f of facets) {
    const fieldKey = f.mappedFieldKey as string;
    if (blockedFields.has(fieldKey)) continue;
    for (const entityId of f.linkedEntityIds) {
      const entityType = context.graph.entities[entityId]?.type;
      if (!entityType) continue;
      const tier = fieldConsequence(schema, entityType, fieldKey);
      if (tier === 'low') continue;

      if (tier === 'high') {
        if (!priorHumanVerification(context, entityId, fieldKey, doc.id)) {
          blocking.push({ kind: 'needs-verification', field: fieldKey, reason: 'high-consequence' });
          blockedFields.add(fieldKey);
        }
        continue;
      }

      // medium
      if (priorHumanVerification(context, entityId, fieldKey, doc.id)) continue;
      if (!hasCorroboration(context, doc.id, f, entityId, fieldKey)) {
        blocking.push({ kind: 'needs-verification', field: fieldKey, reason: 'uncorroborated' });
        blockedFields.add(fieldKey);
      }
    }
  }

  const keptIssues = doc.issues.filter((i) => i.kind !== 'needs-verification');
  if (blocking.length) {
    return { stage: 'linked', issues: [...keptIssues, ...blocking] };
  }
  return { stage: 'verified', verifiedBy: 'system', verifiedAt: context.now, issues: keptIssues };
}
