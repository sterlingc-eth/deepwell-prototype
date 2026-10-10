import { useEffect, useState } from 'react';
import { reviewClient } from '../services/reviewClient';

/**
 * Admin setting, OFF by default. Nothing here asks the customer to review or teach anything.
 */
export function DonovanSharingCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    reviewClient.donovanSharing().then((r) => { if (live) setOn(r.sharing); }).catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, []);

  const toggle = async () => {
    if (on === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await reviewClient.donovanSharing(!on);
      setOn(r.sharing);
    } catch {
      setError('Could not save that just now.');
    }
    setBusy(false);
  };

  return (
    <div className="flex items-start gap-3 py-2">
      <button
        type="button"
        role="switch"
        aria-checked={on === true}
        aria-labelledby="donovan-share-label"
        aria-describedby="donovan-share-help"
        disabled={on === null || busy}
        onClick={() => void toggle()}
        className={`shrink-0 mt-0.5 min-h-touch min-w-touch inline-flex items-center justify-center rounded-md focus-visible:outline focus-visible:outline-2 disabled:opacity-50`}
      >
        <span className={`relative inline-block w-11 h-6 rounded-full transition-colors duration-quick ${on ? 'bg-ok' : 'bg-line-2'}`} aria-hidden="true">
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-stone-0 transition-transform duration-quick ${on ? 'translate-x-5' : ''}`} />
        </span>
      </button>
      <div className="min-w-0">
        <p id="donovan-share-label" className="text-body font-semibold">Share Donovan performance scores with DeepWell</p>
        <p id="donovan-share-help" className="text-caption text-ink-2">
          Off by default. When on, DeepWell sees only scores: the kind of question, whether Donovan answered it, and how fast. Never your questions, answers, documents or names.
        </p>
        {error && <p className="text-caption text-bad" role="alert">{error}</p>}
      </div>
    </div>
  );
}
