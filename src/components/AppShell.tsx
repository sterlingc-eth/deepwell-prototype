import type { ComponentType, ReactNode } from 'react';
import { AlertTriangle, CreditCard, Database, Inbox, LayoutDashboard, Sun, Moon, LogOut, Globe, Users } from 'lucide-react';
import { AskMark } from './AskMark';
import { OrganizationSwitcher, useAuth, useClerk } from '@clerk/clerk-react';
import { Wordmark } from './Wordmark';
import { useAppStore, selectIngestProgress, type Screen } from '../store/appStore';
import { billingBannerFor } from '../services/billingClient';
import { isAdminRole } from '../services/teamClient';
import { NotificationsPanel } from './NotificationsPanel';

interface NavItem {
  screen: Screen;
  label: string;
  icon: ComponentType<{ className?: string; active?: boolean }>;
  /** Screens that should light up this nav item */
  matches: Screen[];
}

// Exactly four primary destinations — Ask, Inbox, Records, Dashboard. Browse
// merged into Records (as its Documents/Search tabs); the old standalone
// Records screen's health metrics moved into Dashboard's "Data health"
// strip; 'review' and 'records' are retired ids kept as aliases (see
// store/appStore.ts) so they still light up the right item here.
export const NAV: NavItem[] = [
  { screen: 'ask', label: 'Ask', icon: AskMark, matches: ['ask', 'entity'] },
  { screen: 'ingest', label: 'Inbox', icon: Inbox, matches: ['ingest', 'review'] },
  { screen: 'browse', label: 'Records', icon: Database, matches: ['browse', 'customer'] },
  { screen: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, matches: ['dashboard', 'warranty-export', 'records'] },
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

  // The one-line sub-bar shown below `sm`, so a phone-width session always
  // has a legible label for the active screen instead of relying on the
  // underline-only active state in the icon-only nav row above it.
  const activeLabel = NAV.find((item) => item.matches.includes(currentScreen))?.label;

  return (
    <div className="min-h-screen flex flex-col bg-bg text-ink">
      <a href="#main" className="dw-skip-link">
        Skip to main content
      </a>

      <header className="sticky top-0 z-40 bg-forest-700 text-stone-0 border-b border-forest-800">
        <div className="max-w-content mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center gap-4">
          <button
            type="button"
            onClick={() => setCurrentScreen('ask')}
            className="flex items-center min-h-touch rounded-md -ml-1 focus-visible:outline-brass-300"
            aria-label="DeepWell Technology home"
          >
            <Wordmark />
          </button>

          {ingestProgress && (
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
                    'inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 sm:px-3 rounded-md text-body-lg font-medium transition-colors duration-quick whitespace-nowrap focus-visible:outline-brass-300',
                    active
                      ? 'text-stone-0 shadow-[inset_0_-2px_0_0_#C99C5C]'
                      : 'text-forest-100 hover:text-stone-0 hover:bg-forest-800',
                  ].join(' ')}
                >
                  <Icon className="w-[18px] h-[18px]" active={active} />
                  <span className="hidden sm:inline">{label}</span>
                  <span className="sr-only sm:hidden">{label}</span>
                </button>
              );
            })}
          </nav>

          {/* "Website" (the marketing site) is not a task inside the product
              for a signed-in user, so it lives in the footer, not this row —
              see the footer below. */}

          {/* Bell, next to Billing — see NotificationsPanel.tsx. */}
          <NotificationsPanel />

          {/* Billing lives in the account area, not the primary nav — it's
              not one of the four destinations NAV enumerates above. */}
          <button
            type="button"
            onClick={() => setCurrentScreen('billing')}
            aria-current={currentScreen === 'billing' ? 'page' : undefined}
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            <CreditCard className="w-5 h-5" aria-hidden="true" />
            <span className="hidden md:inline text-body">Billing</span>
          </button>

          {/* Team (invite/manage members) — admin-only in the UI. A member
              still has read-only access if they navigate here directly (see
              TeamScreen.tsx), but nothing surfaces the destination to them
              here, same reasoning as Billing living outside the primary nav. */}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setCurrentScreen('team')}
              aria-current={currentScreen === 'team' ? 'page' : undefined}
              className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
            >
              <Users className="w-5 h-5" aria-hidden="true" />
              <span className="hidden md:inline text-body">Team</span>
            </button>
          )}

          <button
            type="button"
            role="switch"
            aria-checked={fieldMode}
            aria-label={fieldMode ? 'Truck view on. Switch to office view' : 'Truck view off. Switch to truck view'}
            onClick={() => setFieldMode(!fieldMode)}
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            {fieldMode ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            <span className="hidden md:inline text-body">Truck view</span>
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
            <span className="hidden md:inline text-body">Sign out</span>
          </button>
        </div>
      </header>

      {activeLabel && (
        <div className="sm:hidden bg-surface-2 border-b border-line px-4 py-1.5 text-caption text-ink-2 font-medium">
          {activeLabel}
        </div>
      )}

      {/* Global billing banner: trial countdown, a failed payment, or a
          never-subscribed tenant that's used up its free preview. Hidden on
          Billing itself — the person is already looking at the answer. */}
      {banner && currentScreen !== 'billing' && (
        <button
          type="button"
          onClick={() => setCurrentScreen('billing')}
          className={[
            'w-full text-left px-4 sm:px-6 py-2 flex items-center gap-2 text-body transition-colors duration-quick',
            banner.kind === 'past_due' || banner.kind === 'cap' ? 'bg-warn-bg text-warn-ink hover:brightness-95' : 'bg-info-bg text-info-ink hover:brightness-95',
          ].join(' ')}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="max-w-content mx-auto w-full flex items-center gap-2">
            {banner.message} <span className="underline font-medium">Go to Billing</span>
          </span>
        </button>
      )}

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
          <span>DeepWell Technology · Knowledge builds business.</span>
          <span className="flex items-center gap-4">
            <span>Every answer shows its source.</span>
            <a href="/" className="inline-flex items-center gap-1 hover:text-ink-2 transition-colors duration-quick">
              <Globe className="w-3.5 h-3.5" aria-hidden="true" /> Website
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
