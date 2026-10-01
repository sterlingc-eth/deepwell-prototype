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
export async function attemptUploadOnce(file: File, sha256: string, signal?: AbortSignal, expectedTenant?: string): Promise<UploadOutcome> {
  const { documentId, uploadUrl, alreadyUploaded } = await requestUploadUrl(
    { filename: file.name, sha256, contentType: file.type || undefined, sizeBytes: file.size },
    signal,
    expectedTenant
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
    // R30 L4: 402 = "choose a plan" / monthly page cap. That resolves itself (the shop subscribes, the month rolls
    // over), so the scan must be retried later, not thrown away as permanent. drain() spaces these retries out.
    if (err.status === 402) return 'transient'
    if (err.status === 401) return 'permanent' // caller special-cases 401 as an auth pause; see drain()
    if (err.status === 403) return 'permanent' // R30 L4: forbidden for THIS scan (role/plan/scope) - not "signed out"
    if (err.status === 429 || err.status >= 500) return 'transient'
    return 'permanent' // 400/402/404/etc — retrying the same bytes changes nothing
  }
  // A thrown network error (offline, DNS failure, an aborted "still no
  // signal" timeout) is always worth retrying once connectivity is back.
  return 'transient'
}

/** The server (api/upload-url.js) refuses a scan whose capture shop is no longer the signed-in shop. */
function isTenantMismatch(err: unknown): boolean {
  return err instanceof IngestHttpError && err.status === 409 && (err.body as { code?: string } | null)?.code === 'tenant-mismatch'
}

/** Only a 401 means "signed out". R30 L4: a 403 (wrong role/plan/scope for one request) used to pause the WHOLE queue
 *  behind a misleading "Signed out - sign in again" banner; it now fails just that scan with the server's message. */
function isAuthError(err: unknown): boolean {
  return err instanceof IngestHttpError && err.status === 401
}

/** R30 L4: a billing 402 will not clear in seconds - wait at least this long between tries. */
export const BILLING_RETRY_MIN_MS = 10 * 60_000
/** R35: never wait longer than this on a server Retry-After (a daily-cap 429 says "until UTC midnight"; the tech should
 *  not come back to a scan that sat idle all night when the cap lifted at 5am local). */
export const RETRY_AFTER_CAP_MS = 2 * 60 * 60_000
export function retryDelayMs(err: unknown, attempts: number): number {
  const base = backoffDelayMs(attempts)
  if (err instanceof IngestHttpError && err.status === 402) return Math.max(base, BILLING_RETRY_MIN_MS)
  // R35: honor the server's Retry-After on a 429 (it was ignored here - the queue guessed its own backoff and every
  // queued scan guessed the same moment, which is a thundering herd on the shared per-minute bucket).
  if (err instanceof IngestHttpError && err.status === 429 && typeof err.retryAfterSeconds === 'number' && Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds >= 0) {
    return Math.min(Math.max(base, err.retryAfterSeconds * 1000 + Math.round(Math.random() * 2000)), RETRY_AFTER_CAP_MS)
  }
  return base
}

/** R35: a response that says "the SHOP is throttled/blocked right now", not "this scan is bad". When one arrives the
 *  rest of the queue must stop sending: every further attempt is certain to fail the same way, burns that scan's retry
 *  budget, and (rate limit) makes the shared per-minute bucket worse for the shop's other people. */
export function isShopWidePause(err: unknown): boolean {
  return err instanceof IngestHttpError && (err.status === 429 || err.status === 402)
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
  /** R35: tenant -> epoch ms before which NOTHING is sent (set by a shop-wide 429/402, see isShopWidePause). */
  private pausedUntil = new Map<string, number>()
  private backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The shop this phone is signed into RIGHT NOW. `undefined` = never told (tests, unguarded); `null` = nobody is
   *  signed in, so nothing may upload. A drain only ever runs for the active tenant; see setActiveTenant. */
  private activeTenant: string | null | undefined = undefined
  private inflight = new Map<string, AbortController>()

  constructor(store: QueueStore) {
    this.store = store
  }

  /**
   * Tell the queue which shop is signed in (null = nobody). Anything still running or scheduled for a DIFFERENT
   * shop is stopped at once: its backoff timer is cancelled and its in-flight upload aborted, and those scans stay
   * queued (untouched) for when that shop is active again. Without this, a retry timer or a running drain kept using
   * the CURRENT session token after an org switch and would have filed shop A's scans into shop B.
   */
  setActiveTenant(tenantKey: string | null): void {
    this.activeTenant = tenantKey
    for (const [key, t] of this.backoffTimers) {
      if (key !== tenantKey) {
        clearTimeout(t)
        this.backoffTimers.delete(key)
      }
    }
    for (const [key, ac] of this.inflight) {
      if (key !== tenantKey) ac.abort()
    }
  }

  private allowed(tenantKey: string): boolean {
    return this.activeTenant === undefined || this.activeTenant === tenantKey
  }

  /** Scans waiting on this phone across every shop. */
  countAll(): Promise<number> {
    return this.store.countAll()
  }

  /** Delete every queued scan for every shop and stop all work. For sign-out and "a different person is on this phone". */
  async purgeAll(): Promise<void> {
    this.activeTenant = null
    for (const t of this.backoffTimers.values()) clearTimeout(t)
    this.backoffTimers.clear()
    for (const ac of this.inflight.values()) ac.abort()
    this.authBlocked.clear()
    this.pausedUntil.clear()
    await this.store.clearAll()
    for (const key of this.listeners.keys()) await this.notify(key)
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
    if (!this.allowed(tenantKey)) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (this.authBlocked.has(tenantKey)) return
    // R35: inside a shop-wide pause the online/visibility/sync triggers must not retry the next scan early.
    const pausedUntil = this.pausedUntil.get(tenantKey) ?? 0
    if (pausedUntil > Date.now()) {
      if (!this.backoffTimers.has(tenantKey)) {
        this.backoffTimers.set(tenantKey, setTimeout(() => void this.drain(tenantKey, opts), pausedUntil - Date.now()))
      }
      return
    }
    this.pausedUntil.delete(tenantKey)
    this.draining.add(tenantKey)
    const ac = new AbortController()
    this.inflight.set(tenantKey, ac)
    const onOuterAbort = () => ac.abort()
    opts.signal?.addEventListener('abort', onOuterAbort)
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
        if (!this.allowed(tenantKey)) break // signed-in shop changed mid-drain: leave the rest untouched
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
          const outcome = await attemptUploadOnce(file, item.sha256, ac.signal, tenantKey)
          await this.store.remove(item.id)
          opts.onUploaded?.(item, outcome)
        } catch (err) {
          if (!this.allowed(tenantKey) || isTenantMismatch(err)) {
            // Not a failure of the scan: the signed-in shop is not the one it was captured in. Put it back as it was.
            await this.store.update(item.id, { status: 'queued' })
            await this.notify(tenantKey)
            break
          }
          const attempts = item.attempts + 1
          let patch: Partial<QueuedUpload>
          if (isAuthError(err)) {
            this.authBlocked.add(tenantKey)
            patch = { status: 'auth-error', attempts, error: 'Signed out — sign in again to send this.', errorClass: undefined }
          } else {
            const cls = classifyUploadError(err)
            patch = { status: 'error', attempts, error: errorMessage(err), errorClass: cls }
            if (cls === 'transient') {
              patch.nextAttemptAt = Date.now() + retryDelayMs(err, attempts)
              soonest = Math.min(soonest, patch.nextAttemptAt)
            }
          }
          await this.store.update(item.id, patch)
          opts.onError?.({ ...item, ...patch })
          // R35: stop the drain at the first shop-wide refusal; the untouched scans keep their place and attempts.
          if (isShopWidePause(err)) {
            this.pausedUntil.set(tenantKey, patch.nextAttemptAt ?? Date.now() + retryDelayMs(err, attempts))
            await this.notify(tenantKey)
            break
          }
        }
        await this.notify(tenantKey)
      }
      if (Number.isFinite(soonest) && !this.authBlocked.has(tenantKey) && this.allowed(tenantKey)) {
        const delay = Math.max(0, soonest - Date.now())
        const t = setTimeout(() => void this.drain(tenantKey, opts), delay)
        this.backoffTimers.set(tenantKey, t)
      }
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort)
      this.inflight.delete(tenantKey)
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
