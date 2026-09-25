import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { useGraph } from '../core/entityGraph'
import { getOriginalUrl, type OriginalUrl } from '../services/documentClient'
import { fieldLabel, requirementLabel } from '../domains/hvac/documentTypes'
import { customerAddress, customerName, customerOf, fieldValue, formatDate, typeLabel } from './docUtils'
import { Sheet } from './Sheet'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A document's key facts plus its original, one tap away. (Keyed by id in MobileApp, so state starts fresh.) */
export function DocSheet({ documentId, graphLoading, onClose }: { documentId: string; graphLoading: boolean; onClose: () => void }) {
  const doc = useGraph((s) => s.docs[documentId])
  const entities = useGraph((s) => s.entities)
  const [original, setOriginal] = useState<OriginalUrl | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Fetched up front so "Open original" is a plain link (iOS blocks a
  // window.open() that happens after an await). Works before the graph loads.
  useEffect(() => {
    if (!UUID_RE.test(documentId)) return
    let cancelled = false
    getOriginalUrl(documentId)
      .then((o) => !cancelled && setOriginal(o))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : 'Could not load the original'))
    return () => {
      cancelled = true
    }
  }, [documentId])

  const cust = doc ? customerOf(doc, entities) : null
  const fields = (doc?.extracted ?? []).filter((f) => fieldValue(f) && f.name !== 'raw_text')
  const missing = (doc?.issues ?? []).flatMap((i) => (i.kind === 'missing-field' ? [requirementLabel(i.field)] : []))
  const isImage = !!original?.contentType?.startsWith('image/')
  const title = doc?.filename ?? original?.filename ?? 'Document'

  return (
    <Sheet eyebrow={doc ? typeLabel(doc.typeId) : undefined} title={title} onClose={onClose}>
      {(cust || missing.length > 0) && (
        <div className="rounded-xl bg-surface-2 p-3 grid gap-1">
          {cust && (
            <>
              <p className="m-0 text-body-lg font-semibold text-ink">{customerName(cust) || 'Unnamed customer'}</p>
              {customerAddress(cust) && <p className="m-0 text-body text-ink-2">{customerAddress(cust)}</p>}
            </>
          )}
          {missing.length > 0 && (
            <p className="m-0 mt-1 flex gap-2 text-body text-warn">
              <AlertTriangle className="w-4 h-4 mt-1 shrink-0" aria-hidden="true" />
              <span>Missing {missing.join(', ')}</span>
            </p>
          )}
        </div>
      )}

      {original && isImage && <img src={original.url} alt={title} className="w-full max-h-72 short:max-h-40 object-contain rounded-xl bg-surface-2" />}

      {original ? (
        <a
          href={original.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-touch rounded-xl bg-accent text-forest-950 font-semibold flex items-center justify-center gap-2"
        >
          <ExternalLink className="w-5 h-5" aria-hidden="true" /> Open original
        </a>
      ) : loadError ? (
        <p className="m-0 text-caption text-bad">{loadError}</p>
      ) : UUID_RE.test(documentId) ? (
        <div className="min-h-touch rounded-xl bg-surface-2 flex items-center justify-center gap-2 text-ink-3 text-body">
          <Loader2 className="w-4 h-4 animate-spin" /> Getting the original…
        </div>
      ) : null}

      {!doc && (
        <p className="m-0 text-body text-ink-3 flex items-center gap-2">
          {graphLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading details…
            </>
          ) : (
            'Details for this document aren’t on this device yet. Open the original above.'
          )}
        </p>
      )}

      {fields.length > 0 && (
        <dl className="m-0 divide-y divide-line/60">
          {fields.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex justify-between gap-4 py-2.5">
              <dt className="text-caption text-ink-3 shrink-0 max-w-[45%]">
                {fieldLabel(f.name)}
                {f.unitIndex && f.unitIndex > 1 ? ` (unit ${f.unitIndex})` : ''}
              </dt>
              <dd className="m-0 text-body text-ink text-right break-words min-w-0">{fieldValue(f)}</dd>
            </div>
          ))}
        </dl>
      )}

      {doc && (
        <p className="m-0 text-caption text-ink-3">
          Added {formatDate(doc.receivedAt)}
          {doc.pages ? ` · ${doc.pages} page${doc.pages === 1 ? '' : 's'}` : ''}
        </p>
      )}
    </Sheet>
  )
}
