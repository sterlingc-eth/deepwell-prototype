/**
 * Keeps one person's / one shop's data from following the phone into another session (R30).
 *
 *  - The offline queue holds scanned files (already compressed) in IndexedDB. It is namespaced per shop and the
 *    queue manager only ever drains the shop that is signed in, but the bytes themselves must not outlive the
 *    person: on sign-out, and whenever a DIFFERENT user turns up on the same phone, the whole queue is deleted.
 *  - sessionStorage holds the Help chat and the cached billing status; both go on sign-out and on a shop switch.
 *
 * Pure-ish on purpose (storage and the purge callback are injected) so scripts/verify-r30-app-fixes.mjs can test
 * it without a browser.
 */

export const DEVICE_OWNER_KEY = 'dw.mobile.owner'
/** sessionStorage key prefixes that can hold a shop's data (support chat transcript, cached billing status). */
export const TENANT_SESSION_PREFIXES = ['deepwell.support.chat.', 'deepwell.billingStatus.']

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

/** Remove every sessionStorage entry that could hold the previous shop's / person's data. */
export function clearTenantSessionState(store: KeyValueStore | null = safeSession()): void {
  if (!store) return
  try {
    const doomed: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && TENANT_SESSION_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k)
    }
    doomed.forEach((k) => store.removeItem(k))
  } catch {
    /* storage blocked: nothing was persisted there either */
  }
}

function safeSession(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}
function safeLocal(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/**
 * Called once per sign-in with the signed-in user id. When this phone last belonged to a DIFFERENT user, everything
 * queued by them is deleted before anything can drain. First-ever run (no owner recorded, e.g. a phone upgraded to
 * this build) adopts the current user and keeps the queue so nobody loses scans already waiting.
 * Returns true when a purge happened.
 */
export async function reconcileDeviceOwner(userId: string, purge: () => Promise<void>, local: KeyValueStore | null = safeLocal()): Promise<boolean> {
  let owner: string | null = null
  try {
    owner = local?.getItem(DEVICE_OWNER_KEY) ?? null
  } catch {
    owner = null
  }
  let purged = false
  if (owner && owner !== userId) {
    try {
      await purge()
    } finally {
      clearTenantSessionState()
    }
    purged = true
  }
  try {
    local?.setItem(DEVICE_OWNER_KEY, userId)
  } catch {
    /* storage blocked: the next sign-in simply cannot detect a change */
  }
  return purged
}

/** Sign-out: wipe the queue and shop-scoped browser state FIRST (so nothing can upload or linger), then sign out. */
export async function wipeAndSignOut(purge: () => Promise<void>, signOut: () => Promise<unknown>, local: KeyValueStore | null = safeLocal()): Promise<void> {
  try {
    await purge()
  } catch {
    /* best effort: the sign-out below still ends the session */
  }
  clearTenantSessionState()
  try {
    local?.removeItem(DEVICE_OWNER_KEY)
  } catch {
    /* ignore */
  }
  await signOut()
}
