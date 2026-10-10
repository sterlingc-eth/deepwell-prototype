import { DonovanSharingCard } from '../components/DonovanSharingCard';
import { useEffect, useState } from 'react';
import { CreateOrganization, OrganizationProfile, useAuth, useOrganization } from '@clerk/clerk-react';
import { Bell, ChevronDown, ChevronUp, Clock, Download, History, Loader2, ShieldAlert, ShieldCheck, Trash2, Users } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { useAppStore } from '../store/appStore';
import { isAdminRole, seatStatus, type SeatStatus } from '../services/teamClient';
import { billingClient, BillingApiError, type SeatsView } from '../services/billingClient';
import { fetchNotifications, setDigestMutedPreference, setEmailDigestPreference } from '../services/notifyClient';
import { deleteShopData, downloadTenantExportJson } from '../services/exportClient';
import { memberDisplayName } from '../core/memberNames';
import { FollowupsCard } from '../components/FollowupsCard';
import { PhoneAppCard } from '../components/PhoneAppCard';
import { DataExportButtons } from '../components/records/DataExportButtons';
import { AccountFilesExport } from '../components/records/AccountFilesExport';
import { SUPPORT_ACCESS_CHANGED } from '../services/supportClient';
import { reviewClient, type StaffAccessLogEntry, type SupportAccessGrant } from '../services/reviewClient';

/**
 * Team screen (handoffs/ORG_INVITES_AUDIT.md): Clerk's own
 * `<OrganizationProfile />` IS the invite/manage UI — it sends the invite
 * email, hosts the invitee's sign-up, and is the source of truth for who's
 * in the org and what role they hold. This screen's job is only to (1) put
 * that behind an admin-only door in our own UI, (2) show DeepWell's login
 * usage ("3 of 5 logins used (owner not counted)", computed server-side) and enforce
 * the plan's cap through our own seat-guarded invite form, and (3) give a non-admin a read-only view instead of the
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
    // Round 26: invites go through our own seat-guarded form (InviteForm below → POST /api/billing?action=invite),
    // which counts pending invites and refuses past the plan's login cap. Clerk's own invite button would bypass it.
    membersPageInviteButton: { display: 'none' },
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
function AccountSettingsCard({ tenantId, shopName }: { tenantId: string | null; shopName: string }) {
  const [open, setOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [emailDigest, setEmailDigestState] = useState<boolean | null>(null);
  const [savingDigest, setSavingDigest] = useState(false);
  const [digestMuted, setDigestMutedState] = useState<boolean | null>(null);
  const [savingMute, setSavingMute] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    fetchNotifications()
      .then((res) => {
        setEmailDigestState(res.emailDigest);
        setDigestMutedState(res.digestMuted ?? false);
      })
      .catch(() => {
        // fail open to the defaults rather than showing a stuck loading state
        setEmailDigestState(true);
        setDigestMutedState(false);
      });
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

  const toggleMute = () => {
    if (digestMuted === null || savingMute) return;
    const next = !digestMuted;
    setDigestMutedState(next);
    setSavingMute(true);
    setDigestMutedPreference(next)
      .catch(() => setDigestMutedState(!next)) // revert on failure
      .finally(() => setSavingMute(false));
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
              <span className="text-body text-ink-2">Send the company&apos;s daily warranty digest (every admin)</span>
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
              One email a day to the company&apos;s admins, only when a warranty needs attention — expired, expiring soon,
              or a registration window closing. This switch is for the whole company.
            </p>
            <label className="flex items-center justify-between gap-3 py-1 min-h-[44px]">
              <span className="text-body text-ink-2">Mute my daily digest</span>
              <button
                type="button"
                role="switch"
                aria-checked={digestMuted ?? false}
                aria-label="Mute my daily digest"
                data-testid="mute-my-digest"
                disabled={digestMuted === null || savingMute}
                onClick={toggleMute}
                className={[
                  'relative inline-flex items-center h-6 w-11 rounded-full transition-colors duration-quick shrink-0',
                  digestMuted ? 'bg-forest-700' : 'bg-line',
                  digestMuted === null ? 'opacity-50' : '',
                ].join(' ')}
              >
                <span
                  className={[
                    'inline-block h-4 w-4 transform rounded-full bg-stone-0 transition-transform duration-quick',
                    digestMuted ? 'translate-x-6' : 'translate-x-1',
                  ].join(' ')}
                />
              </button>
            </label>
            <p className="text-caption text-ink-3">
              Stops the digest email for you only. Other admins still get it. Only admins receive the digest, so
              members have nothing to mute.
            </p>
          </div>

          <div className="space-y-2 pt-2 border-t border-line">
            <h3 className="text-body font-medium text-ink">Donovan</h3>
            <DonovanSharingCard />
          </div>

          <div className="space-y-2 pt-2 border-t border-line">
            <h3 className="text-body font-medium text-ink">Your data</h3>
            <p className="text-caption text-ink-3">
              Download every document, extraction, customer/unit record and audit-log entry this company has on file,
              as one JSON file.
            </p>
            <button type="button" className="dw-btn-secondary shrink-0" disabled={exporting} onClick={() => void runExport()}>
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Download data export (JSON)
            </button>
            {exportError && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{exportError}</p>}
            <p className="text-caption text-ink-3">Or as spreadsheets:</p>
            <DataExportButtons />
          </div>

          <div className="space-y-2 pt-2 border-t border-line">
            <AccountFilesExport />
          </div>

          {/* R25: self-serve deletion (promised on /security). Typed confirmation here; the server
              independently requires the caller's own tenant id and admin role. */}
          <div className="space-y-2 pt-2 border-t border-line">
            <h3 className="text-body font-medium text-ink flex items-center gap-2">
              <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete this company
            </h3>
            <p className="text-caption text-ink-3">
              Cancels your subscription and permanently deletes every document, file, customer record and answer
              history for this company. This can't be undone — download the export above first.
            </p>
            {!deleteOpen ? (
              <button type="button" className="dw-btn-secondary shrink-0" onClick={() => setDeleteOpen(true)} disabled={!tenantId}>
                Delete company data…
              </button>
            ) : (
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!tenantId || deleteTyped.trim() !== shopName.trim() || deleting) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await deleteShopData(tenantId);
                    window.location.assign('/?deleted=1');
                  } catch (err) {
                    setDeleteError(err instanceof Error ? err.message : 'Could not delete the company. Nothing was deleted — try again.');
                    setDeleting(false);
                  }
                }}
              >
                <label htmlFor="dw-delete-confirm" className="block text-caption text-ink-2">
                  Type <strong className="text-ink">{shopName}</strong> to confirm
                </label>
                <input
                  id="dw-delete-confirm"
                  value={deleteTyped}
                  onChange={(e) => setDeleteTyped(e.target.value)}
                  autoComplete="off"
                  className="w-full min-h-touch rounded-md border border-line-2 bg-surface px-3 text-ink"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={deleting || deleteTyped.trim() !== shopName.trim()}
                    className="dw-btn-secondary shrink-0 text-bad border-bad disabled:opacity-50"
                  >
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />} Permanently delete
                  </button>
                  <button type="button" className="dw-btn-secondary shrink-0" onClick={() => { setDeleteOpen(false); setDeleteTyped(''); setDeleteError(null); }}>
                    Cancel
                  </button>
                </div>
                {deleteError && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{deleteError}</p>}
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** en-US, minute precision — an expiry/access-log timestamp people are deciding "is this still
 *  active" or "did I recognize this" from, not just a calendar date. */
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Round 22 (S2, privacy) — "Support access" + "Access log", the tenant-facing half of
 * api/_lib/privacy/supportAccess.js: an admin GRANTS DeepWell staff time-boxed, revocable access to
 * this shop's own documents/misses/learning data (never on by default), and can always see every
 * staff access to it — granted or "break-glass" emergency — in the log below. Same collapsed-by-
 * default dw-card shape as AccountSettingsCard right above it, and admin-only for the same reason:
 * this is an account-lifecycle/trust setting, not a people/seats one.
 */
export function SupportAccessCard({ companyName }: { companyName?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<SupportAccessGrant | null>(null);
  const [log, setLog] = useState<StaffAccessLogEntry[] | null>(null);
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const refresh = () => {
    setLoading(true);
    setError(null);
    Promise.all([reviewClient.supportAccessStatus(), reviewClient.supportAccessLog({ limit: 50 })])
      .then(([status, logRes]) => {
        setActive(status.active);
        setLog(logRes.items);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load support access.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    // A grant made (or ended) from the Help chat or the banner shows here right away.
    window.addEventListener(SUPPORT_ACCESS_CHANGED, refresh);
    return () => window.removeEventListener(SUPPORT_ACCESS_CHANGED, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      await reviewClient.supportAccessGrant({ hours, reason: reason.trim() || undefined, companyName });
      setReason('');
      window.dispatchEvent(new Event(SUPPORT_ACCESS_CHANGED));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await reviewClient.supportAccessRevoke(active.id);
      window.dispatchEvent(new Event(SUPPORT_ACCESS_CHANGED));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Support access
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-4 pt-1">
          <p className="text-caption text-ink-3">
            By default, DeepWell staff cannot look at this company&apos;s documents, answers, or learning data. Grant
            time-boxed access below when you want help from support — it expires on its own, or you can revoke it
            any time. Every staff access is recorded in the Access log below, including any emergency access.
          </p>

          {loading && !active && !log ? (
            <p className="text-caption text-ink-3 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading…</p>
          ) : active ? (
            <div className="dw-card bg-forest-50 dark:bg-forest-900/20 border-forest-700/30 p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 mt-0.5 shrink-0 text-forest-700" aria-hidden="true" />
                <div>
                  <p className="text-body text-ink">Access active until {fmtDateTime(active.expires_at)}</p>
                  {active.reason && <p className="text-caption text-ink-3">Reason: {active.reason}</p>}
                </div>
              </div>
              <button type="button" className="dw-btn-secondary shrink-0" disabled={busy} onClick={() => void revoke()}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} Revoke now
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-body text-ink-2" htmlFor="support-access-hours">Grant for</label>
                <select
                  id="support-access-hours"
                  className="dw-input w-auto"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                >
                  <option value={24}>24 hours</option>
                  <option value={72}>72 hours</option>
                  <option value={168}>7 days</option>
                </select>
                <input
                  type="text"
                  className="dw-input flex-1 min-w-[10rem]"
                  placeholder="Reason (optional) — e.g. helping debug a missing invoice"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                />
              </div>
              <button type="button" className="dw-btn-primary" disabled={busy} onClick={() => void grant()}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4" aria-hidden="true" />} Grant support access
              </button>
            </div>
          )}

          {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}

          <div className="pt-2 border-t border-line">
            <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setShowLog((v) => !v)}>
              <span className="text-body font-medium text-ink flex items-center gap-2">
                <History className="w-4 h-4" aria-hidden="true" /> Access log{log ? ` (${log.length})` : ''}
              </span>
              {showLog ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
            </button>
            {showLog && (
              <ul className="divide-y divide-line mt-2">
                {(log ?? []).map((row) => (
                  <li key={row.id} className="py-2 flex items-start justify-between gap-2">
                    <div>
                      <p className="text-body text-ink">
                        {row.action}
                        {row.is_emergency && (
                          <span className="dw-pill-warn ml-2 inline-flex items-center gap-1">
                            <ShieldAlert className="w-3 h-3" aria-hidden="true" /> emergency
                          </span>
                        )}
                      </p>
                      <p className="text-caption text-ink-3">
                        {fmtDateTime(row.created_at)}
                        {row.record_count != null ? ` · ${row.record_count} record${row.record_count === 1 ? '' : 's'}` : ''}
                      </p>
                      {row.emergency_reason && <p className="text-caption text-ink-3">Reason: {row.emergency_reason}</p>}
                    </div>
                  </li>
                ))}
                {log && log.length === 0 && <p className="text-caption text-ink-3 py-2">No staff access recorded yet.</p>}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Round 26: the seat-guarded invite form. Disabled at/over the plan's login cap with an upgrade message; the
 * server (api/_lib/seats.js guardedInvite) re-checks live, so a stale count here can never over-invite.
 */
function InviteForm({ seats, onInvited }: { seats: SeatStatus; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const blocked = seats.atCap;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await billingClient.invite(email.trim(), role);
      setMessage({ ok: true, text: `Invite sent to ${email.trim()}.` });
      setEmail('');
      onInvited();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof BillingApiError || err instanceof Error ? err.message : 'Could not send that invite.' });
      if (err instanceof BillingApiError && err.status === 402) onInvited();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="dw-card p-4 space-y-3" aria-labelledby="invite-heading">
      <h2 id="invite-heading" className="text-h3">Invite someone</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="dw-label block mb-1.5">Email</span>
          <input
            type="email"
            required
            className="dw-input w-64"
            value={email}
            disabled={blocked}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
          />
        </label>
        <label className="block">
          <span className="dw-label block mb-1.5">Role</span>
          <select className="dw-input" value={role} disabled={blocked} onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit" className="dw-btn-primary" disabled={blocked || busy || !email.trim()}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Send invite
        </button>
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-caption text-ink-2' : 'text-caption text-bad-ink'}>
          {message.text}
        </p>
      )}
    </form>
  );
}

export function TeamScreen() {
  const { orgRole, orgId } = useAuth();
  const admin = isAdminRole(orgRole ?? null);
  // Only a non-admin needs the paginated memberships list fetched here — an
  // admin gets it for free inside <OrganizationProfile />'s own Members tab.
  const { organization, isLoaded, memberships } = useOrganization(admin ? undefined : { memberships: { pageSize: 50 } });
  const billingStatus = useAppStore((s) => s.billingStatus);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const planCap = billingStatus?.limits?.logins ?? null;
  // Server-computed login usage (owner excluded; extra admins + pending invites counted). Admin-only endpoint; it
  // also lazily syncs the Clerk org's member limit. null until loaded / if Clerk is unreachable.
  const [seatsView, setSeatsView] = useState<SeatsView | null>(null);
  const [seatsTick, setSeatsTick] = useState(0);
  const refreshSeats = () => setSeatsTick((n) => n + 1);
  useEffect(() => {
    if (!admin) return;
    let live = true;
    billingClient
      .seats()
      .then((r) => { if (live) setSeatsView(r.seats); })
      .catch(() => { if (live) setSeatsView(null); });
    return () => { live = false; };
  }, [admin, orgId, seatsTick]);

  // Defensive fallback: App.tsx already gates on `orgId` before this screen
  // can render, so `organization` should always be set here — this only
  // covers the brief instant Clerk's org object hasn't hydrated yet.
  if (isLoaded && !organization) {
    return (
      <AppShell>
        <div className="max-w-md mx-auto dw-card p-6 space-y-4">
          <p className="text-body text-ink-2">Create your company to invite your team.</p>
          <CreateOrganization hideSlug afterCreateOrganizationUrl="/app/" appearance={clerkAppearance} />
        </div>
      </AppShell>
    );
  }

  const membersCount = organization?.membersCount ?? 0;
  const pendingInvites = organization?.pendingInvitationsCount ?? 0;
  // Fallback while the server count is unavailable: everyone but the owner (approx.) + pending invites.
  const used = seatsView?.used ?? Math.max(0, membersCount - 1) + pendingInvites;
  const seats = seatStatus(used, seatsView ? seatsView.cap : planCap);
  const pending = seatsView?.pending ?? pendingInvites;

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-h2 flex items-center gap-2">
            <Users className="w-5 h-5" aria-hidden="true" />
            Team
          </h1>
          <span className={seats.atCap ? 'dw-pill-warn' : 'dw-pill-muted'}>
            {admin ? seats.label : `${membersCount} member${membersCount === 1 ? '' : 's'}`}
            {admin && pending > 0 ? ` · ${pending} pending invite${pending === 1 ? '' : 's'}` : ''}
          </span>
        </div>

        {admin && seats.atCap && (
          <div role="alert" className="dw-card border-warn/40 px-4 py-3 text-warn-ink dark:text-brass-200 flex items-center justify-between gap-3 flex-wrap">
            <span>
              {seats.overCap
                ? `Your team is over your plan's login limit: ${seats.label}. Nobody is locked out, but new invites are paused until you're under the limit or upgrade.`
                : `You've reached your plan's login limit: ${seats.label}. Upgrade to invite more people.`}
            </span>
            <button type="button" onClick={() => setCurrentScreen('billing')} className="underline font-medium shrink-0">
              Go to Billing
            </button>
          </div>
        )}

        {admin ? (
          <>
            {/* R36: inviting is the one job of this screen for an admin, so the form leads (it used to sit below the
                phone-app card and three collapsed sections). The seat-limit notice above it says everything the old
                in-form hint and the "Your plan includes…" sentence repeated. */}
            <InviteForm seats={seats} onInvited={() => { refreshSeats(); void organization?.reload(); }} />
            <p className="text-caption text-ink-3">
              Invites are sent by email: anyone who accepts lands in this company with the role you pick. To change a role,
              remove someone or cancel an invitation, use the <strong className="text-ink-2">Members</strong> and{' '}
              <strong className="text-ink-2">Invitations</strong> tabs of the panel at the bottom of this page.
            </p>
            <PhoneAppCard />
            <FollowupsCard />
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
        <AccountSettingsCard tenantId={organization?.name ? (orgId ?? null) : null} shopName={organization?.name ?? ''} />
        <SupportAccessCard companyName={organization?.name ?? undefined} />

            <div className="dw-card p-1 sm:p-3 overflow-hidden" data-testid="team-clerk-panel">
              <OrganizationProfile appearance={clerkAppearance} />
            </div>
          </>
        ) : (
          <>
            <PhoneAppCard />
            <div className="dw-card p-4">
            <p className="text-body text-ink-2 mb-1">Members of {organization?.name ?? 'this company'}:</p>
            <p className="text-caption text-ink-3 mb-3" data-testid="team-member-help">
              Only a company admin can invite people, change roles or remove someone. Ask an admin.
            </p>
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
          </>
        )}
      </div>
    </AppShell>
  );
}
