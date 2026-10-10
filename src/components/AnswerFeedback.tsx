import { useState } from 'react';
import { Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { reviewClient } from '../services/reviewClient';

/**
 * Tiny "Was this right?" control under an answer. Optional and ONE tap, no form: thumbs-up confirms the shortcut Donovan
 * learned from this answer; thumbs-down records that it was wrong, retires any learned shortcut for that question and has
 * Donovan re-check it once. (2026-10-10: the "what was wrong?" note step was removed, so the customer never has to type or
 * teach anything.) Everything it says back is what the server actually did - no pretending. The parent keys it by question +
 * answer so a new answer starts fresh.
 */
export function AnswerFeedback({ question }: { question: string }) {
  const [step, setStep] = useState<'idle' | 'sending' | 'done'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const send = async (rating: 'up' | 'down') => {
    setStep('sending');
    try {
      const r = await reviewClient.askFeedback(question, rating);
      if (rating === 'up') setMessage('Thanks - noted.');
      else if (r.budget) setMessage('Logged. The daily AI budget is used up, so Donovan will re-check it later.');
      else if (r.replay?.outcome === 'answered_now') setMessage(`Checked again: ${r.replay.answer?.text ?? 'Donovan has a new answer.'}`);
      else setMessage('Logged for review - Donovan could not do better on a second look.');
    } catch {
      setMessage('Could not save that just now.');
    }
    setStep('done');
  };

  // Round 12 tech-ergonomics pass: was w-8 h-8 (32px) — under the 44px minimum tap target every other
  // control in this round meets. Bumped to match MobileAnswer's own (already-44px) feedback buttons.
  const btn = 'inline-flex items-center justify-center w-11 h-11 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';

  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-ink-3" data-testid="answer-feedback">
      {step !== 'done' && (
        <>
          <span>Was this right?</span>
          <button type="button" className={btn} aria-label="Yes, this answer was right" disabled={step === 'sending'} onClick={() => void send('up')} data-tap-target="true">
            <ThumbsUp className="w-4 h-4" aria-hidden="true" />
          </button>
          <button type="button" className={btn} aria-label="No, this answer was wrong" disabled={step === 'sending'} onClick={() => void send('down')} data-tap-target="true">
            {step === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ThumbsDown className="w-4 h-4" aria-hidden="true" />}
          </button>
        </>
      )}
      {step === 'done' && message && <span role="status">{message}</span>}
    </div>
  );
}
