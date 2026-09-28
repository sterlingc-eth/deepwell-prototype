/** A tiny seedable PRNG (mulberry32) shared by scripts/lib/mockAnthropicClient.mjs and
 *  scripts/live-test-day.mjs — deterministic when `seed` is given (so a sample/mock roll is
 *  reproducible across a --resume or a verify-script assertion), `Math.random` otherwise. */
export function makeRng(seed) {
  if (seed == null) return Math.random;
  let a = Number(seed) >>> 0 || 1;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
