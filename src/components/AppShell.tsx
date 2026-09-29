import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { AlertTriangle, CreditCard, Database, Inbox, LayoutDashboard, Sparkles, Sun, Moon, LogOut, Globe, Users, Smartphone, X } from 'lucide-react';
import { AskMark } from './AskMark';
import { OrganizationSwitcher, useAuth, useClerk } from '@clerk/clerk-react';
import { Wordmark } from './Wordmark';
import { useAppStore, selectIngestProgress, type Screen } from '../store/appStore';
import { billingBannerFor } from '../services/billingClient';
import { isAdminRole } from '../services/teamClient';
import { NotificationsPanel } from './NotificationsPanel';
import { useGraph } from '../core/entityGraph';
import { needsPersonCount } from '../screens/ReviewScreen';
import { CommandPalette } from './command/CommandPalette';

// Lazy — same reasoning as App.tsx's WarrantyExportScreen/OutreachScreen:
// this is an admin-only destination most sessions never open, and it pulls
// in DonovanLearningCard (the heaviest of the three cards it hosts), so it
// must not sit in AppShell's own bundle — AppShell wraps every screen,
// including AskScreen, the one screen that stays eager for startup speed.
const DonovanScreen = lazy(() => import('../screens/DonovanScreen').then((m) => ({ default: m.DonovanScreen })));

interface NavItem {
  screen: Screen;
  label: string;
  icon: ComponentType<{ className?: string; active?: boolean }>;
  /** Screens that should light up this nav item */
  matches: Screen[];
}

// Exactly four primary destinations — Ask, Dashboard, Inbox, Records. Browse
// merged into Records (as its Documents/Customers/Grid/Graph tabs — round 17
// folded the old standalone Search tab into ⌘K and the Documents/Customers
// tabs' own search boxes instead, see BrowseScreen.tsx); the old standalone
// Records screen's health metrics moved into Dashboard's "Data health"
// strip; 'review' and 'records' are retired ids kept as aliases (see
// store/appStore.ts) so they still light up the right item here.
export const NAV: NavItem[] = [
  { screen: 'ask', label: 'Ask', icon: AskMark, matches: ['ask', 'entity'] },
  { screen: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, matches: ['dashboard', 'warranty-export', 'records'] },
  { screen: 'ingest', label: 'Inbox', icon: Inbox, matches: ['ingest', 'review'] },
  { screen: 'browse', label: 'Records', icon: Database, matches: ['browse', 'customer'] },
];

interface AppShellProps {
  children: ReactNode;
  /** Narrow, single-column layout (Ask, entity pages). Default is the 1200px content width. */
  width?: 'ask' | 'content';
}

export function AppShell({ children, width = 'content' }: AppShellProps) {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const fieldMode = useAppStore((s) => s.fieldMode);
  const setFieldMode = useAppStore((s) => s.setFieldMode);
  const ingestProgress = useAppStore(selectIngestProgress);
  const billingStatus = useAppStore((s) => s.billingStatus);
  const banner = billingBannerFor(billingStatus);
  const { signOut } = useClerk();
  const { orgRole } = useAuth();
  const isAdmin = isAdminRole(orgRole ?? null);
  const [donovanOpen, setDonovanOpen] = useState(false);

  // Inbox nav badge (round 17, U2 top fix #8): one number, always visible,
  // for "is there open intake work" — no click required to find out. Same
  // `isAttention` rule ReviewScreen's own "Needs a person" chip and
  // DataHealthStrip's tile already use (needsPersonCount), so this can never
  // disagree with what Inbox itself shows once you're in it.
  const docs = useGraph((s) => s.docs);
  const inboxBadge = needsPersonCount(docs);

  // HARD GATE (owner decision, 2026-09-21): a tenant App.tsx has routed into
  // the paywall (billingStatus 'none' or 'canceled') gets a stripped-down
  // shell here too — no Ask/Dashboard/Inbox/Records nav, no ingest pill, no
  // notifications, no billing banner (BillingScreen already says it all) —
  // just the brand mark, Billing, Team (admin-only, unchanged), field mode,
  // the org switcher (so a person in more than one shop can switch to one
  // that IS subscribed without signing all the way out), and Sign out. Derived
  // straight from the store rather than a prop so every screen App.tsx can
  // render while gated (Billing, Team) gets the same restricted shell for
  // free.
  const billingGateActive = !!billingStatus && (billingStatus.status === 'none' || billingStatus.status === 'canceled');

  // The one-line sub-bar shown below `sm`, so a phone-width session always
  // has a legible label for the active screen instead of relying on the
  // underline-only active state in the icon-only nav row above it.
  // While the billing gate is active the screen shown is Billing (or Team) whatever `currentScreen` still
  // says — App.tsx falls back to Billing — so label what is actually on screen, not the stale 'Ask'.
  const activeLabel = billingGateActive
    ? currentScreen === 'team'
      ? 'Team'
      : 'Billing'
    : NAV.find((item) => item.matches.includes(currentScreen))?.label;

  return (
    <div className="min-h-screen flex flex-col bg-bg text-ink">
      <a href="#main" className="dw-skip-link">
        Skip to main content
      </a>

      <header className="relative sm:sticky sm:top-0 z-40 bg-forest-700 text-stone-0 border-b border-forest-800">
        <div className="max-w-content mx-auto px-3 lg:px-6 min-h-14 sm:min-h-16 flex flex-wrap xl:flex-nowrap items-center gap-x-0.5 lg:gap-x-4 gap-y-0">
          <button
            type="button"
            onClick={() => setCurrentScreen('ask')}
            className="flex items-center min-h-touch rounded-md -ml-1 focus-visible:outline-brass-300"
            aria-label="DeepWell Technology home"
          >
            <Wordmark />
          </button>

          {!billingGateActive && ingestProgress && (
            <button
              type="button"
              onClick={() => setCurrentScreen('ingest')}
              className="inline-flex items-center gap-1.5 min-h-touch px-2 sm:px-3 rounded-md text-caption sm:text-body text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300 whitespace-nowrap"
            >
              <Inbox className="w-4 h-4 shrink-0" aria-hidden="true" />
              {ingestProgress.stalled
                ? `Still working on ${ingestProgress.total - ingestProgress.current} — check Inbox`
                : `Processing ${ingestProgress.current} of ${ingestProgress.total}…`}
            </button>
          )}

          {!billingGateActive && (
            <nav aria-label="Primary" className="ml-auto flex items-center gap-0.5 sm:gap-1">
              {NAV.map(({ screen, label, icon: Icon, matches }) => {
                const active = matches.includes(currentScreen);
                return (
                  <button
                    key={screen}
                    type="button"
                    onClick={() => setCurrentScreen(screen)}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 lg:px-3 rounded-md text-body-lg font-medium transition-colors duration-quick whitespace-nowrap focus-visible:outline-brass-300',
                      active
                        ? 'text-stone-0 shadow-[inset_0_-2px_0_0_#C99C5C]'
                        : 'text-forest-100 hover:text-stone-0 hover:bg-forest-800',
                    ].join(' ')}
                  >
                    {/* Only AskMark's svg reads `active` (for its ripple) - lucide's icon
                        components forward unrecognized props straight to the DOM <svg>,
                        so passing `active` to them warned "Received `false` for a
                        non-boolean attribute `active`" every render. */}
                    {Icon === AskMark ? (
                      <Icon className="w-[18px] h-[18px]" active={active} />
                    ) : (
                      <Icon className="w-[18px] h-[18px]" />
                    )}
                    <span className="hidden lg:inline">{label}</span>
                    <span className="sr-only lg:hidden">{label}</span>
                    {screen === 'ingest' && inboxBadge > 0 && (
                      <span
                        className={[
                          'inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-caption font-mono leading-none',
                          active ? 'bg-brass-300 text-forest-950' : 'bg-forest-800 text-forest-100',
                        ].join(' ')}
                        aria-hidden="true"
                      >
                        {inboxBadge > 99 ? '99+' : inboxBadge}
                      </span>
                    )}
                    {screen === 'ingest' && inboxBadge > 0 && <span className="sr-only">, {inboxBadge} need your attention</span>}
                  </button>
                );
              })}
            </nav>
          )}

          {/* "Website" (the marketing site) is not a task inside the product
              for a signed-in user, so it lives in the footer, not this row —
              see the footer below. */}

          {/* Bell, next to Billing — see NotificationsPanel.tsx. Hidden while
              gated: notifications reference records a paywalled tenant has
              no access to. */}
          {!billingGateActive && <NotificationsPanel />}

          {/* Billing lives in the account area, not the primary nav — it's
              not one of the four destinations NAV enumerates above.
              Pushed to the far right with ml-auto when the primary nav
              above it is hidden (gated), same as it would sit after NAV
              otherwise. */}
          <button
            aria-label="Billing"
            type="button"
            onClick={() => setCurrentScreen('billing')}
            aria-current={currentScreen === 'billing' ? 'page' : undefined}
            className={[
              'inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300',
              billingGateActive ? 'ml-auto' : '',
            ].join(' ')}
          >
            <CreditCard className="w-5 h-5" aria-hidden="true" />
            <span className="hidden lg:inline text-body">Billing</span>
          </button>

          {/* Team (invite/manage members) — admin-only in the UI. A member
              still has read-only access if they navigate here directly (see
              TeamScreen.tsx), but nothing surfaces the destination to them
              here, same reasoning as Billing living outside the primary nav. */}
          {isAdmin && (
            <button
              aria-label="Team"
              type="button"
              onClick={() => setCurrentScreen('team')}
              aria-current={currentScreen === 'team' ? 'page' : undefined}
              className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
            >
              <Users className="w-5 h-5" aria-hidden="true" />
              <span className="hidden lg:inline text-body">Team</span>
            </button>
          )}

          {/* Donovan (answer quality: misses, learning, search-by-meaning) —
              admin/operator-only, same gate as Team. Round 17 split: used to
              be 3 of Team's 7 stacked cards; this is their new, obvious home,
              one click from the same account row Team and Billing live in
              (not buried inside Team's own scroll). Opens as an overlay —
              see DonovanScreen.tsx's file comment for why. */}
          {isAdmin && !billingGateActive && (
            <button
              aria-label="Donovan"
              type="button"
              onClick={() => setDonovanOpen(true)}
              className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
            >
              <Sparkles className="w-5 h-5" aria-hidden="true" />
              <span className="hidden lg:inline text-body">Donovan</span>
            </button>
          )}

          <button
            type="button"
            role="switch"
            aria-checked={fieldMode}
            aria-label={fieldMode ? 'Field view on. Switch to Office view' : 'Office view on. Switch to Field view'}
            title={fieldMode ? 'Field view: light, larger type for outdoors. Click for Office view.' : 'Office view: dark. Click for Field view (light, larger type).'}
            onClick={() => setFieldMode(!fieldMode)}
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            {fieldMode ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            <span className="hidden lg:inline text-body">{fieldMode ? 'Field view' : 'Office view'}</span>
          </button>

          {/* A tech who works two shops switches their active org here — the
              app re-derives its tenant from Clerk's orgId the moment this
              changes (src/App.tsx, usePostgresSync's tenantKey), same as
              signing into a different account would. hidePersonal: DeepWell
              has no "personal" tenant concept in the UI — a user with no
              shop sees OnboardingScreen instead of ever reaching this menu. */}
          <OrganizationSwitcher
            hidePersonal
            afterSelectOrganizationUrl="/app/"
            appearance={{
              elements: {
                organizationSwitcherTrigger: 'text-forest-100 hover:text-stone-0 rounded-md px-2 min-h-touch focus-visible:outline-brass-300',
                organizationPreviewMainIdentifier: 'text-forest-100',
                organizationSwitcherTriggerIcon: 'text-forest-100',
              },
            }}
          />

          <button
            type="button"
            onClick={() => { void signOut({ redirectUrl: '/app/' }); }}
            aria-label="Sign out"
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            <LogOut className="w-5 h-5" aria-hidden="true" />
            <span className="hidden lg:inline text-body">Sign out</span>
          </button>
        </div>
      </header>

      {activeLabel && (
        <div className="lg:hidden bg-surface-2 border-b border-line px-4 py-1.5 text-caption text-ink-2 font-medium">
          {activeLabel}
        </div>
      )}

      {/* Global billing banner: trial countdown or a failed payment. Hidden
          on Billing itself (the person is already looking at the answer)
          and while the hard gate is active — BillingScreen's own gated
          headline already says everything this banner would. */}
      {banner && currentScreen !== 'billing' && !billingGateActive && (
        <button
          type="button"
          onClick={() => setCurrentScreen('billing')}
          className={[
            'w-full text-left px-4 sm:px-6 py-2 flex items-center gap-2 text-body transition-colors duration-quick',
            banner.kind === 'past_due' || banner.kind === 'cap' || banner.kind === 'asks_warn' || banner.kind === 'asks_exhausted'
              ? 'bg-warn-bg text-warn-ink hover:brightness-95'
              : 'bg-info-bg text-info-ink hover:brightness-95',
          ].join(' ')}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="max-w-content mx-auto w-full flex items-center gap-2">
            {banner.message} <span className="underline font-medium">Go to Billing</span>
          </span>
        </button>
      )}

      <PhoneBanner />

      <main
        id="main"
        tabIndex={-1}
        className={[
          'flex-1 w-full mx-auto px-4 sm:px-6 py-6 sm:py-10 focus:outline-none',
          width === 'ask' ? 'max-w-ask' : 'max-w-content',
        ].join(' ')}
      >
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="max-w-content mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-caption text-ink-3">
          <span>DeepWell Technology · Knowledge Builds Business.</span>
          <span className="flex items-center gap-4">
            <span>Every answer shows its source.</span>
            <a href="/get" target="_blank" rel="noopener" className="inline-flex items-center gap-1 hover:text-ink-2 transition-colors duration-quick">
              <Smartphone className="w-3.5 h-3.5" aria-hidden="true" /> Phone app
            </a>
            <a href="/" className="inline-flex items-center gap-1 hover:text-ink-2 transition-colors duration-quick">
              <Globe className="w-3.5 h-3.5" aria-hidden="true" /> Website
            </a>
          </span>
        </div>
      </footer>

      {!billingGateActive && <CommandPalette isAdmin={isAdmin} onOpenDonovan={() => setDonovanOpen(true)} />}

      {donovanOpen && (
        <Suspense fallback={<div className="fixed inset-0 z-40 bg-bg" aria-busy="true" />}>
          <DonovanScreen onClose={() => setDonovanOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/**
 * A phone that opens the desktop app (for example from a Clerk invite email)
 * gets a one-line nudge to DeepWell Mobile, which is built for that screen.
 * Touch + narrow only; dismissal is remembered on this device.
 */
const PHONE_BANNER_KEY = 'deepwell.app.phoneBanner';

function PhoneBanner() {
  const [show, setShow] = useState(() => {
    try {
      if (localStorage.getItem(PHONE_BANNER_KEY) === 'off') return false;
      return window.matchMedia('(pointer: coarse) and (max-width: 767px)').matches;
    } catch {
      return false;
    }
  });
  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(PHONE_BANNER_KEY, 'off');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="bg-info-bg text-info-ink text-body">
      <div className="max-w-content mx-auto pl-4 pr-1 flex items-center gap-2">
        <Smartphone className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 py-2">On a phone? DeepWell Mobile is built for it.</span>
        <a href="/m/?install=1" className="min-h-touch inline-flex items-center px-2 font-semibold underline">
          Open
        </a>
        <button type="button" onClick={dismiss} aria-label="Dismiss" className="min-h-touch min-w-touch inline-flex items-center justify-center">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
