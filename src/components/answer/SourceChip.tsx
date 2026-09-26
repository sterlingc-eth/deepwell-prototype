import { FileText } from 'lucide-react';
import type { SourceRef } from '../../core/types';
import { useGraph } from '../../core/entityGraph';
import { documentName } from '../../core/documentName';
import { locationLabel } from '../SourceList';

/**
 * One tappable citation, used by every answer-layout hero (money/status/single-fact/timeline) so a
 * fact's evidence is never more than a tap away, wherever the hero puts it. Same 44px-tall target and
 * "type · name" tooltip as FactGrid's own numbered chips, just without requiring a citation number
 * (a hero's single source chip doesn't need one).
 */
export function SourceChip({ source, onOpen, compact = false }: { source: SourceRef; onOpen: (ref: SourceRef) => void; compact?: boolean }) {
  const docs = useGraph((s) => s.docs);
  const schema = useGraph((s) => s.schema);
  const doc = docs[source.documentId];
  const typeLabel = doc ? (schema.documentTypes.find((t) => t.id === doc.typeId)?.label ?? 'Document') : 'Document';
  const name = doc ? documentName(doc) : undefined;
  const where = locationLabel(source.location);
  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={name ? `${typeLabel}: ${name}${where ? ` · ${where}` : ''}` : typeLabel}
      className={[
        // min-w-0 lets this shrink (and its truncated label actually truncate) inside a flex row that
        // does not itself have room to spare — without it a flex child's default min-width:auto keeps
        // it at its full content width and the ROW overflows the viewport instead.
        'inline-flex items-center gap-1.5 min-h-[32px] min-w-0 max-w-full rounded-full border border-brass-300/70 dark:border-brass-300/40',
        'bg-brass-50 dark:bg-forest-800 text-ink-2 hover:text-ink hover:border-brass-500 dark:hover:border-brass-200',
        'transition-colors duration-quick text-caption',
        compact ? 'pl-2 pr-2.5' : 'pl-2.5 pr-3',
      ].join(' ')}
    >
      <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className={['truncate', compact ? 'max-w-[8rem]' : 'max-w-[14rem]'].join(' ')}>{name ?? typeLabel}</span>
      {where && !compact && <span className="text-ink-3 whitespace-nowrap shrink-0">· {where}</span>}
    </button>
  );
}
