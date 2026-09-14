import type { Answer, AnswerProvider, Fact, SourceRef } from '../core/types';
import { authHeader } from './authToken';
import { isAnswerable, type GraphSnapshot } from '../core/entityGraph';
import { fmtValue } from '../core/answer';

/**
 * Claude-backed provider. Sends the question plus a compact, source-tagged
 * export of the answerable records to /api/ask (a Vercel function that holds
 * the API key). The function is asked to return the same Answer shape the
 * mock produces, with every fact citing a document id + location from the
 * export — the server drops any fact whose source isn't in the export, so the
 * "no fact without a source" rule holds on this path too.
 */
export function createClaudeProvider(snapshot: () => GraphSnapshot, endpoint = '/api/ask'): AnswerProvider {
  return {
    async ask(question, opts) {
      const g = snapshot();
      const inc = opts?.includeUnverified ?? false;
      const records = exportRecords(g, inc);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ question, records, includeUnverified: inc, today: (opts?.now ?? new Date()).toISOString().slice(0, 10) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Answer service ${res.status}: ${detail || res.statusText}`);
      }
      const body = (await res.json()) as { success: boolean; data?: Partial<Answer>; error?: string };
      if (!body.success || !body.data) throw new Error(body.error ?? 'Answer service returned no data');
      return normalizeAnswer(body.data, g);
    },
  };
}

interface ExportedRecord {
  entityId: string;
  type: string;
  fields: Record<string, { value: string; sources: SourceRef[] }>;
}

/** Only answerable documents contribute; each field carries its sources. */
export function exportRecords(g: GraphSnapshot, includeUnverified: boolean): ExportedRecord[] {
  const byEntity = new Map<string, ExportedRecord>();
  for (const doc of Object.values(g.docs)) {
    if (!isAnswerable(doc, includeUnverified)) continue;
    for (const f of doc.extracted) {
      if (!f.target) continue;
      const ent = g.entities[f.target.entityId];
      if (!ent) continue;
      let rec = byEntity.get(ent.id);
      if (!rec) {
        rec = { entityId: ent.id, type: ent.type, fields: {} };
        byEntity.set(ent.id, rec);
      }
      const current = ent.fields[f.target.field];
      const existing = rec.fields[f.target.field] ?? { value: fmtValue(current ?? null), sources: [] };
      existing.sources.push({ documentId: doc.id, location: f.location, excerpt: `${f.name}: ${f.correctedValue ?? f.value}` });
      rec.fields[f.target.field] = existing;
    }
  }
  return Array.from(byEntity.values());
}

function normalizeAnswer(a: Partial<Answer>, g: GraphSnapshot): Answer {
  const facts: Fact[] = (a.facts ?? [])
    .map((f) => ({ ...f, sources: (f.sources ?? []).filter((s) => !!g.docs[s.documentId]) }))
    .filter((f) => f.sources.length > 0);
  const sources = facts.flatMap((f) => f.sources);
  const docIds = new Set(sources.map((s) => s.documentId));
  const out: Answer = {
    kind: facts.length ? 'answer' : 'no-answer',
    text: a.text ?? 'Nothing in your records answers that.',
    facts,
    sources,
    confidence: a.confidence ?? (facts.length ? 0.8 : 0),
    verifiedCount: docIds.size,
    unverifiedCount: a.unverifiedCount ?? 0,
    closest: (a.closest ?? []).filter((s) => !!g.docs[s.documentId]),
  };
  if (a.entityId && g.entities[a.entityId]) out.entityId = a.entityId;
  if (a.interpretation) out.interpretation = a.interpretation;
  return out;
}
