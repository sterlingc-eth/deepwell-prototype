/**
 * Offline upload queue storage — persists a scanned file's already-compressed
 * bytes (src/mobile/imagePrep.ts has already run by the time anything reaches
 * here) on the device until it can be sent to `/api/upload-url` +
 * `/api/read-document` (src/mobile/offline/uploadQueue.ts owns that part).
 *
 * A small, dependency-free wrapper around IndexedDB, kept behind a plain
 * `QueueStore` interface so scripts/verify-offline-queue.mjs can exercise the
 * exact same enqueue/drain logic (uploadQueue.ts) against an in-memory
 * adapter — no fake-indexeddb dependency, no browser needed to test
 * retry/backoff/dedupe/tenant-namespacing.
 *
 * One database (`dw-offline-queue`), one object store (`items`), keyed by a
 * client-generated id, indexed by `tenantKey` — the signed-in org id, or the
 * user id when there is no org (same value MobileApp.tsx already uses for
 * `usePostgresSync`). A phone shared between two techs at two different shops
 * only ever lists/drains ITS current tenant's rows (see uploadQueue.ts) —
 * the other shop's queued scans just sit inert in the same store until
 * someone signs back into that org.
 */

export type QueueItemStatus = 'queued' | 'uploading' | 'error' | 'auth-error'

/** Only set once an item has failed at least once. 'transient' is retried
 *  with backoff; 'too-large' and 'permanent' are not retried automatically —
 *  the bytes will never succeed unchanged, so the item just sits with its
 *  message until the tech deletes it. */
export type QueueErrorClass = 'transient' | 'too-large' | 'permanent'

export interface QueuedUpload {
  id: string
  tenantKey: string
  filename: string
  contentType: string
  sizeBytes: number
  /** sha256 of the (already-compressed) bytes, computed once at enqueue time
   *  and reused on every retry — this IS the idempotency key: the server's
   *  (tenant_id, sha256_hash) unique constraint (api/upload-url.js) means a
   *  retried upload of the same bytes is recognized as the same document,
   *  never a duplicate, no matter how many times the queue retries it. */
  sha256: string
  blob: Blob
  createdAt: number
  attempts: number
  /** Drain skips this item until Date.now() >= nextAttemptAt (backoff). */
  nextAttemptAt: number
  status: QueueItemStatus
  error?: string
  errorClass?: QueueErrorClass
}

/** What the caller supplies; the rest is filled in by `QueueStore`/the manager. */
export type NewQueuedUpload = Pick<QueuedUpload, 'id' | 'tenantKey' | 'filename' | 'contentType' | 'sizeBytes' | 'sha256' | 'blob'>

/** Thrown by a store's `add` when the device has no room left for the file
 *  (Safari/Chrome both raise a DOMException named QuotaExceededError for a
 *  full IndexedDB). Callers show the tech a plain message instead of the
 *  scan silently vanishing. */
export class QueueQuotaError extends Error {
  constructor(cause?: unknown) {
    super('Not enough storage on this device to queue this scan. Free up space or delete an older queued item.')
    this.name = 'QueueQuotaError'
    this.cause = cause
  }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22)
}

export interface QueueStore {
  add(item: QueuedUpload): Promise<void>
  /** Every item for one tenant, oldest first (FIFO). */
  all(tenantKey: string): Promise<QueuedUpload[]>
  get(id: string): Promise<QueuedUpload | undefined>
  update(id: string, patch: Partial<QueuedUpload>): Promise<void>
  remove(id: string): Promise<void>
  /** How many items are queued across every tenant (for the sign-out warning). */
  countAll(): Promise<number>
  /** Delete EVERY item for EVERY tenant (sign-out / another person on this phone). */
  clearAll(): Promise<void>
}

const DB_NAME = 'dw-offline-queue'
const STORE = 'items'
const DB_VERSION = 1

/** Real, browser IndexedDB-backed store. */
export function createIndexedDbStore(dbName = DB_NAME): QueueStore {
  let dbPromise: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' })
            store.createIndex('tenantKey', 'tenantKey', { unique: false })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    }
    return dbPromise
  }

  return {
    async add(item) {
      const db = await open()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).add(item)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } catch (err) {
        if (isQuotaError(err)) throw new QueueQuotaError(err)
        throw err
      }
    },
    async all(tenantKey) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const idx = tx.objectStore(STORE).index('tenantKey')
        const out: QueuedUpload[] = []
        const req = idx.openCursor(IDBKeyRange.only(tenantKey))
        req.onsuccess = () => {
          const cursor = req.result
          if (cursor) {
            out.push(cursor.value as QueuedUpload)
            cursor.continue()
          } else {
            resolve(out.sort((a, b) => a.createdAt - b.createdAt))
          }
        }
        req.onerror = () => reject(req.error)
      })
    },
    async get(id) {
      const db = await open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(id)
        req.onsuccess = () => resolve(req.result as QueuedUpload | undefined)
        req.onerror = () => reject(req.error)
      })
    },
    async update(id, patch) {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const existing = getReq.result as QueuedUpload | undefined
          if (!existing) {
            resolve()
            return
          }
          store.put({ ...existing, ...patch })
        }
        getReq.onerror = () => reject(getReq.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async remove(id) {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async countAll() {
      const db = await open()
      return new Promise<number>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    },
    async clearAll() {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
  }
}

/** In-memory adapter behind the SAME interface — used by
 *  scripts/verify-offline-queue.mjs (plain Node, no browser, no
 *  fake-indexeddb dependency) and available to any other test that wants a
 *  queue without touching a real device's storage. */
export function createMemoryStore(): QueueStore {
  const rows = new Map<string, QueuedUpload>()
  return {
    async add(item) {
      if (rows.has(item.id)) throw new Error(`duplicate queue id ${item.id}`)
      rows.set(item.id, { ...item })
    },
    async all(tenantKey) {
      return [...rows.values()]
        .filter((r) => r.tenantKey === tenantKey)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({ ...r }))
    },
    async get(id) {
      const r = rows.get(id)
      return r ? { ...r } : undefined
    },
    async update(id, patch) {
      const existing = rows.get(id)
      if (!existing) return
      rows.set(id, { ...existing, ...patch })
    },
    async remove(id) {
      rows.delete(id)
    },
    async countAll() {
      return rows.size
    },
    async clearAll() {
      rows.clear()
    },
  }
}

let sharedStore: QueueStore | null = null
/** One store for the life of the tab: real IndexedDB in the browser, an
 *  in-memory fallback anywhere it's missing (SSR/build tooling, or a very
 *  old in-app browser) so importing this module never throws. */
export function defaultQueueStore(): QueueStore {
  if (!sharedStore) {
    sharedStore = typeof indexedDB !== 'undefined' ? createIndexedDbStore() : createMemoryStore()
  }
  return sharedStore
}
