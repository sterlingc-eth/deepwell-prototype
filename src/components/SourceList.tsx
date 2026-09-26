import { FileText, Image as ImageIcon, Table2, FileType2 } from 'lucide-react';
import type { Doc, SourceRef } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { StagePill } from './StagePill';
import { documentName, hasFriendlyName, originalFilename } from '../core/documentName';

const FILE_ICON: Record<Doc['fileType'], typeof FileText> = {
  pdf: FileText,
  image: ImageIcon,
  spreadsheet: Table2,
  text: FileType2,
};

export function locationLabel(loc: SourceRef['location']): string {
  const parts: string[] = [];
  if (loc.page) parts.push(`p. ${loc.page}`);
  if (loc.field) parts.push(loc.field);
  if (loc.region) parts.push(loc.region);
  return parts.join(' · ');
}

interface SourceListProps {
  sources: SourceRef[];
  onOpen: (ref: SourceRef) => void;
  /** Heading override, e.g. "Closest documents" */
  title?: string;
  emptyText?: string;
}

/**
 * Every document an answer drew from, with where on the page the fact came
 * from. One tap opens the original.
 */
export function SourceList({ sources, onOpen, title = 'Sources', emptyText = 'No documents cited.' }: SourceListProps) {
  const docs = useGraph((s) => s.docs);

  // Group refs by document, keep citation order
  const grouped = new Map<string, SourceRef[]>();
  for (const ref of sources) {
    const list = grouped.get(ref.documentId) ?? [];
    list.push(ref);
    grouped.set(ref.documentId, list);
  }

  return (
    <section aria-labelledby="sources-heading">
      <h3 id="sources-heading" className="dw-label mb-2">
        {title} <span className="text-ink-3 normal-case font-normal">· {grouped.size}</span>
      </h3>
      {grouped.size === 0 ? (
        <p className="text-ink-3">{emptyText}</p>
      ) : (
        <ol className="divide-y divide-line border border-line rounded-lg bg-surface">
          {Array.from(grouped.entries()).map(([docId, refs], i) => {
            const doc = docs[docId];
            if (!doc) return null;
            const Icon = FILE_ICON[doc.fileType];
            const first = refs[0];
            return (
              <li key={docId}>
                <button
                  type="button"
                  onClick={() => first && onOpen(first)}
                  className="w-full text-left flex items-start gap-3 px-3 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick rounded-lg"
                >
                  <span className="mt-0.5 w-7 h-7 rounded-md bg-surface-2 grid place-items-center shrink-0 text-ink-2">
                    <Icon className="w-4 h-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-ink truncate">
                        <span className="text-ink-3 font-mono text-data mr-1.5">[{i + 1}]</span>
                        {documentName(doc)}
                      </span>
                      <StagePill stage={doc.stage} />
                    </span>
                    {hasFriendlyName(doc) && (
                      <span className="block text-body text-ink-3 truncate font-mono">{originalFilename(doc)}</span>
                    )}
                    <span className="block text-body text-ink-2 mt-1">
                      {refs
                        .map((r) => locationLabel(r.location))
                        .filter(Boolean)
                        .filter((v, idx, arr) => arr.indexOf(v) === idx)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
