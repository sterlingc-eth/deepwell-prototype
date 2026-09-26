/**
 * Typed client for POST /api/account?action=entity-merge — the Team screen's
 * "Possible duplicate customers" admin card (DuplicateCustomersCard.tsx).
 * Same postJson + authHeader shape as notifyClient.ts.
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/account?action=entity-merge';

export class EntityMergeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EntityMergeApiError';
    this.status = status;
  }
}

export interface DuplicateCandidateDocument {
  id: string;
  filename: string | null;
  type: string | null;
}

export interface DuplicateClusterEntity {
  id: string;
  name: string | null;
  customerNumber: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  documents: DuplicateCandidateDocument[];
}

export interface DuplicateCluster {
  id: string | null;
  clusterId: string;
  entityIds: string[];
  score: number;
  reasons: string[];
  status: 'pending' | 'accepted' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  suggestedKeepId: string;
  entities: DuplicateClusterEntity[];
}

export interface DuplicateClustersResponse {
  clusters: DuplicateCluster[];
}

export interface AcceptMergeResult {
  id: string | null;
  clusterId: string;
  keepId: string;
  droppedIds: string[];
  mergedCount: number;
}

export interface RejectMergeResult {
  id: string | null;
  clusterId: string;
  status: 'rejected';
}

export interface UndoMergeResult {
  id: string;
  keepId: string;
  restoredIds: string[];
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new EntityMergeApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export function fetchDuplicateClusters(): Promise<DuplicateClustersResponse> {
  return post({ op: 'list' });
}

export function acceptDuplicateCluster(
  entityIds: string[],
  opts: { keepId?: string; suggestionId?: string | null; clusterId?: string } = {}
): Promise<AcceptMergeResult> {
  return post({ op: 'accept', entityIds, keepId: opts.keepId, suggestionId: opts.suggestionId, clusterId: opts.clusterId });
}

export function rejectDuplicateCluster(entityIds: string[], clusterId: string): Promise<RejectMergeResult> {
  return post({ op: 'reject', entityIds, clusterId });
}

export function undoDuplicateMerge(suggestionId: string): Promise<UndoMergeResult> {
  return post({ op: 'undo', suggestionId });
}
