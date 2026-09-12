import { ArrowUpRight } from 'lucide-react';
import type { Fact, FactStatus, SourceRef } from '../core/types';

const PILL: Record<FactStatus, string> = {
  ok: 'dw-pill-ok',
  warn: 'dw-pill-warn',
  bad: 'dw-pill-bad',
  info: 'dw-pill-info',
  muted: 'dw-pill-muted',
};

interface FactGridProps {
  facts: Fact[];
  /** Map of documentId → citation number, so facts can show [2] */
  citation: (ref: SourceRef) => number;
  onOpenSource: (ref: SourceRef) => void;
  onOpenEntity?: (entityId: string) => void;
}

/**
 * Key/value grid of the records an answer is built from. Status facts render
 * as pills (with text — colour is never the only signal). Each row shows its
 * citation numbers; tapping one opens that document at the cited field.
 */
export function FactGrid({ facts, citation, onOpenSource, onOpenEntity }: FactGridProps) {
  if (!facts.length) return null;
  return (
    <section aria-labelledby="facts-heading">
      <h3 id="facts-heading" className="dw-label mb-2">
        Linked facts
      </h3>
      <dl className="border border-line rounded-lg bg-surface divide-y divide-line">
        {facts.map((f, i) => {
          const refs = f.sources;
          const linkable = !!(f.entityId && onOpenEntity);
          return (
            <div key={`${f.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(140px,30%)_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-3 py-2.5 items-baseline">
              <dt className="text-body text-ink-3 sm:text-body-lg dark:text-body-lg col-span-2 sm:col-span-1">{f.label}</dt>
              <dd className="min-w-0 text-ink">
                {f.status ? (
                  <span className={PILL[f.status]}>{f.value}</span>
                ) : linkable ? (
                  <button
                    type="button"
                    onClick={() => f.entityId && onOpenEntity?.(f.entityId)}
                    className={[
                      'inline-flex items-center gap-1 text-left underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 dark:hover:decoration-brass-300 min-h-[32px]',
                      f.kind === 'serial' || f.kind === 'money' ? 'font-mono text-data sm:text-body-lg' : '',
                    ].join(' ')}
                  >
                    {f.value}
                    <ArrowUpRight className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
                  </button>
                ) : (
                  <span className={f.kind === 'serial' || f.kind === 'money' ? 'font-mono' : ''}>{f.value}</span>
                )}
              </dd>
              <dd className="flex gap-1 justify-end">
                {refs.slice(0, 3).map((r, j) => (
                  <button
                    key={`${r.documentId}-${j}`}
                    type="button"
                    onClick={() => onOpenSource(r)}
                    aria-label={`Open source ${citation(r)} for ${f.label}`}
                    className="font-mono text-caption text-ink-3 hover:text-ink border border-line hover:border-line-2 rounded-sm min-w-[28px] h-7 px-1.5 grid place-items-center transition-colors duration-quick"
                  >
                    [{citation(r)}]
                  </button>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
