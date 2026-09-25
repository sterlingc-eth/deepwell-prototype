import { useEffect, useState } from 'react'

const TEXT_INPUT = /^(text|search|email|tel|url|number|password)$/

function isTextField(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && TEXT_INPUT.test(el.type)
}

/**
 * True while a text field has focus on a touch device, i.e. the on-screen
 * keyboard is (almost certainly) up. The shell hides the bottom tab bar then,
 * so the tech keeps the answer and the input in view instead of chrome.
 * Focus-based rather than viewport-based because iOS never resizes the
 * layout viewport for the keyboard and Android resizes it inconsistently.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)')
    const update = () => setOpen(!!coarse?.matches && isTextField(document.activeElement))
    const onBlur = () => window.setTimeout(update, 50)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', onBlur)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', onBlur)
    }
  }, [])
  return open
}
