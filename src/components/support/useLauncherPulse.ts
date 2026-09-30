import { useEffect, useState } from 'react';

/**
 * Pulse policy: on for the first `firstMs` after load, then a short burst every `everyMs`. Never while
 * `suppressed` (chat open). prefers-reduced-motion is handled in CSS.
 */
export function useLauncherPulse(suppressed: boolean, firstMs = 20_000, everyMs = 60_000, burstMs = 6_000): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setOn(false), firstMs));
    const iv = window.setInterval(() => {
      setOn(true);
      timers.push(window.setTimeout(() => setOn(false), burstMs));
    }, everyMs);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearInterval(iv);
    };
  }, [firstMs, everyMs, burstMs]);
  return on && !suppressed;
}
