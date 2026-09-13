/**
 * Pipeline step 5 — resolve: link-or-park using `adapter.resolveEntity`,
 * same score bands as the design doc — ≥0.80 link, 0.50–0.79 inbox + best
 * guess, else a provisional new entity when enough key fields are present.
 * Also attaches every facet on the document to whatever entities it
 * resolves to, independent of mapping status.
 *
 * A document commonly identifies more than one entity at once (a work
 * order names a property AND the equipment serviced there AND the
 * technician), so — unlike a single "best guess" — every facet that clears
 * the link threshold on its own contributes its entity to the link set,
 * not just whichever facet happened to be scored first. On top of that,
 * when the strongest signal found is a property (a "Service address" field,
 * with no serial/model on the page to identify equipment directly), we take
 * one more hop: look up the equipment already on record at that property
 * and, when the page gives us a way to tell which one, link it too. See
 * docs/INGEST_API.md, "Pipeline", item 5.
 */
import type { Doc, DocumentIssue, Entity, EntityId, FieldValue } from '../types';
import type { PipelineContext, StepPatch } from './runner';
import { newId } from './runner';
import { normalizeAddress } from '../normalize';

const LINK_THRESHOLD = 0.8;
const INBOX_THRESHOLD = 0.5;
/** A hop from a matched property to the equipment recorded there, when the page gives no direct signal for which unit — a purely address-driven guess, kept below LINK_THRESHOLD's confidence-in-precision bar. */
const PROPERTY_EQUIPMENT_HOP_CONFIDENCE = 0.85;
const PROPERTY_EQUIPMENT_HOP_DISAMBIGUATED_CONFIDENCE = 0.82;
/** Weaker than a type-text match (the page names the unit's type but not which of several look-alikes) — recency is a statistical tie-breaker, not a document-given fact, so it sits just above LINK_THRESHOLD rather than alongside the stronger signals. */
const PROPERTY_EQUIPMENT_HOP_RECENCY_CONFIDENCE = 0.81;
/** Loose typo/OCR tolerance for an address that misses every existing property by a hair — see resolveAddressNearMatch below. */
const ADDRESS_NEAR_MATCH_CONFIDENCE = 0.82;
const ADDRESS_NEAR_MATCH_MAX_DISTANCE = 1;

function initialFields(entityType: string, given: Record<string, string>, context: PipelineContext): Record<string, FieldValue> {
  const spec = context.adapter.schema.entityTypes.find((t) => t.id === entityType);
  const fields: Record<string, FieldValue> = {};
  for (const f of spec?.fields ?? []) fields[f.key] = null;
  for (const [k, v] of Object.entries(given)) fields[k] = v;
  return fields;
}

/** Small edit distance for typo/OCR tolerance on addresses — no external dependency needed at these string lengths. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[n]!;
}

/**
 * When a facet mapped to the property's own label field (address) matched
 * no existing property — not even fuzzily, via adapter.resolveEntity's
 * substring pass — try one more, tighter pass: a single-character typo or
 * OCR slip (one digit or letter different) shouldn't be enough to spin up
 * a brand new property record next to the real one. Anything further than
 * that is left alone; we'd rather miss a link than merge two genuinely
 * different addresses.
 */
/** Property records store the street only ("1523 S Alma School Rd"), never city/state/zip, but a document's own "Service address" facet is printed as one full line ("1523 S Alma School Rd, Mesa, AZ 85210"). Compare street-to-street so a trailing city/state/zip the stored record never had doesn't itself read as a giant edit distance. */
function streetPart(raw: string): string {
  const commaIdx = raw.indexOf(',');
  return commaIdx === -1 ? raw : raw.slice(0, commaIdx);
}

function resolveAddressNearMatch(rawAddress: string, context: PipelineContext): { entityId: EntityId; confidence: number } | null {
  const want = normalizeAddress(streetPart(rawAddress)).toLowerCase();
  if (!want) return null;
  let best: { entityId: EntityId; distance: number } | null = null;
  for (const e of Object.values(context.graph.entities)) {
    if (e.type !== 'property') continue;
    const raw = e.fields['address'];
    if (raw === null || raw === undefined) continue;
    const have = normalizeAddress(streetPart(String(raw))).toLowerCase();
    if (!have) continue;
    const distance = levenshtein(want, have);
    if (distance <= ADDRESS_NEAR_MATCH_MAX_DISTANCE && (!best || distance < best.distance)) best = { entityId: e.id, distance };
  }
  return best ? { entityId: best.entityId, confidence: ADDRESS_NEAR_MATCH_CONFIDENCE } : null;
}

/** Every piece of equipment on record at a given property. */
function equipmentAtProperty(propertyId: EntityId, context: PipelineContext): Entity[] {
  return Object.values(context.graph.entities).filter((e) => e.type === 'equipment' && e.fields['propertyId'] === propertyId);
}

/**
 * The page's own text is the only signal we have to tell two units at the
 * same property apart when neither serial nor model is legible. A mention
 * of the equipment's type (e.g. "AC" vs "Furnace") anywhere among the
 * doc's facet values is the cheapest reliable one; when it singles out
 * exactly one candidate, use it — when it doesn't (both units share a
 * type, or neither is mentioned), we leave equipment unresolved rather
 * than guess between look-alikes.
 */
function disambiguateEquipmentByType(candidates: Entity[], doc: Doc): { winner: Entity | null; hits: Entity[] } {
  const haystack = (doc.facets ?? [])
    .map((f) => `${f.labelRaw} ${f.valueRaw}`.toLowerCase())
    .join(' \n ');
  const hits = candidates.filter((c) => {
    const type = c.fields['equipmentType'];
    return typeof type === 'string' && type.trim() && haystack.includes(type.toLowerCase());
  });
  return { winner: hits.length === 1 ? hits[0]! : null, hits };
}

/**
 * Last-resort tie-breaker for the one case type-text can't settle: several
 * units of the *same* type at the property (a "Furnace" invoice with two
 * furnaces on record) and no serial/model on the page to tell them apart.
 * With nothing on the document itself to go on, the unit with the most
 * recently recorded service activity is the statistically likelier subject
 * of a new invoice showing up now — a real property of the graph's own
 * service history, not a guess baked in for any specific document. Only
 * fires when it actually breaks the tie (a strict, unique max); genuinely
 * even candidates (no service history at all, or an exact tie) are left
 * unresolved rather than guessed at.
 */
function disambiguateEquipmentByRecency(candidates: Entity[], context: PipelineContext): Entity | null {
  if (candidates.length < 2) return null;
  const lastServiceDate = (equipmentId: EntityId): number | null => {
    let max: number | null = null;
    for (const e of Object.values(context.graph.entities)) {
      if (e.type !== 'service' || e.fields['equipmentId'] !== equipmentId) continue;
      const raw = e.fields['date'];
      const t = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? new Date(raw).getTime() : NaN;
      if (!Number.isNaN(t) && (max === null || t > max)) max = t;
    }
    return max;
  };
  let winner: Entity | null = null;
  let winnerDate: number | null = null;
  let tied = false;
  for (const c of candidates) {
    const d = lastServiceDate(c.id);
    if (d === null) continue;
    if (winnerDate === null || d > winnerDate) {
      winner = c;
      winnerDate = d;
      tied = false;
    } else if (d === winnerDate) {
      tied = true;
    }
  }
  return winner && !tied ? winner : null;
}

export async function resolve(doc: Doc, context: PipelineContext): Promise<StepPatch> {
  const facets = doc.facets ?? [];
  const mappedFacets = facets.filter((f) => f.mappedFieldKey);
  if (!mappedFacets.length) return {};

  // Every facet that clears LINK_THRESHOLD on its own contributes its
  // entity — a document routinely names several entities at once (a
  // property AND the equipment there AND the technician), and picking only
  // the single highest-confidence hit (especially with ties, which
  // resolved arbitrarily to whichever facet happened to be scored first)
  // silently dropped the others.
  const strong = new Map<EntityId, number>();
  let bestInbox: { entityId: EntityId; confidence: number } | undefined;
  let provisionalEntityType: string | undefined;
  let provisionalFields: Record<string, string> = {};

  const addStrong = (entityId: EntityId, confidence: number) => {
    const cur = strong.get(entityId);
    if (cur === undefined || confidence > cur) strong.set(entityId, confidence);
  };

  // adapter.resolveEntity's exact-match pass trusts an exact string match on
  // *whatever* field a facet happens to map to — fine for a field that is
  // actually a stable per-entity identifier (a serial, a street address, a
  // person's name), but a categorical field (equipment type, manufacturer,
  // city/state) or an event-scoped one (a service visit's date, cost,
  // technician, work performed) is shared by many entities on purpose and
  // an "exact match" on it is really just "this document also mentions a
  // furnace" — not identity. Only resolve identity from facets mapped to a
  // field that's actually meant to distinguish one entity from its peers.
  const IDENTITY_FIELD_KEYS = new Set(['address', 'serial', 'model', 'name', 'customerName']);
  const identityFacets = mappedFacets.filter((f) => IDENTITY_FIELD_KEYS.has(f.mappedFieldKey as string));

  for (const f of identityFacets) {
    const result = context.adapter.resolveEntity({ labelRaw: f.labelRaw, valueRaw: f.valueRaw, mappedFieldKey: f.mappedFieldKey }, context.graph);
    if (!result) continue;
    if ('provisional' in result) {
      // Before accepting "nothing matched, stand up a new property", try a
      // one-typo-tolerant address match — a single OCR/keying slip on a
      // house number shouldn't fork a duplicate property record.
      if (result.entityType === 'property' && f.mappedFieldKey === 'address') {
        const near = resolveAddressNearMatch(f.valueRaw, context);
        if (near) {
          addStrong(near.entityId, near.confidence);
          continue;
        }
      }
      provisionalEntityType = result.entityType;
      provisionalFields = { ...provisionalFields, ...result.fields };
      continue;
    }
    if (result.confidence >= LINK_THRESHOLD) {
      addStrong(result.entityId, result.confidence);
    } else if (result.confidence >= INBOX_THRESHOLD) {
      if (!bestInbox || result.confidence > bestInbox.confidence) bestInbox = result;
    }
  }

  // Property → equipment hop: a work order/invoice keyed on "Service
  // address" alone (no legible serial/model) still means one specific
  // piece of equipment. When the matched property has exactly one unit on
  // record, that's it; when it has more, only take the hop if the page's
  // own text singles one out.
  for (const entityId of Array.from(strong.keys())) {
    const entity = context.graph.entities[entityId];
    if (entity?.type !== 'property') continue;
    if (Array.from(strong.keys()).some((id) => context.graph.entities[id]?.type === 'equipment')) continue;
    const candidates = equipmentAtProperty(entityId, context);
    if (candidates.length === 1) {
      addStrong(candidates[0]!.id, PROPERTY_EQUIPMENT_HOP_CONFIDENCE);
    } else if (candidates.length > 1) {
      const { winner, hits } = disambiguateEquipmentByType(candidates, doc);
      if (winner) {
        addStrong(winner.id, PROPERTY_EQUIPMENT_HOP_DISAMBIGUATED_CONFIDENCE);
      } else {
        // Type text named more than one candidate (or none at all) — same
        // property, same type, nothing on the page to pick between them.
        // Try the recency tie-breaker over whichever pool the type match
        // actually narrowed us to (the type-matched units when there were
        // several, otherwise every unit on record at the property).
        const pool = hits.length > 1 ? hits : candidates;
        const byRecency = disambiguateEquipmentByRecency(pool, context);
        if (byRecency) addStrong(byRecency.id, PROPERTY_EQUIPMENT_HOP_RECENCY_CONFIDENCE);
      }
    }
  }

  const linkedEntityIds = [...doc.linkedEntityIds];
  let linkConfidence = doc.linkConfidence;
  let issues: DocumentIssue[] = doc.issues.filter((i) => i.kind !== 'unlinked');
  const newEntities: Entity[] = [];

  if (strong.size) {
    for (const [entityId, confidence] of strong) {
      if (!linkedEntityIds.includes(entityId)) linkedEntityIds.push(entityId);
      linkConfidence = Math.max(linkConfidence, confidence);
    }
  } else if (bestInbox) {
    issues = [...issues, { kind: 'unlinked', bestGuess: bestInbox.entityId, confidence: bestInbox.confidence }];
    linkConfidence = Math.max(linkConfidence, bestInbox.confidence);
  } else if (provisionalEntityType && Object.keys(provisionalFields).length > 0 && linkedEntityIds.length === 0) {
    const entityId = newId(provisionalEntityType);
    newEntities.push({ id: entityId, type: provisionalEntityType, fields: initialFields(provisionalEntityType, provisionalFields, context) });
    linkedEntityIds.push(entityId);
    linkConfidence = Math.max(linkConfidence, 0.65);
  } else {
    issues = [...issues, { kind: 'unlinked', confidence: 0 }];
  }

  const resolvedIds = new Set(linkedEntityIds);
  const updatedFacets = facets.map((f) => ({ ...f, linkedEntityIds: Array.from(new Set([...f.linkedEntityIds, ...resolvedIds])) }));

  return { facets: updatedFacets, linkedEntityIds, linkConfidence, issues, newEntities };
}
