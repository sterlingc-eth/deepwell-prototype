type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }

/** Run `fn` when the main thread is idle (setTimeout fallback where rIC is missing, e.g. Safari). Returns a canceller. */
export function whenIdle(fn: () => void, timeout = 3000): () => void {
  const w = window as IdleWindow
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(fn, { timeout })
    return () => w.cancelIdleCallback?.(h)
  }
  const t = window.setTimeout(fn, Math.min(timeout, 1500))
  return () => window.clearTimeout(t)
}
