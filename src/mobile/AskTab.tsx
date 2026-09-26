import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ArrowUp, RotateCcw, X } from 'lucide-react'
import { ask, AskApiError } from '../services/answerService'
import { authHeader } from '../services/authToken'
import { asksUsedFraction, resetsOnShortLabel, type BillingStatus } from '../services/billingClient'
import { buildSuggestions, useDidYouMean, useSamplePrompts, useTypeahead } from '../core/suggestions'
import { PreflightPill, TypeaheadDropdown, DidYouMeanChips } from '../components/ask'
import { useGraph } from '../core/entityGraph'
import { DonovanMark } from '../components/DonovanMark'
import type { Answer } from '../core/types'
import { MobileAnswer } from './MobileAnswer'
import { canPromptInstall, isIos, isStandalone, onInstallAvailabilityChange, promptInstall } from './pwa'

interface Turn {
  id: number
  question: string
  answer?: Answer
  error?: string
  billingUrl?: string
  slow?: boolean
}

/** Abort a single ask after this long (bad signal) and offer a retry instead of a spinner forever. */
const ASK_TIMEOUT_MS = 60_000
/** After this long, say it's still working so a slow answer doesn't look frozen. */
const SLOW_HINT_MS = 8_000

// Used until the tenant's own records load (or when it has none): tapping
// fills the box rather than sending, so the tech types the real address.
const TEMPLATES = ['Warranty status for ', 'Last service at ', 'Which customers have Trane units?']

// ---------------------------------------------------------------------------

function InstallHint() {
  const [installable, setInstallable] = useState(canPromptInstall())
  useEffect(() => onInstallAvailabilityChange(() => setInstallable(canPromptInstall())), [])
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('deepwell.m.installHint') === 'off'
    } catch {
      return false
    }
  })
  if (dismissed || isStandalone() || !(installable || isIos())) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem('deepwell.m.installHint', 'off')
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="short:hidden mt-6 w-full flex items-center gap-2 rounded-xl bg-surface-2 pl-4 text-caption text-ink-2">
      <span className="flex-1 py-3">{installable ? 'Put DeepWell on your home screen.' : 'Install: tap Share, then "Add to Home Screen".'}</span>
      {installable && (
        <button type="button" onClick={() => void promptInstall()} className="min-h-11 px-3 rounded-lg bg-accent text-forest-950 font-semibold">
          Install
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="w-11 h-11 shrink-0 flex items-center justify-center text-ink-3">
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ComposerHandle {
  fill: (text: string) => void
}

/** Owns its own text state so typing never re-renders the answer thread. */
const Composer = memo(
  forwardRef<ComposerHandle, { busy: boolean; onSubmit: (q: string) => void; usageNote: string | null }>(function Composer(
    { busy, onSubmit, usageNote },
    ref
  ) {
    const [input, setInput] = useState('')
    const taRef = useRef<HTMLTextAreaElement>(null)
    // Round 14 K1: typeahead completions + a preflight hint, same no-model server route the desktop Ask
    // composer uses (src/core/suggestions.ts). Big touch targets, works in sunlight — see TypeaheadDropdown.
    const { completions, hint } = useTypeahead(input)
    const [dropdownOpen, setDropdownOpen] = useState(false)
    const [activeIndex, setActiveIndex] = useState(-1)
    const showDropdown = dropdownOpen && completions.length > 0

    useImperativeHandle(ref, () => ({
      fill(text: string) {
        setInput(text)
        requestAnimationFrame(() => {
          const ta = taRef.current
          if (!ta) return
          ta.focus()
          ta.setSelectionRange(text.length, text.length)
        })
      },
    }))

    // Grow with the text up to ~4 lines, then scroll inside.
    useEffect(() => {
      const ta = taRef.current
      if (!ta) return
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`
    }, [input])

    const send = (text = input) => {
      if (busy || !text.trim()) return
      onSubmit(text)
      setInput('')
      setDropdownOpen(false)
      setActiveIndex(-1)
      taRef.current?.blur() // drop the keyboard so the answer has the screen
    }

    return (
      <div className="shrink-0 border-t border-line/60 bg-surface">
        {hint && !busy && (
          <p className="max-w-2xl mx-auto px-4 pt-1.5 short:hidden">
            <PreflightPill hint={hint} />
          </p>
        )}
        <form
          className="max-w-2xl mx-auto px-3 py-2 short:py-1.5 flex items-end gap-2 relative"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <label htmlFor="dw-m-ask" className="sr-only">
            Ask Donovan
          </label>
          <textarea
            ref={taRef}
            id="dw-m-ask"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setDropdownOpen(true)
              setActiveIndex(-1)
            }}
            onFocus={() => {
              void authHeader() // warm the session token so the ask doesn't wait on a refresh
              setDropdownOpen(true)
            }}
            onBlur={() => setDropdownOpen(false)}
            role="combobox"
            aria-expanded={showDropdown}
            aria-autocomplete="list"
            onKeyDown={(e) => {
              if (showDropdown && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setActiveIndex((i) => {
                  const max = completions.length - 1
                  if (e.key === 'ArrowDown') return i >= max ? max : i + 1
                  return i <= 0 ? -1 : i - 1
                })
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (showDropdown && activeIndex >= 0 && completions[activeIndex]) send(completions[activeIndex].text)
                else send()
              }
            }}
            placeholder="Ask Donovan…"
            enterKeyHint="send"
            autoComplete="off"
            className="flex-1 min-h-12 resize-none rounded-2xl bg-surface-2 text-ink px-4 py-3 placeholder:text-ink-3 border border-transparent focus:outline-none focus:border-accent"
          />
          {showDropdown && (
            <TypeaheadDropdown items={completions} activeIndex={activeIndex} onHover={setActiveIndex} onSelect={(text) => send(text)} />
          )}
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Ask"
            className="w-12 h-12 shrink-0 rounded-full bg-accent text-forest-950 flex items-center justify-center disabled:opacity-40"
          >
            <ArrowUp className="w-5 h-5" />
          </button>
        </form>
        {usageNote && <p className="m-0 max-w-2xl mx-auto px-4 pb-1.5 text-caption text-ink-3 short:hidden">{usageNote}</p>}
      </div>
    )
  })
)

// ---------------------------------------------------------------------------

const TurnView = memo(function TurnView({
  turn,
  onOpenDoc,
  onOpenCustomer,
  onRetry,
  onAsk,
}: {
  turn: Turn
  onOpenDoc: (id: string) => void
  onOpenCustomer: (ref: string) => void
  onRetry: (q: string) => void
  onAsk: (q: string) => void
}) {
  // Round 14 K1: "Did you mean…" chips once this turn's own answer has actually come back with nothing.
  const didYouMean = useDidYouMean(turn.answer?.kind === 'no-answer' ? turn.question : null)
  return (
    <div className="grid grid-cols-1 gap-2 min-w-0 scroll-mt-3" data-turn={turn.id}>
      <div className="justify-self-end max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-forest-600 text-stone-0 text-body-lg break-words">{turn.question}</div>
      {turn.answer && <MobileAnswer question={turn.question} answer={turn.answer} onOpenDoc={onOpenDoc} onOpenCustomer={onOpenCustomer} onAsk={onAsk} />}
      {turn.answer?.kind === 'no-answer' && didYouMean.length > 0 && <DidYouMeanChips chips={didYouMean} onPick={onAsk} />}
      {turn.error && (
        <div role="alert" className="rounded-2xl bg-bad-bg text-bad-ink p-4 text-body grid gap-2">
          <span>{turn.error}</span>
          {turn.billingUrl ? (
            <a href={turn.billingUrl} className="font-semibold underline">
              See plans
            </a>
          ) : (
            <button type="button" onClick={() => onRetry(turn.question)} className="justify-self-start min-h-11 inline-flex items-center gap-2 font-semibold underline">
              <RotateCcw className="w-4 h-4" /> Try again
            </button>
          )}
        </div>
      )}
      {!turn.answer && !turn.error && (
        <div className="flex items-center gap-3 text-ink-3 text-body" aria-live="polite">
          <DonovanMark size={28} state="reading" />
          {turn.slow ? 'Still working — this one takes a little longer…' : 'Reading your records…'}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------

export function AskTab({
  onOpenDoc,
  onOpenCustomer,
  billing,
}: {
  onOpenDoc: (id: string) => void
  onOpenCustomer: (ref: string) => void
  billing: BillingStatus | null
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  // Counter, not a boolean: a "Try again" can start while another ask is still in flight.
  const [inFlight, setInFlight] = useState(0)
  const busy = inFlight > 0
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const nextId = useRef(1)

  // Real suggestions from this shop's own records once they've loaded. Round 14 K1: the server's own
  // role-based ("tech" — this is the field app) sample prompts come first when it has any — pre-validated
  // to answer without a model call, same as the desktop Ask screen's own "Try asking" — falling back to
  // the client-only entity-graph suggestions, then the generic fill-in templates, exactly as before.
  const entities = useGraph((s) => s.entities)
  const serverPrompts = useSamplePrompts('tech', turns.length === 0)
  const suggestions = useMemo(() => {
    if (serverPrompts.length) return serverPrompts.map((p) => ({ label: p.text, fill: p.text, send: true }))
    const real = buildSuggestions(Object.values(entities), 3)
    return real.length ? real.map((q) => ({ label: q, fill: q, send: true })) : TEMPLATES.map((t) => ({ label: t.endsWith(' ') ? `${t}…` : t, fill: t, send: !t.endsWith(' ') }))
  }, [entities, serverPrompts])

  const update = (id: number, patch: Partial<Turn>) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)))

  // Bring the newest question to the top of the view (not the bottom), so the
  // headline of a long answer is what the tech sees first.
  const lastId = turns.length ? turns[turns.length - 1]!.id : 0
  const lastAnswered = turns.length ? !!(turns[turns.length - 1]!.answer || turns[turns.length - 1]!.error) : false
  useEffect(() => {
    if (!lastId) return
    scrollRef.current?.querySelector(`[data-turn="${lastId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [lastId, lastAnswered])

  const submit = useCallback(async (q: string) => {
    const question = q.trim()
    if (!question) return
    const id = nextId.current++
    setTurns((t) => [...t, { id, question }])
    setInFlight((n) => n + 1)
    const controller = new AbortController()
    const slowTimer = window.setTimeout(() => update(id, { slow: true }), SLOW_HINT_MS)
    const killTimer = window.setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
    try {
      const answer = await ask(question, { signal: controller.signal })
      update(id, { answer })
    } catch (err) {
      const aborted = controller.signal.aborted
      const message = aborted
        ? 'That took too long — probably a weak signal. Try again.'
        : err instanceof TypeError
          ? "Couldn't reach DeepWell. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : 'Something went wrong.'
      const billingUrl = err instanceof AskApiError && err.status === 402 ? (err.url ?? '/app/?screen=billing') : undefined
      update(id, { error: message, billingUrl })
    } finally {
      window.clearTimeout(slowTimer)
      window.clearTimeout(killTimer)
      setInFlight((n) => n - 1)
    }
  }, [])

  const send = useCallback((q: string) => void submit(q), [submit])

  const pct = asksUsedFraction(billing)
  const usageNote =
    pct != null && pct >= 0.8
      ? `${Math.round(Math.min(pct, 1) * 100)}% of this month's usage${resetsOnShortLabel(billing?.usage.resetsOn) ? ` · resets ${resetsOnShortLabel(billing?.usage.resetsOn)}` : ''}`
      : null

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-2xl mx-auto px-4 py-4 short:py-2">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center text-center pt-4 short:pt-0">
              <DonovanMark size={64} className="short:hidden" />
              <h2 className="text-h3 font-semibold mt-3 short:mt-0 mb-1">Ask Donovan</h2>
              <p className="text-body text-ink-2 m-0 max-w-xs short:hidden">A customer, an address, a serial number, or any question about your records.</p>
              <div className="mt-5 short:mt-2 w-full grid grid-cols-1 gap-2">
                {suggestions.map((s, i) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => (s.send ? void submit(s.fill) : composerRef.current?.fill(s.fill))}
                    className={`w-full min-h-touch text-left px-4 py-2.5 rounded-xl bg-surface text-body text-ink-2 ${i >= 2 ? 'short:hidden' : ''}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <InstallHint />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5">
              {turns.map((t) => (
                <TurnView key={t.id} turn={t} onOpenDoc={onOpenDoc} onOpenCustomer={onOpenCustomer} onRetry={send} onAsk={send} />
              ))}
            </div>
          )}
        </div>
      </div>
      <Composer ref={composerRef} busy={busy} onSubmit={send} usageNote={usageNote} />
    </div>
  )
}
