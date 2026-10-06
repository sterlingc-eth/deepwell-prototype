import type { Doc, Entity, EntityId } from '../core/types'
import { customerForDocument } from '../core/customer'
import { documentTypeLabel } from '../domains/documentTypeLabel'
import { documentName } from '../core/documentName'

export function typeLabel(typeId: string | null): string {
  return documentTypeLabel(typeId) || 'Document'
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

export function customerName(e: Entity | null): string {
  if (!e) return ''
  const f = e.fields
  return str(f.name) || str(f.displayName) || str(f.fullName) || str(f.company) || ''
}

export function customerAddress(e: Entity | null): string {
  if (!e) return ''
  const f = e.fields
  return str(f.address) || str(f.serviceAddress) || str(f.street) || ''
}

export function customerOf(doc: Doc, entities: Record<EntityId, Entity>): Entity | null {
  return customerForDocument(doc, entities)
}

export function fieldValue(f: Doc['extracted'][number]): string {
  return (f.correctedValue ?? f.value ?? '').trim()
}

/** Lower-cased blob the Docs search matches against. Includes BOTH the display name (round 12:
 *  "Warranty · Carol Rios · Trane XR16 · Jun 12, 2025" now matches "warranty rios") and the
 *  original filename — a tech who still remembers "34534895.pdf" must keep finding it too. */
export function searchText(doc: Doc, entities: Record<EntityId, Entity>): string {
  const c = customerOf(doc, entities)
  const cust = c ? Object.values(c.fields).map(str).join(' ') : ''
  const fields = doc.extracted.map(fieldValue).join(' ')
  const name = documentName(doc)
  return `${doc.filename} ${name} ${typeLabel(doc.typeId)} ${cust} ${fields}`.toLowerCase()
}

// `Intl.DateTimeFormat` (what `Date#toLocaleDateString` builds fresh under the
// hood on every single call) does one-time ICU work the first time any
// formatter is constructed in the whole page's life — tens of milliseconds,
// worse under CPU throttling. Building ONE instance here, at module scope
// (this file is a static import of DocSheet.tsx, itself a static import of
// MobileApp.tsx, so it's evaluated during the mobile entry's own initial
// parse/eval, before a tech can tap anything) means that cost lands during
// app boot instead of during a DocSheet or CustomerSheet open, and every
// later date format is then just cheap formatter reuse instead of a rebuild.
export const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function formatDate(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ''
  return DATE_FORMATTER.format(d)
}
