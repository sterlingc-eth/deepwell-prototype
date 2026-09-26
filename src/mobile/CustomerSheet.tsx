import { useEffect, useState } from 'react'
import { FileText, Loader2, Mail, MapPin, Phone } from 'lucide-react'
import { customerClient, type CustomerDetail, type CustomerDocument } from '../services/customerClient'
import { typeLabel } from './docUtils'
import { Sheet } from './Sheet'

/** customerClient's CustomerDocument doesn't declare `displayName` yet — round 12 hook for
 *  whoever owns api/_lib/routes/customers.js + src/services/customerClient.ts: map
 *  `displayName: d.display_name` alongside the existing `filename: d.original_filename` (see
 *  that route's own document-list mapping) and add `displayName?: string | null` to
 *  CustomerDocument. Read loosely here (rather than left unused) so this screen picks the real
 *  name up the moment that lands, with zero UI change needed on that side. */
type NamedCustomerDocument = CustomerDocument & { displayName?: string | null }

function warrantyStatus(daysLeft: number | null, expires: string | null): { text: string; cls: string } | null {
  if (!expires) return null
  const date = new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (daysLeft == null) return { text: `Warranty to ${date}`, cls: 'bg-surface-2 text-ink-2' }
  if (daysLeft < 0) return { text: `Warranty expired ${date}`, cls: 'bg-bad-bg text-bad-ink' }
  if (daysLeft <= 90) return { text: `Warranty ends ${date}`, cls: 'bg-warn-bg text-warn-ink' }
  return { text: `Warranty to ${date}`, cls: 'bg-ok-bg text-ok-ink' }
}

/** A customer's contact card, units and recent paperwork — straight from the server, no graph needed. */
export function CustomerSheet({ customerRef, onOpenDoc, onClose }: { customerRef: string; onOpenDoc: (id: string) => void; onClose: () => void }) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    customerClient
      .getByRef(customerRef)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not open that customer'))
    return () => {
      cancelled = true
    }
  }, [customerRef])

  const c = detail?.customer
  const action = 'min-h-touch flex-1 rounded-xl bg-surface-2 text-ink font-semibold flex items-center justify-center gap-2 text-body'

  return (
    <Sheet eyebrow={c?.customerNumber ?? 'Customer'} title={c?.name || (detail ? 'Unnamed customer' : 'Customer')} onClose={onClose}>
      {!detail && !error && (
        <p className="m-0 flex items-center gap-2 text-body text-ink-3">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </p>
      )}
      {error && <p className="m-0 text-body text-bad">{error}</p>}

      {c && (
        <>
          {c.serviceAddress && <p className="m-0 text-body text-ink-2">{c.serviceAddress}</p>}
          {(c.phone || c.email || c.serviceAddress) && (
            <div className="flex gap-2">
              {c.phone && (
                <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className={action}>
                  <Phone className="w-4 h-4 text-accent" aria-hidden="true" /> Call
                </a>
              )}
              {c.email && (
                <a href={`mailto:${c.email}`} className={action}>
                  <Mail className="w-4 h-4 text-accent" aria-hidden="true" /> Email
                </a>
              )}
              {c.serviceAddress && (
                <a href={`https://maps.google.com/?q=${encodeURIComponent(c.serviceAddress)}`} target="_blank" rel="noopener noreferrer" className={action}>
                  <MapPin className="w-4 h-4 text-accent" aria-hidden="true" /> Map
                </a>
              )}
            </div>
          )}
        </>
      )}

      {detail && detail.equipment.length > 0 && (
        <section>
          <h3 className="m-0 mb-1 text-caption text-ink-3 font-semibold uppercase tracking-wide">Equipment</h3>
          <ul className="list-none p-0 m-0 divide-y divide-line/60">
            {detail.equipment.map((u) => {
              const w = warrantyStatus(u.warranty.daysLeft, u.warranty.expires)
              return (
                <li key={u.id} className="py-2.5">
                  <p className="m-0 text-body text-ink font-medium">{[u.manufacturer, u.model].filter(Boolean).join(' ') || 'Unit'}</p>
                  <p className="m-0 text-caption text-ink-3">{u.serial ? `S/N ${u.serial}` : 'No serial on file'}</p>
                  {w && <span className={`inline-block mt-1 px-2 py-0.5 rounded-md text-caption font-medium ${w.cls}`}>{w.text}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {detail && detail.documents.length > 0 && (
        <section>
          <h3 className="m-0 mb-1 text-caption text-ink-3 font-semibold uppercase tracking-wide">Recent documents</h3>
          <ul className="list-none p-0 m-0 divide-y divide-line/60">
            {detail.documents.slice(0, 12).map((d) => {
              const title = (d as NamedCustomerDocument).displayName || typeLabel(d.type)
              return (
                <li key={d.id}>
                  <button type="button" onClick={() => onOpenDoc(d.id)} className="w-full min-h-touch py-2 text-left flex items-center gap-3">
                    <FileText className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-body text-ink truncate">{title}</span>
                      <span className="block text-caption text-ink-3 truncate">
                        {[d.serviceDate ?? d.createdAt?.slice(0, 10), d.filename].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </Sheet>
  )
}
