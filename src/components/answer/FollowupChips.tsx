/**
 * Quick-reply chips generated deterministically from the answer's shape (src/core/answerLayout.ts's
 * followupChips) — one tap asks the obvious next question instead of retyping it one-handed.
 */
export function FollowupChips({ chips, onPick }: { chips: string[]; onPick: (q: string) => void }) {
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Follow-up questions">
      {chips.map((q) => (
        <li key={q}>
          <button
            type="button"
            onClick={() => onPick(q)}
            data-tap-target="true"
            className="min-h-11 px-3.5 rounded-full border border-line-2 bg-surface text-body text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors duration-quick"
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}
