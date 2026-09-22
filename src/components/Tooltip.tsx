import { useId, useState, type ReactNode } from 'react';

interface TooltipProps {
  /** The tooltip's text. Null/empty renders `children` completely unwired —
   *  no tabIndex, no aria-describedby — so a per-row computed string with
   *  nothing to say (see core/customerFilters.ts's `alertsTooltip`) costs
   *  nothing. */
  label: string | null;
  children: ReactNode;
  className?: string;
}

/** A small, accessible hover/focus (and tap, for touch) tooltip — no
 *  library, no positioning engine. A bare `title=` isn't enough (owner
 *  feedback: it needs to actually be readable), so this renders a real
 *  `role="tooltip"` bubble wired to its trigger via `aria-describedby`,
 *  shown on hover, on keyboard focus, and on a touch tap (which fires both
 *  focus and click on the trigger, so a single tap opens it and stays open
 *  until the next tap elsewhere blurs it). */
export function Tooltip({ label, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!label) return <>{children}</>;
  return (
    <span className={['relative inline-flex', className].filter(Boolean).join(' ')}>
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        className="inline-flex outline-none rounded-sm"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-[14rem] whitespace-normal
                     rounded-md bg-stone-900 text-stone-50 text-caption px-2.5 py-1.5 shadow-lift pointer-events-none"
        >
          {label}
        </span>
      )}
    </span>
  );
}
