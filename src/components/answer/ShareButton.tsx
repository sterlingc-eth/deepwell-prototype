import { useState } from 'react';
import { Check, Share2 } from 'lucide-react';

/**
 * "Share": copies a plain-text summary (question, headline, key facts, sources — src/core/answerLayout
 * .ts's shareText) so a tech can paste it into a text message or a work-order note. Uses the native
 * share sheet when the platform offers one (mobile Safari/Chrome); falls back to clipboard everywhere
 * else, and simply does nothing (no crash) if neither is available.
 */
export function ShareButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');

  const run = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        setState('done');
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setState('done');
      } else {
        setState('error');
      }
    } catch (e) {
      // AbortError = the person dismissed the native share sheet — not a failure worth reporting.
      if (e instanceof Error && e.name === 'AbortError') return;
      setState('error');
    }
    window.setTimeout(() => setState('idle'), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      className="min-h-11 inline-flex items-center gap-1.5 px-3 rounded-md text-body text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors duration-quick"
      aria-label="Share this answer"
      data-tap-target="true"
    >
      {state === 'done' ? <Check className="w-4 h-4 text-ok" aria-hidden="true" /> : <Share2 className="w-4 h-4" aria-hidden="true" />}
      {state === 'done' ? 'Copied' : state === 'error' ? "Couldn't share" : 'Share'}
    </button>
  );
}
