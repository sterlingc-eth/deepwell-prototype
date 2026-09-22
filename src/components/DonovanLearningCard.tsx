import { useEffect, useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, Clipboard, GraduationCap, Loader2, Play, Power, X,
} from 'lucide-react';
import { reviewClient, type LearningLearnedItem, type LearningProposal } from '../services/reviewClient';

/**
 * Platform-operator-only "Donovan learning" card (Tier 2 Part B,
 * handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md) — Team screen, right below
 * DonovanMissesCard. Unlike that card, EVERYTHING here is operator-only —
 * the queue is cross-tenant, so a tenant's own admin never sees any of it.
 * There is no separate "am I an operator" probe: this just calls
 * learningList like any other action and, on the 403 the server sends a
 * non-operator, hides the whole card rather than showing an error a regular
 * shop admin has no way to act on.
 *
 * Mirrors FollowupsCard/DonovanMissesCard's collapsed-by-default, dw-card
 * styling — no new UI library.
 */
const KIND_LABEL: Record<string, string> = {
  abbreviation: 'Abbreviation',
  typo: 'Typo fix',
  synonym: 'New synonym',
  few_shot: 'Example (few-shot)',
  capability_gap: "Can't do yet",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function payloadSummary(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'abbreviation':
    case 'typo':
      return `"${payload.from}" → "${payload.to}"`;
    case 'synonym':
      return `${payload.entity}: "${payload.word}"`;
    case 'few_shot':
      return `"${payload.question}"`;
    case 'capability_gap':
      return String(payload.title ?? '');
    default:
      return JSON.stringify(payload);
  }
}

const STATUS_PILL: Record<string, string> = {
  pending: 'dw-pill-warn',
  approved: 'dw-pill-muted',
  auto_approved: 'dw-pill-muted',
  rejected: 'dw-pill-muted',
  auto_rejected: 'dw-pill-muted',
};

export function DonovanLearningCard() {
  const [proposals, setProposals] = useState<LearningProposal[] | null>(null);
  const [activeLearned, setActiveLearned] = useState<LearningLearnedItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false); // set true on a 403 (not an operator)
  const [checked, setChecked] = useState(false); // true once the first load has resolved either way
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    reviewClient
      .learningList({ status: 'pending', limit: 100 })
      .then((r) => {
        setProposals(r.items);
        setActiveLearned(r.activeLearned);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : 'Could not load Donovan learning.';
        if (message.includes('platform operators')) {
          setHidden(true);
        } else {
          setError(message);
        }
      })
      .finally(() => {
        setLoading(false);
        setChecked(true);
      });
  };

  // Loaded eagerly on mount (unlike DonovanMissesCard's lazy-on-open), not
  // lazily on open: the ENTIRE card is operator-only, cross-tenant content,
  // so a regular shop admin who mounts this (every admin does — see
  // TeamScreen.tsx) must never even see the collapsed header. The 403 this
  // gets back for them flips `hidden` before they'd have a chance to open it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const toggleOpen = () => setOpen((v) => !v);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setDecidingId(id);
    setError(null);
    try {
      await reviewClient.learningDecide(id, decision);
      setProposals((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
      if (decision === 'approved') load(); // pick up the new active-learned row
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not decide this proposal.');
    } finally {
      setDecidingId(null);
    }
  };

  const deactivate = async (learnedId: string) => {
    setDeactivatingId(learnedId);
    setError(null);
    try {
      await reviewClient.learningDeactivate(learnedId);
      setActiveLearned((prev) => (prev ? prev.filter((i) => i.id !== learnedId) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not deactivate this item.');
    } finally {
      setDeactivatingId(null);
    }
  };

  const runNow = async () => {
    setRunningNow(true);
    setRunStatus(null);
    setError(null);
    try {
      const summary = await reviewClient.learningRunNow();
      if (summary.skipped) {
        setRunStatus(`Skipped: ${summary.skipped}.`);
      } else if (summary.error) {
        setRunStatus(`Failed: ${summary.error}`);
      } else {
        const byStatus = Object.entries(summary.byStatus ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') || 'no proposals';
        setRunStatus(`${summary.totalMissGroups ?? 0} miss group(s), ${summary.modelCallsMade ?? 0} model call(s) — ${byStatus}.`);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run learning now.');
    } finally {
      setRunningNow(false);
    }
  };

  const exportApproved = async () => {
    setExporting(true);
    setError(null);
    try {
      const { items } = await reviewClient.learningExport();
      await navigator.clipboard.writeText(JSON.stringify(items, null, 2));
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export approved items.');
    } finally {
      setExporting(false);
    }
  };

  if (hidden || !checked) return null;

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={toggleOpen}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <GraduationCap className="w-4 h-4" aria-hidden="true" />
          Donovan learning
          {proposals && <span className="dw-pill-muted">{proposals.length} pending</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-4 pt-1">
          <p className="text-caption text-ink-3">
            Every night Donovan looks at what it answered honestly instead of correctly and proposes fixes — a typo
            or abbreviation to learn, a new word for something it already tracks, or a worked example. Nothing here
            ever changes how Donovan answers until you approve it (or the fix is a routine typo/abbreviation the
            policy already trusts).
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}

          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => void runNow()} disabled={runningNow} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
              {runningNow ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
              Run learning now
            </button>
            <button type="button" onClick={() => void exportApproved()} disabled={exporting} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
              {exported ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Clipboard className="w-3.5 h-3.5" aria-hidden="true" />}
              {exported ? 'Copied' : 'Export approved'}
            </button>
            <button type="button" onClick={load} disabled={loading} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} Refresh
            </button>
            {runStatus && <span className="text-caption text-ink-3">{runStatus}</span>}
          </div>

          {loading && proposals === null && (
            <p className="text-body text-ink-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
            </p>
          )}

          <div>
            <h3 className="text-caption font-medium text-ink-3 uppercase tracking-wide mb-2">Pending proposals</h3>
            {proposals && proposals.length === 0 && (
              <p className="text-body text-ink-3">Nothing pending — every recent proposal was auto-decided or already reviewed.</p>
            )}
            {proposals && proposals.length > 0 && (
              <ul className="divide-y divide-line">
                {proposals.map((p) => {
                  const v = p.verification;
                  return (
                    <li key={p.id} className="py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-body text-ink">
                          <span className={STATUS_PILL[p.status] ?? 'dw-pill-muted'}>{kindLabel(p.kind)}</span>{' '}
                          {payloadSummary(p.kind, p.payload)}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void decide(p.id, 'approved')}
                            disabled={decidingId === p.id}
                            className="dw-btn-tertiary !min-h-[28px] !py-0"
                          >
                            {decidingId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(p.id, 'rejected')}
                            disabled={decidingId === p.id}
                            className="dw-btn-tertiary !min-h-[28px] !py-0"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                            Reject
                          </button>
                        </div>
                      </div>
                      <p className="text-caption text-ink-3">
                        Seen {p.evidence?.count ?? 0}x across {p.evidence?.tenantCount ?? 0} shop(s)
                        {v ? ` · bank ${v.bankPass}/${v.bankTotal} · miss fixed ${v.missFixed?.fixed ?? 0}/${v.missFixed?.total ?? 0} · negatives ${v.negativesPass ? 'clean' : 'FAILED'}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-caption font-medium text-ink-3 uppercase tracking-wide mb-2">Active learned items</h3>
            {activeLearned && activeLearned.length === 0 && (
              <p className="text-body text-ink-3">Nothing learned yet.</p>
            )}
            {activeLearned && activeLearned.length > 0 && (
              <ul className="divide-y divide-line">
                {activeLearned.map((item) => (
                  <li key={item.id} className="py-2 flex items-center justify-between gap-2">
                    <span className="text-body text-ink">
                      <span className="dw-pill-muted">{kindLabel(item.kind)}</span> {payloadSummary(item.kind, item.value)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deactivate(item.id)}
                      disabled={deactivatingId === item.id}
                      className="dw-btn-tertiary !min-h-[28px] !py-0 shrink-0"
                    >
                      {deactivatingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Power className="w-3.5 h-3.5" aria-hidden="true" />}
                      Deactivate
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
