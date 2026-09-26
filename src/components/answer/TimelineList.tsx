import type { Fact, SourceRef } from '../../core/types';
import { humanDateWithRelative } from './dates';
import { SourceChip } from './SourceChip';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^[A-Z][a-z]{2,8} \d{1,2},? \d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function dateOf(f: Fact): string | null {
  if (ISO_DATE.test(f.value) || DATE_LIKE.test(f.value.trim())) return f.value;
  return null;
}

/**
 * 'timeline' layout: a history of dated events (visits, service calls) as a vertical list, most recent
 * first, each with its evidence a tap away. Falls back to the fact's own label order for any entry
 * whose value isn't itself a parseable date (kept in place rather than dropped).
 */
export function TimelineList({ facts, onOpenSource }: { facts: Fact[]; onOpenSource: (ref: SourceRef) => void }) {
  const rows = facts
    .map((f, i) => ({ f, i, date: dateOf(f) }))
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return a.i - b.i;
    });

  return (
    <ol className="relative border-l border-line pl-5 space-y-4" aria-label="Timeline">
      {rows.map(({ f, i, date }) => (
        <li key={`${f.label}-${i}`} className="relative">
          <span className="absolute -left-[1.34rem] top-1.5 w-2.5 h-2.5 rounded-full bg-accent" aria-hidden="true" />
          <p className="text-body-lg font-medium text-ink">{date ? humanDateWithRelative(date) : f.label}</p>
          <p className="text-body text-ink-2 break-words">{date ? f.label : f.value}</p>
          {f.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {f.sources.slice(0, 3).map((s, j) => (
                <SourceChip key={`${s.documentId}-${j}`} source={s} onOpen={onOpenSource} compact />
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
