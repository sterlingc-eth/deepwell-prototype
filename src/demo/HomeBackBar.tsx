import { ArrowLeft } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';

/** Always-visible way back to the marketing site from /demo/. A plain link (full page load), never a router push. */
export function HomeBackBar() {
  return (
    <div className="border-b border-line bg-surface-2" data-testid="demo-home-bar">
      <div className="max-w-content mx-auto px-4">
        <a
          href="/"
          data-testid="demo-home-link"
          className="inline-flex items-center gap-3 min-h-11 py-1 text-body text-ink-2 hover:text-ink rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Wordmark />
          <span className="inline-flex items-center gap-1.5 font-medium"><ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to home</span>
        </a>
      </div>
    </div>
  );
}
