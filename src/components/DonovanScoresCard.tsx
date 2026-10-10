import { useEffect, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { reviewClient, type DonovanScores } from '../services/reviewClient';

/**
 * Operator-only: Donovan's performance scores across every organization that opted in to sharing. Redacted by
 * construction (question kind, outcome, speed, cost): there are no questions, answers, documents or names to show.
 */
const pct = (n: number | null | undefined) => (n == null ? '-' : `${Math.round(n * 100)}%`);
const LABEL: Record<string, string> = {
  answered_from_records: 'Answered from records',
  declined: 'Declined',
  ai_fallback: 'Used AI fallback',
  marked_wrong: 'Marked wrong',
};

export function DonovanScoresCard() {
  const [data, setData] = useState<DonovanScores | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setData(null);
    setError(null);
    reviewClient.donovanScores(days).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Could not load scores.'));
  }, [days]);

  // Only declined and marked-wrong rows exist until answered questions are reported, so the answered/AI rates would read 0%.
  const hasAnswered = !!data && ((data.byOutcome.answered_from_records ?? 0) + (data.byOutcome.ai_fallback ?? 0)) > 0;
  const labelKeys = (Object.keys(LABEL) as Array<keyof typeof LABEL>).filter((k) => hasAnswered || (k !== 'answered_from_records' && k !== 'ai_fallback'));

  return (
    <section className="dw-card p-4 sm:p-5" aria-labelledby="donovan-scores-h">
      <div className="flex flex-wrap items-center gap-3">
        <Gauge className="w-5 h-5 text-ink-2" aria-hidden="true" />
        <h3 id="donovan-scores-h" className="text-h3">Shared performance scores</h3>
        <div className="ml-auto flex gap-1" role="group" aria-label="Time range">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
              className={`min-h-touch px-3 rounded-md text-body ${days === d ? 'bg-surface-2 text-ink font-semibold' : 'text-ink-2 hover:bg-surface-2'}`}>{d} days</button>
          ))}
        </div>
      </div>
      <p className="text-ink-2 mt-1">Only organizations that switched sharing on. Question kind, outcome, speed and cost only: no questions, answers, documents or names.</p>
      {error && <p className="text-bad mt-3" role="alert">{error}</p>}
      {!data && !error && <p className="mt-3 text-ink-2 inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading</p>}
      {data && !data.configured && <p className="mt-3 text-ink-2">Not set up for this deployment yet.</p>}
      {data && data.configured && data.total === 0 && <p className="mt-3 text-ink-2">No shared scores yet. {data.tenantsOptedIn} organization{data.tenantsOptedIn === 1 ? '' : 's'} opted in.</p>}
      {data && data.total > 0 && (
        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {labelKeys.map((k) => (
              <div key={k} className="rounded-md bg-surface-2 p-3">
                <dt className="text-caption text-ink-2">{LABEL[k]}</dt>
                <dd className="text-h3">{pct(data.rates[k as keyof DonovanScores['rates']])} <span className="text-caption text-ink-3">({data.byOutcome[k] ?? 0})</span></dd>
              </div>
            ))}
          </dl>
          {!hasAnswered && <p className="text-ink-2 text-body">Waiting for answered-question data. Answered and AI rates will show here once those are reported.</p>}
          <p className="text-ink-2 text-body">
            {data.total} scored questions from {data.tenantsReporting} organization{data.tenantsReporting === 1 ? '' : 's'} ({data.tenantsOptedIn} opted in). Speed p50 {data.latencyMs.p50 ?? '-'} ms, p95 {data.latencyMs.p95 ?? '-'} ms. AI cost ${data.costUsd.toFixed(2)}.
          </p>
          {hasAnswered && <div>
            <h4 className="text-body font-semibold">By kind of question</h4>
            <ul className="mt-1 space-y-1">
              {data.byShape.map((s) => (
                <li key={s.shape} className="flex items-center gap-3">
                  <span className="w-24 text-ink-2 capitalize">{s.shape}</span>
                  <span className="flex-1 h-2 rounded bg-surface-2" aria-hidden="true"><span className="block h-2 rounded bg-ok" style={{ width: `${Math.round((s.answeredRate ?? 0) * 100)}%` }} /></span>
                  <span className="w-28 text-right text-body">{pct(s.answeredRate)} of {s.n}</span>
                </li>
              ))}
            </ul>
          </div>}
          <div className="overflow-x-auto">
            <h4 className="text-body font-semibold">Daily trend</h4>
            <table className="w-full text-body mt-1">
              <thead><tr className="text-left text-caption text-ink-2"><th className="py-1 pr-3">Day</th><th className="pr-3">Asked</th>{hasAnswered && <th className="pr-3">From records</th>}<th className="pr-3">Declined</th>{hasAnswered && <th className="pr-3">AI</th>}<th className="pr-3">Wrong</th><th>Avg ms</th></tr></thead>
              <tbody>
                {data.trend.slice(-14).map((d) => (
                  <tr key={d.day} className="border-t border-line-2"><td className="py-1 pr-3">{d.day}</td><td className="pr-3">{d.n}</td>{hasAnswered && <td className="pr-3">{pct(d.answeredRate)}</td>}<td className="pr-3">{pct(d.declinedRate)}</td>{hasAnswered && <td className="pr-3">{pct(d.aiRate)}</td>}<td className="pr-3">{pct(d.wrongRate)}</td><td>{d.avgLatencyMs ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
