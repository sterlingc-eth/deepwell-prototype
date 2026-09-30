import type { Answer } from '../core/types';

/** Ask a how-to question about the app itself and the server answers from the DeepWell Help guide (no records
 *  involved). This card says so plainly and offers the Help chat for follow-ups. */
export function HelpAnswerCard({ answer, variant = 'desktop' }: { answer: Answer; variant?: 'desktop' | 'mobile' }) {
  const paras = answer.text.split('\n').map((p) => p.trim()).filter(Boolean);
  const mobile = variant === 'mobile';
  return (
    <article
      className={mobile ? 'rounded-2xl bg-surface p-4 grid grid-cols-1 gap-2' : 'dw-card px-5 sm:px-6 py-5 sm:py-6 space-y-3 animate-rise'}
      aria-live="polite"
      data-testid="help-answer"
    >
      <p className="m-0 text-caption text-ink-3 truncate">
        <span className="font-medium text-ink-2">Donovan</span> · {answer.interpretation ?? 'From DeepWell Help'}
      </p>
      {paras.map((p, i) => (
        <p key={i} className={`m-0 ${i === 0 ? 'text-body-lg text-ink' : 'text-body text-ink-2'}`}>{p}</p>
      ))}
      <p className="m-0 text-caption text-ink-3">This is a how-to answer from the Help guide, not from your records.</p>
      <div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('deepwell:open-help'))}
          className={`${mobile ? 'min-h-11 ' : ''}px-3.5 py-1.5 rounded-full text-caption font-semibold bg-surface-2 text-ink-2 border border-line`}
        >
          Open DeepWell Help
        </button>
      </div>
    </article>
  );
}

/** Under a "nothing in your records" answer to something that looks like a how-to question about the app. */
export function HelpHint({ variant = 'desktop' }: { variant?: 'desktop' | 'mobile' }) {
  const mobile = variant === 'mobile';
  return (
    <div className={mobile ? 'rounded-2xl bg-surface-2 p-3 grid gap-2' : 'dw-card px-5 py-4 flex flex-wrap items-center gap-3'} data-testid="help-hint">
      <p className="m-0 text-body text-ink-2">This looks like a how-to question about DeepWell itself. The Help chat can walk you through it.</p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('deepwell:open-help'))}
        className={`${mobile ? 'min-h-11 ' : ''}px-3.5 py-1.5 rounded-full text-caption font-semibold bg-surface-2 text-ink-2 border border-line`}
      >
        Open DeepWell Help
      </button>
    </div>
  );
}
