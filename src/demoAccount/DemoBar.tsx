/**
 * Header controls for an industry demo company: a subtle "Demo" badge, "Switch industry" (back to the picker) and
 * "Clear my scans" (removes the documents scanned during this visit; the sample paperwork stays).
 */
import { useState } from 'react';
import { Eraser, LayoutGrid, Loader2 } from 'lucide-react';
import { setDemoPicked } from './industries';
import { demoClient } from './demoClient';

export function DemoBadge({ industry }: { industry: string | null }) {
  return (
    <span
      className="inline-flex items-center rounded-full bg-brass-300/90 text-forest-950 text-caption font-semibold px-2.5 py-0.5 tracking-wide whitespace-nowrap"
      title={industry ? `Demo company: ${industry}` : 'Demo company'}
    >
      Demo
    </span>
  );
}

export function DemoControls({ onSwitch }: { onSwitch: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const clear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await demoClient.clearScans();
      setMessage(r.removedDocuments > 0 ? `Cleared ${r.removedDocuments} scanned document${r.removedDocuments === 1 ? '' : 's'}.` : 'Nothing to clear. Only the sample paperwork is here.');
      setConfirming(false);
      // Reload so every screen shows the company exactly as it was (the picked industry stays selected).
      if (r.removedDocuments > 0) window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not clear the scans. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const btn = 'inline-flex items-center gap-2 min-h-touch min-w-touch justify-center px-2 lg:px-3 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800 transition-colors duration-quick focus-visible:outline-brass-300 whitespace-nowrap';
  return (
    <>
      <button type="button" className={btn} onClick={() => { setDemoPicked(false); onSwitch(); }} title="Switch industry">
        <LayoutGrid className="w-5 h-5" aria-hidden="true" />
        <span className="hidden md:inline text-body">Switch industry</span>
        <span className="sr-only md:hidden">Switch industry</span>
      </button>
      <button type="button" className={btn} onClick={() => { setMessage(null); setConfirming(true); }} title="Clear my scans">
        <Eraser className="w-5 h-5" aria-hidden="true" />
        <span className="hidden xl:inline text-body">Clear my scans</span>
        <span className="sr-only xl:hidden">Clear my scans</span>
      </button>
      {(confirming || message) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" aria-labelledby="clear-scans-title">
          <div className="dw-card bg-surface max-w-md w-full p-6 text-ink">
            <h2 id="clear-scans-title" className="text-h3 font-semibold">Clear my scans</h2>
            {message ? (
              <p className="mt-3 text-body-lg text-ink-2" role="status">{message}</p>
            ) : (
              <p className="mt-3 text-body-lg text-ink-2">Remove every document scanned or uploaded during this visit? The sample paperwork stays exactly as it was.</p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="dw-btn-secondary !min-h-touch" onClick={() => { setConfirming(false); setMessage(null); }}>
                {message ? 'Close' : 'Cancel'}
              </button>
              {!message && (
                <button type="button" className="dw-btn-primary !min-h-touch" onClick={() => void clear()} disabled={busy}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Clear scans
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
