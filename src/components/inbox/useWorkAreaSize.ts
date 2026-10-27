import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Inbox redesign (banner fix): sizes the Inbox's own scroll area to the space that is really free on screen, so the list
 * and the detail scroll INSIDE it and nothing ever slides over the page footer or the floating Help button.
 *
 * What was wrong: the work area was `position: sticky` with a negative bottom margin (-10rem) plus a 10rem spacer, sized
 * to the whole window height. A sticky box paints above ordinary content, so while the page scrolled the two columns
 * slid over the footer banner and hid it (and on a phone the list ran underneath the round Help button).
 *
 * Now: the area sticks to just under the pinned header (none on a phone), is exactly as tall as what is left of the
 * screen minus `bottomReserve` (the Help button and the phone's safe-area inset), and has no negative margin, so when the
 * page reaches the footer the area scrolls away WITH its own wrapper instead of over the footer.
 */
export function useWorkAreaSize() {
  const regionRef = useRef<HTMLDivElement>(null);
  const [stickyTop, setStickyTop] = useState(12);
  useLayoutEffect(() => {
    const measure = () => {
      // The app's pinned top bar (a phone has none: its header scrolls away with the page).
      const bar = [...document.querySelectorAll('header')].find((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position));
      setStickyTop(bar ? Math.round(bar.getBoundingClientRect().bottom) + 12 : 8);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useLayoutEffect(() => {
    let raf = 0;
    const size = () => {
      raf = 0;
      const el = regionRef.current;
      if (!el) return;
      const top = Math.max(stickyTop, el.getBoundingClientRect().top);
      const desktop = window.matchMedia('(min-width: 1024px)').matches;
      // Room kept clear below the area: desktop only a small margin; a phone also clears the floating Help button (56px + 16px) and the home-bar inset.
      const r = el.getBoundingClientRect();
      // On a narrower laptop the columns reach under the Help button (56px, 16px in from the corner): clear it too.
      const underHelp = r.right > window.innerWidth - 80;
      const reserve = desktop ? (underHelp ? 88 : 16) : 80 + safeAreaBottom();
      el.style.setProperty('--dw-col-h', `${Math.max(desktop ? 240 : 320, Math.round(window.innerHeight - top - reserve))}px`);
    };
    const queueSize = () => { if (!raf) raf = requestAnimationFrame(size); };
    size();
    window.addEventListener('scroll', queueSize, { passive: true });
    window.addEventListener('resize', queueSize);
    return () => { window.removeEventListener('scroll', queueSize); window.removeEventListener('resize', queueSize); if (raf) cancelAnimationFrame(raf); };
  }, [stickyTop]);
  return { regionRef, stickyTop };
}

/** The phone's bottom safe-area inset in px (0 where there is none), read through a throwaway probe element. */
function safeAreaBottom(): number {
  try {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(p);
    const v = parseFloat(getComputedStyle(p).paddingBottom) || 0;
    p.remove();
    return v;
  } catch { return 0; }
}
