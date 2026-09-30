import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Loader2, Pencil } from 'lucide-react';
import { formatYmd } from '../core/answer';
import { useGraph } from '../core/entityGraph';
import type { Entity, SourceRef } from '../core/types';
import { useAppStore } from '../store/appStore';
import { useMemberDirectory } from '../hooks/useMemberDirectory';

/** Bounds the server enforces too (api/_lib/reviewStore.js validateInstallDateInput): 1950 .. three months ahead. */
export const INSTALL_DATE_MIN = '1950-01-01';
export function installDateMax(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 3, now.getDate()));
  return d.toISOString().slice(0, 10);
}

interface Props {
  entity: Entity;
  /** Documents the current value came from (empty when it was typed by hand or is missing). */
  sources: SourceRef[];
  citation: (ref: SourceRef) => number;
  onOpenSource: (ref: SourceRef) => void;
}

/**
 * Install date on a unit's page: shown for everyone, editable by any signed-in person who can edit facts
 * (the same people who can correct a field on a document). The save goes through reviewClient.setUnitInstallDate
 * (audited, stored as "entered by <name>", warranty re-derived server-side). The Dashboard's "Add install date"
 * opens this page with `entityFocusField === 'installDate'`, which opens the editor with the cursor in the box.
 */
export function InstallDateField({ entity, sources, citation, onOpenSource }: Props) {
  const setUnitInstallDate = useGraph((s) => s.setUnitInstallDate);
  const focusRequest = useAppStore((s) => s.entityFocusField);
  const clearFocusRequest = useAppStore((s) => s.clearEntityFocusField);
  const { userId, displayName, nameByUserId } = useMemberDirectory();

  const installDate = entity.fields.installDate instanceof Date && !Number.isNaN(entity.fields.installDate.getTime()) ? entity.fields.installDate : null;
  const isoValue = installDate ? installDate.toISOString().slice(0, 10) : '';
  const enteredBy = typeof entity.fields.installDateEnteredBy === 'string' ? entity.fields.installDateEnteredBy : null;
  const enteredById = typeof entity.fields.installDateEnteredById === 'string' ? entity.fields.installDateEnteredById : null;
  const enteredAt = typeof entity.fields.installDateEnteredAt === 'string' ? entity.fields.installDateEnteredAt : null;
  // Prefer the roster name for the person's id (the label a browser sends is display-only), fall back to the stored label.
  const enteredName = (enteredById && nameByUserId.get(enteredById)) || enteredBy;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(isoValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Deep link from the Dashboard: open the editor, put the cursor in the box, then consume the request.
  useEffect(() => {
    if (focusRequest !== 'installDate') return;
    setValue(isoValue);
    setEditing(true);
    clearFocusRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      editBtnRef.current?.focus();
    }
  }, [editing]);

  const startEdit = () => {
    setValue(isoValue);
    setError(null);
    setSavedNote(null);
    setEditing(true);
  };
  const cancel = () => {
    restoreFocus.current = true;
    setEditing(false);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!value) {
      setError('Pick the install date first.');
      inputRef.current?.focus();
      return;
    }
    if (value < INSTALL_DATE_MIN || value > installDateMax()) {
      setError(value < INSTALL_DATE_MIN ? 'That install date is too far back. Check the year.' : 'That install date is in the future. Check the year.');
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setUnitInstallDate(entity.id, value, displayName ?? 'Team member', userId);
      const after = useGraph.getState().entities[entity.id];
      const expiry = after?.fields.warrantyExpiry;
      setSavedNote(
        expiry instanceof Date
          ? `Saved. Warranty now ends ${formatYmd(expiry)}.`
          : 'Saved. DeepWell could not work out a warranty end date from it (no verified warranty term for this brand), so the unit stays under "No warranty on file".'
      );
      restoreFocus.current = true;
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the install date. Try again.');
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const provenance = enteredName
    ? `Entered by ${enteredName}${enteredAt ? ` on ${formatYmd(enteredAt)}` : ''}`
    : sources.length > 0
      ? 'From the documents below'
      : installDate
        ? 'Source not recorded'
        : null;

  return (
    <section aria-labelledby="install-date-heading" data-testid="install-date-field" className="dw-card p-4 space-y-2 min-h-[9.5rem]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="install-date-heading" className="dw-label flex items-center gap-2">
          <CalendarDays className="w-4 h-4" aria-hidden="true" /> Install date
        </h2>
        {!editing && (
          <button ref={editBtnRef} type="button" className="dw-btn-secondary !min-h-[44px] !py-1.5" onClick={startEdit}>
            <Pencil className="w-4 h-4" aria-hidden="true" /> {installDate ? 'Change install date' : 'Add install date'}
          </button>
        )}
      </div>

      {editing ? (
        <form noValidate onSubmit={(e) => void submit(e)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }} className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="dw-label block mb-1.5">Install date</span>
            <input
              ref={inputRef}
              type="date"
              className="dw-input !min-h-[44px]"
              value={value}
              min={INSTALL_DATE_MIN}
              max={installDateMax()}
              disabled={saving}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'install-date-error' : undefined}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <button type="submit" className="dw-btn-primary !min-h-[44px]" disabled={saving || !value}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="dw-btn-tertiary !min-h-[44px]" disabled={saving} onClick={cancel}>
            Cancel
          </button>
        </form>
      ) : (
        <p className="text-body-lg text-ink" data-testid="install-date-value">
          {installDate ? formatYmd(installDate) : <span className="text-ink-3">Not on file</span>}
        </p>
      )}

      {error && <p id="install-date-error" role="alert" className="text-caption text-warn-ink dark:text-brass-200">{error}</p>}
      {savedNote && !editing && <p role="status" className="text-caption text-ink-2">{savedNote}</p>}
      {!editing && provenance && (
        <p className="text-caption text-ink-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{provenance}</span>
          {sources.slice(0, 3).map((r, j) => (
            <button
              key={`${r.documentId}-${j}`}
              type="button"
              onClick={() => onOpenSource(r)}
              aria-label={`Open source ${citation(r)} for install date`}
              className="inline-flex items-center justify-center min-h-[32px] px-2 rounded-full border border-line text-ink-2 hover:text-ink underline-offset-2"
            >
              Source {citation(r)}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
