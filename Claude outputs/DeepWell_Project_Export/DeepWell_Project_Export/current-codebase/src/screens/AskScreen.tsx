import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Camera, Clock, Loader2, X } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { AnswerCard, AnswerTicker } from '../components/AnswerCard';
import { DocumentPreview } from '../components/DocumentPreview';
import { SerialCapture } from '../components/SerialCapture';
import type { Answer, AskStage, SourceRef } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { ask } from '../services/answerService';
import { useAppStore } from '../store/appStore';

const SUGGESTED = [
  'Is the furnace at 2847 N 24th St still under warranty?',
  'What did Carlos do at 4521 E Camelback in 2025?',
  'SN-RHE-012345',
  'Which warranties expire in the next 12 months?',
  'When were we last at 4321 S Price Rd?',
  'How much did the compressor replacement at Alma School cost?',
];

export function AskScreen() {
  const pendingQuestion = useAppStore((s) => s.pendingQuestion);
  const clearPendingQuestion = useAppStore((s) => s.clearPendingQuestion);
  const recentQuestions = useAppStore((s) => s.recentQuestions);
  const pushRecentQuestion = useAppStore((s) => s.pushRecentQuestion);
  const includeUnverified = useAppStore((s) => s.includeUnverified);
  const setIncludeUnverified = useAppStore((s) => s.setIncludeUnverified);
  const pushAnswerTime = useAppStore((s) => s.pushAnswerTime);
  const openEntity = useAppStore((s) => s.openEntity);
  const fieldMode = useAppStore((s) => s.fieldMode);
  // Re-run the current question whenever the graph changes (a review correction changes the answer)
  const graphVersion = useGraph((s) => s.docs);

  const [input, setInput] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<AskStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SourceRef | null>(null);
  const [capture, setCapture] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const submit = useCallback(
    async (question: string, opts: { record?: boolean } = {}) => {
      const q = question.trim();
      if (!q) return;
      const id = ++requestId.current;
      setAsked(q);
      setInput(q);
      setLoading(true);
      setStage(null);
      setError(null);
      if (opts.record !== false) pushRecentQuestion(q);
      const started = performance.now();
      try {
        const a = await ask(q, {
          includeUnverified,
          onStatus: (s) => {
            if (id === requestId.current) setStage(s);
          },
        });
        if (id === requestId.current) {
          setAnswer(a);
          pushAnswerTime(a.latencyMs ?? performance.now() - started);
        }
      } catch (e) {
        if (id === requestId.current) setError(e instanceof Error ? e.message : 'Something went wrong answering that.');
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setStage(null);
        }
      }
    },
    [includeUnverified, pushRecentQuestion, pushAnswerTime],
  );

  // Deep links (dashboard rows, entity pages) arrive as a pending question
  useEffect(() => {
    if (pendingQuestion) {
      clearPendingQuestion();
      void submit(pendingQuestion);
    }
  }, [pendingQuestion, clearPendingQuestion, submit]);

  // Toggling verified-only, or the records changing, re-asks the same question silently
  useEffect(() => {
    if (asked) void submit(asked, { record: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeUnverified, graphVersion]);

  useEffect(() => {
    if (!pendingQuestion) inputRef.current?.focus();
  }, [pendingQuestion]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  const clear = () => {
    setInput('');
    setAsked(null);
    setAnswer(null);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <AppShell width="ask">
      <div className="space-y-8">
        <header className="space-y-2">
          <h1 className={asked ? 'text-h2 sm:text-h1' : 'text-display sm:text-display-lg'}>Ask your records.</h1>
          {!asked && <p className="text-ink-2 text-body-lg dark:text-body-xl">One question. One answer, with the documents it came from.</p>}
        </header>

        <form onSubmit={onSubmit} role="search" aria-label="Ask a question" className="space-y-3">
          <label htmlFor="ask-input" className="sr-only">
            Ask anything
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="ask-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (input) clear();
                }
              }}
              placeholder="Ask anything — an address, a serial, a name, a question…"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              className={['dw-input text-body-lg dark:text-body-xl sm:text-[18px] sm:leading-7 sm:py-4', input ? 'pr-[9.75rem]' : 'pr-[6.75rem]'].join(' ')}
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
              <button type="submit" aria-label="Ask" disabled={!input.trim()} className="dw-btn-primary min-w-touch !px-3">
                {loading ? <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ArrowRight className="w-5 h-5" aria-hidden="true" />}
              </button>
            </div>
          </div>
          <p className="text-caption text-ink-3">
            <kbd className="dw-kbd">Enter</kbd> to ask · <kbd className="dw-kbd">Esc</kbd> to clear
          </p>
        </form>

        {loading && <AnswerTicker stage={stage} />}

        {error && (
          <div role="alert" className="dw-card border-bad/40 px-5 py-4 text-bad-ink dark:text-bad-bg">
            <p className="font-medium">Couldn't get an answer.</p>
            <p className="text-body mt-1">{error}</p>
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
              Try asking
            </h2>
            <ul className="flex flex-wrap gap-2">
              {SUGGESTED.map((q) => (
                <li key={q}>
                  <button type="button" onClick={() => void submit(q)} className="dw-btn-secondary !py-2 text-left font-normal max-w-full">
                    {q}
                  </button>
                </li>
              ))}
            </ul>
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
