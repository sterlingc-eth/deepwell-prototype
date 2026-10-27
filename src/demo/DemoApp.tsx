import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, LayoutDashboard, Loader2, MessageSquare, RotateCcw, Search, Upload, X } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { DidYouMeanChips } from '../components/ask/PromptChips';
import { DEMO_INDEX, loadFixture } from './fixtures';
import { TryOwn } from './TryOwn';
import { TRYOWN_TEXT } from './tryown';
import {
  INGEST_STAGES, askDemo, capFirst, dashboardOf, ingestPlan, money, niceDate, niceText, nounPlural, stagesAfter,
  type DemoDocument, type DemoFixture, type DemoReply, type IngestStage,
} from './engine';

type Step = 'upload' | 'dashboard' | 'ask';
const STEP_MS = 70;

function initialSlug(): string {
  const want = new URLSearchParams(window.location.search).get('industry');
  const all = DEMO_INDEX.industries;
  return all.find((i) => i.slug === want)?.slug ?? all[0]?.slug ?? '';
}

/** ?try=1 opens the "Try your own documents" panel straight away (a link a presenter can bookmark). */
const initialOwn = () => new URLSearchParams(window.location.search).get('try') === '1';

export function DemoApp() {
  const [own, setOwn] = useState(initialOwn);
  const [slug, setSlug] = useState(initialSlug);
  const [fx, setFx] = useState<DemoFixture | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [openDoc, setOpenDoc] = useState<{ doc: DemoDocument; page?: number } | null>(null);
  const [asked, setAsked] = useState<{ q: string; reply: DemoReply } | null>(null);
  const [input, setInput] = useState('');
  const [loadKey, setLoadKey] = useState(0);

  // load the picked industry; any switch (or Reset) starts the demo over
  useEffect(() => {
    let live = true;
    setFx(null); setStep('upload'); setDone(0); setRunning(false); setOpenDoc(null); setAsked(null); setInput('');
    void loadFixture(slug).then((f) => { if (live) setFx(f); });
    try { const u = new URL(window.location.href); u.searchParams.set('industry', slug); window.history.replaceState(null, '', u); } catch { /* address bar is optional */ }
    return () => { live = false; };
  }, [slug, loadKey]);

  const plan = useMemo(() => (fx ? ingestPlan(fx) : []), [fx]);
  const finished = plan.length > 0 && done >= plan.length;
  useEffect(() => {
    if (!running) return;
    if (done >= plan.length) { setRunning(false); return; }
    const t = window.setTimeout(() => setDone((n) => n + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [running, done, plan.length]);

  const families = useMemo(() => {
    const m = new Map<string, typeof DEMO_INDEX.industries>();
    for (const i of DEMO_INDEX.industries) { const k = i.core ? 'Featured' : i.familyLabel; m.set(k, [...(m.get(k) ?? []), i]); }
    return [...m.entries()];
  }, []);

  const ask = (q: string) => { if (!fx) return; setInput(q); setAsked({ q, reply: askDemo(fx, q) }); };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line bg-surface">
        <div className="max-w-content mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <Wordmark />
          <span className="dw-pill-info">Demo workspace</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label htmlFor="demo-industry" className="dw-label">Industry</label>
            <select id="demo-industry" value={slug} onChange={(e) => setSlug(e.target.value)} className="dw-input min-h-11 max-w-[16rem]">
              {families.map(([fam, list]) => (
                <optgroup key={fam} label={fam}>
                  {list.map((i) => <option key={i.slug} value={i.slug}>{i.label}</option>)}
                </optgroup>
              ))}
            </select>
            <button type="button" className="dw-btn dw-btn-secondary min-h-11" onClick={() => { setOwn(false); setLoadKey((k) => k + 1); }}>
              <RotateCcw className="w-4 h-4" aria-hidden="true" /> Start over
            </button>
            <button type="button" className={`dw-btn min-h-11 ${own ? 'dw-btn-secondary' : 'dw-btn-primary'}`} aria-pressed={own} onClick={() => setOwn(true)}>
              <Upload className="w-4 h-4" aria-hidden="true" /> {TRYOWN_TEXT.panelTitle}
            </button>
          </div>
        </div>
        <div className="max-w-content mx-auto px-4 pb-3 flex flex-wrap gap-2" role="list" aria-label="Featured industries">
          {DEMO_INDEX.industries.filter((i) => i.core).map((i) => (
            <button key={i.slug} type="button" role="listitem" onClick={() => setSlug(i.slug)} aria-pressed={i.slug === slug}
              className={`min-h-9 px-3 rounded-full border text-body ${i.slug === slug ? 'border-accent text-ink bg-surface-2' : 'border-line-2 text-ink-2 hover:text-ink'}`}>
              {i.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-content mx-auto px-4 py-6 space-y-5">
        {own ? (
          <TryOwn pack={fx?.pack?.id} onBack={() => setOwn(false)} />
        ) : !fx ? (
          <div className="dw-card p-8 flex items-center gap-3 text-ink-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Getting the sample workspace ready…</div>
        ) : (
          <>
            <section className="space-y-1">
              <h1 className="font-display text-h1">{fx.company}</h1>
              <p className="text-ink-2">{fx.label} sample workspace. The company, people, addresses and numbers in it are made up for this demo.</p>
            </section>

            <nav aria-label="Demo steps" className="grid grid-cols-3 gap-2">
              {([['upload', '1. Upload documents', Upload], ['dashboard', '2. Dashboard', LayoutDashboard], ['ask', '3. Ask Donovan', MessageSquare]] as const).map(([k, label, Icon]) => (
                <button key={k} type="button" onClick={() => setStep(k)} aria-current={step === k ? 'step' : undefined}
                  className={`min-h-11 px-3 rounded-lg border flex items-center justify-center gap-2 text-body ${step === k ? 'border-accent bg-surface text-ink' : 'border-line text-ink-2 hover:text-ink'}`}>
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" /><span className="truncate">{label}</span>
                </button>
              ))}
            </nav>

            {step === 'upload' && <UploadStep fx={fx} done={done} running={running} finished={finished} planLength={plan.length}
              onStart={() => { setDone(0); setRunning(true); }} onSkip={() => { setDone(plan.length); setRunning(false); }}
              onOpen={(doc) => setOpenDoc({ doc })} onNext={() => setStep('dashboard')} onTryOwn={() => setOwn(true)} />}
            {step === 'dashboard' && (finished ? <DashboardStep fx={fx} onOpen={(doc) => setOpenDoc({ doc })} onNext={() => setStep('ask')} />
              : <NotYet onGo={() => setStep('upload')} />)}
            {step === 'ask' && (finished ? <AskStep fx={fx} input={input} setInput={setInput} asked={asked} onAsk={ask} onOpen={(doc, page) => setOpenDoc({ doc, page })} />
              : <NotYet onGo={() => setStep('upload')} />)}
          </>
        )}
      </main>
      {openDoc && <DocPreview doc={openDoc.doc} page={openDoc.page} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

function NotYet({ onGo }: { onGo: () => void }) {
  return (
    <div className="dw-card p-6 space-y-3">
      <p className="text-ink-2">Upload the sample documents first. It takes a few seconds.</p>
      <button type="button" className="dw-btn dw-btn-primary min-h-11" onClick={onGo}><Upload className="w-4 h-4" aria-hidden="true" /> Go to upload</button>
    </div>
  );
}

const STAGE_PILL: Record<IngestStage, string> = { 'Uploaded': 'dw-pill-muted', 'Reading pages': 'dw-pill-info', 'Fields found': 'dw-pill-info', 'Matched': 'dw-pill-ok' };

function UploadStep({ fx, done, running, finished, planLength, onStart, onSkip, onOpen, onNext, onTryOwn }: {
  fx: DemoFixture; done: number; running: boolean; finished: boolean; planLength: number;
  onStart: () => void; onSkip: () => void; onOpen: (d: DemoDocument) => void; onNext: () => void; onTryOwn: () => void;
}) {
  const stages = stagesAfter(fx, done);
  const started = done > 0 || running;
  const ready = fx.documents.filter((d) => stages.get(d.id) === 'Matched').length;
  const listRef = useRef<HTMLUListElement>(null);
  return (
    <section className="dw-card p-5 space-y-4" aria-labelledby="demo-upload-h">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="demo-upload-h" className="text-h3 font-medium">Upload documents</h2>
        <span className="text-ink-3 text-body">{fx.documents.length} sample documents</span>
        <div className="ml-auto flex gap-2">
          {!started && <button type="button" className="dw-btn dw-btn-primary min-h-11" onClick={onStart}><Upload className="w-4 h-4" aria-hidden="true" /> Upload sample documents</button>}
          {running && <button type="button" className="dw-btn dw-btn-tertiary min-h-11" onClick={onSkip}>Skip ahead</button>}
          {finished && <button type="button" className="dw-btn dw-btn-primary min-h-11" onClick={onNext}><LayoutDashboard className="w-4 h-4" aria-hidden="true" /> See the dashboard</button>}
        </div>
      </div>
      {!started ? (
        <div className="border-2 border-dashed border-line-2 rounded-xl p-8 text-center space-y-2">
          <FileText className="w-8 h-8 mx-auto text-ink-3" aria-hidden="true" />
          <p className="text-ink-2">Sample documents in this workspace include {[...new Set(fx.documents.map((d) => d.typeLabel))].slice(0, 5).join(', ')}.</p>
          <p className="text-ink-3 text-body">DeepWell reads each one, finds the key fields and matches it to the right {fx.customerNoun}.</p>
          <button type="button" className="dw-btn dw-btn-tertiary min-h-11" onClick={onTryOwn}>{TRYOWN_TEXT.entry}</button>
        </div>
      ) : (
        <>
          <div className="space-y-1" aria-live="polite">
            <div className="h-2 rounded-full bg-surface-2 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${Math.round((done / Math.max(1, planLength)) * 100)}%` }} /></div>
            <p className="text-body text-ink-2">{finished ? `All ${fx.documents.length} documents are read and matched.` : `${ready} of ${fx.documents.length} documents ready`}</p>
          </div>
          <ul ref={listRef} className="divide-y divide-line border border-line rounded-lg">
            {fx.documents.map((d) => {
              const st = stages.get(d.id); const step = plan(fx, d.id, st);
              return (
                <li key={d.id} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <FileText className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  <button type="button" className="text-left text-body hover:underline min-w-0 flex-1 truncate" onClick={() => onOpen(d)} disabled={!st}>{d.name}</button>
                  <span className="text-caption text-ink-3 hidden sm:inline">{step}</span>
                  {st ? <span className={STAGE_PILL[st]}>{st === 'Matched' ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} {st}</span>
                    : <span className="dw-pill-muted">Waiting</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-caption text-ink-3">Steps: {INGEST_STAGES.join(' → ')}. Select a document to see what was read from it.</p>
        </>
      )}
    </section>
  );
}
function plan(fx: DemoFixture, id: string, st: IngestStage | undefined): string {
  if (!st) return '';
  return ingestPlan(fx).find((s) => s.docId === id && s.stage === st)?.detail ?? '';
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dw-card p-4">
      <p className="dw-label text-ink-3">{label}</p>
      <p className="text-h2 font-medium mt-1">{value}</p>
      {note && <p className="text-caption text-ink-3 mt-1">{note}</p>}
    </div>
  );
}

function DashboardStep({ fx, onOpen, onNext }: { fx: DemoFixture; onOpen: (d: DemoDocument) => void; onNext: () => void }) {
  const dash = dashboardOf(fx);
  const max = Math.max(1, ...dash.byType.map((x) => x.count));
  return (
    <section className="space-y-4" aria-labelledby="demo-dash-h">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="demo-dash-h" className="text-h3 font-medium">Dashboard</h2>
        <button type="button" className="dw-btn dw-btn-primary min-h-11 ml-auto" onClick={onNext}><MessageSquare className="w-4 h-4" aria-hidden="true" /> Ask Donovan</button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Documents" value={String(dash.documents)} note={`${dash.byType.length} kinds of documents`} />
        <Tile label={capFirst(nounPlural(fx.customerNoun))} value={String(dash.customers)} note="matched automatically" />
        <Tile label="Billed" value={money(dash.billed)} note="across invoices on file" />
        <Tile label="Open balance" value={money(dash.openBalance)} note={`${dash.openInvoices} open ${dash.openInvoices === 1 ? 'invoice' : 'invoices'}`} />
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <div className="dw-card p-4 space-y-3">
          <h3 className="dw-label">Documents by kind</h3>
          <ul className="space-y-2">
            {dash.byType.map((t) => (
              <li key={t.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center">
                <div className="min-w-0">
                  <p className="text-body truncate">{t.label}</p>
                  <div className="h-1.5 rounded-full bg-surface-2 mt-1"><div className="h-full rounded-full bg-accent" style={{ width: `${(t.count / max) * 100}%` }} /></div>
                </div>
                <span className="text-data text-ink-2">{t.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="dw-card p-4 space-y-3">
          <h3 className="dw-label">Coming up</h3>
          {dash.comingUp.length ? (
            <ul className="space-y-2">
              {dash.comingUp.map((c) => (
                <li key={c.doc.id}>
                  <button type="button" className="w-full text-left flex flex-wrap items-center gap-2 hover:underline" onClick={() => onOpen(c.doc)}>
                    <span className="text-body flex-1 min-w-0 truncate">{c.doc.name}</span>
                    <span className={c.days <= 60 ? 'dw-pill-warn' : 'dw-pill-muted'}>Ends {niceDate(c.on)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-body text-ink-2">Nothing ends in the next 12 months.</p>}
          <h3 className="dw-label pt-2">Recent documents</h3>
          <ul className="space-y-1">
            {dash.recent.map((d) => (
              <li key={d.id}>
                <button type="button" className="w-full text-left flex items-center gap-2 hover:underline" onClick={() => onOpen(d)}>
                  <FileText className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  <span className="text-body flex-1 min-w-0 truncate">{d.name}</span>
                  <span className="text-caption text-ink-3">{niceDate(d.date)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="dw-card overflow-x-auto">
        <table className="w-full text-body">
          <caption className="sr-only">All documents</caption>
          <thead><tr className="text-left text-ink-3 border-b border-line">
            <th className="px-3 py-2 font-normal">Document</th><th className="px-3 py-2 font-normal">{capFirst(fx.customerNoun)}</th>
            <th className="px-3 py-2 font-normal">Date</th><th className="px-3 py-2 font-normal text-right">Amount</th><th className="px-3 py-2 font-normal">Status</th>
          </tr></thead>
          <tbody>
            {fx.documents.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2"><button type="button" className="text-left hover:underline" onClick={() => onOpen(d)}>{d.typeLabel}{d.number ? ` ${d.number}` : ''}</button></td>
                <td className="px-3 py-2 text-ink-2">{d.customer ?? d.vendor ?? '—'}</td>
                <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{niceDate(d.date)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{d.total != null ? money(d.total) : '—'}</td>
                <td className="px-3 py-2">{d.pay ? <span className={d.pay.balance > 0 ? 'dw-pill-warn' : 'dw-pill-ok'}>{d.pay.balance > 0 ? `Open ${money(d.pay.balance)}` : 'Paid'}</span> : d.status ? <span className="dw-pill-muted">{d.status}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AskStep({ fx, input, setInput, asked, onAsk, onOpen }: {
  fx: DemoFixture; input: string; setInput: (s: string) => void; asked: { q: string; reply: DemoReply } | null;
  onAsk: (q: string) => void; onOpen: (d: DemoDocument, page?: number) => void;
}) {
  const byId = new Map(fx.documents.map((d) => [d.id, d]));
  const reply = asked?.reply;
  return (
    <section className="space-y-4" aria-labelledby="demo-ask-h">
      <h2 id="demo-ask-h" className="text-h3 font-medium">Ask Donovan</h2>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onAsk(input); }}>
        <label htmlFor="demo-q" className="sr-only">Ask a question about these records</label>
        <input id="demo-q" className="dw-input min-h-11 flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about these records" autoComplete="off" />
        <button type="submit" className="dw-btn dw-btn-primary min-h-11"><Search className="w-4 h-4" aria-hidden="true" /> Ask</button>
      </form>
      <div className="space-y-2">
        <h3 className="dw-label">Try one of these</h3>
        <ul className="flex flex-wrap gap-2">
          {fx.questions.map((q) => (
            <li key={q.id}><button type="button" onClick={() => onAsk(q.q)} className="min-h-11 px-3.5 py-2 text-left rounded-full border border-line-2 bg-surface text-body text-ink-2 hover:text-ink hover:bg-surface-2">{q.q}</button></li>
          ))}
          {fx.didYouMean && (
            <li><button type="button" onClick={() => onAsk(fx.didYouMean!.q)} className="min-h-11 px-3.5 py-2 text-left rounded-full border border-dashed border-line-2 bg-surface text-body text-ink-2 hover:text-ink hover:bg-surface-2">
              {fx.didYouMean.q} <span className="text-ink-3">(misspelled name)</span></button></li>
          )}
        </ul>
      </div>
      {reply && (
        <div className="dw-card p-5 space-y-3" aria-live="polite">
          <p className="text-caption text-ink-3">You asked: {asked.q}</p>
          {reply.kind === 'answer' && (
            <>
              {reply.question.answer.headline && <p className="text-h2 font-medium">{niceText(reply.question.answer.headline)}</p>}
              <p className="text-body-lg">{niceText(reply.question.answer.text)}</p>
              {reply.question.answer.docs.length > 0 && (
                <div className="space-y-2">
                  <h4 className="dw-label">From {reply.question.answer.docs.length === 1 ? 'this document' : `these ${reply.question.answer.docs.length} documents`}</h4>
                  <ul className="flex flex-wrap gap-2">
                    {reply.question.answer.docs.map((id) => { const d = byId.get(id); return d ? (
                      <li key={id}><button type="button" className="dw-pill-info min-h-9" onClick={() => onOpen(d, reply.question.answer.page ?? undefined)}><FileText className="w-3.5 h-3.5" aria-hidden="true" /> {d.name}{reply.question.answer.page && reply.question.answer.docs.length === 1 ? `, page ${reply.question.answer.page}` : ''}</button></li>
                    ) : null; })}
                  </ul>
                </div>
              )}
            </>
          )}
          {reply.kind === 'did-you-mean' && (
            <>
              <p className="text-body-lg">No {fx.customerNoun} named {reply.typed} is on file.</p>
              <DidYouMeanChips chips={[{ text: reply.corrected, label: reply.suggestion, detail: fx.customers.find((c) => c.name === reply.suggestion)?.address ?? reply.corrected, heading: 'Did you mean' }]} onPick={onAsk} />
            </>
          )}
          {reply.kind === 'try-suggested' && <p className="text-body-lg">In this demo, Donovan answers from the sample records above. Pick one of the suggested questions to see how it works.</p>}
        </div>
      )}
    </section>
  );
}

function DocPreview({ doc, page, onClose }: { doc: DemoDocument; page?: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="demo-doc-h" className="bg-surface w-full sm:max-w-3xl max-h-[90vh] overflow-y-auto rounded-t-xl sm:rounded-xl shadow-modal p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="demo-doc-h" className="text-h3 font-medium">{doc.name}</h2>
            <p className="text-caption text-ink-3">{doc.file} · {niceDate(doc.date)}</p>
          </div>
          <button type="button" className="dw-btn dw-btn-tertiary min-h-11" onClick={onClose} aria-label="Close"><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <div className="grid md:grid-cols-[minmax(0,1fr)_16rem] gap-4">
          <div className="space-y-3">
            {doc.pages.map((p, i) => (
              <figure key={i} className={`rounded-lg border p-4 bg-stone-50 text-stone-900 ${page === i + 1 ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}>
                <figcaption className="text-caption text-stone-500 mb-2">Page {i + 1}</figcaption>
                <pre className="whitespace-pre-wrap font-mono text-data">{p}</pre>
              </figure>
            ))}
          </div>
          <div className="space-y-2">
            <h3 className="dw-label">Fields found</h3>
            <dl className="space-y-2">
              {doc.customer && <div><dt className="text-caption text-ink-3">Matched to</dt><dd className="text-body">{doc.customer}</dd></div>}
              {doc.total != null && <div><dt className="text-caption text-ink-3">Total</dt><dd className="text-body">{money(doc.total)}</dd></div>}
              {doc.fields.map(([k, v]) => <div key={k}><dt className="text-caption text-ink-3">{k}</dt><dd className="text-body break-words">{/^\d{4}-\d{2}-\d{2}$/.test(v) ? niceDate(v) : v}</dd></div>)}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
