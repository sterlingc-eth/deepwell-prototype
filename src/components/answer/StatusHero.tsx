import { AlertCircle, CheckCircle2, Circle, Info, XCircle } from 'lucide-react';
import type { Fact, FactStatus, SourceRef } from '../../core/types';
import { SourceChip } from './SourceChip';
import { CopyValueButton } from './CopyValueButton';

const STATUS_ICON: Record<FactStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertCircle, bad: XCircle, info: Info, muted: Circle };
// Same reuse-the-pill's-own-colors approach as MoneyHero — see that file's comment.
const STATUS_TEXT: Record<FactStatus, string> = {
  ok: 'text-ok-ink dark:text-[#b9e6c9]',
  warn: 'text-warn-ink dark:text-[#ffd98a]',
  bad: 'text-bad-ink dark:text-[#ffc1b8]',
  info: 'text-info-ink dark:text-[#c3d8ef]',
  muted: 'text-ink-3',
};
const STATUS_BG: Record<FactStatus, string> = {
  ok: 'bg-ok-bg dark:bg-[#16432a]',
  warn: 'bg-warn-bg dark:bg-[#4d3300]',
  bad: 'bg-bad-bg dark:bg-[#5a1a13]',
  info: 'bg-info-bg dark:bg-[#0e3057]',
  muted: 'bg-surface-2',
};

const COPYABLE = /serial|model|imei|vin|account/i;

/**
 * 'status' layout (warranty/maintenance/coverage): the state leads — a large icon + word, colored AND
 * labelled (never color alone) — with why right underneath (the facts that explain it: dates, the
 * document it came from) and a copy button on any serial/model/account fact so a tech never retypes
 * one off a cracked screen.
 */
export function StatusHero({ facts, onOpenSource }: { facts: Fact[]; onOpenSource: (ref: SourceRef) => void }) {
  const primary = facts.find((f) => f.status && f.status !== 'muted') ?? facts[0];
  if (!primary) return null;
  const rest = facts.filter((f) => f !== primary);
  const status = primary.status ?? 'muted';
  const Icon = STATUS_ICON[status];

  return (
    <div className={['rounded-lg border border-line p-4 sm:p-5', STATUS_BG[status]].join(' ')}>
      <div className="flex items-center gap-3">
        <Icon className={['w-8 h-8 sm:w-10 sm:h-10 shrink-0', STATUS_TEXT[status]].join(' ')} aria-hidden="true" />
        <div className="min-w-0">
          <p className="dw-label text-ink-3">{primary.label}</p>
          <p data-testid="status-hero-value" className={['font-display text-h2 sm:text-h1 leading-tight', STATUS_TEXT[status]].join(' ')}>{primary.value}</p>
        </div>
      </div>
      {primary.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {primary.sources.slice(0, 3).map((s, i) => (
            <SourceChip key={`${s.documentId}-${i}`} source={s} onOpen={onOpenSource} compact />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <dl className="mt-4 pt-3 border-t border-line/70 divide-y divide-line/70">
          {rest.slice(0, 4).map((f, i) => (
            <div key={`${f.label}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <dt className="text-body text-ink-2 min-w-0 truncate">{f.label}</dt>
              <dd className="flex items-center flex-wrap justify-end gap-1 min-w-0 max-w-full">
                <span className="text-body text-ink font-medium">{f.value}</span>
                {COPYABLE.test(f.label) && <CopyValueButton value={f.value} label={f.label} />}
                {f.sources.slice(0, 1).map((s, j) => (
                  <SourceChip key={`${s.documentId}-${j}`} source={s} onOpen={onOpenSource} compact />
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
