import type { Doc, Entity, EntityId } from '../core/types'
import { customerForDocument } from '../core/customer'
import { DOCUMENT_TYPES } from '../domains/hvac/documentTypes'

const TYPE_LABELS = new Map(DOCUMENT_TYPES.map((t) => [t.id, t.label]))

export function typeLabel(typeId: string | null): string {
  return (typeId && TYPE_LABELS.get(typeId)) || 'Document'
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

/** Lower-cased blob the Docs search matches against. */
export function searchText(doc: Doc, entities: Record<EntityId, Entity>): string {
  const c = customerOf(doc, entities)
  const cust = c ? Object.values(c.fields).map(str).join(' ') : ''
  const fields = doc.extracted.map(fieldValue).join(' ')
  return `${doc.filename} ${typeLabel(doc.typeId)} ${cust} ${fields}`.toLowerCase()
}

export function formatDate(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
