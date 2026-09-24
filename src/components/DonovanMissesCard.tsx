import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clipboard, ListChecks, Loader2, Send } from 'lucide-react';
import { reviewClient, type MissReport } from '../services/reviewClient';

/**
 * Admin-only "Donovan misses" card (Day 2 training plan,
 * handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md) — Team screen. Read-only:
 * shows how many asks in the last 7 days ended honest rather than right (a
 * no-answer, a money/maintenance/"can't filter by X yet" fallback, an
 * ambiguous or empty contact lookup, an analytics plan that fell through to
 * retrieval), grouped by outcome, so the weekly miss review is a five-minute
 * glance instead of a log dive. "Copy for review" puts the same data on the
 * clipboard as plain text, ready to paste into wherever that review happens.
 *
 * Mirrors FollowupsCard's collapsed-by-default, dw-card styling exactly — no
 * new UI library, no chart, just counts.
 */
const REPORT_WINDOW_DAYS = 7;

const OUTCOME_LABEL: Record<string, string> = {
  'no-answer': 'No answer',
  'money-fallback': "Can't total money yet",
  'maintenance-fallback': "Can't filter by maintenance yet",
  'unsupported-condition': "Can't filter by X yet",
  'contact-lookup-zero': 'Contact lookup — no match',
  'contact-lookup-ambiguous': 'Contact lookup — more than one match',
  'analytics-fallthrough': 'Analytics plan rejected',
  'agent-no-answer': 'Agent could not answer',
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function DonovanMissesCard() {
  const [report, setReport] = useState<MissReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sendingDigest, setSendingDigest] = useState(false);
  const [digestStatus, setDigestStatus] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    reviewClient
      .missReport(REPORT_WINDOW_DAYS)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load misses.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open && report === null && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalCount = report?.groups.reduce((sum, g) => sum + g.count, 0) ?? 0;

  // Platform-operator-only (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md,
  // Tier 1 self-learning loop) — the server tells us via `report.isOperator`
  // whether the signed-in caller may call this; nothing here is hardcoded to
  // an id. A 403 (a non-operator somehow reaching this button) surfaces as an
  // ordinary error message like any other failed call.
  const sendDigestNow = async () => {
    setSendingDigest(true);
    setDigestStatus(null);
    setError(null);
    try {
      const result = await reviewClient.missDigest({ send: true });
      if (result.skippedReason === 'no-misses') {
        setDigestStatus('No misses in the last 24h — nothing sent.');
      } else {
        const parts = [`${result.digest.totals.totalMisses} miss(es)`, `${result.digest.totals.newQuestionsCount} new`];
        if (result.emailed) parts.push('emailed');
        if (result.notified) parts.push('in-app notified');
        setDigestStatus(`Digest sent — ${parts.join(', ')}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the digest.');
    } finally {
      setSendingDigest(false);
    }
  };

  const copyForReview = async () => {
    if (!report) return;
    const lines = [
      `Donovan misses, last ${REPORT_WINDOW_DAYS} days (${report.total} logged, most recent first)`,
      ...report.groups.map((g) => {
        const top = g.topQuestions.slice(0, 5).map((q) => `    - ${q.text} (${q.count}x)`);
        return [`${outcomeLabel(g.outcome)}: ${g.count}`, ...top].join('\n');
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to your clipboard — your browser may be blocking it.');
    }
  };

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <ListChecks className="w-4 h-4" aria-hidden="true" />
          Donovan misses
          {report && <span className="dw-pill-muted">{totalCount} in 7 days</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <p className="text-caption text-ink-3">
            Questions Donovan answered honestly instead of correctly — a plain "nothing found," a "can't do that
            yet," or a lookup that matched none or more than one customer. Reviewing these weekly is how the
            question bank and the code both improve.
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}

          {loading && !report && (
            <p className="text-body text-ink-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
            </p>
          )}

          {report && report.groups.length === 0 && (
            <p className="text-body text-ink-3">No misses logged yet — Donovan is answering everything it's tried.</p>
          )}

          {/* Platform-operator-only, independent of THIS tenant's own miss
              count — the digest is cross-tenant, so an operator whose own
              shop has zero misses can still send today's platform digest. */}
          {report?.isOperator && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void sendDigestNow()}
                disabled={sendingDigest}
                className="dw-btn-tertiary !min-h-[32px] !py-0.5"
              >
                {sendingDigest ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Send digest now
              </button>
              {digestStatus && <span className="text-caption text-ink-3">{digestStatus}</span>}
            </div>
          )}

          {report && report.groups.length > 0 && (
            <>
              <ul className="divide-y divide-line">
                {report.groups.map((g) => (
                  <li key={g.outcome} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-body text-ink">{outcomeLabel(g.outcome)}</span>
                      <span className="dw-pill-warn">{g.count}</span>
                    </div>
                    {g.topQuestions[0] && (
                      <p className="text-caption text-ink-3 mt-1 truncate" title={g.topQuestions.map((q) => q.text).join(' · ')}>
                        e.g. "{g.topQuestions[0].text}"{g.topQuestions.length > 1 ? ` and ${g.topQuestions.length - 1} more` : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button type="button" onClick={() => void copyForReview()} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
                  {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Clipboard className="w-3.5 h-3.5" aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy for review'}
                </button>
                <button type="button" onClick={load} disabled={loading} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} Refresh
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

