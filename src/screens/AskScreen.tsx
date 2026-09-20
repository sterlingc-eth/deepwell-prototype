import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Camera, Clock, Loader2, X } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { AnswerCard } from '../components/AnswerCard';
import { DocumentPreview } from '../components/DocumentPreview';
import { SerialCapture } from '../components/SerialCapture';
import type { Answer, SourceRef } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { buildSuggestions } from '../core/suggestions';
import { ask, AskApiError } from '../services/answerService';
import { useAppStore } from '../store/appStore';

// Shown only when the account has nothing ingested yet, so there is nothing
// real to suggest. Clearly labelled "e.g." — never presented as though they
// are this tenant's own records — and paired with one action: go add some.
const EXAMPLE_QUESTIONS = [
  'Is the furnace at 2847 N 24th St still under warranty?',
  'What serial number is on that outdoor unit?',
  'Which warranties expire in the next 12 months?',
];

export function AskScreen() {
  const pendingQuestion = useAppStore((s) => s.pendingQuestion);
  const clearPendingQuestion = useAppStore((s) => s.clearPendingQuestion);
  const pendingPrefill = useAppStore((s) => s.pendingPrefill);
  const clearPendingPrefill = useAppStore((s) => s.clearPendingPrefill);
  const recentQuestions = useAppStore((s) => s.recentQuestions);
  const pushRecentQuestion = useAppStore((s) => s.pushRecentQuestion);
  const includeUnverified = useAppStore((s) => s.includeUnverified);
  const setIncludeUnverified = useAppStore((s) => s.setIncludeUnverified);
  const openEntity = useAppStore((s) => s.openEntity);
  const fieldMode = useAppStore((s) => s.fieldMode);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  // Re-run the current question whenever the graph changes (a review correction changes the answer)
  const graphVersion = useGraph((s) => s.docs);
  const entities = useGraph((s) => s.entities);
  const suggestions = useMemo(() => buildSuggestions(Object.values(entities)), [entities]);

  const [input, setInput] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set alongside `error` only for a 402 (subscription required / free
  // preview used up) — AskApiError's own `url`, defaulting to Billing.
  const [billingUrl, setBillingUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<SourceRef | null>(null);
  const [capture, setCapture] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);

  const submit = useCallback(
    async (question: string, opts: { record?: boolean } = {}) => {
      const q = question.trim();
      if (!q) return;
      const id = ++requestId.current;
      setAsked(q);
      // Cleared, not repopulated: the asked question stays visible above the
      // answer (AnswerCard's "Asked: ..." line) — repeating it back in the
      // box too just meant every answer had to be manually cleared before
      // asking the next thing.
      setInput('');
      setLoading(true);
      setError(null);
      setBillingUrl(null);
      if (opts.record !== false) pushRecentQuestion(q);
      try {
        const a = await ask(q, { includeUnverified });
        if (id === requestId.current) setAnswer(a);
      } catch (e) {
        if (id === requestId.current) {
          setError(e instanceof Error ? e.message : 'Something went wrong answering that.');
          if (e instanceof AskApiError && e.status === 402) setBillingUrl(e.url ?? '/app/?screen=billing');
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [includeUnverified, pushRecentQuestion],
  );

  // Deep links (dashboard rows, entity pages) arrive as a pending question
  useEffect(() => {
    if (pendingQuestion) {
      clearPendingQuestion();
      void submit(pendingQuestion);
    }
  }, [pendingQuestion, clearPendingQuestion, submit]);

  // "Ask about this customer" only fills the box (e.g. "C-00012: ") — the
  // person still has to say what they want to know, unlike pendingQuestion
  // above which asks immediately.
  useEffect(() => {
    if (pendingPrefill != null) {
      setInput(pendingPrefill);
      clearPendingPrefill();
      window.setTimeout(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, 0);
    }
  }, [pendingPrefill, clearPendingPrefill]);

  // Toggling verified-only, or the records changing, re-asks the same question silently
  useEffect(() => {
    if (asked) void submit(asked, { record: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeUnverified, graphVersion]);

  useEffect(() => {
    if (!pendingQuestion) inputRef.current?.focus();
  }, [pendingQuestion]);

  // Auto-grow the textarea for a multi-line (Shift+Enter) question, capped by
  // the max-h-48/overflow-y-auto on the element itself.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  const clear = () => {
    setInput('');
    setAsked(null);
    setAnswer(null);
    setError(null);
    setBillingUrl(null);
    inputRef.current?.focus();
  };

  return (
    <AppShell width="ask">
      <div className="space-y-8">
        <header className="space-y-2">
          <h1 className={asked ? 'text-h2 sm:text-h1' : 'text-display sm:text-display-lg'}>Ask Donovan.</h1>
          {!asked && <p className="text-ink-2 text-body-lg field:text-body-xl">Donovan reads your records and answers with the documents it came from.</p>}
        </header>

        <form onSubmit={onSubmit} role="search" aria-label="Ask a question" className="space-y-3">
          <label htmlFor="ask-input" className="sr-only">
            Ask anything
          </label>
          <div className="relative">
            <textarea
              ref={inputRef}
              id="ask-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  // Enter asks; Shift+Enter inserts a newline (the browser's
                  // default textarea behavior, left alone below).
                  e.preventDefault();
                  void submit(input);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  if (input) clear();
                }
              }}
              placeholder="Ask Donovan anything — an address, a serial, a name, a question…"
              autoComplete="off"
              spellCheck={false}
              rows={1}
              enterKeyHint="search"
              className="dw-input pr-[7.5rem] text-body-lg field:text-body-xl sm:text-[18px] sm:leading-7 sm:py-4 resize-none overflow-y-auto max-h-48"
              style={{ minHeight: fieldMode ? 60 : 56 }}
            />
            <div className="absolute inset-y-0 right-1.5 flex items-center gap-1">
              {input && (
                <button type="button" onClick={clear} aria-label="Clear question" className="min-w-touch min-h-touch grid place-items-center text-ink-3 hover:text-ink rounded-md">
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={() => setCapture(true)} aria-label="Enter a serial from a photo" title="Serial from photo" className="min-w-touch min-h-touch grid place-items-center text-ink-3 hover:text-ink rounded-md">
                <Camera className="w-5 h-5" aria-hidden="true" />
              </button>
              <button type="submit" aria-label="Ask" disabled={!input.trim()} className="dw-btn-primary min-w-touch !px-3 !min-h-[44px]">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <ArrowRight className="w-5 h-5" aria-hidden="true" />}
              </button>
            </div>
          </div>
          <p className="text-caption text-ink-3" aria-live="polite">
            {loading
              ? <span className="inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Donovan is reading your records…</span>
              : <><kbd className="dw-kbd">Enter</kbd> to ask · <kbd className="dw-kbd">Esc</kbd> to clear</>}
          </p>
        </form>

        {error && (
          <div role="alert" className="dw-card border-bad/40 px-5 py-4 text-bad-ink dark:text-bad-bg">
            <p className="font-medium">Donovan couldn't get an answer.</p>
            <p className="text-body mt-1">{error}</p>
            {billingUrl && (
              <button type="button" onClick={() => setCurrentScreen('billing')} className="dw-btn-primary !min-h-[36px] !py-1 mt-3">
                See plans
              </button>
            )}
          </div>
        )}

        {answer && asked && !error && (
          <AnswerCard
            answer={answer}
            question={asked}
            includeUnverified={includeUnverified}
            onToggleUnverified={setIncludeUnverified}
            onOpenSource={setPreview}
            onOpenEntity={openEntity}
          />
        )}

        {!asked && (
          <section aria-labelledby="suggested-heading" className="space-y-3">
            <h2 id="suggested-heading" className="dw-label">
              {suggestions.length > 0 ? 'Try asking' : 'For example'}
            </h2>
            {suggestions.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {suggestions.map((q) => (
                  <li key={q}>
                    <button type="button" onClick={() => void submit(q)} className="dw-btn-secondary !min-h-[44px] !py-2 text-left font-normal">
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <ul className="flex flex-wrap gap-2">
                  {EXAMPLE_QUESTIONS.map((q) => (
                    <li key={q}>
                      <span className="dw-btn-secondary !min-h-[44px] !py-2 text-left font-normal opacity-70 cursor-default select-none">
                        e.g. {q}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-ink-3">
                  Nothing added yet. Add a document, then ask about it.{' '}
                  <button type="button" onClick={() => setCurrentScreen('ingest')} className="dw-btn-primary !min-h-[36px] !py-1 ml-1 align-middle">
                    Add a document <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </p>
              </>
            )}
          </section>
        )}

        {recentQuestions.length > 0 && (
          <section aria-labelledby="recent-heading" className="space-y-3">
            <h2 id="recent-heading" className="dw-label">
              Recent
            </h2>
            <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
              {recentQuestions.map((q) => (
                <li key={q}>
                  <button type="button" onClick={() => void submit(q)} className="w-full text-left flex items-center gap-3 px-4 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                    <Clock className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{q}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
      {capture && (
        <SerialCapture
          onClose={() => setCapture(false)}
          onSerial={(serial) => {
            setCapture(false);
            void submit(serial);
          }}
        />
      )}
    </AppShell>
  );
}
