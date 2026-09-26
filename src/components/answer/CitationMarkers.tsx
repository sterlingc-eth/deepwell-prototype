import { useId, useRef, useState } from 'react';
import type { SentenceCitation } from '../../core/answerLayout';
import { CitationPopover } from './CitationPopover';

/**
 * Superscript [1][2] markers after one sentence — the Anthropic-Citations/Perplexity pattern: tapping
 * a marker opens a quick preview (CitationPopover) instead of jumping straight to the document. Each
 * marker sits in its own `position: relative` wrapper so its popover can anchor directly under it.
 */
export function CitationMarkers({
  citations,
  onOpenDocument,
}: {
  citations: (SentenceCitation & { n: number })[];
  onOpenDocument: (documentId: string, page?: number) => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  if (!citations.length) return null;

  return (
    <span className="ml-0.5 inline-flex items-baseline gap-0.5">
      {citations.map((c, i) => {
        const popoverId = `${baseId}-${i}`;
        const open = openIndex === i;
        return (
          <span key={i} className="relative inline-block">
            <button
              ref={(el) => {
                triggerRefs.current[i] = el;
              }}
              type="button"
              aria-expanded={open}
              aria-describedby={open ? popoverId : undefined}
              aria-label={`Source ${c.n}${c.page != null ? `, page ${c.page}` : ''} — show preview`}
              onClick={() => setOpenIndex((cur) => (cur === i ? null : i))}
              className={[
                'align-super text-[0.7em] leading-none font-semibold rounded px-0.5 py-0.5 -my-0.5',
                'text-accent-ink underline decoration-dotted decoration-1 underline-offset-2',
                'hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              ].join(' ')}
            >
              [{c.n}]
            </button>
            {open && (
              <CitationPopover
                id={popoverId}
                citation={c}
                onClose={() => setOpenIndex(null)}
                onOpenDocument={onOpenDocument}
                returnFocusTo={() => triggerRefs.current[i] ?? null}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}
