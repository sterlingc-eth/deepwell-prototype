import type { Answer, AnswerProvider, AskStage, Doc, Entity, Fact, SourceRef } from '../core/types';
import { isAnswerable, type GraphSnapshot } from '../core/entityGraph';
import { dedupeSources, fmtValue, str } from '../core/answer';

/**
 * Server-backed provider. Builds the request described in docs/ASK_API.md
 * (answerable records with their sources, held-back documents, a document
 * catalog), posts it to /api/ask and reads the Server-Sent Events stream:
 * `status` events drive the thinking ticker, `done` carries the Answer.
 *
 * The server only cites documents that appear in the request; this side
 * drops anything it does not recognise as well, so "no fact without a
 * source" holds on this path too.
 */

// ---------------------------------------------------------------------------
// Request body (docs/ASK_API.md)
// ---------------------------------------------------------------------------

export interface AskRecordField {
  value: string;
  sources: SourceRef[];
}

export interface AskRecord {
  entityId: string;
  type: string;
  label: string;
  related: string[];
  fields: Record<string, AskRecordField>;
}

export interface AskHeldBack {
  documentId: string;
  entityIds: string[];
}

export interface AskDoc {
  documentId: string;
  filename: string;
  type: string;
  entityIds: string[];
}

export interface AskRequest {
  question: string;
  includeUnverified: boolean;
  /** YYYY-MM-DD */
  today: string;
  records: AskRecord[];
  heldBack: AskHeldBack[];
  docs: AskDoc[];
}

/** A short human name for an entity, used for retrieval and display. */
export function entityLabel(g: GraphSnapshot, e: Entity): string {
  switch (e.type) {
    case 'property':
      return str(e, 'address') || e.id;
    case 'equipment': {
      const parts = [str(e, 'manufacturer'), str(e, 'equipmentType'), str(e, 'serial')].filter(Boolean);
      return parts.length ? parts.join(' ') : e.id;
    }
    case 'technician':
    case 'customer':
      return str(e, 'name') || e.id;
    case 'service': {
      const date = e.fields['date'];
      const iso = date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : str(e, 'date');
      const what = str(e, 'workPerformed');
      return `Visit ${iso}${what ? ` ${what}` : ''}`.trim();
    }
    default: {
      const spec = g.schema.entityTypes.find((t) => t.id === e.type);
      return (spec && str(e, spec.labelField)) || e.id;
    }
  }
}

/** One-hop neighbours: every ref field on every entity, in both directions. */
function relatedIndex(g: GraphSnapshot): Map<string, Set<string>> {
  const refKeys = new Map<string, string[]>();
  for (const t of g.schema.entityTypes) refKeys.set(t.id, t.fields.filter((f) => f.kind === 'ref').map((f) => f.key));
  // Always consider the conventional id fields too, even if a schema forgot to mark them.
  const conventional = ['propertyId', 'equipmentId', 'technicianId', 'customerId'];

  const index = new Map<string, Set<string>>();
  const bucket = (id: string): Set<string> => {
    let s = index.get(id);
    if (!s) {
      s = new Set();
      index.set(id, s);
    }
    return s;
  };
  const link = (a: string, b: string) => {
    if (a === b) return;
    bucket(a).add(b);
    bucket(b).add(a);
  };
  for (const e of Object.values(g.entities)) {
    const keys = new Set([...(refKeys.get(e.type) ?? []), ...conventional]);
    for (const k of keys) {
      const v = e.fields[k];
      if (typeof v === 'string' && v && g.entities[v]) link(e.id, v);
    }
  }
  return index;
}

function docTypeLabel(g: GraphSnapshot, doc: Doc): string {
  const spec = g.schema.documentTypes.find((t) => t.id === doc.typeId);
  return spec?.label ?? doc.typeId ?? 'Other';
}

/** Pure: the exact body /api/ask expects, built from a graph snapshot. */
export function buildAskRequest(g: GraphSnapshot, question: string, includeUnverified: boolean, now: Date): AskRequest {
  const related = relatedIndex(g);
  const byEntity = new Map<string, AskRecord>();
  const docs: AskDoc[] = [];
  const heldBack: AskHeldBack[] = [];

  const recordFor = (ent: Entity): AskRecord => {
    let rec = byEntity.get(ent.id);
    if (!rec) {
      rec = {
        entityId: ent.id,
        type: ent.type,
        label: entityLabel(g, ent),
        related: Array.from(related.get(ent.id) ?? []).sort(),
        fields: {},
      };
      byEntity.set(ent.id, rec);
    }
    return rec;
  };

  for (const doc of Object.values(g.docs)) {
    const answerable = isAnswerable(doc, includeUnverified);
    if (!answerable) {
      // Linked-but-not-verified docs excluded only by the toggle are reported as held back.
      if (!includeUnverified && doc.stage === 'linked' && isAnswerable(doc, true)) {
        heldBack.push({ documentId: doc.id, entityIds: [...doc.linkedEntityIds] });
      }
      continue;
    }

    const entityIds = new Set<string>(doc.linkedEntityIds.filter((id) => !!g.entities[id]));
    for (const f of doc.extracted) {
      if (!f.target) continue;
      const ent = g.entities[f.target.entityId];
      if (!ent) continue;
      entityIds.add(ent.id);
      const rec = recordFor(ent);
      const existing = rec.fields[f.target.field] ?? { value: fmtValue(ent.fields[f.target.field] ?? null), sources: [] };
      existing.sources.push({ documentId: doc.id, location: f.location, excerpt: `${f.name}: ${f.correctedValue ?? f.value}` });
      rec.fields[f.target.field] = existing;
    }
    // Entities the doc is linked to without a targeted field (technicians on a work order)
    // still get a record so their label and links are retrievable.
    for (const id of entityIds) {
      const ent = g.entities[id];
      if (ent) recordFor(ent);
    }
    docs.push({ documentId: doc.id, filename: doc.filename, type: docTypeLabel(g, doc), entityIds: Array.from(entityIds) });
  }

  // Entities one hop from a documented entity (a customer named on a property record,
  // say) carry no sourced fields but are still needed for retrieval by name and for
  // the property↔customer hop the server expands. They get a label-only record.
  for (const rec of Array.from(byEntity.values())) {
    for (const id of rec.related) {
      const ent = g.entities[id];
      if (ent && !byEntity.has(id)) recordFor(ent);
    }
  }

  // `related` only points at entities that are themselves in the export, so the server's
  // one-hop expansion never dangles.
  const records = Array.from(byEntity.values()).map((r) => ({ ...r, related: r.related.filter((id) => byEntity.has(id)) }));

  return {
    question,
    includeUnverified,
    today: now.toISOString().slice(0, 10),
    records,
    heldBack,
    docs,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface ServerError {
  error?: string;
  retryAfter?: number;
}

function messageFor(status: number, body: ServerError | null, retryAfterHeader: string | null): string {
  if (status === 403) return 'The answer service is turned off for this deployment.';
  if (status === 429) {
    const fromHeader = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const seconds = body?.retryAfter ?? (Number.isFinite(fromHeader) ? fromHeader : 30);
    return `Too many questions right now — try again in ${Math.max(1, Math.round(seconds))} seconds.`;
  }
  return `The answer service didn't respond (${status}).`;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

/** Incrementally parse a text/event-stream body: blank-line separated blocks of `event:` / `data:` lines. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseBlock = (block: string): SseEvent | null => {
    let event = 'message';
    const data: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(':')) continue;
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        const ev = parseBlock(block);
        if (ev) yield ev;
        sep = buffer.search(/\r?\n\r?\n/);
      }
      if (done) {
        const tail = parseBlock(buffer);
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const STAGES: readonly AskStage[] = ['reading', 'linking', 'writing'];
const isStage = (s: unknown): s is AskStage => typeof s === 'string' && (STAGES as readonly string[]).includes(s);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createClaudeProvider(snapshot: () => GraphSnapshot, endpoint = '/api/ask'): AnswerProvider {
  return {
    async ask(question, opts) {
      const g = snapshot();
      const inc = opts?.includeUnverified ?? false;
      const body = buildAskRequest(g, question, inc, opts?.now ?? new Date());
      const started = Date.now();

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error("The answer service didn't respond (network).");
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(messageFor(res.status, parseJson<ServerError>(text), res.headers.get('Retry-After')));
      }
      if (!res.body) throw new Error("The answer service didn't respond (empty).");

      let finalAnswer: Partial<Answer> | null = null;
      for await (const ev of readSse(res.body)) {
        if (ev.event === 'status') {
          const d = parseJson<{ stage?: unknown } & Record<string, unknown>>(ev.data);
          if (d && isStage(d.stage)) {
            const detail: Record<string, number> = {};
            for (const [k, v] of Object.entries(d)) if (k !== 'stage' && typeof v === 'number') detail[k] = v;
            opts?.onStatus?.(d.stage, Object.keys(detail).length ? detail : undefined);
          }
        } else if (ev.event === 'error') {
          const d = parseJson<ServerError & { status?: number }>(ev.data);
          throw new Error(messageFor(d?.status ?? 500, d, null));
        } else if (ev.event === 'done') {
          const d = parseJson<Partial<Answer>>(ev.data);
          if (d) finalAnswer = d;
          break;
        }
        // `answer` (text deltas) is informational; the `done` payload carries the validated text.
      }

      if (!finalAnswer) throw new Error("The answer service didn't respond (no answer).");
      return normalizeAnswer(finalAnswer, g, Date.now() - started);
    },
  };
}

/** Drop unknown document ids, recompute the source union, keep the server's timing fields. */
export function normalizeAnswer(a: Partial<Answer>, g: GraphSnapshot, measuredMs?: number): Answer {
  const known = (s: SourceRef | undefined): s is SourceRef => !!s && typeof s.documentId === 'string' && !!g.docs[s.documentId];
  const facts: Fact[] = (a.facts ?? [])
    .map((f) => ({ ...f, sources: (f.sources ?? []).filter(known) }))
    .filter((f) => f.sources.length > 0);
  const sources = dedupeSources(facts.flatMap((f) => f.sources));
  const docIds = new Set(sources.map((s) => s.documentId));
  const out: Answer = {
    kind: facts.length ? 'answer' : 'no-answer',
    text: a.text ?? 'Nothing in your records answers that.',
    facts,
    sources,
    confidence: facts.length ? (a.confidence ?? 0.8) : 0,
    verifiedCount: docIds.size,
    unverifiedCount: typeof a.unverifiedCount === 'number' ? a.unverifiedCount : 0,
    closest: (a.closest ?? []).filter(known),
  };
  if (a.entityId && g.entities[a.entityId]) out.entityId = a.entityId;
  if (a.interpretation) out.interpretation = a.interpretation;
  const latency = typeof a.latencyMs === 'number' ? a.latencyMs : measuredMs;
  if (typeof latency === 'number' && Number.isFinite(latency)) out.latencyMs = Math.round(latency);
  if (Array.isArray(a.retrievalIds)) out.retrievalIds = a.retrievalIds.filter((id): id is string => typeof id === 'string');
  if (typeof a.validatorStrikes === 'number') out.validatorStrikes = a.validatorStrikes;
  if (typeof a.cached === 'boolean') out.cached = a.cached;
  return out;
}
