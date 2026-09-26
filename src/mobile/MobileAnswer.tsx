import { memo, useId, useMemo, useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Answer, Fact } from '../core/types'
import { useGraph } from '../core/entityGraph'
import { filterRecords, recordGroups, recordsHeading, recordTarget, showRecordsPanel, splitAnswerHeadline } from '../core/citations'
import { answerLayout, claimCheckNote, followupChips, isModelWritten, numberCitations, sentencesOf, shareText } from '../core/answerLayout'
import { documentName } from '../core/documentName'
import { reviewClient } from '../services/reviewClient'
import { contactHref, statusClasses } from './format'
import { typeLabel } from './docUtils'
import {
  CitationMarkers,
  CitationSourceStrip,
  FollowupChips,
  MoneyHero,
  NotOnFileBadge,
  ShareButton,
  SingleFactHero,
  StatusHero,
  TimelineList,
} from '../components/answer'

type Panel = 'details' | 'records' | 'sources' | null
const RECORDS_PAGE = 25

function FactValue({ fact }: { fact: Fact }) {
  const href = contactHref(fact.value)
  const value = href ? (
    <a href={href} className="underline decoration-accent/60 underline-offset-2">
      {fact.value}
    </a>
  ) : (
    fact.value
  )
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {fact.status && fact.status !== 'muted' ? <span className={`px-2 py-0.5 rounded-md font-medium ${statusClasses(fact.status)}`}>{value}</span> : value}
      {/* A date Donovan worked out (not printed on a page) must never read as though a document said it. */}
      {fact.basis === 'computed' && <span className="text-caption text-ink-3 italic">calculated</span>}
    </span>
  )
}

function FactRow({ fact, onOpenCustomer }: { fact: Fact; onOpenCustomer: (ref: string) => void }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-caption text-ink-3 min-w-0 pt-0.5">
        {fact.entityId ? (
          <button type="button" className="min-h-11 -my-2.5 inline-flex items-center text-left underline decoration-line-2 underline-offset-2" onClick={() => onOpenCustomer(fact.entityId!)}>
            {fact.label}
          </button>
        ) : (
          fact.label
        )}
      </dt>
      <dd className="m-0 text-body text-ink text-right font-medium min-w-0 break-words">
        <FactValue fact={fact} />
      </dd>
    </div>
  )
}

function Feedback({ question }: { question: string }) {
  const [step, setStep] = useState<'idle' | 'asking' | 'sending' | 'done'>('idle')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const noteId = useId()
  const [upSending, setUpSending] = useState(false)
  const btn = 'w-11 h-11 -my-1.5 flex items-center justify-center rounded-full text-ink-3 active:bg-surface-2'

  if (message) return <p className="m-0 text-caption text-ink-3">{message}</p>
  if (step === 'asking' || step === 'sending') {
    return (
      <form
        className="flex items-center gap-2 w-full"
        onSubmit={async (e) => {
          e.preventDefault()
          setStep('sending')
          try {
            const r = await reviewClient.askFeedback(question, 'down', note.trim() || undefined)
            setMessage(
              r.budget
                ? 'Logged. Donovan will re-check it later.'
                : r.replay?.outcome === 'answered_now'
                  ? `Checked again: ${r.replay.answer?.text ?? 'Donovan has a new answer.'}`
                  : 'Logged for review. Thanks.'
            )
          } catch {
            setMessage('Could not save that just now.')
          }
          setStep('done')
        }}
      >
        <label className="sr-only" htmlFor={noteId}>
          What was wrong?
        </label>
        <input
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was wrong? (optional)"
          autoFocus
          className="flex-1 min-w-0 h-11 rounded-lg border border-line-2 bg-surface-2 px-3 text-ink placeholder:text-ink-3"
        />
        <button type="submit" disabled={step === 'sending'} className="h-11 px-4 rounded-lg bg-accent text-forest-950 font-semibold disabled:opacity-50">
          Send
        </button>
      </form>
    )
  }
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        className={btn}
        aria-label="This answer was right"
        data-tap-target="true"
        disabled={upSending}
        onClick={async () => {
          setUpSending(true)
          try {
            await reviewClient.askFeedback(question, 'up')
            setMessage('Thanks, noted.')
          } catch {
            setMessage('Could not save that just now.')
          }
        }}
      >
        <ThumbsUp className="w-4 h-4" />
      </button>
      <button type="button" className={btn} aria-label="This answer was wrong" data-tap-target="true" onClick={() => setStep('asking')}>
        <ThumbsDown className="w-4 h-4" />
      </button>
    </span>
  )
}

/**
 * Donovan's answer, phone-sized: the headline sentence and (at most) one key
 * fact up front; everything else — the rest of the facts, the records behind
 * a count, the cited documents — one tap away behind a single row of toggles.
 * Same data and the same trust rules as the desktop AnswerCard; nothing is
 * dropped, it's only folded.
 */
export const MobileAnswer = memo(function MobileAnswer({
  question,
  answer,
  onOpenDoc,
  onOpenCustomer,
  onAsk,
}: {
  question: string
  answer: Answer
  onOpenDoc: (id: string) => void
  onOpenCustomer: (ref: string) => void
  /** Send a follow-up chip as the next question — omitted, the chip row just doesn't render. */
  onAsk?: (question: string) => void
}) {
  const docs = useGraph((s) => s.docs)
  const [panel, setPanel] = useState<Panel>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [recordLimit, setRecordLimit] = useState(RECORDS_PAGE)

  // Round 12: same layout decision as desktop AnswerCard (src/core/answerLayout.ts) — a money/
  // status/single-fact/timeline shape gets that shared hero component instead of the generic
  // headline-fact-then-Details fold below.
  const layout = useMemo(() => answerLayout(answer), [answer])
  const hasHero = layout === 'money' || layout === 'status' || layout === 'single-fact' || layout === 'timeline'

  const { headline, secondary } = splitAnswerHeadline(answer.text)
  // R13H1: same server-computed per-sentence citations AnswerCard reads — see its own comment.
  const sentenceData = useMemo(() => sentencesOf(answer), [answer])
  const modelWritten = useMemo(() => isModelWritten(answer), [answer])
  const { numbered: numberedSentences, order: citationOrder } = useMemo(
    () => (sentenceData ? numberCitations(sentenceData) : { numbered: [], order: [] }),
    [sentenceData]
  )
  const openCitationDoc = (documentId: string) => onOpenDoc(documentId)
  const textLower = answer.text.toLowerCase()
  // Lead with the first fact only when it adds something the sentence doesn't already say — moot
  // once a hero is already showing the facts, so this stays empty for those layouts.
  const keyFact = hasHero ? undefined : answer.facts.find((f, i) => i === 0 && (f.status || f.basis === 'computed' || !textLower.includes(f.value.toLowerCase())))
  const restFacts = hasHero ? [] : keyFact ? answer.facts.slice(1) : answer.facts

  const claimNote = claimCheckNote(answer)
  const chips = onAsk ? followupChips(answer, question) : []
  const resolveDocName = (id: string) => { const d = docs[id]; return d ? documentName(d) : undefined }

  const records = useMemo(() => answer.records ?? [], [answer.records])
  const hasRecords = showRecordsPanel(answer)
  const groups = useMemo(() => recordGroups(records), [records])
  const shownRecords = useMemo(() => filterRecords(records, '', group), [records, group])
  const total = answer.recordsTotal ?? records.length

  const noAnswer = answer.kind === 'no-answer'
  const citedIds = useMemo(
    () => Array.from(new Set((noAnswer ? answer.closest : answer.sources).map((s) => s.documentId))),
    [answer, noAnswer]
  )

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p))
  const pill = (active: boolean) =>
    `min-h-11 px-3.5 rounded-full text-caption font-semibold whitespace-nowrap ${active ? 'bg-accent text-forest-950' : 'bg-surface-2 text-ink-2'}`

  return (
    <div className="rounded-2xl bg-surface p-4 grid grid-cols-1 gap-2">
      {answer.interpretation && <p className="m-0 text-caption text-ink-3 truncate">Donovan · {answer.interpretation}</p>}
      {noAnswer && <NotOnFileBadge />}
      {numberedSentences.length > 0 ? (
        <>
          <p className="m-0 text-body-lg text-ink font-medium">
            {numberedSentences[0]!.text}
            <CitationMarkers citations={numberedSentences[0]!.citations} onOpenDocument={openCitationDoc} />
            {modelWritten && !numberedSentences[0]!.supported && (
              <span className="ml-2 text-caption italic text-ink-2">(not found in your records)</span>
            )}
          </p>
          {numberedSentences.slice(1).map((s, i) => (
            <p key={i} className="m-0 text-body text-ink-2">
              {s.text}
              <CitationMarkers citations={s.citations} onOpenDocument={openCitationDoc} />
              {modelWritten && !s.supported && <span className="ml-2 text-caption italic text-ink-2">(not found in your records)</span>}
            </p>
          ))}
        </>
      ) : (
        <>
          <p className="m-0 text-body-lg text-ink font-medium">{headline}</p>
          {secondary && <p className="m-0 text-body text-ink-2 whitespace-pre-line">{secondary}</p>}
        </>
      )}
      {answer.basis && <p className="m-0 text-caption text-ink-3">{answer.basis}</p>}
      {claimNote && <p className="m-0 text-caption text-ink-3">{claimNote}</p>}
      {citationOrder.length > 0 && <CitationSourceStrip order={citationOrder} onOpenDocument={openCitationDoc} />}

      {layout === 'money' && <MoneyHero facts={answer.facts} onOpenSource={(ref) => onOpenDoc(ref.documentId)} />}
      {layout === 'status' && <StatusHero facts={answer.facts} onOpenSource={(ref) => onOpenDoc(ref.documentId)} />}
      {layout === 'single-fact' && answer.facts[0] && <SingleFactHero fact={answer.facts[0]} onOpenSource={(ref) => onOpenDoc(ref.documentId)} />}
      {layout === 'timeline' && <TimelineList facts={answer.facts} onOpenSource={(ref) => onOpenDoc(ref.documentId)} />}

      {keyFact && (
        <dl className="m-0">
          <FactRow fact={keyFact} onOpenCustomer={onOpenCustomer} />
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {restFacts.length > 0 && (
          <button type="button" aria-expanded={panel === 'details'} className={pill(panel === 'details')} onClick={() => toggle('details')}>
            Details{restFacts.length ? ` · ${restFacts.length}` : ''}
          </button>
        )}
        {hasRecords && (
          <button type="button" aria-expanded={panel === 'records'} className={pill(panel === 'records')} onClick={() => toggle('records')}>
            {recordsHeading(answer)}
          </button>
        )}
        {citedIds.length > 0 && (
          <button type="button" aria-expanded={panel === 'sources'} className={pill(panel === 'sources')} onClick={() => toggle('sources')}>
            {noAnswer ? 'Closest' : 'Sources'} · {citedIds.length}
          </button>
        )}
        <span className="ml-auto shrink-0 inline-flex items-center gap-1">
          <ShareButton text={shareText(question, answer, resolveDocName)} />
          <Feedback question={question} />
        </span>
      </div>

      {chips.length > 0 && onAsk && <FollowupChips chips={chips} onPick={onAsk} />}

      {panel === 'details' && (
        <div className="grid grid-cols-1 gap-1">
          {restFacts.length > 0 && (
            <dl className="m-0 divide-y divide-line/60">
              {restFacts.map((f, i) => (
                <FactRow key={i} fact={f} onOpenCustomer={onOpenCustomer} />
              ))}
            </dl>
          )}
        </div>
      )}

      {panel === 'records' && (
        <div className="grid grid-cols-1 gap-2">
          {groups.length > 1 && (
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
              <button type="button" className={pill(group === null)} onClick={() => setGroup(null)}>
                All
              </button>
              {groups.map((g) => (
                <button key={g} type="button" className={pill(group === g)} onClick={() => setGroup(g)}>
                  {g}
                </button>
              ))}
            </div>
          )}
          <ul className="list-none p-0 m-0 divide-y divide-line/60">
            {shownRecords.slice(0, recordLimit).map((r) => {
              const target = recordTarget(r)
              const open =
                target.kind === 'document' ? () => onOpenDoc(target.documentId) : target.kind === 'customer' ? () => onOpenCustomer(target.ref) : null
              const inner = (
                <>
                  <span className="block text-body text-ink truncate">{r.label}</span>
                  {r.sublabel && <span className="block text-caption text-ink-3 truncate">{r.sublabel}</span>}
                </>
              )
              return (
                <li key={`${r.type}-${r.id}`}>
                  {open ? (
                    <button type="button" className="w-full min-h-touch py-1.5 text-left" onClick={open}>
                      {inner}
                    </button>
                  ) : (
                    <div className="py-1.5">{inner}</div>
                  )}
                </li>
              )
            })}
          </ul>
          {shownRecords.length > recordLimit && (
            <button type="button" className="min-h-touch rounded-xl bg-surface-2 text-ink-2 font-semibold" onClick={() => setRecordLimit((n) => n + RECORDS_PAGE)}>
              Show more
            </button>
          )}
          {total > records.length && (
            <p className="m-0 text-caption text-ink-3">
              Showing {records.length} of {total}. Narrow the question to see the rest.
            </p>
          )}
        </div>
      )}

      {panel === 'sources' && (
        <ul className="list-none p-0 m-0 divide-y divide-line/60">
          {citedIds.map((id, i) => {
            const d = docs[id]
            return (
              <li key={id}>
                <button type="button" className="w-full min-h-touch py-1.5 text-left" onClick={() => onOpenDoc(id)}>
                  <span className="block text-body text-ink truncate">{d ? typeLabel(d.typeId) : `Document ${i + 1}`}</span>
                  <span className="block text-caption text-ink-3 truncate">{d?.filename ?? 'Tap to open'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
