import { useMemo, useState } from 'react';
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

// Owner report (2026-09-25): a warranty breakdown ("Carlos Ramirez" -> "active warranty, expires
// 2031-02-15") rendered as a cramped 2-column grid that TRUNCATED every name ("Carlos Ra…") next to a
// monospace, underlined value — unreadable, and looked like a broken link. A breakdown whose values
// name a status word (active/expiring/expired/unknown) gets the richer, full-width treatment below
// instead: full names that wrap, a real status pill, a humanized date, sorted/grouped by status, capped
// at 12 rows with "Show all N". Any other breakdown (a city/brand/month count) keeps the plain 2-column
// grid, just without the truncation/monospace/underline this same defect report flagged there too.
const STATUS_WORD: Record<string, { status: FactStatus; label: string }> = {
  active: { status: 'ok', label: 'Active' },
  current: { status: 'ok', label: 'Active' },
  valid: { status: 'ok', label: 'Active' },
  expiring: { status: 'warn', label: 'Expiring soon' },
  expired: { status: 'bad', label: 'Expired' },
  unknown: { status: 'muted', label: 'Unknown' },
};
const STATUS_GROUP_ORDER: FactStatus[] = ['warn', 'bad', 'ok', 'muted'];
const STATUS_ROWS_INITIAL_CAP = 12;

interface ParsedStatus {
  status: FactStatus;
  statusLabel: string;
  dateIso?: string;
}

function parseStatusValue(value: string): ParsedStatus | null {
  const m = value.match(/\b(active|current|valid|expiring|expired|unknown)\b/i);
  const key = m?.[1]?.toLowerCase();
  const meta = key ? STATUS_WORD[key] : undefined;
  if (!meta) return null;
  const dateMatch = value.match(/\d{4}-\d{2}-\d{2}/);
  return { status: meta.status, statusLabel: meta.label, ...(dateMatch ? { dateIso: dateMatch[0] } : {}) };
}

function humanizeDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "in 4 months" / "this month" / "3 months ago" — omitted (null) once it's far enough out that a
 *  bare date reads better than a big month count. */
function relativeDateNote(iso: string, status: FactStatus): string | null {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const months = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  if (status === 'bad') {
    const ago = -months;
    return ago > 0 && ago < 24 ? `${ago} month${ago === 1 ? '' : 's'} ago` : null;
  }
  if (months < 0 || months >= 24) return null;
  return months === 0 ? 'this month' : `in ${months} month${months === 1 ? '' : 's'}`;
}

function StatusBreakdownTable({ facts, onOpenEntity }: { facts: Fact[]; onOpenEntity?: (entityId: string) => void }) {
  const [sortByDate, setSortByDate] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const byStatus = new Map<FactStatus, { fact: Fact; parsed: ParsedStatus }[]>();
    for (const fact of facts) {
      const parsed = parseStatusValue(fact.value) ?? { status: 'muted' as FactStatus, statusLabel: 'Unknown' };
      if (!byStatus.has(parsed.status)) byStatus.set(parsed.status, []);
      byStatus.get(parsed.status)!.push({ fact, parsed });
    }
    const order = STATUS_GROUP_ORDER.filter((s) => byStatus.has(s));
    if (sortByDate) {
      for (const s of order) byStatus.get(s)!.sort((a, b) => (a.parsed.dateIso ?? '').localeCompare(b.parsed.dateIso ?? ''));
    }
    return order.flatMap((status) => byStatus.get(status)!.map((r) => ({ ...r, groupStatus: status, groupCount: byStatus.get(status)!.length })));
  }, [facts, sortByDate]);

  const capped = !showAll && rows.length > STATUS_ROWS_INITIAL_CAP;
  const visible = capped ? rows.slice(0, STATUS_ROWS_INITIAL_CAP) : rows;
  const multiGroup = new Set(rows.map((r) => r.groupStatus)).size > 1;

  return (
    <section aria-labelledby="facts-heading">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="facts-heading" className="dw-label">Breakdown</h3>
        <button
          type="button"
          onClick={() => setSortByDate((v) => !v)}
          aria-pressed={sortByDate}
          className="text-caption text-ink-2 hover:text-ink underline decoration-line-2 underline-offset-4 min-h-[28px]"
        >
          {sortByDate ? 'Sorted by date ✓' : 'Sort by date'}
        </button>
      </div>
      <div className="border border-line rounded-lg bg-surface divide-y divide-line overflow-hidden">
        {visible.map((r, i) => {
          const showHeading = multiGroup && r.groupStatus !== visible[i - 1]?.groupStatus;
          const linkable = !!(r.fact.entityId && onOpenEntity);
          const dateText = r.parsed.dateIso ? humanizeDate(r.parsed.dateIso) : null;
          const relNote = r.parsed.dateIso ? relativeDateNote(r.parsed.dateIso, r.parsed.status) : null;
          const row = (
            // Owner report (2026-09-25), mobile pass: sharing one flex row with the pill+date squeezed
            // a long name ("Kimberly Ostrowski-Vance") into a sliver of width and it broke mid-word on
            // 375px. Stacked below `xs` (420px, tailwind.config.ts) so the name always gets the full
            // row width to wrap on whole words; side by side once there is room.
            <div className="flex flex-col xs:flex-row xs:items-center xs:justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 min-h-[44px] w-full text-left">
              <span className="min-w-0 text-body text-ink break-words">{r.fact.label}</span>
              <span className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={PILL[r.parsed.status]}>{r.parsed.statusLabel}</span>
                {dateText && (
                  <span className="text-caption text-ink-3 whitespace-nowrap">
                    {r.parsed.status === 'bad' ? 'expired ' : 'until '}{dateText}{relNote ? ` · ${relNote}` : ''}
                  </span>
                )}
              </span>
            </div>
          );
          return (
            <div key={`${r.fact.label}-${i}`}>
              {showHeading && (
                <div className="px-3 pt-2.5 pb-1 bg-surface-2/60">
                  <p className="dw-label text-ink-3">{r.parsed.statusLabel} <span className="normal-case font-normal">· {r.groupCount}</span></p>
                </div>
              )}
              {linkable ? (
                <button type="button" onClick={() => r.fact.entityId && onOpenEntity?.(r.fact.entityId)} className="w-full hover:bg-surface-2 transition-colors duration-quick">
                  {row}
                </button>
              ) : row}
            </div>
          );
        })}
      </div>
      {capped && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 text-caption text-ink-2 hover:text-ink underline decoration-line-2 underline-offset-4 min-h-[28px]"
        >
          Show all {rows.length}
        </button>
      )}
    </section>
  );
}

function GroupTable({ facts, onOpenEntity, groupKeys, activeGroup, onSelectGroup }: { facts: Fact[]; onOpenEntity?: (entityId: string) => void } & GroupSelect) {
  // A status-shaped breakdown (most values name active/expiring/expired/unknown) gets the richer table
  // above instead of the plain numeric grid below. Excluded only when a fact's LABEL is itself an
  // active breakdown-filter key (a real "grouped by warranty status" count, e.g. "Active" -> "10") —
  // that is a different shape (a bucket count, not a per-customer status) and keeps the plain grid.
  const anyFilterable = !!(onSelectGroup && groupKeys && facts.some((f) => groupKeys.has(f.label)));
  const statusLike = !anyFilterable && facts.filter((f) => parseStatusValue(f.value)).length >= Math.max(3, Math.ceil(facts.length * 0.6));
  if (statusLike) return <StatusBreakdownTable facts={facts} onOpenEntity={onOpenEntity} />;

  return (
    <section aria-labelledby="facts-heading">
      <div className="mb-2">
        <h3 id="facts-heading" className="dw-label">Breakdown</h3>
      </div>
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
                className="w-full flex items-baseline justify-between gap-3 text-left min-h-[28px] hover:text-ink hover:bg-surface-2 rounded px-1 -mx-1"
              >
                <span className="text-body text-ink-2 break-words">{f.label}</span>
                <span className="text-data text-ink shrink-0">{f.value}</span>
              </button>
            ) : (
              <dt className="text-body text-ink-2 break-words">{f.label}</dt>
            )}
            {filterable ? null : linkable ? (
              <button
                type="button"
                onClick={() => f.entityId && onOpenEntity?.(f.entityId)}
                className="text-data text-ink hover:text-forest-700 dark:hover:text-brass-300 shrink-0"
              >
                {f.value}
              </button>
            ) : (
              <dd className="text-data text-ink shrink-0">{f.value}</dd>
            )}
          </div>
        );
      })}
      </dl>
    </section>
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
    // GroupTable/StatusBreakdownTable each own their own <section>+heading (the latter also carries
    // the "Sort by date" control in that same heading row) — no wrapper here, or "Breakdown" doubled.
    return <GroupTable facts={facts} onOpenEntity={onOpenEntity} groupKeys={groupKeys} activeGroup={activeGroup} onSelectGroup={onSelectGroup} />;
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
