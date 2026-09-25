/** Tailwind classes for a Fact status pill (FactStatus in core/types). */
export function statusClasses(status: string | undefined): string {
  switch (status) {
    case 'ok':
      return 'bg-ok-bg text-ok-ink'
    case 'warn':
      return 'bg-warn-bg text-warn-ink'
    case 'bad':
      return 'bg-bad-bg text-bad-ink'
    case 'info':
      return 'bg-info-bg text-info-ink'
    default:
      return 'bg-surface-2 text-ink-2'
  }
}

/** tel:/mailto: for values that are plainly a phone number or an email address. */
export function contactHref(value: string): string | null {
  const v = value.trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`
  const digits = v.replace(/\D/g, '')
  if (/^[+()\d\s.-]+$/.test(v) && digits.length >= 7 && digits.length <= 15) return `tel:${digits.length === 10 ? '+1' : '+'}${digits}`
  return null
}
