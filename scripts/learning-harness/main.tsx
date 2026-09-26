// Dev-only harness for scripts/verify-provider-outage.mjs — mounts DonovanScorecardStrip and
// DonovanLearningCard with reviewClient's network methods monkey-patched to fixture data (reviewClient
// is a plain exported object, not frozen — see scripts/answer-harness/main.tsx for the same technique
// applied to useGraph.seed instead). Nothing here ever calls the network, a DB, or Anthropic.
import { createRoot } from 'react-dom/client';
import { reviewClient } from '../../src/services/reviewClient';
import type { ScorecardStatus, LearningProposal, AutopilotStatus, GapReport } from '../../src/services/reviewClient';
import { useAppStore } from '../../src/store/appStore';
import { DonovanScorecardStrip } from '../../src/components/DonovanScorecardStrip';
import { DonovanLearningCard } from '../../src/components/DonovanLearningCard';
import '../../src/index.css';

const SCORECARD_PAUSED: ScorecardStatus = {
  backend: 'tables',
  exam: { version: '2026.1', questions: 11, categories: { warranty: 4, billing: 4, service: 3 } },
  budgetUsd: 5,
  adjudicationNote: 'Answer key is audited against the shop’s own records.',
  run: {
    id: 'run-1', source: 'operator', examVersion: '2026.1', status: 'stopped', stopReason: 'model-credits',
    totalQuestions: 11, answered: 4, passed: 4, score: 4 / 11, valueScore: 4 / 11,
    citation: { required: 4, cited: 4, coverage: 1 },
    byCategory: { warranty: { passed: 2, total: 2, score: 1 }, billing: { passed: 2, total: 2, score: 1 } },
    costUsd: 0.02, models: ['claude-haiku-4-5'], startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(),
  },
  previous: { id: 'run-0', score: 0.82, startedAt: new Date(Date.now() - 86_400_000).toISOString(), answered: 11 },
  runs: [],
  failing: [],
  providerStatus: { reason: 'credits', detail: 'credit balance is too low', since: new Date(Date.now() - 30 * 60_000).toISOString() },
};

const GAP_PROPOSALS: LearningProposal[] = [
  {
    id: 'gap-1', kind: 'capability_gap',
    payload: { title: 'Compare two customers’ spend side by side', example: 'How does 900 W Baseline compare to 12 Elm St?', note: 'No cross-customer comparison yet.' },
    evidence: { count: 6, tenantCount: 3 }, verification: {}, status: 'pending', reason: null,
    created_at: new Date().toISOString(), decided_at: null, decided_by: null,
    replay: { outcome: 'answered_now', reason: null, costUsd: 0 } as never,
    groupCount: 3, groupIds: ['gap-1', 'gap-1b', 'gap-1c'],
  },
  {
    id: 'gap-2', kind: 'capability_gap',
    payload: { title: 'Forecast next month’s parts spend', example: 'What will parts cost next month?', note: 'No forecasting capability.' },
    evidence: { count: 2, tenantCount: 2 }, verification: {}, status: 'pending', reason: null,
    created_at: new Date().toISOString(), decided_at: null, decided_by: null,
  },
];

const NON_GAP_PROPOSALS: LearningProposal[] = [
  {
    id: 'p-1', kind: 'abbreviation', payload: { from: 'PM', to: 'preventive maintenance' },
    evidence: { count: 5, tenantCount: 2 }, verification: { bankTotal: 20, bankPass: 20, negativesPass: true, missFixed: { fixed: 3, total: 3 } } as never,
    status: 'pending', reason: null, created_at: new Date().toISOString(), decided_at: null, decided_by: null,
  },
];

reviewClient.scorecardStatus = () => Promise.resolve(SCORECARD_PAUSED);
reviewClient.learningList = () => Promise.resolve({
  items: [...NON_GAP_PROPOSALS, ...GAP_PROPOSALS],
  activeLearned: [{ id: 'l-1', kind: 'abbreviation', key: 'PM', value: { from: 'PM', to: 'preventive maintenance' }, created_at: new Date().toISOString() }],
  summary: { recipesActive: 1, answeredNow: 2, stillFailing: 1, notReplayed: 0 },
});
reviewClient.learningAutopilotStatus = () => Promise.resolve<AutopilotStatus>({
  tenantsEligible: 12, perTenant: [], platformSpentUsd: 0.41, nextTenant: null, gapReportWeekStart: null,
});
reviewClient.learningGapReport = () => Promise.resolve<GapReport>({ weekStart: new Date().toISOString().slice(0, 10), totalFailures: 8, clusters: [] });

const params = new URLSearchParams(window.location.search);
useAppStore.getState().setFieldMode(params.get('field') === '1');

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div className="max-w-2xl mx-auto p-4 space-y-6" data-testid="harness-root">
      <section data-testid="fixture-scorecard">
        <DonovanScorecardStrip />
      </section>
      <section data-testid="fixture-learning">
        <DonovanLearningCard />
      </section>
    </div>,
  );
}
