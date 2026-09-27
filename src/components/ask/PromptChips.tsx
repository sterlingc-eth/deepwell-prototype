import type { DidYouMeanChip, SamplePrompt } from '../../core/suggestions';

/** One tappable chip row — same visual language as answer/FollowupChips.tsx, reused here for both the
 *  empty-screen sample prompts and the post-miss "Did you mean…" chips (Round 14 K1). */
function ChipRow({ items, onPick }: { items: string[]; onPick: (text: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((q) => (
        <li key={q}>
          <button
            type="button"
            onClick={() => onPick(q)}
            data-tap-target="true"
            className="min-h-11 px-3.5 py-2 text-left font-normal rounded-full border border-line-2 bg-surface text-body text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors duration-quick"
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Role-based sample prompts (tech vs office) for an empty Ask screen — every one of them is seeded with
 *  this tenant's own real data and pre-validated server-side to actually answer without a model call. */
export function SamplePromptChips({ prompts, onPick }: { prompts: SamplePrompt[]; onPick: (q: string) => void }) {
  return <ChipRow items={prompts.map((p) => p.text)} onPick={onPick} />;
}

/** "Did you mean…" rephrasings offered after a failed/"not on file" answer — a spelling fix against this
 *  tenant's own vocabulary, or the same question with a real customer/address added. */
export function DidYouMeanChips({ chips, onPick }: { chips: DidYouMeanChip[]; onPick: (q: string) => void }) {
  if (!chips.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="dw-label">Did you mean</h3>
      <ChipRow items={chips.map((c) => c.text)} onPick={onPick} />
    </div>
  );
}

// Reasonable, deliberately varied footprints for the skeleton bars below — never a real (guessed)
// question, since a guess rendering here first and then getting replaced by the real one is exactly the
// flicker Round 18 P2 fixes (src/core/suggestions.ts's useSamplePrompts). Tuned to sit close to typical
// sample-prompt chip widths so there's little to no jump once real content lands; not a pixel-exact
// promise for arbitrarily long future text, but a stable, fixed-size stand-in in the meantime.
const PLACEHOLDER_CHIP_WIDTHS = ['w-64', 'w-72', 'w-56'];

/** Fixed-height stand-in for SamplePromptChips, shown only while the very first fetch for this
 *  tenant+role is still in flight (no cache yet — see useSamplePrompts' `loading`). Same chip footprint
 *  (min-h-11, same gap) as the real thing so nothing shifts once it arrives. `aria-hidden` + no text:
 *  never announced, never mistaken for real content by anything (including a screenshot diff or a
 *  mutation observer watching for suggestion text changing after first paint). */
export function SamplePromptsPlaceholder({ count = PLACEHOLDER_CHIP_WIDTHS.length }: { count?: number }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-hidden="true" data-testid="sample-prompts-placeholder">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className={`min-h-11 h-11 ${PLACEHOLDER_CHIP_WIDTHS[i % PLACEHOLDER_CHIP_WIDTHS.length]} rounded-full border border-line-2 bg-surface-2/70 animate-pulse`} />
        </li>
      ))}
    </ul>
  );
}

/** Same idea as SamplePromptsPlaceholder, shaped for the mobile Ask tab's stacked full-width rows
 *  instead of desktop's wrapped pills — one skeleton bar per row, `min-h-touch` matching the real
 *  buttons exactly. */
export function SamplePromptRowsPlaceholder({ count = 3 }: { count?: number }) {
  return (
    <div className="w-full grid grid-cols-1 gap-2" aria-hidden="true" data-testid="sample-prompts-placeholder">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="w-full min-h-touch rounded-xl bg-surface-2/70 animate-pulse" />
      ))}
    </div>
  );
}
