import { useEffect, useState } from 'react';
import { CreateOrganization, OrganizationProfile, useAuth, useOrganization } from '@clerk/clerk-react';
import { Bell, ChevronDown, ChevronUp, Download, Loader2, Users } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { useAppStore } from '../store/appStore';
import { isAdminRole, seatStatus } from '../services/teamClient';
import { fetchNotifications, setEmailDigestPreference } from '../services/notifyClient';
import { downloadTenantExportJson } from '../services/exportClient';
import { memberDisplayName } from '../core/memberNames';
import { FollowupsCard } from '../components/FollowupsCard';
import { PhoneAppCard } from '../components/PhoneAppCard';

/**
 * Team screen (handoffs/ORG_INVITES_AUDIT.md): Clerk's own
 * `<OrganizationProfile />` IS the invite/manage UI — it sends the invite
 * email, hosts the invitee's sign-up, and is the source of truth for who's
 * in the org and what role they hold. This screen's job is only to (1) put
 * that behind an admin-only door in our own UI, (2) show DeepWell's seat
 * cap next to Clerk's own member count since Clerk has no concept of our
 * plan limits, and (3) give a non-admin a read-only view instead of the
 * management UI (Clerk's own permission system would likely hide the
 * invite/remove controls for a plain "member" anyway, but this doesn't rely
 * on that — a member here never even mounts <OrganizationProfile />).
 *
 * Matches the dw-* design tokens (CSS variables in src/index.css) rather
 * than hardcoding light/dark colors, so it tracks Truck view automatically.
 */
const clerkAppearance = {
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none border-0',
    card: 'w-full shadow-none border-0',
  },
  variables: {
    colorPrimary: '#0D3827',
    colorBackground: 'var(--dw-surface)',
    colorText: 'var(--dw-ink)',
    colorTextSecondary: 'var(--dw-ink-2)',
    colorInputBackground: 'var(--dw-bg)',
    colorInputText: 'var(--dw-ink)',
    colorNeutral: 'var(--dw-ink-3)',
    borderRadius: '8px',
  },
} as const;

/**
 * Admin-only "Settings" — the warranty-digest email toggle
 * (handoffs/NOTIFICATIONS.md) and the whole-shop data export
 * (api/_lib/routes/tenant-export.js), combined into one collapsed-by-default
 * card instead of two always-open ones (round 17, U2 top fix #3).
 *
 * These are account-lifecycle settings, not a "team" feature and not an
 * "answer quality" one (see DonovanScreen.tsx) — Billing/Settings is their
 * real long-term home (the owner brief's own wording), but BillingScreen.tsx
 * isn't a file this round's UX-D2 pass owns (see R17_CONTRACT.md's file
 * split), so it stays here for now, under its own clearly-separated
 * "Settings" heading rather than mixed into Team's people/seats content.
 * HOOK FOR THE LEAD (small, optional): this component is self-contained —
 * moving it is `import { AccountSettingsCard } from '../screens/TeamScreen'`
 * (export it) into BillingScreen.tsx and dropping this section + that export
 * from here.
 */
function AccountSettingsCard() {
  const [open, setOpen] = useState(false);
  const [emailDigest, setEmailDigestState] = useState<boolean | null>(null);
  const [savingDigest, setSavingDigest] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    fetchNotifications()
      .then((res) => setEmailDigestState(res.emailDigest))
      .catch(() => setEmailDigestState(true)); // fail open to the default rather than showing a stuck loading state
  }, []);

  const toggleDigest = () => {
    if (emailDigest === null || savingDigest) return;
    const next = !emailDigest;
    setEmailDigestState(next);
    setSavingDigest(true);
    setEmailDigestPreference(next)
      .catch(() => setEmailDigestState(!next)) // revert on failure
      .finally(() => setSavingDigest(false));
  };

  const runExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadTenantExportJson();
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Could not download the data export.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink">Settings</span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-4 pt-1">
          <div className="space-y-2">
            <h3 className="text-body font-medium text-ink flex items-center gap-2">
              <Bell className="w-4 h-4" aria-hidden="true" /> Notifications
            </h3>
            <label className="flex items-center justify-between gap-3 py-1">
              <span className="text-body text-ink-2">Email me warranty digests</span>
              <button
                type="button"
                role="switch"
                aria-checked={emailDigest ?? false}
                disabled={emailDigest === null || savingDigest}
                onClick={toggleDigest}
                className={[
                  'relative inline-flex items-center h-6 w-11 rounded-full transition-colors duration-quick shrink-0',
                  emailDigest ? 'bg-forest-700' : 'bg-line',
                  emailDigest === null ? 'opacity-50' : '',
                ].join(' ')}
              >
                <span
                  className={[
                    'inline-block h-4 w-4 transform rounded-full bg-stone-0 transition-transform duration-quick',
                    emailDigest ? 'translate-x-6' : 'translate-x-1',
                  ].join(' ')}
                />
              </button>
            </label>
            <p className="text-caption text-ink-3">
              One email a day, only when a warranty needs attention — expired, expiring soon, or a registration
              window closing.
            </p>
          </div>

          <div className="space-y-2 pt-2 border-t border-line">
            <h3 className="text-body font-medium text-ink">Your data</h3>
            <p className="text-caption text-ink-3">
              Download every document, extraction, customer/unit record and audit-log entry this shop has on file,
              as one JSON file.
            </p>
            <button type="button" className="dw-btn-secondary shrink-0" disabled={exporting} onClick={() => void runExport()}>
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Download data export (JSON)
            </button>
            {exportError && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{exportError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function TeamScreen() {
  const { orgRole } = useAuth();
  const admin = isAdminRole(orgRole ?? null);
  // Only a non-admin needs the paginated memberships list fetched here — an
  // admin gets it for free inside <OrganizationProfile />'s own Members tab.
  const { organization, isLoaded, memberships } = useOrganization(admin ? undefined : { memberships: { pageSize: 50 } });
  const billingStatus = useAppStore((s) => s.billingStatus);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const cap = billingStatus?.limits?.technicians ?? null;

  // Defensive fallback: App.tsx already gates on `orgId` before this screen
  // can render, so `organization` should always be set here — this only
  // covers the brief instant Clerk's org object hasn't hydrated yet.
  if (isLoaded && !organization) {
    return (
      <AppShell>
        <div className="max-w-md mx-auto dw-card p-6 space-y-4">
          <p className="text-body text-ink-2">Create your shop to invite your team.</p>
          <CreateOrganization hideSlug afterCreateOrganizationUrl="/app/" appearance={clerkAppearance} />
        </div>
      </AppShell>
    );
  }

  const count = organization?.membersCount ?? 0;
  const pending = organization?.pendingInvitationsCount ?? 0;
  const seats = seatStatus(count, cap);

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-h2 flex items-center gap-2">
            <Users className="w-5 h-5" aria-hidden="true" />
            Team
          </h1>
          <span className={seats.atCap ? 'dw-pill-warn' : 'dw-pill-muted'}>
            {seats.label}
            {pending > 0 ? ` · ${pending} pending invite${pending === 1 ? '' : 's'}` : ''}
          </span>
        </div>

        <PhoneAppCard />

        {admin && <FollowupsCard />}

        {/* Round 17 (U2 top fix #3): Team used to carry 7 stacked cards —
            Donovan misses/learning and Search by meaning moved to their own
            "Donovan" destination (account row, admin-only — see
            AppShell.tsx/DonovanScreen.tsx: answer quality isn't a people/seats
            concern), and Possible duplicate customers folded into the
            Customers tab (CustomersScreen.tsx: it already had a related,
            tighter duplicate check right there). Team now keeps only what is
            actually about the team: the phone-app install card, follow-ups,
            and — below — invites/seats/roles. Settings (notifications +
            data export) stays here too, in its own separated, collapsed
            section, until it has a Billing/Settings home this pass doesn't
            own (see AccountSettingsCard's file comment). */}
        {admin && <AccountSettingsCard />}

        {admin && seats.atCap && (
          <div role="alert" className="dw-card border-warn/40 px-4 py-3 text-warn-ink flex items-center justify-between gap-3 flex-wrap">
            <span>You&apos;re at your plan&apos;s seat limit ({seats.label}). Upgrade to invite more technicians.</span>
            <button type="button" onClick={() => setCurrentScreen('billing')} className="underline font-medium shrink-0">
              Go to Billing
            </button>
          </div>
        )}

        {admin ? (
          <>
            <p className="text-caption text-ink-3">
              Clerk sends the invite email and handles sign-up — anyone who accepts lands in this shop with the
              role you pick below, not their own separate account. The seat count above is DeepWell&apos;s plan
              limit; Clerk itself does not enforce it, so it is still possible to invite past it here.
            </p>
            <div className="dw-card p-1 sm:p-3 overflow-hidden">
              <OrganizationProfile appearance={clerkAppearance} />
            </div>
          </>
        ) : (
          <div className="dw-card p-4">
            <p className="text-body text-ink-2 mb-3">Members of {organization?.name ?? 'this shop'}:</p>
            <ul className="divide-y divide-line">
              {(memberships?.data ?? []).map((m) => (
                <li key={m.id} className="py-2 flex items-center justify-between gap-2">
                  <span className="text-body">{memberDisplayName(m)}</span>
                  <span className={isAdminRole(m.role) ? 'dw-pill-info' : 'dw-pill-muted'}>{isAdminRole(m.role) ? 'Admin' : 'Member'}</span>
                </li>
              ))}
            </ul>
            {!memberships?.data?.length && <p className="text-caption text-ink-3">No members yet.</p>}
          </div>
        )}
      </div>
    </AppShell>
  );
}
