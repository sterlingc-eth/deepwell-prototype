import type { Fact, SourceRef } from '../../core/types';
import { SourceChip } from './SourceChip';
import { CopyValueButton } from './CopyValueButton';

const COPYABLE = /serial|model|imei|vin|account/i;

/**
 * 'single-fact' layout: one plain question, one answer — a big value, its label, and one source chip.
 * A serial/model/account number also gets a copy button (retyping one off a screen with gloves on is
 * the exact friction this layout exists to remove).
 */
export function SingleFactHero({ fact, onOpenSource }: { fact: Fact; onOpenSource: (ref: SourceRef) => void }) {
  const copyable = COPYABLE.test(fact.label) || fact.kind === 'serial';
  return (
    <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <p className="dw-label text-ink-3">{fact.label}</p>
      <div className="flex items-center gap-1 mt-1">
        <p className={['font-display text-h1 sm:text-display leading-tight text-ink break-words', fact.kind === 'serial' ? 'font-mono text-[0.85em]' : ''].join(' ')}>
          {fact.value}
        </p>
        {copyable && <CopyValueButton value={fact.value} label={fact.label} />}
      </div>
      {fact.basis === 'computed' && <p className="text-caption text-ink-3 italic mt-1">calculated</p>}
      {fact.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {fact.sources.slice(0, 3).map((s, i) => (
            <SourceChip key={`${s.documentId}-${i}`} source={s} onOpen={onOpenSource} />
          ))}
        </div>
      )}
    </div>
  );
}
