import { useEffect, useRef, type RefObject } from 'react';

export interface FocusTrapOptions {
  /** Element to focus when the trap activates. Falls back to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Called on Escape (the event is stopped so outer handlers don't also fire). */
  onEscape?: () => void;
  /** Return focus to the previously focused element on deactivate/unmount. Default true. */
  restoreFocus?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Keeps keyboard focus inside a modal container while `active` is true.
 * - On activation: focuses `initialFocus` (or the first focusable element).
 * - Tab / Shift+Tab wrap within the container.
 * - Escape calls `onEscape` and stops propagation.
 * - On deactivate/unmount: restores focus to whatever had it before.
 *
 * No dependencies; works with any element ref.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  opts: FocusTrapOptions = {},
): void {
  const { initialFocus, onEscape, restoreFocus = true } = opts;

  // Keep the latest onEscape without re-running the trap (and re-focusing)
  // every time the parent passes a new callback identity.
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Initial focus. If nothing is focusable, make the container itself focusable
    // so keyboard users still land inside the dialog.
    const first = initialFocus?.current ?? focusables(container)[0];
    if (first) {
      first.focus();
    } else {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const handler = escapeRef.current;
        if (handler) {
          e.stopPropagation();
          e.preventDefault();
          handler();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const list = focusables(container);
      if (list.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (!firstEl || !lastEl) return;
      const current = document.activeElement;
      const inside = current instanceof HTMLElement && container.contains(current);

      if (e.shiftKey) {
        if (!inside || current === firstEl) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (!inside || current === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    // Capture phase so the trap sees the key before anything inside or outside the dialog.
    document.addEventListener('keydown', onKeyDown, true);

    // If focus escapes by other means (e.g. a click on the backdrop), pull it back.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof Node && container.contains(target)) return;
      const list = focusables(container);
      (list[0] ?? container).focus();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (restoreFocus && previous && previous.isConnected) previous.focus();
    };
    // initialFocus / containerRef are ref objects; their identities are stable.
  }, [active, containerRef, initialFocus, restoreFocus]);
}
