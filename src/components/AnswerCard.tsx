import { ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { Answer, SourceRef } from '../core/types';
import { FactGrid } from './FactGrid';
import { SourceList } from './SourceList';

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

  return (
    <article className="dw-card overflow-hidden animate-rise" aria-live="polite" aria-labelledby="answer-text">
      <header className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-line">
        <p className="text-caption text-ink-3 mb-2 truncate">
          <span className="font-medium text-ink-2">Donovan</span> · {answer.interpretation ? answer.interpretation : `Asked: “${question}”`}
        </p>
        <p id="answer-text" className={['font-display text-ink', isEmpty ? 'text-h2' : 'text-h2 sm:text-[28px] sm:leading-[36px] field:text-[30px] field:leading-[38px]'].join(' ')}>
          {answer.text}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-body text-ink-2 field:text-body-lg">
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
          </span>
          <label className="inline-flex items-center gap-2 cursor-pointer select-none min-h-touch sm:min-h-0">
            <input
              type="checkbox"
              checked={includeUnverified}
              onChange={(e) => onToggleUnverified(e.target.checked)}
              className="w-4 h-4 accent-forest-700 dark:accent-brass-300"
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
