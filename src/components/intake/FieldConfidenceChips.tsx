import { useState } from 'react';
import { Check, Loader2, Pencil } from 'lucide-react';
import type { IntakeFilledField } from '../../services/intakeClient';

/**
 * "Field-level confidence chips on a document's filled fields" (Round 13, H2 contract): every
 * field autofill.js was able to fill for this document — whether the document stated it itself or
 * it was inferred from a sibling — with a one-tap way to confirm or correct it, right beside the
 * ONE open question the card is actually asking about. A chip never blocks anything; it's how a
 * person notices a wrong inference in passing instead of it quietly becoming "true" forever.
 */
export function FieldConfidenceChips({
  fields,
  onConfirm,
  onFix,
  busyKey,
}: {
  fields: IntakeFilledField[];
  onConfirm: (fieldKey: string, value: string) => void;
  onFix: (fieldKey: string, value: string) => void;
  busyKey: string | null;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (!fields.length) return null;

  const startFix = (f: IntakeFilledField) => {
    setEditingKey(f.fieldKey);
    setDraft(f.value);
  };
  const saveFix = (fieldKey: string) => {
    const v = draft.trim();
    if (v) onFix(fieldKey, v);
    setEditingKey(null);
  };

  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Filled fields">
      {fields.map((f) => {
        const busy = busyKey === f.fieldKey;
        const low = f.confidence < 0.85;
        if (editingKey === f.fieldKey) {
          return (
            <li key={f.fieldKey} className="flex items-center gap-1">
              <label className="sr-only" htmlFor={`chip-fix-${f.fieldKey}`}>{f.label}</label>
              <input
                id={`chip-fix-${f.fieldKey}`}
                autoFocus
                className="dw-input !min-h-[32px] !py-1 !px-2 text-caption w-40"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveFix(f.fieldKey);
                  if (e.key === 'Escape') setEditingKey(null);
                }}
              />
              <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 text-caption" onClick={() => saveFix(f.fieldKey)} disabled={!draft.trim()}>
                Save
              </button>
              <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 text-caption" onClick={() => setEditingKey(null)}>
                Cancel
              </button>
            </li>
          );
        }
        return (
          <li
            key={f.fieldKey}
            className={['flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption', low ? 'border-warn/50 bg-warn-bg dark:bg-forest-800' : 'border-line bg-surface-2'].join(' ')}
            title={f.provenance ?? undefined}
          >
            <span className="text-ink-2">
              {f.label} · <span className="font-mono text-ink">{f.value}</span>
              {f.source === 'inferred' && <span className="text-ink-3"> · {f.provenance ?? 'inferred'}</span>}
              {' '}
              <span className={low ? 'text-warn-ink dark:text-brass-200' : 'text-ink-3'}>{Math.round(f.confidence * 100)}%</span>
            </span>
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin text-ink-3" aria-hidden="true" />
            ) : (
              <>
                <button type="button" className="text-ok-ink dark:text-ok-bg hover:opacity-70" aria-label={`Looks right: ${f.label}`} onClick={() => onConfirm(f.fieldKey, f.value)}>
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button type="button" className="text-ink-3 hover:opacity-70" aria-label={`Fix: ${f.label}`} onClick={() => startFix(f)}>
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
