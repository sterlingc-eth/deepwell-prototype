/**
 * Pipeline step 7 — conflicts: same entity + same *mapped* field + different
 * normalized value across docs → a hard Conflict (existing shape,
 * unchanged). Same entity + same *facet label* (unmapped) + different value
 * → the softer `inconsistent-facet` issue — shown in Review, non-blocking.
 * See docs/INGEST_API.md, "Pipeline", item 7.
 */
import type { Conflict, Doc, DocumentIssue } from '../types';
import type { PipelineContext, StepPatch } from './runner';
import { normalizeSerialKey } from '../normalize';

/** Which entity type's own field a mapped key belongs to, per the schema — a value can only conflict against another value of the *same* entity, not any entity the document happens to also touch (a work order links equipment, property AND the service visit at once; the visit's "date" and "cost" are expected to differ from every other visit, that's not a conflict about the equipment or the property). */
function fieldOwnerTypes(context: PipelineContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of context.adapter.schema.entityTypes) {
    for (const f of t.fields) out.set(f.key, t.id);
  }
  return out;
}

export async function conflicts(doc: Doc, context: PipelineContext): Promise<StepPatch> {
  if (!doc.linkedEntityIds.length) return {};

  const facets = doc.facets ?? [];
  const otherDocs = Object.values(context.graph.docs).filter((d) => d.id !== doc.id && d.linkedEntityIds.some((id) => doc.linkedEntityIds.includes(id)));
  if (!otherDocs.length) return {};

  const ownerTypes = fieldOwnerTypes(context);
  const newConflicts: Conflict[] = [];
  const extraIssues: DocumentIssue[] = [];

  for (const entityId of doc.linkedEntityIds) {
    const entityType = context.graph.entities[entityId]?.type;
    // Hard conflicts: mapped facets sharing (entity, fieldKey) — only when
    // the field actually belongs to this entity's own type. A work order's
    // "Date"/"Total"/"Work performed" are the service visit's fields, not
    // the equipment's or the property's, even though the same document
    // links to all three.
    for (const f of facets.filter((x) => x.mappedFieldKey && ownerTypes.get(x.mappedFieldKey) === entityType)) {
      const mine = context.adapter.normalizeValue(f.valueTypeGuess, f.valueRaw);
      if (!mine) continue;
      // Serials/identifiers are compared confusable-tolerant (O/0, I/1,
      // S/5, B/8) — a scan that read one digit as its look-alike letter
      // isn't a different serial number, it's the same one read twice.
      const mineKey = f.valueTypeGuess === 'serial' || f.valueTypeGuess === 'identifier' ? normalizeSerialKey(f.valueRaw) : mine;
      for (const other of otherDocs) {
        if (!other.linkedEntityIds.includes(entityId)) continue;
        const theirs = (other.facets ?? []).find((of) => of.mappedFieldKey === f.mappedFieldKey);
        if (!theirs) continue;
        const theirValue = context.adapter.normalizeValue(theirs.valueTypeGuess, theirs.valueRaw);
        if (!theirValue) continue;
        const theirKey = theirs.valueTypeGuess === 'serial' || theirs.valueTypeGuess === 'identifier' ? normalizeSerialKey(theirs.valueRaw) : theirValue;
        if (theirKey === mineKey) continue;

        const conflictId = `conflict-${entityId}-${f.mappedFieldKey}`;
        if (!context.graph.conflicts[conflictId] && !newConflicts.some((c) => c.id === conflictId)) {
          newConflicts.push({
            id: conflictId,
            entityId,
            field: f.mappedFieldKey as string,
            candidates: [
              { value: theirs.valueRaw, documentId: other.id, location: { page: theirs.page, field: theirs.labelRaw } },
              { value: f.valueRaw, documentId: doc.id, location: { page: f.page, field: f.labelRaw } },
            ],
          });
        }
        if (!extraIssues.some((i) => i.kind === 'conflict' && i.conflictId === conflictId)) extraIssues.push({ kind: 'conflict', conflictId });
      }
    }

    // Soft inconsistencies: unmapped facets sharing (entity, labelRaw).
    for (const f of facets.filter((x) => !x.mappedFieldKey)) {
      for (const other of otherDocs) {
        if (!other.linkedEntityIds.includes(entityId)) continue;
        const theirs = (other.facets ?? []).find((of) => !of.mappedFieldKey && of.labelRaw.trim().toLowerCase() === f.labelRaw.trim().toLowerCase());
        if (!theirs) continue;
        if (theirs.valueRaw.trim().toLowerCase() === f.valueRaw.trim().toLowerCase()) continue;
        if (!extraIssues.some((i) => i.kind === 'inconsistent-facet' && i.labelRaw === f.labelRaw)) {
          extraIssues.push({ kind: 'inconsistent-facet', labelRaw: f.labelRaw, facetIds: [f.id, theirs.id] });
        }
      }
    }
  }

  if (!newConflicts.length && !extraIssues.length) return {};

  const newConflictIds = new Set(extraIssues.filter((i): i is Extract<DocumentIssue, { kind: 'conflict' }> => i.kind === 'conflict').map((i) => i.conflictId));
  const newInconsistentLabels = new Set(extraIssues.filter((i): i is Extract<DocumentIssue, { kind: 'inconsistent-facet' }> => i.kind === 'inconsistent-facet').map((i) => i.labelRaw));
  const kept = doc.issues.filter((i) => {
    if (i.kind === 'conflict') return !newConflictIds.has(i.conflictId);
    if (i.kind === 'inconsistent-facet') return !newInconsistentLabels.has(i.labelRaw);
    return true;
  });
  return { issues: [...kept, ...extraIssues], newConflicts };
}
