import { useGraph } from '../../core/entityGraph';
import { documentName } from '../../core/documentName';

/**
 * The compact "Sources" strip under an answer's text (R13H1): one numbered chip per unique document
 * cited by a sentence marker, in the same [1][2] order the markers use — tapping a chip opens that
 * document directly (no preview step; the marker's own popover already offers the quick preview).
 */
export function CitationSourceStrip({
  order,
  onOpenDocument,
}: {
  /** documentId in [1][2][3]... order — see src/core/answerLayout.ts's numberCitations. */
  order: readonly string[];
  onOpenDocument: (documentId: string) => void;
}) {
  const docs = useGraph((s) => s.docs);
  if (!order.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="citation-source-strip">
      <span className="dw-label text-ink-3 mr-0.5">Sources</span>
      {order.map((documentId, i) => {
        const doc = docs[documentId];
        const label = doc ? documentName(doc) : 'Document';
        return (
          <button
            key={documentId}
            type="button"
            onClick={() => onOpenDocument(documentId)}
            title={label}
            className="inline-flex items-center gap-1 min-h-[28px] max-w-[12rem] rounded-full border border-line bg-surface-2 px-2.5 text-caption text-ink-2 hover:text-ink hover:border-line-2 transition-colors duration-quick"
          >
            <span className="font-mono text-ink-3 shrink-0">[{i + 1}]</span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
