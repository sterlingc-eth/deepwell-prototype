import { AlertCircle, CheckCircle2, Circle, Info, XCircle } from 'lucide-react';
import type { Fact, FactStatus, SourceRef } from '../../core/types';
import { SourceChip } from './SourceChip';

const STATUS_ICON: Record<FactStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertCircle, bad: XCircle, info: Info, muted: Circle };
// Light-mode: the same *-ink tokens dw-pill-* already uses as pill TEXT (AA against the pill's own
// bg, and darker still against the plain page bg). Dark-mode: the exact literal colors
// `.dark .dw-pill-*` use for pill text in src/index.css — reused here as text-only (no pill bg) at
// headline size, verified for contrast against --dw-surface by scripts/verify-answer-ui.mjs.
const STATUS_TEXT: Record<FactStatus, string> = {
  ok: 'text-ok-ink dark:text-[#b9e6c9]',
  warn: 'text-warn-ink dark:text-[#ffd98a]',
  bad: 'text-bad-ink dark:text-[#ffc1b8]',
  info: 'text-info-ink dark:text-[#c3d8ef]',
  muted: 'text-ink-3',
};
const PILL: Record<FactStatus, string> = { ok: 'dw-pill-ok', warn: 'dw-pill-warn', bad: 'dw-pill-bad', info: 'dw-pill-info', muted: 'dw-pill-muted' };

/**
 * 'money' layout: the amount IS the answer, so it leads — large, right-aligned, tabular numbers, with
 * its own citation chip(s) right under it. A status on the money fact itself (paid/overdue/etc., same
 * FactStatus every pill in the app uses) colors the number AND carries an icon, never color alone.
 * Everything else about the answer (a breakdown of other facts) reads as supporting detail underneath.
 */
export function MoneyHero({ facts, onOpenSource }: { facts: Fact[]; onOpenSource: (ref: SourceRef) => void }) {
  const primary = facts.find((f) => f.kind === 'money') ?? facts[0];
  if (!primary) return null;
  const rest = facts.filter((f) => f !== primary);
  const Icon = primary.status ? STATUS_ICON[primary.status] : null;

  return (
    <div className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="dw-label text-ink-3">{primary.label}</span>
        {primary.basis === 'computed' && <span className="text-caption text-ink-3 italic">calculated</span>}
      </div>
      <p
        data-testid="money-hero-amount"
        className={[
          'font-display text-h1 sm:text-display tabular-nums text-right leading-tight mt-1 flex items-center justify-end gap-2',
          primary.status && primary.status !== 'muted' ? STATUS_TEXT[primary.status] : 'text-ink',
        ].join(' ')}
      >
        {Icon && primary.status !== 'muted' && <Icon className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" aria-hidden="true" />}
        {primary.value}
      </p>
      {primary.sources.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5 mt-2">
          {primary.sources.slice(0, 3).map((s, i) => (
            <SourceChip key={`${s.documentId}-${i}`} source={s} onOpen={onOpenSource} compact />
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <dl className="mt-4 pt-3 border-t border-line divide-y divide-line">
          {rest.map((f, i) => (
            <div key={`${f.label}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
              <dt className="text-body text-ink-2 min-w-0">{f.label}</dt>
              <dd className="flex items-center flex-wrap justify-end gap-2 min-w-0 max-w-full">
                {f.status && f.status !== 'muted' ? (
                  <span className={PILL[f.status]}>{f.value}</span>
                ) : (
                  <span className={['text-body text-ink text-right tabular-nums', f.kind === 'money' ? 'font-medium' : ''].join(' ')}>{f.value}</span>
                )}
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
