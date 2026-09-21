export type DonovanState = 'idle' | 'reading' | 'answered';

interface DonovanMarkProps {
  state?: DonovanState;
  /** Rendered size in px (square). */
  size?: number;
  className?: string;
}

/**
 * Donovan's presence on the Ask screen: an abstract "well" — concentric
 * rings inside a lit sphere, the DeepWell mark given depth. Not a face on
 * purpose (owner decision 2026-09-21: abstract over a rendered head — no
 * WebGL, no model asset, nothing uncanny on a trade tool).
 *
 * Three states, all pure SVG/CSS (see .dw-donovan-* in index.css):
 *   idle      — slow breathing ripple, the rings fading in sequence
 *   reading   — quicker ripple plus a sweeping arc while records are read
 *   answered  — one settling pulse, then still
 * Reduced-motion visitors get the static mark. Decorative: aria-hidden.
 */
export function DonovanMark({ state = 'idle', size = 72, className = '' }: DonovanMarkProps) {
  const rings = [30, 22, 14, 7];
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      aria-hidden="true"
      className={['dw-donovan', `dw-donovan-${state}`, className].filter(Boolean).join(' ')}
    >
      <defs>
        <radialGradient id="dw-donovan-sphere" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor="var(--dw-donovan-hi)" />
          <stop offset="55%" stopColor="var(--dw-donovan-mid)" />
          <stop offset="100%" stopColor="var(--dw-donovan-lo)" />
        </radialGradient>
        <radialGradient id="dw-donovan-glow" cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor="var(--dw-donovan-ring)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--dw-donovan-ring)" stopOpacity="0.35" />
        </radialGradient>
      </defs>
      <circle className="dw-donovan-halo" cx="40" cy="40" r="39" fill="url(#dw-donovan-glow)" />
      <circle cx="40" cy="40" r="34" fill="url(#dw-donovan-sphere)" />
      {rings.map((r, i) => (
        <circle
          key={r}
          className="dw-donovan-ring"
          style={{ animationDelay: `${i * 0.45}s` }}
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="var(--dw-donovan-ring)"
          strokeWidth={i === rings.length - 1 ? 2.2 : 1.4}
        />
      ))}
      <circle cx="40" cy="40" r="2.6" fill="var(--dw-donovan-ring)" />
      {/* reading sweep: a short arc that orbits the well */}
      <circle
        className="dw-donovan-sweep"
        cx="40"
        cy="40"
        r="30"
        fill="none"
        stroke="var(--dw-donovan-ring)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="34 155"
      />
      {/* specular highlight — what makes it read as a sphere, not a disc */}
      <ellipse cx="30" cy="26" rx="9" ry="5.5" fill="var(--dw-donovan-hi)" opacity="0.55" transform="rotate(-28 30 26)" />
    </svg>
  );
}
