import { withTenant } from "./_lib/recordsStore.js";
import { presign, objectKey, keyBelongsToTenant, normalizeContentType, sanitizeUploadFilename, uploadExpirySeconds, originalServing } from "./_lib/r2.js";
import { handleCors, handleError } from "./_lib/claude.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { denyAuth } from "./_lib/auth.js";
import { checkUploadFile } from "./_lib/uploadTypes.js";
import { limit, refundPlanRefusal } from "./_lib/rateLimit.js";
import { gateUpload, getCachedBillingRow, estimatePagesForUpload, batchLimitMessage, staffImportFor, IMPORT_ALLOWANCE_CODE } from "./_lib/plan.js";
import { logStage } from "./_lib/perf.js";
import { startTimer } from "./_lib/timing.js";

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Billing gate (handoffs/BILLING_RULES.md): only for NEW-upload paths (single
 * and batch), never for `mode: 'get'` — reading a document you already have
 * is not new ingestion. One extra withTenant round trip per request; cheap
 * next to the R2 presign + document-row work that follows it.
 *
 * Exported so api/_lib/routes/v1-ingest.js — the partner-facing ingest
 * surface, which calls createUploadUrl() directly rather than going through
 * this route's own handler below — runs the identical gate instead of
 * bypassing it (Reviewer NO-GO, 2026-09-21: it previously ran none at all).
 */
export async function checkUploadGate(auth) {
  // Fail OPEN: a billing lookup that errors (e.g. migration 14 not applied
  // yet, or a DB blip) must never turn into a 500 for every customer.
  try {
    return await checkUploadGateInner(auth);
  } catch (err) {
    // R43: ...EXCEPT while a staff import is active. Its page budget is the spend ceiling of a bulk load, so a broken count
    // must not mean "no ceiling": refuse this request (503 is retried by the import tool with a back-off) instead.
    if (err?.staffImportActive) {
      console.error("billing gate failed CLOSED during a staff import (checkUploadGate):", err?.message);
      return { allowed: false, status: 503, error: IMPORT_CHECK_FAILED_MESSAGE };
    }
    console.error("billing gate failed open (checkUploadGate):", err?.message);
    return { allowed: true };
  }
}

/**
 * The ONE place the plan-gate inputs are read and the verdict is made. Used by the early gate (checkUploadGateInner, the
 * fast path) and by the in-transaction recheck (recheckUploadGate, the authority) so the two can never drift.
 * Must run on an open tenant `db` handle.
 */
async function evaluateUploadGate(db, billingRow) {
  // R43: a staff import (tenants.limits.staffImport, see plan.js) keeps its pages out of the monthly count and, while
  // active, is gated on its own page budget; the import pages are only counted when one is active.
  const imp = staffImportFor(billingRow);
  const importWindow = imp ? { from: imp.from.toISOString(), to: imp.end.toISOString() } : null;
  const [documentsStored, pagesThisMonth, pendingPages, importPagesUsed] = await Promise.all([
    db.countDocuments(),
    db.countPagesSince(new Date(Date.now() - MS_PER_MONTH).toISOString(), importWindow),
    // R30 M6: pages of documents already accepted but not read yet (fails safe to 0 if the probe errors).
    typeof db.estimatePendingPages === "function" ? db.estimatePendingPages().catch(() => 0) : 0,
    imp?.active && typeof db.countPagesBetween === "function" ? db.countPagesBetween(importWindow.from, importWindow.to) : 0,
  ]);
  const gate = gateUpload(billingRow, { documentsStored, pagesThisMonth, pendingPages, importPagesUsed });
  // R35: keep the plan row with the verdict so a 50-file batch can say, per file, which ones no longer fit.
  return gate.allowed ? { ...gate, billingRow } : gate;
}

async function checkUploadGateInner(auth) {
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  // API_PERF_2026-09-22: the billing row is now the shared, cached lookup
  // (plan.js's getCachedBillingRow — same cache assertActiveBilling reads),
  // run OUTSIDE this withTenant transaction. Only the usage counts
  // — which must be fresh on every call, never cached, since the whole point
  // of the gate is catching the moment a tenant crosses its cap — still need
  // a real per-request round trip.
  // R36: awaited BEFORE the transaction opens (it used to run beside it). A cache miss now also reads the tenant's Records
  // Rescue credit through its own connection; with the pool at 3 connections, holding one here while waiting for another could
  // deadlock three concurrent uploads on a cold cache. On a cache hit (almost always) this costs nothing.
  const billingRow = await getCachedBillingRow(ctx);
  const imp = staffImportFor(billingRow);
  return withTenant(ctx, (db) => evaluateUploadGate(db, billingRow)).catch((err) => {
    if (imp?.active && err && typeof err === "object") err.staffImportActive = true;
    throw err;
  });
}

/** The 503 body used when the import allowance cannot be checked (shared by the early gate and the recheck). */
const IMPORT_CHECK_FAILED_MESSAGE = "The import allowance could not be checked just now. Try again in a minute.";

/**
 * Thrown by the in-transaction recheck when the gate no longer lets this request in (a concurrent request used the last
 * room between the early gate and the insert). Carries the gate's own verdict, so the response is the same 402 body the early
 * gate gives. `.status` is the HTTP status.
 */
export class UploadGateRefusal extends Error {
  constructor(gate) {
    super(gate?.error ?? "Upload refused");
    this.name = "UploadGateRefusal";
    this.status = gate?.status ?? 402;
    this.gate = gate;
  }
}

/**
 * FIX 2 (upload race): the authoritative plan check, run INSIDE the transaction that inserts the document row(s).
 * Takes ONE per-company transaction-scoped advisory lock (always the same key, one lock per transaction, so there is no
 * lock ordering and no deadlock; released by COMMIT/ROLLBACK), then re-reads the same counts and makes the same decision as
 * the early gate. Uploads of one company are serialised for the few milliseconds between this and COMMIT; other companies
 * are not affected (different key). Nothing awaited here leaves the database (the billing row was loaded before the
 * transaction opened, presign is a local HMAC).
 *
 * Returns the gate verdict, or null when the check itself could not run (fails OPEN, like checkUploadGate; during an
 * active staff import it fails CLOSED with a 503 instead). A SAVEPOINT keeps a failing count from aborting the transaction.
 */
async function recheckUploadGate(db, billingRow) {
  const imp = staffImportFor(billingRow);
  try {
    await db.raw("SAVEPOINT upload_gate");
    await db.raw("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`upload-gate:${db.tenantId}`]);
    return await evaluateUploadGate(db, billingRow);
  } catch (err) {
    if (imp?.active) {
      console.error("billing gate failed CLOSED during a staff import (upload recheck):", err?.message);
      throw new UploadGateRefusal({ allowed: false, status: 503, error: IMPORT_CHECK_FAILED_MESSAGE });
    }
    await db.raw("ROLLBACK TO SAVEPOINT upload_gate");
    console.error("billing gate failed open (upload recheck):", err?.message);
    return null;
  }
}

/**
 * For routes that insert a document row themselves (api/records.ts createDocument): inside the inserting transaction, take the
 * company's upload lock and re-check the plan. Throws UploadGateRefusal when it no longer fits. `billingRow` comes from
 * loadBillingRowForRecheck(), called BEFORE the transaction opens; `undefined` skips the recheck (fails open, as the early gate).
 */
export async function assertUploadRoomInTx(db, billingRow) {
  if (billingRow === undefined) return;
  const verdict = await recheckUploadGate(db, billingRow);
  if (verdict && !verdict.allowed) throw new UploadGateRefusal(verdict);
}

/** The billing row for the in-transaction recheck, loaded BEFORE the transaction opens. `undefined` = could not load (skip). */
export async function loadBillingRowForRecheck(auth) {
  try {
    return await getCachedBillingRow({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });
  } catch (err) {
    console.error("billing gate failed open (upload recheck, billing row):", err?.message);
    return undefined;
  }
}

/**
 * POST /api/upload-url
 * body: { filename, sha256, sizeBytes, contentType? }   (sizeBytes REQUIRED, R35)
 * -> { documentId, storageKey, uploadUrl, alreadyUploaded }
 *
 * Step one of ingestion, and the point where the two stores meet: this creates
 * the Postgres row (the fact that a document exists, who owns it, where its
 * bytes will live) and hands back a short-lived URL the browser PUTs the bytes
 * to directly. Compute never touches the file.
 *
 * The client sends the file's sha256. That makes uploads idempotent — the same
 * file dropped twice is one document, thanks to the (tenant_id, sha256_hash)
 * unique constraint — and it is the hook for "you already have this invoice",
 * which is a real HVAC office problem: the same PO arrives by email, by fax,
 * and in a folder from the installer.
 *
 * Accepts either a Clerk session or an API key with the 'ingest' scope
 * (requireAuthOrKey / assertScope, ./_lib/apiKeyAuth.js), and is rate-limited
 * on the 'ingest' bucket (./_lib/rateLimit.js) — this is the endpoint an
 * uncapped caller could loop with uniquely-hashed files forever, which is
 * exactly the abuse case both of those exist to bound.
 *
 * The validation + withTenant core is exported as `createUploadUrl` so
 * api/v1-ingest.js (the public partner/integration surface) can reuse it
 * exactly rather than re-implementing document creation and presigning a
 * second time.
 *
 * OPEN ORIGINAL (agent-docs-access, handoffs/TEAM_BRIEF_2026-09-19.md): body
 * may instead be { mode: 'get', documentId } -> { url, contentType, filename,
 * expiresIn }, a presigned R2 GET (15 min) for that document's own bytes,
 * tenant-scoped through the same withTenant() as every other lookup here.
 * Shares this route's existing auth/rate-limit gate rather than adding a new
 * one (see the handler) — reading a document you can already presign an
 * upload for is not a wider capability grant.
 *
 * BATCH MODE (bulk import): body may instead be { files: [{filename, sha256,
 * sizeBytes, contentType?}, ...] }, up to MAX_BATCH_FILES entries, and the
 * response is { results: [...] } with one entry per input file IN THE SAME
 * ORDER (callers may zip by index; filenames are not assumed unique). This
 * exists because a bulk import of thousands of files at one presign-per-HTTP-
 * request would be thousands of round trips before a single byte moves — one
 * batch call of 50 cuts that 50x. Each file is validated exactly as the
 * single-file path validates it; a bad file in the batch becomes a per-item
 * `error`/`status`, not a failed whole request, so 49 good files are not
 * held hostage by 1 bad one. All files in one batch call share a single
 * database transaction (one connection checkout, not fifty) — the one
 * exception is R2 being unconfigured (StorageUnavailableError), which is
 * environment-wide and is surfaced as a per-item error too rather than an
 * uncaught 503, so a batch never rolls back documents that already
 * committed fine earlier in the same request.
 */
export const config = { api: { bodyParser: { sizeLimit: "64kb" } } };

const MAX_BATCH_FILES = 50;

/** R35: the two 400s for the now-mandatory sizeBytes. Exported so the client tests and docs quote one wording. */
export const SIZE_REQUIRED_MESSAGE =
  "sizeBytes is required: send the file's exact size in bytes (a browser File's .size) so the upload can be checked and signed before it moves.";
export const SIZE_INVALID_MESSAGE = "sizeBytes must be the file's exact size as a positive whole number of bytes";

// Size caps per kind (24 MB PDFs/photos, 20 MB text/sheets/Word/Excel, 100 MB absolute) now live with the allow-list in
// api/_lib/uploadTypes.js, with the reasons they exist.

/**
 * Thrown when presign() can't produce an upload URL (R2 env vars unset, e.g.
 * every Preview/Development deploy today). Kept distinct from other errors so
 * the handler can report it as a legible 503 instead of a generic 500, and so
 * it can be recognized before the transaction that created the document row
 * commits — see the comment at the presign() call below.
 */
class StorageUnavailableError extends Error {
  constructor(cause) {
    super("File storage is not configured");
    this.name = "StorageUnavailableError";
    this.cause = cause;
  }
}

/** Thrown for a bad request body. `.status` is the HTTP status to report. */
export class UploadValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

/**
 * Validate one file's presign request body. Pure (throws or returns a clean
 * shape) so both the single-file and batch paths run the exact same checks.
 *
 * @param {{filename: unknown, sha256: unknown, contentType?: unknown, sizeBytes?: unknown}} body
 * @returns {{filename: string, sha256: string, contentType: string|null, sizeBytes: number}}
 * @throws {UploadValidationError}
 */
function validateUploadBody(body) {
  const { filename: rawFilename, sha256, contentType: rawContentType, sizeBytes } = body ?? {};
  if (typeof rawFilename !== "string" || !rawFilename.trim()) {
    throw new UploadValidationError("filename is required");
  }
  // R34: a NUL (or any control character) in the name was a raw Postgres error - a 500 for one file and an aborted 50-file
  // batch - and the length and directional-override characters were unbounded. Clean and bound it; refuse only if nothing is left.
  const filename = sanitizeUploadFilename(rawFilename);
  if (!filename) throw new UploadValidationError("filename is required");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new UploadValidationError("sha256 must be a 64-character hex digest");
  }
  // R34: only a string type is a type. An object/array was stored as JSON text in documents.content_type.
  if (rawContentType != null && typeof rawContentType !== "string") {
    throw new UploadValidationError("contentType must be a string");
  }
  // R34: lower-cased with parameters removed, so "Application/PDF" and "application/pdf; charset=binary" are subject to the same
  // size limits as "application/pdf" (they used to slip past the 24 MB / 20 MB checks below and were uploaded in full first).
  const contentType = normalizeContentType(rawContentType);
  // R35 (owner decision): an upload MUST state its size. It is signed into the upload URL as the exact Content-Length R2
  // will accept, it feeds the pending-pages estimate that keeps the monthly page cap honest while files are still queued
  // (a row with no size used to count as one page, so a 200-page scan slipped past the cap), and the 24 MB / 20 MB read
  // limits below can only be applied before the bytes move if the size is known. Every client already knows file.size.
  if (sizeBytes === undefined || sizeBytes === null) {
    throw new UploadValidationError(SIZE_REQUIRED_MESSAGE);
  }
  if (sizeBytes === 0) {
    // R34: the old message ("sizeBytes must be a positive whole number of bytes") is what a person saw for an empty file.
    throw new UploadValidationError("This file is empty (0 bytes), so there is nothing to upload. Choose the file again, or scan it again.");
  }
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new UploadValidationError(SIZE_INVALID_MESSAGE);
  }
  // Office build (2026-10-03): the ALLOW-LIST. The extension must be on it, the declared type must be one that extension
  // legitimately carries, and the size cap is the one for the KIND the extension says (so a file with no declared type, or
  // octet-stream, is capped like a PDF/Word/CSV, not let through at 100 MB; defect L-2). Runs here, before any document row or
  // signed URL exists, for the single AND batch paths, /api/v1-ingest (it calls createUploadUrl) and nothing else can skip it.
  const verdict = checkUploadFile({ filename, contentType, sizeBytes });
  if (!verdict.ok) throw new UploadValidationError(verdict.message, verdict.status);
  // The stored type is the canonical one for the extension (a Windows browser's "application/vnd.ms-excel" for a .csv becomes
  // text/csv), so the reader and the page estimate see one spelling.
  return { filename, sha256, contentType: verdict.contentType, sizeBytes };
}

/**
 * Create (or find) the document row and presign an upload URL for it, given
 * an already-open tenant `db` handle. Shared by the single-file and batch
 * paths so a batch runs every file through one transaction instead of one
 * per file.
 *
 * @param {ReturnType<typeof withTenant> extends Promise<infer T> ? T : never} db
 * @param {{filename: string, sha256: string, contentType: string|null, sizeBytes: number|null}} validated
 * @param {{userId: string, viaKey?: boolean}} auth
 * @throws {StorageUnavailableError} when R2 is not configured
 */
async function createUploadUrlTx(db, validated, auth) {
  const { filename, sha256, contentType, sizeBytes } = validated;
  const key = objectKey(db.tenantId, sha256, filename);
  const doc = await db.createDocument({
    original_filename: filename,
    sha256_hash: sha256,
    file_size_bytes: sizeBytes,
    content_type: contentType,
    storage_key: key,
    // Per-technician work attribution (M3-config/20): the Clerk user id of
    // whoever requested this upload. `auth.userId` is `key:<id>` for an API
    // key caller, not a real Clerk user — harmless here, it just never
    // matches anyone's "My work" filter, same as any other non-human upload.
    uploaded_by: auth.userId ?? null,
  });
  // Was this row already here (same tenant, same bytes)? If the document
  // already has pages, the client can skip the upload entirely.
  // R35: an EXISTS probe, not listPages() (every page's full text, once per file, just to read `.length`).
  const alreadyUploaded = typeof db.hasPages === "function"
    ? await db.hasPages(doc.id)
    : (await db.listPages(doc.id)).length > 0;

  // presign() must run BEFORE this transaction commits, not after. It used
  // to be called outside withTenant, once the documents row above was
  // already committed — so a misconfigured R2 (presign() throws when
  // R2_ACCOUNT_ID etc. are unset, true for every Preview/Development
  // deploy today) left behind a permanent orphan row: stage='received',
  // no error recorded, indistinguishable from an upload in progress,
  // never cleaned up. Calling it here means a throw happens inside the
  // transaction, so withTenant's catch/ROLLBACK undoes the createDocument
  // insert along with it — no row, no orphan.
  let uploadUrl = null;
  if (!alreadyUploaded) {
    try {
      // R30 M5 / R35: the declared size is ALWAYS signed (Content-Length), so R2 rejects a PUT of any other size -
      // otherwise the "100 MB / 24 MB" limits above were only ever checked against what the client SAID. sizeBytes is
      // mandatory now (validateUploadBody), so there is no unsigned URL any more.
      uploadUrl = presign("PUT", key, uploadExpirySeconds(sizeBytes), {}, new Date(), { contentLength: sizeBytes });
    } catch (err) {
      throw new StorageUnavailableError(err);
    }
  }

  await db.logAction({
    action: "document.upload_requested",
    resource_type: "document",
    resource_id: doc.id,
    clerk_user_id: auth.userId,
    changes: { filename, sizeBytes, viaKey: !!auth.viaKey },
  });
  // `created` = this call made the row (a brand-new document), as opposed to finding one that already existed.
  return { documentId: doc.id, storageKey: key, alreadyUploaded, uploadUrl, created: doc.inserted === true };
}

/**
 * The core of /api/upload-url, minus HTTP concerns: validate the body, create
 * (or find) the document row, and presign an upload URL for it.
 *
 * @param {{tenantId: string, orgId: string|null, userId: string}} auth  whatever requireAuthOrKey() returned
 * @param {{filename: unknown, sha256: unknown, contentType?: unknown, sizeBytes?: unknown}} body
 * @returns {Promise<{documentId: string, storageKey: string, alreadyUploaded: boolean, uploadUrl: string|null}>}
 * @throws {UploadValidationError} on a bad body (caller maps `.status` to the HTTP response)
 * @throws {StorageUnavailableError} when R2 is not configured
 */
export async function createUploadUrl(auth, body) {
  const validated = validateUploadBody(body);
  // FIX 2: loaded before the transaction opens (pool of 3: no nested checkout while holding the lock).
  const billingRow = await loadBillingRowForRecheck(auth);
  return withTenant(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    async (db) => {
      if (billingRow !== undefined) {
        const verdict = await recheckUploadGate(db, billingRow);
        if (verdict && !verdict.allowed) throw new UploadGateRefusal(verdict);
      }
      const { created: _created, ...publicShape } = await createUploadUrlTx(db, validated, auth);
      return publicShape;
    }
  );
}

/**
 * Batch form: presign up to MAX_BATCH_FILES files in one request/transaction.
 * See the BATCH MODE note above the exports for the response shape and why
 * a bad file becomes a per-item error instead of failing the whole call.
 *
 * @param {{tenantId: string, orgId: string|null, userId: string}} auth
 * @param {unknown} files  expected to be an array of single-file bodies
 * @returns {Promise<Array<{filename?: string, documentId?: string, storageKey?: string, alreadyUploaded?: boolean, uploadUrl?: string|null, error?: string, status?: number}>>}
 * @throws {UploadValidationError} only for a malformed batch itself (not an array, empty, or too long)
 */
export async function createUploadUrls(auth, files, allowance = null) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new UploadValidationError("files must be a non-empty array");
  }
  if (files.length > MAX_BATCH_FILES) {
    throw new UploadValidationError(`A batch is limited to ${MAX_BATCH_FILES} files`, 413);
  }

  // R35: `allowance` = what the plan gate said is left ({pagesRemaining, documentsRemaining, billingRow}; null = no
  // limits known). The gate used to look only at the count BEFORE the batch, so 50 files each estimated at 100 pages all
  // passed one check at 1,990 of 2,000. Now every NEW document spends from the headroom and a file that arrives once it
  // is gone gets its own 402 (the rest of the batch, and everyone else's files, are unaffected).
  let pagesLeft = allowance?.pagesRemaining ?? null;
  let docsLeft = allowance?.documentsRemaining ?? null;
  // FIX 2: the plan row is loaded before the transaction opens (see createUploadUrl).
  const billingRow = await loadBillingRowForRecheck(auth);

  return withTenant(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    async (db) => {
      // FIX 2: under the company's upload lock, re-read what is really left and keep the STRICTER of that and what the
      // early gate said. If the gate now refuses outright (a concurrent request used the last room), every valid file
      // gets its own 402 carrying the gate's own message, the same per-file shape a batch already uses when it runs out.
      let refusedNow = null;
      if (billingRow !== undefined) {
        const verdict = await recheckUploadGate(db, billingRow);
        if (verdict && !verdict.allowed) {
          if (verdict.status !== 402) throw new UploadGateRefusal(verdict); // the fail-closed 503 refuses the whole request
          refusedNow = verdict;
        } else if (verdict) {
          const lower = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
          pagesLeft = lower(pagesLeft, verdict.pagesRemaining ?? null);
          docsLeft = lower(docsLeft, verdict.documentsRemaining ?? null);
          allowance = { ...(allowance ?? {}), billingRow: allowance?.billingRow ?? billingRow, importMode: allowance?.importMode ?? verdict.importMode };
        }
      }
      const results = [];
      for (const raw of files) {
        const filename = typeof raw?.filename === "string" ? raw.filename : undefined;
        try {
          const validated = validateUploadBody(raw);
          if (refusedNow) {
            results.push({ filename: validated.filename, error: refusedNow.error, status: 402, url: refusedNow.url, ...(refusedNow.code ? { code: refusedNow.code } : {}) });
            continue;
          }
          if (pagesLeft != null && pagesLeft <= 0) {
            results.push({ filename: validated.filename, error: batchLimitMessage("pages", allowance.billingRow), status: 402, url: "/app/?screen=billing", ...(allowance.importMode ? { code: IMPORT_ALLOWANCE_CODE } : {}) });
            continue;
          }
          if (docsLeft != null && docsLeft <= 0) {
            results.push({ filename: validated.filename, error: batchLimitMessage("documents", allowance.billingRow), status: 402, url: "/app/?screen=billing" });
            continue;
          }
          const { created, ...single } = await createUploadUrlTx(db, validated, auth);
          // Only a file that is not already stored (a duplicate costs nothing) and not already counted (a re-sent row that is
          // still waiting is in the gate's pending estimate) spends from the headroom.
          if (created && !single.alreadyUploaded) {
            if (pagesLeft != null) pagesLeft -= estimatePagesForUpload(validated.contentType, validated.sizeBytes);
            if (docsLeft != null) docsLeft -= 1;
          }
          results.push({ filename: validated.filename, ...single });
        } catch (err) {
          // A bad or too-large file, or R2 being unconfigured, is this file's
          // problem alone — record it and keep going, so one item never sinks
          // the other 49 sharing this transaction. Anything else (a genuine
          // bug) is left to propagate and abort the whole batch, same as any
          // other unexpected error in this codebase.
          if (err?.name === "UploadValidationError") {
            results.push({ filename, error: err.message, status: err.status });
          } else if (err?.name === "StorageUnavailableError") {
            results.push({ filename, error: "File storage is not configured for this environment.", status: 503 });
          } else {
            throw err;
          }
        }
      }
      return results;
    }
  );
}

// Same shape as customer-equipment.js's own UUID_RE, and for the same
// reason: documents.id is a uuid column, and a merely-non-empty string like
// "not-a-uuid" survives a truthiness check and only fails once bound against
// it, as "invalid input syntax for type uuid" — a raw 500, not a 400.
const DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a bad `mode: 'get'` request. `.status` is the HTTP status to report. */
export class DocumentGetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DocumentGetError";
    this.status = status;
  }
}

/**
 * OPEN ORIGINAL: presign a short-lived GET for a document's own stored
 * bytes, tenant-scoped via withTenant() exactly like every curated
 * recordsStore.js lookup. `response-content-disposition` is passed through
 * to presign()'s extraQuery so the browser renders a PDF/image inline
 * instead of prompting a download; R2's presigned-GET support for that
 * override query param comes free from being S3-API-compatible.
 *
 * @param {{tenantId: string, orgId: string|null}} auth
 * @param {unknown} documentId
 * @throws {DocumentGetError} bad/missing id, or no such document in this tenant
 * @throws {StorageUnavailableError} when R2 is not configured
 */
export async function getOriginalUrl(auth, documentId) {
  if (typeof documentId !== "string" || !documentId.trim()) {
    throw new DocumentGetError("documentId is required");
  }
  if (!DOCUMENT_ID_RE.test(documentId)) {
    throw new DocumentGetError("documentId must be a uuid");
  }
  return withTenant(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    async (db) => {
      const doc = await db.getDocument(documentId);
      if (!doc || !doc.storage_key) {
        throw new DocumentGetError("Document not found", 404);
      }
      // R30 H1: never presign a key outside this tenant's own prefix.
      if (!keyBelongsToTenant(doc.storage_key, db.tenantId)) {
        throw new DocumentGetError("Document not found", 404);
      }
      const filename = doc.original_filename || "document";
      // R34: serve it as a known document/photo type or as a download, never as whatever Content-Type the uploader's PUT carried.
      const serving = originalServing(filename, doc.content_type);
      let url;
      try {
        url = presign("GET", doc.storage_key, 900, {
          "response-content-disposition": serving.disposition,
          "response-content-type": serving.contentType,
        });
      } catch (err) {
        throw new StorageUnavailableError(err);
      }
      return { url, contentType: doc.content_type ?? null, filename, expiresIn: 900 };
    }
  );
}

/** Shared by this route and v1-ingest.js: map createUploadUrl()'s thrown errors to an HTTP response. */
export async function respondUploadError(res, req, error, opts = {}) {
  if (error?.name === "UploadGateRefusal") {
    // FIX 3: a plan-gate 402 (not the fail-closed 503) hands its rate-limit unit back, up to the cap in refundPlanRefusal.
    if (error.status === 402) await refundPlanRefusal(req);
    const g = error.gate ?? {};
    return handleCors(res, req).status(error.status).json({ error: g.error, url: g.url, ...(g.code && opts.omitCode !== true ? { code: g.code } : {}) });
  }
  if (error?.name === "UploadValidationError") {
    return handleCors(res, req).status(error.status).json({ error: error.message });
  }
  if (error?.name === "StorageUnavailableError") {
    // Legible and specific, not the generic 500 handleError would give: a
    // technician reading this knows it's an environment problem, not a bad
    // upload, and support knows to check R2 credentials, not the database.
    console.error("upload-url: R2 is not configured:", error.cause?.message ?? error.cause);
    return handleCors(res, req).status(503).json({
      error: "File storage is not configured for this environment. Uploads are unavailable until an administrator sets the R2 credentials.",
    });
  }
  return handleError(res, error, req);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // API_PERF_2026-09-22 (DW_TIMING=1 only — see handoffs/API_PERF_2026-09-22.md):
  // one JSON line per request covering auth, rate limit, billing gate, and the
  // handler body, so the four stages the owner's browser timing flagged as
  // slow are each visible without a profiler. logged in a `finally` so a
  // thrown error still gets a timing line.
  const timer = startTimer();
  const mode = req.body && req.body.mode === "get" ? "get" : Array.isArray(req.body?.files) ? "batch" : "single";
  let statusSent = 0;
  try {
    let auth;
    try {
      auth = await timer.time("auth", () => requireAuthOrKey(req));
      // R30 L3: downloading an original is a READ. An ingest-only (write-only) key could presign a GET and pull
      // documents out; now `mode: 'get'` needs the 'read' scope and everything else the 'ingest' scope.
      assertScope(auth, mode === "get" ? "read" : "ingest");
    } catch (err) {
      statusSent = err?.status ?? 401;
      return denyAuth(res, err);
    }

    // R30: a queued phone scan names the shop it was captured in. If the signed-in shop has changed since (org
    // switch, another user on the same phone, a retry timer that outlived a switch), refuse instead of filing
    // the scan into whichever shop the token belongs to now. Callers that send no header are unaffected.
    const expectedTenant = req.headers?.["x-dw-expected-tenant"];
    if (typeof expectedTenant === "string" && expectedTenant && !auth.viaKey && expectedTenant !== (auth.orgId ?? auth.userId)) {
      statusSent = 409;
      return handleCors(res, req).status(409).json({ error: "This scan was captured in a different company. Switch back to that company to send it.", code: "tenant-mismatch" });
    }

    // A 50-file batch presign is 50 units of ingest, not one request.
    const batchCost = Array.isArray(req.body?.files) ? Math.max(1, req.body.files.length) : 1;
    if (!(await timer.time("limit", () => limit(req, res, auth, "ingest", undefined, batchCost)))) {
      statusSent = 429;
      return; // 429 already written
    }

    // OPEN ORIGINAL: { mode: 'get', documentId } -> presigned GET. Checked
    // first and does not touch the PUT/batch paths below at all.
    if (req.body && req.body.mode === "get") {
      const result = await timer.time("handler", () => getOriginalUrl(auth, req.body.documentId));
      statusSent = 200;
      return handleCors(res, req).status(200).json(result);
    }

    const gate = await timer.time("gate", () => checkUploadGate(auth));
    if (!gate.allowed) {
      statusSent = gate.status;
      if (gate.status === 402) await refundPlanRefusal(req); // FIX 3 (DC3b): a plan refusal does not spend the unit
      return handleCors(res, req).status(gate.status).json({ error: gate.error, url: gate.url, ...(gate.code ? { code: gate.code } : {}) });
    }

    // Batch shape: { files: [...] } -> { results: [...] }. One request, one
    // rate-limit charge and one usage_counters increment cover the whole
    // batch today — see the daily-cap note in HANDOFF-C.md for the tradeoff.
    if (req.body && Array.isArray(req.body.files)) {
      const results = await timer.time("handler", () => createUploadUrls(auth, req.body.files, gate));
      statusSent = 200;
      return handleCors(res, req).status(200).json({ results });
    }
    const result = await timer.time("handler", () => createUploadUrl(auth, req.body));
    statusSent = 200;
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    statusSent = error?.status ?? 500;
    if (error?.name === "DocumentGetError") {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return await respondUploadError(res, req, error);
  } finally {
    logStage({ t: "request", route: "upload-url", mode, status: statusSent, ...timer.snapshot() });
  }
}
