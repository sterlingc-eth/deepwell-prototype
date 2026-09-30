import { useId, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import type { Answer } from '../../core/types';
import { replacedOnLabel, supersededOf, whyThisAnswer } from '../../core/answerLayout';
import { useGraph } from '../../core/entityGraph';
import { documentName } from '../../core/documentName';

/** R31 3d kill switch: VITE_ANSWER_WHY=0 hides the "Why this answer?" affordance (the superseded note is separate). */
function whyOn(): boolean {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ANSWER_WHY !== '0';
  } catch {
    return true;
  }
}

const DOT: Record<string, string> = { high: 'bg-ok', medium: 'bg-warn', low: 'bg-bad' };

/**
 * Two small trust signals under an answer, shared by desktop AnswerCard and MobileAnswer:
 *  - R31 3b: "replaced on <date>" for any cited document a newer copy has superseded, with the newer copy one tap away.
 *  - R31 3d: a collapsed "Why this answer?" with a confidence band and only the reasons the answer itself carries.
 * Everything is 44px-tall to tap, collapsed by default, and renders from props at mount (no layout shift).
 */
export function AnswerTrust({ answer, onOpenDocument }: { answer: Answer; onOpenDocument: (documentId: string) => void }) {
  const docs = useGraph((s) => s.docs);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const notes = supersededOf(answer);
  const why = whyOn() ? whyThisAnswer(answer) : null;
  if (!notes.length && !why) return null;
  const nameOf = (id: string, fallback?: string | null) => {
    const d = docs[id];
    return d ? documentName(d) : (fallback ?? 'the newer copy');
  };
  return (
    <div className="mt-1">
      {notes.map((n) => (
        <p key={n.documentId} className="m-0 flex flex-wrap items-center gap-x-2 text-caption text-warn-ink dark:text-brass-200" data-testid="answer-superseded">
          <History className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            {docs[n.documentId] ? `“${nameOf(n.documentId)}”` : 'A source'} was replaced on {replacedOnLabel(n.replacedOn)}.
          </span>
          <button
            type="button"
            data-tap-target="true"
            className="min-h-touch inline-flex items-center font-semibold underline underline-offset-2"
            onClick={() => onOpenDocument(n.replacedById)}
          >
            Open {n.replacedByName ? 'newer copy' : 'the newer copy'}
          </button>
        </p>
      ))}
      {why && (
        <div>
          <button
            type="button"
            data-tap-target="true"
            data-testid="answer-why-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="min-h-touch inline-flex items-center gap-2 text-caption text-ink-3 hover:text-ink"
          >
            <span className={`inline-block w-2 h-2 rounded-full ${DOT[why.level]}`} aria-hidden="true" />
            <span>{why.levelLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="underline underline-offset-2">Why this answer?</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {open && (
            <ul id={panelId} data-testid="answer-why" className="m-0 mb-1 pl-5 list-disc space-y-1 text-caption text-ink-2">
              {why.lines.length ? why.lines.map((l, i) => <li key={i}>{l}</li>) : <li>Answered directly from your records.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
