import { useState } from 'react';
import { AlertTriangle, Clock, Loader2, X } from 'lucide-react';
import { documentName, hasFriendlyName, originalFilename } from '../../core/documentName';
import type { IntakeCandidate, IntakeQueueItem } from '../../services/intakeClient';
import { FieldConfidenceChips } from './FieldConfidenceChips';

/**
 * One document, one plain-language question, one tap to answer it (Round 13, H2 contract). Every
 * candidate button IS the answer — no separate "confirm" step — because the whole point of this
 * queue is that autofill.js already did the hard part (finding and phrasing the real conflict);
 * the person's only job left is to pick, or say what actually happened when neither guess is right.
 */
export function IntakeQueueCard({
  item,
  active,
  shortcutIndex,
  busy,
  fieldBusyKey,
  onActivate,
  onPickCandidate,
  onTypeValue,
  onDismiss,
  onSnooze,
  onConfirmField,
  onFixField,
  onPreview,
}: {
  item: IntakeQueueItem;
  active: boolean;
  /** 0-based position in the visible list — drives the "1"…"9" shortcut hint; undefined past 9. */
  shortcutIndex: number;
  busy: boolean;
  fieldBusyKey: string | null;
  onActivate: () => void;
  onPickCandidate: (candidate: IntakeCandidate) => void;
  onTypeValue: (value: string) => void;
  onDismiss: () => void;
  onSnooze: () => void;
  onConfirmField: (fieldKey: string, value: string) => void;
  onFixField: (fieldKey: string, value: string) => void;
  onPreview: (documentId: string, page: number | null) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [typedValue, setTypedValue] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);

  const docForName = { filename: item.filename, typeId: item.documentType, extracted: item.extracted, displayName: item.displayName ?? undefined };
  const title = documentName(docForName);
  const hasEvidence = item.candidates.some((c) => c.evidence || c.sourceDocumentLabel);

  const submitTyped = () => {
    const v = typedValue.trim();
    if (!v) return;
    onTypeValue(v);
    setTyping(false);
    setTypedValue('');
  };

  return (
    <li
      className={['dw-card p-4 space-y-3 transition-colors duration-quick', active ? 'ring-2 ring-forest-500 dark:ring-brass-300' : ''].join(' ')}
      onClick={onActivate}
      onFocus={onActivate}
      data-intake-card={item.needsInfoId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {shortcutIndex < 9 && (
              <span className="dw-pill-muted !px-1.5 font-mono text-caption" aria-hidden="true">{shortcutIndex + 1}</span>
            )}
            <button type="button" className="font-sans font-semibold text-body-lg text-ink hover:underline truncate text-left" onClick={(e) => { e.stopPropagation(); onPreview(item.documentId, item.candidates[0]?.page ?? 1); }}>
              {title}
            </button>
          </div>
          <p className="text-caption text-ink-3 mt-0.5">
            {item.documentTypeLabel}
            {hasFriendlyName(docForName) && ` · ${originalFilename(docForName)}`}
            {item.moreQuestions > 0 && ` · +${item.moreQuestions} more question${item.moreQuestions === 1 ? '' : 's'} after this`}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 text-caption" title="Ask again later" aria-label="Snooze this question" onClick={(e) => { e.stopPropagation(); onSnooze(); }} disabled={busy}>
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 text-caption" title="Doesn't apply" aria-label="Dismiss this question" onClick={(e) => { e.stopPropagation(); onDismiss(); }} disabled={busy}>
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="text-body-lg text-ink font-medium flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warn-ink dark:text-brass-200" aria-hidden="true" />
        {item.question}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {item.candidates.map((c, i) => (
          <button
            key={`${c.entityId ?? c.value ?? i}-${i}`}
            type="button"
            onClick={(e) => { e.stopPropagation(); onPickCandidate(c); }}
            disabled={busy}
            className="dw-card text-left p-3 min-w-0 hover:shadow-lift transition-shadow duration-quick disabled:opacity-60"
          >
            <p className={['font-semibold text-body-lg', c.kind === 'entity' ? 'break-words' : 'font-mono break-all'].join(' ')}>{c.label || c.address || 'Unnamed'}</p>
            {c.kind === 'entity' && c.address && c.label !== c.address && <p className="text-caption text-ink-3 mt-0.5 truncate">{c.address}</p>}
            {c.kind === 'value' && c.sourceDocumentLabel && (
              <p className="text-caption text-ink-3 mt-1 truncate">
                {c.sourceDocumentLabel}{c.page ? ` · p. ${c.page}` : ''}
              </p>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!typing ? (
          <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1" onClick={(e) => { e.stopPropagation(); setTyping(true); }}>
            Type it instead
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-1 min-w-[14rem]" onClick={(e) => e.stopPropagation()}>
            <label className="sr-only" htmlFor={`typed-${item.needsInfoId}`}>{item.fieldLabel}</label>
            <input
              id={`typed-${item.needsInfoId}`}
              autoFocus
              className="dw-input !min-h-[40px] flex-1"
              placeholder={item.fieldLabel}
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); if (e.key === 'Escape') setTyping(false); }}
            />
            <button type="button" className="dw-btn-primary !min-h-[40px]" disabled={!typedValue.trim() || busy} onClick={submitTyped}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Confirm'}
            </button>
            <button type="button" className="dw-btn-tertiary !min-h-[40px]" onClick={() => setTyping(false)}>Cancel</button>
          </div>
        )}
        {hasEvidence && (
          <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1 text-caption" onClick={(e) => { e.stopPropagation(); setShowEvidence((v) => !v); }}>
            {showEvidence ? 'Hide evidence' : 'Why are we asking?'}
          </button>
        )}
      </div>

      {showEvidence && (
        <ul className="rounded-lg border border-line bg-surface-2 p-3 space-y-2 text-caption">
          {item.candidates.map((c, i) => (
            <li key={i}>
              <span className="font-medium text-ink">{c.label}</span>
              {c.sourceDocumentLabel && <span className="text-ink-3"> — {c.sourceDocumentLabel}{c.page ? `, p. ${c.page}` : ''}</span>}
              {c.evidence && <p className="text-ink-2 mt-0.5 italic">“{c.evidence}”</p>}
              {!c.evidence && c.kind === 'entity' && <span className="text-ink-3"> — an existing record on file</span>}
            </li>
          ))}
        </ul>
      )}

      {item.filledFields.length > 0 && (
        <div>
          <p className="dw-label mb-1">On file for this document</p>
          <FieldConfidenceChips fields={item.filledFields} onConfirm={onConfirmField} onFix={onFixField} busyKey={fieldBusyKey} />
        </div>
      )}
    </li>
  );
}
