/**
 * Shared, in-process performance primitives for the 2026-09-22 latency work
 * (handoffs/API_PERF_2026-09-22.md): a tiny bounded TTL cache, and a timing
 * logger gated behind DW_TIMING=1.
 *
 * Deliberately dependency-free (no-new-deps constraint) and deliberately
 * small: every cache in this codebase's hot path is small enough (one entry
 * per tenant) that a plain Map with lazy expiry checks is simpler and just as
 * fast as an LRU library, and easier for the next engineer to read in one
 * sitting.
 *
 * PRIVACY: logStage() must never be handed a raw tenant key (a Clerk org id
 * is not secret, but it is still an identifier we don't need in logs for this
 * purpose), an env value, or any PII. Callers pass only stage names, booleans
 * and small numbers — see each call site.
 */

/**
 * Bounded, TTL-based cache. "Bounded" here means an old entry is evicted
 * lazily (on the next set() once the cap is hit) rather than with a real LRU
 * list — this is sized for "one entry per tenant per warm instance", at most
 * a few hundred entries even for a busy instance, so a cheap eviction policy
 * (drop the oldest-inserted entry) is enough to guarantee the cache can never
 * grow unbounded if a caller mistakenly keys it on something high-cardinality
 * (e.g. a document id instead of a tenant id).
 */
export class TTLCache {
  /**
   * @param {number} ttlMs default time-to-live for an entry with no per-call override
   * @param {number} maxEntries hard cap; oldest insertion is evicted once exceeded
   */
  constructor(ttlMs, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /** @returns {*} the cached value, or undefined if absent/expired (expired entries are deleted on read). */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** @param {number} [ttlMs] override this entry's TTL (e.g. a shorter TTL for a 'canceled' billing state). */
  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      // Map iteration order is insertion order — the first key is the oldest.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  /** Test/debug only — current live (non-expired) entry count. */
  size() {
    let n = 0;
    const now = Date.now();
    for (const entry of this.map.values()) {
      if (entry.expiresAt > now) n++;
    }
    return n;
  }
}

/**
 * memoAsync: wraps an async lookup with a TTLCache so concurrent callers
 * during a cache miss share one in-flight request instead of each starting
 * their own (a "thundering herd" of N simultaneous requests for the same
 * tenant would otherwise fire N identical queries the instant a cache entry
 * expires). The in-flight promise itself is cached (briefly) so a second
 * caller awaits the first's result rather than re-querying; a rejected
 * lookup is never cached, so a transient DB error doesn't lock a tenant out
 * for the rest of the TTL.
 *
 * @param {TTLCache} cache
 * @param {string} key
 * @param {() => Promise<*>} fetcher
 * @param {number} [ttlMs]
 */
export async function memoAsync(cache, key, fetcher, ttlMs) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const promise = fetcher()
    .then((value) => {
      cache.set(key, value, ttlMs);
      return value;
    })
    .catch((err) => {
      cache.delete(key); // never cache a failure
      throw err;
    });
  // Cache the in-flight promise itself for a few seconds so a burst of
  // concurrent requests for the same tenant (very common: several API calls
  // fire together on /app open) collapses to one query, not N.
  cache.set(key, promise, 5_000);
  return promise;
}

/**
 * Cross-cache invalidation registry (Reviewer NO-GO, 2026-09-22): every
 * per-tenant TTLCache that keys on a tenant identifier registers itself
 * here, so ONE call — bustTenantCaches() — can clear a tenant's entry out of
 * all of them, from whichever file just learned that tenant's billing state
 * changed (today, only api/billing.js's webhook handler). Registration is a
 * plain array push at module load (recordsStore.js/plan.js each do it once,
 * right after constructing their cache) — deliberately NOT a reverse import
 * (perf.js importing recordsStore.js/plan.js would be circular, since both
 * of those already import FROM perf.js).
 *
 * SAME-INSTANCE ONLY: this clears the warm Vercel instance that RUNS this
 * call. A Stripe webhook can land on a different instance than the one
 * serving a given tenant's reads, and that other instance's cache entry is
 * never reachable from here — there is no cross-instance signal in this
 * architecture (no pub/sub, no shared cache). Busting here is a same-instance
 * speed-up, not the correctness guarantee; the TTLs themselves (2 min
 * normal, 30s for a gated 'none'/'canceled' billing row — see plan.js) are
 * what bound staleness across every instance, busted or not. See
 * handoffs/API_PERF_2026-09-22.md for the exact bound.
 */
const registeredTenantCaches = [];

/** Called once by each per-tenant cache right after construction. */
export function registerTenantCache(cache) {
  registeredTenantCaches.push(cache);
}

/**
 * Clear one tenant's entry out of every registered cache, on THIS instance.
 * Accepts either form of tenant identifier a caller might have on hand — the
 * tenantKey (Clerk org id / `user_<id>`, what every cache is actually keyed
 * by) or the tenant's uuid (what a Stripe-webhook lookup like
 * billing_tenant_by_customer() returns, with no tenantKey in hand at all).
 * `uuidToTenantKey` (recordsStore.js) is consulted to translate a uuid this
 * instance has already resolved before; a uuid it has never seen simply has
 * nothing cached to bust, which is a correct no-op, not a failure.
 *
 * @param {string|null|undefined} tenantKeyOrUuid
 * @param {Map<string,string>} [uuidToTenantKey]
 */
export function bustTenantCaches(tenantKeyOrUuid, uuidToTenantKey) {
  if (!tenantKeyOrUuid) return;
  const translated = uuidToTenantKey?.get(tenantKeyOrUuid);
  const keys = translated ? [tenantKeyOrUuid, translated] : [tenantKeyOrUuid];
  for (const key of keys) {
    for (const cache of registeredTenantCaches) cache.delete(key);
  }
}

/** True when DW_TIMING=1 is set — the one flag every timing log line below is gated on. Read fresh each call (not memoized) so a test can flip process.env.DW_TIMING between assertions. */
export function timingEnabled() {
  return process.env.DW_TIMING === '1';
}

/**
 * One JSON line to stdout, only when DW_TIMING=1. `fields` must contain only
 * stage names, durations (ms), booleans and small counts — never a tenant
 * key/id, a user id, an email, or an env value. Wrapped in try/catch so a
 * logging bug can never be the reason a request fails.
 */
export function logStage(fields) {
  if (!timingEnabled()) return;
  try {
    console.log(JSON.stringify({ dw_timing: true, ts: Date.now(), ...fields }));
  } catch {
    /* logging must never break the request */
  }
}
