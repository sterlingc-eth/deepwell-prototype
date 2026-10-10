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

/* ---------------------------------------------------- review duplicates */

export interface ReviewMember {
  id: string;
  customerNumber: string | null;
  name: string;
  address: string;
  phone: string;
  email: string;
  documents: number;
  links: number;
  equipment: number;
}

export interface ReviewGroup {
  key: string;
  name: string;
  ids: string[];
  mainId: string;
  members: ReviewMember[];
  totals: { records: number; documents: number; links: number; equipment: number };
  /** Exact-name groups only: true when nothing argues against merging. */
  safe?: boolean;
  /** True when the names match but no phone, email or address does. */
  nameOnly?: boolean;
  conflicts?: string[];
  /** Similar-name groups only. */
  reasons?: string[];
}

export interface DuplicateReview {
  companyName: string;
  exact: ReviewGroup[];
  near: ReviewGroup[];
  self: ReviewMember[];
  summary: {
    customers: number;
    exactGroups: number;
    exactSafeGroups: number;
    extraRecordsInExactSafe: number;
    nearGroups: number;
    selfRecords: number;
  };
}

export interface MergeAllResult {
  merged: Array<{ name: string; keepId: string; droppedIds: string[]; suggestionId: string | null; documents: number; links: number; equipment: number }>;
  failed: Array<{ name: string; reason: string }>;
  remaining: number;
  needsReview: number;
}

export interface ThisIsUsResult {
  logId: string | null;
  markedIds: string[];
  documentsMoved: number;
  documentsKeptWithCustomers: number;
  equipmentUnassigned: number;
}

export function reviewDuplicates(): Promise<DuplicateReview> {
  return post({ op: 'review' });
}

/** One time-boxed pass; call again while `remaining` > 0. */
export function mergeAllExactDuplicates(): Promise<MergeAllResult> {
  return post({ op: 'merge-exact' });
}

export function markCustomersAsCompany(entityIds: string[]): Promise<ThisIsUsResult> {
  return post({ op: 'this-is-us', entityIds });
}

export function undoMarkAsCompany(logId: string): Promise<{ restoredIds: string[] }> {
  return post({ op: 'undo-this-is-us', logId });
}

export interface RecentChange {
  id: string;
  kind: 'merge-all' | 'this-is-us';
  at: string;
  groups?: number;
  records: number;
  documents?: number;
  /** How many pieces can still be put back (0 = already undone). */
  undoable: number;
}

export function fetchRecentChanges(): Promise<{ days: number; items: RecentChange[] }> {
  return post({ op: 'recent' });
}

export function undoMergeAllRun(logId: string): Promise<{ restoredGroups: number }> {
  return post({ op: 'undo-merge-all', logId });
}
