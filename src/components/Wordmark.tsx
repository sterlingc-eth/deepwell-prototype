/**
 * The DeepWell lockup. One component so the brand renders identically on
 * every screen. Colours are sampled from the logo artwork: navy #04315A and
 * forest #0D3827. Neither is legible on the dark surfaces this sits on, so the
 * lockup carries its own light plate rather than recolouring the brand.
 */
const NAVY = 'text-[#04315A]';
const FOREST = '#0D3827';

interface WordmarkProps {
  /** 'lg' for the sign-in screen, 'sm' for the app header. */
  size?: 'sm' | 'lg';
}

export function Wordmark({ size = 'sm' }: WordmarkProps) {
  const lg = size === 'lg';
  return (
    <span className={`inline-flex items-center rounded-md bg-stone-50 ${lg ? 'gap-3 px-4 py-2.5' : 'gap-2.5 px-2.5 py-1'}`}>
      <span
        aria-hidden="true"
        className={`rounded-full grid place-items-center border-[3px] border-[#0D3827] ${lg ? 'w-9 h-9' : 'w-7 h-7'}`}
      >
        <span className={`rounded-full ${lg ? 'w-3 h-3' : 'w-2.5 h-2.5'}`} style={{ background: FOREST }} />
      </span>
      <span className={`font-display font-semibold leading-none tracking-tight ${lg ? 'text-[30px]' : 'text-[22px]'}`}>
        <span className={NAVY}>Deep</span><span className="text-[#0D3827]">Well</span>
      </span>
    </span>
  );
}
