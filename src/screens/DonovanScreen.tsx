import { useEffect, useRef } from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { DonovanMissesCard } from '../components/DonovanMissesCard';
import { DonovanLearningCard } from '../components/DonovanLearningCard';
import { DonovanScoresCard } from '../components/DonovanScoresCard';
import { SemanticSearchCard } from '../components/SemanticSearchCard';

interface DonovanScreenProps {
  onClose: () => void;
}

/**
 * "Donovan" — the admin-only answer-quality destination (round 17, U2 top
 * fixes #3/#5). Used to be 3 of TeamScreen's 7 stacked cards (Donovan misses,
 * Donovan learning, Search by meaning) — Team is people/seats/invites, not
 * an AI-quality review screen, so this gives them their own home, reachable
 * from the account row (next to Billing/Team) rather than buried behind two
 * clicks of scrolling on Team.
 *
 * Rendered as a full-screen overlay ABOVE whatever screen is underneath
 * (same modal pattern as DocumentPreview.tsx) rather than as one more
 * `Screen` id in store/appStore.ts — that file (and its `Screen` union /
 * App.tsx's switch) belongs to no one in this round's file split, so this
 * stays a self-contained overlay AppShell owns the open/closed state for.
 * HOOK FOR THE LEAD (optional, 3 lines, if a real route is preferred later):
 * add `'donovan'` to `Screen` in store/appStore.ts, a `case 'donovan':
 * return <DonovanScreen onClose={() => setCurrentScreen('dashboard')} />`
 * in App.tsx's switch, and `'donovan'` to useDeepLink.ts's SCREENS list.
 *
 * 2026-10-10: customers no longer get this screen at all (owner: no extra work or stress for the client). AppShell only
 * shows the button, and the command palette only lists it, for a platform operator (the server's `isOperator`).
 *
 * Gating (earlier): the exact same admin/operator checks the three cards already used
 * on Team (isAdminRole for the section, `report.isOperator` from the server
 * inside DonovanMissesCard for the operator-only actions) — moving them
 * doesn't loosen or duplicate that gate, AppShell only ever renders the
 * button that opens this for an admin in the first place.
 */
export function DonovanScreen({ onClose }: DonovanScreenProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-40 bg-bg overflow-y-auto" role="dialog" aria-modal="true" aria-label="Donovan">
      <div className="sticky top-0 z-10 bg-forest-700 text-stone-0 border-b border-forest-800">
        <div className="max-w-content mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center gap-3">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 min-h-touch px-2 -ml-2 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300"
          >
            <ArrowLeft className="w-5 h-5" aria-hidden="true" /> Back
          </button>
          <h1 className="flex items-center gap-2 text-body-lg font-semibold">
            <Sparkles className="w-5 h-5" aria-hidden="true" /> Donovan
          </h1>
          <span className="dw-pill-muted !text-forest-100 !bg-forest-800 hidden sm:inline-flex">DeepWell team only</span>
        </div>
      </div>

      <main className="max-w-content mx-auto px-4 sm:px-6 py-6 sm:py-10 space-y-4">
        <div>
          <h2 className="text-h2">Answer quality</h2>
          <p className="text-ink-2 mt-1">
            Shared performance scores from organizations that opted in, plus this account's own misses, learning and
            search-by-meaning status. DeepWell team only.
          </p>
        </div>
        <DonovanScoresCard />
        <DonovanMissesCard />
        <DonovanLearningCard />
        <SemanticSearchCard />
      </main>
    </div>
  );
}
