// Split out of main.tsx so that file stays side-effects-only, same convention as answer-harness's own
// Fixtures.tsx (oxlint's react-refresh rule wants a component's own file to only export components).
import { useState } from 'react';
import { TypeaheadDropdown, PreflightPill, SamplePromptChips, DidYouMeanChips } from '../../src/components/ask';
import { COMPLETIONS, INSTANT_HINT, SLOW_HINT, NEEDS_ANCHOR_HINT, SAMPLE_PROMPTS, DID_YOU_MEAN_CHIPS } from './fixtures';

declare global {
  interface Window {
    __dwOpens?: string[];
  }
}
const noteOpen = (msg: string) => {
  window.__dwOpens = [...(window.__dwOpens ?? []), msg];
};

/** One labelled section, same visual rhythm as the real Ask screen (dw-label heading + content). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2" data-testid={`section-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <h2 className="dw-label">{title}</h2>
      {children}
    </section>
  );
}

export function AskSuggestFixtures() {
  const [activeIndex, setActiveIndex] = useState(1);
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-8" data-testid="ask-suggest-root">
      <Section title="Preflight instant">
        <PreflightPill hint={INSTANT_HINT} />
      </Section>
      <Section title="Preflight slow">
        <PreflightPill hint={SLOW_HINT} />
      </Section>
      <Section title="Preflight needs anchor">
        <PreflightPill hint={NEEDS_ANCHOR_HINT} />
      </Section>

      <Section title="Sample prompts">
        <SamplePromptChips prompts={SAMPLE_PROMPTS} onPick={(q) => noteOpen(`pick:${q}`)} />
      </Section>

      {/* DidYouMeanChips renders its own "Did you mean" heading, so this section is unlabelled to avoid
          a duplicate — data-testid still marks it for the harness script. */}
      <section className="space-y-2" data-testid="section-did-you-mean">
        <DidYouMeanChips chips={DID_YOU_MEAN_CHIPS} onPick={(q) => noteOpen(`pick:${q}`)} />
      </section>

      {/* Last: TypeaheadDropdown floats absolutely below the input, same as in the real composer — kept
          at the bottom of the harness page so it never overlaps a section that comes after it. */}
      <Section title="Composer with typeahead open">
        <div className="relative" data-testid="composer-wrap">
          <textarea
            readOnly
            value="is m9"
            rows={1}
            className="dw-input text-body-lg field:text-body-xl resize-none"
            data-testid="composer-input"
          />
          <TypeaheadDropdown items={COMPLETIONS} activeIndex={activeIndex} onHover={setActiveIndex} onSelect={(t) => noteOpen(`select:${t}`)} />
        </div>
        {/* Reserves room for the floated dropdown so the harness page's own scroll height includes it
            (a screenshot with fullPage:true would otherwise crop the dropdown's bottom rows). */}
        <div aria-hidden="true" style={{ height: 260 }} />
      </Section>
    </div>
  );
}
