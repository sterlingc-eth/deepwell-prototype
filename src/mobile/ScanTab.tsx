import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, FileUp, Loader2, Trash2 } from 'lucide-react'
import { ingestFiles, type IngestProgress, type IngestResult } from '../services/ingestClient'
import { combineToPdf, preparePhoto, scanFilename, type PreparedPage } from './imagePrep'

interface Picked {
  id: number
  file: File
  preview: string | null
}

type Phase = 'pick' | 'working' | 'done'

const STATUS_TEXT: Record<IngestProgress['status'], string> = {
  hashing: 'Preparing…',
  uploading: 'Uploading…',
  reading: 'Donovan is reading…',
  queued: 'Queued for reading…',
  pending: 'Reading…',
  waiting: 'Waiting a moment…',
  done: 'Done',
  error: 'Failed',
}

function isImage(f: File) {
  return f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name)
}

export function ScanTab({ onUploaded, onOpenDocs }: { onUploaded: () => void; onOpenDocs: () => void }) {
  const [picked, setPicked] = useState<Picked[]>([])
  const [combine, setCombine] = useState(true)
  const [phase, setPhase] = useState<Phase>('pick')
  const [prepMessage, setPrepMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, IngestProgress>>({})
  const [results, setResults] = useState<IngestResult[]>([])
  const cameraRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)

  // Free the thumbnails' object URLs when they leave the list.
  const previews = useRef(new Set<string>())
  useEffect(() => {
    const set = previews.current
    return () => set.forEach((u) => URL.revokeObjectURL(u))
  }, [])

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

      // 3. Same ingest path as the desktop Inbox.
      const out = await ingestFiles(files, (p) => setProgress((prev) => ({ ...prev, [p.filename]: p })), 2)
      setResults(out)
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
    setPhase('pick')
  }

  const failed = results.filter((r) => r.error)
  const billingUrl = results.find((r) => r.billingUrl)?.billingUrl

  return (
    <div className="h-full flex flex-col">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      <input
        ref={filesRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => (add(e.target.files), (e.target.value = ''))}
      />

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
                className="w-full min-h-touch mt-2 rounded-xl text-accent font-semibold flex items-center justify-center gap-2"
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
              <h2 className="text-h3 font-semibold m-0">{phase === 'working' ? 'Uploading…' : failed.length ? 'Finished with problems' : 'All filed'}</h2>
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
                  results.map((r, i) => (
                    <li key={`${r.filename}-${i}`} className="flex items-center gap-3 py-3">
                      {r.error ? <AlertTriangle className="w-5 h-5 text-bad shrink-0" /> : <CheckCircle2 className="w-5 h-5 text-ok shrink-0" />}
                      <span className="flex-1 min-w-0">
                        <span className="block text-body text-ink truncate">{r.filename}</span>
                        <span className="block text-caption text-ink-3">
                          {r.error ?? (r.duplicate ? 'Already in DeepWell — nothing new to add' : r.queued ? 'Uploaded — still being read' : 'Uploaded and read')}
                        </span>
                      </span>
                    </li>
                  ))}
              </ul>
              {billingUrl && (
                <a href={billingUrl} className="text-body font-semibold underline text-accent">
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
}
