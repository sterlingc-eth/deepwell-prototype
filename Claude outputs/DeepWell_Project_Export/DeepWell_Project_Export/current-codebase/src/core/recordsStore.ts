/**
 * RecordsStore — lean persistence for the open-schema pipeline (M2).
 *
 * One object store per collection in a real `indexedDB` database
 * (`deepwell-records`, version 1), with an in-memory fallback for
 * environments where `indexedDB` doesn't exist (SSR, tests, some privacy
 * modes). Postgres/object storage swap in at M3 behind this same interface —
 * see claude/M2_PLAN.md.
 */

export type CollectionName = 'entities' | 'docs' | 'batches' | 'conflicts' | 'facets' | 'proposals' | 'schemaVersions' | 'auditLog';

export const COLLECTIONS: CollectionName[] = ['entities', 'docs', 'batches', 'conflicts', 'facets', 'proposals', 'schemaVersions', 'auditLog'];

export interface RecordsStore {
  get<T>(collection: CollectionName, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(collection: CollectionName, value: T): Promise<void>;
  putMany<T extends { id: string }>(collection: CollectionName, values: T[]): Promise<void>;
  delete(collection: CollectionName, id: string): Promise<void>;
  all<T>(collection: CollectionName): Promise<T[]>;
  query<T>(collection: CollectionName, predicate: (v: T) => boolean): Promise<T[]>;
  /** No arg = wipe everything ("Reset sample data"). */
  clear(collection?: CollectionName): Promise<void>;
  /** For the export-all zip. */
  exportAll(): Promise<Record<CollectionName, unknown[]>>;
}

const DB_NAME = 'deepwell-records';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of COLLECTIONS) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
  });
}

/** Real indexedDB-backed store. */
export function createIndexedDbStore(): RecordsStore {
  let dbPromise: Promise<IDBDatabase> | undefined;
  const db = () => (dbPromise ??= openDb());

  return {
    async get<T>(collection: CollectionName, id: string): Promise<T | undefined> {
      const conn = await db();
      const tx = conn.transaction(collection, 'readonly');
      const value = await reqToPromise<T | undefined>(tx.objectStore(collection).get(id));
      return value ?? undefined;
    },

    async put<T extends { id: string }>(collection: CollectionName, value: T): Promise<void> {
      const conn = await db();
      const tx = conn.transaction(collection, 'readwrite');
      tx.objectStore(collection).put(value);
      await txDone(tx);
    },

    async putMany<T extends { id: string }>(collection: CollectionName, values: T[]): Promise<void> {
      if (!values.length) return;
      const conn = await db();
      const tx = conn.transaction(collection, 'readwrite');
      const store = tx.objectStore(collection);
      for (const v of values) store.put(v);
      await txDone(tx);
    },

    async delete(collection: CollectionName, id: string): Promise<void> {
      const conn = await db();
      const tx = conn.transaction(collection, 'readwrite');
      tx.objectStore(collection).delete(id);
      await txDone(tx);
    },

    async all<T>(collection: CollectionName): Promise<T[]> {
      const conn = await db();
      const tx = conn.transaction(collection, 'readonly');
      const values = await reqToPromise<T[]>(tx.objectStore(collection).getAll());
      return values ?? [];
    },

    async query<T>(collection: CollectionName, predicate: (v: T) => boolean): Promise<T[]> {
      const values = await this.all<T>(collection);
      return values.filter(predicate);
    },

    async clear(collection?: CollectionName): Promise<void> {
      const conn = await db();
      const names = collection ? [collection] : COLLECTIONS;
      const tx = conn.transaction(names, 'readwrite');
      for (const name of names) tx.objectStore(name).clear();
      await txDone(tx);
    },

    async exportAll(): Promise<Record<CollectionName, unknown[]>> {
      const out = {} as Record<CollectionName, unknown[]>;
      for (const name of COLLECTIONS) out[name] = await this.all(name);
      return out;
    },
  };
}

/** In-memory fallback with the same interface — used when `indexedDB` is unavailable. */
export function createMemoryStore(): RecordsStore {
  const data: Record<CollectionName, Map<string, unknown>> = {
    entities: new Map(), docs: new Map(), batches: new Map(), conflicts: new Map(),
    facets: new Map(), proposals: new Map(), schemaVersions: new Map(), auditLog: new Map(),
  };

  return {
    async get<T>(collection: CollectionName, id: string): Promise<T | undefined> {
      return data[collection].get(id) as T | undefined;
    },
    async put<T extends { id: string }>(collection: CollectionName, value: T): Promise<void> {
      data[collection].set(value.id, value);
    },
    async putMany<T extends { id: string }>(collection: CollectionName, values: T[]): Promise<void> {
      for (const v of values) data[collection].set(v.id, v);
    },
    async delete(collection: CollectionName, id: string): Promise<void> {
      data[collection].delete(id);
    },
    async all<T>(collection: CollectionName): Promise<T[]> {
      return Array.from(data[collection].values()) as T[];
    },
    async query<T>(collection: CollectionName, predicate: (v: T) => boolean): Promise<T[]> {
      return (Array.from(data[collection].values()) as T[]).filter(predicate);
    },
    async clear(collection?: CollectionName): Promise<void> {
      if (collection) data[collection].clear();
      else for (const name of COLLECTIONS) data[name].clear();
    },
    async exportAll(): Promise<Record<CollectionName, unknown[]>> {
      const out = {} as Record<CollectionName, unknown[]>;
      for (const name of COLLECTIONS) out[name] = Array.from(data[name].values());
      return out;
    },
  };
}

/** Factory used everywhere else in the app: real indexedDB when available, memory otherwise. */
export function createRecordsStore(): RecordsStore {
  return typeof indexedDB === 'undefined' ? createMemoryStore() : createIndexedDbStore();
}
