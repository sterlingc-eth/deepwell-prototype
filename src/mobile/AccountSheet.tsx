import { useEffect, useState } from 'react'
import { useClerk, useOrganization, useOrganizationList, useUser } from '@clerk/clerk-react'
import { Check, Loader2, LogOut, Store } from 'lucide-react'
import { Sheet } from './Sheet'
import { offlineQueue } from './offline/uploadQueue'
import { clearTenantSessionState, wipeAndSignOut } from './offline/deviceIsolation'

export function AccountSheet({ onClose }: { onClose: () => void }) {
  const { user } = useUser()
  const clerk = useClerk()
  const { organization } = useOrganization()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: { infinite: true, pageSize: 20 } })
  const memberships = userMemberships?.data ?? []
  const [busyOrg, setBusyOrg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmOut, setConfirmOut] = useState<number | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const name = user?.fullName ?? user?.firstName ?? email

  const switchTo = async (orgId: string) => {
    if (!setActive || busyOrg || orgId === organization?.id) return
    setBusyOrg(orgId)
    setError(null)
    try {
      // Stop the old shop's uploads first; nothing queued may follow the session into the new shop.
      offlineQueue.setActiveTenant(null)
      clearTenantSessionState()
      await setActive({ organization: orgId })
      // Fresh page = no old-shop graph, answers or sheets left in memory. The queue re-wires for the new shop.
      window.location.reload()
    } catch (e) {
      setBusyOrg(null)
      // The old shop is still the signed-in one: let its queue run again.
      if (organization?.id) offlineQueue.setActiveTenant(organization.id)
      setError(e instanceof Error && e.message ? e.message : 'Could not switch companies. Try again.')
    }
  }

  const doSignOut = async () => {
    setSigningOut(true)
    setError(null)
    try {
      await wipeAndSignOut(() => offlineQueue.purgeAll(), () => clerk.signOut({ redirectUrl: '/m/' }))
    } catch (e) {
      setSigningOut(false)
      setError(e instanceof Error && e.message ? e.message : 'Could not sign out. Try again.')
    }
  }

  const askSignOut = async () => {
    let waiting = 0
    try {
      waiting = await offlineQueue.countAll()
    } catch {
      waiting = 0
    }
    if (waiting > 0) setConfirmOut(waiting)
    else void doSignOut()
  }

  // Keep the list fresh if Clerk loads memberships after the sheet opens.
  useEffect(() => {
    void userMemberships?.revalidate?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Sheet title="Account" onClose={onClose}>
      <div className="space-y-1" data-testid="account-identity">
        {name && <p className="m-0 text-body-lg font-semibold text-ink break-words">{name}</p>}
        {email && email !== name && <p className="m-0 text-caption text-ink-3 break-all">{email}</p>}
      </div>

      <section aria-labelledby="acct-shop-heading" className="space-y-2">
        <h3 id="acct-shop-heading" className="m-0 text-caption font-semibold uppercase tracking-wide text-ink-3">Current company</h3>
        <p className="m-0 flex items-center gap-2 text-body-lg text-ink" data-testid="account-current-shop">
          <Store className="w-5 h-5 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="break-words min-w-0">{organization?.name ?? 'No company'}</span>
        </p>
      </section>

      {isLoaded && memberships.length > 1 && (
        <section aria-labelledby="acct-switch-heading" className="space-y-2" data-testid="account-switcher">
          <h3 id="acct-switch-heading" className="m-0 text-caption font-semibold uppercase tracking-wide text-ink-3">Switch company</h3>
          <ul className="m-0 p-0 list-none grid gap-2">
            {memberships.map((m) => {
              const current = m.organization.id === organization?.id
              const busy = busyOrg === m.organization.id
              return (
                <li key={m.organization.id}>
                  <button
                    type="button"
                    disabled={current || !!busyOrg}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => void switchTo(m.organization.id)}
                    className="w-full min-h-touch px-4 rounded-xl border border-line bg-surface-2 text-ink text-left flex items-center justify-between gap-3 disabled:opacity-70"
                  >
                    <span className="break-words min-w-0">{m.organization.name}</span>
                    {busy ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-label="Switching" /> : current ? <Check className="w-5 h-5 shrink-0 text-accent" aria-label="Current company" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="m-0 text-caption text-ink-3">Scans waiting to upload stay with the company they were taken in.</p>
        </section>
      )}

      {error && <p role="alert" className="m-0 text-body text-bad-ink">{error}</p>}

      {confirmOut !== null ? (
        <div role="alertdialog" aria-labelledby="acct-confirm-out" className="rounded-xl border border-line p-4 space-y-3" data-testid="account-signout-confirm">
          <p id="acct-confirm-out" className="m-0 text-body text-ink">
            {confirmOut === 1 ? '1 scan has' : `${confirmOut} scans have`} not been sent yet. Signing out deletes {confirmOut === 1 ? 'it' : 'them'} from this phone.
          </p>
          <div className="grid gap-2">
            <button type="button" className="min-h-touch rounded-xl bg-surface-2 text-ink font-semibold" onClick={() => setConfirmOut(null)} disabled={signingOut}>
              Stay signed in
            </button>
            <button type="button" className="min-h-touch rounded-xl border border-bad text-bad-ink font-semibold flex items-center justify-center gap-2" onClick={() => void doSignOut()} disabled={signingOut} data-testid="account-signout-confirm-yes">
              {signingOut && <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />} Sign out and delete
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="account-signout"
          className="min-h-touch rounded-xl bg-surface-2 text-ink font-semibold flex items-center justify-center gap-2"
          onClick={() => void askSignOut()}
          disabled={signingOut}
        >
          {signingOut ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <LogOut className="w-5 h-5" aria-hidden="true" />} Sign out
        </button>
      )}
    </Sheet>
  )
}
