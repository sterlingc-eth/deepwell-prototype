import { useEffect, useState } from 'react';

/**
 * Tracks the on-screen keyboard through window.visualViewport. iOS never shrinks the layout viewport for
 * the keyboard, so a bottom-pinned sheet would sit behind it: `inset` is how far the visual viewport's
 * bottom edge is above the layout viewport's (0 with no keyboard), and `height` is the visible height.
 * Both are null-safe on browsers without visualViewport.
 */
export function useVisualViewport(enabled = true): { inset: number; height: number | null } {
  const [state, setState] = useState<{ inset: number; height: number | null }>({ inset: 0, height: null });
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!enabled || !vv) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setState((s) => (s.inset === inset && s.height === vv.height ? s : { inset, height: vv.height }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return state;
}
