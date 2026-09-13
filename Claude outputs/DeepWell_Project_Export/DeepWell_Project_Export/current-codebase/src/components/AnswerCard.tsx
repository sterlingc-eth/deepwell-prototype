import { Loader2, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { Answer, AskStage, SourceRef } from '../core/types';
import { FactGrid } from './FactGrid';
import { SourceList } from './SourceList';

export const STAGE_TEXT: Record<AskStage, string> = {
  reading: 'Reading your records…',
  linking: 'Linking…',
  writing: 'Writing the answer…',
};

/**
 * The thinking ticker. Driven only by the provider's status events — no
 * timers — so it says what is actually happening. Renders nothing until the
 * first event arrives; each change of stage re-keys the text so it fades in
 * (200 ms, within the motion cap).
 */
export function AnswerTicker({ stage }: { stage: AskStage | null }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-body text-ink-2 dark:text-body-lg min-h-[24px]">
      {stage && (
        <>
          <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none shrink-0" aria-hidden="true" />
          <span key={stage} className="animate-fade-in motion-reduce:animate-none">
            {STAGE_TEXT[stage]}
          </span>
        </>
      )}
    </p>
  );
}

export interface AnswerCardProps {
  answer: Answer;
  question: string;
  includeUnverified: boolean;
  onToggleUnverified: (on: boolean) => void;
  onOpenSource: (ref: SourceRef) => void;
  onOpenEntity?: (entityId: string) => void;
}

/**
 * The one answer shape, always in this order:
 *   Answer → Linked facts → Sources
 * or, when the records don't support an answer, an honest empty state with
 * the closest documents instead. Same component on desk and in the field.
 *
 * Embeddable: it depends only on the Answer object and three callbacks.
 */
export function AnswerCard({ answer, question, includeUnverified, onToggleUnverified, onOpenSource, onOpenEntity }: AnswerCardProps) {
  const docOrder = new Map<string, number>();
  for (const s of answer.sources) if (!docOrder.has(s.documentId)) docOrder.set(s.documentId, docOrder.size + 1);
  const citation = (ref: SourceRef) => docOrder.get(ref.documentId) ?? 0;

  const isEmpty = answer.kind === 'no-answer';
  const recordWord = answer.verifiedCount === 1 ? 'record' : 'records';

  // One polite announcement per answer, for screen readers. The article itself
  // is not a live region, so the answer is not read twice.
  const sourceCount = docOrder.size;
  const closestCount = answer.closest.length;
  const announcement = isEmpty
    ? `No answer found. ${closestCount} closest ${closestCount === 1 ? 'document' : 'documents'}.`
    : `Answer ready. ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}.`;

  return (
    <article className="dw-card overflow-hidden animate-rise" aria-labelledby="answer-text">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <header className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-line">
        <p className="text-caption text-ink-3 mb-2 truncate">
          {answer.interpretation ? answer.interpretation : `Asked: “${question}”`}
        </p>
        <p id="answer-text" className={['font-display text-ink', isEmpty ? 'text-h2' : 'text-h2 sm:text-[28px] sm:leading-[36px] dark:text-[30px] dark:leading-[38px]'].join(' ')}>
          {answer.text}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-body text-ink-2 dark:text-body-lg">
          <span className="inline-flex items-center gap-1.5">
            {includeUnverified ? <ShieldQuestion className="w-4 h-4 text-warn" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4 text-ok" aria-hidden="true" />}
            {isEmpty
              ? includeUnverified
                ? 'Searched linked and verified records'
                : 'Searched verified records only'
              : `From ${answer.verifiedCount} ${includeUnverified ? 'linked or verified' : 'verified'} ${recordWord}`}
            {answer.unverifiedCount > 0 && !includeUnverified && (
              <span className="text-warn-ink dark:text-brass-200">· {answer.unverifiedCount} unverified held back</span>
            )}
            {typeof answer.latencyMs === 'number' && (
              <span className="text-ink-3">· {answer.latencyMs < 1000 ? `${answer.latencyMs} ms` : `${(answer.latencyMs / 1000).toFixed(1)} s`}</span>
            )}
          </span>
          {/* The label is the touch target for the checkbox: 48px tall on phones and
              always in field mode; the box itself is 24px in field mode. */}
          <label className="inline-flex items-center gap-2 cursor-pointer select-none min-h-touch sm:min-h-0 dark:sm:min-h-touch">
            <input
              type="checkbox"
              checked={includeUnverified}
              onChange={(e) => onToggleUnverified(e.target.checked)}
              className="w-4 h-4 dark:w-6 dark:h-6 accent-forest-700 dark:accent-brass-300"
            />
            <span>Include unverified</span>
          </label>
        </div>
      </header>

      <div className="px-5 sm:px-6 py-5 space-y-6">
        {isEmpty ? (
          <SourceList sources={answer.closest} onOpen={onOpenSource} title="Closest documents" emptyText="No documents look related. Try an address, a serial number, or a customer name." />
        ) : (
          <>
            <FactGrid facts={answer.facts} citation={citation} onOpenSource={onOpenSource} {...(onOpenEntity ? { onOpenEntity } : {})} />
            <SourceList sources={answer.sources} onOpen={onOpenSource} />
          </>
        )}
      </div>
    </article>
  );
}
