// Split out of main.tsx so that file stays side-effects-only (window hooks, useGraph.seed) — oxlint's
// react-refresh rule wants a component's own file to only export components.
import { AnswerCard } from '../../src/components/AnswerCard';
import { MobileAnswer } from '../../src/mobile/MobileAnswer';
import type { Answer } from '../../src/core/types';
import { CITATION_FIXTURE, FIXTURES, LAYOUT_ORDER, noteOpen } from './fixtures';

export function DesktopFixtures() {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6" data-testid="desktop-root">
      {LAYOUT_ORDER.map((kind) => (
        <section key={kind} data-testid={`fixture-${kind}`}>
          <p className="dw-label text-ink-3 mb-1">{kind}</p>
          <AnswerCard
            answer={FIXTURES[kind]!}
            question={FIXTURES[kind]!.interpretation ?? 'Sample question'}
            includeUnverified={false}
            onToggleUnverified={() => {}}
            onOpenSource={(ref) => noteOpen(`source:${ref.documentId}`)}
            onOpenEntity={(id) => noteOpen(`entity:${id}`)}
            onOpenRecord={(r) => noteOpen(`record:${r.type}:${r.id}`)}
            onAsk={(q) => noteOpen(`ask:${q}`)}
          />
        </section>
      ))}
      {/* R13H1: sentence-level citations — a separate fixture, not one of the answerLayout() kinds
          above (see fixtures.ts's own comment on CITATION_FIXTURE). */}
      <section data-testid="fixture-citations">
        <p className="dw-label text-ink-3 mb-1">citations</p>
        <AnswerCard
          answer={CITATION_FIXTURE as unknown as Answer}
          question={CITATION_FIXTURE.interpretation}
          includeUnverified={false}
          onToggleUnverified={() => {}}
          onOpenSource={(ref) => noteOpen(`source:${ref.documentId}`)}
          onOpenEntity={(id) => noteOpen(`entity:${id}`)}
          onOpenRecord={(r) => noteOpen(`record:${r.type}:${r.id}`)}
          onAsk={(q) => noteOpen(`ask:${q}`)}
        />
      </section>
    </div>
  );
}

export function MobileFixtures() {
  return (
    <div className="max-w-sm mx-auto p-3 space-y-4" data-testid="mobile-root">
      {LAYOUT_ORDER.map((kind) => (
        <section key={kind} data-testid={`m-fixture-${kind}`}>
          <p className="dw-label text-ink-3 mb-1">{kind}</p>
          <MobileAnswer
            question={FIXTURES[kind]!.interpretation ?? 'Sample question'}
            answer={FIXTURES[kind]!}
            onOpenDoc={(id) => noteOpen(`doc:${id}`)}
            onOpenCustomer={(ref) => noteOpen(`customer:${ref}`)}
            onAsk={(q) => noteOpen(`ask:${q}`)}
          />
        </section>
      ))}
      <section data-testid="m-fixture-citations">
        <p className="dw-label text-ink-3 mb-1">citations</p>
        <MobileAnswer
          question={CITATION_FIXTURE.interpretation}
          answer={CITATION_FIXTURE as unknown as Answer}
          onOpenDoc={(id) => noteOpen(`doc:${id}`)}
          onOpenCustomer={(ref) => noteOpen(`customer:${ref}`)}
          onAsk={(q) => noteOpen(`ask:${q}`)}
        />
      </section>
    </div>
  );
}
