import { useEffect, useRef } from 'react';
import { FileText, X } from 'lucide-react';
import { useGraph } from '../../core/entityGraph';
import { documentName } from '../../core/documentName';
import type { SentenceCitation } from '../../core/answerLayout';

/** doc.preview (see DocumentPreview.tsx) is a plain-text "label: value" dump of what was extracted —
 *  there is no page-scoped text to slice client-side, so the best honest fallback (when the server
 *  didn't have a real page quote to send — see sentences.js's sync/async split) is a short excerpt of
 *  the document's own extracted lines, never anything invented. */
function clientFallbackQuote(previewText: string | undefined): string | undefined {
  if (!previewText) return undefined;
  const lines = previewText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const joined = lines.slice(0, 3).join(' · ');
  return joined.length > 200 ? `${joined.slice(0, 199)}…` : joined;
}

export interface CitationPopoverProps {
  citation: SentenceCitation;
  onClose: () => void;
  onOpenDocument: (documentId: string, page?: number) => void;
  /** Resolves the element to return focus to when this closes (the marker button that opened it) —
   *  a getter, not the element itself: reading a ref's `.current` is only safe outside of render. */
  returnFocusTo?: () => HTMLElement | null;
  /** Element id this popover's content lives at, for the trigger's aria-describedby. */
  id: string;
}

/**
 * The "quick preview" every citation marker opens: the quoted passage (server-computed, verbatim from
 * the source page — see api/_lib/citations/sentences.js — or, absent one, a short client-side excerpt
 * of the document's own extracted text, never fabricated), the document's name, its page, and one tap
 * to the full page. Positions as a small anchored popover on desktop (the marker sits inside a
 * `position: relative` wrapper — see CitationMarkers.tsx) and a bottom sheet on a narrow/phone
 * viewport, same responsive pattern DocumentPreview already uses for its own modal.
 */
export function CitationPopover({ citation, onClose, onOpenDocument, returnFocusTo, id }: CitationPopoverProps) {
  const doc = useGraph((s) => s.docs[citation.documentId]);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')).filter(
          (el) => !el.hasAttribute('disabled')
        );
        if (!focusables.length) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Capture phase: this can be nested inside other keydown listeners (AnswerCard, DocumentPreview);
    // Escape here must close only the popover, never bubble into something else's handler.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      returnFocusTo?.()?.focus?.();
    };
  }, [onClose, returnFocusTo]);

  const name = doc ? documentName(doc) : 'Document';
  const quote = citation.quote ?? clientFallbackQuote(doc?.preview);

  return (
    <>
      {/* Backdrop: dims the page behind the mobile bottom sheet; invisible (but still click-to-close)
          on desktop, where the popover is small and anchored instead of covering the screen. */}
      <button
        type="button"
        aria-label="Close citation preview"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-stone-950/40 sm:bg-transparent"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={`Citation: ${name}`}
        className={[
          'fixed inset-x-0 bottom-0 z-50 rounded-t-xl border border-line bg-surface p-4 shadow-modal animate-rise',
          'sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:left-0 sm:mt-2 sm:w-80 sm:rounded-xl',
        ].join(' ')}
      >
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 w-4 h-4 shrink-0 text-ink-3" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink truncate">{name}</p>
            {citation.page != null && <p className="text-caption text-ink-3">Page {citation.page}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-tap-target="true"
            className="-mr-1.5 -mt-1.5 min-h-touch min-w-touch grid place-items-center rounded-md text-ink-3 hover:bg-surface-2"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {quote ? (
          <blockquote className="mt-3 border-l-2 border-line-2 pl-3 text-body text-ink-2 italic">“{quote}”</blockquote>
        ) : (
          <p className="mt-3 text-body text-ink-3">Open the document to see the page.</p>
        )}

        <button
          type="button"
          data-tap-target="true"
          className="dw-btn-secondary mt-3 w-full min-h-touch justify-center"
          onClick={() => {
            onOpenDocument(citation.documentId, citation.page);
            onClose();
          }}
        >
          Open document
        </button>
      </div>
    </>
  );
}
