/**
 * The Ask mark — the DeepWell rings, used in place of a generic chat icon.
 *
 * Ask is the product's one irreplaceable action, so it carries the brand rather
 * than a stock glyph. Same concentric geometry as the logo, reduced to three
 * rings so it stays legible at nav size. The ripple reuses the `dw-ring`
 * keyframes from index.css, which are already disabled under
 * prefers-reduced-motion.
 */
const RINGS = [22, 14, 7];

interface AskMarkProps {
  className?: string;
  /** Ripple outward. Off for the resting state, on when Ask is the active screen. */
  active?: boolean;
}

export function AskMark({ className, active = false }: AskMarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" fill="none">
      <g stroke="currentColor" strokeWidth={3.2}>
        {RINGS.map((r, i) => (
          <circle
            key={r}
            cx="24"
            cy="24"
            r={r}
            className={active ? 'dw-ring' : undefined}
            style={active ? { animationDelay: `${i * 320}ms` } : undefined}
          />
        ))}
      </g>
      <circle cx="24" cy="24" r="2.6" fill="currentColor" />
    </svg>
  );
}
