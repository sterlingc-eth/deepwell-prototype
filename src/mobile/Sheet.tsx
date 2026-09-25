import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * Detail panel chrome: a bottom sheet on phones, a centered dialog from
 * tablet width up. Escape, the backdrop and the X all close it; focus moves
 * into it on open and back to where it came from on close.
 */
export function Sheet({ eyebrow, title, onClose, children }: { eyebrow?: string; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Latest onClose without re-running the mount effect (callers pass inline arrows).
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onCloseRef.current()
      // Keep Tab inside the dialog (aria-modal) instead of wandering behind the backdrop.
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])')
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restore?.focus?.({ preventScroll: true })
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:justify-center md:items-center md:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div ref={panelRef} className="dw-safe-bottom relative w-full max-h-[88dvh] short:max-h-[94dvh] overflow-y-auto overscroll-contain rounded-t-2xl md:rounded-2xl md:max-w-lg bg-surface shadow-modal">
        <div className="sticky top-0 z-10 bg-surface px-4 pt-2 pb-2 flex items-start gap-2 border-b border-line/60">
          <div className="flex-1 min-w-0 pt-2">
            {eyebrow && <p className="m-0 text-caption text-accent-ink font-semibold uppercase tracking-wide">{eyebrow}</p>}
            <h2 className="m-0 text-h4 font-semibold text-ink break-words">{title}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 shrink-0 flex items-center justify-center rounded-full text-ink-3">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 py-4 grid grid-cols-1 gap-4">{children}</div>
      </div>
    </div>
  )
}
