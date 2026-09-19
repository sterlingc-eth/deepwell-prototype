/**
 * Typed client for POST /api/review — the review screen's six actions,
 * persisted server-side. Follows ingestClient.ts's postJson + error-parsing
 * shape (a plain fetch helper, not recordsStoreClient.ts's class) because
 * this is a handful of narrow, already-typed calls rather than an interface
 * with 24 differently-shaped actions to implement.
 */

import { authHeader } from './authToken';

const API_URL = '/api/review';

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // A 500 (or a Vercel platform error) can come back as an HTML page, so
    // .json() would throw a SyntaxError and hide the real status. Read as
    // text and try to parse, same as ingestClient.ts and recordsStoreClient.ts.
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** The subset of a `documents` row every review action hands back, so the
 *  caller can reconcile local state with what the server actually wrote. */
export interface ReviewDocument {
  id: string;
  stage: 'received' | 'read' | 'mapped' | 'linked' | 'verified';
  document_type: string | null;
  verified_by: string | null;
  verified_at: string | null;
  [key: string]: unknown;
}

export interface ReviewExtraction {
  id: string;
  field_key: string;
  value: string | null;
  corrected_value: string | null;
  corrected_by?: string | null;
  corrected_at?: string | null;
}

export interface DocumentLink {
  document_id: string;
  entity_id: string;
  confidence: number | null;
  linked_by: string | null;
  created_at: string;
}

export interface Correction {
  document_id: string;
  field_key: string;
  corrected_value: string;
  corrected_by: string | null;
  corrected_at: string | null;
}

export interface ReviewCompleteness {
  type: string;
  required: string[];
  present: string[];
  missing: string[];
  minConfidence: number;
  complete: boolean;
}

export interface ReclassifyChange {
  documentId: string;
  from: string | null;
  to: string;
}

export interface ReviewEntity {
  id: string;
  entity_type: string;
  data: Record<string, unknown>;
  merged_into: string | null;
  [key: string]: unknown;
}

export const reviewClient = {
  /** Correct an extracted field, or add one that was never extracted. */
  correctField(documentId: string, fieldKey: string, value: string, by: string) {
    return postJson<{ document: ReviewDocument; extraction: ReviewExtraction }>({
      action: 'correctField',
      documentId,
      fieldKey,
      value,
      by,
    });
  },

  classifyDocument(documentId: string, documentType: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'classifyDocument',
      documentId,
      documentType,
    });
  },

  linkDocument(documentId: string, entityId: string, by: string) {
    return postJson<{ document: ReviewDocument; links: DocumentLink[] }>({
      action: 'linkDocument',
      documentId,
      entityId,
      by,
    });
  },

  unlinkDocument(documentId: string, entityId: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'unlinkDocument',
      documentId,
      entityId,
    });
  },

  verifyDocument(documentId: string, by: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'verifyDocument',
      documentId,
      by,
    });
  },

  unverifyDocument(documentId: string) {
    return postJson<{ document: ReviewDocument }>({
      action: 'unverifyDocument',
      documentId,
    });
  },

  mergeEntities(keepId: string, dropId: string) {
    return postJson<{ keep: ReviewEntity; dropped: ReviewEntity }>({
      action: 'mergeEntities',
      keepId,
      dropId,
    });
  },

  /** Bulk fetch for usePostgresSync: every document_entity_links row for a
   *  batch of documents in one round trip. */
  listLinks(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ links: DocumentLink[] }>({ links: [] });
    return postJson<{ links: DocumentLink[] }>({ action: 'listLinks', documentIds });
  },

  /** Bulk fetch for usePostgresSync: every corrected field for a batch of
   *  documents in one round trip. */
  listCorrections(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ corrections: Correction[] }>({ corrections: [] });
    return postJson<{ corrections: Correction[] }>({ action: 'listCorrections', documentIds });
  },

  /** AI VERIFICATION CONTRACT: recomputes completeness from stored
   *  extractions and promotes to verified (verified_by 'ai') if complete and
   *  confident enough. No-op (verified:false) otherwise — never an error. */
  aiVerify(documentId: string) {
    return postJson<{ document: ReviewDocument; completeness: ReviewCompleteness; verified: boolean }>({
      action: 'aiVerify',
      documentId,
    });
  },

  /** Batch reclassification of legacy/unknown/'other' document_type values
   *  (≤100 ids; may make a few cheap model calls for stubborn ones). `remaining`
   *  is how many of THESE ids are still 'other' after this pass — the caller
   *  loops, resubmitting only the still-'other' ids, until it hits 0. */
  reclassify(documentIds: string[]) {
    if (!documentIds.length) return Promise.resolve<{ changes: ReclassifyChange[]; remaining: number }>({ changes: [], remaining: 0 });
    return postJson<{ changes: ReclassifyChange[]; remaining: number }>({ action: 'reclassify', documentIds });
  },
};
