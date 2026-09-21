/**
 * browser-ingest.js -- plain, dependency-free JS to paste into DevTools
 * console on a signed-in DeepWell app tab (window.Clerk + same-origin fetch
 * both need to work). Extends the one-off snippet in
 * handoffs/LIMIT_TEST_PLAN_2026-09-20.md's Steps 2-4 for the 600-doc business
 * corpus: rate-limit aware, resumable, and able to hand its results back to
 * a tool (or person) reading the console output in small pieces.
 *
 * ============================================================ HOW TO USE ==
 *
 * 1) Build the bundle locally first:  node scripts/build-bundle.mjs test-docs/business
 *    -> writes test-docs/business/bundle.json (paste its contents as `bundle`
 *    below, or fetch() it from wherever it's reachable).
 *
 * 2) Open the DeepWell app, sign in, open DevTools console on that tab, and
 *    paste THIS WHOLE FILE. Nothing runs automatically -- it only defines
 *    functions and one throttle object.
 *
 * 3) Paste the bundle (or fetch it) and run the ingest:
 *      const bundle = { files: [...] };      // paste bundle.json's contents
 *      const results = await dwRunIngest(bundle);
 *
 *    Concurrency is fixed at 2 and self-throttled to stay under 60 units per
 *    minute (see DW_UNITS_PER_MINUTE below), with exponential backoff plus
 *    Retry-After on any 429 from the server on top of that as a backstop.
 *    Progress is persisted to localStorage under DW_PROGRESS_KEY, so if the
 *    tab reloads or the script is re-run with the SAME bundle, already-
 *    uploaded files are skipped without re-presigning them -- and even
 *    without that local cache, the server itself recognizes a repeat upload
 *    by its sha256 and returns `alreadyUploaded: true` (skips the PUT, still
 *    calls read-document so a document stuck pre-extraction gets requeued).
 *
 * 4) Wait for extraction:
 *      const ids = results.filter((r) => r.documentId).map((r) => r.documentId);
 *      await dwWaitForIngest(ids);
 *
 * 5) Capture snapshots (customers/documents/scan/asks) and get them back as
 *    small, tool-readable pieces:
 *      const answerKeyQuestions = [...];     // ANSWER_KEY.json's `.questions`
 *      await dwCaptureSnapshot(answerKeyQuestions);
 *      dwPieceCount()                         // -> N
 *      dwPiece(0)                             // -> first <=900-char string
 *      dwPiece(1)                             // -> second, etc, until it
 *                                              //    returns null
 *    Concatenate every piece in order and JSON.parse() the result to get
 *    { customers, documents, scan, asks } (a compacted snapshot -- only the
 *    fields scripts/score-corpus.mjs actually reads). Reading it this way
 *    matters when the console is being driven by a tool with a small
 *    per-call output limit: `dwPiece(i)` returns one small string, no matter
 *    how big the whole snapshot is, so the tool never has to read a giant
 *    blob in one shot. `dwCaptureSnapshot` ALSO triggers four ordinary file
 *    downloads (customers.json, documents.json, scan.json, asks.json) for a
 *    human running this by hand, exactly like LIMIT_TEST_PLAN_2026-09-20.md's
 *    Step 4 -- `node scripts/score-corpus.mjs --dir <that folder> --key
 *    test-docs/business/ANSWER_KEY.json` scores those files directly.
 *
 * ========================================================================== */

/* ---- config -------------------------------------------------------------- */
const DW_UNITS_PER_MINUTE = 55; // stay under the product's 60/minute ingest bucket with margin
const DW_PROGRESS_KEY = 'dwBusinessIngestProgress';
const DW_PIECE_SIZE = 900;

/* ---- shared auth header --------------------------------------------------- */
async function dwAuthHeader() {
  const token = await window.Clerk?.session?.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ---- throttle: proactively cap requests at DW_UNITS_PER_MINUTE, shared
 * across both concurrent workers ------------------------------------------- */
const dwThrottle = {
  timestamps: [],
  async wait() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60000);
      if (this.timestamps.length < DW_UNITS_PER_MINUTE) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 60000 - (now - this.timestamps[0]) + 50;
      console.log(`[throttle] at ${DW_UNITS_PER_MINUTE}/min, waiting ${Math.ceil(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  },
};

/* ---- fetch wrapper: honors Retry-After / backs off on 429, as a backstop
 * behind the proactive throttle above (a shared tenant limit, other tabs, or
 * a slightly stricter server window can still 429 even under our own cap) -- */
async function dwFetchWithRetry(url, opts, { maxAttempts = 6 } = {}) {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    attempt += 1;
    if (attempt >= maxAttempts) return res;
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : null;
    const backoffSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec
      : Math.min(30, 2 ** attempt); // exponential backoff fallback: 2,4,8,16,30s
    console.log(`[429] ${url} -- backing off ${backoffSec}s (attempt ${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, backoffSec * 1000 + Math.random() * 250));
  }
}

/* ---- local progress (resume across reloads without re-presigning) -------- */
function dwLoadProgress() {
  try { return JSON.parse(localStorage.getItem(DW_PROGRESS_KEY) || '{}'); } catch { return {}; }
}
function dwSaveProgress(progress) {
  try { localStorage.setItem(DW_PROGRESS_KEY, JSON.stringify(progress)); } catch { /* private mode / quota -- best effort only */ }
}
function dwResetProgress() {
  try { localStorage.removeItem(DW_PROGRESS_KEY); } catch { /* ignore */ }
}

/* ---- ingest one file: presign -> PUT -> notify (mirrors
 * src/services/ingestClient.ts, same as LIMIT_TEST_PLAN_2026-09-20.md) ----- */
async function dwUploadOne({ name, mime, base64 }, progress) {
  if (progress[name]?.done) {
    return { name, documentId: progress[name].documentId, queued: progress[name].queued, skipped: 'already done (local progress)' };
  }

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

  await dwThrottle.wait();
  const presignRes = await dwFetchWithRetry('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
    body: JSON.stringify({ filename: name, sha256, contentType: mime, sizeBytes: bytes.length }),
  });
  if (!presignRes.ok) return { name, error: `presign ${presignRes.status}: ${await presignRes.text()}` };
  const { documentId, uploadUrl, alreadyUploaded } = await presignRes.json();

  if (!alreadyUploaded && uploadUrl) {
    const put = await fetch(uploadUrl, { method: 'PUT', body: bytes, headers: { 'Content-Type': mime } });
    if (!put.ok) return { name, error: `PUT ${put.status}` };
  }

  // Second throttle slot: the server counts presign + read as 2 ingest units
  // per document (reviewer finding B1, 2026-09-21).
  await dwThrottle.wait();
  const readRes = await dwFetchWithRetry('/api/read-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
    body: JSON.stringify({ documentId }),
  });
  const readBody = await readRes.json().catch(() => ({}));
  const result = { name, documentId, queued: !!readBody.queued, error: readRes.ok ? undefined : `read ${readRes.status}` };

  if (!result.error) {
    progress[name] = { documentId, queued: result.queued, done: true };
    dwSaveProgress(progress);
  }
  return result;
}

/* ---- run the whole bundle, concurrency 2, resumable ----------------------- */
async function dwRunIngest(bundle, concurrency = 2) {
  const files = bundle.files;
  const progress = dwLoadProgress();
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      results[i] = await dwUploadOne(files[i], progress);
      const status = results[i].error ?? results[i].skipped ?? 'ok';
      console.log(`[${i + 1}/${files.length}]`, results[i].name, status);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const okCount = results.filter((r) => !r.error).length;
  console.log('done:', okCount, '/', results.length, 'uploaded ok (', results.filter((r) => r.skipped).length, 'skipped as already done)');
  return results;
}

/* ---- wait for extraction to finish (same 15-minute cap as ingestClient.ts) */
async function dwWaitForIngest(documentIds, { intervalMs = 3000, timeoutMs = 15 * 60 * 1000 } = {}) {
  const pending = new Set(documentIds);
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await dwThrottle.wait();
    const res = await dwFetchWithRetry('/api/document-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
      body: JSON.stringify({ documentIds: [...pending] }),
    });
    const { documents } = await res.json().catch(() => ({ documents: [] }));
    for (const d of documents ?? []) {
      const done = d.extract_error || (d.extracted_at && ['mapped', 'linked', 'verified'].includes(d.stage));
      if (done) pending.delete(d.id);
    }
    console.log(`waiting on ${pending.size} of ${documentIds.length}...`);
  }
  return { finished: documentIds.length - pending.size, stillPending: [...pending] };
}

/* ---- snapshot capture: full downloads (for score-corpus.mjs) + a compact
 * in-memory summary chunked for dwPiece() (for a tool with small output) --- */
function dwDownload(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

let dwPieces = [];

async function dwCaptureSnapshot(questions) {
  const customersRes = await fetch('/api/v1/customers?limit=200', { headers: await dwAuthHeader() });
  const customersData = await customersRes.json();

  const documentsRes = await fetch('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
    body: JSON.stringify({ action: 'listDocuments' }),
  });
  const documentsData = { documents: await documentsRes.json() };

  const scanRes = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
    body: JSON.stringify({ action: 'integrityScan' }),
  });
  const scanData = await scanRes.json();

  // Sequential on purpose -- /api/ask is rate-limited and each call is a
  // real fast-path/analytics/model invocation, not something to fire at once.
  const asks = [];
  for (const q of questions) {
    await dwThrottle.wait();
    const res = await dwFetchWithRetry('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await dwAuthHeader()) },
      body: JSON.stringify({ question: q.q }),
    });
    const body = await res.json().catch(() => ({}));
    asks.push({ q: q.q, answer: body?.data?.answer ?? body?.error ?? '', fast: !!body?.fast });
    console.log('asked:', q.q, '->', body?.data?.answer ?? body?.error);
  }
  const asksData = { asks };

  dwDownload('customers.json', customersData);
  dwDownload('documents.json', documentsData);
  dwDownload('scan.json', scanData);
  dwDownload('asks.json', asksData);

  // Compact form -- only what scripts/score-corpus.mjs actually reads, so the
  // JSON handed back through dwPiece() is as small as it can be.
  const compact = {
    customers: (customersData?.customers ?? customersData ?? []).map((c) => ({
      id: c.id, name: c.name ?? c.data?.customer_name ?? null,
      serviceAddress: c.serviceAddress ?? c.data?.service_address ?? null,
      phone: c.phone ?? c.data?.phone ?? null, email: c.email ?? c.data?.email ?? null,
      alerts: c.alerts ?? null,
    })),
    documents: (documentsData?.documents ?? []).map((d) => ({ id: d.id, original_filename: d.original_filename ?? d.filename ?? d.id, stage: d.stage })),
    scan: {
      unlinkedDocuments: scanData?.unlinkedDocuments ?? [],
      equipmentWithoutCustomer: scanData?.equipmentWithoutCustomer ?? [],
      multiUnitDocsUnderLinked: scanData?.multiUnitDocsUnderLinked ?? [],
      suspectedShopAddresses: scanData?.suspectedShopAddresses ?? [],
    },
    asks: asksData.asks,
  };
  const json = JSON.stringify(compact);
  dwPieces = [];
  for (let i = 0; i < json.length; i += DW_PIECE_SIZE) dwPieces.push(json.slice(i, i + DW_PIECE_SIZE));
  console.log(`Compact snapshot: ${json.length} chars in ${dwPieces.length} piece(s) of <=${DW_PIECE_SIZE} chars. Read with dwPiece(0), dwPiece(1), ...`);

  return { customersData, documentsData, scanData, asksData };
}

/** Returns piece i (0-indexed) of the last captured compact snapshot as a
 *  string of at most DW_PIECE_SIZE characters, or null past the last piece.
 *  Concatenate every piece in order and JSON.parse() to reconstruct
 *  { customers, documents, scan, asks }. */
function dwPiece(i) {
  return i >= 0 && i < dwPieces.length ? dwPieces[i] : null;
}
function dwPieceCount() {
  return dwPieces.length;
}

// Back-compat aliases matching the tool-facing names in the brief.
window.__dwPiece = dwPiece;
window.__dwPieceCount = dwPieceCount;

console.log('browser-ingest.js loaded. Next: const bundle = {...}; const results = await dwRunIngest(bundle);');
