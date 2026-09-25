import { useMemo, useState } from 'react';
import { ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { Answer, AnswerRecord, SourceRef } from '../core/types';
import { recordGroups, showRecordsPanel, splitAnswerHeadline } from '../core/citations';
import { RecordsPanel } from './RecordsPanel';
import { FactGrid } from './FactGrid';
import { SourceList } from './SourceList';
import { AnswerFeedback } from './AnswerFeedback';

export interface AnswerCardProps {
  answer: Answer;
  question: string;
  includeUnverified: boolean;
  onToggleUnverified: (on: boolean) => void;
  onOpenSource: (ref: SourceRef) => void;
  onOpenEntity?: (entityId: string) => void;
  /** Open a record from the "Based on N records" list: customer profile, unit's customer, document at its cited page. */
  onOpenRecord?: (record: AnswerRecord) => void;
}

/**
 * The one answer shape, always in this order:
 *   Answer → Linked facts → Sources
 * or, when the records don't support an answer, an honest empty state with
 * the closest documents instead. Same component on desk and in the field.
 *
 * Embeddable: it depends only on the Answer object and three callbacks.
 */
export function AnswerCard({ answer, question, includeUnverified, onToggleUnverified, onOpenSource, onOpenEntity, onOpenRecord }: AnswerCardProps) {
  // Citation contract: the drill-down list is collapsed until asked for; a breakdown row can filter it.
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsGroup, setRecordsGroup] = useState<string | null>(null);
  const records = useMemo(() => answer.records ?? [], [answer.records]);
  const groupKeys = useMemo(() => new Set(recordGroups(records)), [records]);
  const selectGroup = (label: string) => {
    setRecordsGroup((cur) => (cur === label ? null : label));
    setRecordsOpen(true);
  };
  const panel = showRecordsPanel(answer) && onOpenRecord ? (
    <RecordsPanel
      records={records}
      total={answer.recordsTotal ?? records.length}
      kind={answer.recordsKind ?? 'basis'}
      open={recordsOpen}
      onToggle={setRecordsOpen}
      group={recordsGroup}
      onGroupChange={setRecordsGroup}
      onOpenRecord={onOpenRecord}
      onOpenSource={onOpenSource}
    />
  ) : null;

  const docOrder = new Map<string, number>();
  for (const s of answer.sources) if (!docOrder.has(s.documentId)) docOrder.set(s.documentId, docOrder.size + 1);
  const citation = (ref: SourceRef) => docOrder.get(ref.documentId) ?? 0;
  const docName = new Map<string, string>();
  for (const s of answer.sources) {
    const n = (s as { filename?: string }).filename;
    if (n && !docName.has(s.documentId)) docName.set(s.documentId, n);
  }
  const sourceLabel = (ref: SourceRef) => docName.get(ref.documentId);

  const isEmpty = answer.kind === 'no-answer';
  const recordWord = answer.verifiedCount === 1 ? 'record' : 'records';
  // Owner report (2026-09-25): a two-sentence answer ("13 customers ... 14 in all.") rendered as one
  // giant, confusing headline. Split so the headline states ONE plain claim and anything after it
  // (a caveat, a unit-count aside) reads as a small muted line underneath instead.
  const { headline, secondary } = splitAnswerHeadline(answer.text);
  // The verified/unverified control is about DOCUMENT staging (a citation contract concept) — it has
  // nothing to say, and nothing to change, for a record-grounded answer (an analytics/agent count with
  // no document sources at all: "0 verified records" next to "Based on 13 customers" read as a flat
  // contradiction). Shown only when it can actually mean something: an empty/no-answer state, or an
  // answer that cites real documents.
  const showVerifiedControl = isEmpty || answer.sources.length > 0;

  return (
    <article className="dw-card overflow-hidden animate-rise" aria-live="polite" aria-labelledby="answer-text">
      <header className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-line">
        <p className="text-caption text-ink-3 mb-2 truncate">
          <span className="font-medium text-ink-2">Donovan</span> · {answer.interpretation ? answer.interpretation : `Asked: “${question}”`}
        </p>
        <p id="answer-text" className={['font-display text-ink', isEmpty ? 'text-h2' : 'text-h2 sm:text-[28px] sm:leading-[36px] field:text-[30px] field:leading-[38px]'].join(' ')}>
          {headline}
        </p>
        {/* A second sentence (a caveat, a unit-count aside) never shares headline size with the main
            claim — it reads as ordinary muted context underneath it instead. */}
        {secondary && (
          <p className="mt-1 text-body text-ink-2" data-testid="answer-secondary">
            {secondary}
          </p>
        )}
        {/* How it was computed, one muted sentence: every answer states its basis (citation contract). */}
        {answer.basis && (
          <p className="mt-2 text-caption text-ink-3" data-testid="answer-basis">
            {answer.basis}
          </p>
        )}

        {showVerifiedControl && (
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
        )}
      </header>

      <div className="px-5 sm:px-6 py-5 space-y-6">
        {isEmpty ? (
          <>
            <SourceList sources={answer.closest} onOpen={onOpenSource} title="Closest documents" emptyText="No documents look related. Try an address, a serial number, or a customer name." />
            {panel}
          </>
        ) : (
          <>
            <FactGrid
              facts={answer.facts} citation={citation} onOpenSource={onOpenSource} sourceLabel={sourceLabel}
              {...(onOpenEntity ? { onOpenEntity } : {})}
              {...(panel ? { groupKeys, activeGroup: recordsGroup, onSelectGroup: selectGroup } : {})}
            />
            {panel}
            {/* Owner report (2026-09-25): "SOURCES · 0 — No documents cited" showed even when the
                RecordsPanel above already cites 13 real customer records — read as a flat
                contradiction. A record-grounded answer (no document sources at all) has nothing new
                to say here, so the plain Sources list is shown only when it has something to show, or
                when there is no records panel to have already covered it. */}
            {(answer.sources.length > 0 || !panel) && (
              <SourceList sources={answer.sources} onOpen={onOpenSource} />
            )}
          </>
        )}
        <AnswerFeedback key={`${question}|${answer.text}`} question={question} />
      </div>
    </article>
  );
}
