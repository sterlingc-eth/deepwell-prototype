import { Fragment, useState } from 'react';
import { Check, Lightbulb, Pencil, X } from 'lucide-react';
import { reviewClient, type FieldSuggestion } from '../../services/reviewClient';
import { dropSuggestion, loadFieldSuggestions, useFieldSuggestions } from './fieldSuggestStore';
import { SUGGEST_TEXT as T, prettyValue } from './fieldSuggestText';

const BY = 'You';
const pretty = prettyValue;
const shown = (s: FieldSuggestion) => (s.value && /^\d{4}-\d{2}-\d{2}$/.test(s.value) ? pretty(s.value) : s.value ?? '');

/** The quote with the suggested value (or the date written on the page) highlighted. */
export function QuoteWithHighlight({ quote, value }: { quote: string; value?: string }) {
  const dateTok = /\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}/.exec(quote);
  let start = -1, len = 0;
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { start = quote.toLowerCase().indexOf(value.toLowerCase()); len = value.length; }
  if (start < 0 && dateTok) { start = dateTok.index; len = dateTok[0].length; }
  if (start < 0) return <>{quote}</>;
  return <Fragment>{quote.slice(0, start)}<mark className="bg-brass-100 text-ink dark:bg-brass-800 dark:text-brass-100 rounded px-0.5">{quote.slice(start, start + len)}</mark>{quote.slice(start + len)}</Fragment>;
}

function Row({ s, onChanged }: { s: FieldSuggestion; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.value ?? '');
  const [pick, setPick] = useState<string | null>(null);

  const done = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await fn(); dropSuggestion(s.document_id, s.key); onChanged?.(); }
    catch (e) {
      if (/no longer open/i.test(String((e as Error)?.message ?? ''))) { dropSuggestion(s.document_id, s.key); setMsg(T.gone); } else setMsg(T.error);
      void loadFieldSuggestions([s.document_id], true);
    } finally { setBusy(false); }
  };

  const accept = () => {
    if (s.options && !pick) { setMsg(T.pickFirst); return; }
    void done(() => reviewClient.acceptFieldSuggestion(s.document_id, s.key, s.options ? pick! : undefined, BY));
  };
  const saveEdit = () => { const v = draft.trim(); if (v) void done(() => reviewClient.acceptFieldSuggestion(s.document_id, s.key, v, BY)); };

  return (
    <li className="rounded-lg border border-line bg-surface p-3 space-y-2" data-testid="field-suggestion">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <Lightbulb className="w-4 h-4 self-center text-accent" aria-hidden="true" />
        <span className="font-medium text-ink">{s.label}</span>
        {s.options ? null : <span className="text-ink">{T.suggested(shown(s))}</span>}
      </p>
      <p className="text-caption text-ink-3">{s.options ? T.hintDate : T.hint}</p>
      {s.options && (
        <div role="radiogroup" aria-label={s.label} className="flex flex-wrap gap-2">
          {s.options.map((o, i) => (
            <label key={o} className={['inline-flex items-center gap-2 rounded-md border px-3 min-h-[44px] cursor-pointer', pick === o ? 'border-forest-700 bg-forest-50 dark:bg-forest-800' : 'border-line'].join(' ')}>
              <input type="radio" name={`pick-${s.key}`} checked={pick === o} onChange={() => { setPick(o); setMsg(null); }} />
              <span>{pretty(o)} <span className="text-caption text-ink-3">({i === 0 ? T.monthFirst : T.dayFirst})</span></span>
            </label>
          ))}
        </div>
      )}
      <p className="text-caption text-ink-2"><span className="text-ink-3">{T.fromPage}</span> <q className="not-italic">&ldquo;<QuoteWithHighlight quote={s.quote} value={s.value} />&rdquo;</q></p>
      {editing ? (
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor={`edit-${s.key}`}>{T.editLabel(s.label)}</label>
          <input id={`edit-${s.key}`} className="dw-input !min-h-[44px]" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="button" className="dw-btn-primary !min-h-[44px]" disabled={busy || !draft.trim()} onClick={saveEdit}>{T.save}</button>
          <button type="button" className="dw-btn-tertiary !min-h-[44px]" disabled={busy} onClick={() => setEditing(false)}>{T.cancel}</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="dw-btn-primary !min-h-[44px]" disabled={busy} onClick={accept}><Check className="w-4 h-4" aria-hidden="true" /> {T.accept}</button>
          <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={busy} onClick={() => { setEditing(true); setDraft(s.value ?? pick ?? ''); }}><Pencil className="w-4 h-4" aria-hidden="true" /> {T.edit}</button>
          <button type="button" className="dw-btn-tertiary !min-h-[44px]" disabled={busy} onClick={() => void done(() => reviewClient.dismissFieldSuggestion(s.document_id, s.key))}><X className="w-4 h-4" aria-hidden="true" /> {T.dismiss}</button>
        </div>
      )}
      {msg && <p role="status" className="text-caption text-ink-2">{msg}</p>}
    </li>
  );
}

/** Open AI suggestions for one paper: Accept / Edit / Dismiss. Nothing is stored as a fact until Accept (or Save) is pressed. */
export function FieldSuggestions({ docId, onChanged }: { docId: string; onChanged?: () => void }) {
  const list = useFieldSuggestions(docId);
  if (!list.length) return null;
  return <ul aria-label="Suggested values" className="space-y-2" data-testid="field-suggestions">{list.map((s) => <Row key={s.key} s={s} onChanged={onChanged} />)}</ul>;
}
