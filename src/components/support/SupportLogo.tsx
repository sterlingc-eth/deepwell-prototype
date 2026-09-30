import './support.css';

/**
 * The DeepWell concentric-circles mark (same geometry as public/favicon.svg). With `pulsing` the rings
 * brighten and swell outward in sequence, a calm ~2.8s ripple; pure CSS, switched off under
 * prefers-reduced-motion (see support.css). `plate` draws the dark rounded tile the favicon uses so the mark
 * reads on any surface; without it the rings take `currentColor`.
 */
const RINGS = [12, 26, 40]; // inner first, so the ripple travels outward

interface SupportLogoProps {
  size?: number;
  pulsing?: boolean;
  plate?: boolean;
  className?: string;
}

export function SupportLogo({ size = 28, pulsing = false, plate = false, className }: SupportLogoProps) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false" className={['dw-sl', pulsing ? 'dw-sl-pulsing' : '', className ?? ''].filter(Boolean).join(' ')}>
      {plate && <rect width="100" height="100" rx="22" fill="#0B1613" />}
      <g fill="none" stroke={plate ? '#D9B57A' : 'currentColor'} strokeWidth={plate ? 8 : 9}>
        {RINGS.map((r, i) => (
          <circle key={r} cx="50" cy="50" r={plate ? r * 0.86 + 5 : r} className="dw-sl-ring" style={{ animationDelay: `${i * 0.3}s` }} />
        ))}
      </g>
    </svg>
  );
}
