import { startTransition } from 'react'
import { whenIdle } from './idle'

/**
 * R36 (mobile fluidity): chunk loaders for the sheets that are not on the first screen (document, customer,
 * account), plus the idle-time prefetch and the transition-based opener. Component wrappers live in lazySheets.tsx
 * (kept component-only for fast refresh).
 */
let docChunk = false
let customerChunk = false
export const loadDocSheet = () => import('./DocSheet').then((m) => ((docChunk = true), m))
export const loadCustomerSheet = () => import('./CustomerSheet').then((m) => ((customerChunk = true), m))
export const loadAccountSheet = () => import('./AccountSheet')

/**
 * Open a sheet as a React transition once its chunk is in memory: the sheet's render (hundreds of DOM nodes
 * under a 4x-throttled phone) is then time-sliced into short tasks instead of one long one inside the tap.
 * While the chunk is still loading, update synchronously so the tap shows the skeleton sheet at once (a
 * transition that suspends keeps the old screen up with no feedback).
 */
export function openSheet(kind: 'doc' | 'customer', update: () => void) {
  if (kind === 'doc' ? docChunk : customerChunk) startTransition(update)
  else update()
}

/** Prefetch the sheet chunks one idle slot apart (each fires as soon as the main thread is idle; the timeout is only
 *  the latest it may wait). `onDone` runs once every chunk has loaded. Returns a canceller. */
export function schedulePrefetch(onDone?: () => void): () => void {
  const steps = [loadDocSheet, loadCustomerSheet, loadAccountSheet]
  let cancelled = false
  let cancelIdle: () => void = () => {}
  const next = (i: number) => {
    if (cancelled) return
    if (i >= steps.length) return onDone?.()
    cancelIdle = whenIdle(() => {
      void Promise.resolve(steps[i]!()).finally(() => next(i + 1))
    }, 2500 + i * 1000)
  }
  next(0)
  return () => {
    cancelled = true
    cancelIdle()
  }
}

