/**
 * Typed client for the DELETE and OPEN ORIGINAL contracts
 * (handoffs/TEAM_BRIEF_2026-09-19.md). Same postJson + authHeader shape as
 * reviewClient.ts — this is a couple of narrow, already-typed calls, not a
 * generic interface.
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const REVIEW_URL = '/api/review';
const UPLOAD_URL_URL = '/api/upload-url';

const MAX_DELETE_BATCH = 100;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // A 500 (or a Vercel platform error) can come back as an HTML page, so
    // .json() would throw a SyntaxError and hide the real status. Read as
    // text and try to parse, same as reviewClient.ts and ingestClient.ts.
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
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface OriginalUrl {
  url: string;
  contentType: string | null;
  filename: string;
  expiresIn: number;
}

/**
 * Delete up to any number of documents (and their extractions/facets/
 * document_pages/document_entity_links, cascaded server-side, plus
 * best-effort R2 cleanup) — batched at 100 per request to match the
 * server's cap. "Empty this shop's documents" is just this called with
 * every document id; there is no separate `mode: 'all'` on the server.
 */
export async function deleteDocuments(ids: string[]): Promise<{ deleted: number }> {
  if (!ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const batch of chunk(ids, MAX_DELETE_BATCH)) {
    const result = await postJson<{ deleted: number; failedStorage: string[] }>(REVIEW_URL, {
      action: 'deleteDocuments',
      documentIds: batch,
    });
    deleted += result.deleted;
  }
  return { deleted };
}

// API_PERF_2026-09-22: the owner's browser timing showed /api/upload-url
// fired 3x on one /app open. This call (mode: 'get', presigning a document's
// original bytes) is the one caller of UPLOAD_URL_URL outside the ingest
// flow, and DocumentPreview.tsx's own fetch effect can legitimately re-run
// for the same documentId (React StrictMode's dev-only double-invoke, or two
// mounted previews for the same id) — each call is otherwise indistinguishable
// from the last. Deduped here, at the client-call-scheduling layer, rather
// than trying to fix every possible caller: concurrent calls for the SAME
// documentId share one in-flight request instead of each firing their own;
// the entry is dropped the moment it settles, so this is not a cache (a
// presigned URL has its own short server-side expiry and must never be
// served stale) — only a same-tick de-duplication.
const inFlightOriginalUrl = new Map<string, Promise<OriginalUrl>>();

/** A short-lived, tenant-scoped presigned GET for a document's own original bytes. */
export function getOriginalUrl(id: string): Promise<OriginalUrl> {
  const existing = inFlightOriginalUrl.get(id);
  if (existing) return existing;
  const request = postJson<OriginalUrl>(UPLOAD_URL_URL, { mode: 'get', documentId: id }).finally(() => {
    inFlightOriginalUrl.delete(id);
  });
  inFlightOriginalUrl.set(id, request);
  return request;
}
