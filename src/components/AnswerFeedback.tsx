import { useState } from 'react';
import { Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { reviewClient } from '../services/reviewClient';

/**
 * Tiny "Was this right?" control under an answer. Thumbs-up confirms the shortcut Donovan learned from
 * this answer; thumbs-down asks (optionally) what was wrong, records a correction, retires any learned
 * shortcut for that question, and has Donovan re-check it once with the note as a hint. Everything it
 * says back is what the server actually did - no pretending. The parent keys it by question + answer so a
 * new answer starts fresh.
 */
export function AnswerFeedback({ question }: { question: string }) {
  const [step, setStep] = useState<'idle' | 'up' | 'asking' | 'sending' | 'done'>('idle');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const thumbsUp = async () => {
    setStep('up');
    try {
      await reviewClient.askFeedback(question, 'up');
      setMessage('Thanks - noted.');
    } catch {
      setMessage('Could not save that just now.');
    }
  };

  const sendDown = async () => {
    setStep('sending');
    try {
      const r = await reviewClient.askFeedback(question, 'down', note.trim() || undefined);
      if (r.budget) setMessage('Logged. The daily AI budget is used up, so Donovan will re-check it later.');
      else if (r.replay?.outcome === 'answered_now') setMessage(`Checked again: ${r.replay.answer?.text ?? 'Donovan has a new answer.'}`);
      else setMessage('Logged for review - Donovan could not do better on a second look.');
    } catch {
      setMessage('Could not save that just now.');
    }
    setStep('done');
  };

  const btn = 'inline-flex items-center justify-center w-8 h-8 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';

  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-ink-3" data-testid="answer-feedback">
      {step === 'idle' && (
        <>
          <span>Was this right?</span>
          <button type="button" className={btn} aria-label="Yes, this answer was right" onClick={() => void thumbsUp()}>
            <ThumbsUp className="w-4 h-4" aria-hidden="true" />
          </button>
          <button type="button" className={btn} aria-label="No, this answer was wrong" onClick={() => setStep('asking')}>
            <ThumbsDown className="w-4 h-4" aria-hidden="true" />
          </button>
        </>
      )}
      {(step === 'asking' || step === 'sending') && (
        <form className="flex flex-wrap items-center gap-2 w-full" onSubmit={(e) => { e.preventDefault(); void sendDown(); }}>
          <label className="sr-only" htmlFor="answer-feedback-note">What was wrong?</label>
          <input
            id="answer-feedback-note"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was wrong? (optional)"
            className="flex-1 min-w-[12rem] rounded-md border border-line-2 bg-surface px-2 py-1 text-caption text-ink placeholder:text-ink-3 focus:border-focus"
            disabled={step === 'sending'}
          />
          <button type="submit" className="dw-btn-tertiary !min-h-[32px] !py-0.5" disabled={step === 'sending'}>
            {step === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} Send
          </button>
          <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5" disabled={step === 'sending'} onClick={() => setStep('idle')}>Cancel</button>
        </form>
      )}
      {(step === 'up' || step === 'done') && message && <span role="status">{message}</span>}
    </div>
  );
}
