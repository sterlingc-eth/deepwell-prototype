import { useCallback, useState } from 'react';
import { Building2, CheckCircle2, ChevronDown, ChevronUp, Loader2, RefreshCw, Undo2, Users2 } from 'lucide-react';
import {
  reviewDuplicates, mergeAllExactDuplicates, acceptDuplicateCluster, undoDuplicateMerge,
  markCustomersAsCompany, undoMarkAsCompany, fetchRecentChanges, undoMergeAllRun,
  type RecentChange, type DuplicateReview, type ReviewGroup, type ReviewMember,
} from '../services/entityMergeClient';

/**
 * Admin-only "Review duplicates" — every duplicate group in the whole customer list
 * (not just the first page), each with a suggested main record and how many
 * documents, links and units it touches. One click merges all exact-name duplicates
 * (after a confirm); "This is us" takes the company's own name out of the customer
 * list and files its documents as company papers. Everything goes through the
 * admin-gated entity-merge endpoint, and each action can be undone from here.
 */

type Undo = { label: string; run: () => Promise<void> };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function detailLine(m: ReviewMember): string {
  return [m.customerNumber, m.address, m.phone, m.email].filter(Boolean).join(' · ') || 'No contact details on file';
}

function MemberRow({ m, isMain }: { m: ReviewMember; isMain: boolean }) {
  return (
    <li className="py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <span className="text-body text-ink">{m.name || 'Unnamed customer'}</span>
        {isMain && <span className="dw-pill-ok ml-2">Main record</span>}
        <p className="text-caption text-ink-3 break-words">{detailLine(m)}</p>
      </div>
      <span className="text-caption text-ink-3 shrink-0">
        {plural(m.documents, 'document')}{m.equipment > 0 ? ` · ${plural(m.equipment, 'unit')}` : ''}
      </span>
    </li>
  );
}

const SHOWN_AT_FIRST = 3;

function GroupCard({
  group, busy, onMerge, onThisIsUs,
}: {
  group: ReviewGroup; busy: boolean;
  onMerge: (g: ReviewGroup, mainId: string) => void;
  onThisIsUs: (ids: string[], key: string) => void;
}) {
  const [mainId, setMainId] = useState(group.mainId);
  const [expanded, setExpanded] = useState(false);
  const t = group.totals;
  const members = [...group.members].sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const shown = expanded ? members : members.slice(0, SHOWN_AT_FIRST);
  return (
    <li className="dw-card p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body text-ink font-medium break-words">{group.name}</p>
          <p className="text-caption text-ink-3">
            {plural(t.records, 'record')} · {plural(t.documents, 'document')} · {plural(t.links, 'link')}
            {t.equipment > 0 ? ` · ${plural(t.equipment, 'unit')}` : ''}
            {group.reasons?.length ? ` · ${group.reasons.join(', ')}` : ''}
          </p>
          {group.safe === false && group.nameOnly && (
            <p className="text-caption text-warn-ink dark:text-brass-200">
              Check first: only the name matches. No phone, email or address is shared between these records.
            </p>
          )}
          {group.safe === false && !group.nameOnly && (
            <p className="text-caption text-warn-ink dark:text-brass-200">
              Check first: the {(group.conflicts ?? []).join(' or ')} differs between these records.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="dw-btn-tertiary" disabled={busy} onClick={() => onThisIsUs(group.ids, group.key)}>
            This is us
          </button>
          <button type="button" className="dw-btn-primary" disabled={busy} onClick={() => onMerge(group, mainId)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
            Merge
          </button>
        </div>
      </div>
      <div className="divide-y divide-line">
        {shown.map((m) => (
          <div key={m.id} className="flex items-start gap-2">
            <input
              type="radio" name={`main-${group.key}`} className="mt-4 shrink-0 w-5 h-5" checked={mainId === m.id}
              onChange={() => setMainId(m.id)} aria-label={`Keep ${m.name} ${m.customerNumber ?? ''} as the main record`}
            />
            <ul className="flex-1 min-w-0"><MemberRow m={m} isMain={mainId === m.id} /></ul>
          </div>
        ))}
      </div>
      {members.length > SHOWN_AT_FIRST && (
        <button type="button" className="dw-btn-tertiary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${members.length} records`}
        </button>
      )}
    </li>
  );
}

export function ReviewDuplicatesPanel({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<DuplicateReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirmUs, setConfirmUs] = useState<{ ids: string[]; key: string } | null>(null);
  const [recent, setRecent] = useState<RecentChange[]>([]);

  const loadRecent = useCallback(() => {
    fetchRecentChanges().then((r) => setRecent(r.items.filter((x) => x.undoable > 0))).catch(() => setRecent([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    loadRecent();
    reviewDuplicates()
      .then(setReview)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the duplicates.'))
      .finally(() => setLoading(false));
  }, [loadRecent]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && review === null && !loading) load();
  };

  const finish = (message: string, undoAction: Undo | null) => {
    setNotice(message);
    setUndo(undoAction);
    onChanged?.();
    load();
  };

  const mergeGroup = async (g: ReviewGroup, mainId: string) => {
    setBusyKey(g.key); setError(null);
    try {
      const r = await acceptDuplicateCluster(g.ids, { keepId: mainId });
      const kept = g.members.find((m) => m.id === mainId);
      finish(`Merged ${plural(r.mergedCount, 'record')} into ${kept?.name ?? 'the main record'}.`,
        r.id ? { label: 'Undo', run: async () => { await undoDuplicateMerge(r.id as string); } } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge these customers.');
    } finally { setBusyKey(null); }
  };

  const mergeAll = async () => {
    setConfirmAll(false); setBusyKey('all'); setError(null);
    const suggestionIds: string[] = [];
    let groups = 0; let records = 0; let failed = 0; let needsReview = 0;
    try {
      for (let pass = 0; pass < 20; pass++) {
        const r = await mergeAllExactDuplicates();
        groups += r.merged.length;
        records += r.merged.reduce((n, m) => n + m.droppedIds.length, 0);
        failed += r.failed.length;
        needsReview = r.needsReview;
        r.merged.forEach((m) => { if (m.suggestionId) suggestionIds.push(m.suggestionId); });
        if (r.remaining === 0 || r.merged.length === 0) break;
      }
      finish(
        `Merged ${plural(groups, 'group')} and removed ${plural(records, 'extra record')}.${failed ? ` ${plural(failed, 'group')} could not be merged.` : ''}${needsReview ? ` ${plural(needsReview, 'group')} need a look first.` : ''}`,
        suggestionIds.length ? { label: 'Undo all', run: async () => { for (const id of suggestionIds) await undoDuplicateMerge(id); } } : null
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge the duplicates.');
    } finally { setBusyKey(null); }
  };

  const undoRecent = async (c: RecentChange) => {
    setBusyKey(`recent-${c.id}`); setError(null);
    try {
      if (c.kind === 'merge-all') await undoMergeAllRun(c.id); else await undoMarkAsCompany(c.id);
      setNotice('Undone.'); setUndo(null); onChanged?.(); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that.');
    } finally { setBusyKey(null); }
  };

  const thisIsUs = async (ids: string[], key: string) => {
    setConfirmUs(null);
    setBusyKey(key); setError(null);
    try {
      const r = await markCustomersAsCompany(ids);
      finish(`Moved ${plural(r.documentsMoved, 'document')} to company papers and took ${plural(ids.length, 'record')} out of the customer list.`,
        r.logId ? { label: 'Undo', run: async () => { await undoMarkAsCompany(r.logId as string); } } : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally { setBusyKey(null); }
  };

  const runUndo = async () => {
    if (!undo) return;
    setBusyKey('undo'); setError(null);
    try {
      await undo.run();
      setNotice('Undone.'); setUndo(null); onChanged?.(); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that.');
    } finally { setBusyKey(null); }
  };

  const s = review?.summary;
  const total = s ? s.exactGroups + s.nearGroups + (s.selfRecords > 0 ? 1 : 0) : null;

  return (
    <div className="dw-card p-4 space-y-3" data-testid="review-duplicates">
      <button type="button" className="w-full flex items-center justify-between text-left min-h-[44px]" onClick={toggle} aria-expanded={open}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <Users2 className="w-4 h-4" aria-hidden="true" />
          Review duplicates
          {total !== null && <span className={total > 0 ? 'dw-pill-warn' : 'dw-pill-muted'}>{total}</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-4 pt-1">
          <p className="text-caption text-ink-3">
            Customer records with the same or a similar name, across your whole customer list. Merging moves every
            document, link and unit to the main record, and you can undo it.
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
          {notice && (
            <div role="status" className="dw-card border-ok/40 px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-caption text-ink-2">{notice}</span>
              {undo && (
                <button type="button" className="dw-btn-tertiary underline" disabled={busyKey === 'undo'} onClick={() => void runUndo()}>
                  {busyKey === 'undo' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Undo2 className="w-4 h-4" aria-hidden="true" />} {undo.label}
                </button>
              )}
            </div>
          )}

          {confirmUs && (
            <div role="alertdialog" aria-label="Confirm this is us" className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-2">
              <p className="text-caption text-warn-ink dark:text-brass-200">
                Mark {plural(confirmUs.ids.length, 'record')} as your own company? The documents move to company papers and the records leave the customer list. You can undo it.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="dw-btn-primary" onClick={() => void thisIsUs(confirmUs.ids, confirmUs.key)}>Yes, this is us</button>
                <button type="button" className="dw-btn-tertiary" onClick={() => setConfirmUs(null)}>Cancel</button>
              </div>
            </div>
          )}

          {recent.length > 0 && (
            <section className="space-y-2" aria-label="Recent changes">
              <h3 className="text-h4 text-ink">Recent changes</h3>
              <ul className="space-y-2">
                {recent.map((c) => (
                  <li key={c.id} className="dw-card px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-caption text-ink-2">
                      {new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}:{' '}
                      {c.kind === 'merge-all'
                        ? `Merged ${plural(c.groups ?? 0, 'group')} and removed ${plural(c.records, 'extra record')}`
                        : `Marked ${plural(c.records, 'record')} as your own company`}
                    </span>
                    <button type="button" className="dw-btn-tertiary underline" disabled={busyKey !== null} onClick={() => void undoRecent(c)}>
                      {busyKey === `recent-${c.id}` ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Undo2 className="w-4 h-4" aria-hidden="true" />} Undo
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-caption text-ink-3">Changes from the last 14 days.</p>
            </section>
          )}

          {loading && !review && (
            <p className="text-body text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Looking for duplicates…</p>
          )}

          {review && (
            <>
              {review.self.length > 0 && (
                <section className="dw-card p-3 space-y-2 border-warn/40" aria-label="Your company as a customer">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-body text-ink font-medium flex items-center gap-2 break-words">
                        <Building2 className="w-4 h-4 shrink-0" aria-hidden="true" /> {review.companyName} appears as a customer {review.self.length} {review.self.length === 1 ? 'time' : 'times'}
                      </p>
                      <p className="text-caption text-ink-3">
                        {plural(review.self.reduce((n, m) => n + m.documents, 0), 'document')} · {plural(review.self.reduce((n, m) => n + m.equipment, 0), 'unit')}.
                        Use This is us when the record is your own company. Its documents move to company papers and it leaves the customer list.
                      </p>
                    </div>
                    <button type="button" className="dw-btn-primary" disabled={busyKey !== null} onClick={() => setConfirmUs({ ids: review.self.map((m) => m.id), key: 'self' })}>
                      {busyKey === 'self' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                      This is us
                    </button>
                  </div>
                </section>
              )}

              <section className="space-y-2" aria-label="Exact duplicates">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-h4 text-ink">Exact duplicates <span className="dw-pill-muted ml-1">{review.exact.length}</span></h3>
                  {review.summary.exactSafeGroups > 0 && !confirmAll && (
                    <button type="button" className="dw-btn-primary" disabled={busyKey !== null} onClick={() => setConfirmAll(true)}>
                      {busyKey === 'all' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                      Merge all exact duplicates
                    </button>
                  )}
                </div>
                {confirmAll && (
                  <div role="alertdialog" aria-label="Confirm merge" className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-2">
                    <p className="text-caption text-warn-ink dark:text-brass-200">
                      Merge {plural(review.summary.exactSafeGroups, 'group')} into their main records? That removes {plural(review.summary.extraRecordsInExactSafe, 'extra record')}.
                      Every document, link and unit moves to the main record, and you can undo it.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="dw-btn-primary" onClick={() => void mergeAll()}>Merge them</button>
                      <button type="button" className="dw-btn-tertiary" onClick={() => setConfirmAll(false)}>Cancel</button>
                    </div>
                  </div>
                )}
                {review.exact.length === 0 && <p className="text-body text-ink-3">No exact duplicates found.</p>}
                <ul className="space-y-2">
                  {review.exact.map((g) => (
                    <GroupCard key={g.key} group={g} busy={busyKey !== null} onMerge={(x, id) => void mergeGroup(x, id)} onThisIsUs={(ids, key) => setConfirmUs({ ids, key })} />
                  ))}
                </ul>
              </section>

              {review.near.length > 0 && (
                <section className="space-y-2" aria-label="Similar names">
                  <h3 className="text-h4 text-ink">Similar names <span className="dw-pill-muted ml-1">{review.near.length}</span></h3>
                  <ul className="space-y-2">
                    {review.near.map((g) => (
                      <GroupCard key={g.key} group={g} busy={busyKey !== null} onMerge={(x, id) => void mergeGroup(x, id)} onThisIsUs={(ids, key) => setConfirmUs({ ids, key })} />
                    ))}
                  </ul>
                </section>
              )}

              {total === 0 && <p className="text-body text-ink-3">No duplicates found.</p>}
            </>
          )}

          <button type="button" onClick={load} disabled={loading} className="dw-btn-tertiary">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />}
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
