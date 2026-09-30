import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import { useGraph } from '../core/entityGraph'
import { getOriginalUrl, type OriginalUrl } from '../services/documentClient'
import { fieldLabel, requirementLabel } from '../domains/hvac/documentTypes'
import {
  dismissIntakeQuestion,
  fetchIntakeQueueItemsForDocument,
  resolveIntakeQuestion,
  snoozeIntakeQuestion,
  type IntakeCandidate,
  type IntakeQueueItem,
} from '../services/intakeClient'
import { IntakeQueueCard } from '../components/intake/IntakeQueueCard'
import { customerAddress, customerName, customerOf, fieldValue, formatDate, typeLabel } from './docUtils'
import { Sheet } from './Sheet'
import { findPassage, passageHighlightOn, passageNeedle, withPdfPage } from '../core/passage'
import { documentName, hasFriendlyName, originalFilename } from '../core/documentName'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENT_USER = 'You' // matches IntakeQueuePanel.tsx's own CURRENT_USER constant

function candidateArgs(c: IntakeCandidate): { value?: string; entityId?: string } {
  return c.kind === 'entity'
    ? { entityId: c.entityId ?? undefined, value: c.value ?? undefined }
    : { value: c.value ?? undefined }
}

/**
 * Round 17 audit fix #2: the exception queue card, reused in place so a tech
 * never has to leave the phone (or find a desktop) to answer the one
 * question autofill couldn't resolve on its own. Same client (intakeClient.ts)
 * and the same card (IntakeQueueCard) InboxScreen.tsx uses — this component
 * only owns the single-document fetch + optimistic remove-on-resolve loop
 * IntakeQueuePanel.tsx already does for its whole list.
 */
function DocIntakeCard({ documentId }: { documentId: string }) {
  const [item, setItem] = useState<IntakeQueueItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fieldBusyKey, setFieldBusyKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [justResolved, setJustResolved] = useState(false)

  const load = async () => {
    setErr(null)
    try {
      const [found] = await fetchIntakeQueueItemsForDocument(documentId)
      setItem(found ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load this question.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  const runResolve = async (args: { value?: string; entityId?: string }) => {
    if (!item || busy) return
    setBusy(true)
    setErr(null)
    try {
      await resolveIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER, ...args })
      setJustResolved(true)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That answer didn't save.")
    } finally {
      setBusy(false)
    }
  }

  const runDismiss = async () => {
    if (!item || busy) return
    setBusy(true)
    setErr(null)
    try {
      await dismissIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER })
      setJustResolved(true)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not dismiss that question.')
    } finally {
      setBusy(false)
    }
  }

  const runSnooze = async () => {
    if (!item || busy) return
    setBusy(true)
    setErr(null)
    try {
      await snoozeIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER })
      setJustResolved(true)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not snooze that question.')
    } finally {
      setBusy(false)
    }
  }

  const runField = async (fieldKey: string, value: string) => {
    if (!item) return
    setFieldBusyKey(fieldKey)
    setErr(null)
    try {
      await resolveIntakeQuestion({ documentId: item.documentId, fieldKey, value, by: CURRENT_USER })
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That correction didn't save.")
    } finally {
      setFieldBusyKey(null)
    }
  }

  if (loading) {
    return (
      <p className="m-0 flex items-center gap-2 text-body text-ink-3">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking for open questions…
      </p>
    )
  }
  if (!item) return justResolved ? <p className="m-0 text-body text-ok-ink">All set — nothing else needs an answer on this document.</p> : null

  return (
    <div>
      <h3 className="m-0 mb-1 text-caption text-ink-3 font-semibold uppercase tracking-wide">Needs your input</h3>
      {err && <p className="m-0 mb-2 text-caption text-bad">{err}</p>}
      <ul className="list-none p-0 m-0">
        <IntakeQueueCard
          item={item}
          active
          shortcutIndex={99}
          busy={busy}
          fieldBusyKey={fieldBusyKey}
          onActivate={() => {}}
          onPickCandidate={(c) => void runResolve(candidateArgs(c))}
          onTypeValue={(value) => void runResolve({ value })}
          onDismiss={() => void runDismiss()}
          onSnooze={() => void runSnooze()}
          onConfirmField={(fieldKey, value) => void runField(fieldKey, value)}
          onFixField={(fieldKey, value) => void runField(fieldKey, value)}
          onPreview={() => {}}
        />
      </ul>
    </div>
  )
}

/** A document's key facts plus its original, one tap away. (Keyed by id in MobileApp, so state starts fresh.) */
export function DocSheet({
  documentId,
  page,
  quote,
  graphLoading,
  onOpenCustomer,
  onClose,
}: {
  documentId: string
  /** Cited page / words from the answer's citation (R31 3a). Optional: opened from Docs there is none. */
  page?: number
  quote?: string
  graphLoading: boolean
  onOpenCustomer: (ref: string) => void
  onClose: () => void
}) {
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
  const citedQuote = passageHighlightOn() ? passageNeedle(quote) : ''
  const citedRef = useRef<HTMLDivElement>(null)
  const isCitedField = (v: string) => {
    const t = v.trim()
    return citedQuote.length >= 3 && t.length >= 3 && !!findPassage(citedQuote, t)
  }
  // Bring the cited row into view once the fields render (inside the sheet's own scroller: no layout shift).
  useEffect(() => {
    if (citedQuote && doc) citedRef.current?.scrollIntoView?.({ block: 'center' })
  }, [citedQuote, doc])
  const fields = (doc?.extracted ?? []).filter((f) => fieldValue(f) && f.name !== 'raw_text')
  const missing = (doc?.issues ?? []).flatMap((i) => (i.kind === 'missing-field' ? [requirementLabel(i.field)] : []))
  const isImage = !!original?.contentType?.startsWith('image/')
  const title = doc ? documentName(doc) : (original?.filename ?? 'Document')

  return (
    <Sheet eyebrow={doc ? typeLabel(doc.typeId) : undefined} title={title} onClose={onClose}>
      {doc && hasFriendlyName(doc) && (
        <p className="m-0 -mt-2 text-caption text-ink-3 truncate">{originalFilename(doc)}</p>
      )}
      {citedQuote && (
        <blockquote
          data-testid="doc-cited-passage"
          className="m-0 rounded-xl border-l-4 border-accent bg-surface-2 px-3 py-2 text-body text-ink"
        >
          <span className="block text-caption text-ink-3 font-semibold uppercase tracking-wide">
            Cited{page ? ` on page ${page}` : ''}
          </span>
          <mark className="bg-brass-200 dark:bg-forest-600 text-ink rounded-sm px-0.5">{citedQuote}</mark>
        </blockquote>
      )}
      {UUID_RE.test(documentId) && <DocIntakeCard documentId={documentId} />}
      {(cust || missing.length > 0) && (
        <div className="rounded-xl bg-surface-2 p-3 grid gap-1">
          {cust && (
            <>
              {/* Round 17 audit fix #3: was a plain <p> — a customer's contact
                  card (with the Call button) was reachable only from an
                  Ask-answer's entity chip, and most phrasings never produced
                  one. Now: find a customer, call them, in <=3 taps from here. */}
              <button
                type="button"
                data-testid="doc-customer-name"
                onClick={() => onOpenCustomer(cust.id)}
                className="min-h-11 -my-2 text-left text-body-lg font-semibold text-ink underline decoration-line-2 underline-offset-2 w-fit"
              >
                {customerName(cust) || 'Unnamed customer'}
              </button>
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

      {/* A fixed-aspect box (not just max-height) so the image's real
          dimensions — unknown until it decodes — never shift this sheet's
          layout once it lands (round 23 M1: CLS-on-sheet-open budget). */}
      {original && isImage && (
        <div className="w-full aspect-[4/3] max-h-72 short:max-h-40 rounded-xl bg-surface-2 overflow-hidden">
          <img src={original.url} alt={title} className="w-full h-full object-contain" />
        </div>
      )}

      {original ? (
        <a
          href={withPdfPage(original.url, page)}
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
          {fields.map((f, i) => {
            const cited = isCitedField(fieldValue(f))
            return (
            <div
              key={`${f.name}-${i}`}
              ref={cited && !fields.slice(0, i).some((g) => isCitedField(fieldValue(g))) ? citedRef : undefined}
              data-passage={cited ? 'true' : undefined}
              className={['flex justify-between gap-4 py-2.5', cited ? 'bg-brass-100 dark:bg-forest-700 -mx-2 px-2 rounded-sm' : ''].join(' ')}
            >
              <dt className="text-caption text-ink-3 shrink-0 max-w-[45%]">
                {fieldLabel(f.name)}
                {f.unitIndex && f.unitIndex > 1 ? ` (unit ${f.unitIndex})` : ''}
              </dt>
              <dd className="m-0 text-body text-ink text-right break-words min-w-0">{fieldValue(f)}</dd>
            </div>
            )
          })}
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
