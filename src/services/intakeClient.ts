/**
 * Typed client for the clean exception queue (Round 13, H2 — research #2/#7): reads go to
 * GET /api/v1/intake-status (extended by api/_lib/routes/intake-status.js with `?queue=1` and
 * `?documentIds=` — see that file's header for the exact query shapes); the one write action goes
 * to POST /api/account?action=intake (api/_lib/routes/intake-resolve.js). Follows reviewClient.ts's
 * postJson + error-parsing shape exactly; GET calls add the same auth header reviewClient/
 * customerClient already send on their own GETs.
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const STATUS_URL = '/api/v1/intake-status';
const INTAKE_URL = '/api/account?action=intake';

export class IntakeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'IntakeApiError';
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { ...(await authHeader()) } });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(raw);
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new IntakeApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch(INTAKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(raw);
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new IntakeApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

/** Straight-through-processing metrics (api/_lib/intake/status.js#intakeStatus). */
export interface IntakeStatus {
  total: number;
  autoVerified: number;
  autoVerifiedCount: number;
  humanVerified: number;
  openQuestions: number;
  resolvedQuestions: number;
  straightThroughRate: number;
  needsInfoTracked: boolean;
}

export interface IntakeCandidate {
  /** 'value': a sourced field value to pick (has documentId/page/evidence when available).
   *  'entity': an existing record to pick (a unit or a customer) — never has document evidence,
   *  just what's already on file for it. */
  kind: 'value' | 'entity';
  label: string;
  value: string | null;
  entityId: string | null;
  address: string | null;
  documentId: string | null;
  page: number | null;
  sourceDocumentLabel: string | null;
  /** A verbatim excerpt from the source page, when one was captured — "Why are we asking?" text. */
  evidence: string | null;
}

export interface IntakeFilledField {
  fieldKey: string;
  label: string;
  value: string;
  confidence: number;
  source: 'stated' | 'corrected' | 'inferred';
  correctedBy: string | null;
  /** Human-readable provenance for an inferred field ("Inferred from Warranty registration p.1"); null for stated/corrected fields. */
  provenance: string | null;
}

/** Minimal shape matching src/core/types.ts's ExtractedField closely enough for
 *  documentName(doc)/hasFriendlyName(doc) to compute the right title client-side. */
export interface IntakeExtractedField {
  name: string;
  value: string;
  correctedValue?: string;
  confidence: number;
  location: Record<string, never>;
}

export interface IntakeQueueItem {
  needsInfoId: string;
  documentId: string;
  entityId: string | null;
  documentType: string | null;
  documentTypeLabel: string;
  displayName: string | null;
  filename: string;
  stage: string;
  fieldKey: string;
  fieldLabel: string;
  question: string;
  candidates: IntakeCandidate[];
  /** Additional open questions on this SAME document, beyond the one shown here — resolving this
   *  one surfaces the next on the following fetch rather than showing two cards for one document. */
  moreQuestions: number;
  filledFields: IntakeFilledField[];
  extracted: IntakeExtractedField[];
  createdAt: string;
}

export interface IntakeQueuePage {
  items: IntakeQueueItem[];
  nextCursor: string | null;
  /** Total distinct documents with an open (unsnoozed) question — the Inbox header's count, not just this page's length. */
  openDocumentCount: number;
  tracked: boolean;
}

export type IntakeStatusWithQueue = IntakeStatus & { queue: IntakeQueuePage };

export function fetchIntakeStatus(): Promise<IntakeStatus> {
  return getJson<IntakeStatus>(STATUS_URL);
}

export function fetchIntakeQueue({ limit, cursor }: { limit?: number; cursor?: string | null } = {}): Promise<IntakeStatusWithQueue> {
  const params = new URLSearchParams({ queue: '1' });
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return getJson<IntakeStatusWithQueue>(`${STATUS_URL}?${params.toString()}`);
}

export interface DocumentIntakeSummary {
  documentId: string;
  stage: string;
  read: boolean;
  totalRequired: number;
  filledCount: number;
  verified: boolean;
  openQuestion: { fieldKey: string; question: string } | null;
}

export async function fetchDocumentIntakeSummaries(documentIds: string[]): Promise<DocumentIntakeSummary[]> {
  if (!documentIds.length) return [];
  const params = new URLSearchParams({ documentIds: documentIds.join(',') });
  const { documents } = await getJson<{ documents: DocumentIntakeSummary[] }>(`${STATUS_URL}?${params.toString()}`);
  return documents;
}

export interface ResolveIntakeArgs {
  documentId: string;
  fieldKey: string;
  /** The corrected value (ordinary fields), or a new customer's typed name ('customer_name' with no entityId). */
  value?: string;
  /** Picks a candidate entity ('equipment_unit' or 'customer_name'). */
  entityId?: string;
  by?: string;
}

export interface ResolveIntakeResult {
  ok: true;
  resolvedValue: string;
  autofill: { ok: boolean; filled: string[]; questions: string[]; verified: boolean };
}

export function resolveIntakeQuestion(args: ResolveIntakeArgs): Promise<ResolveIntakeResult> {
  return postJson<ResolveIntakeResult>({ op: 'resolve', ...args });
}

export function dismissIntakeQuestion({ documentId, fieldKey, by }: { documentId: string; fieldKey: string; by?: string }): Promise<{ ok: true; dismissed: boolean }> {
  return postJson({ op: 'dismiss', documentId, fieldKey, by });
}

export function snoozeIntakeQuestion({
  documentId,
  fieldKey,
  minutes,
  by,
}: {
  documentId: string;
  fieldKey: string;
  minutes?: number;
  by?: string;
}): Promise<{ ok: true; snoozed: boolean; until: string | null }> {
  return postJson({ op: 'snooze', documentId, fieldKey, minutes, by });
}
