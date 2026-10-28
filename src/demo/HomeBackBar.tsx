import { ArrowLeft } from 'lucide-react';

/** Way back to the marketing site from /demo/: one plain text link (full page load), no logo. The demo header below carries the wordmark. */
export function HomeBackBar() {
  return (
    <div className="border-b border-line bg-surface-2" data-testid="demo-home-bar">
      <div className="max-w-content mx-auto px-4">
        <a
          href="/"
          data-testid="demo-home-link"
          className="inline-flex items-center gap-1.5 min-h-11 py-2 text-body font-medium text-ink-2 hover:text-ink rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to home
        </a>
      </div>
    </div>
  );
}
