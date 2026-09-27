/**
 * Offline upload queue — the manager. ScanTab.tsx enqueues a file here the
 * moment a live upload attempt fails or the phone has no signal at all; this
 * module owns retrying it (exponential backoff, tenant-scoped, idempotent)
 * until it lands, without the tech doing anything else.
 *
 *   ScanTab (capture) --sha256+bytes--> enqueue --------> QueueStore (queue.ts)
 *                                          |                    ^
 *                                          v                    |
 *                                        drain() -------- attemptUploadOnce()
 *                                          |            (same /api/upload-url +
 *                                          |             /api/read-document calls
 *                                          |             ingestClient.ts's own
 *                                          |             ingestFile uses)
 *                                          v
 *                              subscribe() -> ScanTab's "Waiting to upload" strip
 *
 * Triggers that call drain(): an online event, the tab/page becoming visible
 * again ("retry on app open"), a message from the service worker's
 * Background Sync handler (public/m/sw.js) where the browser supports it, and
 * a self-scheduled timer for each item's own backoff — see `wireAutoDrain`.
 */

import { IngestHttpError, putFile, readDocument, requestUploadUrl } from '../../services/ingestClient'
import { createMemoryStore, defaultQueueStore, type QueuedUpload, type QueueErrorClass, type QueueStore } from './queue'

export type { QueuedUpload, QueueErrorClass } from './queue'
export { QueueQuotaError } from './queue'

export interface UploadOutcome {
  documentId?: string
  pages?: number
  duplicate?: boolean
  /** Server queued the read step (out of band) — mirrors ingestClient's own IngestResult.queued. */
  queued?: boolean
  awaitingExtraction?: boolean
}

/**
 * One direct attempt — no retry loop of its own; the caller (ScanTab for the
 * live attempt, `drain` below for a queued retry) decides what happens on
 * failure. Reuses ingestClient's own exported presign/PUT/read calls, so the
 * dedupe-by-sha256 path (the (tenant_id, sha256_hash) unique constraint —
 * see api/upload-url.js) is IDENTICAL whether this is the first try or the
 * fifth: the same hash always resolves to the same document, never a new one.
 */
export async function attemptUploadOnce(file: File, sha256: string, signal?: AbortSignal): Promise<UploadOutcome> {
  const { documentId, uploadUrl, alreadyUploaded } = await requestUploadUrl(
    { filename: file.name, sha256, contentType: file.type || undefined, sizeBytes: file.size },
    signal
  )
  if (alreadyUploaded) return { documentId, duplicate: true }
  if (uploadUrl) await putFile(uploadUrl, file, signal)
  const read = await readDocument(documentId as string, signal)
  if (read.queued) return { documentId, queued: true, awaitingExtraction: read.extract !== false }
  return { documentId, pages: read.pages }
}

/** Classifies a failed attempt into what the queue should do next. Exported
 *  (pure) so scripts/verify-offline-queue.mjs can check it directly. */
export function classifyUploadError(err: unknown): QueueErrorClass {
  if (err instanceof IngestHttpError) {
    if (err.status === 413) return 'too-large'
    if (err.status === 401 || err.status === 403) return 'permanent' // caller special-cases 401/403 as an auth pause; see drain()
    if (err.status === 429 || err.status >= 500) return 'transient'
    return 'permanent' // 400/402/404/etc — retrying the same bytes changes nothing
  }
  // A thrown network error (offline, DNS failure, an aborted "still no
  // signal" timeout) is always worth retrying once connectivity is back.
  return 'transient'
}

function isAuthError(err: unknown): boolean {
  return err instanceof IngestHttpError && (err.status === 401 || err.status === 403)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Upload failed — check your connection and try again.'
}

/** Fixed base/cap exponential backoff with jitter, 1-indexed by attempt
 *  number. attempts=1 -> ~5s, attempts=2 -> ~10s, ... capped at 5 minutes so
 *  a phone left face-down overnight doesn't spin ever-longer waits once
 *  signal returns. Exported (pure) for scripts/verify-offline-queue.mjs. */
export const BASE_DELAY_MS = 5_000
export const MAX_DELAY_MS = 5 * 60_000
export function backoffDelayMs(attempts: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1))
  const jitter = exp * (0.85 + Math.random() * 0.3)
  return Math.round(Math.min(MAX_DELAY_MS, jitter))
}

export interface DrainOptions {
  signal?: AbortSignal
  /** Called once per item that lands successfully during this drain — lets
   *  ScanTab refresh the doc sync even for an item that finishes long after
   *  the tech has moved on to another tab. */
  onUploaded?: (item: QueuedUpload, outcome: UploadOutcome) => void
  /** Called once per item that just failed (any status change to
   *  'error'/'auth-error') — lets ScanTab replace a stale "waiting for a
   *  signal" line with the real, already-known reason (a 413 discovered
   *  within the same drain that queued it) rather than leaving it generic
   *  until the tech happens to look at the persistent strip instead. */
  onError?: (item: QueuedUpload) => void
}

/**
 * The queue manager. One instance per tab (see `offlineQueue` below); tests
 * construct their own instance over a memory store instead of importing the
 * singleton, so runs never share state.
 */
export class OfflineUploadQueue {
  private store: QueueStore
  private listeners = new Map<string, Set<(items: QueuedUpload[]) => void>>()
  private draining = new Set<string>()
  /** Tenants currently paused on a 401/403 — every other queued item for
   *  that tenant would fail identically, so drain() stops rather than
   *  burning through backoff on all of them one by one. Cleared by
   *  `retryAuthNow` (or a fresh drain() call after re-auth, e.g. next app
   *  open — the auth block itself is never persisted). */
  private authBlocked = new Set<string>()
  private backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(store: QueueStore) {
    this.store = store
  }

  subscribe(tenantKey: string, fn: (items: QueuedUpload[]) => void): () => void {
    let set = this.listeners.get(tenantKey)
    if (!set) {
      set = new Set()
      this.listeners.set(tenantKey, set)
    }
    set.add(fn)
    void this.store.all(tenantKey).then(fn)
    return () => {
      set?.delete(fn)
    }
  }

  private async notify(tenantKey: string): Promise<void> {
    const set = this.listeners.get(tenantKey)
    if (!set?.size) return
    const items = await this.store.all(tenantKey)
    set.forEach((fn) => fn(items))
  }

  async list(tenantKey: string): Promise<QueuedUpload[]> {
    return this.store.all(tenantKey)
  }

  isAuthBlocked(tenantKey: string): boolean {
    return this.authBlocked.has(tenantKey)
  }

  /**
   * Queue a file. Dedupes against the tenant's OWN pending items by sha256
   * first — a tech re-scanning the same paper twice while offline (easy to
   * do; nothing on screen tells them the first scan hasn't gone anywhere
   * yet) gets one queued item, not two, without ever hitting the network.
   * Throws QueueQuotaError when the device is out of storage.
   */
  async enqueue(tenantKey: string, file: File, sha256: string): Promise<QueuedUpload> {
    const existing = await this.store.all(tenantKey)
    const dup = existing.find((it) => it.sha256 === sha256 && it.status !== 'error')
    if (dup) return dup
    const item: QueuedUpload = {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tenantKey,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256,
      blob: file,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
      status: 'queued',
    }
    await this.store.add(item)
    await this.notify(tenantKey)
    return item
  }

  async remove(tenantKey: string, id: string): Promise<void> {
    await this.store.remove(id)
    await this.notify(tenantKey)
  }

  /** Clears the auth pause and immediately tries again — the "sign in again"
   *  banner's retry button calls this once the tech has a fresh session. */
  retryAuthNow(tenantKey: string): void {
    this.authBlocked.delete(tenantKey)
    void this.drain(tenantKey)
  }

  /**
   * Send every due item for one tenant, oldest first. Never runs two drains
   * of the same tenant concurrently (a second call while one is in flight is
   * a no-op) — the online event, visibilitychange, a Background Sync message
   * and a self-scheduled backoff timer can all fire close together.
   */
  async drain(tenantKey: string, opts: DrainOptions = {}): Promise<void> {
    if (this.draining.has(tenantKey)) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (this.authBlocked.has(tenantKey)) return
    this.draining.add(tenantKey)
    const timer = this.backoffTimers.get(tenantKey)
    if (timer) {
      clearTimeout(timer)
      this.backoffTimers.delete(tenantKey)
    }
    try {
      const items = await this.store.all(tenantKey)
      let soonest = Number.POSITIVE_INFINITY
      for (const item of items) {
        if (opts.signal?.aborted) break
        if (this.authBlocked.has(tenantKey)) break
        if (item.status === 'error' && item.errorClass && item.errorClass !== 'transient') continue // permanent/too-large: only the tech deleting it changes anything
        const now = Date.now()
        if (item.attempts > 0 && item.nextAttemptAt > now) {
          soonest = Math.min(soonest, item.nextAttemptAt)
          continue
        }

        await this.store.update(item.id, { status: 'uploading' })
        await this.notify(tenantKey)
        try {
          const file = new File([item.blob], item.filename, { type: item.contentType })
          const outcome = await attemptUploadOnce(file, item.sha256, opts.signal)
          await this.store.remove(item.id)
          opts.onUploaded?.(item, outcome)
        } catch (err) {
          const attempts = item.attempts + 1
          let patch: Partial<QueuedUpload>
          if (isAuthError(err)) {
            this.authBlocked.add(tenantKey)
            patch = { status: 'auth-error', attempts, error: 'Signed out — sign in again to send this.', errorClass: undefined }
          } else {
            const cls = classifyUploadError(err)
            patch = { status: 'error', attempts, error: errorMessage(err), errorClass: cls }
            if (cls === 'transient') {
              patch.nextAttemptAt = Date.now() + backoffDelayMs(attempts)
              soonest = Math.min(soonest, patch.nextAttemptAt)
            }
          }
          await this.store.update(item.id, patch)
          opts.onError?.({ ...item, ...patch })
        }
        await this.notify(tenantKey)
      }
      if (Number.isFinite(soonest) && !this.authBlocked.has(tenantKey)) {
        const delay = Math.max(0, soonest - Date.now())
        const t = setTimeout(() => void this.drain(tenantKey, opts), delay)
        this.backoffTimers.set(tenantKey, t)
      }
    } finally {
      this.draining.delete(tenantKey)
    }
  }
}

/** The live singleton — real IndexedDB in the browser. Tests import the
 *  class and a memory store instead (see scripts/verify-offline-queue.mjs). */
export const offlineQueue: OfflineUploadQueue = new OfflineUploadQueue(defaultQueueStore())

/** For anything (harness, a future screen) that wants an isolated queue
 *  without touching the shared IndexedDB — e.g. a Playwright page reload
 *  should still see the real singleton's persisted items, but a unit test
 *  should not share state across cases. */
export function createTestQueue(): OfflineUploadQueue {
  return new OfflineUploadQueue(createMemoryStore())
}

const SYNC_TAG = 'dw-offline-queue'

/** Best-effort Background Sync registration — the browser fires the
 *  service worker's `sync` event once connectivity returns, even if DeepWell
 *  Mobile isn't open, and the worker wakes any open tab to actually drain
 *  (see public/m/sw.js: it has no Clerk session of its own to upload with).
 *  Silently does nothing where unsupported (iOS Safari) — the online event,
 *  visibilitychange and backoff timer below cover it there. */
export async function registerBackgroundSync(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.ready
    const withSync = reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }
    await withSync.sync?.register(SYNC_TAG)
  } catch {
    /* unsupported or transient — the other triggers still fire */
  }
}

/**
 * Wires every trigger that should attempt a drain: right now (mount / "app
 * open"), the `online` event, the tab becoming visible again, and a wake-up
 * message from the service worker's Background Sync handler. Returns a
 * cleanup function. Call once per (tenantKey) — ScanTab re-wires when the
 * signed-in org changes.
 */
export function wireAutoDrain(manager: OfflineUploadQueue, tenantKey: string, opts: DrainOptions = {}): () => void {
  const run = () => {
    void manager.drain(tenantKey, opts)
  }
  run()
  window.addEventListener('online', run)
  const onVisible = () => {
    if (document.visibilityState === 'visible') run()
  }
  document.addEventListener('visibilitychange', onVisible)
  let onMessage: ((e: MessageEvent) => void) | undefined
  if ('serviceWorker' in navigator) {
    onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | undefined
      if (data?.type === 'dw-offline-queue-sync') run()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
  }
  return () => {
    window.removeEventListener('online', run)
    document.removeEventListener('visibilitychange', onVisible)
    if (onMessage) navigator.serviceWorker.removeEventListener('message', onMessage)
  }
}
