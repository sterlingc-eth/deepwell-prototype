import { ArrowUpRight } from 'lucide-react';
import type { Fact, FactStatus, SourceRef } from '../core/types';
import { useGraph } from '../core/entityGraph';

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
  /** Filename (or other label) for a source, shown as the chip's tooltip so
   *  "[2]" reads as "[2] 48-invoice-whitmore.pdf" on hover/long-press. */
  sourceLabel?: (ref: SourceRef) => string | undefined;
  /** Breakdown keys that have records behind them (citation contract): their rows become filters. */
  groupKeys?: ReadonlySet<string>;
  activeGroup?: string | null;
  onSelectGroup?: (label: string) => void;
}

/**
 * Donovan analytics groupBy/list answers (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md)
 * arrive as ordinary facts — "Gilbert" / "5" — with no sources and no status
 * pill, same shape a meta-router count answer already used. Once there are
 * more than a few of them (a city/county/brand breakdown), the citation-chip
 * column buys nothing (there is nothing to cite) and the roomy per-row layout
 * below reads as a list, not a table. This is purely a rendering choice off
 * the EXISTING Fact shape — no new response type, no change to core/types.ts.
 */
const GROUP_TABLE_THRESHOLD = 5;

function isGroupLikeFact(f: Fact): boolean {
  return !f.status && f.sources.length === 0;
}

interface GroupSelect {
  groupKeys?: ReadonlySet<string> | undefined;
  activeGroup?: string | null | undefined;
  onSelectGroup?: ((label: string) => void) | undefined;
}

function GroupTable({ facts, onOpenEntity, groupKeys, activeGroup, onSelectGroup }: { facts: Fact[]; onOpenEntity?: (entityId: string) => void } & GroupSelect) {
  return (
    <dl className="border border-line rounded-lg bg-surface divide-y divide-line grid grid-cols-1 sm:grid-cols-2 max-h-[28rem] overflow-y-auto">
      {facts.map((f, i) => {
        const linkable = !!(f.entityId && onOpenEntity);
        const filterable = !!(onSelectGroup && groupKeys?.has(f.label));
        const active = filterable && activeGroup === f.label;
        return (
          <div
            key={`${f.label}-${i}`}
            className={[
              'flex items-baseline justify-between gap-3 px-3 py-1.5 border-b border-line sm:border-b-0 sm:odd:border-r sm:[&:nth-last-child(-n+2)]:border-b-0',
              active ? 'bg-surface-2' : '',
            ].join(' ')}
          >
            {filterable ? (
              // Breakdown row = a filter for the records list below: click / Enter / Space toggles it.
              <button
                type="button"
                onClick={() => onSelectGroup?.(f.label)}
                aria-pressed={active}
                aria-label={`${f.label}: ${f.value}. Show these records`}
                className="w-full flex items-baseline justify-between gap-3 text-left min-h-[28px] hover:text-ink"
              >
                <span className="text-body text-ink-2 truncate">{f.label}</span>
                <span className="font-mono text-data text-ink underline decoration-line-2 underline-offset-4">{f.value}</span>
              </button>
            ) : (
              <dt className="text-body text-ink-2 truncate">{f.label}</dt>
            )}
            {filterable ? null : linkable ? (
              <button
                type="button"
                onClick={() => f.entityId && onOpenEntity?.(f.entityId)}
                className="font-mono text-data text-ink underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 dark:hover:decoration-brass-300"
              >
                {f.value}
              </button>
            ) : (
              <dd className="font-mono text-data text-ink">{f.value}</dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Key/value grid of the records an answer is built from. Status facts render
 * as pills (with text — colour is never the only signal). Each row shows its
 * citation numbers; tapping one opens that document at the cited field.
 */
export function FactGrid({ facts, citation, onOpenSource, onOpenEntity, sourceLabel, groupKeys, activeGroup, onSelectGroup }: FactGridProps) {
  const docs = useGraph((s) => s.docs);
  const schema = useGraph((s) => s.schema);
  if (!facts.length) return null;

  // A groupBy/list breakdown (many sourceless, statusless rows) renders as a
  // dense two-column table instead of the citation-oriented grid below.
  if (facts.length > GROUP_TABLE_THRESHOLD && facts.every(isGroupLikeFact)) {
    return (
      <section aria-labelledby="facts-heading">
        <div className="mb-2">
          <h3 id="facts-heading" className="dw-label">Breakdown</h3>
        </div>
        <GroupTable facts={facts} onOpenEntity={onOpenEntity} groupKeys={groupKeys} activeGroup={activeGroup} onSelectGroup={onSelectGroup} />
      </section>
    );
  }
  // Owner follow-up (2026-09-21): "signify the citations better". A bare
  // [2] is a footnote; "2 · Invoice" says what kind of page backs the fact
  // before you tap. Type label from the graph; filename in the tooltip.
  const typeOf = (ref: SourceRef): string | undefined => {
    const doc = docs[ref.documentId];
    if (!doc) return undefined;
    return schema.documentTypes.find((t) => t.id === doc.typeId)?.label ?? 'Document';
  };
  const nameOf = (ref: SourceRef): string | undefined => sourceLabel?.(ref) ?? docs[ref.documentId]?.filename;
  return (
    <section aria-labelledby="facts-heading">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="facts-heading" className="dw-label">
          Linked facts
        </h3>
        {/* Owner question (2026-09-21): "what are those numbers on the side?"
            — they are the source documents, numbered to match the list
            further down the page. Say so where the eye lands. */}
        <p className="text-caption text-ink-3">
          Numbered chips = the document each fact came from · tap to open the page
        </p>
      </div>
      <dl className="border border-line rounded-lg bg-surface divide-y divide-line">
        {facts.map((f, i) => {
          const refs = f.sources;
          const linkable = !!(f.entityId && onOpenEntity);
          return (
            <div key={`${f.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(140px,30%)_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-3 py-2.5 items-baseline">
              <dt className="text-body text-ink-3 sm:text-body-lg field:text-body-lg col-span-2 sm:col-span-1">{f.label}</dt>
              <dd className="min-w-0 text-ink">
                {f.status ? (
                  <span className={PILL[f.status]}>{f.value}</span>
                ) : onSelectGroup && groupKeys?.has(f.label) ? (
                  <button
                    type="button"
                    onClick={() => onSelectGroup(f.label)}
                    aria-pressed={activeGroup === f.label}
                    aria-label={`${f.label}: ${f.value}. Show these records`}
                    className="inline-flex items-center gap-1 text-left underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 dark:hover:decoration-brass-300 min-h-[32px]"
                  >
                    {f.value}
                  </button>
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
              <dd className="flex gap-1.5 justify-end flex-wrap">
                {refs.slice(0, 3).map((r, j) => {
                  const n = citation(r);
                  const kind = typeOf(r);
                  const name = nameOf(r);
                  return (
                    <button
                      key={`${r.documentId}-${j}`}
                      type="button"
                      onClick={() => onOpenSource(r)}
                      aria-label={`Open source ${n}${kind ? ` (${kind})` : ''} for ${f.label}${name ? ` — ${name}` : ''}`}
                      title={name ? `Source ${n}${kind ? ` · ${kind}` : ''}: ${name}` : `Source ${n}`}
                      className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-full border border-brass-300/70 dark:border-brass-300/40 bg-brass-50 dark:bg-forest-800 text-ink-2 hover:text-ink hover:border-brass-500 dark:hover:border-brass-200 transition-colors duration-quick text-caption"
                    >
                      <span className="font-mono grid place-items-center w-5 h-5 rounded-full bg-brass-500 text-white dark:bg-brass-300 dark:text-forest-900 text-[11px] leading-none">
                        {n}
                      </span>
                      {kind && <span className="hidden sm:inline whitespace-nowrap">{kind}</span>}
                    </button>
                  );
                })}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
