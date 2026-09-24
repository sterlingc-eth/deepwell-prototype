import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clipboard, ListChecks, Loader2, RefreshCw, Send } from 'lucide-react';
import { reviewClient, replayAllMisses, type MissReport, type MissReplay } from '../services/reviewClient';

/**
 * Admin-only "Donovan misses" card (Day 2 training plan,
 * handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md) — Team screen. Shows how many asks in the last 7 days ended honest rather than right (a
 * no-answer, a money/maintenance/"can't filter by X yet" fallback, an
 * ambiguous or empty contact lookup, an analytics plan that fell through to
 * retrieval), grouped by outcome, so the weekly miss review is a five-minute
 * glance instead of a log dive. "Copy for review" puts the same data on the
 * clipboard as plain text, ready to paste into wherever that review happens.
 *
 * Each missed question carries what actually happened when Donovan re-ran it (api/_lib/learning/replay.js):
 * "Answered now" (with the answer, on demand) or "Still failing" and why - or nothing, when it has not been
 * re-run yet. Platform operators also get "Replay all now", which re-runs the open misses for real.
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
  'user-marked-wrong': 'Marked wrong by a user',
};

const TOP_SHOWN = 5;

/** One missed question with its honest status. */
function MissRow({ text, count, replay }: { text: string; count: number; replay?: MissReplay }) {
  const [showAnswer, setShowAnswer] = useState(false);
  return (
    <li className="py-1">
      <p className="text-caption text-ink truncate" title={text}>"{text}"{count > 1 ? ` (${count}x)` : ''}</p>
      {replay?.outcome === 'answered_now' && (
        <p className="text-caption text-ok-ink dark:text-ok">
          Answered now ✓{' '}
          <button type="button" className="underline text-ink-2" onClick={() => setShowAnswer((v) => !v)}>
            {showAnswer ? 'hide answer' : 'view answer'}
          </button>
        </p>
      )}
      {replay?.outcome === 'still_failing' && (
        <p className="text-caption text-warn-ink dark:text-brass-200">Still failing{replay.reason ? ` — ${replay.reason}` : ''}</p>
      )}
      {!replay && <p className="text-caption text-ink-3">Not re-run yet</p>}
      {showAnswer && replay?.answer && (
        <div className="mt-1 rounded-md bg-surface-2 px-2 py-1 text-caption text-ink-2">
          <p>{replay.answer.text}</p>
          {(replay.answer.facts ?? []).slice(0, 8).map((f, i) => (
            <p key={i} className="text-ink-3">{f.label}: {f.value}</p>
          ))}
          {(replay.answer.facts?.length ?? 0) > 8 && <p className="text-ink-3">…and {(replay.answer.facts?.length ?? 0) - 8} more</p>}
        </div>
      )}
    </li>
  );
}

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
  const [replaying, setReplaying] = useState(false);
  const [replayStatus, setReplayStatus] = useState<string | null>(null);

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

  // Operator-only: re-run the open misses through Donovan for real (a billed model call per miss, capped
  // per round), record what happened, then reload so every row shows its true status.
  const replayAll = async () => {
    setReplaying(true);
    setReplayStatus(null);
    setError(null);
    try {
      const t = await replayAllMisses((p) => setReplayStatus(`Re-running… ${p.attempted} done, ${p.remaining} left.`));
      const stop = t.stopped === 'model-budget' ? ' Stopped: daily AI budget reached.' : t.stopped === 'cost-ceiling' ? ' Stopped: per-run cost ceiling.' : '';
      setReplayStatus(`Re-ran ${t.attempted}: ${t.answeredNow} answered now, ${t.stillFailing} still failing${t.recipesLive ? `, ${t.recipesLive} shortcut(s) now live` : ''}.${stop}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not replay the misses.');
    } finally {
      setReplaying(false);
    }
  };

  const copyForReview = async () => {
    if (!report) return;
    const lines = [
      `Donovan misses, last ${REPORT_WINDOW_DAYS} days (${report.total} logged, most recent first)`,
      ...report.groups.map((g) => {
        const top = g.topQuestions.slice(0, 5).map((q) => `    - ${q.text} (${q.count}x)${q.replay ? ` [${q.replay.outcome === 'answered_now' ? 'answered now' : `still failing: ${q.replay.reason ?? 'unknown'}`}]` : ''}`);
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
          {report?.replaySummary && report.replaySummary.answeredNow > 0 && <span className="dw-pill-muted">{report.replaySummary.answeredNow} answered now</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <p className="text-caption text-ink-3">
            Questions Donovan answered honestly instead of correctly. Each one is re-run through Donovan (nightly, or
            on demand) and shows whether it is answered now or still failing — and why.
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

          {report?.replaySummary && report.groups.length > 0 && (
            <p className="text-caption text-ink-2">
              {report.replaySummary.answeredNow} answered now · {report.replaySummary.stillFailing} still failing · {report.replaySummary.notReplayed} not re-run yet
            </p>
          )}
          {report?.isOperator && (
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => void replayAll()} disabled={replaying} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
                {replaying ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                Replay all now
              </button>
              {replayStatus && <span className="text-caption text-ink-3">{replayStatus}</span>}
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
                    <ul className="mt-1">
                      {g.topQuestions.slice(0, TOP_SHOWN).map((q) => (
                        <MissRow key={q.text} text={q.text} count={q.count} {...(q.replay ? { replay: q.replay } : {})} />
                      ))}
                    </ul>
                    {g.topQuestions.length > TOP_SHOWN && (
                      <p className="text-caption text-ink-3">and {g.topQuestions.length - TOP_SHOWN} more</p>
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

