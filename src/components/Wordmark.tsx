/**
 * The DeepWell lockup. One component so the brand renders identically on
 * every screen. Colours are sampled from the logo artwork: navy #04315A and
 * forest #0D3827. Neither is legible on the dark surfaces this sits on, so the
 * lockup carries its own light plate rather than recolouring the brand.
 *
 * The mark is the same concentric-ring geometry as the marketing header, so
 * the two lockups stay identical.
 */
const FOREST = '#0D3827';
const RINGS = [46, 37, 28, 19, 10];

interface WordmarkProps {
  /** 'lg' for the sign-in screen, 'sm' for the app header. */
  size?: 'sm' | 'lg';
  /** Ripple the rings outward. Used on the sign-in screen. */
  animated?: boolean;
}

export function Wordmark({ size = 'sm', animated = false }: WordmarkProps) {
  const lg = size === 'lg';
  return (
    <span
      className={`inline-flex items-center rounded-md bg-stone-50 ${lg ? 'gap-3.5 px-5 py-3' : 'gap-2.5 px-2.5 py-1'}`}
    >
      <svg
        viewBox="0 0 100 100"
        aria-hidden="true"
        className={lg ? 'w-11 h-11 shrink-0' : 'w-7 h-7 shrink-0'}
      >
        <g fill="none" stroke={FOREST} strokeWidth={5}>
          {RINGS.map((r, i) => (
            <circle
              key={r}
              cx="50"
              cy="50"
              r={r}
              className={animated ? 'dw-ring' : undefined}
              style={animated ? { animationDelay: `${i * 260}ms` } : undefined}
            />
          ))}
        </g>
        <circle cx="50" cy="50" r="4" fill={FOREST} />
      </svg>
      <span className={`flex flex-col ${lg ? 'gap-1.5' : 'gap-1'}`}>
        <span
          className={`font-display font-semibold leading-none tracking-tight ${lg ? 'text-[34px]' : 'text-[22px]'}`}
        >
          <span className="text-[#04315A]">Deep</span><span className="text-[#0D3827]">Well</span>
        </span>
        <span
          className={`font-mono font-medium uppercase leading-none text-[#0D3827]/70 ${lg ? 'text-[11px] tracking-[0.34em]' : 'text-[8px] tracking-[0.3em]'}`}
        >
          Technology
        </span>
      </span>
    </span>
  );
}
