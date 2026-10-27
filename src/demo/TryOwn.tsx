import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, MessageSquare, RotateCcw, Search, ShieldCheck, Upload, X } from 'lucide-react';
import {
  TRYOWN, TRYOWN_TEXT as T, askQuestion, checkPicked, fetchStatus, readFiles, typeOf,
  type TryAnswer, type TryDoc, type TryStatus,
} from './tryown';

type Phase = 'pick' | 'working' | 'done';
const sizeLabel = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * "Try your own documents": pick up to 3 files, watch DeepWell read them, then ask Donovan about them.
 * Everything lives in this component's state (the browser tab); nothing is saved, and the server keeps no copy of the files.
 */
export function TryOwn({ pack, onBack }: { pack?: string; onBack: () => void }) {
  const [status, setStatus] = useState<TryStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [docs, setDocs] = useState<TryDoc[]>([]);
  const [ctx, setCtx] = useState<string | null>(null);
  const [left, setLeft] = useState<number>(TRYOWN.maxQuestions);
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; a: TryAnswer } | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { let live = true; void fetchStatus().then((s) => { if (live) setStatus(s); }); return () => { live = false; }; }, []);

  const addFiles = useCallback((list: FileList | File[] | null) => {
    const next = [...files, ...Array.from(list ?? [])];
    const bad = checkPicked(next.map((f) => ({ name: f.name, size: f.size, type: f.type })));
    setProblem(bad);
    setFiles(bad ? files : next);
  }, [files]);

  const start = async () => {
    setPhase('working'); setStage(0); setProblem(null); setAnswer(null);
    try {
      const r = await readFiles(files, pack, setStage);
      setDocs(r.docs); setCtx(r.ctx); setLeft(r.questionsLeft);
      if (!r.ok) setProblem(r.docs.find((d) => d.error)?.error ?? r.error ?? T.generic);
      setPhase('done');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : T.generic);
      setPhase('pick');
    }
  };

  const reset = () => { setFiles([]); setDocs([]); setCtx(null); setAnswer(null); setQ(''); setProblem(null); setLeft(TRYOWN.maxQuestions); setPhase('pick'); };

  const ask = async (text: string) => {
    if (!ctx || !text.trim() || asking || left <= 0) return;
    setAsking(true);
    try {
      const a = await askQuestion(text.trim(), ctx);
      setAnswer({ q: text.trim(), a });
      if (typeof a.questionsLeft === 'number') setLeft(a.questionsLeft);
    } catch {
      setAnswer({ q: text.trim(), a: { ok: false, error: T.generic } });
    } finally { setAsking(false); }
  };

  const okDocs = docs.filter((d) => d.ok);
  const off = status && !status.enabled;

  return (
    <section className="space-y-4" aria-labelledby="try-h">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="try-h" className="font-display text-h1">{T.panelTitle}</h1>
        <button type="button" className="dw-btn dw-btn-secondary min-h-11 ml-auto" onClick={onBack}>{T.back}</button>
      </div>
      <p className="flex items-start gap-2 text-ink-2" data-testid="try-notice">
        <ShieldCheck className="w-4 h-4 mt-1 shrink-0 text-ink-3" aria-hidden="true" /><span>{T.notice}</span>
      </p>

      {off && <div className="dw-card p-5 text-ink-2" role="status">{status?.message ?? T.unavailable}</div>}

      {!off && phase === 'pick' && (
        <div className="dw-card p-5 space-y-4">
          <p className="text-ink-2">{T.panelIntro}</p>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center space-y-2 ${over ? 'border-accent bg-surface-2' : 'border-line-2'}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
            <FileText className="w-8 h-8 mx-auto text-ink-3" aria-hidden="true" />
            <button type="button" className="dw-btn dw-btn-primary min-h-11" onClick={() => inputRef.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden="true" /> {T.dropHint}
            </button>
            <p className="text-caption text-ink-3">{T.accepted}</p>
            <input ref={inputRef} type="file" multiple accept={TRYOWN.accept} className="sr-only" aria-label={T.dropHint} tabIndex={-1}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>
          {problem && <p role="alert" className="text-body text-ink">{problem}</p>}
          {files.length > 0 && (
            <ul className="divide-y divide-line border border-line rounded-lg">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="px-3 py-2 flex items-center gap-3">
                  <FileText className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  <span className="text-body flex-1 min-w-0 truncate">{f.name}</span>
                  <span className="text-caption text-ink-3">{typeOf(f) === 'application/pdf' ? 'PDF' : 'Photo'} · {sizeLabel(f.size)}</span>
                  <button type="button" className="dw-btn dw-btn-tertiary min-h-11" aria-label={`${T.remove} ${f.name}`} onClick={() => { setFiles(files.filter((_, j) => j !== i)); setProblem(null); }}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="dw-btn dw-btn-primary min-h-11" disabled={files.length === 0} onClick={() => void start()}>
            <Search className="w-4 h-4" aria-hidden="true" /> {T.readButton}
          </button>
        </div>
      )}

      {!off && phase === 'working' && (
        <div className="dw-card p-5 space-y-3" aria-live="polite">
          <p className="flex items-center gap-2 text-body-lg"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {T.working}</p>
          <ol className="flex flex-wrap gap-2">
            {T.stages.map((s, i) => (
              <li key={s} className={i < stage ? 'dw-pill-ok' : i === stage ? 'dw-pill-info' : 'dw-pill-muted'}>
                {i < stage ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> : i === stage ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null} {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {!off && phase === 'done' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-h3 font-medium">{T.resultsTitle}</h2>
            <button type="button" className="dw-btn dw-btn-secondary min-h-11 ml-auto" onClick={reset}><RotateCcw className="w-4 h-4" aria-hidden="true" /> {T.again}</button>
          </div>
          {problem && !okDocs.length && <p role="alert" className="text-body">{problem}</p>}
          <div className="grid lg:grid-cols-2 gap-3">
            {docs.map((d) => (
              <article key={d.i} className="dw-card p-4 space-y-3" aria-label={files[d.i]?.name ?? `Document ${d.i + 1}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  <h3 className="text-body font-medium min-w-0 flex-1 truncate">{files[d.i]?.name ?? `Document ${d.i + 1}`}</h3>
                  {d.ok ? <span className="dw-pill-info">{d.typeLabel}</span> : <span className="dw-pill-warn">Not read</span>}
                </div>
                {!d.ok && <p className="text-body text-ink-2">{d.error}</p>}
                {d.ok && (
                  <>
                    <p className="text-caption text-ink-3">{T.pagesWord(d.pages ?? 1)} · {d.readHow}</p>
                    <div>
                      <h4 className="dw-label">{T.summaryTitle}</h4>
                      <p className="text-body">{d.summary}</p>
                    </div>
                    {(d.fields?.length ?? 0) > 0 && (
                      <div>
                        <h4 className="dw-label">{T.fieldsTitle}</h4>
                        <dl className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                          {d.fields!.map((f, k) => (
                            <div key={`${f.label}-${k}`} className="min-w-0">
                              <dt className="text-caption text-ink-3">{f.label}</dt>
                              <dd className="text-body break-words">{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
          {okDocs.length > 0 && <p className="text-caption text-ink-3">{T.maskedNote}</p>}

          {okDocs.length > 0 && ctx && (
            <div className="dw-card p-5 space-y-3" aria-labelledby="try-ask-h">
              <div className="flex flex-wrap items-center gap-3">
                <h2 id="try-ask-h" className="text-h3 font-medium flex items-center gap-2"><MessageSquare className="w-4 h-4" aria-hidden="true" /> {T.askTitle}</h2>
                <span className="dw-pill-muted ml-auto" aria-live="polite">{left > 0 ? T.questionsLeft(left) : T.noQuestionsLeft}</span>
              </div>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
                <label htmlFor="try-q" className="sr-only">{T.askPlaceholder}</label>
                <input id="try-q" className="dw-input min-h-11 flex-1" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)}
                  placeholder={T.askPlaceholder} autoComplete="off" disabled={left <= 0} />
                <button type="submit" className="dw-btn dw-btn-primary min-h-11" disabled={asking || left <= 0 || !q.trim()}>
                  {asking ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Search className="w-4 h-4" aria-hidden="true" />} {T.askButton}
                </button>
              </form>
              {answer && (
                <div className="border-t border-line pt-3 space-y-2" aria-live="polite">
                  <p className="text-caption text-ink-3">You asked: {answer.q}</p>
                  <p className="text-body-lg">{answer.a.ok ? answer.a.answer : (answer.a.error ?? T.generic)}</p>
                  {answer.a.ok && (answer.a.sources?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      <h4 className="dw-label">{T.sources}</h4>
                      <ul className="flex flex-wrap gap-2">
                        {answer.a.sources!.map((s, i) => (
                          <li key={i} className="dw-pill-info max-w-full"><FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> <span className="truncate">{files[s.doc]?.name ?? `Document ${s.doc + 1}`}: “{s.quote}”</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
