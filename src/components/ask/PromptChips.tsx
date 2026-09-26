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
