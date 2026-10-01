import { memo, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, CloudOff, FileUp, Loader2, LogIn, Trash2 } from 'lucide-react'
import { sha256Hex, waitForIngest, type IngestProgress, type IngestResult } from '../services/ingestClient'
import { fetchDocumentIntakeSummaries, type DocumentIntakeSummary } from '../services/intakeClient'
import { combineToPdf, preparePhoto, scanFilename, type PreparedPage } from './imagePrep'
import {
  attemptUploadOnce,
  offlineQueue,
  QueueQuotaError,
  registerBackgroundSync,
  wireAutoDrain,
  type QueuedUpload,
  type UploadOutcome,
} from './offline/uploadQueue'

interface Picked {
  id: number
  file: File
  preview: string | null
}

type Phase = 'pick' | 'working' | 'done'

/** A result that landed in the offline queue instead of uploading right
 *  away — `documentId` isn't known yet, so it's not shown as uploaded or
 *  read; see the separate "Waiting to upload" strip for its live status. */
type ScanResult = IngestResult & { queuedOffline?: boolean }

/** Adds the one state a scan can be in this run that ingestClient's own
 *  status enum has no reason to know about: no signal, saved for later. */
type ScanProgressStatus = IngestProgress['status'] | 'queued-offline'
interface ScanProgress {
  filename: string
  status: ScanProgressStatus
  error?: string
}

const STATUS_TEXT: Record<ScanProgressStatus, string> = {
  hashing: 'Preparing…',
  uploading: 'Uploading…',
  reading: 'Donovan is reading…',
  queued: 'Queued for reading…',
  pending: 'Reading…',
  waiting: 'Waiting a moment…',
  done: 'Done',
  error: 'Failed',
  'queued-offline': 'No signal — will upload automatically',
}

/** A live attempt gets this long before it's treated the same as a hard
 *  failure and handed to the offline queue — long enough for a slow cell
 *  connection, short enough that a truly dead radio doesn't stall "capture →
 *  done" for the tech standing in a basement. */
const LIVE_ATTEMPT_TIMEOUT_MS = 20_000

/** Per-item status line for the "Waiting to upload" strip. */
function queueItemStatusText(item: QueuedUpload): string {
  if (item.status === 'auth-error') return item.error ?? 'Sign in again to send this'
  if (item.status === 'uploading') return 'Uploading…'
  if (item.status === 'error') {
    if (item.errorClass === 'too-large') return item.error ?? 'File is too large'
    if (item.errorClass === 'permanent') return item.error ?? "Couldn't upload"
    return `${item.error ?? 'Waiting for a signal'} — will retry`
  }
  return 'Waiting for a signal…'
}

function isImage(f: File) {
  return f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name)
}

export const ScanTab = memo(function ScanTab({
  onUploaded,
  onOpenDocs,
  onOpenDoc,
  tenantKey = null,
}: {
  onUploaded: () => void
  onOpenDocs: () => void
  /** Round 17 audit fix #2: opens the just-scanned document itself (its
   *  DocSheet now has an in-place answer control) instead of only switching
   *  to the Docs tab and leaving the tech to find it again. Optional so the
   *  offline-queue-harness (which only exercises the upload path, not the
   *  post-upload "needs an answer" link) doesn't need to change. */
  onOpenDoc?: (id: string) => void
  /** The signed-in org id (or user id when there's no org) — same value
   *  MobileApp.tsx's usePostgresSync already keys on. Namespaces the offline
   *  queue so a phone shared between two shops never drains one shop's scans
   *  into the other's. MobileApp passes `orgId ?? userId ?? null`. */
  tenantKey?: string | null
}) {
  const [picked, setPicked] = useState<Picked[]>([])
  const [combine, setCombine] = useState(true)
  const [phase, setPhase] = useState<Phase>('pick')
  const [prepMessage, setPrepMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({})
  const [results, setResults] = useState<ScanResult[]>([])
  // The offline queue is cross-session state (it outlives "Scan another" and
  // even leaving the tab), so it's tracked separately from the per-run
  // progress/results above and rendered as its own persistent strip.
  const [queueItems, setQueueItems] = useState<QueuedUpload[]>([])
  // Live post-upload status (Round 13, H2, research #7): once a document is uploaded, straight-
  // through autofill keeps working in the background — this is a best-effort, short-lived poll of
  // that progress, not a persistent tracker (a field tech scanning paperwork typically moves on
  // within seconds; Records/the Inbox is where the fuller picture lives after that).
  const [intake, setIntake] = useState<Record<string, DocumentIntakeSummary>>({})
  const cameraRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)

  // Free the thumbnails' object URLs when they leave the list.
  const previews = useRef(new Set<string>())
  useEffect(() => {
    const set = previews.current
    return () => set.forEach((u) => URL.revokeObjectURL(u))
  }, [])

  // A queued item can land long after this run's own "done" screen already
  // rendered its stale "No signal — saved on your phone" line (the tech may
  // have moved to Docs and back by then) — patch that ONE row in place with
  // the real outcome instead of leaving it saying "no signal" forever.
  const patchQueuedResult = (item: QueuedUpload, outcome: UploadOutcome) =>
    setResults((prev) =>
      prev.map((r) =>
        r.queuedOffline && r.filename === item.filename
          ? { filename: item.filename, documentId: outcome.documentId, pages: outcome.pages, queued: outcome.queued, awaitingExtraction: outcome.awaitingExtraction, duplicate: outcome.duplicate }
          : r
      )
    )

  // A failure that's already known for certain (413/permanent/auth) replaces
  // the generic "waiting for a signal" line right away; a merely transient
  // one (a blip, still being retried) is left as-is — "will upload
  // automatically" stays true for that one.
  const patchQueuedError = (item: QueuedUpload) => {
    if (item.errorClass === 'transient') return
    setResults((prev) => prev.map((r) => (r.queuedOffline && r.filename === item.filename ? { filename: item.filename, error: item.error ?? "Couldn't upload" } : r)))
  }

  // Subscribe to this tenant's offline queue and wire every trigger that
  // should attempt to drain it: right now (mount / "app open"), the `online`
  // event, the tab becoming visible again, and a wake-up from the service
  // worker's Background Sync handler where the browser supports it — plus
  // each item's own exponential-backoff timer (inside the queue itself).
  // Re-wires if the signed-in org changes so a queue never drains into the
  // wrong tenant.
  useEffect(() => {
    // Nobody signed in / no shop yet: nothing may upload. Otherwise only THIS shop's queue may (R30 isolation).
    offlineQueue.setActiveTenant(tenantKey)
    if (!tenantKey) return
    const unsubscribe = offlineQueue.subscribe(tenantKey, setQueueItems)
    const unwire = wireAutoDrain(offlineQueue, tenantKey, {
      onUploaded: (item, outcome) => {
        onUploaded()
        patchQueuedResult(item, outcome)
      },
      onError: patchQueuedError,
    })
    return () => {
      unsubscribe()
      unwire()
      offlineQueue.setActiveTenant(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantKey])

  const add = (list: FileList | null) => {
    if (!list?.length) return
    const next: Picked[] = Array.from(list).map((file) => {
      const preview = isImage(file) ? URL.createObjectURL(file) : null
      if (preview) previews.current.add(preview)
      return { id: nextId.current++, file, preview }
    })
    setPicked((p) => [...p, ...next])
  }

  const remove = (id: number) =>
    setPicked((p) => {
      const gone = p.find((x) => x.id === id)
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview)
        previews.current.delete(gone.preview)
      }
      return p.filter((x) => x.id !== id)
    })

  const photos = picked.filter((p) => isImage(p.file))
  const others = picked.filter((p) => !isImage(p.file))
  const willCombine = combine && photos.length > 1

  const upload = async () => {
    if (!picked.length) return
    setPhase('working')
    setResults([])
    setProgress({})
    try {
      // 1. Shrink photos on the phone.
      setPrepMessage(photos.length ? `Optimizing ${photos.length} photo${photos.length === 1 ? '' : 's'}…` : null)
      const prepared: { page: PreparedPage | null; original: File }[] = []
      for (const p of photos) prepared.push({ page: await preparePhoto(p.file), original: p.file })

      // 2. Build the upload list.
      const files: File[] = []
      const ready = prepared.filter((x): x is { page: PreparedPage; original: File } => x.page !== null)
      const undecodable = prepared.filter((x) => x.page === null).map((x) => x.original)
      if (willCombine && ready.length > 1) {
        setPrepMessage(`Combining ${ready.length} pages into one document…`)
        const pdf = await combineToPdf(ready.map((x) => x.page))
        files.push(new File([pdf], scanFilename('pdf'), { type: 'application/pdf' }))
      } else {
        ready.forEach((x, i) =>
          files.push(new File([x.page.blob], scanFilename('jpg', ready.length > 1 ? i : undefined), { type: 'image/jpeg' }))
        )
      }
      files.push(...undecodable, ...others.map((o) => o.file))
      // Progress is keyed by filename, so two picked files with the same name
      // (e.g. two "scan.pdf") get a " (2)" suffix instead of sharing a row.
      const seen = new Map<string, number>()
      for (const [i, f] of files.entries()) {
        const n = (seen.get(f.name) ?? 0) + 1
        seen.set(f.name, n)
        if (n > 1) files[i] = new File([f], f.name.replace(/(\.[^.]*)?$/, ` (${n})$1`), { type: f.type })
      }
      setPrepMessage(null)

      // 3. Same ingest path as the desktop Inbox — with one addition: a file
      //    that fails (or a phone with no signal at all) falls back to the
      //    offline queue instead of just showing a red error, so the tech
      //    never has to remember to come back and retry it by hand. This is
      //    the ONLY difference from ingestFiles(): a live attempt per file,
      //    and a queue.enqueue() in the catch. Nothing changes about the
      //    happy path — capture -> upload -> done, zero extra taps.
      const report = (filename: string, status: ScanProgressStatus, error?: string) =>
        setProgress((prev) => ({ ...prev, [filename]: { filename, status, error } }))

      const runOne = async (file: File): Promise<ScanResult> => {
        report(file.name, 'hashing')
        let sha256: string
        try {
          sha256 = await sha256Hex(file)
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Could not prepare this file.'
          report(file.name, 'error', error)
          return { filename: file.name, error }
        }

        const online = typeof navigator === 'undefined' || navigator.onLine !== false
        if (online) {
          report(file.name, 'uploading')
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), LIVE_ATTEMPT_TIMEOUT_MS)
          try {
            const outcome = await attemptUploadOnce(file, sha256, controller.signal, tenantKey ?? undefined)
            clearTimeout(timer)
            if (outcome.duplicate) {
              report(file.name, 'done')
              return { filename: file.name, documentId: outcome.documentId, duplicate: true }
            }
            if (outcome.queued) {
              report(file.name, 'queued')
              return { filename: file.name, documentId: outcome.documentId, queued: true, awaitingExtraction: outcome.awaitingExtraction }
            }
            report(file.name, 'done')
            return { filename: file.name, documentId: outcome.documentId, pages: outcome.pages }
          } catch (err) {
            clearTimeout(timer)
            return queueForLater(file, sha256, err)
          }
        }
        return queueForLater(file, sha256, null)
      }

      const queueForLater = async (file: File, sha256: string, liveErr: unknown): Promise<ScanResult> => {
        if (!tenantKey) {
          const message = liveErr instanceof Error ? liveErr.message : "Couldn't reach DeepWell — check your connection and try again."
          report(file.name, 'error', message)
          return { filename: file.name, error: message }
        }
        try {
          await offlineQueue.enqueue(tenantKey, file, sha256)
          void registerBackgroundSync()
          void offlineQueue.drain(tenantKey, {
            onUploaded: (item, outcome) => {
              onUploaded()
              patchQueuedResult(item, outcome)
            },
            onError: patchQueuedError,
          })
          report(file.name, 'queued-offline')
          return { filename: file.name, queuedOffline: true }
        } catch (err) {
          const message =
            err instanceof QueueQuotaError
              ? err.message
              : liveErr instanceof Error
                ? liveErr.message
                : err instanceof Error
                  ? err.message
                  : "Couldn't reach DeepWell — check your connection and try again."
          report(file.name, 'error', message)
          return { filename: file.name, error: message }
        }
      }

      // Sequential on purpose: a field scan is a handful of pages, already
      // shrunk on-device, and this keeps one clear "N of M" progress order
      // instead of interleaved rows — a bounded worker pool buys nothing here.
      const out: ScanResult[] = []
      for (const file of files) out.push(await runOne(file))

      const settled = await waitForIngest(out, (p) => setProgress((prev) => ({ ...prev, [p.filename]: p })))
      setResults(settled)
      onUploaded()
    } catch (err) {
      setResults([{ filename: 'Upload', error: err instanceof Error ? err.message : 'Upload failed' }])
    } finally {
      setPrepMessage(null)
      setPhase('done')
    }
  }

  const reset = () => {
    picked.forEach((p) => p.preview && URL.revokeObjectURL(p.preview))
    previews.current.clear()
    setPicked([])
    setResults([])
    setProgress({})
    setIntake({})
    setPhase('pick')
  }

  // Poll each uploaded document's intake status a few times (autofill runs right after the read
  // step commits) — best-effort: a failed poll just leaves whatever status was last shown, never
  // an error the person has to deal with mid-scan.
  useEffect(() => {
    if (phase !== 'done') return
    const ids = results.filter((r) => !!r.documentId && !r.error).map((r) => r.documentId as string)
    if (!ids.length) return
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      try {
        const rows = await fetchDocumentIntakeSummaries(ids)
        if (!cancelled) setIntake((prev) => ({ ...prev, ...Object.fromEntries(rows.map((r) => [r.documentId, r])) }))
      } catch {
        /* best-effort only */
      }
      attempts += 1
      const allSettled = ids.every((id) => intake[id]?.read || intake[id]?.verified)
      if (!cancelled && attempts < 6 && !allSettled) setTimeout(poll, 2500)
    }
    void poll()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, results])

  /** "Reading… / Filled 7 of 8 fields… / Needs 1 answer" — the one line the owner asked for. */
  function intakeStatusText(documentId: string | undefined): string | null {
    if (!documentId) return null
    const s = intake[documentId]
    if (!s) return 'Reading…'
    if (!s.read) return 'Reading…'
    const filled = `Filled ${s.filledCount} of ${s.totalRequired} field${s.totalRequired === 1 ? '' : 's'}`
    if (s.openQuestion) return `${filled} — needs 1 answer`
    if (s.verified || s.totalRequired === 0) return `${filled} — all set`
    return `${filled}…`
  }

  const failed = results.filter((r) => r.error)
  const queuedOfflineCount = results.filter((r) => r.queuedOffline).length
  const billingUrl = results.find((r) => r.billingUrl)?.billingUrl
  const anyAuthBlocked = queueItems.some((it) => it.status === 'auth-error')

  return (
    <div className="h-full flex flex-col" data-testid="scan-root">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid="scan-camera-input" onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      <input
        ref={filesRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        data-testid="scan-files-input"
        onChange={(e) => (add(e.target.files), (e.target.value = ''))}
      />

      {/* Persistent across phases and even across "Scan another" — these are
          scans that didn't go out yet, not this run's progress. */}
      {queueItems.length > 0 && (
        <div className="shrink-0 border-b border-line/60 bg-surface-2" data-testid="offline-queue-strip">
          <div className="max-w-2xl mx-auto px-4 py-2">
            <div className="flex items-center gap-2">
              <CloudOff className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
              <span className="flex-1 text-body font-semibold text-ink">Waiting to upload ({queueItems.length})</span>
              {anyAuthBlocked && (
                <button
                  type="button"
                  onClick={() => tenantKey && offlineQueue.retryAuthNow(tenantKey)}
                  className="min-h-8 px-2 rounded-lg bg-accent/20 text-accent-ink text-caption font-semibold inline-flex items-center gap-1"
                >
                  <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                  Sign in again
                </button>
              )}
            </div>
            <ul className="list-none p-0 m-0 mt-1 divide-y divide-line/40 max-h-40 overflow-y-auto" aria-label="Queued uploads">
              {queueItems.map((item) => (
                <li key={item.id} className="flex items-center gap-2 py-1.5">
                  {item.status === 'uploading' ? (
                    <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" aria-hidden="true" />
                  ) : item.status === 'auth-error' || (item.status === 'error' && item.errorClass && item.errorClass !== 'transient') ? (
                    <AlertTriangle className="w-4 h-4 text-bad shrink-0" aria-hidden="true" />
                  ) : (
                    <CloudOff className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block text-caption text-ink truncate">{item.filename}</span>
                    <span className="block text-caption text-ink-3">{queueItemStatusText(item)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => tenantKey && void offlineQueue.remove(tenantKey, item.id)}
                    aria-label={`Remove ${item.filename} from the upload queue`}
                    className="w-11 h-11 flex items-center justify-center shrink-0"
                  >
                    <Trash2 className="w-4 h-4 text-ink-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-2xl mx-auto px-4 py-5 short:py-2">
          {phase === 'pick' && (
            <>
              <h2 className="text-h3 font-semibold m-0">Scan paperwork</h2>
              <p className="text-body text-ink-2 mt-1 mb-4 short:hidden">Work orders, warranty cards, nameplates, invoices. Donovan reads and files them.</p>

              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="w-full h-20 short:h-14 short:mt-2 rounded-2xl bg-accent text-forest-950 font-semibold text-body-lg flex items-center justify-center gap-3"
              >
                <Camera className="w-7 h-7" aria-hidden="true" />
                {photos.length ? 'Add another page' : 'Take photo'}
              </button>
              <button
                type="button"
                onClick={() => filesRef.current?.click()}
                className="w-full min-h-touch mt-2 rounded-xl text-accent-ink font-semibold flex items-center justify-center gap-2"
              >
                <FileUp className="w-5 h-5" aria-hidden="true" />
                Choose photos or PDFs
              </button>

              {picked.length > 0 && (
                <ul className="list-none p-0 m-0 mt-4 -mx-4 px-4 flex gap-2 overflow-x-auto no-scrollbar snap-x" aria-label="Pages to upload">
                  {picked.map((p, i) => (
                    <li key={p.id} className="relative w-24 shrink-0 snap-start aspect-[3/4] rounded-lg overflow-hidden bg-surface-2">
                      {p.preview ? (
                        <img src={p.preview} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center text-caption text-ink-2">
                          <FileUp className="w-6 h-6 text-accent mb-1" aria-hidden="true" />
                          <span className="break-all line-clamp-3">{p.file.name}</span>
                        </div>
                      )}
                      <span className="absolute left-1 bottom-1 px-1.5 rounded bg-black/60 text-white text-caption">{i + 1}</span>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
                        aria-label={`Remove ${p.file.name}`}
                        className="absolute right-0 top-0 w-11 h-11 flex items-start justify-end p-1.5"
                      >
                        <span className="w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center">
                          <Trash2 className="w-3.5 h-3.5" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {phase !== 'pick' && (
            <div className="grid grid-cols-1 gap-3">
              <h2 className="text-h3 font-semibold m-0">
                {phase === 'working'
                  ? 'Uploading…'
                  : failed.length
                    ? 'Finished with problems'
                    : queuedOfflineCount
                      ? 'Saved — will upload automatically'
                      : 'All filed'}
              </h2>
              {phase === 'working' && <p className="m-0 text-body text-ink-2">You can switch tabs; this keeps going while the app is open.</p>}
              {prepMessage && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-surface text-body">
                  <Loader2 className="w-5 h-5 animate-spin text-accent" /> {prepMessage}
                </div>
              )}
              <ul className="list-none p-0 m-0 divide-y divide-line/60">
                {(phase === 'working' ? Object.values(progress) : []).map((p) => (
                  <li key={p.filename} className="flex items-center gap-3 py-3">
                    {p.status === 'done' ? (
                      <CheckCircle2 className="w-5 h-5 text-ok shrink-0" />
                    ) : p.status === 'error' ? (
                      <AlertTriangle className="w-5 h-5 text-bad shrink-0" />
                    ) : p.status === 'queued-offline' ? (
                      <CloudOff className="w-5 h-5 text-ink-3 shrink-0" />
                    ) : (
                      <Loader2 className="w-5 h-5 animate-spin text-accent shrink-0" />
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-body text-ink truncate">{p.filename}</span>
                      <span className="block text-caption text-ink-3">{p.error ?? STATUS_TEXT[p.status]}</span>
                    </span>
                  </li>
                ))}
                {phase === 'done' &&
                  results.map((r, i) => {
                    const status = !r.error && !r.duplicate && !r.queuedOffline ? intakeStatusText(r.documentId) : null
                    const needsAnswer = Boolean(r.documentId && intake[r.documentId]?.openQuestion)
                    return (
                      <li key={`${r.filename}-${i}`} className="flex items-center gap-3 py-3">
                        {r.error ? (
                          <AlertTriangle className="w-5 h-5 text-bad shrink-0" />
                        ) : r.queuedOffline ? (
                          <CloudOff className="w-5 h-5 text-ink-3 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-5 h-5 text-ok shrink-0" />
                        )}
                        <span className="flex-1 min-w-0">
                          <span className="block text-body text-ink truncate">{r.filename}</span>
                          <span className="block text-caption text-ink-3">
                            {r.error ??
                              (r.queuedOffline
                                ? 'No signal — saved on your phone, will upload automatically'
                                : r.duplicate
                                  ? 'Already in DeepWell — nothing new to add'
                                  : r.queued
                                    ? 'Uploaded — still being read'
                                    : 'Uploaded and read')}
                          </span>
                          {status && (
                            needsAnswer ? (
                              <button
                                type="button"
                                onClick={() => (r.documentId && onOpenDoc ? onOpenDoc(r.documentId) : onOpenDocs())}
                                className="block text-caption text-accent-ink font-semibold underline mt-0.5 text-left"
                              >
                                {status}
                              </button>
                            ) : (
                              <span className="block text-caption text-ink-3 mt-0.5">{status}</span>
                            )
                          )}
                        </span>
                      </li>
                    )
                  })}
              </ul>
              {billingUrl && (
                <a href={billingUrl} className="text-body font-semibold underline text-accent-ink">
                  See plans
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Primary action pinned above the tab bar so it's never scrolled away. */}
      {phase === 'pick' && picked.length > 0 && (
        <div className="shrink-0 border-t border-line/60 bg-surface">
          <div className="max-w-2xl mx-auto px-4 py-2 grid gap-1">
            {photos.length > 1 && (
              <label className="min-h-11 flex items-center justify-between gap-3 text-body text-ink-2">
                <span>{combine ? `One document, ${photos.length} pages` : `${photos.length} separate documents`}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={combine}
                  onChange={(e) => setCombine(e.target.checked)}
                  aria-label="Upload the photos as pages of one document"
                  className="w-6 h-6 accent-[var(--dw-accent)]"
                />
              </label>
            )}
            <button type="button" onClick={() => void upload()} className="w-full min-h-touch rounded-xl bg-forest-500 text-stone-0 font-semibold text-body-lg">
              Upload {willCombine ? `${photos.length} pages` : `${picked.length} file${picked.length === 1 ? '' : 's'}`}
              {willCombine && others.length ? ` + ${others.length} file${others.length === 1 ? '' : 's'}` : ''}
            </button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="shrink-0 border-t border-line/60 bg-surface">
          <div className="max-w-2xl mx-auto px-4 py-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={reset} className="min-h-touch rounded-xl bg-accent text-forest-950 font-semibold">
              Scan another
            </button>
            <button type="button" onClick={onOpenDocs} className="min-h-touch rounded-xl bg-surface-2 text-ink font-semibold">
              View docs
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
