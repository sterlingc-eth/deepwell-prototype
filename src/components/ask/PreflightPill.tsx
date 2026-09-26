import type { PreflightHint } from '../../core/suggestions';

/**
 * The three-level "will this be instant?" hint next to the Ask box (Round 14 K1) — computed server-side,
 * with no model call, from the exact same pre-router shape classifiers ask.js itself runs before it ever
 * pays for a model. Never blocks submitting; it is a forecast, never a gate.
 */
const DOT_CLASS: Record<PreflightHint['level'], string> = {
  instant: 'bg-accent',
  slow: 'bg-warn',
  'needs-anchor': 'bg-ink-3',
};

export function PreflightPill({ hint }: { hint: PreflightHint | null }) {
  if (!hint) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-ink-3" role="status">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[hint.level]}`} aria-hidden="true" />
      {hint.message}
    </span>
  );
}
