import { Component, type ReactNode } from 'react';

/**
 * Startup performance (handoffs/STARTUP_PERF_R13.md), reviewer NO-GO
 * (2026-09-26): App.tsx's screens are now `React.lazy` — a code-split chunk
 * that 404s (this browser has an old `index.html` still pointing at a
 * chunk hash a new deploy no longer ships) throws INSIDE the Suspense
 * boundary, and with no error boundary above it that's a blank white
 * screen, not a recoverable state. This catches exactly that and offers a
 * reload; anything else caught here (a genuine bug in a screen, not a
 * missing chunk) gets a plain "something went wrong" card instead — it
 * must never auto-reload, or a real bug would reload-loop the tab forever.
 */
const RELOAD_GUARD_KEY = 'deepwell.chunkReload';

// Covers Vite/Rollup's and every major browser's own wording for a dynamic
// `import()` that 404s or times out.
const CHUNK_ERROR_RE =
  /fetch dynamically imported module|dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk|loading css chunk/i;

interface Props {
  children: ReactNode;
}

interface State {
  kind: 'none' | 'chunk' | 'other';
}

export class ScreenLoadBoundary extends Component<Props, State> {
  override state: State = { kind: 'none' };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: CHUNK_ERROR_RE.test(message) ? 'chunk' : 'other' };
  }

  override componentDidCatch(error: unknown): void {
    if (this.state.kind !== 'chunk') return;
    // Auto-reload ONCE per tab — sessionStorage-guarded so a deploy that is
    // somehow STILL broken after a reload shows the card instead of
    // reload-looping the tab forever.
    let alreadyTried = false;
    try {
      alreadyTried = window.sessionStorage.getItem(RELOAD_GUARD_KEY) === '1';
    } catch {
      /* private window / storage blocked — just show the card below */
    }
    if (alreadyTried) return;
    try {
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    } catch {
      /* best-effort — worst case this reloads more than once */
    }
    window.location.reload();
    void error;
  }

  override render() {
    if (this.state.kind === 'chunk') {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center p-6">
          <div className="dw-card px-6 py-5 max-w-sm text-center space-y-3">
            <p className="font-medium">A new version is available</p>
            <p className="text-body text-ink-2">Reloading to pick it up…</p>
            <button type="button" onClick={() => window.location.reload()} className="dw-btn bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950">
              Reload now
            </button>
          </div>
        </div>
      );
    }
    if (this.state.kind === 'other') {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center p-6">
          <div className="dw-card px-6 py-5 max-w-sm text-center space-y-3">
            <p className="font-medium">Something went wrong</p>
            <p className="text-body text-ink-2">Try reloading the page.</p>
            <button type="button" onClick={() => window.location.reload()} className="dw-btn bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950">
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
