import type { ReactNode } from 'react';
import { MessageSquareText, Database, Inbox, LayoutDashboard, List, Sun, Moon, LogOut, Globe } from 'lucide-react';
import { useClerk } from '@clerk/clerk-react';
import { useAppStore, type Screen } from '../store/appStore';

interface NavItem {
  screen: Screen;
  label: string;
  icon: typeof MessageSquareText;
  /** Screens that should light up this nav item */
  matches: Screen[];
}

const NAV: NavItem[] = [
  { screen: 'ask', label: 'Ask', icon: MessageSquareText, matches: ['ask', 'entity'] },
  { screen: 'records', label: 'Records', icon: Database, matches: ['records'] },
  { screen: 'ingest', label: 'Intake', icon: Inbox, matches: ['ingest', 'review'] },
  { screen: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, matches: ['dashboard', 'warranty-export'] },
  { screen: 'browse', label: 'Browse', icon: List, matches: ['browse'] },
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
  const { signOut } = useClerk();

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
            className="flex items-center gap-2.5 min-h-touch rounded-md px-1 -ml-1 focus-visible:outline-brass-300"
            aria-label="DeepWell home"
          >
            <span aria-hidden="true" className="w-7 h-7 rounded-full border-[3px] border-brass-400 grid place-items-center">
              <span className="w-2.5 h-2.5 rounded-full bg-brass-400" />
            </span>
            <span className="hidden xs:inline sm:inline font-display font-semibold text-[22px] leading-none tracking-tight">DeepWell</span>
          </button>

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
                  <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
                  <span className="hidden sm:inline">{label}</span>
                  <span className="sr-only sm:hidden">{label}</span>
                </button>
              );
            })}
          </nav>

          <a
            href="/"
            aria-label="Back to the DeepWell website"
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            <Globe className="w-5 h-5" aria-hidden="true" />
            <span className="hidden md:inline text-body">Website</span>
          </a>

          <button
            type="button"
            role="switch"
            aria-checked={fieldMode}
            aria-label={fieldMode ? 'Field mode on. Switch to office mode' : 'Office mode on. Switch to field mode'}
            onClick={() => setFieldMode(!fieldMode)}
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            {fieldMode ? <Sun className="w-5 h-5" aria-hidden="true" /> : <Moon className="w-5 h-5" aria-hidden="true" />}
            <span className="hidden md:inline text-body">{fieldMode ? 'Field' : 'Office'}</span>
          </button>

          <button
            type="button"
            onClick={() => { void signOut(); }}
            aria-label="Sign out"
            className="inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            <LogOut className="w-5 h-5" aria-hidden="true" />
            <span className="hidden md:inline text-body">Sign out</span>
          </button>
        </div>
      </header>

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
          <span>DeepWell · Knowledge builds business.</span>
          <span>Every answer shows its source.</span>
        </div>
      </footer>
    </div>
  );
}
