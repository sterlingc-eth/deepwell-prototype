import { lazy, Suspense, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { Sheet } from './Sheet'
import { loadAccountSheet } from './sheetLoader'
import { SheetBoundary } from './lazySheets'

// The sheet (shop switcher, sign-out, tenant-isolation helpers) opens on tap, so it stays out of the phone's startup bundle.
const AccountSheet = lazy(() => loadAccountSheet().then((m) => ({ default: m.AccountSheet })))

/**
 * Phone account menu (R30): who is signed in, which shop, a shop switcher when the person belongs to more than one,
 * and Sign out. It replaces Clerk's UserButton so both actions go through the same tenant-isolation rules:
 *  - Switching shops halts anything queued for the old shop, clears shop-scoped browser state, activates the new shop,
 *    then reloads so no graph, answer or sheet from the old shop stays in memory. Queued scans are NOT sent to the
 *    new shop: they stay under their own shop and only upload when that shop is active again (the server also
 *    refuses them with a 409 otherwise, see api/upload-url.js).
 *  - Signing out deletes the phone's whole offline queue (with a plain warning first when scans are still waiting).
 * Not a 4th tab: it is a header button that opens a sheet.
 */
export function AccountMenu({ triggerClassName }: { triggerClassName?: string }) {
  const [open, setOpen] = useState(false)
  const { user } = useUser()
  const initial = (user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? '?').toUpperCase()
  return (
    <>
      <button
        type="button"
        aria-label="Account and companies"
        aria-haspopup="dialog"
        data-testid="account-button"
        onClick={() => setOpen(true)}
        className={triggerClassName ?? 'w-11 h-11 shrink-0 flex items-center justify-center rounded-full bg-surface-2 text-ink text-body font-semibold border border-line'}
      >
        <span aria-hidden="true">{initial}</span>
      </button>
      {open && (
        <SheetBoundary title="Account" onClose={() => setOpen(false)}>
          <Suspense fallback={<Sheet title="Account" onClose={() => setOpen(false)}><div className="min-h-32" aria-busy="true" /></Sheet>}>
            <AccountSheet onClose={() => setOpen(false)} />
          </Suspense>
        </SheetBoundary>
      )}
    </>
  )
}

